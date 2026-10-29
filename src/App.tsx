import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowRight, Check, ChevronLeft, Copy, FileText, FlaskConical, Menu, Plus, Search, WifiOff, X } from 'lucide-react'
import Editor from './components/Editor'
import Experiment from './components/Experiment'
import { api, download, errorMessage } from './lib/api'
import { Collaboration, collaboratorColor } from './lib/collaboration'
import type { ConnectionInfo, Note } from './types'

const initialInfo: ConnectionInfo = { status: 'connecting', pending: 0, peers: [], session: '', error: null }

function NewNoteDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (title: string) => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog className="new-note-dialog" ref={dialog} onCancel={onClose} onClick={event => { if (event.target === dialog.current) onClose() }}>
    <form onSubmit={async event => {
      event.preventDefault()
      setBusy(true)
      try { await onCreate(title.trim() || 'Untitled note'); onClose() }
      catch (failure) { setError(errorMessage(failure)); setBusy(false) }
    }}>
      <div className="dialog-top"><span className="eyebrow">A FRESH PAGE</span><button type="button" className="icon-button" onClick={onClose} aria-label="Close new note"><X size={18} /></button></div>
      <h2>What’s on<br />your mind?</h2>
      <label className="field-label" htmlFor="new-note-title">GIVE YOUR NOTE A TITLE</label>
      <input id="new-note-title" autoFocus maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder="An idea worth keeping…" />
      {error && <p role="alert" className="inline-error">{error}</p>}
      <button type="submit" className="button dark full-width" disabled={busy}>{busy ? 'Opening a fresh page…' : <>Create note <ArrowRight size={16} /></>}</button>
    </form>
  </dialog>
}

