export interface PolymarketConfig {
  host: string;
  chainId: number;
  privateKey: string;
  funderAddress: string;
  authMode?: 'EOA' | 'PROXY';  // EOA = direct wallet, PROXY = Gnosis Safe (default: PROXY)
}

export interface TradeParams {
  marketSlug: string;
  outcome: string;
  amountUSD: number;
  side: 'BUY' | 'SELL';
  tokenId?: string;
}

export interface TradeResult {
  success: boolean;
  orderID?: string;
  error?: string;
  filledShares?: number;
  filledPrice?: number;
  details?: {
    totalCost: number;
    shares: number;
    pricePerShare: number;
    requestedShares?: number;  // For GTC orders: original requested shares
    orderedShares?: number;    // V51: Actual shares ordered (after CLOB rounding)
    resting?: boolean;         // For GTC orders: true if order is resting on book
  };
}

export interface MarketInfo {
  slug: string;
  question: string;
  conditionId: string;
  endDate: string;
  startTime: number;
  tokens: Array<{
    token_id: string;
    outcome: string;
  }>;
  clobTokenIds?: string[];
  outcomes?: string[];
  outcomePrices?: string[];  // Current prices for each outcome ["0.52", "0.48"]
}

export interface OrderResult {
  orderID: string;
  success: boolean;
  transactionHash?: string;
  error?: string;
}

// Timing constants for the strategy
export const TIMING = {
  ENTRY_WINDOW_START: 0,       // Second 0
  ENTRY_WINDOW_END: 120,       // Second 120 (2 minutes - wait for order book liquidity)
  TAKE_PROFIT_END: 300,        // Second 300 (5 minutes - conditional TP window ends)
  PNL_CHECK_TIME: 890,         // 14:50 (14 * 60 + 50)
  MARKET_END: 900,             // 15:00 (15 * 60)
  REDEMPTION_DELAY: 600000,    // 10 minutes after market end (ms)
  LOOP_INTERVAL: 2000,         // Main loop every 2 seconds (ms)
  MAX_REMAINING_TO_START: 893, // Only trade when remaining < 14:53 (wait 7 seconds into market)
};

// Trading thresholds (fixed values)
// NOTE: Stop-loss disabled - positions ride to settlement
export const THRESHOLDS = {};

// Get configurable thresholds from environment (legacy - kept for backward compatibility)
export function getConfigurableThresholds() {
  return {
    MAX_ENTRY_PRICE: parseFloat(process.env.MAX_ENTRY_PRICE || '0.55'),
    MIN_POSITION_SIZE: parseFloat(process.env.MIN_POSITION_SIZE || '1'),
    RECOVERY_PROFIT_TARGET: parseFloat(process.env.RECOVERY_PROFIT_TARGET || '0.5'),
    CAPITAL_BASE: parseFloat(process.env.CAPITAL_BASE || '100'),
    MAX_FULL_RECOVERY_LOSS: parseFloat(process.env.MAX_FULL_RECOVERY_LOSS || '50'),
  };
}

// Side type for arbitrage
export type Side = 'UP' | 'DOWN';

// Trade Decision from the engine
export interface TradeDecision {
  action: 'BUY' | 'WAIT' | 'STOP';
  side?: Side;
  size?: number;
  reason: string;
}

// Profit-Lock Strategy Configuration
// Based on Gabagool22's successful trading patterns
// Key insight: Balance is just as important as pair cost!
export interface ProfitLockConfig {
  // Lock thresholds
  targetPairCost: number;         // Target pair cost (0.975)
  maxPairCost: number;            // Max acceptable pair cost (0.985)
  targetImbalance: number;        // Target imbalance ratio (1.03)
  maxImbalance: number;           // Max acceptable imbalance (1.05)
  criticalImbalance: number;      // Critical - only buy smaller side (1.10)

  // Sizing (V8 Linear Flippening Scaling)
  baseSize: number;               // Base shares per trade (10)
  sizeIncrement: number;          // Size increment per flip (12) - buySize = baseSize + (flipCount * sizeIncrement)
  extremeMultiplier: number;      // Size multiplier in extreme zone (2.0) - legacy
  balanceMultiplier: number;      // Size multiplier when rebalancing (1.5) - legacy

  // Price thresholds
  extremeThreshold: number;       // Always buy below this (0.25)
  expensiveThreshold: number;     // Buy only for balance above this (0.60)

  // Timing (seconds)
  accumulationPhaseEnd: number;   // End of aggressive accumulation (400)
  balancingPhaseEnd: number;      // End of balancing phase (600)
  stopTradingBefore: number;      // Stop trading before settlement (60)
}

export function getProfitLockConfig(): ProfitLockConfig {
  const pairCostTarget = parseFloat(process.env.PAIR_COST_TARGET || '0.98');
  return {
    targetPairCost: pairCostTarget,
    maxPairCost: pairCostTarget,
    targetImbalance: parseFloat(process.env.TARGET_IMBALANCE || '1.03'),
    maxImbalance: parseFloat(process.env.MAX_IMBALANCE || '1.05'),
    criticalImbalance: parseFloat(process.env.CRITICAL_IMBALANCE || '1.10'),
    baseSize: parseFloat(process.env.BASE_SIZE || '10'),
    sizeIncrement: parseFloat(process.env.SIZE_INCREMENT || '12'),
    extremeMultiplier: parseFloat(process.env.EXTREME_MULTIPLIER || '2.0'),
    balanceMultiplier: parseFloat(process.env.BALANCE_MULTIPLIER || '1.5'),
    extremeThreshold: parseFloat(process.env.EXTREME_THRESHOLD || '0.25'),
    expensiveThreshold: parseFloat(process.env.EXPENSIVE_THRESHOLD || '0.60'),
    accumulationPhaseEnd: parseInt(process.env.ACCUMULATION_PHASE_END || '400'),
    balancingPhaseEnd: parseInt(process.env.BALANCING_PHASE_END || '600'),
    stopTradingBefore: parseInt(process.env.STOP_TRADING_BEFORE || '60'),
  };
}

export interface ActivePosition {
  id: number;
  marketSlug: string;
  conditionId: string;
  tokenId: string;
  entryPrice: number;
  shares: number;
  entryTime: number;
  marketEndTime: number;
}

export interface PositionApiResponse {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  endDate: string;
}

export interface ClosedPositionApiResponse {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  avgPrice: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  endDate: string;
}
