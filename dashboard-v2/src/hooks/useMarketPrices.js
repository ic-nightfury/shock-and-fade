import { useState, useRef, useEffect } from "react";
import { useWebSocket } from "./useWebSocket";

const PRICE_RELAY_URL = `ws://${window.location.hostname}:3001/prices`;
const MAX_HISTORY_POINTS = 900; // 15 minutes of 1-second data

/**
 * Hook to manage market prices from Polymarket relay
 * Uses refs internally to avoid dependency cycles
 */
export function useMarketPrices() {
  const [prices, setPrices] = useState({
    upBid: 0.5,
    upAsk: 0.5,
    downBid: 0.5,
    downAsk: 0.5,
    timestamp: Date.now(),
  });

  const [priceHistory, setPriceHistory] = useState([]);
  const [market, setMarket] = useState(null);

  // Track last update time to throttle
  const lastUpdateRef = useRef(0);

  // Stable message handler
  const handleMessage = (message) => {
    const { type, data } = message;

    switch (type) {
      case "PRICE_UPDATE":
        // Throttle updates to max 1 per 100ms
        const now = Date.now();
        if (now - lastUpdateRef.current < 100) return;
        lastUpdateRef.current = now;

        setPrices(data);

        // Add to history
        const historyPoint = {
          timestamp: data.timestamp,
          upMid: (data.upBid + data.upAsk) / 2,
          downMid: (data.downBid + data.downAsk) / 2,
          upBid: data.upBid,
          upAsk: data.upAsk,
          downBid: data.downBid,
          downAsk: data.downAsk,
        };

        setPriceHistory((prev) => {
          const newHistory = [...prev, historyPoint];
          if (newHistory.length > MAX_HISTORY_POINTS) {
            return newHistory.slice(-MAX_HISTORY_POINTS);
          }
          return newHistory;
        });
        break;

      case "MARKET_INFO":
      case "MARKET_SWITCH":
        setMarket(data);
        if (type === "MARKET_SWITCH") {
          setPriceHistory([]);
          setPrices({
            upBid: 0.5,
            upAsk: 0.5,
            downBid: 0.5,
            downAsk: 0.5,
            timestamp: Date.now(),
          });
        }
        break;

      default:
        console.log("[MarketPrices] Unknown message type:", type);
    }
  };

  const handleConnect = () => {
    console.log("[MarketPrices] Connected to price relay");
  };

  const handleDisconnect = () => {
    console.log("[MarketPrices] Disconnected from price relay");
  };

  const { connected } = useWebSocket(PRICE_RELAY_URL, {
    onMessage: handleMessage,
    onConnect: handleConnect,
    onDisconnect: handleDisconnect,
  });

  return {
    prices,
    priceHistory,
    market,
    connected,
  };
}

export default useMarketPrices;
