# SetBasedSimulation_TradeFill V1.3 Changelog

## Overview

**Version**: V1.3 (Emergency Protection)  
**Base Version**: SetBasedSimulation_TradeFill.ts  
**File**: SetBasedSimulation_TradeFill_V1.3.ts  
**Date**: January 2026

V1.3 introduces **emergency protection mechanisms** to prevent runaway position accumulation and excessive dilution that could lead to significant losses.

---

## Summary of Changes

| Feature | Description |
|---------|-------------|
| **Position Size Cap** | Emergency hedge when total position exceeds `MAX_POSITION_SIZE` (default: 1500 shares) |
| **Dilute Count Cap** | Emergency hedge after `MAX_DILUTES_PER_WINDOW` dilute operations (default: 8) |
| **Emergency Hedge Method** | New `executeEmergencyHedge()` method for immediate market hedge |
| **Environment Variables** | Configurable via `V13_MAX_POSITION_SIZE` and `V13_MAX_DILUTES` |
| **Dynamic Accumulation** | `ACCUM_MAX_SHARES` scales with account balance, hard capped at 30 |

---

## Detailed Changes

### 1. New Properties (Emergency Protection State)

**Location**: Class properties section (lines 279-289)

```typescript
// V1.3: Emergency protection thresholds
private readonly MAX_POSITION_SIZE: number = parseInt(
  process.env.V13_MAX_POSITION_SIZE || "1500",
); // Emergency hedge if total position exceeds this

private readonly MAX_DILUTES_PER_WINDOW: number = parseInt(
  process.env.V13_MAX_DILUTES || "8",
); // Emergency hedge after this many dilutes

private dilutesThisWindow: number = 0;        // Count of dilute operations this window
private emergencyHedgeTriggered: boolean = false;  // Flag to prevent multiple emergency hedges
```

**Purpose**: 
- `MAX_POSITION_SIZE`: Prevents position from growing too large (e.g., in a volatile market with many trigger fills)
- `MAX_DILUTES_PER_WINDOW`: Limits dilution operations to prevent chasing a bad position
- Tracking variables reset each window

---

### 2. Position Size Check in fillOrder()

**Location**: `fillOrder()` method, after position update (lines 827-840)

**Before (Base)**:
```typescript
// No position cap check
```

**After (V1.3)**:
```typescript
// V1.3: Check position size threshold for emergency hedge
const totalPosition = this.position.upQty + this.position.downQty;
if (
  totalPosition >= this.MAX_POSITION_SIZE &&
  !this.emergencyHedgeTriggered
) {
  this.dashLog(
    `   ⚠️ [V1.3] POSITION CAP REACHED (${totalPosition.toFixed(0)}/${this.MAX_POSITION_SIZE}) - triggering emergency hedge`,
    "warn",
  );
  setImmediate(() => this.executeEmergencyHedge("POSITION_CAP"));
}
```

**Purpose**: After every fill, checks if total position exceeds the cap. Uses `setImmediate()` to avoid blocking the fill handler.

---

### 3. Dilute Count Check in placeHedgeForSet()

**Location**: `placeHedgeForSet()` method, dilute logic section (lines 1602-1621)

**Before (Base)**:
```typescript
if (dilute && dilute.hedgeQty > 0) {
  const existingSide = hedgeSide;
  const hedgeAvg = hedgeSideQty > 0 ? hedgeSideCost / hedgeSideQty : 0;
  console.log(
    `   M${currentMinute.toFixed(1)} | 📌 DILUTE HEDGE: ${existingSide} avg $${hedgeAvg.toFixed(2)} → ${dilute.hedgeQty} @ $${dilute.hedgePrice.toFixed(2)}`,
  );
  // ... continue with dilute hedge
}
```

