// Local bots (src/main/local-bots.js): bots on this device while signed out of
// Durango, answered by this machine's Claude Code. The lane runner is faked;
// the parallel-reply delay and the routine timer are driven by hand.
//
//   node --no-warnings scripts/test-local-bots.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  LOCAL_BOT_PLACE,
  TRANSCRIPT_LOG_MAX_LINES,
  compactionBoundary,
  createLocalBotEngine,
  durangoModelForLocalBot,
  nextRunAfter,
} from '../src/main/local-bots.js';
import { createClaudeOneShot } from '../src/main/bot-replies.js';
import { EARLIER_HISTORY_MAX_CHARS, SUMMARY_MAX_CHARS, memorySection, parseCompaction } from '../src/main/bot-memory.js';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'durango-local-bots-'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, { timeout = 3_000, label = 'condition' } = {}) => {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await delay(5);
  }
};

/** A fake lane runner: each call waits until the test finishes it. */
const createFakeRunner = () => {
  const lanes = [];
  const runLane = (lane, ctx) =>
    new Promise((resolve) => {
      const run = {
        lane,
        ctx,
        finish: (outcome) => resolve(outcome),
        done: false,
      };
      ctx.signal?.addEventListener('abort', () => resolve({ text: '', aborted: true }), { once: true });
      lanes.push(run);
    }).then((outcome) => {
      lanes.find((run) => run.lane === lane).done = true;
      return outcome;
    });
  return { lanes, runLane, running: () => lanes.filter((run) => !run.done) };
};

/** Manual sleep: resolves when the test releases it. */
const createManualSleep = () => {
  const sleeps = [];
  return {
    sleeps,
    sleep: (ms) => new Promise((resolve) => sleeps.push({ ms, resolve })),
    release: () => {
      for (const entry of sleeps.splice(0)) entry.resolve();
    },
  };
};

const createManualTimer = () => {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      handle.cleared = true;
    },
  };
};

let dirCount = 0;
const makeEngine = (overrides = {}) => {
  const dir = overrides.dir ?? path.join(testRoot, `bots-${(dirCount += 1)}`);
  const runner = overrides.runner ?? createFakeRunner();
  const sleeper = createManualSleep();
  const timer = createManualTimer();
  const notifications = [];
  let clock = overrides.clock ?? { now: Date.parse('2026-11-17T08:00:00') };
  const engine = createLocalBotEngine({
    dir,
    runLane: runner.runLane,
    summarize: overrides.summarize ?? null,
    getAccessMode: () => 'auto-edit',
    notify: (notification) => notifications.push(notification),
    now: () => clock.now,
    sleep: sleeper.sleep,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    log: () => {},
    timeZone: () => 'Australia/Sydney',
    ...(overrides.listProjects ? { listProjects: overrides.listProjects } : {}),
    ...(overrides.listModels ? { listModels: overrides.listModels } : {}),
    ...(overrides.startProjectThread ? { startProjectThread: overrides.startProjectThread } : {}),
    ...(overrides.startThreadFollowUp ? { startThreadFollowUp: overrides.startThreadFollowUp } : {}),
    ...(overrides.threadTools ? { threadTools: overrides.threadTools } : {}),
  });
  engine.setActive(true);
  return { engine, runner, sleeper, timer, notifications, dir, clock };
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- the primary bot and shapes ------------------------------------------------------------

test('list creates the primary bot in the desktop shape', async () => {
  const { engine } = makeEngine();
  const listed = await engine.list();
  assert.equal(listed.allowed, true);
  assert.equal(listed.bots.length, 1);
  const [bot] = listed.bots;
  assert.equal(bot.name, 'Durango');
  assert.equal(bot.emoji, '✨');
  assert.equal(bot.role, 'primary');
  assert.equal(bot.model, 'claude-opus-5-5');
  assert.equal(bot.status, 'idle');
  assert.deepEqual(bot.replies, []);
  assert.equal(bot.unread, 0);
  assert.equal(bot.needsYou, false);
  // Calling again doesn't create another.
  assert.equal((await engine.list()).bots.length, 1);
  const thread = await engine.thread(bot.id);
  assert.deepEqual(thread.messages, []);
  assert.deepEqual(thread.live, []);
  assert.equal(thread.hasMore, false);
  await assert.rejects(engine.thread('nope'), /No such bot/);
});

// --- replies -----------------------------------------------------------------------------

test('a message while idle starts a reply; live progress and the stored reply', async () => {
  const { engine, runner } = makeEngine();
  const [primary] = (await engine.list()).bots;
  const sent = await engine.send(primary.id, { messageId: 'bm1', content: 'Weather in SF?' });
  assert.equal(sent.seq, 1);
  // Idempotent by id.
  assert.equal((await engine.send(primary.id, { messageId: 'bm1', content: 'Weather in SF?' })).seq, 1);
  await waitFor(() => runner.lanes.length === 1, { label: 'reply started' });
  const [run] = runner.lanes;
  assert.equal(run.lane.botId, primary.id);
  assert.equal(run.lane.model, 'claude-opus-5-5');
  assert.equal(run.ctx.accessMode, 'auto-edit');
  assert.match(run.lane.systemPrompt, /You are a Durango bot/);
  assert.match(run.lane.systemPrompt, /Your name is Durango\./);
  assert.match(run.lane.systemPrompt, /primary bot/);
  assert.doesNotMatch(run.lane.systemPrompt, /Durango's cloud|list_machines|run_on/);
  assert.match(run.lane.prompt, /<new_messages>\nPerson:\nWeather in SF\?\n<\/new_messages>/);
  assert.match(run.lane.prompt, /1 message from the person/);
  assert.match(run.lane.prompt, /The person has no other bots yet\./);
  assert.deepEqual(
    run.lane.tools.map((tool) => tool.name).sort(),
    [
      'ask_user', 'create_bot', 'delegate_task', 'forget_project_note', 'manage_routine', 'message_bot', 'notify_user',
      'project_notes', 'read_bot', 'read_project_file', 'remember_project', 'save_project_file', 'search_history', 'show_actions',
      'show_html', 'update_bot',
    ]
  );

  run.ctx.update({ text: 'Checking SF weather now.', activeTool: 'WebSearch' });
  let thread = await engine.thread(primary.id);
  assert.equal(thread.bot.status, 'running');
  assert.deepEqual(thread.bot.replies, [{ messageId: run.lane.laneId, place: LOCAL_BOT_PLACE }]);
  assert.deepEqual(thread.live, [
    // It showed text, so it has its place (seq 2, after the message it answers).
    { messageId: run.lane.laneId, seq: 2, firstSeq: null, place: LOCAL_BOT_PLACE, content: 'Checking SF weather now.', activeTool: 'WebSearch' },
  ]);

  run.finish({ text: 'Checking SF weather now.\n\n18°C and sunny.', modelId: 'anthropic/claude-opus-5.5' });
  await engine.idle();
  thread = await engine.thread(primary.id);
  assert.deepEqual(thread.live, []);
  assert.equal(thread.messages.length, 2);
  const reply = thread.messages[1];
  assert.equal(reply.id, run.lane.laneId, 'the stored reply keeps the live id');
  assert.equal(reply.role, 'assistant');
  assert.equal(reply.seq, 2);
  assert.equal(thread.bot.unread, 1);
  assert.equal(thread.bot.lastPreview, 'Checking SF weather now. 18°C and sunny.');
  await engine.thread(primary.id, { read: true });
  assert.equal((await engine.thread(primary.id)).bot.unread, 0);
});

test('a reply is the messages it sends: acknowledgement, progress and the answer with its buttons, each in its own place', async () => {
  const { engine, runner, dir, sleeper } = makeEngine();
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'q1', content: 'Is the dots fix ready?' });
  await waitFor(() => runner.lanes.length === 1, { label: 'reply started' });
  const [run] = runner.lanes;
  const id = run.lane.laneId;
  run.ctx.update({ text: 'On it, checking the change.' });
  assert.equal(await run.ctx.sendMessage({ index: 0, text: 'On it, checking the change.' }), true);
  run.ctx.update({ text: '' });
  // The person writes meanwhile: it lands between the reply's messages.
  await engine.send(primary.id, { messageId: 'q2', content: 'and the docs?' });
  assert.equal((await run.ctx.takeInbox()).length, 1);
  sleeper.release();
  run.ctx.update({ text: 'Checks passed, the docs too.' });
  assert.equal(await run.ctx.sendMessage({ index: 1, text: 'Checks passed, the docs too.' }), true);
  // Buttons made with the answer go on it; a repeat of an index changes nothing.
  assert.equal(await run.ctx.sendMessage({ index: 2, text: 'Ready: chg_abc fixes the dots.' }), true);
  assert.equal(await run.ctx.sendMessage({ index: 2, text: 'Ready: chg_abc fixes the dots.' }), true);
  const shown = await run.ctx.callTool({ name: 'show_actions', input: { actions: [{ kind: 'reply', label: 'Ship it' }] }, message: 2 });
  assert.equal(shown.result.ok, true);
  run.ctx.update({ text: '' });
  // Nothing written after the buttons: no final message of its own.
  run.finish({ text: '', sent: 3 });
  await engine.idle();
  const thread = await engine.thread(primary.id);
  assert.deepEqual(thread.live, []);
  assert.deepEqual(
    thread.messages.map((message) => [message.seq, message.role, message.content]),
    [
      [1, 'user', 'Is the dots fix ready?'],
      [2, 'assistant', 'On it, checking the change.'],
      [3, 'user', 'and the docs?'],
      [4, 'assistant', 'Checks passed, the docs too.'],
      [5, 'assistant', 'Ready: chg_abc fixes the dots.'],
    ]
  );
  assert.equal(thread.messages[4].id, `${id}_m02`);
  assert.deepEqual(thread.messages[4].cards.map((card) => card.component), ['bot-actions']);
  assert.equal(thread.messages[1].cards, undefined);
  assert.equal(thread.bot.lastPreview, 'Ready: chg_abc fixes the dots.');
  assert.ok(!thread.messages.some((message) => message.content.startsWith("Couldn't reply")), 'no failure note');
  // Saved: a reload reads the same messages and cards.
  await engine.flush();
  const reloaded = makeEngine({ dir });
  const again = await reloaded.engine.thread(primary.id);
  assert.deepEqual(again.messages.map((message) => message.content), thread.messages.map((message) => message.content));
  assert.deepEqual(again.messages[4].cards.map((card) => card.component), ['bot-actions']);
  await reloaded.engine.stop();
});

test('a reply picked up again after a restart sees the messages the stopped one already sent', async () => {
  const dir = path.join(testRoot, 'restart-sent');
  const first = makeEngine({ dir });
  const [primary] = (await first.engine.list()).bots;
  await first.engine.send(primary.id, { messageId: 'q', content: 'Check A and B.' });
  await waitFor(() => first.runner.lanes.length === 1);
  const run = first.runner.lanes[0];
  run.ctx.update({ text: 'Checking A.' });
  assert.equal(await run.ctx.sendMessage({ index: 0, text: 'Checking A.' }), true);
  await first.engine.flush();
  await first.engine.stop();
  const second = makeEngine({ dir });
  await second.engine.list();
  await waitFor(() => second.runner.lanes.length === 1, { label: 'picked up again' });
  const history = second.runner.lanes[0].lane.session.history.map((row) => `${row.role}:${row.text}`);
  assert.ok(history.includes('assistant:Checking A.'), history.join(' | '));
  assert.ok(history.includes('user:Check A and B.'), history.join(' | '));
  second.runner.lanes[0].finish({ text: 'Done with B.' });
  await second.engine.idle();
  await second.engine.stop();
});

test('messages sent mid-reply are taken in between steps', async () => {
  const { engine, runner, sleeper } = makeEngine();
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'SF weather?' });
  await waitFor(() => runner.lanes.length === 1);
  await engine.send(primary.id, { messageId: 'b', content: 'and Almaty?' });
  const taken = await runner.lanes[0].ctx.takeInbox();
  assert.deepEqual(taken, [{ seq: 2, source: 'person', label: null, content: 'and Almaty?' }]);
  assert.deepEqual(await runner.lanes[0].ctx.takeInbox(), [], 'taken once');
  // The parallel check finds nothing waiting.
  sleeper.release();
  await delay(5);
  assert.equal(runner.lanes.length, 1);
  runner.lanes[0].finish({ text: 'SF 18°C, Almaty -3°C.' });
  await engine.idle();
  const thread = await engine.thread(primary.id);
  assert.deepEqual(thread.messages.map((message) => [message.seq, message.role]), [[1, 'user'], [2, 'user'], [3, 'assistant']]);
  assert.equal(runner.lanes.length, 1, 'no extra reply');
});

test('pre-finish check in local bots claims back-to-back person messages, resets draft seq below them, and skips routines', async () => {
  const { engine, runner, sleeper } = makeEngine();
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'he', content: 'He' });
  await waitFor(() => runner.lanes.length === 1);
  const run = runner.lanes[0];
  // Draft text reserves seq 2.
  run.ctx.update({ text: 'Hey! What can I help you with?' });
  assert.equal((await engine.thread(primary.id)).live[0].seq, 2);
  // A second message from the person arrives at seq 3 while replying.
  await engine.send(primary.id, { messageId: 'hey', content: 'Hey' });
  const taken = await run.ctx.takeInbox({ beforeFinish: true });
  assert.deepEqual(taken, [{ seq: 3, source: 'person', label: null, content: 'Hey' }]);
  // Draft place and live text were cleared so the rewritten final answer sits below "Hey".
  assert.equal((await engine.thread(primary.id)).live[0].seq, null);
  assert.equal((await engine.thread(primary.id)).live[0].content, '');
  // Parallel timer wakes up and finds nothing waiting.
  sleeper.release();
  await delay(5);
  assert.equal(runner.lanes.length, 1);
  run.finish({ text: "Hey! What's up?" });
  await engine.idle();
  const thread = await engine.thread(primary.id);
  assert.deepEqual(
    thread.messages.map((message) => [message.seq, message.role, message.content]),
    [
      [1, 'user', 'He'],
      [3, 'user', 'Hey'],
      [4, 'assistant', "Hey! What's up?"],
    ]
  );
  assert.equal(runner.lanes.length, 1, 'single reply answered both messages');
});

