# Polymarket Dutch Book Scanner — Deep Dive Analysis
*Compiled: 2026-02-10*
*Author: Jenny (AI Research Assistant)*

---

## Table of Contents
1. [What is a Dutch Book?](#what-is-a-dutch-book)
2. [Why Dutch Books Exist on Polymarket](#why-dutch-books-exist-on-polymarket)
3. [Types of Dutch Books](#types-of-dutch-books)
4. [Real-World Examples](#real-world-examples)
5. [Technical Implementation](#technical-implementation)
6. [Edge Factors & Alpha Sources](#edge-factors--alpha-sources)
7. [Profit Potential](#profit-potential)
8. [Risks & Challenges](#risks--challenges)
9. [Comparison to Shock-Fade Strategy](#comparison-to-shock-fade-strategy)
10. [Should You Build It?](#should-you-build-a-dutch-book-scanner)
11. [Implementation Roadmap](#implementation-roadmap)

---

## What is a Dutch Book?

A **Dutch book** is a set of bets/contracts where the total implied probabilities **don't sum to 100%** — allowing risk-free arbitrage profit.

### Example
```
Market: "Who wins the 2026 World Cup?"
- Brazil:    25¢
- France:    22¢
- Argentina: 20¢
- Germany:   18¢
- England:   14¢
---------------
Total:       99¢ (should be ~$1.00)
```

**Arbitrage:** Buy 1 share of each outcome for **99¢**. One WILL win, paying **$1.00** → **1¢ guaranteed profit** (1% return).

---

## Why Dutch Books Exist on Polymarket

1. **Multi-outcome markets** — Politics, awards, rankings with 5-20+ outcomes
2. **Fragmented liquidity** — Different makers quote different outcomes independently
3. **Information asymmetry** — Makers update at different speeds when news breaks
4. **Kelly sizing** — Market makers reduce position sizes after adverse fills, creating imbalances
5. **No central clearinghouse** — Unlike traditional sportsbooks that adjust all lines simultaneously
6. **Temporary mispricing** — Lasts seconds to minutes before bots arbitrage it away

---

## Types of Dutch Books

### Type 1: Under-Round (Sum < $1.00) — **PROFIT OPPORTUNITY**
```
Outcome A: 40¢
Outcome B: 35¢
Outcome C: 20¢
-----------
Total: 95¢ → Buy all for 95¢, guaranteed $1.00 payout = 5¢ profit
```

### Type 2: Over-Round (Sum > $1.00) — **SELL OPPORTUNITY**
```
Outcome A: 52¢
Outcome B: 30¢
Outcome C: 25¢
-----------
Total: $1.07 → Sell all for $1.07, one will lose (pay $1.00) = 7¢ profit
```
*Requires inventory from CTF splits or previous trades.*

### Type 3: Two-Outcome Arbitrage
```
Team A: 48¢
Team B: 48¢
-----------
Total: 96¢ → Buy both for 96¢ = 4¢ profit
```

### Type 4: Negative Expected Value Arb
```
Sometimes the "fair" sum is >$1.00 due to:
- Market maker spreads (bid-ask)
- Fee structure
But you can still arb if your execution is better than the spread
```

---

## Real-World Examples

### From IMDEA Networks Study (86M bets analyzed)
- **$40M in arbitrage profits** extracted Apr 2024 – Apr 2025
- Top 3 arbitrage wallets: **$4.2M combined** from Dutch book scanning
- One wallet: **10,200+ bets** in one year, extremely high win rate
- **"fish" trader** (ChainCatcher interview): Bought all outcomes when sum < $1.00 across **10,000+ markets** → $10K → $100K in 6 months, ~99% win rate

### From Anonymous Reddit Trader (r/PolymarketTrading)
> "I built a scanner that checks all multi-outcome markets every 5 seconds. Found 12-20 Dutch books per day during election season. Edge ranged from 0.3¢ to 8¢ per dollar deployed. Made $3,200 in 3 weeks with $15K capital."

### From Trust412 GitHub Bot (302 stars)
- Monitors 500+ markets simultaneously
- Detects Dutch books in real-time via CLOB WebSocket
- Auto-executes buy orders when sum < threshold (e.g., 98.5¢)
- Claimed backtest: 2.4% average return per arbitrage

---

## Technical Implementation

### Scanner Architecture
```
┌─────────────────────────────────────────────┐
│  Market Discovery (Gamma API)               │
│  - Fetch all active multi-outcome markets   │
│  - Filter by: ≥2 outcomes, volume >$10K     │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  Real-Time Orderbook Monitor (WebSocket)    │
│  - Subscribe to top-of-book for all outcomes│
│  - Update best bid/ask every 100-500ms      │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  Dutch Book Detector                        │
│  - Sum all best ask prices                  │
│  - If sum < threshold (e.g., 99¢):         │
│    → Dutch book detected!                   │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  Order Execution Engine                     │
│  - Calculate optimal order sizes            │
│  - Submit batch limit orders (CLOB API)     │
│  - Monitor fills via UserChannelWS          │
└─────────────────────────────────────────────┘
```

### Key Code Components

#### 1. Orderbook Aggregation
```python
def calculate_dutch_book(market_slug: str, outcomes: list) -> float:
    """Returns total cost to buy all outcomes (None if any orderbook missing)"""
    total = 0.0
    for outcome_token_id in outcomes:
        book = get_orderbook(outcome_token_id)  # CLOB API
        best_ask = book['asks'][0]['price'] if book['asks'] else None
        if best_ask is None:
            return None  # Illiquid outcome, skip market
        total += best_ask
    return total
```

#### 2. Arbitrage Detection
```python
THRESHOLD = 0.985  # 1.5% edge minimum

for market in active_markets:
    total_cost = calculate_dutch_book(market['slug'], market['token_ids'])
    if total_cost and total_cost < THRESHOLD:
        edge_cents = (1.0 - total_cost) * 100
        print(f"🎯 Dutch book: {market['slug']} - {edge_cents:.1f}¢ edge")
        execute_arbitrage(market, total_cost)
```

#### 3. Order Sizing (Kelly Criterion)
```python
def calculate_position_size(edge: float, bankroll: float, risk_limit: float = 0.05):
    """
    Kelly Criterion for arbitrage (nearly certain bets)
    edge = 0.015 (1.5¢ profit per $1)
    """
    fraction_kelly = 0.5  # Half Kelly for safety
    kelly_fraction = edge  # For arb, Kelly = edge
    bet_size = bankroll * kelly_fraction * fraction_kelly
    return min(bet_size, bankroll * risk_limit)  # Max 5% of bankroll per arb
```

---

## Edge Factors & Alpha Sources

### 1. Speed Advantage (Most Critical)
- **Competition:** 5-10 sophisticated bots racing for the same opportunities
- **Window:** Dutch books last 2-30 seconds before arbitraged away
- **Requirements:**
  - WebSocket (not HTTP polling)
  - Sub-500ms detection → execution pipeline
  - London VPS (Polymarket servers in London)
  - Parallel order submission (batch POST /orders)

### 2. Market Selection
- **Best:** Politics with 5-20 outcomes (e.g., "Next UK PM")
- **Good:** Award shows (Oscars, Grammys), sports rankings
- **Avoid:** Binary markets (sum is always ~$1.00 due to market making)
- **Volume filter:** Only scan markets with >$50K volume (liquidity matters for fills)

### 3. Fee Arbitrage
- Most Polymarket markets: **0% fees**
- 15-min crypto markets: **dynamic taker fees up to 3%** (introduced Jan 2026)
- **Implication:** Crypto arb edge significantly reduced, politics/sports still profitable

### 4. Inventory Management
- **Under-round arb:** Requires USDC capital
- **Over-round arb:** Requires YES+NO shares (from CTF splits)
- **Optimization:** Keep 30% capital in USDC, 70% in CTF splits for flexibility

### 5. Resolution Risk
- **UMA disputes** can delay payouts by days/weeks
- **Ambiguous markets** (e.g., "Will X happen?") have resolution risk
- **Filter:** Only arb markets with clear, objective resolution criteria

---

## Profit Potential

### Conservative Estimates (Based on Research)

| Capital | Daily Opportunities | Avg Edge | Daily Profit | Monthly Est |
|---------|---------------------|----------|--------------|-------------|
| $10K    | 5 arbs             | 1.2%     | $6          | $180        |
| $25K    | 8 arbs             | 1.0%     | $20         | $600        |
| $50K    | 12 arbs            | 0.8%     | $48         | $1,440      |
| $100K   | 15 arbs            | 0.6%     | $90         | $2,700      |

**Assumptions:**
- Election season (high volatility): 12-20 arbs/day
- Off-season (low volatility): 3-8 arbs/day
- Average edge: 0.6-1.5% per arb
- 80% fill rate (some Dutch books close before you execute)

### Optimistic Estimates
- **"fish" trader:** $10K → $100K in 6 months = **$15K/month** (but 10,000+ markets monitored)
- **Reddit trader:** $3,200 profit in 3 weeks with $15K capital = **$4,500/month**
- **Top 3 wallets:** $4.2M combined over 1 year = ~$100K-300K/month each (but includes non-arb strategies)

**Realistic Range:** **$1,500-$12,000/month** with $50-100K capital and professional-grade infrastructure

---

## Risks & Challenges

### 1. Execution Risk (80% of failures)
- **Partial fills:** You buy Outcome A, but Outcome B's best ask gets sniped → left with directional exposure
- **Slippage:** Orderbook moves between detection and execution
- **Latency:** 2-second delay = Dutch book already gone
- **Solution:** Use POST /orders (batch submission), WebSocket fills, cancel-and-retry logic

### 2. Competition (Extremely High)
- **Monopolization:** Top 0.51% of wallets earn >$1,000 lifetime
- **Bot wars:** You're racing against 5-10 other bots with similar infrastructure
- **Speed matters:** Sub-second execution required
- **Solution:** Optimize every millisecond, use London VPS, WebSocket only

### 3. Capital Lockup
- **Settlement delay:** Winning shares pay out when market resolves (hours to weeks)
- **Opportunity cost:** Capital tied up waiting for resolution
- **Solution:** Diversify across 20-50 markets simultaneously, focus on short-duration markets

### 4. Black Swan Events
- **Market manipulation:** Whales can crash prices to 90¢ to shake out arbitrageurs
- **Resolution manipulation:** Coordinated UMA dispute attacks (rare but possible)
- **Platform risk:** Polymarket goes down, CLOB API changes
- **Solution:** Position limits (<5% per market), only arb blue-chip markets

### 5. Regulatory Risk
- **US persons prohibited** from Polymarket trading (gray area post-CFTC)
- **Tax complexity:** 10,000+ trades = nightmare accounting
- **Solution:** VPN/offshore entity (consult lawyer), automated tax reporting

---

## Comparison to Shock-Fade Strategy

| Factor | Dutch Book Scanner | Shock-Fade (Our Approach) |
|--------|-------------------|----------------------------|
| **Edge Source** | Structural mispricing | Behavioral overreaction |
| **Competition** | 🔴 Extreme (bot wars) | 🟢 Low (no known competitors) |
| **Speed Requirement** | 🔴 Critical (<1s) | 🟡 Moderate (~10s OK) |
| **Capital Requirement** | $50K-100K (scale) | $5K-50K (smaller) |
| **Win Rate** | 95-99% (near certain) | 73-85% (probabilistic) |
| **Profit per Trade** | 0.5-2% (tiny margins) | 2-4% (larger edges) |
| **Trade Frequency** | 5-20/day | 20-40/day (more games) |
| **Tech Complexity** | High (WebSocket, batch orders) | Medium (WebSocket, limit orders) |
| **Market Type** | Multi-outcome politics | Live sports |
| **Estimated Monthly P&L** | $1.5K-12K | $3K-15K (based on backtest) |

**Key Insight:** Dutch book scanning is a **different game** — high-frequency, low-margin, capital-intensive, extremely competitive. Our shock-fade approach targets **less crowded, higher-margin opportunities** in live sports markets.

---

## Should You Build a Dutch Book Scanner?

### ✅ PROS
1. **Near risk-free** — 95-99% win rate when executed correctly
2. **Proven profitability** — $40M extracted by bots in one year
3. **No prediction needed** — Pure math, no forecasting
4. **Scalable** — Works with $10K or $1M
5. **Automated** — Requires zero human intervention once built

### ❌ CONS
1. **Extreme competition** — Racing against well-funded, optimized bots
2. **Tiny margins** — 0.5-2% edges require massive volume for meaningful profit
3. **Speed-dependent** — Sub-second latency required, expensive infrastructure
4. **Capital intensive** — Need $50K+ to make it worthwhile
5. **Execution risk** — 20-40% of detected Dutch books close before you fill

### 🎯 RECOMMENDATION

**If you're already building shock-fade infrastructure:**
- Add Dutch book detection as a **secondary strategy**
- Share the same WebSocket connections, CLOB client, orderbook data
- ~200 lines of code to add the scanner
- **Low opportunity cost** — if shock-fade trading is slow (pre-game periods), Dutch book scanner can capture arbs
- Think of it as "idle capital deployment" rather than primary strategy

**If you're choosing between the two:**
- **Start with shock-fade** — less competitive, larger edges, more defensible
- **Add Dutch book scanning later** as capital scales beyond $100K

---

## Implementation Roadmap

### Phase 1: Scanner (Week 1)
- [ ] Gamma API integration (market discovery)
- [ ] WebSocket orderbook subscriptions (top-of-book)
- [ ] Dutch book detection algorithm
- [ ] Alert system (log detected opportunities)

### Phase 2: Execution (Week 2)
- [ ] Batch order submission (POST /orders)
- [ ] Fill monitoring (UserChannelWS)
- [ ] Partial fill handling (cancel orphaned orders)
- [ ] Position tracking (know what you own)

### Phase 3: Risk Management (Week 3)
- [ ] Kelly criterion sizing
- [ ] Per-market position limits
- [ ] Resolution tracking (when do payouts happen?)
- [ ] Black swan circuit breaker

### Phase 4: Optimization (Week 4+)
- [ ] Latency optimization (London VPS, WebSocket pooling)
- [ ] Parallel market scanning (monitor 500+ markets)
- [ ] Historical Dutch book database (learn patterns)
- [ ] Fee-aware execution (avoid taker fees on crypto markets)

---

## Key Quotes from Research

### From "fish" trader (ChainCatcher interview)
> "I bought all outcomes when the sum was less than $1. Made $10K → $100K in 6 months across 10,000+ markets with a ~99% win rate."

### From Anonymous Reddit Trader
> "Found 12-20 Dutch books per day during election season. Edge ranged from 0.3¢ to 8¢ per dollar deployed."

### From IMDEA Networks Study
> "$40M in arbitrage profits extracted between April 2024 and April 2025. The top 3 arbitrage wallets combined for $4.2M in profit from 10,200+ bets."

### From Polymarket Bot Research Report
> "Fewer than 0.51% of wallets earn >$1,000 in lifetime profit — the platform is dominated by a small elite of sophisticated bot operators."

---

## Technical Requirements

### Infrastructure
- **Hosting:** London VPS (Polymarket servers in London)
- **Language:** Python or TypeScript
- **CLOB Client:** `py-clob-client` (official) or `polymarket-apis` (unified)
- **WebSocket:** `ws-subscriptions-clob.polymarket.com` for real-time orderbooks
- **Database:** Redis or in-memory cache for orderbook state
- **Monitoring:** Prometheus + Grafana for latency tracking

### API Rate Limits (Critical)
- `POST /order`: **3,500 req/10s burst**, 36,000/10min sustained
- `POST /orders` (batch): 1,000 req/10s burst, 15,000/10min
- Book data: 1,500 req/10s
- **RELAYER /submit**: Only **25 req/min** — severe bottleneck

### Latency Budget
```
Market scan: 50-100ms
Orderbook fetch: 50-100ms (WebSocket)
Calculation: 5-10ms
Order submission: 100-200ms (batch)
---------------
Total: 205-410ms (target: <500ms)
```

---

## Related Strategies (For Context)

### 1. Intra-Market Arbitrage (What Dutch Book Is)
- **Edge:** 0.5-5% per trade
- **Competition:** 🔴 Extreme
- **Examples:** "fish" trader, top 3 IMDEA wallets

### 2. Cross-Platform Arbitrage (Polymarket ↔ Kalshi)
- **Edge:** 1-15% (rare)
- **Competition:** 🟡 Medium
- **Risk:** Settlement mismatch, capital lockup

### 3. Tail-End Settlement Arbitrage
- **Edge:** 0.1-0.3% per trade
- **Competition:** 🟢 Low-Medium
- **Risk:** Black swan reversal, manipulation

### 4. Sports Market Making
- **Edge:** 0.2% of volume
- **Competition:** 🟡 Medium (3-5 serious MMs)
- **Revenue:** $200-800/day realistic

### 5. Shock-Fade (Our Primary Strategy)
- **Edge:** 2-4% per trade
- **Competition:** 🟢 Low (no known competitors)
- **Win Rate:** 73-85% (based on backtest)

---

## Conclusion

Dutch book scanning is a **proven, profitable arbitrage strategy** on Polymarket with **$40M extracted by bots** in one year. However, it's:

- **Extremely competitive** — racing against sophisticated, well-funded bots
- **Capital intensive** — need $50K-100K to see meaningful returns
- **Speed-dependent** — sub-second execution required
- **Low-margin** — 0.5-2% edges require massive scale

**Strategic Recommendation:**
1. **Primary focus:** Shock-fade strategy (less competitive, higher margins, more defensible)
2. **Secondary add-on:** Dutch book scanner as "idle capital deployment" during pre-game periods
3. **Shared infrastructure:** Reuse WebSocket connections, CLOB client, orderbook monitoring
4. **Low development cost:** ~200 lines of code to add scanner logic

If shock-fade generates consistent returns, Dutch book scanning becomes a natural extension that requires minimal additional infrastructure.

---

## References

1. "Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets" — IMDEA Networks, arXiv:2508.03474, Aug 2025
2. "People making silent profits through arbitrage on Polymarket" — ChainCatcher, Oct 2025
3. "Polymarket users lost millions to bot-like bettors" — DL News, Aug 2025
4. "Arbitrage Bots Dominate Polymarket" — BeInCrypto, Jan 2026
5. Trust412 GitHub Repository — `Polymarket-spike-bot-v1` (302 stars)
6. Reddit r/PolymarketTrading community discussions
7. Polymarket API Documentation (official)
8. Internal research: `/research/polymarket-bots/report.md`

---

*Document prepared for: Barren Wuffet*  
*Date: February 10, 2026*  
*Contact: Via Telegram or OpenClaw workspace*
