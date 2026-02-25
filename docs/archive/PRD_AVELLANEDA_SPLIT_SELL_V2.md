# PRD: Avellaneda Split-Sell Strategy V2 (ASS-V2)

## Executive Summary

A spread-capture market-making strategy for Polymarket 15-minute binary crypto markets. The strategy uses SPLIT to acquire token pairs and SELL both sides continuously to capture spread profit. The core philosophy: **sell more, stay balanced, never gamble on direction**.

**Key Differences from V1:**
- Research-first approach: Understand tick data patterns before coding
- Dynamic split sizing based on window-start balance (25%)
- Balance priority over direction prediction
- Fill simulation matches live trading exactly (trade-based, size-limited)
- Success = high turnover (500+ shares/side/window) with positive P&L

---

## 1. Problem Statement

### V1 Failures
1. **maxTotalSplit cap prevented resplits** - Initial split consumed 100% capacity, no room to replenish
2. **Sold below cost** - No minimum price protection, lost money on individual trades
3. **Avellaneda worked against us** - Widened spread on side we needed to dump
4. **Winner prediction failed** - Phase 3 "dump loser" strategy accelerated losses
5. **Backtest didn't match live** - 28% gap made parameter optimization unreliable

### V2 Solution
1. **Unlimited resplits** - 25% of balance per split, resplit when either side < 20% inventory
2. **Spread optimization via research** - Understand what spreads actually fill
3. **Balance-first Avellaneda** - Skew to maintain balance, not predict winners
4. **No winner prediction** - Stay balanced, profit from spread on BOTH sides
5. **Accurate backtest** - Trade-based fills with size limits and latency simulation

---

## 2. Strategy Principles

### 2.1 Core Philosophy
```
Source of tokens:  SPLIT ($1.00 = 1 UP + 1 DOWN)
Source of profit:  Sell both sides for combined revenue > $1.00
Primary goal:      Maximize turnover (shares sold) while maintaining balance
Secondary goal:    End window with slight overweight on winner (bonus, not strategy)
Risk to avoid:     Overweight on LOSER at settlement (catastrophic loss)
```

### 2.2 Capital Model
```
Window Start Balance: $1000 (configurable)
Initial Split Size:   25% of balance = $250 = 250 pairs
Resplit Trigger:      Either side < 20% of split size (< 50 tokens)
Resplit Size:         Same as initial (250 pairs)
Maximum Splits:       Unlimited (constrained only by balance and liquidity)
Minimum Order:        5 shares (Polymarket requirement)
```

### 2.3 Balance Priority
```
ALWAYS stay balanced. Imbalance = risk.

If UP inventory >> DOWN inventory:
  - Avellaneda skews: sell MORE UP, sell LESS DOWN
  - Spread skews: TIGHTER spread on UP (fills faster), WIDER on DOWN

Accept selling at loss to rebalance:
  - The loss threshold (e.g., sell at 45c when cost=50c) is a tunable parameter
  - Better to take small loss rebalancing than hold loser to settlement
```

### 2.4 No Winner Prediction (Early Window)
```
Minutes M0-M?: We DON'T predict winners
  - Market is noisy, direction unclear
  - Both sides oscillate around 50c
  - Strategy: Sell both sides equally, capture spread

Minutes M?-M15: Pattern-based behavior (TO BE DISCOVERED)
  - Research will reveal: At what point does price become predictive?
  - Research will reveal: How should behavior change?
  - This is NOT time-based, it's pattern-based
```

---

## 3. Implementation Phases

### Phase 0: Research & Pattern Discovery (CURRENT)
### Phase 1: Backtest Engine with Accurate Fill Simulation
### Phase 2: Parameter Optimization via Backtest
### Phase 3: Live Simulation Validation
### Phase 4: Live Trading Deployment

---

## 4. Phase 0: Research & Pattern Discovery

**OBJECTIVE:** Before writing strategy code, understand the market patterns that will inform strategy parameters and phase transitions.

### 4.1 Data Requirements

```
Source: Tick collector data from /mnt/HC_Volume_102468263/polymarket_ticks/
Required: Minimum 48+ hours of data (ideally 72+ hours)
Coverage: Must include weekday AND weekend data
Markets: BTC 15-minute markets (primary), optionally ETH/SOL/XRP
Format: JSONL with book events (bids[], asks[]) and trade events (price, size, side)
```

### 4.2 Research Questions (User Stories)

#### RQ-001: Spread & Fill Rate Analysis
**Question:** What spreads actually get filled? How does fill rate vary by spread size?

**Analysis Required:**
- For each spread level (1c, 2c, 3c, 4c, 5c above BID):
  - What % of time would a sell order fill within 1 minute?
  - What's the average fill time?
  - Does fill rate vary by minute (M0-M5 vs M5-M10 vs M10-M15)?
