# ArbitrageSimulation Dashboard Integration Guide

This comprehensive guide covers:
1. How `ArbitrageSimulation.ts` was ported to create dashboard-integrated variants
2. Step-by-step integration with dashboard-v2
3. Trade-based vs price-based fill detection
4. Complete DashboardRelay API reference
5. Running and troubleshooting instructions

---

## Overview

| File | Fill Detection | Dashboard | Use Case |
|------|---------------|-----------|----------|
| `ArbitrageSimulation.ts` | Price-based (optimistic) | Built-in WebSocket server | Standalone simulation |
| `ArbitrageSimulation_Dashboard.ts` | Price-based (optimistic) | DashboardRelay | Dashboard-v2 integration |
| `ArbitrageSimulation_TradeFill.ts` | Trade-based (realistic) | DashboardRelay | Realistic simulation with dashboard |

Dashboard-v2 provides real-time visualization of:
- Order lifecycle (placed, filled, cancelled)
- Position tracking (quantities, averages, P&L)
- Price updates (bid/ask for UP/DOWN)
- Market switches (15-minute windows)
- Log messages with level filtering
- Surge line visualization (supply line during surge detection)
- Hedge line visualization (horizontal line showing pending hedge order price)
- Mode change logging (NORMAL → BALANCING → PROFIT_LOCK transitions)
- Market exit logging (when bot stops trading in a window)

---

## Part 1: Key Differences Between Variants

### 1.1 Dashboard Integration

**Original (`ArbitrageSimulation.ts`):**
- Has its own WebSocket server (`dashboardWss`, `dashboardClients`)
- Broadcasts state via `broadcastState()` and `broadcastEvent()`
- Runs on configurable port (default 8080)

```typescript
// Original - built-in WebSocket server
private dashboardWss: WebSocketServer | null = null;
private dashboardClients: Set<WebSocket> = new Set();
private dashboardPort: number = 8080;

private async startDashboardServer() {
  this.dashboardWss = new WebSocketServer({ port: this.dashboardPort });
  // ... handle connections
}

private broadcastState() {
  const state = { type: 'state', data: { ... } };
  const message = JSON.stringify(state);
  for (const client of this.dashboardClients) {
    client.send(message);
  }
}
```

**Dashboard Variants (`_Dashboard.ts` and `_TradeFill.ts`):**
- Use centralized `DashboardRelay` singleton
- Emit events via relay methods
- No internal WebSocket management

```typescript
// Dashboard variants - use DashboardRelay
import { dashboardRelay } from "../services/DashboardRelay";

private emitPositionUpdate(): void {
  dashboardRelay.positionUpdate(
    this.stats.upQty,
    this.stats.downQty,
    upAvg,
    downAvg,
    pairCost,
    hedged,
    totalPnL,
    this.simBalance,
    this.initialBalance,
    this.marketCount,
    this.windowMergedPairs,
    this.windowMergeProfit,
  );
}

private dashLog(message: string, level: "info" | "warn" | "error" | "success" | "debug" = "info"): void {
  console.log(message);
  dashboardRelay.log(message, level);
}
```

### 1.2 Merge Tracking

**Original:**
- Uses `simulateMerge()` but doesn't track window-specific merges
- Only tracks total profit via `totalProfit` and `lockedProfit`

**Dashboard Variants:**
- Added window-specific merge tracking:

```typescript
// Total merge tracking (lifetime)
private totalMergedPairs: number = 0;
private totalMergeProfit: number = 0;
private mergeCount: number = 0;

// Window-specific merge tracking (reset each market)
private windowMergedPairs: number = 0;
private windowMergeProfit: number = 0;
```

- Reset in `initializeMarket()`:

```typescript
// Reset window-specific merge tracking
this.windowMergedPairs = 0;
this.windowMergeProfit = 0;
```

- Updated `simulateMerge()` to track both:

```typescript
private simulateMerge(hedged: number): void {
  // ... calculation ...
  
  // Update merge tracking (total and window-specific)
  this.totalMergedPairs += hedged;
  this.totalMergeProfit += profit;
  this.mergeCount++;
  this.windowMergedPairs += hedged;
  this.windowMergeProfit += profit;
  
  // Emit to dashboard
  this.emitPositionUpdate();
}
```

### 1.3 Order Event Emissions

**Original:**
- Orders are placed/cancelled silently (internal tracking only)
- No external notification of order state changes

**Dashboard Variants:**
- Emit order events to dashboard:

```typescript
private placeOrder(side: "UP" | "DOWN", price: number, size: number, orderType: "normal" | "balance" | "reversal", entryType?: EntryType): string {
  const orderId = this.generateOrderId();
  const order: SimOrder = { ... };
  this.pendingOrders.set(orderId, order);

  // Emit order placed to dashboard
  dashboardRelay.orderPlaced(
    orderId,
    side,
    price,
    size,
    orderType === "normal" ? "trigger" : "hedge",
    `ARB-${this.marketCount}`,
  );

  this.dashLog(`[ORDER] ${side} $${price.toFixed(2)} (${size})`, "info");
  return orderId;
}
```

- Emit cancellations in `resetBalancingState()`:

```typescript
private resetBalancingState(): void {
  // Cancel any pending trigger/hedge orders and notify dashboard
  if (this.triggerOrderId && this.triggerOrderId !== "instant-fill") {
    const order = this.pendingOrders.get(this.triggerOrderId);
    if (order) {
      dashboardRelay.orderCancelled(this.triggerOrderId, order.side, order.limitPrice);
      this.pendingOrders.delete(this.triggerOrderId);
    }
  }
  if (this.hedgeOrderId) {
    const order = this.pendingOrders.get(this.hedgeOrderId);
    if (order) {
      dashboardRelay.orderCancelled(this.hedgeOrderId, order.side, order.limitPrice);
      this.pendingOrders.delete(this.hedgeOrderId);
    }
  }
  // ... rest of reset
}
```

