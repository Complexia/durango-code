import assert from 'node:assert/strict';
import { app } from 'electron';
import { readFile } from 'node:fs/promises';

import {
  CLAUDE_BACKGROUND_CHECK_IN_DEFAULT_S,
  CLAUDE_BACKGROUND_CHECK_IN_MAX_S,
  CLAUDE_SESSION_IDLE_EVICT_MS,
  claudeBackgroundRunSessions,
  claudeSdkSessions,
  createClaudeTurnState,
  discardClaudeBackgroundShellTasks,
  discardableClaudeBackgroundShellTasks,
  endClaudeSession,
  evictIdleClaudeSdkSessions,
  finalizeClaudeTurn,
  handleClaudeSessionMessage,
  pendingClaudeBackgroundTasks,
  runClaudeBackgroundCheckIn,
  setClaudeBackgroundTasksAwaited,
  stopClaudeBackgroundTasks,
  steerClaudeSdkRun,
  updateClaudeBackgroundCheckIn,
} from '../src/main/claude-driver.js';
import {
  codexSteerableRunDrivers,
  createCodexAppServerDriver,
  steerCodexAppServerRun,
} from '../src/main/codex-driver.js';
import { commandForModel } from '../src/main/command-for-model.js';
import { createThreadSteeringCoordinator } from '../src/app/thread-steering.js';

const [appSource, claudeDriverSource] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/main/claude-driver.js', import.meta.url), 'utf8'),
]);

const section = (source, start, end) => {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
};

const steerRenderer = section(
  appSource,
  '  const performSteerWithContent = async (',
  '  // Composer ⚡ / ⌘⏎'
);
const refreshIndex = steerRenderer.indexOf('await refreshLinkedTasksBeforeDispatch(threadId);');
const dispatchIndex = steerRenderer.indexOf('window.orion?.steerAgentTurn?.(');
assert.ok(
  refreshIndex >= 0 && refreshIndex < dispatchIndex,
  'Steering must refresh linked Board tasks before dispatching the live input'
);
for (const requiredContext of [
  'buildLinkedTaskContext(',
  'buildModelMentionsContext(',
  'buildThreadMentionsContext(',
]) {
  assert.match(
    steerRenderer,
    new RegExp(requiredContext.replace('(', '\\(')),
    `Steering must preserve ${requiredContext.slice(0, -1)} dispatch context`
  );
}
assert.match(
  steerRenderer,
  /flushOrionThreadsSave\(\)/,
  'Steering with @thread references must flush the transcript snapshot before exposing thread ids'
);
assert.match(
  steerRenderer,
  /linkedTaskAttachments\(tasksToInject\)[\s\S]*recordSteeredMessage\(threadId, target.runId, prepared\)/,
  'A successful steer must pass prepared Board attachments to transcript recording'
);
assert.match(
  section(appSource, '  const recordSteeredMessage = (', '  const performSteerWithContent = async ('),
  /injected: true[\s\S]*attachments: prepared.turnAttachments/,
  'Transcript recording must retain Board attachments and consume task context once'
);
assert.match(
  steerRenderer,
  /activeRunsByThreadRef\.current\[threadId\] !== target\.runId[\s\S]*window\.orion\?\.steerAgentTurn/,
  'Steering must recheck exact run ownership after async preparation and before IPC dispatch'
);
assert.match(
  steerRenderer,
  /steerAgentTurn[\s\S]*if \(cancelled\(\)\) return;[\s\S]*if \(!injected\)/,
  'A Stop generation must suppress both late IPC success and fallback queueing'
);
const stopThreadTree = section(
  appSource,
  '  const stopThreadTree = async ({',
  '  const stopActiveAgent = async () =>'
);
assert.ok(
  stopThreadTree.indexOf('cancelPendingSteers(threadIds);') >= 0 &&
    stopThreadTree.indexOf('cancelPendingSteers(threadIds);') < stopThreadTree.indexOf('clearActiveRun(runId);'),
  'Stop must invalidate pending steers before clearing active run ownership'
);

const coordinator = createThreadSteeringCoordinator();
const stopGoal = section(appSource, '  const stopTrackedGoalRun = async (', '  // `/goal <objective>');
assert.ok(
  stopGoal.indexOf('cancelPendingSteers([tracked.threadId]);') >= 0 &&
    stopGoal.indexOf('cancelPendingSteers([tracked.threadId]);') < stopGoal.indexOf('clearActiveRun(runId);'),
  'Goal pause/clear must cancel in-flight question replies before releasing the run'
);
const releaseFirst = {};
releaseFirst.promise = new Promise((resolve) => {
  releaseFirst.resolve = resolve;
});
const order = [];
const first = coordinator.enqueue('thread-serial', async (cancelled) => {
  order.push('first:start');
  await releaseFirst.promise;
  order.push(cancelled() ? 'first:cancelled' : 'first:dispatch');
});
const second = coordinator.enqueue('thread-serial', async (cancelled) => {
  order.push('second:start');
  order.push(cancelled() ? 'second:cancelled' : 'second:dispatch');
});
await Promise.resolve();
assert.deepEqual(order, ['first:start'], 'A second steer must wait behind the first thread reservation');
coordinator.cancel(['thread-serial']);
const afterStop = coordinator.enqueue('thread-serial', async (cancelled) => {
  order.push(cancelled() ? 'after-stop:cancelled' : 'after-stop:dispatch');
});
await afterStop;
assert.deepEqual(
  order,
  ['first:start', 'after-stop:dispatch'],
  'A new run generation must not wait behind stale steering work from before Stop'
);
releaseFirst.resolve();
await Promise.all([first, second]);
assert.deepEqual(
  order,
  ['first:start', 'after-stop:dispatch', 'first:cancelled', 'second:start', 'second:cancelled'],
  'Stop must invalidate both an in-flight steer and a steer already queued behind it'
);

