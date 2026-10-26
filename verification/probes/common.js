"use strict";
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const os = require("node:os");

// The repository this file sits in, so a clone runs the probes unedited.
const REPO = path.resolve(__dirname, "..", "..");
const PLUGIN = path.join(REPO, "plugins", "placet-research");
const GUARD = path.join(PLUGIN, "hooks", "guard-promotion.js");
const FIX = path.join(PLUGIN, "test", "fixtures", "voice-uptake", "research");
// Throwaway projects live here. The probes never write into the repository.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "rh-probe-"));

const canvasSrc = fs.readFileSync(path.join(FIX, "canvas.md"), "utf8");
const decisionsSrc = fs.readFileSync(path.join(FIX, "decisions.md"), "utf8");
const canvasLib = require(path.join(PLUGIN, "hooks", "lib", "canvas.js"));
const reviewLib = require(path.join(PLUGIN, "hooks", "lib", "review.js"));
const hashLib = require(path.join(PLUGIN, "hooks", "lib", "hash.js"));
const decisionsLib = require(path.join(PLUGIN, "hooks", "lib", "decisions.js"));
const profileLib = require(path.join(PLUGIN, "hooks", "lib", "profile.js"));

let seq = 0;
function makeProject() {
  seq += 1;
  const root = fs.mkdtempSync(path.join(SCRATCH, "p" + seq + "-"));
  fs.mkdirSync(path.join(root, "research"));
  fs.writeFileSync(path.join(root, "research", "canvas.md"), canvasSrc);
  fs.writeFileSync(path.join(root, "research", "decisions.md"), decisionsSrc);
  return root;
}
function canvasFile(root) { return path.join(root, "research", "canvas.md"); }
function decisionsFile(root) { return path.join(root, "research", "decisions.md"); }
function readOr(file) { try { return fs.readFileSync(file, "utf8"); } catch (e) { return null; } }

function runHook(root, toolName, toolInput, extraEnv) {
  const env = Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: PLUGIN }, extraEnv || {});
  delete env.CLAUDE_PROJECT_DIR;
  const out = cp.spawnSync(process.execPath, [GUARD], {
    cwd: root,
    env: env,
    input: JSON.stringify({ cwd: root, session_id: "s", hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput }),
    encoding: "utf8",
  });
  if (out.status !== 0) return { decision: "HOOKERR", reason: String(out.stderr).slice(0, 200) };
  if (!out.stdout) return { decision: "ALLOW", reason: "" };
  const o = JSON.parse(out.stdout).hookSpecificOutput;
  if (o && o.permissionDecision === "deny") return { decision: "DENY", reason: o.permissionDecisionReason };
  return { decision: "ALLOW", reason: "" };
}

function applyTool(toolName, toolInput) {
  const target = toolInput.file_path || toolInput.path;
  if (toolName === "Write") { fs.writeFileSync(target, toolInput.content); return { ok: true }; }
  if (toolName === "Edit") {
    const cur = fs.readFileSync(target, "utf8");
    const first = cur.indexOf(toolInput.old_string);
    if (first < 0) return { ok: false, err: "TOOL-ERROR old_string not found" };
    const second = cur.indexOf(toolInput.old_string, first + toolInput.old_string.length);
    if (second >= 0 && !toolInput.replace_all) return { ok: false, err: "TOOL-ERROR old_string not unique" };
    const next = toolInput.replace_all
      ? cur.split(toolInput.old_string).join(toolInput.new_string)
      : cur.slice(0, first) + toolInput.new_string + cur.slice(first + toolInput.old_string.length);
    fs.writeFileSync(target, next);
    return { ok: true };
  }
  return { ok: false, err: "NOT-APPLIED (" + toolName + " not simulated)" };
}

