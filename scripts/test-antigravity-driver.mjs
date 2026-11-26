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
import { createAntigravitySessionManager } from '../src/main/antigravity-session-manager.js';
import { EventEmitter } from 'node:events';
import {
  antigravityWireModelId,
  groupAntigravityModelRows,
  parseAntigravityModelsOutput,
} from '../src/main/models.js';
import {
  buildAntigravityModelsFromAcpProbe,
  probeAntigravityModelsOverAcp,
} from '../src/main/antigravity-models-probe.js';
import {
  antigravityCliHome,
  sweepOrphanAntigravityTempSessions,
} from '../src/main/antigravity-session-files.js';
import { parseAntigravityLoginUrl, parseAntigravityModelRows } from '../src/main/provider-updates.js';
import { commandForModel } from '../src/main/command-for-model.js';
import { createProviderSignInWatch } from '../src/main/provider-sign-in-watch.js';
import { antigravityVersionError } from '../src/main/antigravity-driver.js';
import { antigravityFailureFromErrorText } from '../src/main/antigravity-turn-outcome.js';
import { handleAntigravitySubagentLine } from '../src/main/antigravity-child-work.js';
import { codexLimitsFromRateLimitsRead, grokWindowsFromBilling } from '../src/main/provider-usage-limits.js';

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

