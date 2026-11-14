// Threads that run on another machine (remote control): the settings a remote
// turn carries and how a refresh of the other machine's copy updates the
// mirror.
//
//   bun scripts/test-remote-threads.ts
import assert from 'node:assert/strict';
import {
  adoptRemoteSettings,
  keepStreamedMessages,
  mapRemoteAttachments,
  remoteTurnSettingsToSend,
  REMOTE_START_GRACE_MS,
  remoteMirrorUpdate,
  remoteTranscriptChanged,
  remoteTurnSettings,
} from '../src/app/remoteThreads';
import type { Message, Thread } from '../src/store';

const thread = {
  id: 'local-1',
  projectId: 'p1',
  title: 'Fix the flaky test',
  status: 'idle',
  modelId: 'claude:opus',
  accessMode: 'full-access',
  claudeReasoningEffort: 'high',
  claudeContextWindow: '1m',
  codexReasoningEffort: 'low',
  codexServiceTier: 'priority',
  createdAt: '2026-11-09T00:00:00.000Z',
} as unknown as Thread;

// The effort for the model's provider, and only its provider's extras.
assert.deepEqual(remoteTurnSettings(thread, 'claude'), {
  modelId: 'claude:opus',
  accessMode: 'full-access',
  reasoningEffort: 'high',
  claudeContextWindow: '1m',
});
assert.deepEqual(remoteTurnSettings({ ...thread, modelId: 'codex:gpt' } as Thread, 'codex'), {
  modelId: 'codex:gpt',
  accessMode: 'full-access',
  reasoningEffort: 'low',
  codexServiceTier: 'priority',
});
assert.deepEqual(remoteTurnSettings(thread, undefined), { modelId: 'claude:opus', accessMode: 'full-access' });
console.log('ok  remote turns carry the thread’s settings for its provider');

const message = (id: string, extra: Partial<Message> = {}): Message =>
  ({ id, role: 'agent', content: 'hello', ts: '2026-11-09T00:00:01.000Z', ...extra }) as Message;

assert.equal(remoteTranscriptChanged({ messages: [message('a')] }, { messages: [message('a')] }), false);
assert.equal(remoteTranscriptChanged({ messages: [message('a')] }, { messages: [message('a'), message('b')] }), true);
assert.equal(
  remoteTranscriptChanged({ messages: [message('a', { status: 'running' })] }, { messages: [message('a', { status: 'done' })] }),
  true
);
assert.equal(
  remoteTranscriptChanged({ messages: [message('a')] }, { messages: [message('a', { content: 'hello there' })] }),
  true
);
assert.equal(remoteTranscriptChanged(undefined, { messages: [] }), false);
console.log('ok  the mirror is replaced only when the other machine’s transcript moved');

const now = 1_000_000;
const local = { status: 'running' as const, title: 'Fix the flaky test' };
// Just started there: a copy saved before the turn (not running yet, or
// without the new prompt) is ignored until the grace period ends.
assert.equal(remoteMirrorUpdate(local, 3, { status: 'idle', title: 'x', messages: [] }, now - 1_000, now), null);
assert.equal(
  remoteMirrorUpdate(local, 3, { status: 'running', title: 'x', messages: [message('a')] }, now - 1_000, now),
  null
);
assert.deepEqual(
  remoteMirrorUpdate(
    local,
    3,
    { status: 'done', title: 'Thread 4:04 PM', messages: [] },
    now - REMOTE_START_GRACE_MS - 1,
    now
  ),
  { status: 'done' }
);
// Running there with the prompt: status and the other machine's title apply,
// but never its placeholder title.
assert.deepEqual(
  remoteMirrorUpdate(
    local,
    1,
    { status: 'running', title: 'Stabilize the retry test', messages: [message('a'), message('b')] },
    now - 1_000,
    now
  ),
  { title: 'Stabilize the retry test' }
);
assert.deepEqual(
  remoteMirrorUpdate({ status: 'idle', title: 'Fix the flaky test' }, 2, { status: 'done', title: 'Thread 4:04 PM', messages: [] }, null, now),
  { status: 'done' }
);
console.log('ok  refreshes wait for a just-started turn and keep this machine’s title until that one has its own');

// The other machine's attachment paths point at this machine's copies.
{
  const attachment = { id: 'a', name: 'shot.png', path: '/host/attachments/a-shot.png', mimeType: 'image/png', size: 3 };
  const other = { ...attachment, id: 'b', path: '/host/attachments/b-log.txt' };
  const messages = [message('u1', { role: 'user', attachments: [attachment, other] }), message('a1')];
  const { messages: mapped, missing } = mapRemoteAttachments(messages, { '/host/attachments/a-shot.png': '/local/shot.png' });
  assert.equal(mapped[0].attachments?.[0].path, '/local/shot.png');
  assert.equal(
    mapped[0].attachments?.[1].path,
    'remote-only:/host/attachments/b-log.txt',
    'a path of that machine with no copy here is never read as a local one'
  );
  assert.deepEqual(missing, ['/host/attachments/b-log.txt']);
  // Fetched later: the remote-only path becomes the copy.
  const later = mapRemoteAttachments(mapped, { '/host/attachments/b-log.txt': '/local/b-log.txt' });
  assert.equal(later.messages[0].attachments?.[1].path, '/local/b-log.txt');
  assert.equal(mapped[1], messages[1], 'messages without attachments are untouched');
  console.log('ok  mirrored attachments point at this machine’s copies');
}

