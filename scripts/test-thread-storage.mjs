import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

const testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-thread-storage-'));
app.setPath('userData', testDataDir);

try {
  const { getThreadsDirectoryPath, getThreadsFilePath } = await import('../src/main/paths.js');
  const {
    clearThreadsStorage,
    readAllThreads,
    readThreadById,
    readThreadsIndex,
    readThreadsBatch,
    readThreadsHead,
    writeThreadsPatch,
    writeThreadsPatchSync,
  } = await import('../src/main/thread-storage.js');

  const first = {
    id: 'thread-first',
    projectId: 'project-1',
    title: 'First',
    status: 'idle',
    modelId: 'codex:test',
    createdAt: '2026-08-04T00:00:00.000Z',
    messages: [{ role: 'user', content: 'one', ts: '2026-08-04T00:00:01.000Z' }],
  };
  const second = {
    id: 'thread-second',
    projectId: 'project-1',
    title: 'Second',
    status: 'idle',
    modelId: 'codex:test',
    createdAt: '2026-08-04T00:00:00.000Z',
    messages: [{ role: 'agent', content: 'two', ts: '2026-08-04T00:00:02.000Z' }],
  };

  await fs.writeFile(
    getThreadsFilePath(),
    JSON.stringify({ version: 1, threads: [first, second] }),
    'utf8'
  );

  assert.deepEqual(await readAllThreads(), [first, second], 'legacy snapshot should migrate without loss');
  await assert.rejects(fs.access(getThreadsFilePath()), 'legacy source should be archived after migration');
  await fs.access(path.join(testDataDir, 'orion-threads.v1-backup.json'));

  const index = await readThreadsIndex();
  assert.equal(index.version, 2);
  assert.deepEqual(index.entries.map((entry) => entry.id), [first.id, second.id]);
  assert.equal(index.entries[1].messageCount, 1);

  const secondPath = path.join(
    getThreadsDirectoryPath(),
    `${Buffer.from(second.id).toString('base64url')}.${index.entries[1].hash}.json`
  );
  const secondBefore = await fs.readFile(secondPath, 'utf8');
  const secondStatBefore = await fs.stat(secondPath);
  await new Promise((resolve) => setTimeout(resolve, 20));

  first.messages.push({ role: 'agent', content: 'changed', ts: '2026-08-04T00:00:03.000Z' });
  await writeThreadsPatch({ version: 2, upserts: [first], deletes: [], order: [first.id, second.id] });
  assert.deepEqual(await readThreadById(first.id), first);
  assert.equal(await fs.readFile(secondPath, 'utf8'), secondBefore, 'unchanged transcript bytes must be untouched');
  assert.equal(
    (await fs.stat(secondPath)).mtimeMs,
    secondStatBefore.mtimeMs,
    'unchanged transcript file must not be rewritten'
  );

  const third = { ...second, id: 'thread-third', title: 'Third' };
  writeThreadsPatchSync({
    version: 2,
    upserts: [third],
    deletes: [first.id],
    order: [second.id, third.id],
  });
  assert.deepEqual((await readThreadsIndex()).entries.map((entry) => entry.id), [second.id, third.id]);
  assert.equal(await readThreadById(first.id), null);
  assert.deepEqual(await readAllThreads(), [second, third]);

  const thirdEntry = (await readThreadsIndex()).entries.find((entry) => entry.id === third.id);
  const thirdPath = path.join(
    getThreadsDirectoryPath(),
    `${Buffer.from(third.id).toString('base64url')}.${thirdEntry.hash}.json`
  );
  await fs.writeFile(thirdPath, JSON.stringify({ ...third, title: 'silently corrupted' }), 'utf8');
  await assert.rejects(readThreadById(third.id), /failed its checksum/);
  await writeThreadsPatch({ version: 2, upserts: [third], deletes: [], order: [second.id, third.id] });
  assert.deepEqual(await readThreadById(third.id), third, 'a later valid patch should repair corrupt bytes');

  const fourth = {
    ...second,
    id: 'thread-fourth',
    title: 'Fourth',
    messages: [{ role: 'agent', content: 'x'.repeat(1_500), ts: '2026-08-04T00:00:04.000Z' }],
  };
  const fifth = {
    ...second,
    id: 'thread-fifth',
    title: 'Fifth',
    messages: [{ role: 'agent', content: 'y'.repeat(1_500), ts: '2026-08-04T00:00:05.000Z' }],
  };
  const oversized = {
    ...second,
    id: 'thread-oversized',
    title: 'Oversized',
    messages: [{ role: 'agent', content: 'z'.repeat(8 * 1024 * 1024), ts: '2026-08-04T00:00:06.000Z' }],
  };
  const pagedManifest = await writeThreadsPatch({
    version: 2,
    upserts: [fourth, fifth, oversized],
    deletes: [],
    order: [second.id, third.id, fourth.id, fifth.id, oversized.id],
  });
  const allIds = [second.id, third.id, fourth.id, fifth.id, oversized.id];
  const packed = JSON.parse(await readThreadsBatch({ ids: allIds, maxBytes: 2_048 }));
  assert.ok(packed.threads.length > 1, 'small transcripts should share a batch');
  assert.ok(Buffer.byteLength(JSON.stringify(packed), 'utf8') <= 2_048, 'packed batches must honor their byte target');
  const batchedThreads = [];
  let sawOversizedBatch = false;
  for (let index = 0; index < allIds.length; ) {
    const batch = JSON.parse(await readThreadsBatch({ ids: allIds.slice(index), maxBytes: 1_024 }));
    assert.ok(batch.consumed > 0 && batch.threads.length > 0, 'every batch must make progress');
    assert.ok(
      batch.threads.length === 1 || Buffer.byteLength(JSON.stringify(batch), 'utf8') <= 1_024,
      'a batch may exceed its target only for one individually oversized thread'
    );
    if (batch.threads[0]?.id === oversized.id) {
      assert.equal(batch.threads.length, 1, 'an oversized transcript must be isolated to its own batch');
      sawOversizedBatch = true;
    }
    batchedThreads.push(...batch.threads);
    index += batch.consumed;
  }
  assert.equal(sawOversizedBatch, true, 'an individually oversized transcript must not block loading');
  assert.deepEqual(batchedThreads, [second, third, fourth, fifth, oversized], 'batches must keep the requested order');
  const sparse = JSON.parse(await readThreadsBatch({ ids: ['thread-gone', fifth.id, 'thread-missing'] }));
  assert.deepEqual(sparse.threads, [fifth], 'ids no longer stored are skipped');
  assert.equal(sparse.consumed, 3, 'skipped ids still count as covered');
  await assert.rejects(readThreadsBatch({ ids: 'nope' }), /threads batch/);

  // The head: the first `count` stored, the most recently active, the named
  // ids with their parents, and everything nested under any of those.
  const parent = { ...second, id: 'thread-parent', title: 'Parent', messages: [] , createdAt: '2026-07-01T00:00:00.000Z' };
  const child = { ...second, id: 'thread-child', parentThreadId: parent.id, subagent: true };
  const grandchild = { ...second, id: 'thread-grandchild', parentThreadId: child.id, subagent: true };
  const recent = {
    ...second,
    id: 'thread-recent',
    messages: [{ role: 'user', content: 'new', ts: '2026-09-01T00:00:00.000Z' }],
  };
  const pinned = { ...second, id: 'thread-pinned', pinnedAt: '2026-08-05T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', messages: [] };
  const headOrder = [...allIds, parent.id, child.id, grandchild.id, recent.id, pinned.id];
  await writeThreadsPatch({
    version: 2,
    upserts: [parent, child, grandchild, recent, pinned],
    deletes: [],
    order: headOrder,
  });
  const head = JSON.parse(await readThreadsHead({ count: 1, ids: [grandchild.id] }));
  assert.equal(head.present, true);
  assert.deepEqual(head.order, headOrder, 'the head carries the full stored order');
  assert.deepEqual(
    head.threads.map((thread) => thread.id),
    [second.id, parent.id, child.id, grandchild.id, recent.id, pinned.id],
    'the head holds the first, the most recent, pinned, and named threads with their family, in stored order'
  );
  assert.deepEqual(head.threads[0], second, 'head transcripts arrive intact');
  const parentHead = JSON.parse(await readThreadsHead({ count: 0, ids: [parent.id] }));
  assert.deepEqual(
    parentHead.threads.map((thread) => thread.id),
    [parent.id, child.id, grandchild.id, pinned.id],
    'a named thread brings every subagent thread under it'
  );

  await fs.writeFile(path.join(getThreadsDirectoryPath(), 'manifest.json'), '{broken', 'utf8');
  await assert.rejects(readAllThreads(), 'a corrupt v2 manifest must fail closed instead of reviving stale v1 data');
  await clearThreadsStorage();
  const absentHead = JSON.parse(await readThreadsHead({ count: 10 }));
  assert.equal(absentHead.present, false, 'absent storage must remain distinct from a failed read');
  assert.deepEqual(absentHead.threads, []);

  console.log('Thread storage migration, startup loading, and incremental persistence checks passed.');
} finally {
  await fs.rm(testDataDir, { recursive: true, force: true });
  app.quit();
}
