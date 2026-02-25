# PRD: 2-Level Avellaneda Split-Sell (2L-ASS) Strategy

## Executive Summary

A market-making strategy for Polymarket 15-minute binary crypto markets that uses SPLIT to acquire tokens and SELL at two price tiers with Avellaneda-inspired inventory skew. The strategy aims to capture spread profit while dynamically drifting toward the winning side at settlement.

---

## 1. Problem Statement

### Current Challenges
1. **Single-level strategies miss price spikes** - When market suddenly moves, a single ASK price either fills too early (leaving money on table) or never fills
2. **Trending markets cause losses** - Selling the winning side early means missing $1 settlement value
3. **Emergency hedging is expensive** - Current DCA MM V2 loses ~$13 avg per emergency hedge vs +$0.50 per profitable cycle
4. **Inventory imbalance creates directional risk** - One-sided fills leave us exposed to wrong side at settlement

### Opportunity
Use 2-tier pricing with Avellaneda inventory management to:
- Capture normal spreads with tight level (high fill probability)
- Capture spikes with wide level (bonus profit)
- Maintain buffer inventory on potential winner side
- Dynamically adjust sizing based on inventory imbalance

---

## 2. Market Analysis Requirements

### 2.1 Data Sources
- **Tick data**: `/analysis/tick_data/` - Historical order book snapshots
- **Trade data**: Trade events with price, size, side
- **Binance data**: Reference price for settlement prediction

### 2.2 Key Metrics to Analyze (from last 100 BTC markets)

| Metric | Purpose |
|--------|---------|
| **Price distribution at M0** | Where do markets typically open? |
| **Price volatility by minute** | How much do prices move M0→M15? |
| **Spread distribution** | What's typical bid-ask spread? |
| **Spike frequency** | How often do prices jump >3c in <1 min? |
| **Fill rates by price level** | What % of ASKs at bid+2c vs bid+5c fill? |
| **Trending vs sideways ratio** | How often does winner emerge early? |
| **Settlement distribution** | UP win % vs DOWN win %? |

### 2.3 Market Scenarios to Design For

Based on historical patterns, categorize markets into:

#### Scenario A: Sideways/Oscillating (Target: 40% of markets)
```
Characteristics:
- Opening price: 45c-55c on both sides
- Max price swing: <15c during window
- Winner unclear until M12+
- High fill rates on both sides

Strategy goal: Maximize spread capture, stay balanced
```

#### Scenario B: Early Trend (Target: 35% of markets)
```
Characteristics:
- Clear direction by M5 (one side >60c)
- Steady drift toward winner
- Winner side fills slow, loser fills fast

Strategy goal: Protect winner, dump loser early
```

#### Scenario C: Late Reversal (Target: 15% of markets)
```
Characteristics:
- Looks like Scenario A until M10
- Sudden move in last 5 minutes
- Can flip from 55/45 to 70/30 quickly

Strategy goal: Wide level captures late spike, tight level already sold
```

#### Scenario D: Extreme/Volatile (Target: 10% of markets)
```
Characteristics:
- Opening already imbalanced (>65c one side)
- High volatility, rapid price swings
- Multiple direction changes

Strategy goal: Conservative sizing, wide spreads, avoid overexposure
```

---

## 3. Strategy Specification

### 3.1 Core Mechanics

#### SPLIT + SELL Model
```
1. SPLIT $X USDC → X UP tokens + X DOWN tokens (cost: $X)
2. Place SELL orders on both sides at two price tiers
3. On fill: Update inventory, recalculate sizes
4. At settlement: Remaining tokens settle at $0 or $1
5. Profit = (sell_revenue + settlement_value) - split_cost
```

#### Two-Level Pricing

**Why BID as Reference (not ASK):**

We place LIMIT SELL orders (ASKs) that fill when buyers pay our price. Using BID as reference makes sense because:

1. **BID = current buyer demand** - what someone is willing to pay right now
2. **Adding spread to BID** - we're asking for a premium above current demand
3. **Fill probability** - when BID rises to our price OR a market buy sweeps through, we fill
4. **Consistent profit calculation** - `pairCostBid + 2*spread = revenue`

```
Order Book Example:
  ASK: 54c ← Other sellers (we compete with these)
  ASK: 53c
  ASK: 52c ← Best ASK
  ─────────
  BID: 51c ← Best BID (buyers waiting)
  BID: 50c

Our SELL order at BID + 2c = 53c
→ We're offering to sell 2c above what buyers currently bid
→ Fills when: buyer raises bid to 53c OR market buy occurs
```

