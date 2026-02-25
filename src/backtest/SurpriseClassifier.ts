/**
 * SurpriseClassifier — scores how "surprising" a shock event is in game context.
 *
 * Higher surprise → better fade opportunity (market overreacts to unexpected events).
 * Lower surprise → market reaction is efficient, less fade edge.
 */

export interface FairValue {
  fairBid: number;
  fairAsk: number;
}

export interface GameState {
  /** Which team scored / caused the shock: "home" | "away" */
  scoringTeam: "home" | "away";
  /** Seconds remaining in the game (e.g. 3600 for start of NHL 3rd period) */
  timeRemainingSeconds: number;
  /** Total regulation seconds (NHL = 3600, NBA = 2880) */
  totalGameSeconds: number;
  /** Score differential BEFORE the event: home - away (positive = home leading) */
  scoreDifferential: number;
  /** Event type, e.g. "goal", "penalty" */
  eventType?: string;
}

export interface SurpriseResult {
  /** 0-1 surprise score (1 = maximum surprise) */
  score: number;
  /** Whether this shock is worth fading */
  shouldFade: boolean;
  /** Human-readable explanation */
  reason: string;
}

/**
 * Classify how surprising a shock event is.
 *
 * @param fairValue  Pre-game fair value for the token that just moved
 * @param shockPrice Post-shock price (best bid after the move)
 * @param gameState  Context about the game at time of shock
 * @param threshold  Minimum surprise score to recommend fading (default 0.4)
 */
export function classifySurprise(
  fairValue: FairValue,
  shockPrice: number,
  gameState: GameState,
  threshold: number = 0.4,
): SurpriseResult {
  const reasons: string[] = [];

  // ─── 1. Price Deviation Score (0-1) ────────────────────────────────
  // How far did the price move from fair value?
  const fairMid = (fairValue.fairBid + fairValue.fairAsk) / 2;
  const priceDeviation = Math.abs(shockPrice - fairMid);
  // Normalize: 0.05 deviation = ~0.25, 0.15 = ~0.75, 0.20+ = ~1.0
  const deviationScore = Math.min(1, priceDeviation / 0.20);
  reasons.push(`deviation=${(priceDeviation * 100).toFixed(1)}¢ (score=${deviationScore.toFixed(2)})`);

  // ─── 2. Underdog Factor (0-1) ─────────────────────────────────────
  // Did the underdog score? Underdog = team whose token had lower fair value
  // If the shock moved price DOWN, the scoring team was the opponent
  const priceDropped = shockPrice < fairMid;
  // Fair value > 0.5 means this token is the favorite
  const isFavoriteToken = fairMid > 0.5;

  let underdogScore: number;
  if (priceDropped && isFavoriteToken) {
    // Favorite's price dropped → underdog scored. High surprise.
    underdogScore = 0.7 + 0.3 * (fairMid - 0.5) / 0.5; // higher fav = more surprise
    reasons.push(`underdog scored vs favorite @${fairMid.toFixed(2)} (score=${underdogScore.toFixed(2)})`);
  } else if (!priceDropped && !isFavoriteToken) {
    // Underdog's price jumped → underdog is rallying
    underdogScore = 0.6 + 0.2 * (0.5 - fairMid) / 0.5;
    reasons.push(`underdog rallying @${fairMid.toFixed(2)} (score=${underdogScore.toFixed(2)})`);
  } else {
    // Favorite scored / extended lead — less surprising
    underdogScore = 0.2;
    reasons.push(`favorite action (score=${underdogScore.toFixed(2)})`);
  }

  // ─── 3. Game Time Factor (0-1) ────────────────────────────────────
  // Late-game events are more surprising (less time to recover)
  const fractionElapsed = 1 - gameState.timeRemainingSeconds / gameState.totalGameSeconds;
  const clampedElapsed = Math.max(0, Math.min(1, fractionElapsed));
  // Exponential: early game low, ramps up in final third
  const timeScore = Math.pow(clampedElapsed, 1.5);
  reasons.push(`game ${(clampedElapsed * 100).toFixed(0)}% elapsed (time_score=${timeScore.toFixed(2)})`);

  // ─── 4. Score Tightness (0-1) ─────────────────────────────────────
  // Tight games = more surprise. Blowouts = less.
  const absDiff = Math.abs(gameState.scoreDifferential);
  // 0 diff = 1.0, 1 diff = 0.7, 2 diff = 0.4, 3+ = 0.2
  const tightnessScore = Math.max(0.1, 1.0 - absDiff * 0.3);
  reasons.push(`scoreDiff=${gameState.scoreDifferential} (tightness=${tightnessScore.toFixed(2)})`);

  // ─── Composite Score ──────────────────────────────────────────────
  // Weighted combination
  const weights = {
    deviation: 0.30,
    underdog: 0.25,
    time: 0.25,
    tightness: 0.20,
  };

  const composite =
    weights.deviation * deviationScore +
    weights.underdog * underdogScore +
    weights.time * timeScore +
    weights.tightness * tightnessScore;

  const score = Math.max(0, Math.min(1, composite));
  const shouldFade = score >= threshold;

  return {
    score,
    shouldFade,
    reason: `surprise=${score.toFixed(3)} ${shouldFade ? "→ FADE" : "→ SKIP"}: ${reasons.join(", ")}`,
  };
}

/**
 * Estimate game state from basic info when Sportradar data isn't available.
 * Falls back to assuming midpoint and tied game.
 */
export function defaultGameState(totalGameSeconds: number = 3600): GameState {
  return {
    scoringTeam: "home",
    timeRemainingSeconds: totalGameSeconds / 2,
    totalGameSeconds,
    scoreDifferential: 0,
    eventType: "unknown",
  };
}
