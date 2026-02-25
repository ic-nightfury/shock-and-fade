# Surge/Switch Loss Analysis and Alternative Solutions

**Date:** 2026-01-12  
**Context:** Analysis of losses in SetBasedSimulation_TradeFill.ts caused by multiple surges, supply breaks, and flips in volatile windows.

---

## Executive Summary

The base simulation strategy suffers significant losses in volatile windows due to **unlimited switching** on surge detection. Each SURGE triggers a SWITCH (cancel + market buy), which incrementally increases pair cost. In choppy markets with 50-90+ surges per window, pair costs escalate to $1.01-$1.35, causing losses of $20-$290 per window.

**V1.3 Emergency Protection** addresses this with hard caps on position size (1500 shares), dilutes per window (8), and accumulation size (30 shares). However, deeper algorithmic changes could further improve outcomes.

---

## Problem Analysis

### Loss Data from Production Logs (Finland Server)

| Window ID | Surge Count | Pair Cost | Hedged Pairs | Loss |
|-----------|-------------|-----------|--------------|------|
| btc-updown-15m-1768007700 | **89** | $1.030 | 889 | -$26.66 |
| btc-updown-15m-1768091400 | **78** | $1.030 | 408 | -$12.23 |
| btc-updown-15m-1767978000 | **53** | $1.012 | 5,595 | -$69.09 |
| btc-updown-15m-1768064400 | **53** | $1.013 | 5,027 | -$63.79 |
| btc-updown-15m-1768048200 | **41** | $1.014 | 406 | -$5.71 |
| btc-updown-15m-1768027500 | **33** | $1.000 | 1,714 | -$0.00 |
| btc-updown-15m-1768018500 | **21** | $1.026 | 670 | -$17.13 |
| btc-updown-15m-1768095000 | **14** | $1.030 | 661 | -$19.81 |
| btc-updown-15m-1768032900 | **12** | $1.013 | 2,430 | -$32.62 |

**Key Observation:** Windows with 50+ surges consistently produce $25-$70 losses.

### Loss Data from Helsinki Server

| Pair Cost | Hedged Pairs | Loss |
|-----------|--------------|------|
| $1.041 | 422 | -$289.33 |
| $1.141 | 65 | -$156.37 |
| $1.030 | 108 | -$73.45 |

**Helsinki shows even larger losses** with pair costs reaching $1.14 (14c loss per pair).

### Root Cause: Unlimited Switching

```
Market Oscillates → SURGE Detected → SWITCH Triggered → 
Cancel Orders + Market Buy at ASK → Higher Pair Cost →
Market Reverses → Another SURGE → Another SWITCH →
[Repeat 50-90 times] → Pair Cost $1.02-$1.35 → LOSS
```

Each SWITCH operation:
1. Cancels existing orders on old side
2. Places MARKET order at ASK (worst price)
3. Places HEDGE order at calculated price
4. **Adds cost with no guaranteed hedge fill**

In choppy markets, this creates a **death spiral** where pair cost keeps increasing.

---

## What V1.3 Emergency Protection Does

### 1. MAX_POSITION_SIZE = 1500 shares
- Hard cap on total position (UP + DOWN shares)
- Limits maximum capital at risk
- **Effect:** Prevents accumulation beyond 1500 shares

### 2. MAX_DILUTES_PER_WINDOW = 8
- Limits number of dilute/switch attempts per 15-minute window
- After 8 switches, triggers EMERGENCY HEDGE
- **Effect:** Caps switching losses at 8 iterations

### 3. ACCUM_MAX_SHARES = 30 (hard cap)
- Dynamic accumulation size capped at 30
- Previously could scale with account size
- **Effect:** Smaller per-trade exposure

### 4. Emergency Hedge Trigger
- When dilute count exceeds limit OR pair cost > threshold
- Buys hedge to balance position and exits
- **Effect:** Stops bleeding, accepts loss, moves on

