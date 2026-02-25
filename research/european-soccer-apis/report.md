# European Soccer Live Data Sources — Research Report

**Date:** 2026-02-07  
**Objective:** Find primary, free, real-time data sources for European soccer live scores and goal events — optimized for shock-fade trading on Polymarket.

---

## Executive Summary

Unlike the NBA (cdn.nba.com) and NHL (api-web.nhle.com) where official league CDNs serve unauthenticated JSON, **European soccer has no single equivalent**. The data supply chain is fragmented:

- **Opta** (owned by Stats Perform) is the upstream data provider for the Premier League, La Liga, Serie A, UCL, and most European leagues
- Official league websites use intermediary API services (PulseLive for EPL, UEFA's own comp API for UCL)
- **ESPN's scoreboard API** is the best universal free source — covers ALL six target leagues with goal events, ~10s cache, no auth required
- **FotMob** has the richest match detail but 40s+ cache for league data and 300s for individual matches
- **PulseLive** (EPL's official API) works unauthenticated but has 30s cache — 3x slower than ESPN

### 🏆 Recommendation: **ESPN API as primary source for ALL European soccer leagues**

ESPN provides the best latency-to-coverage ratio: 10-second CDN cache, goal events with scorer/minute in the scoreboard response, all six leagues via one API pattern, zero auth required.

---

## Detailed Source Analysis

### 1. ESPN Scoreboard API ⭐ RECOMMENDED PRIMARY

**Endpoint Pattern:**
```
https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/scoreboard
```

**League Slugs:**
| League | Slug | Polymarket Volume |
|--------|------|-------------------|
| Premier League | `eng.1` | $219M |
| UEFA Champions League | `uefa.champions` | $208M |
| La Liga | `esp.1` | $78M |
| Bundesliga | `ger.1` | $2.5M |
| Serie A | `ita.1` | $2.4M |
| Ligue 1 | `fra.1` | $1M |

**Cache Behavior:**
All leagues use a **10-second CDN cache cycle**. The `max-age` header counts down from ~10 to 0, then resets:
```
10:30:17 max-age=1   (about to refresh)
10:30:18 max-age=9   (just refreshed)
10:30:19 max-age=8
...
10:30:26 max-age=1   (about to refresh again)
```

**Tested cache-control values (single-request snapshots, varies due to countdown):**
- `eng.1`: 2-10s (10s cycle)
- `uefa.champions`: 2-10s (10s cycle)  
- `esp.1`: 2-10s (10s cycle)
- `ger.1`: 2-10s (10s cycle)
- `ita.1`: 2-10s (10s cycle)
- `fra.1`: 2-10s (10s cycle)

**Auth:** None required. `access-control-allow-origin: *`

**Rate Limits:** No known limits. No API key needed.

**Goal Events in Scoreboard Response:**
```json
{
  "events": [{
    "name": "Fulham at Manchester United",
    "competitions": [{
      "details": [
        {
          "type": {"id": "70", "text": "Goal"},
          "clock": {"displayValue": "56'"},
          "athletesInvolved": [{"displayName": "Matheus Cunha"}],
          "team": {"displayName": "Manchester United"},
          "scoringPlay": true
        },
        {
          "type": {"text": "Yellow Card"},
          "clock": {"displayValue": "35'"},
          "athletesInvolved": [{"displayName": "Kristoffer Ajer"}]
        },
        {
          "type": {"text": "Red Card"},
          "clock": {"displayValue": "42'"},
          "athletesInvolved": [{"displayName": "Kevin Schade"}]
        }
      ],
      "competitors": [
        {"team": {"displayName": "Manchester United"}, "score": "3"},
        {"team": {"displayName": "Fulham"}, "score": "0"}
      ],
      "status": {
        "type": {"state": "in", "description": "Second Half"},
        "clock": 67.0,
        "displayClock": "67'"
      }
    }]
  }]
}
```

**Event Detail Endpoint (for deeper data):**
```
https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/summary?event={eventId}
```
- Returns `keyEvents` array with full goal descriptions, penalty info, etc.
- Cache: 10s (same as scoreboard)
- Includes: xG data, formations, commentary, play-by-play

**Response Time:** 40-80ms from Frankfurt

**Verdict:** ✅ Best option. Same 10s cache as our NBA source, covers all 6 leagues, includes goal events with scorer/minute/team directly in scoreboard. One client handles everything.

---

### 2. PulseLive / footballapi.pulselive.com (EPL Official)

**Base URL:** `https://footballapi.pulselive.com/football/`

**Key Endpoints:**
```
# Live fixtures
/fixtures?comps=1&compSeasons=719&statuses=L&altIds=true

# Completed fixtures (recent)
/fixtures?comps=1&compSeasons=719&statuses=C&sort=desc&pageSize=5

# Match stats
/stats/match/{matchId}
```

**Season IDs:** `719` = 2024/25 EPL season

**Cache:** `max-age=30` (30 seconds — 3x slower than ESPN)

**Auth:** None required for basic endpoints. `Origin: https://www.premierleague.com` header may be needed for some endpoints.

**Goal Data Format:**
```json
{
  "goals": [
    {
      "personId": 25474,
      "assistId": 67546,
      "clock": {
        "secs": 4440,
        "label": "74'00"
      },
      "phase": "2",
      "type": "G",
      "description": "G"
    }
  ]
}
```

**Notes:**
- Goal events include `personId` (not name) — requires lookup
- Only covers EPL (comp ID 1)
- 30s cache makes it slower than ESPN for our use case
- No known rate limits, but CloudFront-backed

**Verdict:** ⚠️ Useful as EPL backup. 30s cache is too slow for primary shock detection.

---

### 3. UEFA Match API (Champions League Official)

**Base URL:** `https://match.uefa.com/v5/`

**Key Endpoints:**
```
# Competitions list
https://comp.uefa.com/v2/competitions

# Matches (with filters)
https://match.uefa.com/v5/matches?competitionId=1&seasonYear=2025&status=LIVE&offset=0&limit=10

# Single match detail
https://match.uefa.com/v5/matches/{matchId}
```

**Competition IDs:** `1` = Champions League

**Cache:** 
- `max-age=1175, s-maxage=587` (~10-20 minutes!) when no live matches
- Likely reduces during live matches, but NOT confirmed (no live UCL games during testing)

**Auth:** None required for basic access. CORS restricted to `https://www.uefa.com`

**Goal Data:**
```json
{
  "playerEvents": {
    "scorers": [
      {
        "goalType": "SCORED",
        "phase": "FIRST_HALF",
        "player": {
          "clubShirtName": "HAKIMI",
          "internationalName": "Achraf Hakimi"
        }
      }
    ]
  },
  "score": {
    "regular": {"home": 5, "away": 0}
  }
}
```

**Notes:**
- ❌ **No minute data** for goals in the API response (major gap!)
- 10-20 minute cache is far too slow for live trading
- Only covers UEFA competitions
- Rich metadata but latency is unusable for shock detection

**Verdict:** ❌ Not suitable. Too slow, no goal minute, limited scope.

---

### 4. FotMob API

**Base URL:** `https://www.fotmob.com/api/`

**Key Endpoints:**
```
# Match details
/matchDetails?matchId={matchId}

# League data
/leagues?id={leagueId}
```

**League IDs:** `47` = EPL, `42` = UCL, `87` = La Liga, `54` = Bundesliga, `55` = Serie A, `53` = Ligue 1

**Cache:**
- League data: `max-age=40, s-maxage=40` (40 seconds)
- Match details: `max-age=300, s-maxage=300` (5 minutes!)
- Stale-while-revalidate: 13-100s

**Auth:** None required.

**Goal Data (extremely rich):**
```json
{
  "header": {
    "events": {
      "homeTeamGoals": {
        "Ødegaard": [{
          "type": "Goal",
          "time": 28,
          "player": {"name": "Martin Ødegaard"},
          "homeScore": 0,
          "awayScore": 1,
          "newScore": [1, 1],
          "shotmapEvent": {
            "expectedGoals": 0.17,
            "shotType": "LeftFoot",
            "situation": "RegularPlay"
          }
        }]
      }
    }
  }
}
```

**Notes:**
- Richest data of any free source (xG, shot maps, formations)
- 5-minute cache on match details is far too slow
- CloudFront CDN with anti-bot protection (returns HTML instead of JSON for some endpoints without proper headers)
- Would require knowing match IDs in advance

**Verdict:** ⚠️ Excellent for pre-game research. Too slow for real-time shock detection.

---

### 5. OpenLigaDB (Bundesliga Only)

**Base URL:** `https://api.openligadb.de/`

**Key Endpoints:**
```
# Match data by matchday
/getmatchdata/bl1/2025/{matchday}

# Current matches
/getmatchdata/bl1
```

**Cache:** No cache-control headers (server: IIS/ASP.NET). Likely real-time or near-real-time.

**Auth:** None required. Fully open API.

**Goal Data:**
```json
{
  "goals": [
    {
      "goalGetterName": "M. Svanberg",
      "matchMinute": 66,
      "scoreTeam1": 1,
      "scoreTeam2": 2,
      "isPenalty": false,
      "isOwnGoal": false
    }
  ]
}
```

**Notes:**
- Only covers Bundesliga (and lower German leagues)
- Clean, simple API with goal scorer names and minutes
- No documented rate limits
- Community-maintained — reliability unknown for live updates
- Response time: 60-90ms

**Verdict:** ⚠️ Good Bundesliga backup. Unknown live update frequency. Only covers one league.

---

### 6. Fantasy Premier League API (EPL Only)

**Base URL:** `https://fantasy.premierleague.com/api/`

**Key Endpoints:**
```
# Live gameweek player data
/event/{gameweek}/live/

# Fixtures with goal events
/fixtures/?event={gameweek}

# Bootstrap (season data)
/bootstrap-static/
```

**Cache:** 
- `cache-control: no-cache, no-store` but `edge-control: max-age=300`
- Effectively 5-minute edge cache

**Goal Data (in fixtures):**
```json
{
  "stats": [{
    "identifier": "goals_scored",
    "h": [{"element": 342, "value": 1}],
    "a": [{"element": 805, "value": 1}]
  }]
}
```

**Notes:**
- Only EPL
- Uses player element IDs (requires bootstrap lookup for names)
- 5-minute effective cache — too slow
- Live endpoint exists but update frequency during matches is ~60s

**Verdict:** ❌ Too slow for trading. Only EPL.

---

## Cache Comparison Summary

| Source | Cache (seconds) | Scope | Goal Events? | Auth? |
|--------|----------------|-------|-------------|-------|
| **ESPN** | **~10** | **All 6 leagues** | **✅ Yes (scorer + minute)** | **None** |
| PulseLive | 30 | EPL only | ✅ Yes (ID only) | None |
| FotMob | 40-300 | All leagues | ✅ Yes (rich) | None |
| OpenLigaDB | Unknown | Bundesliga | ✅ Yes | None |
| UEFA | 600-1200 | UCL only | ⚠️ No minutes | None |
| FPL | ~300 | EPL only | ⚠️ IDs only | None |
| football-data.org | 60+ | Most leagues | ✅ Yes | API key |

---

## Architecture Recommendation

### Primary: ESPN Scoreboard API (ALL leagues)

```
Poll interval: 5 seconds
Effective new data: every ~10 seconds (CDN cache cycle)
Endpoint: https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/scoreboard
```

**Why ESPN over league-specific APIs:**
1. **10s cache** — matches our NBA latency budget
2. **One client pattern** for all 6 leagues — minimal code, maximum coverage
3. **Goal events in scoreboard** — no need for secondary match detail calls
4. **Includes scorer name and minute** — directly usable for shock detection
5. **No auth, no rate limits, CORS open** (`access-control-allow-origin: *`)
6. **Same infrastructure we already use for NBA/NHL** — proven reliability

### Secondary: ESPN Summary (per-match detail)

```
Endpoint: https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/summary?event={eventId}
```

- For `keyEvents` array with full goal descriptions
- Same 10s cache
- Use when scoreboard goal event is detected — get richer context

### Backup: PulseLive (EPL only)

```
Endpoint: https://footballapi.pulselive.com/football/fixtures?comps=1&compSeasons=719&statuses=L
```

- 30s cache is suboptimal but works as backup
- Useful for EPL-specific validation

---

## Implementation Plan

### Phase 1: ESPN Soccer Client (covers all 6 leagues)
- Same polling architecture as NBA/NHL ESPN clients
- Monitor `competitions[].details[]` for type `"Goal"`
- Track `competitions[].status.type.state` for match state (`pre`/`in`/`post`)
- Poll each league every 5 seconds during match windows
- **Total API calls during a typical Saturday with all leagues**: ~4,320/hour (6 leagues × 720 polls/hour)

### Phase 2: Event Detection Logic
- **Goal detected** = new entry in `details[]` with `type.text === "Goal"`
- **Red card detected** = new entry with `type.text === "Red Card"`
- **Penalty detected** = new entry with `type.text === "Penalty - Scored"` or `"Penalty - Saved"`
- Compare current `details[]` array with previous poll to detect new events

### Phase 3: Match Schedule Awareness
- Use ESPN calendar to know when matches are scheduled
- Only poll during active match windows (save ~90% of API calls)
- EPL: Sat 12:30-17:00 UTC, Sun 14:00-16:30 UTC (typical)
- UCL: Tue/Wed 17:45-21:00 UTC
- La Liga: Sat-Sun 12:00-21:00 UTC
- Bundesliga: Sat 14:30-17:30 UTC
- Serie A: Sat-Sun 11:30-19:45 UTC
- Ligue 1: Sat-Sun 13:00-20:45 UTC

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| ESPN changes API/caching | PulseLive backup for EPL; FotMob for other leagues |
| ESPN rate limits us | Polling at 5s is very conservative; ESPN handles millions of users |
| Goal event missing from scoreboard | ESPN summary endpoint as fallback; cross-check score changes |
| Cache increases during live | Monitor cache headers; adapt polling frequency |
| League-specific quirk | Each league's ESPN endpoint is independent; failures are isolated |

---

## Key Insight: European Soccer vs NBA/NHL

The NBA and NHL both have **official league CDNs** that serve static JSON files with 10-15s staleness. European soccer doesn't have an equivalent because:

1. **Opta (Stats Perform)** owns the data rights — leagues license FROM Opta, not the other way around
2. **No static JSON CDN** — leagues use dynamic APIs with CloudFront/Akamai caching
3. **Fragmented governance** — each league controls its own digital platform

ESPN effectively acts as the "cdn.nba.com equivalent" for all sports — it aggregates from Opta and other data providers, caches at 10s intervals, and serves it via a uniform, unauthenticated REST API. For our purposes, this is the optimal source.

---

## Appendix: Verified Working Endpoints (as of 2026-02-07)

```bash
# EPL
curl "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard"

# UCL
curl "https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard"

# La Liga
curl "https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard"

# Bundesliga
curl "https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard"

# Serie A
curl "https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard"

# Ligue 1
curl "https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard"

# EPL match detail
curl "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event={eventId}"

# PulseLive EPL (backup)
curl "https://footballapi.pulselive.com/football/fixtures?comps=1&compSeasons=719&statuses=L"

# UEFA UCL (backup)
curl "https://match.uefa.com/v5/matches?competitionId=1&seasonYear=2025&status=LIVE&offset=0&limit=10"

# FotMob match detail (research)
curl "https://www.fotmob.com/api/matchDetails?matchId={matchId}"

# OpenLigaDB Bundesliga (backup)
curl "https://api.openligadb.de/getmatchdata/bl1"
```
