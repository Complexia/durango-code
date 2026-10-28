import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { agentModelSuccessors } from './agentCatalog';
import { createThreadBranchFamily } from './thread-branching';
import { defaultWorkspaceSyncConsentSettings, migrateWorkspaceSyncSettings } from './app/workspaceSyncConsent';

export type Project = {
  id: string;
  name: string;
  path: string;
};

/**
 * Pseudo-project for agents started with "No project" selected (a plain chat,
 * not tied to a repository). It is never stored in `projects`, so project
 * lists and repository controls don't see it; threads reference it by
 * id and run in an Orion-owned scratch directory (`noProject.path`).
 */
export const NO_PROJECT_ID = 'orion:no-project';
export const NO_PROJECT_NAME = 'No project';
export const isNoProjectId = (id: string | null | undefined) => id === NO_PROJECT_ID;

/** Looks up a thread's project, resolving the No project pseudo-project too. */
export const findProjectById = (
  state: { projects: Project[]; noProject: Project | null },
  id: string | null | undefined
): Project | undefined => {
  if (!id) return undefined;
  if (id === NO_PROJECT_ID) return state.noProject ?? undefined;
  return state.projects.find((project) => project.id === id);
};

/**
 * The model behind Orion's hidden text-generation turns: thread titles,
 * commit messages, and PR descriptions. These are short, latency-sensitive
 * one-shots, so the default is the fastest model on whichever providers the
 * user actually has installed.
 */
export type TextGenerationSettings = {
  /**
   * AgentModel id. `null` means the user has never picked one, so the model is
   * resolved from the built-in preference order (GPT-6 Luna, then Claude Haiku
   * 5.5; see UTILITY_MODEL_PREFERENCE in App.tsx) against the installed,
   * enabled providers, and the user is asked to pick when neither is usable.
   */
  modelId: string | null;
  /**
   * Reasoning effort for the providers that take one (codex, claude, grok).
   * `null` means unset, which resolves to the cheapest tier — these turns are
   * a title or a commit message, not work worth thinking hard about. Kept as a
   * plain string because the accepted values differ per provider; the renderer
   * clamps it to the selected model's own options.
   */
  reasoningEffort: string | null;
};

export const defaultTextGenerationSettings: TextGenerationSettings = {
  modelId: null,
  reasoningEffort: null,
};

/**
 * Orion Cloud deploys. Simple apps deploy straight from the navbar; anything
 * Railpack can't build unattended (monorepos, compose stacks) is handed to a
 * visible agent thread that drives `orion-cli` instead.
 */
export type DeploymentSettings = {
  /**
   * AgentModel id for the deployment agent. `null` means never picked, which
   * falls back to the text-generation model (see resolvedDeploymentModelId in
   * App.tsx).
   */
  agentModelId: string | null;
  /**
   * Reasoning effort for the deployment agent. Kept provider-agnostic like
   * TextGenerationSettings because each model family exposes different tiers;
   * the renderer clamps it to the selected deployment model's options.
   */
  reasoningEffort: string | null;
  /** Route every deploy through the agent, even ones Orion judges simple. */
  preferAgentDeploys: boolean;
};

export const defaultDeploymentSettings: DeploymentSettings = {
  agentModelId: null,
  reasoningEffort: null,
  preferAgentDeploys: false,
};

/**
 * Sidebar v2 (Settings → Experimental): one flat thread list with snooze and
 * settle instead of project groups. `views` are the lists toggled from its
 * header menu.
 */
export type SidebarV2Settings = {
  enabled: boolean;
  views: { pinned: boolean; recent: boolean; snoozed: boolean; settled: boolean };
  /**
   * Set once the threads from before sidebar v2 were settled. The first time
   * it is turned on, every listed thread except pinned ones is settled so the
   * sidebar starts empty instead of holding the whole history.
   */
  settledExistingAt?: string;
};

/** Settings → Cosmetics. */
export type AppearanceSettings = {
  /** Zoom factor for the whole window (text, icons and spacing alike). */
  uiScale: number;
};

export const UI_SCALE_OPTIONS = [1, 1.1, 1.2, 1.3] as const;

export const defaultAppearanceSettings: AppearanceSettings = {
  uiScale: 1.1,
};

export const defaultSidebarV2Settings: SidebarV2Settings = {
  enabled: false,
  views: { pinned: true, recent: true, snoozed: false, settled: false },
};

/**
 * Settles every thread sidebar v2 would list (not pinned, snoozed, settled or
 * running), as if the user had clicked Settle on each.
 */
const settleThreadsForSidebarV2 = (threads: Thread[], at: string): Thread[] =>
  threads.map((thread) =>
    thread.pinnedAt || thread.snoozedAt || thread.settledAt || thread.status === 'running'
      ? thread
      : { ...thread, settledAt: at, wokeAt: undefined, wokeReason: undefined, finishedUnseenAt: undefined }
  );

/**
 * Durango workspaces (docs/workspaces.md): an isolated checkout per thread.
 * Agents create one themselves (`durango-code ws new`, the bundled
 * durango-workspaces skill) when they start work in a repository that has a
 * durango.toml; with `enabled` the app instead creates it before every new
 * thread's first turn.
 */
export type DurangoWorkspaceSettings = {
  /** Create a workspace before the first turn of every new thread in Durango repositories. */
  enabled: boolean;
  /**
   * 2 since agents create workspaces themselves: stores from before then had
   * `enabled` on by default and are switched off once.
   */
  version?: number;
};

export const defaultDurangoWorkspaceSettings: DurangoWorkspaceSettings = {
  enabled: false,
  version: 2,
};

/**
 * Work sharing ("Share coding work with Durango") — workspace sync to Durango
 * Code web (docs in orion-web/docs/workspace-sync.md): projects,
 * threads (full transcripts), token usage, and — when syncCode is on — code
 * as Durango Cloud repos with full git history. Durango Chat builds its
 * memory from summaries of the synced threads. On by default since the
 * Durango merge (consentVersion 1, see app/workspaceSyncConsent.ts); while
 * off (or signed out) the desktop makes no sync calls of any kind and
 * captures nothing extra.
 */
export type WorkspaceSyncSettings = {
  /** Master switch; requires a signed-in Durango account to take effect. */
  enabled: boolean;
  /**
   * Auto-publish git projects and auto-push branch save points (commits).
   * Dirty working-tree files are never uploaded by workspace sync.
   */
  syncCode: boolean;
  /** Consent policy these settings were reconciled with (1 = default Full). */
  consentVersion: number;
  /** The one-time "your coding work now syncs" notice was acknowledged. */
  consentNoticeSeen: boolean;
};

export const defaultWorkspaceSyncSettings: WorkspaceSyncSettings = {
  ...defaultWorkspaceSyncConsentSettings,
};

/** Durango (durango.sh) integration preferences. */
export type DurangoSettings = {
  /**
   * Add a compact "[Durango memory]" block (what Durango remembers about the
   * user) to the agent instructions when a thread starts. Off by default:
   * memory is otherwise pull-based through the recall_memory tool.
   */
  includeProfileMemory: boolean;
  /**
   * Linked tasks come from Durango Tasks (durango.sh/tasks). Off switches the
   * task picker back to the legacy Durango Code web board (rollback; the
   * DURANGO_TASKS=0 env var does the same).
   */
  useDurangoTasks: boolean;
  /** "Allow Durango Chat to start agents on this Mac" (main: durango-dispatch.js). */
  dispatch: DurangoDispatchSettings;
};

export type DurangoDispatchSettings = {
  /** Off by default. Requires a signed-in Durango account. */
  enabled: boolean;
  /** Projects dispatched agents may run in; null = all projects. */
  allowedProjectIds: string[] | null;
  /**
   * Access for dispatched runs, and the ceiling: a run never gets more even
   * if Durango Chat asks for it. Read only by default.
   */
  accessMode: Thread['accessMode'];
  /** Model for dispatched runs when Durango Chat names none; null = the project's usual model. */
  modelId: string | null;
  /** Dispatched runs at a time on this Mac. */
  maxConcurrent: 1 | 2;
};

export const defaultDurangoDispatchSettings: DurangoDispatchSettings = {
  enabled: false,
  allowedProjectIds: null,
  accessMode: 'read-only',
  modelId: null,
  maxConcurrent: 1,
};

export const defaultDurangoSettings: DurangoSettings = {
  includeProfileMemory: false,
  useDurangoTasks: true,
  dispatch: defaultDurangoDispatchSettings,
};

/**
 * Remote control between paired Orion instances signed in to the same
 * account. `enabled` is the master switch: it shows the sidebar Machines
 * section and lets this machine drive its paired hosts. `allowIncoming`
 * additionally lets paired machines drive THIS one (starts a listener on
 * `port`); it is meaningless while `enabled` is off or the user is signed
 * out — the main-process engine enforces both. The settings UI keeps the two
 * in lockstep (enabling remote control implies being controllable — pairing
 * codes are still required for anything to connect); the field survives for
 * the engine contract and persisted-state compatibility.
 */
export type RemoteControlSettings = {
  enabled: boolean;
  allowIncoming: boolean;
  port: number;
  /**
   * How paired machines reach each other. `'direct'` is LAN/VPN only and
   * contacts nothing outside your network. `'relay'` additionally lets this
   * machine be reached over the internet through Orion Cloud's relay, which
   * brokers an already-encrypted connection it cannot read. Defaults to
   * `'direct'` — being reachable from outside is always an explicit choice.
   */
  connectionMode: 'direct' | 'relay';
};

export const defaultRemoteControlSettings: RemoteControlSettings = {
  enabled: false,
  allowIncoming: false,
  port: 47615,
  connectionMode: 'direct',
};

export type AgentToolSource = { url: string; title?: string };

export type AgentPlanEntry = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
};

export type AgentActivity = {
  id: string;
  key?: string;
  type: 'thought' | 'command' | 'tool' | 'result' | 'error' | 'plan';
  /** Provider tool kind (execute/edit/read/search/fetch/task/plan) for iconography. */
  kind?: string;
  title: string;
  detail?: string;
  /** Transient IPC-only append. It is folded into detail before persistence. */
  detailDelta?: string;
  /** Full tool input (command, pretty-printed arguments) shown when the row is expanded. */
  input?: string;
  /** Live tool output (streaming terminal stdout, tool result text). */
  output?: string;
  exitCode?: number;
  /** Line counts for a file edit, rendered as a +N −N chip. */
  diff?: { path: string; additions: number; deletions: number };
  /** Web search / fetch result links. */
  sources?: AgentToolSource[];
  /** Live task checklist (agent plan / todo-list updates). */
  plan?: AgentPlanEntry[];
  /** 'waiting' = blocked on a permission decision. */
  status?: 'running' | 'done' | 'error' | 'waiting';
  ts: string;
  /**
   * Length of the message content when this activity was added — lets the
   * transcript interleave activities with the streamed text in order.
   * Activities updated in place (by key) keep their original offset.
   */
  contentOffset?: number;
};

export type TurnTokenStats = {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  reasoningTokens?: number;
  /** Input carried by the most recent model request, not the cumulative thread total. */
  contextTokens?: number;
  contextWindow?: number;
  modelId?: string;
};

export type ChangedFileSummary = {
  path: string;
  status: 'added' | 'copied' | 'conflicted' | 'deleted' | 'modified' | 'renamed' | 'untracked';
  additions: number;
  deletions: number;
};

export type FileAttachment = {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
};

