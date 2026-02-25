import { useRef, useEffect } from "react";

const UP_COLOR = "#10B981";
const DOWN_COLOR = "#EF4444";
const NEUTRAL_COLOR = "#6B7280";

/**
 * Format price for display
 */
function formatPrice(price) {
  if (price === undefined || price === null) return "--";
  return (price * 100).toFixed(1) + "¢";
}

/**
 * Format currency
 */
function formatCurrency(value) {
  if (value === undefined || value === null) return "--";
  return `$${value.toFixed(2)}`;
}

/**
 * Format timestamp for display
 */
function formatTime(date) {
  if (!date) return "--:--:--";
  const d = new Date(date);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Get activity type styling
 */
function getActivityStyle(type) {
  switch (type) {
    case "ORDER_PLACED":
      return { icon: "📝", color: "#60A5FA" }; // blue
    case "ORDER_FILLED":
      return { icon: "✅", color: "#10B981" }; // green
    case "ORDER_PARTIAL":
      return { icon: "⏳", color: "#F59E0B" }; // yellow
    case "ORDER_CANCELLED":
      return { icon: "❌", color: "#EF4444" }; // red
    case "MARKET_SWITCH":
      return { icon: "🔄", color: "#8B5CF6" }; // purple
    case "MERGE":
      return { icon: "🔗", color: "#14B8A6" }; // teal
    case "SURGE_LINE":
      return { icon: "📈", color: "#F59E0B" }; // amber
    case "CONNECTED":
      return { icon: "🟢", color: "#10B981" };
    case "DISCONNECTED":
      return { icon: "🔴", color: "#EF4444" };
    default:
      return { icon: "•", color: NEUTRAL_COLOR };
  }
}

/**
 * Format activity message
 */
function formatActivityMessage(activity) {
  const sideColor =
    activity.side === "UP"
      ? UP_COLOR
      : activity.side === "DOWN"
        ? DOWN_COLOR
        : NEUTRAL_COLOR;

  switch (activity.type) {
    case "ORDER_PLACED":
      return (
        <span>
          Placed <span style={{ color: sideColor }}>{activity.side}</span>{" "}
          <span className="font-mono">{activity.size}</span> @{" "}
          <span className="font-mono">{formatPrice(activity.price)}</span>{" "}
          <span className="text-gray-500">({activity.orderType})</span>
        </span>
      );
    case "ORDER_FILLED":
      return (
        <span>
          Filled <span style={{ color: sideColor }}>{activity.side}</span>{" "}
          <span className="font-mono">{activity.filledSize}</span> @{" "}
          <span className="font-mono">{formatPrice(activity.price)}</span>
        </span>
      );
    case "ORDER_PARTIAL":
      return (
        <span>
          Partial <span style={{ color: sideColor }}>{activity.side}</span>{" "}
          <span className="font-mono">{activity.filledSize}</span> filled,{" "}
          <span className="font-mono">{activity.remaining}</span> remaining
        </span>
      );
    case "ORDER_CANCELLED":
      return (
        <span>
          Cancelled <span style={{ color: sideColor }}>{activity.side}</span> @{" "}
          <span className="font-mono">{formatPrice(activity.price)}</span>
        </span>
      );
    case "MARKET_SWITCH":
      return (
        <span>
          Market switched to{" "}
          <span className="text-purple-400">{activity.slug}</span>
        </span>
      );
    case "MERGE":
      return (
        <span>
          Merged{" "}
          <span className="font-mono text-teal-400">{activity.pairs}</span>{" "}
          pairs
          {activity.profit > 0 && (
            <span className="text-green-400">
              {" "}
              +{formatCurrency(activity.profit)}
            </span>
          )}
        </span>
      );
    case "SURGE_LINE":
      return (
        <span>
          SURGE <span style={{ color: sideColor }}>{activity.side}</span> supply
          @{" "}
          <span className="font-mono text-amber-400">
            {formatPrice(activity.supplyPrice)}
          </span>
          {" → entry "}
          <span className="font-mono text-amber-400">
            {formatPrice(activity.entryPrice)}
          </span>
        </span>
      );
    case "CONNECTED":
    case "DISCONNECTED":
      return <span>{activity.message}</span>;
    default:
      return <span>{JSON.stringify(activity)}</span>;
  }
}

/**
 * ActivityFeed - Scrolling log of order events
 * Shows all activities in a scrollable container
 * Auto-scrolls to top when new activities arrive
 */
export function ActivityFeed({ activities }) {
  const scrollContainerRef = useRef(null);
  const prevLengthRef = useRef(0);

  // Auto-scroll to top when new activities are added
  useEffect(() => {
    if (activities && activities.length > prevLengthRef.current) {
      // New activity added, scroll to top
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = 0;
      }
    }
    prevLengthRef.current = activities?.length || 0;
  }, [activities]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-300">Activity Feed</h3>
        <span className="text-xs text-gray-500">
          {activities?.length || 0} events
        </span>
      </div>

      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto space-y-1 pr-1 min-h-0"
      >
        {!activities || activities.length === 0 ? (
          <div className="text-gray-500 text-sm text-center py-4">
            No activity yet
          </div>
        ) : (
          activities.map((activity) => {
            const { icon, color } = getActivityStyle(activity.type);
            return (
              <div
                key={activity.id}
                className="flex items-start gap-2 text-xs bg-gray-700/30 rounded px-2 py-1.5"
              >
                <span className="text-sm">{icon}</span>
                <span className="text-gray-500 font-mono whitespace-nowrap">
                  {formatTime(activity.timestamp)}
                </span>
                <span className="text-gray-200 flex-1">
                  {formatActivityMessage(activity)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default ActivityFeed;
