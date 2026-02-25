/**
 * OrderExecutor - V12 Unified Order Execution Service
 *
 * Provides a single `preciseBuy()` method for all order types:
 * - ACCUMULATE: Single FAK with liquidity check
 * - FLIP: Chunked FAK with progress tracking
 * - LOCK: GTC resting order for lock fills
 *
 * Key Features:
 * - buyInProgress mutex prevents concurrent orders
 * - Liquidity check (150% threshold) before execution
 * - WSS fill confirmation for accurate position tracking
 * - Chunked execution for large orders
 *
 * IMPORTANT: All order execution goes through this service.
 */

import { PolymarketClient } from './PolymarketClient';
import { OrderBookWebSocket } from './OrderBookWS';
import { TradeResult, Side } from '../types';

// Order execution result
export interface PreciseBuyResult {
  success: boolean;
  filledShares: number;
  filledPrice: number;
  avgPrice: number;
  totalCost: number;
  orderId: string | null;
  status: 'FILLED' | 'PARTIAL' | 'FAILED' | 'NO_LIQUIDITY' | 'KILLED';
}

// Parameters for preciseBuy
export interface PreciseBuyParams {
  tokenId: string;
  side: Side;
  shares: number;
  maxPrice: number;
  orderType: 'ACCUMULATE' | 'FLIP' | 'LOCK';
}

// GTC lock order result
export interface GtcLockResult {
  success: boolean;
  orderId: string | null;
  immediatelyFilled: number;
  fillPrice: number;
  resting: boolean;
  error?: string;
}

// FAK fill result from WSS confirmation
export interface FAKFillResult {
  filled: boolean;
  filledShares: number;
  filledPrice: number;
  status: 'MATCHED' | 'CANCELLED' | 'EXPIRED' | 'TIMEOUT';
}

// Pending FAK state for WSS resolution
interface PendingFAKState {
  orderId: string;
  side: Side;
  tokenId: string;
  requestedShares: number;
  maxPrice: number;
  type: 'ACCUMULATE' | 'FLIP_CHUNK' | 'LOCK_CHUNK';
  resolve: (result: FAKFillResult) => void;
  timeout: NodeJS.Timeout;
}

// Chunked execution state
interface ChunkState {
  totalRequired: number;
  totalFilled: number;
  totalCost: number;
  side: Side;
  tokenId: string;
  maxPrice: number;
}

export class OrderExecutor {
  private client: PolymarketClient;
  private orderBookWS: OrderBookWebSocket | null = null;
  private testMode: boolean;

  // NOTE: buyInProgress mutex is managed by the STRATEGY (BilateralStrategyV6)
  // This service is a pure execution layer - no mutex logic here

  // Pending FAK order state (for WSS promise resolution)
  private pendingFAKState: PendingFAKState | null = null;

  // Chunked execution state
  private chunkState: ChunkState | null = null;

  // Constants
  private readonly MAX_CHUNK_SIZE = 20;
  private readonly LIQUIDITY_THRESHOLD = 1.5;  // 150% = no chunking needed
  private readonly WSS_TIMEOUT = 5000;  // 5 seconds
  private readonly LIQUIDITY_WAIT_TIMEOUT = 10000;  // 10 seconds

  // Callbacks for external notifications
  private onOrderFilled?: (orderId: string, shares: number, price: number, side: Side) => void;

  constructor(client: PolymarketClient) {
    this.client = client;
    this.testMode = process.env.TESTBUY === 'true';
  }

  // ============================================================
  // LIFECYCLE
  // ============================================================

  /**
   * Set the order book WebSocket for liquidity checking
   */
  setOrderBookWS(ws: OrderBookWebSocket): void {
    this.orderBookWS = ws;
  }

  /**
   * Set callbacks for order events
   */
  setCallbacks(callbacks: {
    onOrderFilled?: (orderId: string, shares: number, price: number, side: Side) => void;
  }): void {
    this.onOrderFilled = callbacks.onOrderFilled;
  }

  /**
   * Get pending FAK order ID (for WSS matching)
   */
  getPendingOrderId(): string | null {
    return this.pendingFAKState?.orderId || null;
  }

  // ============================================================
  // MAIN ENTRY POINT: preciseBuy()
  // ============================================================