- Find the "optimal spread" that balances fill probability vs profit per fill

**Output:** `analysis/ass_v2_spread_analysis.md`
- Fill rate curves by spread size
- Recommended tight/wide spread values
- Time-based fill rate patterns

---

#### RQ-002: Liquidity & Volume Patterns
**Question:** When does liquidity dry up? How much can we sell per minute?

**Analysis Required:**
- Trade volume by minute (M0, M1, M2... M14)
- Average trade size distribution
- Bid depth at each minute (how many shares at best bid?)
- Identify "danger zones" where selling becomes difficult

**Output:** `analysis/ass_v2_liquidity_analysis.md`
- Volume curves by minute
- Maximum safe sell rate per minute
- Liquidity warning thresholds

---

#### RQ-003: Price Predictability Timeline
**Question:** At what minute does current price become a reliable settlement predictor?

**Analysis Required:**
- For each minute M0-M14:
  - If UP BID > 50c at minute M, what % of time does UP win?
  - If UP BID > 60c at minute M, what % of time does UP win?
  - If UP BID > 70c at minute M, what % of time does UP win?
- Find the "confidence threshold": At what (minute, price) combo is winner >80% predictable?

**Output:** `analysis/ass_v2_predictability_analysis.md`
- Predictability matrix: minute × price threshold → winner probability
- Recommended "safe to predict" conditions (if any)
- Reversal frequency by minute

---

#### RQ-004: Imbalance Recovery Patterns
**Question:** If we become imbalanced, how quickly can we recover? What's the cost?

**Analysis Required:**
- Simulate: Start with 60 UP / 40 DOWN imbalance
- How many minutes to rebalance to 50/50?
- What spread is needed to dump the oversupplied side?
- What's the typical cost (loss) to rebalance?

**Output:** `analysis/ass_v2_imbalance_analysis.md`
- Recovery time by imbalance severity
- Cost to rebalance curves
- Recommended imbalance thresholds for action

---

#### RQ-005: Phase Transition Signals
**Question:** What patterns should trigger behavior changes? (Not time-based, pattern-based)

**Analysis Required:**
- Identify patterns that precede strong directional moves:
  - Spread widening on one side?
  - Volume spike?
  - Price crossing threshold (e.g., 60c)?
- Identify patterns that indicate "safe to continue symmetric selling"
- Correlate patterns with settlement outcomes

**Output:** `analysis/ass_v2_phase_signals.md`
- List of candidate phase transition signals
- Signal → outcome correlation data
- Recommended phase transition rules

---

#### RQ-006: Optimal Avellaneda Parameters
**Question:** What eta (sizing) and gamma (spread) values work best historically?

**Analysis Required:**
- Simulate different eta values [0.1, 0.2, 0.3, 0.4, 0.5] on historical data
- Simulate different gamma values [0.3, 0.5, 0.7, 1.0] on historical data
- Measure: balance maintenance, turnover, theoretical P&L

**Output:** `analysis/ass_v2_avellaneda_params.md`
- Parameter sensitivity analysis
- Recommended starting values for backtest optimization
- Any new parameters suggested by the data

---

### 4.3 Research Deliverables

| ID | Output File | Key Finding |
|----|-------------|-------------|
| RQ-001 | `ass_v2_spread_analysis.md` | Optimal tight/wide spreads |
| RQ-002 | `ass_v2_liquidity_analysis.md` | Safe sell rate, danger zones |
| RQ-003 | `ass_v2_predictability_analysis.md` | When (if ever) to predict winner |
| RQ-004 | `ass_v2_imbalance_analysis.md` | Rebalancing cost/time |
| RQ-005 | `ass_v2_phase_signals.md` | Pattern-based phase triggers |
| RQ-006 | `ass_v2_avellaneda_params.md` | Starting parameter values |

**Master Summary:** `analysis/ass_v2_research_summary.md`
- Consolidated findings from all research questions
- Recommended strategy parameters based on research
- Identified risks and edge cases

---

## 5. Phase 1: Backtest Engine

**PREREQUISITE:** Phase 0 complete with research findings

### 5.1 Backtest Requirements

#### US-100: Create accurate backtest engine
**Description:** Backtest that replicates live trading fill mechanics exactly.

**Acceptance Criteria:**
- Fill detection: Trade-based (trade occurs at or above our ASK = potential fill)
- Fill size: Limited to trade size (if trade is 10 shares, we fill max 10 shares)
- Latency simulation: Configurable delay (default 100ms) before processing each tick
- Order update delay: Configurable delay before order changes take effect
- Track: inventory, P&L, fills per side, turnover rate
- Output: Per-tick log for debugging

