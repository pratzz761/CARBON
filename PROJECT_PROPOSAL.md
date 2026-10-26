# Proposed scope: responsive shared lecture notes

Status: scope accepted for implementation. The initial local application follows this proposal; see README.md for setup, measurement boundaries and implemented behaviour. No additional course-specific solver requirement was supplied.

## 1. What the supplied PDF proposes

Read source: `crdt_batching_formulation.pdf`, all 11 physical pages.

The existing project optimises transport of collaborative document changes. Each client collects CRDT updates and sends them when a timer T expires or a size threshold S is reached. The objective combines normalised transmitted bytes and p95 remote-edit latency, with latency and link-utilisation constraints. CRDT convergence is a correctness requirement, not an optimisation objective.

Its useful components are:

- A real collaborative editor using an existing CRDT library.
- A clear trade-off between waiting to combine updates and sending more messages.
- Immediate-send and fixed-window baselines.
- The same edit traces for every policy, actual encoded update lengths, and convergence checks.

The following sections make the proposal much broader than a small course project needs:

| PDF section | Proposed treatment |
| --- | --- |
| 3: Poisson, MMPP and Hawkes workloads | Use recorded typing traces and one reproducible burst/paste trace. |
| 4: optimise both timer and size threshold | Optimise only the timer; retain a fixed buffer safety threshold. |
| 6: weighted, CVaR and Pareto formulations | Use one constrained objective with understandable units. |
| 7: analytic fluid model and square-root rule | Optional background in the report; not an application subsystem. |
| 8: grid, random search and genetic algorithm comparisons | Use finite enumeration unless the course requires another method. |
| 9: adaptive three-parameter policy | Defer; select one fixed timer for each measured session profile. |

Several qualifications in the PDF matter when presenting results:

- Its worked example is explicitly illustrative. The reported 34% byte reduction is not an experimental result.
- Its main latency constraint averages scenario p95 values. This does not guarantee that every scenario meets the target.
- Section 7.1 says the latency constraint is always active, but its own subsequent formula permits an interior optimum or T = 0. Treat that claim as conditional.
- The analytic model assumes negligible queueing and a constant network transmission term. It cannot establish latency improvements under congestion without further measurement.
- Batching cannot remove propagation delay or make an unavailable network available. It adds waiting and can help overall latency only when reduced communication work offsets that wait.

## 2. Recommended real-world case

Three to five students jointly write lecture or study-group notes. They need their own typing to appear immediately and their classmates' edits to arrive promptly, even when the collaboration channel has limited bandwidth.

Working title: **CARBON — Shared lecture notes with bandwidth-constrained synchronisation**.

Proposed problem statement:

> Select the update-batching interval that minimises the time until classmates see an edit, while keeping the collaboration traffic within a fixed bandwidth budget and preserving document convergence.

The new primary objective is collaboration responsiveness. Network usage becomes a resource constraint. This is a narrower continuation of the original project, with a concrete user and measurable outcome.

This remains a modest systems optimisation project. A few people typing plain text may not stress an ordinary connection. Normal-network experiments must be included, and intentionally restricted conditions must be labelled as controlled experiments. We should report no improvement if that is what the evidence shows.

## 3. Small mathematical formulation

Use one timer T for all contributors in a session. Illustrative candidate set:

`T ∈ {0, 10, 20, ..., 300} milliseconds`

The set and upper bound can be adjusted after an initial measurement, then fixed before final comparisons. T = 0 means immediate send. A timer starts at the first pending local update and does not reset with every subsequent keystroke.

For a fixed input trace and network profile, measure:

- `D[j,k](T)`: elapsed time from creation of edit j until remote client k applies it. Include batching, queueing and delivery. Count an edit as visible only when its causal dependencies have arrived and it is integrated.
- `L95(T)`: the 95th percentile across edit/remote-recipient delay observations.
- `r(T)`: total offered collaboration-update bytes divided by the fixed trace duration, including updates flushed after the final input event. Count the full selected network boundary consistently, including relay fan-out.
- `B`: the collaboration traffic budget in bytes/second, fixed for the comparison.
- `Lmax`: a provisional 500 ms responsiveness target; this is a project requirement to test, not a universal usability standard.

Solve:

```text
minimise    L95(T)
subject to  r(T) <= B
            L95(T) <= Lmax
            T belongs to the candidate set
            all replicas converge after delivery finishes
```

If several candidates have equal measured latency, prefer the one with lower offered traffic, then the smaller timer. If none is feasible, return "target not achievable for this profile" with the measured reason.

For multiple calibration traces, require both resource and latency constraints on each trace and minimise their worst p95. This avoids hiding a poor trace inside an average without introducing a separate robust-optimisation subsystem.

The network profile has a fixed service capacity C. Set B below C to leave some capacity headroom, with the chosen values documented after calibration. Measure offered traffic before the capacity limiter: measuring only capped output would make the bandwidth constraint meaningless. Report growing queues and undelivered edits rather than silently discarding them.

## 4. Solution method

