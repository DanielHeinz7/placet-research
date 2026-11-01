'use strict';
// Runs in an Electron utilityProcess: one agent conversation, or one
// connection test. The secret arrives in the first message and lives only
// here and in the agent binary's environment; it is never logged.
const { createSession } = require('./session');
const { buildOptions, buildTestOptions } = require('./options');
const { testConnection } = require('./connection');

// Electron gives a utility process process.parentPort; a plain Node child (the
// tests) has the process IPC channel instead.
const port = process.parentPort || { on: (ev, cb) => process.on('message', (data) => cb({ data })), postMessage: (m) => process.send(m) };
const post = (m) => port.postMessage(m);
let session = null;

// Loaded once, so messages that arrive together are handled in order.
let sdk = null;
const loadSdk = () => { sdk = sdk || import('@anthropic-ai/claude-agent-sdk'); return sdk; };

const stopped = (reason) => post({ type: 'event', event: { kind: 'stopped', reason } });

async function handle(data) {
  const { query } = await loadSdk();
  switch (data.type) {
    case 'test': {
      const r = await testConnection({ query, conn: data.conn, options: buildTestOptions({ ...data.base, conn: data.conn, secret: data.secret }) });
      post({ type: 'test-result', ...r });
      break;
    }
    case 'start': {
      session = createSession({
        query, pluginRoot: data.pluginRoot, cwd: data.cwd, onEvent: (event) => post({ type: 'event', event }),
        options: (canUseTool) => buildOptions({ ...data.base, conn: data.conn, secret: data.secret, cwd: data.cwd, pluginRoot: data.pluginRoot, shimsDir: data.shimsDir, shimEnv: data.shimEnv, canUseTool, resume: data.resume }),
      });
      session.start().then(() => post({ type: 'event', event: { kind: 'ended' } }), () => stopped('The agent could not start.'));
      break;
    }
    case 'send': if (session && !session.send(data.text)) post({ type: 'event', event: { kind: 'not-sent' } }); break;
    case 'stop': if (session) await session.interrupt(); break;
    case 'answer': if (session) session.answer(data.id, data.allow); break;
    case 'close': if (session) session.close(); break;
    default: break;
  }
}

port.on('message', async ({ data }) => {
  try {
    await handle(data);
  } catch {
    // Fixed words: an error from here can sit next to the options, secret included.
    if (data.type === 'test') post({ type: 'test-result', ok: false, error: 'The connection test could not run. Try again.' });
    else stopped('The agent stopped unexpectedly.');
  }
});
