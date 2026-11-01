"use strict";
// Runs scripts/release.js in a throwaway git repo: two manifests, a
// CHANGELOG.md, release fragments, a bare remote, stub `claude` and `gh` on
// PATH, and stub check commands injected through
// RELEASE_TEST_CHECKS. Nothing here touches the real repo, its remote or the
// installed plugin.
//
//   node --test scripts/release.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const SCRIPT = path.join(__dirname, "release.js");
const SECRET = "curl https://private.example/token-9f3a";
const CHANGELOG = "# Changelog\n\n## 0.4.0 (2026-10-02)\n\nYou can now do the big thing.\n\n### Fixed\n\n- A small thing.\n\n"
  + "## 0.3.7 (2026-10-01)\n\nThe 0.3.7 notes.\n\n## 0.3.6 (2026-09-30)\n\nOlder notes.\n";

test("benign counts parse timeout headers without exposing rows", function () {
  const release = require(SCRIPT);
  assert.strictEqual(typeof release.benignCounts, "function", "benign counts must be directly testable");
  const head = "2 replayed, 0 denied, 1 timeouts";
  assert.deepStrictEqual(release.benignCounts(head + "\n\n" + SECRET), { head: [head], replayed: 2, denied: 0, timeouts: 1 });
  assert.deepStrictEqual(release.benignCounts("2 replayed, 1 denied"), { head: ["2 replayed, 1 denied"], replayed: 2, denied: 1, timeouts: 0 });
  assert.deepStrictEqual(release.benignCounts("missing counts"), { head: ["missing counts"], replayed: null, denied: null, timeouts: 0 });
});

test("benign check refuses timeouts independently of exit status and deny count", function () {
  const release = require(SCRIPT);
  assert.strictEqual(typeof release.benignCheckFailure, "function", "benign refusal must be directly testable");
  assert.strictEqual(release.benignCheckFailure(0, { denied: 0, timeouts: 1 }), ": 1 timeouts");
  assert.strictEqual(release.benignCheckFailure(1, { denied: 0, timeouts: 1 }), " (exit 1)");
  assert.strictEqual(release.benignCheckFailure(0, { denied: null, timeouts: 1 }), ": 1 timeouts");
  assert.strictEqual(release.benignCheckFailure(0, { denied: null, timeouts: 0 }), ": no counts in its output");
  assert.strictEqual(release.benignCheckFailure(0, { denied: 0, timeouts: 0 }), null);
});

