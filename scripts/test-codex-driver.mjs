import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { app } from 'electron';

import {
  codexAppServerConfig,
  codexAppServerActivityFromItem,
  codexUserInput,
  codexErrorDetail,
  codexStatsFromTokenUsage,
  createCodexAppServerDriver,
  isRecoverableCodexContextError,
} from '../src/main/codex-driver.js';
import { commandForModel } from '../src/main/command-for-model.js';
import { createCompletedCodexQuestions } from '../src/main/codex-questions.js';

const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
assert.match(
  mainSource,
  /onSessionId: \(sessionId\) => \{\s*acceptedCodexSessionId = sessionId;\s*ensureCodexSpawnWatcher\(sessionId\);/,
  'fresh Codex app-server threads must start their filesystem spawn watcher from onSessionId'
);

const model = {
  id: 'codex:gpt-test',
  providerId: 'codex',
  slug: 'gpt-test',
  label: 'Codex Test',
};

assert.deepEqual(
  codexStatsFromTokenUsage(
    {
      total: { totalTokens: 900, inputTokens: 800, outputTokens: 100 },
      last: { inputTokens: 620 },
      modelContextWindow: 1_000,
    },
    model.id
  ),
  {
    modelId: model.id,
    totalTokens: 900,
    inputTokens: 800,
    outputTokens: 100,
    contextTokens: 620,
    contextWindow: 1_000,
  },
  'Codex token updates must expose current context fill separately from cumulative usage'
);
assert.equal(
  codexErrorDetail({
    message: 'response stream disconnected',
    codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
  }),
  'response stream disconnected · response stream disconnected (HTTP 502)',
  'Codex retry details must preserve the structured transport classification'
);
assert.equal(
  isRecoverableCodexContextError({
    codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 504 } },
  }),
  true
);
assert.equal(
  isRecoverableCodexContextError({ codexErrorInfo: { unauthorized: null } }),
  false
);

const requests = [];
const activities = [];
const statsEvents = [];
const subagentEvents = [];
let runEnded = 0;
let driver;
const child = {
  stdin: {
    write: (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      requests.push(message);
      const result =
        message.method === 'thread/resume'
          ? { thread: { id: 'native-thread' } }
          : message.method === 'turn/start'
            ? { turn: { id: 'user-turn' } }
            : {};
      queueMicrotask(() => {
        driver.handleMessage({ jsonrpc: '2.0', id: message.id, result });
        if (message.method === 'turn/start') {
          driver.handleMessage({
            jsonrpc: '2.0',
            method: 'turn/started',
            params: { threadId: 'native-thread', turn: { id: 'user-turn' } },
          });
        }
      });
    },
  },
};

driver = createCodexAppServerDriver({
  child,
  cwd: '/tmp/project',
  model,
  input: { prompt: 'continue the long-running thread' },
  goal: undefined,
  review: undefined,
  resumeSessionId: 'native-thread',
  accessMode: 'full-access',
  callbacks: {
    onActivity: (activity) => activities.push(activity),
    onActionAccepted: () => {},
    onFatal: (error) => assert.fail(error),
    onGoal: () => {},
    onReasoning: () => {},
    onRunEnd: () => {
      runEnded += 1;
    },
    onSessionId: () => {},
    onStats: (stats) => statsEvents.push(stats),
    onSubagent: (subagent) => subagentEvents.push(subagent),
    onText: () => {},
  },
});

await driver.start();
assert.deepEqual(
  requests.map((request) => request.method),
  ['initialize', 'thread/resume', 'turn/start'],
  'Orion must delegate the initial compaction decision to turn/start'
);
driver.handleMessage({
  jsonrpc: '2.0',
  method: 'item/started',
  params: {
    threadId: 'native-thread',
    turnId: 'user-turn',
    item: {
      id: 'spawn-1',
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      prompt: 'Implement the durable ledger contract.',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      receiverThreadIds: [],
      senderThreadId: 'native-thread',
      agentsStates: {},
      status: 'inProgress',
    },
  },
});
driver.handleMessage({
  jsonrpc: '2.0',
  method: 'item/completed',
  params: {
    threadId: 'native-thread',
    turnId: 'user-turn',
    item: {
      id: 'spawn-1',
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      prompt: null,
      model: null,
      reasoningEffort: null,
      receiverThreadIds: ['child-thread'],
      senderThreadId: 'native-thread',
      agentsStates: {},
      status: 'completed',
    },
  },
});
assert.deepEqual(subagentEvents, [
  {
    id: 'child-thread',
    prompt: 'Implement the durable ledger contract.',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'low',
  },
]);
driver.handleMessage({
  jsonrpc: '2.0',
  method: 'item/completed',
  params: {
    threadId: 'child-thread',
    turnId: 'child-turn',
    item: {
      id: 'spawn-2',
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      prompt: 'Implement the Convex transaction layer.',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      receiverThreadIds: ['grandchild-thread'],
      senderThreadId: 'child-thread',
      agentsStates: {},
      status: 'completed',
    },
  },
});
driver.handleMessage({
  jsonrpc: '2.0',
  method: 'item/completed',
  params: {
    threadId: 'unrelated-thread',
    turnId: 'unrelated-turn',
    item: {
      id: 'spawn-other',
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      prompt: 'This belongs to another run.',
      receiverThreadIds: ['unrelated-child'],
      senderThreadId: 'unrelated-thread',
      agentsStates: {},
      status: 'completed',
    },
  },
});
assert.deepEqual(subagentEvents.at(-1), {
  id: 'grandchild-thread',
  prompt: 'Implement the Convex transaction layer.',
  model: 'gpt-5.6-luna',
  reasoningEffort: 'low',
});
assert.equal(
  subagentEvents.some((event) => event.id === 'unrelated-child'),
  false,
  'persistent app-server notifications from another run must remain isolated'
);

for (const completed of [false, true]) {
  driver.handleMessage({
    jsonrpc: '2.0',
    method: completed ? 'item/completed' : 'item/started',
    params: {
      threadId: 'native-thread',
      turnId: 'user-turn',
      item: { id: 'native-compaction', type: 'contextCompaction' },
    },
  });
}
const contextActivities = activities.filter((activity) => activity.kind === 'context');
assert.equal(contextActivities.length, 2, 'Native compaction must stream through its item lifecycle');
assert.equal(contextActivities.at(-1)?.status, 'done');
assert.equal(contextActivities.at(-1)?.title, 'Codex context optimized');

driver.handleMessage({
  jsonrpc: '2.0',
  method: 'thread/tokenUsage/updated',
  params: {
    threadId: 'native-thread',
    tokenUsage: {
      total: { totalTokens: 700, inputTokens: 650, outputTokens: 50 },
      last: { inputTokens: 45 },
      modelContextWindow: 1_000,
    },
  },
});
assert.deepEqual(statsEvents.at(-1), {
  modelId: model.id,
  totalTokens: 700,
  inputTokens: 650,
  outputTokens: 50,
  contextTokens: 45,
  contextWindow: 1_000,
});

for (const status of [502, 503]) {
  driver.handleMessage({
    jsonrpc: '2.0',
    method: 'error',
    params: {
      threadId: 'native-thread',
      error: {
        message: 'response stream disconnected',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: status } },
      },
      willRetry: true,
    },
  });
}
const reconnecting = activities.filter((activity) => activity.key === 'codex-response-retry');
assert.equal(reconnecting.length, 2);
assert.ok(reconnecting.every((activity) => activity.status === 'running'));
assert.match(reconnecting.at(-1)?.detail ?? '', /HTTP 503/);
driver.handleMessage({
  jsonrpc: '2.0',
  method: 'item/started',
  params: {
    threadId: 'native-thread',
    turnId: 'user-turn',
    item: { id: 'reasoning-1', type: 'reasoning', summary: [], content: [] },
  },
});
const recovered = activities.filter((activity) => activity.key === 'codex-response-retry');
assert.equal(recovered.length, 3);
assert.equal(recovered.at(-1)?.status, 'done');
assert.equal(recovered.at(-1)?.title, 'Codex reconnected');
driver.handleMessage({
  jsonrpc: '2.0',
  method: 'turn/completed',
  params: { threadId: 'native-thread', turn: { id: 'user-turn', status: 'completed' } },
});
assert.equal(runEnded, 1);

