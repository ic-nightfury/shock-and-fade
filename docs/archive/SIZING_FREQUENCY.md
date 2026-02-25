# Arbitrage Strategy Documentation

This document explains the arbitrage bot's strategy, sizing, and order placement logic.

---

## 1. Win Condition

```
GUARANTEED PROFIT = min(qty_UP, qty_DOWN) x ($1.00 - avg_pair_cost)

Requirements:
  1. avg_UP_price + avg_DOWN_price < $1.00  (pair cost under $1)
  2. UP/DOWN balance within acceptable imbalance
```

**Why it works:** Polymarket binary markets guarantee exactly one outcome wins and pays $1.00/share. By holding equal UP and DOWN tokens at combined cost < $1.00, profit is locked regardless of outcome.

**Example:**
```
Position: 100 UP @ $0.65 avg, 100 DOWN @ $0.30 avg
Pair cost: $0.65 + $0.30 = $0.95
Hedged pairs: min(100, 100) = 100

If UP wins:  100 x $1.00 - $95.00 total cost = $5.00 profit
If DOWN wins: 100 x $1.00 - $95.00 total cost = $5.00 profit

Guaranteed profit = 100 x ($1.00 - $0.95) = $5.00
```

---

## 2. Two Operating Modes

| Mode | Trigger | Pair Cost Target | Purpose |
|------|---------|------------------|---------|
| **NORMAL** | Balanced position | $1.00 (hard cap) | Bilateral accumulation |
| **BALANCING** | Imbalanced position | $1.10 (relaxed) | Rebalance deficit side |

---

## 3. NORMAL Mode

When position is balanced, place passive orders on both sides.

### Order Structure (3 levels per side)

| Side | Price 1 | Price 2 | Price 3 |
|------|---------|---------|---------|
| UP | Bid | Bid - 1c | Bid - 2c |
| DOWN | Bid | Bid - 1c | Bid - 2c |

### Pair Cost Constraint (Hard $1.00 Cap)

**Only place orders that won't push pair cost >= $1.00:**

```typescript
maxPrice[UP] = $1.00 - downAvg
maxPrice[DOWN] = $1.00 - upAvg
```

**Example:**
- Current: UP avg = $0.75, DOWN avg = $0.20
- For DOWN orders: maxPrice = $1.00 - $0.75 = $0.25
- Any DOWN order > $0.25 is skipped
- If DOWN fills at $0.25: pair cost = $0.75 + $0.25 = $1.00 (at limit)

This ensures NORMAL mode never creates positions with pair cost >= $1.00.

---

## 4. BALANCING Mode

When position is imbalanced beyond threshold, aggressively buy the deficit side.

### Trigger Condition

```
imbalance = |upQty - downQty| / (upQty + downQty)
```

| Total Shares | Threshold | Behavior |
|--------------|-----------|----------|
| 0 | 100% | No balancing (no position) |
| 250 | 65% | Loose - allow accumulation |
| 500 | 30% | Moderate |
| 1000 | 17% | Tighter |
| 2000+ | 5% | Very tight - maintain balance |

**Additional requirement:** Minimum 100 shares absolute imbalance.

### Single-Phase Trigger-Hedge

BALANCING mode places **TRIGGER + HEDGE together** in one cycle to:
1. Balance quantities (trigger on deficit, hedge on surplus)
2. Lock profit (calculated hedge price ensures target pair cost)

**Exit condition:** `pairCost < $1.00`

### Order Structure

| Side | Order | Price | Size |
|------|-------|-------|------|
| Deficit | TRIGGER | Ask + 1c | min(25% of imbalance, 64) |
| Surplus | HEDGE | Calculated | Same as trigger |

### Dilute-Balance Formula

Calculates hedge price so that **after both orders fill**, pair cost hits target:

```typescript
const TARGET_PAIR_COST = 0.97;  // 3% profit margin

// After trigger fills, calculate new deficit avg
newDeficitAvg = (deficitCost + triggerSize × aggressivePrice) / (deficitQty + triggerSize)

// Calculate target surplus avg for target pair cost
targetSurplusAvg = TARGET_PAIR_COST - newDeficitAvg

// Calculate hedge price that dilutes surplus avg to target
hedgePrice = (targetSurplusAvg × (surplusQty + hedgeSize) - surplusCost) / hedgeSize
```

### Example

```
Current Position:
  Deficit (DOWN): 50 shares @ $0.75 avg (cost = $37.50)
  Surplus (UP): 80 shares @ $0.22 avg (cost = $17.60)
  Imbalance: 30 shares

DOWN ask: $0.78, triggerSize: 20

Step 1: Calculate new deficit avg after trigger
  newDeficitCost = 37.50 + (20 × 0.79) = $53.30
  newDeficitQty = 50 + 20 = 70
  newDeficitAvg = 53.30 / 70 = $0.761

Step 2: Calculate target surplus avg
  targetSurplusAvg = 0.97 - 0.761 = $0.209

Step 3: Calculate hedge price (hedgeSize = 20)
  hedgePrice = (0.209 × (80 + 20) - 17.60) / 20
            = (20.9 - 17.60) / 20
            = $0.165

After both fill:
  New UP avg = (17.60 + 20 × 0.165) / 100 = $0.209
  Pair cost = 0.761 + 0.209 = $0.97 (target hit!)
```