function sh(cwd, cmd, args) {
  const r = cp.spawnSync(cmd, args, { cwd: cwd, encoding: "utf8" });
  assert.strictEqual(r.status, 0, cmd + " " + args.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
}

function manifest(version) {
  return {
    market: JSON.stringify({ name: "placet-research", version: version, plugins: [{ name: "placet-research", version: version }] }, null, 2) + "\n",
    plugin: JSON.stringify({ name: "placet-research", version: version }, null, 2) + "\n",
  };
}

function writeManifests(repo, marketVersion, pluginVersion) {
  fs.writeFileSync(path.join(repo, ".claude-plugin", "marketplace.json"), manifest(marketVersion).market);
  fs.writeFileSync(path.join(repo, "plugins", "placet-research", ".claude-plugin", "plugin.json"), manifest(pluginVersion).plugin);
}

// A committed repo on main with origin and a stub `claude`.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-release-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  const repo = path.join(dir, "repo");
  const remote = path.join(dir, "remote.git");
  const bin = path.join(dir, "bin");
  for (const d of [".claude-plugin", "plugins/placet-research/.claude-plugin", "scripts", "verification/local", "bin"]) {
    fs.mkdirSync(path.join(repo, d), { recursive: true });
  }
  fs.mkdirSync(bin);
  fs.copyFileSync(SCRIPT, path.join(repo, "scripts", "release.js"));
  fs.copyFileSync(path.join(__dirname, "windows-zip.js"), path.join(repo, "scripts", "windows-zip.js"));
  fs.cpSync(path.join(__dirname, "..", "windows"), path.join(repo, "windows"), { recursive: true });
  fs.mkdirSync(path.join(repo, "plugins", "placet-research", "bin"), { recursive: true });
  fs.writeFileSync(path.join(repo, "plugins", "placet-research", "bin", "placet-research.js"), "// stub\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "verification/local/\n");
  fs.writeFileSync(path.join(repo, "CHANGELOG.md"), CHANGELOG);
  fs.mkdirSync(path.join(repo, ".release", "unreleased"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".release", "unreleased", "a.md"), "---\ntitle: A\n---\n");
  fs.writeFileSync(path.join(repo, ".release", "unreleased", "b.md"), "---\ntitle: B\n---\n");
  writeManifests(repo, "0.3.6", "0.3.6");
  fs.writeFileSync(path.join(repo, "verification", "local", "harvest-2026-09-29T10-00-00-000Z.jsonl"), "{}\n");
  fs.writeFileSync(path.join(repo, "verification", "local", "harvest-2026-09-30T10-00-00-000Z.jsonl"), JSON.stringify({ cwd: "/x", command: SECRET }) + "\n");
  const claudeLog = path.join(dir, "claude.log");
  fs.writeFileSync(path.join(bin, "claude"), '#!/bin/sh\necho "$@" >> "' + claudeLog + '"\necho "claude ok"\n', { mode: 0o755 });
  // The gh stub logs its arguments and copies the notes file it was given.
  const ghLog = path.join(dir, "gh.log");
  const ghNotes = path.join(dir, "gh-notes.md");
  fs.writeFileSync(path.join(bin, "gh"), '#!/bin/sh\n[ -n "$FAKE_GH_FAIL" ] && { echo "gh broke" >&2; exit 1; }\necho "$@" >> "' + ghLog + '"\n'
    + 'if [ "$1 $2" = "release download" ]; then prev=""; for a in "$@"; do [ "$prev" = "--dir" ] && dir="$a"; prev="$a"; done; cp "$FAKE_GH_SERVED"/* "$dir"/; echo "gh ok"; exit 0; fi\n'
    + 'for a in "$@"; do case "$a" in *placet-research-windows.zip) [ -f "$a" ] && echo "zip existed" >> "' + ghLog + '.zip";; esac; done\n'
    + 'prev=""; for a in "$@"; do [ "$prev" = "--notes-file" ] && cp "$a" "' + ghNotes + '"; prev="$a"; done\necho "gh ok"\n', { mode: 0o755 });
  sh(dir, "git", ["init", "--bare", "-b", "main", remote]);
  sh(repo, "git", ["init", "-b", "main"]);
  sh(repo, "git", ["config", "user.email", "t@example.org"]);
  sh(repo, "git", ["config", "user.name", "T"]);
  sh(repo, "git", ["add", "-A"]);
  sh(repo, "git", ["commit", "-m", "start"]);
  sh(repo, "git", ["remote", "add", "origin", remote]);
  sh(repo, "git", ["push", "origin", "main"]);
  return { dir: dir, repo: repo, remote: remote, bin: bin, claudeLog: claudeLog, ghLog: ghLog, ghNotes: ghNotes };
}

const SIGNED = { signing: "developer-id", identity: "Developer ID Application: A. Researcher (AB12CD34EF)", teamId: "AB12CD34EF", notaryProfile: "research-harness-notary", releases: "example-owner/placet-research" };

// Adds desktop/ with the switch and the stubs a desktop release calls:
// security and xcrun answer the preflight, npm "builds" four release files.
function withDesktop(fx, dist) {
  const lib = path.join(fx.repo, "desktop", "lib");
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "..", "desktop", "lib", "distribution.js"), path.join(lib, "distribution.js"));
  fs.writeFileSync(path.join(fx.repo, "desktop", "distribution.json"), JSON.stringify(dist) + "\n");
  fs.appendFileSync(path.join(fx.repo, ".gitignore"), "desktop/dist/\n");
  fx.npmLog = path.join(fx.dir, "npm.log");
  fs.writeFileSync(path.join(fx.bin, "security"), '#!/bin/sh\n[ -n "$FAKE_NO_IDENTITY" ] && { echo "     0 valid identities found"; exit 0; }\necho \'  1) 0123ABCD "' + SIGNED.identity + '"\'\necho "     1 valid identities found"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(fx.bin, "xcrun"), '#!/bin/sh\n[ -n "$FAKE_NO_PROFILE" ] && { echo "No Keychain password item found" >&2; exit 69; }\necho "No submission history."\n', { mode: 0o755 });
  fs.writeFileSync(path.join(fx.bin, "npm"), '#!/bin/sh\necho "$@" >> "' + fx.npmLog + '"\n[ "$1" = "ci" ] && exit 0\n[ -n "$FAKE_NPM_FAIL" ] && { echo "notarization rejected" >&2; exit 1; }\nmkdir -p dist/release\n'
    + 'for n in research-harness-mac-arm64.dmg research-harness-mac-x64.dmg research-harness-0.3.7-mac-arm64.zip latest-mac.yml; do echo "$n" > "dist/release/$n"; done\n', { mode: 0o755 });
  sh(fx.repo, "git", ["add", "-A"]);
  sh(fx.repo, "git", ["commit", "-m", "desktop switch"]);
  sh(fx.repo, "git", ["push", "origin", "main"]);
  fx.served = path.join(fx.repo, "desktop", "dist", "release");
}

