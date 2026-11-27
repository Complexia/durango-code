import assert from 'node:assert/strict';
import {
  allBotCards,
  botNeedsYouCards,
  botSentAnswers,
  threadCardsKey,
  withNeedsYouNow,
  botThreadRequestSet,
  localNeedsYouBotKey,
  startBotThreadRequestSync,
  withLocalNeedsYou,
  type BotThreadRequest,
  type BotThreadRequestAnswer,
  type BotThreadRequestSyncInput,
} from '../src/app/botThreadRequests';
import { sealBotSecret } from '../src/app/botSecretSeal';
import { createBotSecretKeys } from '../src/main/bot-secret-keys.js';
import { createBotThreadRequestsBridge } from '../src/main/bot-thread-requests.js';
import type { Thread } from '../src/store';

// "Needs you" requests of bot-started threads in their bot's chat
// (src/app/botThreadRequests.ts, src/main/bot-thread-requests.js).

const at = '2026-11-27T10:00:00.000Z';
const thread = (id: string, extra: Partial<Thread> = {}): Thread =>
  ({ id, title: `Thread ${id}`, projectId: 'p1', status: 'idle', messages: [], ...extra }) as unknown as Thread;

const botThread = thread('t1', {
  startedByBotId: 'bot_1',
  startedByBot: 'durango-bots',
  status: 'running',
  userActions: [{ id: 'ua_auth', action: 'Authorize this device', url: 'https://durango.sh/desktop/authorize', requestedAt: at }],
} as Partial<Thread>);
const subagent = thread('t1-sub', {
  parentThreadId: 't1',
  title: 'Pair omarchy',
  userActions: [
    {
      id: 'sr_code',
      action: 'Pairing code',
      requestedAt: '2026-11-27T10:01:00.000Z',
      secret: { label: 'Pairing code', reason: 'The code omarchy shows', expiresAt: '' },
    },
  ],
} as Partial<Thread>);
const personThread = thread('t2', { userActions: [{ id: 'ua_mine', action: 'Mine', requestedAt: at }] } as Partial<Thread>);
const taskThread = thread('t3', {
  startedByBotDispatchId: 'bottask:task_9',
  durangoDispatch: { id: 'bottask:task_9' },
  userActions: [{ id: 'ua_task', action: 'Plug in the phone', requestedAt: at }],
} as Partial<Thread>);

// --- the set this machine sends --------------------------------------------------------
{
  const inputs = new Map([['t1', [{ requestId: 7, questions: [{ header: 'Deploy', question: 'Deploy now?', options: [{ label: 'Yes' }, { label: 'No' }] }] }]]]);
  const set = botThreadRequestSet([botThread, subagent, personThread, taskThread], inputs, () => 'durango');
  assert.deepEqual(
    set.map((entry) => entry.threadId),
    ['t1', 't3'],
    "only bot-started threads (not the person's own, not subagents on their own)"
  );
  const [first, task] = set;
  assert.deepEqual(first.owner, { botId: 'bot_1', botName: 'durango-bots' });
  assert.equal(first.projectName, 'durango');
  assert.deepEqual(
    first.requests.map((request) => [request.requestId, request.kind]),
    [
      ['ua_auth', 'action'],
      ['sr_code', 'secret'],
      ['q:7', 'input'],
    ]
  );
  const secret = first.requests[1];
  assert.equal(secret.actionThreadId, 't1-sub');
  assert.equal(secret.secretLabel, 'Pairing code');
  assert.match(first.requests[2].text, /Deploy now\?[\s\S]*- Yes/);
  assert.deepEqual(task.owner, { taskId: 'task_9' });
}

