// Bot replies on this machine's other harnesses (src/main/bot-harness-lanes.js
// and bot-harness-models.js): Codex app-server, ACP (Antigravity, Grok) and
// Muse exec, each faked as a child process speaking its protocol. Covers the
// model mapping and presence, the bot tools' MCP hand-off, streamed messages,
// mid-turn steering, pre-finish inbox folding, kept sessions and resume, and
// the fallback to the next place.
//
//   node --no-warnings scripts/test-bot-harness-lanes.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

import {
  BOT_LOCAL_CLAUDE_WILDCARD,
  durangoIdForHarnessModel,
  grokOrMuseBotEffort,
  harnessModelFor,
  localBotModelHarnesses,
  localBotModelIds,
} from '../src/main/bot-harness-models.js';
import {
  HarnessError,
  botInstructionsBlock,
  isApiErrorAnswer,
  isApiLimitError,
  createAcpBotHarness,
  createCodexBotHarness,
  createHarnessLaneRunner,
  createMuseBotHarness,
  isHarnessUnavailableError,
} from '../src/main/bot-harness-lanes.js';
import { BOT_FINAL_INBOX_HEADER, BOT_INBOX_HEADER, createBotSessionStore, presenceOf } from '../src/main/bot-replies.js';
import { normalizeBotLane } from '../src/main/durango-client.js';
import { mergeDesktopBotModelCatalog } from '../src/main/bot-models.js';

