# Polymarket WebSocket API

## Overview

The Polymarket WebSocket API provides real-time streaming data for markets and user-specific account information via WebSocket connections. This enables low-latency updates for orderbooks, trades, prices, and order status.

**Official Documentation:** https://docs.polymarket.com/quickstart/websocket/WSS-Quickstart

**GitHub Example:** https://github.com/Polymarket/clob-client/blob/main/examples/socketConnection.ts

---

## Connection Details

### WebSocket URL

```
wss://ws-subscriptions-clob.polymarket.com/ws/{channel_type}
```

### Available Channels

1. **`market`** - Public market data (no authentication required)
   - Real-time orderbook updates
   - Trade executions
   - Price changes
   - Liquidity updates

2. **`user`** - Private user data (authentication required)
   - Order status updates
   - Fill notifications
   - Balance changes
   - Position updates

---

## Authentication

### Required Credentials

User channel subscriptions require API credentials. These are already configured in your `.env` file:

```bash
BUILDER_API_KEY=019a5c3c-972a-7569-8eb9-3d500434237c
BUILDER_SECRET=b5KRT0hbYJf2vwiAO69whIdNtfhOWE4sxCgzxJWCLAo=
BUILDER_PASS_PHRASE=85ba43b0eca7ea56dc39d69c17d8e3bfcd9bfd973eec06c1a89c3ef181cdbe8e
```

### How to Obtain Credentials

If you need new credentials:

1. **Export Private Key** from your wallet (MetaMask, Magic.link, etc.)
2. **Derive API Keys** using the ClobClient:
   ```typescript
   import { ClobClient } from '@polymarket/clob-client';

   const client = new ClobClient(...);
   const credentials = await client.deriveApiKey();
   // Returns: { apiKey, secret, passphrase }
   ```

---

## Message Formats

### Market Channel Subscription

```json
{
  "type": "market",
  "assets_ids": [
    "21742633143463906290569050155826241533067272736897614950488156847949938836455",
    "48331043336612883890938759509493159234755048973500640148014422747788308965732"
  ]
}
```

**Fields:**
- `type`: `"market"` (required)
- `assets_ids`: Array of token IDs to subscribe to (YES/NO outcome tokens)
- `dump`: Boolean (optional) - Include initial orderbook snapshot

### User Channel Subscription

```json
{
  "type": "user",
  "markets": ["0x0c32dfcafe399ef43a0dd3a76b7c381b7d29e3f32b0c10c6c1e95f9e64b25960"],
  "auth": {
    "apiKey": "YOUR_BUILDER_API_KEY",
    "secret": "YOUR_BUILDER_SECRET",
    "passphrase": "YOUR_BUILDER_PASS_PHRASE"
  }
}
```

**Fields:**
- `type`: `"user"` (required)
- `markets`: Array of condition IDs to subscribe to
- `auth`: Authentication object (required)
  - `apiKey`: From `BUILDER_API_KEY`
  - `secret`: From `BUILDER_SECRET`
  - `passphrase`: From `BUILDER_PASS_PHRASE`
- `dump`: Boolean (optional) - Include initial user state

---

## Keepalive (CRITICAL)

**⚠️ IMPORTANT:** Clients MUST send a `"PING"` message every **10 seconds** to maintain the connection. Failure to send pings will result in disconnection.

```typescript
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send('PING');
  }
}, 10000);
```

---

## Message Types

### Inbound Messages (Server → Client)

#### Market Data Updates

```json
{
  "event_type": "book",
  "asset_id": "21742633143463906290569050155826241533067272736897614950488156847949938836455",
  "market": "0x0c32dfcafe399ef43a0dd3a76b7c381b7d29e3f32b0c10c6c1e95f9e64b25960",
  "timestamp": 1699564820,
  "hash": "0x...",
  "bids": [
    {"price": "0.55", "size": "100.0"},
    {"price": "0.54", "size": "250.0"}
  ],
  "asks": [
    {"price": "0.56", "size": "150.0"},
    {"price": "0.57", "size": "300.0"}
  ]
}
```

#### Trade Updates

```json
{
  "event_type": "trade",
  "asset_id": "21742633143463906290569050155826241533067272736897614950488156847949938836455",
  "market": "0x0c32dfcafe399ef43a0dd3a76b7c381b7d29e3f32b0c10c6c1e95f9e64b25960",
  "timestamp": 1699564825,
  "price": "0.555",
  "size": "50.0",
  "side": "BUY"
}
```