// --- the Bots view's cards and highlight ---------------------------------------------
{
  const request = (extra: Partial<BotThreadRequest>): BotThreadRequest => ({
    id: 'row1',
    botId: 'bot_1',
    machineId: 'm2',
    machineName: 'omarchy',
    threadId: 'remote-1',
    actionThreadId: null,
    subagentTitle: null,
    threadTitle: 'Pair omarchy',
    projectName: 'durango',
    requestId: 'ua_far',
    kind: 'action',
    text: 'Approve on omarchy',
    url: null,
    secretLabel: null,
    secretPlaceholder: null,
    secretKey: null,
    requestedAt: Date.parse(at),
    status: 'pending',
    answeredAt: null,
    answer: null,
    error: null,
    ...extra,
  });
  const threads = [botThread, subagent, personThread];
  // A thread elsewhere: through Durango. This computer's own thread: its live card.
  const cards = botNeedsYouCards('bot_1', [request({}), request({ id: 'row2', threadId: 't1', requestId: 'ua_auth', machineName: 'Mac' })], threads);
  const far = cards.find((card) => card.action.id === 'ua_far')!;
  assert.equal(far.here, false);
  assert.equal(far.machineName, 'omarchy');
  const near = cards.find((card) => card.action.id === 'ua_auth')!;
  assert.equal(near.here, true);
  assert.equal(near.action.url, 'https://durango.sh/desktop/authorize', 'the live card');
  const secret = cards.find((card) => card.action.id === 'sr_code')!;
  assert.equal(secret.here, true, 'a card Durango has not listed yet still shows');
  assert.equal(secret.action.threadId, 't1-sub');
  assert.equal(cards.length, 3, "the person's own thread is not the bot's");

  // Answered here (gone from the thread) before Durango caught up: hidden.
  const answered = [thread('t1', { ...botThread, userActions: undefined } as Partial<Thread>), personThread];
  assert.deepEqual(
    botNeedsYouCards('bot_1', [request({ id: 'row2', threadId: 't1', requestId: 'ua_auth' })], answered),
    []
  );
  // A mirror of the remote thread here: its live card acts through remote control.
  const mirror = thread('mirror-1', {
    remote: { machineId: 'rc-omarchy', machineName: 'omarchy', threadId: 'remote-1' },
    userActions: [{ id: 'ua_far', action: 'Approve on omarchy', requestedAt: at }],
  } as Partial<Thread>);
  const mirrored = botNeedsYouCards('bot_1', [request({})], [mirror]);
  assert.equal(mirrored[0].here, true);
  assert.equal(mirrored[0].threadId, 'mirror-1');

  assert.equal(localNeedsYouBotKey([botThread, subagent, personThread]), 'bot_1');
  assert.equal(localNeedsYouBotKey([subagent, thread('t1', { startedByBotId: 'bot_1' } as Partial<Thread>)]), 'bot_1', 'a subagent card counts for its root');
  const bots = [
    { id: 'bot_1', needsYou: false },
    { id: 'bot_2', needsYou: false },
  ];
  assert.deepEqual(
    withLocalNeedsYou(bots, 'bot_1')!.map((bot) => bot.needsYou),
    [true, false]
  );
  assert.equal(withLocalNeedsYou(bots, ''), bots);
}

