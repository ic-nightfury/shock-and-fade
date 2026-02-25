# Arbitrage Simulation Guide

Paper trading simulation for the Arbitrage strategy on Polymarket BTC Up/Down markets.

---

## Quick Start

```bash
# 1. Configure environment (optional - see parameters below)
export SIM_INITIAL_BALANCE=1000

# 2. Run simulation
npm run arb:sim

# 3. View dashboard in browser
cd trade_monitor_sim
npm install && npm run dev
open http://localhost:5175
```

---

## Environment Parameters

### Core Simulation Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `SIM_INITIAL_BALANCE` | 1000 | Starting paper balance ($) |

### Arbitrage Strategy Parameters

| Variable | Default | Description |
|----------|---------|-------------|
| `ARB_BASE_FREQUENCY` | 5000 | Check interval (ms) |
| `ARB_BASE_SIZE` | 5 | Base shares per trade |
| `ARB_TARGET_PAIR_COST` | 0.98 | Target pair cost for constraint |
| `ARB_IMBALANCE_THRESHOLD` | 0.15 | Base threshold (overridden by dynamic) |
| `ARB_INVENTORY_IMPACT` | 0.04 | Avellaneda adjustment (4c per unit) |
| `ARB_STOP_MINUTE` | 8 | Stop after this minute if profitable |
| `ARB_MAX_CAPITAL_PCT` | 0.80 | Stop if capital exceeds 80% |

---

## Example Configurations

### Conservative (Lower Risk)
```bash
export SIM_INITIAL_BALANCE=500
export ARB_BASE_SIZE=3
export ARB_STOP_MINUTE=6
npm run arb:sim
```

### Aggressive (Higher Capital)
```bash
export SIM_INITIAL_BALANCE=5000
export ARB_BASE_SIZE=20
export ARB_STOP_MINUTE=10
npm run arb:sim
```

### Extended Trading Window
```bash
export ARB_STOP_MINUTE=12           # Trade until M12
export ARB_MAX_CAPITAL_PCT=0.90     # Use up to 90% capital
npm run arb:sim
```

---

## How Simulation Works

### Execution Model

```
Real Prices (WebSocket) → Simulated Orders → Paper Position

Fill Logic:
  - BUY order fills when: Ask <= Limit Price
  - Immediate fill for market-crossing orders
  - GTC orders wait for price to reach limit
```

### Market Phases

| Phase | Minutes | Behavior |
|-------|---------|----------|
| Active Trading | M0 - M8 | Place orders, accumulate, rebalance |
| Extended (if not profitable) | M8 - M15 | Continue if not yet profitable |
| Stop Conditions | Any | Stop if profitable AND (time > M8 OR capital > 80%) |

### Strategy Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| NORMAL | imbalance < dynamic threshold | Place bid-1/bid-2 on both sides |
| BALANCE | imbalance >= dynamic threshold | Cancel all, aggressively buy deficit |

### Dynamic Threshold

The imbalance threshold decreases as position grows:

```
0 shares      → 100% threshold (never balance)
500 shares    → 30% threshold
2000+ shares  → 5% threshold (floor)
```

### Pair Cost Constraint

Orders respect max price based on target pair cost:

```
maxPriceForUP = targetPairCost - downAvg
maxPriceForDOWN = targetPairCost - upAvg
```

In BALANCE mode, if prices exceed max, the strategy **waits**.

---

## Dashboard

### Start Dashboard

```bash
cd trade_monitor_sim
npm install
npm run dev
# Open http://localhost:5175
```

### WebSocket Connection

The simulation exposes a WebSocket server at `ws://localhost:3002/sim` that broadcasts:

- **STATE_UPDATE**: Full state every check interval
  - Market info (slug, time, minute)
  - Prices (bid/ask for both sides)
  - Position (quantities, costs, averages, profit)
  - Strategy (mode, balance, pending orders)
  - Session (market count, total profit)

- **FILL**: On each simulated fill
  - Side, size, price, cost

### Dashboard Features

| Feature | Description |
|---------|-------------|
| **Market Info** | Current market slug, time elapsed |
| **Prices** | Real-time UP/DOWN bid/ask |
| **Position** | Quantities, averages, pair cost |
| **Strategy Mode** | NORMAL/BALANCE indicator |
| **Orders** | Pending orders list |
| **Fills** | Recent fill history |
| **Profit** | Current and session P&L |

