"use strict";

// node --test verification/negative-control.test.js
//
// Each case builds a throwaway git repository: a function, a test that pins
// its new behaviour, an unrelated file, and a file the change added. The
// control is run there and the whole repository is compared before and after,
// so a run that wrote to the caller's tree or left a worktree behind fails
// the case it was made in.

const { spawnSync, execFileSync } = require("node:child_process");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SCRIPT = path.join(__dirname, "negative-control.js");
const TEST_CMD = "node --test --test-reporter=tap pins.test.js";

const CALC_BASE = "function double(x) {\n  return x + x + 1;\n}\n\nmodule.exports = { double: double };\n";
const CALC_HEAD = "function double(x) {\n  return x * 2;\n}\n\nmodule.exports = { double: double };\n";
const PINS = [
  '"use strict";',
  'const test = require("node:test");',
  'const assert = require("node:assert");',
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const { double } = require("./calc.js");',
  "",
  'test("double multiplies by two", function () {',
  "  assert.strictEqual(double(3), 6);",
  "});",
  "",
  'test("the file the change added is present", function () {',
  '  assert.ok(fs.existsSync(path.join(__dirname, "added.js")));',
  "});",
  ""
].join("\n");

function git(cwd, args) {
  return execFileSync("git", args, { cwd: cwd, encoding: "utf8" });
}

function write(root, name, body) {
  fs.writeFileSync(path.join(root, name), body);
}

// base commit: the old function, an unrelated file, the tests that pin the new
// behaviour. HEAD: the new function, the unrelated file changed, a new file.
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "negative-control-fixture-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "negative-control@example.invalid"]);
  git(root, ["config", "user.name", "negative control fixture"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  write(root, "calc.js", CALC_BASE);
  write(root, "other.js", 'module.exports.label = "base";\n');
  write(root, "pins.test.js", PINS);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "base"]);
  write(root, "calc.js", CALC_HEAD);
  write(root, "other.js", 'module.exports.label = "head";\n');
  write(root, "added.js", "module.exports.added = true;\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "change"]);
  return root;
}

function snapshot(root) {
  return {
    head: git(root, ["rev-parse", "HEAD"]),
    status: git(root, ["status", "--porcelain"]),
    worktrees: git(root, ["worktree", "list"])
  };
}

// Every run is bracketed: the caller's HEAD, working tree and worktree list
// have to come back byte-identical.
function runControl(root, args) {
  const before = snapshot(root);
  const run = spawnSync(process.execPath, [SCRIPT].concat(args), { cwd: root, encoding: "utf8" });
  assert.deepStrictEqual(snapshot(root), before, "the run touched the caller's repository");
  return {
    status: run.status,
    stdout: run.stdout || "",
    stderr: run.stderr || ""
  };
}

function fixture(t) {
  const root = makeFixture();
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

test("reverting the file the change touched fails the tests and names them", function (t) {
  const root = fixture(t);
  const run = runControl(root, ["--base", "HEAD~1", "--revert", "calc.js", "--test-cmd", TEST_CMD]);
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /control bit\s+yes/);
  assert.match(run.stdout, /double multiplies by two/);
  assert.match(run.stdout, /failing\s+1/);
  assert.doesNotMatch(run.stdout, /the file the change added is present/);
});

test("reverting only an unrelated file leaves the tests passing", function (t) {
  const root = fixture(t);
  const run = runControl(root, ["--base", "HEAD~1", "--revert", "other.js", "--test-cmd", TEST_CMD]);
  assert.strictEqual(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /control bit\s+no/);
  assert.match(run.stdout, /failing\s+0/);
});

test("a file the change added is removed in the throwaway tree, not in the caller's", function (t) {
  const root = fixture(t);
  const run = runControl(root, ["--base", "HEAD~1", "--revert", "added.js", "--test-cmd", TEST_CMD]);
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /the file the change added is present/);
  assert.match(run.stdout, /absent at base; removed here/);
  assert.ok(fs.existsSync(path.join(root, "added.js")), "the caller's added.js is gone");
});

test("several paths at once are reverted", function (t) {
  const root = fixture(t);
  const run = runControl(root, ["--base", "HEAD~1", "--revert", "calc.js,added.js", "--test-cmd", TEST_CMD]);
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /double multiplies by two/);
  assert.match(run.stdout, /the file the change added is present/);
  assert.match(run.stdout, /failing\s+2/);
});

test("a base that does not resolve is refused", function (t) {
  const root = fixture(t);
  const run = runControl(root, ["--base", "no-such-rev", "--revert", "calc.js", "--test-cmd", TEST_CMD]);
  assert.strictEqual(run.status, 2, run.stdout + run.stderr);
  assert.strictEqual(run.stderr.trim().split("\n").length, 1);
  assert.match(run.stderr, /base does not resolve to a commit: no-such-rev/);
  assert.strictEqual(run.stdout, "");
});

test("usage and path errors are refused with one line", function (t) {
  const root = fixture(t);
  const missing = runControl(root, ["--revert", "calc.js"]);
  assert.strictEqual(missing.status, 2);
  assert.match(missing.stderr, /--base is required/);

  const untracked = runControl(root, ["--base", "HEAD~1", "--revert", "not-a-file.js"]);
  assert.strictEqual(untracked.status, 2);
  assert.match(untracked.stderr, /not tracked at HEAD or at HEAD~1: not-a-file\.js/);

  const unknown = runControl(root, ["--base", "HEAD~1", "--revert", "calc.js", "--wat"]);
  assert.strictEqual(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument --wat/);
});

// A command that exits 0 without running anything must not be read as "the
// tests pass with the change reverted".
test("a run with no test result in its output cannot be judged", function (t) {
  const root = fixture(t);
  const run = runControl(root, ["--base", "HEAD~1", "--revert", "calc.js", "--test-cmd", "true"]);
  assert.strictEqual(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /control bit\s+cannot be judged/);
  assert.match(run.stdout, /without a test result in its output/);
});

test("an uncommitted change in the caller's tree is left alone", function (t) {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, "calc.js"), "\n// uncommitted note\n");
  const dirty = git(root, ["status", "--porcelain"]);
  const run = runControl(root, ["--base", "HEAD~1", "--revert", "calc.js", "--test-cmd", TEST_CMD]);
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /control bit\s+yes/);
  assert.strictEqual(git(root, ["status", "--porcelain"]), dirty);
  assert.match(fs.readFileSync(path.join(root, "calc.js"), "utf8"), /uncommitted note/);
});
