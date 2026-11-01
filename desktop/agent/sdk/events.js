'use strict';
// SDK messages → thread events for the panel. Pure apart from remembering
// each tool call's input until its result arrives.
const path = require('node:path');
const { findStatementTokens } = require('../statement-links');

const GUARD_REFUSAL = /^PreToolUse:(\w+) hook error: ([\s\S]*)$/;

function shown(file, cwd) {
  if (typeof file !== 'string') return '';
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}

function toolLine(name, input = {}, cwd) {
  switch (name) {
    case 'Read': return `Read ${shown(input.file_path, cwd)}`;
    case 'Edit': return `Edited ${shown(input.file_path, cwd)}`;
    case 'Write': return `Wrote ${shown(input.file_path, cwd)}`;
    case 'Bash': return `Ran ${String(input.command || '').split('\n')[0].slice(0, 120)}`;
    case 'Glob': return `Listed files matching “${input.pattern}”`;
    case 'Grep': return `Searched the project for “${input.pattern}”`;
    case 'WebFetch': return `Fetched ${input.url}`;
    case 'WebSearch': return `Searched the web for “${input.query}”`;
    case 'Skill': return `Used the skill ${input.skill}`;
    // C8: the binary lists the subagent tool as `Task`, the model calls it `Agent`.
    case 'Task':
    case 'Agent': return `Started a helper: ${input.description}`;
    default: return `Used ${name}`;
  }
}

function resultText(block) {
  if (typeof block.content === 'string') return block.content;
  return (block.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

function createMapper({ cwd }) {
  const inputs = new Map();
  return function map(msg) {
    const main = msg.parent_tool_use_id == null;
    if (msg.type === 'system' && msg.subtype === 'init') return [{ kind: 'session', sessionId: msg.session_id, model: msg.model }];
    if (msg.type === 'stream_event' && main && msg.event.type === 'content_block_delta' && msg.event.delta.type === 'text_delta') {
      return [{ kind: 'delta', text: msg.event.delta.text }];
    }
    if (msg.type === 'assistant') {
      if (msg.error && main) return [{ kind: 'error', code: msg.error }];
      const out = [];
      for (const b of msg.message.content || []) {
        if (b.type === 'tool_use') { inputs.set(b.id, { name: b.name, input: b.input }); out.push({ kind: 'tool', id: b.id, line: toolLine(b.name, b.input, cwd) }); }
        if (b.type === 'text' && main) out.push({ kind: 'text', text: b.text });
      }
      return out;
    }
    if (msg.type === 'user' && Array.isArray(msg.message && msg.message.content)) {
      const out = [];
      for (const b of msg.message.content) {
        if (b.type !== 'tool_result') continue;
        const m = GUARD_REFUSAL.exec(resultText(b));
        if (!m) continue;
        const call = inputs.get(b.tool_use_id) || { input: {} };
        const found = m[1] === 'Bash' ? findStatementTokens(call.input.command || '') : [];
        out.push({ kind: 'refusal', id: b.tool_use_id, tool: m[1], reason: m[2], statement: found.length ? found[0].num : null });
      }
      return out;
    }
    if (msg.type === 'result') {
      // C14: a result's `usage` counts its own turn, `total_cost_usd` is
      // cumulative over the query, so a per-turn cost is the difference of two.
      const u = msg.usage || {};
      const tokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      const out = [{ kind: 'usage', tokens, costUsd: msg.total_cost_usd || 0 }];
      if (msg.subtype !== 'success') out.push({ kind: 'error', code: msg.subtype });
      out.push({ kind: 'turn-end' });
      return out;
    }
    return [];
  };
}

module.exports = { createMapper, toolLine, GUARD_REFUSAL };