### Validation

Skip cycle if hedge price fails:
- **Negative** - mathematically impossible
- **> $0.50** - too expensive
- **< surplus ask** - can't fill immediately

### Why Ask + 1c?

| Placement | Simulation | Live Trading |
|-----------|------------|--------------|
| At Ask | Fills (limitPrice >= ask) | Joins queue, may not fill |
| At Ask + 1c | Fills immediately | **Crosses spread, guaranteed fill** |

---

## 5. Core Size Calculation

### Formula

```
coreSize = min(max(BASE_SIZE, floor(balance / 30)), MAX_CORE_SIZE)
```

**Default:** `BASE_SIZE = 5` shares, `MAX_CORE_SIZE = 32` shares

| Balance | Core Size |
|---------|-----------|
| $100 | 5 |
| $300 | 10 |
| $600 | 20 |
| $900 | 30 |
| $1500+ | 32 (capped) |

**Rule of thumb:** 1 share per $30 of capital, min 5, max 32.

### Time Decay After M6

Size decreases 20% per minute after minute 6:

```typescript
if (currentMinute >= 6) {
  const minutesPast6 = Math.floor(currentMinute) - 6;
  base = Math.round(base * Math.pow(0.8, minutesPast6));
}
```

| Minute | Multiplier | Example (base=32) |
|--------|------------|-------------------|
| M0-M6 | 100% | 32 shares |
| M7 | 80% | 26 shares |
| M8 | 64% | 20 shares |
| M9 | 51% | 16 shares |
| M10 | 41% | 13 shares |

### Profit Lock Reduction

Each profit lock reduces core size by 30%:

```typescript
coreSize = baseCoreSize * Math.pow(0.7, profitLockCount);
```

| Profit Locks | Multiplier |
|--------------|------------|
| 0 | 100% |
| 1 | 70% |
| 2 | 49% |
| 3 | Exit market |

---

## 6. Minimum Order Size

Polymarket requires minimum $1 order value:

```typescript
minSize = max(5, ceil(1 / price))
```

| Price | Min Size |
|-------|----------|
| $0.05 | 20 shares |
| $0.10 | 10 shares |
| $0.20 | 5 shares |

---

## 7. Hedge Monitor

After each fill, cancel opposite-side orders that would result in pair cost >= $1.03:

```typescript
maxOppositePrice = $1.03 - lastFillPrice

// Example: UP fills @ $0.55
maxDownPrice = $1.03 - $0.55 = $0.48
// Cancel any pending DOWN orders > $0.48
```

---

## 8. Configuration Summary

### Pair Cost Targets

| Mode | Target | Purpose |
|------|--------|---------|
| NORMAL | $1.00 | Hard cap - preserve profit margin |
| BALANCING | $1.10 | Relaxed - allow rebalancing flexibility |
| Hedge Monitor | $1.03 | Post-fill safety check |

### Strategy Constants

| Constant | Value | Description |
|----------|-------|-------------|
| MAX_CORE_SIZE | 32 | Maximum order size |
| BASE_SIZE | 5 | Minimum order size |
| LOOP_INTERVAL | 5000ms | Price check frequency |
| STOP_BEFORE_END | M8 | Stop trading before market end |

---

## 9. Decision Flow

```
+------------------------------------------------------------------+
|                     EVERY 5 SECONDS                               |
+------------------------------------------------------------------+
                              |
                              v
                   +--------------------+
                   |   getCoreSize()    |
                   | min(balance/30, 32)|
                   | x 0.8^(min after M6)|
                   | x 0.7^(profitLocks)|
                   +--------------------+
                              |
                              v
                   +--------------------+
                   |  Check Imbalance   |
                   | threshold + min 100|
                   +--------------------+
                              |
              +---------------+---------------+
              |                               |
              v                               v
     +-----------------+            +-------------------+
     |   NORMAL MODE   |            |  BALANCING MODE   |
     +-----------------+            +-------------------+
              |                               |
              v                               v
     +-----------------+            +-------------------+
     | Both sides:     |            | Deficit:          |
     |   Bid           |            |   Ask+1c (25% def)|
     |   Bid - 1c      |            |   Bid-1c          |
     |   Bid - 2c      |            |   NORMAL (reversal)|
     |                 |            |   PATIENT         |
     | maxPrice =      |            |                   |
     | $1.00 - otherAvg|            | Price floor:      |
     +-----------------+            |   Skip if < first |
                                    +-------------------+
                                    | Surplus (half):   |
                                    |   Bid-2c, Bid-3c  |
                                    +-------------------+
```

---

## 10. Key Insights

1. **Win condition:** `min(UP, DOWN) x ($1.00 - pairCost) = profit`
2. **NORMAL mode:** $1.00 hard cap ensures profitable positions
3. **BALANCING mode:** Ask+1c crosses spread for immediate deficit fills
4. **Dynamic sizing:** 25% of deficit (min 2x core) = balance in ~4 trades
5. **Price floor:** Don't chase falling prices - let passive orders catch cheaper fills
6. **Reversal catchers:** NORMAL/PATIENT orders catch price drops for instant rebalance
7. **Size caps:** Max 32 shares limits single-order risk
8. **Time decay:** 20% size reduction per minute after M6
9. **Hedge monitor:** Cancels dangerous opposite-side orders after fills
