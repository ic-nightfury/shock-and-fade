/**
 * MLB Live API Client
 *
 * Free, no-auth client for statsapi.mlb.com.
 * Provides schedule, play-by-play, and live score data.
 *
 * Endpoints (official MLB Stats API — free, no key required):
 *   GET /api/v1/schedule?date=YYYY-MM-DD&sportId=1
 *   GET /api/v1.1/game/{gamePk}/feed/live
 *
 * Rate limit: 2s minimum between calls (polite usage).
 */

import type { NormalizedGameEvent } from "./NhlLiveApi";
export type { NormalizedGameEvent };

export interface MlbScheduleGame {
  gamePk: number;
  gameDate: string; // ISO datetime
  status: {
    abstractGameState: string; // "Preview", "Live", "Final"
    detailedState: string; // "Scheduled", "In Progress", "Final", etc.
    codedGameState: string; // "S", "I", "F"
  };
  teams: {
    away: { team: { id: number; name: string }; score?: number };
    home: { team: { id: number; name: string }; score?: number };
  };
  venue: { name: string };
}

export interface MlbLiveScore {
  gamePk: number;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  inning: number;
  halfInning: string; // "top" | "bottom"
  gameState: string;
  outs: number;
}

export class MlbLiveApi {
  private static BASE = "https://statsapi.mlb.com";
  private lastCallTs = 0;
  private minGapMs: number;

  constructor(minGapMs = 2000) {
    this.minGapMs = minGapMs;
  }

  /* ─── Rate limiter ──────────────────────────────────────────────── */

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastCallTs;
    if (elapsed < this.minGapMs) {
      await new Promise((r) => setTimeout(r, this.minGapMs - elapsed));
    }
    this.lastCallTs = Date.now();
  }

  private async fetchJson<T>(url: string): Promise<T> {
    await this.rateLimit();
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`MLB API ${res.status}: ${url}`);
    }
    return res.json() as Promise<T>;
  }

  /* ─── Schedule ──────────────────────────────────────────────────── */

  async getGamesByDate(date: string): Promise<MlbScheduleGame[]> {
    // date format: "2026-02-06"
    const data = await this.fetchJson<any>(
      `${MlbLiveApi.BASE}/api/v1/schedule?date=${date}&sportId=1&hydrate=team`,
    );
    const games: MlbScheduleGame[] = [];
    const dates = data?.dates || [];

    for (const d of dates) {
      for (const g of d.games || []) {
        games.push({
          gamePk: g.gamePk,
          gameDate: g.gameDate,
          status: {
            abstractGameState: g.status?.abstractGameState || "",
            detailedState: g.status?.detailedState || "",
            codedGameState: g.status?.codedGameState || "",
          },
          teams: {
            away: {
              team: {
                id: g.teams?.away?.team?.id || 0,
                name: g.teams?.away?.team?.name || "",
              },
              score: g.teams?.away?.score,
            },
            home: {
              team: {
                id: g.teams?.home?.team?.id || 0,
                name: g.teams?.home?.team?.name || "",
              },
              score: g.teams?.home?.score,
            },
          },
          venue: { name: g.venue?.name || "" },
        });
      }
    }
    return games;
  }

  /* ─── Play-by-play (live feed) ──────────────────────────────────── */

  async getPlayByPlay(gamePk: number): Promise<NormalizedGameEvent[]> {
    const data = await this.fetchJson<any>(
      `${MlbLiveApi.BASE}/api/v1.1/game/${gamePk}/feed/live`,
    );
    return this.parsePbp(data);
  }

  private parsePbp(data: any): NormalizedGameEvent[] {
    const events: NormalizedGameEvent[] = [];
    const allPlays: any[] = data?.liveData?.plays?.allPlays || [];

    for (const play of allPlays) {
      const resultType = (play.result?.type || "").toLowerCase();
      const resultEvent = (play.result?.event || "").toLowerCase();
      const resultDesc = play.result?.description || "";

      let type: NormalizedGameEvent["type"] = "other";

      // Scoring events
      if (resultEvent.includes("home run") || resultEvent.includes("homer")) {
        type = "goal";
      } else if (resultEvent.includes("single") || resultEvent.includes("double") ||
                 resultEvent.includes("triple") || resultEvent.includes("sac fly") ||
                 resultEvent.includes("grounded into")) {
        // Check if runs scored
        const runners = play.runners || [];
        const scored = runners.some((r: any) => r.movement?.end === "score");
        if (scored) {
          type = "goal";
        } else {
          continue;
        }
      } else if (resultEvent.includes("walk") && play.runners?.some((r: any) => r.movement?.end === "score")) {
        type = "goal"; // bases-loaded walk scores a run
      } else if (resultEvent.includes("error") && play.runners?.some((r: any) => r.movement?.end === "score")) {
        type = "goal"; // run scored on error
      } else if (resultType === "atbat" && !play.runners?.some((r: any) => r.movement?.end === "score")) {
        continue; // at-bat with no scoring — skip
      } else {
        continue; // skip non-scoring, non-significant events
      }

      const about = play.about || {};
      const inning = about.inning || 0;
      const halfInning = about.halfInning || "";
      const period = `${halfInning === "top" ? "T" : "B"}${inning}`;

      // Use endTime or startTime for timestamp
      const ts = about.endTime ? new Date(about.endTime).getTime() :
                 about.startTime ? new Date(about.startTime).getTime() : Date.now();

      // Team (batting team)
      const team = play.matchup?.batSide?.description
        ? ""
        : (halfInning === "top"
          ? data?.gameData?.teams?.away?.abbreviation || data?.gameData?.teams?.away?.name || ""
          : data?.gameData?.teams?.home?.abbreviation || data?.gameData?.teams?.home?.name || "");

      const scorer = play.matchup?.batter?.fullName || undefined;

      // Count runs scored in this play
      const runsScored = (play.runners || []).filter(
        (r: any) => r.movement?.end === "score",
      ).length;

      events.push({
        type,
        team,
        period,
        clock: `${runsScored}R`,
        description: resultDesc.slice(0, 200),
        timestamp: ts,
        scorer,
      });
    }

    return events;
  }

  /* ─── Live score ────────────────────────────────────────────────── */

  async getLiveScore(gamePk: number): Promise<MlbLiveScore | null> {
    try {
      const data = await this.fetchJson<any>(
        `${MlbLiveApi.BASE}/api/v1.1/game/${gamePk}/feed/live`,
      );
      const gameData = data?.gameData || {};
      const liveData = data?.liveData || {};
      const linescore = liveData?.linescore || {};

      return {
        gamePk,
        homeTeam: gameData?.teams?.home?.name || "",
        awayTeam: gameData?.teams?.away?.name || "",
        homeScore: linescore?.teams?.home?.runs ?? 0,
        awayScore: linescore?.teams?.away?.runs ?? 0,
        inning: linescore?.currentInning || 0,
        halfInning: linescore?.inningHalf || "",
        gameState: gameData?.status?.abstractGameState || "",
        outs: linescore?.outs || 0,
      };
    } catch (err) {
      console.error(`[MlbLiveApi] getLiveScore error for ${gamePk}:`, err);
      return null;
    }
  }
}