// Settings: that machine's win unless changed here; a turn sends only what
// changed here (everything when it starts the thread there).
{
  const mirror = {
    ...thread,
    accessMode: 'full-access',
    remote: {
      machineId: 'm',
      machineName: 'omarchy',
      threadId: 'h1',
      hostSettings: { modelId: 'claude:opus', accessMode: 'full-access', claudeReasoningEffort: 'high', claudeContextWindow: '1m' },
    },
  } as unknown as Thread;
  // Changed there to read only: adopted here.
  const fromHost = adoptRemoteSettings(mirror, { modelId: 'claude:opus', accessMode: 'read-only', claudeReasoningEffort: 'high' });
  assert.deepEqual(fromHost.patch, { accessMode: 'read-only' });
  assert.equal(fromHost.hostSettings.accessMode, 'read-only');
  // Changed here (effort to max) and not sent yet: kept, while the host's
  // access change still comes in.
  const changedHere = { ...mirror, claudeReasoningEffort: 'max' } as Thread;
  assert.deepEqual(
    adoptRemoteSettings(changedHere, { modelId: 'claude:opus', accessMode: 'read-only', claudeReasoningEffort: 'high' }).patch,
    { accessMode: 'read-only' }
  );
  // A turn sends only the effort (changed here), never the stale access mode.
  assert.deepEqual(remoteTurnSettingsToSend(changedHere, 'claude'), { reasoningEffort: 'max' });
  assert.deepEqual(remoteTurnSettingsToSend(mirror, 'claude'), {});
  // A thread not yet started there sends everything.
  const fresh = { ...mirror, remote: { machineId: 'm', machineName: 'omarchy' } } as unknown as Thread;
  assert.equal(remoteTurnSettingsToSend(fresh, 'claude').accessMode, 'full-access');
  console.log('ok  that machine’s settings win unless changed here; turns send only changes');
}

{
  // A run streaming here (its events) is ahead of that machine's saved copy.
  const run = (content: string, status: Message['status'], activities = 0) =>
    ({
      id: 'run-1',
      role: 'agent',
      kind: 'agent-run',
      content,
      ts: 't',
      status,
      activities: Array.from({ length: activities }, (_, index) => ({ id: `a${index}` })),
    }) as unknown as Message;
  const prompt = { id: 'u-1', role: 'user', content: 'go', ts: 't' } as Message;
  const live = new Set(['run-1']);
  const mirrored = [prompt, run('Hello there, streaming', 'running', 2)];

  // Saved copy behind: the streamed text and activity stay.
  let kept = keepStreamedMessages([prompt, run('Hello', 'running', 1)], mirrored, live, true);
  assert.equal(kept.messages[1].content, 'Hello there, streaming');
  assert.equal(kept.messages[1].activities?.length, 2);
  assert.deepEqual(kept.settled, []);

  // Saved copy ahead (or different): it wins, and streaming into it stops.
  kept = keepStreamedMessages([prompt, run('Hello there, streaming more', 'running', 2)], mirrored, live, true);
  assert.equal(kept.messages[1].content, 'Hello there, streaming more');
  assert.deepEqual(kept.settled, ['run-1']);
  kept = keepStreamedMessages([prompt, run('Goodbye', 'running', 2)], mirrored, live, true);
  assert.equal(kept.messages[1].content, 'Goodbye');
  assert.deepEqual(kept.settled, ['run-1']);

  // Saved after the run ended: the saved copy, and the message is settled.
  kept = keepStreamedMessages([prompt, run('Hello', 'done', 1)], mirrored, live, false);
  assert.equal(kept.messages[1].content, 'Hello');
  assert.deepEqual(kept.settled, ['run-1']);

  // Saved before the run started there: the streamed message is kept at the
  // end while it runs here, even if that copy shows nothing running...
  for (const hostRunning of [true, false]) {
    kept = keepStreamedMessages([prompt], mirrored, live, hostRunning);
    assert.equal(kept.messages.length, 2);
    assert.equal(kept.messages[1].id, 'run-1');
    assert.equal(kept.predatesRun, true);
  }
  // ...and dropped once it ended here and nothing runs there.
  kept = keepStreamedMessages([prompt], [prompt, run('Hello there', 'done', 2)], live, false);
  assert.equal(kept.messages.length, 1);
  assert.deepEqual(kept.settled, ['run-1']);
  assert.equal(kept.predatesRun, false);

  // Nothing streamed: the saved copy as is.
  const incoming = [prompt];
  assert.equal(keepStreamedMessages(incoming, mirrored, new Set(), true).messages, incoming);
  console.log('ok  streamed messages are not rolled back by an older saved copy');
}

{
  // A turn that already ended there (its done event): a saved copy with the
  // turn, showing it finished, is taken within the start grace.
  const local = { status: 'running', title: 'x' } as Thread;
  const now = Date.now();
  const finished = { status: 'idle', title: 'x', messages: [message('a'), message('b')] } as never;
  assert.equal(remoteMirrorUpdate(local, 2, finished, now - 1_000, now), null);
  assert.deepEqual(remoteMirrorUpdate(local, 2, finished, now - 1_000, now, true), { status: 'idle' });
  // A copy saved before the turn (fewer messages) is still ignored.
  const before = { status: 'idle', title: 'x', messages: [message('a')] } as never;
  assert.equal(remoteMirrorUpdate(local, 2, before, now - 1_000, now, true), null);
  console.log('ok  a run that ended there ends the start grace');
}

console.log('All remote-threads tests passed.');
