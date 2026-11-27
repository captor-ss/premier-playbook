#!/usr/bin/env node
/* Prac preview for Discord.
   Watches the #discobot channel for "Match started · <queue> · A, B, C, D vs E, F, G, H" and posts a
   preview of that match to another channel: win chance, who is hot or cold, streaks, what is on the line.
   All numbers come from the Playbook's prac.json.

   Usage:
     node scripts/preview.js --loop [minutes]   watch Discord, polling every POLL_S seconds (default 340 min)
     node scripts/preview.js --test "Match started · svs-4v4 · a, b, c, d vs e, f, g, h"
                                                print the preview for one line, no Discord needed

   Env (GitHub secrets):
     DISCORD_BOT_TOKEN     token of a bot that can read the discobot channel (Message Content Intent on)
     DISCOBOT_CHANNEL_ID   id of the channel where "Match started" lines appear
     PREVIEW_WEBHOOK       webhook URL of the channel that gets the previews
   No dependencies: Node 18+ (built-in fetch). Nothing is written to the repo. */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const SITE = "https://playbook.ssrl.gg/";
const RAW = "https://raw.githubusercontent.com/captor-ss/premier-playbook/main/";
const API = "https://discord.com/api/v10";
const TOKEN = process.env.DISCORD_BOT_TOKEN || "", CHANNEL = process.env.DISCOBOT_CHANNEL_ID || "", HOOK = process.env.PREVIEW_WEBHOOK || "";

