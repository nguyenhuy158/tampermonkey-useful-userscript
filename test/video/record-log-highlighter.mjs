// Video "robot" test: runs log_highlighter.user.js in a real Chromium,
// streams fake dashboard log lines, asserts the highlighting and records
// the whole session to test/video/out/*.webm.
//
// Run: npm run test:video

import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(path.join(root, "log_highlighter.user.js"), "utf8");
const outDir = path.join(root, "test/video/out");
mkdirSync(outDir, { recursive: true });

const PAGE = `<!doctype html>
<html>
<head><style>
  * { box-sizing:border-box; }
  body { background:#0b0f19; color:#cbd5e1; font:17px/1.8 ui-monospace,Menlo,monospace; margin:0; }
  /* fake browser chrome — Playwright only records the page, not the real URL bar */
  #chrome {
    display:flex; align-items:center; gap:14px;
    background:#1c2333; border-bottom:1px solid #2a3348; padding:12px 18px;
    font-family:ui-sans-serif,system-ui;
  }
  #dots { display:flex; gap:8px; }
  #dots i { width:13px; height:13px; border-radius:50%; display:block; }
  #urlbar {
    flex:1; background:#0f172a; border:1px solid #2a3348; border-radius:999px;
    padding:9px 20px; color:#94a3b8; font-size:15px;
  }
  #urlbar b { color:#e2e8f0; font-weight:600; }
  #tm { font-size:15px; color:#94a3b8; }
  #wrap { padding:28px 36px; }
  h1 { color:#e2e8f0; font-size:22px; margin:0 0 6px; font-family:ui-sans-serif,system-ui; }
  p  { color:#64748b; margin:0 0 22px; font-family:ui-sans-serif,system-ui; font-size:15px; }
  #logs { border:1px solid #1e293b; border-radius:8px; padding:20px 24px; background:#0f172a; min-height:740px; }
  #logs div { white-space:pre-wrap; }
</style></head>
<body>
  <div id="chrome">
    <span id="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></span>
    <span id="urlbar">🔒 <b>deploy-dev.techcoop.dev</b>/dashboard/project/farmnet/environment/preprod/services/odoo?tab=logs</span>
    <span id="tm">🐒 Tampermonkey: Log Highlighter ✅</span>
  </div>
  <div id="wrap">
    <h1>Log Highlighter — robot demo</h1>
    <p>userscript injected, log lines streamed one by one (như log viewer thật)</p>
    <div id="logs"></div>
  </div>
</body>
</html>`;

const LINES = [
  '2026-08-02 10:23:45,903 14 INFO farmnet_service_preprod werkzeug: 127.0.0.1 - - [02/Aug/2026 10:23:45] "GET /web/login HTTP/1.1" 200 - 11 0.027 0.032',
  '2026-08-02 10:24:16,402 14 INFO farmnet_service_preprod werkzeug: 127.0.0.1 - - [02/Aug/2026 10:24:16] "GET /web/session/authenticate HTTP/1.1" 200 - 11 0.048 0.050',
  '2026-08-02 10:24:53,264 14 DEBUG farmnet_service_preprod odoo.modules.loading: loading 142 modules...',
  '2026-08-02 10:25:34,669 14 INFO farmnet_service_preprod werkzeug: 45.79.236.121 - - [02/Aug/2026 10:25:34] "GET / HTTP/1.1" 303 - 4 0.014 0.038',
  '2026-08-02 10:25:36,262 14 WARNING farmnet_service_preprod odoo.http: Session expired for user 14, redirecting to login',
  '2026-08-02 10:26:10,323 14 INFO farmnet_service_preprod werkzeug: 172.188.170.111 - - [02/Aug/2026 10:26:10] "POST /xmlrpc/2/object HTTP/1.1" 200 - 3 0.028 0.039',
  '2026-08-02 10:26:12,868 14 ERROR farmnet_service_preprod odoo.sql_db: bad query: SELECT missing_col FROM res_partner',
  "Traceback (most recent call last):",
  '  File "/usr/lib/python3/odoo/sql_db.py", line 321, in execute',
  '2026-08-02 10:26:43,059 14 INFO farmnet_service_preprod werkzeug: 127.0.0.1 - - [02/Aug/2026 10:26:43] "DELETE /api/v1/cache HTTP/1.1" 404 - 1 0.010 0.011',
  '2026-08-02 10:26:46,107 14 INFO farmnet_service_preprod werkzeug: 127.0.0.1 - - [02/Aug/2026 10:26:46] "POST /web/dataset/call_kw HTTP/1.1" 500 - 3 0.013 0.036',
  '2026-08-02 10:27:01,551 14 CRITICAL farmnet_service_preprod odoo.service.server: Failed to start worker, retrying'
];

// HEADED=1 opens a visible browser window (video still records only the page)
const browser = await chromium.launch({ headless: !process.env.HEADED });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: outDir, size: { width: 1920, height: 1080 } }
});
const page = await context.newPage();

await page.setContent(PAGE);
await page.addScriptTag({ content: source });
await page.waitForTimeout(1500);

for (const line of LINES) {
  await page.evaluate((text) => {
    const div = document.createElement("div");
    div.textContent = text;
    document.getElementById("logs").appendChild(div);
  }, line);
  await page.waitForTimeout(350);
}

// let the MutationObserver finish, then verify highlighting on screen
await page.waitForTimeout(800);

const check = await page.evaluate(() => {
  const spans = [...document.querySelectorAll("#logs span[style]")];
  const byText = (t) => spans.filter((s) => s.textContent === t);
  return {
    total: spans.length,
    error: byText("ERROR").length,
    warning: byText("WARNING").length,
    critical: byText("CRITICAL").length,
    ok200: byText("200").length,
    notFound404: byText("404").length,
    fail500: byText("500").length,
    get: byText("GET").length,
    ip: byText("127.0.0.1").length
  };
});

await page.waitForTimeout(2500);
const video = page.video();
await context.close();
await browser.close();

assert.ok(check.total > 20, `too few highlighted spans: ${check.total}`);
assert.ok(check.error >= 1, "ERROR not highlighted");
assert.ok(check.warning >= 1, "WARNING not highlighted");
assert.ok(check.critical >= 1, "CRITICAL not highlighted");
assert.ok(check.ok200 >= 1, "status 200 not highlighted");
assert.ok(check.notFound404 >= 1, "status 404 not highlighted");
assert.ok(check.fail500 >= 1, "status 500 not highlighted");
assert.ok(check.get >= 1, "GET method not highlighted");
assert.ok(check.ip >= 1, "IP not highlighted");

const videoPath = await video.path();
console.log("assertions:", JSON.stringify(check));
console.log("video:", videoPath);