test('a message not taken in within 5 s gets a parallel reply (at most 2)', async () => {
  const { engine, runner, sleeper } = makeEngine();
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'Write me a long essay' });
  await waitFor(() => runner.lanes.length === 1);
  await engine.send(primary.id, { messageId: 'b', content: 'quick: 2+2?' });
  assert.equal(sleeper.sleeps.length, 1);
  assert.equal(sleeper.sleeps[0].ms, 5_000);
  assert.equal((await engine.list()).bots[0].status, 'running');
  sleeper.release();
  await waitFor(() => runner.lanes.length === 2, { label: 'parallel reply' });
  const parallel = runner.lanes[1];
  assert.match(parallel.lane.prompt, /<new_messages>\nPerson:\nquick: 2\+2\?\n<\/new_messages>/);
  assert.match(parallel.lane.prompt, /Another reply of yours is already answering: "Write me a long essay"/);
  assert.match(parallel.lane.prompt, /<conversation_so_far>\nPerson:\nWrite me a long essay/);
  // A third message while two replies run: the check can't start a third.
  await engine.send(primary.id, { messageId: 'c', content: 'and 3+3?' });
  sleeper.release();
  await delay(5);
  assert.equal(runner.running().length, 2);
  // The parallel reply finishes first; the remaining message gets a reply after both are done.
  parallel.finish({ text: '4' });
  await waitFor(() => runner.running().length === 1);
  await delay(5);
  assert.equal(runner.lanes.length, 2, 'another reply is still running: no new one yet');
  runner.lanes[0].finish({ text: 'Here is the essay.' });
  await waitFor(() => runner.lanes.length === 3, { label: 'follow-up reply' });
  assert.match(runner.lanes[2].lane.prompt, /<new_messages>\nPerson:\nand 3\+3\?\n<\/new_messages>/);
  runner.lanes[2].finish({ text: '6' });
  await engine.idle();
  const thread = await engine.thread(primary.id);
  assert.deepEqual(
    thread.messages.map((message) => `${message.seq}:${message.role}:${message.content}`),
    ['1:user:Write me a long essay', '2:user:quick: 2+2?', '3:user:and 3+3?', '4:assistant:4', '5:assistant:Here is the essay.', '6:assistant:6']
  );
});

test('a shown message keeps its place when the reply takes in a later one; what it writes after reading goes below it', async () => {
  const dir = path.join(testRoot, 'reply-moves');
  const { engine, runner, sleeper } = makeEngine({ dir });
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'land the durango change' });
  await waitFor(() => runner.lanes.length === 1);
  const run = runner.lanes[0];
  // It shows text: its place is 2.
  run.ctx.update({ text: 'Landing the project-sort change now.' });
  assert.equal((await engine.thread(primary.id)).live[0].seq, 2);
  // The person writes mid-reply: 3, below the reply so far.
  assert.equal((await engine.send(primary.id, { messageId: 'b', content: "wait no, don't" })).seq, 3);
  // The reply takes it in: what it showed was written before reading it, so it stays at 2.
  assert.deepEqual((await run.ctx.takeInbox()).map((item) => item.seq), [3]);
  assert.equal((await engine.thread(primary.id)).live[0].seq, 2);
  assert.equal(await run.ctx.sendMessage({ index: 0, text: 'Landing the project-sort change now.' }), true);
  run.ctx.update({ text: '' });
  // Its answer to the new message is its next message: below it.
  run.ctx.update({ text: 'Stopped.' });
  assert.equal((await engine.thread(primary.id)).live[0].seq, 4);
  sleeper.release();
  run.finish({ text: 'Stopped.', sent: 1 });
  await engine.idle();
  const thread = await engine.thread(primary.id);
  assert.deepEqual(
    thread.messages.map((message) => `${message.seq}:${message.role}`),
    ['1:user', '2:assistant', '3:user', '4:assistant'],
    'each message where it showed'
  );
  await engine.stop();
  // After a reload: the same order.
  const reloaded = makeEngine({ dir });
  const again = await reloaded.engine.thread(primary.id);
  assert.deepEqual(again.messages.map((message) => `${message.seq}:${message.content}`), [
    '1:land the durango change',
    '2:Landing the project-sort change now.',
    "3:wait no, don't",
    '4:Stopped.',
  ]);
  await reloaded.engine.stop();
});

test('a reply is placed after the messages that arrived while it ran', async () => {
  const { engine, runner } = makeEngine();
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'one' });
  await waitFor(() => runner.lanes.length === 1);
  await engine.send(primary.id, { messageId: 'b', content: 'two' });
  runner.lanes[0].finish({ text: 'answer to one' });
  await waitFor(() => runner.lanes.length === 2, { label: 'reply to the waiting message' });
  let thread = await engine.thread(primary.id);
  assert.deepEqual(thread.messages.map((message) => message.content), ['one', 'two', 'answer to one']);
  runner.lanes[1].finish({ text: 'answer to two' });
  await engine.idle();
  thread = await engine.thread(primary.id);
  assert.deepEqual(thread.messages.map((message) => message.content), ['one', 'two', 'answer to one', 'answer to two']);
});

test('a failed reply leaves a short note', async () => {
  const { engine, runner } = makeEngine();
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'hi' });
  await waitFor(() => runner.lanes.length === 1);
  runner.lanes[0].finish({ text: '', failure: 'Claude Code stopped (rate_limit).', retryElsewhere: true });
  await engine.idle();
  const thread = await engine.thread(primary.id);
  assert.equal(thread.messages[1].content, "Couldn't reply on this computer: Claude Code stopped (rate_limit).");
});

test('stop aborts a running reply and its messages are answered next time', async () => {
  const dir = path.join(testRoot, 'stop');
  const first = makeEngine({ dir });
  const [primary] = (await first.engine.list()).bots;
  await first.engine.send(primary.id, { messageId: 'a', content: 'hi' });
  await waitFor(() => first.runner.lanes.length === 1);
  await first.engine.stop();
  await first.engine.idle();
  assert.equal((await first.engine.thread(primary.id)).messages.length, 1, 'no reply stored');
  const second = makeEngine({ dir });
  await waitFor(() => second.runner.lanes.length === 1, { label: 'reply after restart' });
  assert.match(second.runner.lanes[0].lane.prompt, /Person:\nhi/);
  second.runner.lanes[0].finish({ text: 'hello' });
  await second.engine.idle();
});

// --- tools -------------------------------------------------------------------------------

test('create_bot, message_bot, read_bot and update_bot', async () => {
  const { engine, runner } = makeEngine();
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'Make me a news bot' });
  await waitFor(() => runner.lanes.length === 1);
  const call = (name, input) => runner.lanes[0].ctx.callTool({ name, input, toolCallId: `t-${name}` }).then((out) => out.result);

  const created = await call('create_bot', {
    name: 'News',
    job: 'You send a morning news digest.',
    emoji: '📰',
    routines: [{ title: 'Morning digest', instructions: 'Send the digest.', schedule: { kind: 'daily', time: '07:30' } }],
    first_message: 'Say hi to the person.',
  });
  assert.equal(created.ok, true);
  assert.deepEqual(created.routines, ['Morning digest']);
  // The first message wakes the new bot.
  await waitFor(() => runner.lanes.length === 2, { label: 'new bot replies' });
  const newsRun = runner.lanes[1];
  assert.equal(newsRun.lane.botId, created.botId);
  assert.equal(newsRun.lane.model, 'claude-sonnet-5-5', 'woken by another bot: background runs stay on Sonnet (replies to the person: Opus)');
  assert.match(newsRun.lane.prompt, /\[Bot: Durango\]:\nSay hi to the person\./);
  assert.match(newsRun.lane.prompt, /1 message from other bots/);
  assert.match(newsRun.lane.prompt, /Your routines: "Morning digest" \(lr[a-z0-9]+\): daily at 07:30 \(every day\), next /);
  assert.match(newsRun.lane.prompt, new RegExp(`- Durango \\(${primary.id}; primary, running\\)`));
  assert.match(newsRun.lane.systemPrompt, /## Your job\n\nYou send a morning news digest\./);
  newsRun.finish({ text: 'Hi! I will send a digest at 7:30.' });

  const listed = await engine.list();
  assert.equal(listed.bots.length, 2);
  assert.equal(listed.bots[0].role, 'primary', 'primary first');

  const messaged = await call('message_bot', { bot_id: created.botId, message: 'Add tech news too.' });
  assert.deepEqual(messaged, { ok: true, to: 'News' });
  await waitFor(() => runner.lanes.length === 3, { label: 'messaged bot replies' });
  runner.lanes[2].finish({ text: 'Will do.' });
  await waitFor(() => runner.running().length === 1);

  const read = await call('read_bot', { bot_id: created.botId, limit: 10 });
  assert.equal(read.ok, true);
  assert.deepEqual(read.messages.map((message) => message.content), ['Say hi to the person.', 'Hi! I will send a digest at 7:30.', 'Add tech news too.', 'Will do.']);
  assert.equal(read.messages[0].from, 'Bot: Durango');

  assert.deepEqual(await call('message_bot', { bot_id: primary.id, message: 'me' }), { ok: false, error: "That's you: message another bot." });
  assert.deepEqual(await call('read_bot', { bot_id: 'missing' }), { ok: false, error: 'No such bot on this device.' });
  assert.equal((await call('update_bot', { bot_id: 'missing', name: 'x' })).ok, false);

  const updated = await call('update_bot', { bot_id: created.botId, model: 'anthropic/claude-haiku-5.5', paused: true, name: 'Newsie' });
  assert.equal(updated.ok, true);
  assert.equal(updated.bot.model, 'claude-haiku-5-5');
  const news = (await engine.list()).bots.find((bot) => bot.id === created.botId);
  assert.equal(news.paused, true);
  assert.equal(news.name, 'Newsie');
  // A paused bot keeps messages without replying; resuming answers them.
  await call('message_bot', { bot_id: created.botId, message: 'Still there?' });
  await delay(5);
  assert.equal(runner.lanes.length, 3);
  await call('update_bot', { bot_id: created.botId, paused: false });
  await waitFor(() => runner.lanes.length === 4, { label: 'resumed bot replies' });
  runner.lanes[3].finish({ text: 'Yes.' });
  assert.equal((await call('update_bot', { model: 'gpt-9' })).ok, false);
  assert.deepEqual(await call('nope', {}), { ok: false, error: 'No tool named nope.' });
  runner.lanes[0].finish({ text: 'Done: News is set up.' });
  await engine.idle();
});