export type Message = {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  ts: string;
  attachments?: FileAttachment[];
  kind?: 'text' | 'agent-run' | 'claude-background-intervention';
  status?: 'running' | 'done' | 'error' | 'stopped';
  statusText?: string;
  command?: string;
  activities?: AgentActivity[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /**
   * Set when the turn's error text reads as a logged-out provider CLI: the
   * transcript offers an Authenticate button for this provider instead of a
   * dead-end error.
   */
  authProviderId?: string;
  changedFiles?: ChangedFileSummary[];
  /** Per-turn token usage, when the provider reports it (grok ACP). */
  stats?: TurnTokenStats;
  /**
   * Model the turn was dispatched with ("<providerId>:<slug>"), stamped when
   * the run starts. Thread.modelId is mutable (and lies for orchestrator
   * threads), so per-message attribution needs this frozen copy.
   */
  modelId?: string;
  /** Orion-authored prompt shown when a completed Claude turn is held open only by local shell tasks. */
  claudeBackgroundIntervention?: {
    runId: string;
    tasks: string[];
    status: 'pending' | 'stopping' | 'stopped' | 'settled' | 'error';
    error?: string;
  };
  /** Board-task chips shown on the user message whose turn sent those tasks to the agent. */
  linkedTasks?: Array<Pick<LinkedBoardTask, 'id' | 'title' | 'description'>>;
};

export type QueuedMessage = {
  id: string;
  text: string;
  attachments?: FileAttachment[];
};

/**
 * A `/btw` aside: a quick question answered by a read-only fork of the
 * thread's agent session. It has the thread's full context but never joins
 * the thread — the main session and transcript are untouched.
 */
export type BtwExchange = {
  id: string;
  question: string;
  answer: string;
  status: 'running' | 'done' | 'error';
  createdAt: string;
  completedAt?: string;
  error?: string;
  /** Set when the aside failed because the provider CLI is logged out — renders an Authenticate button. */
  authProviderId?: string;
  /**
   * Id of the transcript message the aside was asked after, so it renders at
   * its chronological spot instead of pinned below the whole transcript.
   * Pre-anchor exchanges (and asides asked on empty threads) fall back to
   * their timestamp when the renderer rebuilds the combined timeline.
   */
  afterMessageId?: string;
  /**
   * Character offset inside a streaming agent-run message at which the aside
   * was asked. Later chunks and tool activity render below the aside even
   * though they belong to the same message.
   */
  contentOffset?: number;
};

/**
 * Codex goal (/goal): a persistent objective the agent pursues autonomously
 * across turns. Owned by codex (~/.codex/goals_1.sqlite, keyed by the
 * thread's codex session id); this is Orion's mirror for the goal chip and
 * /goal status. Updated live from `goal` turn events during goal runs.
 */
export type ThreadGoal = {
  objective: string;
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  updatedAt?: number;
};

/**
 * A provider-native subagent (claude Agent/Task tool, codex collaboration
 * spawn, cursor Task tool, grok spawn_subagent) rendered as a read-only child
 * thread. Streamed live from the subagent's on-disk transcript by main.
 */
export type NativeSubagentInfo = {
  /** Provider-side id (claude task_id, codex thread id, cursor agentId, grok child session id). */
  id: string;
  providerId: ProviderId;
  /** Subagent type/role label (Explore, general-purpose, codex nickname role, …). */
  kind?: string;
  model?: string;
  reasoningEffort?: string;
  prompt?: string;
  /** Final output summary, when the provider reports one. */
  summary?: string;
};

// A kanban card from the Orion web board linked to this thread — a thread can
// carry any number of them. Title and description plus attachment paths are
// snapshotted at link time (refreshed just before injection) and fed to the
// agent on the first turn that carries them.
export type LinkedBoardTaskAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path?: string;
  downloadError?: string;
};

export type LinkedBoardTask = {
  id: string;
  title: string;
  description: string;
  attachments?: LinkedBoardTaskAttachment[];
  /** True once the task context has been injected into an agent turn. */
  injected?: boolean;
  /** Last thread status pushed to the board (running | finished | done | error). */
  lastStatus?: string;
};

export type Thread = {
  id: string;
  projectId: string;
  title: string;
  status: 'idle' | 'running' | 'done' | 'error';
  modelId: string;
  accessMode: 'read-only' | 'workspace-write' | 'full-access';
  codexReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  codexServiceTier?: 'default' | 'priority';
  claudeReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode' | 'ultrathink';
  claudeContextWindow?: '200k' | '1m';
  grokReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  museReasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  openCodeReasoningEffort?: string;
  createdAt: string;
  /** Removed from the sidebar Recent agents list (still listed under its project). */
  hiddenFromRecent?: boolean;
  /** Shown in the sidebar Pinned section (and excluded from Recent agents) while set. */
  pinnedAt?: string;
  /** Set on unpin so the thread surfaces at the top of Recent agents. */
  unpinnedAt?: string;
  /**
   * Set when a run finished while the user was looking at something else, and
   * cleared once the thread is opened. Drives the green sidebar dot.
   */
  finishedUnseenAt?: string;
  /**
   * Sidebar v2: snoozed threads leave the list until their run finishes or
   * they need the user (a question, an approval, a failure), then wake up.
   */
  snoozedAt?: string;
  /** Set when a snoozed thread woke; cleared once it is opened. */
  wokeAt?: string;
  wokeReason?: 'finished' | 'attention';
  /** Sidebar v2: settled (archived) threads leave the list until restored or run again. */
  settledAt?: string;
  /**
   * Set on threads imported from a Claude Code or Codex session the user ran
   * outside Orion. The session id doubles as the dedupe key for re-imports;
   * agentSessionIds carries the same id so the next turn resumes it.
   */
  importedFrom?: { providerId: 'claude' | 'codex'; sessionId: string; importedAt: string };
  /** Imported but not opened yet: the sidebar shows the source provider's icon until then. */
  importedUnseen?: boolean;
  messages: Message[];
  // Per-provider harness session ids so follow-up turns resume the same
  // conversation (claude --resume, codex exec resume, etc.).
  agentSessionIds?: Partial<Record<ProviderId, string>>;
  /**
   * Providers whose session id was inherited by branching and must be forked
   * (never resumed in place) on this thread's next turn, so runs here don't
   * append to the parent thread's CLI-side conversation. Cleared per provider
   * once the fork reports its own session id.
   */
  pendingForkProviders?: ProviderId[];
  /** Thread this one was branched from, if any. */
  branchedFromThreadId?: string;
  /** Driver thread that spawned this one as a subagent, if any. */
  parentThreadId?: string;
  /** Set when this thread is a provider-native subagent's live transcript (read-only). */
  subagent?: NativeSubagentInfo;
  /** Native subagent metadata retained by an editable branch copy. */
  inheritedSubagent?: NativeSubagentInfo;
  /** Latest start, prompt, or exit observed from an embedded terminal. */
  terminalActivityAt?: string;
  /**
   * Pending spawn_subagent call awaiting this thread's result. Persisted so
   * stop/delete/reload can still resolve the driver's blocked tool call;
   * cleared after the first report.
   */
  spawnId?: string;
  /** Follow-ups submitted while a run was in flight; dispatched in order when the run ends. */
  queuedMessages?: QueuedMessage[];
  /** `/btw` asides answered by session forks; rendered alongside the transcript, never part of it. */
  btwExchanges?: BtwExchange[];
  /** Kanban cards on the Orion web board driving/driven by this thread, in link order. */
  linkedTasks?: LinkedBoardTask[];
  /**
   * Set when Durango Chat started this thread (Phase 5 dispatch). The
   * outcome is reported back to the chat once the first run settles.
   */
  durangoDispatch?: {
    id: string;
    sourceUrl: string | null;
    startedAt: string;
    /** Set once the outcome went back to Durango Chat. */
    reportedAt?: string;
  };
  /** Codex goal (/goal) this thread is pursuing, if any. Null after /goal clear. */
  goal?: ThreadGoal | null;
  /**
   * Durango workspace this thread's agents run in, created before its first
   * turn. Branches and subagents share their source thread's workspace, so a
   * resumed or forked session keeps the cwd it was recorded under. `null`
   * means the thread works in its project directory and never gets one.
   */
  durangoWorkspace?: ThreadDurangoWorkspace | null;
  /** Set when the thread's workspace was removed; its next turn creates a new one. */
  durangoWorkspaceRemovedAt?: string;
  /**
   * Orion MCP servers this thread attached with @nickname mentions. They load
   * on every turn here (even when switched off in Settings) until detached.
   */
  mcpServerIds?: string[];
};

export type ThreadDurangoWorkspace = {
  /** `durango-code ws` name, unique per repository. */
  name: string;
  /** Workspace root (a git worktree of `repo`). */
  path: string;
  /** Where the agent runs: the project's directory inside the workspace. */
  workingDir: string;
  /** Base checkout the workspace was created from. */
  repo: string;
  portBase: number;
  portBlock: number;
  createdAt: string;
  /**
   * The agent made this workspace itself during a turn (`durango-code ws new`)
   * instead of the app making it before the first one. The thread's sessions
   * were recorded in the project directory, so its turns keep running there
   * and the agent works in the workspace by path; the app still shows it in
   * the header and cleans it up with the thread.
   */
  adopted?: boolean;
};

export type OpenFile = {
  path: string;
  content: string;
  isDirty: boolean;
  /** Changes whenever a clean tab is refreshed from disk, including binary previews. */
  diskRevision?: number;
};

export type ProviderId = 'grok' | 'codex' | 'claude' | 'cursor' | 'kimi' | 'muse' | 'opencode';

export type CodexSettingMode = 'inherit' | 'enabled' | 'disabled';
export type BrowserUseMode = 'disabled' | 'extension' | 'mcp';

// Per-provider harness capabilities, passed through to the CLI invocation.
export type ProviderRuntimeOptions = {
  /** claude: extra tools auto-approved outside Full Access (--allowedTools) */
  allowedTools?: string;
  /** codex: allow network inside the workspace-write sandbox */
  networkAccess?: boolean;
  /** codex: enable the web search tool */
  webSearch?: boolean;
  /** codex: automatic enables notes/searchable history for Astra only */
  codexContextManagementMode?: 'inherit' | 'enabled' | 'disabled' | 'codex';
  /** codex: inherit, enable, or disable local memory use and generation */
  codexMemoryMode?: CodexSettingMode;
  /** codex: inherit, enable, or disable Chronicle integration */
  codexChronicleMode?: CodexSettingMode;
  /** codex: allow or exclude MCP/web/tool-search chats from memory generation */
  codexMemoryExternalContextMode?: CodexSettingMode;
  /** codex: per-Orion personality override */
  codexPersonality?: 'inherit' | 'none' | 'friendly' | 'pragmatic';
  /** codex: additional developer instructions for Orion-launched sessions */
  codexDeveloperInstructions?: string;
  /** grok: enable cross-session memory (--experimental-memory) */
  experimentalMemory?: boolean;
  /** claude: browser control via the Claude Chrome extension (--chrome) */
  chrome?: boolean;
  /** legacy codex browser toggle, retained for migration */
  browserControl?: boolean;
  /** legacy codex opt-in to attach MCP browser control to signed-in Chrome */
  browserAutoConnect?: boolean;
  /** codex: disabled, signed-in Chrome extension, or signed-in Chrome through chrome-devtools MCP */
  browserUseMode?: BrowserUseMode;
  /** any provider: extra CLI flags appended to every run */
  extraArgs?: string;
};

export type ProviderSettings = Record<
  ProviderId,
  { enabled: boolean; options?: ProviderRuntimeOptions }
>;

export const defaultProviderSettings: ProviderSettings = {
  grok: { enabled: true },
  codex: { enabled: true },
  claude: { enabled: true },
  cursor: { enabled: true },
  kimi: { enabled: true },
  muse: { enabled: true },
  opencode: { enabled: true },
};

// Roles the Orion orchestrator pseudo-model delegates to. Each maps to an
// AgentModel id picked in Settings → Orchestration.
export type OrchestrationRoleId =
  | 'mainDriver'
  | 'computerUse'
  | 'exploring'
  | 'implementation'
  | 'imageVideoGen';

export type OrchestrationSettings = {
  /** AgentModel id per role, e.g. 'claude:claude-fable-5'. */
  models: Record<OrchestrationRoleId, string>;
  /** Standing instructions injected into every agent run started from Orion. */
  generalInstructions: string;
};

export const defaultOrchestrationSettings: OrchestrationSettings = {
  models: {
    mainDriver: 'claude:claude-fable-5-1',
    computerUse: 'codex:gpt-6.1-sol',
    exploring: 'claude:claude-haiku-5-5',
    implementation: 'codex:gpt-6.1-sol',
    imageVideoGen: 'grok:grok-4.7',
  },
  generalInstructions: '',
};

export type NotificationSettings = {
  /** Notify when a thread finishes while the user isn't looking at it. */
  enabled: boolean;
  /** Play the system notification sound. */
  sound: boolean;
};

export const defaultNotificationSettings: NotificationSettings = {
  enabled: true,
  sound: true,
};

/** Hard ceiling on the split view: past six the panes are too small to read. */
export const MAX_THREAD_PANES = 6;

