// Functional tests for prod_guard.user.js in jsdom.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "prod_guard.user.js"), "utf8");

function boot({ url, envName }) {
  const html = `<body>
    <nav>
      <button>FarmNet</button>
      <button id="env">${envName}</button>
    </nav>
    <main><h1>FarmNet</h1><p>Some environment</p></main>
  </body>`;
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  dom.window.requestAnimationFrame = (cb) => dom.window.setTimeout(cb, 0);
  dom.window.eval(source);
  return dom;
}

const PROJECT_URL = "https://deploy-dev.techcoop.dev/dashboard/project/abc/environment/xyz";
const overlay = (dom) => dom.window.document.getElementById("__prod_guard_host__");
const settle = (dom) => new Promise((r) => dom.window.setTimeout(r, 20));

test("overlay shows when env is production", () => {
  const dom = boot({ url: PROJECT_URL, envName: "production" });
  assert.ok(overlay(dom), "overlay missing on production env");
  assert.match(overlay(dom).textContent, /PRODUCTION/);
});

test("overlay also recognises 'prod'", () => {
  const dom = boot({ url: PROJECT_URL, envName: "prod" });
  assert.ok(overlay(dom), "overlay missing for env named prod");
});

test("no overlay on non-production env", () => {
  const dom = boot({ url: PROJECT_URL, envName: "preprod" });
  assert.equal(overlay(dom), null);
});

test("no overlay outside project pages even if text matches", () => {
  const dom = boot({
    url: "https://deploy-dev.techcoop.dev/dashboard/projects",
    envName: "production"
  });
  assert.equal(overlay(dom), null);
});

test("overlay appears when SPA switches env to production", async () => {
  const dom = boot({ url: PROJECT_URL, envName: "preprod" });
  assert.equal(overlay(dom), null);

  dom.window.document.getElementById("env").textContent = "production";
  await settle(dom);
  assert.ok(overlay(dom), "overlay did not appear after switching to production");
});

test("overlay disappears when switching away from production", async () => {
  const dom = boot({ url: PROJECT_URL, envName: "production" });
  assert.ok(overlay(dom));

  dom.window.document.getElementById("env").textContent = "staging";
  await settle(dom);
  assert.equal(overlay(dom), null, "overlay stuck after leaving production");
});

test("description text like 'Farmnet PRODUCTION' does not trigger overlay", () => {
  const dom = new JSDOM(
    `<body><nav><button>FarmNet</button><button>preprod</button></nav>
     <p>Farmnet PRODUCTION (cutover from alpha)</p></body>`,
    { url: PROJECT_URL, runScripts: "outside-only" }
  );
  dom.window.requestAnimationFrame = (cb) => dom.window.setTimeout(cb, 0);
  dom.window.eval(source);
  assert.equal(dom.window.document.getElementById("__prod_guard_host__"), null);
});
