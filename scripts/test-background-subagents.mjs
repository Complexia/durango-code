// Background subagents (src/main/background-subagents.js): providers whose
// MCP calls time out (Antigravity) get spawn_subagent back once the subthread
// starts; wait_subagents collects reports within the time limit, and reports
// nobody collected are delivered to the driver thread after its turn.
//
//   node scripts/test-background-subagents.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createBackgroundSubagents,
  spawnsSubagentsInBackground,
  subagentReportsMessage,
  subagentStartedText,
  waitSubagentsText,
  waitSubagentsTimeoutMs,
  WAIT_SUBAGENTS_MAX_MS,
} from '../src/main/background-subagents.js';

assert.equal(spawnsSubagentsInBackground('antigravity'), true);
for (const provider of ['claude', 'codex', 'kimi', 'cursor', 'grok', 'opencode', 'muse', 'fx']) {
  assert.equal(spawnsSubagentsInBackground(provider), false, provider);
}

// Waits never outlast Antigravity's 3-minute call limit.
assert.equal(waitSubagentsTimeoutMs(undefined), WAIT_SUBAGENTS_MAX_MS);
assert.equal(waitSubagentsTimeoutMs(600), WAIT_SUBAGENTS_MAX_MS);
assert.equal(waitSubagentsTimeoutMs(10), 10_000);
assert.equal(waitSubagentsTimeoutMs(-1), WAIT_SUBAGENTS_MAX_MS);
assert.ok(WAIT_SUBAGENTS_MAX_MS < 180_000);

const uncollected = [];
const make = () => createBackgroundSubagents({ onUncollected: (entry) => uncollected.push(entry.spawnId) });
const start = (registry, spawnId, driverThreadId = 'driver', title = spawnId) =>
  registry.start(spawnId, { driverThreadId, childThreadId: `child-${spawnId}`, title, model: 'Opus 5.5', getSender: () => null });

{
  // The started text names the subthread and steers away from re-spawning.
  const text = subagentStartedText(start(make(), 'a', 'driver', 'Review'));
  assert.match(text, /"Review" \(Opus 5\.5\)/);
  assert.match(text, /child-a/);
  assert.match(text, /Do not spawn it again/);
  assert.match(text, /wait_subagents/);
}

{
  // Parallel reviews: one wait returns once all have finished, each report once.
  uncollected.length = 0;
  const registry = make();
  start(registry, 'opus');
  start(registry, 'sol');
  start(registry, 'other', 'someone-else');
  const waiting = registry.wait('driver', { timeoutMs: 5_000 });
  assert.equal(registry.finish('opus', { ok: true, result: 'opus report' }), true);
  // Not everything finished yet: the wait keeps going and nothing is collected,
  // so the report is announced as uncollected (the renderer only delivers it
  // once the driver's turn has ended, when it is still uncollected).
  assert.deepEqual(uncollected, ['opus']);
  registry.finish('sol', { ok: false, result: 'Subagent failed: boom' });
  const outcome = await waiting;
  assert.deepEqual(outcome.finished.map((entry) => entry.spawnId), ['opus', 'sol']);
  assert.deepEqual(outcome.running, []);
  // `sol` was collected by the wait as it finished: not announced.
  assert.deepEqual(uncollected, ['opus']);
  const text = waitSubagentsText(outcome);
  assert.match(text, /2 subagent reports/);
  assert.match(text, /opus report/);
  assert.match(text, /"sol" \(Opus 5\.5\) — failed/);
  // Collected reports are gone: no duplicate on the next wait or at turn end.
  assert.deepEqual(await registry.wait('driver', { timeoutMs: 10 }), { finished: [], running: [] });
  assert.deepEqual(registry.take('driver'), []);
  assert.match(waitSubagentsText({ finished: [], running: [] }), /already been delivered/);
  // Another driver's subagent was never touched.
  assert.equal(registry.has('other'), true);
}

{
  // A wait that times out returns what finished and lists what still runs.
  const registry = make();
  start(registry, 'fast');
  start(registry, 'slow', 'driver', 'Slow review');
  registry.finish('fast', { ok: true, result: 'fast report' });
  const outcome = await registry.wait('driver', { timeoutMs: 20 });
  assert.deepEqual(outcome.finished.map((entry) => entry.spawnId), ['fast']);
  assert.deepEqual(outcome.running.map((entry) => entry.spawnId), ['slow']);
  assert.match(waitSubagentsText(outcome), /Still running: "Slow review"/);
  assert.match(waitSubagentsText(outcome), /do not spawn them again/);
}

