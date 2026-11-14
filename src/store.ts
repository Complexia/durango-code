import { create } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';
import { agentModelSuccessors } from './agentCatalog';
import { branchFamilyThreadIds, createThreadBranchFamily } from './thread-branching';
import {
  sameThreadSummary,
  STEERED_RUN_CAPTION,
  summarizeThreadMessages,
  threadShellOf,
  WAITING_ON_BACKGROUND_CAPTION,
  withSubagentDetails,
  type ThreadSummary,
} from './thread-shell.js';
import { defaultWorkspaceSyncConsentSettings, migrateWorkspaceSyncSettings } from './app/workspaceSyncConsent';
import { adoptRemoteSettings, remoteSettingsOf } from './app/remoteThreads';

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
 * settle instead of project groups, on by default. `views` are the lists
 * toggled from its header menu.
 */
export type SidebarV2Settings = {
  enabled: boolean;
  /**
   * 2 since sidebar v2 is the default: stores from before then (where it was
   * opt-in) are switched on once, and a later "off" sticks.
   */
  version?: number;
  views: { pinned: boolean; working: boolean; recent: boolean; snoozed: boolean; settled: boolean };
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
  enabled: true,
  version: 2,
  views: { pinned: false, working: false, recent: true, snoozed: false, settled: false },
};

/**
 * Settles every thread sidebar v2 would list (not pinned, snoozed, settled or
 * running), as if the user had clicked Settle on each.
 */
export const settleThreadsForSidebarV2 = (threads: Thread[], at: string): Thread[] =>
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
  /** "Allow Durango Chat and Tasks to start agents on this Mac" (main: durango-dispatch.js). */
  dispatch: DurangoDispatchSettings;
  /** "Deploy changes landed elsewhere" (main: durango-deploy-watcher.js). */
  deployWatcher: DurangoDeployWatcherSettings;
};

export type DurangoDeployWatcherSettings = {
  /**
   * Off by default: deploys run on this Mac with its railway/convex/wrangler
   * logins, so turning it on is the user's call (and per Mac).
   */
  enabled: boolean;
};

export const defaultDurangoDeployWatcherSettings: DurangoDeployWatcherSettings = {
  enabled: false,
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
  /** Dispatched runs at a time on this Mac; null = no limit. */
  maxRunning: number | null;
};

export const defaultDurangoDispatchSettings: DurangoDispatchSettings = {
  enabled: false,
  allowedProjectIds: null,
  accessMode: 'read-only',
  modelId: null,
  maxRunning: null,
};