  /**
   * Execute a precise buy order with liquidity check and WSS confirmation
   *
   * This is the UNIFIED entry point for all buy operations.
   *
   * Flow:
   * 1. Check mutex - fail if another buy in progress
   * 2. Check liquidity (150% threshold)
   * 3. If insufficient liquidity, wait up to 10s
   * 4. Execute IOC order
   * 5. Return result
   *
   * @param params - Order parameters
   * @returns Promise<PreciseBuyResult>
   */
  async preciseBuy(params: PreciseBuyParams): Promise<PreciseBuyResult> {
    const { tokenId, side, shares, maxPrice, orderType } = params;

    // NOTE: Mutex (tradeInProgress) is managed by the strategy layer, not here
    // This is a pure execution method

    // TESTBUY mode - simulate the buy
    if (this.testMode) {
      return this.simulateBuy(params);
    }

    try {
      // 1. Check liquidity (>= 150% threshold)
      const availableLiquidity = this.checkLiquidity(tokenId, shares, maxPrice);
      const liquidityRatio = availableLiquidity / shares;

      // Check if liquidity >= 150% (LIQUIDITY_THRESHOLD = 1.5)
      if (liquidityRatio < this.LIQUIDITY_THRESHOLD) {
        console.log(`   ❌ Insufficient liquidity for ${shares} ${side}`);
        return {
          success: false,
          filledShares: 0,
          filledPrice: 0,
          avgPrice: 0,
          totalCost: 0,
          orderId: null,
          status: 'NO_LIQUIDITY',
        };
      }

      // 2. Create promise for WSS TRADE event confirmation
      const fillPromise = new Promise<FAKFillResult>((resolve) => {
        // Timeout fallback (5 seconds)
        const timeout = setTimeout(() => {
          if (this.pendingFAKState) {
            // Silent timeout - no log spam
            resolve({
              filled: false,
              filledShares: 0,
              filledPrice: 0,
              status: 'TIMEOUT',
            });
            this.pendingFAKState = null;
          }
        }, this.WSS_TIMEOUT);

        // Store pending state with resolver
        this.pendingFAKState = {
          orderId: '',
          side,
          tokenId,
          requestedShares: shares,
          maxPrice,
          type: orderType === 'ACCUMULATE' ? 'ACCUMULATE' :
                orderType === 'FLIP' ? 'FLIP_CHUNK' : 'LOCK_CHUNK',
          resolve: (result) => {
            clearTimeout(timeout);
            resolve(result);
          },
          timeout,
        };
      });

      // 3. Execute FAK order (allows partial fills)
      const result = await this.client.buySharesFAK(tokenId, shares, maxPrice);

      if (!result.success || !result.orderID) {
        // Only log error message, not full details
        const errorMsg = result.error?.split(',')[0] || 'Order rejected';
        console.log(`   ❌ ${errorMsg}`);
        if (this.pendingFAKState) {
          this.pendingFAKState.resolve({
            filled: false,
            filledShares: 0,
            filledPrice: 0,
            status: 'CANCELLED',
          });
          this.pendingFAKState = null;
        }
        return {
          success: false,
          filledShares: 0,
          filledPrice: 0,
          avgPrice: 0,
          totalCost: 0,
          orderId: null,
          status: 'FAILED',
        };
      }

      // CRITICAL FIX: Trust API response fill data instead of waiting for WSS
      // The WSS event may arrive BEFORE the API returns, causing order ID mismatch
      // and false timeout. The API response already contains accurate fill data.

      // Check if API returned fill data
      if (result.filledShares && result.filledShares > 0) {
        const filledShares = result.filledShares;
        const filledPrice = result.filledPrice || maxPrice;
        const totalCost = filledShares * filledPrice;

        // Clean log - no internal details
        console.log(`   ✅ Filled ${filledShares.toFixed(0)} ${side} @ $${filledPrice.toFixed(3)} = $${totalCost.toFixed(2)}`);

        // Cancel the WSS timeout since we got fill from API
        if (this.pendingFAKState) {
          clearTimeout(this.pendingFAKState.timeout);
          this.pendingFAKState = null;
        }

        // Notify callback
        if (this.onOrderFilled) {
          this.onOrderFilled(result.orderID, filledShares, filledPrice, side);
        }

        return {
          success: true,
          filledShares,
          filledPrice,
          avgPrice: filledPrice,
          totalCost,
          orderId: result.orderID,
          status: filledShares >= shares ? 'FILLED' : 'PARTIAL',
        };
      }

      // No fill data from API - wait for WSS confirmation as fallback
      if (this.pendingFAKState) {
        this.pendingFAKState.orderId = result.orderID;
      }

      // Wait for WSS confirmation
      const fillResult = await fillPromise;

      // Return result based on WSS confirmation
      if (fillResult.filled && fillResult.filledShares > 0) {
        const totalCost = fillResult.filledShares * fillResult.filledPrice;
        console.log(`   ✅ Filled ${fillResult.filledShares.toFixed(0)} ${side} @ $${fillResult.filledPrice.toFixed(3)} = $${totalCost.toFixed(2)}`);

        // Notify callback
        if (this.onOrderFilled) {
          this.onOrderFilled(result.orderID, fillResult.filledShares, fillResult.filledPrice, side);
        }

        return {
          success: true,
          filledShares: fillResult.filledShares,
          filledPrice: fillResult.filledPrice,
          avgPrice: fillResult.filledPrice,
          totalCost,
          orderId: result.orderID,
          status: fillResult.filledShares >= shares ? 'FILLED' : 'PARTIAL',
        };
      } else {
        console.log(`   ❌ No fill (${fillResult.status})`);
        return {
          success: false,
          filledShares: 0,
          filledPrice: 0,
          avgPrice: 0,
          totalCost: 0,
          orderId: result.orderID,
          status: fillResult.status === 'TIMEOUT' ? 'FAILED' : 'KILLED',
        };
      }
    } catch (error) {
      console.error(`   ❌ preciseBuy exception: ${error}`);
      if (this.pendingFAKState) {
        this.pendingFAKState = null;
      }
      return {
        success: false,
        filledShares: 0,
        filledPrice: 0,
        avgPrice: 0,
        totalCost: 0,
        orderId: null,
        status: 'FAILED',
      };
    }
  }

