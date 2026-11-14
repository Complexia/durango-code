import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  configureWorkspaceSync,
  initWorkspaceSync,
  shutdownWorkspaceSync,
  workspaceSyncNow,
} from '../src/main/workspace-sync.js';

// Workspace sync's removals against an in-memory server.
//
// - The snapshot never sends a full list for the server to reconcile against:
//   another machine's threads are never removed by this one.
// - A thread or project deleted locally is removed explicitly, once, and only
//   by the machine that had it, including across a restart (the ledger file).
// - This machine's threads the server shows as removed are restored.
// - Nothing is posted when nothing changed; a failed index read removes
//   nothing, while deleting the last thread is a deletion.
// - Removals stay pending until the server acknowledges them (an older server
//   ignores the fields), and a failed ledger write is retried.
// - Each account keeps its own ledger.
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const thread = (id) => ({
  id,
  projectId: 'p1',
  title: id,
  status: 'done',
  modelId: 'claude:test',
  createdAt: '2026-11-01T00:00:00.000Z',
  messages: [{ id: `${id}-m`, role: 'user', content: 'hi', ts: '2026-11-01T00:00:01.000Z' }],
});

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'durango-sync-removals-'));
const ledgerPath = path.join(directory, 'orion-sync-ledger.json');

// "This machine": t1..t3 locally, projects p1 and p2.
const local = new Map(['t1', 't2', 't3'].map((id) => [id, thread(id)]));
let projects = [
  { id: 'p1', name: 'One', path: '' },
  { id: 'p2', name: 'Two', path: '' },
];
// "Server": this machine's threads, another machine's (o1, o2), and t3 marked
// removed by an older client on the other machine.
const server = new Map(
  [...local.values(), thread('o1'), thread('o2')].map((entry) => [
    entry.id,
    { hash: sha(JSON.stringify(entry)), removed: entry.id === 't3' },
  ])
);
const snapshots = [];
// An older server answers ok without applying removals.
let oldServer = false;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input.toString());
  const json = (value) => new Response(JSON.stringify(value), { status: 200 });
  if (url.pathname === '/api/sync/state') {
    assert.equal(url.searchParams.get('removed'), '1', 'the desktop asks for removed threads too');
    return json({
      threads: [...server].map(([id, row]) => ({ id, transcriptHash: row.hash, totalTokens: 10, ...(row.removed ? { removed: true } : {}) })),
    });
  }
  if (url.pathname === '/api/sync/snapshot') {
    const body = JSON.parse(options.body);
    snapshots.push(body);
    if (oldServer) return json({ ok: true });
    for (const id of body.removedThreadIds ?? []) server.get(id).removed = true;
    for (const id of body.restoredThreadIds ?? []) server.get(id).removed = false;
    return json({ ok: true, removals: true });
  }
  if (url.pathname === '/api/sync/threads') return json({ uploads: [] });
  return new Response('{}', { status: 404 });
};

let failIndex = false;
let userId = 'user';
const deps = {
  getWebUrl: () => 'https://durango.test',
  readSession: async () => ({ token: 'token', user: { id: userId } }),
  readStoreState: async () => ({ projects }),
  readThreadsIndex: async () => ({
    version: 3,
    entries: failIndex ? (() => { throw new Error('missing its manifest'); })() : [...local.values()].map((entry) => ({ id: entry.id, hash: sha(JSON.stringify(entry)) })),
  }),
  readThreadsForSync: async (ids) => ids.map((id) => ({ thread: local.get(id), version: sha(JSON.stringify(local.get(id))) })),
  getSyncLedgerPath: () => ledgerPath,
  broadcast: () => {},
};
initWorkspaceSync(deps);
configureWorkspaceSync({ enabled: true, syncCode: false });

// First pass: projects go up, t3 is restored, nothing is removed, and no full
// list is sent.
await workspaceSyncNow();
assert.equal(snapshots.length, 1);
assert.deepEqual(snapshots[0].projects.map((project) => project.id), ['p1', 'p2']);
assert.deepEqual(snapshots[0].restoredThreadIds, ['t3']);
assert.deepEqual(snapshots[0].removedThreadIds, []);
assert.equal(snapshots[0].threadIds, undefined, 'no thread list to reconcile against');
assert.equal(snapshots[0].complete, undefined);
assert.equal(server.get('t3').removed, false);
assert.equal(server.get('o1').removed, false, "another machine's threads are untouched");
const saved = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
assert.deepEqual(saved.accounts.user.threadIds.sort(), ['t1', 't2', 't3']);

