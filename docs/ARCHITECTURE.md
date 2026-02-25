# Architecture

## System Overview

Shock & Fade runs as a distributed system across two servers with four main components: a market recorder, a paper trader, a live trader, and a web dashboard.

```
┌─────────────────────────────────────────────────────┐
│              Germany Server (Hetzner)                │
│                                                     │
│  ┌─────────────────────┐  ┌──────────────────────┐  │
│  │  polymarket-recorder │  │ shock-fade-paper     │  │
│  │  (systemd service)   │  │ (systemd service)    │  │
│  │                      │  │                      │  │
│  │  Records tick data + │  │  Paper trades on     │  │
│  │  play-by-play for    │  │  live market data    │  │
│  │  all sports to       │  │  with simulated      │  │
│  │  SQLite              │  │  fills               │  │
│  └──────────┬───────────┘  └──────────────────────┘  │
│             │                                        │
│             ▼                                        │
│  ┌──────────────────────┐                            │
│  │  data/sports_ticks.db │  ◄── SQLite database     │
│  │  (tick + event data)  │                           │
│  └───────────────────────┘                           │
│                                                      │
│  ┌──────────────────────┐                            │
│  │  OpenClaw Agent       │  ◄── Monitoring & ops     │
│  └──────────────────────┘                           │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│              Production Server                          │
│                                                     │
│  ┌──────────────────────┐                            │
│  │  shock-fade-live      │  ◄── Real money trading  │
│  │  (systemd service)    │                           │
│  │                       │                           │
│  │  DirectExecution for  │                           │
│  │  on-chain ops, CLOB   │                           │
│  │  API for orders       │                           │
│  └───────────────────────┘                           │
└─────────────────────────────────────────────────────┘
```

---

## Data Flow

### Market Discovery

```
Gamma API (gamma-api.polymarket.com)
        │
        ▼
SportsMarketDiscovery
  - Polls /markets every 5 minutes
  - Filters: sports tags, active games, sufficient volume
  - Extracts: conditionId, tokenIds, negRisk flag, sport type
        │
        ▼
  Active market list → subscribed via OrderBookWS
```

### Recording Pipeline

```
Polymarket WebSocket ──► OrderBookWS ──► Tick snapshots ──► SQLite
                                              │
Free League APIs ──► Event poller ──► Play-by-play ──► SQLite
  (NBA CDN, ESPN,                     events
   NHL API, etc.)
```

The recorder (`NhlShockRecorder`, despite the name, handles all sports) captures:
- **Tick data:** Best bid, best ask, mid-price, spread — every price update
- **Order book snapshots:** Full depth at configurable intervals
- **Play-by-play events:** Scoring plays with timestamps from league APIs
- **Market metadata:** Sport, teams, game state, negRisk flag

All stored in a single SQLite database (`data/sports_ticks.db`).

### Trading Pipeline

```
OrderBookWS (real-time prices)
        │
        ▼
ShockFadeDetector
  - Rolling 60s window per token
  - Z-score calculation (mean + stddev)
  - Shock = >2σ AND >3¢ absolute move
  - Cooldown: 30s between shocks per market
        │
        ▼ (shock detected)
        │
Free League API (burst poll)
  - Poll at 1s intervals for 10s
  - Classify: single_event / scoring_run / unclassified
        │
        ▼ (single_event confirmed)
        │
ShockFadeLive / ShockFadePaper
  - Check inventory (pre-split shares available?)
  - Check concurrency (game slot available?)
  - Place laddered sell orders on spiked token
  - Entry fills tracked via UserChannelWS (WSS)
  - TP fills tracked via WSS (matching tp.tpOrderId)
  - wsHandledOrderIds dedup guard prevents MATCHED→MINED→CONFIRMED triple-processing
  - Monitor for exit conditions:
    • Next scoring event → GTC sell complement at bid+1tick
    • Take-profit hit → confirmed via UserChannelWS fill events
    • Scoring run → emergency bail
    • Game decided (bid ≤1¢ / ≥99¢) → finalizePositionClose() directly
    • Timeout fallback (600s)
        │
        ▼
UserChannelWS (fill confirmation)
  - Real-time fill/cancel events via wss://ws-subscriptions-clob.polymarket.com/ws/user
  - Primary fill confirmation for TP and exit GTC orders
  - Polling CLOB getOrder() as fallback
        │
        ▼
DirectExecutionClient (on-chain)    CLOB API (off-chain)
  - Split USDC → CTF tokens          - Place GTC sell orders
  - Merge tokens → USDC              - Cancel orders
  - Approvals                        - GTC at bid+1tick for exits (avoids 3s delay)
                                     - FAK at 1¢ floor as final fallback
```

