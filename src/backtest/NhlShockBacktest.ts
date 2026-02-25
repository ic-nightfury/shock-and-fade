import Database from "better-sqlite3";
import { classifySurprise, defaultGameState, FairValue, GameState } from "./SurpriseClassifier";

export type BacktestConfig = {
  dbPath: string;
  /** Sigma threshold for shock detection (standard deviations) */
  sigma: number;
  /** Rolling window for computing return volatility (seconds) */
  windowSeconds: number;
  /** Number of ladder levels to place on the impulse side */
  ladderLevels: number;
  /** Base ladder step — used as a percentage of deviation from fair value */
  ladderStepPct: number;
  /** Max time to fill the complete ladder (seconds) */
  ladderWindowSec: number;
  /** Max time to fill the hedge/fade on opposite side (seconds) */
  fadeWindowSec: number;
  /** Target pair sum: sell1 + sell2 ≥ this for profit */
  targetPair: number;
  /** Notional trade size (shares per fill) */
  tradeSize: number;
  /** Minimum surprise score (0-1) to trigger a trade */
  surpriseThreshold: number;
  /** Total regulation game seconds for sport (NHL=3600, NBA=2880) */
  totalGameSeconds: number;
};

/* ─── Row types ────────────────────────────────────────────────────── */

type Snapshot = {
  ts: number;
  token_id: string;
  best_bid: number;
  best_ask: number;
};

type MarketRow = {
  market_slug: string;
  outcome1: string;
  outcome2: string;
  token1: string;
  token2: string;
  sport: string;
};

type FairValueRow = {
  token_id: string;
  fair_bid: number;
  fair_ask: number;
};

type DepthRow = {
  ts: number;
  token_id: string;
  level: number;
  bid_price: number | null;
  bid_size: number | null;
  ask_price: number | null;
  ask_size: number | null;
};

type GameEventRow = {
  ts: number;
  event_type: string;
  team: string;
  period: string;
  clock: string;
  description: string;
};

/* ─── Trade result ─────────────────────────────────────────────────── */

type TradeResult = {
  market: string;
  shockTs: number;
  impulse: "token1" | "token2";
  sell1: number;
  sell2: number;
  pnl: number;
  filled: boolean;
  surpriseScore: number;
  surpriseReason: string;
  depthAvailable: number; // shares available at fill price
};

/* ─── Aggregate metrics ────────────────────────────────────────────── */

type MarketStats = {
  market: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  sharpe: number;
};

export class NhlShockBacktest {
  private db: Database.Database;
  private cfg: BacktestConfig;

  constructor(cfg: BacktestConfig) {
    this.cfg = cfg;
    this.db = new Database(cfg.dbPath, { readonly: true });
  }

  run(): void {
    const markets = this.db
      .prepare(`SELECT market_slug, outcome1, outcome2, token1, token2, COALESCE(sport, 'NHL') as sport FROM markets`)
      .all() as MarketRow[];

    if (markets.length === 0) {
      console.log("No markets found in DB. Run the NHL recorder first.");
      return;
    }

    const allResults: TradeResult[] = [];
    const marketStatsList: MarketStats[] = [];

    for (const m of markets) {
      const snaps = this.loadSnapshots(m.market_slug);
      if (snaps.length < 50) {
        console.log(`⏭  ${m.market_slug}: only ${snaps.length} snaps — skipping`);
        continue;
      }

      const fairValues = this.loadFairValues(m.market_slug);
      const depth = this.loadDepth(m.market_slug);
      const gameEvents = this.loadGameEvents(m.market_slug);

      const marketResults = this.backtestMarket(m, snaps, fairValues, depth, gameEvents);
      allResults.push(...marketResults);

      if (marketResults.length > 0) {
        marketStatsList.push(this.computeMarketStats(m.market_slug, marketResults));
      }
    }

    this.printResults(allResults, marketStatsList);
  }

  /* ─── Data loaders ───────────────────────────────────────────────── */

  private loadSnapshots(marketSlug: string): Snapshot[] {
    return this.db
      .prepare(`SELECT ts, token_id, best_bid, best_ask FROM snapshots WHERE market_slug = ? ORDER BY ts ASC`)
      .all(marketSlug) as Snapshot[];
  }

