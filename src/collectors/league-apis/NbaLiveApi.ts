/**
 * NBA Live API Client
 *
 * Free, no-auth client for cdn.nba.com/static/json/liveData/.
 * Provides scoreboard, play-by-play, and box score data.
 *
 * Endpoints (unofficial but widely used):
 *   cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json
 *   cdn.nba.com/static/json/liveData/playbyplay/playbyplay_{gameId}.json
 *   cdn.nba.com/static/json/liveData/boxscore/boxscore_{gameId}.json
 *
 * Rate limit: 2s minimum between calls (polite usage).
 */

import type { NormalizedGameEvent } from "./NhlLiveApi";
export type { NormalizedGameEvent };

export interface NbaScoreboardGame {
  gameId: string;
  gameStatus: number; // 1=pregame, 2=live, 3=final
  gameStatusText: string;
  homeTeam: {
    teamId: number;
    teamTricode: string;
    teamName: string;
    teamCity: string;
    score: number;
  };
  awayTeam: {
    teamId: number;
    teamTricode: string;
    teamName: string;
    teamCity: string;
    score: number;
  };
  period: number;
  gameClock: string;
  gameTimeUTC: string;
}

export interface NbaBoxScore {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  period: number;
  gameClock: string;
  gameStatus: number;
}

export class NbaLiveApi {
  private static CDN = "https://cdn.nba.com/static/json/liveData";
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
    const res = await fetch(url, {
      headers: {
        // NBA CDN sometimes requires these
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
    });
    if (!res.ok) {
      throw new Error(`NBA API ${res.status}: ${url}`);
    }
    return res.json() as Promise<T>;
  }

  /* ─── Scoreboard ────────────────────────────────────────────────── */

  async getTodaysScoreboard(): Promise<NbaScoreboardGame[]> {
    const data = await this.fetchJson<any>(
      `${NbaLiveApi.CDN}/scoreboard/todaysScoreboard_00.json`,
    );
    const games: NbaScoreboardGame[] = [];
    const scoreboardGames = data?.scoreboard?.games || [];

    for (const g of scoreboardGames) {
      games.push({
        gameId: g.gameId,
        gameStatus: g.gameStatus,
        gameStatusText: g.gameStatusText || "",
        homeTeam: {
          teamId: g.homeTeam?.teamId || 0,
          teamTricode: g.homeTeam?.teamTricode || "",
          teamName: g.homeTeam?.teamName || "",
          teamCity: g.homeTeam?.teamCity || "",
          score: g.homeTeam?.score || 0,
        },
        awayTeam: {
          teamId: g.awayTeam?.teamId || 0,
          teamTricode: g.awayTeam?.teamTricode || "",
          teamName: g.awayTeam?.teamName || "",
          teamCity: g.awayTeam?.teamCity || "",
          score: g.awayTeam?.score || 0,
        },
        period: g.period || 0,
        gameClock: g.gameClock || "",
        gameTimeUTC: g.gameTimeUTC || "",
      });
    }
    return games;
  }

  /* ─── Play-by-play ──────────────────────────────────────────────── */

  async getPlayByPlay(gameId: string): Promise<NormalizedGameEvent[]> {
    const data = await this.fetchJson<any>(
      `${NbaLiveApi.CDN}/playbyplay/playbyplay_${gameId}.json`,
    );
    return this.parsePbp(data);
  }

  private parsePbp(data: any): NormalizedGameEvent[] {
    const events: NormalizedGameEvent[] = [];
    const actions: any[] = data?.game?.actions || [];

    for (const action of actions) {
      const actionType = (action.actionType || "").toLowerCase();
      let type: NormalizedGameEvent["type"] = "other";

      // Filter for significant scoring events
      if (actionType === "2pt" || actionType === "3pt" || actionType === "freethrow") {
        // Only count made shots
        if (!action.shotResult || action.shotResult.toLowerCase() !== "made") continue;
        type = "goal"; // reuse "goal" for scoring events
      } else if (actionType === "foul" || actionType === "violation") {
        type = "penalty";
      } else if (actionType === "period" && action.subType?.toLowerCase() === "start") {
        type = "period_start";
      } else if (actionType === "period" && action.subType?.toLowerCase() === "end") {
        type = "period_end";
      } else {
        continue; // skip routine events
      }

      const period = action.period || 0;
      const clock = action.clock || "";
      const ts = action.timeActual ? new Date(action.timeActual).getTime() : Date.now();
      const team = action.teamTricode || "";
      const scorer = action.playerNameI || undefined;

      const descParts: string[] = [];
      if (type === "goal") {
        const pts = actionType === "3pt" ? "3PT" : actionType === "freethrow" ? "FT" : "2PT";
        descParts.push(`${pts} by ${scorer || "unknown"}`);
      } else if (type === "penalty") {
        descParts.push(action.description || actionType);
      } else {
        descParts.push(action.description || actionType);
      }

      events.push({
        type,
        team,
        period,
        clock,
        description: descParts.join(" "),
        timestamp: ts,
        scorer,
      });
    }

    return events;
  }

  /* ─── Box score ─────────────────────────────────────────────────── */

  async getBoxScore(gameId: string): Promise<NbaBoxScore | null> {
    try {
      const data = await this.fetchJson<any>(
        `${NbaLiveApi.CDN}/boxscore/boxscore_${gameId}.json`,
      );
      const game = data?.game || {};
      return {
        gameId,
        homeTeam: game.homeTeam?.teamName || game.homeTeam?.teamTricode || "",
        awayTeam: game.awayTeam?.teamName || game.awayTeam?.teamTricode || "",
        homeScore: game.homeTeam?.score || 0,
        awayScore: game.awayTeam?.score || 0,
        period: game.period || 0,
        gameClock: game.gameClock || "",
        gameStatus: game.gameStatus || 0,
      };
    } catch (err) {
      console.error(`[NbaLiveApi] getBoxScore error for ${gameId}:`, err);
      return null;
    }
  }
}
