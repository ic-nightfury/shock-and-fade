# Polymarket Rate Limits & Quota Reference

> Last updated: 2026-02-08  
> Sources: [docs.polymarket.com/rate-limits](https://docs.polymarket.com/quickstart/introduction/rate-limits), [Builder Tiers](https://docs.polymarket.com/developers/builders/builder-tiers), [Relayer Client docs](https://docs.polymarket.com/developers/builders/relayer-client), community issues, source code analysis.

---

## Table of Contents

1. [Builder Relayer (Critical)](#1-builder-relayer-critical)
2. [CLOB API Rate Limits](#2-clob-api-rate-limits)
3. [Gamma API Rate Limits](#3-gamma-api-rate-limits)
4. [Data API Rate Limits](#4-data-api-rate-limits)
5. [Other API Rate Limits](#5-other-api-rate-limits)
6. [Mitigation Strategies](#6-mitigation-strategies)
7. [EOA Fallback Strategy](#7-eoa-fallback-strategy)
8. [Implementation Recommendations](#8-implementation-recommendations)

---

## 1. Builder Relayer (Critical)

### The Error We Hit

```
429: quota exceeded: 0 units remaining, resets in ~68000 seconds
```

### What This Means

The Builder Relayer (`relayer-v2.polymarket.com/submit`) has a **daily transaction quota** tied to your **Builder Tier**, completely separate from the Cloudflare-enforced API rate limits.

### Builder Tier Quotas

| Tier | Daily Relayer Txn Limit | API Rate Limits | How to Get |
|------|------------------------|-----------------|------------|
| **Unverified** | **100/day** | Standard | Create builder profile at polymarket.com/settings?tab=builder |
| **Verified** | **3,000/day** | Standard | Contact Polymarket with API key, use case, expected volume |
| **Partner** | **Unlimited** | Highest | Apply for partnership |

### Reset Window

- The quota resets **daily** (24-hour rolling window)
- `resets in ~68000 seconds` = ~18.9 hours, confirming a 24h rolling window
- When exhausted: **ALL relayer operations are blocked** — no split, merge, approve, redeem, or deploy
- The error is returned as HTTP 429 with body: `{"error":"quota exceeded: 0 units remaining, resets in XXXXX seconds"}`

### What Counts as a Relayer Transaction

Each call to `POST /submit` on `relayer-v2.polymarket.com` costs 1 unit. This includes:
- **Safe deployment** (`client.deploy()`)
- **ERC20 approvals** (USDC → CTF, USDC → Exchange, etc.)
- **CTF split positions** (USDC → YES+NO tokens)
- **CTF merge positions** (YES+NO tokens → USDC)
- **Token transfers / withdrawals**
- **Position redemptions**
- **Batched transactions** (multiple ops in one `execute()` call = **1 unit**)

### Key Insight: Batching Saves Quota

The relayer `execute()` method accepts an **array of transactions**. Multiple operations batched into a single `execute()` call consume only **1 quota unit**. This is critical for conservation.

### Additionally: Cloudflare Rate Limit on Relayer

Beyond the daily quota, there's also a Cloudflare throttle:

| Endpoint | Limit | Notes |
|----------|-------|-------|
| RELAYER /submit | **25 requests / 1 minute** | Throttle (not reject) |

This means even if you have quota, you can't burst more than ~25 relayer txns per minute.

---

## 2. CLOB API Rate Limits

All CLOB limits are enforced via **Cloudflare throttling** (requests are delayed, not immediately rejected). Limits are per IP (not per API key).

### General

| Endpoint | Limit (per 10s) | Effective Rate |
|----------|-----------------|----------------|
| CLOB (General) | 9,000 | 900/s |
| GET Balance Allowance | 200 | 20/s |
| UPDATE Balance Allowance | 50 | 5/s |

### Market Data (Read)

| Endpoint | Limit (per 10s) | Effective Rate |
|----------|-----------------|----------------|
| /book | 1,500 | 150/s |
| /books | 500 | 50/s |
| /price | 1,500 | 150/s |
| /prices | 500 | 50/s |
| /midpoint | 1,500 | 150/s |
| /midpoints | 500 | 50/s |

### Trading Endpoints (Write)

These have **two layers**: a burst limit (10s window) and a sustained limit (10min window).

| Endpoint | Burst (per 10s) | Sustained (per 10min) | Effective Sustained |
|----------|----------------|-----------------------|--------------------|
| POST /order | 3,500 (500/s burst) | 36,000 | 60/s |
| DELETE /order | 3,000 (300/s burst) | 30,000 | 50/s |
| POST /orders (batch) | 1,000 (100/s burst) | 15,000 | 25/s |
| DELETE /orders (batch) | 1,000 (100/s burst) | 15,000 | 25/s |
| DELETE /cancel-all | 250 (25/s burst) | 6,000 | 10/s |
| DELETE /cancel-market-orders | 1,000 (100/s burst) | 1,500 | 25/s |

### Ledger Endpoints

| Endpoint | Limit (per 10s) |
|----------|-----------------|
| /trades, /orders, /notifications, /order | 900 |
| /data/orders | 500 |
| /data/trades | 500 |
| /notifications | 125 |

### Other CLOB

| Endpoint | Limit (per 10s) |
|----------|-----------------|
| Price History | 1,000 |
| Market Tick Size | 200 |
| API Keys | 100 |

### Throttling Behavior (Important)

From the official docs:
> When you exceed the maximum configured rate for any endpoint, **requests are throttled rather than immediately rejected**. This means:
> - **Throttling**: Requests over the limit are delayed/queued rather than dropped
> - **Burst Allowances**: Some endpoints allow short bursts above the sustained rate
> - **Time Windows**: Limits reset based on sliding time windows (e.g., per 10 seconds, per minute)

This means you'll see **increased latency** before you see errors. Monitor response times as an early warning.

---

## 3. Gamma API Rate Limits

`gamma-api.polymarket.com` — used for market discovery, event listing, search.

| Endpoint | Limit (per 10s) | Effective Rate |
|----------|-----------------|----------------|
| GAMMA (General) | 4,000 | 400/s |
| /events | 500 | 50/s |
| /markets | 300 | 30/s |
| /markets & /events listing | 900 | 90/s |
| Search | 350 | 35/s |
| Get Comments | 200 | 20/s |
| Tags | 200 | 20/s |

### Our Usage Pattern

We call `/markets` for market discovery. At 300 requests per 10 seconds, we're unlikely to hit this unless we're scanning aggressively. However, since the Gamma API is Cloudflare-throttled, rapid scanning could result in delayed responses.

---

## 4. Data API Rate Limits

`data-api.polymarket.com` — used for positions, trades, activity.

| Endpoint | Limit (per 10s) | Effective Rate |
|----------|-----------------|----------------|
| Data API (General) | 1,000 | 100/s |
| /trades | 200 | 20/s |
| /positions | **150** | **15/s** |
| /closed-positions | 150 | 15/s |
| "OK" Endpoint | 100 | 10/s |

### Additional Query Limits (from changelog Aug 26, 2025)

- `/trades` and `/activity` endpoints: `limit` param max = 500, `offset` param max = 1,000

### Our Usage Pattern

We use `/positions` to check current holdings. At 150/10s this is generous, but if we're polling frequently across multiple accounts, it could add up.

---

## 5. Other API Rate Limits

| Endpoint | Limit (per 10s) | Notes |
|----------|-----------------|-------|
| General Rate Limiting | 15,000 | Across all endpoints |
| "OK" Endpoint (health) | 100 | |
| User PNL API | 200 | |
| RELAYER /submit | 25 / 1 min | Per-minute, not per-10s |

---

## 6. Mitigation Strategies

### 6.1 Relayer Quota Conservation (HIGHEST PRIORITY)

The relayer daily quota is our **most constrained resource** (100/day on Unverified tier).

**Strategy: Batch Everything**

```typescript
// BAD: 4 separate relayer transactions (4 quota units)
await relayClient.execute([approveUSDC]);      // 1 unit
await relayClient.execute([approveCTF]);        // 1 unit  
await relayClient.execute([splitPosition]);     // 1 unit
await relayClient.execute([mergePosition]);     // 1 unit

// GOOD: 1 batched relayer transaction (1 quota unit)
await relayClient.execute([
  approveUSDC,
  approveCTF, 
  splitPosition,
  mergePosition
], "batch: approvals + split + merge");
```

**Strategy: Cache Approval State**

```typescript
// Track approvals persistently (file/DB), NOT in memory
const APPROVAL_CACHE_FILE = './data/approval_state.json';

// On startup: read cache, don't re-approve unless needed
// After successful approval: update cache
// Only re-check on-chain if cache is stale (>24h) or after errors
```

Approvals are `type(uint256).max` (infinite) — once set, they never need to be re-done unless revoked. **Never re-approve on every startup.**

**Strategy: Pre-check Before Relayer Calls**

Before calling the relayer for split/merge, verify on-chain that approvals exist using a direct RPC call (free, no quota):

```typescript
// Direct RPC read (FREE, no relayer quota)
const allowance = await usdcContract.allowance(safeAddress, ctfAddress);
if (allowance > 0n) {
  // Already approved, skip relayer call
}
```

**Strategy: Quota Tracking**

```typescript
interface RelayerQuotaTracker {
  dailyUsed: number;
  dailyLimit: number;         // 100 for Unverified
  resetTime: number;          // Unix timestamp
  lastRelayerCall: number;
}

// Before any relayer call:
function canUseRelayer(): boolean {
  if (Date.now() > tracker.resetTime) {
    tracker.dailyUsed = 0;
    tracker.resetTime = Date.now() + 86400000;
  }
  return tracker.dailyUsed < tracker.dailyLimit;
}
```

### 6.2 CLOB Rate Limit Management

**Strategy: Use Batch Endpoints**

- Use `POST /orders` (batch) instead of multiple `POST /order` calls
- Use `/midpoints` instead of multiple `/midpoint` calls
- Use `/books` instead of multiple `/book` calls
- Use `/prices` instead of multiple `/price` calls

**Strategy: Respect Two-Layer Limits**

For trading, the burst limit (10s) is generous but the sustained limit (10min) is the real constraint:
- POST /order sustained: 60/s → ~1 order per second is safe
- Our arbitrage bot: aim for max 30 orders/minute to stay well under

**Strategy: Monitor Response Times**

Since Cloudflare throttles (delays) rather than rejects, watch for latency spikes:

```typescript
const start = Date.now();
const response = await clobClient.postOrder(order);
const latency = Date.now() - start;

if (latency > 2000) {
  console.warn('CLOB latency spike - likely being throttled');
  // Back off for 10 seconds
}
```

### 6.3 Gamma API Conservation

**Strategy: Cache Market Data**

```typescript
// Market data doesn't change frequently
const MARKET_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Don't re-fetch market list more than once per scan cycle
// Cache condition IDs, token IDs, and market metadata
```

**Strategy: Paginate Efficiently**

Use `limit` and `offset` parameters. Fetch only active, liquid markets instead of scanning everything.

### 6.4 Data API Conservation

**Strategy: Poll Positions Sparingly**

```typescript
// Don't check positions every loop iteration
// Check once per trade cycle (every 30-60 seconds)
const POSITION_POLL_INTERVAL = 60_000; // 1 minute
```

### 6.5 General Strategies

**Exponential Backoff on 429s**

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (is429Error(err)) {
        const waitMs = Math.min(1000 * Math.pow(2, i), 30000);
        // Parse "resets in XXXXX seconds" if available
        const resetSeconds = parseResetTime(err);
        if (resetSeconds && resetSeconds < 120) {
          await sleep(resetSeconds * 1000);
        } else {
          await sleep(waitMs);
        }
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}
```

---

## 7. EOA Fallback Strategy

When the relayer quota is exhausted, we can fall back to **direct EOA (Externally Owned Account) transactions** on Polygon. This bypasses the relayer entirely but requires paying gas.

### How It Works

The relayer wraps transactions through a Gnosis Safe proxy. But the underlying contracts (CTF, ERC20, Exchange) are standard Polygon contracts that accept transactions from any address.

### What's Needed

1. **Polygon MATIC/POL for gas** — Polygon gas is very cheap (~0.01-0.1 cents per tx)
2. **Direct contract interaction** — Call CTF `splitPosition()`, `mergePositions()`, ERC20 `approve()` directly
3. **Wallet with private key** — The same EOA key we already have

### Contract Addresses (Polygon Mainnet)

| Contract | Address |
|----------|---------|
| USDCe | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| CTF (Conditional Tokens) | `0x4d97dcd97ec945f40cf65f87097ace5ea0476045` |
| CTF Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` |
| Neg Risk CTF Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` |

### Important Caveat: Safe vs EOA Address

- The relayer operates through a **Gnosis Safe proxy address** derived from your EOA
- Your CLOB orders are signed by your EOA but reference the Safe as the maker
- If you switch to direct EOA transactions, the tokens/USDC move in the **EOA's balance**, not the Safe's
- You may need to set up **separate approvals for the EOA** (not the Safe)
- The CLOB may require orders from the Safe address — verify before switching

### Implementation Sketch

```typescript
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Direct ERC20 approval (no relayer needed)
const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
await usdc.approve(CTF_ADDRESS, ethers.MaxUint256);

// Direct CTF split (no relayer needed)
const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
await ctf.splitPosition(
  USDC_ADDRESS,           // collateralToken
  ethers.ZeroHash,        // parentCollectionId (null for Polymarket)
  conditionId,            // conditionId
  [1, 2],                 // partition (YES=1, NO=2)
  amount                  // amount to split
);
```

### Gas Cost Estimate

Polygon gas is minimal:
- ERC20 approve: ~50,000 gas × ~30 gwei = ~0.0015 MATIC (~$0.001)
- CTF split: ~150,000 gas × ~30 gwei = ~0.0045 MATIC (~$0.003)
- CTF merge: ~120,000 gas × ~30 gwei = ~0.0036 MATIC (~$0.002)
- Keep ~0.1 MATIC ($0.05) in the EOA for hundreds of transactions

---

## 8. Implementation Recommendations

### Priority 1: Stop Burning Relayer Quota (Immediate)

1. **Cache approval state to disk** — Never re-approve if already approved
2. **Check approvals via RPC read** before calling relayer (free)
3. **Batch all relayer operations** into single `execute()` calls
4. **Track quota usage** — log every relayer call, warn at 50% usage
5. **Add relayer quota check** before any relayer call; if exhausted, either queue or use EOA fallback

### Priority 2: Upgrade Builder Tier (Short-term)

- Contact Polymarket at builders@polymarket.com
- Request Verified tier (3,000/day — 30× current limit)
- Provide: Builder API Key, use case description, expected volume
- This is the single biggest improvement we can make

### Priority 3: Implement EOA Fallback (Medium-term)

- Fund EOA with small MATIC balance
- Implement direct contract calls for split/merge/approve
- Auto-switch when relayer returns 429
- This makes us resilient to relayer outages too

### Priority 4: Optimize API Usage (Ongoing)

- Use batch endpoints (/midpoints, /books, /prices, /orders)
- Cache market metadata (5-min TTL for Gamma, 60s for positions)
- Monitor response latencies for early throttling detection
- Implement exponential backoff on all API calls

### Our Current Usage Budget (Unverified Tier)

| Resource | Limit | Safe Target | Notes |
|----------|-------|-------------|-------|
| Relayer txns | 100/day | <20/day | Batch everything, cache approvals |
| CLOB orders | 60/s sustained | <1/s | We're nowhere near this |
| CLOB reads | 150/s (midpoint) | <10/s | Generous for our needs |
| Gamma markets | 30/s | <1/s | Cache aggressively |
| Data positions | 15/s | <0.1/s | Poll every 60s max |

### Monitoring Checklist

- [ ] Log every relayer call with timestamp and remaining quota
- [ ] Parse `resets in XXXXX seconds` from 429 errors to calculate reset time
- [ ] Track daily relayer usage in persistent storage
- [ ] Alert when relayer usage exceeds 50% of daily limit
- [ ] Monitor CLOB response latencies (>2s = likely throttled)
- [ ] Log all 429 responses with endpoint and retry behavior

---

## Appendix: Key URLs

| Service | Base URL |
|---------|----------|
| CLOB API | `https://clob.polymarket.com` |
| Gamma API | `https://gamma-api.polymarket.com` |
| Data API | `https://data-api.polymarket.com` |
| Relayer | `https://relayer-v2.polymarket.com` |
| Builder Profile | `https://polymarket.com/settings?tab=builder` |
| Builder Leaderboard | `https://builders.polymarket.com/` |
| Builder Support | `builders@polymarket.com` |

## Appendix: Relayer Endpoints

From `@polymarket/builder-relayer-client` source:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/nonce` | GET | Get current nonce for signing |
| `/transaction` | GET | Get transaction by ID |
| `/transactions` | GET | List transactions (authed) |
| `/submit` | POST | Submit transaction (authed, costs quota) |
| `/deployed` | GET | Check if Safe is deployed |

Only `/submit` consumes quota. The other endpoints are read-only.
