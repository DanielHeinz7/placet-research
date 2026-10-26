'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('plugin.json declares the fixed identity', () => {
  const plugin = readJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
  assert.equal(plugin.name, 'placet-research');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof plugin.description, 'string');
  assert.equal(plugin.license, 'MIT');
});

test('marketplace.json lists the plugin with the same version and description', () => {
  const marketplace = readJson(path.join(repoRoot, '.claude-plugin', 'marketplace.json'));
  const plugin = readJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
  assert.equal(marketplace.name, 'placet-research');
  const entry = marketplace.plugins.find((p) => p.name === 'placet-research');
  assert.ok(entry, 'marketplace entry missing');
  assert.equal(entry.source, './plugins/placet-research');
  assert.equal(entry.version, plugin.version, 'version drifted between marketplace and plugin');
  assert.equal(entry.description, plugin.description, 'description drifted between marketplace and plugin');
});

test('hooks.json is valid and every command is rooted at CLAUDE_PLUGIN_ROOT', () => {
  const hooks = readJson(path.join(pluginRoot, 'hooks', 'hooks.json'));
  assert.equal(typeof hooks.description, 'string');
  for (const [event, groups] of Object.entries(hooks.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        assert.equal(hook.type, 'command', `${event}: hook type`);
        assert.match(hook.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[a-z-]+\.js"$/, `${event}: command shape`);
        assert.ok(hook.timeout <= 10, `${event}: timeout too long`);
      }
    }
  }
});

// A PreToolUse command hook that times out or crashes lets the tool call
// through unless it sets onFailure: "block" (Claude Code 2.1.295 or later).
// The guard is a gate, so it blocks. SessionStart only adds context and stays
// fail-open.
test('the guard blocks the tool call when it times out or crashes; SessionStart fails open', () => {
  const hooks = readJson(path.join(pluginRoot, 'hooks', 'hooks.json'));
  const commandHooks = (event) => hooks.hooks[event].flatMap((group) => group.hooks);
  const guard = commandHooks('PreToolUse');
  assert.ok(guard.length > 0, 'PreToolUse carries no hook');
  for (const hook of guard) {
    assert.equal(hook.onFailure, 'block', `PreToolUse ${hook.command}: onFailure`);
  }
  for (const hook of commandHooks('SessionStart')) {
    assert.notEqual(hook.onFailure, 'block', `SessionStart ${hook.command}: onFailure`);
  }
});

test('there is no commands/ directory', () => {
  assert.equal(fs.existsSync(path.join(pluginRoot, 'commands')), false);
});