- Emit fills in `fillOrder()`:

```typescript
private fillOrder(order: SimOrder, fillSize: number, fillPrice: number): void {
  // ... fill logic ...
  
  // Emit order filled to dashboard
  dashboardRelay.orderFilled(order.orderId, order.side, fillPrice, fillSize);

  // Emit position update
  this.emitPositionUpdate();
}
```

### 1.4 Fill Detection Methods

**Original and Dashboard Variant:**
- Price-based fill detection (optimistic)
- Orders fill when `limitPrice >= currentAsk`

```typescript
private checkPendingOrderFills(): void {
  for (const order of this.pendingOrders.values()) {
    const currentAsk = order.side === "UP" ? this.upAsk : this.downAsk;
    // Fill when limit price >= ask (order is at or above ask)
    if (currentAsk > 0 && order.limitPrice >= currentAsk) {
      const remaining = order.size - order.filledAmount;
      if (remaining > 0) {
        this.fillOrder(order, remaining, currentAsk);
      }
    }
  }
}
```

**TradeFill Variant:**
- Trade-based fill detection (realistic)
- Orders fill based on actual trade events
- Supports partial fills

```typescript
private handleTradeEvent(event: TradeEvent): void {
  // Only SELL trades can fill our BUY limit orders
  if (event.side !== "sell") {
    this.tradeStats.buyTrades++;
    return;
  }
  this.tradeStats.sellTrades++;

  // Check if trade matches any pending orders
  const side: "UP" | "DOWN" = isUpToken ? "UP" : "DOWN";
  const ordersToCheck = Array.from(this.pendingOrders.values())
    .filter((o) => o.side === side && o.filledAmount < o.size);

  let remainingTradeSize = event.size;

  for (const order of ordersToCheck) {
    if (remainingTradeSize <= 0) break;
    
    const remainingOrderSize = order.size - order.filledAmount;
    
    // 1. Exact match: trade at our price level (0.5c tolerance)
    const exactMatch = Math.abs(event.tradePrice - order.limitPrice) < 0.005;
    
    // 2. Sweep through: aggressive seller sweeps through our price level
    const sweptThrough = event.tradePrice < order.limitPrice && 
                         order.limitPrice <= event.bestBid + 0.01;

    if (exactMatch || sweptThrough) {
      const fillAmount = Math.min(remainingTradeSize, remainingOrderSize);
      this.fillOrder(order, fillAmount, order.limitPrice);
      remainingTradeSize -= fillAmount;
      
      this.tradeStats.fillsTriggered++;
      if (fillAmount === remainingOrderSize) {
        this.tradeStats.fullFills++;
      } else {
        this.tradeStats.partialFills++;
      }
    }
  }
}
```

**TradeFill also has:**
- Trade statistics tracking:

```typescript
private tradeStats = {
  tradesReceived: 0,
  sellTrades: 0,
  buyTrades: 0,
  fillsTriggered: 0,
  partialFills: 0,
  fullFills: 0,
};
```

- Renamed `checkPendingOrderFills()` to `checkAggressiveOrderFills()` (for taker orders at/above ask)

### 1.5 Settlement Calculation

**Original:**
- Simple settlement based on hedged pairs only

**Dashboard Variants:**
- Enhanced settlement with proper winner determination:

```typescript
private async cleanupMarket(): Promise<void> {
  // Save final prices before reset
  const finalUpBid = this.upBid;
  const finalDownBid = this.downBid;
  
  // ... cleanup logic ...
  
  // Determine winner based on final bid prices
  const upWins = finalUpBid >= finalDownBid;
  const winningSide = upWins ? "UP" : "DOWN";
  
  // Calculate unhedged P&L
  const unhedgedUp = this.stats.upQty - hedgedPairs;
  const unhedgedDown = this.stats.downQty - hedgedPairs;
  const unhedgedReturn = upWins ? unhedgedUp * 1.0 : unhedgedDown * 1.0;
  
  // Total return = hedged return + unhedged return
  const totalReturn = hedgedReturn + unhedgedReturn;
  const profit = totalReturn - totalCost;
  
  this.dashLog(
    `[SETTLEMENT] ${winningSide} wins (bid ${(upWins ? finalUpBid : finalDownBid).toFixed(2)})`,
    "info"
  );
}
```

---

## Part 2: Step-by-Step Integration Guide

### Step 1: Required Imports

Add these imports to your simulation class:

```typescript
import { dashboardRelay } from "../services/DashboardRelay";
import { 
  OrderBookWebSocket, 
  PriceUpdateEvent, 
  TradeEvent  // Required for trade-based fill detection
} from "../services/OrderBookWS";
```

### Step 2: Remove Built-in WebSocket Server

If your original simulation has a built-in WebSocket server for trade_monitor_sim, **remove it entirely**. Dashboard-v2 uses `DashboardRelay` instead.

### Step 3: Update SimOrder Interface

Add the `entryType` field for order logging:

```typescript
export interface SimOrder {
  orderId: string;
  side: "UP" | "DOWN";
  limitPrice: number;
  size: number;
  filledAmount: number;      // Total filled so far (for partial fills)
  orderType: "normal" | "balance" | "reversal";
  placedAt: number;
  entryType?: EntryType;     // NEW: For logging which entry type
}
```

### Step 4: Implement Trade-Based Fill Detection (TradeFill variant only)

#### 4.1 Subscribe to Trade Events

Update your WebSocket subscription to handle both price updates and trade events:

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

#### 4.2 Implement handleTradeEvent()

See Section 1.4 above for the full implementation.

### Step 5: Emit Dashboard Events

#### 5.1 Market Switch

Emit when entering a new 15-minute market:

```typescript
private async initializeMarket(market: MarketInfo): Promise<void> {
  // ... setup code ...

  // Emit market switch to dashboard
  dashboardRelay.marketSwitch(
    this.marketSlug,
    this.conditionId,
    Math.floor((this.marketStartTime + 15 * 60 * 1000) / 1000),  // endTime
    this.upTokenId,
    this.downTokenId,
  );
}
```

