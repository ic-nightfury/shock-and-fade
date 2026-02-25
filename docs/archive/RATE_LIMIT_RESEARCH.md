# Polymarket API Rate Limits Research

**Document**: US-410 Research Findings  
**Date**: 2026-01-26  
**Status**: COMPLETE  

## Executive Summary

Our live trading crashed due to Cloudflare Error 1015 (rate limiting) on the CLOB API. The culprit was the `GET /data/orders` endpoint being called too frequently in the main trading loop. This document outlines all rate limits, identifies our high-frequency calls, and provides implementation recommendations.

## Official Rate Limits (from docs.polymarket.com)

### CLOB API (clob.polymarket.com)

| Endpoint | Limit | Window | Notes |
|----------|-------|--------|-------|
| General | 9,000 req | 10s | Overall CLOB API limit |
| `/book`, `/price`, `/midprice` | 1,500 req | 10s | Market data endpoints |
| `POST /order` | 3,500 req | 10s | Order placement (burst) |
| `POST /order` | 36,000 req | 10 min | Order placement (sustained) |
| `DELETE /order` | 3,000 req | 10s | Order cancellation (burst) |
| `DELETE /order` | 30,000 req | 10 min | Order cancellation (sustained) |
| `/balance-allowance` | Included in general | 10s | Token balance checks |
| `/data/orders` | Included in general | 10s | **CAUSED OUR CRASH** |

### Gamma API (gamma-api.polymarket.com)

| Endpoint | Limit | Window |
|----------|-------|--------|
| General | 4,000 req | 10s |
| `/markets` | 300 req | 10s |
| `/events` | 500 req | 10s |
| Search | 350 req | 10s |

### Data API (data-api.polymarket.com)

| Endpoint | Limit | Window |
|----------|-------|--------|
| General | 1,000 req | 10s |
| `/trades` | 200 req | 10s |
| `/positions` | 150 req | 10s |
| `/closed-positions` | 150 req | 10s |

### Builder Relayer

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/submit` | 25 req | 1 min |

## Root Cause Analysis

### What Happened

1. Bot started at M6.1 (minute 6.1 of window)
2. Bot placed sell orders rapidly (every ~0.1s based on fills)
3. Each order placement triggered:
   - `POST /order` (create order)
   - `GET /balance-allowance` (check token allowance) 
   - `GET /data/orders` (fetch open orders to track)
4. Within ~25 seconds, we hit ~30+ API calls
5. Cloudflare triggered Error 1015 (temporary ban)
6. All subsequent requests failed for several minutes

### Specific Trigger: `GET /data/orders`

From the crash log:
```
url: "https://clob.polymarket.com/data/orders"
status: 429 (Too Many Requests)
```

This endpoint was called in a loop to check for open orders, causing rapid-fire requests.

## ASSV2 Strategy API Usage Analysis

### High-Frequency Calls (Per Window)

| Operation | API Call | Frequency | Estimated/Window |
|-----------|----------|-----------|------------------|
| Check token allowance | `GET /balance-allowance` | Per order | 30-50 |
| Place sell order | `POST /order` | Per trade | 30-50 |
| Fetch open orders | `GET /data/orders` | Per loop iteration | 100+ |
| Market discovery | `GET /markets` (Gamma) | Once per window | 1 |
| Position check | `GET /positions` (Data) | Per reconciliation | 5-10 |

### Problem Areas

1. **`GET /data/orders`**: Called every loop iteration (1s) to check order status
2. **`GET /balance-allowance`**: Called before EVERY sell order (redundant)
3. **No caching**: Same data fetched repeatedly

## Recommended Implementation

### 1. Rate Limiter Architecture

**Recommended: Global Rate Limiter with Per-Endpoint Buckets**

```typescript
interface RateLimitConfig {
  endpoint: string;
  maxRequests: number;
  windowMs: number;
}