const POLL_S = 20;            // seconds between looks at the channel
const DATA_MIN = 5;           // minutes between prac.json refreshes
const QUEUES = /4v4/i;        // only queues whose name matches get a preview
const SCALE = 240;            // rating gap to win chance: fitted on 1,487 logged pracs (favourite won 55%)
const TIERS = [["Iron", 0], ["Bronze", 100], ["Silver", 150], ["Gold", 200], ["Platinum", 250], ["Diamond", 300], ["Master", 350], ["Grandmaster", 400], ["Challenger", 450]];
const TIER_NEAR = 8;          // "close to a new tier" = this many rating points or fewer
const STREAK_NEXT = [5, 8, 10, 15, 20], GAMES = [100, 250, 500, 1000, 1500, 2000, 3000, 5000];
const HEAT_MIN = 4, HOT = 0.65, COLD = 0.35;   // last 7 days: pracs needed, win share for hot / cold
const DUO_MIN = 5;            // pracs together before a pair is mentioned
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "preview:", ...a);
const mins = v => { const [a, b] = String(v || "0").split(":").map(Number); return (a || 0) + (b || 0) / 60; };
const md = s => String(s).replace(/([\\*_~`|>\[\]()])/g, "\\$1");
const link = n => `[${md(n)}](${SITE}#player/${encodeURIComponent(n)})`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- data ---------- */
let ALIASES = null;   // alt names, read once from data.json
function index(P, aliases) {
  const AL = {}; Object.entries(aliases || {}).forEach(([k, v]) => AL[k.toLowerCase()] = v);
  const key = n => (AL[String(n).trim().toLowerCase()] || String(n).trim()).toLowerCase();
  const M = (P.pracMatches || []).filter(m => m && Array.isArray(m.P)).sort((a, b) => +a.id - +b.id);
  const pl = {}, pair = {}, today = Date.now();
  const get = (k, n) => pl[k] = pl[k] || { n, g: 0, w: 0, streak: 0, rating: null, last: [], g7: 0, w7: 0, tot: null, rank: null };
  M.forEach(m => {
    const t = Date.parse(m.at || (m.date + "T12:00:00Z")), in7 = isFinite(t) && today - t <= 7 * 864e5;
    const side = { A: [], B: [] };
    m.P.forEach(r => {
      if (mins(r[13]) < 3) return;
      const k = key(r[0]), o = get(k, r[0]), won = m.win === r[1];
      o.g++; o.w += won ? 1 : 0; o.streak = won ? (o.streak > 0 ? o.streak + 1 : 1) : (o.streak < 0 ? o.streak - 1 : -1);
      o.last.push(won ? "W" : "L"); if (o.last.length > 5) o.last.shift();
      if (in7) { o.g7++; o.w7 += won ? 1 : 0; }
      if (r[14] != null) o.rating = +r[14];
      if (side[r[1]]) side[r[1]].push(k);
    });
    ["A", "B"].forEach(s => { const L = side[s], won = m.win === s; for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) { const id = [L[i], L[j]].sort().join("|"), o = pair[id] = pair[id] || { g: 0, w: 0 }; o.g++; o.w += won ? 1 : 0; } });
  });
  // ladder: a pilot's own entry wins over an alt name's entry
  const seenOwn = {};
  (P.pracAll || []).forEach(x => { if (!x || x.r == null) return; const k = key(x.p), own = String(x.p).trim().toLowerCase() === k, o = get(k, x.p);
    if (own || !seenOwn[k]) { if (own || o.rating == null) { o.rating = +x.r; o.rank = x.rank || null; } }
    if (own) seenOwn[k] = 1;
    if (x.w != null && x.l != null) o.tot = Math.max(o.tot || 0, x.w + x.l); });
  return { key, pl, pair, n: M.length };
}
async function loadData() {
  const j = async f => { try { const r = await fetch(RAW + f + "?t=" + Math.floor(Date.now() / 6e4), { signal: AbortSignal.timeout(30000) }); if (r.ok) return await r.json(); } catch (e) {} try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch (e) { return null; } };
  const local = f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch (e) { return null; } };
  const useLocal = process.argv.includes("--test");
  const P = useLocal ? (local("prac.json") || await j("prac.json")) : await j("prac.json");
  if (!P) throw new Error("no prac.json");
  if (!ALIASES) { const D = useLocal ? local("data.json") : await j("data.json"); ALIASES = (D && D.aliases) || P.aliases || {}; }
  return index(P, ALIASES);
}

/* ---------- the preview ---------- */
function parse(text) {
  const t = String(text || "").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  const m = t.match(/Match started\s*[·•\-–|:]\s*([^·•|]+?)\s*[·•|]\s*(.+?)\s+vs\.?\s+(.+)$/i);
  if (!m) return null;
  const names = s => s.split(/\s*,\s*/).map(x => x.trim()).filter(Boolean);
  return { queue: m[1].trim(), A: names(m[2]), B: names(m[3]) };
}
const tierOf = r => { let i = 0; TIERS.forEach((t, k) => { if (r >= t[1]) i = k; }); return i; };
function build(match, I) {
  const info = n => { const o = I.pl[I.key(n)]; return o ? { ...o, n } : { n, g: 0, rating: null, streak: 0, last: [], g7: 0, w7: 0 }; };
  const T = [match.A.map(info), match.B.map(info)];
  const avg = L => { const v = L.filter(o => o.rating != null).map(o => o.rating); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const ra = avg(T[0]), rb = avg(T[1]);
  const lines = [];
  let head = "";
  if (ra != null && rb != null) {
    const pa = 1 / (1 + Math.pow(10, -(ra - rb) / SCALE)), a = Math.round(pa * 100), gap = Math.abs(a - 50);
    const word = gap <= 3 ? "Coin flip" : gap <= 8 ? "Slight edge" : gap <= 15 ? "Clear favourite" : "Heavy favourite";
    head = `**Team A ${a}% – ${100 - a}% Team B** · ${word}${gap > 3 ? ": Team " + (a > 50 ? "A" : "B") : ""}\nAverage rating ${Math.round(ra)} vs ${Math.round(rb)}`;
  } else head = "Not enough rating data for a win chance.";
  const row = L => L.map(o => `${link(o.n)}${o.rating != null ? " " + o.rating : " (new)"}`).join(" · ");
  const notes = [];
  T.forEach((L, ti) => L.forEach(o => {
    if (!o.g) return;
    const who = `**${md(o.n)}**`;
    if (o.streak >= 3) { const nx = STREAKS_HIT(o.streak + 1); notes.push([6 + o.streak, `🔥 ${who} is on a **${o.streak}-win streak**${nx ? ` (a win makes it ${o.streak + 1})` : ""}.`]); }
    else if (o.streak <= -4) notes.push([4 - o.streak, `🧊 ${who} has lost **${-o.streak} in a row**.`]);
    if (o.g7 >= HEAT_MIN) { const s = o.w7 / o.g7; if (s >= HOT && o.streak < 3) notes.push([5, `📈 ${who} is hot: ${o.w7}–${o.g7 - o.w7} in the last 7 days.`]); else if (s <= COLD && o.streak > -4) notes.push([4, `📉 ${who} is cold: ${o.w7}–${o.g7 - o.w7} in the last 7 days.`]); }
    if (o.rating != null) { const ti2 = tierOf(o.rating), nx = TIERS[ti2 + 1]; if (nx && nx[1] - o.rating <= TIER_NEAR && ti2 + 1 >= 3) notes.push([7, `🎯 ${who} is ${nx[1] - o.rating} point${nx[1] - o.rating === 1 ? "" : "s"} from **${nx[0]}**.`]); }
    if (o.tot != null && GAMES.includes(o.tot + 1)) notes.push([8, `🎖️ This is prac number **${o.tot + 1}** for ${who}.`]);
    if (o.rank === 1) notes.push([3, `👑 ${who} is #1 on the prac ladder.`]);
  }));
  // best and worst pair on the same side
  const duo = [];
  T.forEach(L => { for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) { const p = I.pair[[I.key(L[i].n), I.key(L[j].n)].sort().join("|")]; if (p && p.g >= DUO_MIN) duo.push({ a: L[i].n, b: L[j].n, g: p.g, w: p.w, s: p.w / p.g }); } });
  duo.sort((x, y) => y.s - x.s || y.g - x.g);
  if (duo.length && duo[0].s >= 0.6) notes.push([5, `🤝 **${md(duo[0].a)} + ${md(duo[0].b)}** are ${duo[0].w}–${duo[0].g - duo[0].w} together.`]);
  const worst = duo[duo.length - 1]; if (duo.length > 1 && worst.s <= 0.4) notes.push([3, `⚠️ **${md(worst.a)} + ${md(worst.b)}** are ${worst.w}–${worst.g - worst.w} together.`]);
  notes.sort((x, y) => y[0] - x[0]);
  const desc = [head, "", `**Team A:** ${row(T[0])}`, `**Team B:** ${row(T[1])}`].concat(notes.length ? ["", ...notes.slice(0, 7).map(x => x[1])] : []).join("\n");
  return { title: `Prac preview · ${match.queue}`, description: desc.slice(0, 3900) };
}
function STREAKS_HIT(n) { return STREAK_NEXT.includes(n); }

/* ---------- Discord ---------- */
async function dget(p) {
  const r = await fetch(API + p, { headers: { Authorization: "Bot " + TOKEN }, signal: AbortSignal.timeout(20000) });
  if (r.status === 429) { const j = await r.json().catch(() => ({})); await sleep(Math.min(30, (j.retry_after || 5)) * 1000); return null; }
  if (!r.ok) throw new Error("Discord answered " + r.status + (r.status === 401 ? " (bad token)" : r.status === 403 ? " (bot cannot see the channel)" : r.status === 404 ? " (wrong channel id)" : ""));
  return r.json();
}
const textOf = m => [m.content, ...(m.embeds || []).flatMap(e => [e.title, e.description, ...(e.fields || []).flatMap(f => [f.name, f.value])])].filter(Boolean).join("\n");
async function post(embed) {
  const body = { username: "Playbook", allowed_mentions: { parse: [] }, embeds: [{ ...embed, url: SITE + "#prac", color: 0x5b9bff, footer: { text: "playbook.ssrl.gg · win chance from prac ratings" } }] };
  const r = await fetch(HOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("webhook answered " + r.status);
}

async function loop(minutes) {
  if (!TOKEN || !CHANNEL || !HOOK) { log("missing secrets:", [!TOKEN && "DISCORD_BOT_TOKEN", !CHANNEL && "DISCOBOT_CHANNEL_ID", !HOOK && "PREVIEW_WEBHOOK"].filter(Boolean).join(", "), "- nothing to do"); return; }
  const end = Date.now() + minutes * 6e4;
  let I = await loadData(), at = Date.now(); log("data ready:", I.n, "pracs,", Object.keys(I.pl).length, "pilots");
  // start from the newest message: nothing older is previewed
  let first = null; while (first === null) first = await dget(`/channels/${CHANNEL}/messages?limit=1`);
  let last = first[0] ? first[0].id : "0", seen = 0, sent = 0, empty = 0;
  log("watching channel from message", last);
  while (Date.now() < end) {
    await sleep(POLL_S * 1000);
    try {
      if (Date.now() - at > DATA_MIN * 6e4) { try { I = await loadData(); } catch (e) {} at = Date.now(); }
      const L = await dget(`/channels/${CHANNEL}/messages?after=${last}&limit=100`); if (!L || !L.length) continue;
      L.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)); last = L[L.length - 1].id; seen += L.length;
      for (const m of L) {
        const t = textOf(m); if (!t) { empty++; continue; }
        for (const line of t.split("\n")) {
          if (!/match started/i.test(line)) continue;
          const mt = parse(line); if (!mt) { log("could not read:", line.slice(0, 120)); continue; }
          if (!QUEUES.test(mt.queue)) continue;
          await post(build(mt, I)); sent++; log("posted preview:", mt.A.join(", "), "vs", mt.B.join(", "));
        }
      }
      if (empty > 20 && !sent && empty === seen) { log("messages arrive without text: turn on Message Content Intent for the bot"); empty = 0; seen = 0; }
    } catch (e) { log("error:", e.message); await sleep(15000); }
  }
  log("done:", sent, "previews,", seen, "messages read");
}

(async () => {
  const a = process.argv.slice(2);
  if (a[0] === "--test") { const I = await loadData(), mt = parse(a[1] || ""); if (!mt) return console.log("could not read that line"); const e = build(mt, I); console.log(e.title + "\n" + e.description); return; }
  if (a[0] === "--loop") return loop(+a[1] || 340);
  console.log('usage: node scripts/preview.js --loop [minutes] | --test "Match started · svs-4v4 · a, b vs c, d"');
})().catch(e => { console.error("preview failed:", e.message); process.exit(1); });