test('models: bots on the old default move to Opus, chosen ones stay; switching keeps the thread', async () => {
  const dir = path.join(testRoot, `bots-${(dirCount += 1)}`);
  await fs.mkdir(dir, { recursive: true });
  const stored = (id, role, extra) => ({ id, name: id, role, job: '', createdAt: 1, lastActivityAt: 1, ...extra });
  await fs.writeFile(
    path.join(dir, 'bots.json'),
    JSON.stringify({
      version: 1,
      bots: [
        stored('lbprimary', 'primary', { model: 'claude-opus-5-5' }),
        stored('lbolddefault', 'bot', { model: 'claude-sonnet-5-5' }),
        stored('lbchosen', 'bot', { model: 'claude-sonnet-5-5', modelChosen: true }),
        stored('lbhaiku', 'bot', { model: 'claude-haiku-5-5' }),
      ],
    })
  );
  const { engine, runner } = makeEngine({ dir });
  const listed = await engine.list();
  const model = (id) => listed.bots.find((bot) => bot.id === id).model;
  assert.equal(model('lbolddefault'), 'claude-opus-5-5', 'the old default follows the new one');
  assert.equal(model('lbchosen'), 'claude-sonnet-5-5', 'a chosen model stays');
  assert.equal(model('lbhaiku'), 'claude-haiku-5-5');
  assert.deepEqual(listed.modelChoices.map((choice) => choice.id), ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5']);

  // A reply running when the person switches finishes on its model; the next one runs on the new one.
  await engine.send('lbolddefault', { messageId: 'm1', content: 'Hi' });
  await waitFor(() => runner.lanes.length === 1);
  assert.equal(runner.lanes[0].lane.model, 'claude-opus-5-5');
  const switched = await engine.setModel('lbolddefault', 'claude-sonnet-5-5');
  assert.equal(switched.model, 'claude-sonnet-5-5');
  runner.lanes[0].finish({ text: 'Hello.' });
  await engine.idle();
  await engine.send('lbolddefault', { messageId: 'm2', content: 'Still you?' });
  await waitFor(() => runner.lanes.length === 2);
  const next = runner.lanes[1].lane;
  assert.equal(next.model, 'claude-sonnet-5-5');
  // Same conversation: the earlier exchange is in the new reply's history.
  assert.deepEqual(next.session.history.map((row) => row.text), ['Hi', 'Hello.', 'Still you?']);
  runner.lanes[1].finish({ text: 'Yes.' });
  await engine.idle();
  await assert.rejects(engine.setModel('lbolddefault', 'gpt-9'), /Pick one of the bot models/);

  // Chosen survives a restart (it doesn't fall back to the default), and goes to Durango as a choice.
  const withEffort = await engine.setModel('lbolddefault', null, 'xhigh');
  assert.equal(withEffort.reasoningEffort, 'xhigh');
  await engine.send('lbolddefault', { messageId: 'm3', content: 'Think deeper' });
  await waitFor(() => runner.lanes.length === 3);
  assert.equal(runner.lanes[2].lane.reasoningEffort, 'xhigh');
  runner.lanes[2].finish({ text: 'Done.' });
  await engine.idle();

  await engine.stop();
  const again = makeEngine({ dir });
  const reloaded = (await again.engine.list()).bots.find((bot) => bot.id === 'lbolddefault');
  assert.equal(reloaded.model, 'claude-sonnet-5-5');
  assert.equal(reloaded.reasoningEffort, 'xhigh');
  const exported = (await again.engine.exportForSync()).bots;
  assert.equal(exported.find((bot) => bot.localId === 'lbolddefault').modelChosen, true);
  assert.equal(exported.find((bot) => bot.localId === 'lbolddefault').reasoningEffort, 'xhigh');
  assert.equal(exported.find((bot) => bot.localId === 'lbhaiku').modelChosen, false);
  await again.engine.stop();
});

test("models: only replies to the person moved to Opus; a bot's background runs stay on Sonnet until a model is chosen", async () => {
  const dir = path.join(testRoot, `bots-${(dirCount += 1)}`);
  await fs.mkdir(dir, { recursive: true });
  const stored = (id, role, extra) => ({ id, name: id, role, job: '', createdAt: 1, lastActivityAt: 1, ...extra });
  await fs.writeFile(
    path.join(dir, 'bots.json'),
    JSON.stringify({ version: 1, bots: [stored('lbprimary', 'primary', { model: 'claude-opus-5-5' }), stored('lbwork', 'bot', {}), stored('lbother', 'bot', {})] })
  );
  const { engine, runner } = makeEngine({ dir });
  // Answers whatever is still running (task reports wake the bot again) until it is quiet.
  const settle = async () => {
    for (let round = 0; round < 20; round += 1) {
      await delay(20);
      const open = runner.running();
      if (!open.length) break;
      for (const run of open) run.finish({ text: 'ok' });
    }
    await engine.idle();
  };
  await engine.list();
  await engine.send('lbwork', { messageId: 'w1', content: 'Plan my week' });
  await waitFor(() => runner.lanes.length === 1);
  const work = runner.lanes[0];
  assert.equal(work.lane.model, 'claude-opus-5-5', 'replies to the person: Opus');
  const call = (name, input) => work.ctx.callTool({ name, input, toolCallId: `t-${name}` }).then((out) => out.result);
  assert.equal((await call('delegate_task', { title: 'Research', instructions: 'Look things up.' })).ok, true);
  await waitFor(() => runner.lanes.length === 2, { label: 'task started' });
  assert.equal(runner.lanes[1].lane.model, 'claude-sonnet-5-5', 'a delegated task: Sonnet, as before');
  runner.lanes[1].finish({ text: 'Found it.' });
  assert.equal((await call('message_bot', { bot_id: 'lbother', message: 'Ping' })).ok, true);
  await waitFor(() => runner.lanes.some((run) => run.lane.botId === 'lbother'), { label: 'other bot wakes' });
  const otherWake = runner.lanes.find((run) => run.lane.botId === 'lbother');
  assert.equal(otherWake.lane.model, 'claude-sonnet-5-5', 'a bot-to-bot wake: Sonnet, as before');
  otherWake.finish({ text: 'Pong.' });
  work.finish({ text: 'On it.' });
  await settle();

  // Once the person picks a model, everything the bot runs uses it (as before).
  await engine.setModel('lbother', 'claude-haiku-5-5');
  const before = runner.lanes.length;
  await engine.send('lbwork', { messageId: 'w2', content: 'Tell Other again' });
  await waitFor(() => runner.lanes.length === before + 1);
  const work2 = runner.lanes[before];
  await work2.ctx.callTool({ name: 'message_bot', input: { bot_id: 'lbother', message: 'Ping again' }, toolCallId: 't2' });
  await waitFor(() => runner.lanes.slice(before + 1).some((run) => run.lane.botId === 'lbother'), { label: 'other bot wakes again' });
  const wake2 = runner.lanes.slice(before + 1).find((run) => run.lane.botId === 'lbother');
  assert.equal(wake2.lane.model, 'claude-haiku-5-5');
  wake2.finish({ text: 'Pong.' });
  work2.finish({ text: 'Done.' });
  await settle();
  await engine.stop();
});

test("models: a choice that can't be saved is reported and not kept", async () => {
  const { engine, dir } = makeEngine();
  const [primary] = (await engine.list()).bots;
  await engine.idle();
  await fs.chmod(dir, 0o500);
  try {
    await assert.rejects(engine.setModel(primary.id, 'claude-sonnet-5-5'), /Couldn’t save the model/);
  } finally {
    await fs.chmod(dir, 0o700);
  }
  assert.equal((await engine.list()).bots[0].model, 'claude-opus-5-5');
  await engine.stop();
});

test('notify_user and ask_user', async () => {
  const { engine, runner, notifications } = makeEngine();
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'hi' });
  await waitFor(() => runner.lanes.length === 1);
  const call = (name, input) => runner.lanes[0].ctx.callTool({ name, input, toolCallId: 'x' }).then((out) => out.result);
  assert.deepEqual(await call('notify_user', { title: 'Found a flat', message: '2BR in Surry Hills' }), { ok: true });
  const asked = await call('ask_user', { question: 'Which one?', options: ['A', 'B'] });
  assert.equal(asked.ok, true);
  assert.match(asked.note, /in your reply/);
  assert.equal((await engine.list()).bots[0].needsYou, true);
  assert.deepEqual(notifications, [
    { title: 'Durango: Found a flat', body: '2BR in Surry Hills' },
    { title: 'Durango needs you', body: 'Which one?' },
  ]);
  runner.lanes[0].finish({ text: 'Which one: A or B?' });
  await engine.idle();
  // The person's answer clears it.
  await engine.send(primary.id, { messageId: 'b', content: 'A' });
  assert.equal((await engine.list()).bots[0].needsYou, false);
  await waitFor(() => runner.lanes.length === 2);
  runner.lanes[1].finish({ text: 'A it is.' });
  await engine.idle();
});

test('delegate_task runs in the background and its report wakes the bot', async () => {
  const { engine, runner } = makeEngine();
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'Research flats in Sydney' });
  await waitFor(() => runner.lanes.length === 1);
  const result = (await runner.lanes[0].ctx.callTool({
    name: 'delegate_task',
    input: { title: 'Find flats', instructions: 'Find 5 two-bedroom flats in Sydney under $900/week.' },
    toolCallId: 't1',
  })).result;
  assert.equal(result.ok, true);
  assert.equal(result.status, 'running');
  await waitFor(() => runner.lanes.length === 2, { label: 'task lane' });
  const task = runner.lanes[1];
  assert.equal(task.lane.laneId, result.taskId);
  assert.deepEqual(task.lane.tools, []);
  assert.equal(task.lane.prompt, 'Find 5 two-bedroom flats in Sydney under $900/week.');
  assert.match(task.lane.systemPrompt, /You are running a task for a Durango bot/);
  assert.match(task.lane.systemPrompt, /The bot "Durango" handed you the task "Find flats"/);
  assert.deepEqual(await task.ctx.takeInbox(), []);
  runner.lanes[0].finish({ text: "On it: I've started a search." });
  await waitFor(() => runner.running().length === 1);
  // The bot's context lists the running task.
  await engine.send(primary.id, { messageId: 'b', content: 'how is it going?' });
  await waitFor(() => runner.lanes.length === 3);
  assert.match(runner.lanes[2].lane.prompt, new RegExp(`Your tasks still running: "Find flats" \\(${result.taskId}, started just now\\)`));
  runner.lanes[2].finish({ text: 'Still searching.' });
  await waitFor(() => runner.running().length === 1);

  task.finish({ text: 'Found 5 flats: …' });
  await waitFor(() => runner.lanes.length === 4, { label: 'reply to the task report' });
  const wake = runner.lanes[3];
  assert.match(wake.lane.prompt, /<new_messages>\n\[Task: Find flats\]:\nFound 5 flats: …\n<\/new_messages>/);
  assert.match(wake.lane.prompt, /1 task report/);
  assert.match(wake.lane.prompt, /The person didn't write this time/);
  wake.finish({ text: 'Found 5 flats for you.' });
  await engine.idle();
  const thread = await engine.thread(primary.id);
  const report = thread.messages.find((message) => message.authorLabel === 'Task: Find flats');
  assert.equal(report.role, 'user');
  assert.equal(report.content, 'Found 5 flats: …');
});

test('delegate_task with a project starts a Durango Code thread; its outcome is a task report', async () => {
  const started = [];
  const { engine, runner } = makeEngine({
    listProjects: async () => [{ id: 'proj_1', name: 'Durango', path: '/Users/me/projects/durango' }],
    startProjectThread: async (input) => {
      started.push(input);
      return { ok: true, threadId: 'thread_9' };
    },
  });
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'Why do signups fail? Check the code.' });
  await waitFor(() => runner.lanes.length === 1);
  assert.equal(runner.lanes[0].lane.threads, 'local', 'replies are told how to start threads');
  const call = (input) => runner.lanes[0].ctx.callTool({ name: 'delegate_task', input, toolCallId: 't' }).then((out) => out.result);

  const missing = await call({ title: 'Look', instructions: 'x', project: 'nope' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /No Durango Code project named "nope".*Projects: Durango/);

  const result = await call({ title: 'Debug signups', instructions: 'Find why signups fail.', project: 'durango' });
  assert.equal(result.ok, true);
  assert.equal(result.project, 'Durango');
  assert.equal(started.length, 1);
  assert.equal(started[0].projectId, 'proj_1');
  assert.equal(started[0].accessMode, 'auto-edit');
  assert.equal(started[0].key, `${primary.id}:${result.taskId}`);
  assert.match(started[0].prompt, /^Find why signups fail\.\n\nWhen you're done, end with a concise report/);
  assert.equal(runner.lanes.length, 1, 'no Claude task lane: the thread does the work');
  runner.lanes[0].finish({ text: 'On it: a thread is digging into the signup code.' });
  await waitFor(() => runner.running().length === 0);

  await engine.send(primary.id, { messageId: 'b', content: 'status?' });
  await waitFor(() => runner.lanes.length === 2);
  assert.match(runner.lanes[1].lane.prompt, new RegExp(`"Debug signups" \\(${result.taskId}, a Durango Code thread in Durango`));
  runner.lanes[1].finish({ text: 'Still on it.' });
  await waitFor(() => runner.running().length === 0);

  await engine.threadSettled({ key: started[0].key, threadId: 'thread_9', outcome: 'finished', summary: 'The Clerk webhook secret is wrong.' });
  await waitFor(() => runner.lanes.length === 3, { label: 'reply to the thread report' });
  assert.match(runner.lanes[2].lane.prompt, /\[Task: Debug signups\]:\nThe Clerk webhook secret is wrong\.\n\n\(Durango Code thread thread_9, project Durango\. Follow up there, e\.g\. to ship it, with message_thread thread_id "thread_9"\.\)/);
  runner.lanes[2].finish({ text: 'Found it.' });
  await engine.idle();
  assert.deepEqual(await engine.threadSettled({ key: 'gone:lt_x', outcome: 'failed' }), { ok: false });

  // The thread resumes by itself (say, a background check it waited on ended):
  // that turn's report reaches the bot too, as a later one.
  await engine.threadSettled({ key: started[0].key, threadId: 'thread_9', outcome: 'finished', summary: 'Fixed the secret; signups work.' });
  await waitFor(() => runner.lanes.length === 4, { label: 'reply to the later report' });
  assert.match(runner.lanes[3].lane.prompt, /\[Task: Debug signups\]:\nA later report from the thread, after its earlier one:\n\nFixed the secret; signups work\./);
  runner.lanes[3].finish({ text: 'Fixed.' });
  await engine.idle();
});

test('local bots: a thread whose turn ends while it still waits says so, and reports again when it finishes', async () => {
  const started = [];
  const { engine, runner } = makeEngine({
    listProjects: async () => [{ id: 'proj_1', name: 'Durango', path: '/Users/me/durango' }],
    startProjectThread: async (input) => {
      started.push(input);
      return { ok: true, threadId: 'thread_7' };
    },
  });
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'Release the app.' });
  await waitFor(() => runner.lanes.length === 1);
  const result = await runner.lanes[0].ctx
    .callTool({ name: 'delegate_task', input: { title: 'Release', instructions: 'Release it.', project: 'Durango' }, toolCallId: 't' })
    .then((out) => out.result);
  assert.equal(result.ok, true);
  runner.lanes[0].finish({ text: 'On it.' });
  await waitFor(() => runner.running().length === 0);

  await engine.threadSettled({
    key: started[0].key,
    threadId: 'thread_7',
    outcome: 'finished',
    summary: 'Watching the notarization.',
    waiting: ['background command: bun run deploy'],
  });
  await waitFor(() => runner.lanes.length === 2, { label: 'reply to the waiting report' });
  const prompt = runner.lanes[1].lane.prompt;
  assert.match(prompt, /\[Task: Release\]:\nNOT FINISHED YET: the thread ended its turn but still has work pending: background command: bun run deploy\. When that ends it resumes by itself and reports again/);
  assert.match(prompt, /What it said so far:\n\nWatching the notarization\./);
  assert.match(prompt, /Threads that reported but aren't finished \(still working in the background; each reports again when it is\): "Release" \(lt[^,]+, thread thread_7\)/);
  assert.doesNotMatch(prompt, /Your tasks still running/, 'a waiting thread holds no task slot');
  runner.lanes[1].finish({ text: 'Still releasing.' });
  await waitFor(() => runner.running().length === 0);

  await engine.threadSettled({ key: started[0].key, threadId: 'thread_7', outcome: 'finished', summary: 'Released 1.0.217.' });
  await waitFor(() => runner.lanes.length === 3, { label: 'reply to the final report' });
  assert.match(runner.lanes[2].lane.prompt, /\[Task: Release\]:\nA later report from the thread, after its earlier one:\n\nReleased 1\.0\.217\./);
  assert.doesNotMatch(runner.lanes[2].lane.prompt, /Threads that reported but aren't finished/);
  runner.lanes[2].finish({ text: 'Released.' });
  await engine.idle();
});

