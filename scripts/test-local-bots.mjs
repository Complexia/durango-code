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
  compactionBoundary,
  createLocalBotEngine,
  durangoModelForLocalBot,
  nextRunAfter,
} from '../src/main/local-bots.js';
import { createClaudeOneShot } from '../src/main/bot-replies.js';

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
      'project_notes', 'read_bot', 'read_project_file', 'remember_project', 'save_project_file', 'show_actions', 'show_html',
      'update_bot',
    ]
  );

  run.ctx.update({ text: 'Checking SF weather now.', activeTool: 'WebSearch' });
  let thread = await engine.thread(primary.id);
  assert.equal(thread.bot.status, 'running');
  assert.deepEqual(thread.bot.replies, [{ messageId: run.lane.laneId, place: LOCAL_BOT_PLACE }]);
  assert.deepEqual(thread.live, [
    // It showed text, so it has its place (seq 2, after the message it answers).
    { messageId: run.lane.laneId, seq: 2, place: LOCAL_BOT_PLACE, content: 'Checking SF weather now.', activeTool: 'WebSearch' },
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
  assert.equal(newsRun.lane.model, 'claude-sonnet-5-5');
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
  assert.match(runner.lanes[2].lane.prompt, /\[Task: Debug signups\]:\nThe Clerk webhook secret is wrong\.\n\n\(From the Durango Code thread in Durango, thread_9\.\)/);
  runner.lanes[2].finish({ text: 'Found it.' });
  await engine.idle();
  assert.deepEqual(await engine.threadSettled({ key: 'gone:lt_x', outcome: 'failed' }), { ok: false });
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
  assert.match(started[0].prompt, /^\[Project notes: Site\]\n- Deploys go through durango-code land\.\n- The site runs on Next\.js\.\nProject files \(kept with the project\): plan\.md, notes\.txt\n\[\/Project notes\]\n\nUpgrade Next\.js\./);
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
    input: { actions: [{ kind: 'reply', label: 'Looks good' }, { kind: 'open_thread', thread_id: 'thr-1' }, { kind: 'open_change', change_id: 'nope' }] },
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
      ['bot-actions', { actions: [{ kind: 'reply', label: 'Looks good' }, { kind: 'open_thread', thread_id: 'thr-1' }] }],
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
  const again = await call('create_bot', { project: 'Shop' });
  assert.equal(again.botId, made.botId, 'one bot per project');
  assert.match(again.note, /already has this bot/);
  const bot = (await engine.list()).bots.find((item) => item.id === made.botId);
  assert.deepEqual(bot.project, { key: 'repo:repo_shop', name: 'Shop', repoId: 'repo_shop' });
  assert.equal(bot.emoji, null, 'a robot face, no emoji');
  assert.equal((await engine.projectByKey(project)).botId, made.botId, 'the notes are now its project\'s');
  assert.equal((await call('remember_project', { note: 'Ships on Fridays.', project: 'Shop' })).ok, true);
  assert.equal((await call('create_bot', { name: 'X' })).ok, false, 'a plain bot still needs a job');
  runner.lanes[0].finish({ text: 'Done.' });
  await engine.idle();
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
  assert.deepEqual(files, [`${created.botId}.json`, `${primary.id}.json`, 'bots.json'].sort());
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
  assert.match(calls[0].systemPrompt, /long-term working summary/);
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
  assert.equal(durangoModelForLocalBot('weird'), 'anthropic/claude-sonnet-5.5');

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
  assert.equal(gym.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(gym.job, 'You plan workouts.');
  assert.deepEqual(gym.routines, [{ title: 'Plan', instructions: 'Plan the week.', schedule: { kind: 'daily', localTime: '06:00', days: [1], timeZone: 'Australia/Sydney' } }]);

  const { movedTo } = await engine.markSynced();
  assert.equal(path.dirname(movedTo), dir);
  assert.match(path.basename(movedTo), /^synced-/);
  assert.deepEqual((await fs.readdir(movedTo)).sort(), [`${created.botId}.json`, `${primary.id}.json`, 'bots.json'].sort());
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