// The three checks as stubs; FAKE_FAIL names the one that fails, FAKE_DENIED
// is the DENY count the replay stub reports, and its rows carry a secret.
const STUBS = JSON.stringify({
  tests: [process.execPath, "-e", "if (process.env.FAKE_FAIL === 'tests') { console.log('not ok 1 - boom'); process.exit(1); }"],
  perimeter: [process.execPath, "-e", "if (process.env.FAKE_FAIL === 'perimeter') { console.error('perimeter broke'); process.exit(1); }"],
  benign: [process.execPath, "-e",
    "console.log('12 replayed, ' + process.env.FAKE_DENIED + ' denied (skipped: 0 with research state, 0 cwd missing)');"
    + "console.log('  corpus: 12 rows, 12 replayed, ' + process.env.FAKE_DENIED + ' denied');"
    + "console.log('');console.log('verdict\\tcwd\\tcommand\\treason');console.log('DENY\\t/x\\t" + SECRET + "\\tr');"],
});

// TMPDIR points into the fixture, so a test can see what the script left there.
function release(fx, args, env) {
  fs.mkdirSync(path.join(fx.dir, "tmp"), { recursive: true });
  return cp.spawnSync(process.execPath, [path.join(fx.repo, "scripts", "release.js")].concat(args), {
    cwd: fx.repo,
    encoding: "utf8",
    env: Object.assign({}, process.env, { PATH: fx.bin + path.delimiter + process.env.PATH, RELEASE_TEST_CHECKS: STUBS, FAKE_DENIED: "3", TMPDIR: path.join(fx.dir, "tmp") }, env),
  });
}

// Everything a refused or stopped release must leave alone.
function snapshot(fx) {
  const baseline = path.join(fx.repo, "verification", "local", "release-baseline.json");
  return JSON.stringify({
    head: sh(fx.repo, "git", ["rev-parse", "HEAD"]),
    remote: sh(fx.repo, "git", ["--git-dir", fx.remote, "rev-parse", "main"]),
    status: sh(fx.repo, "git", ["status", "--porcelain"]),
    market: fs.readFileSync(path.join(fx.repo, ".claude-plugin", "marketplace.json"), "utf8"),
    plugin: fs.readFileSync(path.join(fx.repo, "plugins", "placet-research", ".claude-plugin", "plugin.json"), "utf8"),
    baseline: fs.existsSync(baseline) ? fs.readFileSync(baseline, "utf8") : null,
    claude: fs.existsSync(fx.claudeLog),
    gh: fs.existsSync(fx.ghLog),
    tags: sh(fx.repo, "git", ["tag"]),
    remoteTags: sh(fx.repo, "git", ["--git-dir", fx.remote, "tag"]),
  });
}

