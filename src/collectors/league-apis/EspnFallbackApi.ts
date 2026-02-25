/**
 * ESPN Fallback API Client
 *
 * Free, no-auth client for site.api.espn.com.
 * Lightweight fallback for live scores when league APIs fail.
 *
 * Endpoints (hidden but widely documented):
 *   GET /apis/site/v2/sports/{sport}/{league}/scoreboard
 *
 * Rate limit: 2s minimum between calls (polite usage).
 */

export interface EspnScoreboardGame {
  id: string;
  name: string; // "Team A at Team B"
  shortName: string;
  status: {
    type: { state: string; completed: boolean; description: string }; // state: "pre", "in", "post"
    period: number;
    clock: string;
    displayClock: string;
  };
  homeTeam: {
    id: string;
    abbreviation: string;
    displayName: string;
    shortDisplayName: string;
    score: string;
  };
  awayTeam: {
    id: string;
    abbreviation: string;
    displayName: string;
    shortDisplayName: string;
    score: string;
  };
}

type SportKey = "nhl" | "nba" | "mlb" | "nfl" | "cbb";

const SPORT_MAP: Record<SportKey, { sport: string; league: string }> = {
  nhl: { sport: "hockey", league: "nhl" },
  nba: { sport: "basketball", league: "nba" },
  mlb: { sport: "baseball", league: "mlb" },
  nfl: { sport: "football", league: "nfl" },
  cbb: { sport: "basketball", league: "mens-college-basketball" },
};

export class EspnFallbackApi {
  private static BASE = "https://site.api.espn.com";
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
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
    });
    if (!res.ok) {
      throw new Error(`ESPN API ${res.status}: ${url}`);
    }
    return res.json() as Promise<T>;
  }

  /* ─── Scoreboard ────────────────────────────────────────────────── */

  async getScoreboard(sport: SportKey): Promise<EspnScoreboardGame[]> {
    const { sport: sportPath, league } = SPORT_MAP[sport];
    // Build query params
    const params = new URLSearchParams();
    if (sport === "cbb") {
      params.set("groups", "50"); // All conferences, not just top-25
      params.set("limit", "200");
    }
    // Always include today's date to get scheduled (not-yet-started) games
    const now = new Date();
    const dateStr = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
    params.set("dates", dateStr);

    const qs = params.toString();
    const data = await this.fetchJson<any>(
      `${EspnFallbackApi.BASE}/apis/site/v2/sports/${sportPath}/${league}/scoreboard?${qs}`,
    );

    const games: EspnScoreboardGame[] = [];
    const events = data?.events || [];

    for (const event of events) {
      const competition = event.competitions?.[0];
      if (!competition) continue;

      const competitors = competition.competitors || [];
      const home = competitors.find((c: any) => c.homeAway === "home");
      const away = competitors.find((c: any) => c.homeAway === "away");

      if (!home || !away) continue;

      const status = event.status || {};
      const statusType = status.type || {};

      games.push({
        id: event.id || "",
        name: event.name || "",
        shortName: event.shortName || "",
        status: {
          type: {
            state: statusType.state || "",
            completed: statusType.completed || false,
            description: statusType.description || "",
          },
          period: status.period || 0,
          clock: status.clock || "0",
          displayClock: status.displayClock || "",
        },
        homeTeam: {
          id: home.id || "",
          abbreviation: home.team?.abbreviation || "",
          displayName: home.team?.displayName || "",
          shortDisplayName: home.team?.shortDisplayName || "",
          score: home.score || "0",
        },
        awayTeam: {
          id: away.id || "",
          abbreviation: away.team?.abbreviation || "",
          displayName: away.team?.displayName || "",
          shortDisplayName: away.team?.shortDisplayName || "",
          score: away.score || "0",
        },
      });
    }

    return games;
  }

  /* ─── Play-by-Play (for CBB and other ESPN-only sports) ──────── */

  /**
   * Fetch play-by-play from ESPN for a given sport and game ID.
   * Returns normalized game events compatible with NormalizedGameEvent.
   * ESPN PBP endpoint: /apis/site/v2/sports/{sport}/{league}/summary?event={gameId}
   */
  async getPlayByPlay(
    sport: SportKey,
    gameId: string,
  ): Promise<{
    type: "goal" | "penalty" | "period_start" | "period_end" | "shootout" | "other";
    team: string;
    period: number | string;
    clock: string;
    description: string;
    timestamp: number;
    scorer?: string;
  }[]> {
    const { sport: sportPath, league } = SPORT_MAP[sport];
    const data = await this.fetchJson<any>(
      `${EspnFallbackApi.BASE}/apis/site/v2/sports/${sportPath}/${league}/summary?event=${gameId}`,
    );

    const events: {
      type: "goal" | "penalty" | "period_start" | "period_end" | "shootout" | "other";
      team: string;
      period: number | string;
      clock: string;
      description: string;
      timestamp: number;
      scorer?: string;
    }[] = [];

    // Build team ID → abbreviation lookup from boxscore (CBB plays lack displayName)
    const teamMap = new Map<string, string>();
    const boxTeams = data?.boxscore?.teams || [];
    for (const t of boxTeams) {
      const bTeam = t?.team;
      if (bTeam?.id && (bTeam?.abbreviation || bTeam?.displayName)) {
        teamMap.set(String(bTeam.id), bTeam.abbreviation || bTeam.shortDisplayName || bTeam.displayName || "");
      }
    }

    // ESPN summary has "plays" array for basketball
    const plays = data?.plays || [];
    for (const play of plays) {
      if (!play) continue;

      const isScoring = play.scoringPlay === true || play.scoreValue > 0;
      const teamId = String(play.team?.id || "");
      const team = play.team?.displayName || play.team?.abbreviation || teamMap.get(teamId) || "";
      const period = play.period?.number || 0;
      const clock = play.clock?.displayValue || "";
      const text = play.text || play.description || "";
      const ts = play.wallclock ? new Date(play.wallclock).getTime() : Date.now();

      if (isScoring) {
        events.push({
          type: "goal",
          team,
          period,
          clock,
          description: text,
          timestamp: ts,
          scorer: play.participants?.[0]?.athlete?.displayName,
        });
      }
    }

    return events;
  }
}