**Profit Calculation:**
```
If UP BID = 52c, DOWN BID = 46c (pairCostBid = 98c)
Our spread = 2c per side
UP ASK = 54c, DOWN ASK = 48c
Revenue if both fill = 54c + 48c = $1.02
Cost = $1.00 (SPLIT)
Profit = $0.02 per pair
```

**Two Price Tiers:**
```
TIGHT LEVEL (70% allocation):
  - Price: BID + 2c (aggressive, likely to fill)
  - Purpose: Capture normal spread, high turnover

WIDE LEVEL (30% allocation):
  - Price: BID + 5c (conservative, captures spikes)
  - Purpose: Bonus profit on price jumps, inventory buffer
```

### 3.2 Avellaneda Inventory Skew

#### Inventory Imbalance Calculation
```typescript
// q = normalized inventory imbalance [-1, +1]
// q > 0: More UP than DOWN (long UP)
// q < 0: More DOWN than UP (long DOWN)
q = (upRemaining - downRemaining) / (upRemaining + downRemaining);
```

#### Skewed Sizing Formula
```typescript
// eta = inventory aversion parameter (0.3 default)
// Higher eta = more aggressive rebalancing

upSize = baseSize * Math.exp(-eta * q);    // q>0: sell less UP
downSize = baseSize * Math.exp(eta * q);   // q>0: sell more DOWN
```

#### Skewed Spread Formula (Optional)
```typescript
// gamma = spread aversion parameter (0.5 default)
// Widen spread on side we want to KEEP

if (q > 0) {
  // More UP → protect UP, dump DOWN
  upSpread = baseSpread * (1 + gamma * q);    // Wider
  downSpread = baseSpread * (1 - gamma * q);  // Tighter
}
```

### 3.3 Phase-Based Behavior

#### Phase 1: Spread Harvest (M0 - M8)
```
Goal: Maximize spread capture, stay balanced
- Equal spreads on both sides
- Aggressive resplitting when inventory low
- Track momentum signal passively
- Inventory skew via sizing only (not spread)
```

#### Phase 2: Adaptive Transition (M8 - M12)
```
Goal: Gradually drift toward probable winner
- Apply both spread AND sizing skew
- Reduce resplit frequency
- Widen spreads overall (time decay)
- Monitor momentum signal actively
```

#### Phase 3: Directional Commitment (M12 - M15)
```
Goal: Position for settlement
- Stop resplitting entirely
- If clear winner: Protect winner (15c spread), dump loser (1c spread)
- If unclear: Exit all inventory at tight spreads
- Emergency exit at M14.5 if needed
```

### 3.4 Polymarket Order Constraints

**CRITICAL**: All orders must comply with Polymarket's minimum order requirements:

```
Minimum Order Size: 5 shares OR $1 notional value (whichever is MET FIRST)

Examples:
- At 50c price: min 5 shares × $0.50 = $2.50 ✓ (5 shares meets minimum)
- At 10c price: min 5 shares × $0.10 = $0.50 ✗ → need 10 shares for $1
- At 25c price: min 5 shares × $0.25 = $1.25 ✓ (5 shares meets minimum)
```

**Implementation Rules:**
1. **Minimum Order Size**: Always place orders of at least 5 shares
2. **Order Rounding**: Round calculated sizes UP to nearest integer (never fractional shares)
3. **Skip Small Orders**: If Avellaneda sizing calculates < 5 shares, skip that order
4. **Balance Check**: Ensure sufficient token balance before placing order

```typescript
// Order validation helper
function validateOrderSize(calculatedSize: number, price: number): number | null {
  const MIN_SHARES = 5;
  const MIN_NOTIONAL = 1.0; // $1
  
  // Round up to integer
  const shares = Math.ceil(calculatedSize);
  
  // Check minimum shares
  if (shares < MIN_SHARES) {
    return null; // Skip order - too small
  }
  
  // Check minimum notional (rare but possible at very low prices)
  const notional = shares * price;
  if (notional < MIN_NOTIONAL) {
    const minSharesForNotional = Math.ceil(MIN_NOTIONAL / price);
    return Math.max(shares, minSharesForNotional);
  }
  
  return shares;
}
```

### 3.5 Configuration Parameters

