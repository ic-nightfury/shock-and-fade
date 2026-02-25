import { useMemo } from 'react';

const UP_COLOR = '#10B981';
const DOWN_COLOR = '#EF4444';

/**
 * Format price for display
 */
function formatPrice(price) {
  return (price * 100).toFixed(1) + '¢';
}

/**
 * OrderBookPanel - Display pending orders grouped by side
 */
export function OrderBookPanel({ orders }) {
  const { upOrders, downOrders } = useMemo(() => {
    const orderList = Object.values(orders || {});
    return {
      upOrders: orderList
        .filter(o => o.side === 'UP')
        .sort((a, b) => b.price - a.price),
      downOrders: orderList
        .filter(o => o.side === 'DOWN')
        .sort((a, b) => b.price - a.price)
    };
  }, [orders]);

  const totalOrders = upOrders.length + downOrders.length;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-300">Pending Orders</h3>
        <span className="text-xs text-gray-500">{totalOrders} active</span>
      </div>

      {totalOrders === 0 ? (
        <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
          No pending orders
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-3">
          {/* UP Orders */}
          {upOrders.length > 0 && (
            <div>
              <div className="text-xs font-medium mb-1" style={{ color: UP_COLOR }}>
                UP ({upOrders.length})
              </div>
              <div className="space-y-1">
                {upOrders.map((order, idx) => (
                  <OrderRow key={order.orderId || idx} order={order} color={UP_COLOR} />
                ))}
              </div>
            </div>
          )}

          {/* DOWN Orders */}
          {downOrders.length > 0 && (
            <div>
              <div className="text-xs font-medium mb-1" style={{ color: DOWN_COLOR }}>
                DOWN ({downOrders.length})
              </div>
              <div className="space-y-1">
                {downOrders.map((order, idx) => (
                  <OrderRow key={order.orderId || idx} order={order} color={DOWN_COLOR} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OrderRow({ order, color }) {
  return (
    <div
      className="flex items-center justify-between bg-gray-700/50 rounded px-2 py-1 text-xs"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono">{formatPrice(order.price)}</span>
        <span className="text-gray-400">×</span>
        <span>{order.size}</span>
      </div>
      <span className="text-gray-500 uppercase text-[10px]">
        {order.orderType || 'LIMIT'}
      </span>
    </div>
  );
}

export default OrderBookPanel;
