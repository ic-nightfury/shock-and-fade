# Product Requirements Document (PRD)
# Shock & Fade: Mean-Reversion Trading on Polymarket Sports Markets

## Executive Summary

Automated mean-reversion trading system for Polymarket sports moneyline markets. Detects mid-game price shocks caused by scoring events, classifies them using free league APIs, and captures the reversion by selling into the overshoot with laddered limit orders.

**Win Condition:**
```
Event-driven exit + split-and-sell model = 100% parameter robustness
(vs 15% with static timeout exits)
```

---

## Problem Statement

Live sports betting markets on Polymarket exhibit predictable overreaction to scoring events. When a team scores during a game, the market price typically overshoots the "fair" adjustment by 2-5¢ before reverting.

**Challenges:**
1. **Detecting shocks in real-time** (z-score > 2σ on rolling window)
2. **Classifying events** (single scoring event vs scoring run vs noise)
3. **Timing the exit** (when to close the position)
4. **Execution efficiency** (avoiding 3-second taker delay on sports markets)
5. **Multi-sport coverage** (NBA, NFL, NHL, CBB with different event frequencies)

---

## Solution Overview

### Core Mechanism: Split-and-Sell

Binary sports markets on Polymarket guarantee that 1 share Team A + 1 share Team B = $1.00 at settlement. We exploit this by:

1. **Pre-split** USDC into complementary token pairs before games start
2. **Detect shocks** via z-score on 60-second rolling mid-price window
3. **Classify events** using free league APIs (NBA CDN, ESPN, NHL Stats)
4. **Sell into overshoot** with laddered limit orders (maker orders = no delay)
5. **Exit on next event** (event-driven, not time-based)

### The Edge: Event-Driven Exit

Static timeout exits (e.g., "close after 120 seconds") are arbitrary and fail 85% of the time. The market might still be dislocated, or might have moved further against us.

**Event-driven exits** (close only when the next scoring event occurs) achieve **100% parameter robustness**. The next scoring event creates a new price equilibrium that naturally ends the fade window.

This is the entire alpha.

---

## Technical Architecture

### 1. Shock Detection

**Z-Score Calculation:**
```typescript
const zScore = (currentMid - rollingMean) / rollingStdDev;
const isShock = Math.abs(zScore) > 2.0 && Math.abs(currentMid - prevMid) >= 0.03;
```

**Parameters:**
- Rolling window: 60 seconds
- Z-score threshold: 2σ (2 standard deviations)
- Absolute minimum: 3¢ move (filters low-volatility noise)

### 2. Event Classification

**10-Second Hard Cutoff:**
After a shock is detected, poll the league API every 1 second for 10 seconds maximum.

**Classification Logic:**
```
Single scoring event (1 basket, 1 goal)    → TRADE
Scoring run (2+ events in 10s window)      → SKIP (momentum, not mean-reversion)
No event detected within 10s               → SKIP (noise or data lag)
```

**API Sources:**
- **NBA:** NBA CDN (free, real-time play-by-play)
- **NFL:** ESPN API (free, 10-15s delay)
- **NHL:** NHL Stats API (free, 5-10s delay)
- **CBB:** ESPN API (free, similar to NFL)

### 3. Ladder Entry (Maker Orders)

Place 3 GTC limit sell orders on the spiked token:

| Level | Price | Size | Fill Rate |
|-------|-------|------|-----------|
| 1 | Shock + 3¢ | 5 shares | ~80% |
| 2 | Shock + 6¢ | 10 shares | ~40% |
| 3 | Shock + 9¢ | 20 shares | ~10% |

**Total exposure:** ~$35 per cycle

**Why ladders?**
- Capture different depths of overshoot
- Avoid chasing the spike with market orders (3-second delay)
- Maker orders execute instantly (no Polymarket sports delay)

### 4. Exit Logic

**Event-Driven Exit:**
```
If next event = FAVORABLE (opposite team scores):
  → Hold position, wait for mean reversion
  → GTC sell complement token at bid+1tick

If next event = ADVERSE (same team scores again):
  → Exit immediately via GTC at bid+1tick

If game decided (bid ≤1¢ or ≥99¢):
  → Finalize directly (no GTC needed)
```

**GTC-at-Bid Strategy:**
Instead of FAK market orders (3-second delay), place GTC sell at `bid + 1 tick`. This executes as a maker order (~1 second fill) vs taker delay (3+ seconds).

