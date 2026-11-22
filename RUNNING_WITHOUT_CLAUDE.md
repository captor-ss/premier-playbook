# Running the Premier Playbook without Claude

Season One is over (Warriors are champions). The site keeps working with no Claude chat behind it.

## What keeps running by itself
- **Netlify site** (subspacereclamation.netlify.app). Every time someone opens it, the page loads live data from this repo:
  `data.json` (league), `prac.json` (prac games) and `pop/` (online player counts).
- **GitHub Actions: "Zone and prac updates"** (`.github/workflows/population.yml`). Every 5 minutes it reads new
  Standard Fours prac games from Subspace Reloaded (`scripts/prac_sync.js`, including which ship each pilot flew)
  and samples the zone population (`scripts/pop_sample.py`), then commits `prac.json` and `pop/`.
  The repo is public, so this costs nothing.

So prac stats, Coach, Your ships, Dream team, pairings, ladders and population keep updating on their own.
League data (`data.json`) is frozen at the end of Season One, which is correct now that the season is done.

## Things to check now and then
- **Actions still on?** GitHub → repo → Actions. If a banner says scheduled workflows were disabled,
  click *Enable workflow*. (GitHub turns off schedules after 60 days with no commits; this workflow commits
  every few minutes, so that should not happen while it is healthy.)
- **A run failed?** Open the newest run under Actions. The usual cause is Subspace Reloaded being down; it
  recovers on the next run. To start one by hand: Actions → Zone and prac updates → *Run workflow*.
- **prac.json size.** It grows by roughly 1 MB a month. Fine for a long time; if it ever passes ~25 MB,
  move old games into `seasons/` and delete them from `prac.json`.

## Updating the Netlify site by hand
The exact site files are in `site/`. Two ways:
1. **Drag and drop** (what you do now): zip the contents of `site/` (not the folder itself) and upload it in
   Netlify → Deploys.
2. **Automatic** (recommended): Netlify → Site configuration → Build & deploy → *Link repository* →
   choose `captor-ss/premier-playbook`, build command empty, publish directory `site`. After that,
   any change to `site/` in GitHub goes live by itself.
After changing `site/index.html`, bump the cache name in `site/sw.js` (`pp-v128` → `pp-v128`) so phones
pick up the new version.

## Season Two
- Season One is archived in `seasons/season-1/` (README with champions and bracket, CSVs, full data).
- For a new season, `data.json` needs new `results`, `box`, `kills`, `schedule`, `rosters` and `playoffs`.
  The easiest route is a new Claude (or other AI) chat: give it this repo, `seasons/season-1/README.md`
  and this file, and ask it to set up Season Two in the same format. Keep these keys in `data.json`:
  salary, playoffs, pracAllNote, gmLeague, aliases, pressHide, extraPilots, gmHide, gmKeep, gmKeepOriginal,
  gmMerge, playedRd, pop, warmup, dq, notRookies.
- League data and prac data stay separate (`data.json` vs `prac.json`).

## Backups
`backups/` has weekly copies. A full backup with git history (`premier-playbook.bundle`) is in the backup
zip from 23 Nov 2026. Restore with `git clone premier-playbook.bundle premier-playbook`.
