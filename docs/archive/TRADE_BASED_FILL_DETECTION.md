# Trade-Based Fill Detection for Paper Trading

## Overview

This document describes the realistic paper trading fill simulation method implemented in ArbitrageSimulation_Dashboard.ts. The approach uses actual WebSocket trade events to determine when limit orders would realistically fill, rather than optimistically assuming fills whenever price crosses the limit.

## Problem with Naive Fill Detection

The naive approach fills limit orders whenever **any** trade occurs below the limit price:

```
❌ WRONG: Ask <= limitPrice → Fill our limit order
```

This is unrealistic because:
1. A trade at $0.29 shouldn't fill our $0.53 order
2. Real limit orders only fill when a counterparty trades **at our price level**
3. This leads to overly optimistic backtests that don't match live performance

## Correct Fill Detection Logic

### WebSocket Data Structure

Polymarket WSS `price_changes` events contain trade data inside each change object:

```typescript
interface PriceChange {
  asset_id: string;   // Token ID for this specific trade
  price: string;      // Trade price (e.g., "0.53")
  size: string;       // Trade size in shares (e.g., "25.5")
  side: "BUY" | "SELL";  // Taker side (BUY = taker bought, SELL = taker sold)
  hash: string;       // Transaction hash
  best_bid?: string;  // Current best bid after trade
  best_ask?: string;  // Current best ask after trade
}
```

**Key insight**: The `side` field indicates the **taker's action**:
- `SELL` = Taker is selling → They're hitting bids → Our BUY limit orders can fill
- `BUY` = Taker is buying → They're lifting asks → Our SELL limit orders can fill

**Important**: The `asset_id` is inside each change object, not in the outer message (which may be `undefined`).

### Fill Conditions for BUY Limit Orders

A BUY limit order fills when:

1. **Exact Match**: Trade occurs at our limit price (±0.5¢ tolerance)
   ```
   |tradePrice - ourLimitPrice| < 0.005
   ```

2. **Sweep Through**: Aggressive seller sweeps through our price level
   ```
   tradePrice < ourLimitPrice AND ourLimitPrice <= bestBid + 0.01
   ```
   This catches scenarios where a large sell order sweeps multiple bid levels.

### TradeEvent Interface

```typescript
export interface TradeEvent {
  tokenId: string;
  tradePrice: number;
  tradeSize: number;    // Size for partial fill simulation
  side: "buy" | "sell"; // API-provided taker side (lowercase)
  bestBid: number;
  bestAsk: number;
  timestamp: number;
}
```

## SimOrder Interface

Orders track cumulative fills for partial fill support:

```typescript
export interface SimOrder {
  orderId: string;
  side: "UP" | "DOWN";
  limitPrice: number;
  size: number;
  filledAmount: number;  // Total filled so far (for partial fills)
  orderType: "normal" | "balance";
  placedAt: number;
  entryType?: EntryType;  // For logging which entry type this order was
}
```

## Implementation

### WebSocket Event Handling (OrderBookWS.ts)

```typescript
// Handle price_changes (trade notifications) for fill detection
if (message.price_changes && Array.isArray(message.price_changes)) {
  for (const change of message.price_changes) {
    // Use the asset_id from the change itself, not from the outer message
    const changeAssetId = change.asset_id || message.asset_id;
    const tokenId = this.tokenIds.find((id) =>
      id.startsWith(changeAssetId) || changeAssetId.startsWith(id)
    ) || changeAssetId;
    
    this.handlePriceChange(tokenId, change);
  }
}

private handlePriceChange(tokenId: string, change: any): void {
  const tradePrice = parseFloat(change.price || "0");
  const tradeSize = change.size ? parseFloat(change.size) : 0;

  // Skip trades with no meaningful price
  if (tradePrice <= 0) return;

  // If no size provided, use a default of 1 for fill detection
  const effectiveSize = tradeSize > 0 ? tradeSize : 1;

  // Use API-provided side if available, otherwise infer from price vs mid
  let side: "buy" | "sell" = "sell";
  if (change.side) {
    side = change.side.toLowerCase() as "buy" | "sell";
  } else {
    // Fallback: infer from price relative to bid/ask
    const book = this.orderBooks.get(tokenId);
    if (book) {
      const bestBid = this.getBestBid(tokenId);
      const bestAsk = this.getBestAsk(tokenId);
      const midPrice = (bestBid + bestAsk) / 2;
      side = tradePrice >= midPrice ? "buy" : "sell";
    }
  }

  const tradeEvent: TradeEvent = {
    tokenId,
    tradePrice,
    tradeSize: effectiveSize,
    side,
    bestBid: this.getBestBid(tokenId),
    bestAsk: this.getBestAsk(tokenId),
    timestamp: Date.now(),
  };

  this.emit("trade", tradeEvent);
}
```

### Trade Event Handler (ArbitrageSimulation_Dashboard.ts)

