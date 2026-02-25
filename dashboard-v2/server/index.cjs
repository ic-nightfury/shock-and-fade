/**
 * Dashboard Backend Server (CommonJS version)
 *
 * This is the same as index.ts but in plain CommonJS JavaScript
 * to avoid tsx/ESM issues that cause RSV1 WebSocket errors.
 */

const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const axios = require("axios");
const path = require("path");

const app = express();
const server = http.createServer(app);

// WebSocket servers for different purposes
// Disable perMessageDeflate to avoid "Invalid frame header" errors with browser clients
const priceWss = new WebSocketServer({
  server,
  path: "/prices",
  perMessageDeflate: false,
});
const botWss = new WebSocketServer({
  server,
  path: "/bot",
  perMessageDeflate: false,
});

// Serve static files from the dist folder
app.use(express.static(path.join(__dirname, "../dist")));

// Parse port from CLI args (--port 3002) or default to 3001
const portArg = process.argv.find((arg, i) => process.argv[i - 1] === "--port");
const PORT = portArg ? parseInt(portArg) : 3001;
const POLYMARKET_WSS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const GAMMA_API = "https://gamma-api.polymarket.com";

let currentMarket = null;
let polymarketWs = null;
let latestPrices = null;
let polymarketPingInterval = null;
let isReconnecting = false;

// Price WebSocket clients (dashboard frontends connecting to /prices)
const priceClients = new Set();

// Bot WebSocket connections
const botClients = new Set(); // Bots that send events
const botFrontendClients = new Set(); // Dashboard frontends listening for bot events

// Cached bot state for new frontend connections
const cachedBotState = {
  market: null,
  position: null,
  orders: new Map(),
  surgeLine: null,
  hedgeLine: null,
};

// Legacy alias for backward compatibility
const clients = priceClients;

// Get current 15-min BTC market
async function getCurrentBTCMarket() {
  try {
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const currentWindowStart = Math.floor(currentTimestamp / (15 * 60)) * (15 * 60);
    const slug = `btc-updown-15m-${currentWindowStart}`;

    console.log(`[Market] Fetching market: ${slug}`);

    const response = await axios.get(`${GAMMA_API}/markets?slug=${slug}`);

    if (!response.data || response.data.length === 0) {
      console.log("[Market] No market found for slug:", slug);
      return null;
    }

    const market = response.data[0];
    const tokenIds = JSON.parse(market.clobTokenIds);
    const outcomes = JSON.parse(market.outcomes);

    // Find UP and DOWN token IDs
    const upIndex = outcomes.findIndex((o) => o.toLowerCase() === "up");
    const downIndex = outcomes.findIndex((o) => o.toLowerCase() === "down");

    return {
      slug: market.slug,
      upTokenId: tokenIds[upIndex],
      downTokenId: tokenIds[downIndex],
      endTime: Math.floor(new Date(market.endDate).getTime() / 1000),
      question: market.question,
    };
  } catch (error) {
    console.error("[Market] Error fetching market:", error);
    return null;
  }
}

// Clean up Polymarket connection
function cleanupPolymarketConnection() {
  if (polymarketPingInterval) {
    clearInterval(polymarketPingInterval);
    polymarketPingInterval = null;
  }
  if (polymarketWs) {
    polymarketWs.removeAllListeners();
    if (polymarketWs.readyState === WebSocket.OPEN || polymarketWs.readyState === WebSocket.CONNECTING) {
      polymarketWs.close();
    }
    polymarketWs = null;
  }
}

