import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  epicHasActionableCommitWork,
  epicRepositoryShouldAutoCreatePr,
} from '../src/app/epicGit.ts';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
} from '../src/app/sidebarResize.ts';

const [appSource, chatSource, mainSource, preloadSource, dialogsSource, storeSource, sidebarSource] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/chat.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/preload.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/AppDialogs.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/store.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/AgentsSidebar.tsx', import.meta.url), 'utf8'),
]);

const section = (source, start, end) => {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
};

assert.equal(
  epicHasActionableCommitWork(undefined, true),
  true,
  'commit stays available until the first workspace status arrives'
);
assert.equal(
  epicHasActionableCommitWork(
    { hasChangesToCommit: true, hasUnpushedCommits: true },
    true
  ),
  true,
  'commit-only remains available when there are fresh changes to commit'
);
assert.equal(
  epicHasActionableCommitWork(
    { hasChangesToCommit: false, hasUnpushedCommits: true },
    true
  ),
  false,
  'commit-only must not offer an action when only unpushed commits remain'
);
assert.equal(
  epicHasActionableCommitWork(
    { hasChangesToCommit: false, hasUnpushedCommits: true },
    false
  ),
  true,
  'commit-and-push remains available to retry an earlier failed push'
);
assert.equal(
  epicHasActionableCommitWork(
    { hasChangesToCommit: false, hasUnpushedCommits: false },
    false
  ),
  false,
  'a clean, fully pushed workspace has no actionable commit work'
);

assert.equal(
  epicRepositoryShouldAutoCreatePr({ autoPrAfterCommit: true }, {}),
  true,
  'a pushed multi-project repository without a PR must continue into PR creation'
);
assert.equal(
  epicRepositoryShouldAutoCreatePr(
    { autoPrAfterCommit: true },
    { prUrl: 'https://example.test/pull/1', prState: 'OPEN' }
  ),
  false,
  'an existing open repository PR must not be recreated after a push'
);
assert.equal(
  epicRepositoryShouldAutoCreatePr(
    { autoPrAfterCommit: true },
    { prUrl: 'https://example.test/pull/1', prState: 'CLOSED' }
  ),
  true,
  'a closed repository PR must allow the multi-project flow to create a replacement'
);
assert.equal(
  epicRepositoryShouldAutoCreatePr({ autoPrAfterCommit: true, commitWithoutPush: true }, {}),
  false,
  'commit-only mode must suppress multi-project auto-PR creation'
);

assert.equal(
  clampSidebarWidth(400, 1200),
  400,
  'the Code explorer should accept an editor-safe drag width'
);
assert.equal(
  clampSidebarWidth(100, 1200),
  SIDEBAR_MIN_WIDTH,
  'the Code explorer must retain its usable minimum width'
);
assert.equal(
  clampSidebarWidth(900, 1200),
  SIDEBAR_MAX_WIDTH,
  'the Code explorer must stop at its normal editor-style maximum width'
);
assert.equal(
  clampSidebarWidth(600, 700),
  380,
  'the Code explorer must leave a usable editor area in a narrow window'
);

const backgroundSettled = section(
  appSource,
  "      if (event.type === 'background-settled') {",
  '      // Provider-native subagents'
);
assert.doesNotMatch(
  backgroundSettled,
  /completeInProgressPlanEntries/,
  'failed or killed background work must leave its in-progress plan entry halted'
);

assert.match(
  appSource,
  /pendingBackgroundShellTasks[\s\S]*kind: 'claude-background-intervention'[\s\S]*status: 'pending'/,
  'A completed Claude response with only shell work left must append an Orion monitor message'
);