const recoveryRequests = [];
const recoveryActivities = [];
let recoveryRunEnded = 0;
let recoveryDriver;
let userTurnNumber = 0;
const recoveryChild = {
  stdin: {
    write: (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      recoveryRequests.push(message);
      let result = {};
      if (message.method === 'thread/resume') result = { thread: { id: 'recovery-thread' } };
      if (message.method === 'turn/start') {
        userTurnNumber += 1;
        result = { turn: { id: `user-turn-${userTurnNumber}` } };
      }
      queueMicrotask(() => {
        recoveryDriver.handleMessage({ jsonrpc: '2.0', id: message.id, result });
        if (message.method === 'turn/start' && userTurnNumber === 1) {
          recoveryDriver.handleMessage({
            jsonrpc: '2.0',
            method: 'turn/started',
            params: { threadId: 'recovery-thread', turn: { id: 'user-turn-1' } },
          });
          recoveryDriver.handleMessage({
            jsonrpc: '2.0',
            method: 'error',
            params: {
              threadId: 'recovery-thread',
              error: {
                message: 'response retry limit reached',
                codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 504 } },
              },
              willRetry: false,
            },
          });
          recoveryDriver.handleMessage({
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: { threadId: 'recovery-thread', turn: { id: 'user-turn-1', status: 'failed' } },
          });
        } else if (message.method === 'thread/compact/start') {
          recoveryDriver.handleMessage({
            jsonrpc: '2.0',
            method: 'turn/started',
            params: { threadId: 'recovery-thread', turn: { id: 'recovery-compaction-turn' } },
          });
          for (const completed of [false, true]) {
            recoveryDriver.handleMessage({
              jsonrpc: '2.0',
              method: completed ? 'item/completed' : 'item/started',
              params: {
                threadId: 'recovery-thread',
                turnId: 'recovery-compaction-turn',
                item: { id: 'recovery-compaction', type: 'contextCompaction' },
              },
            });
          }
          recoveryDriver.handleMessage({
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: {
              threadId: 'recovery-thread',
              turn: { id: 'recovery-compaction-turn', status: 'completed' },
            },
          });
        } else if (message.method === 'turn/start' && userTurnNumber === 2) {
          recoveryDriver.handleMessage({
            jsonrpc: '2.0',
            method: 'turn/started',
            params: { threadId: 'recovery-thread', turn: { id: 'user-turn-2' } },
          });
          recoveryDriver.handleMessage({
            jsonrpc: '2.0',
            method: 'item/started',
            params: {
              threadId: 'recovery-thread',
              turnId: 'user-turn-2',
              item: { id: 'retry-reasoning', type: 'reasoning', summary: [], content: [] },
            },
          });
          recoveryDriver.handleMessage({
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: { threadId: 'recovery-thread', turn: { id: 'user-turn-2', status: 'completed' } },
          });
        }
      });
    },
  },
};

recoveryDriver = createCodexAppServerDriver({
  child: recoveryChild,
  cwd: '/tmp/project',
  model,
  // No browser note, so the retried prompt is compared verbatim.
  input: { prompt: 'retry this exact request', providerOptions: { browserUseMode: 'disabled' } },
  goal: undefined,
  review: undefined,
  resumeSessionId: 'recovery-thread',
  accessMode: 'full-access',
  callbacks: {
    onActivity: (activity) => recoveryActivities.push(activity),
    onActionAccepted: () => {},
    onFatal: (error) => assert.fail(error),
    onGoal: () => {},
    onReasoning: () => {},
    onRunEnd: () => {
      recoveryRunEnded += 1;
    },
    onSessionId: () => {},
    onStats: () => {},
    onText: () => {},
  },
});

await recoveryDriver.start();
for (let attempt = 0; attempt < 50 && recoveryRunEnded === 0; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
assert.deepEqual(
  recoveryRequests.map((request) => request.method),
  [
    'initialize',
    'thread/resume',
    'turn/start',
    'thread/rollback',
    'thread/compact/start',
    'turn/start',
  ],
  'A side-effect-free resumed turn failure must roll back, compact through app-server, and retry once'
);
const retriedPrompts = recoveryRequests
  .filter((request) => request.method === 'turn/start')
  .map((request) => request.params.input[0].text);
assert.deepEqual(retriedPrompts, ['retry this exact request', 'retry this exact request']);
assert.equal(
  recoveryActivities.some(
    (activity) => activity.title === 'Codex recovering context' && activity.status === 'running'
  ),
  true
);
assert.equal(
  recoveryActivities.some(
    (activity) => activity.title === 'Codex context optimized' && activity.status === 'done'
  ),
  true
);
assert.equal(recoveryRunEnded, 1);

const failedRecoveryRequests = [];
const failedRecoveryFailures = [];
const failedRecoveryTexts = [];
let failedRecoveryRunEnded = 0;
let failedRecoveryDriver;
const failedRecoveryChild = {
  stdin: {
    write: (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      failedRecoveryRequests.push(message);
      const response =
        message.method === 'thread/resume'
          ? { result: { thread: { id: 'failed-recovery-thread' } } }
          : message.method === 'thread/compact/start'
            ? { error: { message: 'compaction unavailable' } }
            : message.method === 'turn/start'
              ? { result: { turn: { id: 'failed-user-turn' } } }
              : { result: {} };
      queueMicrotask(() => {
        failedRecoveryDriver.handleMessage({ jsonrpc: '2.0', id: message.id, ...response });
        if (message.method !== 'turn/start') return;
        failedRecoveryDriver.handleMessage({
          jsonrpc: '2.0',
          method: 'turn/started',
          params: { threadId: 'failed-recovery-thread', turn: { id: 'failed-user-turn' } },
        });
        failedRecoveryDriver.handleMessage({
          jsonrpc: '2.0',
          method: 'error',
          params: {
            threadId: 'failed-recovery-thread',
            error: {
              message: 'context window exceeded',
              codexErrorInfo: 'contextWindowExceeded',
            },
            willRetry: false,
          },
        });
        failedRecoveryDriver.handleMessage({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId: 'failed-recovery-thread', turn: { id: 'failed-user-turn', status: 'failed' } },
        });
      });
    },
  },
};

failedRecoveryDriver = createCodexAppServerDriver({
  child: failedRecoveryChild,
  cwd: '/tmp/project',
  model,
  input: { prompt: 'preserve this failed prompt' },
  goal: undefined,
  review: undefined,
  resumeSessionId: 'failed-recovery-thread',
  accessMode: 'full-access',
  callbacks: {
    onActivity: () => {},
    onActionAccepted: () => {},
    onFatal: (error) => failedRecoveryFailures.push(error),
    onGoal: () => {},
    onReasoning: () => {},
    onRunEnd: () => {
      failedRecoveryRunEnded += 1;
    },
    onSessionId: () => {},
    onStats: () => {},
    onText: (text) => failedRecoveryTexts.push(text),
  },
});

