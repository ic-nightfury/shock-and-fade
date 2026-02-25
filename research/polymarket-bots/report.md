# Profitable Polymarket Trading Bots — Comprehensive Research Report
*Compiled 2026-02-09 | Sources: Moltbook, academic papers, interviews, Reddit, Twitter/X, GitHub*

---

## Executive Summary

The Polymarket bot ecosystem is a rapidly maturing, fiercely competitive landscape. Between April 2024 and April 2025 alone, automated traders extracted **~$40 million in arbitrage profits** (IMDEA Networks study, 86M bets analyzed). Fewer than **0.51% of wallets** earn >$1,000 in lifetime profit — the platform is dominated by a small elite of sophisticated bot operators.

**Key takeaways for our shock-fade bot:**
1. **Sports markets are under-exploited by bots** — most bot profits come from crypto 15-min markets and political event arb. Sports in-game trading is a less crowded niche.
2. **The anonymous sports market maker (Polymarket Oracle interview) is our closest competitor** — runs millions in volume across NFL/NBA/MLB, earns $60-65K/month, uses Pinnacle as fair-value oracle, and explicitly says **basketball is easier to MM than football/hockey because singular events don't move prices as much.**
3. **Our shock-fade approach is distinct from all documented strategies** — nobody publicly discusses in-game shock/fade or mean-reversion on live sports markets. Confirmed by both Moltbook research (zero results) and broader web research.
4. **Polymarket enforces a 500ms intentional delay on taker orders** — this protects makers and is critical for our limit-order-based approach.
5. **Polymarket's Sports WebSocket API** provides real-time scores/periods, but top bots likely use faster external feeds (Sportradar, etc.) — ~4s delay from score change to first Polymarket price movement observed by community members.

---

## 1. Moltbook Community Insights on Polymarket Bots

*(From our prior Moltbook scrape — see `/research/moltbook-intel/findings.md`)*

### Key Moltbook Findings (Previously Captured)
- **Drew's backtest**: Mean reversion shows **+4.7% edge** on Polymarket (60K OrderFilled events). Momentum is **-8.4% (losing strategy).**
- **MoltQuant's Price Zone Theory**: Mean-reversion strongest near extremes (80-95¢ or 5-20¢). Momentum works in the 40-60¢ middle range.
- **Anti-Hype Whale**: $3.92M profit, 99% football, always betting NO on favorites. 32,000+ trades.
- **AnonPunk's 15-min Bot**: Momentum-based fair value model, +5pp accuracy edge vs Polymarket consensus.
- **Nobody on Moltbook discusses shock-fade or in-game live trading.** Zero results for shock, fade, in-play, overreaction, spike detection.

### Additional Moltbook Context
- Moltbook is an **AI-agent-only social network** (moltbook.com) — the site requires JS rendering and now shows a "coming next" landing page. Content may have been taken down or moved behind auth.
- The community includes sophisticated quant agents (Drew, MoltQuant, Dennis, BenderRodriguez) who share strategies openly.
- **BenderRodriguez's insight**: "The real alpha isn't the model — it's the pipeline. If your scraper lags by 30 seconds, your model is worthless."

---

## 2. Known Profitable Bot Operators

### Tier 1: Verified High-Profit Bot Operators

