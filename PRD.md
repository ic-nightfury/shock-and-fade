# Product Requirements Document (PRD)
# Polymarket Arbitrage Strategy

## Executive Summary

Market-neutral arbitrage trading bot for Polymarket's BTC 15-minute Up/Down binary prediction markets. Exploits the mathematical certainty that in binary markets, exactly one outcome pays $1.00 per share at settlement.

**Win Condition:**
```
min(qty_UP, qty_DOWN) > total_cost = GUARANTEED PROFIT
```

---

## Problem Statement

Binary prediction markets on Polymarket offer paired outcomes (e.g., "BTC Up" vs "BTC Down" in 15-minute intervals). When market inefficiencies allow acquiring both sides for less than $1.00 combined, guaranteed profit exists regardless of the actual outcome.

**Challenges:**
1. Real-time price monitoring across both sides
2. Balanced position accumulation
3. Dynamic rebalancing when positions drift
4. Optimal execution to minimize slippage
5. Time pressure (15-minute market windows)

---

## Solution Overview

An automated trading system with four operating modes:

| Mode | Trigger | Purpose |
|------|---------|---------|
| **NORMAL** | Default | Accumulate both sides with inventory-aware pricing |
| **BALANCING** | Imbalance >= threshold | Rebalance using trigger-hedge mechanism |
| **PAIR_IMPROVEMENT** | After BALANCING, if pair cost >= $1.00 | Recover cost by buying below averages |
| **PROFIT_LOCK** | Can lock profit at current prices | Balance position to realize guaranteed profit |

**Priority:** PROFIT_LOCK > BALANCING > PAIR_IMPROVEMENT > NORMAL

---

## Win Condition Deep Dive

### The Guarantee

Binary markets guarantee exactly one outcome (UP or DOWN) wins, paying $1.00/share.

```
Example Position:
  - 100 UP shares @ $0.52 avg = $52.00 cost
  - 100 DOWN shares @ $0.43 avg = $43.00 cost
  - Total cost: $95.00
  - Hedged pairs: 100

At Settlement:
  - One side wins → receives $100.00
  - Guaranteed profit: $100.00 - $95.00 = $5.00 (5.26% return)
```

### Win Condition Formula

```
Guaranteed Profit = min(qty_UP, qty_DOWN) - (cost_UP + cost_DOWN)

Requirements:
  1. min(qty_UP, qty_DOWN) > total_cost
  2. Pair cost < $1.00
```

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     ARBITRAGE TRADING BOT                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │                   STRATEGY LAYER                            │     │
│  │              (ArbitrageStrategy.ts)                         │     │
│  ├───────────────┬───────────────┬───────────────┬───────────┤     │
│  │ NORMAL Mode   │ BALANCING     │ PAIR_IMPROVE  │ PROFIT_   │     │
│  │ - Multi-level │ - MICRO       │ - Below-avg   │ LOCK      │     │
│  │   bids        │   trigger-    │   buying      │ - Instant │     │
│  │ - Inventory   │   hedge       │ - Cost        │   balance │     │
│  │   skew        │ - Linear      │   recovery    │ - Merge   │     │
│  │               │   scaling     │               │   pairs   │     │
│  └───────────────┴───────────────┴───────────────┴───────────┘     │
│                               │                                      │
│  ┌────────────────────────────▼─────────────────────────────────┐   │
│  │                    SERVICE LAYER                              │   │
│  ├──────────────┬──────────────┬──────────────┬────────────────┤   │
│  │Polymarket    │ OrderBookWS  │BalanceMonitor│ MergeClient    │   │
│  │Client        │ (Prices)     │WS (USDC)     │ (Redemption)   │   │
│  │(CLOB API)    │              │              │                │   │
│  └──────────────┴──────────────┴──────────────┴────────────────┘   │
│                               │                                      │
│  ┌────────────────────────────▼─────────────────────────────────┐   │
│  │                  PERSISTENCE LAYER                            │   │
│  │                    (Database.ts)                              │   │
│  │  - arbitrage_positions: qty, cost, profit tracking            │   │
│  │  - arbitrage_trades: fill history                             │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Core Features

### 1. NORMAL Mode (Accumulation)