#### 5.2 Order Placed

Emit when placing a new order:

```typescript
private placeOrder(
  side: "UP" | "DOWN",
  price: number,
  size: number,
  orderType: "normal" | "balance",
): void {
  const orderId = this.generateOrderId();

  const order: SimOrder = {
    orderId,
    side,
    limitPrice: price,
    size,
    filledAmount: 0,
    orderType,
    placedAt: Date.now(),
  };
  this.pendingOrders.set(orderId, order);

  // Emit order placed to dashboard
  dashboardRelay.orderPlaced(
    orderId,
    side,
    price,
    size,
    orderType === "normal" ? "trigger" : "hedge",
    `ARB-${this.marketCount}`,  // setId for grouping
  );
}
```

#### 5.3 Order Filled

Emit when an order is filled (inside fillOrder method):

```typescript
private fillOrder(order: SimOrder, fillSize: number, fillPrice: number): void {
  order.filledAmount += fillSize;
  const cost = fillSize * fillPrice;

  // Update stats
  if (order.side === "UP") {
    this.stats.upQty += fillSize;
    this.stats.upCost += cost;
  } else {
    this.stats.downQty += fillSize;
    this.stats.downCost += cost;
  }
  this.simBalance -= cost;

  // Emit order filled to dashboard
  dashboardRelay.orderFilled(order.orderId, order.side, fillPrice, fillSize);

  // Also emit position update
  this.emitPositionUpdate();
}
```

#### 5.4 Order Cancelled

Emit when cancelling orders:

```typescript
private cancelAllOrders(): void {
  for (const [orderId, order] of this.pendingOrders) {
    dashboardRelay.orderCancelled(orderId, order.side, order.limitPrice);
  }
  this.pendingOrders.clear();
}
```

#### 5.5 Position Update

Create a helper method to emit position updates:

```typescript
private emitPositionUpdate(): void {
  const upAvg = this.stats.upQty > 0 ? this.stats.upCost / this.stats.upQty : 0;
  const downAvg = this.stats.downQty > 0 ? this.stats.downCost / this.stats.downQty : 0;
  const pairCost = upAvg + downAvg;
  const hedged = Math.min(this.stats.upQty, this.stats.downQty);
  const totalPnL = this.simBalance - this.initialBalance;

  dashboardRelay.positionUpdate(
    this.stats.upQty,
    this.stats.downQty,
    upAvg,
    downAvg,
    pairCost,
    hedged,
    totalPnL,
    this.simBalance,
    this.initialBalance,
    this.marketCount,
    this.windowMergedPairs,
    this.windowMergeProfit,
  );
}
```

#### 5.6 Price Update

Emit on every price tick:

```typescript
private handlePriceUpdate(event: PriceUpdateEvent): void {
  if (event.tokenId === this.upTokenId) {
    this.upBid = event.bid || this.upBid;
    this.upAsk = event.ask || this.upAsk;
  } else if (event.tokenId === this.downTokenId) {
    this.downBid = event.bid || this.downBid;
    this.downAsk = event.ask || this.downAsk;
  }

  // Emit price update to dashboard on every tick
  dashboardRelay.priceUpdate(
    this.upBid,
    this.upAsk,
    this.downBid,
    this.downAsk,
  );
}
```

#### 5.7 Log Messages

Use the dashLog helper for dual logging (console + dashboard):

```typescript
private dashLog(
  message: string,
  level: "info" | "warn" | "error" | "success" | "debug" = "info",
): void {
  console.log(message);
  dashboardRelay.log(message, level);
}

// Usage examples:
this.dashLog("Market started", "info");
this.dashLog("Position imbalanced!", "warn");
this.dashLog("Order filled successfully", "success");
this.dashLog("API error occurred", "error");
```

#### 5.8 Mode Change Logging

Log mode transitions to the dashboard for visibility:

```typescript
private async periodicCheck(): Promise<boolean> {
  const mode = this.getMode();
  const modeChanged = this.lastMode !== mode;

  // Log mode changes to dashboard
  if (modeChanged && this.lastMode !== null) {
    this.dashLog(`[MODE] ${this.lastMode} → ${mode}`, "warn");
  }

  // Reset balancing state when exiting BALANCING mode
  if (this.lastMode === "BALANCING" && mode !== "BALANCING") {
    this.dashLog(`[MODE] Exit BALANCING → ${mode}`, "info");
    this.resetBalancingState();
  }
  this.lastMode = mode;

  // ... rest of periodic check
}
```

#### 5.9 Market Exit Logging

Log when the bot stops trading in a market window:

```typescript
// Exit on 3rd profit lock
if (this.profitLockCount >= 3) {
  this.dashLog(`[PROFIT-LOCK] 3rd lock achieved - exiting market`, "success");
  this.dashLog(`[EXIT] Stopped trading this window`, "warn");
  return false;
}

// Exit if past stop minute after successful profit-lock
if (currentMinute >= this.config.stopMinute && this.profitLockCount > 0) {
  this.dashLog(`[PROFIT-LOCK] Past M${this.config.stopMinute} with ${this.profitLockCount} lock(s) - exiting market`, "info");
  this.dashLog(`[EXIT] Stopped trading this window`, "warn");
  return false;
}

// Exit if past stop minute AND profitable
if (currentMinute >= this.config.stopMinute && this.isProfitable()) {
  this.dashLog(`[STOP] M${currentMinute.toFixed(0)} >= M${this.config.stopMinute} AND profitable`, "info");
  this.dashLog(`[EXIT] Stopped trading this window`, "warn");
  return true;
}

// Exit if capital limit reached AND profitable
if (capitalUsed >= this.config.maxCapitalPct && this.isProfitable()) {
  this.dashLog(`[STOP] Capital ${(capitalUsed * 100).toFixed(0)}% >= ${(this.config.maxCapitalPct * 100).toFixed(0)}% AND profitable`, "info");
  this.dashLog(`[EXIT] Stopped trading this window`, "warn");
  return true;
}
```