  // ============================================================
  // CHUNKED EXECUTION: preciseFlipBuy()
  // ============================================================

  /**
   * Execute flip buy with chunking support
   *
   * Used for flippening when:
   * - Order size > available liquidity
   * - Need to chunk into smaller orders to fill
   *
   * Flow:
   * 1. Check total liquidity
   * 2. If >= 150%, use single preciseBuy
   * 3. If < 150%, chunk into MAX_CHUNK_SIZE orders
   * 4. Loop until filled or max retries
   *
   * @param params - Order parameters
   * @param maxChunks - Maximum number of chunk attempts (default 10)
   * @returns Promise<PreciseBuyResult> with total filled
   */
  async preciseFlipBuy(
    params: PreciseBuyParams,
    maxChunks: number = 10
  ): Promise<PreciseBuyResult> {
    const { tokenId, side, shares, maxPrice } = params;

    // NOTE: Mutex is managed by the strategy layer, not here

    // TESTBUY mode - simulate
    if (this.testMode) {
      return this.simulateBuy(params);
    }

    // Check if single order is sufficient
    const availableLiquidity = this.checkLiquidity(tokenId, shares, maxPrice);
    const liquidityRatio = availableLiquidity / shares;

    if (liquidityRatio >= this.LIQUIDITY_THRESHOLD) {
      // Single order sufficient
      console.log(`   📊 Flip buy: sufficient liquidity (${(liquidityRatio * 100).toFixed(0)}%), using single order`);
      return this.preciseBuy(params);
    }

    // Chunked execution required
    console.log(`   📊 Flip buy: insufficient liquidity (${(liquidityRatio * 100).toFixed(0)}%), chunking...`);

    // Initialize chunk state
    this.chunkState = {
      totalRequired: shares,
      totalFilled: 0,
      totalCost: 0,
      side,
      tokenId,
      maxPrice,
    };

    try {
      let chunkCount = 0;

      while (this.chunkState.totalFilled < this.chunkState.totalRequired && chunkCount < maxChunks) {
        chunkCount++;
        const remaining = this.chunkState.totalRequired - this.chunkState.totalFilled;
        const chunkSize = Math.min(remaining, this.MAX_CHUNK_SIZE);

        console.log(`   🔄 Chunk ${chunkCount}: ${chunkSize}/${remaining} remaining`);

        // Wait for chunk liquidity
        const available = this.checkLiquidity(tokenId, chunkSize, maxPrice);
        if (available < chunkSize) {
          console.log(`   ⏳ Waiting for chunk liquidity...`);
          const hasLiquidity = await this.waitForLiquidity(tokenId, chunkSize, maxPrice, 15000);
          if (!hasLiquidity) {
            console.log(`   ⚠️ Chunk liquidity timeout - continuing with available`);
          }
        }

        // Execute chunk FOK
        const result = await this.client.buySharesFOK(tokenId, chunkSize, maxPrice);

        if (result.success && result.filledShares && result.filledShares > 0) {
          const filledShares = result.filledShares;
          const filledPrice = result.filledPrice || maxPrice;

          this.chunkState.totalFilled += filledShares;
          this.chunkState.totalCost += filledShares * filledPrice;

          console.log(`   ✅ Chunk ${chunkCount} filled: ${filledShares} @ $${filledPrice.toFixed(4)}`);

          // Notify callback
          if (this.onOrderFilled && result.orderID) {
            this.onOrderFilled(result.orderID, filledShares, filledPrice, side);
          }
        } else {
          console.log(`   ❌ Chunk ${chunkCount} failed: ${result.error}`);
          // Continue trying next chunk
        }

        // Small delay between chunks
        await this.sleep(500);
      }

      // Calculate results
      const totalFilled = this.chunkState.totalFilled;
      const totalCost = this.chunkState.totalCost;
      const avgPrice = totalFilled > 0 ? totalCost / totalFilled : 0;
      const fillRatio = totalFilled / shares;

      console.log(`   📊 Flip buy complete: ${totalFilled}/${shares} shares (${(fillRatio * 100).toFixed(0)}%)`);

      const result: PreciseBuyResult = {
        success: totalFilled > 0,
        filledShares: totalFilled,
        filledPrice: avgPrice,  // Use avg price for chunked
        avgPrice,
        totalCost,
        orderId: null,  // Multiple order IDs for chunked
        status: fillRatio >= 1 ? 'FILLED' : fillRatio > 0 ? 'PARTIAL' : 'FAILED',
      };

      return result;
    } catch (error) {
      console.error(`   ❌ Flip buy exception: ${error}`);
      return {
        success: this.chunkState?.totalFilled ? this.chunkState.totalFilled > 0 : false,
        filledShares: this.chunkState?.totalFilled || 0,
        filledPrice: this.chunkState?.totalFilled ? this.chunkState.totalCost / this.chunkState.totalFilled : 0,
        avgPrice: this.chunkState?.totalFilled ? this.chunkState.totalCost / this.chunkState.totalFilled : 0,
        totalCost: this.chunkState?.totalCost || 0,
        orderId: null,
        status: 'FAILED',
      };
    } finally {
      this.chunkState = null;
      // NOTE: Mutex is cleared by strategy layer, not here
    }
  }

