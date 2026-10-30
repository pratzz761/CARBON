import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import type { ConnectionInfo, Note } from '../types'

export const REMOTE = Symbol('remote')
export const RESTORE = Symbol('restore')
const REMOTE_AWARENESS = Symbol('remote awareness')
const BUFFER_CAP = 16 * 1024
const COLLABORATOR_COLOURS = ['#b2452e', '#2e6f95', '#6b7b3d', '#745097', '#b06b1e', '#087e8b']

export function collaboratorColor(id: string) {
  let hash = 0
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return COLLABORATOR_COLOURS[hash % COLLABORATOR_COLOURS.length]
}

function transparent(color: string) { return `${color}33` }

export function toBase64(update: Uint8Array) {
  let binary = ''
  for (const byte of update) binary += String.fromCharCode(byte)
  return btoa(binary)
}
export function fromBase64(value: string) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0))
}

export class Collaboration {
  readonly doc = new Y.Doc()
  readonly text = this.doc.getText('notes')
  readonly awareness = new Awareness(this.doc)
  private socket: WebSocket | null = null
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private cacheTimer: ReturnType<typeof setTimeout> | null = null
  private buffer: Uint8Array[] = []
  private outbox = new Map<number, Uint8Array>()
  private sequence = 0
  private windowMs = 0
  private name: string
  private info: ConnectionInfo = {
    status: 'connecting', pending: 0, peers: [], session: '', error: null,
  }
  private backoff = 500

  constructor(
    readonly noteId: string,
    name: string,
    private onInfo: (info: ConnectionInfo) => void,
    private onNote: (note: Note) => void,
  ) {
    this.name = name
    try {
      const saved = localStorage.getItem(`carbon:document:${noteId}`)
      if (saved) Y.applyUpdate(this.doc, fromBase64(saved), RESTORE)
    } catch {
      this.info.error = 'The browser recovery copy could not be loaded.'
    }
    this.doc.on('update', this.onUpdate)
    this.awareness.setLocalStateField('user', {
      name: this.name,
      color: collaboratorColor(String(this.doc.clientID)),
      colorLight: transparent(collaboratorColor(String(this.doc.clientID))),
    })
    this.awareness.on('update', this.onAwarenessUpdate)
    window.addEventListener('online', this.reconnect)
    window.addEventListener('offline', this.goOffline)
    window.addEventListener('pagehide', this.persist)
    this.connect()
  }

  private emit(patch: Partial<ConnectionInfo> = {}) {
    this.info = { ...this.info, ...patch, pending: this.outbox.size + (this.buffer.length ? 1 : 0) }
    if (!this.disposed) this.onInfo(this.info)
  }

