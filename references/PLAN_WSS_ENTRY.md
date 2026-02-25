# BTC Martingale Trading Bot - Entry with WSS for Liquidity

## Problem

The previous approach used Market Gamma API for entry price, but early in the market (first ~30-60 seconds) there is **no liquidity** in the order book. FAK orders fail with:
```
"no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found."
```

## Solution

Use **WSS during entry window** to:
1. Monitor when the order book has liquidity (asks available)
2. Wait for price to be ≤ $0.55
3. Only then execute the buy order

## Architecture

| Phase | Data Source | Duration |
|-------|-------------|----------|
| Entry (0-120s) | WebSocket | Monitor order book for liquidity |
| Hold (120-810s) | None | No monitoring |
| Stop-Loss (810-900s) | WebSocket | Real-time bid monitoring |
| PNL Check (890s) | Positions API | Single call |

## Entry Logic (0-120 seconds)

### 1. Connect WSS at market start
At second 0, connect to WSS and subscribe to UP token:
```typescript
async handleNewMarket(market: MarketInfo): Promise<void> {
  // Connect WSS immediately for entry monitoring
  this.orderBookWS = new OrderBookWebSocket(market.clobTokenIds);
  await this.orderBookWS.connect();
  this.state.wsConnected = true;
}
```

### 2. Wait for order book liquidity
Check every loop (2 seconds) if there's an ASK available:
```typescript
async executeEntry(market: MarketInfo): Promise<void> {
  const upTokenId = market.clobTokenIds[0];
  const bestAsk = this.orderBookWS.getBestAsk(upTokenId);

  // No liquidity yet - keep waiting
  if (bestAsk === 0) {
    console.log('⏳ No order book yet, waiting for liquidity...');
    return; // Will retry on next loop
  }

  // Check price condition
  if (bestAsk > 0.55) {
    console.log(`⏳ Price $${bestAsk.toFixed(4)} > $0.55, waiting for drop...`);
    return; // Will retry on next loop
  }

  // Liquidity available and price is good - execute!
  const positionSize = await this.calculatePositionSize(bestAsk);
  const sharesToBuy = positionSize / bestAsk;
  await this.client.buyShares(upTokenId, sharesToBuy, bestAsk + 0.02);

  this.state.entryExecuted = true;
}
```

### 3. Disconnect WSS after entry or window end
At second 120 (entry window end):
- If entry executed → Disconnect WSS (reconnect at 810 for stop-loss)
- If no entry (price too high) → Disconnect WSS, skip this market

### 4. Reconnect WSS for stop-loss
At second 810, reconnect WSS for stop-loss monitoring.

## Files to Modify

### 1. `src/types/index.ts`
Change ENTRY_WINDOW_END from 40 to 120:
```typescript
export const TIMING = {
  ENTRY_WINDOW_START: 0,        // Second 0
  ENTRY_WINDOW_END: 120,        // Second 120 (2 minutes) - WAS 40
  STOP_LOSS_START: 810,         // 13:30
  PNL_CHECK_TIME: 890,          // 14:50
  MARKET_END: 900,              // 15:00
  REDEMPTION_DELAY: 600000,     // 10 minutes (ms)
  LOOP_INTERVAL: 2000,          // 2 seconds (ms)
};
```

### 2. `src/strategies/MartingaleStrategy.ts`

**Changes needed:**

#### A. `handleNewMarket()` - Connect WSS immediately
```typescript
private async handleNewMarket(market: MarketInfo): Promise<void> {
  console.log(`\n📊 New market detected: ${market.slug}`);

  // Reset state for new market
  this.state = {
    currentMarket: market,
    currentPosition: null,
    entryExecuted: false,
    stopLossExecuted: false,
    pnlChecked: false,
    redemptionScheduled: false,
    wsConnected: false,
  };

  // Connect WSS immediately for entry monitoring
  if (market.clobTokenIds && market.clobTokenIds.length > 0) {
    console.log('📡 Connecting WSS for entry monitoring...');
    this.orderBookWS = new OrderBookWebSocket(market.clobTokenIds);
    await this.orderBookWS.connect();
    this.state.wsConnected = true;
    console.log('✅ WSS connected');
  }

  // Check if we already have a position in this market
  const existingPosition = this.db.getPositionByMarketSlug(market.slug);
  if (existingPosition) {
    console.log(`   Found existing position in database`);
    this.state.currentPosition = existingPosition;
    this.state.entryExecuted = true;
  }
}
```

