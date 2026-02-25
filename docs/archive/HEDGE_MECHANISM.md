# BALANCING Mode: Multi-Cycle Trigger-Hedge

This document describes the **BALANCING mode** strategy for handling imbalanced positions.

---

## Core Principle

**MULTI-CYCLE + PASSIVE PRICING + DILUTE-BALANCE HEDGING**

Splits the rebalancing into multiple cycles based on price distance from $0.96:

1. **Trigger at BID** (passive) - waits for fill instead of crossing spread
2. **Cycle-based sizing** - smaller orders reduce per-fill risk
3. **Dilute to target** - calculate shares needed to dilute surplus to target avg

---

## Win Condition

```
GUARANTEED PROFIT = min(qty_UP, qty_DOWN) × ($1.00 - avg_pair_cost)
```

Binary markets pay $1.00/share for the winning outcome. By holding equal UP and DOWN at combined cost < $1.00, profit is locked regardless of outcome.

---

## Hedge Price Calculation (Correct Formula)

### Step-by-Step Process

```typescript
const TARGET_PROFIT = 0.03;     // 3% profit margin
const HEDGE_DISCOUNT = 0.10;    // 10c discount on hedge price

// Step 1: Target surplus avg based on trigger price
// If we buy deficit at triggerPrice, we need surplus avg at this level
const triggerPrice = deficitBid;
const targetSurplusAvg = 1 - triggerPrice - TARGET_PROFIT;

// Step 2: Hedge price with discount (explicit, not calculated)
const hedgePrice = targetSurplusAvg - HEDGE_DISCOUNT;

// Step 3: Calculate dilution shares (X) needed to reach target
// Formula: (surplusCost + X × hedgePrice) / (surplusQty + X) = targetSurplusAvg
// Solving for X:
const X = (surplusCost - targetSurplusAvg * surplusQty) / (targetSurplusAvg - hedgePrice);

// Step 4: Order sizes
// Trigger = deficit + dilution (to maintain balance after hedge fills!)
// Hedge = dilution shares
const triggerSize = deficit + X;
const hedgeSize = X;
```

### Example

```
Position:
  UP: 0 shares
  DOWN: 100 shares @ $0.50 avg (cost = $50)

Deficit: 100 shares (need UP to balance)
Current prices: UP bid = $0.60

Step 1: Target surplus avg
  triggerPrice = $0.60
  targetSurplusAvg = 1 - 0.60 - 0.03 = $0.37

Step 2: Hedge price
  hedgePrice = 0.37 - 0.10 = $0.27

Step 3: Dilution shares
  X = (50 - 0.37 × 100) / (0.37 - 0.27)
    = (50 - 37) / 0.10
    = 130 shares

Step 4: Order sizes
  triggerSize = 100 + 130 = 230 UP @ $0.60
  hedgeSize = 130 DOWN @ $0.27

Verification after all fills:
  UP: 230 shares @ $0.60 avg
  DOWN: 230 shares @ (50 + 130×0.27) / 230 = $85.1 / 230 = $0.37 avg
  Pair cost = 0.60 + 0.37 = $0.97 ✓
  Quantities balanced: 230 = 230 ✓
  Profit locked: 230 × (1 - 0.97) = $6.90 (3%)
```

---

## Key Insight: Trigger Size = Deficit + Dilution

The trigger size is NOT just the deficit. It must include the dilution shares to maintain balance:

- If deficit = 100 and dilution = 130
- Trigger buys 230 on deficit side
- Hedge buys 130 on surplus side
- Result: both sides have 230 shares (balanced!)

---

## Multi-Cycle Splitting

Once total sizes are calculated, split across cycles based on price distance:

```typescript
const PRICE_CEILING = 0.96;
const CYCLE_STEP = 0.05;

const priceDistance = Math.max(0, PRICE_CEILING - deficitBid);
const numCycles = Math.max(1, Math.ceil(priceDistance / CYCLE_STEP));

const triggerPerCycle = Math.ceil(totalTriggerSize / numCycles);
const hedgePerCycle = Math.ceil(totalHedgeSize / numCycles);
```

| Deficit Bid | Distance | Cycles |
|-------------|----------|--------|
| $0.60 | $0.36 | 8 |
| $0.70 | $0.26 | 6 |
| $0.80 | $0.16 | 4 |
| $0.90 | $0.06 | 2 |

---

## State Tracking

```typescript
private hedgePending: boolean = false;
private hedgeSide: 'UP' | 'DOWN' | null = null;
```

When `hedgePending = true`:
- Wait for hedge to fill before starting next cycle
- Don't place new trigger orders
- If hedge order is cleaned up (stale), reset flag and recalculate

---

## Configuration

| Parameter | Value | Description |
|-----------|-------|-------------|
| TARGET_PROFIT | 0.03 | 3% profit margin |
| HEDGE_DISCOUNT | 0.10 | 10c below target surplus avg |
| PRICE_CEILING | 0.96 | Max price for cycle calculation |
| CYCLE_STEP | 0.05 | Price step per cycle |

---

*Document Version: BALANCING Mode v5 | Last Updated: 2026-01-09*
