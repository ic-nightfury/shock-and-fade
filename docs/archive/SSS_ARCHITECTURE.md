# SSS Strategy Architecture

Technical architecture and component overview for the Sports Split-Sell strategy.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Component Diagram](#2-component-diagram)
3. [Data Flow](#3-data-flow)
4. [Core Components](#4-core-components)
5. [File Structure](#5-file-structure)
6. [Configuration Files](#6-configuration-files)
7. [External Dependencies](#7-external-dependencies)

---

## 1. System Overview

The SSS strategy is built as a modular TypeScript application with the following layers:

```
┌─────────────────────────────────────────────────────────────┐
│                     Entry Points                             │
│  run-sports-split-sell.ts    run-sports-split-sell-paper.ts │
└─────────────────────────────┬───────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│                    Strategy Layer                            │
│          SportsSplitSell.ts / SportsSplitSell_Paper.ts      │
└─────────────────────────────┬───────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│                    Service Layer                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Market    │  │    Price    │  │     Position        │  │
│  │  Discovery  │  │   Monitor   │  │     Manager         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────┬───────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│                   Client Layer                               │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐ │
│  │  Split   │  │   Merge   │  │ Polymarket│  │ OrderBook │ │
│  │  Client  │  │   Client  │  │   Client  │  │    WS     │ │
│  └──────────┘  └───────────┘  └───────────┘  └───────────┘ │
└─────────────────────────────┬───────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│                   External APIs                              │
│  Gamma API    CLOB API    WebSocket    Builder Relayer      │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Component Diagram

```
                          ┌───────────────────────────────────────────┐
                          │           ENTRY POINTS                     │
                          │                                            │
                          │  run-sports-split-sell.ts (Live)          │
                          │  run-sports-split-sell-paper.ts (Paper)   │
                          └───────────────┬───────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              STRATEGY LAYER                                  │
│                                                                              │
│  ┌─────────────────────────┐      ┌────────────────────────────────────┐   │
│  │   SportsSplitSell.ts    │      │   SportsSplitSell_Paper.ts          │   │
│  │   (Live Strategy)       │      │   (Paper Strategy)                  │   │
│  │                         │      │                                      │   │
│  │  • Entry logic          │      │  • Wraps PaperTradingEngine         │   │
│  │  • Sell logic           │      │  • Uses real prices, simulated fills│   │
│  │  • Settlement logic     │      │  • Slippage simulation              │   │
│  │  • MERGE fallback       │      │                                      │   │
│  │  • Alerting             │      │                                      │   │
│  │  • Scaling              │      │                                      │   │
│  └────────────┬────────────┘      └──────────────────┬─────────────────┘   │
│               │                                       │                      │
└───────────────┼───────────────────────────────────────┼──────────────────────┘
                │                                       │
                ▼                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SERVICE LAYER                                   │
│                                                                              │
│  ┌────────────────────────┐  ┌─────────────────────┐  ┌──────────────────┐ │
│  │  SportsMarketDiscovery │  │  SportsPriceMonitor │  │SportsPositionMgr │ │
│  │                        │  │                     │  │                  │ │
│  │  • Poll Gamma API      │  │  • WebSocket prices │  │  • Track state   │ │
│  │  • Filter by sport     │  │  • Sell triggers    │  │  • P&L calc      │ │
│  │  • Track market state  │  │  • Sport thresholds │  │  • Persistence   │ │
│  │  • Emit events         │  │  • Emit events      │  │  • 50 positions  │ │
│  └────────────┬───────────┘  └──────────┬──────────┘  └────────┬─────────┘ │
│               │                         │                      │            │
└───────────────┼─────────────────────────┼──────────────────────┼────────────┘
                │                         │                      │
                ▼                         ▼                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                    │
│                                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  ┌────────────────┐ │
│  │  SplitClient │  │  MergeClient │  │PolymarketClient│ │ OrderBookWS    │ │
│  │              │  │              │  │               │  │                │ │
│  │  SPLIT via   │  │  MERGE via   │  │  CLOB orders  │  │  Real-time     │ │
│  │  Builder API │  │  Builder API │  │  (sell)       │  │  prices        │ │
│  └──────────────┘  └──────────────┘  └───────────────┘  └────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                │                         │                      │
                ▼                         ▼                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EXTERNAL APIS                                      │
│                                                                              │
│  Gamma API          CLOB API           WebSocket           Builder Relayer  │
│  (market data)      (orders, prices)   (real-time)         (SPLIT/MERGE)    │
│                                                                              │
│  /events            /orders            ws://...            /split           │
│  /markets           /orderbook                             /merge           │
│                     /prices-history                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Flow

### Entry Flow

```
                    ┌─────────────┐
                    │   Gamma     │
                    │    API      │
                    └──────┬──────┘
                           │ Poll every 5 min
                           ▼
                    ┌─────────────┐
                    │   Market    │
                    │  Discovery  │
                    └──────┬──────┘
                           │ newMarket event
                           ▼
                    ┌─────────────┐
                    │  Strategy   │
                    │  Entry      │
                    │  Logic      │
                    └──────┬──────┘
                           │ meetsEntryCriteria?
                           ▼
         ┌─────────────────┴─────────────────┐
         │                                   │
         ▼ YES                               ▼ NO
┌─────────────────┐                  ┌─────────────────┐
│   SplitClient   │                  │    Skip         │
│    SPLIT        │                  │    Market       │
└────────┬────────┘                  └─────────────────┘
         │ Success
         ▼
┌─────────────────┐
│   Position      │
│   Manager       │
│ (openPosition)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Price         │
│   Monitor       │
│ (addMarket)     │
└─────────────────┘
```

### Sell Flow

```
┌─────────────────┐
│   WebSocket     │
│   Price Feed    │
└────────┬────────┘
         │ priceUpdate
         ▼
┌─────────────────┐
│   Price         │
│   Monitor       │
│   (check        │
│   threshold)    │
└────────┬────────┘
         │ sellTrigger event (BID < threshold)
         ▼
┌─────────────────┐
│   Strategy      │
│   Sell Logic    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Polymarket     │
│  Client         │
│  (MARKET sell)  │
└────────┬────────┘
         │ Fill confirmation
         ▼
┌─────────────────┐
│   Position      │
│   Manager       │
│ (recordSale)    │
└─────────────────┘
```

### Settlement Flow

```
┌─────────────────┐
│   Settlement    │
│   Check Timer   │
│  (every 1 hour) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Gamma API     │
│   /markets      │
│ (check resolved)│
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│             Market Resolved?                 │
├────────────────┬────────────────────────────┤
│     YES        │          NO                │
│                │                            │
│     ▼          │          ▼                 │
│ ┌──────────┐   │    ┌──────────┐           │
│ │ Redeem   │   │    │ Check    │           │
│ │ Winner   │   │    │ Age > 6h │           │
│ └────┬─────┘   │    └────┬─────┘           │
│      │         │         │                  │
│      ▼         │         ▼                  │
│ ┌──────────┐   │    ┌──────────┐           │
│ │ Position │   │    │ MERGE    │           │
│ │ Settled  │   │    │ Recovery │           │
│ └──────────┘   │    └──────────┘           │
└────────────────┴────────────────────────────┘
```

### Game End Detection Flow

The game end detection mechanism uses a 99c+ price threshold to identify when games have ended:

```
┌─────────────────┐
│   WebSocket     │
│   Price Feed    │
└────────┬────────┘
         │ priceUpdate
         ▼
┌─────────────────┐
│   Price         │
│   Monitor       │
│   Check:        │
│   BID >= 99c?   │
└────────┬────────┘
         │ YES - potential game end
         ▼
┌─────────────────┐
│ fetchFreshPrice │
│  (CLOB API)     │
│                 │
│ Confirm 99c+    │
│ (avoid stale    │
│  WebSocket data)│
└────────┬────────┘
         │ Confirmed 99c+
         ▼
┌─────────────────┐
│   Strategy      │
│   Game End      │
│   Handler       │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│         Check Position State                 │
├────────────────┬────────────────────────────┤
│  HOLDING       │      PARTIAL_SOLD          │
│  (both sides)  │      (loser sold)          │
│                │                            │
│     ▼          │          ▼                 │
│ ┌──────────┐   │    ┌──────────────────┐   │
│ │  MERGE   │   │    │ markPending-     │   │
│ │ both     │   │    │ Settlement()     │   │
│ │ sides    │   │    └────────┬─────────┘   │
│ └────┬─────┘   │             │              │
│      │         │             ▼              │
│      ▼         │    ┌──────────────────┐   │
│ ┌──────────┐   │    │ PENDING_         │   │
│ │ SETTLED  │   │    │ SETTLEMENT       │   │
│ │ ($10     │   │    │                  │   │
│ │ recovered)│  │    │ (await redeem)   │   │
│ └──────────┘   │    └──────────────────┘   │
└────────────────┴────────────────────────────┘
```

### GameEndedEvent Interface

When game end is detected, the following event is emitted:

```typescript
interface GameEndedEvent {
  marketSlug: string;
  sport: string;
  winningOutcome: string;       // "outcome1" or "outcome2"
  winningOutcomeName: string;   // e.g., "Seattle" or "YES"
  winnerPrice: number;          // The 99c+ price that triggered detection
  loserPrice: number;           // The ~1c price of losing side
  positionState: string;        // "holding" or "partial_sold"
  hasUnsoldLoser: boolean;      // True if loser side wasn't sold
  timestamp: Date;
}
```

**Event listeners can subscribe to:**
- `gameEnded` - Emitted when 99c+ threshold detected and confirmed
- `pendingSettlement` - Emitted after position transitions to PENDING_SETTLEMENT
- `merged` - Emitted when MERGE operation completes for HOLDING positions

### Upcoming Games Data Flow

```
┌─────────────────┐
│   Dashboard     │
│   (Browser)     │
│   Dropdown:     │
│   6h/12h/24h/48h│
└────────┬────────┘
         │ GET /api/upcoming-games?hours=24
         ▼
┌─────────────────┐
│ Dashboard       │
│ Server          │
│ (HTTP Handler)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Dashboard       │
│ Adapter         │
│ getUpcomingGames│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Market        │
│   Discovery     │
│   getMarkets()  │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│          Filter & Transform                  │
├─────────────────────────────────────────────┤
│ 1. Filter by time horizon                   │
│ 2. Exclude closed/settled markets           │
│ 3. Calculate status (scheduled/entry/live)  │
│ 4. Check hasPosition                        │
│ 5. Sort by gameStartTime ascending          │
└────────┬────────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│   Response:     │
│   { games: [...}│
│   DashboardUp-  │
│   comingGame[]  │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│              Browser Rendering               │
├─────────────────────────────────────────────┤
│ 1. Render game rows with sport badges       │
│ 2. Start 1-second timer interval            │
│ 3. updateTimers() calculates time remaining │
│ 4. calculateStatus() updates badges         │
│ 5. Auto-refresh data every 5 minutes        │
└─────────────────────────────────────────────┘
```

### Force Entry Flow (Paper Trading Only)

```
┌─────────────────┐
│   Dashboard     │
│   "Split" btn   │
└────────┬────────┘
         │ Click
         ▼
┌─────────────────┐
│   Modal         │
│   Confirmation  │
│   + Bet Size    │
└────────┬────────┘
         │ Confirm
         ▼
┌─────────────────┐        ┌─────────────────┐
│ POST /api/      │───────▶│ Check mode      │
│ force-entry     │        │ LIVE → 403      │
└────────┬────────┘        └─────────────────┘
         │ PAPER mode
         ▼
┌─────────────────┐
│ Paper           │
│ Dashboard       │
│ Adapter         │
│ forceEntry()    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Paper           │
│ Trading         │
│ Engine          │
│ executeSplit()  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Response:     │
│   { success,    │
│     position }  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Toast         │
│   Notification  │
│   + UI Update   │
└─────────────────┘
```

---

## 4. Core Components

### SportsMarketDiscovery.ts

**Purpose**: Discover and track active sports markets.

| Method | Description |
|--------|-------------|
| `start()` | Begin polling Gamma API |
| `stop()` | Stop polling |
| `getMarkets()` | Get all tracked markets |
| `getMarketsInEntryWindow()` | Get markets within first 10 mins |
| `getMarketsBySport(sport)` | Filter by sport |
| `getStats()` | Discovery statistics |

**Events Emitted**:
- `newMarket` - New market discovered
- `marketStartingSoon` - Market entering entry window
- `marketEnded` - Market closed

**Configuration**: Uses `sss_sport_params.json` for sport filtering.

**Slug Pattern Detection**:

US Sports and Soccer use different slug patterns:

| Pattern Type | Regex | Example |
|--------------|-------|---------|
| US Sports | `^(nba\|nhl\|nfl\|mlb\|cbb\|cfb)-[team]-[team]-YYYY-MM-DD$` | `nhl-sea-ana-2026-02-03` |
| Soccer | `^(epl\|ucl\|lal\|bun\|sea\|fl1\|uel)-[team](-vs)?-[team](-YYYY-MM-DD)?$` | `epl-arsenal-vs-chelsea-2026-02-03` |

**Soccer League Prefixes**:

The `SOCCER_LEAGUE_PREFIXES` constant defines supported soccer leagues:

```typescript
const SOCCER_LEAGUE_PREFIXES = [
  "epl",  // English Premier League
  "ucl",  // UEFA Champions League
  "lal",  // La Liga (Spain)
  "bun",  // Bundesliga (Germany)
  "sea",  // Serie A (Italy)
  "fl1",  // Ligue 1 (France)
  "uel",  // UEFA Europa League
] as const;
```

**3-Way Market Filtering**: Soccer events have 3 markets (Home Win, Draw, Away Win). The discovery service excludes "Draw" markets as they are not supported by SSS. Only "Will [Team] Win?" markets are tracked.

### SportsPriceMonitor.ts

**Purpose**: Monitor real-time prices and detect sell triggers.

| Method | Description |
|--------|-------------|
| `start()` | Connect to WebSocket |
| `addMarket(market)` | Subscribe to market prices |
| `removeMarket(slug)` | Unsubscribe |
| `getMarketPrices(slug)` | Get current prices |
| `resetTriggers(slug)` | Reset trigger state |

**Events Emitted**:
- `priceUpdate` - New price received
- `sellTrigger` - Price dropped below threshold
- `winnerPriceLog` - Winner price drop logged (for analysis)
- `gameEnded` - Game end detected (99c+ threshold)

**Threshold Logic**: Uses sport-specific thresholds from config (NHL: 25c, NFL: 20c, NBA: 15c).

**Fresh Price Validation (`fetchFreshPrice`):**

The `fetchFreshPrice()` method fetches current prices directly from the CLOB API, bypassing potentially stale WebSocket data:

```typescript
// Method signature
public async fetchFreshPrice(
  tokenId: string,
  options?: {
    compareToStored?: boolean;  // Log difference from cached WebSocket price
    updateStored?: boolean;     // Update cached price with fresh data
  }
): Promise<{ bid: number; ask: number } | null>
```

**Why WebSocket data can be stale:**
- Ended games receive fewer price updates (low trading activity)
- WebSocket connections may briefly disconnect
- High-volume periods can delay message delivery

**Rate limiting considerations:**
- CLOB API limit: 9000 requests per 10 seconds
- `fetchFreshPrice` is called conservatively (~10 calls/sec max)
- Used only for critical decisions: game end confirmation, force sell price display

**Usage example:**
```typescript
// Confirm game end before marking position as pending settlement
const freshPrice = await priceMonitor.fetchFreshPrice(winnerTokenId);
if (freshPrice && freshPrice.bid >= 0.99) {
  // Confirmed - safe to mark as pending settlement
  positionManager.markPendingSettlement(marketSlug, winnerOutcome, 'Game ended (99c+)');
}
```

### SportsPositionManager.ts

**Purpose**: Track positions and calculate P&L.

| Method | Description |
|--------|-------------|
| `openPosition(market, cost, shares)` | Create new position |
| `recordSale(slug, outcome, shares, price, revenue)` | Record sale |
| `settlePosition(slug, revenue, reason)` | Close position |
| `markPendingSettlement(slug, winningOutcome, reason)` | Mark position as awaiting settlement (US-818) |
| `getPnLSummary()` | Full P&L breakdown |
| `getOpenPositions()` | Get active positions |
| `getPositionsByState(state)` | Get positions in specific state |

**Position States** (PositionState enum):
- `PENDING_SPLIT` - Waiting for SPLIT to complete
- `HOLDING` - Both sides held
- `PARTIAL_SOLD` - Loser sold, holding winner
- `FULLY_SOLD` - Both sides sold (edge case)
- `PENDING_SETTLEMENT` - Game ended, awaiting redemption (US-818)
- `SETTLED` - Position closed

**State Transitions (US-818):**
```
HOLDING → PENDING_SETTLEMENT (game ended, both sides held, after MERGE)
PARTIAL_SOLD → PENDING_SETTLEMENT (game ended, holding winner)
PENDING_SETTLEMENT → SETTLED (after redemption)
```

**Position Interface Fields (US-818):**
| Field | Type | Description |
|-------|------|-------------|
| `gameEndedAt` | Date \| null | When game end was detected (99c+ price) |
| `winningOutcome` | string \| null | Name of the winning outcome |

**Persistence**: Auto-saves to `data/sss_positions.json` every 30 seconds.

### SportsSplitSell.ts

**Purpose**: Main strategy orchestration.

| Method | Description |
|--------|-------------|
| `start()` | Initialize all services, begin trading |
| `stop()` | Graceful shutdown |
| `executeEntry(market)` | SPLIT and open position |
| `executeSell(trigger)` | Sell loser side |
| `checkSettlements()` | Process settlements |
| `getStats()` | Strategy statistics |

**Events Emitted**:
- `entry` - Position entered
- `entryFailed` - Entry failed
- `sell` - Position sold
- `settlement` - Position settled
- `alert` - Alert triggered (loss, error, reversal)

### PaperTradingEngine.ts

**Purpose**: Simulate order execution for paper trading.

| Method | Description |
|--------|-------------|
| `simulateSplit(market, amount)` | Simulate SPLIT (11s delay) |
| `simulateSell(tokenId, shares, side)` | Simulate MARKET sell with slippage |
| `simulateMerge(market, shares)` | Simulate MERGE |
| `simulateRedemption(market, shares, isWinner)` | Simulate settlement |
| `getPnLSummary()` | Paper P&L |

**Slippage Model**: Walks through order book bids from best to worst, calculating weighted average fill price.

---

## 5. File Structure

```
poly_arbitrage/
├── src/
│   ├── strategies/
│   │   ├── SportsSplitSell.ts          # Live strategy
│   │   └── SportsSplitSell_Paper.ts    # Paper trading wrapper
│   │
│   ├── services/
│   │   ├── SportsMarketDiscovery.ts    # Market discovery
│   │   ├── SportsPriceMonitor.ts       # Price monitoring
│   │   ├── SportsPositionManager.ts    # Position tracking
│   │   ├── SplitClient.ts              # SPLIT operations
│   │   ├── MergeClient.ts              # MERGE operations
│   │   ├── PolymarketClient.ts         # CLOB API client
│   │   └── OrderBookWebSocket.ts       # WebSocket client
│   │
│   ├── simulation/
│   │   └── PaperTradingEngine.ts       # Paper trading simulation
│   │
│   ├── dashboard/
│   │   ├── SportsDashboardServer.ts    # HTTP/WS dashboard server
│   │   ├── LiveDashboardAdapter.ts     # Live data adapter
│   │   └── PaperDashboardAdapter.ts    # Paper data adapter
│   │
│   ├── collectors/
│   │   └── SportsTickCollector.ts      # Tick data collection
│   │
│   ├── config/
│   │   ├── sss_sport_params.json       # Sport-specific parameters
│   │   └── sss_runtime_params.json     # Runtime configuration
│   │
│   ├── run-sports-split-sell.ts        # Live entry point
│   └── run-sports-split-sell-paper.ts  # Paper entry point
│
├── analysis/
│   ├── sss_research_summary.md         # Research consolidation
│   ├── sss_final_parameters.md         # Production config docs
│   ├── sss_optimal_params.json         # Historical analysis data
│   └── sss_performance_analyzer.py     # P&L analysis script
│
├── docs/
│   ├── SSS_STRATEGY.md                 # Strategy overview
│   ├── SSS_QUICKSTART.md               # Getting started guide
│   ├── SSS_ARCHITECTURE.md             # This document
│   └── SSS_LESSONS_LEARNED.md          # Operational insights
│
├── scripts/
│   ├── systemd/
│   │   └── polymarket-sports-sss.service  # systemd service
│   └── deploy-sports-sss.sh            # Deployment script
│
└── data/
    └── sss_positions.json              # Persisted positions (auto-created)
```

---

## 6. Configuration Files

### sss_sport_params.json

Main configuration for sport-specific parameters.

```json
{
  "strategy": "SSS",
  "version": "1.0",
  "enabled_sports": ["NHL", "NFL", "NBA"],
  "global_defaults": {
    "min_entry_price": 0.40,
    "max_entry_price": 0.60,
    "min_sell_price": 0.05,
    "stop_loss": null,
    "entry_window_minutes": 10,
    "order_type": "MARKET",
    "max_concurrent_positions": 50
  },
  "sports": {
    "NHL": {
      "enabled": true,
      "priority": 1,
      "sell_threshold": 0.25,
      "min_volume_24h": 50000,
      "max_bet_size": 100
    },
    "SOCCER": {
      "enabled": false,
      "priority": 4,
      "sell_threshold": 0.30,
      "feasibility_tier": "CONDITIONAL_GO",
      "leagues": {
        "EPL": { "prefix": "epl", "status": "CONDITIONAL_GO" },
        "UCL": { "prefix": "ucl", "status": "CONDITIONAL_GO" }
      },
      "market_structure": {
        "type": "3-way",
        "draw_rate": 0.21,
        "handling": "Trade 'Will X Win?' markets as binary"
      }
    }
    // ... other sports
  }
}
```

**Note**: Soccer is currently `enabled: false` pending tick data validation. Set to `true` after collecting 2 weeks of tick data to validate reversal rates.

### sss_runtime_params.json

Runtime configuration for scaling and parameter adjustments.

```json
{
  "version": 1,
  "last_updated": "2026-02-03T00:00:00Z",
  "scaling_config": {
    "enabled": false,
    "require_approval": true,
    "aum": 1000,
    "current_tier": "STARTER"
  },
  "parameter_overrides": {
    "NHL": { "sell_threshold": null }
  },
  "lessons_learned": []
}
```

---

## 7. External Dependencies

### Dashboard API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/positions` | Get all active positions (with revamped fields) |
| GET | `/api/positions/pending-sells` | Get positions within 10c of threshold (sorted) |
| GET | `/api/stats` | Get P&L summary and statistics (with section counts) |
| GET | `/api/trades` | Get trade history (last 100) |
| GET | `/api/health` | Get market health data |
| GET | `/api/full` | Get all data in one response |
| GET | `/api/upcoming-games?hours=N&sport=S` | Get games within N hours, optionally filtered by sport |
| GET | `/api/positions/pending-settlement` | Get positions awaiting settlement (sorted by game end time) |
| POST | `/api/force-entry` | Force SPLIT entry (paper mode only) |
| POST | `/api/force-sell` | Force sell unsold shares on pending settlement positions |

#### GET /api/positions (Revamped Schema - US-807)

Response schema includes new fields for the section-based dashboard:

```json
{
  "positions": [
    {
      "marketSlug": "nhl-sea-ana-2026-02-03",
      "sport": "NHL",
      "question": "Will Seattle win?",
      "state": "holding",
      "entryTime": "2026-02-03T19:00:00Z",
      "elapsedMinutes": 45,

      "outcome1": {
        "name": "Seattle",
        "shares": 10,
        "sold": false,
        "currentBid": 0.55,
        "soldPrice": null,
        "soldRevenue": null
      },
      "outcome2": {
        "name": "Anaheim",
        "shares": 10,
        "sold": false,
        "currentBid": 0.45,
        "soldPrice": null,
        "soldRevenue": null
      },

      "splitCost": 10.0,
      "totalSoldRevenue": 0,
      "unrealizedPnL": 0.50,
      "realizedPnL": 0,

      "sellThreshold": 0.25,
      "distanceToThreshold1": 0.30,
      "distanceToThreshold2": 0.20,

      "isPendingSell": false,
      "closestToThreshold": "outcome2",
      "distanceToThreshold": 0.20,
      "projectedPnL": 0,
      "winnerValue": 0
    }
  ]
}
```

**New Fields (US-807):**

| Field | Type | Description |
|-------|------|-------------|
| `isPendingSell` | boolean | True if position is within 10c of sell threshold |
| `closestToThreshold` | string | `"outcome1"`, `"outcome2"`, or `null` |
| `distanceToThreshold` | number | Distance to threshold for closest side (in dollars) |
| `projectedPnL` | number | For `partial_sold`: `soldRevenue + (shares × $1.00) - splitCost` |
| `winnerValue` | number | For `partial_sold`: `shares × currentBid` |

#### GET /api/positions/pending-sells (US-807)

Returns only positions within 10c of sell threshold, sorted by distance ascending (closest first).

Response schema:
```json
{
  "positions": [
    {
      "marketSlug": "nhl-sea-ana-2026-02-03",
      "distanceToThreshold": 0.02,
      "closestToThreshold": "outcome2",
      ...
    }
  ]
}
```

#### GET /api/stats (Revamped Schema - US-807)

Response schema includes new section counts:

```json
{
  "mode": "PAPER",
  "running": true,
  "startedAt": "2026-02-03T12:00:00Z",

  "initialBalance": 1000,
  "currentBalance": 890,

  "positionsActive": 11,
  "positionsSettled": 5,
  "positionsPendingSell": 1,

  "realizedPnL": 12.50,
  "unrealizedPnL": 3.20,
  "totalPnL": 15.70,

  "winCount": 4,
  "lossCount": 1,
  "winRate": 0.80,
  "avgPnLPerPosition": 2.50,

  "bySport": {
    "NHL": { "positionsActive": 5, "realizedPnL": 8.50 },
    "NBA": { "positionsActive": 6, "realizedPnL": 4.00 }
  },

  "splitsToday": 8,
  "sellsToday": 3,
  "mergesToday": 0,
  "settlementsToday": 2,
  "todayPnL": 5.20,

  "pendingSellCount": 1,
  "watchingCount": 7,
  "holdingWinnersCount": 3,
  "deployedCapital": 100,
  "projectedTotalPnL": 6.50
}
```

**New Fields (US-807):**

| Field | Type | Description |
|-------|------|-------------|
| `pendingSellCount` | number | Positions within 10c of threshold (state=holding) |
| `watchingCount` | number | Positions holding both sides, NOT near threshold |
| `holdingWinnersCount` | number | Positions with loser sold (state=partial_sold) |
| `deployedCapital` | number | Sum of split costs for all open positions |
| `projectedTotalPnL` | number | Sum of projected P&L from holding winners |

#### GET /api/positions/pending-settlement (US-817)

Returns positions in PENDING_SETTLEMENT state, sorted by game end time (oldest first).

Response schema:
```json
{
  "positions": [
    {
      "marketSlug": "nhl-sea-ana-2026-02-03",
      "sport": "NHL",
      "state": "pending_settlement",
      "isPendingSettlement": true,
      "gameEndedAt": "2026-02-03T22:30:00Z",
      "winningOutcome": "Seattle",
      "hasUnsoldShares": true,
      "unsoldOutcome": "Anaheim",
      "unsoldShares": 10,
      "unsoldCurrentBid": 0.02,
      "outcome1": {
        "name": "Seattle",
        "shares": 10,
        "sold": false,
        "currentBid": 0.98
      },
      "outcome2": {
        "name": "Anaheim",
        "shares": 10,
        "sold": false,
        "currentBid": 0.02
      },
      "splitCost": 10.0,
      "totalSoldRevenue": 0,
      "projectedPnL": 0
    }
  ]
}
```

**New Fields (US-817/818):**

| Field | Type | Description |
|-------|------|-------------|
| `isPendingSettlement` | boolean | True when state is PENDING_SETTLEMENT |
| `gameEndedAt` | string (ISO date) | When game end was detected (99c+ price) |
| `winningOutcome` | string | Name of the winning outcome |
| `hasUnsoldShares` | boolean | True if any side has unsold shares |
| `unsoldOutcome` | string | Name of the unsold side (if any) |
| `unsoldShares` | number | Number of unsold shares |
| `unsoldCurrentBid` | number | Current BID price for unsold side |

#### GET /api/upcoming-games

Query parameters:
- `hours` - Time horizon in hours. Accepts: 6, 12, 24 (default), 48
- `sport` - Filter by sport category. Accepts: `hockey`, `football`, `basketball`, `soccer` (optional)

Response schema:
```json
{
  "games": [
    {
      "marketSlug": "nhl-sea-ana-2026-02-03",
      "sport": "NHL",
      "leaguePrefix": null,
      "teams": { "home": "ANA", "away": "SEA" },
      "gameStartTime": "2026-02-03T19:00:00Z",
      "prices": { "yes": 0.48, "no": 0.52 },
      "volume": 125000,
      "status": "scheduled",
      "hasPosition": false,
      "polymarketUrl": "https://polymarket.com/event/nhl-sea-ana-2026-02-03"
    },
    {
      "marketSlug": "epl-arsenal-vs-chelsea-2026-02-03",
      "sport": "SOCCER",
      "leaguePrefix": "EPL",
      "teams": { "home": "Chelsea", "away": "Arsenal" },
      "gameStartTime": "2026-02-03T15:00:00Z",
      "prices": { "yes": 0.52, "no": 0.48 },
      "volume": 5600000,
      "status": "entry_window",
      "hasPosition": true,
      "polymarketUrl": "https://polymarket.com/event/epl-arsenal-vs-chelsea-2026-02-03"
    }
  ]
}
```

Status values:
- `scheduled` - Game hasn't started
- `entry_window` - Within first 10 minutes of game
- `live` - Game in progress, entry window closed
- `ended` - Game has ended

#### POST /api/force-entry

Request body:
```json
{
  "marketSlug": "nhl-sea-ana-2026-02-03",
  "betSize": 10
}
```

Response (success):
```json
{
  "success": true,
  "position": {
    "marketSlug": "nhl-sea-ana-2026-02-03",
    "sport": "NHL",
    "shares": 10,
    "cost": 10.0
  }
}
```

Response (error - live mode):
```json
{
  "error": "Force entry is only available in PAPER mode"
}
```
HTTP Status: 403

#### POST /api/force-sell (US-814)

Force sell unsold shares on a pending settlement or holding position. Used when a game has ended but the loser side wasn't automatically sold (didn't hit the sell threshold).

Request body:
```json
{
  "marketSlug": "nhl-sea-ana-2026-02-03",
  "outcomeIndex": 1
}
```

| Field | Type | Description |
|-------|------|-------------|
| `marketSlug` | string | The market slug to force sell |
| `outcomeIndex` | 0 or 1 | Which outcome to sell (0 = outcome1, 1 = outcome2) |

Response (success):
```json
{
  "success": true,
  "marketSlug": "nhl-sea-ana-2026-02-03",
  "outcomeIndex": 1,
  "outcomeName": "Anaheim",
  "sharesSold": 10,
  "fillPrice": 0.02,
  "revenue": 0.20,
  "newBalance": 1000.20
}
```

Response (error - wrong state):
```json
{
  "success": false,
  "marketSlug": "nhl-sea-ana-2026-02-03",
  "error": "Position state is partial_sold, expected PENDING_SETTLEMENT or HOLDING"
}
```
HTTP Status: 400

Response (error - no shares):
```json
{
  "success": false,
  "marketSlug": "nhl-sea-ana-2026-02-03",
  "error": "No shares to sell for outcome 1"
}
```
HTTP Status: 400

**Use Cases:**
- Game ended but loser never hit sell threshold (e.g., stayed at 30c throughout)
- Settlement is delayed and you want to free up capital
- Manual intervention for edge cases

### WebSocket Events (US-807)

The dashboard WebSocket pushes real-time updates to browser clients.

#### Message Types

| Type | Description |
|------|-------------|
| `FULL_UPDATE` | Complete refresh of all data |
| `POSITIONS_UPDATE` | Position data changed |
| `STATS_UPDATE` | Statistics changed |
| `TRADE_UPDATE` | New trade occurred |
| `HEALTH_UPDATE` | Market health data changed |
| `UPCOMING_GAMES_UPDATE` | Upcoming games list changed |
| `POSITION_SECTION_CHANGE` | Position moved between dashboard sections |

#### POSITION_SECTION_CHANGE Event (US-807)

Fired when a position transitions between dashboard sections:

```json
{
  "type": "POSITION_SECTION_CHANGE",
  "data": {
    "marketSlug": "nhl-sea-ana-2026-02-03",
    "fromSection": "watching",
    "toSection": "pending_sells"
  },
  "timestamp": 1707000000000
}
```

Section values:
- `watching` - Holding both sides, far from threshold
- `pending_sells` - Within 10c of sell threshold
- `holding_winners` - Loser sold, holding winner

This event triggers smooth CSS animations when positions move between sections in the UI.

### Dashboard Calculation Formulas (US-802, US-804, US-807)

These formulas are used to calculate the values displayed in the revamped dashboard.

#### Progress Bar Percentage

The progress bar shows how close a price is to the sell threshold:

```
progressPercent = (50c - currentBid) / (50c - threshold) × 100

// Capped at 0-100%, with special handling for below threshold
if (currentBid <= threshold) progressPercent = 100 (AT THRESHOLD!)
if (currentBid >= 50c) progressPercent = 0 (far from threshold)
```

**Example (NHL with 25c threshold):**
- currentBid = 50c → progress = (50-50)/(50-25) × 100 = 0%
- currentBid = 35c → progress = (50-35)/(50-25) × 100 = 60%
- currentBid = 27c → progress = (50-27)/(50-25) × 100 = 92%
- currentBid = 25c → progress = 100% (AT THRESHOLD)
- currentBid = 22c → progress = 100% (BELOW THRESHOLD, sell triggered)

#### Progress Bar Color Transitions

```
if (progressPercent < 60) color = 'green'
else if (progressPercent < 80) color = 'yellow'
else color = 'red'
```

#### Distance to Threshold

Distance in cents from current price to sell threshold:

```
distanceToCents = (currentBid - threshold) × 100

// Example: NHL (threshold = 25c), currentBid = 27c
distanceToCents = (0.27 - 0.25) × 100 = 2c
```

#### Urgency Level (Pending Sells Section)

```
if (distanceToCents > 5) urgencyLevel = 'normal' (green)
else if (distanceToCents > 2) urgencyLevel = 'caution' (yellow)
else urgencyLevel = 'imminent' (red, pulsing animation)
```

#### Projected P&L (Holding Winners Section)

For positions where the loser was sold (state = `partial_sold`):

```
projectedPnL = soldRevenue + (winnerShares × $1.00) - splitCost

// Example:
// Split cost: $10.00 (10 shares each side)
// Sold loser @ 22c: 10 × $0.22 = $2.20 revenue
// Holding winner: 10 shares
// If winner settles at $1.00:
projectedPnL = $2.20 + (10 × $1.00) - $10.00 = $2.20
```

#### Winner Value (Holding Winners Section)

Current market value of held winner shares:

```
winnerValue = winnerShares × currentBid

// Example:
// Holding 10 winner shares at 87c BID
winnerValue = 10 × $0.87 = $8.70
```

#### isPendingSell Flag

A position is considered "pending sell" if EITHER outcome is within 10c of threshold:

```
isPendingSell = (outcome1.currentBid < threshold + 0.10)
             || (outcome2.currentBid < threshold + 0.10)

// Example: NHL threshold = 25c
// outcome1 at 55c, outcome2 at 33c
// 33c < 35c (25c + 10c) → isPendingSell = true
```

#### Deployed Capital

Total capital locked in open positions:

```
deployedCapital = SUM(position.splitCost) for all open positions

// Example:
// Position 1: $10 split
// Position 2: $25 split
// Position 3: $50 split
deployedCapital = $10 + $25 + $50 = $85
```

#### Projected Total P&L

Sum of projected P&L from all holding winners positions:

```
projectedTotalPnL = SUM(position.projectedPnL)
                    for positions where state = 'partial_sold'
```

### External APIs Used

| API | Endpoint | Purpose | Rate Limit |
|-----|----------|---------|------------|
| Gamma API | `https://gamma-api.polymarket.com` | Market discovery | 300/10s |
| CLOB API | `https://clob.polymarket.com` | Orders, prices | 9000/10s |
| WebSocket | `wss://ws-subscriptions-clob.polymarket.com` | Real-time prices | N/A |
| Builder Relayer | (configured) | SPLIT/MERGE | N/A |

### npm Dependencies

| Package | Purpose |
|---------|---------|
| `@polymarket/clob-client` | Official Polymarket SDK |
| `ethers` | Ethereum wallet operations |
| `axios` | HTTP requests |
| `ws` | WebSocket client |
| `dotenv` | Environment configuration |

---

## References

- [SSS_STRATEGY.md](./SSS_STRATEGY.md) - Strategy documentation
- [SSS_QUICKSTART.md](./SSS_QUICKSTART.md) - Getting started
- [sss_sport_params.json](../src/config/sss_sport_params.json) - Configuration
- [analysis/](../analysis/) - Research documents

---

*Last Updated: 2026-02-04*