**After (V1.3)**:
```typescript
if (dilute && dilute.hedgeQty > 0) {
  // V1.3: Increment dilute counter and check threshold
  this.dilutesThisWindow++;
  if (
    this.dilutesThisWindow >= this.MAX_DILUTES_PER_WINDOW &&
    !this.emergencyHedgeTriggered
  ) {
    this.dashLog(
      `   ⚠️ [V1.3] DILUTE CAP REACHED (${this.dilutesThisWindow}/${this.MAX_DILUTES_PER_WINDOW}) - triggering emergency hedge`,
      "warn",
    );
    this.executeEmergencyHedge("DILUTE_CAP");
    return;
  }

  const existingSide = hedgeSide;
  const hedgeAvg = hedgeSideQty > 0 ? hedgeSideCost / hedgeSideQty : 0;
  console.log(
    `   M${currentMinute.toFixed(1)} | 📌 DILUTE HEDGE: ${existingSide} avg $${hedgeAvg.toFixed(2)} → ${dilute.hedgeQty} @ $${dilute.hedgePrice.toFixed(2)} [dilute #${this.dilutesThisWindow}]`,
  );
  // ... continue with dilute hedge
}
```

**Purpose**: Counts dilute operations and triggers emergency hedge if cap is exceeded. Log message now includes dilute count.

---

### 4. Dynamic Accumulation Size

**Location**: `preplaceAccumulationOrders()` method (lines 1514-1519)

**Before (Base)**:
```typescript
const ACCUM_MAX_SHARES = 30; // Hard cap per accumulation order
```

**After (V1.3)**:
```typescript
// Use config value (env: SET_ACCUM_MAX, default 112) but cap at 30 and scale with account size
const ACCUM_MAX_SHARES = Math.min(
  30, // V1.3: Hard cap at 30 shares
  this.config.accumulationMaxSize,
  Math.floor(this.initialBalance / 100),
);
```

**Purpose**: Accumulation order size now scales with account balance while maintaining a hard cap of 30 shares. A $1000 account caps at 10 shares, a $5000 account caps at 30 shares (not 50), preventing oversized accumulation orders.

---

### 5. New executeEmergencyHedge() Method

**Location**: End of class (lines 4008-4118)

```typescript
/**
 * V1.3: Execute emergency hedge when position or dilute thresholds are exceeded.
 * This immediately hedges all unhedged position to prevent further losses.
 */
private executeEmergencyHedge(reason: "POSITION_CAP" | "DILUTE_CAP"): void {
  if (this.emergencyHedgeTriggered) return;
  this.emergencyHedgeTriggered = true;

  const hedged = Math.min(this.position.upQty, this.position.downQty);
  const unhedgedUp = this.position.upQty - hedged;
  const unhedgedDown = this.position.downQty - hedged;
  const currentMinute = this.getCurrentMinute();

  this.dashLog(
    `\n   🚨 [V1.3] EMERGENCY HEDGE TRIGGERED (${reason}) at M${currentMinute.toFixed(1)}`,
    "error",
  );
  this.dashLog(
    `         | Position: UP ${this.position.upQty.toFixed(0)} / DOWN ${this.position.downQty.toFixed(0)} | Unhedged: UP ${unhedgedUp.toFixed(0)} / DOWN ${unhedgedDown.toFixed(0)}`,
    "warn",
  );

  // Cancel all pending orders
  for (const [orderId, order] of this.pendingOrders.entries()) {
    dashboardRelay.orderCancelled(orderId, order.side, order.limitPrice);
  }
  this.pendingOrders.clear();
  this.activeSETs.clear();

  // Determine which side needs hedging
  const hedgeDeficit = Math.abs(unhedgedUp - unhedgedDown);
  if (hedgeDeficit < 1) {
    this.dashLog(`         | Already balanced, no hedge needed`, "info");
    this.isTotalHedged = true;
    this.marketExited = true;
    return;
  }

  const hedgeSide: "UP" | "DOWN" = unhedgedUp > unhedgedDown ? "DOWN" : "UP";
  const hedgeQty = hedgeDeficit;

  // Get current ask for the hedge side
  const hedgeTokenId = hedgeSide === "UP" ? this.upTokenId : this.downTokenId;
  const hedgeAsk = this.lastAsk.get(hedgeTokenId) || 0.6;

  // Simulate immediate market fill at ask price
  const cost = hedgeQty * hedgeAsk;
  this.simBalance -= cost;

  // Update position...
  // Update lifetime stats...
  // Record trade...
  // Log final position...
  
  // Mark as fully hedged and exited
  this.isTotalHedged = true;
  this.marketExited = true;

  // Emit position update to dashboard
  dashboardRelay.positionUpdate(...);
}
```

**Key Behaviors**:
1. **Idempotent**: Uses `emergencyHedgeTriggered` flag to prevent multiple triggers
2. **Cancels All Orders**: Clears `pendingOrders` and `activeSETs`
3. **Immediate Market Fill**: Uses current ASK price (simulated)
4. **Dashboard Integration**: Emits order cancellation and position updates
5. **Exits Market**: Sets `isTotalHedged = true` and `marketExited = true`

---

### 6. Reset Logic Updates

Emergency protection state is reset in three places:

**a) Window Start** (`initNewMarket()` at lines 399-400):
```typescript
this.dilutesThisWindow = 0;       // V1.3: Reset dilute counter
this.emergencyHedgeTriggered = false;  // V1.3: Reset emergency hedge flag
```

**b) Cleanup** (`cleanupAndPrepareForNextWindow()` at lines 3461-3462):
```typescript
this.dilutesThisWindow = 0;       // V1.3: Reset dilute counter
this.emergencyHedgeTriggered = false;  // V1.3: Reset emergency hedge flag
```

**c) Hard Reset** (`performHardReset()` at lines 3944-3946):
```typescript
// V1.3: Reset emergency protection state
this.dilutesThisWindow = 0;
this.emergencyHedgeTriggered = false;
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `V13_MAX_POSITION_SIZE` | `1500` | Maximum total position (UP + DOWN) before emergency hedge |
| `V13_MAX_DILUTES` | `8` | Maximum dilute operations per window before emergency hedge |

