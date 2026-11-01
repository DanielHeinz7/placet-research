'use strict';
// Merges the latest-mac.yml of the arm64 build and of the x64 build into one
// feed, so electron-updater on either kind of Mac finds its own zip (spec
// 4.2). electron-builder writes these files in one fixed shape; this reads
// that shape and refuses anything else.

function scalar(raw) {
  const v = raw.trim();
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

function parseFeed(text) {
  const feed = { files: [] };
  let item = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let m = /^ {2}- (\w+): (.*)$/.exec(line);
    if (m) { item = { [m[1]]: scalar(m[2]) }; feed.files.push(item); continue; }
    m = /^ {4}(\w+): (.*)$/.exec(line);
    if (m && item) { item[m[1]] = scalar(m[2]); continue; }
    m = /^(\w+):(?: (.*))?$/.exec(line);
    if (m) { item = null; if (m[1] !== 'files') feed[m[1]] = scalar(m[2] || ''); continue; }
    throw new Error(`unexpected line in the update feed: ${JSON.stringify(line)}`);
  }
  return feed;
}

function formatFeed(feed) {
  const lines = [`version: ${feed.version}`, 'files:'];
  for (const file of feed.files) {
    const [first, ...rest] = Object.keys(file);
    lines.push(`  - ${first}: ${file[first]}`);
    for (const key of rest) lines.push(`    ${key}: ${file[key]}`);
  }
  for (const key of Object.keys(feed)) {
    if (!['version', 'files', 'releaseDate'].includes(key)) lines.push(`${key}: ${feed[key]}`);
  }
  if (feed.releaseDate) lines.push(`releaseDate: '${feed.releaseDate}'`);
  return `${lines.join('\n')}\n`;
}

function mergeFeeds(texts) {
  const feeds = texts.map(parseFeed);
  const versions = feeds.map((f) => f.version);
  if (new Set(versions).size !== 1) throw new Error(`the update feeds disagree on the version (${versions.join(', ')})`);
  const merged = { ...feeds[0], files: [] };
  const seen = new Set();
  for (const f of feeds) {
    for (const file of f.files) {
      if (!seen.has(file.url)) { seen.add(file.url); merged.files.push(file); }
    }
  }
  merged.releaseDate = feeds.map((f) => f.releaseDate).filter(Boolean).sort().pop();
  return formatFeed(merged);
}

module.exports = { parseFeed, mergeFeeds };
