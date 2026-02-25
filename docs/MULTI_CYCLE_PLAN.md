# Multi-Cycle Refactor Plan

## Goal
Enable `maxCyclesPerGame=2` (currently hardcoded to 1) without breaking any existing single-cycle behavior.

## Current Architecture (maxCyclesPerGame=1)

```
Market: LAC@MIN
  └── 1 CumulativeTP (keyed by marketSlug)
  └── N LiveLadderOrders (tagged with shockId)
  └── N LivePositions (tagged with shockId)
  └── 1 MarketInventory (shared pool)
```

**Key invariant today:** One cycle at a time per market, so keying TP by marketSlug = keying by cycle.

## What Changes

### Change 1: CumulativeTP keyed by shockId (not marketSlug)

**Current:** `cumulativeTPs: Map<string, CumulativeTP>` keyed by `marketSlug`
**New:** `cumulativeTPs: Map<string, CumulativeTP>` keyed by `shockId`

**Why:** With 2 cycles, each shock generates an independent set of ladder orders and needs an independent TP. Keying by marketSlug blends entries across cycles (the -219¢ bug).

**Impact radius:**
- `updateCumulativeTP()` — change lookup key from marketSlug → shockId
- `completeCumulativeTP()` — change delete key
- `eventExitCumulativeTP()` — change delete key
- `handlePriceUpdate()` — iterate all TPs for the held token (already does this)
- `handleGameEvent()` — find TP(s) by marketSlug, exit only adverse ones
- `handleScoringRun()` — find all TPs for market, exit all
- `handleExtremePrice()` — find all TPs for market, exit all
- `pollRestingOrderFills()` — passes shockId to updateCumulativeTP (already correct)
- State persistence — `loadState()`/`saveState()` must handle new key scheme
- Dashboard events — `tpUpdate` emitted with shockId for filtering

**Helper needed:** `getCumulativeTPsForMarket(marketSlug): CumulativeTP[]` — iterate map, filter by marketSlug.

### Change 2: Per-cycle event exit

**Current:** `handleGameEvent(marketSlug)` closes ALL open positions and ALL TPs for that market.

**New:** `handleGameEvent(marketSlug, eventTeam)` must:
1. Find all active cycles (via cumulativeTPs + positions) for this market
2. For each cycle, look up the `shockTeam` (stored on the TP or positions)
3. If `eventTeam === cycle.shockTeam` → ADVERSE → exit that cycle
4. If `eventTeam !== cycle.shockTeam` → FAVORABLE → hold that cycle
5. If `eventTeam` or `shockTeam` is unknown → exit conservatively (same as today)

**Requires:** Store `shockTeam` on `CumulativeTP`. Currently only stored on the shock event, not passed through.

**Change to CumulativeTP interface:**
```typescript
export interface CumulativeTP {
  // ... existing fields ...
  shockTeam: string | null;  // NEW — team that caused the shock
}
```

**Change to `processShock()`:** Pass `shock.shockTeam` through to `updateCumulativeTP()`.

**Note:** With 2 concurrent cycles, it's possible that:
- Cycle 1: shock from Team A scoring → sell A tokens → adverse if A scores again
- Cycle 2: shock from Team B scoring → sell B tokens → adverse if B scores again
- If A scores: cycle 1 exits (adverse), cycle 2 holds (favorable) ✅

### Change 3: Inventory sizing for 2 cycles

**Current:** `preSplitSize = cycleSize + L1 + L2 = 35 + 5 + 10 = 50`
**New:** `preSplitSize = (cycleSize × maxCyclesPerGame) + L1 + L2`
  - For maxCyclesPerGame=2: `(35 × 2) + 5 + 10 = 85`

**Change in constructor:**
```typescript
this.preSplitSize = (this.cycleSize * this.config.maxCyclesPerGame) 
  + (this.ladderSizes[0] || 0) + (this.ladderSizes[1] || 0);
```

**Inventory check in `placeLadderOrders()`:** Already checks per-level. No change needed — if cycle 1 consumed 35 shares and we split 85, cycle 2 has 50 shares available (35 + 15 buffer).

### Change 4: Dashboard cycle grouping

**Current:** Dashboard groups active orders/TPs by market. With 2 cycles, orders from different shocks intermingle.

**New:** Group by `shockId` within each market. Show cycle badge (Cycle 1, Cycle 2) or shock timestamp.

**Dashboard changes (shock-fade-ui.html):**
- Active Orders section: group orders by `shockId`, show cycle header
- TP section: show one row per cycle's TP (not one per market)
- Trade History: already has shockId — no change needed

### Change 5: Cycle count in processShock gate

