import { useMemo } from "react";
import {
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  ComposedChart,
} from "recharts";

const UP_COLOR = "#10B981"; // green-500 (for ask - outer edge)
const UP_COLOR_BID = "#34D399"; // green-400 (for bid - inner edge, lighter)
const UP_COLOR_LIGHT = "rgba(16, 185, 129, 0.25)"; // green with 25% opacity
const DOWN_COLOR = "#EF4444"; // red-500 (for ask - outer edge)
const DOWN_COLOR_BID = "#F87171"; // red-400 (for bid - inner edge, lighter)
const DOWN_COLOR_LIGHT = "rgba(239, 68, 68, 0.25)"; // red with 25% opacity
const SURGE_COLOR = "#F59E0B"; // amber-500 for supply line
const HEDGE_COLOR = "#8B5CF6"; // violet-500 for hedge line
const GRID_COLOR = "#374151"; // gray-700
const TEXT_COLOR = "#9CA3AF"; // gray-400

const VISIBLE_WINDOW_MS = 60 * 1000; // Show last 1 minute of data

/**
 * Format timestamp for X-axis - show MM:SS
 */
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return `${date.getMinutes().toString().padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}`;
}

/**
 * Format price for display
 */
function formatPrice(price) {
  return (price * 100).toFixed(1) + "¢";
}

