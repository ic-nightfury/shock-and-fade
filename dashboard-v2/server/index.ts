import express from "express";
import { createServer, IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// IMPORTANT: Use a SINGLE WebSocketServer with noServer mode to avoid RSV1 compression bug
// Having multiple WebSocketServer instances on the same HTTP server causes "RSV1 must be clear" errors
// See: https://github.com/websockets/ws/issues/1917
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

// Serve static files from the dist folder
app.use(express.static(path.join(__dirname, "../dist")));

// Parse port from CLI args (--port 3002) or default to 3001
const portArg = process.argv.find((arg, i) => process.argv[i - 1] === "--port");
const PORT = portArg ? parseInt(portArg) : 3001;
const POLYMARKET_WSS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const GAMMA_API = "https://gamma-api.polymarket.com";

interface MarketInfo {
  slug: string;
  upTokenId: string;
  downTokenId: string;
  endTime: number;
  question: string;
}

interface PriceData {
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  timestamp: number;
}

let currentMarket: MarketInfo | null = null;
let polymarketWs: WebSocket | null = null;
let latestPrices: PriceData | null = null;
let polymarketPingInterval: NodeJS.Timeout | null = null;
let isReconnecting: boolean = false;

// Price WebSocket clients (dashboard frontends connecting to /prices)
const priceClients = new Set<WebSocket>();

// Bot WebSocket connections
const botClients = new Set<WebSocket>(); // Bots that send events
const botFrontendClients = new Set<WebSocket>(); // Dashboard frontends listening for bot events

// Cached bot state for new frontend connections
interface BotState {
  market: any | null;
  position: any | null;
  orders: Map<string, any>;
  surgeLine: any | null;
  hedgeLine: any | null;
}
const cachedBotState: BotState = {
  market: null,
  position: null,
  orders: new Map(),
  surgeLine: null,
  hedgeLine: null,
};

// Legacy alias for backward compatibility
const clients = priceClients;

// Get current 15-min BTC market
async function getCurrentBTCMarket(): Promise<MarketInfo | null> {
  try {
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const currentWindowStart =
      Math.floor(currentTimestamp / (15 * 60)) * (15 * 60);
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
    const upIndex = outcomes.findIndex((o: string) => o.toLowerCase() === "up");
    const downIndex = outcomes.findIndex(
      (o: string) => o.toLowerCase() === "down",
    );

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
    if (
      polymarketWs.readyState === WebSocket.OPEN ||
      polymarketWs.readyState === WebSocket.CONNECTING
    ) {
      polymarketWs.close();
    }
    polymarketWs = null;
  }
}

// Connect to Polymarket WebSocket
function connectToPolymarket() {
  // Prevent multiple simultaneous reconnection attempts
  if (isReconnecting) {
    return;
  }

  cleanupPolymarketConnection();

  if (!currentMarket) {
    console.log("[Polymarket] No market to subscribe to");
    return;
  }

  console.log(`[Polymarket] Connecting to WSS for ${currentMarket.slug}`);
  isReconnecting = true;

  // Disable compression to avoid RSV1 frame header issues
  polymarketWs = new WebSocket(POLYMARKET_WSS, {
    perMessageDeflate: false,
  });

  polymarketWs.on("open", () => {
    console.log("[Polymarket] WebSocket connected");
    isReconnecting = false;

    // Subscribe to both UP and DOWN tokens
    const subscribeMsg = {
      type: "Market",
      assets_ids: [currentMarket!.upTokenId, currentMarket!.downTokenId],
    };

    polymarketWs!.send(JSON.stringify(subscribeMsg));
    console.log(
      "[Polymarket] Subscribed to tokens:",
      currentMarket!.upTokenId.slice(0, 8),
      currentMarket!.downTokenId.slice(0, 8),
    );

    // Start ping interval to keep connection alive (every 30 seconds)
    polymarketPingInterval = setInterval(() => {
      if (polymarketWs && polymarketWs.readyState === WebSocket.OPEN) {
        polymarketWs.ping();
      }
    }, 30000);
  });

  polymarketWs.on("pong", () => {
    // Connection is alive - pong received from server
  });

  polymarketWs.on("message", (data: Buffer) => {
    try {
      const messages = JSON.parse(data.toString());

      for (const msg of Array.isArray(messages) ? messages : [messages]) {
        if (msg.event_type === "book" && msg.asset_id && currentMarket) {
          const isUp = msg.asset_id === currentMarket.upTokenId;
          const side = isUp ? "up" : "down";

          // Extract best bid/ask from order book
          const bids = msg.bids || [];
          const asks = msg.asks || [];

          // Bids are sorted ascending (0.01, 0.02, ... 0.35), best bid is LAST (highest price)
          // Asks are sorted descending (0.99, 0.98, ... 0.37), best ask is LAST (lowest price)
          const bestBid =
            bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;

          // Asks are sorted DESCENDING (0.99, 0.98, 0.97...), best ask is LAST (lowest price)
          let bestAsk = 1;
          if (asks.length > 0) {
            bestAsk = parseFloat(asks[asks.length - 1].price);
          }

          // Update latest prices
          if (!latestPrices) {
            latestPrices = {
              upBid: 0.5,
              upAsk: 0.5,
              downBid: 0.5,
              downAsk: 0.5,
              timestamp: Date.now(),
            };
          }

          if (isUp) {
            latestPrices.upBid = bestBid;
            latestPrices.upAsk = bestAsk;
          } else {
            latestPrices.downBid = bestBid;
            latestPrices.downAsk = bestAsk;
          }
          latestPrices.timestamp = Date.now();

          // Broadcast to all connected clients
          broadcastPrices();
        }
      }
    } catch (error) {
      // Ignore parse errors for ping/pong messages
    }
  });

  polymarketWs.on("close", () => {
    console.log("[Polymarket] WebSocket closed");
    isReconnecting = false;

    // Clean up ping interval
    if (polymarketPingInterval) {
      clearInterval(polymarketPingInterval);
      polymarketPingInterval = null;
    }

    // Reconnect after 3 seconds (only if we have a market)
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

  const message = JSON.stringify({
    type: "PRICE_UPDATE",
    data: latestPrices,
  });

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Track client alive status for ping/pong
const clientAlive = new Map<WebSocket, boolean>();

// Handle dashboard client connections for PRICES
function handlePriceConnection(ws: WebSocket) {
  console.log("[Prices] Client connected");
  priceClients.add(ws);
  clientAlive.set(ws, true);

  // Send current market info
  if (currentMarket) {
    ws.send(
      JSON.stringify({
        type: "MARKET_INFO",
        data: currentMarket,
      }),
    );
  }

  // Send latest prices
  if (latestPrices) {
    ws.send(
      JSON.stringify({
        type: "PRICE_UPDATE",
        data: latestPrices,
      }),
    );
  }

  ws.on("pong", () => {
    clientAlive.set(ws, true);
  });

  // Handle application-level ping from browser clients
  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type === "ping") {
        clientAlive.set(ws, true);
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      }
    } catch {
      // Ignore parse errors
    }
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
}

// =============================================================================
// BOT RELAY WebSocket (/bot endpoint)
// =============================================================================
// This endpoint serves two purposes:
// 1. Bots connect here to SEND events (identified by sending { type: "BOT_REGISTER" })
// 2. Dashboard frontends connect here to RECEIVE bot events
// =============================================================================

function broadcastToBotFrontends(message: string) {
  for (const client of botFrontendClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function sendCachedBotState(ws: WebSocket) {
  // Send cached market
  if (cachedBotState.market) {
    ws.send(
      JSON.stringify({ type: "MARKET_SWITCH", data: cachedBotState.market }),
    );
  }

  // Send cached orders
  for (const order of cachedBotState.orders.values()) {
    ws.send(JSON.stringify({ type: "ORDER_PLACED", data: order }));
  }

  // Send cached position
  if (cachedBotState.position) {
    ws.send(
      JSON.stringify({
        type: "POSITION_UPDATE",
        data: cachedBotState.position,
      }),
    );
  }

  // Send cached surge line
  if (cachedBotState.surgeLine?.active) {
    ws.send(
      JSON.stringify({ type: "SURGE_LINE", data: cachedBotState.surgeLine }),
    );
  }

  // Send cached hedge line
  if (cachedBotState.hedgeLine?.active) {
    ws.send(
      JSON.stringify({ type: "HEDGE_LINE", data: cachedBotState.hedgeLine }),
    );
  }
}

function handleBotConnection(ws: WebSocket) {
  console.log("[Bot] New connection");
  let isBot = false;
  clientAlive.set(ws, true);

  ws.on("pong", () => {
    clientAlive.set(ws, true);
  });

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());

      // Handle ping from browser clients
      if (message.type === "ping") {
        clientAlive.set(ws, true);
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        return;
      }

      // Bot registration - mark this connection as a bot (sender)
      if (message.type === "BOT_REGISTER") {
        isBot = true;
        botClients.add(ws);
        console.log(
          `[Bot] Bot registered (${botClients.size} bots, ${botFrontendClients.size} frontends)`,
        );

        // Notify frontends that a bot connected
        broadcastToBotFrontends(
          JSON.stringify({
            type: "CONNECTION_STATUS",
            data: { connected: true, botCount: botClients.size },
          }),
        );
        return;
      }

      // If this is a bot, relay its events to frontends
      if (isBot) {
        const rawMessage = data.toString();

        // Update cached state based on event type
        switch (message.type) {
          case "MARKET_SWITCH":
            cachedBotState.market = message.data;
            cachedBotState.orders.clear(); // Clear orders on market switch
            cachedBotState.surgeLine = null;
            cachedBotState.hedgeLine = null;
            break;
          case "ORDER_PLACED":
            cachedBotState.orders.set(
              message.data.orderId?.toLowerCase(),
              message.data,
            );
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

        // Relay to all frontend clients
        broadcastToBotFrontends(rawMessage);
      }
    } catch {
      // Ignore parse errors
    }
  });

  ws.on("close", () => {
    clientAlive.delete(ws);

    if (isBot) {
      botClients.delete(ws);
      console.log(`[Bot] Bot disconnected (${botClients.size} bots remaining)`);

      // Notify frontends that bot disconnected
      broadcastToBotFrontends(
        JSON.stringify({
          type: "CONNECTION_STATUS",
          data: { connected: botClients.size > 0, botCount: botClients.size },
        }),
      );
    } else {
      botFrontendClients.delete(ws);
      console.log(
        `[Bot] Frontend disconnected (${botFrontendClients.size} frontends remaining)`,
      );
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

  // If not registered as bot within 1 second, treat as frontend client
  setTimeout(() => {
    if (!isBot && ws.readyState === WebSocket.OPEN) {
      botFrontendClients.add(ws);
      console.log(
        `[Bot] Frontend client registered (${botFrontendClients.size} frontends)`,
      );

      // Send current bot connection status
      ws.send(
        JSON.stringify({
          type: "CONNECTION_STATUS",
          data: { connected: botClients.size > 0, botCount: botClients.size },
        }),
      );

      // Send cached state to new frontend
      sendCachedBotState(ws);
    }
  }, 1000);
}

// Handle HTTP upgrade requests and route to appropriate handler based on path
server.on("upgrade", (request: IncomingMessage, socket, head) => {
  const pathname = request.url || "/";

  if (pathname === "/prices") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      handlePriceConnection(ws);
    });
  } else if (pathname === "/bot") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleBotConnection(ws);
    });
  } else {
    // Unknown path - destroy the socket
    socket.destroy();
  }
});

