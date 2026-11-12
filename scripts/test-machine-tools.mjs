// machine_* agent tools (src/main/machine-tools.js) against a fake fleet of
// paired machines: machine resolution, access-mode limits, exec formatting,
// project and model matching, and machine_run_agent's wait for the turn's end.
// The wire itself (exec on a real host) is covered by test-remote-control.mjs.
import assert from 'node:assert/strict';
import os from 'node:os';

const {
  MACHINE_TOOL_DEFINITIONS,
  defaultRemoteModel,
  remoteThreadSpawner,
  machineMcpToolDefinitions,
  machineToolsForAccessMode,
  machineToolsPromptHint,
  runMachineTool,
  setMachineToolDepsForTests,
} = await import('../src/main/machine-tools.js');
const { isPreapprovedOrionTool } = await import('../src/main/thread-reader-routing.js');
const { runExecCommand } = await import('../src/main/remote-exec.js');

const machines = [
  { id: 'm-omarchy', name: 'omarchy', status: 'connected' },
  { id: 'm-studio', name: 'Studio Mac', status: 'offline' },
];
const snapshot = {
  machine: { id: 'm-omarchy', name: 'omarchy' },
  projects: [
    { id: 'orion:no-project', name: 'No project', path: '/home/u/chats', repoId: null },
    { id: 'p-fm', name: 'futuremail', path: '/home/u/futuremail', repoId: 'r1' },
  ],
  threads: [
    { id: 't-old', projectId: 'p-fm', title: 'Old', status: 'done', modelId: 'claude:opus', updatedAt: '2026-11-01T00:00:00Z', messageCount: 4 },
    { id: 't-run', projectId: 'p-fm', title: 'Rich messages', status: 'running', modelId: 'claude:opus', updatedAt: '2026-11-12T00:00:00Z', messageCount: 9 },
    { id: 't-sub', projectId: 'p-fm', parentThreadId: 't-run', title: 'Sub', status: 'running', messageCount: 2 },
  ],
};

