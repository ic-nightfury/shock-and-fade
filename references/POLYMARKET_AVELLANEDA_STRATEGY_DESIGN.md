# Polymarket Avellaneda-Stoikov Market Making Strategy

## Overview

The Avellaneda-Stoikov (A-S) strategy is a mathematically optimal market making approach that dynamically adjusts bid/ask prices based on:
1. **Inventory risk** - Skew prices to reduce position imbalance
2. **Volatility** - Widen spreads in volatile markets
3. **Time horizon** - Adjust aggressiveness based on time remaining

This document adapts the A-S framework from Hummingbot to Polymarket's binary option markets.

---

## Key Differences: Traditional A-S vs Polymarket A-S

| Aspect | Traditional A-S | Polymarket A-S |
|--------|-----------------|----------------|
| **Asset** | Single asset (BTC/USDT) | Two tokens (UP + DOWN) |
| **Goal** | Buy low, sell high | Accumulate pairs at < $1.00 |
| **Inventory** | Base vs Quote balance | UP vs DOWN token balance |
| **Risk** | Price movement | Settlement outcome |
| **Time Horizon** | Continuous | Fixed (15-min windows) |
| **Exit** | Sell position | Merge pairs or settlement |

---

## The Avellaneda-Stoikov Framework

### Core Equations

**1. Reservation Price (r)**

The price at which the market maker is indifferent to holding inventory:

```
r = s - q × γ × σ² × T
```

Where:
- `s` = current mid price
- `q` = inventory position (positive = long, negative = short)
- `γ` = risk aversion parameter (gamma)
- `σ` = volatility (standard deviation of price changes)
- `T` = time remaining (fraction of total window)

**2. Optimal Spread (δ)**

The total spread to place around the reservation price:

```
δ = γ × σ² × T + (2/γ) × ln(1 + γ/κ)
```

Where:
- `κ` = order book depth factor (kappa)
- First term: volatility component
- Second term: liquidity component

**3. Optimal Bid/Ask**

```
optimal_bid = r - δ/2
optimal_ask = r + δ/2
```

---

## Adapting to Polymarket Binary Markets

### The Bilateral Twist

In Polymarket, we're not buying and selling the same asset. Instead:
- We BUY UP tokens (hoping UP wins)
- We BUY DOWN tokens (hoping DOWN wins)
- We MERGE UP+DOWN pairs to lock profit

The A-S framework adapts as:

```
UP_reservation = up_mid - q_up × γ × σ × T
DOWN_reservation = down_mid - q_down × γ × σ × T

optimal_up_bid = UP_reservation - δ/2
optimal_down_bid = DOWN_reservation - δ/2
```

### Inventory Definition

For bilateral markets, inventory imbalance is the difference between UP and DOWN positions:

```python
def calculate_inventory_skew():
    total = up_position + down_position
    if total == 0:
        return 0  # Balanced
    
    # q ranges from -1 (all DOWN) to +1 (all UP)
    q = (up_position - down_position) / total
    return q
```

When `q > 0`: We have more UP than DOWN → lower UP bid, raise DOWN bid
When `q < 0`: We have more DOWN than UP → lower DOWN bid, raise UP bid

### Volatility in Binary Markets

Binary market volatility is measured differently:
- Price bounded between $0.01 and $0.99
- Volatility of UP ≈ volatility of DOWN (inverse correlation)
- Use tick-to-tick price changes, not returns

```python
def calculate_volatility(price_history: list, window: int = 30) -> float:
    """Calculate rolling volatility of price changes."""
    if len(price_history) < window:
        return 0.05  # Default 5% volatility
    
    recent = price_history[-window:]
    changes = [abs(recent[i] - recent[i-1]) for i in range(1, len(recent))]
    return statistics.stdev(changes) if len(changes) > 1 else 0.05
```

### Time Horizon

The 15-minute Polymarket window provides a natural time horizon:

