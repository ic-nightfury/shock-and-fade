/**
 * Polymarket Trading Client
 * Uses POLY_GNOSIS_SAFE signature type (signature type 2) for Gnosis Safe wallets
 *
 * Rate Limiting (US-411):
 * All API calls are wrapped with rate limiting to prevent Cloudflare Error 1015.
 * See RateLimiter.ts for limits and configuration.
 */

import {
  ClobClient,
  Side,
  OrderType,
  AssetType,
} from "@polymarket/clob-client";
import { ApiKeyCreds } from "@polymarket/clob-client";
import { SignatureType } from "@polymarket/order-utils";
import { Wallet } from "@ethersproject/wallet";
import { ethers } from "ethers";
import axios from "axios";
import {
  PolymarketConfig,
  TradeParams,
  TradeResult,
  MarketInfo,
} from "../types";
import { BalanceMonitorWS } from "./BalanceMonitorWS";
import {
  RateLimiter,
  getGlobalRateLimiter,
  EndpointCategory,
} from "./RateLimiter";

/**
 * Calculate minimum shares required for an order at a given price
 * Polymarket has TWO minimums:
 * 1. Minimum 5 shares
 * 2. Minimum $1 transaction value
 * At low prices (< $0.20), need more than 5 shares to meet $1 minimum
 */
function getMinimumShares(price: number): number {
  const MIN_SHARES = 5;
  const MIN_USDC = 1.0;
  const sharesFor1Dollar = Math.ceil(MIN_USDC / Math.max(0.01, price));
  return Math.max(MIN_SHARES, sharesFor1Dollar);
}

export class PolymarketClient {
  private clobClient: ClobClient | null = null;
  private config: PolymarketConfig;
  private signer: Wallet;
  private creds: Promise<ApiKeyCreds>;
  private initialized: boolean = false;
  private polygonProvider: ethers.providers.JsonRpcProvider;
  private balanceMonitor: BalanceMonitorWS | null = null;
  private rateLimiter: RateLimiter;

