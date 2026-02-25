# Inverse-SET Strategy v2 (SPLIT + SELL)

Guaranteed-profit market-making for Polymarket 15-minute BTC Up/Down binary markets using linked sell order pairs with GTC orders. This is the **inverse** of the SET (BUY + MERGE) strategy.

**V2 Features:** Capital-aware sizing, dynamic cooldown, zone accumulation, IOC orders for DROP, lifetime tracking, bilateral hedge calculation, race condition guards.

---

## Win Condition

```
min(qty_UP_sold, qty_DOWN_sold) × (avg_sell_revenue - $1.00) = GUARANTEED PROFIT

Requirements:
  1. avg_UP_sell_price + avg_DOWN_sell_price > $1.00
  2. Balanced sales (equal UP and DOWN sold) throughout market window
```

Binary markets guarantee exactly one outcome wins → $1.00/share payout. By selling equal UP and DOWN tokens at combined revenue > $1.00, profit is locked regardless of outcome. The tokens came from SPLIT ($1.00 each pair), so any revenue above $1.00 is profit.

---

## Strategy Comparison: SET vs Inverse-SET

| Aspect | SET (BUY + MERGE) | Inverse-SET (SPLIT + SELL) |
|--------|-------------------|---------------------------|
| **Capital Operation** | MERGE: 1 UP + 1 DOWN → $1 | SPLIT: $1 → 1 UP + 1 DOWN |
| **Trading Operation** | BUY tokens | SELL tokens |
| **Order Side** | Limit BUY at BID | Limit SELL at ASK |
| **Target** | pair_cost < $1.00 | sell_revenue > $1.00 |
| **Profit Source** | Buy cheap, merge to $1 | Split $1, sell expensive |
| **Win Condition** | `hedged × ($1.00 - pair_cost)` | `hedged × (sell_revenue - $1.00)` |
| **Momentum Detection** | SURGE (price rises) | DROP (price drops) |
| **Inventory Source** | USDC (always available) | Tokens from SPLIT |
| **Capital Recycling** | AUTO-MERGE at threshold | AUTO-SPLIT when inventory low |
| **Price Filters** | Floor 5¢, Ceiling 95¢ | None |

---

## Core Concept: ISET (Inverse-SET)

An **ISET** is a trigger SELL order with a calculated hedge placed AFTER the trigger fills:

```
ISET = {
  trigger: SELL @ current ASK price (placed immediately)
  hedge:   SELL opposite side (placed AFTER trigger fills)
          Hedge price calculated to achieve target sell revenue
}

ISET_UP   = { trigger: SELL UP @ UP_ask, hedge: SELL DOWN (after fill) }
ISET_DOWN = { trigger: SELL DOWN @ DOWN_ask, hedge: SELL UP (after fill) }
```

---

## V2 Improvements

### 1. Time-Based Target Sell Revenue

