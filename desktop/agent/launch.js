'use strict';
// The one argument vector and environment for the person's claude (spec
// §5.2, §5.3). The vector goes to the pty without a shell.

const SESSION_SETTINGS = '{"disableAllHooks":false,"enabledPlugins":{"placet-research@inline":true}}';
const FORBIDDEN_FLAGS = ['--bare', '--safe-mode', '--dangerously-skip-permissions', '--permission-mode', '--system-prompt', '--append-system-prompt'];

function claudeArgs({ pluginRoot, resume = false, screenReader = false }) {
  const args = ['--plugin-dir', pluginRoot, '--settings', SESSION_SETTINGS];
  if (resume) args.push('--continue');
  if (screenReader) args.push('--ax-screen-reader');
  return args;
}

// Only these come from the app's own environment. Anything else in it, such
// as ELECTRON_RUN_AS_NODE or NODE_OPTIONS from a developer's shell, would
// change how the agent's programs run.
const KEEP = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'];

function agentEnv({ base, loginPath, shimsDir, electronPath, git, markerPath }) {
  const env = {};
  for (const key of KEEP) if (typeof base[key] === 'string') env[key] = base[key];
  return {
    ...env,
    PATH: `${shimsDir}:${loginPath}`,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    RH_ELECTRON: electronPath,
    RH_GIT: git.bin,
    RH_GIT_EXEC_PATH: git.execPath,
    RH_GIT_CONFIG_SYSTEM: git.configSystem,
    RH_GIT_TEMPLATE_DIR: git.templateDir,
    PLACET_RESEARCH_APP_MARKER: markerPath,
  };
}

module.exports = { SESSION_SETTINGS, FORBIDDEN_FLAGS, claudeArgs, agentEnv };
