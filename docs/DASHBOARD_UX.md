# Shock-Fade Dashboard — UX Design Plan

## Design Principles
- **Glanceable**: Key numbers visible at phone-screen distance
- **Dense when needed**: Live game cards show everything, no clicks required
- **Mobile-first responsive**: Works on phone (glance) and desktop (full monitoring)
- **Mode-aware**: Paper vs Live are visually distinct, same design language
- **Timestamped everything**: Every log entry, event, order, trade — UTC + local (GMT+7)

---

## Mode Distinction

### Paper Trading
- **Header**: `⚡ SHOCK-FADE — PAPER MODE`
- **Accent color**: Blue/purple (current palette)
- **Subtle repeating watermark**: "SIMULATED" in background
- **No wallet/balance display**

### Live Trading
- **Header**: `🔴 SHOCK-FADE — LIVE`
- **Accent color**: Amber/orange
- **Persistent top banner**: `⚠️ REAL MONEY — LIVE TRADING ACTIVE` (red background)
- **Shows**: Wallet balance, USDC available, pre-split inventory, gas (MATIC)

---

## Layout (Top → Bottom)

### 1. Header Bar
```
┌─────────────────────────────────────────────────────────────┐
│ ⚡ SHOCK-FADE — PAPER MODE              🟢 Connected  12:34│
│ Session: 2h 14m │ P&L: +$142.50 │ Win: 8/9 (88.9%)        │
└─────────────────────────────────────────────────────────────┘
```
- Mode indicator (Paper/Live)
- WebSocket status + uptime clock
- Session P&L (big, prominent)
- Win rate
- **Live mode adds**: USDC balance, pre-split shares inventory, MATIC balance

### 2. Stats Strip (KPI Cards)
```
┌──────┬──────┬──────┬──────┬──────┬──────┬──────┐
│SHOCKS│TRADES│ W/L  │ WIN% │AVG   │SHARPE│ P&L  │
│  12  │  9   │ 8/1  │88.9% │$17.81│ 1.05 │+$142 │
└──────┴──────┴──────┴──────┴──────┴──────┴──────┘
```
- Shocks detected (session)
- Trades taken (passed event filter)
- Win/Loss count
- Win rate %
- Avg profit per trade
- Sharpe ratio
- Total P&L

### 3. Game Sections (3 tabs/sections, vertically stacked)

#### 3a. 🔴 LIVE GAMES — Expanded Cards

Each live game gets a full card:

```
┌─────────────────────────────────────────────────────────────┐
│ 🏀 NBA   MIA @ BOS          Q3 4:32    🟢 WSS: 45ms       │
│          85  -  91                                          │
├─────────────────────────────────────────────────────────────┤
│ TOKEN A (MIA)              │ TOKEN B (BOS)                  │
│ Best Bid: 38.2¢  (2,140)   │ Best Bid: 60.5¢  (3,200)      │
│ Best Ask: 38.8¢  (1,890)   │ Best Ask: 61.2¢  (2,750)      │
│ Spread:   0.6¢             │ Spread:   0.7¢                │
│ Depth ±3¢: $4,200 / $3,800 │ Depth ±3¢: $5,100 / $4,600    │
│ Mid: 38.5¢                 │ Mid: 60.85¢                   │
├─────────────────────────────────────────────────────────────┤
│ ⚡ SHOCK STATUS: None       │ 📊 VOLATILITY: σ = 1.2¢       │
│ Last shock: 3m ago (1.8σ)  │ Z-score: 0.4 (normal)         │
├─────────────────────────────────────────────────────────────┤
│ 📋 OUR ORDERS                                               │
│ L1: SELL BOS @ 64.0¢  500 shares  ⏳ pending                │
│ L2: SELL BOS @ 67.0¢  500 shares  ⏳ pending                │
│ L3: SELL BOS @ 70.0¢  500 shares  ⏳ pending                │
├─────────────────────────────────────────────────────────────┤
│ 📈 OUR POSITION                                             │
│ Side: SHORT BOS │ Entry: 64.0¢ │ Current: 61.2¢ │ +$14.00  │
├─────────────────────────────────────────────────────────────┤
│ 📰 RECENT EVENTS                                            │
│ 12:31:04  🏀 BOS 3-pointer (Tatum) — 85-91                 │
│ 12:28:17  🏀 MIA layup (Butler) — 85-88                    │
│ 12:25:42  ⚡ Shock detected: +4.2¢ (3.1σ) → single_event   │
└─────────────────────────────────────────────────────────────┘
```

