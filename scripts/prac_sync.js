// Reads new Standard Fours prac games from Subspace Reloaded and keeps them in prac.json.
// prac.json: {pracMatches, pracFeed, pracTags, pracPending, pracAll, prac, pracAllAt, pracUpdated, u}
// Run every ~5 minutes. Only league rosters are read from data.json. Never deletes stored games.
const fs = require("fs"), JSON5 = require("json5");
const BASE = "https://subspacereloaded.com";
const SHIPS = ["Warbird", "Javelin", "Spider", "Leviathan", "Terrier", "Weasel", "Lancaster", "Shark"];
const RANK_EVERY = +(process.env.RANK_EVERY || 30) * 60e3; // ladder refresh interval
const MAX_NEW = +(process.env.MAX_NEW || 40);
const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return d; } };
const D = load("data.json", {});
const P = load("prac.json", null) || {
  pracMatches: D.pracMatches || [], pracFeed: D.pracFeed || {}, pracTags: D.pracTags || {}, pracPending: D.pracPending || [],
  pracAll: D.pracAll || [], prac: D.prac || [], pracAllAt: D.pracAllAt || null, pracUpdated: D.pracUpdated || null };
let changed = false;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function get(path) {
  const r = await fetch(BASE + path + (path.includes("?") ? "&" : "?") + "t=" + Date.now(), {
    headers: { "User-Agent": "premier-playbook-sync/1.0 (+https://subspacereclamation.netlify.app)" },
    signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(r.status + " " + path);
  return extract(await r.text());
}
// SvelteKit server pages carry their data as a JS literal: `data: [ ... ]` inside kit.start(...)
function extract(html) {
  const i = html.indexOf("data: ["); if (i < 0) throw new Error("no page data");
  let d = 0, q = null, esc = false; const j = i + 6;
  for (let k = j; k < html.length; k++) {
    const c = html[k];
    if (q) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "[" || c === "{") d++;
    else if (c === "]" || c === "}") { if (--d === 0) {
      const s = html.slice(j, k + 1).replace(/new Date\((-?\d+)\)/g, "$1").replace(/\bvoid 0\b/g, "null");
      const a = JSON5.parse(s); const node = a.filter(x => x && x.type === "data").pop(); return node ? node.data : null; } }
  }
  throw new Error("page data not closed");
}
const hki = ms => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Helsinki", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const mss = s => { s = Math.floor(s); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
const rate = (mu, sg) => Math.round(10 * (mu - 3 * sg) + 100);
const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;

function toGame(d) {
  const m = d.match, id = m.seq; if (m.gameType !== "svs-4v4") return { skip: true };
  if (m.finalState && m.finalState !== "completed") return { pending: true, err: "state " + m.finalState };
  const T = d.teams.slice().sort((a, b) => a.teamIndex - b.teamIndex);
  if (T.length !== 2 || !T.every(t => t.players && t.players.length)) return { pending: true, err: "teams " + T.length };
  const rows = [], tags = {}, dead = [0, 0];
  T.forEach((t, ti) => t.players.forEach(p => {
    const M = p.metrics || {}; if (!p.metrics) return;
    dead[ti] += M.deaths || 0;
    const dealt = (M.damageDealtGuns || 0) + (M.damageDealtBombs || 0), taken = (M.damageTakenGuns || 0) + (M.damageTakenBombs || 0);
    const ra = p.ratingMuAfter != null ? rate(p.ratingMuAfter, p.ratingSigmaAfter) : null;
    const rb = p.ratingMuBefore != null ? rate(p.ratingMuBefore, p.ratingSigmaBefore) : null;
    rows.push([p.displayName, ti ? "B" : "A", M.kills || 0, M.deaths || 0, M.assists || 0, r1(M.repelCredit || 0),
      Math.round(dealt / 1000), Math.round(taken / 1000), M.weaponEnergySpent ? r2(dealt / M.weaponEnergySpent) : 0,
      r1((M.killDamage || 0) / 1000), M.firesBullet ? Math.round(100 * M.gunHits / M.firesBullet) : null,
      M.firesBomb ? Math.round(100 * M.bombHits / M.firesBomb) : 0, M.wastedRepels || 0, mss(M.playingTime || 0),
      ra, ra != null && rb != null ? ra - rb : null, M.soloKills || 0, M.wastedRockets || 0]);
    if (p.squadTag) tags[p.displayName] = p.squadTag;
  }));
  if (rows.length < 2) return { pending: true, err: "no player stats" };
  const score = [dead[1], dead[0]], winT = T.find(t => t.rank === 1);
  const win = winT ? (winT.teamIndex === T[0].teamIndex ? "A" : "B") : (score[0] >= score[1] ? "A" : "B");
  const end = m.endedAt || m.startedAt;
  const g = { id, date: hki(end), at: new Date(end).toISOString().slice(0, 16) + "Z", dur: mss(m.durationSec || 0), score, win,
    ff: Math.max(...score) < 12, P: rows };
  const feed = (d.timeline || []).filter(e => e.kind === "kill" && e.killer && e.player).map(e => [Math.floor(e.t), e.killer, e.player]);
  shipProbe(d); const S = shipTrack(d); if (Object.keys(S).length) g.S = S; else g.Sx = 1;
  return { g, feed, tags };
}

// ---- ships: which ship each pilot flew and when they switched, from the match timeline ----
// Stored per game as S = {pilot: [[secondOfMatch, "Warbird"], ...]} (one entry per ship change).
const shipOf = v => { if (typeof v === "number") return SHIPS[v] || null; if (typeof v === "string") { const t = v.trim().toLowerCase(); return SHIPS.find(x => x.toLowerCase() === t) || null; } return null; };
function shipTrack(d) {
  const S = {}, add = (n, t, s) => { if (!n || !s) return; n = String(n).trim(); const L = S[n] = S[n] || []; if (!L.length || L[L.length - 1][1] !== s) L.push([Math.max(0, Math.floor(+t || 0)), s]); };
  try {
    (d.teams || []).forEach(tm => (tm.players || []).forEach(p => { for (const [k, v] of Object.entries(p)) if (/ship/i.test(k)) { const s = shipOf(v); if (s) add(p.displayName, 0, s); } }));
    (d.timeline || []).forEach(e => {
      if (e.fromShip != null && e.player != null && !S[String(e.player).trim()]) add(e.player, 0, shipOf(e.fromShip));
      for (const [k, v] of Object.entries(e)) {
        if (/^fromShip$/i.test(k)) continue;
        if (/ship/i.test(k)) { const s = shipOf(v); if (s) { if (/^killer/i.test(k)) add(e.killer, e.t, s); else add(e.player || e.name || e.displayName, e.t, s); } }
        else if (typeof v === "string") { const m = v.match(/^(.+?) changed ships? to (\w+)/i); if (m) add(m[1], e.t, shipOf(m[2])); }
      }
    });
    Object.values(S).forEach(L => L.sort((a, b) => a[0] - b[0]));
  } catch (e) { log("ship track failed:", e.message); }
  return S;
}
function shipProbe(d) {
  if (P.shipProbe && P.shipProbe.n >= 3) return;
  try {
    const pr = P.shipProbe = P.shipProbe || { n: 0, kinds: {}, playerKeys: [], samples: [] };
    pr.n++;
    (d.timeline || []).forEach(e => { const k = String(e.kind); pr.kinds[k] = [...new Set([...(pr.kinds[k] || []), ...Object.keys(e)])];
      if (pr.samples.length < 8 && (Object.keys(e).some(x => /ship/i.test(x)) || Object.values(e).some(v => typeof v === "string" && /ship/i.test(v)))) pr.samples.push(JSON.stringify(e).slice(0, 300)); });
    (d.teams || []).forEach(tm => (tm.players || []).forEach(p => { pr.playerKeys = [...new Set([...pr.playerKeys, ...Object.keys(p)])]; }));
  } catch (e) {}
}
async function newIds() {
  const have = new Set(P.pracMatches.map(m => +m.id)), max = Math.max(0, ...have); const ids = [];
  let before = null;
  for (let page = 0; page < 6; page++) {
    const L = await get("/matches?type=svs-4v4" + (before ? "&before=" + before : ""));
    const M = (L.matches || []).filter(m => m.gameType === "svs-4v4");
    let reached = false;
    for (const m of M) { const n = +String(m.matchId).split("-").pop(); if (n <= max) { reached = true; continue; } if (!have.has(n)) ids.push(n); }
    if (reached || !L.nextCursor || !M.length) break; before = L.nextCursor;
  }
  return ids;
}

async function syncGames() {
  let ids = [];
  try { ids = await newIds(); } catch (e) { log("list failed:", e.message); }
  const today = hki(Date.now()), cut = hki(Date.now() - 3 * 864e5);
  P.pracPending = (P.pracPending || []).filter(x => x.first >= cut);
  const want = [...new Set([...ids, ...P.pracPending.map(x => +x.id)])].sort((a, b) => a - b).slice(0, MAX_NEW);
  const have = new Set(P.pracMatches.map(m => +m.id));
  for (const id of want) {
    if (have.has(id)) { P.pracPending = P.pracPending.filter(x => +x.id !== id); continue; }
    let res;
    try { res = toGame(await get("/matches/svs-4v4-" + id)); } catch (e) { res = /^404 /.test(e.message) ? { skip: true } : { pending: true, err: e.message }; }
    if (res.skip) { P.pracPending = P.pracPending.filter(x => +x.id !== id); changed = true; continue; }
    if (res.pending) { const why = String(res.err || "").slice(0, 80), o = P.pracPending.find(x => +x.id === id);
      if (!o) { P.pracPending.push({ id, first: today, why }); changed = true; } else if (o.why !== why) { o.why = why; changed = true; }
      log("pending", id, why); continue; }
    P.pracMatches.push(res.g); have.add(id); P.pracFeed[String(id)] = res.feed; Object.assign(P.pracTags, res.tags);
    P.pracPending = P.pracPending.filter(x => +x.id !== id); changed = true; log("added", id, res.g.date, res.g.score.join("-"));
  }
  P.pracMatches.sort((a, b) => +a.id - +b.id);
}

// Fill in ships for older games, newest first, a few per run (one page read each).
async function backfillShips() {
  const BF = +(process.env.SHIP_BACKFILL || 15), cut = hki(Date.now() - 75 * 864e5);
  const todo = P.pracMatches.filter(m => !m.S && !m.Sx && m.date >= cut).sort((a, b) => +b.id - +a.id).slice(0, BF);
  for (const m of todo) {
    try { const d = await get("/matches/svs-4v4-" + m.id); shipProbe(d); const S = shipTrack(d); if (Object.keys(S).length) m.S = S; else m.Sx = 1; changed = true; }
    catch (e) { if (/^404 /.test(e.message)) { m.Sx = 1; changed = true; } else { log("ship backfill", m.id, e.message); break; } }
  }
  if (todo.length) log("ships filled", todo.filter(m => m.S).length, "of", todo.length);
}
async function syncLadder() {
  if (P.pracAllAt && Date.now() - Date.parse(P.pracAllAt) < RANK_EVERY) return;
  let R; try { R = await get("/rankings/svs-4v4"); } catch (e) { log("ladder failed:", e.message); return; }
  const B = (R && R.board) || []; if (B.length < 20) { log("ladder too short", B.length); return; }
  const all = B.map(b => ({ rank: b.rank, p: b.displayName, r: b.ordinal, chg: b.last5 ?? null, w: b.wins, l: b.losses, ship: SHIPS[b.ship] || null }));
  const seen = new Set(all.map(x => x.p.toLowerCase())), last = {};
  P.pracMatches.forEach(m => (m.P || []).forEach(r => { if (r[14] != null) last[r[0]] = r[14]; }));
  Object.entries(last).forEach(([p, r]) => { if (!seen.has(p.toLowerCase())) all.push({ rank: null, p, r, chg: null, w: null, l: null, ship: null }); });
  P.pracAll = all;
  const k = s => String(s).toLowerCase().replace(/\s+/g, ""), byK = {}; all.forEach(x => byK[k(x.p)] = x);
  const team = {}; Object.entries(D.rosters || {}).forEach(([t, L]) => (L || []).forEach(p => team[k(p)] = t));
  const prac = (P.prac || []).map(o => { const x = byK[k(o.p)]; return x && x.rank ? { ...o, r: x.r, chg: x.chg, w: x.w, l: x.l, ship: x.ship } : o; });
  const inPrac = new Set(prac.map(o => k(o.p)));
  all.forEach(x => { if (x.rank && team[k(x.p)] && !inPrac.has(k(x.p))) prac.push({ p: x.p, t: team[k(x.p)], ship: x.ship, r: x.r, chg: x.chg, w: x.w, l: x.l }); });
  P.prac = prac; P.pracAllAt = new Date().toISOString().slice(0, 16) + "Z"; P.pracUpdated = hki(Date.now()); changed = true; log("ladder", all.length);
}

(async () => {
  await syncGames(); await backfillShips(); await syncLadder();
  if (changed) { P.u = Math.floor(Date.now() / 1000); fs.writeFileSync("prac.json", JSON.stringify(P)); log("saved", P.pracMatches.length, "games"); }
  else log("nothing new");
})().catch(e => { console.error(e); process.exit(0); });