**Purpose:** Build balanced positions at favorable prices.

**Logic:**
- Place up to 3 orders per side at 1c intervals
- Use inventory skew to adjust starting prices (Avellaneda-style)
- Price-based size scaling: 1.1x per cent below average
- Filter orders by `getMaxPriceForSide()` to maintain pair cost < $0.99

**Example:**
```
UP avg: $0.55, DOWN avg: $0.40
maxPrice(UP) = 0.99 - 0.40 - 0.01 = $0.58

UP orders: $0.55, $0.54, $0.53 (below max)
DOWN orders: $0.38, $0.37, $0.36
```

### 2. BALANCING Mode (MICRO Trigger-Hedge)

**Purpose:** Rebalance imbalanced positions using passive triggers + hedges.

**Trigger Conditions (ALL required):**
1. Imbalance ratio >= dynamic threshold
2. Absolute imbalance >= 110 shares
3. Deficit side ask > $0.50

**Execution Flow:**
```
1. CALCULATE: Determine deficit, X (dilution shares)
2. PLACE TRIGGERS: Tiered bids at BID, BID-1c, BID-2c
3. ON FILL: Place proportional hedge
   - Phase 1 (catching up): Half hedge
   - Phase 2 (balanced): Full hedge
4. EXIT: When balanced or forced
```

**Linear Size Scaling (getLevelSize):**
```
Price    | Multiplier | Size (base=10)
---------|------------|---------------
SOT      | 1.0x       | 10
$0.60    | 1.67x      | 17
$0.55    | 2.33x      | 24
$0.50    | 3.0x       | 30
```

### 3. PAIR_IMPROVEMENT Mode

**Purpose:** Recover cost when pair cost >= $1.00 after BALANCING.

**Logic:**
- Buy BOTH sides at prices BELOW their respective averages
- Tighter spread than NORMAL (bid - 0.02)
- 1.3x size scaling per cent below average

### 4. PROFIT_LOCK Mode

**Purpose:** Lock guaranteed profit when opportunity detected.

**Trigger:**
```typescript
newLockedPNL > lastLockedPNL && newLockedPNL > 0
```

**Execution:**
1. Cancel all pending orders
2. Buy deficit side at Ask+1c (aggressive)
3. Wait for fill
4. Merge hedged pairs via Builder Relayer
5. Reset state for next opportunity

---

## Key Algorithms

### Dynamic Imbalance Threshold

Position size determines trigger sensitivity:

| Total Shares | Threshold |
|--------------|-----------|
| 0-100 | 100% - 86% |
| 100-500 | 86% - 30% |
| 500-2000 | 30% - 5% |
| 2000+ | 5% (floor) |

### Level Size Scaling (getLevelSize)

```typescript
sizeMultiplier = 1 + 2 * (SOT - price) / (SOT - 0.50)
// 1x at SOT → 3x at $0.50
// NO max cap - sizes scale freely for faster rebalancing
```

### Core Size Decay

```typescript
// Time decay: After M6, decrease 20% per minute
if (minute >= 6) base *= Math.pow(0.8, minute - 6);

// Profit-lock decay: 30% per successful lock
if (profitLockCount > 0) base *= Math.pow(0.7, profitLockCount);
```

### Dilution Formula (BALANCING)

```
X = (TARGET_PAIR_COST × basePairs - totalCostAfterDeficit) /
    (triggerPrice + hedgePrice - TARGET_PAIR_COST)
```

---

## Success Metrics

### Primary

| Metric | Target | Description |
|--------|--------|-------------|
| Win Rate | 100% | When profit is locked, outcome is guaranteed |
| Profit per Lock | 1-5% | Depends on entry prices and balance quality |
| Capital Efficiency | >80% | USDC utilization rate |

### Secondary

| Metric | Description |
|--------|-------------|
| Pair Cost | Average cost per hedged pair (target: < $0.99) |
| Rebalance Success | % of BALANCING cycles that achieve balance |
| Markets per Hour | 4 maximum (one every 15 minutes) |

---

## Technical Requirements

### Infrastructure

- **Runtime:** Node.js with TypeScript
- **Database:** SQLite for position persistence
- **WebSocket:** Real-time price feeds