  constructor(config: PolymarketConfig, rateLimiter?: RateLimiter) {
    this.config = config;
    this.signer = new Wallet(config.privateKey);
    this.rateLimiter = rateLimiter || getGlobalRateLimiter();

    // Initialize Polygon RPC provider for balance queries
    const rpcUrl = process.env.RPC_URL || "https://polygon-rpc.com";
    this.polygonProvider = new ethers.providers.JsonRpcProvider(rpcUrl);

    // CRITICAL: API keys are created with DEFAULT client (no signatureType)
    // Then USED with POLY_GNOSIS_SAFE client for trading
    const tempClient = new ClobClient(config.host, config.chainId, this.signer);
    this.creds = tempClient.createOrDeriveApiKey();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const apiCreds = await this.creds;

    // Determine signature type and funder based on AUTH_MODE (default: PROXY)
    const authMode = this.config.authMode || "PROXY";
    const isEOA = authMode === "EOA";
    const signatureType = isEOA
      ? SignatureType.EOA
      : SignatureType.POLY_GNOSIS_SAFE;
    const funderAddress = isEOA
      ? this.signer.address
      : this.config.funderAddress;

    // Create CLOB client with appropriate signature type
    this.clobClient = new ClobClient(
      this.config.host,
      this.config.chainId,
      this.signer,
      apiCreds,
      signatureType,
      funderAddress,
    );

    this.initialized = true;
    console.log(`✅ Polymarket client initialized (${authMode} mode)`);
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.clobClient) {
      throw new Error("Client not initialized. Call initialize() first.");
    }
  }

  /**
   * Get derived API credentials for WebSocket authentication
   */
  async getApiCreds(): Promise<{
    key: string;
    secret: string;
    passphrase: string;
  }> {
    const creds = await this.creds;
    return {
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase,
    };
  }

  /**
   * Get token balance using CLOB API.
   * US-415: Added for fast token balance queries.
   *
   * @param tokenId - The conditional token ID
   * @returns Balance in shares (not raw units)
   */
  async getTokenBalance(tokenId: string): Promise<number> {
    this.ensureInitialized();

    try {
      const balanceAllowance = await this.clobClient!.getBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: tokenId,
      });

      if (balanceAllowance && balanceAllowance.balance !== undefined) {
        // CLOB API returns balance in raw units (6 decimals)
        const balance = Math.floor(Number(balanceAllowance.balance) / 1e6);
        return balance;
      }
      return 0;
    } catch (error: any) {
      console.error(
        `[PolymarketClient] getTokenBalance failed: ${error.message}`,
      );
      throw error; // Let caller handle fallback
    }
  }

  // Cache of approved token IDs to avoid repeated API calls (US-420)
  private approvedTokens: Set<string> = new Set();

  /**
   * Ensure conditional token (shares) has allowance for CLOB trading
   * US-420: Only calls updateBalanceAllowance when actually needed
   * - Caches approved tokens to avoid repeated API calls
   * - Checks current allowance before updating
   */
  async ensureConditionalTokenApproval(tokenId: string): Promise<void> {
    this.ensureInitialized();

    // Skip if already approved in this session
    if (this.approvedTokens.has(tokenId)) {
      return;
    }

    try {
      // Check current allowance
      const balanceAllowance = await this.clobClient!.getBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: tokenId,
      });

      // Parse allowance - Polymarket returns allowance as string or undefined
      const allowance = balanceAllowance?.allowance
        ? BigInt(balanceAllowance.allowance)
        : BigInt(0);

      // Allowance is "unlimited" if > 1e20 (effectively infinite approval)
      const SUFFICIENT_ALLOWANCE = BigInt("100000000000000000000"); // 1e20

      if (allowance >= SUFFICIENT_ALLOWANCE) {
        // Already has sufficient allowance - cache and skip
        console.log(`✅ Token allowance sufficient (cached)`);
        this.approvedTokens.add(tokenId);
        return;
      }

      // Need to set/update allowance
      console.log(`🔐 Setting up token approval for selling...`);
      await this.clobClient!.updateBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: tokenId,
      });
      console.log(`✅ Token approval updated`);
      this.approvedTokens.add(tokenId);
    } catch (error: any) {
      // Log the full error for debugging
      console.error("⚠️ Token approval FAILED:", error?.message || error);
      if (error?.response?.data) {
        console.error("   API response:", JSON.stringify(error.response.data));
      }
      // DO NOT cache as approved — next attempt should retry the approval
      // This was the root cause of "not enough balance / allowance" errors:
      // caching failures as successes meant all subsequent sells skipped approval
      throw new Error(`Token approval failed for ${tokenId.slice(0, 12)}...: ${error?.message || error}`);
    }
  }

  /**
   * Clear approved tokens cache (call when switching markets)
   */
  clearApprovalCache(): void {
    this.approvedTokens.clear();
  }

  /**
   * Execute a BUY order with USD amount and max price
   * Note: Polymarket API expects amount in USD, not shares
   */
  async buyShares(
    tokenId: string,
    amountUSD: number,
    maxPrice: number,
  ): Promise<TradeResult> {
    this.ensureInitialized();

    // CRITICAL: Ensure amount (USD) has max 2 decimals (CLOB rejects 4-decimal amounts)
    const roundedAmount = Math.round(amountUSD * 100) / 100;

    try {
      console.log(
        `📊 BUY $${roundedAmount.toFixed(2)} at max $${maxPrice.toFixed(4)}`,
      );

      const marketOrder = await this.clobClient!.createMarketOrder({
        tokenID: tokenId,
        side: Side.BUY,
        amount: roundedAmount,
        price: Math.min(maxPrice, 0.99),
        feeRateBps: 0,
        nonce: 0,
      });

      const response = await this.clobClient!.postOrder(
        marketOrder,
        OrderType.FAK,
      );

      if (response.error || response.status === 400) {
        throw new Error(response.error || "Order failed with status 400");
      }

      if (!response.orderID) {
        throw new Error("No orderID returned - trade failed");
      }

      // Calculate actual fill price from response
      // takingAmount = shares received, makingAmount = USD spent
      let filledPrice = maxPrice;
      let filledShares = amountUSD / maxPrice; // fallback estimate

      if (response.takingAmount && response.makingAmount) {
        // V14: Round to 2 decimals for consistent precision
        filledShares =
          Math.round(parseFloat(response.takingAmount) * 100) / 100;
        const spent = parseFloat(response.makingAmount);
        filledPrice = filledShares > 0 ? spent / filledShares : maxPrice;
      }

      return {
        success: true,
        orderID: response.orderID,
        filledShares,
        filledPrice,
        details: {
          totalCost: filledShares * filledPrice,
          shares: filledShares,
          pricePerShare: filledPrice,
        },
      };
    } catch (error) {
      console.error(
        "Trade failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Execute a BUY order at a specific limit price (FAK style)
   * Used for arbitrage strategy - only fills if price is at or below limit
   * Uses FAK (Fill-And-Kill) for immediate execution attempt
   */
  async buyAtLimit(
    tokenId: string,
    limitPrice: number,
    amountUSD: number,
  ): Promise<TradeResult> {
    this.ensureInitialized();

    // CRITICAL: Ensure amount (USD) has max 2 decimals (CLOB rejects 4-decimal amounts)
    const roundedAmount = Math.round(amountUSD * 100) / 100;

    try {
      console.log(
        `📊 BUY LIMIT $${roundedAmount.toFixed(2)} @ $${limitPrice.toFixed(4)}`,
      );

      // Create order at exact limit price
      const marketOrder = await this.clobClient!.createMarketOrder({
        tokenID: tokenId,
        side: Side.BUY,
        amount: roundedAmount,
        price: Math.min(limitPrice, 0.99),
        feeRateBps: 0,
        nonce: 0,
      });

      // FAK = Fill-And-Kill - fill what you can immediately, cancel rest
      const response = await this.clobClient!.postOrder(
        marketOrder,
        OrderType.FAK,
      );

      if (response.error || response.status === 400) {
        return {
          success: false,
          error: response.error || "Order failed with status 400",
        };
      }

      // Check if we got any fill
      if (!response.orderID) {
        return {
          success: false,
          error: "No orderID returned - no fill at limit price",
        };
      }

      // Calculate actual fill from response
      let filledPrice = limitPrice;
      let filledShares = 0;

      if (response.takingAmount && response.makingAmount) {
        // V14: Round to 2 decimals for consistent precision
        filledShares =
          Math.round(parseFloat(response.takingAmount) * 100) / 100;
        const spent = parseFloat(response.makingAmount);
        filledPrice = filledShares > 0 ? spent / filledShares : limitPrice;
      }

      // If no shares filled, return as unsuccessful
      if (filledShares === 0) {
        return {
          success: false,
          orderID: response.orderID,
          error: "Order placed but no shares filled at limit price",
        };
      }

      return {
        success: true,
        orderID: response.orderID,
        filledShares,
        filledPrice,
        details: {
          totalCost: filledShares * filledPrice,
          shares: filledShares,
          pricePerShare: filledPrice,
        },
      };
    } catch (error) {
      console.error(
        "Limit buy failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Execute a BUY order for EXACT share count (GTC - rests on book)
   * Used for lock orders where we need precise share matching
   * Order stays on the book until filled or cancelled
   */
  async buySharesGTC(
    tokenId: string,
    shares: number,
    maxPrice: number,
  ): Promise<TradeResult> {
    this.ensureInitialized();

    // Dynamic minimum: max(5 shares, $1 worth) - at low prices need more shares
    const minShares = getMinimumShares(maxPrice);
    // Round to whole number to avoid USDC precision issues
    // Polymarket requires makerAmount (USDC) with max 2 decimals
    // Whole shares ensures clean USDC: 15 × $0.51 = $7.65 ✓ (not 15.28 × $0.51 = $7.7928 ✗)
    const actualShares = Math.round(Math.max(minShares, shares));
    const price = Math.min(maxPrice, 0.99);

    try {
      // Use createOrder (not createMarketOrder) to specify exact share size
      const limitOrder = await this.clobClient!.createOrder({
        tokenID: tokenId,
        side: Side.BUY,
        size: actualShares,
        price,
        feeRateBps: 0,
        nonce: 0,
      });

      // Post with GTC (Good-Till-Cancelled) - rests on book
      const response = await this.clobClient!.postOrder(
        limitOrder,
        OrderType.GTC,
      );

      if (response.error || response.status === 400) {
        return {
          success: false,
          error: response.error || "Order failed with status 400",
        };
      }

      if (!response.orderID) {
        return {
          success: false,
          error: "No orderID returned",
        };
      }

      // For GTC orders, check if immediately filled or resting
      let filledShares = 0;
      let filledPrice = maxPrice;

      if (response.takingAmount && response.makingAmount) {
        // V14: Round to 2 decimals for consistent precision
        filledShares =
          Math.round(parseFloat(response.takingAmount) * 100) / 100;
        const spent = parseFloat(response.makingAmount);
        filledPrice = filledShares > 0 ? spent / filledShares : maxPrice;
      }

      return {
        success: true,
        orderID: response.orderID,
        filledShares,
        filledPrice,
        details: {
          totalCost:
            filledShares > 0
              ? filledShares * filledPrice
              : actualShares * price,
          shares: filledShares > 0 ? filledShares : actualShares,
          pricePerShare: filledPrice,
          requestedShares: shares, // Original request
          orderedShares: actualShares, // What was actually ordered (after rounding)
          resting: filledShares < actualShares, // If not fully filled, it's resting on book
        },
      };
    } catch (error) {
      console.error(
        "GTC shares buy failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Execute FOK (Fill-Or-Kill) buy order for exact shares
   * Either fills ALL shares immediately or order is cancelled entirely
   * No partial fills - all or nothing
   */
  async buySharesFOK(
    tokenId: string,
    shares: number,
    maxPrice: number,
  ): Promise<TradeResult> {
    this.ensureInitialized();

    // Dynamic minimum: max(5 shares, $1 worth) - at low prices need more shares
    const minShares = getMinimumShares(maxPrice);
    // CRITICAL: Use INTEGER shares - integer * 2-decimal price = max 2-decimal cost
    const actualShares = Math.floor(Math.max(minShares, shares));
    const price = Math.min(maxPrice, 0.99);
    const amountUSD = actualShares * price; // Integer * 2-decimal = 2-decimal max

    try {
      // Use createMarketOrder for FOK (per ORDER_EXAMPLE.md)
      const marketOrder = await this.clobClient!.createMarketOrder({
        tokenID: tokenId,
        side: Side.BUY,
        amount: amountUSD,
        price,
        feeRateBps: 0,
        nonce: 0,
      });

      // Post with FOK (Fill-Or-Kill) - all or nothing
      const response = await this.clobClient!.postOrder(
        marketOrder,
        OrderType.FOK,
      );

      if (response.error || response.status === 400) {
        return {
          success: false,
          error: response.error || response.errorMsg || "FOK order failed",
        };
      }

      // FOK: Either fully filled or nothing
      let filledShares = 0;
      let filledPrice = maxPrice;

      if (response.takingAmount && response.makingAmount) {
        // V14: Round to 2 decimals for consistent precision
        filledShares =
          Math.round(parseFloat(response.takingAmount) * 100) / 100;
        const spent = parseFloat(response.makingAmount);
        filledPrice = filledShares > 0 ? spent / filledShares : maxPrice;
      }

      // FOK failed if no fills (order was killed)
      if (filledShares === 0) {
        return {
          success: false,
          error: "FOK order killed - insufficient liquidity",
        };
      }

      return {
        success: true,
        orderID: response.orderID,
        filledShares,
        filledPrice,
        details: {
          totalCost: filledShares * filledPrice,
          shares: filledShares,
          pricePerShare: filledPrice,
          requestedShares: shares,
          resting: false, // FOK never rests
        },
      };
    } catch (error) {
      console.error(
        "FOK buy failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Execute FAK (Fill-And-Kill) buy order at MARKET PRICE
   * Uses createMarketOrder + FAK - executes at market, catches shares from response
   *
   * @param tokenId - Token to buy
   * @param shares - Number of shares to buy
   * @param estimatedPrice - Estimated price for cost calculation
   * @returns TradeResult with actual filledShares and filledPrice from market
   */
  async buySharesFAK(
    tokenId: string,
    shares: number,
    estimatedPrice: number,
  ): Promise<TradeResult> {
    this.ensureInitialized();

    // Calculate USD amount to spend (shares * estimated price, with buffer)
    const amountUSD = Math.round(shares * estimatedPrice * 100) / 100;
    const minAmount = 1.0; // Polymarket minimum
    const actualAmount = Math.max(minAmount, amountUSD);

    try {
      console.log(
        `📊 MARKET BUY: $${actualAmount.toFixed(2)} USD (target ~${shares} shares)`,
      );

      // createMarketOrder - executes at MARKET PRICE automatically
      // No need for exact price - it fills at whatever market offers
      const marketOrder = await this.clobClient!.createMarketOrder({
        tokenID: tokenId,
        side: Side.BUY,
        amount: actualAmount,
        feeRateBps: 0,
        nonce: 0,
      });

      // Post with FAK - Fill-And-Kill (partial fills OK)
      const response = await this.clobClient!.postOrder(
        marketOrder,
        OrderType.FAK,
      );

      if (response.error || response.status === 400) {
        return {
          success: false,
          error: response.error || response.errorMsg || "Market order failed",
        };
      }

      if (!response.orderID) {
        return {
          success: false,
          error: "No orderID returned - no fill",
        };
      }

      // Catch actual shares bought from response
      // takingAmount = shares received, makingAmount = USD spent
      let filledShares = 0;
      let filledPrice = estimatedPrice;

      if (response.takingAmount && response.makingAmount) {
        filledShares =
          Math.round(parseFloat(response.takingAmount) * 100) / 100;
        const spent = parseFloat(response.makingAmount);
        filledPrice = filledShares > 0 ? spent / filledShares : estimatedPrice;
      }

      // FAK with 0 fills = no liquidity available
      if (filledShares === 0) {
        return {
          success: false,
          error: "FAK order - no liquidity available",
        };
      }

      console.log(
        `✅ MARKET FILL: ${filledShares} shares @ $${filledPrice.toFixed(4)} (spent $${(filledShares * filledPrice).toFixed(2)})`,
      );

      return {
        success: true,
        orderID: response.orderID,
        filledShares,
        filledPrice,
        details: {
          totalCost: filledShares * filledPrice,
          shares: filledShares,
          pricePerShare: filledPrice,
          requestedShares: shares,
          resting: false,
        },
      };
    } catch (error) {
      console.error(
        "Market buy failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Execute IOC (Immediate-Or-Cancel) BUY order for exact shares
   * Alias for buySharesFAK - IOC and FAK have same behavior for buys
   */
  async buySharesIOC(
    tokenId: string,
    shares: number,
    maxPrice: number,
  ): Promise<TradeResult> {
    return this.buySharesFAK(tokenId, shares, maxPrice);
  }

  /**
   * Execute a BUY order at a specific limit price (GTC - rests on book)
   * Order stays on the book until filled or cancelled
   * Uses createOrder() instead of createMarketOrder() for GTC support
   */
  async buyAtLimitGTC(
    tokenId: string,
    limitPrice: number,
    amountUSD: number,
  ): Promise<TradeResult> {
    this.ensureInitialized();

    try {
      // Calculate shares from USD amount - use INTEGER to avoid 4-decimal cost
      const price = Math.min(limitPrice, 0.99);
      const shares = Math.floor(amountUSD / price);
      const actualCost = shares * price; // Integer * 2-decimal = 2-decimal max

      console.log(
        `📊 BUY LIMIT GTC $${actualCost.toFixed(2)} @ $${price.toFixed(4)} (~${shares} shares)`,
      );

      // Use createOrder (not createMarketOrder) for GTC support
      const limitOrder = await this.clobClient!.createOrder({
        tokenID: tokenId,
        side: Side.BUY,
        size: shares,
        price,
        feeRateBps: 0,
        nonce: 0,
      });

      // Post with GTC (Good-Till-Cancelled) - rests on book
      const response = await this.clobClient!.postOrder(
        limitOrder,
        OrderType.GTC,
      );

      if (response.error || response.status === 400) {
        return {
          success: false,
          error: response.error || "Order failed with status 400",
        };
      }

      if (!response.orderID) {
        return {
          success: false,
          error: "No orderID returned",
        };
      }

      // For GTC orders, check if immediately filled or resting
      let filledShares = 0;
      let filledPrice = limitPrice;

      if (response.takingAmount && response.makingAmount) {
        // V14: Round to 2 decimals for consistent precision
        filledShares =
          Math.round(parseFloat(response.takingAmount) * 100) / 100;
        const spent = parseFloat(response.makingAmount);
        filledPrice = filledShares > 0 ? spent / filledShares : limitPrice;
      }

      return {
        success: true,
        orderID: response.orderID,
        filledShares,
        filledPrice,
        details: {
          totalCost: filledShares > 0 ? filledShares * filledPrice : amountUSD,
          shares: filledShares > 0 ? filledShares : shares,
          pricePerShare: filledPrice,
        },
      };
    } catch (error) {
      console.error(
        "GTC limit buy failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Execute a SELL order (for stop-loss)
   * @param tokenId - Token to sell
   * @param shares - Number of shares to sell
   * @param minPrice - Minimum price (default 0.01)
   * @param isNegRisk - If true, use 0% fee (sports markets). Default false (10% fee for crypto).
   */
  async sellShares(
    tokenId: string,
    shares: number,
    minPrice: number = 0.01,
    isNegRisk: boolean = false,
    retried: boolean = false,
  ): Promise<TradeResult> {
    this.ensureInitialized();

    // Ensure token is approved for selling
    await this.ensureConditionalTokenApproval(tokenId);

    // Sell all shares - don't reduce for "balance discrepancies" as this leaves dust
    const adjustedShares = shares;

    // CRITICAL: Ensure shares has max 2 decimals (CLOB rejects 4-decimal amounts)
    const roundedShares = Math.round(adjustedShares * 100) / 100;

    // Skip if shares too small after adjustment
    if (roundedShares < 0.5) {
      console.log(
        `⚠️ Skipping sell - adjusted shares (${roundedShares}) too small`,
      );
      return {
        success: false,
        error: `Adjusted shares too small: ${roundedShares}`,
      };
    }

    try {
      // Fee: Always 0 bps - Polymarket doesn't charge fees on sells
      const feeRateBps = 0;
      console.log(
        `📊 SELL ${roundedShares.toFixed(2)} shares (original: ${shares.toFixed(2)}) at min $${minPrice.toFixed(4)} [fee: ${feeRateBps}bps]`,
      );

      // Let the CLOB client auto-detect negRisk from the token ID
      // The client calls GET /neg-risk endpoint to determine if token is NegRisk
      const marketOrder = await this.clobClient!.createMarketOrder({
        tokenID: tokenId,
        side: Side.SELL,
        amount: roundedShares,
        price: minPrice,
        feeRateBps,
        nonce: 0,
      });

      const response = await this.clobClient!.postOrder(
        marketOrder,
        OrderType.FAK,
      );

      if (response.error || response.status === 400) {
        throw new Error(response.error || "Order failed with status 400");
      }

      if (!response.orderID) {
        throw new Error("No orderID returned - sell failed");
      }

      // Debug: log full response to trace FAK fill issues
      console.log(`📊 SELL response: orderID=${response.orderID}, status=${response.status}, takingAmount='${response.takingAmount}', makingAmount='${response.makingAmount}'`);

      // If status is "delayed", order is queued — sports markets have 3s delay on marketable orders.
      // Must wait longer than 3s then check if it filled.
      if (response.status === "delayed" && response.orderID) {
        console.log(`⏳ Order delayed (3s sports delay) — waiting 4s then checking status...`);
        // Wait 4s (3s delay + 1s buffer for settlement)
        await new Promise(r => setTimeout(r, 4000));
        try {
          const orderStatus = await this.clobClient!.getOrder(response.orderID);
          if (orderStatus) {
            console.log(`📊 Delayed order check: status=${orderStatus.status}, sizeFilled=${orderStatus.size_matched}, original=${orderStatus.original_size}`);
            if (orderStatus.size_matched && parseFloat(orderStatus.size_matched) > 0) {
              const filledShares = Math.round(parseFloat(orderStatus.size_matched) * 100) / 100;
              // For SELL: we receive USDC, price = amount received per share
              const filledPrice = orderStatus.associate_trades?.[0]?.price
                ? parseFloat(orderStatus.associate_trades[0].price)
                : minPrice;
              console.log(`📊 DELAYED FILL: ${filledShares} shares @ ${filledPrice.toFixed(4)}`);
              return {
                success: true,
                orderID: response.orderID,
                filledShares,
                filledPrice,
                details: { totalCost: filledShares * filledPrice, shares: filledShares, pricePerShare: filledPrice },
              };
            }
            // Still no fills after 4s — genuinely unfilled
            console.log(`⚠️ Delayed order still unfilled after 4s — treating as zero fills`);
          }
        } catch (err: any) {
          console.log(`⚠️ Delayed order check failed: ${err?.message}`);
        }
        // Fall through to zero-fill check below — don't return early with assumed fills
      }

      // Calculate actual fill price from response
      // For SELL orders: takingAmount = USD received, makingAmount = shares sold
      let filledPrice = minPrice;
      let filledShares = roundedShares; // Default to requested shares

      if (response.takingAmount && response.makingAmount && parseFloat(response.makingAmount) > 0) {
        const received = parseFloat(response.takingAmount);
        // V14: Round to 2 decimals for consistent precision
        filledShares =
          Math.round(parseFloat(response.makingAmount) * 100) / 100;
        filledPrice = filledShares > 0 ? received / filledShares : minPrice;
        console.log(
          `📊 SELL FILL: received=$${received.toFixed(4)}, shares=${filledShares}, price=${filledPrice.toFixed(4)}`,
        );
      } else {
        // FAK order with no fill data = order was accepted but NOTHING FILLED
        // This happens when minPrice is above market price — no counterparties
        console.warn(
          `⚠️ SELL response missing fill data (takingAmount=${response.takingAmount}, makingAmount=${response.makingAmount}) — likely ZERO fills (FAK killed)`,
        );
        filledShares = 0;
        filledPrice = 0;
      }

      // Zero fills = sell did not execute
      if (filledShares === 0) {
        return {
          success: false,
          error: "FAK order returned zero fills — minPrice likely above market",
          orderID: response.orderID,
          filledShares: 0,
          filledPrice: 0,
        };
      }

      return {
        success: true,
        orderID: response.orderID,
        filledShares,
        filledPrice,
        details: {
          totalCost: filledShares * filledPrice,
          shares: filledShares,
          pricePerShare: filledPrice,
        },
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown error";
      console.error("Sell failed:", errMsg);
      
      // Retry once on allowance-related errors
      if (!retried && (errMsg.includes('not enough balance') || errMsg.includes('allowance') || errMsg.includes('approval'))) {
        console.log(`🔄 [MARKET] Allowance error caught, clearing cache and retrying...`);
        this.approvedTokens.delete(tokenId);
        return this.sellShares(tokenId, shares, minPrice, isNegRisk, true);
      }
      
      return {
        success: false,
        error: errMsg,
      };
    }
  }

  /**
   * Execute a GTC SELL order for EXACT share count
   * Used for V62 flip sell where we want price protection
   * Order stays on the book until filled or cancelled
   * @param isNegRisk - If true, use 0% fee (sports markets). Default false (10% fee for crypto).
   */
  async sellSharesGTC(
    tokenId: string,
    shares: number,
    minPrice: number,
    isNegRisk: boolean = false,
    retried: boolean = false,
  ): Promise<TradeResult> {
    this.ensureInitialized();

    // Ensure token is approved for selling
    await this.ensureConditionalTokenApproval(tokenId);

    // V14: Round to 2 decimals for consistent precision
    const roundedShares = Math.round(shares * 100) / 100;
    const price = Math.max(minPrice, 0.01);

    try {
      // Fee: Always 0 bps - Polymarket doesn't charge fees on sells
      const feeRateBps = 0;

      // Let the CLOB client auto-detect negRisk from the token ID
      // Use createOrder (not createMarketOrder) for GTC
      const limitOrder = await this.clobClient!.createOrder({
        tokenID: tokenId,
        side: Side.SELL,
        size: roundedShares,
        price,
        feeRateBps,
        nonce: 0,
      });

      // Post with GTC (Good-Till-Cancelled) - rests on book
      const response = await this.clobClient!.postOrder(
        limitOrder,
        OrderType.GTC,
      );

      if (response.error || response.status === 400) {
        const errorMsg = response.error || "Order failed with status 400";
        
        // Detect allowance/balance issues and retry once with fresh approval
        if (!retried && (errorMsg.includes('not enough balance') || errorMsg.includes('allowance'))) {
          console.log(`🔄 Allowance issue detected, clearing cache and retrying...`);
          this.approvedTokens.delete(tokenId);
          return this.sellSharesGTC(tokenId, shares, minPrice, isNegRisk, true);
        }
        
        return {
          success: false,
          error: errorMsg,
        };
      }

      if (!response.orderID) {
        return {
          success: false,
          error: "No orderID returned",
        };
      }

      // For GTC sells: takingAmount = USD received, makingAmount = shares sold
      let filledShares = 0;
      let filledPrice = minPrice;

      if (response.takingAmount && response.makingAmount) {
        const received = parseFloat(response.takingAmount);
        filledShares =
          Math.round(parseFloat(response.makingAmount) * 100) / 100;
        filledPrice = filledShares > 0 ? received / filledShares : minPrice;
      }

      return {
        success: true,
        orderID: response.orderID,
        filledShares,
        filledPrice,
        details: {
          totalCost:
            filledShares > 0
              ? filledShares * filledPrice
              : roundedShares * price,
          shares: filledShares > 0 ? filledShares : roundedShares,
          pricePerShare: filledPrice,
          requestedShares: shares,
          orderedShares: roundedShares,
          resting: filledShares < roundedShares,
        },
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown error";
      console.error("GTC sell failed:", errMsg);
      
      // Retry once on allowance-related errors
      if (!retried && (errMsg.includes('not enough balance') || errMsg.includes('allowance') || errMsg.includes('approval'))) {
        console.log(`🔄 Allowance error caught, clearing cache and retrying...`);
        this.approvedTokens.delete(tokenId);
        return this.sellSharesGTC(tokenId, shares, minPrice, isNegRisk, true);
      }
      
      return {
        success: false,
        error: errMsg,
      };
    }
  }

  /**
   * Execute IOC (Immediate-Or-Cancel) SELL order for exact shares
   * Uses FAK (Fill-And-Kill) which ALLOWS partial fills
   * - Fills whatever is available immediately at or above minPrice
   * - Cancels unfilled portion
   * - Returns actual fill (may be 0, partial, or full)
   *
   * IMPORTANT: Caller must wait for WSS confirmation to get actual fill amount
   * The response here is just the order submission - actual fill comes from WSS
   * @param isNegRisk - If true, use 0% fee (sports markets). Default false (10% fee for crypto).
   */
  async sellSharesIOC(
    tokenId: string,
    shares: number,
    minPrice: number,
    isNegRisk: boolean = false,
    retried: boolean = false,
  ): Promise<TradeResult> {
    this.ensureInitialized();

    // Ensure token is approved for selling
    await this.ensureConditionalTokenApproval(tokenId);

    // V14: Round to 2 decimals for consistent precision
    const roundedShares = Math.round(shares * 100) / 100;
    const price = Math.max(minPrice, 0.01);

    // Skip if shares too small
    if (roundedShares < 0.5) {
      return {
        success: false,
        error: `Shares too small: ${roundedShares}`,
      };
    }

    try {
      // Fee: Always 0 bps - Polymarket doesn't charge fees on sells
      const feeRateBps = 0;

      // Let the CLOB client auto-detect negRisk from the token ID
      // Use createOrder (not createMarketOrder) for exact share control
      const limitOrder = await this.clobClient!.createOrder({
        tokenID: tokenId,
        side: Side.SELL,
        size: roundedShares,
        price,
        feeRateBps,
        nonce: 0,
      });

      // Post with FAK (Fill-And-Kill) - IOC behavior
      // Unlike FOK, FAK allows partial fills
      const response = await this.clobClient!.postOrder(
        limitOrder,
        OrderType.FAK,
      );

      if (response.error || response.status === 400) {
        const errorMsg = response.error || response.errorMsg || "IOC sell order failed";
        
        // Detect allowance/balance issues and retry once with fresh approval
        if (!retried && (errorMsg.includes('not enough balance') || errorMsg.includes('allowance'))) {
          console.log(`🔄 [IOC] Allowance issue detected, clearing cache and retrying...`);
          this.approvedTokens.delete(tokenId);
          return this.sellSharesIOC(tokenId, shares, minPrice, isNegRisk, true);
        }
        
        return {
          success: false,
          error: errorMsg,
        };
      }

      if (!response.orderID) {
        return {
          success: false,
          error: "No orderID returned",
        };
      }

      // For IOC sells: takingAmount = USD received, makingAmount = shares sold
      // We return the order ID but don't trust the fill info here - WSS is source of truth
      let filledShares = 0;
      let filledPrice = minPrice;

      if (response.takingAmount && response.makingAmount) {
        const received = parseFloat(response.takingAmount);
        filledShares =
          Math.round(parseFloat(response.makingAmount) * 100) / 100;
        filledPrice = filledShares > 0 ? received / filledShares : minPrice;
      }

      return {
        success: true,
        orderID: response.orderID,
        filledShares, // May be 0, partial, or full - WSS is source of truth
        filledPrice,
        details: {
          totalCost: filledShares * filledPrice,
          shares: filledShares,
          pricePerShare: filledPrice,
          requestedShares: shares,
          resting: false, // FAK never rests - fills or cancels immediately
        },
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown error";
      console.error("IOC sell failed:", errMsg);
      
      // Retry once on allowance-related errors
      if (!retried && (errMsg.includes('not enough balance') || errMsg.includes('allowance') || errMsg.includes('approval'))) {
        console.log(`🔄 [IOC] Allowance error caught, clearing cache and retrying...`);
        this.approvedTokens.delete(tokenId);
        return this.sellSharesIOC(tokenId, shares, minPrice, isNegRisk, true);
      }
      
      return {
        success: false,
        error: errMsg,
      };
    }
  }

  /**
   * Get market by slug from Gamma API
   * Rate limited: gamma category (300 req/10s limit)
   */
  async getMarketBySlug(slug: string): Promise<MarketInfo | null> {
    try {
      const response = await this.rateLimiter.execute("gamma", async () => {
        return fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
      });
      const markets = (await response.json()) as any[];

      if (markets && Array.isArray(markets) && markets.length > 0) {
        const m = markets[0];

        // Parse clobTokenIds, outcomes, and outcomePrices
        let clobTokenIds: string[] = [];
        let outcomes: string[] = [];
        let outcomePrices: string[] = [];

        try {
          clobTokenIds =
            typeof m.clobTokenIds === "string"
              ? JSON.parse(m.clobTokenIds)
              : m.clobTokenIds || [];
        } catch {
          clobTokenIds = [];
        }

        try {
          outcomes =
            typeof m.outcomes === "string"
              ? JSON.parse(m.outcomes)
              : m.outcomes || [];
        } catch {
          outcomes = [];
        }

        try {
          outcomePrices =
            typeof m.outcomePrices === "string"
              ? JSON.parse(m.outcomePrices)
              : m.outcomePrices || [];
        } catch {
          outcomePrices = [];
        }

        // Build tokens array
        const tokens = clobTokenIds.map((tokenId: string, idx: number) => ({
          token_id: tokenId,
          outcome: outcomes[idx] || `Outcome ${idx}`,
        }));

        // Calculate start time from slug (btc-updown-15m-{timestamp})
        const slugParts = slug.split("-");
        const timestamp = parseInt(slugParts[slugParts.length - 1]);
        const startTime = timestamp * 1000; // Convert to milliseconds

        return {
          slug: m.slug,
          question: m.question,
          conditionId: m.conditionId,
          endDate: m.endDate,
          startTime,
          tokens,
          clobTokenIds,
          outcomes,
          outcomePrices,
        };
      }

      return null;
    } catch (error) {
      console.error("Error fetching market:", error);
      return null;
    }
  }

  /**
   * Find next BTC 15-minute market
   */
  async findNext15MinMarket(): Promise<MarketInfo | null> {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / 900) * 900;

    // Try current window first
    let slug = `btc-updown-15m-${windowStart}`;
    let market = await this.getMarketBySlug(slug);

    if (market) {
      return market;
    }

    // V64.8 FIX: Only try next window if we're near end of current window (last 60s)
    // This prevents false "new market" detection when API returns errors
    const secondsIntoWindow = now - windowStart;
    if (secondsIntoWindow < 840) {
      // 840s = 14 mins, only try next window in last minute
      // API error for current window - return null to trigger retry
      // Don't try next window as it could cause false market switch
      return null;
    }

    // Try next window (only near end of current)
    const nextWindowStart = windowStart + 900;
    slug = `btc-updown-15m-${nextWindowStart}`;
    market = await this.getMarketBySlug(slug);

    return market;
  }

  /**
   * Get the upcoming market (the one AFTER current window)
   */
  async getUpcomingMarket(): Promise<MarketInfo | null> {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / 900) * 900;
    const nextWindowStart = windowStart + 900;

    const slug = `btc-updown-15m-${nextWindowStart}`;
    return await this.getMarketBySlug(slug);
  }

  /**
   * Get open orders for a market (or specific token)
   * Useful for debugging and order state tracking
   * Rate limited: clob-general category (9000 req/10s limit)
   *
   * WARNING: This was the main cause of rate limiting crash (US-410).
   * Avoid polling this frequently - use WebSocket for order status instead.
   */
  async getOpenOrders(
    conditionId: string,
    tokenId?: string,
  ): Promise<{ success: boolean; orders?: any[]; error?: string }> {
    this.ensureInitialized();

    try {
      const params: { market: string; asset_id?: string } = {
        market: conditionId,
      };

      if (tokenId) {
        params.asset_id = tokenId;
      }

      const orders = await this.rateLimiter.execute(
        "clob-general",
        async () => {
          return this.clobClient!.getOpenOrders(params);
        },
      );

      return {
        success: true,
        orders: Array.isArray(orders) ? orders : [],
      };
    } catch (error) {
      console.error(
        "Get open orders failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Cancel all orders for a market (or specific token)
   * CRITICAL: Used when averaging down to reset counterpart limit orders
   * Rate limited: clob-general category (9000 req/10s limit)
   */
  async cancelOrders(
    conditionId: string,
    tokenId?: string,
  ): Promise<{ success: boolean; cancelled?: string[]; error?: string }> {
    this.ensureInitialized();

    try {
      const params: { market: string; asset_id?: string } = {
        market: conditionId,
      };

      if (tokenId) {
        params.asset_id = tokenId;
      }

      const response = await this.rateLimiter.execute(
        "clob-general",
        async () => {
          return this.clobClient!.cancelMarketOrders(params);
        },
      );

      // Response contains array of cancelled order IDs
      const cancelled = response?.canceled || response?.cancelled || [];

      return {
        success: true,
        cancelled: Array.isArray(cancelled) ? cancelled : [],
      };
    } catch (error) {
      console.error(
        "Cancel orders failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get order by ID directly from CLOB (for fill checking on GTC exits)
   */
  async getOrderById(orderId: string): Promise<any> {
    this.ensureInitialized();
    return await this.clobClient!.getOrder(orderId);
  }

  /**
   * Cancel a single order by its order ID
   * Rate limited: clob-general category (9000 req/10s limit)
   */
  async cancelSingleOrder(
    orderId: string,
  ): Promise<{ success: boolean; error?: string }> {
    this.ensureInitialized();

    try {
      // Use cancelOrders with array of one order hash
      await this.rateLimiter.execute("clob-general", async () => {
        return this.clobClient!.cancelOrders([orderId]);
      });

      return { success: true };
    } catch (error) {
      console.error(
        "Cancel single order failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Cancel multiple orders by their order IDs
   * Rate limited: clob-general category (9000 req/10s limit)
   */
  async cancelOrdersByIds(
    orderIds: string[],
  ): Promise<{ success: boolean; error?: string }> {
    if (orderIds.length === 0) return { success: true };
    this.ensureInitialized();

    try {
      await this.rateLimiter.execute("clob-general", async () => {
        return this.clobClient!.cancelOrders(orderIds);
      });
      return { success: true };
    } catch (error) {
      console.error(
        "Cancel orders by IDs failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Check order status with partial fill information
   * Returns detailed info about order state including any fills
   */
  async getOrderStatus(
    orderId: string,
    conditionId: string,
  ): Promise<"LIVE" | "NOT_FOUND"> {
    const details = await this.getOrderDetails(orderId, conditionId);
    return details.status;
  }

  /**
   * Get detailed order status including partial fill information
   */
  async getOrderDetails(
    orderId: string,
    conditionId: string,
  ): Promise<{
    status: "LIVE" | "NOT_FOUND";
    originalSize?: number;
    sizeMatched?: number;
    remainingSize?: number;
    price?: number;
  }> {
    this.ensureInitialized();

    try {
      const result = await this.getOpenOrders(conditionId);

      if (!result.success || !result.orders) {
        console.log(`   ⚠️ Failed to fetch open orders: ${result.error}`);
        return { status: "NOT_FOUND" };
      }

      const found = result.orders.find((o: any) => o.id === orderId);

      if (!found) {
        return { status: "NOT_FOUND" };
      }

      // Parse order details - CLOB returns these fields
      const originalSize = parseFloat(found.original_size || found.size || "0");
      const sizeMatched = parseFloat(found.size_matched || "0");
      const remainingSize = originalSize - sizeMatched;
      const price = parseFloat(found.price || "0");

      return {
        status: "LIVE",
        originalSize,
        sizeMatched,
        remainingSize,
        price,
      };
    } catch (error) {
      console.error("Error checking order details:", error);
      return { status: "NOT_FOUND" };
    }
  }

  /**
   * Get USDC.e balance from blockchain
   * Uses cached balance from WebSocket monitor if available (prevents race conditions)
   */
  async getBalance(): Promise<number> {
    // Use cached balance from WebSocket monitor if available
    if (this.balanceMonitor) {
      return this.balanceMonitor.getBalance();
    }

    // Fallback to direct RPC call
    try {
      const usdcAddress = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
      const usdcAbi = [
        "function balanceOf(address owner) view returns (uint256)",
        "function decimals() view returns (uint8)",
      ];

      const usdcContract = new ethers.Contract(
        usdcAddress,
        usdcAbi,
        this.polygonProvider,
      );

      // In EOA mode, check EOA wallet balance; in proxy mode, check funder address
      const isEOA = process.env.AUTH_MODE === "EOA";
      const walletToCheck = isEOA
        ? this.signer.address
        : this.config.funderAddress;

      const balance = await usdcContract.balanceOf(walletToCheck);
      const decimals = await usdcContract.decimals();

      return parseFloat(ethers.utils.formatUnits(balance, decimals));
    } catch (error) {
      console.error("Error fetching balance:", error);
      return 0;
    }
  }

  getWalletAddress(): string {
    return this.signer.address;
  }

  getFunderAddress(): string {
    return this.config.funderAddress;
  }

  /**
   * Get the address to use for API queries (positions, value, etc.)
   * In EOA mode: use signer address (the EOA wallet)
   * In PROXY mode: use funder address (the proxy contract)
   */
  getApiQueryAddress(): string {
    const isEOA = process.env.AUTH_MODE === "EOA";
    return isEOA ? this.signer.address : this.config.funderAddress;
  }

  /**
   * Set the balance monitor for cached balance access
   */
  setBalanceMonitor(monitor: BalanceMonitorWS): void {
    this.balanceMonitor = monitor;
  }

  /**
   * Get real-time price from CLOB API
   * Returns null if market closed or error
   * Rate limited: clob-market-data category (1500 req/10s limit)
   */
  async getClobPrice(tokenId: string): Promise<number | null> {
    try {
      const response = await this.rateLimiter.execute(
        "clob-market-data",
        async () => {
          return axios.get("https://clob.polymarket.com/price", {
            params: { token_id: tokenId, side: "BUY" },
          });
        },
      );
      return parseFloat(response.data.price);
    } catch (error: any) {
      // Market likely closed - CLOB API unavailable
      return null;
    }
  }

  /**
   * Get CLOB token ID for a position's outcome
   */
  async getTokenIdForPosition(
    slug: string,
    outcomeIndex: number,
  ): Promise<string | null> {
    const market = await this.getMarketBySlug(slug);
    if (
      !market ||
      !market.clobTokenIds ||
      market.clobTokenIds.length <= outcomeIndex
    ) {
      return null;
    }
    return market.clobTokenIds[outcomeIndex];
  }

  /**
   * Get real-time price for a position
   * Tries CLOB API first, falls back to Positions API curPrice
   */
  async getPositionRealTimePrice(pos: any): Promise<number> {
    // 1. Try CLOB API for real-time price
    const tokenId = await this.getTokenIdForPosition(
      pos.slug,
      pos.outcomeIndex,
    );
    if (tokenId) {
      const clobPrice = await this.getClobPrice(tokenId);
      if (clobPrice !== null) {
        return clobPrice;
      }
    }

    // 2. Fallback to Positions API curPrice (may lag, but works for closed markets)
    return pos.curPrice || 0;
  }

  /**
   * Get active positions CURRENT value (for PNL calculation)
   * Uses real-time CLOB prices: currentValue = realPrice * size
   * Falls back to Positions API curPrice if CLOB unavailable
   * Filters out positions where realizedPnl > 0 (already redeemed = money in balance)
   * Rate limited: data-api category (150 req/10s limit)
   */
  async getActivePositionsCurrentValue(): Promise<number> {
    try {
      const positions = await this.getActivePositionsRaw();
      let totalValue = 0;

      for (const pos of positions) {
        // Skip if redeemable (market ended) or realizedPnl > 0 (already redeemed)
        if (pos.redeemable) continue;
        if ((pos.realizedPnl || 0) > 0) continue;

        // Get real-time price from CLOB API (with fallback to Positions API)
        const realPrice = await this.getPositionRealTimePrice(pos);
        const size = pos.size || 0; // Number of shares

        // currentValue = price * shares
        totalValue += realPrice * size;
      }

      return totalValue;
    } catch (error: any) {
      console.error(
        `Error fetching active positions current value:`,
        error.message,
      );
      return 0;
    }
  }

  /**
   * Get total portfolio value from Value API
   * This returns the CURRENT value of all positions (reflects unrealized gains/losses)
   * Rate limited: data-api category (150 req/10s limit)
   */
  async getPortfolioValue(): Promise<number> {
    try {
      const response = await this.rateLimiter.execute("data-api", async () => {
        return axios.get("https://data-api.polymarket.com/value", {
          params: { user: this.getApiQueryAddress() },
        });
      });

      // Value API returns single-element array with total portfolio value
      const totalValue = response.data[0]?.value || 0;
      return totalValue;
    } catch (error: any) {
      console.error(`Error fetching portfolio value:`, error.message);
      return 0; // Graceful degradation
    }
  }

  /**
   * Get current value for PNL calculation
   * currentValue = USDC.e balance + active positions currentValue (filtered)
   * NOTE: Do NOT use Value API - it includes redeemed positions causing double count
   */
  async getCurrentValueForPnl(): Promise<number> {
    const balance = await this.getBalance();
    const portfolioValue = await this.getActivePositionsCurrentValue(); // NOT Value API!
    return balance + portfolioValue;
  }

  /**
   * Get active positions INITIAL value (for Baseline calculation)
   * Uses initialValue to prevent baseline from using unrealized PNL ATH
   * Filters out positions where realizedPnl > 0 (already redeemed = money in balance)
   * Rate limited: data-api category (150 req/10s limit)
   */
  async getActivePositionsInitialValue(): Promise<number> {
    try {
      const response = await this.rateLimiter.execute("data-api", async () => {
        return axios.get("https://data-api.polymarket.com/positions", {
          params: {
            user: this.getApiQueryAddress(),
            sizeThreshold: 0.01,
          },
        });
      });

      const positions = response.data || [];
      let totalValue = 0;

      for (const pos of positions) {
        // Skip if redeemable (market ended) or realizedPnl > 0 (already redeemed)
        if (pos.redeemable) continue;
        if ((pos.realizedPnl || 0) > 0) continue;
        totalValue += pos.initialValue || 0;
      }

      return totalValue;
    } catch (error: any) {
      console.error(
        `Error fetching active positions initial value:`,
        error.message,
      );
      return 0;
    }
  }

  /**
   * R1: Get redeemable value (money waiting to be claimed)
   * From two sources:
   * 1. Active positions where redeemable = true: use totalBought * curPrice
   * 2. Closed positions where realizedPnl = 0: use totalBought * curPrice
   * Rate limited: data-api category (150 req/10s limit)
   */
  async getRedeemableValue(): Promise<number> {
    try {
      let totalValue = 0;

      // 1. From active positions where redeemable = true
      const activeResponse = await this.rateLimiter.execute(
        "data-api",
        async () => {
          return axios.get("https://data-api.polymarket.com/positions", {
            params: {
              user: this.getApiQueryAddress(),
              sizeThreshold: 0.01,
            },
          });
        },
      );
      const activePositions = activeResponse.data || [];

      for (const pos of activePositions) {
        if (pos.redeemable) {
          // Settlement value = totalBought * curPrice (curPrice=1 for win, 0 for loss)
          totalValue += (pos.totalBought || 0) * (pos.curPrice || 0);
        }
      }

      // 2. From closed positions (always redeemable) where not yet redeemed
      const closedResponse = await this.rateLimiter.execute(
        "data-api",
        async () => {
          return axios.get("https://data-api.polymarket.com/closed-positions", {
            params: {
              user: this.getApiQueryAddress(),
              limit: 500,
            },
          });
        },
      );
      const closedPositions = closedResponse.data || [];

      for (const pos of closedPositions) {
        if ((pos.realizedPnl || 0) === 0) {
          // Not yet redeemed - add settlement value
          totalValue += (pos.totalBought || 0) * (pos.curPrice || 0);
        }
        // If realizedPnl > 0, already redeemed - skip
      }

      return totalValue;
    } catch (error: any) {
      console.error(`Error fetching redeemable value:`, error.message);
      return 0;
    }
  }

  /**
   * Get total AUM for PNL calculation
   * Uses CURRENT value of active positions (reflects unrealized gains/losses)
   * AUM = Balance + Redeemable + Active Positions (currentValue)
   */
  async getAUM(): Promise<number> {
    const balance = await this.getBalance();
    const redeemableValue = await this.getRedeemableValue();
    const activeValue = await this.getActivePositionsCurrentValue(); // CURRENT value
    return balance + redeemableValue + activeValue;
  }

  /**
   * Get AUM for Baseline calculation
   * Uses INITIAL value of active positions (prevents baseline from using unrealized PNL)
   * AUM = Balance + Active Positions (initialValue where realizedPnl = 0)
   * NOTE: Do NOT add redeemableValue separately - positions already filtered
   */
  async getAUMForBaseline(): Promise<number> {
    const balance = await this.getBalance();
    const activeValue = await this.getActivePositionsInitialValue();
    return balance + activeValue;
  }

  /**
   * Get raw positions data from API
   * Used for stale position detection
   * Rate limited: data-api category (150 req/10s limit)
   */
  async getActivePositionsRaw(): Promise<any[]> {
    try {
      const response = await this.rateLimiter.execute("data-api", async () => {
        return axios.get("https://data-api.polymarket.com/positions", {
          params: {
            user: this.getApiQueryAddress(),
            sizeThreshold: 0.01,
          },
        });
      });
      return response.data || [];
    } catch (error: any) {
      console.error(`Error fetching raw positions:`, error.message);
      return [];
    }
  }

  /**
   * Get AUM for Baseline calculation, excluding stale positions
   * Stale positions are those where the API hasn't caught up after a manual sell
   */
  async getAUMForBaselineExcluding(staleIds: Set<string>): Promise<number> {
    const balance = await this.getBalance();
    const positions = await this.getActivePositionsRaw();

    let activeValue = 0;
    for (const pos of positions) {
      if (pos.redeemable) continue;
      if ((pos.realizedPnl || 0) > 0) continue;
      if (staleIds.has(pos.conditionId)) continue; // Skip stale positions
      activeValue += pos.initialValue || 0;
    }

    return balance + activeValue;
  }

  /**
   * Get detailed AUM breakdown for display
   */
  async getAUMBreakdown(): Promise<{
    balance: number;
    redeemableValue: number;
    activePositionsValue: number;
    total: number;
  }> {
    const balance = await this.getBalance();
    const redeemableValue = await this.getRedeemableValue();
    const activePositionsValue = await this.getActivePositionsCurrentValue(); // Show current value

    return {
      balance,
      redeemableValue,
      activePositionsValue,
      total: balance + redeemableValue + activePositionsValue,
    };
  }

  /**
   * Get active positions from API (source of truth)
   * Returns condition IDs of all active positions
   * Excludes redeemable positions (markets that have ended) and already redeemed (realizedPnl > 0)
   */
  async getActivePositions(): Promise<string[]> {
    try {
      const response = await axios.get(
        "https://data-api.polymarket.com/positions",
        {
          params: {
            user: this.getApiQueryAddress(),
            sizeThreshold: 0.01,
          },
        },
      );
      const positions = response.data || [];
      // Filter: only count active (non-redeemable) positions
      const activePositions = positions.filter((p: any) => !p.redeemable);
      return activePositions.map((p: any) => p.conditionId);
    } catch (error: any) {
      console.error(`Error fetching active positions:`, error.message);
      return [];
    }
  }

  /**
   * Get count of active positions from API
   */
  async getActivePositionCount(): Promise<number> {
    const positions = await this.getActivePositions();
    return positions.length;
  }

  /**
   * Get the rate limiter instance for stats/monitoring
   */
  getRateLimiter(): RateLimiter {
    return this.rateLimiter;
  }

  /**
   * Get rate limiter stats for monitoring
   */
  getRateLimiterStats(): Record<
    EndpointCategory,
    {
      requests: number;
      rateLimited: number;
      retries: number;
      queueLength: number;
    }
  > {
    return this.rateLimiter.getStats();
  }

  /**
   * Check if approaching rate limit (>80% of limit)
   */
  isApproachingRateLimit(category: EndpointCategory): boolean {
    return this.rateLimiter.isApproachingLimit(category);
  }

  /**
   * Enable or disable rate limiting (for testing)
   */
  setRateLimitingEnabled(enabled: boolean): void {
    this.rateLimiter.setEnabled(enabled);
  }
}
