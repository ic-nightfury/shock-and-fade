/**
 * Free NFL Live API client
 * Uses ESPN public API (site.api.espn.com) — no auth required
 * ESPN has the best free NFL coverage (better than nfl.com hidden APIs)
 */

export type NormalizedEvent = {
  type: string;
  team: string;
  period: string;
  clock: string;
  description: string;
  timestamp: number;
};

export type NflGame = {
  id: string;
  homeTeam: string;
  awayTeam: string;
  homeAbbrev: string;
  awayAbbrev: string;
  homeScore: number;
  awayScore: number;
  status: string;
  period: number;
  clock: string;
  startTimeUTC: string;
};

const MIN_INTERVAL_MS = 2000;
let lastCallTs = 0;

async function rateLimitedFetch(url: string): Promise<any> {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastCallTs));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallTs = Date.now();

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`NFL API ${resp.status}: ${url}`);
  return resp.json();
}

export class NflLiveApi {
  private baseUrl = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

  async getTodaysGames(): Promise<NflGame[]> {
    const data = await rateLimitedFetch(`${this.baseUrl}/scoreboard`);
    const events = data.events || [];

    return events.map((e: any) => {
      const comp = e.competitions?.[0] || {};
      const home = comp.competitors?.find((c: any) => c.homeAway === "home") || {};
      const away = comp.competitors?.find((c: any) => c.homeAway === "away") || {};
      const status = e.status || {};

      return {
        id: e.id,
        homeTeam: home.team?.displayName || "",
        awayTeam: away.team?.displayName || "",
        homeAbbrev: home.team?.abbreviation || "",
        awayAbbrev: away.team?.abbreviation || "",
        homeScore: parseInt(home.score || "0", 10),
        awayScore: parseInt(away.score || "0", 10),
        status: status.type?.description || "",
        period: status.period || 0,
        clock: status.displayClock || "",
        startTimeUTC: e.date || "",
      };
    });
  }

  async getPlayByPlay(gameId: string): Promise<NormalizedEvent[]> {
    const data = await rateLimitedFetch(`${this.baseUrl}/summary?event=${gameId}`);
    const events: NormalizedEvent[] = [];

    // ESPN play-by-play from drives/plays
    const drives = data.drives?.previous || [];
    for (const drive of drives) {
      const plays = drive.plays || [];
      for (const play of plays) {
        if (!play.scoringPlay && !play.type?.text?.match(/touchdown|field goal|safety|interception|fumble/i)) {
          continue; // Only capture scoring + turnovers (high-impact events)
        }

        events.push({
          type: this.classifyPlay(play),
          team: play.team?.abbreviation || drive.team?.abbreviation || "",
          period: `Q${play.period?.number || "?"}`,
          clock: play.clock?.displayValue || "",
          description: play.text || play.type?.text || "",
          timestamp: play.wallclock ? new Date(play.wallclock).getTime() : Date.now(),
        });
      }
    }

    return events;
  }

  async getLiveScore(gameId: string): Promise<{ home: number; away: number; period: number; clock: string } | null> {
    const games = await this.getTodaysGames();
    const game = games.find((g) => g.id === gameId);
    if (!game) return null;

    return {
      home: game.homeScore,
      away: game.awayScore,
      period: game.period,
      clock: game.clock,
    };
  }

  private classifyPlay(play: any): string {
    const text = (play.text || play.type?.text || "").toLowerCase();
    if (text.includes("touchdown")) return "touchdown";
    if (text.includes("field goal")) return "field_goal";
    if (text.includes("safety")) return "safety";
    if (text.includes("interception")) return "interception";
    if (text.includes("fumble")) return "fumble";
    if (play.scoringPlay) return "scoring_play";
    return "play";
  }
}
