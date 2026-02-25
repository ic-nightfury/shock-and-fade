# Arbitrage Strategy

Market-neutral arbitrage strategy for Polymarket BTC Up/Down 15-minute binary prediction markets.

---

## Win Condition

```
min(UP_qty, DOWN_qty) > total_cost = GUARANTEED PROFIT
```

**Why it works:** In a binary market, exactly one side pays $1 per share at settlement. By holding equal shares of both sides and paying less than $1 per pair, you profit regardless of outcome.

**Example:**
- Hold: 100 UP + 100 DOWN
- Total cost: $95
- Settlement: Winner pays $100 (either UP or DOWN wins)
- **Guaranteed profit: $5**

---

## Quick Start

```bash
# Production (real orders)
npm run arbitrage

# Simulation (paper trading with real prices)
npm run arb:sim
```

---

## Execution Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MARKET START                                 │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  INITIALIZATION PHASE (First 30 seconds)                            │
│  ─────────────────────────────────────────                          │
│  • Wait for prices in $0.40-$0.60 range                             │
│  • Allow up to 250 shares imbalance before triggering BALANCING     │
│  • Begin placing orders once in range                               │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     MODE SELECTION (Every Tick)                      │
│  ───────────────────────────────────────────────                    │
│  Priority: PROFIT_LOCK > BALANCING > PAIR_IMPROVEMENT > NORMAL      │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
┌───────────────┐    ┌──────────────────┐    ┌─────────────────────┐
│ PROFIT_LOCK   │    │   BALANCING      │    │ NORMAL /            │
│ ────────────  │    │   ──────────     │    │ PAIR_IMPROVEMENT    │
│ Buy deficit   │    │ Multi-cycle      │    │ ──────────────────  │
│ at ask to     │    │ trigger-hedge    │    │ Place multi-level   │
│ lock profit   │    │ to rebalance     │    │ orders, reactive    │
│               │    │                  │    │ fill updates        │
└───────┬───────┘    └────────┬─────────┘    └──────────┬──────────┘
        │                     │                         │
        ▼                     ▼                         ▼
┌───────────────┐    ┌──────────────────┐    ┌─────────────────────┐
│ MERGE PAIRS   │    │ Exit Conditions: │    │ Fill Detected:      │
│ via Builder   │    │ • Imb < 5%       │    │ • Update OTHER side │
│ Relayer       │    │ • PairCost ≥ $1  │    │   immediately       │
│               │    │   → PAIR_IMPROV  │    │ • Preserve filled   │
│               │    │                  │    │   side orders       │
└───────┬───────┘    └────────┬─────────┘    └──────────┬──────────┘
        │                     │                         │
        └─────────────────────┴─────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     STOP CONDITIONS CHECK                            │
│  ───────────────────────────────────────                            │
│  1. Market decided (price ≤$0.02 or ≥$0.98)                         │
│  2. Time + Profit (minute ≥ stopMinute AND profitable)              │
│  3. Capital + Profit (used ≥ 80% AND profitable)                    │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         MARKET END                                   │
│  ─────────────────────────────────                                  │
│  Cancel all orders, wait for settlement, redeem via Builder Relayer │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Strategy Modes

The strategy operates in one of four modes, checked every 3-10 seconds:

| Mode | Trigger | Purpose |
|------|---------|---------|
| **PROFIT_LOCK** | `newLockedPNL > lastLockedPNL && newLockedPNL > 0` | Balance position to lock guaranteed profit |
| **BALANCING** | Imbalance ≥ threshold AND ≥ `8 × coreSize` shares AND deficit ask > $0.50 | Rebalance using multi-cycle trigger-hedge |
| **PAIR_IMPROVEMENT** | After BALANCING when pair cost ≥ $1.00 but balanced | Recover cost by buying below averages |
| **NORMAL** | Default | Accumulate on both sides with dynamic depth |

**Priority:** PROFIT_LOCK > BALANCING > PAIR_IMPROVEMENT > NORMAL

---

## Mode Details

### 1. PROFIT_LOCK Mode

**Highest priority.** Checked on every price tick BEFORE any other mode execution.

**Trigger Logic:**
```typescript
// Cannot trigger if hedge order pending (mid-BALANCING)
if (hedgeOrderId && !hedgeFilled) return false;

// Calculate potential locked PNL if we buy deficit at ask
const deficitQty = abs(upQty - downQty);
const additionalCost = deficitQty * deficitAsk;
const newTotalCost = upCost + downCost + additionalCost;
const newHedged = min(upQty, downQty) + deficitQty;
const newLockedPNL = newHedged - newTotalCost;

// Trigger if: improvement over previous lock AND positive
if (newLockedPNL > lastLockedPNL && newLockedPNL > 0) {
  EXECUTE_PROFIT_LOCK();
}
```

**Key Point:** Compares against `lastLockedPNL` (best achieved), NOT current position PNL. This allows profit-locks even when current position is underwater.

