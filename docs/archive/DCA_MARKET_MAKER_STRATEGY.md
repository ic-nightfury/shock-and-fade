# DCA Market Maker Strategy

## Overview

The DCA (Dollar Cost Average) Market Maker is a simulation strategy for Polymarket 15-minute crypto prediction markets. It uses **SPLIT + SELL** to profit from selling token pairs above the $1.00 SPLIT cost.

## Core Concept

**SPLIT gives us tokens at $1.00 per pair. We profit by selling the pair for more than $1.00.**

```
SPLIT: $1.00 USDC → 1 UP token + 1 DOWN token

Profit = (Trigger Revenue + Hedge Revenue) - $1.00 SPLIT cost
```

**Example:**
- SPLIT cost: $1.00 per pair
- Sell UP trigger at $0.30 → receive $0.30
- Sell DOWN hedge at $0.74 → receive $0.74
- Total revenue: $1.04
- **Profit: +$0.04 per pair**

## Strategy Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     WINDOW START (M0)                           │
├─────────────────────────────────────────────────────────────────┤
│  1. Wait for valid prices (20¢-80¢ range)                       │
│  2. SPLIT $300 USDC → 300 UP + 300 DOWN tokens                  │
│     (We now OWN these tokens, cost basis = $1.00/pair)          │
│  3. Create SELL trigger sets on BOTH sides (4 levels each)      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ACTIVE TRADING (M0-M14.5)                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  TRIGGER ORDERS (SELL on both UP and DOWN):                     │
│    L1: SELL  5 shares @ ASK        (fills first)                │
│    L2: SELL 10 shares @ ASK + 1¢   (better price)               │
│    L3: SELL 20 shares @ ASK + 3¢   (even better)                │
│    L4: SELL 40 shares @ ASK + 7¢   (best price, slides in)      │
│                                                                 │
│  When TRIGGER fills:                                            │
│    → We receive USDC                                            │
│    → Calculate DYNAMIC target based on filled levels            │
│    → Place/update HEDGE SELL on opposite side                   │
│    → If L4 fills, slide L4 into visible position                │
│                                                                 │
│  When HEDGE fills:                                              │
│    → Complete pair sale!                                        │
│    → Profit = trigger + hedge revenue - $1.00                   │
│    → Reset set, create new triggers                             │
│                                                                 │
│  Every 3 seconds:                                               │
│    → Check if price moved > 1¢                                  │
│    → Refresh orders at new prices if needed                     │
│    → Check if SPLIT needed (tokens running low)                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│               EXTREME PRICE EXIT (if detected)                  │
├─────────────────────────────────────────────────────────────────┤
│  Triggered when: price ≤ 10¢ OR price ≥ 90¢                     │
│                                                                 │
│  1. Cancel ALL pending orders                                   │
│  2. Handle excess tokens:                                       │
│     - If overweight is WINNING side (≥90¢):                     │
│       → LIMIT SELL at 95¢ (capture near-settlement value)       │
│     - If overweight is LOSING side:                             │
│       → MARKET SELL at BID - 1¢ (cut losses)                    │
│  3. MERGE remaining pairs → $1.00 each                          │
│  4. Skip to next window                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     WINDOW END (M14.5+)                         │
├─────────────────────────────────────────────────────────────────┤
│  1. Cancel all pending orders                                   │
│  2. Sell any excess tokens at market                            │
│  3. MERGE remaining pairs back to USDC ($1.00 each)             │
│  4. Calculate window P&L                                        │
│  5. Wait for next 15-minute window                              │
└─────────────────────────────────────────────────────────────────┘
```

## DCA Trigger Levels

We place **4 levels** of SELL orders at progressively higher prices:

| Level | Size | Spread from ASK | Cumulative Spread | Target |
|-------|------|-----------------|-------------------|--------|
| L1 | 5 shares | +0¢ (at ASK) | 0¢ | 104¢ |
| L2 | 10 shares | +1¢ | +1¢ | 103¢ |
| L3 | 20 shares | +2¢ | +3¢ | 102¢ |
| L4 | 40 shares | +4¢ | +7¢ | 101¢ |

**Total: 75 shares per side (150 shares for both UP + DOWN)**

### Spread Calculation

Spreads grow exponentially with `spreadMultiplier = 2`:

```
L1: ASK + 0¢                           (at market)
L2: ASK + baseSpread                   = ASK + 1¢
L3: ASK + baseSpread + baseSpread×2    = ASK + 3¢
L4: ASK + baseSpread + baseSpread×2 + baseSpread×4 = ASK + 7¢
```

### Why 4 Levels?

- **L1 small (5)**: Quick fills, establishes position, minimal risk
- **L2 medium (10)**: Better price, doubles exposure
- **L3 large (20)**: Even better price, significant size
- **L4 largest (40)**: Best price, captures big moves, slides in after L1 fills

## Dynamic Pair Target (Key Innovation)

**The target pair price DECREASES as more levels fill.**

This solves the "stuck hedge" problem where hedge orders become unreachable as prices move.

| Filled Levels | Target Calculation | Target Price |
|---------------|-------------------|--------------|
| L1 only | baseTarget | 104¢ |
| L1 + L2 | baseTarget - 1¢ | 103¢ |
| L1 + L2 + L3 | baseTarget - 2¢ | 102¢ |
| L1 + L2 + L3 + L4 | baseTarget - 3¢ | 101¢ |

**Formula:**
```
dynamicTarget = baseTarget - (filledLevelsCount - 1) × targetReduction
effectiveTarget = max(dynamicTarget, pairPriceTarget)  // Floor at 99¢
hedgePrice = effectiveTarget - avgTriggerPrice
```

### Example: Dynamic Target in Action

```
Market: UP at 30¢, DOWN at 70¢

