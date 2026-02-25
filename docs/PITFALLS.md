# Pitfalls & Gotchas

Hard-won lessons from live trading. Read this before making changes.

## Environment Variables

### SHOCK_LADDER_SPACING must be decimal (0.03), not integer (3)
The code uses `parseFloat(process.env.SHOCK_LADDER_SPACING)` and treats it as a decimal price offset. Setting `SHOCK_LADDER_SPACING=3` means $3.00 spacing (300¢), which clamps all ladder levels to 99¢. **Always use decimal: `0.03` for 3¢.**

### SHOCK_FADE_TARGET is in cents (integer)
Unlike LADDER_SPACING, `SHOCK_FADE_TARGET=4` means 4¢. The code does `fadeTargetCents / 100` internally. Inconsistent with LADDER_SPACING, but that's how it works.

### SHOCK_PRICE_MIN/MAX are decimal prices
`SHOCK_PRICE_MIN=0.07` means 7¢. `SHOCK_PRICE_MAX=0.85` means 85¢.

## Polymarket Sports Market Delay

### 3-second delay on marketable orders
Polymarket applies a 3-second delay on ANY order that would cross the spread in sports markets. This includes:
- FAK (Fill-and-Kill) market orders
- GTC orders priced at or below the best bid (for sells)
- Any order that is immediately matchable

**Solution:** Place GTC sells at `bid + 1 tick` so the order rests on the book as a maker order (no delay). The tick size is 0.01 for prices in [0.04, 0.96] and 0.001 outside that range.

**API tells you:** `status: "delayed"` in the order response means the 3s delay was triggered.

### FAK orders return empty fill data when delayed
A FAK sell that triggers the 3s delay returns `status: "delayed"` with NO fill information. The order actually fills after 3 seconds on-chain. If you treat empty fills as "nothing sold," you lose track of inventory. The handler now waits 4s before checking fill status.

## Inventory Tracking

### Shares deducted ONLY on confirmed fills
- Entry sell orders: deducted at placement (committed to book), returned on cancel/fail
- TP/exit sell orders: deducted ONLY when fill confirmed via UserChannelWS or API response
- NEVER assume a fill based on bid price crossing your order price

### Merge only works on balanced pairs
`MergeClient.merge(n)` merges `n` pairs of (tokenA + tokenB) → $n USDC. If you have 90A/85B, merge(85) leaves 5 orphaned A shares that can't be merged. These accumulate across restarts.

### On-chain balance ≠ internal inventory
After restarts, the bot reads on-chain balance to sync. But if trades executed between shutdown and startup (delayed FAK fills, etc.), the on-chain balance may not match what the bot expects.

## SIGHUP Hot-Reload