let calls = [];
let listeners = new Set();
let canControl = true;
let hostThreads = new Map();
const remote = {
  canControlRemoteMachines: () => canControl,
  getRemoteControlState: () => ({ available: true, authenticated: true, machineName: 'MacBook', machines }),
  fetchRemoteSnapshot: async ({ machineId }) =>
    machineId === 'm-omarchy' ? { ok: true, snapshot } : { ok: false, error: 'The host is offline.' },
  fetchRemoteThread: async ({ threadId }) =>
    hostThreads.has(threadId) ? { ok: true, thread: hostThreads.get(threadId) } : { ok: false, error: 'Thread not found on the host.' },
  fetchRemoteModels: async () => ({
    ok: true,
    models: [
      { id: 'claude:opus', providerId: 'claude', label: 'Claude Opus', slug: 'opus', available: true },
      { id: 'codex:gpt', providerId: 'codex', label: 'GPT', slug: 'gpt', available: true },
      { id: 'grok:grok-4.7', providerId: 'grok', label: 'Grok 4.7', slug: 'grok-4.7', available: false },
    ],
  }),
  execOnRemoteMachine: async (input) => {
    calls.push({ kind: 'exec', input });
    return {
      ok: true,
      exitCode: 0,
      signal: null,
      stdout: 'hello\n',
      stderr: '',
      timedOut: false,
      cancelled: false,
      durationMs: 42,
      cwd: '/home/u/futuremail',
    };
  },
  runRemoteTurn: async (input) => {
    calls.push({ kind: 'runTurn', input });
    const threadId = input.threadId ?? 't-new';
    hostThreads.set(threadId, {
      id: threadId,
      title: 'Install bun',
      status: 'running',
      modelId: input.modelId ?? 'claude:opus',
      createdAt: '2026-11-12T00:00:00Z',
      messages: [{ role: 'user', content: input.prompt }, { role: 'agent', content: '', status: 'running' }],
    });
    if (threadId === 't-slow') return { ok: true, threadId };
    if (threadId === 't-busy') {
      // A follow-up with the same text as an earlier turn; another follow-up
      // starts there before this waiter reads the saved transcript.
      const earlier = hostThreads.get('t-busy').messages;
      setTimeout(() => {
        hostThreads.set('t-busy', {
          ...hostThreads.get('t-busy'),
          status: 'running',
          messages: [
            ...earlier,
            { role: 'user', content: input.prompt },
            { role: 'agent', content: 'new reply', status: 'done' },
            { role: 'user', content: 'and then this' },
            { role: 'agent', content: 'later turn', status: 'running' },
          ],
        });
        for (const listener of listeners) {
          listener({ machineId: 'm-omarchy', kind: 'turnEvent', payload: { type: 'done', threadId } });
        }
      }, 50);
      return { ok: true, threadId };
    }
    // The turn ends a moment later; the transcript is saved after the event.
    setTimeout(() => {
      for (const listener of listeners) {
        listener({ machineId: 'm-omarchy', kind: 'turnEvent', payload: { type: 'done', threadId } });
      }
      setTimeout(() => {
        hostThreads.set(threadId, {
          ...hostThreads.get(threadId),
          status: 'done',
          messages: [{ role: 'user', content: input.prompt }, { role: 'agent', content: 'bun 1.3 installed.', status: 'done' }],
        });
      }, 300);
    }, 50);
    return { ok: true, threadId };
  },
  stopRemoteTurn: async (input) => {
    calls.push({ kind: 'stop', input });
    return { ok: true };
  },
  addRemoteEventListener: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
setMachineToolDepsForTests({
  remote,
  resolveCallerProject: async ({ machineId, projectPath }) => {
    calls.push({ kind: 'resolveProject', input: { machineId, projectPath } });
    return { ok: true, projectId: 'p-fm', projectName: 'futuremail' };
  },
});

const full = { accessMode: 'full-access', projectPath: '/Users/me/futuremail' };
// Electron keeps running after an uncaught error; end the test instead.
process.on('uncaughtException', (error) => {
  console.error(error);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error(error);
  process.exit(1);
});

// Listing per access mode, and pre-approval.
{
  assert.deepEqual(
    machineToolsForAccessMode('read-only').map((tool) => tool.name),
    ['machine_list', 'machine_threads', 'machine_read_thread']
  );
  assert.equal(machineToolsForAccessMode('workspace-write').length, MACHINE_TOOL_DEFINITIONS.length);
  for (const tool of machineMcpToolDefinitions('full-access')) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.readOnly, undefined, 'MCP definitions carry no private fields');
  }
  assert.equal(isPreapprovedOrionTool('machine_list', 'read-only'), true);
  assert.equal(isPreapprovedOrionTool('machine_exec', 'workspace-write'), false, 'Workspace write asks before commands there');
  assert.equal(isPreapprovedOrionTool('machine_exec', 'full-access'), true);
  assert.match(machineToolsPromptHint(), /This machine is MacBook.*omarchy, Studio Mac/s);
  console.log('ok  machine tools listed and pre-approved by access mode');
}

