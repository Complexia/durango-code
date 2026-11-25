type ThemeIpcResult<T> = { ok: true; value: T } | { ok: false; error: string };
/** A shared theme on durango.sh (src/main/theme-community.js). */
type CommunityThemeSummary = { slug: string; name: string; version: number; listed: boolean; url: string; installs?: number; author?: string | null };
type CommunityThemePreview = {
  /** community: a durango.sh theme; t3: a T3 Code theme file from a link. */
  kind?: 'community' | 't3';
  slug: string | null;
  name: string;
  description: string;
  author: string | null;
  appearance: 'dark' | 'light';
  installs: number;
  version: number;
  url: string | null;
  previewUrl: string | null;
  bytes: number;
  animated: boolean;
  /** This computer already has it (some version). */
  installedId: string | null;
  /** A T3 Code theme's appearances (its own first). */
  appearances?: Array<'dark' | 'light'>;
};
export {};

type AppUpdateState = {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'restarting'
    | 'not-available'
    | 'error';
  currentVersion: string;
  checkedAt?: string | null;
  availableVersion?: string | null;
  releaseNotes?: string[] | null;
  progress?: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  } | null;
  error?: string | null;
};

type WhatsNewState = {
  version: string;
  notes: string[];
  unseen: boolean;
};

type ProviderUpdateProgress = {
  operationId: string;
  status: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  phase: 'checking' | 'starting' | 'updating' | 'downloading' | 'installing' | 'verifying' | 'complete' | 'error' | 'cancelled';
  message: string;
  output: string;
  providerId: string | null;
  providerLabel: string | null;
  current: number;
  total: number;
  percent: number | null;
  updatedAt: string;
};

/** A Claude Code / Codex session found on disk that Orion can import. */
export type ImportableSessionSummary = {
  providerId: 'claude' | 'codex';
  sessionId: string;
  filePath: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ImportedSessionTranscript = {
  providerId: 'claude' | 'codex';
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: string;
  /** Provider model slug of the last turn, when recorded. */
  model: string | null;
  messages: import('./store').Message[];
};

export type DurangoCliStatus = {
  /** This build ships the durango-code CLI. */
  available: boolean;
  version: string | null;
  /** Directory with the `durango-code` launchers, appended to PATH for agents. */
  binDir: string | null;
  signedIn: boolean;
  credentialSource: 'saved' | 'environment' | null;
  user: { id?: string; name?: string | null; email?: string | null } | null;
};

export type DurangoWorkspaceStatus = {
  ok: boolean;
  /** The workspace directory is still on disk. */
  exists?: boolean;
  /** `durango-code ws list` still knows it. */
  registered?: boolean;
  /** `ws serve` state for this workspace's server slot. */
  server?: 'running' | 'queued' | 'starting' | null;
  /** The change this workspace holds, if any (`.durango/change.json`). */
  change?: {
    changeId: string;
    status: 'open' | 'queued' | 'landed' | 'archived' | 'abandoned' | null;
    url: string | null;
    title: string | null;
    rejection: string | null;
    error?: string | null;
  } | null;
  /** A `land` started from the app is waiting for the train. */
  landing?: boolean;
  error?: string;
};

/**
 * One agent skill directory under ~/.claude/skills (active) or
 * ~/.claude/skills-disabled (deactivated by Orion). The filesystem is the only
 * source of truth — nothing about skills is persisted in the Orion store.
 */
/** A slash command reported by the Claude CLI (mirror of the SDK's SlashCommand). */
/** One workspace in `durango-code ws prune --json`: removed with a reason code, or kept with a sentence. */
export type DurangoWorkspacePruneVerdict = {
  name: string;
  repo: string;
  repoName: string;
  path: string;
  threadId: string | null;
  changeId: string | null;
  lastUsedAt: string | null;
} & (
  | { remove: true; reason: 'merged' | 'abandoned' | 'idle' | 'interrupted' | 'missing' }
  | { remove: false; reason: string }
);

export type SlashCommandInfo = {
  /** Command name without the leading slash. */
  name: string;
  description: string;
  /** Placeholder shown after the name, e.g. "<objective>" — empty when the command takes no arguments. */
  argumentHint: string;
  aliases?: string[];
};

export type SkillEntry = {
  /** Directory name; mutations also carry `path` and `enabled` to identify duplicate IDs exactly. */
  id: string;
  /** Frontmatter `name`, falling back to the directory name. */
  name: string;
  description: string;
  version: string | null;
  license: string | null;
  path: string;
  /** Absolute path of the skill's SKILL.md — always present. */
  skillFile: string;
  enabled: boolean;
  scope: 'user';
  bytes: number;
  files: number;
  updatedAt: string | null;
};

export type SkillsListResult = {
  ok: boolean;
  skills: SkillEntry[];
  skillsPath: string;
  disabledPath: string;
  error?: string;
};

export type SkillImportResult = {
  id: string;
  name: string;
  status: 'imported' | 'replaced' | 'skipped' | 'error';
  error?: string;
};

/** A Codex MCP server available to Orion, with secrets intentionally omitted. */
export type McpEntry = {
  id: string;
  name: string;
  enabled: boolean;
  /** State in Codex before Orion's local override is applied. */
  configuredEnabled: boolean;
  transport: string;
  /** Sanitized executable basename or remote origin. */
  detail: string | null;
  authStatus: string | null;
};

export type McpsListResult = {
  ok: boolean;
  mcps: McpEntry[];
  error?: string;
};

/**
 * An MCP server connected to Orion itself (any provider). Its nickname is the
 * server name agents see and its @-mention token. Secrets stay in main.
 */
export type OrionMcpEntry = {
  id: string;
  nickname: string;
  transport: 'http' | 'stdio';
  /** Host + path for HTTP servers, the command line for local ones. */
  detail: string | null;
  /** Loaded in every turn; off means only threads that @-mention it load it. */
  enabled: boolean;
  auth: 'none' | 'oauth';
  status: 'ready' | 'needs-sign-in';
  headerNames: string[];
  envNames: string[];
  createdAt: string;
};

export type OrionMcpsListResult = {
  ok: boolean;
  servers: OrionMcpEntry[];
  error?: string;
};

/** A connector from the Durango account (durango.sh Settings → Connectors), loaded as an MCP server. */
export type AccountConnectorEntry = {
  id: string;
  kind: string;
  name: string;
  /** MCP server name agents see (mcp__<serverName>__*). */
  serverName: string;
};

export type AccountConnectorsListResult = {
  ok: boolean;
  signedIn: boolean;
  connectors: AccountConnectorEntry[];
  /** durango.sh Settings → Connectors, where they're added and removed. */
  manageUrl?: string;
  error?: string;
};

/** Where a provider-configured MCP server comes from. */
export type ProviderMcpSource = {
  id: string;
  provider: 'claude' | 'codex';
  /** The server's name inside that provider. */
  name: string;
  /** Claude Code: user, local (one project), project (.mcp.json) or plugin. Codex: config. */
  scope: 'user' | 'local' | 'project' | 'plugin' | 'config';
  projectPath?: string;
  plugin?: string;
  /** Loaded by that provider's runs (Codex: after Orion's toggle). */
  enabled: boolean;
  configuredEnabled?: boolean;
  authStatus?: string | null;
};

/**
 * An MCP server connected to Claude Code and/or Codex directly, grouped
 * across providers by name or endpoint. Secrets stay in main.
 */
export type ProviderMcpEntry = {
  /** Id of the primary source; pass it back to share the server. */
  key: string;
  name: string;
  transport: 'http' | 'stdio' | 'sse' | 'ws' | 'unknown';
  detail: string | null;
  sources: ProviderMcpSource[];
  /** Set when Orion already carries this server for every provider. */
  orion: { id: string; nickname: string; enabled: boolean } | null;
  shareBlockedReason: string | null;
  headerNames: string[];
  envNames: string[];
};

export type ProviderMcpsListResult = {
  ok: boolean;
  servers: ProviderMcpEntry[];
  /** Per-provider read failures; the other provider's servers still list. */
  errors: Partial<Record<'claude' | 'codex', string>>;
  error?: string;
};

export type AddOrionMcpInput = {
  /** Identifies a pending add so the renderer can cancel before a server exists. */
  operationId?: string;
  nickname: string;
  transport: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  enabled?: boolean;
};

// A process holding a listening TCP socket inside one of the user's project
// or workspace roots (Settings > Dev Servers). Rebuilt from lsof/ps on every scan.
export type DevServerEntry = {
  pid: number;
  /** Process short name from lsof (e.g. "node", "bun"). */
  command: string;
  /** Full command line from ps; falls back to `command` when ps omits it. */
  commandLine: string;
  /** Listening TCP ports, deduped and ascending. */
  ports: number[];
  /** Working directory; the join key for renderer-side thread attribution. */
  cwd: string | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  /** Epoch ms derived from ps etime; second precision. */
  startedAt: number | null;
  /** Thread attribution resolved in the main process, when possible. */
  threadId: string | null;
  /** How threadId was resolved: live run ancestry, thread PTY ancestry, or Claude session cwd. */
  threadSource: 'agent' | 'terminal' | 'session' | null;
};

export type UsageRange = '24h' | '7d' | '30d' | '90d';
export type UsageSourceFilter = 'all' | 'durango' | 'thread' | 'subagent' | 'bot' | 'other';
export type UsageReportInput = {
  range: UsageRange;
  provider: string;
  source: UsageSourceFilter;
  refresh?: boolean;
  /** Agent session ids of Durango Code threads, so their usage is attributed. */
  links: Array<{ sessionId: string; kind: 'thread' | 'subagent' }>;
};
export type UsageScanProgress = { done: number; total: number; scanning: boolean };
export type UsageTokens = { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number };
export type UsageRow = {
  cost: number;
  tokens: UsageTokens;
  totalTokens: number;
  sessions: number;
  share: number;
  tokenShare: number;
};
export type UsageRateWindow = {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
} | null;
export type UsageReport = {
  range: UsageRange;
  generatedAt: number;
  window: { start: number; end: number; bucket: 'hour' | 'day'; bucketMs: number };
  totals: {
    cost: number;
    savings: number;
    sessions: number;
    totalTokens: number;
    tokens: UsageTokens;
    unpricedTokens: number;
    ownCostTokens: number;
  };
  providers: Array<UsageRow & { id: string }>;
  models: Array<UsageRow & { provider: string; model: string; priced: boolean }>;
  sources: Array<UsageRow & { id: 'thread' | 'subagent' | 'bot' | 'other' }>;
  series: Array<{ start: number; cost: Record<string, number>; tokens: Record<string, number> }>;
  costByType: { input: number; cacheRead: number; cacheWrite: number; output: number; other: number };
  costBySpeed: { standard: number; fast: number; fastPremium: number; fastTokens: number };
  unpricedModels: string[];
  availableProviders: string[];
  prices: { source: 'bundled' | 'gateway'; fetchedAt: string | null };
  limits: {
    claude: Record<
      string,
      { status: string | null; utilization: number | null; resetsAt: number | null; usingOverage: boolean; overageStatus: string | null; at: number }
    >;
    codex: {
      at: number;
      value: {
        primary?: UsageRateWindow;
        secondary?: UsageRateWindow;
        additional?: Array<{
          label: string;
          used_percent?: number | null;
          window_minutes?: number | null;
          resets_at?: number | null;
        }>;
        plan_type?: string | null;
        credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | null } | null;
        rate_limit_reached_type?: string | null;
      };
    } | null;
  };
};

/** One provider's plan limits read live (src/main/provider-usage-limits.js). */
export type LiveProviderLimits = {
  status: 'ok' | 'signed-out' | 'expired' | 'unavailable' | 'error';
  detail?: string;
  plan?: string | null;
  extra?: string | null;
  at: number;
  windows?: Array<{
    id: string;
    label: string;
    usedPercent: number;
    resetsAt: number | null;
    windowMinutes: number | null;
    detail?: string;
  }>;
};
export type LiveUsageLimits = {
  claude?: LiveProviderLimits;
  antigravity?: LiveProviderLimits;
  grok?: LiveProviderLimits;
  /** Codex live snapshot (shared app-server or ChatGPT OAuth usage API), in the session logs' shape; `status` alone when unavailable. */
  codex?: (NonNullable<UsageReport['limits']['codex']> & { live?: boolean }) | { status: string; detail?: string; at: number };
};