/**
 * A split the user can get back to from the sidebar. It holds thread ids only —
 * nothing about a thread is copied, so opening a saved view is navigation, and
 * deleting one never touches a transcript.
 */
export type SavedView = {
  id: string;
  /** Derived from the pane titles; refreshed whenever the split changes. */
  name: string;
  /** Panes in display order. Always at least two: one pane isn't a split. */
  threadIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type SplitViewSettings = {
  /**
   * Record every split into the sidebar's Saved views section as it is formed.
   * Off means splits are never written down: closing one loses it, which is the
   * point — some users don't want a growing list of views they didn't ask for.
   */
  autoSave: boolean;
};

export const defaultSplitViewSettings: SplitViewSettings = {
  autoSave: true,
};

export const isAgentsPanelVisible = (state: {
  activeTab: 'agents' | 'code';
  settingsOpen: boolean;
}) => state.activeTab === 'agents' && !state.settingsOpen;

interface OrionState {
  // Tabs
  activeTab: 'agents' | 'code';
  /** Settings replaces the main content, so panes remain mounted in state but are not visible. */
  settingsOpen: boolean;

  // Projects & Threads
  projects: Project[];
  /** The No project pseudo-project, once its scratch directory is known. */
  noProject: Project | null;
  threads: Thread[];
  selectedProjectId: string | null;
  selectedThreadId: string | null;
  /**
   * Threads currently shown in the main view, left-to-right / top-to-bottom.
   * The split view renders one pane per entry and `selectedThreadId` is the
   * focused one — it is always a member of this list, or null when it's empty.
   */
  paneThreadIds: string[];

  // Saved views (splits the user can return to)
  savedViews: SavedView[];
  /**
   * The saved view the on-screen split is currently mirroring, if any. Set by
   * forming or opening a split while auto-save is on; cleared by navigating
   * away, so a view stops following panes the user has moved on from.
   */
  activeSavedViewId: string | null;
  splitViewSettings: SplitViewSettings;

  durangoWorkspaceSettings: DurangoWorkspaceSettings;
  workspaceSyncSettings: WorkspaceSyncSettings;
  durangoSettings: DurangoSettings;
  remoteControlSettings: RemoteControlSettings;
  deploymentSettings: DeploymentSettings;
  sidebarV2Settings: SidebarV2Settings;
  appearanceSettings: AppearanceSettings;

  // Code tab workspace
  workspacePath: string | null;
  openFiles: OpenFile[];
  activeFilePath: string | null;

  // UI
  expandedProjects: string[];
  providerSettings: ProviderSettings;
  orchestrationSettings: OrchestrationSettings;
  notificationSettings: NotificationSettings;
  textGenerationSettings: TextGenerationSettings;

  // Actions
  setActiveTab: (tab: 'agents' | 'code') => void;
  setSettingsOpen: (open: boolean) => void;
  setProviderEnabled: (id: ProviderId, enabled: boolean) => void;
  setProviderOptions: (id: ProviderId, options: Partial<ProviderRuntimeOptions>) => void;
  setOrchestrationRoleModel: (role: OrchestrationRoleId, modelId: string) => void;
  setOrchestrationGeneralInstructions: (text: string) => void;
  setNotificationSettings: (updates: Partial<NotificationSettings>) => void;
  setTextGenerationSettings: (updates: Partial<TextGenerationSettings>) => void;
  setThreadAgentSession: (threadId: string, providerId: ProviderId, sessionId: string) => void;

  addProject: (project: Omit<Project, 'id'>) => string; // returns new project id
  setNoProjectPath: (path: string) => void;
  /** Adds imported threads (and the projects created for them) without changing selection. */
  importThreads: (input: { projects: Project[]; threads: Thread[] }) => void;
  removeProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;

  setDurangoWorkspaceSettings: (updates: Partial<DurangoWorkspaceSettings>) => void;
  setWorkspaceSyncSettings: (updates: Partial<WorkspaceSyncSettings>) => void;
  setDurangoSettings: (updates: Partial<DurangoSettings>) => void;
  setRemoteControlSettings: (updates: Partial<RemoteControlSettings>) => void;
  setDeploymentSettings: (updates: Partial<DeploymentSettings>) => void;
  setSidebarV2Settings: (updates: Partial<SidebarV2Settings>) => void;
  setAppearanceSettings: (updates: Partial<AppearanceSettings>) => void;

  createThread: (
    projectId: string,
    title?: string,
    options?: {
      parentThreadId?: string;
      modelId?: string;
      hiddenFromRecent?: boolean;
      spawnId?: string;
      accessMode?: Thread['accessMode'];
      subagent?: NativeSubagentInfo;
      /** Durango workspace to work in; defaults to the parent thread's. `null` opts out. */
      durangoWorkspace?: ThreadDurangoWorkspace | null;
      /** false = don't switch the UI to the new thread (background spawns). */
      select?: boolean;
    }
  ) => string; // returns new thread id
  branchThread: (sourceThreadId: string) => string | null; // returns new thread id
  selectProject: (id: string | null) => void;
  selectThread: (id: string | null) => void;
  /** Add a thread as an extra pane beside the ones already open, and focus it. */
  openThreadInSplit: (id: string) => void;
  /** Remove a pane from the split; the thread itself is untouched. */
  closeThreadPane: (id: string) => void;
  /** Restore a saved split into the main view. Copies nothing. */
  openSavedView: (id: string) => void;
  /** Forget a saved view. Its threads are untouched. */
  deleteSavedView: (id: string) => void;
  setSplitViewSettings: (updates: Partial<SplitViewSettings>) => void;
  updateThread: (id: string, updates: Partial<Thread>) => void;
  deleteThread: (id: string) => void;
  addMessageToThread: (threadId: string, message: Omit<Message, 'id' | 'ts'>) => string;
  appendToThreadMessage: (threadId: string, messageId: string, chunk: string) => void;
  updateThreadMessage: (
    threadId: string,
    messageId: string,
    updates: Partial<Omit<Message, 'id'>>
  ) => void;
  addActivityToThreadMessage: (
    threadId: string,
    messageId: string,
    activity: Omit<AgentActivity, 'id' | 'ts'>
  ) => void;
  /**
   * A run that ended successfully has finished whatever task it was on, even
   * when the agent skipped the final checklist update — flip lingering
   * in-progress plan entries to completed so the widget can't spin forever.
   */
  completeInProgressPlanEntries: (threadId: string, messageId: string) => void;
  queueMessageToThread: (threadId: string, message: Omit<QueuedMessage, 'id'>) => string;
  removeQueuedThreadMessage: (threadId: string, messageId: string) => void;
  addBtwExchange: (threadId: string, question: string) => string;
  appendToBtwExchange: (threadId: string, exchangeId: string, chunk: string) => void;
  updateBtwExchange: (
    threadId: string,
    exchangeId: string,
    updates: Partial<Omit<BtwExchange, 'id'>>
  ) => void;
  removeBtwExchange: (threadId: string, exchangeId: string) => void;

  toggleProjectExpanded: (id: string) => void;

  setWorkspacePath: (path: string | null) => void;

  openFile: (path: string, content: string) => void;
  closeFile: (path: string) => void;
  setActiveFile: (path: string) => void;
  updateOpenFileContent: (path: string, content: string) => void;
  markFileSaved: (path: string, content?: string) => void;
  refreshOpenFileFromDisk: (path: string, content?: string) => void;
  closeAllFiles: () => void;
}

const memoryStorage = new Map<string, string>();

// Streaming agent runs update the store many times per second, and zustand's
// persist middleware serializes the whole store on every update. Debounce the
// IPC/file write so tokens don't each trigger a full-store disk write; the
// in-memory copy is always current.
const STORE_SAVE_DEBOUNCE_MS = 400;
let pendingStoreValue: string | null = null;
let storeSaveTimer: ReturnType<typeof setTimeout> | null = null;
let storeSaveFlush: Promise<boolean> | null = null;

export const flushOrionStoreSave = async (): Promise<boolean> => {
  if (storeSaveTimer !== null) {
    clearTimeout(storeSaveTimer);
    storeSaveTimer = null;
  }
  if (storeSaveFlush !== null) return storeSaveFlush;

  const flush = (async () => {
    while (pendingStoreValue !== null) {
      if (typeof window === 'undefined' || !window.orion?.saveStore) return false;

      const value = pendingStoreValue;
      let saved = false;
      try {
        saved = await window.orion.saveStore(value);
      } catch (error) {
        console.warn('Failed to persist orion-storage', error);
        return false;
      }
      if (!saved) {
        console.warn('Failed to persist orion-storage');
        return false;
      }

      // A newer snapshot may have arrived while this one was being written.
      // Only clear the value that was actually persisted; the loop will drain
      // a replacement before reporting success.
      if (pendingStoreValue === value) pendingStoreValue = null;
    }
    return true;
  })();

  storeSaveFlush = flush;
  try {
    return await flush;
  } finally {
    if (storeSaveFlush === flush) storeSaveFlush = null;
  }
};

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    void flushOrionStoreSave();
  });
}

// Threads (full transcripts) are excluded from the persisted store above and
// live in sharded storage on a slower save cadence — see the saver below the
// store definition. State shared with it:
let threadsSaveTimer: ReturnType<typeof setTimeout> | null = null;
let threadsSaveFlush: Promise<boolean> | null = null;
type ThreadsPatch = { version: 2; upserts: Thread[]; deletes: string[]; order: string[] };
const pendingThreadUpserts = new Map<string, Thread>();
const pendingThreadDeletes = new Set<string>();
let pendingThreadOrder = false;
let threadsInFlightPatch: ThreadsPatch | null = null;
let loadedThreadsFromStorage = false;
// The threads reference at clearStorage time: zustand clears storage without
// clearing in-memory state, so the savers must not write this exact snapshot
// back to disk. A later thread change (fresh reference) resumes persistence.
let clearedThreadsSnapshot: Thread[] | null = null;
// Set when the threads file exists but could not be read or parsed: the
// hydrated state then lacks the real transcripts, and any flush would
// overwrite the (possibly recoverable) file with that lesser snapshot. All
// thread persistence stays suppressed until an explicit clearStorage.
let threadsPersistenceBlocked = false;

const cancelQueuedThreadsSave = () => {
  if (threadsSaveTimer !== null) {
    clearTimeout(threadsSaveTimer);
    threadsSaveTimer = null;
  }
};

type PersistedThreadsPage = {
  version: 2;
  present: boolean;
  stale: boolean;
  revision: number;
  offset: number;
  total: number;
  threads: Thread[];
  nextOffset: number | null;
};

const THREADS_PAGE_BYTES = 4 * 1024 * 1024;
const THREADS_HYDRATION_ATTEMPTS = 3;