#### 5.10 Hedge Line Visualization

Display a horizontal line on the price chart showing the pending hedge order price:

```typescript
// When placing a hedge order in BALANCING mode
dashboardRelay.hedgeLine(
  this.hedgeSide!,      // "UP" or "DOWN"
  this.hedgePrice,      // Price level
  thisCycleHedge,       // Order size
  true,                 // active = true
);

// When hedge order is filled or cancelled
dashboardRelay.clearHedgeLine();
```

The hedge line appears as a purple dashed horizontal line on the price chart with a label showing the side, size, and price.

#### 5.11 Surge Line Visualization

Display a horizontal line showing the supply price when a surge is detected:

```typescript
// When surge is detected
dashboardRelay.surgeLine(
  side,           // "UP" or "DOWN"
  supplyPrice,    // Price before surge
  entryPrice,     // Price when surge triggered
  true,           // active = true
);

// When surge ends
dashboardRelay.clearSurgeLine();
```

### Step 6: Lifecycle Management

#### Start

```typescript
async start(): Promise<void> {
  this.running = true;

  // Start dashboard relay for real-time visualization
  dashboardRelay.start();

  // ... rest of start logic
}
```

#### Stop

```typescript
stop(): void {
  this.running = false;
  
  if (this.orderBookWS) {
    this.orderBookWS.disconnect();
    this.orderBookWS = null;
  }
  
  dashboardRelay.stop();
}
```

---

## Part 3: DashboardRelay API Reference

### Event Types

| Event | Description |
|-------|-------------|
| `ORDER_PLACED` | New limit order placed |
| `ORDER_FILLED` | Order fully filled |
| `ORDER_PARTIAL` | Partial fill |
| `ORDER_CANCELLED` | Order cancelled |
| `POSITION_UPDATE` | Position quantities changed |
| `MARKET_SWITCH` | New 15-min market started |
| `PRICE_UPDATE` | Bid/ask prices updated |
| `MERGE` | Pairs merged for profit |
| `SURGE_LINE` | Supply line for surge detection |
| `HEDGE_LINE` | Horizontal line showing pending hedge order price |
| `CONNECTION_STATUS` | WebSocket connection status |
| `LOG_MESSAGE` | Log message for dashboard |

### Data Interfaces

```typescript
// Order event data
export interface OrderEventData {
  orderId: string;
  side: "UP" | "DOWN";
  price: number;
  size: number;
  filledSize?: number;
  remaining?: number;
  orderType: "trigger" | "hedge" | "accumulation" | "zone";
  setId: string;
  timestamp: number;
}

// Position event data
export interface PositionEventData {
  upQty: number;
  downQty: number;
  upAvg: number;
  downAvg: number;
  pairCost: number;
  hedgedPairs: number;
  totalPnL: number;
  balance: number;
  initialBalance: number;
  windowCount: number;
  windowMergedPairs: number;
  windowMergeProfit: number;
  timestamp: number;
}

// Hedge line event data
export interface HedgeLineEventData {
  side: "UP" | "DOWN";
  price: number;      // The hedge order price
  size: number;       // The hedge order size
  active: boolean;    // true = hedge active, false = hedge filled/cancelled
  timestamp: number;
}

// Surge line event data
export interface SurgeLineEventData {
  side: "UP" | "DOWN";
  supplyPrice: number;  // The supply line price (price before surge)
  entryPrice: number;   // The entry price when surge triggered
  active: boolean;      // true = surge active, false = surge ended
  timestamp: number;
}

// Log event data
export interface LogEventData {
  message: string;
  level: "info" | "warn" | "error" | "success" | "debug";
  timestamp: number;
}

// Market event data
export interface MarketEventData {
  slug: string;
  conditionId: string;
  endTime: number;
  upTokenId: string;
  downTokenId: string;
  timestamp: number;
}

// Price event data
export interface PriceEventData {
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  timestamp: number;
}

// Merge event data
export interface MergeEventData {
  pairs: number;
  profit: number;
  timestamp: number;
}
```

### Method Signatures

```typescript
// Order Events
dashboardRelay.orderPlaced(orderId, side, price, size, orderType, setId): void
dashboardRelay.orderFilled(orderId, side, price, filledSize): void
dashboardRelay.orderPartial(orderId, side, price, filledSize, remaining): void
dashboardRelay.orderCancelled(orderId, side, price): void

// Position Events
dashboardRelay.positionUpdate(
  upQty, downQty, upAvg, downAvg, pairCost, hedgedPairs,
  totalPnL, balance, initialBalance, windowCount,
  windowMergedPairs, windowMergeProfit
): void

// Market Events
dashboardRelay.marketSwitch(slug, conditionId, endTime, upTokenId, downTokenId): void
dashboardRelay.priceUpdate(upBid, upAsk, downBid, downAsk): void

// Visualization Events
dashboardRelay.merge(pairs, profit): void
dashboardRelay.surgeLine(side, supplyPrice, entryPrice, active): void
dashboardRelay.clearSurgeLine(): void
dashboardRelay.hedgeLine(side, price, size, active): void
dashboardRelay.clearHedgeLine(): void

// Logging
dashboardRelay.log(message, level): void
dashboardRelay.logInfo(message): void
dashboardRelay.logWarn(message): void
dashboardRelay.logError(message): void
dashboardRelay.logSuccess(message): void
dashboardRelay.logDebug(message): void

// Utilities
dashboardRelay.start(): void
dashboardRelay.stop(): void
dashboardRelay.getClientCount(): number
dashboardRelay.isActive(): boolean
```

### State Caching

DashboardRelay caches the following for new connections:
- `latestMarket` - Current market info
- `latestPosition` - Current position data
- `latestPrices` - Current bid/ask prices
- `latestSurgeLine` - Active surge line (if any)
- `latestHedgeLine` - Active hedge line (if any)
- `pendingOrders` - All pending orders

