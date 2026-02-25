# NFL Super Bowl LX — Shock-Fade Strategy Analysis

**Game**: Seattle Seahawks 29 – New England Patriots 7
**Date**: February 8, 2026 | **Kickoff**: 23:30 UTC
**Market**: `nfl-sea-ne-2026-02-08` on Polymarket
**Data**: 34,931 snapshots, 8 scoring plays
**Recording**: 2026-02-06T23:45:12.815Z → 2026-02-09T03:08:32.029Z

---

## 1. Game Summary & Scoring Plays

| Q | Clock | Team | Play | Score | Type |
|---|-------|------|------|-------|------|
| 1 | 11:58 | SEA | Jason Myers 33 Yd Field Goal | 3-0 | Field Goal |
| 2 | 11:16 | SEA | Jason Myers 39 Yd Field Goal | 6-0 | Field Goal |
| 2 | 0:11 | SEA | Jason Myers 41 Yd Field Goal | 9-0 | Field Goal |
| 3 | 9:12 | SEA | Jason Myers 41 Yd Field Goal | 12-0 | Field Goal |
| 4 | 13:24 | SEA | AJ Barner 16 Yd pass from Sam Darnold (Jason Myers Kick) | 19-0 | Touchdown |
| 4 | 12:27 | NE | Mack Hollins 35 Yd pass from Drake Maye (Andy Borregales Kick) | 19-7 | Touchdown |
| 4 | 5:35 | SEA | Jason Myers 26 Yd Field Goal | 22-7 | Field Goal |
| 4 | 4:27 | SEA | Uchenna Nwosu 45 Yd Interception Return (Jason Myers Kick) | 29-7 | Touchdown |

**Game Character**: SEA dominated from start — 4 field goals built a 12-0 lead through Q3,
then TDs in Q4 blew it open. NE's only score was a garbage-time TD at 12:27 Q4.
This was a **one-sided game** — SEA's win probability climbed steadily from ~67.5¢ to ~98.6¢.

**Price Arc**: SEA opened at ~0.315 and closed at ~0.001 (+-31.4¢ total)

---

## 2. Shock Detection Results

**Parameters**: 2σ threshold, 3¢ absolute minimum, 60s rolling window, 30s cooldown

| Metric | Value |
|--------|-------|
| Total shocks | 133 |
| Median magnitude | 1¢ |
| Mean magnitude | 1¢ |
| Max magnitude | 4¢ |
| Mean z-score | 3.57 |
| Max z-score | 13.65 |

**Magnitude distribution**:
- 3-5¢: 7 shocks
- 6-10¢: 0 shocks
- 11-20¢: 0 shocks
- 21-50¢: 0 shocks
- >50¢: 0 shocks

---

## 3. Post-Shock Price Behavior

### Classification
- **Reverted** (>50% revert within 10 min): 88.7%
- **Continued** (pushed further past shock): 9.8%
- **Flat** (stayed near shock level): 1.5%

### Reversion Timeline

| Time After Shock | Avg Reversion (% of move) |
|------------------|---------------------------|
| 30s | 49.2% |
| 60s | 47.8% |
| 120s | 61.4% |
| 300s (5 min) | 117% |
| 600s (10 min) | 159.7% |

### Overshoot & Reversion Magnitude
- **Max overshoot** (within 10 min): mean 2.51¢, median 2¢, P90 5¢
- **Max reversion** (within 10 min): mean 3.72¢, median 3.5¢, P90 7.27¢

---

## 4. Event Correlation

| Metric | Value |
|--------|-------|
| Shocks with scoring event (±120s) | 21 (15.8%) |
| Shocks without event (market noise) | 112 |
| Mean lag (event vs price) | 3.6s |
| Median lag | 0s |

---

## 5. Spread & Liquidity

| Metric | Overall | During Shocks |
|--------|---------|---------------|
| Mean spread | 0.99¢ | 1.29¢ |
| Median spread | 1¢ | 1¢ |
| P90 spread | 1¢ | — |

---

## 6. NFL vs NBA Comparison

| Dimension | NBA (from existing analysis) | NFL (Super Bowl) |
|-----------|------------------------------|------------------|
| Scoring frequency | Every 40-50s | Every 23+ min |
| Scores per game | ~200 | 8 |
| Median shock magnitude | ~5¢ | 1¢ |
| Max shock magnitude | ~15-20¢ | 4¢ |
| Typical spread | 1-2¢ | 1¢ |
| Time between scores | 40-50s | 26.9 min |

### Key Differences:

1. **Fewer but BIGGER shocks**: NFL games have far fewer scoring events (~8-12 vs ~200 in NBA),
   but each scoring event can move prices 5-20¢+ vs NBA's typical 2-5¢.

2. **Long gaps between scores**: NFL has 3-10 minute gaps between possessions. This means:
   - More time for the market to digest information
   - Less "noise" between scoring plays
   - Longer hold times needed for fade trades