const independent = createThreadSteeringCoordinator();
const independentOrder = [];
const left = independent.enqueue('left', async () => independentOrder.push('left'));
const right = independent.enqueue('right', async () => independentOrder.push('right'));
await Promise.all([left, right]);
assert.deepEqual(new Set(independentOrder), new Set(['left', 'right']), 'Steering reservations must be per thread');

const codexModel = {
  id: 'codex:gpt-test',
  providerId: 'codex',
  slug: 'gpt-test',
  label: 'Codex Test',
};
assert.deepEqual(
  commandForModel(codexModel, {
    codexAppServer: true,
    projectPath: '/tmp/project',
    prompt: 'initial direction',
  }),
  ['codex', 'app-server'],
  'Ordinary Codex turns must use app-server so live steering has an input channel'
);
assert.equal(
  commandForModel(codexModel, {
    projectPath: '/tmp/project',
    prompt: 'utility prompt',
  })[1],
  'exec',
  'Hidden Codex utility prompts must remain one-shot exec turns'
);

const codexRequests = [];
const pendingCodexResponses = new Map();
let codexDriver;
const codexChild = {
  stdin: {
    write: (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      codexRequests.push(message);
      if (message.method === 'turn/steer') {
        pendingCodexResponses.set(message.id, message);
        return;
      }
      const result =
        message.method === 'thread/start'
          ? { thread: { id: 'codex-thread' } }
          : message.method === 'turn/start'
            ? { turn: { id: 'codex-turn' } }
            : {};
      queueMicrotask(() => {
        if (message.method === 'thread/start') {
          codexDriver.handleMessage({
            jsonrpc: '2.0',
            method: 'thread/goal/cleared',
            params: { threadId: 'codex-thread' },
          });
          codexDriver.handleMessage({
            jsonrpc: '2.0',
            method: 'thread/goal/updated',
            params: {
              threadId: 'codex-thread',
              goal: { objective: 'old goal', status: 'paused' },
            },
          });
        }
        codexDriver.handleMessage({ jsonrpc: '2.0', id: message.id, result });
        if (message.method === 'turn/start') {
          codexDriver.handleMessage({
            jsonrpc: '2.0',
            method: 'turn/started',
            params: { threadId: 'codex-thread', turn: { id: 'codex-turn' } },
          });
        }
      });
    },
  },
};
let codexRunEnded = 0;
let codexActionsAccepted = 0;
codexDriver = createCodexAppServerDriver({
  child: codexChild,
  cwd: '/tmp/project',
  model: codexModel,
  input: { prompt: 'initial direction' },
  goal: undefined,
  review: undefined,
  resumeSessionId: null,
  accessMode: 'full-access',
  callbacks: {
    onActivity: () => {},
    onActionAccepted: () => {
      codexActionsAccepted += 1;
    },
    onFatal: (error) => assert.fail(error),
    onGoal: () => {},
    onReasoning: () => {},
    onRunEnd: () => {
      codexRunEnded += 1;
    },
    onSessionId: () => {},
    onStats: () => {},
    onText: () => {},
  },
});
await codexDriver.start();
assert.equal(
  codexActionsAccepted,
  1,
  'A successfully started Codex turn must be marked accepted exactly once'
);
assert.equal(
  codexRunEnded,
  0,
  'Stored goal snapshots must not terminate an ordinary Codex turn during resume/start'
);
const codexTurnStart = codexRequests.find((request) => request.method === 'turn/start');
assert.deepEqual(codexTurnStart?.params, {
  threadId: 'codex-thread',
  input: [{ type: 'text', text: 'initial direction' }],
  effort: 'medium',
  serviceTier: 'default',
});

codexSteerableRunDrivers.set('codex-run', codexDriver);
const codexSteer = steerCodexAppServerRun('codex-run', 'change direction');
await Promise.resolve();
const codexSteerRequest = [...pendingCodexResponses.values()][0];
assert.deepEqual(codexSteerRequest?.params, {
  threadId: 'codex-thread',
  expectedTurnId: 'codex-turn',
  input: [{ type: 'text', text: 'change direction' }],
});
codexDriver.handleMessage({
  jsonrpc: '2.0',
  id: codexSteerRequest.id,
  result: { turnId: 'codex-turn' },
});
assert.equal(await codexSteer, true, 'Codex must acknowledge a steer accepted by the active turn');