When a new client connects, all cached state is sent immediately via `sendCachedState()`.

---

## Part 4: Trade-Based Fill Detection Details

### Why Trade-Based?

The naive approach (`Ask <= limitPrice` → fill) is unrealistic because:
1. Just because ask dropped doesn't mean YOUR order was hit
2. Large orders at better prices fill before yours
3. No concept of partial fills based on actual trade sizes

### Fill Conditions

For BUY limit orders to fill, we need a **SELL trade** at our price level:

| Condition | Logic | Description |
|-----------|-------|-------------|
| **Exact Match** | `\|tradePrice - limitPrice\| < 0.005` | Trade occurred at our price (0.5¢ tolerance) |
| **Sweep Through** | `tradePrice < limitPrice AND limitPrice <= bestBid + 0.01` | Large sell swept through our level |

### TradeEvent Interface

```typescript
interface TradeEvent {
  tokenId: string;     // Token that was traded
  side: "buy" | "sell"; // Taker side (sell = someone sold into bids)
  tradePrice: number;  // Price of the trade
  tradeSize: number;   // Size of the trade
  bestBid: number;     // Best bid after trade
  bestAsk: number;     // Best ask after trade
  timestamp: number;   // Trade timestamp
}
```

### Token Matching

Use flexible matching to handle WebSocket token ID variations:

```typescript
const isUpToken =
  event.tokenId === this.upTokenId ||
  event.tokenId.startsWith(this.upTokenId) ||
  this.upTokenId.startsWith(event.tokenId);
```

---

## Part 5: How to Port New Changes

When updating `ArbitrageSimulation.ts`, follow these steps to port changes to both variants:

### Step 1: Identify the Change Type

| Change Type | Dashboard | TradeFill | Notes |
|-------------|-----------|-----------|-------|
| Strategy logic (modes, calculations) | Yes | Yes | Copy to both |
| Order placement/cancellation | Yes | Yes | Add dashboard emissions |
| Fill detection | Yes | No | TradeFill uses trade-based |
| Price handling | Yes | Yes | Copy to both |
| New state variables | Yes | Yes | Add to both + emit in `emitPositionUpdate()` |

### Step 2: Copy Strategy Logic

For any strategy logic changes (e.g., `executeBalancingMode()`, `calculateBalancingOrders()`):

1. Copy the updated method to both `_Dashboard.ts` and `_TradeFill.ts`
2. Add any new state variables to both files
3. If new state affects position display, update `emitPositionUpdate()`

### Step 3: Add Dashboard Emissions

For any order-related changes:

1. Add `dashboardRelay.orderPlaced()` when placing orders
2. Add `dashboardRelay.orderCancelled()` when cancelling orders
3. Add `dashboardRelay.orderFilled()` when orders fill
4. Call `this.emitPositionUpdate()` after position changes

### Step 4: Handle Fill Detection Differently

- **Dashboard variant**: Keep price-based `checkPendingOrderFills()`
- **TradeFill variant**: Keep trade-based `handleTradeEvent()` and `checkAggressiveOrderFills()`

### Transformation Checklist

When converting `MySimulation.ts` to `MySimulation_Dashboard.ts`:

- [ ] Add imports: `dashboardRelay`, `TradeEvent`
- [ ] Remove built-in WebSocket server (if any)
- [ ] Add `entryType` to SimOrder interface
- [ ] Call `dashboardRelay.start()` in `start()`
- [ ] Call `dashboardRelay.stop()` in `stop()`
- [ ] Subscribe to `"trade"` events from OrderBookWS
- [ ] Implement `handleTradeEvent()` with fill logic
- [ ] Remove naive fill detection from `handlePriceUpdate()`
- [ ] Emit `ORDER_PLACED` when placing orders
- [ ] Emit `ORDER_FILLED` when orders fill
- [ ] Emit `ORDER_CANCELLED` when cancelling
- [ ] Emit `POSITION_UPDATE` after fills and periodically
- [ ] Emit `PRICE_UPDATE` on every price tick
- [ ] Emit `MARKET_SWITCH` when entering new market
- [ ] Create `dashLog()` helper for dual logging
- [ ] Add mode change logging with `[MODE]` prefix
- [ ] Add market exit logging with `[EXIT]` prefix
- [ ] Emit `hedgeLine()` when placing hedge orders
- [ ] Call `clearHedgeLine()` when hedge fills or is cancelled
- [ ] Update entry point file name (add `_Dashboard` suffix)

---

## Part 6: Critical Implementation Details

### 6.1 Preventing Stale Orders on Dashboard

**Problem**: Orders that are cancelled internally (cleanup, hedge adjustments) but not emitted to the dashboard will appear as "stale" pending orders on the chart - showing at old price levels while the market has moved.

**Solution**: Every location that deletes/cancels orders from `pendingOrders` must emit `ORDER_CANCELLED` to the dashboard.

#### Places That Cancel Orders (must emit `orderCancelled`):

**1. `cleanupStaleOrders()` - Orders too far from current bid**

```typescript
private cleanupStaleOrders(): void {
  const staleThreshold = 0.15; // 15 cents away from current bid

  for (const [orderId, order] of this.pendingOrders) {
    // Skip BALANCING trigger/hedge orders - they're managed separately
    if (orderId === this.triggerOrderId || orderId === this.hedgeOrderId) continue;

    const currentBid = order.side === "UP" ? this.upBid : this.downBid;
    const distance = Math.abs(order.limitPrice - currentBid);

    if (distance > staleThreshold) {
      // CRITICAL: Emit cancellation to dashboard BEFORE deleting
      dashboardRelay.orderCancelled(orderId, order.side, order.limitPrice);
      this.pendingOrders.delete(orderId);
      console.log(`  [CLEANUP] Stale ${order.side} @ $${order.limitPrice.toFixed(2)}`);
    }
  }
}
```

