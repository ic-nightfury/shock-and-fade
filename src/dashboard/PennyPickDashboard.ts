import express from 'express';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import { PennyPickScanner, PennyOutcome } from '../services/PennyPickScanner.js';

const HTML_TEMPLATE = `
<!DOCTYPE html>
<html>
<head>
  <title>Polymarket Penny Picks Scanner</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'SF Mono', 'Menlo', monospace;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #e0e0e0;
      padding: 20px;
      min-height: 100vh;
    }
    .container { max-width: 1800px; margin: 0 auto; }
    
    header {
      background: rgba(0, 0, 0, 0.3);
      padding: 20px 30px;
      border-radius: 12px;
      margin-bottom: 25px;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    h1 {
      font-size: 28px;
      color: #ffd700;
      margin-bottom: 10px;
    }
    .subtitle {
      font-size: 14px;
      color: #888;
      margin-bottom: 15px;
    }
    
    .controls {
      display: flex;
      gap: 15px;
      flex-wrap: wrap;
      align-items: center;
      margin-top: 15px;
      padding-top: 15px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
    }
    .control-group {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .control-group label {
      font-size: 13px;
      color: #aaa;
    }
    select, input[type="number"] {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #e0e0e0;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 13px;
      font-family: inherit;
    }
    select:focus, input:focus {
      outline: none;
      border-color: #ffd700;
    }
    button {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border: none;
      color: white;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }
    button:active { transform: translateY(0); }
    
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 25px;
    }
    .stat-card {
      background: rgba(0, 0, 0, 0.3);
      padding: 20px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    .stat-label {
      font-size: 12px;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }
    .stat-value {
      font-size: 28px;
      font-weight: bold;
      color: #ffd700;
    }
    .stat-sub {
      font-size: 13px;
      color: #aaa;
      margin-top: 5px;
    }
    
    .table-container {
      background: rgba(0, 0, 0, 0.3);
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      overflow: hidden;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    thead {
      background: rgba(0, 0, 0, 0.4);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    th {
      padding: 15px 12px;
      text-align: left;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #aaa;
      font-weight: 600;
      cursor: pointer;
      user-select: none;
      border-bottom: 2px solid rgba(255, 255, 255, 0.1);
    }
    th:hover { color: #ffd700; }
    th.sortable::after {
      content: ' ↕';
      opacity: 0.3;
    }
    th.sorted-asc::after {
      content: ' ↑';
      opacity: 1;
      color: #ffd700;
    }
    th.sorted-desc::after {
      content: ' ↓';
      opacity: 1;
      color: #ffd700;
    }
    td {
      padding: 12px;
      font-size: 13px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    tbody tr {
      transition: background 0.2s;
    }
    tbody tr:hover {
      background: rgba(255, 255, 255, 0.05);
    }
    
    .outcome-name {
      font-weight: 600;
      color: #fff;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .event-name {
      font-size: 11px;
      color: #777;
      max-width: 250px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    
    .price { color: #ffd700; font-weight: 600; }
    .spread { color: #888; }
    .spread.good { color: #4ade80; }
    .spread.bad { color: #f87171; }
    
    .change-positive { color: #4ade80; }
    .change-negative { color: #f87171; }
    .change-neutral { color: #888; }
    
    .volume { color: #60a5fa; }
    .category {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .category.politics { background: rgba(139, 92, 246, 0.3); color: #c4b5fd; }
    .category.fed-economics { background: rgba(34, 197, 94, 0.3); color: #86efac; }
    .category.geopolitical { background: rgba(239, 68, 68, 0.3); color: #fca5a5; }
    .category.crypto { background: rgba(251, 191, 36, 0.3); color: #fde68a; }
    .category.nba { background: rgba(249, 115, 22, 0.3); color: #fdba74; }
    .category.nhl { background: rgba(14, 165, 233, 0.3); color: #7dd3fc; }
    .category.soccer { background: rgba(34, 197, 94, 0.3); color: #86efac; }
    .category.sports-other { background: rgba(168, 85, 247, 0.3); color: #d8b4fe; }
    .category.entertainment { background: rgba(236, 72, 153, 0.3); color: #f9a8d4; }
    .category.tech-business { background: rgba(59, 130, 246, 0.3); color: #93c5fd; }
    .category.other { background: rgba(100, 116, 139, 0.3); color: #cbd5e1; }
    
    .tier {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .tier.elite {
      background: rgba(34, 197, 94, 0.3);
      color: #86efac;
      border: 1px solid #86efac;
    }
    .tier.good {
      background: rgba(59, 130, 246, 0.3);
      color: #93c5fd;
      border: 1px solid #93c5fd;
    }
    .tier.marginal {
      background: rgba(251, 191, 36, 0.3);
      color: #fde68a;
      border: 1px solid #fde68a;
    }
    .tier.poor {
      background: rgba(239, 68, 68, 0.3);
      color: #fca5a5;
      border: 1px solid #fca5a5;
    }
    
    /* Row color coding by tier */
    tbody tr.tier-elite {
      background: rgba(34, 197, 94, 0.05);
    }
    tbody tr.tier-good {
      background: rgba(59, 130, 246, 0.05);
    }
    tbody tr.tier-marginal {
      background: rgba(251, 191, 36, 0.05);
    }
    tbody tr:hover.tier-elite {
      background: rgba(34, 197, 94, 0.12);
    }
    tbody tr:hover.tier-good {
      background: rgba(59, 130, 246, 0.12);
    }
    tbody tr:hover.tier-marginal {
      background: rgba(251, 191, 36, 0.12);
    }
    
    .link-icon {
      color: #60a5fa;
      text-decoration: none;
      font-size: 16px;
    }
    .link-icon:hover { color: #ffd700; }
    
    .status {
      position: fixed;
      top: 20px;
      right: 20px;
      background: rgba(0, 0, 0, 0.8);
      padding: 12px 20px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      font-size: 13px;
      z-index: 100;
    }
    .status.connected { border-color: #4ade80; color: #4ade80; }
    .status.disconnected { border-color: #f87171; color: #f87171; }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .updating {
      animation: pulse 1s ease-in-out infinite;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="status" id="status">● Connecting...</div>
    
    <header>
      <h1>💰 Polymarket Penny Picks Scanner</h1>
      <div class="subtitle">Low-probability, high-volume multi-outcome opportunities (0.5-10¢)<br/>
        <span style="font-size: 12px; opacity: 0.7;">Tick Cross = % of trades that move ±0.1¢ (24h real data) | Min 30% threshold | Sorted by activity</span>
      </div>
      
      <div class="controls">
        <div class="control-group">
          <label>Category:</label>
          <select id="categoryFilter">
            <option value="all">All Categories</option>
            <option value="Politics">Politics</option>
            <option value="Fed/Economics">Fed/Economics</option>
            <option value="Geopolitical">Geopolitical</option>
            <option value="Crypto">Crypto</option>
            <option value="NBA">NBA</option>
            <option value="NHL">NHL</option>
            <option value="Soccer">Soccer</option>
            <option value="Sports-Other">Sports-Other</option>
            <option value="Entertainment">Entertainment</option>
            <option value="Tech/Business">Tech/Business</option>
          </select>
        </div>
        
        <div class="control-group">
          <label>Min Volume:</label>
          <select id="minVolumeFilter">
            <option value="0">All</option>
            <option value="50000">$50K+</option>
            <option value="100000">$100K+</option>
            <option value="200000">$200K+</option>
            <option value="500000">$500K+</option>
          </select>
        </div>
        
        <div class="control-group">
          <label>Max Spread:</label>
          <select id="maxSpreadFilter">
            <option value="100">All</option>
            <option value="20">≤20%</option>
            <option value="15">≤15%</option>
            <option value="10">≤10%</option>
          </select>
        </div>
        
        <div class="control-group">
          <label>Price Range:</label>
          <input type="number" id="minPriceFilter" value="0.5" step="0.1" min="0" max="20" style="width: 80px;">
          <span style="color: #666;">to</span>
          <input type="number" id="maxPriceFilter" value="10" step="0.1" min="0" max="20" style="width: 80px;">
          <span style="color: #666;">¢</span>
        </div>
        
        <button id="refreshBtn">🔄 Refresh Now</button>
      </div>
    </header>
    
    <div class="stats" id="stats"></div>
    
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th class="sortable" data-sort="tier">Tier</th>
            <th class="sortable" data-sort="tickCrossRate">Tick%</th>
            <th class="sortable" data-sort="outcome">Outcome</th>
            <th class="sortable" data-sort="event">Event</th>
            <th class="sortable" data-sort="category">Category</th>
            <th class="sortable" data-sort="price">Price</th>
            <th class="sortable" data-sort="spread">Spread</th>
            <th class="sortable" data-sort="fillProbability">Fill%</th>
            <th class="sortable" data-sort="volume24h">24h Vol</th>
            <th class="sortable" data-sort="priceChange1w">1w Δ</th>
            <th>Link</th>
          </tr>
        </thead>
        <tbody id="tableBody"></tbody>
      </table>
    </div>
  </div>
  
  <script>
    const socket = io();
    let allOutcomes = [];
    let sortColumn = 'tickCrossRate';
    let sortDirection = 'desc';
    
    const statusEl = document.getElementById('status');
    const statsEl = document.getElementById('stats');
    const tableBodyEl = document.getElementById('tableBody');
    
    socket.on('connect', () => {
      statusEl.textContent = '● Connected';
      statusEl.className = 'status connected';
    });
    
    socket.on('disconnect', () => {
      statusEl.textContent = '● Disconnected';
      statusEl.className = 'status disconnected';
    });
    
    socket.on('update', (data) => {
      allOutcomes = data.outcomes;
      renderStats(data.stats);
      renderTable();
    });
    
    function renderStats(stats) {
      statsEl.innerHTML = \`
        <div class="stat-card">
          <div class="stat-label">Opportunities</div>
          <div class="stat-value">\${stats.totalOpportunities}</div>
          <div class="stat-sub">\${stats.categories} categories</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total 24h Volume</div>
          <div class="stat-value">$\${(stats.totalVolume24h / 1e6).toFixed(1)}M</div>
          <div class="stat-sub">Across all outcomes</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Avg Price</div>
          <div class="stat-value">\${(stats.avgPrice * 100).toFixed(1)}¢</div>
          <div class="stat-sub">Avg spread: \${(stats.avgSpread * 100).toFixed(1)}¢</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Biggest Mover</div>
          <div class="stat-value">\${stats.biggestMover > 0 ? '+' : ''}\${(stats.biggestMover * 100).toFixed(1)}¢</div>
          <div class="stat-sub">1-week change</div>
        </div>
      \`;
    }
    
    function renderTable() {
      const categoryFilter = document.getElementById('categoryFilter').value;
      const minVolume = parseFloat(document.getElementById('minVolumeFilter').value);
      const maxSpread = parseFloat(document.getElementById('maxSpreadFilter').value);
      const minPrice = parseFloat(document.getElementById('minPriceFilter').value) / 100;
      const maxPrice = parseFloat(document.getElementById('maxPriceFilter').value) / 100;
      
      let filtered = allOutcomes.filter(o => {
        if (categoryFilter !== 'all' && o.category !== categoryFilter) return false;
        if (o.volume24h < minVolume) return false;
        if (o.spreadPct > maxSpread) return false;
        if (o.price < minPrice || o.price > maxPrice) return false;
        return true;
      });
      
      // Sort
      filtered.sort((a, b) => {
        const aVal = a[sortColumn];
        const bVal = b[sortColumn];
        const mult = sortDirection === 'asc' ? 1 : -1;
        if (typeof aVal === 'string') return mult * aVal.localeCompare(bVal);
        return mult * (aVal - bVal);
      });
      
      tableBodyEl.innerHTML = filtered.map(o => \`
        <tr class="tier-\${o.tier}">
          <td><span class="tier \${o.tier}">\${o.tier === 'elite' ? '🔥 Elite' : o.tier === 'good' ? '✅ Good' : o.tier === 'marginal' ? '⚠️ Marg' : '❌ Poor'}</span></td>
          <td>
            <span class="\${o.tickCrossRate >= 50 ? 'change-positive' : o.tickCrossRate >= 40 ? 'volume' : 'change-neutral'}" style="font-weight: 600;">\${o.tickCrossRate.toFixed(0)}%</span>
          </td>
          <td><div class="outcome-name" title="\${o.outcome}">\${o.outcome}</div></td>
          <td><div class="event-name" title="\${o.eventTitle}">\${o.eventTitle}</div></td>
          <td><span class="category \${o.category.toLowerCase().replace(/\\/| /g, '-')}">\${o.category}</span></td>
          <td class="price">\${(o.price * 100).toFixed(1)}¢</td>
          <td>
            <span class="spread \${o.spreadPct < 10 ? 'good' : o.spreadPct > 20 ? 'bad' : ''}">\${(o.spread * 100).toFixed(1)}¢ (\${o.spreadPct.toFixed(0)}%)</span>
          </td>
          <td>
            <span class="\${o.fillProbability >= 50 ? 'change-positive' : o.fillProbability >= 30 ? 'volume' : 'change-neutral'}">\${o.fillProbability.toFixed(0)}%</span>
          </td>
          <td class="volume">$\${(o.volume24h / 1000).toFixed(0)}K</td>
          <td class="\${o.priceChange1w > 0 ? 'change-positive' : o.priceChange1w < 0 ? 'change-negative' : 'change-neutral'}">
            \${o.priceChange1w > 0 ? '+' : ''}\${(o.priceChange1w * 100).toFixed(1)}¢
          </td>
          <td><a href="\${o.link}" target="_blank" class="link-icon">🔗</a></td>
        </tr>
      \`).join('');
    }
    
    // Sorting
    document.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (sortColumn === col) {
          sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          sortColumn = col;
          sortDirection = 'desc';
        }
        
        document.querySelectorAll('th.sortable').forEach(t => {
          t.classList.remove('sorted-asc', 'sorted-desc');
        });
        th.classList.add(sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
        
        renderTable();
      });
    });
    
    // Filters
    ['categoryFilter', 'minVolumeFilter', 'maxSpreadFilter', 'minPriceFilter', 'maxPriceFilter'].forEach(id => {
      document.getElementById(id).addEventListener('change', renderTable);
    });
    
    // Refresh button
    document.getElementById('refreshBtn').addEventListener('click', () => {
      socket.emit('refresh');
      document.getElementById('refreshBtn').classList.add('updating');
      setTimeout(() => {
        document.getElementById('refreshBtn').classList.remove('updating');
      }, 2000);
    });
    
    // Set initial sort indicator
    document.querySelector(\`th[data-sort="\${sortColumn}"]\`).classList.add('sorted-desc');
  </script>
</body>
</html>
`;

