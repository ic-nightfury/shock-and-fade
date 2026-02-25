const UP_COLOR = '#10B981';
const DOWN_COLOR = '#EF4444';

/**
 * Format price for display
 */
function formatPrice(price) {
  if (price === undefined || price === null) return '--';
  return (price * 100).toFixed(1) + '¢';
}

/**
 * MarketStats - Current bid/ask, spread, time remaining
 */
export function MarketStats({ prices, market, timeRemaining }) {
  const upSpread = prices ? (prices.upAsk - prices.upBid) : null;
  const downSpread = prices ? (prices.downAsk - prices.downBid) : null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-300 mb-3">Market Stats</h3>

      <div className="space-y-3">
        {/* UP Stats */}
        <div className="bg-gray-700/50 rounded p-2" style={{ borderLeft: `3px solid ${UP_COLOR}` }}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium" style={{ color: UP_COLOR }}>UP</span>
            <span className="text-[10px] text-gray-500">
              spread: {upSpread !== null ? formatPrice(upSpread) : '--'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-gray-400">Bid: </span>
              <span className="font-mono">{formatPrice(prices?.upBid)}</span>
            </div>
            <div>
              <span className="text-gray-400">Ask: </span>
              <span className="font-mono">{formatPrice(prices?.upAsk)}</span>
            </div>
          </div>
        </div>

        {/* DOWN Stats */}
        <div className="bg-gray-700/50 rounded p-2" style={{ borderLeft: `3px solid ${DOWN_COLOR}` }}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium" style={{ color: DOWN_COLOR }}>DOWN</span>
            <span className="text-[10px] text-gray-500">
              spread: {downSpread !== null ? formatPrice(downSpread) : '--'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-gray-400">Bid: </span>
              <span className="font-mono">{formatPrice(prices?.downBid)}</span>
            </div>
            <div>
              <span className="text-gray-400">Ask: </span>
              <span className="font-mono">{formatPrice(prices?.downAsk)}</span>
            </div>
          </div>
        </div>

        {/* Combined Stats */}
        <div className="pt-2 border-t border-gray-700 space-y-1 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-gray-400">Sum (Bid+Bid):</span>
            <span className="font-mono">
              {prices ? formatPrice(prices.upBid + prices.downBid) : '--'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-400">Time Remaining:</span>
            <span className="font-mono text-white">{timeRemaining}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default MarketStats;
