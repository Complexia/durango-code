// Long bot threads (src/app/botThreadWindow.ts): merging pages without
// redrawing unchanged messages, the poll cursor, and the mounted window.
//
//   node --no-warnings scripts/test-bot-thread-window.mjs
import assert from 'node:assert/strict';

import {
  BOT_WINDOW_INITIAL,
  BOT_WINDOW_MAX,
  BOT_WINDOW_STEP,
  botPollCursor,
  botWindowRange,
  botWindowStep,
  mergeBotMessages,
} from '../src/app/botThreadWindow.ts';
import { botShipRequestText, parseBotAction, resolveThreadStarter, taskReportActions, taskReportBody } from '../src/app/bots.ts';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const message = (seq, extra = {}) => ({ id: `m${seq}`, seq, role: seq % 2 ? 'assistant' : 'user', content: `message ${seq}`, authorLabel: null, createdAt: seq, ...extra });
const range = (from, to) => Array.from({ length: to - from }, (_, index) => from + index);

/** A thread on "the server": pages like bots.threadForService / localBots.thread. */
const server = (count) => {
  const rows = range(1, count + 1).map((seq) => message(seq));
  return {
    rows,
    page({ limit, beforeSeq, afterSeq }) {
      if (afterSeq !== undefined) {
        const after = rows.filter((row) => row.seq > afterSeq);
        return { messages: after.slice(0, limit).map((row) => ({ ...row })), hasMore: false, hasNewer: after.length > limit };
      }
      const before = beforeSeq === undefined ? rows : rows.filter((row) => row.seq < beforeSeq);
      // Fresh objects, like JSON over IPC.
      return { messages: before.slice(-limit).map((row) => ({ ...row })), hasMore: before.length > limit };
    },
  };
};

test('merging a page keeps unchanged messages as the same objects (no redraw)', () => {
  const shown = range(1, 41).map((seq) => message(seq));
  const same = mergeBotMessages(shown, shown.map((row) => ({ ...row })));
  assert.equal(same, shown, 'nothing changed: the same array');
  const withNew = mergeBotMessages(shown, [message(41), { ...message(40) }]);
  assert.equal(withNew.length, 41);
  assert.equal(withNew[39], shown[39], 'unchanged rows keep their objects');
  assert.equal(withNew[40].seq, 41);
  const edited = mergeBotMessages(shown, [{ ...message(10), content: 'edited' }]);
  assert.notEqual(edited[9], shown[9]);
  assert.equal(edited[9].content, 'edited');
  assert.equal(edited[8], shown[8]);
  assert.equal(mergeBotMessages(shown, []), shown);
  assert.equal(mergeBotMessages(shown, undefined), shown);
  // Files: the same names and sizes are the same message.
  const withFiles = [message(1, { files: [{ name: 'a.png', size: 3 }] })];
  assert.equal(mergeBotMessages(withFiles, [message(1, { files: [{ name: 'a.png', size: 3 }] })]), withFiles);
  assert.notEqual(mergeBotMessages(withFiles, [message(1, { files: [{ name: 'b.png', size: 3 }] })]), withFiles);
  // Silent read mark: adding or changing silentRead triggers a row update; identical keeps object.
  const inbox = [message(2, { role: 'user', authorLabel: 'Task: Build' })];
  const marked = mergeBotMessages(inbox, [message(2, { role: 'user', authorLabel: 'Task: Build', silentRead: { at: 100, reason: 'Interim' } })]);
  assert.notEqual(marked, inbox);
  assert.equal(marked[0].silentRead?.reason, 'Interim');
  assert.equal(
    mergeBotMessages(marked, [message(2, { role: 'user', authorLabel: 'Task: Build', silentRead: { at: 100, reason: 'Interim' } })]),
    marked
  );
  // Request resolved mark: adding or changing requestResolved triggers a row update; identical keeps object.
  const resolvedMsg = mergeBotMessages(inbox, [
    message(2, { role: 'user', authorLabel: 'Task: Build', requestResolved: { op: 'done', by: 'person', at: 200 } }),
  ]);
  assert.notEqual(resolvedMsg, inbox);
  assert.equal(resolvedMsg[0].requestResolved?.op, 'done');
  assert.equal(
    mergeBotMessages(resolvedMsg, [
      message(2, { role: 'user', authorLabel: 'Task: Build', requestResolved: { op: 'done', by: 'person', at: 200 } }),
    ]),
    resolvedMsg
  );
});