```typescript
interface TwoLevelASSConfig {
  // Capital
  initialSplitUSD: number;          // Starting capital per window (default: 50)
  maxTotalSplitUSD: number;         // Maximum capital committed (default: 100)
  
  // Pricing - Tight Level
  tightSpreadCents: number;         // Spread above BID (default: 2)
  tightAllocationPct: number;       // % of inventory (default: 0.70)
  
  // Pricing - Wide Level
  wideSpreadCents: number;          // Spread above BID (default: 5)
  wideAllocationPct: number;        // % of inventory (default: 0.30)
  
  // Inventory Management
  eta: number;                      // Avellaneda sizing parameter (default: 0.3)
  gamma: number;                    // Avellaneda spread parameter (default: 0.5)
  resplitThreshold: number;         // Resplit when both sides < X (default: 10)
  resplitAmount: number;            // Amount to resplit (default: 25)
  
  // Imbalance Thresholds
  softImbalanceThreshold: number;   // Adjust spreads (default: 0.20)
  hardImbalanceThreshold: number;   // Stop resplitting (default: 0.40)
  criticalImbalanceThreshold: number; // Emergency action (default: 0.60)
  
  // Phase Timing
  phase2StartMinute: number;        // (default: 8)
  phase3StartMinute: number;        // (default: 12)
  emergencyExitMinute: number;      // (default: 14.5)
  
  // Momentum/Direction
  momentumThreshold: number;        // Min momentum to commit (default: 0.10)
  winnerSpreadCents: number;        // Phase 3 winner spread (default: 15)
  loserSpreadCents: number;         // Phase 3 loser spread (default: 1)
  
  // Order Management
  orderUpdateThresholdCents: number; // Min price change to update (default: 0.5)
  minOrderSize: number;             // Minimum shares per order (default: 5) - POLYMARKET MINIMUM
}
```

---

## 4. Implementation Phases (Streamlined)

### OBJECTIVE
Get a profitable Avellaneda SPLIT/SELL strategy as fast as possible through:
1. Backtest that matches live simulation exactly
2. Parameter optimization via backtest iteration
3. Live simulation validation of winning parameters
4. Live trading deployment

### Phase 1: Foundation (COMPLETE)
**Status: US-001 through US-019 PASSED**

Built core infrastructure:
- Backtest engine with SPLIT/SELL simulation
- Avellaneda inventory skew (eta, gamma parameters)
- Two-level pricing (tight + wide spreads)
- Phase-based behavior (Phase 1/2/3)
- TypeScript live simulation with Dashboard V2 integration
- Order lifecycle synchronization

**Lesson Learned (US-019b)**: 
- 10-window validation FAILED: 40% win rate, -$47.13 P&L
- Root cause: Phase 3 dump spread (1c) accelerates losses
- Backtest must match live simulation before trusting optimization

### Phase 2A: Fix Tick Collector (COMPLETE - US-020a)
**Status: DONE** - Tick collector fixed and 10+ windows collected.

#### What Was Done:
- Created `src/tick-collector.ts` using same `OrderBookWebSocket` class as live simulation
- Captures book_update events (full bids[], asks[]) and trade events (price, size, side)
- Deployed to collector server (157.180.68.185) as `polymarket-tick-collector.service`
- Verified: 5827 events captured for first test window

#### Data Available:
- 10+ windows of tick data from fixed collector
- Corresponding live simulation logs from Finland
- Ready for backtest parity testing

### Phase 2B: Backtest Parity (CURRENT - US-021)
**Goal: Backtest matches live simulation within ±20% on 8/10 windows**

#### Key Understanding:
Both live simulation AND backtest use **trade-based fill detection** (no real orders are placed). The discrepancy comes from:
1. **Latency**: Backtest processes ticks instantly; live simulation has WebSocket/processing delays
2. **Order timing**: Backtest updates orders immediately; live simulation has reaction time
3. **Fill detection thresholds**: May differ slightly between implementations

#### Data Available (NO NEW LIVE SIM NEEDED):
- 10+ windows of tick data from fixed collector
- Corresponding live simulation logs from Finland
- Use this existing data for iterative tuning

#### Iterative Tuning Process:
```
1. Pick 1 window from existing data
2. Run backtest with identical params used in live sim
3. Compare P&L - if delta > 20%:
   a. Add latency_ms parameter to backtest (simulate delays)
   b. Verify fill detection logic matches exactly
   c. Compare order placement timing
4. Fix issue, re-run on same window
5. Repeat until 1 window passes (delta < 20%)
6. Run on all 10 windows - success if 8/10 within ±20%
```

