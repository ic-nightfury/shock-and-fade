import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/prices" });
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
const clients = new Set();
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
    }
    catch (error) {
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
        if (polymarketWs.readyState === WebSocket.OPEN ||
            polymarketWs.readyState === WebSocket.CONNECTING) {
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
    polymarketWs = new WebSocket(POLYMARKET_WSS);
    polymarketWs.on("open", () => {
        console.log("[Polymarket] WebSocket connected");
        isReconnecting = false;
        // Subscribe to both UP and DOWN tokens
        const subscribeMsg = {
            type: "Market",
            assets_ids: [currentMarket.upTokenId, currentMarket.downTokenId],
        };
        polymarketWs.send(JSON.stringify(subscribeMsg));
        console.log("[Polymarket] Subscribed to tokens:", currentMarket.upTokenId.slice(0, 8), currentMarket.downTokenId.slice(0, 8));
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
    polymarketWs.on("message", (data) => {
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
                    const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
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
                    }
                    else {
                        latestPrices.downBid = bestBid;
                        latestPrices.downAsk = bestAsk;
                    }
                    latestPrices.timestamp = Date.now();
                    // Broadcast to all connected clients
                    broadcastPrices();
                }
            }
        }
        catch (error) {
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
    if (!latestPrices || clients.size === 0)
        return;
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
const clientAlive = new Map();
// Handle dashboard client connections
wss.on("connection", (ws) => {
    console.log("[Dashboard] Client connected");
    clients.add(ws);
    clientAlive.set(ws, true);
    // Send current market info
    if (currentMarket) {
        ws.send(JSON.stringify({
            type: "MARKET_INFO",
            data: currentMarket,
        }));
    }
    // Send latest prices
    if (latestPrices) {
        ws.send(JSON.stringify({
            type: "PRICE_UPDATE",
            data: latestPrices,
        }));
    }
    ws.on("pong", () => {
        clientAlive.set(ws, true);
    });
    ws.on("close", () => {
        console.log("[Dashboard] Client disconnected");
        clients.delete(ws);
        clientAlive.delete(ws);
    });
    ws.on("error", (error) => {
        console.error("[Dashboard] Client error:", error.message);
        clients.delete(ws);
        clientAlive.delete(ws);
    });
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
        clients: clients.size,
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
    console.log(`[Server] WebSocket available at ws://localhost:${PORT}/prices`);
    // Initial market fetch and connection
    currentMarket = await getCurrentBTCMarket();
    if (currentMarket) {
        console.log(`[Server] Initial market: ${currentMarket.slug}`);
        connectToPolymarket();
    }
    // Check for market switch every 5 seconds
    setInterval(checkMarketSwitch, 5000);
});
