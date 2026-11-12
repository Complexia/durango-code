// A paired machine's threads listed in this machine's store
// (syncRemoteMachineThreads): mirrors are added once, kept current, filed under
// the matching local project (else No project), never re-added after a
// delete here, and dropped when that machine no longer has the thread.
//
//   bun scripts/test-remote-thread-listing.ts
import assert from 'node:assert/strict';
import { summarizeThreadMessages } from '../src/thread-shell.js';

const project = { id: 'local-durango', name: 'durango', path: '/tmp/durango' };
const bridge = {
  loadStore: async () => JSON.stringify({ version: 1, state: { projects: [project] } }),
  saveStore: async () => true,
  saveStoreSync: () => true,
  clearStore: async () => true,
  loadThreadShells: async () => ({
    ok: true,
    value: JSON.stringify({ version: 2, present: true, shells: [], threads: [] }),
  }),
  loadThreadsBatch: async () => ({ ok: true, value: JSON.stringify({ version: 2, consumed: 0, threads: [] }) }),
  saveThreads: async () => true,
  getNoProjectDir: async () => '/tmp/no-project',
};
Object.assign(globalThis, {
  window: { addEventListener() {}, localStorage: { getItem: () => null }, orion: bridge },
});
const { useOrionStore, NO_PROJECT_ID } = await import('../src/store');
await new Promise<void>((resolve) => {
  if (useOrionStore.persist.hasHydrated()) resolve();
  else useOrionStore.persist.onFinishHydration(() => resolve());
});

const machine = { id: 'm-omarchy', name: 'omarchy' };
const summary = {
  ...summarizeThreadMessages([]),
  messageCount: 4,
  lastMessage: { id: 'm4', role: 'agent' as const, ts: '2026-11-09T10:00:00.000Z', status: 'done' as const },
};
const listing = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: 'host-durango',
  title: `Host thread ${id}`,
  status: 'done' as const,
  modelId: 'claude:opus',
  createdAt: '2026-11-09T09:00:00.000Z',
  updatedAt: '2026-11-09T10:00:00.000Z',
  messageCount: 4,
  summary,
  settings: { accessMode: 'read-only', claudeReasoningEffort: 'high' },
  localProjectId: 'local-durango',
  projectName: 'durango',
  ...extra,
});
const mirrors = () => useOrionStore.getState().threads.filter((thread) => thread.remote?.machineId === machine.id);
const sync = (listed: ReturnType<typeof listing>[], skip = new Set<string>(), dismissed = new Set<string>()) =>
  useOrionStore.getState().syncRemoteMachineThreads(machine, listed, { skip, dismissed });

sync([
  listing('h1'),
  listing('h2', { localProjectId: null, projectName: 'futuremail' }),
  listing('draft', { messageCount: 0 }),
  listing('gone-here'),
], new Set(), new Set(['gone-here']));
assert.equal(mirrors().length, 2, 'empty drafts there and threads deleted here are not listed');
const h1 = mirrors().find((thread) => thread.remote?.threadId === 'h1')!;
assert.equal(h1.projectId, 'local-durango');
assert.equal(h1.accessMode, 'read-only');
assert.equal(h1.claudeReasoningEffort, 'high');
assert.equal(h1.summary.messageCount, 4, 'the sidebar orders and labels it by that machine’s summary');
assert.equal(h1.remote?.imported, true);
const h2 = mirrors().find((thread) => thread.remote?.threadId === 'h2')!;
assert.equal(h2.projectId, NO_PROJECT_ID, 'no local project matches: filed under No project');
assert.equal(h2.remote?.projectName, 'futuremail');
console.log('ok  another machine’s threads are listed here with their project and settings');

sync([listing('h1', { title: 'Renamed there', status: 'running' }), listing('h2')]);
assert.equal(mirrors().length, 2, 'listing again adds nothing');
assert.equal(mirrors().find((thread) => thread.id === h1.id)?.title, 'Renamed there');
assert.equal(mirrors().find((thread) => thread.id === h1.id)?.status, 'running');
sync([listing('h1', { title: 'Thread 4:04 PM' }), listing('h2')]);
assert.equal(mirrors().find((thread) => thread.id === h1.id)?.title, 'Renamed there', 'never a placeholder title');
console.log('ok  listed threads stay current');

