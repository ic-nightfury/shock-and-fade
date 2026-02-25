# SET-Based Strategy V2

Guaranteed-profit market-making for Polymarket 15-minute BTC/ETH/SOL/XRP Up/Down binary markets using trigger-hedge pairs with accumulation and surge detection.

---

## Win Condition

```
min(qty_UP, qty_DOWN) × ($1.00 - avg_pair_cost) = GUARANTEED PROFIT

Requirements:
  1. avg_UP_price + avg_DOWN_price < $1.00
  2. UP/DOWN balance within acceptable imbalance
```

Binary markets guarantee exactly one outcome wins → $1.00/share payout. By holding equal UP and DOWN tokens at combined cost < $1.00, profit is locked regardless of outcome.

---

## SET (Synchronized Entry Trade)

A SET is a trigger order with a calculated hedge placed AFTER the trigger fills:

```
SET = {
  trigger: GTC limit order at current ASK price (market order behavior)
  hedge:   GTC limit order on OPPOSITE side (placed after trigger fills)
}

SET_UP   = { trigger: BUY UP @ ask,   hedge: BUY DOWN @ bid }
SET_DOWN = { trigger: BUY DOWN @ ask, hedge: BUY UP @ bid }
```

### Why Trigger-Then-Hedge?

1. **Guaranteed entry** - Trigger at ASK ensures immediate fill
2. **Optimal hedge** - Calculate hedge price based on actual trigger fill price
3. **Accumulation** - Can add to position at better prices before hedge fills

---

## Single Active Side Rule

Only ONE side is active at a time, determined by price signals:

```
Initial: Side with higher BID price (more expensive = more likely to win)

Switch on SURGE: When opposite side rises 8c+ in 5 seconds
  - Cancel all orders on current side
  - Switch active side to the rising side
  - Place new SET on new active side
```

### SURGE Detection

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SURGE DETECTION                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Every tick, check 5-second price history:                         │
│                                                                     │
│  priceRise = currentBid - bid5SecondsAgo                           │
│                                                                     │
│  If priceRise >= 8c (SURGE_THRESHOLD):                             │
│    1. Cancel all orders on opposite side                           │
│    2. Switch active side                                           │
│    3. Update supply line tracking                                  │
│    4. Place new SET on rising side                                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Accumulation System

After trigger fills, place accumulation orders at lower prices to improve average:

### Zone Accumulation (at SET placement)

When SET is placed, pre-calculate accumulation levels:
```
Trigger @ $0.56 → Zone accumulations:
  - 20 shares @ $0.54 (2c below)
  - 40 shares @ $0.52 (4c below)  
  - 40 shares @ $0.50 (6c below)
  - 40 shares @ $0.48 (8c below)
```

### Pre-placed Accumulation (after trigger fills)

5 levels at fixed offsets below trigger:
```
Offsets: 2c, 3c, 5c, 10c, 15c
Size: 3% of capital per level, max 30 shares
```

### Dynamic Accumulation

On price drops after trigger fills:
- If price drops 2c+ from last accumulation price → place new accumulation
- Each fill recalculates hedge price to maintain target pair cost

---

## Hedge Calculation

Hedge size = **Full position imbalance**, not just SET's fills:

```typescript
Position: UP 100, DOWN 80
Trigger fill: +10 UP → Total UP = 110

Hedge size = 110 - 80 = 30 DOWN (balances entire position)
```

### Hedge Price Formula

```
hedgePrice = targetPairCost - avgTriggerPrice

Example:
  avgTriggerPrice = $0.52
  targetPairCost = $0.98
  hedgePrice = $0.98 - $0.52 = $0.46
```

### Hedge Recalculation

When accumulations fill:
1. Recalculate average trigger price
2. Update hedge price to maintain pair cost target
3. Cancel old hedge, place new one at updated price

---

## V2 Features

### Accept Loss + Recovery SET

When supply line breaks with imbalanced position:

**Method 2a** (flip count 0-2): Accept the loss, place recovery SET
```
1. Balance position by buying on new side
2. Merge newly hedged pairs (locks in small loss)
3. Place Recovery SET with extra shares to recover loss

Recovery shares = loss / profitPerPair
```

**Method 2b** (flip count 3+): Tight target mode
```
- Use tighter pair cost target ($0.97 vs $0.98)
- Smaller positions, more conservative
```

### Cycle Tracking

A cycle spans from first SET until position is fully balanced:
```
Cycle #1: Started M2.3 | SETs: 5 | Cost: $45.20 | Hedged: 100 pairs
```

### Flip Count

Tracks surge switches within a market window:
```
flipCount = 0  → Normal mode, 2% profit target
flipCount >= 3 → Tight target mode, 3% profit target
```

---

## Total Hedge Mode

When approaching market end with imbalanced position:

### Entry Conditions
- Minute > 8 (configurable)
- Position imbalance > threshold
- Can achieve acceptable pair cost

### Execution Options

**Simple Hedge**: Buy deficit side at current ASK
```
Position: UP 100, DOWN 80
Deficit: 20 DOWN needed
Action: BUY 20 DOWN @ current ASK
```

**Bilateral Hedge**: Buy both sides to optimize pair cost
```
Position: UP 100, DOWN 80  
Action: BUY 5 UP + BUY 25 DOWN
Result: Better pair cost than simple hedge
```

---

## Auto-Merge

Automatic merging after hedge fills:

```
After hedge fills:
  1. Check hedged pairs count
  2. If hedgedPairs >= threshold (default 50):
     - Merge 80% of hedged pairs
     - Return $1.00 per pair to balance
     - Log profit/loss from merge
```

### Lifetime Tracking

