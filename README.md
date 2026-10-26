# CARBON — A shared notebook

A small optimisation-techniques project: find the update-batching interval that minimises remote edit delay within a collaboration traffic budget. The application is a real collaborative plain-text notebook, with a separate, reproducible experiment.

React + Vite + TypeScript, CodeMirror + Yjs, FastAPI, and MongoDB. A built-in SQLite fallback lets you work without a database service. The interface follows `DESIGN.md`.

## Run on Windows

Node.js 22.18+ (24 recommended) and Python 3.11+ are required.

```powershell
npm.cmd install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
npm.cmd start
```

Open **http://127.0.0.1:5173**. Both the frontend and backend start from one command. Stop them with Ctrl+C. A prepared copy of `backend/seed.json` is included; `npm.cmd run seed` regenerates the two starter notes if needed.

For separate terminals:

```powershell
# Terminal 1
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000

# Terminal 2
npm.cmd run dev
```

On macOS/Linux use `.venv/bin/python` and `npm` instead. Vite proxies `/api` and `/ws` to FastAPI. The backend runs as one process; do not add workers to the in-memory room relay.

## Use MongoDB

Without `MONGODB_URI`, notes are durably stored in `data/carbon.sqlite3`. This is displayed as local storage in the sidebar. To use the full FARM stack, start MongoDB and configure the backend:

```powershell
docker compose up -d
Copy-Item .env.example .env
```

Uncomment `MONGODB_URI=mongodb://127.0.0.1:27017` in `.env`, then restart the backend. A configured but unreachable MongoDB causes startup to fail clearly; it does not silently switch storage. Local data and MongoDB data are separate; switching stores does not migrate notes.

## Try collaboration

1. Enter a display name at the bottom of the sidebar.
2. Open a starter note or create a fresh page.
3. Use **Share note**, then open the copied URL in another browser window. Both users can edit concurrently.
4. Take one tab offline using browser developer tools, continue typing, and reconnect. Its changes merge back into the room.
5. Export the note as `.txt` when needed.

The default server binds to loopback. Sharing between tabs on this computer works immediately. For two devices on the same trusted local network, bind FastAPI to `0.0.0.0` and start Vite with `npm.cmd run dev -- --host 0.0.0.0`; use the host computer's LAN IP on both devices. Vite's proxy still connects to the local backend. The demo has room links rather than accounts or access controls.

## Run the optimisation experiment

Open **The experiment**, select a network profile and 2–5 contributors, then run the replay. It compares:

- Immediate transmission (`T = 0`).
- A predeclared 100 ms timer.
- The timer selected by constrained finite search over `0, 10, ..., 300 ms`.

The Python optimiser minimises the worst calibration-trace p95 delay, subject to a traffic budget of 80% of relay capacity, p95 ≤ 500 ms on every calibration trace, and final replica agreement. Ties favour lower offered traffic, then the smaller timer. Selection never uses validation outcomes. Applying a timer is enabled only if it also passes the held-out traces; this is a conservative demo rule, not a future-performance guarantee.

**Sample typing** uses two deterministic calibration traces and two independently seeded validation traces: steady typing and bursts with corrections and a paste. Each sample contributor generates edits independently, so its creation history does not depend on another contributor's delayed edits. IDs have typical 32-bit encoding widths. These are synthetic timings with actual Yjs update bytes, not user-study data.

**Capture my typing** records real local Yjs transactions and their timing. Start it, write in the note, then return to the experiment to stop. Capture at least 20 edits over 3 seconds. The first 70% of edits are calibration; the final 30% are validation, with the correct CRDT state at the split. Capture stops if a remote update arrives, because mixing asynchronous remote observations would invalidate this simple trace model.

All 31 choices use the same traces. Updates are merged using `Y.mergeUpdates`, and final replicas are compared with an unbatched reference. The buffer safety threshold is fixed at 16 KiB, not optimised. Timers begin at the first pending edit and do not reset on every keystroke.

### Measurement boundary

The replay models one shared FIFO **server-to-peer egress channel**. Each batch is transmitted separately to each other contributor, including its actual payload size and unmasked, unfragmented WebSocket framing. The service time is bytes / channel capacity; propagation delay is then added. Per-author ordering preserves the generated traces' causal dependencies.

The p95 includes batching, queueing, serialisation and propagation. All queued messages finish delivery, including those sent after the final input event. Offered bytes/second divides total traffic by the fixed input-trace duration, not by a throttled output rate. The CSV includes queue delay, final drain time, edit counts, feasibility and convergence for every candidate and trace.

These are controlled replay results, not observed one-way timings on your live network. The selected preset does not throttle the live editor. The replay excludes client upload, initial sync, presence, database traffic, TCP/TLS overhead, retransmission and packet coalescing. We do not claim total wire-byte savings or that these restricted channel capacities represent a typical connection.

On the bundled three-contributor shared profile, the initial implementation selects 90 ms; held-out worst-trace p95 is approximately 304 ms versus 372 ms for immediate sending. On the normal profile it selects 0 ms. These are reproducible model results, not general promises. Other contributor counts or captured typing may yield no feasible interval.

## Persistence and recovery

- Browser documents keep a coalesced full-state recovery copy in localStorage, including disconnected edits. This is recovery after an already-loaded page, not a service-worker/PWA implementation.
- The server relays binary Yjs updates and persists them in independent 500 ms groups. A client sees “All changes saved” only after durable acknowledgement.
- New/reconnecting clients receive the room's update history before subscribing to subsequent broadcasts. They return their merged local state to recover offline changes.
- Rename and room timer settings are ordinary shared metadata; text uses the CRDT.
- This small version retains an append-only update history. Compaction, authentication, rich text, accounts, multi-worker scaling and production hosting are outside its scope.

## Verification

```powershell
npm.cmd test
npm.cmd run test:backend
npm.cmd run test:e2e
npm.cmd run build
```

The unit/integration tests check timer semantics, final draining, equal traces, state splits, duplicate and reordered updates, constraint handling, validation isolation, relay delivery, persistent acknowledgements and storage across restarts.

Browser tests use Microsoft Edge on Windows by default. To use an installed Chrome, set `$env:PLAYWRIGHT_CHANNEL="chrome"`. Elsewhere install Playwright Chromium using `npx playwright install chromium`. Tests start and stop their own servers and use separate data under ignored `test-results/`. Desktop/mobile screenshots are saved there, along with failure traces.

## Production build, local serving

```powershell
npm.cmd run build
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

When `dist/` exists at backend startup, FastAPI serves it alongside the API and WebSocket endpoints at http://127.0.0.1:8000. Start the backend after building.

## Files

```text
src/App.tsx                 Notebook workspace
src/components/Editor.tsx   CodeMirror / Yjs binding
src/components/Experiment.tsx
src/lib/collaboration.ts   Batching, WebSocket, recovery and acknowledgements
src/lib/experiment.ts      Actual update generation, merging and replica checks
backend/main.py            HTTP API and single-process room relay
backend/optimizer.py       FIFO evaluation and constrained search
backend/storage.py         MongoDB and local persistence
tests/                     Core tests
e2e/                       Browser integration tests
```

The detailed scope and PDF review are in `PROJECT_PROPOSAL.md`. The original PDF and `DESIGN.md` are preserved.
#   C A R B O N  
 