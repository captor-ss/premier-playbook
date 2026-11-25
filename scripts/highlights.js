#!/usr/bin/env node
/* Prac highlights for Discord.
   Reads prac.json after each sync, finds new milestones and posts them to a Discord channel
   through a webhook. What it has already handled is kept in highlights_state.json, so nothing
   is announced twice.

   Milestones:
     - win streak reaching 5, 8, 10, 15 or 20 pracs
     - a flawless prac: 0 deaths over 8+ minutes
     - a pilot reaching a new rating tier for the first time (Gold, Platinum, Diamond, ...)
     - a new #1 on the prac ladder
     - a pilot entering the top 5 of the prac ladder

   Env:  DISCORD_WEBHOOK  the channel's webhook URL (GitHub secret). Without it the script only
                          logs what it would post (dry run) and still records it as handled.
         DRY=1            log only, and do not save the state (for testing)
   No dependencies: Node 18+ (built-in fetch). */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const PRAC = path.join(ROOT, "prac.json"), DATA = path.join(ROOT, "data.json"), STATE = path.join(ROOT, "highlights_state.json");
const SITE = "https://playbook.ssrl.gg/";
const HOOK = process.env.DISCORD_WEBHOOK || "", DRY = process.env.DRY === "1";
const STREAKS = [5, 8, 10, 15, 20];
const TIERS = [["Iron", 0], ["Bronze", 100], ["Silver", 150], ["Gold", 200], ["Platinum", 250], ["Diamond", 300], ["Master", 350], ["Grandmaster", 400], ["Challenger", 450]];
const MIN_TIER = 3;          // tiers below Gold are not announced
const MAX_AGE_H = 36;        // pracs older than this are recorded but not announced
const MAX_LINES = 8;         // most lines in one post
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "highlights:", ...a);

const tierIdx = r => { let i = 0; TIERS.forEach((t, k) => { if (r >= t[1]) i = k; }); return i; };
const mins = v => { const [a, b] = String(v || "0").split(":").map(Number); return (a || 0) + (b || 0) / 60; };
const md = s => String(s).replace(/([\\*_~`|>\[\]()])/g, "\\$1");
const link = n => `[**${md(n)}**](${SITE}#player/${encodeURIComponent(n)})`;

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
  if (first) S = { v: 1, lastId: 0, tiers: {}, top5: [], leader: null };

  // walk every prac once: streaks and best tier so far; collect events for the new ones
  const streak = {}, disp = {}, ev = [], now = Date.now();
  const isNew = m => !first && +m.id > S.lastId;
  const fresh = m => { const t = Date.parse(m.at || (m.date + "T12:00:00Z")); return isFinite(t) && now - t <= MAX_AGE_H * 36e5; };
  M.forEach(m => {
    const announce = isNew(m) && fresh(m);
    m.P.forEach(r => {
      const k = key(r[0]); disp[k] = nameOf(r[0]);
      if (mins(r[13]) < 3) return;
      const won = m.win === r[1];
      streak[k] = won ? (streak[k] || 0) + 1 : 0;
      if (announce && won && STREAKS.includes(streak[k])) ev.push({ k, pr: 3, t: `🔥 ${link(disp[k])} has won **${streak[k]} pracs in a row**.` });
      if (announce && r[3] === 0 && mins(r[13]) >= 8) ev.push({ k, pr: 2, t: `👻 ${link(disp[k])} went **untouchable**: ${r[2]} kill${r[2] === 1 ? "" : "s"}, 0 deaths in ${r[13]}${won ? " (win)" : ""}.` });
      if (r[14] != null) {
        const ti = tierIdx(+r[14]), best = S.tiers[k] == null ? -1 : S.tiers[k];
        if (ti > best) {
          if (announce && ti >= MIN_TIER && best >= 0) ev.push({ k, pr: 4, t: `📈 ${link(disp[k])} reached **${TIERS[ti][0]}** for the first time (rating ${r[14]}).` });
          S.tiers[k] = ti;
        }
      }
    });
  });

  // ladder: new #1 and new faces in the top 5
  if (!first && top5.length) {
    const lead = top5[0];
    if (S.leader && lead.toLowerCase() !== S.leader.toLowerCase()) ev.push({ k: lead.toLowerCase(), pr: 5, t: `👑 ${link(lead)} is the **new #1** on the prac ladder (rating ${ladder[0].r}), passing ${md(S.leader)}.` });
    const old = new Set((S.top5 || []).map(n => n.toLowerCase()));
    if (old.size) top5.forEach((n, i) => { if (i > 0 && !old.has(n.toLowerCase())) ev.push({ k: n.toLowerCase(), pr: 1, t: `⭐ ${link(n)} moved into the **top 5** of the prac ladder (#${i + 1}, rating ${ladder[i].r}).` }); });
  }

  // one line per pilot per run (the biggest one), most important first
  const byK = {}; ev.forEach(e => { if (!byK[e.k] || e.pr > byK[e.k].pr) byK[e.k] = e; });
  const lines = Object.values(byK).sort((a, b) => b.pr - a.pr).slice(0, MAX_LINES).map(e => e.t);

  const next = { ...S, lastId: M.length ? Math.max(S.lastId, +M[M.length - 1].id) : S.lastId, top5: top5.length ? top5 : S.top5, leader: top5[0] || S.leader };
  const save = () => { if (DRY) return log("DRY=1: state not saved"); fs.writeFileSync(STATE, JSON.stringify(next)); };

  if (first) { save(); return log("first run: state recorded up to prac", next.lastId, "- nothing announced"); }
  if (!lines.length) { save(); return log("nothing new"); }
  lines.forEach(l => log("•", l));
  if (!HOOK || DRY) { save(); return log(HOOK ? "dry run" : "no DISCORD_WEBHOOK set: logged only"); }

  const body = { username: "Playbook", allowed_mentions: { parse: [] },
    embeds: [{ title: "Prac highlights", url: SITE + "#prac", description: lines.join("\n"), color: 0xffd400, footer: { text: "playbook.ssrl.gg" } }] };
  return fetch(HOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
    .then(r => { if (!r.ok) throw new Error("Discord answered " + r.status); save(); log("posted", lines.length, "line(s)"); })
    .catch(e => { console.error("highlights: post failed, will retry next round:", e.message); process.exitCode = 1; });
}
Promise.resolve().then(main).catch(e => { console.error("highlights failed:", e.message); process.exitCode = 1; });
