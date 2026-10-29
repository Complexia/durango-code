import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

import { commandForModel } from '../src/main/command-for-model.js';
import { createFxAcpDriver, fxStatsFromPromptResult } from '../src/main/fx-driver.js';
import {
  ensureFxDurangoConnection,
  fxGatewayModelId,
  fxSettingsPath,
  resolveFxRoutes,
} from '../src/main/fx-provider.js';

const providers = (routes) => routes.map((route) => `${route.provider}:${route.model}`);
const everything = { codex: true, grok: true, durango: true, gateway: true };

// --- Routing ---------------------------------------------------------------

assert.deepEqual(
  providers(resolveFxRoutes('openai/gpt-6-astra', {}, everything)),
  ['codex:gpt-6-astra', 'durango:openai/gpt-6-astra', 'gateway:openai/gpt-6-astra'],
  'OpenAI models prefer the ChatGPT subscription, then Durango credits, then AI Gateway'
);
assert.deepEqual(
  providers(resolveFxRoutes('x-ai/grok-4.7', {}, everything)),
  ['grok:grok-4.7', 'durango:x-ai/grok-4.7', 'gateway:spacexai/grok-4.7'],
  'Grok models prefer the Grok subscription; AI Gateway uses its spacexai namespace'
);
assert.deepEqual(
  providers(resolveFxRoutes('anthropic/claude-sonnet-5.5', {}, everything)),
  ['durango:anthropic/claude-sonnet-5.5', 'gateway:anthropic/claude-sonnet-5.5'],
  'labs without a connected subscription go straight to billed inference'
);
assert.deepEqual(
  providers(resolveFxRoutes('openai/gpt-6-astra', { fxBilledProvider: 'gateway' }, everything)),
  ['codex:gpt-6-astra', 'gateway:openai/gpt-6-astra', 'durango:openai/gpt-6-astra'],
  'choosing AI Gateway as the billed provider keeps subscriptions first'
);
assert.deepEqual(
  providers(resolveFxRoutes('openai/gpt-6-astra', { fxDurangoInference: false }, everything)),
  ['codex:gpt-6-astra', 'gateway:openai/gpt-6-astra'],
  'turning Durango credits off removes the Durango route'
);
assert.deepEqual(
  providers(resolveFxRoutes('openai/gpt-6-astra', {}, { durango: true })),
  ['durango:openai/gpt-6-astra'],
  'without subscriptions every model runs on Durango credits'
);
assert.deepEqual(resolveFxRoutes('openai/gpt-6-astra', {}, {}), [], 'no connection, no route');
assert.equal(fxGatewayModelId('qwen/qwen3.5-coder'), 'alibaba/qwen3.5-coder');
assert.equal(fxGatewayModelId('z-ai/glm-5'), 'zai/glm-5');
assert.equal(fxGatewayModelId('x-ai/grok-4'), 'x-ai/grok-4', 'older Grok releases keep x-ai');

assert.deepEqual(
  commandForModel(
    { providerId: 'fx', slug: 'openai/gpt-6-astra' },
    { prompt: 'Hi', projectPath: '/tmp/project', providerOptions: { extraArgs: '--add-dir /tmp/other' } }
  ),
  ['fx', '--add-dir', '/tmp/other', 'acp'],
  'fx runs over ACP with global flags before the subcommand'
);

// --- ~/.fx/settings.json -----------------------------------------------------

const home = await mkdtemp(path.join(os.tmpdir(), 'orion-fx-home-'));
const previousHome = process.env.HOME;
process.env.HOME = home;
try {
  await mkdir(path.dirname(fxSettingsPath()), { recursive: true });
  await writeFile(
    fxSettingsPath(),
    JSON.stringify({ theme: 'dark', providers: { local: { protocol: 'openai-chat-completions' } } })
  );
  await ensureFxDurangoConnection('https://durango.sh/');
  const settings = JSON.parse(await readFile(fxSettingsPath(), 'utf8'));
  assert.equal(settings.theme, 'dark', 'unrelated settings survive');
  assert.ok(settings.providers.local, 'other custom connections survive');
  assert.deepEqual(settings.providers.durango, {
    protocol: 'openai-chat-completions',
    base_url: 'https://durango.sh/api/v1',
    auth: { type: 'bearer', env: 'DURANGO_API_KEY' },
    tool_choice_mode: 'send',
  });
  assert.ok(!JSON.stringify(settings).includes('dgo_'), 'the Durango key is never written to disk');

  await writeFile(fxSettingsPath(), '{ not json');
  await assert.rejects(ensureFxDurangoConnection('https://durango.sh'), /Fix or remove it/);
  assert.equal(await readFile(fxSettingsPath(), 'utf8'), '{ not json', 'a broken file is left alone');
} finally {
  process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
}