test('older pages merge in seq order, all the way back past 200 and 2,000', () => {
  const thread = server(3_000);
  let first = thread.page({ limit: 40 });
  let messages = mergeBotMessages([], first.messages);
  let hasMore = first.hasMore;
  let pages = 1;
  while (hasMore) {
    const older = thread.page({ limit: 60, beforeSeq: messages[0].seq });
    messages = mergeBotMessages(messages, older.messages);
    hasMore = older.hasMore;
    pages += 1;
  }
  assert.equal(messages.length, 3_000);
  assert.deepEqual(messages.map((row) => row.seq), range(1, 3_001));
  assert.equal(pages, 1 + Math.ceil((3_000 - 40) / 60));
});

test('polls ask only for what is after the cursor; a placed live reply holds the cursor below it', () => {
  const shown = range(1, 101).map((seq) => message(seq));
  assert.equal(botPollCursor([], []), null);
  assert.equal(botPollCursor(shown, []), 100);
  // A reply took seq 95 while it writes; messages 96..100 came after it.
  assert.equal(botPollCursor(shown, [{ messageId: 'r', place: 'cloud', content: 'hi', activeTool: null, seq: 95 }]), 94);
  // Not placed yet (no text): it gets a seq above everything shown.
  assert.equal(botPollCursor(shown, [{ messageId: 'r', place: 'cloud', content: '', activeTool: null, seq: null }]), 100);
  // Placed above what is shown: the newest shown still bounds it.
  assert.equal(botPollCursor(shown, [{ messageId: 'r', place: 'cloud', content: 'x', activeTool: null, seq: 120 }]), 100);

  // The reply is stored at 95: polling from 94 brings it, the rest stay the same objects.
  const stored = [...shown.slice(0, 94), message(95, { id: 'r', role: 'assistant', content: 'done' }), ...shown.slice(95)];
  const page = stored.filter((row) => row.seq > 94).map((row) => ({ ...row }));
  const merged = mergeBotMessages(shown.filter((row) => row.seq !== 95), page);
  assert.deepEqual(merged.map((row) => row.id).slice(93, 96), ['m94', 'r', 'm96']);
  assert.equal(merged[0], shown[0]);
});

test('the window: newest rows first, grows up by a step, never more than the max', () => {
  const ids = range(1, 3_001).map((seq) => `m${seq}`);
  let win = botWindowRange(ids, null, null);
  assert.deepEqual(win, { start: 3_000 - BOT_WINDOW_INITIAL, end: 3_000, following: true });
  win = botWindowStep(ids.length, win, 'up');
  assert.deepEqual(win, { start: 3_000 - BOT_WINDOW_INITIAL - BOT_WINDOW_STEP, end: 3_000, following: true });
  for (let index = 0; index < 10; index += 1) win = botWindowStep(ids.length, win, 'up');
  assert.equal(win.end - win.start, BOT_WINDOW_MAX);
  assert.equal(win.following, false, 'the newest rows were let go');
  // Held by ids: messages arriving below don't move it.
  const startId = ids[win.start];
  const endId = ids[win.end - 1];
  const more = [...ids, 'm3001', 'm3002'];
  assert.deepEqual(botWindowRange(more, startId, endId), { start: win.start, end: win.end, following: false });
  // Older messages loaded above don't move it either (indexes shift, ids hold).
  const older = ['m0a', 'm0b', ...ids];
  assert.deepEqual(botWindowRange(older, startId, endId), { start: win.start + 2, end: win.end + 2, following: false });
  // Back down to the newest: following again.
  let down = win;
  while (!down.following) down = botWindowStep(ids.length, down, 'down');
  assert.equal(down.end, ids.length);
  assert.ok(down.end - down.start <= BOT_WINDOW_MAX);
  // To the very first message.
  let top = botWindowRange(ids, null, null);
  while (top.start > 0) top = botWindowStep(ids.length, top, 'up');
  assert.deepEqual([top.start, top.end - top.start], [0, BOT_WINDOW_MAX]);
});

