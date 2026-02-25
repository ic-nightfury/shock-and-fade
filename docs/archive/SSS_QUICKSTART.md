# SSS Strategy Quickstart Guide

Get the Sports Split-Sell strategy running in 5 minutes.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Installation](#2-installation)
3. [Environment Setup](#3-environment-setup)
4. [Running Paper Trading](#4-running-paper-trading)
5. [Running Live Trading](#5-running-live-trading)
6. [Dashboard Access](#6-dashboard-access)
7. [Server Deployment](#7-server-deployment)
8. [Monitoring and Logs](#8-monitoring-and-logs)
9. [Emergency Stop](#9-emergency-stop)

---

## 1. Prerequisites

### Required Software

| Software | Version | Check Command |
|----------|---------|---------------|
| Node.js | 18+ | `node --version` |
| npm | 8+ | `npm --version` |
| Git | Any | `git --version` |

### Required Credentials

You need the following from your Polymarket account:

1. **Wallet Private Key** - From your Polymarket-connected wallet
2. **Funder Address** - Your Gnosis Safe proxy address (shown in Polymarket settings)
3. **Builder API Credentials** (for SPLIT/MERGE operations):
   - `BUILDER_API_KEY`
   - `BUILDER_SECRET`
   - `BUILDER_PASS_PHRASE`

---

## 2. Installation

```bash
# Clone repository (if not already done)
git clone <repo-url> poly_arbitrage
cd poly_arbitrage

# Install dependencies
npm install

# Build TypeScript
npm run build
```

---

## 3. Environment Setup

### Create `.env` File

Copy the example and edit with your credentials:

```bash
cp .env.example .env
```

### Required Environment Variables

```bash
# Polymarket Credentials
POLYMARKET_PRIVATE_KEY=0x...your-private-key...
POLYMARKET_FUNDER=0x...your-funder-address...
POLYMARKET_HOST=https://clob.polymarket.com

# Builder Relayer (for SPLIT/MERGE)
BUILDER_API_KEY=your-api-key
BUILDER_SECRET=your-secret
BUILDER_PASS_PHRASE=your-passphrase

# Network
RPC_URL=https://polygon-rpc.com
CHAIN_ID=137
```

### Verify Setup

```bash
# Test that credentials work
npx tsx src/scripts/test-credentials.ts
```

---

## 4. Running Paper Trading

Paper trading uses **real market data** but **simulated order execution**. This is the recommended way to validate the strategy before using real money.

### Start Paper Trading

```bash
# Basic (default $1000 balance, $10 bet size)
npx tsx src/run-sports-split-sell-paper.ts

# With custom parameters
npx tsx src/run-sports-split-sell-paper.ts --balance 500 --bet-size 5

# With dashboard enabled
npx tsx src/run-sports-split-sell-paper.ts --balance 1000 --bet-size 10 --dashboard
```

### CLI Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--balance` | 1000 | Starting paper balance in USDC |
| `--bet-size` | 10 | Position size per game in USDC |
| `--dashboard` | false | Enable web dashboard on port 3031 |

### Expected Output

```
🏈 Sports Split-Sell Strategy (PAPER)
=====================================
Starting balance: $1,000.00
Bet size: $10
Dashboard: http://localhost:3031

[15:30:00] 📡 Starting market discovery...
[15:30:05] 🔍 Found 8 live sports markets
[15:30:05] 🏒 NHL: nhl-sea-ana-2026-02-03 (YES: 48c, NO: 52c)
[15:30:06] 🏀 NBA: nba-phi-gsw-2026-02-03 (YES: 55c, NO: 45c)
...
[15:35:00] 💰 SPLIT $10 on nhl-sea-ana-2026-02-03
[15:45:00] 📉 NO dropped to 23c (threshold: 25c) - SELL triggered
[15:45:01] ✅ Sold 10 NO @ 23c = $2.30 revenue
[17:30:00] 🏆 Settlement: YES won @ $1.00
[17:30:01] 💵 Position P&L: +$2.30 (23.0% ROI)
```

### Minimum Paper Trading Duration

Run paper trading for at least **20 games** across different sports before going live. This typically takes 2-3 days.

---

## 5. Running Live Trading

**WARNING: Live trading uses real money. Double-check your configuration before starting.**

### Start Live Trading

```bash
# Test mode (no real trades, just logs what would happen)
npx tsx src/run-sports-split-sell.ts --test

# Live mode with dashboard
npx tsx src/run-sports-split-sell.ts --dashboard

# Live mode with custom bet size
npx tsx src/run-sports-split-sell.ts --bet-size 25 --dashboard
```

### CLI Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--bet-size` | 10 | Position size per game in USDC |
| `--dashboard` | false | Enable web dashboard on port 3030 |
| `--test` | false | Test mode (no real trades) |

### Recommended Progression

1. **Week 1**: $5 positions, monitor closely
2. **Week 2**: $10 positions if Week 1 results match expectations
3. **Week 3+**: Scale to $25-50 based on performance
4. **Month 2+**: Consider $100 positions with 50+ successful trades

---

## 6. Dashboard Access

### Paper Trading Dashboard

- **URL**: http://localhost:3031
- **Theme**: Blue (indicates paper trading)
- **Banner**: "PAPER TRADING" header

### Live Trading Dashboard

- **URL**: http://localhost:3030
- **Theme**: Green (indicates live trading)
- **Banner**: "LIVE TRADING" warning header

### Dashboard Layout (Revamped US-800 Series)

The dashboard uses a **section-based layout** that separates positions by their state for quick at-a-glance understanding:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       SUMMARY STATS BAR (sticky)                         │
│  Balance │ Deployed │ Pending Sell │ Watching │ Holding │ Today P&L     │
│   $890   │   $100   │      1       │    7     │    3    │   +$5.20      │
└─────────────────────────────────────────────────────────────────────────┘
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ 🔶 PENDING SELLS (1) - URGENT                                       ││
│  │ ┌───────────────────────────────────────────────────────────────┐  ││
│  │ │ 🏒 NHL │ SEA vs ANA │ ANA @ 27c │ ONLY 2c AWAY! │ ████████░░│  ││
│  │ └───────────────────────────────────────────────────────────────┘  ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ 🔵 WATCHING (7) - Holding Both Sides                                ││
│  │ ┌─────────────────────────┐ ┌─────────────────────────┐             ││
│  │ │ 🏀 NBA PHI vs GSW      │ │ 🏒 NHL CAR vs COL      │             ││
│  │ │ PHI: 55c │ GSW: 45c   │ │ CAR: 48c │ COL: 52c   │             ││
│  │ │ ██████░░░░ │ ████░░░░░│ │ █████░░░░ │ ██████░░░░│             ││
│  │ └─────────────────────────┘ └─────────────────────────┘             ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ 🟢 HOLDING WINNERS (3) - Loser Sold                                 ││
│  │ ┌───────────────────────────────────────────────────────────────┐  ││
│  │ │ ✅ BOS vs MIA │ Holding: BOS @ 87c │ Sold: MIA @ 22c → $2.20  │  ││
│  │ │ Projected P&L: +$2.00                                          │  ││
│  │ └───────────────────────────────────────────────────────────────┘  ││
│  └─────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────┘
```

### Dashboard Sections

| Section | Color | Shows | Purpose |
|---------|-------|-------|---------|
| **Summary Stats Bar** | Gray (sticky) | Balance, counts, P&L | Always-visible key metrics |
| **Pending Sells** | Orange 🔶 | Positions within 10c of threshold | URGENT - monitor closely |
| **Watching** | Blue 🔵 | Positions holding both sides | Monitor for threshold approach |
| **Holding Winners** | Green 🟢 | Positions with loser sold | Track to settlement |

### Progress Bars

Each position shows a **visual progress bar** indicating how close the price is to the sell threshold:

```
Progress = (50c - currentBid) / (50c - threshold) × 100%
```

| Progress | Color | Meaning |
|----------|-------|---------|
| 0-60% | Green | Far from threshold |
| 60-80% | Yellow | Approaching threshold |
| 80-100% | Red | Sell imminent |
| 100%+ | Red flash | AT THRESHOLD or BELOW |

**Example:** For NHL (25c threshold):
- Price at 50c → 0% (far from threshold)
- Price at 35c → 60% (approaching)
- Price at 27c → 92% (imminent)
- Price at 25c → 100% (sell triggers)

### Urgency Indicators (Pending Sells)

Positions in the Pending Sells section have urgency color-coding:

| Urgency | Distance | Visual |
|---------|----------|--------|
| Normal | >5c from threshold | Green border |
| Caution | ≤5c from threshold | Yellow border, pulsing |
| Imminent | ≤2c from threshold | Red border, pulsing, "ONLY Xc AWAY!" badge |

### Real-Time Price Animations

Prices update in real-time via WebSocket with visual feedback:

- **Price increase**: Brief green flash (300ms)
- **Price decrease**: Brief red flash (300ms)
- **Threshold change**: Only animates if change ≥1c (ignores noise)
- **Section transitions**: Smooth animation when positions move between sections

### Stale Data Indicator

Each position shows a "last updated" timestamp:

| Indicator | Meaning |
|-----------|---------|
| `Updated 3s ago` | Fresh data (green) |
| `Updated 45s ago` | Normal (white) |
| `⚠️ Updated 90s ago` | Stale warning (yellow) |

### Pending Settlement Section

The **Pending Settlement** section shows positions where the game has ended but settlement hasn't completed yet. These positions are awaiting redemption or manual action.

#### Understanding Pending Settlement

| Element | Description |
|---------|-------------|
| **⏳ Icon** | Indicates position is waiting for settlement |
| **Winner Name** | The outcome that won (determined by 99c+ price) |
| **Held Shares** | Number of winner tokens you're holding |
| **Game Ended** | How long ago the game ended |
| **Settlement Status** | "Awaiting" (normal) or "Delayed" (>1 hour) |

#### Settlement Delay Indicators

Positions are color-coded based on how long they've been waiting:

| Time Since End | Visual | Meaning |
|----------------|--------|---------|
| < 1 hour | Gray border | Normal - settlement in progress |
| ≥ 1 hour | Yellow/amber border | Delayed - may need attention |

**Why delays happen:**
- Polymarket settlement typically completes within 30-60 minutes
- Delays can occur during high volume periods or for disputed outcomes
- Very rarely, manual review may be required

#### When to Take Action

Most positions settle automatically. However, if a position shows "Delayed" status for **2+ hours**, consider:
1. Check the game status on Polymarket.com directly
2. If game is confirmed settled, use the Force Sell button (see below)
3. Report persistent issues to Polymarket support

### Force Sell Button

The **Force Sell** button appears on pending settlement positions that have **unsold shares**. This happens when a game ended but the loser side never hit the sell threshold.

#### When Force Sell Appears

Force Sell is available when:
- Position state is `PENDING_SETTLEMENT` or `HOLDING`
- One or both sides still have unsold shares
- Current BID price is available for the unsold side

#### Using Force Sell

1. Locate a pending settlement card with the "Sell [Outcome] @ Xc" button
2. Click the button to open the confirmation modal
3. Review the expected revenue shown
4. Click "Confirm Sell" to execute

**Force Sell Modal:**
```
┌────────────────────────────────────┐
│          Force Sell                │
├────────────────────────────────────┤
│ ⚠️ This position has unsold shares │
│                                    │
│ Sell 10 NO shares at market        │
│ price (~22c)?                      │
│                                    │
│ Expected revenue: $2.20            │
│                                    │
│ Warning: This executes a MARKET    │
│ sell order. The actual fill price  │
│ may vary based on order book depth.│
│                                    │
│  [Cancel]        [Confirm Sell]    │
└────────────────────────────────────┘
```

#### Force Sell Use Cases

| Scenario | Recommendation |
|----------|----------------|
| Game ended, loser at 2-5c | Force sell to capture remaining value |
| Settlement delayed > 2 hours | Force sell to free up capital |
| Both sides still held | Force sell loser, hold winner to settlement |
| Winner held, loser never sold | Force sell loser at current price |

**Note:** Force Sell executes a MARKET order for speed. Actual fill price may be slightly lower than displayed BID due to slippage.

### Dashboard Panels (Legacy Reference)

The following panels are also available:

| Panel | Description |
|-------|-------------|
| **Upcoming Games** | Games within time horizon with countdown timers |
| **P&L Summary** | Total, realized, unrealized, by sport |
| **Trade History** | Last 100 trades with details |
| **Market Health** | Liquidity, spread, staleness warnings |

### Upcoming Games Panel

The Upcoming Games panel shows all discovered sports games within your selected time horizon. This helps you identify entry opportunities and monitor game status.

#### Time Horizon Selector

Use the dropdown to filter games by how soon they start:

| Option | Shows Games |
|--------|-------------|
| 6h | Starting within 6 hours |
| 12h | Starting within 12 hours |
| **24h** | Starting within 24 hours (default) |
| 48h | Starting within 48 hours |

#### Game Status Badges

Each game displays a status badge indicating its current state:

| Badge | Color | Meaning |
|-------|-------|---------|
| **SCHEDULED** | Gray | Game hasn't started yet |
| **ENTRY OPEN** | Green | Within first 10 minutes - can enter now! |
| **LIVE** | Red | Game in progress, entry window closed |
| **ENTERED** | Blue | You have an active position |

#### Countdown Timer

The timer column shows:

- **Before game starts**: `Starts in 11h 23m` or `45m 12s` (shows seconds when < 1 hour)
- **During entry window**: `Entry closes in 8m 32s` (green text, countdown to 10-minute mark)
- **After entry window**: `LIVE 23m` (red text, elapsed time since start)

Timers update every second automatically - no need to refresh.

#### Price Highlighting

Prices between 45c-55c are highlighted in green, indicating balanced odds optimal for SSS entry.

#### Force Entry Button (Paper Trading Only)

In paper trading mode, a "Split" button appears in the Actions column:

1. Click "Split" on any game row
2. A confirmation modal appears showing the teams
3. Enter bet size (default $10)
4. Click "Confirm Split" to execute the paper trade
5. Success/error notification appears as a toast

**Note:** Force Entry is disabled in live mode (returns 403 error).

#### Polymarket Link

Click the 🔗 icon in the Actions column to open the game on Polymarket.com in a new tab.

### Remote Dashboard Access

When running on a server, access the dashboard via SSH tunnel:

```bash
# Paper dashboard
ssh -L 3031:localhost:3031 root@65.21.146.43

# Live dashboard
ssh -L 3030:localhost:3030 root@65.21.146.43

# Then open in browser: http://localhost:3030 or :3031
```

---

## 7. Server Deployment

### Deploy to Finland Server (65.21.146.43)

```bash
# From local machine
cd poly_arbitrage
./scripts/deploy-sports-sss.sh

# Or with auto-start
./scripts/deploy-sports-sss.sh --start
```

### Manual Deployment

```bash
# 1. Sync code (excludes .env, node_modules, logs)
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude '*.log' \
  --exclude '.env' --exclude '.env.*' --exclude 'tick_data*' \
  ./ root@65.21.146.43:/root/poly_arbitrage/

# 2. SSH to server
ssh root@65.21.146.43

# 3. Install dependencies
cd /root/poly_arbitrage
npm install

# 4. Copy systemd service
cp scripts/systemd/polymarket-sports-sss.service /etc/systemd/system/

# 5. Start service
systemctl daemon-reload
systemctl enable polymarket-sports-sss
systemctl start polymarket-sports-sss
```

### Systemd Service Commands

```bash
# Status
systemctl status polymarket-sports-sss

# Start/Stop/Restart
systemctl start polymarket-sports-sss
systemctl stop polymarket-sports-sss
systemctl restart polymarket-sports-sss

# View logs
journalctl -u polymarket-sports-sss -f
```

---

## 8. Monitoring and Logs

### Log Files

| Log | Location | Description |
|-----|----------|-------------|
| Main log | `/root/poly_arbitrage/logs/sss_live.log` | All trading activity |
| Paper log | `/root/poly_arbitrage/logs/sss_paper.log` | Paper trading activity |
| Positions | `/root/poly_arbitrage/data/sss_positions.json` | Persisted positions |

### Monitoring Commands

```bash
# Follow live logs
ssh root@65.21.146.43 'tail -f /root/poly_arbitrage/logs/sss_live.log'

# Check recent entries
ssh root@65.21.146.43 'grep "ENTRY\|SELL\|SETTLE" /root/poly_arbitrage/logs/sss_live.log | tail -50'

# Check P&L
ssh root@65.21.146.43 'grep "P&L" /root/poly_arbitrage/logs/sss_live.log | tail -10'

# Check for errors
ssh root@65.21.146.43 'grep "ERROR\|ALERT" /root/poly_arbitrage/logs/sss_live.log | tail -20'
```

### Alert System

The strategy emits alerts for:
- Unusual losses (> $20 per position)
- Consecutive errors (5+ in a row)
- Reversals (when held side loses)
- Failure streaks

Alerts are logged with emoji markers and can be routed to external systems via the `alert` event.

---

## 9. Emergency Stop

### Stop All Trading Immediately

```bash
# If running locally
Ctrl+C

# If running as service
ssh root@65.21.146.43 'systemctl stop polymarket-sports-sss'
```

### Cancel All Open Orders

```bash
# Emergency stop script
npx tsx src/cli/emergency-stop.ts --market all

# Dry run first
npx tsx src/cli/emergency-stop.ts --market all --dry-run
```

### Manual Position Recovery

If the bot stops unexpectedly with open positions:

1. Check position file: `cat data/sss_positions.json`
2. Manually sell any tokens you don't want to hold
3. Or wait for settlement if you believe in the position
4. MERGE any paired tokens that weren't sold

---

## Supported Sports

The SSS strategy currently supports the following sports:

| Sport | Status | Sell Threshold | Season |
|-------|--------|----------------|--------|
| **NHL** | ✅ Enabled | 25c | Oct-Jun |
| **NFL** | ✅ Enabled | 20c | Sept-Feb |
| **NBA** | ✅ Enabled | 15c | Oct-Jun |
| **Soccer** | ⏳ Conditional | 30c | Year-round |

### Soccer Leagues

Soccer is enabled conditionally pending tick data validation. The following leagues are supported:

| League | Prefix | Status | Avg Volume |
|--------|--------|--------|-----------|
| EPL (Premier League) | `epl-` | CONDITIONAL GO | $15.6M |
| UCL (Champions League) | `ucl-` | CONDITIONAL GO | $7.5M |
| La Liga | `lal-` | NEEDS MORE DATA | $39.8M |
| Bundesliga | `bun-` | NEEDS MORE DATA | $2.5M |

See [SSS_STRATEGY.md](./SSS_STRATEGY.md) for full details on soccer league integration.

---

## Sport Filter Tabs

The dashboard includes sport filter tabs to focus on specific sports:

### Using Filter Tabs

1. Click on any sport tab (ALL, NHL, NFL, NBA, SOCCER) at the top of the Upcoming Games panel
2. The games list filters to show only that sport
3. The filter persists in the URL (e.g., `?sport=NHL`)
4. "ALL" shows games from all sports

### Sport Badge Colors

| Sport | Color |
|-------|-------|
| NHL | Blue (#3498db) |
| NFL | Green (#27ae60) |
| NBA | Orange (#e67e22) |
| SOCCER | Purple (#9b59b6) |

---

## Quick Reference

### Commands Summary

| Task | Command |
|------|---------|
| Paper trading | `npx tsx src/run-sports-split-sell-paper.ts --dashboard` |
| Live trading (test) | `npx tsx src/run-sports-split-sell.ts --test --dashboard` |
| Live trading (real) | `npx tsx src/run-sports-split-sell.ts --dashboard` |
| Deploy to server | `./scripts/deploy-sports-sss.sh --start` |
| Stop service | `systemctl stop polymarket-sports-sss` |
| View logs | `tail -f logs/sss_live.log` |

### Ports

| Service | Port |
|---------|------|
| Paper Dashboard | 3031 |
| Live Dashboard | 3030 |

### Servers

| Server | IP | Purpose |
|--------|-----|---------|
| Finland | 65.21.146.43 | Live trading |
| Helsinki | 65.108.219.235 | Paper trading / testing |

---

## Next Steps

1. Read [SSS_STRATEGY.md](./SSS_STRATEGY.md) for full strategy details
2. Read [SSS_ARCHITECTURE.md](./SSS_ARCHITECTURE.md) for component overview
3. Check [analysis/sss_research_summary.md](../analysis/sss_research_summary.md) for research backing
4. Review [SSS_LESSONS_LEARNED.md](./SSS_LESSONS_LEARNED.md) for operational insights

---

*Last Updated: 2026-02-04*
