import { useState, useRef, useEffect } from "react";
import { useWebSocket } from "./useWebSocket";

// Connect to dashboard backend's bot relay endpoint on port 3001
// The backend relays events from trading bots to dashboard frontends
const BOT_RELAY_URL = `ws://${window.location.hostname}:3001/bot`;

/**
 * Hook to manage bot order state from DashboardRelay
 * Uses refs internally to avoid dependency cycles
 *
 * Returns two connection states:
 * - connected: whether frontend is connected to relay server (WebSocket to port 3001)
 * - botConnected: whether any trading bot is connected to the relay server
 */
export function useBotOrders() {
  const [orders, setOrders] = useState({});
  const [activities, setActivities] = useState([]);
  const [position, setPosition] = useState({
    upQty: 0,
    downQty: 0,
    upAvg: 0,
    downAvg: 0,
    pairCost: 0,
  });
  const [surgeLine, setSurgeLine] = useState(null);
  const [hedgeLine, setHedgeLine] = useState(null);
  const [logs, setLogs] = useState([]);
  // Track actual bot connection status (separate from WebSocket to relay)
  const [botConnected, setBotConnected] = useState(false);

  // Use ref for state updates to avoid callback recreation
  const stateRef = useRef({ orders, activities, position });
  useEffect(() => {
    stateRef.current = { orders, activities, position };
  });

  // Counter for unique activity IDs
  const activityIdRef = useRef(0);

  // Stable callbacks using refs
  const handleMessage = (message) => {
    const { type, data } = message;

    const addActivity = (activity) => {
      activityIdRef.current += 1;
      const uniqueId = `${Date.now()}-${activityIdRef.current}`;
      setActivities((prev) => {
        const newActivities = [
          { ...activity, id: uniqueId, timestamp: new Date() },
          ...prev,
        ];
        return newActivities.slice(0, 100);
      });
    };

    switch (type) {
      case "ORDER_PLACED":
        setOrders((prev) => ({
          ...prev,
          [data.orderId]: {
            ...data,
            status: "pending",
            placedAt: new Date(),
          },
        }));
        addActivity({
          type: "ORDER_PLACED",
          side: data.side,
          price: data.price,
          size: data.size,
          orderType: data.orderType,
          orderId: data.orderId,
        });
        break;

      case "ORDER_FILLED":
        setOrders((prev) => {
          const newOrders = { ...prev };
          const existed = data.orderId in newOrders;
          delete newOrders[data.orderId];
          if (!existed) {
            console.warn(
              `[useBotOrders] ORDER_FILLED for unknown order: ${data.orderId}`,
            );
          }
          return newOrders;
        });
        addActivity({
          type: "ORDER_FILLED",
          side: data.side,
          price: data.price,
          filledSize: data.filledSize,
          orderId: data.orderId,
        });
        break;

      case "ORDER_PARTIAL":
        setOrders((prev) => ({
          ...prev,
          [data.orderId]: {
            ...prev[data.orderId],
            size: data.remaining,
            status: "partial",
          },
        }));
        addActivity({
          type: "ORDER_PARTIAL",
          side: data.side,
          price: data.price,
          filledSize: data.filledSize,
          remaining: data.remaining,
          orderId: data.orderId,
        });
        break;

      case "ORDER_CANCELLED":
        setOrders((prev) => {
          const newOrders = { ...prev };
          delete newOrders[data.orderId];
          return newOrders;
        });
        addActivity({
          type: "ORDER_CANCELLED",
          side: data.side,
          price: data.price,
          orderId: data.orderId,
        });
        break;

      case "POSITION_UPDATE":
        setPosition(data);
        break;

      case "MARKET_SWITCH":
        setOrders({});
        setSurgeLine(null); // Clear surge line on market switch
        setHedgeLine(null); // Clear hedge line on market switch
        addActivity({
          type: "MARKET_SWITCH",
          slug: data.slug,
          endTime: data.endTime,
        });
        break;

      case "SURGE_LINE":
        if (data.active) {
          setSurgeLine({
            side: data.side,
            supplyPrice: data.supplyPrice,
            entryPrice: data.entryPrice,
            timestamp: data.timestamp,
          });
          addActivity({
            type: "SURGE_LINE",
            side: data.side,
            supplyPrice: data.supplyPrice,
            entryPrice: data.entryPrice,
          });
        } else {
          setSurgeLine(null);
        }
        break;

      case "HEDGE_LINE":
        if (data.active) {
          setHedgeLine({
            side: data.side,
            price: data.price,
            size: data.size,
            timestamp: data.timestamp,
          });
        } else {
          setHedgeLine(null);
        }
        break;

      case "MERGE":
        addActivity({
          type: "MERGE",
          pairs: data.pairs,
          profit: data.profit,
        });
        break;

      case "LOG_MESSAGE":
        setLogs((prev) => {
          const newLogs = [
            {
              id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              message: data.message,
              level: data.level,
              timestamp: new Date(data.timestamp),
            },
            ...prev,
          ];
          return newLogs.slice(0, 500); // Keep last 500 logs
        });
        break;

      case "PRICE_UPDATE":
        // Price updates from bot relay (optional backup)
        break;

      case "STATE_SYNC":
        if (data.orders) {
          const ordersMap = {};
          data.orders.forEach((order) => {
            ordersMap[order.orderId] = order;
          });
          setOrders(ordersMap);
        }
        if (data.position) {
          setPosition(data.position);
        }
        break;

      case "CONNECTION_STATUS":
        // Bot connection status from relay server
        // The 'connected' field indicates if any bot is connected to the relay
        setBotConnected(data.connected);
        if (data.connected) {
          addActivity({
            type: "BOT_CONNECTED",
            message: `Bot connected (${data.botCount} active)`,
          });
        } else {
          addActivity({
            type: "BOT_DISCONNECTED",
            message: "No bot connected",
          });
          // Clear stale state when bot disconnects
          setOrders({});
          setSurgeLine(null);
          setHedgeLine(null);
        }
        break;

      default:
        console.log("[BotOrders] Unknown message type:", type);
    }
  };

  const handleConnect = () => {
    console.log("[BotOrders] Connected to bot relay");
    setActivities((prev) =>
      [
        {
          type: "CONNECTED",
          message: "Connected to bot",
          id: Date.now(),
          timestamp: new Date(),
        },
        ...prev,
      ].slice(0, 100),
    );
  };

  const handleDisconnect = () => {
    console.log("[BotOrders] Disconnected from bot relay");
    setActivities((prev) =>
      [
        {
          type: "DISCONNECTED",
          message: "Disconnected from bot",
          id: Date.now(),
          timestamp: new Date(),
        },
        ...prev,
      ].slice(0, 100),
    );
  };

  const { connected: relayConnected } = useWebSocket(BOT_RELAY_URL, {
    onMessage: handleMessage,
    onConnect: handleConnect,
    onDisconnect: handleDisconnect,
  });

  return {
    orders,
    activities,
    position,
    surgeLine,
    hedgeLine,
    logs,
    connected: relayConnected, // WebSocket connection to relay server
    botConnected, // Whether actual trading bot is connected to relay
  };
}

export default useBotOrders;
