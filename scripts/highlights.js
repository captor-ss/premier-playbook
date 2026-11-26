#!/usr/bin/env node
/* Prac highlights for Discord.
   Reads prac.json after each sync, finds new milestones and posts them to a Discord channel
   through a webhook. What it has already handled is kept in highlights_state.json, so nothing
   is announced twice.

   Per pilot (one line per pilot per run, the biggest one):
     - new #1 on the prac ladder, or a new face in the top 5
     - a new rating tier for the first time (Gold and up)
     - rating climb of CLIMB points within 7 days (once a week per pilot at most)
     - win streak reaching 5, 8, 10, 15 or 20 pracs
     - big game: BIG_K+ kills, BIG_A+ assists or SOLO+ solo kills in one prac
     - untouchable: a win with 0 deaths, UNT_K+ kills, UNT_MIN+ minutes
     - prac count milestone on the ladder (100, 250, 500, 1000, ...)
     - first pracs of a brand new pilot
     - rare feats: flawless carry (CARRY_K+ kills, at most 1 death), total involvement (kills + assists
       of INVOLVE+), kill frenzy (FRENZY+ kills over 3 pracs in a row), predator (PREDATOR+ kills over 5),
       rock solid (SOLID pracs in a row with more kills than deaths), dominant week (DOM_WIN share of wins
       over DOM_PRACS+ pracs in 7 days), grinder (GRIND pracs in 7 days), rating explosion (+BOOM in 7 days),
       ladder rush (RUSH+ places gained in 7 days), first time in the top 10 or top 3, #1 held for 7 days,
       kill count milestones in the Playbook log
   Per pair:
     - chemistry: PAIR_STREAK wins in a row together
   Per game:
     - upset: the winners were rated UPSET+ points lower on average
     - clean sweep: the losers scored 0
     - against the odds: a win with fewer team kills than the losers
   Once a day (after RECAP_HOUR UTC): a recap of yesterday's pracs.

   Env:  DISCORD_WEBHOOK  the channel's webhook URL (GitHub secret). Without it the script only
                          logs what it would post (dry run) and still records it as handled.
         DRY=1            log only, and do not save the state (for testing)
         NOW=<ISO time>   pretend it is this moment (for testing)
   No dependencies: Node 18+ (built-in fetch). */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const PRAC = path.join(ROOT, "prac.json"), DATA = path.join(ROOT, "data.json"), STATE = path.join(ROOT, "highlights_state.json");
const SITE = "https://playbook.ssrl.gg/";
const HOOK = process.env.DISCORD_WEBHOOK || "", DRY = process.env.DRY === "1";
const NOW = process.env.NOW ? Date.parse(process.env.NOW) : Date.now();

const STREAKS = [5, 8, 10, 15, 20];
const TIERS = [["Iron", 0], ["Bronze", 100], ["Silver", 150], ["Gold", 200], ["Platinum", 250], ["Diamond", 300], ["Master", 350], ["Grandmaster", 400], ["Challenger", 450]];
const MIN_TIER = 3;                    // tiers below Gold are not announced
const CLIMB = 50, CLIMB_MIN_GAMES = 10; // rating points gained within 7 days; pracs needed before it counts
const BIG_K = 8, BIG_A = 9, SOLO = 5;  // kills / assists / solo kills in one prac
const UNT_K = 4, UNT_MIN = 10;         // untouchable: kills and minutes needed (and a win)
const UPSET = 60;                      // winners' average rating this much lower than the losers'
const GAMES = [100, 250, 500, 1000, 1500, 2000, 3000, 5000];
const CARRY_K = 7, INVOLVE = 12;       // flawless carry: kills (with at most 1 death); total involvement: kills + assists
const FRENZY = 18, PREDATOR = 25;      // kills over 3 and over 5 pracs in a row
const SOLID = 10;                      // pracs in a row with more kills than deaths
const DOM_WIN = 0.70, DOM_PRACS = 20;  // dominant week
const GRIND = 80;                      // pracs in 7 days
const BOOM = 100;                      // rating points in 7 days that turn a climb into an explosion
const RUSH = 10;                       // ladder places gained in 7 days
const PAIR_STREAK = 8;                 // wins in a row together
const KILLS = [500, 1000, 1500, 2000, 3000, 5000];
const RECAP_HOUR = 9, RECAP_MIN_PRACS = 5;
const MAX_AGE_H = 36;                  // pracs older than this are recorded but not announced
const MAX_LINES = 10;                  // most lines in one post
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "highlights:", ...a);

