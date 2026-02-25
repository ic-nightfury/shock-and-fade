# Sportradar Schedule Collector (MLB/NHL/NFL)

Simple collector to pull **daily schedules** and **game summaries** from Sportradar trial endpoints.

## Environment
Add to `.env`:
```env
SPORTRADAR_MLB_API_KEY=your_key
SPORTRADAR_MLB_ACCESS_LEVEL=trial
SPORTRADAR_MLB_VERSION=v7
SPORTRADAR_MLB_LANGUAGE=en
SPORTRADAR_MLB_BASE_URL=https://api.sportradar.com

SPORTRADAR_NHL_API_KEY=your_key
SPORTRADAR_NHL_ACCESS_LEVEL=trial
SPORTRADAR_NHL_VERSION=v7
SPORTRADAR_NHL_LANGUAGE=en
SPORTRADAR_NHL_BASE_URL=https://api.sportradar.com

SPORTRADAR_NFL_API_KEY=your_key
SPORTRADAR_NFL_ACCESS_LEVEL=trial
SPORTRADAR_NFL_VERSION=v7
SPORTRADAR_NFL_LANGUAGE=en
SPORTRADAR_NFL_BASE_URL=https://api.sportradar.com
```

## Run
```bash
npm run sportradar:fetch -- mlb 2026-02-06
npm run sportradar:fetch -- nhl 2026-02-06
npm run sportradar:fetch -- nfl
```

## Notes
- Endpoints used:
  - `/games/{YYYY}/{MM}/{DD}/schedule.json`
  - `/games/{gameId}/summary.json`
- If Sportradar changes version/access level, update `SPORTRADAR_*` env vars.