export type DevServersListResult = {
  ok: boolean;
  servers: DevServerEntry[];
  error?: string;
};

export type DevServerKillOutcome = {
  pid: number;
  ok: boolean;
  /** The process was already gone before it was signalled. */
  alreadyExited?: boolean;
  error?: string;
};

// A running orchestrator agent asked main to spawn a subagent; the renderer
// resolves the model fuzzily (id, slug, or label), creates a child thread,
// runs it, and reports back via reportSubagentResult.
export type SubagentSpawnRequest = {
  spawnId: string;
  threadId: string;      // driver thread id
  projectPath: string;
  accessMode: 'read-only' | 'workspace-write' | 'full-access';
  model: string;         // model id, slug, or label — renderer resolves fuzzily
  prompt: string;
  title?: string;
  role?: string;
  effort?: string;       // reasoning effort value or label — renderer validates per model
};

// A running orchestrator agent asked main to stop one of its spawned
// subagents; the renderer matches the target among the driver's running
// children (by model and/or title, or the single running one when neither is
// given) and reports back via reportSubagentStopResult.
export type SubagentStopRequest = {
  stopId: string;
  threadId: string;      // driver thread id
  model?: string;        // model id, slug, or label — renderer matches fuzzily
  title?: string;        // title substring, case-insensitive
  all?: boolean;         // stop every match instead of requiring a unique one
};

// ---------------------------------------------------------------------------
// Remote control (paired Orion instances on the same account)

/** A paired controller allowed to drive this machine. */
export type RemoteDeviceEntry = {
  id: string;
  name: string;
  pairedAt: string | null;
  lastSeenAt: string | null;
  connected: boolean;
};

/** A paired host this machine can control. */
export type RemoteMachineEntry = {
  id: string;
  name: string;
  /** Null for a machine paired over the relay: its machine id is the route. */
  host: string | null;
  port: number | null;
  /** Paired over the internet relay rather than a direct address. */
  relay: boolean;
  pairedAt: string | null;
  status: 'connected' | 'connecting' | 'offline' | 'error';
  /** How the live session reaches it: the typed address, its local network, or the relay. */
  route?: 'direct' | 'lan' | 'relay' | null;
  error: string | null;
};

/** A file on its way to another machine (remote:uploadProgress). */
export type RemoteUploadProgress = {
  machineId: string;
  machineName: string;
  /** The file's path on this machine. */
  path: string;
  size: number;
  sent: number;
  /** deferred: that machine takes files only with the turn (older version). */
  state: 'uploading' | 'done' | 'sent' | 'error' | 'cancelled' | 'deferred';
  route: 'direct' | 'lan' | 'relay' | null;
  error?: string;
};

/** Engine state pushed from main over remote:state. */
export type RemoteControlState = {
  available: boolean;
  /** Set when pairings cannot be read or persisted at all on this machine. */
  error?: string | null;
  /** True until the engine has loaded its pairing file at startup. */
  starting?: boolean;
  machineId?: string;
  machineName?: string;
  authenticated?: boolean;
  connectionMode?: 'direct' | 'relay';
  host?: {
    enabled: boolean;
    listening: boolean;
    port: number;
    addresses: string[];
    error: string | null;
    /** Linux: the firewall drops the port, so machines nearby fall back to the relay. */
    firewall?: { tool: 'ufw'; port: number; command: string } | null;
    /** Internet mode only; `enabled` is false whenever the relay is not held. */
    relay: { enabled: boolean; online: boolean; error: string | null };
    pairing: { code: string; expiresAt: string } | null;
    devices: RemoteDeviceEntry[];
  };
  machines?: RemoteMachineEntry[];
};

export type RemoteThreadMeta = {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  subagent: boolean;
  /** A provider-native subagent's type (Explore, …); newer hosts only. */
  subagentKind?: string;
  /** Started by an agent on a paired machine (machine_run_agent), from its thread there. */
  spawnedBy?: { machineId: string; threadId: string };
  title: string;
  status: 'idle' | 'running' | 'done' | 'error';
  modelId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Newer hosts: the thread's summary, settled/hidden flags and workspace. */
  summary?: import('./thread-shell').ThreadSummary;
  settledAt?: string | null;
  hiddenFromRecent?: boolean;
  workspaceName?: string | null;
  /** Its access mode and effort settings (Thread fields of the same names). */
  settings?: Record<string, string>;
  /** Actions it waits on the user for (request_user_action). */
  userActions?: import('./store').UserAction[];
  /** A question or approval waits on the user there. */
  waitingOnQuestion?: boolean;
};

/** A paired machine's thread for this machine's sidebar (remote:listThreads). */
export type RemoteListedThread = RemoteThreadMeta & {
  /** The local project it belongs to here; null when none matches. */
  localProjectId: string | null;
  /** Its project's name on that machine. */
  projectName: string | null;
};

export type RemoteSnapshot = {
  machine: { id: string; name: string };
  capturedAt: string;
  projects: Array<{ id: string; name: string; path: string; repoId?: string | null }>;
  threads: RemoteThreadMeta[];
};

/** Push from a controlled host, forwarded to the controller's renderer. */
export type RemoteEvent = {
  machineId: string;
  kind: 'turnEvent' | 'workspaceChanged' | 'turnClaimed';
  payload: {
    threadId?: string;
    runId?: string;
    type?: string;
    /** turnEvent: the host transcript message the run writes to. */
    outputMessageId?: string;
    /** turnEvent: the number of the run's text/activity event (0 first). */
    streamSeq?: number;
    chunk?: string;
    activity?: Omit<import('./store').AgentActivity, 'id' | 'ts'>;
    parentThreadId?: string;
    /** turnEvent `prompt-suggestion`: the agent's guess at the next prompt. */
    suggestion?: string;
    /** turnClaimed: the key the renderer passed to remoteRunTurn. */
    turnKey?: string;
  } | null;
};

// A paired controller asked this (host) machine to run or stop a turn; the
// renderer executes it exactly like a local user action and reports back via
// reportRemoteCommandResult.
export type RemoteCommandRequest = {
  commandId: string;
  /** Main-process startup deadline, checked around renderer-side preparation. */
  expiresAt: number;
  command: {
    /**
     * addProject: add `projectPath` (a Durango Source checkout main just
     * cloned, main/source-checkout.js) as a project named `projectName`, or
     * find the project that already has that path; reports `projectId`.
     */
    kind:
      | 'runTurn'
      | 'stopTurn'
      | 'steerTurn'
      | 'addProject'
      | 'answerQuestion'
      | 'userAction'
      | 'threadState'
      | 'renameThread'
      | 'configureThread'
      | 'branchThread'
      | 'deleteThread';
    /** threadState: settle, snooze or pin the thread (null = undo); absent keys stay. */
    sidebarState?: import('./store').ThreadSidebarState;
    /** renameThread: new title for the thread. */
    title?: string;
    /** answerQuestion: which question, and the answers per question id. */
    runId?: string;
    requestId?: string | number;
    answers?: Record<string, string[]>;
    /** userAction: which action, and what the user did. */
    actionId?: string;
    op?: 'done' | 'reply' | 'dismiss' | 'watch' | 'secret';
    reply?: string;
    watching?: boolean;
    secretAnswer?: { type: 'save'; value: string } | { type: 'decline' };
    projectPath?: string;
    projectName?: string;
    prompt?: string;
    /**
     * runTurn: context for the agent that the transcript doesn't show (the
     * controller's copies of @-mentioned threads this machine can't read).
     */
    context?: string;
    /** Files a controller sent with the turn, already saved on this machine. */
    attachments?: import('./store').FileAttachment[];
    threadId?: string;
    /** stopTurn: stop only the run of this Durango dispatch (a cancelled bot task), not a later turn. */
    stopDispatchId?: string;
    projectId?: string;
    modelId?: string;
    accessMode?: 'read-only' | 'workspace-write' | 'full-access';
    /**
     * Provider-agnostic reasoning effort (or OpenCode variant name). Main drops
     * unknown values; the renderer maps the rest onto the turn model's field.
     */
    reasoningEffort?: string;
    /** Codex-only service tier. Ignored for other providers. */
    codexServiceTier?: 'default' | 'priority';
    /** Claude-only context window. Ignored for other providers. */
    claudeContextWindow?: '200k' | '1m';
    source?: { machineId: string; machineName: string };
    /**
     * runTurn, new thread: an agent on the controller started it
     * (machine_run_agent) from its thread `threadId` there.
     */
    spawnedBy?: import('./store').ThreadSpawnedBy;
    /** runTurn: an agent on the controller sent this turn (machine_run_agent), not the user. */
    fromAgent?: boolean;
    /**
     * Set when Durango started this run (dispatch worker in main): the
     * renderer creates the thread exactly like a remote runTurn (or, for a
     * follow-up, runs a turn in `threadId`), links the task, and adds a
     * visible "started remotely" note.
     */
    durangoDispatch?: {
      id: string;
      /** Started from a chat, with Run in Durango Code on a task, or through the API (Durango MCP). */
      origin?: 'chat' | 'tasks' | 'api' | 'bot';
      /** Who sent it, for the thread's note ("Durango Chat", "Grok (MCP) via Durango"). */
      sourceLabel?: string;
      /** Continue `threadId` instead of starting a thread. */
      followUp?: boolean;
      /** The new thread's title (a bot's task title). */
      title?: string;
      taskId: string | null;
      sourceUrl: string | null;
      requestedAccessMode: 'ask' | 'auto-edit' | null;
    };
  };
};

declare global {
type OrionCloudSyncStatus = 'synced' | 'ahead' | 'behind' | 'diverged' | 'unknown';

type OrionCloudAppStatus = 'queued' | 'building' | 'deployed' | 'failed';

/** An Orion Cloud app: the repo built on Railway and hosted at `url`. */
/** Model providers fx can route to (Settings → Providers → fx). */
type OrionFxConnections = {
  installed: boolean;
  /** Signed in to a Durango account (usage credits). */
  durango: boolean;
  /** ChatGPT subscription signed in through `fx login codex`. */
  codex: boolean;
  /** Grok subscription signed in through `fx login grok`. */
  grok: boolean;
  gateway: boolean;
  gatewaySource: 'api-key' | 'fx' | null;
};

type OrionCloudApp = {
  slug: string;
  url: string;
  status: OrionCloudAppStatus;
  error: string | null;
  commitOid?: string | null;
};

type OrionGithubMirror = {
  provider: 'github';
  delivery: 'cloud' | 'desktop';
  status:
    | 'active'
    | 'queued'
    | 'syncing'
    | 'authorization_required'
    | 'reconnect_required'
    | 'error'
    | 'disabling'
    | 'unconfigured'
    | 'disabled';
  authorizationUrl?: string | null;
  repositoryUrl?: string | null;
  lastMirroredGeneration?: number | null;
  lastError?: string | null;
};

type OrionCloudState = {
  ok: boolean;
  authenticated?: boolean;
  linked?: boolean;
  stale?: boolean;
  repoId?: string;
  repoName?: string;
  repo?: { id: string; name: string; defaultBranch: string; generation: number };
  refs?: Array<{ name: string; oid: string }>;
  currentBranch?: string | null;
  sync?: OrionCloudSyncStatus;
  webUrl?: string | null;
  /** Absent on Orion Web deployments that predate app hosting. */
  app?: OrionCloudApp | null;
  /** Absent on Orion Web deployments that predate continuous GitHub mirroring. */
  mirror?: OrionGithubMirror | null;
  error?: string;
};

type OrionCloudDeployResult = {
  ok: boolean;
  app?: OrionCloudApp | null;
  needsAuth?: boolean;
  /** The repo isn't linked yet — publish it before deploying. */
  needsPublish?: boolean;
  /** 402: the plan's app limit is used up. */
  limitReached?: boolean;
  upgradeRequired?: boolean;
  appLimit?: number | null;
  error?: string;
};

type OrionCloudAppStateResult = {
  ok: boolean;
  app?: OrionCloudApp | null;
  needsAuth?: boolean;
  error?: string;
};

/** Can Orion Cloud build this repo unattended, or does it need the agent? */
type OrionCloudDeployPrecheck = {
  ok: boolean;
  simple?: boolean;
  reasons?: string[];
  error?: string;
};

type OrionCloudPushResult = {
  ok: boolean;
  alreadyLinked?: boolean;
  upToDate?: boolean;
  conflict?: boolean;
  needsAuth?: boolean;
  pushed?: string[];
  skipped?: Array<{ branch: string; reason: string }>;
  repo?: { id: string; name: string };
  webUrl?: string | null;
  app?: OrionCloudApp | null;
  error?: string;
};

type OrionCloudPullResult = {
  ok: boolean;
  needsAuth?: boolean;
  branches?: Array<{ branch: string; oid?: string; status: string }>;
  merge?: {
    status:
      | 'none'
      | 'up-to-date'
      | 'checked-out'
      | 'fast-forwarded'
      | 'ff-failed'
      | 'local-ahead'
      | 'diverged'
      | 'unborn-dirty';
    to?: string;
    error?: string;
    hint?: string;
  };
  downloadedPacks?: number;
  downloadedLoose?: number;
  mirrorWarning?: string;
  error?: string;
};
}

