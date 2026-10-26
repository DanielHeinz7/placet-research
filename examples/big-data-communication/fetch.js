#!/usr/bin/env node
'use strict';

// Fetches the PDFs this alternative demo reads, from the one Zenodo
// version pinned in sources.json, and refuses any file whose size or sha256
// differs from the pinned value. Nothing from the dataset is stored in this
// repository: the data is fetched, checked, and written only if it matches.
//
//   node fetch.js [--into <dir>]      default: ./interviews
//
// Plain Node 18 or newer, no dependencies.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sources = require('./sources.json');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// null when the bytes are the pinned file, otherwise one line saying why not.
function mismatch(file, buffer) {
  if (buffer.length !== file.size) return `${file.name}: ${buffer.length} bytes, pinned ${file.size}`;
  const got = sha256(buffer);
  if (got !== file.sha256) return `${file.name}: sha256 ${got}, pinned ${file.sha256}`;
  return null;
}

function urlOf(file) {
  return `https://zenodo.org/api/records/${sources.record}/files/${encodeURIComponent(file.name)}/content`;
}

async function main(argv) {
  const at = argv.indexOf('--into');
  const dest = path.resolve(at >= 0 && argv[at + 1] ? argv[at + 1] : 'interviews');
  fs.mkdirSync(dest, { recursive: true });
  console.log(`Fetching ${sources.files.length} files of Zenodo record ${sources.record} (${sources.licence}) into ${dest}`);
  let fetched = 0;
  for (const file of sources.files) {
    const target = path.join(dest, file.name);
    if (fs.existsSync(target) && mismatch(file, fs.readFileSync(target)) === null) {
      console.log(`ok       ${file.name} (already present)`);
      continue;
    }
    // Zenodo answers 403 to a request that names no client.
    const response = await fetch(urlOf(file), { headers: { 'User-Agent': 'placet-research-demo-fetch' } });
    if (!response.ok) {
      console.log(`Cannot fetch ${file.name}: HTTP ${response.status}. Nothing more was written.`);
      return 1;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const problem = mismatch(file, buffer);
    if (problem) {
      console.log(`Refused ${problem}. The record is not the one this demo pins; the file was not written.`);
      return 1;
    }
    fs.writeFileSync(target, buffer);
    fetched += 1;
    console.log(`ok       ${file.name} (${buffer.length} bytes)`);
  }
  console.log(`${sources.files.length} files match the pinned record (${fetched} fetched). Cite it as https://doi.org/${sources.doi} (${sources.licence}).`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.log(`Cannot fetch: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { mismatch, sha256, urlOf, sources };
