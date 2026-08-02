// Functional tests for health_monitor.user.js: run in jsdom with stubbed GM_* APIs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "health_monitor.user.js"), "utf8");

// Boots the userscript with GM stubs. `responder` decides each request's outcome.
function boot({ responder, sites }) {
  const dom = new JSDOM("<body></body>", {
    url: "https://example.com/",
    runScripts: "outside-only"
  });
  const w = dom.window;
  const store = new Map();
  if (sites) store.set("sites", sites);
  const notifications = [];
  const requests = [];

  w.GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
  w.GM_setValue = (k, v) => store.set(k, v);
  w.GM_notification = (opts) => notifications.push(opts);
  w.GM_registerMenuCommand = () => {};
  w.GM_addValueChangeListener = () => {};
  w.GM_xmlhttpRequest = (req) => {
    requests.push(req.url);
    w.setTimeout(() => responder(req), 0);
  };

  w.eval(source);
  OPEN_DOMS.push(dom);
  return { dom, w, store, notifications, requests };
}

const tickAsync = (w, ms = 10) => new Promise((r) => w.setTimeout(r, ms));

// The userscript schedules a recurring poll timer; close every jsdom window when
// the suite ends (even on failures) or the intervals keep the process alive.
const OPEN_DOMS = [];
after(() => {
  for (const dom of OPEN_DOMS) dom.window.close();
});

const SITES = [{ name: "Deploy", url: "https://deploy-dev.techcoop.dev", interval: 60, timeout: 5 }];

test("widget renders and site goes green on HTTP 200", async () => {
  const ctx = boot({
    sites: SITES,
    responder: (req) => req.onload({ status: 200 })
  });
  await tickAsync(ctx.w);

  const shadow = ctx.dom.window.document.getElementById("__health_monitor_host__").shadowRoot;
  assert.ok(shadow.querySelector("#pill"), "pill widget missing");
  assert.ok(shadow.querySelector(".dot.up"), "dot not green after 200");
});

test("site goes red on HTTP 500 and history records it", async () => {
  const ctx = boot({
    sites: SITES,
    responder: (req) => req.onload({ status: 500 })
  });
  await tickAsync(ctx.w);

  const shadow = ctx.dom.window.document.getElementById("__health_monitor_host__").shadowRoot;
  assert.ok(shadow.querySelector(".dot.down"), "dot not red after 500");
  const hist = ctx.store.get("hist:https://deploy-dev.techcoop.dev");
  assert.equal(hist.length, 1);
  assert.equal(hist[0].up, false);
});

test("network error marks site down", async () => {
  const ctx = boot({
    sites: SITES,
    responder: (req) => req.onerror()
  });
  await tickAsync(ctx.w);
  const shadow = ctx.dom.window.document.getElementById("__health_monitor_host__").shadowRoot;
  assert.ok(shadow.querySelector(".dot.down"), "dot not red after network error");
});

test("notifies only on up→down transition, not on first result", async () => {
  let status = 200;
  const ctx = boot({
    sites: [{ ...SITES[0], interval: 1 }],
    responder: (req) => req.onload({ status })
  });
  await tickAsync(ctx.w);
  assert.equal(ctx.notifications.length, 0, "must not notify on first check");
  assert.equal(ctx.store.get("results")[SITES[0].url].up, true);

  // flip the backend to failing and wait for the next 5s poll tick
  status = 500;
  await tickAsync(ctx.w, 5200);

  assert.equal(ctx.notifications.length, 1, "must notify on transition");
  assert.match(ctx.notifications[0].title, /DOWN/);
});

test("leader election: single tab claims leadership", async () => {
  const ctx = boot({ sites: SITES, responder: (req) => req.onload({ status: 200 }) });
  assert.ok(ctx.store.get("leader"), "tab did not claim leadership");
});
