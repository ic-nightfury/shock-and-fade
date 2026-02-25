# Sports Split-Sell (SSS) Strategy Documentation

**Split early, sell the loser, hold the winner, MERGE if needed.**

---

## Table of Contents

1. [Strategy Overview](#1-strategy-overview)
2. [How It Works](#2-how-it-works)
3. [Sport-Specific Parameters](#3-sport-specific-parameters)
4. [Expected ROI](#4-expected-roi)
5. [Risk Management](#5-risk-management)
6. [Game End Detection and Settlement](#6-game-end-detection-and-settlement)
7. [Key Research Findings](#7-key-research-findings)

---

## 1. Strategy Overview

### Core Thesis

SSS is a **low-risk, positive expected value** strategy for Polymarket sports moneyline markets. It exploits the binary settlement mechanism where one side settles at $1.00 and the other at $0.00.

> **"Split early, sell the loser while it still has value, hold the winner to $1 settlement."**

Unlike directional betting that predicts game outcomes, SSS:
1. Enters **early** when prices are balanced (~50:50)
2. Waits for the market to pick a direction
3. Sells the **losing side** when it drops to a sport-specific threshold (15c-25c)
4. Holds the **winning side** until it settles at $1.00
5. Uses **MERGE** as a safety net if neither side drops below threshold

### Key Metrics

| Metric | Value |
|--------|-------|
| **Best Sport** | NHL (15.9% expected ROI) |
| **Overall Win Rate** | 90-95% |
| **Reversal Rate** | 5-10% (varies by sport) |
| **Max Position Size** | $100 (TIER1 liquidity) |
| **Daily Opportunities** | 5-9 games (NHL + NBA) |
| **Expected Daily Profit** | $20-40 (at $50-100 positions) |

### Why It Works

1. **Binary settlement creates asymmetric payoff**: Winner gets $1.00, loser gets $0.00
2. **Selling loser captures value**: Get 15c-25c instead of $0.00
3. **Holding winner maximizes gain**: Full $1.00 settlement instead of partial exit
4. **MERGE safety net**: If neither side drops, recover full capital

---

## 2. How It Works

### Strategy Flow Diagram

```
Game Start
    │
    ▼
┌─────────┐     ┌──────────────┐     ┌─────────────┐
│  SPLIT  │────▶│  YES + NO    │────▶│   MONITOR   │
│ $10 USDC│     │  10 + 10     │     │   PRICES    │
└─────────┘     │   tokens     │     └─────────────┘
                └──────────────┘            │
                       │                    │
                       │         ┌──────────┴──────────┐
                       │         │                     │
                       │    ┌────▼─────┐         ┌────▼─────┐
                       │    │ One side │         │ Neither  │
                       │    │ drops to │         │ hits     │
                       │    │ threshold│         │ threshold│
                       │    └────┬─────┘         └────┬─────┘
                       │         │                    │
                       │    ┌────▼─────┐         ┌────▼─────┐
                       │    │ SELL     │         │  MERGE   │
                       │    │ LOSER    │         │ (recover │
                       │    │ @ 22c    │         │  $10)    │
                       │    └────┬─────┘         └──────────┘
                       │         │
                       │    ┌────▼─────┐
                       │    │  HOLD    │
                       │    │ WINNER   │
                       │    │ until    │
                       │    │settlement│
                       │    └────┬─────┘
                       │         │
                       │    ┌────▼─────────────────────┐
                       │    │ Settlement:              │
                       │    │ Winner → $1.00 × 10 = $10│
                       │    │ Loser sold → $2.20       │
                       │    │ Split cost → -$10        │
                       │    │ PROFIT: $2.20            │
                       │    └──────────────────────────┘
                       │
```

### Example Trade (NHL Game)

| Step | Action | Result |
|------|--------|--------|
| 1 | SPLIT $10 USDC | Receive 10 YES + 10 NO tokens |
| 2 | Monitor prices | YES at 55c, NO at 45c |
| 3 | NO drops to 23c (below 25c threshold) | Trigger SELL |
| 4 | MARKET sell 10 NO @ 23c | Receive $2.30 |
| 5 | Hold 10 YES until settlement | Winner at $1.00 |
| 6 | **Result: YES wins** | $10.00 + $2.30 - $10.00 = **$2.30 profit** |

### Example Trade (MERGE Fallback)

| Step | Action | Result |
|------|--------|--------|
| 1 | SPLIT $10 USDC | Receive 10 YES + 10 NO tokens |
| 2 | Monitor prices | Both stay between 45c-55c |
| 3 | Game ends, neither hits threshold | Trigger MERGE |
| 4 | MERGE 10 YES + 10 NO → $10 USDC | Recover $10 |
| 5 | **Result: No loss** | $10.00 - $10.00 = **$0.00** (minus gas) |

### Entry Criteria

| Criteria | Condition | Rationale |
|----------|-----------|-----------|
| Sport | NHL, NFL, NBA, or Soccer (EPL/UCL) | Validated with high-confidence data |
| Market Type | Moneyline only | Binary winner outcome |
| Time Window | First 10 minutes of game | Entry window from research |
| Volume | > $50k (sport-specific) | Liquidity for exit |

### Understanding the Entry Window

The **Entry Window** is a critical 10-minute period at the start of each game when the SSS strategy can safely enter positions.

#### Why 10 Minutes?

Research (RQ-002, RQ-003b) showed that:
1. **Balanced pricing lasts ~10 minutes**: After the first 10 minutes, game developments often shift prices significantly
2. **SPLIT timing matters**: SPLIT operations take 10-12 seconds, so entering before game start ensures tokens arrive in time
3. **Early entry = more monitoring time**: Entering early gives more opportunity to identify and sell the losing side

#### Entry Window States

The dashboard countdown timer helps identify entry opportunities:

| Timer Display | State | Action |
|---------------|-------|--------|
| `Starts in 2h 15m` | **Scheduled** | Game not yet started - monitor for entry |
| `Starts in 45m 12s` | **Scheduled (soon)** | Prepare for entry, verify prices balanced |
| `Entry closes in 8m 32s` | **Entry Window Open** (green) | **Enter now!** Execute SPLIT |
| `LIVE 23m` | **Entry Closed** (red) | Too late for this game |

#### Best Practices for Entry

1. **Watch the countdown**: When timer shows "Entry closes in..." (green), the entry window is open
2. **Check prices first**: Ensure prices are reasonably balanced (45-55c range highlighted green)
3. **Enter early in window**: Don't wait until the last minute - SPLIT takes 10-12 seconds
4. **Use Force Entry for testing**: In paper trading, click "Split" to test entry at any game

---

## 3. Sport-Specific Parameters

### Sell Thresholds by Sport

| Sport | Sell Threshold | Reversal Rate | Expected ROI | Recommendation |
|-------|----------------|---------------|--------------|----------------|
| **NHL** | 25c | 9.1% | **15.9%** | PRIMARY TARGET |
| **NFL** | 20c | 5.7% | 14.3% | SEASONAL (Sept-Feb) |
| **NBA** | 15c | 9.9% | 5.1% | SECONDARY |
| **Soccer** | 30c | ~12%* | ~16%* | CONDITIONAL GO |

*Soccer parameters are estimates pending tick data validation. See [analysis/sss_soccer_league_feasibility.md](../analysis/sss_soccer_league_feasibility.md).

### Why Sport-Specific Thresholds?

Different sports have different comeback patterns:

- **NHL**: Games can swing with quick goals, but 25c threshold captures 90.9% correct sells
- **NFL**: Lower scoring, more predictable - 20c threshold achieves 94.3% accuracy
- **NBA**: High scoring, frequent lead changes - requires 15c threshold for 90.1% accuracy
- **Soccer**: Low-scoring with 21% draws - conservative 30c threshold recommended

### Soccer League Specifics

Soccer markets have a **3-way structure** (Home Win / Draw / Away Win), unlike US sports with binary outcomes:

| Aspect | US Sports | Soccer |
|--------|-----------|--------|
| Outcomes | 2 (Home/Away) | 3 (Home/Draw/Away) |
| Draw Rate | 0% (OT rules) | 21% |
| Market Type | Single moneyline | Three separate "Will X Win?" markets |

**How SSS handles 3-way markets:**
- Trade the "Will [Team] Win?" markets as binary (YES/NO)
- If game ends in draw: YES settles to $0, NO settles to $1
- Draw outcome = NO wins for BOTH teams' win markets
- SSS strategy still works - we hold the NO side which wins if team doesn't win

**Soccer Leagues by Status:**
| League | Prefix | Avg Volume | Status |
|--------|--------|-----------|--------|
| EPL (Premier League) | `epl-` | $15.6M | CONDITIONAL GO |
| UCL (Champions League) | `ucl-` | $7.5M | CONDITIONAL GO |
| La Liga | `lal-` | $39.8M | NEEDS MORE DATA |
| Bundesliga | `bun-` | $2.5M | NEEDS MORE DATA |
| Europa League | `uel-` | $205K | NO-GO (below threshold) |
| Serie A | `sea-` | $16K | NO-GO (volume) |

**Year-Round Advantage:** Unlike NHL/NFL/NBA with seasonal gaps, soccer provides opportunities year-round across different league schedules.

### Full Parameter Table

| Parameter | NHL | NFL | NBA | Soccer* |
|-----------|-----|-----|-----|---------|
| Sell Threshold | 25c | 20c | 15c | 30c |
| Min Sell Price | 5c | 5c | 5c | 5c |
| Min Volume 24h | $50k | $100k | $50k | $50k |
| Min Bet Size | $5 | $5 | $5 | $5 |
| Max Bet Size | $100 | $100 | $100 | $100 |
| Expected EV/$ | $0.159 | $0.143 | $0.051 | ~$0.16 |
| Reversal Rate | 9.1% | 5.7% | 9.9% | ~12% |
| Stop-Loss | NONE | NONE | NONE | NONE |
| Season | Oct-Jun | Sept-Feb | Oct-Jun | Year-round |

*Soccer parameters are estimates pending tick data validation.

---

## 4. Expected ROI

### Per-Position Math

```
Case 1: Correct Side Identification (90.9% for NHL)
- Split cost: $1.00
- Sell loser at 25c: +$0.25
- Winner settles at $1.00: +$1.00
- Net: $1.00 + $0.25 - $1.00 = +$0.25 profit

Case 2: Reversal (9.1% for NHL)
- Split cost: $1.00
- Sell "winner" at 25c: +$0.25
- Actual winner settles at $0.00: $0.00
- Net: $0.00 + $0.25 - $1.00 = -$0.75 loss

Expected Value (NHL):
EV = (0.909 × $0.25) + (0.091 × -$0.75) = $0.159 per $1 split
```

### Per-Sport Expected Returns

| Sport | EV per $1 | At $50 Position | At $100 Position |
|-------|-----------|-----------------|------------------|
| NHL | $0.159 | $7.95 | $15.90 |
| NFL | $0.143 | $7.15 | $14.30 |
| NBA | $0.051 | $2.55 | $5.10 |

### Daily Expected Profit

**Assumptions:**
- 3 NHL opportunities/day (50% of 5-10 games balanced)
- 3 NBA opportunities/day (30% of 8-12 games balanced)
- NFL: Seasonal (0 games off-season)

| Scenario | NHL | NBA | Total/Day |
|----------|-----|-----|-----------|
| Conservative ($50) | $11.93 | $7.65 | **$19.58** |
| Moderate ($75) | $17.89 | $11.48 | **$29.37** |
| Aggressive ($100) | $23.85 | $15.30 | **$39.15** |

**Monthly Estimates (30 days):**
- Conservative: ~$590
- Moderate: ~$880
- Aggressive: ~$1,175

---

## 5. Risk Management

### MERGE Safety Net

The MERGE operation is the key safety feature:
- If neither side drops below threshold after ~6 hours: MERGE both tokens back to $1 USDC
- **Worst case loss**: Gas fees only (~$0.01)
- This eliminates the risk of being stuck with worthless tokens

### No Stop-Loss Policy

Research (RQ-004) conclusively showed that **NO STOP-LOSS IS OPTIMAL**:

| Stop-Loss Level | EV Without SL | EV With SL | Winner |
|-----------------|---------------|------------|--------|
| 55c | +$0.059 | -$0.244 | **NO SL** |
| 50c | +$0.059 | -$0.268 | **NO SL** |
| 40c | +$0.059 | -$0.214 | **NO SL** |
| 30c | +$0.059 | -$0.094 | **NO SL** |

**Why?** 72% of eventual winners dropped below 50c during the game. One winner even dropped to 0.5c and still won! Stopping out locks in losses on positions that would have recovered.

### Risk Quantification

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Reversal (sell wrong side) | 9-10% | -$0.75/position | Accept as cost, included in EV |
| Game cancellation | <1% | Stuck tokens | Monitor for void events, MERGE |
| Liquidity collapse | Low | Can't exit | Min volume filter, TIER1 only |
| API downtime | Low | Miss entries | Auto-reconnect, health monitoring |

### Position Sizing

| AUM | Position Size | Max Concurrent | Daily Risk Limit |
|-----|---------------|----------------|------------------|
| $500 | $5-10 | 10 | $50 max |
| $1,000 | $10-25 | 20 | $100 max |
| $5,000 | $25-50 | 30 | $250 max |
| $10,000 | $50-100 | 50 | $500 max |

---

## 6. Game End Detection and Settlement

### How Game End is Detected

The SSS strategy automatically detects when a game has ended using a **price threshold mechanism**. When one side's BID price reaches **99c or higher**, it indicates the game outcome is essentially decided.

```
Game End Detection Logic:
1. Monitor both sides via WebSocket prices
2. When BID ≥ 99c on either side → Game likely ended
3. Fetch fresh price from CLOB API to confirm (avoid stale WebSocket data)
4. If confirmed 99c+, mark position as PENDING_SETTLEMENT
```

**Why 99c threshold?**
- At 99c, the market has ~99% confidence in the winner
- Polymarket settlement typically happens within minutes to hours after game end
- This threshold catches game end faster than waiting for API settlement confirmation

### Fresh Price Validation

WebSocket data can become stale for ended games (markets receive fewer updates). The strategy uses the `fetchFreshPrice()` utility to confirm game end:

```typescript
// Before marking game as ended:
const freshPrice = await priceMonitor.fetchFreshPrice(tokenId);
if (freshPrice.bid >= 0.99) {
  // Confirmed - game has ended
  positionManager.markPendingSettlement(marketSlug, winningOutcome, reason);
}
```

**Rate limiting consideration**: Fresh price fetches are limited to ~10 calls/second to avoid hitting CLOB API rate limits (9000/10s).

### MERGE Strategy at Game End

When a game ends with **both sides still held** (no sell trigger was hit), the strategy uses MERGE to recover capital:

**Scenario: Game Ends Without Sell Trigger**
```
1. SPLIT $10 → 10 YES + 10 NO tokens
2. Game plays out, prices fluctuate between 40c-60c
3. Neither side drops below sport-specific threshold (e.g., 25c for NHL)
4. Game ends: YES at 99c (winner), NO at 1c (loser)
5. Instead of holding to settlement: MERGE 10 YES + 10 NO → $10 USDC
6. Result: Recover full capital (minus gas ~$0.01)
```

**Why MERGE instead of waiting?**
- **Faster capital recovery**: MERGE completes in seconds vs. hours/days for settlement
- **Certainty**: MERGE always returns $1.00 per pair regardless of winner
- **No settlement risk**: Avoids rare settlement delays or disputes

**When MERGE is triggered:**
| Condition | Action |
|-----------|--------|
| Game ended (99c+ detected) AND both sides held | MERGE immediately |
| Position age > 6 hours AND no threshold hit | MERGE (safety fallback) |
| Market voided/cancelled AND both sides held | MERGE to recover capital |

### Hold-to-Settlement Flow

When the **loser side was already sold**, the strategy holds the winner until settlement:

**Scenario: Normal SSS Flow**
```
1. SPLIT $10 → 10 YES + 10 NO tokens
2. NO drops to 23c (below 25c threshold) → SELL 10 NO @ 23c = $2.30
3. Hold 10 YES
4. Game ends: YES at 99c → Position enters PENDING_SETTLEMENT
5. Wait for Polymarket settlement (auto or manual redemption)
6. Settlement: 10 YES @ $1.00 = $10.00
7. Result: $10.00 + $2.30 - $10.00 = $2.30 profit
```

### Position State Lifecycle

The full position state lifecycle including game end states:

```
                    ┌─────────────┐
                    │PENDING_SPLIT│
                    └──────┬──────┘
                           │ SPLIT completes
                           ▼
                    ┌─────────────┐
                    │   HOLDING   │ (both sides held)
                    └──────┬──────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
   │ Sell trigger│  │ Game ends   │  │ Age > 6h    │
   │ (BID < thld)│  │ (99c+ price)│  │ (safety)    │
   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
          │                │                │
          ▼                ▼                ▼
   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
   │PARTIAL_SOLD │  │    MERGE    │  │    MERGE    │
   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
          │                │                │
          │                │                │
          ▼                ▼                ▼
   ┌─────────────┐        ┌─────────────────────┐
   │   PENDING_  │        │      SETTLED        │
   │ SETTLEMENT  │        │  (capital recovered)│
   └──────┬──────┘        └─────────────────────┘
          │
          │ Redemption
          ▼
   ┌─────────────┐
   │   SETTLED   │
   └─────────────┘
```

**State Descriptions:**
| State | Description |
|-------|-------------|
| `PENDING_SPLIT` | Waiting for SPLIT operation to complete (10-12s) |
| `HOLDING` | Both YES and NO tokens held, monitoring for sell trigger |
| `PARTIAL_SOLD` | Loser sold at threshold, holding winner |
| `PENDING_SETTLEMENT` | Game ended, awaiting redemption or manual action |
| `SETTLED` | Position closed, P&L finalized |

---

## 7. Key Research Findings

### RQ-001: Market Discovery
- Individual game moneyline markets ARE available via Gamma API
- Slug pattern: `{sport}-{team1}-{team2}-{YYYY-MM-DD}`
- Use `sportsMarketType: "moneyline"` to filter

### RQ-002: Entry Timing
- ~30% of sports markets have balanced pricing (45-55c)
- NHL has highest balanced rate (~50%)
- Entry window: First 10 minutes of game

### RQ-003/003b: Sell Threshold
- Sport-specific thresholds are CRITICAL
- Polymarket reversal rates are HIGHER than academic data predicted
- NBA requires 15c (not 30c) to achieve <10% reversal

### RQ-004: Stop-Loss Analysis
- **NO STOP-LOSS IS OPTIMAL** at any price level
- 72% of winners dropped below 50c during game
- Hold winner until settlement regardless of price drops

### RQ-004b: Large-Scale Analysis (468 Markets)
- NHL: Best EV ($0.159), 25c threshold, 9.1% reversal
- NFL: Lowest reversal (5.7%), 20c threshold, 14.3% EV
- NBA: Lowest EV ($0.051), needs 15c threshold

### RQ-005: Live Market Survey
- NHL/NBA best for SSS (volume + balanced pricing)
- Esports excluded (unreliable liquidity)
- CBB excluded (insufficient data)

### RQ-006/007: Tick Data Analysis
- All pro sports are TIER1 (excellent liquidity)
- Slippage <1.5% at $100 positions
- MARKET orders viable for fast execution

---

## References

| Document | Path | Description |
|----------|------|-------------|
| Research Summary | `analysis/sss_research_summary.md` | Consolidated findings |
| Final Parameters | `analysis/sss_final_parameters.md` | Production config |
| Sport Params | `src/config/sss_sport_params.json` | Machine-readable config |
| Market Discovery | `analysis/sss_market_discovery.md` | API patterns |
| Sell Threshold | `analysis/sss_sell_threshold.md` | Threshold research |
| Stop-Loss | `analysis/sss_stop_loss.md` | No stop-loss evidence |
| Tick Data | `analysis/sss_tick_data_analysis.md` | Liquidity analysis |

---

*Last Updated: 2026-02-04*
*Strategy Version: SSS 1.0*
