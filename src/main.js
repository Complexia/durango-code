// Must stay the first import: pins the internal app name and legacy userData
// path before any other module evaluates (see docs/durango-rebrand.md).
import './main/pin-app-identity.js';
// Then: a launch that is really a `durango-code` CLI call (/usr/bin/durango-code
// on Linux is this app) runs the bundled CLI and exits.
import './main/run-cli-from-argv.js';
import './main/linux-password-store.js';
// Then: a legacy /Applications/Orion.app renames itself to Durango Code.app
// and relaunches (Dock/Finder show the bundle file name).
import './main/rename-legacy-bundle-on-start.js';
import { createRepositoryCredentials } from './main/repository-credentials.js';
import { SOURCE_ATTACHMENT_PROTOCOL, createSourceAttachmentHandler } from './main/source-attachments.js';
import { reloadWhenRendererGone } from './main/renderer-recovery.js';
import { INTERNAL_APP_NAME, PRODUCT_DISPLAY_NAME, devUserDataPath } from './main/app-identity.js';
import { DEFAULT_DEV_WEB_URL, DEFAULT_PACKAGED_WEB_URL } from './main/web-origin.js';
import { isPreviewFilePath } from './app/codeFiles.ts';
import { migrateWorkspaceSyncSettings } from './app/workspaceSyncConsent.ts';
import { remoteModelEfforts, remoteThreadRuntime } from './app/remote-control-policy.ts';
import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, dialog, Menu, nativeImage, net, Notification, powerMonitor, protocol, safeStorage, shell, systemPreferences, webFrameMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  unwatchFile,
  watch as watchFsPath,
  watchFile,
  writeFileSync,
} from 'node:fs';
import { Readable } from 'node:stream';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import started from 'electron-squirrel-startup';
import {
  clearCloudRepoLink,
  createCloudRepo,
  deployApp,
  findOwnedCloudRepo,
  getAppState,
  getCloudGitConnection,
  getCloudRepoLink,
  getCloudState,
  publishRepo,
  pullRepo,
  pushRepo,
  setCloudRepoLink,
} from './cloud-sync.js';
import { getWhatsNew, markWhatsNewSeen } from './main/whats-new.js';
import { relaunchApp } from './main/linux-relaunch.js';
import { browseDirectories, resolveProjectDirectory } from './main/project-browse.js';
import { findProjectIcon } from './main/project-icon.js';
import { approvalExplainPrompt, approvalExplainTruncated, parseApprovalExplanation } from './main/approval-explainer.js';
import { appUpdateDownloadedVersion, appUpdateState, checkForAppUpdate, getAppIconPath, initializeAppUpdater, installDownloadedLinuxUpdate, invalidateAppUpdateDownload, publishAppUpdateState, scheduleAppUpdateChecks, waitForAppUpdateStagedForInstall } from './main/app-updater.js';
import { withClaudeEnv } from './main/claude-env.js';
import { claudeSdkSessions, createClaudeInputQueue, discardClaudeBackgroundShellTasks, disposeAllClaudeSdkSessions, disposeClaudeSdkSession, disposeClaudeSdkSessionAndWait, interruptClaudeSdkRun, listClaudeSlashCommands, loadClaudeSdk, loadZod, notifyClaudeSession, resolveClaudeBinary, runClaudeSdkTurn, steerClaudeSdkRun } from './main/claude-driver.js';
import { unwatchUserActions, watchUserAction } from './main/user-actions.js';
import { answerSecretRequest, listPendingSecretRequests, startSecretFileSweeps } from './main/secret-requests.js';
import { devServerUrlForPort, killDevServers, listDevServers } from './main/dev-servers.js';
import { buildUsageReport, createUsageStore, latestCodexLimits } from './main/usage-stats.js';
import { loadUsagePrices, refreshUsagePrices, usagePricesInfo } from './main/usage-pricing.js';
import { claudeRateLimits, configureUsageLimits } from './main/usage-limits.js';
import { clearProviderUsageLimitsCache, configureCodexLiveLimits, readProviderUsageLimits } from './main/provider-usage-limits.js';
import { codexBrowserUseMode, codexUtilityPrivacyOptions, splitCodexConfigContextArgs } from './main/codex-config.js';
import { codexBrowserOptionsForIntegration, probeCodexBrowserIntegration } from './main/codex-browser-integration.js';
import { codexAppServerManager } from './main/codex-app-server-manager.js';
import { spawnCodexServerProcess } from './main/codex-server-process.js';
import { codexGoalRunDrivers, codexSteerableRunDrivers, createCodexAppServerDriver, runCodexGoalOp, steerCodexAppServerRun } from './main/codex-driver.js';
import { createCompletedCodexQuestions } from './main/codex-questions.js';
import { commandForModel } from './main/command-for-model.js';
import { validateAgentWorkspace } from './main/agent-run-preflight.js';
import { captureGitChangeSnapshot, commandSucceeds, commitMessageForEntries, getCurrentGitBranch, getDetachedGitHead, getGitRoot, getGitStateForPath, getGitStatusMap, invalidateTreeGitStatusCache, readGitStatusEntries, summarizeChangedFiles, validateNewBranchName } from './main/git-utils.js';
import { createFxAcpDriver, fxReadOnlyOneShot, fxStatsFromPromptResult, fxSteerableRunDrivers, steerFxRun } from './main/fx-driver.js';
import { configureFxProvider, installFx, prepareFxLaunch, readFxConnections } from './main/fx-provider.js';
import { antigravityChildTranscriptPath, handleAntigravitySubagentLine, resolveAntigravityChild } from './main/antigravity-child-work.js';
import { antigravityReadOnlyOneShot, antigravityRunDrivers, antigravityStatsFromPromptResult, cancelAntigravityRun, createAntigravityAcpDriver, steerAntigravityRun } from './main/antigravity-driver.js';
import { antigravitySessionManager } from './main/antigravity-session-manager.js';
import { sweepOrphanAntigravityTempSessions } from './main/antigravity-session-files.js';
import { discoverAntigravitySkills, mergeAntigravitySlashCommands } from './main/antigravity-skills.js';
import { createReasoningStream } from './main/reasoning-stream.js';
import { createKimiAcpDriver, handleKimiSubagentLine, kimiPlanModeOneShot, kimiStatsFromSessionDisk, watchKimiSubagentSpawns } from './main/kimi-driver.js';
import { guardVisualFrames } from './main/visual-tools.js';
import { attachTextContextMenu } from './main/text-context-menu.js';
import { subagentReportsMessage } from './main/background-subagents.js';
import { closeMcpBridge, handleSubagentResult, handleSubagentStarted, legacyMcpCleanupPromise, openCodeMcpConfigContent, orionAcpHttpMcpServers, orionAcpMcpServers, pendingSubagentStops, takeSubagentReports, providerSupportsRunPlugin, providerSupportsThreadReader, registerMcpBridgeForRun, startLegacyMcpCleanup, writeMuseMcpConfigRoot } from './main/mcp-bridge.js';
import { isEffectiveThreadReaderBridgeReady, isMcpBridgeProvider, isRequiredThreadReaderBridgeMissing } from './main/thread-reader-routing.js';
import { DurangoError, accountKeyOf, createDurangoClient, createDurangoCredentials, createMockDurangoClient } from './main/durango-client.js';
import { createBoardTasks, durangoTasksEnabled } from './main/board-tasks.js';
import {
  createDispatchWorker,
  dispatchSourceLabel,
  dispatchSourceUrl,
  isProjectAllowed,
  normalizeDispatchSettings,
} from './main/durango-dispatch.js';
import {
  createBotReplyWorker,
  createBotSessionStore,
  createClaudeLaneRunner,
  createClaudeOneShot,
  normalizeBotSettings,
} from './main/bot-replies.js';
import { createLocalBotEngine, localProjectKey } from './main/local-bots.js';
import { SHIP_VIA_THREAD_MESSAGE, createBotThreadTools, withThreadReportFooter } from './main/bot-thread-tools.js';
import { botThreadTitle } from './main/bot-thread-title.js';
import { titleFromResponseText, utilityReplyFromOutput } from './main/utility-reply.js';
import {
  createDeployWatcher,
  createSourceConfigFetcher,
  createSourceDeploysFetcher,
  normalizeDeployWatcherSettings,
  startBundledDeployRunner,
} from './main/durango-deploy-watcher.js';
import { createProfileMemoryCache, durangoErrorText, setDurangoToolsClient } from './main/durango-tools.js';
import { createProjectNotesReader, setProjectNotesReader } from './main/project-notes-tool.js';
import { readImportableSessions, scanImportableSessions } from './main/session-import.js';
import { clearThreadsStorage, readThreadById, readThreadsByIds, readThreadsForSync, readThreadsBatch, readThreadRawSync, readThreadShells, readThreadsIndex, searchThreadBodies, searchThreadExcerpts, warmThreadSearch, writeThreadsPatch, writeThreadsPatchSync } from './main/thread-storage.js';
import { ensureMediaExtension, getMimeTypeForMediaPath, mediaPreviewExtensions, sanitizeAttachmentName } from './main/media.js';
import { convertHeicToJpeg, isHeicInput, jpegNameForHeic } from './main/heic.js';
import {
  configureAgentModelsCache,
  getAgentModels,
  invalidateAgentModelsCache,
  listAgentModelsWithAvailability,
  onAgentModelsChanged,
  resolveLegacyAntigravityModelId,
} from './main/models.js';
import { appProtocol, attachmentProtocol, getAccountSessionFilePath, getAttachmentDirectoryPath, getNoProjectDirectoryPath, getStorageFilePath, getSyncLedgerFilePath, storageFileName, threadsDirectoryName, threadsFileName } from './main/paths.js';
import { authenticateProviderTool, cancelAntigravityLogin, checkProviderUpdates, submitAntigravityLoginCode, getProcessErrorMessage, getProviderStatuses, normalizeEnabledProviderIds, providerAuthenticationGenerations, providerUpdaterConfigs, updateProviderTool, waitForProviderAuthentication } from './main/provider-updates.js';
import { activeAgentRuns, finalizingAgentRuns, killAgentChild, startingAgentRuns, stoppedAgentRuns, trackAgentShutdown, waitForAgentThreadShutdowns, waitForPendingAgentShutdowns } from './main/run-registry.js';
import { checkCommandAvailable, execFileAsync, loginShell, runShellCommand, shellPathSyncPromise, shellQuote, startShellPathSync } from './main/shell-env.js';
import { initDevices, registerDeviceIpc, shutdownDevices } from './main/devices/device-ipc.js';
import { extractSessionIdFromJsonEvent, isTerminalJsonEvent, jsonAdapterForProvider, sendsJsonEvents, stringifySummary } from './main/stream-adapters.js';
import { syncOrchestrationInstructionFiles } from './main/orchestration-files.js';
import { deleteSkill, ensureBundledSkills, importSkills, listSkills, openSkillsFolder, revealSkill, setSkillEnabled } from './main/skills.js';
import { listMcps, readMcpRuntimeConfig, setMcpEnabled } from './main/mcps.js';
import { addOrionMcp, cancelOrionMcpSignIn, claudeOrionMcpServers, listOrionMcps, reconnectOrionMcp, removeOrionMcp, reservedNicknames, resolveOrionMcpsForRun, updateOrionMcp } from './main/orion-mcps.js';
import { createAccountConnectors } from './main/account-connectors.js';
import { listProviderMcps, shareProviderMcp, withoutClaudeNativeMcps, withoutCodexNativeMcps } from './main/provider-mcps.js';
import { findKimiSessionIndexEntry, forkSessionOnDisk } from './main/session-fork.js';
import { addAgentEventListener, emitAgentEvent, sendToAllWindows } from './main/events.js';
import { createProviderSignInWatch } from './main/provider-sign-in-watch.js';
import {
  canUndoTheme,
  configureThemeStore,
  deleteTheme,
  duplicateTheme,
  getTheme,
  listThemes,
  recordSceneError,
  setVideoPoster,
  videoForPoster,
  renameTheme,
  resetThemeValues,
  setActiveTheme,
  setThemeSaved,
  setThemeValues,
  adoptLegacyThemesAnimate,
  setThemesAnimate,
  themeAssetPath,
  undoTheme,
} from './main/ui-themes-store.js';
import { isThemeAssetName, isVideoAsset } from './ui-themes.js';
import { setThemeToolsClient, setThemeToolsMetrics } from './main/theme-tools.js';
import {
  communityGalleryUrl,
  configureCommunityThemes,
  installCommunityTheme,
  previewCommunityTheme,
  setSharedThemeListed,
  shareTheme,
  themeInstallLinkSlug,
  unshareTheme,
} from './main/theme-community.js';
import { createThreadOpenLinks } from './main/thread-links.js';
import { configureT3Themes, exportThemeToT3, importT3Theme, t3FileName } from './main/theme-t3.js';
import { createBrowserManager } from './main/browser/manager.js';
import { browserScreenshotsDirectory } from './main/browser/security.js';
import { browserModeFor, setBrowserManager } from './main/browser-tools.js';
import { fetchRelayApiJson, fetchRemotePairingProofJson } from './main/remote-api.js';
import { externalWebUrl, linkedFileCandidates } from './main/linked-navigation.js';
import {
  cancelRemotePairing,
  configureRemoteControl,
  connectRemoteMachine,
  deregisterRelayMachine,
  disconnectRemoteMachine,
  fetchRemoteSnapshot,
  fetchRemoteThread,
  forwardAgentEventToRemote,
  noteAgentRunOutputMessage,
  forgetAgentRunOutputMessage,
  getRemoteControlState,
  initRemoteControl,
  migrateRemoteControlUserId,
  notifyRemoteControlAccountChanged,
  notifyRemoteCommandRendererLost,
  claimRemoteCommand,
  notifyRemoteWorkspaceChanged,
  pairWithRemoteHost,
  removeRemoteMachine,
  resolveRemoteCommand,
  revokeRemoteDevice,
  runRemoteTurn,
  checkoutRemoteSource,
  fetchRemoteAttachment,
  prepareRemoteAttachmentUpload,
  cancelRemoteAttachmentUpload,
  listRemoteAttachmentUploads,
  fetchRemoteThreadGit,
  listRemoteQuestions,
  answerRemoteQuestion,
  remoteUserAction,
  setRemoteThreadState,
  followRemoteThreads,
  shutdownRemoteControl,
  startRemotePairing,
  stopRemoteTurn,
  steerRemoteTurn,
  waitForRemoteControlPersistence,
} from './main/remote-control.js';
import { configureMachineTools, remoteThreadSpawner } from './main/machine-tools.js';
import { readThreadForAgent, setThreadReaderRemoteFetch } from './main/thread-reader.js';
import {
  configureWorkspaceSync,
  getWorkspaceSyncStatus,
  initWorkspaceSync,
  notifyAccountChanged as notifyWorkspaceSyncAccountChanged,
  notifyWorkspaceChanged,
  shutdownWorkspaceSync,
  workspaceSyncNow,
} from './main/workspace-sync.js';
import { codexSubagentTitle, createSubagentTracker, cursorAgentTranscriptFile, handleCodexRolloutLine, handleCursorSubagentLine, watchCodexSubagentSpawns } from './main/subagent-trackers.js';
import { createGrokAcpDriver, grokStatsFromPromptMeta, grokSubagentUpdatesFile, handleGrokSubagentLine } from './main/grok-driver.js';
import { bundledCliBinDir, bundledCliEntry, bundledCliError, bundledCliVersion, ensureCliSignedIn, installBundledCliShims, readCliCredential, runBundledCli } from './main/bundled-cli.js';
import { cliSupportsClone, createSourceCheckout } from './main/source-checkout.js';
import { installGitCredentialHelper } from './main/git-credential-helper.js';
import { disposeSnapShot, registerSnapShotIpc, startSnapShot } from './main/snapshot.js';
import {
  createDurangoWorkspace,
  durangoWorkspaceStatus,
  findDurangoWorkspace,
  inspectDurangoWorkspaceProject,
  landDurangoChange,
  landDurangoWorkspace,
  locateDurangoChange,
  missingDurangoWorkspaces,
  pruneDurangoWorkspaces,
  removeDurangoWorkspace,
  serveDurangoWorkspace,
  stopAllDurangoWorkspaceServers,
  stopDurangoWorkspaceServer,
} from './main/durango-workspaces.js';
import {
  configureOrionSourceControl,
  describeGitPushFailure,
  ensureBaselineGitignore,
  gitPushWasAlreadyUpToDate,
  inspectSourceControl,
  isEquivalentOrionGitRemote,
  isOrionRepoRemoteUrl,
  canReuseLinkedCloudRepo,
  parseNamedGitRefs,
  planGithubRefImport,
  pushSourceControl,
  runAuthenticatedGit,
  sanitizeRepositoryName,
  shouldReconcileDefaultBranch,
  shouldMirrorGithubLocally,
  switchSourceControlToOrion,
} from './main/source-control.js';

// The internal app name ("Orion") and userData path are pinned by
// ./main/pin-app-identity.js, imported first. The customer-facing name is
// PRODUCT_DISPLAY_NAME ("Durango Code"); menus and the About panel use it
// explicitly because Electron's role-based menu labels follow app.getName().

const hiddenSystemDirectories = new Set(['.git']);
let quitAfterPendingWork = false;
let quitBarrierSatisfied = false;
let appShutdownRequested = false;
let appShutdownReason = null;
let codexAppServerShutdownPromise = null;
const codexGoalOpsByThread = new Map(); // threadId -> Set<{ controller, promise }>
const completedCodexQuestions = createCompletedCodexQuestions();
const disposeCodexGoalOpsForThread = async (threadId) => {
  const operations = [...(codexGoalOpsByThread.get(threadId) ?? [])];
  if (operations.length === 0) return false;
  for (const operation of operations) operation.controller.abort();
  await Promise.allSettled(operations.map((operation) => operation.promise));
  return true;
};
const disposeAllCodexGoalOps = () => {
  const shutdowns = [...codexGoalOpsByThread.keys()].map((threadId) =>
    disposeCodexGoalOpsForThread(threadId)
  );
  if (shutdowns.length > 0) trackAgentShutdown(Promise.all(shutdowns));
};
const titleGenerationsByThread = new Map(); // threadId -> Set<{ controller, promise }>
const disposeTitleGenerationsForThread = async (threadId) => {
  const generations = [...(titleGenerationsByThread.get(threadId) ?? [])];
  if (generations.length === 0) return false;
  for (const generation of generations) generation.controller.abort();
  await Promise.allSettled(generations.map((generation) => generation.promise));
  return true;
};
const disposeAllTitleGenerations = () => {
  const shutdowns = [...titleGenerationsByThread.keys()].map((threadId) =>
    disposeTitleGenerationsForThread(threadId)
  );
  if (shutdowns.length > 0) trackAgentShutdown(Promise.all(shutdowns));
};
const PROVIDER_UPDATE_PROGRESS_OUTPUT_LIMIT = 24_000;
const PROVIDER_UPDATE_PROGRESS_INTERVAL_MS = 100;
let activeProviderUpdate = null;
let lastProviderUpdateProgress = null;
const providerUpdateOutputTail = (current, chunk) => {
  const combined = `${current || ''}${chunk || ''}`;
  return combined.length > PROVIDER_UPDATE_PROGRESS_OUTPUT_LIMIT
    ? combined.slice(-PROVIDER_UPDATE_PROGRESS_OUTPUT_LIMIT)
    : combined;
};
const cleanProviderUpdateOutput = (value) =>
  String(value || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n');
const providerUpdateProgressMessage = (output, fallback) => {
  const lines = String(output || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) || fallback;
};
const providerUpdatePercent = (output) => {
  const matches = [...String(output || '').matchAll(/(?:^|\s)(100|\d{1,2}(?:\.\d+)?)%/g)];
  if (matches.length === 0) return null;
  const percent = Number(matches.at(-1)?.[1]);
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
};
const publishProviderUpdateProgress = (operation, patch) => {
  const progress = {
    ...(operation.lastProgress || {}),
    operationId: operation.id,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  operation.lastProgress = progress;
  lastProviderUpdateProgress = progress;
  sendToAllWindows('providers:updateProgress', progress);
  return progress;
};
const cancelActiveProviderUpdate = (operationId = null) => {
  const operation = activeProviderUpdate;
  if (!operation || (operationId && operation.id !== operationId)) return false;
  if (operation.controller.signal.aborted) return true;
  publishProviderUpdateProgress(operation, {
    status: 'cancelling',
    message: operation.lastProgress?.providerLabel
      ? `Stopping ${operation.lastProgress.providerLabel} update…`
      : 'Stopping provider updates…',
  });
  operation.controller.abort();
  return true;
};
const waitForProviderUpdateShutdown = () =>
  activeProviderUpdate?.promise?.catch(() => {}) ?? Promise.resolve();
let pendingDesktopAuth = null;
let inMemoryAccountSession = null;
let lastPublishedAccountAuthenticated = null;
let storageSaveQueue = Promise.resolve();
let threadsSaveQueue = Promise.resolve();
// The quit-time synchronous threads flush jumps the async save queue; the
// sequence pair lets a stale queued write detect it has been superseded so
// its manifest commit cannot clobber the newer quit-time snapshot. A commit
// already submitted to the fs when the sync flush runs can still land after
// it — the retained sync snapshot lets that writer notice (post-rename seq
// check) and reinstall the newer data, which matters on macOS where the main
// process outlives the window and the clobbered file would persist.
let threadsWriteSeq = 0;
let threadsCommittedSeq = 0;
let threadsSyncSnapshot = null; // { seq, patch } from the latest sync flush
// The store file gets the same treatment: its unload flush writes
// synchronously, so a queued or in-flight async save of an older snapshot
// must neither overwrite it nor survive it.
let storageWriteSeq = 0;
let storageCommittedSeq = 0;
let storageSyncSnapshot = null; // { seq, value } from the latest sync flush
// A BrowserWindow can exist while its renderer is still loading or has
// crashed/reloaded before installing the remote-command subscription. Only a
// renderer that explicitly announces readiness may receive a command.
let remoteCommandRenderer = null;
let remoteCommandRendererCleanup = null;

const markRemoteCommandRendererReady = (webContents) => {
  if (!webContents || webContents.isDestroyed()) return { ok: false };
  if (remoteCommandRenderer === webContents) return { ok: true };
  remoteCommandRendererCleanup?.();
  remoteCommandRenderer = webContents;
  // Only the window's own page reloading or navigating ends its readiness.
  // `did-start-loading` also fires when a frame inside it loads (a theme's
  // scene, an HTML visual in a thread), which used to leave Durango Code
  // thinking no window was open ("Open a Durango Code window…").
  const onNavigation = (details, _url, isInPlace, isMainFrame) => {
    const mainFrame = details?.isMainFrame ?? isMainFrame;
    const sameDocument = details?.isSameDocument ?? isInPlace;
    if (mainFrame && !sameDocument) clear();
  };
  const clear = () => {
    webContents.removeListener('did-start-navigation', onNavigation);
    webContents.removeListener('render-process-gone', clear);
    webContents.removeListener('destroyed', clear);
    if (remoteCommandRenderer === webContents) {
      remoteCommandRenderer = null;
      notifyRemoteCommandRendererLost();
    }
    if (remoteCommandRendererCleanup === clear) remoteCommandRendererCleanup = null;
  };
  remoteCommandRendererCleanup = clear;
  webContents.on('did-start-navigation', onNavigation);
  webContents.once('render-process-gone', clear);
  webContents.once('destroyed', clear);
  return { ok: true };
};

const dispatchRemoteCommand = (payload) => {
  const target = remoteCommandRenderer;
  if (!target || target.isDestroyed()) {
    remoteCommandRendererCleanup?.();
    return 0;
  }
  try {
    target.send('remote:commandRequest', payload);
    return 1;
  } catch {
    remoteCommandRendererCleanup?.();
    return 0;
  }
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: attachmentProtocol,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
  {
    // Durango Source change-description images (src/main/source-attachments.js).
    scheme: SOURCE_ATTACHMENT_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

const sanitizeStoreValue = (value) => {
  try {
    JSON.parse(value);
    return value;
  } catch {}

  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value[index] !== '}') continue;
    const candidate = value.slice(0, index + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }

  return null;
};

// The persisted store is the main process's only view of renderer state, and
// the one that survives a crash.
const readPersistedStoreState = async () => {
  try {
    const value = sanitizeStoreValue(await fs.readFile(getStorageFilePath(), 'utf-8'));
    if (!value) return null;
    return JSON.parse(value)?.state ?? null;
  } catch {
    return null;
  }
};

const base64Url = (value) =>
  Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

const randomBase64Url = (byteLength = 32) => base64Url(crypto.randomBytes(byteLength));

const sha256Base64Url = (value) => base64Url(crypto.createHash('sha256').update(value).digest());

const getDurangoWebUrl = () => {
  // Packaged builds talk to durango.sh; development defaults to the local
  // Durango dev server. DURANGO_URL (or the older ORION_WEB_URL) overrides
  // either. Every HTTP API the desktop uses, the Durango API included, lives
  // on this one origin.
  const defaultWebUrl = app.isPackaged ? DEFAULT_PACKAGED_WEB_URL : DEFAULT_DEV_WEB_URL;
  const rawUrl = process.env.DURANGO_URL || process.env.ORION_WEB_URL || defaultWebUrl;
  const url = new URL(rawUrl);
  url.hash = '';
  url.search = '';
  return url;
};

const remotePairingProofRequest = async (method, body, token, { signal } = {}) => {
  const { response, data } = await fetchRemotePairingProofJson({
    url: new URL('/api/desktop-auth/remote-pairing-proof', getDurangoWebUrl()),
    method,
    token,
    body,
    signal,
  });
  if (!response.ok) {
    throw new Error(
      data?.error ||
        (response.status === 404
          ? 'Durango Cloud does not support secure remote pairing yet.'
          : 'Durango Cloud could not authenticate remote pairing.')
    );
  }
  return data;
};

const createRemotePairingProof = async ({ token, challenge, machineId, signal }) => {
  const data = await remotePairingProofRequest('POST', { challenge, machineId }, token, { signal });
  if (typeof data?.proof !== 'string' || !data.proof) {
    throw new Error('Durango Cloud returned an invalid remote pairing proof.');
  }
  return data.proof;
};

const verifyRemotePairingProof = async ({ proof, challenge, machineId, signal }) => {
  try {
    const data = await remotePairingProofRequest('PUT', { proof, challenge, machineId }, null, { signal });
    return typeof data?.userId === 'string' && data.userId ? data.userId : null;
  } catch {
    return null;
  }
};

// Remote control over the internet. Only reached when the user has switched
// remote control to relay mode; direct mode never calls any of this.
const getOrionRelayUrl = () => {
  const defaultRelayUrl = app.isPackaged ? 'wss://relay.orioncode.xyz' : 'ws://localhost:8787';
  return process.env.ORION_RELAY_URL || defaultRelayUrl;
};

/**
 * Bearer-authed call to the relay APIs on durango.sh. The desktop account
 * token authenticates THESE calls and never leaves this function: what comes
 * back is a short-lived relay ticket, and that is all the relay ever sees.
 */
const relayApiRequest = async (apiPath, body, { signal, method, allowNotFound = false } = {}) => {
  const session = await readAccountSession();
  if (!session?.token) throw new Error('Sign in to your Durango account first.');
  const { response, data } = await fetchRelayApiJson({
    url: new URL(apiPath, getDurangoWebUrl()),
    method,
    token: session.token,
    body,
    signal,
  });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      data?.error ||
        (response.status === 404
          ? 'Durango Cloud does not support internet remote control yet.'
          : 'Durango Cloud refused the relay request.')
    );
  }
  return data;
};

const registerRelayDevice = ({ machineId, name, platform, appVersion, signal }) =>
  relayApiRequest('/api/relay/devices', { machineId, name, platform, appVersion }, { signal });

// Removing a machine that is not registered (or was already removed) is the
// state the user asked for — treat the route's 404 as success rather than
// surfacing an error for an idempotent removal.
const deregisterRelayDevice = ({ machineId, signal }) =>
  relayApiRequest(`/api/relay/devices/${encodeURIComponent(machineId)}`, undefined, {
    method: 'DELETE',
    allowNotFound: true,
    signal,
  });

// This account's machines at the relay, with online status: where a pairing
// code typed on its own is offered (pairWithRemoteHost).
const listRelayDevices = async ({ signal } = {}) => {
  const data = await relayApiRequest('/api/relay/devices', undefined, { method: 'GET', signal });
  return Array.isArray(data?.devices) ? data.devices : [];
};

const mintRelayTicket = async ({ role, machineId, signal }) => {
  const data = await relayApiRequest('/api/relay/ticket', { role, machineId }, { signal });
  if (typeof data?.ticket !== 'string' || !data.ticket) {
    throw new Error('Durango Cloud returned an invalid relay ticket.');
  }
  const relayUrl =
    typeof data?.relayUrl === 'string' && data.relayUrl.trim() ? data.relayUrl.trim() : getOrionRelayUrl();
  try {
    const parsed = new URL(relayUrl);
    const allowedProtocols = app.isPackaged ? ['wss:', 'https:'] : ['ws:', 'wss:', 'http:', 'https:'];
    if (!allowedProtocols.includes(parsed.protocol)) throw new Error();
  } catch {
    throw new Error('Durango Cloud returned an invalid relay address.');
  }
  return { ticket: data.ticket, relayUrl };
};

const desktopAccountForRenderer = (session) => {
  if (!session?.token || !session?.user) {
    return { authenticated: false, user: null, expiresAt: null };
  }

  return {
    authenticated: true,
    user: session.user,
    expiresAt: session.expiresAt ?? null,
  };
};

// macOS ties keychain ACLs to the app's code signature. In development the app
// runs under the stock Electron binary, whose signature never matches the ACL
// on the "Orion Safe Storage" keychain item, so every safeStorage call triggers
// a login-keychain password prompt. Only use the keychain in packaged builds,
// which are signed with a stable Developer ID.
const canUseSafeStorage = () => app.isPackaged && safeStorage.isEncryptionAvailable();

const encryptAccountToken = (token) => {
  if (!canUseSafeStorage()) {
    return { encrypted: false, value: token };
  }
  return {
    encrypted: true,
    value: safeStorage.encryptString(token).toString('base64'),
  };
};

const decryptAccountToken = (storedToken) => {
  if (!storedToken || typeof storedToken !== 'object') return null;
  if (storedToken.encrypted) {
    // Decrypting in dev would re-trigger the keychain prompt; treat the
    // session as absent and let the user sign in again.
    if (!app.isPackaged) return null;
    return safeStorage.decryptString(Buffer.from(String(storedToken.value || ''), 'base64'));
  }
  return typeof storedToken.value === 'string' ? storedToken.value : null;
};

const readAccountSession = async () => {
  if (inMemoryAccountSession) return inMemoryAccountSession;

  try {
    const raw = await fs.readFile(getAccountSessionFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    const token = decryptAccountToken(parsed.token);
    if (!token || !parsed.user) return null;
    return {
      token,
      user: parsed.user,
      expiresAt: parsed.expiresAt ?? null,
      createdAt: parsed.createdAt ?? null,
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('account:load error', error);
    }
    return null;
  }
};

const writeAccountSession = async (session) => {
  inMemoryAccountSession = session;

  // In packaged builds, never persist account tokens without OS-backed
  // encryption. Development builds store the token unencrypted to avoid the
  // keychain password prompt on every launch.
  if (app.isPackaged && !safeStorage.isEncryptionAvailable()) {
    return;
  }

  const filePath = getAccountSessionFilePath();
  const payload = {
    token: encryptAccountToken(session.token),
    user: session.user,
    expiresAt: session.expiresAt ?? null,
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
};

const repositoryCredentials = createRepositoryCredentials({
  readSession: () => readAccountSession(),
  origin: () => getDurangoWebUrl().toString(),
  deviceName: `Durango Code · ${os.hostname()}`.slice(0, 100),
  readStored: async () => {
    try {
      const stored = JSON.parse(await fs.readFile(`${getAccountSessionFilePath()}.repositories`, 'utf8'));
      return { ...stored, token: decryptAccountToken(stored.token) };
    } catch { return null; }
  },
  writeStored: async (credential) => {
    if (app.isPackaged && !canUseSafeStorage()) return;
    const target = `${getAccountSessionFilePath()}.repositories`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ ...credential, token: encryptAccountToken(credential.token) }), { mode: 0o600 });
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  },
  removeStored: () => fs.rm(`${getAccountSessionFilePath()}.repositories`, { force: true }),
});
const readRepositorySession = () => repositoryCredentials.get();
const sourceAttachments = createSourceAttachmentHandler({
  credentials: repositoryCredentials,
  webOrigin: () => getDurangoWebUrl().toString(),
});

// Durango (durango.sh) device key for the chats/memory API (contracts §7–8).
// Stored beside the account session like the repository credential: the key
// is safeStorage-encrypted in packaged builds and never leaves main.
const durangoKeyFilePath = () => `${getAccountSessionFilePath()}.durango`;
// Stable per-install device id sent with each key mint so Durango can tell
// this device's keys apart across re-mints. Not a secret.
let durangoDeviceIdPromise = null;
const getDurangoDeviceId = () => {
  durangoDeviceIdPromise ??= (async () => {
    const target = path.join(app.getPath('userData'), 'orion-device-id');
    try {
      const existing = (await fs.readFile(target, 'utf8')).trim();
      if (/^[0-9a-f-]{36}$/i.test(existing)) return existing;
    } catch {}
    const id = crypto.randomUUID();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${id}\n`, 'utf8');
    return id;
  })().catch(() => {
    durangoDeviceIdPromise = null;
    return null;
  });
  return durangoDeviceIdPromise;
};
const durangoCredentials = createDurangoCredentials({
  readSession: () => readAccountSession(),
  webOrigin: () => getDurangoWebUrl().toString(),
  deviceName: os.hostname().slice(0, 80),
  getDeviceId: () => getDurangoDeviceId(),
  isPackaged: () => app.isPackaged,
  readStored: async () => {
    try {
      const stored = JSON.parse(await fs.readFile(durangoKeyFilePath(), 'utf8'));
      const key = decryptAccountToken(stored.key);
      return key ? { ...stored, key } : null;
    } catch { return null; }
  },
  writeStored: async (credential) => {
    // Same rule as account tokens: packaged builds never persist a key
    // without OS-backed encryption (it then lives for this process only).
    if (app.isPackaged && !canUseSafeStorage()) return;
    const target = durangoKeyFilePath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ ...credential, key: encryptAccountToken(credential.key) }), { mode: 0o600 });
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  },
  removeStored: () => fs.rm(durangoKeyFilePath(), { force: true }),
});
// DURANGO_MOCK=1 swaps in fixture data (development, GUI verification, tests).
const durangoMock = process.env.DURANGO_MOCK === '1';
const durangoClient = durangoMock
  ? createMockDurangoClient()
  : createDurangoClient({
      credentials: durangoCredentials,
      readSession: () => readAccountSession(),
      isPackaged: () => app.isPackaged,
      webOrigin: () => getDurangoWebUrl().toString(),
    });
setDurangoToolsClient(durangoClient);
// generate_theme_media makes theme backdrops with Durango inference.
setThemeToolsClient(durangoClient);
// Community themes: share to and install from durango.sh/code/themes.
// T3 Code exports embed the backdrop as a JPEG data: URL that fits in its
// 50,000 characters of CSS: the largest size and quality that fits `maxChars`.
configureT3Themes({
  picture: (bytes, maxChars) => {
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (image.isEmpty()) return null;
    const { width } = image.getSize();
    for (const target of [960, 800, 640, 520, 420, 340]) {
      const sized = width > target ? image.resize({ width: target, quality: 'good' }) : image;
      for (const quality of [72, 60, 48, 38]) {
        const url = `data:image/jpeg;base64,${sized.toJPEG(quality).toString('base64')}`;
        if (url.length <= maxChars) return url;
      }
    }
    return null;
  },
});
// This device's owner key for community themes shared without an account
// (theme-community.js): made on first use, kept in userData. Whoever holds it
// can update or stop sharing those themes; nothing else.
let themeOwnerKeyPromise = null;
const themeOwnerKey = () => {
  themeOwnerKeyPromise ??= (async () => {
    const file = path.join(app.getPath('userData'), 'community-theme-owner.key');
    const existing = (await fs.readFile(file, 'utf8').catch(() => '')).trim();
    if (/^[A-Za-z0-9_-]{32,128}$/.test(existing)) return existing;
    const key = crypto.randomBytes(32).toString('base64url');
    await fs.writeFile(file, `${key}\n`, { mode: 0o600 });
    return key;
  })().catch((error) => {
    themeOwnerKeyPromise = null;
    throw error;
  });
  return themeOwnerKeyPromise;
};
configureCommunityThemes({
  durangoClient,
  anonymousKey: themeOwnerKey,
  // A ~960px JPEG of the backdrop for the gallery (the original can be many MB).
  thumbnail: (bytes) => {
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (image.isEmpty()) return null;
    const { width } = image.getSize();
    return (width > 960 ? image.resize({ width: 960, quality: 'good' }) : image).toJPEG(78);
  },
});
// fx's own Vercel AI Gateway key, saved from Settings → Providers → fx. Stored
// like the Durango key (safeStorage-encrypted in packaged builds) and only
// handed to fx processes whose route is AI Gateway.
const fxGatewayKeyFilePath = () => path.join(app.getPath('userData'), 'fx-gateway-key.json');
const readFxGatewayApiKey = async () => {
  try {
    return decryptAccountToken(JSON.parse(await fs.readFile(fxGatewayKeyFilePath(), 'utf8')).key) || null;
  } catch {
    return null;
  }
};
const writeFxGatewayApiKey = async (key) => {
  const target = fxGatewayKeyFilePath();
  if (!key) {
    await fs.rm(target, { force: true });
    return;
  }
  if (app.isPackaged && !canUseSafeStorage()) {
    throw new Error('Secure storage is unavailable, so the key cannot be saved.');
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ key: encryptAccountToken(key) }), { mode: 0o600 });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
};
configureFxProvider({
  getDurangoCredentials: () => durangoCredentials.get(),
  isDurangoSignedIn: async () => !durangoMock && Boolean(await readAccountSession()),
  readGatewayApiKey: readFxGatewayApiKey,
});
const durangoProfileMemory = createProfileMemoryCache({ getClient: () => durangoClient });
// MCP servers from the Durango account (durango.sh Settings → Connectors),
// added to runs next to Durango Code's own MCP servers while signed in.
const accountConnectors = createAccountConnectors({
  getClient: () => durangoClient,
  isSignedIn: async () => durangoMock || Boolean(await readAccountSession()),
  reservedNames: reservedNicknames,
});
// Lazily connect an already-signed-in user (startup) or a fresh sign-in, off
// the critical path; tools mint on demand anyway if this fails.
const warmDurangoKey = () => {
  if (durangoMock) return;
  void durangoCredentials.get().catch(() => {});
};
const durangoIpcError = (error) => ({
  ok: false,
  code: error instanceof DurangoError ? error.code : 'network',
  error: error instanceof DurangoError ? error.message : durangoErrorText(error),
});

const clearAccountSession = async ({ preserveRepository = false } = {}) => {
  const repositoryClear = preserveRepository ? Promise.resolve() : repositoryCredentials.clear({ revokeRemote: true });
  // The Durango key follows the repository credential: an expired session
  // keeps it (it is unusable while signed out and is revoked with the next
  // session on sign-in); explicit sign-out revokes it with the session that
  // is ending, captured before that session is dropped.
  const durangoClear = preserveRepository
    ? Promise.resolve()
    : durangoCredentials.clear({ revokeRemote: true, session: inMemoryAccountSession });
  durangoProfileMemory.clear();
  accountConnectors.clear();
  sourceAttachments.clear();
  inMemoryAccountSession = null;
  // Authorization ends when sign-out begins, not after the session file has
  // finished being removed. This synchronously closes remote listeners and
  // sessions before any account transition can await filesystem work.
  notifyRemoteControlAccountChanged(null, { reconcile: false });
  // Durango Chat dispatch stops polling the moment sign-out begins.
  dispatchWorker.accountChanged(durangoMock);
  botReplyWorker.accountChanged(durangoMock);
  localBots.setActive(!durangoMock);
  deployWatcher.accountChanged(false);
  await Promise.all([repositoryClear, durangoClear.catch(() => {})]);
  await fs.rm(getAccountSessionFilePath(), { force: true });
};

const publishAccountState = async (session) => {
  const effectiveSession = session === undefined ? await readAccountSession() : session;
  const account = desktopAccountForRenderer(effectiveSession);
  const wasAuthenticated = lastPublishedAccountAuthenticated;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('account:changed', account);
  }
  // Only real sign-in/out transitions invalidate account-scoped sync state.
  // Startup restoration and OAuth validation refreshes still update renderers
  // without forcing a full workspace backfill.
  if (
    lastPublishedAccountAuthenticated !== null &&
    lastPublishedAccountAuthenticated !== account.authenticated
  ) {
    notifyWorkspaceSyncAccountChanged();
  }
  lastPublishedAccountAuthenticated = account.authenticated;
  // Remote control is gated on the live session: sign-out must stop the
  // listener and drop every connection immediately, sign-in re-arms it.
  notifyRemoteControlAccountChanged(effectiveSession);
  // Same for Durango Chat dispatch (never claims while signed out) and the
  // deploy watcher (never checks or deploys while signed out).
  dispatchWorker.accountChanged(durangoMock || account.authenticated);
  botReplyWorker.accountChanged(durangoMock || account.authenticated);
  // Bots on this device while signed out; signing in uploads them to Durango.
  localBots.setActive(!(durangoMock || account.authenticated));
  if (account.authenticated && wasAuthenticated !== true) void syncLocalBotsToDurango();
  deployWatcher.accountChanged(account.authenticated);
  return account;
};

const migrateAccountUserId = async (previousUser, nextUser) => {
  const fromUserId = typeof previousUser?.id === 'string' ? previousUser.id : null;
  const toUserId = typeof nextUser?.id === 'string' ? nextUser.id : null;
  if (!fromUserId || !toUserId || fromUserId === toUserId) return;
  const [remote] = await Promise.allSettled([
    migrateRemoteControlUserId({ fromUserId, toUserId }),
    repositoryCredentials.rebindUser(fromUserId, nextUser),
  ]);
  if (remote.status === 'fulfilled' && remote.value?.error) {
    console.error('account: could not migrate remote-control pairings', remote.value.error);
  }
};

const verifyAccountSession = async () => {
  const session = await readAccountSession();
  if (!session?.token) return desktopAccountForRenderer(null);

  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
    await clearAccountSession({ preserveRepository: true });
    return publishAccountState(null);
  }

  try {
    const response = await fetch(new URL('/api/desktop-auth/session', getDurangoWebUrl()), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${session.token}`,
      },
    });

    if (response.status === 401) {
      await clearAccountSession({ preserveRepository: true });
      return publishAccountState(null);
    }

    if (!response.ok) {
      return desktopAccountForRenderer(session);
    }

    const data = await response.json();
    const nextSession = {
      token: session.token,
      user: data.user ?? session.user,
      expiresAt: data.expiresAt ?? session.expiresAt ?? null,
    };
    // Durango identity cutover: the same desktop session (same app user)
    // now reports a different native Clerk id. Rebind pairings and the
    // repository credential to it before anything compares ids, so users
    // neither re-pair machines nor mint a second repository token.
    await migrateAccountUserId(session.user, nextSession.user);
    await writeAccountSession(nextSession);
    void readRepositorySession().catch(() => {});
    warmDurangoKey();
    return publishAccountState(nextSession);
  } catch {
    return desktopAccountForRenderer(session);
  }
};

const buildDesktopAuthUrl = (state, codeChallenge) => {
  const url = new URL('/desktop/authorize', getDurangoWebUrl());
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', `${appProtocol}://auth/callback`);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('app_version', app.getVersion());
  url.searchParams.set('platform', process.platform);
  return url;
};

const startDesktopAuth = async () => {
  const state = randomBase64Url(24);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = sha256Base64Url(codeVerifier);
  pendingDesktopAuth = {
    state,
    codeVerifier,
    createdAt: Date.now(),
  };

  const url = buildDesktopAuthUrl(state, codeChallenge);
  await shell.openExternal(url.toString());
  return { ok: true, url: url.toString() };
};

const isDesktopAuthCallbackUrl = (rawUrl) => {
  try {
    const url = new URL(rawUrl);
    return url.protocol === `${appProtocol}:` && url.hostname === 'auth' && url.pathname === '/callback';
  } catch {
    return false;
  }
};

const exchangeDesktopAuthCode = async ({ code, state, codeVerifier }) => {
  const response = await fetch(new URL('/api/desktop-auth/exchange', getDurangoWebUrl()), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      state,
      codeVerifier,
      appVersion: app.getVersion(),
      platform: process.platform,
    }),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(data?.error || 'Could not authorize Durango Code.');
  }

  return data;
};

const handleDesktopAuthCallback = async (rawUrl) => {
  if (!isDesktopAuthCallbackUrl(rawUrl)) return false;

  const callbackUrl = new URL(rawUrl);
  const state = callbackUrl.searchParams.get('state');
  const code = callbackUrl.searchParams.get('code');
  const error = callbackUrl.searchParams.get('error');

  if (error) {
    await publishAccountState(await readAccountSession());
    return true;
  }

  const pending = pendingDesktopAuth;
  pendingDesktopAuth = null;

  if (!pending || !state || pending.state !== state || !code) {
    await publishAccountState(await readAccountSession());
    return true;
  }

  if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
    await publishAccountState(await readAccountSession());
    return true;
  }

  try {
    const session = await exchangeDesktopAuthCode({
      code,
      state,
      codeVerifier: pending.codeVerifier,
    });
    await repositoryCredentials.clear({ revokeRemote: true });
    // A key left over from an expired session is revoked with the new one.
    await durangoCredentials.clear({ revokeRemote: true, session }).catch(() => {});
    durangoProfileMemory.clear();
    accountConnectors.clear();
    sourceAttachments.clear();
    await writeAccountSession(session);
    repositoryCredentials.resume();
    await publishAccountState(session);
    void readRepositorySession().catch(() => {});
    warmDurangoKey();
    void installDurangoGitCredentials();
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  } catch (exchangeError) {
    console.error('account:exchange error', exchangeError);
    await publishAccountState(await readAccountSession());
  }

  return true;
};

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// The single-instance lock is scoped to userData, and two live instances
// sharing one profile would clobber the store file. Give the dev build its
// own profile so it can run alongside the installed app instead of quitting
// immediately; seed it from the installed app's store on first run.
if (!app.isPackaged) {
  const liveUserData = app.getPath('userData');
  // ORION_DEV_USER_DATA points a dev run at its own profile (for example a
  // copy of a large real one, to measure startup) without touching either.
  const devUserData = process.env.ORION_DEV_USER_DATA
    ? path.resolve(process.env.ORION_DEV_USER_DATA)
    : devUserDataPath(liveUserData);
  try {
    mkdirSync(devUserData, { recursive: true });
    // Seed only a brand-new dev profile — BOTH files absent. An existing dev
    // profile owns its history: copying just the installed profile's threads
    // file into it would graft the installed transcripts over the dev
    // store's embedded threads on hydration (the pre-split migration path),
    // and a surviving dev threads file next to a copied installed store
    // would graft dev transcripts onto unrelated projects/settings. A
    // partial dev profile recovers through the renderer's own hydration
    // fallbacks instead.
    if (
      !existsSync(path.join(devUserData, storageFileName)) &&
      !existsSync(path.join(devUserData, threadsFileName)) &&
      !existsSync(path.join(devUserData, threadsDirectoryName))
    ) {
      for (const fileName of [storageFileName, threadsFileName]) {
        const liveFile = path.join(liveUserData, fileName);
        const devFile = path.join(devUserData, fileName);
        if (!existsSync(devFile) && existsSync(liveFile)) {
          copyFileSync(liveFile, devFile);
        }
      }
      const liveThreadsDirectory = path.join(liveUserData, threadsDirectoryName);
      const devThreadsDirectory = path.join(devUserData, threadsDirectoryName);
      if (!existsSync(devThreadsDirectory) && existsSync(liveThreadsDirectory)) {
        cpSync(liveThreadsDirectory, devThreadsDirectory, { recursive: true });
      }
    }
  } catch (error) {
    console.warn('Could not seed dev profile, starting empty:', error);
  }
  app.setPath('userData', devUserData);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(appProtocol, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(appProtocol);
}

// orion://theme/install?slug=<slug> (the Install button on a community theme
// page): kept until the renderer asks (it may not be loaded yet), then it
// shows the install dialog; nothing installs without the user's click.
let pendingThemeInstall = null;
const handleThemeInstallLink = (rawUrl) => {
  const slug = themeInstallLinkSlug(rawUrl, appProtocol);
  if (!slug) return false;
  pendingThemeInstall = slug;
  const [window] = BrowserWindow.getAllWindows();
  if (window && !window.isDestroyed()) {
    window.webContents.send('themes:installRequest', slug);
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
  return true;
};

// orion://thread/<id> (a thread link in a bot reply on durango.sh): opens that thread here.
const threadOpenLinks = createThreadOpenLinks({ protocol: appProtocol, getWindow: () => BrowserWindow.getAllWindows()[0] ?? null });

app.on('second-instance', (_event, argv) => {
  const callbackUrl = argv.find((arg) => isDesktopAuthCallbackUrl(arg));
  if (callbackUrl) {
    void handleDesktopAuthCallback(callbackUrl);
  }
  const themeLink = argv.find((arg) => themeInstallLinkSlug(arg, appProtocol));
  if (themeLink) handleThemeInstallLink(themeLink);
  const threadLink = argv.find((arg) => arg.startsWith(`${appProtocol}://thread/`));
  if (threadLink) threadOpenLinks.handle(threadLink);

  const [window] = BrowserWindow.getAllWindows();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (handleThemeInstallLink(url)) return;
  if (threadOpenLinks.handle(url)) return;
  void handleDesktopAuthCallback(url);
});

const createWindow = () => {
  const macWindowChrome =
    process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 22, y: 22 },
        }
      : {};

  const appIcon = nativeImage.createFromPath(getAppIconPath());

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1451,
    height: 907,
    minWidth: 900,
    minHeight: 600,
    title: PRODUCT_DISPLAY_NAME,
    icon: appIcon,
    backgroundColor: '#101012',
    ...macWindowChrome,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Electron disables Chromium plugins by default; its built-in PDF
      // viewer needs them in order to render Code-tab PDF iframes.
      plugins: true,
      // Security best practices: nodeIntegration false, contextIsolation true (default)
    },
  });

  // Never let an anchor replace Orion's only renderer document. Markdown
  // links are routed explicitly in the renderer, while this main-process
  // guard safely catches target=_blank and any future unhandled anchors.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = externalWebUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl).catch((error) =>
        console.error('Could not open external window URL', error)
      );
    }
    return { action: 'deny' };
  });
  // Cmd/Ctrl+Alt+Shift+0 always returns to the stock look, even when a theme's
  // CSS hides Settings (ui-themes-store.js).
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      input.alt &&
      input.shift &&
      (input.meta || input.control) &&
      (input.code === 'Digit0' || input.code === 'Numpad0')
    ) {
      event.preventDefault();
      void setActiveTheme(null).catch(() => {});
    }
  });
  // show_html visuals (about:srcdoc frames) may never navigate: that would
  // send a request the frame's CSP cannot stop (visual-tools.js).
  guardVisualFrames(mainWindow.webContents, webFrameMain);
  // Spelling suggestions and edit actions on right-click (built on demand).
  attachTextContextMenu(mainWindow, { Menu, clipboard, shell, externalUrl: externalWebUrl });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow.webContents.getURL()) return;
    event.preventDefault();
    const externalUrl = externalWebUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl).catch((error) =>
        console.error('Could not open external navigation URL', error)
      );
    }
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  // A renderer that dies (crash, OOM, stray signal) would leave a blank window.
  // Recover like closing the window and opening a new one (window-all-closed,
  // then activate): stop the work the dead renderer was following, and let
  // goal pauses and transcript saves land before the new renderer hydrates.
  reloadWhenRendererGone(mainWindow, {
    isShuttingDown: () => appShutdownRequested,
    reload: () => {
      disposeRendererBoundWork();
      void waitForPendingAgentShutdowns()
        .then(() => threadsSaveQueue.catch(() => {}))
        .then(() => {
          if (!mainWindow.isDestroyed() && !appShutdownRequested) mainWindow.webContents.reload();
        });
    },
  });

  // DevTools can still be opened manually from the Electron menu when needed.
  browserMainWindow = mainWindow;
  // The window's own focus, for theme motion (themes/motionPolicy.ts): the
  // page's focus also drops when a built-in browser tab takes it, which is
  // still using the app.
  const sendWindowFocus = () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('app:windowFocus', mainWindow.isFocused());
  };
  mainWindow.on('focus', sendWindowFocus);
  mainWindow.on('blur', sendWindowFocus);
  mainWindow.on('closed', () => {
    if (browserMainWindow === mainWindow) browserMainWindow = null;
  });
  return mainWindow;
};

// -------------------- Built-in browser --------------------
// Tabs are WebContentsViews owned here (main/browser/manager.js); the
// renderer's browser panel positions the visible one, agents drive them
// through the browser_* tools (main/browser-tools.js).
let browserMainWindow = null;
let browserManager = null;
const getBrowserManagerInstance = () => {
  if (!browserManager) {
    browserManager = createBrowserManager({
      getWindow: () =>
        browserMainWindow && !browserMainWindow.isDestroyed()
          ? browserMainWindow
          : BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null,
      emit: (channel, payload) => sendToAllWindows(channel, payload),
    });
    setBrowserManager(browserManager, { screenshotsDirectory: browserScreenshotsDirectory() });
  }
  return browserManager;
};
const handleBrowserIpc = (channel, action) => {
  ipcMain.handle(channel, async (_event, input) => {
    try {
      return await getBrowserManagerInstance().userActions[action](input ?? {});
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  });
};
handleBrowserIpc('browser:list', 'list');
handleBrowserIpc('browser:create', 'create');
handleBrowserIpc('browser:navigate', 'navigate');
handleBrowserIpc('browser:back', 'back');
handleBrowserIpc('browser:forward', 'forward');
handleBrowserIpc('browser:reload', 'reload');
handleBrowserIpc('browser:stop', 'stop');
handleBrowserIpc('browser:close', 'close');
handleBrowserIpc('browser:select', 'select');
handleBrowserIpc('browser:setBounds', 'setBounds');
handleBrowserIpc('browser:thumbnail', 'thumbnail');
handleBrowserIpc('browser:takeControl', 'takeControl');
handleBrowserIpc('browser:releaseControl', 'releaseControl');
handleBrowserIpc('browser:adopt', 'adopt');
handleBrowserIpc('browser:answerDialog', 'answerDialog');
handleBrowserIpc('browser:answerDownload', 'answerDownload');
handleBrowserIpc('browser:setOptions', 'setOptions');
handleBrowserIpc('browser:closeThreadTabs', 'closeThreadTabs');
handleBrowserIpc('browser:setThreadParents', 'setThreadParents');
handleBrowserIpc('browser:clearData', 'clearData');
ipcMain.handle('browser:setVisible', (_event, visible) => getBrowserManagerInstance().userActions.setVisible(visible === true));

// First-party skills install in the background; only the skills list and
// agent runs (whose CLI reads the skills folder at launch) wait for them.
let bundledSkillsReady = Promise.resolve();
// Remote control initializes after the window opens (see whenReady).
let remoteControlReady = Promise.resolve();

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Settings → Themes themes (ui-themes-store.js): agents' theme
  // tools and the renderer share this one store.
  configureThemeStore({
    dir: path.join(app.getPath('userData'), 'themes'),
    send: (snapshot) => sendToAllWindows('themes:changed', snapshot),
  });
  bundledSkillsReady = ensureBundledSkills()
    .then(() => {})
    .catch((error) => console.error('Could not install bundled agent skills', error));
  // Secret files (request_secret) expire after 24 hours: swept now (left
  // over from earlier runs) and hourly while the app runs.
  startSecretFileSweeps();
  // Reinforce the internal app name (helps in some dev launch scenarios). It
  // must stay "Orion": see ./main/app-identity.js.
  app.setName(INTERNAL_APP_NAME);

  // Start maintenance immediately, but never hold the first window behind
  // shell startup or filesystem cleanup. Provider and MCP operations await
  // only the prerequisite they actually need.
  startShellPathSync();
  startLegacyMcpCleanup();
  setTimeout(() => {
    void sweepOrphanAntigravityTempSessions().catch(() => {});
  }, 4000).unref?.();
  void initDevices().catch((error) => console.error('Device setup failed:', error));
  void installBundledCli();
  void installDurangoGitCredentials();

  // Seed the model catalog from the last discovery so the first picker render
  // and first turn never wait on provider CLIs, then revalidate it in the
  // background; windows refetch whenever a refresh changes the list.
  onAgentModelsChanged(() => sendToAllWindows('agent:modelsChanged'));
  void configureAgentModelsCache(path.join(app.getPath('userData'), 'agent-models-cache.json')).then(() =>
    getAgentModels().catch(() => {})
  );
  // A sign-in changed in a terminal (another account, or signed out) shows up
  // when the user comes back to the window: refresh that provider's models
  // and status as if it had signed in here (providers:authenticated).
  const providerSignInWatch = createProviderSignInWatch({
    onChange: (providerIds) => {
      invalidateAgentModelsCache();
      clearProviderUsageLimitsCache(providerIds);
      getAgentModels({ fresh: true }).catch(() => {});
      for (const providerId of providerIds) sendToAllWindows('providers:authenticated', { providerId });
    },
  });
  void providerSignInWatch.check();
  app.on('browser-window-focus', () => {
    void providerSignInWatch.check();
  });

  // Workspace sync (opt-in, contract in orion-web/docs/workspace-sync.md).
  // Seed the engine from the persisted store so an enabled sync resumes after
  // restart without waiting for the renderer to hydrate; the renderer re-pushes
  // the settings over sync:configure on hydration and every change.
  initWorkspaceSync({
    getWebUrl: () => getDurangoWebUrl(),
    readSession: () => readAccountSession(),
    readStoreState: () => readPersistedStoreState(),
    readThreadsIndex,
    readThreadsByIds,
    readThreadsForSync,
    getSyncLedgerPath: () => getSyncLedgerFilePath(),
    pushOrionSourceControl: async ({ gitRoot, token, signal }) => {
      const branch = await getCurrentGitBranch(gitRoot);
      if (!branch) throw new Error('Cannot push from a detached HEAD.');
      return await pushOrionSourceControl({ gitRoot, branch, token, signal });
    },
    broadcast: (channel, payload) => sendToAllWindows(channel, payload),
  });
  void readPersistedStoreState().then((state) => {
    // Same consent reconciliation as the renderer store (work sharing
    // defaults to Full; a persisted "off" made after consent v1 sticks).
    // A store without settings yet is a fresh install: the renderer pushes
    // its defaults on hydration.
    if (state?.workspaceSyncSettings) {
      configureWorkspaceSync(migrateWorkspaceSyncSettings(state.workspaceSyncSettings));
    }
  });

  // Remote control (opt-in): lets paired Orion instances on the same account
  // view and drive this one. Same seeding strategy as workspace sync. Its
  // startup reconcile refreshes the account over the network, so the window
  // opens without it; the remote IPC handlers and the account publish below
  // wait for it instead.
  remoteControlReady = initRemoteControl({
    readSession: () => readAccountSession(),
    readStoreState: () => readPersistedStoreState(),
    readThreadsIndex,
    readThreadById,
    // Cached-list entry point (same path as agent:listModels without `force`),
    // so a remote `models` request never triggers a CLI re-probe by itself.
    listAgentModels: () => listAgentModelsWithAvailability(),
    broadcast: (channel, payload) => sendToAllWindows(channel, payload),
    dispatchRendererCommand: (payload) => dispatchRemoteCommand(payload),
    // A run a controller follows ended: the renderer saves its threads now
    // (controllers read the finished turn from the saved file).
    flushRendererThreads: () => sendToAllWindows('remote:flushThreads', null),
    // Paired machines may ask this one to clone a Source repository it lacks.
    ...(sourceCheckoutAvailable() ? { checkoutSourceProject: (input) => checkoutSourceProject(input) } : {}),
    createRemotePairingProof,
    verifyRemotePairingProof,
    registerRelayDevice,
    deregisterRelayDevice,
    listRelayDevices,
    mintRelayTicket,
    projectRepoIds,
    getAttachmentDirectoryPath,
    getRemoteAttachmentCacheDir: () => path.join(getAttachmentDirectoryPath(), 'remote'),
    threadGitState: (threadId) => remoteThreadGitState(threadId),
    listAgentQuestions: (threadId) => listAgentQuestions(threadId),
    hasPendingQuestions: (threadId) => listAgentQuestions(threadId).length > 0,
    getAppVersion: () => app.getVersion(),
  }).catch((error) => console.error('Could not start remote control', error));
  // read_thread reads threads of other machines from them.
  void remoteControlReady.then(() => setThreadReaderRemoteFetch(fetchRemoteThread));
  // Agents reach the user's other machines through it (machine-tools.js).
  configureMachineTools({
    ready: remoteControlReady,
    resolveCallerProject: ({ machineId, projectPath }) => resolveCallerProjectOnMachine({ machineId, projectPath }),
  });
  addAgentEventListener((event) => forwardAgentEventToRemote(event));
  // Durango Chat dispatch (off by default). Seed from the persisted store so
  // an enabled worker resumes before the renderer hydrates; the renderer
  // re-pushes settings and projects over durango:configure on every change.
  // The deploy watcher (off by default) is seeded and gated the same way.
  powerMonitor.on('suspend', () => {
    dispatchWorker.suspend();
    botReplyWorker.suspend();
    deployWatcher.suspend();
  });
  powerMonitor.on('resume', () => {
    dispatchWorker.resume();
    botReplyWorker.resume();
    deployWatcher.resume();
  });
  void Promise.all([readPersistedStoreState(), isDispatchSignedIn()])
    .then(async ([state, signedIn]) => {
      if (dispatchConfigureSeq === 0 && state?.durangoSettings) {
        await configureDurango({
          useDurangoTasks: state.durangoSettings.useDurangoTasks,
          dispatch: state.durangoSettings.dispatch,
          deployWatcher: state.durangoSettings.deployWatcher,
          projects: state.projects,
        });
      }
      dispatchWorker.accountChanged(signedIn);
      botReplyWorker.accountChanged(signedIn);
      localBots.setActive(!signedIn);
      // A sync that failed last time is retried at start.
      if (signedIn) void syncLocalBotsToDurango();
      deployWatcher.accountChanged(signedIn && !durangoMock);
    })
    .catch((error) => console.error('Could not start Durango Chat dispatch', error));
  void remoteControlReady
    .then(() => readPersistedStoreState())
    .then((state) =>
      state?.remoteControlSettings
        ? configureRemoteControl({
            ...state.remoteControlSettings,
            // Mirror the store's hydration lift (src/store.ts persist merge):
            // the UI has no separate allow-incoming toggle anymore, and this
            // startup path reads the raw persisted JSON before the renderer
            // has hydrated and reconfigured.
            allowIncoming:
              state.remoteControlSettings.enabled === true ||
              state.remoteControlSettings.allowIncoming === true,
          })
        : undefined
    )
    .catch((error) => {
      console.error('Could not restore remote control settings', error);
    });

  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: PRODUCT_DISPLAY_NAME,
      applicationVersion: app.getVersion(),
      copyright: '© Complexia',
    });
    // Electron's default menu labels its app-menu items from app.getName(),
    // which stays the internal "Orion" (see ./main/app-identity.js). Mirror
    // the default menu with explicit customer-facing labels instead.
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: PRODUCT_DISPLAY_NAME,
          submenu: [
            { role: 'about', label: `About ${PRODUCT_DISPLAY_NAME}` },
            { type: 'separator' },
            {
              label: 'Use Stock Theme',
              accelerator: 'CmdOrCtrl+Alt+Shift+0',
              click: () => void setActiveTheme(null).catch(() => {}),
            },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide', label: `Hide ${PRODUCT_DISPLAY_NAME}` },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit', label: `Quit ${PRODUCT_DISPLAY_NAME}` },
          ],
        },
        { role: 'fileMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
        { role: 'help', submenu: [] },
      ])
    );
  }

  protocol.handle(SOURCE_ATTACHMENT_PROTOCOL, sourceAttachments.handle);

  protocol.handle(attachmentProtocol, async (request) => {
    try {
      const url = new URL(request.url);
      // The renderer may pass several `path` candidates for one media
      // reference (e.g. a relative markdown path resolved against the project
      // dir and against the grok session dir) — serve the first that exists.
      const requestedPaths = url.searchParams.getAll('path');
      const attachmentDir = path.resolve(getAttachmentDirectoryPath());
      const candidatePaths = requestedPaths.length
        ? requestedPaths.map((requestedPath) =>
            path.resolve(
              /^~[\\/]/.test(requestedPath)
                ? path.join(os.homedir(), requestedPath.slice(2))
                : requestedPath
            )
          )
        : [
            path.resolve(
              getAttachmentDirectoryPath(),
              path.basename(decodeURIComponent(url.pathname.replace(/^\/+/, '')))
            ),
          ];

      let filePath = null;
      let stats = null;
      for (const candidate of candidatePaths) {
        const isSavedAttachment = candidate.startsWith(`${attachmentDir}${path.sep}`);
        const isMediaPreview = mediaPreviewExtensions.has(path.extname(candidate).toLowerCase());
        if (!isSavedAttachment && !isMediaPreview) continue;
        const candidateStats = await fs.stat(candidate).catch(() => null);
        if (candidateStats?.isFile()) {
          filePath = candidate;
          stats = candidateStats;
          break;
        }
      }
      if (!filePath) {
        return new Response('Not found', { status: 404 });
      }

      const headers = {
        'content-type': getMimeTypeForMediaPath(filePath),
        'cache-control': 'no-store',
        'accept-ranges': 'bytes',
      };

      if (stats.size === 0) {
        return new Response(new Uint8Array(), { headers });
      }

      // Honor Range requests so <video> can seek.
      let start = 0;
      let end = stats.size - 1;
      let status = 200;
      const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
      if (rangeMatch && (rangeMatch[1] || rangeMatch[2])) {
        if (rangeMatch[1]) {
          start = Number(rangeMatch[1]);
          if (rangeMatch[2]) end = Math.min(end, Number(rangeMatch[2]));
        } else {
          start = Math.max(0, stats.size - Number(rangeMatch[2]));
        }
        if (start > end || start >= stats.size) {
          return new Response('Range not satisfiable', {
            status: 416,
            headers: { 'content-range': `bytes */${stats.size}` },
          });
        }
        status = 206;
        headers['content-range'] = `bytes ${start}-${end}/${stats.size}`;
      }
      headers['content-length'] = String(end - start + 1);

      return new Response(Readable.toWeb(createReadStream(filePath, { start, end })), {
        status,
        headers,
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  createWindow();
  void startSnapShot().catch((error) => console.error('Could not start SnapShot', error));
  getBrowserManagerInstance();
  await remoteControlReady;

  const startupThemeLink = process.argv.find((arg) => themeInstallLinkSlug(arg, appProtocol));
  if (startupThemeLink) pendingThemeInstall = themeInstallLinkSlug(startupThemeLink, appProtocol);
  const startupThreadLink = process.argv.find((arg) => arg.startsWith(`${appProtocol}://thread/`));
  if (startupThreadLink) threadOpenLinks.handle(startupThreadLink);
  const startupAuthUrl = process.argv.find((arg) => isDesktopAuthCallbackUrl(arg));
  if (startupAuthUrl) {
    void handleDesktopAuthCallback(startupAuthUrl);
  } else {
    void publishAccountState(await readAccountSession());
  }

  if (process.platform === 'darwin') {
    const dockIcon = nativeImage.createFromPath(getAppIconPath());
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon);
    }
  }

  scheduleAppUpdateChecks();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    // A quit may be briefly draining agent persistence after the old window
    // closes. Do not recreate an interactive renderer that can only reject
    // new turns while the process is committed to exiting.
    if (appShutdownRequested) return;
    if (BrowserWindow.getAllWindows().length === 0) {
      // Closing the previous window can still be pausing a live /goal and
      // patching that state into the separately persisted transcripts. Do not
      // let a quickly reopened renderer hydrate the older active snapshot and
      // enqueue a newer save that overwrites the pause.
      void waitForPendingAgentShutdowns()
        .then(() => threadsSaveQueue.catch(() => {}))
        .then(() => {
          if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    }
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
// Quit waits for tracked provider termination (including forced escalation)
// plus any /goal pause requested by a reap, so neither can be cut off by main
// process exit.

// A shutdown-time goal pause lands after the renderer (and its unload thread
// flush) is gone: the persisted thread still says goal.status 'active', so a
// relaunch would show an Active goal with no live run and offer Pause
// instead of Resume. Patch the persisted transcripts directly; serialized on
// the threads save queue with a fresh sequence so it cannot fight other
// writers.
const patchPersistedGoalPause = (threadIds) => {
  if (threadIds.length === 0) return;
  const seq = ++threadsWriteSeq;
  threadsSaveQueue = threadsSaveQueue
    .catch(() => {})
    .then(async () => {
      const threads = await readThreadsByIds(threadIds);
      const changed = [];
      for (const thread of threads) {
        if (thread?.goal?.status === 'active') {
          thread.goal.status = 'paused';
          thread.goal.updatedAt = Date.now();
          changed.push(thread);
        }
      }
      if (changed.length === 0 || seq <= threadsCommittedSeq) return;
      await writeThreadsPatch({ version: 2, upserts: changed });
      threadsCommittedSeq = Math.max(threadsCommittedSeq, seq);
    });
};

const reapActiveAgentRuns = () => {
  completedCodexQuestions.clear();
  // A run can still be awaiting model/PATH/git setup and therefore have no
  // child or Claude turn to reap yet. Leave its startup entry in place for
  // the handler's post-await guard, but make that guard terminal: on macOS
  // the main process survives the last window and must not launch invisible
  // work after its renderer has gone away.
  for (const starting of startingAgentRuns.values()) {
    starting.aborted = true;
    starting.abortController?.abort(new Error('Agent startup was cancelled.'));
    starting.terminateBackground = true;
  }
  const shutdowns = [];
  const goalThreadIds = [];
  for (const [runId, run] of activeAgentRuns) {
    // Mark the kill as intentional BEFORE it lands: a resumed one-shot run
    // that dies with no output otherwise satisfies the resume-failure
    // fallback in its close handler, which would startAttempt(null) a fresh
    // invisible agent process after the renderer is gone.
    stoppedAgentRuns.add(runId);
    const goalDriver = codexGoalRunDrivers.get(runId);
    if (goalDriver) {
      codexGoalRunDrivers.delete(runId);
      goalThreadIds.push(run.threadId);
      // Mirror agent:stopTurn: ask the app-server to record the pause before
      // the process goes down — a raw kill leaves codex's goal DB claiming
      // an active goal that nothing is pursuing. Capped so teardown can't
      // hang on a wedged app-server.
      shutdowns.push(
        Promise.race([
          (async () => {
            try {
              await goalDriver.stopGoalRun();
            } catch {}
          })(),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]).then(() => killAgentChild(run.child))
      );
    } else {
      const driver = codexSteerableRunDrivers.get(runId);
      codexSteerableRunDrivers.delete(runId);
      shutdowns.push(
        (async () => {
          await driver?.dispose?.();
          await killAgentChild(run.child);
        })()
      );
    }
  }
  activeAgentRuns.clear();
  if (shutdowns.length > 0) {
    trackAgentShutdown(
      Promise.all(shutdowns)
        .then(() => {
          if (goalThreadIds.length === 0) return undefined;
          // Reflect goal pauses in the persisted threads too, and hold the
          // quit barrier open until they are on disk.
          patchPersistedGoalPause(goalThreadIds);
          return threadsSaveQueue.catch(() => {});
        })
    );
  }
};

// Work only a live renderer can follow. Once the renderer is gone (window
// closed, or its process died and the window reloads), tear it down so its
// output is not sent to destroyed webContents and background agents cannot
// keep working invisibly: a fresh renderer cannot reattach to these runs.
const disposeRendererBoundWork = () => {
  disposeAllClaudeSdkSessions();
  disposeAllTerminalSessions();
  disposeAllCodexGoalOps();
  disposeAllTitleGenerations();
  reapActiveAgentRuns();
};

app.on('window-all-closed', () => {
  // On macOS the main process remains alive after the last window closes.
  disposeRendererBoundWork();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Persistent claude sessions outlive individual turns; kill their CLI
// processes (and any background subagents inside them) when Orion exits.
const disposeForQuit = (reason = 'quit') => {
  appShutdownRequested = true;
  appShutdownReason ??= reason;
  disposeAllClaudeSdkSessions();
  disposeAllTerminalSessions();
  disposeAllCodexGoalOps();
  disposeAllTitleGenerations();
  cancelActiveProviderUpdate();
  stopAllDurangoWorkspaceServers();
  // Ends agent-device sessions and stops its daemon; simulators keep running.
  // Idempotent and bounded; waitForPendingQuitWork awaits the same promise.
  void shutdownDevices();
  reapActiveAgentRuns();
  void antigravitySessionManager.shutdown();
  void closeMcpBridge();
  if (!codexAppServerShutdownPromise) {
    // Goal runs must record their pause through the shared server before it
    // exits. Once all per-run connections are reaped, stop the server itself.
    // This server owns no Orion persistence, so do not put its process reap in
    // the global quit barrier: a wedged helper must not leave a live renderer
    // permanently rejecting every follow-up as if an update were installing.
    codexAppServerShutdownPromise = waitForPendingAgentShutdowns().then(() =>
      codexAppServerManager.shutdown()
    );
  }
};

// Resolves once active children have exited (including the SIGKILL fallback),
// any /goal pauses are recorded, and the latest transcript queue has settled.
// Waiting for the queue after agent shutdown matters: shutdown can enqueue a
// goal-pause persistence write of its own.
const waitForPendingQuitWork = () =>
  Promise.all([
    waitForPendingAgentShutdowns(),
    waitForProviderUpdateShutdown(),
    waitForRemoteControlPersistence(),
    // agent-device sessions and daemon (bounded; never rejects).
    shutdownDevices(),
  ])
    .then(() => threadsSaveQueue.catch(() => {}));

const appShutdownError = () =>
  appShutdownReason === 'update'
    ? 'Durango Code is restarting to install an update.'
    : 'Durango Code is shutting down.';

app.on('will-quit', (event) => {
  disposeSnapShot();
  shutdownWorkspaceSync();
  shutdownRemoteControl();
  dispatchWorker.stop();
  botReplyWorker.stop();
  void localBots.stop();
  deployWatcher.stop();
  disposeForQuit();
  if (quitBarrierSatisfied) return;

  // Hold quit open until the pending work above has landed.
  event.preventDefault();
  if (!quitAfterPendingWork) {
    quitAfterPendingWork = true;
    void waitForPendingQuitWork().finally(() => {
      quitAfterPendingWork = false;
      quitBarrierSatisfied = true;
      app.quit();
    });
  }
});

// The updater installs by quitting the app, and the barrier above answers that
// quit with preventDefault() — which cancels the terminate Squirrel is waiting
// on. Drain the same work up front so the installing quit runs straight
// through instead of being held (and possibly dropped).
const settleQuitBarrierForUpdate = async () => {
  if (quitBarrierSatisfied) return;
  // Stop remote lifecycle work before taking the persistence-queue snapshot.
  // Otherwise a pairing/revoke could start after this pre-drain and be skipped
  // when will-quit sees the already-satisfied updater barrier.
  disposeSnapShot();
  shutdownWorkspaceSync();
  shutdownRemoteControl();
  dispatchWorker.stop();
  botReplyWorker.stop();
  void localBots.stop();
  deployWatcher.stop();
  disposeForQuit('update');
  // If a quit is already draining this same work, waiting on it here settles at
  // the same time; either way the barrier is open once the work has landed.
  await waitForPendingQuitWork().catch(() => {});
  quitBarrierSatisfied = true;
};

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

// -------------------- IPC Handlers --------------------

// Settings → Themes (ui-themes-store.js). Each change broadcasts
// 'themes:changed' with the full list, so these only return for errors.
const themeIpc = (channel, run) =>
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await run(...args) };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  });
themeIpc('themes:list', () => listThemes());
themeIpc('themes:setActive', (id) => setActiveTheme(typeof id === 'string' ? id : null));
themeIpc('themes:setSaved', (id, saved) => setThemeSaved(String(id), saved === true));
themeIpc('themes:rename', (id, name) => renameTheme(String(id), String(name ?? '')));
themeIpc('themes:duplicate', (id) => duplicateTheme(String(id)));
themeIpc('themes:delete', (id) => deleteTheme(String(id)));
themeIpc('themes:undo', (id) => undoTheme(String(id)));
themeIpc('themes:canUndo', (id) => canUndoTheme(String(id)));
themeIpc('themes:setValues', (id, values) => setThemeValues(String(id), values && typeof values === 'object' ? values : {}));
themeIpc('themes:resetValues', (id) => resetThemeValues(String(id)));
themeIpc('themes:setAnimate', (animate) => setThemesAnimate(animate !== false));
themeIpc('themes:adoptLegacyAnimate', (animate) => adoptLegacyThemesAnimate(animate !== false));
themeIpc('themes:frost', (id, asset, width, saturate) => makeThemeFrost(String(id), String(asset), Number(width), Number(saturate)));

// Static frost for an image backdrop (ThemeLayer useStaticFrost): a small copy
// of the picture that the renderer stretches behind each panel, so frosted
// panels need no live backdrop-filter. Made once per size and kept with the
// theme's files.
const makeThemeFrost = async (id, asset, width, saturate) => {
  if (!isThemeAssetName(asset) || isVideoAsset(asset)) return null;
  const source = themeAssetPath(id, asset);
  const size = Math.max(16, Math.min(320, Math.round(Number.isFinite(width) ? width : 96)));
  const amount = Math.max(0, Math.min(3, Number.isFinite(saturate) ? saturate : 1));
  const name = `frost-${size}-s${Math.round(amount * 100)}-${asset.replace(/\.[a-z0-9]+$/i, '')}.jpg`;
  const target = isThemeAssetName(name) ? themeAssetPath(id, name) : null;
  if (!source || !target) return null;
  try {
    await fs.access(target);
    return name;
  } catch {}
  const image = nativeImage.createFromPath(source);
  if (image.isEmpty()) return null;
  // Two steps down stays smooth where one big step would alias.
  let small = image.resize({ width: size * 4, quality: 'best' }).resize({ width: size, quality: 'best' });
  if (Math.abs(amount - 1) > 0.005) small = saturateImage(small, amount);
  await fs.writeFile(target, small.toJPEG(85));
  return name;
};

// CSS saturate() (Filter Effects matrix) on a small BGRA bitmap, the way the
// backdrop's own filter and the live panel blur's saturate(1.15) tint it.
const saturateImage = (image, s) => {
  const size = image.getSize();
  const pixels = Buffer.from(image.toBitmap());
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const b = pixels[index];
    const g = pixels[index + 1];
    const r = pixels[index + 2];
    const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
    pixels[index + 2] = clamp((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b);
    pixels[index + 1] = clamp((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b);
    pixels[index] = clamp((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b);
  }
  return nativeImage.createFromBitmap(pixels, size);
};

// manage_app_themes measure: CPU of each Durango Code process over a window.
setThemeToolsMetrics(() =>
  app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    name: metric.name ?? metric.serviceName ?? '',
    cpu: metric.cpu?.percentCPUUsage ?? 0,
    memoryKb: metric.memory?.workingSetSize ?? 0,
  }))
);
themeIpc('themes:videoForPoster', (id, asset) => videoForPoster(String(id), String(asset)));
themeIpc('themes:savePoster', (id, asset, data) => setVideoPoster(String(id), String(asset), data));
ipcMain.on('themes:sceneError', (_event, id, message) => recordSceneError(id, message));
// Community themes (theme-community.js).
themeIpc('themes:share', (id, options) => shareTheme(String(id), { listed: typeof options?.listed === 'boolean' ? options.listed : undefined }));
themeIpc('themes:setShareListed', (id, listed) => setSharedThemeListed(String(id), listed === true));
themeIpc('themes:unshare', (id) => unshareTheme(String(id)));
themeIpc('themes:previewCommunity', (slugOrUrl) => previewCommunityTheme(String(slugOrUrl ?? '')));
themeIpc('themes:installCommunity', (slugOrUrl, options) =>
  installCommunityTheme(String(slugOrUrl ?? ''), { appearance: options?.appearance === 'light' || options?.appearance === 'dark' ? options.appearance : undefined })
);
// T3 Code themes (theme-t3.js): import a file, export one.
themeIpc('themes:importT3File', async () => {
  const [window] = BrowserWindow.getAllWindows();
  const result = await dialog.showOpenDialog(window, {
    title: 'Import a T3 Code theme',
    properties: ['openFile'],
    filters: [{ name: 'T3 Code theme', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return importT3Theme(result.filePaths[0]);
});
themeIpc('themes:exportT3', async (id) => {
  const theme = await getTheme(String(id));
  if (!theme) throw new Error('That theme no longer exists.');
  const [window] = BrowserWindow.getAllWindows();
  const result = await dialog.showSaveDialog(window, {
    title: 'Export for T3 Code',
    defaultPath: path.join(app.getPath('downloads'), t3FileName(theme.name)),
    filters: [{ name: 'T3 Code theme', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return null;
  // The user picked the file (and agreed to replace it) in the save dialog.
  return exportThemeToT3(theme.id, result.filePath, { allowOverwrite: true });
});
themeIpc('themes:takeInstallRequest', () => {
  const slug = pendingThemeInstall;
  pendingThemeInstall = null;
  return slug;
});
themeIpc('themes:openGallery', async (slug) => {
  const url = await communityGalleryUrl();
  await shell.openExternal(typeof slug === 'string' && /^[a-z0-9]{10}$/.test(slug) ? `${url}/${slug}` : url);
  return url;
});

ipcMain.handle('storage:load', async () => {
  try {
    const storagePath = getStorageFilePath();
    const value = await fs.readFile(storagePath, 'utf-8');
    const sanitized = sanitizeStoreValue(value);
    if (sanitized && sanitized !== value) {
      await fs.writeFile(storagePath, sanitized, 'utf-8');
    }
    return sanitized;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('storage:load error', error);
    }
    return null;
  }
});

ipcMain.handle('storage:save', async (_event, value) => {
  // Chain on the settled queue (.catch first): a failed write must not leave
  // the queue permanently rejected, or every later save would skip its write
  // callback and fail with the stale error even after storage recovers.
  const seq = ++storageWriteSeq;
  const save = storageSaveQueue.catch(() => {}).then(async () => {
    if (seq <= storageCommittedSeq) return; // superseded by the sync flush
    const storagePath = getStorageFilePath();
    const tempPath = `${storagePath}.${process.pid}.tmp`;
    const sanitized = sanitizeStoreValue(value) ?? value;
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(tempPath, sanitized, 'utf-8');
    await fs.rename(tempPath, storagePath);
    if (seq >= storageCommittedSeq) {
      storageCommittedSeq = seq;
      return;
    }
    // The sync flush committed a newer snapshot while this rename was in
    // flight and may have been overwritten by it — reinstall the newer one.
    const snapshot = storageSyncSnapshot;
    if (snapshot && snapshot.seq > seq) {
      await fs.writeFile(tempPath, snapshot.value, 'utf-8');
      await fs.rename(tempPath, storagePath);
    }
  });
  storageSaveQueue = save;

  try {
    await save;
    // Projects/settings changed — nudge the (opt-in) workspace sync.
    notifyWorkspaceChanged();
    notifyRemoteWorkspaceChanged();
    return true;
  } catch (error) {
    console.error('storage:save error', error);
    return false;
  }
});

// Thread hydration (thread-storage.js): every thread's shell plus the
// transcripts of the open panes at startup; other transcripts load when the
// renderer needs them (loadThreadsBatch). Both arrive as JSON text.
ipcMain.handle('storage:loadThreadShells', async (_event, input) => {
  try {
    return { ok: true, value: await readThreadShells(input) };
  } catch (error) {
    console.error('storage:loadThreadShells error', error);
    return { ok: false };
  }
});

// Quit-time read of one stored thread (see storage:saveThreadsSync): changes
// the renderer queued for a transcript it hadn't loaded yet are saved with it.
ipcMain.on('storage:loadThreadSync', (event, id) => {
  try {
    event.returnValue = { ok: true, value: typeof id === 'string' ? readThreadRawSync(id) : null };
  } catch (error) {
    console.error('storage:loadThreadSync error', error);
    event.returnValue = { ok: false };
  }
});

// Full-text thread search runs here against the stored transcripts, so the
// renderer never holds them all (thread-storage.js).
ipcMain.handle('storage:searchThreads', async (_event, input) => {
  try {
    const result = await searchThreadBodies(input);
    // Null: a newer request superseded this one. The renderer's newer request
    // already carries every token its open searches still lack.
    return result ? { ok: true, tokens: result.tokens, scores: result.scores } : { ok: false, superseded: true };
  } catch (error) {
    console.error('storage:searchThreads error', error);
    return { ok: false };
  }
});

ipcMain.handle('storage:threadSearchExcerpts', async (_event, input) => {
  try {
    return { ok: true, excerpts: await searchThreadExcerpts(input) };
  } catch (error) {
    console.error('storage:threadSearchExcerpts error', error);
    return { ok: false };
  }
});

ipcMain.handle('storage:warmThreadSearch', async () => {
  try {
    return await warmThreadSearch();
  } catch (error) {
    console.error('storage:warmThreadSearch error', error);
    return false;
  }
});

ipcMain.handle('storage:loadThreadsBatch', async (_event, input) => {
  try {
    return { ok: true, value: await readThreadsBatch(input) };
  } catch (error) {
    console.error('storage:loadThreadsBatch error', error);
    return { ok: false };
  }
});

// Import conversations from Claude Code / Codex session stores. Scan returns
// lightweight summaries; the renderer then reads transcripts in small batches
// so no single response carries the whole history.
ipcMain.handle('sessionImport:scan', async (_event, input) => {
  try {
    return { ok: true, ...(await scanImportableSessions({ excludeSessionIds: input?.excludeSessionIds })) };
  } catch (error) {
    console.error('sessionImport:scan error', error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('sessionImport:read', async (_event, input) => {
  try {
    return { ok: true, sessions: await readImportableSessions({ sessions: input?.sessions }) };
  } catch (error) {
    console.error('sessionImport:read error', error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Workspace sync surface. Configure carries the renderer's persisted opt-in
// settings; the engine itself no-ops while disabled or signed out.
ipcMain.handle('sync:configure', (_event, value) => configureWorkspaceSync(value));
ipcMain.handle('sync:now', () => workspaceSyncNow());
ipcMain.handle('sync:getState', () => getWorkspaceSyncStatus());

// Remote control surface. The engine no-ops while disabled or signed out;
// every mutating handler re-checks the live account session inside the
// engine, so a stale renderer can never act on a signed-out machine. Calls
// wait for the engine's startup, which no longer holds up the window.
// Durango Source repository ids of projects (git config), cached: a remote
// snapshot or thread list asks for them every few seconds.
const REPO_ID_CACHE_MS = 5 * 60_000;
const repoIdCache = new Map(); // path → { repoId, at }
const repoIdForPath = async (projectPath) => {
  if (!projectPath) return null;
  const cached = repoIdCache.get(projectPath);
  if (cached && Date.now() - cached.at < REPO_ID_CACHE_MS) return cached.repoId;
  const repoId = (await getCloudRepoLink(projectPath).catch(() => null))?.repoId ?? null;
  repoIdCache.set(projectPath, { repoId, at: Date.now() });
  return repoId;
};
const projectRepoIds = async (projects) => {
  const ids = new Map();
  for (const project of Array.isArray(projects) ? projects : []) {
    if (typeof project?.path !== 'string') continue;
    ids.set(project.path, await repoIdForPath(project.path));
  }
  return ids;
};

// Host side: the branch a thread here works on, for a controller's prompt
// box. Its Durango workspace when it has one, else its project directory.
const remoteThreadGitState = async (threadId) => {
  // The shell is enough (project, workspace): read it from the index rather
  // than loading the whole transcript.
  const entry = threadId
    ? ((await readThreadsIndex().catch(() => null))?.entries ?? []).find((candidate) => candidate?.id === threadId)
    : null;
  const thread = entry?.shell ?? null;
  if (!thread) return { ok: false, error: 'Thread not found on this machine.' };
  const state = (await readPersistedStoreState().catch(() => null)) ?? {};
  const project = [...(state.noProject ? [state.noProject] : []), ...(Array.isArray(state.projects) ? state.projects : [])].find(
    (candidate) => candidate?.id === thread.projectId
  );
  const workingDir = thread.durangoWorkspace?.workingDir ?? thread.durangoWorkspace?.path ?? project?.path;
  if (!workingDir) return { ok: true, branch: null, detachedHead: null, workspaceName: null, dirty: false };
  try {
    const gitRoot = await getGitRoot(workingDir);
    const [branch, entries] = await Promise.all([getCurrentGitBranch(gitRoot), readGitStatusEntries(gitRoot)]);
    return {
      ok: true,
      branch,
      detachedHead: branch === null ? await getDetachedGitHead(gitRoot) : null,
      workspaceName: typeof thread.durangoWorkspace?.name === 'string' ? thread.durangoWorkspace.name : null,
      dirty: entries.length > 0,
    };
  } catch {
    // Not a git repository (No project, a plain folder).
    return { ok: true, branch: null, detachedHead: null, workspaceName: null, dirty: false };
  }
};

/**
 * A paired machine's threads for this machine's sidebar, each with the local
 * project it belongs to here: the same Durango Source repository, else a
 * project of the same name or folder (null = none; the renderer files it
 * under No project, labeled with that machine's project name).
 */
const listRemoteThreads = async ({ machineId } = {}) => {
  const snapshot = await fetchRemoteSnapshot({ machineId: String(machineId ?? '') });
  if (!snapshot.ok || !snapshot.snapshot) return { ok: false, error: snapshot.error ?? 'Could not reach that machine.' };
  const local = configuredProjects.filter((project) => typeof project?.id === 'string');
  const localRepoIds = await projectRepoIds(local);
  const localFor = (hostProject) => {
    if (!hostProject) return null;
    if (hostProject.id === REMOTE_NO_PROJECT_ID) return REMOTE_NO_PROJECT_ID;
    if (hostProject.repoId) {
      const byRepo = local.find((project) => localRepoIds.get(project.path) === hostProject.repoId);
      if (byRepo) return byRepo.id;
    }
    // Same name or folder, unless both are Source repositories and differ.
    const name = String(hostProject.name ?? '').toLowerCase();
    const folder = typeof hostProject.path === 'string' ? path.basename(hostProject.path) : '';
    return (
      local.find((project) => {
        const localRepoId = localRepoIds.get(project.path);
        if (hostProject.repoId && localRepoId && localRepoId !== hostProject.repoId) return false;
        return (
          String(project.name ?? '').toLowerCase() === name ||
          (folder && typeof project.path === 'string' && path.basename(project.path) === folder)
        );
      })?.id ?? null
    );
  };
  const hostProjects = new Map((snapshot.snapshot.projects ?? []).map((project) => [project.id, project]));
  const ownMachineId = getRemoteControlState()?.machineId ?? null;
  // A thread an agent here started there (machine_run_agent) shows under
  // that agent's thread, like its other subagents: the host says so (it
  // knows this machine as the device that asked), else this run remembers.
  const localParentOf = (thread) =>
    (ownMachineId && thread.spawnedBy?.machineId === ownMachineId ? thread.spawnedBy.threadId : null) ??
    remoteThreadSpawner(String(machineId ?? ''), thread.id);
  // Subagent threads come too (`parentThreadId` = their parent's id there):
  // the store lists them under their parent's mirror, like subagents here.
  return {
    ok: true,
    machine: snapshot.snapshot.machine,
    threads: (snapshot.snapshot.threads ?? [])
      .map((thread) => {
        const hostProject = hostProjects.get(thread.projectId);
        return {
          ...thread,
          localProjectId: localFor(hostProject),
          projectName: hostProject?.name ?? null,
          localParentThreadId: localParentOf(thread),
        };
      }),
  };
};

// Where a thread started here runs on a paired machine: its project's Durango
// Source repository there (cloned if that machine lacks it), else a project
// of the same name or folder, else nothing (the user adds it there first).
// "No project" threads use that machine's No project scratch.
const REMOTE_NO_PROJECT_ID = 'orion:no-project';
const resolveRemoteProject = async ({ machineId, project } = {}) => {
  const targetMachineId = String(machineId ?? '');
  if (!project || project.id === REMOTE_NO_PROJECT_ID) {
    return { ok: true, projectId: REMOTE_NO_PROJECT_ID, projectName: 'No project' };
  }
  const name = String(project.name ?? '').slice(0, 200);
  const localPath = typeof project.path === 'string' ? project.path : '';
  const snapshot = await fetchRemoteSnapshot({ machineId: targetMachineId });
  if (!snapshot.ok) return { ok: false, error: snapshot.error ?? 'Could not reach that machine.' };
  const hostProjects = (snapshot.snapshot?.projects ?? []).filter((candidate) => candidate.id !== REMOTE_NO_PROJECT_ID);
  const repoId = localPath ? await repoIdForPath(localPath) : null;
  // The same Durango Source repository, already there.
  const sameRepo = repoId ? hostProjects.find((candidate) => candidate.repoId === repoId) : null;
  if (sameRepo) return { ok: true, projectId: sameRepo.id, projectName: sameRepo.name };
  // Same name or folder, but never a different repository that happens to
  // share it (an "api" or "app").
  const folder = localPath ? path.basename(localPath) : '';
  const sameName = hostProjects.find(
    (candidate) =>
      !(repoId && candidate.repoId && candidate.repoId !== repoId) &&
      (candidate.name?.toLowerCase() === name.toLowerCase() ||
        (folder && typeof candidate.path === 'string' && path.basename(candidate.path) === folder))
  );
  if (repoId) {
    // Clone it there (an existing checkout the snapshot didn't link is reused).
    const checkout = await checkoutRemoteSource({ machineId: targetMachineId, repoId, name });
    if (checkout.ok && checkout.projectId) return { ok: true, projectId: checkout.projectId, projectName: name };
    if (!sameName) return { ok: false, error: checkout.error ?? `Could not set up ${name} on that machine.` };
  }
  if (sameName) return { ok: true, projectId: sameName.id, projectName: sameName.name };
  return {
    ok: false,
    error: `${name || 'This project'} is not on that machine. Add it there, or publish it to Durango Source so it can be cloned there.`,
  };
};

// Where an agent's machine_run_agent runs on another machine when it names no
// project: the agent's own project there (resolveRemoteProject), else that
// machine's No project.
const resolveCallerProjectOnMachine = async ({ machineId, projectPath }) => {
  const byPath = (projects) =>
    (Array.isArray(projects) ? projects : []).find((candidate) => candidate?.path === projectPath) ?? null;
  const project =
    typeof projectPath === 'string' && projectPath
      ? (byPath(configuredProjects) ?? byPath((await readPersistedStoreState().catch(() => null))?.projects))
      : null;
  return resolveRemoteProject({ machineId, project: project ?? null });
};

const afterRemoteControlInit =
  (handler) =>
  async (...args) => {
    await remoteControlReady;
    return handler(...args);
  };
// State reads never wait: before the engine has started they report
// `starting`, and the engine broadcasts 'remote:state' once it has.
ipcMain.handle('remote:getState', () => getRemoteControlState());
ipcMain.handle('remote:configure', afterRemoteControlInit((_event, value) => configureRemoteControl(value)));
ipcMain.handle('remote:startPairing', afterRemoteControlInit(() => startRemotePairing()));
ipcMain.handle('remote:cancelPairing', afterRemoteControlInit(() => cancelRemotePairing()));
ipcMain.handle('remote:revokeDevice', afterRemoteControlInit((_event, input) => revokeRemoteDevice(input)));
ipcMain.handle('remote:relayDeregister', afterRemoteControlInit(() => deregisterRelayMachine()));
ipcMain.handle('remote:pair', afterRemoteControlInit((_event, input) => pairWithRemoteHost(input)));
ipcMain.handle('remote:removeMachine', afterRemoteControlInit((_event, input) => removeRemoteMachine(input)));
ipcMain.handle('remote:connectMachine', afterRemoteControlInit((_event, input) => connectRemoteMachine(input)));
ipcMain.handle('remote:disconnectMachine', afterRemoteControlInit((_event, input) => disconnectRemoteMachine(input)));
ipcMain.handle('remote:fetchSnapshot', afterRemoteControlInit((_event, input) => fetchRemoteSnapshot(input)));
ipcMain.handle('remote:fetchThread', afterRemoteControlInit((_event, input) => fetchRemoteThread(input)));
ipcMain.handle('remote:runTurn', afterRemoteControlInit((_event, input) => runRemoteTurn(input)));
ipcMain.handle('remote:checkoutSource', afterRemoteControlInit((_event, input) => checkoutRemoteSource(input)));
ipcMain.handle('remote:stopTurn', afterRemoteControlInit((_event, input) => stopRemoteTurn(input)));
ipcMain.handle('remote:steerTurn', afterRemoteControlInit((_event, input) => steerRemoteTurn(input)));
ipcMain.handle('remote:resolveProject', afterRemoteControlInit((_event, input) => resolveRemoteProject(input)));
ipcMain.handle('remote:listThreads', afterRemoteControlInit((_event, input) => listRemoteThreads(input)));
ipcMain.handle('remote:fetchAttachment', afterRemoteControlInit((_event, input) => fetchRemoteAttachment(input)));
ipcMain.handle('remote:prepareUpload', afterRemoteControlInit((_event, input) => prepareRemoteAttachmentUpload(input)));
ipcMain.handle('remote:cancelUpload', afterRemoteControlInit((_event, input) => cancelRemoteAttachmentUpload(input)));
ipcMain.handle('remote:listUploads', afterRemoteControlInit(() => listRemoteAttachmentUploads()));
ipcMain.handle('remote:threadGit', afterRemoteControlInit((_event, input) => fetchRemoteThreadGit(input)));
ipcMain.handle('remote:listQuestions', afterRemoteControlInit((_event, input) => listRemoteQuestions(input)));
ipcMain.handle('remote:answerQuestion', afterRemoteControlInit((_event, input) => answerRemoteQuestion(input)));
ipcMain.handle('remote:userAction', afterRemoteControlInit((_event, input) => remoteUserAction(input)));
ipcMain.handle('remote:threadState', afterRemoteControlInit((_event, input) => setRemoteThreadState(input)));
ipcMain.handle('remote:followThreads', afterRemoteControlInit((_event, input) => followRemoteThreads(input)));
// Registered only after the renderer has installed onRemoteCommandRequest.
// A main-frame navigation, a crash or destruction clears this authority until the next mount.
ipcMain.handle('remote:rendererReady', (event) => markRemoteCommandRendererReady(event.sender));
ipcMain.handle('remote:claimCommand', (event, input) =>
  event.sender !== remoteCommandRenderer
    ? { ok: false }
    : isDispatchRendererCommand(input?.commandId)
      ? claimDispatchRendererCommand(input)
      : claimRemoteCommand(input)
);
// The host renderer reports a remote command's outcome here, unblocking the
// controller's pending request (mirrors orchestration:subagentResult).
ipcMain.handle('remote:commandResult', (event, payload) =>
  event.sender !== remoteCommandRenderer
    ? { ok: false }
    : isDispatchRendererCommand(payload?.commandId)
      ? resolveDispatchRendererCommand(payload)
      : resolveRemoteCommand(payload)
);

ipcMain.handle('storage:saveThreads', async (_event, value) => {
  // Same settled-queue chaining as storage:save above.
  const seq = ++threadsWriteSeq;
  const save = threadsSaveQueue.catch(() => {}).then(async () => {
    if (seq <= threadsCommittedSeq) return; // superseded by the sync flush
    await writeThreadsPatch(value);
    if (seq >= threadsCommittedSeq) {
      threadsCommittedSeq = seq;
      return;
    }
    // The quit-time sync flush committed a newer patch while our manifest
    // write was in flight and may have been superseded — reinstall it.
    const snapshot = threadsSyncSnapshot;
    if (snapshot && snapshot.seq > seq) {
      await writeThreadsPatch(snapshot.patch);
    }
  });
  threadsSaveQueue = save;

  try {
    await save;
    // A stored thread just changed — let the (opt-in) workspace sync
    // engine schedule a debounced pass. Inert while sync is disabled.
    notifyWorkspaceChanged();
    notifyRemoteWorkspaceChanged();
    return true;
  } catch (error) {
    console.error('storage:saveThreads error', error);
    return false;
  }
});

// Quit-time flush: an async save started from beforeunload would race app
// teardown (Electron can exit before the promise settles). The renderer
// blocks in sendSync until this returns, so the write is on disk before the
// window can be destroyed.
ipcMain.on('storage:saveThreadsSync', (event, value) => {
  try {
    const seq = ++threadsWriteSeq;
    writeThreadsPatchSync(value);
    threadsCommittedSeq = seq;
    // Retained so an in-flight async manifest commit can detect the
    // supersession and reinstall this patch.
    threadsSyncSnapshot = { seq, patch: value };
    event.returnValue = true;
  } catch (error) {
    console.error('storage:saveThreadsSync error', error);
    event.returnValue = false;
  }
});

// Quit-time store flush (see storage:saveThreadsSync): settings and unsent
// composer drafts changed within the save debounce would otherwise be lost.
ipcMain.on('storage:saveSync', (event, value) => {
  try {
    const seq = ++storageWriteSeq;
    const storagePath = getStorageFilePath();
    const sanitized = sanitizeStoreValue(value) ?? value;
    mkdirSync(path.dirname(storagePath), { recursive: true });
    const tempPath = `${storagePath}.${process.pid}.sync.tmp`;
    writeFileSync(tempPath, sanitized, 'utf-8');
    renameSync(tempPath, storagePath);
    storageCommittedSeq = seq;
    storageSyncSnapshot = { seq, value: sanitized };
    event.returnValue = true;
  } catch (error) {
    console.error('storage:saveSync error', error);
    event.returnValue = false;
  }
});

ipcMain.handle('storage:clear', async () => {
  // Clear participates in both save queues so an older pending write cannot
  // recreate either file after this handler reports success. Threads also
  // take a sequence number because the unload-time synchronous flush can
  // jump the async queue.
  const threadsSeq = ++threadsWriteSeq;
  const storageSeq = ++storageWriteSeq;
  const clearStorage = storageSaveQueue.catch(() => {}).then(async () => {
    if (storageSeq <= storageCommittedSeq) return;
    await fs.rm(getStorageFilePath(), { force: true });
    storageCommittedSeq = Math.max(storageCommittedSeq, storageSeq);
    if (storageSyncSnapshot && storageSyncSnapshot.seq < storageSeq) storageSyncSnapshot = null;
  });
  storageSaveQueue = clearStorage;

  const clearThreads = threadsSaveQueue.catch(() => {}).then(async () => {
    if (threadsSeq <= threadsCommittedSeq) return;
    await clearThreadsStorage();
    if (threadsSeq < threadsCommittedSeq) {
      // A newer synchronous unload flush raced the removal. Reinstall its
      // snapshot in case the rm landed after that flush's rename.
      const snapshot = threadsSyncSnapshot;
      if (snapshot && snapshot.seq > threadsSeq) {
        await writeThreadsPatch(snapshot.patch);
      }
      return;
    }
    threadsCommittedSeq = threadsSeq;
    threadsSyncSnapshot = null;
  });
  threadsSaveQueue = clearThreads;

  try {
    await Promise.all([clearStorage, clearThreads]);
    return true;
  } catch (error) {
    console.error('storage:clear error', error);
    return false;
  }
});

// Open directory picker
ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Open Project Folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// The project picker's "Add project" view browses folders from its search field.
ipcMain.handle('fs:browseDirectories', (_event, requestedPath) => browseDirectories(requestedPath));
ipcMain.handle('fs:resolveProjectDirectory', (_event, inputPath, options) =>
  resolveProjectDirectory(inputPath, { create: options?.create === true })
);

// Agents started without a project run in an Orion-owned scratch directory.
ipcMain.handle('app:getNoProjectDir', async () => {
  const dir = getNoProjectDirectoryPath();
  await fs.mkdir(dir, { recursive: true });
  return dir;
});

// Read directory (returns files + dirs info for tree)
ipcMain.handle('fs:readDirectory', async (_event, dirPath) => {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const { directStatuses, aggregateStatuses } = await getGitStatusMap(dirPath);
    const items = entries
      .filter((entry) => !(entry.isDirectory() && hiddenSystemDirectories.has(entry.name)))
      .map((entry) => {
        const fullPath = path.join(dirPath, entry.name);
        const directStatus = directStatuses.get(fullPath);
        const aggregateStatus = aggregateStatuses.get(fullPath);
        const status = directStatus ?? aggregateStatus ?? null;

        return {
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
          gitStatus: status?.kind ?? null,
          gitStatusLabel: status?.label ?? null,
          hasChildGitStatus: !directStatus && Boolean(aggregateStatus),
        };
      });
    // Sort: folders first then files, alpha
    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return items;
  } catch (err) {
    console.error('readDirectory error', err);
    return [];
  }
});

// Read file content
ipcMain.handle('fs:readFile', async (_event, filePath) => {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (e) {
    console.error('readFile error', e);
    return '';
  }
});

// Watcher refreshes must distinguish a genuinely empty file from a failed
// read. Keep the legacy readFile contract for existing callers, and expose a
// result-bearing variant for external-change reconciliation.
ipcMain.handle('fs:readFileResult', async (_event, filePath) => {
  try {
    return { ok: true, content: await fs.readFile(filePath, 'utf-8') };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
});

// Poll the small set of open files rather than an entire workspace.
// fs.watchFile survives the atomic-save replacements used by editors and
// agents, where a watcher attached to the old inode can silently go stale.
const openFileWatchersByRenderer = new Map();

const disposeOpenFileWatchers = (webContentsId) => {
  const record = openFileWatchersByRenderer.get(webContentsId);
  if (!record) return;
  for (const [filePath, listener] of record.listeners) {
    unwatchFile(filePath, listener);
  }
  record.webContents.removeListener('did-start-navigation', record.disposeOnNavigation);
  record.webContents.removeListener('render-process-gone', record.dispose);
  record.webContents.removeListener('destroyed', record.dispose);
  openFileWatchersByRenderer.delete(webContentsId);
};

ipcMain.handle('fs:setWatchedFiles', (event, requestedPaths) => {
  const webContents = event.sender;
  if (!webContents || webContents.isDestroyed()) return false;

  let record = openFileWatchersByRenderer.get(webContents.id);
  if (!record) {
    const dispose = () => disposeOpenFileWatchers(webContents.id);
    const disposeOnNavigation = (_event, _url, isInPlace, isMainFrame) => {
      // PDF previews load in a child frame and must not tear down the
      // renderer's open-file watchers. Only a real top-level document change
      // invalidates the renderer subscription.
      if (isMainFrame && !isInPlace) dispose();
    };
    record = { webContents, listeners: new Map(), dispose, disposeOnNavigation };
    openFileWatchersByRenderer.set(webContents.id, record);
    webContents.on('did-start-navigation', disposeOnNavigation);
    webContents.once('render-process-gone', dispose);
    webContents.once('destroyed', dispose);
  }

  const nextPaths = new Set(
    (Array.isArray(requestedPaths) ? requestedPaths : [])
      .filter((filePath) => typeof filePath === 'string' && filePath.length > 0)
      .slice(0, 250)
      .map((filePath) => path.resolve(filePath))
  );

  for (const [filePath, listener] of record.listeners) {
    if (nextPaths.has(filePath)) continue;
    unwatchFile(filePath, listener);
    record.listeners.delete(filePath);
  }

  for (const filePath of nextPaths) {
    if (record.listeners.has(filePath)) continue;
    const listener = (current, previous) => {
      const exists = current.nlink > 0;
      if (
        exists === (previous.nlink > 0) &&
        current.mtimeMs === previous.mtimeMs &&
        current.size === previous.size &&
        current.ino === previous.ino
      ) {
        return;
      }
      if (webContents.isDestroyed()) return;
      webContents.send('fs:fileChanged', {
        path: filePath,
        exists,
        mtimeMs: exists ? current.mtimeMs : null,
      });
    };
    record.listeners.set(filePath, listener);
    watchFile(filePath, { persistent: false, interval: 350 }, listener);
  }

  return true;
});

ipcMain.handle('fs:openLinkedFile', async (_event, input) => {
  const candidates = linkedFileCandidates(
    input?.href,
    Array.isArray(input?.baseDirs) ? input.baseDirs.slice(0, 16) : [],
    os.homedir()
  );
  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (!stats.isFile()) continue;
      return {
        ok: true,
        path: candidate,
        content: isPreviewFilePath(candidate)
          ? ''
          : await fs.readFile(candidate, 'utf-8'),
      };
    } catch {
      // Try the next base directory or the path with its source location removed.
    }
  }
  return { ok: false, error: 'The linked file could not be found.' };
});

// Write file content
ipcMain.handle('fs:writeFile', async (_event, filePath, content) => {
  try {
    await fs.writeFile(filePath, content, 'utf-8');
    invalidateTreeGitStatusCache();
    return true;
  } catch (e) {
    console.error('writeFile error', e);
    return false;
  }
});

// Create new file
ipcMain.handle('fs:createFile', async (_event, filePath, content = '') => {
  try {
    await fs.writeFile(filePath, content, 'utf-8');
    invalidateTreeGitStatusCache();
    return true;
  } catch (e) {
    console.error('createFile error', e);
    return false;
  }
});

// Create directory
ipcMain.handle('fs:createDirectory', async (_event, dirPath) => {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    invalidateTreeGitStatusCache();
    return true;
  } catch (e) {
    console.error('createDirectory error', e);
    return false;
  }
});

// Delete file or dir
ipcMain.handle('fs:deletePath', async (_event, targetPath) => {
  try {
    await fs.rm(targetPath, { recursive: true, force: true });
    invalidateTreeGitStatusCache();
    return true;
  } catch (e) {
    console.error('deletePath error', e);
    return false;
  }
});

// Rename/move file or dir
ipcMain.handle('fs:renamePath', async (_event, oldPath, newPath) => {
  try {
    try {
      await fs.access(newPath);
      return { ok: false, error: 'A file or folder with that name already exists.' };
    } catch {}
    await fs.rename(oldPath, newPath);
    invalidateTreeGitStatusCache();
    return { ok: true };
  } catch (e) {
    console.error('renamePath error', e);
    return { ok: false, error: e?.message ?? String(e) };
  }
});

const openPathInTerminal = async (targetPath) => {
  let dir = targetPath;
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isDirectory()) dir = path.dirname(targetPath);
  } catch {
    dir = path.dirname(targetPath);
  }

  if (process.platform === 'darwin') {
    await execFileAsync('open', ['-a', 'Terminal', dir]);
  } else if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', 'cmd.exe'], { cwd: dir, detached: true, shell: false });
  } else {
    spawn('x-terminal-emulator', [], { cwd: dir, detached: true });
  }
};

// Native context menu for the Code file tree. Resolves with the action the
// renderer must perform (rename/delete/new-file/new-folder) or null when the
// action was fully handled here (reveal, terminal, copy path) or dismissed.
ipcMain.handle('fileTree:showContextMenu', async (event, input) => {
  const { path: targetPath, isDirectory, rootPath } = input ?? {};
  if (!targetPath) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;

  const revealLabel =
    process.platform === 'darwin'
      ? 'Reveal in Finder'
      : process.platform === 'win32'
        ? 'Reveal in File Explorer'
        : 'Reveal in File Manager';

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const template = [];
    if (isDirectory) {
      template.push(
        { label: 'New File…', click: () => finish('new-file') },
        { label: 'New Folder…', click: () => finish('new-folder') },
        { type: 'separator' }
      );
    }
    template.push(
      { label: 'Rename…', click: () => finish('rename') },
      { label: 'Delete', click: () => finish('delete') },
      { type: 'separator' },
      {
        label: revealLabel,
        click: () => {
          shell.showItemInFolder(targetPath);
          finish(null);
        },
      },
      {
        label: 'Open in Terminal',
        click: () => {
          openPathInTerminal(targetPath).catch((error) =>
            console.error('openInTerminal error', error)
          );
          finish(null);
        },
      },
      { type: 'separator' },
      {
        label: 'Copy Path',
        click: () => {
          clipboard.writeText(targetPath);
          finish(null);
        },
      }
    );
    if (rootPath) {
      template.push({
        label: 'Copy Relative Path',
        click: () => {
          clipboard.writeText(path.relative(rootPath, targetPath));
          finish(null);
        },
      });
    }

    const menu = Menu.buildFromTemplate(template);
    // The close callback fires before item click handlers, so defer the
    // "dismissed" resolution one tick to let a click win the race.
    menu.popup({ window: win, callback: () => setTimeout(() => finish(null), 0) });
  });
});

// Native confirmation dialog before deleting a tree entry.
ipcMain.handle('fileTree:confirmDelete', async (event, input) => {
  const { path: targetPath, isDirectory } = input ?? {};
  if (!targetPath) return false;
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = {
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: `Delete “${path.basename(targetPath)}”?`,
    detail: isDirectory
      ? 'The folder and all of its contents will be deleted. This cannot be undone.'
      : 'This cannot be undone.',
  };
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return response === 0;
});

ipcMain.handle('git:getState', async (_event, projectPath) => {
  try {
    if (!projectPath) {
      return { ok: false, branches: [], hasUncommittedChanges: false, error: 'Missing project path.' };
    }

    return await getGitStateForPath(projectPath);
  } catch (error) {
    const detail = error?.stderr?.toString().trim() || error?.message || String(error);
    const isPlainProject = /not a git repository/i.test(detail);
    return {
      ok: false,
      isGitRepository: false,
      sourceProvider: isPlainProject ? 'none' : 'other',
      originUrl: null,
      branches: [],
      hasUncommittedChanges: false,
      error: isPlainProject ? 'This project is ready to publish to Durango Cloud.' : detail,
    };
  }
});

ipcMain.handle('git:checkoutBranch', async (_event, input) => {
  try {
    const projectPath = input?.projectPath;
    const branchName = String(input?.branchName ?? '').trim();
    const create = Boolean(input?.create);
    if (!projectPath || !branchName) {
      return { ok: false, error: 'Missing project path or branch name.' };
    }

    const gitRoot = await getGitRoot(projectPath);
    if (create) {
      const valid = await validateNewBranchName(branchName);
      if (!valid) {
        return { ok: false, error: 'Invalid branch name.' };
      }
      await execFileAsync('git', ['-C', gitRoot, 'checkout', '-b', branchName]);
    } else {
      const state = await getGitStateForPath(projectPath);
      if (state.hasUncommittedChanges) {
        return { ok: false, error: 'Commit or discard local changes before switching branches.' };
      }
      if (!state.branches.some((branch) => branch.name === branchName)) {
        return { ok: false, error: `Unknown branch: ${branchName}` };
      }
      await execFileAsync('git', ['-C', gitRoot, 'checkout', branchName]);
    }

    return { ok: true, state: await getGitStateForPath(projectPath) };
  } catch (error) {
    return { ok: false, error: error?.stderr?.toString().trim() || error?.message || String(error) };
  }
});

const pushBranchToSourceControl = async (gitRoot, branch, { signal } = {}) => {
  const state = await getGitStateForPath(gitRoot);
  if (state.sourceProvider === 'orion') {
    const session = await readRepositorySession();
    if (!session?.token) {
      const error = new Error('Sign in to your Durango account before pushing.');
      error.needsAuth = true;
      throw error;
    }
    return await pushOrionSourceControl({ gitRoot, branch, token: session.token, signal });
  }
  const pushed = await execFileAsync('git', ['-C', gitRoot, 'push', '-u', 'origin', branch], { signal });
  return {
    ok: true,
    branch,
    pushedToOrion: false,
    mirrorWarning: null,
    alreadyUpToDate: gitPushWasAlreadyUpToDate(pushed),
  };
};

// The navbar action passes `{ projectPath, modelId, reasoningEffort }`; older
// callers passed the path alone and keep the diffstat-style fallback message.
ipcMain.handle('git:commitAndPush', async (_event, input) => {
  let committed = false;
  let pushAttempted = false;
  try {
    const request = typeof input === 'string' ? { projectPath: input } : (input ?? {});
    const { projectPath } = request;
    if (!projectPath) {
      return { ok: false, error: 'Missing project path.' };
    }

    const gitRoot = await getGitRoot(projectPath);
    const state = await getGitStateForPath(projectPath);
    if (!state.currentBranch) {
      return { ok: false, error: 'Cannot push from a detached HEAD.' };
    }

    const entries = await readGitStatusEntries(gitRoot);
    if (entries.length === 0) {
      // A previous click may have committed successfully before its push was
      // rejected. A clean worktree must still retry that push; a true no-op is
      // reported as already up to date instead of as a commit failure.
      pushAttempted = true;
      const pushed = await pushBranchToSourceControl(gitRoot, state.currentBranch);
      return {
        ok: true,
        branch: state.currentBranch,
        committed: false,
        pushed: true,
        alreadyUpToDate: Boolean(pushed.alreadyUpToDate),
        ...(pushed.mirrorWarning ? { mirrorWarning: pushed.mirrorWarning } : {}),
        state: await getGitStateForPath(projectPath),
      };
    }

    await execFileAsync('git', ['-C', gitRoot, 'add', '-A']);
    const stagedHasChanges = !(await commandSucceeds('git', ['-C', gitRoot, 'diff', '--cached', '--quiet']));
    if (!stagedHasChanges) {
      return { ok: false, error: 'No staged changes to commit.' };
    }

    // Freeze the index across the message turn: staging keeps moving while the model writes, and committing after
    // that would ship changes the message never described.
    const indexTree = await readGitIndexTree(gitRoot);
    const stagedEntries = await readStagedGitEntries(gitRoot);
    const message = await writeGitCommitMessage({
      gitRoot,
      entries: stagedEntries,
      modelId: request.modelId,
      reasoningEffort: request.reasoningEffort,
    });
    if ((await readGitIndexTree(gitRoot)) !== indexTree) {
      return {
        ok: false,
        error: 'Staged changes changed while Durango Code was preparing the commit. Try again.',
      };
    }
    if ((await getCurrentGitBranch(gitRoot)) !== state.currentBranch) {
      return {
        ok: false,
        error: `The repository moved off ${state.currentBranch} while Durango Code was preparing the commit. Try again.`,
      };
    }

    await execFileAsync('git', ['-C', gitRoot, 'commit', '-m', message]);
    committed = true;
    pushAttempted = true;
    const pushed = await pushBranchToSourceControl(gitRoot, state.currentBranch);

    return {
      ok: true,
      branch: state.currentBranch,
      message,
      committed: true,
      pushed: true,
      alreadyUpToDate: Boolean(pushed.alreadyUpToDate),
      ...(pushed.mirrorWarning ? { mirrorWarning: pushed.mirrorWarning } : {}),
      state: await getGitStateForPath(projectPath),
    };
  } catch (error) {
    if (pushAttempted) {
      return { ok: false, committed, ...describeGitPushFailure(error, { committed }) };
    }
    return { ok: false, error: error?.stderr?.toString().trim() || error?.message || String(error) };
  }
});

// --- Git commit messages written by the text-generation model ------------

const truncateForPrompt = (text, limit) =>
  text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text;

// Models answer with fences/labels no matter how firmly the prompt forbids
// them; strip the common wrappers so the raw message survives.
const cleanGeneratedGitMessage = (text) => {
  let candidate = (text || '').trim();
  candidate = candidate.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '');
  candidate = candidate.replace(/^(commit message|pr description|title)\s*[:：]\s*/i, '');
  return candidate.trim();
};

// Describe only the index snapshot that will be committed. Edits made while
// the model writes the message remain in the worktree for a later commit.
// The prompt only ever sees the first ~14k chars, so the diff read is bounded
// well below the full index and an oversized diff degrades to the diffstat
// (and then to the file list alone) instead of failing the commit.
const readStagedGitChangesContext = async (gitRoot, entries) => {
  const fileList = entries
    .map((entry) => `${entry.kind}\t${entry.relativePath}`)
    .join('\n');

  let diff = '';
  try {
    ({ stdout: diff } = await execFileAsync('git', ['-C', gitRoot, 'diff', '--cached'], {
      maxBuffer: 1024 * 1024 * 4,
    }));
  } catch {
    try {
      ({ stdout: diff } = await execFileAsync(
        'git',
        ['-C', gitRoot, 'diff', '--cached', '--stat'],
        { maxBuffer: 1024 * 1024 }
      ));
    } catch {
      diff = '';
    }
  }

  return `Staged files:\n${fileList}\nDiff:\n${truncateForPrompt(diff, 14000)}`;
};

const readStagedGitEntries = async (gitRoot) => {
  const { stdout } = await execFileAsync('git', [
    '-C',
    gitRoot,
    'diff',
    '--cached',
    '--name-status',
    '-z',
  ]);
  const fields = stdout.split('\0');
  const entries = [];
  let index = 0;

  while (index < fields.length) {
    const rawStatus = fields[index++];
    if (!rawStatus) break;
    const status = rawStatus[0];
    const sourcePath = fields[index++];
    const relativePath =
      status === 'R' || status === 'C' ? fields[index++] : sourcePath;
    if (!relativePath) continue;
    const kind = {
      A: 'added',
      C: 'copied',
      D: 'deleted',
      M: 'modified',
      R: 'renamed',
      U: 'conflicted',
    }[status] ?? 'modified';
    entries.push({ kind, relativePath });
  }

  return entries;
};

const readGitIndexTree = async (gitRoot) => {
  const { stdout } = await execFileAsync('git', ['-C', gitRoot, 'write-tree']);
  return stdout.trim();
};

// Ask the text-generation model for a commit message describing the staged
// entries. Without a model — or when the turn comes back empty because the
// model is unavailable or errored — this degrades to the mechanical
// "Update N files" summary rather than blocking the commit.
const writeGitCommitMessage = async ({ gitRoot, entries, modelId, reasoningEffort, signal }) => {
  if (modelId) {
    const context = await readStagedGitChangesContext(gitRoot, entries);
    const prompt =
      'Write a git commit message for the changes below. First line: a specific summary under 72 characters. Then a blank line, then a short ' +
      'body of bullet points covering the substantive changes. Reply with ONLY the commit ' +
      'message — no quotes, no code fences, no commentary.\n\n' +
      context;
    const generated = cleanGeneratedGitMessage(
      await runOneShotForModelId(modelId, prompt, gitRoot, { reasoningEffort, signal })
    );
    if (generated) return generated;
  }
  return commitMessageForEntries(entries);
};

// --- Bundled durango-code CLI and Durango workspaces -----------------------------

// Launchers for the CLI bundled with the app (src/main/bundled-cli.js), on PATH
// for agents and the embedded terminal. Appended, so a globally installed CLI
// still wins. On Linux /usr/bin/durango-code (the app itself) comes first; it
// runs this same bundled CLI (src/main/run-cli-from-argv.js). The shell PATH
// sync merges the user's shell PATH in front of whatever process.env.PATH
// holds, which keeps this directory last either way.
let bundledCliBinDirPromise = null;
const installBundledCli = () => {
  bundledCliBinDirPromise ??= installBundledCliShims()
    .then((binDir) => {
      if (binDir) {
        const entries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
        if (!entries.includes(binDir)) process.env.PATH = [...entries, binDir].join(path.delimiter);
      }
      return binDir;
    })
    .catch((error) => {
      console.error('Could not install the bundled durango-code CLI', error);
      return null;
    });
  return bundledCliBinDirPromise;
};

// `git pull` / `git push` to Durango Source from any terminal answer with the
// CLI's sign-in (src/main/git-credential-helper.js), so the CLI is signed in
// along with the app rather than on first use. Packaged builds only: a dev
// build's Electron lives in a checkout that can disappear.
const installDurangoGitCredentials = async () => {
  if (!app.isPackaged) return;
  await installGitCredentialHelper({ binDir: bundledCliBinDir() }).catch((error) =>
    console.error('Could not register the Durango Source git credential helper', error)
  );
  await signInBundledCli();
};

const signInBundledCli = () =>
  ensureCliSignedIn({ readSession: () => readAccountSession(), origin: getDurangoWebUrl().toString() }).catch((error) => ({
    ok: false,
    signedIn: false,
    error: error?.message || String(error),
  }));

const isPathInput = (value) => typeof value === 'string' && value.length > 0 && value.length < 4096 && path.isAbsolute(value);
const isWorkspaceNameInput = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(value);

ipcMain.handle('durangoCli:status', async () => {
  const binDir = await installBundledCli();
  const credential = await readCliCredential().catch(() => null);
  return {
    available: Boolean(bundledCliEntry()),
    version: bundledCliVersion(),
    binDir,
    signedIn: Boolean(credential),
    credentialSource: credential?.source ?? null,
    user: credential?.user ?? null,
  };
});

ipcMain.handle('durangoCli:signIn', () => signInBundledCli());

ipcMain.handle('durangoWorkspace:inspect', async (_event, input) => {
  if (!isPathInput(input?.projectPath)) return { ok: false, eligible: false, error: 'Missing project path.' };
  try {
    return await inspectDurangoWorkspaceProject(input.projectPath);
  } catch (error) {
    return { ok: false, eligible: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('durangoWorkspace:find', async (_event, input) => {
  if (!isPathInput(input?.projectPath) || !isWorkspaceNameInput(input?.name)) {
    return { ok: false, error: 'Missing project path or workspace name.' };
  }
  try {
    return await findDurangoWorkspace({ projectPath: input.projectPath, name: input.name });
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('durangoWorkspace:create', async (_event, input) => {
  if (!isPathInput(input?.projectPath) || !isWorkspaceNameInput(input?.name)) {
    return { ok: false, error: 'Missing project path or workspace name.' };
  }
  try {
    await installBundledCli();
    // `ws new` starts from main on Durango Source, and the agent will open its
    // change from here, so make sure the CLI is signed in first (best effort).
    const cliSignIn = await signInBundledCli();
    const result = await createDurangoWorkspace({
      projectPath: input.projectPath,
      name: input.name,
      threadId: typeof input.threadId === 'string' ? input.threadId : undefined,
    });
    return { ...result, cliSignedIn: cliSignIn.signedIn === true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('durangoWorkspace:remove', async (_event, input) => {
  if (!isWorkspaceNameInput(input?.name) || (input?.repo !== undefined && !isPathInput(input.repo))) {
    return { ok: false, error: 'Missing workspace name.' };
  }
  try {
    if (isPathInput(input?.path)) {
      await stopDurangoWorkspaceServer({ path: input.path, name: input.name, repo: input.repo });
    }
    return await removeDurangoWorkspace({ name: input.name, repo: input.repo, force: input.force === true });
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('durangoWorkspace:status', async (_event, input) => {
  if (!isPathInput(input?.path)) return { ok: false, error: 'Missing workspace path.' };
  try {
    return await durangoWorkspaceStatus({
      path: input.path,
      name: typeof input.name === 'string' ? input.name : undefined,
      repo: typeof input.repo === 'string' ? input.repo : undefined,
      remote: input.remote === true,
    });
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('durangoWorkspace:prune', async (_event, input) => {
  const paths = (value) => (Array.isArray(value) ? value.filter(isPathInput).slice(0, 500) : []);
  try {
    await installBundledCli();
    return await pruneDurangoWorkspaces({
      keep: paths(input?.keep),
      only: paths(input?.only),
      dryRun: input?.dryRun === true,
      idleDays: typeof input?.idleDays === 'number' ? input.idleDays : undefined,
    });
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('durangoWorkspace:missing', (_event, input) => {
  const paths = Array.isArray(input?.paths) ? input.paths.filter(isPathInput).slice(0, 500) : [];
  return missingDurangoWorkspaces(paths);
});

ipcMain.handle('durangoWorkspace:land', async (_event, input) => {
  if (!isPathInput(input?.path)) return { ok: false, error: 'Missing workspace path.' };
  const cliSignIn = await signInBundledCli();
  if (!cliSignIn.signedIn) return { ok: false, error: cliSignIn.error ?? 'Sign in to Durango Code first.' };
  return landDurangoWorkspace({ path: input.path });
});

ipcMain.handle('durangoWorkspace:serve', async (_event, input) => {
  if (!isPathInput(input?.path) || !isWorkspaceNameInput(input?.name)) {
    return { ok: false, error: 'Missing workspace path or name.' };
  }
  await installBundledCli();
  return serveDurangoWorkspace({
    path: input.path,
    name: input.name,
    repo: isPathInput(input.repo) ? input.repo : undefined,
    onExit: ({ code, error }) =>
      sendToAllWindows('durangoWorkspace:serverExited', { path: input.path, code, error }),
  });
});

ipcMain.handle('durangoWorkspace:stopServer', async (_event, input) => {
  if (!isPathInput(input?.path) || !isWorkspaceNameInput(input?.name)) {
    return { ok: false, error: 'Missing workspace path or name.' };
  }
  return stopDurangoWorkspaceServer({
    path: input.path,
    name: input.name,
    repo: isPathInput(input.repo) ? input.repo : undefined,
  });
});

// --- Orion Cloud repositories -------------------------------------------------

const cloudErrorMessage = (error) => {
  if (error?.status === 401) return 'Durango Cloud repository access was revoked or expired. Sign in again to authorize this device.';
  if (error?.status === 403) return error?.data?.error || 'Your Durango Cloud token does not have permission for this operation. Check Settings > Access tokens.';
  if (error?.status === 404) {
    // A real "repo not found" comes back as JSON from the git API; a bare 404
    // (HTML page) means this Durango deployment doesn't have the API at all.
    return error?.data?.error
      ? 'Cloud repository not found. It may have been deleted.'
      : `Durango Cloud at ${getDurangoWebUrl().host} does not support repositories yet. Deploy the latest Durango, or point DURANGO_URL at a server that has it.`;
  }
  if (error?.message?.includes('fetch failed')) return 'Could not reach Durango Cloud.';
  return error?.stderr?.toString().trim() || error?.message || String(error);
};

const cloudGitApiRequest = async (apiPath, { method = 'GET', body, signal } = {}) => {
  const session = await readRepositorySession();
  if (!session?.token) {
    const error = new Error('Sign in to your Durango account first.');
    error.needsAuth = true;
    throw error;
  }
  const response = await fetch(new URL(apiPath, getDurangoWebUrl()), {
    method,
    signal,
    headers: {
      authorization: `Bearer ${session.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data = {};
  try {
    data = await response.json();
  } catch {}
  if (!response.ok) {
    const error = new Error(data?.error || `Durango Cloud request failed (${response.status}).`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
};

const expectedOrionGitRemote = (gitHttpUrl, repoId) =>
  `${String(gitHttpUrl ?? '').replace(/\/+$/, '')}/r/${encodeURIComponent(repoId)}.git`;

// Local git config is mutable and can arrive with an untrusted repository.
// Resolve the authoritative endpoint through Orion Cloud and compare the
// complete remote before placing the session token in Git's environment.
const verifyOrionGitRemote = async ({ gitRoot, token, signal }) => {
  const link = await getCloudRepoLink(gitRoot);
  if (!link?.repoId) throw new Error('This repository is not linked to Durango Cloud.');
  const [{ stdout }, { stdout: pushUrls }, connection] = await Promise.all([
    execFileAsync('git', ['-C', gitRoot, 'remote', 'get-url', 'origin']),
    execFileAsync('git', ['-C', gitRoot, 'remote', 'get-url', '--push', '--all', 'origin']),
    getCloudGitConnection({ baseUrl: getDurangoWebUrl(), token, signal }),
  ]);
  const actual = stdout.trim().replace(/\/+$/, '');
  const expected = expectedOrionGitRemote(connection?.gitHttpUrl, link.repoId);
  // Git permits separate (and multiple) push destinations, including URL
  // rewrites. Validate the effective destinations before supplying a token.
  const pushDestinations = pushUrls.trim().split('\n').map((url) => url.trim().replace(/\/+$/, ''));
  // Existing clones may point at a legacy alias of the advertised git host
  // (git.orioncode.xyz vs git.durango.sh); both are the same service.
  if (!connection?.gitHttpUrl || !isEquivalentOrionGitRemote(actual, expected) || !isOrionRepoRemoteUrl(actual, link.repoId)
    || pushDestinations.length !== 1 || !isEquivalentOrionGitRemote(pushDestinations[0], expected)) {
    throw new Error(
      'The origin remote does not match this repository’s authenticated Durango Cloud endpoint.'
    );
  }
  return expected;
};

const runVerifiedOrionGit = async ({ gitRoot, token, args, signal, timeout, maxBuffer }) => {
  await verifyOrionGitRemote({ gitRoot, token, signal });
  return await runAuthenticatedGit({ gitRoot, token, args, signal, timeout, maxBuffer });
};

const readPersistedGithubMirrorDelivery = async (gitRoot) => {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', gitRoot, 'config', '--local', '--get', 'orion.githubMirrorDelivery',
    ]);
    return ['cloud', 'desktop'].includes(stdout.trim()) ? stdout.trim() : null;
  } catch {
    return null;
  }
};

const persistGithubMirrorDelivery = async (gitRoot, mirror) => {
  const delivery = shouldMirrorGithubLocally(mirror) ? 'desktop' : 'cloud';
  await execFileAsync('git', [
    '-C', gitRoot, 'config', '--local', 'orion.githubMirrorDelivery', delivery,
  ]);
  return delivery;
};

const mirrorFromCloudResponse = (data) =>
  data?.mirror ?? data?.githubMirror ?? (data?.delivery && data?.status ? data : null);

// Orion Cloud owns the downstream GitHub push once its mirror is active. A
// missing/legacy endpoint and an installation that still needs authorization
// deliberately preserve Desktop's existing best-effort mirror.
const resolveGithubMirrorDelivery = async (gitRoot, { signal } = {}) => {
  const link = await getCloudRepoLink(gitRoot);
  if (!link?.repoId) return { mirrorGithub: true, mirror: null };
  const persistedDelivery = await readPersistedGithubMirrorDelivery(gitRoot);
  try {
    const data = await cloudGitApiRequest(
      `/api/git/repos/${encodeURIComponent(link.repoId)}/github-mirror`,
      { signal }
    );
    const mirror = mirrorFromCloudResponse(data);
    const delivery = await persistGithubMirrorDelivery(gitRoot, mirror);
    return { mirrorGithub: delivery === 'desktop', mirror };
  } catch (error) {
    const legacyFallback = error?.status === 404 && persistedDelivery !== 'cloud';
    if (!legacyFallback) {
      console.warn('Could not resolve Orion Cloud GitHub mirror delivery; skipping Desktop mirror:', error);
    }
    return { mirrorGithub: legacyFallback, mirror: null };
  }
};

const pushOrionSourceControl = async ({ gitRoot, branch, token, signal }) => {
  // Background workspace sync also reaches this path with an account token.
  // Resolve repository credentials here so every caller uses durable access.
  token = (await readRepositorySession()).token;
  await verifyOrionGitRemote({ gitRoot, token, signal });
  const delivery = await resolveGithubMirrorDelivery(gitRoot, { signal });
  const pushed = await pushSourceControl({
    gitRoot,
    branch,
    token,
    signal,
    mirrorGithub: delivery.mirrorGithub,
  });
  return { ...pushed, mirror: delivery.mirror };
};

const sanitizeCloudRepoName = (value) =>
  String(value ?? '')
    .trim()
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 100);

const cloudRepoWebUrl = (repoId) => new URL(`/repos/${repoId}`, getDurangoWebUrl()).toString();

const ensureInitialSourceControlCommit = async (gitRoot, session) => {
  const hasHead = await commandSucceeds('git', ['-C', gitRoot, 'rev-parse', '--verify', 'HEAD']);
  if (hasHead) return false;

  await ensureBaselineGitignore(gitRoot);
  const readConfig = async (key) => {
    try {
      const { stdout } = await execFileAsync('git', ['-C', gitRoot, 'config', '--get', key]);
      return stdout.trim();
    } catch {
      return '';
    }
  };
  if (!(await readConfig('user.name'))) {
    await execFileAsync('git', [
      '-C',
      gitRoot,
      'config',
      '--local',
      'user.name',
      String(session?.user?.name || 'Durango Code User'),
    ]);
  }
  if (!(await readConfig('user.email'))) {
    await execFileAsync('git', [
      '-C',
      gitRoot,
      'config',
      '--local',
      'user.email',
      String(session?.user?.email || 'orion@users.noreply.orioncode.xyz'),
    ]);
  }
  await execFileAsync('git', ['-C', gitRoot, 'add', '-A']);
  await execFileAsync('git', ['-C', gitRoot, 'commit', '-m', 'Initial commit']);
  return true;
};

const clearGithubImportTagRefs = async (gitRoot) => {
  let refs = [];
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      gitRoot,
      'for-each-ref',
      '--format=%(refname)',
      'refs/orion-import/github-tags',
    ]);
    refs = stdout.split('\n').map((ref) => ref.trim()).filter(Boolean);
  } catch {
    return;
  }
  await Promise.allSettled(
    refs.map((ref) => execFileAsync('git', ['-C', gitRoot, 'update-ref', '-d', ref]))
  );
};

const readLocalNamedRefs = async (gitRoot, namespace, name) => {
  const { stdout } = await execFileAsync('git', [
    '-C', gitRoot, 'for-each-ref', '--format=%(refname)\t%(objectname)', namespace,
  ]);
  return parseNamedGitRefs({ stdout, namespace, field: name });
};

const createAvailableEmptyCloudRepo = async ({ gitRoot, name, defaultBranch, token }) => {
  const previousLink = await getCloudRepoLink(gitRoot);
  if (previousLink?.repoId) {
    const existing = await cloudGitApiRequest(
      `/api/git/repos/${encodeURIComponent(previousLink.repoId)}`
    );
    if (canReuseLinkedCloudRepo({ repo: existing?.repo, expectedName: name })) {
      return { repo: existing.repo, previousLink, created: false };
    }
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? name : `${name}-orion${attempt === 1 ? '' : `-${attempt}`}`;
    try {
      const repo = await createCloudRepo({
        gitRoot,
        name: candidate,
        defaultBranch,
        baseUrl: getDurangoWebUrl(),
        token,
      });
      return { repo, previousLink, created: true };
    } catch (error) {
      if (error?.status !== 409) throw error;
    }
  }
  throw new Error('Could not choose an available Durango Cloud repository name.');
};

const restoreCloudRepoLink = async (gitRoot, previousLink) => {
  if (previousLink?.repoId) await setCloudRepoLink(gitRoot, previousLink);
  else await clearCloudRepoLink(gitRoot);
};

const convertGithubSourceControl = async ({ projectPath, state, session }) => {
  const gitRoot = state.gitRoot;
  const current = await getCurrentGitBranch(gitRoot);
  if (!current) {
    throw new Error('Cannot switch source control from a detached HEAD. Check out a branch first.');
  }
  await ensureInitialSourceControlCommit(gitRoot, session);

  const [localBranches, localTags] = await Promise.all([
    readLocalNamedRefs(gitRoot, 'refs/heads', 'branch'),
    readLocalNamedRefs(gitRoot, 'refs/tags', 'tag'),
  ]);
  let githubDefaultBranch = current;
  try {
    await execFileAsync(
      'git',
      [
        '-C', gitRoot, 'fetch', '--prune', 'origin',
        '+refs/heads/*:refs/remotes/origin/*',
        '+refs/tags/*:refs/orion-import/github-tags/*',
      ],
      { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    );
    const { stdout: remoteHead } = await execFileAsync(
      'git',
      ['-C', gitRoot, 'ls-remote', '--symref', 'origin', 'HEAD'],
      { timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    );
    githubDefaultBranch =
      remoteHead.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m)?.[1]?.trim() || current;
  } catch {
    throw new Error(
      'The GitHub remote could not be refreshed completely. Durango Code left the repository on GitHub.'
    );
  }

  const [githubBranches, githubTags] = await Promise.all([
    readLocalNamedRefs(gitRoot, 'refs/remotes/origin', 'branch'),
    readLocalNamedRefs(gitRoot, 'refs/orion-import/github-tags', 'tag'),
  ]);
  const filteredGithubBranches = githubBranches.filter(({ branch }) => branch !== 'HEAD');
  const { targetBranches, targetTags, branchPreservations, tagPreservations } =
    planGithubRefImport({
      localBranches,
      githubBranches: filteredGithubBranches,
      localTags,
      githubTags,
    });

  const repoName = sanitizeRepositoryName(state.origin.repo || path.basename(gitRoot));
  const provisioned = await createAvailableEmptyCloudRepo({
    gitRoot,
    name: repoName,
    defaultBranch: githubDefaultBranch,
    token: session.token,
  });
  const connection = await getCloudGitConnection({
    baseUrl: getDurangoWebUrl(), token: session.token,
  });
  const cloneUrl = expectedOrionGitRemote(connection?.gitHttpUrl, provisioned.repo.id);
  if (!connection?.gitHttpUrl || !isOrionRepoRemoteUrl(cloneUrl, provisioned.repo.id)) {
    await restoreCloudRepoLink(gitRoot, provisioned.previousLink);
    await clearGithubImportTagRefs(gitRoot);
    throw new Error('Durango Cloud did not return a valid Git repository endpoint.');
  }

  const refspecs = [
    ...[...targetBranches].map(([branch, oid]) => `${oid}:refs/heads/${branch}`),
    ...[...targetTags].map(([tag, oid]) => `${oid}:refs/tags/${tag}`),
  ];
  try {
    if (refspecs.length > 0) {
      await runAuthenticatedGit({
        gitRoot,
        token: session.token,
        args: ['push', '--atomic', cloneUrl, ...refspecs],
      });
    }
    if (shouldReconcileDefaultBranch({
      repo: provisioned.repo,
      authoritativeDefaultBranch: githubDefaultBranch,
    })) {
      const updated = await cloudGitApiRequest(
        `/api/git/repos/${encodeURIComponent(provisioned.repo.id)}`,
        { method: 'PATCH', body: { defaultBranch: githubDefaultBranch } }
      );
      provisioned.repo = updated.repo;
    }
  } catch (error) {
    await restoreCloudRepoLink(gitRoot, provisioned.previousLink);
    await clearGithubImportTagRefs(gitRoot);
    throw error;
  }

  const currentPreservation = branchPreservations.find((entry) => entry.original === current);
  const previousGithubUrl = state.remotes.find((remote) => remote.name === 'github')?.url ?? null;
  let localRefsChanged = false;
  let remotesMayHaveChanged = false;
  try {
    if (currentPreservation) {
      await execFileAsync('git', ['-C', gitRoot, 'branch', '-m', currentPreservation.preserved]);
      localRefsChanged = true;
      await execFileAsync('git', [
        '-C', gitRoot, 'update-ref', `refs/heads/${currentPreservation.original}`,
        currentPreservation.githubOid,
      ]);
    }
    for (const entry of branchPreservations) {
      if (entry === currentPreservation) continue;
      await execFileAsync('git', [
        '-C', gitRoot, 'update-ref', `refs/heads/${entry.preserved}`, entry.localOid,
      ]);
      localRefsChanged = true;
      await execFileAsync('git', [
        '-C', gitRoot, 'update-ref', `refs/heads/${entry.original}`, entry.githubOid,
      ]);
    }
    for (const entry of tagPreservations) {
      await execFileAsync('git', [
        '-C', gitRoot, 'update-ref', `refs/tags/${entry.preserved}`, entry.localOid,
      ]);
      localRefsChanged = true;
      await execFileAsync('git', [
        '-C', gitRoot, 'update-ref', `refs/tags/${entry.original}`, entry.githubOid,
      ]);
    }

    remotesMayHaveChanged = true;
    await configureOrionSourceControl({
      gitRoot,
      orionUrl: cloneUrl,
      repoId: provisioned.repo.id,
      repoName: provisioned.repo.name,
      orionHosts: [new URL(connection.gitHttpUrl).hostname],
    });
    for (const [branch, oid] of targetBranches) {
      await execFileAsync('git', ['-C', gitRoot, 'update-ref', `refs/remotes/origin/${branch}`, oid]);
    }
    for (const { branch, oid } of filteredGithubBranches) {
      await execFileAsync('git', ['-C', gitRoot, 'update-ref', `refs/remotes/github/${branch}`, oid]);
    }
    const activeBranch = currentPreservation?.preserved ?? current;
    await execFileAsync('git', ['-C', gitRoot, 'config', '--local', `branch.${activeBranch}.remote`, 'origin']);
    await execFileAsync('git', [
      '-C', gitRoot, 'config', '--local', `branch.${activeBranch}.merge`, `refs/heads/${activeBranch}`,
    ]);
  } catch (error) {
    if (remotesMayHaveChanged) {
      await execFileAsync('git', ['-C', gitRoot, 'remote', 'set-url', 'origin', state.originUrl]).catch(() => {});
      if (previousGithubUrl) {
        const hasGithubRemote = await execFileAsync('git', ['-C', gitRoot, 'remote', 'get-url', 'github'])
          .then(() => true, () => false);
        await execFileAsync('git', [
          '-C', gitRoot, 'remote', hasGithubRemote ? 'set-url' : 'add', 'github', previousGithubUrl,
        ]).catch(() => {});
      } else {
        await execFileAsync('git', ['-C', gitRoot, 'remote', 'remove', 'github']).catch(() => {});
      }
      for (const key of ['orion.sourcecontrol', 'orion.githubMirrorUrl', 'orion.githubMirrorDelivery']) {
        await execFileAsync('git', ['-C', gitRoot, 'config', '--local', '--unset-all', key]).catch(() => {});
      }
    }
    if (localRefsChanged) {
      if (currentPreservation && (await getCurrentGitBranch(gitRoot)) === currentPreservation.preserved) {
        await execFileAsync('git', ['-C', gitRoot, 'branch', '-m', current]).catch(() => {});
      }
      for (const entry of branchPreservations) {
        await execFileAsync('git', ['-C', gitRoot, 'update-ref', `refs/heads/${entry.original}`, entry.localOid]).catch(() => {});
        await execFileAsync('git', ['-C', gitRoot, 'update-ref', '-d', `refs/heads/${entry.preserved}`]).catch(() => {});
      }
      for (const entry of tagPreservations) {
        await execFileAsync('git', ['-C', gitRoot, 'update-ref', `refs/tags/${entry.original}`, entry.localOid]).catch(() => {});
        await execFileAsync('git', ['-C', gitRoot, 'update-ref', '-d', `refs/tags/${entry.preserved}`]).catch(() => {});
      }
    }
    await restoreCloudRepoLink(gitRoot, provisioned.previousLink);
    throw error;
  } finally {
    await clearGithubImportTagRefs(gitRoot);
  }

  let mirror = null;
  let mirrorConfigurationWarning = null;
  try {
    const configured = await cloudGitApiRequest(
      `/api/git/repos/${encodeURIComponent(provisioned.repo.id)}/github-mirror`,
      {
        method: 'PUT',
        body: {
          githubOwner: state.origin.owner,
          githubName: state.origin.repo,
          githubUrl: state.originUrl,
        },
      }
    );
    mirror = mirrorFromCloudResponse(configured);
    await persistGithubMirrorDelivery(gitRoot, mirror);
  } catch (error) {
    if (error?.status === 404) {
      await persistGithubMirrorDelivery(gitRoot, null);
    } else {
      mirrorConfigurationWarning =
        'Continuous GitHub mirroring could not be confirmed; Desktop will not mirror until Cloud status recovers.';
    }
  }

  const preservedNames = [
    ...branchPreservations.map((entry) => entry.preserved),
    ...tagPreservations.map((entry) => `tag ${entry.preserved}`),
  ];
  const preservationMessage = preservedNames.length > 0
    ? `Differing local refs were preserved in Durango Cloud as ${preservedNames.join(', ')}.`
    : null;
  return {
    ok: true,
    createdRepository: provisioned.created,
    repo: provisioned.repo,
    originUrl: cloneUrl,
    githubMirrorUrl: state.originUrl,
    mirror,
    ...(
      preservationMessage || mirrorConfigurationWarning
        ? { mirrorWarning: [preservationMessage, mirrorConfigurationWarning].filter(Boolean).join(' ') }
        : {}
    ),
  };
};

ipcMain.handle('git:changeSourceControlToOrion', async (_event, input) => {
  try {
    const projectPath = input?.projectPath;
    if (!projectPath) return { ok: false, error: 'Missing project path.' };
    const session = await readRepositorySession();
    if (!session?.token) {
      return { ok: false, needsAuth: true, error: 'Sign in to your Durango account first.' };
    }

    const initialSource = await inspectSourceControl(projectPath);
    if (initialSource.origin.kind === 'github') {
      return await convertGithubSourceControl({ projectPath, state: initialSource, session });
    }

    const trustedOrionHosts = [];
    let createdRepository = false;
    const switched = await switchSourceControlToOrion({
      projectPath,
      orionHosts: trustedOrionHosts,
      provisionRepo: async ({ name, defaultBranch, gitRoot }) => {
        await ensureInitialSourceControlCommit(gitRoot, session);
        let link = await getCloudRepoLink(gitRoot);
        let repo = null;

        if (link?.repoId) {
          const pushed = await pushRepo({
            gitRoot,
            repoId: link.repoId,
            baseUrl: getDurangoWebUrl(),
            token: session.token,
          });
          if (!pushed.ok) throw new Error(pushed.error || 'Could not seed the Durango Cloud repository.');
          repo = pushed.repo ?? { id: link.repoId, name: link.repoName ?? name, defaultBranch };
        } else {
          try {
            const published = await publishRepo({
              gitRoot,
              name,
              baseUrl: getDurangoWebUrl(),
              token: session.token,
            });
            if (!published.ok) throw new Error(published.error || 'Could not seed the Durango Cloud repository.');
            repo = published.repo;
            createdRepository = true;
          } catch (error) {
            if (error?.status !== 409) throw error;
            repo = await findOwnedCloudRepo({
              baseUrl: getDurangoWebUrl(),
              token: session.token,
              name,
            });
            if (!repo) throw error;
            await setCloudRepoLink(gitRoot, { repoId: repo.id, repoName: repo.name });
            const pushed = await pushRepo({
              gitRoot,
              repoId: repo.id,
              baseUrl: getDurangoWebUrl(),
              token: session.token,
            });
            if (!pushed.ok) throw new Error(pushed.error || 'Could not update the Durango Cloud repository.');
          }
        }

        const connection = await getCloudGitConnection({
          baseUrl: getDurangoWebUrl(),
          token: session.token,
        });
        const gitHttpUrl = String(connection?.gitHttpUrl ?? '').replace(/\/+$/, '');
        const parsed = new URL(gitHttpUrl);
        trustedOrionHosts.push(parsed.hostname);
        return { repo, cloneUrl: `${gitHttpUrl}/r/${encodeURIComponent(repo.id)}.git` };
      },
    });

    await runVerifiedOrionGit({
      gitRoot: switched.gitRoot,
      token: session.token,
      args: ['push', 'origin', '--tags'],
    });
    const pushed = await pushOrionSourceControl({
      gitRoot: switched.gitRoot,
      token: session.token,
    });
    return {
      ok: true,
      createdRepository,
      repo: switched.repo,
      originUrl: switched.originUrl,
      githubMirrorUrl: switched.githubUrl,
      mirror: pushed.mirror ?? null,
      ...(pushed.mirrorWarning ? { mirrorWarning: pushed.mirrorWarning } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      ...(error?.needsAuth || error?.status === 401 ? { needsAuth: true } : {}),
      error: cloudErrorMessage(error),
    };
  }
});

ipcMain.handle('git:authorizeGithubMirror', async (_event, projectPath) => {
  try {
    if (!projectPath) return { ok: false, error: 'Missing project path.' };
    const session = await readRepositorySession();
    if (!session?.token) {
      return { ok: false, needsAuth: true, error: 'Sign in to your Durango account first.' };
    }
    const gitRoot = await getGitRoot(projectPath);
    const [link, state] = await Promise.all([
      getCloudRepoLink(gitRoot),
      getGitStateForPath(gitRoot),
    ]);
    if (!link?.repoId || !state.githubMirrorUrl) {
      return { ok: false, error: 'This repository does not have a preserved GitHub mirror.' };
    }
    await verifyOrionGitRemote({ gitRoot, token: session.token });
    const configured = await cloudGitApiRequest(
      `/api/git/repos/${encodeURIComponent(link.repoId)}/github-mirror`,
      { method: 'PUT', body: { githubUrl: state.githubMirrorUrl } }
    );
    return { ok: true, mirror: mirrorFromCloudResponse(configured) };
  } catch (error) {
    return {
      ok: false,
      ...(error?.needsAuth || error?.status === 401 ? { needsAuth: true } : {}),
      error: cloudErrorMessage(error),
    };
  }
});

ipcMain.handle('cloud:getState', async (_event, projectPath) => {
  try {
    if (!projectPath) return { ok: false, error: 'Missing project path.' };
    const session = await readRepositorySession();
    if (!session?.token) {
      return { ok: true, authenticated: false, linked: false };
    }
    const gitRoot = await getGitRoot(projectPath);
    const state = await getCloudState({
      gitRoot,
      baseUrl: getDurangoWebUrl(),
      token: session.token,
    });
    return {
      ok: true,
      authenticated: true,
      ...state,
      webUrl: state.linked ? cloudRepoWebUrl(state.repoId) : null,
    };
  } catch (error) {
    if (error?.needsAuth || error?.status === 401) {
      return { ok: true, authenticated: false, linked: false };
    }
    return { ok: false, error: cloudErrorMessage(error) };
  }
});

ipcMain.handle('cloud:publish', async (_event, input) => {
  try {
    const projectPath = input?.projectPath;
    if (!projectPath) return { ok: false, error: 'Missing project path.' };
    const session = await readRepositorySession();
    if (!session?.token) {
      return { ok: false, error: 'Sign in to your Durango account to publish.', needsAuth: true };
    }

    const gitRoot = await getGitRoot(projectPath);
    const existing = await getCloudRepoLink(gitRoot);
    if (existing) {
      // Already linked — publishing again just means updating the cloud copy.
      try {
        const result = await pushRepo({
          gitRoot,
          repoId: existing.repoId,
          baseUrl: getDurangoWebUrl(),
          token: session.token,
        });
        return { ...result, alreadyLinked: true, webUrl: cloudRepoWebUrl(existing.repoId) };
      } catch (error) {
        if (error?.status !== 404) throw error;
        // The cloud repo is gone — drop the stale link and publish fresh.
        await clearCloudRepoLink(gitRoot);
      }
    }

    const name = sanitizeCloudRepoName(input?.name || path.basename(gitRoot));
    if (!name) return { ok: false, error: 'Invalid repository name.' };

    const result = await publishRepo({
      gitRoot,
      name,
      baseUrl: getDurangoWebUrl(),
      token: session.token,
    });
    return { ...result, webUrl: result.repo ? cloudRepoWebUrl(result.repo.id) : null };
  } catch (error) {
    return { ok: false, error: cloudErrorMessage(error) };
  }
});

ipcMain.handle('cloud:push', async (_event, projectPath) => {
  try {
    if (!projectPath) return { ok: false, error: 'Missing project path.' };
    const session = await readRepositorySession();
    if (!session?.token) {
      return { ok: false, error: 'Sign in to your Durango account first.', needsAuth: true };
    }
    const gitRoot = await getGitRoot(projectPath);
    const link = await getCloudRepoLink(gitRoot);
    if (!link) return { ok: false, error: 'This repository is not linked to Durango Cloud yet.' };

    return await pushRepo({
      gitRoot,
      repoId: link.repoId,
      baseUrl: getDurangoWebUrl(),
      token: session.token,
    });
  } catch (error) {
    return { ok: false, error: cloudErrorMessage(error) };
  }
});

ipcMain.handle('cloud:pull', async (_event, projectPath) => {
  try {
    if (!projectPath) return { ok: false, error: 'Missing project path.' };
    const session = await readRepositorySession();
    if (!session?.token) {
      return { ok: false, error: 'Sign in to your Durango account first.', needsAuth: true };
    }
    const gitRoot = await getGitRoot(projectPath);
    const link = await getCloudRepoLink(gitRoot);
    if (!link) return { ok: false, error: 'This repository is not linked to Durango Cloud yet.' };

    const pulled = await pullRepo({
      gitRoot,
      repoId: link.repoId,
      baseUrl: getDurangoWebUrl(),
      token: session.token,
    });
    const sourceState = await getGitStateForPath(gitRoot);
    if (
      pulled.ok &&
      sourceState.sourceProvider === 'orion' &&
      sourceState.currentBranch &&
      ['fast-forwarded', 'checked-out', 'up-to-date'].includes(pulled.merge?.status)
    ) {
      const mirrored = await pushOrionSourceControl({
        gitRoot,
        branch: sourceState.currentBranch,
        token: session.token,
      });
      if (mirrored.mirrorWarning) pulled.mirrorWarning = mirrored.mirrorWarning;
    }
    return pulled;
  } catch (error) {
    return { ok: false, error: cloudErrorMessage(error) };
  }
});

// --- Orion Cloud deploys ------------------------------------------------------

const cloudAppFileExists = async (gitRoot, name) => {
  try {
    await fs.access(path.join(gitRoot, name));
    return true;
  } catch {
    return false;
  }
};

/**
 * Can Railway's Railpack build this repo straight from its root, or does it
 * need someone to figure it out? "Simple" is the direct-deploy path; anything
 * else gets handed to the deployment agent with these reasons as context.
 */
const cloudDeployPrecheck = async (gitRoot) => {
  const reasons = [];

  // A direct deploy can only push commits. If the working tree is dirty,
  // handing the deploy to the agent prevents a successful rebuild of stale
  // HEAD while the user's latest files remain local and uncommitted.
  const statusEntries = await readGitStatusEntries(gitRoot);
  if (statusEntries.length > 0) {
    reasons.push('uncommitted working tree changes');
  }

  // Explicit build config wins: whoever wrote it already answered the question.
  for (const name of ['railway.json', 'railway.toml', 'railpack.json']) {
    if (reasons.length === 0 && (await cloudAppFileExists(gitRoot, name))) {
      return { simple: true, reasons: [`${name} pins the build configuration`] };
    }
  }

  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    if (await cloudAppFileExists(gitRoot, name)) reasons.push(`${name} present (multi-service app)`);
  }
  if (await cloudAppFileExists(gitRoot, 'pnpm-workspace.yaml')) reasons.push('pnpm workspaces monorepo');
  if (await cloudAppFileExists(gitRoot, 'lerna.json')) reasons.push('Lerna monorepo');

  let packageJson = null;
  let packageJsonUnreadable = false;
  try {
    packageJson = JSON.parse(await fs.readFile(path.join(gitRoot, 'package.json'), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') packageJsonUnreadable = true;
  }

  if (packageJsonUnreadable) {
    reasons.push('package.json could not be parsed');
  } else if (packageJson) {
    if (packageJson.workspaces) reasons.push('npm workspaces monorepo');
  } else if (!(await cloudAppFileExists(gitRoot, 'Dockerfile'))) {
    reasons.push('no package.json or Dockerfile at the repository root');
  }

  return { simple: reasons.length === 0, reasons };
};

ipcMain.handle('cloud:deployPrecheck', async (_event, projectPath) => {
  try {
    if (!projectPath) return { ok: false, error: 'Missing project path.' };
    const gitRoot = await getGitRoot(projectPath);
    return { ok: true, ...(await cloudDeployPrecheck(gitRoot)) };
  } catch (error) {
    return { ok: false, error: cloudErrorMessage(error) };
  }
});

ipcMain.handle('cloud:deploy', async (_event, projectPath) => {
  try {
    if (!projectPath) return { ok: false, error: 'Missing project path.' };
    const session = await readRepositorySession();
    if (!session?.token) {
      return { ok: false, error: 'Sign in to your Durango account first.', needsAuth: true };
    }
    const gitRoot = await getGitRoot(projectPath);
    const link = await getCloudRepoLink(gitRoot);
    if (!link) {
      return {
        ok: false,
        error: 'Publish this project to Durango Cloud first.',
        needsPublish: true,
      };
    }

    // The server builds whatever HEAD it has, so push before deploying. A
    // converted repository uses its real Orion origin (and downstream GitHub
    // mirror); legacy Cloud-linked repos retain the JSON pack-upload path.
    const sourceState = await getGitStateForPath(gitRoot);
    if (sourceState.sourceProvider === 'orion' && !sourceState.currentBranch) {
      return { ok: false, error: 'Cannot deploy from a detached HEAD.' };
    }
    const pushed = sourceState.sourceProvider === 'orion'
      ? await pushBranchToSourceControl(gitRoot, sourceState.currentBranch)
      : await pushRepo({
          gitRoot,
          repoId: link.repoId,
          baseUrl: getDurangoWebUrl(),
          token: session.token,
        });
    if (!pushed.ok) return pushed;

    const app = await deployApp({
      repoId: link.repoId,
      baseUrl: getDurangoWebUrl(),
      token: session.token,
    });
    return { ok: true, app };
  } catch (error) {
    if (error?.status === 402) {
      // Free plan's one-app limit. The server's message is the user-facing
      // copy; the flags let the renderer offer the upgrade path.
      return {
        ok: false,
        error: error?.data?.error ?? 'Your plan does not allow another Durango Cloud app.',
        limitReached: Boolean(error?.data?.limitReached),
        upgradeRequired: Boolean(error?.data?.upgradeRequired),
        appLimit: error?.data?.appLimit ?? null,
      };
    }
    return {
      ok: false,
      error: cloudErrorMessage(error),
      ...(error?.status === 401 ? { needsAuth: true } : {}),
    };
  }
});

ipcMain.handle('cloud:getAppState', async (_event, projectPath) => {
  try {
    if (!projectPath) return { ok: false, error: 'Missing project path.' };
    const session = await readRepositorySession();
    if (!session?.token) {
      return { ok: false, error: 'Sign in to your Durango account first.', needsAuth: true };
    }
    const gitRoot = await getGitRoot(projectPath);
    const link = await getCloudRepoLink(gitRoot);
    if (!link) return { ok: true, app: null };

    return {
      ok: true,
      app: await getAppState({
        repoId: link.repoId,
        baseUrl: getDurangoWebUrl(),
        token: session.token,
      }),
    };
  } catch (error) {
    return { ok: false, error: cloudErrorMessage(error) };
  }
});

ipcMain.handle('cloud:openAppInBrowser', async (_event, projectPath) => {
  try {
    if (!projectPath) return { ok: false, error: 'Missing project path.' };
    const session = await readRepositorySession();
    if (!session?.token) {
      return { ok: false, error: 'Sign in to your Durango account first.', needsAuth: true };
    }
    const gitRoot = await getGitRoot(projectPath);
    const link = await getCloudRepoLink(gitRoot);
    if (!link) return { ok: false, error: 'This repository is not linked to Durango Cloud yet.' };

    const app = await getAppState({
      repoId: link.repoId,
      baseUrl: getDurangoWebUrl(),
      token: session.token,
    });
    if (!app?.url) return { ok: false, error: 'This project has no deployed app yet.' };
    const parsed = new URL(app.url);
    if (parsed.protocol !== 'https:') return { ok: false, error: 'Only https URLs can be opened.' };
    await shell.openExternal(parsed.toString());
    return { ok: true, app };
  } catch (error) {
    return { ok: false, error: cloudErrorMessage(error) };
  }
});

// --- Linked tasks: Durango Tasks (legacy: the Durango Code web board) ----------
// src/main/board-tasks.js. DURANGO_TASKS=0, or turning off "Use Durango Tasks"
// in Settings → Durango, falls back to the legacy board's /api/tasks*.

const requireAccountToken = async () => {
  const session = await readAccountSession();
  return session?.token ?? null;
};

let useDurangoTasksSetting = true;
const boardTasks = createBoardTasks({
  useDurango: () => durangoTasksEnabled({ setting: useDurangoTasksSetting }),
  durango: durangoClient,
  readToken: requireAccountToken,
  webOrigin: () => getDurangoWebUrl(),
  attachmentDir: () => getAttachmentDirectoryPath(),
  sanitizeName: sanitizeAttachmentName,
  legacyErrorMessage: cloudErrorMessage,
});

ipcMain.handle('tasks:list', () => boardTasks.list());
ipcMain.handle('tasks:get', (_event, rawTaskId) => boardTasks.get(rawTaskId));
ipcMain.handle('tasks:link', (_event, input) => boardTasks.link(input));
ipcMain.handle('tasks:unlink', (_event, input) => boardTasks.unlink(input));
ipcMain.handle('tasks:threadStatus', (_event, input) => boardTasks.threadStatus(input));
// "Open in Durango": durango.sh/tasks (or the legacy web board).
ipcMain.handle('tasks:openWeb', async () => {
  try {
    const url = externalWebUrl(await boardTasks.webUrl());
    if (!url) return { ok: false, error: 'Durango Tasks has no web address.' };
    await shell.openExternal(url);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
});

// --- Durango Chat dispatch: agents started from chat (Phase 5) -------------------
// src/main/durango-dispatch.js runs the claim loop; threads are created by
// the renderer through the remote-control command bridge (same runTurn path
// as a paired controller), so the renderer stays authoritative.

const DISPATCH_START_TIMEOUT_MS = 120_000;
const DISPATCH_COMPLETION_TIMEOUT_MS = 5 * 60_000;
const DISPATCH_COMMAND_PREFIX = 'durango-dispatch:';
const dispatchRendererCommands = new Map(); // commandId -> pending

const settleDispatchRendererCommand = (commandId, result) => {
  const pending = dispatchRendererCommands.get(commandId);
  if (!pending) return false;
  dispatchRendererCommands.delete(commandId);
  clearTimeout(pending.timer);
  pending.resolve(result);
  return true;
};

const requestDispatchRendererCommand = (command, timeoutMs = DISPATCH_START_TIMEOUT_MS) =>
  new Promise((resolve) => {
    const commandId = `${DISPATCH_COMMAND_PREFIX}${crypto.randomUUID()}`;
    const timer = setTimeout(
      () => settleDispatchRendererCommand(commandId, { ok: false, error: 'Durango Code did not start the agent in time.' }),
      timeoutMs
    );
    timer.unref?.();
    dispatchRendererCommands.set(commandId, { resolve, timer, claimed: false });
    if (dispatchRemoteCommand({ commandId, expiresAt: Date.now() + timeoutMs, command }) === 0) {
      settleDispatchRendererCommand(commandId, {
        ok: false,
        error: 'Open a Durango Code window on this Mac to run agents from Durango Chat.',
      });
    }
  });

const isDispatchRendererCommand = (commandId) =>
  typeof commandId === 'string' && commandId.startsWith(DISPATCH_COMMAND_PREFIX);

const claimDispatchRendererCommand = ({ commandId } = {}) => {
  const pending = dispatchRendererCommands.get(commandId);
  if (!pending || pending.claimed) return { ok: false };
  pending.claimed = true;
  clearTimeout(pending.timer);
  pending.timer = setTimeout(
    () => settleDispatchRendererCommand(commandId, { ok: false, error: 'Durango Code did not confirm the agent start in time.' }),
    DISPATCH_COMPLETION_TIMEOUT_MS
  );
  pending.timer.unref?.();
  return { ok: true };
};

const resolveDispatchRendererCommand = (payload) => ({
  ok: settleDispatchRendererCommand(payload?.commandId, {
    ok: payload?.ok === true,
    threadId: typeof payload?.threadId === 'string' ? payload.threadId : undefined,
    threadTitle: typeof payload?.threadTitle === 'string' ? payload.threadTitle : undefined,
    projectId: typeof payload?.projectId === 'string' ? payload.projectId : undefined,
    mirrored: payload?.mirrored === true ? true : undefined,
    error: typeof payload?.error === 'string' ? payload.error : undefined,
  }),
});

let dispatchMachineName = null;
const getDispatchMachineName = async () => {
  if (dispatchMachineName) return dispatchMachineName;
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('scutil', ['--get', 'ComputerName'], { timeout: 3000 });
      if (stdout.trim()) dispatchMachineName = stdout.trim();
    } catch {}
  }
  dispatchMachineName ??= os.hostname().replace(/\.local$/i, '') || 'Mac';
  return dispatchMachineName;
};

// Notifications must stay referenced until clicked or closed, or Electron can
// garbage-collect them and drop the click handler.
const dispatchNotifications = new Set();
const focusThreadInWindow = (threadId) => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (process.platform === 'darwin') app.focus({ steal: true });
  }
  sendToAllWindows('durango:focusThread', { threadId });
};
const notifyDispatchStarted = ({ dispatch, project, threadId }) => {
  if (!Notification.isSupported()) return;
  const firstLine = String(dispatch?.prompt ?? '').trim().split('\n')[0] ?? '';
  const notification = new Notification({
    title: `${dispatchSourceLabel(dispatch)} started an agent in ${project?.name ?? 'a project'}`,
    body: firstLine.length > 140 ? `${firstLine.slice(0, 139)}…` : firstLine,
  });
  dispatchNotifications.add(notification);
  const forget = () => dispatchNotifications.delete(notification);
  notification.on('click', () => {
    forget();
    focusThreadInWindow(threadId);
  });
  notification.on('close', forget);
  notification.show();
};

const dispatchProjectsWithRepoIds = async (projects) =>
  Promise.all(
    (Array.isArray(projects) ? projects : [])
      .filter((project) => typeof project?.id === 'string' && typeof project?.name === 'string')
      .map(async (project) => ({
        id: project.id,
        name: project.name,
        path: typeof project.path === 'string' ? project.path : null,
        // Published projects carry their Durango Cloud repo id in git config.
        repoId: project.path ? ((await getCloudRepoLink(project.path).catch(() => null))?.repoId ?? null) : null,
      }))
  );

const isDispatchSignedIn = async () => {
  if (durangoMock) return true;
  const session = await readAccountSession().catch(() => null);
  return Boolean(session?.token) && !(session.expiresAt && Date.parse(session.expiresAt) <= Date.now());
};

// Projects as the renderer last reported them (durango:configure), for
// finding an existing checkout of a Source repository before cloning it.
let configuredProjects = [];

const existingSourceProject = async (repoId) =>
  (await dispatchProjectsWithRepoIds(configuredProjects)).find(
    (project) => project.repoId === repoId && project.path && existsSync(project.path)
  ) ?? null;

// Clones a Durango Source repository this machine doesn't have and adds it as
// a project (main/source-checkout.js), for runs started from Durango or a
// paired machine. Only with a bundled CLI that has `clone`.
const checkoutSourceProject = createSourceCheckout({
  runCli: runBundledCli,
  cliError: bundledCliError,
  prepareCli: async () => {
    await installBundledCli();
    const signIn = await signInBundledCli();
    if (!signIn.signedIn && !(await readCliCredential().catch(() => null))) {
      throw new Error(signIn.error || 'Sign in to Durango Code to clone from Durango Source.');
    }
  },
  existingProject: existingSourceProject,
  addProject: async ({ name, path: projectPath }) => {
    const result = await requestDispatchRendererCommand(
      {
        kind: 'addProject',
        projectName: name,
        projectPath,
        source: { machineId: 'durango-source', machineName: 'Durango Source' },
      },
      60_000
    );
    return result?.ok && result.projectId ? { id: result.projectId } : { error: result?.error };
  },
});
const sourceCheckoutAvailable = () => Boolean(bundledCliEntry()) && cliSupportsClone(bundledCliVersion());

// The models dispatched runs may use, with the effort levels each takes. The
// worker reads this before every claim (to register changes), so it is cached
// and refreshed every few minutes or when the catalog changes.
const DISPATCH_MODELS_TTL_MS = 5 * 60_000;
let dispatchModelsCache = null;
onAgentModelsChanged(() => {
  dispatchModelsCache = null;
});
const listDispatchModels = async () => {
  if (dispatchModelsCache && Date.now() - dispatchModelsCache.at < DISPATCH_MODELS_TTL_MS) return dispatchModelsCache.models;
  const models = (await listAgentModelsWithAvailability())
    .filter((model) => typeof model?.id === 'string' && remoteThreadRuntime(model.id) === 'agent')
    .map((model) => ({
      id: model.id,
      label: String(model.label || model.id),
      slug: typeof model.slug === 'string' ? model.slug : undefined,
      providerId: typeof model.providerId === 'string' ? model.providerId : undefined,
      provider: String(model.providerLabel || model.providerId || ''),
      efforts: remoteModelEfforts(model),
      available: model.available !== false,
      ...(typeof model.unavailableReason === 'string' ? { unavailableReason: model.unavailableReason } : {}),
    }));
  dispatchModelsCache = { at: Date.now(), models };
  return models;
};

// Durango bot replies on this machine's Claude Code (src/main/bot-replies.js):
// offered while Claude models are available here (the same check the model
// list uses), and run exactly while dispatch runs.
const botRepliesAvailable = async () =>
  (await listDispatchModels()).some((model) => model.providerId === 'claude' && model.available !== false);

const dispatchWorker = createDispatchWorker({
  client: durangoClient,
  getMachineId: () => getDurangoDeviceId(),
  getMachineName: () => getDispatchMachineName(),
  platform: process.platform,
  isSignedIn: isDispatchSignedIn,
  isOnline: () => net.isOnline(),
  canStart: () => Boolean(remoteCommandRenderer && !remoteCommandRenderer.isDestroyed()),
  checkoutProject: sourceCheckoutAvailable() ? checkoutSourceProject : null,
  getThread: async (threadId) => {
    const thread = await readThreadById(threadId);
    if (!thread) return undefined;
    return {
      projectId: typeof thread.projectId === 'string' ? thread.projectId : null,
      accessMode: typeof thread.accessMode === 'string' ? thread.accessMode : undefined,
    };
  },
  listModels: listDispatchModels,
  startRun: ({ dispatch, project, threadId, prompt, accessMode, modelId, reasoningEffort }) =>
    requestDispatchRendererCommand({
      kind: 'runTurn',
      ...(threadId ? { threadId } : { projectId: project.id }),
      prompt: prompt.slice(0, 200_000),
      ...(modelId ? { modelId } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      accessMode,
      source: { machineId: 'durango-chat', machineName: dispatchSourceLabel(dispatch) },
      durangoDispatch: {
        id: dispatch.id,
        origin:
          typeof dispatch.bot === 'string' && dispatch.bot.trim()
            ? 'bot'
            : dispatch.origin === 'tasks' || dispatch.origin === 'api'
              ? dispatch.origin
              : 'chat',
        sourceLabel: dispatchSourceLabel(dispatch),
        followUp: Boolean(threadId),
        taskId: dispatch.taskId,
        sourceUrl: dispatchSourceUrl(dispatch),
        requestedAccessMode: dispatch.accessMode,
      },
    }),
  stopRun: (threadId) =>
    requestDispatchRendererCommand(
      { kind: 'stopTurn', threadId, source: { machineId: 'durango-chat', machineName: 'Durango Chat' } },
      30_000
    ),
  notify: notifyDispatchStarted,
  onStateChange: (state) => sendToAllWindows('durango:dispatchState', state),
});

// The projects a bot reply here may see and work in: this machine's Durango
// Code projects, limited to the ones allowed for Durango (Settings → Durango).
let botAllowedProjectIds = normalizeDispatchSettings(null).allowedProjectIds;
// Projects whose folder is gone (moved or deleted) are left out: a reply
// can't work there, and Claude Code refuses a missing extra directory.
const botProjects = () =>
  configuredProjects.filter(
    (project) =>
      typeof project?.id === 'string' &&
      typeof project?.path === 'string' &&
      isProjectAllowed(project.id, botAllowedProjectIds) &&
      existsSync(project.path)
  );

// Each bot's Claude Code session, resumed by its next reply here (bot-sessions.js).
const botSessions = createBotSessionStore({
  dir: () => path.join(app.getPath('userData'), 'bots', '.sessions'),
  log: (...args) => console.warn('[bot sessions]', ...args),
});

const claudeBotLaneRunner = createClaudeLaneRunner({
  loadSdk: loadClaudeSdk,
  loadZod,
  resolveBinary: resolveClaudeBinary,
  createInputQueue: createClaudeInputQueue,
  botsDir: () => path.join(app.getPath('userData'), 'bots'),
  getProjects: botProjects,
  sessions: botSessions,
});

// A Durango Code thread a bot started in a project here (delegate_task
// `project`), opened in the app's window like an agent from Durango Chat. The
// renderer's dispatch settle watcher reports its outcome under the dispatch id
// `<prefix><key>` (durango:dispatchSettled below).
const LOCAL_BOT_DISPATCH_PREFIX = 'localbot:';
const BOT_TASK_DISPATCH_PREFIX = 'bottask:';
const startBotProjectThread = (prefix) => ({ projectId, prompt, key, botName, title, accessMode }) => {
  // A plain thread title, without a "Bots:" style prefix (bot-thread-title.js).
  const threadTitle = botThreadTitle(title, botName).slice(0, 80);
  return requestDispatchRendererCommand({
    kind: 'runTurn',
    projectId,
    prompt: prompt.slice(0, 200_000),
    accessMode,
    source: { machineId: 'durango-bot', machineName: botName },
    durangoDispatch: {
      id: `${prefix}${key}`,
      origin: 'bot',
      sourceLabel: `your bot ${botName}`,
      ...(threadTitle ? { title: threadTitle } : {}),
      followUp: false,
      sourceUrl: null,
      requestedAccessMode: accessMode,
    },
  });
};

// A bot's follow-up turn in an existing thread here (message_thread), reported
// like a thread it started.
// The turn runs with the stricter of the thread's own access and the bot's,
// so a bot never widens what a thread may do (a Read only thread stays Read
// only), as for follow-ups dispatched from Durango Chat.
const startBotThreadFollowUp = (prefix) => async ({ threadId, prompt, key, botName, accessMode }) => {
  // Bots work with Full access, in their follow-ups too (bot-replies.js normalizeBotSettings).
  const turnAccessMode = accessMode;
  return requestDispatchRendererCommand({
    kind: 'runTurn',
    threadId,
    prompt: prompt.slice(0, 200_000),
    accessMode: turnAccessMode,
    source: { machineId: 'durango-bot', machineName: botName },
    durangoDispatch: {
      id: `${prefix}${key}`,
      origin: 'bot',
      sourceLabel: `your bot ${botName}`,
      followUp: true,
      sourceUrl: null,
      requestedAccessMode: turnAccessMode,
    },
  });
};

// list_threads / read_thread / manage_thread over this machine's threads in the
// projects bots may use. manage_thread works on any thread (whether started by
// a bot or by the person); the renderer still refuses settling a running turn.
const botThreadTools = createBotThreadTools({
  readIndex: () => readThreadsIndex(),
  readThread: (args) => readThreadForAgent(args),
  getProjects: () => botProjects(),
  manageThread: ({ threadId, action, title }) => {
    const source = { machineId: 'durango-bot', machineName: 'your bot' };
    const now = new Date().toISOString();
    switch (action) {
      case 'settle':
        return requestDispatchRendererCommand({ kind: 'threadState', threadId, sidebarState: { settledAt: now }, source }, 30_000);
      case 'unsettle':
        return requestDispatchRendererCommand({ kind: 'threadState', threadId, sidebarState: { settledAt: null }, source }, 30_000);
      case 'snooze':
        return requestDispatchRendererCommand({ kind: 'threadState', threadId, sidebarState: { settledAt: null, snoozedAt: now }, source }, 30_000);
      case 'unsnooze':
        return requestDispatchRendererCommand({ kind: 'threadState', threadId, sidebarState: { snoozedAt: null }, source }, 30_000);
      case 'pin':
        return requestDispatchRendererCommand({ kind: 'threadState', threadId, sidebarState: { pinnedAt: now }, source }, 30_000);
      case 'unpin':
        return requestDispatchRendererCommand({ kind: 'threadState', threadId, sidebarState: { pinnedAt: null }, source }, 30_000);
      case 'rename':
        return requestDispatchRendererCommand({ kind: 'renameThread', threadId, title, source }, 30_000);
      case 'stop':
        return requestDispatchRendererCommand({ kind: 'stopTurn', threadId, source }, 30_000);
      case 'delete':
        return requestDispatchRendererCommand({ kind: 'deleteThread', threadId, source }, 30_000);
      default:
        return Promise.resolve({ ok: false, error: `Unsupported thread action "${action}".` });
    }
  },
});

// This machine's bot presence (name, projects with their keys, Claude
// models), sent with each claim poll. Building it reads every project's git
// config, so it is kept a couple of minutes (and rebuilt when the projects change).
const BOT_MACHINE_INFO_TTL_MS = 2 * 60_000;
let botMachineInfoCache = null;
const botMachineInfo = async () => {
  if (botMachineInfoCache && Date.now() - botMachineInfoCache.at < BOT_MACHINE_INFO_TTL_MS) return botMachineInfoCache.info;
  const info = {
    name: await getDispatchMachineName(),
    projects: await botProjectsWithKeys({ local: false }),
    models: (await listDispatchModels().catch(() => []))
      .filter((model) => model.providerId === 'claude' && model.available !== false)
      .map((model) => model.slug || model.id),
  };
  botMachineInfoCache = { at: Date.now(), info };
  return info;
};

// Signed in, this machine answers the person's Durango bots on its Claude
// Code (on by default; Settings → Durango "Answer your bots on this
// computer"). Its claim poll is its bot presence on Durango, with its name,
// projects and Claude models.
const botReplyWorker = createBotReplyWorker({
  client: durangoClient,
  getMachineId: () => getDurangoDeviceId(),
  platform: process.platform,
  isSignedIn: isDispatchSignedIn,
  isOnline: () => net.isOnline(),
  isAvailable: botRepliesAvailable,
  runLane: claudeBotLaneRunner,
  getMachineInfo: () => botMachineInfo(),
  startProjectThread: startBotProjectThread(BOT_TASK_DISPATCH_PREFIX),
  startThreadFollowUp: startBotThreadFollowUp(BOT_TASK_DISPATCH_PREFIX),
  threadTools: botThreadTools,
  // Files a reply attached (attach_files, screenshots it names): to the person's library.
  uploadReplyFile: async (file) => {
    const account = await durangoAccountKey();
    if (!account) throw new Error('Not signed in to Durango.');
    const uploaded = await durangoClient.uploadBotAttachment({
      name: file.name,
      bytes: await fs.readFile(file.path),
      contentType: mimeTypeForPath(file.path),
      account,
    });
    const asset = uploaded?.part?.asset;
    if (!asset?.id) throw new Error('Durango did not store the file.');
    return { id: asset.id, name: asset.name ?? file.name, kind: asset.kind ?? 'file' };
  },
  // A task cancelled on Durango: its thread here stops, like a dispatch stopped from Chat.
  stopThread: (threadId, taskId) =>
    requestDispatchRendererCommand(
      {
        kind: 'stopTurn',
        threadId,
        // Only that task's run: a turn started there since is left alone.
        stopDispatchId: `${BOT_TASK_DISPATCH_PREFIX}${taskId}`,
        source: { machineId: 'durango-bot', machineName: 'Durango' },
      },
      30_000
    ),
});

// Reports a bot task's thread outcome to Durango, retrying a few times.
// `retry: true` = it never got through (offline, signed out): the renderer
// keeps the outcome unreported and tries again later.
// The report ends with the thread's id (and this machine), so the bot can
// follow up there with message_thread, e.g. to ship the change it made.
// `waiting` / `seq`: see durango:dispatchSettled (a turn that ended with the
// thread still waiting, and the sequence number of a later report).
const reportBotTaskThread = async ({ taskId, threadId, outcome, summary, error, waiting, seq }) => {
  const machineId = await getDurangoDeviceId().catch(() => null);
  if (!machineId || !taskId) return { ok: false, retry: true };
  if (threadId) {
    const thread = { threadId, machine: await getDispatchMachineName().catch(() => null), cloud: true };
    // Kept short enough that Durango's clip of the report never cuts the footer.
    const head = (text) => String(text ?? '').trim().slice(0, 10_000);
    if (outcome === 'finished') summary = withThreadReportFooter(head(summary) || 'The Durango Code thread finished without a written summary.', thread);
    else error = withThreadReportFooter(head(error) || 'it stopped.', thread);
  }
  for (const delay of [0, 2_000, 10_000, 30_000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await durangoClient.reportBotTask({
        taskId,
        machineId,
        outcome,
        ...(summary ? { summary } : {}),
        ...(error ? { error } : {}),
        ...(waiting?.length ? { waiting } : {}),
        ...(seq ? { seq } : {}),
      });
    } catch (failure) {
      console.warn('[durango bots] reporting a bot task failed:', failure?.message ?? failure);
      // Durango answered (not a network or sign-in problem): retrying won't help.
      if (failure instanceof DurangoError && failure.code === 'api' && failure.status && failure.status < 500) return { ok: false };
    }
  }
  return { ok: false, retry: true };
};

// Local bots (src/main/local-bots.js): while signed out of Durango, Sidebar v3's
// bots live on this device and every reply runs on this machine's Claude Code,
// with the machine's dispatch access mode (Settings → Durango). Signing in
// uploads them to the Durango account (syncLocalBotsToDurango).
let localBotsAccessMode = normalizeBotSettings(null).accessMode;
const localBotNotifications = new Set();
const notifyLocalBot = ({ title, body }) => {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body: body ?? '' });
  localBotNotifications.add(notification);
  const forget = () => localBotNotifications.delete(notification);
  notification.on('click', () => {
    forget();
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  notification.on('close', forget);
  notification.show();
};
const localBots = createLocalBotEngine({
  dir: () => path.join(app.getPath('userData'), 'bots', 'local'),
  runLane: claudeBotLaneRunner,
  summarize: createClaudeOneShot({ loadSdk: loadClaudeSdk, resolveBinary: resolveClaudeBinary }),
  getAccessMode: () => localBotsAccessMode,
  notify: notifyLocalBot,
  listProjects: async () => botProjectsWithKeys({ local: true }),
  startProjectThread: startBotProjectThread(LOCAL_BOT_DISPATCH_PREFIX),
  startThreadFollowUp: startBotThreadFollowUp(LOCAL_BOT_DISPATCH_PREFIX),
  threadTools: botThreadTools,
});

// A file's bytes to a project's files on Durango, by its bot (a bot id) or by
// the project's key (`{ key }`). Durango's server stores the bytes itself.
const uploadBotProjectFile = (target, { name, bytes, contentType }, { account } = {}) =>
  durangoClient.uploadProjectFile({
    ...(typeof target === 'string' ? { botId: target } : { key: target.key }),
    name,
    bytes,
    contentType,
    ...(account ? { account } : {}),
  });

// After an import: local project bots' files go to their Durango project bots.
const LOCAL_BOTS_MACHINE = 'this-device';
// Signed out, a project without a Source repo is keyed on 'this-device';
// on Durango it is this machine's id (as projects opened signed in).
const syncedProjectKey = (key, deviceId) =>
  key.startsWith(`local:${LOCAL_BOTS_MACHINE}:`) ? `local:${deviceId}:${key.slice(`local:${LOCAL_BOTS_MACHINE}:`.length)}` : key;

// The account signed in now (its user id, or the token when the session has
// no user id), so a sync started for one account never writes to another.
const durangoAccountKey = async () => accountKeyOf(await readAccountSession().catch(() => null));

class LocalBotsAccountChanged extends Error {
  constructor() {
    super('the Durango account changed during the upload');
  }
}

// Every local project library's files go to that project on Durango (by
// key, with or without a bot). → the names that didn't upload. `stillSameAccount`
// is checked before each file (signing out or switching accounts stops it).
const uploadLocalProjectFiles = async (deviceId, account, stillSameAccount) => {
  const failed = [];
  for (const { key, files } of await localBots.projectFilesForSync()) {
    for (const file of files) {
      if (!(await stillSameAccount())) throw new LocalBotsAccountChanged();
      try {
        const bytes = await fs.readFile(file.path);
        await uploadBotProjectFile({ key: syncedProjectKey(key, deviceId) }, { name: file.name, bytes, contentType: file.contentType }, { account });
      } catch (error) {
        if (error instanceof DurangoError && error.code === 'account_changed') throw new LocalBotsAccountChanged();
        failed.push(`${file.name}: ${error?.message ?? error}`);
      }
    }
  }
  return failed;
};

// Uploads the bots made on this device while signed out to the Durango account,
// then moves the local files aside. On failure they stay and the next sign-in
// or app start tries again.
let localBotsSync = null;
const syncLocalBotsToDurango = () => {
  if (durangoMock) return Promise.resolve();
  let rerun = false;
  localBotsSync ??= (async () => {
    try {
      if (!(await isDispatchSignedIn()) || !(await localBots.hasDataToSync())) return;
      // Bound to the account it started for: signing out or into another
      // account midway stops it (and keeps the local data for the next try).
      const account = await durangoAccountKey();
      if (!account) return;
      const stillSameAccount = async () => (await durangoAccountKey()) === account;
      const deviceId = await getDurangoDeviceId();
      if (!deviceId) throw new Error('no device id yet');
      const payload = await localBots.exportForSync();
      // Local project keys become this machine's keys on Durango.
      for (const bot of payload.bots) {
        if (bot.project?.machineId === LOCAL_BOTS_MACHINE) bot.project.machineId = deviceId;
      }
      payload.projects = (payload.projects ?? []).map((project) => ({ ...project, key: syncedProjectKey(project.key, deviceId) }));
      if (!(await stillSameAccount())) throw new LocalBotsAccountChanged();
      const result = await durangoClient.importBots(payload, { account }).catch((error) => {
        throw error instanceof DurangoError && error.code === 'account_changed' ? new LocalBotsAccountChanged() : error;
      });
      if (result.complete === false) {
        // Durango kept part of it for later (a bot with a big unanswered backlog).
        console.warn('[local bots] Durango deferred part of the import; will retry.');
        return;
      }
      const failed = await uploadLocalProjectFiles(deviceId, account, stillSameAccount);
      if (failed.length) {
        // Kept here: the next sign-in or start retries (the import is idempotent).
        console.warn(`[local bots] ${failed.length} project file(s) did not upload; will retry:`, failed.join('; '));
        return;
      }
      if (!(await stillSameAccount())) throw new LocalBotsAccountChanged();
      await localBots.markSynced();
      console.log(`[local bots] uploaded ${result.bots.length} bot(s) to Durango`);
    } catch (error) {
      if (error instanceof LocalBotsAccountChanged) rerun = true;
      console.warn('[local bots] could not upload this device\'s bots (will retry on the next sign-in or start):', error?.message ?? error);
    }
  })().finally(() => {
    localBotsSync = null;
    // Switched accounts midway: the account signed in now gets them.
    if (rerun) setTimeout(() => void syncLocalBotsToDurango(), 1_000).unref?.();
  });
  return localBotsSync;
};

// --- Deploy watcher: deploy changes landed elsewhere ----------------------------------
// src/main/durango-deploy-watcher.js checks Durango Source for pending deploy
// targets and starts the bundled CLI's detached `deploys run` (the runner
// `durango-code land` starts) in the repository's base checkout.

const deployWatcherProjects = (projects) =>
  (Array.isArray(projects) ? projects : [])
    .filter((project) => typeof project?.path === 'string' && path.isAbsolute(project.path))
    .map((project) => ({ id: String(project.id ?? ''), name: typeof project.name === 'string' ? project.name : '', path: project.path }));

// Cancellable: turning the setting off, signing out, sleep or quit during the
// preparation (PATH, CLI install, CLI sign-in) means no runner is spawned.
const startDeployRunner = (input) =>
  startBundledDeployRunner(input, {
    hasCli: () => Boolean(bundledCliEntry()),
    preparePath: () => shellPathSyncPromise,
    installCli: () => installBundledCli(),
    signInCli: () => signInBundledCli(),
    isSignedIn: async () => !durangoMock && (await isDispatchSignedIn()),
    runCli: (args, { cwd }) => runBundledCli(args, { cwd, timeout: 60_000 }),
    cliError: bundledCliError,
  });

const deployNotifications = new Set();
const notifyDeployStarted = ({ name, targets, log }) => {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: `Deploying ${name} on this Mac`,
    body: `${targets.join(', ')}: landed elsewhere, deploying with this Mac's logins.${log ? ' Click for the log.' : ''}`,
  });
  deployNotifications.add(notification);
  const forget = () => deployNotifications.delete(notification);
  notification.on('click', () => {
    forget();
    if (log) void shell.openPath(log);
  });
  notification.on('close', forget);
  notification.show();
};

const deployWatcher = createDeployWatcher({
  fetchDeploys: createSourceDeploysFetcher({
    readSession: () => readAccountSession(),
    baseUrl: () => getDurangoWebUrl().toString(),
  }),
  fetchConfig: createSourceConfigFetcher({
    readSession: () => readAccountSession(),
    baseUrl: () => getDurangoWebUrl().toString(),
  }),
  startRunner: startDeployRunner,
  isSignedIn: async () => !durangoMock && (await isDispatchSignedIn()),
  isOnline: () => net.isOnline(),
  notify: notifyDeployStarted,
  onStateChange: (state) => sendToAllWindows('durango:deployWatcherState', state),
});

let dispatchConfigureSeq = 0;
const configureDurango = async (input) => {
  const seq = ++dispatchConfigureSeq;
  if (typeof input?.useDurangoTasks === 'boolean') useDurangoTasksSetting = input.useDurangoTasks;
  const settings = normalizeDispatchSettings(input?.dispatch);
  configuredProjects = Array.isArray(input?.projects) ? input.projects : [];
  botMachineInfoCache = null;
  // The deploy watcher reads each project's link and durango.toml itself,
  // and only while it is on.
  const deploySettings = normalizeDeployWatcherSettings(input?.deployWatcher);
  deployWatcher.configure({ settings: deploySettings, projects: deployWatcherProjects(input?.projects) });
  // Resolve repo ids only when they matter (the worker is on).
  const projects = settings.enabled ? await dispatchProjectsWithRepoIds(input?.projects) : [];
  if (seq !== dispatchConfigureSeq) return { ok: true, superseded: true };
  dispatchWorker.configure({ settings, projects });
  // Bots have their own switch and access level (not the dispatch opt-in);
  // the projects they see are the ones allowed for Durango.
  const botSettings = normalizeBotSettings(input?.bots);
  botReplyWorker.configure({ settings: botSettings });
  localBotsAccessMode = botSettings.accessMode;
  botAllowedProjectIds = settings.allowedProjectIds;
  return { ok: true, state: dispatchWorker.getState(), deployWatcherState: deployWatcher.getState() };
};

ipcMain.handle('durango:configure', (_event, input) => configureDurango(input));
ipcMain.handle('durango:dispatchState', () => dispatchWorker.getState());
ipcMain.handle('durango:deployWatcherState', () => deployWatcher.getState());
ipcMain.handle('durango:openDeployLog', async (_event, input) => {
  // Only logs the watcher itself reported (the runner's log under ~/.durango/deploys/logs).
  const log = typeof input?.log === 'string' ? input.log : '';
  if (!log || !deployWatcher.getState().repos.some((repo) => repo.log === log)) return { ok: false, error: 'Unknown log.' };
  const error = await shell.openPath(log);
  return error ? { ok: false, error } : { ok: true };
});
// What a bot task's report carries besides the thread's own words: the thread
// and the change its workspace holds, so the bot (and its thread view) can put
// Open thread / View change / Ship buttons on it without guessing ids.
const botTaskReportRefs = async ({ threadId, workspacePath }) => {
  const lines = [];
  if (typeof threadId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(threadId)) lines.push(`Thread: @thread:${threadId}`);
  if (isPathInput(workspacePath)) {
    const status = await durangoWorkspaceStatus({ path: workspacePath, remote: true }).catch(() => null);
    const change = status?.ok ? status.change : null;
    if (change?.changeId) {
      lines.push(`Change: ${change.changeId}${change.status ? ` (${change.status})` : ''}${change.url ? ` ${change.url}` : ''}`);
    }
    lines.push(`Workspace: ${workspacePath}`);
  }
  return lines.length ? `\n\n---\n${lines.join('\n')}` : '';
};

const withReportRefs = async (input) => {
  const summary = typeof input?.summary === 'string' ? input.summary : undefined;
  if (input?.outcome !== 'finished') return summary;
  const refs = await botTaskReportRefs({ threadId: input?.threadId, workspacePath: input?.workspacePath }).catch(() => '');
  // The thread's words are clipped first, so the refs (and the thread footer
  // reportBotTaskThread adds after them, within its 10,000-character clip) survive.
  return refs ? `${(summary?.trim() || 'The thread finished without a written summary.').slice(0, 9_000)}${refs}` : summary;
};

// The renderer saw a dispatched thread settle (finished / failed / stopped).
// `waiting`: the turn ended but the thread still waits on background work (or
// on the person), so it isn't done. `seq`: the report's sequence number (two
// per agent run, odd while waiting); each later report of the dispatch has a higher one.
const dispatchWaiting = (input) =>
  input?.outcome === 'finished' && Array.isArray(input?.waiting)
    ? input.waiting.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim().slice(0, 200)).slice(0, 6)
    : [];
const dispatchSeq = (input) => (Number.isSafeInteger(input?.seq) && input.seq > 0 ? input.seq : undefined);
ipcMain.handle('durango:dispatchSettled', async (_event, input) =>
  typeof input?.dispatchId === 'string' && input.dispatchId.startsWith(BOT_TASK_DISPATCH_PREFIX)
    ? reportBotTaskThread({
        taskId: input.dispatchId.slice(BOT_TASK_DISPATCH_PREFIX.length),
        threadId: typeof input?.threadId === 'string' ? input.threadId : undefined,
        outcome: input?.outcome === 'finished' ? 'finished' : 'failed',
        summary: await withReportRefs(input),
        error: typeof input?.error === 'string' ? input.error : undefined,
        waiting: dispatchWaiting(input),
        seq: dispatchSeq(input),
      })
    : typeof input?.dispatchId === 'string' && input.dispatchId.startsWith(LOCAL_BOT_DISPATCH_PREFIX)
    ? localBots.threadSettled({
        key: input.dispatchId.slice(LOCAL_BOT_DISPATCH_PREFIX.length),
        threadId: typeof input?.threadId === 'string' ? input.threadId : undefined,
        outcome: input?.outcome === 'finished' ? 'finished' : 'failed',
        summary: await withReportRefs(input),
        error: typeof input?.error === 'string' ? input.error : undefined,
        waiting: dispatchWaiting(input),
        seq: dispatchSeq(input),
      })
    : dispatchWorker.settle({
    dispatchId: typeof input?.dispatchId === 'string' ? input.dispatchId : '',
    threadId: typeof input?.threadId === 'string' ? input.threadId : undefined,
    outcome: input?.outcome === 'finished' ? 'finished' : 'failed',
    summary: typeof input?.summary === 'string' ? input.summary : undefined,
    error: typeof input?.error === 'string' ? input.error : undefined,
    waiting: dispatchWaiting(input),
    seq: dispatchSeq(input),
  })
);

// A thread a bot started still runs but needs the person (`kind: 'input'`) or
// looks stuck (`'stuck'`, startDurangoDispatchNotices in app/durangoDispatch.ts): its bot hears it now
// instead of only when the turn ends. Same three routes as dispatchSettled.
// `seq` is the live run's final report number: a notice that arrives after
// that report is dropped. Each route tries once and says `{ retry: true }` when
// it didn't get through; the renderer sends it again only if it still holds,
// so a notice for a request the person answered meanwhile is never resent.
const sendBotTaskNotice = async ({ taskId, threadId, kind, key, seq, detail }) => {
  const machineId = await getDurangoDeviceId().catch(() => null);
  if (!machineId || !taskId) return { ok: false, retry: true };
  const thread = threadId ? { threadId, machine: await getDispatchMachineName().catch(() => null), cloud: true } : null;
  const text = String(detail ?? '').trim().slice(0, 3_000);
  const notice = { kind, key, seq, detail: thread ? withThreadReportFooter(text, thread) : text };
  try {
    return await durangoClient.noticeBotTask({ taskId, machineId, notice });
  } catch (failure) {
    console.warn('[durango bots] a bot task notice failed:', failure?.message ?? failure);
    // 4xx (a Durango without notices answers 404): final.
    if (failure instanceof DurangoError && failure.code === 'api' && failure.status && failure.status < 500) return { ok: false };
    return { ok: false, retry: true };
  }
};
ipcMain.handle('durango:dispatchNotice', async (_event, input) => {
  const dispatchId = typeof input?.dispatchId === 'string' ? input.dispatchId : '';
  const threadId = typeof input?.threadId === 'string' ? input.threadId : undefined;
  const kind = input?.kind === 'input' || input?.kind === 'stuck' ? input.kind : null;
  const key = typeof input?.key === 'string' ? input.key.trim().slice(0, 120) : '';
  const seq = dispatchSeq(input);
  const detail = typeof input?.detail === 'string' ? input.detail : '';
  if (!dispatchId || !kind || !key || seq === undefined) return { ok: false };
  if (dispatchId.startsWith(BOT_TASK_DISPATCH_PREFIX)) {
    return sendBotTaskNotice({ taskId: dispatchId.slice(BOT_TASK_DISPATCH_PREFIX.length), threadId, kind, key, seq, detail });
  }
  if (dispatchId.startsWith(LOCAL_BOT_DISPATCH_PREFIX)) {
    return localBots.threadNotice({ key: dispatchId.slice(LOCAL_BOT_DISPATCH_PREFIX.length), threadId, kind, noticeKey: key, seq, detail });
  }
  return dispatchWorker.notice({ dispatchId, threadId, kind, key, seq, detail });
});

ipcMain.handle('app:openExternalUrl', async (_event, url) => {
  try {
    const externalUrl = externalWebUrl(url);
    if (!externalUrl) return { ok: false, error: 'Only web URLs can be opened.' };
    await shell.openExternal(externalUrl);
    return { ok: true };
  } catch {
    return { ok: false, error: 'Invalid URL.' };
  }
});

// Clicking a thread-finished notification lands here: surface the window
// even if it's minimized or behind another app.
ipcMain.handle('app:isWindowFocused', (event) => BrowserWindow.fromWebContents(event.sender)?.isFocused() ?? true);
ipcMain.handle('app:focusWindow', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
  return true;
});

// Computer use (codex's computer-use plugin and similar) needs macOS TCC
// grants — Accessibility, Screen Recording, Automation. TCC attributes child
// processes to their responsible process, so granting Orion covers every CLI
// it spawns. There is no API to query Automation without prompting, so its
// status is always reported as 'unknown'.
const computerUseSettingsPanes = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
};

// Automation state can only be learned by sending a real Apple Event: macOS
// prompts on the first-ever send, then answers silently (success or -1743)
// once the (Orion → System Events) pair is determined. So we remember on disk
// that the user requested it once, and only probe after that — the tab never
// pops the system prompt on its own.
const computerUseStateFile = () => path.join(app.getPath('userData'), 'computer-use.json');
const automationProbeCommand = `osascript -e 'tell application id "com.apple.systemevents" to count processes'`;
let automationRequestedCache = null;
let automationProbe = { checkedAt: 0, status: 'unknown' };

const readAutomationRequested = async () => {
  // Only a positive result is cached: markAutomationRequested() sets it in
  // this process, and a missing file is re-read so it stays cheap but correct.
  if (automationRequestedCache !== true) {
    try {
      automationRequestedCache = Boolean(JSON.parse(await fs.readFile(computerUseStateFile(), 'utf8'))?.automationRequested);
    } catch {
      automationRequestedCache = false;
    }
  }
  return automationRequestedCache;
};

const markAutomationRequested = async () => {
  automationRequestedCache = true;
  try {
    await fs.writeFile(computerUseStateFile(), JSON.stringify({ automationRequested: true }));
  } catch {
    // best effort; worst case the row falls back to 'Request access'
  }
};

const probeAutomationStatus = async (timeout = 5000) => {
  if (Date.now() - automationProbe.checkedAt < 15000) return automationProbe.status;
  let status;
  try {
    await runShellCommand(automationProbeCommand, timeout);
    status = 'granted';
  } catch {
    status = 'denied';
  }
  automationProbe = { checkedAt: Date.now(), status };
  return status;
};

// Chrome's remote-debugging server (the chrome://inspect/#remote-debugging
// toggle, Chrome 144+) writes DevToolsActivePort into the profile root while
// it runs. chrome-devtools-mcp --autoConnect attaches to that server so Codex
// controls the user's existing signed-in Chrome rather than another profile.
const chromeDebugPortFile = () =>
  path.join(app.getPath('home'), 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort');
const chromeDebugSetupUrl = 'chrome://inspect/#remote-debugging';
let chromeDebugProbe = { checkedAt: 0, result: null };

const getChromeDebugStatus = async () => {
  if (process.platform !== 'darwin') return { status: 'unsupported' };
  if (Date.now() - chromeDebugProbe.checkedAt < 2500 && chromeDebugProbe.result) {
    return chromeDebugProbe.result;
  }
  let result;
  try {
    const port = Number.parseInt((await fs.readFile(chromeDebugPortFile(), 'utf8')).split('\n')[0], 10);
    if (!Number.isInteger(port) || port <= 0) throw new Error('no port');
    result = await new Promise((resolve) => {
      const request = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1500 }, (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve({ status: 'enabled', browser: JSON.parse(body)?.Browser });
          } catch {
            resolve({ status: 'enabled' });
          }
        });
      });
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', () => resolve({ status: 'stale' }));
    });
  } catch {
    result = { status: 'disabled' };
  }
  chromeDebugProbe = { checkedAt: Date.now(), result };
  return result;
};

let codexBrowserIntegrationProbe = { checkedAt: 0, result: null, promise: null };
const getCodexBrowserIntegrationStatus = async () => {
  if (
    codexBrowserIntegrationProbe.result &&
    Date.now() - codexBrowserIntegrationProbe.checkedAt < 15000
  ) {
    return codexBrowserIntegrationProbe.result;
  }
  if (codexBrowserIntegrationProbe.promise) return codexBrowserIntegrationProbe.promise;
  const promise = probeCodexBrowserIntegration(runShellCommand)
    .then((result) => {
      codexBrowserIntegrationProbe = { checkedAt: Date.now(), result, promise: null };
      return result;
    })
    .catch(() => {
      const result = {
        status: 'unavailable',
        ready: false,
        pluginInstalled: false,
        pluginEnabled: false,
        nodeReplEnabled: false,
        browserWorkflowAvailable: false,
        extensionInstalled: null,
        extensionEnabled: null,
        nativeHostReady: null,
        detail:
          'Could not inspect this Codex installation. Use the dedicated MCP browser until Codex browser support is available.',
      };
      codexBrowserIntegrationProbe = { checkedAt: Date.now(), result, promise: null };
      return result;
    });
  codexBrowserIntegrationProbe.promise = promise;
  return promise;
};

const getComputerUsePermissions = async () => {
  const browserUse = { codex: await getCodexBrowserIntegrationStatus() };
  const chromeDebug = await getChromeDebugStatus();
  if (process.platform !== 'darwin') {
    return {
      supported: false,
      accessibility: 'unsupported',
      screenRecording: 'unsupported',
      automation: 'unsupported',
      browserUse,
      chromeDebug,
    };
  }
  return {
    supported: true,
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied',
    screenRecording: systemPreferences.getMediaAccessStatus('screen'),
    automation: (await readAutomationRequested()) ? await probeAutomationStatus() : 'not-determined',
    browserUse,
    chromeDebug,
  };
};

ipcMain.handle('computerUse:getPermissions', async () => getComputerUsePermissions());

// Simulator tools: Settings → Devices and the per-thread device card.
registerDeviceIpc(ipcMain);

ipcMain.handle('computerUse:requestPermission', async (_event, kind) => {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'Computer use permissions only apply on macOS.', state: await getComputerUsePermissions() };
  }
  try {
    if (kind === 'accessibility') {
      // Shows the system dialog and registers Orion in the Accessibility pane
      // (unchecked) so the user has a row to toggle on.
      systemPreferences.isTrustedAccessibilityClient(true);
    } else if (kind === 'screen-recording') {
      // A capture attempt is what registers Orion in the Screen Recording pane
      // and shows the one-time system prompt; the thumbnail is discarded.
      await desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
        .catch(() => {});
    } else if (kind === 'automation') {
      // Trigger the Automation prompt; the long timeout leaves room for the
      // user to answer the dialog so the returned state reflects their choice.
      await markAutomationRequested();
      automationProbe = { checkedAt: 0, status: 'unknown' };
      await probeAutomationStatus(60000);
    } else {
      return { ok: false, error: `Unknown permission: ${kind}`, state: await getComputerUsePermissions() };
    }
    const pane = computerUseSettingsPanes[kind];
    if (pane) await shell.openExternal(pane);
    return { ok: true, state: await getComputerUsePermissions() };
  } catch (error) {
    return { ok: false, error: getProcessErrorMessage(error), state: await getComputerUsePermissions() };
  }
});

// Chrome refuses chrome:// URLs from outside contexts inconsistently, so copy
// the setup URL as a reliable fallback and also ask Chrome to open it.
ipcMain.handle('computerUse:openChromeDebugSetup', async () => {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'Chrome remote-debugging setup is only wired up on macOS.' };
  }
  try {
    clipboard.writeText(chromeDebugSetupUrl);
    await new Promise((resolve, reject) => {
      const child = spawn('open', ['-a', 'Google Chrome', chromeDebugSetupUrl], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error('Could not open Google Chrome. Is it installed?'));
      });
    });
    chromeDebugProbe = { checkedAt: 0, result: null };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: getProcessErrorMessage(error) };
  }
});

// SnapShot (Settings → Computer Use → SnapShot): a capture taken while no
// window is open opens one; never while the app is quitting.
registerSnapShotIpc({ createWindow: () => (appShutdownRequested ? null : createWindow()) });

ipcMain.handle('app:relaunch', () => {
  relaunchApp(app);
  app.exit(0);
  return true;
});

ipcMain.handle('cloud:openInBrowser', async (_event, projectPath) => {
  try {
    if (!projectPath) return { ok: false, error: 'Missing project path.' };
    const gitRoot = await getGitRoot(projectPath);
    const link = await getCloudRepoLink(gitRoot);
    if (!link) return { ok: false, error: 'This repository is not linked to Durango Cloud yet.' };
    await shell.openExternal(cloudRepoWebUrl(link.repoId));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: cloudErrorMessage(error) };
  }
});

const saveAttachment = async (_event, input) => {
  try {
    const mimeType = String(input?.mimeType || '').toLowerCase();
    const originalName = sanitizeAttachmentName(input?.name);
    const data = input?.data;

    if (!data) {
      return { ok: false, error: 'The attachment data is missing.' };
    }

    const id = crypto.randomUUID();
    const attachmentDir = getAttachmentDirectoryPath();
    const buffer = Buffer.from(data);
    await fs.mkdir(attachmentDir, { recursive: true });

    if (isHeicInput(originalName, mimeType)) {
      // Chromium can't render HEIC and the model APIs don't accept it: keep
      // a JPEG copy. If conversion fails, attach the original as a plain file.
      const heicPath = path.join(attachmentDir, `${id}-${originalName}`);
      const jpegPath = path.join(attachmentDir, `${id}-${jpegNameForHeic(originalName)}`);
      await fs.writeFile(heicPath, buffer);
      try {
        await convertHeicToJpeg(heicPath, jpegPath);
        await fs.rm(heicPath, { force: true });
        const { size } = await fs.stat(jpegPath);
        return {
          ok: true,
          attachment: { id, name: originalName, path: jpegPath, mimeType: 'image/jpeg', size },
        };
      } catch (error) {
        console.error('HEIC conversion failed', error);
        await fs.rm(jpegPath, { force: true });
        return {
          ok: true,
          attachment: {
            id,
            name: originalName,
            path: heicPath,
            mimeType: 'application/octet-stream',
            size: buffer.byteLength,
          },
        };
      }
    }

    const safeFileName = `${id}-${ensureMediaExtension(originalName, mimeType)}`;
    const filePath = path.join(attachmentDir, safeFileName);
    await fs.writeFile(filePath, buffer);

    return {
      ok: true,
      attachment: {
        id,
        name: originalName,
        path: filePath,
        mimeType: mimeType || 'application/octet-stream',
        size: buffer.byteLength,
      },
    };
  } catch (e) {
    console.error('saveAttachment error', e);
    return { ok: false, error: e?.message ?? String(e) };
  }
};

ipcMain.handle('attachment:save', saveAttachment);
ipcMain.handle('attachment:saveImage', saveAttachment);

ipcMain.handle('agent:listModels', async (_event, input) => {
  const fresh = input?.force === true;
  if (fresh) invalidateAgentModelsCache();
  return listAgentModelsWithAvailability({ fresh });
});

ipcMain.handle('agent:supportsThreadReader', async (_event, providerId) =>
  providerSupportsThreadReader(providerId)
);

// A turn on another machine that @-mentions threads that machine can't read
// (this machine's own, or a third machine's): read_thread's newest page of
// each goes along as context (startRemoteTurn in App.tsx).
ipcMain.handle('agent:readThreadsForMention', async (_event, input) => {
  const threadIds = (Array.isArray(input?.threadIds) ? input.threadIds : [])
    .filter((id) => typeof id === 'string' && id)
    .slice(0, 8);
  return Promise.all(
    threadIds.map(async (threadId) => ({ threadId, text: await readThreadForAgent({ thread_id: threadId }) }))
  );
});

const antigravityLiveSlashCommandsByProject = new Map(); // projectPath -> SlashCommandInfo[]
const ANTIGRAVITY_FALLBACK_SLASH_COMMANDS = [
  { name: 'compact', description: 'Compact conversation history to free context window', argumentHint: '' },
  { name: 'goal', description: 'Run a long-horizon goal autonomously', argumentHint: '<objective>' },
  { name: 'plan', description: 'Plan carefully before executing', argumentHint: '' },
];

ipcMain.handle('agent:listSlashCommands', async (event, input) => {
  const projectPath = typeof input?.projectPath === 'string' ? input.projectPath : null;
  if (input?.providerId === 'antigravity') {
    const live = projectPath ? antigravityLiveSlashCommandsByProject.get(projectPath) ?? [] : [];
    const skills = await discoverAntigravitySkills({ cwd: projectPath }).catch(() => []);
    const base = live.length > 0 ? live : ANTIGRAVITY_FALLBACK_SLASH_COMMANDS;
    const commands = mergeAntigravitySlashCommands(base, skills);
    return {
      ok: true,
      commands,
      source: live.length > 0 ? 'live' : 'cache',
    };
  }
  return listClaudeSlashCommands({
    sender: event.sender,
    threadId: typeof input?.threadId === 'string' ? input.threadId : null,
    projectPath,
  });
});

// `/clear` in the composer: tear down only the thread's persistent Claude SDK
// session (not the terminal PTY / goal ops that full thread disposal reaps),
// so the next turn starts a fresh conversation.
ipcMain.handle('agent:clearClaudeSession', (_event, threadId) =>
  typeof threadId === 'string' && threadId ? disposeClaudeSdkSession(threadId) : false
);

ipcMain.handle('providers:getStatus', async () => getProviderStatuses());

ipcMain.handle('providers:checkUpdates', async (_event, input) => checkProviderUpdates(input));

ipcMain.handle('providers:getActiveUpdate', () =>
  activeProviderUpdate?.lastProgress ?? lastProviderUpdateProgress
);

ipcMain.handle('providers:cancelUpdate', (_event, operationId) => {
  const cancelled = cancelActiveProviderUpdate(
    typeof operationId === 'string' ? operationId : null
  );
  return cancelled
    ? { ok: true }
    : { ok: false, error: 'That provider update is no longer running.' };
});

ipcMain.handle('providers:updateAll', async (_event, input = {}) => {
  if (activeProviderUpdate) {
    return {
      ok: false,
      busy: true,
      operationId: activeProviderUpdate.id,
      error: 'Provider updates are already running.',
      results: [],
      state: await checkProviderUpdates(input),
    };
  }

  const operationId = crypto.randomUUID();
  const operation = {
    id: operationId,
    controller: new AbortController(),
    promise: null,
    lastProgress: {
      operationId,
      status: 'running',
      phase: 'checking',
      message: 'Checking provider updates…',
      output: '',
      providerId: null,
      providerLabel: null,
      current: 0,
      total: 0,
      percent: null,
      updatedAt: new Date().toISOString(),
    },
  };
  activeProviderUpdate = operation;

  const run = async () => {
    const enabledProviderIds = normalizeEnabledProviderIds(input);
    const results = [];
    publishProviderUpdateProgress(operation, {
      status: 'running',
      phase: 'checking',
      message: 'Checking provider updates…',
      output: '',
      providerId: null,
      providerLabel: null,
      current: 0,
      total: 0,
      percent: null,
    });

    const checkedState = await checkProviderUpdates(input);
    const stateById = new Map(checkedState.providers.map((provider) => [provider.id, provider]));
    const updateConfigs = providerUpdaterConfigs.filter(
      (config) => stateById.get(config.id)?.updateAvailable === true
    );
    let completedUpdates = 0;

    publishProviderUpdateProgress(operation, {
      phase: updateConfigs.length > 0 ? 'starting' : 'complete',
      message:
        updateConfigs.length > 0
          ? `Preparing ${updateConfigs.length} provider update${updateConfigs.length === 1 ? '' : 's'}…`
          : 'Provider CLIs are already up to date.',
      total: updateConfigs.length,
    });

    for (const config of providerUpdaterConfigs) {
      if (operation.controller.signal.aborted) break;

      if (enabledProviderIds && !enabledProviderIds.has(config.id)) {
        results.push({
          id: config.id,
          label: config.label,
          command: config.command,
          ok: true,
          skipped: true,
          message: `${config.label} is disabled.`,
        });
        continue;
      }

      const providerState = stateById.get(config.id);
      if (!providerState?.updateAvailable) {
        results.push({
          id: config.id,
          label: config.label,
          command: config.command,
          ok: true,
          skipped: true,
          message: `${config.label} has no available update.`,
        });
        continue;
      }

      let progressOutput = '';
      let phase = 'updating';
      let lastOutputPublishAt = 0;
      const publishCurrentProvider = (
        message,
        percent = null,
        cleanOutput = cleanProviderUpdateOutput(progressOutput)
      ) =>
        publishProviderUpdateProgress(operation, {
          status: operation.controller.signal.aborted ? 'cancelling' : 'running',
          phase,
          providerId: config.id,
          providerLabel: config.label,
          message,
          output: cleanOutput,
          current: completedUpdates,
          total: updateConfigs.length,
          percent,
        });

      publishCurrentProvider(`Updating ${config.label}…`);
      const result = await updateProviderTool(config, providerState.latestVersion, {
        signal: operation.controller.signal,
        onPhase: (nextPhase) => {
          phase = nextPhase;
          const message =
            nextPhase === 'verifying'
              ? `Verifying ${config.label}…`
              : nextPhase === 'installing'
                ? `Installing ${config.label}…`
                : `Updating ${config.label}…`;
          publishCurrentProvider(message);
        },
        onOutput: ({ chunk }) => {
          progressOutput = providerUpdateOutputTail(progressOutput, chunk);
          const now = Date.now();
          if (now - lastOutputPublishAt < PROVIDER_UPDATE_PROGRESS_INTERVAL_MS) return;
          lastOutputPublishAt = now;
          const cleanOutput = cleanProviderUpdateOutput(progressOutput);
          if (/download(?:ing)?|fetching/i.test(cleanOutput)) phase = 'downloading';
          publishCurrentProvider(
            providerUpdateProgressMessage(cleanOutput, `Updating ${config.label}…`),
            providerUpdatePercent(cleanOutput),
            cleanOutput
          );
        },
      });
      results.push(result);

      if (result.cancelled) {
        publishProviderUpdateProgress(operation, {
          status: 'cancelled',
          phase: 'cancelled',
          message: `${config.label} update cancelled.`,
          output: cleanProviderUpdateOutput(result.output || progressOutput),
          percent: null,
        });
        break;
      }

      completedUpdates += 1;
      publishProviderUpdateProgress(operation, {
        status: 'running',
        phase: result.ok ? 'complete' : 'error',
        message: result.ok
          ? `${config.label} updated successfully.`
          : (result.error ?? `${config.label} update failed.`),
        output: cleanProviderUpdateOutput(result.output || progressOutput),
        current: completedUpdates,
        percent: result.ok ? 100 : null,
      });
    }

    const cancelled = operation.controller.signal.aborted || results.some((result) => result.cancelled);
    invalidateAgentModelsCache();
    const state = cancelled ? checkedState : await checkProviderUpdates(input);
    const failed = results.filter((result) => !result.ok && !result.cancelled);
    const response = {
      ok: !cancelled && failed.length === 0,
      cancelled,
      operationId: operation.id,
      results,
      state,
      ...(failed.length > 0
        ? { error: failed.map((result) => result.error).filter(Boolean).join('\n') }
        : {}),
    };

    publishProviderUpdateProgress(operation, {
      status: cancelled ? 'cancelled' : failed.length > 0 ? 'failed' : 'completed',
      phase: cancelled ? 'cancelled' : failed.length > 0 ? 'error' : 'complete',
      message: cancelled
        ? 'Provider updates cancelled.'
        : failed.length > 0
          ? (response.error || 'Some provider updates failed.')
          : updateConfigs.length > 0
            ? 'Provider CLIs updated.'
            : 'Provider CLIs are already up to date.',
      current: completedUpdates,
      total: updateConfigs.length,
      percent: cancelled || failed.length > 0 ? null : 100,
    });
    return response;
  };

  operation.promise = run().catch((error) => {
    publishProviderUpdateProgress(operation, {
      status: operation.controller.signal.aborted ? 'cancelled' : 'failed',
      phase: operation.controller.signal.aborted ? 'cancelled' : 'error',
      message: operation.controller.signal.aborted
        ? 'Provider updates cancelled.'
        : getProcessErrorMessage(error),
      percent: null,
    });
    throw error;
  });
  try {
    return await operation.promise;
  } finally {
    if (activeProviderUpdate === operation) activeProviderUpdate = null;
  }
});

ipcMain.handle('providers:authenticate', async (event, providerId) => {
  const { result, completion } = await authenticateProviderTool(providerId);
  // Antigravity's sign-in waits for a code the user pastes from the page
  // this link lands on (submitAuthCode below).
  if (result?.ok && result.codeRequired && result.url) {
    void shell.openExternal(result.url).catch(() => {});
  }
  if (result?.ok) {
    invalidateAgentModelsCache();
    const sender = event.sender;
    const generation = (providerAuthenticationGenerations.get(providerId) ?? 0) + 1;
    providerAuthenticationGenerations.set(providerId, generation);
    void waitForProviderAuthentication(providerId, completion).then((authenticated) => {
      if (providerAuthenticationGenerations.get(providerId) !== generation) return;
      providerAuthenticationGenerations.delete(providerId);
      if (!authenticated) return;
      invalidateAgentModelsCache();
      if (!sender.isDestroyed()) {
        sender.send('providers:authenticated', { providerId });
      }
    });
  }
  return result;
});

ipcMain.handle('providers:submitAuthCode', async (_event, input) => {
  if (input?.providerId !== 'antigravity') return { ok: false, error: 'This provider takes no sign-in code.' };
  const result = await submitAntigravityLoginCode(input?.code);
  if (result.ok) invalidateAgentModelsCache();
  return result;
});

ipcMain.handle('providers:cancelAuth', (_event, providerId) =>
  providerId === 'antigravity' ? cancelAntigravityLogin() : { ok: true }
);

// fx connections (Settings → Providers → fx): subscription logins run fx's
// own browser sign-in, detached like other provider logins.
const fxLoginTargets = new Set(['codex', 'grok', 'vercel']);
ipcMain.handle('fx:getConnections', async () => {
  try {
    return { ok: true, connections: await readFxConnections() };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
});
ipcMain.handle('fx:install', async (event) => {
  const result = await installFx();
  if (result.ok) {
    invalidateAgentModelsCache();
    if (!event.sender.isDestroyed()) event.sender.send('providers:authenticated', { providerId: 'fx' });
  }
  return result;
});
ipcMain.handle('fx:connect', async (event, target) => {
  if (!fxLoginTargets.has(target)) return { ok: false, error: `Unknown fx connection: ${target}` };
  try {
    const child = spawn(loginShell, ['-lc', `fx login ${target}`], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', FX_AUTO_UPGRADE: '0' },
    });
    const sender = event.sender;
    child.once('exit', (code) => {
      if (code !== 0) return;
      invalidateAgentModelsCache();
      if (!sender.isDestroyed()) sender.send('providers:authenticated', { providerId: 'fx' });
    });
    child.once('error', () => {});
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
});
ipcMain.handle('fx:disconnect', async (_event, target) => {
  if (!fxLoginTargets.has(target)) return { ok: false, error: `Unknown fx connection: ${target}` };
  try {
    await runShellCommand(`fx logout ${target} </dev/null`, 15000, { FX_AUTO_UPGRADE: '0' });
    invalidateAgentModelsCache();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: getProcessErrorMessage(error) };
  }
});
ipcMain.handle('fx:setGatewayApiKey', async (_event, key) => {
  const value = typeof key === 'string' ? key.trim() : '';
  if (value && (value.length > 512 || /\s/.test(value))) {
    return { ok: false, error: 'That does not look like an AI Gateway API key.' };
  }
  try {
    await writeFxGatewayApiKey(value || null);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
});

ipcMain.handle('account:getSession', async () => verifyAccountSession());

ipcMain.handle('account:startAuth', async () => {
  try {
    return await startDesktopAuth();
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
});

// Durango Chat for the renderer (@chat mentions, profile memory). The key
// never crosses into the renderer; only results and typed errors do.
ipcMain.handle('durango:searchChats', async (_event, input) => {
  try {
    const query = typeof input?.query === 'string' ? input.query.slice(0, 200) : '';
    const result = await durangoClient.searchChats(query, {
      limit: input?.limit,
      cursor: typeof input?.cursor === 'string' ? input.cursor : undefined,
    });
    return { ok: true, ...result };
  } catch (error) {
    return durangoIpcError(error);
  }
});

// Bots (Sidebar v3): the person's Durango bots, read and messaged with this
// app's Durango sign-in. Replies may run on this machine (src/main/bot-replies.js).
// Signed out, the bots are this device's own (local-bots.js), answered by this
// machine's Claude Code.
const LOCAL_BOTS_CLAUDE_UNAVAILABLE =
  'Local bots run on Claude Code: install it and sign in to Claude to use bots without a Durango account.';
const localBotsMode = async () => {
  if (await isDispatchSignedIn()) return false;
  localBots.setActive(true);
  return true;
};
const localBotsIpcError = (error) => ({
  ok: false,
  ...(typeof error?.code === 'string' ? { code: error.code } : {}),
  error: error?.message ?? String(error),
});

ipcMain.handle('bots:mode', async () => ({
  mode: (await isDispatchSignedIn()) ? 'durango' : 'local',
  claudeAvailable: await botRepliesAvailable().catch(() => false),
  // Signed in: whether this machine takes bot replies (the dispatch opt-in).
  machineReplies: botReplyWorker.getState().enabled,
}));

ipcMain.handle('bots:list', async () => {
  if (await localBotsMode()) {
    if (!(await botRepliesAvailable().catch(() => false))) {
      return { ok: false, code: 'claude_unavailable', error: LOCAL_BOTS_CLAUDE_UNAVAILABLE };
    }
    try {
      return { ok: true, ...(await localBots.list()), projectKeys: await botProjectKeys({ local: true }), account: 'local' };
    } catch (error) {
      return localBotsIpcError(error);
    }
  }
  try {
    // Which account this list is for (no secret: a hash), so the Bots view
    // drops what it kept for another account.
    const before = await durangoAccountKey();
    const list = await durangoClient.listBots();
    const after = await durangoAccountKey();
    if (!before || before !== after) return { ok: false, code: 'account_changed', error: 'The Durango account changed. Try again.' };
    const account = crypto.createHash('sha256').update(before).digest('hex').slice(0, 16);
    return { ok: true, ...list, projectKeys: await botProjectKeys({ local: false }), account };
  } catch (error) {
    return durangoIpcError(error);
  }
});

// The person picks a bot's reply model and/or reasoning effort (Bots view header).
// Only the setting changes: a reply already running finishes on its model, the next
// one runs on the new one (chat/docs/bots.md → "Switching a bot's model").
ipcMain.handle('bots:setModel', async (_event, input) => {
  const botId = typeof input?.botId === 'string' ? input.botId : '';
  const model = typeof input?.model === 'string' && input.model.trim() ? input.model.trim() : '';
  const reasoningEffort =
    input?.reasoningEffort === null
      ? null
      : typeof input?.reasoningEffort === 'string' && input.reasoningEffort.trim()
        ? input.reasoningEffort.trim()
        : undefined;
  if (!botId || (!model && reasoningEffort === undefined)) return { ok: false, error: 'Pick a model or reasoning level.' };
  if (await localBotsMode()) {
    try {
      return { ok: true, bot: await localBots.setModel(botId, model || null, reasoningEffort) };
    } catch (error) {
      return localBotsIpcError(error);
    }
  }
  try {
    const result = await durangoClient.setBotModel(botId, model || undefined, reasoningEffort);
    return {
      ok: true,
      ...(result.model ? { model: result.model } : {}),
      ...(result.reasoningEffort !== undefined ? { reasoningEffort: result.reasoningEffort } : {}),
      ...(result.bot ? { bot: result.bot } : {}),
    };
  } catch (error) {
    return durangoIpcError(error);
  }
});

ipcMain.handle('bots:rename', async (_event, input) => {
  const botId = typeof input?.botId === 'string' ? input.botId : '';
  const name = typeof input?.name === 'string' ? input.name : '';
  if (!botId || !name.trim()) return { ok: false, error: 'Enter a name for the bot.' };
  if (await localBotsMode()) {
    try {
      return { ok: true, bot: await localBots.rename(botId, name) };
    } catch (error) {
      return localBotsIpcError(error);
    }
  }
  try {
    const result = await durangoClient.renameBot(botId, name);
    return { ok: true, name: result.name, ...(result.bot ? { bot: result.bot } : {}) };
  } catch (error) {
    return durangoIpcError(error);
  }
});

ipcMain.handle('bots:delete', async (_event, input) => {
  const botId = typeof input?.botId === 'string' ? input.botId : '';
  if (!botId) return { ok: false, error: 'Bot not found.' };
  if (await localBotsMode()) {
    try {
      await localBots.deleteBot(botId);
      await botSessions.forgetBot(botId).catch(() => {});
      return { ok: true };
    } catch (error) {
      return localBotsIpcError(error);
    }
  }
  try {
    await durangoClient.deleteBot(botId);
    await botSessions.forgetBot(botId).catch(() => {});
    return { ok: true };
  } catch (error) {
    return durangoIpcError(error);
  }
});

ipcMain.handle('bots:clear', async (_event, input) => {
  const botId = typeof input?.botId === 'string' ? input.botId : '';
  if (!botId) return { ok: false, error: 'Bot not found.' };
  if (await localBotsMode()) {
    try {
      const bot = await localBots.clear(botId);
      await botSessions.forgetBot(botId).catch(() => {});
      return { ok: true, bot };
    } catch (error) {
      return localBotsIpcError(error);
    }
  }
  try {
    const result = await durangoClient.clearBot(botId);
    await botSessions.forgetBot(botId).catch(() => {});
    return { ok: true, ...(result.bot ? { bot: result.bot } : {}) };
  } catch (error) {
    return durangoIpcError(error);
  }
});

// Each Durango Code project's key (convex/botPolicy.ts projectKeyFor): its
// Source repository when it has one, else this machine's project. Sidebar v3
// finds a project's bot by it.
// Repo links read from git config, kept a minute (bot claims ask every poll).
const botRepoIds = new Map(); // path -> { repoId, at }
const botRepoIdOf = async (projectPath) => {
  if (!projectPath) return null;
  const cached = botRepoIds.get(projectPath);
  if (cached && Date.now() - cached.at < 60_000) return cached.repoId;
  const repoId = (await getCloudRepoLink(projectPath).catch(() => null))?.repoId ?? null;
  botRepoIds.set(projectPath, { repoId, at: Date.now() });
  return repoId;
};
const botProjectIdentity = async (project, { local }) => {
  const repoId = await botRepoIdOf(project.path);
  const machineId = local ? LOCAL_BOTS_MACHINE : await getDurangoDeviceId().catch(() => null);
  return { repoId, machineId, key: localProjectKey({ repoId, machineId, projectId: project.id }) };
};
// The projects bots may use, each with its repo id and Durango key.
const botProjectsWithKeys = async ({ local }) =>
  Promise.all(botProjects().map(async (project) => ({ ...project, ...(await botProjectIdentity(project, { local })) })));
const botProjectKeys = async ({ local }) => {
  const out = {};
  for (const project of configuredProjects) {
    if (typeof project?.id !== 'string') continue;
    const identity = await botProjectIdentity(project, { local });
    if (identity.key) out[project.id] = identity.key;
  }
  return out;
};

// A project's bot, created the first time the project is opened in Sidebar v3.
ipcMain.handle('bots:ensureProjectBot', async (_event, input) => {
  const projectId = typeof input?.projectId === 'string' ? input.projectId : '';
  const project = configuredProjects.find((candidate) => candidate?.id === projectId);
  if (!project) return { ok: false, error: 'That project is not open in Durango Code.' };
  const local = await localBotsMode();
  try {
    const identity = await botProjectIdentity(project, { local });
    if (local) {
      return { ok: true, bot: await localBots.ensureProjectBot({ name: project.name, projectId: project.id, repoId: identity.repoId, machineId: LOCAL_BOTS_MACHINE }) };
    }
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const bot = await durangoClient.ensureProjectBot({
      name: project.name,
      ...(identity.repoId ? { repoId: identity.repoId } : { machineId: identity.machineId, projectId: project.id }),
      ...(timeZone ? { timeZone } : {}),
    });
    // The account has a bot now: a machine waiting out an idle period answers it.
    botReplyWorker.wake();
    return { ok: true, bot };
  } catch (error) {
    return local ? localBotsIpcError(error) : durangoIpcError(error);
  }
});

// Creates an additional bot in a project (a project open here, or a remote project by key/repoId).
ipcMain.handle('bots:createProjectBot', async (_event, input) => {
  const projectId = typeof input?.projectId === 'string' ? input.projectId : '';
  const remoteProject = input?.project && typeof input.project === 'object' ? input.project : null;
  const botName = typeof input?.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 40) : undefined;
  const job = typeof input?.job === 'string' && input.job.trim() ? input.job.trim().slice(0, 8_000) : undefined;
  const emoji = typeof input?.emoji === 'string' && input.emoji.trim() ? input.emoji.trim().slice(0, 8) : undefined;
  const model = typeof input?.model === 'string' && input.model.trim() ? input.model.trim().slice(0, 80) : undefined;
  const project = projectId ? configuredProjects.find((candidate) => candidate?.id === projectId) : null;
  if (!project && !remoteProject) return { ok: false, error: 'That project is not available.' };
  const local = await localBotsMode();
  try {
    if (project) {
      const identity = await botProjectIdentity(project, { local });
      if (local) {
        return {
          ok: true,
          bot: await localBots.createProjectBot({
            name: project.name,
            projectId: project.id,
            repoId: identity.repoId,
            machineId: LOCAL_BOTS_MACHINE,
            botName,
            job,
            emoji,
            model,
          }),
        };
      }
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const bot = await durangoClient.createProjectBot({
        name: project.name,
        ...(identity.repoId ? { repoId: identity.repoId } : { machineId: identity.machineId, projectId: project.id }),
        ...(botName ? { botName } : {}),
        ...(job ? { job } : {}),
        ...(emoji ? { emoji } : {}),
        ...(model ? { model } : {}),
        ...(timeZone ? { timeZone } : {}),
      });
      botReplyWorker.wake();
      return { ok: true, bot };
    }
    const remoteName = typeof remoteProject?.name === 'string' ? remoteProject.name.trim() : '';
    const remoteKey = typeof remoteProject?.key === 'string' ? remoteProject.key.trim() : '';
    const remoteRepoId = typeof remoteProject?.repoId === 'string' && remoteProject.repoId.trim() ? remoteProject.repoId.trim() : null;
    if (!remoteName || (!remoteKey && !remoteRepoId)) return { ok: false, error: 'Missing project details.' };
    if (local) {
      let localProjectId = null;
      let machineId = LOCAL_BOTS_MACHINE;
      if (remoteKey.startsWith('local:')) {
        const rest = remoteKey.slice(6);
        const colon = rest.indexOf(':');
        if (colon > 0 && colon < rest.length - 1) {
          machineId = rest.slice(0, colon);
          localProjectId = rest.slice(colon + 1);
        }
      }
      return {
        ok: true,
        bot: await localBots.createProjectBot({
          name: remoteName,
          projectId: localProjectId,
          repoId: remoteRepoId,
          machineId,
          botName,
          job,
          emoji,
          model,
        }),
      };
    }
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const bot = await durangoClient.createProjectBot({
      name: remoteName,
      ...(remoteRepoId ? { repoId: remoteRepoId } : { projectKey: remoteKey }),
      ...(botName ? { botName } : {}),
      ...(job ? { job } : {}),
      ...(emoji ? { emoji } : {}),
      ...(model ? { model } : {}),
      ...(timeZone ? { timeZone } : {}),
    });
    botReplyWorker.wake();
    return { ok: true, bot };
  } catch (error) {
    return local ? localBotsIpcError(error) : durangoIpcError(error);
  }
});

// A project's notes and files: by its bot (`botId`), or by the project open
// here (`projectId`), which needs no bot.
const botProjectTarget = async (input, local) => {
  const botId = typeof input?.botId === 'string' ? input.botId.slice(0, 128) : '';
  if (botId) return { botId };
  const projectId = typeof input?.projectId === 'string' ? input.projectId : '';
  const project = configuredProjects.find((candidate) => candidate?.id === projectId);
  if (!project) return null;
  const identity = await botProjectIdentity(project, { local });
  return identity.key ? { project: { key: identity.key, name: project.name } } : null;
};

// project_notes (project-notes-tool.js): a thread's project notes, read when
// the thread asks (not pasted into its prompt). By the thread's project id,
// looked up as the project panel does (bots:project): its folder may be a
// Durango workspace outside the project. Signed in, Durango's notes for the
// project's key, else this device's own, without waking the local bots.
setProjectNotesReader(
  createProjectNotesReader({
    projects: () => configuredProjects,
    isLocal: async () => !(await isDispatchSignedIn()),
    projectTarget: botProjectTarget,
    localProject: (project) => localBots.projectByKey(project),
    remoteProject: (key) => durangoClient.projectMemory(key),
  })
);

ipcMain.handle('bots:project', async (_event, input) => {
  const local = await localBotsMode();
  const target = await botProjectTarget(input, local);
  if (!target) return { ok: false, error: 'Missing bot or project.' };
  try {
    if (local) {
      return { ok: true, project: target.botId ? await localBots.project(target.botId) : await localBots.projectByKey(target.project) };
    }
    return { ok: true, project: target.botId ? await durangoClient.botProject(target.botId) : await durangoClient.projectMemory(target.project.key) };
  } catch (error) {
    return local ? localBotsIpcError(error) : durangoIpcError(error);
  }
});

const PROJECT_FILE_MAX_BYTES = 10 * 1024 * 1024;
const PROJECT_FILE_TYPES = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv',
  html: 'text/html', yaml: 'text/yaml', yml: 'text/yaml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', zip: 'application/zip',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
};
const mimeTypeForPath = (filePath) => PROJECT_FILE_TYPES[path.extname(filePath).slice(1).toLowerCase()] ?? 'application/octet-stream';

// Changes a project's notes and files (by `botId` or `projectId`, as bots:project):
// { action: 'add_note', content } | { action: 'delete_note', noteId } |
// { action: 'add_files' } (pick files) | { action: 'add_file_paths', paths } (dropped files) |
// { action: 'delete_file', fileId, name } | { action: 'open_file', name, url? }
ipcMain.handle('bots:projectAction', async (event, input) => {
  const action = typeof input?.action === 'string' ? input.action : '';
  const local = await localBotsMode();
  const target = await botProjectTarget(input, local);
  if (!target || !action) return { ok: false, error: 'Missing bot, project or action.' };
  const { botId, project } = target;
  // Pinned to the account signed in now: if another account signs in while
  // the file picker is open (or during a batch), nothing goes to it.
  const account = local ? null : await durangoAccountKey();
  if (!local && !account) return { ok: false, error: 'Sign in to Durango first.' };
  const pinned = account ? { account } : {};
  // Signed in: the bot's route, or the project's (by key).
  const remote = (body) => (botId ? durangoClient.botProjectAction(botId, body, pinned) : durangoClient.projectMemoryAction(project.key, body, pinned));
  try {
    if (action === 'add_note') {
      const content = typeof input?.content === 'string' ? input.content : '';
      if (local) return { ok: true, ...(botId ? await localBots.addProjectNote(botId, content) : await localBots.addProjectNoteByKey(project, content)) };
      return { ok: true, ...(await remote({ action, content })) };
    }
    if (action === 'delete_note') {
      const noteId = typeof input?.noteId === 'string' ? input.noteId : '';
      return { ok: true, ...(local ? await localBots.deleteProjectNote(noteId) : await remote({ action, noteId })) };
    }
    if (action === 'delete_file') {
      const name = String(input?.name ?? '');
      if (local) return { ok: true, ...(botId ? await localBots.deleteProjectFile(botId, name) : await localBots.deleteProjectFileByKey(project, name)) };
      return { ok: true, ...(await remote({ action, fileId: String(input?.fileId ?? '') })) };
    }
    if (action === 'open_file') {
      if (local) {
        const name = String(input?.name ?? '');
        const filePath = botId ? await localBots.projectFilePath(botId, name) : await localBots.projectFilePathByKey(project, name);
        if (!filePath) return { ok: false, error: 'That file is gone.' };
        const error = await shell.openPath(filePath);
        return error ? { ok: false, error } : { ok: true };
      }
      const url = externalWebUrl(typeof input?.url === 'string' ? input.url : '');
      if (!url) return { ok: false, error: 'That file has no link.' };
      await shell.openExternal(url);
      return { ok: true };
    }
    // Uploads files from this machine: picked in the OS dialog (`add_files`), or
    // dropped on the Library (`add_file_paths`, absolute paths of regular files).
    const addPaths = async (filePaths) => {
      const added = [];
      const errors = [];
      for (const filePath of filePaths.slice(0, 20)) {
        const name = path.basename(filePath);
        try {
          const stat = await fs.stat(filePath);
          if (!stat.isFile()) throw new Error('not a file');
          if (stat.size > PROJECT_FILE_MAX_BYTES) throw new Error('over 10 MB');
          const bytes = await fs.readFile(filePath);
          const contentType = mimeTypeForPath(filePath);
          if (local) {
            if (botId) await localBots.saveProjectFile(botId, { name, bytes, contentType });
            else await localBots.saveProjectFileByKey(project, { name, bytes, contentType });
          } else {
            await uploadBotProjectFile(botId ?? { key: project.key }, { name, bytes, contentType }, pinned);
          }
          added.push(name);
        } catch (error) {
          errors.push(`${name}: ${error?.message ?? error}`);
        }
      }
      return { ok: errors.length === 0, added, ...(errors.length ? { error: errors.join('; ') } : {}) };
    };
    if (action === 'add_files') {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const picked = await dialog.showOpenDialog(window, { title: 'Add files to the project', properties: ['openFile', 'multiSelections'] });
      if (picked.canceled || !picked.filePaths.length) return { ok: true, added: [] };
      return await addPaths(picked.filePaths);
    }
    if (action === 'add_file_paths') {
      const filePaths = (Array.isArray(input?.paths) ? input.paths : [])
        .filter((filePath) => typeof filePath === 'string' && filePath && path.isAbsolute(filePath));
      if (!filePaths.length) return { ok: false, error: 'No files to add.' };
      return await addPaths(filePaths);
    }
    return { ok: false, error: 'Unknown action.' };
  } catch (error) {
    return local ? localBotsIpcError(error) : durangoIpcError(error);
  }
});

ipcMain.handle('bots:thread', async (_event, input) => {
  const botId = typeof input?.botId === 'string' ? input.botId.slice(0, 128) : '';
  if (!botId) return { ok: false, error: 'Missing bot id.' };
  // A page: the newest, the one before `beforeSeq` (scrolling back) or what is new after `afterSeq` (polling).
  const page = {
    limit: input?.limit,
    read: input?.read === true,
    ...(Number.isSafeInteger(input?.beforeSeq) ? { beforeSeq: input.beforeSeq } : {}),
    ...(Number.isSafeInteger(input?.afterSeq) ? { afterSeq: input.afterSeq } : {}),
  };
  if (await localBotsMode()) {
    try {
      return { ok: true, ...(await localBots.thread(botId, page)) };
    } catch (error) {
      return localBotsIpcError(error);
    }
  }
  try {
    return { ok: true, ...(await durangoClient.botThread(botId, page)) };
  } catch (error) {
    return durangoIpcError(error);
  }
});

// Files the person attaches to a bot message: picked, dropped (their paths) or
// pasted (saved to a temp file first, bots:saveAttachment). Regular files only.
const BOT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const BOT_ATTACHMENT_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

const botAttachmentFiles = async (files) => {
  const out = [];
  for (const file of (Array.isArray(files) ? files : []).slice(0, 10)) {
    const filePath = typeof file?.path === 'string' ? file.path : '';
    if (!filePath || !path.isAbsolute(filePath)) continue;
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw new Error(`Can't read ${path.basename(filePath)}.`);
    if (stat.size > BOT_ATTACHMENT_MAX_BYTES) throw new Error(`${path.basename(filePath)} is over 25 MB.`);
    const name = (typeof file?.name === 'string' && file.name.trim() ? file.name : path.basename(filePath)).slice(0, 200);
    out.push({ path: filePath, name, size: stat.size, contentType: mimeTypeForPath(filePath) });
  }
  return out;
};

ipcMain.handle('bots:pickAttachments', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const picked = await dialog.showOpenDialog(window, { title: 'Attach files', properties: ['openFile', 'multiSelections'] });
  if (picked.canceled) return { ok: true, files: [] };
  try {
    const files = await botAttachmentFiles(picked.filePaths.map((filePath) => ({ path: filePath })));
    // Images come with a small data URL so the prompt box can show a thumbnail.
    return {
      ok: true,
      files: await Promise.all(
        files.map(async ({ path: filePath, name, size, contentType }) => {
          const preview =
            /^image\/(png|jpeg|gif|webp)$/.test(contentType) && size <= BOT_ATTACHMENT_PREVIEW_MAX_BYTES
              ? `data:${contentType};base64,${(await fs.readFile(filePath)).toString('base64')}`
              : undefined;
          return { path: filePath, name, size, ...(preview ? { preview } : {}) };
        })
      ),
    };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
});

// A pasted image (or file) → a temp file to attach like a picked one.
ipcMain.handle('bots:saveAttachment', async (_event, input) => {
  const data = typeof input?.data === 'string' ? input.data : '';
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > BOT_ATTACHMENT_MAX_BYTES) return { ok: false, error: 'That file is empty or over 25 MB.' };
  const name = (typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : 'pasted').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120);
  const dir = path.join(app.getPath('temp'), 'durango-bot-attachments', crypto.randomUUID());
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, bytes);
  return { ok: true, file: { path: filePath, name, size: bytes.length } };
});

ipcMain.handle('bots:send', async (_event, input) => {
  const botId = typeof input?.botId === 'string' ? input.botId.slice(0, 128) : '';
  const messageId = typeof input?.messageId === 'string' ? input.messageId.slice(0, 128) : '';
  const content = typeof input?.content === 'string' ? input.content.slice(0, 32_000) : '';
  let files;
  try {
    files = await botAttachmentFiles(input?.files);
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
  if (!botId || !messageId || (!content.trim() && !files.length)) return { ok: false, error: 'Write a message first.' };
  if (await localBotsMode()) {
    try {
      return { ok: true, ...(await localBots.send(botId, { messageId, content, files })) };
    } catch (error) {
      return localBotsIpcError(error);
    }
  }
  // A bot is in use here: a machine waiting out an idle period (no bots then) answers now.
  botReplyWorker.wake();
  try {
    // Pinned to the account signed in now (uploads and the message alike).
    const account = await durangoAccountKey();
    if (!account) return { ok: false, error: 'Sign in to Durango first.' };
    // Uploads in parallel (and the device id alongside): sending waits only for the slowest file.
    const [uploads, machineId] = await Promise.all([
      Promise.all(files.map(async (file) => durangoClient.uploadBotAttachment({ name: file.name, bytes: await fs.readFile(file.path), contentType: file.contentType, account }))),
      // Sent from this machine: its replies run here first (unless the bot has its own order).
      getDurangoDeviceId().catch(() => null),
    ]);
    const assets = uploads.map((uploaded) => uploaded?.part).filter(Boolean);
    const timeZone = typeof input?.timeZone === 'string' ? input.timeZone.slice(0, 64) : undefined;
    return {
      ok: true,
      ...(await durangoClient.sendBotMessage(
        botId,
        {
          messageId,
          content,
          ...(assets.length ? { assets } : {}),
          ...(timeZone ? { timeZone } : {}),
          ...(machineId ? { machineId } : {}),
        },
        { account }
      )),
    };
  } catch (error) {
    return durangoIpcError(error);
  }
});

// Titles for the changes and Durango Code threads bot replies name (shown as
// links): from Durango, only what the account can read. Signed out: none.
ipcMain.handle('bots:refs', async (_event, input) => {
  const ids = (value, pattern) =>
    [...new Set((Array.isArray(value) ? value : []).filter((id) => typeof id === 'string' && pattern.test(id)))].slice(0, 50);
  const changes = ids(input?.changes, /^chg_[a-z0-9]{8,40}$/);
  const threads = ids(input?.threads, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
  if ((!changes.length && !threads.length) || (await localBotsMode())) return { ok: true, changes: {}, threads: {} };
  try {
    return { ok: true, ...(await durangoClient.botRefs({ changes, threads })) };
  } catch (error) {
    return durangoIpcError(error);
  }
});
ipcMain.handle('threads:takeOpenRequest', () => threadOpenLinks.take());

// Files in bot threads (what the person attached, and files a reply attached):
// read links (an hour) from Durango, by library id. Signed out, files are on
// this device and the renderer shows them from their paths.
ipcMain.handle('bots:fileLinks', async (_event, input) => {
  const ids = (Array.isArray(input?.ids) ? input.ids : []).filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)).slice(0, 40);
  if (!ids.length) return { ok: true, files: [] };
  if (await localBotsMode()) return { ok: true, files: [] };
  try {
    return { ok: true, files: await durangoClient.botFileLinks(ids) };
  } catch (error) {
    return durangoIpcError(error);
  }
});

// A bot reply's Ship button (the renderer asked the person to confirm first).
// With the thread that made the change: the ship request goes to that thread
// as a follow-up turn, like a bot's message_thread (the bots' Shipping rule:
// that thread knows how its project ships). A thread that isn't here →
// `notHere`, and the renderer asks the bot to send it there. Without a
// thread: lands the change the way the thread header's Land does.
ipcMain.handle('bots:shipChange', async (_event, input) => {
  const changeId = typeof input?.changeId === 'string' ? input.changeId.trim() : '';
  if (!/^chg_[a-z0-9]{8,40}$/.test(changeId)) return { ok: false, error: 'Not a change id.' };
  const threadId = typeof input?.threadId === 'string' ? input.threadId.trim() : '';
  if (threadId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) return { ok: false, error: 'Not a thread id.' };
    const started = await requestDispatchRendererCommand(
      {
        kind: 'runTurn',
        threadId,
        prompt: `${SHIP_VIA_THREAD_MESSAGE}\n\n(The change: ${changeId}. The person confirmed shipping it with the Ship button on their bot's reply.)`,
        source: { machineId: 'durango-bot', machineName: 'Ship button' },
      },
      30_000
    ).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (started?.ok) return { ok: true, via: 'thread', threadId, changeId };
    if (/not found on this machine|runs on another machine/i.test(started?.error ?? '')) {
      return { ok: false, notHere: true, error: started.error };
    }
    return { ok: false, error: started?.error ?? 'Could not start the follow-up in that thread.' };
  }
  const cliSignIn = await signInBundledCli();
  if (!cliSignIn.signedIn) return { ok: false, error: cliSignIn.error ?? 'Sign in to Durango Code first.' };
  return landDurangoChange({ changeId });
});

// A bot reply's View change button: the change's page on durango.sh (its URL
// when the bot gave one, else Durango Source's, found from a checkout here).
ipcMain.handle('bots:openChange', async (_event, input) => {
  const changeId = typeof input?.changeId === 'string' ? input.changeId.trim() : '';
  const given = typeof input?.url === 'string' ? externalWebUrl(input.url) : null;
  try {
    let target = given;
    if (!target) {
      if (!/^chg_[a-z0-9]{8,40}$/.test(changeId)) return { ok: false, error: 'Not a change id.' };
      await signInBundledCli();
      target = externalWebUrl((await locateDurangoChange(changeId))?.url ?? '');
    }
    if (!target) return { ok: false, error: `Couldn't find ${changeId} in a Durango Source checkout on this computer.` };
    await shell.openExternal(target);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? 'Could not open the change.' };
  }
});

// @chat links: open the chat's own URL when known (renderer or main saw it
// in search results), else Durango Chat. Only http(s) URLs ever open.
ipcMain.handle('durango:openChat', async (_event, input) => {
  const chatId = typeof input?.chatId === 'string' ? input.chatId.slice(0, 200) : '';
  if (!chatId) return { ok: false, error: 'Missing chat id.' };
  try {
    const rendererUrl = typeof input?.url === 'string' ? externalWebUrl(input.url) : null;
    const target = rendererUrl ?? externalWebUrl(await durangoClient.chatUrl(chatId));
    if (!target) return { ok: false, error: 'This chat link cannot be opened.' };
    await shell.openExternal(target);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? 'Could not open the chat.' };
  }
});

ipcMain.handle('durango:profileMemory', async () => {
  const session = await readAccountSession();
  if (!durangoMock && !session?.token) return { ok: false, code: 'not_signed_in', block: '' };
  return durangoProfileMemory.get(session?.user?.id ?? 'mock');
});

ipcMain.handle('account:signOut', async () => {
  await clearAccountSession();
  return publishAccountState(null);
});

ipcMain.handle('appUpdate:getState', async () => appUpdateState);

ipcMain.handle('appUpdate:check', async (_event, input) =>
  checkForAppUpdate({ force: input?.force === true, background: input?.background === true })
);

ipcMain.handle('appUpdate:download', async () => {
  if (!app.isPackaged) return appUpdateState;
  const autoUpdater = await initializeAppUpdater();
  // downloadUpdate() fetches whatever the last check found, and that check
  // can be hours old — newer releases may have shipped since, and the feed's
  // signed download URLs expire minutes after each check. Re-check first so
  // we always download the latest version from a fresh URL.
  const checkResult = await autoUpdater.checkForUpdates();
  if (!checkResult?.isUpdateAvailable) return appUpdateState;
  const targetVersion = checkResult?.updateInfo?.version ?? null;
  if (targetVersion && targetVersion === appUpdateDownloadedVersion) {
    // This version is already downloaded and staged; go straight back to
    // "Restart to update" instead of fetching the same bytes again.
    return publishAppUpdateState({ status: 'downloaded', availableVersion: targetVersion, progress: null, error: null });
  }
  publishAppUpdateState({ status: 'downloading', progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }, error: null });
  await autoUpdater.downloadUpdate(checkResult.cancellationToken);
  return appUpdateState;
});

let appUpdateRestartRequested = false;

const restartForAppUpdate = async () => {
  if (appUpdateRestartRequested) return { ok: true };
  appUpdateRestartRequested = true;
  publishAppUpdateState({ status: 'restarting', progress: null, error: null });

  try {
    // "Downloaded" only means the zip is on disk; Squirrel still has to pull it
    // through electron-updater's proxy server and stage it. quitAndInstall()
    // before that finishes is swallowed — the click looks like a no-op — so
    // wait for the update to actually be installable first.
    const staged = await waitForAppUpdateStagedForInstall();
    if (!staged) {
      appUpdateRestartRequested = false;
      invalidateAppUpdateDownload();
      const error =
        appUpdateState.error ??
        'Durango Code could not prepare the update. Try downloading it again.';
      publishAppUpdateState({ status: 'error', progress: null, error });
      return { ok: false, error };
    }

    // Linux packages install before anything shuts down: the password prompt
    // can be dismissed or fail, and then the app keeps running as it was.
    const linuxInstall = await installDownloadedLinuxUpdate();
    if (linuxInstall && !linuxInstall.ok) {
      appUpdateRestartRequested = false;
      if (linuxInstall.cancelled) {
        publishAppUpdateState({ status: 'downloaded', progress: null, error: null });
        return { ok: false, error: 'The update was not installed.' };
      }
      publishAppUpdateState({ status: 'error', progress: null, error: linuxInstall.error });
      return { ok: false, error: linuxInstall.error };
    }

    await settleQuitBarrierForUpdate();
    if (linuxInstall) {
      relaunchApp(app);
      app.quit();
      return { ok: true };
    }
    const autoUpdater = await initializeAppUpdater();
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  } catch (error) {
    appUpdateRestartRequested = false;
    publishAppUpdateState({ status: 'downloaded', progress: null, error: null });
    return { ok: false, error: error?.message ?? 'Could not restart to update' };
  }
};

ipcMain.handle('whatsNew:get', async () => getWhatsNew());

ipcMain.handle('whatsNew:dismiss', async () => {
  await markWhatsNewSeen();
  return { ok: true };
});

ipcMain.handle('appUpdate:restart', async () => {
  if (appUpdateState.status !== 'downloaded' && appUpdateState.status !== 'restarting') {
    return { ok: false, error: 'No update is ready to install' };
  }
  return restartForAppUpdate();
});

// The renderer reports a spawned subagent's outcome here, unblocking the
// spawn_subagent MCP tool call that requested it.
ipcMain.handle('orchestration:subagentResult', (_event, payload) => handleSubagentResult(payload));

// The renderer created a spawned subagent's subthread: a background spawn's
// call returns now (background-subagents.js).
ipcMain.handle('orchestration:subagentStarted', (_event, payload) => handleSubagentStarted(payload));

// A driver thread whose turn ended takes the background subagent reports it
// never collected, to receive them as a new message.
ipcMain.handle('orchestration:takeSubagentReports', (_event, threadId) => {
  const entries = takeSubagentReports(threadId);
  return entries.length > 0 ? { text: subagentReportsMessage(entries) } : { text: '' };
});

// The renderer reports a subagent stop's outcome here, unblocking the
// stop_subagent MCP tool call that requested it.
ipcMain.handle('orchestration:subagentStopResult', (_event, payload) => {
  const pending = pendingSubagentStops.get(payload?.stopId);
  if (!pending) return { ok: false };
  pendingSubagentStops.delete(payload.stopId);
  pending.resolve(
    payload.ok
      ? payload.result || 'Subagent stopped.'
      : `Could not stop subagent: ${payload.result || 'unknown error'}`
  );
  return { ok: true };
});

ipcMain.handle('agent:runTurn', async (event, input) => {
  if (appShutdownRequested) {
    return { ok: false, error: appShutdownError() };
  }
  const runId = input?.runId || crypto.randomUUID();
  // Synchronous, before the first await: IPC handlers start in arrival
  // order, so a stop/steer sent after this runTurn is guaranteed to see the
  // entry (or the fully registered run).
  const startupController = new AbortController();
  startingAgentRuns.set(runId, {
    aborted: false,
    threadId: input?.threadId,
    abortController: startupController,
  });
  // Paired controllers stream the run's events into their copy of this message.
  noteAgentRunOutputMessage(runId, input?.outputMessageId, input?.threadId);
  try {
    if (!input?.threadId || !input?.projectPath || !input?.prompt || !input?.modelId) {
      return { ok: false, error: 'Missing threadId, projectPath, prompt, or modelId.' };
    }
    // The No project scratch directory is Orion's own; recreate it if it was
    // cleaned up rather than failing the chat.
    if (path.resolve(input.projectPath) === getNoProjectDirectoryPath()) {
      await fs.mkdir(input.projectPath, { recursive: true });
    }
    await bundledSkillsReady;
    const workspaceError = await validateAgentWorkspace(input.projectPath);
    if (workspaceError) {
      return { ok: false, error: workspaceError };
    }

    // A newly opened window can submit a turn while startup cleanup is still
    // running. Do not let a provider load the stale persistent MCP entries
    // that cleanup is removing.
    await legacyMcpCleanupPromise;

    const models = await getAgentModels();
    const legacyAntigravity = models.some((candidate) => candidate.id === input.modelId)
      ? null
      : resolveLegacyAntigravityModelId(models, input.modelId);
    const model =
      models.find((candidate) => candidate.id === input.modelId) ?? legacyAntigravity?.model;
    if (!model) {
      return { ok: false, error: `Unknown model: ${input.modelId}` };
    }

    // Safety net: the renderer resolves the Orion pseudo-model to its
    // configured main-driver model before ever calling runTurn.
    if (model.providerId === 'orion' || input.modelId === 'orion:orchestrator') {
      return { ok: false, error: 'Durango Code orchestrator was not resolved to a driver model' };
    }

    // Safety net: Claude Code CLI threads run in an embedded terminal
    // (terminal:* IPC), never as one-shot turns — its slug is not a model.
    if (input.modelId === 'claude:claude-code-cli') {
      return { ok: false, error: 'Claude Code CLI runs in the embedded terminal, not as agent turns' };
    }

    const available = await checkCommandAvailable(model.command);
    if (!available) {
      return { ok: false, error: `${model.command} is not installed or not on PATH.` };
    }

    // MCP servers connected to Orion: every enabled one plus any the thread
    // attached with an @-mention. One-shot asides and reviews keep the
    // provider's own configuration only.
    const orionMcps =
      input.aside || input.codexReview
        ? { servers: [], needsSignIn: [] }
        : await resolveOrionMcpsForRun(input.mcpServerIds, { signal: startupController.signal }).catch((error) => {
            // Cancellation is handled below; storage failures must stop startup.
            if (startupController.signal.aborted) return { servers: [], needsSignIn: [] };
            throw error;
          });
    if (startupController.signal.aborted) {
      const aborted = startingAgentRuns.get(runId);
      return aborted?.abortError ? { ok: false, error: aborted.abortError } : { ok: true, runId };
    }
    // Connectors from the Durango account join Durango Code's own servers.
    // Best effort: they never make a turn fail.
    const accountMcps =
      input.aside || input.codexReview
        ? []
        : await accountConnectors.forRun({ taken: orionMcps.servers.map((server) => server.name) });
    if (orionMcps.needsSignIn.length > 0) {
      emitAgentEvent(event.sender, {
        runId,
        threadId: input.threadId,
        type: 'chunk',
        chunk: `_${orionMcps.needsSignIn
          .map((name) => `@${name}`)
          .join(', ')} ${
          orionMcps.needsSignIn.length === 1 ? 'needs' : 'need'
        } a new sign-in (Settings → Skills & MCPs), so ${
          orionMcps.needsSignIn.length === 1 ? 'it was' : 'they were'
        } not loaded for this turn._\n\n`,
      });
    }

    // Capture before Orion's own managed-file writes so they remain visible
    // in the run's changed-files summary. Read only must not mutate the
    // project at all, so it relies solely on the injected prompt context.
    const shouldSyncOrchestrationFiles =
      input.orchestration?.isOrchestrator && input.accessMode !== 'read-only';
    const orchestrationSnapshot = shouldSyncOrchestrationFiles
      ? await captureGitChangeSnapshot(input.projectPath)
      : undefined;
    if (shouldSyncOrchestrationFiles) {
      try {
        await syncOrchestrationInstructionFiles(input.projectPath, input.orchestration);
      } catch (error) {
        console.warn('agent:runTurn: syncing orchestration instruction files failed', error);
      }
    }

    // Claude turns run on a persistent Agent SDK session (one CLI process per
    // thread) so background subagents and their task notifications survive
    // turn boundaries. `/btw` asides must not touch the thread's live
    // session, so they keep the one-shot forked-CLI path below.
    if (model.providerId === 'claude' && !input.aside) {
      return await runClaudeSdkTurn({
        sender: event.sender,
        input: {
          ...input,
          // Servers shared from Claude Code already load from its own config.
          orionMcpServers: claudeOrionMcpServers(
            await withoutClaudeNativeMcps([...orionMcps.servers, ...accountMcps], input.projectPath)
          ),
        },
        model,
        runId,
        initialSnapshot: orchestrationSnapshot,
      });
    }

    const beforeSnapshot =
      orchestrationSnapshot === undefined
        ? await captureGitChangeSnapshot(input.projectPath)
        : orchestrationSnapshot;
    const jsonMode = sendsJsonEvents(model.providerId);
    const adapter = jsonAdapterForProvider(model.providerId);
    const REASONING_EMIT_INTERVAL_MS = 150;

    // A branched thread's first turn must not resume the parent's session in
    // place. claude forks natively via --fork-session; codex/cursor/grok
    // sessions are copied on disk here and the copy is resumed instead. If
    // the copy fails, start fresh — never touch the parent's session.
    let initialResumeId =
      typeof input.resumeSessionId === 'string' && input.resumeSessionId
        ? input.resumeSessionId
        : null;
    const forkRequested = Boolean(input.forkSession) && Boolean(initialResumeId);
    const forkWithNativeFlag =
      forkRequested && (model.providerId === 'claude' || model.providerId === 'opencode');
    if (forkRequested && !forkWithNativeFlag) {
      initialResumeId = await forkSessionOnDisk(model.providerId, initialResumeId);
      if (!initialResumeId) {
        emitAgentEvent(event.sender, {
          runId,
          threadId: input.threadId,
          type: 'chunk',
          chunk: "_Couldn't copy the parent thread's session; starting this branch fresh._\n\n",
        });
      }
    }

    // One spawn of the provider CLI. If resuming a prior session fails before
    // producing output, close() falls back to a single fresh attempt.
    const useAcp =
      model.providerId === 'grok' ||
      model.providerId === 'kimi' ||
      model.providerId === 'antigravity' ||
      model.providerId === 'fx';
    // Codex goal runs (/goal) are driven over `codex app-server` JSON-RPC —
    // the goal runtime auto-continues turns only inside a live app-server.
    const useCodexGoal =
      model.providerId === 'codex' && Boolean(input.codexGoal) && typeof input.codexGoal === 'object';
    const useCodexReview =
      model.providerId === 'codex' &&
      Boolean(input.codexReview) &&
      typeof input.codexReview === 'object';
    const useCodexAppServer = model.providerId === 'codex' && !input.aside;
    // Resolve user/plugin MCP definitions before allocating the per-run
    // bridge. If Codex cannot list or parse its MCP configuration, startup
    // fails without leaving a bridge session or temporary plugin directory.
    // Resolve from the turn's workspace and process-level config flags so
    // project .codex/config.toml and selected profiles match the app-server
    // process that consumes the result. Full definitions may contain
    // environment values or headers, so only the app-server path receives
    // them over local JSON-RPC. One-shot /btw execs keep inheriting the user's
    // base Codex MCP configuration unchanged.
    // Customized Codex runs use a project-local process; ordinary runs use
    // the shared app-server whose login shell starts at home.
    const codexHasProcessArgs =
      typeof input.providerOptions?.extraArgs === 'string' &&
      input.providerOptions.extraArgs.trim().length > 0;
    const codexShellCwd = codexHasProcessArgs ? input.projectPath : os.homedir();
    // Reuse equivalent native servers and reject unsafe name collisions. A
    // collision caused by an account connector drops the account connectors
    // instead of failing the turn.
    const codexMcpServers = async () => {
      const options = {
        cwd: input.projectPath,
        shellCwd: codexShellCwd,
        configArgs: splitCodexConfigContextArgs(input.providerOptions).configArgs,
      };
      if (accountMcps.length === 0) return withoutCodexNativeMcps(orionMcps.servers, options);
      try {
        return await withoutCodexNativeMcps([...orionMcps.servers, ...accountMcps], options);
      } catch {
        return withoutCodexNativeMcps(orionMcps.servers, options);
      }
    };
    let runtimeInput =
      useCodexAppServer
        ? {
            ...input,
            // The run's own servers load on demand through the bridge below.
            mcpRuntimeConfig: await readMcpRuntimeConfig({
              cwd: input.projectPath,
              shellCwd: codexShellCwd,
              configArgs: splitCodexConfigContextArgs(input.providerOptions).configArgs,
            }),
          }
        : input;
    // fx chooses its route (subscription first, then the billed provider) and
    // credentials before the process starts: its ACP initialize already
    // needs a usable startup provider.
    let fxLaunch = null;
    if (model.providerId === 'fx') {
      try {
        fxLaunch = await prepareFxLaunch({
          slug: model.slug,
          providerOptions: input.providerOptions,
          accessMode: input.accessMode || 'full-access',
        });
      } catch (error) {
        if (!startupController.signal.aborted) {
          return { ok: false, error: error?.message ?? String(error) };
        }
      }
      if (startupController.signal.aborted) {
        const aborted = startingAgentRuns.get(runId);
        return aborted?.abortError ? { ok: false, error: aborted.abortError } : { ok: true, runId };
      }
    }
    // spawn_subagent for non-Claude drivers: hand the CLI the bridge shim as
    // an `orion` MCP server. One token per runTurn call — a resume-fallback
    // reattempt reuses it; the last attempt's finalizeRun releases it.
    const bridgeProvider = isMcpBridgeProvider(model.providerId);
    const supportsRunPlugin =
      bridgeProvider && (await providerSupportsRunPlugin(model.providerId));
    if (orionMcps.servers.length > 0 && !supportsRunPlugin) {
      return {
        ok: false,
        error: `This ${model.providerId} installation cannot load Durango Code MCP servers: ${orionMcps.servers.map((server) => `@${server.name}`).join(', ')}. Update the provider CLI or switch providers.`,
      };
    }
    const usePersistentAntigravity =
      model.providerId === 'antigravity' && !input.aside && !input.spawnedSubagent;
    const createRunOrionMcp = async () =>
      input.aside || input.codexReview || !bridgeProvider || !supportsRunPlugin
        ? null
        : registerMcpBridgeForRun({
            getSender: () => event.sender,
            threadId: input.threadId,
            runId,
            projectPath: input.projectPath,
            projectId: typeof input.projectId === 'string' ? input.projectId : null,
            providerId: model.providerId,
            modelId: model.id,
            accessMode: input.accessMode || 'full-access',
            browserMode: browserModeFor(model.providerId, input.providerOptions, input.accessMode || 'full-access'),
            // Not in the provider's config: the bridge connects them when the
            // agent loads them (load_tools / call_app_tool, mcp-on-demand.js).
            // Codex skips servers its own config already runs.
            userServers:
              model.providerId === 'codex'
                ? await codexMcpServers()
                : [...orionMcps.servers, ...accountMcps],
          });
    let antigravityLease = usePersistentAntigravity
      ? await antigravitySessionManager.acquire({
          threadId: input.threadId,
          cwd: input.projectPath,
          accessMode: input.accessMode || 'full-access',
          commandArgs: commandForModel(model, {
            ...runtimeInput,
            acp: true,
            resumeSessionId: input.resumeSessionId,
          }),
          env: withClaudeEnv({
            ...process.env,
            FORCE_COLOR: '0',
            NO_COLOR: '1',
          }),
          mcpKey: JSON.stringify({
            servers: [...orionMcps.servers, ...accountMcps],
            projectId: typeof input.projectId === 'string' ? input.projectId : null,
            interactive: !input.spawnedSubagent,
          }),
          resumeSessionId: input.resumeSessionId || null,
          createMcp: createRunOrionMcp,
          rebindMcp: (mcp) =>
            mcp.rebindTurn?.({
              runId,
              modelId: model.id,
              accessMode: input.accessMode || 'full-access',
              browserMode: browserModeFor(model.providerId, input.providerOptions, input.accessMode || 'full-access'),
              getSender: () => event.sender,
            }),
        })
      : null;
    const releaseRunStartupResources = async () => {
      if (antigravityLease) {
        const lease = antigravityLease;
        antigravityLease = null;
        await lease.release({ keepAlive: false });
      } else {
        orionMcp?.release();
      }
    };
    const orionMcp = antigravityLease ? antigravityLease.orionMcp : await createRunOrionMcp();
    const openCodeConfig =
      model.providerId === 'opencode'
        ? openCodeMcpConfigContent(orionMcp, process.env.OPENCODE_CONFIG_CONTENT)
        : null;
    // Muse takes the bridge through a synthetic XDG config root (its settings
    // file is the only MCP intake); built once per runTurn so a resume
    // fallback reattempt reuses it, and removed with the token dir on release.
    const museConfigRoot =
      model.providerId === 'muse' ? await writeMuseMcpConfigRoot(orionMcp) : null;
    // The renderer's capability probe only establishes that this provider can
    // accept the bridge. A referenced-thread turn also needs this run's shim,
    // socket token, and provider-specific plugin/config registration to have
    // succeeded. OpenCode registration is not effective unless its inline MCP
    // config could also be merged and passed to the child.
    const effectiveThreadReaderBridgeReady = isEffectiveThreadReaderBridgeReady(
      model.providerId,
      Boolean(orionMcp),
      Boolean(openCodeConfig),
      Boolean(museConfigRoot)
    );
    if (orionMcps.servers.length > 0 && !effectiveThreadReaderBridgeReady) {
      await releaseRunStartupResources();
      return {
        ok: false,
        error: `Durango Code could not load MCP servers for this run: ${orionMcps.servers.map((server) => `@${server.name}`).join(', ')}. Try again or switch providers.`,
      };
    }
    if (
      isRequiredThreadReaderBridgeMissing(
        model.providerId,
        // @chat mentions need read_chat from the same bridge as read_thread.
        input.hasThreadMentions === true || input.hasChatMentions === true,
        effectiveThreadReaderBridgeReady
      )
    ) {
      await releaseRunStartupResources();
      return {
        ok: false,
        error: input.hasThreadMentions
          ? 'Durango Code could not make read_thread available for this run. Try the referenced-thread turn again.'
          : 'Durango Code could not make read_chat available for this run. Try the Durango chat mention again.',
      };
    }
    if (
      model.providerId === 'codex' &&
      (input.accessMode || 'full-access') !== 'read-only' &&
      codexBrowserUseMode(input.providerOptions) === 'extension'
    ) {
      const browserIntegration = await getCodexBrowserIntegrationStatus();
      if (!browserIntegration.ready) {
        // An unverified extension stays the user's choice when this run has
        // the built-in browser for pages without a login; without the bridge
        // it falls back to the separate-profile chrome-devtools browser.
        runtimeInput = {
          ...runtimeInput,
          providerOptions: codexBrowserOptionsForIntegration(
            input.providerOptions,
            { ...browserIntegration, builtinAvailable: Boolean(orionMcp) }
          ),
        };
        orionMcp?.setBrowserMode?.(
          browserModeFor(model.providerId, runtimeInput.providerOptions, input.accessMode || 'full-access')
        );
      }
    }
    // Per-process Codex flags cannot be isolated on a shared server. Keep
    // those uncommon customized runs on the direct path; ordinary turns use
    // one Orion-owned server and an isolated WebSocket per active run.
    let codexAppServerLease =
      useCodexAppServer && !codexHasProcessArgs
        ? await codexAppServerManager.acquire()
        : null;

    const startAttempt = (resumeSessionId, forceDirectCodexAppServer = false) => {
    const persistentCodexAppServer = Boolean(
      useCodexAppServer &&
        !forceDirectCodexAppServer &&
        codexAppServerLease?.persistent &&
        codexAppServerLease.child
    );
    const persistentAntigravity = Boolean(
      usePersistentAntigravity && antigravityLease?.child
    );
    const args = commandForModel(model, {
      ...runtimeInput,
      acp: useAcp,
      codexAppServer: useCodexAppServer,
      resumeSessionId,
      forkSession: forkWithNativeFlag && Boolean(resumeSessionId),
      orionMcp,
    });
    const commandString = args.map(shellQuote).join(' ');
    const child = persistentCodexAppServer
      ? codexAppServerLease.child
      : persistentAntigravity
      ? antigravityLease.child
      : (useCodexAppServer ? spawnCodexServerProcess : spawn)(loginShell, ['-lc', commandString], {
          // Shared-server startup/connection failures retry directly. Keep
          // the shell context used by MCP discovery on every attempt; the
          // driver's thread/start or thread/resume supplies the project cwd.
          cwd: useCodexAppServer ? codexShellCwd : input.projectPath,
          env: withClaudeEnv({
            ...process.env,
            FORCE_COLOR: '0',
            NO_COLOR: '1',
            ...(openCodeConfig ? { OPENCODE_CONFIG_CONTENT: openCodeConfig } : {}),
            ...(museConfigRoot ? { XDG_CONFIG_HOME: museConfigRoot } : {}),
            ...(fxLaunch ? fxLaunch.env : {}),
          }),
          // ACP and app-server runs speak JSON-RPC over stdin; one-shot CLIs
          // take no input.
          stdio: [useAcp || useCodexAppServer ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        });

    let stderr = '';
    let stdoutSeen = false;
    let fatalMeta = null;
    let acceptedCodexSessionId = resumeSessionId;
    let codexActionAccepted = false;
    let jsonBuffer = '';
    const streamContext = { textSeen: false };
    const knownToolActivities = new Map();

    // codex's exec --json stream emits no item at all when the model spawns a
    // collaboration subagent — only bare "Waiting for subagents" rows once it
    // waits on them — so the parent's steps never said what was delegated.
    // Mirror each tracked subagent as a step naming it and its task, matching
    // how claude's Task tool_use row reads.
    const emitCodexSubagentStep = (meta) => {
      emitAgentEvent(event.sender, {
        runId,
        threadId: input.threadId,
        type: 'activity',
        activity: {
          key: `subagent:${meta.id}`,
          type: 'tool',
          kind: 'task',
          title: `Subagent - ${meta.title || meta.kind || 'codex agent'}`,
          detail: stringifySummary(meta.prompt ?? '', 300),
          status: meta.status === 'error' ? 'error' : meta.status === 'running' ? 'running' : 'done',
        },
      });
    };

    // Native subagents (codex collaboration spawns, cursor Task tool): tail
    // each spawned subagent's on-disk transcript and stream it to the
    // renderer as its own switchable thread.
    const subagentTracker = createSubagentTracker({
      providerId: model.providerId,
      threadId: input.threadId,
      getSender: () => event.sender,
      getRunId: () => runId,
      onMeta: model.providerId === 'codex' ? emitCodexSubagentStep : undefined,
    });
    // Codex app-server exposes the plaintext spawn prompt live, while the
    // child rollout stores its body encrypted. The app-server item and the
    // filesystem watcher can arrive in either order, so retain metadata until
    // the child tracker exists and update it immediately when it already does.
    const pendingCodexSubagentMetadata = new Map();
    const receiveCodexSubagentMetadata = ({ id, prompt, model: childModel, reasoningEffort }) => {
      if (typeof id !== 'string' || !id) return;
      const previous = pendingCodexSubagentMetadata.get(id) ?? {};
      const metadata = {
        ...previous,
        ...(typeof prompt === 'string' && prompt ? { prompt } : {}),
        ...(typeof childModel === 'string' && childModel ? { model: childModel } : {}),
        ...(typeof reasoningEffort === 'string' && reasoningEffort ? { reasoningEffort } : {}),
      };
      if (subagentTracker.update(id, metadata)) {
        pendingCodexSubagentMetadata.delete(id);
      } else {
        pendingCodexSubagentMetadata.set(id, metadata);
      }
    };
    let codexSpawnWatcher = null;
    let kimiSpawnWatcher = null;
    // Kimi subagents live under the session's own directory; watching can
    // only start once the ACP dialog reports the session id.
    const ensureKimiSpawnWatcher = async (sessionId, baselineExisting) => {
      if (kimiSpawnWatcher || model.providerId !== 'kimi' || !sessionId) return;
      // A brand-new session's index entry may lag the session/new response by
      // a moment — retry briefly before giving up on subagent tracking.
      let entry = null;
      for (let attempt = 0; attempt < 10 && !entry; attempt += 1) {
        entry = await findKimiSessionIndexEntry(sessionId);
        if (!entry) await new Promise((resolve) => setTimeout(resolve, 1000));
        if (finalized) return;
      }
      if (!entry?.sessionDir || kimiSpawnWatcher || finalized) return;
      kimiSpawnWatcher = watchKimiSubagentSpawns({
        sessionDir: entry.sessionDir,
        baselineExisting,
        onSpawn: (spawn) => {
          subagentTracker.start(
            {
              id: spawn.agentId,
              title: 'Kimi subagent',
              kind: 'kimi agent',
            },
            {
              resolveFile: async () => (existsSync(spawn.wirePath) ? spawn.wirePath : null),
              handleLine: handleKimiSubagentLine,
            }
          );
        },
      });
    };
    // provisional cursor agentId -> { realAgentId } (see the completed event)
    const cursorSubagentFileRefs = new Map();
    const ensureCodexSpawnWatcher = (parentThreadId) => {
      if (codexSpawnWatcher || model.providerId !== 'codex' || !parentThreadId) return;
      codexSpawnWatcher = watchCodexSubagentSpawns({
        parentThreadId,
        // A codex subagent can spawn its own subagents; those name the
        // subagent, not the run's thread, as their spawn parent.
        isTrackedThread: (threadId) => subagentTracker.has(threadId),
        onSpawn: (spawn) => {
          const metadata = pendingCodexSubagentMetadata.get(spawn.threadId) ?? {};
          subagentTracker.start(
            {
              id: spawn.threadId,
              title: codexSubagentTitle(spawn),
              kind: spawn.role || 'codex agent',
              ...metadata,
              // Nest under the spawning subagent rather than flattening every
              // descendant onto the run's thread.
              ...(spawn.parentThreadId !== parentThreadId
                ? { parentSubagentId: spawn.parentThreadId }
                : {}),
            },
            {
              resolveFile: async () => spawn.filePath,
              handleLine: handleCodexRolloutLine,
            }
          );
          pendingCodexSubagentMetadata.delete(spawn.threadId);
        },
      });
    };
    // Resumed codex runs emit no thread.started — the resumed session id IS
    // the parent thread id.
    if (model.providerId === 'codex' && resumeSessionId) ensureCodexSpawnWatcher(resumeSessionId);

    const inspectForSubagents = (parsed) => {
      if (model.providerId === 'codex') {
        if (parsed?.type === 'thread.started' && typeof parsed.thread_id === 'string') {
          ensureCodexSpawnWatcher(parsed.thread_id);
        }
        return;
      }
      if (model.providerId !== 'cursor' || parsed?.type !== 'tool_call') return;
      const task = parsed.tool_call?.taskToolCall;
      if (!task) return;
      const args = task.args ?? {};
      const agentId = typeof args.agentId === 'string' ? args.agentId : null;
      if (!agentId) return;
      if (parsed.subtype === 'started') {
        const subagentType =
          args.subagentType && typeof args.subagentType === 'object'
            ? Object.keys(args.subagentType).find((key) => key !== 'unspecified')
            : undefined;
        // The started event's agentId is provisional — the transcript on disk
        // is keyed by the REAL agent id, which only arrives on the completed
        // event (result.success.agentId). Try both.
        const fileRef = { realAgentId: null };
        cursorSubagentFileRefs.set(agentId, fileRef);
        subagentTracker.start(
          {
            id: agentId,
            title: typeof args.description === 'string' && args.description ? args.description : 'Subagent',
            kind: subagentType,
            model: typeof args.model === 'string' ? args.model : undefined,
            prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
          },
          {
            resolveFile: async () =>
              (fileRef.realAgentId
                ? await cursorAgentTranscriptFile(input.projectPath, fileRef.realAgentId)
                : null) ?? (await cursorAgentTranscriptFile(input.projectPath, agentId)),
            handleLine: handleCursorSubagentLine,
          }
        );
      } else if (parsed.subtype === 'completed') {
        const result = task.result ?? {};
        const realAgentId = result.success?.agentId;
        const fileRef = cursorSubagentFileRefs.get(agentId);
        if (fileRef && typeof realAgentId === 'string' && realAgentId) {
          fileRef.realAgentId = realAgentId;
        }
        subagentTracker.finish(agentId, { status: result.success ? 'done' : 'error' });
      }
    };
    const seenActivityKeys = new Set();
    let sessionIdReported = false;
    let finalized = false;
    let exitFallbackTimer = null;
    let terminalEventTimer = null;
    let runStats = null;
    let antigravitySessionBroken = false;
    // Set once the stream signals a completed turn — a nonzero exit after
    // that (e.g. from the SIGTERM that reaps a lingering agent process) must
    // not trigger the resume-failed retry.
    let turnCompleted = false;
    activeAgentRuns.set(runId, { child, threadId: input.threadId });

    const clearFinalizeTimers = () => {
      if (exitFallbackTimer) {
        clearTimeout(exitFallbackTimer);
        exitFallbackTimer = null;
      }
      if (terminalEventTimer) {
        clearTimeout(terminalEventTimer);
        terminalEventTimer = null;
      }
    };

    const finalizeRun = async (exitCode, options = {}) => {
      if (finalized) return;
      finalized = true;
      // The run is about to be forgotten while its terminal event still
      // awaits git summarization — advertise the gap so a racing steer can
      // wait for the real outcome (agent:isRunFinalizing).
      finalizingAgentRuns.add(runId);
      try {
        await finalizeRunInner(exitCode, options);
      } finally {
        finalizingAgentRuns.delete(runId);
      }
    };

    const finalizeRunInner = async (exitCode, { wasStopped = false } = {}) => {
      // Stopping a goal run is a successful pause, not a provider failure.
      // The renderer normally untracks explicit stops, but normalizing here
      // keeps any other caller from receiving a false error event.
      const finalExitCode = wasStopped && useCodexGoal ? 0 : exitCode;
      clearFinalizeTimers();
      // A Codex recovery may have rolled back the failed user turn while its
      // compaction is still active. Let the driver restore that prompt before
      // closing its app-server transport.
      await acpDriver?.dispose?.();
      // Persistent Antigravity sessions stay warm across clean turns and own
      // their MCP bridge lease; error/stop/broken turns tear the process down.
      if (persistentAntigravity && antigravityLease) {
        const keepWarm = finalExitCode === 0 && !wasStopped && !antigravitySessionBroken;
        if (keepWarm) orionMcp?.abortTurn?.();
        await antigravityLease.release({ keepAlive: keepWarm });
        antigravityLease = null;
      } else {
        // The run owns its CLI process; whatever path finalized the run, the
        // process must not outlive it (ACP servers idle forever on their own).
        // No-op when the process already exited.
        killAgentChild(child, input.threadId);
        orionMcp?.release();
      }
      activeAgentRuns.delete(runId);
      stoppedAgentRuns.delete(runId);
      codexGoalRunDrivers.delete(runId);
      codexSteerableRunDrivers.delete(runId);
      fxSteerableRunDrivers.delete(runId);
      antigravityRunDrivers.delete(runId);
      codexAppServerLease?.release();
      codexAppServerLease = null;
      codexSpawnWatcher?.stop();
      kimiSpawnWatcher?.stop();
      subagentTracker.dispose(
        wasStopped ? 'stopped' : finalExitCode === 0 ? 'done' : 'error'
      );
      if (jsonMode && jsonBuffer.trim()) {
        try {
          const parsed = JSON.parse(jsonBuffer.trim());
          if (acpDriver) acpDriver.handleMessage(parsed);
          else emitParsedJsonEvent(parsed);
        } catch {}
        jsonBuffer = '';
      }
      finishReasoningActivity();

      if (finalExitCode !== 0 && stderr.trim()) {
        emitAgentEvent(event.sender, {
          runId,
          threadId: input.threadId,
          type: 'chunk',
          chunk: `${stdoutSeen ? '\n\n' : ''}${stderr.trim()}\n`,
        });
      }

      emitAgentEvent(event.sender, {
        runId,
        threadId: input.threadId,
        type: finalExitCode === 0 ? 'done' : 'error',
        exitCode: finalExitCode,
        changedFiles: await summarizeChangedFiles(input.projectPath, beforeSnapshot),
        ...(runStats ? { stats: runStats } : {}),
        ...(finalExitCode === 0
          ? {}
          : {
              error: `${model.label} exited with code ${finalExitCode}.`,
              // Lets the renderer offer the right provider's Authenticate
              // button when the failure text reads as a logged-out CLI.
              providerId: model.providerId,
              ...(fatalMeta?.retryable ? { retryable: true } : {}),
              ...(fatalMeta?.resumeWith ? { resumeWith: fatalMeta.resumeWith } : {}),
            }),
      });
    };

    const maybeEmitSessionId = (parsed) => {
      if (sessionIdReported) return;
      const sessionId = extractSessionIdFromJsonEvent(model.providerId, parsed);
      if (!sessionId) return;
      sessionIdReported = true;
      emitAgentEvent(event.sender, {
        runId,
        threadId: input.threadId,
        type: 'session',
        providerId: model.providerId,
        sessionId,
      });
    };

    const reasoningStream = createReasoningStream({
      runId,
      intervalMs: REASONING_EMIT_INTERVAL_MS,
      emit: (activity) => {
        emitAgentEvent(event.sender, {
          runId,
          threadId: input.threadId,
          type: 'activity',
          activity,
        });
      },
    });
    const finishReasoningActivity = () => reasoningStream.finishStep();

    const emitActivity = (activity) => {
      const isNewStep =
        activity.type !== 'thought' &&
        activity.type !== 'plan' &&
        (!activity.key || !seenActivityKeys.has(activity.key));
      if (activity.key) seenActivityKeys.add(activity.key);
      if (isNewStep) reasoningStream.finishStep();
      emitAgentEvent(event.sender, {
        runId,
        threadId: input.threadId,
        type: 'activity',
        activity,
      });
    };

    const emitParsedJsonEvent = (parsed) => {
      maybeEmitSessionId(parsed);
      inspectForSubagents(parsed);

      const reasoningDelta = adapter.reasoning(parsed, streamContext);
      if (reasoningDelta) reasoningStream.push(reasoningDelta);

      for (const { updateForKey, ...activity } of adapter.activities(parsed)) {
        if (updateForKey) {
          // A tool result: flip the original step to done/error in place
          // instead of appending a detached "Tool result" row. What the tool
          // returned only appears here, so fold it onto that row — the
          // expanded step shows the call and its output together.
          const known = knownToolActivities.get(updateForKey);
          if (known) {
            if (activity.output) known.output = activity.output;
            emitActivity({
              ...known,
              key: updateForKey,
              status: activity.status === 'error' || activity.type === 'error' ? 'error' : 'done',
            });
            continue;
          }
        }
        if (activity.key) {
          const { key, status, ...rest } = activity;
          knownToolActivities.set(key, rest);
        }
        emitActivity(activity);
      }

      const text = adapter.text(parsed, streamContext);
      if (text) {
        reasoningStream.finishStep();
        stdoutSeen = true;
        streamContext.textSeen = true;
        emitAgentEvent(event.sender, {
          runId,
          threadId: input.threadId,
          type: 'chunk',
          chunk: text,
        });
      }

      if (!terminalEventTimer && !finalized && isTerminalJsonEvent(model.providerId, parsed)) {
        // Give the process a moment to exit on its own; if it (or something
        // holding its pipes) lingers, complete the run from the stream event.
        turnCompleted = true;
        terminalEventTimer = setTimeout(() => {
          terminalEventTimer = null;
          killAgentChild(child);
          finalizeRun(0);
        }, 2000);
      }
    };

    // ACP and app-server runs bypass the pure-function adapters: the driver
    // owns the JSON-RPC dialog (it must answer requests over stdin) and feeds
    // the same emit helpers the adapter path uses.
    const sharedDriverCallbacks = {
      onSessionId: (sessionId) => {
        acceptedCodexSessionId = sessionId;
        ensureCodexSpawnWatcher(sessionId);
        if (sessionIdReported) return;
        sessionIdReported = true;
        emitAgentEvent(event.sender, {
          runId,
          threadId: input.threadId,
          type: 'session',
          providerId: model.providerId,
          sessionId,
        });
      },
      onReasoning: (delta) => reasoningStream.push(delta),
      onText: (text) => {
        reasoningStream.finishStep();
        stdoutSeen = true;
        emitAgentEvent(event.sender, {
          runId,
          threadId: input.threadId,
          type: 'chunk',
          chunk: text,
        });
      },
      onActivity: emitActivity,
      onActionAccepted: () => {
        codexActionAccepted = true;
      },
      onResumeFallback: () => {
        emitAgentEvent(event.sender, {
          runId,
          threadId: input.threadId,
          type: 'chunk',
          chunk: '_Could not resume the previous session; starting a fresh one._\n\n',
        });
      },
      onFatal: (message, meta) => {
        if (finalized) return;
        fatalMeta = meta && typeof meta === 'object' ? meta : null;
        stdoutSeen = true;
        emitAgentEvent(event.sender, {
          runId,
          threadId: input.threadId,
          type: 'chunk',
          chunk: `${message}\n`,
        });
        if (!persistentAntigravity) killAgentChild(child);
        finalizeRun(1);
      },
    };
    // The driver's completion signal: its per-run protocol connection idles
    // once the work resolves, so close it shortly after and finalize as done.
    // Persistent Antigravity runs keep their warm process alive via the lease
    // released inside `finalizeRun` rather than killing the child here.
    const finishDriverRun = () => {
      turnCompleted = true;
      if (!terminalEventTimer && !finalized) {
        terminalEventTimer = setTimeout(() => {
          terminalEventTimer = null;
          if (!persistentAntigravity) killAgentChild(child);
          finalizeRun(0);
        }, 400);
      }
    };

    const acpDriver =
      model.providerId === 'fx'
        ? createFxAcpDriver({
            child,
            cwd: input.projectPath,
            promptText: input.prompt,
            attachments: input.attachments,
            resumeSessionId,
            accessMode: input.accessMode || 'full-access',
            routes: fxLaunch?.routes ?? [],
            mcpServers: orionAcpMcpServers(orionMcp),
            callbacks: {
              ...sharedDriverCallbacks,
              onNotice: (notice) => {
                if (finalized) return;
                emitAgentEvent(event.sender, {
                  runId,
                  threadId: input.threadId,
                  type: 'chunk',
                  chunk: notice,
                });
              },
              onTurnEnd: (result) => {
                const stats = fxStatsFromPromptResult(result);
                if (stats) runStats = stats;
                finishDriverRun();
              },
            },
          })
        : model.providerId === 'antigravity'
        ? createAntigravityAcpDriver({
            child,
            cwd: input.projectPath,
            model,
            reasoningEffort: input.antigravityReasoningEffort ?? legacyAntigravity?.effort,
            promptText: input.prompt,
            systemPromptAppend: input.systemPromptAppend,
            attachments: input.attachments,
            resumeSessionId,
            accessMode: input.accessMode || 'full-access',
            mcpServers: orionAcpMcpServers(orionMcp),
            httpMcpServers: orionAcpHttpMcpServers(orionMcp),
            threadId: input.threadId,
            sessionState: persistentAntigravity ? antigravityLease.entry : null,
            nextRequestId: persistentAntigravity ? antigravityLease.nextRequestId : null,
            callbacks: {
              ...sharedDriverCallbacks,
              // Each invoke_subagent child shows as a live subagent thread
              // fed by its own transcript (antigravity-child-work.js).
              onSubagentSpawn: ({ id, role, prompt, parentSessionId }) => {
                let childId = null;
                subagentTracker.start(
                  { id, title: role, kind: 'antigravity agent', ...(prompt ? { prompt } : {}) },
                  {
                    resolveFile: async () => {
                      childId ??= await resolveAntigravityChild(parentSessionId, id);
                      const file = childId ? antigravityChildTranscriptPath(childId) : null;
                      return file && existsSync(file) ? file : null;
                    },
                    handleLine: handleAntigravitySubagentLine,
                  }
                );
              },
              onSubagentDone: (id, info) => subagentTracker.finish(id, info),
              onSessionBroken: () => {
                antigravitySessionBroken = true;
                emitAgentEvent(event.sender, {
                  runId,
                  threadId: input.threadId,
                  type: 'session-broken',
                  providerId: 'antigravity',
                });
              },
              onSlashCommands: (commands) => {
                if (typeof input.projectPath !== 'string' || !input.projectPath) return;
                antigravityLiveSlashCommandsByProject.set(input.projectPath, commands);
                void discoverAntigravitySkills({ cwd: input.projectPath })
                  .catch(() => [])
                  .then((skills) => {
                    if (event.sender.isDestroyed()) return;
                    event.sender.send('agent:slashCommands', {
                      projectPath: input.projectPath,
                      providerId: 'antigravity',
                      commands: mergeAntigravitySlashCommands(commands, skills),
                    });
                  });
              },
              // A spawn_subagent child asks whoever spawned it: its question
              // stays in its reply text (agy prints the choices) instead of a
              // card the user would answer for someone else.
              ...(input.spawnedSubagent
                ? {}
                : {
                    onUserInput: () => {
                      emitAgentEvent(event.sender, { runId, threadId: input.threadId, type: 'user-input' });
                    },
                  }),
              onTurnEnd: (result) => {
                const stats = antigravityStatsFromPromptResult(result);
                if (stats) runStats = stats;
                finishDriverRun();
              },
            },
          })
        : model.providerId === 'kimi'
        ? createKimiAcpDriver({
            child,
            cwd: input.projectPath,
            model,
            promptText: input.prompt,
            attachments: input.attachments,
            resumeSessionId,
            accessMode: input.accessMode || 'full-access',
            mcpServers: orionAcpMcpServers(orionMcp),
            callbacks: {
              ...sharedDriverCallbacks,
              onSessionId: (sessionId, sessionMeta) => {
                sharedDriverCallbacks.onSessionId(sessionId);
                void ensureKimiSpawnWatcher(sessionId, sessionMeta?.resumed === true);
              },
              onTurnEnd: (_result, sessionId) => {
                // The ACP prompt response carries no usage metadata — pull
                // cumulative session totals from the on-disk wire log before
                // the run finalizes. kimi flushes the turn's final
                // usage.record right around the prompt response, so give the
                // write a moment to land before reading.
                void (async () => {
                  await new Promise((resolve) => setTimeout(resolve, 350));
                  const stats = await kimiStatsFromSessionDisk(sessionId);
                  if (stats) runStats = stats;
                  finishDriverRun();
                })();
              },
            },
          })
        : useAcp
      ? createGrokAcpDriver({
          child,
          cwd: input.projectPath,
          promptText: input.prompt,
          attachments: input.attachments,
          resumeSessionId,
          accessMode: input.accessMode || 'full-access',
          callbacks: {
            ...sharedDriverCallbacks,
            onTurnEnd: (result) => {
              const stats = grokStatsFromPromptMeta(result?._meta);
              if (stats) runStats = stats;
              finishDriverRun();
            },
            onSubagent: (update) => {
              const childId =
                (typeof update.child_session_id === 'string' && update.child_session_id) ||
                (typeof update.subagent_id === 'string' && update.subagent_id) ||
                null;
              if (!childId) return;
              if (update.sessionUpdate === 'subagent_spawned') {
                subagentTracker.start(
                  {
                    id: childId,
                    title:
                      typeof update.description === 'string' && update.description
                        ? update.description
                        : 'Subagent',
                    kind:
                      typeof update.subagent_type === 'string' ? update.subagent_type : undefined,
                    model: typeof update.model === 'string' ? update.model : undefined,
                  },
                  {
                    resolveFile: async () => {
                      const file = grokSubagentUpdatesFile(input.projectPath, childId);
                      return existsSync(file) ? file : null;
                    },
                    handleLine: handleGrokSubagentLine,
                  }
                );
              } else if (update.sessionUpdate === 'subagent_finished') {
                subagentTracker.finish(childId, {
                  status: update.status === 'completed' ? 'done' : 'error',
                  stats:
                    typeof update.tokens_used === 'number'
                      ? { totalTokens: update.tokens_used }
                      : undefined,
                  summary:
                    typeof update.output === 'string' ? update.output.slice(0, 4000) : undefined,
                });
              }
            },
          },
        })
      : useCodexAppServer
        ? createCodexAppServerDriver({
            child,
            cwd: input.projectPath,
            model,
            input: { ...runtimeInput, orionMcp },
            goal: input.codexGoal,
            review: input.codexReview,
            resumeSessionId,
            accessMode: input.accessMode || 'full-access',
            callbacks: {
              ...sharedDriverCallbacks,
              onStats: (stats) => {
                runStats = stats;
              },
              onSubagent: receiveCodexSubagentMetadata,
              onGoal: (goal) => {
                emitAgentEvent(event.sender, {
                  runId,
                  threadId: input.threadId,
                  type: 'goal',
                  goal,
                });
              },
              onRunEnd: finishDriverRun,
              onRetainUserInputs: (requests) => completedCodexQuestions.retain(runId, requests),
              onUserInput: useCodexReview ? undefined : () => {
                emitAgentEvent(event.sender, { runId, threadId: input.threadId, type: 'user-input' });
              },
            },
          })
        : null;
    if (useCodexGoal && acpDriver) codexGoalRunDrivers.set(runId, acpDriver);
    if (model.providerId === 'fx' && acpDriver) fxSteerableRunDrivers.set(runId, acpDriver);
    if (model.providerId === 'antigravity' && acpDriver) antigravityRunDrivers.set(runId, acpDriver);
    if (useCodexAppServer && !useCodexGoal && !useCodexReview && acpDriver) {
      codexSteerableRunDrivers.set(runId, acpDriver);
    }

    emitAgentEvent(event.sender, {
      runId,
      threadId: input.threadId,
      type: 'started',
      // App-server runs have no trailing prompt to strip.
      command: persistentCodexAppServer
        ? `${model.command} app-server (persistent)`
        : persistentAntigravity
        ? `${model.command} acp (persistent)`
        : `${model.command} ${(
            useCodexAppServer ? args.slice(1) : args.slice(1, -1)
          ).join(' ')}`,
    });

    if (persistentAntigravity && antigravityLease) {
      antigravityLease.attachHandlers({
        onMessage: (parsed) => {
          if (finalized) return;
          stdoutSeen = true;
          acpDriver?.handleMessage(parsed);
        },
        onStderr: (chunk) => {
          stderr += chunk;
        },
        onClose: (exitCode) => {
          activeAgentRuns.delete(runId);
          const wasStopped = stoppedAgentRuns.delete(runId);
          if (finalized) return;
          void finalizeRun(exitCode ?? 1, { wasStopped });
        },
      });
    } else {
    child.stdout.on('data', (data) => {
      if (finalized) return;
      const raw = data.toString();
      if (!jsonMode) {
        stdoutSeen = stdoutSeen || raw.trim().length > 0;
        emitAgentEvent(event.sender, {
          runId,
          threadId: input.threadId,
          type: 'chunk',
          chunk: raw,
        });
        return;
      }

      jsonBuffer += raw;
      const lines = jsonBuffer.split(/\r?\n/);
      jsonBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (acpDriver) acpDriver.handleMessage(parsed);
          else emitParsedJsonEvent(parsed);
        } catch {
          stdoutSeen = true;
          // Never leak raw agent protocol JSON (e.g. {"type":"thought",...}) into the chat transcript
          const looksLikeProtocol =
            /^\s*[\{\[]/.test(trimmed) &&
            (/"type"\s*:/i.test(trimmed) ||
              /"data"\s*:/i.test(trimmed) ||
              /"thought"/i.test(trimmed) ||
              /"jsonrpc"/i.test(trimmed));
          if (!looksLikeProtocol) {
            emitAgentEvent(event.sender, {
              runId,
              threadId: input.threadId,
              type: 'chunk',
              chunk: `${trimmed}\n`,
            });
          }
        }
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      activeAgentRuns.delete(runId);
      emitAgentEvent(event.sender, {
        runId,
        threadId: input.threadId,
        type: 'error',
        error: error.message,
      });
    });

    // 'close' waits for the stdio pipes to drain, not just process exit. An
    // agent-spawned background process (e.g. a dev server left running for
    // the user) inherits those pipes and can hold them open forever, so
    // finalize from 'exit' if 'close' doesn't follow shortly.
    child.on('exit', (exitCode, signal) => {
      if (finalized || exitFallbackTimer) return;
      exitFallbackTimer = setTimeout(() => {
        exitFallbackTimer = null;
        finalizeRun(exitCode ?? (signal ? 1 : 0), {
          wasStopped: stoppedAgentRuns.has(runId),
        });
      }, 2000);
    });

    child.on('close', async (exitCode) => {
      activeAgentRuns.delete(runId);
      const wasStopped = stoppedAgentRuns.delete(runId);
      if (finalized) return;

      // A failed shared-server connection is infrastructure failure, not a
      // missing Codex thread. Preserve the same resume id and retry once
      // against a direct app-server instead of silently throwing the
      // conversation away.
      if (
        exitCode !== 0 &&
        persistentCodexAppServer &&
        !stdoutSeen &&
        !codexActionAccepted &&
        !wasStopped &&
        !turnCompleted
      ) {
        finalized = true;
        clearFinalizeTimers();
        codexSteerableRunDrivers.delete(runId);
        fxSteerableRunDrivers.delete(runId);
        antigravityRunDrivers.delete(runId);
        await acpDriver?.dispose?.();
        codexSpawnWatcher?.stop();
        kimiSpawnWatcher?.stop();
        subagentTracker.dispose('error');
        codexAppServerLease?.release();
        codexAppServerLease = null;
        emitAgentEvent(event.sender, {
          runId,
          threadId: input.threadId,
          type: 'chunk',
          chunk: resumeSessionId
            ? '_Codex service connection restarted; resuming the previous session._\n\n'
            : '_Codex service connection restarted; retrying this turn._\n\n',
        });
        // thread/start may have succeeded before the socket failed. Resume
        // the reported thread so retrying cannot fork an unrelated session.
        startAttempt(acceptedCodexSessionId, true);
        return;
      }

      // Legacy providers can retry a missing session fresh. Codex must retain
      // its session id on all failures, including an exit before RPC output.
      if (
        exitCode !== 0 &&
        model.providerId !== 'codex' &&
        resumeSessionId &&
        !stdoutSeen &&
        !codexActionAccepted &&
        !wasStopped &&
        !turnCompleted
      ) {
        finalized = true;
        clearFinalizeTimers();
        codexSteerableRunDrivers.delete(runId);
        fxSteerableRunDrivers.delete(runId);
        antigravityRunDrivers.delete(runId);
        await acpDriver?.dispose?.();
        codexSpawnWatcher?.stop();
        kimiSpawnWatcher?.stop();
        subagentTracker.dispose('error');
        emitAgentEvent(event.sender, {
          runId,
          threadId: input.threadId,
          type: 'chunk',
          chunk: '_Could not resume the previous session; starting a fresh one._\n\n',
        });
        startAttempt(null);
        return;
      }

      await finalizeRun(exitCode, { wasStopped });
    });
    }

    acpDriver?.start();
    };

    // A stop/steer raced the startup above and aborted the run before any
    // process existed — honor it instead of launching a run the renderer
    // already settled and untracked.
    const abortedStartup = startingAgentRuns.get(runId);
    if (abortedStartup?.aborted) {
      codexAppServerLease?.release();
      codexAppServerLease = null;
      if (antigravityLease) {
        await antigravityLease.release({ keepAlive: antigravityLease.reused });
        antigravityLease = null;
      } else {
        orionMcp?.release();
      }
      // A normal stop is already settled by the renderer and retains the
      // historical successful-startup result. Runtime disposal can also come
      // directly from workspace removal, though, so report that distinct
      // abort as a startup failure and let hidden renderer runs settle even
      // when no terminal event can be emitted.
      if (abortedStartup.abortError) {
        return { ok: false, error: abortedStartup.abortError };
      }
      return { ok: true, runId };
    }

    try {
      startAttempt(initialResumeId);
    } catch (error) {
      codexAppServerLease?.release();
      codexAppServerLease = null;
      await releaseRunStartupResources();
      throw error;
    }

    return { ok: true, runId };
  } catch (error) {
    console.error('agent:runTurn error', error);
    return { ok: false, error: error?.message ?? String(error) };
  } finally {
    startingAgentRuns.delete(runId);
  }
});

// Deliver a message into the provider's active turn. Codex has a native
// turn/steer RPC, fx a steering session/prompt; Claude interrupts its
// blocking SDK loop and immediately continues it. False preserves the message as an ordinary queued follow-up.
ipcMain.handle('agent:steerTurn', async (_event, runId, text, attachments) => {
  if (typeof runId !== 'string' || typeof text !== 'string' || !text) return false;
  // A steered turn may continue in a new transcript message.
  forgetAgentRunOutputMessage(runId);
  if (await steerCodexAppServerRun(runId, text, attachments)) return true;
  if (await steerFxRun(runId, text, attachments)) return true;
  if (await steerAntigravityRun(runId, text, attachments)) return true;
  return await steerClaudeSdkRun(runId, text, attachments);
});

// A user action answered or seen done (user-actions.js): tell the agent
// without interrupting it. Codex and fx fold a steer in at their next model
// boundary; Claude gets it at its next tool call or in a turn of its own.
// `runId` is the thread's running run, which must own the delivery; with
// none, only a Claude thread (`providerId`) can be re-invoked from here.
// `notice` becomes an activity on the run that receives it. False: nothing
// took it, and the renderer sends it as an ordinary message.
ipcMain.handle('agent:notifyTurn', async (event, { threadId, runId, providerId, text, notice } = {}) => {
  if (typeof threadId !== 'string' || typeof text !== 'string' || !text) return false;
  const activity = {
    key: `user-action-${crypto.randomUUID()}`,
    type: 'result',
    title: typeof notice?.title === 'string' ? notice.title : 'The user answered',
    ...(typeof notice?.detail === 'string' ? { detail: notice.detail } : {}),
    status: 'done',
  };
  if (typeof runId === 'string' && runId) {
    if (
      (await steerCodexAppServerRun(runId, text, [])) ||
      (await steerFxRun(runId, text, [])) ||
      (await steerAntigravityRun(runId, text, []))
    ) {
      emitAgentEvent(event.sender, { runId, threadId, type: 'activity', activity });
      return true;
    }
    return notifyClaudeSession(threadId, { text, activity }, { runId });
  }
  return providerId === 'claude' && notifyClaudeSession(threadId, { text, activity });
});

// Watching a user action's `check` (user-actions.js). The renderer decides
// which actions are watched and re-arms them after a restart.
ipcMain.handle('agent:watchUserAction', (event, { threadId, id, check, cwd } = {}) =>
  watchUserAction({ threadId, id, check, cwd, getSender: () => event.sender })
);
ipcMain.handle('agent:unwatchUserAction', (_event, { threadId, id } = {}) => {
  if (typeof threadId !== 'string' && typeof id !== 'string') return false;
  unwatchUserActions({ threadId, id });
  return true;
});

// request_secret (secret-requests.js): the user's answer from the private
// card. The value goes straight to an owner-only file; only its path reaches
// the agent.
ipcMain.handle('agent:answerSecretRequest', (_event, input) => answerSecretRequest(input ?? {}));
ipcMain.handle('agent:listSecretRequests', () => listPendingSecretRequests());

const listCodexQuestions = (threadId) => {
  const drivers = new Map([...codexSteerableRunDrivers, ...codexGoalRunDrivers, ...antigravityRunDrivers]);
  return [...completedCodexQuestions.list(threadId), ...[...drivers].flatMap(([runId, driver]) =>
    (driver.getUserInputs?.() ?? [])
      .filter((request) => request.threadId === threadId)
      .map((request) => ({ ...request, runId }))
  )];
};
const listClaudeQuestions = (threadId) => claudeSdkSessions.get(threadId)?.userInputs?.list() ?? [];
// Every question or approval a thread's agent waits on (paired controllers
// show and answer them too: remote-control.js).
const listAgentQuestions = (threadId) => [...listCodexQuestions(threadId), ...listClaudeQuestions(threadId)];

ipcMain.handle('agent:getCodexQuestions', (_event, threadId) => listCodexQuestions(threadId));

ipcMain.handle('agent:answerCodexQuestions', async (event, runId, requestId, answers, text) => {
  const driver =
    codexSteerableRunDrivers.get(runId) ?? codexGoalRunDrivers.get(runId) ?? antigravityRunDrivers.get(runId);
  if (typeof text === 'string' && text.trim()) {
    const question = driver?.getUserInputs?.().find((entry) => entry.requestId === requestId) ??
      completedCodexQuestions.list().find((entry) => entry.runId === runId && entry.requestId === requestId);
    const result = await completedCodexQuestions.deliver(runId, requestId, answers, text, driver);
    if (result && question) emitAgentEvent(event.sender, { runId, threadId: question.threadId, type: 'user-input' });
    return result;
  }
  const retained = completedCodexQuestions.answer(runId, requestId, answers);
  if (retained) {
    emitAgentEvent(event.sender, { runId, threadId: retained.threadId, type: 'user-input' });
    return true;
  }
  return driver?.answerUserInput?.(requestId, answers) ?? false;
});

ipcMain.handle('agent:getClaudeQuestions', (_event, threadId) => listClaudeQuestions(threadId));
ipcMain.handle('agent:answerClaudeQuestions', (_event, runId, requestId, answers) => {
  for (const session of claudeSdkSessions.values()) {
    if (session.userInputs?.answer(runId, requestId, answers)) return true;
  }
  return false;
});

ipcMain.handle('agent:discardClaudeBackgroundShellTasks', (_event, runId) => {
  if (typeof runId !== 'string' || !runId) {
    return { ok: false, error: 'A Claude run id is required.' };
  }
  return discardClaudeBackgroundShellTasks(runId);
});

ipcMain.handle('agent:stopTurn', async (_event, runId, options) => {
  if (await interruptClaudeSdkRun(runId, options)) return true;
  const run = activeAgentRuns.get(runId);
  if (!run) {
    // Still in agent:runTurn's async startup: nothing to kill yet — mark the
    // startup aborted (it checks before spawning / registering the turn) and
    // report the run as interrupted.
    const starting = startingAgentRuns.get(runId);
    if (starting) {
      starting.aborted = true;
      starting.abortController?.abort(new Error('Agent startup was cancelled.'));
      starting.terminateBackground = Boolean(options?.terminateBackground);
      return true;
    }
    return false;
  }
  stoppedAgentRuns.add(runId);
  await codexSteerableRunDrivers.get(runId)?.dispose?.();
  codexSteerableRunDrivers.delete(runId);
  fxSteerableRunDrivers.delete(runId);
  if (antigravityRunDrivers.has(runId)) {
    try {
      await cancelAntigravityRun(runId);
    } catch {}
    antigravityRunDrivers.delete(runId);
  }
  // Stopping a goal run = pausing the goal: ask the app-server to record the
  // pause (so the stored goal matches reality and /goal resume works) before
  // the process goes down.
  const goalDriver = codexGoalRunDrivers.get(runId);
  if (goalDriver) {
    codexGoalRunDrivers.delete(runId);
    try {
      await goalDriver.stopGoalRun();
    } catch {}
  }
  const shutdown = killAgentChild(run.child, run.threadId);
  activeAgentRuns.delete(runId);
  // Workspace removal uses terminateBackground and must not delete the
  // process's cwd until SIGTERM/SIGKILL has actually reaped it. Ordinary Stop/Steer
  // remains responsive and lets the global shutdown tracker finish the reap.
  if (options?.terminateBackground) await shutdown;
  return true;
});

// True while a run's terminal event is still being prepared (the run itself
// is already forgotten). Terminal events are sent before this flips back to
// false, and IPC preserves ordering — so once this returns false, either the
// renderer has already received the outcome or none is coming.
ipcMain.handle('agent:isRunFinalizing', (_event, runId) => finalizingAgentRuns.has(runId));

ipcMain.handle('agent:codexGoal', async (_event, input) => {
  const threadId = typeof input?.threadId === 'string' ? input.threadId : '';
  try {
    if (appShutdownRequested) {
      return { ok: false, error: appShutdownError() };
    }
    if (!input?.sessionId || !threadId || !input?.projectPath || !input?.action) {
      return { ok: false, error: 'Missing sessionId, threadId, projectPath, or action.' };
    }
    if (!['pause', 'clear', 'get'].includes(input.action)) {
      return { ok: false, error: `Unsupported goal action: ${input.action}` };
    }
    const controller = new AbortController();
    const operationEntry = { controller, promise: null };
    let threadOperations = codexGoalOpsByThread.get(threadId);
    if (!threadOperations) {
      threadOperations = new Set();
      codexGoalOpsByThread.set(threadId, threadOperations);
    }
    threadOperations.add(operationEntry);
    const operation = (async () => {
      const available = await checkCommandAvailable('codex');
      if (controller.signal.aborted) {
        return { ok: false, error: 'Codex goal operation was cancelled.' };
      }
      if (!available) return { ok: false, error: 'codex is not installed or not on PATH.' };
      const appServerLease = await codexAppServerManager.acquire();
      try {
        return await runCodexGoalOp({
          sessionId: input.sessionId,
          threadId,
          cwd: input.projectPath,
          action: input.action,
          signal: controller.signal,
          ...(appServerLease.persistent
            ? { appServerChild: appServerLease.child }
            : {}),
        });
      } finally {
        appServerLease.release();
      }
    })();
    operationEntry.promise = operation;
    try {
      return await operation;
    } finally {
      threadOperations.delete(operationEntry);
      if (threadOperations.size === 0) codexGoalOpsByThread.delete(threadId);
    }
  } catch (error) {
    console.error('agent:codexGoal error', error);
    return { ok: false, error: error?.message ?? String(error) };
  }
});

async function disposeAgentThreadRuntime(threadId) {
  if (typeof threadId !== 'string' || !threadId) return false;
  // Cancel and drain startup work too. It may not own a child process yet,
  // but it can still be resolving sessions, and must not spawn after its
  // workspace is removed.
  let cancelledStartup = false;
  for (const starting of startingAgentRuns.values()) {
    if (starting.threadId !== threadId) continue;
    starting.aborted = true;
    starting.terminateBackground = true;
    starting.abortError = 'The thread runtime was disposed during agent startup.';
    starting.abortController?.abort(new Error(starting.abortError));
    cancelledStartup = true;
  }
  invalidateTerminalSession(threadId);
  const terminalShutdown = disposeTerminalSessionAndWait(threadId);
  const goalShutdown = disposeCodexGoalOpsForThread(threadId);
  const titleShutdown = disposeTitleGenerationsForThread(threadId);
  // Also reap any live run process for the thread (e.g. a wedged ACP server
  // whose run the renderer no longer tracks): thread teardown must not leave
  // an orphaned CLI behind.
  const runShutdowns = [];
  for (const [runId, run] of activeAgentRuns) {
    if (run.threadId !== threadId) continue;
    // Marks the exit as intentional so the run finalizes as stopped, not as a
    // provider error.
    stoppedAgentRuns.add(runId);
    runShutdowns.push(killAgentChild(run.child, threadId));
    activeAgentRuns.delete(runId);
  }
  const [disposedTerminal, disposedClaude, disposedAntigravity, disposedGoals, disposedTitles, disposedAgent] =
    await Promise.all([
      terminalShutdown,
      disposeClaudeSdkSessionAndWait(threadId),
      antigravitySessionManager.disposeThread(threadId),
      goalShutdown,
      titleShutdown,
      waitForAgentThreadShutdowns(threadId),
      ...runShutdowns,
    ]);
  if (cancelledStartup) {
    const deadline = Date.now() + 3000;
    while (
      [...startingAgentRuns.values()].some((starting) => starting.threadId === threadId) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if ([...startingAgentRuns.values()].some((starting) => starting.threadId === threadId)) {
      throw new Error(`Agent startup for thread ${threadId} did not stop in time.`);
    }
  }
  // A Claude startup can install a session after the first disposal snapshot
  // but before it observes the aborted startup flag. Repeat the acknowledged
  // disposal after startup drain so no late session outlives workspace removal.
  const disposedLateClaude = await disposeClaudeSdkSessionAndWait(threadId);
  return (
    disposedClaude ||
    disposedLateClaude ||
    disposedAntigravity ||
    disposedTerminal ||
    disposedGoals ||
    disposedTitles ||
    disposedAgent ||
    runShutdowns.length > 0 ||
    cancelledStartup
  );
}

ipcMain.handle('agent:disposeThread', (_event, threadId) =>
  disposeAgentThreadRuntime(threadId)
);

// -------------------- Claude Code CLI terminal sessions --------------------
// One PTY per thread hosting the interactive `claude` TUI. The PTY lives in
// main and survives view remounts/thread switches; the renderer reattaches by
// replaying the scrollback snapshot, then applying data events whose seq is
// newer than the snapshot's (invoke replies and pushed events aren't strictly
// ordered, so the per-session seq disambiguates).

const terminalSessions = new Map(); // threadId -> { pty, scrollback, seq, exited, exitCode, accessMode, projectPath, claudeSessionId }
const terminatingTerminalSessions = new Map(); // threadId -> Set<session>
// Explicit teardown (model switch/thread deletion) can race an async
// terminal:ensure before it has installed a session. Epochs let teardown
// invalidate those pending starts so they cannot spawn an invisible PTY.
const terminalSessionEpochs = new Map();
const TERMINAL_SCROLLBACK_LIMIT = 400_000; // chars kept for reattach replay

const invalidateTerminalSession = (threadId) => {
  terminalSessionEpochs.set(threadId, (terminalSessionEpochs.get(threadId) ?? 0) + 1);
};

const disposeTerminalSession = (threadId) => {
  const session = terminalSessions.get(threadId);
  if (!session) return false;
  terminalSessions.delete(threadId);
  if (!session.exited) {
    let terminating = terminatingTerminalSessions.get(threadId);
    if (!terminating) {
      terminating = new Set();
      terminatingTerminalSessions.set(threadId, terminating);
    }
    terminating.add(session);
  }
  if (session.sessionWatcher) clearInterval(session.sessionWatcher);
  disposeTerminalHookSignals(session);
  try {
    if (!session.exited) session.pty.kill();
  } catch {
    // already gone
  }
  return true;
};

const disposeTerminalSessionAndWait = async (threadId, timeoutMs = 3000) => {
  const sessions = new Set(terminatingTerminalSessions.get(threadId) ?? []);
  const activeSession = terminalSessions.get(threadId);
  if (activeSession) {
    disposeTerminalSession(threadId);
    sessions.add(activeSession);
  }
  if (sessions.size === 0) return false;
  if ([...sessions].every((session) => session.exited)) return true;

  let timeoutId;
  const exited = await Promise.race([
    Promise.all([...sessions].map((session) => session.exitPromise)).then(() => true),
    new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  if (!exited) {
    throw new Error(`Claude terminal for thread ${threadId} did not stop in time.`);
  }
  return true;
};

// claude's per-project session store (~/.claude/projects/<encoded-cwd>).
// The encoding is the realpath'd cwd with every non-alphanumeric replaced by
// '-'; realpath matters because claude records its own resolved cwd (e.g.
// /tmp -> /private/tmp on macOS).
const claudeProjectDirFor = async (projectPath) => {
  let realProjectPath = projectPath;
  try {
    realProjectPath = await fs.realpath(projectPath);
  } catch {
    // keep the raw path
  }
  return path.join(
    os.homedir(),
    '.claude',
    'projects',
    realProjectPath.replace(/[^a-zA-Z0-9]/g, '-')
  );
};

// A distinctive plain-text slice of a prompt that will appear verbatim inside
// the session's JSONL (JSON string escaping mangles quotes/newlines/etc., so
// pick the longest run of unescaped characters).
const terminalPromptMarker = (text) => {
  const segments = String(text)
    .split(/[\\"\n\r\t\u0000-\u001f]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 12);
  segments.sort((a, b) => b.length - a.length);
  return segments[0]?.slice(0, 120) ?? null;
};

const rememberTerminalPrompt = (session, text) => {
  const marker = terminalPromptMarker(text);
  if (!marker) return;
  session.sentPrompts.push(marker);
  if (session.sentPrompts.length > 5) session.sentPrompts.shift();
};

// xterm's onData stream is usually one character at a time, but paste and
// IME input can arrive in larger chunks. Keep a lightweight approximation of
// the current prompt so pressing Enter through the terminal itself records the
// same transcript marker as the GUI composer. Exact cursor editing is not
// required for attribution: a distinctive unchanged slice is enough to match
// the prompt in Claude's JSONL session file.
const trackTerminalPromptInput = (session, rawData) => {
  const data = String(rawData ?? '');
  let submittedPrompt = false;
  for (let index = 0; index < data.length; index += 1) {
    const char = data[index];

    if (char === '\x1b') {
      // Ignore terminal control sequences (arrows, bracketed-paste markers,
      // function keys). A bare Meta prefix leaves the following character to
      // be processed normally.
      const csi = data.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
      if (csi) {
        index += csi[0].length - 1;
        continue;
      }
      if (data[index + 1] === 'O' && data[index + 2]) {
        index += 2;
        continue;
      }
      continue;
    }

    if (char === '\r' || char === '\n') {
      submittedPrompt ||= Boolean(session.inputBuffer.trim());
      rememberTerminalPrompt(session, session.inputBuffer);
      session.inputBuffer = '';
      continue;
    }
    if (char === '\x7f' || char === '\b') {
      session.inputBuffer = [...session.inputBuffer].slice(0, -1).join('');
      continue;
    }
    if (char === '\x03' || char === '\x15') {
      // Ctrl+C / Ctrl+U clear the pending line.
      session.inputBuffer = '';
      continue;
    }
    if (char === '\x17') {
      // Ctrl+W deletes the previous word.
      session.inputBuffer = session.inputBuffer.replace(/\S+\s*$/u, '');
      continue;
    }
    if (char === '\t') {
      session.inputBuffer += '\t';
      continue;
    }
    if (char < ' ') continue;

    session.inputBuffer += char;
    if (session.inputBuffer.length > 8000) {
      session.inputBuffer = session.inputBuffer.slice(-8000);
    }
  }
  return submittedPrompt;
};

// The interactive claude TUI ignores --session-id (verified: conversations
// persist under their own fresh id), so the thread's resumable session id has
// to be discovered from claude's session store: a
// ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl written after this PTY
// spawned. Other writers share that directory (SDK threads, other terminals,
// the user's own claude runs — and claude can flush transcripts minutes
// late), so a candidate only counts when it contains a prompt this terminal
// actually submitted. Markers come from both the GUI composer and raw xterm
// input, avoiding an unsafe "newest transcript wins" guess.
const startTerminalSessionWatcher = (threadId, session, projectPath) => {
  const spawnedAt = Date.now();
  const projectDirPromise = claudeProjectDirFor(projectPath);
  session.sessionWatcher = setInterval(() => {
    void (async () => {
      if (session.exited || session.claudeSessionId) {
        clearInterval(session.sessionWatcher);
        session.sessionWatcher = null;
        return;
      }
      // Never guess from the newest project transcript. Multiple Orion and
      // external Claude processes can write this directory concurrently.
      if (session.sentPrompts.length === 0) return;
      try {
        const dir = await projectDirPromise;
        const entries = await fs.readdir(dir).catch(() => []);
        const candidates = [];
        for (const entry of entries) {
          if (!entry.endsWith('.jsonl')) continue;
          const stats = await fs.stat(path.join(dir, entry)).catch(() => null);
          if (!stats || stats.mtimeMs < spawnedAt) continue;
          candidates.push({ id: entry.slice(0, -'.jsonl'.length), mtimeMs: stats.mtimeMs });
        }
        candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const candidate of candidates) {
          const content = await fs
            .readFile(path.join(dir, `${candidate.id}.jsonl`), 'utf-8')
            .catch(() => '');
          if (!session.sentPrompts.some((marker) => content.includes(marker))) continue;
          session.claudeSessionId = candidate.id;
          sendToAllWindows('terminal:session', { threadId, sessionId: candidate.id });
          clearInterval(session.sessionWatcher);
          session.sessionWatcher = null;
          break;
        }
      } catch {
        // transient fs error; retry next tick
      }
    })();
  }, 2500);
};

// The PTY stays alive between turns, so process exit says nothing about turn
// completion — the reliable lifecycle signal is Claude Code's own hooks. Each
// session gets a private settings file (passed via --settings, which layers on
// top of the user's settings so their own hooks still run) whose
// UserPromptSubmit/Stop hooks append one line to a per-session signal file.
// Main watches that file and forwards the lines as terminal:activity events,
// letting the renderer flip the thread between running and done while the TUI
// keeps running. Stop does not fire on a user interrupt (esc) — an interrupted
// thread stays "running" until its next completed turn or PTY exit.
const TERMINAL_HOOK_DIR = path.join(os.tmpdir(), 'orion-claude-hooks');

const createTerminalHookFiles = async (threadId, epoch) => {
  const base = `${threadId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${epoch}`;
  const signalPath = path.join(TERMINAL_HOOK_DIR, `${base}.signals`);
  const settingsPath = path.join(TERMINAL_HOOK_DIR, `${base}.settings.json`);
  const appendSignal = (kind) => `printf '${kind}\\n' >> ${shellQuote(signalPath)}`;
  await fs.mkdir(TERMINAL_HOOK_DIR, { recursive: true });
  await fs.writeFile(signalPath, '');
  await fs.writeFile(
    settingsPath,
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: appendSignal('prompt') }] }],
        Stop: [{ hooks: [{ type: 'command', command: appendSignal('stop') }] }],
      },
    })
  );
  return { signalPath, settingsPath };
};

const startTerminalSignalWatcher = (threadId, session) => {
  let draining = false;
  let queued = false;
  const drain = async () => {
    if (draining) {
      queued = true;
      return;
    }
    draining = true;
    try {
      do {
        queued = false;
        if (terminalSessions.get(threadId) !== session) return;
        const content = await fs.readFile(session.signalPath, 'utf-8').catch(() => '');
        // The hooks only ever append; replay lines past the last read offset.
        const fresh = content.slice(session.signalReadOffset);
        session.signalReadOffset = content.length;
        for (const line of fresh.split('\n')) {
          const kind = line.trim();
          if (!kind) continue;
          if (terminalSessions.get(threadId) !== session) return;
          if (kind === 'prompt') {
            sendToAllWindows('terminal:activity', { threadId, kind: 'prompt' });
          } else if (kind === 'stop') {
            sendToAllWindows('terminal:activity', { threadId, kind: 'turn-complete' });
          }
        }
      } while (queued);
    } finally {
      draining = false;
    }
  };
  try {
    session.signalWatcher = watchFsPath(session.signalPath, () => void drain());
  } catch (error) {
    console.warn('terminal hook signal watch failed, polling instead', error);
    const timer = setInterval(() => void drain(), 1000);
    session.signalWatcher = { close: () => clearInterval(timer) };
  }
};

const disposeTerminalHookSignals = (session) => {
  if (session.signalWatcher) {
    try {
      session.signalWatcher.close();
    } catch {
      // already closed
    }
    session.signalWatcher = null;
  }
  if (session.signalPath) void fs.unlink(session.signalPath).catch(() => {});
  if (session.settingsPath) void fs.unlink(session.settingsPath).catch(() => {});
};

const disposeAllTerminalSessions = () => {
  for (const threadId of terminalSessionEpochs.keys()) {
    invalidateTerminalSession(threadId);
  }
  for (const threadId of [...terminalSessions.keys()]) {
    disposeTerminalSession(threadId);
  }
};

// Spawn (or reattach to) the thread's claude TUI. Composer-sent prompts let
// the watcher discover the CLI's persisted session id for restart/resume.
ipcMain.handle('terminal:ensure', async (_event, input) => {
  try {
    if (appShutdownRequested) {
      return { ok: false, error: appShutdownError() };
    }
    const threadId = typeof input?.threadId === 'string' ? input.threadId : '';
    const projectPath = typeof input?.projectPath === 'string' ? input.projectPath : '';
    const accessMode =
      input?.accessMode === 'read-only' ||
      input?.accessMode === 'workspace-write' ||
      input?.accessMode === 'full-access'
        ? input.accessMode
        : 'workspace-write';
    if (!threadId || !projectPath) {
      return { ok: false, error: 'threadId and projectPath are required' };
    }
    // A newer ensure supersedes any older pending start for the same thread
    // (for example, when access mode changes while node-pty is still loading).
    const ensureEpoch = (terminalSessionEpochs.get(threadId) ?? 0) + 1;
    terminalSessionEpochs.set(threadId, ensureEpoch);

    let session = terminalSessions.get(threadId);
    if (
      session &&
      (input?.fresh ||
        input?.restart ||
        session.accessMode !== accessMode ||
        session.projectPath !== projectPath)
    ) {
      disposeTerminalSession(threadId);
      session = null;
    }
    if (session) {
      if (!session.exited) {
        sendToAllWindows('terminal:activity', { threadId, kind: 'started' });
      }
      return {
        ok: true,
        reattached: true,
        claudeSessionId: session.claudeSessionId,
        snapshot: session.scrollback,
        seq: session.seq,
        ...(session.exited
          ? { exited: true, exitCode: session.exitCode ?? null }
          : {}),
      };
    }

    if (!(await checkCommandAvailable('claude'))) {
      return { ok: false, error: 'claude is not installed or not on PATH.' };
    }

    let ptyModule;
    try {
      ptyModule = await import('node-pty');
    } catch (error) {
      console.error('terminal:ensure node-pty load failed', error);
      return {
        ok: false,
        error: `Terminal support unavailable (node-pty failed to load): ${error?.message ?? error}`,
      };
    }

    const isUuid = (value) =>
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

    const accessArgs =
      accessMode === 'full-access'
        ? ['--dangerously-skip-permissions']
        : ['--permission-mode', accessMode === 'read-only' ? 'plan' : 'acceptEdits'];
    const args = ['claude', ...accessArgs];
    // Orion's general instructions bind this session like a global CLAUDE.md,
    // but only when claude is launched from Orion — appending to the system
    // prompt leaves the project's real CLAUDE.md untouched for outside runs.
    const generalInstructions =
      typeof input?.generalInstructions === 'string' ? input.generalInstructions.trim() : '';
    if (generalInstructions) args.push('--append-system-prompt', generalInstructions);
    let claudeSessionId = null;
    if (!input?.fresh && isUuid(input?.resumeSessionId)) {
      // Only resume when claude actually persisted that conversation: it
      // buffers transcripts in memory and can flush minutes late (or never,
      // for sessions killed early), and --resume on a missing id exits(1).
      const transcriptPath = path.join(
        await claudeProjectDirFor(projectPath),
        `${input.resumeSessionId}.jsonl`
      );
      const transcriptExists = await fs
        .stat(transcriptPath)
        .then((stats) => stats.isFile())
        .catch(() => false);
      if (transcriptExists) {
        const forkSession = input?.forkSession === true;
        // A branch resumes the inherited transcript only as the source for a
        // new conversation. Keep the id unknown until the watcher discovers
        // Claude's newly-created fork and reports it to the renderer.
        claudeSessionId = forkSession ? null : input.resumeSessionId;
        args.push('--resume', input.resumeSessionId);
        if (forkSession) args.push('--fork-session');
      }
    }

    const hookFiles = await createTerminalHookFiles(threadId, ensureEpoch).catch((error) => {
      // Turn-lifecycle signals are an enhancement; a temp-dir failure should
      // not block the terminal itself.
      console.warn('terminal hook settings unavailable', error);
      return null;
    });
    if (hookFiles) args.push('--settings', hookFiles.settingsPath);

    if ((terminalSessionEpochs.get(threadId) ?? 0) !== ensureEpoch) {
      return { ok: false, error: 'Terminal start was cancelled.' };
    }

    const commandString = args.map(shellQuote).join(' ');
    const cols = Math.max(20, Math.floor(Number(input?.cols)) || 120);
    const rows = Math.max(5, Math.floor(Number(input?.rows)) || 30);
    const ptyProcess = ptyModule.spawn(loginShell, ['-lc', commandString], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: projectPath,
      env: withClaudeEnv({ ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }),
    });

    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    session = {
      pty: ptyProcess,
      scrollback: '',
      seq: 0,
      exited: false,
      exitCode: null,
      accessMode,
      projectPath,
      claudeSessionId,
      sessionWatcher: null,
      // Markers from composer- and xterm-submitted prompts, used by the
      // session watcher to attribute an on-disk transcript to this terminal.
      sentPrompts: [],
      // Best-effort current input line for prompts typed directly into xterm.
      inputBuffer: '',
      // Turn-lifecycle signal file appended to by the injected Claude hooks.
      signalPath: hookFiles?.signalPath ?? null,
      settingsPath: hookFiles?.settingsPath ?? null,
      signalReadOffset: 0,
      signalWatcher: null,
      exitPromise,
      resolveExit,
    };
    terminalSessions.set(threadId, session);
    startTerminalSessionWatcher(threadId, session, projectPath);
    if (session.signalPath) startTerminalSignalWatcher(threadId, session);
    sendToAllWindows('terminal:activity', { threadId, kind: 'started' });

    ptyProcess.onData((data) => {
      // A fresh start/access-mode/project change can replace this PTY before its
      // final callbacks drain. Never let the superseded process write into
      // the replacement terminal's renderer stream.
      if (terminalSessions.get(threadId) !== session) return;
      session.seq += 1;
      session.scrollback = (session.scrollback + data).slice(-TERMINAL_SCROLLBACK_LIMIT);
      sendToAllWindows('terminal:data', { threadId, data, seq: session.seq });
    });
    ptyProcess.onExit(({ exitCode }) => {
      session.exited = true;
      session.exitCode = exitCode ?? null;
      session.resolveExit?.();
      const terminating = terminatingTerminalSessions.get(threadId);
      if (terminating) {
        terminating.delete(session);
        if (terminating.size === 0) terminatingTerminalSessions.delete(threadId);
      }
      // disposeTerminalSession removes the old session before killing it. If
      // another PTY now owns this thread id, its view must not receive the
      // old process's delayed exit event.
      if (terminalSessions.get(threadId) !== session) return;
      if (session.sessionWatcher) {
        clearInterval(session.sessionWatcher);
        session.sessionWatcher = null;
      }
      // Exit is itself the terminal status signal; hook signals are moot now.
      disposeTerminalHookSignals(session);
      sendToAllWindows('terminal:exit', { threadId, exitCode: exitCode ?? null });
    });

    return {
      ok: true,
      reattached: false,
      claudeSessionId,
      snapshot: session.scrollback,
      seq: session.seq,
    };
  } catch (error) {
    console.error('terminal:ensure error', error);
    return { ok: false, error: error?.message ?? String(error) };
  }
});

// Raw keystrokes from the embedded xterm.
ipcMain.handle('terminal:input', (_event, input) => {
  const session = terminalSessions.get(input?.threadId);
  if (!session || session.exited) return false;
  const data = String(input?.data ?? '');
  const submittedPrompt = trackTerminalPromptInput(session, data);
  session.pty.write(data);
  if (submittedPrompt) {
    sendToAllWindows('terminal:activity', { threadId: input.threadId, kind: 'prompt' });
  }
  return true;
});

ipcMain.handle('terminal:resize', (_event, input) => {
  const session = terminalSessions.get(input?.threadId);
  if (!session || session.exited) return false;
  const cols = Math.floor(Number(input?.cols));
  const rows = Math.floor(Number(input?.rows));
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return false;
  try {
    session.pty.resize(cols, rows);
  } catch {
    return false;
  }
  return true;
});

// GUI composer → TUI: deliver the draft as a bracketed paste (so multi-line
// prompts land as one input) and press Enter once the TUI has ingested it —
// exactly as if the user had typed it in the terminal.
ipcMain.handle('terminal:sendPrompt', async (_event, input) => {
  const session = terminalSessions.get(input?.threadId);
  if (!session || session.exited) {
    return { ok: false, error: 'The Claude Code terminal is not running.' };
  }
  const text = String(input?.text ?? '').replace(/\r\n/g, '\n');
  if (!text.trim()) return { ok: false, error: 'Nothing to send' };
  rememberTerminalPrompt(session, text);
  session.inputBuffer = '';
  session.pty.write(`\x1b[200~${text}\x1b[201~`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (session.exited) return { ok: false, error: 'The Claude Code terminal exited.' };
  session.pty.write('\r');
  sendToAllWindows('terminal:activity', { threadId: input.threadId, kind: 'prompt' });
  return { ok: true };
});

ipcMain.handle('terminal:kill', (_event, threadId) => {
  if (typeof threadId !== 'string' || !threadId) return false;
  invalidateTerminalSession(threadId);
  return disposeTerminalSession(threadId);
});

// Run a single non-streaming prompt through a provider CLI in read-only mode
// and return the model's plain-text reply ('' on any failure). Backs the
// hidden utility turns: thread titles and commit/PR messages.
const runOneShotAgentText = async (
  model,
  prompt,
  projectPath,
  { signal, threadId, reasoningEffort } = {}
) => {
  const cwd = projectPath || process.cwd();
  if (signal?.aborted) return '';

  // OpenCode's non-interactive command does not currently expose a mode that
  // Orion can enforce as read-only. Hidden utility turns must fail closed
  // instead of inheriting the user's normal repository permissions.
  if (model.providerId === 'opencode') {
    return '';
  }

  // kimi's prompt mode auto-approves every tool and rejects --plan, so a
  // one-shot `kimi -p` would silently run this hidden turn with full write
  // access. Drive the turn over ACP plan mode instead, which disables tool
  // execution.
  if (model.providerId === 'kimi') {
    return (await kimiPlanModeOneShot(model, prompt, cwd, { signal, threadId })) || '';
  }
  // Antigravity turns only run over ACP; Read only policy denies every
  // non-read tool, so the hidden turn cannot change anything.
  if (model.providerId === 'antigravity') {
    return (
      (await antigravityReadOnlyOneShot(model, prompt, cwd, {
        signal,
        threadId,
        reasoningEffort: reasoningEffort || 'low',
      })) || ''
    );
  }
  // fx turns only run over ACP; its ask mode with every permission denied
  // keeps the hidden turn read-only.
  if (model.providerId === 'fx') {
    return (await fxReadOnlyOneShot(model, prompt, cwd, { signal, threadId })) || '';
  }

  // Reuse the command builder but force read-only access for the hidden turn.
  // The effort comes from Settings → Text generation (which defaults to the
  // cheapest tier) rather than the provider default: inheriting GPT-5.6's
  // 'high' spends and stalls far more than a title or commit message is worth.
  const effort = reasoningEffort || 'low';
  const args = commandForModel(model, {
    prompt,
    projectPath: cwd,
    accessMode: 'read-only',
    // Utility turns generate disposable metadata. Never let them consume local
    // or Chronicle memories, or become source material for future memories.
    ...(model.providerId === 'codex'
      ? { providerOptions: codexUtilityPrivacyOptions }
      : {}),
    ...(model.providerId === 'codex' ? { codexReasoningEffort: effort } : {}),
    ...(model.providerId === 'claude' ? { claudeReasoningEffort: effort } : {}),
    ...(model.providerId === 'grok' ? { grokReasoningEffort: effort } : {}),
    ...(model.providerId === 'muse' ? { museReasoningEffort: effort } : {}),
  });

  const commandString = args.map(shellQuote).join(' ');
  return await new Promise((resolve) => {
    const child = spawn(loginShell, ['-lc', commandString], {
      cwd,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let deadline = null;
    const cleanup = () => {
      if (deadline) clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    // Cancellation is stronger than ordinary completion: do not release the
    // caller until the provider child has actually exited, because the caller
    // may remove the child's working directory next.
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void killAgentChild(child, threadId).then(() => resolve(''));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    // A provider CLI stalled on auth or network input would otherwise pin the
    // awaiting caller forever — the navbar commit holds its busy state on
    // this promise. Cap the turn and reap the child; callers
    // fall back to their non-LLM message.
    deadline = setTimeout(abort, 120_000);

    let stdout = '';
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    // Drain diagnostics so a chatty failed CLI cannot block on a full pipe.
    // They are never valid generated text.
    child.stderr.resume();

    child.on('error', () => finish(''));

    child.on('close', (code) => {
      if (code !== 0) {
        finish('');
        return;
      }

      finish(utilityReplyFromOutput(stdout, model.providerId));
    });
  });
};

// Look up a model id, verify its CLI is on PATH, and run a one-shot prompt.
// `options.reasoningEffort` comes from Settings → Text generation.
const runOneShotForModelId = async (modelId, prompt, projectPath, options) => {
  if (!modelId) return '';
  if (options?.signal?.aborted) return '';
  const models = await getAgentModels();
  if (options?.signal?.aborted) return '';
  const legacyAntigravity = models.some((candidate) => candidate.id === modelId)
    ? null
    : resolveLegacyAntigravityModelId(models, modelId);
  const model = models.find((candidate) => candidate.id === modelId) ?? legacyAntigravity?.model;
  if (!model) return '';
  if (!(await checkCommandAvailable(model.command))) return '';
  if (options?.signal?.aborted) return '';
  return runOneShotAgentText(model, prompt, projectPath, {
    ...options,
    reasoningEffort: options?.reasoningEffort ?? legacyAntigravity?.effort,
  });
};

// Generate a short, relevant title for a thread based on the first user prompt.
// This runs a lightweight non-streaming call and returns just the title string.
ipcMain.handle('agent:generateTitle', async (_event, input) => {
  if (appShutdownRequested) return '';
  const threadId = typeof input?.threadId === 'string' ? input.threadId : '';
  if (!threadId || !input?.prompt || !input?.modelId) return '';
  const controller = new AbortController();
  const generation = { controller, promise: null };
  let threadGenerations = titleGenerationsByThread.get(threadId);
  if (!threadGenerations) {
    threadGenerations = new Set();
    titleGenerationsByThread.set(threadId, threadGenerations);
  }
  threadGenerations.add(generation);
  const operation = (async () => {
    const models = await getAgentModels();
    if (controller.signal.aborted) return '';
    const model = models.find((candidate) => candidate.id === input.modelId);
    if (!model) return '';

    const available = await checkCommandAvailable(model.command);
    if (!available || controller.signal.aborted) return '';

    const titleInstruction =
      'Reply with ONLY a concise, specific title (3-8 words) for the following user request. ' +
      'Do not work on the request or use any tools; only name it. ' +
      'No quotes, no explanations, no trailing punctuation. Just the title.\n\n' +
      'Request:\n' +
      input.prompt;

    // An empty folder, not the project: the request alone names the thread,
    // and in the project the model loads its instructions, skills and tools
    // and starts exploring the repository as if it were the task.
    let scratch = '';
    try {
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'durango-title-'));
      if (controller.signal.aborted) return '';
      return titleFromResponseText(
        await runOneShotAgentText(model, titleInstruction, scratch, {
          signal: controller.signal,
          threadId,
          reasoningEffort: input.reasoningEffort,
        })
      );
    } finally {
      if (scratch) void fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  })();
  generation.promise = operation;
  try {
    return await operation;
  } catch (e) {
    console.error('agent:generateTitle error', e);
    return '';
  } finally {
    threadGenerations.delete(generation);
    if (threadGenerations.size === 0) titleGenerationsByThread.delete(threadId);
  }
});

// Plain-English explanation of a tool call waiting for approval, written by
// the text-generation model. Keyed by the request so both panes of a split
// view, a remount, or a reopened window share one hidden turn.
const approvalExplanations = new Map(); // key -> Promise<explanation | null>
ipcMain.handle('agent:explainApproval', async (_event, input) => {
  if (appShutdownRequested) return null;
  const key = typeof input?.key === 'string' ? input.key : '';
  const threadId = typeof input?.threadId === 'string' ? input.threadId : '';
  const approval = input?.approval;
  if (!key || !threadId || !input?.modelId || typeof approval?.toolName !== 'string') return null;
  const cached = approvalExplanations.get(key);
  if (cached) return cached;
  const controller = new AbortController();
  const generation = { controller, promise: null };
  let threadGenerations = titleGenerationsByThread.get(threadId);
  if (!threadGenerations) {
    threadGenerations = new Set();
    titleGenerationsByThread.set(threadId, threadGenerations);
  }
  threadGenerations.add(generation);
  const operation = (async () => {
    // The call's text is untrusted and reaches a hidden read-only turn, so
    // that turn runs in an empty folder (no project files or instructions in
    // reach by relative path); the real folder is only named in the prompt.
    let scratch = '';
    try {
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'durango-approval-'));
      const text = await runOneShotForModelId(
        input.modelId,
        approvalExplainPrompt(approval, typeof input.projectPath === 'string' ? input.projectPath : ''),
        scratch,
        { signal: controller.signal, threadId, reasoningEffort: input.reasoningEffort }
      );
      const explanation = parseApprovalExplanation(text);
      // A clipped call was only partly explained: no verdict on the whole.
      return explanation && approvalExplainTruncated(approval) ? { ...explanation, risk: null, partial: true } : explanation;
    } catch (error) {
      console.error('agent:explainApproval error', error);
      return null;
    } finally {
      if (scratch) void fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
      threadGenerations.delete(generation);
      if (threadGenerations.size === 0) titleGenerationsByThread.delete(threadId);
    }
  })();
  generation.promise = operation;
  approvalExplanations.set(key, operation);
  // Only a handful are ever live; drop the oldest past that, and forget a
  // failure so a reopened card can try again.
  if (approvalExplanations.size > 40) approvalExplanations.delete(approvalExplanations.keys().next().value);
  const result = await operation;
  if (!result && approvalExplanations.get(key) === operation) approvalExplanations.delete(key);
  return result;
});

// Path helpers (so renderer doesn't need node path)
ipcMain.handle('project:findIcon', async (_event, projectPath) => {
  try {
    return await findProjectIcon(projectPath, { nativeImage });
  } catch (error) {
    console.error('project:findIcon error', error);
    return null;
  }
});

// "Open with" apps (macOS): detect installed apps and open the project in them.
// cliRelPaths: VS Code-fork CLI binaries inside the bundle. Launching through
// them opens the folder in an editor window; `open -a` can land on the app's
// agents/dashboard view instead (e.g. Cursor).
const OPEN_WITH_CANDIDATES = [
  {
    id: 'cursor',
    name: 'Cursor',
    bundles: ['Cursor.app'],
    cliRelPaths: ['Contents/Resources/app/bin/cursor', 'Contents/Resources/app/bin/code'],
  },
  // Prefer the code-editor app ("Antigravity IDE.app") over the agents app ("Antigravity.app").
  {
    id: 'antigravity',
    name: 'Antigravity',
    bundles: ['Antigravity IDE.app', 'Antigravity.app'],
    cliRelPaths: ['Contents/Resources/app/bin/antigravity-ide'],
  },
  { id: 'ghostty', name: 'Ghostty', bundles: ['Ghostty.app'] },
  {
    id: 'terminal',
    name: 'Terminal',
    bundles: [],
    absolutePaths: [
      '/System/Applications/Utilities/Terminal.app',
      '/Applications/Utilities/Terminal.app',
    ],
  },
  {
    id: 'finder',
    name: 'Finder',
    bundles: [],
    absolutePaths: ['/System/Library/CoreServices/Finder.app'],
  },
  {
    id: 'vscode',
    name: 'VS Code',
    bundles: ['Visual Studio Code.app'],
    cliRelPaths: ['Contents/Resources/app/bin/code'],
  },
];

let openWithAppsCache = null;

function resolveOpenWithAppPath(candidate) {
  const roots = [path.join(app.getPath('home'), 'Applications'), '/Applications'];
  const candidatePaths = [
    ...(candidate.absolutePaths ?? []),
    ...candidate.bundles.flatMap((bundle) => roots.map((root) => path.join(root, bundle))),
  ];
  return candidatePaths.find((appPath) => existsSync(appPath)) ?? null;
}

// app.getFileIcon returns a generic document icon for .app bundles on macOS,
// so pull the real icon out of the bundle (Info.plist -> .icns -> png via sips).
async function extractMacAppIcon(appPath) {
  try {
    const resourcesDir = path.join(appPath, 'Contents', 'Resources');
    const candidates = [];
    try {
      const { stdout } = await execFileAsync('plutil', [
        '-extract', 'CFBundleIconFile', 'raw', '-o', '-',
        path.join(appPath, 'Contents', 'Info.plist'),
      ]);
      const iconFile = stdout.trim();
      if (iconFile) {
        candidates.push(
          path.join(resourcesDir, iconFile.endsWith('.icns') ? iconFile : `${iconFile}.icns`)
        );
      }
    } catch {
      // No CFBundleIconFile entry; fall through to common icon names.
    }
    candidates.push(path.join(resourcesDir, 'AppIcon.icns'));
    let icnsPath = candidates.find((candidate) => existsSync(candidate));
    if (!icnsPath) {
      const entries = await fs.readdir(resourcesDir).catch(() => []);
      const firstIcns = entries.find((name) => name.endsWith('.icns'));
      if (firstIcns) icnsPath = path.join(resourcesDir, firstIcns);
    }
    if (!icnsPath) return null;

    const outPath = path.join(app.getPath('temp'), `orion-openwith-${crypto.randomUUID()}.png`);
    try {
      await execFileAsync('sips', [
        '-s', 'format', 'png', '--resampleHeightWidthMax', '64',
        icnsPath, '--out', outPath,
      ]);
      const image = nativeImage.createFromPath(outPath);
      return image.isEmpty() ? null : image.toDataURL();
    } finally {
      await fs.unlink(outPath).catch(() => {});
    }
  } catch {
    return null;
  }
}

ipcMain.handle('openWith:listApps', async () => {
  if (process.platform !== 'darwin') return [];
  if (openWithAppsCache) return openWithAppsCache;

  const apps = [];
  for (const candidate of OPEN_WITH_CANDIDATES) {
    const appPath = resolveOpenWithAppPath(candidate);
    if (!appPath) continue;
    // Icon is optional; the renderer falls back to a generic glyph.
    const icon = await extractMacAppIcon(appPath);
    apps.push({ id: candidate.id, name: candidate.name, icon });
  }
  openWithAppsCache = apps;
  return apps;
});

ipcMain.handle('openWith:open', async (_event, input) => {
  const { appId, projectPath } = input ?? {};
  try {
    if (typeof projectPath !== 'string' || !existsSync(projectPath)) {
      return { ok: false, error: 'Project folder not found' };
    }
    const candidate = OPEN_WITH_CANDIDATES.find((entry) => entry.id === appId);
    if (!candidate) return { ok: false, error: 'Unknown app' };

    if (candidate.id === 'finder') {
      const error = await shell.openPath(projectPath);
      return error ? { ok: false, error } : { ok: true };
    }

    const appPath = resolveOpenWithAppPath(candidate);
    if (!appPath) return { ok: false, error: `${candidate.name} is not installed` };

    const cliPath = (candidate.cliRelPaths ?? [])
      .map((rel) => path.join(appPath, rel))
      .find((cli) => existsSync(cli));
    if (cliPath) {
      try {
        await execFileAsync(cliPath, [projectPath]);
        return { ok: true };
      } catch (error) {
        console.error(`openWith: ${candidate.id} CLI failed, falling back to open -a`, error);
      }
    }
    await execFileAsync('open', ['-a', appPath, projectPath]);
    return { ok: true };
  } catch (error) {
    console.error('openWith:open error', error);
    return { ok: false, error: error?.message ?? 'Failed to open' };
  }
});

// --- Agent skills (Settings → Skills) -----------------------------------------

ipcMain.handle('skills:list', async () => {
  await bundledSkillsReady;
  return listSkills();
});

ipcMain.handle('skills:import', async (event, input) =>
  importSkills({
    window: BrowserWindow.fromWebContents(event.sender),
    paths: input?.paths,
  })
);

ipcMain.handle('skills:setEnabled', async (_event, input) =>
  setSkillEnabled({ id: input?.id, enabled: input?.enabled })
);

ipcMain.handle('skills:delete', async (event, input) =>
  deleteSkill({
    window: BrowserWindow.fromWebContents(event.sender),
    id: input?.id,
    skillPath: input?.path,
    enabled: input?.enabled,
    confirm: input?.confirm !== false,
  })
);

ipcMain.handle('skills:reveal', async (_event, input) =>
  revealSkill({ id: input?.id, skillPath: input?.path, enabled: input?.enabled })
);

ipcMain.handle('skills:openFolder', async () => openSkillsFolder());

// --- MCP servers (Settings → Skills & MCPs) ----------------------------------

ipcMain.handle('mcps:list', async () => listMcps());

ipcMain.handle('mcps:setEnabled', async (_event, input) =>
  setMcpEnabled({ id: input?.id, enabled: input?.enabled })
);

// MCP servers connected to Orion itself (any provider, @-mentionable).
ipcMain.handle('orionMcps:list', async () => listOrionMcps());
ipcMain.handle('accountConnectors:list', async () => ({
  ...(await accountConnectors.list()),
  manageUrl: new URL('/?settings=connectors', await durangoClient.baseUrl()).toString(),
}));
ipcMain.handle('orionMcps:add', async (_event, input) => addOrionMcp(input));
ipcMain.handle('orionMcps:update', async (_event, input) => updateOrionMcp(input));
ipcMain.handle('orionMcps:remove', async (_event, input) => removeOrionMcp(input));
ipcMain.handle('orionMcps:reconnect', async (_event, input) => reconnectOrionMcp(input));
ipcMain.handle('orionMcps:cancelSignIn', async (_event, input) => cancelOrionMcpSignIn(input?.id, input?.operationId));
// MCP servers connected to Claude Code or Codex directly, and sharing one
// into Orion so every provider loads it.
ipcMain.handle('providerMcps:list', async (_event, input) => listProviderMcps(input));
ipcMain.handle('providerMcps:share', async (_event, input) => shareProviderMcp(input));

// --- Dev servers (Settings → Dev Servers) --------------------------------------

ipcMain.handle('devServers:list', async (_event, input) => {
  // Snapshot the live registries here — the scanner module stays free of
  // main.js state. Ancestry roots: agent CLI children and thread PTYs.
  const agentPidThreads = [];
  for (const run of activeAgentRuns.values()) {
    if (run?.child?.pid) agentPidThreads.push({ pid: run.child.pid, threadId: run.threadId });
  }
  const terminalPidThreads = [];
  for (const [threadId, session] of terminalSessions) {
    if (session?.pty?.pid && !session.exited) terminalPidThreads.push({ pid: session.pty.pid, threadId });
  }
  // Claude SDK sessions spawn their CLI internally (no pid we can see), so
  // they contribute a cwd match instead of an ancestry root.
  const sessionThreadCwds = [];
  for (const [threadId, session] of claudeSdkSessions) {
    if (session?.projectPath && !session.ended && !session.disposed) {
      sessionThreadCwds.push({ cwd: session.projectPath, threadId });
    }
  }
  return listDevServers({
    roots: Array.isArray(input?.roots) ? input.roots.filter((root) => typeof root === 'string') : [],
    agentPidThreads,
    terminalPidThreads,
    sessionThreadCwds,
  });
});

ipcMain.handle('devServers:open', async (_event, input) => {
  try {
    await shell.openExternal(devServerUrlForPort(input?.port));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('devServers:kill', async (_event, input) =>
  killDevServers({ targets: Array.isArray(input?.targets) ? input.targets : [] })
);

// Usage view: token usage from the agents' session logs on this machine,
// priced at API list prices (src/main/usage-stats.js). The first scan reads
// every log (seconds for gigabytes); later ones read only what was appended.
configureUsageLimits(() => app.getPath('userData'));
let usageStore = null;
const getUsageStore = () => {
  usageStore ??= createUsageStore({
    cacheFile: path.join(app.getPath('userData'), 'usage-cache.json'),
    onProgress: (progress) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('usage:progress', progress);
      }
    },
  });
  return usageStore;
};

const USAGE_RANGES = new Set(['24h', '7d', '30d', '90d']);
const USAGE_SOURCES = new Set(['all', 'durango', 'thread', 'subagent', 'bot', 'other']);

ipcMain.handle('usage:report', async (_event, input) => {
  try {
    const userData = app.getPath('userData');
    await loadUsagePrices(userData);
    void refreshUsagePrices(userData);
    const store = getUsageStore();
    await store.scan({ force: input?.refresh === true });
    const links = new Map();
    for (const link of Array.isArray(input?.links) ? input.links : []) {
      if (typeof link?.sessionId !== 'string' || !link.sessionId) continue;
      if (link.kind === 'thread' || link.kind === 'subagent') links.set(link.sessionId, link.kind);
    }
    const report = buildUsageReport(store.entries(), {
      range: USAGE_RANGES.has(input?.range) ? input.range : '7d',
      provider: typeof input?.provider === 'string' ? input.provider : 'all',
      source: USAGE_SOURCES.has(input?.source) ? input.source : 'all',
      links,
    });
    return {
      ok: true,
      report: {
        ...report,
        generatedAt: Date.now(),
        prices: usagePricesInfo(),
        limits: { claude: claudeRateLimits(), codex: latestCodexLimits(store.entries()) },
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Limits read live from Claude Code's, Codex's, Antigravity's and Grok's
// own quota endpoints (provider-usage-limits.js).
ipcMain.handle('usage:liveLimits', async (_event, input) => {
  try {
    configureCodexLiveLimits(codexAppServerManager, app.getVersion?.() ?? '0.0.0');
    return {
      ok: true,
      limits: await readProviderUsageLimits({
        force: input?.force === true,
        ...(Array.isArray(input?.providers) ? { providers: input.providers.filter((id) => typeof id === 'string') } : {}),
      }),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('path:basename', (_e, p) => path.basename(p));
ipcMain.handle('path:dirname', (_e, p) => path.dirname(p));
ipcMain.handle('path:join', (_e, ...parts) => path.join(...parts));