  // ============================================================
  // GTC LOCK ORDERS
  // ============================================================

  /**
   * Place a GTC (Good-Till-Cancelled) lock order
   *
   * Used for lock orders that rest on the book until filled.
   * NOTE: Lock orders are non-blocking (can be placed while mutex is held)
   *
   * @param tokenId - Token to buy
   * @param side - UP or DOWN
   * @param shares - Number of shares
   * @param price - Limit price
   * @returns Promise<GtcLockResult>
   */
  async placeLockOrder(
    tokenId: string,
    side: Side,
    shares: number,
    price: number
  ): Promise<GtcLockResult> {

    // TESTBUY mode - simulate GTC placement
    if (this.testMode) {
      console.log(`   [TESTBUY] GTC lock simulated: ${shares} ${side} @ $${price.toFixed(4)}`);
      return {
        success: true,
        orderId: `TESTBUY-${Date.now()}`,
        immediatelyFilled: 0,
        fillPrice: price,
        resting: true,
      };
    }

    const result = await this.client.buySharesGTC(tokenId, shares, price);

    if (!result.success) {
      const errorMsg = result.error?.split(',')[0] || 'GTC lock failed';
      console.log(`   ❌ ${errorMsg}`);
      return {
        success: false,
        orderId: null,
        immediatelyFilled: 0,
        fillPrice: 0,
        resting: false,
        error: result.error,
      };
    }

    const immediatelyFilled = result.filledShares || 0;
    const resting = result.details?.resting || false;

    // Notify callback if filled
    if (immediatelyFilled > 0 && this.onOrderFilled && result.orderID) {
      this.onOrderFilled(result.orderID, immediatelyFilled, result.filledPrice || price, side);
    }

    return {
      success: true,
      orderId: result.orderID || null,
      immediatelyFilled,
      fillPrice: result.filledPrice || price,
      resting,
    };
  }