/**
 * Custom tooltip component
 */
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;

  // Find the range data
  const upRange = payload.find((p) => p.dataKey === "upRange");
  const downRange = payload.find((p) => p.dataKey === "downRange");

  return (
    <div className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm">
      <p className="text-gray-400 mb-1">{formatTime(label)}</p>
      {upRange && upRange.value && (
        <div className="mb-1">
          <span style={{ color: UP_COLOR }} className="font-medium">
            UP:{" "}
          </span>
          <span style={{ color: UP_COLOR }}>
            {formatPrice(upRange.value[0])} / {formatPrice(upRange.value[1])}
          </span>
          <span className="text-gray-500 text-xs ml-1">
            (spread: {((upRange.value[1] - upRange.value[0]) * 100).toFixed(1)}
            ¢)
          </span>
        </div>
      )}
      {downRange && downRange.value && (
        <div>
          <span style={{ color: DOWN_COLOR }} className="font-medium">
            DOWN:{" "}
          </span>
          <span style={{ color: DOWN_COLOR }}>
            {formatPrice(downRange.value[0])} /{" "}
            {formatPrice(downRange.value[1])}
          </span>
          <span className="text-gray-500 text-xs ml-1">
            (spread:{" "}
            {((downRange.value[1] - downRange.value[0]) * 100).toFixed(1)}¢)
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * PriceChart component with shaded bid/ask spread bands
 * Shows UP and DOWN with transparent ribbons between bid and ask
 * Data flows from right to left, last 1 minute visible
 */
export function PriceChart({
  priceHistory,
  orders,
  prices,
  market,
  surgeLine,
  hedgeLine,
}) {
  // Convert orders object to array for rendering
  const orderLines = useMemo(() => {
    return Object.values(orders || {}).map((order) => ({
      price: order.price,
      side: order.side,
      size: order.size,
      orderId: order.orderId,
      orderType: order.orderType,
      label: order.label,
    }));
  }, [orders]);

  // Transform price history to include range arrays for Area components
  const chartData = useMemo(() => {
    if (!priceHistory || priceHistory.length === 0) return [];
    return priceHistory.map((p) => ({
      timestamp: p.timestamp,
      // Range arrays: [min, max] for shaded bands
      upRange: [p.upBid, p.upAsk],
      downRange: [p.downBid, p.downAsk],
      // Keep individual values for reference
      upBid: p.upBid,
      upAsk: p.upAsk,
      downBid: p.downBid,
      downAsk: p.downAsk,
    }));
  }, [priceHistory]);

  // Static Y-axis from 0 to 100c (0.00 to 1.00)
  const { yDomain, yTicks } = useMemo(() => {
    // Fixed domain: 0 to 1.00 ($0 to $1.00)
    const domainMin = 0;
    const domainMax = 1;

    // Generate ticks at 10¢ intervals (0, 10, 20, ..., 100)
    const ticks = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

    return { yDomain: [domainMin, domainMax], yTicks: ticks };
  }, []);

  // Calculate X-axis domain: sliding 1-minute window ending at current time
  const xDomain = useMemo(() => {
    const now = Date.now();
    // Round to nearest second for clean grid alignment
    const endMs = Math.ceil(now / 1000) * 1000;
    const startMs = endMs - VISIBLE_WINDOW_MS;
    return [startMs, endMs];
  }, [priceHistory]); // Recalculate when new data arrives

  // Generate X-axis ticks at 1-second intervals (60 ticks for 1 minute)
  const xTicks = useMemo(() => {
    const [start, end] = xDomain;
    const ticks = [];
    const oneSecond = 1000;
    let tick = Math.ceil(start / oneSecond) * oneSecond;
    while (tick <= end) {
      ticks.push(tick);
      tick += oneSecond;
    }
    return ticks;
  }, [xDomain]);

  // Filter chart data to only show last 1 minute
  const visibleData = useMemo(() => {
    if (!chartData || chartData.length === 0) return [];
    const [start] = xDomain;
    return chartData.filter((p) => p.timestamp >= start);
  }, [chartData, xDomain]);

  // Calculate current spreads for header display
  const upSpread = prices
    ? ((prices.upAsk - prices.upBid) * 100).toFixed(1)
    : "--";
  const downSpread = prices
    ? ((prices.downAsk - prices.downBid) * 100).toFixed(1)
    : "--";

  return (
    <div className="h-full w-full">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">Price Chart (1 min)</h2>
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-2">
            <div
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: UP_COLOR }}
            />
            <span>
              UP: {prices ? formatPrice(prices.upBid) : "--"}/
              {prices ? formatPrice(prices.upAsk) : "--"}
              <span className="text-gray-500 text-xs ml-1">({upSpread}¢)</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: DOWN_COLOR }}
            />
            <span>
              DOWN: {prices ? formatPrice(prices.downBid) : "--"}/
              {prices ? formatPrice(prices.downAsk) : "--"}
              <span className="text-gray-500 text-xs ml-1">
                ({downSpread}¢)
              </span>
            </span>
          </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height="90%">
        <ComposedChart
          data={visibleData}
          margin={{ top: 10, right: 60, left: 10, bottom: 10 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />

          <XAxis
            dataKey="timestamp"
            type="number"
            domain={xDomain}
            ticks={xTicks}
            tickFormatter={formatTime}
            stroke={TEXT_COLOR}
            tick={{ fill: TEXT_COLOR, fontSize: 9 }}
            axisLine={{ stroke: GRID_COLOR }}
            allowDataOverflow={true}
            interval={9}
          />

          <YAxis
            domain={yDomain}
            ticks={yTicks}
            tickFormatter={(v) => `${(v * 100).toFixed(0)}¢`}
            stroke={TEXT_COLOR}
            tick={{ fill: TEXT_COLOR, fontSize: 11 }}
            axisLine={{ stroke: GRID_COLOR }}
            width={45}
          />

          <Tooltip content={<CustomTooltip />} />

          {/* UP spread band - shaded area between bid and ask */}
          <Area
            type="monotone"
            dataKey="upRange"
            name="UP"
            stroke="none"
            fill={UP_COLOR_LIGHT}
            isAnimationActive={false}
            dot={false}
          />
          {/* UP Ask line (darker green - outer) */}
          <Line
            type="monotone"
            dataKey="upAsk"
            name="UP Ask"
            stroke={UP_COLOR}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          {/* UP Bid line (lighter green - inner) */}
          <Line
            type="monotone"
            dataKey="upBid"
            name="UP Bid"
            stroke={UP_COLOR_BID}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />

          {/* DOWN spread band - shaded area between bid and ask */}
          <Area
            type="monotone"
            dataKey="downRange"
            name="DOWN"
            stroke="none"
            fill={DOWN_COLOR_LIGHT}
            isAnimationActive={false}
            dot={false}
          />
          {/* DOWN Ask line (darker red - outer) */}
          <Line
            type="monotone"
            dataKey="downAsk"
            name="DOWN Ask"
            stroke={DOWN_COLOR}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          {/* DOWN Bid line (lighter red - inner) */}
          <Line
            type="monotone"
            dataKey="downBid"
            name="DOWN Bid"
            stroke={DOWN_COLOR_BID}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />

          {/* Order reference lines */}
          {orderLines.map((order, index) => (
            <ReferenceLine
              key={order.orderId || index}
              y={order.price}
              stroke={order.side === "UP" ? UP_COLOR : DOWN_COLOR}
              strokeDasharray="5 5"
              strokeWidth={1.5}
              label={{
                value: order.label
                  ? `${order.label} ${order.size}@${formatPrice(order.price)}`
                  : `${order.size}@${formatPrice(order.price)}`,
                position: "right",
                fill: order.side === "UP" ? UP_COLOR : DOWN_COLOR,
                fontSize: 11,
              }}
            />
          ))}

          {/* Surge supply line */}
          {surgeLine && (
            <ReferenceLine
              y={surgeLine.supplyPrice}
              stroke={SURGE_COLOR}
              strokeWidth={2}
              strokeDasharray="8 4"
              label={{
                value: `SUPPLY ${surgeLine.side} ${formatPrice(surgeLine.supplyPrice)}`,
                position: "insideTopRight",
                fill: SURGE_COLOR,
                fontSize: 11,
                fontWeight: "bold",
              }}
            />
          )}

          {/* Hedge line */}
          {hedgeLine && (
            <ReferenceLine
              y={hedgeLine.price}
              stroke={HEDGE_COLOR}
              strokeWidth={2.5}
              strokeDasharray="10 5"
              label={{
                value: `HEDGE ${hedgeLine.side} ${hedgeLine.size}@${formatPrice(hedgeLine.price)}`,
                position: "insideTopRight",
                fill: HEDGE_COLOR,
                fontSize: 12,
                fontWeight: "bold",
              }}
            />
          )}

          {/* 50c reference line */}
          <ReferenceLine
            y={0.5}
            stroke="#6B7280"
            strokeDasharray="2 2"
            strokeWidth={1}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export default PriceChart;
