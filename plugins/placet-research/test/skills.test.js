'use strict';

// Pins what skill prose cannot enforce by itself: that the skills exist with a
// well-formed header, that the reviewer skill is granted no write tool, that
// `check` writes exactly one kind of entry, and that no model-facing skill
// tells the model to accept or to choose.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const skillsDir = path.resolve(__dirname, '..', 'skills');

function readSkill(name) {
  const text = fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, `${name}: SKILL.md has no frontmatter`);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    assert.ok(kv, `${name}: unreadable frontmatter line "${line}"`);
    fm[kv[1]] = kv[2];
  }
  return { fm, body: m[2], text };
}

const names = fs.readdirSync(skillsDir).filter((n) => fs.existsSync(path.join(skillsDir, n, 'SKILL.md')));

test('the new skills exist', () => {
  for (const n of ['canvas', 'canvas-review', 'accept', 'check', 'record-review', 'glossary-accept', 'literature-note']) {
    assert.ok(names.includes(n), `skills/${n}/SKILL.md is missing`);
  }
});

test('every skill has a name matching its directory and a description', () => {
  for (const n of names) {
    const { fm } = readSkill(n);
    assert.equal(fm.name, n, `${n}: name does not match the directory`);
    assert.ok(fm.description && fm.description.length > 20, `${n}: description missing or too short`);
  }
});

test('record-review grants no Write, Edit or NotebookEdit and no broad Bash', () => {
  const { fm } = readSkill('record-review');
  assert.ok(fm['allowed-tools'], 'record-review declares no allowed-tools');
  const tools = fm['allowed-tools'].split(/,\s*(?![^()]*\))/).map((t) => t.trim());
  for (const t of tools) {
    assert.doesNotMatch(t, /^(Write|Edit|NotebookEdit|MultiEdit)\b/, `record-review grants ${t}`);
    if (/^Bash/.test(t)) {
      assert.notEqual(t, 'Bash', 'bare Bash grants every command');
      assert.doesNotMatch(t, /^Bash\(node:\*\)$/, 'Bash(node:*) would allow log and accept');
      const inner = /^Bash\((.*)\)$/.exec(t)[1];
      assert.match(
        inner,
        /^(git (log|show|diff|blame|status|rev-parse|ls-files|cat-file)|placet-research (review|status)):\*$/,
        `record-review grants a Bash command that is not a read verb or review: ${t}`,
      );
    }
  }
});

