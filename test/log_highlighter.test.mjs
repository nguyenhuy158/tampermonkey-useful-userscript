// Functional tests for log_highlighter.user.js running in a jsdom page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "log_highlighter.user.js"), "utf8");

const SAMPLE_LINES = [
  '2026-08-02 10:23:45,903 14 INFO farmnet_service_preprod werkzeug: 127.0.0.1 - - [02/Aug/2026 10:23:45] "GET /web/login HTTP/1.1" 200 - 11 0.027 0.032',
  '2026-08-02 10:24:16,402 14 ERROR farmnet_service_preprod odoo.sql_db: bad query',
  '2026-08-02 10:25:34,669 14 INFO farmnet_service_preprod werkzeug: 45.79.236.121 - - [02/Aug/2026 10:25:34] "GET / HTTP/1.1" 303 - 4 0.014 0.038',
  '2026-08-02 10:26:10,323 14 WARNING farmnet_service_preprod werkzeug: 172.188.170.111 - - [02/Aug/2026 10:26:10] "POST /xmlrpc/2/object HTTP/1.1" 500 - 3 0.028 0.039'
];

async function bootDom(html) {
  const dom = new JSDOM(html, { url: "https://deploy-dev.techcoop.dev/dashboard", runScripts: "outside-only" });
  dom.window.eval(source);
  // the userscript defers to DOMContentLoaded when the document is still parsing
  if (dom.window.document.readyState === "loading") {
    await new Promise((resolve) => dom.window.addEventListener("DOMContentLoaded", resolve));
  }
  await new Promise((r) => dom.window.setTimeout(r, 0));
  return dom;
}

function bootPage() {
  return bootDom(
    `<body><div id="logs">${SAMPLE_LINES.map((l) => `<div>${l}</div>`).join("")}</div></body>`
  );
}

function spansByText(dom, text) {
  return [...dom.window.document.querySelectorAll("span[style]")].filter(
    (s) => s.textContent === text
  );
}

test("log levels get colorized", async () => {
  const dom = await bootPage();
  const error = spansByText(dom, "ERROR");
  assert.ok(error.length, "ERROR not wrapped");
  assert.match(error[0].getAttribute("style"), /#dc2626/);

  const warning = spansByText(dom, "WARNING");
  assert.ok(warning.length, "WARNING not wrapped");
  assert.match(warning[0].getAttribute("style"), /#f59e0b/);

  const info = spansByText(dom, "INFO");
  assert.ok(info.length, "INFO not wrapped");
  assert.match(info[0].getAttribute("style"), /#2563eb/);
});

test("HTTP status codes colorized by class", async () => {
  const dom = await bootPage();
  assert.match(spansByText(dom, "200")[0].getAttribute("style"), /#16a34a/, "2xx not green");
  assert.match(spansByText(dom, "303")[0].getAttribute("style"), /#d97706/, "3xx not orange");
  assert.match(spansByText(dom, "500")[0].getAttribute("style"), /#dc2626/, "5xx not red");
});

test("HTTP methods and IPs colorized", async () => {
  const dom = await bootPage();
  assert.match(spansByText(dom, "GET")[0].getAttribute("style"), /#7c3aed/);
  assert.match(spansByText(dom, "POST")[0].getAttribute("style"), /#7c3aed/);
  assert.match(spansByText(dom, "127.0.0.1")[0].getAttribute("style"), /#0891b2/);
});

test("timestamp-like numbers are not painted as status codes", async () => {
  const dom = await bootPage();
  // "303" only exists as a status; the durations "0.027"/"0.032" must stay plain.
  const painted = [...dom.window.document.querySelectorAll("span[style]")].map(
    (s) => s.textContent
  );
  assert.ok(!painted.includes("0.027"));
  assert.ok(!painted.includes("11"));
});

test("streamed log lines get highlighted via MutationObserver", async () => {
  const dom = await bootPage();
  const { document } = dom.window;
  const line = document.createElement("div");
  line.textContent =
    '2026-08-02 10:30:00,000 14 ERROR farmnet_service_preprod werkzeug: "DELETE /api HTTP/1.1" 404 - 1 0.010 0.011';
  document.getElementById("logs").appendChild(line);

  await new Promise((r) => dom.window.setTimeout(r, 0));

  assert.ok(spansByText(dom, "404").length, "streamed 404 not highlighted");
  assert.ok(spansByText(dom, "DELETE").length, "streamed DELETE not highlighted");
});

test("log content is HTML-escaped before highlighting", async () => {
  const dom = await bootDom(
    `<body><div id="logs"><div>ERROR &lt;img src=x onerror=alert(1)&gt; boom</div></div></body>`
  );
  assert.equal(dom.window.document.querySelector("img"), null, "injected element must not render");
  assert.ok(spansByText(dom, "ERROR").length, "ERROR still highlighted");
});

test("already-processed nodes are not re-wrapped", async () => {
  const dom = await bootPage();
  const before = dom.window.document.querySelectorAll("span[data-tclh]").length;
  // touch DOM to trigger the observer again
  dom.window.document.body.appendChild(dom.window.document.createElement("i"));
  await new Promise((r) => dom.window.setTimeout(r, 0));
  const after = dom.window.document.querySelectorAll("span[data-tclh]").length;
  assert.equal(after, before, "observer reprocessed existing spans");
});
