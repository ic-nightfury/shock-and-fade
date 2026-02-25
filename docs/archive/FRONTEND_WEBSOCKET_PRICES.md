# Frontend WebSocket Real-Time Prices Implementation

## Overview

This document describes how to add real-time WebSocket price feeds to the frontend API server, replacing stale Gamma API prices with live bid/ask data from Polymarket's order book WebSocket.

## Problem

The original implementation fetched prices from Gamma API's `outcomePrices` field, which can be stale (updated infrequently). Users need real-time bid/ask prices for accurate trading decisions.

## Solution

Subscribe to Polymarket's WebSocket order book feed and extract live bid/ask prices for each token.

## Files Modified

1. `src/server/api.ts` - Backend API server
2. `src/server/public/app.js` - Frontend JavaScript

## Implementation Steps

### Step 1: Import WebSocket Service

In `src/server/api.ts`, add the import:

```typescript
import { OrderBookWebSocket } from '../services/OrderBookWS';
```

### Step 2: Add State Variables

Add these variables after the cache variables:

```typescript
// WebSocket for real-time prices
let orderBookWS: OrderBookWebSocket | null = null;
let currentTokenIds: string[] = [];
```

### Step 3: Add Helper Functions

Add these functions:

```typescript
// Helper to compare arrays
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, idx) => val === b[idx]);
}

// Connect WebSocket to market tokens
async function connectToMarketPrices(tokenIds: string[]): Promise<void> {
  if (!tokenIds || tokenIds.length < 2) return;

  // Skip if already connected to same tokens
  if (orderBookWS && arraysEqual(currentTokenIds, tokenIds)) {
    return;
  }

  // Disconnect old
  if (orderBookWS) {
    orderBookWS.disconnect();
    orderBookWS = null;
  }

  // Connect new
  try {
    orderBookWS = new OrderBookWebSocket(tokenIds);
    await orderBookWS.connect();
    currentTokenIds = tokenIds;
    console.log(`📡 Connected to price feed for ${tokenIds.length} tokens`);
  } catch (error: any) {
    console.error('Failed to connect WebSocket:', error.message);
    orderBookWS = null;
  }
}

// Get live bid/ask prices from WebSocket
function getLivePrices(): MarketInfo['livePrices'] | null {
  if (!orderBookWS || currentTokenIds.length < 2) return null;

  const upBid = orderBookWS.getBestBid(currentTokenIds[0]);
  const upAsk = orderBookWS.getBestAsk(currentTokenIds[0]);
  const downBid = orderBookWS.getBestBid(currentTokenIds[1]);
  const downAsk = orderBookWS.getBestAsk(currentTokenIds[1]);

  // Return null if no data yet
  if (upAsk === 0 && downAsk === 0) return null;

  return { upBid, upAsk, downBid, downAsk };
}
```

### Step 4: Update MarketInfo Interface

Add the `livePrices` field to the interface:

```typescript
interface MarketInfo {
  slug: string;
  question: string;
  conditionId: string;
  endDate: string;
  outcomes: string[];
  outcomePrices: number[];      // Gamma API fallback
  clobTokenIds: string[];
  volume24hr: number;
  liquidity: number;
  timeRemaining: number;
  timeRemainingFormatted: string;
  livePrices?: {                // NEW: WebSocket real-time prices
    upBid: number;
    upAsk: number;
    downBid: number;
    downAsk: number;
  };
}
```

### Step 5: Integrate into Cache Function

Update `getMarketWithCache()` to connect WebSocket and add live prices:

```typescript
async function getMarketWithCache(): Promise<MarketInfo | null> {
  const now = Date.now();
  if (cachedMarket && now - marketCacheTime < MARKET_CACHE_MS) {
    // Update time remaining
    const endTime = new Date(cachedMarket.endDate).getTime();
    const timeRemaining = Math.max(0, endTime - now);
    const minutes = Math.floor(timeRemaining / 60000);
    const seconds = Math.floor((timeRemaining % 60000) / 1000);
    cachedMarket.timeRemaining = timeRemaining;
    cachedMarket.timeRemainingFormatted = timeRemaining <= 0 ? 'ENDED' : `${minutes}:${seconds.toString().padStart(2, '0')}`;

    // Update live prices from WebSocket
    cachedMarket.livePrices = getLivePrices() || undefined;
    return cachedMarket;
  }

  cachedMarket = await findCurrentMarket();
  marketCacheTime = now;

  // Connect WebSocket to new market tokens
  if (cachedMarket && cachedMarket.clobTokenIds.length >= 2) {
    await connectToMarketPrices(cachedMarket.clobTokenIds);
    // Add initial live prices if available
    cachedMarket.livePrices = getLivePrices() || undefined;
  }

  return cachedMarket;
}
```

### Step 6: Update Frontend JavaScript

In `src/server/public/app.js`, update the `updateMarket()` function to use live prices:

```javascript
// Prices - prefer live WebSocket prices, fallback to Gamma API
let upPrice, downPrice;
if (market.livePrices) {
  // Use mid-price from bid/ask for display
  upPrice = (market.livePrices.upBid + market.livePrices.upAsk) / 2;
  downPrice = (market.livePrices.downBid + market.livePrices.downAsk) / 2;
} else {
  upPrice = market.outcomePrices[0] || 0;
  downPrice = market.outcomePrices[1] || 0;
}
```

## API Response Format

After implementation, `/api/market` returns:

```json
{
  "success": true,
  "market": {
    "slug": "btc-updown-15m-1766882700",
    "outcomePrices": [0.495, 0.505],
    "livePrices": {
      "upBid": 0.49,
      "upAsk": 0.51,
      "downBid": 0.49,
      "downAsk": 0.52
    },
    "clobTokenIds": ["0x...", "0x..."],
    ...
  }
}
```

## Key Points

1. **Fallback**: Keep `outcomePrices` from Gamma API as fallback when WebSocket hasn't connected yet
2. **Auto-reconnect**: `OrderBookWebSocket` handles reconnection automatically (up to 5 attempts)
3. **Market switching**: When market changes (every 15 min), disconnect old WebSocket and connect to new tokens
4. **Token order**: `clobTokenIds[0]` = UP token, `clobTokenIds[1]` = DOWN token

## Dependencies

- `src/services/OrderBookWS.ts` - WebSocket client for Polymarket order books
- WebSocket endpoint: `wss://ws-subscriptions-clob.polymarket.com/ws/market`

## Testing

1. Run `npm run frontend`
2. Look for `📡 Connected to price feed for 2 tokens` in console
3. Check API response: `curl http://localhost:3456/api/market | jq .market.livePrices`
4. Prices should update in real-time on the dashboard