```typescript
private handleTradeEvent(event: TradeEvent): void {
  // Match tokens - support both exact match and partial match (startsWith)
  const isUpToken =
    event.tokenId === this.upTokenId ||
    event.tokenId.startsWith(this.upTokenId) ||
    this.upTokenId.startsWith(event.tokenId);
  const isDownToken =
    event.tokenId === this.downTokenId ||
    event.tokenId.startsWith(this.downTokenId) ||
    this.downTokenId.startsWith(event.tokenId);

  // Only SELL trades can fill our BUY limit orders
  // (A seller is hitting bids, which means our resting bid could be hit)
  if (event.side !== "sell") return;

  // Skip trades with no size
  if (event.tradeSize <= 0) return;

  // Token must match
  if (!isUpToken && !isDownToken) return;

  const side: "UP" | "DOWN" = isUpToken ? "UP" : "DOWN";

  // Find pending orders for this side
  const ordersToCheck: SimOrder[] = [];
  for (const order of this.pendingOrders.values()) {
    if (order.side === side) {
      ordersToCheck.push(order);
    }
  }

  if (ordersToCheck.length === 0) return;

  // Distribute trade size across orders at this price level
  // Sort by price descending (highest price = most aggressive = fills first)
  ordersToCheck.sort((a, b) => b.limitPrice - a.limitPrice);

  let remainingTradeSize = event.tradeSize;

  for (const order of ordersToCheck) {
    if (remainingTradeSize <= 0) break;

    const remainingOrderSize = order.size - order.filledAmount;
    if (remainingOrderSize <= 0) continue;

    // Check fill conditions
    const exactMatch = Math.abs(event.tradePrice - order.limitPrice) < 0.005;
    const sweptThrough =
      event.tradePrice < order.limitPrice &&
      order.limitPrice <= event.bestBid + 0.01;

    if (!exactMatch && !sweptThrough) continue;

    // Calculate fill amount
    const fillAmount = Math.min(remainingTradeSize, remainingOrderSize);
    remainingTradeSize -= fillAmount;

    // Process the fill
    const isFullFill = order.filledAmount + fillAmount >= order.size - 0.01;
    const fillType = isFullFill ? "FULL" : "PARTIAL";

    // Log with entry type if available
    const entryLabel = order.entryType ? ` (${order.entryType})` : "";
    console.log(
      `  🎯 [TRADE-${fillType}] ${order.side}${entryLabel}: ${fillAmount.toFixed(1)} @ $${order.limitPrice.toFixed(3)}`,
      `(trade=${event.tradeSize.toFixed(1)}@${event.tradePrice.toFixed(3)},`,
      `filled=${(order.filledAmount + fillAmount).toFixed(1)}/${order.size})`,
    );

    // Apply the fill
    this.fillOrder(order, fillAmount, order.limitPrice);

    // Remove order if fully filled
    if (isFullFill) {
      this.pendingOrders.delete(order.orderId);
    }
  }
}
```

### Subscribing to Trade Events

```typescript
private async initializeWebSocket(): Promise<void> {
  this.orderBookWS = new OrderBookWebSocket([
    this.upTokenId,
    this.downTokenId,
  ]);
  await this.orderBookWS.connect();

  // Handle price updates (for tracking bid/ask, NOT for fills)
  this.orderBookWS.on("priceUpdate", (event: PriceUpdateEvent) => {
    this.handlePriceUpdate(event);
    // NOTE: Do NOT check fills here - use trade-based detection instead
  });

  // Handle trade events for realistic fill detection
  this.orderBookWS.on("trade", (event: TradeEvent) => {
    this.handleTradeEvent(event);
  });

  await this.waitForPrices();
}
```

## Key Implementation Details

### Token ID Matching

Polymarket WebSocket may send partial token IDs. Use flexible matching:

```typescript
const isUpToken =
  event.tokenId === this.upTokenId ||
  event.tokenId.startsWith(this.upTokenId) ||
  this.upTokenId.startsWith(event.tokenId);
```

### Order Priority

When multiple orders exist at different prices, fill most aggressive first:

```typescript
// Sort by price descending (highest price = most aggressive = fills first)
ordersToCheck.sort((a, b) => b.limitPrice - a.limitPrice);
```

### Partial Fill Tracking

Orders accumulate fills until fully filled:

```typescript
const remainingOrderSize = order.size - order.filledAmount;
const fillAmount = Math.min(remainingTradeSize, remainingOrderSize);
const isFullFill = order.filledAmount + fillAmount >= order.size - 0.01;
```

## Key Takeaways

1. **Only fill on exact price match or sweep-through** - Not on any trade below limit
2. **Use API-provided `side` field** - Don't infer from price when API provides it
3. **Read `asset_id` from each change object** - Outer message may have `undefined`
4. **Accumulate partial fills** - Real orders fill incrementally based on trade size
5. **Track `filledAmount` on orders** - Only remove order when fully filled
6. **SELL trades fill BUY limits** - Taker selling into bids fills our buy orders
7. **Use flexible token matching** - Support partial ID matches with `startsWith`

## Comparison: Before vs After

| Scenario | Naive (Wrong) | Trade-Based (Correct) |
|----------|---------------|----------------------|
| Trade at $0.29, our limit at $0.53 | ✅ Fill | ❌ No fill (not at our level) |
| Trade at $0.53, our limit at $0.53 | ✅ Fill | ✅ Fill (exact match) |
| 10-share trade, 20-share order | ✅ Full fill | ⚠️ Partial fill (10/20) |
| BUY trade (taker buying) | ✅ Fill | ❌ No fill (wrong side) |
| SELL trade at our level | ✅ Fill | ✅ Fill (correct) |

## Files Modified

- `poly_arbitrage/src/services/OrderBookWS.ts` - Parse `asset_id` from change objects, emit TradeEvent with size/side
- `poly_arbitrage/src/strategies/ArbitrageSimulation_Dashboard.ts` - Trade-based fill detection with partial fills
- `poly_arbitrage/src/strategies/ArbitrageSimulation.ts` - Same changes for non-dashboard version