  private loadFairValues(marketSlug: string): Map<string, FairValue> {
    const rows = this.db
      .prepare(`SELECT token_id, fair_bid, fair_ask FROM fair_values WHERE market_slug = ?`)
      .all(marketSlug) as FairValueRow[];

    const map = new Map<string, FairValue>();
    for (const r of rows) {
      map.set(r.token_id, { fairBid: r.fair_bid, fairAsk: r.fair_ask });
    }
    return map;
  }

  private loadDepth(marketSlug: string): DepthRow[] {
    try {
      return this.db
        .prepare(`SELECT ts, token_id, level, bid_price, bid_size, ask_price, ask_size FROM depth_snapshots WHERE market_slug = ? ORDER BY ts ASC, level ASC`)
        .all(marketSlug) as DepthRow[];
    } catch {
      return []; // table may not exist in older DBs
    }
  }

  private loadGameEvents(marketSlug: string): GameEventRow[] {
    try {
      return this.db
        .prepare(`SELECT ts, event_type, team, period, clock, description FROM game_events WHERE market_slug = ? ORDER BY ts ASC`)
        .all(marketSlug) as GameEventRow[];
    } catch {
      return []; // table may not exist
    }
  }

  /* ─── Per-market backtest ────────────────────────────────────────── */

  private backtestMarket(
    market: MarketRow,
    snaps: Snapshot[],
    fairValues: Map<string, FairValue>,
    depth: DepthRow[],
    gameEvents: GameEventRow[],
  ): TradeResult[] {
    const results: TradeResult[] = [];

    // Use fair values if available, otherwise fall back to first snapshot prices
    const fv1 = fairValues.get(market.token1) || this.inferFairValue(snaps, market.token1);
    const fv2 = fairValues.get(market.token2) || this.inferFairValue(snaps, market.token2);

    if (!fv1 || !fv2) return results;

    let bid1 = 0;
    let bid2 = 0;
    let prevBid1 = 0;

    const window: { ts: number; r: number }[] = [];
    let cooldownUntil = 0; // Don't trigger again within same trade window

    // Index into depth array for lookups
    let depthIdx = 0;

    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i];
      if (s.token_id === market.token1) bid1 = s.best_bid;
      if (s.token_id === market.token2) bid2 = s.best_bid;

      if (bid1 <= 0 || bid2 <= 0) continue;
      if (s.ts < cooldownUntil) {
        prevBid1 = bid1;
        continue;
      }

      if (prevBid1 > 0) {
        const r = bid1 - prevBid1;
        window.push({ ts: s.ts, r });

        const cutoff = s.ts - this.cfg.windowSeconds * 1000;
        while (window.length && window[0].ts < cutoff) window.shift();

        const std = this.std(window.map((w) => w.r));

        if (std > 0 && Math.abs(r) >= this.cfg.sigma * std) {
          const impulse: "token1" | "token2" = r > 0 ? "token1" : "token2";
          const impulseFv = impulse === "token1" ? fv1 : fv2;
          const currentPrice = impulse === "token1" ? bid1 : bid2;

          // Build game state from events + timing
          const gameState = this.estimateGameState(market, snaps, i, gameEvents, fv1, fv2);

          // Classify surprise
          const surprise = classifySurprise(impulseFv, currentPrice, gameState, this.cfg.surpriseThreshold);

          if (!surprise.shouldFade) {
            prevBid1 = bid1;
            continue;
          }

          // Advance depth index to current timestamp
          while (depthIdx < depth.length && depth[depthIdx].ts < s.ts) depthIdx++;

          const res = this.simulateTrade(market, snaps, i, impulse, impulseFv, depth, depthIdx, surprise);
          if (res) {
            results.push(res);
            // Cooldown: skip for ladder + fade window duration
            cooldownUntil = s.ts + (this.cfg.ladderWindowSec + this.cfg.fadeWindowSec) * 1000;
          }
        }
      }