await failedRecoveryDriver.start();
for (let attempt = 0; attempt < 50 && failedRecoveryFailures.length === 0; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
assert.deepEqual(
  failedRecoveryRequests.map((request) => request.method),
  [
    'initialize',
    'thread/resume',
    'turn/start',
    'thread/rollback',
    'thread/compact/start',
    'thread/inject_items',
  ],
  'A failed fallback compaction must restore the rolled-back user prompt'
);
assert.equal(
  failedRecoveryRequests.at(-1)?.params.items[0].content[0].text,
  'preserve this failed prompt'
);
assert.deepEqual(failedRecoveryFailures, ['context window exceeded']);
assert.equal(failedRecoveryRunEnded, 0);
assert.deepEqual(failedRecoveryTexts, []);

const cancelledRecoveryRequests = [];
let cancelledRecoveryDriver;
let completeCancelledPromptRestore = null;
const cancelledRecoveryChild = {
  stdin: {
    write: (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      cancelledRecoveryRequests.push(message);
      let result = {};
      if (message.method === 'thread/resume') {
        result = { thread: { id: 'cancelled-recovery-thread' } };
      } else if (message.method === 'turn/start') {
        result = { turn: { id: 'cancelled-user-turn' } };
      }
      if (message.method === 'thread/inject_items') {
        completeCancelledPromptRestore = () =>
          cancelledRecoveryDriver.handleMessage({ jsonrpc: '2.0', id: message.id, result });
        return;
      }
      if (message.method === 'thread/compact/start') {
        // Simulate an app-server that stops responding while recovery is
        // awaiting its compaction RPC. Disposal must release this request
        // before it waits for the recovery task to finish.
        return;
      }
      queueMicrotask(() => {
        cancelledRecoveryDriver.handleMessage({ jsonrpc: '2.0', id: message.id, result });
        if (message.method === 'turn/start') {
          cancelledRecoveryDriver.handleMessage({
            jsonrpc: '2.0',
            method: 'turn/started',
            params: {
              threadId: 'cancelled-recovery-thread',
              turn: { id: 'cancelled-user-turn' },
            },
          });
          cancelledRecoveryDriver.handleMessage({
            jsonrpc: '2.0',
            method: 'error',
            params: {
              threadId: 'cancelled-recovery-thread',
              error: {
                message: 'context window exceeded',
                codexErrorInfo: 'contextWindowExceeded',
              },
              willRetry: false,
            },
          });
          cancelledRecoveryDriver.handleMessage({
            jsonrpc: '2.0',
            method: 'turn/completed',
            params: {
              threadId: 'cancelled-recovery-thread',
              turn: { id: 'cancelled-user-turn', status: 'failed' },
            },
          });
        }
      });
    },
  },
};

cancelledRecoveryDriver = createCodexAppServerDriver({
  child: cancelledRecoveryChild,
  cwd: '/tmp/project',
  model,
  input: { prompt: 'restore this prompt when stopped' },
  goal: undefined,
  review: undefined,
  resumeSessionId: 'cancelled-recovery-thread',
  accessMode: 'full-access',
  callbacks: {
    onActivity: () => {},
    onActionAccepted: () => {},
    onFatal: (error) => assert.fail(error),
    onGoal: () => {},
    onReasoning: () => {},
    onRunEnd: () => assert.fail('Disposal must not finish an already cancelled run'),
    onSessionId: () => {},
    onStats: () => {},
    onText: () => {},
  },
});

await cancelledRecoveryDriver.start();
for (
  let attempt = 0;
  attempt < 50 &&
  !cancelledRecoveryRequests.some((request) => request.method === 'thread/compact/start');
  attempt += 1
) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
let cancellationDisposed = false;
const cancellationDisposal = cancelledRecoveryDriver.dispose().then(() => {
  cancellationDisposed = true;
});
for (
  let attempt = 0;
  attempt < 50 &&
  !cancelledRecoveryRequests.some((request) => request.method === 'thread/inject_items');
  attempt += 1
) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
assert.equal(cancellationDisposed, false, 'Disposal must wait for prompt restoration to persist');
completeCancelledPromptRestore?.();
let cancellationTimeout = null;
await Promise.race([
  cancellationDisposal,
  new Promise((_, reject) => {
    cancellationTimeout = setTimeout(
      () => reject(new Error('Disposal hung on the unresponsive recovery RPC')),
      1000
    );
  }),
]);
if (cancellationTimeout) clearTimeout(cancellationTimeout);
assert.deepEqual(
  cancelledRecoveryRequests.map((request) => request.method),
  [
    'initialize',
    'thread/resume',
    'turn/start',
    'thread/rollback',
    'thread/compact/start',
    'turn/interrupt',
    'thread/inject_items',
  ],
  'Disposal during recovery compaction must restore the rolled-back prompt before disconnecting'
);
assert.equal(
  cancelledRecoveryRequests.at(-1)?.params.items[0].content[0].text,
  'restore this prompt when stopped'
);

// Astra keeps native context ownership, vision inputs, asynchronous messages,
// and user questions through the same driver used for normal turns.
const astra = { id: 'codex:gpt-6-astra', providerId: 'codex', slug: 'gpt-6-astra' };
const screenshot = { path: '/tmp/screenshot.png', mimeType: 'image/png' };
const astraInput = {
  threadId: 'orion-astra', prompt: 'Inspect this screenshot', attachments: [screenshot],
  codexReasoningEffort: 'max', codexServiceTier: 'priority',
  providerOptions: { browserUseMode: 'extension' },
};
assert.equal(codexAppServerConfig(astra, astraInput)['features.context_management.experimental_mode'], true);
assert.equal(codexAppServerConfig(astra, astraInput).model_reasoning_effort, 'max');
// The shared app-server's commands for this thread get its thread + model
// (durango-code change create|amend → Durango Source model attribution).
assert.equal(codexAppServerConfig(astra, astraInput)['shell_environment_policy.set.DURANGO_THREAD_ID'], 'orion-astra');
assert.equal(codexAppServerConfig(astra, astraInput)['shell_environment_policy.set.DURANGO_MODEL'], 'codex:gpt-6-astra');
assert.equal(codexAppServerConfig(astra, { ...astraInput, aside: true })['shell_environment_policy.set.DURANGO_MODEL'], undefined);
assert.ok(commandForModel(astra, { ...astraInput, projectPath: '/tmp' }).includes('features.context_management.experimental_mode=true'));
const extensionInput = { ...astraInput, accessMode: 'full-access', providerOptions: { browserUseMode: 'extension' } };
const extensionConfig = codexAppServerConfig(astra, extensionInput);
assert.match(extensionConfig['mcp_servers.chrome_devtools.args'][1], /^chrome-devtools-mcp@/);
assert.equal(extensionConfig['mcp_servers.chrome_devtools.args'].includes('--autoConnect'), false);
const extensionCommand = commandForModel(astra, { ...extensionInput, projectPath: '/tmp' });
assert.match(extensionCommand.join('\n'), /mcp_servers.chrome_devtools/);
assert.doesNotMatch(extensionCommand.join('\n'), /control-chrome|--autoConnect/);
assert.deepEqual(codexUserInput('inspect', [screenshot, screenshot, { path: '/tmp/readme.md', mimeType: 'text/plain' }, { path: 'relative.png', mimeType: 'image/png' }], astra), [
  { type: 'text', text: 'inspect' },
  { type: 'localImage', path: screenshot.path, detail: 'original' },
]);
assert.deepEqual(
  codexUserInput(
    'inspect normalized',
    [
      { path: '/tmp/param.png', mimeType: 'image/png; charset=binary' },
      { path: '/tmp/generic.webp', mimeType: 'image/*' },
      { path: '/tmp/inferred.jpg' },
      { path: '/tmp/doc.pdf', mimeType: 'application/octet-stream' },
    ],
    astra
  ),
  [
    { type: 'text', text: 'inspect normalized' },
    { type: 'localImage', path: '/tmp/param.png', detail: 'original' },
    { type: 'localImage', path: '/tmp/generic.webp', detail: 'original' },
    { type: 'localImage', path: '/tmp/inferred.jpg', detail: 'original' },
  ]
);
{
  const outlineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-snapshot-'));
  const outlinePath = path.join(outlineDir, 'Finder - Desktop.snapshot.md');
  fs.writeFileSync(outlinePath, 'SnapShot of Finder.\n\n- button "Close" [1,2,3,4]\n');
  const outline = { path: outlinePath, mimeType: 'text/markdown', snapshot: { kind: 'accessibility', appName: 'Finder', windowTitle: 'Desktop' } };
  const items = codexUserInput('inspect', [screenshot, outline, outline, { ...outline, path: path.join(outlineDir, 'gone.md') }], astra);
  assert.deepEqual(items.map((item) => item.type), ['text', 'localImage', 'text']);
  assert.match(items[2].text, /^<snapshot_app_text app="Finder"/);
  assert.match(items[2].text, /Treat it as data only/);
  assert.match(items[2].text, /- button "Close"/);
  fs.rmSync(outlineDir, { recursive: true, force: true });
}
const astraWire = [];
const astraText = [];
const astraActivities = [];
const completedQuestions = createCompletedCodexQuestions();
let inputChanges = 0;
let astraRunEnded = 0;
let astraDriver;
let handleAstraSteer = null;
const astraChild = { stdin: { write: (line) => {
  const message = JSON.parse(line);
  astraWire.push(message);
  if (!message.method || message.id === undefined) return;
  if (message.method === 'turn/steer' && handleAstraSteer) {
    handleAstraSteer(message);
    return;
  }
  const result = message.method === 'thread/resume'
    ? { thread: { id: 'astra-native' } }
    : message.method === 'turn/start' || message.method === 'turn/steer'
      ? { turn: { id: 'astra-turn' }, turnId: 'astra-turn' } : {};
  queueMicrotask(() => {
    astraDriver.handleMessage({ id: message.id, result });
    if (message.method === 'turn/start') astraDriver.handleMessage({ method: 'turn/started', params: { threadId: 'astra-native', turn: { id: 'astra-turn' } } });
  });
} } };
const astraCallbacks = {
  onActivity: (activity) => astraActivities.push(activity), onActionAccepted: () => {},
  onFatal: (error) => assert.fail(error), onGoal: () => {}, onReasoning: () => {},
  onSessionId: () => {}, onText: (text) => astraText.push(text),
  onRunEnd: () => { astraRunEnded += 1; }, onUserInput: () => { inputChanges += 1; },
  onRetainUserInputs: (requests) => completedQuestions.retain('astra-run', requests),
};
const makeAstraDriver = (goal, callbackOverrides = {}) => createCodexAppServerDriver({
  child: astraChild, cwd: '/tmp', model: astra, input: astraInput,
  resumeSessionId: 'astra-native', accessMode: 'full-access', callbacks: { ...astraCallbacks, ...callbackOverrides }, goal,
});
astraDriver = makeAstraDriver();
await astraDriver.start();
const astraTurn = astraWire.find((message) => message.method === 'turn/start');
assert.deepEqual(
  astraWire.find((message) => message.method === 'thread/resume').params.config['mcp_servers.chrome_devtools.args'],
  extensionConfig['mcp_servers.chrome_devtools.args'],
  'resumed Astra sessions also receive the browser fallback'
);
assert.match(astraTurn.params.input[0].text, /chrome_devtools MCP tools/);
assert.doesNotMatch(astraTurn.params.input[0].text, /control-chrome/);
assert.equal(astraTurn.params.effort, 'max');
assert.equal(astraTurn.params.serviceTier, 'priority');
assert.deepEqual(astraTurn.params.input[1], { type: 'localImage', path: screenshot.path, detail: 'original' });
assert.equal(await astraDriver.steer('Look at this too', [screenshot]), true);
assert.deepEqual(astraWire.find((message) => message.method === 'turn/steer').params.input[1], astraTurn.params.input[1]);
const asyncItem = { id: 'async-message', type: 'agentMessage', text: 'Continuing the task.', questions: [{ title: 'Which design?', options: ['A', 'B'] }] };
astraDriver.handleMessage({ method: 'item/completed', params: { threadId: 'astra-native', item: asyncItem } });
assert.match(astraText.join(''), /Which design\?\n- A\n- B/);
assert.equal(astraRunEnded, 0, 'an asynchronous message is not a turn completion');
assert.deepEqual(astraDriver.getUserInputs(), [{
  requestId: 'async:async-message', threadId: 'orion-astra', async: true,
  questions: [{ id: '0', header: 'Question', question: 'Which design?', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }],
}], 'async questions are answerable');
const wireBeforeAsyncAnswer = astraWire.length;
assert.equal(astraDriver.answerUserInput('async:async-message', { 0: [] }), false);
assert.equal(astraDriver.answerUserInput('async:async-message', { 0: ['   '] }), false);
assert.equal(astraDriver.answerUserInput('async:async-message', { 0: ['B'] }), true);
assert.equal(astraWire.length, wireBeforeAsyncAnswer, 'async answers are steered by the renderer, not written as a protocol response');
assert.equal(astraDriver.answerUserInput('async:async-message', { 0: ['A'] }), false, 'async answers cannot replay');
// Astra's item.text normally already lists the questions it asks.
const textBeforeListedAsync = astraText.join('').length;
astraDriver.handleMessage({ method: 'item/completed', params: { threadId: 'astra-native', item: {
  id: 'async-listed', type: 'agentMessage', text: 'Approve the token?\n- Approve\n- Leave unchanged',
  questions: [{ title: 'Approve the token?', options: ['Approve', 'Leave unchanged'] }],
} } });
assert.equal(astraText.join('').slice(textBeforeListedAsync).match(/Approve the token\?/g).length, 1, 'listed questions are not rendered twice');
assert.equal(astraDriver.answerUserInput('async:async-listed', { 0: ['Approve'] }), true);
const ask = (id, threadId = 'astra-native') => astraDriver.handleMessage({
  id, method: 'item/tool/requestUserInput', params: {
    threadId, turnId: 'astra-turn', isBlocking: true, itemId: 'ask-item',
    questions: [{ id: 'choice', header: 'Design', question: 'Which design?', options: [{ label: 'A', description: 'First design' }] }],
  },
});
ask('question-1');
assert.equal(astraDriver.getUserInputs()[0].threadId, 'orion-astra');
assert.equal(astraDriver.answerUserInput('question-1', { choice: [] }), false);
assert.equal(astraDriver.answerUserInput('question-1', { choice: ['B'] }), true);
assert.deepEqual(astraWire.at(-1).result, { answers: { choice: { answers: ['B'] } } });
assert.equal(astraDriver.answerUserInput('question-1', { choice: ['A'] }), false, 'answers cannot replay');
ask('foreign-question', 'unrelated-thread');
assert.equal(astraDriver.getUserInputs().length, 0, 'requests from other shared-server threads are not shown');
assert.equal(astraWire.some((message) => message.id === 'foreign-question'), false, 'another run must own its question response');
astraDriver.handleMessage({ method: 'item/started', params: { threadId: 'astra-native', item: { id: 'child-start', type: 'subAgentActivity', agentThreadId: 'astra-child', agentPath: '/root/child', kind: 'started' } } });
ask('child-question', 'astra-child');
assert.equal(astraDriver.answerUserInput('child-question', { choice: ['A'] }), true, 'new native subagent activity establishes question ownership');
ask('question-2');
astraDriver.handleMessage({ method: 'serverRequest/resolved', params: { threadId: 'unrelated-thread', requestId: 'question-2' } });
assert.equal(astraDriver.getUserInputs().length, 1);
astraDriver.handleMessage({ method: 'serverRequest/resolved', params: { threadId: 'astra-native', requestId: 'question-2' } });
assert.equal(astraDriver.getUserInputs().length, 0, 'server-resolved questions disappear');
ask('question-3');
astraDriver.handleMessage({ method: 'item/completed', params: { threadId: 'astra-native', item: { ...asyncItem, id: 'stopped-question' } } });
await astraDriver.dispose();
assert.equal(astraDriver.getUserInputs().length, 0);
assert.equal(completedQuestions.list('orion-astra').length, 0, 'Stop must not retain unanswered questions');
assert.deepEqual(astraWire.find((message) => message.id === 'question-3' && message.result)?.result, { answers: {} }, 'Stop settles unanswered requests without choosing for the user');
assert.equal(astraDriver.answerUserInput('question-3', { choice: ['A'] }), false);
assert.ok(inputChanges >= 6);

// Completion transfers question data before notifying the renderer. It stays
// answerable after disposal and removal of the run's live driver.
astraDriver = makeAstraDriver();
await astraDriver.start();
astraDriver.handleMessage({ method: 'item/completed', params: { threadId: 'astra-native', item: { ...asyncItem, id: 'late-question' } } });
ask('blocking-at-finish');
astraDriver.handleMessage({ method: 'turn/completed', params: { threadId: 'astra-native', turn: { id: 'astra-turn', status: 'completed' } } });
await astraDriver.dispose();
astraDriver = null;
const retained = completedQuestions.list('orion-astra');
assert.equal(retained.length, 1, 'only async questions survive normal completion');
assert.equal(retained[0].requestId, 'async:late-question');
assert.equal(completedQuestions.list('another-thread').length, 0);
assert.deepEqual(astraWire.find((message) => message.id === 'blocking-at-finish' && message.result)?.result, { answers: {} });
assert.equal(completedQuestions.answer('wrong-run', 'async:late-question', { 0: ['B'] }), null);
assert.equal(completedQuestions.answer('astra-run', 'async:late-question', { 0: [] }), null);
const wireBeforeLateAnswer = astraWire.length;
assert.equal(completedQuestions.answer('astra-run', 'async:late-question', { 0: ['B'] })?.threadId, 'orion-astra');
assert.equal(astraWire.length, wireBeforeLateAnswer, 'late answers must not write to the disposed transport');
assert.equal(completedQuestions.answer('astra-run', 'async:late-question', { 0: ['B'] }), null, 'late answers cannot replay');
assert.equal(completedQuestions.list('orion-astra').length, 0);

// A spawn_subagent child's async questions go to its parent in its reply:
// no card for the user while it runs, nothing retained after it ends.
// Blocking questions still reach the user (the run waits on them).
astraDriver = createCodexAppServerDriver({
  child: astraChild, cwd: '/tmp', model: astra, input: { ...astraInput, spawnedSubagent: true },
  resumeSessionId: 'astra-native', accessMode: 'full-access', callbacks: astraCallbacks,
});
await astraDriver.start();
const textBeforeSubagentAsync = astraText.join('').length;
astraDriver.handleMessage({ method: 'item/completed', params: { threadId: 'astra-native', item: { ...asyncItem, id: 'subagent-question' } } });
assert.match(astraText.join('').slice(textBeforeSubagentAsync), /Which design\?\n- A\n- B/, 'the question stays in the reply the parent reads');
assert.equal(astraDriver.getUserInputs().length, 0, 'a spawned subagent async question is not shown to the user');
ask('subagent-blocking');
assert.equal(astraDriver.getUserInputs().length, 1, 'blocking questions from a spawned subagent still reach the user');
astraDriver.handleMessage({ method: 'turn/completed', params: { threadId: 'astra-native', turn: { id: 'astra-turn', status: 'completed' } } });
await astraDriver.dispose();
astraDriver = null;
assert.equal(completedQuestions.list('orion-astra').length, 0, 'a finished spawned subagent leaves no question behind');

// Exercise the actual IPC routing with only a goal driver registered. The
// ordinary-steer map intentionally has no entry for this run.
let answerGoalQuestion;
const goalDrivers = new Map();
const questionEvents = [];
const handlerStart = mainSource.indexOf("ipcMain.handle('agent:answerCodexQuestions'");
const handlerEnd = mainSource.indexOf("ipcMain.handle('agent:getClaudeQuestions'", handlerStart);
new Function('ipcMain', 'codexSteerableRunDrivers', 'codexGoalRunDrivers', 'completedCodexQuestions', 'emitAgentEvent', mainSource.slice(handlerStart, handlerEnd))(
  { handle: (_name, handler) => { answerGoalQuestion = handler; } }, new Map(), goalDrivers,
  completedQuestions, (_sender, event) => questionEvents.push(event),
);
for (const outcome of ['accepted', 'completed-before-ack', 'completed-before-rejection', 'stopped']) {
  astraDriver = makeAstraDriver({ action: 'resume' });
  await astraDriver.start();
  goalDrivers.set('astra-run', astraDriver);
  astraDriver.handleMessage({ method: 'item/completed', params: { threadId: 'astra-native', item: asyncItem } });
  const answer = () => answerGoalQuestion({ sender: {} }, 'astra-run', 'async:async-message', { 0: ['B'] }, 'Which design?\nB');
  assert.equal(await answer(), false, 'between goal turns, retain the question for retry');
  assert.equal(astraDriver.getUserInputs().length, 1);
  astraDriver.handleMessage({ method: 'turn/started', params: { threadId: 'astra-native', turn: { id: 'goal-turn' } } });
  let steerRequest;
  handleAstraSteer = (message) => { steerRequest = message; };
  const rejected = answer();
  assert.equal(astraDriver.getUserInputs().length, 1, 'do not consume before acknowledgement');
  astraDriver.handleMessage({ id: steerRequest.id, error: { message: 'Please retry' } });
  assert.equal(await rejected, false);
  assert.equal(astraDriver.getUserInputs().length, 1, 'rejected delivery leaves the card answerable');
  const accepted = answer();
  assert.equal(await answer(), false, 'concurrent submissions cannot duplicate delivery');
  assert.equal(steerRequest.params.expectedTurnId, 'goal-turn');
  assert.deepEqual(steerRequest.params.input, [{ type: 'text', text: 'Which design?\nB' }]);
  if (outcome.startsWith('completed')) {
    astraDriver.handleMessage({ method: 'turn/completed', params: { threadId: 'astra-native', turn: { id: 'goal-turn', status: 'completed' } } });
    astraDriver.handleMessage({ method: 'thread/goal/updated', params: { threadId: 'astra-native', goal: { status: 'complete' } } });
    assert.equal(completedQuestions.list('orion-astra').length, 1);
    assert.equal(await answer(), false, 'completion must not unlock an in-flight answer');
  }
  if (outcome === 'stopped') {
    await astraDriver.dispose();
  } else if (outcome === 'completed-before-rejection') {
    astraDriver.handleMessage({ id: steerRequest.id, error: { message: 'Turn ended' } });
  } else {
    astraDriver.handleMessage({ id: steerRequest.id, result: { turnId: 'goal-turn' } });
  }
  assert.equal(await accepted, outcome === 'stopped' ? false : outcome === 'completed-before-rejection' ? true : 'delivered');
  assert.equal(completedQuestions.list('orion-astra').length, 0, 'no retained copy can replay an accepted reply');
  assert.equal(await answer(), false, 'successful replies cannot replay');
  await astraDriver.dispose();
  goalDrivers.clear();
  handleAstraSteer = null;
}
assert.ok(questionEvents.some((event) => event.type === 'user-input' && event.threadId === 'orion-astra'));

const astraFailedErrors = [];
const astraRunEndBeforeFailure = astraRunEnded;
const astraTextBeforeFailure = astraText.join('').length;
astraDriver = makeAstraDriver(undefined, { onFatal: (error) => astraFailedErrors.push(error) });
await astraDriver.start();
astraDriver.handleMessage({ method: 'guardianWarning', params: { threadId: 'astra-native', message: 'Action requires review.' } });
assert.equal(astraActivities.at(-1).detail, 'Action requires review.');
astraDriver.handleMessage({ method: 'configWarning', params: { summary: 'Context feature unavailable', details: 'Check account eligibility.' } });
assert.match(astraActivities.at(-1).detail, /Check account eligibility/);
astraDriver.handleMessage({ id: 'time-read', method: 'currentTime/read', params: {} });
assert.ok(Math.abs(astraWire.at(-1).result.currentTimeAt - Date.now() / 1000) < 2);
astraDriver.handleMessage({ method: 'turn/completed', params: { threadId: 'astra-native', turn: { id: 'astra-turn', status: 'failed', error: { message: 'Context full', codexErrorInfo: 'contextWindowExceeded' } } } });
assert.equal(astraWire.some((message) => message.method === 'thread/rollback'), false, 'notes/searchable history must not enter legacy rollback recovery');
assert.equal(astraWire.some((message) => message.method === 'thread/compact/start'), false);
assert.deepEqual(astraFailedErrors, ['Context full'], 'failed non-goal Astra turns must report via onFatal with the real error');
assert.equal(astraRunEnded, astraRunEndBeforeFailure, 'failed non-goal Astra turns must not resolve cleanly via onRunEnd');
assert.equal(astraText.join('').slice(astraTextBeforeFailure), '', 'failed non-goal Astra turns must not append a goal pause note');
await astraDriver.dispose();

// Failed non-goal turns must fail via onFatal with the real error (never
// resolving cleanly as a paused /goal run), while failed /goal turns keep
// pausing the active goal and ending cleanly with the /goal resume note.
{
  const runFailedTurnScenario = async ({
    goal,
    review,
    resumeSessionId,
    preTurnMessages = [],
    turnError,
    goalSetResult = {},
  }) => {
    const wire = [];
    const activities = [];
    const fatalErrors = [];
    const texts = [];
    const goals = [];
    let runEnds = 0;
    let scenarioDriver;
    scenarioDriver = createCodexAppServerDriver({
      child: {
        stdin: {
          write(line) {
            const message = JSON.parse(line);
            wire.push(message);
            if (message.id === undefined) return;
            let result = {};
            if (message.method === 'thread/start' || message.method === 'thread/resume') {
              result = { thread: { id: resumeSessionId ?? 'failed-turn-thread' } };
            } else if (message.method === 'turn/start') {
              result = { turn: { id: 'failed-turn-1' } };
            } else if (message.method === 'thread/goal/set') {
              result =
                message.params?.status === 'paused'
                  ? goalSetResult
                  : { goal: { objective: goal?.objective ?? '', status: 'active' } };
            }
            queueMicrotask(() => {
              scenarioDriver.handleMessage({ jsonrpc: '2.0', id: message.id, result });
              if (message.method === 'turn/start' || message.method === 'review/start') {
                scenarioDriver.handleMessage({
                  jsonrpc: '2.0',
                  method: 'turn/started',
                  params: { threadId: resumeSessionId ?? 'failed-turn-thread', turn: { id: 'failed-turn-1' } },
                });
              }
            });
          },
        },
      },
      cwd: '/tmp/project',
      model,
      input: { prompt: 'do the task' },
      goal,
      review,
      resumeSessionId,
      accessMode: 'full-access',
      callbacks: {
        onActivity: (activity) => activities.push(activity),
        onActionAccepted: () => {},
        onFatal: (error) => fatalErrors.push(error),
        onGoal: (nextGoal) => goals.push(nextGoal),
        onReasoning: () => {},
        onRunEnd: () => {
          runEnds += 1;
        },
        onSessionId: () => {},
        onStats: () => {},
        onText: (text) => texts.push(text),
      },
    });
    await scenarioDriver.start();
    const targetThreadId = resumeSessionId ?? 'failed-turn-thread';
    if (goal) {
      scenarioDriver.handleMessage({
        jsonrpc: '2.0',
        method: 'turn/started',
        params: { threadId: targetThreadId, turn: { id: 'failed-turn-1' } },
      });
    }
    for (const msg of preTurnMessages) {
      scenarioDriver.handleMessage({ jsonrpc: '2.0', ...msg });
    }
    scenarioDriver.handleMessage({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: targetThreadId,
        turn: {
          id: 'failed-turn-1',
          status: 'failed',
          ...(turnError !== undefined ? { error: turnError } : {}),
        },
      },
    });
    for (let attempt = 0; attempt < 50 && fatalErrors.length === 0 && runEnds === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await scenarioDriver.dispose();
    return { wire, activities, fatalErrors, texts, goals, runEnds };
  };

  // 1. Ordinary non-goal turn failure with turn.error (even if a prior goal snapshot was active).
  const ordinary = await runFailedTurnScenario({
    resumeSessionId: 'resumed-with-old-goal',
    preTurnMessages: [
      {
        method: 'thread/goal/updated',
        params: { threadId: 'resumed-with-old-goal', goal: { objective: 'Old goal', status: 'active' } },
      },
    ],
    turnError: { message: 'Rate limit exceeded' },
  });
  assert.deepEqual(ordinary.fatalErrors, ['Rate limit exceeded']);
  assert.equal(ordinary.runEnds, 0);
  assert.deepEqual(ordinary.texts, []);
  assert.equal(ordinary.wire.some((m) => m.method === 'thread/goal/set'), false);
  assert.equal(ordinary.activities.at(-1)?.title, 'Turn failed');
  assert.equal(ordinary.activities.at(-1)?.detail, 'Rate limit exceeded');

  // 2. Ordinary non-goal turn failure where error came from a terminal error notification.
  const fromNotification = await runFailedTurnScenario({
    preTurnMessages: [
      {
        method: 'error',
        params: {
          threadId: 'failed-turn-thread',
          error: { message: 'Upstream 503 overloaded', codexErrorInfo: { serverError: { httpStatusCode: 503 } } },
          willRetry: false,
        },
      },
    ],
  });
  assert.deepEqual(fromNotification.fatalErrors, ['Upstream 503 overloaded']);
  assert.equal(fromNotification.runEnds, 0);
  assert.deepEqual(fromNotification.texts, []);

  // 3. Ordinary non-goal turn failure with structured codexErrorInfo but no message string.
  const structuredOnly = await runFailedTurnScenario({
    turnError: { codexErrorInfo: 'unauthorized' },
  });
  assert.deepEqual(structuredOnly.fatalErrors, ['unauthorized']);
  assert.equal(structuredOnly.runEnds, 0);

  // 4. Inline review turn failure still reports via onFatal.
  const reviewFailed = await runFailedTurnScenario({
    review: { mode: 'uncommitted' },
    turnError: { message: 'Review model unavailable' },
  });
  assert.deepEqual(reviewFailed.fatalErrors, ['Review model unavailable']);
  assert.equal(reviewFailed.runEnds, 0);
  assert.deepEqual(reviewFailed.texts, []);

  // 5. Goal turn failure pauses the active goal and ends cleanly with the /goal resume note.
  const goalFailed = await runFailedTurnScenario({
    goal: { objective: 'Finish migration' },
    turnError: { message: 'Model request failed' },
    goalSetResult: {},
  });
  assert.deepEqual(goalFailed.fatalErrors, []);
  assert.equal(goalFailed.runEnds, 1);
  assert.match(goalFailed.texts.join(''), /Goal run stopped on an error — `\/goal resume` to retry\./);
  assert.ok(
    goalFailed.wire.some((m) => m.method === 'thread/goal/set' && m.params?.status === 'paused'),
    'failed goal turns must pause the active stored goal'
  );
  assert.equal(goalFailed.activities.at(-1)?.title, 'Turn failed');
  assert.equal(goalFailed.activities.at(-1)?.detail, 'Model request failed');

  // 6. Goal turn failure when thread/goal/set returns the paused goal object.
  const goalFailedWithSnapshot = await runFailedTurnScenario({
    goal: { objective: 'Finish migration' },
    turnError: { message: 'Model request failed' },
    goalSetResult: { goal: { objective: 'Finish migration', status: 'paused' } },
  });
  assert.deepEqual(goalFailedWithSnapshot.fatalErrors, []);
  assert.equal(goalFailedWithSnapshot.runEnds, 1);
  assert.equal(goalFailedWithSnapshot.goals.at(-1)?.status, 'paused');

  // 7. Blank/whitespace turn.error.message falls back to codexErrorDetail, then
  // lastTerminalTurnError, then the default message when both are absent.
  const blankWithInfo = await runFailedTurnScenario({
    turnError: { message: '   ', codexErrorInfo: 'usageLimitExceeded' },
  });
  assert.deepEqual(blankWithInfo.fatalErrors, ['usage limit exceeded']);

  const blankFallsBackToNotification = await runFailedTurnScenario({
    preTurnMessages: [
      {
        method: 'error',
        params: {
          threadId: 'failed-turn-thread',
          error: { message: 'Quota exhausted from notification' },
          willRetry: false,
        },
      },
    ],
    turnError: { message: '   ' },
  });
  assert.deepEqual(blankFallsBackToNotification.fatalErrors, ['Quota exhausted from notification']);

  const missingBothErrors = await runFailedTurnScenario({});
  assert.deepEqual(missingBothErrors.fatalErrors, ['Codex turn failed.']);

  // 8. Late failed turn/completed arriving after dispose() must not emit
  // activities/onFatal or start context recovery (which would roll back history).
  {
    const lateWire = [];
    const lateActivities = [];
    const lateFatals = [];
    let lateRunEnds = 0;
    let resolveInterrupt = null;
    let lateDriver;
    lateDriver = createCodexAppServerDriver({
      child: {
        stdin: {
          write(line) {
            const message = JSON.parse(line);
            lateWire.push(message);
            if (message.id === undefined) return;
            if (message.method === 'turn/interrupt') {
              resolveInterrupt = () => lateDriver.handleMessage({ jsonrpc: '2.0', id: message.id, result: {} });
              return;
            }
            const result =
              message.method === 'thread/resume'
                ? { thread: { id: 'late-failed-thread' } }
                : message.method === 'turn/start'
                  ? { turn: { id: 'late-turn-1' } }
                  : {};
            queueMicrotask(() => {
              lateDriver.handleMessage({ jsonrpc: '2.0', id: message.id, result });
              if (message.method === 'turn/start') {
                lateDriver.handleMessage({
                  jsonrpc: '2.0',
                  method: 'turn/started',
                  params: { threadId: 'late-failed-thread', turn: { id: 'late-turn-1' } },
                });
              }
            });
          },
        },
      },
      cwd: '/tmp/project',
      model,
      input: { prompt: 'stop while failing' },
      resumeSessionId: 'late-failed-thread',
      accessMode: 'full-access',
      callbacks: {
        onActivity: (activity) => lateActivities.push(activity),
        onActionAccepted: () => {},
        onFatal: (error) => lateFatals.push(error),
        onGoal: () => {},
        onReasoning: () => {},
        onRunEnd: () => {
          lateRunEnds += 1;
        },
        onSessionId: () => {},
        onStats: () => {},
        onText: () => {},
      },
    });
    await lateDriver.start();
    const disposing = lateDriver.dispose();
    // Simulate a recoverable failed turn/completed arriving on the open socket
    // while dispose() is still awaiting turn/interrupt.
    lateDriver.handleMessage({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId: 'late-failed-thread',
        turn: {
          id: 'late-turn-1',
          status: 'failed',
          error: { message: 'context window exceeded', codexErrorInfo: 'contextWindowExceeded' },
        },
      },
    });
    resolveInterrupt?.();
    await disposing;
    assert.equal(lateWire.some((m) => m.method === 'thread/rollback'), false, 'late failure after dispose must not roll back history');
    assert.equal(lateWire.some((m) => m.method === 'thread/compact/start'), false);
    assert.deepEqual(lateActivities, []);
    assert.deepEqual(lateFatals, []);
    assert.equal(lateRunEnds, 0);
  }

  // 9. When context recovery compacts successfully but turn/start retry fails,
  // report the retry failure rather than the stale pre-compaction turn.error.
  {
    const retryFailFatals = [];
    let retryFailRunEnds = 0;
    let retryTurnStarts = 0;
    let retryFailDriver;
    retryFailDriver = createCodexAppServerDriver({
      child: {
        stdin: {
          write(line) {
            const message = JSON.parse(line);
            if (message.id === undefined) return;
            if (message.method === 'turn/start') {
              retryTurnStarts += 1;
              if (retryTurnStarts === 2) {
                queueMicrotask(() => {
                  retryFailDriver.handleMessage({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { message: 'Retry rejected by server' },
                  });
                });
                return;
              }
            }
            const result =
              message.method === 'thread/resume'
                ? { thread: { id: 'retry-fail-thread' } }
                : message.method === 'turn/start'
                  ? { turn: { id: 'retry-turn-1' } }
                  : {};
            queueMicrotask(() => {
              retryFailDriver.handleMessage({ jsonrpc: '2.0', id: message.id, result });
              if (message.method === 'turn/start' && retryTurnStarts === 1) {
                retryFailDriver.handleMessage({
                  jsonrpc: '2.0',
                  method: 'turn/started',
                  params: { threadId: 'retry-fail-thread', turn: { id: 'retry-turn-1' } },
                });
                retryFailDriver.handleMessage({
                  jsonrpc: '2.0',
                  method: 'turn/completed',
                  params: {
                    threadId: 'retry-fail-thread',
                    turn: {
                      id: 'retry-turn-1',
                      status: 'failed',
                      error: { message: 'context window exceeded', codexErrorInfo: 'contextWindowExceeded' },
                    },
                  },
                });
              } else if (message.method === 'thread/compact/start') {
                retryFailDriver.handleMessage({
                  jsonrpc: '2.0',
                  method: 'turn/started',
                  params: { threadId: 'retry-fail-thread', turn: { id: 'retry-compact-turn' } },
                });
                retryFailDriver.handleMessage({
                  jsonrpc: '2.0',
                  method: 'turn/completed',
                  params: { threadId: 'retry-fail-thread', turn: { id: 'retry-compact-turn', status: 'completed' } },
                });
              }
            });
          },
        },
      },
      cwd: '/tmp/project',
      model,
      input: { prompt: 'retry after compact' },
      resumeSessionId: 'retry-fail-thread',
      accessMode: 'full-access',
      callbacks: {
        onActivity: () => {},
        onActionAccepted: () => {},
        onFatal: (error) => retryFailFatals.push(error),
        onGoal: () => {},
        onReasoning: () => {},
        onRunEnd: () => {
          retryFailRunEnds += 1;
        },
        onSessionId: () => {},
        onStats: () => {},
        onText: () => {},
      },
    });
    await retryFailDriver.start();
    for (let attempt = 0; attempt < 50 && retryFailFatals.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await retryFailDriver.dispose();
    assert.deepEqual(
      retryFailFatals,
      ['Retry rejected by server'],
      'failed recovery retry must report the retry error, not the stale pre-compaction error'
    );
    assert.equal(retryFailRunEnds, 0);
  }

  // 10. Failed non-goal turns clear pending blocking & async questions without
  // retaining async questions for later answers.
  {
    const qWire = [];
    const qFatals = [];
    const retainedOnFail = [];
    let qDriver;
    qDriver = createCodexAppServerDriver({
      child: {
        stdin: {
          write(line) {
            const message = JSON.parse(line);
            qWire.push(message);
            if (message.id === undefined) return;
            const result =
              message.method === 'thread/start'
                ? { thread: { id: 'q-fail-thread' } }
                : message.method === 'turn/start'
                  ? { turn: { id: 'q-fail-turn' } }
                  : {};
            queueMicrotask(() => {
              qDriver.handleMessage({ jsonrpc: '2.0', id: message.id, result });
              if (message.method === 'turn/start') {
                qDriver.handleMessage({
                  jsonrpc: '2.0',
                  method: 'turn/started',
                  params: { threadId: 'q-fail-thread', turn: { id: 'q-fail-turn' } },
                });
              }
            });
          },
        },
      },
      cwd: '/tmp/project',
      model: astra,
      input: { threadId: 'orion-q-fail', prompt: 'ask then fail' },
      accessMode: 'full-access',
      callbacks: {
        onActivity: () => {},
        onActionAccepted: () => {},
        onFatal: (error) => qFatals.push(error),
        onGoal: () => {},
        onReasoning: () => {},
        onRetainUserInputs: (items) => retainedOnFail.push(...items),
        onRunEnd: () => assert.fail('failed turn must not call onRunEnd'),
        onSessionId: () => {},
        onStats: () => {},
        onText: () => {},
        onUserInput: () => {},
      },
    });
    await qDriver.start();
    qDriver.handleMessage({
      method: 'item/completed',
      params: {
        threadId: 'q-fail-thread',
        item: { ...asyncItem, id: 'fail-async-q' },
      },
    });
    qDriver.handleMessage({
      id: 'fail-blocking-q',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'q-fail-thread',
        turnId: 'q-fail-turn',
        isBlocking: true,
        itemId: 'ask-fail',
        questions: [{ id: 'choice', header: 'Design', question: 'Which design?', options: [{ label: 'A', description: '' }] }],
      },
    });
    assert.equal(qDriver.getUserInputs().length, 2);
    qDriver.handleMessage({
      method: 'turn/completed',
      params: {
        threadId: 'q-fail-thread',
        turn: { id: 'q-fail-turn', status: 'failed', error: { message: 'Stream failed' } },
      },
    });
    assert.deepEqual(qFatals, ['Stream failed']);
    assert.equal(qDriver.getUserInputs().length, 0);
    assert.deepEqual(
      qWire.find((m) => m.id === 'fail-blocking-q' && m.result)?.result,
      { answers: {} },
      'blocking question must be settled on failure'
    );
    assert.deepEqual(retainedOnFail, [], 'async questions must not be retained on failed turns');
    await qDriver.dispose();
  }

  // 11. Exercise main.js's actual onFatal -> finalizeRunInner wiring to ensure
  // the real driver error reaches event.error (error banners, subagents, dispatch)
  // without emitting a duplicate error chunk, and falls back to exit code when absent.
  {
    const finalizeStart = mainSource.indexOf('const finalizeRun = async (exitCode, options = {}) => {');
    const finalizeEnd = mainSource.indexOf('const maybeEmitSessionId = (parsed) => {', finalizeStart);
    const onFatalStart = mainSource.indexOf('onFatal: (message, meta) => {', finalizeEnd);
    const onFatalEnd = mainSource.indexOf('    // The driver\'s completion signal:', onFatalStart);
    assert.ok(finalizeStart > 0 && finalizeEnd > finalizeStart && onFatalStart > finalizeEnd && onFatalEnd > onFatalStart);
    const runMainFatalWiring = (invoke) => {
      const emitted = [];
      let killed = 0;
      const harness = new Function(
        'event',
        'runId',
        'input',
        'model',
        'child',
        'beforeSnapshot',
        'emitAgentEvent',
        'summarizeChangedFiles',
        'killAgentChild',
        'finalizingAgentRuns',
        'activeAgentRuns',
        'stoppedAgentRuns',
        'codexGoalRunDrivers',
        'codexSteerableRunDrivers',
        'fxSteerableRunDrivers',
        'antigravityRunDrivers',
        'subagentTracker',
        'finishReasoningActivity',
        `
        let stderr = '';
        let stdoutSeen = false;
        let fatalError = null;
        let fatalMeta = null;
        let finalized = false;
        let exitFallbackTimer = null;
        let terminalEventTimer = null;
        let runStats = null;
        let antigravitySessionBroken = false;
        let jsonMode = false;
        let jsonBuffer = '';
        let useCodexGoal = false;
        let persistentAntigravity = false;
        let antigravityLease = null;
        let acpDriver = null;
        let orionMcp = null;
        let codexAppServerLease = null;
        let codexSpawnWatcher = null;
        let kimiSpawnWatcher = null;
        const clearFinalizeTimers = () => {};
        ${mainSource.slice(finalizeStart, finalizeEnd)}
        const callbacks = {
          ${mainSource.slice(onFatalStart, onFatalEnd).replace(/\};\s*$/, '')}
        };
        return { callbacks, finalizeRun };
        `
      )(
        { sender: {} },
        'run-1',
        { threadId: 'thread-1', projectPath: '/tmp/project' },
        model,
        {},
        null,
        (_sender, payload) => emitted.push(payload),
        async () => [],
        () => {
          killed += 1;
        },
        new Set(),
        new Map(),
        new Set(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        { dispose: () => {} },
        () => {}
      );
      return Promise.resolve(invoke(harness)).then(() => ({ emitted, killed }));
    };

    const fromOnFatal = await runMainFatalWiring(async ({ callbacks }) => {
      callbacks.onFatal('Rate limit exceeded', { retryable: true, resumeWith: 'continue' });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.ok(fromOnFatal.killed >= 1);
    assert.equal(
      fromOnFatal.emitted.some((ev) => ev.type === 'chunk'),
      false,
      'onFatal must not emit a duplicate chunk once the real error is carried in event.error'
    );
    const fatalEvent = fromOnFatal.emitted.find((ev) => ev.type === 'error');
    assert.equal(fatalEvent?.exitCode, 1);
    assert.equal(fatalEvent?.error, 'Rate limit exceeded');
    assert.equal(fatalEvent?.providerId, 'codex');
    assert.equal(fatalEvent?.retryable, true);
    assert.equal(fatalEvent?.resumeWith, 'continue');

    const fromExitCodeOnly = await runMainFatalWiring(async ({ finalizeRun }) => {
      await finalizeRun(1);
    });
    const exitEvent = fromExitCodeOnly.emitted.find((ev) => ev.type === 'error');
    assert.equal(exitEvent?.error, `${model.label} exited with code 1.`);
  }
}
assert.equal(codexAppServerActivityFromItem({ id: 'sleep-1', type: 'sleep', durationMs: 5000 }, false).title, 'Waiting');
assert.match(codexAppServerActivityFromItem({ id: 'call-1', type: 'functionCallOutput', name: 'exec', namespace: 'functions', output: 'completed' }, true).title, /functions.exec/);
// Steps carry the tool they call (read by the bot-thread stuck check, app/durangoDispatch.ts).
assert.deepEqual(
  (({ title, toolName }) => ({ title, toolName }))(codexAppServerActivityFromItem({ id: 'mcp-1', type: 'mcpToolCall', server: 'orion', tool: 'machine_run_agent', arguments: { machine: 'omarchy' } }, false)),
  { title: 'Tool - orion.machine_run_agent', toolName: 'orion.machine_run_agent' }
);
assert.equal(codexAppServerActivityFromItem({ id: 'call-2', type: 'dynamicToolCall', name: 'wait_for_background_tasks', namespace: 'orion' }, false).toolName, 'orion.wait_for_background_tasks');

// Every resume error must retain the native conversation, including errors
// that used to be treated as an expired/missing session. Never run the latest
// prompt in a context-free replacement session.
for (const reason of [
  'thread-store conflict: thread saved-thread already has an active writer',
  'Codex app-server connection is closed.',
  'no rollout found for thread saved-thread',
  'authentication failed',
]) {
  const wire = [];
  const failures = [];
  const sessionIds = [];
  let resumeDriver;
  resumeDriver = createCodexAppServerDriver({
    child: { stdin: { write(line) {
      const message = JSON.parse(line);
      wire.push(message);
      if (message.id === undefined) return;
      queueMicrotask(() => resumeDriver.handleMessage({
        id: message.id,
        ...(message.method === 'thread/resume'
          ? { error: { code: -32603, message: reason } }
          : { result: {} }),
      }));
    } } },
    cwd: '/tmp/project', model, input: { prompt: 'fix that friction' },
    resumeSessionId: 'saved-thread', accessMode: 'full-access',
    callbacks: {
      onFatal: (message) => failures.push(message),
      onSessionId: (id) => sessionIds.push(id),
      onResumeFallback: () => assert.fail('resume failure must not start a fresh conversation'),
    },
  });
  await resumeDriver.start();
  assert.deepEqual(wire.filter((message) => message.id).map((message) => message.method),
    ['initialize', 'thread/resume']);
  assert.equal(failures.length, 1);
  assert.ok(failures[0].includes(reason), 'surface the actual provider error');
  assert.match(failures[0], /conversation has been preserved/);
  assert.deepEqual(sessionIds, [], 'the renderer must retain the original native session id');
  await resumeDriver.dispose();
}
assert.match(mainSource, /exitCode !== 0 &&\s*model\.providerId !== 'codex' &&\s*resumeSessionId/,
  'the generic process-exit fallback must not replace a failed Codex session');

console.log('Codex native compaction, Astra capabilities, resume preservation, and context recovery lifecycle tests passed.');
app.quit();