test('record-review is invoked by the researcher, cites, and says "not in the record"', () => {
  const { fm, body } = readSkill('record-review');
  assert.equal(fm['disable-model-invocation'], 'true');
  assert.match(body, /not in the record/);
  assert.match(body, /overrides the SessionStart rules/);
  assert.match(body, /--key/);
  assert.match(body, /#<seq>/);
});

test('record-review cites a statement without a hash the harness never prints', () => {
  const { body } = readSkill('record-review');
  assert.match(body, /question id `n\.m`, its marker, and its exact words/);
  assert.match(body, /recorded hash/, 'the hash the log records must stay citable');
  assert.match(body, /never compute\s+one, never invent one/);
  // the old demand for a per-statement hash no allowed tool prints
  assert.doesNotMatch(body, /text hash the harness/);
  assert.doesNotMatch(body, /hashes differ and show both/);
});

test('check: its only write instruction is log DISCOVERY "<n.m> check"', () => {
  const { fm, body } = readSkill('check');
  assert.equal(fm['disable-model-invocation'], 'true');
  const cli = body.match(/(?:^|[\s`])placet-research (?=status|log|init|review|accept|choose)\w+/gm) || [];
  const verbs = cli.map((c) => c.trim().split(/\s+/)[1]);
  assert.ok(verbs.length > 0);
  for (const v of verbs) assert.ok(['status', 'log'].includes(v), `check runs the harness verb ${v}`);
  const logs = body.match(/placet-research log[^\n]*/g) || [];
  assert.equal(logs.length, 1, 'check must have exactly one log instruction');
  assert.match(logs[0], /log DISCOVERY "<n\.m> check" --body "<question>"$/);
  // no instruction to write the canvas
  assert.doesNotMatch(body, /\[(proposed|tentative|stated|accepted)[^\]]*\]\s+paragraph/i);
});

test('canvas multiverse mode uses the variant flags and never chooses', () => {
  const { body } = readSkill('canvas');
  assert.match(body, /init --variant <name> --lens "<text>"/);
  assert.match(body, /review --variant <name>/);
  assert.match(body, /you cannot choose, and will not/);
  assert.match(body, /`\[stated\]` or `\[accepted\]`/);
});

// SQ-205: the writing skills say who accepts a glossary entry, how a canvas
// statement and a manuscript cite one, and that the mechanical group is not a
// judgment about the construct.
test('canvas proposes glossary entries and cites them without accepting', () => {
  const { body } = readSkill('canvas');
  assert.match(body, /references\/construct-glossary\.md/);
  assert.match(body, /src: glossary\.md#felt-safety/);
  assert.match(body, /\(research\/glossary\.md#felt-safety\)/);
  assert.match(body, /<!-- constructs: felt-safety, speaking-frequency -->/);
  assert.match(body, /never accept them/);
  assert.match(body, /glossary-accept <id> --hash <64hex> --explained/);
  assert.match(body, /Definition: pending/);
  assert.match(body, /element 4 emerges from the material/);
});

test('canvas-review keeps the mechanical glossary group and the construct judgment apart', () => {
  const { body } = readSkill('canvas-review');
  assert.match(body, /Glossary\s+mechanics/);
  assert.match(body, /Declared construct coverage checked;\s+undeclared constructs require human inspection\./);
  assert.match(body, /Human construct judgment:\s+not performed by this check/);
  assert.match(body, /definition changed since\s+acceptance/);
  assert.match(body, /measure or observe the construct/);
  assert.match(body, /you never accept one/);
});

test('no model-facing skill runs accept or choose', () => {
  for (const n of names) {
    if (n === 'accept') continue; // researcher-only: disable-model-invocation, runs the accept it is named for
    const { body } = readSkill(n);
    assert.doesNotMatch(body, /placet-research\.js"\s+(accept|choose)\b/, `${n} runs accept or choose`);
    const lines = body.split('\n');
    lines.forEach((line, i) => {
      // `choose <name>` may appear only where the researcher is told to run it
      if (/\bplacet-research (accept|choose)\b/.test(line)) {
        const near = `${lines[i - 1] || ''} ${line}`;
        assert.match(near, /researcher|their own|you cannot/i, `${n}: "${line.trim()}" reads as an instruction to the model`);
      }
    });
  }
  assert.equal(readSkill('accept').fm['disable-model-invocation'], 'true');
});

test('every /placet-research:accept shown in a skill carries --explained', () => {
  let seen = 0;
  for (const n of names) {
    const { text } = readSkill(n);
    for (const line of text.split('\n')) {
      if (!line.includes('/placet-research:accept')) continue;
      seen += 1;
      assert.match(line, /--explained/, `${n}: accept without --explained: ${line.trim()}`);
    }
  }
  assert.ok(seen > 0, 'no skill shows the researcher how to accept');
});

function allowedTools(name) {
  const v = readSkill(name).fm['allowed-tools'];
  return v ? v.split(/,\s*(?![^()]*\))/).map((x) => x.trim()) : [];
}

test('no skill pre-approves a node route or a wildcard-led Bash rule (SQ-132 F5)', () => {
  for (const n of names) {
    for (const t of allowedTools(n)) {
      if (!/^Bash/.test(t)) continue;
      assert.doesNotMatch(t, /^Bash\(node/, `${n} pre-approves node: ${t}`);
      const inner = /^Bash\((.*)\)$/.exec(t);
      assert.ok(inner, `${n}: Bash rule has no pattern: ${t}`);
      assert.doesNotMatch(inner[1], /^\*/, `${n}: leading wildcard in ${t}`);
      assert.doesNotMatch(inner[1], / \*/, `${n}: wildcard before the subcommand in ${t}`);
    }
  }
});

test('check allows exactly status and log DISCOVERY through the bare command', () => {
  assert.deepEqual(allowedTools('check'), [
    'Read', 'Grep', 'Glob',
    'Bash(placet-research status:*)',
    'Bash(placet-research log DISCOVERY:*)',
  ]);
});

test('record-review allows only review, status and git read verbs', () => {
  const bash = allowedTools('record-review').filter((t) => /^Bash/.test(t));
  assert.ok(bash.includes('Bash(placet-research review:*)'));
  assert.ok(bash.includes('Bash(placet-research status:*)'));
  for (const t of bash) {
    assert.match(t, /^Bash\((placet-research (review|status)|git (log|show|diff|blame|status|rev-parse|ls-files|cat-file)):\*\)$/, t);
  }
});

test('accept declares no allowed-tools: its ! line runs outside the model', () => {
  assert.equal(readSkill('accept').fm['allowed-tools'], undefined);
});

// SQ-203: the glossary acceptance is the researcher's act on the same terms as
// the canvas one, so its skill is the same shape: no tool grant, no model
// invocation, and the command runs outside the model.
test('glossary-accept declares no allowed-tools and is the researcher\'s to invoke', () => {
  const { fm, body } = readSkill('glossary-accept');
  assert.equal(fm['disable-model-invocation'], 'true');
  assert.equal(fm['allowed-tools'], undefined);
  assert.match(body, /glossary accept \$ARGUMENTS/);
  assert.match(body, /Do not run `glossary accept` through the\s+Bash tool/);
});

test('the README and the technical appendix describe record-review citing words, not a hash of a current statement', () => {
  const docs = [path.resolve(__dirname, '..', 'README.md'), path.resolve(__dirname, '..', '..', '..', 'docs', 'technical-appendix.md')];
  for (const file of docs) {
    const text = fs.readFileSync(file, 'utf8').replace(/\s+/g, ' ');
    assert.doesNotMatch(text, /`n\.m` with the text hash|statement number plus hash/, file);
  }
});


test('SQ-212: glossary acceptance skill states the crash window without an all-or-nothing promise', () => {
  const { body } = readSkill('glossary-accept');
  assert.match(body, /SHA-256/);
  assert.match(body, /crash.*between.*writes/);
  assert.match(body, /unlogged/);
  assert.doesNotMatch(body, /neither file is left half-done/);
});

// SQ-216: package 4 of the literature-note design. The skill has to carry the
// boundary the checker prints, take explicit pointers rather than discover
// them, and route the one request itself instead of through a generic subagent.
// Blockquote markers go before the prose is compared: the boundary is the same
// words whether it is printed, quoted or fenced.
const flat = (text) => text.replace(/^> ?/gm, '').replace(/\s+/g, ' ');

test('literature-note carries the wording-only boundary and accepts nothing', () => {
  const { body } = readSkill('literature-note');
  const text = flat(body);
  assert.match(text, /This check covers only verbatim wording on the claimed printed page\./);
  assert.match(
    text,
    /It does not verify paraphrase, numbers or attribution, and it does not accept a research claim\./,
  );
  assert.match(text, /Project relevance and transfer judgments remain \[proposed\] for human review\./);
  assert.match(text, /You never accept anything/);
  assert.match(text, /Never label the note `fact-checked` or `human-read`/);
  assert.match(text, /never move a statement to `\[stated\]` or `\[accepted\]`/);
});

test('literature-note requires explicit pointers to the paper and the context', () => {
  const { body } = readSkill('literature-note');
  const text = flat(body);
  assert.match(text, /one explicit library pointer relative to `PLACET_RESEARCH_LIBRARY`/);
  assert.match(text, /Do not scan the library, do not discover sibling projects/);
  assert.match(text, /Write `unknown` for a reader or a read coverage nobody supplied/);
});

test('literature-note sends the one request itself, with no generic subagent exemption', () => {
  const { body } = readSkill('literature-note');
  const text = flat(body);
  assert.match(text, /not through a generic drafting subagent/);
  assert.match(text, /not by asking for a Sidequest scope exemption/);
  // the approved route is not a licence to bypass a refusal or add a provider
  assert.match(text, /not permission to bypass a refused action/);
  assert.match(text, /Do not substitute another provider/);
});
