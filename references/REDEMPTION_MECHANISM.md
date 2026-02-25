# Redemption Mechanism

How settled market positions are redeemed back to USDC.

---

## Overview

After a market settles (outcome determined), winning positions can be **redeemed** for $1 USDC per share. The bot automatically checks for and redeems settled positions.

---

## Cooldown & Timing

| Parameter | Value | Description |
|-----------|-------|-------------|
| **Check interval** | 5 minutes | Time between redemption checks |
| **Initial check** | On startup | Non-blocking, immediate |
| **Retry attempts** | 3 | Per position |
| **Retry delay** | 30 seconds | Between retry attempts |

---

## Flow

```
BOT STARTUP
     │
     ├─► Initial redemption check (non-blocking)
     │   └─► Set lastRedemptionCheck = now
     │
     ▼
MAIN LOOP (every ~100ms)
     │
     └─► if (!isRedeeming && now - lastRedemptionCheck >= 5min)
              │
              ▼
         FETCH REDEEMABLE POSITIONS
              │
              ├─► Active positions API (redeemable=true)
              │   URL: data-api.polymarket.com/positions
              │
              └─► Closed positions API (realizedPnl=0)
                  URL: data-api.polymarket.com/closed-positions
              │
              ▼
         FILTER (V68: prevent loops)
              │
              └─► Remove already-attempted from attemptedRedemptions Set
              │
              ▼
         REDEEM EACH POSITION
              │
              ├─► Add to attemptedRedemptions Set
              ├─► Get outcome index (0 or 1)
              └─► Call redeemWithRetry(3 attempts, 30s delay)
                       │
                       ├─► SUCCESS → Done
                       ├─► ALREADY_REDEEMED → Treat as success
                       └─► FAILED → Retry up to 3 times
```

---

## State Variables

```typescript
private lastRedemptionCheck = 0;              // Timestamp of last check
private isRedeeming = false;                   // Concurrency lock
private attemptedRedemptions = new Set<string>(); // V68: Track attempted positions
```

---

## API Endpoints

### Active Positions (redeemable=true)
```
GET https://data-api.polymarket.com/positions?sizeThreshold=0.01&limit=100&user={wallet}

Response: [{
  conditionId: string,
  outcome: string,
  size: number,
  redeemable: boolean  // ← Check this
}]
```

### Closed Positions (realizedPnl=0)
```
GET https://data-api.polymarket.com/closed-positions?limit=500&user={wallet}

Response: [{
  conditionId: string,
  outcome: string,
  size: number,
  realizedPnl?: number  // ← If 0, not yet redeemed
}]
```

---

## Redemption via Builder Relayer

The actual redemption uses the ProxyRedemptionClient which calls the CTF contract via Builder Relayer (gas-free).

```typescript
// For standard markets
redeemTx = {
  to: CTF_CONTRACT,
  operation: OperationType.Call,
  data: ctfInterface.encodeFunctionData('redeemPositions', [
    USDC_E,
    PARENT_COLLECTION_ID,
    conditionId,
    [outcomeIndex]
  ])
};

// For NegRisk markets
redeemTx = {
  to: NEGRISK_ADAPTER,
  operation: OperationType.Call,
  data: negRiskInterface.encodeFunctionData('redeemPositions', [
    conditionId,
    amounts  // [sharesInWei, 0] or [0, sharesInWei]
  ])
};
```

---

## Error Handling

| Error | Handling |
|-------|----------|
| `SafeMath: subtraction overflow` | Position already redeemed → treat as success |
| `TRANSACTION_FAILED_ONCHAIN` | Retry up to 3 times |
| Network errors | Retry up to 3 times |
| Other errors | Log and continue to next position |

---

## V68: Loop Prevention

The `attemptedRedemptions` Set prevents endless redemption loops:

```typescript
// Build key from conditionId + outcome
const key = `${pos.conditionId}:${pos.outcome}`;

// Skip if already attempted
if (this.attemptedRedemptions.has(key)) {
  continue;
}

// Mark as attempted before redeeming
this.attemptedRedemptions.add(key);
await this.redeemSide(pos.conditionId, pos.outcome, pos.size);
```

**Note:** The Set is never cleared during runtime. This is intentional to prevent loops. On bot restart, the Set resets and positions will be re-checked.

---

## Concurrency Protection

```typescript
// Only one redemption check at a time
if (!this.isRedeeming && now - this.lastRedemptionCheck >= 300000) {
  this.isRedeeming = true;
  this.lastRedemptionCheck = now;

  this.checkAndRedeemPositions()
    .catch(err => console.error('Redemption error:', err))
    .finally(() => { this.isRedeeming = false; });
}
```

---

## Example Log Output

```
💰 Found 2 redeemable position(s) from API
   Redeeming Yes (15.00 shares)...
   ✅ Redeemed (tx: 0x447dbf2c...)
   Redeeming No (8.50 shares)...
   ✅ Redeemed (tx: 0x58af6d27...)
✅ Processed 2 redemption(s)
```

Or on already-redeemed:
```
   Redeeming Yes (15.00 shares)...
   [No log - ALREADY_REDEEMED treated as silent success]
```

---

## Code Location

| File | Function |
|------|----------|
| `src/strategies/BilateralStrategyV6.ts` | `checkAndRedeemPositions()`, `redeemSide()` |
| `src/services/ProxyRedemptionClient.ts` | `redeemWithRetry()`, `redeem()` |

---

## Key Files

| File | Purpose |
|------|---------|
| `src/services/ProxyRedemptionClient.ts` | Builder Relayer integration for redemption |
| `src/strategies/BilateralStrategyV6.ts` | Periodic check and position fetching |

---

## Environment Variables

```bash
POLYMARKET_FUNDER=0x...     # Wallet address to check positions for
BUILDER_API_KEY=...         # Builder Relayer credentials
BUILDER_SECRET=...
BUILDER_PASS_PHRASE=...
```