export const defaultDurangoSettings: DurangoSettings = {
  includeProfileMemory: false,
  useDurangoTasks: true,
  dispatch: defaultDurangoDispatchSettings,
  deployWatcher: defaultDurangoDeployWatcherSettings,
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

/**
 * SnapShot (macOS): a global trigger captures the window you're working in
 * and attaches it to the selected thread's draft. Main mirrors these to
 * userData/snapshot.json (src/main/snapshot.js) so the trigger is armed at
 * launch; normalizeSnapShotSettings there validates them.
 */
export type SnapShotSettings = {
  enabled: boolean;
  /** Also attach the window's accessibility outline (needs Accessibility). */
  includeAppText: boolean;
  shortcut:
    | { kind: 'modifier-pair'; modifier: 'shift' }
    | { kind: 'accelerator'; accelerator: string };
  /** Play the screenshot sound on capture. */
  sound: boolean;
};

export const defaultSnapShotSettings: SnapShotSettings = {
  enabled: false,
  includeAppText: true,
  shortcut: { kind: 'modifier-pair', modifier: 'shift' },
  sound: true,
};

/** Persisted (possibly older or hand-edited) SnapShot settings over the defaults. */
export const mergeSnapShotSettings = (value: unknown): SnapShotSettings => {
  const input = (value && typeof value === 'object' ? value : {}) as Partial<SnapShotSettings>;
  const shortcut = input.shortcut as Partial<{ kind: string; accelerator: unknown }> | undefined;
  return {
    enabled: input.enabled === true,
    includeAppText: input.includeAppText !== false,
    shortcut:
      shortcut?.kind === 'accelerator' && typeof shortcut.accelerator === 'string' && shortcut.accelerator
        ? { kind: 'accelerator', accelerator: shortcut.accelerator }
        : defaultSnapShotSettings.shortcut,
    sound: input.sound !== false,
  };
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

/** A page an agent showed with show_html (src/main/visual-tools.js). */
export type AgentVisual = {
  html: string;
  title: string;
  /** Fixed frame height in CSS pixels; absent = fit the content. */
  height?: number;
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
  /** An inline HTML page from show_html, rendered as its own block (HtmlVisual). */
  visual?: AgentVisual;
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
  /** Set on the files of a SnapShot (window capture): the image, and the
   * window's accessibility outline when app text was included. */
  snapshot?: SnapShotAttachmentInfo;
};

export type SnapShotAttachmentInfo = {
  kind: 'image' | 'accessibility';
  appName: string;
  windowTitle: string;
  bundleId?: string;
  truncated?: boolean;
};

/** What the user typed into a thread's composer but has not sent yet. */
export type ComposerDraft = {
  text: string;
  attachments: FileAttachment[];
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
  /** A user message steered into a running turn (⌘⏎): it doesn't start new work. */
  steer?: boolean;
};

// The run captions live with the shell summary that reads them (thread-shell.js).
export { STEERED_RUN_CAPTION, WAITING_ON_BACKGROUND_CAPTION };
export type { ThreadSummary };

export type QueuedMessage = {
  id: string;
  text: string;
  attachments?: FileAttachment[];
};

/**
 * A request_secret card: the agent waits for a value typed into a private
 * input. Only the request is kept here, never the value (the main process
 * writes it to an owner-only file and hands the agent the path).
 */
export type UserActionSecret = {
  label: string;
  /** What the agent will use it for and where to get it. */
  reason: string;
  placeholder?: string;
  /** file: saved to an owner-only file; ref: kept in memory for the agent's tools. */
  delivery?: 'file' | 'ref';
  /** When the agent stops waiting. */
  expiresAt: string;
};

/**
 * A `/btw` aside: a quick question answered by a read-only fork of the
 * thread's agent session. It has the thread's full context but never joins
 * the thread — the main session and transcript are untouched.
 */
export type UserAction = {
  /** Id the agent resolves it by (`ua_…`; `sr_…` for a secret request). */
  id: string;
  /** One instruction, as the agent wrote it (Markdown). */
  action: string;
  url?: string;
  requestedAt: string;
  /** Command that exits 0 once the action is done (request_user_action `check`). */
  check?: string;
  /** Where `check` runs: the agent's working directory. */
  checkCwd?: string;
  /**
   * Whether Durango Code runs `check` on a schedule. Starts on in Full
   * access; otherwise the user starts it from the card. Off again when the
   * watch gives up.
   */
  watching?: boolean;
  /** Set for request_secret: the card asks for the value instead of Done/Reply. */
  secret?: UserActionSecret;
};

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
  /**
   * What the shell knows about the transcript (thread-shell.js). Kept current
   * by the store's transcript actions; never stored in the thread file.
   */
  summary: ThreadSummary;
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
  /**
   * Started here by an agent on a paired machine (machine_run_agent): it is
   * that agent's subagent, listed to that machine under its thread there
   * and kept out of Recent here.
   */
  spawnedBy?: ThreadSpawnedBy;
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
  /** Kanban cards on the Orion web board driving/driven by this thread, in link order. */
  linkedTasks?: LinkedBoardTask[];
  /**
   * Things the agent asked the user to do outside the chat (request_user_action),
   * oldest first. While any is pending the thread reads as needing the user and
   * the actions stay pinned above the composer, until the agent or the user
   * resolves them.
   */
  userActions?: UserAction[];
  /**
   * Set when Durango started this thread (Phase 5 dispatch) or sent it a
   * follow-up. The outcome is reported back once that run settles.
   */
  durangoDispatch?: {
    id: string;
    sourceUrl: string | null;
    startedAt: string;
    /** Follow-up: agent runs the thread had before this one (absent = its first run). */
    runOffset?: number;
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
  /**
   * Set when the thread's agents run on another machine (remote control):
   * the prompt box sends its turns there and the transcript is a mirror of
   * that machine's copy. Absent = this machine.
   */
  remote?: ThreadRemote;
};

export type ThreadSpawnedBy = {
  /** The paired machine whose agent started it. */
  machineId: string;
  machineName: string;
  /** The thread on that machine whose agent started it. */
  threadId: string;
};

export type ThreadRemote = {
  /** The paired machine's id (remote control). */
  machineId: string;
  /** Its name when chosen, for the sidebar and the prompt box. */
  machineName: string;
  /** The thread's id on that machine; absent until its first turn starts there. */
  threadId?: string;
  /** The project on that machine the thread runs in. */
  projectId?: string;
  /** Its name there; shown when no project here matches it (filed under No project). */
  projectName?: string;
  /** Started on that machine and listed here from it (not from this machine's prompt box). */
  imported?: boolean;
  /** That machine's path of an attachment → this machine's copy, for showing the mirror. */
  attachmentPaths?: Record<string, string>;
  /**
   * The thread's agent settings as that machine last reported them (model,
   * access, effort). A turn sends only the settings changed here since.
   */
  hostSettings?: Partial<Record<string, string>>;
  /** Since when its agent waits there on a question or approval (sidebar "Needs you"). */
  needsInputSince?: string;
  /** Its title there when last seen: a rename here stands until it changes there. */
  hostTitle?: string;
};

/** One of a paired machine's threads, as remote:listThreads lists it. */
export type RemoteThreadListing = {
  id: string;
  projectId: string;
  title: string;
  status: Thread['status'];
  modelId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  summary?: ThreadSummary;
  settledAt?: string | null;
  hiddenFromRecent?: boolean;
  settings?: Record<string, string>;
  userActions?: UserAction[];
  waitingOnQuestion?: boolean;
  localProjectId: string | null;
  projectName: string | null;
  /** The thread here whose agent started it there (machine_run_agent): it shows as its subagent. */
  localParentThreadId?: string | null;
  /**
   * A subagent of one of that machine's threads: the parent's id there (not
   * here). It is listed under the parent's mirror, not in the sidebar.
   */
  parentThreadId?: string | null;
  /** A provider-native subagent there (read-only), and its type. */
  subagent?: boolean;
  subagentKind?: string;
};

/** What the other machine says the thread waits on the user for, as a mirror patch. */
export const remoteAttentionPatch = (
  current: Pick<Thread, 'userActions' | 'remote'>,
  userActions: UserAction[] | undefined,
  waitingOnQuestion: boolean
): Partial<Thread> => {
  const patch: Partial<Thread> = {};
  const next = userActions && userActions.length > 0 ? userActions : undefined;
  if (JSON.stringify(next ?? null) !== JSON.stringify(current.userActions ?? null)) patch.userActions = next;
  const since = current.remote?.needsInputSince;
  if (waitingOnQuestion !== Boolean(since) && current.remote) {
    patch.remote = { ...current.remote, needsInputSince: waitingOnQuestion ? new Date().toISOString() : undefined };
  }
  return patch;
};

const REMOTE_SETTING_KEYS = [
  'accessMode',
  'codexReasoningEffort',
  'codexServiceTier',
  'claudeReasoningEffort',
  'claudeContextWindow',
  'grokReasoningEffort',
  'museReasoningEffort',
  'openCodeReasoningEffort',
] as const;

// That machine's thread ids missing from its last listing, per machine: a
// mirror goes only when its thread is missing twice in a row, so one odd
// listing (a host mid-write) can't drop it.
const remoteMissingLastTime = new Map<string, Set<string>>();

// Whether that machine listed the thread's full summary. An older host, or
// one whose listing was too large to send whole (fitSnapshot), gives only its
// message count and last activity time.
const hasListedSummary = (entry: RemoteThreadListing) =>
  Boolean(entry.summary && typeof entry.summary === 'object' && Number.isSafeInteger(entry.summary.messageCount));

const remoteListingSummary = (entry: RemoteThreadListing): ThreadSummary => {
  if (hasListedSummary(entry)) return entry.summary!;
  // An older host lists counts and times only.
  return {
    ...summarizeThreadMessages([]),
    messageCount: entry.messageCount,
    lastMessage: entry.updatedAt ? { id: `remote:${entry.id}`, role: 'agent', ts: entry.updatedAt } : null,
    hasUserMessage: entry.messageCount > 0,
  };
};

// Whether summary `a` is of a later point in the thread than `b`: more
// messages, or a newer last message (sent or completed).
const summaryAhead = (a: ThreadSummary, b: ThreadSummary) => {
  if (a.messageCount !== b.messageCount) return a.messageCount > b.messageCount;
  const at = (summary: ThreadSummary) =>
    Math.max(Date.parse(summary.lastMessage?.ts ?? '') || 0, Date.parse(summary.lastMessage?.completedAt ?? '') || 0);
  return at(a) > at(b);
};

/**
 * The summary a listing gives a mirror here, or null to keep its own. A full
 * summary from that machine always counts. A count-and-time one only once
 * that machine has moved on, and it keeps the worked time and last run this
 * machine already knows (it has none of its own).
 */
// The id there of the thread `entry` is a subagent of, if any.
const remoteListingParentOf = (entry: RemoteThreadListing): string | null =>
  typeof entry.parentThreadId === 'string' && entry.parentThreadId && entry.parentThreadId !== entry.id
    ? entry.parentThreadId
    : null;

/**
 * A machine's listing with each thread after the thread it is a subagent of
 * (subagents can have subagents), so a parent's mirror exists before its
 * subagents are filed under it. Subagents of threads not in the listing (or
 * in a cycle) come last.
 */
export const remoteListingParentsFirst = (listed: RemoteThreadListing[]): RemoteThreadListing[] => {
  const valid = listed.filter((entry) => entry && typeof entry.id === 'string');
  const ordered: RemoteThreadListing[] = [];
  const placed = new Set<string>();
  let pending = valid;
  for (;;) {
    const next: RemoteThreadListing[] = [];
    for (const entry of pending) {
      const parentId = remoteListingParentOf(entry);
      if (!parentId || placed.has(parentId)) {
        ordered.push(entry);
        placed.add(entry.id);
      } else next.push(entry);
    }
    if (next.length === 0 || next.length === pending.length) return [...ordered, ...next];
    pending = next;
  }
};

const listedMirrorSummary = (entry: RemoteThreadListing, current: ThreadSummary): ThreadSummary | null => {
  const listed = remoteListingSummary(entry);
  if (hasListedSummary(entry)) return sameThreadSummary(listed, current) ? null : listed;
  if (listed.messageCount === current.messageCount && !summaryAhead(listed, current)) return null;
  return {
    ...listed,
    agentRunCount: Math.max(listed.agentRunCount, current.agentRunCount),
    lastAgentRun: current.lastAgentRun,
    workedMs: current.workedMs,
  };
};

/**
 * A thread's transcript. The store keeps every thread's shell (`Thread`) but
 * only some transcripts (`transcripts`): the open panes', running threads',
 * recently opened ones' and any with unsaved changes. The rest load from disk
 * on demand (ensureThreadTranscript).
 */
export type ThreadTranscript = {
  messages: Message[];
  /** `/btw` asides answered by session forks; rendered alongside the transcript, never part of it. */
  btwExchanges?: BtwExchange[];
};

/** A thread as stored on disk and exchanged whole: the shell's fields plus the transcript. */
export type ThreadRecord = Omit<Thread, 'summary'> & ThreadTranscript;

/** What the store sends main to persist (thread-storage.js writeThreadsPatch). */
export type ThreadsPatch = {
  version: 2;
  /** Whole threads: shell and transcript. */
  upserts: ThreadRecord[];
  /** Shell-only saves of threads whose transcript isn't loaded; main keeps the stored transcript. */
  shells: Array<Omit<Thread, 'summary'>>;
  deletes: string[];
  order?: string[];
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

export type ProviderId = 'grok' | 'codex' | 'claude' | 'cursor' | 'kimi' | 'fx' | 'muse' | 'opencode';

export type CodexSettingMode = 'inherit' | 'enabled' | 'disabled';
export type BrowserUseMode = 'disabled' | 'builtin' | 'extension' | 'mcp';
/** claude: built-in browser panel, Claude in Chrome (--chrome), or none. Others: builtin or off. */
export type ProviderBrowserMode = 'builtin' | 'chrome' | 'off';

export type BrowserSettings = {
  /** Open the browser panel when an agent of the focused thread opens a tab. */
  autoOpenPanel: boolean;
  /** Hold built-in browser downloads until the user clicks Save (like Chrome's "Ask where to save"). */
  askBeforeDownload: boolean;
};

export const defaultBrowserSettings: BrowserSettings = {
  autoOpenPanel: true,
  askBeforeDownload: true,
};

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
  /** legacy claude toggle for Claude in Chrome; `browser: 'chrome'` replaces it */
  chrome?: boolean;
  /** claude: builtin | chrome | off (default builtin); other non-Codex providers: builtin | off */
  browser?: ProviderBrowserMode;
  /** legacy codex browser toggle, retained for migration */
  browserControl?: boolean;
  /** legacy codex opt-in to attach MCP browser control to signed-in Chrome */
  browserAutoConnect?: boolean;
  /** codex: disabled, Durango Code's built-in browser (default), signed-in Chrome extension, or signed-in Chrome through chrome-devtools MCP */
  browserUseMode?: BrowserUseMode;
  /** fx: bill models without a connected subscription to Durango usage credits (default on) */
  fxDurangoInference?: boolean;
  /** fx: billed provider tried first when no subscription serves the model */
  fxBilledProvider?: 'durango' | 'gateway';
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
  fx: { enabled: true },
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

/**
 * A thread with `updates` applied, plus what a change of status brings with
 * it. Every status change goes through here (updateThread, and the listings
 * of threads that run on another machine), so a run that ends wakes and flags
 * a thread the same way wherever it ran.
 */
const withThreadUpdates = (
  state: { activeTab: 'agents' | 'code'; settingsOpen: boolean; paneThreadIds: string[] },
  t: Thread,
  updates: Partial<Thread>
): Thread => {
  const next = { ...t, ...updates };
  if (!updates.status || updates.status === t.status) return next;
  const onScreen = isAgentsPanelVisible(state) && state.paneThreadIds.includes(t.id);
  // A run that ends while the user is elsewhere leaves a dot in the sidebar
  // until the thread is opened; starting a new run (or finishing one in the
  // open thread) clears it again. Only a run that ran to completion counts —
  // a stop (-> idle) was deliberate, so it needs no follow-up marker.
  const ranToEnd = t.status === 'running' && (updates.status === 'done' || updates.status === 'error');
  next.finishedUnseenAt = ranToEnd && !onScreen ? new Date().toISOString() : undefined;
  // A snoozed thread wakes when its run ends: finished, or (on a failure)
  // needing the user. A stop was deliberate and keeps it snoozed. Questions
  // and approvals wake it too (App).
  if (t.snoozedAt && !('snoozedAt' in updates) && ranToEnd) {
    next.snoozedAt = undefined;
    // Already on screen: nothing to flag, it just rejoins the list.
    if (!onScreen) {
      next.wokeAt = new Date().toISOString();
      next.wokeReason = updates.status === 'error' ? 'attention' : 'finished';
    }
  }
  // New work in a settled thread brings it back to the sidebar.
  if (t.settledAt && updates.status === 'running' && !('settledAt' in updates)) {
    next.settledAt = undefined;
  }
  return next;
};

interface OrionState {
  // Tabs
  activeTab: 'agents' | 'code';
  /** Settings replaces the main content, so panes remain mounted in state but are not visible. */
  settingsOpen: boolean;

  // Projects & Threads
  projects: Project[];
  /** The No project pseudo-project, once its scratch directory is known. */
  noProject: Project | null;
  /** Every thread's shell, in stored order. Streaming output never replaces these. */
  threads: Thread[];
  /**
   * Loaded transcripts by thread id (see ThreadTranscript). Read one with
   * `state.transcripts[id]`; load one with ensureThreadTranscript.
   */
  transcripts: Record<string, ThreadTranscript>;
  selectedProjectId: string | null;
  selectedThreadId: string | null;
  /**
   * Threads currently shown in the main view, left-to-right / top-to-bottom.
   * The split view renders one pane per entry and `selectedThreadId` is the
   * focused one — it is always a member of this list, or null when it's empty.
   */
  paneThreadIds: string[];

  /**
   * Unsent composer text and attachments by thread id, so a restart brings
   * them back. Only non-empty drafts are kept. They live here rather than on
   * the thread so typing doesn't churn `threads` (and every transcript save)
   * on each keystroke.
   */
  composerDrafts: Record<string, ComposerDraft>;

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
  snapShotSettings: SnapShotSettings;
  deploymentSettings: DeploymentSettings;
  sidebarV2Settings: SidebarV2Settings;
  browserSettings: BrowserSettings;
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
  importThreads: (input: { projects: Project[]; threads: ThreadRecord[] }) => void;
  /**
   * List a paired machine's threads here, like this machine's own: add a
   * mirror for each new one, keep the rest current, and drop the mirrors of
   * threads that machine no longer has. `skip` = mirrors kept current one by
   * one (open or running: useRemoteThreadSync); `dismissed` = that machine's
   * thread ids deleted here.
   */
  syncRemoteMachineThreads: (
    machine: { id: string; name: string },
    listed: RemoteThreadListing[],
    options: { skip: Set<string>; dismissed: Set<string> }
  ) => void;
  removeProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;

  setDurangoWorkspaceSettings: (updates: Partial<DurangoWorkspaceSettings>) => void;
  setWorkspaceSyncSettings: (updates: Partial<WorkspaceSyncSettings>) => void;
  setDurangoSettings: (updates: Partial<DurangoSettings>) => void;
  setRemoteControlSettings: (updates: Partial<RemoteControlSettings>) => void;
  setSnapShotSettings: (updates: Partial<SnapShotSettings>) => void;
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
      /** Started by an agent on a paired machine (machine_run_agent). */
      spawnedBy?: ThreadSpawnedBy;
    }
  ) => string; // returns new thread id
  /**
   * Copies a thread (and its settled subagents) into a new one. Loads the
   * transcripts it copies first; resolves to the new thread id.
   */
  branchThread: (sourceThreadId: string) => Promise<string | null>;
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
  setBrowserSettings: (updates: Partial<BrowserSettings>) => void;
  updateThread: (id: string, updates: Partial<Omit<Thread, 'id' | 'summary'>>) => void;
  /**
   * Replace a thread's transcript with `recipe(transcript)`. When it isn't
   * loaded the change waits for it (loading it now), so it is never lost.
   */
  updateThreadTranscript: (threadId: string, recipe: (transcript: ThreadTranscript) => ThreadTranscript) => void;
  /** Remember (or, when empty, forget) a thread's unsent composer draft. */
  setComposerDraft: (threadId: string, draft: ComposerDraft) => void;
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
const ORION_STORE_NAME = 'orion-storage';

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

// State kept outside the store that must reach it before the unload-time
// synchronous write below (the composer's debounced draft). Window listeners
// for the same event run in registration order, and this module registers
// first, so a later beforeunload listener would be too late.
const beforeUnloadStoreFlushes = new Set<() => void>();
export const flushIntoStoreBeforeUnload = (flush: () => void) => {
  beforeUnloadStoreFlushes.add(flush);
  return () => {
    beforeUnloadStoreFlushes.delete(flush);
  };
};

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    for (const flush of beforeUnloadStoreFlushes) {
      try {
        flush();
      } catch (error) {
        console.warn('Failed to flush into orion-storage on unload', error);
      }
    }
    // Like the threads flush below: an async save started here races app
    // teardown, and the store carries unsent composer drafts typed (or
    // cleared by a send) moments before quitting. Block on a synchronous
    // write of the newest snapshot when one isn't known to be on disk.
    const unsaved = pendingStoreValue !== null || storeSaveFlush !== null;
    const latest = memoryStorage.get(ORION_STORE_NAME);
    if (unsaved && latest !== undefined && window.orion?.saveStoreSync) {
      if (storeSaveTimer !== null) {
        clearTimeout(storeSaveTimer);
        storeSaveTimer = null;
      }
      try {
        if (window.orion.saveStoreSync(latest)) {
          pendingStoreValue = null;
          return;
        }
      } catch (error) {
        console.warn('Failed to persist orion-storage on unload', error);
      }
    }
    void flushOrionStoreSave();
  });
}

