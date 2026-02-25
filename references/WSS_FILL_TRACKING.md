# WSS Fill Tracking Pattern

How to track GTC order fills via WebSocket.

---

## Critical Rules

| Rule | Why |
|------|-----|
| **LOWERCASE all order IDs** | WSS sends mixed case |
| **Only use TRADE events** | ORDER events have unreliable `size_matched` |
| **Use `event.size` directly** | TRADE events give accurate incremental fill |
| **Initialize filledAmount to 0** | WSS reports ALL fills |
| **QUEUE events, don't drop** | Multiple makers = multiple rapid events |

---

## Event Queue Pattern (CRITICAL)

WSS emits one event PER MAKER in a TRADE message. If 3 makers fill your order, you get 3 rapid events. **You MUST queue them or you'll drop fills.**

```typescript
// WRONG - drops events!
this.userChannelWS.on('orderUpdate', (event) => {
  if (this.isProcessing) return;  // ← DROPS EVENT!
  this.isProcessing = true;
  this.handleOrderUpdate(event).finally(() => { this.isProcessing = false; });
});

// CORRECT - queue events
private orderUpdateQueue: OrderUpdateEvent[] = [];

this.userChannelWS.on('orderUpdate', (event) => {
  this.orderUpdateQueue.push(event);
  this.processQueue();
});

private async processQueue(): Promise<void> {
  if (this.isProcessing) return;
  this.isProcessing = true;
  while (this.orderUpdateQueue.length > 0) {
    const event = this.orderUpdateQueue.shift()!;
    await this.handleOrderUpdate(event);
  }
  this.isProcessing = false;
}
```

---

## Store Orders with Lowercase Keys

```typescript
const result = await this.client.buySharesGTC(tokenId, size, price);
if (result.success && result.orderID) {
  this.pendingOrders.set(result.orderID.toLowerCase(), {
    orderId: result.orderID,
    side: side,
    size: size,
    filledAmount: 0,  // ALWAYS 0! WSS reports all fills
    orderType: 'hedge',
  });
}
```

---

## Handle WSS Events

```typescript
private async handleOrderUpdate(event: OrderUpdateEvent): Promise<void> {
  const order = this.pendingOrders.get(event.orderId.toLowerCase());
  if (!order) return;

  // ORDER events: only for CANCELLED/EXPIRED
  if (event.eventType !== 'trade') {
    if (event.status === 'CANCELLED' || event.status === 'EXPIRED') {
      this.pendingOrders.delete(event.orderId.toLowerCase());
    }
    return;
  }

  // TRADE fill - use event.size directly
  if (event.status === 'MATCHED' && event.size > 0) {
    order.filledAmount += event.size;

    // Update position
    if (order.side === 'UP') {
      this.position.upQty += event.size;
      this.position.upCost += event.size * event.price;
    } else {
      this.position.downQty += event.size;
      this.position.downCost += event.size * event.price;
    }

    // Check if 90%+ filled (complete)
    if (order.filledAmount >= order.size * 0.90) {
      this.pendingOrders.delete(event.orderId.toLowerCase());
    }
  }
}
```

---

## Event Types

| Event Type | Use For |
|------------|---------|
| `eventType === 'trade'` | **FILLS** - accurate `event.size` |
| `eventType === 'order'` | **CANCELLED/EXPIRED only** |

---

## Common Bugs

### Bug 1: Case Mismatch
```
pendingOrders.set(orderID, {...})       // API: uppercase
pendingOrders.get(event.orderId)        // WSS: lowercase
→ Lookup fails!

FIX: Always .toLowerCase() both sides
```

### Bug 2: Using ORDER events for fills
```
if (event.status === 'MATCHED') {...}   // Catches ORDER events too
→ ORDER event.size might be 0!

FIX: Check event.eventType === 'trade'
```

### Bug 3: Dropping rapid events
```
if (this.isProcessing) return;          // Multiple makers = multiple events
→ Only first maker's fill detected!

FIX: Queue events instead of dropping
```

### Bug 4: Initializing from API response
```
filledAmount = result.filledShares;     // Double-counts
→ WSS will report same fill again!

FIX: Always initialize filledAmount = 0
```

---

## Reference: SetBasedStrategy.ts

- `orderUpdateQueue` - Event queue (line ~213)
- `processOrderUpdateQueue()` - Queue processor (line ~374)
- `handleOrderUpdate()` - Fill handler (line ~386)
- `pendingOrders.set()` - All use `.toLowerCase()`