// machine_list reports reachable and unreachable machines.
{
  const result = await runMachineTool('machine_list', {}, full);
  assert.equal(result.ok, true);
  assert.match(result.text, /## omarchy \(id: m-omarchy\)\nConnected\./);
  assert.match(result.text, /futuremail \(id: p-fm\) — \/home\/u\/futuremail, 2 threads/);
  assert.match(result.text, /Running now: "Rich messages" \(t-run\)/);
  assert.match(result.text, /## Studio Mac[^\n]*\nNot reachable now: The host is offline\./);
  console.log('ok  machine_list');
}

// Machine resolution.
{
  assert.match((await runMachineTool('machine_threads', {}, full)).text, /Name the machine/);
  assert.match((await runMachineTool('machine_threads', { machine: 'nope' }, full)).text, /No paired machine is called "nope"/);
  const byPrefix = await runMachineTool('machine_threads', { machine: 'OMA' }, full);
  assert.equal(byPrefix.ok, true);
  assert.ok(byPrefix.text.indexOf('t-run') < byPrefix.text.indexOf('t-old'), 'most recent first');
  assert.doesNotMatch(byPrefix.text, /t-sub/, 'subagent threads are not listed');
  const running = await runMachineTool('machine_threads', { machine: 'omarchy', running: true }, full);
  assert.doesNotMatch(running.text, /t-old/);
  console.log('ok  machines resolve by name, id or prefix');
}

// machine_exec: refused in Read only, project resolved, output formatted.
{
  calls = [];
  const refused = await runMachineTool('machine_exec', { machine: 'omarchy', command: 'ls' }, { accessMode: 'read-only' });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /not available in Read only/);
  assert.equal(calls.length, 0);
  const missing = await runMachineTool('machine_exec', { machine: 'omarchy', command: 'ls', project: 'api' }, full);
  assert.match(missing.text, /No project "api" there\. Projects there: futuremail \(p-fm\)/);
  const result = await runMachineTool(
    'machine_exec',
    { machine: 'omarchy', command: 'bun --version', project: 'futuremail', timeout_seconds: 30 },
    full
  );
  assert.equal(result.ok, true);
  assert.deepEqual(calls.at(-1).input.projectId, 'p-fm');
  assert.equal(calls.at(-1).input.timeoutMs, 30_000);
  assert.match(result.text, /On omarchy in \/home\/u\/futuremail: exit code 0 after 0\.0s\.\n--- stdout ---\nhello/);
  console.log('ok  machine_exec');
}

// machine_run_agent: waits for the end event and returns the final reply;
// never more access than the caller; default project is the caller's.
{
  calls = [];
  const result = await runMachineTool(
    'machine_run_agent',
    { machine: 'omarchy', prompt: 'Install bun and report its version.', access_mode: 'full-access', model: 'opus' },
    { accessMode: 'workspace-write', projectPath: '/Users/me/futuremail' }
  );
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /The turn on omarchy finished — thread "Install bun" \(id: t-new\)/);
  assert.match(result.text, /bun 1\.3 installed\./);
  const run = calls.find((call) => call.kind === 'runTurn').input;
  assert.equal(run.accessMode, 'workspace-write', 'capped at the caller');
  assert.equal(run.projectId, 'p-fm');
  assert.equal(run.modelId, 'claude:opus');
  assert.deepEqual(calls.find((call) => call.kind === 'resolveProject').input, {
    machineId: 'm-omarchy',
    projectPath: '/Users/me/futuremail',
  });
  assert.equal(listeners.size, 0, 'the event listener is removed');

  const followUp = await runMachineTool(
    'machine_run_agent',
    { machine: 'omarchy', thread_id: 't-run', prompt: 'Now run the tests.', wait: false },
    full
  );
  assert.equal(followUp.ok, true);
  assert.match(followUp.text, /Started a turn on omarchy in thread t-run/);
  assert.equal(calls.at(-1).input.threadId, 't-run');
  assert.equal(calls.at(-1).input.accessMode, 'full-access');

  const badModel = await runMachineTool('machine_run_agent', { machine: 'omarchy', prompt: 'x', model: 'llama' }, full);
  assert.match(badModel.text, /No available model "llama" there/);

  hostThreads.set('t-slow', {
    id: 't-slow',
    title: 'Slow',
    status: 'done',
    modelId: 'claude:opus',
    createdAt: '2026-11-12T00:00:00Z',
    messages: [],
  });
  const stopped = new AbortController();
  const pending = runMachineTool(
    'machine_run_agent',
    { machine: 'omarchy', thread_id: 't-slow', prompt: 'never ends' },
    { ...full, signal: stopped.signal }
  );
  // This turn never ends; stopping this run stops the wait only.
  setTimeout(() => stopped.abort(), 100);
  const abandoned = await pending;
  assert.equal(abandoned.ok, false);
  assert.match(abandoned.text, /This run was stopped; the turn there keeps running/);
  console.log('ok  machine_run_agent');
}