function refusal(name, setup, args, pattern, env) {
  test("refuses " + name + ": exit 2, one line, nothing changed", function (t) {
    const fx = fixture(t);
    setup(fx);
    const before = snapshot(fx);
    const r = release(fx, args || ["0.3.7", "s"], env);
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.strictEqual(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.match(r.stderr, pattern);
    assert.strictEqual(r.stdout, "", "no check ran");
    assert.strictEqual(snapshot(fx), before);
  });
}

refusal("a dirty tree", function (fx) { fs.writeFileSync(path.join(fx.repo, "stray.txt"), "x"); }, null, /not clean/);
refusal("a branch other than main", function (fx) { sh(fx.repo, "git", ["checkout", "-b", "topic"]); }, null, /on branch topic/);
refusal("a version equal to the current one", function () {}, ["0.3.6", "s"], /not greater/);
refusal("a version below the current one", function () {}, ["0.3.5", "s"], /not greater/);
refusal("a version that is not semver", function () {}, ["0.4", "s"], /not a semver/);
refusal("a missing summary", function () {}, ["0.3.7"], /usage/);
refusal("disagreeing manifests", function (fx) {
  writeManifests(fx.repo, "0.3.6", "0.3.5");
  sh(fx.repo, "git", ["commit", "-am", "drift"]);
}, null, /disagree/);
refusal("a version with no CHANGELOG section", function () {}, ["0.3.8", "s"], /CHANGELOG\.md has no section for 0\.3\.8/);
refusal("an empty CHANGELOG section", function (fx) {
  fs.writeFileSync(path.join(fx.repo, "CHANGELOG.md"), "# Changelog\n\n## 0.3.7 (2026-10-01)\n\n## 0.3.6\n\nx\n");
  sh(fx.repo, "git", ["commit", "-am", "empty"]);
}, null, /CHANGELOG\.md has no section for 0\.3\.7/);
refusal("a version whose tag exists", function (fx) { sh(fx.repo, "git", ["tag", "v0.3.7"]); }, null, /tag v0\.3\.7 already exists/);
refusal("a repo with no harvest", function (fx) {
  for (const f of fs.readdirSync(path.join(fx.repo, "verification", "local"))) fs.unlinkSync(path.join(fx.repo, "verification", "local", f));
}, null, /--harvest/);

test("--dry-run runs the checks, prints the planned commands and writes nothing", function (t) {
  const fx = fixture(t);
  const before = snapshot(fx);
  const r = release(fx, ["0.3.7", "a summary", "--dry-run", "--trailer", "Co-Authored-By: X"]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /node --test test\/\*\.test\.js/);
  assert.match(r.stdout, /probe-perimeter\.js/);
  assert.match(r.stdout, /harvest-2026-09-30T10-00-00-000Z\.jsonl/, "the newest harvest is the corpus");
  assert.match(r.stdout, /12 replayed, 3 denied/);
  assert.match(r.stdout, /git commit -m "Release 0\.3\.7: a summary" -m "Co-Authored-By: X"/);
  assert.match(r.stdout, /git push origin main/);
  assert.match(r.stdout, /git mv \.release\/unreleased\/\*\.md \.release\/0\.3\.7\/ \(2 fragments\)/);
  assert.match(r.stdout, /git tag -a v0\.3\.7/);
  assert.match(r.stdout, /git push origin v0\.3\.7/);
  assert.match(r.stdout, /build placet-research-windows\.zip/);
  assert.match(r.stdout, /gh release create v0\.3\.7 <placet-research-windows\.zip> --verify-tag --title 0\.3\.7 --notes-file <CHANGELOG\.md section 0\.3\.7> --latest/);
  assert.match(r.stdout, /The 0\.3\.7 notes\./, "the dry run shows the notes it would publish");
  assert.ok(!r.stdout.includes("Older notes"), "only the version's own section");
  assert.deepStrictEqual(fs.readdirSync(path.join(fx.dir, "tmp")), [], "a dry run writes no notes file");
  assert.match(r.stdout, /claude plugin marketplace update placet-research/);
  assert.match(r.stdout, /claude plugin update placet-research@placet-research/);
  assert.strictEqual(snapshot(fx), before);
});

test("a failing check stops before any write and prints its tail", function (t) {
  for (const which of ["tests", "perimeter"]) {
    const fx = fixture(t);
    const before = snapshot(fx);
    const r = release(fx, ["0.3.7", "s"], { FAKE_FAIL: which });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, which === "tests" ? /not ok 1 - boom/ : /perimeter broke/);
    assert.match(r.stderr, /the release did not start/);
    assert.strictEqual(snapshot(fx), before);
  }
});