type OrionBoardColumn = {
  id: string;
  name: string;
  role: 'todo' | 'in_progress' | 'review' | 'done' | null;
  position: number;
};

type OrionBoardAttachment = {
  id: string;
  fileName: string;
  /** Durango Tasks also sends the display name (same value as fileName). */
  name?: string;
  contentType: string;
  size: number;
  createdAt: string;
  /** Local copy downloaded by Orion Desktop for agent access. */
  localPath?: string;
  downloadError?: string;
};

type OrionBoardTask = {
  id: string;
  columnId: string;
  title: string;
  description: string;
  position: number;
  attachments: OrionBoardAttachment[];
  linked: {
    threadId: string;
    threadTitle: string | null;
    projectName: string | null;
    status: string;
    linkedAt: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Durango Tasks: the pre-migration Durango Code board id of an imported
   * task. Threads linked before the switch still hold that id.
   */
  legacyId?: string | null;
  /** Durango Tasks: the task on durango.sh. */
  url?: string;
};

type OrionBoardResult = {
  ok: boolean;
  error?: string;
  needsAuth?: boolean;
  columns?: OrionBoardColumn[];
  tasks?: OrionBoardTask[];
};

type OrionTaskActionResult = {
  ok: boolean;
  error?: string;
  needsAuth?: boolean;
  /** The task was unlinked or relinked on the web — drop the local link. */
  stale?: boolean;
  task?: OrionBoardTask;
};

type OrionAccountState = {
  authenticated: boolean;
  user: {
    id: string;
    email?: string | null;
    name?: string | null;
    imageUrl?: string | null;
  } | null;
  expiresAt: string | null;
};

type OrionWorkspaceSyncSettings = {
  enabled: boolean;
  syncCode: boolean;
  consentVersion?: number;
  consentNoticeSeen?: boolean;
};

/** A Durango Chat conversation as returned by GET /api/v1/chats (contracts §7). */
type DurangoChatSummary = {
  id: string;
  projectId: string | null;
  title: string;
  updatedAt: string | number | null;
  snippet: string;
  url: string | null;
  archived?: boolean;
};

type DurangoErrorCode = 'not_signed_in' | 'not_connected' | 'network' | 'api';

/** Settings → Durango → "Allow Durango Chat and Tasks to start agents on this Mac". */
type DurangoDispatchSettingsInput = {
  enabled: boolean;
  /** null = every project. */
  allowedProjectIds: string[] | null;
  accessMode: 'read-only' | 'workspace-write' | 'full-access';
  /** null = the project's usual model. */
  modelId: string | null;
  /** null = no limit. */
  maxRunning: number | null;
};

type DurangoDispatchState = {
  enabled: boolean;
  signedIn: boolean;
  status: 'off' | 'signed_out' | 'paused' | 'offline' | 'no_window' | 'busy' | 'listening' | 'error';
  lastError: string | null;
  maxRunning: number | null;
  running: Array<{ dispatchId: string; threadId: string | null; projectName: string | null }>;
};

/** Settings → Durango → "Deploy changes landed elsewhere" (main: durango-deploy-watcher.js). */
type DurangoDeployWatcherSettingsInput = {
  enabled: boolean;
};

type DurangoDeployWatcherState = {
  enabled: boolean;
  signedIn: boolean;
  status: 'off' | 'signed_out' | 'paused' | 'offline' | 'watching' | 'error';
  lastError: string | null;
  lastCheckAt: string | null;
  repos: Array<{
    repoId: string;
    name: string;
    checkout: string;
    state: 'idle' | 'deploying' | 'started' | 'stalled' | 'error' | 'unavailable';
    pending: string[];
    error: string | null;
    startedAt: string | null;
    pid: number | null;
    log: string | null;
  }>;
};

type DurangoSearchChatsResult =
  | { ok: true; data: DurangoChatSummary[]; nextCursor: string | null }
  | { ok: false; code: DurangoErrorCode; error: string };

type OrionWorkspaceSyncStatus = {
  enabled: boolean;
  authenticated: boolean;
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  backfillDone: boolean;
  counts: {
    projects: number;
    threads: number;
    transcriptsUploaded: number;
    codePushes: number;
  } | null;
};

export type DevicePlatform = 'ios' | 'android';

export type DeviceSettings = { useDevices: boolean; agentsCanUseDevices: boolean };

export type DeviceInfo = {
  id: string;
  name: string;
  platform: DevicePlatform;
  version: string;
  state: string;
  kind?: 'phone' | 'tablet' | 'emulator' | 'physical';
  avd?: string | null;
};

export type DevicePlatformAvailability = { available: boolean; reason: string | null };

export type DeviceStatus = {
  settings: DeviceSettings;
  platforms: { ios: DevicePlatformAvailability; android: DevicePlatformAvailability };
  agentDevice: {
    name: string;
    version?: string;
    installed: boolean;
    installing?: boolean;
    error?: string | null;
    /** Package manager that would install it ('bun' when present, else 'npm'); null when neither is found. */
    installer?: 'bun' | 'npm' | null;
    installerPath?: string | null;
    /** Set when neither bun nor npm is found: asks the user to install Node.js. */
    installerMissingHint?: string | null;
  };
};

export type OpenDevice = { device: DeviceInfo; session: string; command: string; openedAt: number };

export type DeviceEvent =
  | ({ type: 'opened'; threadId: string } & OpenDevice)
  | { type: 'screenshot'; threadId: string; deviceId: string; file: string; dataUrl: string; takenAt: number }
  | { type: 'closed'; threadId: string; deviceId: string };

declare global {
type OrionComputerUsePermissionKind = 'accessibility' | 'screen-recording' | 'automation';

type OrionComputerUsePermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown'
  | 'unsupported';

type OrionComputerUsePermissions = {
  supported: boolean;
  accessibility: OrionComputerUsePermissionStatus;
  screenRecording: OrionComputerUsePermissionStatus;
  automation: OrionComputerUsePermissionStatus;
  browserUse: {
    codex: OrionCodexBrowserIntegrationStatus;
  };
  chromeDebug: OrionChromeDebugStatus;
};

type OrionSnapShotState = {
  supported: boolean;
  settings: import('./store').SnapShotSettings;
  /** The capture helper: ready, being compiled (development), or missing. */
  helper: 'unknown' | 'ready' | 'building' | 'missing' | 'unsupported';
  trigger:
    | { kind: 'off'; fallback: boolean; error: string | null }
    | { kind: 'modifier-pair'; modifier: 'shift'; fallback: boolean; error: string | null }
    | { kind: 'accelerator'; accelerator: string; fallback: boolean; error: string | null };
  capturing: boolean;
  lastError: { message: string; at: string } | null;
  pendingCount: number;
  screenRecording: OrionComputerUsePermissionStatus;
  accessibility: OrionComputerUsePermissionStatus;
};

type OrionChromeDebugStatus = {
  /** enabled: server reachable; stale: configured but Chrome needs restart; disabled: not configured */
  status: 'enabled' | 'stale' | 'disabled' | 'unsupported';
  browser?: string;
};

type OrionCodexBrowserIntegrationStatus = {
  status: 'ready' | 'setup-required' | 'unavailable';
  ready: boolean;
  pluginInstalled: boolean;
  pluginEnabled: boolean;
  nodeReplEnabled: boolean;
  browserWorkflowAvailable: boolean;
  extensionInstalled: boolean | null;
  extensionEnabled: boolean | null;
  nativeHostReady: boolean | null;
  detail: string;
};

  type OrionBrowserTab = {
    id: string;
    threadId: string | null;
    agentId: string | null;
    /** A thread id, `thread:agent` for a Claude Task subagent, or `user`. */
    ownerKey: string;
    openedBy: 'agent' | 'user';
    controller: 'agent' | 'user';
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    dialog: { id: number; type: string; message: string; defaultPrompt: string; url: string } | null;
    crashed: boolean;
    agentBusy: boolean;
    lastAgentActionAt: number;
    createdAt: number;
    blocked: string | null;
    /** A download waiting for the user's Save / Cancel (Ask before downloading). */
    pendingDownload: { id: string; filename: string; url: string; totalBytes: number | null } | null;
    lastDownload: { path: string; state: string } | null;
  };

  type OrionBrowserState = {
    tabs: OrionBrowserTab[];
    visibleTabId: string | null;
    event?: { type: 'agent-opened' | 'popup-opened' | 'dialog-opened' | 'dialog-closed' | 'download-requested'; tabId: string; threadId: string | null; ownerKey?: string; openerTabId?: string };
  };

  type OrionBrowserResult = { ok: boolean; error?: string };

  type OrionBrowserApi = {
    list: () => Promise<OrionBrowserState>;
    create: (input: { url?: string; projectPath?: string | null; threadId?: string | null }) => Promise<OrionBrowserResult & { tabId?: string }>;
    navigate: (input: { tabId: string; url: string }) => Promise<OrionBrowserResult>;
    back: (tabId: string) => Promise<OrionBrowserResult>;
    forward: (tabId: string) => Promise<OrionBrowserResult>;
    reload: (tabId: string) => Promise<OrionBrowserResult>;
    stop: (tabId: string) => Promise<OrionBrowserResult>;
    close: (tabId: string) => Promise<OrionBrowserResult>;
    select: (tabId: string | null) => Promise<OrionBrowserResult>;
    setBounds: (rect: { x: number; y: number; width: number; height: number } | null) => Promise<OrionBrowserResult>;
    setVisible: (visible: boolean) => Promise<OrionBrowserResult>;
    thumbnail?: (input: { tabId: string; width?: number }) => Promise<OrionBrowserResult & { dataUrl?: string }>;
    takeControl: (tabId: string) => Promise<OrionBrowserResult>;
    releaseControl: (tabId: string) => Promise<OrionBrowserResult>;
    adopt: (input: { tabId: string; threadId: string; projectPath?: string | null }) => Promise<OrionBrowserResult>;
    answerDialog: (input: { tabId: string; dialogId?: number; accept: boolean; promptText?: string }) => Promise<OrionBrowserResult>;
    answerDownload: (input: { tabId: string; id: string; accept: boolean }) => Promise<OrionBrowserResult>;
    setOptions: (input: { askBeforeDownload?: boolean }) => Promise<OrionBrowserResult>;
    closeThreadTabs: (threadId: string, options?: { finished?: boolean }) => Promise<OrionBrowserResult>;
    setThreadParents: (parents: Record<string, string>) => Promise<OrionBrowserResult>;
    clearData: () => Promise<OrionBrowserResult>;
  };

  interface Window {
    orion: {
      loadStore: () => Promise<string | null>;
      saveStore: (value: string) => Promise<boolean>;
      /** Blocking quit-time flush — see preload. */
      saveStoreSync?: (value: string) => boolean;
      /**
       * Every thread's shell plus the stored threads named by `ids` (the open
       * panes), as JSON text. ok:false suppresses thread persistence.
       */
      loadThreadShells?: (input?: { ids?: string[] }) => Promise<{ ok: boolean; value?: string }>;
      /** Blocking quit-time read of one stored thread as JSON text (null: not stored). */
      loadThreadSync?: (id: string) => { ok: boolean; value?: string | null };
      /** Stored transcripts by id, in bounded batches, as JSON text. */
      loadThreadsBatch?: (input: { ids: string[]; maxBytes?: number }) => Promise<{ ok: boolean; value?: string }>;
      /** Transcript match scores per query token, by thread id (threads that matched any token). */
      /**
       * Scores per thread, aligned with `tokens` (the request's tokens main
       * scored; it skips some, e.g. over-long ones). `superseded`: a newer
       * search request replaced this one before it finished.
       */
      searchThreads?: (input: {
        tokens: string[];
      }) => Promise<{ ok: boolean; tokens?: string[]; scores?: Record<string, number[]>; superseded?: boolean }>;
      /** Search result excerpts read from the stored transcripts, by thread id. */
      threadSearchExcerpts?: (input: {
        items: Array<{ id: string; tokens: string[] }>;
      }) => Promise<{ ok: boolean; excerpts?: Record<string, string | null> }>;
      /** Loads the transcript search texts ahead of a search. */
      warmThreadSearch?: () => Promise<boolean>;
      saveThreads: (value: import('./store').ThreadsPatch) => Promise<boolean>;
      /** Blocking quit-time flush — see preload. */
      saveThreadsSync?: (value: import('./store').ThreadsPatch) => boolean;
      clearStore: () => Promise<boolean>;
      /** Lists Claude Code / Codex sessions the user ran outside Orion. */
      scanImportableSessions?: (input: {
        excludeSessionIds: string[];
      }) => Promise<
        | { ok: true; sessions: ImportableSessionSummary[]; missingDirectory: number }
        | { ok: false; error: string }
      >;
      /** Converts scanned sessions to transcripts; null entries could not be read. */
      readImportableSessions?: (input: {
        sessions: Array<Pick<ImportableSessionSummary, 'providerId' | 'filePath'>>;
      }) => Promise<
        | { ok: true; sessions: Array<ImportedSessionTranscript | null> }
        | { ok: false; error: string }
      >;
      /** Zooms the whole window (Settings → Themes → Text size). */
      setZoomFactor?: (factor: number) => void;
      /** Settings → Themes themes (src/main/ui-themes-store.js). */
      themes?: {
        list: () => Promise<ThemeIpcResult<import('./ui-themes.js').ThemeSnapshot>>;
        setActive: (id: string | null) => Promise<ThemeIpcResult<import('./ui-themes.js').ThemeSnapshot>>;
        setSaved: (id: string, saved: boolean) => Promise<ThemeIpcResult<import('./ui-themes.js').UiTheme>>;
        rename: (id: string, name: string) => Promise<ThemeIpcResult<import('./ui-themes.js').UiTheme>>;
        duplicate: (id: string) => Promise<ThemeIpcResult<import('./ui-themes.js').UiTheme>>;
        remove: (id: string) => Promise<ThemeIpcResult<import('./ui-themes.js').ThemeSnapshot>>;
        undo: (id: string) => Promise<ThemeIpcResult<import('./ui-themes.js').UiTheme>>;
        canUndo: (id: string) => Promise<ThemeIpcResult<boolean>>;
        setValues: (
          id: string,
          values: Record<string, import('./ui-themes.js').ThemeValue | null>
        ) => Promise<ThemeIpcResult<{ values: Record<string, import('./ui-themes.js').ThemeValue>; ignored: string[] }>>;
        resetValues: (id: string) => Promise<ThemeIpcResult<import('./ui-themes.js').ThemeSnapshot>>;
        setAnimate: (animate: boolean) => Promise<ThemeIpcResult<import('./ui-themes.js').ThemeSnapshot>>;
        /** The pre-1.0.206 localStorage setting; main keeps it only if state.json has none yet. */
        adoptLegacyAnimate: (animate: boolean) => Promise<ThemeIpcResult<import('./ui-themes.js').ThemeSnapshot>>;
        /** A small, softened copy of an image backdrop for static frosted panels; null if it cannot be made. */
        frost: (id: string, asset: string, width: number, saturate: number) => Promise<ThemeIpcResult<string | null>>;
        reportSceneError: (id: string, message: string) => void;
        /** A posterless video backdrop's bytes, to take a still frame from (null: nothing to do). */
        videoForPoster?: (id: string, asset: string) => Promise<ThemeIpcResult<Uint8Array | null>>;
        /** Saves a still frame (JPEG bytes) as the poster of a video backdrop that has none. */
        savePoster?: (id: string, asset: string, data: Uint8Array) => Promise<ThemeIpcResult<string | null>>;
        /** Share a theme to durango.sh/code/themes (or update the shared copy). */
        share?: (id: string, options?: { listed?: boolean }) => Promise<ThemeIpcResult<{ theme: import('./ui-themes.js').UiTheme; shared: CommunityThemeSummary }>>;
        setShareListed?: (id: string, listed: boolean) => Promise<ThemeIpcResult<{ theme: import('./ui-themes.js').UiTheme; shared: CommunityThemeSummary }>>;
        unshare?: (id: string) => Promise<ThemeIpcResult<import('./ui-themes.js').UiTheme>>;
        previewCommunity?: (slugOrUrl: string) => Promise<ThemeIpcResult<CommunityThemePreview>>;
        installCommunity?: (slugOrUrl: string, options?: { appearance?: 'dark' | 'light' }) => Promise<ThemeIpcResult<{ theme: import('./ui-themes.js').UiTheme; alreadyInstalled: boolean }>>;
        /** A theme install link that arrived before the renderer listened (taken once). */
        takeInstallRequest?: () => Promise<ThemeIpcResult<string | null>>;
        openGallery?: (slug?: string) => Promise<ThemeIpcResult<string>>;
        /** Pick a T3 Code theme file and add it (null: cancelled). */
        importT3File?: () => Promise<ThemeIpcResult<{ theme: import('./ui-themes.js').UiTheme; alreadyInstalled: boolean } | null>>;
        /** Save a theme as a T3 Code theme file (null: cancelled). */
        exportT3?: (id: string) => Promise<ThemeIpcResult<{ filePath: string; notes: string[]; name: string } | null>>;
        onInstallRequest?: (callback: (slug: string) => void) => () => void;
        onChanged: (callback: (snapshot: import('./ui-themes.js').ThemeSnapshot) => void) => () => void;
        onCelebrate: (callback: () => void) => () => void;
      };
      openDirectory: () => Promise<string | null>;
      /** Lists the directories in a typed path (project picker's Add project view). */
      browseDirectories?: (requestedPath: string) => Promise<{
        requestedPath: string;
        homeDir: string;
        directoryPath: string;
        parentPath: string | null;
        exists: boolean;
        entries: Array<{ name: string; fullPath: string }>;
      }>;
      /** Resolves a typed folder path to an absolute one, creating it when asked. */
      resolveProjectDirectory?: (
        inputPath: string,
        options?: { create?: boolean }
      ) => Promise<{ ok: true; path: string; created: boolean } | { ok: false; error: string }>;
      /** Creates (if needed) and returns the working directory for agents run without a project. */
      getNoProjectDir?: () => Promise<string>;
      readDirectory: (dirPath: string) => Promise<Array<{
        name: string;
        path: string;
        isDirectory: boolean;
        gitStatus: 'added' | 'copied' | 'conflicted' | 'deleted' | 'modified' | 'renamed' | 'untracked' | null;
        gitStatusLabel: string | null;
        hasChildGitStatus: boolean;
      }>>;
      readFile: (filePath: string) => Promise<string>;
      readFileResult: (filePath: string) => Promise<
        { ok: true; content: string } | { ok: false; error?: string }
      >;
      setWatchedFiles: (filePaths: string[]) => Promise<boolean>;
      openLinkedFile: (input: {
        href: string;
        baseDirs: string[];
      }) => Promise<{ ok: boolean; path?: string; content?: string; error?: string }>;
      writeFile: (filePath: string, content: string) => Promise<boolean>;
      createFile: (filePath: string, content?: string) => Promise<boolean>;
      createDirectory: (dirPath: string) => Promise<boolean>;
      deletePath: (targetPath: string) => Promise<boolean>;
      renamePath: (oldPath: string, newPath: string) => Promise<{ ok: boolean; error?: string }>;
      showFileTreeMenu: (input: {
        path: string;
        isDirectory: boolean;
        rootPath?: string | null;
      }) => Promise<'new-file' | 'new-folder' | 'rename' | 'delete' | null>;
      confirmDeletePath: (input: { path: string; isDirectory: boolean }) => Promise<boolean>;
      getGitState: (projectPath: string) => Promise<{
        ok: boolean;
        isGitRepository?: boolean;
        root?: string;
        originUrl?: string | null;
        sourceProvider?: 'github' | 'orion' | 'other' | 'none';
        githubMirrorUrl?: string | null;
        currentBranch?: string | null;
        detachedHead?: string | null;
        branches: Array<{
          name: string;
          current: boolean;
          hasUpstream: boolean;
        }>;
        hasUncommittedChanges: boolean;
        ahead?: number;
        behind?: number;
        error?: string;
      }>;
      changeSourceControlToOrion: (input: { projectPath: string }) => Promise<{
        ok: boolean;
        needsAuth?: boolean;
        createdRepository?: boolean;
        repo?: { id: string; name: string; defaultBranch?: string; generation?: number };
        originUrl?: string;
        githubMirrorUrl?: string | null;
        mirror?: OrionGithubMirror | null;
        mirrorWarning?: string;
        error?: string;
      }>;
      authorizeGithubMirror: (projectPath: string) => Promise<{
        ok: boolean;
        needsAuth?: boolean;
        mirror?: OrionGithubMirror | null;
        error?: string;
      }>;
      checkoutGitBranch: (input: {
        projectPath: string;
        branchName: string;
        create?: boolean;
      }) => Promise<{
        ok: boolean;
        error?: string;
        state?: {
          ok: boolean;
          root?: string;
          currentBranch?: string | null;
          detachedHead?: string | null;
          branches: Array<{
            name: string;
            current: boolean;
            hasUpstream: boolean;
          }>;
          hasUncommittedChanges: boolean;
          ahead?: number;
          behind?: number;
          error?: string;
        };
      }>;
      commitAndPush: (input: {
        projectPath: string;
        /** Text-generation model that writes the message; null falls back to a file summary. */
        modelId?: string | null;
        reasoningEffort?: string | null;
      }) => Promise<{
        ok: boolean;
        branch?: string;
        message?: string;
        /** Whether this click created a new local commit. */
        committed?: boolean;
        pushed?: boolean;
        /** The push succeeded without changing the remote branch. */
        alreadyUpToDate?: boolean;
        mirrorWarning?: string;
        error?: string;
        /** Concise remediation or technical context rendered below the error title. */
        errorDetail?: string;
        state?: {
          ok: boolean;
          root?: string;
          currentBranch?: string | null;
          detachedHead?: string | null;
          branches: Array<{
            name: string;
            current: boolean;
            hasUpstream: boolean;
          }>;
          hasUncommittedChanges: boolean;
          ahead?: number;
          behind?: number;
          error?: string;
        };
      }>;
      durangoCliStatus?: () => Promise<DurangoCliStatus>;
      durangoCliSignIn?: () => Promise<{
        ok: boolean;
        signedIn: boolean;
        created?: boolean;
        needsSignIn?: boolean;
        error?: string;
      }>;
      inspectDurangoWorkspaceProject?: (input: { projectPath: string }) => Promise<{
        ok: boolean;
        /** The project is in the main checkout of a repository with a durango.toml. */
        eligible: boolean;
        reason?: 'missing' | 'not-git' | 'worktree' | 'no-config';
        baseRoot?: string;
        error?: string;
      }>;
      createDurangoWorkspace?: (input: { projectPath: string; name: string; threadId?: string }) => Promise<{
        ok: boolean;
        workspace?: import('./store').ThreadDurangoWorkspace;
        /** Dependency directories that could not be cloned (run `hints` to install). */
        failedClones?: string[];
        hints?: string[];
        configErrors?: string[];
        cliSignedIn?: boolean;
        error?: string;
      }>;
      /** A workspace an agent made itself, looked up by name in the project's repository. */
      findDurangoWorkspace?: (input: { projectPath: string; name: string }) => Promise<{
        ok: boolean;
        workspace?: import('./store').ThreadDurangoWorkspace | null;
        error?: string;
      }>;
      removeDurangoWorkspace?: (input: {
        name: string;
        repo?: string;
        path?: string;
        /** Discard work that has not landed. */
        force?: boolean;
      }) => Promise<{ ok: boolean; alreadyRemoved?: boolean; unlanded?: boolean; error?: string }>;
      durangoWorkspaceStatus?: (input: {
        path: string;
        name?: string;
        repo?: string;
        /** Also ask Durango Source for the change's status and URL. */
        remote?: boolean;
      }) => Promise<DurangoWorkspaceStatus>;
      /** The workspace directories in `paths` that no longer exist. */
      missingDurangoWorkspaces?: (input: { paths: string[] }) => Promise<string[]>;
      /** `durango-code ws prune`: removes workspaces whose change merged or was abandoned, or that sat idle with no change. */
      pruneDurangoWorkspaces?: (input: {
        keep?: string[];
        only?: string[];
        dryRun?: boolean;
        idleDays?: number;
      }) => Promise<
        | {
            ok: boolean;
            removed: DurangoWorkspacePruneVerdict[];
            kept: DurangoWorkspacePruneVerdict[];
            failed: Array<DurangoWorkspacePruneVerdict & { error: string }>;
            error?: undefined;
            unsupported?: undefined;
          }
        | { ok: false; error: string; unsupported?: boolean; removed?: undefined; kept?: undefined; failed?: undefined }
      >;
      landDurangoWorkspace?: (input: { path: string }) => Promise<{
        ok: boolean;
        changeId?: string | null;
        url?: string | null;
        code?: string | null;
        conflictFiles?: string[] | null;
        exitCode?: number;
        error?: string;
      }>;
      serveDurangoWorkspace?: (input: { path: string; name: string; repo?: string }) => Promise<{
        ok: boolean;
        error?: string;
      }>;
      stopDurangoWorkspaceServer?: (input: { path: string; name: string; repo?: string }) => Promise<{
        ok: boolean;
        error?: string;
      }>;
      onDurangoWorkspaceServerExited?: (
        cb: (payload: { path: string; code: number; error: string | null }) => void
      ) => () => void;
      listSkills?: () => Promise<SkillsListResult>;
      /** Omit `paths` to let the user pick folders, SKILL.md files, or .zip archives. */
      importSkills?: (input?: { paths?: string[] }) => Promise<{
        ok: boolean;
        cancelled?: boolean;
        results: SkillImportResult[];
      }>;
      setSkillEnabled?: (input: { id: string; enabled: boolean }) => Promise<{ ok: boolean; error?: string }>;
      deleteSkill?: (input: { id: string; path: string; enabled: boolean; confirm?: boolean }) => Promise<{
        ok: boolean;
        cancelled?: boolean;
        error?: string;
      }>;
      revealSkill?: (input: { id: string; path: string; enabled: boolean }) => Promise<{ ok: boolean; error?: string }>;
      openSkillsFolder?: () => Promise<{ ok: boolean; error?: string }>;
      listMcps?: () => Promise<McpsListResult>;
      setMcpEnabled?: (input: { id: string; enabled: boolean }) => Promise<{ ok: boolean; error?: string }>;
      listOrionMcps?: () => Promise<OrionMcpsListResult>;
      listAccountConnectors?: () => Promise<AccountConnectorsListResult>;
      /** Signs in through the browser when the server requires OAuth, then lists its tools. */
      addOrionMcp?: (input: AddOrionMcpInput) => Promise<{
        ok: boolean;
        server?: OrionMcpEntry;
        tools?: string[];
        error?: string;
      }>;
      updateOrionMcp?: (input: {
        id: string;
        enabled?: boolean;
        nickname?: string;
      }) => Promise<{ ok: boolean; error?: string }>;
      removeOrionMcp?: (input: { id: string }) => Promise<{ ok: boolean; error?: string }>;
      reconnectOrionMcp?: (input: { id: string }) => Promise<{ ok: boolean; tools?: string[]; error?: string }>;
      cancelOrionMcpSignIn?: (input: { id?: string; operationId?: string }) => Promise<{ ok: boolean }>;
      /** `projectPaths` add each project's Claude Code `.mcp.json` servers. */
      /** `fresh: false` may reuse Codex's list from the last minute. */
      listProviderMcps?: (input?: { projectPaths?: string[]; fresh?: boolean }) => Promise<ProviderMcpsListResult>;
      /** Copies a provider-configured server into Orion (signing in through the browser if needed). */
      shareProviderMcp?: (input: { key: string; projectPaths?: string[]; operationId?: string }) => Promise<{
        ok: boolean;
        server?: OrionMcpEntry;
        tools?: string[];
        error?: string;
      }>;
      /** `roots` are project/workspace directories; servers outside them (and unattributed to a thread) are excluded. */
      listDevServers?: (input?: { roots?: string[] }) => Promise<DevServersListResult>;
      /** Usage view report built from the agents' session logs (see src/main/usage-stats.js). */
      usageReport?: (input: UsageReportInput) => Promise<{ ok: true; report: UsageReport } | { ok: false; error: string }>;
      /** Plan limits read live from the providers (src/main/provider-usage-limits.js). */
      usageLiveLimits?: (input?: { force?: boolean; providers?: string[] }) => Promise<{ ok: true; limits: LiveUsageLimits } | { ok: false; error: string }>;
      onUsageProgress?: (callback: (progress: UsageScanProgress) => void) => () => void;
      /** Opens a validated localhost HTTP URL for a listed dev-server port. */
      openDevServer?: (input: { port: number }) => Promise<{ ok: boolean; error?: string }>;
      /** `port` re-verifies each pid still holds it, so a stale row cannot kill a recycled pid. */
      killDevServers?: (input: { targets: Array<{ pid: number; port: number | null }> }) => Promise<{
        ok: boolean;
        results: DevServerKillOutcome[];
        error?: string;
      }>;
      getPathForFile?: (file: File) => string;
      saveAttachment: (input: {
        name: string;
        mimeType: string;
        data: ArrayBuffer;
      }) => Promise<{
        ok: boolean;
        attachment?: {
          id: string;
          name: string;
          path: string;
          mimeType: string;
          size: number;
        };
        error?: string;
      }>;
      /** @deprecated Restart compatibility for legacy renderer/main pairs. */
      saveImageAttachment?: NonNullable<Window['orion']>['saveAttachment'];
      listAgentModels: (input?: { force?: boolean }) => Promise<Array<{
        id: string;
        providerId: 'grok' | 'codex' | 'claude' | 'cursor' | 'kimi' | 'antigravity' | 'fx' | 'muse' | 'opencode';
        providerLabel: string;
        label: string;
        slug: string;
        shortcut?: string;
        favorite?: boolean;
        reasoningVariants?: string[];
        reasoningEfforts?: string[];
        defaultReasoningEffort?: string;
        available: boolean;
        unavailableReason?: string;
      }>>;
      onAgentModelsChanged?: (callback: () => void) => () => void;
      supportsThreadReader?: (providerId: string) => Promise<boolean>;
      /** read_thread's newest page of each thread, for a turn on another machine that mentions them. */
      readThreadsForMention?: (input: { threadIds: string[] }) => Promise<Array<{ threadId: string; text: string }>>;
      getProviderStatus: () => Promise<{
        checkedAt: string;
        updatesAvailable: number;
        providers: Array<{
          id: string;
          label: string;
          command: string;
          enabled: boolean;
          installed: boolean;
          path?: string | null;
          currentVersion?: string | null;
          latestVersion?: string | null;
          updateAvailable: boolean;
          status: 'available' | 'current' | 'unknown' | 'missing' | 'error';
          auth: {
            authenticated: boolean | null;
            status: 'authenticated' | 'unauthenticated' | 'unknown' | 'missing' | 'error';
            label: string;
            detail?: string;
          };
          error?: string;
        }>;
      }>;
      checkProviderUpdates: (input?: { enabledProviderIds?: string[] }) => Promise<{
        checkedAt: string;
        updatesAvailable: number;
        providers: Array<{
          id: string;
          label: string;
          command: string;
          enabled: boolean;
          installed: boolean;
          path?: string | null;
          currentVersion?: string | null;
          latestVersion?: string | null;
          updateAvailable: boolean;
          status: 'available' | 'current' | 'unknown' | 'missing' | 'error';
          auth: {
            authenticated: boolean | null;
            status: 'authenticated' | 'unauthenticated' | 'unknown' | 'missing' | 'error';
            label: string;
            detail?: string;
          };
          error?: string;
        }>;
      }>;
      updateProviders: (input?: { enabledProviderIds?: string[] }) => Promise<{
        ok: boolean;
        cancelled?: boolean;
        busy?: boolean;
        operationId?: string;
        error?: string;
        results: Array<{
          id: string;
          label: string;
          command: string;
          ok: boolean;
          cancelled?: boolean;
          skipped?: boolean;
          message?: string;
          output?: string;
          error?: string;
        }>;
        state: {
          checkedAt: string;
          updatesAvailable: number;
          providers: Array<{
            id: string;
            label: string;
            command: string;
            enabled: boolean;
            installed: boolean;
            path?: string | null;
            currentVersion?: string | null;
            latestVersion?: string | null;
            updateAvailable: boolean;
            status: 'available' | 'current' | 'unknown' | 'missing' | 'error';
            auth: {
              authenticated: boolean | null;
              status: 'authenticated' | 'unauthenticated' | 'unknown' | 'missing' | 'error';
              label: string;
              detail?: string;
            };
            error?: string;
          }>;
        };
      }>;
      getActiveProviderUpdate: () => Promise<ProviderUpdateProgress | null>;
      cancelProviderUpdate: (operationId?: string | null) => Promise<{
        ok: boolean;
        error?: string;
      }>;
      onProviderUpdateProgress: (
        callback: (event: ProviderUpdateProgress) => void
      ) => () => void;
      authenticateProvider: (providerId: string) => Promise<{
        ok: boolean;
        error?: string;
        /** The sign-in finishes on a page showing a code to paste back (Antigravity). */
        codeRequired?: boolean;
        url?: string;
      }>;
      submitProviderAuthCode?: (input: { providerId: string; code: string }) => Promise<{
        ok: boolean;
        error?: string;
      }>;
      cancelProviderAuth?: (providerId: string) => Promise<{ ok: boolean }>;
      onProviderAuthenticated: (
        callback: (event: { providerId: string }) => void
      ) => () => void;
      getFxConnections: () => Promise<{
        ok: boolean;
        error?: string;
        connections?: OrionFxConnections;
      }>;
      installFx: () => Promise<{ ok: boolean; path?: string; version?: string; error?: string }>;
      connectFx: (target: 'codex' | 'grok' | 'vercel') => Promise<{ ok: boolean; error?: string }>;
      disconnectFx: (target: 'codex' | 'grok' | 'vercel') => Promise<{ ok: boolean; error?: string }>;
      setFxGatewayApiKey: (key: string | null) => Promise<{ ok: boolean; error?: string }>;
      getAccountSession: () => Promise<OrionAccountState>;
      startAccountAuth: () => Promise<{
        ok: boolean;
        url?: string;
        error?: string;
      }>;
      signOutAccount: () => Promise<OrionAccountState>;
      getCloudState: (projectPath: string) => Promise<OrionCloudState>;
      publishToCloud: (input: { projectPath: string; name?: string }) => Promise<OrionCloudPushResult>;
      pushToCloud: (projectPath: string) => Promise<OrionCloudPushResult>;
      pullFromCloud: (projectPath: string) => Promise<OrionCloudPullResult>;
      openCloudRepoInBrowser: (projectPath: string) => Promise<{ ok: boolean; error?: string }>;
      deployToCloud: (projectPath: string) => Promise<OrionCloudDeployResult>;
      getCloudAppState: (projectPath: string) => Promise<OrionCloudAppStateResult>;
      openCloudAppInBrowser: (
        projectPath: string
      ) => Promise<{ ok: boolean; app?: OrionCloudApp | null; error?: string }>;
      precheckCloudDeploy: (projectPath: string) => Promise<OrionCloudDeployPrecheck>;
      listBoardTasks: () => Promise<OrionBoardResult>;
      getBoardTask: (taskId: string) => Promise<OrionTaskActionResult>;
      linkBoardTask: (input: {
        taskId: string;
        threadId: string;
        threadTitle?: string;
        projectName?: string;
      }) => Promise<OrionTaskActionResult>;
      unlinkBoardTask: (input: { taskId: string; threadId: string }) => Promise<OrionTaskActionResult>;
      updateBoardTaskThreadStatus: (input: {
        taskId: string;
        threadId: string;
        status: 'running' | 'finished' | 'done' | 'error';
        notes?: string;
      }) => Promise<OrionTaskActionResult>;
      /** Opens Durango Tasks (durango.sh/tasks) in the browser. */
      openBoardTasksWeb?: () => Promise<{ ok: boolean; error?: string }>;
      getDeviceSettings?: () => Promise<DeviceSettings>;
      setDeviceSettings?: (patch: Partial<DeviceSettings>) => Promise<DeviceSettings>;
      getDeviceStatus?: () => Promise<DeviceStatus>;
      installAgentDevice?: () => Promise<{ ok: boolean; error?: string; status: DeviceStatus }>;
      listDevices?: (input?: { platform?: DevicePlatform }) => Promise<{
        ok: boolean;
        error?: string;
        devices: DeviceInfo[];
        availability?: DeviceStatus['platforms'];
      }>;
      getOpenDevices?: (threadId: string) => Promise<OpenDevice[]>;
      screenshotDevice?: (input: { threadId: string; deviceId: string }) => Promise<{
        ok: boolean;
        error?: string;
        dataUrl?: string;
        takenAt?: number;
      }>;
      showDevice?: (input: { threadId: string; deviceId: string }) => Promise<{ ok: boolean; error?: string }>;
      closeDevice?: (input: { threadId: string; deviceId: string; shutdown?: boolean }) => Promise<{
        ok: boolean;
        error?: string;
      }>;
      closeThreadDevices?: (threadId: string) => Promise<{ ok: boolean }>;
      onDeviceEvent?: (callback: (event: DeviceEvent) => void) => () => void;
      getComputerUsePermissions: () => Promise<OrionComputerUsePermissions>;
      requestComputerUsePermission: (kind: OrionComputerUsePermissionKind) => Promise<{
        ok: boolean;
        error?: string;
        state?: OrionComputerUsePermissions;
      }>;
      openChromeDebugSetup: () => Promise<{ ok: boolean; error?: string }>;
      openExternalUrl: (url: string) => Promise<{ ok: boolean; error?: string }>;
      relaunchApp: () => Promise<boolean>;
      focusWindow: () => Promise<boolean>;
      /** Whether the app window itself is focused (a built-in browser tab with focus counts). */
      isWindowFocused?: () => Promise<boolean>;
      onWindowFocusChange?: (callback: (focused: boolean) => void) => () => void;
      getAppUpdateState: () => Promise<AppUpdateState>;
      checkForAppUpdate: (input?: { force?: boolean; background?: boolean }) => Promise<AppUpdateState>;
      downloadAppUpdate: () => Promise<AppUpdateState>;
      restartToUpdate: () => Promise<{ ok: boolean; error?: string }>;
      getWhatsNew?: () => Promise<WhatsNewState>;
      dismissWhatsNew?: () => Promise<{ ok: boolean }>;
      runAgentTurn: (input: {
        runId?: string;
        threadId: string;
        /** The transcript message the run writes to (forwarded to remote controllers). */
        outputMessageId?: string;
        projectPath: string;
        /** The thread's Durango Code project (its working directory may be a workspace outside it). */
        projectId?: string;
        prompt: string;
        /** Optional system-prompt appendix sent natively via ACP `_meta.antigravity.systemPrompt.append` when supported. */
        systemPromptAppend?: string;
        modelId: string;
        /** Image metadata used to build native ACP image blocks for Kimi turns. */
        attachments?: Array<{
          id: string;
          name: string;
          path: string;
          mimeType: string;
          size: number;
        }>;
        accessMode: 'read-only' | 'workspace-write' | 'auto' | 'full-access';
        codexReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
        codexServiceTier?: 'default' | 'priority';
        claudeReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode' | 'ultrathink';
        claudeContextWindow?: '200k' | '1m';
        grokReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
        museReasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
        antigravityReasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
        openCodeReasoningEffort?: string;
        resumeSessionId?: string;
        /** Fork resumeSessionId into a new session instead of resuming it in place (branched threads). */
        forkSession?: boolean;
        /** One-shot side question (/btw): never touches the thread's persistent claude session. */
        aside?: boolean;
        /**
         * A turn an agent sent (a spawn_subagent child, or machine_run_agent
         * from another machine): its non-blocking questions go to that agent
         * in the reply, not to the user.
         */
        spawnedSubagent?: boolean;
        /** Codex goal run (/goal): drive the turn over `codex app-server` and pursue the goal across turns. */
        codexGoal?: { action: 'set' | 'resume'; objective?: string; tokenBudget?: number };
        /** Preserved branch context used only when starting a fresh Codex goal thread. */
        codexInitialContext?: string;
        /** Codex code review (/review): run review/start inline on the current Codex session. */
        codexReview?: {
          mode: 'uncommitted' | 'base' | 'commit' | 'custom';
          base?: string;
          commit?: string;
          instructions?: string;
          /** Recent Orion transcript supplied because the dedicated reviewer does not inherit it. */
          threadContext?: string;
        };
        providerOptions?: {
          allowedTools?: string;
          networkAccess?: boolean;
          webSearch?: boolean;
          codexMemoryMode?: 'inherit' | 'enabled' | 'disabled';
          codexContextManagementMode?: 'inherit' | 'enabled' | 'disabled' | 'codex';
          codexChronicleMode?: 'inherit' | 'enabled' | 'disabled';
          codexMemoryExternalContextMode?: 'inherit' | 'enabled' | 'disabled';
          codexPersonality?: 'inherit' | 'none' | 'friendly' | 'pragmatic';
          codexDeveloperInstructions?: string;
          experimentalMemory?: boolean;
          chrome?: boolean;
          browserControl?: boolean;
          browserAutoConnect?: boolean;
          browserUseMode?: 'disabled' | 'builtin' | 'extension' | 'mcp';
          browser?: 'builtin' | 'chrome' | 'off';
          extraArgs?: string;
        };
        /** Set when the thread runs the Orion pseudo-model: the roles it may delegate to. */
        orchestration?: {
          isOrchestrator: boolean;
          roles: Array<{ role: string; roleLabel: string; modelId: string; providerId: string; slug: string; modelLabel: string }>;
          generalInstructions: string;
        };
        /** @-mentioned models the agent may delegate to directly. */
        mentions?: Array<{ modelId: string; providerId: string; slug: string; label: string }>;
        /** True when prompt context contains resolvable @thread references and requires read_thread. */
        hasThreadMentions?: boolean;
        /** The prompt @-mentions Durango chats, so the run needs read_chat. */
        hasChatMentions?: boolean;
        /** Orion MCP servers attached to the thread (loaded even when switched off). */
        mcpServerIds?: string[];
      }) => Promise<{ ok: boolean; runId?: string; error?: string }>;
      /**
       * Steer: deliver a follow-up into the run in flight without interrupting
       * it (claude folds a mid-turn user message into the running turn, like
       * typing while Claude Code works). False = no live mid-turn channel holds
       * this run — queue the message for end-of-turn dispatch instead.
       */
      steerAgentTurn?: (runId: string, text: string, attachments?: Array<{ path: string; mimeType?: string }>) => Promise<boolean>;
      getClaudeQuestions?: (threadId: string) => Promise<import('./app/CodexQuestions').CodexQuestionRequest[]>;
      answerClaudeQuestions?: (runId: string, requestId: string | number, answers: Record<string, string[]>) => Promise<boolean>;
      getCodexQuestions?: (threadId: string) => Promise<import('./app/CodexQuestions').CodexQuestionRequest[]>;
      answerCodexQuestions?: (runId: string, requestId: string | number, answers: Record<string, string[]>, text?: string) => Promise<boolean | 'delivered'>;
      /** Stop only a completed Claude turn's remaining local shell tasks and settle its runtime. */
      discardClaudeBackgroundShellTasks?: (runId: string) => Promise<{
        ok: boolean;
        alreadySettled?: boolean;
        tasks?: string[];
        error?: string;
      }>;
      stopAgentTurn: (
        runId: string,
        /** terminateBackground: also dispose the thread's persistent claude session (kills background subagents). */
        options?: { terminateBackground?: boolean }
      ) => Promise<boolean>;
      /** Provider slash commands (Claude built-ins + skills/plugins, or Antigravity advertised commands + skills) known for a thread/project. */
      listSlashCommands: (input: {
        threadId?: string | null;
        projectPath?: string | null;
        providerId?: string | null;
      }) => Promise<{
        ok: boolean;
        commands?: SlashCommandInfo[];
        source?: 'live' | 'cache' | 'harvest';
      }>;
      /** Push of the latest slash-command list whenever a Claude or Antigravity session reports one. Replace, don't merge. */
      onSlashCommands: (
        cb: (event: { projectPath: string; providerId?: string; commands: SlashCommandInfo[] }) => void
      ) => () => void;
      /** `/clear`: dispose only the thread's persistent Claude SDK session so the next turn starts fresh. */
      clearClaudeSession: (threadId: string) => Promise<boolean>;
      /** True while a forgotten run's terminal event is still being prepared. */
      isRunFinalizing?: (runId: string) => Promise<boolean>;
      /** Dispose any persistent agent runtime owned by a deleted thread. */
      disposeAgentThread: (threadId: string) => Promise<boolean>;
      /** Claude Code CLI embedded terminal (one PTY per thread, lives in main). */
      terminalEnsure: (input: {
        threadId: string;
        projectPath: string;
        accessMode: 'read-only' | 'workspace-write' | 'auto' | 'full-access';
        /** Resume this CLI session instead of starting fresh (--resume). */
        resumeSessionId?: string;
        cols?: number;
        rows?: number;
        /** Kill any existing PTY and start a brand-new session. */
        fresh?: boolean;
        /** Restart an exited PTY, optionally resuming resumeSessionId. */
        restart?: boolean;
        /** Resume the inherited session into a new id for a branched thread. */
        forkSession?: boolean;
        /** Orion's general instructions, appended to the CLI's system prompt at spawn. */
        generalInstructions?: string;
      }) => Promise<{
        ok: boolean;
        /** True when an already-running PTY was reattached instead of spawned. */
        reattached?: boolean;
        /** The session id known so far (resume id, or one discovered by the watcher). */
        claudeSessionId?: string | null;
        /** Scrollback to replay into a freshly mounted terminal view. */
        snapshot?: string;
        /** Seq of the last data event included in the snapshot. */
        seq?: number;
        /** True when the retained PTY exited and awaits an explicit restart. */
        exited?: boolean;
        exitCode?: number | null;
        error?: string;
      }>;
      terminalInput: (input: { threadId: string; data: string }) => Promise<boolean>;
      terminalResize: (input: { threadId: string; cols: number; rows: number }) => Promise<boolean>;
      terminalSendPrompt: (input: { threadId: string; text: string }) => Promise<{ ok: boolean; error?: string }>;
      terminalKill: (threadId: string) => Promise<boolean>;
      onTerminalData: (cb: (event: { threadId: string; data: string; seq: number }) => void) => () => void;
      onTerminalExit: (cb: (event: { threadId: string; exitCode: number | null }) => void) => () => void;
      onTerminalActivity: (cb: (event: {
        threadId: string;
        kind: 'started' | 'prompt' | 'turn-complete';
      }) => void) => () => void;
      /** The thread's live claude CLI session id, discovered from claude's session store. */
      onTerminalSession: (cb: (event: { threadId: string; sessionId: string }) => void) => () => void;
      generateThreadTitle: (input: {
        threadId: string;
        prompt: string;
        modelId: string;
        /** Reasoning tier for the hidden turn; null falls back to the cheapest. */
        reasoningEffort?: string | null;
        projectPath?: string;
      }) => Promise<string>;
      /** Plain-English explanation of a tool call waiting for approval (text-generation model). */
      explainApproval?: (input: {
        key: string;
        threadId: string;
        approval: import('./app/CodexQuestions').ToolApproval;
        modelId: string;
        reasoningEffort?: string | null;
        projectPath?: string;
      }) => Promise<import('./app/CodexQuestions').ApprovalExplanation | null>;
      findProjectIcon: (projectPath: string) => Promise<string | null>;
      listOpenWithApps: () => Promise<Array<{ id: string; name: string; icon: string | null }>>;
      openProjectWith: (input: { appId: string; projectPath: string }) => Promise<{ ok: boolean; error?: string }>;
      basename: (p: string) => Promise<string>;
      dirname: (p: string) => Promise<string>;
      join: (...parts: string[]) => Promise<string>;
      onAgentTurnEvent?: (cb: (event: {
        runId: string;
        threadId: string;
        type: 'started' | 'chunk' | 'activity' | 'session' | 'error' | 'done' | 'goal' | 'background-settled' | 'subagent' | 'subagent-chunk' | 'subagent-activity' | 'user-input' | 'prompt-suggestion' | 'session-broken';
        /** prompt-suggestion events only: the agent's predicted next user prompt for this thread. */
        suggestion?: string;
        /** started events only: the persistent claude session opened this turn itself (background task finished). */
        background?: boolean;
        /** subagent events: lifecycle upsert for a provider-native subagent of this thread's run. */
        subagent?: {
          id: string;
          providerId: string;
          status: 'running' | 'done' | 'error' | 'stopped';
          title?: string;
          /** Subagent type/role (Explore, general-purpose, codex nickname role, …). */
          kind?: string;
          model?: string;
          reasoningEffort?: string;
          prompt?: string;
          summary?: string;
          /** Provider id of the subagent that spawned this one, when it was not the run's own thread. */
          parentSubagentId?: string;
          startedAt?: number;
          completedAt?: number;
          stats?: { totalTokens?: number };
        };
        /** subagent-chunk / subagent-activity events: which subagent the payload belongs to. */
        subagentId?: string;
        /** done events only: descriptions of background tasks (subagents, workflows, backgrounded shell commands) still running when the turn ended — the thread stays in the working state until they settle. */
        pendingBackgroundTasks?: string[];
        /** Claude done events only: present when every pending task is a local shell process that the user may safely discard. */
        pendingBackgroundShellTasks?: string[];
        chunk?: string;
        exitCode?: number | null;
        error?: string;
        /** error events only: true when the failure is transient and can be resumed/retried cleanly. */
        retryable?: boolean;
        /** error events only: whether a one-click resume should send 'Continue.' or resend the prompt. */
        resumeWith?: 'continue' | 'retry';
        command?: string;
        providerId?: string;
        sessionId?: string;
        changedFiles?: Array<{
          path: string;
          status: 'added' | 'copied' | 'conflicted' | 'deleted' | 'modified' | 'renamed' | 'untracked';
          additions: number;
          deletions: number;
        }>;
        stats?: {
          totalTokens?: number;
          inputTokens?: number;
          outputTokens?: number;
          cachedReadTokens?: number;
          reasoningTokens?: number;
          contextTokens?: number;
          contextWindow?: number;
          modelId?: string;
        };
        activity?: {
          key?: string;
          type: 'thought' | 'command' | 'tool' | 'result' | 'error' | 'plan';
          kind?: string;
          title: string;
          detail?: string;
          /** Append-only reasoning payload; the renderer folds it into detail. */
          detailDelta?: string;
          input?: string;
          output?: string;
          exitCode?: number;
          diff?: { path: string; additions: number; deletions: number; patch?: string };
          sources?: Array<{ url: string; title?: string }>;
          plan?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>;
          status?: 'running' | 'done' | 'error' | 'waiting';
        };
        /** goal events: the codex goal's latest state (null after clear). */
        goal?: import('./store').ThreadGoal | null;
      }) => void) => () => void;
      /** Codex goal ops (pause/clear/status refresh) when no goal run is live. */
      codexGoalCommand: (input: {
        sessionId: string;
        threadId: string;
        projectPath: string;
        action: 'pause' | 'clear' | 'get';
      }) => Promise<{ ok: boolean; goal?: import('./store').ThreadGoal | null; error?: string }>;
      reportSubagentResult(payload: { spawnId: string; ok: boolean; result: string }): Promise<void>;
      onSubagentSpawnRequest(callback: (request: SubagentSpawnRequest) => void): () => void;
      // Background spawns (main/background-subagents.js): the subthread
      // started, so the driver's spawn_subagent call can return.
      reportSubagentStarted?(payload: { spawnId: string; childThreadId: string; title: string; model: string }): Promise<{ ok: boolean }>;
      // Reports a driver thread never collected, as the text of a message to it ('' when none).
      takeSubagentReports?(threadId: string): Promise<{ text: string }>;
      onSubagentReportsReady?(callback: (payload: { threadId: string }) => void): () => void;
      reportSubagentStopResult(payload: { stopId: string; ok: boolean; result: string }): Promise<void>;
      onSubagentStopRequest(callback: (request: SubagentStopRequest) => void): () => void;
      browser?: OrionBrowserApi;
      onBrowserState?: (callback: (state: OrionBrowserState) => void) => () => void;
      onUserAction?: (
        callback: (
          request:
            | {
                type: 'request';
                threadId: string;
                id: string;
                action: string;
                url?: string;
                check?: string;
                cwd?: string;
                autoWatch?: boolean;
                secret?: import('./store').UserActionSecret;
              }
            | { type: 'resolve'; threadId: string; id?: string; source?: 'secret' }
            | { type: 'detected' | 'watch-stopped'; threadId: string; id: string }
            | { type: 'undelivered'; threadId: string; texts: string[] }
        ) => void
      ) => () => void;
      notifyAgentTurn?: (input: {
        threadId: string;
        runId?: string;
        providerId?: string;
        text: string;
        notice?: { title: string; detail?: string };
      }) => Promise<boolean>;
      watchUserAction?: (input: { threadId: string; id: string; check: string; cwd?: string }) => Promise<boolean>;
      unwatchUserAction?: (input: { threadId: string; id: string }) => Promise<boolean>;
      answerSecretRequest?: (input: {
        threadId: string;
        id: string;
        answer: { type: 'save'; value: string } | { type: 'decline' };
      }) => Promise<{ ok: boolean; ended?: boolean; error?: string }>;
      listSecretRequests?: () => Promise<{ id: string; threadId: string }[]>;
      onFileChange?: (cb: (data: { path: string; exists: boolean; mtimeMs: number | null }) => void) => () => void;
      onAppUpdateState?: (cb: (state: AppUpdateState) => void) => () => void;
      onAccountChanged?: (cb: (state: OrionAccountState) => void) => () => void;
      durangoSearchChats?: (input: {
        query: string;
        limit?: number;
        cursor?: string;
      }) => Promise<DurangoSearchChatsResult>;
      durangoOpenChat?: (input: { chatId: string; url?: string | null }) => Promise<{ ok: boolean; error?: string }>;
      getBotsMode?: () => Promise<import('./app/bots').BotsModeResult>;
      listBots?: () => Promise<import('./app/bots').BotsListResult>;
      setBotModel?: (input: { botId: string; model?: string; reasoningEffort?: string | null }) => Promise<import('./app/bots').SetBotModelResult>;
      renameBot?: (input: { botId: string; name: string }) => Promise<import('./app/bots').RenameBotResult>;
      updateBot?: (input: import('./app/bots').UpdateBotInput) => Promise<import('./app/bots').UpdateBotResult>;
      setBotProjectPrimary?: (input: { botId: string }) => Promise<import('./app/bots').SetBotProjectPrimaryResult>;
      deleteBot?: (input: { botId: string }) => Promise<import('./app/bots').DeleteBotResult>;
      clearBot?: (input: { botId: string }) => Promise<import('./app/bots').ClearBotResult>;
      getBotThread?: (input: { botId: string; limit?: number; read?: boolean; beforeSeq?: number; afterSeq?: number }) => Promise<import('./app/bots').BotThreadResult>;
      createBot?: (input: import('./app/bots').CreateBotInput) => Promise<import('./app/bots').EnsureProjectBotResult>;
      ensureProjectBot?: (input: { projectId: string }) => Promise<import('./app/bots').EnsureProjectBotResult>;
      createProjectBot?: (input: import('./app/bots').CreateProjectBotInput) => Promise<import('./app/bots').EnsureProjectBotResult>;
      getBotProject?: (input: import('./app/bots').BotProjectTarget) => Promise<import('./app/bots').BotProjectResult>;
      botProjectAction?: (
        input: import('./app/bots').BotProjectTarget &
          (
            | { action: 'add_note'; content: string }
            | { action: 'delete_note'; noteId: string }
            | { action: 'add_files' }
            | { action: 'add_file_paths'; paths: string[] }
            | { action: 'delete_file'; fileId: string; name: string }
            | { action: 'open_file'; name: string; url?: string | null }
          )
      ) => Promise<{ ok: boolean; error?: string; duplicate?: boolean; added?: string[] }>;
      sendBotMessage?: (input: {
        botId: string;
        messageId: string;
        content: string;
        timeZone?: string;
        /** Files attached (paths on this computer). */
        files?: import('./app/bots').BotAttachmentFile[];
      }) => Promise<{
        ok: boolean;
        seq?: number;
        pendingAttachments?: import('./app/bots').BotAttachmentUploadStatus[];
        error?: string;
        code?: string;
      }>;
      getBotAttachmentStatuses?: (input?: {
        botId?: string;
      }) => Promise<{ ok: boolean; items?: import('./app/bots').BotAttachmentUploadStatus[]; error?: string }>;
      retryBotAttachmentUpload?: (input: {
        botId: string;
        messageId: string;
        pendingId: string;
      }) => Promise<{ ok: boolean; item?: import('./app/bots').BotAttachmentUploadStatus; error?: string }>;
      onBotAttachmentStatus?: (callback: (status: import('./app/bots').BotAttachmentUploadStatus) => void) => () => void;
      pickBotAttachments?: () => Promise<{ ok: boolean; files?: import('./app/bots').BotAttachmentFile[]; error?: string }>;
      saveBotAttachment?: (input: { name: string; data: string }) => Promise<{ ok: boolean; file?: import('./app/bots').BotAttachmentFile; error?: string }>;
      /** Read links (an hour) for library files in bot threads, by id (signed in). */
      botFileLinks?: (input: { ids: string[] }) => Promise<{ ok: boolean; files?: import('./app/bots').BotFileLink[]; error?: string }>;
      botRefs?: (input: { changes: string[]; threads: string[] }) => Promise<{ ok: boolean; error?: string } & Partial<import('./app/botRefs').BotRefs>>;
      takeThreadOpenRequest?: () => Promise<string | null>;
      onThreadOpenRequest?: (callback: (threadId: string) => void) => () => void;
      /**
       * A bot reply's Ship button (confirm first). With `threadId`: the ship request goes to the
       * thread that made the change (`notHere` when that thread isn't on this computer).
       * Without: lands the change like the thread header's Land.
       */
      shipBotChange?: (input: { changeId: string; threadId?: string }) => Promise<{
        ok: boolean;
        via?: 'thread';
        threadId?: string;
        notHere?: boolean;
        changeId?: string | null;
        url?: string | null;
        error?: string;
        exitCode?: number;
      }>;
      /** A bot reply's View change button. */
      openBotChange?: (input: { changeId: string; url?: string }) => Promise<{ ok: boolean; error?: string }>;
      durangoProfileMemory?: () => Promise<{
        ok: boolean;
        code?: DurangoErrorCode;
        error?: string;
        block: string;
      }>;
      durangoConfigure?: (input: {
        useDurangoTasks: boolean;
        dispatch: DurangoDispatchSettingsInput;
        deployWatcher: DurangoDeployWatcherSettingsInput;
        /** Durango bots on this computer (Settings → Durango; main: bot-replies.js). */
        bots?: { enabled: boolean; accessMode: 'read-only' | 'workspace-write' | 'full-access' };
        projects: Array<{ id: string; name: string; path: string }>;
      }) => Promise<{ ok: boolean; state?: DurangoDispatchState; deployWatcherState?: DurangoDeployWatcherState }>;
      durangoDispatchState?: () => Promise<DurangoDispatchState>;
      durangoDeployWatcherState?: () => Promise<DurangoDeployWatcherState>;
      durangoOpenDeployLog?: (input: { log: string }) => Promise<{ ok: boolean; error?: string }>;
      onDurangoDeployWatcherState?: (cb: (state: DurangoDeployWatcherState) => void) => () => void;
      durangoDispatchSettled?: (input: {
        dispatchId: string;
        threadId: string;
        /** The thread's Durango workspace: a bot task's report names the change it holds. */
        workspacePath?: string;
        outcome: 'finished' | 'failed';
        summary?: string;
        error?: string;
        /** The turn ended, but the thread still waits on these (it reports again when it resumes). */
        waiting?: string[];
        /** The report's sequence number (two per agent run, odd while waiting): later reports have higher ones. */
        seq?: number;
      }) => Promise<{ ok: boolean; skipped?: boolean; retry?: boolean }>;
      /**
       * A dispatched thread (a bot's task) still runs but needs the person
       * (`input`: an approval, a question, an action) or looks stuck: tells
       * whoever started it now. One notice per `key`.
       */
      durangoDispatchNotice?: (input: {
        dispatchId: string;
        threadId: string;
        kind: 'input' | 'stuck';
        key: string;
        /** The live run's final report sequence number (a notice for a run already reported is dropped). */
        seq: number;
        detail: string;
      }) => Promise<{ ok: boolean; skipped?: boolean; retry?: boolean }>;
      onDurangoDispatchState?: (cb: (state: DurangoDispatchState) => void) => () => void;
      onDurangoFocusThread?: (cb: (payload: { threadId: string }) => void) => () => void;
      workspaceSyncConfigure?: (
        settings: OrionWorkspaceSyncSettings
      ) => Promise<OrionWorkspaceSyncStatus>;
      workspaceSyncNow?: () => Promise<OrionWorkspaceSyncStatus>;
      workspaceSyncGetState?: () => Promise<OrionWorkspaceSyncStatus>;
      onWorkspaceSyncState?: (cb: (state: OrionWorkspaceSyncStatus) => void) => () => void;
      // SnapShot (Settings > Computer Use > SnapShot, macOS)
      snapShotConfigure?: (settings: import('./store').SnapShotSettings) => Promise<OrionSnapShotState>;
      snapShotGetState?: () => Promise<OrionSnapShotState>;
      snapShotTakePending?: () => Promise<import('./store').FileAttachment[]>;
      snapShotCaptureNow?: () => Promise<{ ok: boolean; count?: number; error?: string }>;
      onSnapShotAvailable?: (cb: () => void) => () => void;
      onSnapShotState?: (cb: (state: OrionSnapShotState) => void) => () => void;
      onSnapShotError?: (cb: (error: { message: string; at: string }) => void) => () => void;
      // Remote control (Settings > Remote Control, sidebar Machines section)
      remoteControlGetState?: () => Promise<RemoteControlState>;
      remoteControlConfigure?: (settings: {
        enabled: boolean;
        allowIncoming: boolean;
        port: number;
        connectionMode: 'direct' | 'relay';
      }) => Promise<{ ok: boolean }>;
      remoteStartPairing?: () => Promise<{
        ok: boolean;
        code?: string;
        expiresAt?: string;
        addresses?: string[];
        port?: number;
        error?: string;
        needsAuth?: boolean;
      }>;
      remoteCancelPairing?: () => Promise<{ ok: boolean }>;
      remoteRevokeDevice?: (input: { deviceId: string }) => Promise<{ ok: boolean; error?: string }>;
      remoteRelayDeregister?: () => Promise<{ ok: boolean; error?: string }>;
      remotePair?: (input: {
        /** Direct mode: the host's address and port. */
        host?: string;
        port?: number;
        /** Internet mode: a specific machine. Omit it (and host) to find the machine by its code. */
        machineId?: string;
        code: string;
      }) => Promise<{ ok: boolean; machine?: { id: string; name: string }; error?: string; needsAuth?: boolean }>;
      remoteRemoveMachine?: (input: { machineId: string }) => Promise<{ ok: boolean; error?: string }>;
      remoteConnectMachine?: (input: { machineId: string }) => Promise<{ ok: boolean; error?: string }>;
      remoteDisconnectMachine?: (input: { machineId: string }) => Promise<{ ok: boolean }>;
      remoteFetchSnapshot?: (input: {
        machineId: string;
      }) => Promise<{ ok: boolean; snapshot?: RemoteSnapshot; error?: string }>;
      remoteFetchThread?: (input: {
        machineId: string;
        threadId: string;
        /** The storedVersion of the copy this machine has: an unchanged thread isn't sent again. */
        knownVersion?: string;
      }) => Promise<{
        ok: boolean;
        thread?: import('./store').ThreadRecord;
        unchanged?: boolean;
        storedVersion?: string;
        /** Its and its subagents' pending user actions there. */
        pendingUserActions?: import('./store').UserAction[];
        /** Settled, snoozed and pinned there, as of `thread` (absent from older hosts). */
        sidebarState?: import('./store').ThreadSidebarState;
        error?: string;
      }>;
      /**
       * Ask a paired host to clone a Durango Source repository it doesn't have
       * (and add it as a project) before a remoteRunTurn in it.
       */
      remoteCheckoutSource?: (input: {
        machineId: string;
        repoId: string;
        name?: string;
      }) => Promise<{ ok: boolean; projectId?: string; error?: string }>;
      /**
       * The project on a paired machine a thread from `project` runs in: its
       * Source repository there (cloned if missing), else one of the same name.
       */
      remoteResolveProject?: (input: {
        machineId: string;
        project: { id: string; name: string; path: string } | null;
      }) => Promise<{ ok: boolean; projectId?: string; projectName?: string; error?: string }>;
      remoteListThreads?: (input: {
        machineId: string;
      }) => Promise<{ ok: boolean; threads?: RemoteListedThread[]; error?: string }>;
      /** A local copy of one of a paired machine's attachments. */
      remoteFetchAttachment?: (input: { machineId: string; path: string }) => Promise<{ ok: boolean; path?: string; error?: string }>;
      /** Start sending a prompt-box file to the machine its thread runs on. */
      remotePrepareUpload?: (input: {
        machineId: string;
        attachment: { id: string; name: string; path: string; mimeType?: string; size?: number };
      }) => Promise<{ ok: boolean; error?: string }>;
      /** Stop sending it (taken out of the prompt box, or the thread moved). */
      remoteCancelUpload?: (input: { machineId: string; path: string }) => Promise<{ ok: boolean }>;
      remoteListUploads?: () => Promise<RemoteUploadProgress[]>;
      onRemoteUploadProgress?: (cb: (progress: RemoteUploadProgress) => void) => () => void;
      /** The branch (and workspace) a paired machine's thread works in. */
      remoteThreadGit?: (input: { machineId: string; threadId: string }) => Promise<{
        ok: boolean;
        branch?: string | null;
        detachedHead?: string | null;
        workspaceName?: string | null;
        dirty?: boolean;
        error?: string;
      }>;
      /** The threads of that machine shown here: their live streams come through. */
      remoteFollowThreads?: (input: { machineId: string; threadIds: string[] }) => Promise<{ ok: boolean; error?: string }>;
      /** The questions and approvals a paired machine's thread waits on there. */
      remoteListQuestions?: (input: {
        machineId: string;
        threadId: string;
      }) => Promise<{ ok: boolean; questions?: import('./app/CodexQuestions').CodexQuestionRequest[]; error?: string }>;
      remoteAnswerQuestion?: (input: {
        machineId: string;
        threadId: string;
        runId: string;
        requestId: string | number;
        answers: Record<string, string[]>;
      }) => Promise<{ ok: boolean; error?: string }>;
      /** Done / Reply / Dismiss / Watch on an action a paired machine's thread asked for. */
      remoteUserAction?: (input: {
        machineId: string;
        threadId: string;
        actionId: string;
        op: 'done' | 'reply' | 'dismiss' | 'watch' | 'secret';
        reply?: string;
        attachments?: import('./store').FileAttachment[];
        watching?: boolean;
        /** op 'secret': the answer to a request_secret card (sent to that machine only). */
        secretAnswer?: { type: 'save'; value: string } | { type: 'decline' };
      }) => Promise<{ ok: boolean; error?: string }>;
      /** Settle, snooze or pin (null = undo) a host thread like its mirror here. */
      remoteThreadState?: (input: {
        machineId: string;
        threadId: string;
        state: import('./store').ThreadSidebarState;
      }) => Promise<{ ok: boolean; error?: string }>;
      remoteRunTurn?: (input: {
        machineId: string;
        threadId?: string;
        projectId?: string;
        /** Local files to send along; they are uploaded to that machine first. */
        attachments?: import('./store').FileAttachment[];
        modelId?: string;
        accessMode?: 'read-only' | 'workspace-write' | 'full-access';
        reasoningEffort?:
          | 'low'
          | 'default'
          | 'none'
          | 'minimal'
          | 'medium'
          | 'high'
          | 'xhigh'
          | 'ultra'
          | 'max'
          | 'ultracode'
          | 'ultrathink';
        codexServiceTier?: 'default' | 'priority';
        claudeContextWindow?: '200k' | '1m';
        prompt: string;
        /** Agent context the transcript there doesn't show (mentioned threads it can't read). */
        context?: string;
        /** Echoed in a `turnClaimed` remote event once that machine has the turn's thread. */
        turnKey?: string;
      }) => Promise<{
        ok: boolean;
        threadId?: string;
        /** Where each attachment landed on that machine. */
        attachments?: Array<{ hostPath: string; localPath: string }>;
        error?: string;
      }>;
      remoteStopTurn?: (input: {
        machineId: string;
        threadId: string;
      }) => Promise<{ ok: boolean; error?: string }>;
      /** Message into a host thread's running turn; ok = it is in the turn. */
      remoteSteerTurn?: (input: {
        machineId: string;
        threadId: string;
        prompt: string;
        attachments?: import('./store').FileAttachment[];
      }) => Promise<{ ok: boolean; error?: string }>;
      remoteRendererReady?: () => Promise<{ ok: boolean }>;
      remoteClaimCommand?: (input: { commandId: string; threadId?: string }) => Promise<{ ok: boolean }>;
      reportRemoteCommandResult?: (payload: {
        commandId: string;
        ok: boolean;
        threadId?: string;
        threadTitle?: string;
        projectId?: string;
        modelId?: string;
        reasoningEffort?: string;
        accessMode?: 'read-only' | 'workspace-write' | 'full-access';
        mirrored?: boolean;
        error?: string;
      }) => Promise<{ ok: boolean }>;
      onRemoteState?: (cb: (state: RemoteControlState) => void) => () => void;
      onRemoteEvent?: (cb: (event: RemoteEvent) => void) => () => void;
      /** A run a paired controller follows ended here: save the threads now. */
      onRemoteFlushThreads?: (cb: () => void) => () => void;
      onRemoteCommandRequest?: (cb: (request: RemoteCommandRequest) => void) => () => void;
    };
  }
}