const RATE_LIMITS: RateLimitConfig[] = [
  // CLOB API
  { endpoint: 'clob.polymarket.com', maxRequests: 900, windowMs: 10000 },  // 10% buffer
  { endpoint: '/order', maxRequests: 350, windowMs: 10000 },
  { endpoint: '/data/orders', maxRequests: 50, windowMs: 10000 },  // Conservative
  { endpoint: '/balance-allowance', maxRequests: 100, windowMs: 10000 },
  
  // Gamma API
  { endpoint: 'gamma-api.polymarket.com', maxRequests: 400, windowMs: 10000 },
  { endpoint: '/markets', maxRequests: 30, windowMs: 10000 },
  
  // Data API
  { endpoint: 'data-api.polymarket.com', maxRequests: 100, windowMs: 10000 },
  { endpoint: '/positions', maxRequests: 15, windowMs: 10000 },
];
```

### 2. Specific Fixes for ASSV2

| Issue | Fix |
|-------|-----|
| Frequent `/data/orders` calls | Cache open orders, only refresh every 5s |
| Redundant `/balance-allowance` | Cache token allowance after first check |
| No backoff on errors | Add exponential backoff (1s → 2s → 4s → 8s) |
| Burst requests | Add minimum 100ms delay between requests |

### 3. WebSocket vs Polling

**Use WebSocket for Real-Time Data:**
- Order fills: Use UserChannel WebSocket (`wss://ws-subscriptions-clob.polymarket.com/ws/user`)
- Price updates: Use Market WebSocket (already implemented)
- Order status: Subscribe to user channel instead of polling `/data/orders`

**WebSocket connections do NOT count against HTTP rate limits.**

### 4. Exponential Backoff Strategy

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      if (error.status === 429 || error.status === 1015) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
        console.warn(`Rate limited, retrying in ${delay}ms...`);
        await sleep(delay);
      } else {
        throw error;
      }
    }
  }
  throw new Error('Max retries exceeded');
}
```

### 5. Request Queuing

Use a request queue with minimum interval:

```typescript
class RequestQueue {
  private queue: Array<() => Promise<any>> = [];
  private processing = false;
  private minIntervalMs = 100;  // 100ms between requests
  
  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        }
      });
      this.processQueue();
    });
  }
  
  private async processQueue() {
    if (this.processing) return;
    this.processing = true;
    
    while (this.queue.length > 0) {
      const fn = this.queue.shift()!;
      await fn();
      await sleep(this.minIntervalMs);
    }
    
    this.processing = false;
  }
}
```

## Safe Request Frequencies

Based on official limits with 10% safety buffer:

| API | Safe Frequency | Max per Window (15 min) |
|-----|----------------|------------------------|
| CLOB General | 90 req/s | 81,000 |
| Order Placement | 35 req/s | 31,500 |
| Order Status | 5 req/s | 4,500 |
| Gamma Markets | 30 req/10s | 2,700 |
| Data Positions | 15 req/10s | 1,350 |

## Implementation Priority

1. **CRITICAL**: Add 100ms minimum delay between CLOB API calls
2. **CRITICAL**: Stop polling `/data/orders` - use WebSocket for order fills
3. **HIGH**: Cache `/balance-allowance` results (valid for session)
4. **HIGH**: Add exponential backoff on 429/1015 errors
5. **MEDIUM**: Implement global rate limiter singleton
6. **LOW**: Add rate limit headers parsing for smarter throttling

## Sources

- [Polymarket API Rate Limits Documentation](https://docs.polymarket.com/quickstart/introduction/rate-limits)
- [Polymarket Builder Tiers](https://docs.polymarket.com/developers/builders/builder-tiers)
- [GitHub Issue: Rate Limit Burst vs Throttle](https://github.com/Polymarket/py-clob-client/issues/147)
- [GitHub Issue: Cloudflare Block](https://github.com/Polymarket/poly-market-maker/issues/72)
- [Cloudflare Error 1015 Documentation](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1015/)

## Appendix: Crash Log Analysis

The crash occurred at 03:21:29 UTC on 2026-01-26. Key observations:

1. First rate limit error on `GET /data/orders`
2. Multiple concurrent requests with same timestamp (no delay)
3. Once rate limited, all subsequent requests also failed
4. Error persisted for entire log duration (never recovered)

This confirms the need for:
- Request spacing (minimum delay)
- Backoff on rate limit detection
- Fail-safe to stop trading when rate limited
