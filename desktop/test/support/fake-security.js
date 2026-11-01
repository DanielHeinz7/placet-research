'use strict';
// The fake `security` for tests, shared by keychain.test.js and the Electron
// smoke test. It never touches the real Keychain.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The fake `security`, run in a process of its own; items live in a JSON file.
// It answers the way /usr/bin/security did on macOS 26: `-i` reads a command
// line with double quotes and backslash escapes, and the last of a repeated
// option wins; a missing item exits 44; `-w` prints a value with a byte outside
// printable ASCII as bare hex; `-g` prints `password: "<value>"` on stderr when
// every byte is printable ASCII other than a backslash, else
// `password: 0x<HEX>  "<value with octal escapes>"`. Each call appends its
// arguments to `log`, and its stdin, its stderr and whether an environment
// value contains `watch` to `io`. Once the file `fail` exists, every call
// repeats what it got, and the item it found, on stderr and exits 1.
function fakeMain(dir, watch) {
  const fs = require('node:fs');
  const file = (name) => `${dir}/${name}`;
  let items = {};
  try { items = JSON.parse(fs.readFileSync(file('items.json'), 'utf8')); } catch {}
  const save = () => fs.writeFileSync(file('items.json'), JSON.stringify(items));
  const args = process.argv.slice(2);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; }).on('end', () => {
    const words = [];
    if (args[0] === '-i') {
      const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
      for (let m; (m = re.exec(input));) words.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
    } else words.push(...args);
    const at = (flag) => words[words.lastIndexOf(flag) + 1];
    const key = `${at('-s')}/${at('-a')}`;
    const printable = (b) => b >= 0x20 && b <= 0x7e;
    const plain = (b) => printable(b) && b !== 0x5c;
    let stdout = '';
    let stderr = '';
    let status = 0;
    if (fs.existsSync(file('fail'))) {
      stderr = `security: failed: ${input || words.join(' ')} ${items[key] ?? ''}\n`;
      status = 1;
    } else if (words[0] === 'add-generic-password') {
      items[key] = at('-w');
      save();
    } else if (!(key in items)) {
      status = 44;
    } else if (words[0] === 'delete-generic-password') {
      delete items[key];
      save();
    } else if (words.includes('-g')) {
      const bytes = [...Buffer.from(items[key])];
      const escaped = bytes.map((b) => (plain(b) ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, '0')}`)).join('');
      stdout = `attributes:\n    "acct"<blob>="${at('-a')}"\n    "svce"<blob>="${at('-s')}"\n`;
      stderr = bytes.every(plain)
        ? `password: "${items[key]}"\n`
        : `password: 0x${Buffer.from(bytes).toString('hex').toUpperCase()} ${bytes.some(plain) ? ` "${escaped}"` : ''}\n`;
    } else if (words.includes('-w')) {
      const bytes = Buffer.from(items[key]);
      stdout = `${[...bytes].every(printable) ? items[key] : bytes.toString('hex')}\n`;
    }
    fs.appendFileSync(file('log'), `${JSON.stringify({ args })}\n`);
    const envHasWatch = watch !== null && Object.values(process.env).some((v) => v.includes(watch));
    fs.appendFileSync(file('io'), `${JSON.stringify({ args, input, stderr, envHasWatch })}\n`);
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.exitCode = status;
  });
}

const dirs = [];
// A folder a test made and wants gone when the process ends.
const trackDir = (dir) => { dirs.push(dir); return dir; };
process.on('exit', () => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

function fakeSecurity({ watch = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-sec-'));
  trackDir(dir);
  const bin = path.join(dir, 'security');
  fs.writeFileSync(bin, `#!${process.execPath}\n'use strict';\n(${fakeMain})(${JSON.stringify(dir)}, ${JSON.stringify(watch)});\n`, { mode: 0o755 });
  return {
    bin,
    log: () => fs.readFileSync(path.join(dir, 'log'), 'utf8'),
    io: () => fs.readFileSync(path.join(dir, 'io'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
    fail: () => fs.writeFileSync(path.join(dir, 'fail'), ''),
    items: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'items.json'), 'utf8')); } catch { return {}; } },
  };
}

module.exports = { fakeSecurity, trackDir };