const racingSteer = codexDriver.steer('too late');
await Promise.resolve();
const racingRequest = [...pendingCodexResponses.values()].at(-1);
codexDriver.handleMessage({
  jsonrpc: '2.0',
  method: 'turn/completed',
  params: { threadId: 'codex-thread', turn: { id: 'codex-turn', status: 'completed' } },
});
codexDriver.handleMessage({
  jsonrpc: '2.0',
  id: racingRequest.id,
  result: { turnId: 'codex-turn' },
});
assert.equal(await racingSteer, false, 'A completed turn must reject a racing stale steer');
assert.equal(codexRunEnded, 1, 'An ordinary Codex turn must end after turn/completed');
await codexDriver.dispose();
assert.equal(
  codexRequests.some((request) => request.method === 'turn/interrupt'),
  false,
  'Disposing after a completed turn must not interrupt anything'
);
codexSteerableRunDrivers.clear();

// A stopped run's turn outlives its connection on the shared app-server, and
// app-server folds the next turn/start into that busy turn: the response
// carries the existing turn id and no turn/started notification follows.
const createFoldedTurnDriver = ({ answerTurnStart = true, answerThreadRead = true } = {}) => {
  const requests = [];
  const deferred = new Map();
  let driver;
  const child = {
    stdin: {
      write: (line) => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        requests.push(message);
        const result =
          message.method === 'thread/resume'
            ? { thread: { id: 'busy-thread' } }
            : message.method === 'turn/start'
              ? { turn: { id: 'busy-turn', status: 'inProgress' } }
              : message.method === 'thread/read'
                ? { thread: { id: 'busy-thread', turns: [{ id: 'busy-turn', status: 'inProgress' }] } }
              : message.method === 'turn/steer'
                ? { turnId: message.params.expectedTurnId }
                : {};
        const respond = () => driver.handleMessage({ jsonrpc: '2.0', id: message.id, result });
        if (
          (message.method === 'turn/start' && !answerTurnStart) ||
          (message.method === 'thread/read' && !answerThreadRead)
        ) deferred.set(message.id, respond);
        else queueMicrotask(respond);
      },
    },
  };
  driver = createCodexAppServerDriver({
    child,
    cwd: '/tmp/project',
    model: codexModel,
    input: { prompt: 'follow-up after stop' },
    goal: undefined,
    review: undefined,
    resumeSessionId: 'busy-thread',
    accessMode: 'full-access',
    callbacks: {
      onActivity: () => {},
      onFatal: (error) => assert.fail(error),
      onGoal: () => {},
      onReasoning: () => {},
      onRunEnd: () => {},
      onSessionId: () => {},
      onStats: () => {},
      onText: () => {},
    },
  });
  return { driver, requests, deferred };
};

const folded = createFoldedTurnDriver();
await folded.driver.start();
codexSteerableRunDrivers.set('folded-run', folded.driver);
assert.equal(
  await steerCodexAppServerRun('folded-run', 'steer the folded turn'),
  true,
  'A turn adopted from the turn/start response must accept steering'
);
assert.equal(
  folded.requests.find((request) => request.method === 'turn/steer')?.params.expectedTurnId,
  'busy-turn'
);
await folded.driver.dispose();
assert.deepEqual(
  folded.requests.find((request) => request.method === 'turn/interrupt')?.params,
  { threadId: 'busy-thread', turnId: 'busy-turn' },
  'Stop must interrupt the live Codex turn instead of leaving it running server-side'
);
codexSteerableRunDrivers.clear();

const stopDuringStart = createFoldedTurnDriver({ answerTurnStart: false });
const stopDuringStartRun = stopDuringStart.driver.start();
while (!stopDuringStart.requests.some((request) => request.method === 'turn/start')) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
const stopDuringStartDispose = stopDuringStart.driver.dispose();
for (const respond of stopDuringStart.deferred.values()) respond();
await stopDuringStartDispose;
await stopDuringStartRun;
assert.deepEqual(
  stopDuringStart.requests.find((request) => request.method === 'turn/interrupt')?.params,
  { threadId: 'busy-thread', turnId: 'busy-turn' },
  'Stop during turn/start must interrupt the turn once its id is known'
);

const stopWithoutStartResponse = createFoldedTurnDriver({ answerTurnStart: false });
const unansweredStart = stopWithoutStartResponse.driver.start();
while (!stopWithoutStartResponse.requests.some((request) => request.method === 'turn/start')) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
await stopWithoutStartResponse.driver.dispose();
await unansweredStart;
assert.deepEqual(
  stopWithoutStartResponse.requests.find((request) => request.method === 'turn/interrupt')?.params,
  { threadId: 'busy-thread', turnId: 'busy-turn' },
  'Stop must discover and interrupt the running turn even when turn/start never responds'
);
for (const respond of stopWithoutStartResponse.deferred.values()) respond();
assert.equal(await stopWithoutStartResponse.driver.steer('late steer'), false);

const completionDuringLookup = createFoldedTurnDriver({ answerTurnStart: false, answerThreadRead: false });
const completingStart = completionDuringLookup.driver.start();
while (!completionDuringLookup.requests.some((request) => request.method === 'turn/start')) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
const completingDispose = completionDuringLookup.driver.dispose();
while (!completionDuringLookup.requests.some((request) => request.method === 'thread/read')) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
completionDuringLookup.driver.handleMessage({
  method: 'turn/completed',
  params: { threadId: 'busy-thread', turn: { id: 'busy-turn', status: 'completed' } },
});
for (const respond of completionDuringLookup.deferred.values()) respond();
await completingDispose;
await completingStart;
assert.equal(
  completionDuringLookup.requests.some((request) => request.method === 'turn/interrupt'),
  false,
  'A stale thread/read snapshot must not resurrect a turn that completed during Stop'
);