#### Latency Simulation:
```python
# Backtest should simulate live simulation latency
class BacktestConfig:
    latency_ms: int = 100  # Delay before processing each tick
    order_update_delay_ms: int = 50  # Delay before order updates take effect
```

#### Key Parity Checks:
| Component | Must Match |
|-----------|------------|
| Fill detection | Trade-based (price crosses ASK = fill) |
| Avellaneda sizing | q = (up-down)/(up+down), size = base × exp(±eta×q) |
| Phase spreads | P1: tight/wide, P2: skewed, P3: dump/protect (if enabled) |
| Resplit logic | When inventory < threshold |
| **Settlement P&L** | Must include remaining token value (see below) |

#### CRITICAL: Settlement P&L Calculation

At window end, remaining tokens have value based on winner:

```
P&L = sell_revenue + settlement_value - split_cost

Where:
  sell_revenue = sum of all filled sell orders (UP sells + DOWN sells)
  split_cost = total USDC spent on SPLITs ($1 per pair)
  settlement_value = (remaining_winner_tokens × $1.00) + (remaining_loser_tokens × $0.00)
```

**Example:**
```
Split: 100 pairs ($100 cost)
Sold: 60 UP @ 54c = $32.40, 40 DOWN @ 52c = $20.80
Remaining: 40 UP, 60 DOWN
Winner: UP

Settlement value = 40 × $1.00 + 60 × $0.00 = $40.00
P&L = $32.40 + $20.80 + $40.00 - $100.00 = -$6.80
```

**Both backtest and live simulation MUST:**
1. Track remaining inventory (upRemaining, downRemaining) at window end
2. Determine winner from Binance settlement price
3. Calculate settlement_value = winner_remaining × $1.00
4. Include settlement_value in final P&L

#### Deliverables:
- `analysis/backtest_2lass_parity.py` - Validated backtest script
- `analysis/2lass_parity_log.md` - Discrepancy fixes documented
- Backtest total P&L within ±10% of -$47.13

### Phase 3: Parameter Optimization (US-022)
**Goal: 9/10 windows profitable via backtest iteration**

#### Starting Point (Symmetric Selling):
```
eta = 0.3
tight_spread = 2c
wide_spread = 5c
phase3_enabled = false  # No dump spread
```

#### Parameters to Tune:
| Parameter | Range | Purpose |
|-----------|-------|---------|
| eta | 0.1 - 0.5 | Inventory aversion (higher = more aggressive rebalancing) |
| tight_spread | 1c - 4c | Aggressive fill price |
| wide_spread | 3c - 8c | Spike capture price |
| phase3_enabled | true/false | Enable/disable late-window behavior change |

#### Iteration Loop:
```
for each parameter combination:
    run backtest on 10 parity windows
    calculate: win_rate, total_pnl, worst_window
    
    if win_rate >= 9/10 and total_pnl > 0:
        FOUND WINNER → save to 2lass_optimal_params_v2.json
        proceed to Phase 4
```

#### Deliverables:
- `analysis/2lass_optimization_log.md` - All iterations documented
- `analysis/2lass_optimal_params_v2.json` - Winning parameters
- 9/10 windows profitable in backtest

### Phase 4: Live Simulation Validation (US-023)
**Goal: Confirm backtest-optimized parameters work in live simulation**

#### Steps:
1. Update `TwoLevelASS_Simulation.ts` with winning parameters
2. Deploy to Finland server
3. Run for **10 consecutive full 15-minute windows** (~2.5 hours)
4. Compare results to backtest prediction

#### Success Criteria:
- **9/10 windows profitable (P&L > $0)**
- **Total P&L > $0**
- Results match backtest within reasonable margin

#### If FAIL:
```
1. Compare live logs to backtest predictions
2. Identify divergence source (fills? timing? prices?)
3. Fix backtest to match reality
4. Return to Phase 3, re-optimize
5. Repeat until live validates
```

#### Deliverables:
- `analysis/2lass_live_validation_v2.md` - Detailed results
- Confirmation that backtest predicts live performance

### Phase 5: Live Trading (US-024)
**PREREQUISITE: Phase 4 must PASS**

#### Steps:
1. Create `TwoLevelASS.ts` (live version)
2. Create `run-2lass.ts` entry point
3. Create `polymarket-2lass.service` systemd service
4. Deploy to Finland with **$100/window initial capital**
5. Monitor for 20 windows, scale up if profitable