---

## Alternative Solutions (From ARBITRAGE_STRATEGY.md Analysis)

### Alternative A: Volatility-Based Switch Cooldown

**Concept:** After N switches, enter cooldown mode. During cooldown, STOP switching and use **Reversal Guard** instead.

**Implementation:**
```typescript
const MAX_SWITCHES_BEFORE_COOLDOWN = 3;
const COOLDOWN_DURATION_MINUTES = 2;

if (switchCount >= MAX_SWITCHES_BEFORE_COOLDOWN) {
  enterCooldownMode();
  // During cooldown: buy BOTH sides on price movement
  // Use reversal guard logic instead of switching
}
```

**Pros:**
- Stops death spiral early
- Reversal guard buys both sides = guaranteed hedge
- Meets in middle with good averages

**Cons:**
- May miss directional profits if market trends after cooldown
- Requires cooldown duration tuning

---

### Alternative B: Pair Cost-Based Switch Guard

**Concept:** If pair cost exceeds threshold, STOP switching immediately.

**Implementation:**
```typescript
const SWITCH_STOP_PAIR_COST = 0.98;

if (pairCost >= SWITCH_STOP_PAIR_COST) {
  // NO MORE SWITCHES - position is already expensive
  enterPairImprovementMode();
  // Only buy BELOW current averages
}
```

**Pros:**
- Direct protection against cost escalation
- Leverages existing PAIR_IMPROVEMENT mode
- Simple to implement

**Cons:**
- May lock in bad position if can't improve
- Requires functioning PAIR_IMPROVEMENT mode

---

### Alternative C: Time-Based Switch Budget

**Concept:** Allocate a fixed "switch budget" per window.

**Implementation:**
```typescript
const SWITCH_BUDGET_PER_WINDOW = 4;
let switchesUsed = 0;

function onSurgeDetected() {
  if (switchesUsed < SWITCH_BUDGET_PER_WINDOW) {
    executeSwitch();
    switchesUsed++;
  } else {
    // Budget exhausted - hold position
    enterHoldMode();
  }
}
```

**Pros:**
- Predictable maximum switches
- V1.3 already implements this with MAX_DILUTES_PER_WINDOW = 8
- Simple and effective

**Cons:**
- Budget may run out early in trending markets
- Fixed budget doesn't adapt to conditions

---

### Alternative D: Oscillation Detection

**Concept:** Track price direction history. If oscillating (UP,DOWN,UP,DOWN), market is choppy - increase surge threshold dramatically.

**Implementation:**
```typescript
const directionHistory: ('UP'|'DOWN')[] = [];
const HISTORY_SIZE = 6;

function isOscillating(): boolean {
  if (directionHistory.length < HISTORY_SIZE) return false;
  // Check for alternating pattern
  for (let i = 1; i < directionHistory.length; i++) {
    if (directionHistory[i] === directionHistory[i-1]) return false;
  }
  return true; // All alternating = oscillating
}

function getSurgeThreshold(): number {
  if (isOscillating()) {
    return 0.15; // 15c surge needed (vs normal 8c)
  }
  return 0.08; // Normal 8c threshold
}
```

**Pros:**
- Adapts to market conditions
- Reduces false surge detections in choppy markets
- Preserves ability to catch real trends

**Cons:**
- Requires history tracking
- May delay response to real trends
- Threshold tuning needed

---

### Alternative E: "Ride It Out" Mode

**Concept:** Once position is established with good pair cost (<$0.95), STOP all switching. Let market settle and only do PROFIT_LOCK when opportunity arises.

**Implementation:**
```typescript
const LOCK_IN_PAIR_COST = 0.95;
const LOCK_IN_MIN_PAIRS = 100;

if (pairCost < LOCK_IN_PAIR_COST && hedgedPairs >= LOCK_IN_MIN_PAIRS) {
  enterRideItOutMode();
  // Only actions allowed:
  // 1. PROFIT_LOCK if opportunity arises
  // 2. Wait for settlement
  // NO switching, NO new accumulation
}
```

