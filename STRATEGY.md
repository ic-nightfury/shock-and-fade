# Shock & Fade Strategy

## Overview

Shock & Fade is a mean-reversion trading strategy for Polymarket sports moneyline markets. It detects mid-game price shocks caused by scoring events (goals, baskets, touchdowns), classifies them using free league API data, and sells into the overshoot with laddered limit orders — capturing the reversion as the market recalibrates.

### The Core Insight

When a team scores during a live sports game, Polymarket prices overreact. A single NBA basket can move a moneyline 5-8¢ when the "fair" adjustment might be 2-3¢. This overshoot creates a predictable fade opportunity: sell into the spike, wait for mean reversion.

### The Edge: Event-Driven Exit

The single biggest alpha is **how we exit**, not how we enter.

- **Static timeout exit** (e.g., close after 120s): Only 15% of parameter combinations are profitable. The market might still be dislocated, or might have moved further against us.
- **Event-driven exit** (close only when the next scoring event occurs): **100% of parameter combinations are profitable.** The next scoring event creates a new price disruption that naturally ends the fade window.

This asymmetry is the entire edge.

---

## Split-and-Sell Model

> **Never buy on the book. Always sell.**

Polymarket sports markets are binary: Team A vs Team B. The CTF (Conditional Token Framework) ensures that 1 share of Team A + 1 share of Team B always equals $1.00 at settlement. We exploit this by splitting USDC into complementary token pairs and selling whichever side spikes.

### How It Works

1. **Pre-split** $50 USDC → 50 shares of Team A + 50 shares of Team B
2. When Team A scores, Team A token spikes (e.g., 55¢ → 62¢)
3. **Sell Team A shares** at the inflated price via laddered limit orders
4. **Hold Team B shares** — they're now underpriced (complement = 1.00 - Team A price)
5. When the market reverts (or the next event occurs), sell Team B shares to close

### Why Split-and-Sell?

- **Zero sell fees** on Polymarket (sellers pay 0%, buyers pay the spread)
- **No need to cross the spread** — we post limit sell orders and get filled by aggressive buyers
- **Capital efficient** — splitting is an on-chain operation with no slippage
- **Symmetric** — we can sell either side depending on which token spikes

---

## Cycle Mechanics

A "cycle" is one complete shock → entry → exit lifecycle.

### Entry: Shock Detection + Event Classification

1. **Shock detection** via z-score on a 60-second rolling window of mid-prices. Threshold: >2σ move AND >3¢ absolute change.
2. **Event classification** using free league APIs (NBA CDN, ESPN for CBB/NFL/soccer):
   - Burst-poll the API at 1-second intervals for 10 seconds after shock detection
   - **10-second hard cutoff** — if no event confirmed within 10s, skip the shock
   - **Single event** (exactly 1 scoring play detected) → **TRADE**
   - **Scoring run** (2+ scoring events in the window) → **SKIP** (momentum, not mean-reversion)
   - **Unclassified** (0 events detected) → **SKIP** (noise or structural change)

### Entry: Laddered Limit Orders

Once a shock is classified as `single_event`, place 3 GTC (Good-Till-Cancelled) sell limit orders on the spiked token:

| Level | Offset from shock price | Size (shares) | Notional |
|-------|------------------------|---------------|----------|
| 1     | +3¢                    | 5             | ~$5      |
| 2     | +6¢                    | 10            | ~$10     |
| 3     | +9¢                    | 20            | ~$20     |

**Total exposure per cycle: ~$35**

The ladder captures different depths of the overshoot. Most cycles only fill Level 1; deep spikes fill all three.

### Take Profit: Cumulative DCA-Blended TP

Instead of individual TP orders per ladder level, we maintain **ONE cumulative take-profit limit order** per market cycle:

- Tracks the DCA-blended entry price across all filled ladder orders
- TP price = `1.00 - blendedEntryPrice + fadeTarget`
- As more ladders fill, the TP order is cancelled and replaced with updated price/size
- This simplifies order management and reduces the number of resting orders

**TP Fill Confirmation:**
- **Live mode:** TP fills are confirmed via **UserChannelWS** (real-time WebSocket fill events), not bid-based detection. The WS fires events matching `tp.tpOrderId` and inventory is deducted ONLY on confirmed fill (WSS event or API response).
- **Dry-run/paper mode:** Bid-based TP detection is kept as the only option (no real orders to track).

### Exit: GTC-at-Bid Strategy

Polymarket sports markets impose a **3-second delay on marketable orders** (FAK, FOK, or GTC orders that cross the spread). This makes FAK market sells slow and unreliable for exits.