test("the replay's rows never reach the output", function (t) {
  const fx = fixture(t);
  const r = release(fx, ["0.3.7", "s", "--dry-run"]);
  assert.strictEqual(r.status, 0);
  assert.ok(!(r.stdout + r.stderr).includes("private.example"), "harvested command text was printed");
});

test("replay timeouts stop before any write even with exit zero and --accept-denies", function (t) {
  const fx = fixture(t);
  const before = snapshot(fx);
  const checks = JSON.parse(STUBS);
  checks.benign = [process.execPath, "-e", "console.log('12 replayed, 0 denied, 1 timeouts (skipped: 0 with research state, 0 cwd missing)\\n\\nTIMEOUT\\t/x\\t" + SECRET + "\\treason');"];
  const run = release(fx, ["0.3.7", "s", "--accept-denies"], { RELEASE_TEST_CHECKS: JSON.stringify(checks) });
  assert.strictEqual(run.status, 1, "a timeout count must block even if the replay exits zero");
  assert.match(run.stdout, /1 timeouts/);
  assert.match(run.stderr, /the release did not start/);
  assert.doesNotMatch(run.stdout + run.stderr, /private.example/);
  assert.strictEqual(snapshot(fx), before, "timeouts cannot update the baseline or start a release");
});

test("more DENYs than the baseline stop the release unless --accept-denies", function (t) {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.repo, "verification", "local", "release-baseline.json"), JSON.stringify({ denied: 2 }));
  const before = snapshot(fx);
  const stopped = release(fx, ["0.3.7", "s"]);
  assert.strictEqual(stopped.status, 1, stopped.stdout + stopped.stderr);
  assert.match(stopped.stderr, /3 DENYs, baseline 2/);
  assert.strictEqual(snapshot(fx), before);

  const dry = release(fx, ["0.3.7", "s", "--dry-run", "--accept-denies"]);
  assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
  assert.strictEqual(snapshot(fx), before, "a dry run never moves the baseline");

  const done = release(fx, ["0.3.7", "the summary", "--accept-denies", "--trailer", "Co-Authored-By: X"]);
  assert.strictEqual(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /accepted by --accept-denies/);
  assert.match(done.stdout, /released 0\.3\.7/);
});

