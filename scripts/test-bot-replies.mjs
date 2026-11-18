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

import { DurangoError, accountKeyOf, createDurangoClient } from '../src/main/durango-client.js';
import { buildMachinePayload, createDispatchWorker } from '../src/main/durango-dispatch.js';
import {
  BOT_INBOX_HEADER,
  BOT_REPLIES_CAPABILITY,
  botProjectsNote,
  botToolLabel,
  createBotReplyWorker,
  createClaudeLaneRunner,
  durangoModelIdForClaude,
  formatBotInbox,
  normalizeBotSettings,
} from '../src/main/bot-replies.js';
import { createBotThreadTools } from '../src/main/bot-thread-tools.js';

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
const createFakeSdk = (script) => {
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
  const calls = { claim: [], progress: [], tool: [], finish: [] };
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
      ['thread-follow-up', 'model-choice', 'source-checkout', 'api-source-checkout', BOT_REPLIES_CAPABILITY]
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
    assert.equal(options.permissionMode, 'acceptEdits', 'workspace-write → acceptEdits, as agent threads');
    assert.equal(options.pathToClaudeCodeExecutable, '/opt/claude');
    assert.deepEqual(options.env, { TEST_ENV: '1' });
    assert.deepEqual(options.mcpServers, {}, 'no tools → no bot server');
    assert.equal((await options.canUseTool('Bash', { command: 'ls' })).behavior, 'deny', 'no one here to approve');
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

  await test('bot settings: on by default with Workspace write, separate from the dispatch opt-in', async () => {
    assert.deepEqual(normalizeBotSettings(undefined), { enabled: true, accessMode: 'workspace-write' });
    assert.deepEqual(normalizeBotSettings({ enabled: false, accessMode: 'full-access' }), { enabled: false, accessMode: 'full-access' });
    assert.deepEqual(normalizeBotSettings({ accessMode: 'bogus' }), { enabled: true, accessMode: 'workspace-write' });
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
      return { taskId: `task_${tasks.length}`, title: input.title };
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
      project: 'Durango', requestId: 't', signal: tasks[0].signal,
    }, 'the tool call id makes a retried create return the same task');
    assert.equal(started[0].projectId, 'p1');
    assert.equal(started[0].key, 'task_1', 'the renderer reports it as bottask:<taskId>');
    assert.equal(started[0].accessMode, 'workspace-write');
    assert.match(started[0].prompt, /^Fix the OpenCode updater spinner\.\n\nWhen you're done, end with a concise report/);
    assert.equal(results.named.ok, true, 'run_on naming this machine');
    assert.equal(results.missingHere.ok, false);
    assert.match(results.missingHere.error, /No Durango Code project named "website" on this computer\. Projects: Durango\./);
    // Another machine, a project not here, or no project: Durango's own tool.
    assert.deepEqual(client.calls.tool.map((call) => call.input.title), ['Other', 'Unknown', 'Cloud']);
    assert.equal(results.fails.ok, false);
    assert.equal(results.fails.error, 'No window.');
    assert.deepEqual(reports, [{ taskId: 'task_3', machineId: 'machine-1', outcome: 'failed', error: 'No window.' }], 'a thread that never started is reported failed');
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

  await test('access modes map like agent threads', async () => {
    for (const [accessMode, expected] of [
      ['read-only', { permissionMode: 'plan' }],
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
    assert.deepEqual(options.allowedTools, ['mcp__durango_bot__web_search'], 'pre-approved outside Full access');
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
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log('bot replies: all tests passed');