// A new thread there without a model: the caller's provider when it works
// there, else what that machine ran last; it is the caller thread's subagent.
{
  calls = [];
  const started = await runMachineTool(
    'machine_run_agent',
    { machine: 'omarchy', prompt: 'Diagnose the updater.', project: 'No project', wait: false },
    { ...full, threadId: 'local-driver', providerId: 'codex', modelId: 'codex:gpt-other' }
  );
  assert.equal(started.ok, true, started.text);
  assert.match(started.text, /It shows here as a subagent of this thread/);
  const run = calls.find((call) => call.kind === 'runTurn').input;
  assert.equal(run.modelId, 'codex:gpt', "the caller's provider there");
  assert.deepEqual(run.spawnedBy, { threadId: 'local-driver' });
  assert.equal(remoteThreadSpawner('m-omarchy', 't-new'), 'local-driver');
  assert.equal(remoteThreadSpawner('m-studio', 't-new'), null);

  calls = [];
  await runMachineTool(
    'machine_run_agent',
    { machine: 'omarchy', prompt: 'x', project: 'No project', wait: false },
    { ...full, threadId: 'local-driver', providerId: 'grok', modelId: 'grok:grok-4.7' }
  );
  assert.equal(
    calls.find((call) => call.kind === 'runTurn').input.modelId,
    'claude:opus',
    'a provider not usable there falls back to the model last used there'
  );

  calls = [];
  await runMachineTool('machine_run_agent', { machine: 'omarchy', thread_id: 't-run', prompt: 'more', wait: false }, {
    ...full,
    threadId: 'local-driver',
    providerId: 'codex',
  });
  const followUp = calls.find((call) => call.kind === 'runTurn').input;
  assert.equal(followUp.modelId, undefined, 'a follow-up keeps its thread\'s model');
  assert.equal(followUp.spawnedBy, undefined);

  const models = [
    { id: 'claude:opus', providerId: 'claude', available: true },
    { id: 'claude:sonnet', providerId: 'claude', available: true },
    { id: 'codex:gpt', providerId: 'codex', available: true },
    { id: 'grok:grok-4.7', providerId: 'grok', available: false },
  ];
  const threads = [
    { id: 'a', modelId: 'codex:gpt', updatedAt: '2026-11-10T00:00:00Z', messageCount: 3 },
    { id: 'b', modelId: 'claude:sonnet', updatedAt: '2026-11-09T00:00:00Z', messageCount: 3 },
    { id: 'c', modelId: 'claude:opus', updatedAt: '2026-11-11T00:00:00Z', messageCount: 0 },
    { id: 'd', modelId: 'grok:grok-4.7', updatedAt: '2026-11-12T00:00:00Z', messageCount: 5 },
  ];
  const pick = (caller) => defaultRemoteModel({ models, threads, ...caller })?.id ?? null;
  assert.equal(pick({ callerModelId: 'claude:opus' }), 'claude:opus', 'the same model when it is there');
  assert.equal(pick({ callerModelId: 'claude:fable', callerProviderId: 'claude' }), 'claude:sonnet', "the provider's last used there");
  assert.equal(pick({}), 'codex:gpt', 'no caller: last used there (not drafts, not unusable models)');
  assert.equal(pick({ callerProviderId: 'kimi' }), 'codex:gpt');
  assert.equal(defaultRemoteModel({ models, threads: [], callerProviderId: 'claude' })?.id, 'claude:opus');
  assert.equal(defaultRemoteModel({ models, threads: [] }), null, "nothing to go on: that machine's default");
  console.log('ok  machine_run_agent default model and subagent link');
}

// A follow-up returns its own reply: not an earlier turn with the same text,
// not a later turn already running.
{
  hostThreads.set('t-busy', {
    id: 't-busy',
    title: 'Busy',
    status: 'done',
    modelId: 'claude:opus',
    createdAt: '2026-11-12T00:00:00Z',
    messages: [
      { role: 'user', content: 'Run the tests.' },
      { role: 'agent', content: 'old reply', status: 'done' },
    ],
  });
  const result = await runMachineTool('machine_run_agent', { machine: 'omarchy', thread_id: 't-busy', prompt: 'Run the tests.' }, full);
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /new reply/);
  assert.doesNotMatch(result.text, /old reply|later turn/);
  console.log('ok  a follow-up returns its own reply');
}