// Threads are excluded from the persisted store above and live in sharded
// storage (main/thread-storage.js) on a slower save cadence — see the saver
// below the store definition.
//
// Memory model: the store holds every thread's shell (`threads`) and only some
// transcripts (`transcripts`). Startup reads the shells from the storage
// manifest plus the open panes' transcripts; any other transcript loads when
// something needs it (ensureThreadTranscript): opening it, an agent event or
// store action for it, or code that reads it (branching, review context…).
// Transcripts nothing needs any more are dropped again (evictTranscripts),
// never while they have unsaved changes.
//
// Saving is patch-based: whole threads whose transcript changed, shell-only
// saves for the rest (main keeps the stored transcript, so a thread whose
// transcript isn't loaded is never written without its messages), explicit
// deletes, and the order when it changed.
let threadsSaveTimer: ReturnType<typeof setTimeout> | null = null;
let threadsSaveFlush: Promise<boolean> | null = null;
// Thread ids whose transcript changed since it was last handed to main.
const dirtyTranscripts = new Set<string>();
// Thread ids whose shell changed since then (whole-thread saves cover both).
const dirtyShells = new Set<string>();
const pendingThreadDeletes = new Set<string>();
let pendingThreadOrder = false;
type InFlightThreadsSave = { transcriptIds: Set<string>; shellIds: Set<string>; deletes: Set<string> };
let threadsInFlight: InFlightThreadsSave | null = null;
let loadedThreadsFromStorage = false;
// The threads reference at clearStorage time: zustand clears storage without
// clearing in-memory state, so the savers must not write this exact snapshot
// back to disk. A later thread change (fresh reference) resumes persistence.
let clearedThreadsSnapshot: Thread[] | null = null;
// Set when the threads storage exists but could not be read: the hydrated
// state then lacks the real threads, and any flush would overwrite the
// (possibly recoverable) files with that lesser snapshot. All thread
// persistence stays suppressed until an explicit clearStorage.
let threadsPersistenceBlocked = false;

const cancelQueuedThreadsSave = () => {
  if (threadsSaveTimer !== null) {
    clearTimeout(threadsSaveTimer);
    threadsSaveTimer = null;
  }
};

type PersistedThreadShells = { version: 2; present: boolean; shells: Thread[]; threads: ThreadRecord[] };
type PersistedThreadsBatch = { version: 2; consumed: number; threads: ThreadRecord[] };

const THREADS_BATCH_BYTES = 8 * 1024 * 1024;

const threadsCompleteListeners = new Set<() => void>();

/**
 * True once every stored thread's shell is in the store. Shells all load with
 * hydration, so this is hydration itself (kept for the startup tasks that
 * must see every thread).
 */
export const allThreadsLoaded = () => useOrionStore.persist.hasHydrated();
/** Runs `listener` once every stored thread's shell is in the store; returns an unsubscribe. */
export const onAllThreadsLoaded = (listener: () => void) => {
  if (allThreadsLoaded()) {
    listener();
    return () => {};
  }
  threadsCompleteListeners.add(listener);
  return () => {
    threadsCompleteListeners.delete(listener);
  };
};
const notifyAllThreadsLoaded = () => {
  for (const listener of [...threadsCompleteListeners]) {
    threadsCompleteListeners.delete(listener);
    listener();
  }
};

// The panes the first frame shows: their transcripts come with the shells.
const paneThreadIdsNamedByStore = (state: Record<string, unknown>) => {
  const ids = new Set<string>();
  if (typeof state.selectedThreadId === 'string') ids.add(state.selectedThreadId);
  if (Array.isArray(state.paneThreadIds)) {
    for (const id of state.paneThreadIds) if (typeof id === 'string') ids.add(id);
  }
  return [...ids];
};

const parseStorageValue = (value: string | null) =>
  value === null ? null : (JSON.parse(value) as StorageValue<unknown>);

// Graft the separately persisted threads into the persisted state so the
// persist middleware — including its crash-recovery merge — sees one combined
// snapshot: every shell, and the transcripts of the panes that will be on
// screen. With no threads directory yet (pre-split builds), the store value's
// own embedded threads are used as-is and the first threads save migrates
// them out.
const withThreadsGrafted = async (value: string | null): Promise<StorageValue<unknown> | null> => {
  if (!window.orion.loadThreadShells) return parseStorageValue(value);
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
    // transcripts are not. Rebuild a minimal envelope rather than letting
    // hydration flush an empty thread list over the valid threads files.
    parsed = { state: {}, version: 1 };
  }
  try {
    const result = await window.orion.loadThreadShells({ ids: paneThreadIdsNamedByStore(parsed.state) });
    if (!result?.ok || typeof result.value !== 'string') throw new Error('Thread shells read failed.');
    const stored = JSON.parse(result.value) as PersistedThreadShells;
    if (
      stored?.version !== 2 ||
      typeof stored.present !== 'boolean' ||
      !Array.isArray(stored.shells) ||
      !Array.isArray(stored.threads)
    ) {
      throw new Error('Invalid thread shells response.');
    }
    if (!stored.present) return parseStorageValue(value);
    loadedThreadsFromStorage = true;
    const transcripts: Record<string, ThreadTranscript> = {};
    const records = new Map<string, ThreadRecord>();
    for (const record of stored.threads) {
      transcripts[record.id] = transcriptOfRecord(record);
      records.set(record.id, record);
    }
    // The manifest's shells leave out subagent prompts and reports; the
    // threads that arrive whole put them back, so a whole-thread save (or a
    // branch) of an open pane keeps them.
    const shells = records.size === 0 ? stored.shells : stored.shells.map((shell) => {
      const record = records.get(shell.id);
      return record ? withStoredSubagentDetails(shell, record) : shell;
    });
    parsed.state = { ...parsed.state, threads: shells, transcripts };
    return parsed;
  } catch (error) {
    console.error('Failed to hydrate Orion threads', error);
    // Hydrating without the real threads is survivable, but persisting over
    // them is not.
    threadsPersistenceBlocked = true;
    return parseStorageValue(value);
  }
};

// Persisting the settings envelope costs a partialize and a stringify; skip
// both when no persisted field changed (streaming output changes none).
let lastPersistedState: unknown = null;

