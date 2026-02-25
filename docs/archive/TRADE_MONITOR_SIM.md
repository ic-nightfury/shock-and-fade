# Trade Monitor Simulation Dashboard

Real-time web-based monitoring dashboard for the Polymarket arbitrage strategy simulation.

---

## Overview

**trade_monitor_sim** provides live visualization of simulated trading activity, including:
- Price movements with bid/ask spreads
- Pending orders and fills
- Position tracking and P&L
- Strategy mode and BALANCING cycle progress
- Market countdown and settlement tracking

---

## Quick Start

```bash
cd trade_monitor_sim
npm install
npm run dev
```

Opens dashboard at http://localhost:5175

---

## Architecture

```
Polymarket WebSocket (Real Prices)
         |
    Price Server (3001)
         |
   Dashboard useMarketPrices Hook
         |
    PriceChart Component

Arbitrage Simulation (3002-3011)
         |
    State Relay Server (3003)
         |
   Dashboard useSimulationState Hook
         |
  Position, Orders, Strategy Components
```

---

## Port Configuration

| Service | Port | Purpose |
|---------|------|---------|
| Vite Dev Server | 5175 | Frontend (React app) |
| Price Relay | 3001 | Real Polymarket prices via WebSocket |
| Simulation | 3002-3011 | Arbitrage simulation state (dynamic) |
| State Relay | 3003 | Bridge from simulation to dashboard |

---

## Technology Stack

**Frontend**
- React 19 with hooks
- Vite 6 bundler
- Recharts for price visualization
- Tailwind CSS for styling

**Backend**
- Express 4.21 REST API
- WebSocket (ws) for real-time streaming
- TypeScript

---

## Directory Structure

```
trade_monitor_sim/
├── src/                          # React frontend
│   ├── components/               # UI components
│   │   ├── PriceChart.jsx        # Interactive price chart
│   │   ├── PositionSummary.jsx   # Holdings and P&L
│   │   ├── MarketStats.jsx       # Current prices
│   │   ├── ActivityFeed.jsx      # Event log
│   │   ├── OrderBookPanel.jsx    # Pending orders
│   │   └── LogPanel.jsx          # Raw messages
│   ├── hooks/                    # Custom React hooks
│   │   ├── useSimulationState.js # Simulation state
│   │   ├── useMarketPrices.js    # Polymarket prices
│   │   ├── useWebSocket.js       # Generic WebSocket
│   │   └── useBotOrders.js       # Order management
│   ├── utils/
│   │   └── formatters.js         # Price/time formatting
│   ├── App.jsx                   # Main dashboard
│   └── main.jsx                  # Entry point
├── server/                       # State relay (3003)
│   └── index.ts
├── price-server/                 # Price relay (3001)
│   └── index.ts
├── vite.config.js
└── package.json
```

---

## NPM Scripts

```bash
npm run dev          # Start all servers (Vite + price + state relay)
npm run client       # Vite dev server only
npm run server       # State relay server only
npm run price-server # Price relay server only
npm run build        # Production build
npm run preview      # Preview production build
```

---

## Key Components

### Price Chart (`PriceChart.jsx`)

- Shaded bid/ask spread bands for UP and DOWN
- 1-minute sliding window of price history
- Pending order reference lines (colored by side)
- Hedge orders shown as dashed yellow lines
- Y-axis 0-100 cents, X-axis 1-second ticks

### Position Summary

- UP/DOWN holdings, average cost, current value
- Pair cost calculation (avgUP + avgDOWN)
- Unrealized P&L at current bid prices
- Merged pairs counter
- Imbalance percentage with warning indicator

### Activity Feed

- Scrolling event log with color-coded icons
- Event types: ORDER_PLACED, ORDER_FILLED, ORDER_CANCELLED, MARKET_SWITCH, MERGE
- Auto-scrolls to new events

---

## Dashboard Features

**Header**
- Market slug and countdown timer
- Strategy mode (NORMAL/BALANCING/PROFIT_LOCK/PAIR_IMPROVEMENT)
- Connection status indicators

**BALANCING Display**
- Current phase (TRIGGER/HEDGE/MONITOR)
- Cycle progress (e.g., "Cycle 2/5")
- Trigger and hedge side indicators

**Session Stats**
- Markets run count
- Total session P&L

---

## Servers

### Price Relay Server (`price-server/index.ts`)

- Queries Gamma API for current 15-minute BTC markets
- Connects to Polymarket WebSocket
- Extracts best bid/ask from order books
- Detects market switches every 5 seconds
- Broadcasts prices to all connected dashboards

### State Relay Server (`server/index.ts`)

- Auto-detects running simulation instances (ports 3002-3011)
- Reconnects automatically on disconnect
- Broadcasts simulation state to dashboards
- Exposes `/api/state` and `/api/health` endpoints

---

## Color Coding

| Element | Color |
|---------|-------|
| UP side | Green (#10B981) |
| DOWN side | Red (#EF4444) |
| Hedge orders | Yellow (#FBBF24) dashed |
| Connected | Green dot |
| Disconnected | Red dot |

---

## Performance

- **Throttled updates**: Max 1 price update per 100ms
- **History capping**: Max 900 data points (15 min at 1/sec)
- **Market switch reset**: Clears history on new market
- **Auto-reconnect**: 3-second retry interval

---

## Integration with Arbitrage Bot

1. Run simulation: `npm run arb:sim` (main project)
2. Simulation broadcasts state on port 3002-3011
3. State relay captures and forwards to dashboard
4. Price server provides live Polymarket prices
5. Dashboard displays synchronized simulation + market data

---

*Last Updated: 2026-01-12*
