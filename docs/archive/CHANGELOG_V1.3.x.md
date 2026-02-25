# SET-Based Simulation Strategy Changelog (V1.3.x Series)

## Overview

The V1.3.x series introduces emergency protection mechanisms to prevent runaway position accumulation and dilution spirals. Each version refines when and how emergency hedging is triggered.

---

## V1.3.4 - Combined Features (2025-01-13)

**Base:** Combines V1.3.2 + V1.3.3

### Purpose

V1.3.4 combines the best features from both V1.3.2 and V1.3.3:
- **Dynamic Position Cap** from V1.3.2: Cost-based cap scales with account size
- **Smart Dilute Cap** from V1.3.3: Only emergency hedge when overweight token is cheap

### Features Combined

| Feature | From | Description |
|---------|------|-------------|
| Dynamic Position Cap | V1.3.2 | 75% of window start balance as cost-based cap |
| Smart Dilute Cap | V1.3.3 | Only hedge when overweight token ≤ 70c |
| Dilute Count Limit | V1.3 | 8 dilutes per window |

### Configuration

| Variable | Default | Env Var | Description |
|----------|---------|---------|-------------|
| `POSITION_CAP_PERCENT` | 0.75 | `V134_POSITION_CAP_PERCENT` | Use this % of window start balance as cap |
| `DILUTE_PRICE_THRESHOLD` | 0.70 | `V134_DILUTE_PRICE_THRESHOLD` | Only emergency hedge when overweight token ≤ this |
| `MAX_DILUTES_PER_WINDOW` | 8 | `V13_MAX_DILUTES` | Emergency hedge after this many dilutes |

### Code Changes

**File:** `SetBasedSimulation_TradeFill_V1.3.4.ts`

1. **Variables from V1.3.2** (dynamic position cap):
```typescript
private readonly POSITION_CAP_PERCENT: number = parseFloat(
  process.env.V134_POSITION_CAP_PERCENT || "0.75",
);
private windowStartBalance: number = 0;
private windowPositionCap: number = 0;
```

2. **Variables from V1.3.3** (smart dilute cap):
```typescript
private readonly DILUTE_PRICE_THRESHOLD: number = parseFloat(
  process.env.V134_DILUTE_PRICE_THRESHOLD || "0.70",
);
private diluteCapReached: boolean = false;
```

3. **Position cap check** uses cost-based threshold (from V1.3.2):
```typescript
const totalPositionCost = this.position.upCost + this.position.downCost;
if (totalPositionCost >= this.windowPositionCap && !this.emergencyHedgeTriggered) {
  this.executeEmergencyHedge("POSITION_CAP");
}
```

4. **Dilute cap check** uses price-based deferral (from V1.3.3):
```typescript
if (this.dilutesThisWindow >= this.MAX_DILUTES_PER_WINDOW) {
  if (overweightAsk <= this.DILUTE_PRICE_THRESHOLD) {
    // Trigger immediately
    this.executeEmergencyHedge("DILUTE_CAP");
  } else {
    // Defer - set flag and keep checking
    this.diluteCapReached = true;
  }
}
```

### Behavior Summary

| Condition | Action |
|-----------|--------|
| Position cost ≥ 75% of window balance | Emergency hedge immediately |
| Dilute cap (8) + overweight token ≤ 70c | Emergency hedge immediately |
| Dilute cap (8) + overweight token > 70c | Defer, keep checking each tick |
| Deferred dilute cap + token drops to ≤ 70c | Now trigger emergency hedge |

### Entry Point

`run-set-simulation-tradefill-v134.ts`

---

## V1.3.3 - Smart Dilute Cap (2025-01-13)

**Base:** V1.3 (not V1.3.2)

### Problem Solved

V1.3 triggers emergency hedge immediately when dilute cap (8) is reached, regardless of market conditions. This causes:
- **Unnecessary market buys** on cheap tokens that may not need hedging
- **Worse fill prices** - cancels pending limit orders and replaces with market orders
- **Locked-in losses** when overweight on the winning side