**Execution Flow:**
```
┌─────────────────────────────────────────────────────────┐
│                   PROFIT_LOCK Execution                  │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │  Cancel all pending orders  │
              └──────────────┬──────────────┘
                             │
                             ▼
              ┌─────────────────────────────┐
              │  Buy deficit side at Ask+1c │
              │  (aggressive for instant    │
              │   fill)                     │
              └──────────────┬──────────────┘
                             │
                             ▼
              ┌─────────────────────────────┐
              │  Wait 2 seconds for fill    │
              └──────────────┬──────────────┘
                             │
                             ▼
              ┌─────────────────────────────┐
              │  Merge hedged pairs via     │
              │  Builder Relayer → $1/pair  │
              └──────────────┬──────────────┘
                             │
                             ▼
              ┌─────────────────────────────┐
              │  Reset lastLockedPNL = 0    │
              │  Increment profitLockCount  │
              │  resetBalancingState()      │
              │  (fresh start for next      │
              │   BALANCING trigger)        │
              └─────────────────────────────┘
```

**Critical:** After merge, `resetBalancingState()` clears all multi-cycle state (currentCycle, totalCycles, triggerLevelsCalculated, etc.) so the next BALANCING trigger starts fresh at "Cycle 1/X" instead of continuing from a stale state like "Cycle 3/8".

**After Merge Example:**
```
[PROFIT-LOCK] SUCCESS #1! Hedged=160, Cost=$157.52, Locked PNL=$2.48
[MERGE] Merging 160 hedged shares...
[MERGE] SUCCESS: Merged 160 → $160.00 USDC
```

---

### 2. BALANCING Mode (MICRO Trigger-Hedge)

**Trigger Conditions (ALL THREE required):**
```typescript
1. imbalanceRatio >= getDynamicImbalanceThreshold()
   OR absoluteImbalance >= 110 shares (hard cap)
2. absoluteImbalance >= minImbalanceThreshold (110 + buffer for small positions)
3. deficitSideAsk > $0.50  // Won't balance when deficit is cheap
4. If baseline exists: relativeImbalance >= 110 (prevents re-entry on same imbalance)
```

**Purpose:** Rebalance an imbalanced position using MICRO trigger-hedge approach: place small passive trigger orders at BID levels, and for each trigger fill, place a proportional hedge order.

---

#### MICRO BALANCING Execution Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    BALANCING Mode Entry                              │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 1: CALCULATE (Once on entry)                                 │
│  ─────────────────────────────────                                  │
│  calculateMicroBalancingParams():                                   │
│  • TARGET_PAIR_COST = $0.99 (always)                                │
│  • deficit = |upQty - downQty|                                      │
│  • X = dilution formula (see below)                                 │
│  • microTotalTriggerSize = deficit + X                              │
│  • microTotalHedgeSize = X                                          │
│  • microInitialHedgeTarget = X (cap for recalculation)              │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 2: CHECK FINAL MODE                                          │
│  ────────────────────────────                                       │
│  checkFinalTriggerHedge():                                          │
│  • If ASK >= threshold (0.99 - margin - 0.05): place final hedge    │
│  • Enabled by default (FINAL_THRESHOLD_BYPASS=false)                │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 3: CHECK EXIT                                                │
│  ───────────────────                                                │
│  shouldExitMicroBalancing():                                        │
│  • SUCCESS: deficit === 0 AND pairCost < $1.00                      │
│  • FORCED: triggerAsk <= $0.50 (no margin left)                     │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 4: UPDATE TRIGGERS (on BID movement)                         │
│  ─────────────────────────────────────────                          │
│  updateMicroTriggerOrders():                                        │
│  • On ANY BID movement: cancel ALL stale orders first               │
│  • UPWARD BREAKOUT: Place BID+1c ONLY if:                           │
│    - Price < $0.97                                                  │
│    - Position NOT lockable with pending hedges                      │
│  • Place 3 passive orders at tiered levels with hedgeTargets:       │
│    - BID:    hedgeTarget = $0.99                                    │
│    - BID-1c: hedgeTarget = $0.98                                    │
│    - BID-2c: hedgeTarget = $0.97                                    │
│  • Size via getBalancingTriggerSize(price, hedgeTarget)             │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 5: CHECK FINAL HEDGE                                         │
│  ─────────────────────────                                          │
│  checkAndPlaceFinalHedge():                                         │
│  • Condition: All triggers filled (microTriggerFilled >= total)     │
│  • Calculate hedgesNeeded = triggerQty - hedgeQty                   │
│  • Price = min(maxProfitPrice, hedgeAsk)                            │
│  • maxProfitPrice = (triggerQty - totalCost - pending) / needed     │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ON TRIGGER FILL → PLACE HEDGE (Phase 1/2)                          │
│  ─────────────────────────────────────────                          │
│  handleMicroTriggerFill():                                          │
│  • microTriggerFilled += fillSize                                   │
│  • hedgePrice = hedgeTarget - fillPrice (stored per trigger)        │
│  • PHASE LOGIC (critical):                                          │
│    Phase 1: triggerQty < hedgeQty → half hedge (catching up)        │
│    Phase 2: triggerQty >= hedgeQty → full hedge                     │
│    hedgeSize = isPhase1 ? ceil(fillSize/2) : fillSize               │
│  • actualHedgeSize = max(hedgeSize, minHedgeSize)                   │
│  • placeMicroHedge(hedgePrice, actualHedgeSize)                     │
│  • Restart 4s timer (resets countdown)                              │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ON HEDGE FILL → RECALCULATE SIZES                                  │
│  ────────────────────────────────                                   │
│  handleMicroHedgeFill():                                            │
│  • microHedgeFilled += fillSize                                     │
│  • recalculateMicroBalancingSizes():                                │
│    - FREEZE if triggers complete (prevent spiral)                   │
│    - Cap hedge target at balance (triggerQty - hedgeQty)            │
│    - Never exceed microInitialHedgeTarget (prevent growth)          │
│  • Check if profitable → trigger merge                              │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│  EXIT CONDITIONS                                                      │
│  ──────────────                                                       │
│  1. SUCCESS: deficit === 0 AND pairCost < $1.00                       │
│     → Save baseline, cancel orders, return to NORMAL                  │
│  2. FORCED: triggerAsk <= $0.50 (no margin left)                      │
│     → Save baseline, cancel orders, transition to PAIR_IMPROVEMENT    │
│                                                                       │
│  On Exit: exitMicroBalancing()                                        │
│    • Save baseline (upQty, downQty, imbalance)                        │
│    • Cancel all micro trigger and hedge orders                        │
│    • If pairCost >= $1.00 → PAIR_IMPROVEMENT                          │
│    • Else → NORMAL                                                    │
│                                                                       │
│  BASELINE: Prevents re-entry on same imbalance                        │
│  Future BALANCING only if: newImbalance >= baseline + 110             │
└───────────────────────────────────────────────────────────────────────┘
```

---

#### MICRO Calculation Details

```typescript
const TARGET_PAIR_COST = 0.99;  // Always $0.99

