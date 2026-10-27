# Backups

Weekly snapshots of the Premier Playbook, taken every Monday around noon (Helsinki time) by a scheduled task.

Each folder `YYYY-MM-DD/` holds:
- `data.json`: all league, prac and site data as published that day
- `index.html`: the page as published that day

To restore: upload that folder's `index.html` + `data.json` (zipped) to Netlify, or ask Claude to republish them to the artifact.
