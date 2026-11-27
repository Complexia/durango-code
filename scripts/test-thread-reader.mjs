import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { app, dialog } from 'electron';

// Never block CI or the desktop with Electron's modal error box on assertion failure.
app.dock?.hide?.();
dialog.showErrorBox = (title, content) => {
  console.error(`${title}: ${content}`);
};
const failAndExit = (error) => {
  console.error(error);
  app.exit(1);
};
process.on('uncaughtException', failAndExit);
process.on('unhandledRejection', failAndExit);

const testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-thread-reader-'));
app.setPath('userData', testDataDir);

let exitCode = 0;
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

  // Long final message (the audit case): returned in full on the default page even
  // alongside huge tool activity, and messages past the 34,000-char single-message
  // budget can be paged cleanly with offset + limit=1 + char_offset without splitting
  // UTF-16 surrogate pairs.
  {
    const coreFinding = 'NON-ACP PATH #7: code/src/main/usage-stats.js:412 reads ~/.gemini/antigravity-cli/brain';
    const auditFinal = [
      '### 1. Does every Antigravity path go through ACP?',
      'A'.repeat(7_500),
      coreFinding,
      'B'.repeat(7_500),
      '### 4. Dead or leftover code: none remaining after 71b83f90.',
    ].join('\n');
    thread.messages = [
      { role: 'user', content: 'Audit Antigravity integration.' },
      {
        role: 'agent',
        content: auditFinal,
        activities: Array.from({ length: 20 }, (_, i) => ({
          title: `Command ${i + 1}`,
          input: 'i'.repeat(1_500),
          output: 'o'.repeat(3_500),
        })),
      },
    ];
    await persistThread();
    const auditPage = await readThreadForAgent({ thread_id: thread.id });
    assert.ok(auditPage.includes(coreFinding), 'final message core finding is returned in full on default read_thread');
    assert.ok(auditPage.includes('### 4. Dead or leftover code'), 'final message closing is intact');
    assert.doesNotMatch(auditPage, /\[message truncated/, 'final message under 34,000 chars is not truncated');
    assert.match(auditPage, /\[message details truncated\]/, 'huge tool activities are bounded separately from message content');

    // A very long final message (> 34,000 chars) pages losslessly with char_offset.
    const middleMarker = 'MIDDLE_FINDING_AT_35K';
    const endMarker = 'END_OF_45K_REPORT';
    const hugeFinal = `START_OF_45K_REPORT\n${'x'.repeat(34_500)}\n${middleMarker}\n${'y'.repeat(8_000)}\n${endMarker}`;
    thread.messages = [
      { role: 'user', content: 'Huge report please.' },
      { role: 'agent', content: hugeFinal },
    ];
    await persistThread();
    const chunk1 = await readThreadForAgent({ thread_id: thread.id });
    const nextMatch = chunk1.match(/offset=(\d+), limit=1, char_offset=(\d+) to read more/);
    assert.ok(nextMatch, 'truncated long message prints exact char_offset continuation pointer');
    assert.equal(Number(nextMatch[1]), 2);
    const nextOffset = Number(nextMatch[2]);
    assert.ok(nextOffset > 30_000 && nextOffset <= 34_001);
    const chunk2 = await readThreadForAgent({
      thread_id: thread.id,
      offset: Number(nextMatch[1]),
      limit: 1,
      char_offset: nextOffset,
    });
    assert.ok(chunk2.includes(middleMarker), 'char_offset continuation includes middle past 34k');
    assert.ok(chunk2.includes(endMarker), 'char_offset continuation reaches end of message');
    assert.match(chunk2, /end of message\.\)/);

    // Non-final long message: truncated at 6,000 on multi-message page with pointer,
    // and readable in full via offset + limit=1.
    const earlierLong = `EARLIER_HEAD\n${'e'.repeat(8_000)}\nEARLIER_TAIL`;
    thread.messages = [
      { role: 'agent', content: earlierLong },
      { role: 'user', content: 'Thanks.' },
      { role: 'agent', content: 'Short final reply.' },
    ];
    await persistThread();
    const multiPage = await readThreadForAgent({ thread_id: thread.id });
    assert.match(multiPage, /offset=1, limit=1, char_offset=6001 to read more/);
    const earlierFull = await readThreadForAgent({ thread_id: thread.id, offset: 1, limit: 1 });
    assert.ok(earlierFull.includes('EARLIER_HEAD') && earlierFull.includes('EARLIER_TAIL'));
    assert.doesNotMatch(earlierFull, /\[message truncated/);

    // Surrogate-pair safety at char_offset boundary.
    const emojiReport = '🚀'.repeat(20_000);
    thread.messages = [{ role: 'agent', content: emojiReport }];
    await persistThread();
    const emojiChunk1 = await readThreadForAgent({ thread_id: thread.id });
    assert.equal(emojiChunk1.isWellFormed(), true, 'emoji chunk 1 well-formed');
    const emojiNext = emojiChunk1.match(/char_offset=(\d+)/);
    assert.ok(emojiNext);
    const emojiChunk2 = await readThreadForAgent({
      thread_id: thread.id,
      offset: 1,
      limit: 1,
      char_offset: Number(emojiNext[1]),
    });
    assert.equal(emojiChunk2.isWellFormed(), true, 'emoji chunk 2 well-formed');
  }

  console.log('Thread reader regression checks passed.');
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await fs.rm(testDataDir, { recursive: true, force: true });
  app.exit(exitCode);
}