---

## Key Services

### Core Strategy

| Service | File | Purpose |
|---------|------|---------|
| `ShockFadeDetector` | `src/strategies/ShockFadeDetector.ts` | Rolling z-score shock detection on mid-price stream. Emits `ShockEvent` with magnitude, z-score, direction. |
| `ShockFadeLive` | `src/strategies/ShockFadeLive.ts` | Live trading engine. Manages inventory (pre-split tokens), places real orders, handles exits. Full cycle management with cumulative TP. |
| `ShockFadePaper` | `src/strategies/ShockFadePaper.ts` | Paper trading engine. Same logic as live but simulates fills using order book data. Tracks P&L, win rate, positions. |

### Market Infrastructure

| Service | File | Purpose |
|---------|------|---------|
| `SportsMarketDiscovery` | `src/services/SportsMarketDiscovery.ts` | Discovers active sports moneyline markets from Gamma API. Manages market lifecycle (upcoming → active → settled). |
| `OrderBookWS` | `src/services/OrderBookWS.ts` | WebSocket connection to Polymarket. Receives real-time bid/ask/trade events per token. Supports multi-token subscriptions. |
| `SportsPriceMonitor` | `src/services/SportsPriceMonitor.ts` | Higher-level price tracking. Manages OrderBookWS subscriptions across discovered markets. |
| `UserChannelWS` | `src/services/UserChannelWS.ts` | Real-time fill/cancel detection via `wss://ws-subscriptions-clob.polymarket.com/ws/user`. Primary fill confirmation for TP and exit orders; polling as fallback. |

### On-Chain Execution

| Service | File | Purpose |
|---------|------|---------|
| `DirectExecutionClient` | `src/services/DirectExecutionClient.ts` | Bypasses Builder Relayer. Calls Gnosis Safe `execTransaction()` directly on Polygon. Unlimited transactions at ~$0.05/cycle. |
| `SplitClient` | `src/services/SplitClient.ts` | Splits USDC into CTF token pairs (both outcomes). Supports both EOA and PROXY modes, both regular CTF and NegRisk adapter. |
| `MergeClient` | `src/services/MergeClient.ts` | Merges complementary CTF tokens back into USDC. Handles approvals, supports both regular and NegRisk. |
| `PolymarketClient` | `src/services/PolymarketClient.ts` | Places sell orders on the CLOB. `sellSharesGTC()` for limit orders, `sellShares()` for market sells (FAK). Handles order signing. |
| `WalletBalanceService` | `src/services/WalletBalanceService.ts` | Tracks USDC and CTF token balances across the proxy wallet. Used for inventory management and dashboard display. |

### Data Collection

| Service | File | Purpose |
|---------|------|---------|
| `NhlShockRecorder` | `src/collectors/nhl/NhlShockRecorder.ts` | Despite the name, records data for ALL sports. Captures tick data + play-by-play events to SQLite. Runs as `polymarket-recorder` systemd service. |
| `NbaLiveApi` | `src/collectors/league-apis/NbaLiveApi.ts` | NBA play-by-play from `cdn.nba.com`. Free, no API key. |
| `NhlLiveApi` | `src/collectors/league-apis/NhlLiveApi.ts` | NHL play-by-play from `api-web.nhle.com`. Free, no API key. |
| `NflLiveApi` | `src/collectors/league-apis/NflLiveApi.ts` | NFL play-by-play from ESPN. Free, no API key. |
| `MlbLiveApi` | `src/collectors/league-apis/MlbLiveApi.ts` | MLB play-by-play from `statsapi.mlb.com`. Free, no API key. |
| `EspnFallbackApi` | `src/collectors/league-apis/EspnFallbackApi.ts` | ESPN as fallback for CBB, soccer, and any sport where the primary API fails. |

