# CARBON — bandwidth-aware shared notes

CARBON is a real-time plain-text notebook for study groups. It pairs a working CRDT editor with a reproducible optimisation experiment: choose an update-batching interval that keeps remote edits responsive without overwhelming the relay.

The stack is React, Vite and TypeScript with CodeMirror + Yjs; FastAPI provides the HTTP/WebSocket relay; MongoDB or local SQLite stores metadata and CRDT update history. One FastAPI process serves the API and the note room relay.

## Problem

Every immediate keystroke update pays CRDT and WebSocket framing overhead. Combining nearby Yjs updates amortises that cost and can shrink their encoded payload, but makes the first edit wait. CARBON frames this as a constrained timer-selection problem.

For $N$ replicas sharing a note, choose a timer $T$ from a finite set. $T=0$ means immediate transmission. A timer begins with the first pending local edit and never resets as later edits arrive; the batch closes when the timer expires or the content threshold is reached.

## Mathematical formulation

In scenario $\omega$, edit $j$ is created at $t_j$ by author $k_j$ and has encoded size $s_j$. A batch $b$ opens at $a_b$. Let $H$ be WebSocket framing overhead, $R$ relay capacity, $S$ the size trigger and $d$ propagation delay. A batch closes at

```math
f_b = \min\left(a_b + T,\ \inf\left\{ t \ge a_b : \sum_{j:\, a_b \le t_j \le t} s_j \ge S \right\}\right)
```

The theoretical run-length model is $P_b = s_0 r_b + s_1 m_b$, where $m_b$ is edits and $r_b$ contiguous editing runs. The real replay replaces it with the actual byte length from `Y.mergeUpdates` and the encoded update trunk.

The server-to-peer egress queue is FIFO:

```math
\sigma_b = \frac{H + P_b}{R}, \qquad W_1 = 0, \qquad W_{b+1} = \max\left\{ 0,\ W_b + \sigma_b - (f_{b+1} - f_b) \right\}
```

For an edit carried by batch $b$, remote-visible delay is

```math
D_j(T;\omega) = (f_b - t_j) + W_b + \sigma_b + d
```

The terms represent batching, queueing, serialisation and propagation. Batching increases the first term, but can decrease fixed overhead and queue delay.

Let $L_{0.95}(T;\omega)$ be empirical p95 remote delay. Offered traffic is measured before capacity limiting and includes batches drained after the last input:

```math
r(T;\omega) = \frac{\phi \sum_b (H + P_b)}{\Theta / 1000} \quad \text{bytes/s}
```

For calibration scenarios $\Omega_{train}$, CARBON exactly searches the finite problem

```math
\begin{aligned}
\underset{T \in \{0, 10, \ldots, 300\}}{\mathrm{minimise}} \quad & \max_{\omega \in \Omega_{train}} L_{0.95}(T;\omega) \\
\text{subject to} \quad & r(T;\omega) \le B, \\
& L_{0.95}(T;\omega) \le L_{max}, \\
& \mathrm{converge}(T;\omega) = \text{true} \quad \forall\, \omega \in \Omega_{train}.
\end{aligned}
```

$B$ is 80% of selected relay capacity and $L_{max} = 500$ ms is a stated project target. Ties use lower offered rate then smaller $T$. Held-out validation results are never used in selection.

The broader supplied formulation admits $x = (T, S)$ and weighted sample average

```math
J(x) = \frac{1}{K} \sum_i \left[ w_b \frac{B(x;\omega_i)}{B_0(\omega_i)} + w_l \frac{L_{0.95}(x;\omega_i)}{L_{SLO}} \right]
```

CARBON fixes $S$, so enumeration is exact over its 31 declared alternatives.

### Analytic benchmark

For a single Poisson sender of rate $\lambda$, negligible queueing, and effective fixed/marginal batch costs $\kappa, \tilde{s}$,

```math
\mathrm{messageRate}(T) = \frac{\lambda}{1 + \lambda T}, \qquad \beta(T) = \phi \left[ \lambda \tilde{s} + \frac{\lambda \kappa}{1 + \lambda T} \right]
```

Consequently,

```math
\frac{\beta(T)}{\beta(0)} = \frac{\tilde{s} + \kappa / (1 + \lambda T)}{\kappa + \tilde{s}}
```

With low-rate $L_{0.95}(T) \approx T + c_{net}$, the weighted reference is

