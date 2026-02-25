# SSS Strategy Lessons Learned

This document tracks insights and parameter refinements discovered during live trading.

## How to Use This Document

1. **Run Performance Analyzer** after 50+ positions:
   ```bash
   python analysis/sss_performance_analyzer.py --positions-file ./sss_positions.json
   ```

2. **Review Recommendations** in `analysis/sss_performance_report.md`

3. **Apply Parameter Changes** via `src/config/sss_runtime_params.json`

4. **Document Lessons** below for future reference

---

## Scaling Tier Progression

| Date | Tier | Positions | Win Rate | Notes |
|------|------|-----------|----------|-------|
| _TBD_ | STARTER | 0+ | Any | Initial deployment |
| _TBD_ | CONSERVATIVE | 50+ | 80%+ | First tier upgrade |
| _TBD_ | MODERATE | 100+ | 85%+ | Proven profitability |
| _TBD_ | AGGRESSIVE | 200+ | 85%+ | Full position sizing |

---

## Parameter Adjustments Log

### Template Entry

```
### [Date] - [Sport] Parameter Adjustment

**Trigger:** What prompted this change (e.g., performance analyzer recommendation)

**Change:**
- Previous: `sell_threshold = 0.25`
- New: `sell_threshold = 0.20`

**Rationale:** Why this change was made

**Results (after 20+ positions):**
- Reversal rate: _X%_ vs expected _Y%_
- ROI: _X%_ vs expected _Y%_

**Conclusion:** Keep / Revert / Further adjust
```

---

## Lessons by Category

### Entry Timing

_(Document insights about when to enter markets)_

### Sell Threshold Optimization

_(Document findings about sport-specific sell thresholds)_

### Liquidity Observations

_(Document insights about order book depth and slippage)_

### Market Selection

_(Document which markets work best for SSS)_

### Risk Management

_(Document insights about position sizing and loss limits)_

---

## Key Metrics to Track

After each batch of 50 positions, record:

| Batch | NHL ROI | NFL ROI | NBA ROI | Overall | Reversals | Win Rate |
|-------|---------|---------|---------|---------|-----------|----------|
| 1-50 | | | | | | |
| 51-100 | | | | | | |
| 101-150 | | | | | | |
| 151-200 | | | | | | |

---

## Expected vs Actual Performance

### Research Baselines (from RQ-004b)

| Sport | Expected EV | Expected Reversal | Sell Threshold |
|-------|-------------|-------------------|----------------|
| NHL | 15.9% | 9.1% | 25c |
| NFL | 14.3% | 5.7% | 20c |
| NBA | 5.1% | 9.9% | 15c |

### Actual Performance (to be filled)

| Sport | Actual EV | Actual Reversal | Variance Notes |
|-------|-----------|-----------------|----------------|
| NHL | _TBD_ | _TBD_ | |
| NFL | _TBD_ | _TBD_ | |
| NBA | _TBD_ | _TBD_ | |

---

## Common Issues and Solutions

### Issue: High Reversal Rate

**Symptoms:** Reversal rate > expected + 5%

**Possible Causes:**
1. Selling too early (threshold too high)
2. Market selection issues (entering lopsided games)
3. Sport-specific variance

**Solutions:**
1. Lower sell threshold by 5c
2. Add stricter entry criteria
3. Review sport-specific parameters

### Issue: Low Fill Rate

**Symptoms:** SPLIT or SELL orders failing frequently

**Possible Causes:**
1. Insufficient liquidity
2. Network congestion
3. Rate limiting

**Solutions:**
1. Increase minimum volume requirement
2. Add retry logic with backoff
3. Reduce order frequency

### Issue: Negative ROI

**Symptoms:** Losing money despite research showing positive EV

**Possible Causes:**
1. Sample size too small
2. Parameters not matching research conditions
3. Market conditions changed

**Solutions:**
1. Wait for 50+ positions before adjusting
2. Run performance analyzer for detailed breakdown
3. Compare to research assumptions

---

## Rollback Plan

If performance significantly deviates from expectations:

1. **Stop new entries:** Set `enabled: false` in scaling config
2. **Let existing positions settle:** Don't force exits
3. **Review performance data:** Run analyzer
4. **Identify root cause:** Compare to research baselines
5. **Adjust parameters:** Use runtime config for live changes
6. **Resume with caution:** Start at STARTER tier again

---

## Monthly Review Checklist

- [ ] Run performance analyzer
- [ ] Compare actual vs expected metrics
- [ ] Review any alerts or unusual losses
- [ ] Check sport-specific performance
- [ ] Update parameters if needed
- [ ] Document lessons learned
- [ ] Consider tier upgrade/downgrade

---

*Last Updated: Initial Template*
*Strategy Version: SSS v1.0*
*US-401: Live Scaling and Optimization*
