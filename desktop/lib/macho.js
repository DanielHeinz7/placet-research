'use strict';
// Finds the Mach-O files in a folder and reads their code signatures: before a
// build, to keep signatures that arrive with a Developer ID (spec 4.2), and
// after it, to check every binary in the app (spec 4.3).
const fs = require('node:fs');
const path = require('node:path');
const { runTool } = require('./distribution');

const THIN = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);
const FAT = new Set([0xcafebabe, 0xcafebabf]);

function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(8);
    if (fs.readSync(fd, head, 0, 8, 0) < 8) return false;
    const magic = head.readUInt32BE(0);
    if (THIN.has(magic)) return true;
    // A Java class file starts with 0xcafebabe too; its next word is a version, 45 or more.
    return FAT.has(magic) && head.readUInt32BE(4) < 45;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function machOFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (isMachO(file)) found.push(file);
  }
  return found.sort();
}

function parseCodesign(text) {
  if (/code object is not signed at all/.test(text)) return { signed: false };
  const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(text);
  const names = flags ? flags[1].split(',') : [];
  const authority = /^Authority=(.+)$/m.exec(text);
  const team = /^TeamIdentifier=(.+)$/m.exec(text);
  return {
    signed: true,
    adhoc: names.includes('adhoc') || /^Signature=adhoc$/m.test(text),
    runtime: names.includes('runtime'),
    timestamp: /^Timestamp=/m.test(text),
    authority: authority ? authority[1] : null,
    team: team && team[1] !== 'not set' ? team[1] : null,
  };
}

// codesign writes its description to stderr.
function signature(file, run = runTool) {
  const r = run('codesign', ['-dvvv', file]);
  return parseCodesign(r.stderr + r.stdout);
}

function keepList(dir, run = runTool) {
  return machOFiles(dir).filter((file) => {
    const sig = signature(file, run);
    return sig.signed && sig.runtime && sig.timestamp && Boolean(sig.authority) && sig.authority.startsWith('Developer ID Application: ');
  }).map((file) => path.relative(dir, file));
}

module.exports = { isMachO, machOFiles, parseCodesign, signature, keepList };