const require = createRequire(import.meta.url);
const { createOrionMcpBridgeHandler } = require('../src/mcp-bridge-shim.cjs');

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'durango-bot-harness-'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n${error?.stack ?? error}`);
  }
};

// --- a fake harness process --------------------------------------------------------
// `serve(message, peer)` sees every JSON line the client writes; peer.send()
// writes a line back (a response, a notification or a request).
const fakeChild = (serve) => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  const peer = {
    send: (message) => {
      if (!child.killed) child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    },
    reply: (message, result) => peer.send({ id: message.id, result }),
    fail: (message, error) => peer.send({ id: message.id, error }),
    exit: (code = 0) => {
      if (child.killed) return;
      child.killed = true;
      child.exitCode = code;
      child.emit('exit', code);
      child.emit('close', code);
    },
  };
  let buffer = '';
  child.stdin.on('data', (data) => {
    buffer += data.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) void serve(JSON.parse(line), peer);
    }
  });
  child.kill = () => peer.exit(null);
  return child;
};

const lane = (overrides = {}) => ({
  laneId: 'lane_1',
  botId: 'bot_1',
  botName: 'Helper',
  threadId: 'thread_1',
  replyMessageId: 'reply_1',
  model: null,
  modelId: 'openai/gpt-6.1-sol',
  reasoningEffort: 'high',
  systemPrompt: 'You are Helper, the person’s bot.',
  prompt: '',
  session: { history: [{ id: 'm1', seq: 1, role: 'user', text: 'Hi there' }], answering: [1], context: [] },
  tools: [{ name: 'web_search', description: 'Search the web', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
  heartbeatMs: 10_000,
  messages: true,
  attachments: [],
  threads: 'machine',
  ...overrides,
});

// The bot tools' MCP server, as registerBotToolsBridge hands it out (the call is kept for tests).
const fakeRegistry = () => {
  const registry = { registered: [], released: 0 };
  registry.register = async ({ tools, call }) => {
    registry.registered.push({ tools, call });
    return {
      command: '/fake/electron',
      args: ['/fake/shim.cjs', '--socket', '/fake.sock', '--token', 'tok', '--bot-tools'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      release: () => {
        registry.released += 1;
      },
    };
  };
  return registry;
};

const ctxFor = ({ inbox = [], beforeFinish = [], tool = async () => ({ result: { ok: true } }) } = {}) => {
  const ctx = {
    updates: [],
    messages: [],
    calls: [],
    takes: [],
    accessMode: 'full-access',
    update: (state) => ctx.updates.push(state),
    takeInbox: async (options) => {
      ctx.takes.push(options ?? {});
      if (options?.beforeFinish) return beforeFinish.shift() ?? [];
      return inbox.shift() ?? [];
    },
    callTool: async (call) => {
      ctx.calls.push(call);
      return await tool(call);
    },
    sendMessage: async (message) => {
      ctx.messages.push(message);
      return true;
    },
  };
  return ctx;
};

const runnerFor = ({ harnesses, registry = fakeRegistry(), sessions = null, resolved, onUnavailable = () => {} }) =>
  createHarnessLaneRunner({
    resolveModel: async (item) =>
      resolved ??
      (item.modelId === 'openai/gpt-6.1-sol'
        ? { providerId: 'codex', model: { slug: 'gpt-6.1-sol' }, effort: 'high' }
        : item.modelId === 'google/gemini-4-neon'
          ? { providerId: 'antigravity', model: { slug: 'gemini-4-neon', acpModelId: 'gemini-4-neon-high' }, effort: 'high' }
          : item.modelId === 'x-ai/grok-4.7'
            ? { providerId: 'grok', model: { slug: 'grok-4.7' }, effort: 'high' }
            : item.modelId === 'meta/muse-spark-1.3'
              ? { providerId: 'muse', model: { slug: 'muse-spark-1.3' }, effort: 'high' }
              : null),
    harnesses,
    registerTools: registry.register,
    botsDir: path.join(testRoot, 'bots'),
    getProjects: () => [{ name: 'durango', path: testRoot }],
    sessions,
    onUnavailable,
    log: () => {},
  });

// --- a fake `codex app-server` -------------------------------------------------------
// script(turnIndex, text, api): what one turn does; api.delta / api.tool / api.callBotTool / api.complete.
const fakeCodex = ({ script, registry, onStart = () => {}, resumeError = null, initError = null } = {}) => {
  const seen = [];
  let turnIndex = 0;
  const spawned = [];
  const spawnProcess = (argv, options) => {
    spawned.push({ argv, options });
    let threadId = null;
    let turn = null;
    const child = fakeChild(async (message, peer) => {
      seen.push(message);
      const notify = (method, params) => peer.send({ method, params: { threadId, ...params } });
      if (message.method === 'initialize') return initError ? peer.fail(message, initError) : peer.reply(message, { userAgent: 'codex' });
      if (message.method === 'thread/start') {
        onStart(message.params);
        threadId = 'thr_fresh';
        return peer.reply(message, { thread: { id: threadId } });
      }
      if (message.method === 'thread/resume') {
        if (resumeError) return peer.fail(message, resumeError);
        threadId = message.params.threadId;
        return peer.reply(message, { thread: { id: threadId } });
      }
      if (message.method === 'turn/start') {
        const index = turnIndex++;
        const id = `turn_${index}`;
        turn = { id, steers: [] };
        peer.reply(message, { turn: { id } });
        notify('turn/started', { turn: { id } });
        let item = 0;
        const api = {
          turn,
          delta: (text) => {
            notify('item/started', { item: { type: 'agentMessage', id: `msg_${index}_${(item += 1)}` } });
            notify('item/agentMessage/delta', { itemId: `msg_${index}_${item}`, delta: text });
          },
          tool: async (name, run = async () => {}) => {
            const toolId = `tool_${index}_${(item += 1)}`;
            notify('item/started', { item: { type: 'mcpToolCall', id: toolId, server: 'durango_bot', tool: name } });
            await run();
            notify('item/completed', { item: { type: 'mcpToolCall', id: toolId } });
          },
          callBotTool: (name, args) => registry.registered.at(-1).call(name, args),
          usage: (inputTokens, outputTokens) => notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens, outputTokens, cachedInputTokens: 0 } } }),
          complete: (status = 'completed', error = null) => notify('turn/completed', { turn: { id, status, ...(error ? { error } : {}) } }),
        };
        await delay(1);
        await script(index, message.params.input[0].text, api);
        return;
      }
      if (message.method === 'turn/steer') {
        turn?.steers.push(message.params.input[0].text);
        return peer.reply(message, { turnId: message.params.expectedTurnId });
      }
      if (message.id !== undefined && message.method) peer.reply(message, {});
    });
    return child;
  };
  return { spawnProcess, seen, spawned, get turns() {
    return turnIndex;
  } };
};

// --- tests ---------------------------------------------------------------------------

await test('harness models map to Durango ids and back', () => {
  assert.equal(durangoIdForHarnessModel({ providerId: 'codex', slug: 'gpt-6.1-sol' }), 'openai/gpt-6.1-sol');
  assert.equal(durangoIdForHarnessModel({ providerId: 'antigravity', slug: 'gemini-4-neon' }), 'google/gemini-4-neon');
  // Antigravity also hosts Claude: those are Claude Code's.
  assert.equal(durangoIdForHarnessModel({ providerId: 'antigravity', slug: 'claude-opus-5-5' }), null);
  assert.equal(durangoIdForHarnessModel({ providerId: 'grok', slug: 'grok-4.7' }), 'x-ai/grok-4.7');
  assert.equal(durangoIdForHarnessModel({ providerId: 'muse', slug: 'muse-spark-1.3' }), 'meta/muse-spark-1.3');
  assert.equal(durangoIdForHarnessModel({ providerId: 'muse', slug: 'muse-wonder-1.0' }), 'meta/muse-wonder');
  assert.equal(durangoIdForHarnessModel({ providerId: 'kimi', slug: 'k3' }), null);
  const models = [
    { id: 'claude:claude-opus-5-5', providerId: 'claude', slug: 'claude-opus-5-5', available: true },
    { id: 'codex:gpt-6.1-sol', providerId: 'codex', slug: 'gpt-6.1-sol', available: true },
    { id: 'antigravity:gemini-4-neon', providerId: 'antigravity', slug: 'gemini-4-neon', available: true },
    { id: 'grok:grok-4.7', providerId: 'grok', slug: 'grok-4.7', available: false },
    { id: 'muse:muse-wonder-1.0', providerId: 'muse', slug: 'muse-wonder-1.0', available: true },
  ];
  assert.deepEqual(localBotModelIds(models), [BOT_LOCAL_CLAUDE_WILDCARD, 'google/gemini-4-neon', 'meta/muse-wonder', 'openai/gpt-6.1-sol']);
  // A harness that's down (signed out, a limit) isn't advertised.
  assert.deepEqual(localBotModelIds(models, { down: (id) => id === 'codex' }), [BOT_LOCAL_CLAUDE_WILDCARD, 'google/gemini-4-neon', 'meta/muse-wonder']);
  assert.equal(harnessModelFor(models, 'google/gemini-4-neon').providerId, 'antigravity');
  assert.equal(harnessModelFor(models, 'meta/muse-wonder').model.slug, 'muse-wonder-1.0');
  assert.equal(harnessModelFor(models, 'x-ai/grok-4.7'), null, 'not installed');
  assert.equal(harnessModelFor(models, 'anthropic/claude-opus-5.5'), null, 'Claude runs on Claude Code');
  assert.equal(localBotModelHarnesses(models).get('openai/gpt-6.1-sol'), 'Codex');
});

await test('the claim presence carries localModels and lanes keep their Durango modelId', () => {
  const presence = presenceOf({ name: 'Mac', projects: [], models: ['claude-opus-5-5'], localModels: [BOT_LOCAL_CLAUDE_WILDCARD, 'openai/gpt-6.1-sol'] });
  assert.deepEqual(presence.localModels, [BOT_LOCAL_CLAUDE_WILDCARD, 'openai/gpt-6.1-sol']);
  assert.equal('localModels' in presenceOf({ name: 'Mac', projects: [], models: [] }), false);
  assert.equal(normalizeBotLane({ laneId: 'l', botId: 'b', modelId: 'google/gemini-4-neon' }).modelId, 'google/gemini-4-neon');
  assert.equal(normalizeBotLane({ laneId: 'l', botId: 'b' }).modelId, null);
});

await test('the picker lists harness models as Local, with the harness that runs them', () => {
  const catalog = mergeDesktopBotModelCatalog({
    mode: 'durango',
    modelChoices: [
      { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5', note: '', claude: true },
      { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', note: '', claude: false },
      { id: 'google/gemini-4-neon', label: 'Gemini 4 Neon', note: '', claude: false },
    ],
    modelCatalog: [{ id: 'x-ai/grok-4.7', label: 'Grok 4.7', note: '', claude: false }],
    localHarnessModels: new Map([['openai/gpt-6.1-sol', 'Codex'], ['google/gemini-4-neon', 'Antigravity']]),
  });
  const byId = Object.fromEntries(catalog.map((choice) => [choice.id, choice]));
  assert.equal(byId['anthropic/claude-opus-5.5'].local, true);
  assert.equal(byId['openai/gpt-6.1-sol'].local, true);
  assert.equal(byId['openai/gpt-6.1-sol'].localVia, 'Codex');
  assert.equal(byId['google/gemini-4-neon'].localVia, 'Antigravity');
  assert.equal(byId['x-ai/grok-4.7'].local, false, 'Grok not installed here: Cloud');
});

await test('the bridge shim in bot mode lists only the bot tools as durango_bot', async () => {
  const handler = createOrionMcpBridgeHandler({
    botTools: true,
    compactTools: true,
    callOrion: async (tool, args) =>
      tool === '__tools'
        ? { ok: true, text: '', tools: [{ name: 'web_search', description: 'Search', inputSchema: { type: 'object', properties: {} } }] }
        : { ok: true, text: `ran ${tool} ${JSON.stringify(args)}` },
  });
  const init = await handler.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'durango_bot');
  const list = await handler.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ['web_search'], 'no spawn_subagent, no load_tools');
  const call = await handler.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'web_search', arguments: { q: 1 } } });
  assert.equal(call.result.content[0].text, 'ran web_search {"q":1}');
});

await test('codex: a reply streams as messages, bot tools run through MCP, the session is kept and resumed', async () => {
  const registry = fakeRegistry();
  let started = null;
  const codex = fakeCodex({
    registry,
    onStart: (params) => {
      started = params;
    },
    script: async (index, text, api) => {
      if (index === 0) {
        assert.match(text, /Hi there/);
        api.delta('On it, searching.');
        await api.tool('web_search', async () => {
          const result = await api.callBotTool('web_search', { query: 'weather' });
          assert.equal(result.ok, true);
        });
        api.delta('It is sunny.');
        api.usage(1200, 80);
        api.complete();
      } else {
        assert.doesNotMatch(text, /Hi there/, 'a kept session gets only what it has not seen');
        assert.match(text, /And tomorrow\?/);
        api.delta('Rain tomorrow.');
        api.complete();
      }
    },
  });
  const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-codex') });
  const runner = runnerFor({ harnesses: { codex: createCodexBotHarness({ spawnProcess: codex.spawnProcess }) }, registry, sessions });
  const ctx = ctxFor();
  const outcome = await runner(lane(), ctx);
  assert.equal(outcome.failure, undefined, outcome.failure);
  assert.equal(outcome.text, 'It is sunny.');
  assert.equal(outcome.sent, 1);
  assert.equal(outcome.modelId, 'openai/gpt-6.1-sol');
  assert.deepEqual(ctx.messages.map((message) => message.text), ['On it, searching.']);
  assert.equal(ctx.calls[0].name, 'web_search');
  assert.equal(ctx.calls[0].message, 0, 'the card goes on the message it was called with');
  assert.equal(started.model, 'gpt-6.1-sol');
  assert.equal(started.sandbox, 'danger-full-access');
  assert.match(started.developerInstructions, /You are Helper/);
  assert.equal(started.config['mcp_servers.durango_bot.command'], '/fake/electron');
  assert.equal(started.config['mcp_servers.durango_bot.default_tools_approval_mode'], 'approve');
  assert.equal(started.config.model_reasoning_effort, 'high');
  assert.deepEqual(registry.registered[0].tools.map((tool) => tool.name), ['web_search', 'attach_files']);
  assert.equal(registry.released, 1, 'the MCP server is released when the reply ends');
  assert.ok(ctx.updates.some((state) => state.activeTool === 'web_search'), 'the running tool shows');

  const second = await runner(
    lane({
      laneId: 'lane_2',
      replyMessageId: 'reply_2',
      session: {
        history: [
          { id: 'm1', seq: 1, role: 'user', text: 'Hi there' },
          { id: 'reply_1', seq: 2, role: 'assistant', text: 'It is sunny.' },
          { id: 'm3', seq: 3, role: 'user', text: 'And tomorrow?' },
        ],
        answering: [3],
        context: [],
      },
    }),
    ctxFor()
  );
  assert.equal(second.text, 'Rain tomorrow.');
  assert.ok(codex.seen.some((message) => message.method === 'thread/resume' && message.params.threadId === 'thr_fresh'), 'resumed the kept thread');
});

await test('codex: messages that arrive mid-turn are steered in; ones before the final answer get another turn', async () => {
  const registry = fakeRegistry();
  const codex = fakeCodex({
    registry,
    script: async (index, text, api) => {
      if (index === 0) {
        api.delta('Looking.');
        await api.tool('web_search', async () => {
          await delay(20);
        });
        await delay(30);
        assert.equal(api.turn.steers.length, 1, 'steered after the tool result');
        assert.ok(api.turn.steers[0].startsWith(BOT_INBOX_HEADER));
        assert.match(api.turn.steers[0], /also check Paris/);
        api.delta('Draft answer.');
        api.complete();
      } else {
        assert.ok(text.startsWith('(Bot inbox: arrived before your final answer'), 'the draft was replaced');
        assert.match(text, /one more thing/);
        api.delta('Final answer covering both.');
        api.complete();
      }
    },
  });
  const runner = runnerFor({ harnesses: { codex: createCodexBotHarness({ spawnProcess: codex.spawnProcess }) }, registry });
  const ctx = ctxFor({
    inbox: [[{ seq: 5, source: 'person', content: 'also check Paris' }]],
    beforeFinish: [[{ seq: 6, source: 'person', content: 'one more thing' }]],
  });
  const outcome = await runner(lane(), ctx);
  assert.equal(outcome.failure, undefined, outcome.failure);
  assert.equal(outcome.text, 'Final answer covering both.');
  assert.ok(!outcome.text.includes('Draft answer'));
  assert.ok(ctx.takes.some((options) => options.beforeFinish), 'checked the inbox before posting');
  assert.ok(BOT_FINAL_INBOX_HEADER.startsWith('(Bot inbox: arrived before your final answer'));
});

await test('codex: a broken kept session starts over fresh; signed out moves the reply elsewhere', async () => {
  const registry = fakeRegistry();
  const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-broken') });
  const ok = fakeCodex({ registry, script: async (_i, _t, api) => (api.delta('First.'), api.complete()) });
  await runnerFor({ harnesses: { codex: createCodexBotHarness({ spawnProcess: ok.spawnProcess }) }, registry, sessions })(lane(), ctxFor());
  const broken = fakeCodex({ registry, resumeError: { message: 'no rollout found for thread' }, script: async (_i, text, api) => (assert.match(text, /Hi there/), api.delta('Fresh.'), api.complete()) });
  const next = lane({
    laneId: 'lane_b',
    replyMessageId: 'reply_b',
    session: { history: [{ id: 'm1', seq: 1, role: 'user', text: 'Hi there' }, { id: 'reply_1', seq: 2, role: 'assistant', text: 'First.' }, { id: 'm3', seq: 3, role: 'user', text: 'Again' }], answering: [3], context: [] },
  });
  const outcome = await runnerFor({ harnesses: { codex: createCodexBotHarness({ spawnProcess: broken.spawnProcess }) }, registry, sessions })(next, ctxFor());
  assert.equal(outcome.text, 'Fresh.');
  assert.ok(broken.seen.some((message) => message.method === 'thread/start'), 'started a fresh thread');

  const down = [];
  const signedOut = fakeCodex({ registry, script: async (_i, _t, api) => api.complete('failed', { message: 'Not logged in. Run codex login.' }) });
  const failed = await runnerFor({
    harnesses: { codex: createCodexBotHarness({ spawnProcess: signedOut.spawnProcess }) },
    registry,
    onUnavailable: (provider, reason) => down.push([provider, reason]),
  })(lane(), ctxFor());
  assert.equal(failed.retryElsewhere, true);
  assert.match(failed.failure, /Not logged in/);
  assert.equal(down[0][0], 'codex', 'left out of the presence for a while');
});

await test('no harness here for the model, or the CLI is missing: the reply moves on', async () => {
  const runner = runnerFor({ harnesses: {}, resolved: null });
  const outcome = await runner(lane({ modelId: 'mistral/large' }), ctxFor());
  assert.equal(outcome.retryElsewhere, true);
  const missing = createCodexBotHarness({
    spawnProcess: () => {
      const child = fakeChild(() => {});
      setTimeout(() => child.emit('error', new Error('spawn codex ENOENT')), 1);
      return child;
    },
    handshakeTimeoutMs: 500,
  });
  const gone = await runnerFor({ harnesses: { codex: missing } })(lane(), ctxFor());
  assert.equal(gone.retryElsewhere, true);
  assert.ok(isHarnessUnavailableError('spawn codex ENOENT'));
  assert.ok(new HarnessError('x', { retryElsewhere: true }).retryElsewhere);
});

// --- ACP ----------------------------------------------------------------------------
const fakeAcp = ({ provider, caps = {}, onPrompt, registry, loadable = true }) => {
  const seen = [];
  const spawned = [];
  const spawnProcess = (argv, options) => {
    spawned.push({ argv, options });
    let prompts = [];
    const child = fakeChild(async (message, peer) => {
      seen.push(message);
      const update = (u) => peer.send({ method: 'session/update', params: { sessionId: 'ses_1', update: u } });
      if (message.method === 'initialize') return peer.reply(message, { protocolVersion: 1, agentCapabilities: caps });
      if (message.method === 'session/new') return peer.reply(message, { sessionId: 'ses_1' });
      if (message.method === 'session/resume') return caps.sessionCapabilities?.resume && loadable ? peer.reply(message, {}) : peer.fail(message, { message: 'no' });
      if (message.method === 'session/load') {
        if (!loadable) return peer.fail(message, { message: 'Session not found' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED OLD TEXT' } });
        return peer.reply(message, {});
      }
      if (message.method === 'session/set_model') return peer.reply(message, {});
      if (message.method === 'session/prompt') {
        prompts.push(message);
        await onPrompt({ message, prompts, peer, update, callBotTool: (name, args) => registry.registered.at(-1).call(name, args) });
        return;
      }
      if (message.id !== undefined && message.method) peer.reply(message, {});
    });
    return child;
  };
  return { spawnProcess, seen, spawned };
};

await test('antigravity over ACP: instructions via its advertised systemPrompt extension, MCP in session/new, set_model, streamed tools', async () => {
  const registry = fakeRegistry();
  const agy = fakeAcp({
    provider: 'antigravity',
    registry,
    caps: { loadSession: true, sessionCapabilities: { resume: {}, additionalDirectories: {} }, _meta: { antigravity: { systemPrompt: { append: true } } } },
    onPrompt: async ({ message, peer, update, callBotTool }) => {
      assert.ok(!message.params.prompt[0].text.includes('<bot_instructions>'), 'instructions went in natively');
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking.' } });
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run mcp_durango_bot_web_search', status: 'in_progress' });
      await callBotTool('web_search', { query: 'x' });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done: 42.' } });
      peer.reply(message, { stopReason: 'end_turn', usage: { inputTokens: 900, outputTokens: 20, cachedReadTokens: 400, totalTokens: 920 } });
    },
  });
  const ctx = ctxFor();
  const outcome = await runnerFor({ harnesses: { antigravity: createAcpBotHarness({ provider: 'antigravity', spawnProcess: agy.spawnProcess }) }, registry })(
    lane({ modelId: 'google/gemini-4-neon' }),
    ctx
  );
  assert.equal(outcome.failure, undefined, outcome.failure);
  assert.equal(outcome.text, 'Done: 42.');
  assert.deepEqual(ctx.messages.map((m) => m.text), ['Checking.']);
  assert.deepEqual(agy.spawned[0].argv, ['agy', 'acp', '--dangerously-skip-permissions']);
  const created = agy.seen.find((m) => m.method === 'session/new').params;
  assert.match(created._meta.antigravity.systemPrompt.append, /You are Helper/);
  assert.deepEqual(created.mcpServers[0], { name: 'durango_bot', command: '/fake/electron', args: ['/fake/shim.cjs', '--socket', '/fake.sock', '--token', 'tok', '--bot-tools'], env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] });
  assert.deepEqual(created.additionalDirectories, [testRoot]);
  assert.equal(agy.seen.find((m) => m.method === 'session/set_model').params.modelId, 'gemini-4-neon-high');
  assert.equal(outcome.usage.cacheRead, 400);
  // Only ACP methods: nothing else was ever sent.
  assert.deepEqual([...new Set(agy.seen.filter((m) => m.method).map((m) => m.method))].sort(), ['initialize', 'session/new', 'session/prompt', 'session/set_model']);
});

await test('antigravity: a message mid-turn goes in as a steer prompt; the newest prompt ends the turn', async () => {
  const registry = fakeRegistry();
  const agy = fakeAcp({
    provider: 'antigravity',
    registry,
    caps: { _meta: { antigravity: { systemPrompt: { append: true } } } },
    onPrompt: async ({ message, prompts, peer, update }) => {
      if (prompts.length === 1) {
        update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', status: 'in_progress' });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
        return; // answered when the steer arrives
      }
      assert.ok(message.params.prompt[0].text.startsWith(BOT_INBOX_HEADER));
      peer.reply(prompts[0], { stopReason: 'end_turn' });
      await delay(5);
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Answered both.' } });
      peer.reply(message, { stopReason: 'end_turn' });
    },
  });
  const ctx = ctxFor({ inbox: [[{ seq: 9, source: 'person', content: 'and the other file' }]] });
  const outcome = await runnerFor({ harnesses: { antigravity: createAcpBotHarness({ provider: 'antigravity', spawnProcess: agy.spawnProcess }) }, registry })(
    lane({ modelId: 'google/gemini-4-neon' }),
    ctx
  );
  assert.equal(outcome.failure, undefined, outcome.failure);
  assert.equal(outcome.text, 'Answered both.');
  assert.equal(agy.seen.filter((m) => m.method === 'session/prompt').length, 2);
});

await test('antigravity: an upstream error reported as the answer moves the reply (and marks agy down)', async () => {
  const registry = fakeRegistry();
  const down = [];
  const agy = fakeAcp({
    provider: 'antigravity',
    registry,
    caps: {},
    onPrompt: async ({ message, peer, update }) => {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Error 429, Message: Resource has been exhausted (reason:QUOTA_EXHAUSTED), Status: RESOURCE_EXHAUSTED' } });
      peer.reply(message, { stopReason: 'end_turn' });
    },
  });
  const outcome = await runnerFor({
    harnesses: { antigravity: createAcpBotHarness({ provider: 'antigravity', spawnProcess: agy.spawnProcess }) },
    registry,
    onUnavailable: (provider) => down.push(provider),
  })(lane({ modelId: 'google/gemini-4-neon', messages: false }), { ...ctxFor(), sendMessage: undefined });
  assert.equal(outcome.retryElsewhere, true);
  assert.equal(outcome.text, '', 'the error line is never posted as the reply (Durango only moves a reply with no text)');
  assert.deepEqual(down, ['antigravity']);
});

await test('only a whole-answer agy error line counts as an API error; a reply about one does not', () => {
  assert.equal(isApiErrorAnswer('Error 429, Message: Resource has been exhausted (e.g. check quota)., Status: RESOURCE_EXHAUSTED'), true);
  assert.equal(isApiErrorAnswer('UNAVAILABLE (code 503): The model is overloaded.'), true);
  assert.equal(isApiErrorAnswer('The log shows reason:QUOTA_EXHAUSTED at 10:02, so the job hit its quota.'), false);
  assert.equal(isApiErrorAnswer('Here is what happened:\n\nError 429, Message: x, Status: RESOURCE_EXHAUSTED'), false, 'more than the error line');
  assert.equal(isApiErrorAnswer('Error 429, Message: x, Status: RESOURCE_EXHAUSTED', 1), false, 'a tool ran this turn');
  assert.equal(isApiLimitError('Error 429, Message: x, Status: RESOURCE_EXHAUSTED'), true);
  assert.equal(isApiLimitError('INVALID_ARGUMENT (code 400): bad request'), false);
});

await test('antigravity: a reply that talks about a quota error is posted, not treated as one', async () => {
  const registry = fakeRegistry();
  const down = [];
  const agy = fakeAcp({
    provider: 'antigravity',
    registry,
    caps: {},
    onPrompt: async ({ message, peer, update }) => {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Your job failed with reason:QUOTA_EXHAUSTED; raise the quota.' } });
      peer.reply(message, { stopReason: 'end_turn' });
    },
  });
  const outcome = await runnerFor({ harnesses: { antigravity: createAcpBotHarness({ provider: 'antigravity', spawnProcess: agy.spawnProcess }) }, registry, onUnavailable: (p) => down.push(p) })(
    lane({ modelId: 'google/gemini-4-neon' }),
    ctxFor()
  );
  assert.equal(outcome.failure, undefined);
  assert.match(outcome.text, /raise the quota/);
  assert.deepEqual(down, []);
});

await test('antigravity: a steer agy refuses, at once or later, folds its message into the final answer (nothing lost)', async () => {
  for (const late of [false, true]) {
    const registry = fakeRegistry();
    const agy = fakeAcp({
      provider: 'antigravity',
      registry,
      caps: {},
      onPrompt: async ({ message, prompts, peer, update }) => {
        const text = message.params.prompt[0].text;
        if (prompts.length === 1) {
          update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', status: 'in_progress' });
          update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
          return; // answered once the steer is dealt with
        }
        if (prompts.length === 2) {
          assert.ok(text.startsWith(BOT_INBOX_HEADER), 'the steer');
          if (late) {
            peer.reply(prompts[0], { stopReason: 'end_turn' });
            await delay(30);
          }
          peer.fail(message, { message: 'already processing' });
          if (!late) {
            await delay(5);
            update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Draft.' } });
            peer.reply(prompts[0], { stopReason: 'end_turn' });
          }
          return;
        }
        // The folded round: the person's message reaches the final answer.
        assert.match(text, /and the other file/);
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Both covered.' } });
        peer.reply(message, { stopReason: 'end_turn' });
      },
    });
    const ctx = ctxFor({ inbox: [[{ seq: 9, source: 'person', content: 'and the other file' }]] });
    const outcome = await runnerFor({ harnesses: { antigravity: createAcpBotHarness({ provider: 'antigravity', spawnProcess: agy.spawnProcess }) }, registry })(
      lane({ modelId: 'google/gemini-4-neon' }),
      ctx
    );
    assert.equal(outcome.failure, undefined, `${late ? 'late' : 'immediate'}: ${outcome.failure}`);
    assert.equal(outcome.text, 'Both covered.');
    // The waiting message got the next round as it was; only that round's end checked the inbox.
    assert.equal(ctx.takes.filter((options) => options.beforeFinish).length, 1);
  }
});

await test('antigravity: its ask_question prompts are cancelled, never answered with option 1', async () => {
  const registry = fakeRegistry();
  const answers = [];
  const agy = fakeAcp({
    provider: 'antigravity',
    registry,
    caps: {},
    onPrompt: async ({ message, peer, update }) => {
      const ask = (id, toolCallId, options) =>
        new Promise((resolve) => {
          peer.onResponse = peer.onResponse ?? new Map();
          answers.push({ id, resolve });
          peer.send({ id, method: 'session/request_permission', params: { sessionId: 'ses_1', toolCall: { toolCallId }, options } });
        });
      peer.send({ id: 'q1', method: 'session/request_permission', params: { sessionId: 'ses_1', toolCall: { toolCallId: 'interaction_1', title: 'Which?' }, options: [{ optionId: 'a', name: 'Option A' }, { optionId: 'b', name: 'Option B' }] } });
      peer.send({ id: 'q2', method: 'session/request_permission', params: { sessionId: 'ses_1', toolCall: { toolCallId: 'call_2' }, options: [{ optionId: 'no', kind: 'reject_once', name: 'No' }, { optionId: 'yes', kind: 'allow_once', name: 'Yes' }] } });
      peer.send({ id: 'q3', method: 'session/request_permission', params: { sessionId: 'ses_1', toolCall: { toolCallId: 'call_3' }, options: [{ optionId: 'x', name: 'Something' }] } });
      await delay(30);
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Asked in my reply instead.' } });
      peer.reply(message, { stopReason: 'end_turn' });
    },
  });
  await runnerFor({ harnesses: { antigravity: createAcpBotHarness({ provider: 'antigravity', spawnProcess: agy.spawnProcess }) }, registry })(lane({ modelId: 'google/gemini-4-neon' }), ctxFor());
  const replies = Object.fromEntries(agy.seen.filter((m) => m.id === 'q1' || m.id === 'q2' || m.id === 'q3').map((m) => [m.id, m.result.outcome]));
  assert.deepEqual(replies.q1, { outcome: 'cancelled' });
  assert.deepEqual(replies.q2, { outcome: 'selected', optionId: 'yes' });
  assert.deepEqual(replies.q3, { outcome: 'cancelled' }, 'no allow kind: not picked by position');
});

await test('antigravity: model and thinking level fall back to ACP config options', async () => {
  const registry = fakeRegistry();
  const seenConfig = [];
  const spawnProcess = (argv) =>
    fakeChild(async (message, peer) => {
      if (message.method === 'initialize') return peer.reply(message, { protocolVersion: 1, agentCapabilities: {} });
      if (message.method === 'session/new') return peer.reply(message, { sessionId: 's' });
      if (message.method === 'session/set_model') return peer.fail(message, { message: 'unknown model id' });
      if (message.method === 'session/set_config_option') {
        seenConfig.push(message.params);
        return peer.reply(message, { configOptions: [] });
      }
      if (message.method === 'session/prompt') {
        peer.send({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi.' } } } });
        return peer.reply(message, { stopReason: 'end_turn' });
      }
    });
  const outcome = await runnerFor({
    harnesses: { antigravity: createAcpBotHarness({ provider: 'antigravity', spawnProcess }) },
    registry,
    resolved: { providerId: 'antigravity', model: { slug: 'gemini-4-neon', acpModelId: 'gemini-4-neon-xhigh', antigravityThoughtLevelValues: { xhigh: 'extra_high' } }, effort: 'xhigh' },
  })(lane({ modelId: 'google/gemini-4-neon' }), ctxFor());
  assert.equal(outcome.text, 'Hi.');
  assert.deepEqual(seenConfig, [
    { sessionId: 's', configId: 'model', value: 'gemini-4-neon' },
    { sessionId: 's', configId: 'thought_level', value: 'extra_high' },
  ]);
});

await test('a reply stopped while its harness starts never sends a prompt', async () => {
  const registry = fakeRegistry();
  const abort = new AbortController();
  const seen = [];
  const spawnProcess = () =>
    fakeChild(async (message, peer) => {
      seen.push(message.method);
      if (message.method === 'initialize') {
        abort.abort(); // stopped mid-handshake
        await delay(5);
        return peer.reply(message, { protocolVersion: 1, agentCapabilities: {} });
      }
      if (message.method === 'session/new') return peer.reply(message, { sessionId: 's' });
      if (message.method === 'session/prompt') return peer.reply(message, { stopReason: 'end_turn' });
    });
  const outcome = await runnerFor({ harnesses: { antigravity: createAcpBotHarness({ provider: 'antigravity', spawnProcess }) }, registry })(
    lane({ modelId: 'google/gemini-4-neon' }),
    { ...ctxFor(), signal: abort.signal }
  );
  assert.equal(outcome.aborted, true);
  assert.ok(!seen.includes('session/prompt'), `sent: ${seen.join(', ')}`);
});

await test("bot tools that can't be served move the reply instead of running it toolless", async () => {
  const outcome = await createHarnessLaneRunner({
    resolveModel: async () => ({ providerId: 'codex', model: { slug: 'gpt-6.1-sol' } }),
    harnesses: { codex: { id: 'codex', open: async () => assert.fail('must not open') } },
    registerTools: async () => null,
    botsDir: path.join(testRoot, 'bots'),
    log: () => {},
  })(lane(), ctxFor());
  assert.equal(outcome.retryElsewhere, true);
  assert.equal(outcome.text, '');
});

await test('grok over ACP: instructions open the first prompt, no steering, resume replays nothing into the reply', async () => {
  const registry = fakeRegistry();
  const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-grok') });
  let promptsSeen = [];
  const grok = fakeAcp({
    provider: 'grok',
    registry,
    caps: { loadSession: true },
    onPrompt: async ({ message, peer, update }) => {
      promptsSeen.push(message.params.prompt[0].text);
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Answer ${promptsSeen.length}.` } });
      peer.reply(message, { stopReason: 'end_turn', _meta: { inputTokens: 10, outputTokens: 2 } });
    },
  });
  const harness = createAcpBotHarness({ provider: 'grok', spawnProcess: grok.spawnProcess });
  assert.equal(harness.steers, false);
  const runner = runnerFor({ harnesses: { grok: harness }, registry, sessions });
  const first = await runner(lane({ modelId: 'x-ai/grok-4.7' }), ctxFor());
  assert.equal(first.text, 'Answer 1.');
  assert.ok(promptsSeen[0].startsWith(botInstructionsBlock('You are Helper, the person’s bot.').slice(0, 30)));
  assert.match(promptsSeen[0], /You are Helper/);
  assert.deepEqual(grok.spawned[0].argv, ['grok', '--always-approve', 'agent', '-m', 'grok-4.7', '--reasoning-effort', 'high', 'stdio']);
  const second = await runner(
    lane({
      modelId: 'x-ai/grok-4.7',
      laneId: 'lane_g2',
      replyMessageId: 'reply_g2',
      session: { history: [{ id: 'm1', seq: 1, role: 'user', text: 'Hi there' }, { id: 'reply_1', seq: 2, role: 'assistant', text: 'Answer 1.' }, { id: 'm3', seq: 3, role: 'user', text: 'More' }], answering: [3], context: [] },
    }),
    ctxFor()
  );
  assert.equal(second.text, 'Answer 2.', 'the replayed history never leaks into the reply');
  assert.ok(grok.seen.some((m) => m.method === 'session/load' && m.params.sessionId === 'ses_1'));
  assert.ok(!promptsSeen[1].includes('<bot_instructions>'), 'a resumed session already has them');
});

