# SET-Based Simulation V1.4 Changelog

## Version 1.4 - Full BALANCING Mode + Mid-Set Merge

**Release Date:** January 2025

### Overview

V1.4 introduces two major features to address the loss patterns identified in surge/supply-break volatile markets:

1. **Full BALANCING Mode** - Multi-cycle trigger-hedge with calculated prices (ported from ARBITRAGE_STRATEGY.md)
2. **Mid-Set Merge for Capital Recycling** - Merge hedged pairs even when unprofitable to recycle capital

These features work together to:
- Prevent unlimited switching that causes pair cost spiral
- Recycle capital during volatile periods instead of exhausting budget
- Maintain position tracking while freeing up capital for rebalancing

---

## New Features

### 1. Full BALANCING Mode

**Purpose:** When position becomes imbalanced (UP qty != DOWN qty), execute a calculated multi-cycle trigger-hedge sequence to restore balance while maintaining profitable pair cost.

**Trigger Condition:**
- Position imbalance >= `balancingImbalanceThreshold` (default: 20 shares)

**How It Works:**

1. **Calculate Orders** - Solves for X shares needed to reach target pair cost:
   ```
   X = (TARGET * basePairs - totalCostAfterDeficit) / (triggerPrice + hedgePrice - TARGET)
   ```

2. **Multi-Cycle Execution** - Splits large orders into cycles based on price distance:
   - Each cycle: TRIGGER phase → HEDGE phase
   - Cycle step: 5c price intervals (configurable)
   - Min 80 shares per cycle

3. **Dynamic Pair Cost Targeting:**
   - M0-M5: $0.97 target (max profit)
   - M5-M8: $0.98 target (standard)
   - M8-M10: $0.99 target (relaxed)
   - M10+: $1.00 target (breakeven)

4. **Reversal Guard** - If price drops 5c after trigger fill, buy BOTH sides progressively to protect against adverse movement

**Configuration:**
```bash
V14_BALANCING_ENABLED=true          # Enable BALANCING mode
V14_BALANCING_IMBALANCE=20          # Min imbalance to trigger (shares)
V14_BALANCING_CYCLE_STEP=0.05       # Price step between cycles
V14_BALANCING_PRICE_CEILING=0.85    # Max trigger price
```

---

### 2. Mid-Set Merge for Capital Recycling

**Purpose:** When hedged pairs accumulate but pair cost is unprofitable, merge to recycle capital instead of exhausting budget.

**Trigger Condition:**
- Hedged pairs value >= `midSetMergeThresholdPct` of initial balance (default: 10%)
- Minimum pairs: `midSetMergeMinPairs` (default: 50)

**Key Characteristics:**
- **Async Operation** - Trading continues during merge, set tracking remains intact
- **Not for Profit** - This is capital recycling, not profit taking
- **Limits Reset** - After merge, dilute counter and emergency hedge flags reset for fresh budget

**Configuration:**
```bash
V14_MIDSET_MERGE_ENABLED=true       # Enable mid-set merge
V14_MIDSET_MERGE_THRESHOLD=0.10     # Threshold as % of initial balance
V14_MIDSET_MERGE_MIN=50             # Min pairs before merge triggers
```

---

### 3. Separate Dashboard Tracking

**Purpose:** Track profit merges and capital recycle merges separately for accurate P&L calculation.

**New Metrics Tracked:**

| Metric | Description |
|--------|-------------|
| `totalProfitMerges` | Count of profitable merges |
| `totalRecycleMerges` | Count of capital recycle merges |
| `totalProfitMergePairs` | Pairs from profit merges |
| `totalRecycleMergePairs` | Pairs from recycle merges |
| `totalProfitMergeProfit` | Total profit from profit merges |
| `totalRecycleMergeLoss` | Total loss from recycle merges |
| `lastProfitMergePairCost` | Pair cost of last profit merge |
| `lastRecycleMergePairCost` | Pair cost of last recycle merge |

**Log Output Examples:**
```
💰 PROFIT MERGE: 80 pairs @ $0.973 = +$2.16
♻️ RECYCLE MERGE: 64 pairs @ $1.023 = -$1.47 (capital recycling)
```

---

## Changes from V1.3

### Inherited from V1.3 (Emergency Protection)
- MAX_POSITION_SIZE = 1500 shares (emergency hedge if exceeded)
- MAX_DILUTES_PER_WINDOW = 8 (emergency hedge after this many dilutes)
- ACCUM_MAX_SHARES = 30 (hard cap on accumulation size)

### New in V1.4

| Feature | V1.3 | V1.4 |
|---------|------|------|
| BALANCING Mode | Not implemented | Full multi-cycle trigger-hedge |
| Mid-Set Merge | Not implemented | Capital recycling on 10% threshold |
| Merge Types | Single type | Profit merge + Recycle merge |
| Limits After Merge | Not reset | Reset for fresh budget |
| Reversal Guard | Not implemented | Buy BOTH sides on 5c drop |