// Graft the separately-persisted threads back into the persisted state so the
// persist middleware — including its crash-recovery merge — sees one combined
// snapshot. Pages keep the main-process IPC allocation bounded; the manifest
// revision prevents a concurrent save from producing a mixed snapshot. With
// no threads file yet (pre-split builds), the store value's own embedded
// threads are used as-is and the first threads save migrates them out.
const withThreadsGrafted = async (value: string | null): Promise<string | null> => {
  if (!window.orion.loadThreadsPage) return value;
  let storedThreads: Thread[] | null = null;
  try {
    for (let attempt = 0; attempt < THREADS_HYDRATION_ATTEMPTS; attempt += 1) {
      const threads: Thread[] = [];
      let offset = 0;
      let revision: number | undefined;
      let total: number | undefined;
      let retry = false;

      while (true) {
        const result = await window.orion.loadThreadsPage({
          offset,
          revision,
          maxBytes: THREADS_PAGE_BYTES,
        });
        if (!result?.ok || typeof result.value !== 'string') throw new Error('Thread page read failed.');
        const page = JSON.parse(result.value) as PersistedThreadsPage;
        if (
          page?.version !== 2 ||
          typeof page.present !== 'boolean' ||
          typeof page.stale !== 'boolean' ||
          !Number.isInteger(page.revision) ||
          !Number.isInteger(page.offset) ||
          !Number.isInteger(page.total) ||
          !Array.isArray(page.threads) ||
          (page.nextOffset !== null && !Number.isInteger(page.nextOffset))
        ) {
          throw new Error('Invalid thread page response.');
        }
        if (page.stale) {
          retry = true;
          break;
        }
        if (!page.present) {
          if (offset !== 0 || page.threads.length !== 0 || page.nextOffset !== null) {
            throw new Error('Invalid absent thread page response.');
          }
          return value;
        }
        if (
          page.offset !== offset ||
          page.revision < 0 ||
          page.total < 0 ||
          (revision !== undefined && page.revision !== revision) ||
          (total !== undefined && page.total !== total)
        ) {
          throw new Error('Inconsistent thread page response.');
        }
        revision = page.revision;
        total = page.total;
        threads.push(...page.threads);

        if (page.nextOffset === null) {
          if (threads.length !== total) throw new Error('Incomplete thread page response.');
          storedThreads = threads;
          break;
        }
        if (
          page.nextOffset <= offset ||
          page.nextOffset > total ||
          page.nextOffset - offset !== page.threads.length
        ) {
          throw new Error('Invalid next thread page offset.');
        }
        offset = page.nextOffset;
      }

      if (storedThreads !== null) break;
      if (!retry) throw new Error('Thread hydration did not complete.');
    }
    if (storedThreads === null) throw new Error('Thread storage changed repeatedly during hydration.');
    loadedThreadsFromStorage = true;
    // A lost/corrupt store file must not take the transcripts with it.
    let parsed: { state: Record<string, unknown>; version?: number };
    try {
      const candidate = value === null ? null : JSON.parse(value);
      parsed =
        candidate &&
        typeof candidate === 'object' &&
        !Array.isArray(candidate) &&
        candidate.state &&
        typeof candidate.state === 'object' &&
        !Array.isArray(candidate.state)
          ? candidate
          : { state: {}, version: 1 };
    } catch {
      // The settings envelope is expendable; the separately persisted
      // transcripts are not. Rebuild a minimal envelope rather than returning
      // the malformed value and letting hydration flush an empty thread list
      // over the valid threads file.
      parsed = { state: {}, version: 1 };
    }
    parsed.state = { ...parsed.state, threads: storedThreads };
    return JSON.stringify(parsed);
  } catch (error) {
    console.error('Failed to hydrate Orion threads', error);
    // Hydrating without the real transcript snapshot is survivable, but
    // persisting over it is not.
    threadsPersistenceBlocked = true;
    return value;
  }
};

const orionStorage: StateStorage = {
  getItem: async (name) => {
    if (typeof window === 'undefined' || !window.orion?.loadStore) {
      return memoryStorage.get(name) ?? null;
    }

    const value = await withThreadsGrafted(await window.orion.loadStore());
    if (value !== null) {
      memoryStorage.set(name, value);
      return value;
    }

    const legacyValue = window.localStorage.getItem(name);
    if (legacyValue !== null) {
      memoryStorage.set(name, legacyValue);
      await window.orion.saveStore(legacyValue);
      return legacyValue;
    }

    return null;
  },
  setItem: async (name, value) => {
    memoryStorage.set(name, value);
    pendingStoreValue = value;

    if (typeof window === 'undefined' || !window.orion?.saveStore) {
      return;
    }

    if (storeSaveTimer === null) {
      storeSaveTimer = setTimeout(() => {
        storeSaveTimer = null;
        void flushOrionStoreSave();
      }, STORE_SAVE_DEBOUNCE_MS);
    }
  },
  removeItem: async (name) => {
    memoryStorage.delete(name);
    pendingStoreValue = null;
    if (storeSaveTimer !== null) {
      clearTimeout(storeSaveTimer);
      storeSaveTimer = null;
    }
    // A queued or future threads write after the clear would resurrect the
    // cleared transcripts (zustand leaves them in memory): drop the queued
    // timer and mark the current snapshot as not-to-be-rewritten, which the
    // throttled saver and the unload flush both honor.
    cancelQueuedThreadsSave();
    clearedThreadsSnapshot = useOrionStore.getState().threads;
    pendingThreadUpserts.clear();
    pendingThreadDeletes.clear();
    pendingThreadOrder = false;
    // An explicit clear discards whatever unreadable file blocked
    // persistence — new activity may persist fresh snapshots again.
    threadsPersistenceBlocked = false;

    if (typeof window === 'undefined' || !window.orion?.clearStore) {
      return;
    }

    const cleared = await window.orion.clearStore();
    if (!cleared) {
      console.warn(`Failed to clear ${name}`);
    }
  },
};

// Threads and their user messages used to hold at most one board task in a
// `linkedTask` field; both now hold a `linkedTasks` list. Rewrite the legacy
// shape on hydration so old transcripts keep their chips and their board link.
type LegacyLinkedTaskMessage = Message & {
  linkedTask?: Pick<LinkedBoardTask, 'id' | 'title' | 'description'>;
};
type LegacyLinkedTaskThread = Omit<Thread, 'messages'> & {
  linkedTask?: LinkedBoardTask;
  messages: LegacyLinkedTaskMessage[];
};

const migrateLegacyLinkedTask = (thread: Thread): Thread => {
  const legacy = thread as LegacyLinkedTaskThread;
  const migratesThread = Boolean(legacy.linkedTask) && !legacy.linkedTasks;
  const migratesMessages = legacy.messages.some(
    (message) => message.linkedTask && !message.linkedTasks
  );
  if (!migratesThread && !migratesMessages) return thread;
  const migrated: LegacyLinkedTaskThread = {
    ...legacy,
    ...(migratesThread ? { linkedTasks: [legacy.linkedTask!] } : {}),
    ...(migratesMessages
      ? {
          messages: legacy.messages.map((message) => {
            if (!message.linkedTask || message.linkedTasks) return message;
            const { linkedTask, ...rest } = message;
            return { ...rest, linkedTasks: [linkedTask] };
          }),
        }
      : {}),
  };
  delete migrated.linkedTask;
  return migrated;
};

// Opening a thread already on screen just moves focus to its pane. Opening any
// other thread leaves the split behind and shows that thread alone: clicking a
// thread means "show me this thread", and a split the user can neither grow by
// browsing nor step out of would be a trap. The split isn't lost — its Saved
// views entry puts it back in one click. Extra panes only arrive by drag
// (openThreadInSplit).
const panesForSelection = (
  state: Pick<OrionState, 'selectedThreadId' | 'paneThreadIds'>,
  id: string | null
): { selectedThreadId: string | null; paneThreadIds: string[] } => {
  if (!id) return { selectedThreadId: null, paneThreadIds: [] };
  if (state.paneThreadIds.includes(id)) {
    return { selectedThreadId: id, paneThreadIds: state.paneThreadIds };
  }
  return { selectedThreadId: id, paneThreadIds: [id] };
};

// Dropping a thread out of the split (closed, deleted, its project removed)
// hands focus to the pane that slid into its place, so the main view is never
// left blank while other panes are still open.
const panesAfterRemoval = (
  state: Pick<OrionState, 'selectedThreadId' | 'paneThreadIds'>,
  removed: (id: string) => boolean
): { selectedThreadId: string | null; paneThreadIds: string[] } => {
  const paneThreadIds = state.paneThreadIds.filter((id) => !removed(id));
  if (state.selectedThreadId && paneThreadIds.includes(state.selectedThreadId)) {
    return { selectedThreadId: state.selectedThreadId, paneThreadIds };
  }
  const previousIndex = state.selectedThreadId
    ? state.paneThreadIds.indexOf(state.selectedThreadId)
    : 0;
  const fallback = paneThreadIds[Math.min(Math.max(previousIndex, 0), paneThreadIds.length - 1)];
  return { selectedThreadId: fallback ?? null, paneThreadIds };
};

// A saved view is labelled by what's in it, so the sidebar reads as the panes
// do rather than as "Split view 3".
const savedViewName = (threads: Thread[], threadIds: string[]): string => {
  const titles = threadIds.map(
    (id) => threads.find((thread) => thread.id === id)?.title ?? 'Untitled'
  );
  if (titles.length <= 2) return titles.join(' + ');
  return `${titles[0]} +${titles.length - 1}`;
};

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

type PaneSelection = { selectedThreadId: string | null; paneThreadIds: string[] };
type PaneUpdate = PaneSelection & Partial<Pick<OrionState, 'savedViews' | 'activeSavedViewId'>>;

/**
 * Mirror the on-screen split into its sidebar entry.
 *
 * `ejectOnCollapse` marks a change the user made by closing panes: falling back
 * to a single thread then throws the entry away, because a "view" that restores
 * one pane is just that thread. Every other route to one pane — opening a
 * thread elsewhere — only stops tracking, so the saved view
 * survives to be reopened.
 */
const syncSavedView = (
  state: OrionState,
  panes: PaneSelection,
  options?: {
    ejectOnCollapse?: boolean;
    /** Save an already-open split, such as when auto-save is enabled. */
    createIfUntracked?: boolean;
    /** Thread list to name panes from, when the caller is adding one. */
    threads?: Thread[];
  }
): PaneUpdate => {
  const tracked = state.activeSavedViewId
    ? state.savedViews.find((view) => view.id === state.activeSavedViewId)
    : undefined;

  if (panes.paneThreadIds.length < 2) {
    if (!tracked) return panes;
    return {
      ...panes,
      activeSavedViewId: null,
      savedViews: options?.ejectOnCollapse
        ? state.savedViews.filter((view) => view.id !== tracked.id)
        : state.savedViews,
    };
  }

  if (!state.splitViewSettings.autoSave) return panes;
  // An untracked split that did not change is intentionally left alone. This
  // is how deleting the active saved view remains a deletion even though its
  // panes stay on screen; growing or otherwise changing the split saves it
  // again as a new view.
  if (
    !tracked &&
    !options?.createIfUntracked &&
    sameIds(state.paneThreadIds, panes.paneThreadIds)
  ) {
    return panes;
  }
  const now = new Date().toISOString();
  const threads = options?.threads ?? state.threads;
  const threadIds = panes.paneThreadIds;

  // The same set of panes must never occupy two sidebar rows, so a split that
  // already has an entry adopts it instead of adding a second one.
  const duplicate = state.savedViews.find(
    (view) => view.id !== tracked?.id && sameIds(view.threadIds, threadIds)
  );

  if (tracked) {
    if (sameIds(tracked.threadIds, threadIds)) {
      const name = savedViewName(threads, threadIds);
      if (tracked.name === name) return panes;
      return {
        ...panes,
        savedViews: state.savedViews.map((view) =>
          view.id === tracked.id ? { ...view, name, updatedAt: now } : view
        ),
      };
    }
    if (duplicate) {
      // The split has become one that's already saved; the entry it was
      // tracking would otherwise linger as a stale copy of this one.
      return {
        ...panes,
        savedViews: state.savedViews.filter((view) => view.id !== tracked.id),
        activeSavedViewId: duplicate.id,
      };
    }
    return {
      ...panes,
      savedViews: state.savedViews.map((view) =>
        view.id === tracked.id
          ? { ...view, threadIds, name: savedViewName(threads, threadIds), updatedAt: now }
          : view
      ),
    };
  }

  if (duplicate) return { ...panes, activeSavedViewId: duplicate.id };

  const created: SavedView = {
    id: crypto.randomUUID(),
    name: savedViewName(threads, threadIds),
    threadIds,
    createdAt: now,
    updatedAt: now,
  };
  return {
    ...panes,
    savedViews: [created, ...state.savedViews],
    activeSavedViewId: created.id,
  };
};

// Threads that no longer exist drop out of every saved view, and a view left
// with fewer than two of them stops being a split and goes with them.
const pruneSavedViews = (savedViews: SavedView[], threads: Thread[]) => {
  const liveThreadIds = new Set(threads.map((thread) => thread.id));
  return savedViews.flatMap((view) => {
    const threadIds = view.threadIds.filter((id) => liveThreadIds.has(id));
    if (threadIds.length < 2) return [];
    const name = savedViewName(threads, threadIds);
    return [
      sameIds(threadIds, view.threadIds) && name === view.name
        ? view
        : { ...view, threadIds, name },
    ];
  });
};

// Every thread visible in an opened pane clears its "finished while you were
// away" mark, including background panes in a saved/restored split.
const threadsWithOpenedSeen = (state: OrionState, ids: string | string[]) => {
  const openedIds = new Set(Array.isArray(ids) ? ids : [ids]);
  const isUnseen = (thread: Thread) =>
    Boolean(thread.finishedUnseenAt || thread.importedUnseen || thread.wokeAt || thread.wokeReason);
  if (!state.threads.some((thread) => openedIds.has(thread.id) && isUnseen(thread))) {
    return state.threads;
  }
  return state.threads.map((thread) =>
    openedIds.has(thread.id) && isUnseen(thread)
      ? { ...thread, finishedUnseenAt: undefined, importedUnseen: undefined, wokeAt: undefined, wokeReason: undefined }
      : thread
  );
};