Target sell revenue decreases as market approaches end (inverse of SET's pair cost which increases):

| Minute | Target | Profit Margin | Rationale |
|--------|--------|---------------|-----------|
| M0-M5  | $1.02  | 2¢ per pair   | Early window: require max profit margin |
| M5-M8  | $1.01  | 1¢ per pair   | Mid window: accept smaller margin |
| M8+    | $1.00  | 0¢ (breakeven)| Late window: priority is selling inventory |

```typescript
getTargetSellRevenue(): number {
  const minute = getCurrentMinute();
  if (minute < 5) return 1.02;
  if (minute < 8) return 1.01;
  return 1.00;
}
```

### 2. Capital-Aware ISET Sizing

ISET size is calculated based on available capital:

```
ISET size = 5% of capital
MIN = 5 shares (baseOrderSize)
MAX = 20 shares (maxOrderSize)
```

Example:
- $100 capital → 5 shares (5 × $1 = $5, capped at min)
- $300 capital → 15 shares (0.05 × $300 = $15)
- $1000 capital → 20 shares (capped at max)

### 3. Dynamic Cooldown

Cooldown between ISET placements scales with capital:

| Capital | Cooldown | Rationale |
|---------|----------|-----------|
| $0-200  | 15 seconds | Conservative for small accounts |
| $200-1000 | Linear 15s→2s | Gradual scale |
| $1000+  | 2 seconds | Aggressive for large accounts |

```typescript
getDynamicCooldown(): number {
  const capital = this.balance;
  if (capital <= 200) return 15;
  if (capital >= 1000) return 2;
  // Linear interpolation
  const t = (capital - 200) / (1000 - 200);
  return Math.round(15 - t * 13);
}
```

### 4. Critical Imbalance Threshold

When sales imbalance exceeds threshold, boost sizing to correct faster:

```
Critical threshold: 50 shares imbalance
Boost multiplier: 2x

Example:
  upSold = 100, downSold = 40
  imbalance = 60 > 50 (critical!)
  If placing DOWN trigger: size = baseSize × 2
```

### 5. DROP Detection with IOC Orders

When DROP is detected (price drops 5¢+ in 5 seconds on OTHER side), use IOC-like orders for immediate execution:

```
DROP Detection:
  1. Monitor rolling 5-second price window
  2. When OTHER side drops 5¢+: switch TO dropping side
  3. Use IOC order: sell at BID - 2¢ (aggressive, immediate fill)
  4. Record demand line (price before drop)
```

IOC orders ensure we sell BEFORE the price drops further.

### 6. Demand Line and Demand Break

**Demand line** = price ceiling before DROP (resistance level)

```
Demand line example:
  Before DROP: DOWN ask = $0.45
  DROP triggers, DOWN falls to $0.39
  demand_line = $0.45 (the resistance)

Demand break:
  If price rises ABOVE demand line → buyers restored
  Switch to OTHER side (breaking side no longer valid)
```

### 7. Zone Accumulation

After trigger fills, pre-place additional SELL orders at higher prices to capture price improvements:

```
Zone accumulation offsets: +2¢, +3¢, +5¢, +10¢, +15¢

Example:
  Trigger fills @ $0.52
  Zone orders placed at: $0.54, $0.55, $0.57, $0.62, $0.67
  Size: 1/3 of trigger size (min 3 shares)
```

When zone orders fill, hedge is recalculated to maintain target sell revenue.

### 8. Lifetime Position Tracking

Track cumulative positions across all markets (never reduced by MERGE):

```typescript
interface LifetimeSales {
  upSold: number;      // Never reset
  downSold: number;    // Never reset
  upRevenue: number;   // Never reset
  downRevenue: number; // Never reset
}
```

Used for accurate PnL tracking across multiple market windows.

### 9. Bilateral Hedge Calculation

Smart total sell calculation considering both sides:

```typescript
calculateBilateralSell(deficitSide, deficitBid): {
  // Project new averages after selling deficit
  if (deficitSide === 'UP') {
    newUpSold = upSold + salesDeficit;
    newUpRevenue = upRevenue + salesDeficit × deficitBid;
    projectedSellRevenue = (newUpRevenue / newUpSold) + avgDownSell;
  } else {
    // Mirror for DOWN
  }
  return { sellQty: salesDeficit, projectedSellRevenue };
}
```

### 10. Race Condition Guards

Prevent concurrent processing of ticks, orders, and DROP events:

```typescript
private isProcessingTick: boolean = false;
private isProcessingOrderUpdate: boolean = false;
private isProcessingDrop: boolean = false;

onTick(): void {
  if (this.isProcessingTick) return;
  this.isProcessingTick = true;
  try {
    // ... tick processing
  } finally {
    this.isProcessingTick = false;
  }
}
```

---

## Position-Aware ISET Calculation

ISET parameters (size and hedge price) are calculated dynamically based on:
1. Current sales state (upSold, downSold, upRevenue, downRevenue)
2. Available inventory (upInventory, downInventory)
3. Target sell revenue (time-based)
4. Capital-aware base size

```
calculateOptimalISET(triggerSide, triggerPrice, oppositeAsk):

  1. BASE SIZE:
     - Calculate capital-aware size (5% of capital, min 5, max 20)
     
  2. TRIGGER SIZE:
     - Start with base size
     - If deficit side = trigger side: boost size to close gap
     - If critical imbalance (>50 shares): apply 2x multiplier
     - Cap by available inventory

  3. HEDGE SIZE (Position-Aware):
     - projectedTriggerSold = triggerSold + triggerSize
     - hedgeSize = projectedTriggerSold - hedgeSold
     - Cap by available inventory

  4. HEDGE PRICE (Sales-Aware):
     - Calculate projected avg trigger after fill
     - Solve for min hedge price that achieves target sell revenue:

       projectedAvgTrigger = (triggerRevenue + triggerSize × triggerPrice) / (triggerSold + triggerSize)
       minAvgHedge = targetSellRevenue - projectedAvgTrigger
       hedgePrice = (minAvgHedge × newHedgeSold - hedgeRevenue) / hedgeSize
```

---

## Inventory Management: AUTO-SPLIT

Unlike SET strategy (which has USDC always available), Inverse-SET needs tokens from SPLIT before selling.

### Initial SPLIT

At strategy start, SPLIT based on balance:

```
Initial inventory calculation:
  available_usdc = balance × SPLIT_PERCENTAGE (default 50%)
  pairs_to_split = floor(available_usdc)
  
  After SPLIT:
    inventory.upQty = pairs_to_split
    inventory.downQty = pairs_to_split
```

### AUTO-SPLIT (Inverse of AUTO-MERGE)

When inventory runs low, SPLIT more pairs:

```
Check condition (every tick):
  min_inventory = min(inventory.upQty, inventory.downQty)
  
  If min_inventory < AUTO_SPLIT_THRESHOLD (default 20):
    1. Calculate SPLIT amount: floor(available_usdc × 0.5)
    2. Execute SPLIT: USDC → UP + DOWN tokens
    3. Update inventory
    4. Continue trading

Timing: AUTO-SPLIT happens BEFORE placing new ISETs
        (unlike AUTO-MERGE which happens after fills)
```

---

## DROP Detection (Inverse of SURGE)

Both strategies exploit the **equilibrium principle**: `UP + DOWN ≈ $1.00` always. When one side moves, the other moves inversely.

### What is a DROP?

A **DROP** is when one side's ask price falls 5¢+ within 5 seconds. Due to equilibrium, this means the OTHER side is RISING.

```
DROP Detection:
  Monitor: Rolling 5-second price window
  Trigger: Price DROPS >= 5¢ in 5 seconds on OTHER side
  Result:  Switch activeSide TO the dropping side
           Sell the dropping side BEFORE it gets cheaper (IOC order)
           Hedge on the rising side (now more expensive)
```

### DROP Example

```
Equilibrium: UP + DOWN = $1.00

Current: activeSide = UP (selling UP @ $0.55)
         DOWN ask = $0.45

Event:   DOWN drops from $0.45 → $0.39 in 5 seconds
         📉 DROP on OTHER side detected!
         
Analysis (equilibrium):
  - DOWN dropped to $0.39
  - UP must have risen to ~$0.61 (to maintain $1.00)
  
Action: Switch TO DOWN (the dropping side)
  1. IOC SELL DOWN @ $0.37 (bid-2¢, aggressive immediate fill)
  2. Place HEDGE to SELL UP @ $0.65+ (it's rising, expensive)
  
Result:
  - Trigger: SELL DOWN @ $0.37
  - Hedge:   SELL UP @ $0.65 (target revenue $1.02)
  - Revenue: $0.37 + $0.65 = $1.02 > $1.00 ✓
```

### Demand Line (Inverse of Supply Line)

```
Demand line = ask price before DROP started (the resistance)

When price RISES above demand line:
  - "Demand break" → sellers exhausted, price rising
  - Switch to OTHER side

Example:
  Before DROP: DOWN ask = $0.45
  DROP triggered: DOWN ask drops to $0.39
  demand_line = $0.45

  If DOWN recovers to $0.46 (above demand line):
    → Demand break! Switch back to UP
```

---

## ISET Lifecycle (V2)

```
1. ISET PLACED
   └─► SELL trigger order placed as GTC at ASK (or IOC for DROP)
   └─► Check inventory available
   └─► Added to activeISETs Map
   └─► Status: "pending"
   └─► Hedge NOT placed yet

2. TRIGGER FILLS
   └─► Detected via UserChannelWS (real) or Bid >= Limit (simulation)
   └─► ISET status → "trigger_filled"
   └─► CANCEL OPPOSITE ISET trigger
   └─► PLACE HEDGE SELL at calculated price
   └─► PLACE ZONE ACCUMULATION orders (+2¢, +3¢, +5¢, +10¢, +15¢)
   └─► Update inventory and sales

3. ZONE FILLS (optional)
   └─► Additional trigger-side sells at higher prices
   └─► Recalculate hedge price and size
   └─► Better average = lower hedge needed

4. HEDGE FILLS
   └─► ISET status → "completed"
   └─► Cancel remaining zone orders
   └─► Sales updated: pair sold, profit locked

5. ISET CANCELLED
   └─► Triggered when opposite ISET's trigger fills
   └─► All orders (trigger, hedge, zones) cancelled
   └─► Status: "cancelled"
```

---

## Strategy Logic Per Tick (V2)

```
On Each Price Update:
    │
    ├─► RACE GUARD: Skip if isProcessingTick
    │
    ├─► 1. CHECK AUTO-SPLIT (before trading)
    │       If min(inventory) < threshold → SPLIT more pairs
    │
    ├─► 2. SKIP STALE TICKS
    │       Skip if prices unchanged from last tick
    │
    ├─► 3. CHECK FOR DROP (with IOC)
    │       If OTHER side drops 5¢+ in 5s → switch activeSide
    │       Record demand line, cancel orders on old side
    │       Place IOC order on new side (bid-2¢)
    │
    ├─► 4. CHECK DEMAND BREAK
    │       If current ask > demand line → switch back
    │       Cancel orders on current side
    │
    ├─► 5. CHECK STALE TRIGGERS
    │       If ask < trigger - 2¢: cancel, enter STALE MODE
    │       Replace at ask-1¢ (more aggressive)
    │
    ├─► 6. CHECK PENDING ORDER FILLS
    │       Real: Via UserChannelWS orderUpdate events
    │       Sim:  Check if Bid >= Limit price
    │
    ├─► 7. PROCESS FILLS
    │       If trigger fills → Cancel opposite, place hedge + zones
    │       If zone fills → Recalculate hedge
    │       If hedge fills → Mark ISET completed, cancel zones
    │
    ├─► 8. ORDER FREEZE CHECK
    │       After M12: Stop placing new ISETs
    │
    ├─► 9. DYNAMIC COOLDOWN CHECK
    │        Skip if < cooldown since last ISET
    │        Cooldown: 15s ($0-200) to 2s ($1000+)
    │
    ├─► 10. CAPITAL-AWARE SIZING
    │        Calculate ISET size: 5% of capital (5-20 shares)
    │
    ├─► 11. SELL REVENUE CHECK
    │        Skip if trigger + hedge < target revenue
    │
    ├─► 12. INVENTORY CHECK
    │        Skip if not enough inventory to sell
    │
    └─► 13. PLACE NEW ISET (single active side)
            Only place ISET on current activeSide
            Position-aware sizing (boost if imbalanced)
```

---

## Total Sell Mechanism (V2)

When all remaining inventory can be sold profitably at current bid prices, execute **total sell**.

### Time-Based Thresholds

```
Before M8:  Use strict target ($1.02) - maximize profit
M8-M10:     Use moderate ($1.01) - smaller margin OK
M10-M12:    Use relaxed ($1.00) - accept breakeven
After M12:  Accept $0.98 (2¢ loss) - exit before settlement
```

### Bilateral Calculation

Uses `calculateBilateralSell()` to project exact revenue after selling deficit:

```typescript
const { sellQty, projectedSellRevenue } = calculateBilateralSell(deficitSide, deficitBid);

if (projectedSellRevenue >= threshold) {
  // Execute total sell
  cancelAllOrders();
  placeTotalSellOrder(deficitSide, sellQty, deficitBid);
}
```

---

## Configuration (V2)

### Environment Variables

```bash
# Inverse-SET Strategy Parameters (V2)
ISET_BASE_ORDER_SIZE=5       # Minimum shares per ISET (default: 5)
ISET_MAX_ORDER_SIZE=20       # Maximum shares per ISET (default: 20)
ISET_CAPITAL_PERCENT=0.05    # % of capital per ISET (default: 5%)
ISET_ORDER_FREEZE=12         # Stop new orders after this minute (default: M12)

# Inventory Settings
ISET_SPLIT_PERCENTAGE=0.50   # % of balance to SPLIT initially (default: 50%)
ISET_AUTO_SPLIT_THRESHOLD=20 # SPLIT more when inventory < this (default: 20)

# DROP Detection Settings
ISET_DROP_THRESHOLD=0.05     # Price drop to trigger (default: 5¢)
ISET_DROP_WINDOW_MS=5000     # Time window for detecting drop (default: 5s)
ISET_DROP_STABILIZE_MS=3000  # Stabilization time (default: 3s)

# Total Sell Settings
ISET_TOTAL_SELL_STOP=10      # Stop trading after total sell if minute > this

# Critical Imbalance
ISET_CRITICAL_IMBALANCE=50   # Shares imbalance to trigger boost
ISET_CRITICAL_MULTIPLIER=2   # Sizing multiplier when critical

# Simulation Only
SIM_INITIAL_BALANCE=1000     # Starting paper balance (default: $1000)
```

### Parameter Reference (V2)

| Parameter | Default | Description |
|-----------|---------|-------------|
| Base Order Size | 5 | Minimum shares per ISET |
| Max Order Size | 20 | Maximum shares per ISET |
| Capital Percent | 5% | Percentage of capital per ISET |
| Dynamic Cooldown | 15s-2s | Based on capital ($200→$1000) |
| Order Freeze | M12 | Stop placing new ISETs |
| Target Revenue | $1.02-$1.00 | Time-based (M0→M8) |
| Split Percentage | 50% | Initial balance to SPLIT |
| Auto-Split Threshold | 20 | SPLIT more when inventory below |
| Drop Threshold | 5¢ | Price drop to trigger DROP |
| Drop Window | 5s | Time window for detection |
| Critical Imbalance | 50 | Shares imbalance for boost |
| Critical Multiplier | 2x | Sizing boost when critical |
| Zone Offsets | +2,3,5,10,15¢ | Accumulation order offsets |

---

## Data Structures (V2)

```typescript
interface ISET {
  id: string;
  triggerSide: 'UP' | 'DOWN';
  triggerOrderId: string;
  triggerPrice: number;
  triggerTokenId: string;
  hedgeOrderId: string;
  hedgePrice: number;
  hedgeTokenId: string;
  status: 'pending' | 'trigger_filled' | 'completed' | 'cancelled';
  size: number;
  hedgeSize: number;
  createdAt: number;
  // Accumulation tracking
  totalTriggerQty: number;
  totalTriggerRevenue: number;
  lastAccumulationPrice: number;
  accumulationCount: number;
  // Zone orders (V2)
  zoneOrderIds: string[];
}

interface Inventory {
  upQty: number;
  downQty: number;
  totalSplitPairs: number;
}

interface Sales {
  upSold: number;
  downSold: number;
  upRevenue: number;
  downRevenue: number;
}

// Lifetime tracking (V2) - never reduced by merge
interface LifetimeSales {
  upSold: number;
  downSold: number;
  upRevenue: number;
  downRevenue: number;
}
```

---

## Commands

```bash
# Real Trading
npm run iset              # Start Inverse-SET strategy (real orders)

# Paper Trading
npm run iset:sim          # Start simulation (real prices, simulated execution)
```

---

## Strategy Summary (V2)

```
┌─────────────────────────────────────────────────────────────┐
│               INVERSE-SET STRATEGY v2                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  WIN CONDITION:                                             │
│    avg_UP_sell + avg_DOWN_sell > $1.00 = GUARANTEED PROFIT │
│                                                             │
│  V2 IMPROVEMENTS:                                           │
│    • Time-based target: $1.02 (M0-5) → $1.00 (M8+)         │
│    • Capital-aware sizing: 5% of capital per ISET          │
│    • Dynamic cooldown: 15s ($200) → 2s ($1000+)            │
│    • IOC orders for DROP (sell at bid-2¢)                  │
│    • Zone accumulation (+2¢, +3¢, +5¢, +10¢, +15¢)         │
│    • Critical imbalance: 2x sizing when >50 shares         │
│    • Lifetime tracking (never reset by merge)              │
│    • Bilateral hedge calculation                           │
│    • Race condition guards                                 │
│                                                             │
│  CORE CONCEPT: ISET                                         │
│    ISET = trigger SELL @ ask (hedge placed AFTER fill)     │
│    Hedge price = targetSellRevenue - avgTriggerPrice       │
│    activeSide init = more expensive side                   │
│    Switches on DROP or DEMAND BREAK                        │
│                                                             │
│  DROP MECHANISM:                                            │
│    Trigger: Price DROPS 5¢+ in 5s on OTHER side            │
│    Action:                                                  │
│      1. Switch activeSide TO dropping side                 │
│      2. IOC SELL at bid-2¢ (immediate)                     │
│      3. Record demand line (resistance)                    │
│      4. Hedge on rising side                               │
│                                                             │
│  ZONE ACCUMULATION:                                         │
│    After trigger fills, place zone orders:                 │
│      +2¢, +3¢, +5¢, +10¢, +15¢ above trigger               │
│    When zone fills → recalculate hedge                     │
│    Better avg trigger = lower hedge needed                 │
│                                                             │
│  DEMAND BREAK:                                              │
│    Trigger: Current ask rises above demand line            │
│    Action:  Switch to OTHER side                           │
│                                                             │
│  SAFETY GUARDS:                                             │
│    • isProcessingTick (race guard)                         │
│    • isProcessingOrderUpdate (race guard)                  │
│    • isProcessingDrop (race guard)                         │
│    • Single-side only (active side enforcement)            │
│    • Demand break guard (block old side same tick)         │
│    • Inventory check (can't sell without tokens)           │
│    • Dynamic cooldown (capital-based)                      │
│    • Sell revenue floor (time-based target)                │
│                                                             │
│  MARKET PHASES:                                             │
│    M-6 to M0: Initial SPLIT (create inventory)             │
│    M0-M5: Strict mode ($1.02 target)                       │
│    M5-M8: Moderate mode ($1.01 target)                     │
│    M8-M12: Relaxed mode ($1.00, accept breakeven)          │
│    M12-M15: Order freeze (existing stay active)            │
│    M15: Settlement + MERGE unsold pairs                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Differences from SET Strategy

| Feature | SET (BUY) | Inverse-SET (SELL) |
|---------|-----------|-------------------|
| Order type | Limit BUY @ BID | Limit SELL @ ASK |
| Fill condition (sim) | Ask <= Limit | Bid >= Limit |
| Target | pair_cost < $1 | sell_revenue > $1 |
| Momentum detection | SURGE (rise OTHER) | DROP (fall OTHER) |
| Reference line | Supply (support) | Demand (resistance) |
| Break condition | bid < supply | ask > demand |
| Init side | Cheaper side | More expensive side |
| Stale condition | bid > trigger + 2¢ | ask < trigger - 2¢ |
| Capital recycling | AUTO-MERGE | AUTO-SPLIT |
| IOC trigger | SURGE → buy at ask | DROP → sell at bid-2¢ |

---

*Document Version: v2.0 | Last Updated: 2026-01-02*