#### User Order Updates

```json
{
  "event_type": "order",
  "order_id": "0x...",
  "market": "0x0c32dfcafe399ef43a0dd3a76b7c381b7d29e3f32b0c10c6c1e95f9e64b25960",
  "asset_id": "21742633143463906290569050155826241533067272736897614950488156847949938836455",
  "status": "MATCHED",
  "price": "0.55",
  "size": "10.0",
  "side": "BUY",
  "timestamp": 1699564830
}
```

**Order Statuses:**
- `LIVE` - Order active on orderbook
- `MATCHED` - Order filled
- `CANCELLED` - Order cancelled
- `EXPIRED` - Order expired

---

## TypeScript Implementation

See complete example: [`docs/reference/polymarket-socket-connection.ts`](./polymarket-socket-connection.ts)

### Quick Start

```typescript
import WebSocket from 'ws';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  // Subscribe to market
  ws.send(JSON.stringify({
    type: 'market',
    assets_ids: [YES_TOKEN_ID, NO_TOKEN_ID]
  }));

  // Keepalive ping
  setInterval(() => ws.send('PING'), 10000);
});

ws.on('message', (data) => {
  const message = JSON.parse(data.toString());
  console.log('Update:', message);
});
```

---

## Use Cases for Polyhedge

### 1. Real-Time Order Tracking

**Problem:** Currently rely on polling CLOB API for order status
**Solution:** Subscribe to user channel for instant order updates

```typescript
// Receive immediate notification when order fills
ws.on('message', (data) => {
  const message = JSON.parse(data.toString());
  if (message.event_type === 'order' && message.status === 'MATCHED') {
    console.log(`✅ Order filled: ${message.order_id}`);
    // Update database, trigger notifications, etc.
  }
});
```

### 2. Live Price Monitoring

**Problem:** Position values calculated from periodic syncs (15 min)
**Solution:** Subscribe to market channel for real-time prices

```typescript
// Track live price movements for open positions
ws.on('message', (data) => {
  const message = JSON.parse(data.toString());
  if (message.event_type === 'trade') {
    updatePositionPrice(message.asset_id, message.price);
  }
});
```

### 3. Martingale Trigger Detection

**Problem:** Martingale system checks every 15 minutes for -60% trigger
**Solution:** Real-time price monitoring for instant trigger detection

```typescript
// Detect martingale triggers as they happen
ws.on('message', (data) => {
  const message = JSON.parse(data.toString());
  if (message.event_type === 'trade') {
    const position = getPositionByAssetId(message.asset_id);
    const pnlPercent = calculatePnL(position, message.price);

    if (pnlPercent <= -60) {
      triggerMartingaleEntry(position);
    }
  }
});
```

### 4. Trade Execution Confirmation

**Problem:** After placing order, need to poll for confirmation
**Solution:** Immediate notification via WebSocket

```typescript
// Instant confirmation of trade execution
async function executeTrade() {
  const order = await placeOrder(...);

  // Listen for fill
  const fillPromise = new Promise((resolve) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.order_id === order.id && msg.status === 'MATCHED') {
        resolve(msg);
      }
    });
  });

  const fill = await fillPromise;
  console.log('Trade confirmed:', fill);
}
```

---

## Integration Pattern

### Recommended Architecture

```
┌─────────────────────────────────────────────┐
│         Polyhedge Express API Server        │
│                                             │
│  ┌─────────────────────────────────────┐  │
│  │   WebSocket Manager Service         │  │
│  │                                     │  │
│  │  ┌──────────┐      ┌──────────┐   │  │
│  │  │ Market   │      │  User    │   │  │
│  │  │ Channel  │      │ Channel  │   │  │
│  │  └────┬─────┘      └────┬─────┘   │  │
│  │       │                 │          │  │
│  │       └────────┬────────┘          │  │
│  │                │                   │  │
│  │         Event Handlers             │  │
│  │    ┌─────────────────────┐        │  │
│  │    │ - Price Updates     │        │  │
│  │    │ - Order Fills       │        │  │
│  │    │ - Position Changes  │        │  │
│  │    │ - Martingale Checks │        │  │
│  │    └─────────────────────┘        │  │
│  └─────────────────────────────────────┘  │
│                                             │
│  ┌─────────────────────────────────────┐  │
│  │      Existing Services              │  │
│  │  - VaultService                     │  │
│  │  - PositionService                  │  │
│  │  - MartingaleService                │  │
│  │  - TradingExecutor                  │  │
│  └─────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### Service Template

```typescript
// src/services/PolymarketWebSocketService.ts

