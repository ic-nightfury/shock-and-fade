import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Generic WebSocket hook with auto-reconnect
 * Uses refs to avoid dependency cycles and prevent reconnection loops
 */
export function useWebSocket(url, options = {}) {
  const {
    reconnectInterval = 3000,
    onMessage = null,
    onConnect = null,
    onDisconnect = null,
  } = options;

  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState(null);

  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const urlRef = useRef(url);

  // Store callbacks in refs - never used as dependencies
  const callbacksRef = useRef({ onMessage, onConnect, onDisconnect });

  // Update refs when callbacks change (no re-render triggered)
  useEffect(() => {
    callbacksRef.current = { onMessage, onConnect, onDisconnect };
  });

  // Update URL ref
  useEffect(() => {
    urlRef.current = url;
  }, [url]);

  const sendMessage = useCallback((message) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  // Single connection effect - only runs once on mount
  useEffect(() => {
    let mounted = true;
    let connecting = false;

    const connect = () => {
      if (!mounted || connecting) return;
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

      connecting = true;
      console.log(`[WebSocket] Connecting to ${urlRef.current}...`);

      try {
        const ws = new WebSocket(urlRef.current);
        wsRef.current = ws;

        ws.onopen = () => {
          connecting = false;
          if (!mounted) {
            ws.close();
            return;
          }
          console.log(`[WebSocket] Connected to ${urlRef.current}`);
          setConnected(true);
          callbacksRef.current.onConnect?.();

          // Start application-level ping interval (browser WebSockets don't expose protocol-level ping/pong)
          const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
            }
          }, 15000); // Every 15 seconds

          ws._pingInterval = pingInterval;
        };

        ws.onmessage = (event) => {
          if (!mounted) return;
          try {
            const data = JSON.parse(event.data);
            setLastMessage(data);
            callbacksRef.current.onMessage?.(data);
          } catch (error) {
            console.error("[WebSocket] Failed to parse message:", error);
          }
        };

        ws.onclose = () => {
          connecting = false;
          // Clear ping interval for THIS websocket
          if (ws._pingInterval) {
            clearInterval(ws._pingInterval);
            ws._pingInterval = null;
          }
          wsRef.current = null;
          if (!mounted) return;

          console.log(`[WebSocket] Disconnected from ${urlRef.current}`);
          setConnected(false);
          callbacksRef.current.onDisconnect?.();

          // Schedule reconnect
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = setTimeout(() => {
            if (mounted) connect();
          }, reconnectInterval);
        };

        ws.onerror = (error) => {
          console.error(`[WebSocket] Error:`, error);
          connecting = false;
        };
      } catch (error) {
        console.error(`[WebSocket] Connection failed:`, error);
        connecting = false;

        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = setTimeout(() => {
          if (mounted) connect();
        }, reconnectInterval);
      }
    };

    connect();

    return () => {
      mounted = false;
      clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [reconnectInterval]); // Only reconnectInterval as dependency

  return { connected, lastMessage, sendMessage };
}

export default useWebSocket;
