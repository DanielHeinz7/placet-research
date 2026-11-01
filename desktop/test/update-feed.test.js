'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeed, mergeFeeds } = require('../lib/update-feed');

const feed = (arch, date) => [
  'version: 0.6.0',
  'files:',
  `  - url: placet-research-0.6.0-mac-${arch}.zip`,
  `    sha512: ${arch}Zx/AbC+12==`,
  '    size: 104857600',
  '    blockMapSize: 110000',
  `  - url: research-harness-mac-${arch}.dmg`,
  `    sha512: ${arch}Qq/xyz+34==`,
  '    size: 109051904',
  `path: placet-research-0.6.0-mac-${arch}.zip`,
  `sha512: ${arch}Zx/AbC+12==`,
  `releaseDate: '${date}'`,
  '',
].join('\n');

test('reads electron-builder\'s feed shape', () => {
  const f = parseFeed(feed('arm64', '2026-10-20T09:00:00.000Z'));
  assert.equal(f.version, '0.6.0');
  assert.equal(f.files.length, 2);
  assert.deepEqual(f.files[0], { url: 'placet-research-0.6.0-mac-arm64.zip', sha512: 'arm64Zx/AbC+12==', size: 104857600, blockMapSize: 110000 });
  assert.equal(f.releaseDate, '2026-10-20T09:00:00.000Z');
});

test('merging lists both processors once and keeps the newer date', () => {
  const merged = parseFeed(mergeFeeds([feed('arm64', '2026-10-20T09:00:00.000Z'), feed('x64', '2026-10-20T09:05:00.000Z')]));
  assert.deepEqual(merged.files.map((f) => f.url), ['placet-research-0.6.0-mac-arm64.zip', 'research-harness-mac-arm64.dmg', 'placet-research-0.6.0-mac-x64.zip', 'research-harness-mac-x64.dmg']);
  assert.equal(merged.path, 'placet-research-0.6.0-mac-arm64.zip');
  assert.equal(merged.releaseDate, '2026-10-20T09:05:00.000Z');
});

test('feeds of two versions are refused', () => {
  assert.throws(() => mergeFeeds([feed('arm64', 'x'), feed('x64', 'x').replace('version: 0.6.0', 'version: 0.6.1')]), /disagree on the version/);
});

test('an unexpected line is refused, not skipped', () => {
  assert.throws(() => parseFeed('version: 0.6.0\nfiles:\n\t- url: x\n'), /unexpected line/);
});

test('electron-updater\'s YAML reader reads the merged feed the same way', (t) => {
  let yaml;
  try { yaml = require('js-yaml'); } catch { t.skip('js-yaml is not installed'); return; }
  const text = mergeFeeds([feed('arm64', '2026-10-20T09:00:00.000Z'), feed('x64', '2026-10-20T09:05:00.000Z')]);
  const viaYaml = yaml.load(text);
  assert.equal(viaYaml.files.length, 4);
  assert.equal(viaYaml.files[2].sha512, 'x64Zx/AbC+12==');
  assert.equal(viaYaml.releaseDate, '2026-10-20T09:05:00.000Z');
});
