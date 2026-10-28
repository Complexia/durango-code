import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
} from '../src/app/sidebarResize.ts';

const [appSource, chatSource, mainSource, preloadSource, sidebarSource] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/chat.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/preload.js', import.meta.url), 'utf8'),
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
  sidebarSource,
  /useSidebarResize\(\{[\s\S]*storageKey: AGENTS_SIDEBAR_STORAGE_KEY[\s\S]*className="sidebar agents-sidebar" ref=\{sidebarRef\}[\s\S]*<SidebarFooter \{\.\.\.sidebarFooterProps\} \/>\s*\{sidebarResizeHandle\}/,
  'the Agents sidebar must be drag-resizable through the shared sidebar resize hook'
);

// Durango workspaces replace Rifts (docs/workspaces.md).
// The store only mentions Rift fields to drop them from persisted state.
for (const [name, source] of Object.entries({ appSource, mainSource, preloadSource, sidebarSource })) {
  assert.doesNotMatch(source, /riftPath|riftStatus|riftsSettings/, `no Rift code may remain in ${name}`);
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