const unresponsiveStop = createFoldedTurnDriver({ answerTurnStart: false, answerThreadRead: false });
const unresponsiveStart = unresponsiveStop.driver.start();
while (!unresponsiveStop.requests.some((request) => request.method === 'turn/start')) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
let disposalDeadline;
try {
  await Promise.race([
    unresponsiveStop.driver.dispose(),
    new Promise((_, reject) => {
      disposalDeadline = setTimeout(() => reject(new Error('Stop hung on the turn lookup')), 5000);
    }),
  ]);
} finally {
  clearTimeout(disposalDeadline);
}
await unresponsiveStart;
assert.equal(
  unresponsiveStop.requests.some((request) => request.method === 'thread/read'),
  true,
  'Stop must attempt the bounded turn lookup before closing an unresponsive connection'
);
for (const respond of unresponsiveStop.deferred.values()) respond();
assert.equal(await unresponsiveStop.driver.steer('late steer'), false);

const createSession = ({ threadId, runId, retained = false }) => {
  const events = [];
  const pushed = [];
  const stoppedTasks = [];
  let interruptCount = 0;
  let resolveEnded;
  const endedPromise = new Promise((resolve) => {
    resolveEnded = resolve;
  });
  const session = {
    threadId,
    activeTurns: retained ? [] : [createClaudeTurnState(runId, { baseline: runId })],
    backgroundRunId: retained ? runId : null,
    backgroundSettleTimer: retained ? setTimeout(() => {}, 60_000) : null,
    backgroundTasks: new Map(),
    skipTranscriptTaskIds: new Set(),
    pendingTaskNotifications: [],
    tasks: new Map(),
    pendingTaskToolUses: new Map(),
    taskToolUseIds: new Set(),
    pendingSteerBoundary: null,
    lastTurnEndSnapshot: { baseline: 'background' },
    resultsOwed: 1,
    ended: false,
    disposed: false,
    endedPromise,
    resolveEnded,
    stderrTail: '',
    query: {
      interrupt: async () => {
        interruptCount += 1;
        const interrupted = session.activeTurns[0];
        queueMicrotask(async () => {
          session.resultsOwed = Math.max(0, session.resultsOwed - 1);
          await finalizeClaudeTurn(session, { subtype: 'interrupted', is_error: true });
        });
        return interrupted ? { still_queued: [] } : undefined;
      },
      stopTask: async (taskId) => {
        stoppedTasks.push(taskId);
        session.backgroundTasks.delete(taskId);
      },
    },
    sender: {
      isDestroyed: () => false,
      send: (_channel, event) => events.push(event),
    },
    pushUserMessage: (text, { expectResult = true } = {}) => {
      if (expectResult) session.resultsOwed += 1;
      pushed.push(text);
    },
  };
  session.dispose = () => {
    if (session.disposed) return;
    session.disposed = true;
    endClaudeSession(session, null);
  };
  return {
    session,
    events,
    pushed,
    stoppedTasks,
    get interruptCount() { return interruptCount; },
  };
};

claudeSdkSessions.clear();
claudeBackgroundRunSessions.clear();

const active = createSession({ threadId: 'thread-active', runId: 'run-active' });
claudeSdkSessions.set(active.session.threadId, active.session);
assert.equal(await steerClaudeSdkRun('run-active', 'change direction'), true);
assert.equal(active.interruptCount, 1, 'An active steer must interrupt a blocking Claude loop');
assert.equal(active.session.activeTurns.length, 1, 'An active steer must replace the interrupted owner');
assert.equal(active.session.resultsOwed, 1, 'The continuation must own exactly one SDK result');
assert.deepEqual(active.pushed, ['change direction']);
assert.equal(active.session.backgroundSettleTimer, null, 'A live steer must disarm background settlement');
assert.equal(active.events.length, 0, 'The interrupted transport boundary must not settle the visible run');
active.session.resultsOwed -= 1;
await finalizeClaudeTurn(active.session, {
  usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
});
assert.equal(active.session.activeTurns.length, 0, 'The continuation result must settle the visible run');
assert.equal(active.session.resultsOwed, 0, 'The continuation result must clear all result debt');
assert.equal(active.events.length, 1, 'The continuation result must emit a terminal event');
assert.equal(active.events[0]?.type, 'done');
assert.deepEqual(active.events[0]?.stats, {
  totalTokens: 16,
  inputTokens: 12,
  outputTokens: 4,
  cachedReadTokens: 2,
});

const failedInterrupt = createSession({
  threadId: 'thread-interrupt-failed',
  runId: 'run-interrupt-failed',
});
failedInterrupt.session.query.interrupt = async () => {
  throw new Error('control channel unavailable');
};
claudeSdkSessions.set(failedInterrupt.session.threadId, failedInterrupt.session);
assert.equal(await steerClaudeSdkRun('run-interrupt-failed', 'preserve me'), false);
assert.equal(
  failedInterrupt.session.pendingSteerBoundary,
  null,
  'A failed interrupt must restore ordinary terminal handling'
);
assert.equal(failedInterrupt.session.activeTurns.length, 1, 'A failed interrupt must retain its owner');
assert.deepEqual(failedInterrupt.pushed, [], 'A failed interrupt must leave the prompt for renderer fallback');

