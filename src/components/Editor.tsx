import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import type { Collaboration } from '../lib/collaboration'

const paperTheme = EditorView.theme({
  '&': { fontSize: '16px', background: 'transparent', color: '#2e2a26' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: '"Courier New", Courier, monospace', lineHeight: '1.85', overflow: 'visible' },
  '.cm-content': { padding: '0', minHeight: '390px', caretColor: '#b2452e', overflowWrap: 'anywhere' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: '#b2452e', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { background: '#ded0b5 !important' },
  '.cm-placeholder': { color: '#8a7e6b', fontStyle: 'italic' },
})

export default function Editor({ connection, onCount }: {
  connection: Collaboration
  onCount: (words: number, chars: number) => void
}) {
  const mount = useRef<HTMLDivElement>(null)
  const countRef = useRef(onCount)
  countRef.current = onCount
  useEffect(() => {
    const count = () => {
      const text = connection.text.toString()
      countRef.current(text.trim() ? text.trim().split(/\s+/u).length : 0, text.length)
    }
    const view = new EditorView({
      parent: mount.current!,
      state: EditorState.create({
        doc: connection.text.toString(),
        extensions: [
          yCollab(connection.text, connection.awareness),
          keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': 'Note content', spellcheck: 'true' }),
          placeholder('A thought, a question, a place to begin…'),
          paperTheme,
        ],
      }),
    })
    connection.text.observe(count)
    count()
    return () => {
      connection.text.unobserve(count)
      view.destroy()
    }
  }, [connection])
  return <div className="note-editor" ref={mount} />
}
