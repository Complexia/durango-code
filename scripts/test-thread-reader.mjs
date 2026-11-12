import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

const testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-thread-reader-'));
app.setPath('userData', testDataDir);

try {
  const { getStorageFilePath, getThreadsFilePath } = await import('../src/main/paths.js');
  const { writeThreadsPatch } = await import('../src/main/thread-storage.js');
  const { readThreadForAgent } = await import('../src/main/thread-reader.js');
  const thread = {
    id: 'thread-12345678-abcd',
    projectId: 'project-1',
    title: 'Pagination regression',
    status: 'idle',
    modelId: 'codex:test',
    createdAt: '2026-08-02T00:00:00.000Z',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'agent', content: 'second' },
    ],
  };
  const persistThread = () =>
    writeThreadsPatch({ version: 2, upserts: [thread], deletes: [], order: [thread.id] });

  await fs.writeFile(
    getThreadsFilePath(),
    JSON.stringify({ version: 1, threads: [thread] }),
    'utf8'
  );
  await fs.writeFile(
    getStorageFilePath(),
    JSON.stringify({ state: { projects: [{ id: 'project-1', name: 'Orion', path: '/tmp/orion' }] } }),
    'utf8'
  );

  const finalPage = await readThreadForAgent({ thread_id: thread.id, offset: 2, limit: 1 });
  assert.match(finalPage, /Showing messages 2–2 of 2/);
  assert.match(finalPage, /second/);

  const afterEnd = await readThreadForAgent({ thread_id: thread.id, offset: 3, limit: 1 });
  assert.match(afterEnd, /Requested offset 3 is past the end of this transcript \(2 messages\)/);
  assert.doesNotMatch(afterEnd, /### Message 2\/2/);
  assert.doesNotMatch(afterEnd, /second/);

  thread.messages = [
    {
      role: 'agent',
      status: 'stopped',
      content: 'Tool evidence follows.',
      activities: [
        {
          title: 'Read source file',
          detail: '/tmp/example.txt',
          input: `path=/tmp/example.txt\n${'i'.repeat(2500)}`,
          output: `essential persisted result\n${'o'.repeat(4500)}`,
        },
      ],
    },
  ];
  await persistThread();
  const toolEvidence = await readThreadForAgent({ thread_id: thread.id });
  assert.match(toolEvidence, /Input:\n    path=\/tmp\/example\.txt/);
  assert.match(toolEvidence, /Output:\n    essential persisted result/);
  assert.match(toolEvidence, /\[activity input truncated\]/);
  assert.match(toolEvidence, /\[activity output truncated\]/);

  thread.messages = [
    {
      role: 'user',
      content: '',
      linkedTasks: [
        {
          id: 'task-1',
          title: 'Preserve linked task prompts',
          description: 'Make linked-task-only turns readable from another thread.',
        },
        {
          id: 'task-2',
          title: 'Keep the second task visible',
          description: 'Include every originating task title and description.',
        },
      ],
    },
  ];
  await persistThread();
  const linkedTaskPrompt = await readThreadForAgent({ thread_id: thread.id });
  assert.match(linkedTaskPrompt, /Linked board tasks \(2\):/);
  assert.match(linkedTaskPrompt, /Preserve linked task prompts/);
  assert.match(linkedTaskPrompt, /Make linked-task-only turns readable from another thread\./);
  assert.match(linkedTaskPrompt, /Keep the second task visible/);
  assert.match(linkedTaskPrompt, /Include every originating task title and description\./);
  assert.doesNotMatch(linkedTaskPrompt, /\(empty message\)/);

  thread.messages = [
    {
      role: 'agent',
      content: 'Large metadata page',
      changedFiles: Array.from({ length: 2000 }, (_, index) => ({
        path: `/tmp/${index}-${'x'.repeat(80)}.txt`,
        status: 'modified',
      })),
    },
  ];
  await persistThread();
  const cappedPage = await readThreadForAgent({ thread_id: thread.id, limit: 1 });
  assert.ok(cappedPage.length <= 48_000, `reply exceeded cap: ${cappedPage.length}`);
  assert.match(cappedPage, /Changed files \(2000\):/);
  assert.match(cappedPage, /…1950 more changed files omitted/);

  thread.messages = [
    {
      role: 'agent',
      content: 'Bound every repeated metadata collection.',
      linkedTasks: Array.from({ length: 12 }, (_, index) => ({
        title: `Task ${index + 1}`,
        description: `Description ${index + 1}`,
      })),
      attachments: Array.from({ length: 25 }, (_, index) => ({
        name: `attachment-${index + 1}.png`,
        path: `/tmp/attachment-${index + 1}.png`,
      })),
      changedFiles: Array.from({ length: 60 }, (_, index) => ({
        path: `/tmp/file-${index + 1}.txt`,
        status: 'modified',
      })),
    },
  ];
  await persistThread();
  const boundedCollections = await readThreadForAgent({ thread_id: thread.id });
  assert.match(boundedCollections, /…2 more linked tasks omitted/);
  assert.match(boundedCollections, /…5 more attachments omitted/);
  assert.match(boundedCollections, /…10 more changed files omitted/);

  thread.messages = [
    {
      role: 'agent',
      content: 'x'.repeat(6000),
      activities: Array.from({ length: 12 }, (_, index) => ({
        title: `Large activity ${index + 1}`,
        input: 'i'.repeat(2000),
        output: 'o'.repeat(4000),
      })),
    },
  ];
  await persistThread();
  const boundedMessage = await readThreadForAgent({ thread_id: thread.id });
  assert.match(boundedMessage, /\[message details truncated\]/);
  assert.ok(boundedMessage.length <= 48_000, `bounded message exceeded reply cap: ${boundedMessage.length}`);

  thread.messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'agent',
    content: `page marker ${index + 1}\n${'x'.repeat(5900)}`,
  }));
  await persistThread();
  const oversizedPage = await readThreadForAgent({ thread_id: thread.id, offset: 1, limit: 12 });
  const recoveryHint = oversizedPage.match(
    /(\d+) messages of this page were dropped[^\n]+offset=(\d+), limit=(\d+)/
  );
  assert.ok(recoveryHint, 'an oversized page should identify its omitted range');
  const droppedCount = Number(recoveryHint[1]);
  assert.ok(droppedCount > 0 && droppedCount < 12, 'the recovery limit should be smaller than the original page');
  assert.equal(Number(recoveryHint[2]), 1, 'recovery must begin at the original page offset');
  assert.equal(Number(recoveryHint[3]), droppedCount, 'recovery limit must cover exactly the omitted range');
  const recoveredBeginning = await readThreadForAgent({
    thread_id: thread.id,
    offset: Number(recoveryHint[2]),
    limit: Number(recoveryHint[3]),
  });
  assert.match(recoveredBeginning, /### Message 1\/12/);
  assert.match(recoveredBeginning, /page marker 1/);

  // A thread of another machine (a remote-control mirror) is read from it.
  {
    const { setThreadReaderRemoteFetch } = await import('../src/main/thread-reader.js');
    const mirror = {
      id: 'mirror-aaaabbbb',
      projectId: 'project-1',
      title: 'On omarchy',
      status: 'idle',
      modelId: 'claude:opus',
      createdAt: '2026-11-12T00:00:00.000Z',
      remote: { machineId: 'm-omarchy', machineName: 'omarchy', threadId: 'host-ccccdddd' },
      messages: [],
    };
    await writeThreadsPatch({ version: 2, upserts: [mirror], deletes: [], order: [thread.id, mirror.id] });
    const asked = [];
    setThreadReaderRemoteFetch(async (input) => {
      asked.push(input);
      return {
        ok: true,
        thread: { ...mirror, id: 'host-ccccdddd', remote: undefined, messages: [{ role: 'agent', content: 'from the host' }] },
      };
    });
    const remotePage = await readThreadForAgent({ thread_id: mirror.id });
    assert.deepEqual(asked, [{ machineId: 'm-omarchy', threadId: 'host-ccccdddd' }]);
    assert.match(remotePage, /thread_id: mirror-aaaabbbb/, 'paging keeps the id listed here');
    assert.match(remotePage, /machine: omarchy \(this thread runs there; transcript read from it just now\)/);
    assert.match(remotePage, /from the host/);
    setThreadReaderRemoteFetch(async () => ({ ok: false, error: 'The host is offline.' }));
    const offlinePage = await readThreadForAgent({ thread_id: mirror.id });
    assert.match(offlinePage, /could not be reached: The host is offline\./);
    assert.match(offlinePage, /This thread has no messages yet/);
    setThreadReaderRemoteFetch(null);
  }

  console.log('Thread reader regression checks passed.');
} finally {
  await fs.rm(testDataDir, { recursive: true, force: true });
  app.quit();
}
