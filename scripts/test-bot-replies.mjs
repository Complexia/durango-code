// Bot replies on this machine's Claude Code (src/main/bot-replies.js): the
// claim loop, progress/heartbeat, inbox delivery, stop, tool proxying, finish
// classification, the Durango client's bot-lane methods and the bot-replies
// registration capability. The Claude Agent SDK is faked.
//
//   node --no-warnings scripts/test-bot-replies.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DurangoError, accountKeyOf, createDurangoClient, normalizeBotInbox, normalizeBotLane } from '../src/main/durango-client.js';
import { createBotAttachmentManager } from '../src/main/bot-attachments.js';
import { buildMachinePayload, createDispatchWorker } from '../src/main/durango-dispatch.js';
import {
  botCacheColdMs,
  botClaudeEnv,
  BOT_FINAL_INBOX_HEADER,
  BOT_FINAL_INBOX_MAX_ROUNDS,
  BOT_INBOX_HEADER,
  BOT_REPLIES_CAPABILITY,
  BOT_REPLY_MESSAGES_FEATURE,
  BOT_SESSIONS_FEATURE,
  BOT_THREAD_ACTIONS_FEATURE,
  BOT_THREAD_CONFIGURE_FEATURE,
  BOT_THREAD_REQUESTS_FEATURE,
  BOT_CONNECTORS_NOTE,
  BOT_WARM_PROCESS_MS,
  BOT_WARM_PROCESSES_MAX,
  connectedConnectorsOf,
  connectorsStillConnectingNote,
  connectorsThisReplyNote,
  createBotSessionStore,
  createWarmClaudeProcesses,
  keptConnectorsOf,
  waitForConnectors,
  botProjectsNote,
  botToolLabel,
  claudeEffortForBot,
  createBotReplyWorker,
  createClaudeLaneRunner,
  durangoModelIdForClaude,
  formatBotInbox,
  normalizeBotSettings,
  saveLaneAttachments,
} from '../src/main/bot-replies.js';
import { createBotThreadTools, threadReportFooter, withThreadReportFooter } from '../src/main/bot-thread-tools.js';
import { MEMORY_SECTION_HEADING, MEMORY_SECTION_INTRO, memorySection } from '../src/main/bot-memory.js';
import { cutMiddle, estimateTextTokens, maxPromptTokensFromEnv, planBotPrompt, sessionBasis, splitMemorySection } from '../src/main/bot-sessions.js';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'durango-bot-replies-'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, { timeout = 3_000, label = 'condition' } = {}) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await delay(5);
  }
};

// Same semantics as claude-driver.js's createClaudeInputQueue (which needs Electron to import).
const createInputQueue = () => {
  const pending = [];
  let wake = null;
  let closed = false;
  const poke = () => {
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve();
    }
  };
  return {
    push(message) {
      pending.push(message);
      poke();
    },
    close() {
      closed = true;
      poke();
    },
    async *stream() {
      while (true) {
        while (pending.length > 0) yield pending.shift();
        if (closed) return;
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
  };
};

const zod = await import('zod');

/**
 * A fake SDK whose query() runs `script({ next, options, tools })`: an async
 * generator yielding SDK messages. `next()` reads the next user message from
 * the streaming input; abort ends the run with an AbortError.
 */
const createFakeSdk = (script, { mcpServerStatus = null } = {}) => {
  const runs = [];
  return {
    runs,
    tool: (name, description, shape, handler, extras) => ({ name, description, shape, handler, extras }),
    createSdkMcpServer: ({ name, tools }) => ({ type: 'sdk', name, tools }),
    query: ({ prompt, options }) => {
      const iterator = prompt[Symbol.asyncIterator]();
      const run = { options, inputs: [], closed: false };
      runs.push(run);
      const signal = options.abortController.signal;
      const aborted = new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      );
      aborted.catch(() => {});
      const next = async () => {
        const item = await Promise.race([iterator.next(), aborted]);
        if (item.done) return null;
        run.inputs.push(item.value);
        return item.value;
      };
      const tools = Object.fromEntries((options.mcpServers?.durango_bot?.tools ?? []).map((tool) => [tool.name, tool]));
      const generator = script({ next, options, tools, signal, aborted });
      return {
        async *[Symbol.asyncIterator]() {
          for await (const message of generator) {
            if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            yield message;
          }
        },
        close() {
          run.closed = true;
        },
        // mcpServerStatus(run): the query's MCP servers (only when given, like an older SDK without it).
        ...(mcpServerStatus ? { mcpServerStatus: async () => mcpServerStatus(run) } : {}),
      };
    },
  };
};

const textOf = (message) => message?.message?.content?.map((part) => part.text ?? '').join('') ?? '';
const init = (model = 'claude-opus-5-5') => ({ type: 'system', subtype: 'init', model });
const assistant = (id, content, extra = {}) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, model: 'claude-opus-5-5', content }, ...extra });
const toolResult = (toolUseId) => ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] } });
const success = () => ({ type: 'result', subtype: 'success', is_error: false, result: '' });
const delta = (text) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });

/** A fake Durango client recording every call; handlers are overridable. */
const createFakeClient = (overrides = {}) => {
  const calls = { claim: [], progress: [], tool: [], finish: [], message: [], order: [] };
  const client = {
    calls,
    async claimBotLane(input) {
      calls.claim.push(input);
      if (overrides.claim) return overrides.claim(input, calls.claim.length);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 50);
        input.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return { lane: null };
    },
    async reportBotLaneProgress(input) {
      calls.progress.push(input);
      calls.order.push(`progress:${input.text ?? ''}`);
      return overrides.progress ? overrides.progress(input, calls.progress.length) : { stop: false, inbox: [] };
    },
    async callBotLaneTool(input) {
      calls.tool.push(input);
      return overrides.tool ? overrides.tool(input) : { result: { ok: true } };
    },
    async finishBotLane(input) {
      calls.finish.push(input);
      return { ok: true, stored: true };
    },
    async sendBotLaneMessage(input) {
      calls.message.push(input);
      calls.order.push(`message:${input.index}`);
      return { ok: true, stop: false };
    },
  };
  return client;
};

const makeLane = (overrides = {}) => ({
  laneId: 'lane_1',
  botId: 'bot_1',
  botName: 'Scout',
  threadId: 'thr_1',
  replyMessageId: 'msg_1',
  model: 'claude-opus-5-5',
  systemPrompt: 'You are Scout.',
  prompt: 'What is new today?',
  tools: [],
  heartbeatMs: 10_000,
  ...overrides,
});

/** A worker that claims `lanes` once each, then idles. */
const laneClaims = (lanes) => (input) => {
  const lane = lanes.shift();
  if (lane) return { lane };
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ lane: null }), 30);
    input.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve({ lane: null });
    }, { once: true });
  });
};

const liveWorkers = new Set();
const startWorker = (deps, { accessMode = 'read-only' } = {}) => {
  const worker = createBotReplyWorker({
    getMachineId: async () => 'machine-1',
    platform: 'darwin',
    isSignedIn: async () => true,
    sleep: (ms, signal) => new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.min(ms, 20));
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }),
    log: () => {},
    ...deps,
  });
  liveWorkers.add(worker);
  worker.configure({ settings: { enabled: true, accessMode } });
  worker.accountChanged(true);
  return worker;
};
const sdkRunner = (sdk, overrides = {}) =>
  createClaudeLaneRunner({
    loadSdk: async () => sdk,
    loadZod: async () => zod,
    resolveBinary: async () => '/opt/claude',
    createInputQueue,
    botsDir: path.join(testRoot, 'bots'),
    env: () => ({ TEST_ENV: '1' }),
    ...overrides,
  });

let failures = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  } finally {
    for (const worker of liveWorkers) worker.stop();
    await Promise.all([...liveWorkers].map((worker) => worker.idle()));
    liveWorkers.clear();
  }
};

