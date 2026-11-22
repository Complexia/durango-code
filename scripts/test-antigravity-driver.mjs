// Antigravity (agy) provider checks. Unit checks always run; set
// AGY_LIVE=1 to also drive real `agy acp` turns (needs a signed-in agy on
// PATH; uses the cheapest Gemini model). Run through
// scripts/run-electron-test.mjs, which exits 0 even on failure: read the
// PASS/FAIL lines.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import {
  antigravityStatsFromPromptResult,
  antigravityToolLabel,
  createAntigravityAcpDriver,
} from '../src/main/antigravity-driver.js';
import { parseAntigravityModelsOutput } from '../src/main/models.js';
import { parseAntigravityLoginUrl, parseAntigravityModelRows } from '../src/main/provider-updates.js';
import { commandForModel } from '../src/main/command-for-model.js';
import { createProviderSignInWatch } from '../src/main/provider-sign-in-watch.js';
import { readAntigravityLimits } from '../src/main/provider-usage-limits.js';
import { antigravityVersionError } from '../src/main/antigravity-driver.js';
import { antigravityFailureFromErrorText } from '../src/main/antigravity-turn-outcome.js';
import { handleAntigravitySubagentLine } from '../src/main/antigravity-child-work.js';
import {
  antigravityWindowsFromQuotaSummary,
  codexLimitsFromRateLimitsRead,
  decodeGoKeyringValue,
  grokWindowsFromBilling,
} from '../src/main/provider-usage-limits.js';

