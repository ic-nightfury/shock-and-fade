# V68 Merge Mechanism

How hedged shares are merged back to USDC after cycle locks.

---

## Overview

When a cycle locks (min(UP, DOWN) > cost), the hedged shares can be **merged** back to USDC via the Builder Relayer. This is gas-free and converts equal amounts of UP + DOWN tokens into $1 USDC per pair.

**Key Feature:** 5-minute cooldown between merge attempts to avoid rate limiting.

---

## Merge Flow

```
Cycle Locks
    │
    ▼
Display Celebration
    │ "🎉 CYCLE N LOCKED!"
    │ "Total hedged: X shares"
    │ "Total cost: $Y"
    │ "Total profit: $Z (W%)"
    │
    ▼
Check Cooldown (5 min since last attempt?)
    │
    ├─► COOLDOWN ACTIVE
    │     └─► "X shares pending merge (cooldown: Ys remaining)"
    │     └─► Queue for retry when cooldown expires
    │
    └─► COOLDOWN PASSED (or first attempt)
          │
          ▼
    Try Merge (engine.hedgedQty)
          │
          ├─► SUCCESS
          │     └─► recordMerge() - deduct from engine
          │     └─► Clear pending queue
          │     └─► "✅ Merged X shares (tx: 0x...)"
          │
          └─► FAILURE
                └─► Shares stay in engine (no deduction)
                └─► Start 5-min cooldown
                └─► "📋 X shares pending - will retry after 5min cooldown"
```

---

## Key Points

### 1. Merge Timing
- Merge happens **at each cycle lock** (after celebration log)
- NOT at cycle start, NOT on timer

### 2. What Gets Merged
- **ALL** `engine.hedgedQty` (total accumulated shares)
- Includes any pending from previous failed merges
- Includes shares just locked in current cycle

### 3. Queue Mechanism
- Queue (`previousCycleHedged`) is **only used on failure**
- If merge fails, shares stay in engine and are queued for info
- Next cycle, engine still has them → will try again
- No double-counting because `recordMerge()` only called on success

### 4. Engine Sync
- On SUCCESS: `engine.recordMerge(amount)` deducts shares + proportional cost
- On FAILURE: Engine unchanged, shares remain for next attempt

---

## Tracking Variables

| Variable | Purpose | Resets When |
|----------|---------|-------------|
| `engine.hedgedQty` | Current hedged shares in engine | After successful merge |
| `previousCycleHedged` | Pending shares from failed merge (info only) | After successful merge |
| `lastMergeAttempt` | Timestamp of last merge attempt | New market |
| `MERGE_COOLDOWN` | 5 minutes (300000ms) | Constant |
| `totalProfitLocked` | Cumulative profit across ALL cycles | New market |
| `totalCostInvested` | Cumulative cost across ALL cycles | New market |

---

## Display Stats (Cycle Lock Celebration)

```
🎉 CYCLE 2 LOCKED!
   Cycle UP: 7 shares @ $0.600 ($4.34)
   Cycle DOWN: 7 shares @ $0.370 ($2.68)
   Cycle hedged: 7 shares
   Cycle cost: $7.02
   Cycle pair cost: $0.970
   Cycle profit: $0.21 ✅
   ────────────────
   Total hedged: 15 shares          ← engine.hedgedQty (before merge)
   Total cost: $14.92               ← totalCostInvested (cumulative, never decreases)
   Total profit: $0.46 (3.1%)       ← totalProfitLocked / totalCostInvested
   Current zone: $0.51-$0.92
   Flips this cycle: 0
==================================================

🔀 V68: Merging 15 total hedged shares...
   ✅ V68: Merged 15 shares (tx: 0x447dbf2c...)
```

---

## Failure & Cooldown Handling

```
🔀 V68: Merging 15 total hedged shares...
   ❌ V68: Merge failed (TRANSACTION_FAILED_ONCHAIN)
   📋 15 shares pending - will retry after 5min cooldown

[Next cycle locks 30 seconds later...]

🔀 V68: 22 shares pending merge (cooldown: 270s remaining)

[Next cycle locks 3 minutes later...]

🔀 V68: 29 shares pending merge (cooldown: 90s remaining)

[Next cycle locks 2 minutes later... cooldown expired]

🔀 V68: Merging 36 total hedged shares (includes 15 pending from last attempt)...
   ✅ V68: Merged 36 shares (tx: 0x...)
```