import WebSocket from 'ws';

export class PolymarketWebSocketService {
  private marketWs: WebSocket | null = null;
  private userWs: WebSocket | null = null;

  async connectMarket(assetIds: string[]) {
    this.marketWs = new WebSocket(
      'wss://ws-subscriptions-clob.polymarket.com/ws/market'
    );

    this.marketWs.on('open', () => {
      this.marketWs!.send(JSON.stringify({
        type: 'market',
        assets_ids: assetIds
      }));

      // Keepalive
      setInterval(() => {
        if (this.marketWs?.readyState === WebSocket.OPEN) {
          this.marketWs.send('PING');
        }
      }, 10000);
    });

    this.marketWs.on('message', (data) => {
      this.handleMarketUpdate(JSON.parse(data.toString()));
    });
  }

  async connectUser(markets: string[]) {
    this.userWs = new WebSocket(
      'wss://ws-subscriptions-clob.polymarket.com/ws/user'
    );

    this.userWs.on('open', () => {
      this.userWs!.send(JSON.stringify({
        type: 'user',
        markets,
        auth: {
          apiKey: process.env.BUILDER_API_KEY,
          secret: process.env.BUILDER_SECRET,
          passphrase: process.env.BUILDER_PASS_PHRASE
        }
      }));

      // Keepalive
      setInterval(() => {
        if (this.userWs?.readyState === WebSocket.OPEN) {
          this.userWs.send('PING');
        }
      }, 10000);
    });

    this.userWs.on('message', (data) => {
      this.handleUserUpdate(JSON.parse(data.toString()));
    });
  }

  private handleMarketUpdate(message: any) {
    // Update position prices, check martingale triggers, etc.
  }

  private handleUserUpdate(message: any) {
    // Handle order fills, balance changes, etc.
  }

  disconnect() {
    this.marketWs?.close();
    this.userWs?.close();
  }
}
```

---

## Rate Limits

The WebSocket API does not specify explicit rate limits. However:

- **Subscription Limit:** Unknown maximum concurrent subscriptions
- **Reconnection:** Implement exponential backoff on disconnect
- **Message Rate:** No specified limit on message frequency

---

## Error Handling

### Connection Errors

```typescript
ws.on('error', (error) => {
  console.error('WebSocket error:', error);
  // Implement reconnection logic
});
```

### Disconnections

```typescript
ws.on('close', (code, reason) => {
  console.log(`Disconnected: ${code} - ${reason}`);

  // Implement exponential backoff
  setTimeout(() => reconnect(), 1000 * Math.pow(2, retryCount));
});
```

### Authentication Failures

If authentication fails for user channel:
- Verify API credentials in `.env`
- Check credential expiration
- Regenerate credentials if needed

---

## Testing

### Test Market Connection

```bash
# Run the example
ts-node docs/reference/polymarket-socket-connection.ts
```

### Test with wscat

```bash
# Install wscat
npm install -g wscat

# Connect to market channel
wscat -c wss://ws-subscriptions-clob.polymarket.com/ws/market

# Send subscription
{"type":"market","assets_ids":["21742633143463906290569050155826241533067272736897614950488156847949938836455"]}

# Send keepalive ping every 10 seconds
PING
```

---

## References

- **Official Docs:** https://docs.polymarket.com/quickstart/websocket/WSS-Quickstart
- **GitHub Example:** https://github.com/Polymarket/clob-client/blob/main/examples/socketConnection.ts
- **CLOB Client Package:** https://www.npmjs.com/package/@polymarket/clob-client
- **Local Example:** `docs/reference/polymarket-socket-connection.ts`

---

## Next Steps

To integrate WebSocket support into Polyhedge:

1. **Create WebSocket Service** - `src/services/PolymarketWebSocketService.ts`
2. **Add Event Handlers** - Price updates, order fills, position changes
3. **Enable Real-Time Martingale** - Trigger on live price updates instead of 15-min sync
4. **Add Monitoring** - Connection health, reconnection logic, error tracking
5. **Update Documentation** - Add to CLAUDE.md and PRD.md

**Priority:** Medium-High - Real-time updates would significantly improve system responsiveness
