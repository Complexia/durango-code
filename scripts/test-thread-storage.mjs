import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
    readThreadRawSync,
    readThreadShells,
    readThreadsByIds,
    readThreadsForSync,
    resetThreadStorageStateForTests,
    retireLegacyThreadFiles,
    searchThreadBodies,
    searchThreadExcerpts,
    writeThreadsPatch,
    writeThreadsPatchSync,
  } = await import('../src/main/thread-storage.js');
  const { readThreadForAgent } = await import('../src/main/thread-reader.js');

  const encode = (id) => Buffer.from(id).toString('base64url');
  const fileOf = (name) => path.join(getThreadsDirectoryPath(), name);
  const entryOf = async (id) => (await readThreadsIndex()).entries.find((entry) => entry.id === id);
  const transcriptPath = (entry) => fileOf(`${encode(entry.id)}.${entry.transcriptHash}.transcript.json`);
  const shellPath = (entry) => fileOf(`${encode(entry.id)}.${entry.shellHash}.shell.json`);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shellOnly = ({ messages: _messages, btwExchanges: _asides, ...fields }) => fields;
  const fallbackOf = (entry) => ({ ...entry.shell, id: entry.id });

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
  assert.equal(index.version, 3);
  assert.deepEqual(index.entries.map((entry) => entry.id), [first.id, second.id]);
  assert.equal(index.entries[1].messageCount, 1);
  assert.ok(index.entries.every((entry) => entry.shellHash && entry.transcriptHash), 'each thread is a shell plus a transcript');

  const secondPath = transcriptPath(index.entries[1]);
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

  const thirdEntry = await entryOf(third.id);
  const thirdPath = transcriptPath(thirdEntry);
  await fs.writeFile(thirdPath, JSON.stringify({ messages: [] }), 'utf8');
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

  // Startup reads every thread's shell from the manifest, plus the stored
  // threads the renderer names (its open panes), and no other transcript.
  const parent = { ...second, id: 'thread-parent', title: 'Parent', messages: [], createdAt: '2026-07-01T00:00:00.000Z' };
  const child = {
    ...second,
    id: 'thread-child',
    parentThreadId: parent.id,
    pinnedAt: '2026-08-05T00:00:00.000Z',
    subagent: { id: 'sa-1', providerId: 'claude', kind: 'Explore', prompt: 'p'.repeat(5_000), summary: 'final report' },
    messages: [
      { id: 'c1', role: 'user', content: 'look into the migration bug', ts: '2026-08-04T00:00:01.000Z' },
      {
        id: 'c2',
        role: 'agent',
        kind: 'agent-run',
        status: 'done',
        content: 'Found it: the Flaky Migration drops a column.',
        ts: '2026-08-04T00:00:02.000Z',
        startedAt: '2026-08-04T00:00:02.000Z',
        completedAt: '2026-08-04T00:00:12.000Z',
      },
    ],
  };
  const shellOrder = [...allIds, parent.id, child.id];
  await writeThreadsPatch({ version: 2, upserts: [parent, child], deletes: [], order: shellOrder });
  const startup = JSON.parse(await readThreadShells({ ids: [parent.id] }));
  assert.equal(startup.present, true);
  assert.deepEqual(startup.shells.map((shell) => shell.id), shellOrder, 'every shell, in stored order');
  assert.ok(startup.shells.every((shell) => !('messages' in shell)), 'shells carry no transcript');
  assert.deepEqual(startup.threads, [parent], 'only the named threads arrive whole');
  const childShell = startup.shells.find((shell) => shell.id === child.id);
  assert.equal(childShell.title, child.title);
  assert.equal(childShell.summary.messageCount, 2);
  assert.equal(childShell.summary.lastAgentRun.id, 'c2');
  assert.equal(childShell.summary.workedMs, 10_000);
  assert.equal(childShell.summary.hasUserMessage, true);
  assert.deepEqual(childShell.subagent, { id: 'sa-1', providerId: 'claude', kind: 'Explore' }, 'subagent details stay out of shells');

  // A shell-only save never reads or writes the transcript: with the
  // transcript file unreadable, a rename still saves, and the file keeps its
  // bytes and mtime. It keeps the stored transcript and subagent details, and
  // takes every shell field as sent — including one the renderer removed.
  const childBefore = await entryOf(child.id);
  const childTranscriptPath = transcriptPath(childBefore);
  const childTranscriptBytes = await fs.readFile(childTranscriptPath, 'utf8');
  const childTranscriptStat = await fs.stat(childTranscriptPath);
  const listing = async () =>
    new Map(
      await Promise.all(
        (await fs.readdir(getThreadsDirectoryPath())).map(async (name) => [name, (await fs.stat(fileOf(name))).mtimeMs])
      )
    );
  const filesBeforeRename = await listing();
  await sleep(20);
  await fs.chmod(childTranscriptPath, 0o000);
  const { messages: _childMessages, ...childFields } = child;
  const { pinnedAt: _unpinned, ...unpinnedFields } = childFields;
  try {
    await writeThreadsPatch({
      version: 2,
      upserts: [],
      shells: [{ ...unpinnedFields, title: 'Renamed', subagent: { id: 'sa-1', providerId: 'claude', kind: 'Explore' }, summary: { messageCount: 0 } }],
      deletes: [],
    });
  } finally {
    await fs.chmod(childTranscriptPath, 0o644);
  }
  const childAfter = await entryOf(child.id);
  assert.equal(childAfter.transcriptHash, childBefore.transcriptHash, 'the transcript version is unchanged');
  assert.notEqual(childAfter.shellHash, childBefore.shellHash);
  assert.notEqual(childAfter.hash, childBefore.hash, 'the thread version (what workspace sync watches) changes');
  assert.equal(await fs.readFile(childTranscriptPath, 'utf8'), childTranscriptBytes);
  assert.equal((await fs.stat(childTranscriptPath)).mtimeMs, childTranscriptStat.mtimeMs, 'the transcript file is not rewritten');
  assert.ok((await fs.stat(shellPath(childAfter))).size < 6_000, 'only a small shell file is written');
  const writtenByRename = [...(await listing())].filter(([name, mtime]) => filesBeforeRename.get(name) !== mtime).map(([name]) => name);
  assert.deepEqual(
    writtenByRename
      .map((name) =>
        name === 'manifest.json'
          ? 'root'
          : name === 'manifest.prev.json'
            ? 'previous root'
            : name.startsWith('manifest.')
              ? 'shard'
              : name.endsWith('.shell.json')
                ? 'shell'
                : name
      )
      .sort(),
    ['previous root', 'root', 'shard', 'shell'],
    'a rename writes the shell, its manifest shard, the manifest root and the fallback root: nothing else'
  );
  const renamedChild = await readThreadById(child.id);
  assert.equal(renamedChild.title, 'Renamed');
  assert.equal(renamedChild.pinnedAt, undefined, 'a removed shell field is removed');
  assert.deepEqual(renamedChild.messages, child.messages, 'the stored messages survive a shell-only save');
  assert.deepEqual(renamedChild.subagent, child.subagent, 'and so do the subagent details');
  assert.equal('summary' in renamedChild, false, 'summaries are never stored in thread files');
  assert.equal(childAfter.summary.messageCount, 2, 'the summary stays with the unchanged transcript');

  // Every reader sees the newest shell, with the stored transcript.
  const readers = {
    readThreadById: async () => readThreadById(child.id),
    readThreadsByIds: async () => (await readThreadsByIds([child.id]))[0],
    readAllThreads: async () => (await readAllThreads()).find((thread) => thread.id === child.id),
    readThreadsBatch: async () => JSON.parse(await readThreadsBatch({ ids: [child.id] })).threads[0],
    readThreadShells: async () => JSON.parse(await readThreadShells({ ids: [child.id] })).threads[0],
    readThreadRawSync: async () => JSON.parse(readThreadRawSync(child.id)),
  };
  for (const [name, read] of Object.entries(readers)) {
    const thread = await read();
    assert.equal(thread.title, 'Renamed', `${name} sees the new shell`);
    assert.deepEqual(thread.messages, child.messages, `${name} sees the stored transcript`);
  }
  assert.equal((await entryOf(child.id)).title, 'Renamed', 'the index sees it');
  assert.equal(
    JSON.parse(await readThreadShells({ ids: [] })).shells.find((shell) => shell.id === child.id).title,
    'Renamed',
    'the startup shells see it'
  );
  assert.match(await readThreadForAgent({ thread_id: child.id }), /# Durango Code thread "Renamed"/, 'read_thread sees it');

  writeThreadsPatchSync({ version: 2, upserts: [], shells: [{ ...childFields, title: 'Renamed on quit' }], deletes: [] });
  assert.equal((await entryOf(child.id)).transcriptHash, childBefore.transcriptHash, 'the quit-time shell save keeps the transcript');
  assert.deepEqual((await readThreadById(child.id)).messages, child.messages);
  assert.equal((await readThreadById(child.id)).title, 'Renamed on quit');
  assert.equal(JSON.parse(readThreadRawSync(child.id)).title, 'Renamed on quit');

  // The quit-time read: verified stored JSON, null for an unknown thread.
  assert.deepEqual(JSON.parse(readThreadRawSync(child.id)).messages, child.messages);
  assert.equal(readThreadRawSync('thread-unknown'), null);

  // Interleaved transcript and shell saves: each keeps the other's latest.
  const grown = {
    ...child,
    title: 'Renamed on quit',
    messages: [...child.messages, { id: 'c3', role: 'user', content: 'and then?', ts: '2026-08-04T00:00:20.000Z' }],
  };
  await writeThreadsPatch({ version: 2, upserts: [grown], deletes: [] });
  await writeThreadsPatch({
    version: 2,
    upserts: [],
    shells: [{ ...shellOnly(grown), pinnedAt: '2026-08-06T00:00:00.000Z' }],
    deletes: [],
  });
  writeThreadsPatchSync({
    version: 2,
    upserts: [
      {
        ...grown,
        pinnedAt: '2026-08-06T00:00:00.000Z',
        messages: [...grown.messages, { id: 'c4', role: 'agent', content: 'done', ts: '2026-08-04T00:00:21.000Z' }],
      },
    ],
    deletes: [],
  });
  await writeThreadsPatch({
    version: 2,
    upserts: [],
    shells: [{ ...shellOnly(grown), pinnedAt: '2026-08-06T00:00:00.000Z', title: 'Final title' }],
    deletes: [],
  });
  const interleaved = await readThreadById(child.id);
  assert.equal(interleaved.title, 'Final title');
  assert.equal(interleaved.pinnedAt, '2026-08-06T00:00:00.000Z');
  assert.deepEqual(interleaved.messages.map((message) => message.id), ['c1', 'c2', 'c3', 'c4']);
  assert.equal((await entryOf(child.id)).messageCount, 4);
  // Pin, unpin, pin again: the shell returns to a version whose file the
  // first cleanup retires. It must still be there once cleanups have run.
  const pinned = { ...shellOnly(interleaved), pinnedAt: '2026-08-07T00:00:00.000Z' };
  await writeThreadsPatch({ version: 2, upserts: [], shells: [pinned], deletes: [] });
  await writeThreadsPatch({ version: 2, upserts: [], shells: [{ ...pinned, pinnedAt: undefined }], deletes: [] });
  await sleep(950);
  await writeThreadsPatch({ version: 2, upserts: [], shells: [pinned], deletes: [] });
  await sleep(1_300);
  assert.equal((await readThreadById(child.id)).pinnedAt, '2026-08-07T00:00:00.000Z', 'a shell version reused after a cleanup is intact');

  // A transcript that can't be read: a shell save still works (it doesn't
  // touch the transcript) and the transcript stays as stored.
  const parentEntry = await entryOf(parent.id);
  const parentPath = transcriptPath(parentEntry);
  const parentBytes = await fs.readFile(parentPath, 'utf8');
  await fs.writeFile(parentPath, parentBytes.replace('[]', '[{"tampered":true}]'), 'utf8');
  await assert.rejects(readThreadById(parent.id), /failed its checksum/);
  await writeThreadsPatch({ version: 2, upserts: [], shells: [{ ...shellOnly(parent), title: 'Still renamable' }], deletes: [] });
  assert.equal((await entryOf(parent.id)).transcriptHash, parentEntry.transcriptHash, 'its transcript version is kept');
  assert.equal((await entryOf(parent.id)).title, 'Still renamable');
  assert.throws(() => readThreadRawSync(parent.id), /failed its checksum/, 'the quit-time read verifies too');
  await fs.writeFile(parentPath, parentBytes, 'utf8');

  // A shell save of a thread that was never stored starts it empty.
  await writeThreadsPatch({ version: 2, upserts: [], shells: [{ ...shellOnly(parent), id: 'thread-new', title: 'New' }], deletes: [] });
  assert.deepEqual((await readThreadById('thread-new')).messages, []);

  // Full-text search runs here against the stored transcripts.
  const longToken = 'p'.repeat(250);
  const { tokens: scoredTokens, scores } = await searchThreadBodies({ tokens: [longToken, 'migration', 'zzzz', 'flak'] });
  assert.deepEqual(scoredTokens, ['migration', 'zzzz', 'flak'], 'the tokens it scored are named (an over-long one is skipped)');
  assert.deepEqual(scores[child.id], [18, 0, 18], 'word starts score as words, misses as zero');
  assert.equal(scores[parent.id], undefined, 'threads matching no token are left out');
  // A newer query supersedes the scan in flight (typing asks for each prefix).
  const [superseded, latest] = await Promise.all([
    searchThreadBodies({ tokens: ['migr'] }),
    searchThreadBodies({ tokens: ['migration'] }),
  ]);
  assert.equal(superseded, null, 'the superseded scan stops and says so');
  assert.deepEqual(latest.scores[child.id], [18]);
  const excerpts = await searchThreadExcerpts({ items: [{ id: child.id, tokens: ['column'] }] });
  assert.match(excerpts[child.id], /drops a column/);

  // A synchronous save (quit, window reload) that commits while an async save
  // is writing its files must not be overwritten by it: the async save
  // computes its patch again on top.
  // A read that fails for now (EIO, EMFILE) is retried, and never opens the
  // previous root: that would roll the last save back.
  await writeThreadsPatch({ version: 2, upserts: [], shells: [{ ...shellOnly(fifth), title: 'Fifth (latest)' }], deletes: [] });
  const realReadFile = fs.readFile;
  let failures = 1;
  fs.readFile = async (filePath, ...rest) => {
    if (failures > 0 && String(filePath).includes(`${path.sep}manifest.`) && !String(filePath).endsWith('prev.json')) {
      failures -= 1;
      throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
    }
    return realReadFile(filePath, ...rest);
  };
  try {
    resetThreadStorageStateForTests();
    assert.equal((await entryOf(fifth.id)).title, 'Fifth (latest)', 'a transient read error is retried, not rolled back');
    failures = Number.POSITIVE_INFINITY;
    resetThreadStorageStateForTests();
    await assert.rejects(readThreadsIndex(), /EIO/, 'a persistent one fails rather than opening the previous root');
  } finally {
    fs.readFile = realReadFile;
  }
  resetThreadStorageStateForTests();
  assert.equal((await entryOf(fifth.id)).title, 'Fifth (latest)');
  await assert.rejects(fs.access(fileOf('manifest.damaged.json')), 'nothing was treated as damage');

  const racing = writeThreadsPatch({
    version: 2,
    upserts: [{ ...fourth, title: 'Fourth (async)', messages: [...fourth.messages, { role: 'user', content: 'more', ts: '2026-08-04T00:00:09.000Z' }] }],
    deletes: [],
  });
  await sleep(0);
  writeThreadsPatchSync({ version: 2, upserts: [], shells: [{ ...shellOnly(fifth), title: 'Fifth (sync)' }], deletes: [] });
  await racing;
  assert.equal((await readThreadById(fifth.id)).title, 'Fifth (sync)', 'the synchronous save survives the async one');
  assert.equal((await readThreadById(fourth.id)).title, 'Fourth (async)', 'and the async one lands too');
  assert.equal((await readThreadById(fourth.id)).messages.length, 2);

  // The reviewer's sequence: an async save is writing its files when the
  // quit/reload flush commits newer state of the same thread. The newer
  // commit wins: the async save drops what it would have overwritten.
  const seq = { ...second, id: 'thread-seq', title: 'Seq', messages: [{ id: 'a', role: 'user', content: 'a', ts: '2026-08-04T00:00:01.000Z' }] };
  await writeThreadsPatch({ version: 2, upserts: [seq], deletes: [] });
  const withB = { ...seq, messages: [...seq.messages, { id: 'b', role: 'agent', content: 'b', ts: '2026-08-04T00:00:02.000Z' }] };
  const asyncSave = writeThreadsPatch({ version: 2, upserts: [withB, { ...third, title: 'Third (async only)' }], deletes: [] });
  await sleep(0);
  writeThreadsPatchSync({
    version: 2,
    upserts: [{ ...withB, messages: [...withB.messages, { id: 'c', role: 'user', content: 'c', ts: '2026-08-04T00:00:03.000Z' }] }],
    deletes: [],
  });
  await asyncSave;
  assert.deepEqual(
    (await readThreadById('thread-seq')).messages.map((message) => message.id),
    ['a', 'b', 'c'],
    'the newer synchronous commit is not overwritten by the older async save'
  );
  assert.equal((await readThreadById(third.id)).title, 'Third (async only)', "the async save's other threads still land");

  // Recovery: a torn shard shared by the current and previous roots (an
  // unchanged shard) still opens the store with every thread, rebuilt from
  // the thread files, as of the newest verified files.
  await writeThreadsPatch({ version: 2, upserts: [], shells: [{ ...shellOnly(fifth), title: 'Fifth (last save)' }], deletes: [] });
  const idsBefore = (await readThreadsIndex()).entries.map((entry) => entry.id).sort();
  const rootNow = JSON.parse(await fs.readFile(fileOf('manifest.json'), 'utf8'));
  const rootBefore = JSON.parse(await fs.readFile(fileOf('manifest.prev.json'), 'utf8'));
  const sharedShard = Object.entries(rootNow.shards).find(([key, hash]) => rootBefore.shards[key] === hash);
  assert.ok(sharedShard, 'some shard is shared by both roots');
  const sharedPath = fileOf(`manifest.${sharedShard[0]}.${sharedShard[1]}.json`);
  await fs.writeFile(sharedPath, (await fs.readFile(sharedPath, 'utf8')).slice(0, 10), 'utf8');
  resetThreadStorageStateForTests();
  const rebuilt = await readThreadsIndex();
  assert.deepEqual(rebuilt.entries.map((entry) => entry.id).sort(), idsBefore, 'every thread is still there');
  assert.equal((await entryOf(fifth.id)).title, 'Fifth (last save)', 'as of the newest save');
  for (const id of idsBefore) {
    if (id === parent.id) continue;
    assert.ok((await readThreadById(id)).messages, `${id} reads whole`);
  }
  assert.ok((await fs.readdir(getThreadsDirectoryPath())).some((name) => /^manifest\.damaged-\d+\.json$/.test(name)), 'a copy of the damaged root is kept');
  // Both roots torn: everything is rebuilt from the thread files.
  await writeThreadsPatch({ version: 2, upserts: [], shells: [{ ...shellOnly(fifth), title: 'Fifth again' }], deletes: [] });
  await fs.writeFile(fileOf('manifest.json'), '{broken', 'utf8');
  await fs.writeFile(fileOf('manifest.prev.json'), '{broken', 'utf8');
  resetThreadStorageStateForTests();
  assert.deepEqual((await readThreadsIndex()).entries.map((entry) => entry.id).sort(), idsBefore, 'every thread, rebuilt from files');
  assert.equal((await entryOf(fifth.id)).title, 'Fifth again', 'at its newest verified version');
  assert.deepEqual((await readThreadById(child.id)).messages.map((message) => message.id), ['c1', 'c2', 'c3', 'c4']);
  // The store works normally afterwards.
  await writeThreadsPatch({ version: 2, upserts: [], shells: [{ ...shellOnly(fifth), title: 'Fifth after recovery' }], deletes: [] });
  resetThreadStorageStateForTests();
  assert.equal((await entryOf(fifth.id)).title, 'Fifth after recovery');

  // Damaged copies protect only the threads they name, and only for a week:
  // cleanup is never stuck.
  for (const name of await fs.readdir(getThreadsDirectoryPath())) {
    if (/^manifest\.damaged-/.test(name)) await fs.rm(fileOf(name));
  }
  const expiredCopy = `manifest.damaged-${Date.now() - 8 * 24 * 60 * 60 * 1000}.json`;
  await fs.writeFile(fileOf(expiredCopy), '{', 'utf8');
  const recentCopy = `manifest.damaged-${Date.now()}.json`;
  await fs.writeFile(fileOf(recentCopy), JSON.stringify({ order: [fifth.id] }), 'utf8');
  const protectedOrphan = `${encode(fifth.id)}.${'2'.repeat(64)}.shell.json`;
  const plainOrphan = `${encode(second.id)}.${'3'.repeat(64)}.shell.json`;
  const anHour = new Date(Date.now() - 60 * 60 * 1000);
  for (const name of [protectedOrphan, plainOrphan]) {
    await fs.writeFile(fileOf(name), '{}', 'utf8');
    await fs.utimes(fileOf(name), anHour, anHour);
  }
  resetThreadStorageStateForTests();
  await readThreadsIndex();
  const afterProtectedSweep = await fs.readdir(getThreadsDirectoryPath());
  assert.ok(!afterProtectedSweep.includes(expiredCopy), 'a damaged copy older than a week goes');
  assert.ok(afterProtectedSweep.includes(recentCopy));
  assert.ok(afterProtectedSweep.includes(protectedOrphan), 'files of a thread a recent damaged copy names are kept');
  assert.ok(!afterProtectedSweep.includes(plainOrphan), 'other leftovers are still cleaned up');
  await clearThreadsStorage();

  // --- Migration from version 2 (one combined file per thread).
  const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const v2Threads = [
    { ...child, id: 'v2-a', title: 'A' },
    {
      ...second,
      id: 'v2-b',
      title: 'B',
      btwExchanges: [{ id: 'x', question: 'q', answer: 'a', status: 'done', createdAt: '2026-08-04T00:00:00.000Z' }],
    },
    { ...first, id: 'v2-broken', title: 'Broken' },
  ];
  const v2FileName = (entry) => `${encode(entry.id)}.${entry.hash}.json`;
  const writeV2 = async () => {
    await fs.mkdir(getThreadsDirectoryPath(), { recursive: true });
    const entries = [];
    for (const thread of v2Threads) {
      const serialized = JSON.stringify(thread);
      const entry = {
        id: thread.id,
        hash: sha(serialized),
        title: thread.title,
        projectId: thread.projectId,
        status: thread.status,
        modelId: thread.modelId,
        createdAt: thread.createdAt,
        messageCount: thread.messages.length,
        // Entries this change's earlier builds upgraded carry a shell.
        ...(thread.id === 'v2-a'
          ? { shellVersion: 1, shell: { ...shellOnly(thread), subagent: { id: 'sa-1', providerId: 'claude' } }, summary: {} }
          : {}),
      };
      // The broken one's bytes don't match their hash.
      await fs.writeFile(
        fileOf(v2FileName(entry)),
        thread.id === 'v2-broken' ? serialized.replace('one', 'uno') : serialized,
        'utf8'
      );
      await fs.writeFile(fileOf(`${v2FileName(entry)}.search`), 'old search text', 'utf8');
      entries.push(entry);
    }
    await fs.writeFile(fileOf('manifest.json'), JSON.stringify({ version: 2, revision: 7, entries }), 'utf8');
    return entries;
  };
  const v2Entries = await writeV2();
  resetThreadStorageStateForTests();
  // An interrupted earlier attempt left some version 3 files and a temp file.
  const partial = v2Threads[0];
  const partialShell = JSON.stringify(shellOnly(partial));
  await fs.writeFile(fileOf(`${encode(partial.id)}.${sha(partialShell)}.shell.json`), partialShell, 'utf8');
  const leftover = `${encode(partial.id)}.${'0'.repeat(64)}.transcript.json`;
  await fs.writeFile(fileOf(leftover), '{"messages":[', 'utf8');
  // An interrupted attempt's files are old by the next launch; a fresh
  // unreferenced file may belong to a save that hasn't committed yet.
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  await fs.utimes(fileOf(leftover), anHourAgo, anHourAgo);
  const uncommitted = `${encode(partial.id)}.${'1'.repeat(64)}.transcript.json`;
  await fs.writeFile(fileOf(uncommitted), '{"messages":[]}', 'utf8');
  await fs.writeFile(fileOf('stray.123.transcript.tmp'), 'partial', 'utf8');
  const staleTemp = 'manifest.json.456.manifest.tmp';
  await fs.writeFile(fileOf(staleTemp), 'partial', 'utf8');
  const longAgo = new Date(Date.now() - 60 * 60 * 1000);
  await fs.utimes(fileOf(staleTemp), longAgo, longAgo);

  const migrated = await readThreadsIndex();
  assert.equal(migrated.version, 3);
  assert.equal(migrated.revision, 8);
  assert.deepEqual(migrated.entries.map((entry) => entry.id), ['v2-a', 'v2-b', 'v2-broken'], 'every thread is kept, in order');
  assert.deepEqual(await readThreadById('v2-a'), v2Threads[0], 'migrated threads read back whole');
  assert.deepEqual(await readThreadById('v2-b'), v2Threads[1], 'asides go with the transcript');
  assert.equal((await entryOf('v2-a')).summary.messageCount, 2, 'summaries are computed in the migration');
  await assert.rejects(readThreadById('v2-broken'), /could not be read/, 'an unreadable thread is reported, not invented');
  assert.equal((await entryOf('v2-broken')).title, 'Broken', 'and still listed');
  const brokenFile = v2FileName(v2Entries[2]);
  const migratingLaunch = await fs.readdir(getThreadsDirectoryPath());
  for (const entry of v2Entries) {
    assert.ok(migratingLaunch.includes(v2FileName(entry)), 'the launch that migrated keeps every version 2 file');
  }
  assert.equal(await retireLegacyThreadFiles(), 0, 'nor does it retire them');
  assert.equal((await entryOf('v2-a')).syncHash, v2Entries[0].hash, 'a migrated entry keeps the hash sync uploaded it under');
  const [forSync] = await readThreadsForSync(['v2-a']);
  assert.equal(forSync.version, v2Entries[0].hash, 'and syncs under it while unchanged');
  // The next launch sweeps the disposable leftovers, and retires the version
  // 2 thread files in the background once the new files verify.
  resetThreadStorageStateForTests();
  await readThreadsIndex();
  assert.equal(await retireLegacyThreadFiles(), 2);
  const names = await fs.readdir(getThreadsDirectoryPath());
  assert.ok(names.includes(brokenFile), 'its version 2 file is kept for recovery');
  for (const entry of v2Entries.slice(0, 2)) {
    assert.ok(!names.includes(v2FileName(entry)), 'other version 2 files are removed once the new ones verify');
  }
  assert.ok(!names.some((name) => name.endsWith('.json.search')), 'and their search texts');
  assert.ok(!names.includes(leftover), 'an interrupted attempt leftover is removed');
  assert.ok(names.includes(uncommitted), 'a fresh unreferenced file is kept: it may belong to a save in flight');
  assert.ok(names.includes('stray.123.transcript.tmp'), 'temp files of writes in flight are left alone');
  assert.ok(!names.includes(staleTemp), 'a temp file an old failed write left is removed');
  assert.ok(names.some((name) => /\.[0-9a-f]{64}\.search$/.test(name)), 'search texts are built');
  // Running again changes nothing.
  resetThreadStorageStateForTests();
  assert.deepEqual(await readThreadsIndex(), JSON.parse(JSON.stringify(migrated)), 'the migration runs once');
  // The first save of a migrated thread drops its syncHash: from then on its
  // own version is what syncs.
  await writeThreadsPatch({ version: 2, upserts: [], shells: [{ ...shellOnly(v2Threads[1]), title: 'B renamed' }], deletes: [] });
  assert.equal((await entryOf('v2-b')).syncHash, undefined);
  assert.equal((await readThreadsForSync(['v2-b']))[0].version, (await entryOf('v2-b')).hash);
  assert.match((await readThreadsForSync(['v2-broken']))[0].error, /could not be read/, 'sync gets an error, not a throw');
  // The unreadable thread can still be renamed and deleted.
  await writeThreadsPatch({
    version: 2,
    upserts: [],
    shells: [{ ...fallbackOf(await entryOf('v2-broken')), title: 'Broken (renamed)' }],
    deletes: [],
  });
  assert.equal((await entryOf('v2-broken')).title, 'Broken (renamed)');
  await assert.rejects(readThreadById('v2-broken'), /could not be read/, 'renaming it invents no transcript');
  await writeThreadsPatch({ version: 2, upserts: [], deletes: ['v2-broken'] });
  // Its file is still named by the previous root (the fallback) until the
  // next save, and removed after that.
  await writeThreadsPatch({ version: 2, upserts: [], shells: [{ ...shellOnly(v2Threads[1]), title: 'B again' }], deletes: [] });
  await sleep(1_300);
  assert.ok(!(await fs.readdir(getThreadsDirectoryPath())).includes(brokenFile), 'deleting it removes its file');

  // Power loss right after the migration: one thread's new transcript, and
  // another's shell, never reached the disk in full (sizes right, data not).
  await clearThreadsStorage();
  await writeV2();
  resetThreadStorageStateForTests();
  await readThreadsIndex();
  const committed = await fs.readFile(fileOf('manifest.json'), 'utf8');
  const damagedTranscript = await entryOf('v2-a');
  const transcriptBytes = (await fs.stat(transcriptPath(damagedTranscript))).size;
  await fs.writeFile(transcriptPath(damagedTranscript), '\0'.repeat(transcriptBytes), 'utf8');
  const damagedShell = await entryOf('v2-b');
  await fs.writeFile(shellPath(damagedShell), '', 'utf8');
  resetThreadStorageStateForTests();
  // Readers recover each from its version 2 file and rewrite the new file.
  assert.deepEqual(await readThreadById('v2-a'), v2Threads[0], 'a damaged transcript is read from the version 2 file');
  assert.deepEqual(JSON.parse(readThreadRawSync('v2-b')), v2Threads[1], 'a damaged shell too (sync path as well)');
  assert.equal(
    crypto.createHash('sha256').update(await fs.readFile(transcriptPath(damagedTranscript), 'utf8')).digest('hex'),
    damagedTranscript.transcriptHash,
    'and the new file is written again'
  );
  // Retiring verifies content, not sizes: a damaged new file keeps its
  // version 2 file (after rewriting the new one) until a later run.
  await fs.writeFile(transcriptPath(damagedTranscript), '\0'.repeat(transcriptBytes), 'utf8');
  assert.equal(await retireLegacyThreadFiles(), 1, 'only the thread whose new files verify loses its old file');
  const afterRetire = await fs.readdir(getThreadsDirectoryPath());
  assert.ok(afterRetire.includes(v2FileName(v2Entries[0])), 'the damaged one keeps it');
  assert.ok(!afterRetire.includes(v2FileName(v2Entries[1])));
  assert.equal(await retireLegacyThreadFiles(), 1, 'and loses it once its rewritten files verify');
  assert.deepEqual(await readThreadById('v2-a'), v2Threads[0]);
  assert.equal(await fs.readFile(fileOf('manifest.json'), 'utf8'), committed, 'the committed manifest is untouched');

  // A transcript save drops the current entry's pointer, but the previous
  // root (the recovery fallback) still names the migrated version: its v2
  // file stays until that root moves on.
  await clearThreadsStorage();
  await writeV2();
  resetThreadStorageStateForTests();
  await readThreadsIndex();
  resetThreadStorageStateForTests();
  const migratedA = await readThreadById('v2-a');
  await writeThreadsPatch({ version: 2, upserts: [{ ...migratedA, messages: [...migratedA.messages, { id: 'n', role: 'user', content: 'n', ts: '2026-08-05T00:00:00.000Z' }] }], deletes: [] });
  assert.equal((await entryOf('v2-a')).legacyHash, undefined);
  await retireLegacyThreadFiles();
  assert.ok((await fs.readdir(getThreadsDirectoryPath())).includes(v2FileName(v2Entries[0])), 'kept while the previous root points at it');
  await writeThreadsPatch({ version: 2, upserts: [], shells: [{ ...shellOnly(v2Threads[1]), title: 'B moves the roots on' }], deletes: [] });
  await retireLegacyThreadFiles();
  assert.ok(!(await fs.readdir(getThreadsDirectoryPath())).includes(v2FileName(v2Entries[0])), 'and goes once it no longer does');

  // The reviewer's sequence: a migrated transcript never reached the disk,
  // then the thread is renamed (a shell-only save, which drops syncHash)
  // without being opened, then retirement runs. The version 2 file must stay,
  // and the thread must still read whole.
  await clearThreadsStorage();
  await writeV2();
  resetThreadStorageStateForTests();
  await readThreadsIndex();
  const notDurable = await entryOf('v2-a');
  await fs.writeFile(transcriptPath(notDurable), '', 'utf8');
  resetThreadStorageStateForTests();
  await readThreadsIndex();
  await writeThreadsPatch({ version: 2, upserts: [], shells: [{ ...shellOnly(v2Threads[0]), title: 'A renamed' }], deletes: [] });
  const renamedEntry = await entryOf('v2-a');
  assert.equal(renamedEntry.syncHash, undefined, 'the save drops the sync hash');
  assert.equal(renamedEntry.legacyHash, v2Entries[0].hash, 'but keeps the recovery pointer: the transcript is still the migrated one');
  await fs.writeFile(transcriptPath(renamedEntry), '', 'utf8');
  assert.equal(await retireLegacyThreadFiles(), 1, 'only the healthy thread retires its file');
  assert.ok((await fs.readdir(getThreadsDirectoryPath())).includes(v2FileName(v2Entries[0])), 'the renamed thread keeps its v2 file');
  const recoveredThread = await readThreadById('v2-a');
  assert.equal(recoveredThread.title, 'A renamed', 'with its new shell');
  assert.deepEqual(recoveredThread.messages, v2Threads[0].messages, 'and the transcript recovered from the v2 file');
  // A transcript save ends the pointer; the copy then goes on the next run.
  await writeThreadsPatch({ version: 2, upserts: [{ ...recoveredThread, messages: [...recoveredThread.messages, { id: 'x', role: 'user', content: 'new', ts: '2026-08-05T00:00:00.000Z' }] }], deletes: [] });
  assert.equal((await entryOf('v2-a')).legacyHash, undefined);
  // (Once the previous root no longer points at it either.)
  await writeThreadsPatch({ version: 2, upserts: [], shells: [{ ...shellOnly(v2Threads[1]), title: 'B, later' }], deletes: [] });
  assert.equal(await retireLegacyThreadFiles(), 1);
  assert.ok(!(await fs.readdir(getThreadsDirectoryPath())).includes(v2FileName(v2Entries[0])));

  // The quit-time path can migrate too.
  await clearThreadsStorage();
  await writeV2();
  resetThreadStorageStateForTests();
  writeThreadsPatchSync({ version: 2, upserts: [], shells: [{ ...shellOnly(v2Threads[1]), title: 'B on quit' }], deletes: [] });
  assert.equal((await readThreadsIndex()).version, 3);
  assert.equal((await readThreadById('v2-b')).title, 'B on quit');
  assert.deepEqual((await readThreadById('v2-b')).messages, v2Threads[1].messages);
  await clearThreadsStorage();
  resetThreadStorageStateForTests();

  const absent = JSON.parse(await readThreadShells({ ids: [] }));
  assert.equal(absent.present, false, 'absent storage must remain distinct from a failed read');
  assert.deepEqual(absent.shells, []);

  console.log('Thread storage migration, startup loading, and incremental persistence checks passed.');
} finally {
  await fs.rm(testDataDir, { recursive: true, force: true });
  app.quit();
}