interface DashboardConfig {
  port: number;
  scanIntervalMs: number;
  scannerConfig?: any;
  tickAnalyzer?: any;
}

const DEFAULT_DASHBOARD_CONFIG: DashboardConfig = {
  port: 3041,
  scanIntervalMs: 60000, // 1 minute
};

export class PennyPickDashboard {
  private config: DashboardConfig;
  private scanner: PennyPickScanner;
  private tickAnalyzer?: any;
  private app: express.Application;
  private server: http.Server;
  private io: SocketIO;
  private scanInterval?: NodeJS.Timeout;
  
  constructor(config: Partial<DashboardConfig> = {}) {
    this.config = { ...DEFAULT_DASHBOARD_CONFIG, ...config };
    this.scanner = new PennyPickScanner(this.config.scannerConfig || {});
    this.tickAnalyzer = config.tickAnalyzer;
    
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new SocketIO(this.server);
    
    this.setupRoutes();
    this.setupSocketIO();
  }
  
  private setupRoutes() {
    this.app.get('/', (_req, res) => {
      res.send(HTML_TEMPLATE);
    });
  }
  
  private setupSocketIO() {
    this.io.on('connection', (socket) => {
      console.log('Dashboard client connected');
      
      // Send initial data immediately
      this.scan().catch(console.error);
      
      socket.on('refresh', () => {
        this.scan().catch(console.error);
      });
      
      socket.on('disconnect', () => {
        console.log('Dashboard client disconnected');
      });
    });
  }
  