const releasedBeforeControlFailure = createSession({
  threadId: 'thread-released-before-control-failure',
  runId: 'run-released-before-control-failure',
});
releasedBeforeControlFailure.session.query.interrupt = async () => {
  releasedBeforeControlFailure.session.resultsOwed = 0;
  await finalizeClaudeTurn(releasedBeforeControlFailure.session, {
    subtype: 'interrupted',
    is_error: true,
  });
  throw new Error('late control failure');
};
claudeSdkSessions.set(
  releasedBeforeControlFailure.session.threadId,
  releasedBeforeControlFailure.session
);
assert.equal(
  await steerClaudeSdkRun('run-released-before-control-failure', 'continue anyway'),
  true,
  'A released hidden boundary must continue even if the control request reports a late failure'
);
assert.equal(releasedBeforeControlFailure.session.activeTurns.length, 1);
assert.equal(releasedBeforeControlFailure.session.resultsOwed, 1);
assert.deepEqual(releasedBeforeControlFailure.pushed, ['continue anyway']);

const lostHandoff = createSession({
  threadId: 'thread-lost-handoff',
  runId: 'run-lost-handoff',
});
const lostOwner = lostHandoff.session.activeTurns.shift();
lostHandoff.session.pendingSteerBoundary = lostOwner;
lostHandoff.session.stderrTail = '';
claudeSdkSessions.set(lostHandoff.session.threadId, lostHandoff.session);
endClaudeSession(lostHandoff.session, new Error('session exited after interrupt'));
assert.ok(
  lostHandoff.events.some(
    (event) => event.runId === 'run-lost-handoff' && event.type === 'error'
  ),
  'A session lost after the hidden boundary must still settle the visible run'
);

const retained = createSession({
  threadId: 'thread-retained',
  runId: 'run-retained',
  retained: true,
});
retained.session.resultsOwed = 0;
claudeSdkSessions.set(retained.session.threadId, retained.session);
claudeBackgroundRunSessions.set('run-retained', retained.session);
assert.equal(await steerClaudeSdkRun('run-retained', 'follow up'), true);
assert.equal(retained.session.backgroundRunId, null, 'Steering must consume the retained background handle');
assert.equal(
  claudeBackgroundRunSessions.has('run-retained'),
  false,
  'A retained handle must not settle independently after steering starts'
);
assert.equal(retained.session.backgroundSettleTimer, null, 'Retained-run steering must cancel its armed timer');
assert.equal(retained.session.activeTurns.length, 1, 'Retained-run steering must reserve a real active turn');
assert.equal(retained.session.resultsOwed, 1);
assert.equal(retained.events[0]?.type, 'started', 'The renderer must receive an owner for retained-run output');
assert.equal(retained.events[0]?.runId, 'run-retained');

// Subagent frames are forwarded on the main stream with parent_tool_use_id.
// A background subagent acting while the main loop is idle must not open a
// synthetic turn: no `result` would ever settle it, and steering would then
// interrupt the CLI (killing the subagent) and fall back to a queue that
// never drains.
const subagentToolUse = (name, input) => ({
  type: 'assistant',
  parent_tool_use_id: 'toolu_agent',
  message: { content: [{ type: 'tool_use', id: `toolu_${name}`, name, input }] },
});
const idleSubagent = createSession({
  threadId: 'thread-idle-subagent',
  runId: 'run-idle-subagent',
  retained: true,
});
idleSubagent.session.resultsOwed = 0;
idleSubagent.session.sessionId = 'sdk-session-idle-subagent';
claudeSdkSessions.set(idleSubagent.session.threadId, idleSubagent.session);
claudeBackgroundRunSessions.set('run-idle-subagent', idleSubagent.session);
await handleClaudeSessionMessage(idleSubagent.session, subagentToolUse('Bash', { command: 'date' }));
await handleClaudeSessionMessage(idleSubagent.session, {
  type: 'user',
  parent_tool_use_id: 'toolu_agent',
  message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_Bash', content: 'ok' }] },
});
assert.equal(idleSubagent.session.activeTurns.length, 0, 'Subagent output must not open a main turn');
assert.equal(idleSubagent.session.resultsOwed, 0, 'Subagent output must not create result debt');
assert.equal(idleSubagent.events.length, 0, 'Subagent output must not start a visible main run');
idleSubagent.session.tasks.set('shared-task', { subject: 'Shared work', status: 'in_progress' });
await handleClaudeSessionMessage(idleSubagent.session, subagentToolUse('TaskUpdate', {
  taskId: 'shared-task', status: 'completed',
}));
await handleClaudeSessionMessage(idleSubagent.session, {
  type: 'user',
  parent_tool_use_id: 'toolu_agent',
  tool_use_result: { statusChange: { to: 'completed' } },
  message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_TaskUpdate', content: 'ok' }] },
});
assert.equal(idleSubagent.session.tasks.get('shared-task').status, 'completed');
assert.equal(idleSubagent.session.activeTurns.length, 0, 'Idle checklist updates must not open a turn');
assert.equal(idleSubagent.session.resultsOwed, 0, 'Idle checklist updates must not create result debt');
assert.equal(idleSubagent.events.length, 1, 'Only the checklist update should be emitted');
assert.equal(idleSubagent.events[0].type, 'activity');
assert.equal(idleSubagent.events[0].activity.type, 'plan');
assert.equal(idleSubagent.events[0].runId, 'run-idle-subagent');
assert.equal(await steerClaudeSdkRun('run-idle-subagent', 'check on it'), true);
assert.equal(idleSubagent.interruptCount, 0, 'Steering an idle main loop must not interrupt background work');
assert.deepEqual(idleSubagent.pushed, ['check on it']);

