import assert from 'node:assert/strict';

// Unsent bot prompts (text and attached files) are saved with the store, one
// per box, so switching bots or tabs, opening a thread, or restarting brings
// them back. Empty drafts are never kept; thumbnails are rebuilt from the
// files' paths (blob:/data: previews are never stored, and a literal % in a
// file name survives). Project ask-box drafts are kept per account, and a
// prompt being sent is forgotten at once so leaving mid-send can't bring it
// back (a failed send restores it). All storage is in memory.

const savedBotDrafts = {
  'bot:b1': {
    text: 'typed before the restart',
    files: [
      { path: '/tmp/shot.png', name: 'shot.png', size: 10 },
      { path: '/tmp/notes.txt', name: 'notes.txt', size: 3 },
    ],
  },
  'project:local:p1': { text: 'ask the project bot', files: [] },
  'bot:b9': { text: '', files: [{ path: '/tmp/diagram%20v2.png', name: 'diagram%20v2.png', size: 4 }] },
};

const storeSaves: string[] = [];
const syncStoreSaves: string[] = [];
const unloadListeners: Array<() => void> = [];
Object.assign(globalThis, {
  window: {
    addEventListener(type: string, listener: () => void) {
      if (type === 'beforeunload') unloadListeners.push(listener);
    },
    localStorage: { getItem: () => null },
    orion: {
      loadStore: async () =>
        JSON.stringify({
          version: 1,
          state: {
            botDrafts: savedBotDrafts,
            sidebarV2Settings: { enabled: true, version: 2, settledExistingAt: '2026-10-01T00:00:00.000Z' },
          },
        }),
      saveStore: async (value: string) => {
        storeSaves.push(value);
        return true;
      },
      saveStoreSync: (value: string) => {
        syncStoreSaves.push(value);
        return true;
      },
      clearStore: async () => true,
      loadThreadShells: async () => ({ ok: true, value: JSON.stringify({ version: 2, present: true, shells: [], threads: [] }) }),
      loadThreadsBatch: async () => ({ ok: true, value: JSON.stringify({ version: 2, consumed: 0, threads: [] }) }),
      saveThreads: async () => true,
      getNoProjectDir: async () => '/tmp/no-project',
    },
  },
});

const { useOrionStore, flushOrionStoreSave } = await import('../src/store');
const {
  appendBotDraftFiles,
  botDraftKey,
  botDraftThumbnail,
  createBotDraftSaver,
  loadBotDraft,
  projectBotDraftKey,
  restoreUnsentBotDraft,
} = await import('../src/app/botDrafts');

await new Promise<void>((resolve) => {
  if (useOrionStore.persist.hasHydrated()) resolve();
  else useOrionStore.persist.onFinishHydration(() => resolve());
});

assert.equal(botDraftKey('b1'), 'bot:b1');
assert.equal(projectBotDraftKey('local', 'p1'), 'project:local:p1');
assert.notEqual(projectBotDraftKey('acct-a', 'p1'), projectBotDraftKey('acct-b', 'p1'), 'two accounts never share a project draft');
assert.notEqual(projectBotDraftKey('acct-a', 'p1'), projectBotDraftKey('local', 'p1'), 'signed-out local bots never see an account’s draft');
assert.equal(projectBotDraftKey(null, 'p1'), 'project:none:p1');
assert.equal(loadBotDraft(projectBotDraftKey('acct-a', 'p1')).text, '', 'another account starts with an empty project box');
assert.equal(loadBotDraft(projectBotDraftKey('local', 'p1')).text, 'ask the project bot');
assert.deepEqual(useOrionStore.getState().botDrafts, savedBotDrafts, 'saved bot drafts come back after a restart');

const restored = loadBotDraft('bot:b1');
assert.equal(restored.text, 'typed before the restart');
assert.deepEqual(
  restored.files.map((file) => file.path),
  ['/tmp/shot.png', '/tmp/notes.txt'],
  'attachments come back in order'
);
assert.match(restored.files[0].preview ?? '', /^orion-attachment:\/\/local\/media\?path=%2Ftmp%2Fshot\.png$/, 'an image gets its thumbnail back from disk');
assert.equal(restored.files[1].preview, undefined, 'other files have no thumbnail');
assert.deepEqual(loadBotDraft('bot:none'), { text: '', files: [] }, 'a bot with no draft starts empty');