// --- ACP driver (scripted fx) -----------------------------------------------

const workspace = await mkdtemp(path.join(os.tmpdir(), 'orion-fx-ws-'));

// A fake `fx acp`: answers the driver's requests via `respond`, then replays
// the turn's notifications and server requests once the prompt arrives.
const runDriver = async ({ accessMode = 'workspace-write', routes, respond, turn }) => {
  const sent = [];
  const events = { text: '', activities: [], notices: [], fatal: null, turnEnd: null, route: null };
  let driver;
  const deliver = (message) => queueMicrotask(() => driver.handleMessage(message));
  const child = {
    stdin: {
      write(line) {
        const message = JSON.parse(line);
        sent.push(message);
        if (!message.method) return; // a permission answer
        if (message.method === 'session/prompt') {
          for (const step of turn) deliver(step);
          deliver({ jsonrpc: '2.0', id: message.id, result: turn.result ?? { stopReason: 'end_turn' } });
          return;
        }
        const reply = respond(message) ?? { result: null };
        deliver({ jsonrpc: '2.0', id: message.id, ...reply });
      },
    },
  };
  await new Promise((resolve) => {
    driver = createFxAcpDriver({
      child,
      cwd: workspace,
      promptText: 'Do the thing',
      resumeSessionId: null,
      accessMode,
      routes,
      callbacks: {
        onSessionId: () => {},
        onReasoning: () => {},
        onResumeFallback: () => {},
        onActivity: (activity) => events.activities.push(activity),
        onText: (text) => {
          events.text += text;
        },
        onNotice: (notice) => events.notices.push(notice),
        onRoute: (route) => {
          events.route = route;
        },
        onTurnEnd: (result) => {
          events.turnEnd = result;
          resolve();
        },
        onFatal: (message) => {
          events.fatal = message;
          resolve();
        },
      },
    });
    driver.start();
  });
  return { sent, events };
};

const baseRespond = (message) => {
  if (message.method === 'initialize') return { result: { protocolVersion: 1, agentCapabilities: {} } };
  if (message.method === 'session/new') return { result: { sessionId: 'fx-session' } };
  return null;
};
const permission = (id, toolCall) => ({
  jsonrpc: '2.0',
  id,
  method: 'session/request_permission',
  params: {
    sessionId: 'fx-session',
    toolCall,
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Allow for this session', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
  },
});
const update = (value) => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: 'fx-session', update: value },
});