#### Safety Features:
- Max loss per window: $20
- Position persistence across restarts
- Balance verification before SPLIT

#### Deliverables:
- Production-ready live trading bot
- Systemd service for auto-restart
- Monitoring via Dashboard V2

---

## 5. Success Metrics

### Primary KPIs
| Metric | Target | Measurement |
|--------|--------|-------------|
| Win Rate | >60% | Windows with positive P&L |
| Avg P&L per Window | >$2 | Total P&L / Windows |
| Max Drawdown | <$50 | Largest consecutive loss |
| Sharpe Ratio | >1.5 | Risk-adjusted return |

### Secondary KPIs
| Metric | Target | Measurement |
|--------|--------|-------------|
| Tight Level Fill Rate | >80% | Tight fills / Tight orders |
| Wide Level Fill Rate | >30% | Wide fills / Wide orders |
| Avg Spread Captured | >3c | Revenue / Tokens sold |
| Settlement Win Rate | >55% | Correct side holdings at settlement |

---

## 6. Risk Management

### Risk: One-Sided Fills (Trending Market)
**Mitigation:**
- Wide level acts as buffer on potential winner
- Avellaneda skew accelerates selling of loser
- Critical imbalance triggers emergency hedge

### Risk: Both Sides Fill Too Fast
**Mitigation:**
- Phase 2 widens spreads as time passes
- Phase 3 stops resplitting to preserve inventory
- Settlement exposure is intentional (profit from winner)

### Risk: Settlement on Wrong Side
**Mitigation:**
- Momentum tracking identifies likely winner
- Phase 3 protects likely winner with wide spread
- Diversification across multiple assets

### Risk: Low Liquidity / Wide Spreads
**Mitigation:**
- Skip markets with spread > 5c at M0
- Reduce sizing in low-liquidity conditions
- Use dynamic spread based on market depth

---

## 7. Technical Architecture

### Order Flow
```
┌─────────────────────────────────────────────────────────────┐
│                    WEBSOCKET PRICE FEED                      │
│         (OrderBookWS: UP/DOWN bid/ask updates)              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   STRATEGY ENGINE                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  Inventory  │  │   Phase     │  │  Avellaneda │         │
│  │   Tracker   │  │  Manager    │  │ Calculator  │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   ORDER MANAGER                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ UP Side                    │ DOWN Side              │   │
│  │ ├─ Tight: bid+2c × size   │ ├─ Tight: bid+2c × size│   │
│  │ └─ Wide:  bid+5c × size   │ └─ Wide:  bid+5c × size│   │
│  └─────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              POLYMARKET CLIENT / SIMULATOR                   │
│      (Real orders or simulated trade-based fills)           │
└─────────────────────────────────────────────────────────────┘
```

### File Structure
```
poly_arbitrage/
├── src/
│   ├── strategies/
│   │   ├── TwoLevelASS_Simulation.ts    # Simulation version
│   │   └── TwoLevelASS.ts               # Live trading version
│   ├── run-2lass-simulation.ts          # Simulation entry point
│   └── run-2lass.ts                     # Live entry point
├── analysis/
│   ├── 2lass_market_analysis.py         # Data analysis
│   ├── backtest_2lass.py                # Backtest engine
│   └── 2lass_optimization.py            # Parameter optimizer
└── docs/
    ├── PRD_2LEVEL_ASS_STRATEGY.md       # This document
    └── 2LASS_IMPLEMENTATION_GUIDE.md    # Technical guide
```

### Dashboard V2 Integration

The strategy MUST integrate with Dashboard V2 (same pattern as DCA MM V2) for real-time monitoring and P&L visualization.

#### Required: DashboardRelay Service

Import and use the singleton `dashboardRelay` from `src/services/DashboardRelay.ts`:

```typescript
import { dashboardRelay } from "../services/DashboardRelay";

// Start relay in constructor or start()
dashboardRelay.start();

// Stop relay on shutdown
dashboardRelay.stop();
```

#### Required Events to Broadcast