const liveSubagent = createSession({ threadId: 'thread-live-subagent', runId: 'run-live-subagent' });
liveSubagent.session.sessionId = 'sdk-session-live-subagent';
const subagentWrite = '/tmp/orion-steering-subagent-write.txt';
await handleClaudeSessionMessage(
  liveSubagent.session,
  subagentToolUse('Write', { file_path: subagentWrite, content: 'x' })
);
assert.equal(liveSubagent.events.length, 0, 'Subagent tool rows must not duplicate into the main turn');
assert.ok(
  liveSubagent.session.activeTurns[0].toolWrittenPaths.has(subagentWrite),
  'Subagent writes must still count toward the live turn\'s changed files'
);

// A task created by the parent can be completed by a foreground subagent.
await handleClaudeSessionMessage(liveSubagent.session, {
  ...subagentToolUse('TaskCreate', { subject: 'Implement feature' }),
  parent_tool_use_id: null,
});
await handleClaudeSessionMessage(liveSubagent.session, {
  type: 'user',
  parent_tool_use_id: null,
  tool_use_result: { task: { id: 'feature' } },
  message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_TaskCreate', content: 'ok' }] },
});
liveSubagent.events.length = 0;
await handleClaudeSessionMessage(liveSubagent.session, subagentToolUse('TaskUpdate', {
  taskId: 'feature', status: 'completed',
}));
assert.equal(liveSubagent.session.tasks.get('feature').status, 'pending', 'Wait for the successful tool result');
await handleClaudeSessionMessage(liveSubagent.session, {
  type: 'user',
  parent_tool_use_id: 'toolu_agent',
  tool_use_result: { statusChange: { to: 'completed' } },
  message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_TaskUpdate', content: 'ok' }] },
});
assert.equal(liveSubagent.session.tasks.get('feature').status, 'completed');
assert.equal(liveSubagent.session.pendingTaskToolUses.size, 0, 'The result must consume its pending task update');
assert.equal(liveSubagent.session.activeTurns.length, 1, 'Checklist updates must keep the existing turn');
assert.equal(liveSubagent.session.resultsOwed, 1, 'Checklist updates must not create result debt');
assert.equal(liveSubagent.events.length, 1, 'Only the checklist update should be emitted');
assert.equal(liveSubagent.events[0].type, 'activity');
assert.equal(liveSubagent.events[0].runId, 'run-live-subagent');
assert.equal(liveSubagent.events[0].activity.type, 'plan');
assert.deepEqual(liveSubagent.events[0].activity.plan, [{ content: 'Implement feature', status: 'completed' }]);

const shellOnly = createSession({
  threadId: 'thread-shell-only',
  runId: 'run-shell-only',
  retained: true,
});
shellOnly.session.resultsOwed = 0;
shellOnly.session.backgroundTasks = new Map([
  ['bash-1', { taskType: 'local_bash', description: '20 minute idle wait' }],
  ['bash-2', { taskType: 'local_bash', description: 'monitor controls.mjs' }],
]);
claudeSdkSessions.set(shellOnly.session.threadId, shellOnly.session);
claudeBackgroundRunSessions.set('run-shell-only', shellOnly.session);
assert.deepEqual(
  pendingClaudeBackgroundTasks(shellOnly.session),
  [],
  'Claude Code background shells are monitors and must not pin the completed turn'
);
assert.deepEqual(
  discardableClaudeBackgroundShellTasks(shellOnly.session).map((task) => task.taskId),
  ['bash-1', 'bash-2'],
  'A completed Claude turn may offer an intervention when every live task is local_bash'
);
assert.equal((await discardClaudeBackgroundShellTasks('run-shell-only')).ok, true);
assert.deepEqual(shellOnly.stoppedTasks, ['bash-1', 'bash-2']);
assert.equal(shellOnly.session.ended, true, 'Discarding shell-only work must settle the Claude runtime');

const monitoredTurn = createSession({
  threadId: 'thread-monitored-turn',
  runId: 'run-monitored-turn',
});
monitoredTurn.session.resultsOwed = 0;
monitoredTurn.session.backgroundTasks = new Map([
  ['bash-monitor', { taskType: 'local_bash', description: 'watch the dev server' }],
]);
claudeSdkSessions.set(monitoredTurn.session.threadId, monitoredTurn.session);
await finalizeClaudeTurn(monitoredTurn.session, { usage: { input_tokens: 2, output_tokens: 1 } });
assert.equal(monitoredTurn.events[0]?.type, 'done');
assert.deepEqual(monitoredTurn.events[0]?.pendingBackgroundTasks, undefined);
assert.deepEqual(monitoredTurn.events[0]?.pendingBackgroundShellTasks, ['watch the dev server']);
assert.equal(
  claudeBackgroundRunSessions.get('run-monitored-turn'),
  monitoredTurn.session,
  'A completed monitored turn must retain a handle for the explicit stop action'
);