assert.match(
  dialogsSource,
  /newEpicProjectIds\.length < projects\.length[\s\S]*Add another project/,
  'the Epic dialog must let the user add another unique project picker'
);
assert.match(
  dialogsSource,
  /aria-label=\{`Remove project \$\{index \+ 1\}`\}/,
  'every Epic project selection, including the last one, must be removable'
);
assert.match(
  storeSource,
  /repositories\?: EpicRepository\[\]/,
  'Epic persistence must retain all repositories'
);
assert.match(
  appSource,
  /Commit & push all projects[\s\S]*Create PRs for all[\s\S]*runMultiRepositoryAction/,
  'the Epic view must expose batch and per-project repository actions'
);
const multiRepositoryActions = section(
  appSource,
  '                      {selectedEpicRepositories.length > 1 && (',
  '                      <span className="epic-view-repository-hint">'
);
assert.match(
  multiRepositoryActions,
  /checked=\{Boolean\(selectedEpic\.autoPrAfterCommit\)\}[\s\S]*Auto create PR on commit/,
  'the multi-project Epic view must expose the persisted auto-create-PR checkbox'
);
assert.match(
  appSource,
  /epicRepositoryShouldAutoCreatePr\(latestEpic, latestRepository\)[\s\S]*createEpicRepositoryPr\(latestEpic, latestRepository\)/,
  'a successful multi-project commit must continue into PR creation when enabled'
);
assert.match(
  appSource,
  /result === 'aborted'\) break/,
  'a user-aborted repository operation must stop the remaining batch'
);
assert.match(
  appSource,
  /epic\.repositories\?\.length \?\? 0\) > 1[\s\S]*return UNCLAIMED_EPIC_GIT_WORKSPACE_KEY/,
  'multi-repository actions must use the conservative shared-checkout lock'
);
assert.match(
  appSource,
  /claimedBranches: claimedBranchesForEpic\(epic\.id\)/,
  'per-repository actions must enforce cross-Epic branch claims'
);
assert.match(
  appSource,
  /kind === 'commit' && window\.orion\?\.epicGitStatus[\s\S]*status\.hasChangesToCommit[\s\S]*status\.hasUnpushedCommits/,
  'batch commits must preflight and skip clean, fully-pushed repositories'
);
assert.match(
  appSource,
  /baseBranch: repository\.sourceBranch \?\? ''/,
  'each repository pull request must target its recorded source branch'
);
assert.match(
  appSource,
  /epic-view-actions[\s\S]*selectedEpicRepositories\.length <= 1/,
  'legacy primary-only git controls must be hidden for multi-project Epics'
);
assert.match(
  sidebarSource,
  /useSidebarResize\(\{[\s\S]*storageKey: AGENTS_SIDEBAR_STORAGE_KEY[\s\S]*className="sidebar agents-sidebar" ref=\{sidebarRef\}[\s\S]*<SidebarFooter \{\.\.\.sidebarFooterProps\} \/>\s*\{sidebarResizeHandle\}/,
  'the Agents sidebar must be drag-resizable through the shared sidebar resize hook'
);

// Durango workspaces replace Rifts (docs/workspaces.md).
// The store only mentions Rift fields to drop them from persisted state.
for (const [name, source] of Object.entries({ appSource, mainSource, preloadSource, dialogsSource, sidebarSource })) {
  assert.doesNotMatch(source, /riftPath|riftStatus|epicCreateRift|riftsSettings/, `no Rift code may remain in ${name}`);
}
const turnStart = section(
  appSource,
  'const startTurnForThreadUnlocked = useCallback(',
  'let model = findAgentModel(agentModels, thread.modelId ?? defaultAgentModelId);'
);
assert.match(
  turnStart,
  /await ensureThreadDurangoWorkspace\(threadId, promptText\)[\s\S]*const workingDir = threadWorkingDir\(thread, project\)/,
  'a first turn must create its Durango workspace before resolving the agent cwd'
);
assert.match(
  appSource,
  /thread\.durangoWorkspace && !thread\.agentSessionIds\?\.\[model\.providerId\][\s\S]*buildDurangoWorkspaceContext/,
  'fresh sessions in a workspace must be told they are already in one'
);
assert.match(
  appSource,
  /durangoWorkspace: driverThread\.durangoWorkspace \?\? null/,
  'subagents must work in their driver thread\'s directory'
);
assert.match(
  mainSource,
  /ipcMain\.handle\('durangoWorkspace:create'[\s\S]*await signInBundledCli\(\)[\s\S]*createDurangoWorkspace\(/,
  'workspace creation must sign the bundled CLI in before `ws new`'
);
assert.match(
  preloadSource,
  /createDurangoWorkspace:[\s\S]*durangoWorkspace:create/,
  'workspace creation must cross the preload boundary'
);
assert.match(
  appSource,
  /Shell-only work follows Claude Code's monitor semantics[\s\S]*if \(waiting\)[\s\S]*else \{[\s\S]*status: 'done'/,
  'Shell-only monitors must not keep the completed Claude turn in the working state'
);
assert.match(
  chatSource,
  /Stop background monitors[\s\S]*onDiscardClaudeBackgroundTasks/,
  'The monitor card must expose an explicit stop action in the transcript'
);
assert.match(
  mainSource,
  /agent:discardClaudeBackgroundShellTasks/,
  'The renderer action must have a dedicated Claude-only IPC route'
);
assert.match(
  preloadSource,
  /discardClaudeBackgroundShellTasks/,
  'The Claude shell-discard action must be exposed through the preload boundary'
);

const epicActions = section(
  appSource,
  '                    <div className="epic-view-actions">',
  '                      {selectedEpicPrBadge && ('
);
assert.match(
  epicActions,
  /disabled=\{selectedEpicOperationBusy\}[\s\S]*checked=\{Boolean\(selectedEpic\.commitWithoutPush\)\}/,
  'commit-only mode must be frozen while the selected epic operation is busy'
);

const cloudDeployPrecheck = section(
  mainSource,
  'const cloudDeployPrecheck = async (gitRoot) => {',
  "ipcMain.handle('cloud:deployPrecheck'"
);
assert.match(
  cloudDeployPrecheck,
  /readGitStatusEntries\(gitRoot\)[\s\S]*uncommitted working tree changes/,
  'a dirty worktree must route through the deployment agent instead of rebuilding stale HEAD'
);
assert.match(
  cloudDeployPrecheck,
  /reasons\.length === 0 && \(await cloudAppFileExists\(gitRoot, name\)\)/,
  'explicit build config must not bypass the dirty-worktree deploy guard'
);
assert.match(
  appSource,
  /working tree has uncommitted changes[\s\S]*commit the intended deployable work[\s\S]*preserving unrelated user changes/,
  'the deployment agent must commit intended dirty-tree work without swallowing unrelated changes'
);

console.log('UI improvements tests passed');
