import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { ArrowDownToLine, ArrowRight, Check, Circle, FlaskConical, LoaderCircle, Play, Square, X } from 'lucide-react'
import type { Collaboration } from '../lib/collaboration'
import { REMOTE, RESTORE } from '../lib/collaboration'
import { api, download, errorMessage } from '../lib/api'
import { experimentCSV, prepareCandidates, type Recording } from '../lib/experiment'
import type { ExperimentResult, Note } from '../types'

const profiles = {
  normal: { title: 'Unconstrained', description: '16 KiB/s channel · 20 ms propagation' },
  shared: { title: 'Shared connection', description: '1 KiB/s channel · 60 ms propagation' },
  limited: { title: 'Very limited', description: '512 B/s channel · 120 ms propagation' },
}
const format = (value: number) => Math.round(value).toLocaleString()

function ResultsChart({ result }: { result: ExperimentResult }) {
  const width = 376, height = 190, left = 43, right = 12, top = 18, bottom = 30
  const maxY = Math.max(600, ...result.results.flatMap(row => [row.calibration.latency_ms, row.validation.latency_ms])) * 1.08
  const x = (timer: number) => left + timer / 300 * (width - left - right)
  const y = (latency: number) => height - bottom - latency / maxY * (height - top - bottom)
  const path = (split: 'calibration' | 'validation') => result.results.map((row, i) => `${i ? 'L' : 'M'}${x(row.window_ms)},${y(row[split].latency_ms)}`).join(' ')
  const selected = result.results.find(row => row.window_ms === result.selected_window_ms)
  return <div className="chart-wrap">
    <div className="chart-heading"><span>REMOTE EDIT DELAY</span><span>p95 / ms</span></div>
    <svg className="results-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="chart-title chart-description">
      <title id="chart-title">Remote edit delay by batching interval</title>
      <desc id="chart-description">Calibration and held-out validation delays for all 31 timers. The dashed horizontal line is the 500 millisecond target.</desc>
      {[0, maxY / 2, maxY].map(value => <g key={value}>
        <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className="chart-grid" />
        <text x={left - 7} y={y(value) + 3} textAnchor="end">{format(value)}</text>
      </g>)}
      <line x1={left} x2={width - right} y1={y(500)} y2={y(500)} className="chart-target" />
      <text x={width - right} y={y(500) - 5} textAnchor="end" className="target-label">500 ms target</text>
      <path d={path('calibration')} className="chart-line calibration" />
      <path d={path('validation')} className="chart-line validation" />
      {selected && <>
        <line x1={x(selected.window_ms)} x2={x(selected.window_ms)} y1={top} y2={height - bottom} className="chart-selection" />
        <circle cx={x(selected.window_ms)} cy={y(selected.calibration.latency_ms)} r="4" fill="var(--rust)" />
      </>}
      {[0, 100, 200, 300].map(value => <text key={value} x={x(value)} y={height - 12} textAnchor="middle">{value}</text>)}
    </svg>
    <div className="chart-legend"><span><i />Calibration</span><span><i className="dashed" />Held-out validation</span><span>interval / ms →</span></div>
  </div>
}