**Current (line ~582):**
```typescript
const gameActiveCycles = new Set([
  ...gameOpenPositions.map(p => p.shockId || 'pos'),
  ...gameRestingOrders.map(o => o.shockId || 'order'),
]).size;
```

This correctly counts unique shockIds. **No change needed** — already works for N cycles.

---

## Acceptance Criteria

### AC-1: Single-cycle backward compatibility
When `maxCyclesPerGame=1`, behavior is IDENTICAL to current code:
- [ ] Same shock detection, same classification, same entry logic
- [ ] Same TP creation, update, and completion
- [ ] Same event exit behavior
- [ ] Same P&L calculation
- [ ] Same dashboard display
- [ ] State file from old format loads correctly (migration)

### AC-2: Two concurrent cycles in same game
- [ ] Shock #1 fires → cycle 1 ladder placed, TP created with shockId_1
- [ ] Shock #2 fires (different event, <30s later) → cycle 2 ladder placed, separate TP created with shockId_2
- [ ] Cycle 1 and cycle 2 have INDEPENDENT TP prices (no blending)
- [ ] Cycle 1 fills do NOT affect cycle 2's TP, and vice versa
- [ ] Both TPs are visible on dashboard as separate entries

### AC-3: Per-cycle event exit
- [ ] Adverse event for cycle 1 (same shock team) → cycle 1 exits, cycle 2 holds
- [ ] Adverse event for cycle 2 (same shock team) → cycle 2 exits, cycle 1 holds
- [ ] Unknown team event → both cycles exit (conservative)
- [ ] Scoring run → both cycles exit (same as today)

### AC-4: Inventory management
- [ ] Pre-split size = `(cycleSize × maxCyclesPerGame) + buffer`
- [ ] Cycle 1 deducts shares → remaining shares available for cycle 2
- [ ] Cancelled orders return shares to shared pool (usable by either cycle)
- [ ] When both cycles complete/exit → shares are balanced for merge

### AC-5: TP lifecycle per cycle
- [ ] Each cycle has independent TP keyed by shockId
- [ ] TP fill for cycle 1 → closes cycle 1 positions only, cancels cycle 1 resting orders
- [ ] TP fill for cycle 2 → closes cycle 2 positions only, cancels cycle 2 resting orders  
- [ ] No cross-contamination between cycles
- [ ] Completed TP removed from map (prevents -219¢ blending bug)

### AC-6: Extreme price exit
- [ ] When price hits >99¢ or <1¢, ALL cycles for that market exit
- [ ] All TPs cancelled, all positions closed, shares merged

### AC-7: State persistence
- [ ] State file saves/loads with shockId-keyed TPs
- [ ] Old state files (marketSlug-keyed) are migrated on load
- [ ] Restart mid-cycle preserves both cycles correctly

### AC-8: Dashboard display
- [ ] Active Orders grouped by cycle (shockId)
- [ ] Each cycle's TP shown separately
- [ ] Cycle identifier visible (e.g., "Cycle 1", "Cycle 2" or timestamp)

---

## Unit Tests

### Test file: `src/__tests__/multi-cycle.test.ts`

Using Node's built-in test runner (`node:test`) + assert — no external test framework needed.

```
Test Suite: Multi-Cycle ShockFadeLive
├── Setup: Create mock WS, SplitClient, MergeClient, PolymarketClient
│
├── Group: Backward Compatibility (maxCyclesPerGame=1)
│   ├── test: single shock creates one TP keyed by shockId
│   ├── test: second shock on same market is rejected (cycle limit)
│   ├── test: TP completion deletes TP and closes positions
│   ├── test: event exit closes all positions and TP for market
│   ├── test: cancelled orders return shares to inventory
│   └── test: state save/load round-trips correctly
│
├── Group: Two Concurrent Cycles (maxCyclesPerGame=2)
│   ├── test: two shocks create two independent TPs
│   ├── test: third shock on same market is rejected (cycle limit=2)
│   ├── test: cycle 1 TP fill does not affect cycle 2
│   ├── test: cycle 2 TP fill does not affect cycle 1
│   ├── test: both TPs have correct independent blended prices
│   ├── test: ladder fill on cycle 1 updates only cycle 1 TP
│   └── test: ladder fill on cycle 2 updates only cycle 2 TP
│
├── Group: Per-Cycle Event Exit
│   ├── test: adverse event exits only the matching cycle
│   ├── test: favorable event holds both cycles
│   ├── test: unknown team exits all cycles (conservative)
│   ├── test: scoring run exits all cycles
│   └── test: extreme price exits all cycles
│
├── Group: Inventory Management
│   ├── test: preSplitSize scales with maxCyclesPerGame
│   ├── test: cycle 1 consumes shares, cycle 2 uses remainder
│   ├── test: cancelled cycle 1 order shares available for cycle 2
│   └── test: insufficient inventory skips ladder levels gracefully
│
├── Group: State Persistence
│   ├── test: save/load with two active cycles
│   ├── test: migration from old marketSlug-keyed state
│   └── test: restart reconstructs both TPs from state
│
└── Group: Dashboard Events
    ├── test: tpUpdate emitted with shockId for each cycle
    ├── test: positionClosed emitted per-cycle on TP fill
    └── test: orderCancelled emitted per-cycle
```