// --- Muse ---------------------------------------------------------------------------
await test('muse: one exec per prompt, the session goes on with --session-id, tools stream', async () => {
  const registry = fakeRegistry();
  const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-muse') });
  const runs = [];
  const spawnProcess = (argv, options) => {
    const child = fakeChild(() => {});
    runs.push({ argv, options });
    setTimeout(async () => {
      const line = (value) => child.stdout.write(`${JSON.stringify({ stream: { kind: 'session', id: 'muse_ses' }, ...value })}\n`);
      const file = argv[argv.indexOf('--prompt-file') + 1];
      const prompt = await fs.readFile(file, 'utf8');
      line({ payload_type: 'run.output.delta', payload: { text: 'Hmm.' } });
      line({ payload_type: 'task.lifecycle.proposed', payload: { task_id: 'k1', event: { task_kind: 'tool.durango_bot__web_search' } } });
      line({ payload_type: 'task.lifecycle.completed', payload: { task_id: 'k1', event: {} } });
      line({ payload_type: 'run.output.delta', payload: { text: prompt.includes('<bot_instructions>') ? 'Fresh run.' : 'Resumed run.' } });
      line({ payload_type: 'run.terminal.completed', payload: { terminal: 'completed', text: 'x' } });
      child.emit('exit', 0);
      child.emit('close', 0);
    }, 2);
    return child;
  };
  const runner = runnerFor({ harnesses: { muse: createMuseBotHarness({ spawnProcess, museEnv: async (mcp) => ({ XDG_CONFIG_HOME: `/tmp/root-for-${mcp ? 'bot' : 'none'}` }) }) }, registry, sessions });
  const ctx = ctxFor();
  const first = await runner(lane({ modelId: 'meta/muse-spark-1.3' }), ctx);
  assert.equal(first.text, 'Fresh run.');
  assert.deepEqual(ctx.messages.map((m) => m.text), ['Hmm.']);
  assert.ok(!runs[0].argv.includes('--session-id'));
  assert.ok(runs[0].argv.includes('--yolo'));
  assert.equal(runs[0].options.env.XDG_CONFIG_HOME, '/tmp/root-for-bot');
  const second = await runner(
    lane({
      modelId: 'meta/muse-spark-1.3',
      laneId: 'lane_m2',
      replyMessageId: 'reply_m2',
      session: { history: [{ id: 'm1', seq: 1, role: 'user', text: 'Hi there' }, { id: 'reply_1', seq: 2, role: 'assistant', text: 'Fresh run.' }, { id: 'm3', seq: 3, role: 'user', text: 'Next' }], answering: [3], context: [] },
    }),
    ctxFor()
  );
  assert.equal(second.text, 'Resumed run.');
  assert.equal(runs[1].argv[runs[1].argv.indexOf('--session-id') + 1], 'muse_ses');
});