| Event Type | When to Emit | Data Interface |
|------------|--------------|----------------|
| `MARKET_SWITCH` | New 15-min window starts | `MarketEventData` |
| `PRICE_UPDATE` | BID/ASK prices change | `PriceEventData` |
| `ORDER_PLACED` | New limit order placed | `OrderEventData` |
| `ORDER_FILLED` | Order fully filled | `OrderEventData` |
| `ORDER_PARTIAL` | Partial fill | `OrderEventData` |
| `ORDER_CANCELLED` | Order cancelled | `OrderEventData` |
| `POSITION_UPDATE` | Token balance changes | `PositionEventData` |

#### PositionEventData for P&L Tracking

**CRITICAL**: The `PositionEventData` interface provides all metrics needed for dashboard P&L display:

```typescript
interface PositionEventData {
  // Current inventory
  upQty: number;              // UP tokens held
  downQty: number;            // DOWN tokens held
  upAvg: number;              // Avg cost of UP (not used in SPLIT model)
  downAvg: number;            // Avg cost of DOWN (not used in SPLIT model)
  pairCost: number;           // Current window split cost
  hedgedPairs: number;        // Pairs sold (both sides filled)

  // Cumulative stats across ALL windows (session totals)
  totalPnL: number;           // Cumulative P&L since session start
  balance: number;            // Current paper balance
  initialBalance: number;     // Starting balance
  windowCount: number;        // Number of windows completed

  // Current window stats
  windowMergedPairs: number;  // Pairs merged/sold this window
  windowMergeProfit: number;  // Profit from merges this window
  windowAvgPairCost: number;  // Average pair sale price (should be > $1.00 for profit)

  timestamp: number;
}
```

#### Example: Broadcasting Position Update

```typescript
private broadcastPositionUpdate(): void {
  const state = this.windowState;
  const q = this.calculateInventoryImbalance();

  dashboardRelay.broadcast({
    type: "POSITION_UPDATE",
    data: {
      upQty: state.upRemaining,
      downQty: state.downRemaining,
      upAvg: 0.50,  // SPLIT model: always 50c each
      downAvg: 0.50,
      pairCost: state.splitCost,
      hedgedPairs: state.tightStats.sharesFilled + state.wideStats.sharesFilled,

      // Session totals
      totalPnL: this.sessionPnL,
      balance: this.paperBalance,
      initialBalance: this.initialBalance,
      windowCount: this.windowCount,

      // Current window
      windowMergedPairs: state.tightStats.fills + state.wideStats.fills,
      windowMergeProfit: state.sellRevenue - state.splitCost,
      windowAvgPairCost: state.sellRevenue / Math.max(1, state.tightStats.sharesFilled + state.wideStats.sharesFilled),

      timestamp: Date.now(),
    },
  });
}
```

#### Example: Broadcasting Order Events

```typescript
private broadcastOrderPlaced(order: SimulatedOrder): void {
  dashboardRelay.broadcast({
    type: "ORDER_PLACED",
    data: {
      orderId: order.orderId,
      side: order.side,
      price: order.price,
      size: order.size,
      filledSize: 0,
      remaining: order.size,
      orderType: order.level === "TIGHT" ? "trigger" : "zone",  // Map to existing types
      setId: this.currentWindowSlug,
      label: `${order.level} ${order.side}`,  // e.g., "TIGHT UP", "WIDE DOWN"
      timestamp: Date.now(),
    },
  });
}

private broadcastOrderFilled(order: SimulatedOrder, fillSize: number): void {
  const isFullFill = order.filled >= order.size;

  dashboardRelay.broadcast({
    type: isFullFill ? "ORDER_FILLED" : "ORDER_PARTIAL",
    data: {
      orderId: order.orderId,
      side: order.side,
      price: order.price,
      size: order.size,
      filledSize: order.filled,
      remaining: order.size - order.filled,
      orderType: order.level === "TIGHT" ? "trigger" : "zone",
      setId: this.currentWindowSlug,
      label: `${order.level} ${order.side}`,
      timestamp: Date.now(),
    },
  });
}
```

#### Dashboard Port Configuration

The entry point (`run-2lass-simulation.ts`) should accept a `--port` argument:

```typescript
const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3012;

process.env.DASHBOARD_PORT = port.toString();
```

This allows running multiple simulations on different ports (e.g., 3002 for DCA MM V2, 3012 for 2L-ASS).

#### Order Lifecycle Synchronization (CRITICAL)

**Dashboard visuals MUST match simulation state exactly.** When an order is filled or cancelled in the simulation, it MUST be removed from the dashboard display.

**How Dashboard Handles Order Events** (from `useBotOrders.js`):