test('local bots: a running thread that needs the person tells the bot at once, once per notice', async () => {
  const started = [];
  const { engine, runner } = makeEngine({
    listProjects: async () => [{ id: 'proj_1', name: 'Durango', path: '/Users/me/durango' }],
    startProjectThread: async (input) => {
      started.push(input);
      return { ok: true, threadId: 'thread_3' };
    },
  });
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'Land the bot changes.' });
  await waitFor(() => runner.lanes.length === 1);
  await runner.lanes[0].ctx.callTool({ name: 'delegate_task', input: { title: 'Land bot changes', instructions: 'Land them.', project: 'Durango' }, toolCallId: 't' });
  runner.lanes[0].finish({ text: 'On it.' });
  await waitFor(() => runner.running().length === 0);

  const notice = { key: started[0].key, threadId: 'thread_3', kind: 'input', noticeKey: 'input:req-1', seq: 2, detail: 'It is waiting for the person to approve a Bash call in the thread (what the call does is shown there, not here).' };
  assert.deepEqual(await engine.threadNotice(notice), { ok: true });
  await waitFor(() => runner.lanes.length === 2, { label: 'reply to the notice' });
  const prompt = runner.lanes[1].lane.prompt;
  assert.match(prompt, /\[Task: Land bot changes\]:\nNEEDS THE PERSON: the task "Land bot changes" is blocked/);
  assert.match(prompt, /approve a Bash call/);
  assert.match(prompt, /message_thread thread_id "thread_3"/);
  assert.match(prompt, /Your tasks still running/, 'still a running task: a notice is not its report');
  runner.lanes[1].finish({ text: 'The thread needs you to approve a command.' });
  await waitFor(() => runner.running().length === 0);
  // The same notice again (a retry): nothing new.
  await engine.threadNotice(notice);
  await engine.idle();
  assert.equal(runner.lanes.length, 2);
  assert.deepEqual(await engine.threadNotice({ ...notice, kind: 'other' }), { ok: false });
  assert.deepEqual(await engine.threadNotice({ ...notice, key: 'gone:lt_x' }), { ok: false });

  // Its turn reports (seq 2); a notice about that turn arriving after it is dropped.
  await engine.threadSettled({ key: started[0].key, threadId: 'thread_3', outcome: 'finished', summary: 'Landed.', seq: 2 });
  await waitFor(() => runner.lanes.length === 3, { label: 'reply to the report' });
  runner.lanes[2].finish({ text: 'Landed.' });
  await waitFor(() => runner.running().length === 0);
  assert.deepEqual(await engine.threadNotice({ ...notice, noticeKey: 'input:late' }), { ok: true, stale: true });
  await engine.idle();
  assert.equal(runner.lanes.length, 3, 'no reply to a stale notice');
  assert.ok(!(await engine.thread((await engine.list()).bots[0].id)).messages.some((message) => /input_late/.test(message.id ?? '')));
  // A turn the thread resumes by itself (seq 4) still notifies.
  assert.deepEqual(await engine.threadNotice({ ...notice, noticeKey: 'input:next', seq: 4 }), { ok: true });
  await waitFor(() => runner.lanes.length === 4, { label: 'reply to the resumed turn\'s notice' });
  runner.lanes[3].finish({ text: 'Again.' });
  await waitFor(() => runner.running().length === 0);
});

test('local bots: a notice is acknowledged only once it is saved; a retry saves it', async () => {
  const dir = path.join(testRoot, `bots-notice-readonly-${Date.now()}`);
  const started = [];
  const { engine, runner } = makeEngine({
    dir,
    listProjects: async () => [{ id: 'proj_1', name: 'Durango', path: '/Users/me/durango' }],
    startProjectThread: async (input) => {
      started.push(input);
      return { ok: true, threadId: 'thread_4' };
    },
  });
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'Release it.' });
  await waitFor(() => runner.lanes.length === 1);
  await runner.lanes[0].ctx.callTool({ name: 'delegate_task', input: { title: 'Release', instructions: 'Release it.', project: 'Durango' }, toolCallId: 't' });
  runner.lanes[0].finish({ text: 'On it.' });
  await waitFor(() => runner.running().length === 0);
  await engine.flush();
  const notice = { key: started[0].key, threadId: 'thread_4', kind: 'input', noticeKey: 'input:r9', seq: 2, detail: 'It asked the person:\n- Which environment?' };
  // The bots folder can't be written to: not acknowledged, so the desktop sends it again.
  await fs.chmod(dir, 0o500);
  try {
    assert.deepEqual(await engine.threadNotice(notice), { ok: false, retry: true });
    // The retry while it still can't save: the message is in memory, not on disk; still not acknowledged.
    assert.deepEqual(await engine.threadNotice(notice), { ok: false, retry: true });
  } finally {
    await fs.chmod(dir, 0o700);
  }
  // The retry once it can: the message it already holds is saved, then acknowledged.
  assert.deepEqual(await engine.threadNotice(notice), { ok: true });
  await waitFor(() => runner.lanes.length >= 2, { label: 'reply to the notice' });
  for (const lane of runner.lanes.slice(1)) if (!lane.done) lane.finish({ text: 'Noted.' });
  await waitFor(() => runner.running().length === 0);
  await engine.stop();
  const reloaded = makeEngine({ dir });
  const thread = await reloaded.engine.thread((await reloaded.engine.list()).bots[0].id);
  assert.ok(thread.messages.some((message) => /NEEDS THE PERSON: the task "Release"/.test(message.content)), 'on disk');
  await reloaded.engine.stop();
});

test('project bots: one per project, notes and files in their instructions and in threads they start', async () => {
  const started = [];
  const { engine, runner } = makeEngine({
    listProjects: async () => [{ id: 'proj_1', name: 'Site', path: '/Users/me/site' }],
    startProjectThread: async (input) => {
      started.push(input);
      return { ok: true, threadId: 'thread_1' };
    },
  });
  const bot = await engine.ensureProjectBot({ name: 'Site', projectId: 'proj_1', machineId: 'this-device' });
  assert.equal(bot.name, 'Site');
  assert.deepEqual(bot.project, { key: 'local:this-device:proj_1', name: 'Site', repoId: null });
  assert.equal((await engine.ensureProjectBot({ name: 'Site', projectId: 'proj_1', machineId: 'this-device' })).id, bot.id, 'one bot per project');
  const viaRepo = await engine.ensureProjectBot({ name: 'Other', projectId: 'proj_2', repoId: 'repo_9' });
  assert.equal(viaRepo.project.key, 'repo:repo_9');

  await engine.addProjectNote(bot.id, 'Deploys go through durango-code land.');
  assert.deepEqual(await engine.addProjectNote(bot.id, 'deploys go through durango-code land.'), { ok: true, duplicate: true });
  await engine.saveProjectFile(bot.id, { name: 'plan.md', bytes: Buffer.from('# Plan\nShip it.') });
  const project = await engine.project(bot.id);
  assert.deepEqual(project.notes.map((note) => [note.content, note.author]), [['Deploys go through durango-code land.', 'you']]);
  assert.deepEqual(project.files.map((file) => [file.name, file.size, file.contentType]), [['plan.md', 15, 'text/markdown']]);

  await engine.send(bot.id, { messageId: 'a', content: 'What do we know about the site?' });
  await waitFor(() => runner.lanes.length === 1);
  const lane = runner.lanes[0];
  assert.match(lane.lane.systemPrompt, /## Your project: Site/);
  assert.match(lane.lane.systemPrompt, /Project notes \(oldest first\):\n- Deploys go through durango-code land\./);
  assert.match(lane.lane.systemPrompt, /Project files \(read_project_file\): plan\.md/);
  const call = (name, input) => lane.ctx.callTool({ name, input, toolCallId: 't' }).then((out) => out.result);
  assert.equal((await call('read_project_file', { name: 'PLAN.md' })).content, '# Plan\nShip it.');
  assert.equal((await call('remember_project', { note: 'The site runs on Next.js.' })).ok, true);
  assert.equal((await call('save_project_file', { name: 'notes.txt', content: 'hello' })).ok, true);
  const listed = await call('project_notes', {});
  assert.deepEqual(listed.notes.map((note) => note.by), ['you', 'Site']);
  assert.deepEqual(listed.files.map((file) => file.name), ['plan.md', 'notes.txt']);
  assert.equal((await call('project_notes', { project: 'Other' })).project, 'Other', 'any project by name');

  const task = await call('delegate_task', { title: 'Upgrade Next', instructions: 'Upgrade Next.js.', project: 'Site' });
  assert.equal(task.ok, true);
  // The brief alone: the thread reads the project's notes itself (project_notes).
  assert.match(started[0].prompt, /^Upgrade Next\.js\.\n\nWhen you're done/);
  assert.doesNotMatch(started[0].prompt, /Project notes|Deploys go through/);
  lane.finish({ text: 'Upgrading.' });
  await engine.idle();

  const exported = await engine.exportForSync();
  const site = exported.bots.find((item) => item.localId === bot.id);
  assert.deepEqual(site.project, { name: 'Site', machineId: 'this-device', projectId: 'proj_1' });
  // Libraries go up by project key (with or without a bot).
  assert.deepEqual(exported.projects, [
    { key: 'local:this-device:proj_1', name: 'Site', notes: ['Deploys go through durango-code land.', 'The site runs on Next.js.'] },
  ]);
  const files = await engine.projectFilesForSync();
  assert.deepEqual(files.map((item) => [item.key, item.files.map((file) => file.name)]), [['local:this-device:proj_1', ['plan.md', 'notes.txt']]]);
});

test('unanswered messages are exported as pending (Durango answers them after the upload)', async () => {
  const { engine, runner } = makeEngine();
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'first' });
  await waitFor(() => runner.lanes.length === 1);
  runner.lanes[0].finish({ text: 'answered' });
  await engine.idle();
  await engine.send(primary.id, { messageId: 'b', content: 'still waiting' });
  await waitFor(() => runner.lanes.length === 2);
  const exported = await engine.exportForSync();
  const messages = exported.bots.find((item) => item.localId === primary.id).messages;
  assert.deepEqual(messages.map((message) => [message.content, message.pending === true]), [
    ['first', false],
    ['answered', false],
    ['still waiting', true],
  ]);
  runner.lanes[1].finish({ text: 'ok' });
  await engine.idle();
});

test('a project library without a bot is exported for sign-in too', async () => {
  const { engine } = makeEngine();
  const project = { key: 'repo:repo_lib', name: 'Lib' };
  await engine.addProjectNoteByKey(project, 'Only a note, no bot.');
  await engine.saveProjectFileByKey(project, { name: 'spec.md', bytes: Buffer.from('# Spec') });
  assert.equal(await engine.hasDataToSync(), true);
  const exported = await engine.exportForSync();
  assert.deepEqual(exported.projects, [{ key: 'repo:repo_lib', name: 'Lib', notes: ['Only a note, no bot.'] }]);
  assert.deepEqual((await engine.projectFilesForSync()).map((item) => item.key), ['repo:repo_lib']);
});

test('a reply interrupted by a crash or a stop answers its messages next time', async () => {
  const dir = path.join(testRoot, `bots-crash-${Date.now()}`);
  const first = makeEngine({ dir });
  const [primary] = (await first.engine.list()).bots;
  await first.engine.send(primary.id, { messageId: 'a', content: 'Are you there?' });
  await waitFor(() => first.runner.lanes.length === 1);
  await first.engine.flush();
  // Crash: the reply never finishes and nothing else is saved.
  const second = makeEngine({ dir });
  await second.engine.list();
  await waitFor(() => second.runner.lanes.length === 1, { label: 'the message answered after the crash' });
  assert.match(second.runner.lanes[0].lane.prompt, /<new_messages>\nPerson:\nAre you there\?\n<\/new_messages>/);
  // Stop (quit) mid-reply: the next start answers it too.
  await second.engine.stop();
  const third = makeEngine({ dir });
  await third.engine.list();
  await waitFor(() => third.runner.lanes.length === 1, { label: 'the message answered after a stop' });
  third.runner.lanes[0].finish({ text: 'Yes!' });
  await third.engine.idle();
  const thread = await third.engine.thread(primary.id);
  assert.deepEqual(thread.messages.map((message) => message.content), ['Are you there?', 'Yes!']);
  assert.equal((await third.engine.thread(primary.id)).bot.status, 'idle');
});

test('claims are saved with the messages they name: a stale index never loses a message', async () => {
  const dir = path.join(testRoot, `bots-claims-${Date.now()}`);
  const first = makeEngine({ dir });
  const [primary] = (await first.engine.list()).bots;
  await first.engine.send(primary.id, { messageId: 'a', content: 'Still there?' });
  await waitFor(() => first.runner.lanes.length === 1);
  await first.engine.flush();
  // The index says everything was answered (written after a reply whose
  // transcript never landed): the transcript's own claim state wins.
  const indexFile = path.join(dir, 'bots.json');
  const index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  index.bots = index.bots.map((bot) => ({ ...bot, processedSeq: 99, inFlight: [], requeue: [] }));
  await fs.writeFile(indexFile, JSON.stringify(index));
  const second = makeEngine({ dir });
  await second.engine.list();
  await waitFor(() => second.runner.lanes.length === 1, { label: 'the message answered after the crash' });
  assert.match(second.runner.lanes[0].lane.prompt, /Still there\?/);
  await second.engine.stop();
});

