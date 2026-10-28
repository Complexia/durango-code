import assert from 'node:assert/strict';

// Sidebar v2: snoozed threads wake when their run ends, settled threads come
// back when they run again, and the four lists partition the threads. All
// storage is in memory; nothing touches the user's profile.
const bridge = {
  loadStore: async () => null,
  // Never answers: these checks run against a fresh, unhydrated store.
  loadThreadsPage: () => new Promise(() => {}),
  saveStore: async () => true,
  getNoProjectDir: async () => '/tmp/no-project',
};
Object.assign(globalThis, {
  window: { addEventListener() {}, localStorage: { getItem: () => null }, orion: bridge },
});
const { useOrionStore, defaultSidebarV2Settings } = await import('../src/store');
const { formatWorkedDuration, sidebarV2ThreadLists, threadSidebarTone, threadWorkedMs } = await import('../src/app/threadLists');
const { projectMonogram } = await import('../src/app/ProjectBadge');

const store = useOrionStore.getState;
assert.equal(store().sidebarV2Settings.enabled, false, 'sidebar v2 is opt-in');
assert.deepEqual(store().sidebarV2Settings.views, defaultSidebarV2Settings.views);
assert.equal(store().sidebarV2Settings.views.pinned, false, 'the Pinned list starts off');
store().setSidebarV2Settings({ views: { ...defaultSidebarV2Settings.views, settled: true } });
assert.equal(store().sidebarV2Settings.views.settled, true);
assert.equal(store().sidebarV2Settings.views.recent, true, 'toggling one list keeps the others');

const projectId = store().addProject({ name: 'durango', path: '/tmp/durango' });
const background = store().createThread(projectId, 'Background', { select: false });
const onScreen = store().createThread(projectId, 'On screen');
const thread = (id: string) => store().threads.find((candidate) => candidate.id === id)!;

// A snoozed run that finishes off screen wakes as "finished".
store().updateThread(background, { status: 'running' });
store().updateThread(background, { snoozedAt: new Date().toISOString() });
store().updateThread(background, { status: 'done' });
assert.equal(thread(background).snoozedAt, undefined, 'finishing wakes a snoozed thread');
assert.equal(thread(background).wokeReason, 'finished');
assert.equal(threadSidebarTone(thread(background), false), 'finished');

// Opening it clears the wake marker.
store().selectThread(background);
assert.equal(thread(background).wokeReason, undefined);
assert.equal(thread(background).wokeAt, undefined);

// A failure wakes as needing attention; a stop keeps it snoozed.
store().selectThread(onScreen);
store().updateThread(background, { status: 'running', snoozedAt: new Date().toISOString() });
store().updateThread(background, { status: 'error' });
assert.equal(thread(background).wokeReason, 'attention');
assert.equal(threadSidebarTone(thread(background), false), 'attention');
store().updateThread(background, { status: 'running', snoozedAt: new Date().toISOString() });
store().updateThread(background, { status: 'idle' });
assert.ok(thread(background).snoozedAt, 'a deliberate stop does not wake a snoozed thread');

// Finishing while on screen just rejoins the list, with nothing to flag.
store().updateThread(onScreen, { status: 'running', snoozedAt: new Date().toISOString() });
store().updateThread(onScreen, { status: 'done' });
assert.equal(thread(onScreen).snoozedAt, undefined);
assert.equal(thread(onScreen).wokeReason, undefined);

// Pending input outranks everything, even while running.
assert.equal(threadSidebarTone({ ...thread(onScreen), status: 'running' }, true), 'attention');

// New work in a settled thread brings it back; a pinned one keeps its pin.
store().updateThread(onScreen, { pinnedAt: new Date().toISOString(), settledAt: new Date().toISOString() });
store().updateThread(onScreen, { status: 'running' });
assert.equal(thread(onScreen).settledAt, undefined, 'running again unsettles');
assert.ok(thread(onScreen).pinnedAt, 'unsettling keeps the pin');
store().updateThread(onScreen, { pinnedAt: undefined });