export const useOrionStore = create<OrionState>()(
  persist(
    (set, get) => ({
      activeTab: 'agents',
      settingsOpen: false,
      projects: [],
      noProject: null,
      threads: [],
      selectedProjectId: null,
      selectedThreadId: null,
      paneThreadIds: [],
      savedViews: [],
      activeSavedViewId: null,
      splitViewSettings: defaultSplitViewSettings,
      durangoWorkspaceSettings: defaultDurangoWorkspaceSettings,
      workspaceSyncSettings: defaultWorkspaceSyncSettings,
      durangoSettings: defaultDurangoSettings,
      remoteControlSettings: defaultRemoteControlSettings,
      deploymentSettings: defaultDeploymentSettings,
      sidebarV2Settings: defaultSidebarV2Settings,
      appearanceSettings: defaultAppearanceSettings,
      workspacePath: null,
      openFiles: [],
      activeFilePath: null,
      expandedProjects: [],
      providerSettings: defaultProviderSettings,
      orchestrationSettings: defaultOrchestrationSettings,
      notificationSettings: defaultNotificationSettings,
      textGenerationSettings: defaultTextGenerationSettings,

      setActiveTab: (tab) =>
        set((state) => {
          return {
            activeTab: tab,
            // Returning from Code reveals every pane without selecting its row
            // again, so each visible transcript counts as opened.
            threads:
              tab === 'agents' && !state.settingsOpen
                ? threadsWithOpenedSeen(state, state.paneThreadIds)
                : state.threads,
          };
        }),
      setSettingsOpen: (open) =>
        set((state) => ({
          settingsOpen: open,
          // Leaving Settings reveals the panes again. Any completion markers
          // collected while it covered the agents panel have now been seen.
          threads:
            !open && state.activeTab === 'agents'
              ? threadsWithOpenedSeen(state, state.paneThreadIds)
              : state.threads,
        })),
      setProviderEnabled: (id, enabled) =>
        set((state) => ({
          providerSettings: {
            ...defaultProviderSettings,
            ...state.providerSettings,
            [id]: { ...state.providerSettings[id], enabled },
          },
        })),
      setProviderOptions: (id, options) =>
        set((state) => {
          const current = state.providerSettings[id] ?? defaultProviderSettings[id];
          return {
            providerSettings: {
              ...defaultProviderSettings,
              ...state.providerSettings,
              [id]: {
                ...current,
                options: { ...current.options, ...options },
              },
            },
          };
        }),
      setOrchestrationRoleModel: (role, modelId) =>
        set((state) => ({
          orchestrationSettings: {
            ...defaultOrchestrationSettings,
            ...state.orchestrationSettings,
            models: {
              ...defaultOrchestrationSettings.models,
              ...state.orchestrationSettings?.models,
              [role]: modelId,
            },
          },
        })),
      setOrchestrationGeneralInstructions: (text) =>
        set((state) => ({
          orchestrationSettings: {
            ...defaultOrchestrationSettings,
            ...state.orchestrationSettings,
            models: {
              ...defaultOrchestrationSettings.models,
              ...state.orchestrationSettings?.models,
            },
            generalInstructions: text,
          },
        })),
      setNotificationSettings: (updates) =>
        set((state) => ({
          notificationSettings: {
            ...defaultNotificationSettings,
            ...state.notificationSettings,
            ...updates,
          },
        })),
      setTextGenerationSettings: (updates) =>
        set((state) => ({
          textGenerationSettings: {
            ...defaultTextGenerationSettings,
            ...state.textGenerationSettings,
            ...updates,
          },
        })),
      setThreadAgentSession: (threadId, providerId, sessionId) =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  agentSessionIds: { ...thread.agentSessionIds, [providerId]: sessionId },
                  // A branched thread's first turn forks the inherited session
                  // and reports the fork's id; from here on resume in place.
                  pendingForkProviders: thread.pendingForkProviders?.filter(
                    (p) => p !== providerId
                  ),
                }
              : thread
          ),
        })),

      addProject: (project) => {
        const newProject: Project = {
          ...project,
          id: crypto.randomUUID(),
        };
        // Newest project first — adding a project means the user wants to
        // work in it now, so it should lead the sidebar.
        set((state) => ({
          projects: [newProject, ...state.projects],
          expandedProjects: [...state.expandedProjects, newProject.id],
          selectedProjectId: newProject.id,
        }));
        // Auto-set as workspace if none
        if (!get().workspacePath) {
          set({ workspacePath: newProject.path });
        }
        return newProject.id;
      },

      setNoProjectPath: (path) =>
        set((state) =>
          state.noProject?.path === path
            ? {}
            : { noProject: { id: NO_PROJECT_ID, name: NO_PROJECT_NAME, path } }
        ),

      importThreads: ({ projects, threads }) => {
        if (projects.length === 0 && threads.length === 0) return;
        set((state) => {
          const knownProjectIds = new Set(state.projects.map((project) => project.id));
          const newProjects = projects.filter((project) => !knownProjectIds.has(project.id));
          const knownThreadIds = new Set(state.threads.map((thread) => thread.id));
          const newThreads = threads.filter((thread) => !knownThreadIds.has(thread.id));
          return {
            // The sidebar orders projects and threads by activity, so imported
            // history lands in its chronological place wherever it's appended.
            projects: [...state.projects, ...newProjects],
            threads: [...state.threads, ...newThreads],
          };
        });
      },
      removeProject: (id) => {
        set((state) => {
          const removedProject = state.projects.find((p) => p.id === id);
          const remainingProjects = state.projects.filter((p) => p.id !== id);
          const fallbackProject = remainingProjects[0] ?? null;
          const wasWorkspaceProject = removedProject?.path === state.workspacePath;
          // Saved views lose the threads that went with the project.
          const threads = state.threads.filter((thread) => thread.projectId !== id);
          const savedViews = pruneSavedViews(state.savedViews, threads);
          const panes = panesAfterRemoval(
            state,
            (paneId) => state.threads.find((thread) => thread.id === paneId)?.projectId === id
          );
          const focusedPaneThread = panes.selectedThreadId
            ? threads.find((thread) => thread.id === panes.selectedThreadId)
            : undefined;

          return {
            projects: remainingProjects,
            threads,
            selectedProjectId:
              focusedPaneThread?.projectId ??
              (state.selectedProjectId === id ? fallbackProject?.id ?? null : state.selectedProjectId),
            // Panes showing threads from the removed project close; any others
            // stay open.
            ...panes,
            savedViews,
            activeSavedViewId: savedViews.some((view) => view.id === state.activeSavedViewId)
              ? state.activeSavedViewId
              : null,
            expandedProjects: state.expandedProjects.filter((pid) => pid !== id),
            workspacePath: wasWorkspaceProject ? fallbackProject?.path ?? null : state.workspacePath,
            openFiles: wasWorkspaceProject ? [] : state.openFiles,
            activeFilePath: wasWorkspaceProject ? null : state.activeFilePath,
          };
        });
      },

      renameProject: (id, name) =>
        set((state) => ({
          projects: state.projects.map((p) => (p.id === id ? { ...p, name } : p)),
        })),

      setSplitViewSettings: (updates) =>
        set((state) => {
          const splitViewSettings = {
            ...defaultSplitViewSettings,
            ...state.splitViewSettings,
            ...updates,
          };
          // Turning auto-save off stops the open split writing to the entry it
          // came from. Views already saved stay until the user trashes them.
          if (!splitViewSettings.autoSave) return { splitViewSettings, activeSavedViewId: null };
          // Turning it on records the split already on screen, so the setting
          // applies to what the user is looking at rather than to the next
          // split they happen to touch.
          return {
            splitViewSettings,
            ...syncSavedView(
              { ...state, splitViewSettings },
              { selectedThreadId: state.selectedThreadId, paneThreadIds: state.paneThreadIds },
              { createIfUntracked: true }
            ),
          };
        }),

      setDurangoWorkspaceSettings: (updates) =>
        set((state) => ({
          durangoWorkspaceSettings: {
            ...defaultDurangoWorkspaceSettings,
            ...state.durangoWorkspaceSettings,
            ...updates,
          },
        })),

      setWorkspaceSyncSettings: (updates) =>
        set((state) => ({
          workspaceSyncSettings: {
            ...defaultWorkspaceSyncSettings,
            ...state.workspaceSyncSettings,
            ...updates,
          },
        })),

      setDurangoSettings: (updates) =>
        set((state) => ({
          durangoSettings: {
            ...defaultDurangoSettings,
            ...state.durangoSettings,
            ...updates,
          },
        })),

      setRemoteControlSettings: (updates) =>
        set((state) => ({
          remoteControlSettings: {
            ...defaultRemoteControlSettings,
            ...state.remoteControlSettings,
            ...updates,
          },
        })),

      setDeploymentSettings: (updates) =>
        set((state) => ({
          deploymentSettings: {
            ...defaultDeploymentSettings,
            ...state.deploymentSettings,
            ...updates,
          },
        })),

      setAppearanceSettings: (updates) =>
        set((state) => ({
          appearanceSettings: { ...defaultAppearanceSettings, ...state.appearanceSettings, ...updates },
        })),

      setSidebarV2Settings: (updates) =>
        set((state) => {
          const sidebarV2Settings: SidebarV2Settings = {
            ...defaultSidebarV2Settings,
            ...state.sidebarV2Settings,
            ...updates,
            views: {
              ...defaultSidebarV2Settings.views,
              ...state.sidebarV2Settings?.views,
              ...updates.views,
            },
          };
          if (!sidebarV2Settings.enabled || sidebarV2Settings.settledExistingAt) return { sidebarV2Settings };
          const at = new Date().toISOString();
          return {
            sidebarV2Settings: { ...sidebarV2Settings, settledExistingAt: at },
            threads: settleThreadsForSidebarV2(state.threads, at),
          };
        }),

      createThread: (projectId, title, options) => {
        // Inherit model + settings from the most recently used thread in the
        // same project so new top-level threads default to what the user last
        // picked. Hidden/background subagents must not become that default;
        // child threads inherit from their explicit parent instead.
        const threadActivityTime = (t: Thread) =>
          new Date(t.messages.at(-1)?.ts ?? t.createdAt).getTime();
        const projectThreads = get().threads.filter((t) => t.projectId === projectId);
        const parentThread = options?.parentThreadId
          ? projectThreads.find((t) => t.id === options.parentThreadId)
          : undefined;
        const lastProjectThread =
          parentThread ??
          projectThreads
            .filter((t) => !t.parentThreadId && !t.subagent)
            .sort((a, b) => threadActivityTime(b) - threadActivityTime(a))[0];

        // Claude Code CLI is a terminal-hosted pseudo-model; it must be picked
        // deliberately per thread, so new threads fall back to Claude Fable 5.1
        // instead of inheriting it.
        const inheritedModelId =
          lastProjectThread?.modelId === 'claude:claude-code-cli'
            ? 'claude:claude-fable-5-1'
            : lastProjectThread?.modelId;

        const newThread: Thread = {
          id: crypto.randomUUID(),
          projectId,
          title: title || `Thread ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          status: 'idle',
          modelId: options?.modelId ?? inheritedModelId ?? 'grok:grok-4.7',
          accessMode: options?.accessMode ?? lastProjectThread?.accessMode ?? 'full-access',
          codexReasoningEffort: lastProjectThread?.codexReasoningEffort,
          codexServiceTier: lastProjectThread?.codexServiceTier,
          claudeReasoningEffort: lastProjectThread?.claudeReasoningEffort,
          claudeContextWindow: lastProjectThread?.claudeContextWindow,
          grokReasoningEffort: lastProjectThread?.grokReasoningEffort,
          museReasoningEffort: lastProjectThread?.museReasoningEffort,
          openCodeReasoningEffort: lastProjectThread?.openCodeReasoningEffort,
          createdAt: new Date().toISOString(),
          parentThreadId: options?.parentThreadId,
          spawnId: options?.spawnId,
          hiddenFromRecent: options?.hiddenFromRecent,
          subagent: options?.subagent,
          // Subagents work in their driver's directory. A workspace the driver's
          // agent made itself is their run directory outright: their sessions
          // are new, so nothing was recorded elsewhere.
          durangoWorkspace:
            options?.durangoWorkspace !== undefined
              ? options.durangoWorkspace
              : parentThread?.durangoWorkspace
                ? { ...parentThread.durangoWorkspace, adopted: undefined }
                : parentThread?.durangoWorkspace,
          messages: [],
        };
        set((state) => ({
          threads: [newThread, ...state.threads],
          ...(options?.select === false
            ? {}
            : {
                selectedProjectId: projectId,
                ...syncSavedView(state, panesForSelection(state, newThread.id), {
                  threads: [newThread, ...state.threads],
                }),
              }),
        }));
        return newThread.id;
      },

      branchThread: (sourceThreadId) => {
        const state = get();
        const family = createThreadBranchFamily(state.threads, sourceThreadId);
        if (!family) return null;
        const newThread = family.threads.find((thread) => thread.id === family.rootId);
        if (!newThread) return null;
        set((state) => {
          const threads = [...family.threads, ...state.threads];
          return {
            threads,
            selectedProjectId: newThread.projectId,
            ...syncSavedView(state, panesForSelection(state, newThread.id), { threads }),
          };
        });
        return family.rootId;
      },

      selectProject: (id) =>
        set((state) => {
          const selectedThread = state.threads.find((t) => t.id === state.selectedThreadId);

          // Moving the shell to another project drops the thread view, split
          // and all — the same rule as before panes existed, keyed off the
          // focused one.
          const leavesThread = Boolean(selectedThread && selectedThread.projectId !== id);

          return {
            selectedProjectId: id,
            selectedThreadId: leavesThread ? null : state.selectedThreadId,
            paneThreadIds: leavesThread ? [] : state.paneThreadIds,
            // The split's saved view stays in the sidebar; it just stops
            // following the panes once they're gone.
            activeSavedViewId: leavesThread ? null : state.activeSavedViewId,
          };
        }),

      selectThread: (id) =>
        set((state) => {
          const thread = state.threads.find((t) => t.id === id);

          return {
            ...syncSavedView(state, panesForSelection(state, id)),
            selectedProjectId: thread?.projectId ?? state.selectedProjectId,
            threads: id ? threadsWithOpenedSeen(state, id) : state.threads,
          };
        }),

      openThreadInSplit: (id) =>
        set((state) => {
          const thread = state.threads.find((t) => t.id === id);
          if (!thread) return {};
          // Already on screen: focus it rather than opening a second copy —
          // two panes on one thread would fight over the same transcript.
          const paneThreadIds = state.paneThreadIds.includes(id)
            ? state.paneThreadIds
            : state.paneThreadIds.length >= MAX_THREAD_PANES
              ? null
              : [...state.paneThreadIds, id];
          if (!paneThreadIds) return {};
          return {
            ...syncSavedView(state, { selectedThreadId: id, paneThreadIds }),
            selectedProjectId: thread.projectId,
            threads: threadsWithOpenedSeen(state, id),
          };
        }),

      closeThreadPane: (id) =>
        set((state) => {
          if (!state.paneThreadIds.includes(id)) return {};
          const next = panesAfterRemoval(state, (paneId) => paneId === id);
          const focused = next.selectedThreadId
            ? state.threads.find((t) => t.id === next.selectedThreadId)
            : undefined;
          return {
            // Closing panes back down to a single thread retires the saved
            // view: the user has taken the split apart by hand.
            ...syncSavedView(state, next, { ejectOnCollapse: true }),
            selectedProjectId: focused?.projectId ?? state.selectedProjectId,
          };
        }),

      openSavedView: (id) =>
        set((state) => {
          const view = state.savedViews.find((candidate) => candidate.id === id);
          if (!view) return {};
          // Threads deleted since the view was saved are simply left out.
          const paneThreadIds = view.threadIds
            .filter((threadId) => state.threads.some((thread) => thread.id === threadId))
            .slice(0, MAX_THREAD_PANES);
          if (paneThreadIds.length === 0) {
            return {
              ...(state.splitViewSettings.autoSave
                ? { savedViews: state.savedViews.filter((candidate) => candidate.id !== id) }
                : {}),
              activeSavedViewId:
                state.activeSavedViewId === id ? null : state.activeSavedViewId,
            };
          }
          const focusedId = paneThreadIds[0];
          const focused = state.threads.find((thread) => thread.id === focusedId);
          // Down to one surviving thread it is no longer a split: open that
          // thread and drop the entry, matching what closing panes does.
          const collapsed = paneThreadIds.length < 2;
          return {
            paneThreadIds,
            selectedThreadId: focusedId,
            selectedProjectId: focused?.projectId ?? state.selectedProjectId,
            threads: threadsWithOpenedSeen(state, paneThreadIds),
            ...(state.splitViewSettings.autoSave
              ? {
                  savedViews: collapsed
                    ? state.savedViews.filter((candidate) => candidate.id !== id)
                    : state.savedViews.map((candidate) =>
                        candidate.id === id ? { ...candidate, threadIds: paneThreadIds } : candidate
                      ),
                }
              : {}),
            // With auto-save off the view is opened read-only: editing the
            // split on screen must not rewrite an entry the user is keeping.
            activeSavedViewId:
              collapsed || !state.splitViewSettings.autoSave ? null : id,
          };
        }),

      deleteSavedView: (id) =>
        set((state) => ({
          savedViews: state.savedViews.filter((view) => view.id !== id),
          activeSavedViewId: state.activeSavedViewId === id ? null : state.activeSavedViewId,
        })),

      updateThread: (id, updates) =>
        set((state) => {
          const threads = state.threads.map((t) => {
            if (t.id !== id) return t;
            const next = { ...t, ...updates };
            // A run that ends while the user is elsewhere leaves a dot in the
            // sidebar until the thread is opened; starting a new run (or
            // finishing one in the open thread) clears it again. Only a run
            // that ran to completion counts — a stop (-> idle) was deliberate,
            // so it needs no follow-up marker.
            if (updates.status && updates.status !== t.status) {
              next.finishedUnseenAt =
                t.status === 'running' &&
                (updates.status === 'done' || updates.status === 'error') &&
                (!isAgentsPanelVisible(state) || !state.paneThreadIds.includes(id))
                  ? new Date().toISOString()
                  : undefined;
              // A snoozed thread wakes when its run ends: finished, or (on a
              // failure) needing the user. A stop was deliberate and keeps it
              // snoozed. Questions and approvals wake it too (App).
              if (
                t.snoozedAt &&
                !('snoozedAt' in updates) &&
                t.status === 'running' &&
                (updates.status === 'done' || updates.status === 'error')
              ) {
                next.snoozedAt = undefined;
                // Already on screen: nothing to flag, it just rejoins the list.
                if (!isAgentsPanelVisible(state) || !state.paneThreadIds.includes(id)) {
                  next.wokeAt = new Date().toISOString();
                  next.wokeReason = updates.status === 'error' ? 'attention' : 'finished';
                }
              }
              // New work in a settled thread brings it back to the sidebar.
              if (t.settledAt && updates.status === 'running' && !('settledAt' in updates)) {
                next.settledAt = undefined;
              }
            }
            return next;
          });
          return {
            threads,
            // Saved-view labels are derived from their current thread titles,
            // including automatic titles assigned after a view was created.
            ...(updates.title !== undefined
              ? {
                  savedViews: state.savedViews.map((view) => {
                    if (!view.threadIds.includes(id)) return view;
                    const name = savedViewName(threads, view.threadIds);
                    return view.name === name ? view : { ...view, name };
                  }),
                }
              : {}),
          };
        }),

      deleteThread: (id) =>
        set((state) => {
          // A deleted thread leaves every saved view it appeared in; a view
          // left with one thread goes with it.
          const threads = state.threads.filter((thread) => thread.id !== id);
          const savedViews = pruneSavedViews(state.savedViews, threads);
          const panes = panesAfterRemoval(state, (paneId) => paneId === id);
          const focusedPaneThread = panes.selectedThreadId
            ? threads.find((thread) => thread.id === panes.selectedThreadId)
            : undefined;
          return {
            threads,
            ...panes,
            selectedProjectId: focusedPaneThread?.projectId ?? state.selectedProjectId,
            savedViews,
            activeSavedViewId: savedViews.some((view) => view.id === state.activeSavedViewId)
              ? state.activeSavedViewId
              : null,
          };
        }),

      addMessageToThread: (threadId, message) => {
        const msg: Message = {
          ...message,
          id: crypto.randomUUID(),
          ts: new Date().toISOString(),
        };
        set((state) => ({
          threads: state.threads.map((t) =>
            // New activity puts a thread back in Recent agents even if it was
            // removed — except subagent children, which render nested under
            // their parent and never as top-level Recent rows.
            t.id === threadId
              ? {
                  ...t,
                  messages: [...t.messages, msg],
                  hiddenFromRecent: t.parentThreadId ? t.hiddenFromRecent : false,
                }
              : t
          ),
        }));
        return msg.id;
      },

      appendToThreadMessage: (threadId, messageId, chunk) => {
        if (!chunk) return;
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  messages: thread.messages.map((message) =>
                    message.id === messageId
                      ? { ...message, content: `${message.content}${chunk}` }
                      : message
                  ),
                }
              : thread
          ),
        }));
      },

      updateThreadMessage: (threadId, messageId, updates) =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  messages: thread.messages.map((message) =>
                    message.id === messageId ? { ...message, ...updates } : message
                  ),
                }
              : thread
          ),
        })),

      addActivityToThreadMessage: (threadId, messageId, activity) =>
        set((state) => {
          const { detailDelta, ...activityFields } = activity;
          const nextActivity: AgentActivity = {
            ...activityFields,
            ...(detailDelta ? { detail: `${activity.detail ?? ''}${detailDelta}` } : {}),
            id: crypto.randomUUID(),
            ts: new Date().toISOString(),
          };
          // Providers re-emit a keyed step as it progresses, and an update can
          // omit a field it reported earlier (a tool's input is only in the
          // call, its output only in the result). An explicit undefined must
          // not erase what the row already knows.
          const patch = Object.fromEntries(
            Object.entries(activityFields).filter(([, value]) => value !== undefined)
          ) as Partial<AgentActivity>;

          return {
            threads: state.threads.map((thread) =>
              thread.id === threadId
                ? {
                    ...thread,
                    messages: thread.messages.map((message) => {
                      if (message.id !== messageId) return message;

                      const existingActivities = message.activities ?? [];
                      const existingIndex = activity.key
                        ? existingActivities.findIndex((existing) => existing.key === activity.key)
                        : -1;

                      if (existingIndex >= 0) {
                        return {
                          ...message,
                          activities: existingActivities.map((existing, index) =>
                            index === existingIndex
                              ? {
                                  ...existing,
                                  ...patch,
                                  ...(detailDelta
                                    ? { detail: `${existing.detail ?? ''}${detailDelta}` }
                                    : {}),
                                  ts: nextActivity.ts,
                                  contentOffset: existing.contentOffset,
                                }
                              : existing
                          ),
                        };
                      }

                      return {
                        ...message,
                        activities: [
                          ...existingActivities,
                          { ...nextActivity, contentOffset: message.content.length },
                        ],
                      };
                    }),
                  }
                : thread
            ),
          };
        }),

      completeInProgressPlanEntries: (threadId, messageId) =>
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  messages: thread.messages.map((message) => {
                    if (message.id !== messageId || !message.activities?.length) return message;
                    let changed = false;
                    const activities = message.activities.map((activity) => {
                      if (
                        activity.type !== 'plan' ||
                        !activity.plan?.some((entry) => entry.status === 'in_progress')
                      ) {
                        return activity;
                      }
                      changed = true;
                      const plan = activity.plan.map((entry) =>
                        entry.status === 'in_progress'
                          ? { ...entry, status: 'completed' as const }
                          : entry
                      );
                      const completed = plan.filter((entry) => entry.status === 'completed').length;
                      const allDone = completed === plan.length;
                      return {
                        ...activity,
                        plan,
                        ...(allDone ? { status: 'done' as const } : {}),
                        title: `Tasks (${completed}/${plan.length})`,
                      };
                    });
                    return changed ? { ...message, activities } : message;
                  }),
                }
              : thread
          ),
        })),

      queueMessageToThread: (threadId, message) => {
        const id = crypto.randomUUID();
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === threadId
              ? { ...t, queuedMessages: [...(t.queuedMessages ?? []), { ...message, id }] }
              : t
          ),
        }));
        return id;
      },

      removeQueuedThreadMessage: (threadId, messageId) =>
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === threadId
              ? {
                  ...t,
                  queuedMessages: (t.queuedMessages ?? []).filter((m) => m.id !== messageId),
                }
              : t
          ),
        })),

      addBtwExchange: (threadId, question) => {
        const thread = get().threads.find((t) => t.id === threadId);
        const anchorMessage = thread?.messages.at(-1);
        const afterMessageId = anchorMessage?.id;
        const exchange: BtwExchange = {
          id: crypto.randomUUID(),
          question,
          answer: '',
          status: 'running',
          createdAt: new Date().toISOString(),
          ...(afterMessageId ? { afterMessageId } : {}),
          ...(anchorMessage?.kind === 'agent-run'
            ? { contentOffset: anchorMessage.content.length }
            : {}),
        };
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === threadId
              ? { ...t, btwExchanges: [...(t.btwExchanges ?? []), exchange] }
              : t
          ),
        }));
        return exchange.id;
      },

      appendToBtwExchange: (threadId, exchangeId, chunk) => {
        if (!chunk) return;
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === threadId
              ? {
                  ...t,
                  btwExchanges: (t.btwExchanges ?? []).map((exchange) =>
                    exchange.id === exchangeId
                      ? { ...exchange, answer: `${exchange.answer}${chunk}` }
                      : exchange
                  ),
                }
              : t
          ),
        }));
      },

      updateBtwExchange: (threadId, exchangeId, updates) =>
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === threadId
              ? {
                  ...t,
                  btwExchanges: (t.btwExchanges ?? []).map((exchange) =>
                    exchange.id === exchangeId ? { ...exchange, ...updates } : exchange
                  ),
                }
              : t
          ),
        })),

      removeBtwExchange: (threadId, exchangeId) =>
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === threadId
              ? {
                  ...t,
                  btwExchanges: (t.btwExchanges ?? []).filter((e) => e.id !== exchangeId),
                }
              : t
          ),
        })),

      toggleProjectExpanded: (id) =>
        set((state) => ({
          expandedProjects: state.expandedProjects.includes(id)
            ? state.expandedProjects.filter((p) => p !== id)
            : [...state.expandedProjects, id],
        })),

      setWorkspacePath: (path) => set({ workspacePath: path }),

      openFile: (path, content) => {
        // A tab without a path can never be rendered, closed, or saved — refuse
        // it here rather than letting it break the whole editor.
        if (!path) return;
        const existing = get().openFiles.find((f) => f.path === path);
        if (existing) {
          set({ activeFilePath: path });
          return;
        }
        set((state) => ({
          openFiles: [...state.openFiles, { path, content, isDirty: false, diskRevision: 0 }],
          activeFilePath: path,
        }));
      },

      closeFile: (path) => {
        set((state) => {
          const newFiles = state.openFiles.filter((f) => f.path !== path);
          let newActive = state.activeFilePath;
          if (state.activeFilePath === path) {
            newActive = newFiles.length > 0 ? newFiles[newFiles.length - 1].path : null;
          }
          return { openFiles: newFiles, activeFilePath: newActive };
        });
      },

      setActiveFile: (path) => set({ activeFilePath: path }),

      updateOpenFileContent: (path, content) =>
        set((state) => {
          const file = state.openFiles.find((candidate) => candidate.path === path);
          if (!file || (file.isDirty && file.content === content)) return state;
          return {
            openFiles: state.openFiles.map((candidate) =>
              candidate.path === path
                ? { ...candidate, content, isDirty: true }
                : candidate
            ),
          };
        }),

      markFileSaved: (path, content) =>
        set((state) => {
          const file = state.openFiles.find((candidate) => candidate.path === path);
          if (!file) return state;
          const nextContent = content ?? file.content;
          if (!file.isDirty && file.content === nextContent) return state;
          return {
            openFiles: state.openFiles.map((candidate) =>
              candidate.path === path
                ? { ...candidate, content: nextContent, isDirty: false }
                : candidate
            ),
          };
        }),

      refreshOpenFileFromDisk: (path, content) =>
        set((state) => {
          const file = state.openFiles.find((candidate) => candidate.path === path);
          // External writes may refresh clean tabs, but must never replace an
          // unsaved Monaco buffer.
          if (!file || file.isDirty) return state;
          return {
            openFiles: state.openFiles.map((candidate) =>
              candidate.path === path
                ? {
                    ...candidate,
                    content: content ?? candidate.content,
                    diskRevision: (candidate.diskRevision ?? 0) + 1,
                  }
                : candidate
            ),
          };
        }),

      closeAllFiles: () => set({ openFiles: [], activeFilePath: null }),
    }),
    {
      name: 'orion-storage',
      storage: createJSONStorage(() => orionStorage),
      version: 1,
      // `threads` is deliberately absent: the persist middleware stringifies
      // this partialized state on EVERY store update, and threads hold every
      // transcript (multi-MB after a while) — including them made each
      // streaming chunk an O(entire-history) serialize. They are persisted by
      // the throttled saver below instead, and grafted back in on hydration.
      partialize: (state) => ({
        activeTab: state.activeTab,
        projects: state.projects,
        noProject: state.noProject,
        selectedProjectId: state.selectedProjectId,
        selectedThreadId: state.selectedThreadId,
        paneThreadIds: state.paneThreadIds,
        savedViews: state.savedViews,
        activeSavedViewId: state.activeSavedViewId,
        splitViewSettings: {
          ...defaultSplitViewSettings,
          ...state.splitViewSettings,
        },
        durangoWorkspaceSettings: {
          ...defaultDurangoWorkspaceSettings,
          ...state.durangoWorkspaceSettings,
        },
        workspaceSyncSettings: {
          ...defaultWorkspaceSyncSettings,
          ...state.workspaceSyncSettings,
        },
        durangoSettings: {
          ...defaultDurangoSettings,
          ...state.durangoSettings,
        },
        remoteControlSettings: {
          ...defaultRemoteControlSettings,
          ...state.remoteControlSettings,
        },
        deploymentSettings: {
          ...defaultDeploymentSettings,
          ...state.deploymentSettings,
        },
        sidebarV2Settings: {
          ...defaultSidebarV2Settings,
          ...state.sidebarV2Settings,
          views: { ...defaultSidebarV2Settings.views, ...state.sidebarV2Settings?.views },
        },
        appearanceSettings: { ...defaultAppearanceSettings, ...state.appearanceSettings },
        workspacePath: state.workspacePath,
        expandedProjects: state.expandedProjects,
        providerSettings: {
          ...defaultProviderSettings,
          ...state.providerSettings,
        },
        orchestrationSettings: {
          ...defaultOrchestrationSettings,
          ...state.orchestrationSettings,
          models: {
            ...defaultOrchestrationSettings.models,
            ...state.orchestrationSettings?.models,
          },
        },
        notificationSettings: {
          ...defaultNotificationSettings,
          ...state.notificationSettings,
        },
        textGenerationSettings: {
          ...defaultTextGenerationSettings,
          ...state.textGenerationSettings,
        },
      }),
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<OrionState>) };
        // Retired features whose persisted state may linger in older stores:
        // Rifts (replaced by Durango workspaces) and Epics.
        delete (merged as { riftsSettings?: unknown }).riftsSettings;
        delete (merged as { epics?: unknown }).epics;
        delete (merged as { selectedEpicId?: unknown }).selectedEpicId;
        delete (merged as { epicsSettings?: unknown }).epicsSettings;
        const persistedWorkspaceSettings = (persisted as Partial<OrionState> | undefined)?.durangoWorkspaceSettings;
        merged.durangoWorkspaceSettings =
          persistedWorkspaceSettings && (persistedWorkspaceSettings.version ?? 1) < 2
            ? // Before agents made their own workspaces the app made one for
              // every thread by default; move those stores to the new default.
              { ...persistedWorkspaceSettings, enabled: false, version: 2 }
            : { ...defaultDurangoWorkspaceSettings, ...merged.durangoWorkspaceSettings };
        // The settings UI no longer has a separate "allow this machine to be
        // controlled" toggle: enabling remote control implies it (pairing
        // codes still gate every connection). Lift configs persisted before
        // that simplification so the engine matches what the UI now shows.
        if (merged.remoteControlSettings?.enabled === true) {
          merged.remoteControlSettings = {
            ...merged.remoteControlSettings,
            allowIncoming: true,
          };
        }
        merged.deploymentSettings = {
          ...defaultDeploymentSettings,
          ...merged.deploymentSettings,
        };
        merged.appearanceSettings = { ...defaultAppearanceSettings, ...merged.appearanceSettings };
        merged.sidebarV2Settings = {
          ...defaultSidebarV2Settings,
          ...merged.sidebarV2Settings,
          views: { ...defaultSidebarV2Settings.views, ...merged.sidebarV2Settings?.views },
        };
        // Durango merge: work sharing defaults to Full. Pre-Durango stores
        // (no consentVersion) move to enabled once and show a one-time
        // notice; a later "off" sticks (workspaceSyncConsent.ts).
        merged.workspaceSyncSettings = migrateWorkspaceSyncSettings(
          (persisted as Partial<OrionState> | undefined)?.workspaceSyncSettings
        );
        merged.durangoSettings = {
          ...defaultDurangoSettings,
          ...merged.durangoSettings,
          dispatch: {
            ...defaultDurangoDispatchSettings,
            ...merged.durangoSettings?.dispatch,
          },
        };
        // The commit/PR message model used to live on epicsSettings; it now
        // also writes thread titles, so it moved to textGenerationSettings.
        // Carry an explicit pick over — the old "Auto (cheapest available)"
        // was persisted as null, which is exactly the new "never picked"
        // value, so those users simply fall into the new default order.
        const legacyCommitModelId = (persisted as { epicsSettings?: { commitModelId?: unknown } })
          ?.epicsSettings?.commitModelId;
        merged.textGenerationSettings = {
          ...defaultTextGenerationSettings,
          ...(typeof legacyCommitModelId === 'string' && legacyCommitModelId
            ? { modelId: legacyCommitModelId }
            : {}),
          ...(persisted as Partial<OrionState>)?.textGenerationSettings,
        };
        // Role and text-generation picks persisted on a retired model (every
        // store saves the full role map, so the old Haiku 4.5 exploring
        // default is on disk for everyone) move to that model's successor.
        const upgradeModelId = (id: string) => agentModelSuccessors[id] ?? id;
        merged.orchestrationSettings = {
          ...defaultOrchestrationSettings,
          ...merged.orchestrationSettings,
          models: Object.fromEntries(
            Object.entries({
              ...defaultOrchestrationSettings.models,
              ...merged.orchestrationSettings?.models,
            }).map(([role, id]) => [role, upgradeModelId(id)])
          ) as OrchestrationSettings['models'],
        };
        if (merged.textGenerationSettings.modelId) {
          merged.textGenerationSettings.modelId = upgradeModelId(merged.textGenerationSettings.modelId);
        }
        // Agent runs can't survive an app restart — the CLI processes die with
        // the app — so any thread or message rehydrated as 'running' is a
        // leftover from the previous session. Left alone it pins the run
        // status bar forever, because the run-event handler only flips
        // messages tracked by runs started in this session.
        const restartedAt = new Date().toISOString();
        // A Claude turn can finish while its background tasks keep working:
        // the message persists as 'done' captioned "Waiting on … background
        // task(s) …" (waitingOnBackgroundStatusText in App.tsx — keep this
        // pattern in sync) with the thread 'running'. Those tasks died with
        // the app, so the wait can never settle — rewrite the caption
        // alongside the status flip. Only while the thread is still
        // 'running', though: every resolution path (a background-settled
        // event or the synthetic follow-up turn finishing) flips the thread
        // off 'running' but leaves the old caption behind as history, and
        // history must not be rebranded as a restart casualty. The first
        // alternation matches captions persisted by older builds ("Waiting on
        // N background agents…").
        const waitingOnBackground = /^Waiting on (\d+ background (?:agents?|tasks?)|background task)\b.*…$/;
        merged.threads = merged.threads.map((thread) => {
          // Threads used to carry a single board task; they now carry a list.
          thread = migrateLegacyLinkedTask(thread);
          // Epics were removed; drop the grouping older builds persisted.
          if ('epicId' in thread) {
            const { epicId: _epicId, ...rest } = thread as Thread & { epicId?: unknown };
            thread = rest;
          }
          const waitUnresolved = thread.status === 'running';
          const stale =
            waitUnresolved || thread.messages.some((message) => message.status === 'running');
          if (!stale) return thread;
          // Only a currently live wait may be rebranded. Every resolution
          // path (a background-settled event or a synthetic follow-up turn)
          // appends a newer agent-run message after the waiting one, while a
          // resolved wait can keep its historical "Waiting on …" caption. So
          // the wait is live only when the thread's newest agent-run message
          // is the one carrying the caption; a captioned message behind a
          // newer turn — including the running foreground or synthetic turn
          // that made this thread 'running' — is history from a wait that
          // already resolved and must not be relabeled as a restart casualty.
          const lastAgentRun = waitUnresolved
            ? [...thread.messages].reverse().find((message) => message.kind === 'agent-run')
            : undefined;
          const liveWaitId =
            lastAgentRun &&
            lastAgentRun.status !== 'running' &&
            lastAgentRun.statusText != null &&
            waitingOnBackground.test(lastAgentRun.statusText)
              ? lastAgentRun.id
              : undefined;
          return {
            ...thread,
            status: waitUnresolved ? 'idle' : thread.status,
            messages: thread.messages.map((message) => {
              if (
                message.kind === 'claude-background-intervention' &&
                message.claudeBackgroundIntervention &&
                (message.claudeBackgroundIntervention.status === 'pending' ||
                  message.claudeBackgroundIntervention.status === 'stopping')
              ) {
                return {
                  ...message,
                  claudeBackgroundIntervention: {
                    ...message.claudeBackgroundIntervention,
                    status: 'settled' as const,
                    error: undefined,
                  },
                };
              }
              if (message.status === 'running') {
                return {
                  ...message,
                  status: 'stopped' as const,
                  completedAt: message.completedAt ?? restartedAt,
                  statusText: 'Interrupted by app restart.',
                };
              }
              if (message.id === liveWaitId) {
                return {
                  ...message,
                  statusText: 'Background tasks interrupted by app restart.',
                };
              }
              return message;
            }),
          };
        });
        // Panes must reference threads that survived to this launch, and stores
        // written before the split view shipped carry no pane list at all —
        // rebuild it from the selected thread so those users reopen on the
        // single view they left.
        const liveThreadIds = new Set(merged.threads.map((thread) => thread.id));
        const restoredPanes = (
          Array.isArray(merged.paneThreadIds) ? merged.paneThreadIds : []
        ).filter(
          (id, index, ids) => liveThreadIds.has(id) && ids.indexOf(id) === index
        );
        merged.paneThreadIds = restoredPanes.slice(0, MAX_THREAD_PANES);
        if (merged.selectedThreadId && !liveThreadIds.has(merged.selectedThreadId)) {
          merged.selectedThreadId = null;
        }
        if (merged.selectedThreadId && !merged.paneThreadIds.includes(merged.selectedThreadId)) {
          merged.paneThreadIds =
            merged.paneThreadIds.length >= MAX_THREAD_PANES
              ? [merged.selectedThreadId, ...merged.paneThreadIds.slice(1)]
              : [...merged.paneThreadIds, merged.selectedThreadId];
        }
        // A split whose focused thread is gone reopens on its leftmost pane
        // rather than throwing the rest away.
        if (!merged.selectedThreadId) merged.selectedThreadId = merged.paneThreadIds[0] ?? null;
        // Saved views outlive their threads on disk, so they get the same
        // treatment: drop dead ids, and drop any view that is no longer a
        // split. Stores written before saved views existed have none.
        merged.savedViews = pruneSavedViews(
          Array.isArray(merged.savedViews) ? merged.savedViews : [],
          merged.threads
        );
        merged.splitViewSettings = {
          ...defaultSplitViewSettings,
          ...merged.splitViewSettings,
        };
        // Tracking only resumes for the view actually back on screen.
        const restoredView = merged.savedViews.find(
          (view) => view.id === merged.activeSavedViewId
        );
        merged.activeSavedViewId =
          restoredView &&
          merged.splitViewSettings.autoSave &&
          sameIds(restoredView.threadIds, merged.paneThreadIds)
            ? restoredView.id
            : null;
        // Restored panes count as opened only when their transcripts are
        // actually visible. Code keeps every completion marker intact.
        if (isAgentsPanelVisible(merged)) {
          merged.threads = threadsWithOpenedSeen(merged, merged.paneThreadIds);
        }
        return merged;
      },
    }
  )
);

// The threads saver sends only changed transcripts at most once per
// THREADS_SAVE_MS (a streaming run mutates a thread many times a second),
// with a synchronous patch flush on unload. Zustand actions replace the
// changed thread object, so reference identity identifies dirty transcripts.
const THREADS_SAVE_MS = 5000;

const scheduleThreadsSave = () => {
  if (threadsSaveTimer !== null) return;
  threadsSaveTimer = setTimeout(() => {
    threadsSaveTimer = null;
    flushThreadsSave();
  }, THREADS_SAVE_MS);
};

export const flushOrionThreadsSave = async (): Promise<boolean> => {
  cancelQueuedThreadsSave();
  if (typeof window === 'undefined' || !window.orion?.saveThreads) return false;
  if (threadsPersistenceBlocked) return false;
  // Before hydration the store still holds the initial threads: [] — saving
  // now would replace the on-disk transcripts with an empty snapshot, which
  // outranks the legacy embedded threads on the next launch. (Safe on the
  // post-hydration flush: zustand flips hasHydrated before its
  // finish-hydration listeners run.)
  if (!useOrionStore.persist.hasHydrated()) return false;
  if (threadsSaveFlush !== null) {
    if (!(await threadsSaveFlush)) return false;
    return flushOrionThreadsSave();
  }
  const threads = useOrionStore.getState().threads;
  if (pendingThreadUpserts.size === 0 && pendingThreadDeletes.size === 0 && !pendingThreadOrder) return true;
  const patch: ThreadsPatch = {
    version: 2,
    upserts: [...pendingThreadUpserts.values()],
    deletes: [...pendingThreadDeletes],
    order: threads.map((thread) => thread.id),
  };
  for (const thread of patch.upserts) pendingThreadUpserts.delete(thread.id);
  for (const id of patch.deletes) pendingThreadDeletes.delete(id);
  pendingThreadOrder = false;
  threadsInFlightPatch = patch;
  const save = (async () => {
    try {
      const saved = await window.orion.saveThreads(patch);
      if (!saved) throw new Error('Thread patch was not acknowledged.');
      return saved;
    } catch (error) {
      console.warn('Failed to persist Orion threads; retrying', error);
      const currentById = new Map(useOrionStore.getState().threads.map((thread) => [thread.id, thread]));
      for (const thread of patch.upserts) {
        if (!pendingThreadUpserts.has(thread.id) && currentById.has(thread.id)) {
          pendingThreadUpserts.set(thread.id, currentById.get(thread.id)!);
        }
      }
      for (const id of patch.deletes) {
        if (!pendingThreadUpserts.has(id) && !currentById.has(id)) pendingThreadDeletes.add(id);
      }
      pendingThreadOrder = true;
      scheduleThreadsSave();
      return false;
    }
  })();
  threadsSaveFlush = save;
  try {
    return await save;
  } finally {
    if (threadsInFlightPatch === patch) threadsInFlightPatch = null;
    if (threadsSaveFlush === save) threadsSaveFlush = null;
  }
};

const flushThreadsSave = () => {
  void flushOrionThreadsSave();
};

useOrionStore.subscribe((state, previous) => {
  if (state.threads === previous.threads || !useOrionStore.persist.hasHydrated()) return;
  if (state.threads.length === previous.threads.length) {
    let sameOrder = true;
    let changed = false;
    for (let index = 0; index < state.threads.length; index += 1) {
      const thread = state.threads[index];
      const prior = previous.threads[index];
      if (thread.id !== prior.id) {
        sameOrder = false;
        break;
      }
      if (thread !== prior) {
        pendingThreadUpserts.set(thread.id, thread);
        pendingThreadDeletes.delete(thread.id);
        changed = true;
      }
    }
    // Streaming updates keep array order stable and replace only the active
    // thread. Avoid allocating two 888-entry maps for every output chunk.
    if (sameOrder) {
      if (changed) scheduleThreadsSave();
      return;
    }
  }
  const previousById = new Map(previous.threads.map((thread) => [thread.id, thread]));
  const currentIds = new Set<string>();
  for (const thread of state.threads) {
    currentIds.add(thread.id);
    if (previousById.get(thread.id) !== thread) {
      pendingThreadUpserts.set(thread.id, thread);
      pendingThreadDeletes.delete(thread.id);
    }
  }
  for (const thread of previous.threads) {
    if (!currentIds.has(thread.id)) {
      pendingThreadUpserts.delete(thread.id);
      pendingThreadDeletes.add(thread.id);
    }
  }
  pendingThreadOrder = true;
  scheduleThreadsSave();
});

// Materialize the threads file as soon as hydration lands rather than a
// throttle-window later: the store file stops embedding threads on its first
// post-hydration save, so until this flush runs the transcripts exist only in
// memory and a crash would lose them.
//
// Stores that turned sidebar v2 on before the first-switch settle existed get
// it once here rather than in `merge`: thread edits made during hydration are
// never saved, while this one goes through the saver like a user's.
const settleThreadsFromBeforeSidebarV2 = () => {
  const { sidebarV2Settings, setSidebarV2Settings } = useOrionStore.getState();
  if (threadsPersistenceBlocked || !sidebarV2Settings.enabled || sidebarV2Settings.settledExistingAt) return;
  setSidebarV2Settings({});
};
useOrionStore.persist.onFinishHydration(() => {
  if (!loadedThreadsFromStorage && !threadsPersistenceBlocked) {
    for (const thread of useOrionStore.getState().threads) pendingThreadUpserts.set(thread.id, thread);
    pendingThreadOrder = true;
  }
  settleThreadsFromBeforeSidebarV2();
  flushThreadsSave();
});
if (useOrionStore.persist.hasHydrated()) {
  if (!loadedThreadsFromStorage && !threadsPersistenceBlocked) {
    for (const thread of useOrionStore.getState().threads) pendingThreadUpserts.set(thread.id, thread);
    pendingThreadOrder = true;
  }
  settleThreadsFromBeforeSidebarV2();
  flushThreadsSave();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    cancelQueuedThreadsSave();
    // Closing the window mid-hydration must preserve the on-disk snapshot —
    // the store still holds the initial threads: [] and flushing it would
    // erase the transcript history. Same when the threads file existed but
    // failed to load: never overwrite it with the lesser hydrated state.
    if (threadsPersistenceBlocked || !useOrionStore.persist.hasHydrated()) return;
    // An async IPC save started here races app teardown — Electron can exit
    // before the promise settles, dropping up to a throttle-window of
    // transcript. Block the unload on a synchronous write instead.
    // Include in-flight ids unconditionally: an async patch may never commit
    // once the renderer exits.
    if (window.orion?.saveThreadsSync) {
      const threads = useOrionStore.getState().threads;
      // Cleared storage must stay cleared — don't write the lingering
      // in-memory snapshot back.
      if (threads === clearedThreadsSnapshot) return;
      const currentById = new Map(threads.map((thread) => [thread.id, thread]));
      const affectedIds = new Set<string>([
        ...pendingThreadUpserts.keys(),
        ...pendingThreadDeletes,
        ...(threadsInFlightPatch?.upserts.map((thread) => thread.id) ?? []),
        ...(threadsInFlightPatch?.deletes ?? []),
      ]);
      const patch: ThreadsPatch = {
        version: 2,
        upserts: [...affectedIds].flatMap((id) => {
          const thread = currentById.get(id);
          return thread ? [thread] : [];
        }),
        deletes: [...affectedIds].filter((id) => !currentById.has(id)),
        order: threads.map((thread) => thread.id),
      };
      if (patch.upserts.length > 0 || patch.deletes.length > 0 || pendingThreadOrder) {
        window.orion.saveThreadsSync(patch);
      }
    } else {
      flushThreadsSave();
    }
  });
}
