"use strict";
const test = require("node:test");
const assert = require("node:assert");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildWindowsZip } = require("./windows-zip");

const REPO = path.resolve(__dirname, "..");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("the zip holds the start file, README.txt and the plugin without test/", function (t) {
  const out = tmp("rh-winzip-");
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const zip = buildWindowsZip({ version: "9.9.9", out, repo: REPO });
  assert.strictEqual(path.basename(zip), "placet-research-windows.zip");
  cp.execFileSync("/usr/bin/unzip", ["-q", zip, "-d", path.join(out, "x")]);
  const top = path.join(out, "x", "placet-research-9.9.9-windows");
  assert.deepStrictEqual(fs.readdirSync(top).sort(), ["README.txt", "Start placet-research.cmd", "placet-research"]);
  assert.ok(fs.existsSync(path.join(top, "placet-research", "bin", "placet-research.js")));
  assert.ok(fs.existsSync(path.join(top, "placet-research", "dashboard", "app.html")));
  assert.ok(!fs.existsSync(path.join(top, "placet-research", "test")));
  for (const name of ["Start placet-research.cmd", "README.txt"]) {
    const bytes = fs.readFileSync(path.join(top, name));
    assert.ok(bytes.every((b) => b < 128), name + " is ASCII");
    const text = bytes.toString("latin1");
    assert.strictEqual(text.split("\r\n").length - 1, text.split("\n").length - 1, name + " has CRLF on every line");
  }
  assert.match(fs.readFileSync(path.join(top, "Start placet-research.cmd"), "latin1"), /serve --app/);
});

test("the unzipped copy starts in app mode and serves the shell page", async function (t) {
  const out = tmp("rh-winzip-run-");
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  cp.execFileSync("/usr/bin/unzip", ["-q", buildWindowsZip({ version: "9.9.9", out, repo: REPO }), "-d", path.join(out, "x")]);
  const cli = path.join(out, "x", "placet-research-9.9.9-windows", "placet-research", "bin", "placet-research.js");
  const child = cp.spawn(process.execPath, [cli, "serve", "--app", "--no-open", "--app-data", tmp("rh-winzip-data-")], { cwd: out });
  t.after(() => child.kill());
  let text = "";
  for await (const chunk of child.stdout) { text += chunk; if (/#c=[0-9a-f]{32}/.test(text)) break; }
  const url = new URL(text.match(/http:\/\/\S+/)[0]);
  const res = await fetch(url.origin + "/app");
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /<html/);
});

test("a missing version exits 2", function () {
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, "windows-zip.js")], { encoding: "utf8" });
  assert.strictEqual(r.status, 2);
});
