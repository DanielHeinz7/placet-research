'use strict';
// electron-builder 26 leaves every `.dll` and `.exe` under node_modules out of the
// app on non-Windows platforms (app-builder-lib, appFileCopier.js,
// getNodeModuleExcludedExts), and no `files` pattern brings one back: the
// extension filter is skipped only when the `onNodeModuleFile` option returns true
// for that file, and that option has to be a function, which the builder settings
// in lib/distribution.js cannot carry as data. dugite's `git-credential-manager`
// is a .NET apphost that loads `git-credential-manager.dll` beside it, so without
// these files `git credential-manager --version` exits 154 and a person's https
// sign-in never reaches the macOS keychain.
//
// This runs after the app directory is packed and before electron-builder signs
// it (app-builder-lib, platformPackager.js: emitAfterPack, then
// doSignAfterPack), so the same signature seals the copied files. It copies what
// the packed app is missing from the dugite tree that was installed, modes
// included, instead of naming extensions: that list belongs to electron-builder,
// and a diff cannot fall behind it.
const fs = require('node:fs');
const path = require('node:path');

const GIT = path.join('node_modules', 'dugite', 'git');

// Every regular file under source that has no counterpart under destination.
function missing(source, destination) {
  const found = [];
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) found.push(...missing(from, to));
    else if (entry.isFile() && !fs.existsSync(to)) found.push([from, to]);
  }
  return found;
}

async function afterPack(context) {
  const source = path.join(context.packager.projectDir, GIT);
  const unpacked = path.join(context.packager.getResourcesDir(context.appOutDir), 'app.asar.unpacked', GIT);
  if (!fs.existsSync(unpacked)) {
    throw new Error(`afterPack: ${unpacked} does not exist, so dugite's git is not unpacked and these files have nowhere to go. Keep "node_modules/dugite/**" in asarUnpack.`);
  }
  const files = missing(source, unpacked);
  for (const [from, to] of files) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, fs.statSync(from).mode & 0o777);
  }
  console.log(`afterPack: put back ${files.length} file(s) electron-builder left out of ${GIT}.`);
}

module.exports = afterPack;