```javascript
// ORDER_PLACED: Add to orders map
case "ORDER_PLACED":
  setOrders((prev) => ({
    ...prev,
    [data.orderId]: { ...data, status: "pending" },
  }));
  break;

// ORDER_FILLED: Remove from orders map (fully filled = gone)
case "ORDER_FILLED":
  setOrders((prev) => {
    const newOrders = { ...prev };
    delete newOrders[data.orderId];  // ← ORDER REMOVED
    return newOrders;
  });
  break;

// ORDER_PARTIAL: Update remaining size (still visible)
case "ORDER_PARTIAL":
  setOrders((prev) => ({
    ...prev,
    [data.orderId]: {
      ...prev[data.orderId],
      size: data.remaining,  // ← Size updated to remaining
      status: "partial",
    },
  }));
  break;

// ORDER_CANCELLED: Remove from orders map
case "ORDER_CANCELLED":
  setOrders((prev) => {
    const newOrders = { ...prev };
    delete newOrders[data.orderId];  // ← ORDER REMOVED
    return newOrders;
  });
  break;

// MARKET_SWITCH: Clear all orders (new window)
case "MARKET_SWITCH":
  setOrders({});  // ← ALL ORDERS CLEARED
  break;
```

**Implementation Requirements:**

1. **Every order MUST have unique `orderId`** - Use `${windowSlug}-${side}-${level}-${timestamp}` format
2. **Broadcast ORDER_CANCELLED when cancelling orders** - Not just when filled
3. **Broadcast ORDER_FILLED only when fully filled** - Use ORDER_PARTIAL for partial fills
4. **Broadcast MARKET_SWITCH at window start** - Dashboard clears all stale orders
5. **Use consistent orderId** - Same ID in PLACED, PARTIAL, FILLED, CANCELLED events

**Example: Cancel and Replace Order Flow**

When updating an order (price changed), you must:
1. Cancel old order: `broadcast({ type: "ORDER_CANCELLED", data: { orderId: oldId } })`
2. Place new order: `broadcast({ type: "ORDER_PLACED", data: { orderId: newId, ... } })`

```typescript
private updateOrder(side: "UP" | "DOWN", level: "TIGHT" | "WIDE", newPrice: number): void {
  const oldOrder = this.activeOrders[`${side}_${level}`];
  
  if (oldOrder) {
    // Cancel old order on dashboard
    this.broadcastOrderCancelled(oldOrder);
  }
  
  // Create new order
  const newOrder = this.createOrder(side, level, newPrice);
  this.activeOrders[`${side}_${level}`] = newOrder;
  
  // Place new order on dashboard
  this.broadcastOrderPlaced(newOrder);
}
```

**Verification Checklist:**
- [ ] Dashboard shows only active pending orders (not filled/cancelled)
- [ ] Order count on dashboard matches `Object.keys(activeOrders).length` in simulation
- [ ] Orders disappear when filled
- [ ] Orders disappear when cancelled
- [ ] New window clears all previous orders

---

## 8. Timeline Summary (Streamlined)

| Phase | User Stories | Duration | Status |
|-------|--------------|----------|--------|
| 1. Foundation | US-001 to US-019 | - | ✅ COMPLETE |
| 2A. Fix Tick Collector | US-020a | - | ✅ COMPLETE |
| 2B. Backtest Parity | US-021 | 1 day | 🔄 CURRENT |
| 3. Parameter Optimization | US-022 | 1 day | ⏳ Pending |
| 4. Live Simulation Validation | US-023 | 3 hours | ⏳ Pending |
| 5. Live Trading | US-024 | 1 day | ⏳ Pending |

**Total to first live trade: ~3 days from now**

### Critical Path:
```
[DONE] Fix Collector → Backtest Parity → Optimize until 9/10 profitable → Validate Live → Deploy
                            ↑                           ↓
                            └── If live fails, fix backtest and re-optimize ──┘
```

### Current Focus (US-021):
Use existing 10+ windows of data to iteratively tune backtest until it matches live simulation within ±20%.

---

## 9. Strategy Principles (Updated 2025-01-24)

### 9.1 CRITICAL: Symmetric Selling Over Winner Prediction

**Problem Identified from US-019b Validation:**
- Strategy was selling winning side during Phase 1-2 (spread revenue)
- Phase 3 "dump spread" (1c) accelerated losses on winner side
- 40% win rate, -$47.13 total P&L across 10 windows