**Card contains:**
- **Header**: Sport badge, teams, period/clock, WSS latency (green/yellow/red)
- **Score**: Live score, prominent
- **Book data**: Bid/Ask/Spread/Depth for BOTH tokens side by side
- **Shock status**: Current z-score, last shock time, classification
- **Our orders**: All 3 ladder levels with side, price, size, fill status
- **Our position**: If holding — side, entry, current price, unrealized P&L
- **Event feed**: Last 3-5 game events with timestamps (scrollable)

**Color coding:**
- WSS latency: 🟢 <100ms, 🟡 100-500ms, 🔴 >500ms or disconnected
- Shock severity: white (normal) → yellow (2σ) → red (3σ+)
- P&L: green positive, red negative
- Order status: ⏳ pending, ✅ filled, ❌ cancelled

#### 3b. 📅 UPCOMING GAMES — Compact List
```
┌─────────────────────────────────────────────────────────────┐
│ 📅 UPCOMING                                     3 games     │
├──────┬──────────────┬───────────┬────────┬─────────────────┤
│SPORT │ MARKET       │ START     │ PRICES │ VOLUME          │
│ NBA  │ DAL vs MIL   │ 7:30 PM  │ 44/54¢ │ $1.7M           │
│ NBA  │ HOU vs OKC   │ 8:00 PM  │ 42/57¢ │ $916K           │
│ ⚽   │ ARS vs LIV   │ 9:00 PM  │ 38/35¢ │ $2.1M           │
└──────┴──────────────┴───────────┴────────┴─────────────────┘
```
- Compact rows (like current "Live Markets" but correctly labeled)
- Start time in local timezone (GMT+7)
- Pre-game prices + volume
- **Live mode adds**: Pre-split share inventory status per game

#### 3c. ✅ SETTLED (Last 24h) — Compact with Results
```
┌─────────────────────────────────────────────────────────────┐
│ ✅ SETTLED (last 24h)                            2 games     │
├──────┬──────────────┬────────┬───────┬─────────┬───────────┤
│SPORT │ MARKET       │ SCORE  │TRADES │ P&L     │ RESULT    │
│ NBA  │ MIA vs BOS   │ 98-112 │  3    │ +$52.40 │ 3W / 0L   │
│ NFL  │ SEA vs NE    │ 24-31  │  1    │ -$8.20  │ 0W / 1L   │
└──────┴──────────────┴────────┴───────┴─────────┴───────────┘
```
- Final score
- Number of trades taken
- Session P&L from that game
- Win/Loss breakdown

### 4. Trade History (scrollable table)
```
┌─────────────────────────────────────────────────────────────┐
│ 📜 TRADE HISTORY                                 9 trades   │
├──────────┬───────┬──────┬─────┬──────┬──────┬──────┬───────┤
│ TIME     │MARKET │ SIDE │LEVEL│ENTRY │ EXIT │ P&L  │TRIGGER│
│ 12:31:04 │MIA@BOS│S BOS │ L1  │64.0¢ │61.2¢│+$14.0│event  │
│ 12:25:42 │MIA@BOS│S BOS │ L2  │67.0¢ │63.1¢│+$19.5│event  │
│ 11:58:11 │NYK@DET│S NYK │ L1  │55.0¢ │52.8¢│+$11.0│TP     │
│ 11:44:30 │NYK@DET│S DET │ L1  │48.0¢ │49.2¢│ -$6.0│timeout│
└──────────┴───────┴──────┴─────┴──────┴──────┴──────┴───────┘
```
- Timestamp (UTC + local)
- Market
- Side + ladder level
- Entry / exit prices
- P&L per trade
- Exit trigger: `event` / `TP` / `timeout` / `scoring_run`