export default function App() {
  const [notes, setNotes] = useState<Note[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(() => new URL(location.href).searchParams.get('note'))
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const [note, setNote] = useState<Note | null>(null)
  const [connection, setConnection] = useState<Collaboration | null>(null)
  const [info, setInfo] = useState(initialInfo)
  const [name, setName] = useState(() => localStorage.getItem('carbon:name') || 'Student')
  const [title, setTitle] = useState('')
  const [words, setWords] = useState(0)
  const [characters, setCharacters] = useState(0)
  const [query, setQuery] = useState('')
  const [storage, setStorage] = useState('')
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [showNew, setShowNew] = useState(false)
  const [experimentOpen, setExperimentOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [toast, setToast] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [copied, setCopied] = useState(false)
  const [focusMode, setFocusMode] = useState(false)

  const notify = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(message)
    toastTimer.current = setTimeout(() => setToast(''), 5000)
  }, [])
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

  const updateNote = useCallback((updated: Note) => {
    if (updated.id === selectedIdRef.current) setNote(updated)
    setNotes(current => current.some(item => item.id === updated.id)
      ? current.map(item => item.id === updated.id ? updated : item) : [updated, ...current])
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    setLoading(true)
    Promise.all([
      api<Note[]>('/notes', { signal: abort.signal }),
      api<{ storage: string }>('/health', { signal: abort.signal }),
    ]).then(([loaded, health]) => {
      setNotes(loaded)
      setStorage(health.storage)
      setSelectedId(current => current || (loaded.find(item => item.id === 'welcome') ?? loaded[0])?.id || null)
      setLoadError('')
      setLoading(false)
    }).catch(failure => {
      if (abort.signal.aborted) return
      setLoadError(`Could not load your notebook. Check that the notes server is running. ${errorMessage(failure)}`)
      setLoading(false)
    })
    return () => abort.abort()
  }, [reload])

  useEffect(() => {
    if (!selectedId) return
    setInfo(initialInfo)
    setNote(notes.find(item => item.id === selectedId) ?? null)
    const client = new Collaboration(selectedId, name, setInfo, updateNote)
    setConnection(client)
    return () => { client.destroy() }
    // A room's connection survives metadata and display-name changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, updateNote])

  useEffect(() => { setTitle(note?.title ?? '') }, [note?.title, note?.id])
  useEffect(() => {
    const timer = setTimeout(() => {
      try { localStorage.setItem('carbon:name', name) } catch { /* A name can stay in memory. */ }
      connection?.setName(name.trim() || 'Student')
    }, 350)
    return () => clearTimeout(timer)
  }, [name, connection])
  useEffect(() => {
    const listener = () => setSelectedId(new URL(location.href).searchParams.get('note') || 'welcome')
    window.addEventListener('popstate', listener)
    return () => window.removeEventListener('popstate', listener)
  }, [])

  function selectNote(id: string) {
    if (id === selectedId) return
    setSelectedId(id)
    const url = new URL(location.href)
    url.searchParams.set('note', id)
    history.pushState({}, '', url)
    setSidebarOpen(false)
  }

  async function createNote(title: string) {
    const created = await api<Note>('/notes', { method: 'POST', body: JSON.stringify({ title }) })
    setNotes(current => [created, ...current])
    selectNote(created.id)
  }

  async function saveTitle() {
    if (!note || title === note.title) return
    const previous = note.title
    try {
      updateNote(await api<Note>(`/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ title: title.trim() || 'Untitled note' }) }))
    } catch (failure) {
      if (selectedIdRef.current === note.id) setTitle(previous)
      notify(`Title could not be saved. ${errorMessage(failure)}`)
    }
  }

  async function share() {
    if (!selectedId) return
    const url = new URL(location.href)
    url.searchParams.set('note', selectedId)
    try {
      await navigator.clipboard.writeText(url.toString())
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
      notify('Room link copied. Open it in another tab to write together.')
    } catch { notify(`Room link: ${url.toString()}`) }
  }

  const closeExperiment = useCallback(() => setExperimentOpen(false), [])
  const visibleNotes = notes.filter(item => item.title.toLowerCase().includes(query.toLowerCase()))
  const others = info.peers.filter(peer => peer.id !== info.session)
  const saved = info.status === 'online' && info.pending === 0 && !info.error
  const date = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Calcutta' }).format(new Date())
  const noteNumber = String(Math.max(1, notes.findIndex(item => item.id === selectedId) + 1)).padStart(2, '0')

  return <div className={`app ${focusMode ? 'focus-mode' : ''}`}>
    <header className="masthead">
      <div className="brand"><span className="brand-word">CARBON<span className="brand-dot">.</span></span><span className="brand-caption">A SHARED NOTEBOOK</span></div>
      <div className="masthead-note">Thoughts are better<br /><span>when they’re shared.</span></div>
      <div className="header-actions"><button className="button outline experiment-trigger" onClick={() => setExperimentOpen(true)}><FlaskConical size={15} /><span>The experiment</span></button><button className="button rust-button" onClick={share} disabled={!selectedId || !!loadError}>{copied ? <Check size={15} /> : <Copy size={14} />}<span>{copied ? 'Copied' : 'Share note'}</span></button></div>
    </header>
    <div className="under-masthead"><span>MAKE ROOM FOR A THOUGHT.</span><span>{date.toUpperCase()} <i /> LOCAL-FIRST WRITING</span></div>

    <div className="workspace">
      {sidebarOpen && <button className="sidebar-scrim" aria-label="Close notebook navigation" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`} aria-label="Notebook navigation">
        <div className="sidebar-top"><span className="eyebrow">YOUR NOTEBOOK</span><button className="icon-button mobile-sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Close navigation"><X size={16} /></button><span className="small-count">{String(notes.length).padStart(2, '0')}</span></div>
        <button className="new-note-button" onClick={() => setShowNew(true)} disabled={!!loadError}><Plus size={17} /><span>A fresh page</span><span className="new-note-plus">↵</span></button>
        <label className="search-field"><Search size={14} /><span className="sr-only">Find a note</span><input placeholder="Find a note…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <nav className="notes-list" aria-label="Notes">
          {loading ? <p className="sidebar-empty">Opening your notebook…</p> : visibleNotes.map((item, index) => <button key={item.id} className={`note-link ${selectedId === item.id ? 'active' : ''}`} onClick={() => selectNote(item.id)} aria-current={selectedId === item.id ? 'page' : undefined}><span className="note-index">{String(index + 1).padStart(2, '0')}</span><span className="note-link-title">{item.title}</span>{selectedId === item.id && <span className="active-note-mark">↗</span>}</button>)}
          {!loading && !visibleNotes.length && <p className="sidebar-empty">{query ? 'No notes match that thought.' : 'Your first page is waiting.'}</p>}
        </nav>
        <div className="sidebar-bottom"><div className="notebook-aside"><span className="tiny-label">A NOTE ON NOTES</span><p>Keep the rough edges.<br />That’s where the<br />good ideas start.</p><span className="aside-scribble">→ keep going</span></div>
          <label className="identity"><span className="avatar own-avatar" style={{ backgroundColor: collaboratorColor(info.session || name) }}>{(name.trim()[0] || 'S').toUpperCase()}</span><span><span className="tiny-label">YOU’RE WRITING AS</span><input aria-label="Your display name" maxLength={30} value={name} onChange={event => setName(event.target.value)} onBlur={() => { if (!name.trim()) setName('Student') }} /></span></label>
          <span className="storage-note"><span className={`status-dot ${storage ? 'is-online' : ''}`} />{storage === 'mongodb' ? 'MongoDB storage' : storage ? 'Saved on this computer' : 'Connecting to notebook'}</span>
        </div>
      </aside>

      <main className="main-area" id="main">
        <div className="document-toolbar"><div className="document-location"><button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open notebook navigation"><Menu size={17} /></button><FileText size={14} /><span>Notebook</span><span className="toolbar-slash">/</span><span className="current-note-name">{note?.title || 'Opening page…'}</span></div><button className="text-button focus-toggle" onClick={() => setFocusMode(value => !value)}>{focusMode ? <ChevronLeft size={13} /> : null}{focusMode ? 'Back to notebook' : 'Just the page ↗'}</button></div>
        {loadError ? <div className="page-error" role="alert"><WifiOff size={28} /><h1>The notebook is offline.</h1><p>{loadError}</p><button className="button dark" onClick={() => setReload(value => value + 1)}>Try again <ArrowRight size={15} /></button></div>
        : info.status === 'missing' ? <div className="page-error"><FileText size={28} /><h1>This page isn’t here.</h1><p>The room link may be incomplete. Open a note from your notebook or create a fresh page.</p><button className="button dark" onClick={() => setShowNew(true)}>Create a note <Plus size={15} /></button></div>
        : <>
          <div className="document-scroll"><article className="paper">
            <div className="page-meta"><span>FIELD NOTES <span className="rust">/</span> {noteNumber}</span><span className="document-state" aria-live="polite"><span className={`status-dot ${saved ? 'is-online' : info.status === 'online' ? 'is-saving' : ''}`} />{saved ? 'All changes saved' : info.status === 'online' ? 'Saving changes…' : info.status === 'offline' ? 'Offline · kept in browser' : 'Connecting…'}</span></div>
            <div className="title-row"><textarea aria-label="Note title" className="note-title" value={title} placeholder="Untitled note" rows={2} maxLength={120} disabled={!note} onChange={event => setTitle(event.target.value)} onBlur={saveTitle} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }} /><span className="margin-star" aria-hidden="true">✳</span></div>
            <div className="byline"><span className="tiny-label">A WORK IN PROGRESS</span><span className="contributors"><span className="avatar-stack"><span className="avatar tiny-avatar" style={{ backgroundColor: collaboratorColor(info.session || name) }} title={`${name || 'Student'} (you)`}>{(name[0] || 'S').toUpperCase()}</span>{others.slice(0, 3).map(peer => <span key={peer.id} className="avatar tiny-avatar" style={{ backgroundColor: collaboratorColor(peer.id) }} title={peer.name}>{peer.name[0]?.toUpperCase() || 'S'}</span>)}</span><span>{others.length ? `${others.length + 1} writing together` : 'Just you, for now'}</span></span></div>
            {info.error && <p className="inline-error" role="alert">{info.error}</p>}
            {connection ? <Editor connection={connection} onCount={(wordCount, charCount) => { setWords(wordCount); setCharacters(charCount) }} /> : <div className="editor-loading">Finding a fresh sheet…</div>}
            <div className="page-end"><span className="page-end-line" /><span>THERE’S ALWAYS ROOM FOR ONE MORE THOUGHT.</span><span className="page-end-line" /></div>
          </article></div>
          <footer className="document-footer"><span>{words.toLocaleString()} words <span className="footer-separator">/</span> {characters.toLocaleString()} characters</span><div><button className="text-button export-note" disabled={!connection} onClick={() => connection && download(`${(note?.title || 'note').replace(/[<>:"/\\|?*]/g, '-')}.txt`, `${note?.title}\n\n${connection.text.toString()}`)}><ArrowDownToLine size={13} /><span>Export .txt</span></button><span className="footer-separator">|</span><button className="text-button interval-button" onClick={() => setExperimentOpen(true)}><span className="status-dot is-online" />{note?.window_ms ? `${note.window_ms} ms batching` : 'Immediate sync'}<ArrowRight size={12} /></button></div></footer>
        </>}
      </main>
    </div>
    <Experiment open={experimentOpen} onClose={closeExperiment} connection={connection} note={note} onNote={updateNote} notify={notify} />
    {showNew && <NewNoteDialog onClose={() => setShowNew(false)} onCreate={createNote} />}
    <div className={`toast ${toast ? 'is-visible' : ''}`} role="status" aria-live="polite">{toast}</div>
  </div>
}