// Core calculation (once on entry)
const deficit = Math.abs(upQty - downQty);
const triggerSide = upQty < downQty ? 'UP' : 'DOWN';
const hedgeSide = triggerSide === 'UP' ? 'DOWN' : 'UP';

const triggerAsk = triggerSide === 'UP' ? upAsk : downAsk;

// Cost after filling deficit (at current ASK - conservative estimate)
const deficitCostAfterFill = deficitCost + deficit * triggerAsk;
const totalCostAfterDeficit = deficitCostAfterFill + surplusCost;
const basePairs = surplusQty;

// Max hedge price constraint
const maxHedgePrice = TARGET_PAIR_COST - triggerAsk;
const buffer = triggerAsk > 0.90 ? 0.02 : 0.05;  // Dynamic buffer
const hedgePrice = maxHedgePrice - buffer;

if (hedgePrice <= 0) return;  // Cannot balance - trigger too expensive

// Solve for X (dilution shares)
const numerator = TARGET_PAIR_COST * basePairs - totalCostAfterDeficit;
const denominator = triggerAsk + hedgePrice - TARGET_PAIR_COST;

if (denominator >= 0) return;  // Invalid - cannot calculate

const X = Math.ceil(numerator / denominator);

// Order sizes
if (X < 0) {
  // Position already better than target - just balance
  microTotalTriggerSize = deficit;
  microTotalHedgeSize = 0;
} else {
  microTotalTriggerSize = deficit + X;
  microTotalHedgeSize = X;
}

// Store initial target as cap
microInitialHedgeTarget = microTotalHedgeSize;
```

---

#### Hedge Price Calculations (Tiered Targets)

**Tiered hedgeTargets by trigger price level:**
```typescript
BID:    hedgeTarget = $0.99  →  hedgePrice = 0.99 - fillPrice
BID-1c: hedgeTarget = $0.98  →  hedgePrice = 0.98 - fillPrice
BID-2c: hedgeTarget = $0.97  →  hedgePrice = 0.97 - fillPrice
```

**High price cap:** If trigger price >= $0.96, cap hedgeTarget at $0.97 (minimum margin).

**Final Hedge (checkAndPlaceFinalHedge):**
```typescript
// Calculate exact max price for profit
maxProfitPrice = (triggerQty - totalCost - pendingHedgeCost) / hedgesNeeded
finalPrice = min(maxProfitPrice, hedgeAsk)

