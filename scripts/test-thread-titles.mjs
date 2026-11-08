import assert from 'node:assert/strict';

import { deriveTitle, getGoalTitleSeed, tryGenerateBetterTitle } from '../src/app/titles.ts';

const freshThread = {
  title: 'Thread 09:22 PM',
  summary: { messageCount: 0 },
};
const objective = 'ship the release safely';

assert.equal(
  getGoalTitleSeed(freshThread, { action: 'set', objective }),
  objective,
  'a new goal on an untouched thread should seed title generation from its objective'
);
assert.equal(
  deriveTitle(getGoalTitleSeed(freshThread, { action: 'set', objective })),
  'Ship The Release Safely',
  'the goal title seed should use the normal first-turn title derivation'
);
assert.equal(
  getGoalTitleSeed({ ...freshThread, title: 'Release Audit' }, { action: 'set', objective }),
  null,
  'a goal must preserve an existing custom title'
);
assert.equal(
  getGoalTitleSeed({ ...freshThread, summary: { messageCount: 1 } }, { action: 'set', objective }),
  null,
  'a goal must not retitle a thread with existing transcript messages'
);
assert.equal(
  getGoalTitleSeed(freshThread, { action: 'resume' }),
  null,
  'resuming a goal must preserve the existing title'
);

let resolveGeneratedTitle;
const generatedTitle = new Promise((resolve) => {
  resolveGeneratedTitle = resolve;
});
globalThis.window = {
  orion: {
    generateThreadTitle: () => generatedTitle,
  },
};

let currentTitle = deriveTitle(objective);
const titleUpdates = [];
const refinement = tryGenerateBetterTitle(
  'thread-1',
  objective,
  { modelId: 'codex:gpt-5.6-luna', reasoningEffort: null },
  '/tmp/project',
  (threadId, updates) => titleUpdates.push({ threadId, updates }),
  currentTitle,
  () => currentTitle
);

currentTitle = 'Manual Release Name';
resolveGeneratedTitle('Generated Release Plan');
await refinement;

assert.deepEqual(
  titleUpdates,
  [],
  'a manual rename while goal title generation is pending must be preserved'
);

currentTitle = deriveTitle(objective);
globalThis.window.orion.generateThreadTitle = async () => 'Generated Release Plan';
await tryGenerateBetterTitle(
  'thread-1',
  objective,
  { modelId: 'codex:gpt-5.6-luna', reasoningEffort: null },
  '/tmp/project',
  (threadId, updates) => titleUpdates.push({ threadId, updates }),
  currentTitle,
  () => currentTitle
);

assert.deepEqual(
  titleUpdates,
  [{ threadId: 'thread-1', updates: { title: 'Generated Release Plan' } }],
  'a generated title should still replace the unchanged heuristic title'
);

console.log('Thread title regression checks passed.');
