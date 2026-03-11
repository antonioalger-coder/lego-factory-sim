# LEGO Microchip Factory Simulator

**An interactive operations management simulation for MBA programs and business education.**

Teams run a microchip factory under time pressure, making real-time decisions about workforce allocation, capacity investment, and order prioritization. Every decision has trade-offs. Every second counts.

---

## Table of Contents

- [Overview](#overview)
- [Learning Objectives](#learning-objectives)
- [How It Works](#how-it-works)
- [The Production Pipeline](#the-production-pipeline)
- [Game Mechanics](#game-mechanics)
- [Strategic Decisions](#strategic-decisions)
- [KPIs & Scoring](#kpis--scoring)
- [Session Flow](#session-flow)
- [Deployment](#deployment)
- [Local Development](#local-development)
- [Architecture](#architecture)

---

## Overview

The LEGO Microchip Factory Simulator places teams in a **10-minute production challenge** where they must manufacture, quality-test, and ship microchip orders under varying urgency levels. One player acts as the **Director** (factory manager), while others operate as **Operators** at individual production stages.

The simulation surfaces real operations management concepts:

| Concept | How It Appears |
|---------|---------------|
| **Theory of Constraints** | Assembly stage is the bottleneck (longest processing times, highest capacity) |
| **Capacity Planning** | Second oven purchase decision — $2,000 investment vs. throughput gain |
| **WIP Management** | Overfilling queues creates delays; underfilling ovens wastes capacity |
| **Order Prioritization** | EXPRESS orders pay 1.5x but expire in 90 seconds |
| **Resource Allocation** | 3 strategic changes limit forces upfront planning over reactive management |

---

## Learning Objectives

1. **Identify bottlenecks** in a multi-stage production system
2. **Optimize throughput** by balancing resource allocation across stages
3. **Evaluate trade-offs** between capacity investment, speed, and revenue
4. **Plan under uncertainty** — random orders with varying urgency and chip complexity
5. **Coordinate as a team** — Director delegates, Operators execute
6. **Analyze post-game metrics** to identify what went wrong and why

---

## How It Works

```
                    ┌─────────────────────────────────────┐
                    │           DIRECTOR (1 player)        │
                    │  Allocates workers, monitors KPIs,   │
                    │  makes strategic decisions            │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────┴──────────────────────┐
                    │         WebSocket Server              │
                    │    (real-time state relay)            │
                    └──────────────┬──────────────────────┘
                                   │
              ┌────────────┬───────┴───────┬──────────────┐
              ▼            ▼               ▼              ▼
         ┌─────────┐ ┌─────────┐   ┌─────────┐   ┌─────────┐
         │Operator 1│ │Operator 2│   │Operator 3│   │Operator N│
         │(phone/  │ │(laptop) │   │(tablet) │   │  (any   │
         │ laptop) │ │         │   │         │   │ device) │
         └─────────┘ └─────────┘   └─────────┘   └─────────┘
```

1. **Director** creates a room and shares a 4-letter code (e.g., `HXKP`)
2. **Operators** join from any device by entering the room code
3. Director **plans strategy** during staging — assigns workers to stages
4. Director **starts the simulation** — 10-minute countdown begins
5. Orders arrive every 60 seconds with random chip types and urgency
6. Operators **interact with their assigned stage** (pick bricks, assemble chips, load ovens, ship orders)
7. Simulation ends — **Debrief screen** shows KPIs, bottleneck analysis, and what-if scenarios

---

## The Production Pipeline

```
  ORDERS          📦 WAREHOUSE      🔧 ASSEMBLY       🔥 OVEN          ✅ QA          🚚 LOGISTICS
  ARRIVE    ──►   Pick & kit    ──►  Build chips  ──►  Weld batch  ──►  Inspect   ──►  Ship orders
                  brick stock        per pattern       (up to 8)       (5s each)      to customers
                  (max 2 ops)        (max 3 ops)       (max 2 ops)    (max 1 op)     (max 1 op)
```

### Stage Details

| Stage | Max Workers | What Happens | Processing Time |
|-------|-------------|-------------|-----------------|
| **Warehouse** | 2 | Pick colored bricks from stock to kit an order | Bot interval: 4s |
| **Assembly** | 3 | Place bricks on a grid pattern to build each chip | ALPHA: 15s, BETA: 25s, GAMMA: 40s |
| **Oven** | 2 | Load up to 8 chips per batch, fire the oven to weld | Batch time = longest chip type in batch |
| **QA** | 1 | Automatic inspection of each completed chip | 5s per chip |
| **Logistics** | 1 | Ship completed orders to earn revenue | Bot interval: 2s |

### Chip Types

```
┌──────────┬──────────────┬────────┬──────────┬──────────┬────────┐
│   Chip   │    Label     │ Pieces │ Assembly │   Oven   │ Value  │
├──────────┼──────────────┼────────┼──────────┼──────────┼────────┤
│  ALPHA   │  The Basic   │   4    │   15s    │   10s    │  $100  │
│  BETA    │  The Pro     │   8    │   25s    │   15s    │  $250  │
│  GAMMA   │  The Elite   │  12    │   40s    │   20s    │  $500  │
└──────────┴──────────────┴────────┴──────────┴──────────┴────────┘
```

GAMMA chips are 5x more valuable than ALPHA but take 2.7x longer to assemble — a deliberate complexity-vs-value trade-off.

---

## Game Mechanics

### Orders

- **Arrive every 60 seconds** (up to 10 orders per simulation)
- Random chip type: ALPHA, BETA, or GAMMA
- Random quantity: 2, 4, 6, or 8 chips per order
- Random urgency level:

| Urgency | Expiry | Revenue Multiplier | Risk/Reward |
|---------|--------|-------------------|-------------|
| STANDARD | 3 min | 1.0x | Balanced — enough time if pipeline flows |
| EXPRESS | 90 sec | 1.5x | High reward, but expires fast |
| BULK | 5 min | 0.8x | Lower value, but forgiving deadline |

- **Expired order penalty**: -$50 per expired order

### Resource Constraints

**Starting Brick Inventory:**

| Color | Stock | Used By |
|-------|-------|---------|
| Red | 80 | ALPHA |
| White | 80 | ALPHA |
| Blue | 60 | BETA |
| Yellow | 60 | BETA |
| Black | 40 | GAMMA |
| Green | 40 | GAMMA |
| Silver | 40 | GAMMA |

Low stock alert triggers when any color drops below 20 units.

**Oven Capacity:** 8 chips per batch. Firing a half-empty oven wastes capacity — but waiting too long creates bottlenecks.

**Second Oven:** Available after 3 minutes. Costs $2,000 (deducted from net score). Doubles welding throughput. **Uses 1 of 3 strategic changes.**

---

## Strategic Decisions

Teams are limited to **3 strategic changes** during the simulation. This forces deliberate upfront planning rather than constant reactive adjustments.

### What Counts as a Strategic Change

| Action | Cost |
|--------|------|
| Reassigning a worker to a different stage | 1 change |
| Purchasing the second oven ($2,000) | 1 change |
| Initial assignments during staging | **Free** |
| Assigning a newly joined operator | **Free** |

### Key Strategic Questions

```
┌─────────────────────────────────────────────────────────────────┐
│                    STRATEGY DECISION TREE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. WORKFORCE ALLOCATION                                        │
│     ├── Assembly is the bottleneck — assign max 3 operators?    │
│     ├── QA has 1 slot but processes 5s/chip — will it clog?     │
│     └── Warehouse needs consistent kitting — 1 or 2 operators?  │
│                                                                 │
│  2. CAPACITY INVESTMENT                                         │
│     ├── Buy 2nd oven for $2,000?                                │
│     ├── ROI: Need to ship ~20 extra ALPHA chips to break even   │
│     └── Uses 1 of 3 strategic changes                           │
│                                                                 │
│  3. ORDER PRIORITIZATION                                        │
│     ├── Chase EXPRESS orders (1.5x) but risk expiry?            │
│     ├── Focus on GAMMA ($500/chip) for max value?               │
│     └── Play it safe with ALPHA (fast, cheap, reliable)?        │
│                                                                 │
│  4. BATCH OPTIMIZATION                                          │
│     ├── Full batches (8 chips) = 100% oven efficiency           │
│     ├── Small batches = faster turnaround but wasted capacity   │
│     └── Mixed chip types: batch time = slowest chip             │
│                                                                 │
│  5. CHANGE MANAGEMENT                                           │
│     ├── Save changes for emergencies?                           │
│     ├── Use early to fix a bad initial allocation?              │
│     └── Reserve 1 change for the 2nd oven decision?             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## KPIs & Scoring

### Real-Time Dashboard (Director View)

| Metric | Formula | Target |
|--------|---------|--------|
| **Net Score** | Revenue - Penalties - Oven Cost | Maximize |
| **Throughput** | Shipped chips / elapsed minutes | Higher = better pipeline flow |
| **Oven Utilization** | Total oven run time / elapsed time | >80% = good |
| **Oven Efficiency** | Average batch size / 8 | 100% = always full batches |
| **Fulfillment Rate** | Shipped orders / total orders | 100% = no expired orders |
| **Avg Lead Time** | Mean time from order arrival to shipment | Lower = more responsive |
| **WIP** | Chips in all queues + in-progress | Monitor for bottlenecks |
| **Expired Orders** | Orders that passed their deadline | Each costs -$50 |

### Post-Game Debrief

The debrief screen provides:

1. **Final Score** — Net revenue after all penalties and investments
2. **Bottleneck Analysis** — Idle time per stage reveals where the pipeline stalled
3. **What-If Analysis** — Shows how much revenue was lost to underutilized oven batches
4. **Stage-by-Stage Breakdown** — Processing counts and efficiency per stage

---

## Session Flow

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────┐
│  LOBBY   │────►│   STAGING    │────►│   RUNNING    │────►│  DEBRIEF │
│          │     │              │     │              │     │          │
│ Create/  │     │ Assign team  │     │ 10-minute    │     │ KPIs,    │
│ Join     │     │ Review       │     │ simulation   │     │ analysis │
│ room     │     │ strategy     │     │              │     │ what-ifs │
│          │     │ briefing     │     │ 3 strategic  │     │          │
│ 4-letter │     │              │     │ changes max  │     │ Final    │
│ code     │     │ Director     │     │              │     │ score    │
│          │     │ clicks Start │     │ Orders every │     │          │
└──────────┘     └──────────────┘     │ 60 seconds   │     └──────────┘
                                      └──────────────┘
```

### Classroom Setup (Recommended)

1. **Form teams** of 4-6 students
2. **One student** opens the app and creates a room as **Director** (ideally on a projected screen)
3. **Other students** join on their phones/laptops using the room code
4. **5 minutes** for strategy discussion during staging
5. **10 minutes** of live simulation
6. **15 minutes** for debrief discussion using the post-game analytics

**Solo Mode:** The Director can add bot operators to run stages automatically — useful for demos or individual study.

---

## Deployment

### Google Cloud Run (Recommended)

```bash
# Build and push container
docker build -t gcr.io/YOUR_PROJECT/lego-factory .
docker push gcr.io/YOUR_PROJECT/lego-factory

# Deploy to Cloud Run
gcloud run deploy lego-factory \
  --image gcr.io/YOUR_PROJECT/lego-factory \
  --port 8080 \
  --allow-unauthenticated \
  --session-affinity
```

> **Note:** `--session-affinity` ensures WebSocket connections from the same client hit the same container instance.

### Docker (Local or Any Host)

```bash
docker build -t lego-factory .
docker run -p 8080:8080 lego-factory
```

Open `http://localhost:8080` in your browser.

---

## Local Development

```bash
# Install dependencies
npm install

# Terminal 1 — WebSocket server
node server.js

# Terminal 2 — Vite dev server (hot reload)
npm run dev
```

- Vite runs on `http://localhost:5173` with WebSocket proxy to `localhost:8080`
- Server handles both static files and WebSocket in production on port 8080

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Single Container (Cloud Run)             │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                   server.js (Node.js)                   │  │
│  │                                                         │  │
│  │  Express ──── Static files (dist/)                      │  │
│  │      │                                                  │  │
│  │  WebSocket ── Room management                           │  │
│  │      │        ├── Director broadcasts state             │  │
│  │      │        ├── Operators send actions                │  │
│  │      │        ├── Server relays (no game logic)         │  │
│  │      │        └── Heartbeat + auto-cleanup              │  │
│  │      │                                                  │  │
│  │  Port 8080 ── HTTP + WebSocket upgrade                  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                  React SPA (dist/)                      │  │
│  │                                                         │  │
│  │  useReducer ── All game state (single source of truth)  │  │
│  │  WebSocket ─── Sync between Director and Operators      │  │
│  │  Tailwind ──── Dark theme, responsive UI                │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Tailwind CSS v4, Vite 7 |
| Backend | Node.js, Express 4, ws (WebSocket) |
| State | useReducer (client-side, Director is source of truth) |
| Sync | WebSocket relay — server has no game logic |
| Deploy | Docker, Google Cloud Run |

### Sync Model

The **Director** is the single source of truth. The server is a stateless relay:

```
Director                    Server                     Operator
   │                          │                           │
   │── state_update ─────────►│── broadcast ────────────►│
   │                          │                           │
   │◄── action (relay) ───────│◄── action ────────────────│
   │                          │                           │
   │  [dispatches action      │  [just forwards           │  [optimistic local
   │   to local reducer]      │   messages between        │   dispatch + sends
   │                          │   room members]           │   action to server]
```

---

## License

MIT

---

*Built for operations management education. Designed to make supply chain concepts tangible, competitive, and fun.*