#### B. `executeEntry()` - Use WSS getBestAsk() instead of API
```typescript
private async executeEntry(market: MarketInfo): Promise<void> {
  if (!market.clobTokenIds || market.clobTokenIds.length === 0) {
    console.log('⚠️ No token IDs for entry');
    return;
  }

  if (!this.orderBookWS || !this.state.wsConnected) {
    console.log('⚠️ WSS not connected');
    return;
  }

  const upTokenId = market.clobTokenIds[0];
  const bestAsk = this.orderBookWS.getBestAsk(upTokenId);

  // No liquidity yet - keep waiting
  if (bestAsk === 0) {
    console.log('⏳ No order book yet, waiting for liquidity...');
    return; // Will retry on next loop
  }

  console.log(`📈 UP ASK price: $${bestAsk.toFixed(4)}`);

  // Check entry condition
  if (bestAsk > THRESHOLDS.MAX_ENTRY_PRICE) {
    console.log(`⏳ Price $${bestAsk.toFixed(4)} > $${THRESHOLDS.MAX_ENTRY_PRICE}, waiting for drop...`);
    return; // Will retry on next loop
  }

  // Liquidity available and price is good - execute!
  const positionSize = await this.calculatePositionSize(bestAsk);
  const sharesToBuy = positionSize / bestAsk;

  console.log(`💰 Position size: $${positionSize.toFixed(2)} (${sharesToBuy.toFixed(2)} shares)`);

  // Execute BUY
  const maxPrice = Math.min(bestAsk + 0.02, 0.99);
  const result = await this.client.buyShares(upTokenId, sharesToBuy, maxPrice);

  if (!result.success) {
    console.error(`❌ Entry failed: ${result.error}`);
    // Don't mark as executed - will retry
    return;
  }

  const filledPrice = result.filledPrice || bestAsk;
  const filledShares = result.filledShares || sharesToBuy;

  console.log(`✅ ENTRY: ${filledShares.toFixed(2)} shares @ $${filledPrice.toFixed(4)}`);

  // Record in database
  const positionId = this.db.insertPosition({
    market_slug: market.slug,
    condition_id: market.conditionId,
    token_id: upTokenId,
    entry_price: filledPrice,
    shares: filledShares,
    entry_time: Date.now(),
    market_end_time: new Date(market.endDate).getTime(),
  });

  // Log the trade
  this.db.logTrade({
    position_id: positionId,
    event_type: 'entry',
    details: JSON.stringify({
      orderID: result.orderID,
      shares: filledShares,
      price: filledPrice,
      positionSize,
    }),
    timestamp: Date.now(),
  });

  this.state.currentPosition = this.db.getPositionById(positionId) || null;
  this.state.entryExecuted = true;
}
```

#### C. `handleMarketPhase()` - Disconnect WSS after entry window, reconnect at 810
```typescript
private async handleMarketPhase(market: MarketInfo, marketSecond: number): Promise<void> {
  // Log current state periodically
  if (marketSecond % 30 === 0) {
    console.log(`⏱️  Market: ${market.slug} | Second: ${marketSecond}`);
  }

  // PHASE 1: Entry Window (0-120 seconds) - Use WSS
  if (marketSecond >= TIMING.ENTRY_WINDOW_START &&
      marketSecond <= TIMING.ENTRY_WINDOW_END &&
      !this.state.entryExecuted) {
    await this.executeEntry(market);
  }

  // Disconnect WSS after entry window ends (to save resources)
  if (marketSecond > TIMING.ENTRY_WINDOW_END &&
      marketSecond < TIMING.STOP_LOSS_START &&
      this.state.wsConnected) {
    console.log('📴 Disconnecting entry WSS (entry window ended)');
    this.disconnectWS();
  }

  // PHASE 2: Reconnect WSS for stop-loss (at second 810)
  if (marketSecond >= TIMING.STOP_LOSS_START &&
      marketSecond < TIMING.MARKET_END &&
      this.state.currentPosition &&
      !this.state.wsConnected) {
    await this.connectStopLossWS(market);
  }

  // PHASE 3: Stop-Loss Check (810-900 seconds) - Use WSS
  if (marketSecond >= TIMING.STOP_LOSS_START &&
      marketSecond < TIMING.MARKET_END &&
      this.state.currentPosition &&
      !this.state.stopLossExecuted &&
      this.state.wsConnected) {
    await this.checkStopLoss(market, marketSecond);
  }

  // PHASE 4: PNL Check (at 14:50)
  if (marketSecond >= TIMING.PNL_CHECK_TIME &&
      marketSecond < TIMING.MARKET_END &&
      this.state.currentPosition &&
      !this.state.pnlChecked) {
    await this.checkPnl();
  }

  // PHASE 5: Market End (after 15:00)
  if (marketSecond >= TIMING.MARKET_END && !this.state.redemptionScheduled) {
    await this.handleMarketEnd();
  }
}
```

## Timing Flow

```
Next Market (starting):
├── Second 0: Connect WSS, subscribe to UP token
├── Second 0-120: ENTRY WINDOW (WSS)
│   ├── Check getBestAsk(upTokenId)
│   ├── If ASK = 0 → "No order book yet" (keep waiting)
│   ├── If ASK > $0.55 → "Price too high" (keep waiting)
│   └── If ASK ≤ $0.55 → Execute buy!
├── Second 120: Disconnect WSS (entry window ends)
├── Second 120-810: HOLD (no monitoring, no WSS)
├── Second 810: Reconnect WSS for stop-loss
├── Second 810-900: STOP-LOSS WINDOW (WSS)
│   ├── Monitor UP BID price
│   └── If BID < $0.20 → Execute sell
├── Second 890: PNL check (Positions API)
└── Second 900: Disconnect WSS, market ends
```

## Benefits

1. **Handles no-liquidity scenario** - Waits for order book to populate
2. **Real-time price** - WSS gives instant price updates
3. **Extended opportunity** - 2 minutes to catch price drops
4. **Resource efficient** - WSS only during entry (0-120s) and stop-loss (810-900s)

## Key Constants

```typescript
ENTRY_WINDOW_END: 120,       // 2 minutes (was 40 seconds)
MAX_ENTRY_PRICE: 0.55,       // Skip if ASK > $0.55
STOP_LOSS_PRICE: 0.20,       // Exit if BID < $0.20
STOP_LOSS_START: 810,        // Only check after 13:30
```

## Summary of Changes

1. **`src/types/index.ts`**: Change `ENTRY_WINDOW_END` from 40 to 120
2. **`src/strategies/MartingaleStrategy.ts`**:
   - `handleNewMarket()`: Connect WSS immediately at market start
   - `executeEntry()`: Use `getBestAsk()` from WSS instead of API
   - `handleMarketPhase()`: Add disconnect after entry window (second 120), reconnect at 810