**GTC-at-bid exit flow:**
1. Read the current best bid for the complement token
2. Place a GTC sell at `bid + 1 tick` — this rests on the book as a **maker order** (no delay)
3. Tick size: `0.01` for prices in [0.04, 0.96], `0.001` outside that range
4. `waitForGTCFill()` polls **UserChannelWS** + CLOB `getOrder()` every 500ms until filled
5. **Retry:** If not filled within timeout, re-read fresh bid, drop price by 2¢, up to 3 attempts
6. **Final fallback:** FAK at 1¢ floor price (accepts the 3-second delay as last resort)

### Exit: Smart Event-Driven

The exit logic is where the strategy's edge lives:

| Event | Action |
|-------|--------|
| **Adverse event** (shock team scores again) | GTC sell complement at bid+1tick. The fade thesis is broken — get out. |
| **Favorable event** (opposite team scores) | **Hold for mean reversion.** The market will swing back our way. |
| **Game decided** (held bid ≤1¢ or sold bid ≥99¢) | Direct finalization — no GTC sell (see below). |
| **Timeout fallback** (600s default) | If no event occurs, eventually close. Rarely triggered with event-driven exit. |

### Exit: Game-Decided Positions

When the held token's bid drops to ≤1¢ or the sold token's bid rises to ≥99¢, the game is effectively decided:

- **Losing-side shares have no buyers** — a GTC sell order would hang forever
- `finalizePositionClose()` is called directly, skipping the GTC sell attempt
- **P&L on winning held shares:** Exit price is set to **$1.00** (redeemable at settlement). The P&L formula `(soldPrice + exitPrice - 1.0) × shares` correctly reflects that selling at e.g. 43¢ + holding the winner at $1.00 = 43¢ profit per share
- **P&L on losing held shares:** Exit price is **$0** — shares are worthless, loss = `(soldPrice - 1.0) × shares`
- `handleExtremePrice()` determines winner/loser using the triggering token's price (if it dropped to ~0, the complement is the winner)
- `checkStalePositions()` also detects decided games as a backup safety net
- **Unbalanced shares** (excess from sold ladder orders) are logged as redeemable and will be claimable after market resolution

### Post-Cycle Cleanup

After exit:
- Cancel any unfilled ladder orders
- Merge remaining complementary shares back to USDC
- Free the game slot for the next opportunity

---

## Capital Model

### Per-Game Budget

- **Pre-split amount:** $85/game
  - Formula: `(cycleSize × maxCyclesPerGame) + L1 + L2 buffer` = `(35 × 2) + 5 + 10 = 85`
  - The L1+L2 buffer ensures the second cycle's first two ladders can be placed while the first cycle is still active