**2. `adjustOppositeSideOrders()` - Orders cancelled after fill to maintain pair cost**

```typescript
private adjustOppositeSideOrders(fillSide: "UP" | "DOWN", fillPrice: number): void {
  const TARGET = 1.03;
  const maxOppositePrice = Math.round((TARGET - fillPrice) * 100) / 100;
  const oppositeSide = fillSide === "UP" ? "DOWN" : "UP";

  const toCancel: string[] = [];
  for (const [orderId, order] of this.pendingOrders) {
    if (order.side === oppositeSide && order.limitPrice > maxOppositePrice) {
      toCancel.push(orderId);
    }
  }

  for (const orderId of toCancel) {
    const order = this.pendingOrders.get(orderId);
    if (order) {
      this.dashLog(`[HEDGE-MONITOR] Cancel ${order.side} @ $${order.limitPrice.toFixed(2)}`, "warn");
      // CRITICAL: Emit cancellation to dashboard
      dashboardRelay.orderCancelled(orderId, order.side, order.limitPrice);
      this.pendingOrders.delete(orderId);
    }
  }
}
```

**3. `cancelAllOrders()` - Bulk cancellation (mode changes, market end)**

```typescript
private cancelAllOrders(): void {
  // CRITICAL: Emit cancellation for EACH order before clearing
  for (const [orderId, order] of this.pendingOrders) {
    dashboardRelay.orderCancelled(orderId, order.side, order.limitPrice);
  }
  this.pendingOrders.clear();
}
```

**4. `cancelNonProtectedOrders()` - Cancel orders when entering BALANCING mode**

```typescript
private cancelNonProtectedOrders(reason: string): void {
  const toCancel: string[] = [];

  for (const [orderId, order] of this.pendingOrders) {
    // Skip protected BALANCING orders
    if (orderId === this.hedgeOrderId || orderId === this.triggerOrderId) continue;
    toCancel.push(orderId);
  }

  if (toCancel.length > 0) {
    this.dashLog(`[CANCEL] ${toCancel.length} orders (${reason})`, "warn");
    for (const orderId of toCancel) {
      const order = this.pendingOrders.get(orderId);
      if (order) {
        dashboardRelay.orderCancelled(orderId, order.side, order.limitPrice);
      }
      this.pendingOrders.delete(orderId);
    }
  }
}
```

**5. `cleanupMarket()` - End of market window**

```typescript
private async cleanupMarket(): Promise<void> {
  // ... disconnect WebSocket ...
  
  // Cancel all pending orders and emit to dashboard
  this.cancelAllOrders();  // This already emits cancellations
  
  // ... settlement calculation ...
}
```

#### Rule of Thumb

**Every `this.pendingOrders.delete(orderId)` call MUST be preceded by `dashboardRelay.orderCancelled()`**

Search your code for `.delete(` to ensure all deletions emit cancellation events.

### 6.2 Settlement Balance Calculation

**Problem**: When filling orders, cost is deducted from `simBalance`. At settlement, you must add back the **return** (proceeds), not the **profit**.

#### Why This Matters

```
Timeline:
1. Start: balance = $1000
2. Fill 100 UP @ $0.30: balance = $1000 - $30 = $970
3. Fill 100 DOWN @ $0.60: balance = $970 - $60 = $910
4. At settlement: 100 hedged pairs return $100

WRONG: balance += profit (100 - 90 = 10) → $920
RIGHT: balance += totalReturn (100) → $1010
```

#### Correct Settlement Code

```typescript
private async cleanupMarket(): Promise<void> {
  // ... cleanup WebSocket, cancel orders ...

  // Settlement calculation
  const hedgedPairs = Math.min(this.stats.upQty, this.stats.downQty);
  const totalCost = this.stats.upCost + this.stats.downCost;

  // Hedged pairs always return $1 each
  const hedgedReturn = hedgedPairs * 1.0;

  // Determine winner based on final prices (higher price = winner)
  const upWins = finalUpBid >= finalDownBid;
  const winningSide = upWins ? "UP" : "DOWN";

  // Unhedged shares: winner gets $1, loser gets $0
  const unhedgedUp = this.stats.upQty - hedgedPairs;
  const unhedgedDown = this.stats.downQty - hedgedPairs;
  const unhedgedReturn = upWins ? unhedgedUp * 1.0 : unhedgedDown * 1.0;

  const totalReturn = hedgedReturn + unhedgedReturn;
  const profit = totalReturn - totalCost;

  // Log settlement details
  if (unhedgedUp > 0 || unhedgedDown > 0) {
    this.dashLog(`[SETTLEMENT] ${winningSide} wins (bid $${(upWins ? finalUpBid : finalDownBid).toFixed(2)})`, "info");
    // ... log unhedged winner/loser details
  }

  // CRITICAL: Add back the RETURN (not profit) because cost was already deducted in fillOrder()
  this.simBalance += totalReturn;
  this.totalProfit += profit;

  // Emit position update to dashboard after settlement
  this.emitPositionUpdate();

  this.printMarketSummary(profit);
}
```

#### Common Mistake

```typescript
// WRONG - This double-counts the cost deduction
this.simBalance += profit;  // profit = return - cost, but cost already deducted!

// RIGHT - Add back what we actually receive from settlement
this.simBalance += totalReturn;
```

### 6.3 Settlement Profit in Window Merge Stats

**Problem**: The dashboard shows "Merged this window: X pairs (+$Y)" but only counts mid-window merges, not settlement profit. This makes the displayed profit incorrect.

**Example**:
- Mid-window merge: 39 pairs @ $0.999 = +$0.03
- Settlement: 626 hedged pairs at $0.963 avg cost
- Dashboard showed: "39 pairs (+$0.03)" ❌
- Should show: "665 pairs (+$9.44)" ✓

#### Solution: Include Settlement in Window Merge Stats