{
  // The driver's run ends mid-wait: nothing is collected for a reader that is
  // gone; the report is delivered after the turn instead.
  const registry = make();
  start(registry, 'a');
  start(registry, 'b');
  const controller = new AbortController();
  const waiting = registry.wait('driver', { timeoutMs: 5_000, signal: controller.signal });
  registry.finish('a', { ok: true, result: 'a report' });
  controller.abort();
  assert.deepEqual((await waiting).finished, []);
  registry.finish('b', { ok: true, result: 'b report' });
  const taken = registry.take('driver');
  assert.deepEqual(taken.map((entry) => entry.spawnId), ['a', 'b']);
  const message = subagentReportsMessage(taken);
  assert.match(message, /subagents have finished/);
  assert.match(message, /a report[\s\S]*b report/);
  assert.deepEqual(registry.take('driver'), []);
}

{
  // Stopped subagents are not announced or delivered: whoever stopped them knows.
  uncollected.length = 0;
  const registry = make();
  start(registry, 'stopped');
  registry.finish('stopped', { ok: false, stopped: true, result: 'Subagent failed: stopped by the user' });
  assert.deepEqual(uncollected, []);
  assert.deepEqual(registry.take('driver'), []);
  assert.equal(registry.has('stopped'), false);
  // A second report for the same spawn (later turns on the subthread) is ignored.
  assert.equal(registry.finish('stopped', { ok: true, result: 'late' }), false);
}

{
  // An unknown spawn is not this registry's.
  assert.equal(make().finish('nope', { ok: true, result: '' }), false);
}

// The bridge shim lists wait_subagents and the background spawn description
// only for providers run with --background-subagents, and forwards the call.
{
  const shimPath = fileURLToPath(new URL('../src/mcp-bridge-shim.cjs', import.meta.url));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-bg-subagents-'));
  const socketPath = path.join(root, 'bridge.sock');
  const calls = [];
  const bridge = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      const message = JSON.parse(chunk.toString().trim());
      calls.push(message);
      const reply = message.tool === '__tools' ? { id: message.id, ok: true, text: '', tools: [] } : { id: message.id, ok: true, text: `ran ${message.tool}` };
      socket.write(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise((resolve) => bridge.listen(socketPath, resolve));
  const runShim = async (flags, requests) => {
    const child = spawn(process.execPath, [shimPath, '--socket', socketPath, '--token', 'tok', ...flags], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const replies = new Map();
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        replies.get(message.id)?.(message);
      }
    });
    const results = [];
    for (const [index, [method, params]] of requests.entries()) {
      results.push(
        await new Promise((resolve) => {
          replies.set(index + 1, resolve);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: index + 1, method, params })}\n`);
        })
      );
    }
    child.kill();
    return results;
  };
  try {
    const [plain] = await runShim([], [['tools/list', {}]]);
    const plainNames = plain.result.tools.map((tool) => tool.name);
    assert.ok(!plainNames.includes('wait_subagents'));
    assert.match(plain.result.tools.find((tool) => tool.name === 'spawn_subagent').description, /Blocks until the subagent finishes/);

    const [list, waited] = await runShim(['--background-subagents'], [
      ['tools/list', {}],
      ['tools/call', { name: 'wait_subagents', arguments: { timeout_seconds: 30 } }],
    ]);
    const names = list.result.tools.map((tool) => tool.name);
    assert.deepEqual(names.slice(0, 3), ['spawn_subagent', 'wait_subagents', 'stop_subagent']);
    const spawnTool = list.result.tools.find((tool) => tool.name === 'spawn_subagent');
    assert.match(spawnTool.description, /Returns as soon as the subagent has started/);
    assert.doesNotMatch(spawnTool.description, /Blocks until/);
    assert.deepEqual(waited.result.content, [{ type: 'text', text: 'ran wait_subagents' }]);
    assert.deepEqual(calls.at(-1).args, { timeout_seconds: 30 });
  } finally {
    bridge.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

console.log('background subagents: ok');
