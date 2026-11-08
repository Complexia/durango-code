import assert from 'node:assert/strict';

// Unsent composer drafts are saved with the store so a restart brings them
// back. Empty drafts are never kept, deleting a thread drops its draft, and
// drafts of threads that no longer exist are pruned once every stored
// thread's shell has loaded (hydration), never after a failed load. All
// storage is in memory. `--failed-backfill` runs a failed thread load;
// `--cleared-backfill` clears storage while a transcript is still loading.
import { summarizeThreadMessages } from '../src/thread-shell.js';

const failedBackfill = process.argv.includes('--failed-backfill');
const clearedBackfill = process.argv.includes('--cleared-backfill');
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const project = { id: 'project', name: 'Project', path: '/tmp/project' };
const thread = (id: string) => ({
  id,
  projectId: project.id,
  title: id,
  status: 'idle',
  createdAt: '2026-10-01T00:00:00.000Z',
  messages: [],
});
const stored = [thread('fresh'), thread('later')];
const attachment = { id: 'a1', name: 'shot.png', path: '/tmp/shot.png', mimeType: 'image/png', size: 1 };
const savedDrafts = {
  fresh: { text: 'typed before the restart', attachments: [attachment] },
  later: { text: 'in a thread whose transcript is not loaded', attachments: [] },
  gone: { text: 'its thread was deleted', attachments: [] },
};

const batchGate = deferred<void>();
const threadSaves: unknown[] = [];
const storeSaves: string[] = [];
const syncStoreSaves: string[] = [];
const unloadListeners: Array<() => void> = [];
const bridge = {
  loadStore: async () =>
    JSON.stringify({
      version: 1,
      state: {
        projects: [project],
        selectedThreadId: 'fresh',
        composerDrafts: savedDrafts,
        // Already settled, so the first-switch settle writes nothing here.
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
  loadThreadShells: async () =>
    failedBackfill
      ? { ok: false }
      : {
          ok: true,
          value: JSON.stringify({
            version: 2,
            present: true,
            shells: stored.map(({ messages, ...fields }) => ({ ...fields, summary: summarizeThreadMessages(messages) })),
            threads: stored.filter((entry) => entry.id === 'fresh'),
          }),
        },
  loadThreadsBatch: async (input: { ids: string[] }) => {
    await batchGate.promise;
    return {
      ok: true,
      value: JSON.stringify({
        version: 2,
        consumed: input.ids.length,
        threads: stored.filter((entry) => input.ids.includes(entry.id)),
      }),
    };
  },
  saveThreads: async (patch: unknown) => {
    threadSaves.push(patch);
    return true;
  },
  getNoProjectDir: async () => '/tmp/no-project',
};
Object.assign(globalThis, {
  window: {
    addEventListener(type: string, listener: () => void) {
      if (type === 'beforeunload') unloadListeners.push(listener);
    },
    localStorage: { getItem: () => null },
    orion: bridge,
  },
});
const { useOrionStore, flushOrionStoreSave, onAllThreadsLoaded } = await import('../src/store');

await new Promise<void>((resolve) => {
  if (useOrionStore.persist.hasHydrated()) resolve();
  else useOrionStore.persist.onFinishHydration(() => resolve());
});
const drafts = () => useOrionStore.getState().composerDrafts;

await new Promise<void>((resolve) => onAllThreadsLoaded(resolve));
if (failedBackfill) {
  assert.equal(useOrionStore.getState().threads.length, 0);
  assert.deepEqual(
    Object.keys(drafts()).sort(),
    ['fresh', 'gone', 'later'],
    "a thread that failed to load keeps its draft (it isn't known to be deleted)"
  );
  console.log('Composer draft persistence checks passed (failed backfill).');
  process.exit(0);
}
assert.equal(useOrionStore.getState().selectedThreadId, 'fresh');
assert.deepEqual(drafts().fresh, savedDrafts.fresh, 'the open thread gets its draft back');
assert.deepEqual(
  Object.keys(drafts()).sort(),
  ['fresh', 'later'],
  "a deleted thread's draft is pruned; one whose transcript isn't loaded is kept"
);
assert.deepEqual(Object.keys(useOrionStore.getState().transcripts), ['fresh'], 'only the open thread loaded');

if (clearedBackfill) {
  // Opening the other thread starts its transcript load; clearing storage
  // meanwhile must not write anything back when it lands.
  useOrionStore.getState().selectThread('later');
  await flushOrionStoreSave();
  const savesBefore = storeSaves.length;
  const threadSavesBefore = threadSaves.length;
  await useOrionStore.persist.clearStorage();
  batchGate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(storeSaves.length, savesBefore, 'a clear during a transcript load writes no store back');
  assert.equal(threadSaves.length, threadSavesBefore, 'nor any thread');
  console.log('Composer draft persistence checks passed (cleared backfill).');
  process.exit(0);
}
batchGate.resolve();

const { setComposerDraft, createThread, deleteThread } = useOrionStore.getState();
const blank = createThread(project.id, 'Blank', { select: false });
setComposerDraft(blank, { text: '   ', attachments: [] });
assert.equal(blank in drafts(), false, 'an empty composer saves nothing');
setComposerDraft(blank, { text: 'new words', attachments: [] });
assert.equal(drafts()[blank]?.text, 'new words');
setComposerDraft(blank, { text: '', attachments: [] });
assert.equal(blank in drafts(), false, 'clearing the composer (or sending) forgets the draft');

deleteThread('later');
assert.equal('later' in drafts(), false, 'deleting a thread drops its draft');

const otherProject = { id: 'other', name: 'Other', path: '/tmp/other' };
useOrionStore.setState((state) => ({ projects: [...state.projects, otherProject] }));
const elsewhere = createThread(otherProject.id, 'Elsewhere', { select: false });
setComposerDraft(elsewhere, { text: 'in a project about to go', attachments: [] });
useOrionStore.getState().removeProject(otherProject.id);
assert.equal(elsewhere in drafts(), false, "removing a project drops its threads' drafts");

setComposerDraft('fresh', { text: 'edited', attachments: [attachment] });
assert.ok(await flushOrionStoreSave());
const persisted = JSON.parse(storeSaves.at(-1)!).state.composerDrafts;
assert.deepEqual(persisted, { fresh: { text: 'edited', attachments: [attachment] } }, 'drafts are written with the store');

// Quitting inside the save debounce: the unload flush writes synchronously.
setComposerDraft('fresh', { text: 'typed just before quitting', attachments: [] });
const asyncSavesBefore = storeSaves.length;
for (const listener of unloadListeners) listener();
assert.equal(syncStoreSaves.length, 1, 'unsaved store changes are flushed synchronously on unload');
assert.equal(
  JSON.parse(syncStoreSaves[0]).state.composerDrafts.fresh.text,
  'typed just before quitting'
);
await new Promise((resolve) => setTimeout(resolve, 600));
assert.equal(storeSaves.length, asyncSavesBefore, 'the debounced async save is cancelled after the sync flush');
for (const listener of unloadListeners) listener();
assert.equal(syncStoreSaves.length, 1, 'nothing unsaved, no second sync write');

console.log('Composer draft persistence checks passed.');