// Nothing changed: no snapshot at all.
await workspaceSyncNow();
assert.equal(snapshots.length, 1, 'an unchanged pass posts no snapshot');

// Delete t2 and project p2 locally: removed explicitly, once.
local.delete('t2');
projects = projects.filter((project) => project.id !== 'p2');
await workspaceSyncNow();
assert.equal(snapshots.length, 2);
assert.deepEqual(snapshots[1].removedThreadIds, ['t2']);
assert.deepEqual(snapshots[1].removedProjectIds, ['p2']);
assert.deepEqual(snapshots[1].projects.map((project) => project.id), ['p1'], 'the changed project list goes up');
assert.equal(server.get('t2').removed, true);
assert.equal(server.get('o1').removed, false);
await workspaceSyncNow();
assert.equal(snapshots.length, 2, 'a removal is sent once');

// A failed index read (thread storage throws) removes nothing.
failIndex = true;
await workspaceSyncNow();
assert.equal(snapshots.length, 2);
assert.equal(server.get('t1').removed, false);
failIndex = false;

// An older server ignores the removal fields: the deletion stays pending and
// is sent again until a server applies it.
oldServer = true;
local.delete('t3');
await workspaceSyncNow();
await workspaceSyncNow();
assert.deepEqual(snapshots.slice(-2).map((body) => body.removedThreadIds), [['t3'], ['t3']]);
assert.equal(server.get('t3').removed, false);
oldServer = false;
await workspaceSyncNow();
assert.equal(server.get('t3').removed, true, 'applied once the server supports it');
const afterAck = snapshots.length;
await workspaceSyncNow();
assert.equal(snapshots.length, afterAck, 'and then not sent again');
local.set('t3', thread('t3'));
await workspaceSyncNow();
assert.equal(server.get('t3').removed, false, 'a thread that comes back is restored');

// A failed ledger write is retried on the next pass.
const blockedPath = path.join(directory, 'blocked');
await fs.mkdir(blockedPath);
deps.getSyncLedgerPath = () => path.join(blockedPath, 'missing', 'ledger.json');
local.set('t4', thread('t4'));
server.set('t4', { hash: sha(JSON.stringify(local.get('t4'))), removed: false });
await workspaceSyncNow();
deps.getSyncLedgerPath = () => ledgerPath;
await workspaceSyncNow();
const retried = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
assert.ok(retried.accounts.user.threadIds.includes('t4'), 'the ledger is written once writing works again');

// Another account on this machine keeps its own ledger.
userId = 'other';
await workspaceSyncNow();
userId = 'user';
await workspaceSyncNow();
const accounts = JSON.parse(await fs.readFile(ledgerPath, 'utf8')).accounts;
assert.deepEqual(Object.keys(accounts).sort(), ['other', 'user']);

// Deleted while the app was closed: a fresh start (a new module instance, so
// nothing in memory, only the ledger on disk) still sends it.
configureWorkspaceSync({ enabled: false });
shutdownWorkspaceSync();
local.delete('t1');
local.delete('t3');
local.delete('t4');
const restarted = await import('../src/main/workspace-sync.js?restart');
restarted.initWorkspaceSync(deps);
restarted.configureWorkspaceSync({ enabled: true, syncCode: false });
await restarted.workspaceSyncNow();
const last = snapshots.at(-1);
assert.deepEqual(last.removedThreadIds.sort(), ['t1', 't3', 't4'], 'deleting the last threads is a deletion too');
assert.equal(local.size, 0);
assert.equal(server.get('t1').removed, true);
assert.equal(server.get('o2').removed, false);

restarted.configureWorkspaceSync({ enabled: false });
restarted.shutdownWorkspaceSync();
await fs.rm(directory, { recursive: true, force: true });
console.log('Workspace sync removal checks passed.');