- **Per-cycle exposure:** ~$35 (3 ladder levels: 5+10+20 shares)
- **Auto-refill:** Split an additional $35 when `min(sharesA, sharesB) ≤ 35`, ensuring inventory for new cycles
- **Price range:** Detector filters noise on tokens outside [0.07, 0.85]
- **Sell price max:** Won't place ladder orders if the sell price > 85¢. This is an asymmetric filter:
  - ✅ **Selling losing team at 11/14/17¢** — TP is on the winning side (high price, stable, will hit)
  - ❌ **Selling winning team at 90/93/96¢** — TP is on the losing side (low price, won't recover)
  - The key insight: when the winning team scores at >85¢, the game is nearly decided and the complement (losing side) won't rise enough for TP to fill

### Concurrency Controls

- **`maxConcurrentGames`**: Maximum number of games with pre-split inventory. Controls total capital deployed.
  - Default: 2 games
  - Capital needed: `$85 × maxConcurrentGames` = $170 for 2 games
- **`maxCyclesPerGame`**: Maximum **concurrent** active cycles per game (prevents stacking).
  - Default: 2 (up to 2 active fade positions per game simultaneously)
  - **Note:** This is CONCURRENT active cycles, not total over the game's lifetime. When a cycle completes (TP hit or exit), the slot frees up. Total cycles per game is unlimited.
  - Cross-direction cycles are fine: Cycle 1 might sell Team A (price went up), Cycle 2 might sell Team B (price bounced back)

### Circuit Breaker

- **3 consecutive losses** → pause trading for the session
- **$30 session loss** → pause trading for the session

### Gas Costs

Using `DirectExecutionClient` (bypasses Builder Relayer):
- Split: ~$0.03
- Merge: ~$0.02
- **Full cycle: ~$0.05 in MATIC gas**

---

## Data Sources

### Market Discovery

- **Gamma API** (`gamma-api.polymarket.com`): Discovers active sports moneyline markets. Filtered by sport tags and `negRisk` flag.

### Real-Time Prices

- **Polymarket WebSocket** (`OrderBookWS`): Real-time bid/ask/trade data for shock detection. Subscribed per token ID.

### Game Events (Scoring Data)

All free, no API keys required:

| Sport | API | Endpoint |
|-------|-----|----------|
| NBA | NBA CDN | `cdn.nba.com/static/json/liveData/playbyplay/` |
| CBB | ESPN | `site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/` |
| NHL | NHL API | `api-web.nhle.com/v1/gamecenter/{id}/play-by-play` |
| NFL | ESPN | `site.api.espn.com/apis/site/v2/sports/football/nfl/` |
| European Soccer | ESPN | `site.api.espn.com/apis/site/v2/sports/soccer/` |
| MLB | MLB Stats | `statsapi.mlb.com/api/v1.1/game/{id}/feed/live` |

---

## On-Chain Execution

### DirectExecutionClient

The `DirectExecutionClient` bypasses Polymarket's Builder Relayer (which has a 100 transactions/day quota on unverified accounts) by calling the Gnosis Safe's `execTransaction()` directly on Polygon.

- **Same proxy wallet** — funds, tokens, and CLOB API keys are unchanged
- **Unlimited transactions** — no daily quota
- **~$0.05/cycle** in MATIC gas (split + merge)
- **Fallback:** Builder Relayer is kept as backup for when the EOA runs out of MATIC

See [DIRECT_EXECUTION.md](./DIRECT_EXECUTION.md) for full technical details.

### Order Execution

- **Entry orders:** GTC (Good-Till-Cancelled) sell limit orders placed via CLOB API
- **TP orders:** GTC limit sell on complement token; fills confirmed via UserChannelWS
- **Exit orders:** GTC sell at `bid + 1 tick` (maker order, avoids 3s sports market delay). Retry with 2¢ drops, FAK at 1¢ floor as final fallback.
- **Cancel:** REST API cancel by order ID

---

## Supported Sports

| Sport | Status | Notes |
|-------|--------|-------|
| NBA | ✅ Primary | Live trading. Highest volume, best liquidity, most data |
| CBB | 📊 Recording + Discovery | Recording tick data, running paper trader for discovery |
| NHL | ✅ Live | Launched Feb 2026 |
| NFL | ✅ Live | Seasonal (Super Bowl, playoffs) |
| European Soccer | 🔜 Planned | Infrastructure ready (ESPN API), pending market volume |
| MLB | 🔜 Seasonal | API ready, seasonal availability |

---

## Backtest Results

### v3 Realistic Backtest

Using actual recorded trade data with 25% queue capture assumption (conservative fill model):

| Metric | Value |
|--------|-------|
| **Best parameter combo P&L** | $107 over 18 games |
| **Win rate** | 73.3% |
| **Sharpe ratio** | 0.55 |
| **Parameter combos profitable** | 100% (with event-driven exit) |

### Key Backtest Parameters

- Shock threshold: 2σ + 3¢ absolute minimum
- Ladder: 3 levels, 3¢ spacing, 5/10/20 shares
- Exit: Event-driven (next scoring event)
- Fill model: 25% queue capture on resting limit orders
- Data: Real Polymarket tick data + real NBA play-by-play from recorded games

### Comparison: Event-Driven vs Static Timeout

| Exit Method | % Profitable Combos | Best Sharpe |
|-------------|---------------------|-------------|
| Static 120s timeout | 15% | 0.22 |
| Static 300s timeout | 35% | 0.31 |
| Event-driven | **100%** | **0.55** |

---

## Risk Management

### Position-Level

- **Scoring run bail:** If 2+ same-team events detected while holding → immediately market sell complement + cancel all resting orders
- **Extreme price exit:** If token price hits >99¢ or <1¢, the game is effectively decided. Close everything, merge, free the slot.
- **Per-game cycle cap:** `maxCyclesPerGame` prevents stacking too many positions on one game

### Portfolio-Level

- **Capital cap:** `maxConcurrentGames × $50` = total capital at risk
- **No buying:** Never placing buy orders eliminates adverse selection from the book
- **Pre-split model:** Capital is deployed as inventory (tokens), not as resting buy orders that could get picked off

### Known Risks

- **Liquidity:** Low-volume games may not fill ladder orders or may have wide spreads on exit
- **API latency:** League API delays could cause missed or stale event classification
- **Market structure changes:** Polymarket could change fees, minimum orders, or WebSocket behavior
- **Gas spikes:** Polygon gas spikes could increase per-cycle costs (rare, Polygon is consistently cheap)