### Example Configuration

```bash
# Conservative settings for small accounts
V13_MAX_POSITION_SIZE=500
V13_MAX_DILUTES=4

# Aggressive settings for large accounts
V13_MAX_POSITION_SIZE=3000
V13_MAX_DILUTES=15
```

---

## When Emergency Hedge Triggers

### Position Cap Scenario
```
Window opens at $1000 balance
Multiple triggers fill rapidly in volatile market
Position grows: UP 800 / DOWN 700 = 1500 total
⚠️ POSITION CAP REACHED → Emergency hedge 100 DOWN at market
Final: UP 800 / DOWN 800 (fully hedged)
```

### Dilute Cap Scenario
```
Trigger fill creates imbalanced position
Strategy dilutes to improve average: dilute #1
Price moves again, another dilute: dilute #2
... continues ...
Dilute #8 attempted
⚠️ DILUTE CAP REACHED → Emergency hedge at market
```

---

## Rationale

### Why Position Size Cap?
In highly volatile markets with many trigger fills, position can grow unchecked. A 1500-share position at $0.50 avg = $750 at risk. Capping prevents catastrophic losses.

### Why Dilute Count Cap?
Diluting repeatedly in a trending market is a losing strategy (chasing). After 8 dilutes, the market has clearly moved against us - better to lock in the loss via emergency hedge than continue diluting.

### Why Dynamic Accumulation Size?
Fixed 30-share accumulation on a $500 account = 6% per order (risky). Dynamic sizing ensures accumulation orders are proportional to account size.

---

## Log Examples

### Position Cap Warning
```
   ⚠️ [V1.3] POSITION CAP REACHED (1500/1500) - triggering emergency hedge

   🚨 [V1.3] EMERGENCY HEDGE TRIGGERED (POSITION_CAP) at M8.5
         | Position: UP 900 / DOWN 600 | Unhedged: UP 300 / DOWN 0
         | EMERGENCY FILL: DOWN 300 @ $0.55 (market)
         | Final position: UP 900@$0.48 DOWN 900@$0.52 | pair $1.00
```

### Dilute Cap Warning
```
   M6.2 | 📌 DILUTE HEDGE: DOWN avg $0.58 too high → 20 @ $0.52 [dilute #7]
   M7.1 | 📌 DILUTE HEDGE: DOWN avg $0.56 too high → 15 @ $0.53 [dilute #8]
   ⚠️ [V1.3] DILUTE CAP REACHED (8/8) - triggering emergency hedge
```

---

## Testing Recommendations

1. **Test Position Cap**: Set `V13_MAX_POSITION_SIZE=100` and run on volatile asset
2. **Test Dilute Cap**: Set `V13_MAX_DILUTES=3` and observe behavior
3. **Verify Resets**: Ensure counters reset properly at window boundaries
4. **Dashboard Integration**: Confirm emergency fills appear in dashboard

---

## Files Modified

| File | Changes |
|------|---------|
| `SetBasedSimulation_TradeFill_V1.3.ts` | New version with emergency protection |
| `SetBasedSimulation_TradeFill.ts` | Base version (unchanged) |

---

## Upgrade Path

To upgrade from base to V1.3:
1. Update run script to use `SetBasedSimulation_TradeFill_V1.3.ts`
2. Optionally set `V13_MAX_POSITION_SIZE` and `V13_MAX_DILUTES` env vars
3. Monitor logs for `[V1.3]` tagged messages