### Dashboard & Monitoring

| Service | File | Purpose |
|---------|------|---------|
| `ShockFadeDashboard` | `src/dashboard/ShockFadeDashboard.ts` | WebSocket-based dashboard server (port 3032). Serves the single-file HTML UI. |
| `LiveDashboardAdapter` | `src/dashboard/LiveDashboardAdapter.ts` | Adapts ShockFadeLive state → dashboard data format. |
| `PaperDashboardAdapter` | `src/dashboard/PaperDashboardAdapter.ts` | Adapts ShockFadePaper state → dashboard data format. |
| `shock-fade-ui.html` | `src/dashboard/shock-fade-ui.html` | Single HTML file with embedded CSS/JS. Real-time display of active markets, positions, P&L, order book. |

### Other Services

| Service | File | Purpose |
|---------|------|---------|
| `CycleTracker` | `src/services/CycleTracker.ts` | Tracks trading cycle state (active positions, filled orders, P&L per cycle). |
| `PnlTracker` | `src/services/PnlTracker.ts` | Aggregates P&L across all positions and cycles. |
| `RateLimiter` | `src/services/RateLimiter.ts` | Rate limiting for API calls (Gamma, CLOB, league APIs). |
| `ApprovalService` | `src/services/ApprovalService.ts` | Manages on-chain ERC20/CTF approvals. Caches approval state to avoid redundant transactions. |
| `Database` | `src/services/Database.ts` | SQLite database wrapper for tick/event storage. |

---

## Entry Points

| Script | Command | Purpose |
|--------|---------|---------|
| `src/run-shock-fade-live.ts` | `npm run shock-fade:live` | Live trading with real money |
| `src/run-shock-fade-paper.ts` | `npm run shock-fade:paper` | Paper trading with simulated fills |
| `src/run-nhl-shock-recorder.ts` | `npm run nhl:record` | Record tick + event data for all sports |
| `src/run-nhl-shock-backtest.ts` | `npm run nhl:backtest` | Run backtest on recorded data |
| `src/analysis/shock-fade-analysis.ts` | `npm run analyze` | Analyze backtest results |
| `src/analysis/parameter-matrix.ts` | `npm run analyze:matrix` | Parameter sweep optimization |
| `src/analysis/nba-matrix-v2.ts` | `npm run analyze:nba-v2` | NBA-specific parameter matrix v2 |
| `src/analysis/nba-matrix-v3.ts` | `npm run analyze:nba-v3` | NBA-specific parameter matrix v3 |

---

## Systemd Services

### polymarket-recorder.service

Runs on the **Germany server**. Records tick data and play-by-play for all active sports markets.

```ini
[Service]
WorkingDirectory=/root/.openclaw/workspace/polymarket_arbitrage
ExecStart=/usr/bin/npx ts-node src/run-nhl-shock-recorder.ts
Restart=always
RestartSec=10
MemoryMax=512M
```

### shock-fade-paper.service

Runs on the **Germany server**. Paper trades on live data for strategy validation.

```ini
[Service]
WorkingDirectory=/root/.openclaw/workspace/polymarket_arbitrage
ExecStart=/usr/bin/npm exec ts-node src/run-shock-fade-paper.ts
Restart=on-failure
RestartSec=10
MemoryMax=512M
```

### shock-fade-live.service

Runs on the **production server** (`/root/shock-and-fade/`). Live trading with real money. Defaults to dry-run mode.

**Deployment:** Deploy via rsync (no git SSH key on production server):
```bash
rsync -avz --exclude node_modules --exclude data --exclude .git . root@YOUR_SERVER_IP:/root/shock-and-fade/
ssh root@YOUR_SERVER_IP "systemctl restart shock-fade-live"
# Or for config-only changes:
ssh root@YOUR_SERVER_IP "systemctl reload shock-fade-live"
```

**Dashboard:** Available on port **3033** on the production server.

```ini
[Service]
WorkingDirectory=/root/shock-and-fade
ExecStart=/usr/bin/node --require ./node_modules/tsconfig-paths/register --import ./node_modules/tsx/dist/esm/index.mjs src/run-shock-fade-live.ts
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=30
MemoryMax=512M
```

