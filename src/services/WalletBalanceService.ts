/**
 * WalletBalanceService — On-chain wallet balance tracking for dashboard.
 *
 * Fetches:
 *  - USDC.e balance via ERC-20 balanceOf
 *  - MATIC balance via provider.getBalance
 *  - CTF positions via Polymarket data API
 *
 * Groups positions by market (conditionId), calculates mergeable pairs,
 * total position value, and total account value.
 *
 * Refreshes periodically (30s) and on-demand via refresh().
 */

import { ethers } from "ethers";

// ============================================================================
// TYPES
// ============================================================================

export interface PositionSide {
  asset: string;
  outcome: string;
  outcomeIndex: number;
  size: number;
  curPrice: number;
  value: number; // size × curPrice
}

export interface MarketPosition {
  conditionId: string;
  title: string;
  slug: string;
  sides: PositionSide[];
  mergeablePairs: number; // min(sideA.size, sideB.size)
  mergeValue: number; // mergeablePairs × $1
  totalValue: number; // sum of all sides' value
  mergeable: boolean;
  redeemable: boolean;
}

export interface WalletBalanceData {
  address: string;
  usdcBalance: number;   // free USDC.e in dollars
  maticBalance: number;   // MATIC for gas
  positions: MarketPosition[];
  totalPositionValue: number;
  totalMergeableValue: number;
  totalAccountValue: number;
  lastRefreshed: number;
  error: string | null;
}

export type WalletUpdateCallback = (data: WalletBalanceData) => void;

// ============================================================================
// CONSTANTS
// ============================================================================

const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e on Polygon
const USDC_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
const POSITIONS_API = "https://data-api.polymarket.com/positions";
const REFRESH_INTERVAL_MS = 30_000;

// ============================================================================
// SERVICE
// ============================================================================

export class WalletBalanceService {
  private provider: ethers.providers.JsonRpcProvider;
  private walletAddress: string;
  private usdcContract: ethers.Contract;
  private refreshTimer: NodeJS.Timeout | null = null;
  private running = false;

  private lastData: WalletBalanceData;
  private onUpdate: WalletUpdateCallback | null = null;

  constructor(rpcUrl: string, walletAddress: string) {
    this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    this.walletAddress = walletAddress;
    this.usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, this.provider);

    this.lastData = {
      address: walletAddress,
      usdcBalance: 0,
      maticBalance: 0,
      positions: [],
      totalPositionValue: 0,
      totalMergeableValue: 0,
      totalAccountValue: 0,
      lastRefreshed: 0,
      error: null,
    };
  }

  /** Set callback for balance updates */
  setOnUpdate(cb: WalletUpdateCallback): void {
    this.onUpdate = cb;
  }

  /** Start periodic refresh */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.log("Starting wallet balance service");
    this.log(`  Address: ${this.walletAddress}`);

    // Initial refresh
    this.refresh().catch((err) => this.log(`Initial refresh error: ${err}`));

    // Periodic refresh every 30s
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => this.log(`Periodic refresh error: ${err}`));
    }, REFRESH_INTERVAL_MS);
  }

  /** Stop periodic refresh */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.log("Stopped wallet balance service");
  }

  /** On-demand refresh — call after transactions */
  async refresh(): Promise<WalletBalanceData> {
    try {
      const [usdcBalance, maticBalance, positions] = await Promise.all([
        this.fetchUsdcBalance(),
        this.fetchMaticBalance(),
        this.fetchPositions(),
      ]);

      const totalPositionValue = positions.reduce((s, p) => s + p.totalValue, 0);
      const totalMergeableValue = positions.reduce((s, p) => s + p.mergeValue, 0);

      this.lastData = {
        address: this.walletAddress,
        usdcBalance,
        maticBalance,
        positions,
        totalPositionValue,
        totalMergeableValue,
        totalAccountValue: usdcBalance + totalPositionValue,
        lastRefreshed: Date.now(),
        error: null,
      };
    } catch (err: any) {
      this.log(`Refresh error: ${err?.message || err}`);
      // Keep last known values but mark error
      this.lastData = {
        ...this.lastData,
        error: err?.message || String(err),
        lastRefreshed: Date.now(),
      };
    }

    // Notify callback
    if (this.onUpdate) {
      try {
        this.onUpdate(this.lastData);
      } catch (cbErr) {
        this.log(`Callback error: ${cbErr}`);
      }
    }

    return this.lastData;
  }

  /** Get last known balance data */
  getData(): WalletBalanceData {
    return this.lastData;
  }

  // ============================================================================
  // DATA FETCHERS
  // ============================================================================

  private async fetchUsdcBalance(): Promise<number> {
    try {
      const balance = await this.usdcContract.balanceOf(this.walletAddress);
      // USDC.e has 6 decimals
      return parseFloat(ethers.utils.formatUnits(balance, 6));
    } catch (err: any) {
      this.log(`USDC balance fetch error: ${err?.message || err}`);
      return this.lastData.usdcBalance; // keep last known
    }
  }

  private async fetchMaticBalance(): Promise<number> {
    try {
      const balance = await this.provider.getBalance(this.walletAddress);
      return parseFloat(ethers.utils.formatEther(balance));
    } catch (err: any) {
      this.log(`MATIC balance fetch error: ${err?.message || err}`);
      return this.lastData.maticBalance; // keep last known
    }
  }

  private async fetchPositions(): Promise<MarketPosition[]> {
    try {
      const url = `${POSITIONS_API}?user=${this.walletAddress}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`Positions API HTTP ${resp.status}`);
      }
      const raw: any[] = await resp.json();

      // Group by conditionId
      const byCondition = new Map<string, any[]>();
      for (const pos of raw) {
        if (!pos.conditionId) continue;
        // Skip zero-size positions
        if (!pos.size || pos.size <= 0) continue;
        const key = pos.conditionId;
        if (!byCondition.has(key)) byCondition.set(key, []);
        byCondition.get(key)!.push(pos);
      }

      const markets: MarketPosition[] = [];

      for (const [conditionId, sides] of byCondition.entries()) {
        const title = sides[0]?.title || "Unknown Market";
        const slug = sides[0]?.slug || conditionId;
        const mergeable = sides.some((s: any) => s.mergeable);
        const redeemable = sides.some((s: any) => s.redeemable);

        const positionSides: PositionSide[] = sides.map((s: any) => ({
          asset: s.asset || "",
          outcome: s.outcome || `Outcome ${s.outcomeIndex || 0}`,
          outcomeIndex: s.outcomeIndex ?? 0,
          size: s.size || 0,
          curPrice: s.curPrice || 0,
          value: (s.size || 0) * (s.curPrice || 0),
        }));

        // Mergeable pairs = min of all sides' sizes (usually 2 sides per market)
        const sizes = positionSides.map((s) => s.size);
        const mergeablePairs = sizes.length >= 2 ? Math.min(...sizes) : 0;
        const mergeValue = mergeablePairs * 1.0; // each pair merges to $1
        const totalValue = positionSides.reduce((s, p) => s + p.value, 0);

        markets.push({
          conditionId,
          title,
          slug,
          sides: positionSides,
          mergeablePairs,
          mergeValue,
          totalValue,
          mergeable,
          redeemable,
        });
      }

      return markets;
    } catch (err: any) {
      this.log(`Positions fetch error: ${err?.message || err}`);
      return this.lastData.positions; // keep last known
    }
  }

  // ============================================================================
  // LOGGING
  // ============================================================================

  private log(msg: string): void {
    const ts = new Date().toISOString();
    console.log(`${ts} [INFO] 💰 [WalletBalance] ${msg}`);
  }
}