      prevBid1 = bid1;
    }

    return results;
  }

  /* ─── Game state estimation ──────────────────────────────────────── */

  private estimateGameState(
    market: MarketRow,
    snaps: Snapshot[],
    snapIdx: number,
    gameEvents: GameEventRow[],
    fv1: FairValue,
    fv2: FairValue,
  ): GameState {
    const snapTs = snaps[snapIdx].ts;

    // If we have game events, use them to build real game state
    if (gameEvents.length > 0) {
      const firstEventTs = gameEvents[0].ts;
      const elapsed = (snapTs - firstEventTs) / 1000; // seconds since first event
      const totalSecs = this.cfg.totalGameSeconds;
      const remaining = Math.max(0, totalSecs - elapsed);

      // Count goals per team (rough: we don't know home/away perfectly)
      let homeGoals = 0;
      let awayGoals = 0;
      for (const ev of gameEvents) {
        if (ev.ts > snapTs) break;
        if (ev.event_type.includes("goal")) {
          // Use outcome names to guess which team is home
          const team = ev.team.toLowerCase();
          const outcome1Lower = market.outcome1.toLowerCase();
          if (team.includes(outcome1Lower) || outcome1Lower.includes(team.split(" ").pop() || "")) {
            homeGoals++;
          } else {
            awayGoals++;
          }
        }
      }

      return {
        scoringTeam: "home", // direction determined by impulse detection
        timeRemainingSeconds: remaining,
        totalGameSeconds: totalSecs,
        scoreDifferential: homeGoals - awayGoals,
        eventType: "goal",
      };
    }

    // Fallback: estimate from snapshot timestamps
    if (snaps.length > 10) {
      const gameStartTs = snaps[0].ts;
      const elapsed = (snapTs - gameStartTs) / 1000;
      const totalSecs = this.cfg.totalGameSeconds;
      const remaining = Math.max(0, totalSecs - elapsed);

      return {
        scoringTeam: "home",
        timeRemainingSeconds: remaining,
        totalGameSeconds: totalSecs,
        scoreDifferential: 0, // unknown without events
        eventType: "unknown",
      };
    }

    return defaultGameState(this.cfg.totalGameSeconds);
  }

  /* ─── Trade simulation ───────────────────────────────────────────── */

  private simulateTrade(
    market: MarketRow,
    snaps: Snapshot[],
    startIndex: number,
    impulse: "token1" | "token2",
    impulseFv: FairValue,
    depth: DepthRow[],
    depthIdx: number,
    surprise: { score: number; reason: string },
  ): TradeResult | null {
    const tokenImpulse = impulse === "token1" ? market.token1 : market.token2;
    const tokenOther = impulse === "token1" ? market.token2 : market.token1;

    const startSnap = snaps[startIndex];
    const basePrice =
      startSnap.token_id === tokenImpulse
        ? startSnap.best_bid
        : this.findLatestBid(snaps, startIndex, tokenImpulse);
    const otherBase =
      startSnap.token_id === tokenOther
        ? startSnap.best_bid
        : this.findLatestBid(snaps, startIndex, tokenOther);

    if (!basePrice || !otherBase) return null;

    // ─── Ladder placement based on deviation from fair value ────────
    const fairMid = (impulseFv.fairBid + impulseFv.fairAsk) / 2;
    const deviation = Math.abs(basePrice - fairMid);
    // Ladder from current price back toward fair value
    // Steps are proportional to the deviation
    const stepSize = deviation > 0
      ? (deviation * this.cfg.ladderStepPct) / this.cfg.ladderLevels
      : 0.01;

    const ladderPrices: number[] = [];
    for (let k = 0; k < this.cfg.ladderLevels; k++) {
      // If price spiked UP, we sell at successively higher levels
      // Each level is closer to fair value (which is above for a dropped token)
      const price = Math.min(0.99, basePrice + (k + 1) * stepSize);
      ladderPrices.push(price);
    }

    // ─── Simulate ladder fills ──────────────────────────────────────
    let sell1 = 0;
    let depthAvailable = 0;
    let lastIdx = startIndex;

    // Estimate depth at current time
    depthAvailable = this.estimateDepthAtTime(depth, depthIdx, tokenImpulse, basePrice);

    // Immediate ladder — no 30s delay
    for (const price of ladderPrices) {
      const fillIdx = this.findPriceHit(snaps, lastIdx, tokenImpulse, price, this.cfg.ladderWindowSec);
      if (fillIdx !== null) {
        sell1 = price;
        lastIdx = fillIdx;
        break;
      }
    }

    if (sell1 === 0) return null;

    // ─── Hedge / fade on opposite side ──────────────────────────────
    const targetSell2 = Math.max(otherBase, this.cfg.targetPair - sell1);
    const sell2Idx = this.findPriceHit(snaps, lastIdx, tokenOther, targetSell2, this.cfg.fadeWindowSec);

    let sell2 = 0;
    if (sell2Idx !== null) {
      sell2 = targetSell2;
    } else {
      // Hedge at last known bid
      sell2 = this.findLatestBid(snaps, snaps.length - 1, tokenOther) || otherBase;
    }

    const pnl = (sell1 + sell2 - 1) * this.cfg.tradeSize;

    return {
      market: market.market_slug,
      shockTs: snaps[startIndex].ts,
      impulse,
      sell1,
      sell2,
      pnl,
      filled: sell2Idx !== null,
      surpriseScore: surprise.score,
      surpriseReason: surprise.reason,
      depthAvailable,
    };
  }

  private estimateDepthAtTime(depth: DepthRow[], startIdx: number, tokenId: string, price: number): number {
    // Find depth rows around startIdx for the token
    let total = 0;
    for (let i = startIdx; i < Math.min(startIdx + 50, depth.length); i++) {
      const d = depth[i];
      if (d.token_id !== tokenId) continue;
      if (d.bid_price !== null && d.bid_size !== null && d.bid_price >= price * 0.98) {
        total += d.bid_size;
      }
    }
    return total;
  }

  /* ─── Fair value fallback ────────────────────────────────────────── */

  private inferFairValue(snaps: Snapshot[], tokenId: string): FairValue | null {
    // Use the first few snapshots as fair value estimate
    const first5 = snaps.filter((s) => s.token_id === tokenId).slice(0, 5);
    if (first5.length === 0) return null;

    const avgBid = first5.reduce((a, s) => a + s.best_bid, 0) / first5.length;
    const avgAsk = first5.reduce((a, s) => a + s.best_ask, 0) / first5.length;
    return { fairBid: avgBid, fairAsk: avgAsk };
  }

  /* ─── Price search helpers ───────────────────────────────────────── */

  private findLatestBid(snaps: Snapshot[], idx: number, tokenId: string): number {
    for (let i = idx; i >= 0; i--) {
      if (snaps[i].token_id === tokenId) return snaps[i].best_bid;
    }
    return 0;
  }

  private findPriceHit(
    snaps: Snapshot[],
    startIdx: number,
    tokenId: string,
    price: number,
    windowSec: number,
  ): number | null {
    const startTs = snaps[startIdx].ts;
    const cutoff = startTs + windowSec * 1000;

    for (let i = startIdx; i < snaps.length; i++) {
      const s = snaps[i];
      if (s.ts > cutoff) break;
      if (s.token_id === tokenId && s.best_bid >= price) return i;
    }
    return null;
  }

  private std(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const varSum = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(varSum);
  }

  /* ─── Per-market stats ───────────────────────────────────────────── */

  private computeMarketStats(market: string, results: TradeResult[]): MarketStats {
    const pnls = results.map((r) => r.pnl);
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p <= 0);

    // Max drawdown
    let peak = 0;
    let cumulative = 0;
    let maxDD = 0;
    for (const p of pnls) {
      cumulative += p;
      if (cumulative > peak) peak = cumulative;
      const dd = peak - cumulative;
      if (dd > maxDD) maxDD = dd;
    }

    // Sharpe-like ratio (mean / std of per-trade pnl)
    const mean = pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
    const stdPnl = this.std(pnls);
    const sharpe = stdPnl > 0 ? mean / stdPnl : 0;

    return {
      market,
      trades: results.length,
      wins: wins.length,
      losses: losses.length,
      winRate: results.length > 0 ? wins.length / results.length : 0,
      totalPnl: pnls.reduce((a, b) => a + b, 0),
      avgWin: wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0,
      avgLoss: losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0,
      maxDrawdown: maxDD,
      sharpe,
    };
  }

  /* ─── Output ─────────────────────────────────────────────────────── */

  private printResults(allResults: TradeResult[], marketStats: MarketStats[]) {
    console.log("\n" + "═".repeat(100));
    console.log("  NHL SHOCK-FADE BACKTEST v2 — RESULTS");
    console.log("═".repeat(100));

    // Config summary
    console.log(`\n  Config: sigma=${this.cfg.sigma}, surprise_threshold=${this.cfg.surpriseThreshold}, ` +
      `ladder=${this.cfg.ladderLevels}×${(this.cfg.ladderStepPct * 100).toFixed(0)}%, ` +
      `windows: ladder=${this.cfg.ladderWindowSec}s fade=${this.cfg.fadeWindowSec}s, ` +
      `target_pair=${this.cfg.targetPair}, size=${this.cfg.tradeSize}`);

    if (allResults.length === 0) {
      console.log("\n  No trades triggered. Check sigma/surprise thresholds or record more data.\n");
      return;
    }

    // Per-market table
    console.log("\n  ┌─────────────────────────────────────────────┬───────┬──────┬──────┬────────┬──────────┬──────────┬──────────┬──────────┬────────┐");
    console.log("  │ Market                                      │ Trades│  Win │ Loss │ WinRate│ Total PnL│  Avg Win │ Avg Loss │  Max DD  │ Sharpe │");
    console.log("  ├─────────────────────────────────────────────┼───────┼──────┼──────┼────────┼──────────┼──────────┼──────────┼──────────┼────────┤");

    for (const ms of marketStats) {
      const mktName = ms.market.length > 43 ? ms.market.slice(0, 40) + "..." : ms.market;
      console.log(
        `  │ ${mktName.padEnd(43)} │ ${String(ms.trades).padStart(5)} │ ${String(ms.wins).padStart(4)} │ ${String(ms.losses).padStart(4)} │ ${(ms.winRate * 100).toFixed(1).padStart(5)}% │ ${ms.totalPnl.toFixed(4).padStart(8)} │ ${ms.avgWin.toFixed(4).padStart(8)} │ ${ms.avgLoss.toFixed(4).padStart(8)} │ ${ms.maxDrawdown.toFixed(4).padStart(8)} │ ${ms.sharpe.toFixed(2).padStart(6)} │`,
      );
    }

    console.log("  └─────────────────────────────────────────────┴───────┴──────┴──────┴────────┴──────────┴──────────┴──────────┴──────────┴────────┘");

    // Aggregate
    const aggStats = this.computeMarketStats("AGGREGATE", allResults);
    console.log(`\n  ── AGGREGATE ──`);
    console.log(`  Total trades:     ${aggStats.trades}`);
    console.log(`  Win / Loss:       ${aggStats.wins} / ${aggStats.losses}  (${(aggStats.winRate * 100).toFixed(1)}%)`);
    console.log(`  Total PnL:        ${aggStats.totalPnl.toFixed(4)} (per ${this.cfg.tradeSize} shares)`);
    console.log(`  Avg Win:          ${aggStats.avgWin.toFixed(4)}`);
    console.log(`  Avg Loss:         ${aggStats.avgLoss.toFixed(4)}`);
    console.log(`  Max Drawdown:     ${aggStats.maxDrawdown.toFixed(4)}`);
    console.log(`  Sharpe-like:      ${aggStats.sharpe.toFixed(3)}`);

    // Surprise distribution
    const scores = allResults.map((r) => r.surpriseScore);
    const avgSurprise = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(`\n  Surprise scores:  avg=${avgSurprise.toFixed(3)}, min=${Math.min(...scores).toFixed(3)}, max=${Math.max(...scores).toFixed(3)}`);

    // Sample trades
    console.log("\n  ── SAMPLE TRADES (first 10) ──");
    for (const r of allResults.slice(0, 10)) {
      const ts = new Date(r.shockTs).toISOString().slice(0, 19);
      const mkt = r.market.length > 30 ? r.market.slice(0, 27) + "..." : r.market;
      console.log(
        `  ${ts} │ ${mkt.padEnd(30)} │ ${r.impulse.padEnd(6)} │ s1=${r.sell1.toFixed(3)} s2=${r.sell2.toFixed(3)} │ pnl=${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(4)} │ surprise=${r.surpriseScore.toFixed(2)} │ depth=${r.depthAvailable.toFixed(0)}`,
      );
    }

    console.log("\n" + "═".repeat(100) + "\n");
  }
}