**SIGHUP Hot-Reload:**
- The service runs `node` directly (not via `npx`) so that SIGHUP reaches the correct process
- `systemctl reload shock-fade-live` or `kill -HUP <pid>` sends SIGHUP
- On SIGHUP: re-reads `.env`, applies updated config to strategy + detector
- **Only affects new shocks/cycles** — existing open positions keep their original config

---

## Dashboard

The dashboard is a single HTML file (`src/dashboard/shock-fade-ui.html`) served by `ShockFadeDashboard` on port 3032. It connects via WebSocket and displays:

- **Active markets:** Currently monitored games with live prices
- **Recent shocks:** Detected price shocks with classification
- **Open positions:** Active fade positions with entry/exit details
- **P&L summary:** Running totals, win rate, per-position breakdown
- **Order book:** Live bid/ask for selected markets
- **Trade history:** Completed cycles with outcomes

Both the paper trader and live trader serve the same dashboard UI, with adapters (`LiveDashboardAdapter` / `PaperDashboardAdapter`) that bridge their internal state to the dashboard's expected data format.

---

## Directory Structure

```
src/
├── strategies/
│   ├── ShockFadeDetector.ts       # Shock detection engine
│   ├── ShockFadeLive.ts           # Live trading engine
│   └── ShockFadePaper.ts          # Paper trading engine
├── services/
│   ├── DirectExecutionClient.ts   # Bypass Builder Relayer
│   ├── SplitClient.ts             # USDC → CTF splitting
│   ├── MergeClient.ts             # CTF → USDC merging
│   ├── PolymarketClient.ts        # CLOB order execution
│   ├── OrderBookWS.ts             # Real-time price WebSocket
│   ├── SportsMarketDiscovery.ts   # Market discovery
│   ├── SportsPriceMonitor.ts      # Multi-market price tracking
│   ├── UserChannelWS.ts           # Real-time fill/cancel via user WS
│   ├── WalletBalanceService.ts    # Balance tracking
│   ├── ApprovalService.ts         # On-chain approval management
│   ├── CycleTracker.ts            # Trading cycle state
│   ├── PnlTracker.ts              # P&L aggregation
│   ├── RateLimiter.ts             # API rate limiting
│   ├── Database.ts                # SQLite wrapper
│   └── ...                        # Other supporting services
├── collectors/
│   ├── nhl/NhlShockRecorder.ts    # Multi-sport recorder
│   ├── league-apis/               # Free league API clients
│   │   ├── NbaLiveApi.ts
│   │   ├── NhlLiveApi.ts
│   │   ├── NflLiveApi.ts
│   │   ├── MlbLiveApi.ts
│   │   └── EspnFallbackApi.ts
│   └── SportsTickCollector.ts     # Tick collection infrastructure
├── dashboard/
│   ├── ShockFadeDashboard.ts      # Dashboard WebSocket server
│   ├── LiveDashboardAdapter.ts    # Live trader → dashboard bridge
│   ├── PaperDashboardAdapter.ts   # Paper trader → dashboard bridge
│   └── shock-fade-ui.html         # Single-file HTML dashboard
├── analysis/                      # Backtest analysis scripts
├── backtest/                      # Backtest engine
├── tools/                         # Utility scripts (merge-all, check-balances, etc.)
├── cli/                           # CLI commands (aum, status, merge, sell, etc.)
├── config/                        # Runtime & sport-specific parameters
├── run-shock-fade-live.ts         # Live trader entry point
├── run-shock-fade-paper.ts        # Paper trader entry point
└── run-nhl-shock-recorder.ts      # Recorder entry point

docs/
├── STRATEGY.md                    # Strategy documentation (this companion doc)
├── ARCHITECTURE.md                # This file
├── DIRECT_EXECUTION.md            # DirectExecutionClient technical docs
├── RATE_LIMITS.md                 # Polymarket API rate limit reference
├── NHL_SHOCK_BACKTEST.md          # Backtest methodology & results
├── PITFALLS.md                    # Known pitfalls & gotchas from live trading
├── DASHBOARD_UX.md                # Dashboard UX specification
└── archive/                       # Legacy strategy documentation

data/
└── sports_ticks.db                # SQLite database (tick + event data)
```
