'use strict';
// Prints what the spec left unverified: whether the bundled git can store
// credentials in the macOS Keychain.
const fs = require('node:fs');
const path = require('node:path');
const { gitPath, credentialHelper } = require('../git-path');

const helper = credentialHelper();
const keychainBin = path.join(path.dirname(gitPath()), '..', 'libexec', 'git-core', 'git-credential-osxkeychain');
console.log(`git: ${gitPath()}`);
console.log(`credential.helper: ${helper || '(none)'}`);
console.log(`git-credential-osxkeychain bundled: ${fs.existsSync(keychainBin) ? keychainBin : 'no'}`);
