// Full access approves Claude Code's own shell safety-check asks and nothing
// else (claude-env.js fullAccessApproves). This drives the real Agent SDK and
// Claude Code runtimes against a local fake Messages API that answers with one
// Bash call, and checks fullAccessApproves on exactly what canUseTool gets:
// the safety-check ask is approved; asks a user's ask rule or a PreToolUse
// hook forced are not (they reach canUseTool with no matchedAskRule, and the
// rule's with no reason at all).
//
// Runtimes: the SDK's bundled one and, when installed, ~/.local/bin/claude
// (CLAUDE_SAFETY_ASKS_BINARIES=path1:path2 overrides the second). No network,
// no account: the runtime talks only to the fake API.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeSafetyCheckAsk, fullAccessApproves } from '../src/main/claude-env.js';

const fakeMessagesApi = (command) =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {}
        if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(req.url.includes('count_tokens') ? { input_tokens: 10 } : {}));
          return;
        }
        const last = body.messages?.[body.messages.length - 1];
        const answered = Array.isArray(last?.content) && last.content.some((block) => block.type === 'tool_result');
        const useTool = (body.tools ?? []).some((tool) => tool.name === 'Bash') && !answered;
        const id = `msg_${Math.random().toString(36).slice(2)}`;
        const block = useTool
          ? { type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2)}`, name: 'Bash', input: { command, description: 'Probe' } }
          : { type: 'text', text: 'Done.' };
        const stop = useTool ? 'tool_use' : 'end_turn';
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: [block], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        event('message_start', { message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
        if (block.type === 'text') {
          event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
          event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: block.text } });
        } else {
          event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
          event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        }
        event('content_block_stop', { index: 0 });
        event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
        event('message_stop', {});
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });

/** What canUseTool receives for one Bash call under Full access (bypassPermissions). */
const asksFor = async ({ binary, command, settings, hooks }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-safety-asks-'));
  try {
    const repo = path.join(root, 'repo');
    const other = path.join(root, 'other');
    for (const dir of [repo, other]) {
      fs.mkdirSync(dir);
      execFileSync('git', ['init', '-q'], { cwd: dir });
    }
    const config = path.join(root, 'config');
    fs.mkdirSync(config);
    let projectSettings = settings;
    if (typeof projectSettings === 'function') projectSettings = projectSettings(root);
    if (projectSettings) {
      fs.mkdirSync(path.join(repo, '.claude'));
      fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify(projectSettings));
    }
    const { server, url } = await fakeMessagesApi(command.replaceAll('<repo>', repo).replaceAll('<other>', other));
    const calls = [];
    try {
      const run = query({
        prompt: 'Run it.',
        options: {
          cwd: repo,
          model: 'claude-sonnet-4-5',
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: ['project'],
          ...(hooks ? { hooks } : {}),
          ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
          canUseTool: async (toolName, input, options) => {
            const { signal: _signal, ...rest } = options;
            calls.push({ toolName, options: rest });
            return { behavior: 'deny', message: 'The test denies every ask.' };
          },
          env: {
            ...process.env,
            ANTHROPIC_BASE_URL: url,
            // Any value: only the local fake API reads it.
            ANTHROPIC_API_KEY: 'placeholder',
            CLAUDE_CONFIG_DIR: config,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_AUTOUPDATER: '1',
          },
        },
      });
      const timeout = setTimeout(() => run.interrupt?.().catch(() => {}), 60_000);
      try {
        for await (const message of run) if (message.type === 'result') break;
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      server.close();
    }
    return calls;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const installed = () => {
  if (process.env.CLAUDE_SAFETY_ASKS_BINARIES) return process.env.CLAUDE_SAFETY_ASKS_BINARIES.split(':').filter(Boolean);
  try {
    return [fs.realpathSync(path.join(os.homedir(), '.local', 'bin', 'claude'))];
  } catch {
    return [];
  }
};
const runtimes = [null, ...installed()];

// The bot release thread's call (a zsh loop over git -C …): Claude Code 2.1.328+
// can't be sure how the shell reads it and asks even in bypassPermissions.
const UNCLEAR_SHELL = 'cd <other>; declare -A M=( [a]=f29e2e9c8eaea7ed75a76087dab9a21b03af8eb9 ); for w in ${(k)M}; do d=<repo>; git -C $d add -AN . 2>/dev/null; echo "$(git -C $d diff ${M[$w]} --stat | tail -1)"; done';
const askHook = { PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'A hook wants a person to confirm' } })] }] };
const settingsHook = (root) => {
  const script = path.join(root, 'ask-hook.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"A settings hook asks"}}'\n`, { mode: 0o755 });
  return { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: script }] }] } };
};

let safetyAsksSeen = 0;
for (const binary of runtimes) {
  const name = binary ? path.basename(binary) : 'bundled runtime';
  // A safety-check ask: approved under Full access, and only there.
  const safety = await asksFor({ binary, command: UNCLEAR_SHELL });
  for (const call of safety) {
    assert.equal(call.toolName, 'Bash', name);
    assert.equal(claudeSafetyCheckAsk(call.toolName, call.options), true, `${name}: an unrecognized safety ask: ${call.options.decisionReason}`);
    assert.equal(fullAccessApproves('full-access', call.toolName, call.options), true, name);
    assert.equal(fullAccessApproves('workspace-write', call.toolName, call.options), false, name);
    safetyAsksSeen += 1;
  }
  // A plain ask rule (permissions.ask: ["Bash"]): reaches canUseTool with no
  // reason and no matchedAskRule. Still the person's.
  for (const [label, settings, command] of [
    ['ask rule', { permissions: { ask: ['Bash'] } }, 'echo hello'],
    ['prefix ask rule', { permissions: { ask: ['Bash(echo:*)'] } }, 'echo hello'],
    ['ask rule on an unclear command', { permissions: { ask: ['Bash'] } }, UNCLEAR_SHELL],
  ]) {
    const calls = await asksFor({ binary, command, settings });
    assert.ok(calls.length > 0, `${name}: the ${label} should ask`);
    for (const call of calls) assert.equal(fullAccessApproves('full-access', call.toolName, call.options), false, `${name}: ${label} must stay with the person`);
  }
  // A PreToolUse hook asking for confirmation (SDK hook and settings command hook).
  for (const [label, options] of [
    ['SDK hook', { hooks: askHook }],
    ['settings hook', { settings: settingsHook }],
  ]) {
    const calls = await asksFor({ binary, command: 'echo hello', ...options });
    assert.ok(calls.length > 0, `${name}: the ${label} should ask`);
    for (const call of calls) {
      assert.ok(call.options.decisionReason, `${name}: a ${label} ask carries its reason`);
      assert.equal(fullAccessApproves('full-access', call.toolName, call.options), false, `${name}: ${label} must stay with the person`);
    }
  }
  console.log(`  ${name}: safety asks ${safety.length}, rule and hook asks kept`);
}
if (runtimes.length > 1) assert.ok(safetyAsksSeen > 0, 'no runtime sent the unclear-shell safety ask: update UNCLEAR_SHELL or the reason patterns');
else console.log('  (no installed Claude Code runtime: only the bundled one was checked)');

console.log('Claude safety ask tests passed');
