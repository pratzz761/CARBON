import * as Y from 'yjs'
import type { Candidate, ExperimentResult, Scenario } from '../types'

export interface TraceEdit { at: number; author: number; update: Uint8Array }
export interface Trace {
  name: string
  split: 'calibration' | 'validation'
  duration: number
  users: number
  initial: Uint8Array
  edits: TraceEdit[]
}
export interface Recording { initial: Uint8Array; edits: TraceEdit[]; duration: number }

function random(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6D2B79F5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

export function sampleTrace(users: number, burst: boolean, seed: number, split: Trace['split']): Trace {
  const rng = random(seed)
  const duration = 12000
  const edits: TraceEdit[] = []
  const letters = 'Good notes make room for a question. We learn more when we think together. '
  for (let author = 0; author < users; author++) {
    const doc = new Y.Doc()
    // Stable 32-bit IDs retain the encoding width of typical browser-generated IDs.
    doc.clientID = 1_500_000_000 + author
    const text = doc.getText('notes')
    let at = 100 + author * 50 + rng() * 80
    let count = 0
    doc.on('update', (update: Uint8Array) => edits.push({ at, author, update }))
    while (at < duration - 100) {
      if (burst && at % 1800 > 700) {
        at += 1800 - at % 1800 + rng() * 70
        continue
      }
      doc.transact(() => {
        if (count > 0 && count % 41 === 0 && text.length) text.delete(text.length - 1, 1)
        text.insert(text.length, count === 37 ? 'a shared thought ' : letters[count % letters.length])
      })
      count++
      at += burst ? 60 + rng() * 55 : 115 + rng() * 90
    }
    doc.destroy()
  }
  const empty = new Y.Doc()
  const initial = Y.encodeStateAsUpdate(empty)
  empty.destroy()
  return { name: `${burst ? 'Bursts & a paste' : 'Steady typing'} / ${split}`, split,
    duration, users, initial, edits: edits.sort((a, b) => a.at - b.at || a.author - b.author) }
}

export function recordedTraces(recording: Recording, users: number): Trace[] {
  if (recording.edits.length < 20 || recording.duration < 3000) {
    throw new Error('Capture at least 20 edits over 3 seconds before running the experiment.')
  }
  const cut = Math.floor(recording.edits.length * 0.7)
  const training = recording.edits.slice(0, cut)
  const validation = recording.edits.slice(cut)
  const offset = validation[0].at
  const doc = new Y.Doc()
  Y.applyUpdate(doc, recording.initial)
  for (const event of training) Y.applyUpdate(doc, event.update)
  const validationInitial = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return [
    { name: 'Captured typing / first 70%', split: 'calibration', users,
      duration: Math.max(1000, offset), initial: recording.initial, edits: training },
    { name: 'Captured typing / final 30%', split: 'validation', users,
      duration: Math.max(1000, recording.duration - offset), initial: validationInitial,
      edits: validation.map(edit => ({ ...edit, at: edit.at - offset })) },
  ]
}

export function batchTrace(trace: Trace, windowMs: number): Scenario {
  const pending = new Map<number, TraceEdit[]>()
  const batches: (Scenario['batches'][number] & { update: Uint8Array })[] = []
  const flush = (author: number, at: number) => {
    const edits = pending.get(author)
    if (!edits?.length) return
    const update = Y.mergeUpdates(edits.map(edit => edit.update))
    batches.push({ at_ms: at, author, bytes: update.length,
      edit_times: edits.map(edit => edit.at), update })
    pending.delete(author)
  }
  for (const event of trace.edits) {
    for (const [author, edits] of pending) {
      const deadline = edits[0].at + windowMs
      if (deadline <= event.at) flush(author, deadline)
    }
    const edits = pending.get(event.author) ?? []
    edits.push(event)
    pending.set(event.author, edits)
    if (windowMs === 0 || edits.reduce((sum, edit) => sum + edit.update.length, 0) >= 16384) {
      flush(event.author, event.at)
    }
  }
  for (const [author, edits] of pending) flush(author, edits[0].at + windowMs)
  batches.sort((a, b) => a.at_ms - b.at_ms || a.author - b.author)

  // Independent per-author generation avoids cross-author causal dependencies.
  // Deliver every batch (also to its sender; duplicate application is harmless).
  const expected = new Y.Doc()
  Y.applyUpdate(expected, trace.initial)
  for (const event of trace.edits) Y.applyUpdate(expected, event.update)
  const expectedText = expected.getText('notes').toString()
  let converged = true
  for (let user = 0; user < trace.users; user++) {
    const replica = new Y.Doc()
    Y.applyUpdate(replica, trace.initial)
    for (const event of trace.edits) if (event.author === user) Y.applyUpdate(replica, event.update)
    for (const batch of batches) if (batch.author !== user) Y.applyUpdate(replica, batch.update)
    converged &&= replica.getText('notes').toString() === expectedText
    replica.destroy()
  }
  expected.destroy()
  return { name: trace.name, split: trace.split, users: trace.users,
    duration_ms: trace.duration, converged,
    batches: batches.map(({ update: _update, ...batch }) => batch) }
}

export async function prepareCandidates(
  users: number,
  recording: Recording | null,
  progress: (percent: number) => void,
): Promise<Candidate[]> {
  const traces = recording ? recordedTraces(recording, users) : [
    sampleTrace(users, false, 17, 'calibration'),
    sampleTrace(users, true, 29, 'calibration'),
    sampleTrace(users, false, 83, 'validation'),
    sampleTrace(users, true, 97, 'validation'),
  ]
  const candidates: Candidate[] = []
  for (let window_ms = 0; window_ms <= 300; window_ms += 10) {
    candidates.push({ window_ms, scenarios: traces.map(trace => batchTrace(trace, window_ms)) })
    progress(Math.round((window_ms / 300) * 95))
    // Yield so progress and cancellation remain responsive during encoding.
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return candidates
}

export function experimentCSV(experiment: ExperimentResult): string {
  const columns = ['experiment_id', 'profile', 'source', 'timer_ms', 'selected', 'trace', 'split',
    'p95_ms', 'offered_bytes_per_second', 'messages', 'edits', 'total_bytes',
    'max_queue_ms', 'drain_ms', 'converged', 'feasible']
  const rows = experiment.results.flatMap(result => result.scenarios.map(scenario => [
    experiment.id, experiment.profile, experiment.source, result.window_ms,
    result.window_ms === experiment.selected_window_ms, scenario.name, scenario.split,
    scenario.latency_ms, scenario.rate_bps, scenario.messages, scenario.edits,
    scenario.total_bytes, scenario.max_queue_ms, scenario.drain_ms, scenario.converged, scenario.feasible,
  ]))
  const escape = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`
  return [columns, ...rows].map(row => row.map(escape).join(',')).join('\r\n')
}