// Ping dashboard clients every 30 seconds to keep connections alive
setInterval(() => {
  for (const client of clients) {
    if (clientAlive.get(client) === false) {
      // Client didn't respond to last ping, terminate
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

    // Notify all clients of market switch
    const message = JSON.stringify({
      type: "MARKET_SWITCH",
      data: currentMarket,
    });

    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });

    // Reconnect to Polymarket with new tokens
    connectToPolymarket();
  }
}

// REST endpoint for current market info
app.get("/api/market", (req, res) => {
  res.json(currentMarket);
});

// Health check
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

// SPA fallback - serve index.html for all non-API routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../dist/index.html"));
});

// Start server
server.listen(PORT, async () => {
  console.log(`[Server] Dashboard backend running on http://localhost:${PORT}`);
  console.log(`[Server] Price WebSocket at ws://localhost:${PORT}/prices`);
  console.log(`[Server] Bot relay WebSocket at ws://localhost:${PORT}/bot`);

  // Initial market fetch and connection
  currentMarket = await getCurrentBTCMarket();
  if (currentMarket) {
    console.log(`[Server] Initial market: ${currentMarket.slug}`);
    connectToPolymarket();
  }

  // Check for market switch every 5 seconds
  setInterval(checkMarketSwitch, 5000);
});
