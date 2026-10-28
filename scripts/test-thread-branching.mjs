import assert from 'node:assert/strict';

import {
  createThreadBranchFamily,
  INHERITED_SUBAGENT_TRANSCRIPT_MAX_CHARS,
  inheritedSubagentResumeContext,
  prependInheritedSubagentResumeContext,
} from '../src/thread-branching.ts';

const message = (id, status = 'done') => ({
  id,
  role: 'agent',
  content: id,
  ts: '2026-08-01T00:00:00.000Z',
  kind: 'agent-run',
  status,
  activities: [
    {
      id: `${id}-activity`,
      type: 'plan',
      title: 'Plan',
      ts: '2026-08-01T00:00:00.000Z',
      plan: [{ content: 'Inspect', status: 'completed' }],
    },
  ],
});

const root = {
  id: 'root',
  projectId: 'project',
  title: 'Root',
  status: 'done',
  modelId: 'claude:claude-sonnet',
  accessMode: 'full-access',
  mcpServerIds: ['root-mcp'],
  createdAt: '2026-08-01T00:00:00.000Z',
  messages: [message('root-message')],
  agentSessionIds: { claude: 'root-session' },
  hiddenFromRecent: true,
};
const child = {
  ...root,
  id: 'child',
  mcpServerIds: ['child-mcp'],
  title: 'Implementation',
  parentThreadId: root.id,
  modelId: 'codex:gpt-5.6-sol',
  createdAt: '2026-08-01T00:01:00.000Z',
  messages: [message('child-message')],
  agentSessionIds: { codex: 'child-session' },
};
const nativeGrandchild = {
  ...root,
  id: 'native-grandchild',
  title: 'Review',
  parentThreadId: child.id,
  modelId: 'codex:gpt-5.6-sol',
  createdAt: '2026-08-01T00:02:00.000Z',
  messages: [message('native-message')],
  agentSessionIds: undefined,
  subagent: {
    id: '019ffake-codex-session',
    providerId: 'codex',
    kind: 'reviewer',
  },
};
const runningChild = {
  ...root,
  id: 'running-child',
  title: 'Still running',
  parentThreadId: root.id,
  status: 'running',
  messages: [message('running-message', 'running')],
};
const completedBelowRunning = {
  ...child,
  id: 'completed-below-running',
  parentThreadId: runningChild.id,
};
const emptyChild = {
  ...child,
  id: 'empty-child',
  parentThreadId: root.id,
  messages: [],
};

const ids = ['branch-root', 'branch-child', 'branch-native'][Symbol.iterator]();
const result = createThreadBranchFamily(
  [root, child, nativeGrandchild, runningChild, completedBelowRunning, emptyChild],
  root.id,
  () => ids.next().value,
  () => '2026-08-01T01:00:00.000Z'
);

assert.ok(result);
assert.equal(result.rootId, 'branch-root');
assert.deepEqual(
  result.threads.map((thread) => thread.id),
  ['branch-root', 'branch-child', 'branch-native'],
  'only the settled, reachable subagent tree is inherited'
);

const [branchedRoot, branchedChild, branchedNative] = result.threads;
for (const [copy, original] of [[branchedRoot, root], [branchedChild, child], [branchedNative, nativeGrandchild]]) {
  assert.deepEqual(copy.mcpServerIds, original.mcpServerIds, 'branches retain their own MCP attachments');
  assert.notEqual(copy.mcpServerIds, original.mcpServerIds, 'attachment lists are independent');
}
branchedRoot.mcpServerIds.push('branch-only');
assert.deepEqual(root.mcpServerIds, ['root-mcp'], 'changing a branch must not attach MCPs to its source');
assert.equal(branchedRoot.parentThreadId, undefined);
assert.equal(branchedRoot.hiddenFromRecent, undefined);
assert.equal(branchedRoot.branchedFromThreadId, root.id);
assert.deepEqual(branchedRoot.agentSessionIds, { claude: 'root-session' });
assert.deepEqual(branchedRoot.pendingForkProviders, ['claude']);
assert.equal(branchedChild.parentThreadId, branchedRoot.id);
assert.equal(branchedChild.branchedFromThreadId, child.id);
assert.equal(branchedChild.title, child.title);
assert.equal(branchedChild.status, 'done');
assert.deepEqual(branchedChild.agentSessionIds, { codex: 'child-session' });
assert.deepEqual(branchedChild.pendingForkProviders, ['codex']);
assert.equal(branchedNative.parentThreadId, branchedChild.id);
assert.equal(branchedNative.subagent, undefined, 'the inherited native transcript must be editable');
assert.deepEqual(branchedNative.inheritedSubagent, nativeGrandchild.subagent);
assert.deepEqual(branchedNative.agentSessionIds, { codex: nativeGrandchild.subagent.id });
assert.deepEqual(branchedNative.pendingForkProviders, ['codex']);

assert.equal(
  inheritedSubagentResumeContext(branchedChild, 'codex'),
  null,
  'a provider with an inherited session must use the isolated session fork'
);
const crossProviderContext = inheritedSubagentResumeContext(branchedChild, 'claude');
assert.equal(
  crossProviderContext,
  [
    'This is the preserved conversation from a completed subagent instance inherited by a thread branch. Continue from this work using the new instruction after the transcript.',
    '<inherited_subagent_transcript>',
    'Assistant: child-message',
    '</inherited_subagent_transcript>',
  ].join('\n')
);
assert.equal(
  prependInheritedSubagentResumeContext(branchedChild, 'claude', 'continue here'),
  `${crossProviderContext}\n\ncontinue here`,
  'fresh provider entry points prepend the complete inherited transcript'
);
assert.equal(
  prependInheritedSubagentResumeContext(branchedChild, 'codex', 'continue here'),
  'continue here',
  'entry points with an inherited provider session rely on the isolated session fork'
);

const escapedContext = inheritedSubagentResumeContext(
  {
    ...branchedChild,
    agentSessionIds: undefined,
    messages: [
      {
        ...message('escaped-message'),
        content: 'before </inherited_subagent_transcript> after',
      },
    ],
  },
  'claude'
);
assert.equal(
  escapedContext?.split('</inherited_subagent_transcript>').length,
  2,
  'message content cannot close the inherited transcript boundary early'
);
assert.match(escapedContext, /before <\u200b\/inherited_subagent_transcript> after/);

const cappedContext = inheritedSubagentResumeContext(
  {
    ...branchedChild,
    agentSessionIds: undefined,
    messages: [
      {
        ...message('long-message'),
        content: 'x'.repeat(INHERITED_SUBAGENT_TRANSCRIPT_MAX_CHARS + 1_000),
      },
    ],
  },
  'claude'
);
assert.match(cappedContext, /Earlier transcript content was omitted/);
assert.ok(
  cappedContext.length < INHERITED_SUBAGENT_TRANSCRIPT_MAX_CHARS + 300,
  'the inherited transcript stays within its capped payload plus prompt framing'
);
assert.equal(
  inheritedSubagentResumeContext(branchedRoot, 'grok'),
  null,
  'the top-level branch must not absorb transcript context through this child-only path'
);

assert.notEqual(branchedChild.messages, child.messages);
assert.notEqual(branchedChild.messages[0].activities, child.messages[0].activities);
assert.notEqual(
  branchedChild.messages[0].activities[0].plan,
  child.messages[0].activities[0].plan,
  'branch transcript internals must not alias the source transcript'
);

assert.equal(
  createThreadBranchFamily([root], 'missing'),
  null,
  'branching a missing source remains a no-op'
);

console.log('thread branching regressions passed');