// Turning sidebar v2 on the first time settles the threads from before it,
// except pinned ones (and running or snoozed ones); later toggles don't.
const old = store().createThread(projectId, 'Old', { select: false });
const pinned = store().createThread(projectId, 'Pinned', { select: false });
store().updateThread(pinned, { pinnedAt: new Date().toISOString() });
store().setSidebarV2Settings({ enabled: true });
assert.ok(store().sidebarV2Settings.settledExistingAt);
assert.ok(thread(old).settledAt, 'an existing thread is settled');
assert.equal(thread(pinned).settledAt, undefined, 'a pinned thread stays');
assert.equal(thread(onScreen).settledAt, undefined, 'a running thread stays');
assert.equal(thread(background).settledAt, undefined, 'a snoozed thread stays snoozed');
store().setSidebarV2Settings({ enabled: false });
const later = store().createThread(projectId, 'Later', { select: false });
store().setSidebarV2Settings({ enabled: true });
assert.equal(thread(later).settledAt, undefined, 'only the first switch settles');
store().setSidebarV2Settings({ enabled: false });

// Lists: settled beats snoozed; children never appear. Recent has every
// thread not snoozed or settled, pinned or not; Pinned keeps settled pinned
// threads but not snoozed ones. Snoozing or settling keeps the pin.
const now = Date.now();
const base = thread(onScreen);
const make = (id: string, extra: Record<string, unknown>) => ({ ...base, id, status: 'idle' as const, ...extra });
const at = new Date(now).toISOString();
const threads = [
  make('recent', {}),
  make('pinned', { pinnedAt: at }),
  make('snoozed', { pinnedAt: at, snoozedAt: at }),
  make('settled', { snoozedAt: at, settledAt: at }),
  make('settled-pinned', { pinnedAt: at, settledAt: at }),
  make('child', { parentThreadId: 'recent' }),
];
const lists = sidebarV2ThreadLists(threads, (candidate) => !!candidate.parentThreadId, () => 0);
assert.deepEqual(
  Object.fromEntries(Object.entries(lists).map(([view, list]) => [view, list.map((entry) => entry.id)])),
  {
    pinned: ['pinned', 'settled-pinned'],
    recent: ['recent', 'pinned'],
    snoozed: ['snoozed'],
    settled: ['settled', 'settled-pinned'],
  }
);
assert.ok(lists.snoozed[0].pinnedAt, 'a snoozed pinned thread stays pinned');

// The row's number is how long the thread's agents worked, summed over runs.
const runThread = {
  ...base,
  messages: [
    { id: 'u1', role: 'user', content: 'hi', ts: '2026-10-28T00:00:00.000Z' },
    { id: 'r1', role: 'agent', kind: 'agent-run', content: '', ts: '2026-10-28T00:00:00.000Z', status: 'done',
      startedAt: '2026-10-28T00:00:00.000Z', completedAt: '2026-10-28T00:00:07.000Z' },
    { id: 'r2', role: 'agent', kind: 'agent-run', content: '', ts: '2026-10-28T00:10:00.000Z', status: 'running',
      startedAt: '2026-10-28T00:10:00.000Z' },
  ],
} as typeof base;
assert.equal(threadWorkedMs(runThread, Date.parse('2026-10-28T00:10:05.000Z')), 12_000);
assert.equal(formatWorkedDuration(7_000), '7s');
assert.equal(formatWorkedDuration(38 * 60_000), '38m');
assert.equal(formatWorkedDuration(125 * 60_000), '2h 5m');

// Monograms match T3 Code's.
assert.equal(projectMonogram('durango'), 'DO');
assert.equal(projectMonogram('futuremail'), 'FL');
assert.equal(projectMonogram('rnr-unicorns-next'), 'RN');
assert.equal(projectMonogram('app2'), 'A2');

console.log('sidebar v2 tests passed');
