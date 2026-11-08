import assert from 'node:assert/strict';
import { mergeShellWithStored, summarizeThreadMessages, threadShellOf } from '../src/thread-shell.js';

// The store keeps every thread's shell and only some transcripts: the open
// panes' at startup, others when something needs them. Checks that loading is
// lazy, that a change to a transcript that isn't loaded waits for it instead
// of being lost, that saves never store a thread without its messages, that
// eviction never drops unsaved work, and that streaming touches only its own
// transcript. "Disk" is an in-memory map that saves the way main does.
type Stored = Record<string, unknown> & { id: string; messages: Array<Record<string, unknown>> };

const project = { id: 'project', name: 'Project', path: '/tmp/project' };
const message = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  role: 'agent',
  kind: 'agent-run',
  content: `${id} text`,
  status: 'done',
  ts: '2026-10-01T00:00:01.000Z',
  ...extra,
});
const thread = (id: string, extra: Record<string, unknown> = {}): Stored => ({
  id,
  projectId: project.id,
  title: id,
  status: 'idle',
  modelId: 'claude:test',
  accessMode: 'full-access',
  createdAt: '2026-10-01T00:00:00.000Z',
  messages: [message(`${id}-m1`)],
  ...extra,
});

const disk = new Map<string, Stored>(
  [
    // The open pane: a branch copy whose inherited subagent details the
    // manifest leaves out.
    thread('open', {
      inheritedSubagent: { id: 'isa', providerId: 'codex', kind: 'reviewer', prompt: 'inherited prompt', summary: 'inherited report' },
    }),
    thread('cold'),
    thread('cold-2'),
    // Running when the previous session ended: its run died with the app.
    thread('interrupted', { status: 'running', messages: [message('i-m1', { status: 'running', startedAt: '2026-10-01T00:00:01.000Z' })] }),
    thread('subagent', {
      parentThreadId: 'open',
      subagent: { id: 'sa', providerId: 'claude', kind: 'Explore', prompt: 'long prompt', summary: 'long report' },
    }),
    // Families to branch: one whose child loads slowly, one whose child can't be read.
    thread('family'),
    thread('family-child', { parentThreadId: 'family' }),
    thread('broken-family'),
    thread('broken-child', { parentThreadId: 'broken-family' }),
    thread('quit-mid-load'),
  ].map((entry) => [entry.id, entry])
);
const order = [...disk.keys()];

// What main's manifest holds for each thread (thread-storage.js): the shell
// without subagent details, plus the summary.
const manifestShell = (entry: Stored) => {
  const shell = threadShellOf(entry) as Record<string, unknown>;
  for (const key of ['subagent', 'inheritedSubagent']) {
    if (!shell[key]) continue;
    const { prompt: _prompt, summary: _summary, ...light } = shell[key] as Record<string, unknown>;
    shell[key] = light;
  }
  return { ...shell, summary: summarizeThreadMessages(entry.messages as never) };
};