```python
def calculate_time_remaining(m0_timestamp: int) -> float:
    """Returns fraction of time remaining (1.0 at start, 0.0 at end)."""
    now = time.time()
    elapsed = now - m0_timestamp
    total_window = 15 * 60  # 15 minutes
    
    remaining = max(0, total_window - elapsed)
    return remaining / total_window
```

As time approaches settlement:
- `T → 0` reduces the inventory risk term
- Spreads tighten to capture more fills
- More aggressive accumulation in final minutes

---

## Strategy Parameters

### Core A-S Parameters

| Parameter | Description | Polymarket Default |
|-----------|-------------|-------------------|
| `gamma` (γ) | Risk aversion factor | 0.5 |
| `kappa` (κ) | Order book depth factor | 1.5 |
| `volatility_window` | Ticks for volatility calc | 30 |
| `min_spread_pct` | Minimum spread (safety) | 2% |

### Polymarket-Specific Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `target_pair_cost` | Max acceptable pair cost | 0.97 |
| `max_position_per_side` | Position limit per side | 100 |
| `order_refresh_time` | Seconds between refreshes | 10 |
| `fill_window_sec` | Max time between paired fills | 60 |
| `force_balance_minutes` | Force balance before end | 1 |

---

## Implementation

### 1. Calculate Reference Prices

```python
def get_reference_prices(up_bid: float, down_bid: float) -> tuple:
    """
    Use BID prices as reference since that's where we place limits.
    ASK prices typically sum to >$1.00 due to spread.
    """
    # Sanity check
    bid_sum = up_bid + down_bid
    if bid_sum < 0.90 or bid_sum > 1.02:
        log.warning(f"Unusual BID sum: {bid_sum:.2f}")
    
    return up_bid, down_bid
```

### 2. Calculate Inventory Skew

```python
def calculate_inventory_adjustment(
    up_position: float, 
    down_position: float,
    gamma: float,
    volatility: float,
    time_remaining: float
) -> tuple:
    """
    Returns price adjustments for UP and DOWN based on inventory.
    
    Positive adjustment = raise bid (more aggressive)
    Negative adjustment = lower bid (less aggressive)
    """
    total = up_position + down_position
    if total == 0:
        return 0, 0  # No adjustment
    
    # q: positive = excess UP, negative = excess DOWN
    q = (up_position - down_position) / total
    
    # Inventory adjustment factor
    inventory_term = q * gamma * volatility * time_remaining
    
    # When excess UP (q > 0):
    #   - Lower UP bid (buy less UP)
    #   - Raise DOWN bid (buy more DOWN)
    up_adjustment = -inventory_term
    down_adjustment = inventory_term
    
    return up_adjustment, down_adjustment
```

### 3. Calculate Optimal Spread

```python
def calculate_optimal_spread(
    gamma: float,
    kappa: float,
    volatility: float,
    time_remaining: float,
    min_spread_pct: float = 0.02
) -> float:
    """
    Avellaneda-Stoikov optimal spread calculation.
    """
    import math
    
    # Volatility component
    vol_term = gamma * volatility * time_remaining
    
    # Liquidity component
    if gamma > 0 and kappa > 0:
        liq_term = (2 / gamma) * math.log(1 + gamma / kappa)
    else:
        liq_term = 0.05  # Default 5%
    
    optimal_spread = vol_term + liq_term
    
    # Enforce minimum spread
    return max(optimal_spread, min_spread_pct)
```

### 4. Generate Order Proposals