**Root Cause:**
Winner prediction before M10+ is unreliable. The strategy was "gambling" on direction instead of capturing symmetric spread profit.

**Solution: Symmetric Selling Model**

```
Core Principle:
  - Source of pairs: SPLIT ($1 = 1 UP + 1 DOWN)
  - Profit model: Sell both sides, capture spread on BOTH
  - Imbalance at settlement: BONUS (not primary strategy)
  - Never gamble on holding wrong side until settlement
```

**Phase 3 Changes:**
- **REMOVE** dump spread (1c loser spread) - this accelerates losses
- **REMOVE** time-triggered winner protection
- Phase 3 should be a **testable parameter**, not hardcoded behavior
- If Phase 3 is enabled, it should use price signals (not time) to determine winner

### 9.2 CRITICAL: Backtest Parity Requirement

**Before trusting any backtest results, we MUST verify:**

1. Backtest logic matches live simulation logic EXACTLY
2. Run backtest on SAME windows as live simulation
3. Compare logs line-by-line for matching fills, P&L, decisions
4. Iterate until results are within acceptable margin (±5%)

**Why This Matters:**
- US-019b showed -$47.13 loss in live simulation
- If backtest showed profit, the backtest is WRONG
- Fix backtest first, then optimize parameters

### 9.3 Capital Model

```
Capital: $2000 paper balance
Constraint: Unlimited splits (limited only by liquidity)
Split size: Configurable (default 100 shares = $100 per split)
Max splits per window: Limited by (balance / splitSize) and liquidity
```

### 9.4 Spread Philosophy

**Wider spreads are NOT the answer:**
- 12c/18c spreads = low fill probability
- Low fills = holding inventory to settlement = gambling on direction
- High fills (even at lower spread) = realized profit

**Optimal Spread:**
- Must be discoverable through backtest parity
- Start with current parameters (2c tight, 5c wide)
- Let backtest optimization find true optimal

## 10. Open Questions

1. **Optimal spread that balances fill rate vs profit per fill?**
   - Requires backtest parity to answer reliably

2. **Should Phase 3 exist at all?**
   - Current hypothesis: NO - symmetric selling only
   - Make it a toggleable parameter for A/B testing

3. **When to resplit?**
   - When both sides have inventory < threshold
   - NOT time-based (avoid overcommitting)

---

## 11. Appendix: Example Calculations

### Example: Avellaneda Sizing with q = 0.3

```
Starting inventory: 40 UP, 28 DOWN
q = (40 - 28) / (40 + 28) = 0.176

With eta = 0.3:
  UP multiplier = exp(-0.3 × 0.176) = 0.949
  DOWN multiplier = exp(0.3 × 0.176) = 1.054

Base size = 10 shares per level

Tight level (70%):
  UP: 10 × 0.7 × 0.949 = 6.6 → 7 shares
  DOWN: 10 × 0.7 × 1.054 = 7.4 → 7 shares

Wide level (30%):
  UP: 10 × 0.3 × 0.949 = 2.8 → 3 shares
  DOWN: 10 × 0.3 × 1.054 = 3.2 → 3 shares

Orders placed:
  UP tight:  BID + 2c × 7 shares
  UP wide:   BID + 5c × 3 shares
  DOWN tight: BID + 2c × 7 shares
  DOWN wide:  BID + 5c × 3 shares
```

### Example: Phase 3 Commitment

```
At M12:
  Accumulated momentum = +0.12 (UP trending)
  Inventory: 15 UP, 25 DOWN
  q = (15-25)/40 = -0.25 (slightly long DOWN - BAD!)

Decision: Clear UP winner, but we're short UP

Actions:
  1. Stop resplitting (don't add more balanced inventory)
  2. Protect remaining UP: ASK @ BID + 15c (nearly impossible to fill)
  3. Dump DOWN aggressively: ASK @ BID + 1c (immediate fill)

Expected outcome:
  - DOWN fills quickly: 25 × ~45c = $11.25 revenue
  - UP holds to settlement: 15 × $1.00 = $15.00
  - Total: $26.25 vs ~$40 split cost
  - Loss minimized by protecting UP

Without protection (sell all at tight spread):
  - Both fill at ~50c: 40 × 50c = $20 revenue
  - Settlement: $0 (no inventory)
  - Total: $20 vs $40 cost = -$20 loss
```

---

*Document Version: 1.0*
*Created: 2025-01-23*
*Author: Claude + User collaboration*