test('a message counts as sent only once it is saved', async () => {
  const dir = path.join(testRoot, `bots-readonly-${Date.now()}`);
  const { engine } = makeEngine({ dir });
  const [primary] = (await engine.list()).bots;
  await engine.flush();
  // The bots folder can't be written to: send says so instead of "sent".
  await fs.chmod(dir, 0o500);
  try {
    await assert.rejects(engine.send(primary.id, { messageId: 'b', content: 'hello' }), /Couldn’t save your message/);
  } finally {
    await fs.chmod(dir, 0o700);
  }
  await engine.stop();
});

test('files sent to a signed-out bot are kept with the message and reach its reply', async () => {
  const { engine, runner, dir } = makeEngine();
  const [primary] = (await engine.list()).bots;
  const source = path.join(dir, '..', `attach-${Date.now()}.txt`);
  await fs.writeFile(source, 'hello file');
  await engine.send(primary.id, { messageId: 'f1', content: 'Read this', files: [{ path: source, name: 'brief.txt' }] });
  await waitFor(() => runner.lanes.length === 1);
  const lane = runner.lanes[0].lane;
  assert.match(lane.prompt, /\[attached file: brief\.txt\]/);
  assert.equal(lane.attachments.length, 1);
  assert.equal(await fs.readFile(lane.attachments[0].path, 'utf8'), 'hello file', 'a copy in the bots folder');
  const thread = await engine.thread(primary.id);
  assert.deepEqual(thread.messages[0].files, [{ name: 'brief.txt', size: 10, path: lane.attachments[0].path }], 'with its path here');
  runner.lanes[0].finish({ text: 'Got it.' });
  await engine.idle();
  await engine.stop();
});

test('a signed-out reply keeps its files and cards (show_html, show_actions)', async () => {
  const { engine, runner, dir } = makeEngine();
  const [primary] = (await engine.list()).bots;
  const shot = path.join(dir, '..', `shot-${Date.now()}.png`);
  await fs.writeFile(shot, 'png bytes');
  await engine.send(primary.id, { messageId: 'r1', content: 'Show me the screenshot' });
  await waitFor(() => runner.lanes.length === 1);
  const { ctx } = runner.lanes[0];
  const page = await ctx.callTool({ name: 'show_html', input: { title: 'Flow', html: '<p>hi</p>', height: 'sm' } });
  assert.deepEqual(page.result, { ok: true, shown: 'html' });
  const bad = await ctx.callTool({ name: 'show_actions', input: { actions: [{ kind: 'open_url', url: 'javascript:alert(1)', label: 'x' }] } });
  assert.equal(bad.result.ok, false, 'an unsafe link is refused');
  await ctx.callTool({
    name: 'show_actions',
    input: {
      actions: [
        { kind: 'reply', label: 'Looks good' },
        { kind: 'open_thread', thread_id: 'thr-1' },
        { kind: 'open_change', change_id: 'nope' },
        // Ship keeps the thread that made the change: that thread ships it.
        { kind: 'ship_change', change_id: 'chg_abcdefgh12', thread_id: 'thr-1' },
      ],
    },
  });
  runner.lanes[0].finish({ text: 'Here it is.', files: [{ path: shot, name: 'shot.png', size: 9 }] });
  await engine.idle();
  const thread = await engine.thread(primary.id);
  const reply = thread.messages.find((message) => message.role === 'assistant');
  assert.equal(reply.content, 'Here it is.');
  assert.equal(reply.files.length, 1);
  assert.equal(reply.files[0].name, 'shot.png');
  assert.equal(reply.files[0].contentType, 'image/png');
  assert.equal(await fs.readFile(reply.files[0].path, 'utf8'), 'png bytes', 'a copy in the bots folder');
  assert.deepEqual(
    reply.cards.map((card) => [card.component, card.props]),
    [
      ['html', { title: 'Flow', html: '<p>hi</p>', height: 'sm' }],
      [
        'bot-actions',
        {
          actions: [
            { kind: 'reply', label: 'Looks good' },
            { kind: 'open_thread', thread_id: 'thr-1' },
            { kind: 'ship_change', change_id: 'chg_abcdefgh12', thread_id: 'thr-1' },
          ],
        },
      ],
    ]
  );
  // The next reply knows what this one showed.
  await engine.send(primary.id, { messageId: 'r2', content: 'Thanks' });
  await waitFor(() => runner.lanes.length === 2);
  assert.match(runner.lanes[1].lane.prompt, /\[attached file: shot\.png\]\n\[showed a page "Flow"\]\n\[showed buttons\]/);
  runner.lanes[1].finish({ text: 'Anytime.' });
  await engine.idle();
  await engine.stop();
});

test('a reply with files is live or stored at every moment while its files copy (a poll never skips it)', async () => {
  const { engine, runner, dir } = makeEngine();
  const [primary] = (await engine.list()).bots;
  // Big enough that the copy spans several polls.
  const big = path.join(dir, '..', `big-${Date.now()}.png`);
  await fs.writeFile(big, Buffer.alloc(48 * 1024 * 1024, 1));
  await engine.send(primary.id, { messageId: 'p1', content: 'show me' });
  await waitFor(() => runner.lanes.length === 1);
  runner.lanes[0].ctx.update({ text: 'Here it is.' });
  const replyId = (await engine.thread(primary.id)).live[0].messageId;
  runner.lanes[0].finish({ text: 'Here it is.', files: [{ path: big, name: 'big.png', size: 1 }] });
  let polls = 0;
  for (;;) {
    const thread = await engine.thread(primary.id);
    const stored = thread.messages.some((message) => message.id === replyId);
    const live = thread.live.some((reply) => reply.messageId === replyId);
    assert.ok(stored || live, `poll ${polls}: the reply is neither live nor stored`);
    if (stored) break;
    polls += 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await engine.idle();
  const reply = (await engine.thread(primary.id)).messages.find((message) => message.id === replyId);
  assert.equal(reply.files.length, 1, 'its file was copied');
  await fs.rm(big, { force: true });
  await engine.stop();
});

test('a message sent after a reply showed text comes below that reply, also once stored', async () => {
  const { engine, runner } = makeEngine();
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'Look at this.' });
  await waitFor(() => runner.lanes.length === 1);
  runner.lanes[0].ctx.update({ text: 'Looking at the screenshot.' });
  await engine.send(primary.id, { messageId: 'b', content: 'also the prompt box' });
  runner.lanes[0].finish({ text: 'Looking at the screenshot. Done.' });
  await waitFor(async () => (await engine.thread(primary.id)).messages.length === 3);
  const thread = await engine.thread(primary.id);
  assert.deepEqual(thread.messages.map((message) => message.content), ['Look at this.', 'Looking at the screenshot. Done.', 'also the prompt box']);
  await engine.stop();
});

test('projects get no bot on their own: create_bot with a project makes it; notes work without a bot', async () => {
  const { engine, runner } = makeEngine({
    listProjects: async () => [{ id: 'proj_7', name: 'Shop', path: '/Users/me/shop', repoId: 'repo_shop' }],
  });
  const [primary] = (await engine.list()).bots;
  assert.equal((await engine.list()).bots.length, 1, 'only the main bot');
  // Notes and files by the project's key, before it has a bot.
  const project = { key: 'repo:repo_shop', name: 'Shop' };
  await engine.addProjectNoteByKey(project, 'Prices are in AUD.');
  assert.deepEqual((await engine.projectByKey(project)).notes.map((note) => note.content), ['Prices are in AUD.']);
  assert.equal((await engine.projectByKey(project)).botId, null);

  await engine.send(primary.id, { messageId: 'a', content: 'Give the shop project a bot' });
  await waitFor(() => runner.lanes.length === 1);
  const call = (name, input) => runner.lanes[0].ctx.callTool({ name, input, toolCallId: 't' }).then((out) => out.result);
  const made = await call('create_bot', { project: 'shop' });
  assert.equal(made.ok, true);
  assert.equal(made.name, 'Shop');
  // Projects can have multiple bots: creating another for the same project creates a distinct bot.
  const second = await call('create_bot', { project: 'Shop', name: 'Checkout QA', job: 'You test checkout flows.' });
  assert.equal(second.ok, true);
  assert.notEqual(second.botId, made.botId, 'multiple bots per project');
  assert.equal(second.name, 'Checkout QA');
  const third = await call('create_bot', { project: 'Shop' });
  assert.equal(third.ok, true);
  assert.notEqual(third.botId, made.botId);
  assert.notEqual(third.botId, second.botId);
  assert.equal(third.name, 'Shop 2', 'default numbered name when project already has a bot');
  const bot = (await engine.list()).bots.find((item) => item.id === made.botId);
  const secondBot = (await engine.list()).bots.find((item) => item.id === second.botId);
  assert.deepEqual(bot.project, { key: 'repo:repo_shop', name: 'Shop', repoId: 'repo_shop' });
  assert.deepEqual(secondBot.project, { key: 'repo:repo_shop', name: 'Shop', repoId: 'repo_shop' });
  assert.equal(bot.emoji, null, 'a robot face, no emoji');
  assert.equal((await engine.projectByKey(project)).botId, made.botId, 'the notes are now its project\'s');
  assert.equal((await call('remember_project', { note: 'Ships on Fridays.', project: 'Shop' })).ok, true);
  // Both project bots see the shared project notes.
  assert.deepEqual(
    (await engine.project(secondBot.id)).notes.map((note) => note.content).sort(),
    ['Prices are in AUD.', 'Ships on Fridays.']
  );
  // Direct createProjectBot API also creates additional bots for a project.
  const fourth = await engine.createProjectBot({ name: 'Shop', projectId: 'proj_7', repoId: 'repo_shop', botName: 'Release', emoji: '🚀' });
  assert.equal(fourth.name, 'Release');
  assert.equal(fourth.emoji, '🚀');
  assert.equal(fourth.project.key, 'repo:repo_shop');
  // Direct createBot API creates a standalone (projectless) bot with optional job and emoji.
  const scout = await engine.createBot({ name: 'X Reply Scout', job: 'Find high-signal posts to reply to.', emoji: '🔎' });
  assert.equal(scout.name, 'X Reply Scout');
  assert.equal(scout.job, 'Find high-signal posts to reply to.');
  assert.equal(scout.emoji, '🔎');
  assert.equal(scout.project, null);
  const minimal = await engine.createBot({ name: 'Quick Helper' });
  assert.equal(minimal.name, 'Quick Helper');
  assert.equal(minimal.job, '');
  assert.equal(minimal.emoji, null);
  assert.equal(minimal.project, null);
  await assert.rejects(() => engine.createBot({ name: '   ' }), /Enter a name for the bot/);
  assert.equal((await call('create_bot', { name: 'X' })).ok, false, 'a plain bot still needs a job');
  runner.lanes[0].finish({ text: 'Done.' });
  await engine.idle();
});

test('hasDataToSync includes newly created local projectless bots', async () => {
  const { engine } = makeEngine();
  assert.equal(await engine.hasDataToSync(), false);
  await engine.createBot({ name: 'News Digest', emoji: '🗞️' });
  assert.equal(await engine.hasDataToSync(), true);
});

test('thread tools: list and read threads, message_thread is a follow-up reported like a task', async () => {
  const followUps = [];
  const threadTools = {
    definitions: [],
    list: async (input) => ({ ok: true, threads: [{ id: 'thread_1', title: 'Fix spinner', project: input.project ?? 'Site' }] }),
    read: async (input) => ({ ok: true, transcript: `transcript of ${input.thread_id}` }),
    findThread: async (id) => {
      if (id !== 'thread_1') throw new Error(`No thread "${id}" in this computer's projects.`);
      return { entry: { id: 'thread_1', title: 'Fix spinner' } };
    },
  };
  const { engine, runner } = makeEngine({
    threadTools,
    startThreadFollowUp: async (input) => {
      followUps.push(input);
      return { ok: true };
    },
  });
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'Nudge the spinner thread' });
  await waitFor(() => runner.lanes.length === 1);
  const lane = runner.lanes[0];
  const call = (name, input) => lane.ctx.callTool({ name, input, toolCallId: 't' }).then((out) => out.result);
  assert.equal((await call('list_threads', { project: 'Site' })).threads[0].id, 'thread_1');
  assert.equal((await call('read_thread', { thread_id: 'thread_1' })).transcript, 'transcript of thread_1');
  assert.equal((await call('message_thread', { thread_id: 'nope', message: 'x' })).ok, false);
  const sent = await call('message_thread', { thread_id: 'thread_1', message: 'Use CR handling.' });
  assert.equal(sent.ok, true);
  assert.equal(followUps[0].threadId, 'thread_1');
  assert.equal(followUps[0].key, `${primary.id}:${sent.taskId}`);
  assert.match(followUps[0].prompt, /^Use CR handling\.\n\n\(From the bot "Durango"/);
  lane.finish({ text: 'Nudged it.' });
  await waitFor(() => runner.running().length === 0);
  await engine.threadSettled({ key: followUps[0].key, threadId: 'thread_1', outcome: 'finished', summary: 'Fixed.' });
  await waitFor(() => runner.lanes.length === 2, { label: 'reply to the follow-up report' });
  assert.match(runner.lanes[1].lane.prompt, /\[Task: Follow-up: Fix spinner\]:\nFixed\./);
  runner.lanes[1].finish({ text: 'Done.' });
  await engine.idle();
});

