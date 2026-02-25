/**
 * PnlTracker Service
 * Handles PNL calculation using Polymarket Data APIs
 */

import { PositionApiResponse, ClosedPositionApiResponse } from '../types';

export class PnlTracker {
  private walletAddress: string;

  constructor(walletAddress: string) {
    this.walletAddress = walletAddress.toLowerCase();
  }

  /**
   * Get current active position for a specific market
   */
  async getActivePosition(conditionId: string): Promise<PositionApiResponse | null> {
    try {
      const url = `https://data-api.polymarket.com/positions?sizeThreshold=0.01&limit=100&user=${this.walletAddress}&market=${conditionId}`;

      const response = await fetch(url);
      if (!response.ok) {
        console.error(`Positions API returned ${response.status}`);
        return null;
      }

      const positions = await response.json() as PositionApiResponse[];

      if (positions && positions.length > 0) {
        return positions[0];
      }

      return null;
    } catch (error) {
      console.error('Error fetching active position:', error);
      return null;
    }
  }

  /**
   * Get closed position for a specific market (after settlement)
   */
  async getClosedPosition(conditionId: string): Promise<ClosedPositionApiResponse | null> {
    try {
      const url = `https://data-api.polymarket.com/closed-positions?limit=100&user=${this.walletAddress}&market=${conditionId}`;

      const response = await fetch(url);
      if (!response.ok) {
        console.error(`Closed Positions API returned ${response.status}`);
        return null;
      }

      const positions = await response.json() as ClosedPositionApiResponse[];

      if (positions && positions.length > 0) {
        return positions[0];
      }

      return null;
    } catch (error) {
      console.error('Error fetching closed position:', error);
      return null;
    }
  }

  /**
   * Calculate current PNL for an active position
   * Returns: { currentValue, initialValue, cashPnl, percentPnl }
   */
  async calculateCurrentPnl(conditionId: string, tokenId: string): Promise<{
    found: boolean;
    currentValue: number;
    initialValue: number;
    cashPnl: number;
    percentPnl: number;
    curPrice: number;
  }> {
    const position = await this.getActivePosition(conditionId);

    if (!position) {
      return {
        found: false,
        currentValue: 0,
        initialValue: 0,
        cashPnl: 0,
        percentPnl: 0,
        curPrice: 0
      };
    }

    // Verify we have the right token
    if (position.asset !== tokenId && !position.asset.startsWith(tokenId.substring(0, 20))) {
      console.log(`Token mismatch: expected ${tokenId.substring(0, 20)}..., got ${position.asset.substring(0, 20)}...`);
    }

    return {
      found: true,
      currentValue: position.currentValue,
      initialValue: position.initialValue,
      cashPnl: position.cashPnl,
      percentPnl: position.percentPnl,
      curPrice: position.curPrice
    };
  }

  /**
   * Get realized PNL after market settlement
   */
  async getRealizedPnl(conditionId: string): Promise<{
    found: boolean;
    realizedPnl: number;
    curPrice: number;
  }> {
    const position = await this.getClosedPosition(conditionId);

    if (!position) {
      return {
        found: false,
        realizedPnl: 0,
        curPrice: 0
      };
    }

    return {
      found: true,
      realizedPnl: position.realizedPnl,
      curPrice: position.curPrice // 1 for win, 0 for loss
    };
  }

  /**
   * Calculate expected PNL based on entry price and current price
   * This is a fallback if the API doesn't return data fast enough
   */
  calculateExpectedPnl(
    entryPrice: number,
    currentPrice: number,
    shares: number
  ): {
    expectedPnl: number;
    percentChange: number;
  } {
    const initialValue = entryPrice * shares;
    const currentValue = currentPrice * shares;
    const expectedPnl = currentValue - initialValue;
    const percentChange = ((currentValue - initialValue) / initialValue) * 100;

    return {
      expectedPnl,
      percentChange
    };
  }

  /**
   * Calculate settlement PNL (win or loss)
   * If UP wins: price goes to 1.0
   * If DOWN wins: price goes to 0.0
   */
  calculateSettlementPnl(
    entryPrice: number,
    shares: number,
    won: boolean
  ): number {
    const initialValue = entryPrice * shares;
    const finalValue = won ? shares * 1.0 : 0;
    return finalValue - initialValue;
  }
}