{
  // The ChatGPT subscription doesn't serve the model: fall back to Durango.
  const turn = [
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'w1',
      name: 'write_file',
      kind: 'edit',
      status: 'pending',
      rawInput: { path: 'inside.txt', content: 'a\nb\n' },
    }),
    permission(901, { toolCallId: 'w1', kind: 'edit', rawInput: { path: 'inside.txt' } }),
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'w2',
      name: 'write_file',
      kind: 'edit',
      status: 'pending',
      rawInput: { path: '../outside.txt', content: 'x' },
    }),
    permission(902, { toolCallId: 'w2', kind: 'edit', rawInput: { path: '../outside.txt' } }),
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 's1',
      name: 'shell',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'rm -rf /' },
    }),
    permission(903, { toolCallId: 's1', kind: 'execute', rawInput: { command: 'rm -rf /' } }),
    update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Done.' } }),
  ];
  turn.result = { stopReason: 'end_turn', usage: { inputTokens: 1200, outputTokens: 80 } };
  const { sent, events } = await runDriver({
    routes: [
      { provider: 'codex', model: 'gpt-6-astra-pro', label: 'ChatGPT subscription' },
      { provider: 'durango', model: 'openai/gpt-6-astra-pro', label: 'Durango credits' },
    ],
    respond: (message) => {
      if (message.method === 'session/set_config_option' && message.params.configId === 'model') {
        return message.params.value === 'gpt-6-astra-pro'
          ? { error: { code: -32602, message: 'Unknown model gpt-6-astra-pro' } }
          : { result: { configOptions: [] } };
      }
      return baseRespond(message);
    },
    turn,
  });
  assert.equal(events.fatal, null);
  assert.equal(events.route.provider, 'durango', 'the next route is used when a model is rejected');
  assert.match(events.notices[0], /Durango credits/);
  const configCalls = sent
    .filter((message) => message.method === 'session/set_config_option')
    .map((message) => `${message.params.configId}=${message.params.value}`);
  assert.deepEqual(configCalls, [
    'provider=codex',
    'model=gpt-6-astra-pro',
    'provider=durango',
    'model=openai/gpt-6-astra-pro',
  ]);
  assert.deepEqual(
    sent.find((message) => message.method === 'session/set_mode').params.modeId,
    'ask',
    'Workspace write runs fx in ask mode so every change is checked'
  );
  const answer = (id) => sent.find((message) => message.id === id && !message.method)?.result?.outcome;
  assert.deepEqual(answer(901), { outcome: 'selected', optionId: 'allow_once' }, 'in-workspace writes are allowed once');
  assert.deepEqual(answer(902), { outcome: 'selected', optionId: 'reject_once' }, 'writes outside the workspace are denied');
  assert.deepEqual(answer(903), { outcome: 'selected', optionId: 'reject_once' }, 'commands are denied in Workspace write');
  const outside = events.activities.filter((activity) => activity.key === 'w2').at(-1);
  assert.equal(outside.status, 'error');
  assert.match(outside.output, /inside the workspace/);
  assert.equal(events.text, 'Done.');
  assert.deepEqual(fxStatsFromPromptResult(events.turnEnd), {
    inputTokens: 1200,
    outputTokens: 80,
    totalTokens: 1280,
  });
}

{
  // Read only denies edits; Full access runs fx's full-access mode.
  const turn = [
    update({ sessionUpdate: 'tool_call', toolCallId: 'e1', name: 'edit_file', kind: 'edit', status: 'pending', rawInput: { path: 'a.txt' } }),
    permission(911, { toolCallId: 'e1', kind: 'edit', rawInput: { path: 'a.txt' } }),
  ];
  const readOnly = await runDriver({
    accessMode: 'read-only',
    routes: [{ provider: 'durango', model: 'anthropic/claude-sonnet-5.5', label: 'Durango credits' }],
    respond: baseRespond,
    turn,
  });
  assert.deepEqual(
    readOnly.sent.find((message) => message.id === 911 && !message.method).result.outcome,
    { outcome: 'selected', optionId: 'reject_once' }
  );
  const fullAccess = await runDriver({
    accessMode: 'full-access',
    routes: [{ provider: 'durango', model: 'anthropic/claude-sonnet-5.5', label: 'Durango credits' }],
    respond: baseRespond,
    turn: [],
  });
  assert.equal(fullAccess.sent.find((message) => message.method === 'session/set_mode').params.modeId, 'full-access');
}

{
  // fx streams a provider failure as text and stops with "refused".
  const turn = [
    update({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: 'HTTP 502: {"error":{"message":"Insufficient credits.","type":"insufficient_credits"}}' },
    }),
  ];
  turn.result = { stopReason: 'refused', usage: {} };
  const { events } = await runDriver({
    routes: [{ provider: 'durango', model: 'anthropic/claude-sonnet-5.5', label: 'Durango credits' }],
    respond: baseRespond,
    turn,
  });
  assert.match(events.fatal, /Out of Durango credits/);
}

{
  // No route fx accepts: fail with every reason.
  const { events } = await runDriver({
    routes: [{ provider: 'codex', model: 'gpt-6-astra', label: 'ChatGPT subscription' }],
    respond: (message) =>
      message.method === 'session/set_config_option'
        ? { error: { code: -32600, message: 'fx needs a Codex subscription login for this model.' } }
        : baseRespond(message),
    turn: [],
  });
  assert.match(events.fatal, /ChatGPT subscription: fx needs a Codex subscription login/);
}