```python
def create_avellaneda_proposals(
    up_bid: float,
    down_bid: float,
    up_position: float,
    down_position: float,
    gamma: float,
    kappa: float,
    volatility: float,
    time_remaining: float,
    order_size: float,
    target_pair_cost: float
) -> list:
    """
    Generate limit order proposals using A-S framework.
    """
    proposals = []
    
    # Step 1: Get inventory adjustments
    up_adj, down_adj = calculate_inventory_adjustment(
        up_position, down_position, gamma, volatility, time_remaining
    )
    
    # Step 2: Calculate optimal spread
    spread = calculate_optimal_spread(gamma, kappa, volatility, time_remaining)
    half_spread = spread / 2
    
    # Step 3: Calculate reservation prices (mid adjusted for inventory)
    up_reservation = up_bid + up_adj
    down_reservation = down_bid + down_adj
    
    # Step 4: Calculate optimal bid prices
    up_limit = round(up_reservation - half_spread, 2)
    down_limit = round(down_reservation - half_spread, 2)
    
    # Enforce minimum price
    up_limit = max(0.01, up_limit)
    down_limit = max(0.01, down_limit)
    
    # Step 5: Check pair cost constraint
    pair_cost = up_limit + down_limit
    if pair_cost <= target_pair_cost:
        proposals.append({
            'up_price': up_limit,
            'down_price': down_limit,
            'size': order_size,
            'pair_cost': pair_cost,
            'spread': spread,
            'up_adjustment': up_adj,
            'down_adjustment': down_adj
        })
    
    return proposals
```

### 5. Adaptive Gamma (Risk Aversion)

```python
def calculate_adaptive_gamma(
    base_gamma: float,
    time_remaining: float,
    current_pnl: float,
    drawdown_threshold: float = -0.05
) -> float:
    """
    Dynamically adjust gamma based on conditions.
    
    - Lower gamma as time runs out (more aggressive)
    - Higher gamma if in drawdown (more conservative)
    """
    # Time decay: become more aggressive as time runs out
    time_factor = 0.5 + 0.5 * time_remaining  # 1.0 at start, 0.5 at end
    
    # Drawdown protection: become more conservative if losing
    if current_pnl < drawdown_threshold:
        drawdown_factor = 1.5  # 50% more conservative
    else:
        drawdown_factor = 1.0
    
    return base_gamma * time_factor * drawdown_factor
```

---

## Main Loop

```python
async def run_avellaneda_strategy(config: dict):
    """
    Main trading loop using Avellaneda-Stoikov framework.
    """
    m0_ts = get_market_start_timestamp()
    price_history_up = []
    price_history_down = []
    
    while True:
        # 1. Get current market state
        up_bid, up_ask = get_order_book('UP')
        down_bid, down_ask = get_order_book('DOWN')
        
        # 2. Update price history for volatility
        price_history_up.append(up_bid)
        price_history_down.append(down_bid)
        
        # 3. Calculate volatility (average of both sides)
        vol_up = calculate_volatility(price_history_up)
        vol_down = calculate_volatility(price_history_down)
        volatility = (vol_up + vol_down) / 2
        
        # 4. Calculate time remaining
        time_remaining = calculate_time_remaining(m0_ts)
        
        if time_remaining <= 0:
            break  # Market ended
        
        # 5. Get current positions
        up_pos = get_token_balance('UP')
        down_pos = get_token_balance('DOWN')
        
        # 6. Adaptive gamma
        gamma = calculate_adaptive_gamma(
            config['gamma'], time_remaining, get_current_pnl()
        )
        
        # 7. Generate proposals using A-S
        proposals = create_avellaneda_proposals(
            up_bid, down_bid,
            up_pos, down_pos,
            gamma, config['kappa'],
            volatility, time_remaining,
            config['order_size'],
            config['target_pair_cost']
        )
        
        # 8. Execute orders
        if proposals:
            await execute_proposals(proposals)
        
        # 9. Check for merge opportunity
        await check_and_merge(config['merge_threshold'])
        
        # 10. Force balance near end
        if time_remaining < config['force_balance_minutes'] / 15:
            await force_balance_and_merge()
            break
        
        # 11. Wait for next refresh
        await asyncio.sleep(config['order_refresh_time'])
```

---