Step 1: L1 fills at 30¢ (5 shares)
  - Filled levels: 1
  - Target: 104¢
  - Hedge price: 104¢ - 30¢ = 74¢
  → Place hedge: SELL 5 DOWN @ 74¢

Step 2: L2 also fills at 31¢ (10 more shares)
  - Filled levels: 2
  - Target: 103¢ (reduced!)
  - Avg trigger: (5×30 + 10×31) / 15 = 30.67¢
  - Hedge price: 103¢ - 30.67¢ = 72.33¢
  → Update hedge: SELL 15 DOWN @ 72¢ (closer to market!)

Step 3: L3 also fills at 33¢ (20 more shares)
  - Filled levels: 3
  - Target: 102¢ (reduced again!)
  - Avg trigger: (5×30 + 10×31 + 20×33) / 35 = 32¢
  - Hedge price: 102¢ - 32¢ = 70¢
  → Update hedge: SELL 35 DOWN @ 70¢ (at market!)
```

**Why this works:** As we fill more triggers at higher prices (further from market), we accept lower profit targets. This makes hedge prices reachable even when the market has moved.

## Cumulative Hedge Mechanism

Hedges are **cumulative** - they grow as more triggers fill:

```typescript
// When trigger fills:
1. Count total filled shares across all levels
2. Calculate average trigger price (revenue-weighted)
3. Determine effective target based on filled levels count
4. Calculate hedge price: target - avg_trigger_price
5. If hedge exists: cancel and replace with new size/price
6. Reserve tokens for hedge order
```

### Hedge Update Rules

The hedge is updated when:
- **New trigger fills** → Hedge size increases
- **Price changes** → Hedge price recalculated
- **Both** → Cancel old hedge, place new one

## Split Management

### Dynamic Split Threshold

```
setSize = 75 shares (total per side)
minRequired = setSize × 4 = 300 shares
criticalThreshold = setSize = 75 shares
```

### Split Triggers

| Condition | Action |
|-----------|--------|
| Balance < 300 AND no pending hedges | SPLIT to replenish |
| Balance < 75 (CRITICAL) | SPLIT immediately, even with pending hedges |
| Before creating new sets | Check and SPLIT if needed |
| Before refreshing orders | Check and SPLIT if needed |

### Why Critical Threshold?

If we have pending hedges that never fill (price moved away), we'd never split and run out of tokens. The critical threshold (75) forces a split when we're dangerously low, regardless of pending orders.

## Extreme Price Handling

When price reaches extreme levels (≤10¢ or ≥90¢), the market is likely settled:

```
Extreme Price Detected (e.g., UP at 95¢, DOWN at 5¢)
                              │
                              ▼
              ┌───────────────────────────────┐
              │  1. Cancel all pending orders │
              │  2. Return reserved tokens    │
              └───────────────────────────────┘
                              │
                              ▼
         ┌────────────────────┴────────────────────┐
         │                                         │
    Overweight is                            Overweight is
    WINNING (≥90¢)                           LOSING (<90¢)
         │                                         │
         ▼                                         ▼
┌─────────────────────┐                 ┌─────────────────────┐
│ LIMIT SELL @ 95¢    │                 │ MARKET SELL @ BID-1¢│
│ (capture near $1)   │                 │ (cut losses)        │
└─────────────────────┘                 └─────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │  MERGE remaining pairs → $1   │
              │  Skip to next window          │
              └───────────────────────────────┘