Position is reduced after merge, but lifetime stats persist:
```
CURRENT:  UP 50@$0.52 DOWN 50@$0.46 | pair $0.980 | hedged 50
LIFETIME: UP 200@$0.52 DOWN 200@$0.44 | pair $0.960 | hedged 200 | merged 150
```

---

## Market Window Phases

```
M0-M0.5:   Initialization (WebSocket connect, price data)
M0.5-M12:  Active trading (place SETs, accumulate, hedge)
M8-M12:    Total hedge mode check (if imbalanced)
M12-M15:   Order freeze (no new orders, monitor existing)
M15:       Settlement
           - Force merge all hedged pairs ($1 per pair)
           - Settle remaining tokens (winner = $1, loser = $0)
```

---

## Configuration

### Environment Variables

```bash
# Required
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_FUNDER=0x...       # For PROXY mode
AUTH_MODE=PROXY               # or EOA

# SET Strategy parameters
SET_ORDER_SIZE=20             # Base trigger size
SET_HEDGE_DISCOUNT=0.02       # Hedge discount from target (2c)
SET_COOLDOWN=3                # Seconds between SETs
SET_TARGET_PAIR=0.98          # Target pair cost
SET_AUTO_MERGE=50             # Auto-merge threshold (hedged pairs)
SET_ORDER_FREEZE=12           # Minute to stop new orders
SET_TOTAL_HEDGE_STOP=10       # Stop after total hedge if minute > this

# SURGE detection
SET_SURGE_THRESHOLD=0.08      # 8c rise triggers surge
SET_SURGE_WINDOW_MS=5000      # 5 second window
SET_SURGE_STABILIZE_MS=3000   # Price must stabilize 3s to end surge

# Budget management
BUDGET_LIMIT_PCT=0.30         # Max 30% of balance per market

# Simulation
SIM_INITIAL_BALANCE=2000      # Starting balance for simulation
```

---

## Order Types in Dashboard

The simulation tracks these order types, all emitted to Dashboard V2:

| Order Type | Description | Dashboard Display |
|------------|-------------|-------------------|
| `trigger` | SET trigger order at ASK | Dashed line, side color |
| `hedge` | Hedge order after trigger fills | Dashed line, opposite side color |
| `accumulation` | Zone/preplaced/dynamic accumulation | Dashed line, trigger side color |
| `total_hedge` | Emergency position balancing | Dashed line, deficit side color |

---

## Dashboard V2

Real-time visualization for SET strategy simulation:

### Architecture
```
┌─────────────────────────────────────────────────────────────────┐
│                    SIMULATION                                    │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ SetBasedSimulationV2_Dashboard.ts                           ││
│  │   - Real WebSocket prices from Polymarket                   ││
│  │   - Simulated order execution                               ││
│  │   - Emits to DashboardRelay (port 3002)                    ││
│  └─────────────────────────────────────────────────────────────┘│
└───────────────────────┬─────────────────────────────────────────┘
                        │ WebSocket
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                    DASHBOARD V2 (React)                          │
│  - Price chart with UP/DOWN lines                               │
│  - Order reference lines (dashed)                               │
│  - Supply line indicator                                        │
│  - Position summary                                             │
│  - Activity feed                                                │
└─────────────────────────────────────────────────────────────────┘
```

### Running Dashboard

```bash
# Terminal 1: Start dashboard
cd dashboard-v2 && npm run dev

# Terminal 2: Start simulation
npm run set:sim:v2
```

---

## Commands

```bash
# SET Strategy V2
npm run set              # Production - real trading
npm run set:sim          # Simulation V1 - paper trading
npm run set:sim:v2       # Simulation V2 with dashboard support

# Inverse SET (experimental)
npm run iset             # Inverse SET production
npm run iset:sim         # Inverse SET simulation

# Dashboard
cd dashboard-v2 && npm run dev   # Start dashboard UI

# Utilities
npm run aum              # Check AUM breakdown
npm run status           # Current status
npm run openorders       # View open orders
npm run merge            # Merge positions to USDC
npm run sell             # Sell all positions
npm run redeem           # Redeem settled positions
```

---

## Strategy Files

| File | Purpose |
|------|---------|
| `SetBasedStrategyV2.ts` | Production V2 strategy (live trading) |
| `SetBasedSimulationV2.ts` | Simulation V2 (paper trading) |
| `SetBasedSimulationV2_Dashboard.ts` | Simulation V2 with dashboard events |
| `DashboardRelay.ts` | WebSocket server for dashboard |

---

## Strategy Summary

```
┌─────────────────────────────────────────────────────────┐
│              SET-BASED STRATEGY V2                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  WIN CONDITION:                                         │
│    avg_UP + avg_DOWN < $1.00 = GUARANTEED PROFIT       │
│                                                         │
│  ORDER MODEL: TRIGGER-THEN-HEDGE                        │
│    • Single active side at a time                      │
│    • Trigger fills → Place hedge                       │
│    • Accumulate at lower prices                        │
│                                                         │
│  SURGE DETECTION:                                       │
│    • 8c+ rise in 5s → Switch sides                     │
│    • Cancel all orders on old side                     │
│    • Track flip count for method selection             │
│                                                         │
│  V2 FEATURES:                                           │
│    • Accept Loss + Recovery SET                        │
│    • Cycle tracking                                    │
│    • Flip count based method selection                 │
│    • Dashboard integration                             │
│                                                         │
│  HEDGE CALCULATION:                                     │
│    • Size = Full position imbalance                    │
│    • Price = targetPairCost - avgTriggerPrice          │
│    • Recalculate on accumulation fills                 │
│                                                         │
│  MARKET PHASES:                                         │
│    • M0-M12: Active trading                            │
│    • M8+: Total hedge mode check                       │
│    • M15: Settlement (merge + settle)                  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

*Document Version: SET V2 | Last Updated: 2026-01-06*
