// @thread mentions across machines (src/app/promptContext.tsx): a mirror of a
// thread of another machine is found by its id there too, and a turn sent to
// that machine names it by that id.
import assert from 'node:assert/strict';
import {
  buildRemoteThreadMentionsContext,
  parseThreadMentions,
  resolveThreadReference,
  retargetThreadMention,
  threadMentionToken,
} from '../src/app/promptContext';

const thread = (id: string, title: string, remote?: { machineId: string; machineName: string; threadId?: string }) =>
  ({ id, title, projectId: 'p', status: 'idle', modelId: 'claude:opus', summary: { messageCount: 3 }, ...(remote ? { remote } : {}) }) as never;

const mirror = thread('local1111-aaaa', 'Rich messages', { machineId: 'm-om', machineName: 'omarchy', threadId: 'host2222-bbbb' });
const local = thread('mac33333-cccc', 'Mac work');
const threads = [mirror, local];

const prompt = `Compare @${threadMentionToken(mirror)} with @${threadMentionToken(local)} please`;
assert.deepEqual(
  parseThreadMentions(prompt, threads).map((mention) => (mention.thread as { id: string }).id),
  ['local1111-aaaa', 'mac33333-cccc']
);
// The host's agents write the host id: it resolves to the mirror here.
assert.equal(resolveThreadReference('host2222-bbbb', threads), mirror);
assert.equal(resolveThreadReference('rich-messages-host2222', threads), mirror);
assert.equal(parseThreadMentions('see @thread:rich-messages-host2222', threads).length, 1);

const retargeted = retargetThreadMention(prompt, mirror, 'host2222-bbbb');
assert.equal(retargeted, `Compare @thread:rich-messages-host2222 with @${threadMentionToken(local)} please`);
assert.equal(retargetThreadMention('@thread:rich-messages-local111\nnext', mirror, 'host2222-bbbb'), '@thread:rich-messages-host2222\nnext');

const context = buildRemoteThreadMentionsContext(
  parseThreadMentions(`@${threadMentionToken(local)}`, threads),
  [{ threadId: 'mac33333-cccc', text: '# Durango Code thread "Mac work"\nlast page' }],
  'omarchy'
);
assert.match(context, /not on omarchy where you run/);
assert.match(context, /## @thread:mac-work-mac33333 → "Mac work"\n# Durango Code thread "Mac work"\nlast page/);
console.log('remote thread mentions: ok');

// A synced copy of a thread can have the same id on both machines: the local
// thread wins, and its mention is not rewritten as the mirror's.
{
  const original = thread('same4444-eeee', 'Shared', undefined);
  const copy = thread('mirr5555-ffff', 'Shared', { machineId: 'm-om', machineName: 'omarchy', threadId: 'same4444-eeee' });
  const both = [original, copy];
  const text = `@${threadMentionToken(original)}`;
  assert.deepEqual(parseThreadMentions(text, both).map((m) => (m.thread as { id: string }).id), ['same4444-eeee']);
  assert.equal(resolveThreadReference('same4444-eeee', both), original);
  assert.equal(retargetThreadMention(text, copy, 'same4444-eeee'), text);
  // Two mirrors with the same id there: the alias resolves to neither.
  const twin = thread('twin6666-gggg', 'Other', { machineId: 'm-x', machineName: 'x', threadId: 'host2222-bbbb' });
  assert.equal(resolveThreadReference('rich-messages-host2222', [mirror, twin]), undefined);
  console.log('remote thread mention aliases: ok');
}
