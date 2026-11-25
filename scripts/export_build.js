#!/usr/bin/env node
/* Builds data.json's `export` object and `boxCols` for Premier Manager.
   It opens site/index.html in a headless browser with the repo's current data.json and prac.json,
   calls the page's own ppExport(), and writes the result into data.json. The numbers are therefore
   always the same ones the Playbook shows. Nothing else in data.json is touched.

   Usage:  node scripts/export_build.js [--also site/data.json]
   Needs:  npm install --no-save playwright-core   (uses the Chrome already on the machine)
   Env:    CHROME_PATH=/path/to/chrome   to pick a specific browser binary */
const fs = require("fs"), path = require("path"), http = require("http");
const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(ROOT, "site");
const DATA = path.join(ROOT, "data.json");
const PRAC = path.join(ROOT, "prac.json");
const also = process.argv.includes("--also") ? path.resolve(ROOT, process.argv[process.argv.indexOf("--also") + 1]) : null;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "export:", ...a);
const MIME = { html: "text/html", json: "application/json", js: "text/javascript", png: "image/png", jpg: "image/jpeg", webmanifest: "application/json" };

function serve() {
  return new Promise(res => {
    const srv = http.createServer((q, r) => {
      let f = decodeURIComponent(q.url.split("?")[0]); if (f === "/") f = "/index.html";
      // the page's own data.json request gets the repo's live copy, not the site/ snapshot
      const fp = f === "/data.json" ? DATA : path.join(SITE, path.normalize(f).replace(/^(\.\.[\/\\])+/, ""));
      if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { "content-type": MIME[fp.split(".").pop()] || "application/octet-stream", "cache-control": "no-store" });
      fs.createReadStream(fp).pipe(r);
    }).listen(0, "127.0.0.1", () => res(srv));
  });
}

// the export without its timestamp, so an unchanged export doesn't make a new commit
const core = e => { if (!e) return ""; const c = { ...e }; delete c.at; return JSON.stringify(c); };

(async () => {
  const { chromium } = require("playwright-core");
  const srv = await serve(), port = srv.address().port;
  const opts = { headless: true, args: ["--no-sandbox"] };
  if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH; else opts.channel = "chrome";
  const browser = await chromium.launch(opts);
  try {
    const ctx = await browser.newContext({ serviceWorkers: "block" });
    // the page reads league and prac data from GitHub: hand it the files in this checkout instead
    await ctx.route("**/raw.githubusercontent.com/**", r => {
      const u = r.request().url();
      const f = /\/prac\.json/.test(u) ? PRAC : /\/data\.json/.test(u) ? DATA : null;
      if (!f || !fs.existsSync(f)) return r.abort();
      r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: fs.readFileSync(f) });
    });
    // no shared sheet, fonts or other outside calls while building
    await ctx.route(u => !/^(127\.0\.0\.1|raw\.githubusercontent\.com)$/.test(u.hostname), r => r.abort());
    const page = await ctx.newPage();
    const errs = []; page.on("pageerror", e => errs.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem("pp-ui", JSON.stringify({ hangar: "off" })); sessionStorage.setItem("pp-gate-skip", "1"); } catch (e) {} });
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof D !== "undefined" && D && D.box && typeof X !== "undefined" && X.st && typeof ppExport === "function", null, { timeout: 90000 });
    // wait until the page has merged prac.json (the first paint may use the league file alone)
    const want = fs.existsSync(PRAC) ? (JSON.parse(fs.readFileSync(PRAC, "utf8")).pracMatches || []).length : 0;
    await page.waitForFunction(n => (D.pracMatches || []).length >= n, want, { timeout: 60000 }).catch(() => log("prac.json not merged in time; using what the page has"));
    const out = await page.evaluate(() => ({ export: ppExport(), boxCols: BOX_COLS, boxWidth: (D.box[0] || []).length }));
    if (!out.export || !Array.isArray(out.export.pilots) || !out.export.pilots.length) throw new Error("empty export");
    if (out.boxCols.length !== out.boxWidth) throw new Error(`boxCols has ${out.boxCols.length} names but box rows have ${out.boxWidth} columns`);

    for (const file of [DATA, also].filter(Boolean)) {
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      if (core(d.export) === core(out.export) && JSON.stringify(d.boxCols) === JSON.stringify(out.boxCols)) { log(path.relative(ROOT, file), "unchanged"); continue; }
      d.boxCols = out.boxCols; d.export = out.export;
      fs.writeFileSync(file, JSON.stringify(d));
      log(path.relative(ROOT, file), "updated:", out.export.pilots.length, "pilots,", out.export.pairs.length, "pairs,", out.export.teams.length, "teams");
    }
    if (errs.length) log("page errors (ignored):", errs.slice(0, 3).join(" | "));
  } finally { await browser.close(); srv.close(); }
})().catch(e => { console.error("export failed:", e.message); process.exit(1); });
