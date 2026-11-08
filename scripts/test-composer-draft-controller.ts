// The composer's draft controller: typing stays out of the store until the
// debounce (or a flush) and the app shell hears only about transitions.
import assert from 'node:assert/strict';
import type { ComposerDraft } from '../src/store';
import { createComposerDraftController } from '../src/app/composerDraft';

const saved = new Map<string, ComposerDraft>([['b', { text: 'saved b', attachments: [] }]]);
const saves: Array<[string, string]> = [];
const typed: string[] = [];
let pendingTimer: (() => void) | null = null;
const controller = createComposerDraftController({
  load: (id) => saved.get(id),
  save: (id, draft) => {
    saves.push([id, draft.text]);
    if (draft.text.trim() || draft.attachments.length) saved.set(id, draft);
    else saved.delete(id);
  },
  onDraftTyped: (id) => typed.push(id),
  setTimer: (callback) => {
    pendingTimer = callback;
    return 1;
  },
  clearTimer: () => {
    pendingTimer = null;
  },
});
let notifications = 0;
controller.subscribe(() => notifications++);
const runTimer = () => {
  const callback = pendingTimer;
  pendingTimer = null;
  callback?.();
};

// The first selected thread restores its saved draft (never overwrites it).
controller.switchTo('b');
assert.equal(controller.getDraft().text, 'saved b');
assert.deepEqual(saves, [], 'restoring a draft writes nothing');

controller.switchTo('a');
assert.equal(controller.getDraft().text, '', 'a fresh thread starts empty');

// Typing: one notification per keystroke for the composer, nothing in the
// store until the debounce fires, and one "typed" signal per thread.
const before = notifications;
for (const text of ['h', 'he', 'hel', 'hell', 'hello']) controller.setText(text);
assert.equal(notifications - before, 5);
assert.deepEqual(saves, [], 'keystrokes are not written to the store');
assert.deepEqual(typed, ['a'], 'the shell hears about the first non-empty draft only');
assert.equal(controller.hasActiveContent(), true);
runTimer();
assert.deepEqual(saves, [['a', 'hello']], 'one store write after the user stops typing');

// Switching flushes the pending draft at once and swaps.
controller.setText('hello world');
controller.switchTo('b');
assert.deepEqual(saves.at(-1), ['a', 'hello world'], 'switching threads flushes the previous draft');
assert.equal(pendingTimer, null);
assert.equal(controller.getDraft().text, 'saved b');
controller.switchTo('a');
assert.equal(controller.getDraft().text, 'hello world', "the thread's draft comes back");

// Send: clear + flush removes the saved draft.
controller.clear();
assert.equal(controller.hasActiveContent(), false);
controller.flush();
assert.equal(saved.has('a'), false, 'a sent draft is gone from the store');
assert.equal(typed.length, 1, 'clearing is not reported');

// A failed submission comes back ahead of whatever was typed since.
controller.setText('later');
controller.updateThreadDraft('a', (draft) => ({
  text: ['hello world', draft.text].filter(Boolean).join('\n\n'),
  attachments: draft.attachments,
}));
assert.equal(controller.getDraft().text, 'hello world\n\nlater');

// Another thread's draft (attachments for a thread about to be selected, a
// failed send elsewhere) is saved at once and shows up on switch.
const attachment = { id: 'f1', name: 'f.png', path: '/tmp/f.png', size: 1, mimeType: 'image/png' } as unknown as ComposerDraft['attachments'][number];
controller.updateThreadDraft('c', (draft) => ({ ...draft, attachments: [...draft.attachments, attachment] }));
assert.deepEqual(saved.get('c')?.attachments, [attachment]);
assert.ok(typed.includes('c'));
assert.equal(controller.hasThreadDraft('c'), true);
controller.switchTo('c');
assert.deepEqual(controller.getDraft().attachments, [attachment]);
controller.setAttachments(() => []);
assert.equal(controller.hasThreadDraft('c'), false);

// "Starting" is per thread and leaves the draft alone.
controller.setStarting('c', true);
assert.equal(controller.getSnapshot().starting.has('c'), true);
controller.setStarting('c', false);
assert.equal(controller.getSnapshot().starting.size, 0);

// Snapshots are immutable: an unchanged draft keeps its identity (what
// useSyncExternalStore relies on to skip renders).
const snapshot = controller.getSnapshot();
controller.setText(snapshot.text);
assert.equal(controller.getSnapshot(), snapshot);

console.log('Composer draft controller checks passed.');