// --- the sync loop --------------------------------------------------------------------
{
  let threads: Thread[] = [botThread];
  const listeners: Array<(state: { threads: Thread[] }, previous: { threads: Thread[] }) => void> = [];
  const timers: Array<{ at: number; fn: () => void }> = [];
  let clock = 0;
  const sent: BotThreadRequestSyncInput[] = [];
  let reply: BotThreadRequestAnswer[] = [];
  const applied: BotThreadRequestAnswer[] = [];
  let flag = false;
  const stop = startBotThreadRequestSync({
    getState: () => ({ threads }),
    subscribe: (listener) => {
      listeners.push(listener);
      return () => undefined;
    },
    sync: async (input) => {
      sent.push(input);
      return { ok: true, answers: reply };
    },
    apply: (answer) => applied.push(answer),
    hadRequests: () => flag,
    setHadRequests: (value) => {
      flag = value;
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { at: clock + ms, fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  // Lets the start (it waits for the saved threads) schedule its first sync.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const advance = async (ms: number) => {
    clock += ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > clock) break;
      timers.shift();
      next.fn();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  await advance(2_000);
  assert.equal(sent.length, 1, 'the set goes out after start');
  assert.equal(sent[0].threads[0].requests[0].requestId, 'ua_auth');
  assert.equal(flag, true);
  // Polls while something waits, and presses an answer once.
  reply = [{ threadId: 't1', actionThreadId: 't1', requestId: 'ua_auth', op: 'done', at: 5 }];
  await advance(4_000);
  assert.equal(sent.length, 2);
  assert.deepEqual(applied.map((answer) => answer.op), ['done']);
  await advance(4_000);
  assert.equal(applied.length, 1, 'an answer is pressed once');
  // The card went: the empty set goes out, then polling stops.
  reply = [];
  const previous = { threads };
  threads = [thread('t1', { ...botThread, userActions: undefined } as Partial<Thread>)];
  for (const listener of listeners) listener({ threads }, previous);
  await advance(500);
  const last = sent[sent.length - 1];
  assert.deepEqual(last.threads, []);
  assert.equal(flag, false);
  const count = sent.length;
  await advance(60_000);
  assert.equal(sent.length, count, 'nothing waits: no polling');
  stop();
}
{
  // A machine whose bot threads never waited on anyone sends nothing at start.
  let calls = 0;
  const timers: Array<() => void> = [];
  startBotThreadRequestSync({
    getState: () => ({ threads: [personThread] }),
    subscribe: () => () => undefined,
    sync: async () => {
      calls += 1;
      return { ok: true, answers: [] };
    },
    apply: () => undefined,
    hadRequests: () => false,
    setTimer: (fn) => {
      timers.push(fn);
      return fn;
    },
    clearTimer: () => undefined,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const fn of timers.splice(0)) fn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 0);
}

// --- secrets: sealed in the chat, opened only by the machine ------------------------
{
  const keys = createBotSecretKeys();
  const publicKey = keys.publicKeyFor('sr_code');
  assert.equal(keys.open('sr_code', await sealBotSecret(publicKey, 'sr_code', 'K7-339')), 'K7-339');
  await assert.rejects(async () => keys.open('sr_other', await sealBotSecret(publicKey, 'sr_code', 'x')));

  // The bridge adds the key to the synced request, opens a sealed answer and
  // hands it to the waiting request; the renderer never gets it.
  const saved: unknown[] = [];
  let lastBody: { threads: Array<{ requests: Array<{ secretKey?: string }> }> } | null = null;
  let answers: unknown[] = [];
  const bridge = createBotThreadRequestsBridge({
    client: {
      async syncBotThreadRequests(body: typeof lastBody) {
        lastBody = body;
        return { ok: true, answers };
      },
      async answerBotThreadRequest() {
        return { ok: true };
      },
    },
    getMachineId: async () => 'm1',
    signedOut: async () => false,
    answerSecretRequest: async (input: unknown) => {
      saved.push(input);
      return { ok: true };
    },
  });
  const input = {
    threads: [{ threadId: 't1', owner: { botId: 'bot_1' }, requests: [{ requestId: 'sr_code', kind: 'secret', text: 'Pairing', requestedAt: 1 }] }],
  };
  await bridge.sync(input);
  const key = lastBody!.threads[0].requests[0].secretKey!;
  assert.ok(key && key.length === 88);
  answers = [{ threadId: 't1', actionThreadId: 't1-sub', requestId: 'sr_code', kind: 'secret', op: 'save', sealed: await sealBotSecret(key, 'sr_code', '424242'), at: 9 }];
  const result = await bridge.sync(input);
  assert.deepEqual(result.answers, [], 'a secret answer never reaches the renderer');
  assert.deepEqual(saved, [{ threadId: 't1-sub', id: 'sr_code', answer: { type: 'save', value: '424242' } }]);
  await bridge.sync(input);
  assert.equal(saved.length, 1, 'applied once');
  // A value sealed to the wrong key is reported back as failed.
  answers = [{ threadId: 't1', requestId: 'sr_code', kind: 'secret', op: 'save', sealed: await sealBotSecret(createBotSecretKeys().publicKeyFor('sr_code'), 'sr_code', 'x'), at: 10 }];
  await bridge.sync(input);
  answers = [];
  await bridge.sync(input);
  assert.equal((lastBody as unknown as { failed?: Array<{ at: number }> }).failed?.[0]?.at, 10);
}


// --- subagent questions, needs-you now, sent answers ------------------------------
{
  const root = thread('r1', { startedByBotId: 'bot_1', status: 'running' } as Partial<Thread>);
  const sub = thread('r1-sub', { parentThreadId: 'r1', title: 'Review', status: 'running' } as Partial<Thread>);
  const set = botThreadRequestSet([root, sub], new Map([['r1-sub', [{ requestId: 3, questions: [{ header: 'Q', question: 'Ship it?' }] }]]]));
  assert.equal(set.length, 1, "a subagent's question shows under its bot-started thread");
  assert.deepEqual(
    { id: set[0].requests[0].requestId, kind: set[0].requests[0].kind, from: set[0].requests[0].actionThreadId, at: set[0].requests[0].requestedAt },
    { id: 'q:r1-sub:3', kind: 'input', from: 'r1-sub', at: 0 }
  );

  const row: BotThreadRequest = {
    id: 'row9', botId: 'bot_9', machineId: 'm2', machineName: 'omarchy', threadId: 'far-9', actionThreadId: null,
    subagentTitle: null, threadTitle: 'Far', projectName: null, requestId: 'ua_9', kind: 'action', text: 'Approve',
    url: null, secretLabel: null, secretPlaceholder: null, secretKey: null, requestedAt: 1, status: 'pending',
    answeredAt: null, answer: null, error: null,
  };
  const bots = [{ id: 'bot_9', needsYou: true, asked: false, requests: [row] }];
  assert.equal(withNeedsYouNow(bots, [], new Map())![0].needsYou, true);
  // Answered from this computer: the highlight clears before Durango's next list.
  assert.equal(withNeedsYouNow(bots, [], new Map([['far-9:ua_9', { op: 'done', machineName: 'omarchy', online: false }]]))![0].needsYou, false);
  // Answered elsewhere (Durango says answering): not highlighted either.
  assert.equal(withNeedsYouNow([{ ...bots[0], requests: [{ ...row, status: 'answering' }] }], [], new Map())![0].needsYou, false);
  // It asked something itself: still highlighted.
  assert.equal(withNeedsYouNow([{ ...bots[0], asked: true, requests: [] }], [], new Map())![0].needsYou, true);
  // An older Durango (no `asked`) keeps its own flag; a thread here asking sets it.
  assert.equal(withNeedsYouNow([{ id: 'bot_1', needsYou: false }], [botThread], new Map())![0].needsYou, true);
  assert.notEqual(threadCardsKey([botThread]), threadCardsKey([{ ...botThread, userActions: undefined } as Thread]));

  // Sent answers: kept while on their way, forgotten once taken, failed or re-opened.
  const card = (request: Partial<BotThreadRequest>) => botNeedsYouCards('bot_9', [{ ...row, ...request }], [])[0];
  const key = 'far-9:ua_9';
  botSentAnswers.set(key, { op: 'done', machineName: 'omarchy', online: false, at: Number.MAX_SAFE_INTEGER });
  botSentAnswers.reconcile([card({ error: 'old failure', errorAt: 50 })]);
  assert.ok(botSentAnswers.get().has(key), "an error from before the answer doesn't undo it");
  botSentAnswers.set(key, { op: 'done', machineName: 'omarchy', online: false, at: 100 });
  botSentAnswers.reconcile([card({ status: 'answering' })]);
  assert.equal(botSentAnswers.get().get(key)?.sawAnswering, true);
  assert.equal(botSentAnswers.get().get(key)?.online, false, 'the offline note survives the answering state');
  botSentAnswers.reconcile([card({ status: 'pending' })]);
  assert.equal(botSentAnswers.get().has(key), false, 're-opened after being answered: forgotten');
  botSentAnswers.set(key, { op: 'done', machineName: 'omarchy', online: true, at: 100 });
  botSentAnswers.reconcile([card({ error: 'The thread is gone.', errorAt: 120 })]);
  assert.equal(botSentAnswers.get().has(key), false, 'failed there: forgotten (the card shows why)');
  botSentAnswers.set(key, { op: 'done', machineName: 'omarchy', online: true, at: 100 });
  botSentAnswers.reconcile([]);
  assert.equal(botSentAnswers.get().has(key), false, 'its card left the list: forgotten');
  botSentAnswers.set(key, { op: 'done', machineName: 'omarchy', online: true, at: 100 });
  botSentAnswers.clear();
  assert.equal(botSentAnswers.get().size, 0, 'account switch / sign-out');
  assert.equal(allBotCards([{ id: 'bot_9', requests: [row] }], []).length, 1);
}

// --- start waits for the saved threads; failures and ended secrets ---------------
{
  let threads: Thread[] = [];
  const sent: BotThreadRequestSyncInput[] = [];
  const timers: Array<{ at: number; fn: () => void }> = [];
  let clock = 0;
  let release: () => void = () => undefined;
  let reply: { answers?: BotThreadRequestAnswer[]; ended?: Array<{ threadId: string; requestId: string }> } = {};
  const dropped: string[] = [];
  startBotThreadRequestSync({
    getState: () => ({ threads }),
    subscribe: () => () => undefined,
    sync: async (input) => {
      sent.push(input);
      return { ok: true, ...reply };
    },
    apply: () => {
      throw new Error('The thread is gone.');
    },
    dropCard: (threadId, requestId) => dropped.push(`${threadId}:${requestId}`),
    whenReady: () => new Promise<void>((resolve) => (release = resolve)),
    hadRequests: () => true,
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { at: clock + ms, fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const advance = async (ms: number) => {
    clock += ms;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > clock) break;
      timers.shift();
      next.fn();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  await advance(5_000);
  assert.equal(sent.length, 0, 'nothing (not even an empty set) before the saved threads load');
  threads = [botThread, subagent];
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await advance(2_000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].threads[0].requests.length, 2, 'the loaded set, not an empty one');
  // An answer that can't be pressed is reported on the next sync.
  reply = { answers: [{ threadId: 't1', actionThreadId: 't1', requestId: 'ua_auth', op: 'done', at: 7 }], ended: [{ threadId: 't1-sub', requestId: 'sr_code' }] };
  await advance(4_000);
  assert.deepEqual(dropped, ['t1-sub:sr_code'], 'an ended secret request loses its card');
  reply = {};
  await advance(4_000);
  const reported = sent.find((input) => input.failed?.length);
  assert.deepEqual(reported?.failed, [{ threadId: 't1', requestId: 'ua_auth', at: 7, error: 'The thread is gone.' }]);
}

// --- the bridge: ended secrets, spent keys, sign-out ----------------------------
{
  const bodies: Array<{ threads: unknown[] }> = [];
  let answers: unknown[] = [];
  let ended = false;
  const bridge = createBotThreadRequestsBridge({
    client: {
      async syncBotThreadRequests(body: { threads: Array<{ requests: Array<{ secretKey?: string }> }> }) {
        bodies.push(body);
        return { ok: true, answers };
      },
      async answerBotThreadRequest() {
        return { ok: true };
      },
    },
    getMachineId: async () => 'm1',
    signedOut: async () => false,
    answerSecretRequest: async () => (ended ? { ok: false, ended: true, error: 'gone' } : { ok: true }),
  });
  const input = { threads: [{ threadId: 't1', owner: { botId: 'bot_1' }, requests: [{ requestId: 'sr_e', kind: 'secret', text: 'x', requestedAt: 1 }] }] };
  await bridge.sync(input);
  const key = (bodies[0].threads[0] as { requests: Array<{ secretKey: string }> }).requests[0].secretKey;
  ended = true;
  answers = [{ threadId: 't1', actionThreadId: 't1-sub', requestId: 'sr_e', kind: 'secret', op: 'save', sealed: await sealBotSecret(key, 'sr_e', 'v'), at: 1 }];
  const result = await bridge.sync(input);
  assert.deepEqual(result.ended, [{ threadId: 't1-sub', requestId: 'sr_e' }]);
  answers = [];
  await bridge.sync(input);
  assert.equal((bodies[bodies.length - 1].threads[0] as { requests: Array<{ secretKey: string }> }).requests[0].secretKey, key, 'a spent key keeps its public key');
  assert.deepEqual((await bridge.clear()).ok, true);
  assert.deepEqual(bodies[bodies.length - 1].threads, [], 'sign-out clears the machine on Durango');

  const keys = createBotSecretKeys();
  const pub = keys.publicKeyFor('sr_s');
  const sealed = await sealBotSecret(pub, 'sr_s', 'once');
  assert.equal(keys.open('sr_s', sealed), 'once');
  keys.spend('sr_s');
  assert.throws(() => keys.open('sr_s', sealed), /already has its value/);
  const env = JSON.parse(await sealBotSecret(keys.publicKeyFor('sr_iv'), 'sr_iv', 'x'));
  assert.throws(() => keys.open('sr_iv', JSON.stringify({ ...env, iv: Buffer.alloc(16).toString('base64') })), /bad nonce/);
}

console.log('bot thread requests: ok');
