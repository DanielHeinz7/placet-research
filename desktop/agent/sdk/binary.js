'use strict';
// The Claude Code binary that ships inside the SDK's per-platform package.
// In the built app it runs from the unpacked copy beside app.asar.
const path = require('node:path');

function binaryPath({ arch = process.arch } = {}) {
  const dir = path.dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-darwin-${arch}/package.json`));
  return path.join(dir, 'claude').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

module.exports = { binaryPath };
