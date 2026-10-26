'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const canvas = require('../hooks/lib/canvas');
const decisions = require('../hooks/lib/decisions');
const seal = require('../hooks/lib/seal');

const root = path.resolve(__dirname, '../../..');
const example = path.join(root, 'examples', 'big-data-communication');
const cli = path.join(root, 'plugins', 'placet-research', 'bin', 'placet-research.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-replacement-'));
const project = path.join(scratch, 'project');
fs.mkdirSync(project);
const state = path.join(scratch, 'private-state');
// The name every entry carries as `By` (SQ-177). Written into this fixture's own
// state dir, which comes before git config user.name, so the walkthrough prints
// the same bytes on a machine with a git identity and on one without.
fs.mkdirSync(state, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(state, 'name'), 'A. Researcher\n');
const { CLAUDE_PROJECT_DIR: _p, PLACET_RESEARCH_DIR: _d, ...ambient } = process.env;
const env = { ...ambient, PLACET_RESEARCH_STATE_DIR: state, CLAUDE_PLUGIN_ROOT: path.join(root, 'plugins', 'placet-research') };

function run(file, args) {
  const out = cp.spawnSync(process.execPath, [file, ...args], { cwd: project, env, encoding: 'utf8' });
  assert.equal(out.status, 0, `${file} ${args.join(' ')}: ${out.stdout}${out.stderr}`);
  return out.stdout;
}

let walked;
function walk() {
  if (walked) return walked;
  const readme = fs.readFileSync(path.join(example, 'README.md'), 'utf8');
  const commands = [...readme.matchAll(/```sh\n([\s\S]*?)```/g)]
    .flatMap(([, block]) => block.trim().split('\n'))
    .filter(line => line.startsWith('placet-research ') || line.endsWith('/recorded.js'));
  assert.equal(commands.length, 9, 'the replacement README has the complete CLI path');
  const outputs = commands.map(command => {
    const line = command.replace('~/placet-research/examples/big-data-communication/recorded.js', path.join(example, 'recorded.js'));
    const args = line.match(/(?:"[^"]*"|\S+)/g).map(token => token.replace(/^"|"$/g, ''));
    return args[0] === 'placet-research' ? run(cli, args.slice(1)) : run(args[1], []);
  });
  const [init, recorded, variant, chosen, check, first, second, status, review] = outputs;
  walked = { init, recorded, variant, chosen, check, first, second, status, review };
  return walked;
}

test('replacement fetch pins all and only the 14 PDF bytes of record 6344804', () => {
  const fetcher = require(path.join(example, 'fetch.js'));
  const files = fetcher.sources.files;
  assert.equal(fetcher.sources.record, 6344804);
  assert.equal(fetcher.sources.licence, 'CC-BY-4.0');
  assert.deepEqual(files.map(f => f.name), [
    ...Array.from({ length: 13 }, (_, i) => `Copy of Interview ${i + 1} Transcript.pdf`),
    'Research participants.pdf',
  ]);
  for (const f of files) {
    assert.ok(f.size > 0 && Number.isInteger(f.size));
    assert.match(f.sha256, /^[a-f0-9]{64}$/);
    assert.equal(fetcher.urlOf(f), `https://zenodo.org/api/records/6344804/files/${encodeURIComponent(f.name)}/content`);
  }
  const pinned = { name: 'sample.pdf', size: 5, sha256: fetcher.sha256(Buffer.from('hello')) };
  assert.equal(fetcher.mismatch(pinned, Buffer.from('hello')), null);
  assert.match(fetcher.mismatch(pinned, Buffer.from('hellp')), /sha256/);
  assert.match(fetcher.mismatch(pinned, Buffer.from('hell')), /4 bytes, pinned 5/);
});

test('replacement walkthrough chooses a framing, accepts despite an open check, and verifies the seal', () => {
  const result = walk();
  assert.match(result.init, /Created research\/canvas.md/);
  assert.match(result.recorded, /variants\/credibility\/canvas.md/);
  assert.match(result.variant, /variant credibility/);
  assert.match(result.chosen, /Chose framing credibility/);
  assert.match(result.check, /Logged #2 DISCOVERY 3.1 check/);
  assert.match(result.first, /Accepted 1.1/);
  assert.match(result.second, /Accepted with open check questions: #2/);
  assert.match(result.status, /Ledger: verified/);
  assert.match(result.review, /verified: 4 sealed entries/);
  const log = fs.readFileSync(path.join(project, 'research', 'decisions.md'), 'utf8');
  const entries = decisions.parseDecisions(log).entries;
  assert.deepEqual(entries.map(e => `${e.seq} ${e.kind} ${e.ref}`), [
    '1 DECISION framing chosen: credibility', '2 DISCOVERY 3.1 check',
    '3 DECISION 1.1 accepted', '4 DECISION 3.1 accepted',
  ]);
  assert.deepEqual(entries[3].openAtAccept, [2]);
  assert.match(entries[0].rejected, /audience \(lens: .*\); crisis \(lens: .*\)/);
  const keyFile = /Sealing key created at (\S+) \(mode/.exec(result.init)?.[1];
  assert.ok(keyFile, 'init printed the project sealing key path');
  const key = seal.readKeyFile(keyFile);
  assert.equal(seal.verifyChain(log, key).status, 'verified');
});

test('three hand-written variants cite only pinned PDF pages and stay uncommitted', () => {
  walk();
  const sources = require(path.join(example, 'sources.json'));
  const known = new Set(sources.files.map(f => f.name));
  const lenses = new Set();
  assert.deepEqual(fs.readdirSync(path.join(project, 'research', 'variants')).sort(), ['audience', 'credibility', 'crisis']);
  for (const name of ['audience', 'credibility', 'crisis']) {
    const parsed = canvas.parseCanvas(fs.readFileSync(path.join(project, 'research', 'variants', name, 'canvas.md'), 'utf8'));
    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.frontmatter.variant, name);
    lenses.add(parsed.frontmatter.lens);
    const statements = canvas.allStatements(parsed).filter(s => s.marker);
    assert.deepEqual(statements.map(s => s.question), ['1.1', '3.1', '7.1', '9.1']);
    for (const s of statements) {
      assert.ok(['proposed', 'tentative'].includes(s.marker));
      const tags = s.tags.filter(t => t.startsWith('src:'));
      if (s.question !== '3.1') assert.ok(tags.length > 0, `${name} ${s.question} needs a citation`);
      for (const tag of tags) {
        const match = /^src: (.+\.pdf)#page=([1-9]\d*)$/.exec(tag);
        assert.ok(match && known.has(match[1]), `${name} cites a pinned PDF page: ${tag}`);
      }
    }
  }
  assert.equal(lenses.size, 3);
});