export default function Experiment({ open, onClose, connection, note, onNote, notify }: {
  open: boolean
  onClose: () => void
  connection: Collaboration | null
  note: Note | null
  onNote: (note: Note) => void
  notify: (message: string) => void
}) {
  const [profile, setProfile] = useState<keyof typeof profiles>('shared')
  const [users, setUsers] = useState(3)
  const [source, setSource] = useState<'sample' | 'recorded'>('sample')
  const [recording, setRecording] = useState(false)
  const [capture, setCapture] = useState<Recording | null>(null)
  const [captureEdits, setCaptureEdits] = useState(0)
  const captureRef = useRef<Recording | null>(null)
  const startedAt = useRef(0)
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ExperimentResult | null>(null)
  const panel = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    closeButton.current?.focus()
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'Tab') {
        const focusable = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), summary, [tabindex="0"]')
        if (!focusable?.length) return
        const first = focusable[0], last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', listener)
    return () => { document.removeEventListener('keydown', listener); previous?.focus() }
  }, [open, onClose])

  useEffect(() => {
    if (!recording || !connection) return
    const observe = (update: Uint8Array, origin: unknown) => {
      if (origin === RESTORE) return
      if (origin === REMOTE) {
        setRecording(false)
        captureRef.current = null
        setCapture(null)
        setError('Capture stopped: a remote edit arrived. Capture your typing in a solo room for a reproducible trace.')
        return
      }
      const trace = captureRef.current
      if (trace) {
        trace.edits.push({ at: performance.now() - startedAt.current, author: 0, update: update.slice() })
        setCaptureEdits(trace.edits.length)
      }
    }
    connection.doc.on('update', observe)
    return () => connection.doc.off('update', observe)
  }, [connection, recording])

  useEffect(() => {
    setCapture(null)
    captureRef.current = null
    setRecording(false)
    setResult(null)
  }, [connection])

  function startCapture() {
    if (!connection) return
    setError('')
    setCapture(null)
    setCaptureEdits(0)
    setSource('recorded')
    startedAt.current = performance.now()
    captureRef.current = { initial: Y.encodeStateAsUpdate(connection.doc), edits: [], duration: 0 }
    setRecording(true)
    notify('Capture started. Type in your note, then return here to stop.')
    onClose()
  }

  function stopCapture() {
    setRecording(false)
    if (captureRef.current) {
      captureRef.current.duration = performance.now() - startedAt.current
      setCapture({ ...captureRef.current })
    }
    setResult(null)
  }

  async function run() {
    setBusy(true)
    setError('')
    setProgress(0)
    setResult(null)
    try {
      if (source === 'recorded' && !capture) throw new Error('Capture your typing first, or choose the sample traces.')
      const candidates = await prepareCandidates(users, source === 'recorded' ? capture : null, setProgress)
      const response = await api<ExperimentResult>('/experiments', {
        method: 'POST', body: JSON.stringify({ profile, source, candidates }),
      })
      setProgress(100)
      setResult(response)
    } catch (failure) { setError(errorMessage(failure)) }
    finally { setBusy(false) }
  }

  async function apply() {
    if (!note || result?.selected_window_ms == null || !result.validation_passed) return
    setApplying(true)
    try {
      const updated = await api<Note>(`/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ window_ms: result.selected_window_ms }) })
      onNote(updated)
      notify(`All contributors now use a ${result.selected_window_ms} ms batching interval.`)
    } catch (failure) { setError(errorMessage(failure)) }
    finally { setApplying(false) }
  }

  const selected = result?.results.find(row => row.window_ms === result.selected_window_ms)
  const readyCapture = capture && capture.edits.length >= 20 && capture.duration >= 3000
  return <>
    {open && <button className="drawer-scrim" aria-label="Close experiment" onClick={onClose} tabIndex={-1} />}
    <aside ref={panel} className={`experiment-drawer ${open ? 'is-open' : ''}`} role="dialog" aria-modal={open ? true : undefined}
      aria-labelledby="experiment-title" aria-hidden={!open} inert={!open}>
      <header className="drawer-header"><span className="eyebrow"><FlaskConical size={14} /> A SMALL EXPERIMENT</span><button className="icon-button" ref={closeButton} onClick={onClose} aria-label="Close experiment"><X size={19} /></button></header>
      <div className="drawer-scroll">
        <div className="experiment-intro"><span className="section-index">01 — THE QUESTION</span><h2 id="experiment-title">How long<br />should a note wait<span className="rust">?</span></h2><p>Find the fastest way to share edits within a limited traffic budget.</p></div>
        <div className="formula"><span>minimise</span> remote edit delay <span>subject to</span> traffic ≤ budget</div>
        <section className="experiment-settings" aria-label="Experiment settings">
          <label className="field-label" htmlFor="profile">THE CONNECTION</label>
          <select id="profile" value={profile} disabled={busy} onChange={event => { setProfile(event.target.value as keyof typeof profiles); setResult(null) }}>
            {Object.entries(profiles).map(([key, value]) => <option key={key} value={key}>{value.title}</option>)}
          </select>
          <p className="field-hint">{profiles[profile].description}</p>
          <div className="settings-row"><label className="field-label" htmlFor="users">CONTRIBUTORS</label><select id="users" value={users} disabled={busy} onChange={event => { setUsers(Number(event.target.value)); setResult(null) }}>{[2, 3, 4, 5].map(value => <option key={value} value={value}>{value} students</option>)}</select></div>
          <div className="settings-row"><label className="field-label" htmlFor="source">EDIT TRACE</label><select id="source" value={source} disabled={busy || recording} onChange={event => { setSource(event.target.value as 'sample' | 'recorded'); setResult(null) }}><option value="sample">Sample typing</option><option value="recorded">My captured typing</option></select></div>
          <p className="field-hint">{source === 'sample' ? 'Repeatable typing, pauses, corrections and a paste. Synthetic timing; real encoded updates.' : 'Your own edits: first 70% for selection, final 30% for validation.'}</p>
          <div className="capture-row">
            <button className={`text-button ${recording ? 'rust' : ''}`} disabled={!connection || busy} onClick={recording ? stopCapture : startCapture}>
              {recording ? <Square size={12} fill="currentColor" /> : <Circle size={12} />} {recording ? `Stop capture (${captureEdits} edits)` : 'Capture my typing'}
            </button>
            {capture && <span className="field-hint">{capture.edits.length} edits · {(capture.duration / 1000).toFixed(1)}s</span>}
          </div>
          {source === 'recorded' && capture && !readyCapture && <p className="field-hint rust">Capture at least 20 edits over 3 seconds.</p>}
        </section>
        <div className="run-section"><button className="button dark full-width" onClick={run} disabled={busy || recording || (source === 'recorded' && !readyCapture)}>
          {busy ? <><LoaderCircle size={15} className="spin" /> Testing intervals… {progress}%</> : <><Play size={13} fill="currentColor" /> Run the experiment <ArrowRight size={16} /></>}
        </button><p className="fine-print">31 intervals · 0–300 ms · 500 ms delay target</p></div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        {result ? <section className="experiment-results" aria-label="Experiment results">
          <span className="section-index">02 — WHAT WE FOUND</span>
          {selected ? <div className="result-headline"><div><span className="result-number">{selected.window_ms}</span><span className="result-unit">ms</span></div><div className="result-caption">Chosen interval<br /><span className={result.validation_passed ? 'success' : 'rust'}>{result.validation_passed ? '✓ Passed held-out traces' : 'Validation target not met'}</span></div></div> : <div className="no-result"><h3>No feasible interval.</h3><p>This connection cannot meet both targets for these traces. Try fewer contributors or more capacity.</p></div>}
          <ResultsChart result={result} />
          <div className="comparison-heading"><span>HELD-OUT RESULTS</span><span>delay / traffic</span></div>
          <table className="comparison-table"><caption className="sr-only">Policies compared on unseen traces</caption><thead><tr><th>Policy</th><th>p95</th><th>B/s</th></tr></thead><tbody>
            {[{ name: 'Immediate', row: result.results[0] }, { name: 'Fixed · 100 ms', row: result.results[10] }, ...(selected ? [{ name: `Chosen · ${selected.window_ms} ms`, row: selected }] : [])].map(({ name, row }) => <tr key={name}><th scope="row">{name}<span className={row.validation.feasible ? 'success' : 'rust'}>{row.validation.feasible ? 'within targets' : 'outside targets'}</span></th><td>{format(row.validation.latency_ms)}<small> ms</small></td><td>{format(row.validation.rate_bps)}</td></tr>)}
          </tbody></table>
          <p className="field-hint">Budget: {format(result.network.budget_bps)} B/s. Values show the worst trace in each split. Every final replica {result.results.every(row => row.calibration.converged && row.validation.converged) ? 'matched' : 'did not match'}.</p>
          {selected && <button className="button rust-button full-width" disabled={!result.validation_passed || applying || !note || note.window_ms === selected.window_ms} onClick={apply}>{note?.window_ms === selected.window_ms ? <><Check size={15} /> This interval is active</> : applying ? 'Applying…' : <>Use {selected.window_ms} ms for this note <ArrowRight size={15} /></>}</button>}
          <button className="text-button export-button" onClick={() => download(`carbon-experiment-${result.id.slice(0, 8)}.csv`, experimentCSV(result), 'text/csv')}><ArrowDownToLine size={14} /> Export all measurements</button>
        </section> : <div className="experiment-empty"><span className="pencil-mark">T = ?</span><p>One variable.<br />A measurable difference.</p></div>}
        <details className="method-details"><summary>What exactly are we measuring?</summary><p>This is a controlled replay, not a measurement of your internet speed. Real Yjs updates are merged, then delivered through one modelled FIFO relay queue with fixed capacity and propagation delay.</p><p>Traffic counts server-to-peer update bytes and binary WebSocket framing, including fan-out. It excludes TCP/TLS, presence, database writes and initial sync. Typing is never delayed locally.</p><p>Selection uses calibration traces only. Validation traces stay unseen until evaluation. The budget is 80% of channel capacity. All queued updates finish delivery, even after the input trace ends.</p><p>Applying an interval changes live update batching for this note. The selected network preset applies only to the replay; it does not throttle your live connection.</p></details>
        <footer className="experiment-footer">A course project in making better choices.</footer>
      </div>
    </aside>
  </>
}