## Comparison: BiMM vs Avellaneda

| Feature | BiMM (Simple) | Avellaneda |
|---------|---------------|------------|
| **Spread Calculation** | Fixed % from BID | Dynamic based on volatility |
| **Inventory Management** | Fixed skew multiplier | Mathematical optimization |
| **Time Awareness** | None | Spreads tighten as T→0 |
| **Volatility Response** | None | Wider spreads in volatile markets |
| **Complexity** | Low | Medium |
| **Parameters** | 3-4 | 5-7 |

### When to Use Avellaneda

1. **High volatility markets** - A-S adapts spreads automatically
2. **Inventory imbalances** - Mathematical skew is more precise
3. **Time-critical windows** - Better end-of-window behavior
4. **Larger position sizes** - Better risk management

### When to Use BiMM

1. **Simple implementation** - Fewer parameters to tune
2. **Low volatility** - Fixed spread is sufficient
3. **Smaller sizes** - Overhead not worth it
4. **Testing/Development** - Easier to debug

---

## Backtest Results

### Gamma Sensitivity (200 markets, kappa=0.5)

| Gamma | Markets | Pairs | Profit | $/Pair | Spread |
|-------|---------|-------|--------|--------|--------|
| 0.05 | 175 | 8,850 | $431 | +4.87c | 4.0% |
| 0.10 | 175 | 8,840 | $430 | +4.86c | 4.0% |
| 0.20 | 174 | 8,830 | $430 | +4.87c | 4.0% |
| 0.50 | 173 | 8,460 | $416 | +4.92c | 4.3% |

**Finding**: Gamma has minimal impact in the 0.05-0.20 range. Lower gamma = slightly more volume.

### Kappa Sensitivity (gamma=0.10)

| Kappa | Markets | Pairs | Profit | $/Pair |
|-------|---------|-------|--------|--------|
| 0.20 | 160 | 5,510 | $377 | +6.84c |
| 0.50 | 175 | 8,840 | $430 | +4.86c |
| 0.70 | 177 | 9,310 | $440 | +4.72c |
| 1.00 | 177 | 9,690 | $432 | +4.45c |

**Finding**: Higher kappa = tighter spreads = more volume but lower profit per pair. Optimal around κ=0.70.

### Avellaneda vs Simple BiMM Comparison

| Strategy | Markets | Pairs | Total Profit | $/Pair | Pair Cost |
|----------|---------|-------|--------------|--------|-----------|
| **Avellaneda (γ=0.10, κ=0.5)** | 175 | 8,840 | **$429.90** | +4.86c | 95.1c |
| **Simple BiMM (10% spread)** | 144 | 4,150 | $384.90 | +9.27c | 90.7c |

**Key Insight**: Avellaneda generates **12% more total profit** by:
- Trading more markets (175 vs 144)
- Completing more pairs (8,840 vs 4,150)
- Using tighter, dynamic spreads (4% vs 10%)

Simple BiMM has higher per-pair profit (+9.27c vs +4.86c) but trades less frequently.

### When to Use Each Strategy

| Use Avellaneda When | Use Simple BiMM When |
|---------------------|---------------------|
| Maximizing total profit | Maximizing per-trade profit |
| High-frequency trading | Limited capital |
| Dynamic market conditions | Stable, predictable markets |
| Want adaptive behavior | Want simplicity |

## Expected Performance

Based on backtest results:

| Metric | Avellaneda | Simple BiMM |
|--------|------------|-------------|
| **Pair cost** | 95.1c | 90.7c |
| **Profit/pair** | +4.86c | +9.27c |
| **Pairs/market** | ~50 | ~29 |
| **Total profit** | +12% higher | Baseline |

---

## Configuration Template

