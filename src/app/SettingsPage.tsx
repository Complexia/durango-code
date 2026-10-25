import React from 'react';
import {
  Cast,
  ChevronDown,
  Cloud,
  Columns2,
  FlaskConical,
  FolderGit2,
  GitPullRequest,
  LogIn,
  LogOut,
  MousePointerClick,
  Palette,
  Play,
  Plug,
  RefreshCw,
  Rocket,
  Server,
  Settings,
  Sparkles,
  Square,
  SquareArrowOutUpRight,
  SquareKanban,
  Trash2,
  UserRound,
  Workflow,
} from 'lucide-react';
import {
  defaultDurangoSettings,
  defaultEpicsSettings,
  useOrionStore,
  defaultSplitViewSettings,
  MAX_THREAD_PANES,
  type BrowserUseMode,
  type DeploymentSettings,
  type Epic,
  type EpicsSettings,
  type NotificationSettings,
  type OrchestrationRoleId,
  type OrchestrationSettings,
  type ProviderId,
  type ProviderRuntimeOptions,
  type ProviderSettings,
  type RemoteControlSettings as RemoteControlSettingsValue,
  type SavedView,
  type SplitViewSettings,
  type TextGenerationSettings,
  type WorkspaceSyncSettings,
} from '../store';
import {
  agentProviders,
  providerOptionDefs,
  type AgentModel,
  type AgentProvider,
  type AgentProviderId,
} from '../agentCatalog';
import { ModelPickerPopover } from './ModelPickerPopover';
import { SelectMenu } from './SelectMenu';
import { DurangoDispatchSettings } from './DurangoDispatchSettings';
import SkillsSettings from './SkillsSettings';
import McpsSettings from './McpsSettings';
import DeploymentsSettings from './DeploymentsSettings';
import DevServersSettings from './DevServersSettings';
import WorkspacesSettings from './WorkspacesSettings';
import RemoteControlSettings from './RemoteControlSettings';
import { orchestrationRoleMeta } from './promptContext';
import { formatShortTime } from './time';
import type {
  AppUpdateState,
  EpicPrStatus,
  OrionAccountState,
  ProviderUpdateItem,
  ProviderUpdateProgress,
  ProviderUpdateState,
  SettingsTab,
  WorkspaceSyncStatus,
} from './appTypes';

const ARCHIVED_EPICS_COLLAPSED_LIMIT = 5;
const CODEX_BROWSER_EXTENSION_URL =
  'https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg';

// Settings remains controlled by App because its asynchronous account and
// update operations are shared with the shell. Keeping that integration in a
// single view model avoids creating a second set of store subscriptions here.
export type SettingsPageProps = {
  notificationSettings: NotificationSettings;
  setNotificationSettings: (updates: Partial<NotificationSettings>) => void;
  setTextGenerationSettings: (updates: Partial<TextGenerationSettings>) => void;
  setEpicsSettings: (updates: Partial<EpicsSettings>) => void;
  epicsSettings: EpicsSettings;
  splitViewSettings: SplitViewSettings;
  setSplitViewSettings: (updates: Partial<SplitViewSettings>) => void;
  savedViews: SavedView[];
  deleteSavedView: (id: string) => void;
  providerSettings: ProviderSettings;
  setProviderEnabled: (id: ProviderId, enabled: boolean) => void;
  setProviderOptions: (id: ProviderId, options: Partial<ProviderRuntimeOptions>) => void;
  setOrchestrationRoleModel: (role: OrchestrationRoleId, modelId: string) => void;
  setOrchestrationGeneralInstructions: (text: string) => void;
  workspaceSyncSettings: WorkspaceSyncSettings;
  setWorkspaceSyncSettings: (updates: Partial<WorkspaceSyncSettings>) => void;
  remoteControlSettings: RemoteControlSettingsValue;
  setRemoteControlSettings: (updates: Partial<RemoteControlSettingsValue>) => void;
  deploymentSettings: DeploymentSettings;
  setDeploymentSettings: (updates: Partial<DeploymentSettings>) => void;
  resolvedDeploymentModel: AgentModel | null;
  resolvedDeploymentModelId: string | null;
  deploymentReasoningOptions: Array<{ value: string; label: string }>;
  resolvedDeploymentReasoningEffort: string | null;
  cloudApp: OrionCloudApp | null;
  handleOpenCloudApp: () => void;
  workspaceSyncStatus: WorkspaceSyncStatus | null;
  handleWorkspaceSyncNow: () => void;
  setUtilityModelPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  utilityModelPickerOpen: boolean;
  setUtilityModelSearch: React.Dispatch<React.SetStateAction<string>>;
  utilityModelSearch: string;
  setUtilityModelTab: React.Dispatch<React.SetStateAction<AgentProviderId>>;
  utilityModelTab: AgentProviderId;
  providerUpdateState: ProviderUpdateState | null;
  providerUpdatesChecking: boolean;
  providerUpdatesRunning: boolean;
  providerUpdateProgress: ProviderUpdateProgress | null;
  appUpdateState: AppUpdateState | null;
  appUpdateBusy: boolean;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  settingsTab: SettingsTab;
  setSettingsTab: React.Dispatch<React.SetStateAction<SettingsTab>>;
  /** Opens a skill's folder in the Code tab with its SKILL.md active. */
  handleOpenSkillInEditor: (skill: { path: string; skillFile?: string; name: string }) => void;
  authenticatingProviderId: string | null;
  accountState: OrionAccountState;
  accountLoading: boolean;
  accountBusy: boolean;
  computerUsePerms: OrionComputerUsePermissions | null;
  computerUseBusyKind: OrionComputerUsePermissionKind | null;
  revealedProviderEmails: Record<string, boolean>;
  setRevealedProviderEmails: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setRevealedAccountIdentity: React.Dispatch<React.SetStateAction<string | null>>;
  expandedProviderOptions: Record<string, boolean>;
  setExpandedProviderOptions: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  utilityModelPickerRef: React.RefObject<HTMLDivElement | null>;
  normalizedProviderSettings: ProviderSettings;
  normalizedOrchestrationSettings: OrchestrationSettings;
  orchestrationModelGroups: Array<{ provider: AgentProvider; models: AgentModel[] }>;
  providerStatusById: Map<string, ProviderUpdateItem>;
  accountName: string;
  accountEmail: string | null;
  accountIdentity: string | null;
  accountEmailRevealed: boolean;
  accountInitials: string;
  epicsEnabled: boolean;
  epicPromptGitMessages: boolean;
  archivedEpics: Epic[];
  utilityCandidateModels: AgentModel[];
  utilityProviders: AgentProvider[];
  resolvedUtilityModelId: string | null;
  resolvedUtilityModel: AgentModel | null;
  utilityModelProviderId: AgentProviderId | null;
  utilityReasoningOptions: Array<{ value: string; label: string }>;
  resolvedUtilityReasoningEffort: string | null;
  refreshProviderUpdates: () => Promise<void>;
  handleUpdateProviders: () => Promise<void>;
  handleCancelProviderUpdate: () => Promise<void>;
  handleAppUpdateClick: () => Promise<void>;
  handleRequestComputerUsePermission: (kind: OrionComputerUsePermissionKind) => Promise<void>;
  handleOpenChromeDebugSetup: () => Promise<void>;
  handleStartAccountAuth: () => Promise<void>;
  handleSignOutAccount: () => Promise<void>;
  handleAuthenticateProvider: (providerId: string) => Promise<void>;
  openEpicPrUrl: (prUrl: string) => void;
  handleDeleteEpic: (epic: Epic) => void;
  handleRestoreEpic: (epic: Epic) => void;
  formatCheckedTime: (iso: string) => string;
  formatBytes: (bytes: number | null | undefined) => string;
  epicPrStatus: (epic: Pick<Epic, 'prUrl' | 'prState'> | null | undefined) => EpicPrStatus | null;
};

