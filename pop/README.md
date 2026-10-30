# Zone population

`.github/workflows/population.yml` runs every hour (free on this public repo) and samples
`https://auth.subspacereloaded.com/playercount` every 5 minutes (11 samples per run).

- `recent.json`: `{"u": last sample (unix), "s": [[unix, players], ...]}`, the last 8 days
- `hourly.json`: `{"h": [[hourStart, avg, max, min, samples], ...]}`, every hour since collection began

The Netlify site reads these files directly; the claude.ai artifact gets a copy in `data.json` key `pop` from the hourly prac refresh.
Only the total player count is stored: no names or personal data.


`archive/YYYY-MM.json` keeps every 5-minute sample for good, one file per month (UTC), so the full history is never lost when `recent.json` drops samples older than 8 days.