test('manage_thread: the bot manages any thread (settle, snooze, rename, …), with the rule in its prompt', async () => {
  const managed = [];
  const threadTools = {
    definitions: [],
    list: async () => ({ ok: true, threads: [] }),
    read: async () => ({ ok: true, transcript: '' }),
    findThread: async () => ({ entry: { id: 'thread_1', title: 'Fix spinner' } }),
    manage: async (input) => {
      managed.push(input);
      return { ok: true, threadId: input.thread_id, action: input.action };
    },
  };
  const { engine, runner } = makeEngine({ threadTools });
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'The spinner change landed, and snooze my other thread.' });
  await waitFor(() => runner.lanes.length === 1);
  const lane = runner.lanes[0];
  assert.match(lane.lane.systemPrompt, /Managing and settling threads \(manage_thread\)/);
  assert.ok(lane.lane.tools.some((tool) => tool.name === 'manage_thread'));
  const settled = (await lane.ctx.callTool({ name: 'manage_thread', input: { thread_id: 'thread_1', action: 'settle', reason: 'landed' }, toolCallId: 't1' })).result;
  const snoozed = (await lane.ctx.callTool({ name: 'manage_thread', input: { thread_id: 'thread_2', action: 'snooze' }, toolCallId: 't2' })).result;
  const legacy = (await lane.ctx.callTool({ name: 'settle_thread', input: { thread_id: 'thread_3' }, toolCallId: 't3' })).result;
  assert.equal(settled.ok, true);
  assert.equal(snoozed.ok, true);
  assert.equal(legacy.ok, true);
  assert.deepEqual(managed, [
    { thread_id: 'thread_1', action: 'settle', reason: 'landed' },
    { thread_id: 'thread_2', action: 'snooze' },
    { thread_id: 'thread_3', action: 'settle' },
  ]);
  lane.finish({ text: 'Done.' });
  await engine.idle();
});

test('local bots: delegate_task and message_thread support model, effort, access_mode, steer, and list_thread_models', async () => {
  const models = [
    { id: 'antigravity:gemini-4-neon', label: 'Gemini 4 Neon', slug: 'gemini-4-neon', providerId: 'antigravity', provider: 'Antigravity', efforts: ['low', 'medium', 'high'], available: true },
  ];
  const started = [];
  const followUps = [];
  const threadTools = {
    definitions: [],
    listModels: async () => ({ ok: true, total: 1, models: [{ id: 'antigravity:gemini-4-neon', label: 'Gemini 4 Neon', provider: 'Antigravity', efforts: ['low', 'medium', 'high'] }] }),
    list: async () => ({ ok: true, threads: [] }),
    read: async () => ({ ok: true, transcript: '' }),
    findThread: async () => ({ entry: { id: 'thread_1', title: 'Fix', modelId: 'antigravity:gemini-4-neon' } }),
    manage: async () => ({ ok: true }),
  };
  const { engine, runner } = makeEngine({
    listProjects: async () => [{ id: 'p1', name: 'Durango', path: '/x/durango' }],
    listModels: async () => models,
    threadTools,
    startProjectThread: async (input) => {
      started.push(input);
      return { ok: true, threadId: 't_gem', modelId: input.modelId, reasoningEffort: input.reasoningEffort, accessMode: input.accessMode };
    },
    startThreadFollowUp: async (input) => {
      followUps.push(input);
      return { ok: true, threadId: input.threadId, modelId: input.modelId, reasoningEffort: input.reasoningEffort };
    },
  });
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'Start on Gemini Neon high' });
  await waitFor(() => runner.lanes.length === 1);
  const call = (name, input) => runner.lanes[0].ctx.callTool({ name, input, toolCallId: 't' }).then((out) => out.result);
  assert.equal((await call('list_thread_models', {})).models[0].id, 'antigravity:gemini-4-neon');
  const bad = await call('delegate_task', { title: 'Bad', instructions: 'x', project: 'Durango', model: 'antigravity:gemini-4-neon', effort: 'ultra' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /takes effort low, medium, high/);
  const ok = await call('delegate_task', { title: 'Good', instructions: 'Fix it.', project: 'Durango', model: 'Gemini 4 Neon', effort: 'high', access_mode: 'workspace-write' });
  assert.equal(ok.ok, true);
  assert.equal(ok.model, 'antigravity:gemini-4-neon');
  assert.equal(ok.effort, 'high');
  assert.equal(started[0].modelId, 'antigravity:gemini-4-neon');
  assert.equal(started[0].reasoningEffort, 'high');
  assert.equal(started[0].accessMode, 'workspace-write');
  const steered = await call('message_thread', { thread_id: 'thread_1', message: 'Check tests.', steer: true });
  assert.equal(steered.ok, true);
  assert.equal(steered.steered, true);
  assert.equal(followUps[0].steer, true);
  const switched = await call('message_thread', { thread_id: 'thread_1', message: 'Now ship.', model: 'antigravity:gemini-4-neon', effort: 'medium' });
  assert.equal(switched.ok, true);
  assert.equal(followUps[1].modelId, 'antigravity:gemini-4-neon');
  assert.equal(followUps[1].reasoningEffort, 'medium');
  runner.lanes[0].finish({ text: 'Done.' });
  await engine.idle();
});

// --- routines ----------------------------------------------------------------------------

test('manage_routine and routine runs', async () => {
  const { engine, runner, timer, clock } = makeEngine();
  assert.equal(timer.timers.length, 1);
  assert.equal(timer.timers[0].ms, 60_000);
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'a', content: 'Remind me to stretch every 30 min' });
  await waitFor(() => runner.lanes.length === 1);
  const call = (name, input) => runner.lanes[0].ctx.callTool({ name, input, toolCallId: 'x' }).then((out) => out.result);
  const tooOften = await call('manage_routine', { action: 'create', title: 'Stretch', instructions: 'Remind to stretch.', schedule: { kind: 'interval', every_minutes: 5 } });
  assert.equal(tooOften.ok, false);
  assert.match(tooOften.error, /at least 15/);
  const created = await call('manage_routine', { action: 'create', title: 'Stretch', instructions: 'Remind the person to stretch.', schedule: { kind: 'interval', every_minutes: 30 } });
  assert.equal(created.ok, true);
  assert.equal(created.nextRunAt, new Date(clock.now + 30 * 60_000).toISOString());
  const once = await call('manage_routine', { action: 'create', title: 'Call mum', instructions: 'Remind about calling mum.', schedule: { kind: 'once', at: '2026-11-17T09:00:00' } });
  assert.equal(once.ok, true);
  const removed = await call('manage_routine', { action: 'create', title: 'Temp', instructions: 'x', schedule: { kind: 'daily', time: '25:00' } });
  assert.equal(removed.ok, false);
  const updated = await call('manage_routine', { action: 'update', routine_id: created.routineId, title: 'Stretch break' });
  assert.equal(updated.title, 'Stretch break');
  assert.equal((await call('manage_routine', { action: 'delete', routine_id: 'missing' })).ok, false);
  runner.lanes[0].finish({ text: 'Set: every 30 minutes.' });
  await engine.idle();

  // Not due yet: nothing happens.
  await timer.timers[0].fn();
  await engine.tickRoutines();
  assert.equal(runner.lanes.length, 1);

  clock.now += 31 * 60_000;
  await engine.tickRoutines();
  await waitFor(() => runner.lanes.length === 2, { label: 'routine reply' });
  const run = runner.lanes[1];
  assert.match(run.lane.prompt, /<new_messages>\n\[Routine: Stretch break\]:\nRemind the person to stretch\.\n<\/new_messages>/);
  assert.match(run.lane.prompt, /1 routine run/);
  run.finish({ text: 'Time to stretch!' });
  await engine.idle();

  // 09:00 once-routine fires once, then turns off.
  clock.now = Date.parse('2026-11-17T09:00:30');
  await engine.tickRoutines();
  await waitFor(() => runner.lanes.length === 3);
  assert.match(runner.lanes[2].lane.prompt, /\[Routine: Call mum\]/);
  runner.lanes[2].finish({ text: 'Reminders sent.' });
  await engine.idle();
  clock.now = Date.parse('2026-11-17T09:00:50');
  await engine.tickRoutines();
  await delay(5);
  assert.equal(runner.lanes.length, 3, 'the one-off routine ran once');
  clock.now = Date.parse('2026-11-17T09:01:10');
  await engine.tickRoutines();
  await waitFor(() => runner.lanes.length === 4, { label: 'next interval run' });
  assert.match(runner.lanes[3].lane.prompt, /\[Routine: Stretch break\]/);
  assert.doesNotMatch(runner.lanes[3].lane.prompt, /<new_messages>[\s\S]*Call mum[\s\S]*<\/new_messages>/);
  runner.lanes[3].finish({ text: 'Stretch!' });
  await engine.idle();

  // Inactive (signed in): the timer stops.
  engine.setActive(false);
  assert.equal(timer.timers[0].cleared, true);
});

test('daily next run (local time, chosen weekdays)', () => {
  const tuesdayMorning = new Date(2026, 10, 17, 8, 0).getTime(); // Tue 17 Nov 2026 08:00 local
  assert.equal(nextRunAfter({ kind: 'daily', localTime: '09:15', days: [0, 1, 2, 3, 4, 5, 6] }, tuesdayMorning), new Date(2026, 10, 17, 9, 15).getTime());
  assert.equal(nextRunAfter({ kind: 'daily', localTime: '07:00', days: [0, 1, 2, 3, 4, 5, 6] }, tuesdayMorning), new Date(2026, 10, 18, 7, 0).getTime());
  assert.equal(nextRunAfter({ kind: 'daily', localTime: '07:00', days: [1] }, tuesdayMorning), new Date(2026, 10, 23, 7, 0).getTime());
  assert.equal(nextRunAfter({ kind: 'once', at: tuesdayMorning - 1 }, tuesdayMorning), null);
});

// --- persistence, compaction and sync ------------------------------------------------------

test('persistence round trip', async () => {
  const dir = path.join(testRoot, 'persist');
  const first = makeEngine({ dir });
  const [primary] = (await first.engine.list()).bots;
  await first.engine.send(primary.id, { messageId: 'a', content: 'remember: I like tea' });
  await waitFor(() => first.runner.lanes.length === 1);
  const created = (await first.runner.lanes[0].ctx.callTool({
    name: 'create_bot',
    input: { name: 'Tea', job: 'You track tea.', routines: [{ title: 'Brew', instructions: 'Remind to brew.', schedule: { kind: 'interval', every_minutes: 60 } }] },
    toolCallId: 'c',
  })).result;
  first.runner.lanes[0].finish({ text: 'Noted.' });
  await first.engine.idle();
  await first.engine.stop();

  const files = (await fs.readdir(dir)).sort();
  // Each bot: a snapshot and the append-only log it names.
  assert.deepEqual(files.filter((file) => !file.endsWith('.log')), [`${created.botId}.json`, `${primary.id}.json`, 'bots.json'].sort());
  for (const id of [created.botId, primary.id]) {
    const snapshot = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8'));
    assert.equal(snapshot.version, 3);
    // (Created by the first save after the snapshot.)
    for (const file of files.filter((name) => name.startsWith(`${id}.`) && name.endsWith('.log'))) assert.equal(file, snapshot.log);
  }
  assert.equal(files.some((file) => file.endsWith('.tmp')), false);

  const second = makeEngine({ dir });
  const listed = await second.engine.list();
  assert.deepEqual(listed.bots.map((bot) => bot.name), ['Durango', 'Tea']);
  const thread = await second.engine.thread(primary.id);
  assert.deepEqual(thread.messages.map((message) => [message.seq, message.role, message.content]), [[1, 'user', 'remember: I like tea'], [2, 'assistant', 'Noted.']]);
  assert.equal(thread.bot.unread, 1);
  // Sequence numbers continue.
  assert.equal((await second.engine.send(primary.id, { messageId: 'b', content: 'hi again' })).seq, 3);
  await waitFor(() => second.runner.lanes.length === 1);
  assert.match(second.runner.lanes[0].lane.prompt, /<conversation_so_far>\nPerson:\nremember: I like tea\n\nDurango \(you\):\nNoted\.\n<\/conversation_so_far>/);
  assert.match(second.runner.lanes[0].lane.prompt, /The person's other bots:\n- Tea \(lb/);
  second.runner.lanes[0].finish({ text: 'Hi!' });
  await second.engine.idle();
  await second.engine.stop();
});

test('compaction folds older messages into the summary', async () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({ seq: index + 1, role: index % 2 ? 'assistant' : 'user', content: 'x'.repeat(8_000) }));
  const boundary = compactionBoundary(rows);
  assert.ok(boundary !== null && boundary < 30);
  assert.equal(rows[boundary].role, 'user', 'the kept part starts with a user message');
  assert.ok(rows.length - boundary >= 8);
  assert.equal(compactionBoundary(rows.slice(0, 5)), null);

  const calls = [];
  const summarize = async (input) => {
    calls.push(input);
    return 'The person likes long messages.';
  };
  const { engine, runner } = makeEngine({ summarize });
  const [primary] = (await engine.list()).bots;
  for (let index = 0; index < 12; index += 1) {
    await engine.send(primary.id, { messageId: `m${index}`, content: `${index} ${'y'.repeat(16_000)}` });
    await waitFor(() => runner.lanes.length === index + 1);
    runner.lanes[index].finish({ text: `ok ${index}` });
    await engine.idle();
  }
  assert.ok(calls.length >= 1, 'summarized');
  assert.equal(calls[0].model, 'claude-haiku-5-5');
  assert.match(calls[0].systemPrompt, /long-term memory/);
  assert.match(calls[0].prompt, /<previous_earlier>\(none yet\)<\/previous_earlier>/);
  assert.match(calls[0].prompt, /<previous_summary>\(none yet\)<\/previous_summary>/);
  await engine.send(primary.id, { messageId: 'last', content: 'and now?' });
  await waitFor(() => runner.lanes.length === 13);
  const lane = runner.lanes[12].lane;
  assert.match(lane.systemPrompt, /## Your earlier conversation with the person \(summary\)[\s\S]*The person likes long messages\./);
  assert.doesNotMatch(lane.prompt, /Person:\n0 y/, 'folded messages are left out');
  runner.lanes[12].finish({ text: 'fine' });
  await engine.idle();
  // Still stored in full (the cap is far away).
  assert.equal((await engine.thread(primary.id, { limit: 500 })).messages.length, 26);
});

