'use strict';
// The agent column belongs to sub-project 2 (its spec §5). This module is
// the only place the SDK way touches it, so both ways keep one contract.
//
// What sub-project 2 named, read from the code as built and not from its plan
// (where some of it reads differently):
//   - the page in the column: a WebContentsView made in setUpAgent
//     (desktop/agent/index.js); its page is loaded with
//     view.webContents.loadFile, at setup desktop/agent/column/column.html.
//   - showing and hiding: the local show(next) in setUpAgent attaches or
//     detaches the view and tells the shell page over 'agent:shown'. The
//     column's "Not now" button hides it through show(false) (the 'column:run'
//     step 'not-now').
//   - asking whether a statement number exists: the 'column:lookup' handler
//     sends 'agent:lookup' to the shell page and waits for
//     'agent:lookup-result' (2 s), then answers with the first words or null.
//   - revealing a statement: the 'column:reveal' handler sends 'agent:reveal'
//     and focuses the shell page.
//   - the current project and its changes: the shell page reports it over
//     'agent:project', which calls controller.setProject(folder)
//     (desktop/agent/controller.js); the project itself is state().project,
//     and setProject emits 'project' when the folder actually changes.
//   - the shims' environment: agentEnv(...) in desktop/agent/launch.js sets
//     RH_ELECTRON, RH_GIT, RH_GIT_EXEC_PATH, RH_GIT_CONFIG_SYSTEM and
//     RH_GIT_TEMPLATE_DIR; the git paths come from gitEnv() in desktop/main.js.
//   - agent.way: readAgentStore/writeAgentStore in desktop/agent/store.js keep
//     it in <userData>/agent.json.
const columnHost = require('../index');
const { agentEnv } = require('../launch');

let gitEnv = null;                                 // set by main.js through useGitEnv

module.exports = {
  showPage: (file) => columnHost.showPage(file),
  hide: () => columnHost.hide(),
  lookupStatement: (number) => columnHost.lookupStatement(number),
  revealStatement: (number) => columnHost.revealStatement(number),
  currentProject: () => columnHost.currentProject(),
  onProjectChange: (cb) => columnHost.onProjectChange(cb),
  useGitEnv: (fn) => { gitEnv = fn; },
  // The shims' variables, taken from agentEnv so the names live in one place.
  shimEnv: () => {
    const g = gitEnv();
    const env = agentEnv({ base: {}, loginPath: '', shimsDir: '', electronPath: process.execPath, markerPath: '',
      git: { bin: g.PLACET_RESEARCH_GIT, execPath: g.GIT_EXEC_PATH, configSystem: g.GIT_CONFIG_SYSTEM, templateDir: g.GIT_TEMPLATE_DIR } });
    return Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('RH_')));
  },
};