// Balance calculation
hedgesToBalance = triggerQty - hedgeQty
hedgesNeeded = hedgesToBalance - pendingHedgeQty
```

---

#### Trigger Size Calculation (getBalancingTriggerSize)

```typescript
private getBalancingTriggerSize(triggerPrice?: number, hedgeTarget = 0.99): number {
  const deficit = abs(upQty - downQty);
  const actualTriggerPrice = triggerPrice || (triggerBid + 0.01);  // BID+1c default
  const minTriggerSize = getMinSizeForPrice(actualTriggerPrice);  // Polymarket minimum

  // Expected hedge price based on target
  const expectedHedgePrice = round((hedgeTarget - actualTriggerPrice) * 100) / 100;
  const minHedgeSize = getMinSizeForPrice(expectedHedgePrice);

  // PHASE MULTIPLIER (critical fix):
  // Phase 1: triggerSideQty < hedgeSideQty → half-hedge → need 2x minHedgeSize
  // Phase 2: triggerSideQty >= hedgeSideQty → full hedge → need 1x minHedgeSize
  const triggerQty = triggerSide === 'UP' ? upQty : downQty;
  const hedgeQty = hedgeSide === 'UP' ? upQty : downQty;
  const isPhase1 = triggerQty < hedgeQty;
  const hedgeMultiplier = isPhase1 ? 2 : 1;
  const adjustedMinHedgeSize = minHedgeSize * hedgeMultiplier;

  // Ensure trigger size >= adjusted hedge minimum (NO max cap)
  const minSize = max(minTriggerSize, adjustedMinHedgeSize);

  let size = deficit > 0 ? max(ceil(deficit * 0.1), minSize) : max(coreSize, minSize);
  return max(size, minSize);  // Only enforce minimum, no cap
}
```

---

#### Level Size Scaling (getLevelSize)

Sizes scale linearly from 1× at SOT (start-of-trigger) to 3× at $0.50:

```typescript
private getLevelSize(price: number): number {
  // Linear interpolation: SOT → 1× baseSize, $0.50 → 3× baseSize
  const distanceFromSOT = this.microSOT - price;
  const totalDistance = this.microSOT - 0.50;

  if (totalDistance <= 0 || distanceFromSOT <= 0) {
    return this.microBaseSizeAtSOT;  // At or above SOT: 1×
  }

  const ratio = Math.min(1, distanceFromSOT / totalDistance);
  const sizeMultiplier = 1 + (2 * ratio);  // 1× to 3×
  const calculatedSize = Math.ceil(this.microBaseSizeAtSOT * sizeMultiplier);

  // BALANCING: Only enforce Polymarket minimum, NO max cap
  // (We WANT bigger sizes at lower prices to rebalance faster)
  const minSize = this.getMinSizeForPrice(price);
  return Math.max(calculatedSize, minSize);
}
```

**Example (SOT=$0.65, baseSize=10):**

| Price | Distance | Ratio | Multiplier | Size |
|-------|----------|-------|------------|------|
| $0.65 | 0 | 0 | 1.0× | 10 |
| $0.60 | 0.05 | 0.33 | 1.67× | 17 |
| $0.55 | 0.10 | 0.67 | 2.33× | 24 |
| $0.50 | 0.15 | 1.0 | 3.0× | 30 |

**Key:** No max cap - sizes scale freely to rebalance faster at lower prices.

---

#### Skip BID+1c When Lockable (isPositionLockableWithPendingHedges)

Prevents placing unnecessary BID+1c triggers when position is already lockable:

```typescript
private isPositionLockableWithPendingHedges(): boolean {
  // Project what position would be if all pending hedges fill
  let projectedHedgeQty = hedgeSideQty;
  let projectedHedgeCost = hedgeSideCost;

  for (each pending hedge order) {
    const remaining = order.size - order.filled;
    projectedHedgeQty += remaining;
    projectedHedgeCost += remaining * order.price;
  }

  // Check if balanced (within 5 shares)
  const projectedDeficit = abs(triggerQty - projectedHedgeQty);
  if (projectedDeficit > 5) return false;

  // Calculate projected pair cost
  const projectedPairCost = projectedTotalCost / projectedHedged;
  return projectedPairCost < 1.00;  // Lockable!
}
```

**Usage:**
- Timer callback (4s no-fill): Skip BID+1c if lockable
- Upward breakout: Skip BID+1c if lockable
- Passive orders (BID, BID-1c, BID-2c): Always placed

---

#### Freeze Logic (Prevents Hedge Spiral)

```typescript
// In recalculateMicroBalancingSizes():
// Once triggers complete, FREEZE hedge target to prevent spiral
if (microTriggerFilled >= microTotalTriggerSize && microTotalTriggerSize > 0) {
  const triggerQty = triggerSide === 'UP' ? upQty : downQty;
  const hedgeQty = hedgeSide === 'UP' ? upQty : downQty;

  // Cap hedges at BALANCE target (not dilution target)
  const hedgesStillNeeded = Math.max(0, triggerQty - hedgeQty);
  const maxHedgeTarget = microHedgeFilled + hedgesStillNeeded;

  if (microTotalHedgeSize > maxHedgeTarget) {
    microTotalHedgeSize = maxHedgeTarget;  // Cap it
  }
  return;  // Don't recalculate - frozen
}
```

**Why this matters:** Without freeze, hedge fills could flip the deficit direction (hedgeQty > triggerQty), causing X to grow infinitely.

---

#### MICRO Pricing Example

```
Starting position: UP=100, DOWN=300 (deficit=200 UP, triggerSide=UP, hedgeSide=DOWN)
Phase 1: triggerQty(100) < hedgeQty(300) → HALF HEDGE

BID = $0.70 → Place triggers at (with tiered hedgeTargets):
  - $0.70 (BID):    hedgeTarget=$0.99, size via getBalancingTriggerSize
  - $0.69 (BID-1c): hedgeTarget=$0.98
  - $0.68 (BID-2c): hedgeTarget=$0.97

Trigger fills 20 @ $0.70:
  hedgeTarget = $0.99 (stored with order)
  hedgePrice = 0.99 - 0.70 = $0.29

  Phase 1 check: triggerQty(120) < hedgeQty(300) → still Phase 1
  hedgeSize = ceil(20/2) = 10 (HALF HEDGE)
  minHedgeSize = getMinSizeForPrice(0.29) = 5
  actualHedgeSize = max(10, 5) = 10
  → Place hedge: 10 DOWN @ $0.29

After more triggers fill (UP=350, DOWN=300):
  Phase 2 check: triggerQty(350) >= hedgeQty(300) → Phase 2 (FULL HEDGE)
  hedgeSize = fillSize (no halving)
