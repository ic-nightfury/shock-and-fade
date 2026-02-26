/**
 * SpreadScannerDashboard.ts — Real-time dashboard for Polymarket vs Pinnacle spreads
 *
 * Displays:
 * - Current spread opportunities (Polymarket vs Pinnacle)
 * - Live orderbook depth charts
 * - Pinnacle fair value vs Polymarket mid
 * - Historical spread evolution (how spreads change over time)
 * - Upcoming games with time to start
 *
 * WebSocket API:
 * - spreadUpdate: New spread detected or existing spread updated
 * - gameStart: Game starting soon (< 1 hour)
 * - opportunityAlert: Spread exceeds threshold
 */

import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import { PinnacleOddsClient, SupportedSport, PinnacleOdds } from '../services/PinnacleOddsClient';
import { SportsMarketDiscovery, SportsMarket, MarketState } from '../services/SportsMarketDiscovery';
import axios from 'axios';
import * as path from 'path';

// ============================================================================
// TYPES
// ============================================================================

interface SpreadData {
  marketSlug: string;
  sport: SupportedSport;
  homeTeam: string;
  awayTeam: string;
  
  // Polymarket data
  polymarketHomeBid: number;
  polymarketHomeAsk: number;
  polymarketHomeMid: number;
  polymarketAwayBid: number;
  polymarketAwayAsk: number;
  polymarketAwayMid: number;
  
  // Pinnacle fair value (vig-removed)
  pinnacleFairHome: number;
  pinnacleFairAway: number;
  pinnacleVig: number;
  
  // Spread (Polymarket - Pinnacle)
  homeSpread: number; // cents
  awaySpread: number; // cents
  
  // Game info
  commenceTime: Date;
  minutesToStart: number;
  
  // Recommendation
  recommendation: 'BUY_HOME' | 'BUY_AWAY' | 'SELL_HOME' | 'SELL_AWAY' | 'NO_EDGE';
  edge: number; // cents
  
  // History (for chart)
  history: SpreadHistoryPoint[];
  
  lastUpdate: Date;
}

interface SpreadHistoryPoint {
  timestamp: number;
  homeSpread: number;
  awaySpread: number;
  polymarketHomeMid: number;
  polymarketAwayMid: number;
  pinnacleFairHome: number;
  pinnacleFairAway: number;
}

interface DashboardConfig {
  port: number;
  updateIntervalMs: number; // how often to refresh spreads
  threshold: number; // minimum spread to alert (cents)
  sports: SupportedSport[];
  maxHistoryPoints: number; // max points to keep in chart
}

// ============================================================================
// DASHBOARD SERVER
// ============================================================================

export class SpreadScannerDashboard {
  private app: express.Application;
  private server: any;
  private io: SocketIOServer;
  private pinnacle: PinnacleOddsClient;
  private discovery: SportsMarketDiscovery;
  private config: DashboardConfig;
  
  private spreads: Map<string, SpreadData> = new Map();
  private updateInterval?: NodeJS.Timeout;
  private isRunning = false;

  constructor(
    pinnacle: PinnacleOddsClient,
    discovery: SportsMarketDiscovery,
    config?: Partial<DashboardConfig>,
  ) {
    this.pinnacle = pinnacle;
    this.discovery = discovery;
    this.config = {
      port: config?.port ?? 3040,
      updateIntervalMs: config?.updateIntervalMs ?? 30_000, // 30s default
      threshold: config?.threshold ?? 2,
      sports: config?.sports ?? ['NBA', 'NFL', 'NHL'],
      maxHistoryPoints: config?.maxHistoryPoints ?? 100,
    };

    // Setup Express + Socket.IO
    this.app = express();
    this.server = createServer(this.app);
    this.io = new SocketIOServer(this.server);

    this.setupRoutes();
    this.setupSocketIO();
  }

  // ==========================================================================
  // SETUP
  // ==========================================================================

  private setupRoutes(): void {
    // Serve static HTML dashboard
    this.app.get('/', (req, res) => {
      res.send(this.getHTML());
    });

    // API endpoints
    this.app.get('/api/spreads', (req, res) => {
      const spreadsArray = Array.from(this.spreads.values())
        .sort((a, b) => b.edge - a.edge); // Sort by edge (highest first)
      res.json({ spreads: spreadsArray });
    });

    this.app.get('/api/stats', (req, res) => {
      res.json({
        totalGames: this.spreads.size,
        opportunities: Array.from(this.spreads.values()).filter(s => s.edge >= this.config.threshold).length,
        threshold: this.config.threshold,
        sports: this.config.sports,
        updateInterval: this.config.updateIntervalMs,
        lastUpdate: new Date(),
      });
    });
  }

