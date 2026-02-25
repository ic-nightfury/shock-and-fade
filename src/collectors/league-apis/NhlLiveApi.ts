/**
 * NHL Live API Client
 *
 * Free, no-auth client for api-web.nhle.com.
 * Provides schedule, play-by-play, and live score data.
 *
 * Endpoints (unofficial but stable since 2023 migration):
 *   GET /v1/score/now                              — live scores
 *   GET /v1/schedule/{date}                        — schedule for a date
 *   GET /v1/gamecenter/{gameId}/play-by-play       — play-by-play events
 *   GET /v1/gamecenter/{gameId}/boxscore           — boxscore / score / clock
 *
 * Rate limit: 2s minimum between calls (polite usage).
 */

export interface NormalizedGameEvent {
  type: "goal" | "penalty" | "period_start" | "period_end" | "shootout" | "other";
  team: string;
  period: number | string;
  clock: string;
  description: string;
  timestamp: number; // epoch ms
  scorer?: string;
  strength?: string; // "even", "pp", "sh"
}

export interface NhlScheduleGame {
  id: number; // e.g. 2025020345
  season: number;
  gameType: number;
  gameDate: string; // "2026-02-06"
  startTimeUTC: string;
  awayTeam: { abbrev: string; commonName: { default: string }; score?: number };
  homeTeam: { abbrev: string; commonName: { default: string }; score?: number };
  gameState: string; // "LIVE", "FUT", "OFF", "FINAL", "CRIT"
  period?: number;
  clock?: { timeRemaining: string; running: boolean };
}

export interface NhlLiveScore {
  gameId: number;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  period: number;
  clock: string;
  gameState: string;
}

export class NhlLiveApi {
  private static BASE = "https://api-web.nhle.com";
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
      throw new Error(`NHL API ${res.status}: ${url}`);
    }
    return res.json() as Promise<T>;
  }

  /* ─── Schedule ──────────────────────────────────────────────────── */

  async getGamesByDate(date: string): Promise<NhlScheduleGame[]> {
    // date format: "2026-02-06"
    const data = await this.fetchJson<any>(
      `${NhlLiveApi.BASE}/v1/schedule/${date}`,
    );
    const games: NhlScheduleGame[] = [];
    const gameWeek = data?.gameWeek || [];
    for (const day of gameWeek) {
      if (day.date === date) {
        for (const g of day.games || []) {
          games.push({
            id: g.id,
            season: g.season,
            gameType: g.gameType,
            gameDate: day.date,
            startTimeUTC: g.startTimeUTC,
            awayTeam: g.awayTeam,
            homeTeam: g.homeTeam,
            gameState: g.gameState,
            period: g.periodDescriptor?.number,
            clock: g.clock,
          });
        }
      }
    }
    return games;
  }

  /* ─── Play-by-play ──────────────────────────────────────────────── */

  async getPlayByPlay(gameId: string | number): Promise<NormalizedGameEvent[]> {
    const data = await this.fetchJson<any>(
      `${NhlLiveApi.BASE}/v1/gamecenter/${gameId}/play-by-play`,
    );
    return this.parsePbp(data);
  }

  private parsePbp(data: any): NormalizedGameEvent[] {
    const events: NormalizedGameEvent[] = [];
    const plays: any[] = data?.plays || [];

    for (const play of plays) {
      const typeCode = (play.typeDescKey || "").toLowerCase();
      let type: NormalizedGameEvent["type"] = "other";

      if (typeCode === "goal") type = "goal";
      else if (typeCode === "penalty") type = "penalty";
      else if (typeCode === "period-start" || typeCode === "period_start") type = "period_start";
      else if (typeCode === "period-end" || typeCode === "period_end") type = "period_end";
      else if (typeCode.includes("shootout")) type = "shootout";
      else continue; // skip routine events

      const period = play.periodDescriptor?.number || play.period || "";
      const clock = play.timeRemaining || play.timeInPeriod || "";
      const ts = play.timeStamp ? new Date(play.timeStamp).getTime() : Date.now();

      // Team details
      const details = play.details || {};
      const teamAbbrev = details.eventOwnerTeamId
        ? this.resolveTeamFromId(data, details.eventOwnerTeamId)
        : "";

      // Scorer
      const scorer = details.scoringPlayerId
        ? this.resolvePlayerName(data, details.scoringPlayerId)
        : undefined;

      // Strength for goals
      let strength: string | undefined;
      if (type === "goal" && play.situationCode) {
        // situationCode: "1551" => home skaters/away skaters
        // We simplify: if not equal skaters, it's PP or SH
        const code = String(play.situationCode);
        if (code.length === 4) {
          const away = parseInt(code[0]);
          const home = parseInt(code[2]);
          if (away === home) strength = "even";
          else strength = away > home ? "pp-away" : "pp-home";
        }
      }

      const descParts: string[] = [];
      if (type === "goal") descParts.push(`Goal by ${scorer || "unknown"}`);
      else if (type === "penalty") descParts.push(details.descKey || "Penalty");
      else descParts.push(typeCode);

      events.push({
        type,
        team: teamAbbrev,
        period,
        clock,
        description: descParts.join(" "),
        timestamp: ts,
        scorer,
        strength,
      });
    }

    return events;
  }

  /* ─── Live score ────────────────────────────────────────────────── */

  async getLiveScore(gameId: string | number): Promise<NhlLiveScore | null> {
    try {
      const data = await this.fetchJson<any>(
        `${NhlLiveApi.BASE}/v1/gamecenter/${gameId}/boxscore`,
      );
      const homeTeam = data?.homeTeam || {};
      const awayTeam = data?.awayTeam || {};
      return {
        gameId: Number(gameId),
        homeTeam: homeTeam.commonName?.default || homeTeam.abbrev || "",
        awayTeam: awayTeam.commonName?.default || awayTeam.abbrev || "",
        homeScore: homeTeam.score ?? 0,
        awayScore: awayTeam.score ?? 0,
        period: data?.periodDescriptor?.number || 0,
        clock: data?.clock?.timeRemaining || "",
        gameState: data?.gameState || "UNKNOWN",
      };
    } catch (err) {
      console.error(`[NhlLiveApi] getLiveScore error for ${gameId}:`, err);
      return null;
    }
  }

  /* ─── Internal helpers ──────────────────────────────────────────── */

  private resolveTeamFromId(data: any, teamId: number): string {
    if (data?.homeTeam?.id === teamId) return data.homeTeam.abbrev || data.homeTeam.commonName?.default || "";
    if (data?.awayTeam?.id === teamId) return data.awayTeam.abbrev || data.awayTeam.commonName?.default || "";
    return String(teamId);
  }

  private resolvePlayerName(data: any, playerId: number): string {
    // Play-by-play response includes roster data inline
    const rosters = data?.rosterSpots || [];
    for (const p of rosters) {
      if (p.playerId === playerId) {
        return `${p.firstName?.default || ""} ${p.lastName?.default || ""}`.trim();
      }
    }
    return String(playerId);
  }
}