```yaml
# Avellaneda-Stoikov Configuration for Polymarket
# Optimized from backtest results (Dec 2024)

strategy:
  name: "avellaneda_bilateral"
  
  # Core A-S parameters (CALIBRATED for 0-1 price range)
  gamma: 0.10             # Risk aversion - lower = tighter spreads
  kappa: 0.70             # Order book depth - higher = more volume
  
  # Spread bounds
  min_spread_pct: 0.03    # 3% minimum spread
  max_spread_pct: 0.20    # 20% maximum spread
  
  # Volatility
  volatility_window: 20   # Ticks for volatility calculation
  volatility_floor: 0.02  # Minimum 2% volatility assumption
  volatility_multiplier: 2.0  # Scale volatility impact on spread
  
  # Time management
  order_refresh_time: 10  # Seconds between order refreshes
  fill_window_sec: 60     # Max time for paired fills
  force_balance_minutes: 1  # Force balance before end
  
  # Polymarket-specific
  target_pair_cost: 0.97
  order_size: 10
  max_position_per_side: 100
  
  # Merge settings
  merge_threshold: 10
  merge_check_interval: 30
```

### Alternative Configurations

**High Volume (more trades, lower profit/trade):**
```yaml
gamma: 0.05
kappa: 1.0
min_spread_pct: 0.03
```

**High Profit Per Trade (fewer trades, higher margin):**
```yaml
gamma: 0.20
kappa: 0.30
min_spread_pct: 0.05
```

---

## Implementation Notes

### 1. Volatility Estimation

Polymarket has unique volatility characteristics:
- Prices bounded [0.01, 0.99]
- Inverse correlation between UP and DOWN
- Volatility spikes near M0 and settlement

Recommended approach: Use absolute price changes, not returns.

### 2. Order Book Depth (κ)

Estimating κ from Polymarket order book:
```python
def estimate_kappa(order_book: dict) -> float:
    """
    Estimate order book depth factor from current book.
    Higher kappa = deeper book = tighter spreads possible.
    """
    total_depth = sum(level['size'] for level in order_book['bids'][:5])
    total_depth += sum(level['size'] for level in order_book['asks'][:5])
    
    # Normalize to kappa range [0.5, 3.0]
    kappa = min(3.0, max(0.5, total_depth / 1000))
    return kappa
```

### 3. Fill Matching

Critical for bilateral strategy:
- Track which side fills first
- Cancel unfilled side if timeout
- Only count balanced pairs for profit

```python
class FillTracker:
    def __init__(self, fill_window: int = 60):
        self.pending_up = None  # (price, timestamp)
        self.pending_down = None
        self.fill_window = fill_window
    
    def on_fill(self, side: str, price: float, timestamp: int):
        if side == 'UP':
            self.pending_up = (price, timestamp)
        else:
            self.pending_down = (price, timestamp)
        
        # Check for complete pair
        if self.pending_up and self.pending_down:
            pair_cost = self.pending_up[0] + self.pending_down[0]
            self.pending_up = None
            self.pending_down = None
            return pair_cost  # Return pair cost for profit tracking
        
        return None
    
    def check_timeout(self, current_time: int):
        # Cancel pending single fills that timed out
        if self.pending_up:
            if current_time - self.pending_up[1] > self.fill_window:
                self.pending_up = None
                return 'UP_TIMEOUT'
        
        if self.pending_down:
            if current_time - self.pending_down[1] > self.fill_window:
                self.pending_down = None
                return 'DOWN_TIMEOUT'
        
        return None
```

---

## Next Steps

1. **Implement StrategyAvellaneda.ts** in trading_bot
2. **Backtest** with tick data to validate A-S parameters
3. **Compare** to BiMM on same market data
4. **Paper trade** with small sizes
5. **Optimize** gamma/kappa based on live results

---

## References

- Avellaneda, M., & Stoikov, S. (2008). "High-frequency trading in a limit order book"
- Hummingbot Avellaneda Strategy: `hummingbot/strategy/avellaneda_market_making/`
- Polymarket CLOB API: https://docs.polymarket.com