function committedList(text) {
  const parsed = canvasLib.parseCanvas(text);
  return canvasLib.allStatements(parsed)
    .filter(function (s) { return canvasLib.COMMITTED.has(s.marker); })
    .map(function (s) { return "e" + s.element + "/" + s.question + " [" + s.marker + (s.tags.length ? ", " + s.tags.join(", ") : "") + "] " + s.text.slice(0, 48); });
}
function statusLine(text) {
  const st = profileLib.statusByNumber(canvasLib.parseCanvas(text));
  return Object.keys(st).map(function (k) { return k + ":" + st[k].status; }).join(",");
}
function reviewLine(root) {
  const parsed = canvasLib.parseCanvas(readOr(canvasFile(root)) || "");
  const r = reviewLib.mechanicalReview({ parsed: parsed, graph: null, decisionsText: readOr(decisionsFile(root)) || "" });
  return "review[unmarked=" + r.unmarked.length + " untagged=" + r.untagged.length + " stale=" + r.staleAcceptances.length + " unlogged=" + r.unloggedAcceptances.length + " problems=" + r.problems.length + "]";
}
function describeCanvas(root, beforeText) {
  const afterText = readOr(canvasFile(root));
  if (afterText === null) return "CANVAS GONE";
  if (afterText === beforeText) return "file unchanged";
  const b = committedList(beforeText);
  const a = committedList(afterText);
  const lost = b.filter(function (x) { return a.indexOf(x) < 0; });
  const gained = a.filter(function (x) { return b.indexOf(x) < 0; });
  const parts = ["bytes " + Buffer.byteLength(beforeText) + "->" + Buffer.byteLength(afterText)];
  if (lost.length) parts.push("LOST-COMMITTED " + JSON.stringify(lost));
  if (gained.length) parts.push("NEW-COMMITTED " + JSON.stringify(gained));
  const sb = statusLine(beforeText);
  const sa = statusLine(afterText);
  if (sb !== sa) parts.push("STATUS " + sb + " => " + sa);
  parts.push(reviewLine(root));
  return parts.join(" | ");
}
function describeDecisions(root, beforeText) {
  const afterText = readOr(decisionsFile(root));
  if (afterText === null) return "DECISIONS GONE";
  if (afterText === beforeText) return "file unchanged";
  const b = decisionsLib.parseDecisions(beforeText);
  const a = decisionsLib.parseDecisions(afterText);
  const gained = a.entries.filter(function (e) { return !b.entries.some(function (x) { return x.seq === e.seq; }); })
    .map(function (e) { return "#" + e.seq + " " + e.kind + " " + e.ref + " text=" + e.hash; });
  return "entries " + b.entries.length + "->" + a.entries.length + (gained.length ? " NEW " + JSON.stringify(gained) : "") + " | " + reviewLine(root);
}

const rows = [];
const details = [];
function probe(id, cls, desc, root, tool, input, opts) {
  const o = opts || {};
  const onDecisions = o.file === "decisions";
  const before = readOr(onDecisions ? decisionsFile(root) : canvasFile(root));
  const v = runHook(root, tool, input, o.env);
  let effect = "";
  if (v.decision === "ALLOW" && o.apply !== false) {
    const ap = applyTool(tool, input);
    effect = ap.ok ? (onDecisions ? describeDecisions(root, before) : describeCanvas(root, before)) : ap.err;
  }
  rows.push(id + " | " + cls + " | " + v.decision + " | " + (effect || "-") + " | " + desc);
  if (v.reason) details.push(id + " reason: " + String(v.reason).replace(/\n/g, " ").slice(0, 150));
  return { root: root, verdict: v, effect: effect };
}
function flush(header) {
  const out = [header, ""].concat(rows).concat(["", "--- deny reasons ---"]).concat(details).join("\n") + "\n";
  process.stdout.write(out);
}
function lineWith(needle) {
  const l = canvasSrc.split("\n").find(function (x) { return x.indexOf(needle) >= 0; });
  if (!l) throw new Error("no line with " + needle);
  return l;
}

module.exports = { fs: fs, path: path, cp: cp, REPO: REPO, PLUGIN: PLUGIN, GUARD: GUARD, canvasSrc: canvasSrc, decisionsSrc: decisionsSrc,
  canvasLib: canvasLib, reviewLib: reviewLib, hashLib: hashLib, decisionsLib: decisionsLib, profileLib: profileLib,
  makeProject: makeProject, canvasFile: canvasFile, decisionsFile: decisionsFile, readOr: readOr, runHook: runHook, applyTool: applyTool,
  probe: probe, flush: flush, lineWith: lineWith, committedList: committedList, statusLine: statusLine, reviewLine: reviewLine, describeCanvas: describeCanvas };