3. **Discrete, high-impact events**: Touchdowns (+7 points) create the biggest shocks.
   Field goals (+3 points) create moderate moves. Turnovers create anticipatory moves.

4. **Game flow matters more**: In a blowout (like this Super Bowl), the market steadily
   reprices toward certainty. Fewer fade opportunities in one-sided games.

---

## 7. Strategy Recommendations for NFL

### 7.1 Parameter Adjustments (vs NBA baseline)

| Parameter | NBA Value | NFL Recommendation | Rationale |
|-----------|-----------|-------------------|-----------|
| Z-threshold | 2σ | 2-3σ | NFL shocks are rarer but bigger; keep 2σ to not miss FG moves |
| Absolute threshold | 3¢ | 4-5¢ | NFL moves are bigger; avoid trading on noise |
| Ladder spacing | 3¢ (1/2/3) | 5-8¢ (3/5/8) | Much wider price swings mean wider ladders |
| Take-profit | 4¢ | 3-4¢ | Field goals create ~5¢ moves that partially revert |
| Timeout | 240s | 600s (10 min) | NFL possessions take 3-5 min; need longer hold |
| Cooldown | 30s | 60s | Fewer events, but they happen in clusters (TD + PAT) |

### 7.2 Event-Specific Strategy

**Touchdowns (TD + PAT = 7 points)**
- Expected price move: 8-20¢+ (depends on game state)
- These are the BIG shock-fade opportunities
- Ladder: 5¢/8¢/12¢ past shock price
- Often see 2-5¢ overshoot that reverts within 60-120s
- ⚠️ Beware: momentum TDs (pick-6, fumble return) may have LESS reversion

**Field Goals (3 points)**
- Expected price move: 3-8¢
- More modest fade opportunity
- Ladder: 2¢/3¢/5¢ past shock price
- FGs often come at end of stalled drives → market may partially price in

**Turnovers / Interceptions (no score)**
- Create 2-5¢ anticipatory moves
- These can be good fade candidates since no actual score change
- But harder to detect programmatically (no "scoring play" signal)

### 7.3 Game State Considerations

**Close games (within 7 points)**
- Maximum shock-fade opportunity
- Each score creates maximum uncertainty shift
- Wider ladders justified

**Blowouts (15+ point lead)**
- Reduced shock-fade opportunity
- Winning team's price already near ceiling
- Losing team's touchdowns may create brief reversion opportunities
- Consider: only trade against the dominant trend (fade NE TDs in a SEA blowout)

**2-Minute Warning / Clock Management**
- Scoring compressed into final 2 min of halves
- Multiple rapid events possible
- Shorter timeout windows may work here

### 7.4 Risk Considerations

1. **Low sample size per game**: Only 8-12 scoring plays means 3-6 tradeable shocks per game.
   Cannot rely on volume for edge — each trade must be high-conviction.

2. **Liquidity**: NFL Super Bowl has excellent liquidity, but regular season games may be thin.
   Spreads widen significantly during shocks.

3. **Information asymmetry**: NFL has TV delay + sideline reporters. Some traders may have
   1-3 second edge from stadium feeds. Price moves BEFORE ESPN updates are common.

4. **One-sided games**: This Super Bowl was a blowout. Most shocks "continued" rather than
   "reverted" because the fundamental direction was clear. Fade strategy works best in
   **competitive, back-and-forth games**.

### 7.5 Optimal NFL Shock-Fade Parameters

```
NFL_PARAMS = {
  z_threshold: 2.0,
  abs_threshold_cents: 4,
  window_ms: 60000,
  cooldown_ms: 60000,
  ladder_spacing_cents: [3, 5, 8],
  ladder_sizes_usd: [100, 200, 300],
  take_profit_cents: 4,
  timeout_ms: 600000,  // 10 min
  price_floor: 0.10,   // skip garbage time / near-certain outcomes
  price_ceiling: 0.90,
  // Only trade competitive games
  max_price_delta_from_50: 0.40,  // skip if price > 0.90 or < 0.10
}
```

---

## 8. Conclusion

NFL presents a **qualitatively different** shock-fade environment than NBA:

- **Fewer trades, bigger stakes**: 3-6 tradeable shocks per game vs 20-40 in NBA
- **Wider parameters needed**: Bigger shocks → wider ladders, longer timeouts
- **Game state is critical**: Blowouts kill the strategy; competitive games are where the edge lives
- **Event-driven exit is less viable**: NFL scoring is discrete but drives take minutes;
  time-based exits (5-10 min timeout) are more practical than waiting for "next score"

**Bottom line**: NFL shock-fade can work but requires:
1. Wider ladder spacing (3/5/8¢ vs 1/2/3¢)
2. Longer hold times (up to 10 min vs 4 min)
3. Game-state filtering (skip blowouts, focus on competitive games)
4. Higher conviction per trade (fewer opportunities, larger sizing)

---

*Generated: 2026-02-09T03:08:33.362Z*