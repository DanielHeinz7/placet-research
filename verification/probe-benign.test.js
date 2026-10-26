"use strict";
// node --test verification/probe-benign.test.js
//
// The replay's counts are what scripts/release.js reads, so a run that
// replayed nothing must not read as a pass. Each case writes a synthetic
// corpus into a throwaway directory and replays it through the real hook:
// an empty corpus and a corpus whose every row is skipped fail, and one row
// that is ALLOWed passes. Nothing here holds session data.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROBE = path.join(__dirname, "probes", "probe-benign.js");

// The probe hands its own environment to the hook; CLAUDE_PROJECT_DIR and
// PLACET_RESEARCH_DIR would point the replay at this session's project
// instead of the corpus rows.
const ENV = (function () {
  const env = Object.assign({}, process.env);
  delete env.CLAUDE_PROJECT_DIR;
  delete env.PLACET_RESEARCH_DIR;
  return env;
})();

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "probe-benign-"));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

function writeCorpus(root, name, rows) {
  const file = path.join(root, name);
  const body = rows.map(function (r) { return JSON.stringify(r); }).join("\n");
  fs.writeFileSync(file, body ? body + "\n" : "");
  return file;
}

function replay(file) {
  const run = spawnSync(process.execPath, [PROBE, "--corpus", file], { encoding: "utf8", env: ENV });
  return { status: run.status, stdout: run.stdout || "", stderr: run.stderr || "" };
}

// Copy the real probe into a tiny repo so its normal GUARD path reaches a
// fixture process, without adding a production hook override. The watchdog
// bounds a regression; cleanup also reaps a hook left by a broken probe.
function hookFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "probe-hook-"));
  const hooks = path.join(root, "plugins", "placet-research", "hooks");
  const probe = path.join(root, "verification", "probes", "probe-benign.js");
  const pidFile = path.join(root, "hook.pid");
  fs.mkdirSync(path.dirname(probe), { recursive: true });
  fs.mkdirSync(path.join(hooks, "lib"), { recursive: true });
  fs.copyFileSync(PROBE, probe);
  fs.copyFileSync(path.join(__dirname, "..", "plugins", "placet-research", "hooks", "lib", "project.js"), path.join(hooks, "lib", "project.js"));
  fs.writeFileSync(path.join(hooks, "guard-promotion.js"),
    'let input = ""; process.stdin.on("data", b => input += b); process.stdin.on("end", () => {\n'
    + 'const command = JSON.parse(input).tool_input.command;\n'
    + 'if (command === "error") { process.stderr.write("synthetic-private-error"); process.exit(1); }\n'
    + 'if (command !== "synthetic-private-hang") return;\n'
    + 'require("node:fs").writeFileSync(' + JSON.stringify(pidFile) + ', String(process.pid));\n'
    + 'process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:"deny",permissionDecisionReason:"synthetic-private-reason"}}));\n'
    + 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n'
    + '});\n');
  t.after(function () {
    if (fs.existsSync(pidFile)) {
      try { process.kill(+fs.readFileSync(pidFile, "utf8"), "SIGKILL"); } catch (e) { assert.strictEqual(e.code, "ESRCH"); }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root: root, probe: probe, pidFile: pidFile };
}

test("runHook covers timeout precedence and reaps a blocked hook in-process", async function (t) {
  const probe = require(PROBE);
  assert.strictEqual(typeof probe.runHook, "function", "runHook must be directly testable");
  const fx = hookFixture(t);
  const guard = path.join(fx.root, "plugins", "placet-research", "hooks", "guard-promotion.js");
  const verdict = await probe.runHook(fx.root, "synthetic-private-hang", 1000, guard);
  assert.deepStrictEqual(verdict, { decision: "TIMEOUT", reason: "hook exceeded 1000 ms" });
  const pid = +fs.readFileSync(fx.pidFile, "utf8");
  assert.throws(function () { process.kill(pid, 0); }, { code: "ESRCH" });
});

test("runHook classifies completed hook output in-process", async function (t) {
  const probe = require(PROBE);
  assert.strictEqual(typeof probe.runHook, "function", "runHook must be directly testable");
  const fx = hookFixture(t);
  const guard = path.join(fx.root, "plugins", "placet-research", "hooks", "guard-promotion.js");
  fs.writeFileSync(guard, 'process.stdin.resume();\n');
  assert.deepStrictEqual(await probe.runHook(fx.root, "", 1000, guard), { decision: "ALLOW", reason: "" });
  fs.writeFileSync(guard, 'process.stdin.resume(); process.stderr.write("fixture error"); process.exitCode = 1;\n');
  assert.deepStrictEqual(await probe.runHook(fx.root, "", 1000, guard), { decision: "HOOKERR", reason: "fixture error" });
  fs.writeFileSync(guard, 'process.stdin.resume(); process.stdout.write("not json");\n');
  assert.deepStrictEqual(await probe.runHook(fx.root, "", 1000, guard), { decision: "HOOKERR", reason: "unparseable: not json" });
  fs.writeFileSync(guard, 'process.stdin.resume(); process.stdout.write(\'{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"fixture denial"}}\');\n');
  assert.deepStrictEqual(await probe.runHook(fx.root, "", 1000, guard), { decision: "DENY", reason: "fixture denial" });
  fs.writeFileSync(guard, 'process.stdin.resume(); process.stdout.write(\'{"hookSpecificOutput":{"permissionDecision":"allow"}}\');\n');
  assert.deepStrictEqual(await probe.runHook(fx.root, "", 1000, guard), { decision: "ALLOW", reason: "" });
  fs.writeFileSync(guard, 'process.stdin.resume(); process.stdout.write("{}");\n');
  assert.deepStrictEqual(await probe.runHook(fx.root, "", 1000, guard), { decision: "ALLOW", reason: "" });
});

test("timeout and hook-error tallies independently fail the replay", function () {
  const probe = require(PROBE);
  assert.strictEqual(typeof probe.tallyFailure, "function", "failure tally must be directly testable");
  const tally = { hookErr: 0, timeouts: 0 };
  probe.tallyFailure(tally, "ALLOW");
  assert.deepStrictEqual(tally, { hookErr: 0, timeouts: 0 });
  assert.strictEqual(probe.replayFailed(1, 0, tally), 0);
  probe.tallyFailure(tally, "TIMEOUT");
  assert.deepStrictEqual(tally, { hookErr: 0, timeouts: 1 });
  assert.strictEqual(probe.replayFailed(1, 0, tally), 1, "TIMEOUT must fail without an expectation");
  probe.tallyFailure(tally, "HOOKERR");
  assert.deepStrictEqual(tally, { hookErr: 1, timeouts: 1 });
  assert.strictEqual(probe.replayFailed(1, 0, tally), 1);
  assert.strictEqual(probe.replayFailed(1, 1, tally), 1);
  assert.strictEqual(probe.replayFailed(0, 0, tally), 1);
});

function fixtureReplay(fx, args) {
  return spawnSync(process.execPath, [fx.probe].concat(args), {
    encoding: "utf8", env: ENV, timeout: 13000, killSignal: "SIGKILL"
  });
}

test("a never-exiting hook is killed and counted as TIMEOUT even with a known mismatch", function (t) {
  const fx = hookFixture(t);
  const corpus = writeCorpus(fx.root, "timeout.jsonl", [
    { command: "synthetic-private-hang", expect: "ALLOW", known: "fixture-known" },
    { command: "git status", expect: "ALLOW" }
  ]);
  const run = fixtureReplay(fx, ["--corpus", corpus]);
  assert.strictEqual(run.status, 1, "the probe must finish and fail after a hook timeout");
  assert.match(run.stdout, /2 replayed, 0 denied, 1 timeouts/);
  assert.doesNotMatch(run.stdout, /hook errors/);
  assert.match(run.stdout, /TIMEOUT \[expected ALLOW, known fixture-known\]/);
  assert.match(run.stdout, /\nALLOW\t/, "other rows still finish");
  const pid = +fs.readFileSync(fx.pidFile, "utf8");
  assert.throws(function () { process.kill(pid, 0); }, { code: "ESRCH" }, "the timed-out hook is reaped");
});

test("harvest timeout output contains only counts, never private row or hook text", function (t) {
  const fx = hookFixture(t);
  const projects = path.join(fx.root, "projects", "fixture-project");
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, "session.jsonl"), JSON.stringify({
    cwd: fx.root, message: { content: [{ type: "tool_use", name: "Bash", input: { command: "synthetic-private-hang" } }] }
  }) + "\n");
  const run = fixtureReplay(fx, ["--harvest", "--projects", path.dirname(projects)]);
  assert.strictEqual(run.status, 1, "a timeout without an expected verdict must fail too");
  assert.match(run.stdout, /1 replayed, 0 denied, 1 timeouts/);
  assert.doesNotMatch(run.stdout + run.stderr, /synthetic-private|verdict\tcwd|TIMEOUT/);
  const local = path.join(fx.root, "verification", "local");
  const report = fs.readdirSync(local).find(function (name) { return name.endsWith(".report.txt"); });
  assert.match(fs.readFileSync(path.join(local, report), "utf8"), /TIMEOUT\t/);
});

