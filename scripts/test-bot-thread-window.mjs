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