---

## Code Location

`src/strategies/BilateralStrategyV6.ts` - `handleProfitLocked()` method (lines ~4120-4165)

```typescript
// V68: Merge ALL hedged shares with 5-minute cooldown between attempts
const totalHedged = this.engine.hedgedQty;
if (totalHedged > 0) {
  const conditionId = this.marketState.market.conditionId;
  const now = Date.now();
  const timeSinceLastMerge = now - this.lastMergeAttempt;
  const cooldownRemaining = Math.max(0, this.MERGE_COOLDOWN - timeSinceLastMerge);

  // Check cooldown (skip if first attempt ever)
  if (this.lastMergeAttempt > 0 && cooldownRemaining > 0) {
    const cooldownSecs = Math.ceil(cooldownRemaining / 1000);
    console.log(`\n🔀 V68: ${totalHedged.toFixed(0)} shares pending merge (cooldown: ${cooldownSecs}s remaining)`);
    this.previousCycleHedged = totalHedged;
    this.previousCycleConditionId = conditionId;
  } else {
    // Cooldown passed - attempt merge
    const pendingNote = this.previousCycleHedged > 0
      ? ` (includes ${this.previousCycleHedged.toFixed(0)} pending from last attempt)`
      : '';
    console.log(`\n🔀 V68: Merging ${totalHedged.toFixed(0)} total hedged shares${pendingNote}...`);
    this.lastMergeAttempt = now;

    try {
      const mergeResult = await this.mergeClient.merge(conditionId, totalHedged);

      if (mergeResult.success && mergeResult.transactionHash) {
        this.engine.recordMerge(totalHedged);
        console.log(`   ✅ V68: Merged ${totalHedged.toFixed(0)} shares (tx: ...)`);
        this.previousCycleHedged = 0;
        this.previousCycleConditionId = null;
      } else {
        console.log(`   ❌ V68: Merge failed (${mergeResult.error})`);
        console.log(`   📋 ${totalHedged.toFixed(0)} shares pending - will retry after 5min cooldown`);
        this.previousCycleHedged = totalHedged;
        this.previousCycleConditionId = conditionId;
      }
    } catch (error) {
      console.log(`   ❌ V68: Merge error`);
      console.log(`   📋 ${totalHedged.toFixed(0)} shares pending - will retry after 5min cooldown`);
      this.previousCycleHedged = totalHedged;
      this.previousCycleConditionId = conditionId;
    }
  }
}
```

---

## Engine recordMerge()

`src/engine/ArbitrageEngine.ts`

```typescript
recordMerge(amount: number): void {
  // Subtract merged amount from quantities
  this.state.qtyUp = Math.max(0, this.state.qtyUp - amount);
  this.state.qtyDown = Math.max(0, this.state.qtyDown - amount);

  // Also subtract proportional costs
  if (prevQtyUp > 0) {
    const costPerShareUp = this.state.costUp / prevQtyUp;
    this.state.costUp = Math.max(0, this.state.costUp - amount * costPerShareUp);
  }
  if (prevQtyDown > 0) {
    const costPerShareDown = this.state.costDown / prevQtyDown;
    this.state.costDown = Math.max(0, this.state.costDown - amount * costPerShareDown);
  }
}
```

---

## Why V68 is Better Than V65

| Aspect | V65 (Old) | V68 (New) |
|--------|-----------|-----------|
| **What merges** | Only previous cycle's shares | ALL accumulated shares |
| **Queue usage** | Every cycle queues | Only on failure |
| **Total stats** | Uses engine values (decrease after merge) | Uses cumulative trackers |
| **Example** | Cycle 2 has 15 hedged, merges 8 | Cycle 2 has 15 hedged, merges 15 |

---

## Related Files

| File | Purpose |
|------|---------|
| `src/services/MergeClient.ts` | Builder Relayer API for merging |
| `src/engine/ArbitrageEngine.ts` | State machine, `recordMerge()` |
| `STRATEGY.md` | Overall strategy documentation |