**File:** `analysis/backtest_ass_v2.py`

---

#### US-101: Implement dynamic split sizing
**Description:** Split size based on 25% of window-start balance.

**Acceptance Criteria:**
- Initial split = 25% of starting balance (e.g., $250 on $1000)
- Resplit triggered when either side < 20% of split size
- Resplit size = same as initial split
- Track total splits, total cost, remaining balance

---

#### US-102: Implement Avellaneda with balance priority
**Description:** Sizing and spread skew to maintain balance.

**Acceptance Criteria:**
- q = (up - down) / (up + down) as inventory imbalance
- Sizing skew: oversupplied side gets LARGER orders (dump faster)
- Spread skew: oversupplied side gets TIGHTER spread (fill faster)
- Configurable eta (sizing) and gamma (spread) parameters
- Additional parameters from Phase 0 research

---

#### US-103: Implement pattern-based phases
**Description:** Phase transitions based on research findings, not fixed time.

**Acceptance Criteria:**
- Phase triggers based on patterns identified in RQ-005
- Each phase has configurable behavior (spreads, aggressiveness)
- Fallback to time-based if no pattern detected
- Log phase transitions with trigger reason

---

### 5.2 Backtest Validation

#### US-104: Validate backtest against live simulation
**Description:** Ensure backtest matches live simulation within acceptable margin.

**Acceptance Criteria:**
- Run backtest on 10 windows that have corresponding live simulation logs
- Compare: total P&L, fills per side, inventory timeline
- Target: <20% P&L deviation on 8/10 windows
- Document any systematic differences

---

## 6. Phase 2: Parameter Optimization

**PREREQUISITE:** Phase 1 complete with validated backtest

### 6.1 Parameter Space

Based on Phase 0 research, tune these parameters:

| Parameter | Range | Description |
|-----------|-------|-------------|
| `split_pct` | 20-30% | Percentage of balance for split |
| `resplit_threshold` | 15-25% | Resplit when side < X% of split |
| `tight_spread` | 1-3c | From RQ-001 |
| `wide_spread` | 3-6c | From RQ-001 |
| `tight_allocation` | 60-80% | % inventory at tight level |
| `eta` | 0.1-0.5 | Sizing skew (from RQ-006) |
| `gamma` | 0.3-1.0 | Spread skew (from RQ-006) |
| `latency_ms` | 50-200ms | Simulated processing delay |
| `loss_threshold` | -5c to -15c | Max loss to accept for rebalancing |
| `phase_signals` | From RQ-005 | Pattern-based phase triggers |

### 6.2 Optimization User Stories

#### US-200: Grid search parameter optimization
**Description:** Find parameter combination that achieves success criteria.

**Acceptance Criteria:**
- Test parameter combinations on 10+ windows
- Success criteria: 
  - Total P&L > $0 across 10 windows
  - Average 500+ shares sold per side per window
  - Win rate > 60% (6/10 windows profitable)
- Save winning parameters to `analysis/ass_v2_optimal_params.json`
- Maximum 50 iterations

---

#### US-201: Sensitivity analysis
**Description:** Understand which parameters matter most.

**Acceptance Criteria:**
- For each parameter, measure P&L impact of ±20% change
- Identify "critical" parameters (high sensitivity)
- Identify "safe" parameters (low sensitivity)
- Document in `analysis/ass_v2_sensitivity.md`

---

## 7. Phase 3: Live Simulation Validation

**PREREQUISITE:** Phase 2 complete with optimized parameters

### 7.1 Validation User Stories

#### US-300: Deploy optimized simulation
**Description:** Run live simulation with optimized parameters.

**Acceptance Criteria:**
- Update `TwoLevelASS_Simulation.ts` (or create V2) with optimal params
- Deploy to Finland server
- Run for 10 consecutive full 15-minute windows
- Monitor via Dashboard V2

---

#### US-301: Validate against backtest predictions
**Description:** Confirm live results match backtest expectations.

**Acceptance Criteria:**
- Compare per-window P&L: live vs backtest prediction
- Compare turnover: live vs backtest
- Success: 
  - Total P&L > $0
  - 500+ shares/side/window average
  - Results within 30% of backtest prediction
- If fail: identify divergence, fix backtest, repeat from Phase 2

---

## 8. Phase 4: Live Trading

**PREREQUISITE:** Phase 3 passes validation

### 8.1 Live Trading User Stories

#### US-400: Create live trading strategy
**Description:** Production-ready strategy with real order execution.

**Acceptance Criteria:**
- Create `AvellanedaSplitSell_V2.ts` using PolymarketClient
- Real SPLIT, real SELL orders
- Safety limits: max loss per window, position persistence
- Gradual capital ramp: start $100/window, scale up if profitable