// A follow-up waits only when it can tell its reply apart: the thread must be
// readable before it starts.
{
  calls = [];
  const unreadable = await runMachineTool(
    'machine_run_agent',
    { machine: 'omarchy', thread_id: 't-gone', prompt: 'Run the tests.' },
    full
  );
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.text, /Could not read thread t-gone on omarchy/);
  assert.equal(calls.filter((call) => call.kind === 'runTurn').length, 0);
  console.log('ok  a follow-up needs the thread readable first');
}

// Bridge providers (they can't be relied on to ask) need Full access for
// commands and turns; a stopped run sends nothing.
{
  calls = [];
  const bridged = await runMachineTool(
    'machine_exec',
    { machine: 'omarchy', command: 'ls' },
    { accessMode: 'workspace-write', requireFullAccess: true }
  );
  assert.equal(bridged.ok, false);
  assert.match(bridged.text, /needs Full access/);
  assert.equal(
    (await runMachineTool('machine_list', {}, { accessMode: 'workspace-write', requireFullAccess: true })).ok,
    true,
    'reads stay available'
  );
  assert.deepEqual(
    machineMcpToolDefinitions('workspace-write').map((tool) => tool.name),
    ['machine_list', 'machine_threads', 'machine_read_thread']
  );
  const stopped = new AbortController();
  stopped.abort();
  const exec = await runMachineTool('machine_exec', { machine: 'omarchy', command: 'ls' }, { ...full, signal: stopped.signal });
  const agent = await runMachineTool('machine_run_agent', { machine: 'omarchy', prompt: 'x', project: 'futuremail' }, { ...full, signal: stopped.signal });
  assert.equal(exec.ok, false);
  assert.equal(agent.ok, false);
  assert.equal(calls.filter((call) => call.kind === 'exec' || call.kind === 'runTurn').length, 0);
  console.log('ok  Full access for bridge providers; stopped runs send nothing');
}

// machine_read_thread and machine_stop_agent.
{
  const read = await runMachineTool('machine_read_thread', { machine: 'omarchy', thread_id: 't-new' }, { accessMode: 'read-only' });
  assert.equal(read.ok, true);
  assert.match(read.text, /machine: omarchy \(id: m-omarchy\)/);
  assert.doesNotMatch(read.text, /@thread:/, 'no local link for a thread of another machine');
  const stop = await runMachineTool('machine_stop_agent', { machine: 'omarchy', thread_id: 't-run' }, full);
  assert.equal(stop.ok, true);
  console.log('ok  machine_read_thread and machine_stop_agent');
}

// Nothing paired / remote control off.
{
  canControl = false;
  const result = await runMachineTool('machine_list', {}, full);
  assert.equal(result.ok, false);
  canControl = true;
  console.log('ok  tools refuse while no machine can be reached');
}

// The host-side runner itself.
{
  const result = await runExecCommand({ command: 'printf "%s" "$(pwd)"; printf err >&2; exit 4', cwd: os.tmpdir() });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 4);
  assert.equal(result.stderr, 'err');
  const big = await runExecCommand({ command: 'head -c 300000 /dev/zero | tr "\\0" a', maxOutputBytes: 1000 });
  assert.equal(big.stdoutTruncated, true);
  assert.equal(big.stdoutBytes, 300000);
  assert.ok(big.stdout.length < 1100);
  const background = await runExecCommand({ command: 'sleep 30 & echo started', timeoutMs: 20_000 });
  assert.equal(background.stdout.trim(), 'started');
  assert.ok(background.durationMs < 5_000, 'a background process holding stdout does not hold the reply');
  // A character split between the kept head and tail stays whole.
  const split = await runExecCommand({ command: 'printf "%s€" "$(head -c 499 /dev/zero | tr "\\0" a)"', maxOutputBytes: 1000 });
  assert.equal(split.stdoutTruncated, false);
  assert.ok(split.stdout.endsWith('a€'), 'no replacement characters');
  const noFolder = await runExecCommand({ command: 'true', cwd: '/definitely/not/here' });
  assert.equal(noFolder.ok, false);
  console.log('ok  runExecCommand');
}

process.exit(0);
