#!/usr/bin/env node
"use strict";

// Negative control: show that the tests fail without the change.
//
// Reverts the named files to <base> inside a throwaway worktree of HEAD, runs
// the test command there, and reports what failed. The caller's work tree,
// index and refs are never written to; the only git state this touches is its
// own temporary worktree registration, which it removes again.
//
//   node verification/negative-control.js --base <rev> --revert <path>[,<path>...] [--test-cmd "<shell command>"]
//
// Exit 0 when the tests failed under the revert (the control bit), 1 when they
// passed (the tests do not catch the change), 2 on usage or setup errors. A run
// whose output carries no test result is never read as "passed": it exits 2.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const USAGE = 'usage: node verification/negative-control.js --base <rev> --revert <path>[,<path>...] [--test-cmd "<shell command>"]';
const DEFAULT_TEST_CMD = "cd plugins/placet-research && node --test --test-reporter=tap test/*.test.js";
const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_NAMES = 20;
const TAIL_LINES = 5;

let cleanup = function () {};

function refuse(message) {
  cleanup();
  process.stderr.write("negative-control: " + message + "\n");
  process.exit(2);
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd: cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    error: r.error
  };
}

function firstLine(text) {
  const lines = String(text).split("\n").filter(function (line) { return line.trim() !== ""; });
  return lines.length > 0 ? lines[0].trim() : "";
}

function parseArgs(argv) {
  const opts = { base: null, revert: [], testCmd: DEFAULT_TEST_CMD };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base") {
      const value = argv[++i];
      if (value === undefined) refuse("--base needs a revision; " + USAGE);
      opts.base = value;
    } else if (arg === "--revert") {
      const value = argv[++i];
      if (value === undefined) refuse("--revert needs a path; " + USAGE);
      value.split(",").forEach(function (p) {
        const trimmed = p.trim();
        if (trimmed !== "") opts.revert.push(trimmed);
      });
    } else if (arg === "--test-cmd") {
      const value = argv[++i];
      if (value === undefined) refuse("--test-cmd needs a command; " + USAGE);
      opts.testCmd = value;
    } else {
      refuse("unknown argument " + arg + "; " + USAGE);
    }
  }
  if (opts.base === null || opts.base === "") refuse("--base is required; " + USAGE);
  if (opts.revert.length === 0) refuse("--revert needs at least one path; " + USAGE);
  return opts;
}

// Repo-root-relative, forward slashes, no way out of the work tree.
function normalizePath(raw, topLevel) {
  let p = raw;
  if (path.isAbsolute(p)) {
    p = path.relative(topLevel, p);
  }
  p = p.split("\\").join("/");
  while (p.startsWith("./")) p = p.slice(2);
  if (p === "" || p === "." || p === "/") refuse("--revert needs a file path, got " + raw + "; " + USAGE);
  if (p.split("/").indexOf("..") >= 0) refuse("path must stay inside the work tree, got " + raw);
  return p;
}

// Failing tests named by TAP "not ok" lines. A line whose next failure line is
// indented deeper is a parent rollup (one entry per test file), not a test.
function tapFailures(output) {
  const seen = [];
  output.split("\n").forEach(function (line) {
    const m = /^(\s*)not ok \d+ - (.*)$/.exec(line);
    if (m) seen.push({ indent: m[1].length, name: m[2].trim() });
  });
  return seen.filter(function (entry, i) {
    return !(i + 1 < seen.length && seen[i + 1].indent > entry.indent);
  }).map(function (entry) { return entry.name; });
}

function tapCount(output, key) {
  const m = new RegExp("^\\s*#\\s*" + key + "\\s+(\\d+)\\s*$", "m").exec(output);
  return m ? m[1] : null;
}

// Did any test actually run? A TAP result line or a non-zero summary counts.
// A runner that skips every file exits 0 and prints none of this, and such a
// run must not be reported as "the tests pass".
function tapRan(output) {
  if (/^\s*(?:not )?ok \d+ - /m.test(output)) return true;
  return ["tests", "pass", "fail"].some(function (key) {
    const n = tapCount(output, key);
    return n !== null && Number(n) > 0;
  });
}

