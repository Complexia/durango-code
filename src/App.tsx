import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { CodexQuestions, asyncAnswerText, type CodexQuestionRequest } from './app/CodexQuestions';
import type { ExplainApproval } from './app/ApprovalCard';
import {
  Plus,
  Trash2,
  MessageSquare,
  Code2,
  GitBranch,
  GitCommit,
  ChevronDown,
  Columns3,
  Ellipsis,
  SquarePen,
  Check,
  X,
  Play,
  Pause,
  Target,
  Shield,
  Terminal,
  Bot,
  Paperclip,
  RefreshCw,
  AppWindow,
  SquareArrowOutUpRight,
  SquareKanban,
  CircleCheck,
  Menu,
  SlidersHorizontal,
  Plug,
  Globe,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import {
  useOrionStore,
  ensureThreadTranscript,
  ensureThreadTranscripts,
  findThread,
  flushIntoStoreBeforeUnload,
  flushOrionThreadsSave,
  holdThreadTranscript,
  defaultProviderSettings,
  defaultOrchestrationSettings,
  defaultNotificationSettings,
  defaultDurangoSettings,
  defaultDurangoDispatchSettings,
  defaultDurangoDeployWatcherSettings,
  defaultSidebarV2Settings,
  defaultAppearanceSettings,
  findProjectById,
  isAgentsPanelVisible,
  isNoProjectId,
  MAX_THREAD_PANES,
  settleThreadsForSidebarV2,
  STEERED_RUN_CAPTION,
  type AgentActivity,
  type BtwExchange,
  type ChangedFileSummary,
  type FileAttachment,
  type LinkedBoardTask,
  type Message,
  type OrchestrationRoleId,
  type Project,
  type ProviderId,
  type SidebarV2Settings,
  type Thread,
  type ThreadGoal,
  type ThreadTranscript,
  type TurnTokenStats,
} from './store';
import type {
  OrionMcpEntry,
  RemoteCommandRequest,
  RemoteControlState,
  RemoteMachineEntry,
} from './types';
import {
  inheritedSubagentResumeContext,
} from './thread-branching';
import { createThreadSteeringCoordinator } from './app/thread-steering';
import { Toaster, toast } from 'sonner';
import {
  agentProviders,
  claudeCodeCliModelId,
  claudeContextWindowOptions,
  claudeReasoningOptionsForModel,
  codexReasoningOptionsForModel,
  codexServiceTierOptions,
  defaultAgentModelId,
  defaultClaudeContextWindow,
  defaultClaudeReasoningEffort,
  defaultCodexServiceTier,
  getEffectiveClaudeReasoningEffort,
  getEffectiveCodexReasoningEffort,
  getEffectiveGrokReasoningEffort,
  getEffectiveMuseReasoningEffort,
  getEffectiveOpenCodeReasoningEffort,
  grokReasoningOptionsForModel,
  museReasoningOptionsForModel,
  openCodeReasoningOptionsForModel,
  fallbackAgentModels,
  findAgentModel,
  isClaudeCodeCliModelId,
  isOrionModelId,
  providerFollowUpSupport,
  type AgentModel,
  type AgentProviderId,
  type ClaudeContextWindow,
  type ClaudeReasoningEffort,
  type CodexReasoningEffort,
  type CodexServiceTier,
  type GrokReasoningEffort,
  type MuseReasoningEffort,
} from './agentCatalog';
import { ClaudeBrandIcon, CodexBrandIcon } from './providerIcons';
import orionIconUrl from '../assets/icon.png';
import { removeBootSkeleton } from './app/bootSkeleton';
import { CodeWorkspace } from './app/CodeWorkspace';
import { AgentsSidebar, type AgentsSidebarModel, SavedViewsSection, THREAD_DRAG_MIME } from './app/AgentsSidebar';
import { SidebarV2, type SidebarV2Actions } from './app/SidebarV2';
import { ProjectPickerModal, type ProjectPickerView } from './app/ProjectPickerModal';
import {
  compareSidebarV2Recent,
  mergeAttentionSince,
  pendingUserActions,
  sidebarRootThread,
  sidebarV2ThreadLists,
  threadsAwaitingUserAction,
  useStableIdList,
  useThreadsNeedingInput,
} from './app/threadLists';
import { UserActionCards } from './app/UserActions';
import { ThreadPane } from './app/ThreadPane';
import { BrowserPanel } from './app/BrowserPanel';
import { tabsForThread, useBrowserTabs, useCloseTabsOfFinishedThreads, useThreadParents, type BrowserTab } from './app/useBrowserTabs';
import { DeviceCard } from './app/DeviceCard';
import { ImageLightbox } from './app/imageLightbox';
import { ProjectBadge } from './app/ProjectBadge';
import DurangoWorkspaceControl from './app/DurangoWorkspaceControl';
import { TaskPickerPopover } from './app/TaskPickerPopover';
import {
  Composer,
  compareRecentThreadOrder,
  useLatestCallback,
  type ComposerReviewRequest,
} from './app/Composer';
import { createComposerDraftController } from './app/composerDraft';
import { ModelPickerPopover } from './app/ModelPickerPopover';
import { goalStatusLabels, goalSummaryLine, goalUsageSummary } from './app/activity';
import {
  claimRemoteSideEffect,
  claimRemoteThreadStart,
  mergeSynchronouslyTrackedRuns,
  persistSuccessfulRemoteCommand,
  remoteAgentSettingsPatch,
  remoteControlIsAuthenticated,
  remoteThreadRunError,
  remoteThreadRuntime,
  reportedSubagentSettingsPatch,
} from './app/remote-control-policy';
import { dispatchProjectsPayload, durangoDispatchOutcome } from './app/durangoDispatch';
import MachinePicker from './app/MachinePicker';
import RemoteBranchPill from './app/RemoteBranchPill';
import { dismissRemoteThread, remoteSettingsOf, remoteTurnSettingsToSend } from './app/remoteThreads';
import { useRemoteThreadSync, type RemoteThreadSync } from './app/useRemoteThreadSync';
import { buildPromptWithAttachments, saveFilesAsAttachments } from './app/attachments';
import {
  AgentFamilySwitcher,
  type ChatScrollPosition,
  ChatTranscript,
  isProviderAuthErrorText,
  type PaneChatRefs,
} from './app/chat';
import { InlineRenameInput } from './app/fileTree';
import {
  claudeOneMillionOnlyModelSlugs,
  getEffectiveClaudeContextWindow,
} from './app/modelPrefs';
import { resolveOrionMainDriverModel } from './app/orionDriver';
import {
  accessModeOptions,
  buildDurangoWorkspaceContext,
  buildGeneralInstructionsContext,
  buildLinkedTaskContext,
  buildModelMentionsContext,
  buildOrchestrationContext,
  buildReviewThreadContext,
  buildRemoteThreadMentionsContext,
  buildThreadMentionsContext,
  linkedTaskFromBoardTask,
  linkedTaskAttachments,
  linkedTaskStatusLabel,
  orchestrationRoleMeta,
  parseModelMentions,
  parseThreadMentions,
  retargetThreadMention,
} from './app/promptContext';
import { durangoWorkspaceName } from './app/durangoWorkspace';
import { hasThreadReaderSupport } from './app/chatMentions';
import { buildChatMentionsContext, knownDurangoChats, parseChatMentions } from './app/durangoChats';
import { shouldShowWorkspaceSyncNotice } from './app/workspaceSyncConsent';
import { WorkspaceSyncNotice } from './app/WorkspaceSyncNotice';
import { RestartToUpdateDialog, WhatsNewNotice } from './app/AppUpdateUi';
import { TextGenerationModelPrompt } from './app/TextGenerationModelPrompt';
import { addPromptContext, parseCodexReviewCommand } from './app/slashCommands';
import type { SlashCommandInfo } from './types';
import { withThreadStartReservation } from './app/turnStart';
import { buildMcpMentionsContext, mergeMcpAttachments, parseMcpMentions } from './app/orionMcps';
import { ORION_MCPS_CHANGED_EVENT } from './app/McpsSettings';
import { getThreadActivityTime } from './app/time';
import {
  deriveTitle,
  getGoalTitleSeed,
  isDefaultTitle,
  isPlausibleTitle,
  tryGenerateBetterTitle,
} from './app/titles';
import type { SidebarFooterProps } from './app/SidebarFooter';
import type { SettingsPageProps } from './app/SettingsPage';
import type {
  AppUpdateState,
  WhatsNewState,
  GitRepoState,
  OrionAccountState,
  ProviderUpdateProgress,
  ProviderUpdateState,
  SettingsTab,
  WorkspaceSyncStatus,
} from './app/appTypes';

// Lazy-loaded so xterm (and the TerminalView code) is split into its own
// chunk and only fetched/parsed when a Claude Code CLI thread is actually
// opened — the pseudo-model costs nothing at startup. (Its main-process
// counterpart, node-pty, is likewise only import()ed on first terminal:ensure.)
const TerminalView = React.lazy(() => import('./TerminalView'));
const SettingsPage = React.lazy(() => import('./app/SettingsPage'));
// Remote control is opt-in and rarely on screen; keep its view out of the
// startup chunk like the settings page.

const normalizeRepositoryPath = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');

// Stable empty list so the memoized sidebar doesn't re-render while remote
// control is off (a fresh [] every render would defeat React.memo).
const EMPTY_REMOTE_MACHINES: RemoteMachineEntry[] = [];
const EMPTY_THREAD_IDS: string[] = [];

/** A thread and its subagent threads at any depth. */
const threadFamilyIds = (threads: Thread[], rootId: string) => {
  const ids = [rootId];
  for (let index = 0; index < ids.length && ids.length < 500; index += 1) {
    for (const thread of threads) {
      if (thread.parentThreadId === ids[index] && !ids.includes(thread.id)) ids.push(thread.id);
    }
  }
  return ids;
};

// A thread's loaded transcript messages (undefined while it isn't loaded;
// ensureThreadTranscript loads it).
const loadedMessages = (threadId: string): Message[] | undefined =>
  useOrionStore.getState().transcripts[threadId]?.messages;

// How long a thread's queue waits after a queued message couldn't start.
const QUEUE_RETRY_DELAY_MS = 30_000;

const TRANSCRIPT_UNAVAILABLE_ERROR =
  "This thread's transcript could not be read from disk, so nothing was sent. Try again in a moment.";

// A thread's transcript messages, loading them first when needed. Null when
// the thread is gone or its stored transcript can't be read: callers must
// not build context (or start work) from a transcript they don't have.
const loadThreadMessages = async (threadId: string): Promise<Message[] | null> => {
  try {
    return (await ensureThreadTranscript(threadId))?.messages ?? null;
  } catch (error) {
    console.warn(`Could not load the transcript of thread ${threadId}`, error);
    return null;
  }
};

const dispatchedModelIdForProvider = (
  thread: Thread,
  providerId: string,
  preferredMessageId?: string
) => {
  const messages = loadedMessages(thread.id) ?? [];
  const matchesProvider = (message: Message) =>
    message.kind === 'agent-run' && message.modelId?.split(':', 1)[0] === providerId;
  const preferred = preferredMessageId
    ? messages.find((message) => message.id === preferredMessageId)
    : undefined;
  if (preferred && matchesProvider(preferred)) return preferred.modelId;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (matchesProvider(messages[index])) return messages[index].modelId;
  }
  return undefined;
};

const qualifyProviderModelId = (providerId: string, modelId?: string) => {
  if (!modelId) return undefined;
  return modelId.includes(':') ? modelId : `${providerId}:${modelId}`;
};

const formatBytes = (bytes: number | null | undefined) => {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 100 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
};

const THREADS_VISIBLE_LIMIT = 5;
// Sidebar v2's first-switch settle covers the threads from before this launch.
const APP_LAUNCHED_AT = Date.now();

type AgentRunStartupResult = { ok: boolean; runId?: string; error?: string };
type ThreadTurnStartResult =
  | { ok: false; error?: string }
  | { ok: true; startup: Promise<AgentRunStartupResult> };

// Which group of the composer's overflow menu is expanded, when the controls
// row is too narrow to show them as separate chips. One at a time.
type ComposerMenuSection = 'agent' | 'access' | 'tasks' | null;

// Width the composer controls need before they start colliding, estimated from
// the labels they will render rather than measured: the collapsed row can't
// measure the expanded one, and re-measuring after each switch would oscillate.
// Deliberately generous — a chip that just fits looks cramped anyway.
const estimateChipWidth = (label: string, perChar: number, fixed: number) =>
  Math.ceil(label.length * perChar) + fixed;

// Default order for Orion's hidden text-generation turns (thread titles,
// commit messages, PR descriptions) when the user hasn't picked a model in
// Settings. There is deliberately no further fallback: with neither model
// usable, the user is asked to pick one (TextGenerationModelPrompt).
const UTILITY_MODEL_PREFERENCE = ['codex:gpt-6-luna', 'claude:claude-haiku-5-5'];

type ReasoningOption = { value: string; label: string };

const reasoningOptionsForModel = (model: AgentModel | null | undefined): ReasoningOption[] => {
  const toOptions = (options: Array<{ value: string; label: string }>) =>
    options.map(({ value, label }) => ({ value, label }));
  if (!model) return [];
  if (model.providerId === 'codex') return toOptions(codexReasoningOptionsForModel(model));
  if (model.providerId === 'claude') return toOptions(claudeReasoningOptionsForModel(model));
  if (model.providerId === 'grok') return toOptions(grokReasoningOptionsForModel(model));
  if (model.providerId === 'muse') return toOptions(museReasoningOptionsForModel(model));
  if (model.providerId === 'opencode') return toOptions(openCodeReasoningOptionsForModel(model));
  return [];
};

const defaultReasoningEffortForModel = (model: AgentModel | null | undefined): string | null => {
  if (!model) return null;
  if (model.providerId === 'codex') return getEffectiveCodexReasoningEffort(model, undefined);
  if (model.providerId === 'claude') return getEffectiveClaudeReasoningEffort(model, undefined);
  if (model.providerId === 'grok') return getEffectiveGrokReasoningEffort(model, undefined);
  if (model.providerId === 'muse') return getEffectiveMuseReasoningEffort(model, undefined);
  if (model.providerId === 'opencode') return getEffectiveOpenCodeReasoningEffort(model, undefined);
  return null;
};

type ThreadReasoningPatch = Partial<
  Pick<
    Thread,
    | 'codexReasoningEffort'
    | 'claudeReasoningEffort'
    | 'grokReasoningEffort'
    | 'museReasoningEffort'
    | 'openCodeReasoningEffort'
  >
>;

const threadReasoningPatchForModel = (
  model: AgentModel | null | undefined,
  effort: string | null
): ThreadReasoningPatch => {
  if (!model || !effort) return {};
  if (model.providerId === 'codex') return { codexReasoningEffort: effort as CodexReasoningEffort };
  if (model.providerId === 'claude') return { claudeReasoningEffort: effort as ClaudeReasoningEffort };
  if (model.providerId === 'grok') return { grokReasoningEffort: effort as GrokReasoningEffort };
  if (model.providerId === 'muse') return { museReasoningEffort: effort as MuseReasoningEffort };
  if (model.providerId === 'opencode') return { openCodeReasoningEffort: effort };
  return {};
};

// Orion Cloud builds on Railway, which takes minutes; poll until the app row
// settles, then give up so a build that never reports back stops costing
// requests for the rest of the session.
const CLOUD_DEPLOY_POLL_INTERVAL_MS = 4000;
// Match the packaged app update scheduler so both update banners stay fresh.
const PROVIDER_UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
const CLOUD_DEPLOY_POLL_TIMEOUT_MS = 20 * 60 * 1000;

const cloudAppHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Plan and usage settings on whichever Durango this desktop talks to. */
const cloudBillingUrl = (repoWebUrl: string | null | undefined) => {
  try {
    return new URL('/settings?tab=usage', repoWebUrl ?? 'https://durango.sh').toString();
  } catch {
    return 'https://durango.sh/settings?tab=usage';
  }
};

// Threads with a Durango workspace (docs/workspaces.md) run their agent
// processes inside it instead of the project directory.
// Where a thread's agent runs: the workspace the app made for it, else the
// project. A workspace the agent made itself mid-thread is not a run
// directory — the thread's sessions were recorded in the project directory.
const threadWorkingDir = (thread: Pick<Thread, 'durangoWorkspace'> | undefined, project: Project) =>
  thread?.durangoWorkspace && !thread.durangoWorkspace.adopted ? thread.durangoWorkspace.workingDir : project.path;

// `durango-code ws new <name>` or `ws rm <name>` (or an alias) in a shell
// command an agent ran.
const WS_COMMAND = /\b(?:durango-code|ds|durango-source|orion-cli)\s+ws\s+(new|rm)\s+([^\n;&|]*)/g;
// `ws new` options that take a value (`--from <rev>`, `--repo <dir>`, `--change <id>`).
const WS_NEW_VALUE_FLAGS = new Set(['--from', '--repo', '--change']);
const workspaceNameFromWsArgs = (args: string) =>
  args
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ''))
    .find((token, index, tokens) => token && !token.startsWith('-') && !WS_NEW_VALUE_FLAGS.has(tokens[index - 1] ?? '')) ??
  null;

const activityRanWorkspaceCommand = (activity: AgentActivity) =>
  /\bws\s+(?:new|rm)\s/.test(`${activity.title}\n${activity.input ?? ''}`);

/**
 * The last `ws new` / `ws rm` that succeeded in a turn. Mid-turn only finished
 * commands count; once the turn is over, so does any that did not fail.
 */
const lastWorkspaceCommand = (activities: AgentActivity[], turnOver: boolean) => {
  let last: { action: 'new' | 'rm'; name: string } | null = null;
  for (const activity of activities) {
    if (!turnOver && activity.status !== 'done' && activity.exitCode === undefined) continue;
    if (activity.status === 'error' || (activity.exitCode !== undefined && activity.exitCode !== 0)) continue;
    const text = `${activity.title}\n${activity.input ?? ''}`;
    for (const match of text.matchAll(WS_COMMAND)) {
      const name = workspaceNameFromWsArgs(match[2]);
      if (name) last = { action: match[1] as 'new' | 'rm', name };
    }
  }
  return last;
};

const WORKSPACE_PRESENCE_POLL_MS = 15_000;

/**
 * Threads whose workspace directory is gone (the agent ran `ws rm`, or it was
 * removed outside the app) stop pointing at it, so the composer shows the
 * project's own branch again. An adopted workspace was never the run
 * directory, so it is simply detached; a workspace the app made held the
 * thread's sessions, so they go too and the next message starts over, as after
 * Remove workspace. Those wait while an agent is still running inside it.
 */
const releaseMissingDurangoWorkspaces = async (paths?: string[]) => {
  const tracked = [
    ...new Set(
      useOrionStore
        .getState()
        .threads.flatMap((thread) => (thread.durangoWorkspace ? [thread.durangoWorkspace.path] : []))
    ),
  ].filter((path) => !paths || paths.includes(path));
  if (tracked.length === 0 || !window.orion?.missingDurangoWorkspaces) return;
  const missing = await window.orion.missingDurangoWorkspaces({ paths: tracked }).catch(() => []);
  if (missing.length === 0) return;
  const removedAt = new Date().toISOString();
  let released = false;
  for (const path of missing) {
    const state = useOrionStore.getState();
    const sharing = state.threads.filter((thread) => thread.durangoWorkspace?.path === path);
    if (sharing.some((thread) => !thread.durangoWorkspace?.adopted && thread.status === 'running')) continue;
    for (const thread of sharing) {
      released = true;
      if (thread.durangoWorkspace?.adopted) {
        state.updateThread(thread.id, { durangoWorkspace: undefined });
        continue;
      }
      void window.orion.disposeAgentThread?.(thread.id);
      state.updateThread(thread.id, {
        durangoWorkspace: undefined,
        durangoWorkspaceRemovedAt: removedAt,
        agentSessionIds: undefined,
        pendingForkProviders: undefined,
      });
    }
  }
  if (released) await flushOrionThreadsSave();
};

/**
 * Agents create their workspace when they start real work (the
 * durango-workspaces skill) and remove it once its change has landed. After
 * each `ws new` / `ws rm` and at the end of a turn, the thread follows: the
 * workspace the agent last made is attached (replacing an earlier one it
 * made), so the header shows it with Land / Run dev server and deleting the
 * thread cleans it up; one that is gone is released.
 */
const syncAgentWorkspace = async (threadId: string, messageId: string, turnOver: boolean) => {
  const state = useOrionStore.getState();
  const thread = findThread(state.threads, threadId);
  if (!thread) return;
  const message = state.transcripts[threadId]?.messages.find((candidate) => candidate.id === messageId);
  const last = lastWorkspaceCommand(message?.activities ?? [], turnOver);
  const current = thread.durangoWorkspace;
  if (
    last?.action === 'new' &&
    /^[a-z0-9][a-z0-9_-]{0,47}$/.test(last.name) &&
    (!current || (current.adopted && current.name !== last.name)) &&
    window.orion?.findDurangoWorkspace
  ) {
    const project = findProjectById(state, thread.projectId);
    if (project && !isNoProjectId(project.id)) {
      const result = await window.orion.findDurangoWorkspace({ projectPath: project.path, name: last.name }).catch(() => null);
      const latest = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId)?.durangoWorkspace;
      if (result?.ok && result.workspace && (!latest || (latest.adopted && latest.path !== result.workspace.path))) {
        useOrionStore.getState().updateThread(threadId, { durangoWorkspace: { ...result.workspace, adopted: true } });
      }
    }
  }
  const workspace = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId)?.durangoWorkspace;
  if (workspace) await releaseMissingDurangoWorkspaces([workspace.path]);
};

const getStoredThreadTitle = (threadId: string) =>
  useOrionStore.getState().threads.find((thread) => thread.id === threadId)?.title;

// Provider-native ids are not necessarily globally unique (Kimi uses values
// such as agent-0 per session). Reload recovery may search nested descendants,
// but it must never escape the Orion thread whose run emitted the event.
const descendantThreadIds = (threads: Thread[], rootThreadId: string): Set<string> => {
  const ids = new Set<string>([rootThreadId]);
  let foundChild = true;
  while (foundChild) {
    foundChild = false;
    for (const thread of threads) {
      if (thread.parentThreadId && ids.has(thread.parentThreadId) && !ids.has(thread.id)) {
        ids.add(thread.id);
        foundChild = true;
      }
    }
  }
  return ids;
};

// Keep the shell/sidebar subscription independent from transcript payloads.
// A token chunk replaces a Thread object, but none of these metadata fields,
// so useShallow keeps App asleep while ChatTranscript handles the update.
const threadShellSignatureCache = new WeakMap<Thread, string>();
const threadShellSignature = (thread: Thread): string => {
  const cached = threadShellSignatureCache.get(thread);
  if (cached !== undefined) return cached;

  const lastMessage = thread.summary.lastMessage;
  const queuedIds = thread.queuedMessages?.map((message) => message.id).join(',') ?? '';
  const signature = [
    thread.id,
    thread.projectId,
    thread.title,
    thread.status,
    thread.modelId,
    thread.accessMode,
    thread.codexReasoningEffort,
    thread.codexServiceTier,
    thread.claudeReasoningEffort,
    thread.claudeContextWindow,
    thread.grokReasoningEffort,
    thread.museReasoningEffort,
    thread.openCodeReasoningEffort,
    thread.createdAt,
    thread.hiddenFromRecent ? '1' : '0',
    thread.pinnedAt,
    thread.unpinnedAt,
    // Drives the sidebar's finished-but-unopened dot, and clearing it on open
    // changes nothing else — so the shell has to wake for it.
    thread.finishedUnseenAt,
    // Sidebar v2 lists and row tints.
    thread.snoozedAt,
    thread.settledAt,
    thread.wokeAt,
    thread.wokeReason,
    thread.importedUnseen ? '1' : '0',
    thread.parentThreadId,
    thread.branchedFromThreadId,
    thread.spawnId,
    thread.terminalActivityAt,
    thread.summary.messageCount,
    thread.summary.workingSince,
    thread.summary.workedMs,
    lastMessage?.id,
    lastMessage?.ts,
    lastMessage?.status,
    lastMessage?.completedAt,
    queuedIds,
    JSON.stringify(thread.agentSessionIds ?? null),
    JSON.stringify(thread.pendingForkProviders ?? null),
    JSON.stringify(thread.subagent ?? null),
    JSON.stringify(thread.inheritedSubagent ?? null),
    JSON.stringify(thread.goal ?? null),
    JSON.stringify(thread.linkedTasks ?? null),
    // The machine it runs on (prompt box picker, sidebar label).
    JSON.stringify(thread.remote ?? null),
    // Pinned user actions (request_user_action) and their row tint.
    JSON.stringify(thread.userActions ?? null),
    // Composer chips for @-attached MCP servers.
    (thread.mcpServerIds ?? []).join(','),
    // The header's workspace pill and run directory; an agent can attach its
    // own workspace when a turn ends, after every other field has settled.
    JSON.stringify(thread.durangoWorkspace ?? null),
    thread.durangoWorkspaceRemovedAt,
  ].join('\u0000');
  threadShellSignatureCache.set(thread, signature);
  return signature;
};

// The signatures of every shell, recomputed only when `threads` changes:
// zustand runs this selector on every store update, including each streamed
// chunk, which no longer touches `threads`.
let signaturesThreads: Thread[] | null = null;
let signatures: string[] = [];
const selectThreadShellSignatures = (state: { threads: Thread[] }) => {
  if (state.threads !== signaturesThreads) {
    signaturesThreads = state.threads;
    signatures = state.threads.map(threadShellSignature);
  }
  return signatures;
};

const formatCheckedTime = (iso: string): string => {
  try {
    const then = new Date(iso).getTime();
    const mins = Math.max(0, Math.floor((Date.now() - then) / 60000));
    if (mins < 1) return 'just now';
    if (mins === 1) return '1m ago';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch {
    return 'recently';
  }
};

const renderThreadCliBadge = (thread: Thread) =>
  isClaudeCodeCliModelId(thread.modelId) ? (
    <span className="thread-cli-badge" title="Claude Code CLI" aria-label="Claude Code CLI">
      <Terminal size={10} strokeWidth={2.4} aria-hidden />
    </span>
  ) : null;

const renderThreadStatusDot = (thread: Thread) => {
  if (thread.status === 'running') {
    return <span className="thread-working-dot" title="Working" />;
  }
  // Imported from Claude Code / Codex and not opened yet: the source
  // provider's mark takes the unseen dot's place until the thread is opened.
  if (thread.importedUnseen && thread.importedFrom) {
    const source = thread.importedFrom.providerId === 'claude' ? 'Claude Code' : 'Codex';
    const Icon = thread.importedFrom.providerId === 'claude' ? ClaudeBrandIcon : CodexBrandIcon;
    return (
      <span
        className={`thread-import-badge ${thread.importedFrom.providerId}`}
        title={`Imported from ${source} — not opened yet`}
        aria-label={`Imported from ${source}`}
      >
        <Icon size={10} />
      </span>
    );
  }
  if (!thread.finishedUnseenAt) return null;
  const failed = thread.status === 'error';
  return (
    <span
      className={`thread-finished-dot ${failed ? 'error' : ''}`}
      title={failed ? 'Failed — not opened yet' : 'Finished — not opened yet'}
    />
  );
};

// "[Durango memory]" block for a fresh agent session when the user opted in
// (Settings → Durango). Main caches the recall for 10 minutes; a slow or
// unreachable Durango never holds a turn back for more than a few seconds.
const DURANGO_PROFILE_MEMORY_WAIT_MS = 4_000;
const fetchDurangoProfileMemoryBlock = async (): Promise<string> => {
  if (!window.orion?.durangoProfileMemory) return '';
  try {
    const result = await Promise.race([
      window.orion.durangoProfileMemory(),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), DURANGO_PROFILE_MEMORY_WAIT_MS)),
    ]);
    return result?.ok ? result.block : '';
  } catch {
    return '';
  }
};

// Caption for a turn that ended while the harness still owns live background
// tasks (subagents, workflows, backgrounded shell commands). Task descriptions
// come from the driver's done event; naming them lets the user tell a genuine
// wait from e.g. a dev server that will never exit. The store's restart
// migration matches this caption by pattern — keep the two in sync.
const waitingOnBackgroundStatusText = (tasks: string[]): string => {
  const clip = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text);
  if (tasks.length === 1) return `Waiting on background task: ${clip(tasks[0])}…`;
  const shown = tasks.slice(0, 2).map(clip).join(', ');
  const more = tasks.length - 2;
  return `Waiting on ${tasks.length} background tasks: ${shown}${more > 0 ? ` (+${more} more)` : ''}…`;
};

// Caption of a turn that ended with actions still pending on the user
// (request_user_action), from the thread or its subagents: the agent stopped
// on purpose and is re-invoked once they are answered. Back to "Finished."
// when the last one is.
const WAITING_ON_USER_PREFIX = 'Waiting on you: ';
const waitingOnUserStatusText = (threadId: string): string | undefined => {
  const pending = pendingUserActions(useOrionStore.getState().threads, threadId);
  if (pending.length === 0) return undefined;
  const first = pending[0].action.replace(/\s+/g, ' ').trim();
  const clipped = first.length > 80 ? `${first.slice(0, 79)}…` : first;
  return `${WAITING_ON_USER_PREFIX}${clipped}${pending.length > 1 ? ` (+${pending.length - 1} more)` : ''}`;
};
// Pending actions count a thread's subagents, so the caption can sit on any
// ancestor of the thread whose action went: settle each one up the chain.
const settleWaitingOnUserCaptions = (threadId: string) => {
  const state = useOrionStore.getState();
  const seen = new Set<string>();
  let thread = state.threads.find((candidate) => candidate.id === threadId);
  while (thread && !seen.has(thread.id)) {
    seen.add(thread.id);
    if (pendingUserActions(state.threads, thread.id).length > 0) return;
    // Only a thread whose last turn finished can carry the caption.
    if (thread.summary.lastAgentRun?.status === 'done') {
      state.updateThreadTranscript(thread.id, (transcript) => {
        const lastRun = [...transcript.messages].reverse().find((message) => message.role === 'agent');
        if (lastRun?.status !== 'done' || !lastRun.statusText?.startsWith(WAITING_ON_USER_PREFIX)) return transcript;
        return {
          ...transcript,
          messages: transcript.messages.map((message) =>
            message.id === lastRun.id ? { ...message, statusText: 'Finished.' } : message
          ),
        };
      });
    }
    const parentId = thread.parentThreadId;
    thread = parentId ? state.threads.find((candidate) => candidate.id === parentId) : undefined;
  }
};

/** How a steer ended: in the turn, queued for its end, handed back, or cancelled by Stop. */
type SteerOutcome = 'steered' | 'queued' | 'unsteered' | 'cancelled';

const App: React.FC = () => {
  const {
    activeTab,
    setActiveTab,
    settingsOpen,
    setSettingsOpen,
    projects,
    noProject,
    setNoProjectPath,
    selectedProjectId,
    selectedThreadId,
    paneThreadIds,
    openThreadInSplit,
    closeThreadPane,
    savedViews,
    activeSavedViewId,
    openSavedView,
    deleteSavedView,
    splitViewSettings,
    setSplitViewSettings,
    durangoWorkspaceSettings,
    setDurangoWorkspaceSettings,
    workspaceSyncSettings,
    setWorkspaceSyncSettings,
    remoteControlSettings,
    setRemoteControlSettings,
    snapShotSettings,
    deploymentSettings,
    setDeploymentSettings,
    sidebarV2Settings,
    setSidebarV2Settings,
    addProject,
    removeProject,
    renameProject,
    createThread,
    branchThread,
    selectProject,
    selectThread,
    updateThread,
    deleteThread,
    addMessageToThread,
    appendToThreadMessage,
    updateThreadMessage,
    addActivityToThreadMessage,
    workspacePath,
    setWorkspacePath,
    activeFilePath,
    closeAllFiles,
    providerSettings,
    setProviderEnabled,
    setProviderOptions,
    orchestrationSettings,
    setOrchestrationRoleModel,
    setOrchestrationGeneralInstructions,
    notificationSettings,
    setNotificationSettings,
    textGenerationSettings,
    setTextGenerationSettings,
    setThreadAgentSession,
    queueMessageToThread,
    removeQueuedThreadMessage,
    addBtwExchange,
    appendToBtwExchange,
    updateBtwExchange,
    removeBtwExchange,
  } = useOrionStore(
    useShallow((state) => ({
      activeTab: state.activeTab,
      setActiveTab: state.setActiveTab,
      settingsOpen: state.settingsOpen,
      setSettingsOpen: state.setSettingsOpen,
      projects: state.projects,
      noProject: state.noProject,
      setNoProjectPath: state.setNoProjectPath,
      selectedProjectId: state.selectedProjectId,
      selectedThreadId: state.selectedThreadId,
      paneThreadIds: state.paneThreadIds,
      openThreadInSplit: state.openThreadInSplit,
      closeThreadPane: state.closeThreadPane,
      savedViews: state.savedViews,
      activeSavedViewId: state.activeSavedViewId,
      openSavedView: state.openSavedView,
      deleteSavedView: state.deleteSavedView,
      splitViewSettings: state.splitViewSettings,
      setSplitViewSettings: state.setSplitViewSettings,
      durangoWorkspaceSettings: state.durangoWorkspaceSettings,
      setDurangoWorkspaceSettings: state.setDurangoWorkspaceSettings,
      workspaceSyncSettings: state.workspaceSyncSettings,
      setWorkspaceSyncSettings: state.setWorkspaceSyncSettings,
      remoteControlSettings: state.remoteControlSettings,
      setRemoteControlSettings: state.setRemoteControlSettings,
      snapShotSettings: state.snapShotSettings,
      deploymentSettings: state.deploymentSettings,
      setDeploymentSettings: state.setDeploymentSettings,
      sidebarV2Settings: state.sidebarV2Settings,
      setSidebarV2Settings: state.setSidebarV2Settings,
      addProject: state.addProject,
      removeProject: state.removeProject,
      renameProject: state.renameProject,
      createThread: state.createThread,
      branchThread: state.branchThread,
      selectProject: state.selectProject,
      selectThread: state.selectThread,
      updateThread: state.updateThread,
      deleteThread: state.deleteThread,
      addMessageToThread: state.addMessageToThread,
      appendToThreadMessage: state.appendToThreadMessage,
      updateThreadMessage: state.updateThreadMessage,
      addActivityToThreadMessage: state.addActivityToThreadMessage,
      workspacePath: state.workspacePath,
      setWorkspacePath: state.setWorkspacePath,
      activeFilePath: state.activeFilePath,
      closeAllFiles: state.closeAllFiles,
      providerSettings: state.providerSettings,
      setProviderEnabled: state.setProviderEnabled,
      setProviderOptions: state.setProviderOptions,
      orchestrationSettings: state.orchestrationSettings,
      setOrchestrationRoleModel: state.setOrchestrationRoleModel,
      setOrchestrationGeneralInstructions: state.setOrchestrationGeneralInstructions,
      notificationSettings: state.notificationSettings,
      setNotificationSettings: state.setNotificationSettings,
      textGenerationSettings: state.textGenerationSettings,
      setTextGenerationSettings: state.setTextGenerationSettings,
      setThreadAgentSession: state.setThreadAgentSession,
      queueMessageToThread: state.queueMessageToThread,
      removeQueuedThreadMessage: state.removeQueuedThreadMessage,
      addBtwExchange: state.addBtwExchange,
      appendToBtwExchange: state.appendToBtwExchange,
      updateBtwExchange: state.updateBtwExchange,
      removeBtwExchange: state.removeBtwExchange,
    }))
  );
  const threadShellSignatures = useOrionStore(useShallow(selectThreadShellSignatures));
  // Branching loads the transcripts it copies; one that can't be read fails
  // the branch, and the user is told rather than given a partial copy.
  const branchThreadWithFeedback = useCallback(
    async (sourceThreadId: string) => {
      try {
        return await branchThread(sourceThreadId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'The thread could not be branched.');
        return null;
      }
    },
    [branchThread]
  );
  const threads = useMemo(() => useOrionStore.getState().threads, [threadShellSignatures]);
  // Bumped when a turn completes without the thread leaving 'running' (a
  // Claude turn still waiting on background agents) — invisible to the
  // runningAgentCount-based refresh below, but its files are on disk.
  const [treeTurnRefreshTick, setTreeTurnRefreshTick] = useState(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  // One agent run may be active per thread; runs in other threads are
  // independent, so starting/stopping one never blocks the rest.
  const [activeRunsByThread, setActiveRunsByThread] = useState<Record<string, string>>({});
  // The agent's predicted next prompt per thread (Claude's promptSuggestions),
  // offered in the empty composer until the thread's next turn starts or the
  // user dismisses it. Kept in memory only.
  const [promptSuggestions, setPromptSuggestions] = useState<Record<string, string>>({});
  // The run that most recently started on each thread. A suggestion lands a
  // moment after its run's result; one from an older run (the user already
  // sent again, maybe on another provider) is stale.
  const latestStartedRunByThread = useRef(new Map<string, string>());
  const activeRunsByThreadRef = useRef(activeRunsByThread);
  useEffect(() => {
    activeRunsByThreadRef.current = activeRunsByThread;
  }, [activeRunsByThread]);
  const activeRunId = selectedThreadId ? (activeRunsByThread[selectedThreadId] ?? null) : null;
  const isSending = Boolean(activeRunId);
  const clearActiveRun = useCallback((runId: string) => {
    setActiveRunsByThread((current) => {
      const next: Record<string, string> = {};
      let changed = false;
      for (const [threadId, id] of Object.entries(current)) {
        if (id === runId) changed = true;
        else next[threadId] = id;
      }
      return changed ? next : current;
    });
  }, []);
  const [agentModels, setAgentModels] = useState<AgentModel[]>(fallbackAgentModels);
  // Whether agentModels holds the main process's list (with availability)
  // rather than the static fallback, which claims every model is usable.
  const [agentModelsLoaded, setAgentModelsLoaded] = useState(false);
  const [textGenerationPromptDismissed, setTextGenerationPromptDismissed] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  // Settings → General → Text generation drives its own copy of the picker
  // state so opening it never disturbs the composer's picker.
  const [utilityModelPickerOpen, setUtilityModelPickerOpen] = useState(false);
  const [utilityModelSearch, setUtilityModelSearch] = useState('');
  const [utilityModelTab, setUtilityModelTab] = useState<AgentProviderId>('codex');
  const [threadReaderSupport, setThreadReaderSupport] = useState<{
    providerId: AgentProviderId;
    supported: boolean;
  } | null>(null);
  // Slash-command menu (Claude Code style): the real command list reported by
  // each project's Claude session (the menu itself lives in the Composer).
  const [slashCommandsByProject, setSlashCommandsByProject] = useState<
    Record<string, SlashCommandInfo[]>
  >({});
  const [activeProviderTab, setActiveProviderTab] = useState<AgentProviderId>('grok');
  const [codexSettingsOpen, setCodexSettingsOpen] = useState(false);
  const [accessModeOpen, setAccessModeOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectPickerView, setProjectPickerView] = useState<ProjectPickerView>('projects');
  const openProjectPicker = useCallback(() => {
    setProjectPickerView('projects');
    setProjectPickerOpen(true);
  }, []);
  const openAddProjectPicker = useCallback(() => {
    setProjectPickerView('add-project');
    setProjectPickerOpen(true);
  }, []);
  const closeProjectPicker = useCallback(() => setProjectPickerOpen(false), []);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);

  useEffect(() => {
    if (isSending) setAccessModeOpen(false);
  }, [isSending]);

  useEffect(() => {
    if (!branchPickerOpen) setCreatingBranch(false);
  }, [branchPickerOpen]);
  const [openWithApps, setOpenWithApps] = useState<Array<{ id: string; name: string; icon: string | null }>>([]);
  const [openWithOpen, setOpenWithOpen] = useState(false);
  const [threadSearchOpen, setThreadSearchOpen] = useState(false);
  const [gitState, setGitState] = useState<GitRepoState | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitBusy, setGitBusy] = useState(false);
  const [cloudState, setCloudState] = useState<OrionCloudState | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  // Orion Cloud apps we've heard about since launch, keyed by working dir: a
  // deploy we just queued, a redeploy a push kicked off, and every poll while a
  // build runs. cloudState carries the server's copy on each refresh, so this
  // only has to hold what is fresher than the last refresh.
  const [cloudAppsByDir, setCloudAppsByDir] = useState<Record<string, OrionCloudApp | null>>({});
  const [cloudDeployingDir, setCloudDeployingDir] = useState<string | null>(null);
  // Dirs whose in-flight build the user is waiting on, so only a deploy they
  // started toasts when it settles.
  const cloudDeployWatchRef = useRef<Set<string>>(new Set());
  const cloudDeployPollStartRef = useRef<Record<string, number>>({});
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [goalMenuOpen, setGoalMenuOpen] = useState(false);
  const [projectMenuOpenId, setProjectMenuOpenId] = useState<string | null>(null);
  // Keys are namespaced ("shell:<id>", "recent:<id>", "project:<id>") because the
  // same thread can appear in both the Recent agents list and its project list.
  const [threadItemMenuKey, setThreadItemMenuKey] = useState<string | null>(null);
  const [threadRenameKey, setThreadRenameKey] = useState<string | null>(null);
  const [projectRenameId, setProjectRenameId] = useState<string | null>(null);
  const [threadListLimits, setThreadListLimits] = useState<Record<string, number>>({});
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  // Nested subthread lists (keyed by parent thread id), shared between the
  // Recent agents list and the project lists.
  const [recentAgentsOpen, setRecentAgentsOpen] = useState(true);
  const [recentAgentsShowAll, setRecentAgentsShowAll] = useState(false);
  const [pinnedAgentsOpen, setPinnedAgentsOpen] = useState(true);
  const [pinnedAgentsShowAll, setPinnedAgentsShowAll] = useState(false);
  const [savedViewsSectionOpen, setSavedViewsSectionOpen] = useState(true);
  // Threads whose Durango workspace is being created (before their first
  // turn) or removed. Mirrored in refs so turn dispatch, which reads state at
  // call time, never starts an agent while its working directory is changing.
  const [workspaceSetupThreadIds, setWorkspaceSetupThreadIds] = useState<Record<string, boolean>>({});
  const workspaceSetupThreadIdsRef = useRef<Set<string>>(new Set());
  const [workspaceRemovalThreadIds, setWorkspaceRemovalThreadIds] = useState<Record<string, boolean>>({});
  const workspaceRemovalThreadIdsRef = useRef<Set<string>>(new Set());
  const markWorkspaceThreads = useCallback(
    (kind: 'setup' | 'removal', threadIds: Iterable<string>, pending: boolean) => {
      const ref = kind === 'setup' ? workspaceSetupThreadIdsRef : workspaceRemovalThreadIdsRef;
      const setIds = kind === 'setup' ? setWorkspaceSetupThreadIds : setWorkspaceRemovalThreadIds;
      const ids = [...threadIds];
      for (const threadId of ids) {
        if (pending) ref.current.add(threadId);
        else ref.current.delete(threadId);
      }
      setIds((current) => {
        const next = { ...current };
        for (const threadId of ids) {
          if (pending) next[threadId] = true;
          else delete next[threadId];
        }
        return next;
      });
    },
    []
  );
  // Shell-wide guard: the workspace project/branch pickers and cloud actions
  // stand down while any repository work is in flight.
  const repositoryOperationBusy = gitBusy || cloudBusy;
  useEffect(() => {
    if (!repositoryOperationBusy) return;
    setProjectPickerOpen(false);
    setBranchPickerOpen(false);
  }, [repositoryOperationBusy]);
  const [providerUpdateState, setProviderUpdateState] = useState<ProviderUpdateState | null>(null);
  const [providerUpdatesChecking, setProviderUpdatesChecking] = useState(false);
  const [providerUpdatesRunning, setProviderUpdatesRunning] = useState(false);
  const [providerUpdateProgress, setProviderUpdateProgress] = useState<ProviderUpdateProgress | null>(null);
  const providerUpdateInvocationRef = useRef(false);
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState | null>(null);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const [restartToUpdateConfirmOpen, setRestartToUpdateConfirmOpen] = useState(false);
  const [whatsNew, setWhatsNew] = useState<WhatsNewState | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('account');
  const [authenticatingProviderId, setAuthenticatingProviderId] = useState<string | null>(null);
  const [accountState, setAccountState] = useState<OrionAccountState>({
    authenticated: false,
    user: null,
    expiresAt: null,
  });
  const [accountLoading, setAccountLoading] = useState(true);
  const [accountBusy, setAccountBusy] = useState(false);
  const [computerUsePerms, setComputerUsePerms] = useState<OrionComputerUsePermissions | null>(null);
  const [computerUseBusyKind, setComputerUseBusyKind] = useState<OrionComputerUsePermissionKind | null>(null);
  const [revealedProviderEmails, setRevealedProviderEmails] = useState<Record<string, boolean>>({});
  const [revealedAccountIdentity, setRevealedAccountIdentity] = useState<string | null>(null);
  const [expandedProviderOptions, setExpandedProviderOptions] = useState<Record<string, boolean>>({});
  const projectPickerRef = useRef<HTMLDivElement>(null);
  const branchPickerRef = useRef<HTMLDivElement>(null);
  const openWithRef = useRef<HTMLDivElement>(null);
  const threadSearchRef = useRef<HTMLDivElement>(null);
  const threadMenuRef = useRef<HTMLDivElement>(null);
  const goalMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const threadItemMenuRef = useRef<HTMLDivElement>(null);
  const runOutputMessages = useRef(new Map<string, { threadId: string; messageId: string }>());
  // `/btw` side-question runs, routed to a thread's btwExchanges instead of
  // its transcript. Kept separate from runOutputMessages so aside runs never
  // touch thread status, queued-message dispatch, or the active-run map.
  const btwRuns = useRef(new Map<string, { threadId: string; exchangeId: string }>());
  // Provider-native subagents streamed by main (subagent/subagent-chunk/
  // subagent-activity events): `${parentThreadId}:${providerId}:${subagentId}`
  // → the child thread + agent-run message their transcript streams into.
  const nativeSubagentTargets = useRef(new Map<string, { threadId: string; messageId: string }>());
  // Subagents whose events arrived with no thread to bind to (keys as above).
  const unboundNativeSubagents = useRef(new Set<string>());
  const agentModelsRef = useRef<AgentModel[]>(fallbackAgentModels);
  const startRemoteTurnRef = useRef<
    (threadId: string, promptText: string, attachments?: FileAttachment[]) => Promise<{ ok: boolean; error?: string }>
  >(
    async () => ({ ok: false, error: 'Remote control is not ready.' })
  );
  const startTurnForThreadRef = useRef<
    | ((
        threadId: string,
        promptText: string,
        attachments: FileAttachment[],
        claimStart?: () => Promise<boolean>,
        applyClaimedSettings?: () => void,
        extraContext?: string
      ) => Promise<ThreadTurnStartResult>)
    | null
  >(null);
  // In-flight snapshot refreshes, keyed by `${threadId} ${taskId}`.
  const linkedTaskRefreshesRef = useRef(new Map<string, Promise<void>>());
  // Shared unlink requests prevent the picker and composer chip from issuing
  // competing mutations for the same thread/task pair.
  const linkedTaskUnlinksRef = useRef(new Map<string, Promise<boolean>>());
  const pendingTurnStartsRef = useRef(new Set<string>());
  // A steer reserves its thread synchronously, before linked-task refreshes or
  // transcript saves yield. This preserves submission order and prevents two
  // steers from consuming the same uninjected Board context.
  const steeringCoordinatorRef = useRef(createThreadSteeringCoordinator());
  const cancelPendingSteers = useCallback((threadIds: Iterable<string>) => {
    steeringCoordinatorRef.current.cancel(threadIds);
  }, []);
  const dragDepth = useRef(0);
  // Each pane scrolls its own transcript, so the DOM refs and the pinned/offset
  // bookkeeping are per thread rather than per shell. Entries are plain objects
  // created on demand — no hooks — so a pane opening mid-render is fine.
  const paneChatRefsRef = useRef(new Map<string, PaneChatRefs>());
  const paneChatRefs = useCallback((threadId: string): PaneChatRefs => {
    const existing = paneChatRefsRef.current.get(threadId);
    if (existing) return existing;
    const created: PaneChatRefs = {
      chatScrollRef: { current: null },
      chatEndRef: { current: null },
      chatPinnedRef: { current: true },
      chatScrollTopRef: { current: 0 },
    };
    paneChatRefsRef.current.set(threadId, created);
    return created;
  }, []);
  // Sending or receiving in a thread sticks its transcript to the bottom. Any
  // pane showing that thread follows along, not just the focused one.
  const pinThreadToBottom = useCallback(
    (threadId: string) => {
      paneChatRefs(threadId).chatPinnedRef.current = true;
    },
    [paneChatRefs]
  );
  // Per-thread transcript positions, owned here so they survive ChatTranscript
  // unmounting (Code tab) and are shared by every thread the switcher can reach.
  const chatScrollPositionsRef = useRef(new Map<string, ChatScrollPosition>());
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const utilityModelPickerRef = useRef<HTMLDivElement>(null);
  const taskPickerRef = useRef<HTMLDivElement>(null);
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const codexSettingsRef = useRef<HTMLDivElement>(null);
  const accessModeRef = useRef<HTMLDivElement>(null);
  // Composer controls collapse into one overflow menu when the row runs out of
  // room (narrow split panes); see composerControlsCompact below.
  const composerMenuRef = useRef<HTMLDivElement>(null);
  const composerMenuPopoverRef = useRef<HTMLDivElement>(null);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [composerMenuSection, setComposerMenuSection] = useState<ComposerMenuSection>(null);
  const [composerControlsWidth, setComposerControlsWidth] = useState<number | null>(null);
  const composerControlsObserverRef = useRef<ResizeObserver | null>(null);
  // A callback ref, not useEffect: the composer unmounts and remounts as panes
  // take focus, and the row has to be re-measured each time.
  const composerControlsRef = useCallback((node: HTMLDivElement | null) => {
    composerControlsObserverRef.current?.disconnect();
    composerControlsObserverRef.current = null;
    if (!node) {
      // Unmeasured means "assume there is room", so the full-width composer
      // never flashes the compact menu on mount.
      setComposerControlsWidth(null);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width;
      if (typeof width === 'number') setComposerControlsWidth(width);
    });
    observer.observe(node);
    composerControlsObserverRef.current = observer;
  }, []);

  useEffect(() => () => composerControlsObserverRef.current?.disconnect(), []);

  // Selecting a thread no longer forces the transcript to the bottom — the
  // transcript restores that thread's own position (bottom for never-visited
  // ones). Positions for threads that are gone are dropped so the map tracks
  // the live thread set.
  useEffect(() => {
    const positions = chatScrollPositionsRef.current;
    const paneRefs = paneChatRefsRef.current;
    if (positions.size === 0 && paneRefs.size === 0) return;
    const liveIds = new Set(threads.map((thread) => thread.id));
    for (const threadId of positions.keys()) {
      if (!liveIds.has(threadId)) positions.delete(threadId);
    }
    for (const threadId of paneRefs.keys()) {
      if (!liveIds.has(threadId)) paneRefs.delete(threadId);
    }
  }, [threads]);

  // Everything the main view needs to render one thread. The split view shows
  // up to MAX_THREAD_PANES threads at once, so this has to resolve per thread
  // rather than only for the focused one.
  const threadViewContext = useCallback(
    (thread: Thread | undefined) => {
      const project = thread ? (findProjectById({ projects, noProject }, thread.projectId) ?? null) : null;
      const workspacePending = Boolean(thread && workspaceSetupThreadIds[thread.id]);
      const workspaceRemoving = Boolean(thread && workspaceRemovalThreadIds[thread.id]);
      const workspaceUnavailable = workspacePending || workspaceRemoving;
      // Threads with a Durango workspace work inside it.
      const projectPath = workspaceUnavailable
        ? undefined
        : (thread?.durangoWorkspace?.workingDir ?? project?.path);
      // Candidate dirs for resolving relative media paths in agent markdown: the
      // thread's project dir, plus the grok CLI's per-session dir — Grok Imagine
      // saves generated images there (~/.grok/sessions/<encoded-cwd>/<session-id>/
      // images/N.jpg) and references them relative to it, not to the project.
      const grokSessionId = thread?.agentSessionIds?.grok;
      const mediaBaseDirs = projectPath
        ? grokSessionId
          ? [projectPath, `~/.grok/sessions/${encodeURIComponent(projectPath)}/${grokSessionId}`]
          : [projectPath]
        : [];
      return { project, workspacePending, workspaceRemoving, workspaceUnavailable, projectPath, mediaBaseDirs };
    },
    [noProject, projects, workspaceRemovalThreadIds, workspaceSetupThreadIds]
  );

  const selectedThread = threads.find((t) => t.id === selectedThreadId);
  const selectedThreadContext = threadViewContext(selectedThread);
  // Pinned above the composer (its own and its subagents'). Keyed by content
  // so streaming output doesn't re-render the cards every token.
  const selectedThreadUserActionsNow = selectedThreadId ? pendingUserActions(threads, selectedThreadId) : [];
  const selectedThreadUserActionsKey = JSON.stringify(selectedThreadUserActionsNow);
  const selectedThreadUserActions = useMemo(
    () => selectedThreadUserActionsNow,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedThreadUserActionsKey]
  );
  const selectedThreadProject = selectedThreadContext.project;
  const selectedThreadWorkspacePending = selectedThreadContext.workspacePending;
  const selectedThreadWorkspaceRemoving = selectedThreadContext.workspaceRemoving;
  const selectedThreadWorkspaceUnavailable = selectedThreadContext.workspaceUnavailable;
  const selectedThreadProjectPath = selectedThreadContext.projectPath;
  // threadViewContext returns a fresh array per call; every pane re-derives one
  // on each render, which would defeat ChatTranscript's memo. Hand back the
  // previous array whenever the dirs are unchanged so identity tracks content.
  const mediaBaseDirsCacheRef = useRef(new Map<string, string[]>());
  const stableMediaBaseDirs = useCallback((threadId: string, dirs: string[]) => {
    const cached = mediaBaseDirsCacheRef.current.get(threadId);
    if (cached && cached.length === dirs.length && cached.every((dir, index) => dir === dirs[index])) {
      return cached;
    }
    mediaBaseDirsCacheRef.current.set(threadId, dirs);
    return dirs;
  }, []);
  // Card placement survives switching to Code and back, but each simultaneously
  // mounted transcript owns an independent position, collapse state, and
  // dismissed plan id.
  type TasksCardState = {
    position: { x: number; y: number } | null;
    collapsed: boolean;
    dismissedFor: string | null;
  };
  const [tasksCardStates, setTasksCardStates] = useState<Record<string, TasksCardState>>({});
  const updateTasksCardState = useCallback(
    (threadId: string, update: (current: TasksCardState) => TasksCardState) => {
      setTasksCardStates((states) => {
        const current = states[threadId] ?? {
          position: null,
          collapsed: false,
          dismissedFor: null,
        };
        return { ...states, [threadId]: update(current) };
      });
    },
    []
  );
  const moveTasksCard = useCallback(
    (threadId: string, position: { x: number; y: number }) => {
      updateTasksCardState(threadId, (current) => ({ ...current, position }));
    },
    [updateTasksCardState]
  );
  const toggleTasksCard = useCallback(
    (threadId: string) => {
      updateTasksCardState(threadId, (current) => ({ ...current, collapsed: !current.collapsed }));
    },
    [updateTasksCardState]
  );
  const dismissTasksCard = useCallback(
    (threadId: string, messageId: string) => {
      updateTasksCardState(threadId, (current) => ({ ...current, dismissedFor: messageId }));
    },
    [updateTasksCardState]
  );
  useEffect(() => {
    const liveThreadIds = new Set(threads.map((thread) => thread.id));
    const dropStale = <T,>(states: Record<string, T>) => {
      const staleThreadIds = Object.keys(states).filter((threadId) => !liveThreadIds.has(threadId));
      if (staleThreadIds.length === 0) return states;
      const next = { ...states };
      for (const threadId of staleThreadIds) delete next[threadId];
      return next;
    };
    setTasksCardStates(dropStale);
  }, [threads]);
  // A deleted thread's devices: end its agent-device sessions (the simulators
  // keep running). Main ignores threads that never opened one.
  const deviceThreadIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const liveThreadIds = new Set(threads.map((thread) => thread.id));
    const previous = deviceThreadIdsRef.current;
    deviceThreadIdsRef.current = liveThreadIds;
    if (!previous) return;
    for (const threadId of previous) {
      if (!liveThreadIds.has(threadId)) void window.orion?.closeThreadDevices?.(threadId);
    }
  }, [threads]);
  const selectedProject =
    findProjectById({ projects, noProject }, selectedProjectId) ?? selectedThreadProject ?? null;
  const latestThreadProjectId = useMemo(() => {
    let latestProjectId: string | null = null;
    let latestCreatedAt = -Infinity;
    for (const thread of threads) {
      const createdAt = new Date(thread.createdAt).getTime();
      if (createdAt > latestCreatedAt) {
        latestCreatedAt = createdAt;
        latestProjectId = thread.projectId;
      }
    }
    return latestProjectId;
  }, [threads]);
  // May be the No project pseudo-project (the user's current choice, or the
  // only option before any project is added).
  const defaultNewThreadProject =
    selectedProject ??
    findProjectById({ projects, noProject }, latestThreadProjectId) ??
    projects[0] ??
    noProject ??
    null;
  // Unsent composer drafts are kept per thread so switching threads swaps the
  // draft instead of carrying it along, and a fresh thread starts with an
  // empty composer. Non-empty ones are also saved with the store
  // (composerDrafts), so they survive a restart. The draft lives in this
  // controller, not in App state: typing re-renders only the Composer, and
  // the store gets the draft debounced (flushed on switch, send, blur, hide
  // and unload) instead of on every keystroke.
  const composerDraftKey = selectedThreadId ?? null;
  // Empty threads whose composer has been typed into (or given an attachment)
  // this session, or that came back from the last one with a saved draft.
  // Sidebar v2 lists a blank draft only once it is in here, so the fresh
  // composer opened after a snooze or settle stays out of the list.
  const [typedDraftThreadIds, setTypedDraftThreadIds] = useState<ReadonlySet<string>>(() => new Set());
  const [composerDraft] = useState(() =>
    createComposerDraftController({
      load: (threadId) => useOrionStore.getState().composerDrafts[threadId],
      save: (threadId, draft) => {
        const state = useOrionStore.getState();
        // A debounced save landing after its thread was deleted must not
        // bring the draft back as an orphan.
        if (!(threadId in state.composerDrafts) && !state.threads.some((thread) => thread.id === threadId)) return;
        state.setComposerDraft(threadId, draft);
      },
      // Once per thread per session, not per keystroke.
      onDraftTyped: (threadId) =>
        setTypedDraftThreadIds((prev) => (prev.has(threadId) ? prev : new Set(prev).add(threadId))),
    })
  );
  const hasComposerDraft = (threadId: string) => composerDraft.hasThreadDraft(threadId);
  // Mid-run, a non-empty draft adds the queue/steer buttons, which the
  // controls row's width estimate counts. A boolean that is only read while a
  // run is active: typing re-renders App at most when the draft turns
  // empty/non-empty during a run, and clearing it on send never does.
  const composerHasDraft = useSyncExternalStore(
    composerDraft.subscribe,
    () => isSending && composerDraft.hasActiveContent()
  );
  // Swap drafts in the same commit that selects the thread, so the composer
  // never shows the previous thread's draft for a frame. Starts from no key,
  // so the first selected thread's saved draft is restored, not overwritten.
  useLayoutEffect(() => {
    composerDraft.switchTo(composerDraftKey);
  }, [composerDraft, composerDraftKey]);
  // Pending drafts reach the store before the window can go away: on unload
  // (ahead of the store's synchronous write), on blur and when hidden.
  useEffect(() => {
    const flush = () => composerDraft.flush();
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') composerDraft.flush();
    };
    const stopUnloadFlush = flushIntoStoreBeforeUnload(flush);
    window.addEventListener('blur', flush);
    document.addEventListener('visibilitychange', flushWhenHidden);
    return () => {
      stopUnloadFlush();
      window.removeEventListener('blur', flush);
      document.removeEventListener('visibilitychange', flushWhenHidden);
      composerDraft.flush();
    };
  }, [composerDraft]);

  // The spawn-request listener mounts once; it reads the live model catalog
  // through this ref instead of a stale closure.
  useEffect(() => {
    agentModelsRef.current = agentModels;
  }, [agentModels]);

  const canChangeSelectedThreadProject =
    !!selectedThread &&
    !selectedThread.durangoWorkspace &&
    !selectedThreadWorkspacePending &&
    selectedThread.summary.messageCount === 0 &&
    selectedThread.status === 'idle' &&
    !isSending;

  const shellTitle =
    activeTab === 'agents'
      ? (selectedThread?.title ?? 'New thread')
      : activeFilePath
        ? (activeFilePath.split(/[\\/]/).pop() ?? 'Code')
        : 'Code';
  const shellSubtitle =
    activeTab === 'agents'
      ? undefined
      : workspacePath
        ? (workspacePath.split(/[\\/]/).pop() ?? workspacePath)
        : undefined;
  const selectedAgentModel = findAgentModel(agentModels, selectedThread?.modelId ?? defaultAgentModelId);
  // Claude Code CLI threads host the interactive `claude` TUI in an embedded
  // terminal; the composer feeds the PTY instead of dispatching agent turns.
  const isTerminalThread = selectedAgentModel?.id === claudeCodeCliModelId;
  // MCP servers connected to Orion (Settings → Skills & MCPs): the composer's
  // @-mention list and the per-turn attachment resolution read this copy.
  const [orionMcps, setOrionMcps] = useState<OrionMcpEntry[]>([]);
  const orionMcpsRef = useRef<OrionMcpEntry[]>([]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await window.orion?.listOrionMcps?.();
        if (active && result?.ok) {
          orionMcpsRef.current = result.servers;
          setOrionMcps(result.servers);
        }
      } catch {
        // Keep the last known list; the composer simply offers fewer mentions.
      }
    };
    void load();
    window.addEventListener(ORION_MCPS_CHANGED_EVENT, load);
    window.addEventListener('focus', load);
    return () => {
      active = false;
      window.removeEventListener(ORION_MCPS_CHANGED_EVENT, load);
      window.removeEventListener('focus', load);
    };
  }, []);
  const attachedOrionMcps = useMemo(() => {
    const ids = selectedThread?.mcpServerIds ?? [];
    return orionMcps.filter((server) => ids.includes(server.id));
  }, [orionMcps, selectedThread?.mcpServerIds]);
  // Provider-native subagent transcripts are read-only mirrors of a CLI's
  // internal agent — there is no session of their own to talk to. Steering
  // happens from the parent thread.
  const isNativeSubagentThread = Boolean(selectedThread?.subagent);
  const selectedCodexReasoningOptions = codexReasoningOptionsForModel(selectedAgentModel);
  const selectedCodexReasoning = getEffectiveCodexReasoningEffort(
    selectedAgentModel,
    selectedThread?.codexReasoningEffort
  );
  const selectedCodexServiceTier = selectedThread?.codexServiceTier ?? defaultCodexServiceTier;
  const selectedCodexReasoningLabel =
    selectedCodexReasoningOptions.find((option) => option.value === selectedCodexReasoning)?.label ?? 'Medium';
  const selectedCodexServiceTierLabel =
    codexServiceTierOptions.find((option) => option.value === selectedCodexServiceTier)?.label ?? 'Standard';
  const selectedClaudeReasoningOptions = claudeReasoningOptionsForModel(selectedAgentModel);
  const selectedClaudeReasoning = getEffectiveClaudeReasoningEffort(
    selectedAgentModel,
    selectedThread?.claudeReasoningEffort
  );
  const selectedClaudeContextWindow = selectedThread?.claudeContextWindow ?? defaultClaudeContextWindow;
  const effectiveClaudeContextWindow = getEffectiveClaudeContextWindow(selectedAgentModel, selectedClaudeContextWindow);
  const selectedClaudeReasoningLabel =
    selectedClaudeReasoningOptions.find((option) => option.value === selectedClaudeReasoning)?.label ?? 'High';
  const selectedClaudeContextWindowLabel =
    claudeContextWindowOptions.find((option) => option.value === effectiveClaudeContextWindow)?.label ?? '200k';
  const selectedGrokReasoningOptions = grokReasoningOptionsForModel(selectedAgentModel);
  const selectedGrokReasoning = getEffectiveGrokReasoningEffort(
    selectedAgentModel,
    selectedThread?.grokReasoningEffort
  );
  const selectedGrokReasoningLabel =
    selectedGrokReasoningOptions.find((option) => option.value === selectedGrokReasoning)?.label ?? 'High';
  const selectedMuseReasoningOptions = museReasoningOptionsForModel(selectedAgentModel);
  const selectedMuseReasoning = getEffectiveMuseReasoningEffort(
    selectedAgentModel,
    selectedThread?.museReasoningEffort
  );
  const selectedMuseReasoningLabel =
    selectedMuseReasoningOptions.find((option) => option.value === selectedMuseReasoning)?.label ?? 'High';
  const selectedOpenCodeReasoningOptions = openCodeReasoningOptionsForModel(selectedAgentModel);
  const selectedOpenCodeReasoning = getEffectiveOpenCodeReasoningEffort(
    selectedAgentModel,
    selectedThread?.openCodeReasoningEffort
  );
  const selectedOpenCodeReasoningLabel =
    selectedOpenCodeReasoningOptions.find((option) => option.value === selectedOpenCodeReasoning)?.label ??
    'Default';
  const selectedAccessMode = selectedThread?.accessMode ?? 'full-access';
  const selectedAccessModeLabel =
    accessModeOptions.find((option) => option.value === selectedAccessMode)?.label ?? 'Full access';
  const shouldShowAgentSettings =
    !isTerminalThread &&
    (selectedAgentModel?.providerId === 'codex' ||
      selectedAgentModel?.providerId === 'claude' ||
      selectedAgentModel?.providerId === 'grok' ||
      selectedAgentModel?.providerId === 'muse' ||
      (selectedAgentModel?.providerId === 'opencode' && selectedOpenCodeReasoningOptions.length > 1));
  const normalizedProviderSettings = useMemo(
    () => ({
      ...defaultProviderSettings,
      ...providerSettings,
    }),
    [providerSettings]
  );
  // Persisted stores from before orchestration shipped may lack the field, so
  // merge over the defaults before reading any role model.
  const normalizedOrchestrationSettings = useMemo(
    () => ({
      ...defaultOrchestrationSettings,
      ...orchestrationSettings,
      models: {
        ...defaultOrchestrationSettings.models,
        ...orchestrationSettings?.models,
      },
    }),
    [orchestrationSettings]
  );
  const threadReaderModel = useMemo(() => {
    if (selectedAgentModel?.providerId !== 'orion') return selectedAgentModel;
    return resolveOrionMainDriverModel(
      agentModels,
      normalizedOrchestrationSettings.models.mainDriver,
      defaultAgentModelId,
      claudeCodeCliModelId
    );
  }, [agentModels, normalizedOrchestrationSettings.models.mainDriver, selectedAgentModel]);
  const threadReaderProviderId = isTerminalThread ? null : (threadReaderModel?.providerId ?? null);
  useEffect(() => {
    let active = true;
    if (!threadReaderProviderId || !window.orion?.supportsThreadReader) {
      setThreadReaderSupport(null);
      return () => {
        active = false;
      };
    }
    void window.orion.supportsThreadReader(threadReaderProviderId).then(
      (supported) => {
        if (active) setThreadReaderSupport({ providerId: threadReaderProviderId, supported });
      },
      () => {
        if (active) setThreadReaderSupport({ providerId: threadReaderProviderId, supported: false });
      }
    );
    return () => {
      active = false;
    };
  }, [threadReaderProviderId]);
  const canReferenceThreads = hasThreadReaderSupport(threadReaderProviderId, threadReaderSupport);
  const enabledProviderIds = useMemo(
    () =>
      agentProviders
        .map((provider) => provider.id)
        // 'orion' has no providerSettings entry (it's a pseudo-provider, not a
        // CLI); it is always enabled.
        .filter((id) => id === 'orion' || normalizedProviderSettings[id as ProviderId]?.enabled !== false),
    [normalizedProviderSettings]
  );
  const enabledProviderIdSet = useMemo(() => new Set(enabledProviderIds), [enabledProviderIds]);
  const visibleAgentModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return agentModels.filter((model) => {
      // Claude Code CLI lives as a dedicated overlay button on the Claude tab,
      // not as a row in the model list.
      if (model.id === claudeCodeCliModelId) return false;
      const providerMatches = model.providerId === activeProviderTab;
      const providerEnabled = enabledProviderIdSet.has(model.providerId);
      const queryMatches =
        !query ||
        model.label.toLowerCase().includes(query) ||
        model.providerLabel.toLowerCase().includes(query) ||
        model.slug.toLowerCase().includes(query);
      return providerEnabled && providerMatches && queryMatches;
    });
  }, [activeProviderTab, agentModels, enabledProviderIdSet, modelSearch]);
  const claudeCodeCliModel = useMemo(
    () => agentModels.find((model) => model.id === claudeCodeCliModelId),
    [agentModels]
  );
  // Whether the selected thread resolves to a Claude SDK session — directly
  // (claude provider) or via an Orion orchestrator whose main driver is
  // Claude. Gates the slash-command menu, /btw hint, and /clear dispatch.
  const selectedThreadClaudeBacked =
    selectedAgentModel?.providerId === 'claude' ||
    ((selectedAgentModel?.providerId === 'orion' || isOrionModelId(selectedThread?.modelId ?? '')) &&
      findAgentModel(agentModels, normalizedOrchestrationSettings.models.mainDriver)?.providerId ===
        'claude');
  // The selected project's live Claude command list for the Composer's
  // slash menu (null until reported; the menu falls back to a static list).
  const selectedThreadSlashCommands = selectedThreadProjectPath
    ? (slashCommandsByProject[selectedThreadProjectPath] ?? null)
    : null;
  // Role-model options for Settings → Orchestration: every real model grouped
  // by provider. The Orion pseudo-model can't delegate to itself.
  const orchestrationModelGroups = useMemo(
    () =>
      agentProviders
        .filter((provider) => provider.id !== 'orion')
        .map((provider) => ({
          provider,
          models: agentModels.filter((model) => model.providerId === provider.id && model.id !== claudeCodeCliModelId),
        }))
        .filter((group) => group.models.length > 0),
    [agentModels]
  );
  const availableProviderUpdates = useMemo(
    () => providerUpdateState?.providers.filter((provider) => provider.updateAvailable) ?? [],
    [providerUpdateState]
  );
  const providerUpdateSummary =
    availableProviderUpdates.length === 1
      ? `${availableProviderUpdates[0].label} update available`
      : `${availableProviderUpdates.length} CLI updates available`;
  const providerUpdateTooltip = useMemo(
    () =>
      availableProviderUpdates
        .map((provider) => {
          const versionLabel =
            provider.currentVersion && provider.latestVersion
              ? `${provider.currentVersion} -> ${provider.latestVersion}`
              : 'update available';
          return `${provider.label}: ${versionLabel}`;
        })
        .join('\n'),
    [availableProviderUpdates]
  );
  const providerStatusById = useMemo(
    () => new Map((providerUpdateState?.providers ?? []).map((provider) => [provider.id, provider])),
    [providerUpdateState]
  );
  const appUpdateVisible =
    !!appUpdateState &&
    ['available', 'downloading', 'downloaded', 'restarting', 'error'].includes(appUpdateState.status);
  const appUpdatePercent = Math.max(0, Math.min(100, Math.round(appUpdateState?.progress?.percent ?? 0)));
  const appUpdateLabel =
    appUpdateState?.status === 'restarting'
      ? 'Restarting…'
      : appUpdateState?.status === 'downloaded'
        ? 'Restart to update'
        : appUpdateState?.status === 'downloading'
          ? `Downloading ${appUpdatePercent}%`
          : appUpdateState?.status === 'error'
            ? 'Update failed'
            : appUpdateState?.availableVersion
              ? `Update ${appUpdateState.availableVersion}`
              : 'Update available';
  const appUpdateTitle =
    appUpdateState?.status === 'error'
      ? (appUpdateState.error ?? 'Update failed')
      : appUpdateState?.status === 'restarting'
        ? 'Finishing the update, then reopening Durango Code'
        : appUpdateState?.availableVersion
          ? `Durango Code ${appUpdateState.availableVersion} is available`
          : appUpdateLabel;
  const accountName = accountState.user?.name || (accountState.authenticated ? 'Durango account' : 'Not signed in');
  const accountEmail = accountState.user?.email ?? null;
  const accountIdentity = accountState.user ? `${accountState.user.id}\n${accountEmail ?? ''}` : null;
  const accountEmailRevealed = accountIdentity !== null && revealedAccountIdentity === accountIdentity;
  const accountInitials = (accountState.user?.name || accountState.user?.email || 'D')
    .split(/\s+|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  // Order projects by their most recently active thread (same activity signal
  // as the Recent agents list) so current work stays at the top. Projects with
  // no threads sort last, keeping their insertion order. Merely selecting a
  // project does not reorder the sidebar.
  const sortedProjects = useMemo(() => {
    const lastActivityByProject = new Map<string, number>();
    for (const thread of threads) {
      const ts = getThreadActivityTime(thread).getTime();
      const prev = lastActivityByProject.get(thread.projectId) ?? -Infinity;
      if (ts > prev) lastActivityByProject.set(thread.projectId, ts);
    }
    return [...projects].sort(
      (a, b) => (lastActivityByProject.get(b.id) ?? -Infinity) - (lastActivityByProject.get(a.id) ?? -Infinity)
    );
  }, [projects, threads]);

  // The Recent agents section spans every project, so its "new thread" button
  // has no project of its own: it targets the project the last thread ran in.
  // sortedProjects is already ordered by most recent thread activity, so that
  // is simply the topmost project in the sidebar.
  const recentAgentsTargetProject = sortedProjects[0] ?? null;

  // Subagent threads live in the in-thread subagents bar, not the sidebar.
  // A thread counts as a child only while its parent still exists — orphans
  // render as top-level.
  const childThreadIds = useMemo(() => {
    const threadIds = new Set(threads.map((t) => t.id));
    const ids = new Set<string>();
    for (const thread of threads) {
      if (thread.parentThreadId && threadIds.has(thread.parentThreadId)) ids.add(thread.id);
    }
    return ids;
  }, [threads]);

  const pinnedThreads = useMemo(
    () =>
      threads
        .filter((t) => t.pinnedAt && !childThreadIds.has(t.id))
        .sort((a, b) => new Date(b.pinnedAt ?? 0).getTime() - new Date(a.pinnedAt ?? 0).getTime()),
    [childThreadIds, threads]
  );

  const recentThreads = useMemo(
    () =>
      threads
        // Children never appear top-level; they nest under their parent's row.
        // Pinned threads live in the Pinned section instead.
        .filter((t) => !t.hiddenFromRecent && !t.pinnedAt && !childThreadIds.has(t.id))
        .sort(compareRecentThreadOrder),
    [childThreadIds, threads]
  );

  const pinThread = useCallback(
    (threadId: string) => updateThread(threadId, { pinnedAt: new Date().toISOString() }),
    [updateThread]
  );
  // Unpinning surfaces the thread at the top of Recent agents (see the
  // recentThreads sort) so an accidental unpin of an old thread is easy to
  // recover instead of sinking back to its chronological spot.
  const unpinThread = useCallback(
    (threadId: string) =>
      updateThread(threadId, {
        pinnedAt: undefined,
        unpinnedAt: new Date().toISOString(),
        hiddenFromRecent: false,
      }),
    [updateThread]
  );

  const runningAgentCount = useMemo(() => threads.filter((t) => t.status === 'running').length, [threads]);

  // Sidebar v2 (Settings → Experimental): flat Pinned / Recent / Snoozed /
  // Settled lists, and the threads waiting on a question or approval.
  // Settings → Cosmetics → Text size zooms the whole window.
  const uiScale = useOrionStore((state) => state.appearanceSettings?.uiScale ?? defaultAppearanceSettings.uiScale);
  useEffect(() => {
    window.orion?.setZoomFactor?.(uiScale);
  }, [uiScale]);
  const sidebarV2Enabled = sidebarV2Settings?.enabled ?? defaultSidebarV2Settings.enabled;
  const sidebarV2Settled = !!sidebarV2Settings?.settledExistingAt;
  const sidebarV2Views = sidebarV2Settings?.views ?? defaultSidebarV2Settings.views;
  const runningThreadIds = useStableIdList(
    threads.filter((thread) => thread.status === 'running').map((thread) => thread.id)
  );
  // A question or approval wakes a snoozed thread (its run ending does so in
  // the store's updateThread).
  const wakeThreadForAttention = useCallback(
    (threadId: string) => {
      const state = useOrionStore.getState();
      const thread = state.threads.find((candidate) => candidate.id === threadId);
      if (!thread?.snoozedAt) return;
      const onScreen = isAgentsPanelVisible(state) && state.paneThreadIds.includes(threadId);
      updateThread(threadId, {
        snoozedAt: undefined,
        ...(onScreen ? {} : { wokeAt: new Date().toISOString(), wokeReason: 'attention' as const }),
      });
    },
    [updateThread]
  );
  const threadsNeedingInput = useThreadsNeedingInput(sidebarV2Enabled, runningThreadIds, wakeThreadForAttention);
  // Threads with an action pending on the user (request_user_action) need
  // them too, running or not, until the action is resolved. Keyed by content
  // so streaming output doesn't hand the sidebar a new map every token.
  const awaitingUserAction = threadsAwaitingUserAction(threads);
  const awaitingUserActionKey = [...awaitingUserAction].map(([id, since]) => `${id}:${since}`).join(',');
  // Threads on another machine whose agent waits there on a question, on
  // the row the sidebar shows for them (a parent here, for one an agent of
  // it started there).
  const remoteNeedingInput = new Map<string, number>();
  for (const thread of threads) {
    const since = thread.remote?.needsInputSince;
    if (!since) continue;
    const rootId = sidebarRootThread(threads, thread).id;
    remoteNeedingInput.set(rootId, Math.max(remoteNeedingInput.get(rootId) ?? 0, Date.parse(since) || 0));
  }
  const remoteNeedingInputKey = [...remoteNeedingInput].map(([id, since]) => `${id}:${since}`).join(',');
  const attentionThreadIds = useMemo(
    () => mergeAttentionSince(threadsNeedingInput, awaitingUserAction, remoteNeedingInput),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadsNeedingInput, awaitingUserActionKey, remoteNeedingInputKey]
  );
  // Done, Reply, or a `check` seeing it done: clears the action and tells the
  // agent that asked without interrupting it (agent:notifyTurn): at its next
  // tool call while it works, or in a turn of its own once it is idle. Only
  // when no live run or session takes it does it go as an ordinary message,
  // queued behind the running turn or sent at once.
  const answerUserAction = useCallback(
    (
      threadId: string,
      actionId: string,
      answer: { reply?: string; attachments?: FileAttachment[]; detected?: boolean } = {}
    ) => {
      const threads = useOrionStore.getState().threads;
      const thread = threads.find((candidate) => candidate.id === threadId);
      const done = thread?.userActions?.find((action) => action.id === actionId);
      const remaining = (thread?.userActions ?? []).filter((action) => action.id !== actionId);
      updateThread(threadId, { userActions: remaining.length ? remaining : undefined });
      if (!thread || !done) return;
      // A provider-native subagent's transcript is read-only; its driver
      // thread is the one that can take the message.
      let target: Thread | undefined = thread;
      while (target?.subagent) {
        const parentId: string | undefined = target.parentThreadId;
        target = parentId ? threads.find((candidate) => candidate.id === parentId) : undefined;
      }
      if (!target) return;
      const targetId = target.id;
      const providerId = findAgentModel(agentModels, target.modelId ?? defaultAgentModelId)?.providerId;
      settleWaitingOnUserCaptions(threadId);
      const { reply, detected } = answer;
      const attachments = reply !== undefined ? (answer.attachments ?? []) : [];
      // A reply may be only files (a screenshot of where the user is stuck).
      const replyText = reply !== undefined ? [`Not done: ${done.action}`, reply].filter(Boolean).join('\n\n') : '';
      // Files go to the running agent as paths it can read (every provider's
      // notify path is text); a queued fallback carries them as attachments.
      const text =
        reply !== undefined
          ? buildPromptWithAttachments(replyText, attachments)
          : detected && done.check
            ? `Done: ${done.action}\n\n(Durango Code saw \`${done.check}\` succeed.)`
            : `Done: ${done.action}`;
      const notice =
        reply !== undefined
          ? {
              title: 'You replied instead of marking it done',
              detail: buildPromptWithAttachments([done.action, reply].filter(Boolean).join('\n\n'), attachments),
            }
          : detected && done.check
            ? { title: `Done: \`${done.check}\` succeeded`, detail: done.action }
            : { title: 'You marked it done', detail: done.action };
      // In order with steers, and cancelled with them by Stop: a fallback
      // queued after Stop would start the stopped agent again.
      void steeringCoordinatorRef.current.enqueue(targetId, async (cancelled) => {
        let accepted = false;
        try {
          accepted =
            (await window.orion?.notifyAgentTurn?.({
              threadId: targetId,
              runId: activeRunsByThreadRef.current[targetId],
              providerId,
              text,
              notice,
            })) === true;
        } catch {
          accepted = false;
        }
        if (accepted || cancelled()) return;
        pinThreadToBottom(targetId);
        queueMessageToThread(
          targetId,
          attachments.length > 0 ? { text: replyText, attachments } : { text }
        );
      });
    },
    [agentModels, pinThreadToBottom, queueMessageToThread, updateThread]
  );
  const answerUserActionRef = useRef(answerUserAction);
  useLayoutEffect(() => {
    answerUserActionRef.current = answerUserAction;
  });
  const markUserActionDone = useCallback(
    (threadId: string, actionId: string) => answerUserAction(threadId, actionId),
    [answerUserAction]
  );
  const replyToUserAction = useCallback(
    (threadId: string, actionId: string, reply: string, attachments: FileAttachment[]) =>
      answerUserAction(threadId, actionId, { reply, attachments }),
    [answerUserAction]
  );
  // The X on a card: the action is redundant (already done, superseded, or
  // asked twice), so it goes away without telling the agent anything.
  const dismissUserAction = useCallback(
    (threadId: string, actionId: string) => {
      const thread = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
      const current = thread?.userActions ?? [];
      const remaining = current.filter((action) => action.id !== actionId);
      if (remaining.length === current.length) return;
      updateThread(threadId, { userActions: remaining.length ? remaining : undefined });
      if (remaining.length === 0) settleWaitingOnUserCaptions(threadId);
    },
    [updateThread]
  );
  const setUserActionWatching = useCallback(
    (threadId: string, actionId: string, watching: boolean) => {
      const thread = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
      if (!thread?.userActions?.some((action) => action.id === actionId)) return;
      updateThread(threadId, {
        userActions: thread.userActions.map((action) => (action.id === actionId ? { ...action, watching } : action)),
      });
    },
    [updateThread]
  );

  const remoteThreadSyncRef = useRef<RemoteThreadSync | null>(null);
  // The action cards of a thread on another machine act there: the agent that
  // asked runs there, and so does its `check`. The card updates here at once;
  // the mirror brings that machine's state back after.
  const sendRemoteUserAction = useCallback(
    (
      threadId: string,
      actionId: string,
      op: 'done' | 'reply' | 'dismiss' | 'watch',
      extra: { reply?: string; attachments?: FileAttachment[]; watching?: boolean } = {}
    ) => {
      const thread = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
      const remote = thread?.remote;
      if (!thread || !remote?.threadId) return;
      const before = thread.userActions;
      if (op === 'watch') {
        updateThread(threadId, {
          userActions: (thread.userActions ?? []).map((action) =>
            action.id === actionId ? { ...action, watching: extra.watching === true } : action
          ),
        });
      } else {
        const remaining = (thread.userActions ?? []).filter((action) => action.id !== actionId);
        updateThread(threadId, { userActions: remaining.length ? remaining : undefined });
      }
      void window.orion
        ?.remoteUserAction?.({ machineId: remote.machineId, threadId: remote.threadId, actionId, op, ...extra })
        .then((result) => result?.ok === true ? null : (result?.error ?? `Could not reach ${remote.machineName}.`))
        .catch(() => `Could not reach ${remote.machineName}.`)
        .then((error) => {
          if (!error) {
            remoteThreadSyncRef.current?.refreshSoon(threadId);
            return;
          }
          // It didn't go through: the card comes back as it was, and the
          // thread is read whole from that machine when it can be.
          updateThread(threadId, { userActions: before });
          toast.error(op === 'reply' ? `Your reply wasn't sent: ${error}` : error);
          remoteThreadSyncRef.current?.refreshSoon(threadId, { force: true });
        });
    },
    [updateThread]
  );
  const isRemoteThread = (threadId: string) =>
    Boolean(useOrionStore.getState().threads.find((candidate) => candidate.id === threadId)?.remote?.threadId);
  const onUserActionDone = useCallback(
    (threadId: string, actionId: string) =>
      isRemoteThread(threadId) ? sendRemoteUserAction(threadId, actionId, 'done') : markUserActionDone(threadId, actionId),
    [markUserActionDone, sendRemoteUserAction]
  );
  const onUserActionReply = useCallback(
    (threadId: string, actionId: string, reply: string, attachments: FileAttachment[]) =>
      isRemoteThread(threadId)
        ? sendRemoteUserAction(threadId, actionId, 'reply', { reply, attachments })
        : replyToUserAction(threadId, actionId, reply, attachments),
    [replyToUserAction, sendRemoteUserAction]
  );
  const onUserActionDismiss = useCallback(
    (threadId: string, actionId: string) =>
      isRemoteThread(threadId) ? sendRemoteUserAction(threadId, actionId, 'dismiss') : dismissUserAction(threadId, actionId),
    [dismissUserAction, sendRemoteUserAction]
  );
  const onUserActionWatch = useCallback(
    (threadId: string, actionId: string, watching: boolean) =>
      isRemoteThread(threadId)
        ? sendRemoteUserAction(threadId, actionId, 'watch', { watching })
        : setUserActionWatching(threadId, actionId, watching),
    [sendRemoteUserAction, setUserActionWatching]
  );
  // request_user_action / resolve_user_action from any run. Asking pins the
  // action on the thread and, like a question, brings the thread the sidebar
  // lists (a subagent's driver) back from Snoozed or Settled.
  useEffect(() => {
    if (!window.orion?.onUserAction) return undefined;
    return window.orion.onUserAction((request) => {
      const state = useOrionStore.getState();
      const thread = state.threads.find((candidate) => candidate.id === request.threadId);
      if (!thread) return;
      const current = thread.userActions ?? [];
      if (request.type === 'detected') {
        // A check that finished just as the user stopped watching it.
        if (!current.some((action) => action.id === request.id && action.watching)) return;
        answerUserActionRef.current(thread.id, request.id, { detected: true });
        return;
      }
      if (request.type === 'watch-stopped') {
        setUserActionWatching(thread.id, request.id, false);
        return;
      }
      if (request.type === 'undelivered') {
        // The agent's session ended before it saw these answers.
        for (const text of request.texts) queueMessageToThread(thread.id, { text });
        return;
      }
      if (request.type === 'resolve') {
        // resolve_user_action never clears a secret card: its request is still
        // waiting in the main process, which sends its own resolve (with its
        // id) when it ends.
        const remaining = current.filter((action) =>
          request.id ? action.id !== request.id || (action.secret && request.source !== 'secret') : Boolean(action.secret)
        );
        if (remaining.length !== current.length) {
          updateThread(thread.id, { userActions: remaining.length ? remaining : undefined });
          if (remaining.length === 0) settleWaitingOnUserCaptions(thread.id);
        }
        return;
      }
      const now = new Date().toISOString();
      updateThread(thread.id, {
        userActions: [
          ...current.filter((action) => action.id !== request.id),
          {
            id: request.id,
            action: request.action,
            ...(request.url ? { url: request.url } : {}),
            requestedAt: now,
            ...(request.check
              ? { check: request.check, checkCwd: request.cwd, watching: request.autoWatch === true }
              : {}),
            ...(request.secret ? { secret: request.secret } : {}),
          },
        ],
      });
      const root = sidebarRootThread(state.threads, thread);
      if (!root.snoozedAt && !root.settledAt) return;
      const onScreen = isAgentsPanelVisible(state) && state.paneThreadIds.includes(root.id);
      updateThread(root.id, {
        snoozedAt: undefined,
        settledAt: undefined,
        ...(onScreen ? {} : { wokeAt: now, wokeReason: 'attention' as const }),
      });
    });
  }, [queueMessageToThread, setUserActionWatching, updateThread]);
  // A secret card's answer (request_secret) goes straight to the main
  // process, which saves the value to a file and ends the agent's wait; its
  // `resolve` then clears the card. A request that already ended (the run
  // stopped) loses its card here.
  const answerSecretRequest = useCallback(
    async (
      threadId: string,
      actionId: string,
      answer: { type: 'save'; value: string } | { type: 'decline' }
    ): Promise<string | undefined> => {
      const result = await window.orion?.answerSecretRequest?.({ threadId, id: actionId, answer });
      if (result?.ok) return undefined;
      if (!result || result.ended) dismissUserAction(threadId, actionId);
      return result?.error ?? 'Durango Code could not take the answer.';
    },
    [dismissUserAction]
  );
  // A secret card of a thread on another machine is answered there: the value
  // goes to that machine (end-to-end encrypted), whose agent asked for it, and
  // is never written here.
  const onSecretAnswer = useCallback(
    async (
      threadId: string,
      actionId: string,
      answer: { type: 'save'; value: string } | { type: 'decline' }
    ): Promise<string | undefined> => {
      const remote = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId)?.remote;
      if (!remote?.threadId) return answerSecretRequest(threadId, actionId, answer);
      const result = await window.orion
        ?.remoteUserAction?.({ machineId: remote.machineId, threadId: remote.threadId, actionId, op: 'secret', secretAnswer: answer })
        .catch(() => null);
      remoteThreadSyncRef.current?.refreshSoon(threadId, { force: !result?.ok });
      return result?.ok ? undefined : (result?.error ?? `Could not reach ${remote.machineName}.`);
    },
    [answerSecretRequest]
  );
  // Secret cards saved with the thread outlive the request after a restart
  // (or a window reload during which it ended): once the saved threads have
  // loaded, drop the cards the main process no longer waits on. Cards asked
  // for after the check started stay.
  useEffect(() => {
    let cancelled = false;
    const reconcile = () => {
      const startedAt = Date.now();
      void window.orion?.listSecretRequests?.().then((pending) => {
        if (cancelled) return;
        const live = new Set(pending.map((entry) => entry.id));
        for (const thread of useOrionStore.getState().threads) {
          // Another machine's secret cards are pending there, not here.
          if (thread.remote) continue;
          for (const action of thread.userActions ?? []) {
            if (!action.secret || live.has(action.id)) continue;
            if ((Date.parse(action.requestedAt) || 0) >= startedAt) continue;
            dismissUserAction(thread.id, action.id);
          }
        }
      });
    };
    const unsubscribe = useOrionStore.persist.hasHydrated()
      ? (reconcile(), () => {})
      : useOrionStore.persist.onFinishHydration(reconcile);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [dismissUserAction]);
  // Keep the main process watching exactly the actions whose `check` is on
  // (it holds only timers, so this also re-arms them after a restart), and
  // stop the watch once an action is answered, resolved or deleted.
  // Not for threads on another machine: their checks run there.
  const watchedUserActionsKey = threads
    .filter((thread) => !thread.remote)
    .flatMap((thread) =>
      (thread.userActions ?? [])
        .filter((action) => action.check && action.watching)
        .map((action) => `${thread.id}:${action.id}`)
    )
    .join(',');
  const watchedUserActionsRef = useRef(new Map<string, { threadId: string; id: string }>());
  useEffect(() => {
    const watched = watchedUserActionsRef.current;
    const wanted = new Map<string, { threadId: string; id: string; check: string; cwd?: string }>();
    for (const thread of useOrionStore.getState().threads) {
      if (thread.remote) continue;
      for (const action of thread.userActions ?? []) {
        if (!action.check || !action.watching) continue;
        wanted.set(`${thread.id}:${action.id}`, { threadId: thread.id, id: action.id, check: action.check, cwd: action.checkCwd });
      }
    }
    for (const [key, entry] of watched) {
      if (wanted.has(key)) continue;
      watched.delete(key);
      void window.orion?.unwatchUserAction?.({ threadId: entry.threadId, id: entry.id });
    }
    for (const [key, entry] of wanted) {
      if (watched.has(key)) continue;
      watched.set(key, { threadId: entry.threadId, id: entry.id });
      void window.orion?.watchUserAction?.(entry);
    }
  }, [watchedUserActionsKey]);
  // A blank draft (nothing sent, nothing typed) is just the composer the
  // Agents panel opens with nothing else to show; it joins the list once used.
  // CLI threads keep their conversation in the terminal, so they always show.
  // Until the first-switch settle runs (once every thread has loaded), the
  // lists show the threads from before this launch as it will leave them, so
  // the history never flashes into Recent on the launch that turns sidebar v2
  // on.
  const sidebarV2Lists = useMemo(
    () =>
      sidebarV2ThreadLists(
        sidebarV2Enabled
          ? (sidebarV2Settled
              ? threads
              : threads.map((thread) =>
                  Date.parse(thread.createdAt) < APP_LAUNCHED_AT
                    ? settleThreadsForSidebarV2([thread], new Date(APP_LAUNCHED_AT).toISOString())[0]
                    : thread
                )
            ).filter(
              (thread) =>
                thread.summary.messageCount > 0 ||
                thread.status === 'running' ||
                thread.modelId === claudeCodeCliModelId ||
                !!thread.pinnedAt ||
                !!thread.snoozedAt ||
                !!thread.settledAt ||
                typedDraftThreadIds.has(thread.id)
            )
          : [],
        (thread) => childThreadIds.has(thread.id),
        compareSidebarV2Recent(attentionThreadIds)
      ),
    [attentionThreadIds, childThreadIds, sidebarV2Enabled, sidebarV2Settled, threads, typedDraftThreadIds]
  );
  const setSidebarV2ViewVisible = useCallback(
    (view: keyof SidebarV2Settings['views'], visible: boolean) =>
      setSidebarV2Settings({ views: { ...useOrionStore.getState().sidebarV2Settings.views, [view]: visible } }),
    [setSidebarV2Settings]
  );
  const snoozeThread = useCallback(
    (threadId: string) =>
      updateThread(threadId, { snoozedAt: new Date().toISOString(), wokeAt: undefined, wokeReason: undefined }),
    [updateThread]
  );
  const unsnoozeThread = useCallback(
    (threadId: string) => updateThread(threadId, { snoozedAt: undefined }),
    [updateThread]
  );
  // A thread still running can't be settled; it would leave the sidebar
  // mid-run.
  const settleThread = useCallback(
    (threadId: string) => {
      const thread = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
      if (thread?.status === 'running') return;
      updateThread(threadId, {
        settledAt: new Date().toISOString(),
        snoozedAt: undefined,
        wokeAt: undefined,
        wokeReason: undefined,
        finishedUnseenAt: undefined,
      });
    },
    [updateThread]
  );
  const unsettleThread = useCallback(
    (threadId: string) => updateThread(threadId, { settledAt: undefined }),
    [updateThread]
  );

  const projectThreadsByProject = useMemo(() => {
    const grouped = new Map<string, Thread[]>();
    for (const thread of threads) {
      // Top-level rows only; children render nested under their parent.
      if (childThreadIds.has(thread.id)) continue;
      const projectThreads = grouped.get(thread.projectId);
      if (projectThreads) projectThreads.push(thread);
      else grouped.set(thread.projectId, [thread]);
    }
    for (const projectThreads of grouped.values()) {
      projectThreads.sort((a, b) => getThreadActivityTime(b).getTime() - getThreadActivityTime(a).getTime());
    }
    return grouped;
  }, [childThreadIds, threads]);

  const runningThreadCount = useMemo(
    () =>
      restartToUpdateConfirmOpen
        ? threads.filter((thread) => thread.status === 'running' || activeRunsByThread[thread.id]).length
        : 0,
    [activeRunsByThread, restartToUpdateConfirmOpen, threads]
  );

  const activeThreadProject = selectedThreadProject ?? defaultNewThreadProject;
  const activeIsNoProject = isNoProjectId(activeThreadProject?.id);

  // The directory the repository controls act on: the selected thread's
  // Durango workspace when it has one, otherwise the project.
  const activeDurangoWorkspace = selectedThread?.durangoWorkspace ?? null;
  const activeWorkspaceUnavailable = selectedThreadWorkspaceUnavailable;
  const activeWorkingDir = activeWorkspaceUnavailable
    ? null
    : (activeDurangoWorkspace?.workingDir ?? activeThreadProject?.path ?? null);
  const previousActiveWorkingDirRef = useRef(activeWorkingDir);

  // ---- Built-in browser panel (tabs live in main; see app/BrowserPanel) ----
  const browserAutoOpen = useOrionStore((state) => state.browserSettings?.autoOpenPanel !== false);
  const browserAskBeforeDownload = useOrionStore((state) => state.browserSettings?.askBeforeDownload !== false);
  useEffect(() => {
    void window.orion?.browser?.setOptions?.({ askBeforeDownload: browserAskBeforeDownload });
  }, [browserAskBeforeDownload]);
  const [browserPanelOpen, setBrowserPanelOpenState] = useState(() => {
    try {
      return window.localStorage.getItem('orion.browserPanel.open') === '1';
    } catch {
      return false;
    }
  });
  const setBrowserPanelOpen = useCallback((open: boolean) => {
    setBrowserPanelOpenState(open);
    try {
      window.localStorage.setItem('orion.browserPanel.open', open ? '1' : '0');
    } catch {}
  }, []);
  // The browser shows as a preview in the corner; expanded, as a modal.
  const [browserExpanded, setBrowserExpanded] = useState(false);
  // Minimized: the corner preview retracts to its title bar (remembered).
  const [browserMinimized, setBrowserMinimizedState] = useState(() => {
    try {
      return window.localStorage.getItem('orion.browserPanel.minimized') === '1';
    } catch {
      return false;
    }
  });
  const setBrowserMinimized = useCallback((minimized: boolean) => {
    setBrowserMinimizedState(minimized);
    try {
      window.localStorage.setItem('orion.browserPanel.minimized', minimized ? '1' : '0');
    } catch {}
  }, []);
  const [browserSelectedTabId, setBrowserSelectedTabId] = useState<string | null>(null);
  const browserThreadParents = useThreadParents(threads);
  useCloseTabsOfFinishedThreads(threads);
  const browserEventContextRef = useRef({ selectedThreadId, parents: browserThreadParents, autoOpen: browserAutoOpen, open: browserPanelOpen });
  browserEventContextRef.current = { selectedThreadId, parents: browserThreadParents, autoOpen: browserAutoOpen, open: browserPanelOpen };
  const browserState = useBrowserTabs((event) => {
    if (event.type !== 'agent-opened' && event.type !== 'popup-opened' && event.type !== 'download-requested') return;
    const context = browserEventContextRef.current;
    // Only tabs of the thread on screen (or its subagents) pull the panel open.
    const ownTab = tabsForThread(
      [{ ownerKey: event.ownerKey ?? event.threadId ?? '', threadId: event.threadId } as BrowserTab],
      context.selectedThreadId,
      context.parents
    ).length > 0;
    if (!ownTab) return;
    // A download waits for the user's answer, so it always opens the panel.
    if (context.open || context.autoOpen || event.type === 'download-requested') {
      setBrowserSelectedTabId(event.tabId);
      if (!context.open) setBrowserPanelOpen(true);
      // The Save / Cancel prompt is in the expanded view.
      if (event.type === 'download-requested') setBrowserExpanded(true);
    }
  });
  const browserPanelTabs = useMemo(
    () => tabsForThread(browserState.tabs, selectedThreadId, browserThreadParents),
    [browserState.tabs, selectedThreadId, browserThreadParents]
  );
  const browserActiveTabId = useMemo(() => {
    if (browserSelectedTabId && browserPanelTabs.some((tab) => tab.id === browserSelectedTabId)) return browserSelectedTabId;
    const recent = [...browserPanelTabs].sort(
      (a, b) => Math.max(b.lastAgentActionAt, b.createdAt) - Math.max(a.lastAgentActionAt, a.createdAt)
    )[0];
    return recent?.id ?? null;
  }, [browserSelectedTabId, browserPanelTabs]);
  const browserOwnerLabel = useCallback(
    (tab: BrowserTab) => {
      if (tab.ownerKey === 'user') return 'You';
      const title = threads.find((thread) => thread.id === tab.threadId)?.title?.trim() || 'Agent';
      return tab.agentId ? `${title} · subagent` : title;
    },
    [threads]
  );
  const browserAgentTabCount = browserPanelTabs.filter((tab) => tab.ownerKey !== 'user').length;
  // With no tab there is nothing to preview: only the expanded view shows.
  const browserVisible = browserPanelOpen && (browserExpanded || browserPanelTabs.length > 0);
  const toggleBrowser = useCallback(() => {
    if (browserVisible) {
      setBrowserPanelOpen(false);
      setBrowserExpanded(false);
      return;
    }
    setBrowserPanelOpen(true);
    // Nothing to preview yet: open straight to the address bar.
    setBrowserExpanded(browserPanelTabs.length === 0);
  }, [browserVisible, browserPanelTabs.length, setBrowserPanelOpen]);
  const collapseBrowser = useCallback(() => {
    setBrowserExpanded(false);
    if (browserPanelTabs.length === 0) setBrowserPanelOpen(false);
  }, [browserPanelTabs.length, setBrowserPanelOpen]);
  const expandBrowser = useCallback(() => setBrowserExpanded(true), []);
  const closeBrowser = useCallback(() => {
    setBrowserExpanded(false);
    setBrowserPanelOpen(false);
  }, [setBrowserPanelOpen]);
  useLayoutEffect(() => {
    const workingDirChanged = previousActiveWorkingDirRef.current !== activeWorkingDir;
    previousActiveWorkingDirRef.current = activeWorkingDir;
    // Keep the editor mounted only while it still belongs to the active
    // thread. Leaving Code preserves any open-file state; reopening it
    // goes through handleSetActiveTab, which switches the workspace root.
    if (activeTab === 'code' && (activeWorkspaceUnavailable || workingDirChanged)) {
      setActiveTab('agents');
    }
  }, [activeWorkspaceUnavailable, activeWorkingDir, activeTab, setActiveTab]);

  // Models eligible for the hidden text-generation turns. Orion can't delegate
  // to itself, the Claude Code CLI pseudo-model is an interactive terminal, and
  // OpenCode's non-interactive command has no mode Orion can pin to read-only —
  // hidden turns there fail closed in main, so it is never offered.
  const utilityCandidateModels = useMemo(
    () =>
      agentModels.filter(
        (model) => !isOrionModelId(model.id) && model.id !== claudeCodeCliModelId && model.providerId !== 'opencode'
      ),
    [agentModels]
  );
  const utilityProviders = useMemo(
    () =>
      agentProviders.filter(
        (provider) =>
          provider.id !== 'orion' &&
          enabledProviderIdSet.has(provider.id) &&
          utilityCandidateModels.some((model) => model.providerId === provider.id)
      ),
    [enabledProviderIdSet, utilityCandidateModels]
  );
  // The model behind thread titles and commit/PR messages: the Settings
  // pick when it's installed and its provider is enabled, else the first
  // usable model in UTILITY_MODEL_PREFERENCE, else none.
  const resolvedUtilityModelId = useMemo(() => {
    const isUsable = (id: string | null | undefined): id is string => {
      if (!id) return false;
      const model = utilityCandidateModels.find((candidate) => candidate.id === id);
      return !!model && model.available !== false && enabledProviderIdSet.has(model.providerId);
    };
    const preferred = textGenerationSettings?.modelId ?? null;
    if (isUsable(preferred)) return preferred;
    return UTILITY_MODEL_PREFERENCE.find(isUsable) ?? null;
  }, [enabledProviderIdSet, textGenerationSettings?.modelId, utilityCandidateModels]);
  const resolvedUtilityModel = useMemo(
    () => utilityCandidateModels.find((model) => model.id === resolvedUtilityModelId) ?? null,
    [resolvedUtilityModelId, utilityCandidateModels]
  );
  const utilityModelProviderId = resolvedUtilityModel?.providerId ?? null;
  // Reasoning tiers the picked model actually accepts, cheapest first. Cursor
  // and Kimi take none, so they get no picker at all.
  const utilityReasoningOptions = useMemo(
    () => reasoningOptionsForModel(resolvedUtilityModel),
    [resolvedUtilityModel]
  );
  // A hidden turn writes a title or a commit message, so an unset effort — and
  // one the current model doesn't offer, e.g. Claude's Ultrathink after a
  // switch to Codex — falls back to the cheapest tier rather than a provider
  // default that would spend real reasoning on one sentence.
  const resolvedUtilityReasoningEffort = useMemo(() => {
    if (utilityReasoningOptions.length === 0) return null;
    const stored = textGenerationSettings?.reasoningEffort ?? null;
    if (stored && utilityReasoningOptions.some((option) => option.value === stored)) return stored;
    return utilityReasoningOptions[0].value;
  }, [textGenerationSettings?.reasoningEffort, utilityReasoningOptions]);
  // Callers reach for these at the moment they fire a turn, so reading through
  // a ref keeps them off the resolvers' identity and out of re-render churn.
  const utilityTurnRef = useRef({
    modelId: resolvedUtilityModelId,
    reasoningEffort: resolvedUtilityReasoningEffort,
  });
  utilityTurnRef.current = {
    modelId: resolvedUtilityModelId,
    reasoningEffort: resolvedUtilityReasoningEffort,
  };
  /** `{ modelId, reasoningEffort }` for a hidden text-generation turn. */
  const resolveUtilityTurn = useCallback(() => utilityTurnRef.current, []);

  // The model behind agent deploys: the Deployments pick when it's installed
  // and its provider is enabled, else whatever the text-generation turns use.
  const resolvedDeploymentModelId = useMemo(() => {
    const picked = deploymentSettings?.agentModelId ?? null;
    const model = picked ? utilityCandidateModels.find((candidate) => candidate.id === picked) : null;
    if (model && model.available !== false && enabledProviderIdSet.has(model.providerId)) return picked;
    return resolvedUtilityModelId;
  }, [
    deploymentSettings?.agentModelId,
    enabledProviderIdSet,
    resolvedUtilityModelId,
    utilityCandidateModels,
  ]);
  const resolvedDeploymentModel = useMemo(
    () => utilityCandidateModels.find((model) => model.id === resolvedDeploymentModelId) ?? null,
    [resolvedDeploymentModelId, utilityCandidateModels]
  );
  const deploymentReasoningOptions = useMemo(
    () => reasoningOptionsForModel(resolvedDeploymentModel),
    [resolvedDeploymentModel]
  );
  // A deploy is a real implementation task, so an unset or stale effort uses
  // the selected model's normal default rather than Text generation's cheap
  // one-shot fallback.
  const resolvedDeploymentReasoningEffort = useMemo(() => {
    if (deploymentReasoningOptions.length === 0) return null;
    const stored = deploymentSettings?.reasoningEffort ?? null;
    if (stored && deploymentReasoningOptions.some((option) => option.value === stored)) return stored;
    return defaultReasoningEffortForModel(resolvedDeploymentModel);
  }, [deploymentReasoningOptions, deploymentSettings?.reasoningEffort, resolvedDeploymentModel]);
  const deploymentThreadReasoningPatch = useMemo(
    () => threadReasoningPatchForModel(resolvedDeploymentModel, resolvedDeploymentReasoningEffort),
    [resolvedDeploymentModel, resolvedDeploymentReasoningEffort]
  );

  const disposeThreadRuntime = useCallback(async (threadId: string) => {
    try {
      await window.orion?.disposeAgentThread?.(threadId);
    } catch (error) {
      console.error('Could not dispose agent thread runtime', error);
    }
  }, []);

  const deleteThreadWithRuntime = useCallback(
    async (threadId: string) => {
      const state = useOrionStore.getState();
      // Deleting another machine's thread here removes it from this
      // machine's list only (that machine keeps it): don't list it again.
      const remote = state.threads.find((thread) => thread.id === threadId)?.remote;
      if (remote?.threadId) dismissRemoteThread(remote.machineId, remote.threadId);
      const threadIds = new Set([threadId]);
      // A spawned child has an independent runtime. Deleting its parent must
      // therefore walk the whole subtree instead of merely orphaning work
      // that can continue changing the workspace in the background.
      let foundChild = true;
      while (foundChild) {
        foundChild = false;
        for (const thread of state.threads) {
          if (thread.parentThreadId && threadIds.has(thread.parentThreadId) && !threadIds.has(thread.id)) {
            threadIds.add(thread.id);
            foundChild = true;
          }
        }
      }

      const removedThreads = state.threads.filter((thread) => threadIds.has(thread.id));
      // Other machines' threads an agent of it started there go with it here
      // too, and must not come back as top-level threads with the next listing.
      for (const thread of removedThreads) {
        if (thread.id !== threadId && thread.remote?.threadId) {
          dismissRemoteThread(thread.remote.machineId, thread.remote.threadId);
        }
      }
      const runIds: string[] = [];
      const spawnIds: string[] = [];
      for (const thread of removedThreads) {
        const runId = activeRunsByThread[thread.id];
        if (runId) {
          runIds.push(runId);
          runOutputMessages.current.delete(runId);
          clearActiveRun(runId);
        }
        if (thread.spawnId) spawnIds.push(thread.spawnId);
      }

      await Promise.all(runIds.map((runId) => window.orion?.stopAgentTurn?.(runId, { terminateBackground: true })));
      await Promise.all(removedThreads.map((thread) => disposeThreadRuntime(thread.id)));
      // Their built-in browser tabs go with them.
      for (const thread of removedThreads) void window.orion?.browser?.closeThreadTabs(thread.id);
      for (const spawnId of spawnIds) {
        void window.orion?.reportSubagentResult?.({
          spawnId,
          ok: false,
          result: 'Subagent thread was deleted by the user.',
        });
      }
      // Delete children first so no orphan can briefly surface as a top-level
      // thread while the persisted store updates.
      for (const thread of removedThreads.reverse()) deleteThread(thread.id);

      // A Durango workspace no remaining thread uses goes with them, unless it
      // still holds work that has not landed: that is never discarded silently.
      const remaining = useOrionStore.getState().threads;
      const orphaned = new Map(
        removedThreads.flatMap((thread) =>
          thread.durangoWorkspace &&
          !remaining.some((candidate) => candidate.durangoWorkspace?.path === thread.durangoWorkspace?.path)
            ? [[thread.durangoWorkspace.path, thread.durangoWorkspace] as const]
            : []
        )
      );
      for (const workspace of orphaned.values()) {
        void window.orion
          ?.removeDurangoWorkspace?.({ name: workspace.name, repo: workspace.repo, path: workspace.path })
          .then((result) => {
            if (result.ok) return;
            toast.warning(`Kept Durango workspace ${workspace.name}`, {
              description: result.unlanded
                ? `It has work that has not landed. Remove it with \`durango-code ws rm ${workspace.name} --force\`.`
                : result.error,
            });
          });
      }
    },
    [activeRunsByThread, clearActiveRun, deleteThread, disposeThreadRuntime]
  );

  // A workspace removed outside its thread (by another thread's agent, or in a
  // terminal) is released from every thread that still points at it.
  useEffect(() => {
    const check = () => void releaseMissingDurangoWorkspaces();
    check();
    const timer = window.setInterval(check, WORKSPACE_PRESENCE_POLL_MS);
    window.addEventListener('focus', check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, []);

  // Removes a thread's Durango workspace (and with it, the workspace of every
  // branch or subagent sharing it). Their sessions were recorded inside it, so
  // they are cleared: the next message starts a fresh session in a new one.
  const handleRemoveThreadWorkspace = useCallback(
    async (threadId: string) => {
      const state = useOrionStore.getState();
      const workspace = state.threads.find((thread) => thread.id === threadId)?.durangoWorkspace;
      if (!workspace || !window.orion?.removeDurangoWorkspace) return;
      const sharing = state.threads.filter((thread) => thread.durangoWorkspace?.path === workspace.path);
      const sharingIds = sharing.map((thread) => thread.id);
      if (sharingIds.some((id) => workspaceRemovalThreadIdsRef.current.has(id))) return;
      if (sharing.some((thread) => thread.status === 'running' || activeRunsByThreadRef.current[thread.id])) {
        toast.error('Stop the agents working in this workspace before removing it');
        return;
      }
      if (
        !confirm(
          `Remove Durango workspace ${workspace.name}?\n\n` +
            'Its directory is deleted. ' +
            (sharing.length > 1 ? `${sharing.length} threads work in it; they ` : 'The thread ') +
            'keep their transcripts, and the next message starts a fresh agent session in a new workspace.'
        )
      ) {
        return;
      }
      markWorkspaceThreads('removal', sharingIds, true);
      try {
        await Promise.all(sharingIds.map((id) => disposeThreadRuntime(id)));
        let result = await window.orion.removeDurangoWorkspace({
          name: workspace.name,
          repo: workspace.repo,
          path: workspace.path,
        });
        if (!result.ok && result.unlanded) {
          if (
            !confirm(
              `${workspace.name} has work that has not landed:\n\n${result.error ?? ''}\n\nDiscard it and remove the workspace anyway?`
            )
          ) {
            return;
          }
          result = await window.orion.removeDurangoWorkspace({
            name: workspace.name,
            repo: workspace.repo,
            path: workspace.path,
            force: true,
          });
        }
        if (!result.ok) {
          toast.error(`Could not remove ${workspace.name}`, { description: result.error });
          return;
        }
        const removedAt = new Date().toISOString();
        for (const thread of sharing) {
          updateThread(thread.id, {
            durangoWorkspace: undefined,
            durangoWorkspaceRemovedAt: removedAt,
            agentSessionIds: undefined,
            pendingForkProviders: undefined,
          });
        }
        await flushOrionThreadsSave();
        toast.success(`Removed Durango workspace ${workspace.name}`);
      } finally {
        markWorkspaceThreads('removal', sharingIds, false);
      }
    },
    [disposeThreadRuntime, markWorkspaceThreads, updateThread]
  );

  const removeProjectWithRuntimes = useCallback(
    async (projectId: string) => {
      const projectThreads = useOrionStore.getState().threads.filter((thread) => thread.projectId === projectId);
      const runIds = projectThreads
        .map((thread) => activeRunsByThread[thread.id])
        .filter((runId): runId is string => Boolean(runId));
      for (const runId of runIds) {
        runOutputMessages.current.delete(runId);
        clearActiveRun(runId);
      }
      await Promise.all(runIds.map((runId) => window.orion?.stopAgentTurn?.(runId, { terminateBackground: true })));
      await Promise.all(projectThreads.map((thread) => disposeThreadRuntime(thread.id)));
      for (const thread of projectThreads) {
        if (!thread.spawnId) continue;
        void window.orion?.reportSubagentResult?.({
          spawnId: thread.spawnId,
          ok: false,
          result: 'Subagent project was removed by the user.',
        });
      }
      removeProject(projectId);
    },
    [activeRunsByThread, clearActiveRun, disposeThreadRuntime, removeProject]
  );

  const refreshAgentModels = useCallback(async (force = false) => {
    if (!window.orion?.listAgentModels) return;
    try {
      const models = await window.orion.listAgentModels({ force });
      if (models.length > 0) {
        setAgentModels(models);
        setAgentModelsLoaded(true);
      }
    } catch {
      // The fallback catalog remains usable when the bridge is unavailable.
    }
  }, []);

  const refreshProviderUpdates = useCallback(async () => {
    if (!window.orion?.checkProviderUpdates) return;
    setProviderUpdatesChecking(true);
    try {
      setProviderUpdateState(await window.orion.checkProviderUpdates({ enabledProviderIds }));
    } catch {
      setProviderUpdateState(null);
    } finally {
      setProviderUpdatesChecking(false);
    }
  }, [enabledProviderIds]);

  useEffect(() => {
    void refreshAgentModels();
    void refreshProviderUpdates();

    const interval = window.setInterval(() => {
      void refreshProviderUpdates();
    }, PROVIDER_UPDATE_CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [refreshAgentModels, refreshProviderUpdates]);

  // Background discovery refreshes the main-process catalog; pick up the
  // cached result whenever it changes.
  useEffect(() => {
    if (!window.orion?.onAgentModelsChanged) return undefined;
    return window.orion.onAgentModelsChanged(() => {
      void refreshAgentModels();
    });
  }, [refreshAgentModels]);

  useEffect(() => {
    if (!window.orion?.onProviderAuthenticated) return undefined;
    return window.orion.onProviderAuthenticated(() => {
      void refreshAgentModels(true);
      void refreshProviderUpdates();
    });
  }, [refreshAgentModels, refreshProviderUpdates]);

  useEffect(() => {
    let active = true;
    void window.orion?.getActiveProviderUpdate?.().then(
      (progress) => {
        if (!active || !progress) return;
        setProviderUpdateProgress(progress);
        setProviderUpdatesRunning(
          providerUpdateInvocationRef.current || progress.status === 'running' || progress.status === 'cancelling'
        );
      },
      () => {}
    );
    if (!window.orion?.onProviderUpdateProgress) {
      return () => {
        active = false;
      };
    }
    const unsubscribe = window.orion.onProviderUpdateProgress((progress) => {
      if (!active) return;
      setProviderUpdateProgress(progress);
      setProviderUpdatesRunning(
        providerUpdateInvocationRef.current || progress.status === 'running' || progress.status === 'cancelling'
      );
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // Claude Code CLI terminal threads: main discovers the live CLI session id
  // from claude's on-disk session store (the interactive TUI ignores
  // --session-id) and pushes it here. Stored on the thread so later spawns
  // can --resume it after an app restart. Registered app-wide (not in
  // TerminalView) so ids aren't missed while the terminal view is unmounted.
  useEffect(() => {
    if (!window.orion?.onTerminalSession) return undefined;
    return window.orion.onTerminalSession((event) => {
      setThreadAgentSession(event.threadId, 'claude', event.sessionId);
    });
  }, [setThreadAgentSession]);

  // Live slash-command lists pushed by Claude sessions (on init and on
  // mid-session commands_changed). Full replacement per project.
  useEffect(() => {
    if (!window.orion?.onSlashCommands) return undefined;
    return window.orion.onSlashCommands(({ projectPath, commands }) => {
      setSlashCommandsByProject((prev) => ({ ...prev, [projectPath]: commands }));
    });
  }, []);

  // Prefetch the project's command list when a Claude-backed thread is
  // selected, so the first "/" keystroke shows real commands instead of the
  // static fallback. Main answers from a live session or its cache; for a
  // cold project it boots a short-lived promptless CLI to harvest the list
  // (a couple of seconds — the fallback covers the gap).
  useEffect(() => {
    if (!selectedThreadClaudeBacked || !selectedThreadProjectPath || !selectedThreadId) return;
    if (slashCommandsByProject[selectedThreadProjectPath]) return;
    let cancelled = false;
    const projectPath = selectedThreadProjectPath;
    void window.orion
      ?.listSlashCommands?.({ threadId: selectedThreadId, projectPath })
      .then((result) => {
        if (cancelled || !result?.ok || !result.commands) return;
        const commands = result.commands;
        setSlashCommandsByProject((prev) => ({ ...prev, [projectPath]: commands }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    selectedThreadClaudeBacked,
    selectedThreadId,
    selectedThreadProjectPath,
    slashCommandsByProject,
  ]);

  useEffect(() => {
    let mounted = true;

    void window.orion?.getAppUpdateState?.().then((state) => {
      if (mounted) setAppUpdateState(state);
    });
    void window.orion?.getWhatsNew?.().then((state) => {
      if (mounted) setWhatsNew(state);
    });

    const unsubscribe = window.orion?.onAppUpdateState?.((state) => {
      setAppUpdateState(state);
      setAppUpdateBusy(false);
    });

    // Automatic checks stay silent when they fail: right after login Orion is
    // usually running before the network is, and a failed check is not an
    // update failure. The main process retries on its own schedule.
    void window.orion?.checkForAppUpdate?.({ background: true }).catch(() => {});

    // Connectivity returning is the earliest moment a startup check can
    // succeed; re-check right away instead of waiting out the retry delay.
    const handleOnline = () => {
      void window.orion?.checkForAppUpdate?.({ background: true }).catch(() => {});
    };
    window.addEventListener('online', handleOnline);

    return () => {
      mounted = false;
      unsubscribe?.();
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    void window.orion
      ?.getAccountSession?.()
      .then((state) => {
        if (mounted) setAccountState(state);
      })
      .catch(() => {
        if (mounted) {
          setAccountState({
            authenticated: false,
            user: null,
            expiresAt: null,
          });
        }
      })
      .finally(() => {
        if (mounted) setAccountLoading(false);
      });

    const unsubscribe = window.orion?.onAccountChanged?.((state) => {
      setAccountState(state);
      setAccountLoading(false);
      setAccountBusy(false);
    });

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  // Workspace sync engine lives in main; push the opt-in settings to it on
  // hydration and every change, and mirror its status for the settings panel.
  const [workspaceSyncStatus, setWorkspaceSyncStatus] = useState<WorkspaceSyncStatus | null>(null);
  const [storeHydrated, setStoreHydrated] = useState(() => useOrionStore.persist.hasHydrated());
  useEffect(() => {
    if (useOrionStore.persist.hasHydrated()) {
      setStoreHydrated(true);
      return;
    }
    return useOrionStore.persist.onFinishHydration(() => setStoreHydrated(true));
  }, []);
  useEffect(() => {
    // Runs after the hydrated frame commits: the real sidebar is underneath.
    if (storeHydrated) removeBootSkeleton();
  }, [storeHydrated]);
  // Drafts saved by the last session list their threads again, like ones
  // typed into this session.
  useEffect(() => {
    if (!storeHydrated) return;
    const savedDraftIds = Object.keys(useOrionStore.getState().composerDrafts);
    if (savedDraftIds.length > 0) setTypedDraftThreadIds((prev) => new Set([...prev, ...savedDraftIds]));
  }, [storeHydrated]);
  useEffect(() => {
    // Never push pre-hydration defaults: work sharing defaults to on, and a
    // user who turned it off must not get a single sync call at startup.
    if (!storeHydrated) return;
    void window.orion?.workspaceSyncConfigure?.(useOrionStore.getState().workspaceSyncSettings);
  }, [storeHydrated, workspaceSyncSettings]);
  // Durango Tasks backend and Durango Chat dispatch live in main; push the
  // settings and the project list (for machine registration) on hydration
  // and on every change. The signature keeps unrelated project edits (icons,
  // ordering) from re-registering the machine.
  const durangoSettingsForMain = useOrionStore((state) => state.durangoSettings);
  const dispatchProjectsSignature = useOrionStore((state) =>
    JSON.stringify(state.projects.map((project) => [project.id, project.name, project.path]))
  );
  useEffect(() => {
    if (!storeHydrated || !window.orion?.durangoConfigure) return;
    const state = useOrionStore.getState();
    const settings = { ...defaultDurangoSettings, ...state.durangoSettings };
    void window.orion
      .durangoConfigure({
        useDurangoTasks: settings.useDurangoTasks !== false,
        dispatch: { ...defaultDurangoDispatchSettings, ...settings.dispatch },
        deployWatcher: { ...defaultDurangoDeployWatcherSettings, ...settings.deployWatcher },
        projects: dispatchProjectsPayload(state.projects),
      })
      .catch(() => {});
  }, [storeHydrated, durangoSettingsForMain, dispatchProjectsSignature]);
  // One-time "your coding work now syncs" notice (workspaceSyncConsent.ts).
  // No default text-generation model and no usable pick: ask, once per launch,
  // as long as there is something installed to choose from.
  const showTextGenerationModelPrompt =
    storeHydrated &&
    agentModelsLoaded &&
    !resolvedUtilityModelId &&
    !textGenerationPromptDismissed &&
    !settingsOpen &&
    utilityCandidateModels.some(
      (model) => model.available !== false && enabledProviderIdSet.has(model.providerId)
    );

  const showWorkspaceSyncNotice =
    storeHydrated && shouldShowWorkspaceSyncNotice(workspaceSyncSettings, accountState.authenticated);
  const acknowledgeWorkspaceSyncNotice = useCallback(() => {
    setWorkspaceSyncSettings({ consentNoticeSeen: true });
  }, [setWorkspaceSyncSettings]);
  const turnOffWorkspaceSyncFromNotice = useCallback(() => {
    setWorkspaceSyncSettings({ enabled: false, consentNoticeSeen: true });
    toast.info('Sharing coding work with Durango is off. Turn it back on anytime in Settings → Durango.');
  }, [setWorkspaceSyncSettings]);
  // Claude Code CLI terminals take instructions once, at launch: keep the
  // opted-in "[Durango memory]" block ready for them (main caches the recall).
  const includeDurangoProfileMemory = useOrionStore(
    (state) => state.durangoSettings?.includeProfileMemory === true
  );
  const [terminalDurangoMemoryBlock, setTerminalDurangoMemoryBlock] = useState('');
  useEffect(() => {
    if (!includeDurangoProfileMemory || !accountState.authenticated) {
      setTerminalDurangoMemoryBlock('');
      return;
    }
    let active = true;
    void fetchDurangoProfileMemoryBlock().then((block) => {
      if (active) setTerminalDurangoMemoryBlock(block);
    });
    return () => {
      active = false;
    };
  }, [includeDurangoProfileMemory, accountState.authenticated, accountState.user?.id]);
  useEffect(() => {
    const unsubscribe = window.orion?.onWorkspaceSyncState?.((state) => {
      setWorkspaceSyncStatus(state);
    });
    return () => unsubscribe?.();
  }, []);
  const handleWorkspaceSyncNow = useCallback(() => {
    void window.orion?.workspaceSyncNow?.();
  }, []);

  // Remote control engine lives in main; push the persisted opt-in settings on
  // hydration and every change, and mirror its state for the prompt box's
  // machine picker (the settings tab keeps its own subscription while mounted).
  const [remoteControlState, setRemoteControlState] = useState<RemoteControlState | null>(null);
  useEffect(() => {
    let cancelled = false;
    let unsubscribeHydration = () => {};
    let finishHydrationWait = () => {};
    const configure = async () => {
      if (!useOrionStore.persist.hasHydrated()) {
        await new Promise<void>((resolve) => {
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            unsubscribeHydration();
            resolve();
          };
          finishHydrationWait = finish;
          unsubscribeHydration = useOrionStore.persist.onFinishHydration(finish);
          if (useOrionStore.persist.hasHydrated()) finish();
        });
      }
      if (cancelled) return;
      // The effect may have mounted with defaults; after the await, read the
      // hydrated store rather than sending that stale closure to main.
      await window.orion?.remoteControlConfigure?.(useOrionStore.getState().remoteControlSettings);
      if (cancelled) return;
      const state = await window.orion?.remoteControlGetState?.();
      if (!cancelled) setRemoteControlState(state ?? null);
    };
    void configure();
    return () => {
      cancelled = true;
      finishHydrationWait();
    };
  }, [remoteControlSettings]);
  useEffect(() => {
    const unsubscribe = window.orion?.onRemoteState?.((state) => setRemoteControlState(state));
    return () => unsubscribe?.();
  }, []);
  const remoteMachines = remoteControlState?.machines ?? EMPTY_REMOTE_MACHINES;
  // The prompt box offers other machines once remote control is on, signed
  // in, and at least one machine is paired.
  const remoteMachinesAvailable = Boolean(
    remoteControlSettings.enabled &&
      remoteControlIsAuthenticated(accountState.authenticated, remoteControlState?.authenticated) &&
      remoteMachines.length > 0
  );
  const localMachineName = remoteControlState?.machineName ?? 'This machine';
  // A thread left running on a machine that is no longer paired (or with
  // remote control off) can't be followed or stopped from here: it shows as
  // stopped rather than running forever. Turning remote control back on and
  // reaching the machine brings its real status back.
  const remoteEngineReady = Boolean(remoteControlState && !remoteControlState.starting);
  useEffect(() => {
    if (!storeHydrated || (remoteControlSettings.enabled && !remoteEngineReady)) return;
    const paired = new Set(remoteControlSettings.enabled ? remoteMachines.map((machine) => machine.id) : []);
    for (const thread of useOrionStore.getState().threads) {
      if (thread.remote && thread.status === 'running' && !paired.has(thread.remote.machineId)) {
        useOrionStore.getState().updateThread(thread.id, { status: 'idle' });
      }
    }
  }, [remoteControlSettings.enabled, remoteEngineReady, remoteMachines, storeHydrated, threads]);

  useEffect(() => {
    if (!modelPickerOpen) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) {
        setModelPickerOpen(false);
        setModelSearch('');
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setModelPickerOpen(false);
        setModelSearch('');
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [modelPickerOpen]);

  useEffect(() => {
    if (!utilityModelPickerOpen) return undefined;

    const close = () => {
      setUtilityModelPickerOpen(false);
      setUtilityModelSearch('');
    };
    const handlePointerDown = (event: MouseEvent) => {
      if (!utilityModelPickerRef.current?.contains(event.target as Node)) close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [utilityModelPickerOpen]);

  useEffect(() => {
    if (!taskPickerOpen) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      if (!taskPickerRef.current?.contains(event.target as Node)) {
        setTaskPickerOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTaskPickerOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [taskPickerOpen]);

  useEffect(() => {
    if (!codexSettingsOpen) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      if (!codexSettingsRef.current?.contains(event.target as Node)) {
        setCodexSettingsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCodexSettingsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [codexSettingsOpen]);

  useEffect(() => {
    if (!accessModeOpen) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      if (!accessModeRef.current?.contains(event.target as Node)) {
        setAccessModeOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAccessModeOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [accessModeOpen]);

  useEffect(() => {
    if (!shouldShowAgentSettings) {
      setCodexSettingsOpen(false);
    }
  }, [shouldShowAgentSettings]);

  // Re-blur the account email when Settings closes or the signed-in identity
  // changes. Keying the reveal to the identity also keeps a newly rendered
  // account concealed before this effect clears the previous state.
  useEffect(() => {
    setRevealedAccountIdentity(null);
  }, [settingsOpen, accountIdentity]);

  // Poll while the Computer Use tab is visible so grants toggled over in
  // System Settings show up without a manual refresh.
  useEffect(() => {
    if (!settingsOpen || settingsTab !== 'computer-use') return undefined;
    let cancelled = false;
    const refresh = async () => {
      try {
        const state = await window.orion.getComputerUsePermissions();
        if (!cancelled) setComputerUsePerms(state);
      } catch {
        // main process unavailable; leave the last known state in place
      }
    };
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [settingsOpen, settingsTab]);

  const handleRequestComputerUsePermission = useCallback(async (kind: OrionComputerUsePermissionKind) => {
    setComputerUseBusyKind(kind);
    try {
      const result = await window.orion.requestComputerUsePermission(kind);
      if (result.state) setComputerUsePerms(result.state);
      if (!result.ok && result.error) toast.error(result.error);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not request the permission.');
    } finally {
      setComputerUseBusyKind(null);
    }
  }, []);

  const handleOpenChromeDebugSetup = useCallback(async () => {
    try {
      const result = await window.orion.openChromeDebugSetup();
      if (result.ok) {
        toast.success('Opened Chrome — the setup link is also on your clipboard.');
      } else if (result.error) {
        toast.error(result.error);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not open Chrome.');
    }
  }, []);

  // Reads race: a status scan of the previously active project (large repos
  // take seconds) can resolve after the fast read for the project the user
  // just switched to, and would overwrite the pill and picker with the wrong
  // repository's branches. Only the latest request may write state.
  const gitRefreshSeqRef = useRef(0);
  const refreshGitState = useCallback(async () => {
    const projectPath = activeWorkingDir;
    const seq = ++gitRefreshSeqRef.current;
    if (!projectPath || !window.orion?.getGitState) {
      setGitState(null);
      setGitLoading(false);
      return;
    }

    setGitLoading(true);
    try {
      const state = await window.orion.getGitState(projectPath);
      if (seq !== gitRefreshSeqRef.current) return;
      setGitState(state);
    } catch (error) {
      if (seq !== gitRefreshSeqRef.current) return;
      setGitState({
        ok: false,
        branches: [],
        hasUncommittedChanges: false,
        error: error instanceof Error ? error.message : 'Unable to read git state',
      });
    } finally {
      if (seq === gitRefreshSeqRef.current) setGitLoading(false);
    }
  }, [activeWorkingDir]);

  useEffect(() => {
    void refreshGitState();
  }, [refreshGitState]);

  // A checkout in an outside terminal doesn't notify the app; re-read when
  // the window regains focus so the pill matches the repository's real HEAD.
  useEffect(() => {
    const onFocus = () => void refreshGitState();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshGitState]);

  // An agent can switch branches (or leave its workspace) during a turn;
  // re-read when the turn ends so the pill shows where the checkout is now.
  const selectedThreadRunning = selectedThread?.status === 'running';
  useEffect(() => {
    if (!selectedThreadRunning) void refreshGitState();
  }, [refreshGitState, selectedThreadRunning]);

  // Same stale-response race as refreshGitState: only the latest request may
  // write, so a slow read for the previous project can't repaint the cloud
  // pill after a project switch.
  const cloudRefreshSeqRef = useRef(0);
  const refreshCloudState = useCallback(async () => {
    const projectPath = activeWorkingDir;
    const seq = ++cloudRefreshSeqRef.current;
    if (!projectPath || !window.orion?.getCloudState) {
      setCloudState(null);
      return;
    }

    try {
      const state = await window.orion.getCloudState(projectPath);
      if (seq !== cloudRefreshSeqRef.current) return;
      setCloudState(state);
    } catch (error) {
      if (seq !== cloudRefreshSeqRef.current) return;
      setCloudState({
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to read Durango Cloud state',
      });
    }
  }, [activeWorkingDir]);

  // Cloud state depends on both the account session and local git state
  // (each git action can change what is ahead/behind the cloud copy).
  useEffect(() => {
    void refreshCloudState();
  }, [refreshCloudState, accountState.authenticated, gitState]);

  // The Orion Cloud app for the active project: whatever we've learned since
  // the last cloud-state refresh wins, because a deploy queued a second ago is
  // newer than the state that was read before it.
  const cloudApp = useMemo<OrionCloudApp | null>(() => {
    if (!activeWorkingDir) return null;
    return activeWorkingDir in cloudAppsByDir
      ? cloudAppsByDir[activeWorkingDir]
      : (cloudState?.app ?? null);
  }, [activeWorkingDir, cloudAppsByDir, cloudState?.app]);

  const recordCloudApp = useCallback((projectPath: string, app: OrionCloudApp | null) => {
    // Every poll returns a fresh object; only re-render when it says something
    // different, so a slow build doesn't repaint the shell every four seconds.
    setCloudAppsByDir((current) => {
      const previous = current[projectPath];
      if (
        previous?.status === app?.status &&
        previous?.url === app?.url &&
        previous?.error === app?.error
      ) {
        return current;
      }
      return { ...current, [projectPath]: app };
    });
    if (!app || !cloudDeployWatchRef.current.has(projectPath)) return;
    if (app.status === 'deployed') {
      cloudDeployWatchRef.current.delete(projectPath);
      toast.success(`Live at ${cloudAppHost(app.url)}`, {
        action: {
          label: 'Open app',
          onClick: () => void window.orion?.openExternalUrl?.(app.url),
        },
      });
    } else if (app.status === 'failed') {
      cloudDeployWatchRef.current.delete(projectPath);
      toast.error(app.error ?? 'Durango Cloud could not build this app.');
    }
  }, []);

  // While a build is queued or running, poll for the app row until it settles.
  // Keyed off the status alone so a fresh poll result doesn't restart the timer.
  useEffect(() => {
    const projectPath = activeWorkingDir;
    if (!projectPath || !window.orion?.getCloudAppState) return undefined;
    const status = cloudApp?.status;
    if (status !== 'queued' && status !== 'building') {
      delete cloudDeployPollStartRef.current[projectPath];
      return undefined;
    }
    const startedAt = cloudDeployPollStartRef.current[projectPath] ?? Date.now();
    cloudDeployPollStartRef.current[projectPath] = startedAt;

    let cancelled = false;
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt > CLOUD_DEPLOY_POLL_TIMEOUT_MS) {
        window.clearInterval(timer);
        cloudDeployWatchRef.current.delete(projectPath);
        return;
      }
      void window.orion
        ?.getCloudAppState?.(projectPath)
        .then((result) => {
          if (cancelled || !result.ok) return;
          recordCloudApp(projectPath, result.app ?? null);
        })
        .catch(() => {
          // A single failed poll is not worth surfacing; the next tick retries.
        });
    }, CLOUD_DEPLOY_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeWorkingDir, cloudApp?.status, recordCloudApp]);

  const handleUpdateProviders = useCallback(async () => {
    if (!window.orion?.updateProviders || providerUpdatesRunning) return;

    providerUpdateInvocationRef.current = true;
    setProviderUpdateProgress(null);
    setProviderUpdatesRunning(true);
    try {
      const result = await window.orion.updateProviders({ enabledProviderIds });
      setProviderUpdateState(result.state);
      await refreshAgentModels(true);

      if (result.cancelled) {
        toast.info('Provider updates cancelled');
        void refreshProviderUpdates();
      } else if (result.ok) {
        toast.success('Provider CLIs updated');
      } else {
        toast.error(result.error ?? 'Some provider updates failed');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update provider CLIs');
    } finally {
      providerUpdateInvocationRef.current = false;
      setProviderUpdatesRunning(false);
    }
  }, [enabledProviderIds, providerUpdatesRunning, refreshAgentModels, refreshProviderUpdates]);

  const handleCancelProviderUpdate = useCallback(async () => {
    if (!window.orion?.cancelProviderUpdate || !providerUpdateProgress) return;
    try {
      const result = await window.orion.cancelProviderUpdate(providerUpdateProgress.operationId);
      if (!result.ok) toast.error(result.error ?? 'Could not stop the provider update');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not stop the provider update');
    }
  }, [providerUpdateProgress]);

  const handleAppUpdateClick = useCallback(async () => {
    if (!appUpdateState || appUpdateBusy) return;
    if (
      appUpdateState.status === 'downloading' ||
      appUpdateState.status === 'checking' ||
      appUpdateState.status === 'restarting'
    ) {
      return;
    }

    // Restarting interrupts every running agent; RestartToUpdateDialog asks
    // first and calls confirmRestartToUpdate.
    if (appUpdateState.status === 'downloaded') {
      setRestartToUpdateConfirmOpen(true);
      return;
    }

    setAppUpdateBusy(true);
    try {
      if (appUpdateState.status === 'available') {
        await window.orion?.downloadAppUpdate?.();
        return;
      }

      await window.orion?.checkForAppUpdate?.({ force: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update Durango Code');
      setAppUpdateBusy(false);
    }
  }, [appUpdateBusy, appUpdateState]);

  const cancelRestartToUpdate = useCallback(() => setRestartToUpdateConfirmOpen(false), []);
  const confirmRestartToUpdate = useCallback(async () => {
    setRestartToUpdateConfirmOpen(false);
    setAppUpdateBusy(true);
    try {
      // Stays busy on success: the app is on its way out. Only a restart that
      // could not go through hands the button back.
      const result = await window.orion?.restartToUpdate?.();
      if (result && result.ok === false) {
        toast.error(result.error ?? 'Could not restart to update');
        setAppUpdateBusy(false);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update Durango Code');
      setAppUpdateBusy(false);
    }
  }, []);

  const dismissWhatsNew = useCallback(() => {
    setWhatsNew((current) => (current ? { ...current, unseen: false } : current));
    void window.orion?.dismissWhatsNew?.().catch(() => {});
  }, []);

  const handleStartAccountAuth = useCallback(async () => {
    if (!window.orion?.startAccountAuth || accountBusy) return;

    setAccountBusy(true);
    try {
      const result = await window.orion.startAccountAuth();
      if (!result.ok) {
        toast.error(result.error ?? 'Could not start Durango sign-in');
        setAccountBusy(false);
      } else {
        toast.info('Continue sign in in your browser');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start Durango sign-in');
      setAccountBusy(false);
    }
  }, [accountBusy]);

  const handleSignOutAccount = useCallback(async () => {
    if (!window.orion?.signOutAccount || accountBusy) return;

    setAccountBusy(true);
    try {
      setAccountState(await window.orion.signOutAccount());
      toast.success('Signed out of your Durango account');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not sign out');
    } finally {
      setAccountBusy(false);
    }
  }, [accountBusy]);

  const handleAuthenticateProvider = useCallback(
    async (providerId: string) => {
      if (!window.orion?.authenticateProvider || authenticatingProviderId) return;

      setAuthenticatingProviderId(providerId);
      try {
        const result = await window.orion.authenticateProvider(providerId);
        if (result.ok) {
          toast.info('Authentication started');
        } else {
          toast.error(result.error ?? 'Could not start authentication');
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not start authentication');
      } finally {
        setAuthenticatingProviderId(null);
      }
    },
    [authenticatingProviderId]
  );

  useEffect(() => {
    if (
      !branchPickerOpen &&
      !threadSearchOpen &&
      !threadMenuOpen &&
      !goalMenuOpen &&
      !openWithOpen &&
      projectMenuOpenId === null &&
      threadItemMenuKey === null
    )
      return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (branchPickerOpen && !branchPickerRef.current?.contains(target)) {
        setBranchPickerOpen(false);
      }
      if (openWithOpen && !openWithRef.current?.contains(target)) {
        setOpenWithOpen(false);
      }
      // Sidebar v2's search panel is portaled out of the header row.
      if (
        threadSearchOpen &&
        !threadSearchRef.current?.contains(target) &&
        !(target instanceof Element && target.closest('[data-thread-search-popover]'))
      ) {
        setThreadSearchOpen(false);
      }
      if (threadMenuOpen && !threadMenuRef.current?.contains(target)) {
        setThreadMenuOpen(false);
      }
      if (goalMenuOpen && !goalMenuRef.current?.contains(target)) {
        setGoalMenuOpen(false);
      }
      if (projectMenuOpenId !== null && !projectMenuRef.current?.contains(target)) {
        setProjectMenuOpenId(null);
      }
      if (threadItemMenuKey !== null && !threadItemMenuRef.current?.contains(target)) {
        setThreadItemMenuKey(null);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setBranchPickerOpen(false);
        setThreadSearchOpen(false);
        setThreadMenuOpen(false);
        setGoalMenuOpen(false);
        setOpenWithOpen(false);
        setProjectMenuOpenId(null);
        setThreadItemMenuKey(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    branchPickerOpen,
    threadMenuOpen,
    goalMenuOpen,
    threadSearchOpen,
    openWithOpen,
    projectMenuOpenId,
    threadItemMenuKey,
  ]);

  useEffect(() => {
    setThreadMenuOpen(false);
  }, [selectedThreadId]);

  useEffect(() => {
    let cancelled = false;
    void window.orion?.listOpenWithApps?.().then((apps) => {
      if (!cancelled && Array.isArray(apps)) setOpenWithApps(apps);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Streamed chunks can arrive many times per second; buffer them briefly so
  // each token doesn't trigger a full store update (and a store persist).
  const chunkBuffers = useRef(
    new Map<string, { threadId: string; messageId: string; text: string; baseLen: number }>()
  );
  const chunkFlushTimer = useRef<number | null>(null);

  // Every flush re-renders the transcript, and rendering a message touches its
  // whole content string — V8 materializes an O(length) copy each time. At a
  // fixed 60ms cadence that alone balloons the renderer's memory on long turns
  // (hundreds of MB/s of churn by the time a transcript reaches a few MB), so
  // large messages flush progressively less often. Values are a compromise
  // between streaming smoothness and that per-flush cost.
  const chunkFlushDelay = (contentLen: number) => {
    if (contentLen < 128_000) return 60;
    if (contentLen < 512_000) return 250;
    if (contentLen < 2_000_000) return 600;
    return 1500;
  };

  // --- Linked board tasks (Orion web kanban) -----------------------------------

  // Forget one card locally (the web side unlinked or deleted it, or the user
  // unlinked it here). `undefined` rather than an empty array once the last one
  // goes, so a thread that never linked anything looks the same as one that
  // unlinked everything.
  // Replace one card in place, keeping its position in the list.
  const updateLinkedTask = useCallback(
    (threadId: string, taskId: string, next: LinkedBoardTask) => {
      const thread = useOrionStore.getState().threads.find((t) => t.id === threadId);
      const linkedTasks = thread?.linkedTasks;
      if (!linkedTasks?.some((task) => task.id === taskId)) return;
      updateThread(threadId, {
        linkedTasks: linkedTasks.map((task) => (task.id === taskId ? next : task)),
      });
    },
    [updateThread]
  );

  const dropLinkedTask = useCallback(
    (threadId: string, taskId: string) => {
      const thread = useOrionStore.getState().threads.find((t) => t.id === threadId);
      const remaining = (thread?.linkedTasks ?? []).filter((task) => task.id !== taskId);
      if (remaining.length === (thread?.linkedTasks?.length ?? 0)) return;
      updateThread(threadId, {
        linkedTasks: remaining.length > 0 ? remaining : undefined,
      });
    },
    [updateThread]
  );

  // Rename a linked card's id in place (legacy board id → Durango Tasks id).
  const migrateLinkedTaskId = useCallback(
    (threadId: string, fromId: string, toId: string) => {
      const thread = useOrionStore.getState().threads.find((t) => t.id === threadId);
      const linkedTasks = thread?.linkedTasks;
      if (!linkedTasks?.some((task) => task.id === fromId)) return;
      updateThread(threadId, {
        linkedTasks: linkedTasks.some((task) => task.id === toId)
          ? linkedTasks.filter((task) => task.id !== fromId)
          : linkedTasks.map((task) => (task.id === fromId ? { ...task, id: toId } : task)),
      });
    },
    [updateThread]
  );

  // Push a status to the thread's injected cards by default, or just `taskIds`
  // when the action targets one chip (e.g. "mark done"). Pending cards have
  // not been sent to the agent and must not inherit the active run's lifecycle.
  const pushLinkedTaskStatus = useCallback(
    (threadId: string, status: 'running' | 'finished' | 'done' | 'error', notes?: string, taskIds?: string[]) => {
      const thread = useOrionStore.getState().threads.find((t) => t.id === threadId);
      const linkedTasks = thread?.linkedTasks ?? [];
      const targets = taskIds
        ? linkedTasks.filter((task) => taskIds.includes(task.id))
        : linkedTasks.filter((task) => task.injected);
      if (targets.length === 0 || !window.orion?.updateBoardTaskThreadStatus) return;
      const targetIds = new Set(targets.map((task) => task.id));
      updateThread(threadId, {
        linkedTasks: linkedTasks.map((task) => (targetIds.has(task.id) ? { ...task, lastStatus: status } : task)),
      });
      for (const linked of targets) {
        void window.orion
          .updateBoardTaskThreadStatus({
            taskId: linked.id,
            threadId,
            status,
            notes,
          })
          .then((result) => {
            if (result.ok) {
              // Durango Tasks resolves pre-migration board ids but always
              // answers with the task's Durango id: adopt it.
              const nextId = result.task?.id;
              if (nextId && nextId !== linked.id) migrateLinkedTaskId(threadId, linked.id, nextId);
              return;
            }
            if (!result.stale) return;
            // The card was unlinked or relinked on the web — drop our side.
            dropLinkedTask(threadId, linked.id);
          })
          .catch(() => {});
      }
    },
    [dropLinkedTask, migrateLinkedTaskId, updateThread]
  );

  // Desktop notification when a thread finishes. Suppressed while the user is
  // already looking at that thread in any visible pane. Sound rides on the OS
  // notification via `silent`, so there is no separate audio path to keep in
  // sync.
  const notifyThreadFinished = useCallback((threadId: string, outcome: 'done' | 'error') => {
    const state = useOrionStore.getState();
    const settings = {
      ...defaultNotificationSettings,
      ...state.notificationSettings,
    };
    if (!settings.enabled) return;
    if (
      document.hasFocus() &&
      isAgentsPanelVisible(state) &&
      state.paneThreadIds.includes(threadId)
    ) {
      return;
    }
    if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;
    const thread = state.threads.find((t) => t.id === threadId);
    const notification = new Notification(outcome === 'error' ? 'Agent stopped with an error' : 'Agent finished', {
      body: thread?.title?.trim() || 'Agent thread',
      silent: !settings.sound,
      tag: `thread-finished-${threadId}`,
    });
    notification.onclick = () => {
      window.orion?.focusWindow?.().catch(() => {});
      const store = useOrionStore.getState();
      store.setActiveTab('agents');
      store.selectThread(threadId);
    };
  }, []);

  // Embedded terminals do not emit agent-run events, so mirror their prompt
  // and process lifecycle into the persisted thread/board state explicitly.
  useEffect(() => {
    if (!window.orion?.onTerminalActivity || !window.orion?.onTerminalExit) return undefined;
    const offActivity = window.orion.onTerminalActivity((event) => {
      const thread = useOrionStore.getState().threads.find((t) => t.id === event.threadId);
      if (!thread || thread.modelId !== claudeCodeCliModelId) return;
      if (event.kind === 'turn-complete') {
        // Claude's Stop hook fired: the turn is done even though the TUI (and
        // its PTY) stay alive waiting for the next prompt.
        if (thread.status !== 'running') return;
        updateThread(event.threadId, {
          status: 'done',
          terminalActivityAt: new Date().toISOString(),
        });
        notifyThreadFinished(event.threadId, 'done');
        const stillRunning = (thread.linkedTasks ?? []).filter((task) => task.lastStatus === 'running');
        if (stillRunning.length > 0) {
          pushLinkedTaskStatus(
            event.threadId,
            'finished',
            undefined,
            stillRunning.map((task) => task.id)
          );
        }
        return;
      }
      if (event.kind === 'started') {
        // A freshly spawned/reattached TUI is idle at its prompt — record the
        // activity for recency ordering but leave the run status alone.
        if (thread.status !== 'running') {
          updateThread(event.threadId, {
            terminalActivityAt: new Date().toISOString(),
          });
        }
        return;
      }
      updateThread(event.threadId, {
        status: 'running',
        terminalActivityAt: new Date().toISOString(),
      });
      if (event.kind === 'prompt') {
        const notRunning = (thread.linkedTasks ?? []).filter((task) => task.injected && task.lastStatus !== 'running');
        if (notRunning.length > 0) {
          pushLinkedTaskStatus(
            event.threadId,
            'running',
            undefined,
            notRunning.map((task) => task.id)
          );
        }
      }
    });
    const offExit = window.orion.onTerminalExit((event) => {
      const thread = useOrionStore.getState().threads.find((t) => t.id === event.threadId);
      if (!thread || thread.modelId !== claudeCodeCliModelId) return;
      const failed = event.exitCode != null && event.exitCode !== 0;
      updateThread(event.threadId, {
        status: failed ? 'error' : 'done',
        terminalActivityAt: new Date().toISOString(),
      });
      if (thread.status === 'running') {
        notifyThreadFinished(event.threadId, failed ? 'error' : 'done');
      }
      if (thread.linkedTasks?.length) {
        pushLinkedTaskStatus(event.threadId, failed ? 'error' : 'finished');
      }
    });
    return () => {
      offActivity?.();
      offExit?.();
    };
  }, [notifyThreadFinished, pushLinkedTaskStatus, updateThread]);

  const unlinkTaskFromThread = useCallback(
    async (threadId: string, taskId: string): Promise<boolean> => {
      const thread = useOrionStore.getState().threads.find((t) => t.id === threadId);
      if (!thread?.linkedTasks?.some((task) => task.id === taskId)) return true;

      const key = `${threadId}:${taskId}`;
      const existing = linkedTaskUnlinksRef.current.get(key);
      if (existing) return existing;

      const unlink = (async () => {
        if (!window.orion?.unlinkBoardTask) {
          toast.error('Durango Tasks are unavailable in this build.');
          return false;
        }
        try {
          const result = await window.orion.unlinkBoardTask({
            taskId,
            threadId,
          });
          if (!result.ok && !result.stale) {
            toast.error(result.error ?? 'Could not unlink the task');
            return false;
          }
          dropLinkedTask(threadId, taskId);
          return true;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Could not unlink the task');
          return false;
        }
      })();
      linkedTaskUnlinksRef.current.set(key, unlink);
      try {
        return await unlink;
      } finally {
        if (linkedTaskUnlinksRef.current.get(key) === unlink) {
          linkedTaskUnlinksRef.current.delete(key);
        }
      }
    },
    [dropLinkedTask]
  );

  const markLinkedTaskDone = useCallback(
    (threadId: string, taskId: string) => {
      pushLinkedTaskStatus(threadId, 'done', undefined, [taskId]);
      toast.success('Task moved to Done in Durango Tasks');
    },
    [pushLinkedTaskStatus]
  );

  // Picking a task in the popover links it; picking one that is already linked
  // unlinks it, so the popover doubles as the multi-select list.
  const toggleTaskOnSelectedThread = useCallback(
    async (task: OrionBoardTask) => {
      const state = useOrionStore.getState();
      const thread = state.threads.find((t) => t.id === state.selectedThreadId);
      if (!thread) return;
      const linkedTasks = thread.linkedTasks ?? [];
      // Threads linked before the Durango Tasks switch hold the task's old
      // board id (Durango returns it as `legacyId`).
      const alreadyLinked = linkedTasks.find(
        (linked) => linked.id === task.id || (task.legacyId != null && linked.id === task.legacyId)
      );
      if (alreadyLinked) {
        await unlinkTaskFromThread(thread.id, alreadyLinked.id);
        return;
      }
      if (!window.orion?.linkBoardTask) return;
      const project = findProjectById(state, thread.projectId);
      // A fresh, untitled thread adopts the first task's title.
      const adoptTitle = linkedTasks.length === 0 && thread.summary.messageCount === 0 && isDefaultTitle(thread.title);

      const result = await window.orion.linkBoardTask({
        taskId: task.id,
        threadId: thread.id,
        threadTitle: adoptTitle ? task.title : thread.title,
        projectName: project?.name,
      });
      if (!result.ok) {
        toast.error(result.error ?? 'Could not link the task');
        return;
      }
      const linkedTask = linkedTaskFromBoardTask(result.task ?? task);
      // Re-read: the link round-trip is async, so the list may have moved.
      const current = useOrionStore.getState().threads.find((t) => t.id === thread.id)?.linkedTasks ?? [];
      updateThread(thread.id, {
        linkedTasks: current.some((linked) => linked.id === linkedTask.id) ? current : [...current, linkedTask],
        ...(adoptTitle ? { title: task.title } : {}),
      });
      const unavailableCount = linkedTask.attachments?.filter((attachment) => !attachment.path).length ?? 0;
      if (unavailableCount > 0) {
        toast.warning(
          `${unavailableCount} task attachment${unavailableCount === 1 ? '' : 's'} could not be downloaded.`
        );
      }
    },
    [unlinkTaskFromThread, updateThread]
  );

  // Refresh and locally download the linked-task snapshot (and detect web-side
  // unlink or deletion) whenever a thread whose context has not been injected
  // is selected, so the agent gets current text and attachments.
  const refreshLinkedTaskSnapshot = useCallback(
    (threadId: string, linked: LinkedBoardTask): Promise<void> => {
      if (!window.orion?.getBoardTask) return Promise.resolve();

      const key = `${threadId}:${linked.id}`;
      const existing = linkedTaskRefreshesRef.current.get(key);
      if (existing) return existing;

      const refresh = window.orion
        .getBoardTask(linked.id)
        .then((result) => {
          const current = useOrionStore
            .getState()
            .threads.find((thread) => thread.id === threadId)
            ?.linkedTasks?.find((task) => task.id === linked.id);
          if (!current || current.injected) return;

          if (!result.ok) {
            if (result.stale) dropLinkedTask(threadId, linked.id);
            return;
          }

          const fresh = result.task;
          if (!fresh || fresh.linked?.threadId !== threadId) {
            dropLinkedTask(threadId, linked.id);
            return;
          }
          updateLinkedTask(threadId, linked.id, {
            ...linkedTaskFromBoardTask(fresh),
            lastStatus: current.lastStatus,
          });
        })
        .catch(() => {});
      const sharedRefresh = refresh.finally(() => {
        if (linkedTaskRefreshesRef.current.get(key) === sharedRefresh) {
          linkedTaskRefreshesRef.current.delete(key);
        }
      });
      linkedTaskRefreshesRef.current.set(key, sharedRefresh);
      return sharedRefresh;
    },
    [dropLinkedTask, updateLinkedTask]
  );

  const refreshLinkedTasksBeforeDispatch = useCallback(
    async (threadId: string) => {
      const pending = (
        useOrionStore.getState().threads.find((thread) => thread.id === threadId)?.linkedTasks ?? []
      ).filter((task) => !task.injected);
      if (pending.length === 0) return;
      await Promise.all(pending.map((task) => refreshLinkedTaskSnapshot(threadId, task)));
    },
    [refreshLinkedTaskSnapshot]
  );

  // Cards linked but not yet sent to the agent: the ones the composer shows as
  // removable chips and the next turn will inject.
  const pendingLinkedTasks = useMemo(
    () => (selectedThread?.linkedTasks ?? []).filter((task) => !task.injected),
    [selectedThread?.linkedTasks]
  );
  const hasPendingLinkedTasks = pendingLinkedTasks.length > 0;
  // Every card linked to the thread, injected or not — the picker's selection
  // state and the composer's board button read from these.
  const linkedTaskIds = useMemo(
    () => (selectedThread?.linkedTasks ?? []).map((task) => task.id),
    [selectedThread?.linkedTasks]
  );
  const linkedTasksLabel = selectedThread?.linkedTasks?.length
    ? `Linked ${selectedThread.linkedTasks.length === 1 ? 'task' : 'tasks'}: ${selectedThread.linkedTasks
        .map((task) => task.title)
        .join(', ')}`
    : 'Link tasks from Durango Tasks';
  // Signature of that set, so selecting a thread re-refreshes only when it
  // actually changed (not on every status push).
  const pendingLinkedTaskKey = pendingLinkedTasks.map((task) => task.id).join(':');

  useEffect(() => {
    const threadId = selectedThread?.id;
    if (!threadId || !pendingLinkedTaskKey) return;
    void refreshLinkedTasksBeforeDispatch(threadId);
  }, [selectedThread?.id, pendingLinkedTaskKey, refreshLinkedTasksBeforeDispatch]);

  const flushChunkBuffers = useCallback(() => {
    if (chunkFlushTimer.current !== null) {
      window.clearTimeout(chunkFlushTimer.current);
      chunkFlushTimer.current = null;
    }
    if (chunkBuffers.current.size === 0) return;
    const buffered = Array.from(chunkBuffers.current.values());
    chunkBuffers.current.clear();
    for (const { threadId, messageId, text } of buffered) {
      if (text) appendToThreadMessage(threadId, messageId, text);
    }
  }, [appendToThreadMessage]);

  useEffect(() => {
    if (!window.orion?.onAgentTurnEvent) return undefined;
    type AgentTurnEvent = Parameters<Parameters<NonNullable<typeof window.orion.onAgentTurnEvent>>[0]>[0];
    const handleEvent = (event: AgentTurnEvent) => {
      if (event.type === 'prompt-suggestion') {
        const suggestion = event.suggestion?.trim();
        if (
          event.threadId &&
          suggestion &&
          latestStartedRunByThread.current.get(event.threadId) === event.runId
        ) {
          setPromptSuggestions((current) => ({ ...current, [event.threadId]: suggestion }));
        }
        return;
      }
      // Any new turn on the thread makes its suggestion stale.
      if (event.type === 'started' && event.threadId) {
        latestStartedRunByThread.current.set(event.threadId, event.runId);
        setPromptSuggestions((current) => {
          if (!(event.threadId in current)) return current;
          const { [event.threadId]: _stale, ...rest } = current;
          return rest;
        });
      }
      // `/btw` aside runs stream into their exchange, not the transcript.
      // Their `session` events are deliberately dropped: the fork's id must
      // never replace the thread's real session id.
      const btwRun = btwRuns.current.get(event.runId);
      if (btwRun) {
        if (event.type === 'chunk' && event.chunk) {
          appendToBtwExchange(btwRun.threadId, btwRun.exchangeId, event.chunk);
        }
        if (event.type === 'done') {
          updateBtwExchange(btwRun.threadId, btwRun.exchangeId, {
            status: 'done',
            completedAt: new Date().toISOString(),
          });
          btwRuns.current.delete(event.runId);
        }
        if (event.type === 'error') {
          // Same logged-out detection as transcript turns: the aside's answer
          // tail carries the CLI's stderr text.
          const asideAnswerTail =
            useOrionStore
              .getState()
              .transcripts[btwRun.threadId]?.btwExchanges?.find((exchange) => exchange.id === btwRun.exchangeId)
              ?.answer.slice(-1200) ?? '';
          const asideLoggedOut = isProviderAuthErrorText(event.error) || isProviderAuthErrorText(asideAnswerTail);
          updateBtwExchange(btwRun.threadId, btwRun.exchangeId, {
            status: 'error',
            completedAt: new Date().toISOString(),
            error: event.error,
            authProviderId: asideLoggedOut && event.providerId !== 'orion' ? event.providerId : undefined,
          });
          btwRuns.current.delete(event.runId);
        }
        return;
      }

      // Goal state belongs to the thread, not to the transcript message. Stop
      // deliberately untracks a run before IPC so late text/result events
      // cannot rewrite the stopped message; the persisted paused-goal update
      // must still land after that untracking.
      if (event.type === 'goal') {
        updateThread(event.threadId, { goal: event.goal ?? null });
        return;
      }

      // A Claude session's background work settled with no re-invocation
      // coming (task killed/failed, notification suppressed, or the session
      // itself was disposed). Resolve any monitor card even when its turn was
      // already done; only the awaited-agent path needs a thread transition.
      if (event.type === 'background-settled') {
        const retainedRunId = activeRunsByThreadRef.current[event.threadId];
        // A mapping without a tracked output message is the retained
        // background-session handle. A mapping with one is a genuine live
        // foreground turn, which this stale settle event must not finish.
        if (retainedRunId && runOutputMessages.current.has(retainedRunId)) return;
        // runOutputMessages updates synchronously when a run starts, so it
        // also covers the render tick before activeRunsByThreadRef syncs.
        for (const run of runOutputMessages.current.values()) {
          if (run.threadId === event.threadId) return;
        }
        if (retainedRunId) clearActiveRun(retainedRunId);
        const thread = useOrionStore.getState().threads.find((t) => t.id === event.threadId);
        if (!thread) return;
        const threadMessages = loadedMessages(thread.id) ?? [];
        for (const message of threadMessages) {
          const intervention = message.claudeBackgroundIntervention;
          if (
            message.kind !== 'claude-background-intervention' ||
            !intervention ||
            (intervention.status !== 'pending' && intervention.status !== 'stopping')
          ) {
            continue;
          }
          updateThreadMessage(thread.id, message.id, {
            claudeBackgroundIntervention: {
              ...intervention,
              status: intervention.status === 'stopping' ? 'stopped' : 'settled',
              error: undefined,
            },
          });
        }
        if (thread.status !== 'running') return;
        const lastRun = [...threadMessages].reverse().find((m) => m.kind === 'agent-run');
        updateThread(event.threadId, { status: 'done' });
        notifyThreadFinished(event.threadId, 'done');
        pushLinkedTaskStatus(event.threadId, 'finished', lastRun?.content.trim() || undefined);
        if (lastRun && lastRun.status === 'done') {
          updateThreadMessage(event.threadId, lastRun.id, {
            statusText: 'Finished.',
          });
        }
        return;
      }

      // Provider-native subagents (claude Agent tool, codex collaboration
      // spawns, cursor Task tool, grok spawn_subagent): main tails each
      // subagent's on-disk transcript and streams it here. Every subagent
      // becomes a hidden child thread of the run's thread, so the agents
      // switcher can flip between main and subagents uniformly.
      if (
        (event.type === 'subagent' && event.subagent) ||
        ((event.type === 'subagent-chunk' || event.type === 'subagent-activity') && event.subagentId)
      ) {
        const info = event.type === 'subagent' ? event.subagent : undefined;
        const subagentId = info?.id ?? event.subagentId;
        if (!subagentId) return;
        const state = useOrionStore.getState();
        const runThread = findThread(state.threads, event.threadId);
        if (!runThread) return;
        const providerId = (info?.providerId ?? event.providerId ?? runThread.modelId.split(':')[0]) as ProviderId;
        const reportedNativeModelId = qualifyProviderModelId(providerId, info?.model);
        const key = `${event.threadId}:${providerId}:${subagentId}`;
        let target = nativeSubagentTargets.current.get(key) ?? null;
        // Streamed output for a subagent that has no thread (and no info to
        // make one) is dropped as before; don't search for it on every chunk.
        if (!target && !info && unboundNativeSubagents.current.has(key)) return;
        // The rest is for a subagent seen for the first time (or rebound after
        // a reload), not for every streamed chunk: whole-thread scans happen
        // only on that rare path.
        let familyThreadIds: Set<string> | null = null;
        const findFamilySubagent = (providerSubagentId: string) => {
          familyThreadIds ??= descendantThreadIds(state.threads, runThread.id);
          const family = familyThreadIds;
          return state.threads.find(
            (thread) =>
              family.has(thread.id) &&
              thread.subagent?.providerId === providerId &&
              thread.subagent.id === providerSubagentId
          );
        };
        const nativeModelIdFor = () => {
          if (reportedNativeModelId) return reportedNativeModelId;
          const trackedRun = runOutputMessages.current.get(event.runId);
          return dispatchedModelIdForProvider(
            runThread,
            providerId,
            trackedRun?.threadId === runThread.id ? trackedRun.messageId : undefined
          );
        };

        // Rebind after an app reload: the child thread persists, the ref map
        // doesn't. Search the run's descendants for nested agents, but keep
        // provider-local ids inside this run's thread family.
        if (!target) {
          const existing = findFamilySubagent(subagentId);
          // The shell knows the child's last run without loading it; its
          // events load it (store actions wait for the transcript).
          const lastRun = existing?.summary.lastAgentRun;
          if (existing && lastRun) {
            target = { threadId: existing.id, messageId: lastRun.id };
            nativeSubagentTargets.current.set(key, target);
          }
        }

        if (!target && info) {
          // A subagent can spawn its own subagents (codex collaboration
          // spawns). Hang it off the spawning subagent's thread when main
          // reports one, so the switcher shows the real tree instead of
          // flattening every descendant onto the run's thread.
          const parent = (info.parentSubagentId && findFamilySubagent(info.parentSubagentId)) || runThread;
          const nativeModelId = nativeModelIdFor();
          const childThreadId = state.createThread(parent.projectId, info.title || info.kind || 'Subagent', {
            parentThreadId: parent.id,
            modelId: nativeModelId ?? parent.modelId,
            hiddenFromRecent: true,
            accessMode: parent.accessMode,
            select: false,
            subagent: {
              id: subagentId,
              providerId,
              kind: info.kind,
              model: info.model,
              prompt: info.prompt,
            },
          });
          if (info.prompt) {
            addMessageToThread(childThreadId, {
              role: 'user',
              content: info.prompt,
            });
          }
          const messageId = addMessageToThread(childThreadId, {
            role: 'agent',
            content: '',
            kind: 'agent-run',
            status: 'running',
            statusText: 'Subagent working…',
            startedAt: new Date(info.startedAt ?? Date.now()).toISOString(),
            activities: [],
            ...(nativeModelId ? { modelId: nativeModelId } : {}),
          });
          updateThread(childThreadId, { status: 'running' });
          target = { threadId: childThreadId, messageId };
          nativeSubagentTargets.current.set(key, target);
        }
        if (!target) {
          unboundNativeSubagents.current.add(key);
          return;
        }
        unboundNativeSubagents.current.delete(key);

        if (event.type === 'subagent-chunk' && event.chunk) {
          // Same buffered flush as main-run chunks: subagent transcripts tail
          // per-line and a mounted child transcript pays the same O(content)
          // render cost per update as the main one.
          const bufferKey = `sub:${target.threadId}:${target.messageId}`;
          let buffer = chunkBuffers.current.get(bufferKey);
          if (buffer) {
            buffer.text += event.chunk;
          } else {
            buffer = {
              threadId: target.threadId,
              messageId: target.messageId,
              text: event.chunk,
              baseLen:
                loadedMessages(target.threadId)?.find((m) => m.id === target.messageId)?.content.length ?? 0,
            };
            chunkBuffers.current.set(bufferKey, buffer);
          }
          if (chunkFlushTimer.current === null) {
            chunkFlushTimer.current = window.setTimeout(
              flushChunkBuffers,
              chunkFlushDelay(buffer.baseLen + buffer.text.length)
            );
          }
        } else if (event.type === 'subagent-activity' && event.activity) {
          addActivityToThreadMessage(target.threadId, target.messageId, event.activity);
        } else if (info) {
          const fresh = useOrionStore.getState();
          const childThread = fresh.threads.find((t) => t.id === target.threadId);
          if (childThread) {
            const threadPatch: Partial<Thread> = {};
            if (
              childThread.subagent &&
              (info.model || info.reasoningEffort || info.prompt || info.summary)
            ) {
              threadPatch.subagent = {
                ...childThread.subagent,
                ...(info.model ? { model: info.model } : {}),
                ...(info.reasoningEffort ? { reasoningEffort: info.reasoningEffort } : {}),
                ...(info.prompt ? { prompt: info.prompt } : {}),
                ...(info.summary ? { summary: info.summary } : {}),
              };
            }
            const settingsModelId = reportedNativeModelId ?? childThread.modelId;
            const reportedModel = agentModelsRef.current.find(
              (model) => model.id === settingsModelId && model.providerId === providerId
            );
            Object.assign(
              threadPatch,
              reportedSubagentSettingsPatch(
                childThread,
                reportedModel,
                reportedNativeModelId,
                info.reasoningEffort
              ) as Partial<Thread>
            );
            if (threadPatch.modelId) {
              updateThreadMessage(target.threadId, target.messageId, {
                modelId: threadPatch.modelId,
              });
            }
            if (Object.keys(threadPatch).length > 0) {
              updateThread(target.threadId, threadPatch);
            }
          }
          // A late-arriving prompt (codex delivers it inside the rollout)
          // fills in the transcript's opening user bubble.
          if (childThread && info.prompt && !childThread.summary.hasUserMessage) {
            const prompt = info.prompt;
            useOrionStore.getState().updateThreadTranscript(target.threadId, (transcript) =>
              transcript.messages.some((m) => m.role === 'user')
                ? transcript
                : {
                    ...transcript,
                    messages: [
                      {
                        id: crypto.randomUUID(),
                        role: 'user',
                        content: prompt,
                        ts: transcript.messages[0]?.ts ?? new Date().toISOString(),
                      },
                      ...transcript.messages,
                    ],
                  }
            );
          }
          if (info.status && info.status !== 'running') {
            const failed = info.status === 'error';
            const stopped = info.status === 'stopped';
            updateThreadMessage(target.threadId, target.messageId, {
              status: stopped ? 'stopped' : failed ? 'error' : 'done',
              completedAt: new Date(info.completedAt ?? Date.now()).toISOString(),
              statusText: stopped ? 'Stopped by user.' : failed ? 'The subagent stopped with an error.' : 'Finished.',
              ...(info.stats?.totalTokens ? { stats: { totalTokens: info.stats.totalTokens } } : {}),
            });
            updateThread(target.threadId, {
              status: stopped ? 'idle' : failed ? 'error' : 'done',
            });
          }
        }
        return;
      }

      const tracked = runOutputMessages.current.get(event.runId);
      if (!tracked) {
        // A persistent claude session can start a turn on its own when a
        // background subagent finishes (task notification re-invokes the
        // model). Grow the transcript with a fresh agent message for it.
        if (event.type === 'started' && event.background) {
          const thread = useOrionStore.getState().threads.find((t) => t.id === event.threadId);
          if (!thread) return;
          for (const message of loadedMessages(thread.id) ?? []) {
            const intervention = message.claudeBackgroundIntervention;
            if (
              message.kind === 'claude-background-intervention' &&
              intervention?.status === 'pending'
            ) {
              updateThreadMessage(thread.id, message.id, {
                claudeBackgroundIntervention: {
                  ...intervention,
                  status: 'settled',
                  error: undefined,
                },
              });
            }
          }
          const backgroundModelId =
            dispatchedModelIdForProvider(thread, 'claude') ??
            agentModelsRef.current.find(
              (model) =>
                model.providerId === 'claude' &&
                Boolean(event.command?.includes(`--model ${model.slug}`))
            )?.id;
          const messageId = addMessageToThread(event.threadId, {
            role: 'agent',
            content: '',
            kind: 'agent-run',
            status: 'running',
            statusText: 'Continuing background work.',
            command: event.command,
            startedAt: new Date().toISOString(),
            activities: [],
            ...(backgroundModelId ? { modelId: backgroundModelId } : {}),
          });
          runOutputMessages.current.set(event.runId, {
            threadId: event.threadId,
            messageId,
          });
          setActiveRunsByThread((current) => ({
            ...current,
            [event.threadId]: event.runId,
          }));
          updateThread(event.threadId, { status: 'running' });
          pushLinkedTaskStatus(event.threadId, 'running');
        }
        return;
      }

      if (event.type === 'started') {
        updateThreadMessage(tracked.threadId, tracked.messageId, {
          kind: 'agent-run',
          status: 'running',
          statusText: "I'm working on this now.",
          command: event.command,
          startedAt: new Date().toISOString(),
        });
      }

      if (event.type === 'activity' && event.activity) {
        // Flush buffered text first so the activity anchors after the text
        // that streamed before it (contentOffset), not before it.
        flushChunkBuffers();
        addActivityToThreadMessage(tracked.threadId, tracked.messageId, event.activity);
        if (event.activity.status === 'done' || event.activity.exitCode !== undefined) {
          // A keyed update may carry only the result; the command is on the row.
          const { key } = event.activity;
          const merged = key
            ? loadedMessages(tracked.threadId)
                ?.find((message) => message.id === tracked.messageId)
                ?.activities?.find((activity) => activity.key === key)
            : undefined;
          if (activityRanWorkspaceCommand(merged ?? event.activity)) {
            void syncAgentWorkspace(tracked.threadId, tracked.messageId, false);
          }
        }
      }

      if (event.type === 'session' && event.sessionId && event.providerId) {
        setThreadAgentSession(tracked.threadId, event.providerId as ProviderId, event.sessionId);
      }

      if (event.type === 'chunk' && event.chunk) {
        let buffer = chunkBuffers.current.get(event.runId);
        if (buffer) {
          buffer.text += event.chunk;
        } else {
          buffer = {
            threadId: tracked.threadId,
            messageId: tracked.messageId,
            text: event.chunk,
            baseLen:
              loadedMessages(tracked.threadId)?.find((m) => m.id === tracked.messageId)?.content.length ?? 0,
          };
          chunkBuffers.current.set(event.runId, buffer);
        }
        if (chunkFlushTimer.current === null) {
          chunkFlushTimer.current = window.setTimeout(
            flushChunkBuffers,
            chunkFlushDelay(buffer.baseLen + buffer.text.length)
          );
        }
      }

      if (event.type === 'done') {
        flushChunkBuffers();
        // Agents/workflows can re-invoke Claude and keep the thread working.
        // Shell-only work follows Claude Code's monitor semantics: the turn is
        // finished, but the process remains visible and explicitly stoppable.
        const waitingOn = event.pendingBackgroundTasks ?? [];
        const waiting = waitingOn.length > 0;
        const discardableShellTasks = event.pendingBackgroundShellTasks ?? [];
        updateThreadMessage(tracked.threadId, tracked.messageId, {
          status: 'done',
          completedAt: new Date().toISOString(),
          statusText: waiting
            ? waitingOnBackgroundStatusText(waitingOn)
            : (waitingOnUserStatusText(tracked.threadId) ?? 'Finished.'),
          changedFiles: event.changedFiles ?? [],
          ...(event.stats ? { stats: event.stats } : {}),
        });
        void syncAgentWorkspace(tracked.threadId, tracked.messageId, true);
        if (discardableShellTasks.length > 0) {
          const content = `Left running in the background: ${discardableShellTasks.join('; ')}`;
          const existingMonitor = [...(loadedMessages(tracked.threadId) ?? [])]
            .reverse()
            .find(
              (message) =>
                message.kind === 'claude-background-intervention' &&
                message.claudeBackgroundIntervention?.status === 'pending'
            );
          if (existingMonitor?.claudeBackgroundIntervention) {
            updateThreadMessage(tracked.threadId, existingMonitor.id, {
              content,
              claudeBackgroundIntervention: {
                ...existingMonitor.claudeBackgroundIntervention,
                runId: event.runId,
                tasks: discardableShellTasks,
                status: 'pending',
                error: undefined,
              },
            });
          } else {
            addMessageToThread(tracked.threadId, {
              role: 'system',
              kind: 'claude-background-intervention',
              content,
              claudeBackgroundIntervention: {
                runId: event.runId,
                tasks: discardableShellTasks,
                status: 'pending',
              },
            });
          }
        }
        if (waiting) {
          updateThread(tracked.threadId, { status: 'running' });
          // The thread stays 'running', so the count-based tree refresh
          // can't see this turn's completion — tick it explicitly so the
          // files the foreground turn wrote surface in the Code tree.
          setTreeTurnRefreshTick((t) => t + 1);
        } else {
          updateThread(tracked.threadId, { status: 'done' });
          notifyThreadFinished(tracked.threadId, 'done');
          // A successful end means the in-flight checklist task is finished
          // even if the agent never sent the closing update — stop the spinner
          // and let the widget read n/n instead of "ended mid-task".
          useOrionStore
            .getState()
            .completeInProgressPlanEntries(tracked.threadId, tracked.messageId);
          // Turn finished — surface the work on the board (In Review column)
          // with the response the user sees in this completed agent message.
          const finalResponse = loadedMessages(tracked.threadId)
            ?.find((message) => message.id === tracked.messageId)
            ?.content.trim();
          pushLinkedTaskStatus(tracked.threadId, 'finished', finalResponse || undefined);
        }
        runOutputMessages.current.delete(event.runId);
        // Awaited agents keep the run mapping so Stop/queue UI remains active.
        // Shell monitors use the intervention card's run id directly and do
        // not make the completed turn look active.
        if (!waiting) clearActiveRun(event.runId);
      }

      if (event.type === 'error') {
        flushChunkBuffers();
        if (event.error) {
          appendToThreadMessage(tracked.threadId, tracked.messageId, `\n\n${event.error}`);
        }
        // A logged-out provider CLI surfaces as a turn error. Recognize it —
        // in the terminal error text or in the tail of the streamed output,
        // where stderr lands — and mark the message so the transcript offers
        // an Authenticate button instead of a dead-end error.
        const errorThread = useOrionStore.getState().threads.find((thread) => thread.id === tracked.threadId);
        const contentTail =
          loadedMessages(tracked.threadId)?.find((message) => message.id === tracked.messageId)?.content.slice(-1200) ?? '';
        const looksLoggedOut = isProviderAuthErrorText(event.error) || isProviderAuthErrorText(contentTail);
        const rawAuthProviderId = looksLoggedOut ? (event.providerId ?? errorThread?.modelId.split(':')[0]) : undefined;
        // The Orion pseudo-provider has no CLI of its own to authenticate.
        const authProviderId = rawAuthProviderId === 'orion' ? undefined : rawAuthProviderId;
        updateThreadMessage(tracked.threadId, tracked.messageId, {
          status: 'error',
          completedAt: new Date().toISOString(),
          statusText: authProviderId ? 'The agent is logged out.' : 'The agent stopped with an error.',
          error: event.error,
          authProviderId,
          changedFiles: event.changedFiles ?? [],
        });
        updateThread(tracked.threadId, { status: 'error' });
        notifyThreadFinished(tracked.threadId, 'error');
        pushLinkedTaskStatus(tracked.threadId, 'error');
        runOutputMessages.current.delete(event.runId);
        clearActiveRun(event.runId);
      }
    };

    // The handler reads the transcript of the event's thread. When that
    // thread's transcript isn't loaded (a background session's turn on a
    // thread nobody has open), its events wait, in order, until it is: none
    // is dropped or handled against a missing transcript.
    const waitingForTranscript = new Map<string, AgentTurnEvent[]>();
    const unsubscribe = window.orion.onAgentTurnEvent((event) => {
      const threadId = event.threadId;
      const waiting = threadId ? waitingForTranscript.get(threadId) : undefined;
      if (waiting) {
        waiting.push(event);
        return;
      }
      const state = useOrionStore.getState();
      if (threadId && !state.transcripts[threadId] && findThread(state.threads, threadId)) {
        waitingForTranscript.set(threadId, [event]);
        void ensureThreadTranscript(threadId)
          .catch((error) => console.warn('Could not load the transcript of a thread with agent events', error))
          .finally(() => {
            const events = waitingForTranscript.get(threadId) ?? [];
            waitingForTranscript.delete(threadId);
            for (const queued of events) handleEvent(queued);
          });
        return;
      }
      handleEvent(event);
    });

    return () => {
      unsubscribe?.();
      flushChunkBuffers();
    };
  }, [
    addActivityToThreadMessage,
    addMessageToThread,
    appendToThreadMessage,
    appendToBtwExchange,
    clearActiveRun,
    flushChunkBuffers,
    notifyThreadFinished,
    pushLinkedTaskStatus,
    setThreadAgentSession,
    updateBtwExchange,
    updateThread,
    updateThreadMessage,
  ]);

  // Runs and /btw asides the previous session left going are cleaned up
  // when their transcript loads (store.ts restoreTranscriptFromPreviousRun).

  // Resolve (and create) the scratch directory No project agents run in.
  useEffect(() => {
    let cancelled = false;
    let started = false;
    let unsubscribeHydration = () => {};
    const prepare = () => {
      unsubscribeHydration();
      if (cancelled || started) return;
      started = true;
      window.orion
        ?.getNoProjectDir?.()
        .then((dir) => {
          if (!cancelled && dir) setNoProjectPath(dir);
        })
        .catch((error) => console.error('Could not prepare the No project directory', error));
    };
    // This store mutation also schedules persistence. Wait for the real
    // projects/settings before saving, including when transcript loading is slow.
    if (useOrionStore.persist.hasHydrated()) prepare();
    else {
      unsubscribeHydration = useOrionStore.persist.onFinishHydration(prepare);
      if (useOrionStore.persist.hasHydrated()) prepare();
    }
    return () => {
      cancelled = true;
      unsubscribeHydration();
    };
  }, [setNoProjectPath]);

  // Sync workspace with first project if none set
  useEffect(() => {
    if (!workspacePath && projects.length > 0) {
      setWorkspacePath(projects[0].path);
    }
  }, [workspacePath, projects, setWorkspacePath]);

  // Add a project. Keep this stable because it crosses the memoized transcript
  // boundary and App also renders on every composer edit.
  // Add a project: the folder the user typed in the project picker (`path`,
  // created if missing), or one chosen in the system folder dialog. Keep this
  // stable because it crosses the memoized transcript boundary and App also
  // renders on every composer edit.
  const handleAddProject = useCallback(
    async (options?: { path?: string; createInitialThread?: boolean }) => {
      if (!window.orion || repositoryOperationBusy) return;
      let dir: string | null;
      if (options?.path) {
        const resolved = await window.orion.resolveProjectDirectory?.(options.path, { create: true });
        if (!resolved) return;
        if (!resolved.ok) {
          toast.error('Couldn’t add that folder', { description: resolved.error });
          return;
        }
        if (resolved.created) toast.success(`Created ${resolved.path}`);
        dir = resolved.path;
      } else {
        dir = await window.orion.openDirectory();
      }
      if (!dir) return;
      const folder = dir;

      // Adding a folder that is already a project just switches to it.
      const existing = useOrionStore
        .getState()
        .projects.find((project) => normalizeRepositoryPath(project.path) === normalizeRepositoryPath(folder));
      let projectId: string;
      if (existing) {
        projectId = existing.id;
        selectProject(projectId);
      } else {
        const name = await window.orion.basename(dir);
        projectId = addProject({ name, path: dir });
      }

      // Also set workspace to this project
      setWorkspacePath(dir);

      // Adding a project means the user wants to work in it now — drop them
      // straight into a fresh thread for it unless a caller needs to attach its
      // own thread metadata first.
      if (options?.createInitialThread !== false) createThread(projectId);
      setActiveTab('agents');
      return projectId;
    },
    [addProject, createThread, repositoryOperationBusy, selectProject, setActiveTab, setWorkspacePath]
  );

  // Settings → Skills hands a skill to the Code tab: its folder becomes the
  // explorer root (references/, scripts/ and all) with SKILL.md already open.
  // Deliberately not routed through handleSetActiveTab, which would snap the
  // workspace back to the active thread's working directory.
  const handleOpenSkillInEditor = useCallback(
    async (skill: { path: string; skillFile?: string; name: string }) => {
      if (!window.orion) return;
      if (activeWorkspaceUnavailable) {
        toast.error('Wait for the thread’s Durango workspace to become available');
        return;
      }
      if (!skill?.path) {
        toast.error(`Could not locate ${skill?.name ?? 'that skill'} on disk`);
        return;
      }
      // A main process that predates the skillFile field (main is not
      // hot-reloaded) sends the folder only — derive the file rather than
      // opening an undefined path.
      const separator = skill.path.includes('\\') && !skill.path.includes('/') ? '\\' : '/';
      const skillFile = skill.skillFile || `${skill.path}${separator}SKILL.md`;
      let content: string;
      try {
        content = await window.orion.readFile(skillFile);
      } catch (error) {
        toast.error(`Could not open ${skill.name}/SKILL.md`, {
          description: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      const dirtyFiles = useOrionStore.getState().openFiles.filter((file) => file.isDirty);
      if (
        dirtyFiles.length > 0 &&
        !confirm(
          `Open ${skill.name} and discard unsaved changes in ${dirtyFiles.length} file${dirtyFiles.length === 1 ? '' : 's'}?`
        )
      ) {
        return;
      }
      setWorkspacePath(skill.path);
      closeAllFiles();
      useOrionStore.getState().openFile(skillFile, content);
      setSettingsOpen(false);
      setActiveTab('code');
    },
    [activeWorkspaceUnavailable, closeAllFiles, setActiveTab, setSettingsOpen, setWorkspacePath]
  );

  const handleSetActiveTab = (tab: 'agents' | 'code') => {
    // Open the directory the agents are actually editing: the thread's
    // Durango workspace when it has one, else the project.
    const codeRoot = activeWorkingDir;
    if (tab === 'code' && activeWorkspaceUnavailable) {
      toast.error('Wait for the thread’s Durango workspace to become available');
      return;
    }
    if (tab === 'code' && codeRoot && workspacePath !== codeRoot) {
      setWorkspacePath(codeRoot);
      closeAllFiles();
    }

    setActiveTab(tab);
  };

  const handleNewAgent = () => {
    // Sidebar v2 starts the new agent where the most recent thread ran; the
    // project picker in the new thread changes it.
    const projectId = sidebarV2Enabled
      ? (findProjectById({ projects, noProject }, latestThreadProjectId)?.id ?? defaultNewThreadProject?.id)
      : defaultNewThreadProject?.id;
    if (!projectId) {
      void handleAddProject();
      return;
    }
    openNewAgentIn(projectId);
  };

  // A fresh composer in a project. Sidebar v2 reuses an untouched draft there
  // (nothing sent, nothing typed) rather than stacking empty threads at the
  // top of the flat list.
  const openNewAgentIn = (projectId: string) => {
    if (sidebarV2Enabled) {
      const draft = useOrionStore
        .getState()
        .threads.find(
          (thread) =>
            thread.projectId === projectId &&
            thread.summary.messageCount === 0 &&
            thread.status !== 'running' &&
            // Another machine's thread is never a draft here.
            !thread.remote?.threadId &&
            thread.modelId !== claudeCodeCliModelId &&
            !thread.parentThreadId &&
            !thread.subagent &&
            !thread.settledAt &&
            !thread.snoozedAt &&
            !hasComposerDraft(thread.id)
        );
      if (draft) {
        // Restamp it as new: Recent ranks an empty thread by createdAt, so a
        // draft left from hours ago would otherwise open below newer threads.
        const now = new Date();
        updateThread(draft.id, {
          createdAt: now.toISOString(),
          ...(isDefaultTitle(draft.title)
            ? { title: `Thread ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` }
            : {}),
        });
        selectThread(draft.id);
        setActiveTab('agents');
        return;
      }
    }

    handleCreateThread(projectId);
  };

  const handleChangeSelectedThreadProject = useCallback(
    (projectId: string) => {
      if (repositoryOperationBusy) return;
      const project = findProjectById(useOrionStore.getState(), projectId);
      if (!project) return;

      // Read the thread at call time instead of depending on the Thread
      // object: its identity churns with every shell-signature change, and a
      // churning callback would break ChatTranscript's memo boundary.
      const thread = useOrionStore.getState().threads.find((candidate) => candidate.id === selectedThreadId);
      if (!thread) {
        selectProject(projectId);
        setProjectPickerOpen(false);
        return;
      }

      if (thread.durangoWorkspace || workspaceSetupThreadIdsRef.current.has(thread.id)) {
        toast.error('Threads in a Durango workspace stay bound to their project');
        setProjectPickerOpen(false);
        return;
      }
      if (!canChangeSelectedThreadProject) {
        toast.error('Project can only be changed before the agent runs in this thread');
        setProjectPickerOpen(false);
        return;
      }

      updateThread(thread.id, { projectId });
      selectProject(projectId);
      setProjectPickerOpen(false);
    },
    [canChangeSelectedThreadProject, repositoryOperationBusy, selectProject, selectedThreadId, updateThread]
  );

  const handleCheckoutBranch = async (branchName: string) => {
    if (!activeWorkingDir || !window.orion?.checkoutGitBranch || repositoryOperationBusy) return;
    if (gitState?.hasUncommittedChanges) {
      toast.error('Commit or discard local changes before checking out another branch');
      return;
    }

    setGitBusy(true);
    try {
      const result = await window.orion.checkoutGitBranch({
        projectPath: activeWorkingDir,
        branchName,
      });
      if (result.ok) {
        toast.success(`Checked out ${branchName}`);
        setBranchPickerOpen(false);
        await refreshGitState();
      } else {
        toast.error(result.error ?? `Could not check out ${branchName}`);
      }
    } finally {
      setGitBusy(false);
    }
  };

  const handleCreateBranch = async (branchName: string) => {
    if (!activeWorkingDir || !window.orion?.checkoutGitBranch || repositoryOperationBusy) return;

    const normalized = branchName.trim();
    if (!normalized) return;

    setGitBusy(true);
    try {
      const result = await window.orion.checkoutGitBranch({
        projectPath: activeWorkingDir,
        branchName: normalized,
        create: true,
      });
      if (result.ok) {
        toast.success(`Created ${normalized}`);
        setBranchPickerOpen(false);
        await refreshGitState();
      } else {
        toast.error(result.error ?? `Could not create ${normalized}`);
      }
    } finally {
      setGitBusy(false);
    }
  };

  const handleCommitAndPush = async () => {
    if (!activeWorkingDir || !window.orion?.commitAndPush || repositoryOperationBusy) return;

    setGitBusy(true);
    try {
      const result = await window.orion.commitAndPush({
        projectPath: activeWorkingDir,
        // The text-generation model, so navbar commits get a
        // written message instead of "Update 5 files".
        ...resolveUtilityTurn(),
      });
      if (result.ok) {
        const branch = result.branch ?? gitState?.currentBranch ?? 'branch';
        if (result.alreadyUpToDate) {
          toast.info(`Already up to date on ${branch}`);
        } else if (result.committed === false) {
          toast.success(`Pushed ${branch}`, {
            description: 'Existing local commits are now on the remote.',
          });
        } else {
          toast.success(`Committed and pushed ${branch}`, {
            description: result.message?.split('\n')[0],
          });
        }
        if (result.mirrorWarning) toast.warning(result.mirrorWarning);
        await refreshGitState();
      } else {
        toast.error(result.error ?? 'Commit and push failed', {
          ...(result.errorDetail ? { description: result.errorDetail } : {}),
          duration: 8000,
        });
      }
    } finally {
      setGitBusy(false);
    }
  };

  const handleChangeSourceControlToOrion = async () => {
    if (!activeWorkingDir || !window.orion?.changeSourceControlToOrion || repositoryOperationBusy) return;

    if (!accountState.authenticated) {
      toast.info('Sign in to your Durango account to use Durango Cloud source control.');
      setSettingsTab('account');
      setSettingsOpen(true);
      return;
    }

    setCloudBusy(true);
    try {
      const result = await window.orion.changeSourceControlToOrion({ projectPath: activeWorkingDir });
      if (result.ok) {
        const mirror = result.mirror;
        const authorizationUrl = mirror?.authorizationUrl;
        const mirrorDescription =
          mirror?.status === 'active' && mirror.delivery === 'cloud'
            ? 'GitHub is mirrored continuously by Durango Cloud.'
            : mirror?.status === 'authorization_required'
              ? [
                  'Authorize GitHub to keep this mirror in sync when Durango Code is closed.',
                  result.mirrorWarning,
                ]
                  .filter(Boolean)
                  .join(' ')
              : result.mirrorWarning ??
                (result.githubMirrorUrl ? 'GitHub is preserved as a read-only mirror.' : undefined);
        toast.success(
          gitState?.sourceProvider === 'github'
            ? 'Source control changed to Durango Cloud'
            : `Pushed ${activeThreadProject?.name ?? 'project'} to Durango Cloud`,
          result.githubMirrorUrl
            ? {
                description: mirrorDescription,
                ...(mirror?.status === 'authorization_required' && authorizationUrl
                  ? {
                      action: {
                        label: 'Authorize GitHub',
                        onClick: () => void window.orion?.openExternalUrl?.(authorizationUrl),
                      },
                    }
                  : {}),
              }
            : undefined
        );
        await refreshGitState();
        await refreshCloudState();
      } else if (result.needsAuth) {
        toast.error(result.error ?? 'Sign in first.');
        setSettingsTab('account');
        setSettingsOpen(true);
      } else {
        toast.error(result.error ?? 'Could not change source control to Durango Cloud');
      }
    } finally {
      setCloudBusy(false);
    }
  };

  const handleAuthorizeGithubMirror = async () => {
    if (!activeWorkingDir || !window.orion?.authorizeGithubMirror || repositoryOperationBusy) return;
    setCloudBusy(true);
    try {
      const result = await window.orion.authorizeGithubMirror(activeWorkingDir);
      if (!result.ok) {
        if (result.needsAuth) {
          setSettingsTab('account');
          setSettingsOpen(true);
        }
        toast.error(result.error ?? 'Could not start GitHub authorization');
        return;
      }
      const authorizationUrl = result.mirror?.authorizationUrl;
      if (!authorizationUrl) {
        toast.error('Durango Cloud did not return a GitHub authorization link.');
        return;
      }
      await window.orion.openExternalUrl?.(authorizationUrl);
      toast.info('Finish authorizing the GitHub App in your browser.');
      await refreshCloudState();
    } finally {
      setCloudBusy(false);
    }
  };

  const handleCloudPull = async () => {
    if (!activeWorkingDir || !window.orion?.pullFromCloud || repositoryOperationBusy) return;

    setCloudBusy(true);
    try {
      const result = await window.orion.pullFromCloud(activeWorkingDir);
      if (!result.ok) {
        toast.error(result.error ?? 'Pull from Durango Cloud failed');
      } else {
        const merge = result.merge;
        if (merge?.status === 'fast-forwarded' || merge?.status === 'checked-out') {
          toast.success('Pulled latest changes from Durango Cloud');
        } else if (merge?.status === 'up-to-date') {
          toast.info('Already up to date with Durango Cloud');
        } else if (merge?.status === 'diverged') {
          toast.info(merge.hint ?? 'Local and cloud history diverged — merge manually.');
        } else if (merge?.status === 'ff-failed' || merge?.status === 'unborn-dirty') {
          toast.info(merge.error ?? merge.hint ?? 'Fetched, but could not update your branch.');
        } else if (merge?.status === 'local-ahead') {
          toast.info('Fetched — your branch is ahead of Durango Cloud. Push when ready.');
        } else {
          toast.success('Fetched from Durango Cloud');
        }
        if (result.mirrorWarning) toast.warning(result.mirrorWarning);
      }
      await refreshGitState();
      await refreshCloudState();
    } finally {
      setCloudBusy(false);
    }
  };

  const handleOpenCloudApp = useCallback(() => {
    const projectPath = activeWorkingDir;
    if (!projectPath || !window.orion?.openCloudAppInBrowser) return;
    void window.orion.openCloudAppInBrowser(projectPath).then((result) => {
      if (!result.ok) toast.error(result.error ?? 'Could not open the deployed app.');
    });
  }, [activeWorkingDir]);

  // Complex apps don't deploy themselves: hand the job to a visible agent
  // thread that works out the build with orion-cli while the user watches.
  const startAgentDeploy = useCallback(
    (reasons: string[]) => {
      const projectId = activeThreadProject?.id;
      if (!projectId || isNoProjectId(projectId)) {
        toast.error('Open a project before deploying.');
        return;
      }
      const reasonText = reasons.length
        ? reasons.join('; ')
        : 'you asked for every deploy to go through the deployment agent';
      const prompt = [
        'Deploy this app to Durango Cloud. Use the Durango Code CLI: run `durango-code deploy` from the',
        'appropriate app directory (Durango Code puts `durango-code` on your PATH; run `durango-code --help`',
        'first to see usage; authenticate with `durango-code login` if prompted — tell me if login is',
        'required, since it opens a browser).',
        `This project was detected as non-trivial to deploy because: ${reasonText}.`,
        'If the working tree has uncommitted changes, review and commit the intended deployable work',
        'before deploying, while preserving unrelated user changes.',
        'Figure out the right way to deploy it (correct subdirectory for monorepos, build',
        'configuration, etc.), run the deploy, verify it succeeds, and report the live URL.',
      ].join(' ');

      // Deploying pushes commits, installs a CLI, and talks to Orion Cloud over
      // the network, so anything less than full access stalls on the first step.
      const threadId = createThread(projectId, 'Deploy to Durango Cloud', {
        ...(resolvedDeploymentModelId ? { modelId: resolvedDeploymentModelId } : {}),
        accessMode: 'full-access',
        // Keep the thread in the same directory the Deploy button acted on:
        // the selected thread's Durango workspace, or the project itself.
        // A fresh thread can start inside a workspace the agent made itself.
        durangoWorkspace: activeDurangoWorkspace ? { ...activeDurangoWorkspace, adopted: undefined } : null,
      });
      updateThread(threadId, deploymentThreadReasoningPatch);
      setActiveTab('agents');
      const start = startTurnForThreadRef.current?.(threadId, prompt, []);
      void start?.then(
        async (result) => {
          if (result.ok === false) {
            toast.error(result.error ?? 'Could not start the deployment agent');
            return;
          }
          try {
            const startup = await result.startup;
            if (!startup.ok) toast.error(startup.error ?? 'Could not start the deployment agent');
          } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Could not start the deployment agent');
          }
        },
        (error) => toast.error(error instanceof Error ? error.message : 'Could not start the deployment agent')
      );
      toast.info('Deploying with the deployment agent', {
        description: `Detected as non-trivial to deploy: ${reasonText}.`,
      });
    },
    [
      activeDurangoWorkspace,
      activeThreadProject?.id,
      createThread,
      deploymentThreadReasoningPatch,
      resolvedDeploymentModelId,
      setActiveTab,
      updateThread,
    ]
  );

  const handleCloudDeploy = async () => {
    const projectPath = activeWorkingDir;
    if (!projectPath || !window.orion?.deployToCloud || cloudDeployingDir) return;
    if (!accountState.authenticated) {
      toast.info('Sign in to your Durango account to deploy this project.');
      setSettingsTab('account');
      setSettingsOpen(true);
      return;
    }

    setCloudDeployingDir(projectPath);
    // A deploy pushes, so it holds the same lock as push/pull/publish.
    setCloudBusy(true);
    try {
      // A precheck that can't run (no git root, unreadable tree) shouldn't block
      // a deploy — the direct path reports the server's own error instead.
      const precheck = await window.orion.precheckCloudDeploy?.(projectPath);
      const simple = precheck?.ok ? precheck.simple !== false : true;
      if (!simple || deploymentSettings.preferAgentDeploys) {
        startAgentDeploy(precheck?.reasons ?? []);
        return;
      }

      // Deploying builds whatever the cloud repo holds, so an unpublished
      // project has to be published (which pushes) before it can deploy.
      const publishFirst = async () => {
        const published = await window.orion?.publishToCloud?.({ projectPath });
        if (published?.ok) {
          await refreshCloudState();
          return true;
        }
        if (published?.needsAuth) {
          toast.error(published.error ?? 'Sign in first.');
          setSettingsTab('account');
          setSettingsOpen(true);
        } else {
          toast.error(published?.error ?? 'Could not publish this project to Durango Cloud');
        }
        return false;
      };

      if (!cloudState?.linked && !(await publishFirst())) return;

      let result = await window.orion.deployToCloud(projectPath);
      if (!result.ok && result.needsPublish) {
        if (!(await publishFirst())) return;
        result = await window.orion.deployToCloud(projectPath);
      }

      if (!result.ok) {
        if (result.needsAuth) {
          toast.error(result.error ?? 'Sign in first.');
          setSettingsTab('account');
          setSettingsOpen(true);
        } else if (result.limitReached || result.upgradeRequired) {
          toast.error(result.error ?? 'Your plan does not allow another Durango Cloud app.', {
            action: {
              label: 'Upgrade',
              onClick: () => void window.orion?.openExternalUrl?.(cloudBillingUrl(cloudState?.webUrl)),
            },
          });
        } else {
          toast.error(result.error ?? 'Deploy to Durango Cloud failed');
        }
        return;
      }

      const app = result.app ?? null;
      cloudDeployWatchRef.current.add(projectPath);
      recordCloudApp(projectPath, app);
      if (app && app.status !== 'deployed' && app.status !== 'failed') {
        toast.info(`Building ${cloudAppHost(app.url)}…`, {
          description: 'Durango Cloud is building your app. This usually takes a few minutes.',
        });
      }
      await refreshCloudState();
    } finally {
      setCloudBusy(false);
      setCloudDeployingDir(null);
    }
  };

  // Create new thread for a project
  const handleCreateThread = (projectId: string) => {
    setCollapsedProjects((prev) => (prev[projectId] ? { ...prev, [projectId]: false } : prev));
    // Prevent spamming empty threads: if selected thread for this project is empty and nothing typed, do nothing.
    // CLI threads are exempt — their conversation lives in the terminal PTY, so
    // messages.length is always 0 even when the thread is heavily used.
    if (
      selectedThread &&
      selectedThread.projectId === projectId &&
      selectedThread.modelId !== claudeCodeCliModelId &&
      selectedThread.summary.messageCount === 0 &&
      !composerDraft.hasThreadDraft(selectedThread.id)
    ) {
      setActiveTab('agents');
      return selectedThread.id;
    }
    const id = createThread(projectId);
    setActiveTab('agents');
    return id;
  };

  // The thread new attachments go to: the selected one, or a new thread in
  // the selected project when none is open. Brings the composer forward.
  const resolveComposerTarget = useCallback(() => {
    let targetThreadId = selectedThreadId;
    if (!targetThreadId) {
      const projectId = selectedProject?.id ?? projects[0]?.id;
      if (!projectId) {
        toast.error('Add a project before attaching files');
        return null;
      }
      targetThreadId = handleCreateThread(projectId);
    }

    if (activeTab !== 'agents') {
      setActiveTab('agents');
    }
    selectThread(targetThreadId);
    return targetThreadId;
  }, [activeTab, handleCreateThread, projects, selectThread, selectedProject?.id, selectedThreadId, setActiveTab]);

  // Appends already-saved files to a thread's draft. The composer only holds
  // the draft of the thread it shows; a thread it is about to switch to (just
  // selected or created) gets them in its saved draft, which the swap effect
  // loads.
  const appendComposerAttachments = useCallback(
    (threadId: string, attachments: FileAttachment[]) => {
      if (attachments.length === 0) return;
      composerDraft.updateThreadDraft(threadId, (draft) => ({
        ...draft,
        attachments: [...draft.attachments, ...attachments],
      }));
    },
    [composerDraft]
  );

  const attachFiles = useCallback(
    async (files: FileList | File[]) => {
      const selectedFiles = Array.from(files);
      if (selectedFiles.length === 0) return false;

      const targetThreadId = resolveComposerTarget();
      if (!targetThreadId) return true;

      const savedAttachments = await saveFilesAsAttachments(selectedFiles);
      if (!savedAttachments) return true;
      appendComposerAttachments(targetThreadId, savedAttachments);

      return true;
    },
    [appendComposerAttachments, resolveComposerTarget]
  );

  // SnapShot captures (src/main/snapshot.js) wait in main until collected:
  // on mount, and whenever main announces one. They join the selected
  // thread's draft even while it runs. The listener mounts once and reaches
  // the current target through this ref.
  const takeSnapShotsRef = useRef<() => Promise<void>>(async () => {});
  takeSnapShotsRef.current = async () => {
    const attachments = (await window.orion?.snapShotTakePending?.()) ?? [];
    if (attachments.length === 0) return;
    const targetThreadId = resolveComposerTarget();
    if (!targetThreadId) return;
    setSettingsOpen(false);
    appendComposerAttachments(targetThreadId, attachments);
    const capture = attachments.find((attachment) => attachment.snapshot)?.snapshot;
    if (capture) toast.success(`SnapShot of ${capture.appName} attached`);
  };
  useEffect(() => {
    if (!window.orion?.snapShotTakePending) return undefined;
    let hydrationUnsubscribe = () => {};
    const take = () => void takeSnapShotsRef.current().catch(() => {});
    // Before hydration the selected thread is unknown; collect afterwards.
    if (useOrionStore.persist.hasHydrated()) take();
    else hydrationUnsubscribe = useOrionStore.persist.onFinishHydration(take);
    const unsubscribeAvailable = window.orion.onSnapShotAvailable?.(() => {
      if (useOrionStore.persist.hasHydrated()) take();
    });
    const unsubscribeError = window.orion.onSnapShotError?.((error) => {
      toast.error(error.message);
    });
    return () => {
      hydrationUnsubscribe();
      unsubscribeAvailable?.();
      unsubscribeError?.();
    };
  }, []);

  // Main arms the SnapShot trigger from its own copy of these settings at
  // launch; push the persisted ones after hydration and on every change.
  useEffect(() => {
    if (!window.orion?.snapShotConfigure) return undefined;
    const push = () => void window.orion?.snapShotConfigure?.(useOrionStore.getState().snapShotSettings);
    if (useOrionStore.persist.hasHydrated()) {
      push();
      return undefined;
    }
    return useOrionStore.persist.onFinishHydration(push);
  }, [snapShotSettings]);

  const handleRootDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDraggingFiles(true);
  }, []);

  const handleRootDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleRootDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) {
      setDraggingFiles(false);
    }
  }, []);

  const handleRootDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!Array.from(event.dataTransfer.types).includes('Files')) return;
      dragDepth.current = 0;
      setDraggingFiles(false);
      // Taken by a drop target of its own (a Needs you reply).
      if (event.defaultPrevented) return;
      event.preventDefault();
      void attachFiles(event.dataTransfer.files);
    },
    [attachFiles]
  );

  // Durango workspaces (docs/workspaces.md). A thread that has never run gets
  // its own workspace when its project is in a Durango repository (a
  // durango.toml at the repository root) and the setting is on. Threads that
  // already ran keep the directory their sessions were recorded in; branches
  // and subagents were given their source's workspace (or none) when created.
  const ensureThreadDurangoWorkspace = useCallback(
    async (threadId: string, seed: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const state = useOrionStore.getState();
      const thread = state.threads.find((candidate) => candidate.id === threadId);
      if (!thread) return { ok: false, error: 'Thread no longer exists' };
      if (
        thread.durangoWorkspace !== undefined ||
        state.durangoWorkspaceSettings?.enabled === false ||
        thread.parentThreadId ||
        thread.branchedFromThreadId ||
        Object.values(thread.agentSessionIds ?? {}).some(Boolean) ||
        // A thread whose workspace was removed starts over in a new one.
        (!thread.durangoWorkspaceRemovedAt && Boolean(thread.summary.lastAgentRun))
      ) {
        return { ok: true };
      }
      const project = findProjectById(state, thread.projectId);
      if (!project || isNoProjectId(project.id) || !window.orion?.createDurangoWorkspace) return { ok: true };
      const inspection = await window.orion
        .inspectDurangoWorkspaceProject?.({ projectPath: project.path })
        .catch(() => null);
      if (!inspection?.eligible) return { ok: true };

      markWorkspaceThreads('setup', [threadId], true);
      try {
        const name = durangoWorkspaceName(seed || (isDefaultTitle(thread.title) ? '' : thread.title));
        const result = await window.orion.createDurangoWorkspace({ projectPath: project.path, name, threadId });
        if (!result.ok || !result.workspace) {
          return {
            ok: false,
            error:
              `Could not create a Durango workspace: ${result.error ?? 'unknown error'}. ` +
              'Turn off automatic workspaces in Settings → Workspaces to work in the project directory.',
          };
        }
        const workspace = result.workspace;
        if (!useOrionStore.getState().threads.some((candidate) => candidate.id === threadId)) {
          // Deleted while the workspace was being made: nothing can use it.
          void window.orion.removeDurangoWorkspace?.({
            name: workspace.name,
            repo: workspace.repo,
            path: workspace.path,
            force: true,
          });
          return { ok: false, error: 'Thread no longer exists' };
        }
        updateThread(threadId, { durangoWorkspace: workspace });
        // Record it before the agent starts, so a crash can never leave a
        // session in the workspace that the thread does not know about.
        await flushOrionThreadsSave();
        const failedClones = result.failedClones ?? [];
        const hints = result.hints ?? [];
        if (failedClones.length > 0 || hints.length > 0) {
          toast.warning(`Workspace ${workspace.name} may need its dependencies installed`, {
            description: hints.join('; ') || failedClones.join(', '),
          });
        }
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: `Could not create a Durango workspace: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        markWorkspaceThreads('setup', [threadId], false);
      }
    },
    [markWorkspaceThreads, updateThread]
  );

  // Internal turn setup. The wrapper below owns the per-thread reservation
  // across this whole promise, including every asynchronous preflight.
  const startTurnForThreadUnlocked = useCallback(
    async (
      threadId: string,
      promptText: string,
      attachments: FileAttachment[],
      claimStart?: () => Promise<boolean>,
      applyClaimedSettings?: () => void,
      // Agent context the transcript doesn't show (a controller's copies of
      // threads its prompt mentions that this machine can't read).
      extraContext?: string
    ): Promise<ThreadTurnStartResult> => {
      await refreshLinkedTasksBeforeDispatch(threadId);
      if (claimStart && !(await claimRemoteThreadStart(claimStart, applyClaimedSettings))) {
        return { ok: false, error: 'The remote command expired before the turn started.' };
      }
      let state = useOrionStore.getState();
      let thread = state.threads.find((t) => t.id === threadId);
      if (!thread) return { ok: false, error: 'Thread no longer exists' };
      if (thread.subagent) {
        return {
          ok: false,
          error: 'Subagent transcripts are read-only — steer from the parent thread.',
        };
      }
      const project = findProjectById(state, thread.projectId);
      if (!project) return { ok: false, error: 'Select a project for this thread first' };
      if (workspaceRemovalThreadIdsRef.current.has(thread.id)) {
        return { ok: false, error: 'This thread’s Durango workspace is being removed' };
      }
      // A first turn in a Durango repository creates the thread's workspace
      // before anything runs: a session recorded against the project directory
      // could not be resumed from inside the workspace afterwards.
      const workspaceSetup = await ensureThreadDurangoWorkspace(threadId, promptText);
      if (!workspaceSetup.ok) return { ok: false, error: workspaceSetup.error };
      state = useOrionStore.getState();
      const threadAfterWorkspace = state.threads.find((candidate) => candidate.id === threadId);
      if (!threadAfterWorkspace) return { ok: false, error: 'Thread no longer exists' };
      thread = threadAfterWorkspace;
      const workingDir = threadWorkingDir(thread, project);
      let model = findAgentModel(agentModels, thread.modelId ?? defaultAgentModelId);
      if (!model) return { ok: false, error: 'Select an agent model first' };

      // Orion pseudo-model: resolve the configured main driver EARLY and
      // replace `model` with it, so every downstream use (enabled/available
      // checks, session ids, reasoning params, provider options) applies to
      // the real provider. thread.modelId stays 'orion:orchestrator'.
      let orchestration:
        | {
            isOrchestrator: boolean;
            roles: Array<{
              role: string;
              roleLabel: string;
              modelId: string;
              providerId: string;
              slug: string;
              modelLabel: string;
            }>;
            generalInstructions: string;
          }
        | undefined;
      if (model.providerId === 'orion' || isOrionModelId(thread.modelId)) {
        const roleModels = {
          ...defaultOrchestrationSettings.models,
          ...state.orchestrationSettings?.models,
        };
        const generalInstructions =
          state.orchestrationSettings?.generalInstructions ?? defaultOrchestrationSettings.generalInstructions;
        const driverModel = resolveOrionMainDriverModel(
          agentModels,
          roleModels.mainDriver,
          defaultAgentModelId,
          claudeCodeCliModelId
        );
        if (!driverModel || driverModel.providerId === 'orion' || driverModel.id === claudeCodeCliModelId) {
          return {
            ok: false,
            error: 'Pick a main driver model in Settings → Orchestration',
          };
        }
        const roles = orchestrationRoleMeta.map((meta) => {
          const configuredRoleModel = agentModels.find((candidate) => candidate.id === roleModels[meta.id]);
          const roleModel =
            meta.id === 'mainDriver' ||
            !configuredRoleModel ||
            configuredRoleModel.providerId === 'orion' ||
            configuredRoleModel.id === claudeCodeCliModelId
              ? driverModel
              : configuredRoleModel;
          return {
            role: meta.id,
            roleLabel: meta.label,
            modelId: roleModel.id,
            providerId: roleModel.providerId,
            slug: roleModel.slug,
            modelLabel: roleModel.label,
          };
        });
        orchestration = { isOrchestrator: true, roles, generalInstructions };
        model = driverModel;
      }

      // Embedded Claude Code owns a persistent PTY and must never reach the
      // one-shot agent IPC below. Keep this guard ahead of every transcript
      // mutation even though current local and remote callers route it first.
      if (model.id === claudeCodeCliModelId) {
        return { ok: false, error: 'Claude Code CLI threads use the embedded terminal runtime.' };
      }

      if (normalizedProviderSettings[model.providerId]?.enabled === false) {
        return { ok: false, error: `${model.providerLabel} is disabled` };
      }
      if (model.available === false) {
        return {
          ok: false,
          error: model.unavailableReason ?? `${model.label} is unavailable`,
        };
      }
      if (!window.orion?.runAgentTurn) {
        return { ok: false, error: 'Agent runtime is unavailable' };
      }

      const mentionedThreads = promptText
        ? parseThreadMentions(promptText, state.threads, threadId)
        : [];
      // @chat mentions of Durango Chat conversations: ids/titles/links only;
      // the agent reads them with read_chat (same bridge as read_thread).
      const mentionedChats = promptText ? parseChatMentions(promptText, knownDurangoChats()) : [];
      if (mentionedThreads.length > 0 || mentionedChats.length > 0) {
        let supportsThreadReader = false;
        try {
          supportsThreadReader =
            (await window.orion?.supportsThreadReader?.(model.providerId)) === true;
        } catch {
          supportsThreadReader = false;
        }
        if (!supportsThreadReader) {
          return {
            ok: false,
            error:
              mentionedThreads.length > 0
                ? `${model.providerLabel} cannot read referenced threads with this installation`
                : `${model.providerLabel} cannot read Durango chats with this installation`,
          };
        }
      }
      if (mentionedThreads.length > 0) {
        // read_thread runs in main and reads the on-disk transcript snapshot.
        // Persist all live renderer threads before exposing those ids so a
        // just-created or just-updated reference is immediately readable.
        if (!(await flushOrionThreadsSave())) {
          return {
            ok: false,
            error: 'Referenced threads could not be saved before starting this turn',
          };
        }
        // Capability probing and persistence both yield. Continue from the
        // current source thread so edits made during preflight are preserved.
        state = useOrionStore.getState();
        const refreshedThread = state.threads.find((candidate) => candidate.id === threadId);
        if (!refreshedThread) return { ok: false, error: 'Thread no longer exists' };
        thread = refreshedThread;
      }
      // Optional "[Durango memory]" block (Settings → Durango, default off):
      // only when this provider's session starts fresh — later turns resume
      // a session that already has it.
      let durangoMemoryBlock = '';
      if (
        state.durangoSettings?.includeProfileMemory === true &&
        !thread.agentSessionIds?.[model.providerId]
      ) {
        durangoMemoryBlock = await fetchDurangoProfileMemoryBlock();
        state = useOrionStore.getState();
        const refreshedThread = state.threads.find((candidate) => candidate.id === threadId);
        if (!refreshedThread) return { ok: false, error: 'Thread no longer exists' };
        thread = refreshedThread;
      }

      // First turn carrying linked board tasks: the tasks themselves are the
      // prompt, so an empty draft is fine — their titles and descriptions
      // become the agent context (later turns resume the same session, so the
      // agent already has them). Derive this after asynchronous preflight so
      // newly linked tasks are neither omitted nor overwritten.
      const tasksToInject = (thread.linkedTasks ?? []).filter((task) => !task.injected);
      if (!promptText && attachments.length === 0 && tasksToInject.length === 0) {
        return { ok: false, error: 'Type a message first' };
      }
      const taskAttachments = linkedTaskAttachments(tasksToInject);
      const turnAttachments = [...taskAttachments, ...attachments];
      const userContent = promptText || (attachments.length > 0 ? 'Attached file' : '');
      let agentPrompt = buildPromptWithAttachments(promptText, attachments);
      const preserveSlashCommandStart =
        model.providerId === 'claude' && promptText.trimStart().startsWith('/');
      const addAgentContext = (context: string | null) => {
        if (context) {
          agentPrompt = addPromptContext(agentPrompt, context, preserveSlashCommandStart);
        }
      };
      if (tasksToInject.length > 0) {
        addAgentContext(buildLinkedTaskContext(tasksToInject, Boolean(agentPrompt)));
        const injectedIds = new Set(tasksToInject.map((task) => task.id));
        updateThread(threadId, {
          linkedTasks: (thread.linkedTasks ?? []).map((task) =>
            injectedIds.has(task.id) ? { ...task, injected: true } : task
          ),
        });
      }
      // Inherited children normally fork their own provider session. If the
      // user picks another model/provider (or the native provider exposed no
      // independently resumable session), carry the visible child transcript
      // into this first fresh turn. The branched parent still does not absorb
      // every child transcript.
      // startTurnForThread loaded and holds the transcript.
      addAgentContext(inheritedSubagentResumeContext(thread, loadedMessages(threadId) ?? [], model.providerId));
      // @-model mentions in the user's original text: tell the agent which
      // models were referenced so it can delegate to them. Works on any
      // thread, not just Orion ones.
      const mentionedModels = promptText ? parseModelMentions(promptText, agentModels) : [];
      if (mentionedModels.length > 0) {
        addAgentContext(buildModelMentionsContext(mentionedModels));
      }
      // @nickname mentions of Orion MCP servers attach them to the thread:
      // they load for this turn and every later one until detached from the
      // composer, even while switched off in Settings.
      const mentionedMcps = promptText ? parseMcpMentions(promptText, orionMcpsRef.current) : [];
      const mcpServerIds =
        mentionedMcps.length > 0
          ? mergeMcpAttachments(thread.mcpServerIds, mentionedMcps, orionMcpsRef.current)
          : (thread.mcpServerIds ?? []);
      if (mentionedMcps.length > 0) {
        addAgentContext(buildMcpMentionsContext(mentionedMcps));
        updateThread(threadId, { mcpServerIds });
      }
      // @-thread mentions: hand the agent pointers to the referenced Orion
      // threads (id + metadata), not their transcripts — it browses them on
      // demand through the read_thread MCP tool.
      if (mentionedThreads.length > 0) {
        const threadMentionsContext = buildThreadMentionsContext(
          mentionedThreads,
          new Map(state.projects.map((project) => [project.id, project.name]))
        );
        addAgentContext(threadMentionsContext);
      }
      if (mentionedChats.length > 0) {
        addAgentContext(buildChatMentionsContext(mentionedChats));
      }
      addAgentContext(extraContext?.trim() ? extraContext : null);
      // A fresh session in a Durango workspace is told it is already in one.
      if (thread.durangoWorkspace && !thread.agentSessionIds?.[model.providerId]) {
        addAgentContext(buildDurangoWorkspaceContext(thread.durangoWorkspace));
      }
      // Sits just below the general/orchestration instructions block.
      addAgentContext(durangoMemoryBlock);
      if (orchestration) {
        // Added last: ordinary prompts retain orchestration-first ordering;
        // slash commands retain the command at byte zero and put context after it.
        const orchestrationContext = buildOrchestrationContext(
          orchestration.roles,
          orchestration.generalInstructions,
          thread.accessMode ?? 'full-access'
        );
        addAgentContext(orchestrationContext);
      } else {
        // The user's general instructions bind every model run through Orion,
        // not just the orchestrator — a global CLAUDE.md scoped to the app.
        // Orchestrated turns already carry them in the block above. Added last
        // so the block sits topmost on ordinary prompts.
        addAgentContext(
          buildGeneralInstructionsContext(
            state.orchestrationSettings?.generalInstructions ??
              defaultOrchestrationSettings.generalInstructions
          )
        );
      }

      // Auto-generate a relevant thread title from the first user message (like Codex / T3 Code)
      if (thread.summary.messageCount === 0 && isDefaultTitle(thread.title)) {
        const titleSeed = userContent || tasksToInject[0]?.title || '';
        const initialTitle = deriveTitle(titleSeed);
        const expectedTitle = isPlausibleTitle(initialTitle) ? initialTitle : thread.title;
        if (isPlausibleTitle(initialTitle)) {
          updateThread(threadId, { title: initialTitle });
        }
        // Kick off async LLM refinement for a nicer title. The thread's own
        // model may be a slow reasoning one (or Orion, which can't run a
        // one-shot), so this goes through the text-generation model instead.
        void tryGenerateBetterTitle(
          threadId,
          titleSeed,
          resolveUtilityTurn(),
          workingDir,
          updateThread,
          expectedTitle,
          getStoredThreadTitle
        );
      }

      pinThreadToBottom(threadId);
      addMessageToThread(threadId, {
        role: 'user',
        content: userContent,
        attachments: turnAttachments,
        ...(tasksToInject.length > 0
          ? {
              linkedTasks: tasksToInject.map((task) => ({
                id: task.id,
                title: task.title,
                description: task.description,
              })),
            }
          : {}),
      });
      updateThread(threadId, { status: 'running' });
      pushLinkedTaskStatus(threadId, 'running');

      const messageId = addMessageToThread(threadId, {
        role: 'agent',
        content: '',
        kind: 'agent-run',
        status: 'running',
        statusText: "I'm working on this now.",
        startedAt: new Date().toISOString(),
        activities: [],
        modelId: model.id,
      });
      const runId = crypto.randomUUID();
      runOutputMessages.current.set(runId, { threadId, messageId });
      setActiveRunsByThread((current) => ({ ...current, [threadId]: runId }));

      const startup = window.orion.runAgentTurn({
        runId,
        threadId,
        projectPath: workingDir,
        prompt: agentPrompt,
        modelId: model.id,
        accessMode: thread.accessMode ?? 'full-access',
        resumeSessionId: thread.agentSessionIds?.[model.providerId],
        // Branched thread's first turn per provider: fork the inherited
        // session instead of resuming the parent's in place.
        forkSession: Boolean(
          thread.agentSessionIds?.[model.providerId] && thread.pendingForkProviders?.includes(model.providerId)
        ),
        providerOptions: normalizedProviderSettings[model.providerId]?.options,
        // These native providers consume attachments directly as well as
        // retaining the text/path context for later file and crop tools.
        ...(['kimi', 'fx', 'claude', 'codex'].includes(model.providerId) && turnAttachments.length > 0
          ? { attachments: turnAttachments } : {}),
        ...(model.providerId === 'codex'
          ? {
              codexReasoningEffort: getEffectiveCodexReasoningEffort(model, thread.codexReasoningEffort),
              codexServiceTier: thread.codexServiceTier ?? defaultCodexServiceTier,
            }
          : {}),
        ...(model.providerId === 'claude'
          ? {
              claudeReasoningEffort: getEffectiveClaudeReasoningEffort(model, thread.claudeReasoningEffort),
              claudeContextWindow: getEffectiveClaudeContextWindow(
                model,
                thread.claudeContextWindow ?? defaultClaudeContextWindow
              ),
            }
          : {}),
        ...(model.providerId === 'grok'
          ? {
              grokReasoningEffort: getEffectiveGrokReasoningEffort(model, thread.grokReasoningEffort),
            }
          : {}),
        ...(model.providerId === 'muse'
          ? {
              museReasoningEffort: getEffectiveMuseReasoningEffort(model, thread.museReasoningEffort),
            }
          : {}),
        ...(model.providerId === 'opencode'
          ? {
              openCodeReasoningEffort: getEffectiveOpenCodeReasoningEffort(
                model,
                thread.openCodeReasoningEffort
              ),
            }
          : {}),
        ...(mentionedModels.length > 0 ? { mentions: mentionedModels } : {}),
        ...(mentionedThreads.length > 0 ? { hasThreadMentions: true } : {}),
        ...(mentionedChats.length > 0 ? { hasChatMentions: true } : {}),
        ...(mcpServerIds.length > 0 ? { mcpServerIds } : {}),
        ...(orchestration ? { orchestration } : {}),
      });
      void startup.then((result) => {
        if (result.ok && result.runId) {
          if (result.runId !== runId) {
            runOutputMessages.current.delete(runId);
            runOutputMessages.current.set(result.runId, {
              threadId,
              messageId,
            });
            setActiveRunsByThread((current) =>
              current[threadId] === runId ? { ...current, [threadId]: result.runId! } : current
            );
          }
        } else {
          runOutputMessages.current.delete(runId);
          clearActiveRun(runId);
          appendToThreadMessage(threadId, messageId, result.error ?? 'The agent failed to start.');
          updateThreadMessage(threadId, messageId, {
            status: 'error',
            completedAt: new Date().toISOString(),
            statusText: 'The agent failed to start.',
            error: result.error,
          });
          updateThread(threadId, { status: 'error' });
        }
      });

      return { ok: true, startup };
    },
    [
      agentModels,
      normalizedProviderSettings,
      addMessageToThread,
      appendToThreadMessage,
      updateThread,
      updateThreadMessage,
      clearActiveRun,
      pushLinkedTaskStatus,
      refreshLinkedTasksBeforeDispatch,
      ensureThreadDurangoWorkspace,
    ]
  );

  // Start a turn on any thread — not just the selected one — so queued
  // follow-ups can dispatch for threads running in the background. The
  // reservation is acquired synchronously and released only after setup has
  // failed or the active run has been registered.
  const startTurnForThread = useCallback(
    async (
      threadId: string,
      promptText: string,
      attachments: FileAttachment[],
      claimStart?: () => Promise<boolean>,
      applyClaimedSettings?: () => void,
      // Agent context the transcript doesn't show (a controller's copies of
      // threads its prompt mentions that this machine can't read).
      extraContext?: string
    ): Promise<ThreadTurnStartResult> => {
      // A thread on another machine starts its turns there, whichever path
      // (retry, follow-up, composer) asked for one.
      if (findThread(useOrionStore.getState().threads, threadId)?.remote) {
        const remoteStart = await startRemoteTurnRef.current(threadId, promptText, attachments);
        return remoteStart.ok ? { ok: true, startup: Promise.resolve({ ok: true }) } : { ok: false, error: remoteStart.error };
      }
      const turnStart = await withThreadStartReservation(
        pendingTurnStartsRef.current,
        threadId,
        async () => {
          // The turn reads and grows the transcript: load it first (threads
          // started from elsewhere may not be open) and keep it loaded.
          const release = holdThreadTranscript(threadId);
          try {
            if (
              !(await loadThreadMessages(threadId)) &&
              findThread(useOrionStore.getState().threads, threadId)
            ) {
              return { ok: false as const, error: TRANSCRIPT_UNAVAILABLE_ERROR };
            }
            return await startTurnForThreadUnlocked(
              threadId,
              promptText,
              attachments,
              claimStart,
              applyClaimedSettings,
              extraContext
            );
          } finally {
            release();
          }
        }
      );
      return turnStart.acquired
        ? turnStart.value
        : { ok: false, error: 'An agent turn is already starting' };
    },
    [startTurnForThreadUnlocked]
  );

  useEffect(() => {
    startTurnForThreadRef.current = startTurnForThread;
  }, [startTurnForThread]);

  // Orchestrator spawn_subagent requests from main: create a hidden child
  // thread in the driver's project, run the prompt on the requested model,
  // and report the final output back (which unblocks the driver's MCP tool
  // call). Mounts once; live state comes from the store and refs.
  useEffect(() => {
    if (!window.orion?.onSubagentSpawnRequest) return undefined;
    const unsubscribe = window.orion.onSubagentSpawnRequest((request) => {
      const report = (ok: boolean, result: string) => {
        void window.orion?.reportSubagentResult?.({
          spawnId: request.spawnId,
          ok,
          result,
        });
      };
      const state = useOrionStore.getState();
      const driverThread = state.threads.find((t) => t.id === request.threadId);
      if (!driverThread) {
        report(false, 'Driver thread not found');
        return;
      }
      if (
        workspaceSetupThreadIdsRef.current.has(driverThread.id) ||
        workspaceRemovalThreadIdsRef.current.has(driverThread.id)
      ) {
        report(false, 'The driver thread’s Durango workspace is not available');
        return;
      }
      const projectId = driverThread.projectId;
      if (!findProjectById(state, projectId)) {
        report(false, 'Driver project not found');
        return;
      }

      // Resolve the model fuzzily: exact id → exact slug → exact label →
      // includes on slug/label.
      const models = agentModelsRef.current;
      const wanted = request.model.trim();
      const wantedLower = wanted.toLowerCase();
      const model =
        models.find((m) => m.id === wanted) ??
        models.find((m) => m.slug.toLowerCase() === wantedLower) ??
        models.find((m) => m.label.toLowerCase() === wantedLower) ??
        models.find((m) => m.slug.toLowerCase().includes(wantedLower) || m.label.toLowerCase().includes(wantedLower));
      if (!model) {
        const available = models
          .filter((m) => m.providerId !== 'orion')
          .slice(0, 10)
          .map((m) => m.slug)
          .join(', ');
        report(false, `Unknown model "${request.model}". Available: ${available}`);
        return;
      }
      if (model.providerId === 'orion' || model.id === claudeCodeCliModelId) {
        report(
          false,
          model.providerId === 'orion'
            ? 'Cannot spawn a subagent on the Durango Code orchestrator itself'
            : 'Claude Code CLI is an interactive terminal and cannot run as a subagent'
        );
        return;
      }

      // A requested effort must be one the model's own picker offers (value
      // or label), so the child never stores a level its composer can't show.
      // Without one the child keeps the effort createThread inherits.
      let reasoningPatch: ThreadReasoningPatch = {};
      const wantedEffort = request.effort?.trim().toLowerCase();
      if (wantedEffort) {
        const options = reasoningOptionsForModel(model);
        const option = options.find(
          (candidate) =>
            candidate.value.toLowerCase() === wantedEffort || candidate.label.toLowerCase() === wantedEffort
        );
        if (!option) {
          report(
            false,
            options.length > 0
              ? `${model.label} does not support effort "${request.effort}". Available: ${options
                  .map((candidate) => candidate.value)
                  .join(', ')}`
              : `${model.label} has no reasoning effort setting; spawn it without \`effort\``
          );
          return;
        }
        reasoningPatch = threadReasoningPatchForModel(model, option.value);
      }

      const promptSlice = request.prompt.trim().slice(0, 44);
      const roleMeta = orchestrationRoleMeta.find((meta) => meta.id === request.role);
      const title =
        request.title || (roleMeta ? `${roleMeta.label}: ${promptSlice}` : `${model.label}: ${promptSlice}`);

      // Background spawn: never touch the user's selection (thread or
      // project).
      const childThreadId = state.createThread(projectId, title, {
        parentThreadId: request.threadId,
        modelId: model.id,
        hiddenFromRecent: true,
        select: false,
        // Persisted on the thread so stop/delete/reload can still resolve the
        // driver's blocked spawn_subagent call.
        spawnId: request.spawnId,
        // Deterministic: subagents run with the driver's access mode, never
        // whatever an unrelated project thread last used.
        accessMode: request.accessMode ?? driverThread.accessMode,
        // ...and in the driver's directory, so they work on the same tree.
        durangoWorkspace: driverThread.durangoWorkspace ?? null,
      });
      if (Object.keys(reasoningPatch).length > 0) state.updateThread(childThreadId, reasoningPatch);

      // The spawnId was persisted at creation so the completion watcher can't
      // miss a fast run. Async start failures set the thread status to
      // 'error', which the watcher reports.
      const start = startTurnForThreadRef.current?.(childThreadId, request.prompt, []);
      if (!start) {
        state.updateThread(childThreadId, { spawnId: undefined });
        report(false, 'The subagent turn could not start');
        return;
      }
      void start.then(
        (result) => {
          if (result.ok) return;
          state.updateThread(childThreadId, { spawnId: undefined });
          report(false, result.error ?? 'The subagent turn could not start');
        },
        (error) => {
          state.updateThread(childThreadId, { spawnId: undefined });
          report(false, error instanceof Error ? error.message : 'The subagent turn could not start');
        }
      );
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  // A run id can outlive its runOutputMessages entry: a Claude turn that
  // finishes while background agents are still live is untracked by the done
  // handler but keeps its run id in activeRunsByThread as a cancellable
  // handle. Stopping such a run finds no tracked message to mark, so without
  // this the thread's last agent-run bubble would say "Waiting on N
  // background agents…" forever after the runtime is disposed.
  const markUntrackedRunStopped = useCallback(
    (threadId: string, statusText: string) => {
      // The shell knows the last run; the update waits for the transcript if
      // it isn't loaded.
      const lastRun = findThread(useOrionStore.getState().threads, threadId)?.summary.lastAgentRun;
      if (!lastRun) return;
      updateThreadMessage(threadId, lastRun.id, {
        statusText,
        completedAt: new Date().toISOString(),
      });
    },
    [updateThreadMessage]
  );

  // Orchestrator stop_subagent requests from main: match the target among the
  // driver's running child threads (by model and/or title, or the single
  // running one when neither is given), halt its runtime like the user's stop
  // button would, resolve its pending spawn_subagent call, and report what
  // was stopped back to the driver's blocked stop_subagent call.
  const stopSubagentsForRequest = useCallback(
    async (request: { stopId: string; threadId: string; model?: string; title?: string; all?: boolean }) => {
      const report = (ok: boolean, result: string) => {
        void window.orion?.reportSubagentStopResult?.({
          stopId: request.stopId,
          ok,
          result,
        });
      };
      const state = useOrionStore.getState();
      // activeRunsByThreadRef only catches up in an effect after the next
      // render, so a stop arriving right after a spawn would miss the child's
      // just-registered run there and falsely report success without ever
      // terminating the provider process. runOutputMessages is maintained
      // synchronously through registration, runId swaps, and completion, so
      // its entries win over the ref.
      const runsByThread = new Map<string, string>(Object.entries(activeRunsByThreadRef.current));
      for (const [runId, tracked] of runOutputMessages.current) {
        runsByThread.set(tracked.threadId, runId);
      }
      const models = agentModelsRef.current;
      const describe = (thread: Thread) => {
        const model = models.find((m) => m.id === thread.modelId);
        return `"${thread.title}" (${model?.slug ?? thread.modelId})`;
      };

      // Native subagent mirrors have no independent runtime to stop; the provider CLI owns that subagent.
      // Threads on other machines (machine_run_agent) stop with machine_stop_agent.
      const running = state.threads.filter(
        (thread) =>
          thread.parentThreadId === request.threadId &&
          !thread.subagent &&
          !thread.remote &&
          (thread.status === 'running' || runsByThread.has(thread.id))
      );
      if (running.length === 0) {
        report(false, 'This agent has no running subagents.');
        return;
      }

      const wantedModel = request.model?.trim().toLowerCase();
      const wantedTitle = request.title?.trim().toLowerCase();
      let targets = running;
      if (wantedModel) {
        targets = targets.filter((thread) => {
          const model = models.find((m) => m.id === thread.modelId);
          return [thread.modelId, model?.slug, model?.label]
            .filter((value): value is string => Boolean(value))
            .some((value) => value.toLowerCase().includes(wantedModel));
        });
      }
      if (wantedTitle) {
        targets = targets.filter((thread) => thread.title.toLowerCase().includes(wantedTitle));
      }
      if (targets.length === 0) {
        report(false, `No running subagent matches. Running subagents: ${running.map(describe).join(', ')}.`);
        return;
      }
      // A broad selector (or none) must not take down parallel siblings by
      // accident: multiple matches only proceed when the caller explicitly
      // asked for every match.
      if (targets.length > 1 && !request.all) {
        report(
          false,
          `Matched ${targets.length} running subagents — pass a more specific model/title, or all=true to stop every match: ${targets.map(describe).join(', ')}.`
        );
        return;
      }

      // Each target's own spawned children have independent runtimes, so walk
      // the full subtree — same as the user's stop button.
      const threadIds = new Set(targets.map((thread) => thread.id));
      let foundChild = true;
      while (foundChild) {
        foundChild = false;
        for (const candidate of state.threads) {
          if (candidate.parentThreadId && threadIds.has(candidate.parentThreadId) && !threadIds.has(candidate.id)) {
            threadIds.add(candidate.id);
            foundChild = true;
          }
        }
      }

      // Threads on other machines keep the status that machine reports; their
      // queued follow-ups go, or they'd start again once that machine is idle.
      for (const candidate of state.threads) {
        if (candidate.remote && threadIds.has(candidate.id) && (candidate.queuedMessages?.length ?? 0) > 0) {
          updateThread(candidate.id, { queuedMessages: [] });
        }
      }
      const stoppedThreads = state.threads.filter((candidate) => threadIds.has(candidate.id) && !candidate.remote);
      const runsToStop: Array<{ threadId: string; runId: string }> = [];
      for (const candidate of stoppedThreads) {
        const runId = runsByThread.get(candidate.id);
        if (runId) runsToStop.push({ threadId: candidate.id, runId });
      }
      const pendingSpawnIds: string[] = [];

      // Invalidate async steering preparation before releasing any run owner;
      // otherwise a late fallback can enqueue a fresh turn after this stop.
      cancelPendingSteers(threadIds);
      // Untrack and mark every run in the subtree stopped BEFORE the IPC
      // calls: interrupted result events can otherwise race in and mark them
      // Finished.
      for (const { threadId: runThreadId, runId } of runsToStop) {
        const tracked = runOutputMessages.current.get(runId);
        runOutputMessages.current.delete(runId);
        clearActiveRun(runId);
        if (tracked) {
          appendToThreadMessage(tracked.threadId, tracked.messageId, '\n\nStopped by the orchestrator.');
          updateThreadMessage(tracked.threadId, tracked.messageId, {
            status: 'stopped',
            completedAt: new Date().toISOString(),
            statusText: 'Stopped by the orchestrator.',
          });
        } else {
          markUntrackedRunStopped(runThreadId, 'Stopped by the orchestrator.');
        }
      }
      for (const stoppedThread of stoppedThreads) {
        if (stoppedThread.status === 'running') updateThread(stoppedThread.id, { status: 'idle' });
        if ((stoppedThread.queuedMessages?.length ?? 0) > 0) {
          updateThread(stoppedThread.id, { queuedMessages: [] });
        }
        if (stoppedThread.spawnId) {
          updateThread(stoppedThread.id, { spawnId: undefined });
          pendingSpawnIds.push(stoppedThread.spawnId);
        }
      }
      flushChunkBuffers();

      // Each Orion child is its own provider runtime, so terminate every
      // active run and dispose every stopped thread before reporting back.
      await Promise.all(
        runsToStop.map(({ runId }) => window.orion?.stopAgentTurn?.(runId, { terminateBackground: true }))
      );
      await Promise.all(stoppedThreads.map((candidate) => disposeThreadRuntime(candidate.id)));
      for (const spawnId of pendingSpawnIds) {
        void window.orion?.reportSubagentResult?.({
          spawnId,
          ok: false,
          result: 'Subagent run was stopped by the orchestrator.',
        });
      }
      report(true, `Stopped subagent ${targets.map(describe).join(', ')}.`);
    },
    [
      clearActiveRun,
      appendToThreadMessage,
      updateThreadMessage,
      updateThread,
      flushChunkBuffers,
      disposeThreadRuntime,
      markUntrackedRunStopped,
      cancelPendingSteers,
    ]
  );

  const stopSubagentsForRequestRef = useRef(stopSubagentsForRequest);
  useEffect(() => {
    stopSubagentsForRequestRef.current = stopSubagentsForRequest;
  }, [stopSubagentsForRequest]);

  useEffect(() => {
    if (!window.orion?.onSubagentStopRequest) return undefined;
    const unsubscribe = window.orion.onSubagentStopRequest((request) => {
      void stopSubagentsForRequestRef.current?.(request);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  // A spawned subthread reaching 'done' or 'error' (turn finished, failed to
  // start, or app-restart recovery) resolves the driver's blocked
  // spawn_subagent call with the child's final output. The persisted spawnId
  // is cleared after the first report — later runs on the subthread
  // (steer/queued follow-ups) fire more transitions, but main also ignores
  // unknown spawnIds.
  useEffect(() => {
    for (const thread of threads) {
      const spawnId = thread.spawnId;
      if (!spawnId) continue;
      if (thread.status !== 'done' && thread.status !== 'error') continue;
      updateThread(thread.id, { spawnId: undefined });
      const status = thread.status;
      // A run that just ended has its transcript loaded; load it otherwise.
      void loadThreadMessages(thread.id).then((messages) => {
        if (!messages) {
          // Never report an unreadable transcript as a finished run with no
          // output: the driver would act on a result that doesn't exist.
          void window.orion?.reportSubagentResult?.({
            spawnId,
            ok: false,
            result: `The subagent ${status === 'done' ? 'finished' : 'stopped'}, but Durango Code could not read its transcript to report the result. Read the subagent thread instead.`,
          });
          return;
        }
        const lastAgentMessage = [...messages]
          .reverse()
          .find((message) => message.role === 'agent' && (message.content.trim() || message.error));
        const output = lastAgentMessage?.content.trim();
        void window.orion?.reportSubagentResult?.({
          spawnId,
          ok: status === 'done',
          result:
            status === 'done'
              ? output || '(no output)'
              : lastAgentMessage?.error || output || 'The subagent run failed.',
        });
      });
    }
  }, [threads, updateThread]);

  // `/btw` — ask the agent a side question without interrupting the thread
  // (Claude Code's /btw). The question runs against a read-only FORK of the
  // thread's Claude session (--resume <id> --fork-session), so it sees the
  // full conversation context but the main session, transcript, thread
  // status, and queued-message dispatch are all untouched. Works mid-run: the
  // fork reads whatever the session file holds so far.
  const askBtwQuestion = useCallback(
    (threadId: string, question: string): { ok: boolean; error?: string } => {
      const state = useOrionStore.getState();
      const thread = state.threads.find((t) => t.id === threadId);
      if (!thread) return { ok: false, error: 'Thread no longer exists' };
      const project = findProjectById(state, thread.projectId);
      if (!project) return { ok: false, error: 'Select a project for this thread first' };
      if (workspaceSetupThreadIdsRef.current.has(thread.id) || workspaceRemovalThreadIdsRef.current.has(thread.id)) {
        return { ok: false, error: 'This thread’s Durango workspace is not available' };
      }
      const workingDir = threadWorkingDir(thread, project);
      let model = findAgentModel(agentModels, thread.modelId ?? defaultAgentModelId);
      // Orion threads run on their configured main-driver model. Resolve the
      // pseudo-model here just as startTurnForThread does so a Claude-backed
      // orchestrator can fork its live Claude session for /btw.
      if (model?.providerId === 'orion' || isOrionModelId(thread.modelId)) {
        const roleModels = {
          ...defaultOrchestrationSettings.models,
          ...state.orchestrationSettings?.models,
        };
        model = findAgentModel(agentModels, roleModels.mainDriver);
      }
      if (!model) return { ok: false, error: 'Select an agent model first' };
      if (model.providerId !== 'claude') {
        return {
          ok: false,
          error: '/btw is only available on Claude agents for now',
        };
      }
      if (normalizedProviderSettings.claude?.enabled === false) {
        return { ok: false, error: `${model.providerLabel} is disabled` };
      }
      if (model.available === false) {
        return {
          ok: false,
          error: model.unavailableReason ?? `${model.label} is unavailable`,
        };
      }
      if (!window.orion?.runAgentTurn) {
        return { ok: false, error: 'Agent runtime is unavailable' };
      }

      const sessionId = thread.agentSessionIds?.claude;
      if (!sessionId) {
        return {
          ok: false,
          error: 'Wait for Claude to start this thread before using /btw.',
        };
      }
      const prompt =
        'The user has a quick aside question about this session (asked via /btw). ' +
        'Answer it directly and concisely. Do not make any changes and do not treat ' +
        'it as a new task — this exchange is a side conversation that the main ' +
        'session will never see.\n\n' +
        question;

      // Persist any already-received main-turn text before recording the
      // anchor offset. Chunks that arrive after this point then sort below the
      // aside even though the main turn continues in the same message.
      flushChunkBuffers();
      const exchangeId = addBtwExchange(threadId, question);
      const runId = crypto.randomUUID();
      btwRuns.current.set(runId, { threadId, exchangeId });
      pinThreadToBottom(threadId);

      void window.orion
        .runAgentTurn({
          runId,
          threadId,
          projectPath: workingDir,
          prompt,
          modelId: model.id,
          // Plan mode: the aside can read the repo but never mutate it.
          accessMode: 'read-only',
          resumeSessionId: sessionId,
          forkSession: Boolean(sessionId),
          // Asides run one-shot on a forked CLI; they must never reuse (or
          // replace) the thread's persistent claude session.
          aside: true,
          providerOptions: normalizedProviderSettings.claude?.options,
          claudeReasoningEffort: getEffectiveClaudeReasoningEffort(model, thread.claudeReasoningEffort),
          claudeContextWindow: getEffectiveClaudeContextWindow(
            model,
            thread.claudeContextWindow ?? defaultClaudeContextWindow
          ),
        })
        .then((result) => {
          if (result.ok && result.runId) {
            if (result.runId !== runId) {
              const tracked = btwRuns.current.get(runId);
              btwRuns.current.delete(runId);
              if (tracked) btwRuns.current.set(result.runId, tracked);
            }
          } else {
            btwRuns.current.delete(runId);
            updateBtwExchange(threadId, exchangeId, {
              status: 'error',
              completedAt: new Date().toISOString(),
              error: result.error ?? 'The agent failed to start.',
            });
          }
        });

      return { ok: true };
    },
    [agentModels, normalizedProviderSettings, addBtwExchange, flushChunkBuffers, updateBtwExchange]
  );

  // `/goal` — codex goal runs. The whole pursuit (codex auto-continues turns
  // until the goal completes, blocks, or hits budget) is one agent-run
  // message driven over `codex app-server`.
  const startGoalRunForThreadLoaded = useCallback(
    (
      threadId: string,
      rawText: string,
      goalAction: {
        action: 'set' | 'resume';
        objective?: string;
        tokenBudget?: number;
      }
    ): { ok: boolean; error?: string } => {
      const state = useOrionStore.getState();
      const thread = state.threads.find((t) => t.id === threadId);
      if (!thread) return { ok: false, error: 'Thread no longer exists' };
      const project = findProjectById(state, thread.projectId);
      if (!project) return { ok: false, error: 'Select a project for this thread first' };
      if (workspaceSetupThreadIdsRef.current.has(thread.id) || workspaceRemovalThreadIdsRef.current.has(thread.id)) {
        return { ok: false, error: 'This thread’s Durango workspace is not available' };
      }
      const workingDir = threadWorkingDir(thread, project);
      const model = findAgentModel(agentModels, thread.modelId ?? defaultAgentModelId);
      if (!model) return { ok: false, error: 'Select an agent model first' };
      if (model.providerId !== 'codex') {
        return { ok: false, error: '/goal is only available on Codex agents' };
      }
      if (normalizedProviderSettings.codex?.enabled === false) {
        return { ok: false, error: `${model.providerLabel} is disabled` };
      }
      if (model.available === false) {
        return {
          ok: false,
          error: model.unavailableReason ?? `${model.label} is unavailable`,
        };
      }
      if (!window.orion?.runAgentTurn) {
        return { ok: false, error: 'Agent runtime is unavailable' };
      }
      // startGoalRunForThread loaded and holds the transcript.
      const inheritedResumeContext = inheritedSubagentResumeContext(thread, loadedMessages(threadId) ?? [], 'codex');

      // Goal commands bypass the normal send flow, so seed the title here
      // from the objective before the first transcript messages are added.
      // Resuming a goal must preserve the thread's existing title.
      const titleSeed = getGoalTitleSeed(thread, goalAction);
      if (titleSeed) {
        const initialTitle = deriveTitle(titleSeed);
        const expectedTitle = isPlausibleTitle(initialTitle) ? initialTitle : thread.title;
        if (isPlausibleTitle(initialTitle)) {
          updateThread(threadId, { title: initialTitle });
        }
        void tryGenerateBetterTitle(
          threadId,
          titleSeed,
          resolveUtilityTurn(),
          workingDir,
          updateThread,
          expectedTitle,
          getStoredThreadTitle
        );
      }

      addMessageToThread(threadId, { role: 'user', content: rawText });
      const messageId = addMessageToThread(threadId, {
        role: 'agent',
        content: '',
        kind: 'agent-run',
        status: 'running',
        statusText: 'Pursuing the goal.',
        startedAt: new Date().toISOString(),
        activities: [],
        modelId: model.id,
      });
      const runId = crypto.randomUUID();
      runOutputMessages.current.set(runId, { threadId, messageId });
      setActiveRunsByThread((current) => ({ ...current, [threadId]: runId }));
      updateThread(threadId, { status: 'running' });
      pinThreadToBottom(threadId);

      void window.orion
        .runAgentTurn({
          runId,
          threadId,
          projectPath: workingDir,
          prompt: goalAction.objective || 'Resume the goal.',
          modelId: model.id,
          accessMode: thread.accessMode ?? 'full-access',
          ...(thread.mcpServerIds?.length ? { mcpServerIds: thread.mcpServerIds } : {}),
          resumeSessionId: thread.agentSessionIds?.codex,
          forkSession: Boolean(thread.agentSessionIds?.codex && thread.pendingForkProviders?.includes('codex')),
          providerOptions: normalizedProviderSettings.codex?.options,
          codexReasoningEffort: getEffectiveCodexReasoningEffort(model, thread.codexReasoningEffort),
          codexServiceTier: thread.codexServiceTier ?? defaultCodexServiceTier,
          // Goal runs do not consume the ordinary prompt field. Seed a fresh
          // app-server thread with the inherited child transcript without
          // folding that transcript into the persisted goal objective.
          ...(inheritedResumeContext ? { codexInitialContext: inheritedResumeContext } : {}),
          codexGoal: goalAction,
        })
        .then((result) => {
          if (result.ok && result.runId) {
            if (result.runId !== runId) {
              runOutputMessages.current.delete(runId);
              runOutputMessages.current.set(result.runId, {
                threadId,
                messageId,
              });
              setActiveRunsByThread((current) =>
                current[threadId] === runId ? { ...current, [threadId]: result.runId! } : current
              );
            }
          } else {
            runOutputMessages.current.delete(runId);
            clearActiveRun(runId);
            appendToThreadMessage(threadId, messageId, result.error ?? 'The agent failed to start.');
            updateThreadMessage(threadId, messageId, {
              status: 'error',
              completedAt: new Date().toISOString(),
              statusText: 'The agent failed to start.',
              error: result.error,
            });
            updateThread(threadId, { status: 'error' });
          }
        });

      return { ok: true };
    },
    [
      agentModels,
      normalizedProviderSettings,
      addMessageToThread,
      appendToThreadMessage,
      updateThread,
      updateThreadMessage,
      clearActiveRun,
      resolveUtilityTurn,
    ]
  );

  // The run's context comes from the transcript: load it (and keep it
  // loaded) first, and refuse rather than run without it.
  const startGoalRunForThread = useCallback(
    async (threadId: string, rawText: string, goalAction: Parameters<typeof startGoalRunForThreadLoaded>[2]): Promise<{ ok: boolean; error?: string }> => {
      const release = holdThreadTranscript(threadId);
      try {
        if (!(await loadThreadMessages(threadId)) && findThread(useOrionStore.getState().threads, threadId)) {
          return { ok: false, error: TRANSCRIPT_UNAVAILABLE_ERROR };
        }
        return startGoalRunForThreadLoaded(threadId, rawText, goalAction);
      } finally {
        release();
      }
    },
    [startGoalRunForThreadLoaded]
  );

  // `/review` — Codex's dedicated reviewer, run inline on the current native
  // Codex session so it can see the conversation that led to the changes.
  const startReviewForThreadLoaded = useCallback(
    (
      threadId: string,
      rawText: string,
      review: {
        mode: 'uncommitted' | 'base' | 'commit' | 'custom';
        base?: string;
        commit?: string;
        instructions?: string;
      }
    ): { ok: boolean; error?: string } => {
      const state = useOrionStore.getState();
      const thread = state.threads.find((t) => t.id === threadId);
      // The transcript before this review's own messages (its review context).
      // startReviewForThread loaded and holds the transcript.
      const priorMessages = loadedMessages(threadId) ?? [];
      if (!thread) return { ok: false, error: 'Thread no longer exists' };
      const project = findProjectById(state, thread.projectId);
      if (!project) return { ok: false, error: 'Select a project for this thread first' };
      if (workspaceSetupThreadIdsRef.current.has(thread.id) || workspaceRemovalThreadIdsRef.current.has(thread.id)) {
        return { ok: false, error: 'This thread’s Durango workspace is not available' };
      }
      const workingDir = threadWorkingDir(thread, project);
      const model = findAgentModel(agentModels, thread.modelId ?? defaultAgentModelId);
      if (!model) return { ok: false, error: 'Select an agent model first' };
      if (model.providerId !== 'codex') {
        return {
          ok: false,
          error: '/review is only available on Codex agents',
        };
      }
      if (normalizedProviderSettings.codex?.enabled === false) {
        return { ok: false, error: `${model.providerLabel} is disabled` };
      }
      if (model.available === false) {
        return {
          ok: false,
          error: model.unavailableReason ?? `${model.label} is unavailable`,
        };
      }
      if (!window.orion?.runAgentTurn) {
        return { ok: false, error: 'Agent runtime is unavailable' };
      }

      const reviewLabel =
        review.mode === 'base'
          ? `Code review against ${review.base}`
          : review.mode === 'commit'
            ? `Code review of commit ${review.commit}`
            : review.mode === 'custom'
              ? 'Code review (custom instructions)'
              : 'Code review (uncommitted changes)';

      // Codex titles review threads "Review Changes" — mirror that rather
      // than leaving the default timestamp title in the sidebar. The /review
      // path never reaches the normal send flow that seeds thread titles.
      if (isDefaultTitle(thread.title)) {
        updateThread(threadId, { title: 'Review Changes' });
      }

      addMessageToThread(threadId, { role: 'user', content: rawText });
      const messageId = addMessageToThread(threadId, {
        role: 'agent',
        content: '',
        kind: 'agent-run',
        status: 'running',
        statusText: 'Reviewing changes.',
        startedAt: new Date().toISOString(),
        activities: [],
        modelId: model.id,
      });
      const runId = crypto.randomUUID();
      runOutputMessages.current.set(runId, { threadId, messageId });
      setActiveRunsByThread((current) => ({ ...current, [threadId]: runId }));
      updateThread(threadId, { status: 'running' });
      pinThreadToBottom(threadId);

      void window.orion
        .runAgentTurn({
          runId,
          threadId,
          projectPath: workingDir,
          prompt: review.instructions || reviewLabel,
          modelId: model.id,
          accessMode: thread.accessMode ?? 'full-access',
          resumeSessionId: thread.agentSessionIds?.codex,
          forkSession: Boolean(thread.agentSessionIds?.codex && thread.pendingForkProviders?.includes('codex')),
          providerOptions: normalizedProviderSettings.codex?.options,
          codexReasoningEffort: getEffectiveCodexReasoningEffort(model, thread.codexReasoningEffort),
          codexServiceTier: thread.codexServiceTier ?? defaultCodexServiceTier,
          codexReview: {
            ...review,
            threadContext: buildReviewThreadContext(thread, priorMessages),
          },
        })
        .then((result) => {
          if (result.ok && result.runId) {
            if (result.runId !== runId) {
              runOutputMessages.current.delete(runId);
              runOutputMessages.current.set(result.runId, {
                threadId,
                messageId,
              });
              setActiveRunsByThread((current) =>
                current[threadId] === runId ? { ...current, [threadId]: result.runId! } : current
              );
            }
          } else {
            runOutputMessages.current.delete(runId);
            clearActiveRun(runId);
            appendToThreadMessage(threadId, messageId, result.error ?? 'The review failed to start.');
            updateThreadMessage(threadId, messageId, {
              status: 'error',
              completedAt: new Date().toISOString(),
              statusText: 'The review failed to start.',
              error: result.error,
            });
            updateThread(threadId, { status: 'error' });
          }
        });

      return { ok: true };
    },
    [
      agentModels,
      normalizedProviderSettings,
      addMessageToThread,
      appendToThreadMessage,
      updateThread,
      updateThreadMessage,
      clearActiveRun,
    ]
  );

  // The run's context comes from the transcript: load it (and keep it
  // loaded) first, and refuse rather than run without it.
  const startReviewForThread = useCallback(
    async (threadId: string, rawText: string, review: Parameters<typeof startReviewForThreadLoaded>[2]): Promise<{ ok: boolean; error?: string }> => {
      const release = holdThreadTranscript(threadId);
      try {
        if (!(await loadThreadMessages(threadId)) && findThread(useOrionStore.getState().threads, threadId)) {
          return { ok: false, error: TRANSCRIPT_UNAVAILABLE_ERROR };
        }
        return startReviewForThreadLoaded(threadId, rawText, review);
      } finally {
        release();
      }
    },
    [startReviewForThreadLoaded]
  );

  // Dismissing a still-running aside also kills its forked run.
  const dismissBtwExchange = useCallback(
    (threadId: string, exchangeId: string) => {
      for (const [runId, tracked] of btwRuns.current) {
        if (tracked.threadId === threadId && tracked.exchangeId === exchangeId) {
          btwRuns.current.delete(runId);
          void window.orion?.stopAgentTurn?.(runId);
        }
      }
      removeBtwExchange(threadId, exchangeId);
    },
    [removeBtwExchange]
  );

  // Queued follow-ups dispatch as soon as their thread has no run in flight —
  // after a turn finishes (done or error) and after app-restart recovery. Each
  // dispatch resumes the provider session, so the agent keeps its context.
  // One that can't start goes back to the front of its queue (never lost) and
  // the error is shown as a toast: the transcript may be what failed to load.
  // That thread's queue then waits a while before trying again.
  const queueRetryAfterRef = useRef(new Map<string, number>());
  const [queueRetryTick, setQueueRetryTick] = useState(0);
  // Remote threads with a "Steer now" on its way to their machine (count per
  // thread): their queue waits, so it can't overtake the steer.
  const pendingRemoteSteersRef = useRef(new Map<string, number>());
  useEffect(() => {
    for (const thread of threads) {
      const next = thread.queuedMessages?.[0];
      if (!next) continue;
      if (
        thread.status === 'running' ||
        activeRunsByThread[thread.id] ||
        pendingTurnStartsRef.current.has(thread.id) ||
        pendingRemoteSteersRef.current.has(thread.id)
      ) {
        continue;
      }
      if ((queueRetryAfterRef.current.get(thread.id) ?? 0) > Date.now()) continue;
      queueRetryAfterRef.current.delete(thread.id);
      removeQueuedThreadMessage(thread.id, next.id);
      const putBack = (error: string) => {
        const current = findThread(useOrionStore.getState().threads, thread.id);
        if (!current) return;
        if (!current.queuedMessages?.some((queued) => queued.id === next.id)) {
          updateThread(thread.id, { queuedMessages: [next, ...(current.queuedMessages ?? [])] });
        }
        queueRetryAfterRef.current.set(thread.id, Date.now() + QUEUE_RETRY_DELAY_MS);
        window.setTimeout(() => setQueueRetryTick((tick) => tick + 1), QUEUE_RETRY_DELAY_MS);
        toast.error(`Could not send the queued message in "${current.title}": ${error}`);
      };
      void startTurnForThread(thread.id, next.text, next.attachments ?? []).then(
        (result) => {
          if (!result.ok) putBack(result.error ?? 'the agent turn could not start');
        },
        (error) => putBack(error instanceof Error ? error.message : String(error))
      );
    }
  }, [threads, activeRunsByThread, removeQueuedThreadMessage, startTurnForThread, updateThread, queueRetryTick]);

  // Goal pause/clear is an intentional cancellation, so detach the live run
  // before stopping its app-server. Otherwise the SIGTERM tail can race back
  // through the normal error handler and turn a successful pause into a
  // failed transcript entry.
  const stopTrackedGoalRun = async (runId: string, statusText: string) => {
    const tracked = runOutputMessages.current.get(runId);
    if (tracked) cancelPendingSteers([tracked.threadId]);
    runOutputMessages.current.delete(runId);
    clearActiveRun(runId);
    flushChunkBuffers();
    if (tracked) {
      updateThreadMessage(tracked.threadId, tracked.messageId, {
        status: 'stopped',
        completedAt: new Date().toISOString(),
        statusText,
      });
      updateThread(tracked.threadId, { status: 'idle' });
    }
    return (await window.orion?.stopAgentTurn?.(runId)) ?? false;
  };

  // `/goal <objective> [budget:500k]` sets (or replaces) the codex goal and
  // starts pursuing it; `/goal pause|resume|clear|status` manage it. Stop on
  // a goal run pauses the goal, so pause and Stop are the same gesture.
  const handleGoalCommand = async (promptText: string, rest: string) => {
    if (!selectedThreadId || !selectedThread) return;
    const state = useOrionStore.getState();
    const model = findAgentModel(agentModels, selectedThread.modelId ?? defaultAgentModelId);
    if (model?.providerId !== 'codex') {
      toast.error('/goal is only available on Codex agents');
      return;
    }
    const goal = selectedThread.goal;
    const sessionId = selectedThread.agentSessionIds?.codex;
    const project = findProjectById(state, selectedThread.projectId);
    const workingDir = project ? threadWorkingDir(selectedThread, project) : null;
    const finishInput = () => {
      composerDraft.setText('');
    };
    const sub = rest.toLowerCase();

    if (!rest || sub === 'status') {
      if (!goal && !sessionId) {
        toast.error('No goal on this thread yet — set one with “/goal <objective>”.');
        return;
      }
      if (sessionId && workingDir && window.orion?.codexGoalCommand) {
        void window.orion
          .codexGoalCommand({
            sessionId,
            threadId: selectedThreadId,
            projectPath: workingDir,
            action: 'get',
          })
          .then((result) => {
            if (result.ok) updateThread(selectedThreadId, { goal: result.goal ?? null });
            const latest = result.ok ? result.goal : goal;
            if (latest) toast.success(goalSummaryLine(latest));
            else toast.error(result.ok ? 'No goal on this thread.' : (result.error ?? 'Could not read the goal.'));
          });
      } else if (goal) {
        toast.success(goalSummaryLine(goal));
      } else {
        toast.error('No goal on this thread.');
      }
      finishInput();
      return;
    }

    if (sub === 'pause') {
      if (!goal || goal.status !== 'active') {
        toast.error('No active goal to pause.');
        return;
      }
      const activeRun = activeRunsByThread[selectedThreadId];
      if (activeRun) {
        // Stopping the goal run pauses the goal (main records it in codex).
        void stopTrackedGoalRun(activeRun, 'Goal paused.').then((stopped) => {
          if (!stopped) {
            toast.error('Could not stop the live goal run.');
            return;
          }
          // The main-process goal event normally installed the authoritative
          // paused state while stopAgentTurn was awaiting the app-server. Use
          // a local fallback only if that event did not arrive.
          const latest = useOrionStore.getState().threads.find((thread) => thread.id === selectedThreadId)?.goal;
          if (latest?.status === 'active') {
            updateThread(selectedThreadId, {
              goal: { ...latest, status: 'paused' },
            });
          }
          toast.success('Goal paused.');
        });
      } else if (sessionId && workingDir && window.orion?.codexGoalCommand) {
        void window.orion
          .codexGoalCommand({
            sessionId,
            threadId: selectedThreadId,
            projectPath: workingDir,
            action: 'pause',
          })
          .then((result) => {
            if (result.ok) {
              updateThread(selectedThreadId, {
                goal: result.goal ?? { ...goal, status: 'paused' },
              });
              toast.success('Goal paused.');
            } else {
              toast.error(result.error ?? 'Could not pause the goal.');
            }
          });
      }
      finishInput();
      return;
    }

    if (sub === 'clear') {
      if (!goal) {
        toast.error('No goal to clear.');
        return;
      }
      const clearGoal = () => {
        if (sessionId && workingDir && window.orion?.codexGoalCommand) {
          void window.orion
            .codexGoalCommand({
              sessionId,
              threadId: selectedThreadId,
              projectPath: workingDir,
              action: 'clear',
            })
            .then((result) => {
              if (result.ok) {
                updateThread(selectedThreadId, { goal: null });
                toast.success('Goal cleared.');
              } else {
                toast.error(result.error ?? 'Could not clear the goal.');
              }
            });
        } else {
          updateThread(selectedThreadId, { goal: null });
        }
      };
      const activeRun = activeRunsByThread[selectedThreadId];
      if (activeRun) {
        void stopTrackedGoalRun(activeRun, 'Goal stopped.').then((stopped) => {
          if (!stopped) {
            toast.error('Could not stop the live goal run.');
            return;
          }
          // Let the killed app-server release the thread before a short-lived
          // goal-op process resumes it to clear the persisted goal.
          setTimeout(clearGoal, 500);
        });
      } else {
        clearGoal();
      }
      finishInput();
      return;
    }

    if (sub === 'resume') {
      if (!goal) {
        toast.error('No goal to resume — set one with “/goal <objective>”.');
        return;
      }
      if (isSending) {
        toast.error('A run is already in flight on this thread.');
        return;
      }
      await startFromComposer(selectedThreadId, promptText, () =>
        startGoalRunForThread(selectedThreadId, promptText, { action: 'resume' })
      );
      return;
    }

    // New objective. Optional trailing "budget:500k" / "budget:2m" caps tokens.
    if (isSending) {
      toast.error('Stop or finish the current run before setting a goal.');
      return;
    }
    let objective = rest;
    let tokenBudget: number | undefined;
    const budgetMatch = rest.match(/(?:^|\s)budget[:=]\s*(\d+(?:\.\d+)?)\s*([km])?\s*$/i);
    if (budgetMatch) {
      const value = parseFloat(budgetMatch[1]);
      const unit = (budgetMatch[2] ?? '').toLowerCase();
      tokenBudget = Math.round(value * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1));
      objective = rest.slice(0, budgetMatch.index).trim();
    }
    if (!objective) {
      toast.error('Describe the goal, e.g. “/goal get all tests passing budget:500k”.');
      return;
    }
    await startFromComposer(selectedThreadId, promptText, () =>
      startGoalRunForThread(selectedThreadId, promptText, {
        action: 'set',
        objective,
        ...(tokenBudget ? { tokenBudget } : {}),
      })
    );
  };

  // `/review` → codex reviewer. Bare = uncommitted changes; `base <branch>`,
  // `commit <sha>`, anything else = custom instructions (codex's own modes).
  const dispatchReview = async (
    rawText: string,
    review: {
      mode: 'uncommitted' | 'base' | 'commit' | 'custom';
      base?: string;
      commit?: string;
      instructions?: string;
    }
  ) => {
    if (!selectedThreadId) return;
    // On another machine, that machine parses /review itself.
    if (selectedThread?.remote) {
      await sendMessage(rawText);
      return;
    }
    if (isSending) {
      toast.error('Wait for the current run to finish before starting a review.');
      return;
    }
    await startFromComposer(selectedThreadId, rawText, () => startReviewForThread(selectedThreadId, rawText, review));
  };

  // A composer command that starts a run (/goal, /review) may wait on the
  // thread's transcript. Like a send, it takes the command out of the composer
  // and marks the thread starting first — so a second Enter can't start it
  // again, and whatever the user types meanwhile (or another thread's draft)
  // is never what gets cleared — and puts the command back on its own thread
  // if the run doesn't start.
  const startFromComposer = async (
    threadId: string,
    commandText: string,
    start: () => Promise<{ ok: boolean; error?: string }>
  ) => {
    composerDraft.setText('');
    composerDraft.setStarting(threadId, true);
    let result: { ok: boolean; error?: string };
    try {
      result = await start();
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : 'The run could not start' };
    } finally {
      composerDraft.setStarting(threadId, false);
    }
    if (!result.ok) {
      restoreComposerDraft(threadId, commandText, []);
      toast.error(result.error);
      return false;
    }
    composerDraft.flush();
    return true;
  };

  const handleReviewCommand = (promptText: string) => {
    if (!selectedThread) return;
    const model = findAgentModel(agentModels, selectedThread.modelId ?? defaultAgentModelId);
    if (model?.providerId !== 'codex') {
      toast.error('/review is only available on Codex agents');
      return;
    }
    const parsed = parseCodexReviewCommand(promptText);
    if (!parsed) return;
    if (parsed.error) {
      toast.error(parsed.error);
      return;
    }
    void dispatchReview(promptText, parsed.review);
  };

  // Async delivery can outlive the originating thread selection. Restore a
  // failed submission to that thread's draft rather than overwriting whatever
  // the user is currently composing elsewhere.
  const restoreComposerDraft = (threadId: string, promptText: string, attachments: FileAttachment[]) => {
    composerDraft.updateThreadDraft(threadId, (draft) => ({
      text: [promptText, draft.text].filter(Boolean).join('\n\n'),
      attachments: [...attachments, ...draft.attachments],
    }));
  };

  // Threads that run on another machine (remote control, Thread.remote): the
  // mirror of their transcript is kept current here, and their turns start
  // there instead of in a local agent run.
  const remoteThreadSync = useRemoteThreadSync({
    enabled: remoteControlSettings.enabled,
    threads,
    openThreadIds: paneThreadIds.length > 0 ? paneThreadIds : selectedThreadId ? [selectedThreadId] : EMPTY_THREAD_IDS,
    machines: remoteMachines,
  });
  remoteThreadSyncRef.current = remoteThreadSync;

  /**
   * Start a turn of a thread on its machine: the first one finds (or clones)
   * the project there and creates the thread there; later ones continue it.
   * The prompt shows in the mirror at once; the other machine's copy replaces
   * the mirror as soon as it has the turn.
   */
  const startRemoteTurn = async (
    threadId: string,
    promptText: string,
    attachments: FileAttachment[] = []
  ): Promise<{ ok: boolean; error?: string }> => {
    const state = useOrionStore.getState();
    const thread = state.threads.find((candidate) => candidate.id === threadId);
    const remote = thread?.remote;
    if (!thread || !remote) return { ok: false, error: 'This thread does not run on another machine.' };
    if (!window.orion?.remoteRunTurn || !window.orion.remoteResolveProject) {
      return { ok: false, error: 'Remote control is unavailable in this build.' };
    }
    const unsupported = remoteThreadRunError(thread.modelId);
    if (unsupported) return { ok: false, error: unsupported };
    // One start at a time: the queued-message effect must not send the next
    // follow-up before this turn shows as running.
    if (pendingTurnStartsRef.current.has(threadId)) return { ok: false, error: 'This thread is already starting a turn.' };
    pendingTurnStartsRef.current.add(threadId);
    const agentModel = findAgentModel(agentModelsRef.current, thread.modelId);
    const userMessageId = addMessageToThread(threadId, {
      role: 'user',
      content: promptText,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    const derivedTitle = isDefaultTitle(thread.title) && promptText ? deriveTitle(promptText) : null;
    if (derivedTitle && isPlausibleTitle(derivedTitle)) updateThread(threadId, { title: derivedTitle });
    // A start that fails leaves the thread as it was: no prompt, its old title.
    const dropUserMessage = () => {
      const store = useOrionStore.getState();
      store.updateThreadTranscript(threadId, (transcript) => ({
        ...transcript,
        messages: transcript.messages.filter((message) => message.id !== userMessageId),
      }));
      if (derivedTitle && store.threads.find((candidate) => candidate.id === threadId)?.title === derivedTitle) {
        updateThread(threadId, { title: thread.title });
      }
    };
    try {
      // @-mentioned threads: that machine reads its own (the mention is
      // pointed at its id there); this machine's and other machines' threads
      // can't be read there, so their newest page goes along as context.
      let hostPrompt = promptText;
      let mentionContext: string | undefined;
      const mentioned = promptText ? parseThreadMentions(promptText, state.threads, threadId) : [];
      const readHere: typeof mentioned = [];
      for (const mention of mentioned) {
        const hostThreadId =
          mention.thread.remote?.machineId === remote.machineId ? mention.thread.remote.threadId : undefined;
        if (hostThreadId) hostPrompt = retargetThreadMention(hostPrompt, mention.thread, hostThreadId);
        else readHere.push(mention);
      }
      if (readHere.length > 0 && window.orion.readThreadsForMention) {
        // read_thread reads the saved copy: save what changed here first.
        if (!(await flushOrionThreadsSave())) {
          dropUserMessage();
          return { ok: false, error: 'Referenced threads could not be saved before sending this turn.' };
        }
        const pages = await window.orion.readThreadsForMention({
          threadIds: readHere.map((mention) => mention.thread.id),
        });
        mentionContext = buildRemoteThreadMentionsContext(readHere, pages, remote.machineName);
      }
      let hostProjectId = remote.projectId;
      if (!remote.threadId && !hostProjectId) {
        const project = findProjectById(state, thread.projectId);
        const resolved = await window.orion.remoteResolveProject({
          machineId: remote.machineId,
          project: project ? { id: project.id, name: project.name, path: project.path } : null,
        });
        if (!resolved?.ok || !resolved.projectId) {
          dropUserMessage();
          return { ok: false, error: resolved?.error ?? `Could not reach ${remote.machineName}.` };
        }
        hostProjectId = resolved.projectId;
        // Say where it runs: the project there was matched, not chosen.
        if (resolved.projectName) toast.message(`Running in ${resolved.projectName} on ${remote.machineName}`);
      }
      const result = await window.orion.remoteRunTurn({
        machineId: remote.machineId,
        ...(remote.threadId ? { threadId: remote.threadId } : { projectId: hostProjectId }),
        prompt: hostPrompt,
        ...(mentionContext ? { context: mentionContext } : {}),
        // Uploaded to that machine first (main).
        ...(attachments.length > 0 ? { attachments } : {}),
        // Only what changed here (all of it for a new thread there), so a
        // stale value here never overrides a change made there.
        ...(remoteTurnSettingsToSend(thread, agentModel?.providerId) as Partial<
          Parameters<NonNullable<NonNullable<Window['orion']>['remoteRunTurn']>>[0]
        >),
      });
      if (!result?.ok) {
        dropUserMessage();
        return { ok: false, error: result?.error ?? `${remote.machineName} could not start the agent.` };
      }
      const fresh = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
      if (fresh?.remote?.machineId === remote.machineId) {
        const hostThreadId = result.threadId ?? fresh.remote.threadId;
        // This machine's copies of the files it sent, for showing the mirror.
        const sentPaths = Object.fromEntries((result.attachments ?? []).map((item) => [item.hostPath, item.localPath]));
        updateThread(threadId, {
          status: 'running',
          remote: {
            ...fresh.remote,
            threadId: hostThreadId,
            projectId: hostProjectId ?? fresh.remote.projectId,
            // What the turn set there.
            hostSettings: { ...fresh.remote.hostSettings, ...remoteSettingsOf(thread) },
            ...(Object.keys(sentPaths).length > 0
              ? { attachmentPaths: { ...fresh.remote.attachmentPaths, ...sentPaths } }
              : {}),
          },
        });
        // A listing of that machine may have picked the new thread up first.
        for (const duplicate of useOrionStore.getState().threads) {
          if (
            duplicate.id !== threadId &&
            duplicate.remote?.imported &&
            duplicate.remote.machineId === remote.machineId &&
            duplicate.remote.threadId === hostThreadId
          ) {
            useOrionStore.getState().deleteThread(duplicate.id);
          }
        }
        remoteThreadSync.markStarted(threadId);
      }
      return { ok: true };
    } catch (error) {
      dropUserMessage();
      return { ok: false, error: error instanceof Error ? error.message : `Could not reach ${remote.machineName}.` };
    } finally {
      pendingTurnStartsRef.current.delete(threadId);
    }
  };

  startRemoteTurnRef.current = startRemoteTurn;

  const sendMessage = async (overrideText?: string) => {
    if (!selectedThreadId || !selectedThread) return;
    // Native subagent transcripts are read-only mirrors — nothing to talk to.
    if (selectedThread.subagent) {
      toast.error('This is a read-only subagent transcript. Steer from the parent thread.');
      return;
    }
    // Guard against being used directly as an event handler (onClick passes
    // the event as the first argument) — only real strings override the draft.
    const forcedText = typeof overrideText === 'string' ? overrideText : null;
    // Read at send time: the draft lives in the composer, not in App state.
    const draft = composerDraft.getDraft();
    const draftText = forcedText ?? draft.text;
    const draftAttachments = draft.attachments;
    const promptText = draftText.trim();
    // Freshly linked board tasks can be sent on their own — the cards are the
    // prompt. Mid-run they can't (queued follow-ups need their own text).
    const canSendLinkedTasksAlone = !isSending && hasPendingLinkedTasks;
    if (!promptText && draftAttachments.length === 0 && !canSendLinkedTasksAlone) return;

    if (selectedThreadWorkspaceUnavailable) {
      toast.error(
        selectedThreadWorkspaceRemoving
          ? 'This thread’s Durango workspace is being removed'
          : 'This thread’s Durango workspace is still being created — try again in a moment'
      );
      return;
    }

    // Sending to a snoozed thread wakes it at once, rather than when the run
    // it starts ends (or right away for a follow-up queued mid-run).
    if (selectedThread.snoozedAt) unsnoozeThread(selectedThreadId);

    // The thread runs on another machine: the turn starts there.
    if (selectedThread.remote) {
      const machineName = selectedThread.remote.machineName;
      if (!promptText && draftAttachments.length === 0) return;
      if (selectedThread.status === 'running' || pendingTurnStartsRef.current.has(selectedThreadId)) {
        pinThreadToBottom(selectedThreadId);
        queueMessageToThread(selectedThreadId, { text: promptText, attachments: draftAttachments });
        composerDraft.clear();
        composerDraft.flush();
        return;
      }
      const submittedThreadId = selectedThreadId;
      composerDraft.clear();
      composerDraft.setStarting(submittedThreadId, true);
      pinThreadToBottom(submittedThreadId);
      const result = await startRemoteTurn(submittedThreadId, promptText, draftAttachments);
      composerDraft.setStarting(submittedThreadId, false);
      composerDraft.flush();
      if (!result.ok) {
        restoreComposerDraft(submittedThreadId, draftText, draftAttachments);
        toast.error(result.error ?? `${machineName} could not start the agent.`);
      }
      return;
    }

    // Claude Code CLI thread: the composer feeds the embedded terminal —
    // the draft is delivered to the TUI exactly as if typed there (so claude
    // slash commands like /compact work too). Nothing goes through runTurn.
    if (isTerminalThread) {
      if (pendingTurnStartsRef.current.has(selectedThreadId)) return;
      const submittedThreadId = selectedThreadId;
      const submittedInput = draftText;
      const submittedAttachments = draftAttachments;
      // Clear before the linked-task refresh so edits made during that wait
      // belong to the current composer and are never erased by this submission.
      composerDraft.clear();
      composerDraft.flush();
      pendingTurnStartsRef.current.add(selectedThreadId);
      try {
        await refreshLinkedTasksBeforeDispatch(submittedThreadId);
      } catch (error) {
        restoreComposerDraft(submittedThreadId, submittedInput, submittedAttachments);
        toast.error(error instanceof Error ? error.message : 'The linked tasks could not be refreshed');
        return;
      } finally {
        pendingTurnStartsRef.current.delete(submittedThreadId);
      }
      const currentThread = useOrionStore.getState().threads.find((thread) => thread.id === submittedThreadId);
      if (currentThread && workspaceRemovalThreadIdsRef.current.has(currentThread.id)) {
        restoreComposerDraft(submittedThreadId, submittedInput, submittedAttachments);
        toast.error('This thread’s Durango workspace is being removed');
        return;
      }
      // Inherited subagent context comes from the transcript.
      const currentMessages = currentThread ? await loadThreadMessages(currentThread.id) : [];
      if (!currentMessages) {
        restoreComposerDraft(submittedThreadId, submittedInput, submittedAttachments);
        toast.error(TRANSCRIPT_UNAVAILABLE_ERROR);
        return;
      }
      const tasksToInject = (currentThread?.linkedTasks ?? []).filter((task) => !task.injected);
      let text = buildPromptWithAttachments(promptText, submittedAttachments);
      if (tasksToInject.length > 0) {
        text = addPromptContext(
          text,
          buildLinkedTaskContext(tasksToInject, Boolean(text)),
          true
        );
      }
      if (currentThread) {
        const inheritedContext = inheritedSubagentResumeContext(currentThread, currentMessages, 'claude');
        if (inheritedContext) text = addPromptContext(text, inheritedContext, true);
      }
      if (!text) {
        restoreComposerDraft(submittedThreadId, submittedInput, submittedAttachments);
        return;
      }
      const restoreTerminalDraft = () => {
        restoreComposerDraft(submittedThreadId, submittedInput, submittedAttachments);
      };
      let result: Awaited<ReturnType<NonNullable<typeof window.orion>['terminalSendPrompt']>> | undefined;
      pendingTurnStartsRef.current.add(submittedThreadId);
      try {
        result = await window.orion?.terminalSendPrompt?.({
          threadId: submittedThreadId,
          text,
        });
      } catch (error) {
        restoreTerminalDraft();
        toast.error(error instanceof Error ? error.message : 'The Claude Code terminal is not running.');
        return;
      } finally {
        pendingTurnStartsRef.current.delete(submittedThreadId);
      }
      if (!result?.ok) {
        restoreTerminalDraft();
        toast.error(result?.error ?? 'The Claude Code terminal is not running.');
        return;
      }
      if (tasksToInject.length > 0) {
        const injectedIds = new Set(tasksToInject.map((task) => task.id));
        const currentLinkedTasks =
          useOrionStore.getState().threads.find((thread) => thread.id === submittedThreadId)?.linkedTasks ?? [];
        if (currentLinkedTasks.some((task) => injectedIds.has(task.id) && !task.injected)) {
          updateThread(submittedThreadId, {
            linkedTasks: currentLinkedTasks.map((task) =>
              injectedIds.has(task.id) ? { ...task, injected: true } : task
            ),
          });
        }
        pushLinkedTaskStatus(
          submittedThreadId,
          'running',
          undefined,
          tasksToInject.map((task) => task.id)
        );
      }
      // Terminal threads have no transcript, so seed the sidebar title from
      // the first prompt sent through the composer.
      if (currentThread && isDefaultTitle(currentThread.title) && promptText) {
        const initialTitle = deriveTitle(promptText);
        const expectedTitle = isPlausibleTitle(initialTitle) ? initialTitle : currentThread.title;
        if (isPlausibleTitle(initialTitle)) {
          updateThread(submittedThreadId, { title: initialTitle });
        }
        void tryGenerateBetterTitle(
          submittedThreadId,
          promptText,
          resolveUtilityTurn(),
          selectedThreadProjectPath ?? '',
          updateThread,
          expectedTitle,
          getStoredThreadTitle
        );
      }
      return;
    }

    // `/goal …` — codex goal management. Handled before the mid-run queue
    // branch: pause/clear act on the live run, and set/resume must never be
    // queued as plain follow-up text. Claude-backed threads fall through so a
    // custom Claude command named /goal still reaches the CLI's expander.
    const goalMatch = promptText.match(/^\/goal(?:\s+([\s\S]+))?$/i);
    if (goalMatch && !selectedThreadClaudeBacked) {
      void handleGoalCommand(promptText, goalMatch[1]?.trim() ?? '');
      return;
    }

    // `/review …` — codex code review (uncommitted / base branch / commit /
    // custom instructions). Also before the queue branch: it must never be
    // queued as plain follow-up text. Claude-backed threads fall through:
    // Claude Code has its own /review, expanded CLI-side like any other
    // slash command.
    const reviewCommand = parseCodexReviewCommand(promptText);
    if (reviewCommand && !selectedThreadClaudeBacked) {
      handleReviewCommand(promptText);
      return;
    }

    // `/btw <question>` — side question, handled before the mid-run queue
    // branch because asking while the agent works is exactly its use case.
    const btwMatch = promptText.match(/^\/btw(?:\s+([\s\S]+))?$/i);
    if (btwMatch) {
      const question = btwMatch[1]?.trim();
      if (!question) {
        toast.error('Ask something after /btw, e.g. “/btw why did you pick zustand?”');
        return;
      }
      const result = askBtwQuestion(selectedThreadId, question);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      composerDraft.setText('');
      return;
    }

    // `/clear` — Claude: drop the thread's persistent session so the next
    // message starts with fresh context. The transcript stays; a divider
    // marks the boundary. Never sent to the model, never queued.
    if (selectedThreadClaudeBacked && /^\/clear$/i.test(promptText)) {
      if (isSending) {
        toast.error('Stop the run before using /clear.');
        return;
      }
      const clearedThreadId = selectedThreadId;
      const clearedThread = selectedThread;
      composerDraft.setText('');
      // The fresh session can't see what the old suggestion refers to; a late
      // one from the cleared session is dropped as a superseded run.
      latestStartedRunByThread.current.delete(clearedThreadId);
      setPromptSuggestions((current) => {
        if (!(clearedThreadId in current)) return current;
        const { [clearedThreadId]: _cleared, ...rest } = current;
        return rest;
      });
      void window.orion?.clearClaudeSession?.(clearedThreadId).catch(() => {});
      updateThread(clearedThreadId, {
        agentSessionIds: { ...clearedThread.agentSessionIds, claude: undefined },
      });
      addMessageToThread(clearedThreadId, {
        role: 'system',
        content: 'Context cleared — the next message starts a fresh Claude session.',
      });
      return;
    }

    // `/model` — open the model picker instead of sending anything.
    if (/^\/model$/i.test(promptText)) {
      if (isSending) {
        toast.error('Stop the run before switching models.');
        return;
      }
      composerDraft.setText('');
      const providerId = selectedAgentModel?.providerId;
      if (providerId) setActiveProviderTab(providerId);
      setModelPickerOpen(true);
      return;
    }

    // Agent mid-run: hold the message; it dispatches when the current turn ends.
    if (isSending) {
      pinThreadToBottom(selectedThreadId);
      queueMessageToThread(selectedThreadId, {
        text: promptText,
        attachments: draftAttachments,
      });
      composerDraft.clear();
      composerDraft.flush();
      return;
    }

    const submittedThreadId = selectedThreadId;
    const submittedInput = draftText;
    const submittedAttachments = draftAttachments;
    // Empty the composer and show "Starting" before any preflight (linked-task
    // refresh, workspace setup, mention checks) — only the composer re-renders.
    // A failed start restores the draft below.
    composerDraft.clear();
    composerDraft.setStarting(submittedThreadId, true);
    let result: { ok: boolean; error?: string };
    try {
      const turnStart = startTurnForThread(submittedThreadId, promptText, submittedAttachments);
      // The sent draft is gone from disk too (after the turn's synchronous
      // start, so it never delays it).
      composerDraft.flush();
      result = await turnStart;
    } catch (error) {
      composerDraft.setStarting(submittedThreadId, false);
      restoreComposerDraft(submittedThreadId, submittedInput, submittedAttachments);
      toast.error(error instanceof Error ? error.message : 'The agent turn could not start');
      return;
    }
    composerDraft.setStarting(submittedThreadId, false);
    if (!result.ok) {
      restoreComposerDraft(submittedThreadId, submittedInput, submittedAttachments);
      toast.error(result.error);
      return;
    }
    setModelPickerOpen(false);
    setCodexSettingsOpen(false);
    setAccessModeOpen(false);
  };

  // Steering = redirect the run in flight immediately. Main interrupts the
  // current Claude loop, hides that transport-only result boundary, and
  // continues under the same visible run id. If the interrupt cannot land,
  // the message falls back to the ordinary end-of-turn queue.
  // Optional chain: 'orion' has no follow-up-support entry (steering an
  // orchestrated thread would bypass the driver resolution), so treat it as
  // unsupported instead of crashing mid-run.
  const selectedRemoteRunning = Boolean(selectedThread?.remote) && selectedThread?.status === 'running';
  const steerSupported =
    (isSending || selectedRemoteRunning) &&
    !!selectedAgentModel &&
    providerFollowUpSupport[selectedAgentModel.providerId]?.steer === true;
  const steerReady =
    steerSupported &&
    (selectedRemoteRunning
      ? Boolean(selectedThread?.remote?.threadId && window.orion?.remoteSteerTurn)
      : !!window.orion?.steerAgentTurn);

  const steerTargetForThread = (threadId: string) => {
    const runId = activeRunsByThreadRef.current[threadId];
    const thread = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
    const agentModel = thread
      ? findAgentModel(agentModels, thread.modelId ?? defaultAgentModelId)
      : undefined;
    if (
      !runId ||
      !thread ||
      !agentModel ||
      providerFollowUpSupport[agentModel.providerId]?.steer !== true ||
      !window.orion?.steerAgentTurn
    ) {
      return null;
    }
    return { runId, agentModel };
  };
  // A thread on another machine (remote control) is steered there: its turn
  // runs on that machine, so there is no local run to push into.
  const remoteSteerTarget = (threadId: string) => {
    const thread = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
    const remote = thread?.remote;
    if (!thread || !remote?.threadId || thread.status !== 'running' || !window.orion?.remoteSteerTurn) return null;
    const agentModel = findAgentModel(agentModels, thread.modelId ?? defaultAgentModelId);
    if (!agentModel || providerFollowUpSupport[agentModel.providerId]?.steer !== true) return null;
    return { machineId: remote.machineId, machineName: remote.machineName, threadId: remote.threadId };
  };
  const canSteerNow = () =>
    !!selectedThreadId && !!(steerTargetForThread(selectedThreadId) ?? remoteSteerTarget(selectedThreadId));

  // Steer a remote thread's running turn. The message stays this machine's
  // until that machine has put it into the turn: anything it refuses goes
  // back into the queue here (and sends when the turn ends, as an
  // unsteerable local turn's would), or to the composer after a Stop.
  // Serialized per thread with the steering coordinator, so steers arrive in
  // the order they were made, and the queue holds its end-of-turn send while
  // one is on its way.
  const steerRemoteThread = (
    threadId: string,
    promptText: string,
    attachments: FileAttachment[],
    queuedId?: string
  ): Promise<void> => {
    const store = useOrionStore.getState();
    const queue = store.threads.find((candidate) => candidate.id === threadId)?.queuedMessages ?? [];
    const index = queuedId ? queue.findIndex((queued) => queued.id === queuedId) : queue.length;
    const message = queuedId ? queue[index] : { id: crypto.randomUUID(), text: promptText, attachments };
    if (!message) return Promise.resolve();
    // What followed it, to go back in front of (an index would drift while
    // other steers are out of the queue too).
    const followers = queue.slice(index + 1).map((queued) => queued.id);
    if (queuedId) removeQueuedThreadMessage(threadId, queuedId);
    const pending = pendingRemoteSteersRef.current;
    pending.set(threadId, (pending.get(threadId) ?? 0) + 1);
    const restore = (cancelled: boolean) => {
      if (cancelled) {
        // Stopped meanwhile: like the rest of the queue at Stop, back to
        // the composer rather than out to that machine as a new turn.
        restoreComposerDraft(threadId, message.text, message.attachments ?? []);
        return;
      }
      const current =
        useOrionStore.getState().threads.find((candidate) => candidate.id === threadId)?.queuedMessages ?? [];
      if (current.some((queued) => queued.id === message.id)) return;
      const before = current.findIndex((queued) => followers.includes(queued.id));
      const next = [...current];
      next.splice(before === -1 ? next.length : before, 0, message);
      updateThread(threadId, { queuedMessages: next });
    };
    pinThreadToBottom(threadId);
    return steeringCoordinatorRef.current
      .enqueue(threadId, async (cancelled: () => boolean) => {
        if (cancelled()) return restore(true);
        const target = remoteSteerTarget(threadId);
        if (!target || !window.orion?.remoteSteerTurn) return restore(false);
        const result = await window.orion
          .remoteSteerTurn({
            machineId: target.machineId,
            threadId: target.threadId,
            prompt: message.text,
            attachments: message.attachments ?? [],
          })
          .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : undefined }));
        if (result?.ok) {
          // The steered message shows once the mirror has that machine's copy.
          remoteThreadSyncRef.current?.refreshSoon(threadId, { force: true });
          return;
        }
        restore(cancelled());
        if (!cancelled()) {
          toast.info(
            `Couldn't steer the turn on ${target.machineName}${result?.error ? ` (${result.error})` : ''} — the message will send when it ends.`
          );
        }
      })
      .finally(() => {
        const count = (pending.get(threadId) ?? 1) - 1;
        if (count > 0) pending.set(threadId, count);
        else pending.delete(threadId);
        // Let the queue send what it held back.
        setQueueRetryTick((tick) => tick + 1);
      });
  };

  const recordSteeredMessage = (
    threadId: string,
    runId: string,
    prepared: { userContent: string; tasksToInject: LinkedBoardTask[]; turnAttachments: FileAttachment[] }
  ) => {
    // Delivered into the live turn: record the fully prepared instruction in
    // the transcript and consume the linked-task context exactly once.
    pinThreadToBottom(threadId);
    // Split the transcript at the steer point. The run streams into one
    // agent-run bubble, so appending the user message alone would leave it
    // pinned under a bubble that keeps growing above it (and the composer's
    // "Starting agent..." placeholder showing for a run already in flight).
    // Close out the current bubble first; after the user message lands below,
    // retarget the run's output to a fresh bubble so the rest of the turn
    // renders in reading order. A bubble with no output yet moves below the
    // steered message instead — closing it would leave an empty zero-second
    // "Response" above the steer point. (Steering a retained background run
    // hits this: the driver opens a fresh turn and its `started {background}`
    // event can create the tracked bubble before this IPC reply resolves.)
    flushChunkBuffers();
    const trackedRun = runOutputMessages.current.get(runId);
    const splitRun = trackedRun && trackedRun.threadId === threadId ? trackedRun : undefined;
    const splitMessage = splitRun
      ? loadedMessages(threadId)?.find((message) => message.id === splitRun.messageId)
      : undefined;
    const moveSplitMessage =
      !!splitMessage &&
      splitMessage.content.length === 0 &&
      (splitMessage.activities?.length ?? 0) === 0;
    if (splitMessage && !moveSplitMessage) {
      updateThreadMessage(threadId, splitMessage.id, {
        status: 'done',
        completedAt: new Date().toISOString(),
        statusText: STEERED_RUN_CAPTION,
      });
    }
    if (prepared.tasksToInject.length > 0) {
      const injectedIds = new Set(prepared.tasksToInject.map((task) => task.id));
      const currentLinkedTasks =
        useOrionStore.getState().threads.find((thread) => thread.id === threadId)?.linkedTasks ?? [];
      updateThread(threadId, {
        linkedTasks: currentLinkedTasks.map((task) =>
          injectedIds.has(task.id) ? { ...task, injected: true } : task
        ),
      });
      pushLinkedTaskStatus(threadId, 'running');
    }
    addMessageToThread(threadId, {
      role: 'user',
      content: prepared.userContent,
      attachments: prepared.turnAttachments,
      steer: true,
      ...(prepared.tasksToInject.length > 0
        ? {
            linkedTasks: prepared.tasksToInject.map((task) => ({
              id: task.id,
              title: task.title,
              description: task.description,
            })),
          }
        : {}),
    });
    if (splitMessage && moveSplitMessage) {
      // Same run, same bubble — it just hasn't streamed anything yet, so
      // repositioning it below the steered message keeps reading order
      // without leaving an empty closed bubble behind. No retarget needed.
      useOrionStore.getState().updateThreadTranscript(threadId, (transcript) => {
        const bubble = transcript.messages.find((message) => message.id === splitMessage.id);
        if (!bubble) return transcript;
        return {
          ...transcript,
          messages: [...transcript.messages.filter((message) => message.id !== bubble.id), bubble],
        };
      });
    } else if (splitMessage) {
      const continuationMessageId = addMessageToThread(threadId, {
        role: 'agent',
        content: '',
        kind: 'agent-run',
        status: 'running',
        statusText: "I'm working on this now.",
        startedAt: new Date().toISOString(),
        activities: [],
        ...(splitMessage.command ? { command: splitMessage.command } : {}),
        ...(splitMessage.modelId ? { modelId: splitMessage.modelId } : {}),
      });
      runOutputMessages.current.set(runId, {
        threadId,
        messageId: continuationMessageId,
      });
    }
  };

  const performSteerWithContent = async (
    threadId: string,
    promptText: string,
    attachments: FileAttachment[],
    cancelled: () => boolean,
    {
      queueFallback = true,
      beforeInject,
    }: {
      /**
       * false: a message that can't go into the turn is handed back
       * ('unsteered') instead of queued here (a paired controller's steer,
       * which stays in that machine's queue).
       */
      queueFallback?: boolean;
      /** Last gate before the message goes into the turn (a remote command's claim). */
      beforeInject?: () => Promise<boolean>;
    } = {}
  ): Promise<SteerOutcome> => {
    if (!promptText && attachments.length === 0) return 'cancelled';
    // Fallback for every path that can't inject: hold the message and let the
    // queue-dispatch effect send it — immediately if the thread is idle,
    // otherwise the moment the current turn ends. Never interrupts anything.
    const queueForTurnEnd = (): SteerOutcome => {
      if (cancelled()) return 'cancelled';
      if (!queueFallback) return 'unsteered';
      pinThreadToBottom(threadId);
      queueMessageToThread(threadId, { text: promptText, attachments });
      return 'queued';
    };
    const target = steerTargetForThread(threadId);
    if (!target) {
      return queueForTurnEnd();
    }
    let prepared:
      | {
          agentPrompt: string;
          tasksToInject: LinkedBoardTask[];
          turnAttachments: FileAttachment[];
          userContent: string;
        }
      | undefined;
    try {
      // Steering is still a real dispatch: refresh newly linked Board tasks
      // and resolve mention tokens exactly as an ordinary turn does before
      // handing the text to Claude's live input stream.
      await refreshLinkedTasksBeforeDispatch(threadId);
      if (cancelled()) return 'cancelled';
      if (activeRunsByThreadRef.current[threadId] !== target.runId) {
        return queueForTurnEnd();
      }
      let state = useOrionStore.getState();
      let thread = state.threads.find((candidate) => candidate.id === threadId);
      if (!thread) {
        return queueForTurnEnd();
      }
      const mentionedThreads = promptText
        ? parseThreadMentions(promptText, state.threads, threadId)
        : [];
      const mentionedChats = promptText ? parseChatMentions(promptText, knownDurangoChats()) : [];
      if (mentionedThreads.length > 0 || mentionedChats.length > 0) {
        const supportsThreadReader =
          (await window.orion?.supportsThreadReader?.(target.agentModel.providerId)) === true;
        if (cancelled()) return 'cancelled';
        if (activeRunsByThreadRef.current[threadId] !== target.runId) {
          return queueForTurnEnd();
        }
        if (
          !supportsThreadReader ||
          (mentionedThreads.length > 0 && !(await flushOrionThreadsSave()))
        ) {
          return queueForTurnEnd();
        }
        if (cancelled()) return 'cancelled';
        if (activeRunsByThreadRef.current[threadId] !== target.runId) {
          return queueForTurnEnd();
        }
        state = useOrionStore.getState();
        thread = state.threads.find((candidate) => candidate.id === threadId);
        if (!thread) {
          return queueForTurnEnd();
        }
      }

      // Inherited subagent context comes from the transcript.
      const threadMessages = await loadThreadMessages(thread.id);
      if (cancelled()) return 'cancelled';
      if (!threadMessages || activeRunsByThreadRef.current[threadId] !== target.runId) {
        return queueForTurnEnd();
      }
      const tasksToInject = (thread.linkedTasks ?? []).filter((task) => !task.injected);
      const taskAttachments = linkedTaskAttachments(tasksToInject);
      const turnAttachments = [...taskAttachments, ...attachments];
      let agentPrompt = buildPromptWithAttachments(promptText, attachments);
      const preserveSlashCommandStart = promptText.trimStart().startsWith('/');
      const addAgentContext = (context: string | null) => {
        if (context) {
          agentPrompt = addPromptContext(agentPrompt, context, preserveSlashCommandStart);
        }
      };
      if (tasksToInject.length > 0) {
        addAgentContext(buildLinkedTaskContext(tasksToInject, Boolean(agentPrompt)));
      }
      addAgentContext(
        inheritedSubagentResumeContext(thread, threadMessages, target.agentModel.providerId)
      );
      const mentionedModels = promptText ? parseModelMentions(promptText, agentModels) : [];
      if (mentionedModels.length > 0) {
        addAgentContext(buildModelMentionsContext(mentionedModels));
      }
      const mentionedMcps = promptText ? parseMcpMentions(promptText, orionMcpsRef.current) : [];
      if (mentionedMcps.some((server) => !(thread?.mcpServerIds ?? []).includes(server.id))) {
        // A newly attached MCP server can only be loaded when a turn starts.
        return queueForTurnEnd();
      }
      if (mentionedMcps.length > 0) {
        addAgentContext(buildMcpMentionsContext(mentionedMcps));
      }
      if (mentionedThreads.length > 0) {
        addAgentContext(
          buildThreadMentionsContext(
            mentionedThreads,
            new Map(state.projects.map((project) => [project.id, project.name]))
          )
        );
      }
      if (mentionedChats.length > 0) {
        addAgentContext(buildChatMentionsContext(mentionedChats));
      }
      prepared = {
        agentPrompt,
        tasksToInject,
        turnAttachments,
        userContent: promptText || (attachments.length > 0 ? 'Attached file' : ''),
      };
    } catch {
      prepared = undefined;
    }
    if (cancelled()) return 'cancelled';
    if (!prepared) {
      return queueForTurnEnd();
    }
    // Preparation may have outlived the run it targeted. A natural finish
    // becomes an ordinary queued follow-up; Stop is distinguished by the
    // generation check above and discards the pending steer instead.
    if (activeRunsByThreadRef.current[threadId] !== target.runId) {
      return queueForTurnEnd();
    }
    if (beforeInject) {
      if (!(await beforeInject()) || cancelled()) return 'cancelled';
      if (activeRunsByThreadRef.current[threadId] !== target.runId) return queueForTurnEnd();
    }
    let injected = false;
    try {
      injected =
        (await window.orion?.steerAgentTurn?.(
          target.runId,
          prepared.agentPrompt,
          prepared.turnAttachments
        )) === true;
    } catch {
      injected = false;
    }
    if (cancelled()) {
      // Stopped while the push was landing. A paired controller's message
      // that did go in is delivered: say so (and show it), or that machine
      // would send it again. The stopped run itself is left as Stop left it.
      if (injected && !queueFallback) {
        addMessageToThread(threadId, {
          role: 'user',
          content: prepared.userContent,
          attachments: prepared.turnAttachments,
          steer: true,
        });
        return 'steered';
      }
      return 'cancelled';
    }
    // The run settled (or its session vanished) before the push could land —
    // the message becomes an ordinary follow-up turn instead.
    if (!injected) {
      // A run that already finished dispatches the queue right away; only a
      // rejection while it is still running needs explaining.
      if (queueFallback && activeRunsByThreadRef.current[threadId] === target.runId) {
        toast.info("Couldn't steer the running turn — the message will send when it ends.");
      }
      return queueForTurnEnd();
    }
    recordSteeredMessage(threadId, target.runId, prepared);
    return 'steered';
  };

  const steerWithContent = (
    threadId: string,
    promptText: string,
    attachments: FileAttachment[]
  ): Promise<SteerOutcome> => {
    // enqueue captures cancellation identity and publishes the reservation
    // synchronously. Later submissions preserve user order through preflight,
    // IPC dispatch, and linked-task consumption.
    return steeringCoordinatorRef.current.enqueue(threadId, (cancelled) =>
      performSteerWithContent(threadId, promptText, attachments, cancelled)
    );
  };

  // The approval card's "What it will do": a hidden turn on the
  // text-generation model. Without one, the card shows the call as is.
  const explainApproval: ExplainApproval | undefined =
    window.orion?.explainApproval && resolveUtilityTurn().modelId
      ? (approval, key) => {
          const turn = resolveUtilityTurn();
          const thread = selectedThread;
          if (!turn.modelId || !thread) return Promise.resolve(null);
          return (
            window.orion?.explainApproval?.({
              key,
              threadId: thread.id,
              approval,
              modelId: turn.modelId,
              reasoningEffort: turn.reasoningEffort,
              // A remote thread's folder is on its own machine.
              projectPath: thread.remote ? undefined : (activeWorkingDir ?? undefined),
            }) ?? Promise.resolve(null)
          );
        }
      : undefined;

  const answerAsyncQuestion = (
    request: CodexQuestionRequest,
    answers: Record<string, string[]>
  ): Promise<boolean> => steeringCoordinatorRef.current.enqueue(request.threadId, async (cancelled) => {
    if (cancelled()) return false;
    const text = asyncAnswerText(request, answers);
    const accepted = await window.orion?.answerCodexQuestions?.(request.runId, request.requestId, answers, text);
    if (cancelled() || !accepted) return false;
    if (accepted === 'delivered') {
      recordSteeredMessage(request.threadId, request.runId, { userContent: text, tasksToInject: [], turnAttachments: [] });
    } else {
      // Keep the original cancellation identity through fallback preparation
      // and dispatch. Re-enqueueing here would capture a post-Stop generation.
      await performSteerWithContent(request.threadId, text, [], cancelled);
    }
    return !cancelled();
  });

  // Composer ⚡ / ⌘⏎: steer with the current draft.
  const steerActiveAgent = async () => {
    if (!canSteerNow()) return;
    const draft = composerDraft.getDraft();
    const promptText = draft.text.trim();
    const attachments = draft.attachments;
    if (!promptText && attachments.length === 0) return;
    composerDraft.clear();
    composerDraft.flush();
    if (!selectedThreadId) return;
    if (selectedThread?.remote) {
      await steerRemoteThread(selectedThreadId, promptText, attachments);
      return;
    }
    await steerWithContent(selectedThreadId, promptText, attachments);
  };

  // "Steer now" on a queued transcript bubble: deliver that message into the
  // running turn immediately instead of waiting for the turn to end.
  const steerQueuedMessageRef = useRef<(threadId: string, queuedId: string) => Promise<void>>(
    async () => {}
  );
  useLayoutEffect(() => {
    steerQueuedMessageRef.current = async (threadId: string, queuedId: string) => {
      if (useOrionStore.getState().threads.find((candidate) => candidate.id === threadId)?.remote) {
        const queued = useOrionStore
          .getState()
          .threads.find((candidate) => candidate.id === threadId)
          ?.queuedMessages?.find((q) => q.id === queuedId);
        if (!queued) return;
        await steerRemoteThread(threadId, queued.text, queued.attachments ?? [], queuedId);
        return;
      }
      if (!steerTargetForThread(threadId)) return;
      const thread = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
      const queued = thread?.queuedMessages?.find((q) => q.id === queuedId);
      if (!queued) return;
      removeQueuedThreadMessage(threadId, queuedId);
      await steerWithContent(threadId, queued.text, queued.attachments ?? []);
    };
  });
  const steerQueuedMessage = useCallback((threadId: string, queuedId: string) => {
    void steerQueuedMessageRef.current(threadId, queuedId);
  }, []);

  const stopThreadTree = async ({
    rootThreadId,
    stoppedText,
    spawnStoppedText,
    restoreRootQueueToComposer = false,
  }: {
    rootThreadId: string;
    stoppedText: string;
    spawnStoppedText: string;
    restoreRootQueueToComposer?: boolean;
  }): Promise<boolean> => {
    if (!window.orion?.stopAgentTurn) return false;
    const state = useOrionStore.getState();
    const rootThread = state.threads.find((thread) => thread.id === rootThreadId);
    if (!rootThread) return false;
    const threadIds = descendantThreadIds(state.threads, rootThread.id);
    // Turns its agent started on other machines (machine_run_agent) stop
    // there, and their queued follow-ups go (or they'd start again once that
    // machine reports them idle); their mirrors here keep the status that
    // machine reports.
    for (const candidate of state.threads) {
      if (candidate.id === rootThread.id || !threadIds.has(candidate.id) || !candidate.remote) continue;
      if ((candidate.queuedMessages?.length ?? 0) > 0) updateThread(candidate.id, { queuedMessages: [] });
      const hostThreadId = candidate.remote.threadId;
      if (candidate.status === 'running' && hostThreadId && window.orion?.remoteStopTurn) {
        void window.orion
          .remoteStopTurn({ machineId: candidate.remote.machineId, threadId: hostThreadId })
          .catch(() => undefined)
          .finally(() => remoteThreadSync.refreshSoon(candidate.id));
      }
    }
    const stoppedThreads = state.threads.filter(
      (candidate) => threadIds.has(candidate.id) && (candidate.id === rootThread.id || !candidate.remote)
    );
    const runsByThread = mergeSynchronouslyTrackedRuns(
      activeRunsByThreadRef.current,
      runOutputMessages.current
    );
    const runsToStop: Array<{ threadId: string; runId: string }> = [];
    for (const candidate of stoppedThreads) {
      const runId = runsByThread.get(candidate.id);
      if (runId) runsToStop.push({ threadId: candidate.id, runId });
    }
    if (runsToStop.length === 0) return false;

    // Stop cancellation is synchronous with the user's action. Any steering
    // refresh/save/IPC completion carrying an older generation must now exit
    // without restoring its prompt to the queue.
    cancelPendingSteers(threadIds);
    // Stop means "halt everything": clear every queued follow-up before any
    // active mapping is released, otherwise the queue-dispatch effect can
    // immediately start another turn. A local button restores only the root
    // queue to its visible composer; remote Stop has no local composer target
    // and deliberately discards it along with descendant queues.
    const queued = rootThread.queuedMessages ?? [];
    if (queued.length > 0) {
      updateThread(rootThread.id, { queuedMessages: [] });
    }
    if (restoreRootQueueToComposer && queued.length > 0) {
      composerDraft.setText((current) => [...queued.map((q) => q.text), current].filter(Boolean).join('\n\n'));
      composerDraft.setAttachments((current) => [...queued.flatMap((q) => q.attachments ?? []), ...current]);
    }
    const pendingSpawnIds: string[] = [];

    for (const stoppedThread of stoppedThreads) {
      if (stoppedThread.status === 'running') updateThread(stoppedThread.id, { status: 'idle' });
      if (stoppedThread.id !== rootThread.id && (stoppedThread.queuedMessages?.length ?? 0) > 0) {
        updateThread(stoppedThread.id, { queuedMessages: [] });
      }
      if (stoppedThread.spawnId) {
        updateThread(stoppedThread.id, { spawnId: undefined });
        pendingSpawnIds.push(stoppedThread.spawnId);
      }
    }

    // Untrack and mark every run in the subtree stopped BEFORE the IPC calls:
    // interrupted result events can otherwise race in and mark them Finished.
    for (const { threadId: runThreadId, runId } of runsToStop) {
      const tracked = runOutputMessages.current.get(runId);
      runOutputMessages.current.delete(runId);
      clearActiveRun(runId);
      if (tracked) {
        appendToThreadMessage(tracked.threadId, tracked.messageId, `\n\n${stoppedText}`);
        updateThreadMessage(tracked.threadId, tracked.messageId, {
          status: 'stopped',
          completedAt: new Date().toISOString(),
          statusText: stoppedText,
        });
      } else {
        markUntrackedRunStopped(runThreadId, stoppedText);
      }
    }
    flushChunkBuffers();

    // Each Orion child is its own provider runtime, so terminate every active
    // run and dispose every descendant before unblocking the parent's tool.
    await Promise.all(runsToStop.map(({ runId }) => window.orion.stopAgentTurn(runId, { terminateBackground: true })));
    await Promise.all(
      stoppedThreads
        .filter((candidate) => candidate.id !== rootThread.id)
        .map((candidate) => disposeThreadRuntime(candidate.id))
    );
    for (const spawnId of pendingSpawnIds) {
      void window.orion?.reportSubagentResult?.({
        spawnId,
        ok: false,
        result: spawnStoppedText,
      });
    }
    return true;
  };

  const stopActiveAgent = async () => {
    const remote = selectedThread?.remote;
    if (remote && selectedThreadId) {
      const stoppedThreadId = selectedThreadId;
      // Steers still on their way go back to the composer, not out to it.
      cancelPendingSteers([stoppedThreadId]);
      // Like a local Stop: the follow-ups waiting on this run go back to the
      // composer rather than out to that machine once it stops.
      const queued = selectedThread?.queuedMessages ?? [];
      if (queued.length > 0) {
        updateThread(stoppedThreadId, { queuedMessages: [] });
        composerDraft.setText((current) => [...queued.map((q) => q.text), current].filter(Boolean).join('\n\n'));
        composerDraft.setAttachments((current) => [...queued.flatMap((q) => q.attachments ?? []), ...current]);
      }
      if (!remote.threadId || !window.orion?.remoteStopTurn) {
        updateThread(stoppedThreadId, { status: 'idle' });
        return;
      }
      const result = await window.orion
        .remoteStopTurn({ machineId: remote.machineId, threadId: remote.threadId })
        .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : undefined }));
      if (!result?.ok) {
        // Unreachable (offline, unpaired, remote control off): don't leave the
        // thread stuck as running here. The next refresh from that machine
        // shows it running again if it still is.
        updateThread(stoppedThreadId, { status: 'idle' });
        toast.error(
          `Could not reach ${remote.machineName} to stop the agent${result?.error ? ` (${result.error})` : ''}. Marked stopped here; it may still be running there.`
        );
      }
      remoteThreadSync.refreshSoon(stoppedThreadId, { force: !result?.ok });
      return;
    }
    if (!activeRunId || !selectedThreadId) return;
    await stopThreadTree({
      rootThreadId: selectedThreadId,
      stoppedText: 'Stopped by user.',
      spawnStoppedText: 'Subagent run was stopped by the user before completing.',
      restoreRootQueueToComposer: true,
    });
  };

  const discardClaudeBackgroundTasks = useCallback(
    async (threadId: string, messageId: string, runId: string) => {
      // Clicked on a card in an open transcript, so it is loaded.
      const thread = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
      const message = loadedMessages(threadId)?.find((candidate) => candidate.id === messageId);
      const intervention = message?.claudeBackgroundIntervention;
      if (!thread || !message || !intervention || intervention.runId !== runId) return;

      updateThreadMessage(threadId, messageId, {
        claudeBackgroundIntervention: {
          ...intervention,
          status: 'stopping',
          error: undefined,
        },
      });

      let result:
        | { ok: boolean; alreadySettled?: boolean; tasks?: string[]; error?: string }
        | undefined;
      try {
        result = await window.orion?.discardClaudeBackgroundShellTasks?.(runId);
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof Error ? error.message : 'Durango Code could not stop the background processes.',
        };
      }

      const currentMessage = (await ensureThreadTranscript(threadId).catch(() => null))?.messages.find(
        (candidate) => candidate.id === messageId
      );
      const currentIntervention = currentMessage?.claudeBackgroundIntervention;
      if (!currentIntervention || currentIntervention.runId !== runId) return;

      if (!result?.ok) {
        updateThreadMessage(threadId, messageId, {
          claudeBackgroundIntervention: {
            ...currentIntervention,
            status: 'error',
            error: result?.error ?? 'Durango Code could not stop the background processes.',
          },
        });
        return;
      }

      updateThreadMessage(threadId, messageId, {
        claudeBackgroundIntervention: {
          ...currentIntervention,
          status: result.alreadySettled ? 'settled' : 'stopped',
          error: undefined,
        },
      });
      const currentRunId = activeRunsByThreadRef.current[threadId];
      // A newer foreground turn may have taken ownership while this click was
      // in flight. Resolve the historical card, but never finish that newer
      // work or clear its run mapping.
      if (currentRunId && currentRunId !== runId) return;
      if (currentRunId === runId) clearActiveRun(runId);
      const freshThread = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
      if (freshThread?.status === 'running') {
        // Running: its transcript is loaded.
        const lastRun = [...(loadedMessages(threadId) ?? [])]
          .reverse()
          .find((candidate) => candidate.kind === 'agent-run');
        updateThread(threadId, { status: 'done' });
        notifyThreadFinished(threadId, 'done');
        pushLinkedTaskStatus(threadId, 'finished', lastRun?.content.trim() || undefined);
        if (lastRun?.status === 'done') {
          updateThreadMessage(threadId, lastRun.id, {
            statusText: result.alreadySettled
              ? 'Finished.'
              : 'Finished — background shell processes stopped by user.',
          });
        }
      }
    },
    [
      clearActiveRun,
      notifyThreadFinished,
      pushLinkedTaskStatus,
      updateThread,
      updateThreadMessage,
    ]
  );

  // Remote runTurn/stopTurn commands from paired controllers (host side of
  // remote control). Executed exactly like local user actions so this
  // machine's UI and store remain authoritative; the outcome is reported back
  // to unblock the controller's pending request. Ref-forwarded (like
  // steerQueuedMessageRef) so the mount-once subscription always sees the
  // committed render's closures.
  const remoteCommandHandlerRef = useRef<
    (
      command: RemoteCommandRequest['command'],
      canPrepare: () => boolean,
      claimStart: () => Promise<boolean>
    ) => Promise<{
      ok: boolean;
      threadId?: string;
      threadTitle?: string;
      projectId?: string;
      error?: string;
    }>
  >(async () => ({ ok: false, error: 'Remote commands are unavailable.' }));
  useLayoutEffect(() => {
    remoteCommandHandlerRef.current = async (command, canPrepare, claimStart) => {
      const state = useOrionStore.getState();
      // A thread that itself runs on another machine is that machine's to
      // drive (and isn't listed to controllers): no relaying through here.
      if (command.threadId && state.threads.find((candidate) => candidate.id === command.threadId)?.remote) {
        return { ok: false, error: 'That thread runs on another machine.' };
      }
      if (command.kind === 'runTurn') {
        const promptText = (command.prompt ?? '').trim();
        if (!promptText && !(command.attachments?.length ?? 0)) return { ok: false, error: 'Empty prompt.' };
        // Main already dropped unknown access modes / effort values; re-validate
        // here so the thread never stores a value the local picker could not set.
        const requestedAccessMode =
          command.accessMode &&
          accessModeOptions.some((option) => option.value === command.accessMode)
            ? command.accessMode
            : undefined;
        const requestedReasoningEffort = command.reasoningEffort;
        const requestedCodexServiceTier =
          command.codexServiceTier === 'default' || command.codexServiceTier === 'priority'
            ? command.codexServiceTier
            : undefined;
        const requestedClaudeContextWindow =
          command.claudeContextWindow === '200k' || command.claudeContextWindow === '1m'
            ? command.claudeContextWindow
            : undefined;
        let threadId: string;
        let createdThread = false;
        let turnModelId: string | undefined;
        let applyClaimedSettings: (() => void) | undefined;
        if (command.threadId) {
          const thread = state.threads.find((candidate) => candidate.id === command.threadId);
          if (!thread) return { ok: false, error: 'Thread not found on this machine.' };
          const unsupportedError = remoteThreadRunError(thread.modelId);
          if (unsupportedError) return { ok: false, threadId: thread.id, error: unsupportedError };
          // React publishes activeRunsByThreadRef only after a render. The
          // output registry and pending-start set are updated synchronously,
          // so they close admission before a concurrent remote request can
          // launch a second process for the same thread.
          const synchronouslyTracked =
            pendingTurnStartsRef.current.has(thread.id) ||
            [...runOutputMessages.current.values()].some((tracked) => tracked.threadId === thread.id);
          if (
            synchronouslyTracked ||
            Boolean(activeRunsByThreadRef.current[thread.id])
          ) {
            return { ok: false, error: 'That thread is already running a turn.' };
          }
          // Same store action as the local model/access pickers. Unknown model
          // ids are silently ignored (matching the new-thread path), and the
          // terminal pseudo-model stays local-only.
          const patch: Partial<
            Pick<
              Thread,
              | 'modelId'
              | 'accessMode'
              | 'codexReasoningEffort'
              | 'codexServiceTier'
              | 'claudeReasoningEffort'
              | 'claudeContextWindow'
              | 'grokReasoningEffort'
              | 'museReasoningEffort'
              | 'openCodeReasoningEffort'
            >
          > = {};
          if (
            command.modelId &&
            command.modelId !== thread.modelId &&
            command.modelId !== claudeCodeCliModelId &&
            agentModelsRef.current.some((model) => model.id === command.modelId)
          ) {
            patch.modelId = command.modelId;
          }
          if (requestedAccessMode && requestedAccessMode !== thread.accessMode) {
            patch.accessMode = requestedAccessMode;
          }
          // Apply provider-specific agent settings against the model that will
          // actually run (pending model switch, else the thread's current one).
          const targetModelId = patch.modelId ?? thread.modelId;
          turnModelId = targetModelId;
          const targetModel = findAgentModel(agentModelsRef.current, targetModelId);
          Object.assign(
            patch,
            remoteAgentSettingsPatch(thread, targetModel, {
              reasoningEffort: requestedReasoningEffort,
              codexServiceTier: requestedCodexServiceTier,
              claudeContextWindow: requestedClaudeContextWindow,
            }) as Partial<Thread>
          );
          if (Object.keys(patch).length > 0) {
            // Renderer preparation (including linked-task refresh below) may
            // outlive the remote command. Commit controller-requested thread
            // settings only after main atomically claims the command.
            applyClaimedSettings = () => updateThread(thread.id, patch);
          }
          threadId = thread.id;
        } else {
          const project = findProjectById(state, command.projectId);
          if (!project) return { ok: false, error: 'Project not found on this machine.' };
          threadId = state.createThread(project.id, undefined, {
            ...(command.modelId && agentModelsRef.current.some((model) => model.id === command.modelId)
              ? { modelId: command.modelId }
              : {}),
            ...(requestedAccessMode ? { accessMode: requestedAccessMode } : {}),
            // An agent on the controller started it (machine_run_agent): its
            // subagent, not something the user started, so not in Recent here
            // either (still listed under its project).
            ...(command.spawnedBy ? { spawnedBy: command.spawnedBy, hiddenFromRecent: true } : {}),
            select: false,
          });
          createdThread = true;
          // createThread inherits effort from the last project thread; overlay
          // any controller-requested settings for the model that actually ran.
          const created = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
          if (created) {
            turnModelId = created.modelId;
            const targetModel = findAgentModel(agentModelsRef.current, created.modelId);
            const settingsPatch = remoteAgentSettingsPatch(created, targetModel, {
              reasoningEffort: requestedReasoningEffort,
              codexServiceTier: requestedCodexServiceTier,
              claudeContextWindow: requestedClaudeContextWindow,
            }) as Partial<Thread>;
            if (Object.keys(settingsPatch).length > 0) updateThread(threadId, settingsPatch);
          }
        }
        const thread = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
        const unsupportedError = thread ? remoteThreadRunError(thread.modelId) : null;
        if (unsupportedError) {
          if (createdThread) useOrionStore.getState().deleteThread(threadId);
          return { ok: false, ...(createdThread ? {} : { threadId }), error: unsupportedError };
        }
        // Orion-native slash commands do not belong to an agent's ordinary
        // prompt stream. In particular, Codex `/review` must use
        // `review/start`; sending the text through a generic remote run makes
        // the model see it as prose and silently skips the dedicated reviewer.
        // Parse on the authoritative host so existing web clients gain the fix
        // as soon as Desktop is updated. Claude's own `/review` remains an
        // ordinary Claude slash command and deliberately falls through.
        const reviewCommand = parseCodexReviewCommand(promptText);
        const turnModel = findAgentModel(
          agentModelsRef.current,
          turnModelId ?? thread?.modelId ?? defaultAgentModelId
        );
        if (thread && reviewCommand && turnModel?.providerId === 'codex') {
          if (reviewCommand.error) {
            if (createdThread) useOrionStore.getState().deleteThread(threadId);
            return {
              ok: false,
              ...(createdThread ? {} : { threadId }),
              error: reviewCommand.error,
            };
          }
          if (!(await claimRemoteSideEffect(canPrepare, claimStart))) {
            if (createdThread) useOrionStore.getState().deleteThread(threadId);
            return { ok: false, error: 'The remote review command expired or was cancelled.' };
          }
          applyClaimedSettings?.();
          const latestThread = useOrionStore
            .getState()
            .threads.find((candidate) => candidate.id === threadId);
          const synchronouslyTracked =
            pendingTurnStartsRef.current.has(threadId) ||
            [...runOutputMessages.current.values()].some((tracked) => tracked.threadId === threadId);
          if (
            !latestThread ||
            synchronouslyTracked ||
            Boolean(activeRunsByThreadRef.current[threadId])
          ) {
            if (createdThread && latestThread) useOrionStore.getState().deleteThread(threadId);
            return {
              ok: false,
              ...(createdThread ? {} : { threadId }),
              error: latestThread
                ? 'That thread is already running a turn.'
                : 'Thread not found on this machine.',
            };
          }
          const result = await startReviewForThread(threadId, promptText, reviewCommand.review);
          if (!result.ok && createdThread) useOrionStore.getState().deleteThread(threadId);
          return result.ok
            ? { ok: true, threadId }
            : { ok: false, ...(createdThread ? {} : { threadId }), error: result.error };
        }
        // Durango dispatch (main: durango-dispatch.js): a fresh thread, or a
        // follow-up in an existing one (from the API / Durango MCP). For a
        // fresh thread, link the chat's task first so this turn carries its
        // context and the card's status automation follows the run. Either
        // way, leave a visible note that the turn came from outside.
        const dispatch =
          command.durangoDispatch && thread && (createdThread || command.durangoDispatch.followUp)
            ? command.durangoDispatch
            : null;
        const dispatchSource =
          dispatch?.sourceLabel ?? (dispatch?.origin === 'tasks' ? 'Durango Tasks' : 'Durango Chat');
        // A follow-up's outcome is its own run, not the thread's first one.
        const dispatchRunOffset =
          dispatch && !createdThread
            ? thread!.summary.agentRunCount
            : 0;
        let dispatchLinkedTaskId: string | null = null;
        if (dispatch && !createdThread) {
          const accessLabel =
            accessModeOptions.find((option) => option.value === (requestedAccessMode ?? thread!.accessMode))?.label ??
            'Read only';
          addMessageToThread(threadId, {
            role: 'system',
            content:
              `Follow-up sent remotely from ${dispatchSource}${dispatch.sourceUrl ? ` (${dispatch.sourceUrl})` : ''}. ` +
              `Access: ${accessLabel}. Review the changes before you ship them.`,
          });
        } else if (dispatch) {
          const project = findProjectById(useOrionStore.getState(), thread!.projectId);
          const firstLine =
            promptText
              .split('\n')
              .map((line) => line.trim())
              .find((line) => line && !/^\[(Started|Sent) from /.test(line)) ?? '';
          let title = firstLine.length > 60 ? `${firstLine.slice(0, 59).trimEnd()}…` : firstLine;
          let linkNote = '';
          if (dispatch.taskId && window.orion?.linkBoardTask) {
            const linked = await window.orion
              .linkBoardTask({
                taskId: dispatch.taskId,
                threadId,
                threadTitle: title || thread!.title,
                projectName: project?.name,
              })
              .catch((error: unknown) => ({
                ok: false as const,
                error: error instanceof Error ? error.message : String(error),
                task: undefined,
              }));
            if (linked.ok && linked.task) {
              const linkedTask = linkedTaskFromBoardTask(linked.task);
              dispatchLinkedTaskId = linkedTask.id;
              title = linkedTask.title || title;
              updateThread(threadId, { linkedTasks: [linkedTask] });
            } else {
              linkNote = ` Could not link the Durango task: ${linked.error ?? 'unknown error'}.`;
            }
          }
          if (title) updateThread(threadId, { title });
          const accessLabel =
            accessModeOptions.find((option) => option.value === requestedAccessMode)?.label ?? 'Read only';
          const askedForEdits = dispatch.requestedAccessMode === 'auto-edit' && requestedAccessMode === 'read-only';
          addMessageToThread(threadId, {
            role: 'system',
            content:
              `Started remotely from ${dispatchSource}${dispatch.sourceUrl ? ` (${dispatch.sourceUrl})` : ''}. ` +
              `Access: ${accessLabel}${askedForEdits ? ' (this Mac\'s limit for agents started from Durango)' : ''}. ` +
              (dispatch.origin === 'tasks'
                ? 'The prompt came from the task; review the changes before you ship them.'
                : dispatch.origin === 'api'
                  ? 'The prompt came from an app connected to your Durango account; review the changes before you ship them.'
                  : 'The prompt came from your chat and may quote chat or memory content; review the changes before you ship them.') +
              linkNote,
          });
        }
        const unlinkDispatchTask = () => {
          if (dispatchLinkedTaskId) {
            void window.orion?.unlinkBoardTask?.({ taskId: dispatchLinkedTaskId, threadId }).catch(() => {});
          }
        };
        const start = thread
          ? startTurnForThreadRef.current?.(
              threadId,
              promptText,
              // Files the controller sent, already saved here (main).
              Array.isArray(command.attachments) ? command.attachments : [],
              claimStart,
              applyClaimedSettings,
              typeof command.context === 'string' ? command.context : undefined
            )
          : undefined;
        if (!start) {
          if (createdThread) {
            unlinkDispatchTask();
            useOrionStore.getState().deleteThread(threadId);
          }
          return { ok: false, error: 'The agent turn could not start.' };
        }
        let result: { ok: boolean; error?: string };
        try {
          result = await start;
        } catch (error) {
          if (createdThread) {
            unlinkDispatchTask();
            useOrionStore.getState().deleteThread(threadId);
          }
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'The agent turn could not start.',
          };
        }
        if (!result.ok && createdThread) {
          unlinkDispatchTask();
          useOrionStore.getState().deleteThread(threadId);
        }
        if (result.ok && dispatch) {
          // From here the settle watcher reports the outcome to Durango Chat.
          updateThread(threadId, {
            durangoDispatch: {
              id: dispatch.id,
              sourceUrl: dispatch.sourceUrl,
              startedAt: new Date().toISOString(),
              ...(dispatchRunOffset ? { runOffset: dispatchRunOffset } : {}),
            },
          });
        }
        return result.ok
          ? {
              ok: true,
              threadId,
              ...(dispatch
                ? { threadTitle: useOrionStore.getState().threads.find((t) => t.id === threadId)?.title }
                : {}),
            }
          : { ok: false, ...(createdThread ? {} : { threadId }), error: result.error };
      }
      if (command.kind === 'addProject') {
        // A Durango Source checkout main cloned for a run from Durango or a
        // paired machine. Added like a folder the user picked, except that it
        // doesn't take over the sidebar selection or open a thread.
        const projectPath = command.projectPath ?? '';
        if (!projectPath) return { ok: false, error: 'Missing project path.' };
        const existing = state.projects.find(
          (project) => normalizeRepositoryPath(project.path) === normalizeRepositoryPath(projectPath)
        );
        if (existing) return { ok: true, projectId: existing.id };
        if (!(await claimRemoteSideEffect(canPrepare, claimStart))) {
          return { ok: false, error: 'Adding the project expired or was cancelled.' };
        }
        const before = useOrionStore.getState();
        const name = command.projectName?.trim() || (await window.orion?.basename(projectPath)) || projectPath;
        const projectId = before.addProject({ name, path: projectPath });
        useOrionStore.setState({
          selectedProjectId: before.selectedProjectId,
          ...(before.workspacePath ? { workspacePath: before.workspacePath } : {}),
        });
        return { ok: true, projectId };
      }
      if (command.kind === 'stopTurn') {
        const threadId = command.threadId ?? '';
        if (!(await claimRemoteSideEffect(canPrepare, claimStart))) {
          return { ok: false, error: 'The remote Stop command expired or was cancelled.' };
        }
        // Claiming yields to main, so resolve the thread again only after main
        // has atomically confirmed that this command is still authorized.
        const thread = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
        if (thread && remoteThreadRuntime(thread.modelId) === 'terminal') {
          if (thread.status !== 'running') {
            return { ok: false, error: 'No running turn on that thread.' };
          }
          if (!window.orion?.terminalKill) {
            return { ok: false, error: 'The Claude Code terminal runtime is unavailable.' };
          }
          const stopped = await window.orion.terminalKill(threadId);
          if (!stopped) return { ok: false, error: 'No running turn on that thread.' };
          updateThread(threadId, { status: 'idle' });
          return { ok: true, threadId };
        }
        const stoppedText = `Stopped remotely${
          command.source?.machineName ? ` from ${command.source.machineName}` : ''
        }.`;
        const stopped = await stopThreadTree({
          rootThreadId: threadId,
          stoppedText,
          spawnStoppedText: 'Subagent run was stopped by a paired remote machine before completing.',
        });
        if (!stopped) return { ok: false, error: 'No running turn on that thread.' };
        return { ok: true, threadId };
      }
      if (command.kind === 'steerTurn') {
        // A paired controller's "Steer now": the same steer as this machine's
        // own, so the steered message shows here and in every mirror. The
        // controller keeps the message until it is in the turn: anything that
        // can't go in is handed back, never queued here.
        const threadId = command.threadId ?? '';
        const promptText = (command.prompt ?? '').trim();
        const attachments = command.attachments ?? [];
        if (!promptText && attachments.length === 0) return { ok: false, error: 'Empty prompt.' };
        if (!state.threads.some((candidate) => candidate.id === threadId)) {
          return { ok: false, error: 'Thread not found on this machine.' };
        }
        if (!steerTargetForThread(threadId)) {
          return { ok: false, threadId, error: 'That turn cannot be steered.' };
        }
        // Reserved now, before any await, so a Stop from here on cancels it.
        // The claim is the commit point, right before the message goes in:
        // a command that expired first never reaches the turn.
        let claimed = true;
        const outcome = await steeringCoordinatorRef.current.enqueue(threadId, (cancelled: () => boolean) =>
          performSteerWithContent(threadId, promptText, attachments, cancelled, {
            queueFallback: false,
            beforeInject: async () => (claimed = await claimRemoteSideEffect(canPrepare, claimStart)),
          })
        );
        if (outcome === 'steered') return { ok: true, threadId };
        return {
          ok: false,
          threadId,
          error: !claimed
            ? 'The steer expired or was cancelled.'
            : outcome === 'cancelled'
              ? 'The turn was stopped before the message reached it.'
              : 'That turn cannot be steered.',
        };
      }
      if (command.kind === 'answerQuestion') {
        // A paired controller answering a question this machine's agent asked:
        // exactly what this machine's own question card does.
        const threadId = command.threadId ?? '';
        // Its subagents' questions too (controllers show them on the thread).
        const pending = (
          await Promise.all(
            threadFamilyIds(state.threads, threadId).map(async (id) => [
              ...((await window.orion?.getCodexQuestions?.(id)) ?? []),
              ...((await window.orion?.getClaudeQuestions?.(id)) ?? []),
            ])
          )
        ).flat();
        const request = pending.find(
          (candidate) =>
            candidate.runId === command.runId && String(candidate.requestId) === String(command.requestId)
        ) as CodexQuestionRequest | undefined;
        if (!request) return { ok: false, error: 'This question is no longer waiting for an answer.' };
        const answers = command.answers ?? {};
        if (!request.questions.every((question) => (answers[question.id] ?? []).some((value) => value.trim()))) {
          return { ok: false, error: 'Every question needs an answer.' };
        }
        if (!(await claimRemoteSideEffect(canPrepare, claimStart))) {
          return { ok: false, error: 'The answer expired or was cancelled.' };
        }
        const accepted = request.async
          ? await answerAsyncQuestion(request, answers)
          : request.providerId === 'claude'
            ? await window.orion?.answerClaudeQuestions?.(request.runId, request.requestId, answers)
            : await window.orion?.answerCodexQuestions?.(request.runId, request.requestId, answers);
        return accepted
          ? { ok: true, threadId }
          : { ok: false, error: 'This question is no longer waiting for an answer.' };
      }
      if (command.kind === 'userAction') {
        // Done / Reply / Dismiss / Watch from a paired controller, through the
        // same handlers as this machine's own action cards.
        const actionId = command.actionId ?? '';
        // The action may be a subagent's (controllers show them on the thread
        // they list): find the thread that asked.
        const family = threadFamilyIds(state.threads, command.threadId ?? '');
        const threadId =
          family.find((id) =>
            state.threads.find((candidate) => candidate.id === id)?.userActions?.some((action) => action.id === actionId)
          ) ?? '';
        if (!threadId) return { ok: false, error: 'That action is no longer waiting.' };
        if (!(await claimRemoteSideEffect(canPrepare, claimStart))) {
          return { ok: false, error: 'The action expired or was cancelled.' };
        }
        if (command.op === 'done') markUserActionDone(threadId, actionId);
        else if (command.op === 'reply') {
          replyToUserAction(threadId, actionId, command.reply ?? '', Array.isArray(command.attachments) ? command.attachments : []);
        } else if (command.op === 'dismiss') dismissUserAction(threadId, actionId);
        else if (command.op === 'watch') setUserActionWatching(threadId, actionId, command.watching === true);
        else if (command.op === 'secret' && command.secretAnswer) {
          const error = await answerSecretRequest(threadId, actionId, command.secretAnswer);
          if (error) return { ok: false, error };
        } else return { ok: false, error: 'Invalid user action operation.' };
        return { ok: true, threadId };
      }
      return { ok: false, error: 'Unsupported remote command.' };
    };
  });
  useEffect(() => {
    if (!window.orion?.onRemoteCommandRequest) return undefined;
    const unsubscribe = window.orion.onRemoteCommandRequest((request) => {
      void (async () => {
        let outcome: { ok: boolean; threadId?: string; threadTitle?: string; projectId?: string; error?: string };
        const canPrepare = () => Date.now() < request.expiresAt;
        let claimPromise: Promise<boolean> | null = null;
        const claimStart = () => {
          if (!canPrepare()) return Promise.resolve(false);
          claimPromise ??=
            window.orion
              ?.remoteClaimCommand?.({ commandId: request.commandId })
              .then((result) => result.ok)
              .catch(() => false) ?? Promise.resolve(false);
          return claimPromise;
        };
        try {
          outcome = await remoteCommandHandlerRef.current(request.command, canPrepare, claimStart);
          // Main serves remote snapshots and transcripts from disk. Do not
          // expose a successful mutation until the exact thread state the
          // controller will immediately read has crossed that boundary.
          outcome = await persistSuccessfulRemoteCommand(outcome, flushOrionThreadsSave);
        } catch (error) {
          outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        void window.orion?.reportRemoteCommandResult?.({ commandId: request.commandId, ...outcome });
      })();
    });
    // Main dispatches only after this subscription exists. Reload/navigation
    // clears readiness in main until this effect mounts again.
    void window.orion.remoteRendererReady?.();
    return () => unsubscribe?.();
  }, []);

  // Durango Chat dispatch: report each dispatched thread's outcome back to the
  // chat once its run settles (finished → summary, error/stop → failed). Runs
  // off the persisted thread state, so a run interrupted by a restart is
  // still reported (as failed) on the next launch.
  useEffect(() => {
    if (!window.orion?.durangoDispatchSettled) return undefined;
    const inFlight = new Set<string>();
    const loading = new Set<string>();
    // Shells already looked at with no outcome (or an unreadable
    // transcript). An outcome can only appear when the shell changes (its
    // status or summary), so each shell version is examined — and its
    // transcript loaded — at most once.
    const examined = new WeakSet<Thread>();
    const check = (threads: Thread[]) => {
      const { transcripts } = useOrionStore.getState();
      for (const thread of threads) {
        const dispatch = thread.durangoDispatch;
        if (!dispatch || dispatch.reportedAt || inFlight.has(dispatch.id)) continue;
        if (thread.status === 'running' || examined.has(thread)) continue;
        // No dispatched run yet, and no start failure to report.
        if (thread.summary.agentRunCount <= (dispatch.runOffset ?? 0) && thread.status !== 'error') {
          examined.add(thread);
          continue;
        }
        const transcript = transcripts[thread.id];
        if (!transcript) {
          // The outcome is in the transcript: load it, then look again.
          if (loading.has(thread.id)) continue;
          loading.add(thread.id);
          void ensureThreadTranscript(thread.id)
            .catch((error) => {
              console.warn('Could not load a dispatched thread to report its outcome', error);
              examined.add(thread);
              return null;
            })
            .finally(() => {
              loading.delete(thread.id);
              check(useOrionStore.getState().threads);
            });
          continue;
        }
        const outcome = durangoDispatchOutcome(thread, transcript.messages);
        if (!outcome) {
          examined.add(thread);
          continue;
        }
        inFlight.add(dispatch.id);
        updateThread(thread.id, { durangoDispatch: { ...dispatch, reportedAt: new Date().toISOString() } });
        const settled = window.orion?.durangoDispatchSettled?.({
          dispatchId: dispatch.id,
          threadId: thread.id,
          ...outcome,
        });
        void Promise.resolve(settled)
          .catch(() => {})
          .finally(() => inFlight.delete(dispatch.id));
      }
    };
    check(useOrionStore.getState().threads);
    return useOrionStore.subscribe((state, previous) => {
      if (state.threads !== previous.threads) check(state.threads);
    });
  }, [updateThread]);

  // Clicking the "Durango Chat started an agent" notification.
  useEffect(
    () =>
      window.orion?.onDurangoFocusThread?.(({ threadId }) => {
        const store = useOrionStore.getState();
        if (!store.threads.some((thread) => thread.id === threadId)) return;
        store.setActiveTab('agents');
        store.selectThread(threadId);
      }),
    []
  );

  const openAccountSettings = useCallback(() => {
    setSettingsTab('account');
    setSettingsOpen(true);
  }, []);
  const openProviderSettings = useCallback(() => {
    setSettingsTab('providers');
    setSettingsOpen(true);
  }, []);
  const openRemoteControlSettings = useCallback(() => {
    setSettingsTab('remote-control');
    setSettingsOpen(true);
  }, []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const sidebarFooterProps = useMemo<SidebarFooterProps>(
    () => ({
      appUpdateVisible,
      appUpdateState,
      appUpdateBusy,
      appUpdatePercent,
      appUpdateLabel,
      appUpdateTitle,
      accountState,
      accountName,
      accountInitials,
      accountLoading,
      accountBusy,
      onAppUpdateClick: handleAppUpdateClick,
      onOpenAccount: openAccountSettings,
      onStartAccountAuth: handleStartAccountAuth,
      onOpenSettings: openSettings,
    }),
    [
      accountBusy,
      accountInitials,
      accountLoading,
      accountName,
      accountState,
      appUpdateBusy,
      appUpdateLabel,
      appUpdatePercent,
      appUpdateState,
      appUpdateTitle,
      appUpdateVisible,
      handleAppUpdateClick,
      handleStartAccountAuth,
      openAccountSettings,
      openSettings,
    ]
  );

  const settingsPageModel: SettingsPageProps = {
    notificationSettings,
    setNotificationSettings,
    setTextGenerationSettings,
    splitViewSettings,
    setSplitViewSettings,
    savedViews,
    deleteSavedView,
    providerSettings,
    setProviderEnabled,
    setProviderOptions,
    setOrchestrationRoleModel,
    setOrchestrationGeneralInstructions,
    workspaceSyncSettings,
    setWorkspaceSyncSettings,
    remoteControlSettings,
    setRemoteControlSettings,
    deploymentSettings,
    setDeploymentSettings,
    resolvedDeploymentModel,
    resolvedDeploymentModelId,
    deploymentReasoningOptions,
    resolvedDeploymentReasoningEffort,
    cloudApp,
    handleOpenCloudApp,
    workspaceSyncStatus,
    handleWorkspaceSyncNow,
    setUtilityModelPickerOpen,
    utilityModelPickerOpen,
    setUtilityModelSearch,
    utilityModelSearch,
    setUtilityModelTab,
    utilityModelTab,
    providerUpdateState,
    providerUpdatesChecking,
    providerUpdatesRunning,
    providerUpdateProgress,
    appUpdateState,
    appUpdateBusy,
    whatsNew,
    setSettingsOpen,
    settingsTab,
    setSettingsTab,
    handleOpenSkillInEditor,
    authenticatingProviderId,
    accountState,
    accountLoading,
    accountBusy,
    computerUsePerms,
    computerUseBusyKind,
    handleOpenChromeDebugSetup,
    revealedProviderEmails,
    setRevealedProviderEmails,
    setRevealedAccountIdentity,
    expandedProviderOptions,
    setExpandedProviderOptions,
    utilityModelPickerRef,
    normalizedProviderSettings,
    normalizedOrchestrationSettings,
    orchestrationModelGroups,
    providerStatusById,
    accountName,
    accountEmail,
    accountIdentity,
    accountEmailRevealed,
    accountInitials,
    utilityCandidateModels,
    utilityProviders,
    resolvedUtilityModelId,
    resolvedUtilityModel,
    utilityModelProviderId,
    utilityReasoningOptions,
    resolvedUtilityReasoningEffort,
    refreshProviderUpdates,
    handleUpdateProviders,
    handleCancelProviderUpdate,
    handleAppUpdateClick,
    handleRequestComputerUsePermission,
    handleStartAccountAuth,
    handleSignOutAccount,
    handleAuthenticateProvider,
    formatCheckedTime,
    formatBytes,
  };


  // Keep the memoized sidebar detached from composer typing. These wrappers
  // retain stable identities while their targets advance only after a render
  // commits, so they never point at an abandoned concurrent render.
  const agentsSidebarActionsRef = useRef({
    handleNewAgent,
    handleCreateThread,
    openNewAgentIn,
  });
  useLayoutEffect(() => {
    agentsSidebarActionsRef.current = {
      handleNewAgent,
      handleCreateThread,
      openNewAgentIn,
    };
  });
  const stableAgentsSidebarActions = useMemo(
    () => ({
      handleNewAgent: (...args: Parameters<typeof handleNewAgent>) =>
        agentsSidebarActionsRef.current.handleNewAgent(...args),
      handleCreateThread: (...args: Parameters<typeof handleCreateThread>) =>
        agentsSidebarActionsRef.current.handleCreateThread(...args),
    }),
    []
  );

  // Saved views hold ids only, so the sidebar reads its pane titles from here.
  const threadTitlesById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread.title])),
    [threads]
  );

  const agentsSidebarModel: AgentsSidebarModel = {
    projects,
    selectThread,
    setActiveTab,
    selectedThreadId,
    paneThreadIds,
    savedViews,
    activeSavedViewId,
    threadTitlesById,
    openSavedView,
    deleteSavedView,
    savedViewsSectionOpen,
    setSavedViewsSectionOpen,
    updateThread,
    branchThread: branchThreadWithFeedback,
    renameProject,
    selectProject,
    threadSearchOpen,
    setThreadSearchOpen,
    projectMenuOpenId,
    setProjectMenuOpenId,
    threadItemMenuKey,
    setThreadItemMenuKey,
    threadRenameKey,
    setThreadRenameKey,
    projectRenameId,
    setProjectRenameId,
    threadListLimits,
    setThreadListLimits,
    collapsedProjects,
    setCollapsedProjects,
    setRecentAgentsOpen,
    recentAgentsOpen,
    setRecentAgentsShowAll,
    recentAgentsShowAll,
    setPinnedAgentsOpen,
    pinnedAgentsOpen,
    setPinnedAgentsShowAll,
    pinnedAgentsShowAll,
    threadSearchRef,
    projectMenuRef,
    threadItemMenuRef,
    selectedProject,
    sortedProjects,
    recentAgentsTargetProject,
    pinnedThreads,
    recentThreads,
    pinThread,
    unpinThread,
    runningAgentCount,
    projectThreadsByProject,
    deleteThreadWithRuntime,
    removeProjectWithRuntimes,
    handleAddProject,
    ...stableAgentsSidebarActions,
    renderThreadCliBadge,
    renderThreadStatusDot,
    sidebarFooterProps,
  };

  const sidebarV2ModelLabel = useCallback(
    (thread: Thread) => findAgentModel(agentModelsRef.current, thread.modelId)?.label ?? null,
    []
  );
  // Snoozing or settling the open thread takes it off screen too: the main
  // view moves to a fresh composer in the same project, where sending starts
  // a new thread.
  const putAwayThread = useCallback((threadId: string, putAway: (threadId: string) => void) => {
    const thread = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
    putAway(threadId);
    if (thread && useOrionStore.getState().selectedThreadId === threadId) {
      agentsSidebarActionsRef.current.openNewAgentIn(thread.projectId);
    }
  }, []);
  const snoozeThreadFromSidebar = useCallback(
    (threadId: string) => putAwayThread(threadId, snoozeThread),
    [putAwayThread, snoozeThread]
  );
  const settleThreadFromSidebar = useCallback(
    (threadId: string) => {
      const thread = useOrionStore.getState().threads.find((candidate) => candidate.id === threadId);
      if (thread?.status !== 'running') putAwayThread(threadId, settleThread);
    },
    [putAwayThread, settleThread]
  );
  const sidebarV2Actions = useMemo<SidebarV2Actions>(
    () => ({
      selectThread,
      setActiveTab,
      updateThread,
      branchThread: branchThreadWithFeedback,
      pinThread,
      unpinThread,
      snoozeThread: snoozeThreadFromSidebar,
      unsnoozeThread,
      settleThread: settleThreadFromSidebar,
      unsettleThread,
      deleteThreadWithRuntime,
      modelLabel: sidebarV2ModelLabel,
      renderThreadCliBadge,
    }),
    [
      branchThreadWithFeedback,
      deleteThreadWithRuntime,
      pinThread,
      selectThread,
      setActiveTab,
      settleThreadFromSidebar,
      sidebarV2ModelLabel,
      snoozeThreadFromSidebar,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
      updateThread,
    ]
  );
  const sidebarV2ExtraSections = useMemo(
    () =>
      sidebarV2Enabled && savedViews.length > 0 ? (
        <SavedViewsSection
          setActiveTab={setActiveTab}
          savedViews={savedViews}
          activeSavedViewId={activeSavedViewId}
          threadTitlesById={threadTitlesById}
          openSavedView={openSavedView}
          deleteSavedView={deleteSavedView}
          savedViewsSectionOpen={savedViewsSectionOpen}
          setSavedViewsSectionOpen={setSavedViewsSectionOpen}
        />
      ) : null,
    [
      activeSavedViewId,
      deleteSavedView,
      openSavedView,
      savedViews,
      savedViewsSectionOpen,
      setActiveTab,
      sidebarV2Enabled,
      threadTitlesById,
    ]
  );
  const handleSidebarV2AddProject = useCallback(() => {
    if (repositoryOperationBusy) return;
    openAddProjectPicker();
  }, [openAddProjectPicker, repositoryOperationBusy]);

  // The main view's unit of display. paneThreadIds is authoritative; falling
  // back to the selected thread only matters for a store written before the
  // split view existed, or if a pane ever outlives its thread.
  const threadPanes = useMemo(() => {
    const ids = paneThreadIds.length > 0 ? paneThreadIds : selectedThreadId ? [selectedThreadId] : [];
    return ids.flatMap((threadId) => {
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (!thread) return [];
      const context = threadViewContext(thread);
      const agentModel = findAgentModel(agentModels, thread.modelId ?? defaultAgentModelId);
      const paneSending =
        Boolean(activeRunsByThread[threadId]) || (Boolean(thread.remote) && thread.status === 'running');
      const paneSteerSupported =
        paneSending && !!agentModel && providerFollowUpSupport[agentModel.providerId]?.steer === true;
      const focused = threadId === selectedThreadId;
      return [
        {
          thread,
          focused,
          project: context.project,
          projectPath: context.projectPath,
          workspaceUnavailable: context.workspaceUnavailable,
          mediaBaseDirs: stableMediaBaseDirs(threadId, context.mediaBaseDirs),
          isTerminal: agentModel?.id === claudeCodeCliModelId,
          isSending: paneSending,
          steerSupported: paneSteerSupported,
          steerReady:
            paneSteerSupported &&
            (thread.remote
              ? Boolean(thread.remote.threadId && window.orion?.remoteSteerTurn)
              : !!window.orion?.steerAgentTurn),
          // Retargeting an empty thread's project runs through the composer's
          // handler, which only ever addresses the focused thread.
          canChangeProject: focused && canChangeSelectedThreadProject,
        },
      ];
    });
  }, [
    activeRunsByThread,
    agentModels,
    canChangeSelectedThreadProject,
    paneThreadIds,
    selectedThreadId,
    stableMediaBaseDirs,
    threadViewContext,
    threads,
  ]);
  const splitFull = threadPanes.length >= MAX_THREAD_PANES;

  // With nothing open the Agents panel shows a fresh composer, not a "Select
  // a thread" placeholder. New-agent reuses an untouched draft (sidebar v2),
  // so closing or deleting the last thread doesn't stack empty ones.
  const showsEmptyAgentsPanel =
    storeHydrated &&
    activeTab === 'agents' &&
    !settingsOpen &&
    threadPanes.length === 0 &&
    !!defaultNewThreadProject;
  useEffect(() => {
    if (showsEmptyAgentsPanel) agentsSidebarActionsRef.current.handleNewAgent();
  }, [showsEmptyAgentsPanel]);

  // Threads dragged out of the sidebar land here as an extra pane. Other drags
  // (image files, text) fall through to the shell's own handlers untouched.
  const [threadDropActive, setThreadDropActive] = useState(false);
  const isThreadDrag = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types).includes(THREAD_DRAG_MIME);

  const handleThreadDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!isThreadDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = splitFull ? 'none' : 'copy';
      setThreadDropActive(true);
    },
    [splitFull]
  );

  const handleThreadDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!isThreadDrag(event)) return;
    // Moving between panes fires leave on the panel before enter on the child;
    // ignore those so the hint doesn't strobe across the split.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setThreadDropActive(false);
  }, []);

  const handleThreadDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!isThreadDrag(event)) return;
      event.preventDefault();
      setThreadDropActive(false);
      const threadId = event.dataTransfer.getData(THREAD_DRAG_MIME);
      if (threadId) openThreadInSplit(threadId);
    },
    [openThreadInSplit]
  );

  // Width every composer chip would take if they all stayed on the row. Depends
  // only on the labels, so it never changes as a result of collapsing them —
  // the compact row can't measure the full one, and a measured switch would
  // oscillate at the boundary.
  const composerControlsNeededWidth = (() => {
    const widths: number[] = [
      Math.min(260, estimateChipWidth(selectedAgentModel?.label ?? 'Select model', 6.6, 68)),
    ];
    if (shouldShowAgentSettings) {
      widths.push(
        estimateChipWidth(
          selectedAgentModel?.providerId === 'opencode'
            ? selectedOpenCodeReasoningLabel
            : selectedAgentModel?.providerId === 'grok'
            ? selectedGrokReasoningLabel
            : selectedAgentModel?.providerId === 'muse'
              ? selectedMuseReasoningLabel
              : selectedAgentModel?.providerId === 'claude'
                ? `${selectedClaudeReasoningLabel} · ${selectedClaudeContextWindowLabel}`
                : `${selectedCodexReasoningLabel} · ${selectedCodexServiceTierLabel}`,
          7.4,
          52
        )
      );
    }
    widths.push(estimateChipWidth(selectedAccessModeLabel, 7.4, 60));
    if (!isTerminalThread) widths.push(34);
    widths.push(34); // File attachment picker.
    widths.push(36); // Send, or stop while a run is in flight.
    if (isSending && composerHasDraft) {
      widths.push(36); // Queue.
      if (steerSupported) widths.push(36);
    }
    return widths.reduce((total, width) => total + width, 0) + (widths.length - 1) * 8;
  })();

  // Only a narrow pane ever trips this; a full-width composer has room to
  // spare, so it keeps every control as its own chip exactly as before.
  const composerControlsCompact =
    composerControlsWidth !== null && composerControlsWidth < composerControlsNeededWidth;

  useEffect(() => {
    // The chips and the overflow menu own separate open state; whichever form
    // just went away should not come back expanded.
    if (composerControlsCompact) {
      setCodexSettingsOpen(false);
      setAccessModeOpen(false);
      setTaskPickerOpen(false);
    } else {
      setComposerMenuOpen(false);
      setComposerMenuSection(null);
    }
  }, [composerControlsCompact]);

  useEffect(() => {
    if (!composerMenuOpen) return undefined;

    const close = () => {
      setComposerMenuOpen(false);
      setComposerMenuSection(null);
    };
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !composerMenuRef.current?.contains(target) &&
        !composerMenuPopoverRef.current?.contains(target)
      ) {
        close();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [composerMenuOpen]);

  useLayoutEffect(() => {
    if (!composerMenuOpen) return undefined;
    const anchor = composerMenuRef.current;
    const menu = composerMenuPopoverRef.current;
    if (!anchor || !menu) return undefined;

    const fit = () => {
      const margin = 12;
      const gap = 8;
      const anchorRect = anchor.getBoundingClientRect();
      const width = Math.min(300, window.innerWidth - margin * 2);
      const roomAbove = Math.max(0, anchorRect.top - margin - gap);
      const roomBelow = Math.max(0, window.innerHeight - anchorRect.bottom - margin - gap);
      const placeAbove = roomAbove >= roomBelow;
      const maxHeight = Math.min(520, placeAbove ? roomAbove : roomBelow);
      const left = Math.min(
        Math.max(anchorRect.right - width, margin),
        Math.max(margin, window.innerWidth - margin - width)
      );

      menu.style.left = `${Math.round(left)}px`;
      menu.style.width = `${Math.round(width)}px`;
      menu.style.maxHeight = `${Math.floor(maxHeight)}px`;
      if (placeAbove) {
        menu.style.top = 'auto';
        menu.style.bottom = `${Math.round(window.innerHeight - anchorRect.top + gap)}px`;
      } else {
        menu.style.top = `${Math.round(anchorRect.bottom + gap)}px`;
        menu.style.bottom = 'auto';
      }
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(anchor);
    window.addEventListener('resize', fit);
    window.addEventListener('scroll', fit, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
      window.removeEventListener('scroll', fit, true);
    };
  }, [composerMenuOpen]);

  // Popover bodies, lifted out of their chips so the overflow menu can show the
  // same options inline instead of duplicating them.
  const agentSettingsOptions = selectedThread && shouldShowAgentSettings ? (
    selectedAgentModel?.providerId === 'opencode' ? (
      <div className="codex-settings-section">
        <div className="codex-settings-heading">Variant</div>
        <div className="codex-settings-options">
          {selectedOpenCodeReasoningOptions.map((option) => {
            const selected = selectedOpenCodeReasoning === option.value;
            return (
              <button
                key={option.value}
                className={`codex-settings-row ${selected ? 'selected' : ''}`}
                onClick={() =>
                  updateThread(selectedThread.id, {
                    openCodeReasoningEffort: option.value,
                  })
                }
              >
                <span className="settings-check">{selected && <Check size={17} />}</span>
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    ) : selectedAgentModel?.providerId === 'muse' ? (
      <div className="codex-settings-section">
        <div className="codex-settings-heading">Reasoning</div>
        <div className="codex-settings-options">
          {selectedMuseReasoningOptions.map((option) => {
            const selected = selectedMuseReasoning === option.value;
            return (
              <button
                key={option.value}
                className={`codex-settings-row ${selected ? 'selected' : ''}`}
                onClick={() =>
                  updateThread(selectedThread.id, {
                    museReasoningEffort: option.value as MuseReasoningEffort,
                  })
                }
              >
                <span className="settings-check">{selected && <Check size={17} />}</span>
                <span>
                  {option.label}
                  {option.default ? ' (default)' : ''}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    ) : selectedAgentModel?.providerId === 'grok' ? (
      <div className="codex-settings-section">
        <div className="codex-settings-heading">Reasoning</div>
        <div className="codex-settings-options">
          {selectedGrokReasoningOptions.map((option) => {
            const selected = selectedGrokReasoning === option.value;
            return (
              <button
                key={option.value}
                className={`codex-settings-row ${selected ? 'selected' : ''}`}
                onClick={() =>
                  updateThread(selectedThread.id, {
                    grokReasoningEffort: option.value as GrokReasoningEffort,
                  })
                }
              >
                <span className="settings-check">{selected && <Check size={17} />}</span>
                <span>
                  {option.label}
                  {option.default ? ' (default)' : ''}
                  {option.description && (
                    <span className="codex-settings-row-description">{option.description}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    ) : selectedAgentModel?.providerId === 'claude' ? (
      <>
        <div className="codex-settings-section">
          <div className="codex-settings-heading">Reasoning</div>
          <div className="codex-settings-options">
            {selectedClaudeReasoningOptions.map((option) => {
              const selected = selectedClaudeReasoning === option.value;
              const isDefault = option.value === defaultClaudeReasoningEffort;
              return (
                <button
                  key={option.value}
                  className={`codex-settings-row ${selected ? 'selected' : ''}`}
                  onClick={() =>
                    updateThread(selectedThread.id, {
                      claudeReasoningEffort: option.value as ClaudeReasoningEffort,
                    })
                  }
                >
                  <span className="settings-check">{selected && <Check size={17} />}</span>
                  <span>
                    {option.label}
                    {isDefault ? ' (default)' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="codex-settings-divider" />

        <div className="codex-settings-section">
          <div className="codex-settings-heading">Context Window</div>
          <div className="codex-settings-options">
            {claudeContextWindowOptions.map((option) => {
              const selected = effectiveClaudeContextWindow === option.value;
              const oneMillionOnly =
                !!selectedAgentModel && claudeOneMillionOnlyModelSlugs.has(selectedAgentModel.slug);
              const disabled = oneMillionOnly && option.value === '200k';
              return (
                <button
                  key={option.value}
                  className={`codex-settings-row ${selected ? 'selected' : ''}`}
                  onClick={() =>
                    updateThread(selectedThread.id, {
                      claudeContextWindow: option.value as ClaudeContextWindow,
                    })
                  }
                  disabled={disabled}
                  title={
                    disabled && selectedAgentModel
                      ? `${selectedAgentModel.label} uses 1M context unless limited by Claude configuration or your provider`
                      : undefined
                  }
                >
                  <span className="settings-check">{selected && <Check size={17} />}</span>
                  <span>
                    {option.label}
                    {option.value === defaultClaudeContextWindow && !oneMillionOnly
                      ? ' (default)'
                      : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </>
    ) : (
      <>
        <div className="codex-settings-section">
          <div className="codex-settings-heading">Reasoning</div>
          <div className="codex-settings-options">
            {selectedCodexReasoningOptions.map((option) => {
              const selected = selectedCodexReasoning === option.value;
              return (
                <button
                  key={option.value}
                  className={`codex-settings-row ${selected ? 'selected' : ''}`}
                  onClick={() =>
                    updateThread(selectedThread.id, {
                      codexReasoningEffort: option.value as CodexReasoningEffort,
                    })
                  }
                >
                  <span className="settings-check">{selected && <Check size={17} />}</span>
                  <span>
                    {option.label}
                    {option.default ? ' (default)' : ''}
                    {option.description && (
                      <span className="codex-settings-row-description">{option.description}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="codex-settings-divider" />

        <div className="codex-settings-section">
          <div className="codex-settings-heading">Service Tier</div>
          <div className="codex-settings-options">
            {codexServiceTierOptions.map((option) => {
              const selected = selectedCodexServiceTier === option.value;
              return (
                <button
                  key={option.value}
                  className={`codex-settings-row ${selected ? 'selected' : ''}`}
                  onClick={() =>
                    updateThread(selectedThread.id, {
                      codexServiceTier: option.value as CodexServiceTier,
                    })
                  }
                >
                  <span className="settings-check">{selected && <Check size={17} />}</span>
                  <span>
                    {option.label}
                    {option.default ? ' (default)' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </>
    )
  ) : null;

  const accessModeList = selectedThread ? (
    <div className="codex-settings-options">
      {accessModeOptions.map((option) => {
        const selected = selectedAccessMode === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={`codex-settings-row ${selected ? 'selected' : ''}`}
            onClick={() => {
              updateThread(selectedThread.id, { accessMode: option.value });
              setAccessModeOpen(false);
              setComposerMenuSection(null);
            }}
          >
            <span className="settings-check">{selected && <Check size={17} />}</span>
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  ) : null;

  const agentSettingsSummary =
    selectedAgentModel?.providerId === 'opencode'
      ? selectedOpenCodeReasoningLabel
      : selectedAgentModel?.providerId === 'grok'
      ? selectedGrokReasoningLabel
      : selectedAgentModel?.providerId === 'muse'
        ? selectedMuseReasoningLabel
        : selectedAgentModel?.providerId === 'claude'
          ? `${selectedClaudeReasoningLabel} · ${selectedClaudeContextWindowLabel}`
          : `${selectedCodexReasoningLabel} · ${selectedCodexServiceTierLabel}`;

  // Above the composer's top-right corner: the branch picker with Commit and
  // Push, or the thread's Durango workspace when it has one. Its menus open
  // upward so they never fall off the bottom of the window.
  // Left of it, once another machine is paired: which machine the thread's
  // agents run on. A thread on another machine shows its branch there instead
  // of this machine's.
  const showMachinePicker = Boolean(selectedThread && (remoteMachinesAvailable || selectedThread.remote));
  const showLocalGitControls = Boolean(activeThreadProject && !activeIsNoProject && !selectedThread?.remote);
  const composerGitBar =
    activeTab === 'agents' && selectedThread && (showMachinePicker || showLocalGitControls) ? (
      <div className="composer-git-bar">
        {showMachinePicker && (
          <MachinePicker
            localName={localMachineName}
            machines={remoteMachines}
            value={selectedThread.remote ?? null}
            locked={
              selectedThread.summary.messageCount > 0 ||
              Boolean(selectedThread.remote?.threadId) ||
              isSending ||
              selectedThread.status === 'running'
            }
            onChange={(machine) =>
              updateThread(selectedThread.id, {
                remote: machine ? { machineId: machine.id, machineName: machine.name } : undefined,
              })
            }
            onManage={openRemoteControlSettings}
          />
        )}
        {selectedThread.remote?.threadId && (
          <RemoteBranchPill
            machineId={selectedThread.remote.machineId}
            machineName={selectedThread.remote.machineName}
            threadId={selectedThread.remote.threadId}
          />
        )}
        {showLocalGitControls && activeDurangoWorkspace && (
          <DurangoWorkspaceControl
            workspace={activeDurangoWorkspace}
            disabled={repositoryOperationBusy || activeWorkspaceUnavailable}
            onRemove={() => void handleRemoveThreadWorkspace(selectedThread.id)}
            onMissing={() => void releaseMissingDurangoWorkspaces([activeDurangoWorkspace.path])}
          />
        )}
        {showLocalGitControls && !activeDurangoWorkspace && (
          <div className="shell-branch-control" ref={branchPickerRef}>
            <button
              type="button"
              className="shell-branch-trigger"
              onClick={() => {
                if (activeWorkspaceUnavailable) return;
                const opening = !branchPickerOpen;
                setBranchPickerOpen(opening);
                // The list can be stale (branch switched or created in a
                // terminal since the last read) — re-read on open.
                if (opening) void refreshGitState();
              }}
              disabled={activeWorkspaceUnavailable || gitLoading || repositoryOperationBusy || !gitState?.ok}
              title={gitState?.error ?? gitState?.root ?? 'Git state'}
              aria-haspopup="menu"
              aria-expanded={branchPickerOpen && !repositoryOperationBusy}
            >
              <GitBranch size={14} />
              <span className="truncate">
                {gitLoading
                  ? 'Git...'
                  : (gitState?.currentBranch ??
                    (gitState?.detachedHead ? `Detached @ ${gitState.detachedHead}` : 'Local'))}
              </span>
              <ChevronDown size={13} className={`project-pill-chevron ${branchPickerOpen ? 'open' : ''}`} />
            </button>
            {branchPickerOpen && !repositoryOperationBusy && !activeWorkspaceUnavailable && (
              <div className="shell-branch-picker" role="menu">
                {creatingBranch ? (
                  <div className="branch-picker-item branch-picker-create-row">
                    <Plus size={13} />
                    <InlineRenameInput
                      className="thread-rename-input"
                      initialValue=""
                      onSubmit={(name) => {
                        setCreatingBranch(false);
                        void handleCreateBranch(name);
                      }}
                      onCancel={() => setCreatingBranch(false)}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="branch-picker-item"
                    onClick={() => setCreatingBranch(true)}
                    disabled={repositoryOperationBusy || !gitState?.ok}
                  >
                    <Plus size={13} /> New branch
                  </button>
                )}
                <button
                  type="button"
                  className="branch-picker-item"
                  onClick={() => {
                    setBranchPickerOpen(false);
                    void handleCommitAndPush();
                  }}
                  disabled={repositoryOperationBusy || !gitState?.ok || !gitState.currentBranch}
                  title="git add . && git commit && git push"
                >
                  <GitCommit size={13} /> Commit and Push
                </button>
                <div className="project-picker-divider" />
                {gitState?.hasUncommittedChanges && (
                  <div className="branch-picker-note">Commit local changes before switching branches.</div>
                )}
                {gitState?.branches.map((branch) => (
                  <button
                    key={branch.name}
                    type="button"
                    className={`branch-picker-item ${branch.current ? 'selected' : ''}`}
                    onClick={() => handleCheckoutBranch(branch.name)}
                    disabled={branch.current || gitState.hasUncommittedChanges || repositoryOperationBusy}
                    title={
                      gitState.hasUncommittedChanges && !branch.current
                        ? 'Unavailable with uncommitted changes'
                        : branch.name
                    }
                  >
                    <GitBranch size={13} />
                    <span className="truncate">{branch.name}</span>
                    {branch.current && <Check size={13} />}
                  </button>
                ))}
                {gitState?.branches.length === 0 && (
                  <div className="branch-picker-empty">{gitState?.error ?? 'No branches found'}</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    ) : null;

  // The composer belongs to the focused pane: one thread takes input at a
  // time and clicking any pane moves it there. Built once, outside the pane
  // loop, so a six-way split never duplicates the picker/mention machinery.
  // Handlers the Composer calls. Stable identities that always run the latest
  // App closure, so passing them never re-renders the Composer by itself.
  const sendFromComposer = useLatestCallback((overrideText?: string) => {
    void sendMessage(overrideText);
  });
  const steerFromComposer = useLatestCallback(() => {
    void steerActiveAgent();
  });
  const stopFromComposer = useLatestCallback(() => {
    void stopActiveAgent();
  });
  const dispatchReviewFromComposer = useLatestCallback((rawText: string, review: ComposerReviewRequest) =>
    dispatchReview(rawText, review)
  );
  const hideThreadDropHint = useCallback(() => setThreadDropActive(false), []);
  const dismissPromptSuggestion = useCallback((threadId: string) => {
    setPromptSuggestions((current) => {
      if (!(threadId in current)) return current;
      const { [threadId]: _dismissed, ...rest } = current;
      return rest;
    });
  }, []);
  // Base branches the Codex "/review base" picker offers.
  const reviewBranches = useMemo(
    () => (gitState?.branches ?? []).filter((branch) => !branch.current).map((branch) => branch.name),
    [gitState?.branches]
  );
  // Whether /btw can run: Claude, directly or as an Orion main driver.
  const btwAvailable =
    selectedAgentModel?.providerId === 'claude' ||
    (isOrionModelId(selectedThread?.modelId ?? '') &&
      findAgentModel(agentModels, normalizedOrchestrationSettings.models.mainDriver)?.providerId === 'claude');

  // A thread on another machine is busy while its run goes on there: the
  // composer queues follow-ups and its Stop button stops that run.
  const composerIsSending = isSending || (Boolean(selectedThread?.remote) && selectedThread?.status === 'running');
  const composerNode = selectedThread ? (
    <div className="chat-input-area">
      <UserActionCards
        actions={selectedThreadUserActions}
        currentThreadId={selectedThread.id}
        onDone={onUserActionDone}
        onReply={onUserActionReply}
        onDismiss={onUserActionDismiss}
        onWatch={onUserActionWatch}
        onSecretAnswer={onSecretAnswer}
      />
      <CodexQuestions
        threadId={selectedThread.id}
        onAsyncAnswer={answerAsyncQuestion}
        explainApproval={explainApproval}
        remote={
          selectedThread.remote?.threadId
            ? {
                machineId: selectedThread.remote.machineId,
                machineName: selectedThread.remote.machineName,
                threadId: selectedThread.remote.threadId,
              }
            : undefined
        }
      />
      <AgentFamilySwitcher
        currentThread={selectedThread}
        threads={threads}
        onSelect={selectThread}
        split={threadPanes.length > 1}
      />
      {composerGitBar}
      <Composer
        controller={composerDraft}
        threadId={selectedThread.id}
        agentModels={agentModels}
        enabledProviderIds={enabledProviderIdSet}
        orionMcps={orionMcps}
        threads={threads}
        projects={projects}
        canReferenceThreads={canReferenceThreads}
        liveSlashCommands={selectedThreadSlashCommands}
        reviewBranches={reviewBranches}
        providerId={selectedAgentModel?.providerId ?? null}
        modelAvailable={selectedAgentModel?.available !== false}
        claudeBacked={selectedThreadClaudeBacked}
        btwAvailable={btwAvailable}
        isTerminalThread={isTerminalThread}
        isNativeSubagentThread={isNativeSubagentThread}
        workspaceUnavailable={selectedThreadWorkspaceUnavailable}
        workspaceRemoving={selectedThreadWorkspaceRemoving}
        isSending={composerIsSending}
        steerSupported={steerSupported}
        steerReady={steerReady}
        pendingLinkedTaskCount={pendingLinkedTasks.length}
        taskRow={
          <>
            {hasPendingLinkedTasks && (
              <div className="composer-task-row">
                {pendingLinkedTasks.map((linkedTask) => (
                  <div
                    key={linkedTask.id}
                    className={`composer-task-chip status-${linkedTask.lastStatus ?? 'linked'}`}
                    title={linkedTask.description || linkedTask.title}
                  >
                    <SquareKanban size={13} />
                    <span className="composer-task-title">{linkedTask.title}</span>
                    <span className="composer-task-status">
                      {linkedTaskStatusLabel(linkedTask.lastStatus)}
                    </span>
                    {linkedTask.lastStatus !== 'done' && !isSending && (
                      <button
                        type="button"
                        className="composer-task-action done"
                        onClick={() => markLinkedTaskDone(selectedThread.id, linkedTask.id)}
                        title="Mark the task as done in Durango Tasks"
                      >
                        <CircleCheck size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="composer-task-action"
                      onClick={() => unlinkTaskFromThread(selectedThread.id, linkedTask.id)}
                      title="Unlink task"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        }
        mcpRow={
          <>
            {attachedOrionMcps.length > 0 && selectedThread && !isTerminalThread && (
              <div className="composer-mcp-row">
                {attachedOrionMcps.map((server) => (
                  <div
                    key={server.id}
                    className={`composer-mcp-chip${server.status === 'needs-sign-in' ? ' needs-sign-in' : ''}`}
                    title={
                      server.status === 'needs-sign-in'
                        ? `@${server.nickname} needs a new sign-in in Settings → Skills & MCPs`
                        : `@${server.nickname} is loaded for every turn in this thread`
                    }
                  >
                    <Plug size={12} />
                    <span>@{server.nickname}</span>
                    <button
                      type="button"
                      onClick={() =>
                        updateThread(selectedThread.id, {
                          mcpServerIds: (selectedThread.mcpServerIds ?? []).filter((id) => id !== server.id),
                        })
                      }
                      title="Stop loading this MCP in this thread"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        }
        controlsClassName={`composer-controls${composerControlsCompact ? ' compact' : ''}`}
        controlsRef={composerControlsRef}
        onSend={sendFromComposer}
        onSteer={steerFromComposer}
        onStop={stopFromComposer}
        onDispatchReview={dispatchReviewFromComposer}
        onOpenAccountSettings={openAccountSettings}
        onThreadDragOver={hideThreadDropHint}
        promptSuggestion={promptSuggestions[selectedThread.id] ?? null}
        onDismissPromptSuggestion={dismissPromptSuggestion}
      >
        <>
          <div className="model-picker-anchor" ref={modelPickerRef}>
            <button
              className="model-trigger"
              onClick={() => {
                if (!modelPickerOpen) {
                  const providerId = selectedAgentModel?.providerId;
                  if (providerId) setActiveProviderTab(providerId);
                }
                setModelPickerOpen(!modelPickerOpen);
              }}
              disabled={composerIsSending}
            >
              {selectedAgentModel &&
                (() => {
                  const ProviderIcon =
                    agentProviders.find((provider) => provider.id === selectedAgentModel.providerId)
                      ?.icon ?? Play;
                  return <ProviderIcon size={15} />;
                })()}
              <span>{selectedAgentModel?.label ?? 'Select model'}</span>
              <ChevronDown
                size={14}
                className={`model-trigger-chevron ${modelPickerOpen ? 'open' : ''}`}
              />
            </button>

            {modelPickerOpen && (
              <ModelPickerPopover
                providers={agentProviders}
                models={visibleAgentModels}
                activeProviderId={activeProviderTab}
                onActiveProviderChange={setActiveProviderTab}
                search={modelSearch}
                onSearchChange={setModelSearch}
                selectedModelId={selectedThread.modelId}
                onSelect={async (model) => {
                  if (
                    selectedThread.modelId === claudeCodeCliModelId &&
                    model.id !== claudeCodeCliModelId
                  ) {
                    try {
                      await window.orion?.terminalKill?.(selectedThread.id);
                    } catch (error) {
                      console.error('Could not stop Claude Code terminal', error);
                    }
                  }
                  updateThread(selectedThread.id, {
                    modelId: model.id,
                    ...(selectedThread.modelId === claudeCodeCliModelId &&
                    model.id !== claudeCodeCliModelId
                      ? { status: 'idle' as const }
                      : {}),
                  });
                  setModelPickerOpen(false);
                  setModelSearch('');
                  if (
                    model.providerId !== 'codex' &&
                    model.providerId !== 'claude' &&
                    model.providerId !== 'grok'
                  ) {
                    setCodexSettingsOpen(false);
                  }
                }}
                overlay={
                  activeProviderTab === 'claude' && claudeCodeCliModel ? (
                    <button
                      type="button"
                      className={`model-cli-overlay${
                        selectedThread.modelId === claudeCodeCliModelId ? ' selected' : ''
                      }`}
                      onClick={() => {
                        if (selectedThread.modelId !== claudeCodeCliModelId) {
                          updateThread(selectedThread.id, {
                            modelId: claudeCodeCliModelId,
                          });
                        }
                        setModelPickerOpen(false);
                        setModelSearch('');
                      }}
                      disabled={claudeCodeCliModel.available === false}
                      title={
                        claudeCodeCliModel.unavailableReason ??
                        'Open an interactive Claude Code terminal in this thread'
                      }
                    >
                      <span className="model-cli-overlay-glow" aria-hidden />
                      <Terminal size={14} strokeWidth={2.25} />
                      <span className="model-cli-overlay-label">Claude Code CLI</span>
                      {selectedThread.modelId === claudeCodeCliModelId && (
                        <Check size={13} strokeWidth={2.5} />
                      )}
                    </button>
                  ) : undefined
                }
              />
            )}
          </div>

          {composerControlsCompact ? (
            /* No room for a chip per control: everything but the model picker
               folds into one menu whose groups expand in place. */
            <div className="composer-menu-anchor" ref={composerMenuRef}>
              <button
                type="button"
                className={`composer-menu-trigger${composerMenuOpen ? ' open' : ''}`}
                onClick={() => {
                  setComposerMenuOpen((open) => !open);
                  setComposerMenuSection(null);
                }}
                aria-haspopup="menu"
                aria-expanded={composerMenuOpen}
                aria-label="Composer options"
                title={`Options — ${agentSettingsSummary} · ${selectedAccessModeLabel}`}
              >
                <Menu size={16} />
                {linkedTaskIds.length > 0 && (
                  <span className="task-link-count">{linkedTaskIds.length}</span>
                )}
              </button>

              {composerMenuOpen &&
                createPortal(
                  <div ref={composerMenuPopoverRef} className="composer-menu" role="menu">
                    {shouldShowAgentSettings && (
                      <div className="composer-menu-group">
                        <button
                          type="button"
                          className={`composer-menu-row ${composerMenuSection === 'agent' ? 'open' : ''}`}
                          onClick={() =>
                            setComposerMenuSection((section) =>
                              section === 'agent' ? null : 'agent'
                            )
                          }
                          disabled={isSending}
                        >
                          <SlidersHorizontal size={14} />
                          <span className="composer-menu-row-label">
                            {selectedAgentModel?.providerId === 'claude'
                              ? 'Reasoning & context'
                              : selectedAgentModel?.providerId === 'grok' ||
                                  selectedAgentModel?.providerId === 'opencode'
                                ? 'Reasoning'
                                : 'Reasoning & tier'}
                          </span>
                          <span className="composer-menu-row-value">{agentSettingsSummary}</span>
                          <ChevronDown
                            size={13}
                            className={`model-trigger-chevron ${
                              composerMenuSection === 'agent' ? 'open' : ''
                            }`}
                          />
                        </button>
                        {composerMenuSection === 'agent' && (
                          <div className="composer-menu-panel">{agentSettingsOptions}</div>
                        )}
                      </div>
                    )}

                    <div className="composer-menu-group">
                      <button
                        type="button"
                        className={`composer-menu-row ${composerMenuSection === 'access' ? 'open' : ''}`}
                        onClick={() =>
                          setComposerMenuSection((section) =>
                            section === 'access' ? null : 'access'
                          )
                        }
                        disabled={isSending}
                      >
                        <Shield size={14} />
                        <span className="composer-menu-row-label">Access</span>
                        <span className="composer-menu-row-value">{selectedAccessModeLabel}</span>
                        <ChevronDown
                          size={13}
                          className={`model-trigger-chevron ${
                            composerMenuSection === 'access' ? 'open' : ''
                          }`}
                        />
                      </button>
                      {composerMenuSection === 'access' && (
                        <div className="composer-menu-panel">{accessModeList}</div>
                      )}
                    </div>

                    {!isTerminalThread && (
                      <div className="composer-menu-group">
                        <button
                          type="button"
                          className={`composer-menu-row ${composerMenuSection === 'tasks' ? 'open' : ''}`}
                          onClick={() =>
                            setComposerMenuSection((section) =>
                              section === 'tasks' ? null : 'tasks'
                            )
                          }
                          title={linkedTasksLabel}
                        >
                          <SquareKanban size={14} />
                          <span className="composer-menu-row-label">Durango Tasks</span>
                          <span className="composer-menu-row-value">
                            {linkedTaskIds.length > 0 ? `${linkedTaskIds.length} linked` : 'None'}
                          </span>
                          <ChevronDown
                            size={13}
                            className={`model-trigger-chevron ${
                              composerMenuSection === 'tasks' ? 'open' : ''
                            }`}
                          />
                        </button>
                        {composerMenuSection === 'tasks' && (
                          <div className="composer-menu-panel embedded-picker">
                            <TaskPickerPopover
                              linkedTaskIds={linkedTaskIds}
                              authenticated={accountState.authenticated}
                              onSignIn={() => void handleStartAccountAuth()}
                              onPick={toggleTaskOnSelectedThread}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>,
                  document.body
                )}
            </div>
          ) : (
            <>
              {shouldShowAgentSettings && (
                <div className="codex-settings-anchor" ref={codexSettingsRef}>
                  <button
                    className="codex-settings-trigger"
                    onClick={() => setCodexSettingsOpen((open) => !open)}
                    disabled={isSending}
                    title={
                      selectedAgentModel?.providerId === 'claude'
                        ? 'Claude reasoning and context window'
                        : selectedAgentModel?.providerId === 'grok'
                          ? 'Grok reasoning effort'
                        : selectedAgentModel?.providerId === 'muse'
                          ? 'Muse reasoning effort'
                          : selectedAgentModel?.providerId === 'opencode'
                            ? 'OpenCode model variant'
                          : 'Codex reasoning and service tier'
                    }
                  >
                    <span>
                      {selectedAgentModel?.providerId === 'claude'
                        ? selectedClaudeReasoningLabel
                        : selectedAgentModel?.providerId === 'grok'
                          ? selectedGrokReasoningLabel
                          : selectedAgentModel?.providerId === 'muse'
                            ? selectedMuseReasoningLabel
                            : selectedAgentModel?.providerId === 'opencode'
                              ? selectedOpenCodeReasoningLabel
                            : selectedCodexReasoningLabel}
                    </span>
                    {selectedAgentModel?.providerId !== 'grok' &&
                      selectedAgentModel?.providerId !== 'muse' &&
                      selectedAgentModel?.providerId !== 'opencode' && (
                      <>
                        <span className="control-dot">·</span>
                        <span>
                          {selectedAgentModel?.providerId === 'claude'
                            ? selectedClaudeContextWindowLabel
                            : selectedCodexServiceTierLabel}
                        </span>
                      </>
                    )}
                    <ChevronDown
                      size={14}
                      className={`model-trigger-chevron ${codexSettingsOpen ? 'open' : ''}`}
                    />
                  </button>

                  {codexSettingsOpen && (
                    <div className="codex-settings-popover">{agentSettingsOptions}</div>
                  )}
                </div>
              )}

              <div className="access-mode-anchor" ref={accessModeRef}>
                <button
                  type="button"
                  className="access-select"
                  onClick={() => setAccessModeOpen((open) => !open)}
                  disabled={isSending}
                  title="Access level"
                >
                  <Shield size={15} />
                  <span>{selectedAccessModeLabel}</span>
                  <ChevronDown
                    size={13}
                    className={`model-trigger-chevron ${accessModeOpen ? 'open' : ''}`}
                  />
                </button>

                {accessModeOpen && !isSending && (
                  <div className="access-mode-popover">{accessModeList}</div>
                )}
              </div>

              {!isTerminalThread && (
                <div className="task-picker-anchor" ref={taskPickerRef}>
                  <button
                    className={`model-trigger task-link-trigger ${linkedTaskIds.length > 0 ? 'linked' : ''}`}
                    onClick={() => setTaskPickerOpen((open) => !open)}
                    title={linkedTasksLabel}
                    aria-label={linkedTasksLabel}
                  >
                    <SquareKanban size={15} />
                    {linkedTaskIds.length > 1 && (
                      <span className="task-link-count">{linkedTaskIds.length}</span>
                    )}
                  </button>
                  {taskPickerOpen && (
                    <TaskPickerPopover
                      linkedTaskIds={linkedTaskIds}
                      authenticated={accountState.authenticated}
                      onSignIn={() => void handleStartAccountAuth()}
                      onPick={toggleTaskOnSelectedThread}
                    />
                  )}
                </div>
              )}
            </>
          )}

          <input
            ref={attachmentInputRef}
            className="composer-file-input"
            type="file"
            multiple
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const files = event.currentTarget.files;
              if (files?.length) void attachFiles(files);
              // Let the same file be selected again after it is removed.
              event.currentTarget.value = '';
            }}
          />
          <button
            type="button"
            className="attachment-trigger"
            onClick={() => attachmentInputRef.current?.click()}
            disabled={isNativeSubagentThread || selectedThreadWorkspaceUnavailable}
            title="Attach files"
            aria-label="Attach files"
          >
            <Paperclip size={15} />
          </button>
        </>
      </Composer>
    </div>
  ) : null;

  return (
    <div
      className={`app-container ${draggingFiles ? 'dragging-files' : ''}`}
      onDragEnter={handleRootDragEnter}
      onDragOver={handleRootDragOver}
      onDragLeave={handleRootDragLeave}
      onDrop={handleRootDrop}
    >
      <Toaster position="top-center" richColors closeButton />
      <ProjectPickerModal
        open={projectPickerOpen && !repositoryOperationBusy}
        initialView={projectPickerView}
        projects={sortedProjects}
        selectedProjectId={activeThreadProject?.id ?? null}
        onSelect={projectPickerView === 'projects' ? handleChangeSelectedThreadProject : undefined}
        onAddProjectPath={(path) => void handleAddProject({ path })}
        onAddProjectWithDialog={() => void handleAddProject()}
        onRemoveProject={(project) => {
          if (confirm(`Remove "${project.name}" and its threads? Files on disk are not affected.`)) {
            void removeProjectWithRuntimes(project.id);
          }
        }}
        onClose={closeProjectPicker}
      />
      <ImageLightbox />
      {draggingFiles && (
        <div className="file-drop-overlay">
          <div className="file-drop-target">
            <Paperclip size={28} />
            <span>Drop files to attach</span>
          </div>
        </div>
      )}

      <div className="app-shellbar">
        <div className="shell-sidebar-chrome">
          <div className="shell-brand">
            <img src={orionIconUrl} alt="Durango Code" className="shell-brand-logo" width={28} height={28} draggable={false} />
            <span className="shell-brand-name">Code</span>
          </div>
        </div>

        <div className="shell-main-chrome">
          <div className="shell-title-group">
            {activeTab === 'agents' && activeThreadProject && (
              <>
                <div className="shell-project-control shell-breadcrumb-project" ref={projectPickerRef}>
                  <button
                    type="button"
                    className="shell-project-trigger"
                    onClick={() => {
                      if (repositoryOperationBusy || activeWorkspaceUnavailable) return;
                      if (selectedThread && !canChangeSelectedThreadProject) return;
                      openProjectPicker();
                    }}
                    disabled={
                      repositoryOperationBusy ||
                      activeWorkspaceUnavailable ||
                      (!!selectedThread && !canChangeSelectedThreadProject)
                    }
                    title={
                      repositoryOperationBusy
                        ? 'Repository operation in progress'
                        : activeWorkspaceUnavailable
                          ? 'Wait for the thread’s Durango workspace to become available'
                          : selectedThread && !canChangeSelectedThreadProject
                            ? selectedThread.durangoWorkspace
                              ? 'Project is locked to the thread’s Durango workspace'
                              : 'Project is locked after an agent runs'
                            : activeIsNoProject
                              ? 'Not tied to a project'
                              : activeThreadProject.path
                    }
                    aria-haspopup="dialog"
                  >
                    {activeIsNoProject ? (
                      <MessageSquare size={14} />
                    ) : (
                      <ProjectBadge project={activeThreadProject} size={16} />
                    )}
                    <span className="truncate">
                      {/* Another machine's thread whose project isn't here: its name there. */}
                      {activeIsNoProject && selectedThread?.remote?.projectName
                        ? selectedThread.remote.projectName
                        : activeThreadProject.name}
                    </span>
                    {(!selectedThread || canChangeSelectedThreadProject) && (
                      <ChevronDown size={13} className={`project-pill-chevron ${projectPickerOpen ? 'open' : ''}`} />
                    )}
                  </button>
                </div>
                {/* T3-style breadcrumb: project / thread. */}
                {selectedThread && <span className="shell-breadcrumb-separator">/</span>}
              </>
            )}
            {activeTab === 'agents' && selectedThread ? (
              <div className="thread-title-menu shell-thread-title-menu" ref={threadMenuRef}>
                {threadRenameKey === `shell:${selectedThread.id}` ? (
                  <InlineRenameInput
                    className="shell-title-rename-input"
                    initialValue={selectedThread.title}
                    onSubmit={(title) => {
                      updateThread(selectedThread.id, { title });
                      setThreadRenameKey(null);
                    }}
                    onCancel={() => setThreadRenameKey(null)}
                  />
                ) : (
                  <span className="shell-title truncate">{shellTitle}</span>
                )}
                <button
                  type="button"
                  className="thread-title-menu-trigger"
                  onClick={() => setThreadMenuOpen((open) => !open)}
                  aria-label="Thread options"
                  aria-haspopup="menu"
                  aria-expanded={threadMenuOpen}
                  title="Thread options"
                >
                  <Ellipsis size={14} />
                </button>
                {threadMenuOpen && (
                  <div className="thread-menu" role="menu">
                    <button
                      type="button"
                      className="project-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setThreadMenuOpen(false);
                        if (!selectedThread) return;
                        setThreadRenameKey(`shell:${selectedThread.id}`);
                      }}
                    >
                      <SquarePen size={13} /> Rename
                    </button>
                    <button
                      type="button"
                      className="project-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setThreadMenuOpen(false);
                        if (selectedThread) void branchThreadWithFeedback(selectedThread.id);
                      }}
                    >
                      <GitBranch size={13} /> Branch
                    </button>
                    <button
                      type="button"
                      className="project-menu-item danger"
                      role="menuitem"
                      onClick={() => {
                        setThreadMenuOpen(false);
                        if (confirm('Delete this thread?')) {
                          void deleteThreadWithRuntime(selectedThread.id);
                        }
                      }}
                    >
                      <Trash2 size={13} /> Delete
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <span className="shell-title truncate">{shellTitle}</span>
            )}
            {activeTab === 'agents' && selectedThread?.goal && (
              <div className="goal-chip-wrap" ref={goalMenuRef}>
                <button
                  type="button"
                  className={`goal-chip status-${selectedThread.goal.status}`}
                  onClick={() => setGoalMenuOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={goalMenuOpen}
                  title={goalSummaryLine(selectedThread.goal)}
                >
                  <Target size={12} />
                  <span className="goal-chip-status">
                    {goalStatusLabels[selectedThread.goal.status] ?? selectedThread.goal.status}
                  </span>
                  <span className="goal-chip-objective truncate">{selectedThread.goal.objective}</span>
                  {goalUsageSummary(selectedThread.goal) && (
                    <span className="goal-chip-usage">{goalUsageSummary(selectedThread.goal)}</span>
                  )}
                </button>
                {goalMenuOpen && (
                  <div className="thread-menu goal-menu" role="menu">
                    {selectedThread.goal.status === 'active' ? (
                      <button
                        type="button"
                        className="project-menu-item"
                        role="menuitem"
                        onClick={() => {
                          setGoalMenuOpen(false);
                          void handleGoalCommand('/goal pause', 'pause');
                        }}
                      >
                        <Pause size={13} /> Pause goal
                      </button>
                    ) : selectedThread.goal.status !== 'complete' ? (
                      <button
                        type="button"
                        className="project-menu-item"
                        role="menuitem"
                        onClick={() => {
                          setGoalMenuOpen(false);
                          void handleGoalCommand('/goal resume', 'resume');
                        }}
                      >
                        <Play size={13} /> Resume goal
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="project-menu-item danger"
                      role="menuitem"
                      onClick={() => {
                        setGoalMenuOpen(false);
                        void handleGoalCommand('/goal clear', 'clear');
                      }}
                    >
                      <X size={13} /> Clear goal
                    </button>
                  </div>
                )}
              </div>
            )}
            {shellSubtitle && (
              <>
                <span className="shell-title-divider" />
                <span className="shell-subtitle truncate">{shellSubtitle}</span>
              </>
            )}

            {activeTab === 'agents' && selectedThread && (
              <span className={`status-dot shell-status-dot ${selectedThread.status}`} />
            )}
          </div>

          <div className="shell-right-group">
            {activeTab === 'agents' && !settingsOpen && (
              <button
                type="button"
                className="shell-openwith-trigger"
                aria-pressed={browserVisible}
                aria-expanded={browserVisible}
                title={browserVisible ? 'Hide browser' : 'Show browser'}
                aria-label={browserVisible ? 'Hide browser' : 'Show browser'}
                onClick={toggleBrowser}
              >
                <Globe size={14} />
                {browserAgentTabCount > 0 && <span className="text-[11px] tabular-nums">{browserAgentTabCount}</span>}
              </button>
            )}
            {openWithApps.length > 0 && activeWorkingDir && (
              <div className="shell-openwith-control" ref={openWithRef}>
                <button
                  type="button"
                  className="shell-openwith-trigger"
                  onClick={() => setOpenWithOpen((open) => !open)}
                  title={`Open ${activeWorkingDir.split(/[\\/]/).pop() || activeWorkingDir} in another app`}
                  aria-label="Open with"
                  aria-haspopup="menu"
                  aria-expanded={openWithOpen}
                >
                  <SquareArrowOutUpRight size={14} />
                  <ChevronDown size={13} className={`project-pill-chevron ${openWithOpen ? 'open' : ''}`} />
                </button>
                {openWithOpen && (
                  <div className="shell-openwith-menu" role="menu">
                    {openWithApps.map((appOption) => (
                      <button
                        key={appOption.id}
                        type="button"
                        className="openwith-item"
                        role="menuitem"
                        onClick={() => {
                          setOpenWithOpen(false);
                          void window.orion
                            ?.openProjectWith?.({
                              appId: appOption.id,
                              projectPath: activeWorkingDir,
                            })
                            .then((result) => {
                              if (result && !result.ok && result.error) {
                                toast.error(result.error);
                              }
                            });
                        }}
                      >
                        {appOption.icon ? (
                          <img
                            src={appOption.icon}
                            alt=""
                            className="openwith-item-icon"
                            width={18}
                            height={18}
                            draggable={false}
                          />
                        ) : (
                          <AppWindow size={16} className="openwith-item-icon" />
                        )}
                        <span className="truncate">{appOption.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="shell-mode-tabs" role="tablist" aria-label="Mode">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'agents'}
                className={`shell-mode-tab ${activeTab === 'agents' ? 'active' : ''}`}
                onClick={() => handleSetActiveTab('agents')}
              >
                <MessageSquare size={15} /> Agents
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'code'}
                className={`shell-mode-tab ${activeTab === 'code' ? 'active' : ''}`}
                onClick={() => handleSetActiveTab('code')}
              >
                <Code2 size={15} /> Code
              </button>
            </div>
          </div>
        </div>
      </div>

      {!settingsOpen && (availableProviderUpdates.length > 0 || providerUpdatesRunning) && (
        <div className="provider-update-banner" role="status">
          <button
            type="button"
            className="provider-update-copy"
            title={providerUpdatesRunning ? 'Open provider update progress' : providerUpdateTooltip}
            onClick={openProviderSettings}
          >
            <RefreshCw size={14} className={providerUpdatesRunning ? 'spinning' : ''} />
            <span>
              {providerUpdatesRunning
                ? (providerUpdateProgress?.message ?? 'Updating provider CLIs…')
                : providerUpdateSummary}
            </span>
          </button>
          <button
            type="button"
            className="provider-update-button"
            onClick={providerUpdatesRunning ? openProviderSettings : handleUpdateProviders}
            aria-busy={providerUpdatesRunning}
          >
            {providerUpdatesRunning ? 'View progress' : 'Update providers'}
          </button>
        </div>
      )}

      {showTextGenerationModelPrompt && (
        <TextGenerationModelPrompt
          providers={utilityProviders}
          models={utilityCandidateModels}
          onSelect={(model) => setTextGenerationSettings({ modelId: model.id })}
          onDismiss={() => setTextGenerationPromptDismissed(true)}
        />
      )}

      {whatsNew?.unseen && (
        <WhatsNewNotice version={whatsNew.version} notes={whatsNew.notes} onDismiss={dismissWhatsNew} />
      )}

      {restartToUpdateConfirmOpen && appUpdateState?.status === 'downloaded' && (
        <RestartToUpdateDialog
          version={appUpdateState.availableVersion}
          runningThreadCount={runningThreadCount}
          onCancel={cancelRestartToUpdate}
          onConfirm={() => void confirmRestartToUpdate()}
        />
      )}

      {showWorkspaceSyncNotice && (
        <WorkspaceSyncNotice
          onTurnOff={turnOffWorkspaceSyncFromNotice}
          onAcknowledge={acknowledgeWorkspaceSyncNotice}
        />
      )}

      {settingsOpen && (
        <React.Suspense fallback={<div className="settings-page" />}>
          <SettingsPage {...settingsPageModel} />
        </React.Suspense>
      )}

      {!settingsOpen && (
        <div className="main-content">
          {/* ========== AGENTS TAB ========== */}
          {activeTab === 'agents' && (
            <>
              {/* Sidebar: Projects + Threads */}
              {sidebarV2Enabled ? (
                <SidebarV2
                  actions={sidebarV2Actions}
                  projects={projects}
                  noProject={noProject}
                  selectedThreadId={selectedThreadId}
                  paneThreadIds={paneThreadIds}
                  threadsByView={sidebarV2Lists}
                  views={sidebarV2Views}
                  setViewVisible={setSidebarV2ViewVisible}
                  attentionThreadIds={attentionThreadIds}
                  selectProject={stableAgentsSidebarActions.handleCreateThread}
                  handleNewAgent={stableAgentsSidebarActions.handleNewAgent}
                  handleAddProject={handleSidebarV2AddProject}
                  threadSearchOpen={threadSearchOpen}
                  setThreadSearchOpen={setThreadSearchOpen}
                  threadSearchRef={threadSearchRef}
                  extraSections={sidebarV2ExtraSections}
                  sidebarFooterProps={sidebarFooterProps}
                />
              ) : (
                <AgentsSidebar {...agentsSidebarModel} />
              )}

              {/* Main Panel: Thread view */}
              <div
                className={`panel agents-panel${threadDropActive ? ' thread-drop-active' : ''}`}
                onDragOver={handleThreadDragOver}
                onDragLeave={handleThreadDragLeave}
                onDrop={handleThreadDrop}
              >
                {threadDropActive && (
                  <div className={`thread-drop-hint${splitFull ? ' full' : ''}`}>
                    <Columns3 size={18} />
                    <span>
                      {splitFull
                        ? `Split view is full — ${MAX_THREAD_PANES} panes is the limit`
                        : threadPanes.length === 0
                          ? 'Drop to open this thread'
                          : 'Drop to open beside the current view'}
                    </span>
                  </div>
                )}
                {threadPanes.length === 0 ? (
                  // The effect above opens a fresh composer within a frame, so
                  // the panel stays blank meanwhile; the placeholder is only
                  // for when there is no project to start a thread in.
                  storeHydrated && !defaultNewThreadProject && (
                    <div className="empty-state">
                      <div className="empty-state-icon">
                        <Bot size={30} />
                      </div>
                      <div className="empty-state-title">Select a thread</div>
                      <div className="text-xs text-[#6b6b74]">Pick a conversation or start a new one</div>
                    </div>
                  )
                ) : (
                  <div className={`thread-panes count-${threadPanes.length}`}>
                    {threadPanes.map((pane) => {
                      const tasksCardState = tasksCardStates[pane.thread.id] ?? {
                        position: null,
                        collapsed: false,
                        dismissedFor: null,
                      };
                      return (
                        <ThreadPane
                          key={pane.thread.id}
                          thread={pane.thread}
                          project={pane.project}
                          focused={pane.focused}
                          split={threadPanes.length > 1}
                          onFocus={() => selectThread(pane.thread.id)}
                          onClose={() => closeThreadPane(pane.thread.id)}
                          statusDot={renderThreadStatusDot(pane.thread)}
                        >
                          <DeviceCard threadId={pane.thread.id} />
                          {pane.isTerminal ? (
                            // Mounting spawns the CLI: hold off while the thread's
                            // workspace is being removed so it never opens in a
                            // directory that is about to go away.
                            pane.workspaceUnavailable ? (
                              <div className="terminal-view" />
                            ) : (
                              <React.Suspense fallback={<div className="terminal-view" />}>
                                <TerminalView
                                  key={pane.thread.id}
                                  threadId={pane.thread.id}
                                  projectPath={pane.projectPath ?? ''}
                                  accessMode={pane.thread.accessMode ?? 'full-access'}
                                  focused={pane.focused}
                                  resumeSessionId={pane.thread.agentSessionIds?.claude}
                                  forkSession={pane.thread.pendingForkProviders?.includes('claude')}
                                  generalInstructions={[
                                    normalizedOrchestrationSettings.generalInstructions.trim(),
                                    terminalDurangoMemoryBlock,
                                  ]
                                    .filter(Boolean)
                                    .join('\n\n')}
                                />
                              </React.Suspense>
                            )
                          ) : (
                            <ChatTranscript
                              threadId={pane.thread.id}
                              projectName={pane.project?.name}
                              canChangeProject={pane.canChangeProject}
                              onOpenProjectPicker={openProjectPicker}
                              agentModels={agentModels}
                              mediaBaseDirs={pane.mediaBaseDirs}
                              isSending={pane.isSending}
                              steerSupported={pane.steerSupported}
                              steerReady={pane.steerReady}
                              authenticatingProviderId={authenticatingProviderId}
                              {...paneChatRefs(pane.thread.id)}
                              chatScrollPositionsRef={chatScrollPositionsRef}
                              tasksCardPosition={tasksCardState.position}
                              tasksCardCollapsed={tasksCardState.collapsed}
                              tasksCardDismissedFor={tasksCardState.dismissedFor}
                              onMoveTasksCard={moveTasksCard}
                              onToggleTasksCard={toggleTasksCard}
                              onDismissTasksCard={dismissTasksCard}
                              onMarkTaskDone={markLinkedTaskDone}
                              onUnlinkTask={unlinkTaskFromThread}
                              onDismissBtwExchange={dismissBtwExchange}
                              onAuthenticateProvider={handleAuthenticateProvider}
                              onDiscardClaudeBackgroundTasks={discardClaudeBackgroundTasks}
                              onSteerQueuedMessage={steerQueuedMessage}
                            />
                          )}
                          {pane.focused ? composerNode : null}
                        </ThreadPane>
                      );
                    })}
                  </div>
                )}
              </div>

              {browserVisible && (
                <BrowserPanel
                  tabs={browserPanelTabs}
                  selectedTabId={browserActiveTabId}
                  onSelectTab={setBrowserSelectedTabId}
                  focusedThreadId={selectedThreadId}
                  focusedProjectPath={activeWorkingDir}
                  ownerLabel={browserOwnerLabel}
                  expanded={browserExpanded}
                  onExpand={expandBrowser}
                  onCollapse={collapseBrowser}
                  minimized={browserMinimized}
                  onMinimizedChange={setBrowserMinimized}
                  onClose={closeBrowser}
                />
              )}
            </>
          )}

          {/* ========== CODE TAB ========== */}
          {activeTab === 'code' && (
            <CodeWorkspace
              runningAgentCount={runningAgentCount}
              turnRefreshTick={treeTurnRefreshTick}
              sidebarFooterProps={sidebarFooterProps}
            />
          )}
        </div>
      )}
    </div>
  );
};

export default App;