// A literal %xx in a file name is part of the name, not an escape.
const percentPreview = loadBotDraft('bot:b9').files[0].preview ?? '';
assert.equal(new URL(percentPreview).searchParams.getAll('path').join('|'), '/tmp/diagram%20v2.png', 'the thumbnail asks for the file as named');
assert.equal(
  new URL(botDraftThumbnail('C:\\Users\\me\\shot.png')).searchParams.get('path'),
  'C:/Users/me/shot.png',
  'Windows paths use forward slashes like other media URLs'
);

const { setBotDraft } = useOrionStore.getState();
setBotDraft('bot:b2', { text: 'second bot', files: [] });
setBotDraft('bot:b1', { text: '  ', files: [] });
assert.ok(!('bot:b1' in useOrionStore.getState().botDrafts), 'an emptied (sent) draft is forgotten');
setBotDraft('bot:b3', { text: '', files: [{ path: '/tmp/a.pdf', name: 'a.pdf', size: 1 }] });
assert.ok('bot:b3' in useOrionStore.getState().botDrafts, 'files alone are a draft');
const before = useOrionStore.getState();
setBotDraft('bot:b4', { text: '', files: [] });
assert.equal(useOrionStore.getState(), before, 'an empty draft for a box without one changes nothing');

// The debounced saver, with a manual clock.
const timers = new Map<number, () => void>();
let nextTimer = 0;
const clock = {
  setTimer: (callback: () => void) => {
    timers.set(++nextTimer, callback);
    return nextTimer;
  },
  clearTimer: (handle: unknown) => {
    timers.delete(handle as number);
  },
};
const fire = () => {
  const due = [...timers.values()];
  timers.clear();
  due.forEach((callback) => callback());
};
const draftOf = (key: string) => useOrionStore.getState().botDrafts[key];
const sendKey = projectBotDraftKey('local', 'send');

const saver = createBotDraftSaver(sendKey, clock);
saver.save('h');
saver.save('hello');
assert.equal(draftOf(sendKey), undefined, 'typing is not written until the pause');
fire();
assert.equal(draftOf(sendKey)?.text, 'hello', 'the pause writes the draft');

// Send, then leave the page (unmount flush) before the send finishes: the sent text is gone.
saver.save('hello there');
saver.discard();
assert.equal(draftOf(sendKey), undefined, 'a prompt being sent is forgotten at once');
fire();
saver.flush();
assert.equal(draftOf(sendKey), undefined, 'neither the pending write nor leaving the page brings it back');

// The send failed: its text comes back.
restoreUnsentBotDraft(sendKey, { text: 'hello there', files: [] });
assert.equal(draftOf(sendKey)?.text, 'hello there', 'a failed send restores the prompt');

// Sending again, the person types something new before it fails: the new text wins.
saver.discard();
saver.save('a newer thought');
saver.flush();
restoreUnsentBotDraft(sendKey, { text: 'hello there', files: [] });
assert.equal(draftOf(sendKey)?.text, 'a newer thought', 'a failed send never overwrites newer text');

// Emptying the box is written at once.
saver.save('');
assert.equal(draftOf(sendKey), undefined, 'an emptied box forgets its draft without waiting');
assert.equal(timers.size, 0);

// Late-resolving async drops after unmount merge into the original bot's saved draft,
// deduplicate by path, enforce max count, and strip blob: preview URLs.
appendBotDraftFiles('bot:b2', [{ path: '/tmp/late.png', name: 'late.png', size: 12, preview: 'blob:ephemeral' }], 2);
assert.equal(draftOf('bot:b2')?.text, 'second bot', 'appending files preserves existing draft text');
assert.deepEqual(draftOf('bot:b2')?.files, [{ path: '/tmp/late.png', name: 'late.png', size: 12 }]);
appendBotDraftFiles(
  'bot:b2',
  [
    { path: '/tmp/late.png', name: 'late.png', size: 12 },
    { path: '/tmp/second.png', name: 'second.png', size: 24 },
    { path: '/tmp/overflow.png', name: 'overflow.png', size: 36 },
  ],
  2
);
assert.deepEqual(
  draftOf('bot:b2')?.files.map((file) => file.path),
  ['/tmp/late.png', '/tmp/second.png'],
  'appendBotDraftFiles deduplicates and enforces maxFiles'
);

await flushOrionStoreSave();
const lastSave = JSON.parse(storeSaves.at(-1) ?? syncStoreSaves.at(-1) ?? '{}');
assert.deepEqual(
  Object.keys(lastSave.state?.botDrafts ?? {}).sort(),
  ['bot:b2', 'bot:b3', 'bot:b9', 'project:local:p1'],
  'bot drafts are written to the store file'
);

console.log('Bot draft persistence checks passed.');
process.exit(0);