After calculating settlement profit, update window merge stats:

```typescript
// In cleanupMarket(), BEFORE printMarketSummary():

// Update window merge stats to include settlement (so dashboard shows total window profit)
// Settlement is conceptually a "final merge" - hedged pairs return $1 each
if (hedgedPairs > 0) {
  const avgPairCost = totalCost / hedgedPairs;
  const hedgedProfit = hedgedPairs * (1.0 - avgPairCost);
  this.windowMergedPairs += hedgedPairs;
  this.windowMergeProfit += hedgedProfit;
}
// Also track unhedged winner profit (if any)
if (unhedgedReturn > 0) {
  const unhedgedCost = upWins
    ? unhedgedUp * (this.stats.upQty > 0 ? this.stats.upCost / this.stats.upQty : 0)
    : unhedgedDown * (this.stats.downQty > 0 ? this.stats.downCost / this.stats.downQty : 0);
  this.windowMergeProfit += unhedgedReturn - unhedgedCost;
}
```

This ensures `windowMergedPairs` and `windowMergeProfit` reflect the TOTAL window profit (mid-window merges + settlement), which is what users expect to see on the dashboard.

### 6.4 Extreme Price Skip Check Timing

**Problem**: The check for extreme prices (> $0.85) at market start was happening BEFORE waiting for the market to start, so it was seeing stale prices from the PREVIOUS market window.

**Symptom**: Bot skips every market with messages like:
```
[SKIP] Market already decided at start - UP $0.99, DOWN $0.01
```

Even though the new market has normal prices (~$0.50/$0.50).

#### Solution: Move Check AFTER Market Start Wait

```typescript
// In runMarketCycle():

await this.initializeMarket(market);

// Wait for market start if needed
const now = Date.now();
const waitTime = this.marketStartTime - now;
if (waitTime > 0 && waitTime < 120000) {
  console.log(`[SIM] Market starts in ${Math.round(waitTime / 1000)}s, waiting...`);
  await this.sleep(waitTime);
} else if (waitTime > 120000) {
  console.log(`[SIM] Market too far out, waiting for next...`);
  await this.sleep(30000);
  return;
}

// Skip market if prices already extreme (> $0.85) at start - market already decided
// NOTE: This check happens AFTER market start wait so we have fresh prices
if (this.upAsk > 0.85 || this.downAsk > 0.85) {
  console.log(`  [SKIP] Market already decided at start - UP $${this.upAsk.toFixed(2)}, DOWN $${this.downAsk.toFixed(2)}`);
  this.lastMarketSlug = this.marketSlug;
  this.lastExitReason = "extreme_price";
  return;
}

await this.runPeriodicChecks();
```

### 6.5 FINAL HEDGE Mode - Cancel ALL Orders

**Problem**: When entering FINAL HEDGE mode (trigger side > 20% ahead), only micro trigger/hedge orders were being cancelled, leaving stale normal/balance/reversal orders on the dashboard.

#### Solution: Use cancelAllOrders() in FINAL HEDGE

```typescript
// When entering FINAL HEDGE mode:
this.dashLog(`[FINAL-HEDGE] Trigger side ahead by 20%+ - placing final hedge`, "info");

// 1. Cancel ALL pending orders (not just micro - includes balance, reversal, normal)
this.cancelAllOrders();
this.microTriggerOrders.clear();
this.microHedgeOrders.clear();

// 2. Place final hedge at $0.05
const finalHedgeSize = Math.max(hedgeDeficit, minHedgeSize);
this.placeMicroHedge(0.05, finalHedgeSize, 0);
```

### 6.6 Price Floor Requires BOTH Sides Filled

**Problem**: Original logic allowed orders below $0.30 after ANY fill (`hasPosition`). This could lead to one-sided exposure at extreme prices.

#### Solution: Require BOTH Sides Filled

```typescript
// In executeNormalMode():

// Price range enforcement: $0.30-$0.85 before BOTH sides filled, 
// allow down to $0.05 once both have positions
// This ensures first fill on EACH side is > $0.30
const bothSidesFilled = this.stats.upQty > 0 && this.stats.downQty > 0;
const minPrice = bothSidesFilled ? 0.05 : 0.30;
const maxPrice = bothSidesFilled ? 0.96 : 0.85;
```

### 6.7 Respect marketExited Flag in shouldStop()

**Problem**: If `setMarketExited()` was called (e.g., by profit lock merge after M8), `shouldStop()` might not immediately return true, causing continued trading attempts.

#### Solution: Check marketExited First

```typescript
private shouldStop(): boolean {
  // Check if market was already exited (e.g., by profit lock merge after M8)
  if (this.marketExited) {
    return true;
  }

  // ... rest of stop conditions ...
}
```

---

## Part 7: Running with Dashboard-v2

### Prerequisites

1. Ensure `dashboard-v2` is running on the server
2. Simulations connect to DashboardRelay on port 3002

### Starting Dashboard-v2

```bash
cd poly_arbitrage/dashboard-v2
npm run dev
```

This starts:
- **Frontend**: Vite dev server on port 5173
- **Backend**: WebSocket server on port 3002

### Starting ArbitrageSimulation_Dashboard

```bash
# Set initial balance (optional, default $500)
export ARB_INITIAL_BALANCE=10000

# Run the simulation
cd poly_arbitrage
node dist/run-arbitrage-sim-dashboard.js
```

Or with environment variable inline:
```bash
ARB_INITIAL_BALANCE=10000 node dist/run-arbitrage-sim-dashboard.js
```

### Starting ArbitrageSimulation_TradeFill

```bash
# Set initial balance (optional, default $500)
export ARB_INITIAL_BALANCE=10000

# Run the simulation
cd poly_arbitrage
node dist/run-arbitrage-sim-tradefill.js
```

