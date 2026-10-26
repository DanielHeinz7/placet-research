#!/usr/bin/env node
"use strict";
// Builds placet-research-windows.zip for the GitHub release (sub-project 5):
// the plugin without test/, a start file and README.txt with CRLF line endings,
// zipped with macOS's /usr/bin/zip. Runs on the release Mac; nothing here runs
// on Windows.
//
//   node scripts/windows-zip.js <version> [--out <dir>]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const ASSET = "placet-research-windows.zip";

function crlf(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

function buildWindowsZip({ version, out, repo }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "rh-winzip-stage-"));
  try {
    const top = "placet-research-" + version + "-windows";
    const dir = path.join(stage, top);
    fs.mkdirSync(dir);
    fs.cpSync(path.join(repo, "plugins", "placet-research"), path.join(dir, "placet-research"), {
      recursive: true,
      filter: function (src) { return path.basename(src) !== "test" && path.basename(src) !== "node_modules"; },
    });
    fs.writeFileSync(path.join(dir, "Start placet-research.cmd"), crlf(path.join(repo, "windows", "Start placet-research.cmd")));
    fs.writeFileSync(path.join(dir, "README.txt"), crlf(path.join(repo, "windows", "README.txt")));
    fs.mkdirSync(out, { recursive: true });
    const zip = path.join(out, ASSET);
    fs.rmSync(zip, { force: true });
    cp.execFileSync("/usr/bin/zip", ["-q", "-r", "-X", zip, top], { cwd: stage });
    return zip;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const version = args[0];
  if (!version || version.startsWith("--")) {
    process.stderr.write("usage: node scripts/windows-zip.js <version> [--out <dir>]\n");
    process.exit(2);
  }
  const at = args.indexOf("--out");
  const out = at >= 0 && args[at + 1] ? path.resolve(args[at + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), "rh-winzip-"));
  process.stdout.write(buildWindowsZip({ version: version, out: out, repo: path.resolve(__dirname, "..") }) + "\n");
}

module.exports = { ASSET, buildWindowsZip };
