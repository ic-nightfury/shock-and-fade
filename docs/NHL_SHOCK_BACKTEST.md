# NHL Shock-Fade Backtest v2

A data-driven backtest for the **shock-fade strategy** on Polymarket sports moneylines. Records live orderbook data, play-by-play events from free league APIs, and fair-value baselines — then backtests fade trades using a surprise classifier to filter for high-probability setups.

## Architecture

```
┌────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│  Polymarket WS     │────▶│  NhlShockRecorder    │────▶│   SQLite DB          │
│  (orderbook/trades)│     │                      │     │   ├─ markets          │
└────────────────────┘     │  Records:            │     │   ├─ snapshots        │
                           │  • Best bid/ask      │     │   ├─ trades           │
┌────────────────────┐     │  • Top 5 depth levels│     │   ├─ depth_snapshots  │
│  Free League APIs  │────▶│  • Fair values       │     │   ├─ fair_values      │
│  (NHL/NBA/MLB PBP) │     │  • Game events       │     │   └─ game_events      │
└────────────────────┘     └──────────────────────┘     └──────────┬───────────┘
                                                                   │
┌────────────────────┐     ┌──────────────────────┐                │
│  ESPN Fallback     │────▶│  NhlShockBacktest     │◀───────────────┘
│  (scores only)     │     │                      │
└────────────────────┘     │  Uses:               │
                           │  • SurpriseClassifier │
                           │  • Fair-value based   │
                           │    ladder placement   │
                           │  • Depth-aware fills  │
                           │  • Detailed P&L stats │
                           └──────────────────────┘
```

### Data Source Hierarchy

The recorder uses a tiered approach to game-event data:

| Priority | Source | Cost | Latency | Data |
|----------|--------|------|---------|------|
| **1 (default)** | Free league APIs | $0/mo | 10-30s polling | Full PBP, goals, penalties |
| **2 (fallback)** | ESPN hidden API | $0/mo | 30-60s polling | Scores + status only |
| **3 (optional)** | Sportradar | $500+/mo | Sub-second push | Full PBP (enterprise) |

**Free League API endpoints (no auth, no keys):**

| League | Base URL | Schedule | Play-by-Play |
|--------|----------|----------|-------------|
| NHL | `api-web.nhle.com` | `/v1/schedule/{date}` | `/v1/gamecenter/{id}/play-by-play` |
| NBA | `cdn.nba.com/static/json/liveData` | `scoreboard/todaysScoreboard_00.json` | `playbyplay/playbyplay_{id}.json` |
| MLB | `statsapi.mlb.com/api/v1` | `/schedule?date={date}&sportId=1` | `/api/v1.1/game/{id}/feed/live` |
| ESPN | `site.api.espn.com` | N/A | `/apis/site/v2/sports/{sport}/{league}/scoreboard` |

> ⚠️ These are unofficial/undocumented but widely used by thousands of developers. They've been stable for years. If one fails, the recorder gracefully falls back to ESPN and continues recording orderbook data.

### Sportradar (Optional)

Sportradar is **completely optional**. To force it over free APIs:

```bash
USE_SPORTRADAR=true SPORTRADAR_NHL_API_KEY=your_key npm run nhl:record
```

This is only needed if you require sub-second push data or the free APIs become unreliable.

## Quick Start

### 1. Record live data

```bash
# Default — uses free league APIs ($0/mo, no keys needed)
npm run nhl:record

# Force Sportradar (optional, requires paid key)
USE_SPORTRADAR=true SPORTRADAR_NHL_API_KEY=your_key npm run nhl:record
```

The recorder captures:
- **Best bid/ask snapshots** — 1/sec per token
- **Orderbook depth** — top 5 bid/ask levels per snapshot
- **Fair values** — first price seen for each token (pre-game baseline)
- **Game events** — goals, penalties, period changes from league APIs
- **Trades** — individual fills from the WebSocket feed

### 2. Run backtest

```bash
npm run nhl:backtest
```

## Configuration

### Recorder (env vars)

| Variable | Default | Description |
|---|---|---|
| `NHL_SHOCK_DB` | `./data/nhl_shock.db` | SQLite database path |
| `NHL_SHOCK_THROTTLE_MS` | `1000` | Min ms between snapshots per token |
| `NHL_SHOCK_DISCOVERY_MS` | `60000` | Market discovery poll interval |
| `NHL_SHOCK_ALERT_FILE` | `./data/live_market_alerts.jsonl` | JSONL alert log path |
| `SPORTRADAR_POLL_MS` | `10000` | Play-by-play poll interval (min 2000ms) |
| **`USE_SPORTRADAR`** | `false` | Set to `true` to use Sportradar instead of free APIs |
| `SPORTRADAR_NHL_API_KEY` | _(empty)_ | Sportradar API key — **only used if USE_SPORTRADAR=true** |
| `SPORTRADAR_NHL_ACCESS_LEVEL` | `trial` | Sportradar access level |

### Backtest (env vars)