Or with environment variable inline:
```bash
ARB_INITIAL_BALANCE=10000 node dist/run-arbitrage-sim-tradefill.js
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARB_INITIAL_BALANCE` | 500 | Starting simulation balance |
| `SIM_INITIAL_BALANCE` | 1000 | Alternative balance variable |
| `ARB_BASE_FREQUENCY` | 5000 | Check interval in ms |
| `ARB_BASE_SIZE` | 5 | Shares per order |
| `ARB_TARGET_PAIR_COST` | 0.98 | Target pair cost |
| `ARB_IMBALANCE_THRESHOLD` | 0.15 | Max imbalance to enter |
| `ARB_STOP_MINUTE` | 8 | Stop placing orders after this minute |
| `ARB_MAX_CAPITAL_PCT` | 0.80 | Max capital usage per market |

### Accessing the Dashboard

Open in browser: `http://SERVER_IP:5173`

The dashboard shows:
- **Price Chart**: Real-time UP/DOWN prices with pending order markers, hedge line, surge line
- **Market Stats**: Current bid/ask, spread, time remaining
- **Position Summary**: Holdings, pair cost, P&L, merged pairs
- **Pending Orders**: Active limit orders with price and size
- **Activity Logs**: Real-time log feed with level filtering

### Dashboard-v2 Connection

Dashboard-v2 connects to `ws://localhost:3002` to receive events. Make sure:

1. `DashboardRelay.start()` is called before dashboard connects
2. Port 3002 is not in use by another process
3. Dashboard reconnects on disconnect (built-in behavior)

The relay automatically caches the latest state and sends it to newly connected clients, so the dashboard always shows current data even after a refresh.

---

## Part 8: Frontend Integration

### React Hook: useBotOrders.js

The dashboard frontend uses a custom hook to manage WebSocket state:

```javascript
// Handle HEDGE_LINE event
case "HEDGE_LINE":
  if (data.active) {
    setHedgeLine({
      side: data.side,
      price: data.price,
      size: data.size,
      timestamp: data.timestamp,
    });
  } else {
    setHedgeLine(null);
  }
  break;
```

### PriceChart Component

Display the hedge line as a purple dashed horizontal line:

```jsx
const HEDGE_COLOR = "#8B5CF6"; // violet-500

{hedgeLine && (
  <ReferenceLine
    y={hedgeLine.price}
    stroke={HEDGE_COLOR}
    strokeWidth={2.5}
    strokeDasharray="10 5"
    label={{
      value: `HEDGE ${hedgeLine.side} ${hedgeLine.size}@${formatPrice(hedgeLine.price)}`,
      position: "insideTopRight",
      fill: HEDGE_COLOR,
      fontSize: 12,
      fontWeight: "bold",
    }}
  />
)}
```

---

## Part 9: Log Message Conventions

Use consistent prefixes for dashboard log messages:

| Prefix | Description | Level |
|--------|-------------|-------|
| `[MODE]` | Mode transitions (NORMAL → BALANCING) | warn |
| `[EXIT]` | Bot stopped trading in window | warn |
| `[PROFIT-LOCK]` | Profit lock events | success/info |
| `[MERGE]` | Merge operations | success |
| `[SETTLEMENT]` | Settlement results | info/success/warn |
| `[STOP]` | Stop conditions triggered | info |
| `[CLEANUP]` | Stale order cleanup | warn |
| `[CANCEL]` | Order cancellations | warn |
| `[VALIDATE]` | Order validation failures | warn |
| `[HEDGE-MONITOR]` | Hedge order adjustments | warn |
| `[SYNC]` | Order synchronization | info |
| `[ORDER]` | Order placed | info |

---

## Part 10: File Structure

```
poly_arbitrage/
├── src/
│   ├── strategies/
│   │   ├── ArbitrageSimulation.ts          # Original (standalone)
│   │   ├── ArbitrageSimulation_Dashboard.ts # Price-based + dashboard
│   │   └── ArbitrageSimulation_TradeFill.ts # Trade-based + dashboard
│   ├── services/
│   │   └── DashboardRelay.ts               # WebSocket relay singleton
│   ├── run-arbitrage-sim.ts                # Entry for original
│   ├── run-arbitrage-sim-dashboard.ts      # Entry for dashboard variant
│   └── run-arbitrage-sim-tradefill.ts      # Entry for tradefill variant
└── dashboard-v2/
    ├── src/
    │   ├── components/
    │   │   ├── PriceChart.jsx
    │   │   ├── MarketStats.jsx
    │   │   ├── PositionSummary.jsx
    │   │   ├── PendingOrders.jsx
    │   │   └── LogPanel.jsx
    │   ├── hooks/
    │   │   └── useBotOrders.js
    │   └── App.jsx
    └── server/
        └── index.ts                        # WebSocket server (port 3002)
```

---

## Part 11: Troubleshooting

### Dashboard not receiving updates

1. Check DashboardRelay is started: Look for `[DashboardRelay] WebSocket server started on port 3002`
2. Check client connection: Look for `[DashboardRelay] Client connected (N total)`
3. Verify simulation is emitting: Check for `emitPositionUpdate()` calls

### Orders showing as "orphaned" on dashboard

This happens when orders are deleted from `pendingOrders` without emitting `orderCancelled`. Fix by adding:

```typescript
dashboardRelay.orderCancelled(orderId, order.side, order.limitPrice);
```

Before deleting from the map.

### Merged pairs not showing when no position

Ensure `windowMergedPairs` and `windowMergeProfit` are passed in `emitPositionUpdate()` and the frontend handles the case where `hasPosition === false` but `windowMergedPairs > 0`.

### Dashboard not accessible (port 5173)

1. Check if vite dev server is running: `ps aux | grep vite`
2. Kill any stale processes: `pkill -f vite`
3. Restart dashboard: `cd dashboard-v2 && npm run dev`

### WebSocket connection keeps dropping

1. DashboardRelay has built-in ping/pong every 30 seconds
2. Unresponsive clients are terminated automatically
3. Dashboard auto-reconnects on disconnect
