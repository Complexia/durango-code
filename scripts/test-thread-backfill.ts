import assert from 'node:assert/strict';

// Startup hydration: the store hydrates with the head of the stored threads and
// loads the rest in the background. The backfill must keep stored order, keep
// what happened meanwhile, never re-save what it loaded, and clean up runs the
// previous session left 'running'. All storage is in memory.
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const project = { id: 'project', name: 'Project', path: '/tmp/project' };
const thread = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: project.id,
  title: id,
  status: 'idle',
  createdAt: '2026-10-01T00:00:00.000Z',
  messages: [],
  ...extra,
});
const stored = [
  thread('t1'),
  thread('t2'),
  thread('t3', {
    messages: [{ id: 'm1', role: 'agent', content: '', status: 'running', ts: '2026-10-01T00:00:01.000Z' }],
  }),
  thread('t4'),
  thread('selected-old'),
  thread('t5'),
];
const headIds = ['t1', 'selected-old'];
const order = stored.map((entry) => entry.id);

const headRequests: Array<{ count?: number; ids?: string[] }> = [];
const batchRequests: string[][] = [];
const batchGate = deferred<void>();
const saves: Array<{ upserts: Array<{ id: string }>; deletes: string[]; order: string[] }> = [];
const bridge = {
  loadStore: async () =>
    JSON.stringify({
      version: 1,
      state: {
        projects: [project],
        selectedThreadId: 'selected-old',
        // Already settled, so the first-switch settle stays out of these saves.
        sidebarV2Settings: { enabled: true, version: 2, settledExistingAt: '2026-10-01T00:00:00.000Z' },
      },
    }),
  saveStore: async () => true,
  loadThreadsHead: async (input: { count?: number; ids?: string[] }) => {
    headRequests.push(input);
    return {
      ok: true,
      value: JSON.stringify({
        version: 2,
        present: true,
        order,
        threads: stored.filter((entry) => headIds.includes(entry.id)),
      }),
    };
  },
  loadThreadsBatch: async (input: { ids: string[] }) => {
    batchRequests.push(input.ids);
    await batchGate.promise;
    // Two per response, so the caller has to continue from `consumed`.
    const ids = input.ids.slice(0, 2);
    return {
      ok: true,
      value: JSON.stringify({
        version: 2,
        consumed: ids.length,
        threads: stored.filter((entry) => ids.includes(entry.id)),
      }),
    };
  },
  saveThreads: async (patch: (typeof saves)[number]) => {
    saves.push(patch);
    return true;
  },
  getNoProjectDir: async () => '/tmp/no-project',
};
Object.assign(globalThis, {
  window: { addEventListener() {}, localStorage: { getItem: () => null }, orion: bridge },
});
const { useOrionStore, flushOrionThreadsSave, allThreadsLoaded, onAllThreadsLoaded } = await import('../src/store');

await new Promise<void>((resolve) => {
  if (useOrionStore.persist.hasHydrated()) resolve();
  else useOrionStore.persist.onFinishHydration(() => resolve());
});
const ids = () => useOrionStore.getState().threads.map((entry) => entry.id);

assert.deepEqual(headRequests[0]?.ids, ['selected-old'], 'the head is asked for the threads the store names');
assert.deepEqual(ids(), ['t1', 'selected-old'], 'the store hydrates with the head alone');
assert.equal(useOrionStore.getState().selectedThreadId, 'selected-old', 'the selection survives hydration');
assert.equal(allThreadsLoaded(), false);

// Meanwhile: a new thread, and a head thread deleted.
const created = useOrionStore.getState().createThread(project.id, 'Created meanwhile', { select: false });
useOrionStore.getState().deleteThread('t1');
assert.ok(await flushOrionThreadsSave());
assert.deepEqual(saves.at(-1)?.deletes, ['t1']);

const complete = new Promise<void>((resolve) => onAllThreadsLoaded(resolve));
batchGate.resolve();
await complete;

assert.deepEqual(batchRequests[0], ['t2', 't3', 't4', 't5'], 'the backfill asks only for what the head left');
assert.equal(batchRequests.length, 2, 'the backfill continues from what each response consumed');
assert.deepEqual(ids(), [created, 't2', 't3', 't4', 'selected-old', 't5'], 'backfilled threads take their stored places');
const restored = useOrionStore.getState().threads.find((entry) => entry.id === 't3')!;
assert.equal(restored.messages[0].status, 'stopped', "a backfilled run left 'running' is closed out");
assert.equal(allThreadsLoaded(), true);

// The save made during the backfill wrote a partial order; the real one follows,
// without re-uploading any backfilled transcript.
const before = saves.length;
assert.ok(await flushOrionThreadsSave());
assert.equal(saves.length, before + 1, 'the full order is written back');
assert.deepEqual(saves.at(-1)?.upserts, []);
assert.deepEqual(saves.at(-1)?.order, ids());
for (const save of saves) {
  for (const upsert of save.upserts) {
    assert.ok(!['t2', 't3', 't4', 't5'].includes(upsert.id), `backfilled ${upsert.id} must not be re-saved`);
  }
}

console.log('Thread head hydration and background backfill checks passed.');
