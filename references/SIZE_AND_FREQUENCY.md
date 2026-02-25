# Size and Frequency Scaling (V79)

Dynamic trade sizing and frequency based on capital and price zone.

---

## Overview

The strategy adjusts both **trade size** and **trade frequency** based on:
1. **Capital** - Budget determines base size and cooldown
2. **Price Zone** - Higher prices = smaller sizes, longer cooldowns

```
┌─────────────────────────────────────────────────────────────┐
│                    SIZING FLOW                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  AUM × BUDGET_PCT = maxCostPerMarket                       │
│         │                                                   │
│         ▼                                                   │
│  ┌─────────────────────┐    ┌─────────────────────┐        │
│  │ calculateTradeCooldown │    │ calculateOptimalTradeSize │        │
│  │     (base cooldown)    │    │      (base size)          │        │
│  └──────────┬────────────┘    └──────────┬────────────┘        │
│             │                            │                  │
│             ▼                            ▼                  │
│  ┌─────────────────────┐    ┌─────────────────────┐        │
│  │ V79: getPriceMultiplier │    │ V79: getPriceMultiplier │        │
│  │   (cooldown scaling)   │    │    (size scaling)       │        │
│  └──────────┬────────────┘    └──────────┬────────────┘        │
│             │                            │                  │
│             ▼                            ▼                  │
│      FINAL COOLDOWN              FINAL TRADE SIZE          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Capital-Based Sizing

### Budget Calculation

```typescript
maxCostPerMarket = AUM × MARKET_BUDGET_PERCENT  // default: 35%
```

### Base Trade Cooldown

Paces spending across the 15-minute trading window:

```typescript
function calculateTradeCooldown(aum: number): number {
  const tradingWindowSec = 900 - 10;  // 890 seconds
  const tradeSize = TRADE_SIZE;       // env var, default: 20
  const avgPrice = 0.55;

  // Account for flip sizing (1.5x average due to cost-balance formula)
  const avgTradeCost = tradeSize * avgPrice * 1.5;
  const maxTrades = aum / avgTradeCost;

  // cooldown = window / maxTrades
  const cooldownSec = tradingWindowSec / maxTrades;

  // Clamp: 15s minimum, 120s maximum
  return Math.max(15000, Math.min(120000, cooldownSec * 1000));
}
```

**Examples:**
| AUM | Max Trades | Base Cooldown |
|-----|------------|---------------|
| $100 | 6 | 120s (capped) |
| $300 | 18 | 49s |
| $500 | 30 | 30s |
| $1000 | 61 | 15s (floor) |

### Base Trade Size

Spreads capital across ~25 trades:

```typescript
private calculateOptimalTradeSize(currentPrice: number): number {
  const MIN_SIZE = 5;                    // Polymarket minimum
  const MAX_SIZE = TRADE_SIZE;           // env var, default: 20
  const BUDGET_PER_TRADE_PCT = 0.04;     // 4% per trade = ~25 trades

  // Constraint 1: Minimum for $1 order value
  const minForValue = Math.ceil(1 / currentPrice);

  // Constraint 2: Lock minimum ($1 + 20% buffer)
  const lockPrice = PAIR_COST_TARGET - currentPrice;
  const minForLock = lockPrice > 0 ? Math.ceil(1.2 / lockPrice) : 5;

  // Constraint 3: Capital spread
  const targetCost = maxCostPerMarket * BUDGET_PER_TRADE_PCT;
  const baseSize = Math.floor(targetCost / currentPrice);

  // V79: Apply price zone multiplier
  const sizeMultiplier = getPriceMultiplier(currentPrice, 'size');
  const scaledSize = Math.floor(baseSize * sizeMultiplier);

  // Respect minimums, cap at max
  const minRequired = Math.max(MIN_SIZE, minForValue, minForLock);
  return Math.min(MAX_SIZE, Math.max(minRequired, scaledSize));
}
```

**Examples (assuming $300 budget, 4% per trade = $12 target):**
| Price | Base Size | Min Required | Final Size |
|-------|-----------|--------------|------------|
| $0.50 | 24 | 5 | 20 (capped) |
| $0.55 | 21 | 5 | 20 (capped) |
| $0.60 | 20 | 5 | 20 |
| $0.65 | 18 | 5 | 18 |
| $0.70 | 17 | 5 | 17 |

---

## V79: Price Zone Scaling

### Zone Definitions

```
PRICE ZONES:

$1.00 ┌─────────────────────────────────────────┐
      │                                         │
$0.70 ├─────────────────────────────────────────┤ VERY_EXPENSIVE
      │  Size: 0.5x  |  Cooldown: 2.0x         │ Minimal activity
      │                                         │
$0.55 ├─────────────────────────────────────────┤ EXPENSIVE
      │  Size: 1.0→0.7x  |  Cooldown: 1.0→1.5x │ Linear interpolation
      │                                         │
$0.00 └─────────────────────────────────────────┘ CHEAP/NORMAL
        Size: 1.0x  |  Cooldown: 1.0x            Baseline
