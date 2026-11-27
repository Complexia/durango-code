// A steer on a thread that runs on another machine shows from here at once
// and stays until that machine's copy of it (its echo) is in the mirror,
// which takes its place: never both, never neither.
import assert from 'node:assert/strict';

import {
  pendingRemoteSteerMessage,
  pendingRemoteSteers,
  reconcileRemoteSteers,
  remoteSteerContent,
  steeredMessageIds,
  type PendingRemoteSteer,
} from '../src/app/pendingRemoteSteers';
import type { Message } from '../src/store';

const ts = '2026-11-27T10:00:00.000Z';
const prompt: Message = { id: 'u1', role: 'user', content: 'fix the sidebar', ts };
const run: Message = { id: 'r1', role: 'agent', kind: 'agent-run', status: 'running', content: 'Looking.', ts };
const echoOf = (id: string, content: string): Message => ({ id, role: 'user', content, steer: true, ts });

const steer = (id: string, content: string, earlierIds: string[] = []): PendingRemoteSteer => ({
  id,
  content,
  attachments: [],
  ts,
  state: 'sending',
  earlierIds,
});

// What that machine records: the trimmed text, or "Attached file" alone.
assert.equal(remoteSteerContent('  also check dark mode \n', []), 'also check dark mode');
assert.equal(
  remoteSteerContent('', [{ id: 'a', name: 'shot.png', path: '/tmp/shot.png' } as never]),
  'Attached file'
);

// Sending: the mirror doesn't have it yet, so it shows from here.
{
  const view = reconcileRemoteSteers([steer('s1', 'also check dark mode')], [prompt, run]);
  assert.deepEqual(
    view.visible.map((entry) => entry.id),
    ['s1']
  );
  assert.equal(view.echoes.size, 0);
}

// The echo arrives (the host split the run around it): the pending one goes
// in the same render, and the echo is the only copy.
{
  const closed: Message = { ...run, status: 'done' };
  const echo = echoOf('host-u2', 'also check dark mode');
  const continuation: Message = { id: 'r2', role: 'agent', kind: 'agent-run', status: 'running', content: '', ts };
  const view = reconcileRemoteSteers([steer('s1', 'also check dark mode')], [prompt, closed, echo, continuation]);
  assert.equal(view.visible.length, 0);
  assert.equal(view.echoes.get('s1'), 'host-u2');
}

// An earlier steer with the same text is not its echo.
{
  const earlier = echoOf('host-old', 'keep going');
  const messages = [prompt, earlier, run];
  const pending = steer('s1', 'keep going', steeredMessageIds(messages, 'keep going'));
  assert.deepEqual(pending.earlierIds, ['host-old']);
  assert.equal(reconcileRemoteSteers([pending], messages).visible.length, 1);
  const view = reconcileRemoteSteers([pending], [...messages, echoOf('host-new', 'keep going')]);
  assert.equal(view.visible.length, 0);
  assert.equal(view.echoes.get('s1'), 'host-new');
}

// Two steers with the same text: each echo takes one, in order.
{
  const pending = [steer('s1', 'go on'), steer('s2', 'go on')];
  const one = reconcileRemoteSteers(pending, [prompt, run, echoOf('h1', 'go on')]);
  assert.deepEqual(
    one.visible.map((entry) => entry.id),
    ['s2']
  );
  assert.equal(one.echoes.get('s1'), 'h1');
  const both = reconcileRemoteSteers(pending, [prompt, run, echoOf('h1', 'go on'), echoOf('h2', 'go on')]);
  assert.equal(both.visible.length, 0);
}

// A plain (unsteered) user message with the same text is not an echo.
{
  const plain: Message = { id: 'h1', role: 'user', content: 'go on', ts };
  assert.equal(reconcileRemoteSteers([steer('s1', 'go on')], [prompt, run, plain]).visible.length, 1);
}

// Drawn as a steered user message with its id (stable while it is sending, then sent).
{
  const message = pendingRemoteSteerMessage(steer('s1', 'also check dark mode'));
  assert.equal(message.id, 's1');
  assert.equal(message.role, 'user');
  assert.equal(message.steer, true);
}

// The store: added sending, marked sent, settled by its echo (marked adopted
// so it doesn't animate in again), or removed when it went back to the queue.
{
  pendingRemoteSteers.add('t1', steer('s1', 'a'));
  pendingRemoteSteers.add('t1', steer('s2', 'b'));
  assert.equal(pendingRemoteSteers.get('t1').length, 2);
  pendingRemoteSteers.markSent('t1', 's1');
  assert.equal(pendingRemoteSteers.get('t1')[0].state, 'sent');
  assert.equal(pendingRemoteSteers.get('t1')[1].state, 'sending');
  const view = reconcileRemoteSteers(pendingRemoteSteers.get('t1'), [echoOf('h-a', 'a')]);
  pendingRemoteSteers.adopt(view.echoes.values());
  pendingRemoteSteers.settle('t1', view.echoes);
  assert.deepEqual(
    pendingRemoteSteers.get('t1').map((entry) => entry.id),
    ['s2']
  );
  assert.equal(pendingRemoteSteers.isAdoptedEcho('h-a'), true);
  pendingRemoteSteers.remove('t1', 's2');
  assert.equal(pendingRemoteSteers.get('t1').length, 0);
  // Same empty list each read when there are none (useSyncExternalStore).
  assert.equal(pendingRemoteSteers.get('t1'), pendingRemoteSteers.get('t2'));
}

console.log('pending remote steers ok');