```

**Key Insight:**
- Phase 1 (catching up): Half-hedge to avoid over-hedging while rebalancing
- Phase 2 (balanced): Full hedge once trigger side caught up
- BID+1c only placed on upward breakout or timer if NOT already lockable

---

### 3. PAIR_IMPROVEMENT Mode

**Trigger:** Entered from BALANCING when position is balanced but pair cost ≥ $1.00

**Purpose:** Recover from over-cost position by buying BOTH sides at prices BELOW their respective averages.

**Difference from NORMAL:** Uses tighter spread (`bid - 0.02` instead of `bid - losses`) and filters to only place at prices below average.

**Order Placement (same structure as NORMAL):**
```typescript
// Max 3 orders per side with 1.3x scaling
const depth = 3;

// Starting price uses avg comparison instead of inventory skew
for each side:
  startPrice = bid - 0.02;  // Tighter than NORMAL

// CRITICAL FILTER: Only place orders BELOW average cost
for UP side:
  price < upAvg && price <= getMaxPriceForSide('UP')

for DOWN side:
  price < downAvg && price <= getMaxPriceForSide('DOWN')

// Price-based 1.3x size scaling (per 1c below avg)
sizeMultiplier = 1.3 ^ centsBelow(avg)

At avg:     coreSize × 1.0
1c below:   coreSize × 1.3
2c below:   coreSize × 1.69
3c below:   coreSize × 2.20
```

**Exit Condition:** Pair cost drops below $1.00 → Return to NORMAL

---

### 4. NORMAL Mode

**Default mode** when not in PROFIT_LOCK, BALANCING, or PAIR_IMPROVEMENT.

**Purpose:** Accumulate shares on both sides while maintaining balance and keeping pair cost < $1.00.

---

#### NORMAL Mode Order Placement Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    NORMAL Mode Execution                             │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 1: Max 3 Orders Per Side                                      │
│  ───────────────────────────────                                    │
│  • Fixed depth = 3 bids per side                                    │
│  • Calculate starting price using Avellaneda inventory skew:        │
│    - Deficit side: starts at bid (aggressive)                       │
│    - Surplus side: starts at bid - 1c (conservative)                │
│  • Loss adjustment: startPrice -= max(0, pairCost - 1)              │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 2: Calculate Price Levels (3 levels, 1c apart)                │
│  ────────────────────────────────────────────────────               │
│  for level = 0 to 2:                                                │
│    price = startPrice - level × 0.01                                │
│    if (price < 0.05) break;  // Floor                               │
│    if (price <= maxPriceForSide) {                                  │
│      desiredPrices.set(price, level);  // Track level for sizing    │
│    }                                                                │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 3: Place Orders with Price-Based Size Scaling                 │
│  ────────────────────────────────────────────────────               │
│  for each (price, levelIndex) in desiredPrices:                     │
│    centsBelow = (avg - price) * 100                                 │
│    sizeMultiplier = min(1.1 ^ centsBelow, 3.0)  // Capped at 3.0x   │
│    orderSize = ceil(coreSize × sizeMultiplier)                      │
│                                                                     │
│  Example (coreSize=10, price 2c below avg):                         │
│    sizeMultiplier = 1.1^2 = 1.21                                    │
│    orderSize = ceil(10 × 1.21) = 13 shares                          │
│                                                                     │
│  IMPORTANT: Multiplier capped at 3.0x to prevent size explosion     │
│  when price is far from average (e.g., avg $0.61 → order $0.30      │
│  would be 31c = 1.1^31 = 19x without cap!)                          │
│                                                                     │
│  NOTE: PAIR_IMPROVEMENT uses 1.3x (aggressive) vs NORMAL 1.1x       │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 4: Reactive Fill Handling                                     │
│  ──────────────────────────────                                     │
│  • When order fills, immediately execute NORMAL mode again          │
│  • Place orders on BOTH sides to maintain 3 bids each               │
│  • Filled side gets replenished, other side gets recalculated       │
└─────────────────────────────────────────────────────────────────────┘
```

---

#### Loss Adjustment

When position is underwater, orders shift down to accumulate at better prices:

```typescript
const losses = Math.max(0, pairCost - 1);
const startPrice = bid - losses;

// Example (underwater by $0.05):
// UP bid: $0.55
// Losses: $0.05 (pair cost $1.05)
// UP orders placed at: $0.50, $0.49, $0.48...
// (shifted down from bid)
```

---

## Reactive Filling Mechanism

The strategy uses **fill-reactive order placement** to respond immediately to market fills.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    REACTIVE FILL FLOW                                │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
              ┌─────────────────────────────┐
              │  Order Fill Detected        │
              │  (limit price ≥ currentAsk) │
              └──────────────┬──────────────┘
                             │
           ┌─────────────────┴─────────────────┐
           │                                   │
           ▼                                   ▼
