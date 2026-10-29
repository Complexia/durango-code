// Must stay the first import: pins the internal app name and legacy userData
// path before any other module evaluates (see docs/durango-rebrand.md).
import './main/pin-app-identity.js';
// Then: a legacy /Applications/Orion.app renames itself to Durango Code.app
// and relaunches (Dock/Finder show the bundle file name).
import './main/rename-legacy-bundle-on-start.js';
import { createRepositoryCredentials } from './main/repository-credentials.js';
import { INTERNAL_APP_NAME, PRODUCT_DISPLAY_NAME, devUserDataPath } from './main/app-identity.js';
import { DEFAULT_DEV_WEB_URL, DEFAULT_PACKAGED_WEB_URL } from './main/web-origin.js';
import { isPreviewFilePath } from './app/codeFiles.ts';
import { migrateWorkspaceSyncSettings } from './app/workspaceSyncConsent.ts';
import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, dialog, Menu, nativeImage, net, Notification, powerMonitor, protocol, safeStorage, shell, systemPreferences } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  unwatchFile,
  watch as watchFsPath,
  watchFile,
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
import { browseDirectories, resolveProjectDirectory } from './main/project-browse.js';
import { appUpdateDownloadedVersion, appUpdateState, checkForAppUpdate, getAppIconPath, initializeAppUpdater, invalidateAppUpdateDownload, publishAppUpdateState, scheduleAppUpdateChecks, waitForAppUpdateStagedForInstall } from './main/app-updater.js';
import { withClaudeEnv } from './main/claude-env.js';
import { claudeSdkSessions, discardClaudeBackgroundShellTasks, disposeAllClaudeSdkSessions, disposeClaudeSdkSession, disposeClaudeSdkSessionAndWait, interruptClaudeSdkRun, listClaudeSlashCommands, runClaudeSdkTurn, steerClaudeSdkRun } from './main/claude-driver.js';
import { devServerUrlForPort, killDevServers, listDevServers } from './main/dev-servers.js';
import { codexBrowserUseMode, codexUtilityPrivacyOptions, splitCodexConfigContextArgs } from './main/codex-config.js';
import { codexBrowserOptionsForIntegration, probeCodexBrowserIntegration } from './main/codex-browser-integration.js';
import { codexAppServerManager } from './main/codex-app-server-manager.js';
import { spawnCodexServerProcess } from './main/codex-server-process.js';
import { codexGoalRunDrivers, codexSteerableRunDrivers, createCodexAppServerDriver, runCodexGoalOp, steerCodexAppServerRun } from './main/codex-driver.js';
import { createCompletedCodexQuestions } from './main/codex-questions.js';
import { commandForModel } from './main/command-for-model.js';
import { validateAgentWorkspace } from './main/agent-run-preflight.js';
import { captureGitChangeSnapshot, commandSucceeds, commitMessageForEntries, getCurrentGitBranch, getGitRoot, getGitStateForPath, getGitStatusMap, invalidateTreeGitStatusCache, readGitStatusEntries, summarizeChangedFiles, validateNewBranchName } from './main/git-utils.js';
import { createFxAcpDriver, fxReadOnlyOneShot, fxStatsFromPromptResult, fxSteerableRunDrivers, steerFxRun } from './main/fx-driver.js';
import { configureFxProvider, installFx, prepareFxLaunch, readFxConnections } from './main/fx-provider.js';
import { createKimiAcpDriver, handleKimiSubagentLine, kimiPlanModeOneShot, kimiStatsFromSessionDisk, watchKimiSubagentSpawns } from './main/kimi-driver.js';
import { legacyMcpCleanupPromise, openCodeMcpConfigContent, orionAcpMcpServers, pendingSubagentSpawns, pendingSubagentStops, providerSupportsRunPlugin, providerSupportsThreadReader, registerMcpBridgeForRun, startLegacyMcpCleanup, writeMuseMcpConfigRoot } from './main/mcp-bridge.js';
import { isEffectiveThreadReaderBridgeReady, isMcpBridgeProvider, isRequiredThreadReaderBridgeMissing } from './main/thread-reader-routing.js';
import { DurangoError, createDurangoClient, createDurangoCredentials, createMockDurangoClient } from './main/durango-client.js';
import { createBoardTasks, durangoTasksEnabled } from './main/board-tasks.js';
import {
  createDispatchWorker,
  dispatchSourceLabel,
  dispatchSourceUrl,
  normalizeDispatchSettings,
} from './main/durango-dispatch.js';
import { createProfileMemoryCache, durangoErrorText, setDurangoToolsClient } from './main/durango-tools.js';
import { readImportableSessions, scanImportableSessions } from './main/session-import.js';
import { clearThreadsStorage, readThreadById, readThreadsByIds, readThreadsBatch, readThreadsHead, readThreadsIndex, writeThreadsPatch, writeThreadsPatchSync } from './main/thread-storage.js';
import { ensureMediaExtension, getMimeTypeForMediaPath, mediaPreviewExtensions, sanitizeAttachmentName } from './main/media.js';
import {
  configureAgentModelsCache,
  getAgentModels,
  invalidateAgentModelsCache,
  listAgentModelsWithAvailability,
  onAgentModelsChanged,
} from './main/models.js';
import { appProtocol, attachmentProtocol, getAccountSessionFilePath, getAttachmentDirectoryPath, getNoProjectDirectoryPath, getStorageFilePath, storageFileName, threadsDirectoryName, threadsFileName } from './main/paths.js';
import { authenticateProviderTool, checkProviderUpdates, getProcessErrorMessage, getProviderStatuses, normalizeEnabledProviderIds, providerAuthenticationGenerations, providerUpdaterConfigs, updateProviderTool, waitForProviderAuthentication } from './main/provider-updates.js';
import { activeAgentRuns, finalizingAgentRuns, killAgentChild, startingAgentRuns, stoppedAgentRuns, trackAgentShutdown, waitForAgentThreadShutdowns, waitForPendingAgentShutdowns } from './main/run-registry.js';
import { checkCommandAvailable, execFileAsync, loginShell, runShellCommand, shellQuote, startShellPathSync } from './main/shell-env.js';
import { extractSessionIdFromJsonEvent, isTerminalJsonEvent, jsonAdapterForProvider, sendsJsonEvents, stringifySummary } from './main/stream-adapters.js';
import { syncOrchestrationInstructionFiles } from './main/orchestration-files.js';
import { deleteSkill, ensureBundledSkills, importSkills, listSkills, openSkillsFolder, revealSkill, setSkillEnabled } from './main/skills.js';
import { listMcps, readMcpRuntimeConfig, setMcpEnabled } from './main/mcps.js';
import { addOrionMcp, cancelOrionMcpSignIn, claudeOrionMcpServers, listOrionMcps, museOrionMcpServers, reconnectOrionMcp, removeOrionMcp, resolveOrionMcpsForRun, updateOrionMcp, withCodexOrionMcps } from './main/orion-mcps.js';
import { assertOpenCodeMcpNamesAvailable, listProviderMcps, shareProviderMcp, withoutClaudeNativeMcps, withoutCodexNativeMcps } from './main/provider-mcps.js';
import { findKimiSessionIndexEntry, forkSessionOnDisk } from './main/session-fork.js';
import { addAgentEventListener, emitAgentEvent, sendToAllWindows } from './main/events.js';
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
  shutdownRemoteControl,
  startRemotePairing,
  stopRemoteTurn,
  waitForRemoteControlPersistence,
} from './main/remote-control.js';
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
import { bundledCliEntry, bundledCliVersion, ensureCliSignedIn, installBundledCliShims, readCliCredential } from './main/bundled-cli.js';
import {
  createDurangoWorkspace,
  durangoWorkspaceStatus,
  findDurangoWorkspace,
  inspectDurangoWorkspaceProject,
  landDurangoWorkspace,
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
  const clear = () => {
    webContents.removeListener('did-start-loading', clear);
    webContents.removeListener('render-process-gone', clear);
    webContents.removeListener('destroyed', clear);
    if (remoteCommandRenderer === webContents) {
      remoteCommandRenderer = null;
      notifyRemoteCommandRendererLost();
    }
    if (remoteCommandRendererCleanup === clear) remoteCommandRendererCleanup = null;
  };
  remoteCommandRendererCleanup = clear;
  webContents.once('did-start-loading', clear);
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

const getOrionWebUrl = () => {
  // Packaged builds talk to the live site (code.durango.sh; orioncode.xyz is
  // a legacy alias of the same service); development defaults to the local
  // Durango Code web dev server. ORION_WEB_URL overrides either.
  const defaultWebUrl = app.isPackaged ? DEFAULT_PACKAGED_WEB_URL : DEFAULT_DEV_WEB_URL;
  const rawUrl = process.env.ORION_WEB_URL || defaultWebUrl;
  const url = new URL(rawUrl);
  url.hash = '';
  url.search = '';
  return url;
};

const remotePairingProofRequest = async (method, body, token, { signal } = {}) => {
  const { response, data } = await fetchRemotePairingProofJson({
    url: new URL('/api/desktop-auth/remote-pairing-proof', getOrionWebUrl()),
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
 * Bearer-authed call to the relay APIs on orion-next. The desktop account
 * token authenticates THESE calls and never leaves this function: what comes
 * back is a short-lived relay ticket, and that is all the relay ever sees.
 */
const relayApiRequest = async (apiPath, body, { signal, method, allowNotFound = false } = {}) => {
  const session = await readAccountSession();
  if (!session?.token) throw new Error('Sign in to your Durango account first.');
  const { response, data } = await fetchRelayApiJson({
    url: new URL(apiPath, getOrionWebUrl()),
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
  origin: () => getOrionWebUrl().toString(),
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
  webOrigin: () => getOrionWebUrl().toString(),
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
    });
setDurangoToolsClient(durangoClient);
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
  inMemoryAccountSession = null;
  // Authorization ends when sign-out begins, not after the session file has
  // finished being removed. This synchronously closes remote listeners and
  // sessions before any account transition can await filesystem work.
  notifyRemoteControlAccountChanged(null, { reconcile: false });
  // Durango Chat dispatch stops polling the moment sign-out begins.
  dispatchWorker.accountChanged(durangoMock);
  await Promise.all([repositoryClear, durangoClear.catch(() => {})]);
  await fs.rm(getAccountSessionFilePath(), { force: true });
};

const publishAccountState = async (session) => {
  const effectiveSession = session === undefined ? await readAccountSession() : session;
  const account = desktopAccountForRenderer(effectiveSession);
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
  // Same for Durango Chat dispatch (never claims while signed out).
  dispatchWorker.accountChanged(durangoMock || account.authenticated);
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
    const response = await fetch(new URL('/api/desktop-auth/session', getOrionWebUrl()), {
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
  const url = new URL('/desktop/authorize', getOrionWebUrl());
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
  const response = await fetch(new URL('/api/desktop-auth/exchange', getOrionWebUrl()), {
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
    await writeAccountSession(session);
    repositoryCredentials.resume();
    await publishAccountState(session);
    void readRepositorySession().catch(() => {});
    warmDurangoKey();
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

app.on('second-instance', (_event, argv) => {
  const callbackUrl = argv.find((arg) => isDesktopAuthCallbackUrl(arg));
  if (callbackUrl) {
    void handleDesktopAuthCallback(callbackUrl);
  }

  const [window] = BrowserWindow.getAllWindows();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
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

  // DevTools can still be opened manually from the Electron menu when needed.
};

// First-party skills install in the background; only the skills list and
// agent runs (whose CLI reads the skills folder at launch) wait for them.
let bundledSkillsReady = Promise.resolve();
// Remote control initializes after the window opens (see whenReady).
let remoteControlReady = Promise.resolve();

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  bundledSkillsReady = ensureBundledSkills()
    .then(() => {})
    .catch((error) => console.error('Could not install bundled agent skills', error));
  // Reinforce the internal app name (helps in some dev launch scenarios). It
  // must stay "Orion": see ./main/app-identity.js.
  app.setName(INTERNAL_APP_NAME);

  // Start maintenance immediately, but never hold the first window behind
  // shell startup or filesystem cleanup. Provider and MCP operations await
  // only the prerequisite they actually need.
  startShellPathSync();
  startLegacyMcpCleanup();
  void installBundledCli();

  // Seed the model catalog from the last discovery so the first picker render
  // and first turn never wait on provider CLIs, then revalidate it in the
  // background; windows refetch whenever a refresh changes the list.
  onAgentModelsChanged(() => sendToAllWindows('agent:modelsChanged'));
  void configureAgentModelsCache(path.join(app.getPath('userData'), 'agent-models-cache.json')).then(() =>
    getAgentModels().catch(() => {})
  );

  // Workspace sync (opt-in, contract in orion-web/docs/workspace-sync.md).
  // Seed the engine from the persisted store so an enabled sync resumes after
  // restart without waiting for the renderer to hydrate; the renderer re-pushes
  // the settings over sync:configure on hydration and every change.
  initWorkspaceSync({
    getWebUrl: () => getOrionWebUrl(),
    readSession: () => readAccountSession(),
    readStoreState: () => readPersistedStoreState(),
    readThreadsIndex,
    readThreadsByIds,
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
    createRemotePairingProof,
    verifyRemotePairingProof,
    registerRelayDevice,
    deregisterRelayDevice,
    mintRelayTicket,
    getAppVersion: () => app.getVersion(),
  }).catch((error) => console.error('Could not start remote control', error));
  addAgentEventListener((event) => forwardAgentEventToRemote(event));
  // Durango Chat dispatch (off by default). Seed from the persisted store so
  // an enabled worker resumes before the renderer hydrates; the renderer
  // re-pushes settings and projects over durango:configure on every change.
  powerMonitor.on('suspend', () => dispatchWorker.suspend());
  powerMonitor.on('resume', () => dispatchWorker.resume());
  void Promise.all([readPersistedStoreState(), isDispatchSignedIn()])
    .then(async ([state, signedIn]) => {
      if (dispatchConfigureSeq === 0 && state?.durangoSettings) {
        await configureDurango({
          useDurangoTasks: state.durangoSettings.useDurangoTasks,
          dispatch: state.durangoSettings.dispatch,
          projects: state.projects,
        });
      }
      dispatchWorker.accountChanged(signedIn);
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
  await remoteControlReady;

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

app.on('window-all-closed', () => {
  // On macOS the main process remains alive after the last window closes.
  // Tear down persistent sessions so their output is not sent to destroyed
  // webContents and background agents cannot keep working invisibly.
  disposeAllClaudeSdkSessions();
  disposeAllTerminalSessions();
  disposeAllCodexGoalOps();
  disposeAllTitleGenerations();
  reapActiveAgentRuns();
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
  reapActiveAgentRuns();
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
  ])
    .then(() => threadsSaveQueue.catch(() => {}));

const appShutdownError = () =>
  appShutdownReason === 'update'
    ? 'Durango Code is restarting to install an update.'
    : 'Durango Code is shutting down.';

app.on('will-quit', (event) => {
  shutdownWorkspaceSync();
  shutdownRemoteControl();
  dispatchWorker.stop();
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
  shutdownWorkspaceSync();
  shutdownRemoteControl();
  dispatchWorker.stop();
  disposeForQuit('update');
  // If a quit is already draining this same work, waiting on it here settles at
  // the same time; either way the barrier is open once the work has landed.
  await waitForPendingQuitWork().catch(() => {});
  quitBarrierSatisfied = true;
};

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

// -------------------- IPC Handlers --------------------

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
  const save = storageSaveQueue.catch(() => {}).then(async () => {
    const storagePath = getStorageFilePath();
    const tempPath = `${storagePath}.${process.pid}.tmp`;
    const sanitized = sanitizeStoreValue(value) ?? value;
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(tempPath, sanitized, 'utf-8');
    await fs.rename(tempPath, storagePath);
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

// Startup transcript hydration (thread-storage.js): the head the first frame
// shows, then the rest in bounded background batches. Both arrive as JSON text.
ipcMain.handle('storage:loadThreadsHead', async (_event, input) => {
  try {
    return { ok: true, value: await readThreadsHead(input) };
  } catch (error) {
    console.error('storage:loadThreadsHead error', error);
    return { ok: false };
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
const afterRemoteControlInit =
  (handler) =>
  async (...args) => {
    await remoteControlReady;
    return handler(...args);
  };
ipcMain.handle('remote:getState', afterRemoteControlInit(() => getRemoteControlState()));
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
ipcMain.handle('remote:stopTurn', afterRemoteControlInit((_event, input) => stopRemoteTurn(input)));
// Registered only after the renderer has installed onRemoteCommandRequest.
// did-start-loading/destroyed clear this authority until the next mount.
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

ipcMain.handle('storage:clear', async () => {
  // Clear participates in both save queues so an older pending write cannot
  // recreate either file after this handler reports success. Threads also
  // take a sequence number because the unload-time synchronous flush can
  // jump the async queue.
  const threadsSeq = ++threadsWriteSeq;
  const clearStorage = storageSaveQueue.catch(() => {}).then(() =>
    fs.rm(getStorageFilePath(), { force: true })
  );
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

const projectIconExtensions = new Set(['.png', '.jpg', '.jpeg', '.ico', '.webp', '.gif', '.svg']);

const projectIconCandidates = [
  'favicon.ico',
  'favicon.png',
  'favicon.svg',
  'logo.png',
  'logo.svg',
  'icon.png',
  'public/favicon.ico',
  'public/favicon.png',
  'public/favicon.svg',
  'public/logo.png',
  'public/logo.svg',
  'public/icon.png',
  'public/apple-touch-icon.png',
  'app/favicon.ico',
  'src/app/favicon.ico',
  'src/app/icon.png',
  'src/app/icon.svg',
  'assets/logo.png',
  'assets/icon.png',
  'static/favicon.ico',
];

const pathExistsAsFile = async (filePath) => {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
};

const isProjectIconFile = async (filePath) => {
  if (!(await pathExistsAsFile(filePath))) return false;
  const ext = path.extname(filePath).toLowerCase();
  return projectIconExtensions.has(ext);
};

const projectIconToDataUrl = async (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.svg') {
    const content = await fs.readFile(filePath, 'utf-8');
    const encoded = Buffer.from(content).toString('base64');
    return `data:image/svg+xml;base64,${encoded}`;
  }

  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) return null;

  const { width, height } = image.getSize();
  const resized =
    width > 64 || height > 64 ? image.resize({ width: 32, height: 32 }) : image;
  return resized.toDataURL();
};

const resolveProjectIconHref = (baseDir, href) => {
  if (!href || typeof href !== 'string') return null;
  if (/^(?:https?:|data:|\/\/)/i.test(href)) return null;
  const cleanHref = href.split('?')[0].split('#')[0];
  return path.resolve(baseDir, cleanHref);
};

const findProjectIconInHtml = async (projectPath) => {
  const htmlPaths = ['index.html', 'public/index.html', 'src/index.html'];
  for (const relativePath of htmlPaths) {
    const htmlPath = path.join(projectPath, relativePath);
    if (!(await pathExistsAsFile(htmlPath))) continue;

    try {
      const html = await fs.readFile(htmlPath, 'utf-8');
      const iconLinks = html.match(/<link[^>]+rel=["'](?:shortcut\s+)?icon["'][^>]*>/gi) ?? [];
      for (const linkTag of iconLinks) {
        const hrefMatch = linkTag.match(/href=["']([^"']+)["']/i);
        if (!hrefMatch) continue;
        const iconPath = resolveProjectIconHref(path.dirname(htmlPath), hrefMatch[1]);
        if (iconPath && (await isProjectIconFile(iconPath))) return iconPath;
      }
    } catch {
      // ignore malformed html
    }
  }
  return null;
};

const findProjectIconInPackageJson = async (projectPath) => {
  const packagePath = path.join(projectPath, 'package.json');
  if (!(await pathExistsAsFile(packagePath))) return null;

  try {
    const pkg = JSON.parse(await fs.readFile(packagePath, 'utf-8'));
    const iconRef = pkg.icon || pkg.logo;
    if (typeof iconRef !== 'string') return null;
    const iconPath = path.resolve(projectPath, iconRef);
    if (await isProjectIconFile(iconPath)) return iconPath;
  } catch {
    // ignore malformed package.json
  }
  return null;
};

const findProjectIcon = async (projectPath) => {
  if (!projectPath || typeof projectPath !== 'string') return null;

  const sources = [
    findProjectIconInHtml(projectPath),
    findProjectIconInPackageJson(projectPath),
    ...projectIconCandidates.map(async (candidate) => {
      const iconPath = path.join(projectPath, candidate);
      if (await isProjectIconFile(iconPath)) return iconPath;
      return null;
    }),
  ];

  for (const source of sources) {
    const iconPath = await source;
    if (!iconPath) continue;
    try {
      const dataUrl = await projectIconToDataUrl(iconPath);
      if (dataUrl) return dataUrl;
    } catch {
      // try next candidate
    }
  }

  return null;
};

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
// still wins. The shell PATH sync merges the user's shell PATH in front of
// whatever process.env.PATH holds, which keeps this directory last either way.
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

const signInBundledCli = () =>
  ensureCliSignedIn({ readSession: () => readAccountSession(), origin: getOrionWebUrl().toString() }).catch((error) => ({
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
    const result = await createDurangoWorkspace({ projectPath: input.projectPath, name: input.name });
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
    // (HTML page) means this Orion Web deployment doesn't have the API at all.
    return error?.data?.error
      ? 'Cloud repository not found. It may have been deleted.'
      : `Durango Cloud at ${getOrionWebUrl().host} does not support repositories yet. Deploy the latest Durango Code web, or point ORION_WEB_URL at a server that has it.`;
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
  const response = await fetch(new URL(apiPath, getOrionWebUrl()), {
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
    getCloudGitConnection({ baseUrl: getOrionWebUrl(), token, signal }),
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

const cloudRepoWebUrl = (repoId) => new URL(`/repos/${repoId}`, getOrionWebUrl()).toString();

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
        baseUrl: getOrionWebUrl(),
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
    baseUrl: getOrionWebUrl(), token: session.token,
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
            baseUrl: getOrionWebUrl(),
            token: session.token,
          });
          if (!pushed.ok) throw new Error(pushed.error || 'Could not seed the Durango Cloud repository.');
          repo = pushed.repo ?? { id: link.repoId, name: link.repoName ?? name, defaultBranch };
        } else {
          try {
            const published = await publishRepo({
              gitRoot,
              name,
              baseUrl: getOrionWebUrl(),
              token: session.token,
            });
            if (!published.ok) throw new Error(published.error || 'Could not seed the Durango Cloud repository.');
            repo = published.repo;
            createdRepository = true;
          } catch (error) {
            if (error?.status !== 409) throw error;
            repo = await findOwnedCloudRepo({
              baseUrl: getOrionWebUrl(),
              token: session.token,
              name,
            });
            if (!repo) throw error;
            await setCloudRepoLink(gitRoot, { repoId: repo.id, repoName: repo.name });
            const pushed = await pushRepo({
              gitRoot,
              repoId: repo.id,
              baseUrl: getOrionWebUrl(),
              token: session.token,
            });
            if (!pushed.ok) throw new Error(pushed.error || 'Could not update the Durango Cloud repository.');
          }
        }

        const connection = await getCloudGitConnection({
          baseUrl: getOrionWebUrl(),
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
      baseUrl: getOrionWebUrl(),
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
          baseUrl: getOrionWebUrl(),
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
      baseUrl: getOrionWebUrl(),
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
      baseUrl: getOrionWebUrl(),
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
      baseUrl: getOrionWebUrl(),
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
          baseUrl: getOrionWebUrl(),
          token: session.token,
        });
    if (!pushed.ok) return pushed;

    const app = await deployApp({
      repoId: link.repoId,
      baseUrl: getOrionWebUrl(),
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
        baseUrl: getOrionWebUrl(),
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
      baseUrl: getOrionWebUrl(),
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
// in Settings → Durango, falls back to orion-next /api/tasks*.

const requireAccountToken = async () => {
  const session = await readAccountSession();
  return session?.token ?? null;
};

let useDurangoTasksSetting = true;
const boardTasks = createBoardTasks({
  useDurango: () => durangoTasksEnabled({ setting: useDurangoTasksSetting }),
  durango: durangoClient,
  readToken: requireAccountToken,
  webOrigin: () => getOrionWebUrl(),
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

const dispatchWorker = createDispatchWorker({
  client: durangoClient,
  getMachineId: () => getDurangoDeviceId(),
  getMachineName: () => getDispatchMachineName(),
  platform: process.platform,
  isSignedIn: isDispatchSignedIn,
  isOnline: () => net.isOnline(),
  canStart: () => Boolean(remoteCommandRenderer && !remoteCommandRenderer.isDestroyed()),
  startRun: ({ dispatch, project, prompt, accessMode, modelId }) =>
    requestDispatchRendererCommand({
      kind: 'runTurn',
      projectId: project.id,
      prompt: prompt.slice(0, 200_000),
      ...(modelId ? { modelId } : {}),
      accessMode,
      source: { machineId: 'durango-chat', machineName: dispatchSourceLabel(dispatch) },
      durangoDispatch: {
        id: dispatch.id,
        origin: dispatch.origin === 'tasks' ? 'tasks' : 'chat',
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

let dispatchConfigureSeq = 0;
const configureDurango = async (input) => {
  const seq = ++dispatchConfigureSeq;
  if (typeof input?.useDurangoTasks === 'boolean') useDurangoTasksSetting = input.useDurangoTasks;
  const settings = normalizeDispatchSettings(input?.dispatch);
  // Resolve repo ids only when they matter (the worker is on).
  const projects = settings.enabled ? await dispatchProjectsWithRepoIds(input?.projects) : [];
  if (seq !== dispatchConfigureSeq) return { ok: true, superseded: true };
  dispatchWorker.configure({ settings, projects });
  return { ok: true, state: dispatchWorker.getState() };
};

ipcMain.handle('durango:configure', (_event, input) => configureDurango(input));
ipcMain.handle('durango:dispatchState', () => dispatchWorker.getState());
// The renderer saw a dispatched thread settle (finished / failed / stopped).
ipcMain.handle('durango:dispatchSettled', (_event, input) =>
  dispatchWorker.settle({
    dispatchId: typeof input?.dispatchId === 'string' ? input.dispatchId : '',
    threadId: typeof input?.threadId === 'string' ? input.threadId : undefined,
    outcome: input?.outcome === 'finished' ? 'finished' : 'failed',
    summary: typeof input?.summary === 'string' ? input.summary : undefined,
    error: typeof input?.error === 'string' ? input.error : undefined,
  })
);

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

ipcMain.handle('app:relaunch', () => {
  app.relaunch();
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
    const safeFileName = `${id}-${ensureMediaExtension(originalName, mimeType)}`;
    const attachmentDir = getAttachmentDirectoryPath();
    const filePath = path.join(attachmentDir, safeFileName);
    const buffer = Buffer.from(data);

    await fs.mkdir(attachmentDir, { recursive: true });
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

ipcMain.handle('agent:listSlashCommands', async (event, input) =>
  listClaudeSlashCommands({
    sender: event.sender,
    threadId: typeof input?.threadId === 'string' ? input.threadId : null,
    projectPath: typeof input?.projectPath === 'string' ? input.projectPath : null,
  })
);

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

    await settleQuitBarrierForUpdate();
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
ipcMain.handle('orchestration:subagentResult', (_event, payload) => {
  const pending = pendingSubagentSpawns.get(payload?.spawnId);
  if (!pending) return { ok: false };
  pendingSubagentSpawns.delete(payload.spawnId);
  pending.resolve(
    payload.ok
      ? payload.result || '(subagent returned no output)'
      : `Subagent failed: ${payload.result || 'unknown error'}`
  );
  return { ok: true };
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
    const model = models.find((candidate) => candidate.id === input.modelId);
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
    if (model.providerId === 'muse') {
      try {
        museOrionMcpServers(orionMcps.servers);
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }
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
            await withoutClaudeNativeMcps(orionMcps.servers, input.projectPath)
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
    const reasoningActivityKey = `${runId}:reasoning`;
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
      model.providerId === 'grok' || model.providerId === 'kimi' || model.providerId === 'fx';
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
    let runtimeInput =
      useCodexAppServer
        ? {
            ...input,
            mcpRuntimeConfig: withCodexOrionMcps(
              await readMcpRuntimeConfig({
                cwd: input.projectPath,
                shellCwd: codexShellCwd,
                configArgs: splitCodexConfigContextArgs(input.providerOptions).configArgs,
              }),
              // Reuse equivalent native servers and reject unsafe name collisions.
              await withoutCodexNativeMcps(orionMcps.servers, {
                cwd: input.projectPath,
                shellCwd: codexShellCwd,
                configArgs: splitCodexConfigContextArgs(input.providerOptions).configArgs,
              }),
              input.accessMode || 'full-access'
            ),
          }
        : input;
    // Check before allocating a bridge or passing credentials to OpenCode.
    if (model.providerId === 'opencode') {
      try {
        await assertOpenCodeMcpNamesAvailable(orionMcps.servers, {
          cwd: input.projectPath,
          providerOptions: input.providerOptions,
          signal: startupController.signal,
        });
      } catch (error) {
        if (!startupController.signal.aborted) throw error;
      }
      if (startupController.signal.aborted) {
        const aborted = startingAgentRuns.get(runId);
        return aborted?.abortError ? { ok: false, error: aborted.abortError } : { ok: true, runId };
      }
    }
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
    if (orionMcps.servers.length > 0 && model.providerId !== 'codex' && !supportsRunPlugin) {
      return {
        ok: false,
        error: `This ${model.providerId} installation cannot load Durango Code MCP servers: ${orionMcps.servers.map((server) => `@${server.name}`).join(', ')}. Update the provider CLI or switch providers.`,
      };
    }
    const orionMcp =
      input.aside || input.codexReview || !bridgeProvider || !supportsRunPlugin
        ? null
        : await registerMcpBridgeForRun({
            getSender: () => event.sender,
            threadId: input.threadId,
            projectPath: input.projectPath,
            providerId: model.providerId,
            accessMode: input.accessMode || 'full-access',
            // Codex receives these through its app-server config instead.
            userServers: model.providerId === 'codex' ? [] : orionMcps.servers,
          });
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
    if (orionMcps.servers.length > 0 && model.providerId !== 'codex' && !effectiveThreadReaderBridgeReady) {
      orionMcp?.release();
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
      orionMcp?.release();
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
        // Never tell Codex to use extension tools that Orion cannot verify.
        // The dedicated MCP browser is the supported, self-contained fallback.
        runtimeInput = {
          ...runtimeInput,
          providerOptions: codexBrowserOptionsForIntegration(
            input.providerOptions,
            browserIntegration
          ),
        };
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
    let pendingReasoning = '';
    let reasoningEmitted = false;
    let reasoningEmitTimer = null;
    let lastReasoningEmitAt = 0;
    let sessionIdReported = false;
    let finalized = false;
    let exitFallbackTimer = null;
    let terminalEventTimer = null;
    let runStats = null;
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
      // The run owns its CLI process; whatever path finalized the run, the
      // process must not outlive it (ACP servers idle forever on their own).
      // No-op when the process already exited.
      killAgentChild(child, input.threadId);
      activeAgentRuns.delete(runId);
      stoppedAgentRuns.delete(runId);
      codexGoalRunDrivers.delete(runId);
      codexSteerableRunDrivers.delete(runId);
      fxSteerableRunDrivers.delete(runId);
      codexAppServerLease?.release();
      codexAppServerLease = null;
      orionMcp?.release();
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

    const sendReasoningActivity = (status = 'running') => {
      const detailDelta = pendingReasoning;
      pendingReasoning = '';
      if (!detailDelta && !reasoningEmitted) return;
      reasoningEmitted = true;

      emitAgentEvent(event.sender, {
        runId,
        threadId: input.threadId,
        type: 'activity',
        activity: {
          key: reasoningActivityKey,
          type: 'thought',
          title: 'Reasoning',
          detailDelta,
          status,
        },
      });
    };

    // Thinking deltas arrive per token; cap reasoning updates so each one
    // doesn't turn into an IPC message and a renderer store write.
    const queueReasoningActivity = () => {
      const elapsed = Date.now() - lastReasoningEmitAt;
      if (elapsed >= REASONING_EMIT_INTERVAL_MS) {
        lastReasoningEmitAt = Date.now();
        sendReasoningActivity();
        return;
      }
      if (reasoningEmitTimer) return;
      reasoningEmitTimer = setTimeout(() => {
        reasoningEmitTimer = null;
        lastReasoningEmitAt = Date.now();
        sendReasoningActivity();
      }, REASONING_EMIT_INTERVAL_MS - elapsed);
    };

    const finishReasoningActivity = () => {
      if (reasoningEmitTimer) {
        clearTimeout(reasoningEmitTimer);
        reasoningEmitTimer = null;
      }
      sendReasoningActivity('done');
    };

    const emitActivity = (activity) => {
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
      if (reasoningDelta) {
        pendingReasoning = `${pendingReasoning}${reasoningDelta}`;
        queueReasoningActivity();
      }

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
      onReasoning: (delta) => {
        pendingReasoning = `${pendingReasoning}${delta}`;
        queueReasoningActivity();
      },
      onText: (text) => {
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
      onFatal: (message) => {
        if (finalized) return;
        stdoutSeen = true;
        emitAgentEvent(event.sender, {
          runId,
          threadId: input.threadId,
          type: 'chunk',
          chunk: `${message}\n`,
        });
        killAgentChild(child);
        finalizeRun(1);
      },
    };
    // The driver's completion signal: its per-run protocol connection idles
    // once the work resolves, so close it shortly after and finalize as done.
    const finishDriverRun = () => {
      turnCompleted = true;
      if (!terminalEventTimer && !finalized) {
        terminalEventTimer = setTimeout(() => {
          terminalEventTimer = null;
          killAgentChild(child);
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
        : `${model.command} ${(
            useCodexAppServer ? args.slice(1) : args.slice(1, -1)
          ).join(' ')}`,
    });

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

    acpDriver?.start();
    };

    // A stop/steer raced the startup above and aborted the run before any
    // process existed — honor it instead of launching a run the renderer
    // already settled and untracked.
    const abortedStartup = startingAgentRuns.get(runId);
    if (abortedStartup?.aborted) {
      codexAppServerLease?.release();
      codexAppServerLease = null;
      orionMcp?.release();
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
      orionMcp?.release();
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
  if (await steerCodexAppServerRun(runId, text, attachments)) return true;
  if (await steerFxRun(runId, text, attachments)) return true;
  return await steerClaudeSdkRun(runId, text, attachments);
});

ipcMain.handle('agent:getCodexQuestions', (_event, threadId) => {
  const drivers = new Map([...codexSteerableRunDrivers, ...codexGoalRunDrivers]);
  return [...completedCodexQuestions.list(threadId), ...[...drivers].flatMap(([runId, driver]) =>
    (driver.getUserInputs?.() ?? [])
      .filter((request) => request.threadId === threadId)
      .map((request) => ({ ...request, runId }))
  )];
});

ipcMain.handle('agent:answerCodexQuestions', async (event, runId, requestId, answers, text) => {
  const driver = codexSteerableRunDrivers.get(runId) ?? codexGoalRunDrivers.get(runId);
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

ipcMain.handle('agent:getClaudeQuestions', (_event, threadId) =>
  claudeSdkSessions.get(threadId)?.userInputs?.list() ?? []
);
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
  const [disposedTerminal, disposedClaude, disposedGoals, disposedTitles, disposedAgent] =
    await Promise.all([
      terminalShutdown,
      disposeClaudeSdkSessionAndWait(threadId),
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
    const accessMode = ['read-only', 'workspace-write', 'full-access'].includes(
      input?.accessMode
    )
      ? input.accessMode
      : 'full-access';
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

// Normalize a raw model response into a usable one-line thread title,
// or '' when nothing title-shaped survives.
const titleFromResponseText = (responseText) => {
  let candidate = (responseText || '').split(/[\r\n]+/)[0] || '';
  candidate = candidate.trim();
  if (!candidate) return '';

  // Clean model output
  // Strip markdown formatting first (Kimi wraps titles in **bold** / headings)
  // so the quote/prefix cleanups below see plain text.
  candidate = candidate.replace(/^#{1,6}\s+/, '');
  // Paired code/strike/bold delimiters unwrap safely anywhere (the content
  // survives; bold requires non-space at the inner edges, per Markdown, so a
  // literal `**kwargs and **args` stays intact). Single * and __ pairs only
  // unwrap when they enclose the whole title — interior ones are likely
  // literal (glob patterns like *.ts, identifiers like __init__).
  candidate = candidate.replace(/`([^`]+)`/g, '$1');
  candidate = candidate.replace(/~~([^~]+)~~/g, '$1');
  candidate = candidate.replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, '$1');
  candidate = candidate.replace(/^\*([^*]+)\*$/, '$1');
  candidate = candidate.replace(/^__(.+)__$/, '$1');
  candidate = candidate.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2');
  candidate = candidate.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  candidate = candidate.replace(/^(title\s*[:：]\s*|here\s*(is|is a)\s*(a\s+)?(concise\s+)?title\s*[:：]?\s*|the title (is|should be)\s*[:：]?\s*)/i, '');
  candidate = candidate.replace(/\s+/g, ' ').trim();
  candidate = candidate.split(/[\.!?]\s/)[0].trim();
  if (candidate.length > 70) candidate = candidate.slice(0, 67).trim() + '…';

  // Hard guard: never accept raw protocol / JSON / thought lines as a title
  if (!candidate || /^[\{\[]/.test(candidate) || /"type"\s*:/i.test(candidate) || /"data"\s*:/i.test(candidate) || /\btype["\s]*:["\s]*thought\b/i.test(candidate)) {
    return '';
  }
  return candidate;
};

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

      const jsonMode = sendsJsonEvents(model.providerId);
      let responseText = '';

      if (jsonMode) {
        // Parse NDJSON / streaming-json output and extract only real text (ignore thoughts etc.)
        const adapter = jsonAdapterForProvider(model.providerId);
        const textContext = { textSeen: false };
        const lines = stdout.split(/\r?\n/);
        let partial = '';
        for (const rawLine of lines) {
          const line = partial ? partial + rawLine : rawLine;
          const trimmed = line.trim();
          if (!trimmed) {
            partial = '';
            continue;
          }
          try {
            const parsed = JSON.parse(trimmed);
            const t = adapter.text(parsed, textContext);
            if (t) {
              responseText += t;
              textContext.textSeen = true;
              partial = '';
            } else {
              // parsed but no text content (e.g. thought) — discard this line
              partial = '';
            }
          } catch {
            // Not (yet) valid JSON. If it doesn't look like start of JSON, treat as plain text.
            if (!/^\s*[\{\[]/.test(trimmed)) {
              responseText += rawLine + '\n';
              partial = '';
            } else {
              partial = line; // keep for potential multi-line object (rare)
            }
          }
        }
        // flush last partial if it parses
        if (partial.trim()) {
          try {
            const p = JSON.parse(partial.trim());
            const t = adapter.text(p, textContext);
            if (t) responseText += t;
          } catch {
            if (!/^\s*[\{\[]/.test(partial)) responseText += partial;
          }
        }
      } else {
        responseText = stdout;
      }

      finish(responseText);
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
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) return '';
  if (!(await checkCommandAvailable(model.command))) return '';
  if (options?.signal?.aborted) return '';
  return runOneShotAgentText(model, prompt, projectPath, options);
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
      'No quotes, no explanations, no trailing punctuation. Just the title.\n\n' +
      'Request:\n' +
      input.prompt;

    return titleFromResponseText(
      await runOneShotAgentText(model, titleInstruction, input.projectPath, {
        signal: controller.signal,
        threadId,
        reasoningEffort: input.reasoningEffort,
      })
    );
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

// Path helpers (so renderer doesn't need node path)
ipcMain.handle('project:findIcon', async (_event, projectPath) => {
  try {
    return await findProjectIcon(projectPath);
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

ipcMain.handle('path:basename', (_e, p) => path.basename(p));
ipcMain.handle('path:dirname', (_e, p) => path.dirname(p));
ipcMain.handle('path:join', (_e, ...parts) => path.join(...parts));