---

#### US-401: Deploy and monitor
**Description:** Production deployment with monitoring.

**Acceptance Criteria:**
- Systemd service for auto-restart
- Dashboard V2 integration
- Alert on unusual losses
- Daily P&L reporting

---

## 9. Success Metrics

### Primary KPIs
| Metric | Target | Measurement |
|--------|--------|-------------|
| Total P&L (10 windows) | > $0 | Sum of all window P&L |
| Turnover per window | > 500 shares/side | Average (UP sold + DOWN sold) / 2 |
| Win rate | > 60% | Windows with P&L > $0 |

### Secondary KPIs
| Metric | Target | Measurement |
|--------|--------|-------------|
| Max single-window loss | < $50 | Worst window P&L |
| Inventory balance | < 30% imbalance | Max |q| during window |
| Spread captured | > 2c average | Revenue per share sold |
| Resplit count | < 3/window | Indicator of capital efficiency |

---

## 10. Risk Management

### Risk: One-sided fills (trending market)
**Mitigation:**
- Avellaneda skew accelerates selling of oversupplied side
- Tighter spread on oversupplied = faster fills
- Accept loss to rebalance before it's too late

### Risk: Low liquidity near settlement
**Mitigation:**
- Research (RQ-002) identifies danger zones
- Reduce selling in low-liquidity periods
- Ensure inventory is balanced BEFORE liquidity dries up

### Risk: Overweight on loser at settlement
**Mitigation:**
- Balance-first philosophy throughout window
- Pattern-based alerts from RQ-005 research
- Emergency rebalancing with configurable loss threshold

### Risk: Backtest doesn't match live
**Mitigation:**
- Trade-based fills with size limits
- Latency simulation
- Validate on 10 windows before trusting

---

## 11. Technical Architecture

### File Structure
```
poly_arbitrage/
├── src/
│   ├── strategies/
│   │   ├── AvellanedaSplitSell_V2_Simulation.ts  # Live simulation
│   │   └── AvellanedaSplitSell_V2.ts             # Live trading
│   ├── run-ass-v2-simulation.ts                   # Simulation entry
│   └── run-ass-v2.ts                              # Live entry
├── analysis/
│   ├── ass_v2_spread_analysis.md                  # RQ-001
│   ├── ass_v2_liquidity_analysis.md               # RQ-002
│   ├── ass_v2_predictability_analysis.md          # RQ-003
│   ├── ass_v2_imbalance_analysis.md               # RQ-004
│   ├── ass_v2_phase_signals.md                    # RQ-005
│   ├── ass_v2_avellaneda_params.md                # RQ-006
│   ├── ass_v2_research_summary.md                 # Master summary
│   ├── backtest_ass_v2.py                         # Backtest engine
│   ├── ass_v2_optimal_params.json                 # Winning params
│   └── ass_v2_sensitivity.md                      # Sensitivity analysis
└── docs/
    └── PRD_AVELLANEDA_SPLIT_SELL_V2.md            # This document
```

### Dashboard Integration
Same as V1 - use DashboardRelay for real-time visualization:
- MARKET_SWITCH, PRICE_UPDATE, ORDER_PLACED, ORDER_FILLED, POSITION_UPDATE
- Port configurable via --port CLI argument

---

## 12. Timeline

| Phase | Duration | Status |
|-------|----------|--------|
| Phase 0: Research | 1-2 days | **CURRENT** |
| Phase 1: Backtest | 1 day | Pending |
| Phase 2: Optimization | 1 day | Pending |
| Phase 3: Live Simulation | 3 hours | Pending |
| Phase 4: Live Trading | Ongoing | Pending |

**Critical Path:**
```
Research (understand patterns) 
    → Backtest (accurate simulation)
        → Optimize (find winning params)
            → Validate (confirm in live sim)
                → Deploy (real money)
```

---

## 13. Appendix: V1 vs V2 Comparison

| Aspect | V1 | V2 |
|--------|----|----|
| Split sizing | Fixed maxTotalSplit cap | 25% of balance, unlimited resplits |
| Resplit trigger | Inventory ratio < threshold | Either side < 20% of split |
| Winner prediction | Phase 3 "dump loser" | No prediction (balance-first) |
| Phase transitions | Time-based (M8, M12) | Pattern-based (from research) |
| Fill simulation | Any trade at ASK = full fill | Trade-based with SIZE limit |
| Success metric | 90% win rate | Positive P&L + 500 turnover |
| Research | None (jumped to implementation) | Required Phase 0 |

---

*Document Version: 2.0*
*Created: 2025-01-24*
*Author: Claude + User collaboration*
