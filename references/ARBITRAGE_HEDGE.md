# Arbitrage Hedge Formula (MICRO BALANCING)

The MICRO balancing strategy rebalances an imbalanced position using small passive trigger orders at BID levels, with proportional hedge orders placed as triggers fill. This minimizes upfront commitment risk compared to multi-cycle approaches.

---

## Problem Statement

You have an imbalanced position:
- **Surplus side:** Has more shares (e.g., DOWN with 300 shares)
- **Deficit side:** Has fewer shares (e.g., UP with 100 shares)
- **Goal:** Rebalance while achieving target pair cost ($0.99)

**Solution:** Place small passive trigger bids at tiered levels, hedge proportionally as triggers fill, ensure final balance with profitable price calculation.

---

## Win Condition Reminder

```
min(UP_qty, DOWN_qty) > total_cost = GUARANTEED PROFIT
```

MICRO BALANCING achieves this by:
1. Filling the deficit incrementally (tiered bids)
2. Adding X dilution shares to improve pair cost
3. Hedging proportionally as each trigger fills
4. Freezing hedge target once triggers complete (prevent spiral)
5. Placing final hedge at balance-based price

---

## Core Principle: Proportional Hedging

**Each trigger fill spawns a proportional hedge order. The hedge ratio is calculated once at entry and maintained throughout.**

```
hedgeRatio = microTotalHedgeSize / microTotalTriggerSize
hedgesPerFill = floor(fillSize × hedgeRatio + fractionalAccumulator)
hedgePrice = TARGET - avgTriggerPrice - 0.05  // 5c buffer for profit
```

**Example:**
```
Total triggers needed: 540
Total hedges needed (X): 340
hedgeRatio = 340 / 540 = 0.63

Trigger fills 10 @ $0.71:
  → hedgesToPlace = floor(10 × 0.63) = 6
  → hedgePrice = 0.99 - 0.71 - 0.05 = $0.23
  → Place hedge: 6 @ $0.23
```

---