---

## Sport-Specific Tuning

### NBA
- **Frequency:** ~200 scoring events per game
- **Shock magnitude:** 3-8¢ typical
- **Parameters:** 2σ, 3¢ min, 60s window
- **Ladder:** +3¢/+6¢/+9¢

### NFL
- **Frequency:** 8-12 scoring events per game
- **Shock magnitude:** 8-20¢+ (touchdowns are huge moves)
- **Parameters:** 2σ, 4-5¢ min, 10min timeout
- **Ladder:** +3¢/+5¢/+8¢ (wider spacing)

### NHL
- **Frequency:** ~6-8 scoring events per game
- **Shock magnitude:** 5-12¢
- **Parameters:** 2σ, 3-4¢ min, 5min timeout
- **Ladder:** +3¢/+6¢/+10¢

### CBB (College Basketball)
- **Frequency:** Similar to NBA (~150-200 events)
- **Shock magnitude:** 2-6¢ (thinner books = smaller moves)
- **Parameters:** 2σ, 2-3¢ min, 60s window
- **Status:** Recording data, depth filter needed

---

## Performance Metrics

### Backtest Results (18 NBA Games)

**Best Parameter Combination:**
- Total P&L: $107
- Win Rate: 73.3%
- Sharpe Ratio: 0.55
- Queue Capture: 25% (conservative assumption)

**Key Finding:**
- **Event-driven exit:** 100% of parameter combinations profitable
- **Static timeout exit:** Only 15% of parameter combinations profitable
- **7x improvement** in strategy robustness

---

## Risk Management

### Position Sizing
- Max exposure per cycle: $35 (ladder total)
- Max concurrent cycles: 3 (per game)
- Max exposure per game: ~$100
- Bankroll requirement: $5,000 minimum (50x single-game exposure)

### Stop-Loss
- **Adverse event:** Exit at bid+1tick immediately
- **Max drawdown per cycle:** ~$10 (rare, requires 2+ adverse events)
- **Game decided:** Finalize positions, don't chase settled markets

### Edge Degradation
- Strategy assumes 2-5¢ overshoot remains predictable
- If market efficiency increases → edge shrinks
- Monitor: Avg reversion magnitude, fill rates, win rate
- Kill switch: If win rate drops <60% over 20 cycles, pause

---

## Deployment Requirements

### Infrastructure
- **Server:** Low-latency VPS (Hetzner Finland recommended for EU Polymarket servers)
- **WebSocket:** Stable connection to Polymarket price feeds
- **APIs:** Free league APIs (NBA CDN, ESPN, NHL Stats)
- **Database:** PostgreSQL for tick data, trade history, backtest results

### API Keys
- **Polymarket:** CLOB API key + private key (for order placement)
- **League APIs:** No keys required (all free public endpoints)

### Monitoring
- **Dashboard:** Real-time price chart, shock detection, ladder fills, P&L
- **Alerts:** Telegram notifications on fills, errors, adverse events
- **Logs:** All shocks, classifications, entries, exits (for post-game analysis)

---

## Success Metrics

### Phase 1: Live Paper Trading (2 weeks)
- Target: 70%+ win rate across ≥10 games
- Validation: Event-driven exit superiority confirmed
- Benchmark: ≥$50 paper profit per week (simulated)

### Phase 2: Live Trading (Small Capital)
- Capital: $1,000 initial (20x single-game exposure)
- Target: 65%+ win rate, Sharpe ≥0.4
- Risk limit: Max -10% drawdown (pause if hit)

### Phase 3: Scale-Up
- Capital: $10,000+
- Target: $500-1,000/month profit
- Coverage: NBA + NFL + NHL (multi-sport diversification)
- Monitoring: Automated kill switch if edge degrades

---

## Open Source Distribution

**Repository:** https://github.com/ic-nightfury/shock-and-fade  
**License:** MIT (open source, free to use and modify)  
**Documentation:** Full strategy docs, backtest data, setup guides  
**Dashboard:** React + WebSocket real-time visualization

**Support:**
- GitHub Issues for bugs/questions
- Community updates via Telegram
- No official support (use at your own risk)

---

**Author:** Barren Wuffet  
**Created:** 2026-02-25  
**Version:** 3.0