```

**Dashboard Logging**: Extreme price exits show detailed logs:
- Initial token balances
- Each cancelled order with size/price
- Limit or market sell decision
- Final balance after cleanup

## Configuration

```typescript
const DCA_CONFIG = {
  // Asset
  asset: "BTC",                // BTC, ETH, SOL, XRP
  
  // Trigger sizing (DCA levels)
  baseShare: 5,                // L1 = 5 shares
  sizeMultiplier: 2,           // L2 = 10, L3 = 20, L4 = 40
  dcaTriggerLevels: 4,         // 4 levels total
  
  // Trigger pricing (spreads)
  baseSpread: 0.01,            // 1¢ base spread
  spreadMultiplier: 2,         // Exponential: +1¢, +3¢, +7¢
  
  // Dynamic pair target
  baseTarget: 1.04,            // 104¢ target when L1 fills
  targetReduction: 0.01,       // Reduce by 1¢ per level
  pairPriceTarget: 0.99,       // 99¢ minimum floor
  
  // Split management
  // (Dynamic: minRequired = setSize × 4 = 300)
  // (Critical: setSize = 75)
  
  // Timing
  tradingStartOffset: 5,       // Start 5s after M0
  tradingEndMinute: 14.5,      // Stop at M14.5
  refreshOrderTime: 3000,      // Check orders every 3s
  
  // Risk management
  extremePriceThreshold: 0.10, // Exit if ≤10¢ or ≥90¢
  imbalanceThreshold: 100,     // IMBALANCED mode threshold
  emergencyMinPrice: 0.04,     // Emergency exit if ≤4¢
};
```

## P&L Calculation

### Per-Pair Profit

```
pair_revenue = trigger_fill_price + hedge_fill_price
pair_profit = pair_revenue - $1.00 (SPLIT cost)
```

### Dynamic Target Examples

| Scenario | Trigger | Target | Hedge | Revenue | Profit |
|----------|---------|--------|-------|---------|--------|
| L1 fills | 30¢ | 104¢ | 74¢ | $1.04 | +4¢ |
| L1+L2 fill | 31¢ avg | 103¢ | 72¢ | $1.03 | +3¢ |
| L1+L2+L3 fill | 32¢ avg | 102¢ | 70¢ | $1.02 | +2¢ |
| All 4 fill | 33¢ avg | 101¢ | 68¢ | $1.01 | +1¢ |

### Total P&L Calculation

```
Total P&L = USDC Balance + Token Value - Initial Balance

where:
  Token Value = (UP shares × UP_BID) + (DOWN shares × DOWN_BID)
  Initial Balance = $2000 (default)
```

## Order Types

| Order | Direction | Purpose | Price |
|-------|-----------|---------|-------|
| **SPLIT** | USDC → Tokens | Acquire inventory | $1.00/pair |
| **Trigger SELL** | Token → USDC | Sell one side | ASK + spread |
| **Hedge SELL** | Token → USDC | Complete the pair | Target - trigger |
| **MERGE** | Tokens → USDC | Return inventory | $1.00/pair |

## Trade-Based Fill Simulation

The simulation uses WebSocket trade events for realistic fill detection:

```typescript
// SELL order fills when a BUY trade occurs at or above our price
if (event.side === "buy" && event.tradePrice >= order.limitPrice) {
  // CRITICAL: Fill at OUR limit price, not trade price
  processSimulatedFill(order, fillSize, order.limitPrice);
}
```

**Key insight**: We receive our LIMIT price, not the trade price. If we sell at 35¢ and a trade happens at 40¢, we still only receive 35¢.

## Dashboard Visualization

The dashboard at `http://65.21.146.43:5173/` shows:

- **Price Chart**: UP/DOWN prices with hedge level lines
- **Market Stats**: Current BID/ASK, spread, time remaining
- **Position Summary**: Balance, token values, total P&L
- **Current Window**: Pairs sold, avg pair cost, window P&L
- **Live Logs**: Real-time order placements, fills, profits

## File Structure

```
poly_arbitrage/
├── src/
│   ├── strategies/
│   │   └── DCAMarketMaker_Simulation.ts  # Main strategy
│   ├── services/
│   │   ├── DashboardRelay.ts             # WebSocket to dashboard
│   │   └── OrderBookWS.ts                # Price & trade feeds
│   └── run-dca-mm-simulation.ts          # Entry point
├── dashboard-v2/                          # React visualization
│   ├── server/index.ts                   # Backend WebSocket server
│   └── src/                              # React frontend
└── docs/
    └── DCA_MARKET_MAKER_STRATEGY.md      # This file
```

## Quick Commands

```bash
# Start simulation (production server)
ssh root@65.21.146.43 "cd /root/poly_arbitrage && nohup npx tsx --no-cache src/run-dca-mm-simulation.ts > dca_sim.log 2>&1 &"

# View logs
ssh root@65.21.146.43 "tail -f /root/poly_arbitrage/dca_sim.log"

# Stop simulation
ssh root@65.21.146.43 "pkill -f 'run-dca-mm'"

# Restart dashboard
ssh root@65.21.146.43 "pkill -f dashboard-v2; cd /root/poly_arbitrage/dashboard-v2 && nohup npm run dev > dashboard.log 2>&1 &"

# Dashboard URL
http://65.21.146.43:5173/
```

## Key Lessons

1. **SPLIT cost is $1.00/pair** - This is our cost basis. Everything above is profit.

2. **Sell BOTH sides** - We're not betting on direction. We sell UP AND DOWN to capture spread.

3. **Dynamic target solves stuck hedges** - As more levels fill, we accept lower targets, making hedge prices reachable.

4. **Fill at limit price** - Simulation must use order's limit price for revenue, not the trade event price.

5. **Critical split threshold** - Force split at 75 shares regardless of pending hedges to prevent running out of tokens.

6. **Extreme price = likely settlement** - Exit early, capture value on winning side at 95¢, cut losses on losing side.

7. **Cumulative hedge recalculation** - Every trigger fill recalculates the entire hedge (size, price, target).
