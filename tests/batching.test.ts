import assert from 'node:assert/strict'
import test from 'node:test'
import * as Y from 'yjs'
import { batchTrace, prepareCandidates, recordedTraces, sampleTrace, type Trace } from '../src/lib/experiment.ts'

function traceAt(times: number[]): Trace {
  const doc = new Y.Doc()
  doc.clientID = 1000
  const initial = Y.encodeStateAsUpdate(doc)
  const edits: Trace['edits'] = []
  for (const at of times) {
    const capture = (update: Uint8Array) => edits.push({ at, author: 0, update })
    doc.on('update', capture)
    doc.getText('notes').insert(doc.getText('notes').length, 'x')
    doc.off('update', capture)
  }
  doc.destroy()
  return { name: 'Test', split: 'calibration', initial, edits, users: 3, duration: 1000 }
}

test('timer is anchored to the first edit rather than reset by typing', () => {
  const result = batchTrace(traceAt([10, 70, 105, 115]), 100)
  assert.equal(result.batches.length, 2)
  assert.equal(result.batches[0].at_ms, 110)
  assert.deepEqual(result.batches[0].edit_times, [10, 70, 105])
  assert.equal(result.batches[1].at_ms, 215)
  assert.equal(result.converged, true)
})

test('immediate-send policy includes every edit without artificial waiting', () => {
  const result = batchTrace(traceAt([10, 70, 105]), 0)
  assert.deepEqual(result.batches.map(b => b.at_ms), [10, 70, 105])
  assert.equal(result.converged, true)
})

test('pending edits flush after the final trace event', () => {
  const trace = traceAt([990])
  const result = batchTrace(trace, 100)
  assert.equal(result.batches[0].at_ms, 1090)
  assert.equal(result.duration_ms, 1000)
})

test('samples are reproducible and include concurrent corrections and a paste', () => {
  const first = sampleTrace(3, true, 29, 'calibration')
  const second = sampleTrace(3, true, 29, 'calibration')
  assert.deepEqual(first.edits.map(e => [e.at, e.author, [...e.update]]), second.edits.map(e => [e.at, e.author, [...e.update]]))
  assert.equal(new Set(first.edits.map(e => e.author)).size, 3)
  assert.equal(batchTrace(first, 200).converged, true)
})

test('every candidate sees the same edit counts and converges', async () => {
  const candidates = await prepareCandidates(3, null, () => {})
  assert.equal(candidates.length, 31)
  const counts = candidates[0].scenarios.map(s => s.batches.reduce((n, b) => n + b.edit_times.length, 0))
  for (const candidate of candidates) {
    assert.deepEqual(candidate.scenarios.map(s => s.batches.reduce((n, b) => n + b.edit_times.length, 0)), counts)
    assert.ok(candidate.scenarios.every(s => s.converged))
  }
})

test('recorded validation starts from the state at the split', () => {
  const trace = traceAt(Array.from({ length: 30 }, (_, i) => 100 + i * 110))
  const split = recordedTraces({ initial: trace.initial, edits: trace.edits, duration: 3500 }, 3)
  assert.equal(split[0].edits.length, 21)
  assert.equal(split[1].edits.length, 9)
  assert.equal(split[1].edits[0].at, 0)
  assert.equal(batchTrace(split[1], 100).converged, true)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, split[1].initial)
  assert.equal(doc.getText('notes').length, 21)
  doc.destroy()
})

test('CRDT handles out-of-order delivery and duplicated updates', () => {
  const trace = sampleTrace(3, true, 97, 'validation')
  const a = new Y.Doc(), b = new Y.Doc()
  for (const edit of trace.edits) Y.applyUpdate(a, edit.update)
  for (const edit of [...trace.edits].reverse()) {
    Y.applyUpdate(b, edit.update)
    Y.applyUpdate(b, edit.update)
  }
  assert.equal(a.getText('notes').toString(), b.getText('notes').toString())
  a.destroy(); b.destroy()
})