await check('parses and groups `agy models` output by reasoning effort', () => {
  const models = parseAntigravityModelsOutput(
    [
      'Fetching available models...',
      'gemini-4-neon-high\tGemini 4 Neon (High)',
      'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
      'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
      'gemini-4-neon-low\tGemini 4 Neon (Low)',
      'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
      'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
      'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
      'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
      'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
      'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    ].join('\n')
  );
  assert.deepEqual(
    models.map((model) => [
      model.id,
      model.label,
      model.reasoningEfforts ?? null,
      model.defaultReasoningEffort ?? null,
      model.command,
      model.providerId,
    ]),
    [
      ['antigravity:gemini-4-neon', 'Gemini 4 Neon', ['low', 'medium', 'high', 'xhigh'], 'high', 'agy', 'antigravity'],
      ['antigravity:gemini-pro-orchestrator-neon', 'Orchestrator (Neon)', null, null, 'agy', 'antigravity'],
      ['antigravity:gemini-3.8-flash', 'Gemini 3.8 Flash', ['low', 'medium', 'high'], 'high', 'agy', 'antigravity'],
      ['antigravity:claude-opus-5-5', 'Claude Opus 5.5', ['low', 'medium', 'high'], 'high', 'agy', 'antigravity'],
      ['antigravity:claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)', null, null, 'agy', 'antigravity'],
      ['antigravity:gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)', null, null, 'agy', 'antigravity'],
    ]
  );
  assert.equal(antigravityWireModelId(models[0], 'xhigh'), 'gemini-4-neon-xhigh');
  assert.equal(antigravityWireModelId(models[0], undefined), 'gemini-4-neon-high');
  assert.equal(antigravityWireModelId(models[2], 'xhigh'), 'gemini-3.8-flash-high');
  assert.equal(antigravityWireModelId(models[1], 'xhigh'), 'gemini-pro-orchestrator-neon');
  assert.equal(antigravityWireModelId(models[5], 'high'), 'gpt-oss-120b-medium');
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
  assert.deepEqual(grokWindowsFromBilling({ config: { creditUsagePercent: 1, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-11-22T06:57:08Z', end: '2026-11-29T06:57:08Z' } } })[0].label, 'Weekly');
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
const fakeAgent = ({
  respond,
  accessMode = 'full-access',
  promptText = 'hi',
  systemPromptAppend = '',
  attachments = [],
  resumeSessionId = null,
  mcpServers = [],
  httpMcpServers = [],
  sessionState = null,
  nextRequestId = null,
  handshakeTimeoutMs,
  promptInactivityTimeoutMs,
  postSettleCommandHoldMs,
  maxTransientRetries,
  transientRetryDelayMs,
  onUserInput,
  model = { providerId: 'antigravity', slug: 'gemini-3.8-flash-low' },
  reasoningEffort,
}) => {
  const sent = [];
  const answers = [];
  const events = { text: '', turnEnds: [], fatal: null, fatalMeta: null, done: [], spawned: [], slashCommands: [], activities: new Map() };
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
    model,
    reasoningEffort,
    promptText,
    systemPromptAppend,
    attachments,
    resumeSessionId,
    accessMode,
    mcpServers,
    httpMcpServers,
    sessionState,
    nextRequestId,
    ...(handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs } : {}),
    ...(promptInactivityTimeoutMs !== undefined ? { promptInactivityTimeoutMs } : {}),
    ...(postSettleCommandHoldMs !== undefined ? { postSettleCommandHoldMs } : {}),
    ...(maxTransientRetries !== undefined ? { maxTransientRetries } : {}),
    ...(transientRetryDelayMs !== undefined ? { transientRetryDelayMs } : {}),
    threadId: 'thread-1',
    callbacks: {
      onSessionId: () => {},
      onReasoning: () => {},
      onText: (text) => {
        events.text += text;
      },
      onActivity: (activity) => events.activities.set(activity.key, activity),
      onTurnEnd: (result) => events.turnEnds.push(result),
      onFatal: (message, meta) => {
        events.fatal = message;
        events.fatalMeta = meta ?? null;
      },
      onSubagentSpawn: (meta) => events.spawned.push(meta),
      onSubagentDone: (id, info) => events.done.push([id, info]),
      onSlashCommands: (commands) => events.slashCommands.push(commands),
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

// agy's session database (conversations/<id>.db) under a throwaway HOME.
const withAgyHome = async (fn) => {
  const realHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fake-home-'));
  const { DatabaseSync } = await import('node:sqlite');
  const databases = [];
  const conversation = (id) => {
    const dir = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
    fs.mkdirSync(dir, { recursive: true });
    const database = new DatabaseSync(path.join(dir, `${id}.db`));
    database.exec('CREATE TABLE IF NOT EXISTS steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, step_payload blob)');
    databases.push(database);
    return {
      step: (idx, status, type = 132) =>
        database.prepare('INSERT OR REPLACE INTO steps (idx, step_type, status) VALUES (?, ?, ?)').run(idx, type, status),
    };
  };
  process.env.HOME = home;
  try {
    await fn({ home, conversation });
  } finally {
    process.env.HOME = realHome;
    for (const database of databases) database.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
};

await check("fake: a background command holds the turn for as long as agy's step runs, with no idle limit", async () => {
  await withAgyHome(async ({ conversation }) => {
    const sessionId = '21111111-2222-4333-8444-555555555555';
    const session = conversation(sessionId);
    // A step an earlier, killed run left RUNNING doesn't hold this turn.
    session.step(0, 2);
    const prompt = deferred();
    const respond = baseRespond([prompt]);
    const agent = fakeAgent({ respond: (method, params) => (method === 'session/new' ? { sessionId } : respond(method, params)) });
    void agent.driver.start();
    await tick(20);
    const command = { toolCallId: 'cmd-1', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'bun run deploy' } };
    agent.notify({ sessionUpdate: 'tool_call', ...command, status: 'in_progress' });
    session.step(1, 3, 15);
    session.step(2, 2);
    session.step(3, 3, 15);
    prompt.resolve({ stopReason: 'end_turn' });
    await tick(4500);
    assert.equal(agent.events.turnEnds.length, 0, 'waits while the command step runs');

    // ACP says done (or its update was lost) while agy's own step still runs.
    agent.notify({ sessionUpdate: 'tool_call_update', ...command, status: 'completed' });
    await tick(4500);
    assert.equal(agent.events.turnEnds.length, 0, "agy's step, not the ACP view, decides");

    session.step(2, 3);
    await tick(4500);
    assert.equal(agent.events.turnEnds.length, 1, 'ends once the step is done and all is quiet');
    assert.doesNotMatch(agent.events.text, /Stopped waiting/);
  });
});

await check('fake: a command the ACP view missed still holds the turn', async () => {
  await withAgyHome(async ({ conversation }) => {
    const sessionId = '31111111-2222-4333-8444-555555555555';
    const session = conversation(sessionId);
    const prompt = deferred();
    const respond = baseRespond([prompt]);
    const agent = fakeAgent({ respond: (method, params) => (method === 'session/new' ? { sessionId } : respond(method, params)) });
    void agent.driver.start();
    await tick(20);
    session.step(0, 3, 15);
    session.step(1, 2);
    prompt.resolve({ stopReason: 'end_turn' });
    await tick(4500);
    assert.equal(agent.events.turnEnds.length, 0);
    session.step(1, 6); // CANCELED
    await tick(4500);
    assert.equal(agent.events.turnEnds.length, 1);
  });
});

await check('fake: a subagent waiting on an approval is reported stalled; other work is not cut short', async () => {
  await withAgyHome(async ({ home, conversation }) => {
    const sessionId = '41111111-2222-4333-8444-555555555555';
    const childId = '51111111-2222-4333-8444-555555555555';
    const brain = (id, ...parts) => path.join(home, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', ...parts);
    fs.mkdirSync(brain(sessionId, 'subagents'), { recursive: true });
    fs.mkdirSync(brain(childId, 'messages'), { recursive: true });
    fs.writeFileSync(brain(sessionId, 'subagents', `${childId}.json`), JSON.stringify({ conversationId: childId, state: 'SUBAGENT_STATE_ALIVE' }));
    fs.writeFileSync(
      brain(childId, 'messages', 'launch.json'),
      JSON.stringify({ id: 'launch', sender: sessionId, sourceMetadata: { tool: { toolCall: { id: 'sub-1' } } } })
    );
    const session = conversation(sessionId);
    const child = conversation(childId);
    const prompt = deferred();
    const respond = baseRespond([prompt]);
    const agent = fakeAgent({
      respond: (method, params) => (method === 'session/new' ? { sessionId } : respond(method, params)),
      accessMode: 'workspace-write',
    });
    void agent.driver.start();
    await tick(20);
    agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'sub-1', name: 'invoke_subagent', kind: 'other', status: 'in_progress', rawInput: { Role: 'Helper', Prompt: 'do it' } });
    agent.notify({ sessionUpdate: 'tool_call_update', toolCallId: 'sub-1', name: 'invoke_subagent', status: 'completed' });
    session.step(0, 3, 15);
    session.step(1, 2); // the parent's own background command
    child.step(0, 3, 15);
    child.step(1, 9); // WAITING on an approval
    prompt.resolve({ stopReason: 'end_turn' });
    await tick(4000);
    assert.deepEqual(agent.events.done, [['sub-1', { status: 'error' }]], 'the waiting child is stalled');
    assert.equal(agent.events.turnEnds.length, 0, "the parent's command still holds the turn");
    session.step(1, 3);
    await tick(4500);
    assert.equal(agent.events.turnEnds.length, 1);
    assert.match(agent.events.text, /subagent stopped: it needed an approval/);
  });
});

await check('fake: grouped model sends resolved flat id and falls back to model + thought_level config options', async () => {
  const groupedModel = {
    providerId: 'antigravity',
    slug: 'gemini-4-neon',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
  };
  const firstPrompt = deferred();
  const direct = fakeAgent({
    respond: baseRespond([firstPrompt]),
    model: groupedModel,
    reasoningEffort: 'xhigh',
  });
  void direct.driver.start();
  await tick(20);
  assert.deepEqual(
    direct.sent.find((message) => message.method === 'session/set_model')?.params,
    { sessionId: 'sess-1', modelId: 'gemini-4-neon-xhigh' }
  );
  firstPrompt.resolve({ stopReason: 'end_turn' });
  await tick(20);

  const fallbackPrompt = deferred();
  const fallback = fakeAgent({
    model: groupedModel,
    reasoningEffort: 'low',
    respond: (method, params) => {
      if (method === 'session/set_model') return { error: { code: -32602, message: 'unknown flat id' } };
      return baseRespond([fallbackPrompt])(method, params);
    },
  });
  void fallback.driver.start();
  await tick(20);
  assert.deepEqual(
    fallback.sent
      .filter((message) => message.method === 'session/set_config_option')
      .map((message) => [message.params.configId, message.params.value]),
    [
      ['model', 'gemini-4-neon'],
      ['thought_level', 'low'],
    ]
  );
  fallbackPrompt.resolve({ stopReason: 'end_turn' });
  await tick(20);
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

await check('fake: 502 Bad Gateway and mid-turn 404 error classification', () => {
  const badGateway = antigravityFailureFromErrorText('Error 502, Message: bad gateway, Status: 502 Bad Gateway');
  assert.match(badGateway.message, /bad gateway \(502 Bad Gateway, HTTP 502\)/);
  assert.equal(badGateway.retryable, true);
  const midTurn404 = antigravityFailureFromErrorText('Error 404, Message: edge blip, Status: NOT_FOUND', { reachedModel: true });
  assert.equal(midTurn404.retryable, true);
  assert.equal(midTurn404.resumeWith, 'continue');
  assert.doesNotMatch(midTurn404.message, /can't use this model/);
});

await check('fake: native systemPrompt.append via session/new _meta, warm dedup, and fallback', async () => {
  const sessionState = {
    initialized: null,
    sessionId: null,
    currentModelKey: null,
    currentModeId: null,
    availableModes: [],
    systemPromptAppendApplied: null,
  };
  let reqId = 1;
  const prompt1 = deferred();
  const withAppend = fakeAgent({
    promptText: 'do work',
    systemPromptAppend: '[Orion general instructions]\nuse bun\n[/Orion general instructions]',
    sessionState,
    nextRequestId: () => reqId++,
    respond: (method) => {
      if (method === 'initialize') {
        return {
          agentInfo: { name: 'agy', version: '1.5.15' },
          agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } },
        };
      }
      return baseRespond([prompt1])(method);
    },
  });
  void withAppend.driver.start();
  await tick(20);
  const newReq = withAppend.sent.find((m) => m.method === 'session/new');
  assert.equal(newReq?.params?._meta?.antigravity?.systemPrompt?.append, '[Orion general instructions]\nuse bun\n[/Orion general instructions]');
  const promptReq = withAppend.sent.find((m) => m.method === 'session/prompt');
  assert.equal(promptReq?.params?.prompt?.[0]?.text, 'do work');
  prompt1.resolve({ stopReason: 'end_turn' });
  await tick(20);

  // Turn 2 on the same warm session with unchanged standing instructions stays clean (no duplication).
  const promptWarmSame = deferred();
  const warmSame = fakeAgent({
    promptText: 'follow up',
    resumeSessionId: sessionState.sessionId,
    systemPromptAppend: '[Orion general instructions]\nuse bun\n[/Orion general instructions]',
    sessionState,
    nextRequestId: () => reqId++,
    respond: (method) => (method === 'session/prompt' ? promptWarmSame.promise : {}),
  });
  void warmSame.driver.start();
  await tick(20);
  assert.equal(
    warmSame.sent.find((m) => m.method === 'session/prompt')?.params?.prompt?.[0]?.text,
    'follow up',
    'warm follow-up with unchanged systemPromptAppend does not duplicate instructions into user prompt'
  );
  promptWarmSame.resolve({ stopReason: 'end_turn' });
  await tick(20);

  // Turn 3 on the same warm session with changed standing instructions folds the new instructions in.
  const promptWarmChanged = deferred();
  const warmChanged = fakeAgent({
    promptText: 'follow up 2',
    resumeSessionId: sessionState.sessionId,
    systemPromptAppend: '[Orion general instructions]\nuse pnpm\n[/Orion general instructions]',
    sessionState,
    nextRequestId: () => reqId++,
    respond: (method) => (method === 'session/prompt' ? promptWarmChanged.promise : {}),
  });
  void warmChanged.driver.start();
  await tick(20);
  assert.match(
    warmChanged.sent.find((m) => m.method === 'session/prompt')?.params?.prompt?.[0]?.text ?? '',
    /use pnpm[\s\S]*follow up 2/,
    'warm follow-up with updated systemPromptAppend delivers the updated instructions'
  );
  promptWarmChanged.resolve({ stopReason: 'end_turn' });
  await tick(20);

  const prompt2 = deferred();
  const fallback = fakeAgent({
    promptText: '/plan build it',
    systemPromptAppend: '[Orion general instructions]\nuse bun',
    respond: baseRespond([prompt2]),
  });
  void fallback.driver.start();
  await tick(20);
  const fallbackPrompt = fallback.sent.find((m) => m.method === 'session/prompt')?.params?.prompt?.[0]?.text;
  assert.ok(fallbackPrompt.startsWith('/plan build it\n\n[Orion general instructions]'), 'slash command stays at byte 0 on fallback');
  prompt2.resolve({ stopReason: 'end_turn' });
  await tick(20);
});

await check('fake: interactive interaction_* question and generalized elicitation', async () => {
  const prompt = deferred();
  const seenRequests = [];
  const agent = fakeAgent({
    respond: baseRespond([prompt]),
    onUserInput: (driver) => {
      for (const req of driver.getUserInputs()) {
        seenRequests.push(req);
        if (req.requestId === 'iq1') driver.answerUserInput('iq1', { interaction_1: ['Option B'] });
        if (req.requestId === 'el2') driver.answerUserInput('el2', { confirm: ['Yes'], count: ['42'], choice: ['beta'] });
      }
    },
  });
  void agent.driver.start();
  await tick(20);
  agent.ask('iq1', 'session/request_permission', {
    toolCall: { toolCallId: 'interaction_1', title: 'Pick one' },
    options: [
      { optionId: 'opt_a', name: 'Option A', kind: 'allow_once' },
      { optionId: 'opt_b', name: 'Option B', kind: 'allow_once' },
    ],
  });
  agent.ask('el2', 'elicitation/create', {
    mode: 'form',
    message: 'Details',
    requestedSchema: {
      type: 'object',
      required: ['confirm', 'count', 'choice'],
      properties: {
        confirm: { type: 'boolean', title: 'Proceed?' },
        count: { type: 'integer', title: 'Count' },
        choice: { type: 'string', title: 'Mode', enum: ['alpha', 'beta'] },
      },
    },
  });
  await tick(20);
  assert.deepEqual(agent.answers.find((a) => a.id === 'iq1')?.result, {
    outcome: { outcome: 'selected', optionId: 'opt_b' },
  });
  assert.deepEqual(agent.answers.find((a) => a.id === 'el2')?.result, {
    action: 'accept',
    content: { confirm: true, count: 42, choice: 'beta' },
  });
  prompt.resolve({ stopReason: 'end_turn' });
  await tick(20);
});

await check('fake: native auto mode and interactive approval card with agy.security.warning', async () => {
  const prompt = deferred();
  const capturedApprovals = [];
  const agent = fakeAgent({
    accessMode: 'auto',
    respond: (method) => {
      if (method === 'initialize') return { agentInfo: { name: 'agy', version: '1.5.15' }, agentCapabilities: {} };
      if (method === 'session/new') {
        return { sessionId: 'sess-auto', modes: { availableModes: [{ id: 'default' }, { id: 'auto' }] } };
      }
      if (method === 'session/set_model' || method === 'session/set_mode') return {};
      if (method === 'session/prompt') return prompt.promise;
      return {};
    },
    onUserInput: (driver) => {
      for (const req of driver.getUserInputs()) {
        capturedApprovals.push(req);
        if (req.requestId === 'ap1') driver.answerUserInput('ap1', { permission: ['Allow for this thread'] });
        if (req.requestId === 'ap2') driver.answerUserInput('ap2', { permission: ['Deny'] });
      }
    },
  });
  void agent.driver.start();
  await tick(20);
  assert.equal(agent.sent.find((m) => m.method === 'session/set_mode')?.params?.modeId, 'auto');
  // Orion MCP tools pre-approve even in auto mode.
  agent.ask('ap_orion', 'session/request_permission', {
    toolCall: { toolCallId: 't0', name: 'mcp_orion_read_thread', kind: 'other' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
  });
  // Escalated shell command raises ApprovalCard with agy.security.warning.
  agent.ask('ap1', 'session/request_permission', {
    toolCall: { toolCallId: 't1', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'rm -rf ./dist' } },
    options: [
      { optionId: 'allow_1', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow_all', name: 'Allow always', kind: 'allow_always', _meta: { 'agy.security.warning': { message: 'Allows shell commands for this thread.' } } },
      { optionId: 'deny_1', name: 'Deny', kind: 'reject_once' },
    ],
  });
  agent.ask('ap2', 'session/request_permission', {
    toolCall: { toolCallId: 't2', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'curl evil.test' } },
    options: [
      { optionId: 'allow_1', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'deny_1', name: 'Deny', kind: 'reject_once' },
    ],
  });
  await tick(20);
  assert.equal(agent.answers.find((a) => a.id === 'ap_orion')?.result?.outcome?.optionId, 'allow');
  assert.equal(agent.answers.find((a) => a.id === 'ap1')?.result?.outcome?.optionId, 'allow_all');
  assert.equal(agent.answers.find((a) => a.id === 'ap2')?.result?.outcome?.optionId, 'deny_1');
  const card = capturedApprovals.find((r) => r.requestId === 'ap1')?.approval;
  assert.equal(card?.allowForThread, true);
  assert.match(card?.warning ?? '', /Allows shell commands/);
  prompt.resolve({ stopReason: 'end_turn' });
  await tick(20);
});

await check('fake: HTTP MCP selection, session/resume preference, and warm session reuse', async () => {
  const stdioServers = [{ name: 'orion', command: 'node', args: ['shim.cjs'], env: [] }];
  const httpServers = [{ type: 'http', name: 'orion', url: 'http://127.0.0.1:12345/mcp', headers: [{ name: 'Authorization', value: 'Bearer tok' }] }];
  const sessionState = { initialized: null, sessionId: null, currentModelKey: null, currentModeId: null, availableModes: [] };
  let reqId = 1;
  const prompt1 = deferred();
  const cold = fakeAgent({
    resumeSessionId: 'sess-prev',
    mcpServers: stdioServers,
    httpMcpServers: httpServers,
    sessionState,
    nextRequestId: () => reqId++,
    respond: (method) => {
      if (method === 'initialize') {
        return {
          agentInfo: { name: 'agy', version: '1.5.15' },
          agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { resume: {} } },
        };
      }
      if (method === 'session/resume') return { sessionId: 'sess-prev' };
      if (method === 'session/set_model' || method === 'session/set_mode') return {};
      if (method === 'session/prompt') return prompt1.promise;
      return {};
    },
  });
  void cold.driver.start();
  await tick(20);
  const resumeReq = cold.sent.find((m) => m.method === 'session/resume');
  assert.ok(resumeReq, 'uses session/resume when advertised');
  assert.equal(resumeReq.params.mcpServers[0].type, 'http', 'selects HTTP MCP when advertised');
  prompt1.resolve({ stopReason: 'end_turn' });
  await tick(20);

  // Second turn on the same warm sessionState skips initialize, session/resume, set_model, set_mode!
  const prompt2 = deferred();
  const warm = fakeAgent({
    resumeSessionId: 'sess-prev',
    mcpServers: stdioServers,
    httpMcpServers: httpServers,
    sessionState,
    nextRequestId: () => reqId++,
    respond: (method) => (method === 'session/prompt' ? prompt2.promise : {}),
  });
  void warm.driver.start();
  await tick(20);
  assert.deepEqual(warm.sent.map((m) => m.method), ['session/prompt'], 'warm turn sends only session/prompt');
  assert.ok(warm.sent[0].id > cold.sent.at(-1).id, 'request ids stay monotonic across turns');
  prompt2.resolve({ stopReason: 'end_turn' });
  await tick(20);
});

await check('fake: IsDaemon does not hold turn open; schedule does; cancel sends session/cancel', async () => {
  const promptDaemon = deferred();
  const daemonAgent = fakeAgent({ respond: baseRespond([promptDaemon]) });
  void daemonAgent.driver.start();
  await tick(20);
  daemonAgent.notify({
    sessionUpdate: 'tool_call',
    toolCallId: 'd1',
    name: 'run_command',
    kind: 'execute',
    status: 'in_progress',
    rawInput: { CommandLine: 'bun dev', IsDaemon: true },
  });
  promptDaemon.resolve({ stopReason: 'end_turn' });
  await tick(50);
  assert.equal(daemonAgent.events.turnEnds.length, 1, 'daemon command finishes immediately after prompt');

  const promptCancel = deferred();
  const cancelAgent = fakeAgent({ respond: baseRespond([promptCancel]) });
  void cancelAgent.driver.start();
  await tick(20);
  const cancelling = cancelAgent.driver.cancel();
  await tick(20);
  assert.ok(cancelAgent.sent.some((m) => m.method === 'session/cancel'), 'cancel sends session/cancel notification');
  promptCancel.resolve({ stopReason: 'cancelled' });
  assert.equal(await cancelling, true);
});

await check('fake: handshake timeout, inactivity timeout, slash commands, pre-edit unified diff & sanitization', async () => {
  // Handshake timeout
  const hung = fakeAgent({
    handshakeTimeoutMs: 50,
    respond: () => new Promise(() => {}),
  });
  void hung.driver.start();
  await tick(100);
  assert.match(hung.events.fatal ?? '', /Timed out waiting for Antigravity \(initialize\)/);

  // Inactivity timeout
  const silent = fakeAgent({
    promptInactivityTimeoutMs: 120,
    respond: baseRespond([deferred()]),
  });
  void silent.driver.start();
  await tick(350);
  assert.match(silent.events.fatal ?? '', /stopped responding/);

  // Slash commands + pre-edit diff + payload sanitization
  const sampleFile = path.join(fakeWorkspace, 'diff-target.txt');
  fs.writeFileSync(sampleFile, Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n') + '\n');
  const p = deferred();
  const agent = fakeAgent({ respond: baseRespond([p]) });
  void agent.driver.start();
  await tick(20);
  agent.notify({
    sessionUpdate: 'available_commands_update',
    availableCommands: [{ name: 'compact', description: 'Summarize', input: { hint: '[focus]' } }],
  });
  assert.deepEqual(agent.events.slashCommands[0], [{ name: 'compact', description: 'Summarize', argumentHint: '[focus]' }]);

  agent.notify({
    sessionUpdate: 'tool_call',
    toolCallId: 'ed1',
    name: 'replace_file_content',
    kind: 'edit',
    status: 'pending',
    rawInput: {
      TargetFile: sampleFile,
      StartLine: 7,
      EndLine: 9,
      TargetContent: 'line8\nline9',
      ReplacementContent: 'line8-edited\nline9',
      Preview: 'data:image/png;base64,AAAA',
    },
  });
  await tick(20);
  const edActivity = agent.events.activities.get('ed1');
  assert.match(edActivity?.diff?.patch ?? '', /@@ -5,7 \+5,7 @@/);
  assert.match(edActivity?.diff?.patch ?? '', /-line8\n\+line8-edited/);
  assert.doesNotMatch(edActivity?.input ?? '', /data:image\/png/);
  p.resolve({ stopReason: 'end_turn' });
  await tick(20);
});

await check('session manager: reuses warm process and rebinds MCP across turns, disposes cleanly', async () => {
  let spawns = 0;
  let mcpCreates = 0;
  let mcpRebinds = 0;
  let mcpReleases = 0;
  let kills = 0;
  const makeChild = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => true };
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    return child;
  };
  const manager = createAntigravitySessionManager({
    spawnProcess: () => {
      spawns += 1;
      return makeChild();
    },
    terminateProcess: async (child) => {
      kills += 1;
      child.killed = true;
      child.emit('close', 0, null);
    },
    idleTimeoutMs: 5000,
  });
  const createMcp = async () => {
    mcpCreates += 1;
    return {
      rebindTurn: () => {
        mcpRebinds += 1;
      },
      release: () => {
        mcpReleases += 1;
      },
    };
  };
  const lease1 = await manager.acquire({
    threadId: 't-warm',
    cwd: fakeWorkspace,
    accessMode: 'full-access',
    commandArgs: ['agy', 'acp', '--dangerously-skip-permissions'],
    createMcp,
    rebindMcp: (m) => m.rebindTurn(),
  });
  assert.equal(lease1.reused, false);
  lease1.entry.initialized = { agentVersion: '1.5.15', agentCapabilities: {} };
  lease1.entry.sessionId = 's-1';
  await lease1.release({ keepAlive: true });
  assert.equal(kills, 0);
  assert.equal(mcpReleases, 0);

  const lease2 = await manager.acquire({
    threadId: 't-warm',
    cwd: fakeWorkspace,
    accessMode: 'full-access',
    commandArgs: ['agy', 'acp', '--dangerously-skip-permissions'],
    resumeSessionId: 's-1',
    createMcp,
    rebindMcp: (m) => m.rebindTurn(),
  });
  assert.equal(lease2.reused, true);
  assert.equal(spawns, 1);
  assert.equal(mcpCreates, 1);
  assert.equal(mcpRebinds, 1);
  await lease2.release({ keepAlive: true });

  assert.equal(await manager.disposeThread('t-warm'), true);
  assert.equal(kills, 1);
  assert.equal(mcpReleases, 1);
});

await check('ACP model probe: discovers per-model thought_level options and cleans up session files', async () => {
  const removed = [];
  let terminated = 0;
  const modelOptions = [
    { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
    { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
    { value: 'gemini-pro-orchestrator', name: 'Orchestrator' },
    { value: 'gemini-pro-orchestrator-alt', name: 'Orchestrator' },
  ];
  const makeConfig = (currentModel, thoughtLevels, currentThought) => [
    { id: 'model', category: 'model', type: 'select', currentValue: currentModel, options: modelOptions },
    ...(thoughtLevels
      ? [{
          id: 'thought_level',
          category: 'thought_level',
          type: 'select',
          currentValue: currentThought,
          options: thoughtLevels.map((v) => ({ value: v, name: v })),
        }]
      : []),
  ];

  const models = await probeAntigravityModelsOverAcp({
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stderr.resume = () => {};
      child.stdin = {
        write: (line) => {
          const msg = JSON.parse(line);
          queueMicrotask(() => {
            if (msg.method === 'initialize') {
              child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { agentInfo: { version: '1.5.15' } } })}\n`);
            } else if (msg.method === 'session/new') {
              child.stdout.emit(
                'data',
                `${JSON.stringify({
                  jsonrpc: '2.0',
                  id: msg.id,
                  result: {
                    sessionId: 'probe-sess-1',
                    configOptions: makeConfig('gemini-4-neon', ['low', 'medium', 'high', 'xhigh'], 'high'),
                  },
                })}\n`
              );
            } else if (msg.method === 'session/set_config_option') {
              const value = msg.params?.value;
              const configOptions =
                value === 'gemini-4-carbon'
                  ? makeConfig('gemini-4-carbon', ['low', 'medium', 'high'], 'medium')
                  : makeConfig(value, null, null);
              child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { configOptions } })}\n`);
            }
          });
          return true;
        },
      };
      return child;
    },
    terminateProcess: async () => {
      terminated += 1;
    },
    removeSessionFiles: async (info) => {
      removed.push(info);
    },
    fallbackGroupRows: groupAntigravityModelRows,
  });

  assert.equal(models.length, 4);
  assert.deepEqual(models[0].reasoningEfforts, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(models[0].defaultReasoningEffort, 'high');
  assert.equal(models[0].favorite, true);
  assert.deepEqual(models[1].reasoningEfforts, ['low', 'medium', 'high']);
  assert.equal(models[1].defaultReasoningEffort, 'medium');
  assert.equal(models[2].reasoningEfforts, undefined, 'non-thinking model has no reasoningEfforts');
  assert.equal(models[3].label, 'Orchestrator (gemini-pro-orchestrator-alt)', 'disambiguates duplicate model labels');
  assert.equal(terminated, 1);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].sessionId, 'probe-sess-1');

  // Legacy fallback when configOptions lacks a model selector
  const legacy = buildAntigravityModelsFromAcpProbe(
    {
      models: {
        availableModels: [
          { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
          { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
        ],
      },
    },
    new Map(),
    { fallbackGroupRows: groupAntigravityModelRows }
  );
  assert.equal(legacy.length, 1);
  assert.deepEqual(legacy[0].reasoningEfforts, ['low', 'high']);
});

await check('fake: transient error auto-retries once with Continue and surfaces retryable metadata when exhausted', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const convDir = path.join(antigravityCliHome(), 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  const sid1 = `agy-retry-ok-${process.pid}-${Date.now()}`;
  const dbPath1 = path.join(convDir, `${sid1}.db`);
  const db1 = new DatabaseSync(dbPath1);
  db1.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)');
  let promptCalls1 = 0;
  try {
    const agent1 = fakeAgent({
      promptText: 'finish task',
      maxTransientRetries: 1,
      transientRetryDelayMs: 10,
      respond: (method) => {
        if (method === 'initialize') return { agentInfo: { version: '1.5.15' }, agentCapabilities: {} };
        if (method === 'session/new') return { sessionId: sid1 };
        if (method === 'session/set_model' || method === 'session/set_mode') return {};
        if (method === 'session/prompt') {
          promptCalls1 += 1;
          if (promptCalls1 === 1) {
            agent1.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Part 1.' } });
            db1
              .prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)')
              .run(1, 15, 3, Buffer.from('partial'));
            db1
              .prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)')
              .run(2, 17, 3, Buffer.from('Error 502, Message: bad gateway, Status: 502 Bad Gateway'));
            return { stopReason: 'end_turn' };
          }
          agent1.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Part 2 done.' } });
          db1
            .prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)')
            .run(3, 15, 3, Buffer.from('done'));
          return { stopReason: 'end_turn' };
        }
        return {};
      },
    });
    await agent1.driver.start();
    await tick(60);
    assert.equal(promptCalls1, 2, 'auto-retried transient 502 once');
    assert.equal(agent1.events.fatal, null, 'recovered cleanly without fatal');
    assert.equal(agent1.events.turnEnds.length, 1);
    assert.match(agent1.events.text, /Part 1\.[\s\S]*Part 2 done\./);
    const promptReqs = agent1.sent.filter((m) => m.method === 'session/prompt');
    assert.equal(promptReqs[1]?.params?.prompt?.[0]?.text, 'Continue.', 'auto-retry sends Continue. after partial progress');
  } finally {
    db1.close();
    fs.rmSync(dbPath1, { force: true });
  }

  // When retries are exhausted, onFatal receives retryable + resumeWith metadata for the UI button.
  const sid2 = `agy-retry-fail-${process.pid}-${Date.now()}`;
  const dbPath2 = path.join(convDir, `${sid2}.db`);
  const db2 = new DatabaseSync(dbPath2);
  db2.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)');
  let promptCalls2 = 0;
  try {
    const agent2 = fakeAgent({
      promptText: 'do work',
      maxTransientRetries: 1,
      transientRetryDelayMs: 10,
      respond: (method) => {
        if (method === 'initialize') return { agentInfo: { version: '1.5.15' }, agentCapabilities: {} };
        if (method === 'session/new') return { sessionId: sid2 };
        if (method === 'session/set_model' || method === 'session/set_mode') return {};
        if (method === 'session/prompt') {
          promptCalls2 += 1;
          const base = promptCalls2 * 2;
          db2
            .prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)')
            .run(base - 1, 15, 3, Buffer.from('step'));
          db2
            .prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)')
            .run(base, 17, 3, Buffer.from('Error 404, Message: not found, Status: NOT_FOUND'));
          return { stopReason: 'end_turn' };
        }
        return {};
      },
    });
    await agent2.driver.start();
    await tick(60);
    assert.equal(promptCalls2, 2, 'tried initial prompt + 1 auto-retry');
    assert.match(agent2.events.fatal ?? '', /HTTP 404/);
    assert.deepEqual(agent2.events.fatalMeta, { retryable: true, resumeWith: 'continue' });
  } finally {
    db2.close();
    fs.rmSync(dbPath2, { force: true });
  }
});