  private onUpdate = (update: Uint8Array, origin: unknown) => {
    if (this.cacheTimer) clearTimeout(this.cacheTimer)
    this.cacheTimer = setTimeout(this.persist, 200)
    if (origin === REMOTE || origin === RESTORE) return
    this.buffer.push(update)
    const size = this.buffer.reduce((sum, item) => sum + item.byteLength, 0)
    if (this.windowMs === 0 || size >= BUFFER_CAP) this.flush()
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.windowMs)
    this.emit()
  }

  private onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === REMOTE_AWARENESS || this.socket?.readyState !== WebSocket.OPEN) return
    const changed = added.concat(updated, removed)
    if (!changed.length) return
    this.socket.send(JSON.stringify({ type: 'awareness', update: toBase64(encodeAwarenessUpdate(this.awareness, changed)) }))
  }

  private setIdentity(session = String(this.doc.clientID)) {
    const color = collaboratorColor(session)
    this.awareness.setLocalStateField('user', { name: this.name, color, colorLight: transparent(color) })
  }

  persist = () => {
    if (this.cacheTimer) clearTimeout(this.cacheTimer)
    this.cacheTimer = null
    try {
      localStorage.setItem(`carbon:document:${this.noteId}`, toBase64(Y.encodeStateAsUpdate(this.doc)))
    } catch {
      this.emit({ error: 'Browser recovery storage is full. Keep this tab open until the server saves.' })
    }
  }

  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.buffer.length) {
      const update = Y.mergeUpdates(this.buffer)
      this.buffer = []
      const seq = ++this.sequence
      this.outbox.set(seq, update)
      this.send(seq, update)
    }
    this.emit()
  }

  private send(seq: number, update: Uint8Array) {
    if (this.socket?.readyState !== WebSocket.OPEN || this.info.status !== 'online') return
    const packet = new Uint8Array(update.length + 4)
    new DataView(packet.buffer).setUint32(0, seq)
    packet.set(update, 4)
    this.socket.send(packet)
  }

  setName(name: string) {
    this.name = name
    this.setIdentity(this.info.session || undefined)
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'name', name }))
  }

  private connect() {
    if (this.disposed) return
    if (!navigator.onLine) { this.emit({ status: 'offline', peers: [] }); return }
    this.emit({ status: 'connecting' })
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}/ws/notes/${encodeURIComponent(this.noteId)}`)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.onopen = () => socket.send(JSON.stringify({ name: this.name }))
    socket.onmessage = event => {
      if (this.disposed || socket !== this.socket) return
      try {
        if (event.data instanceof ArrayBuffer) {
          Y.applyUpdate(this.doc, new Uint8Array(event.data), REMOTE)
          return
        }
        const message = JSON.parse(event.data)
        if (message.type === 'sync') {
          for (const update of message.updates) Y.applyUpdate(this.doc, fromBase64(update), REMOTE)
          for (const update of message.awareness ?? []) applyAwarenessUpdate(this.awareness, fromBase64(update), REMOTE_AWARENESS)
          this.windowMs = message.note.window_ms
          this.onNote(message.note)
          this.backoff = 500
          this.outbox.clear()
          this.buffer = []
          if (this.timer) clearTimeout(this.timer)
          this.timer = null
          this.emit({ status: 'online', session: message.session, error: null })
          this.setIdentity(message.session)
          // Resending the merged local state recovers edits made while disconnected.
          // Repeated CRDT information is safe to apply more than once.
          const state = Y.encodeStateAsUpdate(this.doc)
          if (state.length > 2) {
            const seq = ++this.sequence
            this.outbox.set(seq, state)
            this.send(seq, state)
          }
          this.persist()
        } else if (message.type === 'ack') {
          this.outbox.delete(message.seq)
          this.emit({ error: null })
        } else if (message.type === 'presence') {
          this.emit({ peers: message.peers })
        } else if (message.type === 'awareness') {
          applyAwarenessUpdate(this.awareness, fromBase64(message.update), REMOTE_AWARENESS)
        } else if (message.type === 'note') {
          this.flush()
          this.windowMs = message.note.window_ms
          this.onNote(message.note)
        } else if (message.type === 'storage_error') {
          this.emit({ error: 'The server could not save yet. Your browser recovery copy is retained.' })
        }
        this.emit()
      } catch {
        this.emit({ error: 'A sync message could not be read. Reconnecting to recover the document.' })
        socket.close()
      }
    }
    socket.onclose = event => {
      if (this.disposed || socket !== this.socket) return
      this.persist()
      this.emit({ status: event.code === 4004 ? 'missing' : 'offline', peers: [] })
      if (event.code === 4004) return
      if (!navigator.onLine) return
      this.retry = setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 8000)
    }
    socket.onerror = () => { /* The close handler owns retry and recovery. */ }
  }

  private reconnect = () => {
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.retry) clearTimeout(this.retry)
    this.socket?.close()
    this.connect()
  }

  private goOffline = () => {
    this.persist()
    if (this.retry) clearTimeout(this.retry)
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.emit({ status: 'offline', peers: [] })
  }

  destroy() {
    this.persist()
    this.flush()
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.retry) clearTimeout(this.retry)
    if (this.cacheTimer) clearTimeout(this.cacheTimer)
    window.removeEventListener('online', this.reconnect)
    window.removeEventListener('offline', this.goOffline)
    window.removeEventListener('pagehide', this.persist)
    this.socket?.close()
    this.doc.off('update', this.onUpdate)
    this.awareness.off('update', this.onAwarenessUpdate)
    this.awareness.destroy()
    this.doc.destroy()
  }
}