**Pros:**
- Locks in good position
- Zero risk of degradation
- Preserves profit margin

**Cons:**
- Misses potential for better position
- May sit idle with unused capital
- Requires good initial position

---

### Alternative F: Reversal Guard Integration (From ARBITRAGE_STRATEGY.md)

The existing `BALANCING` mode has a **Reversal Guard** that buys BOTH sides when price drops:

```typescript
// From ARBITRAGE_STRATEGY.md
const reversalDrop = firstTriggerFillPrice - currentBid;
if (reversalDrop >= 0.05) {
  const guardLevel = Math.floor(reversalDrop / 0.05);  // 1-5
  
  // Buy BOTH sides progressively
  const triggerBuySize = BASE_GUARD_SIZE * guardLevel;
  const hedgeBuySize = BASE_GUARD_SIZE * Math.max(1, 5 - guardLevel);
  
  placeOrder(triggerSide, currentAsk, triggerBuySize);
  placeOrder(hedgeSide, currentAsk, hedgeBuySize);
}
```

**Concept:** Instead of SWITCHING on surge, use reversal guard logic to buy BOTH sides.

**Pros:**
- Every buy is hedged immediately
- No single-side exposure
- Progressive sizing based on magnitude

**Cons:**
- Uses more capital per event
- May not maximize directional profit

---

## Recommended Hybrid Approach

Combine the best elements:

### Phase 1: Early Window (M0-M5)
- Use standard surge/switch logic (allow directional bets)
- Max 4 switches allowed
- Track oscillation pattern

### Phase 2: Mid Window (M5-M10)
- If oscillation detected OR pair cost > $0.96:
  - STOP switching
  - Use reversal guard (buy both sides) on price movement
- Focus on maintaining/improving pair cost

### Phase 3: Late Window (M10-M14)
- No new switches
- Only PROFIT_LOCK if available
- Prepare for settlement

### Emergency Triggers (Any Time)
- If pair cost > $1.00: Emergency hedge and stop
- If switches > 8: Emergency hedge and stop
- If position > 1500: Stop accumulation

---

## V1.3 vs Recommended Improvements

| Feature | V1.3 | Recommended |
|---------|------|-------------|
| Switch limit | 8 per window | 4 early, 0 late |
| Position cap | 1500 shares | Keep |
| Accum cap | 30 shares | Keep |
| Oscillation detection | No | Add |
| Reversal guard | No | Add for mid/late window |
| Pair cost switch guard | No | Add at $0.96 |
| Time-phased logic | No | Add 3 phases |

---

## Implementation Priority

1. **High Priority (V1.4):**
   - Oscillation detection with adaptive surge threshold
   - Pair cost-based switch guard ($0.96 threshold)

2. **Medium Priority (V1.5):**
   - Time-phased logic (early/mid/late)
   - Reversal guard integration for mid-window

3. **Low Priority (V2.0):**
   - Full ARBITRAGE_STRATEGY.md mode integration
   - Multi-cycle balancing with reversal guard

---

## Metrics to Track

- Surge count per window
- Switch count per window
- Final pair cost
- Window PnL
- Oscillation frequency
- Switch effectiveness (% that led to profitable position)

---

## Conclusion

The core problem is **unlimited switching in oscillating markets**. V1.3's hard caps (8 dilutes, 1500 position, 30 accum) are effective stopgaps but don't address the root cause.

The recommended approach adds:
1. **Oscillation detection** to raise surge threshold in choppy markets
2. **Pair cost guard** to stop switching when position is already expensive
3. **Time-phased logic** to reduce risk in late window

These changes would transform the strategy from "reactive switching" to "adaptive accumulation" - better suited for volatile crypto markets.

---

*Analysis by Claude | 2026-01-12*