test('the window falls back to the newest when its ids are gone; short threads show everything', () => {
  const ids = range(1, 11).map((seq) => `m${seq}`);
  assert.deepEqual(botWindowRange(ids, null, null), { start: 0, end: 10, following: true });
  assert.deepEqual(botWindowRange(ids, 'gone', 'gone too'), { start: 0, end: 10, following: true });
  assert.deepEqual(botWindowRange([], null, null), { start: 0, end: 0, following: true });
});

let failed = 0;
test("a reply's cards and file ids count as changes when merging (its row redraws)", () => {
  const shown = [message(1), message(2, { cards: [{ id: 'c1', component: 'bot-actions', props: { actions: [] } }] })];
  assert.equal(mergeBotMessages(shown, [message(1), message(2, { cards: [{ id: 'c1', component: 'bot-actions', props: { actions: [] } }] })]), shown, 'same cards: unchanged');
  const carded = mergeBotMessages(shown, [message(2, { cards: [{ id: 'c1', component: 'bot-actions', props: { actions: [{ kind: 'reply', label: 'Yes' }] } }] })]);
  assert.notEqual(carded, shown);
  assert.equal(carded[0], shown[0], 'the other row keeps its object');
  const filed = [message(3, { files: [{ name: 'a.png', size: 1 }] })];
  assert.notEqual(mergeBotMessages(filed, [message(3, { files: [{ name: 'a.png', size: 1, assetId: 'asset_1' }] })]), filed, 'a file that gained its library id');
  const uploading = [message(3, { files: [{ name: 'a.png', size: 1, pendingId: 'att_1', status: 'uploading' }] })];
  assert.notEqual(
    mergeBotMessages(uploading, [message(3, { files: [{ name: 'a.png', size: 1, pendingId: 'att_1', status: 'failed', error: 'Offline' }] })]),
    uploading,
    'a file whose background upload failed'
  );
  assert.equal(botPollCursor([message(1), message(2), ...uploading], []), 2, 'poll cursor stays before a message with an uploading attachment');
  const resolved = [message(3, { files: [{ name: 'a.png', size: 1, pendingId: 'att_1', assetId: 'asset_1' }] })];
  assert.equal(botPollCursor([message(1), message(2), ...resolved], []), 3, 'poll cursor advances once uploads finish');
});

test('task reports: Ship goes to the thread the report came from; the footers stay out of the text', () => {
  const footer = '(Durango Code thread t_42, project durango, on Mac. Read it with read_thread and follow up there, e.g. to ship it, with message_thread thread_id "t_42".)';
  const report = `Done: sorted projects.\n\n---\nThread: @thread:t_42\nChange: chg_abcdefgh12 (open) https://durango.sh/source/x/changes/chg_abcdefgh12\nWorkspace: /ws/x\n\n${footer}`;
  assert.deepEqual(taskReportActions(report), [
    { kind: 'ship_change', change_id: 'chg_abcdefgh12', thread_id: 't_42', url: 'https://durango.sh/source/x/changes/chg_abcdefgh12' },
    { kind: 'open_change', change_id: 'chg_abcdefgh12', url: 'https://durango.sh/source/x/changes/chg_abcdefgh12' },
    { kind: 'open_thread', thread_id: 't_42' },
  ]);
  assert.equal(taskReportBody(report), 'Done: sorted projects.');
  // A thread Durango started reports with only the footer: its id still reaches Open thread.
  assert.deepEqual(taskReportActions(`Done.\n\n${footer}`), [{ kind: 'open_thread', thread_id: 't_42' }]);
  assert.equal(taskReportBody(`Done.\n\n${footer}`), 'Done.');
  // A landed change: no Ship.
  assert.equal(taskReportActions('x\n\n---\nThread: @thread:t1\nChange: chg_abcdefgh12 (landed)').some((action) => action.kind === 'ship_change'), false);
});

test("Ship buttons keep the change's thread; the bot's fallback request names it", () => {
  assert.deepEqual(parseBotAction({ kind: 'ship_change', change_id: 'chg_abcdefgh12', thread_id: 't_42' }), {
    kind: 'ship_change', label: undefined, change_id: 'chg_abcdefgh12', url: undefined, thread_id: 't_42',
  });
  assert.equal(parseBotAction({ kind: 'ship_change', change_id: 'chg_abcdefgh12', thread_id: 'bad id!' }).thread_id, undefined);
  assert.equal(parseBotAction({ kind: 'open_change', change_id: 'chg_abcdefgh12', thread_id: 't_42' }).thread_id, undefined);
  assert.match(botShipRequestText({ change_id: 'chg_abcdefgh12', thread_id: 't_42' }), /^Ship chg_abcdefgh12 now \(I confirmed\): send it to the thread that made it \(Durango Code thread t_42\)/);
});