// Connect to Polymarket WebSocket
function connectToPolymarket() {
  if (isReconnecting) return;

  cleanupPolymarketConnection();

  if (!currentMarket) {
    console.log("[Polymarket] No market to subscribe to");
    return;
  }

  console.log(`[Polymarket] Connecting to WSS for ${currentMarket.slug}`);
  isReconnecting = true;

  // Disable compression to avoid RSV1 frame header issues
  polymarketWs = new WebSocket(POLYMARKET_WSS, { perMessageDeflate: false });

  polymarketWs.on("open", () => {
    console.log("[Polymarket] WebSocket connected");
    isReconnecting = false;

    const subscribeMsg = {
      type: "Market",
      assets_ids: [currentMarket.upTokenId, currentMarket.downTokenId],
    };

    polymarketWs.send(JSON.stringify(subscribeMsg));
    console.log("[Polymarket] Subscribed to tokens:", currentMarket.upTokenId.slice(0, 8), currentMarket.downTokenId.slice(0, 8));

    polymarketPingInterval = setInterval(() => {
      if (polymarketWs && polymarketWs.readyState === WebSocket.OPEN) {
        polymarketWs.ping();
      }
    }, 30000);
  });

  polymarketWs.on("pong", () => {});

  polymarketWs.on("message", (data) => {
    try {
      const messages = JSON.parse(data.toString());

      for (const msg of Array.isArray(messages) ? messages : [messages]) {
        if (msg.event_type === "book" && msg.asset_id && currentMarket) {
          const isUp = msg.asset_id === currentMarket.upTokenId;

          const bids = msg.bids || [];
          const asks = msg.asks || [];

          const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
          let bestAsk = 1;
          if (asks.length > 0) {
            bestAsk = parseFloat(asks[asks.length - 1].price);
          }

          if (!latestPrices) {
            latestPrices = { upBid: 0.5, upAsk: 0.5, downBid: 0.5, downAsk: 0.5, timestamp: Date.now() };
          }

          if (isUp) {
            latestPrices.upBid = bestBid;
            latestPrices.upAsk = bestAsk;
          } else {
            latestPrices.downBid = bestBid;
            latestPrices.downAsk = bestAsk;
          }
          latestPrices.timestamp = Date.now();

          broadcastPrices();
        }
      }
    } catch (error) {
      // Ignore parse errors
    }
  });

  polymarketWs.on("close", () => {
    console.log("[Polymarket] WebSocket closed");
    isReconnecting = false;

    if (polymarketPingInterval) {
      clearInterval(polymarketPingInterval);
      polymarketPingInterval = null;
    }

    if (currentMarket) {
      setTimeout(connectToPolymarket, 3000);
    }
  });

  polymarketWs.on("error", (error) => {
    console.error("[Polymarket] WebSocket error:", error.message);
    isReconnecting = false;
  });
}

// Broadcast prices to all connected dashboard clients
function broadcastPrices() {
  if (!latestPrices || clients.size === 0) return;

  const message = JSON.stringify({ type: "PRICE_UPDATE", data: latestPrices });

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Track client alive status for ping/pong
const clientAlive = new Map();

// Handle dashboard client connections for PRICES (/prices endpoint)
priceWss.on("connection", (ws) => {
  console.log("[Prices] Client connected");
  priceClients.add(ws);
  clientAlive.set(ws, true);

  if (currentMarket) {
    ws.send(JSON.stringify({ type: "MARKET_INFO", data: currentMarket }));
  }

  if (latestPrices) {
    ws.send(JSON.stringify({ type: "PRICE_UPDATE", data: latestPrices }));
  }

  ws.on("pong", () => { clientAlive.set(ws, true); });

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type === "ping") {
        clientAlive.set(ws, true);
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      }
    } catch {}
  });

  ws.on("close", () => {
    console.log("[Prices] Client disconnected");
    priceClients.delete(ws);
    clientAlive.delete(ws);
  });

  ws.on("error", (error) => {
    console.error("[Prices] Client error:", error.message);
    priceClients.delete(ws);
    clientAlive.delete(ws);
  });
});