| Operator/Wallet | Strategy | Estimated P&L | Win Rate | Notes |
|---|---|---|---|---|
| **"ilovecircle"** | AI neural network, cross-niche arbitrage | **$2.2M in 2 months** | 74% | Trades politics, sports, crypto. Retrains models continuously. Neural network evaluates outcomes. |
| **Anonymous Sports MM** (Polymarket Oracle interview) | Sports market making | **$60-65K/month** | N/A | NFL/NBA/MLB. Up to $300K in play on NFL Sunday. Uses Pinnacle as fair-value oracle. |
| **$313→$414K Bot** (Dexter's Lab) | Latency arbitrage on 15-min crypto markets | **$414K in 1 month** | 98% | BTC/ETH/SOL 15-min up/down. Exploits price feed latency vs Binance/Coinbase. |
| **@defiance_cr** | Automated market making + liquidity rewards | **$700-800/day at peak** | N/A | Open-sourced bot (github.com/warproxxx/poly-maker). Started with $10K. |
| **Top 3 Arb Wallets** (IMDEA study) | Multi-market arbitrage | **$4.2M combined** | Very high | 10,200+ bets combined in one year. Bot-like trading patterns. |
| **"fish"** (ChainCatcher interview) | Tail-end + multi-outcome arbitrage | **$10K→$100K in 6 months** | ~99% | 10,000+ markets. Buys all outcomes when sum < $1. |

### Tier 2: Notable Wallet Addresses (Public)
- `0xd218e474776403a330142299f7796e8ba32eb5c9` — 7-day volume $951K, PnL $900K, 65% WR
- `0xee613b3fc183ee44f9da9c05f53e2da107e3debf` — 7-day volume $1.4M, PnL $1.3M, 52% WR
- **"gmanas"** — Football whale, $166K-$238K single positions
- **"President Biden" (Taras)** — Professional poker player, clear edge on World Cup games
- **$3.92M anti-hype whale** (TonyZH analysis) — 99% football, contrarian NO on favorites

### Aggregate Statistics
- **$40M** total arbitrage profits extracted Apr 2024 – Apr 2025 (IMDEA study)
- **Top 0.51%** of wallets earn >$1,000 lifetime
- **Top 1.74%** have trading volume >$50,000
- **77% of users** have <50 trades total
- Market makers collectively earned **>$20M** in the past year (DeFiGuyLuke estimate)

---

## 3. Bot Architecture and Technology

### Standard Tech Stack
| Component | Common Choice |
|---|---|
| **Language** | Python (dominant), TypeScript |
| **CLOB Client** | `py-clob-client` (official), `polymarket-apis` (PyPI unified) |
| **Order Signing** | `python-order-utils`, EIP-712 signatures |
| **Real-time Data** | WebSocket (`ws-subscriptions-clob.polymarket.com`) |
| **Sports Scores** | `wss://sports-api.polymarket.com/ws` (official), Sofascore WS, Sportradar |
| **AI/ML** | LangChain, ChromaDB (RAG), LightGBM, neural nets |
| **Hosting** | QuantVPS, NYC/London VPS for low latency |
| **Blockchain** | Polygon network, web3.py |

### Official Open-Source Repositories
1. **`Polymarket/py-clob-client`** — Python CLOB client (official)
2. **`Polymarket/poly-market-maker`** — Market maker keeper, Bands + AMM strategies
3. **`Polymarket/agents`** — Official AI agent framework (LangChain + ChromaDB)
4. **`Polymarket/real-time-data-client`** — WebSocket client

### Community Open-Source Bots
1. **`warproxxx/poly-maker`** — @defiance_cr's market making bot (Google Sheets config)
2. **`Trust412/Polymarket-spike-bot-v1`** — Spike detection + trade execution (302 stars)
3. **`0xalberto/polymarket-arbitrage-bot`** — Single + multi-market arb scanner
4. **`runesatsdev/polymarket-arbitrage-bot`** — NegRisk + whale tracking
5. **`CarlosIbCu/polymarket-kalshi-btc-arbitrage-bot`** — Cross-platform Polymarket/Kalshi arb
6. **`gabagool222/15min-btc-polymarket-trading-bot`** — 15-min BTC latency arb
7. **`terrytrl100/polymarket-automated-mm`** — Fork of poly-maker with enhancements

### API Rate Limits (Critical for Bot Design)

**CLOB Trading Endpoints:**
- `POST /order`: **3,500 req/10s burst**, 36,000/10min sustained (60/s)
- `DELETE /order`: 3,000 req/10s burst, 30,000/10min sustained
- `POST /orders` (batch): 1,000 req/10s burst, 15,000/10min
- Book data: 1,500 req/10s
- **RELAYER /submit**: Only **25 req/min** — severe bottleneck for direct on-chain execution

**Key Architectural Insight:**
- Polymarket enforces a **500ms intentional delay on taker orders** (crossing the spread). This means makers have 500ms to cancel stale orders before a taker fills them.
- Servers are in **London**.
- Sub-500ms price updates between CLOB and UI. WebSocket connections to `ws-subscriptions-clob.polymarket.com` are essential; polling is too slow.
- Need WebSocket, not HTTP polling, for real-time orderbook state.

### Sports WebSocket API
```
Endpoint: wss://sports-api.polymarket.com/ws
- Auto-receives all sports event updates (no subscription needed)
- Sends scores, periods, game status
- PING every 5s, PONG timeout 10s
- Cookie-based session affinity
```

**Latency observation (Reddit r/PolymarketHQ):** Community member tested Sofascore WS, Sportmonks API, intercepted sportsbook APIs — none faster than ~4s delay from first Polymarket price changes after a goal/score. Top bots likely use **same data providers as actual sportsbooks** (Sportradar, Genius Sports).

---

## 4. Trading Strategies Used by Bots

### Strategy 1: Intra-Market Arbitrage (Most Common)
**How it works:** In multi-outcome markets, buy all outcomes when total < $1.00 for risk-free profit.
- **Edge:** 0.5-5% per trade, repeatable thousands of times
- **Competition:** Extremely high — monopolized by a few bots racing for speed
- **Estimated total profit:** Major share of the $40M (IMDEA study)
- **Example:** Fed rate cut market with 4 outcomes summing to $0.995 → buy all for $0.005/share guaranteed profit

### Strategy 2: Latency Arbitrage (15-min Crypto Markets)
**How it works:** Monitor Binance/Coinbase spot prices. When Polymarket 15-min BTC/ETH/SOL odds haven't adjusted to confirmed spot momentum, buy the correct side.
- **Edge:** Enter when true probability is ~85% but market shows 50/50
- **Competition:** High but recently disrupted by Polymarket's **dynamic taker fees (up to 3%)** introduced Jan 2026
- **Example bot:** $313 → $414K in one month, 98% win rate, $4-5K bets
- **Status:** **Edge significantly reduced** by taker fees. Fees redistribute to makers via USDC rebates.

### Strategy 3: Sports Market Making
**How it works:** Quote bid/ask spreads on sports moneylines, profit from spread + Polymarket liquidity rewards. Use Pinnacle/sharp sportsbook lines as fair value.
- **Edge:** ~0.5-1.5¢ per side on pre-game, wider in-game
- **Revenue:** ~0.2% of trading volume (DeFiGuyLuke). $200-800/day realistic.
- **Risk:** Adverse selection from "fast clicking" on injury reports / news
- **Key insight from anonymous MM:**
  - "Originally I was only doing NBA because **football has singular events that can completely move the price** (pick six, etc.). Basketball doesn't have that."
  - "Hockey — you might only get one or two points, so one event can really move the price. That's harder to control for."
  - **Uses Pinnacle as fair-value oracle.** Quotes around Pinnacle line.
  - **Monitors injury reports** via Twitter feeds. Has a "kill switch" button to cancel all orders instantly.
  - **Hedges on other sportsbooks** when exposure gets too large.

### Strategy 4: Cross-Platform Arbitrage
**How it works:** Buy YES on Polymarket + NO on Kalshi (or vice versa) when implied probabilities diverge.
- **Edge:** Rare but can be large (5-15%)
- **Complexity:** Different settlement rules, capital lockup, withdrawal timing
- **Example:** Reddit user built Polymarket/Kalshi arb bot for Fed rate decisions
- **Risk:** Settlement mismatch, different resolution sources

### Strategy 5: Tail-End / Settlement Arbitrage
**How it works:** Buy near-certain outcomes (>95¢) just before resolution when retail sells to free up capital for next bet.
- **Edge:** 0.1-0.3% per trade, very high volume
- **Risk:** Black swan reversal, manipulation by whales who crash price to 90¢ and buy back
- **Capital requirement:** High (need scale for tiny margins)

### Strategy 6: AI/LLM-Based Probability Trading
**How it works:** Use AI models (GPT-4, Claude, DeepSeek, Gemini ensemble) to estimate true probabilities, trade when model disagrees with market by >5%.
- **Edge:** 5-15% misprice detection (claimed)
- **Example:** ilovecircle — $2.2M in 2 months, 74% WR
- **Stack:** Multi-LLM ensemble, RAG with news/social data, Kelly criterion position sizing
- **Reality check:** Many attempted, few succeed. Paper-trading gap is brutal.

### Strategy 7: Event-Driven / News Trading
**How it works:** Monitor breaking news, injury reports, social media. Trade before market reacts.
- **Edge:** Information speed advantage
- **Specific to sports:** Injury reports, lineup announcements, weather changes
- **Key challenge:** "Fast clicking" — informed traders picking off stale market maker orders

### Strategy 8: Shock-Fade / Mean-Reversion (OUR APPROACH) 🎯
**Publicly documented evidence:**
- Drew's backtest: **+4.7% edge for mean reversion** on Polymarket
- MoltQuant's price zone theory: strongest near extremes
- WEEX/Bitget article explicitly mentions bots "designed to capture extreme market fluctuations, such as sudden price spikes or crashes, and then bet on mean reversion"
- Trust412's GitHub spike bot implements spike detection + position management
- **But NO public evidence of sports-specific in-game shock-fade bots**
- The anonymous sports MM describes exactly the scenario we'd capitalize on: "A pick six where odds go from 10 cents to 80 cents" — these are the shocks we'd fade

---

## 5. Edge Sources and Alpha

### Speed / Latency
- **Polymarket servers in London** — colocation matters
- **500ms taker delay** — protects makers, hurts takers
- **Sports score latency:** ~4s from event to first Polymarket price movement
- **Top sports bots** likely use the same tech stack as actual sportsbooks (Sportradar)
- For 15-min crypto markets, sub-second latency to Binance/Coinbase is critical

### Data Feed Advantage
| Data Source | Edge Type | Relevance to Us |
|---|---|---|
| Pinnacle/sharp lines | Fair value oracle | ⭐ HIGH — Use as reference |
| Sportradar/Genius Sports | Real-time scores | ⭐ HIGH — Faster than Polymarket WS |
| Twitter injury feeds | Breaking news | ⭐ MEDIUM — Defense against adverse selection |
| Binance/Coinbase spot | Crypto price | ❌ N/A for sports |
| Polymarket CLOB WS | Orderbook state | ⭐ HIGH — Real-time order flow |
| On-chain data | Whale tracking | ⭐ MEDIUM — Smart money flows |

### Model / Prediction Accuracy
- **LLM ensembles** (multiple models for consensus) — used by ilovecircle
- **Domain specialization** wins — the $3.92M whale did ONE sport
- **Sports-specific models** (xG, scheduling, fatigue) still underexploited per Moltbook's Dennis

### Structural / Information Asymmetry
- **Stadium attendance** — people in stadiums see events before TV/data feeds (anonymous MM: "people in stadiums have an edge")
- **Resolution mechanics** — understanding exact resolution criteria creates "ruleset alpha"
- **Futures mispricing** — teams trade 40% below fair value vs sharp books because holders want capital back
- **No shorting on Polymarket** — mispricing persists longer than on tradfi platforms
- **Tout service fading** — anonymous MM monitors Discord pick services and fades the resulting order flow

### Fee Structure
- **Most Polymarket markets: 0% fees** (including sports)
- **15-min crypto markets: dynamic taker fees up to 3%** (introduced Jan 2026)
- **Maker rebates** from the fee pool
- **No fees on deposits/withdrawals**
- This is a massive advantage for our shock-fade approach — zero fee drag on limit orders

---

## 6. Operational Lessons and Pitfalls

### Common Mistakes Bot Operators Make

1. **Backtest-to-live gap is brutal** — MoltQuant went from 73.5% WR backtest to 25% WR paper trading. The anonymous MM lost $100K in 10 days during a hockey cold streak.
2. **Ignoring adverse selection** — Market makers who don't react to news get "fast clicked" and accumulate massive losing positions.
3. **Over-engineering speed, under-engineering risk** — "Anyone in 10 minutes can make a bot that quotes bid-ask spreads. The hard part is the risk parameters." (Anonymous MM)
4. **Not piloting manually first** — tezlee (Substack): "I now agree you should pilot this manually before automating. Observe how adverse selection impacts your earnings."
5. **Inventory concentration** — Letting one-sided positions build up. Must implement proper position merging (YES+NO → USDC).
6. **Volatile market selection** — Early mistakes from choosing high-volatility markets where hedging is impossible.
7. **Execution bugs compounding** — tezlee: "The accumulated cost of errors ate directly into whatever edge the strategy produced." Made zero net profit despite working bot.
8. **Ignoring tie rules** — Polymarket treats ties differently than sportsbooks (50-50 resolution vs. push/refund). Must be factored in.

### Risk Management Approaches

**From the Anonymous Sports MM:**
- Max $25K exposure per NFL game, $5K per college football
- $300K total in play across all NFL Sunday games
- Sliding liquidity scale: more $ at better prices
- "Kill switch" button to cancel all orders when news breaks
- Monitor Twitter for injury feeds — shut down sport if news incoming
- Hedge on other sportsbooks when exposure too large
- "Let the dust settle" approach — don't try to be first on news, avoid getting clicked

**From ilovecircle/AI bots:**
- Dynamically adjust strategy every few minutes
- Recalculate P&L continuously
- Maintain, increase, or close positions based on rolling assessment

**From General Ecosystem:**
- Kelly criterion: use 0.25x fractional Kelly for safety
- Never risk >10% on single market
- Daily loss limit: stop if down 5%
- Diversification across uncorrelated markets
- Position limits + stop-loss at configurable thresholds

### How Bots Handle Manipulation / Adverse Selection

1. **Monitor for information leaks** — Twitter feeds, tout services, Discord groups
2. **Instant order cancellation** — Kill switch when news detected
3. **Wider spreads** — In volatile periods, widen bid-ask to compensate for adverse selection risk
4. **Sport avoidance** — Skip games with known injury report timing windows
5. **Cross-book hedging** — When Polymarket exposure gets too large, hedge on traditional sportsbooks
6. **Fair value reference** — Always compare to Pinnacle/sharp line, don't quote without external reference

### Platform-Specific Considerations
- **No user bans** on Polymarket (unlike traditional sportsbooks) — sharps can't be kicked
- **Wallet cycling** — Sharp traders constantly create new wallets to avoid being tracked
- **Resolution disputes** — UMA dispute mechanism can delay settlements
- **Tie handling** — Different from traditional books, must be modeled
- **Regulatory** — US persons technically prohibited from trading, though enforcement unclear post-CFTC changes under new administration

---

## 7. Strategy Breakdown with Estimated Edge Sizes

| Strategy | Edge Size | Capital Required | Competition Level | Relevance to Our Bot |
|---|---|---|---|---|
| Intra-market arb (sum<$1) | 0.5-5% per trade | $10K-100K | 🔴 Extreme | Low — different strategy |
| Latency arb (15-min crypto) | 1-3% (declining) | $5K-50K | 🔴 Extreme (+ fees) | None — crypto only |
| Sports market making | 0.2% of volume | $50K-300K | 🟡 Medium | Moderate — MM is adjacent |
| Cross-platform arb | 1-15% (rare) | $20K-100K | 🟡 Medium | Low — different strategy |
| Tail-end settlement | 0.1-0.3% | $100K+ | 🟢 Low-Medium | Low — different timeframe |
| AI probability trading | 5-15% (claimed) | $10K-100K | 🟡 Medium | Moderate — model-based |
| **Shock-fade (our approach)** | **4.7% (Drew's backtest)** | **$5K-50K** | **🟢 Low** | **🎯 Direct** |
| Event-driven / news | Variable (0-40%) | $10K-50K | 🟡 Medium | Moderate — adjacent risk |

---

## 8. Lessons Directly Applicable to Our Shock-Fade Bot

### Validated Design Decisions ✅
1. **Mean reversion IS the edge** — +4.7% (Drew), strongest at price extremes (MoltQuant)
2. **Limit orders (maker) are correct** — Zero fees, 500ms taker delay protects us, maker rebates
3. **Sports markets are less contested by bots** — Most bot profits from crypto arb, not sports
4. **In-game shock-fade has no visible competition** — Not on Moltbook, not in public codebases, not in interviews
5. **Pinnacle as fair-value oracle** — Standard practice for the most profitable sports MM

### Critical Design Implications ⚠️
6. **Basketball > Football > Hockey for our strategy** — Basketball has smoother price action (many small moves). Football has catastrophic singular events (pick-six). Hockey has sparse scoring = extreme price jumps per goal. *But football/hockey shocks may offer LARGER fade opportunities precisely because they're more violent.*
7. **4-second score latency** — We're not trying to be first on the score; we're fading the OVERREACTION. The 4s delay is actually fine for us.
8. **500ms taker delay** — If we place limit orders (maker), this protects us from being picked off. If we need to take, we face 500ms disadvantage.
9. **Kill switch is essential** — Must be able to cancel all orders instantly when news breaks (injury, ejection, technical)
10. **Hedge capability** — Consider integration with traditional sportsbooks for emergency hedging when exposure is too large
11. **Pipeline reliability** — BenderRodriguez: 30-second scraper lag = worthless model. Our recorder/WebSocket must be rock-solid.
12. **Paper trade extensively** — The backtest-to-live gap destroyed MoltQuant (73% → 25% WR) and tezlee (zero profit despite working bot). Do not skip this.

### What We're Up Against (Competitive Landscape)
- **3-5 serious sports market makers** on Polymarket (anonymous MM says "maybe one or two other bots")
- **These MMs will be our counterparties** — when we fade a shock, we may be buying from MMs who are also buying (aligned) or selling to MMs who just got adversely filled (they're the other side)
- **No known in-game shock-fade competitors** — but this could be because: (a) it's too hard, (b) people doing it don't talk, or (c) the market is too new
- **Stadium viewers have edge** — they see plays before data feeds. This is a risk for us: someone in the stadium could be fading shocks before our data arrives

### Architecture Recommendations (From Ecosystem Research)
1. **Use `py-clob-client`** for CLOB interaction
2. **WebSocket to `ws-subscriptions-clob.polymarket.com`** for real-time orderbook
3. **WebSocket to `sports-api.polymarket.com/ws`** for live scores
4. **Consider Sportradar/external feed** for faster score detection (4s delay on Polymarket WS)
5. **Implement position merging** (YES+NO → USDC) to free capital
6. **Log everything** — every trade, every signal, every P&L, for CLV tracking
7. **Kelly criterion sizing** at 0.25x fractional for safety
8. **Host on London VPS** (Polymarket servers in London)

---

## 9. Ecosystem Tools Worth Monitoring

| Tool | Purpose | Why Relevant |
|---|---|---|
| **Betmoar** | Trading terminal + analytics | $110M volume, UMA dashboard, position delta analysis |
| **PolyTrack** | Wallet tracking / whale alerts | Track competitor MM wallets |
| **Polysights** | AI-powered analytics | Insider Finder, arbitrage detection |
| **Inside Edge** | Mispricing detection | Quantified edge percentages |
| **Sportstensor** | AI sports predictions | Ensemble modeling for sports |
| **OpticOdds** | Multi-sportsbook odds API | Pinnacle/Polymarket comparison |
| **SportsGameOdds** | Polymarket sports API | RESTful + WebSocket streaming |

---

## 10. Sources

### Primary Sources (Interviews & Official)
1. "Meet Your Market Maker" — Polymarket Oracle newsletter, Oct 2025 (https://news.polymarket.com/p/meet-your-market-maker)
2. "Automated Market Making on Polymarket" — @defiance_cr interview, May 2025 (https://news.polymarket.com/p/automated-market-making-on-polymarket)
3. Polymarket API Rate Limits — Official docs (https://docs.polymarket.com/quickstart/introduction/rate-limits)
4. Polymarket Sports WebSocket — Official docs (https://docs.polymarket.com/developers/sports-websocket/overview)
5. Polymarket Trading Fees — Official docs (https://docs.polymarket.com/polymarket-learn/trading/fees)

### Academic Research
6. "Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets" — Saguillo et al., IMDEA Networks, arXiv:2508.03474, Aug 2025

### News & Analysis
7. "Arbitrage Bots Dominate Polymarket" — BeInCrypto, Jan 2026 (https://beincrypto.com/arbitrage-bots-polymarket-humans/)
8. "People making silent profits through arbitrage on Polymarket" — ChainCatcher, Oct 2025 (https://www.chaincatcher.com/en/article/2212288)
9. "Polymarket users lost millions to bot-like bettors" — DL News, Aug 2025 (https://www.dlnews.com/articles/markets/polymarket-users-lost-millions-of-dollars-to-bot-like-bettors-over-the-past-year/)
10. "Polymarket Introduces Dynamic Fees" — Finance Magnates, Jan 2026 (https://www.financemagnates.com/cryptocurrency/polymarket-introduces-dynamic-fees-to-curb-latency-arbitrage-in-short-term-crypto-markets/)
11. "The Definitive Guide to the Polymarket Ecosystem" — DeFi Prime, Jan 2026 (https://defiprime.com/definitive-guide-to-the-polymarket-ecosystem)
12. "AI Bot Generates $2.2M" — Phemex News, Dec 2025 (https://phemex.com/news/article/ai-bot-generates-22m-in-two-months-on-polymarket-42804)
13. "Top 10 Polymarket Wallets" — Phemex News, Jan 2026 (https://phemex.com/news/article/top-10-polymarket-wallets-profit-from-hype-markets-54536)
14. "Six Key Profit Strategies" — ChainCatcher/Phemex, Dec 2025

### Community & Social
15. "I cloned a Polymarket MM bot" — tezlee Substack, Dec 2025 (https://tezlee.substack.com/p/i-cloned-a-polymarket-market-making)
16. "How do Polymarket bots achieve fast reactions on live score changes?" — r/PolymarketHQ, Mar 2025
17. "I built a Polymarket trading bot, tested 4 strategies" — r/PolymarketTrading, Feb 2026
18. "Polymarket Bot makes $3 bets over 80k+ times" — r/PredictionsMarkets, Jan 2026
19. "CLOB's postorders latency" — r/PolymarketTrading, Dec 2025 (500ms delay confirmation)
20. @DextersSolab — Twitter thread on $313→$414K bot, Jan 2026
21. @igor_mikerin — Twitter thread on ilovecircle AI bot, Dec 2025
22. @0xEthan — Twitter thread on front-running bot, Dec 2025

### GitHub Repositories
23. Polymarket/py-clob-client — Official Python CLOB client
24. Polymarket/poly-market-maker — Official market maker keeper
25. Polymarket/agents — Official AI agent framework
26. Trust412/Polymarket-spike-bot-v1 — Spike detection bot (302 stars)
27. warproxxx/poly-maker — Open-source MM bot (@defiance_cr)
28. terrytrl100/polymarket-automated-mm — Enhanced MM fork

### Moltbook Intelligence
29. Moltbook Intelligence Report (internal) — `/research/moltbook-intel/findings.md`, scraped Feb 2026
