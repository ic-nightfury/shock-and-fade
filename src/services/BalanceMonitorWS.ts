/**
 * Real-time USDC.e balance monitor via WebSocket
 * Listens to Transfer events on Polygon for instant balance updates
 *
 * Two balance increase sources:
 * 1. Expected (redeem engine) - handled via expectedIncrease tracking
 * 2. Unexpected (manual sell) - triggers stale position flagging
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';

const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_DECIMALS = 6;

// ERC20 Transfer event signature
const TRANSFER_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');

export interface BalanceChangeEvent {
  previousBalance: number;
  newBalance: number;
  change: number;
  direction: 'incoming' | 'outgoing';
}

export interface BalanceIncreaseEvent {
  previousBalance: number;
  newBalance: number;
  increase: number;
}

export class BalanceMonitorWS extends EventEmitter {
  private wsProvider: ethers.providers.WebSocketProvider | null = null;
  private httpProvider: ethers.providers.JsonRpcProvider;
  private walletAddress: string;
  private cachedBalance: number = 0;
  private connected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollingInterval: NodeJS.Timeout | null = null;

  constructor(walletAddress: string, rpcUrl: string) {
    super();
    this.walletAddress = walletAddress.toLowerCase();
    this.httpProvider = new ethers.providers.JsonRpcProvider(rpcUrl);
  }

  async start(): Promise<void> {
    // Initial balance fetch via HTTP
    await this.refreshBalance();
    console.log(`   💰 Initial balance: $${this.cachedBalance.toFixed(2)}`);

    // Connect WebSocket for real-time updates
    await this.connectWS();
  }

  private async connectWS(): Promise<void> {
    const wsUrl = this.getWSUrl();
    if (!wsUrl) {
      console.log('⚠️ No WebSocket RPC URL available, using polling fallback');
      this.startPolling();
      return;
    }

    try {
      // Create provider - this may throw synchronously or fail later
      this.wsProvider = new ethers.providers.WebSocketProvider(wsUrl);

      // Handle provider-level errors early
      this.wsProvider.on('error', (error: Error) => {
        console.error('Balance WSS provider error:', error.message);
        if (!this.connected) {
          // Connection failed during setup - fall back to polling
          this.cleanupWS();
          if (!this.pollingInterval) {
            this.startPolling();
          }
        }
      });

      // Wait for the provider to be ready with timeout
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('WSS connection timeout')), 10000)
      );

      await Promise.race([this.wsProvider.ready, timeout]);

      // Listen for Transfer events TO our wallet (incoming)
      const filterTo = {
        address: USDC_ADDRESS,
        topics: [
          TRANSFER_TOPIC,
          null, // from (any)
          ethers.utils.hexZeroPad(this.walletAddress, 32) // to (our wallet)
        ]
      };

      // Listen for Transfer events FROM our wallet (outgoing)
      const filterFrom = {
        address: USDC_ADDRESS,
        topics: [
          TRANSFER_TOPIC,
          ethers.utils.hexZeroPad(this.walletAddress, 32), // from (our wallet)
          null // to (any)
        ]
      };

      this.wsProvider.on(filterTo, (log) => this.handleTransfer(log, 'incoming'));
      this.wsProvider.on(filterFrom, (log) => this.handleTransfer(log, 'outgoing'));

      // Handle disconnections (only access _websocket after ready)
      if (this.wsProvider._websocket) {
        this.wsProvider._websocket.on('close', () => {
          this.connected = false;
          console.log('📡 Balance WSS disconnected, reconnecting...');
          this.scheduleReconnect();
        });

        this.wsProvider._websocket.on('error', (err: Error) => {
          console.error('Balance WSS socket error:', err.message);
        });
      }

      this.connected = true;
      console.log('📡 Balance monitor WSS connected');
    } catch (error: any) {
      console.error('Failed to connect balance WSS:', error.message || error);
      this.cleanupWS();
      if (!this.pollingInterval) {
        this.startPolling();
      }
    }
  }

  private cleanupWS(): void {
    if (this.wsProvider) {
      try {
        this.wsProvider.removeAllListeners();
        if (this.wsProvider._websocket) {
          this.wsProvider._websocket.removeAllListeners();
          this.wsProvider._websocket.close();
        }
      } catch (e) {
        // Ignore cleanup errors
      }
      this.wsProvider = null;
    }
  }

  private getWSUrl(): string | null {
    // Use dedicated WSS_RPC_URL if provided
    const wssUrl = process.env.WSS_RPC_URL;
    if (wssUrl) {
      return wssUrl;
    }

    // No WSS URL configured - will fall back to polling
    return null;
  }

  private async handleTransfer(log: ethers.providers.Log, direction: 'incoming' | 'outgoing'): Promise<void> {
    const previousBalance = this.cachedBalance;
    await this.refreshBalance();

    const change = this.cachedBalance - previousBalance;

    console.log(`💰 USDC ${direction}: $${Math.abs(change).toFixed(2)} | Balance: $${this.cachedBalance.toFixed(2)}`);

    this.emit('balanceChange', {
      previousBalance,
      newBalance: this.cachedBalance,
      change,
      direction
    } as BalanceChangeEvent);

    // Emit specific event for balance increases (for stale detection)
    if (change > 0) {
      this.emit('balanceIncrease', {
        previousBalance,
        newBalance: this.cachedBalance,
        increase: change
      } as BalanceIncreaseEvent);
    }
  }

  private async refreshBalance(): Promise<void> {
    try {
      const usdcContract = new ethers.Contract(
        USDC_ADDRESS,
        ['function balanceOf(address) view returns (uint256)'],
        this.httpProvider
      );

      const balance = await usdcContract.balanceOf(this.walletAddress);
      this.cachedBalance = parseFloat(ethers.utils.formatUnits(balance, USDC_DECIMALS));
    } catch (error) {
      console.error('Error refreshing balance:', error);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connectWS();
    }, 5000);
  }

  private startPolling(): void {
    console.log('📡 Balance monitor using polling fallback (5s interval)');

    // Fallback: poll every 5 seconds
    this.pollingInterval = setInterval(async () => {
      const previousBalance = this.cachedBalance;
      await this.refreshBalance();

      const change = this.cachedBalance - previousBalance;
      if (Math.abs(change) > 0.01) {
        this.emit('balanceChange', {
          previousBalance,
          newBalance: this.cachedBalance,
          change,
          direction: change > 0 ? 'incoming' : 'outgoing'
        } as BalanceChangeEvent);

        if (change > 0) {
          this.emit('balanceIncrease', {
            previousBalance,
            newBalance: this.cachedBalance,
            increase: change
          } as BalanceIncreaseEvent);
        }
      }
    }, 5000);
  }

  getBalance(): number {
    return this.cachedBalance;
  }

  isConnected(): boolean {
    return this.connected;
  }

  stop(): void {
    this.cleanupWS();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.connected = false;
  }
}