### systemd sends signals to MainPID — must be the node process
If the service uses `npx tsx ...`, the MainPID is `npx` (which doesn't handle SIGHUP). The service file must run `node --require ... --import ...` directly so SIGHUP reaches the correct process. Use `ExecReload=/bin/kill -HUP $MAINPID` and `systemctl reload shock-fade-live`.

### Reload only affects NEW shocks/cycles
Existing open positions keep their original config. Only new shock detections and new cycle entries use the reloaded config.

## Restarts During Active Trading

### rsync deploy MUST exclude .env
The Finland server has its own `.env` with `SHOCK_*` trading config. If you rsync without `--exclude .env`, the Germany `.env` (no `SHOCK_*` vars) overwrites it and the bot falls back to defaults (wrong ladder sizes, wrong concurrent games, etc.). Always deploy with:
```bash
rsync -avz --exclude node_modules --exclude data --exclude .git --exclude '*.db' --exclude .env ...
```

### Rapid restarts cause orphaned shares
Each restart: reads on-chain balance → splits to reach preSplitSize. If there's an imbalance from trading, the split adds equal amounts to both sides, so the imbalance persists. On shutdown, merge takes min(A,B), leaving orphans. Multiple restart cycles amplify this.

### State file persistence
The bot saves state to `shock-fade-state.json`. On restart, it loads P&L, trade history, and reconstructs TP orders. But it does NOT reconstruct active positions — those are detected via on-chain balance only.

### Nonce collision on concurrent splits
Two simultaneous split transactions (for different games) can fire with the same nonce → "replacement fee too low" error. Need sequential nonce management or a mutex around on-chain transactions.

## Order Management

### Cancel-fill race condition
If you cancel an order that's being filled simultaneously, the cancel succeeds but the fill also processes. The WS handler detects this and reverses the inventory return from the cancel.

### 60-second order expiry
Resting entry orders auto-cancel after 60 seconds. This prevents stale orders from filling long after the fade window has passed.

### wsHandledOrderIds dedup guard
UserChannelWS fires events for the same order multiple times: MATCHED → MINED → CONFIRMED. The `wsHandledOrderIds` Set prevents double-processing. Also used to mark immediate fills so the WS handler doesn't re-process them.

## Game-Decided Positions

### Losing-side shares have no buyers
When a game is decided (one team at 0¢, other at 100¢), the losing-side shares are worthless. GTC sell orders will hang forever because there are no buyers. Must use `finalizePositionClose()` directly with exit price $0 instead of `closePosition()` which attempts GTC sell.

### Extreme price threshold
Detected when held token bid ≤ 1¢ OR sold token bid ≥ 99¢. Both `handleExtremePrice()` and `checkStalePositions()` check for this.

## Score API Freshness

### NBA CDN is best free source for NBA (~5s refresh)
`cdn.nba.com/static/json/liveData/...` — no rate limits, ~80-100ms latency, ~5s ETag refresh.

### ESPN NHL is better than NHL API
ESPN NHL: `max-age` 1-5s. NHL API (`api-web.nhle.com`): `max-age=19, s-maxage=19` via Cloudflare CDN — way too slow.

### 10-second classification timeout is the real latency bottleneck
Not the API freshness. If the event hasn't propagated to the CDN within 10 seconds of the price shock, the shock is skipped. Most events arrive within 1-5 seconds.

## Capital & Sizing

### Ladder sizes are in SHARES, not dollars
`SHOCK_LADDER_SIZES=5,10,20` means 5 shares, 10 shares, 20 shares. At ~60¢ mid-price, that's ~$3/$6/$12 notional. The dollar exposure varies with price.

### preSplitSize formula
`(cycleSize × maxCyclesPerGame) + L1 + L2` = `(35 × 2) + 5 + 10 = 85` for current config. The L1+L2 buffer ensures the second cycle's first two ladders can be placed while the first cycle is still active.

### maxCyclesPerGame = concurrent, not total
`maxCyclesPerGame=2` means max 2 ACTIVE cycles at once. When a cycle completes (TP hit or exit), the slot frees up. Total cycles per game is unlimited.

### Cross-direction cycles are fine
Cycle 1 might sell Team A (price went up), Cycle 2 might sell Team B (price bounced back). Each cycle removes exactly one pair of shares when the complement sell executes correctly.

### Sell price filter is ASYMMETRIC (not both-sides)
`SHOCK_PRICE_MAX=0.85` filters on the **sell price**, not both token prices:
- ✅ Selling losing team at 11¢ (TP on winning side is safe — they're likely to win)
- ❌ Selling winning team at 90¢ (TP on losing side won't hit — game is nearly decided)
- The detector's `[PRICE_MIN, PRICE_MAX]` range filters noise on the mid price
- ShockFadeLive additionally checks: `if (sellTokenPrice > sellPriceMax) → SKIP`

### Winning held shares = $1 in P&L, not $0
When a game decides in favor of our held token, `exitPrice = 1.0` (redeemable at settlement). Previously this was incorrectly set to $0 regardless of winner/loser, massively understating P&L on winning positions. The P&L formula: `(soldPrice + exitPrice - 1.0) × shares`.
