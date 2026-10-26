'use strict';

// The two hook output shapes and the byte budget each of them gets (§5.2,
// §5.3). A hook's stdout is context the model pays for on every turn of the
// session, so the budget is part of the contract, not a safety net.
const BUDGETS = Object.freeze({ SessionStart: 4096, PreToolUse: 768 });

function byteLength(s) {
  return Buffer.byteLength(s, 'utf8');
}

// Cuts on a code point boundary, so a truncated string is never invalid UTF-8.
function truncateUtf8(value, maxBytes) {
  let out = '';
  let bytes = 0;
  for (const ch of value) {
    const b = byteLength(ch);
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out;
}

function projectedText(hookEventName, text) {
  const budget = BUDGETS[hookEventName] || 512;
  const value = String(text);
  if (byteLength(value) <= budget) return value;
  const note = `\n[placet-research: truncated to ${budget} bytes; run \`placet-research status\` for the full summary]`;
  return `${truncateUtf8(value, Math.max(0, budget - byteLength(note)))}${note}`;
}

// additionalContext is the only channel the model reads (§5.2).
function writeContext(hookEventName, text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext: projectedText(hookEventName, text) },
  }));
}

function writeDeny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: projectedText('PreToolUse', reason),
    },
  }));
}

module.exports = { BUDGETS, projectedText, writeContext, writeDeny };