  private setupSocketIO(): void {
    this.io.on('connection', (socket) => {
      this.log(`📱 Client connected: ${socket.id}`);
      
      // Send initial data
      socket.emit('init', {
        spreads: Array.from(this.spreads.values()),
        config: this.config,
      });

      socket.on('disconnect', () => {
        this.log(`📱 Client disconnected: ${socket.id}`);
      });
    });
  }

  // ==========================================================================
  // START/STOP
  // ==========================================================================

  async start(): Promise<void> {
    this.isRunning = true;

    // Start HTTP server (bind to 0.0.0.0 for external access)
    await new Promise<void>((resolve) => {
      this.server.listen(this.config.port, '0.0.0.0', () => {
        this.log(`🚀 Dashboard running on http://0.0.0.0:${this.config.port}`);
        this.log(`   External access: http://<your-ip>:${this.config.port}`);
        resolve();
      });
    });

    // Start update loop
    this.updateInterval = setInterval(() => {
      this.updateSpreads().catch(err => {
        this.logError('Update loop error', err);
      });
    }, this.config.updateIntervalMs);

    // Initial update
    await this.updateSpreads();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    this.log('🛑 Dashboard stopped');
  }

  // ==========================================================================
  // SPREAD UPDATES
  // ==========================================================================

  private async updateSpreads(): Promise<void> {
    const startMs = Date.now();
    let newOpportunities = 0;

    for (const sport of this.config.sports) {
      try {
        // Fetch Pinnacle odds
        const pinnacleOdds = await this.pinnacle.getMoneylineOdds(sport);
        
        // Get Polymarket markets
        const markets = this.discovery.getMarketsByState(MarketState.DISCOVERED);
        const sportMarkets = markets.filter(m => m.sport.toLowerCase() === sport.toLowerCase());

        for (const pinnOdds of pinnacleOdds) {
          // Find matching Polymarket market + token index mapping
          const result = this.findPolymarketMarket(sportMarkets, pinnOdds);
          if (!result) continue;

          const { market, homeTokenIndex, awayTokenIndex } = result;

          // Fetch orderbook
          const spread = await this.calculateSpread(market, pinnOdds, homeTokenIndex, awayTokenIndex);
          if (!spread) continue;

          // Update or create spread entry
          const existing = this.spreads.get(market.marketSlug);
          if (existing) {
            // Update history
            spread.history = existing.history;
            spread.history.push({
              timestamp: Date.now(),
              homeSpread: spread.homeSpread,
              awaySpread: spread.awaySpread,
              polymarketHomeMid: spread.polymarketHomeMid,
              polymarketAwayMid: spread.polymarketAwayMid,
              pinnacleFairHome: spread.pinnacleFairHome,
              pinnacleFairAway: spread.pinnacleFairAway,
            });

            // Trim history
            if (spread.history.length > this.config.maxHistoryPoints) {
              spread.history = spread.history.slice(-this.config.maxHistoryPoints);
            }
          } else {
            // New spread
            spread.history = [{
              timestamp: Date.now(),
              homeSpread: spread.homeSpread,
              awaySpread: spread.awaySpread,
              polymarketHomeMid: spread.polymarketHomeMid,
              polymarketAwayMid: spread.polymarketAwayMid,
              pinnacleFairHome: spread.pinnacleFairHome,
              pinnacleFairAway: spread.pinnacleFairAway,
            }];
          }

          this.spreads.set(market.marketSlug, spread);

          // Emit updates
          this.io.emit('spreadUpdate', spread);

          // Alert if edge exceeds threshold
          if (spread.edge >= this.config.threshold) {
            if (!existing || existing.edge < this.config.threshold) {
              newOpportunities++;
              this.io.emit('opportunityAlert', spread);
            }
          }

          // Alert if game starting soon
          if (spread.minutesToStart <= 60 && spread.minutesToStart > 55) {
            this.io.emit('gameStart', spread);
          }
        }
      } catch (err) {
        this.logError(`Failed to update ${sport} spreads`, err);
      }
    }

    const elapsedMs = Date.now() - startMs;
    this.log(`✅ Updated ${this.spreads.size} spreads (${newOpportunities} new opportunities) in ${elapsedMs}ms`);
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  private findPolymarketMarket(
    markets: SportsMarket[], 
    pinnOdds: PinnacleOdds
  ): { market: SportsMarket; homeTokenIndex: number; awayTokenIndex: number } | null {
    const homeNorm = this.normalizeTeamName(pinnOdds.homeTeam);
    const awayNorm = this.normalizeTeamName(pinnOdds.awayTeam);

    for (const market of markets) {
      if (market.outcomes.length < 2) continue;

      const outcome1 = market.outcomes[0];
      const outcome2 = market.outcomes[1];

      const match1 = this.teamsMatch(homeNorm, outcome1) && this.teamsMatch(awayNorm, outcome2);
      const match2 = this.teamsMatch(homeNorm, outcome2) && this.teamsMatch(awayNorm, outcome1);

      if (match1) {
        // Home = outcome1 (index 0), Away = outcome2 (index 1)
        return { market, homeTokenIndex: 0, awayTokenIndex: 1 };
      } else if (match2) {
        // Home = outcome2 (index 1), Away = outcome1 (index 0)
        return { market, homeTokenIndex: 1, awayTokenIndex: 0 };
      }
    }

    return null;
  }

  private normalizeTeamName(name: string): string {
    const words = name.split(/\s+/);
    return words[words.length - 1].toLowerCase().replace(/[^a-z]/g, '');
  }

  private teamsMatch(pinnacleNorm: string, polymarketOutcome: string): boolean {
    const pmLower = polymarketOutcome.toLowerCase();
    return pmLower === pinnacleNorm || pmLower.includes(pinnacleNorm) || pinnacleNorm.includes(pmLower);
  }

  private async calculateSpread(
    market: SportsMarket, 
    pinnOdds: PinnacleOdds,
    homeTokenIndex: number,
    awayTokenIndex: number
  ): Promise<SpreadData | null> {
    try {
      // Use market's current prices from Gamma API (last traded price)
      // NOT orderbook mid - sports markets trade via market orders, orderbook is misleading
      if (!market.outcomePrices || market.outcomePrices.length < 2) {
        this.log(`⚠️  Market ${market.marketSlug} missing outcome prices`);
        return null;
      }

      // Parse outcome prices (stored as string array in SportsMarket)
      const prices = market.outcomePrices.map((p: string) => parseFloat(p));
      
      // Map to home/away using the token indices we determined earlier
      const homePrice = prices[homeTokenIndex];
      const awayPrice = prices[awayTokenIndex];

      if (isNaN(homePrice) || isNaN(awayPrice)) {
        this.log(`⚠️  Invalid prices for ${market.marketSlug}: home=${homePrice}, away=${awayPrice}`);
        return null;
      }

      // Skip if prices are obviously wrong (sum should be ~1.0)
      const priceSum = homePrice + awayPrice;
      if (priceSum < 0.95 || priceSum > 1.05) {
        this.log(`⚠️  Invalid price sum for ${market.marketSlug}: ${priceSum.toFixed(2)} (expected ~1.0)`);
        return null;
      }

      const homeMid = homePrice;
      const awayMid = awayPrice;
      
      // For display purposes, use small bid-ask spread assumption (±0.5¢)
      const homeBid = Math.max(0.01, homePrice - 0.005);
      const homeAsk = Math.min(0.99, homePrice + 0.005);
      const awayBid = Math.max(0.01, awayPrice - 0.005);
      const awayAsk = Math.min(0.99, awayPrice + 0.005);

      // Calculate spreads
      const homeSpread = Math.round((homeMid - pinnOdds.homeFair) * 100);
      const awaySpread = Math.round((awayMid - pinnOdds.awayFair) * 100);

      // Determine recommendation
      let recommendation: SpreadData['recommendation'] = 'NO_EDGE';
      let edge = 0;

      if (homeSpread <= -this.config.threshold) {
        recommendation = 'BUY_HOME';
        edge = Math.abs(homeSpread);
      } else if (homeSpread >= this.config.threshold) {
        recommendation = 'SELL_HOME';
        edge = Math.abs(homeSpread);
      } else if (awaySpread <= -this.config.threshold) {
        recommendation = 'BUY_AWAY';
        edge = Math.abs(awaySpread);
      } else if (awaySpread >= this.config.threshold) {
        recommendation = 'SELL_AWAY';
        edge = Math.abs(awaySpread);
      }

      // Calculate time to start
      const minutesToStart = Math.floor((pinnOdds.commenceTime.getTime() - Date.now()) / 60_000);

      return {
        marketSlug: market.marketSlug,
        sport: pinnOdds.sportKey.includes('nba') ? 'NBA' : pinnOdds.sportKey.includes('nfl') ? 'NFL' : 'NHL',
        homeTeam: pinnOdds.homeTeam,
        awayTeam: pinnOdds.awayTeam,
        polymarketHomeBid: homeBid,
        polymarketHomeAsk: homeAsk,
        polymarketHomeMid: homeMid,
        polymarketAwayBid: awayBid,
        polymarketAwayAsk: awayAsk,
        polymarketAwayMid: awayMid,
        pinnacleFairHome: pinnOdds.homeFair,
        pinnacleFairAway: pinnOdds.awayFair,
        pinnacleVig: pinnOdds.vig,
        homeSpread,
        awaySpread,
        commenceTime: pinnOdds.commenceTime,
        minutesToStart,
        recommendation,
        edge,
        history: [],
        lastUpdate: new Date(),
      };
    } catch (err) {
      this.logError(`Failed to calculate spread for ${market.marketSlug}`, err);
      return null;
    }
  }

  private async fetchOrderbook(tokenId: string): Promise<{ bids: { price: number }[]; asks: { price: number }[] }> {
    try {
      const url = `https://clob.polymarket.com/book?token_id=${tokenId}`;
      const res = await axios.get(url);
      
      if (res.data.error) {
        this.log(`⚠️  Orderbook error for token ${tokenId.slice(0,8)}...: ${res.data.error}`);
        return { bids: [], asks: [] };
      }
      
      const bids = (res.data.bids || []).map((b: any) => ({ price: parseFloat(b.price) }));
      const asks = (res.data.asks || []).map((a: any) => ({ price: parseFloat(a.price) }));
      
      if (bids.length === 0 || asks.length === 0) {
        this.log(`⚠️  Empty orderbook for token ${tokenId.slice(0,8)}...: ${bids.length} bids, ${asks.length} asks`);
      }
      
      return { bids, asks };
    } catch (err: any) {
      this.logError(`Orderbook fetch failed for ${tokenId.slice(0,8)}...`, err);
      return { bids: [], asks: [] };
    }
  }

  // ==========================================================================
  // HTML
  // ==========================================================================

  private getHTML(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Spread Scanner Dashboard</title>
  <script src="https://cdn.socket.io/4.5.4/socket.io.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a0e27;
      color: #e0e6ed;
      padding: 20px;
    }
    header {
      background: linear-gradient(135deg, #1a237e 0%, #0d47a1 100%);
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
    }
    h1 { font-size: 28px; margin-bottom: 8px; }
    .stats { display: flex; gap: 20px; margin-top: 10px; font-size: 14px; }
    .stat { opacity: 0.9; }
    .stat strong { color: #64b5f6; }
    
    .opportunities {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    
    .opp-card {
      background: #1e2139;
      border-radius: 12px;
      padding: 20px;
      border: 2px solid #2c3154;
      transition: all 0.3s;
    }
    .opp-card:hover {
      border-color: #64b5f6;
      transform: translateY(-2px);
    }
    .opp-card.buy { border-left: 4px solid #4caf50; }
    .opp-card.sell { border-left: 4px solid #f44336; }
    
    .opp-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }
    .opp-teams { font-size: 18px; font-weight: 600; }
    .opp-sport { 
      background: #2c3154;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 12px;
      text-transform: uppercase;
    }
    
    .opp-edge {
      font-size: 32px;
      font-weight: 700;
      margin: 10px 0;
    }
    .opp-edge.positive { color: #4caf50; }
    .opp-edge.negative { color: #f44336; }
    
    .opp-action {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 15px;
    }
    .opp-action.buy { background: #4caf50; color: white; }
    .opp-action.sell { background: #f44336; color: white; }
    
    .opp-prices {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
      margin-top: 15px;
      padding-top: 15px;
      border-top: 1px solid #2c3154;
    }
    .price-box {
      background: #151829;
      padding: 12px;
      border-radius: 6px;
    }
    .price-label {
      font-size: 11px;
      text-transform: uppercase;
      opacity: 0.7;
      margin-bottom: 6px;
    }
    .price-value {
      font-size: 20px;
      font-weight: 600;
    }
    .price-value.pm { color: #64b5f6; }
    .price-value.pin { color: #ffa726; }
    
    .opp-footer {
      margin-top: 15px;
      font-size: 13px;
      opacity: 0.7;
      display: flex;
      justify-content: space-between;
    }
    
    .chart-container {
      background: #1e2139;
      border-radius: 12px;
      padding: 20px;
      margin-top: 20px;
    }
    canvas {
      max-height: 300px;
    }
    
    .no-opps {
      text-align: center;
      padding: 60px;
      opacity: 0.5;
    }
  </style>
</head>
<body>
  <header>
    <h1>📊 Spread Scanner Dashboard</h1>
    <div class="stats">
      <div class="stat">Threshold: <strong id="threshold">2¢</strong></div>
      <div class="stat">Sports: <strong id="sports">NBA, NFL, NHL</strong></div>
      <div class="stat">Games: <strong id="gameCount">0</strong></div>
      <div class="stat">Opportunities: <strong id="oppCount">0</strong></div>
      <div class="stat">Last update: <strong id="lastUpdate">--</strong></div>
    </div>
    <div style="margin-top:12px;">
      <button id="toggleBtn" onclick="toggleShowAll()" style="
        padding: 8px 16px;
        background: rgba(100, 181, 246, 0.2);
        color: #64b5f6;
        border: 1px solid #64b5f6;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        transition: all 0.2s;
      " onmouseover="this.style.background='rgba(100, 181, 246, 0.3)'" 
         onmouseout="this.style.background='rgba(100, 181, 246, 0.2)'">
        📋 Show All Games
      </button>
    </div>
  </header>
  
  <div id="opportunities" class="opportunities"></div>
  
  <div class="chart-container" style="display: none;" id="chartContainer">
    <h3 style="margin-bottom: 15px;">Spread History</h3>
    <canvas id="spreadChart"></canvas>
  </div>

  <script>
    const socket = io();
    let spreads = new Map();
    let selectedMarket = null;
    let chart = null;
    let showAll = false;
    
    socket.on('init', (data) => {
      console.log('Dashboard initialized', data);
      document.getElementById('threshold').textContent = data.config.threshold + '¢';
      document.getElementById('sports').textContent = data.config.sports.join(', ');
      
      data.spreads.forEach(s => {
        spreads.set(s.marketSlug, s);
      });
      render();
    });
    
    socket.on('spreadUpdate', (spread) => {
      spreads.set(spread.marketSlug, spread);
      render();
      if (selectedMarket === spread.marketSlug) {
        updateChart(spread);
      }
    });
    
    socket.on('opportunityAlert', (spread) => {
      console.log('🚨 New opportunity:', spread);
      // Could add browser notification here
    });
    
    function toggleShowAll() {
      showAll = !showAll;
      const btn = document.getElementById('toggleBtn');
      if (showAll) {
        btn.textContent = '🎯 Show Opportunities Only';
        btn.style.background = 'rgba(239, 68, 68, 0.2)';
        btn.style.borderColor = '#ef4444';
        btn.style.color = '#ef4444';
      } else {
        btn.textContent = '📋 Show All Games';
        btn.style.background = 'rgba(100, 181, 246, 0.2)';
        btn.style.borderColor = '#64b5f6';
        btn.style.color = '#64b5f6';
      }
      render();
    }
    
    function render() {
      const container = document.getElementById('opportunities');
      const threshold = parseInt(document.getElementById('threshold').textContent);
      
      // Filter based on toggle state
      let spreadsArray = Array.from(spreads.values());
      if (!showAll) {
        spreadsArray = spreadsArray.filter(s => s.edge >= threshold);
      }
      spreadsArray.sort((a, b) => b.edge - a.edge);
      
      const opportunitiesCount = Array.from(spreads.values()).filter(s => s.edge >= threshold).length;
      
      document.getElementById('gameCount').textContent = spreads.size;
      document.getElementById('oppCount').textContent = opportunitiesCount;
      document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
      
      if (spreadsArray.length === 0) {
        const msg = showAll ? 'No games found' : 'No opportunities above threshold';
        container.innerHTML = '<div class="no-opps">' + msg + '</div>';
        return;
      }
      
      container.innerHTML = spreadsArray.map(s => {
        // Convert recommendation to team-based display
        let action = s.recommendation.split('_')[0]; // BUY or SELL
        let teamName = '';
        if (s.recommendation.includes('HOME')) {
          teamName = s.homeTeam.split(' ').pop(); // Last word (mascot)
        } else if (s.recommendation.includes('AWAY')) {
          teamName = s.awayTeam.split(' ').pop();
        }
        const displayAction = teamName ? \`\${action} \${teamName}\` : s.recommendation.replace('_', ' ');
        
        // Check if this is below threshold (when showing all)
        const isBelowThreshold = s.edge < threshold;
        const cardClass = s.recommendation.includes('BUY') ? 'buy' : 'sell';
        const opacity = isBelowThreshold && showAll ? 'style="opacity:0.6;"' : '';
        const edgeLabel = isBelowThreshold && showAll ? \`\${s.edge}¢ (below threshold)\` : \`\${s.edge}¢ edge\`;
        
        return \`
        <div class="opp-card \${cardClass}" \${opacity}
             onclick="selectMarket('\${s.marketSlug}')">
          <div class="opp-header">
            <div class="opp-teams">\${s.homeTeam} vs \${s.awayTeam}</div>
            <div class="opp-sport">\${s.sport}</div>
          </div>
          
          <div class="opp-edge \${s.edge >= threshold ? (s.edge > 0 ? 'positive' : 'negative') : ''}" style="font-size:\${isBelowThreshold ? '20px' : '32px'};">\${edgeLabel}</div>
          <div class="opp-action \${s.recommendation.includes('BUY') ? 'buy' : 'sell'}">
            \${displayAction}
          </div>
          
          <div class="opp-prices">
            <div class="price-box">
              <div class="price-label">Polymarket Mid</div>
              <div class="price-value pm">\${(s.polymarketHomeMid * 100).toFixed(1)}¢</div>
            </div>
            <div class="price-box">
              <div class="price-label">Pinnacle Fair</div>
              <div class="price-value pin">\${(s.pinnacleFairHome * 100).toFixed(1)}¢</div>
            </div>
          </div>
          
          <div class="opp-footer">
            <span>Starts in \${s.minutesToStart > 60 ? Math.floor(s.minutesToStart / 60) + 'h' : s.minutesToStart + 'm'}</span>
            <span>Spread: \${s.homeSpread > 0 ? '+' : ''}\${s.homeSpread}¢</span>
          </div>
          
          <a href="https://polymarket.com/event/\${s.marketSlug}" target="_blank" rel="noopener noreferrer"
             style="display:block;margin-top:12px;padding:8px;background:rgba(100,181,246,0.15);
                    color:#64b5f6;text-align:center;text-decoration:none;border-radius:6px;
                    font-weight:600;font-size:13px;border:1px solid #64b5f6;transition:all 0.2s;"
             onclick="event.stopPropagation()"
             onmouseover="this.style.background='rgba(100,181,246,0.25)'"
             onmouseout="this.style.background='rgba(100,181,246,0.15)'">
            🔗 View on Polymarket
          </a>
        </div>
      \`;
      }).join('');
    }
    
    function selectMarket(marketSlug) {
      selectedMarket = marketSlug;
      const spread = spreads.get(marketSlug);
      if (!spread) return;
      
      document.getElementById('chartContainer').style.display = 'block';
      updateChart(spread);
    }
    
    function updateChart(spread) {
      const ctx = document.getElementById('spreadChart');
      
      if (chart) {
        chart.destroy();
      }
      
      chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: spread.history.map(h => new Date(h.timestamp).toLocaleTimeString()),
          datasets: [
            {
              label: 'Home Spread',
              data: spread.history.map(h => h.homeSpread),
              borderColor: '#64b5f6',
              backgroundColor: 'rgba(100, 181, 246, 0.1)',
              tension: 0.3,
            },
            {
              label: 'Polymarket Mid',
              data: spread.history.map(h => h.polymarketHomeMid * 100),
              borderColor: '#4caf50',
              borderDash: [5, 5],
              tension: 0.3,
            },
            {
              label: 'Pinnacle Fair',
              data: spread.history.map(h => h.pinnacleFairHome * 100),
              borderColor: '#ffa726',
              borderDash: [5, 5],
              tension: 0.3,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: '#e0e6ed' } },
          },
          scales: {
            y: {
              ticks: { color: '#e0e6ed' },
              grid: { color: '#2c3154' },
            },
            x: {
              ticks: { color: '#e0e6ed' },
              grid: { color: '#2c3154' },
            },
          },
        },
      });
    }
  </script>
</body>
</html>`;
  }

  // ==========================================================================
  // LOGGING
  // ==========================================================================

  private log(message: string): void {
    const ts = new Date().toISOString();
    console.log(`${ts} [INFO] 📊 [SpreadDashboard] ${message}`);
  }

  private logError(message: string, err: unknown): void {
    const ts = new Date().toISOString();
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`${ts} [ERROR] 📊 [SpreadDashboard] ${message}: ${errMsg}`);
  }
}