┌──────────────────────┐         ┌───────────────────────────┐
│  NORMAL/PAIR_IMPROV  │         │  BALANCING MODE           │
│  ─────────────────── │         │  ──────────────           │
│  • Record which side │         │  • Trigger fill: advance  │
│    filled            │         │    to HEDGE phase         │
│  • Execute mode      │         │  • Hedge fill: advance to │
│    immediately       │         │    next cycle             │
│  • Update OTHER side │         │  • Reversal fill: recalc  │
│    only              │         │    hedge price            │
│  • Skip filled side  │         │                           │
│    (preserve orders) │         │                           │
└──────────────────────┘         └───────────────────────────┘
```

**Key Benefits:**
1. **Faster response**: No waiting for next tick cycle
2. **Better prices**: Preserve filled side orders (they're at good price levels)
3. **Balanced accumulation**: Only update opposite side to maintain balance

---

## Core Size Mechanism

Core size is the base order quantity, dynamically adjusted based on time and profit-lock count.

```typescript
// Base calculation
let base = Math.max(config.baseSize, Math.floor(balance / 30));
base = Math.min(base, MAX_CORE_SIZE);  // Cap at 32

// Time decay: After M6, decrease 20% per minute
if (minute >= 6) {
  base *= Math.pow(0.8, minute - 6);
}

// Profit-lock decay: 30% reduction per successful lock
if (profitLockCount > 0) {
  base *= Math.pow(0.7, profitLockCount);
}

return Math.max(1, Math.floor(base));  // Minimum 1 share
```

**Core Size Examples (base=10):**

| Minute | Profit Locks | Calculation | Result |
|--------|--------------|-------------|--------|
| M5 | 0 | 10 | 10 |
| M6 | 0 | 10 | 10 |
| M7 | 0 | 10 × 0.8 | 8 |
| M8 | 0 | 10 × 0.8² | 6 |
| M6 | 1 | 10 × 0.7 | 7 |
| M7 | 1 | 10 × 0.8 × 0.7 | 5 |
| M8 | 2 | 10 × 0.8² × 0.7² | 3 |

---

## Dynamic Check Interval

The strategy tick interval adjusts based on mode and balance:

```typescript
// BALANCING mode: Fast 1-second intervals
if (mode === 'BALANCING') return 1000;

// Otherwise: Scale with balance
if (balance < 150) return 10000;    // 10s - small balance, slow polling
if (balance < 300) return 7000;     // 7s
if (balance < 500) return 5000;     // 5s
return 3000;                        // 3s - larger balance, fast polling
```

| Balance | Mode | Interval |
|---------|------|----------|
| Any | BALANCING | 1 second |
| < $150 | Other | 10 seconds |
| $150-$300 | Other | 7 seconds |
| $300-$500 | Other | 5 seconds |
| > $500 | Other | 3 seconds |

---

## Initialization Phase Price Range

During the first fill of a market, orders are restricted to a safe price range:

```typescript
// Before first fill: Enforce $0.30-$0.85 price range
if (!hasFirstFill) {
  // Skip prices outside safe range
  if (price < 0.30 || price > 0.85) continue;
}
// After first fill in allowed range: Trade at any price
```

**Purpose:** Prevents large losses from entering at extreme prices when a new market starts. Once a fill occurs within the $0.30-$0.85 range, this restriction is lifted.

---

## Dynamic Imbalance Threshold

Position size determines how strict the imbalance trigger is:

```typescript
if (totalShares <= 0) return 1.0;   // 100% - no shares, no balancing
if (totalShares <= 500) {
  return 1.0 - (0.70 * totalShares / 500);  // Linear: 100% → 30%
}
if (totalShares <= 2000) {
  return 0.30 - (0.25 * (totalShares - 500) / 1500);  // Linear: 30% → 5%
}
return 0.05;  // Floor at 5% for large positions
```

| Total Shares | Threshold | Behavior |
|--------------|-----------|----------|
| 0 | 100% | No balancing on empty position |
| 100 | 86% | Very loose - building initial position |
| 250 | 65% | Loose - still accumulating |
| 500 | 30% | Moderate - position established |
| 1000 | 17.5% | Tight - larger position |
| 2000+ | 5% | Strict floor |

**Initialization Phase (first 30s):**
- Allow up to 250 shares imbalance before triggering BALANCING
- Returns 1.0 threshold if imbalance < 250

---

## Order Depth (Fixed at 3 Per Side)

Both NORMAL and PAIR_IMPROVEMENT modes use a fixed depth of 3 orders per side.

```typescript
const depth = 3;  // Fixed - not calculated from threshold

// Buffer for small positions (< 500 shares)
const absoluteThreshold = 110;  // Fixed threshold
let minImbalanceThreshold = absoluteThreshold;
if (currentTotal < 500) {
  const buffer = Math.ceil((500 - currentTotal) / 500 * coreSize * 2);
  minImbalanceThreshold = absoluteThreshold + buffer;
}
```

**Key Points:**
- Depth is always 3 orders per side (not dynamically calculated)
- Orders use 1.3x size scaling per level
- BALANCING triggers at 110 shares absolute imbalance (plus buffer for small positions)

---

## getMaxPriceForSide

Hard cap on order prices to ensure pair cost stays below target.

```typescript
const target = 0.99;  // Hard cap

for UP side:
  downProxy = (downAvg > 0) ? downAvg : downBid;
  maxPrice = Math.round((target - downProxy) * 100) / 100 - 0.01;  // 1c buffer
  return Math.max(0.05, maxPrice);

for DOWN side:
  upProxy = (upAvg > 0) ? upAvg : upBid;
  maxPrice = Math.round((target - upProxy) * 100) / 100 - 0.01;  // 1c buffer
  return Math.max(0.05, maxPrice);