let failures = 0;
// AGY_ONLY=<regex> runs only the matching checks.
const only = process.env.AGY_ONLY ? new RegExp(process.env.AGY_ONLY) : null;
const check = async (name, fn) => {
  if (only && !only.test(name)) return;
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n${error?.stack ?? error}`);
  }
};

await check('parses `agy models` output', () => {
  const models = parseAntigravityModelsOutput(
    'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n'
  );
  assert.deepEqual(
    models.map((model) => [model.id, model.label, model.command, model.providerId]),
    [
      ['antigravity:gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)', 'agy', 'antigravity'],
      ['antigravity:claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)', 'agy', 'antigravity'],
    ]
  );
  assert.equal(parseAntigravityModelsOutput('Error: authentication required').length, 0);
  assert.equal(parseAntigravityModelRows('Fetching available models...\na\tA\n').length, 1);
});

await check('per-turn usage from the prompt result', () => {
  assert.deepEqual(
    antigravityStatsFromPromptResult({
      stopReason: 'end_turn',
      usage: { inputTokens: 11095, outputTokens: 38, cachedReadTokens: 6911, thoughtTokens: 0, totalTokens: 18044 },
    }),
    { inputTokens: 11095, outputTokens: 38, cachedReadTokens: 6911, reasoningTokens: 0, totalTokens: 18044 }
  );
  assert.equal(antigravityStatsFromPromptResult({}), null);
});

await check('finds the Google sign-in link', () => {
  const url =
    'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=x&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=abc';
  assert.equal(parseAntigravityLoginUrl(`Open this link in a browser to log in with Google:\n\n  ${url}\n\nThen paste`), url);
  assert.equal(parseAntigravityLoginUrl(`partial ${url}`), null);
});

await check('command and labels', () => {
  assert.deepEqual(
    commandForModel(
      { providerId: 'antigravity', slug: 'gemini-3.8-flash-low' },
      { prompt: 'x', projectPath: '/tmp', accessMode: 'workspace-write', providerOptions: { extraArgs: '--add-dir /a' } }
    ),
    ['agy', 'acp', '--add-dir', '/a']
  );
  assert.deepEqual(
    commandForModel({ providerId: 'antigravity', slug: 'x' }, { prompt: 'x', projectPath: '/tmp', accessMode: 'full-access' }),
    ['agy', 'acp', '--dangerously-skip-permissions']
  );
  assert.equal(antigravityToolLabel('run_command'), 'Command');
  assert.equal(antigravityToolLabel('mcp_orion_read_thread'), 'orion · read thread');
});

await check('version gate', () => {
  assert.match(antigravityVersionError('1.4.9'), /needs 1\.5 or newer/);
  assert.equal(antigravityVersionError('1.5.0'), null);
  assert.equal(antigravityVersionError('1.5.14'), null);
  assert.equal(antigravityVersionError('2.0.0'), null);
  assert.equal(antigravityVersionError(undefined), null);
});

await check('classifies error steps', () => {
  const quota = antigravityFailureFromErrorText('RESOURCE_EXHAUSTED (code 429): out of quota reason:QUOTA_EXHAUSTED quotaResetDelay:1h30m ]', { now: 0 });
  assert.match(quota.message, /quota for this period/);
  assert.equal(antigravityFailureFromErrorText('', { stopReason: 'refusal' }).brokenSession, false);
  const broken = antigravityFailureFromErrorText('messages.3.content.0.thinking.signature: Field required');
  assert.equal(broken.brokenSession, true);
  assert.match(antigravityFailureFromErrorText('NOT_FOUND (code 404): model not found\u0012').message, /can't use this model: model not found/);
  assert.match(antigravityFailureFromErrorText('Error 503, Message: backend down, Status: UNAVAILABLE').message, /backend down \(UNAVAILABLE, HTTP 503\)/);
  assert.equal(antigravityFailureFromErrorText(''), null);
});

await check('limits parsing', () => {
  const windows = antigravityWindowsFromQuotaSummary({
    groups: [
      { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.75, resetTime: '2026-11-28T11:47:35Z' }] },
      { displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 1 }, { bucketId: 'x', disabled: true, remainingFraction: 0 }] },
    ],
  });
  assert.deepEqual(windows.map((w) => [w.id, w.label, w.usedPercent, w.windowMinutes]), [
    ['3p-5h', 'Claude and GPT models · 5-hour', 0, 300],
    ['gemini-weekly', 'Gemini Models · Weekly', 25, 10080],
  ]);
  assert.deepEqual(grokWindowsFromBilling({ config: { creditUsagePercent: 1, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-11-22T06:57:08Z', end: '2026-11-29T06:57:08Z' } } })[0].label, 'Weekly');
  assert.equal(decodeGoKeyringValue(`go-keyring-base64:${Buffer.from('{"a":1}').toString('base64')}`), '{"a":1}');
  const codex = codexLimitsFromRateLimitsRead({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 5 }, planType: 'plus' } });
  assert.deepEqual(codex.value.primary, { used_percent: 1, window_minutes: 10080, resets_at: 5 });
});

await check('subagent transcript lines', () => {
  const events = [];
  const api = { prompt: (p) => events.push(['prompt', p]), text: (t) => events.push(['text', t]), activity: (a) => events.push(['activity', a.key ?? a.updateForKey, a.status, a.title ?? a.output]), stats: () => {}, metadata: () => {} };
  const ctx = {};
  handleAntigravitySubagentLine({ step_index: 0, type: 'SYSTEM_MESSAGE', content: '<SYSTEM_MESSAGE>\n[Message] sender=x content=Run ls\n</SYSTEM_MESSAGE>' }, api, ctx);
  handleAntigravitySubagentLine({ step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"ls -la"' } }] }, api, ctx);
  handleAntigravitySubagentLine({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'total 0' }, api, ctx);
  handleAntigravitySubagentLine({ step_index: 3, type: 'PLANNER_RESPONSE', content: 'Done.' }, api, ctx);
  assert.deepEqual(events, [
    ['prompt', 'Run ls'],
    ['activity', 'step-1-0', 'running', 'Command - ls -la'],
    ['activity', 'step-1-0', 'done', 'total 0'],
    ['text', 'Done.'],
  ]);
});

await check('sign-in watch reports only providers whose files changed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-signin-'));
  const token = path.join(dir, 'antigravity-oauth-token');
  const other = path.join(dir, 'auth.json');
  fs.writeFileSync(token, 'a');
  fs.writeFileSync(other, 'b');
  const seen = [];
  const watch = createProviderSignInWatch({
    files: () => ({ antigravity: [token], grok: [other], codex: [path.join(dir, 'missing.json')] }),
    onChange: (ids) => seen.push(ids),
    minIntervalMs: 0,
  });
  assert.deepEqual(await watch.check(), [], 'the first check only records the baseline');
  assert.deepEqual(await watch.check(), []);
  fs.writeFileSync(token, 'signed in as someone else');
  assert.deepEqual(await watch.check(), ['antigravity']);
  fs.rmSync(other);
  assert.deepEqual(await watch.check(), ['grok'], 'signing out counts too');
  assert.deepEqual(seen, [['antigravity'], ['grok']]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- deterministic driver checks against a scripted fake agent ---------------
// `respond(method, params)` returns a result (or a promise of one); requests
// the driver answers (permissions, elicitations) are collected in `answers`.
const fakeWorkspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fake-ws-')));
const fakeAgent = ({ respond, accessMode = 'full-access', promptText = 'hi', mcpServers = [], onUserInput }) => {
  const sent = [];
  const answers = [];
  const events = { text: '', turnEnds: [], fatal: null, done: [], spawned: [], activities: new Map() };
  let driver;
  const child = {
    stdin: {
      write: (line) => {
        const message = JSON.parse(line);
        sent.push(message);
        if (message.method && message.id !== undefined) {
          Promise.resolve(respond(message.method, message.params)).then((result) => {
            if (result !== undefined) driver.handleMessage({ jsonrpc: '2.0', id: message.id, ...(result?.error ? { error: result.error } : { result }) });
          });
        } else if (!message.method) {
          answers.push(message);
        }
        return true;
      },
    },
  };
  driver = createAntigravityAcpDriver({
    child,
    cwd: fakeWorkspace,
    model: { providerId: 'antigravity', slug: 'gemini-3.8-flash-low' },
    promptText,
    accessMode,
    mcpServers,
    threadId: 'thread-1',
    callbacks: {
      onSessionId: () => {},
      onReasoning: () => {},
      onText: (text) => {
        events.text += text;
      },
      onActivity: (activity) => events.activities.set(activity.key, activity),
      onTurnEnd: (result) => events.turnEnds.push(result),
      onFatal: (message) => {
        events.fatal = message;
      },
      onSubagentSpawn: (meta) => events.spawned.push(meta),
      onSubagentDone: (id, info) => events.done.push([id, info]),
      ...(onUserInput ? { onUserInput: () => onUserInput(driver) } : {}),
    },
  });
  const notify = (update) => driver.handleMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update } });
  const ask = (id, method, params) => driver.handleMessage({ jsonrpc: '2.0', id, method, params });
  return { driver, sent, answers, events, notify, ask };
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const baseRespond = (prompts) => (method) => {
  if (method === 'initialize') return { agentInfo: { name: 'Antigravity ACP Server', version: '1.5.14' }, agentCapabilities: {} };
  if (method === 'session/new') return { sessionId: 'sess-1' };
  if (method === 'session/set_model' || method === 'session/set_mode') return {};
  if (method === 'session/prompt') return prompts.shift()?.promise ?? { stopReason: 'end_turn' };
  return {};
};
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const permissionAnswer = async (agent, id, toolCall) => {
  agent.ask(id, 'session/request_permission', {
    toolCall,
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  });
  await tick();
  return agent.answers.find((answer) => answer.id === id)?.result?.outcome?.optionId;
};

await check('fake: permission policy by access mode', async () => {
  const prompt = deferred();
  const ws = fakeAgent({ respond: baseRespond([prompt]), accessMode: 'workspace-write' });
  void ws.driver.start();
  await tick(20);
  assert.equal(await permissionAnswer(ws, 'p1', { toolCallId: 'c1', name: 'write_file', kind: 'edit', locations: [{ path: path.join(fakeWorkspace, 'a.txt') }] }), 'allow');
  assert.equal(await permissionAnswer(ws, 'p2', { toolCallId: 'c2', name: 'write_file', kind: 'edit', locations: [{ path: '/etc/x' }] }), 'deny');
  assert.equal(await permissionAnswer(ws, 'p3', { toolCallId: 'c3', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'ls' } }), 'deny');
  assert.equal(await permissionAnswer(ws, 'p4', { toolCallId: 'c4', name: 'mcp_orion_read_thread', kind: 'other' }), 'allow');
  const ro = fakeAgent({ respond: baseRespond([deferred()]), accessMode: 'read-only' });
  void ro.driver.start();
  await tick(20);
  assert.equal(await permissionAnswer(ro, 'p5', { toolCallId: 'c5', name: 'write_file', kind: 'edit', locations: [{ path: path.join(fakeWorkspace, 'a.txt') }] }), 'deny');
  assert.equal(await permissionAnswer(ro, 'p6', { toolCallId: 'c6', name: 'view_file', kind: 'read' }), 'allow');
  const spoof = fakeAgent({ respond: baseRespond([deferred()]), accessMode: 'read-only', mcpServers: [{ name: 'orion_tools', command: 'x', args: [], env: [] }] });
  void spoof.driver.start();
  await tick(20);
  assert.equal(await permissionAnswer(spoof, 'p7', { toolCallId: 'c7', name: 'mcp_orion_tools_read_thread', kind: 'other' }), 'deny');
});

await check('fake: elicitation question maps labels and free text', async () => {
  const prompt = deferred();
  const agent = fakeAgent({
    respond: baseRespond([prompt]),
    onUserInput: (driver) => {
      for (const request of driver.getUserInputs()) driver.answerUserInput(request.requestId, { q1: ['Green', 'teal, actually'] });
    },
  });
  void agent.driver.start();
  await tick(20);
  agent.ask('e1', 'elicitation/create', {
    mode: 'form',
    message: 'The agent has a question.',
    requestedSchema: {
      type: 'object',
      properties: {
        q1: { type: 'string', title: 'Which color?', oneOf: [{ const: '1', title: 'Red' }, { const: '2', title: 'Green' }] },
        q1_other: { type: 'string', title: 'Other' },
      },
    },
  });
  await tick();
  assert.deepEqual(agent.answers.find((answer) => answer.id === 'e1')?.result, {
    action: 'accept',
    content: { q1: '2', q1_other: 'teal, actually' },
  });
});

await check('fake: a steer supersedes the running prompt; only the newest ends the turn', async () => {
  const first = deferred();
  const second = deferred();
  const agent = fakeAgent({ respond: baseRespond([first, second]) });
  void agent.driver.start();
  await tick(20);
  const steering = agent.driver.steer('also BANANA');
  await tick(20);
  first.resolve({ stopReason: 'end_turn' });
  assert.equal(await steering, true);
  await tick(20);
  assert.equal(agent.events.turnEnds.length, 0, 'the superseded prompt does not end the turn');
  agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'BANANA' } });
  second.resolve({ stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2 } });
  await tick(50);
  assert.equal(agent.events.turnEnds.length, 1);
  assert.equal(agent.events.turnEnds[0].usage.inputTokens, 5);
  assert.equal(agent.sent.filter((message) => message.method === 'session/prompt').length, 2);
});

await check('fake: /goal marker split across chunks is hidden', async () => {
  const prompt = deferred();
  const agent = fakeAgent({ respond: baseRespond([prompt]), promptText: '/goal make it' });
  void agent.driver.start();
  await tick(20);
  for (const text of ['Done.', '\n<!--', ' GOAL_COMP', 'LETE -->']) agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  prompt.resolve({ stopReason: 'end_turn' });
  await tick(4500);
  assert.equal(agent.events.text, 'Done.');
  assert.equal(agent.events.turnEnds.length, 1);
});

await check('fake: a failed subagent launch does not hold the turn open', async () => {
  const prompt = deferred();
  const agent = fakeAgent({ respond: baseRespond([prompt]) });
  void agent.driver.start();
  await tick(20);
  agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'sub-1', name: 'invoke_subagent', kind: 'other', status: 'in_progress', rawInput: { Role: 'Helper', Prompt: 'do it' } });
  agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'sub-1', name: 'invoke_subagent', status: 'failed' });
  prompt.resolve({ stopReason: 'end_turn' });
  await tick(5500);
  assert.deepEqual(agent.events.done, [['sub-1', { status: 'error' }]]);
  assert.equal(agent.events.turnEnds.length, 1);
});

await check('fake: a backgrounded command keeps the turn open until the woken reply ends', async () => {
  // agy's on-disk session under a throwaway HOME (antigravityBrainDir reads it per call).
  const realHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fake-home-'));
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const generatedDir = path.join(home, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated');
  fs.mkdirSync(path.join(generatedDir, 'logs'), { recursive: true });
  const transcript = path.join(generatedDir, 'logs', 'transcript.jsonl');
  const step = (entry) => fs.appendFileSync(transcript, `${JSON.stringify(entry)}\n`);
  process.env.HOME = home;
  try {
    const prompt = deferred();
    const respond = baseRespond([prompt]);
    const agent = fakeAgent({ respond: (method, params) => (method === 'session/new' ? { sessionId } : respond(method, params)) });
    void agent.driver.start();
    await tick(20);
    const command = { toolCallId: 'cmd-1', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'durango-code ws new x', WaitMsBeforeAsync: 10000 } };
    agent.notify({ sessionUpdate: 'tool_call', ...command, status: 'in_progress' });
    step({ step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: {} }] });
    step({ step_index: 2, type: 'GENERIC', status: 'RUNNING', content: 'Tool is running as a background task with task id: x/task-2' });
    step({ step_index: 3, type: 'PLANNER_RESPONSE', content: "I'll continue once it finishes." });
    agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "I'll continue once it finishes." } });
    prompt.resolve({ stopReason: 'end_turn' });
    await tick(4000);
    assert.equal(agent.events.turnEnds.length, 0, 'waits while the background command runs');

    // The command finishes; agy delivers the notice and the model thinks silently.
    agent.notify({ sessionUpdate: 'tool_call_update', ...command, status: 'completed', rawOutput: { output: 'ready', exit_code: 0 } });
    step({ step_index: 4, type: 'SYSTEM_MESSAGE', content: 'Task finished' });
    await tick(4500);
    assert.equal(agent.events.turnEnds.length, 0, 'waits for the woken reply past the quiet period');

    // Its reply runs a tool, then is silent again before the next model step.
    agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'edit-1', name: 'write_file', kind: 'edit', status: 'in_progress' });
    agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', name: 'write_file', kind: 'edit', status: 'completed' });
    agent.notify({ sessionUpdate: 'usage_update', used: 1, size: 2 });
    step({ step_index: 5, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'write_file', args: {} }] });
    step({ step_index: 6, type: 'GENERIC', status: 'DONE', content: 'edited' });
    await tick(4500);
    assert.equal(agent.events.turnEnds.length, 0, 'waits between the steps of the woken reply');

    agent.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Edits done.' } });
    agent.notify({ sessionUpdate: 'usage_update', used: 2, size: 2 });
    step({ step_index: 7, type: 'PLANNER_RESPONSE', content: 'Edits done.' });
    await tick(4500);
    assert.equal(agent.events.turnEnds.length, 1, 'ends once the reply has finished');
    assert.match(agent.events.text, /Edits done\.$/);
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check('fake: a finished background command with no reply ends the turn', async () => {
  const prompt = deferred();
  const agent = fakeAgent({ respond: baseRespond([prompt]) });
  void agent.driver.start();
  await tick(20);
  const command = { toolCallId: 'cmd-1', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'sleep 1' } };
  agent.notify({ sessionUpdate: 'tool_call', ...command, status: 'in_progress' });
  prompt.resolve({ stopReason: 'end_turn' });
  await tick(1500);
  agent.notify({ sessionUpdate: 'tool_call_update', ...command, status: 'completed' });
  await tick(4500);
  assert.equal(agent.events.turnEnds.length, 1);
});

await check('fake: dispose stops a pending settle wait', async () => {
  const prompt = deferred();
  const agent = fakeAgent({ respond: baseRespond([prompt]), promptText: '/goal x' });
  void agent.driver.start();
  await tick(20);
  prompt.resolve({ stopReason: 'end_turn' });
  await tick(20);
  agent.driver.dispose();
  await tick(4500);
  assert.equal(agent.events.turnEnds.length, 0);
  assert.equal(agent.events.fatal, null);
});

// Drives one real turn and records what the driver reported.
const runTurn = ({ cwd, accessMode, promptText, resumeSessionId = null, answer = null, steerAfterMs = null, steerText = '' }) =>
  new Promise((resolve) => {
    const args = ['acp', ...(accessMode === 'full-access' ? ['--dangerously-skip-permissions'] : [])];
    const child = spawn('agy', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const seen = { text: '', activities: new Map(), sessionId: null, fatal: null, result: null, resumeFallback: false, questions: [], spawned: [], done: [], steered: null, turnEnds: 0 };
    const done = () => {
      try {
        child.kill();
      } catch {}
      resolve(seen);
    };
    const timer = setTimeout(() => {
      seen.fatal = seen.fatal ?? 'timeout';
      done();
    }, 180000);
    const driver = createAntigravityAcpDriver({
      child,
      cwd,
      model: { providerId: 'antigravity', slug: 'gemini-3.8-flash-low' },
      promptText,
      resumeSessionId,
      accessMode,
      threadId: 'test-thread',
      callbacks: {
        onSessionId: (id) => {
          seen.sessionId = id;
          if (steerAfterMs !== null) {
            setTimeout(async () => {
              seen.steered = await driver.steer(steerText);
            }, steerAfterMs);
          }
        },
        ...(answer
          ? {
              onUserInput: () => {
                for (const request of driver.getUserInputs()) {
                  seen.questions.push(request);
                  driver.answerUserInput(request.requestId, answer(request));
                }
              },
            }
          : {}),
        onSubagentSpawn: (meta) => seen.spawned.push(meta),
        onSubagentDone: (id, info) => seen.done.push([id, info]),
        onReasoning: () => {},
        onText: (text) => {
          seen.text += text;
        },
        onActivity: (activity) => seen.activities.set(activity.key, activity),
        onResumeFallback: () => {
          seen.resumeFallback = true;
        },
        onTurnEnd: (result) => {
          seen.turnEnds += 1;
          seen.result = result;
          clearTimeout(timer);
          done();
        },
        onFatal: (message) => {
          seen.fatal = message;
          clearTimeout(timer);
          done();
        },
      },
    });
    let buffer = '';
    child.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          driver.handleMessage(JSON.parse(line));
        } catch {}
      }
    });
    child.stderr.resume();
    driver.start();
  });

if (process.env.AGY_LIVE === '1') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-driver-')));
  const workspace = path.join(root, 'ws');
  const outside = path.join(root, 'outside.txt');
  fs.mkdirSync(workspace);
  let sessionId = null;

  await check('live: Antigravity limits read the current sign-in', async () => {
    const limits = await readAntigravityLimits();
    assert.equal(limits.status, 'ok', limits.detail);
    assert.ok(limits.windows.length > 0);
  });

  await check('live: workspace write allows edits inside, denies commands and outside writes', async () => {
    const seen = await runTurn({
      cwd: workspace,
      accessMode: 'workspace-write',
      promptText: `Do exactly these three steps, each with a tool call, even if one fails: 1) create the file ${path.join(workspace, 'inside.txt')} containing "hi"; 2) create the file ${outside} containing "no"; 3) run the shell command \`echo ran\`. Then say DONE.`,
    });
    sessionId = seen.sessionId;
    const activities = [...seen.activities.values()];
    console.log(activities.map((a) => `  ${a.status} ${a.title}${a.output ? ` :: ${String(a.output).slice(0, 90).replace(/\n/g, ' ')}` : ''}`).join('\n'));
    assert.equal(seen.fatal, null);
    assert.ok(seen.result?.usage, 'usage reported');
    assert.ok(fs.existsSync(path.join(workspace, 'inside.txt')), 'inside write allowed');
    assert.ok(!fs.existsSync(outside), 'outside write denied');
    // Denied, or cancelled by agy itself after the outside write was denied:
    // either way the command must not have run.
    assert.ok(
      !activities.some((a) => a.type === 'command' && a.status === 'done'),
      'command did not run'
    );
  });

  await check('live: read only denies writes', async () => {
    const seen = await runTurn({
      cwd: workspace,
      accessMode: 'read-only',
      promptText: `Create the file ${path.join(workspace, 'ro.txt')} containing "x" using a tool, then say DONE.`,
    });
    assert.equal(seen.fatal, null);
    assert.ok(!fs.existsSync(path.join(workspace, 'ro.txt')), 'read-only write denied');
  });

  await check('live: resume keeps the conversation', async () => {
    assert.ok(sessionId, 'first turn reported a session id');
    const seen = await runTurn({
      cwd: workspace,
      accessMode: 'full-access',
      resumeSessionId: sessionId,
      promptText: 'What was the name of the first file I asked you to create? Answer with just the file name.',
    });
    assert.equal(seen.fatal, null);
    assert.equal(seen.resumeFallback, false);
    assert.equal(seen.sessionId, sessionId);
    assert.match(seen.text, /inside\.txt/);
  });

  await check('live: steering folds a second message into the running turn', async () => {
    const seen = await runTurn({
      cwd: workspace,
      accessMode: 'full-access',
      promptText: 'Run the shell command `sleep 3` three times, one at a time, then summarize in one sentence.',
      steerAfterMs: 2500,
      steerText: 'Also end your reply with the word BANANA.',
    });
    assert.equal(seen.fatal, null);
    assert.equal(seen.steered, true);
    assert.equal(seen.turnEnds, 1);
    assert.match(seen.text, /BANANA/);
  });

  await check('live: native question is answered from the card', async () => {
    const seen = await runTurn({
      cwd: workspace,
      accessMode: 'full-access',
      promptText: `Before doing anything, ask me which color I prefer (red, green or blue) using your question tool. Then write my answer to ${path.join(workspace, 'color.txt')}.`,
      answer: (request) => ({ [request.questions[0].id]: [request.questions[0].options.find((o) => /green/i.test(o.label)).label] }),
    });
    assert.equal(seen.fatal, null);
    assert.ok(seen.questions.length >= 1, 'a question card was raised');
    assert.match(fs.readFileSync(path.join(workspace, 'color.txt'), 'utf8'), /green/i);
  });

  await check('live: subagent keeps the turn open until it reports', async () => {
    const seen = await runTurn({
      cwd: workspace,
      accessMode: 'full-access',
      promptText: 'Use a subagent to run the shell command `echo child-ran` and report its exact output to me.',
    });
    assert.equal(seen.fatal, null);
    assert.ok(seen.spawned.length >= 1, 'subagent spawn reported');
    assert.ok(seen.done.some(([, info]) => info.status === 'done'), 'subagent finished');
    assert.match(seen.text, /child-ran/);
  });

  await check('live: the turn stays open for the reply to a background command', async () => {
    const seen = await runTurn({
      cwd: workspace,
      accessMode: 'full-access',
      promptText:
        'Run exactly this shell command with run_command and WaitMsBeforeAsync set to 2000: `sleep 15 && echo BG_DONE`. It will move to the background. Do not wait for it or poll it: end your turn right away by saying "waiting for the task". When you later learn it finished, reply with the single word FINISHED.',
    });
    assert.equal(seen.fatal, null);
    assert.equal(seen.turnEnds, 1);
    assert.match(seen.text, /FINISHED/);
  });

  await check('live: /goal runs natively', async () => {
    const seen = await runTurn({
      cwd: workspace,
      accessMode: 'full-access',
      promptText: `/goal create the file ${path.join(workspace, 'goal.txt')} containing the word done`,
    });
    assert.equal(seen.fatal, null);
    assert.match(fs.readFileSync(path.join(workspace, 'goal.txt'), 'utf8'), /done/);
    assert.doesNotMatch(seen.text, /GOAL_COMPLETE/);
  });

  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `FAILED ${failures}` : 'ALL PASSED');
app.exit(failures ? 1 : 0);