test('resolveThreadStarter attributes each thread to the bot that actually started it (local, machine, cloud, legacy)', () => {
  const makeBot = (overrides) => ({
    id: 'b_default',
    name: 'Bot',
    emoji: null,
    role: 'bot',
    job: '',
    model: 'anthropic/claude-opus-5.5',
    status: 'idle',
    paused: false,
    replies: [],
    lastActivityAt: 1,
    lastPreview: null,
    unread: 0,
    needsYou: false,
    project: null,
    ...overrides,
  });
  const durangoProject = { key: 'repo:durango', name: 'durango', repoId: 'durango' };
  const primary = makeBot({ id: 'y974primary', name: 'durango-primary', emoji: '🌐', projectPrimary: true, project: durangoProject });
  const codeBot = makeBot({ id: 'y977code', name: 'durango-code', emoji: '🛠️', project: durangoProject });
  const chatBot = makeBot({ id: 'y97fchat', name: 'durango-chat', emoji: '💬', project: durangoProject });
  const globalPrimary = makeBot({ id: 'y97global', name: 'Durango', emoji: '✨', role: 'primary', project: null });
  const otherSameName = makeBot({ id: 'y97other', name: 'durango-code', emoji: '🧪', project: { key: 'repo:other', name: 'other', repoId: 'other' } });
  const projectBots = [primary, codeBot, chatBot];
  const allBots = [globalPrimary, otherSameName, ...projectBots];

  // Existing machine-dispatched thread with startedByBot name only (matches project bot, never primary).
  assert.deepEqual(
    resolveThreadStarter({ startedByBot: 'durango-code', durangoDispatch: { id: 'bottask:y1750' } }, allBots, projectBots),
    { kind: 'bot', bot: codeBot, name: 'durango-code' }
  );
  assert.deepEqual(
    resolveThreadStarter({ startedByBot: 'durango-chat', durangoDispatch: { id: 'bottask:y178e', runOffset: 1 } }, allBots, projectBots),
    { kind: 'bot', bot: chatBot, name: 'durango-chat' }
  );

  // Thread with startedByBotId stays attributed even after the bot is renamed (or has a duplicate name).
  const renamedCodeBot = { ...codeBot, name: 'code-renamed' };
  assert.deepEqual(
    resolveThreadStarter(
      { startedByBot: 'durango-code', startedByBotId: 'y977code', durangoDispatch: { id: 'bottask:y1750' } },
      [globalPrimary, otherSameName, primary, renamedCodeBot, chatBot],
      [primary, renamedCodeBot, chatBot]
    ),
    { kind: 'bot', bot: renamedCodeBot, name: 'code-renamed' }
  );

  // Cloud-dispatched bot thread (Convex dispatch id, not bottask:/localbot:) resolves to the starter bot, not Durango.
  assert.deepEqual(
    resolveThreadStarter(
      { startedByBot: 'durango-chat', startedByBotId: 'y97fchat', durangoDispatch: { id: 't57cloud123' } },
      allBots,
      projectBots
    ),
    { kind: 'bot', bot: chatBot, name: 'durango-chat' }
  );
  assert.deepEqual(
    resolveThreadStarter(
      { startedByBot: 'durango-code', durangoDispatch: { id: 't57cloud456' } },
      allBots,
      projectBots
    ),
    { kind: 'bot', bot: codeBot, name: 'durango-code' }
  );

  // Local bot thread resolves by id embedded in localbot:<botId>:<taskId> even without startedByBotId.
  assert.deepEqual(
    resolveThreadStarter({ startedByBot: 'durango-code', durangoDispatch: { id: 'localbot:y977code:lt_1' } }, allBots, projectBots),
    { kind: 'bot', bot: codeBot, name: 'durango-code' }
  );
  // A follow-up by another local bot must not overwrite the original starter bot.
  assert.deepEqual(
    resolveThreadStarter(
      { startedByBot: 'durango-chat', durangoDispatch: { id: 'localbot:y977code:lt_2', runOffset: 1 } },
      allBots,
      projectBots
    ),
    { kind: 'bot', bot: chatBot, name: 'durango-chat' }
  );

  // Thread started by a bot outside the project (e.g. global primary bot) resolves from allBots.
  assert.deepEqual(
    resolveThreadStarter({ startedByBot: 'Durango', durangoDispatch: { id: 'bottask:y1799' } }, allBots, projectBots),
    { kind: 'bot', bot: globalPrimary, name: 'Durango' }
  );

  // Deleted or unknown bot keeps its recorded name and never falls back to durango-primary.
  assert.deepEqual(
    resolveThreadStarter({ startedByBot: 'durango-bots', durangoDispatch: { id: 'bottask:y1734' } }, allBots, projectBots),
    { kind: 'bot', bot: null, name: 'durango-bots' }
  );

  // Pre-startedByBot thread with bottask: prefix falls back to generic "A bot", never durango-primary.
  assert.deepEqual(
    resolveThreadStarter({ durangoDispatch: { id: 'bottask:y17old' } }, allBots, projectBots),
    { kind: 'bot', bot: null, name: 'A bot' }
  );

  // User-started thread that a bot later followed up on stays attributed to You.
  assert.deepEqual(
    resolveThreadStarter({ durangoDispatch: { id: 'bottask:y17followup', runOffset: 2 } }, allBots, projectBots),
    { kind: 'you' }
  );
  // Follow-up on a 0-run user thread (followUp: true, no runOffset) stays attributed to You.
  assert.deepEqual(
    resolveThreadStarter({ durangoDispatch: { id: 'bottask:y17zero', followUp: true } }, allBots, projectBots),
    { kind: 'you' }
  );
  assert.deepEqual(
    resolveThreadStarter({ durangoDispatch: { id: 'localbot:y977code:lt_zero', followUp: true } }, allBots, projectBots),
    { kind: 'you' }
  );
  assert.deepEqual(
    resolveThreadStarter({ durangoDispatch: { id: 't57followup', followUp: true } }, allBots, projectBots),
    { kind: 'you' }
  );

  // Known botId of a deleted bot never falls back to a different live bot sharing the same name.
  assert.deepEqual(
    resolveThreadStarter(
      { startedByBot: 'durango-code', startedByBotId: 'deleted_code_bot', durangoDispatch: { id: 'bottask:y17del' } },
      allBots,
      projectBots
    ),
    { kind: 'bot', bot: null, name: 'durango-code' }
  );
  assert.deepEqual(
    resolveThreadStarter(
      { startedByBot: 'Durango', startedByBotId: 'deleted_cloud_bot', durangoDispatch: { id: 't57del' } },
      allBots,
      projectBots
    ),
    { kind: 'bot', bot: null, name: 'Durango' }
  );

  // Nameless 'bot' placeholder never matches a real bot named "Bot".
  const literalBot = makeBot({ id: 'y97lit', name: 'Bot', emoji: '🤖', project: durangoProject });
  assert.deepEqual(
    resolveThreadStarter({ startedByBot: 'bot', durangoDispatch: { id: 'bottask:y17noname' } }, [literalBot, ...allBots], [literalBot, ...projectBots]),
    { kind: 'bot', bot: null, name: 'A bot' }
  );

  // Signed-out / unloaded bot list keeps the recorded bot name cleanly.
  assert.deepEqual(
    resolveThreadStarter({ startedByBot: 'durango-code', startedByBotId: 'y977code', durangoDispatch: { id: 'bottask:y1750' } }, [], []),
    { kind: 'bot', bot: null, name: 'durango-code' }
  );

  // Legacy name-only matching is case-insensitive when no botId was stored.
  assert.deepEqual(
    resolveThreadStarter({ startedByBot: 'DURANGO-CHAT', durangoDispatch: { id: 'bottask:y17case' } }, allBots, projectBots),
    { kind: 'bot', bot: chatBot, name: 'durango-chat' }
  );

  // Durango Chat/Tasks/API dispatches and user-started threads.
  assert.deepEqual(resolveThreadStarter({ durangoDispatch: { id: 't57task1' } }, allBots, projectBots), { kind: 'durango' });
  assert.deepEqual(resolveThreadStarter({}, allBots, projectBots), { kind: 'you' });
});

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
if (failed) {
  console.error(`${failed} of ${tests.length} failed`);
  process.exit(1);
}
console.log(`all ${tests.length} passed`);