const SettingsPage = React.memo(function SettingsPage(props: SettingsPageProps) {
  const {
    notificationSettings,
    setNotificationSettings,
    setTextGenerationSettings,
    setEpicsSettings,
    epicsSettings,
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
    epicsEnabled,
    epicPromptGitMessages,
    archivedEpics,
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
    handleOpenChromeDebugSetup,
    handleStartAccountAuth,
    handleSignOutAccount,
    handleAuthenticateProvider,
    openEpicPrUrl,
    handleDeleteEpic,
    handleRestoreEpic,
    formatCheckedTime,
    formatBytes,
    epicPrStatus,
  } = props;
  const [archivedEpicsExpanded, setArchivedEpicsExpanded] = React.useState(false);
  const [computerUseSubtab, setComputerUseSubtab] = React.useState<'permissions' | 'browser-use'>('permissions');
  const [skillsAndMcpsSubtab, setSkillsAndMcpsSubtab] = React.useState<'skills' | 'mcps'>('skills');
  const visibleArchivedEpics = archivedEpicsExpanded
    ? archivedEpics
    : archivedEpics.slice(0, ARCHIVED_EPICS_COLLAPSED_LIMIT);
  const hiddenArchivedEpicCount = Math.max(0, archivedEpics.length - ARCHIVED_EPICS_COLLAPSED_LIMIT);
  const configuredCodexBrowserMode = providerSettings.codex?.options?.browserUseMode;
  const codexBrowserMode: BrowserUseMode =
    configuredCodexBrowserMode === 'disabled' ||
    configuredCodexBrowserMode === 'extension' ||
    configuredCodexBrowserMode === 'mcp'
      ? configuredCodexBrowserMode
      : providerSettings.codex?.options?.browserControl === true &&
          providerSettings.codex?.options?.browserAutoConnect === true
        ? 'mcp'
        : 'disabled';
  const codexBrowserIntegration = computerUsePerms?.browserUse.codex ?? null;
  const chromeDebugStatus = computerUsePerms?.chromeDebug.status ?? 'disabled';
  const appUpdatePercent = Math.max(0, Math.min(100, Math.round(appUpdateState?.progress?.percent ?? 0)));
  const appUpdateStatus =
    appUpdateState?.status === 'checking'
      ? 'Checking for updates...'
      : appUpdateState?.status === 'available'
        ? `Durango Code v${appUpdateState.availableVersion ?? 'next'} is available.`
        : appUpdateState?.status === 'downloading'
          ? `Downloading Durango Code v${appUpdateState.availableVersion ?? 'next'} — ${appUpdatePercent}%`
          : appUpdateState?.status === 'downloaded'
            ? `Durango Code v${appUpdateState.availableVersion ?? 'next'} is ready to install.`
            : appUpdateState?.status === 'restarting'
              ? 'Restarting Durango Code to install the update...'
              : appUpdateState?.status === 'not-available'
                ? `Durango Code is up to date.${
                    appUpdateState.checkedAt ? ` Checked ${formatCheckedTime(appUpdateState.checkedAt)}.` : ''
                  }`
                : appUpdateState?.status === 'error'
                  ? (appUpdateState.error ?? 'Could not check for updates.')
                  : 'Check for a newer version of Durango Code.';
  const appUpdateActionLabel =
    appUpdateState?.status === 'checking'
      ? 'Checking...'
      : appUpdateState?.status === 'available'
        ? appUpdateState.availableVersion
          ? `Update to v${appUpdateState.availableVersion}`
          : 'Update Durango Code'
        : appUpdateState?.status === 'downloading'
          ? `Downloading ${appUpdatePercent}%`
          : appUpdateState?.status === 'downloaded'
            ? 'Restart to update'
            : appUpdateState?.status === 'restarting'
              ? 'Restarting...'
              : appUpdateState?.status === 'error'
                ? 'Try again'
                : 'Check for updates';
  const appUpdateActionDisabled =
    !appUpdateState ||
    appUpdateBusy ||
    appUpdateState.status === 'checking' ||
    appUpdateState.status === 'downloading' ||
    appUpdateState.status === 'restarting';
  const providerUpdateActive =
    providerUpdateProgress?.status === 'running' || providerUpdateProgress?.status === 'cancelling';
  const providerUpdateCancellable = providerUpdateActive;
  const providerProgressPercent =
    typeof providerUpdateProgress?.percent === 'number'
      ? Math.max(0, Math.min(100, providerUpdateProgress.percent))
      : null;
  const providerBatchProgress = providerUpdateProgress?.total
    ? `${Math.min(providerUpdateProgress.current + (providerUpdateActive ? 1 : 0), providerUpdateProgress.total)} of ${providerUpdateProgress.total}`
    : null;
  const providerProgressActivityLabel =
    providerUpdateProgress?.phase === 'checking'
      ? 'Checking…'
      : providerUpdateProgress?.phase === 'starting'
        ? 'Preparing…'
        : providerUpdateProgress?.phase === 'installing'
          ? 'Installing…'
          : providerUpdateProgress?.phase === 'verifying'
            ? 'Verifying…'
            : providerUpdateProgress?.phase === 'downloading'
              ? 'Downloading…'
              : 'Updating…';

  return (
    <div className="settings-page">
      <div className="settings-sidebar">
        <div className="settings-sidebar-header">
          <Settings size={16} />
          <span>Settings</span>
        </div>
        <div className="settings-nav">
          {[
            { id: 'account', label: 'Account', Icon: UserRound },
            { id: 'cloud-sync', label: 'Durango', Icon: Cloud },
            { id: 'deployments', label: 'Deployments', Icon: Rocket },
            { id: 'remote-control', label: 'Remote Control', Icon: Cast },
            { id: 'general', label: 'General', Icon: Settings },
            { id: 'providers', label: 'Providers', Icon: Plug },
            { id: 'orchestration', label: 'Orchestration', Icon: Workflow },
            { id: 'skills', label: 'Skills & MCPs', Icon: Sparkles },
            { id: 'split-view', label: 'Split View', Icon: Columns2 },
            {
              id: 'computer-use',
              label: 'Computer Use',
              Icon: MousePointerClick,
            },
            { id: 'dev-servers', label: 'Dev Servers', Icon: Server },
            { id: 'workspaces', label: 'Workspaces', Icon: FolderGit2 },
            { id: 'cosmetics', label: 'Cosmetics', Icon: Palette },
            { id: 'experimental', label: 'Experimental', Icon: FlaskConical },
          ].map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              className={`settings-nav-item ${settingsTab === id ? 'active' : ''}`}
              onClick={() => setSettingsTab(id as SettingsTab)}
            >
              <Icon size={15} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="settings-sidebar-footer">
          <button type="button" className="settings-back-button" onClick={() => setSettingsOpen(false)}>
            ← Back
          </button>
        </div>
      </div>

      <div className="settings-content">
        <div className="settings-content-header">
          {settingsTab === 'account' && 'ACCOUNT'}
          {settingsTab === 'cloud-sync' && 'DURANGO'}
          {settingsTab === 'deployments' && 'DEPLOYMENTS'}
          {settingsTab === 'remote-control' && 'REMOTE CONTROL'}
          {settingsTab === 'general' && 'GENERAL'}
          {settingsTab === 'providers' && 'PROVIDERS'}
          {settingsTab === 'orchestration' && 'ORCHESTRATION'}
          {settingsTab === 'skills' && 'SKILLS & MCPS'}
          {settingsTab === 'split-view' && 'SPLIT VIEW'}
          {settingsTab === 'computer-use' && 'COMPUTER USE'}
          {settingsTab === 'dev-servers' && 'DEV SERVERS'}
          {settingsTab === 'workspaces' && 'WORKSPACES'}
          {settingsTab === 'cosmetics' && 'COSMETICS'}
          {settingsTab === 'experimental' && 'EXPERIMENTAL'}
        </div>

        <div
          className={`settings-panel${settingsTab === 'general' || settingsTab === 'experimental' || settingsTab === 'workspaces' || settingsTab === 'skills' || settingsTab === 'dev-servers' || settingsTab === 'remote-control' ? ' settings-panel-grouped' : ''}`}
        >
          {settingsTab === 'account' && (
            <>
              <div className="account-row">
                <div className="account-card-main">
                  {accountState.user?.imageUrl ? (
                    <img className="account-avatar" src={accountState.user.imageUrl} alt="" aria-hidden />
                  ) : (
                    <div className="account-avatar account-avatar-fallback">{accountInitials || 'D'}</div>
                  )}
                  <div className="account-card-text">
                    <div className="account-card-title">{accountName}</div>
                    <div className="account-card-subtitle">
                      {accountLoading ? (
                        'Checking Durango account...'
                      ) : accountState.authenticated ? (
                        accountEmail ? (
                          <button
                            type="button"
                            className={`account-email-toggle${accountEmailRevealed ? ' revealed' : ''}`}
                            onClick={() =>
                              setRevealedAccountIdentity((current) =>
                                current === accountIdentity ? null : accountIdentity
                              )
                            }
                            title={accountEmailRevealed ? 'Click to hide email' : 'Click to reveal email'}
                            aria-label={accountEmailRevealed ? 'Hide email address' : 'Reveal email address'}
                          >
                            {accountEmail}
                          </button>
                        ) : (
                          'Signed in to your Durango account'
                        )
                      ) : (
                        'Sign in to your Durango account to authorize this desktop app.'
                      )}
                    </div>
                  </div>
                </div>
                <span className={`account-status-chip ${accountState.authenticated ? 'signed-in' : ''}`}>
                  {accountLoading ? 'Checking' : accountState.authenticated ? 'Signed in' : 'Signed out'}
                </span>
              </div>

              {accountState.authenticated && (
                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Desktop session</div>
                    <div className="setting-label-desc">
                      Authorized by Durango Code web
                      {accountState.expiresAt ? ` until ${formatCheckedTime(accountState.expiresAt)}` : ''}.
                    </div>
                  </div>
                  <button
                    type="button"
                    className="provider-auth-button"
                    onClick={handleSignOutAccount}
                    disabled={accountBusy}
                  >
                    <LogOut size={13} />
                    Sign out
                  </button>
                </div>
              )}

              {!accountState.authenticated && (
                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Sign in to your Durango account</div>
                    <div className="setting-label-desc">
                      Opens Durango Code web in your browser and returns here after approval.
                    </div>
                  </div>
                  <button
                    type="button"
                    className="provider-auth-button account-primary-button"
                    onClick={handleStartAccountAuth}
                    disabled={accountBusy || accountLoading}
                  >
                    <LogIn size={13} />
                    {accountBusy ? 'Opening...' : 'Sign in'}
                  </button>
                </div>
              )}
            </>
          )}

          {settingsTab === 'cloud-sync' && (
            <>
              <div className="setting-row">
                <div className="setting-label">
                  <div className="setting-label-title">Share coding work with Durango</div>
                  <div className="setting-label-desc">
                    On by default. Your projects, epics, threads (full transcripts including every
                    agent step and tool call), and token usage sync to your Durango account, and code
                    syncs through Durango Cloud repos (below). Durango Chat uses summaries of this
                    work for its memory, so it can answer questions like “what did I ship this
                    week?”. Browse everything at Durango Code web → Usage. Turn this off to stop all
                    syncing from this device.
                    {!accountState.authenticated &&
                      (workspaceSyncSettings.enabled
                        ? ' Sharing is paused while signed out. You can turn it off now or sign in to resume.'
                        : ' Sign in on the Account tab to turn it on.')}
                  </div>
                </div>
                <label
                  className="provider-toggle"
                  title={
                    accountState.authenticated
                      ? 'Share threads, transcripts, usage, and code with your Durango account'
                      : workspaceSyncSettings.enabled
                        ? 'Turn off sharing coding work with Durango'
                        : 'Sign in to your Durango account first'
                  }
                >
                  <input
                    type="checkbox"
                    checked={workspaceSyncSettings.enabled}
                    disabled={!accountState.authenticated && !workspaceSyncSettings.enabled}
                    onChange={(e) =>
                      // Any explicit choice also settles the one-time notice.
                      setWorkspaceSyncSettings({ enabled: e.target.checked, consentNoticeSeen: true })
                    }
                  />
                  <span />
                </label>
              </div>

              <div className="setting-row">
                <div className="setting-label">
                  <div className="setting-label-title">Sync code to Durango Cloud</div>
                  <div className="setting-label-desc">
                    Publish each git project as a private Durango Cloud repo. New commits sync as
                    immutable save points with full history and diffs; uncommitted file changes are
                    never uploaded or deployed.
                  </div>
                </div>
                <label className="provider-toggle" title="Auto-publish and push git projects">
                  <input
                    type="checkbox"
                    checked={workspaceSyncSettings.syncCode}
                    disabled={!accountState.authenticated || !workspaceSyncSettings.enabled}
                    onChange={(e) => setWorkspaceSyncSettings({ syncCode: e.target.checked })}
                  />
                  <span />
                </label>
              </div>

              {workspaceSyncSettings.enabled && accountState.authenticated && (
                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Status</div>
                    <div className="setting-label-desc">
                      {workspaceSyncStatus?.lastError
                        ? `Last sync failed: ${workspaceSyncStatus.lastError}`
                        : workspaceSyncStatus?.syncing
                          ? workspaceSyncStatus.backfillDone
                            ? 'Syncing…'
                            : 'Backfilling existing projects and threads…'
                          : workspaceSyncStatus?.lastSyncAt
                            ? `Synced ${formatCheckedTime(workspaceSyncStatus.lastSyncAt)}${
                                workspaceSyncStatus.counts
                                  ? ` — ${workspaceSyncStatus.counts.threads} threads, ${workspaceSyncStatus.counts.projects} projects`
                                  : ''
                              }`
                            : 'Waiting for first sync.'}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="provider-auth-button"
                    onClick={handleWorkspaceSyncNow}
                    disabled={Boolean(workspaceSyncStatus?.syncing)}
                  >
                    <RefreshCw size={13} />
                    {workspaceSyncStatus?.syncing ? 'Syncing…' : 'Sync now'}
                  </button>
                </div>
              )}

              <DurangoProfileMemorySetting authenticated={accountState.authenticated} />
              <DurangoDispatchSettings
                authenticated={accountState.authenticated}
                modelGroups={orchestrationModelGroups}
              />
            </>
          )}

          {settingsTab === 'general' && (
            <>
              <div className="settings-group-label">Appearance</div>
              <div className="settings-group">
                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Theme</div>
                    <div className="setting-label-desc">Choose how Durango Code looks across the app. Coming soon.</div>
                  </div>
                  <select className="setting-select" defaultValue="system" disabled>
                    <option value="system">System</option>
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                  </select>
                </div>

                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Time format</div>
                    <div className="setting-label-desc">
                      System default follows your browser or OS clock preference. Coming soon.
                    </div>
                  </div>
                  <select className="setting-select" defaultValue="system" disabled>
                    <option value="system">System default</option>
                    <option value="12h">12-hour</option>
                    <option value="24h">24-hour</option>
                  </select>
                </div>
              </div>

              <div className="settings-group-label">Content</div>
              <div className="settings-group">
                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Word wrap</div>
                    <div className="setting-label-desc">
                      Wrap long lines in code blocks, tables, diffs, and file previews by default. Coming soon.
                    </div>
                  </div>
                  <label className="provider-toggle" title="Word wrap">
                    <input type="checkbox" defaultChecked disabled />
                    <span />
                  </label>
                </div>

                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Hide whitespace changes</div>
                    <div className="setting-label-desc">
                      Set whether the diff panel ignores whitespace-only edits by default. Coming soon.
                    </div>
                  </div>
                  <label className="provider-toggle" title="Hide whitespace">
                    <input type="checkbox" defaultChecked disabled />
                    <span />
                  </label>
                </div>

                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Assistant output</div>
                    <div className="setting-label-desc">
                      Show token-by-token output while a response is in progress. Coming soon.
                    </div>
                  </div>
                  <label className="provider-toggle" title="Assistant output">
                    <input type="checkbox" disabled />
                    <span />
                  </label>
                </div>
              </div>

              <div className="settings-group-label">Notifications</div>
              <div className="settings-group">
                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Thread notifications</div>
                    <div className="setting-label-desc">
                      Show a desktop notification when an agent thread finishes while you're looking elsewhere.
                    </div>
                  </div>
                  <label className="provider-toggle" title="Thread notifications">
                    <input
                      type="checkbox"
                      checked={notificationSettings?.enabled ?? true}
                      onChange={(e) => setNotificationSettings({ enabled: e.target.checked })}
                    />
                    <span />
                  </label>
                </div>

                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Notification sound</div>
                    <div className="setting-label-desc">Play the system sound with thread-finished notifications.</div>
                  </div>
                  <label className="provider-toggle" title="Notification sound">
                    <input
                      type="checkbox"
                      checked={notificationSettings?.sound ?? true}
                      disabled={!(notificationSettings?.enabled ?? true)}
                      onChange={(e) => setNotificationSettings({ sound: e.target.checked })}
                    />
                    <span />
                  </label>
                </div>
              </div>

              <div className="settings-group-label">Threads</div>
              <div className="settings-group">
                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">New threads</div>
                    <div className="setting-label-desc">
                      Pick the default workspace mode for newly created draft threads. Coming soon.
                    </div>
                  </div>
                  <select className="setting-select" defaultValue="local" disabled>
                    <option value="local">Local</option>
                    <option value="remote">Remote</option>
                  </select>
                </div>

                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Archive confirmation</div>
                    <div className="setting-label-desc">
                      Require a second click on the inline archive action before a thread is archived. Coming soon.
                    </div>
                  </div>
                  <label className="provider-toggle" title="Archive confirmation">
                    <input type="checkbox" disabled />
                    <span />
                  </label>
                </div>

                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Delete confirmation</div>
                    <div className="setting-label-desc">
                      Ask before deleting a thread and its chat history. Coming soon.
                    </div>
                  </div>
                  <label className="provider-toggle" title="Delete confirmation">
                    <input type="checkbox" defaultChecked disabled />
                    <span />
                  </label>
                </div>
              </div>

              <div className="settings-group-label">Providers</div>
              <div className="settings-group">
                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Provider update checks</div>
                    <div className="setting-label-desc">
                      Check installed provider CLIs for newer available versions. Coming soon.
                    </div>
                  </div>
                  <label className="provider-toggle" title="Provider update checks">
                    <input type="checkbox" defaultChecked disabled />
                    <span />
                  </label>
                </div>
              </div>

              <div className="settings-group-label">Text generation</div>
              <div className="settings-group settings-group-overflowing">
                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Model</div>
                    <div className="setting-label-desc">
                      Writes Durango Code's short generated text: thread titles, epic commit messages from staged changes, and
                      PR descriptions from branch changes. Defaults to GPT-6 Luna, then Claude Haiku 5.5, when
                      installed.
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="model-picker-anchor" ref={utilityModelPickerRef}>
                      <button
                        className="model-trigger"
                        onClick={() => {
                          setUtilityModelPickerOpen((open) => {
                            if (!open) {
                              setUtilityModelSearch('');
                              // Open on the resolved model's provider, or the
                              // first one with rows if nothing resolved.
                              setUtilityModelTab(utilityModelProviderId ?? utilityProviders[0]?.id ?? 'codex');
                            }
                            return !open;
                          });
                        }}
                      >
                        {resolvedUtilityModel &&
                          (() => {
                            const ProviderIcon =
                              agentProviders.find((provider) => provider.id === resolvedUtilityModel.providerId)
                                ?.icon ?? Play;
                            return <ProviderIcon size={15} />;
                          })()}
                        <span>{resolvedUtilityModel?.label ?? 'Choose a model'}</span>
                        <ChevronDown
                          size={14}
                          className={`model-trigger-chevron ${utilityModelPickerOpen ? 'open' : ''}`}
                        />
                      </button>

                      {utilityModelPickerOpen && (
                        <ModelPickerPopover
                          placement="below"
                          className="compact"
                          providers={utilityProviders}
                          models={utilityCandidateModels}
                          activeProviderId={utilityModelTab}
                          onActiveProviderChange={setUtilityModelTab}
                          search={utilityModelSearch}
                          onSearchChange={setUtilityModelSearch}
                          selectedModelId={resolvedUtilityModelId}
                          onSelect={(model) => {
                            setTextGenerationSettings({ modelId: model.id });
                            setUtilityModelPickerOpen(false);
                            setUtilityModelSearch('');
                          }}
                        />
                      )}
                    </div>

                    {utilityReasoningOptions.length > 0 && (
                      <SelectMenu
                        label="Reasoning effort"
                        value={resolvedUtilityReasoningEffort}
                        options={utilityReasoningOptions}
                        onChange={(value) => setTextGenerationSettings({ reasoningEffort: value })}
                      />
                    )}
                  </div>
                </div>
              </div>

              <div className="settings-group-label">Epics</div>
              <div className="settings-group">
                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Epics section</div>
                    <div className="setting-label-desc">
                      Show Epics in the sidebar — big-ticket tasks that group threads and can commit, push, and open PRs
                      for the work as a whole.
                    </div>
                  </div>
                  <label className="provider-toggle" title="Epics section">
                    <input
                      type="checkbox"
                      checked={epicsEnabled}
                      onChange={(e) => setEpicsSettings({ enabled: e.target.checked })}
                    />
                    <span />
                  </label>
                </div>

                {epicsEnabled && (
                  <div className="setting-row">
                    <div className="setting-label">
                      <div className="setting-label-title">Settle confirmation</div>
                      <div className="setting-label-desc">
                        Ask before every settlement. Durango Code still warns when work may be archived without a commit, push,
                        or pull request.
                      </div>
                    </div>
                    <label className="provider-toggle" title="Settle confirmation">
                      <input
                        type="checkbox"
                        checked={epicsSettings?.confirmSettle ?? defaultEpicsSettings.confirmSettle}
                        onChange={(e) => setEpicsSettings({ confirmSettle: e.target.checked })}
                      />
                      <span />
                    </label>
                  </div>
                )}

                {epicsEnabled && archivedEpics.length > 0 && (
                  <div className="setting-row setting-row-stacked">
                    <div className="setting-label">
                      <div className="setting-label-title">Archived epics</div>
                      <div className="setting-label-desc">
                        Settled epics land here. Restore one to bring it back to the sidebar.
                      </div>
                    </div>
                    <div className="archived-epics-list">
                      <div id="settings-archived-epics-list" className="archived-epics-items">
                        {visibleArchivedEpics.map((epic) => {
                          const prStatus = epicPrStatus(epic);
                          return (
                            <div key={epic.id} className="archived-epic-row">
                              <SquareKanban
                                size={13}
                                className={`epic-icon ${prStatus ? `epic-icon--${prStatus}` : ''}`}
                              />
                              <span className="archived-epic-name truncate" title={epic.name}>
                                {epic.name}
                              </span>
                              <span className="archived-epic-date">
                                Settled {formatShortTime(new Date(epic.settledAt ?? epic.createdAt))}
                              </span>
                              {epic.prUrl && (
                                <button
                                  type="button"
                                  className="archived-epic-action"
                                  title="Open the pull request"
                                  onClick={() => openEpicPrUrl(epic.prUrl as string)}
                                >
                                  <GitPullRequest size={13} />
                                </button>
                              )}
                              <button
                                type="button"
                                className="archived-epic-action"
                                title="Restore to the sidebar"
                                onClick={() => handleRestoreEpic(epic)}
                              >
                                <RefreshCw size={13} />
                              </button>
                              <button
                                type="button"
                                className="archived-epic-action danger"
                                title="Delete epic"
                                onClick={() => handleDeleteEpic(epic)}
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                      {archivedEpics.length > ARCHIVED_EPICS_COLLAPSED_LIMIT && (
                        <button
                          type="button"
                          className="archived-epics-toggle"
                          aria-expanded={archivedEpicsExpanded}
                          aria-controls="settings-archived-epics-list"
                          onClick={() => setArchivedEpicsExpanded((expanded) => !expanded)}
                        >
                          <span>
                            {archivedEpicsExpanded ? 'Show less' : `Show ${hiddenArchivedEpicCount} more`}
                          </span>
                          <ChevronDown
                            size={13}
                            className={archivedEpicsExpanded ? 'open' : ''}
                            aria-hidden="true"
                          />
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="settings-group-label">About</div>
              <div className="settings-group">
                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Durango Code v{appUpdateState?.currentVersion ?? '—'}</div>
                    <div
                      className={`setting-label-desc${
                        appUpdateState?.status === 'error' ? ' setting-update-error' : ''
                      }`}
                      role={appUpdateState?.status === 'error' ? 'alert' : 'status'}
                    >
                      {appUpdateStatus}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="provider-auth-button settings-update-button"
                    onClick={() => {
                      void handleAppUpdateClick();
                    }}
                    disabled={appUpdateActionDisabled}
                    aria-busy={
                      appUpdateState?.status === 'checking' ||
                      appUpdateState?.status === 'downloading' ||
                      appUpdateState?.status === 'restarting'
                    }
                  >
                    <RefreshCw
                      size={13}
                      className={
                        appUpdateState?.status === 'checking' || appUpdateState?.status === 'restarting'
                          ? 'spinning'
                          : ''
                      }
                    />
                    {appUpdateActionLabel}
                  </button>
                </div>
              </div>
            </>
          )}

          {settingsTab === 'providers' && (
            <>
              <div className="providers-toolbar">
                <div className="providers-toolbar-actions">
                  {providerUpdateState?.checkedAt && (
                    <span className="providers-checked">
                      Checked {formatCheckedTime(providerUpdateState.checkedAt)}
                    </span>
                  )}
                  <button
                    type="button"
                    className="providers-action-btn"
                    title="Check installed provider CLIs for updates"
                    onClick={() => {
                      void refreshProviderUpdates();
                    }}
                    disabled={providerUpdatesChecking || providerUpdatesRunning}
                    aria-busy={providerUpdatesChecking}
                  >
                    <RefreshCw size={13} className={providerUpdatesChecking ? 'spinning' : ''} />
                    <span>{providerUpdatesChecking ? 'Checking...' : 'Check for updates'}</span>
                  </button>
                  {!providerUpdateActive && (providerUpdateState?.updatesAvailable ?? 0) > 0 && (
                    <button
                      type="button"
                      className="providers-action-btn primary"
                      onClick={() => {
                        void handleUpdateProviders();
                      }}
                    >
                      <RefreshCw size={13} />
                      <span>Update providers</span>
                    </button>
                  )}
                </div>
              </div>
              {(providerUpdatesRunning || providerUpdateProgress) && (
                <section
                  className={`provider-update-progress-card ${providerUpdateProgress?.status ?? 'running'}`}
                >
                  <div className="provider-update-progress-head">
                    <div className="provider-update-progress-title">
                      <RefreshCw size={15} className={providerUpdateActive ? 'spinning' : ''} />
                      <div>
                        <strong>
                          {providerUpdateProgress?.providerLabel ??
                            (providerUpdateActive ? 'Updating providers' : 'Provider update')}
                        </strong>
                        <span aria-live="polite">
                          {providerUpdateProgress?.message ?? 'Starting provider update…'}
                        </span>
                      </div>
                    </div>
                    {providerUpdateCancellable && (
                      <button
                        type="button"
                        className="provider-update-abort"
                        onClick={() => {
                          void handleCancelProviderUpdate();
                        }}
                        disabled={providerUpdateProgress?.status === 'cancelling'}
                      >
                        <Square size={11} fill="currentColor" />
                        {providerUpdateProgress?.status === 'cancelling' ? 'Stopping…' : 'Abort update'}
                      </button>
                    )}
                  </div>
                  <div
                    className={`provider-update-progress-track${providerProgressPercent === null && providerUpdateActive ? ' indeterminate' : ''}`}
                    role="progressbar"
                    aria-label="Provider download progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    {...(providerProgressPercent !== null ? { 'aria-valuenow': providerProgressPercent } : {})}
                  >
                    <span
                      style={
                        providerProgressPercent !== null
                          ? { width: `${providerProgressPercent}%` }
                          : undefined
                      }
                    />
                  </div>
                  <div className="provider-update-progress-meta">
                    <span>{providerBatchProgress ?? 'Preparing update'}</span>
                    <span>
                      {providerProgressPercent !== null
                        ? `${Math.round(providerProgressPercent)}%`
                        : providerUpdateActive
                          ? providerProgressActivityLabel
                          : providerUpdateProgress?.status === 'completed'
                            ? 'Complete'
                            : providerUpdateProgress?.status === 'cancelled'
                              ? 'Cancelled'
                              : providerUpdateProgress?.status === 'failed'
                                ? 'Failed'
                                : ''}
                    </span>
                  </div>
                  {providerUpdateProgress?.output && (
                    <pre className="provider-update-output">{providerUpdateProgress.output}</pre>
                  )}
                </section>
              )}
              {agentProviders
                // Orion is a pseudo-provider (the orchestrator), not an
                // installable CLI — no row in Providers.
                .filter((provider) => provider.id !== 'orion')
                .map((provider) => {
                  const Icon = provider.icon;
                  const status = providerStatusById.get(provider.id);
                  const providerEnabled = normalizedProviderSettings[provider.id as ProviderId]?.enabled !== false;
                  const authenticated = status?.auth?.authenticated === true;
                  const canAuthenticate = status?.installed !== false && status?.auth?.status !== 'missing';
                  const version = status?.currentVersion ? status.currentVersion.replace(/^v/i, '') : null;
                  const hasUpdate = !!status?.updateAvailable;

                  // Determine subtitle
                  let subtitle = '';
                  if (!providerEnabled) {
                    subtitle = `Disabled – ${provider.label} is disabled in settings.`;
                  } else if (status?.installed === false) {
                    const cmd = status?.command || provider.id;
                    subtitle = `Not found – ${provider.label} CLI (${cmd}) is not installed or not on PATH.`;
                  } else if (authenticated) {
                    const raw = status?.auth?.detail || 'Authenticated';
                    subtitle =
                      provider.id === 'opencode'
                        ? raw
                        : /authenticated/i.test(raw)
                          ? raw
                          : `Authenticated as ${raw}`;
                  } else if (status?.auth?.authenticated === false) {
                    subtitle = 'Available – Installed and ready, but authentication could not be verified.';
                  } else if (status?.installed) {
                    subtitle = 'Available – Installed and ready.';
                  } else {
                    subtitle = status?.auth?.label || 'Unknown';
                  }

                  const revealed = !!revealedProviderEmails[provider.id];
                  const displaySubtitle = subtitle.replace(
                    /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
                    (email) => (revealed ? email : email.replace(/^(.{1,2}).*?(@.*)$/, '$1••••$2'))
                  );
                  const hasEmailInSubtitle = /\S+@\S+/.test(subtitle);

                  const statusColor = !providerEnabled ? 'yellow' : status?.installed === false ? 'red' : 'green';

                  const optionDefs = providerOptionDefs[provider.id] ?? [];
                  const optionsExpanded = !!expandedProviderOptions[provider.id];
                  const optionValues = providerSettings[provider.id as ProviderId]?.options ?? {};

                  return (
                    <div key={provider.id} className="provider-row-wrap">
                      <div className="provider-row">
                        <div className="provider-left">
                          <span className={`provider-status-dot ${statusColor}`} />
                          <span className="provider-icon-wrap">
                            <Icon size={18} />
                          </span>
                          <div className="provider-meta">
                            <div className="provider-head">
                              <span className="provider-name">{provider.label}</span>
                              {version && <span className="provider-version">v{version}</span>}
                              {hasUpdate && (
                                <span className="provider-update-arrow" title="Update available">
                                  ↑
                                </span>
                              )}
                            </div>
                            <div
                              className="provider-subtitle"
                              onClick={() => {
                                if (hasEmailInSubtitle) {
                                  setRevealedProviderEmails((prev) => ({
                                    ...prev,
                                    [provider.id]: !prev[provider.id],
                                  }));
                                }
                              }}
                              title={hasEmailInSubtitle && !revealed ? 'Click to reveal email' : undefined}
                            >
                              {displaySubtitle}
                            </div>
                          </div>
                        </div>

                        <div className="provider-right">
                          <button
                            type="button"
                            className={`provider-menu-btn ${optionsExpanded ? 'open' : ''}`}
                            title={optionsExpanded ? 'Hide options' : 'Provider options'}
                            onClick={() => {
                              setExpandedProviderOptions((prev) => ({
                                ...prev,
                                [provider.id]: !prev[provider.id],
                              }));
                            }}
                          >
                            <ChevronDown size={14} />
                          </button>

                          {canAuthenticate && (
                            <button
                              type="button"
                              className="provider-auth-button compact"
                              onClick={() => handleAuthenticateProvider(provider.id)}
                              disabled={authenticatingProviderId === provider.id}
                            >
                              {authenticated ? 'Re-authenticate' : 'Authenticate'}
                            </button>
                          )}

                          <label className="provider-toggle" title={providerEnabled ? 'Enabled' : 'Disabled'}>
                            <input
                              type="checkbox"
                              checked={providerEnabled}
                              onChange={(event) => {
                                setProviderEnabled(provider.id as ProviderId, event.target.checked);
                              }}
                            />
                            <span />
                          </label>
                        </div>
                      </div>

                      {optionsExpanded && optionDefs.length > 0 && (
                        <div className="provider-options">
                          {optionDefs.map((option) => {
                            if (option.type === 'boolean') {
                              const checked = optionValues[option.key] === true;
                              return (
                                <div key={option.key} className="provider-option">
                                  <span className="provider-option-text">
                                    <span className="provider-option-label">{option.label}</span>
                                    <span className="provider-option-description">{option.description}</span>
                                  </span>
                                  <label className="provider-toggle">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={(event) => {
                                        setProviderOptions(
                                          provider.id as ProviderId,
                                          {
                                            [option.key]: event.target.checked,
                                          } as Partial<ProviderRuntimeOptions>
                                        );
                                      }}
                                    />
                                    <span />
                                  </label>
                                </div>
                              );
                            }

                            const value = optionValues[option.key];
                            if (option.type === 'select') {
                              return (
                                <div key={option.key} className="provider-option">
                                  <span className="provider-option-text">
                                    <span className="provider-option-label">{option.label}</span>
                                    <span className="provider-option-description">{option.description}</span>
                                  </span>
                                  <SelectMenu
                                    label={option.label}
                                    value={typeof value === 'string' ? value : 'inherit'}
                                    options={option.options ?? []}
                                    onChange={(nextValue) => {
                                      setProviderOptions(
                                        provider.id as ProviderId,
                                        {
                                          [option.key]: nextValue,
                                        } as Partial<ProviderRuntimeOptions>
                                      );
                                    }}
                                  />
                                </div>
                              );
                            }

                            if (option.type === 'textarea') {
                              return (
                                <div key={option.key} className="provider-option column">
                                  <span className="provider-option-text">
                                    <span className="provider-option-label">{option.label}</span>
                                    <span className="provider-option-description">{option.description}</span>
                                  </span>
                                  <textarea
                                    className="provider-option-input provider-option-textarea"
                                    placeholder={option.placeholder}
                                    value={typeof value === 'string' ? value : ''}
                                    onChange={(event) => {
                                      setProviderOptions(
                                        provider.id as ProviderId,
                                        {
                                          [option.key]: event.target.value,
                                        } as Partial<ProviderRuntimeOptions>
                                      );
                                    }}
                                  />
                                </div>
                              );
                            }

                            return (
                              <div key={option.key} className="provider-option column">
                                <span className="provider-option-text">
                                  <span className="provider-option-label">{option.label}</span>
                                  <span className="provider-option-description">{option.description}</span>
                                </span>
                                <input
                                  type="text"
                                  className="provider-option-input"
                                  placeholder={option.placeholder}
                                  value={typeof value === 'string' ? value : ''}
                                  onChange={(event) => {
                                    setProviderOptions(
                                      provider.id as ProviderId,
                                      {
                                        [option.key]: event.target.value,
                                      } as Partial<ProviderRuntimeOptions>
                                    );
                                  }}
                                />
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
            </>
          )}

          {settingsTab === 'orchestration' && (
            <>
              <div className="setting-row">
                <div className="setting-label">
                  <div className="settings-panel-title">Orchestration</div>
                  <div className="settings-muted">
                    Pick “Durango Code” as a thread’s model and Fable-style orchestration kicks in: the main driver model
                    coordinates the work, talks to you, and delegates to the role models below via subagents.
                  </div>
                </div>
              </div>

              {orchestrationRoleMeta.map((role) => (
                <div className="setting-row" key={role.id}>
                  <div className="setting-label">
                    <div className="setting-label-title">{role.label}</div>
                    <div className="setting-label-desc">{role.desc}</div>
                  </div>
                  <select
                    className="setting-select"
                    value={normalizedOrchestrationSettings.models[role.id]}
                    onChange={(e) => setOrchestrationRoleModel(role.id, e.target.value)}
                  >
                    {orchestrationModelGroups.map((group) => (
                      <optgroup key={group.provider.id} label={group.provider.label}>
                        {group.models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
              ))}

              <div className="setting-row setting-row-stacked">
                <div className="setting-label">
                  <div className="setting-label-title">General instructions</div>
                  <div className="setting-label-desc">
                    Free-form guidance every model follows when run through Durango Code — like a global
                    CLAUDE.md that never affects these models outside Durango Code
                  </div>
                </div>
                <textarea
                  className="setting-textarea"
                  rows={6}
                  value={normalizedOrchestrationSettings.generalInstructions}
                  onChange={(e) => setOrchestrationGeneralInstructions(e.target.value)}
                  placeholder="e.g. Always run the test suite before reporting a task as done."
                />
              </div>
            </>
          )}

          {settingsTab === 'skills' && (
            <>
              <div className="skills-mcps-subtabs" role="tablist" aria-label="Skills and MCP settings">
                <button
                  type="button"
                  role="tab"
                  aria-selected={skillsAndMcpsSubtab === 'skills'}
                  className={`skills-mcps-subtab ${skillsAndMcpsSubtab === 'skills' ? 'active' : ''}`}
                  onClick={() => setSkillsAndMcpsSubtab('skills')}
                >
                  Skills
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={skillsAndMcpsSubtab === 'mcps'}
                  className={`skills-mcps-subtab ${skillsAndMcpsSubtab === 'mcps' ? 'active' : ''}`}
                  onClick={() => setSkillsAndMcpsSubtab('mcps')}
                >
                  MCPs
                </button>
              </div>
              {skillsAndMcpsSubtab === 'skills' ? (
                <SkillsSettings formatBytes={formatBytes} onOpenInEditor={handleOpenSkillInEditor} />
              ) : (
                <McpsSettings />
              )}
            </>
          )}

          {settingsTab === 'dev-servers' && <DevServersSettings formatBytes={formatBytes} />}

          {settingsTab === 'deployments' && (
            <DeploymentsSettings
              deploymentSettings={deploymentSettings}
              setDeploymentSettings={setDeploymentSettings}
              deploymentCandidateModels={utilityCandidateModels}
              deploymentProviders={utilityProviders}
              resolvedDeploymentModel={resolvedDeploymentModel}
              resolvedDeploymentModelId={resolvedDeploymentModelId}
              deploymentReasoningOptions={deploymentReasoningOptions}
              resolvedDeploymentReasoningEffort={resolvedDeploymentReasoningEffort}
              cloudApp={cloudApp}
              onOpenCloudApp={handleOpenCloudApp}
            />
          )}

          {settingsTab === 'remote-control' && (
            <RemoteControlSettings
              remoteControlSettings={remoteControlSettings}
              setRemoteControlSettings={setRemoteControlSettings}
              accountState={accountState}
              formatCheckedTime={formatCheckedTime}
            />
          )}

          {settingsTab === 'split-view' && (
            <>
              <div className="setting-row">
                <div className="setting-label">
                  <div className="settings-panel-title">Split view</div>
                  <div className="settings-muted">
                    Drag a thread from the sidebar into the main view to open it beside the one already
                    there — up to {MAX_THREAD_PANES} at once. Panes are windows onto the threads
                    themselves; nothing is ever copied.
                  </div>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-label">
                  <div className="setting-label-title">Auto-save split views</div>
                  <div className="setting-label-desc">
                    Keep every split you open in the sidebar's Saved views section, so you can come back
                    to it in one click. Off means splits are never recorded — close one and it's gone.
                  </div>
                </div>
                <label className="provider-toggle" title="Auto-save split views">
                  <input
                    type="checkbox"
                    checked={splitViewSettings?.autoSave ?? defaultSplitViewSettings.autoSave}
                    onChange={(e) => setSplitViewSettings({ autoSave: e.target.checked })}
                  />
                  <span />
                </label>
              </div>

              {savedViews.length > 0 && (
                <div className="setting-row setting-row-stacked">
                  <div className="setting-label">
                    <div className="setting-label-title">Saved views</div>
                    <div className="setting-label-desc">
                      Delete one here or from the sidebar. Its threads are untouched either way.
                    </div>
                  </div>
                  <div className="archived-epics-list">
                    {savedViews.map((view) => (
                      <div key={view.id} className="archived-epic-row">
                        <Columns2 size={13} />
                        <span className="archived-epic-name truncate" title={view.name}>
                          {view.name}
                        </span>
                        <span className="archived-epic-date">{view.threadIds.length} threads</span>
                        <button
                          type="button"
                          className="archived-epic-action"
                          onClick={() => deleteSavedView(view.id)}
                        >
                          Delete
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {settingsTab === 'computer-use' && (
            <>
              <div className="computer-use-subtabs" role="tablist" aria-label="Computer Use settings">
                <button
                  type="button"
                  role="tab"
                  aria-selected={computerUseSubtab === 'permissions'}
                  className={`computer-use-subtab ${computerUseSubtab === 'permissions' ? 'active' : ''}`}
                  onClick={() => setComputerUseSubtab('permissions')}
                >
                  Permissions
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={computerUseSubtab === 'browser-use'}
                  className={`computer-use-subtab ${computerUseSubtab === 'browser-use' ? 'active' : ''}`}
                  onClick={() => setComputerUseSubtab('browser-use')}
                >
                  Browser use
                </button>
              </div>

              {computerUseSubtab === 'permissions' &&
                (computerUsePerms && !computerUsePerms.supported ? (
                  <div className="settings-empty-panel">
                    <div className="settings-panel-title">Computer use</div>
                    <div className="settings-muted">
                      Computer use permissions only apply on macOS. Nothing to configure on this platform.
                    </div>
                  </div>
                ) : (
                  <>
                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">macOS permissions</div>
                    <div className="setting-label-desc">
                      Agents that control the mouse, keyboard, and screen (Codex computer use and similar) need Durango Code to
                      hold these macOS permissions. macOS attributes every CLI Durango Code launches — codex, claude, grok,
                      cursor — back to Durango Code, so granting them here covers all providers.
                    </div>
                  </div>
                </div>

                {(
                  [
                    {
                      kind: 'accessibility',
                      title: 'Accessibility',
                      desc: 'Lets agents read app windows and send clicks and keystrokes. After requesting, enable Durango Code in the Accessibility list.',
                      status: computerUsePerms?.accessibility ?? 'not-determined',
                    },
                    {
                      kind: 'screen-recording',
                      title: 'Screen Recording',
                      desc: 'Lets agent screenshots include other apps’ window contents. Without it, captures show only the wallpaper.',
                      status: computerUsePerms?.screenRecording ?? 'not-determined',
                    },
                    {
                      kind: 'automation',
                      title: 'Automation (Apple Events)',
                      desc: 'Lets agents drive apps through AppleScript and System Events. macOS asks once per app an agent controls; the status here reflects the System Events grant.',
                      status: computerUsePerms?.automation ?? 'not-determined',
                    },
                  ] as Array<{
                    kind: OrionComputerUsePermissionKind;
                    title: string;
                    desc: string;
                    status: OrionComputerUsePermissionStatus;
                  }>
                ).map((row) => {
                  const granted = row.status === 'granted';
                  const chip =
                    row.status === 'granted'
                      ? { className: 'authenticated', label: 'Granted' }
                      : row.status === 'denied' || row.status === 'restricted'
                        ? { className: 'unauthenticated', label: 'Not granted' }
                        : row.status === 'not-determined'
                          ? { className: '', label: 'Not requested' }
                          : null;
                  return (
                    <div className="setting-row" key={row.kind}>
                      <div className="setting-label">
                        <div className="setting-label-title">{row.title}</div>
                        <div className="setting-label-desc">{row.desc}</div>
                      </div>
                      <div className="setting-row-actions">
                        {chip && <span className={`provider-status-chip ${chip.className}`}>{chip.label}</span>}
                        <button
                          type="button"
                          className="provider-auth-button"
                          onClick={() => {
                            void handleRequestComputerUsePermission(row.kind);
                          }}
                          disabled={computerUseBusyKind !== null}
                        >
                          <SquareArrowOutUpRight size={13} />
                          {computerUseBusyKind === row.kind
                            ? 'Requesting...'
                            : granted
                              ? 'System Settings'
                              : row.kind === 'automation'
                                ? 'Request access'
                                : 'Grant access'}
                        </button>
                      </div>
                    </div>
                  );
                })}

                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Apply new grants</div>
                    <div className="setting-label-desc">
                      macOS applies Screen Recording (and sometimes Accessibility) to an already-running app only after
                      it relaunches. Restart Durango Code once you’ve granted access.
                    </div>
                  </div>
                  <button
                    type="button"
                    className="provider-auth-button"
                    onClick={() => {
                      void window.orion?.relaunchApp?.();
                    }}
                  >
                    <RefreshCw size={13} />
                    Relaunch Durango Code
                  </button>
                </div>
                  </>
                ))}

              {computerUseSubtab === 'browser-use' && (
                <>
                  <div className="setting-row">
                    <div className="setting-label">
                      <div className="setting-label-title">Browser use by provider</div>
                      <div className="setting-label-desc">
                        Choose browser access separately for each provider. Browser tools remain unavailable in Read
                        only mode.
                      </div>
                    </div>
                  </div>

                  <div className="setting-row setting-row-stacked">
                    <div className="setting-label">
                      <div className="setting-label-title">Codex</div>
                      <div className="setting-label-desc">
                        Use your signed-in Chrome through the extension, or attach through Chrome’s public debugging
                        server with chrome-devtools-mcp. If Durango Code cannot verify the extension integration, Codex
                        automatically falls back to the MCP connection.
                      </div>
                    </div>
                    <div className="browser-use-mode-options" role="group" aria-label="Codex browser use mode">
                      {(
                        [
                          { value: 'disabled', label: 'Off' },
                          { value: 'extension', label: 'Chrome extension' },
                          { value: 'mcp', label: 'Your Chrome (MCP)' },
                        ] as Array<{ value: BrowserUseMode; label: string }>
                      ).map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={`browser-use-mode-button ${codexBrowserMode === option.value ? 'active' : ''}`}
                          aria-pressed={codexBrowserMode === option.value}
                          onClick={() =>
                            setProviderOptions('codex', {
                              browserUseMode: option.value,
                              browserControl: option.value !== 'disabled',
                              browserAutoConnect: option.value === 'mcp',
                            })
                          }
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {codexBrowserMode === 'extension' && (
                    <div className="setting-row">
                      <div className="setting-label">
                        <div className="setting-label-title">Codex extension setup</div>
                        <div className="setting-label-desc">
                          {codexBrowserIntegration?.detail ?? 'Checking the browser tools and Chrome extension setup…'}
                        </div>
                      </div>
                      <div className="setting-row-actions">
                        <span
                          className={`provider-status-chip ${
                            codexBrowserIntegration?.ready
                              ? 'authenticated'
                              : codexBrowserIntegration
                                ? 'unauthenticated'
                                : ''
                          }`}
                        >
                          {codexBrowserIntegration?.ready
                            ? 'Setup detected'
                            : codexBrowserIntegration
                              ? 'Setup needed'
                              : 'Checking…'}
                        </span>
                        <button
                          type="button"
                          className="provider-auth-button"
                          onClick={() => {
                            void window.orion.openExternalUrl(CODEX_BROWSER_EXTENSION_URL);
                          }}
                        >
                          <SquareArrowOutUpRight size={13} />
                          {codexBrowserIntegration?.ready ? 'View extension' : 'Install extension'}
                        </button>
                      </div>
                    </div>
                  )}

                  {codexBrowserMode === 'mcp' && (
                    <div className="setting-row">
                      <div className="setting-label">
                        <div className="setting-label-title">Codex signed-in Chrome via MCP</div>
                        <div className="setting-label-desc">
                          Durango Code starts chrome-devtools-mcp with <code>--autoConnect</code> so it controls your existing
                          Chrome tabs, logins, and cookies through Chrome’s public debugging server.
                          {chromeDebugStatus !== 'enabled' && (
                            <>
                              <br />
                              One-time setup: click “Set up in Chrome”, turn on “Enable remote debugging”, then quit
                              Chrome fully and reopen it. The server only starts when Chrome launches.
                            </>
                          )}
                        </div>
                      </div>
                      <div className="setting-row-actions">
                        <span
                          className={`provider-status-chip ${
                            chromeDebugStatus === 'enabled'
                              ? 'authenticated'
                              : chromeDebugStatus === 'disabled'
                                ? 'unauthenticated'
                                : ''
                          }`}
                        >
                          {chromeDebugStatus === 'enabled'
                            ? 'Ready'
                            : chromeDebugStatus === 'stale'
                              ? 'Restart Chrome'
                              : chromeDebugStatus === 'unsupported'
                                ? 'Unsupported'
                                : 'Setup needed'}
                        </span>
                        <button
                          type="button"
                          className="provider-auth-button"
                          onClick={() => {
                            void handleOpenChromeDebugSetup();
                          }}
                          disabled={chromeDebugStatus === 'unsupported'}
                        >
                          <SquareArrowOutUpRight size={13} />
                          Set up in Chrome
                        </button>
                      </div>
                    </div>
                  )}

                <div className="setting-row">
                  <div className="setting-label">
                    <div className="setting-label-title">Claude · Claude in Chrome</div>
                    <div className="setting-label-desc">
                      Browser control through the Claude Chrome extension (--chrome): drives your real signed-in Chrome.
                      Requires the extension to be installed in Chrome.
                    </div>
                  </div>
                  <div className="setting-row-actions">
                    <label className="provider-toggle">
                      <input
                        type="checkbox"
                        checked={providerSettings.claude?.options?.chrome === true}
                        onChange={(event) => {
                          setProviderOptions('claude', {
                            chrome: event.target.checked,
                          });
                        }}
                      />
                      <span />
                    </label>
                  </div>
                </div>
                </>
              )}
            </>
          )}

          {settingsTab === 'workspaces' && <WorkspacesSettings />}

          {settingsTab === 'cosmetics' && (
            <div className="settings-empty-panel">
              <div className="settings-panel-title">Cosmetics</div>
              <div className="settings-muted">Coming soon.</div>
            </div>
          )}
          {settingsTab === 'experimental' && (
            <>
              {epicsEnabled && (
                <>
                  <div className="settings-group-label">Epics</div>
                  <div className="settings-group">
                    <div className="setting-row">
                      <div className="setting-label">
                        <div className="setting-label-title">Commit &amp; PR message prompts</div>
                        <div className="setting-label-desc">
                          Ask before an epic commits or opens a PR, so you can write the message yourself (leave it
                          empty and the epic message model still writes it) and pick the PR's base branch. Turn off to
                          skip both dialogs: messages are always generated, and PRs target your project's current branch
                          on origin.
                        </div>
                      </div>
                      <label className="provider-toggle" title="Commit & PR message prompts">
                        <input
                          type="checkbox"
                          checked={epicPromptGitMessages}
                          onChange={(e) =>
                            setEpicsSettings({
                              promptGitMessages: e.target.checked,
                            })
                          }
                        />
                        <span />
                      </label>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
});

export default SettingsPage;

// Optional: add what Durango remembers about the user to agent instructions
// at thread start. Off by default — agents can always pull memory on demand
// with the recall_memory tool.
const DurangoProfileMemorySetting: React.FC<{ authenticated: boolean }> = ({ authenticated }) => {
  const durangoSettings = useOrionStore((state) => state.durangoSettings ?? defaultDurangoSettings);
  const setDurangoSettings = useOrionStore((state) => state.setDurangoSettings);
  return (
    <div className="setting-row">
      <div className="setting-label">
        <div className="setting-label-title">Include my Durango profile in agent instructions</div>
        <div className="setting-label-desc">
          Off by default. When on, each new thread starts with a short summary of what Durango
          remembers about you (preferences, working style, tools), up to about 1,200 characters.
          Agents can always look things up with the recall_memory tool, and you can ask them to
          remember something for Durango Chat.
          {!authenticated && ' Requires signing in to your Durango account.'}
        </div>
      </div>
      <label className="provider-toggle" title="Add your Durango profile to new threads">
        <input
          type="checkbox"
          checked={durangoSettings.includeProfileMemory}
          onChange={(e) => setDurangoSettings({ includeProfileMemory: e.target.checked })}
        />
        <span />
      </label>
    </div>
  );
};