| Variable | Default | Description |
|---|---|---|
| `NHL_SHOCK_DB` | `./data/nhl_shock.db` | SQLite database path |
| `NHL_SHOCK_SIGMA` | `3` | Sigma threshold for shock detection |
| `NHL_SHOCK_WINDOW` | `60` | Rolling volatility window (seconds) |
| `NHL_SHOCK_LADDER_LEVELS` | `3` | Number of ladder levels on impulse side |
| `NHL_SHOCK_LADDER_STEP_PCT` | `0.5` | Fraction of price deviation to spread across ladder |
| `NHL_SHOCK_LADDER_WINDOW` | `3` | Max seconds to fill ladder |
| `NHL_SHOCK_FADE_WINDOW` | `15` | Max seconds to fill hedge/fade |
| `NHL_SHOCK_TARGET_PAIR` | `1.02` | Target sell1 + sell2 sum for profit |
| `NHL_SHOCK_TRADE_SIZE` | `10` | Shares per trade |
| `NHL_SHOCK_SURPRISE_THRESHOLD` | `0.4` | Min surprise score (0-1) to trigger trade |
| `NHL_SHOCK_GAME_SECS` | `3600` | Total regulation seconds (NHL=3600, NBA=2880) |

## Key Concepts

### Fair Value Baseline

When a market is first discovered, the recorder stores the initial bid/ask as the **fair value** — the market's pre-game assessment. This replaces the v1 rolling-window approach. Benefits:

- More stable reference point (doesn't drift with in-game moves)
- Ladder levels placed relative to deviation from fair value
- Allows classifying moves as "surprising" vs "expected"

### Surprise Classifier

Not all shocks are equal. The `SurpriseClassifier` scores each shock 0-1 based on:

| Factor | Weight | Logic |
|---|---|---|
| **Price deviation** | 30% | How far did price move from fair value? |
| **Underdog factor** | 25% | Did the underdog score? (higher fair value = bigger favorite) |
| **Game time** | 25% | Late-game events are more surprising (exponential ramp) |
| **Score tightness** | 20% | Tight games produce more overreaction |

Only shocks above the `surpriseThreshold` (default 0.4) trigger trades. This filters out efficient price adjustments and focuses on overreactions.

### Ladder Placement

v2 places the ladder based on **deviation from fair value**, not fixed steps:

```
deviation = |shock_price - fair_mid|
step_size = (deviation × ladderStepPct) / ladderLevels

Level 1: base_price + 1 × step_size
Level 2: base_price + 2 × step_size
Level 3: base_price + 3 × step_size
```

This auto-scales: bigger shocks get wider ladders, small shocks get tighter ones.

### Depth-Aware Fill Simulation

When `depth_snapshots` data is available, the backtest estimates how much liquidity was available at each price level, giving more realistic fill assumptions.

## SQLite Schema

### Tables

```sql
-- Orderbook depth (top 5 levels)
depth_snapshots (ts, market_slug, token_id, level, bid_price, bid_size, ask_price, ask_size)

-- Pre-game fair value baseline
fair_values (market_slug, token_id, fair_bid, fair_ask, captured_at)

-- Game events (from free league APIs or Sportradar)
game_events (ts, market_slug, sportradar_game_id, event_type, team, period, clock, description)

-- Core tables
markets (market_slug, condition_id, sport, outcome1, outcome2, token1, token2, created_at)
snapshots (ts, market_slug, token_id, best_bid, best_ask)
trades (ts, market_slug, token_id, price, size, side)
```

## Output

The backtest prints:
- **Per-market table** — trades, win rate, PnL, avg win/loss, max drawdown, Sharpe
- **Aggregate stats** — combined across all markets
- **Surprise distribution** — min/avg/max surprise scores
- **Sample trades** — first 10 trades with details

## Graceful Degradation

| Component | Available | Degraded Behavior |
|---|---|---|
| Free league APIs | ✗ | Falls back to ESPN for scores; game events may be incomplete |
| ESPN fallback | ✗ | Game events not recorded; surprise classifier uses time-based estimation |
| Sportradar API | ✗ | N/A (only used if USE_SPORTRADAR=true) |
| `fair_values` table | ✗ | Falls back to first 5 snapshots as fair value estimate |
| `depth_snapshots` table | ✗ | Depth = 0 in results; fill simulation uses price-only |
| `game_events` table | ✗ | Game state estimated from snapshot timestamps only |

## Rate Limiting

All free APIs enforce a **2-second minimum gap** between calls per endpoint. This is polite usage for unofficial APIs that don't require authentication. The Sportradar path uses a 1.2s minimum (their documented limit for trial tier).

## Notes

- Default data source: free league APIs (api-web.nhle.com, cdn.nba.com, statsapi.mlb.com)
- Sportradar is **optional** — set `USE_SPORTRADAR=true` to force it
- ESPN hidden API used as lightweight fallback for live scores
- The recorder filters to **live-only markets** (state=active) for NHL/NBA/MLB
- DB uses WAL mode for concurrent read/write
- Fair values use `INSERT OR IGNORE` — first capture wins, won't be overwritten
- No new npm dependencies — uses Node 22 native `fetch`