const awaitedShell = createSession({
  threadId: 'thread-awaited-shell',
  runId: 'run-awaited-shell',
});
awaitedShell.session.resultsOwed = 0;
awaitedShell.session.backgroundTasks = new Map([
  ['bash-release', { taskType: 'local_bash', description: 'desktop release: signing, notarization' }],
  ['bash-dev', { taskType: 'local_bash', description: 'dev server' }],
]);
assert.deepEqual(
  setClaudeBackgroundTasksAwaited(awaitedShell.session, ['bash-release', 'bash-typo']),
  { matched: ['bash-release'], unmatched: ['bash-typo'] },
  'Only live background tasks can be awaited'
);
assert.deepEqual(pendingClaudeBackgroundTasks(awaitedShell.session), ['desktop release: signing, notarization']);
assert.deepEqual(
  discardableClaudeBackgroundShellTasks(awaitedShell.session),
  [],
  'An awaited shell is work the model rejoins, not a disposable monitor'
);
claudeSdkSessions.set(awaitedShell.session.threadId, awaitedShell.session);
await finalizeClaudeTurn(awaitedShell.session, { usage: { input_tokens: 2, output_tokens: 1 } });
assert.equal(awaitedShell.events[0]?.type, 'done');
assert.deepEqual(
  awaitedShell.events[0]?.pendingBackgroundTasks,
  ['desktop release: signing, notarization'],
  'A turn that ends while an awaited shell runs must keep the thread working'
);
assert.equal(awaitedShell.events[0]?.pendingBackgroundShellTasks, undefined);
const sessionsBeforeEviction = [...claudeSdkSessions];
claudeSdkSessions.clear();
claudeSdkSessions.set(awaitedShell.session.threadId, awaitedShell.session);
evictIdleClaudeSdkSessions(Date.now() + CLAUDE_SESSION_IDLE_EVICT_MS + 1);
assert.equal(awaitedShell.session.ended, false, 'An awaited shell keeps its Claude runtime alive');
for (const [threadId, session] of sessionsBeforeEviction) claudeSdkSessions.set(threadId, session);
await handleClaudeSessionMessage(awaitedShell.session, {
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: [{ task_id: 'bash-dev', task_type: 'local_bash', description: 'dev server' }],
});
assert.equal(
  awaitedShell.session.awaitedBackgroundTaskIds.has('bash-release'),
  false,
  'A finished awaited shell is forgotten'
);
assert.deepEqual(pendingClaudeBackgroundTasks(awaitedShell.session), []);
assert.deepEqual(
  setClaudeBackgroundTasksAwaited(awaitedShell.session, ['bash-dev']),
  { matched: ['bash-dev'], unmatched: [] }
);
setClaudeBackgroundTasksAwaited(awaitedShell.session, ['bash-dev'], false);
assert.deepEqual(pendingClaudeBackgroundTasks(awaitedShell.session), [], 'waiting: false releases the hold');
if (awaitedShell.session.backgroundSettleTimer) clearTimeout(awaitedShell.session.backgroundSettleTimer);
claudeSdkSessions.delete(awaitedShell.session.threadId);

// A shell can outlive its work (npm publish fed by `(sleep 4; printf '\n';
// sleep 840) | script …` kept the thread waiting 14 minutes after npm exited).
// While the model idles on an awaited shell, Durango Code re-invokes it to
// check on the shell, backing off between check-ins.
const checkIn = createSession({
  threadId: 'thread-check-in',
  runId: 'run-check-in',
  retained: true,
});
clearTimeout(checkIn.session.backgroundSettleTimer);
checkIn.session.backgroundSettleTimer = null;
checkIn.session.resultsOwed = 0;
checkIn.session.awaitedBackgroundTaskIds = new Set();
checkIn.session.backgroundTasks = new Map([
  ['bash-publish', { taskType: 'local_bash', description: 'Publish to npm in a pty' }],
]);
claudeSdkSessions.set(checkIn.session.threadId, checkIn.session);
claudeBackgroundRunSessions.set('run-check-in', checkIn.session);
setClaudeBackgroundTasksAwaited(checkIn.session, ['bash-publish']);
updateClaudeBackgroundCheckIn(checkIn.session);
assert.equal(
  checkIn.session.backgroundCheckIn?.delayMs,
  CLAUDE_BACKGROUND_CHECK_IN_DEFAULT_S * 1000,
  'Waiting on a shell arms a default check-in'
);
const firstCheckInTimer = checkIn.session.backgroundCheckIn.timer;
updateClaudeBackgroundCheckIn(checkIn.session);
assert.equal(
  checkIn.session.backgroundCheckIn.timer,
  firstCheckInTimer,
  'A repeated wait without check_in_seconds keeps the armed schedule'
);
updateClaudeBackgroundCheckIn(checkIn.session, 60_000);
assert.equal(checkIn.session.backgroundCheckIn.delayMs, 60_000, 'check_in_seconds re-arms the check-in');