// --- Steering ---------------------------------------------------------------

// A fake fx whose turn stays open until `endTurn()`; steering requests are
// answered by `onSteer` (immediately, or only when the turn ends).
const startSteerableTurn = ({ steering = true, onSteer }) => {
  const sent = [];
  const notices = [];
  let driver;
  let promptId = null;
  const heldSteers = [];
  const deliver = (message) => queueMicrotask(() => driver.handleMessage(message));
  const child = {
    stdin: {
      write(line) {
        const message = JSON.parse(line);
        sent.push(message);
        if (!message.method) return;
        if (message.method === 'initialize') {
          deliver({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: { _meta: { fx: { steering } } } } });
        } else if (message.method === 'session/new') {
          deliver({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fx-session' } });
        } else if (message.method === 'session/prompt' && message.params?._meta?.fx?.steer) {
          const reply = onSteer(message);
          if (reply === 'hold') heldSteers.push(message.id);
          else deliver({ jsonrpc: '2.0', id: message.id, ...reply });
        } else if (message.method === 'session/prompt') {
          promptId = message.id;
        } else {
          deliver({ jsonrpc: '2.0', id: message.id, result: null });
        }
      },
    },
  };
  let turnEnded;
  const ended = new Promise((resolve) => {
    turnEnded = resolve;
  });
  driver = createFxAcpDriver({
    child,
    cwd: workspace,
    promptText: 'Long task',
    resumeSessionId: null,
    accessMode: 'full-access',
    routes: [{ provider: 'durango', model: 'anthropic/claude-sonnet-5.5', label: 'Durango credits' }],
    callbacks: {
      onSessionId: () => {},
      onReasoning: () => {},
      onActivity: () => {},
      onText: () => {},
      onNotice: (notice) => notices.push(notice),
      onTurnEnd: () => turnEnded(),
      onFatal: (message) => turnEnded(message),
    },
  });
  driver.start();
  const promptSent = async () => {
    while (promptId === null) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const endTurn = (steeringOutcome = 'absorbed') => {
    for (const id of heldSteers) {
      deliver({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', _meta: { fx: { steering: steeringOutcome } } } });
    }
    deliver({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    return ended;
  };
  return { driver, sent, notices, promptSent, endTurn };
};

{
  // Accepted steer: fx holds its answer until the turn ends, so silence means taken.
  const turn = startSteerableTurn({ onSteer: () => 'hold' });
  await turn.promptSent();
  assert.equal(await turn.driver.steer('Also update the README', []), true);
  const steerRequest = turn.sent.find((message) => message.params?._meta?.fx?.steer === true);
  assert.equal(steerRequest.params.sessionId, 'fx-session');
  assert.deepEqual(steerRequest.params.prompt, [{ type: 'text', text: 'Also update the README' }]);
  await turn.endTurn('absorbed');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(turn.notices, [], 'an absorbed steer posts no notice');
  assert.equal(await turn.driver.steer('Too late', []), false, 'no steering once the turn has ended');
}

{
  // An accepted steer fx later reports as not absorbed is surfaced, not dropped.
  const turn = startSteerableTurn({ onSteer: () => 'hold' });
  await turn.promptSent();
  assert.equal(await turn.driver.steer('Use tabs', []), true);
  await turn.endTurn('dropped');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(turn.notices.join(''), /couldn't apply a steering message/);
}

{
  // An immediate rejection makes the caller queue the message instead.
  const turn = startSteerableTurn({ onSteer: () => ({ error: { code: -32602, message: 'Unsupported image' } }) });
  await turn.promptSent();
  assert.equal(await turn.driver.steer('Look at this', []), false);
  await turn.endTurn();
}

{
  // An fx build without the steering capability never gets a steer.
  const turn = startSteerableTurn({ steering: false, onSteer: () => 'hold' });
  await turn.promptSent();
  assert.equal(await turn.driver.steer('Hello', []), false);
  assert.ok(!turn.sent.some((message) => message.params?._meta?.fx?.steer), 'nothing is sent');
  await turn.endTurn();
}

await rm(workspace, { recursive: true, force: true });
console.log('fx provider tests passed');
app.exit(0);
