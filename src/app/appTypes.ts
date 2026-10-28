export type GitBranchInfo = {
  name: string;
  current: boolean;
  hasUpstream: boolean;
};

export type GitRepoState = {
  ok: boolean;
  isGitRepository?: boolean;
  root?: string;
  originUrl?: string | null;
  sourceProvider?: 'github' | 'orion' | 'other' | 'none';
  githubMirrorUrl?: string | null;
  currentBranch?: string | null;
  detachedHead?: string | null;
  branches: GitBranchInfo[];
  hasUncommittedChanges: boolean;
  ahead?: number;
  behind?: number;
  error?: string;
};

export type ProviderUpdateItem = {
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
};

export type ProviderUpdateState = {
  checkedAt: string;
  updatesAvailable: number;
  providers: ProviderUpdateItem[];
};

export type ProviderUpdateProgress = {
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

export type AppUpdateState = {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'restarting' | 'not-available' | 'error';
  currentVersion: string;
  checkedAt?: string | null;
  availableVersion?: string | null;
  /** What changed in availableVersion, one line per change. */
  releaseNotes?: string[] | null;
  progress?: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  } | null;
  error?: string | null;
};

/** This version's release notes, and whether its "What's new" is still due. */
export type WhatsNewState = {
  version: string;
  notes: string[];
  unseen: boolean;
};

export type OrionAccountState = {
  authenticated: boolean;
  user: {
    id: string;
    email?: string | null;
    name?: string | null;
    imageUrl?: string | null;
  } | null;
  expiresAt: string | null;
};

/**
 * Workspace sync engine status pushed from main (sync:state). Null until the
 * first status arrives; the engine is inert while the setting is off.
 */
export type WorkspaceSyncStatus = {
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

export type SettingsTab =
  | 'account'
  | 'cloud-sync'
  | 'deployments'
  | 'remote-control'
  | 'general'
  | 'providers'
  | 'orchestration'
  | 'skills'
  | 'split-view'
  | 'computer-use'
  | 'dev-servers'
  | 'workspaces'
  | 'cosmetics'
  | 'experimental';