  /**
   * Cancel all orders for a market (or specific token)
   * Used when resetting lock orders
   *
   * V19: Returns cancelled count to detect if order was already filled
   * (cancelledCount=0 means order was already fully filled before cancel)
   *
   * @param conditionId - Market condition ID
   * @param tokenId - Optional: specific token to cancel
   */
  async cancelOrders(conditionId: string, tokenId?: string): Promise<{ success: boolean; cancelledCount: number }> {
    if (this.testMode) {
      console.log(`   [TESTBUY] Cancel all simulated for market`);
      return { success: true, cancelledCount: 1 };
    }

    try {
      const result = await this.client.cancelOrders(conditionId, tokenId);
      const cancelledCount = result.cancelled?.length || 0;
      if (result.success) {
        console.log(`   ✅ Cancelled ${cancelledCount} orders`);
        return { success: true, cancelledCount };
      } else {
        console.log(`   ⚠️ Cancel failed: ${result.error}`);
        return { success: false, cancelledCount: 0 };
      }
    } catch (error) {
      console.error(`   ❌ Cancel failed: ${error}`);
      return { success: false, cancelledCount: 0 };
    }
  }

  // ============================================================
  // WSS INTEGRATION
  // ============================================================

  /**
   * Handle order update from WSS
   * Called by the strategy when it receives an order update event
   *
   * @param orderId - Order ID from WSS
   * @param status - Order status (MATCHED, CANCELLED, EXPIRED)
   * @param filledShares - Number of shares filled
   * @param filledPrice - Fill price
   */
  handleWSSOrderUpdate(
    orderId: string,
    status: 'LIVE' | 'MATCHED' | 'CANCELLED' | 'EXPIRED',
    filledShares: number,
    filledPrice: number
  ): void {
    // Check if this is for our pending FAK
    if (this.pendingFAKState && this.pendingFAKState.orderId === orderId) {
      const result: FAKFillResult = {
        filled: status === 'MATCHED' && filledShares > 0,
        filledShares,
        filledPrice,
        status: status === 'MATCHED' ? 'MATCHED' : status === 'CANCELLED' ? 'CANCELLED' : 'EXPIRED',
      };
      this.pendingFAKState.resolve(result);
      clearTimeout(this.pendingFAKState.timeout);
      this.pendingFAKState = null;
    }
  }

  // ============================================================
  // LIQUIDITY CHECKING (moved from strategy)
  // ============================================================

  /**
   * Check available liquidity at a given price
   *
   * @param tokenId - Token to check
   * @param requiredSize - Shares needed
   * @param maxPrice - Maximum price willing to pay
   * @returns Available quantity at or below maxPrice
   */
  checkLiquidity(tokenId: string, requiredSize: number, maxPrice: number): number {
    if (!this.orderBookWS) {
      console.warn(`⚠️ [OrderExecutor] No orderBookWS - cannot check liquidity`);
      return 0;
    }
    // Round UP to next cent for orderbook matching (orderbook only has whole cents)
    const roundedPrice = Math.ceil(maxPrice * 100) / 100;
    return this.orderBookWS.getAvailableQuantityAtPrice(tokenId, roundedPrice) || 0;
  }

  /**
   * Wait for liquidity to become available
   *
   * @param tokenId - Token to check
   * @param requiredSize - Shares needed
   * @param maxPrice - Maximum price
   * @param timeout - Max wait time (ms)
   * @returns true if liquidity became available
   */
  async waitForLiquidity(
    tokenId: string,
    requiredSize: number,
    maxPrice: number,
    timeout: number = 30000
  ): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 500;

    while (Date.now() - startTime < timeout) {
      const available = this.checkLiquidity(tokenId, requiredSize, maxPrice);

      if (available >= requiredSize) {
        return true;
      }

      // Periodic logging (every 5 seconds)
      const elapsed = Date.now() - startTime;
      if (elapsed % 5000 < checkInterval) {
        console.log(`   ⏳ Waiting for liquidity: ${available.toFixed(0)}/${requiredSize} @ $${maxPrice.toFixed(3)}`);
      }

      await this.sleep(checkInterval);
    }

    console.log(`   ⏰ Liquidity wait timeout after ${timeout / 1000}s`);
    return false;
  }

  // ============================================================
  // HELPERS
  // ============================================================

  /**
   * Simulate a buy in TESTBUY mode
   */
  private simulateBuy(params: PreciseBuyParams): PreciseBuyResult {
    const { side, shares, maxPrice, orderType } = params;

    // Simulate at a slightly better price (mid-range)
    const simulatedPrice = maxPrice - 0.01;
    const totalCost = shares * simulatedPrice;

    console.log(`   [TESTBUY] Simulated ${orderType}: ${shares} ${side} @ $${simulatedPrice.toFixed(4)} = $${totalCost.toFixed(2)}`);

    return {
      success: true,
      filledShares: shares,
      filledPrice: simulatedPrice,
      avgPrice: simulatedPrice,
      totalCost,
      orderId: `TESTBUY-${Date.now()}`,
      status: 'FILLED',
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