## MICRO Trigger-Hedge Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                    BALANCING ENTRY                                   │
│  ─────────────────────────────                                      │
│  Conditions:                                                         │
│  1. imbalanceRatio >= dynamicThreshold OR absoluteImbalance >= 110  │
│  2. absoluteImbalance >= minImbalanceThreshold (110 + buffer)       │
│  3. deficitAsk > $0.50                                              │
│  4. If baseline: relativeImbalance >= 110 (vs baseline)             │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  CALCULATION PHASE (Once on entry)                                  │
│  ──────────────────────────────────                                 │
│  calculateMicroBalancingParams():                                   │
│                                                                      │
│  1. TARGET_PAIR_COST = $0.99 (always)                               │
│                                                                      │
│  2. Calculate max hedge price:                                       │
│     maxHedgePrice = TARGET - triggerAsk                             │
│     buffer = triggerAsk > 0.90 ? 0.02 : 0.05  // Dynamic            │
│     hedgePrice = maxHedgePrice - buffer                             │
│     If hedgePrice <= 0: ABORT (cannot balance)                      │
│                                                                      │
│  3. Solve for X (dilution shares):                                   │
│     numerator = TARGET × basePairs - totalCostAfterDeficit          │
│     denominator = triggerAsk + hedgePrice - TARGET                  │
│     X = ceil(numerator / denominator)                               │
│                                                                      │
│  4. Order sizes:                                                     │
│     microTotalTriggerSize = deficit + X                             │
│     microTotalHedgeSize = X                                         │
│     microInitialHedgeTarget = X  (cap for recalculation)            │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  UPDATE TRIGGERS (on BID movement)                                  │
│  ─────────────────────────────────                                  │
│  updateMicroTriggerOrders():                                        │
│                                                                      │
│  • ONLY place/update on UPWARD breakout (chase behavior)            │
│  • When BID moves DOWN → keep existing orders (don't place new)     │
│  • Clear ALL triggers on upward breakout (single set at a time)     │
│                                                                      │
│  Tiered levels:                                                      │
│    BID+1c:  coreSize (chase on breakout)                            │
│    BID:     2% of totalTriggerSize                                  │
│    BID-5c:  5% of totalTriggerSize                                  │
│    BID-15c: 8% of totalTriggerSize                                  │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ON TRIGGER FILL → PROPORTIONAL HEDGE                               │
│  ────────────────────────────────────                               │
│  handleMicroTriggerFill():                                          │
│                                                                      │
│  1. Track fill: microTriggerFilled += fillSize                      │
│                                                                      │
│  2. Calculate proportional hedge:                                    │
│     hedgeRatio = microTotalHedgeSize / microTotalTriggerSize        │
│     microHedgeFractional += fillSize × hedgeRatio                   │
│     hedgesToPlace = floor(microHedgeFractional)                     │
│                                                                      │
│  3. Calculate hedge price (for profit):                              │
│     avgTriggerPrice = unhedgedTriggerCost / unhedgedTriggerQty      │
│     hedgePrice = TARGET - avgTriggerPrice - 0.05                    │
│                                                                      │
│  4. Place hedge: placeMicroHedge(hedgePrice, hedgesToPlace)         │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ON HEDGE FILL → RECALCULATE & CHECK                                │
│  ───────────────────────────────────                                │
│  handleMicroHedgeFill():                                            │
│                                                                      │
│  1. Track fill: microHedgeFilled += fillSize                        │
│                                                                      │
│  2. recalculateMicroBalancingSizes():                               │
│     • FREEZE if triggers complete (prevent spiral)                  │
│       triggerQty - hedgeQty = hedgesStillNeeded                     │
│       Cap microTotalHedgeSize at microHedgeFilled + hedgesStillNeeded│
│     • Never exceed microInitialHedgeTarget                          │
│                                                                      │
│  3. Check profit lock opportunity                                    │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  CHECK FINAL HEDGE (when triggers complete)                         │
│  ──────────────────────────────────────────                         │
│  checkAndPlaceFinalHedge():                                         │
│                                                                      │
│  Condition: microTriggerFilled >= microTotalTriggerSize             │
│                                                                      │
│  1. Calculate balance target:                                        │
│     hedgesToBalance = triggerQty - hedgeQty                         │
│     hedgesNeeded = hedgesToBalance - pendingHedgeQty                │
│                                                                      │
│  2. Calculate max profit price:                                      │
│     maxProfitPrice = (triggerQty - totalCost - pending) / needed    │
│     finalPrice = min(maxProfitPrice, hedgeAsk)                      │
│                                                                      │
│  3. If no profit possible: use hedgeAsk (accept loss to balance)    │
│                                                                      │
│  4. Place final hedge at finalPrice                                  │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  EXIT CONDITIONS                                                    │
│  ──────────────                                                     │
│  shouldExitMicroBalancing():                                        │
│                                                                      │
│  1. SUCCESS: deficit === 0 AND pairCost < $1.00                     │
│     → Save baseline, cancel orders, return to NORMAL                │
│                                                                      │
│  2. FORCED: triggerAsk <= $0.50 (no margin left)                    │
│     → Save baseline, cancel orders, PAIR_IMPROVEMENT                │
│                                                                      │
│  On Exit: exitMicroBalancing()                                       │
│    • baselineUpQty = upQty                                          │
│    • baselineDownQty = downQty                                      │
│    • baselineImbalance = |upQty - downQty|                          │
│    • Cancel all micro trigger/hedge orders                          │
│    • Reset micro state for next entry                               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Calculation Formula Details

### Step 1: Determine Sides and Deficit

```typescript
const deficit = Math.abs(upQty - downQty);
const triggerSide = upQty < downQty ? 'UP' : 'DOWN';  // Buy deficit side
const hedgeSide = triggerSide === 'UP' ? 'DOWN' : 'UP';  // Buy surplus side

const deficitQty = triggerSide === 'UP' ? upQty : downQty;
const deficitCost = triggerSide === 'UP' ? upCost : downCost;
const surplusQty = hedgeSide === 'UP' ? upQty : downQty;
const surplusCost = hedgeSide === 'UP' ? upCost : downCost;

// Use ASK for calculations (conservative - matches instant fill price)
const triggerAsk = triggerSide === 'UP' ? upAsk : downAsk;
```

### Step 2: Cost After Filling Deficit

```typescript
// Estimate cost if we fill the deficit at current ASK
const deficitCostAfterFill = deficitCost + deficit * triggerAsk;
const totalCostAfterDeficit = deficitCostAfterFill + surplusCost;
const basePairs = surplusQty;  // After filling deficit, hedged qty = surplus
```

### Step 3: Max Hedge Price Constraint

```typescript
const TARGET_PAIR_COST = 0.99;  // Always $0.99 in MICRO mode

const maxHedgePrice = TARGET_PAIR_COST - triggerAsk;

// Dynamic buffer: 2c when ASK is high (> $0.90), 5c otherwise
const buffer = triggerAsk > 0.90 ? 0.02 : 0.05;
const hedgePrice = maxHedgePrice - buffer;

if (hedgePrice <= 0) {
  // Cannot balance profitably - trigger price too high
  // Set totals to 0, exit BALANCING
  microTotalTriggerSize = 0;
  microTotalHedgeSize = 0;
  return;
}
```

### Step 4: Solve for X (Dilution Shares)

```typescript
// Formula derivation:
// (totalCostAfterDeficit + X*trigger + X*hedge) / (basePairs + X) = TARGET
// Solving for X:

const numerator = TARGET_PAIR_COST * basePairs - totalCostAfterDeficit;
const denominator = triggerAsk + hedgePrice - TARGET_PAIR_COST;

if (denominator >= 0) {
  // Invalid calculation - cannot balance
  return;
}

const X = Math.ceil(numerator / denominator);

// X > 0: Need dilution beyond filling deficit
// X < 0: Position already good, just balance quantities
// X = 0: Perfect, no extra hedges needed
```

### Step 5: Order Sizes

```typescript
if (X < 0) {
  // Position already better than target - just balance
  microTotalTriggerSize = Math.ceil(deficit);
  microTotalHedgeSize = 0;
} else {
  microTotalTriggerSize = Math.ceil(deficit + X);
  microTotalHedgeSize = Math.ceil(X);
}

// Store initial target as CAP (prevents infinite growth)
microInitialHedgeTarget = microTotalHedgeSize;
```

---

## Tiered Trigger Placement

### Why Tiered BID Levels?

Instead of committing all triggers at once, MICRO mode places small orders at multiple bid levels. This:
1. Minimizes upfront commitment risk
2. Captures price improvements when bid moves down
3. Chases on upward breakouts (BID+1c)

```typescript
// Levels placed on UPWARD breakout only
const levels = [
  { offset: +0.01, size: coreSize },                   // BID+1c: chase
  { offset: 0,     size: Math.ceil(totalTrigger * 0.02) },  // BID: 2%
  { offset: -0.05, size: Math.ceil(totalTrigger * 0.05) },  // BID-5c: 5%
  { offset: -0.15, size: Math.ceil(totalTrigger * 0.08) },  // BID-15c: 8%
];

// Single set of orders at a time - cleared on upward breakout
// When BID moves DOWN, keep existing orders (passive fills)
```

### Chase vs Passive Behavior

```
BID = $0.70 → Place: $0.71, $0.70, $0.65, $0.55

BID rises to $0.72:
  → Clear all triggers
  → Place new: $0.73, $0.72, $0.67, $0.57
  → "Chase" the price up

BID drops to $0.68:
  → Keep existing orders at $0.65, $0.55
  → Don't place new orders
  → Wait for passive fills
```

---

## Freeze Logic (Prevents Hedge Spiral)

Critical protection against infinite hedge growth when triggers complete.

### The Problem

After all triggers fill, hedge fills change the position balance. Without freeze:
1. Triggers complete: triggerQty = 300, hedgeQty = 200
2. Hedge fills 50 → hedgeQty = 250
3. Recalculation sees: deficit = 300 - 250 = 50
4. Calculates new X based on smaller deficit → X increases!
5. Eventually: hedgeQty > triggerQty (flipped!)
6. X calculation produces huge numbers → infinite loop

### The Solution

```typescript
// In recalculateMicroBalancingSizes():
// FREEZE once triggers complete
if (microTriggerFilled >= microTotalTriggerSize && microTotalTriggerSize > 0) {
  const triggerQty = triggerSide === 'UP' ? upQty : downQty;
  const hedgeQty = hedgeSide === 'UP' ? upQty : downQty;

  // Cap hedges at BALANCE target only
  const hedgesStillNeeded = Math.max(0, triggerQty - hedgeQty);
  const maxHedgeTarget = microHedgeFilled + hedgesStillNeeded;

  if (microTotalHedgeSize > maxHedgeTarget) {
    console.log(`Capping hedge ${microTotalHedgeSize}→${maxHedgeTarget}`);
    microTotalHedgeSize = maxHedgeTarget;
  }
  return;  // Don't recalculate - frozen
}
```

### Additional Safeguards

```typescript
// Never exceed initial target
if (microTotalHedgeSize > microInitialHedgeTarget && microInitialHedgeTarget > 0) {
  microTotalHedgeSize = microInitialHedgeTarget;
}

// Resync hedgeOrdered if it exceeds total
if (microHedgeOrdered > microTotalHedgeSize) {
  microHedgeOrdered = microTotalHedgeSize;
  microHedgeFractional = 0;
}
```

---

## Complete MICRO Example

### Starting Position

```
UP:   100 shares @ $0.50 = $50.00
DOWN: 300 shares @ $0.40 = $120.00

Deficit: UP by 200 shares
Current pair cost: $0.90 ($0.50 + $0.40)
Trigger ASK: UP $0.72
Hedge ASK: DOWN $0.25
```

### Calculation

```
1. TARGET_PAIR_COST = $0.99 (always in MICRO mode)

2. Cost after filling deficit:
   deficitCostAfterFill = $50 + 200 × $0.72 = $194.00
   totalCostAfterDeficit = $194 + $120 = $314.00
   basePairs = 300

3. Max hedge price:
   maxHedgePrice = $0.99 - $0.72 = $0.27
   buffer = 0.05 (since ASK <= $0.90)
   hedgePrice = $0.27 - $0.05 = $0.22

4. Solve for X:
   numerator = 0.99 × 300 - 314 = 297 - 314 = -17
   denominator = 0.72 + 0.22 - 0.99 = -0.05
   X = ceil(-17 / -0.05) = 340

5. Order sizes:
   microTotalTriggerSize = 200 + 340 = 540
   microTotalHedgeSize = 340
   microInitialHedgeTarget = 340
```

### MICRO Execution

```
BID = $0.70 → Place tiered triggers:
  - $0.71 (BID+1c): 10 shares (coreSize)
  - $0.70 (BID):    11 shares (2% of 540)
  - $0.65 (BID-5c): 27 shares (5% of 540)
  - $0.55 (BID-15c):43 shares (8% of 540)

TRIGGER FILL: 10 @ $0.71 (instant - price >= ASK)
  → hedgeRatio = 340/540 = 0.63
  → hedgesToPlace = floor(10 × 0.63) = 6
  → hedgePrice = 0.99 - 0.71 - 0.05 = $0.23
  → Place hedge: DOWN 6 @ $0.23

TRIGGER FILL: 11 @ $0.70 (bid order fills)
  → microHedgeFractional = 0.37 + (11 × 0.63) = 7.30
  → hedgesToPlace = floor(7.30) = 7
  → avgTriggerPrice = (10×0.71 + 11×0.70) / 21 = $0.70
  → hedgePrice = 0.99 - 0.70 - 0.05 = $0.24
  → Place hedge: DOWN 7 @ $0.24

... continues until microTriggerFilled = 540 ...

FINAL HEDGE (triggers complete):
  triggerQty = 640 (100 original + 540 filled)
  hedgeQty = 520 (300 original + 220 filled hedges)
  hedgesToBalance = 640 - 520 = 120

  totalCost = $50 + $388 + $120 + $52 = $610
  maxProfitPrice = (640 - 610) / 120 = $0.25
  hedgeAsk = $0.25

  → Place final hedge: DOWN 120 @ $0.25

Final position:
  UP:   640 shares
  DOWN: 640 shares (balanced!)
  totalCost ≈ $635
  Profit = 640 - 635 = $5 guaranteed
```

---

## Key Takeaways

1. **TARGET_PAIR_COST = $0.99** (always in MICRO mode)

2. **Proportional hedging:** `hedgeRatio = microTotalHedgeSize / microTotalTriggerSize`

3. **Tiered bid levels:** BID+1c (chase), BID (2%), BID-5c (5%), BID-15c (8%)

4. **Hedge price formula:** `hedgePrice = TARGET - avgTriggerPrice - 0.05` (5c buffer)

5. **Single order set:** Clear ALL triggers on upward breakout, keep on downward

6. **FREEZE on completion:** Once triggers done, cap hedge at balance target

7. **Initial target cap:** Never exceed `microInitialHedgeTarget` (prevents infinite growth)

8. **Balance-based final hedge:** `hedgesNeeded = triggerQty - hedgeQty`

9. **Profit price calculation:** `maxProfitPrice = (triggerQty - totalCost - pending) / needed`

10. **Exit conditions:** Balanced AND profitable, OR trigger ASK <= $0.50

11. **Baseline tracking:** Save position after exit, prevent re-entry on same imbalance

---

## Edge Cases

### Trigger Price Too High

If `triggerAsk >= TARGET_PAIR_COST`:
- `hedgePrice <= 0`
- Cannot create profitable pair
- Set totals to 0, exit BALANCING

### Dynamic Buffer

When trigger ASK > $0.90:
- Use 2c buffer instead of 5c
- Tighter margin for expensive triggers

### Position Already Good

If X < 0 after calculation:
- Position already better than target
- Just balance quantities, no dilution needed
- `microTotalTriggerSize = deficit`
- `microTotalHedgeSize = 0`

### Deficit Side Too Cheap

If deficit ask ≤ $0.50:
- Exit BALANCING (no margin left)
- Save baseline, transition to PAIR_IMPROVEMENT
- Don't re-enter on same imbalance

### Over-Hedged Position

If `hedgeQty > triggerQty`:
- Freeze logic kicks in
- `hedgesStillNeeded = 0`
- Stop placing more hedges

---

## Simulation MICRO Functions

| Function | Location | Purpose |
|----------|----------|---------|
| `executeBalancingMode()` | ArbitrageSimulation.ts:1633 | MICRO orchestration |
| `calculateMicroBalancingParams()` | ArbitrageSimulation.ts:2163 | Calculate X, totals |
| `updateMicroTriggerOrders()` | ArbitrageSimulation.ts:2402 | Place tiered bids |
| `placeMicroTrigger()` | ArbitrageSimulation.ts:2296 | Place single trigger |
| `placeMicroHedge()` | ArbitrageSimulation.ts:2360 | Place hedge order |
| `getProportionalHedgeSize()` | ArbitrageSimulation.ts:2250 | Calculate from ratio |
| `handleMicroTriggerFill()` | ArbitrageSimulation.ts:2822 | Process fill, hedge |
| `recalculateMicroBalancingSizes()` | ArbitrageSimulation.ts:2566 | Recalc + freeze |
| `checkAndPlaceFinalHedge()` | ArbitrageSimulation.ts:2697 | Balance-based hedge |
| `shouldExitMicroBalancing()` | ArbitrageSimulation.ts:2756 | Exit conditions |
| `exitMicroBalancing()` | ArbitrageSimulation.ts:2779 | Cleanup + baseline |

---

*Last Updated: 2026-01-15 (MICRO BALANCING: tiered bids, proportional hedging, freeze logic, balance-based final hedge)*
