import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  configureWorkspaceSync,
  initWorkspaceSync,
  shutdownWorkspaceSync,
  workspaceSyncNow,
} from '../src/main/workspace-sync.js';

// Workspace sync's thread pass against an in-memory server, the way the app
// wires it (readThreadsForSync from thread storage). No network, no profile.
//
// - After the storage upgrade, threads still at their migrated version are
//   synced under the hash the server already has (`syncHash`): nothing is
//   read or uploaded.
// - A changed thread is read and uploaded under the version actually read.
// - Changed threads are read a batch at a time, never all at once.
// - An unreadable thread is skipped; the rest still sync.
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const thread = (id, title = id) => ({
  id,
  projectId: 'project',
  title,
  status: 'done',
  modelId: 'claude:test',
  createdAt: '2026-11-01T00:00:00.000Z',
  messages: [{ id: `${id}-m`, role: 'user', content: 'hi', ts: '2026-11-01T00:00:01.000Z' }],
});

// "Disk": the index entries thread storage keeps, and the stored threads.
const entries = new Map();
const stored = new Map();
const unreadable = new Set();
const migrate = (id) => {
  // Before the upgrade the server stored sha256(JSON.stringify(thread)); the
  // migrated entry keeps that as its syncHash next to its new version hash.
  stored.set(id, thread(id));
  entries.set(id, { id, hash: sha(`${id}-v3`), syncHash: sha(JSON.stringify(stored.get(id))), transcriptBytes: 100 });
};
const save = (id, changes) => {
  stored.set(id, { ...stored.get(id), ...changes });
  // A save writes a new entry: a new version hash, and no syncHash.
  entries.set(id, { id, hash: sha(`${id}-${JSON.stringify(stored.get(id))}`), transcriptBytes: 100 });
};
for (let index = 0; index < 120; index += 1) migrate(`t${index}`);

// "Server": the hashes it holds per thread, seeded as before the upgrade.
const serverHashes = new Map([...entries.values()].map((entry) => [entry.id, entry.syncHash]));
const synced = [];
const uploaded = [];
let readCalls = [];
let readNotUploaded = 0;
let maxReadNotUploaded = 0;
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, options = {}) => {
  const url = input.toString();
  const { pathname } = new URL(url);
  if (pathname === '/api/sync/state') {
    return json({ threads: [...serverHashes].map(([id, transcriptHash]) => ({ id, transcriptHash, totalTokens: 10 })) });
  }
  if (pathname === '/api/sync/snapshot') return json({ ok: true });
  if (pathname === '/api/sync/threads') {
    const { threads } = JSON.parse(options.body);
    synced.push(...threads);
    // Uploads only for hashes the server doesn't have.
    const uploads = threads
      .filter((entry) => serverHashes.get(entry.id) !== entry.transcriptHash)
      .map((entry) => ({ threadId: entry.id, url: `https://uploads.test/${entry.id}` }));
    // Hash matches need no upload: the batch is done with.
    readNotUploaded -= threads.length - uploads.length;
    return json({ uploads });
  }
  if (pathname === '/api/sync/threads/complete') {
    for (const upload of JSON.parse(options.body).uploads) serverHashes.set(upload.threadId, upload.transcriptHash);
    return json({ ok: true });
  }
  if (url.startsWith('https://uploads.test/')) {
    uploaded.push(JSON.parse(options.body).id);
    readNotUploaded -= 1;
    return new Response(null, { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

initWorkspaceSync({
  getWebUrl: () => 'https://durango.test',
  readSession: async () => ({ token: 'token', user: { id: 'user' } }),
  readStoreState: async () => ({ projects: [] }),
  readThreadsIndex: async () => ({ version: 3, entries: [...entries.values()] }),
  readThreadsByIds: async () => {
    throw new Error('sync reads through readThreadsForSync');
  },
  readThreadsForSync: async (ids) => {
    readCalls.push(ids);
    // Unreadable threads come back as errors: nothing of theirs is held.
    readNotUploaded += ids.filter((id) => !unreadable.has(id)).length;
    maxReadNotUploaded = Math.max(maxReadNotUploaded, readNotUploaded);
    return ids.map((id) => {
      const entry = entries.get(id);
      const version = entry.syncHash ?? entry.hash;
      return unreadable.has(id) ? { id, version, error: 'failed its checksum' } : { thread: stored.get(id), version };
    });
  },
  broadcast: () => {},
});
configureWorkspaceSync({ enabled: true, syncCode: false });

// The first pass after the upgrade: the server already has every thread.
await workspaceSyncNow();
assert.deepEqual(readCalls, [], 'a migrated profile whose server hashes match reads zero threads');
assert.deepEqual(uploaded, [], 'and uploads none');

// A rename gives that thread a new version (and drops its syncHash): only it
// is read and uploaded, under the version read.
save('t7', { title: 'Seven (renamed)' });
await workspaceSyncNow();
assert.deepEqual(readCalls, [['t7']]);
assert.deepEqual(uploaded, ['t7']);
assert.equal(synced.at(-1).transcriptHash, entries.get('t7').hash, 'the new version hash is what is synced');
assert.match(synced.at(-1).transcriptHash, /^[0-9a-f]{64}$/, "it satisfies the server's hash pattern");

// Unchanged again: nothing read.
readCalls = [];
await workspaceSyncNow();
assert.deepEqual(readCalls, []);

// Every thread changes: they are read in batches, each uploaded before the
// next is read; one unreadable thread is skipped and the rest still sync.
for (const id of entries.keys()) save(id, { status: 'idle' });
unreadable.add('t3');
uploaded.length = 0;
await workspaceSyncNow();
assert.ok(readCalls.length >= 3, 'read in several batches');
assert.ok(readCalls.every((ids) => ids.length <= 50), 'no batch over 50 threads');
assert.ok(maxReadNotUploaded <= 50, `at most one batch read and not yet uploaded (${maxReadNotUploaded})`);
assert.equal(uploaded.length, 119, 'every readable thread is uploaded');
assert.ok(!uploaded.includes('t3'), 'the unreadable one is skipped');

// The version actually read is the one synced: a save between the index and
// the read is uploaded under its own hash.
readCalls = [];
save('t9', { title: 'Nine, once' });
const indexed = entries.get('t9');
save('t9', { title: 'Nine, twice' });
const indexOnce = entries.get('t9');
entries.set('t9', indexed);
initWorkspaceSync({
  getWebUrl: () => 'https://durango.test',
  readSession: async () => ({ token: 'token', user: { id: 'user' } }),
  readStoreState: async () => ({ projects: [] }),
  readThreadsIndex: async () => ({ version: 3, entries: [...entries.values()] }),
  readThreadsForSync: async (ids) => ids.map((id) => (id === 't9' ? { thread: stored.get(id), version: indexOnce.hash } : { thread: stored.get(id), version: entries.get(id).hash })),
  broadcast: () => {},
});
await workspaceSyncNow();
assert.equal(synced.at(-1).id, 't9');
assert.equal(synced.at(-1).title, 'Nine, twice');
assert.equal(synced.at(-1).transcriptHash, indexOnce.hash, 'uploaded under the hash of the version read, not the index');

configureWorkspaceSync({ enabled: false });
shutdownWorkspaceSync();
console.log('Workspace sync thread pass checks passed.');