await test('grok and muse efforts: none for a Grok model without tiers; Muse within the model\'s own tiers', () => {
  const clamp = (effort, efforts, fallback) => (effort && efforts.includes(effort) ? effort : fallback);
  assert.equal(grokOrMuseBotEffort('grok', { slug: 'grok-4.7', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] }, 'high', clamp), 'high');
  assert.equal(grokOrMuseBotEffort('grok', { slug: 'grok-4.6' }, 'high', clamp), null, 'no --reasoning-effort for a model without tiers');
  assert.equal(grokOrMuseBotEffort('muse', { slug: 'muse-spark-1.3', reasoningEfforts: ['low', 'medium', 'high'] }, 'max', clamp), 'high');
  assert.equal(grokOrMuseBotEffort('muse', { slug: 'muse-spark-1.3' }, 'ultra', clamp), 'ultra');
});

await test('muse: a run whose last events arrive after its exit still counts', async () => {
  const runs = [];
  const spawnProcess = (argv) => {
    const child = fakeChild(() => {});
    runs.push(argv);
    setTimeout(() => {
      child.emit('exit', 0); // exit first: stdout isn't drained yet
      child.stdout.write(`${JSON.stringify({ stream: { kind: 'session', id: 's' }, payload_type: 'run.output.delta', payload: { text: 'Late but fine.' } })}\n`);
      // the last line without a newline
      child.stdout.write(JSON.stringify({ stream: { kind: 'session', id: 's' }, payload_type: 'run.terminal.completed', payload: { terminal: 'completed' } }));
      setTimeout(() => child.emit('close', 0), 5);
    }, 2);
    return child;
  };
  const outcome = await runnerFor({ harnesses: { muse: createMuseBotHarness({ spawnProcess }) } })(lane({ modelId: 'meta/muse-spark-1.3' }), ctxFor());
  assert.equal(outcome.failure, undefined, outcome.failure);
  assert.equal(outcome.text, 'Late but fine.');
});