test("a full release sets all three versions, commits, pushes, updates the plugin and records the baseline", function (t) {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.repo, "verification", "local", "release-baseline.json"), JSON.stringify({ denied: 3 }));
  const r = release(fx, ["0.4.0", "the summary", "--trailer", "Co-Authored-By: X"]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);

  const market = JSON.parse(fs.readFileSync(path.join(fx.repo, ".claude-plugin", "marketplace.json"), "utf8"));
  const plugin = JSON.parse(fs.readFileSync(path.join(fx.repo, "plugins", "placet-research", ".claude-plugin", "plugin.json"), "utf8"));
  assert.deepStrictEqual([market.version, market.plugins[0].version, plugin.version], ["0.4.0", "0.4.0", "0.4.0"]);

  assert.strictEqual(sh(fx.repo, "git", ["log", "-1", "--format=%B"]), "Release 0.4.0: the summary\n\nCo-Authored-By: X");
  assert.strictEqual(sh(fx.repo, "git", ["status", "--porcelain"]), "");
  assert.strictEqual(sh(fx.repo, "git", ["--git-dir", fx.remote, "rev-parse", "main"]), sh(fx.repo, "git", ["rev-parse", "HEAD"]));
  assert.strictEqual(fs.readFileSync(fx.claudeLog, "utf8"), "plugin marketplace update placet-research\nplugin update placet-research@placet-research\n");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(fx.repo, "verification", "local", "release-baseline.json"), "utf8")).denied, 3);

  assert.deepStrictEqual(fs.readdirSync(path.join(fx.repo, ".release", "0.4.0")).sort(), ["a.md", "b.md"]);
  assert.ok(!fs.existsSync(path.join(fx.repo, ".release", "unreleased")) || fs.readdirSync(path.join(fx.repo, ".release", "unreleased")).length === 0);
  assert.match(sh(fx.repo, "git", ["show", "--stat", "--format=", "HEAD"]), /\.release\/.*0\.4\.0.*a\.md/, "the move is part of the release commit");
  assert.strictEqual(sh(fx.repo, "git", ["cat-file", "-t", "v0.4.0"]), "tag", "an annotated tag");
  assert.strictEqual(sh(fx.repo, "git", ["rev-parse", "v0.4.0^{commit}"]), sh(fx.repo, "git", ["rev-parse", "HEAD"]));
  assert.strictEqual(sh(fx.repo, "git", ["--git-dir", fx.remote, "rev-parse", "v0.4.0^{commit}"]), sh(fx.repo, "git", ["rev-parse", "HEAD"]));
  assert.match(fs.readFileSync(fx.ghLog, "utf8"), /^release create v0\.4\.0 \S+\/placet-research-windows\.zip --verify-tag --title 0\.4\.0 --notes-file \S+ --latest\n$/);
  assert.strictEqual(fs.readFileSync(fx.ghLog + ".zip", "utf8"), "zip existed\n", "the zip existed when gh ran");
  assert.deepStrictEqual(fs.readdirSync(path.join(fx.dir, "tmp")), [], "the notes file and the zip are gone after gh");
  assert.strictEqual(fs.readFileSync(fx.ghNotes, "utf8"), "You can now do the big thing.\n\n### Fixed\n\n- A small thing.\n");
});

test("a failed gh release stops before the plugin update and leaves the baseline alone", function (t) {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.repo, "verification", "local", "release-baseline.json"), JSON.stringify({ denied: 3 }));
  const r = release(fx, ["0.3.7", "s"], { FAKE_GH_FAIL: "1" });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /gh release create v0\.3\.7.*failed/);
  assert.strictEqual(sh(fx.repo, "git", ["--git-dir", fx.remote, "tag"]), "v0.3.7", "the tag was pushed before gh ran");
  assert.ok(!fs.existsSync(fx.claudeLog), "the plugin was not updated");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(fx.repo, "verification", "local", "release-baseline.json"), "utf8")).denied, 3);
});

test("no baseline yet: the release proceeds and records one", function (t) {
  const fx = fixture(t);
  const r = release(fx, ["0.3.7", "s"], { FAKE_DENIED: "5" });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /baseline: none yet/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(fx.repo, "verification", "local", "release-baseline.json"), "utf8")).denied, 5);
});

test("a failed push leaves the baseline alone", function (t) {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.repo, "verification", "local", "release-baseline.json"), JSON.stringify({ denied: 3 }));
  sh(fx.repo, "git", ["remote", "set-url", "origin", path.join(fx.dir, "missing.git")]);
  const r = release(fx, ["0.3.7", "s"], { FAKE_DENIED: "1" });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /git push origin main.*failed/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(fx.repo, "verification", "local", "release-baseline.json"), "utf8")).denied, 3);
  assert.ok(!fs.existsSync(fx.claudeLog), "the plugin was not updated");
});