try {
  await test('helpers: inbox format, model ids, tool labels', () => {
    assert.equal(
      formatBotInbox([
        { seq: 1, source: 'person', label: null, content: 'Also check the weather.' },
        { seq: 2, source: 'routine', label: 'Morning digest', content: 'Run the digest.' },
        { seq: 3, source: 'task', label: null, content: 'Task done.' },
      ]),
      `${BOT_INBOX_HEADER}\n\nAlso check the weather.\n\n[Morning digest]\nRun the digest.\n\n[task]\nTask done.`
    );
    assert.equal(durangoModelIdForClaude('claude-opus-5-5'), 'anthropic/claude-opus-5.5');
    assert.equal(durangoModelIdForClaude('claude-haiku-5-5-20261001'), 'anthropic/claude-haiku-5.5');
    assert.equal(durangoModelIdForClaude('claude-sonnet-5-5[1m]'), 'anthropic/claude-sonnet-5.5');
    assert.equal(durangoModelIdForClaude('claude-fable-5'), 'anthropic/claude-fable-5');
    assert.equal(durangoModelIdForClaude('default'), null);
    assert.equal(botToolLabel('mcp__durango_bot__web_search'), 'web_search');
    assert.equal(botToolLabel('mcp__claude-in-chrome__navigate'), 'navigate');
    assert.equal(botToolLabel('Bash'), 'Bash');
  });

  await test('registration advertises bot-replies only when offered', async () => {
    assert.ok(!buildMachinePayload({ machineId: 'm', name: 'Mac', platform: 'darwin', projects: [] }).capabilities.includes(BOT_REPLIES_CAPABILITY));
    assert.deepEqual(
      buildMachinePayload({ machineId: 'm', name: 'Mac', platform: 'darwin', projects: [], sourceCheckout: true, extraCapabilities: [BOT_REPLIES_CAPABILITY] }).capabilities,
      ['thread-follow-up', 'model-choice', 'project-notes', 'source-checkout', 'api-source-checkout', BOT_REPLIES_CAPABILITY]
    );
    let offered = true;
    const registrations = [];
    const worker = createDispatchWorker({
      client: {
        async registerMachine(payload) {
          registrations.push(payload);
        },
        async claimDispatch({ signal }) {
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
            signal?.addEventListener('abort', resolve, { once: true });
          });
          return { dispatch: null };
        },
        async reportDispatch() {},
      },
      getMachineId: async () => 'm1',
      isSignedIn: async () => true,
      startRun: async () => ({ ok: false }),
      extraCapabilities: async () => (offered ? [BOT_REPLIES_CAPABILITY] : []),
      log: () => {},
    });
    worker.configure({ settings: { enabled: true }, projects: [] });
    worker.accountChanged(true);
    await waitFor(() => registrations.length >= 1, { label: 'registration' });
    assert.ok(registrations[0].capabilities.includes(BOT_REPLIES_CAPABILITY));
    offered = false;
    worker.configure({ settings: { enabled: true }, projects: [{ id: 'p', name: 'P' }] }); // re-registers now
    await waitFor(() => registrations.length >= 2, { label: 're-registration' });
    assert.ok(!registrations.at(-1).capabilities.includes(BOT_REPLIES_CAPABILITY));
    worker.stop();
    await worker.idle();
  });

  await test('client: bot lane endpoints, bodies and normalization', async () => {
    const requests = [];
    const responses = {
      '/api/v1/code/bots/claim': {
        lane: {
          laneId: 'ln1', botId: 'b1', botName: 'Scout', threadId: 't', replyMessageId: 'r', model: 'claude-opus-5-5',
          systemPrompt: 'sys', prompt: 'hi', heartbeatMs: 10_000,
          tools: [{ name: 'web_search', description: 'Search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }, { name: 'bad name!' }],
        },
      },
      '/api/v1/code/bots/lanes/ln1/progress': { stop: false, inbox: [{ seq: 4, source: 'routine', label: 'Digest', content: 'x' }, { nope: true }] },
      '/api/v1/code/bots/lanes/ln1/tool': { result: { hits: 2 } },
      '/api/v1/code/bots/lanes/ln1/finish': { ok: true, stored: true },
    };
    const client = createDurangoClient({
      credentials: { get: async () => ({ key: 'dgo_k', keyId: 'k', baseUrl: 'http://durango.test' }), refresh: async () => null, peek: async () => null },
      readSession: async () => ({ token: 't' }),
      fetchImpl: async (url, init) => {
        const { pathname } = new URL(url);
        requests.push({ pathname, auth: init.headers.authorization, body: JSON.parse(init.body) });
        return new Response(JSON.stringify(responses[pathname] ?? {}), { status: responses[pathname] ? 200 : 404, headers: { 'content-type': 'application/json' } });
      },
    });
    const { lane } = await client.claimBotLane({ machineId: 'm1', platform: 'darwin', waitMs: 99_999 });
    assert.equal(lane.laneId, 'ln1');
    assert.deepEqual(lane.tools.map((tool) => tool.name), ['web_search'], 'invalid tool names are dropped');
    assert.deepEqual(requests[0], { pathname: '/api/v1/code/bots/claim', auth: 'Bearer dgo_k', body: { machineId: 'm1', platform: 'darwin', waitMs: 25_000 } });
    const progress = await client.reportBotLaneProgress({ laneId: 'ln1', botId: 'b1', machineId: 'm1', text: 'so far', takeInbox: true });
    assert.deepEqual(progress, { stop: false, inbox: [{ seq: 4, source: 'routine', label: 'Digest', content: 'x' }] });
    assert.deepEqual(requests[1].body, { botId: 'b1', machineId: 'm1', text: 'so far', takeInbox: true });
    assert.deepEqual(await client.callBotLaneTool({ laneId: 'ln1', botId: 'b1', machineId: 'm1', name: 'web_search', input: { q: 'x' }, toolCallId: 'tu' }), { result: { hits: 2 } });
    assert.deepEqual(requests[2].body, { botId: 'b1', machineId: 'm1', name: 'web_search', input: { q: 'x' }, toolCallId: 'tu' });
    assert.deepEqual(await client.finishBotLane({ laneId: 'ln1', botId: 'b1', machineId: 'm1', text: 'Done.' }), { ok: true, stored: true });
    assert.deepEqual(requests[3], { pathname: '/api/v1/code/bots/lanes/ln1/finish', auth: 'Bearer dgo_k', body: { botId: 'b1', machineId: 'm1', text: 'Done.' } });
  });

  await test('claim loop keeps polling and runs at most 3 lanes at once', async () => {
    const lanes = [1, 2, 3, 4, 5].map((n) => makeLane({ laneId: `lane_${n}` }));
    const client = createFakeClient({ claim: laneClaims(lanes) });
    const releases = new Map();
    let concurrent = 0;
    let maxConcurrent = 0;
    const worker = startWorker({
      client,
      runLane: async (lane) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => releases.set(lane.laneId, resolve));
        concurrent -= 1;
        return { text: `reply ${lane.laneId}` };
      },
    });
    await waitFor(() => releases.size === 3, { label: 'three lanes' });
    await delay(80);
    assert.equal(releases.size, 3, 'a 4th lane waits for a slot');
    assert.equal(worker.getState().status, 'busy');
    assert.equal(client.calls.claim.length, 3, 'no claim outstanding at the limit');
    assert.ok(client.calls.claim.every((call) => call.machineId === 'machine-1' && call.platform === 'darwin'));
    releases.get('lane_1')();
    await waitFor(() => releases.size === 4, { label: 'fourth lane' });
    assert.ok(client.calls.finish.some((call) => call.laneId === 'lane_1' && call.text === 'reply lane_1'));
    for (const id of ['lane_2', 'lane_3', 'lane_4']) releases.get(id)();
    await waitFor(() => releases.size === 5, { label: 'fifth lane' });
    releases.get('lane_5')();
    await waitFor(() => client.calls.finish.length === 5, { label: 'all finished' });
    const claimsBefore = client.calls.claim.length;
    await delay(100);
    assert.ok(client.calls.claim.length > claimsBefore, 'keeps polling while idle');
    assert.equal(maxConcurrent, 3);
  });

  await test('machine_not_registered backs off and keeps claiming', async () => {
    const sleeps = [];
    const client = createFakeClient({
      claim: (input, n) => {
        if (n <= 2) throw new DurangoError('api', 'Register first.', { status: 404, apiCode: 'machine_not_registered' });
        return laneClaims([])(input);
      },
    });
    const worker = startWorker({
      client,
      runLane: async () => ({ text: '' }),
      sleep: (ms, signal) => {
        sleeps.push(ms);
        return new Promise((resolve) => {
          setTimeout(resolve, 5);
          signal?.addEventListener('abort', resolve, { once: true });
        });
      },
    });
    await waitFor(() => client.calls.claim.length >= 4, { label: 'claims after backoff' });
    assert.ok(sleeps.length >= 2 && sleeps[1] > sleeps[0] * 1.2, `backoff grows (${sleeps})`);
    assert.equal(worker.getState().status, 'listening');
  });

  await test('not available (no Claude Code) → no claims', async () => {
    const client = createFakeClient();
    const worker = startWorker({ client, runLane: async () => ({ text: '' }), isAvailable: async () => false, unavailableRecheckMs: 10 });
    await delay(60);
    assert.equal(client.calls.claim.length, 0);
    assert.equal(worker.getState().status, 'unavailable');
  });

  await test('a take whose response is lost is retried under the same id', async () => {
    let failNext = true;
    const takes = [];
    const client = createFakeClient({
      claim: laneClaims([makeLane()]),
      progress: (input) => {
        if (input.takeInbox) {
          takes.push(input.takeId);
          if (failNext) {
            failNext = false;
            throw new DurangoError('network', 'socket hang up');
          }
          return { stop: false, inbox: takes.length === 2 ? [{ seq: 5, source: 'person', label: null, content: 'and Almaty?' }] : [] };
        }
        return { stop: false, inbox: [] };
      },
    });
    let seen;
    startWorker({
      client,
      reportRetryDelaysMs: [],
      runLane: async (lane, ctx) => {
        const lost = await ctx.takeInbox();
        const retried = await ctx.takeInbox();
        const next = await ctx.takeInbox();
        seen = { lost, retried, next };
        return { text: 'Both answered.' };
      },
    });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.deepEqual(seen.lost, [], 'the lost take gave nothing here');
    assert.deepEqual(seen.retried.map((item) => item.seq), [5], 'its retry brings the messages back');
    assert.equal(takes[0], takes[1], 'the retry reuses the take id');
    assert.notEqual(takes[2], takes[1], 'a new take after that gets a new id');
  });

  await test('a take that never gets through is reported lost at finish', async () => {
    const client = createFakeClient({
      claim: laneClaims([makeLane()]),
      progress: (input) => {
        if (input.takeInbox) throw new DurangoError('network', 'socket hang up');
        return { stop: false, inbox: [] };
      },
    });
    startWorker({
      client,
      reportRetryDelaysMs: [],
      runLane: async (lane, ctx) => {
        await ctx.takeInbox();
        return { text: 'Answered what I had.' };
      },
    });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    const take = client.calls.progress.find((call) => call.takeInbox);
    assert.ok(take?.takeId, 'the take was named');
    assert.deepEqual(client.calls.finish[0].lostTakes, [take.takeId], 'its messages go back to the inbox');
  });

  await test('a task cancelled on Durango stops its thread here', async () => {
    const lanes = [makeLane()];
    let thread = null;
    const client = createFakeClient({
      claim: (input) => {
        const lane = lanes.shift();
        if (lane) return { lane };
        // After the reply started the thread, a poll hands over its cancellation.
        if (thread && !thread.handed) {
          thread.handed = true;
          return { lane: null, stopTasks: ['task_1', 'task_unknown'] };
        }
        return laneClaims([])(input);
      },
    });
    client.createBotLaneTask = async (input) => ({ taskId: 'task_1', title: input.title });
    client.reportBotTask = async () => ({ ok: true });
    const stopped = [];
    startWorker({
      client,
      getMachineInfo: async () => ({ name: 'Mac', projects: [{ id: 'p1', name: 'Durango', path: '/Users/me/durango' }], models: [] }),
      startProjectThread: async () => {
        thread = { id: 'thread_9', handed: false };
        return { ok: true, threadId: 'thread_9' };
      },
      stopThread: async (threadId, taskId) => {
        stopped.push([threadId, taskId]);
        return { ok: true };
      },
      runLane: async (lane, ctx) => {
        await ctx.callTool({ name: 'delegate_task', input: { title: 'Fix', instructions: 'Fix it.', project: 'durango' }, toolCallId: 'c1' });
        return { text: 'Started.' };
      },
    });
    await waitFor(() => stopped.length === 1, { label: 'stop' });
    assert.deepEqual(stopped, [['thread_9', 'task_1']], 'only the known task\'s run stops (by its task, not any turn in the thread)');
  });

  await test('handled stop requests are acknowledged on the next claim; unknown threads stop once they start', async () => {
    const lanes = [makeLane()];
    let round = 0;
    const client = createFakeClient({
      claim: (input) => {
        round += 1;
        if (round === 1) return { lane: null, stopTasks: ['task_1'] }; // cancelled before its thread is known
        const lane = lanes.shift();
        if (lane) return { lane };
        return laneClaims([])(input);
      },
    });
    client.createBotLaneTask = async (input) => ({ taskId: 'task_1', title: input.title });
    client.reportBotTask = async () => ({ ok: true });
    const stopped = [];
    startWorker({
      client,
      getMachineInfo: async () => ({ name: 'Mac', projects: [{ id: 'p1', name: 'Durango', path: '/Users/me/durango' }], models: [] }),
      startProjectThread: async () => ({ ok: true, threadId: 'thread_7' }),
      stopThread: async (threadId) => {
        stopped.push(threadId);
        return { ok: true };
      },
      runLane: async (lane, ctx) => {
        await ctx.callTool({ name: 'delegate_task', input: { title: 'Fix', instructions: 'Fix it.', project: 'durango' }, toolCallId: 'c1' });
        return { text: 'Started.' };
      },
    });
    await waitFor(() => stopped.length === 1, { label: 'stop once the thread is known' });
    assert.deepEqual(stopped, ['thread_7']);
    await waitFor(() => client.calls.claim.some((call) => call.ackStopTasks?.includes('task_1')), { label: 'ack' });
  });

  await test('a sync pinned to one account never resends to another after a key refresh', async () => {
    let session = { token: 'a', user: { id: 'alice' } };
    const sent = [];
    const client = createDurangoClient({
      credentials: {
        get: async () => ({ key: 'dgo_a', keyId: 'ka', baseUrl: 'http://durango.test' }),
        refresh: async () => {
          session = { token: 'b', user: { id: 'bob' } }; // switched accounts meanwhile
          return { key: 'dgo_b', keyId: 'kb', baseUrl: 'http://durango.test' };
        },
        peek: async () => null,
      },
      readSession: async () => session,
      fetchImpl: async (url, init) => {
        sent.push(init.headers.authorization);
        return new Response(JSON.stringify({ error: { message: 'revoked' } }), { status: 401, headers: { 'content-type': 'application/json' } });
      },
    });
    await assert.rejects(client.importBots({ bots: [] }, { account: accountKeyOf({ token: 'a', user: { id: 'alice' } }) }), (error) => error.code === 'account_changed');
    assert.deepEqual(sent, ['Bearer dgo_a'], 'nothing went out with the other account\'s key');
  });

  await test('an account with no bots: the machine waits out the idle period, and wakes when a bot is used here', async () => {
    const client = createFakeClient({ claim: () => ({ lane: null, stopTasks: [], idleMs: 10 * 60_000 }) });
    const worker = startWorker({
      client,
      // The idle wait only ends early on abort (wake / sign-out).
      sleep: (ms, signal) => new Promise((resolve) => {
        const timer = setTimeout(resolve, ms >= 60_000 ? 60_000_000 : Math.min(ms, 20));
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      }),
      runLane: async () => ({ text: 'unused' }),
    });
    await waitFor(() => client.calls.claim.length === 1, { label: 'first claim' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(client.calls.claim.length, 1, 'no polling while idle');
    worker.wake();
    await waitFor(() => client.calls.claim.length === 2, { label: 'claims again once woken' });
  });

  await test('attachments are saved next to the reply and named in the prompt', async () => {
    const dir = await fs.mkdtemp(path.join(testRoot, 'attach-'));
    const local = path.join(dir, 'source.txt');
    await fs.writeFile(local, 'local file');
    const downloads = [];
    const note = await saveLaneAttachments(
      [
        { id: 'asset123456', name: 'photo.png', url: 'https://storage.example/photo.png' },
        { id: 'lm1', name: 'notes/../x.txt', path: local },
        { id: 'bad', name: 'nope.bin', url: 'http://insecure.example/x' },
      ],
      path.join(dir, 'attachments'),
      { download: async (url) => (downloads.push(url), new Uint8Array([1, 2, 3])) }
    );
    assert.deepEqual(downloads, ['https://storage.example/photo.png']);
    assert.match(note, /<attachments>/);
    assert.match(note, /photo\.png: .*attachments\/asset123-photo\.png/);
    const copied = note.match(/x\.txt: (\S+)/)?.[1];
    assert.equal(path.dirname(copied), path.join(dir, 'attachments'), 'a name can\'t leave the attachments folder');
    assert.equal(await fs.readFile(copied, 'utf8'), 'local file');
    assert.doesNotMatch(note, /nope\.bin/, 'only https links are downloaded');
    assert.equal(await saveLaneAttachments([], path.join(dir, 'none')), '');
  });

  await test('progress is throttled, heartbeats keep the lane alive', async () => {
    const client = createFakeClient({ claim: laneClaims([makeLane({ heartbeatMs: 150 })]) });
    let done;
    startWorker({
      client,
      throttleMs: 100,
      runLane: async (lane, ctx) => {
        const started = Date.now();
        for (let i = 1; i <= 30; i += 1) {
          ctx.update({ text: 'x'.repeat(i), activeTool: i > 25 ? 'web_search' : null });
          await delay(10);
        }
        const updatesEnd = client.calls.progress.length;
        const elapsed = Date.now() - started;
        await delay(400); // nothing changes: heartbeats only
        done = { updatesEnd, elapsed, total: client.calls.progress.length };
        return { text: 'x'.repeat(30) };
      },
    });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    const textCalls = client.calls.progress.slice(0, done.updatesEnd);
    // 30 updates, at most one post per 100 ms (plus the start).
    assert.ok(textCalls.length >= 3 && textCalls.length <= Math.ceil(done.elapsed / 100) + 1, `throttled (${textCalls.length} posts in ${done.elapsed} ms)`);
    assert.ok(textCalls.every((call) => call.takeInbox === false && call.botId === 'bot_1' && call.machineId === 'machine-1'));
    assert.ok(textCalls.some((call) => call.activeTool === 'web_search'));
    const beats = done.total - done.updatesEnd;
    assert.ok(beats >= 2 && beats <= 4, `heartbeats every 150 ms (${beats} in 400 ms)`);
    assert.equal(client.calls.progress.at(-1).text, 'x'.repeat(30));
    assert.deepEqual(client.calls.finish[0], { laneId: 'lane_1', botId: 'bot_1', machineId: 'machine-1', text: 'x'.repeat(30) });
  });

  // A reply that acknowledges, reports progress, then answers with buttons (and adds a line after them).
  const ackProgressAnswer = (answer) => async function* ({ next, options, tools }) {
    await next();
    yield init('claude-opus-5-5');
    yield assistant('a1', [{ type: 'text', text: 'On it, checking the change.' }]);
    yield assistant('a1', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }]);
    yield toolResult('tu1');
    yield assistant('a2', [{ type: 'thinking', thinking: '…' }]);
    yield assistant('a2', [{ type: 'text', text: 'The checks passed. Writing it up.' }]);
    yield assistant('a2', [{ type: 'tool_use', id: 'tu2', name: 'Read', input: {} }]);
    yield toolResult('tu2');
    yield assistant('a3', [{ type: 'text', text: answer }]);
    yield assistant('a3', [{ type: 'tool_use', id: 'tu3', name: 'mcp__durango_bot__show_actions', input: {} }]);
    await options.hooks.PreToolUse[0].hooks[0]({ tool_name: 'mcp__durango_bot__show_actions', tool_use_id: 'tu3', tool_input: {} });
    await tools.show_actions.handler({ actions: [] });
    yield toolResult('tu3');
    yield assistant('a4', [{ type: 'text', text: 'Buttons are below.' }]);
    yield success();
  };
  const actionsLane = (overrides = {}) =>
    makeLane({ tools: [{ name: 'show_actions', description: 'Buttons', inputSchema: { type: 'object', properties: { actions: { type: 'array' } } } }], ...overrides });
  const answer = 'Done: chg_abc12345xyz fixes the sidebar dots. The fast checks passed.';

  await test('a reply is the messages it sends: acknowledgement, progress, the answer with its buttons, then what it wrote last', async () => {
    const live = [];
    const sent = [];
    const calls = [];
    const outcome = await sdkRunner(createFakeSdk(ackProgressAnswer(answer)))(actionsLane(), {
      signal: new AbortController().signal,
      accessMode: 'full-access',
      update: ({ text }) => live.push(text),
      takeInbox: async () => [],
      callTool: async (call) => {
        calls.push(call);
        return { result: { ok: true } };
      },
      sendMessage: async (message) => {
        sent.push(message);
        return true;
      },
    });
    assert.deepEqual(
      sent.map(({ index, text }) => [index, text]),
      [
        [0, 'On it, checking the change.'],
        [1, 'The checks passed. Writing it up.'],
        [2, answer],
      ]
    );
    assert.equal(sent[0].modelId, 'anthropic/claude-opus-5.5');
    assert.equal(calls[0].message, 2, 'the buttons go on the answer they were made with');
    assert.equal(outcome.text, 'Buttons are below.', 'the text after the last tool call is the final answer, as written');
    assert.equal(outcome.sent, 3);
    assert.equal(live[0], 'On it, checking the change.', 'the acknowledgement shows at once');
    assert.ok(!live.some((text) => text.includes('On it') && text.includes('checks passed')), 'the live text is only the message being written');
  });

  await test('the answer written before show_actions is never lost when nothing follows it', async () => {
    const sent = [];
    const sdk = createFakeSdk(async function* ({ next, options, tools }) {
      await next();
      yield init();
      yield assistant('a1', [{ type: 'text', text: answer }, { type: 'tool_use', id: 'tu1', name: 'mcp__durango_bot__show_actions', input: {} }]);
      await options.hooks.PreToolUse[0].hooks[0]({ tool_name: 'mcp__durango_bot__show_actions', tool_use_id: 'tu1', tool_input: {} });
      await tools.show_actions.handler({ actions: [] });
      yield toolResult('tu1');
      yield assistant('a2', [{ type: 'thinking', thinking: 'done' }]);
      yield success();
    });
    const calls = [];
    const outcome = await sdkRunner(sdk)(actionsLane(), {
      signal: new AbortController().signal,
      accessMode: 'full-access',
      update: () => {},
      takeInbox: async () => [],
      callTool: async (call) => {
        calls.push(call);
        return { result: { ok: true } };
      },
      sendMessage: async (message) => {
        sent.push(message.text);
        return true;
      },
    });
    assert.deepEqual(sent, [answer]);
    assert.equal(calls[0].message, 0);
    assert.equal(outcome.text, '');
    assert.equal(outcome.sent, 1);
  });

  await test('cards made before any text go with the next message; a message that could not be sent goes out with the final answer', async () => {
    const sdk = createFakeSdk(async function* ({ next, options, tools }) {
      await next();
      yield init();
      yield assistant('a1', [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }]);
      yield toolResult('tu1');
      yield assistant('a2', [{ type: 'tool_use', id: 'tu2', name: 'mcp__durango_bot__show_actions', input: {} }]);
      await options.hooks.PreToolUse[0].hooks[0]({ tool_name: 'mcp__durango_bot__show_actions', tool_use_id: 'tu2', tool_input: {} });
      await tools.show_actions.handler({ actions: [] });
      yield toolResult('tu2');
      yield assistant('a3', [{ type: 'text', text: answer }]);
      yield success();
    });
    const calls = [];
    const outcome = await sdkRunner(sdk)(actionsLane(), {
      signal: new AbortController().signal,
      accessMode: 'full-access',
      update: () => {},
      takeInbox: async () => [],
      callTool: async (call) => {
        calls.push(call);
        return { result: { ok: true } };
      },
      sendMessage: async () => false,
    });
    assert.equal(calls[0].message, null, 'no text of its own: the next message');
    assert.equal(outcome.text, `Looking.\n\n${answer}`, 'nothing is lost when a message fails to send');
  });

  await test('a message is handed over before the reply writes on, even when storing it is slow', async () => {
    const log = [];
    let release;
    const slow = new Promise((resolve) => (release = resolve));
    const sdk = createFakeSdk(async function* ({ next }) {
      await next();
      yield init();
      yield assistant('a1', [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }]);
      yield toolResult('tu1');
      yield delta('Answer');
      yield assistant('a2', [{ type: 'text', text: 'Answer.' }]);
      release(true);
      yield success();
    });
    const outcome = await sdkRunner(sdk)(makeLane(), {
      signal: new AbortController().signal,
      accessMode: 'full-access',
      update: ({ text }) => log.push(`update:${text}`),
      takeInbox: async () => [],
      callTool: async () => ({ result: { ok: true } }),
      sendMessage: (message) => {
        log.push(`send:${message.text}`);
        return slow;
      },
    });
    const sendAt = log.indexOf('send:Checking.');
    const answerAt = log.findIndex((entry) => entry.startsWith('update:Answer'));
    assert.ok(sendAt >= 0 && sendAt < answerAt, log.join(' | '));
    assert.equal(outcome.text, 'Answer.');
  });

  await test('without sendMessage (a task, an older Durango) everything written is one text', async () => {
    const outcome = await sdkRunner(createFakeSdk(ackProgressAnswer(answer)))(actionsLane(), {
      signal: new AbortController().signal,
      accessMode: 'full-access',
      update: () => {},
      takeInbox: async () => [],
      callTool: async (call) => {
        assert.equal(call.message, null);
        return { result: { ok: true } };
      },
    });
    assert.equal(outcome.text, `On it, checking the change.\n\nThe checks passed. Writing it up.\n\n${answer}\n\nButtons are below.`);
    assert.equal(outcome.sent, undefined);
  });

  await test('a machine reply sends its messages to Durango in order, its cards on them, then the final answer', async () => {
    const client = createFakeClient({ claim: laneClaims([actionsLane({ messages: true })]) });
    startWorker({ client, runLane: sdkRunner(createFakeSdk(ackProgressAnswer(answer))) });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.deepEqual(client.calls.claim[0].features, [
      BOT_SESSIONS_FEATURE,
      BOT_REPLY_MESSAGES_FEATURE,
      BOT_THREAD_ACTIONS_FEATURE,
      BOT_THREAD_CONFIGURE_FEATURE,
      BOT_THREAD_REQUESTS_FEATURE,
    ]);
    assert.deepEqual(
      client.calls.message.map(({ index, text }) => [index, text]),
      [
        [0, 'On it, checking the change.'],
        [1, 'The checks passed. Writing it up.'],
        [2, answer],
      ]
    );
    assert.equal(client.calls.tool[0].message, 2);
    assert.equal(client.calls.finish[0].text, 'Buttons are below.');
    // Progress after a message shows only what follows it.
    const afterAck = client.calls.order.indexOf('message:0');
    assert.ok(afterAck >= 0 && client.calls.order.slice(afterAck + 1).every((call) => !call.startsWith('progress:On it')));
  });

  await test('a reply handed back after sending messages still goes elsewhere (never silently dropped)', async () => {
    const client = createFakeClient({ claim: laneClaims([makeLane({ messages: true })]) });
    startWorker({ client, runLane: async () => ({ text: '', sent: 2, retryElsewhere: true, failure: 'usage limit' }) });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.equal(client.calls.finish[0].retryElsewhere, true);
  });

  await test('screenshots named in an earlier message are attached and leave its text', async () => {
    const shot = path.join(testRoot, 'shot.png');
    await fs.writeFile(shot, 'png');
    const sent = [];
    const sdk = createFakeSdk(async function* ({ next }) {
      await next();
      yield init();
      yield assistant('a1', [{ type: 'text', text: `Here it is:\n\n![dots](${shot})` }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }]);
      yield toolResult('tu1');
      yield assistant('a2', [{ type: 'text', text: 'Done.' }]);
      yield success();
    });
    const outcome = await sdkRunner(sdk)(makeLane(), {
      signal: new AbortController().signal,
      accessMode: 'full-access',
      update: () => {},
      takeInbox: async () => [],
      callTool: async () => ({ result: { ok: true } }),
      sendMessage: async (message) => {
        sent.push(message.text);
        return true;
      },
    });
    assert.deepEqual(sent, ['Here it is:']);
    assert.deepEqual(outcome.files.map((file) => file.path), [shot]);
    assert.equal(outcome.text, 'Done.');
  });

  await test('normal run: SDK options, text assembly, model id', async () => {
    const sdk = createFakeSdk(async function* ({ next }) {
      const first = await next();
      assert.equal(textOf(first), 'What is new today?');
      yield init('claude-opus-5-5');
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } };
      yield delta('Let me ');
      yield delta('look.');
      yield assistant('a1', [{ type: 'text', text: 'Let me look.' }]);
      yield assistant('a1', [{ type: 'tool_use', id: 'tu1', name: 'WebSearch', input: {} }]);
      yield assistant('sub', [{ type: 'text', text: 'subagent chatter' }], { parent_tool_use_id: 'tu1' });
      yield toolResult('tu1');
      yield assistant('a2', [{ type: 'text', text: 'Three things are new.' }]);
      yield success();
    });
    const client = createFakeClient({ claim: laneClaims([makeLane()]) });
    const projects = [
      { id: 'p1', name: 'durango', path: '/Users/me/projects/durango' },
      { id: 'p2', name: 'relative', path: 'not/absolute' },
    ];
    startWorker({ client, runLane: sdkRunner(sdk, { getProjects: () => projects }) }, { accessMode: 'workspace-write' });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.deepEqual(client.calls.finish[0], {
      laneId: 'lane_1', botId: 'bot_1', machineId: 'machine-1',
      text: 'Let me look.\n\nThree things are new.', modelId: 'anthropic/claude-opus-5.5',
    });
    const { options } = sdk.runs[0];
    assert.equal(options.model, 'claude-opus-5-5');
    assert.equal(options.systemPrompt.type, 'preset');
    assert.ok(options.systemPrompt.append.startsWith('You are Scout.\n\n## This computer'), 'bot prompt, then the projects');
    assert.ok(options.systemPrompt.append.includes('- durango: /Users/me/projects/durango'));
    assert.ok(!options.systemPrompt.append.includes('relative'), 'only absolute project paths');
    assert.ok(options.systemPrompt.append.includes('delegate_task and `project` set to the project name: it starts on this computer'), 'replies start threads here');
    assert.deepEqual(options.additionalDirectories, ['/Users/me/projects/durango'], 'the projects are reachable');
    assert.equal(options.cwd, path.join(testRoot, 'bots', 'bot_1'));
    assert.ok((await fs.stat(options.cwd)).isDirectory(), 'per-bot directory created');
    assert.equal(options.permissionMode, 'bypassPermissions', 'bot replies always run with Full access');
    assert.equal(options.pathToClaudeCodeExecutable, '/opt/claude');
    assert.deepEqual(options.env, { TEST_ENV: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, 'the hour-long prompt cache');
    assert.deepEqual(
      options.mcpServers.durango_bot.tools.map((tool) => tool.name),
      ['attach_files'],
      'no bot tools: only attach_files (a reply shows files from here)'
    );
    // Full access: Claude Code's own shell safety-check asks are approved
    // (nobody is here to answer); questions, a user's ask rule and a hook's
    // ask are not. Option shapes as the real SDK passes them
    // (scripts/test-claude-safety-asks.mjs drives the runtimes).
    const unclear = "Claude Code can't be sure it read this command the way the shell will, so it can't rule out a dangerous removal. Read the command, and don't go ahead if you can't tell what it does.";
    assert.equal((await options.canUseTool('Bash', { command: 'cd /repo; for w in a; do git -C $w add -AN .; done' }, { decisionReason: unclear, displayName: 'Bash', toolUseID: 't1', requestId: 'r1' })).behavior, 'allow');
    assert.equal((await options.canUseTool('AskUserQuestion', { questions: [] }, {})).behavior, 'deny', 'no one here to answer');
    assert.equal((await options.canUseTool('Bash', { command: 'echo hello' }, { displayName: 'Bash', description: 'Say hello', toolUseID: 't2', requestId: 'r2' })).behavior, 'deny', "a user's ask rule (no reason, no matchedAskRule)");
    assert.equal((await options.canUseTool('Bash', { command: 'echo hello' }, { decisionReason: 'Hook wants a person to confirm', displayName: 'Bash', toolUseID: 't3', requestId: 'r3' })).behavior, 'deny', "a hook's ask");
    assert.equal((await options.canUseTool('Bash', { command: 'cd /repo; git status' }, { decisionReason: unclear, matchedAskRule: { source: 'userSettings', toolName: 'Bash' } })).behavior, 'deny', "a rule-forced ask carrying a safety reason");
    assert.ok(sdk.runs[0].closed, 'query closed when done');
  });

  await test('projects note: local and task variants, none open', async () => {
    const projects = [{ name: 'site', path: '/p/site' }];
    const local = botProjectsNote({ projects, accessMode: 'read-only', threads: 'local' });
    assert.ok(local.includes('- site: /p/site') && local.includes('Read only') && local.includes('delegate_task and `project`'));
    const task = botProjectsNote({ projects, accessMode: 'full-access', threads: null });
    assert.ok(task.includes('- site: /p/site') && !task.includes('delegate_task'), 'tasks only get the folders');
    assert.equal(botProjectsNote({ projects: [], accessMode: 'read-only', threads: null }), '');
    assert.ok(botProjectsNote({ projects: [], accessMode: 'read-only', threads: 'local' }).includes('None are open'));
  });

  await test('bot settings: on by default, always Full access (a saved older choice no longer applies)', async () => {
    assert.deepEqual(normalizeBotSettings(undefined), { enabled: true, accessMode: 'full-access' });
    assert.deepEqual(normalizeBotSettings({ enabled: false, accessMode: 'full-access' }), { enabled: false, accessMode: 'full-access' });
    assert.deepEqual(normalizeBotSettings({ accessMode: 'workspace-write' }), { enabled: true, accessMode: 'full-access' });
  });

  await test('the claim carries this machine\'s presence: name, allowed projects, Claude models', async () => {
    const client = createFakeClient();
    startWorker({
      client,
      runLane: async () => ({ text: '' }),
      getMachineInfo: async () => ({
        name: 'Roma MacBook',
        projects: [
          { id: 'p1', name: 'durango', path: '/Users/me/durango' },
          { id: 'p2', name: 'bad', path: 'relative' },
        ],
        models: ['claude-opus-5-5'],
      }),
    });
    await waitFor(() => client.calls.claim.length >= 1, { label: 'claim' });
    assert.deepEqual(client.calls.claim[0].machine, {
      name: 'Roma MacBook',
      projects: ['durango'],
      projectRefs: [
        { name: 'durango', id: 'p1', repoId: null },
        { name: 'bad', id: 'p2', repoId: null },
      ],
      models: ['claude-opus-5-5'],
    });
    assert.equal(client.calls.claim[0].machineId, 'machine-1');
  });

  await test('delegate_task in a project here starts a Durango Code thread here; elsewhere it goes to Durango', async () => {
    const client = createFakeClient({ claim: laneClaims([makeLane()]) });
    const tasks = [];
    const reports = [];
    client.createBotLaneTask = async (input) => {
      tasks.push(input);
      // An older Durango still sends the project's notes: this version ignores them.
      return { taskId: `task_${tasks.length}`, title: input.title, brief: '[Project notes: Durango]\n- Use bun.\n[/Project notes]' };
    };
    client.reportBotTask = async (input) => {
      reports.push(input);
      return { ok: true };
    };
    const started = [];
    let results;
    startWorker(
      {
        client,
        getMachineInfo: async () => ({ name: 'Roma MacBook', projects: [{ id: 'p1', name: 'Durango', path: '/Users/me/durango' }], models: [] }),
        startProjectThread: async (input) => {
          started.push(input);
          return input.title === 'Fails' ? { ok: false, error: 'No window.' } : { ok: true, threadId: 'thread_1' };
        },
        runLane: async (lane, ctx) => {
          const call = (input) => ctx.callTool({ name: 'delegate_task', input, toolCallId: 't' }).then((out) => out.result);
          results = {
            here: await call({ title: 'Fix spinner', instructions: 'Fix the OpenCode updater spinner.', project: 'durango' }),
            named: await call({ title: 'Named', instructions: 'x', project: 'Durango', run_on: 'roma macbook' }),
            missingHere: await call({ title: 'Missing', instructions: 'x', project: 'website', run_on: 'Roma MacBook' }),
            elsewhere: await call({ title: 'Other', instructions: 'x', project: 'durango', run_on: 'omarchy' }),
            unknown: await call({ title: 'Unknown', instructions: 'x', project: 'website' }),
            cloud: await call({ title: 'Cloud', instructions: 'x' }),
            fails: await call({ title: 'Fails', instructions: 'x', project: 'durango' }),
          };
          return { text: 'On it.' };
        },
      },
      { accessMode: 'workspace-write' }
    );
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.equal(results.here.ok, true);
    assert.equal(results.here.taskId, 'task_1');
    assert.equal(results.here.project, 'Durango');
    assert.deepEqual(tasks[0], {
      laneId: 'lane_1', botId: 'bot_1', machineId: 'machine-1', title: 'Fix spinner', instructions: 'Fix the OpenCode updater spinner.',
      project: 'Durango', requestId: 't', readsProjectNotes: true, signal: tasks[0].signal,
    }, 'the tool call id makes a retried create return the same task; its threads read the notes themselves (no brief)');
    assert.equal(started[0].projectId, 'p1');
    assert.equal(started[0].botId, 'bot_1', 'records which bot started the thread');
    assert.equal(started[0].key, 'task_1', 'the renderer reports it as bottask:<taskId>');
    assert.equal(started[0].accessMode, 'full-access', 'threads a bot starts run with Full access');
    assert.match(started[0].prompt, /^Fix the OpenCode updater spinner\.\n\nWhen you're done, end with a concise report/);
    assert.doesNotMatch(started[0].prompt, /Project notes|Use bun/, 'no pasted notes, even when Durango sends them');
    assert.equal(results.named.ok, true, 'run_on naming this machine');
    assert.equal(results.missingHere.ok, false);
    assert.match(results.missingHere.error, /No Durango Code project named "website" on this computer\. Projects: Durango\./);
    // Another machine, a project not here, or no project: Durango's own tool.
    assert.deepEqual(client.calls.tool.map((call) => call.input.title), ['Other', 'Unknown', 'Cloud']);
    assert.equal(results.fails.ok, false);
    assert.equal(results.fails.error, 'No window.');
    assert.deepEqual(reports, [{ taskId: 'task_3', machineId: 'machine-1', outcome: 'failed', error: 'No window.' }], 'a thread that never started is reported failed');
  });

  await test('delegate_task, list_thread_models, message_thread (model/effort/steer), and manage_thread (configure/branch) honor full thread controls', async () => {
    const modelsCatalog = [
      { id: 'antigravity:gemini-4-neon', label: 'Gemini 4 Neon', slug: 'gemini-4-neon', providerId: 'antigravity', provider: 'Antigravity', efforts: ['low', 'medium', 'high', 'xhigh'], available: true },
      { id: 'claude:claude-opus-5-5', label: 'Claude Opus 5.5', slug: 'claude-opus-5-5', providerId: 'claude', provider: 'Claude', efforts: ['low', 'medium', 'high', 'max', 'ultracode'], available: true },
      { id: 'codex:gpt-5.6-sol', label: 'GPT-5.6 Sol', slug: 'gpt-5.6-sol', providerId: 'codex', provider: 'Codex', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], available: true },
      { id: 'grok:grok-4.7-no-effort', label: 'Grok Plain', slug: 'grok-4.7-no-effort', providerId: 'grok', provider: 'Grok', efforts: [], available: true },
      { id: 'codex:offline-model', label: 'Offline Model', slug: 'offline-model', providerId: 'codex', provider: 'Codex', efforts: ['high'], available: false, unavailableReason: 'Sign in to Codex.' },
    ];
    const client = createFakeClient({
      claim: laneClaims([
        makeLane({
          tools: [
            // Older server schema without effort/access_mode: enriched locally.
            { name: 'delegate_task', description: 'delegate', inputSchema: { type: 'object', properties: { title: { type: 'string' }, instructions: { type: 'string' }, model: { type: 'string' }, project: { type: 'string' } } } },
          ],
        }),
      ]),
    });
    const tasks = [];
    client.createBotLaneTask = async (input) => {
      tasks.push(input);
      return { taskId: `task_${tasks.length}`, title: input.title };
    };
    const started = [];
    const followUps = [];
    const managed = [];
    const threadTools = createBotThreadTools({
      readIndex: async () => ({
        entries: [
          {
            id: 'thread_1',
            projectId: 'p1',
            title: 'Existing',
            status: 'idle',
            modelId: 'claude:claude-opus-5-5',
            shell: { modelId: 'claude:claude-opus-5-5', claudeReasoningEffort: 'high', accessMode: 'full-access' },
            activityAt: 10,
          },
          {
            id: 'subagent_obj',
            projectId: 'p1',
            title: 'Hidden subagent object',
            status: 'idle',
            shell: { subagent: { id: 'sub1', providerId: 'claude' } },
            activityAt: 20,
          },
          {
            id: 'subagent_child',
            projectId: 'p1',
            title: 'Hidden child thread',
            status: 'idle',
            parentThreadId: 'thread_1',
            activityAt: 30,
          },
        ],
      }),
      readThread: async () => '',
      getProjects: () => [{ id: 'p1', name: 'Durango', path: '/Users/me/durango' }],
      listModels: async () => modelsCatalog,
      manageThread: async (req) => {
        managed.push(req);
        if (req.action === 'branch') {
          return { ok: true, threadId: 'thread_branch_1', threadTitle: 'Existing (branch)', modelId: 'claude:claude-opus-5-5', reasoningEffort: 'high', accessMode: 'full-access' };
        }
        return { ok: true, modelId: req.modelId, reasoningEffort: req.reasoningEffort, accessMode: req.accessMode };
      },
    });
    let results;
    let delegateSchema;
    startWorker({
      client,
      getMachineInfo: async () => ({ name: 'Roma MacBook', projects: [{ id: 'p1', name: 'Durango', path: '/Users/me/durango' }], models: [] }),
      listModels: async () => modelsCatalog,
      threadTools,
      startProjectThread: async (input) => {
        started.push(input);
        return {
          ok: true,
          threadId: `thread_new_${started.length}`,
          modelId: input.modelId,
          reasoningEffort: input.reasoningEffort,
          accessMode: input.accessMode,
        };
      },
      startThreadFollowUp: async (input) => {
        followUps.push(input);
        return {
          ok: true,
          threadId: input.threadId,
          modelId: input.modelId,
          reasoningEffort: input.reasoningEffort,
          accessMode: input.accessMode,
        };
      },
      runLane: async (lane, ctx) => {
        delegateSchema = lane.tools.find((t) => t.name === 'delegate_task')?.inputSchema;
        const call = (name, input) => ctx.callTool({ name, input, toolCallId: 't' }).then((out) => out.result);
        results = {
          modelsAll: await call('list_thread_models', {}),
          modelsGemini: await call('list_thread_models', { search: 'neon' }),
          listed: await call('list_threads', {}),
          startGemini: await call('delegate_task', {
            title: 'Fix thread list',
            instructions: 'Skip subagents.',
            project: 'Durango',
            model: 'antigravity:gemini-4-neon',
            effort: 'HIGH',
          }),
          startCloudAlias: await call('delegate_task', {
            title: 'Cloud alias',
            instructions: 'Use Opus.',
            project: 'Durango',
            model: 'anthropic/claude-opus-5.5',
            effort: 'max',
            access_mode: 'workspace-write',
            claude_context_window: '1m',
          }),
          startBadModel: await call('delegate_task', {
            title: 'Bad model',
            instructions: 'Nope.',
            project: 'Durango',
            model: 'antigravity:does-not-exist',
          }),
          startBadEffort: await call('delegate_task', {
            title: 'Bad effort',
            instructions: 'Nope.',
            project: 'Durango',
            model: 'antigravity:gemini-4-neon',
            effort: 'ultra',
          }),
          startNoEffortModel: await call('delegate_task', {
            title: 'No effort',
            instructions: 'Nope.',
            project: 'Durango',
            model: 'grok:grok-4.7-no-effort',
            effort: 'high',
          }),
          followUpSwitch: await call('message_thread', {
            thread_id: 'thread_1',
            message: 'Continue with Gemini.',
            model: 'Gemini 4 Neon',
            effort: 'xhigh',
          }),
          steerRunning: await call('message_thread', {
            thread_id: 'thread_1',
            message: 'Actually focus on tests first.',
            steer: true,
          }),
          steerWithModel: await call('message_thread', {
            thread_id: 'thread_1',
            message: 'Try switching during steer.',
            steer: true,
            model: 'antigravity:gemini-4-neon',
          }),
          readSpawnChild: await call('read_thread', { thread_id: 'subagent_child' }),
          configure: await call('manage_thread', {
            thread_id: 'thread_1',
            action: 'configure',
            model: 'codex:gpt-5.6-sol',
            effort: 'max',
            access_mode: 'read-only',
            codex_service_tier: 'priority',
          }),
          configureBad: await call('manage_thread', {
            thread_id: 'thread_1',
            action: 'configure',
          }),
          branch: await call('manage_thread', {
            thread_id: 'thread_1',
            action: 'branch',
          }),
        };
        return { text: 'Done.' };
      },
    });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.ok(delegateSchema.properties.effort, 'delegate_task schema enriched with effort');
    assert.ok(delegateSchema.properties.access_mode, 'delegate_task schema enriched with access_mode');
    assert.equal(results.modelsAll.ok, true);
    assert.equal(results.modelsAll.models.some((m) => m.id === 'codex:offline-model'), false, 'unavailable models omitted');
    assert.deepEqual(results.modelsGemini.models, [
      { id: 'antigravity:gemini-4-neon', label: 'Gemini 4 Neon', provider: 'Antigravity', efforts: ['low', 'medium', 'high', 'xhigh'] },
    ]);
    // list_threads includes model/effort/accessMode, counts spawn children on parent, and skips provider subagents
    assert.deepEqual(
      results.listed.threads.map((t) => ({ id: t.id, model: t.model, effort: t.effort, accessMode: t.accessMode, subagents: t.subagents })),
      [{ id: 'thread_1', model: 'claude:claude-opus-5-5', effort: 'high', accessMode: 'full-access', subagents: 1 }]
    );
    // Spawn children stay reachable by id (matching sidebarThreadRoots / main)
    assert.equal(results.readSpawnChild.ok, true);
    // Starting with model + effort passes exact modelId + normalized effort
    assert.equal(results.startGemini.ok, true);
    assert.equal(results.startGemini.model, 'antigravity:gemini-4-neon');
    assert.equal(results.startGemini.effort, 'high');
    assert.equal(started[0].modelId, 'antigravity:gemini-4-neon');
    assert.equal(started[0].reasoningEffort, 'high');
    // Cloud-style anthropic/ id resolves to claude:claude-opus-5-5
    assert.equal(results.startCloudAlias.ok, true);
    assert.equal(started[1].modelId, 'claude:claude-opus-5-5');
    assert.equal(started[1].reasoningEffort, 'max');
    assert.equal(started[1].accessMode, 'workspace-write');
    assert.equal(started[1].claudeContextWindow, '1m');
    // Validation errors fail BEFORE creating a bot task
    assert.equal(results.startBadModel.ok, false);
    assert.match(results.startBadModel.error, /has no model/);
    assert.equal(results.startBadEffort.ok, false);
    assert.match(results.startBadEffort.error, /takes effort low, medium, high, xhigh, not "ultra"/);
    assert.equal(results.startNoEffortModel.ok, false);
    assert.match(results.startNoEffortModel.error, /has no effort setting/);
    assert.equal(tasks.length, 3, 'invalid starts never create stray tasks (2 valid starts + 1 valid follow-up)');
    // message_thread switches model + effort on follow-up, and steers with bot attribution (rejecting setting overrides)
    assert.equal(results.followUpSwitch.ok, true);
    assert.equal(followUps[0].modelId, 'antigravity:gemini-4-neon');
    assert.equal(followUps[0].reasoningEffort, 'xhigh');
    assert.equal(results.steerRunning.ok, true);
    assert.equal(results.steerRunning.steered, true);
    assert.equal(followUps[1].steer, true);
    assert.match(followUps[1].prompt, /\(Steered by your bot "Scout"\)/);
    assert.equal(results.steerWithModel.ok, false);
    assert.match(results.steerWithModel.error, /Cannot change model/);
    // manage_thread configure + branch
    assert.equal(results.configure.ok, true);
    assert.equal(results.configure.model, 'codex:gpt-5.6-sol');
    assert.equal(results.configure.effort, 'max');
    assert.equal(results.configure.accessMode, 'read-only');
    assert.deepEqual(managed[0], {
      threadId: 'thread_1',
      action: 'configure',
      modelId: 'codex:gpt-5.6-sol',
      reasoningEffort: 'max',
      accessMode: 'read-only',
      codexServiceTier: 'priority',
    });
    assert.equal(results.configureBad.ok, false);
    assert.match(results.configureBad.error, /requires at least one of/);
    assert.equal(results.branch.ok, true);
    assert.equal(results.branch.threadId, 'thread_branch_1');
    assert.equal(results.branch.branchedFrom, 'thread_1');
    // branch fails cleanly if the renderer returns no new threadId (never falls back to the source thread)
    const brokenBranch = createBotThreadTools({
      readIndex: async () => ({ entries: [{ id: 'thread_1', projectId: 'p1', title: 'T', status: 'idle' }] }),
      readThread: async () => '',
      getProjects: () => [{ id: 'p1', name: 'Durango', path: '/x' }],
      manageThread: async () => ({ ok: true }),
    });
    const branchErr = await brokenBranch.manage({ thread_id: 'thread_1', action: 'branch' });
    assert.equal(branchErr.ok, false);
    assert.match(branchErr.error, /could not be branched/);
    // Claims advertise thread-configure alongside thread-actions
    assert.ok(client.calls.claim.some((c) => c.features?.includes('thread-configure')), 'claims advertise thread-configure');
  });

  await test('queued configure threadAction from Durango forwards modelId, reasoningEffort, and accessMode and acknowledges final errors once', async () => {
    let pendingActions = [
      { id: 'ta_cfg', threadId: 'thread_1', action: 'configure', modelId: 'antigravity:gemini-4-neon', reasoningEffort: 'high', accessMode: 'workspace-write' },
      { id: 'ta_bad', threadId: 'thread_1', action: 'configure', modelId: 'ambiguous' },
    ];
    const client = createFakeClient({
      claim: async (input) => {
        pendingActions = pendingActions.filter((item) => !(input.ackThreadActions ?? []).includes(item.id));
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { lane: null, threadActions: [...pendingActions] };
      },
    });
    const calls = [];
    const threadTools = createBotThreadTools({
      readIndex: async () => ({ entries: [{ id: 'thread_1', projectId: 'p1', title: 'T', status: 'idle' }] }),
      readThread: async () => '',
      getProjects: () => [{ id: 'p1', name: 'Durango', path: '/x' }],
      listModels: async () => [
        { id: 'antigravity:gemini-4-neon', label: 'Gemini 4 Neon', slug: 'gemini-4-neon', providerId: 'antigravity', provider: 'Antigravity', efforts: ['low', 'medium', 'high'], available: true },
        { id: 'a:ambiguous', label: 'ambiguous', slug: 'ambiguous', providerId: 'a', provider: 'A', efforts: [], available: true },
        { id: 'b:ambiguous', label: 'ambiguous', slug: 'ambiguous', providerId: 'b', provider: 'B', efforts: [], available: true },
      ],
      manageThread: async (req) => {
        calls.push(req);
        return { ok: true, modelId: req.modelId, reasoningEffort: req.reasoningEffort, accessMode: req.accessMode };
      },
    });
    startWorker({ client, threadTools });
    await waitFor(() => pendingActions.length === 0, { label: 'all configure actions acked' });
    assert.deepEqual(calls, [
      { threadId: 'thread_1', action: 'configure', modelId: 'antigravity:gemini-4-neon', reasoningEffort: 'high', accessMode: 'workspace-write' },
    ]);
  });

  await test('delegate_task with thread_id: a thread here gets a follow-up (e.g. to ship it); one elsewhere goes to Durango', async () => {
    const client = createFakeClient({ claim: laneClaims([makeLane()]) });
    const tasks = [];
    client.createBotLaneTask = async (input) => {
      tasks.push(input);
      return { taskId: `task_${tasks.length}`, title: input.title };
    };
    const followUps = [];
    const threadTools = createBotThreadTools({
      readIndex: async () => ({ entries: [{ id: 'thread_here', projectId: 'p1', title: 'Fix spinner', status: 'idle', activityAt: 1 }] }),
      readThread: async () => '',
      getProjects: () => [{ id: 'p1', name: 'Durango', path: '/Users/me/durango' }],
    });
    let results;
    startWorker(
      {
        client,
        getMachineInfo: async () => ({ name: 'Roma MacBook', projects: [{ id: 'p1', name: 'Durango', path: '/Users/me/durango' }], models: [] }),
        startProjectThread: async () => ({ ok: true, threadId: 'unused' }),
        startThreadFollowUp: async (input) => {
          followUps.push(input);
          return { ok: true };
        },
        threadTools,
        runLane: async (lane, ctx) => {
          const call = (input) => ctx.callTool({ name: 'delegate_task', input, toolCallId: 't' }).then((out) => out.result);
          results = {
            here: await call({ title: 'Ship it', instructions: 'Ship this change now.', thread_id: 'thread_here', project: 'Durango' }),
            elsewhere: await call({ title: 'Ship there', instructions: 'Ship this change now.', thread_id: 'thread_on_omarchy' }),
          };
          return { text: 'Shipping.' };
        },
      },
      { accessMode: 'workspace-write' }
    );
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.equal(results.here.ok, true);
    assert.equal(results.here.threadId, 'thread_here');
    assert.equal(followUps.length, 1, 'a follow-up in the existing thread, not a new thread');
    assert.equal(followUps[0].threadId, 'thread_here');
    assert.match(followUps[0].prompt, /^Ship this change now\.\n\n\(From the bot/);
    assert.equal(tasks[0].title, 'Ship it');
    assert.equal(tasks[0].project, undefined);
    assert.deepEqual(client.calls.tool.map((call) => call.input.thread_id), ['thread_on_omarchy'], 'a thread not here: Durango sends it to its machine');
  });

  await test('"Needs you" requests: answer_thread_request presses Done/Reply/X; message_thread and steers to a waiting thread answer it; a busy thread is refused before any task', async () => {
    const client = createFakeClient({ claim: laneClaims([makeLane()]) });
    const tasks = [];
    client.createBotLaneTask = async (input) => {
      tasks.push(input);
      return { taskId: `task_${tasks.length}`, title: input.title };
    };
    const reports = [];
    client.reportBotTask = async (input) => {
      reports.push(input);
      return { ok: true };
    };
    const entries = [
      // The iOS release thread's shape: a turn still open, one request pinned.
      { id: 'thread_release', projectId: 'p1', title: 'Ship iOS app', status: 'running', activityAt: 3, shell: { userActions: [{ id: 'ua_asc', action: 'Sign in to App Store Connect in Chrome', url: 'https://appstoreconnect.apple.com/apps/1/distribution', requestedAt: 'x' }] } },
      { id: 'thread_two', projectId: 'p1', title: 'Two asks', status: 'idle', activityAt: 2, shell: { userActions: [{ id: 'ua_a', action: 'Sign in to npm', requestedAt: 'x' }] } },
      // A subagent's request shows on its parent, as on its card.
      { id: 'thread_two_sub', projectId: 'p1', title: 'Review', status: 'idle', parentThreadId: 'thread_two', shell: { userActions: [{ id: 'ua_b', action: 'Plug in the phone', requestedAt: 'y' }] } },
      { id: 'thread_secret', projectId: 'p1', title: 'Needs a key', status: 'running', activityAt: 1, shell: { userActions: [{ id: 'sr_1', action: 'Enter the Stripe key', requestedAt: 'x', secret: { name: 'STRIPE' } }] } },
      { id: 'thread_busy', projectId: 'p1', title: 'Busy', status: 'running', activityAt: 0 },
    ];
    // The renderer's live view (App.tsx threadTurnState), from the same rows.
    const live = (threadId) => {
      const own = entries.filter((entry) => entry.id === threadId || entry.parentThreadId === threadId);
      const actions = own.flatMap((entry) => (entry.shell?.userActions ?? []).map((action) => ({ ...action, threadId: entry.id })));
      return {
        ok: true,
        running: entries.find((entry) => entry.id === threadId)?.status === 'running',
        requests: actions.filter((action) => !action.secret).map(({ id, action, url, threadId: owner }) => ({ id, action, ...(url ? { url } : {}), ...(owner !== threadId ? { threadId: owner } : {}) })),
        secretIds: actions.filter((action) => action.secret).map((action) => action.id),
      };
    };
    const answered = [];
    const threadTools = createBotThreadTools({
      readIndex: async () => ({ entries }),
      readThread: async () => 'transcript',
      getProjects: () => [{ id: 'p1', name: 'Durango', path: '/Users/me/durango' }],
      threadTurnState: async (threadId) => live(threadId),
      answerRequest: async (input) => {
        answered.push(input);
        const thread = entries.find((entry) => (entry.shell?.userActions ?? []).some((action) => action.id === input.actionId));
        if (!thread) return { ok: false, error: 'That action is no longer waiting.' };
        thread.shell.userActions = thread.shell.userActions.filter((action) => action.id !== input.actionId);
        return { ok: true, threadId: thread.id };
      },
    });
    const followUps = [];
    let results;
    startWorker({
      client,
      threadTools,
      startThreadFollowUp: async (input) => {
        followUps.push(input);
        return { ok: true, threadId: input.threadId };
      },
      runLane: async (lane, ctx) => {
        const call = (name, input) => ctx.callTool({ name, input, toolCallId: `t_${name}` }).then((out) => out.result);
        results = {
          listed: await call('list_threads', {}),
          read: await call('read_thread', { thread_id: 'thread_release' }),
          // The person said "done", the bot passes it on: as a message, the request takes it as their reply.
          message: await call('message_thread', { thread_id: 'thread_release', message: 'The person says they are signed in. Carry on.' }),
          noneLeft: await call('answer_thread_request', { thread_id: 'thread_release', answer: 'done' }),
          several: await call('answer_thread_request', { thread_id: 'thread_two', answer: 'done' }),
          severalMessage: await call('message_thread', { thread_id: 'thread_two', message: 'Done.' }),
          done: await call('answer_thread_request', { thread_id: 'thread_two', request_id: 'ua_b', answer: 'done' }),
          wrongId: await call('answer_thread_request', { thread_id: 'thread_two', request_id: 'ua_nope', answer: 'done' }),
          replyEmpty: await call('answer_thread_request', { thread_id: 'thread_two', answer: 'reply' }),
          steer: await call('message_thread', { thread_id: 'thread_two', message: 'They cannot sign in: npm is down.', steer: true }),
          secret: await call('answer_thread_request', { thread_id: 'thread_secret', request_id: 'sr_1', answer: 'done' }),
          secretOnly: await call('answer_thread_request', { thread_id: 'thread_secret', answer: 'done' }),
          busy: await call('message_thread', { thread_id: 'thread_busy', message: 'Also do X.' }),
          busySteer: await call('message_thread', { thread_id: 'thread_busy', message: 'Also do X.', steer: true }),
          elsewhere: await call('answer_thread_request', { thread_id: 'thread_on_omarchy', answer: 'done' }),
        };
        return { text: 'Told the thread.' };
      },
    });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });

    const release = results.listed.threads.find((thread) => thread.id === 'thread_release');
    assert.deepEqual(release.needsYou, [{ id: 'ua_asc', action: 'Sign in to App Store Connect in Chrome', url: 'https://appstoreconnect.apple.com/apps/1/distribution' }], 'list_threads shows the pending request');
    assert.deepEqual(results.listed.threads.find((thread) => thread.id === 'thread_two').needsYou.map((request) => request.id), ['ua_a', 'ua_b'], "a subagent's request shows on its parent");
    assert.equal(results.listed.threads.find((thread) => thread.id === 'thread_secret').needsYou, undefined, 'a secret request is not one a bot answers');
    assert.deepEqual(results.read.needsYou.map((request) => request.id), ['ua_asc']);

    assert.equal(results.message.ok, true, 'not "already running a turn"');
    assert.equal(results.message.answeredRequest, 'ua_asc');
    assert.deepEqual(answered[0], { threadId: 'thread_release', actionId: 'ua_asc', op: 'reply', reply: 'The person says they are signed in. Carry on.', botName: 'Scout' });
    assert.match(results.noneLeft.error, /no pending "Needs you" request/);

    assert.match(results.several.error, /waits on 2 requests: pass request_id, one of: ua_a .*; ua_b /);
    assert.match(results.severalMessage.error, /waiting on the person for 2 requests: answer the one this is about with answer_thread_request/);
    assert.deepEqual(results.done, { ok: true, threadId: 'thread_two', requestId: 'ua_b', answer: 'done', request: 'Plug in the phone', note: results.done.note });
    assert.deepEqual(answered[1], { threadId: 'thread_two', actionId: 'ua_b', op: 'done', botName: 'Scout' });
    assert.match(results.wrongId.error, /No pending request "ua_nope" on that thread\. It waits on: ua_a/);
    assert.match(results.replyEmpty.error, /needs `reply`/);
    // One request left: a steer goes to it as the reply, not into the turn.
    assert.equal(results.steer.answeredRequest, 'ua_a');
    assert.deepEqual(answered[2], { threadId: 'thread_two', actionId: 'ua_a', op: 'reply', reply: 'They cannot sign in: npm is down.', botName: 'Scout' });

    assert.match(results.secret.error, /secret request: only the person/);
    assert.match(results.secretOnly.error, /only waits on a secret request/);
    assert.match(results.busy.error, /currently running a turn\. Pass `steer: true`/);
    assert.equal(results.busySteer.steered, true, 'a busy thread with no request still steers');

    assert.equal(answered.length, 3, 'secrets and refusals press nothing');
    assert.equal(tasks.length, 0, 'no task (and no failed task card) for answers or refusals');
    assert.equal(reports.length, 0);
    assert.deepEqual(followUps.map((input) => [input.threadId, input.steer === true]), [['thread_busy', true]]);
    assert.deepEqual(
      client.calls.tool.filter((call) => call.name !== 'list_threads').map((call) => [call.name, call.input.thread_id]),
      [['answer_thread_request', 'thread_on_omarchy']],
      'a thread not here: Durango hands it to its machine (list_threads also asks Durango for other machines)'
    );
  });

  await test('"Needs you" requests: a follow-up the renderer turned into the reply to a fresh request ends its task at once; queued answers from Durango run with the bot name', async () => {
    const client = createFakeClient({ claim: laneClaims([makeLane()]) });
    client.createBotLaneTask = async (input) => ({ taskId: 'task_1', title: input.title });
    const reports = [];
    client.reportBotTask = async (input) => {
      reports.push(input);
      return { ok: true };
    };
    const threadTools = createBotThreadTools({
      readIndex: async () => ({ entries: [{ id: 'thread_1', projectId: 'p1', title: 'T', status: 'idle' }] }),
      readThread: async () => '',
      getProjects: () => [{ id: 'p1', name: 'Durango', path: '/x' }],
      // The look before it found nothing pending; the request came just after.
      threadTurnState: async () => ({ ok: true, running: false, requests: [], secretIds: [] }),
      answerRequest: async () => ({ ok: true }),
    });
    let result;
    startWorker({
      client,
      threadTools,
      startThreadFollowUp: async (input) => ({ ok: true, threadId: input.threadId, answeredRequest: 'ua_new' }),
      runLane: async (lane, ctx) => {
        result = (await ctx.callTool({ name: 'message_thread', input: { thread_id: 'thread_1', message: 'Signed in.' }, toolCallId: 't' })).result;
        return { text: 'ok' };
      },
    });
    await waitFor(() => client.calls.finish.length === 1 && reports.length === 1, { label: 'finish + report' });
    assert.equal(result.ok, true);
    assert.equal(result.answeredRequest, 'ua_new');
    assert.equal(reports[0].taskId, 'task_1');
    assert.equal(reports[0].outcome, 'finished', 'finished, not a failed card');
    assert.match(reports[0].summary, /request ua_new, so this message went to it as their reply/);

    // From the cloud: answer_thread_request queued as a threadAction.
    let pending = [
      { id: 'ta_ans', threadId: 'thread_q', action: 'answer_request', answer: 'done', requestId: 'ua_q', botName: 'durango-primary' },
      { id: 'ta_gone', threadId: 'thread_q', action: 'answer_request', answer: 'done', requestId: 'ua_old' },
    ];
    const claimClient = createFakeClient({
      claim: async (input) => {
        pending = pending.filter((item) => !(input.ackThreadActions ?? []).includes(item.id));
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { lane: null, threadActions: [...pending] };
      },
    });
    const presses = [];
    const queuedTools = createBotThreadTools({
      readIndex: async () => ({ entries: [{ id: 'thread_q', projectId: 'p1', title: 'Q', status: 'running', shell: { userActions: [{ id: 'ua_q', action: 'Sign in', requestedAt: 'x' }] } }] }),
      readThread: async () => '',
      getProjects: () => [{ id: 'p1', name: 'Durango', path: '/x' }],
      answerRequest: async (input) => {
        presses.push(input);
        return { ok: true };
      },
    });
    startWorker({ client: claimClient, threadTools: queuedTools });
    await waitFor(() => pending.length === 0, { label: 'queued answers acknowledged' });
    assert.deepEqual(presses, [{ threadId: 'thread_q', actionId: 'ua_q', op: 'done', botName: 'durango-primary' }], 'the gone request is acknowledged without a press');
  });

  await test('manage_thread: a thread here is managed here (its tool replaces Durango\'s); one elsewhere goes to Durango', async () => {
    const client = createFakeClient({
      claim: laneClaims([
        makeLane({
          tools: [
            { name: 'manage_thread', description: 'cloud', inputSchema: {} },
            { name: 'settle_thread', description: 'legacy-cloud', inputSchema: {} },
            { name: 'web_search', description: 'x', inputSchema: {} },
          ],
        }),
      ]),
    });
    const managed = [];
    const threadTools = createBotThreadTools({
      readIndex: async () => ({ entries: [{ id: 'thread_here', projectId: 'p1', title: 'Fix spinner', status: 'idle', activityAt: 1 }] }),
      readThread: async () => '',
      getProjects: () => [{ id: 'p1', name: 'Durango', path: '/Users/me/durango' }],
      manageThread: async (req) => {
        managed.push(req);
        return { ok: true };
      },
    });
    let results;
    let toolNames;
    let manageSchema;
    startWorker({
      client,
      threadTools,
      runLane: async (lane, ctx) => {
        toolNames = lane.tools.map((tool) => tool.name);
        manageSchema = lane.tools.find((tool) => tool.name === 'manage_thread' && tool.description !== 'cloud').inputSchema;
        const call = (name, input) => ctx.callTool({ name, input, toolCallId: 't' }).then((out) => out.result);
        results = {
          settleHere: await call('manage_thread', { thread_id: 'thread_here', action: 'settle', reason: 'landed' }),
          snoozeHere: await call('manage_thread', { thread_id: 'thread_here', action: 'snooze' }),
          renameHere: await call('manage_thread', { thread_id: 'thread_here', action: 'rename', title: 'New title' }),
          legacySettleHere: await call('settle_thread', { thread_id: 'thread_here' }),
          elsewhere: await call('manage_thread', { thread_id: 'thread_on_omarchy', action: 'pin' }),
        };
        return { text: 'Updated.' };
      },
    });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.equal(toolNames.filter((name) => name === 'manage_thread').length, 1, 'one manage_thread: this machine\'s');
    assert.equal(toolNames.includes('settle_thread'), false, 'legacy settle_thread replaced by manage_thread');
    assert.ok(manageSchema.properties.run_on, 'a Durango bot can still name the machine that has it');
    assert.ok(toolNames.includes('web_search'));
    assert.equal(results.settleHere.ok, true);
    assert.equal(results.snoozeHere.ok, true);
    assert.equal(results.renameHere.ok, true);
    assert.equal(results.legacySettleHere.ok, true);
    assert.deepEqual(managed, [
      { threadId: 'thread_here', action: 'settle' },
      { threadId: 'thread_here', action: 'snooze' },
      { threadId: 'thread_here', action: 'rename', title: 'New title' },
      { threadId: 'thread_here', action: 'settle' },
    ]);
    assert.deepEqual(
      client.calls.tool.map((call) => ({ name: call.name, thread_id: call.input.thread_id, action: call.input.action })),
      [{ name: 'manage_thread', thread_id: 'thread_on_omarchy', action: 'pin' }],
      'a thread not here: Durango queues it for its machine'
    );
  });

  await test('threadActions and legacy settleThreads from Durango: run once, acknowledged on the next claim; a closed window retries', async () => {
    // Like Durango: every poll hands out what the machine hasn't acknowledged yet.
    let pendingSettles = ['thread_here', 'thread_elsewhere', 'thread_later', 'thread_saved', 'thread_h'];
    let pendingActions = [
      { id: 'ta_snooze', threadId: 'thread_here', action: 'snooze' },
      { id: 'ta_rename', threadId: 'thread_here', action: 'rename', title: 'Renamed remotely' },
      { id: 'ta_elsewhere', threadId: 'thread_elsewhere', action: 'delete' },
      { id: 'ta_short', threadId: 'thread_h', action: 'delete' },
      { id: 'ta_stop_idle', threadId: 'thread_here', action: 'stop' },
      { id: 'ta_later', threadId: 'thread_later', action: 'unsettle' },
    ];
    const client = createFakeClient({
      claim: async (input) => {
        pendingSettles = pendingSettles.filter((id) => !(input.ackSettleThreads ?? []).includes(id));
        pendingActions = pendingActions.filter((item) => !(input.ackThreadActions ?? []).includes(item.id));
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { lane: null, settleThreads: [...pendingSettles], threadActions: [...pendingActions] };
      },
    });
    const calls = [];
    let settleWindowOpen = false;
    let actionWindowOpen = false;
    const threadTools = createBotThreadTools({
      readIndex: async () => ({
        entries: [
          { id: 'thread_here', projectId: 'p1', title: 'Done', status: 'idle', activityAt: 1 },
          { id: 'thread_later', projectId: 'p1', title: 'Later', status: 'idle', activityAt: 2 },
          { id: 'thread_saved', projectId: 'p1', title: 'Save fails once', status: 'idle', activityAt: 3 },
        ],
      }),
      readThread: async () => '',
      getProjects: () => [{ id: 'p1', name: 'Durango', path: '/Users/me/durango' }],
      manageThread: async ({ threadId, action, title }) => {
        // Delay snooze longer than rename so an unchained concurrent runner would finish rename first.
        if (threadId === 'thread_here' && action === 'snooze') await new Promise((resolve) => setTimeout(resolve, 25));
        calls.push({ threadId, action, ...(title ? { title } : {}) });
        if (threadId === 'thread_later' && action === 'settle' && !settleWindowOpen) {
          settleWindowOpen = true;
          return { ok: false, error: 'Open a Durango Code window on this Mac to run agents from Durango Chat.' };
        }
        if (threadId === 'thread_later' && action === 'unsettle' && !actionWindowOpen) {
          actionWindowOpen = true;
          return { ok: false, error: 'Open a Durango Code window on this Mac to run agents from Durango Chat.' };
        }
        if (threadId === 'thread_saved' && calls.filter((c) => c.threadId === 'thread_saved').length === 1) {
          return { ok: false, error: 'The remote command changed the host, but its thread state could not be saved.' };
        }
        if (action === 'stop') {
          return { ok: false, error: 'No running turn on that thread.' };
        }
        return { ok: true };
      },
    });
    startWorker({ client, threadTools });
    await waitFor(() => client.calls.claim.some((call) => call.ackSettleThreads?.includes('thread_later')), { label: 'later settle ack' });
    await waitFor(() => client.calls.claim.some((call) => call.ackSettleThreads?.includes('thread_saved')), { label: 'saved ack' });
    await waitFor(() => pendingSettles.length === 0 && pendingActions.length === 0, { label: 'all acknowledged' });
    assert.equal(calls.filter((c) => c.threadId === 'thread_saved').length, 2, 'a save that failed is tried again, not dropped');
    assert.equal(calls.filter((c) => c.action === 'stop').length, 1, 'no running turn is final: acknowledged, not retried');
    assert.equal(calls.some((c) => c.threadId === 'thread_h'), false, 'a short id from Durango never matches a thread by prefix');
    assert.equal(calls.some((c) => c.threadId === 'thread_elsewhere'), false, 'not a thread here: only acknowledged');
    assert.equal(calls.filter((c) => c.threadId === 'thread_here' && c.action === 'settle').length, 1, 'settle not applied twice');
    assert.equal(calls.filter((c) => c.threadId === 'thread_here' && c.action === 'snooze').length, 1, 'snooze applied once');
    assert.deepEqual(
      calls.filter((c) => c.threadId === 'thread_here' && c.action !== 'settle').map((c) => c.action),
      ['snooze', 'rename', 'stop'],
      'actions on the same thread run strictly in queued order'
    );
    assert.deepEqual(
      calls.filter((c) => c.action === 'rename'),
      [{ threadId: 'thread_here', action: 'rename', title: 'Renamed remotely' }]
    );
    assert.ok(client.calls.claim.some((call) => call.features?.includes('thread-actions')), 'claims advertise thread-actions feature');
    assert.equal(calls.filter((c) => c.threadId === 'thread_later' && c.action === 'settle').length, 2, 'settle retried after window failure');
    assert.equal(calls.filter((c) => c.threadId === 'thread_later' && c.action === 'unsettle').length, 2, 'action retried after window failure');
  });

  await test('thread tools: manage needs an allowed project, validates action/title, never settles while running, supports all actions', async () => {
    const ops = [];
    const tools = createBotThreadTools({
      readIndex: async () => ({
        entries: [
          { id: 'idle1', projectId: 'p1', title: 'Idle', status: 'idle', shell: { settledAt: '2026-11-20T00:00:00.000Z' } },
          { id: 'run1', projectId: 'p1', title: 'Running', status: 'idle', shell: { snoozedAt: '2026-11-20T00:00:00.000Z' } },
          { id: 'pin1', projectId: 'p1', title: 'Pinned', status: 'idle', shell: { pinnedAt: '2026-11-20T00:00:00.000Z' } },
          { id: 'hidden', projectId: 'secret', title: 'Not allowed', status: 'idle' },
        ],
      }),
      readThread: async () => '',
      getProjects: () => [{ id: 'p1', name: 'Site', path: '/x/site' }],
      liveStatus: (id) => (id === 'run1' ? 'running' : null),
      manageThread: async (req) => {
        ops.push(req);
        return { ok: true };
      },
    });
    assert.equal((await tools.manage({ thread_id: 'idle1', action: 'settle' })).ok, true);
    assert.equal((await tools.manage({ thread_id: 'idle1', action: 'unsettle' })).ok, true);
    assert.equal((await tools.manage({ thread_id: 'run1', action: 'snooze' })).ok, true, 'running threads can be snoozed');
    assert.equal((await tools.manage({ thread_id: 'run1', action: 'unsnooze' })).ok, true);
    assert.equal((await tools.manage({ thread_id: 'idle1', action: 'pin' })).ok, true);
    assert.equal((await tools.manage({ thread_id: 'idle1', action: 'unpin' })).ok, true);
    assert.equal((await tools.manage({ thread_id: 'idle1', action: 'rename', title: '  Clean  title  ' })).title, 'Clean title');
    assert.equal((await tools.manage({ thread_id: 'run1', action: 'stop' })).ok, true);
    assert.equal((await tools.manage({ thread_id: 'idle1', action: 'delete' })).ok, true);
    assert.match((await tools.manage({ thread_id: 'run1', action: 'settle' })).error, /running a turn/);
    assert.match((await tools.manage({ thread_id: 'idle1', action: 'rename', title: '   ' })).error, /title is required/);
    assert.match((await tools.manage({ thread_id: 'idle1', action: 'bogus' })).error, /Unsupported thread action/);
    await assert.rejects(tools.manage({ thread_id: 'hidden', action: 'settle' }), /No thread/);
    await assert.rejects(tools.manage({ thread_id: 'idle', action: 'settle' }, { exact: true }), /No thread/, 'a request from Durango needs the full id');
    await assert.rejects(tools.manage({ thread_id: 'idle', action: 'delete' }), /No thread/, 'delete always requires the exact full thread id');
    assert.equal((await tools.manage({ thread_id: 'idle', action: 'snooze' })).ok, true, 'non-delete calls may use a unique prefix');
    // Mirrored thread notes stay honest on rename/delete.
    const mirrorTools = createBotThreadTools({
      readIndex: async () => ({ entries: [{ id: 'mirror1', projectId: 'p1', title: 'Mirror', status: 'idle' }] }),
      readThread: async () => '',
      getProjects: () => [{ id: 'p1', name: 'Site', path: '/x/site' }],
      manageThread: async () => ({ ok: true, mirrored: true }),
    });
    assert.match((await mirrorTools.manage({ thread_id: 'mirror1', action: 'delete' })).note, /mirrored copy/);
    assert.match((await mirrorTools.manage({ thread_id: 'mirror1', action: 'rename', title: 'X' })).note, /mirrored copy/);
    // list_threads surfaces sidebar state and supports filtering by state
    const settledList = await tools.list({ state: 'settled' });
    assert.deepEqual(settledList.threads.map((t) => ({ id: t.id, settled: t.settled })), [{ id: 'idle1', settled: true }]);
    const snoozedList = await tools.list({ state: 'snoozed' });
    assert.deepEqual(snoozedList.threads.map((t) => ({ id: t.id, snoozed: t.snoozed })), [{ id: 'run1', snoozed: true }]);
    const pinnedList = await tools.list({ state: 'pinned' });
    assert.deepEqual(pinnedList.threads.map((t) => ({ id: t.id, pinned: t.pinned })), [{ id: 'pin1', pinned: true }]);
    const activeList = await tools.list({ state: 'active' });
    assert.deepEqual(activeList.threads.map((t) => t.id), ['pin1']);
    const noManage = createBotThreadTools({ readIndex: async () => ({ entries: [] }), readThread: async () => '', getProjects: () => [] });
    assert.match((await noManage.manage({ thread_id: 'x', action: 'settle' })).error, /not available/);
    assert.match((await noManage.manage({ thread_id: 'x', action: 'snooze' })).error, /not available/);
  });

  // --- threads on the person's other machines (remote control) ------------------------
  const remoteFixture = () => {
    const calls = { snapshot: 0, read: [], steer: [], stop: [], setState: [], userAction: [] };
    const hostThreads = [
      {
        id: 'host_build',
        projectId: 'hp_fm',
        title: 'Build FutureMail Agent Channel',
        status: 'running',
        modelId: 'antigravity:gemini-4-neon',
        updatedAt: '2026-11-27T06:20:00.000Z',
        messageCount: 3,
        settings: { accessMode: 'full-access', antigravityReasoningEffort: 'high' },
        userActions: [{ id: 'ua_login', action: 'Sign in to Railway', ownerThreadId: 'host_build_sub' }],
      },
      { id: 'host_build_sub', projectId: 'hp_fm', parentThreadId: 'host_build', title: 'Review', status: 'idle', updatedAt: '2026-11-27T06:21:00.000Z', messageCount: 2 },
      { id: 'host_new', projectId: 'hp_fm', title: 'Not mirrored yet', status: 'idle', updatedAt: '2026-11-27T05:00:00.000Z', messageCount: 4 },
      { id: 'host_np', projectId: 'orion:no-project', title: 'Quick question', status: 'done', updatedAt: '2026-11-27T04:00:00.000Z', messageCount: 2, settledAt: '2026-11-27T04:30:00.000Z' },
      { id: 'host_draft', projectId: 'hp_fm', title: 'Blank', status: 'idle', updatedAt: '2026-11-27T07:00:00.000Z', messageCount: 0 },
      { id: 'host_other', projectId: 'hp_secret', title: 'Elsewhere project', status: 'idle', updatedAt: '2026-11-27T03:00:00.000Z', messageCount: 2 },
    ];
    const entries = [
      // This machine's own thread: the index keeps ISO times (never epoch ms).
      { id: 'own_old', projectId: 'p_fm', title: 'Older here', status: 'done', messageCount: 3, activityAt: '2026-11-26T10:00:00.000Z' },
      { id: 'own_new', projectId: 'p_fm', title: 'Newer here', status: 'done', messageCount: 3, activityAt: '2026-11-27T06:10:00.000Z' },
      // This sidebar's mirror of the host thread (its own id here).
      {
        id: 'mirror_build',
        projectId: 'p_fm',
        title: 'Build FutureMail Agent Channel',
        status: 'running',
        messageCount: 3,
        activityAt: '2026-11-27T06:17:11.058Z',
        shell: { remote: { machineId: 'rc_omarchy', machineName: 'omarchy', threadId: 'host_build', projectName: 'futuremail' } },
      },
    ];
    let reachable = true;
    const remote = {
      hosts: () => [{ id: 'rc_omarchy', name: 'omarchy' }],
      snapshot: async () => {
        calls.snapshot += 1;
        if (!reachable) return { ok: false, error: 'offline' };
        return {
          ok: true,
          snapshot: {
            machine: { id: 'rc_omarchy', name: 'omarchy' },
            projects: [
              { id: 'hp_fm', name: 'futuremail', path: '/home/me/futuremail' },
              { id: 'hp_secret', name: 'secret', path: '/home/me/secret' },
            ],
            threads: hostThreads,
          },
        };
      },
      readThread: async (args) => {
        calls.read.push(args);
        return `host transcript of ${args.threadId}`;
      },
      steer: async (args) => {
        calls.steer.push(args);
        return { ok: true };
      },
      stop: async (args) => {
        calls.stop.push(args);
        return { ok: true };
      },
      setState: async (args) => {
        calls.setState.push(args);
        return { ok: true };
      },
      userAction: async (args) => {
        calls.userAction.push(args);
        return { ok: true };
      },
    };
    const localReads = [];
    const local = [];
    const tools = (options = {}) =>
      createBotThreadTools({
        readIndex: async () => ({ entries }),
        readThread: async (args) => {
          localReads.push(args);
          return `local read of ${args.thread_id}`;
        },
        getProjects: () => [{ id: 'p_fm', name: 'futuremail', path: '/Users/me/futuremail' }],
        machineName: () => 'Roma’s MacBook Air',
        manageThread: async (req) => {
          local.push(req);
          return { ok: true };
        },
        remote,
        ...options,
      });
    return { calls, entries, hostThreads, remote, tools, localReads, local, setReachable: (value) => (reachable = value) };
  };

  await test('thread tools across machines: list_threads lists this machine and every reachable machine, newest first, with `machine`', async () => {
    const fx = remoteFixture();
    const listed = await fx.tools().list({});
    assert.equal(listed.ok, true);
    assert.deepEqual(
      listed.threads.map((thread) => [thread.id, thread.machine, thread.status]),
      [
        ['mirror_build', 'omarchy', 'running'],
        ['own_new', 'Roma’s MacBook Air', 'done'],
        ['host_new', 'omarchy', 'idle'],
        ['own_old', 'Roma’s MacBook Air', 'done'],
      ],
      'ISO times sort newest first; the mirror is listed once, under its id here, from the host listing; drafts, other projects and no-project threads stay out under an allowlist'
    );
    const build = listed.threads[0];
    assert.equal(build.hostThreadId, 'host_build');
    assert.equal(build.project, 'futuremail');
    assert.equal(build.effort, 'high');
    assert.equal(build.subagents, 1);
    assert.deepEqual(build.needsYou, [{ id: 'ua_login', action: 'Sign in to Railway', threadId: 'host_build_sub' }]);
    assert.equal(listed.threads[1].lastActivity, '2026-11-27T06:10:00.000Z', 'lastActivity is no longer null for ISO index times');
    // No allowlist: threads outside a project and other machines' projects are listed too.
    const all = await fx.tools({ allProjectsAllowed: () => true }).list({ limit: 40 });
    assert.deepEqual(all.threads.map((thread) => thread.id).sort(), ['host_new', 'host_np', 'host_other', 'mirror_build', 'own_new', 'own_old']);
    assert.equal(all.threads.find((thread) => thread.id === 'host_np').project, 'No project');
    // Filters: by machine, by project, subagents.
    assert.deepEqual((await fx.tools().list({ machine: 'omarchy' })).threads.map((thread) => thread.id), ['mirror_build', 'host_new']);
    assert.deepEqual((await fx.tools().list({ machine: 'romas macbook air' })).threads.map((thread) => thread.id), ['own_new', 'own_old']);
    assert.ok((await fx.tools().list({ include_subagents: true })).threads.some((thread) => thread.id === 'host_build_sub' && thread.parentThreadId === 'mirror_build'));
    // A machine asked itself (Durango's skipHosts, by name) is left to it.
    assert.deepEqual((await fx.tools().list({}, { skipHosts: ['Omarchy'] })).threads.map((thread) => thread.id), ['own_new', 'own_old']);
    // Unreachable: its mirrors as last seen, marked stale.
    fx.setReachable(false);
    const offline = await fx.tools().list({});
    assert.deepEqual(offline.threads.map((thread) => [thread.id, thread.stale ?? false]), [
      ['mirror_build', true],
      ['own_new', false],
      ['own_old', false],
    ]);
    assert.match(offline.note, /Couldn't reach omarchy/);
  });

  await test('thread tools across machines: ids here or there resolve; read is live from the host; requests, settle, stop, steer go there', async () => {
    const fx = remoteFixture();
    const tools = fx.tools();
    // The host's id (from a task report) finds this sidebar's mirror.
    const byHostId = await tools.findThread('host_build');
    assert.equal(byHostId.entry.id, 'mirror_build');
    assert.deepEqual(byHostId.remote, { machineId: 'rc_omarchy', machineName: 'omarchy', hostThreadId: 'host_build', mirrorId: 'mirror_build', reachable: true });
    // A host thread with no mirror here is found in the host's listing.
    const unmirrored = await tools.findThread('host_new');
    assert.equal(unmirrored.remote.mirrorId, null);
    await assert.rejects(tools.findThread('host_other'), /No thread "host_other"/, 'a project bots may not use stays out');
    await assert.rejects(tools.findThread('host_build', { skipHosts: ['omarchy'] }), (error) => error.notHere === true);

    // Mirror: read through this machine's reader (it fetches from the host); no mirror: from the host directly.
    const read = await tools.read({ thread_id: 'host_build', limit: 1 });
    assert.equal(read.transcript, 'local read of mirror_build');
    assert.equal(read.machine, 'omarchy');
    assert.deepEqual(read.needsYou, [{ id: 'ua_login', action: 'Sign in to Railway', threadId: 'host_build_sub' }]);
    assert.equal((await tools.read({ thread_id: 'host_new' })).transcript, 'host transcript of host_new');
    assert.deepEqual(fx.calls.read, [{ machineId: 'rc_omarchy', threadId: 'host_new' }]);

    const answered = await tools.answer({ thread_id: 'mirror_build', answer: 'done' });
    assert.equal(answered.ok, true);
    assert.deepEqual(fx.calls.userAction, [{ machineId: 'rc_omarchy', threadId: 'host_build', actionId: 'ua_login', op: 'done', botName: '' }]);
    const routed = await tools.routeMessage(byHostId, { message: 'I signed in' });
    assert.equal(routed.result.answeredRequest, 'ua_login');
    assert.equal(fx.calls.userAction[1].op, 'reply');

    assert.match((await tools.manage({ thread_id: 'host_build', action: 'settle' })).error, /running a turn/, 'the host says it runs');
    const pinned = await tools.manage({ thread_id: 'host_build', action: 'pin' });
    assert.equal(pinned.ok, true);
    assert.equal(fx.calls.setState[0].threadId, 'host_build');
    assert.ok(fx.calls.setState[0].state.pinnedAt);
    assert.equal((await tools.manage({ thread_id: 'host_new', action: 'settle' })).ok, true);
    assert.deepEqual(Object.keys(fx.calls.setState[1].state), ['settledAt']);
    assert.equal((await tools.manage({ thread_id: 'mirror_build', action: 'stop' })).ok, true);
    assert.deepEqual(fx.calls.stop, [{ machineId: 'rc_omarchy', threadId: 'host_build' }]);
    assert.equal(fx.local.length, 0, 'nothing ran on this machine\'s renderer');
    // Rename/configure/branch/delete are the host's own: forwarded to Durango, or reported as elsewhere.
    const elsewhere = await tools.manage({ thread_id: 'host_build', action: 'rename', title: 'New name' });
    assert.deepEqual(elsewhere.elsewhere, { machine: 'omarchy', threadId: 'host_build' });
    const forwarded = [];
    const viaDurango = await tools.manage(
      { thread_id: 'host_build', action: 'rename', title: 'New name' },
      { forward: async (name, input) => (forwarded.push({ name, input }), { ok: true, status: 'queued' }) }
    );
    assert.equal(viaDurango.ok, true);
    assert.deepEqual(forwarded, [{ name: 'manage_thread', input: { thread_id: 'host_build', action: 'rename', title: 'New name', run_on: 'omarchy' } }]);
    const steered = await tools.steerRemote(byHostId, 'Also check the docs');
    assert.equal(steered.ok, true);
    assert.deepEqual(fx.calls.steer, [{ machineId: 'rc_omarchy', threadId: 'host_build', prompt: 'Also check the docs' }]);
    const located = await tools.locate({ thread_id: 'mirror_build' });
    assert.deepEqual(
      { own: located.own, threadId: located.threadId, hostThreadId: located.hostThreadId, machine: located.machine, running: located.running },
      { own: false, threadId: 'mirror_build', hostThreadId: 'host_build', machine: 'omarchy', running: true }
    );
    assert.equal((await tools.locate({ thread_id: 'own_new' })).own, true);
    await assert.rejects(tools.locate({ thread_id: 'mirror_b' }), (error) => error.notHere === true, 'locate (before a mutation from Durango) takes full ids only');
    // A queued action Durango hands every machine: a mirror answers to its own id, never its host's (the host runs it).
    await assert.rejects(tools.manage({ thread_id: 'host_build', action: 'pin' }, { exact: true, matchHostIds: false }), /No thread/);
    assert.equal((await tools.manage({ thread_id: 'mirror_build', action: 'unpin' }, { exact: true, matchHostIds: false })).ok, true);
    // Durango knows the host by another name: the forward is sent again without run_on.
    const sentForwards = [];
    const renamed = await tools.manage(
      { thread_id: 'host_build', action: 'rename', title: 'X' },
      {
        forward: async (name, input) => {
          sentForwards.push(input);
          return input.run_on ? { ok: false, error: 'No machine called "omarchy". Known: omarchy-linux.' } : { ok: true, status: 'queued' };
        },
      }
    );
    assert.equal(renamed.ok, true);
    assert.deepEqual(sentForwards.map((input) => input.run_on ?? null), ['omarchy', null]);
  });

  await test('review fixes: mirror ids with skipHosts, forwarded branch, prefixes, own_only, unreachable mirrors', async () => {
    const fx = remoteFixture();
    const tools = fx.tools();
    // omarchy answers for itself (skipHosts): this machine still knows its own mirror id, and says where it runs.
    const located = await tools.locate({ thread_id: 'mirror_build' }, { skipHosts: ['omarchy'] });
    assert.deepEqual({ own: located.own, hostThreadId: located.hostThreadId, machine: located.machine }, { own: false, hostThreadId: 'host_build', machine: 'omarchy' });
    await assert.rejects(tools.locate({ thread_id: 'host_build' }, { skipHosts: ['omarchy'] }), (error) => error.notHere === true, 'its id there is omarchy\'s to answer');
    // A forwarded branch keeps the new fork's id (not the original's).
    const branched = await tools.manage(
      { thread_id: 'mirror_build', action: 'branch' },
      { forward: async () => ({ ok: true, threadId: 'host_fork', branchedFrom: 'host_build', action: 'branch' }) }
    );
    assert.equal(branched.threadId, 'host_fork');
    assert.equal(branched.branchedFrom, 'mirror_build');
    assert.equal(branched.hostThreadId, undefined);
    // The retry without run_on is a separate attempt (its own tool call id upstream).
    const attempts = [];
    await tools.manage(
      { thread_id: 'mirror_build', action: 'rename', title: 'Y' },
      { forward: async (name, input, options) => (attempts.push(options.attempt), input.run_on ? { ok: false, error: 'No machine called "omarchy".' } : { ok: true }) }
    );
    assert.deepEqual(attempts, [0, 1]);
    // An exact id on a paired machine wins over a prefix here.
    fx.entries.push({ id: 'host_new_extra', projectId: 'p_fm', title: 'Shadow', status: 'idle', messageCount: 2, activityAt: '2026-11-20T00:00:00.000Z' });
    assert.equal((await tools.findThread('host_new')).entry.id, 'host_new', 'exact on omarchy beats a local prefix');
    await assert.rejects(tools.findThread('host_n'), /matches several threads/, 'prefixes across machines are ambiguous');
    fx.entries.pop();
    // own_only: Durango asked this machine alone.
    assert.deepEqual((await tools.list({ own_only: true })).threads.map((thread) => thread.machine), ['Roma’s MacBook Air', 'Roma’s MacBook Air']);
    // quiet: a project only another machine has is an empty list for Durango.
    assert.deepEqual(await tools.list({ project: 'studio-only' }, { quiet: true }), { ok: true, threads: [], unknownProject: true });
    assert.deepEqual(await tools.list({ project: 'futuremail', state: 'pinned' }, { quiet: true }), { ok: true, threads: [] }, 'a known project with nothing matching is not unknown');
    assert.equal((await tools.list({ project: 'studio-only' })).ok, false);
    // A mirror of a machine remote control doesn't reach (pairing gone): actions say where it runs, so Durango can take them.
    const unpaired = fx.tools({ remote: { ...fx.remote, hosts: () => [] } });
    await assert.rejects(unpaired.manage({ thread_id: 'mirror_build', action: 'pin' }), (error) => error.notHere && error.elsewhere?.threadId === 'host_build' && error.elsewhere.machine === 'omarchy');
    assert.equal((await unpaired.manage({ thread_id: 'mirror_build', action: 'rename', title: 'Z' })).elsewhere.threadId, 'host_build', 'rename is the host\'s anyway');
    // Its "Needs you" requests and transcript here may be stale: answers and reads go there too.
    await assert.rejects(unpaired.answer({ thread_id: 'mirror_build', answer: 'done' }), (error) => error.notHere && error.elsewhere?.threadId === 'host_build');
    await assert.rejects(unpaired.read({ thread_id: 'mirror_build' }), (error) => error.notHere && error.elsewhere?.machine === 'omarchy');
    assert.equal(fx.calls.userAction.length, 0);
    assert.equal(fx.calls.setState.length, 0);
  });

  await test('machine lane review fixes: retries get their own call ids; list_threads machine/project filters; unreachable mirrors go through Durango', async () => {
    const fx = remoteFixture();
    fx.hostThreads[0].status = 'idle';
    fx.hostThreads[0].userActions = [];
    // Durango records each tool call's result by its id: the same id again gets the first result back.
    const recorded = new Map();
    const served = [];
    const client = createFakeClient({
      claim: laneClaims([makeLane()]),
      tool: (input) => {
        if (recorded.has(input.toolCallId)) return recorded.get(input.toolCallId);
        served.push([input.name, input.input]);
        let result;
        if (input.name === 'delegate_task') {
          result = input.input.run_on ? { ok: false, error: 'No machine called "omarchy". Known: omarchy-linux.' } : { ok: true, taskId: 'task_x', threadId: input.input.thread_id, status: 'queued' };
        } else if (input.name === 'list_threads') {
          result = input.input.run_on === 'Studio' || input.input.project === 'studio-only'
            ? { ok: true, threads: [{ id: 'studio_1', title: 'Studio thing', machine: 'Studio', status: 'idle', lastActivity: '2026-11-27T06:30:00.000Z' }] }
            : { ok: true, threads: [{ id: 'host_build', title: 'Build', machine: 'omarchy', status: 'running', lastActivity: '2026-11-27T06:40:00.000Z' }] };
        } else if (input.name === 'manage_thread') {
          result = { ok: true, threadId: input.input.thread_id, status: 'queued' };
        } else if (input.name === 'message_thread') {
          result = input.input.run_on ? { ok: false, error: 'No machine called "omarchy". Known: omarchy-linux.' } : { ok: true, threadId: input.input.thread_id, steered: true };
        } else {
          result = { ok: false, error: 'No tool named x.' };
        }
        const response = { result };
        recorded.set(input.toolCallId, response);
        return response;
      },
    });
    let results;
    const unpairedRemote = { ...fx.remote, hosts: () => [] };
    startWorker({
      client,
      threadTools: fx.tools(),
      startThreadFollowUp: async () => ({ ok: true }),
      runLane: async (lane, ctx) => {
        const call = (name, input, id) => ctx.callTool({ name, input, toolCallId: id }).then((out) => out.result);
        results = {
          followUp: await call('message_thread', { thread_id: 'mirror_build', message: 'Ship it' }, 't1'),
          onOmarchy: await call('list_threads', { machine: 'omarchy' }, 't2'),
          onStudio: await call('list_threads', { machine: 'Studio' }, 't3'),
          studioProject: await call('list_threads', { project: 'studio-only' }, 't4'),
          // A thread on a machine this one doesn't control, named by a name Durango doesn't know: sent again without it.
          farSteer: await call('message_thread', { thread_id: 'far_9', message: 'Go', steer: true, run_on: 'omarchy' }, 't5'),
        };
        return { text: 'ok' };
      },
    });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.equal(results.followUp.ok, true, 'the retry without run_on really ran');
    assert.deepEqual(served.filter(([name]) => name === 'delegate_task').map(([, input]) => input.run_on ?? null), ['omarchy', null]);
    assert.ok(results.onOmarchy.threads.every((thread) => thread.machine === 'omarchy'), 'a machine this one controls is listed from here only');
    assert.ok(!served.some(([name, input]) => name === 'list_threads' && input.run_on === 'omarchy'));
    assert.deepEqual(results.onStudio.threads.map((thread) => thread.id), ['studio_1'], 'another machine is Durango\'s to list (run_on), nothing from here');
    assert.ok(served.some(([name, input]) => name === 'list_threads' && input.run_on === 'Studio' && !('machine' in input)));
    assert.deepEqual(results.studioProject.threads.map((thread) => thread.id), ['studio_1'], 'a project only another machine has: Durango\'s list');
    assert.equal(results.farSteer.steered, true);
    assert.deepEqual(served.filter(([name]) => name === 'message_thread').map(([, input]) => input.run_on ?? null), ['omarchy', null]);

    // A mirror whose machine remote control can't reach: Durango takes the action, with the thread's id there.
    const client2 = createFakeClient({ claim: laneClaims([makeLane({ laneId: 'lane_2' })]), tool: () => ({ result: { ok: true, status: 'queued' } }) });
    let pinned;
    startWorker({
      client: client2,
      threadTools: fx.tools({ remote: unpairedRemote }),
      startThreadFollowUp: async () => ({ ok: true }),
      runLane: async (lane, ctx) => {
        pinned = (await ctx.callTool({ name: 'manage_thread', input: { thread_id: 'mirror_build', action: 'pin' }, toolCallId: 'p1' })).result;
        return { text: 'ok' };
      },
    });
    await waitFor(() => client2.calls.finish.length === 1, { label: 'finish 2' });
    assert.equal(pinned.ok, true);
    assert.deepEqual(client2.calls.tool.map((call) => [call.name, call.input.thread_id, call.input.run_on]), [['manage_thread', 'host_build', 'omarchy']]);
  });

  await test('a steer from Durango to a thread waiting on one "Needs you" request answers it', async () => {
    const fx = remoteFixture();
    const posted = [];
    let claims = 0;
    const client = createFakeClient({
      claim: async (input) => {
        claims += 1;
        if (claims === 1) {
          return {
            lane: null,
            threadCalls: [
              { id: 'tc_steer', tool: 'steer_thread', input: { thread_id: 'mirror_build', message: 'I signed in\n\n(Steered by your bot "Scout")' }, botName: 'Scout', skipHosts: [] },
            ],
          };
        }
        return laneClaims([])(input);
      },
    });
    client.completeBotThreadCall = async (body) => (posted.push(body), { ok: true });
    startWorker({ client, threadTools: fx.tools(), startThreadFollowUp: async () => ({ ok: true }), runLane: async () => ({ text: '' }) });
    await waitFor(() => posted.length === 1, { label: 'steer result' });
    assert.equal(posted[0].result.answeredRequest, 'ua_login');
    assert.equal(fx.calls.steer.length, 0);
    assert.deepEqual(fx.calls.userAction.map((call) => [call.op, call.reply]), [['reply', 'I signed in']], 'the answer goes without the steer line');

    // A thread call on a mirror this machine can't reach: notHere, with where it runs.
    const unpairedPosted = [];
    let unpairedClaims = 0;
    const client2 = createFakeClient({
      claim: async (input) => {
        unpairedClaims += 1;
        if (unpairedClaims === 1) return { lane: null, threadCalls: [{ id: 'tc_pin', tool: 'manage_thread', input: { thread_id: 'mirror_build', action: 'pin' }, botName: 'Scout', skipHosts: [] }] };
        return laneClaims([])(input);
      },
    });
    client2.completeBotThreadCall = async (body) => (unpairedPosted.push(body), { ok: true });
    startWorker({ client: client2, threadTools: fx.tools({ remote: { ...fx.remote, hosts: () => [] } }), runLane: async () => ({ text: '' }) });
    await waitFor(() => unpairedPosted.length === 1, { label: 'unpaired result' });
    assert.equal(unpairedPosted[0].result.notHere, true);
    assert.deepEqual(unpairedPosted[0].result.elsewhere, { threadId: 'host_build', machine: 'omarchy' });
  });

  await test('message_thread to a thread on another machine: steers it there, or sends the follow-up through Durango to that machine', async () => {
    const fx = remoteFixture();
    fx.hostThreads[0].status = 'idle';
    fx.hostThreads[0].userActions = [];
    const client = createFakeClient({
      claim: laneClaims([makeLane()]),
      tool: (input) =>
        input.name === 'delegate_task'
          ? { result: { ok: true, taskId: 'task_remote', threadId: input.input.thread_id, status: 'queued' } }
          : { result: { ok: true } },
    });
    client.createBotLaneTask = async () => {
      throw new Error('a follow-up elsewhere is Durango\'s task, not this machine\'s');
    };
    const followUps = [];
    let results;
    startWorker(
      {
        client,
        getMachineInfo: async () => ({ name: 'Roma’s MacBook Air', projects: [], models: [] }),
        startProjectThread: async () => ({ ok: true, threadId: 'unused' }),
        startThreadFollowUp: async (input) => (followUps.push(input), { ok: true }),
        threadTools: fx.tools(),
        runLane: async (lane, ctx) => {
          const call = (name, input) => ctx.callTool({ name, input, toolCallId: `t_${name}` }).then((out) => out.result);
          results = {
            followUp: await call('message_thread', { thread_id: 'mirror_build', message: 'Ship it', model: 'antigravity:gemini-4-neon', access_mode: 'workspace-write' }),
            steer: await call('message_thread', { thread_id: 'host_build', message: 'Wrap up', steer: true }),
            shipByDelegate: await call('delegate_task', { title: 'Ship', instructions: 'Ship this change now.', thread_id: 'host_build' }),
            rename: await call('manage_thread', { thread_id: 'host_build', action: 'rename', title: 'Agent Channel' }),
            stop: await call('manage_thread', { thread_id: 'host_build', action: 'stop' }),
          };
          return { text: 'Done.' };
        },
      },
      { accessMode: 'full-access' }
    );
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.equal(followUps.length, 0, 'nothing runs in this machine\'s renderer');
    assert.equal(results.followUp.ok, true);
    assert.equal(results.followUp.threadId, 'mirror_build');
    assert.equal(results.followUp.hostThreadId, 'host_build');
    assert.equal(results.followUp.machine, 'omarchy');
    const sent = client.calls.tool.map((call) => [call.name, call.input]);
    assert.deepEqual(sent[0], [
      'delegate_task',
      { title: 'Follow-up: Build FutureMail Agent Channel', instructions: 'Ship it', thread_id: 'host_build', model: 'antigravity:gemini-4-neon', run_on: 'omarchy' },
    ]);
    assert.equal(results.steer.ok, true);
    assert.match(fx.calls.steer[0].prompt, /^Wrap up\n\n\(Steered by your bot "Scout"\)$/);
    assert.equal(sent[1][0], 'delegate_task');
    assert.equal(sent[1][1].thread_id, 'host_build');
    assert.deepEqual(sent[2], ['manage_thread', { thread_id: 'host_build', action: 'rename', title: 'Agent Channel', run_on: 'omarchy' }]);
    assert.equal(results.stop.ok, true);
    assert.equal(fx.calls.stop.length, 1);
    assert.equal(sent[2][0], 'manage_thread');
    assert.ok(client.calls.tool[2].toolCallId.startsWith('t_manage_thread'), 'a forward keeps its tool call id');
  });

  await test('a thread on a machine this one does not reach: read and follow up through Durango; list_threads adds what Durango lists', async () => {
    const fx = remoteFixture();
    const client = createFakeClient({
      claim: laneClaims([makeLane()]),
      tool: (input) => {
        if (input.name === 'read_thread') return { result: { ok: true, threadId: 'far_1', machine: 'Studio', transcript: 'far away' } };
        if (input.name === 'delegate_task') return { result: { ok: true, taskId: 'task_far', threadId: input.input.thread_id, status: 'queued' } };
        if (input.name === 'list_threads') {
          return {
            result: {
              ok: true,
              threads: [
                { id: 'far_1', title: 'On the studio Mac', machine: 'Studio', status: 'idle', lastActivity: '2026-11-27T06:15:00.000Z' },
                // What this machine told Durango itself, and omarchy's own row of the mirrored thread: not twice.
                { id: 'own_new', title: 'Newer here', machine: 'Roma’s MacBook Air', status: 'done', lastActivity: '2026-11-27T06:10:00.000Z' },
                { id: 'host_build', title: 'Build', machine: 'omarchy', status: 'running', lastActivity: '2026-11-27T06:20:00.000Z' },
              ],
            },
          };
        }
        return { result: { ok: false, error: 'No tool named x.' } };
      },
    });
    let results;
    startWorker({
      client,
      threadTools: fx.tools(),
      startThreadFollowUp: async () => ({ ok: true }),
      runLane: async (lane, ctx) => {
        const call = (name, input) => ctx.callTool({ name, input, toolCallId: `t_${name}` }).then((out) => out.result);
        results = {
          read: await call('read_thread', { thread_id: 'far_1' }),
          message: await call('message_thread', { thread_id: 'far_1', message: 'Ship it', title: 'Ship' }),
          list: await call('list_threads', { limit: 10 }),
        };
        return { text: 'ok' };
      },
    });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.equal(results.read.transcript, 'far away');
    assert.equal(results.message.ok, true);
    assert.deepEqual(client.calls.tool.find((call) => call.name === 'delegate_task').input, { title: 'Ship', instructions: 'Ship it', thread_id: 'far_1' });
    assert.deepEqual(results.list.threads.map((thread) => thread.id), ['mirror_build', 'far_1', 'own_new', 'host_new', 'own_old']);
  });

  await test('thread calls from Durango (a cloud reply): run here, results posted once, notHere for a thread this machine does not have', async () => {
    const fx = remoteFixture();
    const posted = [];
    let claims = 0;
    const client = createFakeClient({
      claim: async (input) => {
        claims += 1;
        if (claims === 1) {
          assert.ok(input.features.includes('thread-calls'));
          const call = (id, tool, callInput, extra = {}) => ({ id, tool, input: callInput, botName: 'Scout', skipHosts: [], ...extra });
          return {
            lane: null,
            threadCalls: [
              call('tc_list', 'list_threads', { limit: 5 }, { skipHosts: ['Roma’s MacBook Air'] }),
              call('tc_read', 'read_thread', { thread_id: 'host_build' }),
              call('tc_locate', 'locate_thread', { thread_id: 'host_build' }),
              call('tc_steer_own', 'steer_thread', { thread_id: 'own_new', message: 'Hurry' }),
              call('tc_missing', 'read_thread', { thread_id: 'nope' }),
              call('tc_answer', 'answer_thread_request', { thread_id: 'host_build', answer: 'done' }),
            ],
          };
        }
        // The same calls again (a lost ack): run once only.
        if (claims === 2) return { lane: null, threadCalls: [{ id: 'tc_list', tool: 'list_threads', input: {} }] };
        return laneClaims([])(input);
      },
    });
    client.completeBotThreadCall = async (body) => (posted.push(body), { ok: true });
    const followUps = [];
    startWorker({
      client,
      threadTools: fx.tools(),
      startThreadFollowUp: async (input) => (followUps.push(input), { ok: true }),
      runLane: async () => ({ text: '' }),
    });
    await waitFor(() => posted.length >= 6 && claims >= 3, { label: 'thread call results' });
    const byId = Object.fromEntries(posted.map((item) => [item.callId, item.result]));
    assert.equal(posted.length, 6, 'each call is answered once');
    assert.equal(posted[0].machineId, 'machine-1');
    assert.deepEqual(byId.tc_list.threads.map((thread) => thread.machine), ['omarchy', 'Roma’s MacBook Air', 'omarchy', 'Roma’s MacBook Air']);
    assert.equal(byId.tc_read.ok, true);
    assert.equal(byId.tc_read.machine, 'omarchy');
    assert.equal(byId.tc_locate.hostThreadId, 'host_build');
    assert.equal(byId.tc_locate.own, false);
    assert.equal(byId.tc_steer_own.ok, true);
    assert.deepEqual(followUps, [{ threadId: 'own_new', prompt: 'Hurry', botName: 'Scout', steer: true }]);
    assert.equal(byId.tc_missing.ok, false);
    assert.equal(byId.tc_missing.notHere, true);
    assert.equal(byId.tc_answer.ok, true);
    assert.equal(fx.calls.userAction[0].threadId, 'host_build');
  });

  await test('thread reports end with the thread id for message_thread', () => {
    assert.equal(threadReportFooter({}), '');
    assert.equal(
      threadReportFooter({ threadId: 't1', project: 'Site', machine: 'Mac' }),
      '(Durango Code thread t1, project Site, on Mac. Read it with read_thread and follow up there, e.g. to ship it, with message_thread thread_id "t1".)'
    );
    assert.equal(threadReportFooter({ threadId: 't1', cloud: true }), threadReportFooter({ threadId: 't1' }), 'one text for the cloud and machines');
    assert.equal(withThreadReportFooter('Done.', { threadId: 't1' }), 'Done.\n\n(Durango Code thread t1. Read it with read_thread and follow up there, e.g. to ship it, with message_thread thread_id "t1".)');
    assert.equal(withThreadReportFooter('Done.', {}), 'Done.');
  });

  await test('list_threads shows what the sidebar shows: subagent threads count on their parent', async () => {
    const parent = 'fbe30b4a-f4e7-429c-babc-4599aa660565';
    const entries = [
      { id: parent, projectId: 'p1', parentThreadId: null, title: 'Land chg_y6jdzkv2', status: 'idle', activityAt: 5, messageCount: 8 },
      // spawn_subagent children (reviews): parentThreadId set and hidden from the
      // sidebar, but not provider subagents (entry.subagent false).
      { id: 'fb1b6e7f-71d5-4572-b781-ea5bdde1d5a4', projectId: 'p1', parentThreadId: parent, title: 'Review chg_y6jdzkv2 (GPT-6.2 Sol)', status: 'idle', activityAt: 9, messageCount: 3, shell: { hiddenFromRecent: true } },
      { id: 'review2', projectId: 'p1', parentThreadId: parent, title: 'Review 2', status: 'running', activityAt: 8, messageCount: 2, shell: { hiddenFromRecent: true } },
      // A subagent of a subagent counts on the thread the sidebar lists.
      { id: 'nested', projectId: 'p1', parentThreadId: 'review2', title: 'Nested', status: 'idle', activityAt: 7, messageCount: 1 },
      // A provider's own subagent, as thread-storage.js indexes it (entry.subagent
      // false, the details object in its shell): hidden, never listed or counted.
      { id: 'native', projectId: 'p1', parentThreadId: parent, subagent: false, title: 'Explore', activityAt: 10, messageCount: 1, shell: { subagent: { id: 'task_1', providerId: 'claude', kind: 'Explore' } } },
      // Its own parent: hidden like any child (as the sidebar does).
      { id: 'self', projectId: 'p1', parentThreadId: 'self', title: 'Self', status: 'idle', activityAt: 13, messageCount: 1 },
      // Its parent is gone: the sidebar shows it on its own.
      { id: 'orphan', projectId: 'p1', parentThreadId: 'deleted-thread', title: 'Orphan', status: 'idle', activityAt: 4, messageCount: 2 },
      // A blank draft isn't in the sidebar; a pinned one, a running one or a Claude Code CLI one is.
      { id: 'blank', projectId: 'p1', title: '', status: 'idle', activityAt: 11, messageCount: 0 },
      { id: 'blank-pinned', projectId: 'p1', title: '', status: 'idle', activityAt: 3, messageCount: 0, pinnedAt: '2026-11-20T00:00:00.000Z' },
      { id: 'cli', projectId: 'p1', title: 'CLI', status: 'idle', modelId: 'claude:claude-code-cli', activityAt: 2, messageCount: 0 },
      { id: 'settled', projectId: 'p1', title: 'Settled', status: 'idle', activityAt: 1, messageCount: 4, shell: { settledAt: '2026-11-21T00:00:00.000Z' } },
      { id: 'settled-child', projectId: 'p1', parentThreadId: 'settled', title: 'Settled review', status: 'idle', activityAt: 12, messageCount: 2 },
    ];
    const tools = createBotThreadTools({
      readIndex: async () => ({ entries }),
      readThread: async (args) => `page of ${args.thread_id}`,
      getProjects: () => [{ id: 'p1', name: 'durango', path: '/x/durango' }],
    });
    const listed = await tools.list({ project: 'durango' });
    assert.deepEqual(listed.threads.map((thread) => thread.id), [parent, 'orphan', 'blank-pinned', 'cli', 'settled']);
    assert.equal(listed.threads[0].subagents, 3, 'both reviews and the nested one; not the provider subagent');
    assert.equal(listed.threads[4].subagents, 1);
    assert.equal('subagents' in listed.threads[1], false);
    assert.equal(listed.threads.some((thread) => thread.subagent), false);
    // Still reachable: listed on request (following their parent's sidebar state) and readable by id.
    const withSubagents = await tools.list({ project: 'durango', include_subagents: true, limit: 40 });
    assert.deepEqual(withSubagents.threads.map((thread) => thread.id), [
      'settled-child', 'fb1b6e7f-71d5-4572-b781-ea5bdde1d5a4', 'review2', 'nested', parent, 'orphan', 'blank-pinned', 'cli', 'settled',
    ]);
    assert.deepEqual(
      { subagent: withSubagents.threads[1].subagent, parentThreadId: withSubagents.threads[1].parentThreadId },
      { subagent: true, parentThreadId: parent }
    );
    assert.equal(withSubagents.threads[3].parentThreadId, 'review2');
    const active = await tools.list({ state: 'active', include_subagents: true });
    assert.equal(active.threads.some((thread) => thread.id === 'settled-child'), false, "a settled parent's subagents aren't active");
    const settled = await tools.list({ state: 'settled', include_subagents: true });
    assert.deepEqual(settled.threads.map((thread) => thread.id), ['settled-child', 'settled']);
    assert.equal(settled.threads[0].settled, true, 'a subagent thread reports its parent\'s sidebar state');
    await assert.rejects(tools.read({ thread_id: 'native' }), /No thread/, "a provider subagent's transcript isn't a thread of its own");
    assert.equal((await tools.read({ thread_id: 'fb1b6e7f-71d5-4572-b781-ea5bdde1d5a4' })).transcript, 'page of fb1b6e7f-71d5-4572-b781-ea5bdde1d5a4');
  });

  await test('thread tools: only allowed projects, newest first, by project name; reads resolve unique ids', async () => {
    const entries = [
      { id: 'aaa111', projectId: 'p1', title: 'Old', status: 'idle', activityAt: 1, messageCount: 4 },
      { id: 'aaa222', projectId: 'p1', title: 'New', status: 'idle', activityAt: 5, messageCount: 2 },
      { id: 'bbb333', projectId: 'p2', title: 'Elsewhere', status: 'error', activityAt: 9 },
      { id: 'ccc444', projectId: 'secret', title: 'Not allowed', status: 'idle', activityAt: 10 },
      { id: 'ddd555', projectId: 'p1', title: 'Subagent', subagent: true, activityAt: 11 },
    ];
    const reads = [];
    const tools = createBotThreadTools({
      readIndex: async () => ({ entries }),
      readThread: async (args) => {
        reads.push(args);
        return `page of ${args.thread_id}`;
      },
      getProjects: () => [{ id: 'p1', name: 'Site', path: '/x/site' }, { id: 'p2', name: 'API', path: '/x/api' }],
      liveStatus: (id) => (id === 'aaa222' ? 'running' : null),
    });
    const all = await tools.list({});
    assert.deepEqual(all.threads.map((thread) => thread.id), ['bbb333', 'aaa222', 'aaa111']);
    assert.equal(all.threads[1].status, 'running', 'the live status wins');
    assert.deepEqual((await tools.list({ project: 'site' })).threads.map((thread) => thread.title), ['New', 'Old']);
    assert.equal((await tools.list({ project: 'nope' })).ok, false);
    assert.equal((await tools.read({ thread_id: 'bbb' })).transcript, 'page of bbb333');
    await assert.rejects(tools.read({ thread_id: 'aaa' }), /matches several threads/);
    await assert.rejects(tools.read({ thread_id: 'ccc444' }), /No thread/);
    assert.deepEqual(reads, [{ thread_id: 'bbb333' }]);
  });

  await test('every bot reply runs with Full access, whatever was saved before', async () => {
    for (const [accessMode, expected] of [
      ['read-only', { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }],
      ['full-access', { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }],
    ]) {
      const sdk = createFakeSdk(async function* ({ next }) {
        await next();
        yield assistant('a', [{ type: 'text', text: 'ok' }]);
        yield success();
      });
      const client = createFakeClient({ claim: laneClaims([makeLane({ model: null })]) });
      startWorker({ client, runLane: sdkRunner(sdk) }, { accessMode });
      await waitFor(() => client.calls.finish.length === 1, { label: `finish ${accessMode}` });
      const { options } = sdk.runs[0];
      assert.equal(options.permissionMode, expected.permissionMode);
      assert.equal(options.allowDangerouslySkipPermissions, expected.allowDangerouslySkipPermissions);
      assert.equal('model' in options, false, 'no model → Claude Code default');
      assert.equal(client.calls.finish[0].modelId, undefined);
      for (const worker of liveWorkers) worker.stop();
    }
  });

  await test('bot tools are served in-process and proxied to Durango', async () => {
    let toolOutput;
    const sdk = createFakeSdk(async function* ({ next, options, tools }) {
      await next();
      yield init();
      yield assistant('a1', [{ type: 'tool_use', id: 'tu_42', name: 'mcp__durango_bot__web_search', input: { q: 'news' } }]);
      await options.hooks.PreToolUse[0].hooks[0]({ tool_name: 'mcp__durango_bot__web_search', tool_use_id: 'tu_42', tool_input: { q: 'news' } });
      toolOutput = await tools.web_search.handler({ q: 'news' });
      await options.hooks.PostToolUse[0].hooks[0]({ tool_name: 'mcp__durango_bot__web_search', tool_use_id: 'tu_42' });
      yield toolResult('tu_42');
      const failed = await tools.web_search.handler({ q: 'boom' });
      assert.equal(failed.isError, true);
      assert.match(failed.content[0].text, /web_search tool failed: Search is down/);
      yield assistant('a2', [{ type: 'text', text: 'Found 2.' }]);
      yield success();
    });
    const lane = makeLane({
      tools: [{ name: 'web_search', description: 'Search the web', inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'Query' } }, required: ['q'] } }],
    });
    const client = createFakeClient({
      claim: laneClaims([lane]),
      tool: (input) => {
        if (input.input.q === 'boom') throw new DurangoError('api', 'Search is down.', { status: 502 });
        return { result: { hits: 2, top: 'x' } };
      },
    });
    startWorker({ client, runLane: sdkRunner(sdk) });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    const { options } = sdk.runs[0];
    const server = options.mcpServers.durango_bot;
    assert.equal(server.name, 'durango_bot');
    const definition = server.tools[0];
    assert.equal(definition.description, 'Search the web');
    assert.ok(definition.shape.q, 'JSON Schema → zod shape');
    assert.equal(definition.extras.alwaysLoad, true);
    assert.equal(options.allowedTools, undefined, 'Full access: nothing to pre-approve');
    assert.equal((await options.canUseTool('mcp__durango_bot__web_search', { q: 'x' })).behavior, 'allow');
    const call = client.calls.tool[0];
    assert.equal(call.laneId, 'lane_1');
    assert.equal(call.botId, 'bot_1');
    assert.equal(call.machineId, 'machine-1');
    assert.equal(call.name, 'web_search');
    assert.deepEqual(call.input, { q: 'news' });
    assert.equal(call.toolCallId, 'tu_42', 'the tool_use id from PreToolUse');
    assert.deepEqual(toolOutput, { content: [{ type: 'text', text: JSON.stringify({ hits: 2, top: 'x' }) }] });
    assert.ok(client.calls.progress.some((progress) => progress.activeTool === 'web_search'), 'running tool reported');
    assert.equal(client.calls.finish[0].text, 'Found 2.');
  });

  await test('inbox items reach the running session without interrupting it', async () => {
    let hookOutput;
    let seen = 0;
    const sdk = createFakeSdk(async function* ({ next, options }) {
      await next();
      yield init();
      yield assistant('a1', [{ type: 'text', text: 'Working on it.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }]);
      // The step's inbox take lands while the tool runs.
      await waitFor(() => client.calls.progress.some((call) => call.takeInbox) && seen >= 1, { label: 'inbox take' });
      await delay(10);
      hookOutput = await options.hooks.PostToolUse[0].hooks[0]({ tool_name: 'Bash', tool_use_id: 'tu1' });
      const subagentHook = await options.hooks.PostToolUse[0].hooks[0]({ tool_name: 'Bash', tool_use_id: 'x', agent_id: 'sub' });
      assert.deepEqual(subagentHook, { continue: true }, 'subagents do not take the inbox');
      yield toolResult('tu1');
      yield assistant('a2', [{ type: 'text', text: 'Done, and the weather is sunny.' }]);
      yield success();
      // The final take returned a routine message: it continues this reply.
      const continuation = await next();
      assert.ok(continuation, 'continuation pushed');
      assert.equal(
        textOf(continuation),
        `${BOT_INBOX_HEADER}\n\n[Morning digest]\nRun the digest.`
      );
      yield assistant('a3', [{ type: 'text', text: 'Digest: all quiet.' }]);
      yield success();
    });
    const client = createFakeClient({
      claim: laneClaims([makeLane()]),
      progress: (input) => {
        if (!input.takeInbox) return { stop: false, inbox: [] };
        seen += 1;
        if (seen === 1) return { stop: false, inbox: [{ seq: 1, source: 'person', label: null, content: 'Also check the weather.' }] };
        // Repeated item (same seq) is not delivered twice.
        if (seen === 2) return { stop: false, inbox: [{ seq: 1, source: 'person', label: null, content: 'Also check the weather.' }] };
        if (seen === 3) return { stop: false, inbox: [{ seq: 2, source: 'routine', label: 'Morning digest', content: 'Run the digest.' }] };
        return { stop: false, inbox: [] };
      },
    });
    startWorker({ client, runLane: sdkRunner(sdk) });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.deepEqual(hookOutput, {
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `${BOT_INBOX_HEADER}\n\nAlso check the weather.` },
    });
    assert.equal(sdk.runs[0].inputs.length, 2, 'the first prompt and one continuation');
    assert.equal(client.calls.finish[0].text, 'Working on it.\n\nDone, and the weather is sunny.\n\nDigest: all quiet.');
    const lastTake = client.calls.progress.filter((call) => call.takeInbox).at(-1);
    assert.equal(lastTake.text, 'Working on it.\n\nDone, and the weather is sunny.\n\nDigest: all quiet.', 'final take right before finishing');
  });

  await test('quick back-to-back messages (He -> Hey) with no tool calls discard the draft greeting and answer once', async () => {
    let beforeFinishCalls = 0;
    const sdk = createFakeSdk(async function* ({ next }) {
      const first = await next();
      assert.equal(textOf(first), 'He');
      yield init('claude-opus-5-5');
      // Quick tool-free answer to "He".
      yield assistant('a1', [{ type: 'text', text: 'Hey! What can I help you with?' }]);
      yield success();
      // Pre-finish check claimed "Hey" and discarded the unposted draft.
      const continuation = await next();
      assert.ok(continuation, 'continuation pushed with Hey');
      assert.equal(textOf(continuation), `${BOT_FINAL_INBOX_HEADER}\n\nHey`);
      yield assistant('a2', [{ type: 'text', text: "Hey! What's up?" }]);
      yield success();
    });
    const client = createFakeClient({
      claim: laneClaims([makeLane({ prompt: 'He', messages: true })]),
      progress: (input) => {
        if (!input.takeInbox) return { stop: false, inbox: [] };
        assert.equal(input.beforeFinish, true, 'quick tool-free reply only checks inbox with beforeFinish');
        beforeFinishCalls += 1;
        if (beforeFinishCalls === 1) return { stop: false, inbox: [{ seq: 1, source: 'person', label: null, content: 'Hey' }] };
        return { stop: false, inbox: [] };
      },
    });
    startWorker({ client, runLane: sdkRunner(sdk) });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.equal(beforeFinishCalls, 2);
    // Crucial: the draft greeting was NOT sent as an earlier message.
    assert.deepEqual(client.calls.message, []);
    assert.equal(client.calls.finish[0].text, "Hey! What's up?");
    assert.equal(sdk.runs[0].inputs.length, 2);
  });

  await test('messages arriving during the pre-finish check are capped at BOT_FINAL_INBOX_MAX_ROUNDS (never loops forever)', async () => {
    let takeCount = 0;
    const sdk = createFakeSdk(async function* ({ next }) {
      await next();
      yield init('claude-opus-5-5');
      for (let round = 0; ; round += 1) {
        yield assistant(`a${round}`, [{ type: 'text', text: `Reply round ${round}` }]);
        yield success();
        if (!(await next())) return;
      }
    });
    const client = createFakeClient({
      claim: laneClaims([makeLane({ prompt: 'He', messages: true })]),
      progress: (input) => {
        if (!input.takeInbox) return { stop: false, inbox: [] };
        takeCount += 1;
        // Every check returns another new person message.
        return { stop: false, inbox: [{ seq: takeCount, source: 'person', label: null, content: `followup ${takeCount}` }] };
      },
    });
    startWorker({ client, runLane: sdkRunner(sdk) });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.equal(takeCount, BOT_FINAL_INBOX_MAX_ROUNDS);
    assert.equal(sdk.runs[0].inputs.length, 1 + BOT_FINAL_INBOX_MAX_ROUNDS);
    assert.deepEqual(client.calls.message, []);
    assert.equal(client.calls.finish[0].text, `Reply round ${BOT_FINAL_INBOX_MAX_ROUNDS}`);
  });

  await test('stop from Durango aborts the run without a finish', async () => {
    let aborted = false;
    const sdk = createFakeSdk(async function* ({ next, aborted: abortedPromise }) {
      await next();
      yield init();
      yield assistant('a1', [{ type: 'text', text: 'Thinking…' }]);
      try {
        await abortedPromise;
      } catch {
        aborted = true;
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
    });
    const client = createFakeClient({
      claim: laneClaims([makeLane({ heartbeatMs: 40 })]),
      progress: (_input, n) => ({ stop: n >= 2, inbox: [] }),
    });
    const worker = startWorker({ client, runLane: sdkRunner(sdk) });
    await waitFor(() => aborted, { label: 'abort' });
    await waitFor(() => worker.getState().running.length === 0, { label: 'lane released' });
    await delay(60);
    assert.equal(client.calls.finish.length, 0);
    assert.ok(sdk.runs[0].closed);
  });

  await test('usage limit → finish with retryElsewhere', async () => {
    const sdk = createFakeSdk(async function* ({ next }) {
      await next();
      yield init();
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } };
      yield assistant('err', [{ type: 'text', text: "You've hit your limit · resets 3pm" }], { error: 'rate_limit', message: { id: 'err', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your limit · resets 3pm" }] } });
      yield { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm" };
    });
    const client = createFakeClient({ claim: laneClaims([makeLane()]) });
    startWorker({ client, runLane: sdkRunner(sdk) });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    const finish = client.calls.finish[0];
    assert.equal(finish.text, '');
    assert.equal(finish.retryElsewhere, true);
  });

  await test('not logged in / no SDK → retryElsewhere; other errors → failure with the text so far', async () => {
    // Claude Code signed out: the process fails before init.
    const signedOut = createFakeSdk(async function* ({ next }) {
      await next();
      throw new Error('Claude Code process exited with code 1');
    });
    let client = createFakeClient({ claim: laneClaims([makeLane()]) });
    startWorker({ client, runLane: sdkRunner(signedOut) });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish signed out' });
    assert.equal(client.calls.finish[0].retryElsewhere, true);
    for (const worker of liveWorkers) worker.stop();

    client = createFakeClient({ claim: laneClaims([makeLane()]) });
    startWorker({ client, runLane: sdkRunner(null, { loadSdk: async () => { throw new Error('Cannot find module @anthropic-ai/claude-agent-sdk'); } }) });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish no sdk' });
    assert.equal(client.calls.finish[0].retryElsewhere, true);
    assert.equal(client.calls.finish[0].text, '');
    for (const worker of liveWorkers) worker.stop();

    const midway = createFakeSdk(async function* ({ next }) {
      await next();
      yield init();
      yield assistant('a1', [{ type: 'text', text: 'Partial answer.' }]);
      yield { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached the maximum number of turns.'] };
    });
    client = createFakeClient({ claim: laneClaims([makeLane()]) });
    startWorker({ client, runLane: sdkRunner(midway) });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish failure' });
    assert.equal(client.calls.finish[0].text, 'Partial answer.');
    assert.equal(client.calls.finish[0].failure, 'Reached the maximum number of turns.');
    assert.equal(client.calls.finish[0].retryElsewhere, undefined);
  });

  await test('turning it off mid-reply aborts and hands the reply back', async () => {
    let started = false;
    const client = createFakeClient({ claim: laneClaims([makeLane()]) });
    const worker = startWorker({
      client,
      runLane: async (_lane, ctx) => {
        started = true;
        await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
        return { text: 'half', aborted: true };
      },
    });
    await waitFor(() => started, { label: 'lane started' });
    worker.configure({ settings: { enabled: false } });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.deepEqual(client.calls.finish[0], { laneId: 'lane_1', botId: 'bot_1', machineId: 'machine-1', text: '', retryElsewhere: true });
    assert.equal(worker.getState().status, 'off');
  });

  await test('reply files: attach_files, screenshots the text names, uploaded at finish', async () => {
    const shots = path.join(testRoot, 'shots');
    await fs.mkdir(shots, { recursive: true });
    for (const name of ['a-inbox.png', 'b-email.png', 'c-mobile.png', 'notes.txt']) await fs.writeFile(path.join(shots, name), name);
    let attachOutput;
    const sdk = createFakeSdk(async function* ({ next, tools }) {
      await next();
      yield init();
      attachOutput = await tools.attach_files.handler({ paths: [path.join(shots, 'notes.txt'), path.join(shots, 'missing.png'), 'relative.png'] });
      yield assistant('a1', [
        {
          type: 'text',
          text: `Done. The screenshots are in \`${shots}/\`:\n\n- \`a-inbox.png\`: inbox\n- \`b-email.png\`: email\n\n![mobile](${path.join(shots, 'c-mobile.png')})`,
        },
      ]);
      yield success();
    });
    const uploads = [];
    const client = createFakeClient({ claim: laneClaims([makeLane()]) });
    startWorker({
      client,
      runLane: sdkRunner(sdk),
      uploadReplyFile: async (file) => {
        uploads.push(file.name);
        if (file.name === 'b-email.png') throw new Error('Storage refused it.');
        return { id: `asset_${file.name.replace(/\W/g, '')}`, name: file.name, kind: file.name.endsWith('.png') ? 'image' : 'document' };
      },
    });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.match(attachOutput.content[0].text, /notes\.txt: attached\./);
    assert.match(attachOutput.content[0].text, /missing\.png: no such file\./);
    assert.match(attachOutput.content[0].text, /relative\.png: not a full path/);
    assert.deepEqual(uploads.sort(), ['a-inbox.png', 'b-email.png', 'c-mobile.png', 'notes.txt']);
    const finish = client.calls.finish[0];
    assert.deepEqual(
      finish.files.map((file) => file.name).sort(),
      ['a-inbox.png', 'c-mobile.png', 'notes.txt'],
      'uploaded files go with the finish'
    );
    assert.ok(!finish.text.includes('![mobile]'), 'an embed of an attached file leaves the text');
    assert.ok(finish.text.includes('`a-inbox.png`: inbox'), 'the rest of the text stays');
    assert.match(finish.text, /_Couldn't attach b-email\.png\._$/, 'a file that failed to upload is named');
  });

  await test('reply files: a task lane (replyFiles: false) gets no attach_files', async () => {
    const sdk = createFakeSdk(async function* ({ next }) {
      await next();
      yield init();
      yield assistant('a1', [{ type: 'text', text: `Report: /tmp/nothing-here.png` }]);
      yield success();
    });
    const outcome = await sdkRunner(sdk)(makeLane({ replyFiles: false }), {
      accessMode: 'full-access',
      update: () => {},
      takeInbox: async () => [],
      callTool: async () => ({ result: null }),
    });
    assert.deepEqual(sdk.runs[0].options.mcpServers, {});
    assert.equal(outcome.files, undefined);
    assert.equal(outcome.text, 'Report: /tmp/nothing-here.png');
  });

  await test('network errors on finish are retried', async () => {
    let attempts = 0;
    const client = createFakeClient({ claim: laneClaims([makeLane()]) });
    client.finishBotLane = async (input) => {
      attempts += 1;
      if (attempts < 3) throw new DurangoError('network', 'Could not reach Durango.');
      client.calls.finish.push(input);
      return { ok: true, stored: true };
    };
    startWorker({ client, runLane: async () => ({ text: 'ok' }), reportRetryDelaysMs: [5, 5, 5] });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish after retries' });
    assert.equal(attempts, 3);
  });

  // --- kept sessions (bot-sessions.js) -------------------------------------------------

  const row = (seq, role, text, extra = {}) => ({ id: `m${seq}`, seq, role, text, ...extra });
  const sessionLane = (history, answering, overrides = {}) =>
    makeLane({
      prompt: '',
      session: { history, answering, context: [{ text: '(Bot context, not from the person.)' }, { text: 'Roster: nobody.', steady: true }] },
      ...overrides,
    });
  /** A fake SDK that reports a session id and usage (context window `window`). */
  const sessionSdk = ({ sessionId = 'sess-1', window = 30_000, fail = null } = {}) =>
    createFakeSdk(async function* ({ next, options }) {
      await next();
      if (fail && fail(options)) {
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: gone'], session_id: 'x' };
        return;
      }
      yield { ...init(), session_id: options.resume ?? sessionId };
      // Each user message (the prompt, then inbox items at the turn's end) gets an answer.
      for (let turn = 1; ; turn += 1) {
        const text = turn === 1 ? 'Done.' : 'And that too.';
        const usage = { input_tokens: 10, cache_read_input_tokens: window - 1_000, cache_creation_input_tokens: 900, output_tokens: 90 };
        yield assistant(`a${turn}`, [{ type: 'text', text }], { message: { id: `a${turn}`, model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage } });
        yield { ...success(), session_id: options.resume ?? sessionId, usage: { ...usage, cache_creation: { ephemeral_1h_input_tokens: 900 } }, total_cost_usd: 0.01 };
        if (!(await next())) return;
      }
    });
  const sessionSdkReason = (run) => (run.options.resume ? 'resume' : 'fresh');
  const sessionCtx = (inbox = []) => ({ update: () => {}, takeInbox: async () => inbox.splice(0), callTool: async () => ({ result: null }) });

  await test('kept session: the first reply seeds it, the next resumes it with only what is new', async () => {
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-a') });
    const sdk = sessionSdk();
    const logs = [];
    const runLane = sdkRunner(sdk, { sessions, log: (...args) => logs.push(args.join(' ')) });
    const history = [row(1, 'user', 'Book a table for Friday.'), row(2, 'assistant', 'Which place?'), row(3, 'user', 'Sato, 7pm.')];
    const first = await runLane(sessionLane(history, [3], { replyMessageId: 'r4' }), sessionCtx());
    assert.equal(first.text, 'Done.');
    assert.equal(sdk.runs[0].options.resume, undefined, 'a new session');
    assert.equal(sdk.runs[0].options.persistSession, undefined, 'kept (saved to disk)');
    assert.match(textOf(sdk.runs[0].inputs[0]), /<conversation_so_far>\nPerson:\nBook a table for Friday\.\n\nScout \(you\):\nWhich place\?\n<\/conversation_so_far>/);
    assert.match(textOf(sdk.runs[0].inputs[0]), /<new_messages>\nPerson:\nSato, 7pm\.\n<\/new_messages>/);
    assert.match(textOf(sdk.runs[0].inputs[0]), /Roster: nobody\./);
    assert.deepEqual(first.usage && { mode: first.usage.mode, reason: first.usage.reason, read: first.usage.cacheRead, write1h: first.usage.cacheWrite1h }, { mode: 'fresh', reason: 'new', read: 29_000, write1h: 900 });
    assert.match(logs[0], /bot bot_1 reply usage/);

    // Next reply: the thread now has this reply (r4), a reply that ran in the cloud meanwhile, and a new message.
    const later = [
      ...history,
      { id: 'r4', seq: 4, role: 'assistant', text: 'Done.' },
      row(5, 'user', 'Also lunch Sat?'),
      row(6, 'assistant', 'Booked lunch (from the cloud).'),
      row(7, 'user', 'Thanks! And Sunday?'),
    ];
    const second = await runLane(sessionLane(later, [7], { laneId: 'lane_2', replyMessageId: 'r8' }), sessionCtx());
    assert.equal(second.text, 'Done.');
    assert.equal(sdk.runs[1].options.resume, 'sess-1', 'resumed');
    const prompt = textOf(sdk.runs[1].inputs[0]);
    assert.doesNotMatch(prompt, /Book a table|Which place|conversation_so_far/, 'nothing the session has seen');
    assert.doesNotMatch(prompt, /Scout \(you\):\nDone\./, 'its own reply is not repeated');
    assert.match(prompt, /<since_your_last_reply>[\s\S]*Person:\nAlso lunch Sat\?\n\nScout \(you\):\nBooked lunch \(from the cloud\)\.\n<\/since_your_last_reply>/);
    assert.match(prompt, /<new_messages>\nPerson:\nThanks! And Sunday\?\n<\/new_messages>/);
    assert.doesNotMatch(prompt, /Roster: nobody\./, 'unchanged steady context is not sent again');
    assert.match(prompt, /\(The rest of your context is as in your last message here\.\)/);
    assert.match(prompt, /\(Bot context, not from the person\.\)/, 'per-turn context still goes');
    assert.equal(second.usage.mode, 'resume');

    // A steady context line that changes (1 note -> 2 notes) and later reverts (2 notes -> 1 note)
    // must be re-sent on reversion instead of being suppressed by stale accumulated contextKeys.
    const withHint = (seq, hint) => ({
      ...sessionLane([...later, { id: 'r8', seq: 8, role: 'assistant', text: 'Done.' }, row(seq, 'user', `msg ${seq}`)], [seq], {
        laneId: `lane_${seq}`,
        replyMessageId: `r_${seq}`,
      }),
      session: {
        history: [...later, { id: 'r8', seq: 8, role: 'assistant', text: 'Done.' }, row(seq, 'user', `msg ${seq}`)],
        answering: [seq],
        context: [{ text: '(Bot context, not from the person.)' }, { text: 'Roster: nobody.', steady: true }, { text: hint, steady: true }],
      },
    });
    await runLane(withHint(9, 'Project library (Site): 1 note.'), sessionCtx());
    assert.match(textOf(sdk.runs[2].inputs[0]), /Project library \(Site\): 1 note\./, 'initial library hint is sent');
    await runLane(withHint(10, 'Project library (Site): 2 notes.'), sessionCtx());
    assert.match(textOf(sdk.runs[3].inputs[0]), /Project library \(Site\): 2 notes\./, 'updated library hint is sent');
    await runLane(withHint(11, 'Project library (Site): 1 note.'), sessionCtx());
    assert.match(textOf(sdk.runs[4].inputs[0]), /Project library \(Site\): 1 note\./, 'reverted library hint is re-sent, not suppressed');
  });

  await test('kept session: a new summary (system prompt), a failure or a crash starts over', async () => {
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-b') });
    const sdk = sessionSdk();
    const runLane = sdkRunner(sdk, { sessions });
    const history = [row(1, 'user', 'hi')];
    await runLane(sessionLane(history, [1]), sessionCtx());
    // Compaction ran: the bot's system prompt (its summary) changed.
    const next = [...history, { id: 'msg_1', seq: 2, role: 'assistant', text: 'Done.' }, row(3, 'user', 'again')];
    const reset = await runLane(sessionLane(next, [3], { systemPrompt: 'You are Scout.\n\n## Summary\nThey said hi.' }), sessionCtx());
    assert.equal(sdk.runs[1].options.resume, undefined, 'a new basis starts a new session');
    assert.equal(reset.usage.reason, 'basis');
    assert.match(textOf(sdk.runs[1].inputs[0]), /<conversation_so_far>/, 'seeded with the recent messages');

    // A failed reply drops the session.
    const failing = createFakeSdk(async function* ({ next }) {
      await next();
      yield { ...init(), session_id: 'sess-x' };
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] };
    });
    await sdkRunner(failing, { sessions })(sessionLane(next, [3], { systemPrompt: 'You are Scout.\n\n## Summary\nThey said hi.' }), sessionCtx());
    await runLane(sessionLane(next, [3], { systemPrompt: 'You are Scout.\n\n## Summary\nThey said hi.' }), sessionCtx());
    assert.equal(sdk.runs[2].options.resume, undefined, 'nothing kept after a failure');
    assert.equal(sessionSdkReason(sdk.runs[2]), 'fresh');

    // A crash mid-reply (begin without end) leaves no session behind.
    const crashDir = path.join(testRoot, 'sessions-crash');
    const before = createBotSessionStore({ dir: crashDir });
    await before.begin('bot_1');
    await before.end('bot_1', { sessionId: 's', basis: 'b', seenSeqs: [], seenIds: [], contextKeys: [], contextTokens: 1 });
    const crashed = createBotSessionStore({ dir: crashDir });
    assert.equal((await crashed.begin('bot_1')).state?.sessionId, 's');
    // ...the app dies here; on the next start:
    const restarted = createBotSessionStore({ dir: crashDir });
    assert.equal((await restarted.begin('bot_1')).state, null);
  });

  await test('kept session: a second reply at once gets its own unkept session; a broken resume retries fresh', async () => {
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-c') });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const sdk = createFakeSdk(async function* ({ next, options }) {
      await next();
      yield { ...init(), session_id: options.resume ?? 'sess-c' };
      if (options.persistSession !== false) await gate;
      yield assistant('a1', [{ type: 'text', text: 'ok' }]);
      yield { ...success(), session_id: options.resume ?? 'sess-c', usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const runLane = sdkRunner(sdk, { sessions });
    const history = [row(1, 'user', 'long job'), row(2, 'user', 'quick: 2+2?')];
    const first = runLane(sessionLane(history.slice(0, 1), [1]), sessionCtx());
    await waitFor(() => sdk.runs.length === 1);
    const second = await runLane(sessionLane(history, [2], { laneId: 'lane_2', replyMessageId: 'r2' }), sessionCtx());
    assert.equal(second.text, 'ok');
    assert.equal(sdk.runs[1].options.persistSession, false, 'the parallel reply is not kept');
    assert.equal(second.usage.reason, 'busy');
    assert.match(textOf(sdk.runs[1].inputs[0]), /<conversation_so_far>\nPerson:\nlong job/);
    release();
    await first;

    // The kept session's file disappears (cleared by Claude Code): the resume fails, the reply retries fresh.
    const broken = sessionSdk({ fail: (options) => Boolean(options.resume) });
    const result = await sdkRunner(broken, { sessions })(
      sessionLane([...history.slice(0, 1), { id: 'msg_1', seq: 3, role: 'assistant', text: 'ok' }, row(4, 'user', 'and now?')], [4], { laneId: 'lane_3' }),
      sessionCtx()
    );
    assert.equal(broken.runs.length, 2, 'retried');
    assert.equal(broken.runs[0].options.resume, 'sess-c');
    assert.equal(broken.runs[1].options.resume, undefined);
    assert.equal(result.text, 'Done.');
    assert.equal(result.usage.reason, 'broken');
    assert.match(textOf(broken.runs[1].inputs[0]), /<conversation_so_far>[\s\S]*long job/, 'the fresh one has the conversation');
  });

  await test('a failed attempt that ran a tool is not redone; one that read messages hands them to the fresh one', async () => {
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-retry') });
    // Fresh runs answer each message; a resumed run fails the way the script says.
    let resumed = 'tool';
    const sdk = createFakeSdk(async function* ({ next, options }) {
      await next();
      yield { ...init(), session_id: options.resume ?? 'sess-r' };
      if (options.resume && resumed === 'tool') {
        // It started a task, then the API failed before any text.
        yield assistant('a1', [{ type: 'tool_use', id: 'tu1', name: 'mcp__durango_bot__delegate_task', input: {} }]);
        yield toolResult('tu1');
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] };
        return;
      }
      if (options.resume && resumed === 'inbox') {
        // An empty first turn; the message that came in meanwhile is handed over at its end; then it fails.
        yield { ...success(), session_id: options.resume };
        if (!(await next())) return;
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] };
        return;
      }
      for (let turn = 1; ; turn += 1) {
        yield assistant(`f${turn}`, [{ type: 'text', text: turn === 1 ? 'Done.' : 'And that too.' }]);
        yield { ...success(), session_id: options.resume ?? 'sess-r', usage: { input_tokens: 1, output_tokens: 1 } };
        if (!(await next())) return;
      }
    });
    const runLane = sdkRunner(sdk, { sessions });
    const history = [row(1, 'user', 'start')];
    await runLane(sessionLane(history, [1]), sessionCtx());
    const later = [...history, { id: 'msg_1', seq: 2, role: 'assistant', text: 'Done.' }, row(3, 'user', 'go on')];

    const failed = await runLane(sessionLane(later, [3], { laneId: 'lane_t' }), sessionCtx());
    assert.equal(sdk.runs.length, 2, 'not redone: the task would start twice');
    assert.equal(sdk.runs[1].options.resume, 'sess-r');
    assert.match(failed.failure, /boom/);

    // The failure dropped the kept session: seed it again, then an attempt that only read a message fails.
    await runLane(sessionLane(later, [3], { laneId: 'lane_s' }), sessionCtx());
    resumed = 'inbox';
    const next = [...later, { id: 'msg_1', seq: 4, role: 'assistant', text: 'Done.' }, row(5, 'user', 'and now?')];
    const inbox = [{ seq: 6, source: 'person', label: null, content: 'also: the second thing' }];
    const runs = sdk.runs.length;
    const retried = await runLane(sessionLane(next, [5], { laneId: 'lane_i' }), sessionCtx(inbox));
    assert.equal(sdk.runs.length, runs + 2, 'redone fresh');
    const fresh = sdk.runs[runs + 1];
    assert.equal(fresh.options.resume, undefined);
    assert.match(textOf(fresh.inputs[1]), /also: the second thing/, 'the message the failed attempt read goes to the fresh one');
    assert.ok(textOf(fresh.inputs[1]).startsWith(BOT_FINAL_INBOX_HEADER), 'unposted draft was discarded before rewriting');
    assert.equal(retried.text, 'And that too.');
  });

  await test('a reply whose setup fails leaves its bot\'s kept session free', async () => {
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-setup') });
    const sdk = sessionSdk({ sessionId: 'sess-g' });
    const runLane = sdkRunner(sdk, { sessions });
    const history = [row(1, 'user', 'hi')];
    await runLane(sessionLane(history, [1]), sessionCtx());
    const throwing = { ...sdk, tool: () => { throw new Error('bad tool schema'); } };
    await assert.rejects(
      sdkRunner(throwing, { sessions })(sessionLane(history, [1], { laneId: 'lane_x', tools: [{ name: 'x', description: 'x', inputSchema: { type: 'object' } }] }), sessionCtx()),
      /bad tool schema/
    );
    const after = await runLane(
      sessionLane([...history, { id: 'msg_1', seq: 2, role: 'assistant', text: 'Done.' }, row(3, 'user', 'again')], [3], { laneId: 'lane_y' }),
      sessionCtx()
    );
    assert.equal(after.usage.reason, 'resume', 'not stuck as busy');
  });

  await test('kept session: grows past the reset size → starts over and asks for compaction; inbox items count as seen', async () => {
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-d') });
    const big = sessionSdk({ window: 120_000 });
    const runLane = sdkRunner(big, { sessions, sessionResetTokens: 100_000 });
    const inbox = [{ seq: 2, source: 'person', label: null, content: 'and one more' }];
    const first = await runLane(sessionLane([row(1, 'user', 'research this')], [1]), sessionCtx(inbox));
    assert.equal(first.compact, true, 'a session past the reset size asks for compaction');
    const second = await runLane(
      sessionLane([row(1, 'user', 'research this'), row(2, 'user', 'and one more'), { id: 'msg_1', seq: 3, role: 'assistant', text: 'Done.' }, row(4, 'user', 'next')], [4]),
      sessionCtx()
    );
    assert.equal(big.runs[1].options.resume, undefined, 'too large to resume');
    assert.equal(second.usage.reason, 'size');
    assert.equal(second.compact, true);

    // Inbox items read mid-reply are seen: not repeated on resume.
    const small = sessionSdk({ sessionId: 'sess-e' });
    const sessionsE = createBotSessionStore({ dir: path.join(testRoot, 'sessions-e') });
    const lane = sdkRunner(small, { sessions: sessionsE });
    // The end-of-turn take delivers seq 2 into the session.
    await lane(sessionLane([row(1, 'user', 'a')], [1]), sessionCtx([{ seq: 2, source: 'person', label: null, content: 'b' }]));
    await lane(
      sessionLane([row(1, 'user', 'a'), row(2, 'user', 'b'), { id: 'msg_1', seq: 3, role: 'assistant', text: 'Done.' }, row(4, 'user', 'c')], [4]),
      sessionCtx()
    );
    assert.equal(small.runs[1].options.resume, 'sess-e');
    assert.doesNotMatch(textOf(small.runs[1].inputs[0]), /since_your_last_reply/, 'b was read mid-reply');
  });

  await test('prompt size cap: oversized pastes are cut, the oldest messages left out, the new ones kept', async () => {
    const paste = 'x'.repeat(400_000); // ~100K tokens
    const history = [
      ...Array.from({ length: 40 }, (_, index) => row(index + 1, index % 2 ? 'assistant' : 'user', `${index} ${'y'.repeat(20_000)}`)),
      row(41, 'user', `Here is the log:\n${paste}`),
    ];
    const plan = planBotPrompt({ botName: 'Scout', session: { history, answering: [41], context: [] }, basis: 'b', maxPromptTokens: 60_000 });
    assert.equal(plan.mode, 'fresh');
    assert.ok(plan.estimatedTokens <= 60_000, `within the limit (${plan.estimatedTokens})`);
    assert.ok(estimateTextTokens(plan.prompt) <= 62_000);
    assert.ok(plan.omitted > 0 && plan.omitted % 8 === 0, 'left out in chunks');
    assert.match(plan.prompt, /oldest messages after your summary were left out to fit the context window\. search_history finds them\./);
    assert.match(plan.prompt, /characters omitted to fit the model's context window/, 'the paste was cut with a marker');
    assert.match(plan.prompt, /<new_messages>\nPerson:\nHere is the log:/, 'the new message stays');
    assert.equal(plan.compact, true, 'compaction fell behind');
    assert.match(plan.prompt, /<conversation_so_far>\n\(Automatic note[\s\S]*\nPerson:\n/, 'the kept part starts with an incoming message');

    // Under the limit: unchanged.
    const small = planBotPrompt({ botName: 'Scout', session: { history: history.slice(0, 3), answering: [3], context: [] }, basis: 'b' });
    assert.equal(small.omitted, 0);
    assert.equal(small.shrunk, 0);
    assert.equal(maxPromptTokensFromEnv({ DURANGO_BOT_MAX_PROMPT_TOKENS: '80000' }), 80_000);
    assert.equal(maxPromptTokensFromEnv({ DURANGO_BOT_MAX_PROMPT_TOKENS: '5' }), 150_000);
    assert.match(cutMiddle('a'.repeat(100), 5), /^a+\n\n\[… \d+ characters omitted/);

    // An older Durango's single prompt is cut in the middle to the limit.
    const sdk = sessionSdk();
    await sdkRunner(sdk, { maxPromptTokens: 30_000 })(makeLane({ prompt: `START ${'z'.repeat(400_000)} END` }), sessionCtx());
    const sent = textOf(sdk.runs[0].inputs[0]);
    assert.ok(estimateTextTokens(sent) < 31_000);
    assert.match(sent, /^START/);
    assert.match(sent, /END$/);
  });

  await test('kept session: a resumed session that would pass the limit starts over, trimmed', async () => {
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-f') });
    const sdk = sessionSdk({ window: 50_000 });
    const runLane = sdkRunner(sdk, { sessions, maxPromptTokens: 60_000, sessionMaxTokens: 60_000 });
    await runLane(sessionLane([row(1, 'user', 'hi')], [1]), sessionCtx());
    // While away, the cloud answered a lot.
    const away = Array.from({ length: 10 }, (_, index) => row(10 + index, index % 2 ? 'assistant' : 'user', 'w'.repeat(20_000)));
    const result = await runLane(sessionLane([row(1, 'user', 'hi'), { id: 'msg_1', seq: 2, role: 'assistant', text: 'Done.' }, ...away, row(30, 'user', 'back')], [30]), sessionCtx());
    assert.equal(sdk.runs[1].options.resume, undefined);
    assert.equal(result.usage.reason, 'size');
    assert.ok(estimateTextTokens(textOf(sdk.runs[1].inputs[0])) <= 60_000);
  });

  await test('kept session: a new summary keeps the session and the instructions it started with', async () => {
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-memory') });
    const sdk = sessionSdk();
    const runLane = sdkRunner(sdk, { sessions });
    const withMemory = (summary, job = 'You are Scout.') => `${job}\n\n${memorySection({ summary })}`;
    const history = [row(1, 'user', 'hi')];
    await runLane(sessionLane(history, [1], { systemPrompt: withMemory('They said hello.') }), sessionCtx());
    // Compaction ran: only the summary changed.
    const next = [...history, { id: 'msg_1', seq: 2, role: 'assistant', text: 'Done.' }, row(3, 'user', 'again')];
    const kept = await runLane(sessionLane(next, [3], { systemPrompt: withMemory('They said hi twice.') }), sessionCtx());
    assert.equal(sdk.runs[1].options.resume, 'sess-1', 'resumed across the new summary');
    assert.equal(kept.usage.reason, 'resume');
    assert.match(sdk.runs[1].options.systemPrompt.append, /They said hello\./, 'with the instructions it started with (its cache)');
    assert.doesNotMatch(sdk.runs[1].options.systemPrompt.append, /twice/);
    // ...and the new summary goes in its prompt once (it may cover messages answered elsewhere, then compacted).
    assert.match(textOf(sdk.runs[1].inputs[0]), /^<memory_updated>[\s\S]*They said hi twice\.\n<\/memory_updated>/);
    const next2 = [...next, { id: 'msg_1b', seq: 4, role: 'assistant', text: 'Done.' }, row(5, 'user', 'and again')];
    await runLane(sessionLane(next2, [5], { systemPrompt: withMemory('They said hi twice.'), laneId: 'lane_m3' }), sessionCtx());
    assert.equal(sdk.runs[2].options.resume, 'sess-1');
    assert.doesNotMatch(textOf(sdk.runs[2].inputs[0]), /memory_updated/, 'not again');
    assert.match(sdk.runs[2].options.systemPrompt.append, /They said hello\./, 'still the instructions it started with');
    // The job changed: a new basis, and the fresh session gets the current summary.
    const later = [...next2, { id: 'msg_2', seq: 6, role: 'assistant', text: 'Done.' }, row(7, 'user', 'more')];
    const reset = await runLane(sessionLane(later, [7], { systemPrompt: withMemory('They said hi twice.', 'You are Scout, a chef.'), laneId: 'lane_m4' }), sessionCtx());
    assert.equal(reset.usage.reason, 'basis');
    assert.match(sdk.runs[3].options.systemPrompt.append, /They said hi twice\./);

    const section = memorySection({ summary: 'sum' });
    assert.deepEqual(splitMemorySection(`A\n\n${section}`), { steady: 'A', memory: section });
    assert.deepEqual(splitMemorySection('A only'), { steady: 'A only', memory: '' });
    assert.equal(splitMemorySection(section).steady, '');
    // The heading alone (say, in the bot's job text) is not the memory: a later edit still changes the steady part.
    const job = `Write recaps titled\n${MEMORY_SECTION_HEADING}\n\nthen more job text`;
    assert.equal(splitMemorySection(`${job}\n\n${section}`).steady, job);
    assert.equal(splitMemorySection(job).steady, job);
    // A copy of the section inside the summary: split at the first, the real one.
    assert.equal(splitMemorySection(`A\n\n${memorySection({ summary: `quoted:\n${MEMORY_SECTION_HEADING}\n\n${MEMORY_SECTION_INTRO}` })}`).steady, 'A');

  });

  await test('kept session: kept well past a fresh start size; an expired cache starts over', async () => {
    const session = { history: [row(1, 'user', 'hi'), { id: 'm', seq: 2, role: 'assistant', text: 'ok' }, row(3, 'user', 'next')], answering: [3], context: [] };
    const now = Date.parse('2026-11-20T10:00:00Z');
    const state = { sessionId: 's', basis: 'b', seenSeqs: [1, 2], seenIds: [], contextKeys: [], contextTokens: 120_000, updatedAt: now - 10 * 60_000 };
    const warm = planBotPrompt({ botName: 'Scout', session, state, basis: 'b', now });
    assert.equal(warm.mode, 'resume', 'a 120K session is kept (fresh sessions start at 70-90K)');
    const big = planBotPrompt({ botName: 'Scout', session, state: { ...state, contextTokens: 170_000 }, basis: 'b', now });
    assert.equal(big.reason, 'size');
    const cold = planBotPrompt({ botName: 'Scout', session, state: { ...state, updatedAt: now - 2 * 3_600_000 }, basis: 'b', now });
    assert.deepEqual([cold.mode, cold.reason, cold.keep], ['fresh', 'cold', true]);
    assert.match(cold.prompt, /<conversation_so_far>/);
    const short = planBotPrompt({ botName: 'Scout', session, state, basis: 'b', now, coldAfterMs: 5 * 60_000 });
    assert.equal(short.reason, 'cold', 'a 5-minute cache TTL goes cold sooner');
    assert.notEqual(sessionBasis({ systemPrompt: 'a', model: 'm', tools: [] }), sessionBasis({ systemPrompt: 'b', model: 'm', tools: [] }));
    // The cache TTL the SDK gets decides when a session goes cold.
    assert.equal(botCacheColdMs({}), 55 * 60_000);
    assert.equal(botCacheColdMs({ CLAUDE_CODE_PROMPT_CACHE_TTL: '' }), 55 * 60_000, 'empty = the 1h default');
    assert.equal(botCacheColdMs({ CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }), 4.5 * 60_000);
    assert.equal(botCacheColdMs({ FORCE_PROMPT_CACHING_5M: '1' }), 4.5 * 60_000);
    assert.equal(botClaudeEnv({ CLAUDE_CODE_PROMPT_CACHE_TTL: '' }).CLAUDE_CODE_PROMPT_CACHE_TTL, '1h');
  });

  await test('kept session: one per bot and model, so routine runs on the cheap model do not reset the main one', async () => {
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-g') });
    let count = 0;
    const sdk = createFakeSdk(async function* ({ next, options }) {
      await next();
      const id = options.resume ?? `sess-${(count += 1)}`;
      yield { ...init(options.model), session_id: id };
      yield assistant('a', [{ type: 'text', text: 'ok' }]);
      yield { ...success(), session_id: id, usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const runLane = sdkRunner(sdk, { sessions });
    await runLane(sessionLane([row(1, 'user', 'hi')], [1], { model: 'claude-opus-5-5' }), sessionCtx());
    await runLane(sessionLane([row(1, 'user', 'hi'), row(2, 'user', '[Routine: digest]\ngo')], [2], { model: 'claude-haiku-5-5', laneId: 'l2' }), sessionCtx());
    await runLane(sessionLane([row(1, 'user', 'hi'), row(2, 'user', '[Routine: digest]\ngo'), row(3, 'user', 'thanks')], [3], { model: 'claude-opus-5-5', laneId: 'l3' }), sessionCtx());
    assert.deepEqual(sdk.runs.map((run) => run.options.resume ?? null), [null, null, 'sess-1']);
    assert.match(textOf(sdk.runs[2].inputs[0]), /<since_your_last_reply>[\s\S]*Routine: digest/);
  });

  // Each reply is a new Claude Code process: the claude.ai connectors it had
  // aren't listed for about a second, and a resumed session's first message
  // before then told the model they had disconnected.
  const gmail = (status) => ({ name: 'claude.ai Gmail', status, scope: 'claudeai', config: { type: 'claudeai-proxy' } });
  const railway = (status) => ({ name: 'railway', status, scope: 'user', config: { type: 'stdio', command: 'railway' } });

  await test('connectors: only connected remote servers are recorded; kept lists are cleaned', async () => {
    assert.deepEqual(
      connectedConnectorsOf([
        gmail('connected'),
        { name: 'claude.ai Google Drive', status: 'connected', scope: 'claudeai' },
        { name: 'claude.ai Slack', status: 'needs-auth', scope: 'claudeai' },
        { name: 'linear', status: 'connected', scope: 'user', config: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
        railway('connected'),
        { name: 'durango_bot', status: 'connected', scope: 'dynamic', config: { type: 'sdk' } },
        gmail('connected'),
      ]),
      ['claude.ai Gmail', 'claude.ai Google Drive', 'linear'],
      'claude.ai and http servers, sorted and once each; stdio, SDK and not-connected ones left out'
    );
    assert.deepEqual(connectedConnectorsOf(null), []);
    assert.deepEqual(keptConnectorsOf({ connectors: ['claude.ai Gmail', 7, '', 'claude.ai Gmail'] }), ['claude.ai Gmail']);
    assert.deepEqual(keptConnectorsOf(null), []);
    assert.deepEqual(keptConnectorsOf({ sessionId: 's' }), [], 'a session kept before this has none: no wait');
  });

  await test('connectors: the wait ends once they are listed and connected, or at its limit with what is missing', async () => {
    let clock = 0;
    const timing = { now: () => clock, sleep: async (ms) => void (clock += ms) };
    // Not listed yet (the claude.ai fetch), then connecting, then connected; railway (not waited for) stays pending.
    const timeline = [[railway('pending')], [railway('pending'), gmail('pending')], [railway('pending'), gmail('connected')]];
    let polls = 0;
    const query = { mcpServerStatus: async () => timeline[Math.min(polls++, timeline.length - 1)] };
    const done = await waitForConnectors({ query, names: ['claude.ai Gmail'], timeoutMs: 10_000, pollMs: 150, ...timing });
    assert.deepEqual(done, { waitedMs: 300, missing: [], aborted: false });
    assert.equal(polls, 3);

    clock = 0;
    const never = await waitForConnectors({ query: { mcpServerStatus: async () => [railway('pending')] }, names: ['claude.ai Gmail'], timeoutMs: 1_000, pollMs: 150, ...timing });
    assert.deepEqual(never, { waitedMs: 1_000, missing: ['claude.ai Gmail'], aborted: false }, 'stops at the limit, not past it');

    clock = 0;
    const failed = await waitForConnectors({ query: { mcpServerStatus: async () => [gmail('failed')] }, names: ['claude.ai Gmail'], ...timing });
    assert.deepEqual(failed, { waitedMs: 0, missing: ['claude.ai Gmail'], aborted: false }, 'a failed connector is settled: no wait, reported missing');

    let asked = 0;
    const none = await waitForConnectors({ query: { mcpServerStatus: async () => ((asked += 1), []) }, names: [], ...timing });
    assert.deepEqual(none, { waitedMs: 0, missing: [], aborted: false });
    assert.equal(asked, 0, 'nothing to wait for: not even asked');
    assert.deepEqual(await waitForConnectors({ query: {}, names: ['claude.ai Gmail'], ...timing }), { waitedMs: 0, missing: [], aborted: false }, 'an SDK without mcpServerStatus');
    assert.deepEqual(
      await waitForConnectors({
        query: {
          mcpServerStatus: async () => {
            throw new Error('closed');
          },
        },
        names: ['claude.ai Gmail'],
        ...timing,
      }),
      { waitedMs: 0, missing: [], aborted: false },
      'a failing status call ends the wait'
    );
    const silent = await waitForConnectors({ query: { mcpServerStatus: () => new Promise(() => {}) }, names: ['claude.ai Gmail'], timeoutMs: 50 });
    assert.deepEqual(silent.missing, [], 'a status call that never answers (the process died) ends the wait at the limit');
    assert.ok(silent.waitedMs >= 40 && silent.waitedMs < 1_000);
    const controller = new AbortController();
    controller.abort();
    clock = 0;
    const stopped = await waitForConnectors({ query: { mcpServerStatus: async () => [] }, names: ['claude.ai Gmail'], signal: controller.signal, ...timing });
    assert.deepEqual([stopped.waitedMs, stopped.aborted], [0, true], 'a stopped reply does not wait');
    assert.equal(connectorsStillConnectingNote([]), '');
    assert.equal(connectorsThisReplyNote([]), '');
    assert.equal(connectorsThisReplyNote(null), '');
    assert.match(connectorsThisReplyNote(['claude.ai Gmail', 'claude.ai Google Drive']), /this reply: claude\.ai Gmail, claude\.ai Google Drive\./);
    assert.match(connectorsStillConnectingNote(['claude.ai Gmail']), /not connected yet as this reply starts: claude\.ai Gmail\.[\s\S]*call ToolSearch/);
  });

  await test('kept session: the next reply sends its first message only once the connectors the last one had are up', async () => {
    const sessionsDir = path.join(testRoot, 'sessions-connectors');
    const sessions = createBotSessionStore({ dir: sessionsDir });
    // Per run: how many status polls until Gmail shows up connected (Infinity: never).
    const readyAfter = [0, 3, Infinity];
    const polls = new Map();
    const sdk = createFakeSdk(
      async function* ({ next, options }) {
        await next();
        yield { ...init(), session_id: options.resume ?? 'sess-c' };
        yield assistant('a', [{ type: 'text', text: 'Drafted.' }]);
        yield { ...success(), session_id: options.resume ?? 'sess-c', usage: { input_tokens: 1, output_tokens: 1 } };
      },
      {
        mcpServerStatus: (run) => {
          if (!polls.has(run)) polls.set(run, { index: sdk.runs.indexOf(run), count: 0, beforeFirstInput: 0 });
          const entry = polls.get(run);
          entry.count += 1;
          if (!run.inputs.length) entry.beforeFirstInput += 1;
          const ready = entry.count > readyAfter[entry.index];
          return [railway('pending'), ...(ready ? [gmail('connected')] : entry.count > 1 ? [gmail('pending')] : [])];
        },
      }
    );
    const pollsOf = (index) => polls.get(sdk.runs[index]);
    const logs = [];
    const runLane = sdkRunner(sdk, { sessions, connectorWaitMs: 400, log: (...args) => logs.push(args.join(' ')) });
    const history = [row(1, 'user', 'Draft a reply to Brett.')];

    await runLane(sessionLane(history, [1], { replyMessageId: 'r2' }), sessionCtx());
    const kept = JSON.parse(await fs.readFile(path.join(sessionsDir, 'bot_1__claude-opus-5-5.json'), 'utf8'));
    assert.deepEqual(kept.connectors, ['claude.ai Gmail'], 'the connectors it answered with are kept with the session');
    assert.equal(pollsOf(0).beforeFirstInput, 1, 'a new bot has no connectors to wait for (one read for the connected-now line)');
    assert.match(textOf(sdk.runs[0].inputs[0]), /Connectors connected in Claude Code on this machine for this reply: claude\.ai Gmail\./, 'the first message names the connectors it has');
    assert.match(sdk.runs[0].options.systemPrompt.append, /## Connectors\n\nThe connectors loaded in Claude Code here [\s\S]*never in a cloud task[\s\S]*sha256:<64 lowercase hex>:<absolute path>[\s\S]*Each of your replies starts Claude Code again/);
    assert.ok(sdk.runs[0].options.systemPrompt.append.endsWith(BOT_CONNECTORS_NOTE));

    const later = [...history, { id: 'r2', seq: 2, role: 'assistant', text: 'Drafted.' }, row(3, 'user', 'Now send it.')];
    await runLane(sessionLane(later, [3], { laneId: 'lane_2', replyMessageId: 'r4' }), sessionCtx());
    assert.equal(sdk.runs[1].options.resume, 'sess-c', 'resumed');
    assert.equal(pollsOf(1).beforeFirstInput, 5, 'asked until Gmail was listed and connected, before the first message (and once for the connected-now line)');
    assert.doesNotMatch(textOf(sdk.runs[1].inputs[0]), /not connected yet/, 'all up: no note');
    assert.match(textOf(sdk.runs[1].inputs[0]), /\(Connectors connected in Claude Code on this machine for this reply: claude\.ai Gmail\. Use them directly here/, 'the first message names the connectors it has');
    assert.ok(logs.some((line) => /bot bot_1 waited \d+ms for connectors$/.test(line)));

    // Gmail never comes up within the limit: the reply goes on, telling the model it is still connecting.
    const third = [...later, { id: 'r4', seq: 4, role: 'assistant', text: 'Drafted.' }, row(5, 'user', 'And to Ana.')];
    const started = Date.now();
    const result = await runLane(sessionLane(third, [5], { laneId: 'lane_3', replyMessageId: 'r6' }), sessionCtx());
    assert.ok(Date.now() - started < 3_000, 'bounded by connectorWaitMs');
    assert.equal(result.text, 'Drafted.');
    assert.match(textOf(sdk.runs[2].inputs[0]), /<new_messages>[\s\S]*And to Ana\.[\s\S]*Connectors not connected yet as this reply starts: claude\.ai Gmail\./);
    assert.doesNotMatch(textOf(sdk.runs[2].inputs[0]), /Connectors connected in Claude Code/, 'Gmail down: not listed as connected');
    assert.ok(logs.some((line) => /not connected: claude\.ai Gmail/.test(line)));
    const keptAfter = JSON.parse(await fs.readFile(path.join(sessionsDir, 'bot_1__claude-opus-5-5.json'), 'utf8'));
    assert.deepEqual(keptAfter.connectors, [], 'a connector still down at the end is not waited for next time');
  });

  await test('kept session: a session kept before connectors were recorded starts over once with the connectors note', async () => {
    const sessionsDir = path.join(testRoot, 'sessions-connectors-old');
    await fs.mkdir(sessionsDir, { recursive: true });
    const sdk = sessionSdk({ sessionId: 'sess-new' });
    const lane = sessionLane([row(1, 'user', 'hi')], [1]);
    // What an older Durango kept: the basis without the connectors note.
    const { steady } = splitMemorySection(lane.systemPrompt);
    const oldBasis = sessionBasis({ systemPrompt: steady, model: lane.model, tools: lane.tools });
    await fs.writeFile(
      path.join(sessionsDir, 'bot_1__claude-opus-5-5.json'),
      JSON.stringify({ version: 1, sessionId: 'sess-old', basis: oldBasis, systemAppend: lane.systemPrompt, updatedAt: Date.now() })
    );
    const result = await sdkRunner(sdk, { sessions: createBotSessionStore({ dir: sessionsDir }) })(lane, sessionCtx());
    assert.equal(sdk.runs[0].options.resume, undefined, 'not resumed');
    assert.equal(result.usage.reason, 'basis');
    assert.ok(sdk.runs[0].options.systemPrompt.append.includes(BOT_CONNECTORS_NOTE));
  });

  // --- warm processes: a bot's next reply within two minutes goes into the running process ---
  const fakeTimers = () => {
    const timers = [];
    return {
      timers,
      setTimer: (fn, ms) => {
        const timer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        if (timer) timer.cleared = true;
      },
      fire: () => {
        for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn();
      },
    };
  };
  /** A fake SDK whose every process answers each message it gets with "Reply <n>." (n counts per process). */
  const warmSdk = ({ sessionId = 'sess-w', onTurn = null, mcpServerStatus = null } = {}) =>
    createFakeSdk(
      async function* ({ next, options, tools }) {
        let input = await next();
        yield { ...init(options.model), session_id: options.resume ?? sessionId };
        for (let turn = 1; input; turn += 1) {
          const outcome = onTurn ? await onTurn({ turn, input, options, tools }) : null;
          if (outcome === 'die') return;
          const text = `Reply ${turn}.`;
          yield assistant(`a${turn}`, [{ type: 'text', text }]);
          yield { ...success(), session_id: options.resume ?? sessionId, usage: { input_tokens: 1, output_tokens: 1 } };
          input = await next();
        }
      },
      mcpServerStatus ? { mcpServerStatus } : {}
    );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  await test('warm processes: park, take, idle close, mismatch, ended while idle, forget and close all', async () => {
    const clock = fakeTimers();
    const closed = [];
    const logs = [];
    const fakeProc = (name, { sessionId = 's1', optionsKey = 'k1', next = () => new Promise(() => {}) } = {}) => ({
      name,
      sessionId,
      optionsKey,
      iterator: { next },
      close: () => closed.push(name),
    });
    const pool = createWarmClaudeProcesses({ ...clock, log: (line) => logs.push(line) });
    const a = fakeProc('a');
    pool.park('bot_1__m', a);
    assert.equal(pool.size, 1);
    assert.equal(clock.timers[0].ms, BOT_WARM_PROCESS_MS);
    assert.equal(BOT_WARM_PROCESS_MS, 120_000, 'two minutes');
    assert.equal(pool.take('bot_1__m', { sessionId: 's1', optionsKey: 'k1' }), a, 'same session and settings: reused');
    assert.ok(a.pending instanceof Promise, 'read ahead while parked');
    assert.equal(pool.size, 0, 'taken: one reply at a time');
    assert.equal(clock.timers[0].cleared, true);
    assert.equal(pool.take('bot_1__m', { sessionId: 's1', optionsKey: 'k1' }), null);

    pool.park('bot_1__m', fakeProc('b'));
    clock.fire();
    assert.deepEqual(closed, ['b'], 'nothing new for two minutes: closed');
    assert.equal(pool.size, 0);

    pool.park('bot_1__m', fakeProc('c', { optionsKey: 'k1' }));
    assert.equal(pool.take('bot_1__m', { sessionId: 's1', optionsKey: 'k2' }), null, 'other settings: not reused');
    pool.park('bot_1__m', fakeProc('d', { sessionId: 's1' }));
    assert.equal(pool.take('bot_1__m', { sessionId: 's2', optionsKey: 'k1' }), null, 'another session: not reused');
    assert.deepEqual(closed, ['b', 'c', 'd'], 'a process that cannot be reused is closed');

    pool.park('bot_1__m', fakeProc('e'));
    pool.park('bot_1__m', fakeProc('f'));
    assert.deepEqual(closed.slice(-1), ['e'], 'a newer process replaces the parked one');

    let end;
    pool.park('bot_2__m', fakeProc('g', { next: () => new Promise((resolve) => (end = resolve)) }));
    end({ done: true });
    await settle();
    assert.deepEqual(closed.slice(-1), ['g'], 'a process that ends (crashes) while parked is closed and dropped');
    assert.equal(pool.size, 1);
    pool.park('bot_2__m', fakeProc('h', { next: () => Promise.reject(new Error('exited')) }));
    await settle();
    assert.deepEqual(closed.slice(-1), ['h'], 'one whose read fails too');
    pool.park('bot_2__m', fakeProc('i', { next: async () => ({ done: false, value: { type: 'system', subtype: 'task_notification' } }) }));
    await settle();
    assert.deepEqual(closed.slice(-1), ['i'], 'one that starts something by itself is not reused');

    pool.park('bot_10__m', fakeProc('j'));
    pool.park('bot_2__m', fakeProc('k'));
    pool.forgetBot('bot_1');
    assert.deepEqual(closed.slice(-1), ['f'], "forgetBot closes that bot's processes only (not bot_10)");
    pool.closeAll();
    assert.deepEqual(closed.slice(-2).sort(), ['j', 'k'], 'closeAll (the app quits) closes the rest');
    assert.equal(pool.size, 0);
    assert.ok(logs.some((line) => /closed the warm Claude Code process of bot_1__m \(idle\)/.test(line)));
  });

  await test('warm processes: the next reply goes into the running process, with its own tools, and no connector wait', async () => {
    const clock = fakeTimers();
    const warmProcesses = createWarmClaudeProcesses(clock);
    let statusCalls = 0;
    const sdk = warmSdk({
      mcpServerStatus: () => ((statusCalls += 1), [gmail('connected')]),
      onTurn: async ({ turn, tools }) => {
        if (turn === 2) await tools.web_search.handler({ q: 'second' });
      },
    });
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-warm-a') });
    const logs = [];
    const runLane = sdkRunner(sdk, { sessions, warmProcesses, log: (...args) => logs.push(args.join(' ')) });
    const tools = [{ name: 'web_search', description: 'Search the web', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }];
    const ctxWith = (calls) => ({ ...sessionCtx(), callTool: async (input) => (calls.push(input), { result: { ok: true } }) });
    const history = [row(1, 'user', 'Find a cafe.')];
    const firstCalls = [];
    const first = await runLane(sessionLane(history, [1], { tools, replyMessageId: 'r2' }), ctxWith(firstCalls));
    assert.equal(first.text, 'Reply 1.');
    assert.equal(sdk.runs.length, 1);
    assert.equal(sdk.runs[0].closed, false, 'left running');
    assert.equal(warmProcesses.size, 1);

    const later = [...history, { id: 'r2', seq: 2, role: 'assistant', text: 'Reply 1.' }, row(3, 'user', 'One near the station.')];
    const statusBefore = statusCalls;
    const secondCalls = [];
    const second = await runLane(sessionLane(later, [3], { tools, laneId: 'lane_2', replyMessageId: 'r4' }), ctxWith(secondCalls));
    assert.equal(sdk.runs.length, 1, 'no new process');
    assert.equal(second.text, 'Reply 2.', 'answered by the same process, its second turn');
    assert.equal(second.usage.mode, 'resume');
    const prompt = textOf(sdk.runs[0].inputs[1]);
    assert.match(prompt, /<new_messages>\nPerson:\nOne near the station\.\n<\/new_messages>/);
    assert.doesNotMatch(prompt, /conversation_so_far|Find a cafe/, 'only what is new, like a resumed session');
    assert.equal(statusCalls - statusBefore, 1, 'no connector wait: one read, for its first message (and what it records)');
    assert.match(prompt, /Connectors connected in Claude Code on this machine for this reply: claude\.ai Gmail\./);
    assert.deepEqual(firstCalls, []);
    assert.equal(secondCalls.length, 1, "the first process's tool calls this reply's handler");
    assert.deepEqual(secondCalls[0].input, { q: 'second' });
    assert.ok(logs.some((line) => /reply goes into its warm Claude Code process/.test(line)));
    assert.equal(warmProcesses.size, 1, 'parked again for the next one');

    // Two minutes with nothing new: closed. The next reply resumes the kept session in a new process.
    clock.fire();
    assert.equal(sdk.runs[0].closed, true);
    assert.equal(warmProcesses.size, 0, 'an idle bot holds no process');
    const third = [...later, { id: 'r4', seq: 4, role: 'assistant', text: 'Reply 2.' }, row(5, 'user', 'Thanks.')];
    const cold = await runLane(sessionLane(third, [5], { tools, laneId: 'lane_3', replyMessageId: 'r6' }), ctxWith([]));
    assert.equal(sdk.runs.length, 2);
    assert.equal(sdk.runs[1].options.resume, 'sess-w', 'a cold start resumes the kept session');
    assert.equal(cold.text, 'Reply 1.');
    warmProcesses.closeAll();
  });

  await test('warm processes: other settings (access mode, effort, model, tools) start a new process', async () => {
    const warmProcesses = createWarmClaudeProcesses(fakeTimers());
    const sdk = warmSdk();
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-warm-b') });
    const runLane = sdkRunner(sdk, { sessions, warmProcesses });
    let seq = 1;
    let history = [row(seq, 'user', 'hi')];
    const reply = async (overrides = {}, ctx = sessionCtx()) => {
      const result = await runLane(sessionLane(history, [seq], { laneId: `l${seq}`, replyMessageId: `r${seq + 1}`, ...overrides }), ctx);
      history = [...history, { id: `r${seq + 1}`, seq: seq + 1, role: 'assistant', text: result.text }, row(seq + 2, 'user', `msg ${seq + 2}`)];
      seq += 2;
      return result;
    };
    await reply();
    await reply();
    assert.equal(sdk.runs.length, 1, 'same settings: reused');
    await reply({}, { ...sessionCtx(), accessMode: 'full-access' });
    assert.equal(sdk.runs.length, 2, 'another access mode: a new process');
    assert.equal(sdk.runs[0].closed, true, 'the old one is closed');
    assert.equal(sdk.runs[1].options.resume, 'sess-w', 'resuming the same session');
    await reply({}, { ...sessionCtx(), accessMode: 'full-access' });
    assert.equal(sdk.runs.length, 2);
    await reply({ reasoningEffort: 'high' }, { ...sessionCtx(), accessMode: 'full-access' });
    assert.equal(sdk.runs.length, 3, 'another effort: a new process');
    assert.equal(sdk.runs[2].options.effort, 'high');
    await reply({ reasoningEffort: 'high', tools: [{ name: 'web_search', description: 'Search', inputSchema: { type: 'object' } }] }, { ...sessionCtx(), accessMode: 'full-access' });
    assert.equal(sdk.runs.length, 4, 'other tools: a new process (its bot tool server is made at start)');
    assert.equal(sdk.runs[3].options.resume, undefined, 'other tools are another session basis: fresh');
    await reply({ model: 'claude-haiku-5-5', reasoningEffort: 'high' }, { ...sessionCtx(), accessMode: 'full-access' });
    assert.equal(sdk.runs.length, 5, 'another model is another kept session, and its own process');
    assert.equal(warmProcesses.size, 2, 'one per bot and model');
    warmProcesses.closeAll();
    assert.ok(sdk.runs.every((run) => run.closed));
  });

  await test('warm processes: a reply while another holds the session gets its own process, closed after it', async () => {
    const warmProcesses = createWarmClaudeProcesses(fakeTimers());
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const sdk = warmSdk({
      onTurn: async ({ input }) => {
        if (/<new_messages>\nPerson:\nthe slow one/.test(textOf(input))) await gate;
      },
    });
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-warm-c') });
    const runLane = sdkRunner(sdk, { sessions, warmProcesses });
    const slow = runLane(sessionLane([row(1, 'user', 'the slow one')], [1], { laneId: 'l1' }), sessionCtx());
    await waitFor(() => sdk.runs.length === 1, { label: 'first process' });
    const quick = await runLane(sessionLane([row(1, 'user', 'the slow one'), row(2, 'user', 'and a quick one')], [2], { laneId: 'l2' }), sessionCtx());
    assert.equal(quick.text, 'Reply 1.');
    assert.equal(sdk.runs.length, 2);
    assert.equal(sdk.runs[1].options.persistSession, false, 'the second gets an unkept session');
    assert.equal(sdk.runs[1].closed, true, 'and its process is not kept');
    assert.equal(warmProcesses.size, 0);
    release();
    await slow;
    assert.equal(sdk.runs[0].closed, false);
    assert.equal(warmProcesses.size, 1, "the session's own reply parks its process");
    warmProcesses.closeAll();
  });

  await test('warm processes: crashed while parked → a cold resume; dies on the next message → retried cold, same session', async () => {
    const warmProcesses = createWarmClaudeProcesses(fakeTimers());
    let dieAfterFirst = true;
    let dieOnSecond = false;
    const sdk = createFakeSdk(async function* ({ next, options }) {
      let input = await next();
      yield { ...init(), session_id: options.resume ?? 'sess-x' };
      for (let turn = 1; input; turn += 1) {
        if (turn === 2 && dieOnSecond) return;
        yield assistant(`a${turn}`, [{ type: 'text', text: `Reply ${turn}.` }]);
        yield { ...success(), session_id: options.resume ?? 'sess-x', usage: { input_tokens: 1, output_tokens: 1 } };
        if (dieAfterFirst) return;
        input = await next();
      }
    });
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-warm-d') });
    const logs = [];
    const runLane = sdkRunner(sdk, { sessions, warmProcesses, log: (...args) => logs.push(args.join(' ')) });
    let history = [row(1, 'user', 'hi')];
    await runLane(sessionLane(history, [1], { laneId: 'l1', replyMessageId: 'r2' }), sessionCtx());
    await settle();
    assert.equal(warmProcesses.size, 0, 'the process ended while parked: dropped');
    assert.equal(sdk.runs[0].closed, true);

    dieAfterFirst = false;
    history = [...history, { id: 'r2', seq: 2, role: 'assistant', text: 'Reply 1.' }, row(3, 'user', 'again')];
    const cold = await runLane(sessionLane(history, [3], { laneId: 'l3', replyMessageId: 'r4' }), sessionCtx());
    assert.equal(sdk.runs.length, 2);
    assert.equal(sdk.runs[1].options.resume, 'sess-x');
    assert.equal(cold.text, 'Reply 1.');
    assert.equal(warmProcesses.size, 1);

    dieOnSecond = true;
    history = [...history, { id: 'r4', seq: 4, role: 'assistant', text: 'Reply 1.' }, row(5, 'user', 'once more')];
    const retried = await runLane(sessionLane(history, [5], { laneId: 'l5', replyMessageId: 'r6' }), sessionCtx());
    assert.equal(sdk.runs.length, 3, 'the warm process died on the message: a new one');
    assert.equal(sdk.runs[2].options.resume, 'sess-x', 'the same session, not a fresh one');
    assert.match(textOf(sdk.runs[2].inputs[0]), /once more/);
    assert.equal(retried.text, 'Reply 1.');
    assert.equal(retried.usage.mode, 'resume');
    assert.equal(sdk.runs[1].closed, true);
    assert.ok(logs.some((line) => /warm Claude Code process failed, resuming in a new one/.test(line)));
    warmProcesses.closeAll();
  });

  await test('warm processes: a reply stopped midway closes its process instead of parking it', async () => {
    const warmProcesses = createWarmClaudeProcesses(fakeTimers());
    const controller = new AbortController();
    const sdk = warmSdk({
      onTurn: async ({ turn, options }) => {
        if (turn === 2) {
          // Stopped mid-turn: the reply closes its process, which aborts the query.
          controller.abort();
          if (options.abortController.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
      },
    });
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-warm-e') });
    const runLane = sdkRunner(sdk, { sessions, warmProcesses });
    await runLane(sessionLane([row(1, 'user', 'hi')], [1], { laneId: 'l1', replyMessageId: 'r2' }), sessionCtx());
    assert.equal(warmProcesses.size, 1);
    const history = [row(1, 'user', 'hi'), { id: 'r2', seq: 2, role: 'assistant', text: 'Reply 1.' }, row(3, 'user', 'stop me')];
    const stopped = await runLane(sessionLane(history, [3], { laneId: 'l3' }), { ...sessionCtx(), signal: controller.signal });
    assert.equal(sdk.runs.length, 1, 'it ran in the warm process');
    assert.equal(stopped.aborted, true);
    assert.equal(sdk.runs[0].closed, true, 'closed');
    assert.equal(warmProcesses.size, 0);
  });

  await test('warm processes: without a pool every reply starts and closes its own process', async () => {
    const sdk = warmSdk();
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-warm-f') });
    const runLane = sdkRunner(sdk, { sessions });
    await runLane(sessionLane([row(1, 'user', 'hi')], [1], { laneId: 'l1', replyMessageId: 'r2' }), sessionCtx());
    await runLane(sessionLane([row(1, 'user', 'hi'), { id: 'r2', seq: 2, role: 'assistant', text: 'Reply 1.' }, row(3, 'user', 'again')], [3], { laneId: 'l3' }), sessionCtx());
    assert.equal(sdk.runs.length, 2);
    assert.ok(sdk.runs.every((run) => run.closed));
  });

  // --- review fixes: real-latency connector waits, stops, warm crashes, rebinding, races, settings ---
  const later = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

  await test('connectors: with real latency a timed-out wait still names what is missing', async () => {
    // Every read takes 5 ms (stdio IPC), Gmail never connects.
    const slow = { mcpServerStatus: () => later(5, [railway('pending'), gmail('pending')]) };
    const timedOut = await waitForConnectors({ query: slow, names: ['claude.ai Gmail'], timeoutMs: 300, pollMs: 100 });
    assert.deepEqual(timedOut.missing, ['claude.ai Gmail'], 'the read at the limit is not cut off by its own latency');
    assert.equal(timedOut.aborted, false);
    assert.ok(timedOut.waitedMs >= 300 && timedOut.waitedMs < 600, `bounded (${timedOut.waitedMs}ms)`);
    // Answers once, then stops answering (the process died): what the last answer said.
    let reads = 0;
    const dying = { mcpServerStatus: () => (reads++ === 0 ? later(5, [gmail('pending')]) : new Promise(() => {})) };
    const died = await waitForConnectors({ query: dying, names: ['claude.ai Gmail'], timeoutMs: 300, pollMs: 50 });
    assert.deepEqual(died.missing, ['claude.ai Gmail']);
    assert.ok(died.waitedMs < 600);
  });

  await test('connectors: a stop ends the wait at once, during a sleep or a read that hangs', async () => {
    const pendingGmail = { mcpServerStatus: () => later(1, [gmail('pending')]) };
    const duringSleep = new AbortController();
    setTimeout(() => duringSleep.abort(), 40);
    let started = Date.now();
    const slept = await waitForConnectors({ query: pendingGmail, names: ['claude.ai Gmail'], timeoutMs: 5_000, pollMs: 1_000, signal: duringSleep.signal });
    assert.equal(slept.aborted, true);
    assert.ok(Date.now() - started < 500, 'not the 1 s poll, not the 5 s limit');
    const duringRead = new AbortController();
    setTimeout(() => duringRead.abort(), 40);
    started = Date.now();
    const hung = await waitForConnectors({ query: { mcpServerStatus: () => new Promise(() => {}) }, names: ['claude.ai Gmail'], timeoutMs: 5_000, signal: duringRead.signal });
    assert.equal(hung.aborted, true);
    assert.ok(Date.now() - started < 500);
    let asked = 0;
    const before = new AbortController();
    before.abort();
    const never = await waitForConnectors({ query: { mcpServerStatus: async () => ((asked += 1), []) }, names: ['claude.ai Gmail'], signal: before.signal });
    assert.deepEqual([never.aborted, asked], [true, 0], 'stopped before it began: not even asked');
  });

  await test('kept session: a reply stopped while the session is taken starts no process and sends nothing', async () => {
    const store = createBotSessionStore({ dir: path.join(testRoot, 'sessions-stop-a') });
    const sdk = warmSdk();
    const controller = new AbortController();
    const sessions = {
      ...store,
      begin: async (key) => {
        const claimed = await store.begin(key);
        controller.abort();
        return claimed;
      },
    };
    const warmProcesses = createWarmClaudeProcesses(fakeTimers());
    const result = await sdkRunner(sdk, { sessions, warmProcesses })(sessionLane([row(1, 'user', 'hi')], [1]), { ...sessionCtx(), signal: controller.signal });
    assert.equal(result.aborted, true);
    assert.equal(sdk.runs.length, 0, 'no process started');
    assert.equal(warmProcesses.size, 0);
  });

  await test('kept session: a reply stopped during the connector wait ends it at once and never sends its prompt', async () => {
    const sessionsDir = path.join(testRoot, 'sessions-stop-b');
    const sessions = createBotSessionStore({ dir: sessionsDir });
    let gmailUp = true;
    const sdk = warmSdk({ mcpServerStatus: () => later(1, gmailUp ? [gmail('connected')] : [railway('pending')]) });
    const runLane = sdkRunner(sdk, { sessions, connectorWaitMs: 5_000 });
    await runLane(sessionLane([row(1, 'user', 'hi')], [1], { replyMessageId: 'r2' }), sessionCtx());
    gmailUp = false;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const started = Date.now();
    const history = [row(1, 'user', 'hi'), { id: 'r2', seq: 2, role: 'assistant', text: 'Reply 1.' }, row(3, 'user', 'again')];
    const result = await runLane(sessionLane(history, [3], { laneId: 'l3' }), { ...sessionCtx(), signal: controller.signal });
    assert.equal(result.aborted, true);
    assert.ok(Date.now() - started < 1_000, `not the 5 s limit (${Date.now() - started}ms)`);
    assert.equal(sdk.runs[1].inputs.length, 0, 'the prompt never went out');
    assert.equal(sdk.runs[1].closed, true);
  });

  await test('warm processes: a warm process that dies after a message and a tool is not redone anywhere, and keeps its model', async () => {
    const warmProcesses = createWarmClaudeProcesses(fakeTimers());
    // Turn 2 sends an acknowledgement and calls a tool, then the process dies.
    const crashing = createFakeSdk(async function* ({ next, options, tools }) {
      let input = await next();
      yield { ...init('claude-opus-5-5'), session_id: options.resume ?? 'sess-m' };
      for (let turn = 1; input; turn += 1) {
        if (turn === 2) {
          // As Claude Code does: PreToolUse, the step, then the call.
          await options.hooks.PreToolUse[0].hooks[0]({ tool_name: 'mcp__durango_bot__web_search', tool_use_id: 'tu-1' });
          yield assistant('a2', [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'tu-1', name: 'mcp__durango_bot__web_search', input: { q: 'x' } }]);
          await tools.web_search.handler({ q: 'x' });
          throw new Error('Claude Code process exited with code 1');
        }
        yield assistant(`a${turn}`, [{ type: 'text', text: `Reply ${turn}.` }]);
        yield { ...success(), session_id: options.resume ?? 'sess-m', usage: { input_tokens: 1, output_tokens: 1 } };
        input = await next();
      }
    });
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-warm-crash') });
    const runLane = sdkRunner(crashing, { sessions, warmProcesses });
    const tools = [{ name: 'web_search', description: 'Search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }];
    const sent = [];
    const calls = [];
    const ctx = () => ({
      ...sessionCtx(),
      callTool: async (input) => (calls.push(input), { result: { ok: true } }),
      sendMessage: async (message) => (sent.push(message), true),
    });
    // No model on the lane: the one Claude Code reports (init) is the reply's.
    const first = await runLane(sessionLane([row(1, 'user', 'hi')], [1], { model: null, tools, replyMessageId: 'r2' }), ctx());
    assert.equal(first.modelId, 'anthropic/claude-opus-5.5');
    assert.equal(warmProcesses.size, 1);
    const history = [row(1, 'user', 'hi'), { id: 'r2', seq: 2, role: 'assistant', text: 'Reply 1.' }, row(3, 'user', 'search it')];
    const second = await runLane(sessionLane(history, [3], { model: null, tools, laneId: 'l3' }), ctx());
    assert.equal(crashing.runs.length, 1, 'not retried here: it already did things');
    assert.equal(calls.length, 1, 'the tool ran once');
    assert.deepEqual(sent.map((message) => message.text), ['On it.']);
    assert.equal(second.retryElsewhere, false, 'not handed to another machine to do again');
    assert.match(second.failure, /exited with code 1/);
    assert.equal(second.modelId, 'anthropic/claude-opus-5.5', 'the warm turn keeps the model its process reported');
    assert.equal(sent[0].modelId, 'anthropic/claude-opus-5.5');
    assert.equal(warmProcesses.size, 0, 'a crashed process is not parked');
  });

  await test("warm processes: hooks and stderr call the reply the process runs now, and a subagent's calls aren't the reply's", async () => {
    const warmProcesses = createWarmClaudeProcesses(fakeTimers());
    let hookOutput = null;
    const sdk = createFakeSdk(async function* ({ next, options, tools }) {
      let input = await next();
      yield { ...init(), session_id: options.resume ?? 'sess-h' };
      const pre = options.hooks.PreToolUse[0].hooks[0];
      const post = options.hooks.PostToolUse[0].hooks[0];
      for (let turn = 1; input; turn += 1) {
        if (turn === 2) {
          // A subagent's call first: it must not take the main loop's tool_use id.
          await pre({ tool_name: 'mcp__durango_bot__web_search', tool_use_id: 'sub-1', agent_id: 'agent-1' });
          await pre({ tool_name: 'mcp__durango_bot__web_search', tool_use_id: 'tu-main' });
          yield assistant('a2t', [{ type: 'tool_use', id: 'tu-main', name: 'mcp__durango_bot__web_search', input: { q: 'y' } }]);
          await tools.web_search.handler({ q: 'y' });
          await post({ tool_name: 'mcp__durango_bot__web_search', tool_use_id: 'tu-main' });
          await settle();
          hookOutput = await post({ tool_name: 'mcp__durango_bot__web_search', tool_use_id: 'tu-main' });
          yield toolResult('tu-main');
        }
        if (turn === 3) {
          options.stderr('Error: not logged in · Please run /login');
          yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], session_id: 'sess-h' };
          input = await next();
          continue;
        }
        yield assistant(`a${turn}`, [{ type: 'text', text: `Reply ${turn}.` }]);
        yield { ...success(), session_id: options.resume ?? 'sess-h', usage: { input_tokens: 1, output_tokens: 1 } };
        input = await next();
      }
    });
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-warm-hooks') });
    const runLane = sdkRunner(sdk, { sessions, warmProcesses });
    const tools = [{ name: 'web_search', description: 'Search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }];
    const callsOf = [[], [], []];
    const ctxFor = (index, inbox = []) => ({
      ...sessionCtx(inbox),
      callTool: async (input) => (callsOf[index].push(input), { result: { ok: true } }),
    });
    let history = [row(1, 'user', 'hi')];
    await runLane(sessionLane(history, [1], { tools, replyMessageId: 'r2' }), ctxFor(0));
    history = [...history, { id: 'r2', seq: 2, role: 'assistant', text: 'Reply 1.' }, row(3, 'user', 'search y')];
    const second = await runLane(sessionLane(history, [3], { tools, laneId: 'l3', replyMessageId: 'r4' }), ctxFor(1, [{ seq: 4, source: 'person', label: null, content: 'and lunch?' }]));
    assert.equal(sdk.runs.length, 1, 'warm');
    assert.deepEqual(callsOf[0], [], "the first reply's handlers are not called");
    assert.equal(callsOf[1].length, 1);
    assert.equal(callsOf[1][0].toolCallId, 'tu-main', "PreToolUse recorded this reply's call; the subagent's id was not taken");
    assert.match(JSON.stringify(hookOutput), /and lunch\?/, "PostToolUse delivered this reply's inbox");
    assert.equal(second.text, 'Reply 2.');
    // Turn 3: stderr goes to the third reply (a sign-in problem: handed elsewhere, not retried here).
    history = [...history, { id: 'r4', seq: 4, role: 'assistant', text: 'Reply 2.' }, row(5, 'user', 'more')];
    const third = await runLane(sessionLane(history, [5], { tools, laneId: 'l5' }), ctxFor(2));
    assert.equal(sdk.runs.length, 1, 'stderr reached this reply: a sign-in failure is not retried in a new process');
    assert.equal(third.retryElsewhere, true);
    warmProcesses.closeAll();
  });

  await test('warm processes: a bot forgotten or all processes closed during a reply → its process is not parked', async () => {
    for (const how of ['forgetBot', 'closeAll']) {
      const warmProcesses = createWarmClaudeProcesses(fakeTimers());
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      const sdk = warmSdk({ onTurn: async () => gate });
      const sessions = createBotSessionStore({ dir: path.join(testRoot, `sessions-warm-race-${how}`) });
      const reply = sdkRunner(sdk, { sessions, warmProcesses })(sessionLane([row(1, 'user', 'hi')], [1]), sessionCtx());
      await waitFor(() => sdk.runs.length === 1, { label: 'started' });
      if (how === 'forgetBot') warmProcesses.forgetBot('bot_1');
      else warmProcesses.closeAll();
      release();
      const result = await reply;
      assert.equal(result.text, 'Reply 1.', 'the reply itself still finishes');
      assert.equal(warmProcesses.size, 0, `${how} during the reply: not parked`);
      assert.equal(sdk.runs[0].closed, true);
    }
  });

  await test('warm processes: projects, environment, Claude Code binary and reply files are part of the settings', async () => {
    const warmProcesses = createWarmClaudeProcesses(fakeTimers());
    const sdk = warmSdk();
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-warm-key') });
    let projectPath = path.join(testRoot, 'project-a');
    await fs.mkdir(path.join(testRoot, 'project-a'), { recursive: true });
    await fs.mkdir(path.join(testRoot, 'project-b'), { recursive: true });
    let envValue = '1';
    let binaryPath = '/opt/claude';
    const runLane = sdkRunner(sdk, {
      sessions,
      warmProcesses,
      getProjects: () => [{ id: 'p1', name: 'Site', path: projectPath }],
      env: () => ({ TEST_ENV: envValue }),
      resolveBinary: async () => binaryPath,
    });
    let seq = 1;
    let history = [row(seq, 'user', 'hi')];
    const reply = async (overrides = {}) => {
      const result = await runLane(sessionLane(history, [seq], { laneId: `k${seq}`, replyMessageId: `kr${seq + 1}`, ...overrides }), sessionCtx());
      history = [...history, { id: `kr${seq + 1}`, seq: seq + 1, role: 'assistant', text: result.text }, row(seq + 2, 'user', `m${seq + 2}`)];
      seq += 2;
      return result;
    };
    await reply();
    await reply();
    assert.equal(sdk.runs.length, 1, 'unchanged: reused');
    envValue = '2';
    await reply();
    assert.equal(sdk.runs.length, 2, 'another environment');
    binaryPath = '/opt/claude-next';
    await reply();
    assert.equal(sdk.runs.length, 3, 'another Claude Code binary');
    assert.equal(sdk.runs[2].options.pathToClaudeCodeExecutable, '/opt/claude-next');
    projectPath = path.join(testRoot, 'project-b');
    await reply();
    assert.equal(sdk.runs.length, 4, 'other projects');
    await reply({ replyFiles: false });
    assert.equal(sdk.runs.length, 5, 'no attach_files tool (a task lane)');
    assert.ok(sdk.runs.slice(0, -1).every((run) => run.closed), 'each replaced process is closed');
    warmProcesses.closeAll();
  });

  await test('warm processes: at most a few are kept (oldest first), and one parked across a sleep is not used', async () => {
    const clock = fakeTimers();
    let wall = 0;
    const closed = [];
    const proc = (name) => ({ name, sessionId: 's', optionsKey: 'k', iterator: { next: () => new Promise(() => {}) }, close: () => closed.push(name) });
    const pool = createWarmClaudeProcesses({ ...clock, now: () => wall, maxSize: 2 });
    assert.equal(BOT_WARM_PROCESSES_MAX, 3);
    pool.park('a', proc('a'));
    pool.park('b', proc('b'));
    pool.park('c', proc('c'));
    assert.deepEqual(closed, ['a'], 'the oldest goes');
    assert.equal(pool.size, 2);
    pool.park('b', proc('b2'));
    pool.park('d', proc('d'));
    assert.deepEqual(closed, ['a', 'b', 'c'], 'a re-parked key counts as newest');
    // Timers stop while a Mac sleeps: the wall clock decides.
    wall += BOT_WARM_PROCESS_MS;
    assert.equal(pool.take('d', { sessionId: 's', optionsKey: 'k' }), null);
    assert.deepEqual(closed.slice(-1), ['d']);
    // A reply that started before forgetBot/closeAll can't park.
    const ticket = pool.ticket('bot_9');
    pool.forgetBot('bot_9');
    assert.equal(pool.park('bot_9__m', proc('e'), ticket), false);
    assert.deepEqual(closed.slice(-1), ['e']);
    assert.equal(pool.park('bot_9__m', proc('f'), pool.ticket('bot_9')), true, 'a later reply can');
    const old = pool.ticket('bot_7');
    pool.closeAll();
    assert.equal(pool.park('bot_7', proc('g'), old), false);
  });

  await test('a reply whose Claude Code fails to start is handed back, with nothing left running', async () => {
    const warmProcesses = createWarmClaudeProcesses(fakeTimers());
    const sdk = warmSdk();
    const broken = {
      ...sdk,
      query: () => {
        throw new Error('spawn ENOENT');
      },
    };
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-broken-start') });
    const result = await sdkRunner(broken, { sessions, warmProcesses })(sessionLane([row(1, 'user', 'hi')], [1]), sessionCtx());
    assert.equal(result.retryElsewhere, true, 'nothing was written: another machine or the cloud answers');
    assert.match(result.failure, /ENOENT/);
    assert.equal(warmProcesses.size, 0);
  });

  await test('the claim asks for structured conversations; usage and compaction go back with the finish', async () => {
    const client = createFakeClient({ claim: laneClaims([makeLane()]) });
    startWorker({
      client,
      isOnline: () => true,
      isAvailable: async () => true,
      runLane: async () => ({ text: 'hi', usage: { mode: 'resume', input: 5, cacheRead: 100 }, compact: true }),
    });
    await waitFor(() => client.calls.finish.length === 1, { label: 'finish' });
    assert.deepEqual(client.calls.claim[0].features, [
      BOT_SESSIONS_FEATURE,
      BOT_REPLY_MESSAGES_FEATURE,
      BOT_THREAD_ACTIONS_FEATURE,
      BOT_THREAD_CONFIGURE_FEATURE,
      BOT_THREAD_REQUESTS_FEATURE,
    ]);
    assert.deepEqual(client.calls.finish[0].usage, { mode: 'resume', input: 5, cacheRead: 100 });
    assert.equal(client.calls.finish[0].compact, true);
    const normalized = normalizeBotLane({ laneId: 'l', botId: 'b', session: { history: [], answering: [1], context: [] } });
    assert.deepEqual(normalized.session, { history: [], answering: [1], context: [] });
  });

  await test('planBotPrompt resets on threadId rotation without invalidating pre-upgrade sessions, and forgetBot drops all model sessions', async () => {
    const basis = sessionBasis({ systemPrompt: 'a', model: 'm', tools: [] });
    const sess = { history: [row(1, 'user', 'hi')], answering: [1], context: [] };
    // Pre-upgrade session without threadId stays warm.
    assert.equal(planBotPrompt({ botName: 'B', session: sess, state: { sessionId: 's1', basis }, basis, threadId: 't1' }).mode, 'resume');
    // Same threadId resumes.
    assert.equal(planBotPrompt({ botName: 'B', session: sess, state: { sessionId: 's1', basis, threadId: 't1' }, basis, threadId: 't1' }).mode, 'resume');
    // Rotated threadId starts fresh with reason 'cleared'.
    const rotated = planBotPrompt({ botName: 'B', session: sess, state: { sessionId: 's1', basis, threadId: 't1' }, basis, threadId: 't2' });
    assert.equal(rotated.mode, 'fresh');
    assert.equal(rotated.reason, 'cleared');

    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-forget') });
    await sessions.begin('bot1__claude-opus-5-5');
    await sessions.end('bot1__claude-opus-5-5', { sessionId: 's-opus', basis: 'b' });
    await sessions.begin('bot1__claude-haiku-5-5');
    await sessions.end('bot1__claude-haiku-5-5', { sessionId: 's-haiku', basis: 'b' });
    await sessions.begin('other__claude-opus-5-5');
    await sessions.end('other__claude-opus-5-5', { sessionId: 's-other', basis: 'b' });

    // Start an in-flight session for bot1 and forgetBot while it is busy.
    const inFlight = await sessions.begin('bot1__claude-opus-5-5');
    assert.equal(inFlight.state?.sessionId, 's-opus');
    await sessions.forgetBot('bot1');
    await sessions.end('bot1__claude-opus-5-5', { sessionId: 's-opus-stale', basis: 'b' });

    const opusAfter = await sessions.begin('bot1__claude-opus-5-5');
    assert.equal(opusAfter.state, null, 'in-flight session discarded on forgetBot');
    await sessions.end('bot1__claude-opus-5-5', null);

    const haikuAfter = await sessions.begin('bot1__claude-haiku-5-5');
    assert.equal(haikuAfter.state, null, 'all model sessions for bot1 deleted');
    await sessions.end('bot1__claude-haiku-5-5', null);

    const otherAfter = await sessions.begin('other__claude-opus-5-5');
    assert.equal(otherAfter.state?.sessionId, 's-other', 'other bots untouched');
    await sessions.end('other__claude-opus-5-5', null);
  });

  await test('reasoningEffort is preserved by normalizeBotLane and forwarded as effort to Claude SDK', async () => {
    assert.equal(claudeEffortForBot('xhigh'), 'xhigh');
    assert.equal(claudeEffortForBot('none'), 'low');
    assert.equal(claudeEffortForBot('bogus'), null);
    const normalized = normalizeBotLane({ laneId: 'l-eff', botId: 'b1', model: 'claude-opus-5-5', reasoningEffort: 'max' });
    assert.equal(normalized.reasoningEffort, 'max');

    const sdk = createFakeSdk(async function* ({ next }) {
      await next();
      yield init('claude-opus-5-5');
      yield assistant('a1', [{ type: 'text', text: 'Deep answer.' }]);
      yield success();
    });
    const run = createClaudeLaneRunner({
      loadSdk: async () => sdk,
      loadZod: async () => zod,
      createInputQueue,
      botsDir: path.join(testRoot, 'bots-effort'),
    });
    const result = await run(
      {
        laneId: 'l-eff',
        botId: 'b1',
        botName: 'Durango',
        threadId: 't1',
        replyMessageId: 'r1',
        model: 'claude-opus-5-5',
        reasoningEffort: 'xhigh',
        systemPrompt: 'sys',
        prompt: 'hi',
        tools: [],
        attachments: [],
      },
      {
        signal: new AbortController().signal,
        accessMode: 'full-access',
        update: () => {},
        takeInbox: async () => [],
        callTool: async () => ({ result: null }),
      }
    );
    assert.equal(result.text, 'Deep answer.');
    assert.equal(sdk.runs[0].options.effort, 'xhigh');
  });

  await test('lane runner: finalMessageOnly drops earlier progress narration before tool calls and falls back if ending on a tool', async () => {
    const runWith = async (messages) => {
      const sdk = createFakeSdk(async function* ({ next }) {
        await next();
        for (const message of messages) yield message;
      });
      const run = createClaudeLaneRunner({
        loadSdk: async () => sdk,
        loadZod: async () => zod,
        createInputQueue,
        botsDir: path.join(testRoot, 'bots-final-only'),
      });
      return run(
        {
          laneId: 'lt-final',
          botId: 'b1',
          botName: 'Durango',
          model: 'claude-sonnet-5-5',
          systemPrompt: 'sys',
          prompt: 'do task',
          tools: [],
          attachments: [],
          finalMessageOnly: true,
        },
        {
          signal: new AbortController().signal,
          accessMode: 'read-only',
          update: () => {},
          takeInbox: async () => [],
          callTool: async () => ({ result: null }),
        }
      );
    };

    const withFinal = await runWith([
      init('claude-sonnet-5-5'),
      assistant('a1', [{ type: 'text', text: 'Checking the repo first...' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
      assistant('a2', [{ type: 'text', text: 'Running tests now...' }, { type: 'tool_use', id: 'tu2', name: 'Bash', input: {} }]),
      assistant('a3', [{ type: 'text', text: 'All tests passed. Opened chg_123.' }]),
      success(),
    ]);
    assert.equal(withFinal.text, 'All tests passed. Opened chg_123.');

    const endedOnTool = await runWith([
      init('claude-sonnet-5-5'),
      assistant('a1', [{ type: 'text', text: 'Starting...' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
      assistant('a2', [{ type: 'text', text: 'Final summary before cleanup.' }, { type: 'tool_use', id: 'tu2', name: 'Bash', input: {} }]),
      success(),
    ]);
    assert.equal(endedOnTool.text, 'Final summary before cleanup.');

    const substantial = 'Full report of everything found and changed across all services. ' + 'Details here. '.repeat(25);
    const withPostscript = await runWith([
      init('claude-sonnet-5-5'),
      assistant('a1', [{ type: 'text', text: 'Checking...' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
      assistant('a2', [{ type: 'text', text: substantial }, { type: 'tool_use', id: 'tu2', name: 'Bash', input: {} }]),
      assistant('a3', [{ type: 'text', text: 'Cleaned up temp files.' }]),
      success(),
    ]);
    assert.equal(withPostscript.text, `${substantial.trim()}\n\nCleaned up temp files.`);
  });

  await test('bot attachments: stage locally for instant handoff, upload in background, handle failure + retry, and never re-download local files', async () => {
    const srcFile = path.join(testRoot, 'retina-shot.png');
    const payload = Buffer.from('fake-png-bytes-5.9mb');
    await fs.writeFile(srcFile, payload);
    const stagingDir = path.join(testRoot, 'staged');
    const events = [];
    const uploadCalls = [];
    const updateCalls = [];
    let failNextUpload = true;

    const manager = createBotAttachmentManager({
      stagingDir,
      client: {
        uploadBotAttachment: async (args) => {
          uploadCalls.push(args);
          if (failNextUpload) throw new Error('Network dropped');
          return {
            part: {
              type: 'asset',
              asset: { id: 'asset_cloud_1', name: args.name, kind: 'image', contentType: args.contentType, byteSize: args.bytes.length },
            },
            attached: true,
          };
        },
        updateBotMessageAttachment: async (args) => {
          updateCalls.push(args);
          return { ok: true };
        },
      },
      onChange: (status) => events.push({ ...status }),
      log: () => {},
    });

    // 1. Stage locally: instant copy, immediately resolvable by pendingId before upload finishes.
    const staged = await manager.stageFiles({
      botId: 'b1',
      messageId: 'm1',
      files: [{ path: srcFile, name: 'retina-shot.png', size: payload.length, contentType: 'image/png' }],
    });
    assert.equal(staged.length, 1);
    assert.equal(staged[0].status, 'uploading');
    const pendingId = staged[0].pendingId;
    const localPath = manager.resolveLocalPath({ pendingId });
    assert.ok(localPath, 'resolvable by pendingId immediately');
    assert.deepEqual(await fs.readFile(localPath), payload);

    // 2. Local reply reads the staged file straight away without downloading (even with local: true and no url).
    const normalized = normalizeBotLane({
      laneId: 'l1',
      botId: 'b1',
      attachments: [{ id: pendingId, pendingId, name: 'retina-shot.png', contentType: 'image/png', local: true }],
    });
    assert.equal(normalized.attachments.length, 1);
    assert.equal(normalized.attachments[0].local, true);
    let downloads = 0;
    const replyDir = path.join(testRoot, 'reply-attachments');
    const note1 = await saveLaneAttachments(normalized.attachments, replyDir, {
      download: async () => {
        downloads += 1;
        throw new Error('should not download local file');
      },
      resolveLocalPath: (item) => manager.resolveLocalPath(item),
    });
    assert.equal(downloads, 0, 'never downloads a locally staged file');
    assert.match(note1, /retina-shot\.png/);

    // 3. Background upload fails: status flips to failed, canRetry=true, server notified so remote/cloud unblocks.
    await manager.startUploads({ pendingIds: [pendingId], account: 'acct_1' });
    assert.equal(uploadCalls.length, 1);
    assert.equal(uploadCalls[0].botId, 'b1');
    assert.equal(uploadCalls[0].messageId, 'm1');
    assert.equal(uploadCalls[0].pendingId, pendingId);
    const failedState = manager.listStatuses({ botId: 'b1' })[0];
    assert.equal(failedState.status, 'failed');
    assert.equal(failedState.canRetry, true);
    assert.match(failedState.error, /Network dropped/);
    assert.equal(updateCalls.some((c) => c.pendingId === pendingId && c.status === 'failed'), true);

    // 4. Retry succeeds: flips to uploading then ready, maps assetId -> localPath so future local replies still skip download.
    failNextUpload = false;
    const retried = await manager.retryUpload({ botId: 'b1', messageId: 'm1', pendingId, account: 'acct_1' });
    assert.equal(retried.ok, true);
    await waitFor(() => manager.listStatuses({ botId: 'b1' })[0]?.status === 'ready', { label: 'retry ready' });
    const readyState = manager.listStatuses({ botId: 'b1' })[0];
    assert.equal(readyState.assetId, 'asset_cloud_1');
    assert.equal(manager.resolveLocalPath({ id: 'asset_cloud_1' }), localPath, 'resolvable by assetId after upload');

    const replyDir2 = path.join(testRoot, 'reply-attachments-after-upload');
    const normalizedAfter = normalizeBotLane({
      laneId: 'l2',
      botId: 'b1',
      attachments: [{ id: 'asset_cloud_1', pendingId, name: 'retina-shot.png', contentType: 'image/png', url: 'https://example.invalid/shot.png' }],
    });
    const note2 = await saveLaneAttachments(normalizedAfter.attachments, replyDir2, {
      download: async () => {
        downloads += 1;
        throw new Error('should not re-download file uploaded from this Mac');
      },
      resolveLocalPath: (item) => manager.resolveLocalPath(item),
    });
    assert.equal(downloads, 0, 'still skips download after upload completes');
    assert.match(note2, /retina-shot\.png/);

    // 5. Mid-reply inbox preserves attachment metadata for local resolution.
    const inbox = normalizeBotInbox([
      { seq: 5, source: 'person', content: 'Look\n[attached: retina-shot.png]', attachments: [{ name: 'retina-shot.png', pendingId, status: 'uploading' }] },
    ]);
    assert.equal(inbox[0].attachments?.length, 1);
    assert.equal(inbox[0].attachments[0].pendingId, pendingId);
  });

  await test('stay_silent in Claude runner suppresses trailing boilerplate, keeps session, and wakes if a person writes before finish', async () => {
    const sessions = createBotSessionStore({ dir: path.join(testRoot, 'sessions-silent') });
    const silentTool = { name: 'stay_silent', description: 'Stay silent', inputSchema: { type: 'object', properties: { reason: { type: 'string' } } } };
    const updates = [];
    const sdk = createFakeSdk(async function* ({ next, options, tools }) {
      await next();
      yield { ...init(), session_id: 'sess-silent-1' };
      yield assistant('a1', [{ type: 'tool_use', id: 'tu_s1', name: 'mcp__durango_bot__stay_silent', input: { reason: 'Interim report' } }]);
      await tools.stay_silent.handler({ reason: 'Interim report' });
      const postHook = options.hooks.PostToolUse[0].hooks[0];
      const hookOut = await postHook({ tool_name: 'mcp__durango_bot__stay_silent' });
      assert.deepEqual(hookOut, { continue: false, stopReason: 'stay_silent' }, 'PostToolUse stops Claude right after stay_silent');
      // Even if Claude Code emits a short post-tool acknowledgement, it must be suppressed.
      yield { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } };
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Okay, staying silent.' } } };
      yield assistant('a2', [{ type: 'text', text: 'Okay, staying silent.' }]);
      yield { ...success(), session_id: 'sess-silent-1' };
    });
    const runLane = sdkRunner(sdk, { sessions });
    const history = [row(1, 'user', 'Task A done', { label: 'Task: Worker A' })];
    const outcome = await runLane(sessionLane(history, [1], { tools: [silentTool], replyMessageId: 'r_silent' }), {
      update: (u) => updates.push(u),
      takeInbox: async () => [],
      callTool: async ({ name }) => ({ result: name === 'stay_silent' ? { ok: true, silent: true } : { ok: true } }),
    });
    assert.equal(outcome.silent, true);
    assert.equal(outcome.silentReason, 'Interim report');
    assert.equal(outcome.text, '');
    assert.equal(updates.some((u) => u.text.includes('staying silent')), false, 'suppressed live boilerplate');
    const stored = await sessions.begin('bot_1__claude-opus-5-5');
    assert.equal(stored.state?.sessionId, 'sess-silent-1', 'kept session preserved across silent turn');
    await sessions.end('bot_1__claude-opus-5-5', stored.state);

    // If a person message arrives during beforeFinish after stay_silent, silent mode clears and the bot replies.
    let beforeFinishCalls = 0;
    const sdkWake = createFakeSdk(async function* ({ next, tools }) {
      await next();
      yield init();
      yield assistant('a1', [{ type: 'tool_use', id: 'tu_s2', name: 'mcp__durango_bot__stay_silent', input: { reason: 'Routine quiet' } }]);
      await tools.stay_silent.handler({ reason: 'Routine quiet' });
      yield success();
      const followUp = await next();
      assert.ok(followUp, 'received pre-finish person message');
      yield assistant('a2', [{ type: 'text', text: 'Hey! Here is the update.' }]);
      yield success();
    });
    const woke = await sdkRunner(sdkWake)(makeLane({ tools: [silentTool] }), {
      update: () => {},
      takeInbox: async (opts) => {
        if (!opts?.beforeFinish) return [];
        beforeFinishCalls += 1;
        return beforeFinishCalls === 1 ? [{ seq: 2, source: 'person', label: null, content: 'Quick check?' }] : [];
      },
      callTool: async () => ({ result: { ok: true, silent: true } }),
    });
    assert.equal(woke.silent, undefined);
    assert.equal(woke.text, 'Hey! Here is the update.');
  });

  await test('worker handles stay_silent from any harness runner (Codex/Antigravity/Grok/Muse), suppresses post-tool text, and keeps errors/empty visible', async () => {
    const client = createFakeClient({
      claim: laneClaims([makeLane({ laneId: 'l_silent' }), makeLane({ laneId: 'l_empty' }), makeLane({ laneId: 'l_fail' })]),
      tool: async ({ name }) => ({ result: name === 'stay_silent' ? { ok: true, silent: true } : { ok: true } }),
    });
    startWorker({
      client,
      runLane: async (lane, ctx) => {
        if (lane.laneId === 'l_silent') {
          await ctx.callTool({ name: 'stay_silent', input: { reason: 'Duplicate report' }, toolCallId: 'tc_1' });
          // Simulate a harness (e.g. Antigravity/Codex/Grok/Muse) that still returns post-tool boilerplate text.
          ctx.update({ text: 'Done, staying silent.' });
          return { text: 'Done, staying silent.' };
        }
        if (lane.laneId === 'l_empty') {
          return { text: '' };
        }
        await ctx.callTool({ name: 'stay_silent', input: { reason: 'Quiet' }, toolCallId: 'tc_2' });
        return { text: '', failure: 'ACP stream failed' };
      },
    });
    await waitFor(() => client.calls.finish.length === 3, { label: 'three finishes' });
    const byLane = new Map(client.calls.finish.map((item) => [item.laneId, item]));
    assert.equal(byLane.get('l_silent').silent, true);
    assert.equal(byLane.get('l_silent').silentReason, 'Duplicate report');
    assert.equal(byLane.get('l_silent').text, '');
    assert.equal(byLane.get('l_empty').silent, undefined, 'empty answer without stay_silent is never silent');
    assert.equal(byLane.get('l_fail').silent, undefined, 'actual error after stay_silent is never silent');
    assert.equal(byLane.get('l_fail').failure, 'ACP stream failed');
  });
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log('bot replies: all tests passed');
