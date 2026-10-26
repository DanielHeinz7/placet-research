'use strict';

// Regenerates view-state-variants.json and view-state-chosen.json: the exact
// GET /api/state response (viewState from bin/canvas-serve.js) of a scratch
// project, read at two points of one run — with three framings to compare and
// two open check questions, and after the researcher chose one framing and
// accepted a statement despite those questions. Nothing here is hand-written
// state: every file the view reads was written through the CLI, so the fixtures
// hold what the approval path really produces. Run it from anywhere:
//
//   node test/fixtures/make-variants-fixtures.js
//
// The seal keys and text hashes differ from one run to the next, the dates are
// the day it runs; the view tests read the fixtures for their shape, not for
// those values.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '..', '..');
const cli = path.join(pluginRoot, 'bin', 'placet-research.js');

delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.PLACET_RESEARCH_DIR;
process.env.PLACET_RESEARCH_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-fixture-state-'));
const { viewState } = require('../../bin/canvas-serve');

// The name every entry carries as `By` (SQ-177): set here, where the state dir
// is the script's own, so the fixtures hold the same bytes on a machine with a
// git identity and on one without.
fs.writeFileSync(path.join(process.env.PLACET_RESEARCH_STATE_DIR, 'name'), 'A. Researcher\n');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-fixture-'));

function run(args) {
  const out = childProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    encoding: 'utf8',
  });
  if (out.status !== 0) throw new Error(`placet-research ${args.join(' ')}: ${out.stdout}${out.stderr}`);
}

// A statement where question `id`'s `_(empty)_` stands, as the model writes it.
function fill(file, id, statement) {
  const text = fs.readFileSync(file, 'utf8');
  const heading = text.indexOf(`## ${id} `);
  const at = text.indexOf('_(empty)_', heading);
  if (heading < 0 || at < 0) throw new Error(`${file}: no empty ${id}`);
  fs.writeFileSync(file, `${text.slice(0, at)}${statement}${text.slice(at + '_(empty)_'.length)}`);
}

const SHARED = {
  '1.1': 'When do members\' suggestions in organizational meetings receive serious consideration rather than polite acknowledgement? [proposed, unverified]',
  '1.2': 'Speaking frequency is well documented; whether a proposal is taken up is not. [tentative, unverified]',
  '1.3': 'Teams lose good ideas without anyone deciding to drop them. [proposed, unverified]',
  '5.1': 'Twelve recorded meetings of one product team over a quarter. [tentative, unverified]',
};
const VARIANTS = [
  {
    name: 'power',
    lens: 'power and hierarchy',
    own: {
      '2.4': 'Work on voice treats speaking as influence and overlooks who is permitted to be heard. [proposed, unverified]',
      '3.1': 'How does a speaker\'s rank shape whether a proposal is taken up? [proposed, unverified]',
      '4.1': 'Rank, deference and uptake. [tentative, unverified]',
      '6.1': 'Code every proposal for its proposer\'s rank and for whether the next speaker built on it. [proposed, unverified]',
    },
  },
  {
    name: 'sense-making',
    lens: 'collective sense-making: "who hears whom"',
    own: {
      '2.4': 'Work on voice assumes a proposal carries its own force; uptake may depend on the frame the room already shares. [proposed, unverified]',
      '3.1': 'How does a proposal\'s fit with the room\'s shared frame shape whether it is taken up? [proposed, unverified]',
      '4.1': 'Shared frame, fit, uptake. [tentative, unverified]',
      '6.1': 'Code each proposal for the frame it invokes and whether the next turn extends it. [proposed, unverified]',
      '7.1': 'A proposal that fits the frame is taken up within two turns. [tentative, unverified]',
    },
  },
  {
    name: 'rituals',
    lens: 'meeting routines and turn-taking',
    own: {
      '2.4': 'Work on voice treats the meeting as a neutral container; its routines may decide who can propose at all. [proposed, unverified]',
      '3.1': 'Which meeting routines make a proposal available for uptake? [proposed, unverified]',
      '4.1': 'Routine, opening, uptake. [tentative, unverified]',
      '6.1': 'Code each meeting for its agenda routine and for the points where a proposal can enter. [proposed, unverified]',
    },
  },
];
const CHECKS = [
  'Does the twelve-meeting corpus hold enough proposals to tell uptake from acknowledgement?',
  'Which source says speaking frequency is "well documented" for meetings like these?',
];

run(['init', '--project', 'voice-uptake', '--mode', 'seed']);
const canvasOf = (...parts) => path.join(root, 'research', ...parts, 'canvas.md');
for (const v of VARIANTS) {
  run(['init', '--variant', v.name, '--lens', v.lens]);
  for (const [id, text] of Object.entries({ ...SHARED, ...v.own })) fill(canvasOf('variants', v.name), id, text);
}
// The main canvas holds what was imported before the framings were generated.
for (const id of ['1.1', '1.2']) fill(canvasOf(), id, SHARED[id]);
for (const question of CHECKS) run(['log', 'DISCOVERY', '1.2 check', '--body', question]);

const dump = (name) => {
  const view = viewState(root, pluginRoot);
  if (!view.ok) throw new Error(view.error);
  fs.writeFileSync(path.join(__dirname, name), `${JSON.stringify(view.body, null, 2)}\n`);
};
dump('view-state-variants.json');

run(['choose', 'power', '--why', 'Every one of the twelve meetings records rank, so the framing can be tested on the whole corpus.']);

// The same log with the framing entry's Why reworded after it was sealed: the
// ledger breaks at that entry (#3, the last one), the two check questions before
// it still verify. What a hand edit, a merge or a raw write to decisions.md
// leaves behind; the view has to say so (SQ-139).
const log = path.join(root, 'research', 'decisions.md');
const sealedLog = fs.readFileSync(log, 'utf8');
const forged = sealedLog.replace('so the framing can be tested on the whole corpus.', 'so the researcher prefers it.');
if (forged === sealedLog) throw new Error('the framing entry no longer carries the expected Why');
fs.writeFileSync(log, forged);
dump('view-state-broken.json');
fs.writeFileSync(log, sealedLog);

run([
  'accept', '1.2', '--match', 'Speaking frequency',
  '--why', 'The gap is uptake, not voice.',
  '--explained', 'Earlier work counts who speaks; none of it asks whether a proposal is taken up, and that is what this study measures.',
]);
dump('view-state-chosen.json');
