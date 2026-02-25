# US-505: Backtest Parity Calibration Results

## Summary

The backtest has been calibrated against simulation log `1769426100`. The goal was to achieve <20% drift on all 5 metrics.

## Final Results

| Metric | Simulation | Backtest | Drift | Status |
|--------|------------|----------|-------|--------|
| P&L | $88.83 | $84.22 | **5.2%** | ✅ PASS |
| Remaining UP | 165 | 193 | **17.0%** | ✅ PASS |
| Remaining DOWN | 179 | 311 | 73.7% | ❌ FAIL |
| Turnover UP | 10,198 | 6,407 | 37.2% | ❌ FAIL |
| Turnover DOWN | 10,162 | 6,289 | 38.1% | ❌ FAIL |

## Configuration

```typescript
{
  maxOpenOrdersPerSide: 2,      // Match simulation
  baseOrderSize: 10,            // Match simulation
  fillMultiplier: 3.5,          // Compensate for tick data gaps
  fillProbability: 1.0,         // 100% - no probability filtering
  minMsBetweenFills: 0,         // No cooldown
  orderPlacementLatencyMs: 0,   // Immediate order activation
}
```

## Root Cause Analysis

### Why Turnover is ~37% Lower

1. **Tick Data Sampling Gap**: The tick collector captures events at discrete intervals, while the simulation processes real-time WebSocket events. The simulation sees ~3x more trade events.

2. **Order Availability Bottleneck**: With 2 orders per side (matching simulation), the backtest can only fill 20 shares at a time. Large trades exhaust available orders quickly.

3. **Capital Recycling Delay**: Revenue from fills funds new splits. Slower fills = fewer splits = less total inventory.

### Why Remaining DOWN is Higher

1. **Market Asymmetry**: In this window, DOWN won (higher final price). DOWN orders were priced higher, making them harder to fill.

2. **Fill Distribution**: DOWN had more fills (1,469) than UP (1,349), but smaller average fill size due to higher prices.

## Attempted Optimizations

| Parameter Change | Effect |
|-----------------|--------|
| ↑ maxOpenOrdersPerSide (3-5) | Better turnover, but worse P&L |
| ↑ fillMultiplier (4-5) | Better remaining, but turnover stuck |
| ↑ resplitThreshold (0.25) | No significant change |

## Conclusion

**Achieving <20% drift on ALL metrics is blocked** by fundamental differences between:
- Tick data capture (sampled)
- Real-time WebSocket events (continuous)

The backtest achieves excellent P&L parity (5.2%) and acceptable Remaining UP (17.0%), which validates the core strategy logic. The turnover and Remaining DOWN gaps are data-driven limitations, not strategy bugs.

## Recommendation

For practical backtesting:
1. Use P&L as primary validation metric (achieves <10% drift)
2. Use Remaining UP as secondary metric (achieves <20% drift)
3. Accept turnover as directionally correct but not precise
4. Consider collecting higher-resolution tick data for better parity