test("an unsigned desktop app is not attached, and the release says so", function (t) {
  const fx = fixture(t);
  withDesktop(fx, { signing: "none" });
  const r = release(fx, ["0.3.7", "s"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /desktop app: not attached \(signing is none\)/);
  assert.ok(!fs.existsSync(fx.npmLog), "npm did not run");
  assert.doesNotMatch(fs.readFileSync(fx.ghLog, "utf8"), /\.dmg/);
});

refusal("a developer-id switch without its certificate", function (fx) { withDesktop(fx, SIGNED); }, null, /is not in this Mac's keychain/, { FAKE_NO_IDENTITY: "1" });
refusal("a developer-id switch without its notarization profile", function (fx) { withDesktop(fx, SIGNED); }, null, /"research-harness-notary" does not work/, { FAKE_NO_PROFILE: "1" });

test("a signed desktop app is built after the version commit, uploaded with the release and read back", function (t) {
  const fx = fixture(t);
  withDesktop(fx, SIGNED);
  const r = release(fx, ["0.3.7", "s"], { FAKE_GH_SERVED: fx.served });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(fs.readFileSync(fx.npmLog, "utf8").trim().split("\n"), ["ci", "run dist"]);
  const gh = fs.readFileSync(fx.ghLog, "utf8");
  const create = gh.split("\n").find(function (l) { return l.startsWith("release create v0.3.7"); });
  for (const n of ["research-harness-mac-arm64.dmg", "research-harness-mac-x64.dmg", "research-harness-0.3.7-mac-arm64.zip", "latest-mac.yml"]) {
    assert.ok(create.includes(path.join("desktop", "dist", "release", n)), n + " is uploaded");
  }
  assert.match(gh, /release download v0\.3\.7 --pattern latest-mac\.yml --pattern \*\.dmg --dir /);
  assert.match(r.stdout, /3 files match/);
});

test("a failed desktop build stops before the tag and the push", function (t) {
  const fx = fixture(t);
  withDesktop(fx, SIGNED);
  const remoteBefore = sh(fx.repo, "git", ["--git-dir", fx.remote, "rev-parse", "main"]);
  const r = release(fx, ["0.3.7", "s"], { FAKE_NPM_FAIL: "1" });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /`npm run dist[^`]*` failed/);
  assert.strictEqual(sh(fx.repo, "git", ["tag"]), "");
  assert.strictEqual(sh(fx.repo, "git", ["--git-dir", fx.remote, "rev-parse", "main"]), remoteBefore);
  assert.ok(!fs.existsSync(fx.ghLog), "gh did not run");
});

test("a file GitHub serves differently is reported with the command that fixes it", function (t) {
  const fx = fixture(t);
  withDesktop(fx, SIGNED);
  const served = path.join(fx.dir, "served");
  fs.mkdirSync(served);
  for (const n of ["research-harness-mac-arm64.dmg", "research-harness-mac-x64.dmg", "latest-mac.yml"]) fs.writeFileSync(path.join(served, n), n + "\n");
  fs.writeFileSync(path.join(served, "research-harness-mac-x64.dmg"), "cut off");
  const r = release(fx, ["0.3.7", "s"], { FAKE_GH_SERVED: served });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /research-harness-mac-x64\.dmg on GitHub differs/);
  assert.match(r.stderr, /gh release upload v0\.3\.7 desktop\/dist\/release\/research-harness-mac-x64\.dmg --clobber/);
  assert.ok(fs.existsSync(fx.claudeLog), "the plugin update ran before the read-back");
  assert.ok(fs.existsSync(path.join(fx.repo, "verification", "local", "release-baseline.json")), "the baseline was recorded");
});