Enumerate the 31 candidate timer values. For each, replay identical edits through the same delivery model, calculate metrics, reject infeasible candidates, and choose the best feasible result.

This finds an optimum over the declared finite set for the calibration traces. It does not prove an optimum over every possible real-valued timer or future session.

Finite enumeration is sufficient for one decision variable. Before committing, confirm whether the course mandates a particular technique such as linear programming, dynamic programming or a genetic algorithm. If it does, revise the formulation to fit that requirement before coding.

The selected timer is applied to subsequent collaboration updates. Version one does not continuously retune it during typing. A user can rerun the experiment when changing the network profile.

## 5. Application and experiment

The product is one collaborative notes workspace:

1. Create or open a note through a room link; enter a display name.
2. Edit plain text simultaneously in multiple browser windows or devices.
3. See connected collaborators and the save/synchronisation status.
4. Open an experiment panel, run a replay and inspect the selected timer.
5. Compare immediate send, a predeclared fixed timer such as 100 ms, and the selected timer.

Show p95 remote delay, offered bytes/second, message count, constraint feasibility and final document agreement. Show the candidate results in a simple chart or table, and support CSV export for the report. Display measured values rather than decorative performance counters.

Use separate, clearly named normal and constrained network profiles. One shared FIFO queue in the replay harness is enough; a reduced-bandwidth preset should actually delay delivery in the controlled experiment. It should not merely change numbers in the UI. Keep experiment rooms separate from the user's saved notes.

Evaluation:

- Capture a small set of real typing traces and one repeatable paste/burst trace.
- Use actual Yjs update payloads; merge updates and measure their resulting lengths.
- Select the timer on calibration traces and evaluate it on held-out traces without retuning on them.
- Include sparse typing and unconstrained delivery, where immediate send may win.
- Include the final draining of pending updates in latency measurements.
- Compare final replicas, including after concurrent insertions/deletions and reconnects.
- For reproducible timing, run replay clients under a common monotonic clock. Cross-device one-way latency requires clock alignment; an acknowledgement round trip must be labelled as such.

Do not conflate encoded application bytes with total internet traffic. If counting WebSocket framing, document the framing assumptions. TCP/IP, TLS, retransmission and packet coalescing need packet-level measurement for genuine wire-byte claims.

## 6. Proposed implementation

Use the requested FARM stack:

- **React + Vite:** workspace and experiment results.
- **An established editor binding + Yjs:** concurrent text edits and merged binary updates.
- **FastAPI:** room WebSockets, note APIs and a small Python optimisation routine.
- **MongoDB:** note metadata, persisted document updates/checkpoints and saved experiment summaries.

Yjs handles document semantics in the clients. FastAPI relays and persists binary updates rather than implementing a new CRDT. Reconnection requires an explicit state-exchange/replay mechanism; a live broadcast alone is insufficient. Persist CRDT state, not just the rendered text, so reloads preserve collaborative history.

Use one backend process for the student demonstration. Treat multiple workers, Redis, authentication, permissions, rich text, comments, attachments and production deployment as outside version one. MongoDB persistence should be coalesced on a fixed policy independent of the transport timer, so the experiment does not accidentally optimise database writes at the same time.

Keep normal presence traffic outside the batched document-update channel. State whether experimental metrics exclude presence, initial document loading, reconnect catch-up and database traffic.

One practical split is: the browser replay harness produces real Yjs payload lengths and deterministic timing observations; Python evaluates the candidate metrics and returns the selected timer. This keeps CRDT encoding in its existing JavaScript library and avoids introducing a second CRDT implementation in Python.

## 7. Design interpretation

Follow the supplied `DESIGN.md` as the source of visual direction:

- Page background `#efe8d8`; paper/editor `#f6f0e2`; secondary surfaces `#e4dbc6`.
- Ink `#2e2a26`; restrained rust accent `#b2452e`.
- Courier New, with the specified 2.5 rem bold heading and 1 rem body starting points.
- CSS Grid/Flexbox, visible rules, compact labels and a paper/typewriter character.
- A small notes list, a generous writing area and an optional experiment drawer.
- Subtle grain, tactile hover/press feedback and purposeful motion with reduced-motion support.

The design file lists many possible effects. Use a restrained combination that supports its typewriter/brutalist direction rather than applying every effect simultaneously. Avoid a generic marketing landing page or a wall of dashboard cards; the editor should dominate.

## 8. Decisions for the discussion

1. Does the proposed latency-first shared lecture-notes problem match the project you want to present?
2. Does the course require a named optimisation method, or is finite constrained search acceptable?

After those decisions, initialise the local React project and implement the agreed scope incrementally. The original PDF and design file remain the reference materials.

## Sources checked

- [Yjs document updates](https://docs.yjs.dev/api/document-updates): update merging, ordering, idempotence and state-vector exchange.
- [FastAPI WebSockets](https://fastapi.tiangolo.com/advanced/websockets/): connections and the single-process limitation of an in-memory connection manager.
- [RFC 6455, section 5.2](https://datatracker.ietf.org/doc/html/rfc6455#section-5.2): WebSocket framing; per-message overhead should not be invented.
