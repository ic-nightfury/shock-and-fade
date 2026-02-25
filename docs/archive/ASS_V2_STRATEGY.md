# ASS-V2 Strategy Documentation

**Avellaneda Split-Sell Strategy V2** for Polymarket 15-Minute Crypto Markets

---

## Table of Contents

1. [Strategy Overview](#1-strategy-overview)
2. [Avellaneda-Stoikov Adaptation](#2-avellaneda-stoikov-adaptation)
3. [Phase System](#3-phase-system)
4. [Split/Sell/Merge Mechanics](#4-splitsellmerge-mechanics)
5. [Configuration Reference](#5-configuration-reference)
6. [Risk Management](#6-risk-management)
7. [Operations Guide](#7-operations-guide)
8. [Troubleshooting](#8-troubleshooting)
9. [Performance Metrics](#9-performance-metrics)

---

## 1. Strategy Overview

### Core Philosophy

ASS-V2 is a **market-making strategy** for Polymarket's 15-minute crypto binary markets. The core philosophy is:

> **"Sell more, stay balanced, never gamble on direction."**

Unlike directional trading that bets on UP or DOWN winning, ASS-V2 captures the **bid-ask spread** by:
1. Splitting USDC into equal UP and DOWN tokens
2. Selling both sides at a spread above the bid
3. Recycling capital continuously
4. Merging unsold pairs at window end

### How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                     ASS-V2 Capital Flow                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   USDC Balance                                                  │
│        │                                                        │
│        ▼                                                        │
│   ┌─────────┐     ┌─────────┐     ┌─────────┐                  │
│   │  SPLIT  │────▶│ UP + DN │────▶│  SELL   │                  │
│   │  $300   │     │ Tokens  │     │ Orders  │                  │
│   └─────────┘     └─────────┘     └─────────┘                  │
│                        │               │                        │
│                        │               ▼                        │
│                        │         ┌─────────┐                   │
│                        │         │  FILLS  │──────┐            │
│                        │         └─────────┘      │            │
│                        │               │          │            │
│                        ▼               ▼          ▼            │
│                   ┌─────────┐    ┌─────────┐  ┌─────────┐      │
│                   │ Unsold  │    │ Revenue │  │ Capital │      │
│                   │  Pairs  │    │ (USDC)  │  │Recycling│      │
│                   └─────────┘    └─────────┘  └─────────┘      │
│                        │               │          │            │
│                        ▼               │          │            │
│                   ┌─────────┐          │          │            │
│                   │  MERGE  │──────────┴──────────┘            │
│                   └─────────┘                                   │
│                        │                                        │
│                        ▼                                        │
│                   USDC Balance (start of next window)           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Profit Mechanism

ASS-V2 profits from the **spread between split cost and sell revenue**:

| Operation | Cost/Revenue |
|-----------|--------------|
| SPLIT $1 USDC | → 1 UP + 1 DOWN (cost: $1.00) |
| SELL 1 UP @ 55c | → $0.55 revenue |
| SELL 1 DOWN @ 46c | → $0.46 revenue |
| **Total Revenue** | **$1.01** |
| **Profit** | **$0.01 per pair** |

The strategy scales this by:
- Trading hundreds of pairs per window
- Capturing 1-4c spread per fill
- Recycling capital for multiple rounds per window

### Key Advantages

1. **Direction-neutral**: Profits regardless of whether UP or DOWN wins
2. **Capital efficient**: Revenue recycled immediately for more splits
3. **Self-hedging**: Equal positions mean minimal settlement risk
4. **Scalable**: More capital = more splits = more profit

---

## 2. Avellaneda-Stoikov Adaptation

### Original Theory

The Avellaneda-Stoikov model (2008) is a market-making framework that optimizes:
- **Inventory risk**: Don't hold too much of one side
- **Spread optimization**: Tighter spreads = more fills, wider = more profit per fill

### Binary Market Adaptation

In binary markets, we adapt the model:

| Traditional MM | ASS-V2 Adaptation |
|----------------|-------------------|
| Inventory = shares held | Inventory = UP shares - DOWN shares |
| Spread based on volatility | Spread based on phase + imbalance |
| Continuous trading | 15-minute windows with settlement |
| Risk = price movement | Risk = wrong side wins |

### Imbalance Calculation

```typescript
q = (upShares - downShares) / (upShares + downShares)
```

- `q > 0`: Excess UP inventory → tighten UP spread, widen DOWN spread
- `q < 0`: Excess DOWN inventory → tighten DOWN spread, widen UP spread
- `q = 0`: Balanced → symmetric spreads

### Spread Skew Formula

```typescript
// Base spread (e.g., 1c)
baseSpread = config.tightSpreadCents / 100;

// Avellaneda spread adjustment
if (side === "UP") {
  spreadAdjustment = -gamma * q * baseSpread;  // q > 0 → tighter UP
} else {
  spreadAdjustment = gamma * q * baseSpread;   // q < 0 → tighter DOWN
}

finalSpread = clamp(baseSpread + spreadAdjustment, 1c, 4c);
```

### Sizing Skew Formula

```typescript
// Oversupplied side gets LARGER orders (dump faster)
if (side === "UP" && q > 0) {
  sizeMultiplier = 1 + eta * q * 2;  // More UP → sell more UP
} else if (side === "DOWN" && q < 0) {
  sizeMultiplier = 1 + eta * (-q) * 2;  // More DOWN → sell more DOWN
}

orderSize = floor(baseSize * sizeMultiplier);
```

---

## 3. Phase System

ASS-V2 uses a 3-phase system that adapts behavior as the window progresses:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Phase Transition Diagram                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  M0          M5          M10         M12         M15            │
│   │           │           │           │           │             │
│   ├───────────┴───────────┴───────────┴───────────┤             │
│   │                                               │             │
│   │  ┌─────────────────────────────────────────┐ │             │
│   │  │         PHASE 1: SYMMETRIC              │ │             │
│   │  │  • Balanced selling on both sides       │ │             │
│   │  │  • Tight spread (1c)                    │ │             │
│   │  │  • Target: Build turnover               │ │             │
│   │  └─────────────────────────────────────────┘ │             │
│   │                    │                         │             │
│   │           Price > 60c?                       │             │
│   │                    │                         │             │
│   │                    ▼                         │             │
│   │  ┌─────────────────────────────────────────┐ │             │
│   │  │         PHASE 2: CAUTIOUS               │ │             │
│   │  │  • Widen spread on expensive side       │ │             │
│   │  │  • Reduce size on expensive side        │ │             │
│   │  │  • Target: Protect from reversal        │ │             │
│   │  └─────────────────────────────────────────┘ │             │
│   │                    │                         │             │
│   │        Price > 70c OR M > 12?                │             │
│   │                    │                         │             │
│   │                    ▼                         │             │
│   │  ┌─────────────────────────────────────────┐ │             │
│   │  │         PHASE 3: COMMIT                 │ │             │
│   │  │  • Stop selling expensive side          │ │             │
│   │  │  • Aggressive on cheap side             │ │             │
│   │  │  • Target: Lock in settlement profit    │ │             │
│   │  └─────────────────────────────────────────┘ │             │
│   │                                               │             │
│   └───────────────────────────────────────────────┘             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Phase Triggers

| Phase | Trigger | Behavior |
|-------|---------|----------|
| **Phase 1** | Default | Symmetric selling, 1c spread, maximize turnover |
| **Phase 2** | Either side BID > 60c | Cautious, widen expensive side spread |
| **Phase 3** | Either side BID > 70c OR minute > 12 | Commit to likely winner, stop selling expensive |

### Phase Behavior Details

**Phase 1: Symmetric**
- Spread: 1c (tight)
- Sizing: Balanced, Avellaneda skew only
- Goal: Maximum turnover while market is undecided

**Phase 2: Cautious**
- Spread: 2-3c on expensive side
- Sizing: Reduced on expensive side
- Goal: Avoid selling tokens that will likely pay $1

**Phase 3: Commit**
- Spread: N/A (stop selling expensive side)
- Sizing: Aggressive on cheap side only
- Goal: Dump cheap tokens before they become worthless

---

## 4. Split/Sell/Merge Mechanics

### SPLIT Operation

Converts USDC into equal UP and DOWN tokens:

```typescript
// Example: Split $300
await splitClient.split(conditionId, 300);
// Result: 300 UP tokens + 300 DOWN tokens
// Cost: $300 USDC
```

**Split Sizing (US-403):**
- `fixedSplitSize = windowStartBalance × splitPct` (30% default)
- Calculated ONCE at window start
- Does NOT shrink as balance depletes

**Resplit Trigger:**
- When either side < `resplitThreshold` × `fixedSplitSize` (20% default)
- Example: Split 300 → resplit when UP < 60 OR DOWN < 60

### SELL Operation

Places limit sell orders at spread above BID:

```typescript
// Price calculation
price = round((bid + spread) * 100) / 100;

// Order placement
await client.sellSharesGTC(tokenId, size, price);
```

**Minimum Order Requirements:**
- Minimum 5 shares
- Minimum $1 transaction value
- At 2c price: need 50 shares (ceil(1/0.02))
- At 20c+ price: need 5 shares

**Advance Sell Tracking (US-402):**
- When forced to sell more than intended (due to $1 minimum)
- Track "advance" and skip subsequent sells until depleted

### MERGE Operation

Converts equal UP + DOWN tokens back to USDC:

```typescript
// Example: Merge 50 pairs
await mergeClient.merge(conditionId, 50);
// Result: 50 UP + 50 DOWN → $50 USDC
```

**When MERGE Happens:**
- Window end: Merge all unsold pairs
- Emergency stop: Merge before selling imbalance

### Capital Recycling

Revenue from sells is immediately added back to balance:

```typescript
// On each fill
const fillRevenue = fillSize * fillPrice;
this.balance += fillRevenue;  // Immediately available for next split
```

This enables multiple split-sell cycles per window:
1. Split $300 → 300 UP + 300 DOWN
2. Sell 200 UP @ 55c → +$110 balance
3. Sell 200 DOWN @ 46c → +$92 balance
4. Balance now $202 → can split again!

---

## 5. Configuration Reference

### Core Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `splitPct` | 0.30 | Fraction of balance to split (30%) |
| `resplitThreshold` | 0.20 | Resplit when side < 20% of split size |
| `tightSpreadCents` | 1 | Tight spread in cents |
| `wideSpreadCents` | 4 | Wide spread in cents |
| `eta` | 0.2 | Avellaneda sizing skew factor |
| `gamma` | 0.7 | Avellaneda spread skew factor |

### Phase Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `phase2PriceThreshold` | 0.60 | Price that triggers Phase 2 |
| `phase3PriceThreshold` | 0.70 | Price that triggers Phase 3 |
| `phase3MinuteThreshold` | 12 | Minute that forces Phase 3 |

### Timing Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `tradingStartMinute` | 0.5 | Start placing orders (30 seconds in) |
| `tradingEndMinute` | 13 | Stop placing orders |
| `aggressiveEndMinute` | 10 | Reduce aggression after this |

### Order Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `minOrderSize` | 5 | Polymarket minimum shares |
| `maxOpenOrdersPerSide` | 2 | Max concurrent orders per side |
| `orderExpirySeconds` | 30 | Cancel orders older than this |
| `orderPlacementLatencyMs` | 400 | Simulated order latency |

### Safety Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxLossPerWindow` | 20 | Stop trading if loss exceeds $20 |
| `minBalanceBuffer` | 10 | Keep $10 reserve, don't split all |

### Background Task Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `redemptionEnabled` | true | Enable background redemption |
| `redemptionIntervalMinutes` | 5 | Redemption check interval |
| `reconciliationEnabled` | true | Enable balance reconciliation |
| `reconciliationIntervalMinutes` | 1 | Reconciliation interval |
| `statePersistenceEnabled` | true | Enable crash recovery |
| `statePersistenceIntervalSeconds` | 30 | State save interval |
| `stateFilePath` | "./assv2_state.json" | State file location |

---

## 6. Risk Management

### Safety Limits

1. **Max Loss Per Window**: Stop trading if unrealized + realized loss > $20
2. **Balance Buffer**: Always keep $10 reserve, never split entire balance
3. **Order Expiry**: Cancel stale orders after 30 seconds

### Position Limits

1. **Pending Order Tracking (US-405)**: Never sell more than available - pending
2. **Advance Sell Tracking (US-402)**: Skip sells when over-sold due to minimums

### Balance Reconciliation (US-406)

- Runs every 1 minute
- Compares internal tracking vs actual on-chain balances
- Auto-corrects any drift (zero tolerance)
- Triggers after WebSocket reconnects

### State Persistence (US-406)

- Saves state to file every 30 seconds
- On crash recovery: logs position info
- Clears stale state automatically

### Emergency Procedures

**Emergency Stop (US-407):**
```bash
# Stop trading and liquidate positions
npx ts-node src/cli/emergency-stop.ts --market all

# Preview without executing
npx ts-node src/cli/emergency-stop.ts --market all --dry-run
```

---

## 7. Operations Guide

### Starting the Bot

**Live Trading:**
```bash
cd /root/poly_arbitrage
npx ts-node src/run-ass-v2-live.ts --dashboard

# With custom config
npx ts-node src/run-ass-v2-live.ts \
  --split-pct 0.25 \
  --max-loss 15 \
  --dashboard
```

**Simulation:**
```bash
npx ts-node src/run-ass-v2-simulation.ts --balance 1000 --dashboard
```

### Monitoring

**Dashboard API:**
```bash
curl http://SERVER:3020/api/state | jq
```

**Log Tailing:**
```bash
# Live
tail -f /root/poly_arbitrage/assv2_live.log

# Simulation
tail -f /root/poly_arbitrage/simulation_assv2.log
```

**Settlement Summary:**
```bash
grep -E 'SETTLE|P&L:' /root/poly_arbitrage/assv2_live.log
```

### Stopping the Bot

**Graceful Stop:**
```bash
# Send SIGTERM
kill -TERM $(pgrep -f ass-v2-live)
```

**Emergency Stop (with cleanup):**
```bash
npx ts-node src/cli/emergency-stop.ts --market all --force
```

### Deployment

```bash
# Build
npm run build -- --skipLibCheck

# Deploy to Finland
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude '*.log' \
  --exclude '.env' --exclude '.env.*' --exclude 'tick_data*' \
  ./ root@65.21.146.43:/root/poly_arbitrage/
```

---

## 8. Troubleshooting

### Common Issues

**Issue: Negative share count**
- Cause: Orders placed without reserving shares
- Fix: US-405 added pending order tracking
- Check: `getPendingOrderShares()` before placing

**Issue: Balance drift**
- Cause: Missed WebSocket fills, transaction failures
- Fix: US-406 reconciliation auto-corrects
- Check: Look for "DRIFT DETECTED" in logs

**Issue: Orders not filling**
- Cause: Spread too wide, latency
- Fix: Reduce spread, check order placement latency
- Check: Compare spread to actual market spread

**Issue: Excessive splitting**
- Cause: Death spiral from shrinking balance
- Fix: US-403 fixed split sizing
- Check: Split size should be constant per window

### Log Analysis

**Check fill rate:**
```bash
grep -c "FILL" assv2_live.log
```

**Check phase transitions:**
```bash
grep "Phase" assv2_live.log
```

**Check reconciliation:**
```bash
grep "DRIFT\|RECONCILE" assv2_live.log
```

**Check errors:**
```bash
grep -i "error\|fail" assv2_live.log
```

---

## 9. Performance Metrics

### Key Metrics to Track

| Metric | Expected Range | Notes |
|--------|----------------|-------|
| Win Rate | 50-60% | Percentage of profitable windows |
| Avg P&L/Window | $1-5 | Depends on capital deployed |
| Turnover/Window | 500-2000 shares | Total shares sold per side |
| Fill Rate | 80-95% | Percentage of orders that fill |
| Phase 3 Rate | 80-95% | Windows ending in Phase 3 |

### Calculating ROI

```
Window ROI = (Settlement Payout + Sell Revenue - Split Cost) / Split Cost

Daily ROI = Sum(Window P&L) / Starting Balance

Annualized ROI = (1 + Daily ROI)^365 - 1
```

### Maker Rebates

Polymarket offers maker rebates (currently 20% of taker fees):

```typescript
// Fee formula
fee = shares * price * 0.25 * (price * (1 - price))^2

// Rebate
rebate = fee * makerRebatePct  // 20%

// Examples at 50c
// 100 shares: fee = $0.78, rebate = $0.156
```

Rebates are tracked per fill and included in P&L calculations.

---

## Related Files

| File | Description |
|------|-------------|
| `src/strategies/ASSV2_Live.ts` | Live trading strategy |
| `src/strategies/ASSV2_Simulation.ts` | Simulation for testing |
| `src/run-ass-v2-live.ts` | Live entry point |
| `src/run-ass-v2-simulation.ts` | Simulation entry point |
| `src/cli/emergency-stop.ts` | Emergency cleanup tool |
| `analysis/ass_v2_research_summary.md` | Research findings |
| `analysis/backtest_ass_v2.py` | Python backtest engine |
| `scripts/ralph/prd.json` | Product requirements |
| `scripts/ralph/progress.txt` | Development log |

---

*Last Updated: 2026-01-26*
*Strategy Version: ASS-V2.0*