const tierIdx = r => { let i = 0; TIERS.forEach((t, k) => { if (r >= t[1]) i = k; }); return i; };
const mins = v => { const [a, b] = String(v || "0").split(":").map(Number); return (a || 0) + (b || 0) / 60; };
const md = s => String(s).replace(/([\\*_~`|>\[\]()])/g, "\\$1");
const link = n => `[**${md(n)}**](${SITE}#player/${encodeURIComponent(n)})`;
const day = t => new Date(t).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 864e5);
const pl = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function main() {
  if (!fs.existsSync(PRAC)) return log("no prac.json");
  const P = JSON.parse(fs.readFileSync(PRAC, "utf8"));
  let aliases = {};
  try { aliases = JSON.parse(fs.readFileSync(DATA, "utf8")).aliases || {}; } catch (e) {}
  const AL = {}; Object.entries(aliases).forEach(([k, v]) => AL[k.toLowerCase()] = v);
  const nameOf = n => AL[String(n).toLowerCase()] || n, key = n => nameOf(n).toLowerCase();

  const M = (P.pracMatches || []).filter(m => m && Array.isArray(m.P)).sort((a, b) => +a.id - +b.id);
  const ladder = (P.pracAll || []).filter(x => x && x.r != null).sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
  const top5 = ladder.slice(0, 5).map(x => nameOf(x.p));

  let S = null; try { S = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (e) {}
  const first = !S;
  if (first) S = { v: 3, lastId: 0, tiers: {}, top5: [], leader: null };
  const hadGames = !!S.games;                       // a state from the first version has no prac counts yet
  S.climb = S.climb || {}; S.games = S.games || {};
  const hadV3 = !!S.cd;                             // a state from before the rare feats: record them quietly once
  S.cd = S.cd || {}; S.ranks = S.ranks || {}; S.ever10 = S.ever10 || []; S.ever3 = S.ever3 || [];
  const cool = (id, date, days) => { const l = S.cd[id]; if (l && dayDiff(date, l) < days) return false; S.cd[id] = date; return true; };

  const streak = {}, disp = {}, hist = {}, ev = [], gev = [], G = {}, solid = {}, kills = {}, pairs = {};
  const isNew = m => !first && +m.id > S.lastId;
  const fresh = m => { const t = Date.parse(m.at || (m.date + "T12:00:00Z")); return isFinite(t) && NOW - t <= MAX_AGE_H * 36e5; };
  const add = (k, pr, t) => ev.push({ k, pr, t });

  M.forEach(m => {
    const go = isNew(m) && fresh(m);
    const sc = Array.isArray(m.score) ? m.score : null, hi = sc ? Math.max(...sc) : 0, lo = sc ? Math.min(...sc) : 0;
    m.P.forEach(r => {
      const k = key(r[0]); disp[k] = nameOf(r[0]);
      const mi = mins(r[13]); if (mi < 3) return;
      const won = m.win === r[1], who = link(disp[k]);
      streak[k] = won ? (streak[k] || 0) + 1 : 0;
      if (go && won && STREAKS.includes(streak[k])) add(k, 5, `🔥 ${who} has won **${streak[k]} pracs in a row**.`);
      if (go && r[2] >= BIG_K) add(k, 4, `💥 ${who} dropped **${r[2]} kills** in one prac (${r[2]}-${r[3]}-${r[4]}${won ? ", win" : ""}).`);
      else if (go && (r[16] || 0) >= SOLO) add(k, 4, `🗡️ ${who} got **${r[16]} solo kills** in one prac (${r[2]}-${r[3]}-${r[4]}).`);
      else if (go && r[4] >= BIG_A) add(k, 3, `🤝 ${who} set up **${r[4]} assists** in one prac (${r[2]}-${r[3]}-${r[4]}).`);
      if (go && won && r[3] === 0 && r[2] >= UNT_K && mi >= UNT_MIN) add(k, 4, `👻 ${who} went **untouchable**: ${pl(r[2], "kill")}, 0 deaths in ${r[13]}.`);
      // rolling record of this pilot's pracs
      const L = G[k] = G[k] || []; L.push({ d: m.date, w: won, k: r[2], de: r[3] });
      solid[k] = r[2] > r[3] ? (solid[k] || 0) + 1 : 0;
      const before = kills[k] || 0; kills[k] = before + r[2];
      if (go) {
        if (r[2] >= CARRY_K && r[3] <= 1) add(k, 5, `💀 ${who} ran a **flawless carry**: ${r[2]}-${r[3]}-${r[4]}${won ? " in a win" : ""}.`);
        else if (r[2] + r[4] >= INVOLVE) add(k, 4.5, `🎯 ${who} was in on **${r[2] + r[4]} points** in one prac (${r[2]}-${r[3]}-${r[4]}).`);
        const n = L.length, sum = c => L.slice(n - c).reduce((a, x) => a + x.k, 0);
        if (n >= 5 && sum(5) >= PREDATOR && cool("pred|" + k, m.date, 3)) add(k, 5.5, `🐺 ${who} has **${sum(5)} kills in the last 5 pracs**.`);
        else if (n >= 3 && sum(3) >= FRENZY && cool("frenzy|" + k, m.date, 3)) add(k, 5.5, `⚡ ${who} is on a kill frenzy: **${sum(3)} kills in 3 pracs**.`);
        if (solid[k] === SOLID) add(k, 6, `🧱 ${who} has out-killed their deaths in **${SOLID} pracs in a row**.`);
        const W = L.filter(x => dayDiff(m.date, x.d) < 7), ww = W.filter(x => x.w).length;
        if (W.length >= DOM_PRACS && ww / W.length >= DOM_WIN && cool("dom|" + k, m.date, 7)) add(k, 6.5, `🏆 ${who} is having a **dominant week**: ${ww}–${W.length - ww} in the last 7 days.`);
        if (W.length >= GRIND && cool("grind|" + k, m.date, 7)) add(k, 3, `🏃 ${who} has played **${W.length} pracs in 7 days**.`);
        const km = KILLS.filter(v => before < v && kills[k] >= v).pop(); if (km) add(k, 3, `⚔️ ${who} has **${km} kills** in the Playbook prac log.`);
      }
      if (r[14] != null) {
        const rt = +r[14], H = hist[k] = hist[k] || [];
        const ti = tierIdx(rt), best = S.tiers[k] == null ? -1 : S.tiers[k];
        if (ti > best) {
          if (go && ti >= MIN_TIER && best >= 0) add(k, 7, `📈 ${who} reached **${TIERS[ti][0]}** for the first time (rating ${rt}).`);
          S.tiers[k] = ti;
        }
        if (go && H.length >= CLIMB_MIN_GAMES) {
          const win = H.filter(x => dayDiff(m.date, x[0]) <= 7), low = win.length ? Math.min(...win.map(x => x[1])) : null;
          const last = S.climb[k];
          if (low != null && rt - low >= CLIMB && (!last || dayDiff(m.date, last) >= 7)) { if (rt - low >= BOOM) add(k, 7.5, `💣 **Rating explosion:** ${who} is up **+${rt - low} in a week** (${low} → ${rt}).`); else add(k, 6, `🚀 ${who} has climbed **+${rt - low} rating in a week** (${low} → ${rt}).`); S.climb[k] = m.date; }
        }
        H.push([m.date, rt]);
      }
    });
    ["A", "B"].forEach(sd => { const T = m.P.filter(r => r[1] === sd && mins(r[13]) >= 3).map(r => key(r[0])), won = m.win === sd;
      for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) { const id = [T[i], T[j]].sort().join("|"); pairs[id] = won ? (pairs[id] || 0) + 1 : 0;
        if (go && pairs[id] === PAIR_STREAK) gev.push({ pr: 5.5, t: `🤝 **Chemistry:** **${md(disp[T[i]])} + ${md(disp[T[j]])}** have won **${PAIR_STREAK} pracs in a row together**.` }); } });
    if (go && sc && m.win) {
      const W = m.P.filter(r => r[1] === m.win), L = m.P.filter(r => r[1] !== m.win);
      const kw = W.reduce((a, r) => a + r[2], 0), kl = L.reduce((a, r) => a + r[2], 0);
      if (kw < kl && W.length >= 3 && L.length >= 3) gev.push({ pr: 4, t: `🎭 **Against the odds:** ${W.filter(r => mins(r[13]) >= 3).map(r => `**${md(nameOf(r[0]))}**`).join(", ")} won ${hi}–${lo} with fewer kills (${kw} vs ${kl}).` });
      const names = W.filter(r => mins(r[13]) >= 3).map(r => `**${md(nameOf(r[0]))}**`).join(", ");
      const avg = R => { const v = R.filter(r => r[14] != null).map(r => r[14] - (r[15] || 0)); return v.length >= 3 ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      const aw = avg(W), al = avg(L);
      if (lo === 0 && hi >= 10) gev.push({ pr: 6, t: `🧹 **Clean sweep ${hi}–0:** ${names}.` });
      else if (aw != null && al != null && al - aw >= UPSET) gev.push({ pr: 5, t: `⚔️ **Upset ${hi}–${lo}:** ${names} beat a team rated ${Math.round(al - aw)} points higher.` });
    }
  });

  // ladder: new #1, new faces in the top 5, prac count milestones, brand new pilots
  if (!first && top5.length) {
    const lead = top5[0];
    if (S.leader && lead.toLowerCase() !== S.leader.toLowerCase()) add(lead.toLowerCase(), 9, `👑 ${link(lead)} is the **new #1** on the prac ladder (rating ${ladder[0].r}), passing ${md(S.leader)}.`);
    const old = new Set((S.top5 || []).map(n => n.toLowerCase()));
    if (old.size) top5.forEach((n, i) => { if (i > 0 && !old.has(n.toLowerCase())) add(n.toLowerCase(), 8, `⭐ ${link(n)} moved into the **top 5** of the prac ladder (#${i + 1}, rating ${ladder[i].r}).`); });
  }
  // ladder history: first time in the top 10 / top 3, places gained in a week, #1 held for a week
  const today = day(NOW), rk = {}; ladder.forEach(x => { const k = key(x.p); if (x.rank && (rk[k] == null || x.rank < rk[k])) rk[k] = x.rank; });
  if (ladder.length) {
    const e10 = new Set(S.ever10), e3 = new Set(S.ever3), nm = k => disp[k] || nameOf((ladder.find(x => key(x.p) === k) || {}).p || k);
    Object.entries(rk).forEach(([k, r]) => {
      if (r <= 3 && !e3.has(k)) { if (!first && hadV3) add(k, 8.5, `🥉 ${link(nm(k))} is in the **top 3** of the prac ladder for the first time (#${r}).`); e3.add(k); e10.add(k); }
      else if (r <= 10 && !e10.has(k)) { if (!first && hadV3) add(k, 8, `🔟 ${link(nm(k))} broke into the **top 10** of the prac ladder for the first time (#${r}).`); e10.add(k); }
    });
    S.ever10 = [...e10]; S.ever3 = [...e3];
    const old = Object.keys(S.ranks).sort().filter(d => dayDiff(today, d) <= 7)[0];
    if (!first && old && old !== today) Object.entries(rk).forEach(([k, r]) => { const was = S.ranks[old][k]; if (was && was - r >= RUSH && cool("rush|" + k, today, 7)) add(k, 6.5, `📊 **Ladder rush:** ${link(nm(k))} climbed **${was - r} places** in a week (#${was} → #${r}).`); });
    S.ranks[today] = rk; Object.keys(S.ranks).forEach(d => { if (dayDiff(today, d) > 8) delete S.ranks[d]; });
    const lead = top5[0] ? top5[0].toLowerCase() : null;
    if (lead) { if (!S.leadSince || S.leadWho !== lead) { S.leadWho = lead; S.leadSince = today; S.leadTold = 0; }
      const held = dayDiff(today, S.leadSince), mark = Math.floor(held / 7);
      if (!first && mark >= 1 && mark > (S.leadTold || 0)) { add(lead, 8, `🛡️ **Rank defender:** ${link(top5[0])} has held **#1 for ${mark * 7} days**.`); S.leadTold = mark; } }
  }
  const tot = {};   // a pilot's alt names share one line: the largest count wins
  ladder.forEach(x => { if (x.w == null || x.l == null) return; const k = key(x.p), n = x.w + x.l; if (tot[k] == null || n > tot[k]) tot[k] = n; });
  Object.entries(tot).forEach(([k, n]) => {
    const was = S.games[k], nm = disp[k] || nameOf((ladder.find(x => key(x.p) === k) || {}).p || k);
    if (!first && hadGames) {
      if (was == null) { if (n >= 1 && n <= 3) add(k, 2, `👋 Welcome ${link(nm)}: first pracs on the ladder.`); }
      else { const g = GAMES.filter(v => was < v && n >= v).pop(); if (g) add(k, 3, `🎖️ ${link(nm)} has played **${g} pracs**.`); }
    }
    if (was == null || n > was) S.games[k] = n;
  });

  // one line per pilot per run (the biggest one), most important first
  const byK = {}; ev.forEach(e => { if (!byK[e.k] || e.pr > byK[e.k].pr) byK[e.k] = e; });
  const lines = [...Object.values(byK), ...gev].sort((a, b) => b.pr - a.pr).slice(0, MAX_LINES).map(e => e.t);

  // daily recap of yesterday's pracs
  let recap = null; const yday = day(NOW - 864e5);
  if (first) S.recap = yday;
  else if (S.recap !== yday && new Date(NOW).getUTCHours() >= RECAP_HOUR) {
    const G = M.filter(m => m.date === yday);
    if (G.length >= RECAP_MIN_PRACS) {
      const A = {};
      G.forEach(m => m.P.forEach(r => { if (mins(r[13]) < 3) return; const k = key(r[0]); const o = A[k] = A[k] || { n: nameOf(r[0]), g: 0, w: 0, k: 0, d: 0, a: 0, chg: 0 }; o.g++; o.w += m.win === r[1] ? 1 : 0; o.k += r[2]; o.d += r[3]; o.a += r[4]; o.chg += r[15] || 0; }));
      const V = Object.values(A), top = (f, ok = () => true) => V.filter(ok).sort((a, b) => f(b) - f(a))[0];
      const out = [`**${G.length} pracs**, ${V.length} pilots.`];
      const w = top(o => o.w * 100 + o.w / o.g, o => o.g >= 3); if (w) out.push(`🏆 Most wins: ${link(w.n)} (${w.w}–${w.g - w.w})`);
      const c = top(o => o.chg, o => o.g >= 3); if (c && c.chg > 0) out.push(`🚀 Biggest climber: ${link(c.n)} (+${c.chg} rating in ${pl(c.g, "prac")})`);
      const f = top(o => o.k / o.g, o => o.g >= 4); if (f) out.push(`💥 Top fragger: ${link(f.n)} (${(f.k / f.g).toFixed(1)} kills per prac over ${f.g})`);
      const kd = top(o => (o.k + o.a) / Math.max(1, o.d), o => o.g >= 4); if (kd) out.push(`🎯 Best K+A/D: ${link(kd.n)} (${kd.k}-${kd.d}-${kd.a})`);
      const act = top(o => o.g); if (act) out.push(`⏱️ Most active: ${link(act.n)} (${pl(act.g, "prac")})`);
      const perf = V.filter(o => o.g >= 5 && o.w === o.g).sort((a, b) => b.g - a.g); if (perf.length) out.push(`✨ Perfect day: ${perf.slice(0, 3).map(o => `${link(o.n)} (${o.g}–0)`).join(", ")}`);
      const DP = {}; G.forEach(m => ["A", "B"].forEach(sd => { if (m.win !== sd) return; const T = m.P.filter(r => r[1] === sd && mins(r[13]) >= 3).map(r => nameOf(r[0])); for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) { const id = [T[i], T[j]].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1).join(" + "); DP[id] = (DP[id] || 0) + 1; } }));
      const duo = Object.entries(DP).sort((a, b) => b[1] - a[1])[0]; if (duo && duo[1] >= 4) out.push(`🤝 Duo of the day: **${md(duo[0])}** (${duo[1]} wins together)`);
      let best = null; G.forEach(m => m.P.forEach(r => { if (mins(r[13]) < 8) return; const v = r[2] * 2 + r[4] - r[3] * 2; if (!best || v > best.v) best = { v, n: nameOf(r[0]), l: `${r[2]}-${r[3]}-${r[4]}` }; }));
      if (best) out.push(`🎬 Game of the day: ${link(best.n)} (${best.l})`);
      recap = { title: `Prac recap · ${yday}`, text: out.join("\n") };
    }
    S.recap = yday;
  }

  const next = { ...S, v: 3, lastId: M.length ? Math.max(S.lastId, +M[M.length - 1].id) : S.lastId, top5: top5.length ? top5 : S.top5, leader: top5[0] || S.leader };
  const save = () => { if (DRY) return log("DRY=1: state not saved"); fs.writeFileSync(STATE, JSON.stringify(next)); };

  if (first) { save(); return log("first run: state recorded up to prac", next.lastId, "- nothing announced"); }
  if (!lines.length && !recap) { save(); return log("nothing new"); }
  lines.forEach(l => log("•", l));
  if (recap) { log("recap:", recap.title); recap.text.split("\n").forEach(l => log("  ", l)); }
  if (!HOOK || DRY) { save(); return log(HOOK ? "dry run" : "no DISCORD_WEBHOOK set: logged only"); }

  const embeds = [];
  if (lines.length) embeds.push({ title: "Prac highlights", url: SITE + "#prac", description: lines.join("\n"), color: 0xffd400 });
  if (recap) embeds.push({ title: recap.title, url: SITE + "#prac", description: recap.text, color: 0x5b9bff });
  embeds[embeds.length - 1].footer = { text: "playbook.ssrl.gg" };
  const body = { username: "Playbook", allowed_mentions: { parse: [] }, embeds };
  return fetch(HOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
    .then(r => { if (!r.ok) throw new Error("Discord answered " + r.status); save(); log("posted", lines.length, "line(s)" + (recap ? " and the daily recap" : "")); })
    .catch(e => { console.error("highlights: post failed, will retry next round:", e.message); process.exitCode = 1; });
}
Promise.resolve().then(main).catch(e => { console.error("highlights failed:", e.message); process.exitCode = 1; });