```

**Example:**
- UP average = $0.60 → maxPrice(DOWN) = 0.99 - 0.60 - 0.01 = **$0.38**
- Any DOWN order at price > $0.38 would be skipped

---

## Market Exit Conditions

```
┌─────────────────────────────────────────────────────────────────────┐
│                     STOP CONDITION CHECK                             │
│  ─────────────────────────────────────                              │
│                                                                      │
│  1. MARKET DECIDED                                                   │
│     • UP or DOWN bid ≤ $0.02 OR ≥ $0.98                             │
│     • Exception: Don't stop if BALANCING hedge is pending           │
│                                                                      │
│  2. TIME + PROFIT                                                    │
│     • Current minute ≥ stopMinute (default M8)                      │
│     • AND isProfitable() = true                                      │
│                                                                      │
│  3. CAPITAL + PROFIT                                                 │
│     • Capital used ≥ maxCapitalPct (default 80%)                    │
│     • AND isProfitable() = true                                      │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

isProfitable():
  hedged = min(upQty, downQty);
  totalCost = upCost + downCost;
  return hedged > totalCost;
```

---

## Balancing Target Pair Cost

Dynamic based on market minute:

```typescript
M0-6:    $0.99  // Conservative (1% profit margin) - early market, cautious
M6-10:   $0.98  // Moderate (2% profit margin)
M10+:    $0.97  // Aggressive (3% profit margin) - late market, more confident
```

---

## Imbalance Threshold Multiplier

The imbalance threshold can be dynamically adjusted to make it harder to trigger BALANCING mode:

```typescript
// State
imbalanceThresholdMultiplier: number = 1.0;  // Default
pairImprovementCount: number = 0;  // Track entries since last profit lock

// Only apply 2x multiplier on 2nd+ PAIR_IMPROVEMENT entry
if (mode === 'PAIR_IMPROVEMENT' && lastMode !== 'PAIR_IMPROVEMENT') {
  pairImprovementCount++;
  if (pairImprovementCount >= 2) {
    imbalanceThresholdMultiplier = 2;  // Makes it harder to re-enter BALANCING
  }
}

// Resets to 1x after profit lock + merge
if (profitLockSuccess && mergeSuccess) {
  imbalanceThresholdMultiplier = 1.0;
  pairImprovementCount = 0;  // Reset counter
}

// Applied in getDynamicImbalanceThreshold():
return Math.min(1.0, baseThreshold * imbalanceThresholdMultiplier);
```

**Effect:** On the first PAIR_IMPROVEMENT entry, threshold stays at 1x. On 2nd+ entry before profit lock, threshold doubles (e.g., 5% → 10%), making it harder to trigger BALANCING mode repeatedly.

---

## State Variables

```typescript
// Position
stats: {
  upQty: number;    // UP shares held
  upCost: number;   // USD spent on UP
  downQty: number;  // DOWN shares
  downCost: number; // USD spent on DOWN
}

// Profit tracking
lastLockedPNL: number;      // Best locked PNL achieved
profitLockCount: number;    // Successful profit-locks (affects coreSize)
imbalanceThresholdMultiplier: number;  // 1.0 default, 2x on 2nd+ PAIR_IMPROVEMENT entry
pairImprovementCount: number;  // Tracks PAIR_IMPROVEMENT entries since last profit lock

// Mode state
lastMode: StrategyMode;
hedgeOrderId: string;       // Protected from cleanup
triggerOrderId: string;     // Protected from cleanup

// MICRO BALANCING state
microTargetPairCost: number;        // Target pair cost (always $0.99)
microTotalTriggerSize: number;      // Total triggers needed (deficit + X)
microTotalHedgeSize: number;        // Total hedges needed (X)
microInitialHedgeTarget: number;    // Cap for hedge increases

microTriggerFilled: number;         // Cumulative trigger fills
microHedgeFilled: number;           // Cumulative hedge fills
microHedgeOrdered: number;          // Total hedge shares ordered
microHedgeFractional: number;       // Fractional hedge accumulator

microTriggerOrders: Map<string, MicroOrder>;  // Pending trigger orders
microHedgeOrders: Map<string, MicroOrder>;    // Pending hedge orders

triggerSide: 'UP' | 'DOWN';         // Side buying triggers
hedgeSide: 'UP' | 'DOWN';           // Side buying hedges
lastMicroTriggerBid: number;        // For BID movement detection
finalModeTriggered: boolean;        // Final mode executed once
microModeActive: boolean;           // MICRO mode active flag

// Baseline tracking (prevents infinite re-entry)
baselineUpQty: number;      // Snapshot of upQty after BALANCING
baselineDownQty: number;    // Snapshot of downQty after BALANCING
baselineImbalance: number;  // Absolute imbalance at baseline

// Reactive filling
lastFilledSide: 'UP' | 'DOWN' | null;