runClaudeBackgroundCheckIn(checkIn.session);
assert.equal(checkIn.pushed.length, 1, 'An idle thread is re-invoked to check on the shell');
assert.match(checkIn.pushed[0], /\[Durango Code check-in\]/);
assert.match(checkIn.pushed[0], /bash-publish: Publish to npm in a pty/);
assert.match(checkIn.pushed[0], /next check-in is in 2m/);
assert.equal(checkIn.session.activeTurns.length, 1, 'The check-in owns a real turn');
assert.equal(checkIn.session.resultsOwed, 1);
assert.equal(checkIn.events[0]?.type, 'started');
assert.equal(checkIn.events[0]?.runId, 'run-check-in', 'The check-in continues the retained run');
assert.equal(checkIn.session.backgroundCheckIn.delayMs, 120_000, 'Check-ins back off');

// Busy: the model sees its tasks itself, so only reschedule.
runClaudeBackgroundCheckIn(checkIn.session);
assert.equal(checkIn.pushed.length, 1, 'A busy thread is not interrupted by a check-in');
assert.equal(checkIn.session.backgroundCheckIn.delayMs, 240_000);
updateClaudeBackgroundCheckIn(checkIn.session, CLAUDE_BACKGROUND_CHECK_IN_MAX_S * 1000);
runClaudeBackgroundCheckIn(checkIn.session);
assert.equal(
  checkIn.session.backgroundCheckIn.delayMs,
  CLAUDE_BACKGROUND_CHECK_IN_MAX_S * 1000,
  'Backoff is capped'
);

await handleClaudeSessionMessage(checkIn.session, {
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: [],
});
assert.equal(checkIn.session.backgroundCheckIn, null, 'A finished shell disarms its check-in');
checkIn.session.activeTurns.splice(0);
if (checkIn.session.backgroundSettleTimer) clearTimeout(checkIn.session.backgroundSettleTimer);
claudeSdkSessions.delete(checkIn.session.threadId);
claudeBackgroundRunSessions.delete('run-check-in');

assert.match(
  claudeDriverSource,
  /preset: 'claude_code',\s*append: \[CLAUDE_BACKGROUND_WAIT_TIP/,
  'Every Claude SDK session learns when to call wait_for_background_tasks'
);

const nativeStops = [];
await stopClaudeBackgroundTasks(
  {
    query: {
      stopTask: async (taskId) => nativeStops.push(taskId),
    },
  },
  [
    { taskId: 'agent-live', description: 'Agent' },
    { taskId: 'shell-live', description: 'Monitor' },
  ],
  10
);
assert.deepEqual(
  nativeStops,
  ['agent-live', 'shell-live'],
  'Stop-everything must use the SDK stopTask control for every exact live task'
);

const mixedBackground = createSession({
  threadId: 'thread-mixed-background',
  runId: 'run-mixed-background',
  retained: true,
});
mixedBackground.session.resultsOwed = 0;
mixedBackground.session.backgroundTasks = new Map([
  ['bash-3', { taskType: 'local_bash', description: 'idle wait' }],
  ['agent-1', { taskType: 'agent', description: 'useful implementation subagent' }],
]);
claudeSdkSessions.set(mixedBackground.session.threadId, mixedBackground.session);
claudeBackgroundRunSessions.set('run-mixed-background', mixedBackground.session);
assert.deepEqual(discardableClaudeBackgroundShellTasks(mixedBackground.session), []);
const mixedDiscard = await discardClaudeBackgroundShellTasks('run-mixed-background');
assert.equal(mixedDiscard.ok, false, 'The shell discard must refuse mixed useful background work');
assert.deepEqual(mixedBackground.stoppedTasks, []);

claudeSdkSessions.clear();
claudeBackgroundRunSessions.clear();
const expiredMonitor = createSession({
  threadId: 'thread-expired-monitor',
  runId: 'run-expired-monitor',
  retained: true,
});
expiredMonitor.session.resultsOwed = 0;
expiredMonitor.session.lastActivityAt = 0;
expiredMonitor.session.backgroundTasks = new Map([
  ['bash-expired', { taskType: 'local_bash', description: 'forgotten dev server' }],
]);
claudeSdkSessions.set(expiredMonitor.session.threadId, expiredMonitor.session);
claudeBackgroundRunSessions.set('run-expired-monitor', expiredMonitor.session);
evictIdleClaudeSdkSessions(CLAUDE_SESSION_IDLE_EVICT_MS + 1);
assert.equal(
  expiredMonitor.session.ended,
  true,
  'An idle shell-only Claude runtime must be reaped instead of surviving indefinitely'
);

assert.match(
  claudeDriverSource,
  /if \(activeOwner\) \{[\s\S]*session\.query\.interrupt\(\)[\s\S]*createClaudeTurnState\(runId[\s\S]*session\.pushUserMessage\(text, \{ content \}\)[\s\S]*return true;/,
  'An active steer must interrupt the blocked loop before pushing its continuation'
);
assert.match(
  claudeDriverSource,
  /perTaskStopAffordance: true/,
  'Claude sessions must declare per-task stop so a steer interrupt spares background agents'
);

for (const { session } of [active, retained, idleSubagent, liveSubagent, monitoredTurn, mixedBackground, expiredMonitor]) {
  if (session.backgroundSettleTimer) clearTimeout(session.backgroundSettleTimer);
}
claudeSdkSessions.clear();
claudeBackgroundRunSessions.clear();

console.log('Steering context and lifecycle checks passed.');

app.quit();