await check('fake: review regressions (elicitation typing/bounds/optional, ordinary tool vs daemon, keep-warm finishDriverRun)', async () => {
  // 1. Elicitation preserves numeric enum types, enforces scalar anyOf & numeric bounds, and propagates optional required flag.
  const p1 = deferred();
  let capturedReq = null;
  const elAgent = fakeAgent({
    respond: baseRespond([p1]),
    onUserInput: (driver) => {
      const list = driver.getUserInputs();
      if (list.length) capturedReq = list[0];
    },
  });
  void elAgent.driver.start();
  await tick(20);
  elAgent.ask('el-typed', 'elicitation/create', {
    message: 'Configure',
    requestedSchema: {
      type: 'object',
      required: ['nums', 'mode', 'retries'],
      properties: {
        nums: { type: 'array', minItems: 1, items: { enum: [1, 2, 3] } },
        mode: { type: 'string', anyOf: [{ const: 'fast', title: 'Fast' }, { const: 'safe', title: 'Safe' }] },
        retries: { type: 'integer', minimum: 1, maximum: 5 },
        note: { type: 'string', title: 'Optional note' },
      },
    },
  });
  await tick(20);
  assert.ok(capturedReq, 'elicitation raised');
  const noteQ = capturedReq.questions.find((q) => q.id === 'note');
  const modeQ = capturedReq.questions.find((q) => q.id === 'mode');
  assert.equal(noteQ?.required, false, 'optional field exposes required: false');
  assert.equal(modeQ?.required, true, 'required field exposes required: true');
  assert.equal(modeQ?.options?.length, 2, 'scalar string anyOf parsed as choice options');

  // Out-of-range number must be rejected without clearing pending question.
  assert.equal(
    elAgent.driver.answerUserInput('el-typed', { nums: ['1'], mode: ['Fast'], retries: ['99'], note: [] }),
    false,
    'rejects number above maximum'
  );
  // Invalid value for scalar anyOf must be rejected without clearing pending question.
  assert.equal(
    elAgent.driver.answerUserInput('el-typed', { nums: ['1'], mode: ['unlisted'], retries: ['3'], note: [] }),
    false,
    'rejects unlisted scalar anyOf value'
  );
  assert.equal(elAgent.driver.getUserInputs().length, 1, 'invalid answers keep question pending');

  // Valid answer with omitted optional field succeeds and preserves numeric type in array.
  assert.equal(
    elAgent.driver.answerUserInput('el-typed', { nums: ['2'], mode: ['Safe'], retries: ['3'], note: [] }),
    true,
    'accepts valid answer with omitted optional field'
  );
  const elReply = elAgent.answers.find((m) => m.id === 'el-typed');
  assert.deepEqual(elReply?.result?.content, { nums: [2], mode: 'safe', retries: 3 });
  p1.resolve({ stopReason: 'end_turn' });
  await tick(20);

  // 2. An ordinary running read_file tool must NOT suppress DB running: 1 (only explicit IsDaemon tools do).
  const { DatabaseSync } = await import('node:sqlite');
  const convDir = path.join(antigravityCliHome(), 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  const sid = `agy-ordinary-tool-${process.pid}-${Date.now()}`;
  const dbPath = path.join(convDir, `${sid}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)');
  try {
    const p2 = deferred();
    const agent = fakeAgent({
      respond: (method) => {
        if (method === 'initialize') return { agentInfo: { version: '1.5.15' }, agentCapabilities: {} };
        if (method === 'session/new') return { sessionId: sid };
        if (method === 'session/set_model' || method === 'session/set_mode') return {};
        if (method === 'session/prompt') return p2.promise;
        return {};
      },
    });
    void agent.driver.start();
    await tick(20);
    // Ordinary non-daemon read tool still marked running in ACP while DB shows a running background command (idx=1, status=2 RUNNING).
    agent.notify({ sessionUpdate: 'tool_call', toolCallId: 'r1', name: 'read_file', kind: 'read', status: 'in_progress' });
    db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)').run(1, 5, 2, Buffer.from('bg'));
    p2.resolve({ stopReason: 'end_turn' });
    await tick(50);
    assert.equal(agent.events.turnEnds.length, 0, 'ordinary read tool does not mask DB running background work');
    agent.driver.dispose();
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }

  // 3. main.js finishDriverRun must not kill persistent Antigravity child before finalizeRun keeps it warm.
  const mainSrc = fs.readFileSync(path.join(process.cwd(), 'src/main.js'), 'utf8');
  const finishMatch = /const finishDriverRun = \(\) => \{[\s\S]*?\n    \};/.exec(mainSrc);
  assert.ok(finishMatch, 'found finishDriverRun in src/main.js');
  assert.match(finishMatch[0], /if \(!persistentAntigravity\) killAgentChild\(child\)/, 'finishDriverRun preserves persistent Antigravity process');

  // 4. Round-2 regressions: fresh turn (resumeSessionId: null) never reuses a warm session; LRU cap evicts oldest idle; idle request gets cancelled.
  const makeChild = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.writes = [];
    child.stdin = { write: (line) => { child.writes.push(line); return true; } };
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    return child;
  };
  const killedChildren = [];
  const mgr = createAntigravitySessionManager({
    spawnProcess: () => makeChild(),
    terminateProcess: async (child) => {
      killedChildren.push(child);
      child.killed = true;
      child.emit('close', 0, null);
    },
    idleTimeoutMs: 60_000,
    maxIdleSessions: 2,
  });
  const l1 = await mgr.acquire({ threadId: 'edit-t', cwd: fakeWorkspace, accessMode: 'full-access', commandArgs: ['agy', 'acp'] });
  l1.entry.initialized = { agentVersion: '1.5.15', agentCapabilities: {} };
  l1.entry.sessionId = 'sess-old';
  await l1.release({ keepAlive: true });
  // Message edit clears resumeSessionId -> must NOT reuse sess-old!
  const l2 = await mgr.acquire({ threadId: 'edit-t', cwd: fakeWorkspace, accessMode: 'full-access', commandArgs: ['agy', 'acp'], resumeSessionId: null });
  assert.equal(l2.reused, false, 'resumeSessionId: null never reuses a warm session');
  assert.notEqual(l2.child, l1.child, 'fresh child spawned for edited thread');
  l2.entry.initialized = { agentVersion: '1.5.15', agentCapabilities: {} };
  l2.entry.sessionId = 'sess-new';
  await l2.release({ keepAlive: true });
  // Idle agent->client permission request gets cancelled and destroys idle entry.
  l2.child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: {} })}\n`);
  await tick(20);
  assert.ok(l2.child.writes.some((w) => w.includes('"cancelled"') && w.includes('77')), 'idle permission request answered cancelled');
  assert.equal(l2.child.killed, true, 'idle process destroyed after unexpected idle traffic');

  // LRU cap (maxIdleSessions: 2) evicts oldest idle session when 3rd becomes idle.
  for (const tid of ['lru-1', 'lru-2', 'lru-3']) {
    const lx = await mgr.acquire({ threadId: tid, cwd: fakeWorkspace, accessMode: 'full-access', commandArgs: ['agy', 'acp'] });
    lx.entry.initialized = { agentVersion: '1.5.15', agentCapabilities: {} };
    lx.entry.sessionId = `s-${tid}`;
    await lx.release({ keepAlive: true });
    await tick(5);
  }
  assert.equal(mgr.snapshot().count, 2, 'LRU cap bounds idle warm sessions');
  await mgr.shutdown();

  // 5. Warm systemPrompt.append dedup with Turn-1 instructions + memory vs Turn-2 instructions-only.
  const memState = { initialized: null, sessionId: null, currentModelKey: null, currentModeId: null, availableModes: [], systemPromptAppendApplied: null };
  let memReqId = 1;
  const mp1 = deferred();
  const mem1 = fakeAgent({
    promptText: 'turn 1',
    systemPromptAppend: '[Orion general instructions]\nuse bun\n[/Orion general instructions]\n\n[Durango memory]\nlikes cats\n[/Durango memory]',
    sessionState: memState,
    nextRequestId: () => memReqId++,
    respond: (method) => {
      if (method === 'initialize') return { agentInfo: { version: '1.5.15' }, agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } } };
      return baseRespond([mp1])(method);
    },
  });
  void mem1.driver.start();
  await tick(20);
  mp1.resolve({ stopReason: 'end_turn' });
  await tick(20);
  const mp2 = deferred();
  const mem2 = fakeAgent({
    promptText: 'turn 2',
    resumeSessionId: memState.sessionId,
    systemPromptAppend: '[Orion general instructions]\nuse bun\n[/Orion general instructions]',
    sessionState: memState,
    nextRequestId: () => memReqId++,
    respond: (method) => (method === 'session/prompt' ? mp2.promise : {}),
  });
  void mem2.driver.start();
  await tick(20);
  assert.equal(
    mem2.sent.find((m) => m.method === 'session/prompt')?.params?.prompt?.[0]?.text,
    'turn 2',
    'warm Turn 2 with instructions-only stays deduplicated when Turn 1 appended instructions + memory'
  );
  mp2.resolve({ stopReason: 'end_turn' });
  await tick(20);

  // 6. Auto mode fallback to default auto-allows read-only tools instead of prompting.
  const ap = deferred();
  let autoAsked = 0;
  const autoFallback = fakeAgent({
    accessMode: 'auto',
    respond: baseRespond([ap]), // no availableModes -> falls back to default
    onUserInput: () => { autoAsked += 1; },
  });
  void autoFallback.driver.start();
  await tick(20);
  autoFallback.ask(55, 'session/request_permission', {
    toolCall: { toolCallId: 'ro-1', name: 'read_file', kind: 'read' },
    options: [{ optionId: 'a1', kind: 'allow_once', name: 'Allow' }, { optionId: 'r1', kind: 'reject_once', name: 'Deny' }],
  });
  await tick(20);
  assert.equal(autoAsked, 0, 'auto fallback to default auto-allows read-only tools');
  assert.equal(autoFallback.answers.find((m) => m.id === 55)?.result?.outcome?.optionId, 'a1');
  ap.resolve({ stopReason: 'end_turn' });
  await tick(20);

  // 7. Startup orphan sweep ONLY removes Durango-owned temp prefixes, never arbitrary user /tmp sessions.
  const sweepRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sweep-test-')));
  try {
    const fakeCliHome = path.join(sweepRoot, 'cli-home');
    const fakeConvDir = path.join(fakeCliHome, 'conversations');
    fs.mkdirSync(fakeConvDir, { recursive: true });
    const ownedWs = path.join(os.tmpdir(), `durango-agy-oneshot-gone-${Date.now()}`);
    const userWs = path.join(os.tmpdir(), `user-scratch-gone-${Date.now()}`);
    fs.writeFileSync(path.join(fakeConvDir, 'sess-owned.db'), 'x');
    fs.writeFileSync(path.join(fakeConvDir, 'sess-owned.meta'), JSON.stringify({ workspaces: [ownedWs] }));
    fs.writeFileSync(path.join(fakeConvDir, 'sess-user.db'), 'x');
    fs.writeFileSync(path.join(fakeConvDir, 'sess-user.meta'), JSON.stringify({ workspaces: [userWs] }));
    const res = await sweepOrphanAntigravityTempSessions({ cliHome: fakeCliHome });
    assert.deepEqual(res.removed, ['sess-owned'], 'sweeps only Durango-owned temp sessions');
    assert.equal(fs.existsSync(path.join(fakeConvDir, 'sess-user.db')), true, 'preserves user /tmp sessions');
  } finally {
    fs.rmSync(sweepRoot, { recursive: true, force: true });
  }
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

  await check('live: ACP model probe discovers real thought_level options and leaves zero session files', async () => {
    const convDir = path.join(antigravityCliHome(), 'conversations');
    const before = new Set(fs.existsSync(convDir) ? fs.readdirSync(convDir) : []);
    const models = await probeAntigravityModelsOverAcp({ fallbackGroupRows: groupAntigravityModelRows });
    const after = new Set(fs.existsSync(convDir) ? fs.readdirSync(convDir) : []);
    const leftover = [...after].filter((f) => !before.has(f));
    assert.ok(models.length > 0, 'probed at least one live Antigravity model');
    assert.ok(
      models.some((m) => Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length >= 3),
      'at least one model reported dynamic thought_level options'
    );
    assert.deepEqual(leftover, [], `probe leaked session files: ${leftover.join(', ')}`);
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
