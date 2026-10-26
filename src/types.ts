export interface Note {
  id: string
  title: string
  created_at: string
  updated_at: string
  window_ms: number
}
export interface Peer { id: string; name: string }
export type ConnectionState = 'connecting' | 'online' | 'offline' | 'missing'
export interface ConnectionInfo {
  status: ConnectionState
  pending: number
  peers: Peer[]
  session: string
  error: string | null
}
export interface Batch {
  at_ms: number
  bytes: number
  author: number
  edit_times: number[]
}
export interface Scenario {
  name: string
  split: 'calibration' | 'validation'
  duration_ms: number
  users: number
  converged: boolean
  batches: Batch[]
}
export interface Candidate { window_ms: number; scenarios: Scenario[] }
export interface Metrics {
  latency_ms: number
  rate_bps: number
  messages: number
  converged: boolean
  feasible: boolean
}
export interface ScenarioResult extends Metrics {
  name: string
  split: string
  total_bytes: number
  edits: number
  max_queue_ms: number
  drain_ms: number
}
export interface CandidateResult {
  window_ms: number
  calibration: Metrics
  validation: Metrics
  scenarios: ScenarioResult[]
}
export interface ExperimentResult {
  id: string
  created_at: string
  profile: 'normal' | 'shared' | 'limited'
  source: 'sample' | 'recorded'
  network: { capacity_bps: number; budget_bps: number; propagation_ms: number; latency_limit_ms: number }
  selected_window_ms: number | null
  validation_passed: boolean
  results: CandidateResult[]
}