---

## Console Output

### Startup Banner

```
╔══════════════════════════════════════════════════════════════╗
║     ARBITRAGE STRATEGY - SIMULATION (No Hedge)               ║
║       Real WebSocket Prices | Simulated Execution            ║
╚══════════════════════════════════════════════════════════════╝

  Balance:     $1000.00 (paper)
  Frequency:   5000ms
  Base Size:   5 shares
  Imb Thresh:  15%
  Stop:        M8
```

### Status Log (Every Check)

```
─── M2.15 ─── NORMAL ─── Imb: 5%/42% ─── Pending: 4 ───
  Prices:  UP $0.45/$0.46  |  DOWN $0.54/$0.55
  UP:      100 shares @ $0.450 avg = $45.00
  DOWN:    95 shares @ $0.545 avg = $51.78
  Pair:    $0.995 cost  |  95 hedged  |  $-1.78 profit
```

**Legend:**
- `M2.15` - Market minute.second
- `NORMAL/BALANCE` - Current mode
- `Imb: 5%/42%` - Current imbalance / threshold
- `Pending: 4` - Active orders

### Order Events

```
  [ORDER] UP $0.44 (10)         # Order placed
  [FILL] UP +10 @ $0.44          # Order filled
  [CANCEL] 8 orders (balance mode)  # Orders cancelled
  [BALANCE] WAITING - UP aggressive $0.68 > max $0.46  # Waiting for better price
```

### Market Summary

```
┌──────────────────────────────────────────────────────────────┐
│  MARKET #1 SUMMARY                                           │
├──────────────────────────────────────────────────────────────┤
│  UP:          100 @ $0.450  =  $  45.00                     │
│  DOWN:         95 @ $0.545  =  $  51.78                     │
│  Pair Cost: $0.995                                           │
│  Hedged:        95 pairs                                     │
│  Total:     $  96.78                                         │
│  PROFIT:    $  -1.78 (-1.8%)                                │
│  Balance:   $ 998.22                                         │
└──────────────────────────────────────────────────────────────┘
```

### Session Summary (on stop)

```
╔══════════════════════════════════════════════════════════════╗
║                    SESSION SUMMARY                           ║
╠══════════════════════════════════════════════════════════════╣
║  Markets:         3                                          ║
║  Initial:    $1000.00                                        ║
║  Final:      $1024.50                                        ║
║  RETURN:     $  24.50 (2.45%)                               ║
╚══════════════════════════════════════════════════════════════╝
```

---

## Troubleshooting

### Simulation not starting?
- Check that a market is active: markets run every 15 minutes
- Verify WebSocket connection in logs
- Ensure no other process is using port 3002

### No trades being placed?
- Check pair cost constraint: orders skip if price > max
- Verify balance is sufficient for order size
- Check stop conditions (M8+, 80% capital)

### Dashboard not connecting?
- Ensure simulation is running first
- Check WebSocket URL: `ws://localhost:3002/sim`
- Verify port 5175 is available

### Prices not updating?
- WebSocket may be disconnected
- Check network connectivity
- Restart simulation

### Always in BALANCE mode?
- Early position with high imbalance (normal)
- Dynamic threshold starts at 100%, decreases with position size
- One-sided fills cause temporary imbalance

### Pair cost above $1.00?
- Strategy is waiting for better prices
- Check `[BALANCE] WAITING` messages in logs
- Prices may be unfavorable, wait for market movement

---

## Commands Reference

```bash
npm run arb:sim          # Run arbitrage simulation
npm run arbitrage        # Run production (real orders)

cd trade_monitor_sim
npm run dev              # Start simulation dashboard
npm run build            # Build for production
```

---

## Files

| File | Purpose |
|------|---------|
| `src/strategies/ArbitrageSimulation.ts` | Simulation strategy |
| `src/run-arbitrage-sim.ts` | Simulation entry point |
| `trade_monitor_sim/` | Dashboard (React + Vite) |
| `docs/SIMULATION_GUIDE.md` | This documentation |

---

*Document Version: v2.0 | Last Updated: 2026-01-07*