```math
T_{unc}^{*} = \frac{\left[ \sqrt{\dfrac{w_b \lambda \kappa L_{SLO}}{w_l (\kappa + \tilde{s})}} - 1 \right]_{+}}{\lambda}, \qquad T^{*} = \min\left( T_{unc}^{*},\ L_{SLO} - c_{net},\ T_{max} \right)
```

This is a validation benchmark only: actual Yjs merging, bursty traces, fan-out and queueing make the measured objective non-smooth.

## Algorithm and measurement boundary

1. Generate/capture equal calibration and validation traces.
2. For every candidate timer, merge actual Yjs updates using the anchored timer.
3. Replay through the FIFO relay once per remote recipient.
4. Reject infeasible candidates; select the best calibration result lexicographically.
5. Report validation results unchanged.

The model includes batching, queueing, serialisation, propagation, relay fan-out and unmasked/unfragmented WebSocket framing. It excludes client upload, presence/cursor traffic, initial sync, database persistence and any production-scale optimisation not being benchmarked.

## Collaboration demo

Click **Share note** and open the identical URL in another browser/device. Each user chooses a display name. Connected users receive a stable colour; their avatar, labelled remote caret and selection markers are visible in the paper.

The browser retains a recovery copy. The server durably acknowledges document-update groups, provides history before subscription, and accepts merged offline state on reconnect. This is intentionally designed to be a lightweight real-time study environment rather than a full document platform.

## Linux setup

Install Node.js 22+ (24 recommended) and Python 3.11+. Docker/MongoDB are optional.

```bash
git clone <YOUR_REPOSITORY_URL> carbon
cd carbon
npm ci
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt
npm start
```

Open `http://127.0.0.1:5173`. For separate terminals:

```bash
# terminal 1
. .venv/bin/activate
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000

# terminal 2
npm run dev
```

For a trusted LAN demo, bind both processes to `0.0.0.0` and use the host LAN IP. To use MongoDB locally, run `docker compose up -d`, copy `.env.example` to `.env`, set `MONGODB_URI=mongodb://127.0.0.1:27017/carbon`, and restart the backend.

## Verify

```bash
npm test
npm run test:backend
npm run test:e2e
npm run build
```

Playwright may need `npx playwright install chromium`.

## Minimal live deployment (Render)

The included `Dockerfile` builds Vite and serves it from FastAPI, keeping HTTP and `wss` WebSockets on one origin.

1. Push the repository to GitHub; never commit `.env` or credentials.
2. In [Render](https://dashboard.render.com/), create a **Web Service**, select the repository and choose the Docker runtime.
3. Use the Free plan for a short demo, set health check path to `/api/health`, then deploy. The Dockerfile reads Render's `PORT`.
4. Open `https://<service>.onrender.com/?note=welcome`, click **Share note**, and open that URL in another browser/device.
5. For persistent data, add hosted MongoDB `MONGODB_URI` as a Render environment variable. Without it, SQLite is only suitable for a disposable demo because a container filesystem can be replaced.

Keep one service instance. Free Render services can sleep after inactivity; open the URL before presenting and wait for `/api/health`. See Render's [FastAPI deployment](https://render.com/docs/deploy-fastapi-app) guide for the general pattern.

## Agent setup prompt

```text
You are setting up the CARBON collaborative-notes repository on Linux. Work only
inside the repository and do not change application code. Read README.md and
PROJECT_PROPOSAL.md. Run: npm ci; python3 -m venv .venv; . .venv/bin/activate;
python -m pip install -r backend/requirements.txt; npm test; npm run test:backend;
npm run build. Report every command result and missing prerequisite. For a local
demo run npm start and state the localhost URL. Do not expose the service, use
credentials, push commits, install unrelated packages, or alter the CRDT/batching
experiment. Explain that two browsers must use the same Share note URL.
```

## Report and layout

The five-page arXiv-style report is [REPORT.pdf](REPORT.pdf); editable source: [REPORT.tex](REPORT.tex). `PROJECT_PROPOSAL.md` records scope and the supplied-formulation review; `DESIGN.md` is the design note.

```text
src/lib/collaboration.ts   Yjs transport, recovery, batching and awareness
src/components/Editor.tsx  CodeMirror/Yjs editor binding
backend/main.py            HTTP API, WebSocket room relay and ephemeral awareness
backend/optimizer.py       FIFO evaluation and constrained finite search
Dockerfile                 single-service public deployment
REPORT.tex                 mathematical report source
```
