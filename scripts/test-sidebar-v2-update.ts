import assert from 'node:assert/strict';

// Updating to the release where sidebar v2 is the default: a store from when it
// was opt-in (off, never settled) turns it on and, once every stored thread has
// loaded, settles them all except pinned ones, saved like a user's settle.
// `--failed-backfill` checks that a partial load settles nothing. All storage
// is in memory.
const failedBackfill = process.argv.includes('--failed-backfill');

const project = { id: 'project', name: 'Project', path: '/tmp/project' };
const message = { id: 'm1', role: 'user', content: 'hi', status: 'done', ts: '2026-10-01T00:00:01.000Z' };
const thread = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: project.id,
  title: id,
  status: 'done',
  createdAt: '2026-10-01T00:00:00.000Z',
  messages: [message],
  ...extra,
});
const stored = [
  thread('head'),
  thread('pinned', { pinnedAt: '2026-10-01T00:00:02.000Z' }),
  thread('older'),
  thread('oldest'),
];
const headIds = ['head', 'pinned'];

const storeSaves: string[] = [];
const threadSaves: Array<{ upserts: Array<{ id: string; settledAt?: string }> }> = [];
const bridge = {
  loadStore: async () =>
    JSON.stringify({
      version: 1,
      state: {
        projects: [project],
        selectedThreadId: 'head',
        sidebarV2Settings: { enabled: false, views: { pinned: false, recent: true, snoozed: false, settled: false } },
      },
    }),
  saveStore: async (value: string) => {
    storeSaves.push(value);
    return true;
  },
  loadThreadsHead: async () => ({
    ok: true,
    value: JSON.stringify({
      version: 2,
      present: true,
      order: stored.map((entry) => entry.id),
      threads: stored.filter((entry) => headIds.includes(entry.id)),
    }),
  }),
  loadThreadsBatch: async (input: { ids: string[] }) => {
    if (failedBackfill) return { ok: false };
    return {
      ok: true,
      value: JSON.stringify({
        version: 2,
        consumed: input.ids.length,
        threads: stored.filter((entry) => input.ids.includes(entry.id)),
      }),
    };
  },
  saveThreads: async (patch: (typeof threadSaves)[number]) => {
    threadSaves.push(patch);
    return true;
  },
  getNoProjectDir: async () => '/tmp/no-project',
};
Object.assign(globalThis, {
  window: { addEventListener() {}, localStorage: { getItem: () => null }, orion: bridge },
});
const { useOrionStore, flushOrionStoreSave, flushOrionThreadsSave, onAllThreadsLoaded } = await import('../src/store');

await new Promise<void>((resolve) => {
  if (useOrionStore.persist.hasHydrated()) resolve();
  else useOrionStore.persist.onFinishHydration(() => resolve());
});
await new Promise<void>((resolve) => onAllThreadsLoaded(resolve));
const state = useOrionStore.getState();
const settledAt = (id: string) => state.threads.find((entry) => entry.id === id)?.settledAt;

assert.equal(state.sidebarV2Settings.enabled, true, 'the update turns sidebar v2 on');
assert.equal(state.sidebarV2Settings.version, 2);

if (failedBackfill) {
  assert.equal(state.sidebarV2Settings.settledExistingAt, undefined, 'a partial load waits for a full one');
  assert.equal(settledAt('head'), undefined);
  console.log('Sidebar v2 update checks passed (failed backfill).');
  process.exit(0);
}

assert.ok(state.sidebarV2Settings.settledExistingAt, 'the first-switch settle ran');
for (const id of ['head', 'older', 'oldest']) assert.ok(settledAt(id), `${id} is settled`);
assert.equal(settledAt('pinned'), undefined, 'a pinned thread stays');

// Both the settle and the switch are saved.
assert.ok(await flushOrionThreadsSave());
const savedSettled = new Set(
  threadSaves.flatMap((patch) => patch.upserts.filter((entry) => entry.settledAt).map((entry) => entry.id))
);
assert.deepEqual([...savedSettled].sort(), ['head', 'older', 'oldest']);
await flushOrionStoreSave();
const savedSidebar = JSON.parse(storeSaves.at(-1)!).state.sidebarV2Settings;
assert.equal(savedSidebar.enabled, true);
assert.equal(savedSidebar.version, 2);
assert.ok(savedSidebar.settledExistingAt);

console.log('Sidebar v2 update checks passed.');
