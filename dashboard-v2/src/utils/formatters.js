/**
 * Format price as cents (e.g., 0.52 -> "52.0¢")
 */
export function formatPrice(price) {
  if (price === undefined || price === null) return '--';
  return (price * 100).toFixed(1) + '¢';
}

/**
 * Format currency (e.g., 1.5 -> "$1.50")
 */
export function formatCurrency(value) {
  if (value === undefined || value === null) return '--';
  const prefix = value >= 0 ? '' : '-';
  return `${prefix}$${Math.abs(value).toFixed(2)}`;
}

/**
 * Format timestamp as HH:MM:SS
 */
export function formatTime(timestamp) {
  if (!timestamp) return '--:--:--';
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/**
 * Format timestamp as MM:SS for chart axis
 */
export function formatTimeShort(timestamp) {
  if (!timestamp) return '--:--';
  const date = new Date(timestamp);
  return `${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
}

/**
 * Format seconds as MM:SS countdown
 */
export function formatCountdown(seconds) {
  if (seconds === undefined || seconds === null || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format percentage (e.g., 0.52 -> "52%")
 */
export function formatPercent(value) {
  if (value === undefined || value === null) return '--';
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Truncate string with ellipsis
 */
export function truncate(str, maxLength = 20) {
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Format order ID for display (first 8 chars)
 */
export function formatOrderId(orderId) {
  if (!orderId) return '--';
  return orderId.slice(0, 8);
}