test("an exited hook error stays HOOKERR and does not wait for the timeout", function (t) {
  const fx = hookFixture(t);
  const run = fixtureReplay(fx, ["--corpus", writeCorpus(fx.root, "error.jsonl", [{ command: "error" }])]);
  assert.strictEqual(run.status, 1);
  assert.match(run.stdout, /1 hook errors/);
  assert.match(run.stdout, /0 timeouts/);
  assert.match(run.stdout, /HOOKERR\t/);
});

test("an empty corpus fails: nothing was replayed", function (t) {
  const root = fixture(t);
  const run = replay(writeCorpus(root, "empty.jsonl", []));
  assert.strictEqual(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /nothing was replayed/);
  assert.match(run.stdout, /0 replayed, 0 denied/);
});

test("a corpus whose every row is skipped fails", function (t) {
  const root = fixture(t);
  const withState = path.join(root, "with-state");
  fs.mkdirSync(path.join(withState, "research"), { recursive: true });
  fs.writeFileSync(path.join(withState, "research", "canvas.md"), "# canvas\n");
  const run = replay(writeCorpus(root, "skipped.jsonl", [
    { cwd: withState, command: "git status" },
    { cwd: path.join(root, "gone"), command: "git status" }
  ]));
  assert.strictEqual(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /nothing was replayed/);
  assert.match(run.stdout, /0 replayed, 0 denied/);
  assert.match(run.stdout, /skipped: 1 with research state, 1 cwd missing/);
});

test("one benign row that is ALLOWed passes", function (t) {
  const root = fixture(t);
  const run = replay(writeCorpus(root, "benign.jsonl", [
    { label: "plain read", command: "git status --short", expect: "ALLOW" }
  ]));
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /1 replayed, 0 denied/);
  assert.doesNotMatch(run.stderr, /nothing was replayed/);
});