test('exportForSync maps models and markSynced moves the data aside', async () => {
  assert.equal(durangoModelForLocalBot('claude-opus-5-5'), 'anthropic/claude-opus-5.5');
  assert.equal(durangoModelForLocalBot('claude-sonnet-5-5'), 'anthropic/claude-sonnet-5.5');
  assert.equal(durangoModelForLocalBot('claude-haiku-5-5'), 'anthropic/claude-haiku-5.5');
  assert.equal(durangoModelForLocalBot('weird'), 'anthropic/claude-opus-5.5');

  const { engine, runner, dir } = makeEngine();
  const [primary] = (await engine.list()).bots;
  assert.equal(await engine.hasDataToSync(), false, 'an untouched primary is nothing to upload');
  await engine.send(primary.id, { messageId: 'a', content: 'hello' });
  await waitFor(() => runner.lanes.length === 1);
  const created = (await runner.lanes[0].ctx.callTool({
    name: 'create_bot',
    input: { name: 'Gym', job: 'You plan workouts.', routines: [{ title: 'Plan', instructions: 'Plan the week.', schedule: { kind: 'daily', time: '06:00', days: [1] } }] },
    toolCallId: 'c',
  })).result;
  runner.lanes[0].finish({ text: 'Hi there.' });
  await engine.idle();
  assert.equal(await engine.hasDataToSync(), true);

  const payload = await engine.exportForSync();
  assert.equal(payload.bots.length, 2);
  const [main, gym] = payload.bots;
  assert.deepEqual(
    { localId: main.localId, name: main.name, emoji: main.emoji, role: main.role, model: main.model, summary: main.summary },
    { localId: primary.id, name: 'Durango', emoji: '✨', role: 'primary', model: 'anthropic/claude-opus-5.5', summary: null }
  );
  assert.deepEqual(main.messages.map(({ role, content, authorLabel }) => ({ role, content, authorLabel })), [
    { role: 'user', content: 'hello', authorLabel: null },
    { role: 'assistant', content: 'Hi there.', authorLabel: null },
  ]);
  assert.equal(typeof main.messages[0].createdAt, 'number');
  assert.equal(gym.localId, created.botId);
  assert.equal(gym.model, 'anthropic/claude-opus-5.5');
  assert.equal(gym.job, 'You plan workouts.');
  assert.deepEqual(gym.routines, [{ title: 'Plan', instructions: 'Plan the week.', schedule: { kind: 'daily', localTime: '06:00', days: [1], timeZone: 'Australia/Sydney' } }]);

  const { movedTo } = await engine.markSynced();
  assert.equal(path.dirname(movedTo), dir);
  assert.match(path.basename(movedTo), /^synced-/);
  const moved = (await fs.readdir(movedTo)).sort();
  assert.deepEqual(moved.filter((name) => !name.endsWith('.log')), [`${created.botId}.json`, `${primary.id}.json`, 'bots.json'].sort());
  // The transcript logs went with their snapshots.
  const named = await Promise.all([created.botId, primary.id].map(async (id) => JSON.parse(await fs.readFile(path.join(movedTo, `${id}.json`), 'utf8')).log));
  assert.ok(moved.some((name) => name.endsWith('.log')));
  for (const name of moved.filter((item) => item.endsWith('.log'))) assert.ok(named.includes(name), name);
  assert.deepEqual((await fs.readdir(dir)).filter((name) => !name.startsWith('synced-')), []);
  assert.equal(await engine.hasDataToSync(), false);
  // Signed out again later: a fresh primary.
  const listed = await engine.list();
  assert.equal(listed.bots.length, 1);
  assert.notEqual(listed.bots[0].id, primary.id);
  await engine.stop();
});

test('createClaudeOneShot: one turn, no tools, the result text', async () => {
  const calls = [];
  const sdk = {
    query: ({ prompt, options }) => {
      calls.push({ prompt, options });
      return (async function* () {
        yield { type: 'system', subtype: 'init', model: options.model };
        yield { type: 'result', subtype: 'success', is_error: false, result: '  The summary.  ' };
      })();
    },
  };
  const oneShot = createClaudeOneShot({ loadSdk: async () => sdk, resolveBinary: async () => '/bin/claude', env: () => ({ A: '1' }), cwd: '/tmp' });
  assert.equal(await oneShot({ model: 'claude-haiku-5-5', systemPrompt: 'Summarize.', prompt: 'text' }), 'The summary.');
  const { options } = calls[0];
  assert.equal(calls[0].prompt, 'text');
  assert.deepEqual(
    { model: options.model, systemPrompt: options.systemPrompt, tools: options.tools, maxTurns: options.maxTurns, persistSession: options.persistSession, cwd: options.cwd, bin: options.pathToClaudeCodeExecutable },
    { model: 'claude-haiku-5-5', systemPrompt: 'Summarize.', tools: [], maxTurns: 1, persistSession: false, cwd: '/tmp', bin: '/bin/claude' }
  );
  const failing = createClaudeOneShot({
    loadSdk: async () => ({
      query: () =>
        (async function* () {
          yield { type: 'result', subtype: 'error_max_turns', is_error: true, errors: [] };
        })(),
    }),
    env: () => ({}),
  });
  await assert.rejects(failing({ model: 'm', systemPrompt: 's', prompt: 'p' }), /error_max_turns/);
});

// --- long threads: transcript log and paging ----------------------------------------------