type Patch = { upserts: Stored[]; shells: Array<Record<string, unknown> & { id: string }>; deletes: string[]; order?: string[] };
const saves: Patch[] = [];
const syncSaves: Patch[] = [];
const batchRequests: string[][] = [];
let failSaves = false;
const unreadableIds = new Set<string>();
// Per-thread load gates: a gated thread's load waits until it is opened.
const gates = new Map<string, { promise: Promise<void>; open: () => void }>();
const gate = (id: string) => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  gates.set(id, { promise, open });
  return () => {
    gates.delete(id);
    open();
  };
};
let releaseBatch: (() => void) | null = null;
const applyPatch = (patch: Patch) => {
  for (const upsert of patch.upserts) disk.set(upsert.id, structuredClone(upsert));
  for (const shell of patch.shells) {
    assert.ok(!('messages' in shell), 'a shell-only save carries no transcript');
    disk.set(shell.id, structuredClone(mergeShellWithStored(shell, disk.get(shell.id) ?? null)) as Stored);
  }
  for (const id of patch.deletes) disk.delete(id);
};
const storeSaves: string[] = [];
const unloadListeners: Array<() => void> = [];
const bridge = {
  loadStore: async () =>
    JSON.stringify({
      version: 1,
      state: {
        projects: [project],
        selectedThreadId: 'open',
        paneThreadIds: ['open'],
        sidebarV2Settings: { enabled: true, version: 2, settledExistingAt: '2026-10-01T00:00:00.000Z' },
      },
    }),
  saveStore: async (value: string) => {
    storeSaves.push(value);
    return true;
  },
  loadThreadShells: async (input: { ids?: string[] }) => ({
    ok: true,
    value: JSON.stringify({
      version: 2,
      present: true,
      shells: order.map((id) => manifestShell(disk.get(id)!)),
      threads: (input.ids ?? []).flatMap((id) => (disk.has(id) ? [disk.get(id)] : [])),
    }),
  }),
  loadThreadsBatch: async (input: { ids: string[] }) => {
    batchRequests.push(input.ids);
    if (input.ids.some((id) => unreadableIds.has(id))) return { ok: false };
    for (const id of input.ids) await gates.get(id)?.promise;
    if (releaseBatch === null) {
      await new Promise<void>((resolve) => {
        releaseBatch = resolve;
      });
    }
    return {
      ok: true,
      value: JSON.stringify({
        version: 2,
        consumed: input.ids.length,
        threads: input.ids.flatMap((id) => (disk.has(id) ? [disk.get(id)] : [])),
      }),
    };
  },
  saveThreads: async (patch: Patch) => {
    if (failSaves) return false;
    saves.push(structuredClone(patch));
    applyPatch(patch);
    return true;
  },
  loadThreadSync: (id: string) => ({ ok: true, value: disk.has(id) ? JSON.stringify(disk.get(id)) : null }),
  saveThreadsSync: (patch: Patch) => {
    syncSaves.push(structuredClone(patch));
    applyPatch(patch);
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
const {
  useOrionStore,
  ensureThreadTranscript,
  evictTranscripts,
  findThread,
  flushOrionStoreSave,
  flushOrionThreadsSave,
  holdThreadTranscript,
  isThreadTranscriptLoaded,
} = await import('../src/store');

await new Promise<void>((resolve) => {
  if (useOrionStore.persist.hasHydrated()) resolve();
  else useOrionStore.persist.onFinishHydration(() => resolve());
});
const store = useOrionStore.getState;
const shell = (id: string) => findThread(store().threads, id)!;
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const release = () => {
  const resolve = releaseBatch;
  releaseBatch = () => {};
  resolve?.();
};

// --- Startup: every shell, only the open pane's transcript.
assert.deepEqual(store().threads.map((entry) => entry.id), order, 'every thread is listed, in stored order');
assert.deepEqual(Object.keys(store().transcripts), ['open'], 'only the open pane has its transcript');
assert.deepEqual(batchRequests, [], 'nothing else was read at startup');
assert.equal(shell('cold').summary.messageCount, 1, 'shells know their transcript without it');
assert.equal(shell('interrupted').status, 'idle', "a thread left 'running' by the last session is idle");
assert.deepEqual(shell('interrupted').summary.runningRunStarts, [], 'its dead run no longer counts as working');
assert.equal(shell('interrupted').summary.lastAgentRun?.status, 'stopped');
assert.equal(shell('subagent').subagent?.prompt, undefined, 'the manifest shell leaves out subagent details');
assert.equal(
  shell('open').inheritedSubagent?.prompt,
  'inherited prompt',
  'a pane loaded at startup gets its subagent details back, so a whole-thread save keeps them'
);

// --- Streaming touches only its own transcript: no shell, no store file.
await flushOrionThreadsSave();
// The first update after launch writes the store file once (migrations).
store().setActiveTab('agents');
await flushOrionStoreSave();
const threadsBefore = store().threads;
const storeSavesBefore = storeSaves.length;
const runId = store().addMessageToThread('open', { role: 'agent', content: '', kind: 'agent-run', status: 'running' });
const threadsAfterAdd = store().threads;
assert.notEqual(threadsAfterAdd, threadsBefore, 'a new message updates the shell summary');
for (let index = 0; index < 1000; index += 1) store().appendToThreadMessage('open', runId, 'x');
store().addActivityToThreadMessage('open', runId, { type: 'tool', title: 'Read file' });
assert.equal(store().threads, threadsAfterAdd, 'streamed text and activity never replace the thread list');
assert.equal(store().transcripts.open.messages.at(-1)?.content.length, 1000);
await settle(500);
assert.equal(storeSaves.length, storeSavesBefore, 'streaming writes no store file (persisted fields unchanged)');

// --- A shell change of a loaded thread whose transcript is saved goes as a
// shell too: main never rewrites (or reads) a transcript for a rename or pin.
assert.ok(await flushOrionThreadsSave());
store().updateThread('open', { pinnedAt: '2026-10-03T00:00:00.000Z', title: 'Open (renamed)' });
assert.ok(await flushOrionThreadsSave());
const openRename = saves.at(-1)!;
assert.deepEqual(openRename.shells.map((entry) => entry.id), ['open'], 'a loaded thread is saved shell-only');
assert.equal(openRename.upserts.length, 0, 'with no transcript in the patch');
assert.equal(disk.get('open')!.title, 'Open (renamed)');
assert.ok(disk.get('open')!.messages.length > 1, 'the stored transcript is untouched');

// --- A shell change of an unloaded thread saves shell-only and keeps its messages.
store().updateThread('cold', { title: 'Renamed while unloaded' });
assert.equal(isThreadTranscriptLoaded('cold'), false, 'a shell change loads nothing');
assert.ok(await flushOrionThreadsSave());
const renameSave = saves.at(-1)!;
assert.deepEqual(renameSave.shells.map((entry) => entry.id), ['cold']);
assert.ok(!renameSave.upserts.some((entry) => entry.id === 'cold'), 'no whole-thread write without the transcript');
assert.equal(disk.get('cold')!.title, 'Renamed while unloaded');
assert.deepEqual(disk.get('cold')!.messages, [message('cold-m1')], 'the stored messages survive a shell-only save');
assert.equal(
  (disk.get('subagent')!.subagent as { prompt?: string }).prompt,
  'long prompt',
  'untouched subagent details stay stored'
);

// A shell-only save of a subagent thread keeps the details the light shell lacks.
store().updateThread('subagent', { title: 'Explore (renamed)' });
assert.ok(await flushOrionThreadsSave());
assert.deepEqual(disk.get('subagent')!.subagent, {
  id: 'sa',
  providerId: 'claude',
  kind: 'Explore',
  prompt: 'long prompt',
  summary: 'long report',
});

// --- A change to an unloaded transcript waits for it, then applies in order.
const queuedId = store().addMessageToThread('cold-2', { role: 'user', content: 'follow-up' });
store().updateThreadMessage('cold-2', queuedId, { content: 'follow-up (edited)' });
assert.equal(isThreadTranscriptLoaded('cold-2'), false, 'still loading');
await settle();
assert.deepEqual(batchRequests.at(-1), ['cold-2'], 'the change loaded the transcript');
release();
await ensureThreadTranscript('cold-2');
assert.deepEqual(
  store().transcripts['cold-2'].messages.map((entry) => [entry.id, entry.content]),
  [['cold-2-m1', 'cold-2-m1 text'], [queuedId, 'follow-up (edited)']],
  'stored messages first, then the queued changes, nothing lost'
);
assert.equal(shell('cold-2').summary.messageCount, 2);
assert.ok(await flushOrionThreadsSave());
assert.deepEqual(disk.get('cold-2')!.messages.length, 2, 'the loaded and changed transcript is saved whole');

// --- Loading after a shell update keeps the shell as the store has it.
store().updateThread('subagent', { title: 'Newest title' });
const loaded = await ensureThreadTranscript('subagent');
assert.ok(loaded);
assert.equal(shell('subagent').title, 'Newest title', 'a load never reverts a newer shell field');
assert.equal(shell('subagent').subagent?.prompt, 'long prompt', 'a load fills in subagent details');

// --- An interrupted run is closed out when its transcript loads.
await ensureThreadTranscript('interrupted');
const interrupted = store().transcripts.interrupted.messages[0];
assert.equal(interrupted.status, 'stopped');
assert.equal(interrupted.statusText, 'Interrupted by app restart.');
assert.ok(await flushOrionThreadsSave());
assert.equal(disk.get('interrupted')!.messages[0].status, 'stopped', 'and that cleanup is saved');

// --- Eviction drops saved transcripts nothing needs, never unsaved ones.
store().selectThread('cold-2');
store().selectThread('open');
// cold-2 and open were opened recently; subagent and interrupted were only loaded.
failSaves = true;
store().appendToThreadMessage('subagent', 'subagent-m1', ' more');
assert.equal(await flushOrionThreadsSave(), false);
evictTranscripts();
assert.ok(isThreadTranscriptLoaded('subagent'), 'a transcript whose save failed is never evicted');
assert.equal(isThreadTranscriptLoaded('interrupted'), false, 'a saved transcript nothing needs is evicted');
assert.ok(isThreadTranscriptLoaded('open'), 'the open pane stays');
assert.ok(isThreadTranscriptLoaded('cold-2'), 'a recently opened thread stays');
failSaves = false;
assert.ok(await flushOrionThreadsSave());
assert.match(String(disk.get('subagent')!.messages[0].content), / more$/, 'the retried save has the change');
const hold = holdThreadTranscript('subagent');
evictTranscripts();
assert.ok(isThreadTranscriptLoaded('subagent'), 'a held transcript stays');
hold();
evictTranscripts();
assert.equal(isThreadTranscriptLoaded('subagent'), false, 'once saved and released it is evicted');
// Running threads stay loaded.
await ensureThreadTranscript('cold');
store().updateThread('cold', { status: 'running' });
await flushOrionThreadsSave();
evictTranscripts();
assert.ok(isThreadTranscriptLoaded('cold'), 'a running thread keeps its transcript');
store().updateThread('cold', { status: 'done' });

// --- Quitting: unsaved transcripts are written whole, shells shell-only.
// (A transcript change and a shell change of the same thread go as one whole
// thread; a shell change alone never carries the transcript.)
store().appendToThreadMessage('open', runId, ' tail');
store().updateThread('cold-2', { title: 'Retitled before quitting' });
evictTranscripts();
store().updateThread('interrupted', { pinnedAt: '2026-10-02T00:00:00.000Z' });
for (const listener of unloadListeners) listener();
const quit = syncSaves.at(-1)!;
assert.ok(quit.upserts.some((entry) => entry.id === 'open'), 'the streamed transcript is flushed whole');
assert.ok(quit.shells.some((entry) => entry.id === 'interrupted'), 'an unloaded thread is flushed shell-only');
assert.ok(!quit.upserts.some((entry) => entry.id === 'interrupted'));
assert.equal(disk.get('interrupted')!.messages[0].status, 'stopped', 'its stored messages are untouched');
assert.ok(disk.get('open')!.messages.some((entry) => String(entry.content).endsWith(' tail')));

// --- Branching holds the family's transcripts while they load.
await ensureThreadTranscript('family');
const openChild = gate('family-child');
const branching = store().branchThread('family');
await settle();
evictTranscripts();
assert.ok(isThreadTranscriptLoaded('family'), 'the source stays loaded while its children load');
openChild();
const branchId = await branching;
assert.ok(branchId, 'the branch is made');
const branchCopies = store().threads.filter((entry) => entry.id === branchId || entry.parentThreadId === branchId);
assert.equal(branchCopies.length, 2, 'the settled subagent is copied along');
assert.deepEqual(
  store().transcripts[branchCopies.find((entry) => entry.id !== branchId)!.id].messages.map((entry) => entry.id),
  ['family-child-m1'],
  'with its transcript'
);
evictTranscripts();
assert.equal(isThreadTranscriptLoaded('family-child'), false, 'and the holds are released after');

// A subagent whose transcript can't be read fails the branch instead of
// leaving the subagent out of it.
unreadableIds.add('broken-child');
const threadCount = store().threads.length;
await assert.rejects(store().branchThread('broken-family'), /could not be read/);
assert.equal(store().threads.length, threadCount, 'no partial branch is made');
unreadableIds.delete('broken-child');

// --- Quitting while a transcript loads keeps the changes waiting for it.
const openQuit = gate('quit-mid-load');
const queuedOnQuit = store().addMessageToThread('quit-mid-load', { role: 'user', content: 'sent while loading' });
await settle();
assert.equal(isThreadTranscriptLoaded('quit-mid-load'), false, 'still loading');
for (const listener of unloadListeners) listener();
const quitMidLoad = syncSaves.at(-1)!.upserts.find((entry) => entry.id === 'quit-mid-load');
assert.ok(quitMidLoad, 'the unload flush saves the thread whose changes were waiting');
assert.deepEqual(
  quitMidLoad.messages.map((entry) => entry.id),
  ['quit-mid-load-m1', queuedOnQuit],
  'stored messages plus the queued change'
);
assert.deepEqual(disk.get('quit-mid-load')!.messages.map((entry) => entry.id), ['quit-mid-load-m1', queuedOnQuit]);
openQuit();
await ensureThreadTranscript('quit-mid-load');

// --- Deleting a thread whose transcript is loading drops it for good.
assert.equal(isThreadTranscriptLoaded('interrupted'), false);
releaseBatch = null;
const pending = ensureThreadTranscript('interrupted').catch(() => null);
await settle();
store().deleteThread('interrupted');
release();
await pending;
assert.equal(isThreadTranscriptLoaded('interrupted'), false, 'a deleted thread does not come back with its load');
assert.equal(findThread(store().threads, 'interrupted'), undefined);
assert.ok(await flushOrionThreadsSave());
assert.ok(saves.at(-1)!.deletes.includes('interrupted'));
assert.equal(disk.has('interrupted'), false);

console.log('Thread shell hydration, lazy transcripts, eviction and save safety checks passed.');