// Open or running here: kept current one by one, so a listing leaves it be.
sync([listing('h1', { title: 'From the listing' }), listing('h2')], new Set([h1.id]));
assert.equal(mirrors().find((thread) => thread.id === h1.id)?.title, 'Renamed there');
// Gone there: gone here, unless kept current one by one or started here.
const started = useOrionStore.getState().createThread('local-durango', 'Started here', { select: false });
useOrionStore.getState().updateThread(started, { remote: { machineId: machine.id, machineName: 'omarchy', threadId: 'h9' } });
sync([listing('h1')], new Set([h1.id]));
assert.equal(mirrors().length, 3, 'one listing without it is not enough (a host mid-write)');
sync([], new Set([h1.id]));
assert.equal(mirrors().length, 3, 'an empty listing removes nothing');
sync([listing('h1')], new Set([h1.id]));
assert.deepEqual(
  mirrors().map((thread) => thread.remote?.threadId).sort(),
  ['h1', 'h9'],
  'the thread deleted there goes; the one kept current and the one started here stay'
);
console.log('ok  threads that machine deleted leave this list');

// What a listed thread waits on the user for there: its actions, and whether
// a question is pending (the sidebar's "Needs you").
{
  const action = { id: 'ua1', action: 'Approve the login', askedAt: '2026-11-09T10:00:00.000Z' };
  sync([listing('h1'), listing('h5', { userActions: [action], waitingOnQuestion: true })]);
  const h5 = mirrors().find((thread) => thread.remote?.threadId === 'h5')!;
  assert.deepEqual(h5.userActions, [action], 'new mirrors carry the actions they wait on');
  assert.ok(h5.remote?.needsInputSince, 'and whether a question waits');
  sync([listing('h1'), listing('h5', { userActions: [], waitingOnQuestion: false })]);
  const answered = mirrors().find((thread) => thread.id === h5.id)!;
  assert.equal(answered.userActions, undefined, 'answered there: gone here');
  assert.equal(answered.remote?.needsInputSince, undefined);
  console.log('ok  listed threads say what they wait on the user for');
}

// Started there by an agent here (machine_run_agent): listed under that
// agent's thread as its subagent, not as a top-level thread.
{
  const driver = useOrionStore.getState().createThread('local-durango', 'Fix the updater', { select: false });
  sync([
    listing('h1'),
    listing('h2'),
    listing('spawned', { localParentThreadId: driver }),
    listing('orphan', { localParentThreadId: 'not-here' }),
  ]);
  const spawned = mirrors().find((thread) => thread.remote?.threadId === 'spawned')!;
  assert.equal(spawned.parentThreadId, driver);
  const orphan = mirrors().find((thread) => thread.remote?.threadId === 'orphan')!;
  assert.equal(orphan.parentThreadId, undefined, 'a parent no longer here leaves it top-level');
  // A mirror listed before the link was known gets it later.
  sync([listing('h1', { localParentThreadId: driver }), listing('h2'), listing('spawned'), listing('orphan')]);
  assert.equal(mirrors().find((thread) => thread.remote?.threadId === 'h1')?.parentThreadId, driver);
  assert.equal(
    mirrors().find((thread) => thread.remote?.threadId === 'spawned')?.parentThreadId,
    driver,
    'a later listing without the link keeps it'
  );
  console.log('ok  threads an agent here started there are its subagents');
}

// A new thread in a project with no threads takes the model last run on this
// machine, not a fixed default.
{
  const store = useOrionStore.getState();
  const used = store.createThread('local-durango', 'Used', { select: false, modelId: 'codex:gpt-5.5' });
  store.updateThread(used, {
    summary: { ...summary, lastMessage: { ...summary.lastMessage, ts: new Date(Date.now() + 60_000).toISOString() } },
  });
  const fresh = useOrionStore.getState().createThread(NO_PROJECT_ID, undefined, { select: false });
  assert.equal(useOrionStore.getState().threads.find((thread) => thread.id === fresh)?.modelId, 'codex:gpt-5.5');
  console.log('ok  an empty project starts with the model last used on this machine');
}

// A thread an agent on another machine started here stays out of Recent
// once its first message lands.
{
  const store = useOrionStore.getState();
  const spawned = store.createThread('local-durango', undefined, {
    select: false,
    hiddenFromRecent: true,
    spawnedBy: { machineId: 'm-mac', machineName: 'Mac', threadId: 'mac-thread' },
  });
  store.addMessageToThread(spawned, { role: 'user', content: 'Diagnose the updater.' });
  assert.equal(useOrionStore.getState().threads.find((thread) => thread.id === spawned)?.hiddenFromRecent, true);
  console.log('ok  threads an agent elsewhere started here stay out of Recent');
}

console.log('All remote thread listing tests passed.');
process.exit(0);