// Objects in, objects out: zustand's createJSONStorage would make the
// grafted transcripts take a stringify and a second parse on every launch.
const orionStorage: PersistStorage<unknown> = {
  getItem: async (name) => {
    if (typeof window === 'undefined' || !window.orion?.loadStore) {
      return parseStorageValue(memoryStorage.get(name) ?? null);
    }

    const stored = await window.orion.loadStore();
    if (stored !== null) memoryStorage.set(name, stored);
    const value = await withThreadsGrafted(stored);
    if (value !== null) return value;

    const legacyValue = window.localStorage.getItem(name);
    if (legacyValue !== null) {
      memoryStorage.set(name, legacyValue);
      await window.orion.saveStore(legacyValue);
      return parseStorageValue(legacyValue);
    }

    return null;
  },
  setItem: async (name, storageValue) => {
    // partialize returns the same object while nothing it reads changed.
    if (storageValue.state === lastPersistedState) return;
    lastPersistedState = storageValue.state;
    const value = JSON.stringify(storageValue);
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
    // lastPersistedState stays: the in-memory state survives the clear, and
    // only a change to it may write the store file again.
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
    dirtyTranscripts.clear();
    dirtyShells.clear();
    pendingThreadDeletes.clear();
    pendingThreadOrder = false;
    // An explicit clear discards whatever unreadable storage blocked
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

// ---------------------------------------------------------------------------
// Shells and transcripts.

/** The transcript part of a stored thread. */
export const transcriptOfRecord = (record: Pick<ThreadRecord, 'messages' | 'btwExchanges'>): ThreadTranscript => {
  const messages = Array.isArray(record.messages) ? record.messages : [];
  return Array.isArray(record.btwExchanges) ? { messages, btwExchanges: record.btwExchanges } : { messages };
};

/** The shell of a stored thread, with its summary computed from the transcript. */
export const shellOfRecord = (record: ThreadRecord): Thread =>
  ({ ...threadShellOf(record), summary: summarizeThreadMessages(record.messages) }) as Thread;

/** `shell` with the subagent details its light manifest copy left out, from the stored thread. */
const withStoredSubagentDetails = (shell: Thread, record: ThreadRecord): Thread => {
  let next = shell;
  if (next.subagent) {
    const subagent = withSubagentDetails(next.subagent, record.subagent);
    if (subagent !== next.subagent) next = { ...next, subagent };
  }
  if (next.inheritedSubagent) {
    const inheritedSubagent = withSubagentDetails(next.inheritedSubagent, record.inheritedSubagent);
    if (inheritedSubagent !== next.inheritedSubagent) next = { ...next, inheritedSubagent };
  }
  return next;
};

/** A whole thread from its shell and transcript (what main stores). */
export const threadRecordOf = (shell: Thread, transcript: ThreadTranscript): ThreadRecord => {
  const { summary: _summary, ...fields } = shell;
  return {
    ...fields,
    messages: transcript.messages,
    ...(transcript.btwExchanges ? { btwExchanges: transcript.btwExchanges } : {}),
  };
};

// Thread lookups by id, built once per `threads` array (which only changes
// when a shell does), so per-update selectors don't scan every thread.
const threadIndexCache = new WeakMap<Thread[], Map<string, number>>();
const threadIndexById = (threads: Thread[]) => {
  let index = threadIndexCache.get(threads);
  if (!index) {
    index = new Map();
    for (let i = 0; i < threads.length; i += 1) index.set(threads[i].id, i);
    threadIndexCache.set(threads, index);
  }
  return index;
};

/** The thread with this id, in O(1) for a `threads` array already looked up once. */
export const findThread = (threads: Thread[], id: string | null | undefined): Thread | undefined => {
  if (!id) return undefined;
  const index = threadIndexById(threads).get(id);
  return index === undefined ? undefined : threads[index];
};

const replaceThreadAt = (threads: Thread[], index: number, thread: Thread) => {
  const next = threads.slice();
  next[index] = thread;
  // The ids and positions are unchanged: reuse the index.
  const index_ = threadIndexCache.get(threads);
  if (index_) threadIndexCache.set(next, index_);
  return next;
};

/** The thread with this id plus its transcript, when the transcript is loaded. */
export const getThreadRecord = (threadId: string): ThreadRecord | undefined => {
  const state = useOrionStore.getState();
  const shell = findThread(state.threads, threadId);
  const transcript = state.transcripts[threadId];
  return shell && transcript ? threadRecordOf(shell, transcript) : undefined;
};

// Store actions that change a transcript which isn't loaded wait here, in
// order, and run on it as soon as it has loaded (ensureThreadTranscript).
type TranscriptRecipe = (transcript: ThreadTranscript) => ThreadTranscript;
const pendingTranscriptOps = new Map<string, TranscriptRecipe[]>();

// Threads that were running when the previous session ended: their stored
// transcripts still say so and are corrected when they load.
const interruptedAtStartup = new Set<string>();
// Transcripts written by this session reflect it; only older ones need the
// previous-session cleanup when they load.
const transcriptsWrittenThisSession = new Set<string>();
let sessionStartedAt = new Date().toISOString();

// Threads and their user messages used to hold at most one board task in a
// `linkedTask` field; both now hold a `linkedTasks` list. Rewrite the legacy
// shape so old transcripts keep their chips and their board link.
type LegacyLinkedTaskMessage = Message & {
  linkedTask?: Pick<LinkedBoardTask, 'id' | 'title' | 'description'>;
};

const migrateLegacyLinkedTaskShell = (thread: Thread): Thread => {
  const legacy = thread as Thread & { linkedTask?: LinkedBoardTask };
  if (!legacy.linkedTask || legacy.linkedTasks) return thread;
  const { linkedTask, ...rest } = legacy;
  return { ...rest, linkedTasks: [linkedTask] };
};

const migrateLegacyLinkedTaskMessages = (messages: Message[]): Message[] => {
  const legacy = messages as LegacyLinkedTaskMessage[];
  if (!legacy.some((message) => message.linkedTask && !message.linkedTasks)) return messages;
  return legacy.map((message) => {
    if (!message.linkedTask || message.linkedTasks) return message;
    const { linkedTask, ...rest } = message;
    return { ...rest, linkedTasks: [linkedTask] };
  });
};

// Agent runs can't survive an app restart — the CLI processes die with the
// app — so any thread rehydrated as 'running' is a leftover from the
// previous session. Left alone it pins the run status bar forever, because
// the run-event handler only flips messages tracked by runs started in this
// session. Its transcript is corrected when it loads
// (restoreTranscriptFromPreviousRun).
const restoreShellFromPreviousRun = (input: Thread): Thread => {
  // Threads used to carry a single board task; they now carry a list.
  let thread = migrateLegacyLinkedTaskShell(input);
  // Epics were removed; drop the grouping older builds persisted.
  if ('epicId' in thread) {
    const { epicId: _epicId, ...rest } = thread as Thread & { epicId?: unknown };
    thread = rest;
  }
  if (!thread.summary) thread = { ...thread, summary: summarizeThreadMessages([]) };
  // A thread running on another machine kept running there: its mirror is
  // brought up to date from that machine (useRemoteThreadSync), not here.
  if (thread.remote) return thread;
  // A summary stored while a run was going still counts it as running (the
  // sidebar's "Worked" time would keep growing); its transcript says
  // 'stopped' once loaded.
  const { summary } = thread;
  if (
    summary.runningRunStarts.length > 0 ||
    summary.lastMessage?.status === 'running' ||
    summary.lastAgentRun?.status === 'running'
  ) {
    thread = {
      ...thread,
      summary: {
        ...summary,
        runningRunStarts: [],
        lastMessage:
          summary.lastMessage?.status === 'running' ? { ...summary.lastMessage, status: 'stopped' } : summary.lastMessage,
        lastAgentRun:
          summary.lastAgentRun?.status === 'running' ? { ...summary.lastAgentRun, status: 'stopped' } : summary.lastAgentRun,
      },
    };
  }
  if (thread.status !== 'running') return thread;
  interruptedAtStartup.add(thread.id);
  return { ...thread, status: 'idle' };
};

// The transcript side of the cleanup above, run once per stored transcript
// this session loads (and never on one it has written).
//
// A Claude turn can finish while its background tasks keep working: the
// message persists as 'done' captioned "Waiting on … background task(s) …"
// (waitingOnBackgroundStatusText in App.tsx — keep this pattern in sync) with
// the thread 'running'. Those tasks died with the app, so the wait can never
// settle — rewrite the caption alongside the status flip. Only while the
// thread was still 'running', though: every resolution path (a
// background-settled event or the synthetic follow-up turn finishing) flips
// the thread off 'running' but leaves the old caption behind as history, and
// history must not be rebranded as a restart casualty. The first alternation
// of the pattern matches captions persisted by older builds ("Waiting on N
// background agents…").
const restoreTranscriptFromPreviousRun = (
  transcript: ThreadTranscript,
  wasRunning: boolean,
  restartedAt: string
): ThreadTranscript => {
  let result = transcript;
  const migrated = migrateLegacyLinkedTaskMessages(transcript.messages);
  if (migrated !== transcript.messages) result = { ...result, messages: migrated };
  const stale = wasRunning || result.messages.some((message) => message.status === 'running');
  if (stale) {
    // Only a currently live wait may be rebranded. Every resolution path (a
    // background-settled event or a synthetic follow-up turn) appends a newer
    // agent-run message after the waiting one, while a resolved wait can
    // keep its historical "Waiting on …" caption. So the wait is live only
    // when the thread's newest agent-run message is the one carrying the
    // caption; a captioned message behind a newer turn — including the
    // running foreground or synthetic turn that made this thread 'running' —
    // is history from a wait that already resolved and must not be relabeled
    // as a restart casualty.
    const lastAgentRun = wasRunning
      ? [...result.messages].reverse().find((message) => message.kind === 'agent-run')
      : undefined;
    const liveWaitId =
      lastAgentRun &&
      lastAgentRun.status !== 'running' &&
      lastAgentRun.statusText != null &&
      WAITING_ON_BACKGROUND_CAPTION.test(lastAgentRun.statusText)
        ? lastAgentRun.id
        : undefined;
    let changed = false;
    const messages = result.messages.map((message) => {
      if (
        message.kind === 'claude-background-intervention' &&
        message.claudeBackgroundIntervention &&
        (message.claudeBackgroundIntervention.status === 'pending' ||
          message.claudeBackgroundIntervention.status === 'stopping')
      ) {
        changed = true;
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
        changed = true;
        return {
          ...message,
          status: 'stopped' as const,
          completedAt: message.completedAt ?? restartedAt,
          statusText: 'Interrupted by app restart.',
        };
      }
      if (message.id === liveWaitId) {
        changed = true;
        return {
          ...message,
          statusText: 'Background tasks interrupted by app restart.',
        };
      }
      return message;
    });
    if (changed) result = { ...result, messages };
  }
  // A /btw aside can't outlive the app either.
  if (result.btwExchanges?.some((exchange) => exchange.status === 'running')) {
    result = {
      ...result,
      btwExchanges: result.btwExchanges.map((exchange) =>
        exchange.status === 'running'
          ? { ...exchange, status: 'error' as const, error: 'Interrupted before Durango Code received the answer.' }
          : exchange
      ),
    };
  }
  return result;
};

/**
 * The state change for `recipe` applied to one thread's transcript, with the
 * shell's summary (and `shellPatch`) updated only when they actually change,
 * so streaming output leaves `threads` — and everything that lists threads —
 * untouched. A transcript that isn't loaded gets the recipe once it is.
 */
const transcriptChange = (
  state: Pick<OrionState, 'threads' | 'transcripts'>,
  threadId: string,
  recipe: TranscriptRecipe,
  options: { summary?: boolean; shellPatch?: (shell: Thread) => Partial<Thread> } = {}
): Partial<OrionState> => {
  const index = threadIndexById(state.threads).get(threadId);
  if (index === undefined) return {};
  const shell = state.threads[index];
  let nextShell = shell;
  if (options.shellPatch) {
    const patch = options.shellPatch(shell);
    if (Object.entries(patch).some(([key, value]) => shell[key as keyof Thread] !== value)) {
      nextShell = { ...shell, ...patch };
    }
  }
  const transcript = state.transcripts[threadId];
  let nextTranscript = transcript;
  if (!transcript) {
    const queue = pendingTranscriptOps.get(threadId);
    if (queue) queue.push(recipe);
    else pendingTranscriptOps.set(threadId, [recipe]);
    // Outside the update that queued it.
    queueMicrotask(() => {
      void ensureThreadTranscript(threadId).catch((error) =>
        console.warn('Could not load an Orion thread transcript', error)
      );
    });
  } else {
    nextTranscript = recipe(transcript);
    if (nextTranscript !== transcript && options.summary !== false) {
      const summary = summarizeThreadMessages(nextTranscript.messages);
      if (!sameThreadSummary(summary, shell.summary)) nextShell = { ...nextShell, summary };
    }
  }
  const result: Partial<OrionState> = {};
  if (nextTranscript !== transcript) result.transcripts = { ...state.transcripts, [threadId]: nextTranscript };
  if (nextShell !== shell) result.threads = replaceThreadAt(state.threads, index, nextShell);
  return result;
};

const mapMessage = (
  transcript: ThreadTranscript,
  messageId: string,
  update: (message: Message) => Message
): ThreadTranscript => {
  const index = transcript.messages.findIndex((message) => message.id === messageId);
  if (index === -1) return transcript;
  const current = transcript.messages[index];
  const next = update(current);
  if (next === current) return transcript;
  const messages = transcript.messages.slice();
  messages[index] = next;
  return { ...transcript, messages };
};

// Message fields the shell summary reads; other updates skip recomputing it.
const SUMMARY_MESSAGE_FIELDS = new Set(['status', 'completedAt', 'startedAt', 'ts', 'kind', 'role', 'stats', 'statusText', 'steer']);

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

// What the store file persists (everything but threads and transcripts),
// memoized on the fields it reads: see `partialize` below.
const PERSISTED_SOURCE_KEYS = [
  'activeSavedViewId',
  'activeTab',
  'appearanceSettings',
  'browserSettings',
  'composerDrafts',
  'deploymentSettings',
  'durangoSettings',
  'durangoWorkspaceSettings',
  'expandedProjects',
  'noProject',
  'notificationSettings',
  'orchestrationSettings',
  'paneThreadIds',
  'projects',
  'providerSettings',
  'remoteControlSettings',
  'savedViews',
  'selectedProjectId',
  'selectedThreadId',
  'sidebarV2Settings',
  'snapShotSettings',
  'splitViewSettings',
  'textGenerationSettings',
  'workspacePath',
  'workspaceSyncSettings',
] as const;
let persistedSource: OrionState | null = null;
let persistedSettings: unknown = null;
const persistedSettingsOf = (state: OrionState) => {
  if (persistedSource && PERSISTED_SOURCE_KEYS.every((key) => persistedSource![key] === state[key])) {
    return persistedSettings;
  }
  persistedSource = state;
  persistedSettings = buildPersistedSettings(state);
  return persistedSettings;
};
const buildPersistedSettings = (state: OrionState) => ({
        activeTab: state.activeTab,
        projects: state.projects,
        noProject: state.noProject,
        selectedProjectId: state.selectedProjectId,
        selectedThreadId: state.selectedThreadId,
        paneThreadIds: state.paneThreadIds,
        composerDrafts: state.composerDrafts,
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
        snapShotSettings: mergeSnapShotSettings(state.snapShotSettings),
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
        browserSettings: { ...defaultBrowserSettings, ...state.browserSettings },
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
      });

export const useOrionStore = create<OrionState>()(
  persist(
    (set, get) => ({
      activeTab: 'agents',
      settingsOpen: false,
      projects: [],
      noProject: null,
      threads: [],
      transcripts: {},
      selectedProjectId: null,
      selectedThreadId: null,
      paneThreadIds: [],
      composerDrafts: {},
      savedViews: [],
      activeSavedViewId: null,
      splitViewSettings: defaultSplitViewSettings,
      durangoWorkspaceSettings: defaultDurangoWorkspaceSettings,
      workspaceSyncSettings: defaultWorkspaceSyncSettings,
      durangoSettings: defaultDurangoSettings,
      remoteControlSettings: defaultRemoteControlSettings,
      snapShotSettings: defaultSnapShotSettings,
      deploymentSettings: defaultDeploymentSettings,
      sidebarV2Settings: defaultSidebarV2Settings,
      browserSettings: defaultBrowserSettings,
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
          const known = threadIndexById(state.threads);
          const newThreads = threads.filter((thread) => !known.has(thread.id));
          // Imported transcripts arrive whole; they stay loaded until saved.
          const transcripts = newThreads.length > 0 ? { ...state.transcripts } : state.transcripts;
          for (const thread of newThreads) transcripts[thread.id] = transcriptOfRecord(thread);
          return {
            // The sidebar orders projects and threads by activity, so imported
            // history lands in its chronological place wherever it's appended.
            projects: [...state.projects, ...newProjects],
            threads: [...state.threads, ...newThreads.map(shellOfRecord)],
            transcripts,
          };
        });
      },
      syncRemoteMachineThreads: (machine, listed, { skip, dismissed }) => {
        const removed: string[] = [];
        set((state) => {
          const mirrors = new Map<string, number>();
          state.threads.forEach((thread, index) => {
            if (thread.remote?.machineId === machine.id && thread.remote.threadId) {
              mirrors.set(thread.remote.threadId, index);
            }
          });
          let threads = state.threads;
          const write = (index: number, next: Thread) => {
            if (threads === state.threads) threads = [...state.threads];
            threads[index] = next;
          };
          const added: Thread[] = [];
          const listedIds = new Set<string>();
          // Started there by an agent here (machine_run_agent): that agent's
          // thread is its parent, so it shows among the thread's subagents
          // and not in the sidebar. Only while that thread is still here.
          const localIds = new Set(state.threads.map((thread) => thread.id));
          const localParentOf = (entry: RemoteThreadListing) =>
            typeof entry.localParentThreadId === 'string' && localIds.has(entry.localParentThreadId)
              ? entry.localParentThreadId
              : undefined;
          // A subagent of a thread there goes under that thread's mirror
          // here (in its subagent switcher, not the sidebar), so parents are
          // handled before their subagents. `mirrorOf`: a thread's mirror
          // here by its id there, those added below included.
          const mirrorOf = new Map<string, Thread>();
          for (const [hostId, index] of mirrors) mirrorOf.set(hostId, state.threads[index]);
          for (const entry of remoteListingParentsFirst(listed)) {
            listedIds.add(entry.id);
            const hostParentId = remoteListingParentOf(entry);
            const parentMirror = hostParentId ? mirrorOf.get(hostParentId) : undefined;
            // Its parent isn't listed here (deleted here, a draft there):
            // neither is it.
            if (hostParentId && !parentMirror) continue;
            const nativeSubagent =
              parentMirror && entry.subagent
                ? {
                    id: entry.id,
                    providerId: (entry.modelId?.split(':')[0] || 'claude') as ProviderId,
                    ...(entry.subagentKind ? { kind: entry.subagentKind } : {}),
                  }
                : undefined;
            const index = mirrors.get(entry.id);
            if (index !== undefined) {
              const current = threads[index];
              if (skip.has(current.id)) continue;
              const patch: Partial<Thread> = {};
              // A subagent there follows its parent's mirror here (which may
              // have been replaced since: a duplicate dropped after a turn
              // started from here).
              if (parentMirror && current.parentThreadId !== parentMirror.id && parentMirror.id !== current.id) {
                patch.parentThreadId = parentMirror.id;
              }
              const parentThreadId = localParentOf(entry);
              if (!parentMirror && parentThreadId && !current.parentThreadId && parentThreadId !== current.id) {
                patch.parentThreadId = parentThreadId;
              }
              if (nativeSubagent && !current.subagent) patch.subagent = nativeSubagent;
              // A rename here stands until that machine renames it.
              if (
                entry.title &&
                entry.title !== current.title &&
                entry.title !== current.remote?.hostTitle &&
                !/^Thread \d{1,2}:\d{2}/i.test(entry.title)
              ) {
                patch.title = entry.title;
              }
              if (entry.status && entry.status !== current.status) patch.status = entry.status;
              // That machine's summary places the row (and says how long it
              // has worked). A loaded transcript here is only a cache of that
              // machine's: it isn't open (open ones are skipped), so it may
              // be behind, and it is fetched again when the thread opens.
              const summary = listedMirrorSummary(entry, current.summary);
              if (summary) patch.summary = summary;
              // That machine's settings for the thread, unless changed here.
              const hostSettings = remoteSettingsOf({ ...entry.settings, modelId: entry.modelId });
              const adopted = adoptRemoteSettings(current, hostSettings);
              Object.assign(patch, adopted.patch);
              const sameKnown =
                JSON.stringify(adopted.hostSettings) === JSON.stringify(current.remote?.hostSettings ?? {});
              if (current.remote?.machineName !== machine.name || !sameKnown || current.remote?.hostTitle !== entry.title) {
                patch.remote = {
                  ...current.remote!,
                  machineName: machine.name,
                  hostSettings: adopted.hostSettings,
                  ...(entry.title ? { hostTitle: entry.title } : {}),
                };
              }
              // What it waits on the user for there (actions, questions).
              if (Array.isArray(entry.userActions) || typeof entry.waitingOnQuestion === 'boolean' || current.userActions) {
                const attention = remoteAttentionPatch(
                  { userActions: current.userActions, remote: patch.remote ?? current.remote },
                  entry.userActions,
                  entry.waitingOnQuestion === true
                );
                if ('userActions' in attention) patch.userActions = attention.userActions;
                if (attention.remote) patch.remote = attention.remote;
              }
              // A run that ended there wakes and flags the thread here like
              // one that ran here.
              if (Object.keys(patch).length > 0) write(index, withThreadUpdates(state, current, patch));
              continue;
            }
            // That machine's untouched drafts stay there; so do threads
            // deleted here. (A subagent there is listed from its start.)
            if ((entry.messageCount === 0 && !parentMirror) || dismissed.has(entry.id)) continue;
            const settings = Object.fromEntries(
              REMOTE_SETTING_KEYS.filter((key) => typeof entry.settings?.[key] === 'string').map((key) => [
                key,
                entry.settings![key],
              ])
            ) as Partial<Thread>;
            const shell = {
              // An older host doesn't list settings; nothing here is sent
              // unless changed here (hostSettings below), and opening the
              // thread brings that machine's values.
              accessMode: 'read-only' as const,
              ...settings,
              id: crypto.randomUUID(),
              projectId: parentMirror?.projectId ?? entry.localProjectId ?? NO_PROJECT_ID,
              title: entry.title || 'Thread',
              status: entry.status ?? 'idle',
              modelId: entry.modelId,
              createdAt: entry.createdAt,
              summary: remoteListingSummary(entry),
              ...(entry.settledAt ? { settledAt: entry.settledAt } : {}),
              ...(entry.hiddenFromRecent || parentMirror ? { hiddenFromRecent: true } : {}),
              ...(parentMirror
                ? { parentThreadId: parentMirror.id }
                : localParentOf(entry)
                  ? { parentThreadId: localParentOf(entry) }
                  : {}),
              ...(nativeSubagent ? { subagent: nativeSubagent } : {}),
              ...(entry.userActions?.length ? { userActions: entry.userActions } : {}),
              remote: {
                machineId: machine.id,
                machineName: machine.name,
                threadId: entry.id,
                projectId: entry.projectId,
                ...(entry.projectName ? { projectName: entry.projectName } : {}),
                ...(entry.waitingOnQuestion ? { needsInputSince: new Date().toISOString() } : {}),
                ...(entry.title ? { hostTitle: entry.title } : {}),
                imported: true,
              },
            } satisfies Thread;
            const mirror = { ...shell, remote: { ...shell.remote, hostSettings: remoteSettingsOf(shell) } };
            added.push(mirror);
            mirrorOf.set(entry.id, mirror);
          }
          // A thread that machine deleted goes here too, unless it is open or
          // running (kept current one by one) or was started from here. An
          // empty listing is more likely a failed read than a machine with
          // no threads left: it removes nothing.
          const missingBefore = remoteMissingLastTime.get(machine.id) ?? new Set<string>();
          const missingNow = new Set<string>();
          if (listedIds.size > 0) {
            for (const [hostId, index] of mirrors) {
              const thread = state.threads[index];
              if (listedIds.has(hostId) || !thread.remote?.imported || skip.has(thread.id)) continue;
              if (missingBefore.has(hostId)) removed.push(thread.id);
              else missingNow.add(hostId);
            }
          }
          if (listedIds.size > 0) remoteMissingLastTime.set(machine.id, missingNow);
          if (threads === state.threads && added.length === 0) return {};
          return { threads: added.length > 0 ? [...threads, ...added] : threads };
        });
        for (const id of removed) get().deleteThread(id);
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
          const removedThreadIds = state.threads
            .filter((thread) => thread.projectId === id && thread.id in state.composerDrafts)
            .map((thread) => thread.id);
          let transcripts = state.transcripts;
          for (const thread of state.threads) {
            if (thread.projectId !== id) continue;
            pendingTranscriptOps.delete(thread.id);
            if (!(thread.id in transcripts)) continue;
            if (transcripts === state.transcripts) transcripts = { ...state.transcripts };
            delete transcripts[thread.id];
          }
          const composerDrafts = removedThreadIds.length > 0 ? { ...state.composerDrafts } : state.composerDrafts;
          for (const threadId of removedThreadIds) delete composerDrafts[threadId];
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
            transcripts,
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
            composerDrafts,
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

      setBrowserSettings: (updates) =>
        set((state) => ({
          browserSettings: { ...defaultBrowserSettings, ...state.browserSettings, ...updates },
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

      setSnapShotSettings: (updates) =>
        set((state) => ({
          snapShotSettings: mergeSnapShotSettings({ ...state.snapShotSettings, ...updates }),
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
          new Date(t.summary.lastMessage?.ts ?? t.createdAt).getTime();
        const projectThreads = get().threads.filter((t) => t.projectId === projectId);
        const parentThread = options?.parentThreadId
          ? projectThreads.find((t) => t.id === options.parentThreadId)
          : undefined;
        const lastProjectThread =
          parentThread ??
          projectThreads
            .filter((t) => !t.parentThreadId && !t.subagent)
            .sort((a, b) => threadActivityTime(b) - threadActivityTime(a))[0] ??
          // A project with no thread yet (No project on a fresh machine, a
          // project just added) takes what was last run anywhere on this
          // machine rather than a fixed provider that may not even be
          // installed here. Mirrors of other machines' threads ran there.
          get()
            .threads.filter(
              (t) => !t.parentThreadId && !t.subagent && !t.remote && !t.spawnedBy && t.summary.messageCount > 0
            )
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
          ...(options?.spawnedBy ? { spawnedBy: options.spawnedBy } : {}),
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
          summary: summarizeThreadMessages([]),
        };
        set((state) => ({
          threads: [newThread, ...state.threads],
          transcripts: { ...state.transcripts, [newThread.id]: { messages: [] } },
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

      branchThread: async (sourceThreadId) => {
        // A thread on another machine has its context there (its agent
        // sessions); a copy here would start without it. Not yet.
        const source = get().threads.find((thread) => thread.id === sourceThreadId);
        if (source?.remote) {
          throw new Error(`Branching a thread that runs on ${source.remote.machineName} isn’t supported yet.`);
        }
        // The copy needs the transcripts of the thread and of the subagents
        // it carries along: load them, and keep them loaded until copied.
        const familyIds = branchFamilyThreadIds(get().threads, sourceThreadId);
        const releases = familyIds.map((id) => holdThreadTranscript(id));
        let family: ReturnType<typeof createThreadBranchFamily>;
        try {
          const loads = await Promise.allSettled(familyIds.map((id) => ensureThreadTranscript(id)));
          // A thread deleted meanwhile resolves to null and is simply not
          // copied; one that couldn't be read fails the whole branch rather
          // than leaving it out of the copy.
          const unreadable = familyIds.filter((_, index) => loads[index].status === 'rejected');
          if (unreadable.length > 0) {
            throw new Error(
              unreadable.includes(sourceThreadId)
                ? "This thread's transcript could not be read, so it was not branched."
                : `The transcript of ${unreadable.length === 1 ? 'a subagent' : `${unreadable.length} subagents`} could not be read, so the thread was not branched.`
            );
          }
          const state = get();
          family = createThreadBranchFamily(state.threads, state.transcripts, sourceThreadId);
        } finally {
          for (const release of releases) release();
        }
        if (!family) return null;
        const newThread = family.threads.find((thread) => thread.id === family!.rootId);
        if (!newThread) return null;
        set((state) => {
          const threads = [...family!.threads.map(shellOfRecord), ...state.threads];
          const transcripts = { ...state.transcripts };
          for (const thread of family!.threads) transcripts[thread.id] = transcriptOfRecord(thread);
          return {
            threads,
            transcripts,
            selectedProjectId: newThread.projectId,
            ...syncSavedView(state, panesForSelection(state, newThread.id), { threads }),
          };
        });
        return family.rootId;
      },

      selectProject: (id) =>
        set((state) => {
          const selectedThread = findThread(state.threads, state.selectedThreadId);

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
          const thread = findThread(state.threads, id);

          return {
            ...syncSavedView(state, panesForSelection(state, id)),
            selectedProjectId: thread?.projectId ?? state.selectedProjectId,
            threads: id ? threadsWithOpenedSeen(state, id) : state.threads,
          };
        }),

      openThreadInSplit: (id) =>
        set((state) => {
          const thread = findThread(state.threads, id);
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
          const index = threadIndexById(state.threads).get(id);
          if (index === undefined) return {};
          const threads = replaceThreadAt(state.threads, index, withThreadUpdates(state, state.threads[index], updates));
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

      setComposerDraft: (threadId, draft) =>
        set((state) => {
          const current = state.composerDrafts[threadId];
          if (!draft.text.trim() && draft.attachments.length === 0) {
            if (!current) return state;
            const { [threadId]: _removed, ...composerDrafts } = state.composerDrafts;
            return { composerDrafts };
          }
          if (current?.text === draft.text && current.attachments === draft.attachments) return state;
          return { composerDrafts: { ...state.composerDrafts, [threadId]: draft } };
        }),

      deleteThread: (id) =>
        set((state) => {
          // A deleted thread leaves every saved view it appeared in; a view
          // left with one thread goes with it.
          const threads = state.threads.filter((thread) => thread.id !== id);
          const { [id]: _removedDraft, ...composerDrafts } = state.composerDrafts;
          pendingTranscriptOps.delete(id);
          const { [id]: _removedTranscript, ...transcripts } = state.transcripts;
          const savedViews = pruneSavedViews(state.savedViews, threads);
          const panes = panesAfterRemoval(state, (paneId) => paneId === id);
          const focusedPaneThread = panes.selectedThreadId
            ? threads.find((thread) => thread.id === panes.selectedThreadId)
            : undefined;
          return {
            threads,
            transcripts: id in state.transcripts ? transcripts : state.transcripts,
            ...panes,
            selectedProjectId: focusedPaneThread?.projectId ?? state.selectedProjectId,
            composerDrafts: id in state.composerDrafts ? composerDrafts : state.composerDrafts,
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
        set((state) =>
          transcriptChange(
            state,
            threadId,
            (transcript) => ({ ...transcript, messages: [...transcript.messages, msg] }),
            {
              // New activity puts a thread back in Recent agents even if it was
              // removed — except subagent children, which render nested under
              // their parent and never as top-level Recent rows, and threads an
              // agent on another machine started here (that agent's subagents).
              shellPatch: (thread) => ({
                hiddenFromRecent: thread.parentThreadId || thread.spawnedBy ? thread.hiddenFromRecent : false,
              }),
            }
          )
        );
        return msg.id;
      },

      appendToThreadMessage: (threadId, messageId, chunk) => {
        if (!chunk) return;
        set((state) =>
          transcriptChange(
            state,
            threadId,
            (transcript) =>
              mapMessage(transcript, messageId, (message) => ({ ...message, content: `${message.content}${chunk}` })),
            // Streamed text changes nothing the shell shows.
            { summary: false }
          )
        );
      },

      updateThreadMessage: (threadId, messageId, updates) =>
        set((state) =>
          transcriptChange(
            state,
            threadId,
            (transcript) => mapMessage(transcript, messageId, (message) => ({ ...message, ...updates })),
            { summary: Object.keys(updates).some((key) => SUMMARY_MESSAGE_FIELDS.has(key)) }
          )
        ),

      updateThreadTranscript: (threadId, recipe) => set((state) => transcriptChange(state, threadId, recipe)),

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

          return transcriptChange(
            state,
            threadId,
            (transcript) =>
              mapMessage(transcript, messageId, (message) => {
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
            // Tool activity changes nothing the shell shows.
            { summary: false }
          );
        }),

      completeInProgressPlanEntries: (threadId, messageId) =>
        set((state) =>
          transcriptChange(
            state,
            threadId,
            (transcript) =>
              mapMessage(transcript, messageId, (message) => {
                if (!message.activities?.length) return message;
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
            { summary: false }
          )
        ),

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
        const id = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        set((state) =>
          transcriptChange(
            state,
            threadId,
            (transcript) => {
              const anchorMessage = transcript.messages.at(-1);
              const afterMessageId = anchorMessage?.id;
              const exchange: BtwExchange = {
                id,
                question,
                answer: '',
                status: 'running',
                createdAt,
                ...(afterMessageId ? { afterMessageId } : {}),
                ...(anchorMessage?.kind === 'agent-run'
                  ? { contentOffset: anchorMessage.content.length }
                  : {}),
              };
              return { ...transcript, btwExchanges: [...(transcript.btwExchanges ?? []), exchange] };
            },
            { summary: false }
          )
        );
        return id;
      },

      appendToBtwExchange: (threadId, exchangeId, chunk) => {
        if (!chunk) return;
        set((state) =>
          transcriptChange(
            state,
            threadId,
            (transcript) => ({
              ...transcript,
              btwExchanges: (transcript.btwExchanges ?? []).map((exchange) =>
                exchange.id === exchangeId
                  ? { ...exchange, answer: `${exchange.answer}${chunk}` }
                  : exchange
              ),
            }),
            { summary: false }
          )
        );
      },

      updateBtwExchange: (threadId, exchangeId, updates) =>
        set((state) =>
          transcriptChange(
            state,
            threadId,
            (transcript) => ({
              ...transcript,
              btwExchanges: (transcript.btwExchanges ?? []).map((exchange) =>
                exchange.id === exchangeId ? { ...exchange, ...updates } : exchange
              ),
            }),
            { summary: false }
          )
        ),

      removeBtwExchange: (threadId, exchangeId) =>
        set((state) =>
          transcriptChange(
            state,
            threadId,
            (transcript) => ({
              ...transcript,
              btwExchanges: (transcript.btwExchanges ?? []).filter((e) => e.id !== exchangeId),
            }),
            { summary: false }
          )
        ),

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
      name: ORION_STORE_NAME,
      storage: orionStorage,
      version: 1,
      // `threads` and `transcripts` are deliberately absent: they are
      // persisted by the throttled saver below instead, and grafted back in on
      // hydration. The middleware calls this on EVERY store update, so it
      // returns the previous object while none of its inputs changed, and
      // orionStorage.setItem then skips the stringify.
      partialize: (state) => persistedSettingsOf(state),
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
        merged.snapShotSettings = mergeSnapShotSettings(merged.snapShotSettings);
        merged.appearanceSettings = { ...defaultAppearanceSettings, ...merged.appearanceSettings };
        merged.browserSettings = { ...defaultBrowserSettings, ...merged.browserSettings };
        // The Pinned group starts off on every launch; turning it on lasts
        // until the app quits. Stores from when sidebar v2 was opt-in turn it
        // on once; those that never had it on get the first-switch settle
        // once all threads have loaded (settleThreadsFromBeforeSidebarV2).
        const persistedSidebarV2 = (persisted as Partial<OrionState> | undefined)?.sidebarV2Settings;
        merged.sidebarV2Settings = {
          ...defaultSidebarV2Settings,
          ...merged.sidebarV2Settings,
          ...(persistedSidebarV2 && (persistedSidebarV2.version ?? 1) < 2 ? { enabled: true, version: 2 } : {}),
          views: { ...defaultSidebarV2Settings.views, ...merged.sidebarV2Settings?.views, pinned: false },
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
          deployWatcher: {
            ...defaultDurangoDeployWatcherSettings,
            ...merged.durangoSettings?.deployWatcher,
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
        // Threads arrive as shells with the panes' transcripts (thread
        // storage), or whole from a store written before threads moved out of
        // it; split those. Then clean up the previous session's runs
        // (restoreShellFromPreviousRun, restoreTranscriptFromPreviousRun).
        sessionStartedAt = new Date().toISOString();
        const transcripts: Record<string, ThreadTranscript> = {
          ...(merged.transcripts && typeof merged.transcripts === 'object' ? merged.transcripts : {}),
        };
        merged.threads = (Array.isArray(merged.threads) ? merged.threads : []).map((thread) => {
          const record = thread as Thread & Partial<ThreadTranscript>;
          if (!Array.isArray(record.messages)) return restoreShellFromPreviousRun(thread);
          transcripts[record.id] = transcriptOfRecord(record as ThreadRecord);
          return restoreShellFromPreviousRun(shellOfRecord(record as ThreadRecord));
        });
        const liveIds = new Set(merged.threads.map((thread) => thread.id));
        for (const id of Object.keys(transcripts)) {
          if (!liveIds.has(id)) {
            delete transcripts[id];
            continue;
          }
          transcripts[id] = restoreTranscriptFromPreviousRun(
            transcripts[id],
            interruptedAtStartup.has(id),
            sessionStartedAt
          );
        }
        // Summaries of the transcripts at hand reflect the cleanup.
        merged.threads = merged.threads.map((thread) => {
          const transcript = transcripts[thread.id];
          if (!transcript) return thread;
          const summary = summarizeThreadMessages(transcript.messages);
          return sameThreadSummary(summary, thread.summary) ? thread : { ...thread, summary };
        });
        merged.transcripts = transcripts;
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
        // Stores written before drafts were saved have none. Drafts of threads
        // deleted since are dropped once every transcript has loaded
        // (pruneOrphanComposerDrafts); the head loaded here may be partial.
        merged.composerDrafts =
          merged.composerDrafts && typeof merged.composerDrafts === 'object' ? merged.composerDrafts : {};
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

// The threads saver sends what changed at most once per THREADS_SAVE_MS (a
// streaming run mutates a transcript many times a second), with a synchronous
// patch flush on unload. Zustand actions replace the shell or transcript they
// change, so reference identity identifies what is dirty.
const THREADS_SAVE_MS = 5000;

const scheduleThreadsSave = () => {
  if (threadsSaveTimer !== null) return;
  threadsSaveTimer = setTimeout(() => {
    threadsSaveTimer = null;
    flushThreadsSave();
  }, THREADS_SAVE_MS);
};

const shellForSave = (shell: Thread): Omit<Thread, 'summary'> => {
  const { summary: _summary, ...fields } = shell;
  return fields;
};

// The patch for these ids against the current state: whole threads for
// changed transcripts (always loaded: transcripts with unsaved changes are
// never evicted), shells for the rest, deletes for threads that are gone.
const threadsPatchFor = (
  transcriptIds: Iterable<string>,
  shellIds: Iterable<string>,
  deleteIds: Iterable<string>,
  withOrder: boolean
) => {
  const state = useOrionStore.getState();
  const upserts: ThreadRecord[] = [];
  const shells: Array<Omit<Thread, 'summary'>> = [];
  const sent: InFlightThreadsSave = { transcriptIds: new Set(), shellIds: new Set(), deletes: new Set() };
  for (const id of transcriptIds) {
    const shell = findThread(state.threads, id);
    const transcript = state.transcripts[id];
    if (!shell || !transcript || sent.transcriptIds.has(id)) continue;
    upserts.push(threadRecordOf(shell, transcript));
    sent.transcriptIds.add(id);
  }
  for (const id of shellIds) {
    if (sent.transcriptIds.has(id) || sent.shellIds.has(id)) continue;
    const shell = findThread(state.threads, id);
    if (!shell) continue;
    shells.push(shellForSave(shell));
    sent.shellIds.add(id);
  }
  for (const id of deleteIds) {
    if (!findThread(state.threads, id)) sent.deletes.add(id);
  }
  const patch: ThreadsPatch = {
    version: 2,
    upserts,
    shells,
    deletes: [...sent.deletes],
    ...(withOrder ? { order: state.threads.map((thread) => thread.id) } : {}),
  };
  return { patch, sent };
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
  if (dirtyTranscripts.size === 0 && dirtyShells.size === 0 && pendingThreadDeletes.size === 0 && !pendingThreadOrder) {
    return true;
  }
  const { patch, sent } = threadsPatchFor(dirtyTranscripts, dirtyShells, pendingThreadDeletes, pendingThreadOrder);
  dirtyTranscripts.clear();
  dirtyShells.clear();
  pendingThreadDeletes.clear();
  pendingThreadOrder = false;
  threadsInFlight = sent;
  const save = (async () => {
    try {
      const saved = await window.orion.saveThreads(patch);
      if (!saved) throw new Error('Thread patch was not acknowledged.');
      for (const id of sent.transcriptIds) transcriptsWrittenThisSession.add(id);
      // Threads storage exists now (it may not have at launch), so saved
      // transcripts can be dropped from memory and read back.
      loadedThreadsFromStorage = true;
      return saved;
    } catch (error) {
      console.warn('Failed to persist Orion threads; retrying', error);
      // Everything in the failed patch is dirty again; the retry reads the
      // current state.
      for (const id of sent.transcriptIds) dirtyTranscripts.add(id);
      for (const id of sent.shellIds) dirtyShells.add(id);
      for (const id of sent.deletes) pendingThreadDeletes.add(id);
      pendingThreadOrder = true;
      scheduleThreadsSave();
      return false;
    }
  })();
  threadsSaveFlush = save;
  try {
    return await save;
  } finally {
    if (threadsInFlight === sent) threadsInFlight = null;
    if (threadsSaveFlush === save) threadsSaveFlush = null;
    scheduleTranscriptEviction();
  }
};

const flushThreadsSave = () => {
  void flushOrionThreadsSave();
};

// Set while a loaded transcript (and the shell fields it fills in) goes into
// the store: that is what is stored already, not a change to save.
let applyingTranscriptLoad = false;

useOrionStore.subscribe((state, previous) => {
  if (!useOrionStore.persist.hasHydrated() || applyingTranscriptLoad) return;
  let changed = false;
  if (state.transcripts !== previous.transcripts) {
    // Only loaded transcripts are visited: a handful, not every thread.
    for (const id in state.transcripts) {
      if (state.transcripts[id] !== previous.transcripts[id]) {
        dirtyTranscripts.add(id);
        changed = true;
      }
    }
  }
  if (state.threads !== previous.threads) {
    const sameOrder =
      state.threads.length === previous.threads.length &&
      state.threads.every((thread, index) => thread.id === previous.threads[index].id);
    if (sameOrder) {
      for (let index = 0; index < state.threads.length; index += 1) {
        if (state.threads[index] !== previous.threads[index]) {
          dirtyShells.add(state.threads[index].id);
          changed = true;
        }
      }
    } else {
      const previousIndex = threadIndexById(previous.threads);
      const currentIndex = threadIndexById(state.threads);
      for (const thread of state.threads) {
        const index = previousIndex.get(thread.id);
        if (index === undefined || previous.threads[index] !== thread) {
          dirtyShells.add(thread.id);
          pendingThreadDeletes.delete(thread.id);
        }
      }
      for (const thread of previous.threads) {
        if (!currentIndex.has(thread.id)) {
          dirtyShells.delete(thread.id);
          dirtyTranscripts.delete(thread.id);
          pendingThreadDeletes.add(thread.id);
        }
      }
      pendingThreadOrder = true;
      changed = true;
    }
  }
  if (changed) scheduleThreadsSave();
});

// ---------------------------------------------------------------------------
// Loading and evicting transcripts.

const transcriptLoads = new Map<string, Promise<ThreadTranscript | null>>();
const TRANSCRIPT_LOAD_ATTEMPTS = 3;

const readStoredThread = async (threadId: string): Promise<ThreadRecord | null> => {
  if (typeof window === 'undefined' || !window.orion?.loadThreadsBatch) return null;
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSCRIPT_LOAD_ATTEMPTS; attempt += 1) {
    try {
      const result = await window.orion.loadThreadsBatch({ ids: [threadId], maxBytes: THREADS_BATCH_BYTES });
      if (!result?.ok || typeof result.value !== 'string') throw new Error('Thread transcript read failed.');
      const batch = JSON.parse(result.value) as PersistedThreadsBatch;
      if (batch?.version !== 2 || !Array.isArray(batch.threads)) throw new Error('Invalid thread batch response.');
      return batch.threads.find((thread) => thread?.id === threadId) ?? null;
    } catch (error) {
      lastError = error;
      if (attempt < TRANSCRIPT_LOAD_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError;
};

// A stored thread as it goes into the store: the previous session's
// leftovers cleaned up (once per session), the changes queued for it while it
// wasn't loaded applied in order, and its shell's summary and subagent
// details brought up to date. The shell keeps every field the store has.
const resolveLoadedThread = (
  threadId: string,
  shell: Thread,
  record: ThreadRecord | null,
  ops: TranscriptRecipe[]
) => {
  // A thread that was never stored has nothing on disk to lose.
  let transcript: ThreadTranscript = record ? transcriptOfRecord(record) : { messages: [] };
  let changed = false;
  if (record && !shell.remote && !transcriptsWrittenThisSession.has(threadId)) {
    const restored = restoreTranscriptFromPreviousRun(transcript, interruptedAtStartup.has(threadId), sessionStartedAt);
    if (restored !== transcript) {
      transcript = restored;
      changed = true;
    }
  }
  for (const op of ops) {
    const next = op(transcript);
    if (next !== transcript) {
      transcript = next;
      changed = true;
    }
  }
  let nextShell = shell;
  // A thread that runs on another machine keeps the summary that machine's
  // listing gave it while its copy stored here is behind that (it is fetched
  // again once open): its row must not drop back to where that copy left it.
  // A copy as new as the listing gives the fuller summary; changes made here
  // (ops) are newer than either.
  const summary = summarizeThreadMessages(transcript.messages);
  const keepRemoteSummary = Boolean(shell.remote) && ops.length === 0 && summaryAhead(shell.summary, summary);
  if (!keepRemoteSummary && !sameThreadSummary(summary, shell.summary)) nextShell = { ...nextShell, summary };
  // The manifest's shell leaves out subagent prompts and reports; take them
  // from the stored thread so a whole-thread save keeps them.
  if (record) nextShell = withStoredSubagentDetails(nextShell, record);
  return { shell: nextShell, transcript, changed };
};

const applyLoadedTranscript = (threadId: string, record: ThreadRecord | null) => {
  applyingTranscriptLoad = true;
  let changedByLoad = false;
  try {
    useOrionStore.setState((state) => {
      const index = threadIndexById(state.threads).get(threadId);
      // Deleted while it loaded: so are the changes waiting for it.
      if (index === undefined) {
        pendingTranscriptOps.delete(threadId);
        return {};
      }
      // Loaded some other way meanwhile.
      if (state.transcripts[threadId]) return {};
      const shell = state.threads[index];
      const ops = pendingTranscriptOps.get(threadId) ?? [];
      pendingTranscriptOps.delete(threadId);
      const loaded = resolveLoadedThread(threadId, shell, record, ops);
      changedByLoad = loaded.changed;
      return {
        transcripts: { ...state.transcripts, [threadId]: loaded.transcript },
        ...(loaded.shell !== shell ? { threads: replaceThreadAt(state.threads, index, loaded.shell) } : {}),
      };
    });
  } finally {
    applyingTranscriptLoad = false;
  }
  if (changedByLoad) {
    dirtyTranscripts.add(threadId);
    scheduleThreadsSave();
  }
  scheduleTranscriptEviction();
};

// Changes queued for a transcript whose load failed must not wait for some
// later trigger: retry the load a few times, backing off.
const PENDING_LOAD_RETRIES = 5;
const pendingLoadRetries = new Map<string, number>();
const retryLoadForPendingOps = (threadId: string) => {
  if (!pendingTranscriptOps.has(threadId)) {
    pendingLoadRetries.delete(threadId);
    return;
  }
  const attempt = (pendingLoadRetries.get(threadId) ?? 0) + 1;
  if (attempt > PENDING_LOAD_RETRIES) {
    console.error(`Gave up loading Orion thread ${threadId}; its queued changes are kept until it loads or the app quits.`);
    return;
  }
  pendingLoadRetries.set(threadId, attempt);
  setTimeout(() => {
    void ensureThreadTranscript(threadId).catch(() => {});
  }, 2000 * attempt);
};

/**
 * Loads a thread's transcript into the store (if it isn't already) and
 * resolves to it; null for a thread that doesn't exist. Rejects when the
 * stored transcript can't be read; changes waiting for it stay queued.
 */
export const ensureThreadTranscript = (threadId: string): Promise<ThreadTranscript | null> => {
  const state = useOrionStore.getState();
  const loaded = state.transcripts[threadId];
  if (loaded) return Promise.resolve(loaded);
  if (!findThread(state.threads, threadId)) return Promise.resolve(null);
  const inFlight = transcriptLoads.get(threadId);
  if (inFlight) return inFlight;
  const load = (async () => {
    let record: ThreadRecord | null;
    try {
      record = await readStoredThread(threadId);
    } catch (error) {
      retryLoadForPendingOps(threadId);
      throw error;
    }
    pendingLoadRetries.delete(threadId);
    applyLoadedTranscript(threadId, record);
    return useOrionStore.getState().transcripts[threadId] ?? null;
  })().finally(() => {
    transcriptLoads.delete(threadId);
  });
  transcriptLoads.set(threadId, load);
  return load;
};

/** ensureThreadTranscript for several threads; resolves once all are settled. */
export const ensureThreadTranscripts = async (threadIds: Iterable<string>) => {
  await Promise.all(
    [...new Set(threadIds)].map((id) =>
      ensureThreadTranscript(id).catch((error) => {
        console.warn('Could not load an Orion thread transcript', error);
        return null;
      })
    )
  );
};

/** Whether a thread's transcript is in the store. */
export const isThreadTranscriptLoaded = (threadId: string) => threadId in useOrionStore.getState().transcripts;

// How many recently opened threads keep their transcript after they leave
// the screen, so switching back and forth doesn't reload them.
const RECENT_TRANSCRIPTS = 20;
const recentThreadIds: string[] = [];
const touchRecentThread = (threadId: string) => {
  const at = recentThreadIds.indexOf(threadId);
  if (at !== -1) recentThreadIds.splice(at, 1);
  recentThreadIds.unshift(threadId);
  if (recentThreadIds.length > RECENT_TRANSCRIPTS) recentThreadIds.length = RECENT_TRANSCRIPTS;
};

// Code that reads a transcript across awaits can hold it loaded.
const transcriptHolds = new Map<string, number>();
/** Keeps a thread's transcript from being evicted until the returned release is called. */
export const holdThreadTranscript = (threadId: string) => {
  transcriptHolds.set(threadId, (transcriptHolds.get(threadId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (transcriptHolds.get(threadId) ?? 1) - 1;
    if (count > 0) transcriptHolds.set(threadId, count);
    else transcriptHolds.delete(threadId);
    scheduleTranscriptEviction();
  };
};

/**
 * Drops the transcripts nothing needs: not on screen, not running, not among
 * the recently opened, not held, and fully saved. Their shells stay.
 */
export const evictTranscripts = () => {
  // Without working persistence the store's copy may be the only one.
  if (threadsPersistenceBlocked || !loadedThreadsFromStorage) return;
  const state = useOrionStore.getState();
  const keep = new Set([...state.paneThreadIds, ...recentThreadIds]);
  if (state.selectedThreadId) keep.add(state.selectedThreadId);
  const evicted: string[] = [];
  for (const id in state.transcripts) {
    if (keep.has(id) || transcriptHolds.has(id) || pendingTranscriptOps.has(id)) continue;
    if (dirtyTranscripts.has(id) || threadsInFlight?.transcriptIds.has(id)) continue;
    const shell = findThread(state.threads, id);
    if (!shell || shell.status === 'running') continue;
    evicted.push(id);
  }
  if (evicted.length === 0) return;
  applyingTranscriptLoad = true;
  try {
    useOrionStore.setState((current) => {
      const transcripts = { ...current.transcripts };
      for (const id of evicted) {
        // Re-checked against the state being replaced.
        if (dirtyTranscripts.has(id) || transcripts[id] !== state.transcripts[id]) continue;
        delete transcripts[id];
      }
      return { transcripts };
    });
  } finally {
    applyingTranscriptLoad = false;
  }
};

const TRANSCRIPT_EVICTION_DELAY_MS = 2000;
let transcriptEvictionTimer: ReturnType<typeof setTimeout> | null = null;
const scheduleTranscriptEviction = () => {
  if (transcriptEvictionTimer !== null) return;
  transcriptEvictionTimer = setTimeout(() => {
    transcriptEvictionTimer = null;
    evictTranscripts();
  }, TRANSCRIPT_EVICTION_DELAY_MS);
};

// What is on screen loads (and counts as recently opened); threads that start
// running load too, since their events will write to them. A thread running
// on another machine gets no events here (useRemoteThreadSync fetches it while
// open), so it doesn't.
useOrionStore.subscribe((state, previous) => {
  if (!useOrionStore.persist.hasHydrated()) return;
  if (state.paneThreadIds !== previous.paneThreadIds || state.selectedThreadId !== previous.selectedThreadId) {
    for (const id of [...state.paneThreadIds].reverse()) touchRecentThread(id);
    if (state.selectedThreadId) touchRecentThread(state.selectedThreadId);
    void ensureThreadTranscripts(state.paneThreadIds);
    scheduleTranscriptEviction();
  }
  if (state.threads !== previous.threads) {
    const running: string[] = [];
    for (const thread of state.threads) {
      if (thread.status === 'running' && !thread.remote && !(thread.id in state.transcripts)) running.push(thread.id);
    }
    if (running.length > 0) void ensureThreadTranscripts(running);
  }
});

// The whole threads that changes queued for unloaded transcripts produce,
// read synchronously (the quit-time flush can't wait for a load). A thread
// whose stored copy can't be read is left alone rather than saved without
// its messages.
const threadsWithPendingOpsSync = (): ThreadRecord[] => {
  if (pendingTranscriptOps.size === 0 || typeof window === 'undefined' || !window.orion?.loadThreadSync) return [];
  const state = useOrionStore.getState();
  const records: ThreadRecord[] = [];
  for (const [threadId, ops] of pendingTranscriptOps) {
    const shell = findThread(state.threads, threadId);
    if (!shell || state.transcripts[threadId]) continue;
    let stored: ThreadRecord | null;
    try {
      const result = window.orion.loadThreadSync(threadId);
      if (!result?.ok) throw new Error('Thread transcript read failed.');
      stored = typeof result.value === 'string' ? (JSON.parse(result.value) as ThreadRecord) : null;
    } catch (error) {
      console.error(`Could not save the queued changes of Orion thread ${threadId}`, error);
      continue;
    }
    const loaded = resolveLoadedThread(threadId, shell, stored, ops);
    records.push(threadRecordOf(loaded.shell, loaded.transcript));
  }
  return records;
};

// Materialize the threads storage as soon as hydration lands rather than a
// throttle-window later: the store file stops embedding threads on its first
// post-hydration save, so until this flush runs the transcripts exist only in
// memory and a crash would lose them.
//
// Stores with sidebar v2 on but never settled (a fresh install, an update
// from when it was opt-in, or one that turned it on before the first-switch
// settle existed) get it once here rather than in `merge`: thread edits made
// during hydration are never saved, while this one goes through the saver
// like a user's.
const settleThreadsFromBeforeSidebarV2 = () => {
  const { sidebarV2Settings, setSidebarV2Settings } = useOrionStore.getState();
  // Only over every stored thread.
  if (threadsPersistenceBlocked) return;
  if (!sidebarV2Settings.enabled || sidebarV2Settings.settledExistingAt) return;
  setSidebarV2Settings({});
};
const pruneOrphanComposerDrafts = () => {
  // A thread that failed to load is not a deleted one; its draft waits for a
  // launch that reads it.
  if (threadsPersistenceBlocked) return;
  const { threads, composerDrafts } = useOrionStore.getState();
  const liveThreadIds = threadIndexById(threads);
  const orphanIds = Object.keys(composerDrafts).filter((id) => !liveThreadIds.has(id));
  if (orphanIds.length === 0) return;
  const kept = { ...composerDrafts };
  for (const id of orphanIds) delete kept[id];
  useOrionStore.setState({ composerDrafts: kept });
};
const finishThreadsHydration = () => {
  const state = useOrionStore.getState();
  if (!loadedThreadsFromStorage && !threadsPersistenceBlocked) {
    // Threads embedded in an older store file: write them all out.
    for (const thread of state.threads) {
      if (thread.id in state.transcripts) dirtyTranscripts.add(thread.id);
      else dirtyShells.add(thread.id);
    }
    pendingThreadOrder = true;
  }
  for (const id of [...state.paneThreadIds].reverse()) touchRecentThread(id);
  void ensureThreadTranscripts(state.paneThreadIds);
  notifyAllThreadsLoaded();
  settleThreadsFromBeforeSidebarV2();
  pruneOrphanComposerDrafts();
  flushThreadsSave();
};
useOrionStore.persist.onFinishHydration(finishThreadsHydration);
if (useOrionStore.persist.hasHydrated()) finishThreadsHydration();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    cancelQueuedThreadsSave();
    // Closing the window mid-hydration must preserve the on-disk snapshot —
    // the store still holds the initial threads: [] and flushing it would
    // erase the transcript history. Same when the threads storage existed but
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
      const inFlight = threadsInFlight;
      const { patch } = threadsPatchFor(
        [...dirtyTranscripts, ...(inFlight?.transcriptIds ?? [])],
        [...dirtyShells, ...(inFlight?.shellIds ?? [])],
        [...pendingThreadDeletes, ...(inFlight?.deletes ?? [])],
        true
      );
      // Changes still waiting for a transcript to load (quitting mid-load,
      // or a load that keeps failing) would die with the renderer: read
      // those transcripts synchronously and save them with the changes.
      patch.upserts.push(...threadsWithPendingOpsSync());
      if (patch.upserts.length > 0 || patch.shells.length > 0 || patch.deletes.length > 0 || pendingThreadOrder) {
        window.orion.saveThreadsSync(patch);
      }
    } else {
      flushThreadsSave();
    }
  });
}
