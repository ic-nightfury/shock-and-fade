import { useEffect, useRef, useState } from "react";

/**
 * Real-time log panel that displays bot logs streamed via WebSocket
 */
function LogPanel({ logs }) {
  const containerRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState("all"); // all, info, warn, error, success

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = 0; // Logs are newest-first
    }
  }, [logs, autoScroll]);

  // Handle scroll to detect manual scrolling
  const handleScroll = () => {
    if (containerRef.current) {
      // If user scrolled away from top, disable auto-scroll
      setAutoScroll(containerRef.current.scrollTop < 10);
    }
  };

  // Filter logs
  const filteredLogs = filter === "all"
    ? logs
    : logs.filter(log => log.level === filter);

  // Level colors
  const levelColors = {
    info: "text-blue-400",
    warn: "text-yellow-400",
    error: "text-red-400",
    success: "text-green-400",
    debug: "text-gray-500",
  };

  const levelBadgeColors = {
    info: "bg-blue-900/50 text-blue-300",
    warn: "bg-yellow-900/50 text-yellow-300",
    error: "bg-red-900/50 text-red-300",
    success: "bg-green-900/50 text-green-300",
    debug: "bg-gray-800 text-gray-400",
  };

  // Format timestamp
  const formatTime = (date) => {
    return date.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header with filters */}
      <div className="flex items-center justify-between mb-2 flex-shrink-0">
        <h3 className="text-sm font-medium text-gray-400">Live Logs</h3>
        <div className="flex items-center gap-2">
          {/* Filter buttons */}
          <div className="flex gap-1">
            {["all", "success", "info", "warn", "error"].map((level) => (
              <button
                key={level}
                onClick={() => setFilter(level)}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${
                  filter === level
                    ? "bg-gray-600 text-white"
                    : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}
              >
                {level === "all" ? "All" : level.charAt(0).toUpperCase() + level.slice(1)}
              </button>
            ))}
          </div>

          {/* Auto-scroll indicator */}
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-2 py-0.5 text-xs rounded ${
              autoScroll
                ? "bg-green-900/50 text-green-300"
                : "bg-gray-800 text-gray-400"
            }`}
            title={autoScroll ? "Auto-scroll enabled" : "Auto-scroll disabled"}
          >
            {autoScroll ? "▼ Live" : "⏸ Paused"}
          </button>
        </div>
      </div>

      {/* Log container */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-xs bg-gray-900 rounded p-2 space-y-0.5"
      >
        {filteredLogs.length === 0 ? (
          <div className="text-gray-500 text-center py-4">
            {logs.length === 0 ? "Waiting for logs..." : "No logs match filter"}
          </div>
        ) : (
          filteredLogs.map((log) => (
            <div
              key={log.id}
              className={`flex items-start gap-2 py-0.5 hover:bg-gray-800/50 ${levelColors[log.level] || "text-gray-300"}`}
            >
              {/* Timestamp */}
              <span className="text-gray-600 flex-shrink-0">
                {formatTime(log.timestamp)}
              </span>

              {/* Level badge */}
              <span
                className={`px-1.5 py-0 rounded text-[10px] font-medium uppercase flex-shrink-0 ${
                  levelBadgeColors[log.level] || "bg-gray-800 text-gray-400"
                }`}
              >
                {log.level}
              </span>

              {/* Message */}
              <span className="flex-1 break-all whitespace-pre-wrap">
                {log.message}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Footer with stats */}
      <div className="flex items-center justify-between mt-1 text-[10px] text-gray-500 flex-shrink-0">
        <span>{filteredLogs.length} logs shown</span>
        <span>{logs.length} total</span>
      </div>
    </div>
  );
}

export default LogPanel;
