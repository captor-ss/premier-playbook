# Premier Playbook data

Live data for the Premier Playbook site (Subspace Reclamation Premier 4v4 league).
`data.json` holds league data (frozen at the end of Season One; archive in `seasons/season-1/`). `prac.json` and `pop/` update every 5 minutes via GitHub Actions. The Netlify site reads all of them from here; the site's own files are in `site/`.

See `RUNNING_WITHOUT_CLAUDE.md` for how everything runs and how to maintain it.