### 5. Session Log (scrollable, timestamped)
```
┌─────────────────────────────────────────────────────────────┐
│ 📝 SESSION LOG                              auto-scroll ↓   │
│                                                             │
│ 12:31:05 [TRADE]  Closed SHORT BOS L1 @ 61.2¢ → +$14.00   │
│ 12:31:04 [EVENT]  BOS: Tatum 3-pointer (85-91 Q3 4:32)     │
│ 12:25:44 [ORDER]  Placed L1: SELL BOS @ 64.0¢ × 500        │
│ 12:25:44 [ORDER]  Placed L2: SELL BOS @ 67.0¢ × 500        │
│ 12:25:44 [ORDER]  Placed L3: SELL BOS @ 70.0¢ × 500        │
│ 12:25:42 [SHOCK]  MIA@BOS: +4.2¢ (3.1σ) → single_event ✅  │
│ 12:25:42 [POLL]   Burst poll triggered (3×3s follow-ups)    │
│ 12:20:00 [SCAN]   11 markets discovered, 4 live             │
│ 12:19:58 [SYS]    WebSocket reconnected (was down 2.1s)     │
│ 12:00:01 [SYS]    Session started — Paper Mode              │
└─────────────────────────────────────────────────────────────┘
```
- Auto-scroll to latest (toggle to pause)
- Color-coded by type: `[SYS]` gray, `[SHOCK]` yellow, `[ORDER]` blue, `[TRADE]` green/red, `[EVENT]` white, `[ERROR]` red
- Every entry has UTC timestamp
- Filterable by type

---

## Responsive Behavior

### Desktop (>1200px)
- Full layout as described above
- Game cards side by side (2 per row) if multiple live games
- Trade history and session log side by side at bottom

### Tablet (768-1200px)
- Game cards stack vertically (1 per row)
- Trade history and session log in tabs

### Mobile (<768px)
- Stats strip wraps to 2 rows
- Game cards full-width, vertically stacked
- Collapsible sections (tap to expand)
- Session log collapsed by default (tap to show)
- **Glance view**: Just header bar (P&L, win rate, status) visible without scrolling

---

## Live Mode Additions

When running in live mode, the dashboard adds:

### Wallet Strip (below header)
```
┌─────────────────────────────────────────────────────────────┐
│ 💰 USDC: $2,450.00 │ Pre-split: 1,500/1,500 │ MATIC: 0.82 │
│ Available: $1,200   │ Reserved: $1,250        │ Gas OK ✅    │
└─────────────────────────────────────────────────────────────┘
```

### Per-game card additions
- Pre-split inventory for this game (shares available at each ladder level)
- Real fill confirmations (tx hash links to Polygonscan)
- Slippage tracking (expected vs actual fill price)

---

## Color Palette

### Paper Mode
- Background: `#0f1923` (dark navy)
- Cards: `#1a2332` 
- Accent: `#6366f1` (indigo/purple)
- Header gradient: indigo → purple (current)

### Live Mode  
- Background: `#1a1209` (dark amber-tint)
- Cards: `#231c10`
- Accent: `#f59e0b` (amber)
- Header gradient: amber → red
- Warning banner: `#dc2626` (red)

### Shared
- Positive P&L: `#22c55e` (green)
- Negative P&L: `#ef4444` (red)  
- Neutral: `#94a3b8` (slate gray)
- Sport badges: NBA 🟠, NFL 🟢, NHL ⚪, ⚽ 🔵

---

## Data Flow (WebSocket Messages)

Dashboard connects to single WS endpoint. Server pushes:

| Event | Payload | Updates |
|-------|---------|---------|
| `market_update` | bid/ask/spread/depth for both tokens | Game card book data |
| `score_update` | teams, score, period, clock | Game card score |
| `shock_detected` | market, move, z-score, classification | Shock status, log |
| `order_placed` | market, side, level, price, size | Orders section, log |
| `order_filled` | market, level, fill_price, shares | Orders → position, log |
| `order_cancelled` | market, level, reason | Orders section, log |
| `position_closed` | market, exit_price, pnl, trigger | Trade history, stats, log |
| `game_event` | sport, type, details, timestamp | Event feed, log |
| `game_state` | status (upcoming/live/settled) | Section placement |
| `system` | message, level | Session log |
| `stats` | aggregated KPIs | Stats strip |
| `wallet` | balances (live mode only) | Wallet strip |

---

## Implementation Notes

- **Tech**: Same stack — single HTML file, vanilla JS, WebSocket
- **No framework**: Keep it lightweight, no React/Vue overhead
- **Auto-reconnect**: WS reconnect with exponential backoff + visual indicator
- **Timezone**: Show both UTC and local (GMT+7) on hover, primary display in local
- **Persistence**: Dashboard state survives page refresh (WS sends full state on connect)
- **URL params**: `?mode=paper` or `?mode=live` (different ports: 3032 paper, 3033 live)