await test('codex: a tool step with no text of its own puts its card on the next message, not an earlier one', async () => {
  const registry = fakeRegistry();
  const codex = fakeCodex({
    registry,
    script: async (index, text, api) => {
      api.delta('Step one.');
      await api.tool('web_search', async () => {
        await api.callBotTool('web_search', { query: 'a' });
      });
      // the next step calls a tool straight away
      await api.tool('show_actions', async () => {
        await api.callBotTool('web_search', { query: 'b' });
      });
      api.delta('Done.');
      api.complete();
    },
  });
  const ctx = ctxFor();
  const outcome = await runnerFor({ harnesses: { codex: createCodexBotHarness({ spawnProcess: codex.spawnProcess }) }, registry })(lane(), ctx);
  assert.equal(outcome.text, 'Done.');
  assert.deepEqual(ctx.calls.map((call) => call.message), [0, null]);
});

await test('grok: messages are not taken mid-turn (it cannot be given them); the check before the final answer takes them', async () => {
  const registry = fakeRegistry();
  const grok = fakeAcp({
    provider: 'grok',
    registry,
    caps: {},
    onPrompt: async ({ message, prompts, peer, update }) => {
      if (prompts.length === 1) {
        update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', status: 'in_progress' });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Draft.' } });
      } else {
        assert.match(message.params.prompt[0].text, /and Paris/);
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Both.' } });
      }
      peer.reply(message, { stopReason: 'end_turn' });
    },
  });
  const ctx = ctxFor({ beforeFinish: [[{ seq: 4, source: 'person', content: 'and Paris' }]] });
  const outcome = await runnerFor({ harnesses: { grok: createAcpBotHarness({ provider: 'grok', spawnProcess: grok.spawnProcess }) }, registry })(lane({ modelId: 'x-ai/grok-4.7' }), ctx);
  assert.equal(outcome.text, 'Both.');
  assert.ok(ctx.takes.every((options) => options.beforeFinish), 'no mid-turn take');
});

await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
if (failures) {
  console.error(`\n${failures} bot harness test(s) failed.`);
  process.exit(1);
}
console.log('\nAll bot harness tests passed.');
