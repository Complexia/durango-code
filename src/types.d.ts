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
    status: 'open' | 'queued' | 'landed' | 'abandoned' | null;
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
  error: string | null;
};

/** Engine state pushed from main over remote:state. */
export type RemoteControlState = {
  available: boolean;
  /** Set when pairings cannot be read or persisted at all on this machine. */
  error?: string | null;
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
  title: string;
  status: 'idle' | 'running' | 'done' | 'error';
  modelId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type RemoteSnapshot = {
  machine: { id: string; name: string };
  capturedAt: string;
  projects: Array<{ id: string; name: string; path: string }>;
  threads: RemoteThreadMeta[];
};

/** Push from a controlled host, forwarded to the controller's renderer. */
export type RemoteEvent = {
  machineId: string;
  kind: 'turnEvent' | 'workspaceChanged';
  payload: { threadId?: string; runId?: string; type?: string } | null;
};

// A paired controller asked this (host) machine to run or stop a turn; the
// renderer executes it exactly like a local user action and reports back via
// reportRemoteCommandResult.
export type RemoteCommandRequest = {
  commandId: string;
  /** Main-process startup deadline, checked around renderer-side preparation. */
  expiresAt: number;
  command: {
    kind: 'runTurn' | 'stopTurn';
    prompt?: string;
    threadId?: string;
    projectId?: string;
    modelId?: string;
    accessMode?: 'read-only' | 'workspace-write' | 'full-access';
    /**
     * Provider-agnostic reasoning effort. Main drops unknown values; the
     * renderer maps the rest onto codex/claude/grok thread fields for the
     * turn's model.
     */
    reasoningEffort?:
      | 'low'
      | 'medium'
      | 'high'
      | 'xhigh'
      | 'ultra'
      | 'max'
      | 'ultracode'
      | 'ultrathink';
    /** Codex-only service tier. Ignored for other providers. */
    codexServiceTier?: 'default' | 'priority';
    /** Claude-only context window. Ignored for other providers. */
    claudeContextWindow?: '200k' | '1m';
    source?: { machineId: string; machineName: string };
    /**
     * Set when Durango Chat started this run (dispatch worker in main): the
     * renderer creates the thread exactly like a remote runTurn, links the
     * task, and adds a visible "started remotely" note.
     */
    durangoDispatch?: {
      id: string;
      /** Started from a chat, or with Run in Durango Code on a task. */
      origin?: 'chat' | 'tasks';
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

  interface Window {
    orion: {
      loadStore: () => Promise<string | null>;
      saveStore: (value: string) => Promise<boolean>;
      /** Blocking quit-time flush — see preload. */
      saveStoreSync?: (value: string) => boolean;
      /** Startup transcripts the first frame shows, as JSON text. ok:false suppresses thread persistence. */
      loadThreadsHead?: (input?: { count?: number; ids?: string[] }) => Promise<{ ok: boolean; value?: string }>;
      /** The remaining transcripts by id, in bounded batches, as JSON text. */
      loadThreadsBatch?: (input: { ids: string[]; maxBytes?: number }) => Promise<{ ok: boolean; value?: string }>;
      saveThreads: (value: {
        version: 2;
        upserts: import('./store').Thread[];
        deletes: string[];
        order: string[];
      }) => Promise<boolean>;
      /** Blocking quit-time flush — see preload. */
      saveThreadsSync?: (value: {
        version: 2;
        upserts: import('./store').Thread[];
        deletes: string[];
        order: string[];
      }) => boolean;
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
      /** Zooms the whole window (Settings → Cosmetics → Text size). */
      setZoomFactor?: (factor: number) => void;
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
      createDurangoWorkspace?: (input: { projectPath: string; name: string }) => Promise<{
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
        providerId: 'grok' | 'codex' | 'claude' | 'cursor' | 'kimi' | 'fx' | 'muse' | 'opencode';
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
      }>;
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
      getAppUpdateState: () => Promise<AppUpdateState>;
      checkForAppUpdate: (input?: { force?: boolean; background?: boolean }) => Promise<AppUpdateState>;
      downloadAppUpdate: () => Promise<AppUpdateState>;
      restartToUpdate: () => Promise<{ ok: boolean; error?: string }>;
      getWhatsNew?: () => Promise<WhatsNewState>;
      dismissWhatsNew?: () => Promise<{ ok: boolean }>;
      runAgentTurn: (input: {
        runId?: string;
        threadId: string;
        projectPath: string;
        prompt: string;
        modelId: string;
        /** Image metadata used to build native ACP image blocks for Kimi turns. */
        attachments?: Array<{
          id: string;
          name: string;
          path: string;
          mimeType: string;
          size: number;
        }>;
        accessMode: 'read-only' | 'workspace-write' | 'full-access';
        codexReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
        codexServiceTier?: 'default' | 'priority';
        claudeReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode' | 'ultrathink';
        claudeContextWindow?: '200k' | '1m';
        grokReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
        museReasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
        openCodeReasoningEffort?: string;
        resumeSessionId?: string;
        /** Fork resumeSessionId into a new session instead of resuming it in place (branched threads). */
        forkSession?: boolean;
        /** One-shot side question (/btw): never touches the thread's persistent claude session. */
        aside?: boolean;
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
          browserUseMode?: 'disabled' | 'extension' | 'mcp';
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
      /** Claude slash commands (built-ins + .claude/commands + skills + plugins) known for a thread/project. */
      listSlashCommands: (input: { threadId?: string | null; projectPath?: string | null }) => Promise<{
        ok: boolean;
        commands?: SlashCommandInfo[];
        source?: 'live' | 'cache' | 'harvest';
      }>;
      /** Push of the latest slash-command list whenever a Claude session reports one. Replace, don't merge. */
      onSlashCommands: (cb: (event: { projectPath: string; commands: SlashCommandInfo[] }) => void) => () => void;
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
        accessMode: 'read-only' | 'workspace-write' | 'full-access';
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
      findProjectIcon: (projectPath: string) => Promise<string | null>;
      listOpenWithApps: () => Promise<Array<{ id: string; name: string; icon: string | null }>>;
      openProjectWith: (input: { appId: string; projectPath: string }) => Promise<{ ok: boolean; error?: string }>;
      basename: (p: string) => Promise<string>;
      dirname: (p: string) => Promise<string>;
      join: (...parts: string[]) => Promise<string>;
      onAgentTurnEvent?: (cb: (event: {
        runId: string;
        threadId: string;
        type: 'started' | 'chunk' | 'activity' | 'session' | 'error' | 'done' | 'goal' | 'background-settled' | 'subagent' | 'subagent-chunk' | 'subagent-activity' | 'user-input';
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
          diff?: { path: string; additions: number; deletions: number };
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
      reportSubagentStopResult(payload: { stopId: string; ok: boolean; result: string }): Promise<void>;
      onSubagentStopRequest(callback: (request: SubagentStopRequest) => void): () => void;
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
              }
            | { type: 'resolve'; threadId: string; id?: string }
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
      onFileChange?: (cb: (data: { path: string; exists: boolean; mtimeMs: number | null }) => void) => () => void;
      onAppUpdateState?: (cb: (state: AppUpdateState) => void) => () => void;
      onAccountChanged?: (cb: (state: OrionAccountState) => void) => () => void;
      durangoSearchChats?: (input: {
        query: string;
        limit?: number;
        cursor?: string;
      }) => Promise<DurangoSearchChatsResult>;
      durangoOpenChat?: (input: { chatId: string; url?: string | null }) => Promise<{ ok: boolean; error?: string }>;
      durangoProfileMemory?: () => Promise<{
        ok: boolean;
        code?: DurangoErrorCode;
        error?: string;
        block: string;
      }>;
      durangoConfigure?: (input: {
        useDurangoTasks: boolean;
        dispatch: DurangoDispatchSettingsInput;
        projects: Array<{ id: string; name: string; path: string }>;
      }) => Promise<{ ok: boolean; state?: DurangoDispatchState }>;
      durangoDispatchState?: () => Promise<DurangoDispatchState>;
      durangoDispatchSettled?: (input: {
        dispatchId: string;
        threadId: string;
        outcome: 'finished' | 'failed';
        summary?: string;
        error?: string;
      }) => Promise<{ ok: boolean; skipped?: boolean }>;
      onDurangoDispatchState?: (cb: (state: DurangoDispatchState) => void) => () => void;
      onDurangoFocusThread?: (cb: (payload: { threadId: string }) => void) => () => void;
      workspaceSyncConfigure?: (
        settings: OrionWorkspaceSyncSettings
      ) => Promise<OrionWorkspaceSyncStatus>;
      workspaceSyncNow?: () => Promise<OrionWorkspaceSyncStatus>;
      workspaceSyncGetState?: () => Promise<OrionWorkspaceSyncStatus>;
      onWorkspaceSyncState?: (cb: (state: OrionWorkspaceSyncStatus) => void) => () => void;
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
        /** Internet mode: the host's machine ID, used instead of host/port. */
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
      }) => Promise<{ ok: boolean; thread?: import('./store').Thread; error?: string }>;
      remoteRunTurn?: (input: {
        machineId: string;
        threadId?: string;
        projectId?: string;
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
      }) => Promise<{ ok: boolean; threadId?: string; error?: string }>;
      remoteStopTurn?: (input: {
        machineId: string;
        threadId: string;
      }) => Promise<{ ok: boolean; error?: string }>;
      remoteRendererReady?: () => Promise<{ ok: boolean }>;
      remoteClaimCommand?: (input: { commandId: string }) => Promise<{ ok: boolean }>;
      reportRemoteCommandResult?: (payload: {
        commandId: string;
        ok: boolean;
        threadId?: string;
        error?: string;
      }) => Promise<{ ok: boolean }>;
      onRemoteState?: (cb: (state: RemoteControlState) => void) => () => void;
      onRemoteEvent?: (cb: (event: RemoteEvent) => void) => () => void;
      onRemoteCommandRequest?: (cb: (request: RemoteCommandRequest) => void) => () => void;
    };
  }
}
