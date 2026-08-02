// Every *.user.js must carry a valid Tampermonkey metadata block and parse as JS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = readdirSync(root).filter((f) => f.endsWith(".user.js"));

test("repo contains userscripts", () => {
  assert.ok(scripts.length >= 4, `expected at least 4 userscripts, got ${scripts.length}`);
});

for (const file of scripts) {
  const source = readFileSync(path.join(root, file), "utf8");

  test(`${file}: metadata block`, () => {
    assert.match(source, /^\/\/ ==UserScript==$/m, "missing ==UserScript== opener");
    assert.match(source, /^\/\/ ==\/UserScript==$/m, "missing ==/UserScript== closer");

    const block = source.split("// ==UserScript==")[1].split("// ==/UserScript==")[0];
    const tags = {};
    for (const line of block.split("\n")) {
      const m = line.match(/^\/\/ @(\S+)\s+(.+)$/);
      if (m) (tags[m[1]] ||= []).push(m[2].trim());
    }

    for (const required of ["name", "version", "match", "run-at"]) {
      assert.ok(tags[required], `missing @${required}`);
    }
    assert.match(tags.version[0], /^\d+\.\d+(\.\d+)?$/, "@version not semver-ish");
    for (const m of tags.match) {
      assert.match(m, /^(\*|https?):\/\/[^\s]+$/, `@match "${m}" malformed`);
    }
    assert.ok(
      ["document-start", "document-end", "document-idle"].includes(tags["run-at"][0]),
      `@run-at "${tags["run-at"][0]}" invalid`
    );
  });

  test(`${file}: valid JavaScript`, () => {
    const res = spawnSync(process.execPath, ["--check", path.join(root, file)], {
      encoding: "utf8"
    });
    assert.equal(res.status, 0, res.stderr);
  });
}