/** A bot whose transcript is a version 2 file (the format before the log) with `count` answered messages. */
const seedVersion2 = async (dir, count) => {
  const seeded = makeEngine({ dir });
  const [primary] = (await seeded.engine.list()).bots;
  await seeded.engine.stop();
  for (const name of await fs.readdir(dir)) if (name.endsWith('.log')) await fs.rm(path.join(dir, name));
  const messages = Array.from({ length: count }, (_, index) => ({
    id: `m${index + 1}`,
    seq: index + 1,
    role: index % 2 ? 'assistant' : 'user',
    content: `message ${index + 1} ${'x'.repeat(200)}`,
    authorLabel: null,
    createdAt: 1_700_000_000_000 + index,
  }));
  const claims = { nextSeq: count + 1, processedSeq: count, compactedThroughSeq: 0, requeue: [], inFlight: [] };
  await fs.writeFile(path.join(dir, `${primary.id}.json`), JSON.stringify({ version: 2, botId: primary.id, messages, claims }));
  return primary.id;
};
const logOf = async (dir, id) => JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8')).log;
const readLines = async (file) => (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('a version 2 transcript (2,000 messages) migrates to a snapshot and log with nothing lost', async () => {
  const dir = path.join(testRoot, `bots-migrate-${Date.now()}`);
  const id = await seedVersion2(dir, 2_000);
  const first = makeEngine({ dir });
  first.engine.setActive(false);
  let thread = await first.engine.thread(id, { limit: 50 });
  assert.equal(thread.messages.length, 50);
  assert.equal(thread.messages.at(-1).seq, 2_000);
  assert.equal(thread.hasMore, true);
  // Loading alone writes nothing: the version 2 file stays until a save.
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8')).version, 2);
  await first.engine.send(id, { messageId: 'new1', content: 'after the migration' });
  await first.engine.flush();
  const snapshot = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8'));
  assert.equal(snapshot.version, 3);
  assert.match(snapshot.log, new RegExp(`^${id}\\.[0-9a-f]{12}\\.log$`));
  await first.engine.stop();
  const second = makeEngine({ dir });
  second.engine.setActive(false);
  thread = await second.engine.thread(id, { limit: 500 });
  assert.equal(thread.messages.at(-1).content, 'after the migration');
  // Every message, all the way back.
  const seen = [];
  let before;
  for (;;) {
    const page = await second.engine.thread(id, { limit: 200, ...(before !== undefined ? { beforeSeq: before } : {}) });
    seen.unshift(...page.messages.map((message) => message.seq));
    if (!page.hasMore) break;
    before = page.messages[0].seq;
  }
  assert.equal(seen.length, 2_001);
  assert.deepEqual(seen.slice(0, 3), [1, 2, 3]);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  await second.engine.stop();
});

test('a save appends what changed instead of rewriting the transcript', async () => {
  const dir = path.join(testRoot, `bots-append-${Date.now()}`);
  const id = await seedVersion2(dir, 2_000);
  const { engine } = makeEngine({ dir });
  engine.setActive(false);
  await engine.send(id, { messageId: 'first', content: 'one' });
  await engine.flush();
  const snapshotFile = path.join(dir, `${id}.json`);
  const before = await fs.stat(snapshotFile);
  const log = path.join(dir, await logOf(dir, id));
  for (let index = 0; index < 20; index += 1) {
    await engine.send(id, { messageId: `more${index}`, content: `more ${index}` });
    await engine.flush();
  }
  const after = await fs.stat(snapshotFile);
  assert.equal(after.mtimeMs, before.mtimeMs, 'the snapshot is not rewritten');
  assert.equal(after.size, before.size);
  const lines = await readLines(log);
  assert.equal(lines.length, 20);
  // Each line: only the new message (and the claim state), never the history.
  for (const [index, line] of lines.entries()) {
    assert.deepEqual(line.add.map((message) => message.id), [`more${index}`]);
    assert.equal(line.drop, undefined);
    assert.equal(typeof line.claims.nextSeq, 'number');
  }
  assert.ok((await fs.stat(log)).size < 20 * 1_000, 'twenty small lines');
  // A save with nothing new writes nothing.
  await engine.markRead(id);
  await engine.flush();
  assert.equal((await readLines(log)).length, 20);
  await engine.stop();
});

test('a torn last log line (a crash mid-save) is dropped whole and the log keeps working', async () => {
  const dir = path.join(testRoot, `bots-torn-${Date.now()}`);
  const first = makeEngine({ dir });
  first.engine.setActive(false);
  const [primary] = (await first.engine.list()).bots;
  await first.engine.send(primary.id, { messageId: 'a', content: 'kept' });
  await first.engine.send(primary.id, { messageId: 'b', content: 'kept too' });
  await first.engine.stop();
  const log = path.join(dir, await logOf(dir, primary.id));
  await fs.appendFile(log, '{"add":[{"id":"c","seq":3,"role":"user","content":"half writ');
  const second = makeEngine({ dir });
  second.engine.setActive(false);
  let thread = await second.engine.thread(primary.id);
  assert.deepEqual(thread.messages.map((message) => message.content), ['kept', 'kept too']);
  assert.equal((await fs.readFile(log, 'utf8')).endsWith('\n'), true, 'the torn tail is cut off');
  await second.engine.send(primary.id, { messageId: 'd', content: 'after the crash' });
  await second.engine.stop();
  const third = makeEngine({ dir });
  third.engine.setActive(false);
  thread = await third.engine.thread(primary.id);
  assert.deepEqual(thread.messages.map((message) => message.content), ['kept', 'kept too', 'after the crash']);
  await third.engine.stop();
});

test('a long log is folded into a new snapshot; a stray old log is removed on load', async () => {
  const dir = path.join(testRoot, `bots-fold-${Date.now()}`);
  const first = makeEngine({ dir });
  first.engine.setActive(false);
  const [primary] = (await first.engine.list()).bots;
  await first.engine.flush();
  const firstLog = await logOf(dir, primary.id);
  for (let index = 0; index < TRANSCRIPT_LOG_MAX_LINES + 5; index += 1) {
    await first.engine.send(primary.id, { messageId: `n${index}`, content: `note ${index}` });
    await first.engine.flush();
  }
  const secondLog = await logOf(dir, primary.id);
  assert.notEqual(secondLog, firstLog, 'a new snapshot names a new log');
  const files = await fs.readdir(dir);
  assert.equal(files.includes(firstLog), false, 'the old log is removed');
  assert.ok((await readLines(path.join(dir, secondLog))).length < 10);
  await first.engine.stop();
  // A crash between a new snapshot and removing the old log leaves a stray.
  const stray = `${primary.id}.0123456789ab.log`;
  await fs.writeFile(path.join(dir, stray), `${JSON.stringify({ add: [{ id: 'ghost', seq: 1, role: 'user', content: 'ghost', createdAt: 0 }] })}\n`);
  const second = makeEngine({ dir });
  second.engine.setActive(false);
  const newest = await second.engine.thread(primary.id, { limit: 500 });
  const oldest = await second.engine.thread(primary.id, { limit: 500, beforeSeq: newest.messages[0].seq });
  const all = [...oldest.messages, ...newest.messages];
  assert.equal(all.length, TRANSCRIPT_LOG_MAX_LINES + 5);
  assert.equal(oldest.hasMore, false);
  assert.deepEqual([all[0].content, all.at(-1).content], ['note 0', `note ${TRANSCRIPT_LOG_MAX_LINES + 4}`]);
  assert.equal(all.some((message) => message.content === 'ghost'), false);
  assert.equal((await fs.readdir(dir)).includes(stray), false);
  await second.engine.stop();
});

test('thread pages: newest, before a seq (all the way back) and after a seq (new ones)', async () => {
  const dir = path.join(testRoot, `bots-pages-${Date.now()}`);
  const id = await seedVersion2(dir, 2_000);
  const { engine } = makeEngine({ dir });
  engine.setActive(false);
  const newest = await engine.thread(id, { limit: 40 });
  assert.deepEqual([newest.messages[0].seq, newest.messages.at(-1).seq, newest.hasMore], [1_961, 2_000, true]);
  const older = await engine.thread(id, { limit: 40, beforeSeq: 1_961 });
  assert.deepEqual([older.messages[0].seq, older.messages.at(-1).seq, older.hasMore], [1_921, 1_960, true]);
  const first = await engine.thread(id, { limit: 40, beforeSeq: 30 });
  assert.deepEqual([first.messages[0].seq, first.messages.at(-1).seq, first.hasMore], [1, 29, false]);
  // Nothing new since the newest page.
  const none = await engine.thread(id, { limit: 40, afterSeq: 2_000 });
  assert.deepEqual([none.messages.length, none.hasNewer], [0, false]);
  for (let index = 0; index < 3; index += 1) await engine.send(id, { messageId: `x${index}`, content: `new ${index}` });
  const fresh = await engine.thread(id, { limit: 2, afterSeq: 2_000 });
  assert.deepEqual([fresh.messages.map((message) => message.content), fresh.hasNewer], [['new 0', 'new 1'], true]);
  const rest = await engine.thread(id, { limit: 2, afterSeq: fresh.messages.at(-1).seq });
  assert.deepEqual([rest.messages.map((message) => message.content), rest.hasNewer], [['new 2'], false]);
  await engine.stop();
});


test('summary chain: compaction keeps a condensed earlier history next to the latest summary', async () => {
  // Pure parsing: tags, no tags (all summary, earlier kept), bounds.
  assert.deepEqual(parseCompaction('<earlier>\n- Nov 2: chose Sato\n</earlier>\n<summary>\nOpen: book Friday.\n</summary>', null), {
    earlier: '- Nov 2: chose Sato',
    summary: 'Open: book Friday.',
  });
  assert.deepEqual(parseCompaction('Just a summary.', '- older line'), { earlier: '- older line', summary: 'Just a summary.' });
  assert.deepEqual(parseCompaction('<earlier>(none yet)</earlier><summary>S</summary>', '- kept'), { earlier: '- kept', summary: 'S' });
  assert.equal(parseCompaction('   ', null), null);
  const long = parseCompaction(`<earlier>${'e'.repeat(20_000)}</earlier><summary>${'s'.repeat(50_000)}</summary>`, null);
  assert.ok(long.earlier.length <= EARLIER_HISTORY_MAX_CHARS && long.summary.length <= SUMMARY_MAX_CHARS, 'bounded');
  assert.equal(memorySection({ summary: null, earlier: 'x' }), null);

  const calls = [];
  const answers = [
    '<earlier>\n- Nov 17: the person said hi a lot.\n</earlier>\n<summary>\nThe person likes long messages.\n</summary>',
    '<earlier>\n- Nov 17: the person said hi a lot.\n- Nov 17: more long messages.\n</earlier>\n<summary>\nStill long messages.\n</summary>',
  ];
  const summarize = async (input) => {
    calls.push(input);
    return answers[Math.min(calls.length - 1, answers.length - 1)];
  };
  const { engine, runner } = makeEngine({ summarize });
  const [primary] = (await engine.list()).bots;
  let sent = 0;
  const say = async (text) => {
    await engine.send(primary.id, { messageId: `c${sent}`, content: text });
    sent += 1;
    await waitFor(() => runner.lanes.length === sent);
    runner.lanes[sent - 1].finish({ text: `ok ${sent}` });
    await engine.idle();
  };
  for (let index = 0; index < 12; index += 1) await say(`${index} ${'y'.repeat(16_000)}`);
  assert.equal(calls.length, 1, 'one compaction so far');
  for (let index = 0; index < 12 && calls.length < 2; index += 1) await say(`more ${index} ${'z'.repeat(16_000)}`);
  assert.equal(calls.length, 2, 'compacted again');
  assert.match(calls[1].prompt, /<previous_earlier>\n- Nov 17: the person said hi a lot\.\n<\/previous_earlier>/, 'the chain goes back in');
  assert.match(calls[1].prompt, /<previous_summary>\nThe person likes long messages\.\n<\/previous_summary>/);
  await engine.send(primary.id, { messageId: 'last', content: 'and now?' });
  await waitFor(() => runner.lanes.length === sent + 1);
  const { systemPrompt } = runner.lanes[sent].lane;
  assert.match(systemPrompt, /### Earlier history \(condensed\)\n\n- Nov 17: the person said hi a lot\.\n- Nov 17: more long messages\.\n\n### Recent conversation\n\nStill long messages\./);
  assert.match(systemPrompt, /search_history finds the older messages/);
  runner.lanes[sent].finish({ text: 'fine' });
  await engine.idle();
  const exported = await engine.exportForSync();
  assert.match(exported.bots[0].earlierSummary, /more long messages/, 'the chain is uploaded at sign-in');
});

test('search_history finds older messages by keywords and dates, newest first', async () => {
  const { engine, runner, clock } = makeEngine();
  const [primary] = (await engine.list()).bots;
  const day = (iso) => Date.parse(iso);
  const sends = [
    ['2026-11-10T09:00:00', 'Flight to Tokyo is JL 772, seat 31A.'],
    ['2026-11-12T09:00:00', 'Hotel in Tokyo: Park Hyatt, booking 99812.'],
    ['2026-11-15T09:00:00', 'Remind me about the dentist.'],
  ];
  for (const [index, [at, text]] of sends.entries()) {
    clock.now = day(at);
    await engine.send(primary.id, { messageId: `s${index}`, content: text });
    await waitFor(() => runner.lanes.length === index + 1);
    runner.lanes[index].finish({ text: `Noted (${index}).` });
    await engine.idle();
  }
  await engine.send(primary.id, { messageId: 'q', content: 'what was my seat?' });
  await waitFor(() => runner.lanes.length === 4);
  const call = (input) => runner.lanes[3].ctx.callTool({ name: 'search_history', input, toolCallId: 't' }).then((out) => out.result);
  const tokyo = await call({ query: 'tokyo' });
  assert.equal(tokyo.ok, true);
  assert.deepEqual(tokyo.results.map((item) => item.snippet), ['Hotel in Tokyo: Park Hyatt, booking 99812.', 'Flight to Tokyo is JL 772, seat 31A.']);
  assert.equal(tokyo.results[0].from, 'Person');
  assert.equal(tokyo.results[1].at, new Date(day('2026-11-10T09:00:00')).toISOString());
  assert.deepEqual((await call({ query: 'Tokyo seat' })).results.map((item) => item.seq), [1], 'every word must appear');
  assert.deepEqual((await call({ query: 'tokyo', from: '2026-11-11' })).results.length, 1, 'from a date');
  assert.deepEqual((await call({ query: 'tokyo', to: '2026-11-10' })).results.length, 1, 'to a date (the whole day)');
  assert.match((await call({ query: 'noted' })).results[0].from, /\(you\)$/, 'its own replies too');
  assert.match((await call({ query: 'kyoto' })).note, /Nothing matched/);
  assert.equal((await call({ query: 'a' })).ok, false);
  runner.lanes[3].finish({ text: '31A.' });
  await engine.idle();
});

test('lanes carry the structured conversation; a reply asking for compaction forces one', async () => {
  const calls = [];
  const summarize = async (input) => {
    calls.push(input);
    return '<earlier>\n- e\n</earlier>\n<summary>\ns\n</summary>';
  };
  const { engine, runner } = makeEngine({ summarize });
  const [primary] = (await engine.list()).bots;
  await engine.send(primary.id, { messageId: 'x1', content: 'first' });
  await waitFor(() => runner.lanes.length === 1);
  runner.lanes[0].finish({ text: 'one' });
  await engine.idle();
  await engine.send(primary.id, { messageId: 'x2', content: 'second', authorLabel: null });
  await waitFor(() => runner.lanes.length === 2);
  const { lane } = runner.lanes[1];
  assert.equal(lane.replyMessageId, lane.laneId, "the reply's message id");
  assert.deepEqual(lane.session.history.map((item) => [item.seq, item.role, item.text]), [[1, 'user', 'first'], [2, 'assistant', 'one'], [3, 'user', 'second']]);
  assert.equal(lane.session.history[2].id, 'x2');
  assert.deepEqual(lane.session.answering, [3]);
  assert.ok(lane.session.context.some((part) => part.steady && /no other bots/.test(part.text)), 'steady parts are marked');
  assert.ok(lane.session.context.some((part) => !part.steady && /This reply answers/.test(part.text)));
  runner.lanes[1].finish({ text: 'two' });
  await engine.idle();
  assert.equal(calls.length, 0, 'far below the trigger: no compaction');

  // ~30K tokens: under the normal trigger (40K), over the forced one (24K).
  for (let index = 0; index < 8; index += 1) {
    await engine.send(primary.id, { messageId: `y${index}`, content: 'w'.repeat(15_000) });
    await waitFor(() => runner.lanes.length === 3 + index);
    runner.lanes[2 + index].finish({ text: 'ok' });
    await engine.idle();
  }
  assert.equal(calls.length, 0);
  await engine.send(primary.id, { messageId: 'z', content: 'go' });
  await waitFor(() => runner.lanes.length === 11);
  runner.lanes[10].finish({ text: 'done', compact: true });
  await engine.idle();
  assert.equal(calls.length, 1, 'forced');
});

// --- rename, delete, and clear ---------------------------------------------------------------

test('rename updates a bot name and persists across reload; blank names are rejected', async () => {
  const dir = path.join(testRoot, `rename-${(dirCount += 1)}`);
  const { engine } = makeEngine({ dir });
  const [primary] = (await engine.list()).bots;
  const renamed = await engine.rename(primary.id, '  Captain Durango  ');
  assert.equal(renamed.name, 'Captain Durango');
  await assert.rejects(() => engine.rename(primary.id, '   '), /Enter a name/i);
  await engine.flush();

  const { engine: reloaded } = makeEngine({ dir });
  const [after] = (await reloaded.list()).bots;
  assert.equal(after.name, 'Captain Durango');
});

test('deleteBot deletes non-primary bots and their files, aborts active replies, and refuses primary', async () => {
  const dir = path.join(testRoot, `delete-${(dirCount += 1)}`);
  const { engine, runner } = makeEngine({ dir });
  const [primary] = (await engine.list()).bots;
  await assert.rejects(() => engine.deleteBot(primary.id), /primary/i);

  const projectBot = await engine.ensureProjectBot({ name: 'alpha', projectId: 'p1', repoId: 'r1' });
  await engine.send(projectBot.id, { messageId: 'd1', content: 'working on it' });
  await waitFor(() => runner.lanes.length === 1);
  assert.equal(runner.lanes[0].ctx.signal.aborted, false);

  await engine.deleteBot(projectBot.id);
  assert.equal(runner.lanes[0].ctx.signal.aborted, true, 'in-flight reply aborted on delete');
  await engine.idle();
  await engine.flush();

  const listed = (await engine.list()).bots;
  assert.deepEqual(listed.map((bot) => bot.id), [primary.id]);
  const files = await fs.readdir(dir);
  assert.equal(files.some((name) => name.startsWith(`${projectBot.id}.`)), false, 'transcript and logs removed');

  const { engine: reloaded } = makeEngine({ dir });
  assert.deepEqual((await reloaded.list()).bots.map((bot) => bot.id), [primary.id]);
});

test('clear wipes history and memory, rotates threadId, does not requeue aborted replies, and persists across reload', async () => {
  const dir = path.join(testRoot, `clear-${(dirCount += 1)}`);
  const { engine, runner } = makeEngine({ dir });
  const [primary] = (await engine.list()).bots;
  const originalThreadId = primary.threadId;
  assert.ok(originalThreadId, 'local bot has a threadId');

  await engine.send(primary.id, { messageId: 'c1', content: 'hello' });
  await waitFor(() => runner.lanes.length === 1);
  assert.equal(runner.lanes[0].lane.threadId, originalThreadId);
  runner.lanes[0].finish({ text: 'hi there' });
  await engine.idle();

  // Start a second reply and clear while it is still running.
  await engine.send(primary.id, { messageId: 'c2', content: 'in flight' });
  await waitFor(() => runner.lanes.length === 2);

  const cleared = await engine.clear(primary.id);
  assert.equal(runner.lanes[1].ctx.signal.aborted, true, 'in-flight reply aborted on clear');
  assert.notEqual(cleared.threadId, originalThreadId, 'threadId rotated');
  assert.equal(cleared.unread, 0);
  assert.equal(cleared.lastPreview, null);
  await engine.idle();
  await engine.flush();

  const thread = await engine.thread(primary.id);
  assert.equal(thread.messages.length, 0);
  assert.equal(thread.live.length, 0);
  assert.equal(runner.lanes.length, 2, 'aborted reply claims were not requeued');

  // Reload from disk and verify nothing came back, then send a fresh message.
  const { engine: reloaded, runner: runner2 } = makeEngine({ dir });
  const reloadedThread = await reloaded.thread(primary.id);
  assert.equal(reloadedThread.messages.length, 0);
  assert.equal(reloadedThread.bot.threadId, cleared.threadId);

  await reloaded.send(primary.id, { messageId: 'c3', content: 'fresh start' });
  await waitFor(() => runner2.lanes.length === 1);
  assert.equal(runner2.lanes[0].lane.threadId, cleared.threadId);
  assert.deepEqual(
    runner2.lanes[0].lane.session.history.map((item) => [item.seq, item.text]),
    [[1, 'fresh start']]
  );
  runner2.lanes[0].finish({ text: 'ready!' });
  await reloaded.idle();
});

// --- run -------------------------------------------------------------------------------------

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}
await fs.rm(testRoot, { recursive: true, force: true });
if (failed) {
  console.error(`${failed} of ${tests.length} failed`);
  process.exit(1);
}
console.log(`all ${tests.length} passed`);
