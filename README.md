# Fantasy Command Center

Sunday HUD for one Sleeper roster: lineup, injury/weather chips, Grok start/sit, and Durable Object state.

## What it does

- Import a live Sleeper roster (starters, bench, record, current NFL week, Sleeper injury tags) into a Cloudflare Durable Object
- Evaluate a start/sit matchup with Grok (compact CSSP packet; persists the JSON verdict and real `usage` token counts)
- Cheap intel refresh: Sleeper injuries plus ESPN/NWS weather tags (`PASS-FADE` / `K-FADE` / `RB-BUMP` / `SLOP`). Cron re-syncs Thu–Sun
- Token inspector is behind `?debug=1`

Sleeper import is public API — no Sleeper token. The UI still seeds a demo Kyren vs Charbonnet lineup until you import.

## Environment

The only secret is `XAI_API_KEY`. Missing it makes Evaluate return an error; it does not fall back to canned Grok copy.

```bash
cp .dev.vars.example .dev.vars
# set XAI_API_KEY
npm run dev
```

Deployed Worker:

```bash
npx wrangler secret put XAI_API_KEY
```

## Sleeper import

From the Command Center header, or:

```bash
curl -X POST http://localhost:5173/api/fantasy/roster/import \
  -H 'content-type: application/json' \
  -d '{"username":"your_sleeper_username"}'
```

Optional body fields: `leagueId`, `rosterId`.

## Scripts

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # vitest
npm run check    # tsc -b && npm test
npm run build
npm run deploy
```