### External APIs

| API | Purpose |
|-----|---------|
| Gamma API | Market discovery |
| CLOB API | Order placement/management |
| WebSocket | Real-time prices |
| Builder Relayer | Gas-free redemption |

### Blockchain

| Property | Value |
|----------|-------|
| Network | Polygon (137) |
| Collateral | USDC.e |
| Signature | POLY_GNOSIS_SAFE |

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `POLYMARKET_PRIVATE_KEY` | Yes | Wallet private key |
| `POLYMARKET_FUNDER` | Yes | Gnosis Safe address |
| `BUILDER_API_KEY` | Yes | Builder Relayer credentials |
| `BUILDER_SECRET` | Yes | Builder Relayer credentials |
| `BUILDER_PASS_PHRASE` | Yes | Builder Relayer credentials |

### Strategy Parameters

| Variable | Default | Description |
|----------|---------|-------------|
| `ARB_BASE_SIZE` | 5 | Base shares per trade |
| `ARB_STOP_MINUTE` | 8 | Stop after this minute if profitable |
| `ARB_MAX_CAPITAL_PCT` | 80% | Stop if capital usage exceeds |
| `ARB_TARGET_PAIR_COST` | $0.98 | Target pair cost |

### Hard-Coded Constants

- MAX_CORE_SIZE = 32
- PRICE_FLOOR = $0.05
- TARGET_PAIR_COST (BALANCING) = $0.99
- ABSOLUTE_IMBALANCE_THRESHOLD = 110 shares

---

## Market Exit Conditions

```
1. MARKET DECIDED
   - UP or DOWN bid <= $0.02 OR >= $0.98

2. TIME + PROFIT
   - Current minute >= stopMinute (default M8)
   - AND isProfitable() = true

3. CAPITAL + PROFIT
   - Capital used >= maxCapitalPct (default 80%)
   - AND isProfitable() = true
```

---

## Risk Factors & Mitigations

| Risk | Mitigation |
|------|------------|
| API downtime | Position persistence in SQLite; graceful reconnection |
| Extreme price moves | Price caps via getMaxPriceForSide() |
| Execution slippage | IOC orders ensure known fill prices |
| Position imbalance | BALANCING mode with multi-level triggers |
| Late market exposure | Time decay on core size; stopMinute |

---

## Commands

```bash
# Production
npm run bot              # Run arbitrage strategy
npm run start            # Run (production alias)

# Simulation
npm run arb:sim          # Paper trading with real prices

# Utilities
npm run aum              # Check AUM breakdown
npm run rebase           # Redeem positions + update baseline
npm run init-wallet      # First-time wallet setup
```

---

## File Structure

```
src/
├── strategies/
│   ├── ArbitrageStrategy.ts     # Production strategy
│   └── ArbitrageSimulation.ts   # Simulation strategy
├── services/
│   ├── PolymarketClient.ts      # CLOB API wrapper
│   ├── OrderBookWS.ts           # Price feeds
│   ├── BalanceMonitorWS.ts      # Balance tracking
│   ├── MergeClient.ts           # Token merging
│   └── Database.ts              # SQLite persistence
└── types/
    └── index.ts                 # Type definitions

docs/
├── ARBITRAGE_STRATEGY.md        # Detailed strategy documentation
└── references/                  # Formula derivations
```

---

## Key Functions Reference

| Function | Purpose |
|----------|---------|
| `getMode()` | Determine current strategy mode |
| `getDynamicImbalanceThreshold()` | Calculate BALANCING trigger |
| `getCoreSize()` | Base order size with time/lock decay |
| `getLevelSize()` | Linear scaling 1x→3x for BALANCING |
| `getMaxPriceForSide()` | Price cap to keep pair cost < $0.99 |
| `checkProfitLockOpportunity()` | Detect profit-lock trigger |
| `calculateMicroBalancingParams()` | Calculate X, total sizes |
| `updateMicroTriggerOrders()` | Place tiered trigger bids |
| `handleMicroTriggerFill()` | Process fill with Phase 1/2 hedging |

---

*Document Version: 2.0*
*Strategy: V8 Bilateral Accumulation with MICRO Balancing*
*Last Updated: 2026-01-16*