Example from logs:
```
Position: UP 75 / DOWN 38 (unhedged: 37 UP)
Dilute cap reached → Emergency hedge: Market buy 37 DOWN @ $0.23
Result: Pair cost $0.99 (breakeven)
```
But if UP wins (price was high), we didn't need to hedge at all!

### Solution

Only trigger emergency hedge when the **overweight token price ≤ 70c**:
- If overweight on expensive token (>70c = likely winner) → **defer** emergency hedge
- Continue normal trading, keep checking each tick
- If overweight token drops to ≤70c → **now trigger** emergency hedge

### New Configuration

| Variable | Default | Env Var | Description |
|----------|---------|---------|-------------|
| `DILUTE_PRICE_THRESHOLD` | 0.70 | `V133_DILUTE_PRICE_THRESHOLD` | Only emergency hedge when overweight token ≤ this |
| `diluteCapReached` | false | N/A | Flag for deferred dilute cap state |

### Code Changes

**File:** `SetBasedSimulation_TradeFill_V1.3.3.ts`

1. **New variables** (lines 300-303):
```typescript
private readonly DILUTE_PRICE_THRESHOLD: number = parseFloat(
  process.env.V133_DILUTE_PRICE_THRESHOLD || "0.70",
);
private diluteCapReached: boolean = false;
```

2. **Modified dilute cap check** in `placeHedgeForSet()` (lines 1654-1686):
```typescript
if (this.dilutesThisWindow >= this.MAX_DILUTES_PER_WINDOW && !this.emergencyHedgeTriggered) {
  // Calculate overweight side and its current price
  const overweightSide = unhedgedUp > unhedgedDown ? "UP" : "DOWN";
  const overweightAsk = this.lastAsk.get(overweightTokenId) || 0.5;

  if (overweightAsk <= this.DILUTE_PRICE_THRESHOLD) {
    // Cheap overweight → trigger immediately
    this.executeEmergencyHedge("DILUTE_CAP");
  } else {
    // Expensive overweight → defer, set flag
    this.diluteCapReached = true;
    // Continue with normal dilute hedge placement
  }
}
```

3. **Per-tick monitoring** in `onTick()` (lines 1171-1189):
```typescript
if (this.diluteCapReached && !this.emergencyHedgeTriggered) {
  const overweightAsk = overweightSide === "UP" ? upAsk : downAsk;
  if (overweightAsk <= this.DILUTE_PRICE_THRESHOLD) {
    this.executeEmergencyHedge("DILUTE_CAP");
    return;
  }
}
```

4. **Reset flags** on market change (lines 418, 3568):
```typescript
this.diluteCapReached = false;
```

### Behavior Comparison

| Scenario | V1.3 | V1.3.3 |
|----------|------|--------|
| Dilute cap, overweight UP @ $0.85 | Emergency hedge DOWN immediately | **Defer** - continue trading |
| Dilute cap, overweight UP @ $0.40 | Emergency hedge DOWN immediately | Emergency hedge DOWN immediately |
| After deferral, UP drops to $0.65 | N/A | **Now trigger** emergency hedge |
| After deferral, UP stays at $0.85 until settlement | N/A | No hedge needed - UP wins! |

### Entry Point

`run-set-simulation-tradefill-v133.ts`

---

## V1.3.2 - Dynamic Position Cap (2025-01-13)

**Base:** V1.3

### Problem Solved

V1.3 uses a static `MAX_POSITION_SIZE` (1500 shares) regardless of account balance. This causes:
- **Over-exposure** for small accounts ($500 balance with 1500 share cap = 300% of capital)
- **Under-utilization** for large accounts ($10K balance limited to same 1500 shares)

### Solution

Replace static share cap with **dynamic cost-based cap**:
- Calculate position cap as **75% of balance at window start**
- Recalculate after each merge (balance changes)
- Trigger emergency hedge when **total position COST** exceeds cap

### New Configuration

| Variable | Default | Env Var | Description |
|----------|---------|---------|-------------|
| `POSITION_CAP_PERCENT` | 0.75 | `V132_POSITION_CAP_PERCENT` | Use this % of window start balance as cap |
| `windowStartBalance` | N/A | N/A | Captured after cleanup/merge |
| `windowPositionCap` | N/A | N/A | = windowStartBalance × POSITION_CAP_PERCENT |