function tail(output) {
  const lines = output.split("\n").filter(function (line) { return line.trim() !== ""; });
  return lines.slice(Math.max(0, lines.length - TAIL_LINES));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  const inside = git(["rev-parse", "--is-inside-work-tree"], cwd);
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  if (inside.status !== 0 || inside.stdout.trim() !== "true" || top.status !== 0) {
    refuse("not inside a git work tree; " + USAGE);
  }
  const topLevel = top.stdout.trim();

  const baseResolved = git(["rev-parse", "--verify", "--quiet", opts.base + "^{commit}"], cwd);
  if (baseResolved.status !== 0) refuse("base does not resolve to a commit: " + opts.base);
  const base = baseResolved.stdout.trim();
  const shortBase = git(["rev-parse", "--short", base], cwd).stdout.trim() || base;

  const paths = opts.revert.map(function (raw) {
    const rel = normalizePath(raw, topLevel);
    const atHead = git(["cat-file", "-e", "HEAD:" + rel], cwd).status === 0;
    const atBase = git(["cat-file", "-e", base + ":" + rel], cwd).status === 0;
    if (!atHead && !atBase) refuse("not tracked at HEAD or at " + opts.base + ": " + rel);
    return { path: rel, absentAtBase: !atBase };
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "negative-control-"));
  const worktree = path.join(tmpDir, "wt");
  let registered = false;
  let removed = false;
  cleanup = function () {
    if (removed) return;
    removed = true;
    if (registered) {
      git(["worktree", "remove", "--force", worktree], topLevel);
      git(["worktree", "prune"], topLevel);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  const add = git(["worktree", "add", "--detach", worktree, "HEAD"], topLevel);
  if (add.status !== 0) {
    refuse("could not add a throwaway worktree: " + (firstLine(add.stderr) || "git worktree add exited " + add.status));
  }
  registered = true;

  paths.forEach(function (entry) {
    if (entry.absentAtBase) {
      // The change added this file. Deleting it here is what reverts it.
      fs.rmSync(path.join(worktree, entry.path), { recursive: true, force: true });
      return;
    }
    const restore = git(["checkout", base, "--", entry.path], worktree);
    if (restore.status !== 0) {
      refuse("could not restore " + entry.path + " from " + opts.base + ": " + firstLine(restore.stderr));
    }
  });

  // Run the tests as an executor's shell would. A node:test child marker
  // (NODE_TEST_CONTEXT, NODE_TEST_WORKER_ID) inherited from a caller that is
  // itself running under node --test makes a nested `node --test` skip every
  // file, print a warning and exit 0 without running anything.
  const env = {};
  Object.keys(process.env).forEach(function (key) {
    if (!key.startsWith("NODE_TEST_")) env[key] = process.env[key];
  });
  const run = spawnSync(opts.testCmd, { shell: true, cwd: worktree, env: env, encoding: "utf8", maxBuffer: MAX_OUTPUT });
  const output = (run.stdout || "") + (run.stderr || "");
  const failures = tapFailures(output);
  const passCount = tapCount(output, "pass");
  const failCount = tapCount(output, "fail");

  let bit = null; // null: cannot be judged
  let note = "";
  if (run.error) {
    note = "the test command could not be run: " + run.error.message;
  } else if (run.status === null) {
    note = "the test command was killed by a signal";
  } else if (!tapRan(output)) {
    note = "the test command exited " + run.status + " without a test result in its output, so nothing was run or reported";
  } else if (run.status === 0) {
    bit = false;
  } else if (failures.length > 0) {
    bit = true;
  } else {
    // Non-zero exit with no TAP failure to name. That is a broken command, not
    // a caught change, and it must not read as a control that bit.
    note = "the test command exited " + run.status + " without TAP \"not ok\" lines; run the tests with --test-reporter=tap so the control can be judged";
  }

  cleanup();

  const out = [];
  out.push("negative control");
  out.push("  base          " + opts.base + (opts.base === shortBase ? "" : " (" + shortBase + ")"));
  out.push("  test command  " + opts.testCmd);
  paths.forEach(function (entry) {
    out.push("  revert        " + entry.path + (entry.absentAtBase ? " (absent at base; removed here)" : ""));
  });
  out.push("  test exit     " + (run.status === null ? "killed by a signal" : run.status));
  if (passCount !== null || failCount !== null) {
    out.push("  tests         pass " + (passCount === null ? "?" : passCount) + ", fail " + (failCount === null ? "?" : failCount));
  }
  out.push("  failing       " + failures.length);
  failures.slice(0, MAX_NAMES).forEach(function (name) {
    out.push("                  " + name);
  });
  if (failures.length > MAX_NAMES) {
    out.push("                  ... and " + (failures.length - MAX_NAMES) + " more");
  }
  out.push("  control bit   " + (bit === null ? "cannot be judged" : (bit ? "yes" : "no")));
  if (bit === false) out.push("                the tests pass with these files reverted, so they do not pin the change");
  if (bit === null) out.push("                " + note);
  process.stdout.write(out.join("\n") + "\n");

  if (bit === null) {
    tail(output).forEach(function (line) {
      process.stderr.write("negative-control: output | " + line + "\n");
    });
    process.exit(2);
  }
  process.exit(bit ? 0 : 1);
}

["SIGINT", "SIGTERM", "SIGHUP"].forEach(function (sig) {
  process.on(sig, function () {
    cleanup();
    process.exit(sig === "SIGINT" ? 130 : (sig === "SIGTERM" ? 143 : 129));
  });
});

main();