// BOT RELAY WebSocket (/bot endpoint)
function broadcastToBotFrontends(message) {
  for (const client of botFrontendClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function sendCachedBotState(ws) {
  if (cachedBotState.market) {
    ws.send(JSON.stringify({ type: "MARKET_SWITCH", data: cachedBotState.market }));
  }
  for (const order of cachedBotState.orders.values()) {
    ws.send(JSON.stringify({ type: "ORDER_PLACED", data: order }));
  }
  if (cachedBotState.position) {
    ws.send(JSON.stringify({ type: "POSITION_UPDATE", data: cachedBotState.position }));
  }
  if (cachedBotState.surgeLine?.active) {
    ws.send(JSON.stringify({ type: "SURGE_LINE", data: cachedBotState.surgeLine }));
  }
  if (cachedBotState.hedgeLine?.active) {
    ws.send(JSON.stringify({ type: "HEDGE_LINE", data: cachedBotState.hedgeLine }));
  }
}

botWss.on("connection", (ws) => {
  console.log("[Bot] New connection");
  let isBot = false;
  clientAlive.set(ws, true);

  ws.on("pong", () => { clientAlive.set(ws, true); });

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === "ping") {
        clientAlive.set(ws, true);
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        return;
      }

      if (message.type === "BOT_REGISTER") {
        isBot = true;
        botClients.add(ws);
        console.log(`[Bot] Bot registered (${botClients.size} bots, ${botFrontendClients.size} frontends)`);
        broadcastToBotFrontends(JSON.stringify({ type: "CONNECTION_STATUS", data: { connected: true, botCount: botClients.size } }));
        return;
      }

      if (isBot) {
        const rawMessage = data.toString();

        switch (message.type) {
          case "MARKET_SWITCH":
            cachedBotState.market = message.data;
            cachedBotState.orders.clear();
            cachedBotState.surgeLine = null;
            cachedBotState.hedgeLine = null;
            break;
          case "ORDER_PLACED":
            cachedBotState.orders.set(message.data.orderId?.toLowerCase(), message.data);
            break;
          case "ORDER_FILLED":
          case "ORDER_CANCELLED":
            cachedBotState.orders.delete(message.data.orderId?.toLowerCase());
            break;
          case "POSITION_UPDATE":
            cachedBotState.position = message.data;
            break;
          case "SURGE_LINE":
            cachedBotState.surgeLine = message.data;
            break;
          case "HEDGE_LINE":
            cachedBotState.hedgeLine = message.data;
            break;
        }

        broadcastToBotFrontends(rawMessage);
      }
    } catch {}
  });

  ws.on("close", () => {
    clientAlive.delete(ws);

    if (isBot) {
      botClients.delete(ws);
      console.log(`[Bot] Bot disconnected (${botClients.size} bots remaining)`);
      broadcastToBotFrontends(JSON.stringify({ type: "CONNECTION_STATUS", data: { connected: botClients.size > 0, botCount: botClients.size } }));
    } else {
      botFrontendClients.delete(ws);
      console.log(`[Bot] Frontend disconnected (${botFrontendClients.size} frontends remaining)`);
    }
  });

  ws.on("error", (error) => {
    console.error("[Bot] Connection error:", error.message);
    clientAlive.delete(ws);
    if (isBot) {
      botClients.delete(ws);
    } else {
      botFrontendClients.delete(ws);
    }
  });

  setTimeout(() => {
    if (!isBot && ws.readyState === WebSocket.OPEN) {
      botFrontendClients.add(ws);
      console.log(`[Bot] Frontend client registered (${botFrontendClients.size} frontends)`);
      ws.send(JSON.stringify({ type: "CONNECTION_STATUS", data: { connected: botClients.size > 0, botCount: botClients.size } }));
      sendCachedBotState(ws);
    }
  }, 1000);
});

// Ping dashboard clients every 30 seconds
setInterval(() => {
  for (const client of clients) {
    if (clientAlive.get(client) === false) {
      console.log("[Dashboard] Terminating unresponsive client");
      client.terminate();
      clients.delete(client);
      clientAlive.delete(client);
      continue;
    }
    clientAlive.set(client, false);
    if (client.readyState === WebSocket.OPEN) {
      client.ping();
    }
  }
}, 30000);

// Check for market switch every 5 seconds
async function checkMarketSwitch() {
  const newMarket = await getCurrentBTCMarket();

  if (newMarket && (!currentMarket || newMarket.slug !== currentMarket.slug)) {
    console.log(`[Market] Switching to new market: ${newMarket.slug}`);
    currentMarket = newMarket;
    latestPrices = null;

    const message = JSON.stringify({ type: "MARKET_SWITCH", data: currentMarket });
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });

    connectToPolymarket();
  }
}

// REST endpoints
app.get("/api/market", (req, res) => { res.json(currentMarket); });

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    market: currentMarket?.slug || null,
    priceClients: priceClients.size,
    botClients: botClients.size,
    botFrontendClients: botFrontendClients.size,
    polymarketConnected: polymarketWs?.readyState === WebSocket.OPEN,
  });
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../dist/index.html"));
});

// Start server
server.listen(PORT, async () => {
  console.log(`[Server] Dashboard backend running on http://localhost:${PORT}`);
  console.log(`[Server] Price WebSocket at ws://localhost:${PORT}/prices`);
  console.log(`[Server] Bot relay WebSocket at ws://localhost:${PORT}/bot`);

  currentMarket = await getCurrentBTCMarket();
  if (currentMarket) {
    console.log(`[Server] Initial market: ${currentMarket.slug}`);
    connectToPolymarket();
  }

  setInterval(checkMarketSwitch, 5000);
});