  private async scan() {
    try {
      // Inject tick metrics if available
      if (this.tickAnalyzer) {
        const metrics = this.tickAnalyzer.getAllMetrics();
        this.scanner.setTickMetrics(metrics);
      }
      
      const outcomes = await this.scanner.scan();
      
      const stats = {
        totalOpportunities: outcomes.length,
        categories: new Set(outcomes.map(o => o.category)).size,
        totalVolume24h: outcomes.reduce((sum, o) => sum + o.volume24h, 0),
        avgPrice: outcomes.length > 0 ? outcomes.reduce((sum, o) => sum + o.price, 0) / outcomes.length : 0,
        avgSpread: outcomes.length > 0 ? outcomes.reduce((sum, o) => sum + o.spread, 0) / outcomes.length : 0,
        biggestMover: Math.max(...outcomes.map(o => Math.abs(o.priceChange1w))) * (
          outcomes.find(o => Math.abs(o.priceChange1w) === Math.max(...outcomes.map(o => Math.abs(o.priceChange1w))))?.priceChange1w || 0 > 0 ? 1 : -1
        ),
      };
      
      this.io.emit('update', { outcomes, stats, timestamp: Date.now() });
      console.log(`Scan complete: ${outcomes.length} opportunities found`);
    } catch (err) {
      console.error('Scan error:', err);
    }
  }
  
  async start() {
    await new Promise<void>((resolve) => {
      this.server.listen(this.config.port, () => {
        console.log(`\n🚀 Penny Pick Dashboard running at http://localhost:${this.config.port}`);
        console.log(`Scanning every ${this.config.scanIntervalMs / 1000}s\n`);
        resolve();
      });
    });
    
    // Initial scan
    await this.scan();
    
    // Start periodic scanning
    this.scanInterval = setInterval(() => {
      this.scan().catch(console.error);
    }, this.config.scanIntervalMs);
  }
  
  async stop() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