// Computed
pairCost = upAvg + downAvg;
hedgedPairs = min(upQty, downQty);
imbalanceRatio = abs(upQty - downQty) / (upQty + downQty);
profit = hedgedPairs - totalCost;
```

---

## Key Functions Summary

| Function | Purpose | Location |
|----------|---------|----------|
| `getMode()` | Determines current strategy mode | ArbitrageSimulation.ts:913 |
| `getDynamicImbalanceThreshold()` | Calculates when BALANCING triggers | ArbitrageSimulation.ts:800 |
| `getCoreSize()` | Base order size with time/lock decay | ArbitrageSimulation.ts:2206 |
| `getMaxPriceForSide()` | Price cap to keep pair cost < $0.99 | ArbitrageSimulation.ts:2259 |
| `shouldStop()` | Exit conditions | ArbitrageSimulation.ts:904 |
| `executeNormalMode()` | Place accumulation orders | ArbitrageSimulation.ts:1230 |
| `executeBalancingMode()` | MICRO trigger-hedge orchestration | ArbitrageSimulation.ts:1633 |
| `executePairImprovementMode()` | Cost recovery orders | ArbitrageSimulation.ts:1894 |
| `checkProfitLockOpportunity()` | Detect profit-lock trigger | ArbitrageSimulation.ts:939 |
| **MICRO BALANCING Functions** | | |
| `calculateMicroBalancingParams()` | Calculate X, total sizes | ArbitrageSimulation.ts:2163 |
| `updateMicroTriggerOrders()` | Place tiered trigger bids at BID/BID-1c/BID-2c | ArbitrageSimulation.ts:2573 |
| `getBalancingTriggerSize()` | Calculate size with Phase 1/2 multiplier | ArbitrageSimulation.ts:2268 |
| `getLevelSize()` | Linear size scaling (1× at SOT → 3× at $0.50) | ArbitrageSimulation.ts:2240 |
| `isPositionLockableWithPendingHedges()` | Skip BID+1c when lockable | ArbitrageSimulation.ts:2406 |
| `placeMicroTrigger()` | Place single trigger order | ArbitrageSimulation.ts:2441 |
| `placeMicroHedge()` | Place hedge for filled triggers | ArbitrageSimulation.ts:2517 |
| `handleMicroTriggerFill()` | Process fill with Phase 1/2 hedge sizing | ArbitrageSimulation.ts:2980 |
| `handleMicroHedgeFill()` | Process hedge fill | ArbitrageSimulation.ts:3021 |
| `startBalancingTimer()` | 4s timer: BID+1c + refill on no-fill | ArbitrageSimulation.ts:2307 |
| `stopBalancingTimer()` | Stop timer (market exit/mode exit) | ArbitrageSimulation.ts:2357 |
| `checkAndPlaceFinalHedge()` | Final hedge at balance price | ArbitrageSimulation.ts:2627 |
| `exitMicroBalancing()` | Cleanup and save baseline | ArbitrageSimulation.ts:2935 |
| `cleanupMarket()` | Stop timer + clear microModeActive | ArbitrageSimulation.ts:750 |

---

## Configuration

```env
ARB_BASE_FREQUENCY=5000         # Check interval base (ms)
ARB_BASE_SIZE=5                 # Base shares per trade
ARB_STOP_MINUTE=8               # Stop after this minute if profitable
ARB_MAX_CAPITAL_PCT=0.80        # Stop if capital > 80% used
ARB_TARGET_PAIR_COST=0.98       # Target pair cost (for HEDGE mode)
ARB_INVENTORY_IMPACT=0.04       # Avellaneda adjustment (4c)

# Simulation
SIM_INITIAL_BALANCE=1000        # Paper trading starting balance
```

**Hard-Coded Constants:**
- MAX_CORE_SIZE = 32
- PRICE_FLOOR = $0.05
- TARGET_PAIR_COST = $0.99 (MICRO BALANCING)
- ABSOLUTE_IMBALANCE_THRESHOLD = 110 shares
- BALANCE_EXIT_THRESHOLD = 5%
- INITIALIZATION_PHASE = 30 seconds
- MICRO Trigger Levels: BID, BID-1c, BID-2c (passive), BID+1c (on breakout/timer)
- MICRO hedgeTargets: $0.99 (BID), $0.98 (BID-1c), $0.97 (BID-2c)
- Timer interval: 4 seconds (no-fill → place BID+1c + refill)
- Phase 1 multiplier: 2x (trigger size must cover half-hedge minimum)

---

## Files

| File | Purpose |
|------|---------|
| `src/strategies/ArbitrageStrategy.ts` | Production strategy |
| `src/strategies/ArbitrageSimulation.ts` | Simulation strategy |
| `src/services/MergeClient.ts` | Builder Relayer merge API |
| `docs/ARBITRAGE_STRATEGY.md` | This documentation |
| `references/ARBITRAGE_HEDGE.md` | Dilute-balance formula derivation |

---

## Production vs Simulation Differences

Both production and simulation use identical MICRO BALANCING logic:

| Aspect | Both Strategies |
|--------|-----------------|
| Mode name | 'BALANCING' |
| Approach | MICRO trigger-hedge with Phase 1/2 |
| Trigger levels | BID, BID-1c, BID-2c (passive) + BID+1c (chase) |
| hedgeTargets | $0.99, $0.98, $0.97 (tiered by price level) |
| Phase 1 hedge | Half size when triggerQty < hedgeQty |
| Phase 2 hedge | Full size when triggerQty >= hedgeQty |
| Timer | 4s no-fill → BID+1c + refill (if not lockable) |
| Skip BID+1c | When position lockable with pending hedges |
| Market exit cleanup | Stop timer + clear microModeActive |
| Entry threshold | ≥ 110 shares + buffer |

---

*Last Updated: 2026-01-16 (getLevelSize: removed max cap for proper linear scaling 1× → 3×)*
