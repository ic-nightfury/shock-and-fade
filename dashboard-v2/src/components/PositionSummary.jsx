const UP_COLOR = "#10B981";
const DOWN_COLOR = "#EF4444";

/**
 * Format price for display
 */
function formatPrice(price) {
  if (price === undefined || price === null || price === 0) return "--";
  return (price * 100).toFixed(1) + "¢";
}

/**
 * Format currency - handles large numbers and floating point precision
 */
function formatCurrency(value) {
  if (value === undefined || value === null) return "--";
  // Handle invalid/infinite values
  if (!isFinite(value) || Math.abs(value) > 1e15) return "--";
  return `$${value.toFixed(2)}`;
}

/**
 * Format number with proper rounding (avoids floating point display issues)
 */
function formatNumber(value, decimals = 0) {
  if (value === undefined || value === null) return "--";
  if (!isFinite(value)) return "--";
  return Number(value.toFixed(decimals));
}

/**
 * PositionSummary - Current holdings, avg prices, unrealized P&L
 * Shows both per-window position (resets each window) and cumulative stats
 */
export function PositionSummary({ position, prices }) {
  const hasPosition = position && (position.upQty > 0 || position.downQty > 0);

  // Current bid prices
  const upBid = prices?.upBid || 0;
  const downBid = prices?.downBid || 0;

  // Calculate position value at current bid prices (liquidation value)
  let positionValue = null;
  let positionCost = null;
  let unrealizedPnL = null;

  if (hasPosition) {
    // Value at current bid (what we could sell for right now)
    positionValue = position.upQty * upBid + position.downQty * downBid;

    // Total cost of position
    positionCost =
      position.upQty * (position.upAvg || 0) +
      position.downQty * (position.downAvg || 0);

    // Unrealized P&L = Current Value - Cost
    unrealizedPnL = positionValue - positionCost;
  }

  // Calculate pair status
  const isPaired = hasPosition && position.upQty === position.downQty;
  const pairCount = hasPosition
    ? Math.min(position.upQty, position.downQty)
    : 0;

  // Cumulative stats from bot
  const balance = position?.balance;
  const initialBalance = position?.initialBalance || 1000;
  const windowCount = position?.windowCount || 0;
  const windowMergedPairs = position?.windowMergedPairs || 0;
  const windowMergeProfit = position?.windowMergeProfit || 0;
  const windowAvgPairCost = position?.windowAvgPairCost || 0;

  // US-434: Sales tracking metrics
  const upSold = position?.upSold || 0;
  const downSold = position?.downSold || 0;
  const upRevenue = position?.upRevenue || 0;
  const downRevenue = position?.downRevenue || 0;

  // Calculate derived metrics for US-434
  const totalSold = upSold + downSold;
  const totalRevenue = upRevenue + downRevenue;
  // Avg sold price = total_revenue / (total_sold / 2) - per $1 split that produces 2 tokens
  const avgSoldPrice = totalSold > 0 ? totalRevenue / (totalSold / 2) : 0;
  // Window profit = total_revenue - split_cost (where split_cost = $0.50 per token = total_sold / 2)
  const windowProfit = totalRevenue - totalSold / 2;

  // Total P&L = (Current Balance - Starting Balance) + Position Value at Current Bid
  // This gives the true account value change including unrealized position value
  const balanceChange = balance !== undefined ? balance - initialBalance : null;
  const totalPnL =
    balanceChange !== null ? balanceChange + (positionValue || 0) : undefined;

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-300 mb-3">
        Position Summary
      </h3>

      {/* Cumulative Stats - Always Show */}
      <div className="bg-gray-700/30 rounded p-2 mb-3 space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-400">Windows:</span>
          <span className="font-mono text-gray-200">{windowCount}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-400">Balance:</span>
          <span className="font-mono text-gray-200">
            {balance !== undefined ? formatCurrency(balance) : "--"}
          </span>
        </div>
        {/* Position Value at current bid */}
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-400">Position Value:</span>
          <span className="font-mono text-gray-200">
            {positionValue !== null ? formatCurrency(positionValue) : "--"}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm border-t border-gray-600 pt-1 mt-1">
          <span className="text-gray-300 font-medium">Total P&L:</span>
          <span
            className={`font-semibold font-mono ${
              totalPnL === undefined
                ? "text-gray-400"
                : totalPnL >= 0
                  ? "text-green-400"
                  : "text-red-400"
            }`}
          >
            {totalPnL !== undefined
              ? `${totalPnL >= 0 ? "+" : ""}${formatCurrency(totalPnL)}`
              : "--"}
          </span>
        </div>
      </div>

      {/* Current Window Position */}
      <div className="text-xs text-gray-500 mb-2">Current Window:</div>

      {/* Window Stats - Show when sales have occurred */}
      {totalSold > 0 && (
        <div className="bg-gray-700/30 rounded p-2 mb-3">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-gray-400">UP Sold:</span>
            <span className="font-mono" style={{ color: UP_COLOR }}>
              {formatNumber(upSold)}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-gray-400">DOWN Sold:</span>
            <span className="font-mono" style={{ color: DOWN_COLOR }}>
              {formatNumber(downSold)}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-gray-400">Avg Sold Price:</span>
            <span className="font-mono text-yellow-400">
              {avgSoldPrice > 0 ? `${(avgSoldPrice * 100).toFixed(1)}¢` : "--"}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs border-t border-gray-600 pt-1">
            <span className="text-gray-400">Window Profit:</span>
            <span
              className={`font-mono ${
                windowProfit >= 0 ? "text-green-400" : "text-red-400"
              }`}
            >
              {windowProfit >= 0 ? "+" : ""}
              {formatCurrency(windowProfit)}
            </span>
          </div>
        </div>
      )}

      {!hasPosition ? (
        totalSold === 0 && (
          <div className="text-gray-500 text-sm text-center py-2">
            No position
          </div>
        )
      ) : (
        <div className="space-y-3">
          {/* Holdings */}
          <div className="grid grid-cols-2 gap-2 text-sm">
            {/* UP Position */}
            <div
              className="bg-gray-700/50 rounded p-2"
              style={{ borderLeft: `3px solid ${UP_COLOR}` }}
            >
              <div className="text-xs text-gray-400 mb-1">UP</div>
              <div className="font-semibold">{Math.round(position.upQty)}</div>
              <div className="text-xs text-gray-500">
                avg: {formatPrice(position.upAvg)}
              </div>
              <div className="text-xs text-green-400">
                val: {formatCurrency(position.upQty * upBid)}
              </div>
            </div>

            {/* DOWN Position */}
            <div
              className="bg-gray-700/50 rounded p-2"
              style={{ borderLeft: `3px solid ${DOWN_COLOR}` }}
            >
              <div className="text-xs text-gray-400 mb-1">DOWN</div>
              <div className="font-semibold">
                {Math.round(position.downQty)}
              </div>
              <div className="text-xs text-gray-500">
                avg: {formatPrice(position.downAvg)}
              </div>
              <div className="text-xs text-red-400">
                val: {formatCurrency(position.downQty * downBid)}
              </div>
            </div>
          </div>

          {/* Pair Status */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-400">Pairs:</span>
            <span className={isPaired ? "text-green-400" : "text-yellow-400"}>
              {Math.round(pairCount)} paired{" "}
              {!isPaired &&
                `(${Math.round(Math.abs(position.upQty - position.downQty))} unhedged)`}
            </span>
          </div>

          {/* Pair Cost */}
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-400">Pair Cost:</span>
            <span className="font-mono">
              {position.upAvg && position.downAvg
                ? formatPrice(position.upAvg + position.downAvg)
                : "--"}
              /pair
            </span>
          </div>

          {/* Unrealized P&L */}
          {unrealizedPnL !== null && (
            <div className="flex items-center justify-between text-sm pt-2 border-t border-gray-700">
              <span className="text-gray-400">Unrealized P&L:</span>
              <span
                className={`font-semibold ${unrealizedPnL >= 0 ? "text-green-400" : "text-red-400"}`}
              >
                {unrealizedPnL >= 0 ? "+" : ""}
                {formatCurrency(unrealizedPnL)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default PositionSummary;