```

### Multiplier Calculation

```typescript
private getPriceMultiplier(price: number, type: 'size' | 'cooldown'): number {
  // CHEAP/NORMAL zone: baseline
  if (price <= 0.55) {
    return 1.0;
  }

  // EXPENSIVE zone: linear interpolation
  if (price <= 0.70) {
    const t = (price - 0.55) / 0.15;  // 0 to 1 as price goes 0.55 to 0.70
    return type === 'size'
      ? 1.0 - (t * 0.3)   // 1.0 → 0.7
      : 1.0 + (t * 0.5);  // 1.0 → 1.5
  }

  // VERY_EXPENSIVE zone: minimal activity
  return type === 'size' ? 0.5 : 2.0;
}
```

### Multiplier Values by Price

| Price | Size Mult | Cooldown Mult |
|-------|-----------|---------------|
| ≤$0.55 | 1.0x | 1.0x |
| $0.58 | 0.94x | 1.1x |
| $0.60 | 0.90x | 1.17x |
| $0.63 | 0.84x | 1.27x |
| $0.65 | 0.80x | 1.33x |
| $0.68 | 0.74x | 1.43x |
| $0.70 | 0.70x | 1.5x |
| >$0.70 | 0.50x | 2.0x |

---

## Dynamic Cooldown

```typescript
private calculateDynamicCooldown(price: number): number {
  const MIN_COOLDOWN = 10000;   // 10 seconds (floor)
  const MAX_COOLDOWN = 120000;  // 120 seconds (cap)

  const cooldownMultiplier = getPriceMultiplier(price, 'cooldown');
  const scaledCooldown = Math.floor(this.tradeCooldown * cooldownMultiplier);

  return Math.min(MAX_COOLDOWN, Math.max(MIN_COOLDOWN, scaledCooldown));
}
```

**Examples (base cooldown = 30s):**
| Price | Multiplier | Scaled | Final |
|-------|------------|--------|-------|
| $0.50 | 1.0x | 30s | 30s |
| $0.55 | 1.0x | 30s | 30s |
| $0.60 | 1.17x | 35s | 35s |
| $0.65 | 1.33x | 40s | 40s |
| $0.70 | 1.5x | 45s | 45s |
| $0.75 | 2.0x | 60s | 60s |

---

## Flip Buy Sizing (V17)

Flip buys use a different formula - cost-balance to achieve target pair cost:

```typescript
private calculateFlipBuySize(newSide: Side, newPrice: number): number {
  // V83: At flip limit, emergency mode takes over
  if (flipCount >= FLIP_LIMIT) return 0;

  const cycleState = cycleTracker.getState();
  const existingGap = oppSideQty - newSideQty;

  // V73: Lock discount based on opposite price
  const oppositePrice = 1 - newPrice;
  const lockDiscount = Math.max(0.05, oppositePrice * 0.20);

  // V85: Flip-adjusted pair cost (1% for flip 1-2, 2% for flip 3+)
  const pairCostTarget = getFlipPairCostTarget();
  const lockTarget = pairCostTarget - newPrice - lockDiscount;

  // V54: Cost-balance formula
  const numerator = totalCycleCost - existingGap * lockTarget - newSideQty;
  const denominator = 1 - pairCostTarget + lockDiscount;
  const flipBuySize = Math.ceil(numerator / denominator);

  return Math.max(5, flipBuySize);  // Minimum 5 shares
}
```

**Key difference:** Flip buy size is determined by cost-balance formula, not capital spread.

---

## Cooldown Bypass

Cooldown is SKIPPED in these cases:
1. **Post-flip accumulation** - Immediate buy after flip triggers
2. **Lock orders** - Placed immediately after accumulation

```typescript
// In handlePriceUpdate():
if (!flipJustHappened) {
  const dynamicCooldown = calculateDynamicCooldown(higherPrice);
  if (now - lastTradeTime < dynamicCooldown) return;  // Enforce cooldown
}
// flipJustHappened = true → cooldown skipped
```

---

## Summary Table

| Scenario | Size | Cooldown |
|----------|------|----------|
| Normal accumulation @ $0.55 | Capital-based, capped at TRADE_SIZE | Base cooldown |
| Normal accumulation @ $0.65 | 0.8x base size | 1.33x base cooldown |
| Normal accumulation @ $0.75 | 0.5x base size | 2.0x base cooldown |
| Post-flip accumulation | Cost-balance formula | SKIPPED |
| Lock order | Based on imbalance | IMMEDIATE |

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `TRADE_SIZE` | 20 | Maximum accumulation size (shares) |
| `MARKET_BUDGET_PERCENT` | 35 | % of AUM allocated per market |
| `PAIR_COST_TARGET` | 0.98 | Target pair cost (affects sizing constraints) |

---

## Code Location

| Function | File | Line |
|----------|------|------|
| `calculateTradeCooldown()` | `BilateralStrategyV6.ts` | 80 |
| `getPriceMultiplier()` | `BilateralStrategyV6.ts` | 2125 |
| `calculateDynamicCooldown()` | `BilateralStrategyV6.ts` | 2146 |
| `calculateOptimalTradeSize()` | `BilateralStrategyV6.ts` | 2165 |
| `calculateFlipBuySize()` | `BilateralStrategyV6.ts` | 2224 |