### Code Changes

**File:** `SetBasedSimulation_TradeFill_V1.3.2.ts`

1. **New variables** (lines 288-292):
```typescript
private readonly POSITION_CAP_PERCENT: number = parseFloat(
  process.env.V132_POSITION_CAP_PERCENT || "0.75",
);
private windowStartBalance: number = 0;
private windowPositionCap: number = 0;
```

2. **Initialize in constructor** (lines 314-316):
```typescript
this.windowStartBalance = initialBalance;
this.windowPositionCap = initialBalance * this.POSITION_CAP_PERCENT;
```

3. **Recalculate after market cleanup** in `runMarketCycle()` (lines 469-472):
```typescript
this.windowStartBalance = this.simBalance;
this.windowPositionCap = this.windowStartBalance * this.POSITION_CAP_PERCENT;
console.log(`[V1.3.2] Window start balance: $${this.windowStartBalance.toFixed(2)} → Position cap: $${this.windowPositionCap.toFixed(2)}`);
```

4. **Modified position cap check** in `fillOrder()` (lines 863-872):
```typescript
// V1.3.2: Check position COST against dynamic cap
const totalPositionCost = this.position.upCost + this.position.downCost;
if (totalPositionCost >= this.windowPositionCap && !this.emergencyHedgeTriggered) {
  this.executeEmergencyHedge("POSITION_CAP");
}
```

### Behavior Comparison

| Account Balance | V1.3 Cap | V1.3.2 Cap (75%) |
|-----------------|----------|------------------|
| $500 | 1500 shares (~$750) | **$375** |
| $1,000 | 1500 shares (~$750) | **$750** |
| $2,000 | 1500 shares (~$750) | **$1,500** |
| $5,000 | 1500 shares (~$750) | **$3,750** |

### Entry Point

`run-set-simulation-tradefill-v132.ts`

---

## V1.3 - Emergency Protection (Base Version)

**Base:** V1.2 (trade-based fill detection)

### Features

1. **Position Size Limit**
   - `MAX_POSITION_SIZE`: 1500 shares (static)
   - Triggers emergency hedge when total position exceeds limit

2. **Dilute Count Cap**
   - `MAX_DILUTES_PER_WINDOW`: 8 per window
   - Triggers emergency hedge when dilute count reaches limit

3. **Emergency Hedge Mechanism**
   - Cancels all pending orders
   - Market buys deficit side at ASK price
   - Marks position as fully hedged
   - Exits market (no more trading)

### Configuration

| Variable | Default | Env Var |
|----------|---------|---------|
| `MAX_POSITION_SIZE` | 1500 | `V13_MAX_POSITION_SIZE` |
| `MAX_DILUTES_PER_WINDOW` | 8 | `V13_MAX_DILUTES` |

### Entry Point

`run-set-simulation-tradefill-v13.ts`

---

## Version Selection Guide

| Use Case | Recommended Version |
|----------|---------------------|
| **Production (best of both)** | **V1.3.4** |
| Small account (<$1K), want dynamic sizing only | V1.3.2 |
| Large account, trust expensive token to win only | V1.3.3 |
| Conservative, want simple emergency rules | V1.3 |
| A/B testing dynamic cap vs smart dilute | V1.3.2 vs V1.3.3 |

---

## File Summary

| Version | Strategy File | Entry Point |
|---------|---------------|-------------|
| V1.3 | `SetBasedSimulation_TradeFill_V1.3.ts` | `run-set-simulation-tradefill-v13.ts` |
| V1.3.2 | `SetBasedSimulation_TradeFill_V1.3.2.ts` | `run-set-simulation-tradefill-v132.ts` |
| V1.3.3 | `SetBasedSimulation_TradeFill_V1.3.3.ts` | `run-set-simulation-tradefill-v133.ts` |
| **V1.3.4** | `SetBasedSimulation_TradeFill_V1.3.4.ts` | `run-set-simulation-tradefill-v134.ts` |