---

## State Variables Added

### BALANCING Mode State
```typescript
private balancingMode: boolean = false;
private balancingPhase: "TRIGGER" | "HEDGE" | "MONITOR" = "TRIGGER";
private balancingTriggerSide: "UP" | "DOWN" | null = null;
private balancingHedgeSide: "UP" | "DOWN" | null = null;
private balancingTriggerPrice: number = 0;
private balancingHedgePrice: number = 0;
private balancingTriggerSize: number = 0;
private balancingHedgeSize: number = 0;
private balancingCurrentCycle: number = 0;
private balancingTotalCycles: number = 1;
private balancingTotalTriggerSize: number = 0;
private balancingTotalHedgeSize: number = 0;
private balancingTotalTriggerFilled: number = 0;
private balancingTotalHedgeFilled: number = 0;
private balancingFirstCyclePairCost: number = 0;
// Reversal guard
private balancingFirstTriggerFillPrice: number = 0;
private balancingLastReversalLevel: number = 0;
private balancingReversalOrderIds: string[] = [];
```

### Mid-Set Merge Tracking
```typescript
private midSetMergeInProgress: boolean = false;
private totalProfitMerges: number = 0;
private totalRecycleMerges: number = 0;
private totalProfitMergePairs: number = 0;
private totalRecycleMergePairs: number = 0;
private totalProfitMergeProfit: number = 0;
private totalRecycleMergeLoss: number = 0;
private lastProfitMergePairCost: number = 0;
private lastRecycleMergePairCost: number = 0;
```

---

## New Methods Added

### BALANCING Mode Methods
- `shouldEnterBalancingMode()` - Check if BALANCING should activate
- `getBalancingTargetPairCost()` - Dynamic target based on minute
- `calculateBalancingOrders()` - Solve for X shares needed
- `executeBalancingMode()` - Main BALANCING loop
- `executeBalancingTriggerPhase()` - Handle TRIGGER phase
- `executeBalancingHedgePhase()` - Handle HEDGE phase
- `advanceBalancingCycle()` - Move to next cycle
- `checkBalancingReversalGuard()` - Protection on price drop
- `resetBalancingState()` - Reset all BALANCING state

### Merge Methods (Refactored)
- `checkAutoMerge()` - Now checks both profit and recycle merge conditions
- `checkMidSetMerge()` - Check if mid-set merge should trigger
- `executeProfitMerge()` - Execute profitable merge with tracking
- `executeRecycleMerge()` - Execute capital recycling merge
- `resetLimitsAfterMerge()` - Reset counters after any merge

---

## Configuration Reference

### New V1.4 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `V14_BALANCING_ENABLED` | `true` | Enable full BALANCING mode |
| `V14_BALANCING_IMBALANCE` | `20` | Min imbalance to trigger (shares) |
| `V14_BALANCING_CYCLE_STEP` | `0.05` | Price step between cycles |
| `V14_BALANCING_PRICE_CEILING` | `0.85` | Max trigger price for BALANCING |
| `V14_MIDSET_MERGE_ENABLED` | `true` | Enable mid-set merge |
| `V14_MIDSET_MERGE_THRESHOLD` | `0.10` | Threshold as % of initial balance |
| `V14_MIDSET_MERGE_MIN` | `50` | Min pairs before merge triggers |

### Inherited V1.3 Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `V13_MAX_POSITION_SIZE` | `1500` | Emergency hedge if exceeded |
| `V13_MAX_DILUTES` | `8` | Max dilutes per window |

---

## Migration from V1.3

1. **File Change:** Use `SetBasedSimulation_TradeFill_V1.4.ts` instead of V1.3

2. **No Breaking Changes:** V1.4 is backward compatible with V1.3 configuration

3. **New Features Enabled by Default:** 
   - BALANCING mode: enabled
   - Mid-set merge: enabled
   - Set `V14_BALANCING_ENABLED=false` or `V14_MIDSET_MERGE_ENABLED=false` to disable

4. **Dashboard Integration:** If using dashboard, new merge type indicators will appear:
   - 💰 for profit merges
   - ♻️ for recycle merges

---

## Known Limitations

1. **Simulation Only** - V1.4 is for paper trading simulation, not live trading
2. **Instant Fills** - BALANCING mode uses simulated instant fills at ask price
3. **No Order Book Depth** - Simulation doesn't consider order book liquidity

---

## Files Changed

- `src/strategies/SetBasedSimulation_TradeFill_V1.4.ts` - New file (based on V1.3)
- `docs/SET_SIMULATION_V1.4_CHANGELOG.md` - This changelog

## Related Documentation

- `docs/SURGE_LOSS_ANALYSIS_AND_ALTERNATIVES.md` - Analysis that led to V1.4
- `docs/ARBITRAGE_STRATEGY.md` - Original BALANCING mode specification