### Mock Strategy

```typescript
// Minimal mocks — just enough to test the trading logic
class MockWS extends EventEmitter {
  simulatePriceUpdate(tokenId: string, bid: number, ask: number) {
    this.emit("priceUpdate", { tokenId, bid, ask, timestamp: Date.now() });
  }
}

class MockPolyClient {
  cancelledOrders: string[] = [];
  placedOrders: { tokenId: string; shares: number; price: number }[] = [];
  
  async sellSharesGTC(tokenId: string, shares: number, price: number, negRisk: boolean) {
    const orderId = `mock_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    this.placedOrders.push({ tokenId, shares, price });
    return { success: true, orderID: orderId };
  }
  
  async cancelSingleOrder(orderId: string) {
    this.cancelledOrders.push(orderId);
    return { success: true };
  }
  
  async getOpenOrders(conditionId: string) {
    return { success: true, orders: [] };
  }
  
  async getTokenBalance(tokenId: string) { return 100; }
  async getBalance() { return 1000; }
}
// Similar minimal mocks for SplitClient, MergeClient
```

### Running tests
```bash
npx tsx --test src/__tests__/multi-cycle.test.ts
```

---

## Implementation Order

1. **Write unit tests first** (test-driven) — all tests fail initially
2. **Change CumulativeTP key** from marketSlug → shockId
3. **Add `shockTeam` to CumulativeTP** and pass through from processShock
4. **Add `getCumulativeTPsForMarket()` helper**
5. **Refactor `handleGameEvent()`** for per-cycle exit
6. **Update `handleScoringRun()`** and `handleExtremePrice()` 
7. **Update `completeCumulativeTP()`** to only close positions matching shockId
8. **Update preSplitSize calculation**
9. **State migration** — handle old marketSlug-keyed state files
10. **Dashboard updates** — cycle grouping
11. **Run all tests** — all pass
12. **Manual scenario walkthrough** — dry-run with simulated shocks
13. **Deploy to Finland** — with maxCyclesPerGame=2

## Risk Mitigation

- **Feature flag:** `maxCyclesPerGame=1` is the safe default. Setting to 1 must produce IDENTICAL behavior to pre-refactor code.
- **No behavior change for maxCyclesPerGame=1:** All new code paths are gated behind `> 1 cycle` checks where possible.
- **State file migration:** Old format auto-detected and migrated on load.
- **Circuit breaker unchanged:** Same consecutive loss / session loss limits apply.
- **Dry-run first:** Deploy with `maxCyclesPerGame=2` in dry-run mode before live.

## Files Modified

| File | Change |
|------|--------|
| `src/strategies/ShockFadeLive.ts` | Core refactor — TP keying, event exit, inventory |
| `src/dashboard/shock-fade-ui.html` | Cycle grouping in Active Orders + TP display |
| `src/run-shock-fade-live.ts` | Pass shockTeam through classification → processShock |
| `src/__tests__/multi-cycle.test.ts` | NEW — unit tests |
| `package.json` | Add test script |

## Files NOT Modified

| File | Reason |
|------|--------|
| `ShockFadeDetector.ts` | Shock detection unchanged |
| `ShockFadePaper.ts` | Paper trader is separate, not refactored |
| `SplitClient.ts` / `MergeClient.ts` | Infrastructure unchanged |
| `PolymarketClient.ts` | API client unchanged |
| `NhlShockRecorder.ts` | Recording unchanged |

## Capital Impact

| Setting | Pre-split/game | 3 games | Notes |
|---------|---------------|---------|-------|
| maxCycles=1 (current) | $50 | $150 | Current deployment |
| maxCycles=2 (target) | $85 | $255 | Need ~$105 more capital |

Andy currently has ~$20 in redeemable CTF positions + $0 USDC. Need to add capital before enabling 2 cycles across 3 games.

## Timeline Estimate

- Tests: ~45 min
- Core refactor: ~60 min  
- Dashboard: ~30 min
- Integration test + dry-run: ~30 min
- **Total: ~3 hours**
