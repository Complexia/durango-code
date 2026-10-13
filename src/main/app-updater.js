import { BrowserWindow, app, autoUpdater as nativeAutoUpdater, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { DEFAULT_UPDATE_FEED_URL } from './web-origin.js';

export let appUpdateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  checkedAt: null,
  availableVersion: null,
  progress: null,
  error: null,
};
export let appUpdaterInitializationPromise = null;
export let appUpdateCheckTimer = null;
export let appUpdateDownloadedVersion = null;
export let appUpdateCheckPromise = null;
export let lastAppUpdateCheckAt = 0;
export let appUpdateRetryTimer = null;
export let appUpdateRetryAttempt = 0;
// The check currently in flight, if any. Automatic checks (startup, the 2h
// interval, retries, the renderer's mount-time check) are `background`; a
// failure there is never something the user asked for, so it must not be
// presented as "Update failed". Only user-initiated checks and downloads
// surface errors.
export let activeAppUpdateCheck = null;
export const APP_UPDATE_CHECK_DEDUP_MS = 60 * 1000;
// Orion launched at login reliably runs its first checks before Wi-Fi, DNS or
// a VPN is up, and the feed request rejects. Keep retrying with a growing
// delay until one check succeeds rather than giving up after a single retry
// and leaving a stale error on screen for the next two hours.
export const APP_UPDATE_RETRY_DELAYS_MS = [30 * 1000, 60 * 1000, 2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000];
// States a background check failure must never replace: they belong to a
// download or restart the user already committed to.
const APP_UPDATE_PROTECTED_STATUSES = new Set(['downloading', 'downloaded', 'restarting']);
// Squirrel has to pull the downloaded zip through electron-updater's local
// proxy server and unpack it before it can install anything. That is a local
// copy of a few hundred megabytes, so allow for a slow disk before giving up.
export const APP_UPDATE_STAGE_TIMEOUT_MS = 3 * 60 * 1000;

// electron-updater emits its own 'update-downloaded' as soon as the zip is on
// disk and the proxy server is listening — Squirrel has not fetched or staged
// anything at that point, and quitAndInstall() is a silent no-op until it has
// (it only registers a listener and returns). That is why the first "Restart
// to update" click appeared to do nothing. Track Squirrel's own
// 'update-downloaded' so a restart can wait for the update to be installable.
export let appUpdateStagedForInstall = false;
const appUpdateStagedWaiters = new Set();

const settleAppUpdateStagedWaiters = (staged) => {
  const waiters = [...appUpdateStagedWaiters];
  appUpdateStagedWaiters.clear();
  for (const waiter of waiters) waiter(staged);
};

export const invalidateAppUpdateDownload = () => {
  appUpdateDownloadedVersion = null;
  appUpdateStagedForInstall = false;
  settleAppUpdateStagedWaiters(false);
};

export const waitForAppUpdateStagedForInstall = (timeoutMs = APP_UPDATE_STAGE_TIMEOUT_MS) => {
  if (appUpdateStagedForInstall) return Promise.resolve(true);
  return new Promise((resolve) => {
    const waiter = (staged) => {
      clearTimeout(timer);
      resolve(staged);
    };
    const timer = setTimeout(() => {
      appUpdateStagedWaiters.delete(waiter);
      resolve(false);
    }, timeoutMs);
    appUpdateStagedWaiters.add(waiter);
  });
};

export const getAppIconPath = () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icon.png');
  }
  return path.join(app.getAppPath(), 'assets', 'icon.png');
};

export const getAppUpdateFeedUrl = () => {
  // code.durango.sh serves the same feed as the legacy orioncode.xyz host,
  // which keeps answering already-installed builds.
  const baseUrl = process.env.ORION_UPDATE_FEED_URL || DEFAULT_UPDATE_FEED_URL;
  const arch = process.arch === 'x64' ? 'x64' : 'arm64';
  return `${baseUrl.replace(/\/$/, '')}/${arch}/`;
};

export const publishAppUpdateState = (patch) => {
  appUpdateState = {
    ...appUpdateState,
    ...patch,
    currentVersion: app.getVersion(),
  };

  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('appUpdate:state', appUpdateState);
  }

  return appUpdateState;
};

export const initializeAppUpdaterOnce = async () => {
  // electron-updater is CommonJS and defines `autoUpdater` with a getter,
  // which Node's CJS export lexer cannot see. The Vite bundle resolves it as
  // a named export; a raw ESM load (the electron test scripts) only finds
  // it on the default export.
  const updaterModule = await import('electron-updater');
  const autoUpdater = updaterModule.autoUpdater ?? updaterModule.default?.autoUpdater;

  // electron-forge does not generate the app-update.yml that electron-builder
  // ships in Resources, and electron-updater insists on reading one when
  // downloading (it holds the cache-dir config). Write an equivalent file to
  // user data and point the updater at it.
  try {
    const updateConfigPath = path.join(app.getPath('userData'), 'app-update.yml');
    await fs.writeFile(
      updateConfigPath,
      ['provider: generic', `url: ${getAppUpdateFeedUrl()}`, 'updaterCacheDirName: orion-updater', ''].join('\n')
    );
    autoUpdater.updateConfigPath = updateConfigPath;
  } catch {
    // Checking still works via setFeedURL below; download will surface errors.
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Differential download fetches blockmaps and many byte ranges against the
  // feed's signed URL; any of those requests landing after the signature
  // expires 403s the whole update. One plain GET keeps the window small.
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: getAppUpdateFeedUrl(),
  });

  // Squirrel reports separately from electron-updater, and only its event
  // means quitAndInstall() will actually do something.
  nativeAutoUpdater.on('update-downloaded', () => {
    appUpdateStagedForInstall = true;
    settleAppUpdateStagedWaiters(true);
  });
  nativeAutoUpdater.on('error', () => {
    // Staging failed. Invalidate the downloaded-version shortcut so the error
    // button performs a real download/staging retry instead of restoring the
    // same permanently unstaged "downloaded" state.
    invalidateAppUpdateDownload();
  });

  autoUpdater.on('checking-for-update', () => {
    // Background re-checks (the startup timer, the 2h interval) must not hide
    // the update button while a download is in flight or already staged, nor
    // interrupt a restart the user already committed to.
    if (appUpdateState.status === 'restarting') return;
    if (appUpdateState.status === 'downloading' || appUpdateState.status === 'downloaded') return;
    publishAppUpdateState({
      status: 'checking',
      checkedAt: new Date().toISOString(),
      progress: null,
      error: null,
    });
  });

  autoUpdater.on('update-available', (info) => {
    const availableVersion = info?.version ?? null;

    // A restart is already under way — leave the staged update alone. Starting
    // a fresh download here would reset Squirrel's staging and strand it.
    if (appUpdateState.status === 'restarting') return;

    // This fires on every check, including background re-checks that race a
    // just-finished download. If this exact version is already staged, keep
    // the 'downloaded' state so "Restart to update" doesn't revert to
    // "Install update" and prompt a second download of the same bytes.
    if (availableVersion && availableVersion === appUpdateDownloadedVersion) {
      publishAppUpdateState({
        status: 'downloaded',
        availableVersion,
        checkedAt: new Date().toISOString(),
        progress: null,
        error: null,
      });
      return;
    }
    if (appUpdateState.status === 'downloading' && availableVersion === appUpdateState.availableVersion) {
      return;
    }

    publishAppUpdateState({
      status: 'available',
      availableVersion,
      checkedAt: new Date().toISOString(),
      progress: null,
      error: null,
    });

    // With autoInstallOnAppQuit, a previously downloaded update stays staged
    // and would install on quit even after newer releases ship. Re-download
    // so the staged update is always the latest one.
    if (appUpdateDownloadedVersion && availableVersion && appUpdateDownloadedVersion !== availableVersion) {
      void autoUpdater.downloadUpdate().catch(() => {});
    }
  });

  autoUpdater.on('update-not-available', () => {
    if (appUpdateState.status === 'restarting') return;
    publishAppUpdateState({
      status: 'not-available',
      availableVersion: null,
      checkedAt: new Date().toISOString(),
      progress: null,
      error: null,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    publishAppUpdateState({
      status: 'downloading',
      progress: {
        percent: Number.isFinite(progress?.percent) ? progress.percent : 0,
        transferred: progress?.transferred ?? 0,
        total: progress?.total ?? 0,
        bytesPerSecond: progress?.bytesPerSecond ?? 0,
      },
      error: null,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    appUpdateDownloadedVersion = info?.version ?? appUpdateState.availableVersion;
    // A new zip means a new proxy server, so Squirrel starts staging over.
    appUpdateStagedForInstall = false;
    publishAppUpdateState({
      status: 'downloaded',
      availableVersion: info?.version ?? appUpdateState.availableVersion,
      progress: null,
      error: null,
    });
  });

  autoUpdater.on('error', (error, detail) => {
    // electron-updater emits this for a failed checkForUpdates() before the
    // promise rejects. A background check failing (typically: offline right
    // after login) is handled by checkForAppUpdate, which keeps the button
    // hidden and schedules a retry. Publishing 'error' here would flash
    // "Update failed" for an update that never existed.
    if (activeAppUpdateCheck?.background && !APP_UPDATE_PROTECTED_STATUSES.has(appUpdateState.status)) return;
    // A check racing an in-flight download or restart must not clobber it.
    const isCheckError = typeof detail === 'string' && detail.startsWith('Cannot check for updates');
    if (isCheckError && APP_UPDATE_PROTECTED_STATUSES.has(appUpdateState.status)) return;
    publishAppUpdateState({
      status: 'error',
      progress: null,
      error: error?.message ?? 'Update failed',
    });
  });

  return autoUpdater;
};

export const initializeAppUpdater = () => {
  if (!appUpdaterInitializationPromise) {
    const initialization = initializeAppUpdaterOnce();
    const sharedInitialization = initialization.catch((error) => {
      if (appUpdaterInitializationPromise === sharedInitialization) {
        appUpdaterInitializationPromise = null;
      }
      throw error;
    });
    appUpdaterInitializationPromise = sharedInitialization;
  }
  return appUpdaterInitializationPromise;
};

export const runAppUpdateCheck = async ({ background = false } = {}) => {
  if (!app.isPackaged) {
    return publishAppUpdateState({
      status: 'not-available',
      checkedAt: new Date().toISOString(),
      error: null,
    });
  }

  // No network interface yet (the usual state seconds after login). Skip the
  // request instead of letting electron-updater fail it; the retry schedule
  // and the renderer's 'online' event bring the check back once connected.
  if (background && !net.isOnline()) {
    throw new Error('Durango Code is offline. The update check will retry once a connection is available.');
  }

  const autoUpdater = await initializeAppUpdater();
  await autoUpdater.checkForUpdates();
  return appUpdateState;
};

export const clearAppUpdateRetry = () => {
  if (appUpdateRetryTimer) {
    clearTimeout(appUpdateRetryTimer);
    appUpdateRetryTimer = null;
  }
  appUpdateRetryAttempt = 0;
};

export const scheduleAppUpdateRetry = () => {
  if (appUpdateRetryTimer) return;
  const delay = APP_UPDATE_RETRY_DELAYS_MS[Math.min(appUpdateRetryAttempt, APP_UPDATE_RETRY_DELAYS_MS.length - 1)];
  appUpdateRetryAttempt += 1;
  appUpdateRetryTimer = setTimeout(() => {
    appUpdateRetryTimer = null;
    // Forced so the retry cannot be deduplicated against the failed check.
    void checkForAppUpdate({ force: true, background: true }).catch(() => {});
  }, delay);
};

// A background check failed. Restore the last visible result — a known
// available update stays offered, otherwise the button stays hidden — and
// keep the message on the state for diagnostics without showing it.
export const publishQuietAppUpdateCheckFailure = (error) => {
  if (APP_UPDATE_PROTECTED_STATUSES.has(appUpdateState.status)) return;
  publishAppUpdateState({
    status: appUpdateState.availableVersion ? 'available' : 'idle',
    checkedAt: new Date().toISOString(),
    progress: null,
    error: error?.message ?? 'Could not check for updates',
  });
};

export const checkForAppUpdate = ({ force = false, background = false } = {}) => {
  if (appUpdateCheckPromise) {
    // A user asking while a background check is in flight expects to see the
    // outcome, so the shared check stops being silent.
    if (!background && activeAppUpdateCheck) activeAppUpdateCheck.background = false;
    return appUpdateCheckPromise;
  }
  if (!force && Date.now() - lastAppUpdateCheckAt < APP_UPDATE_CHECK_DEDUP_MS) {
    return Promise.resolve(appUpdateState);
  }

  const activeCheck = { background };
  activeAppUpdateCheck = activeCheck;
  const check = runAppUpdateCheck({ background }).then(
    (state) => {
      lastAppUpdateCheckAt = Date.now();
      clearAppUpdateRetry();
      return state;
    },
    (error) => {
      if (!activeCheck.background) {
        publishAppUpdateCheckError(error);
        throw error;
      }
      publishQuietAppUpdateCheckFailure(error);
      scheduleAppUpdateRetry();
      return appUpdateState;
    }
  );
  const sharedCheck = check.finally(() => {
    if (activeAppUpdateCheck === activeCheck) activeAppUpdateCheck = null;
    if (appUpdateCheckPromise === sharedCheck) {
      appUpdateCheckPromise = null;
    }
  });
  appUpdateCheckPromise = sharedCheck;
  return sharedCheck;
};

export const publishAppUpdateCheckError = (error) => {
  publishAppUpdateState({
    status: 'error',
    checkedAt: new Date().toISOString(),
    error: error?.message ?? 'Could not check for updates',
  });
};

export const runScheduledAppUpdateCheck = () => {
  // Background failures are absorbed by checkForAppUpdate (quiet state plus
  // the retry schedule); the catch only covers a check a user joined.
  void checkForAppUpdate({ background: true }).catch(() => {});
};

export const scheduleAppUpdateChecks = () => {
  if (!app.isPackaged) return;

  setTimeout(runScheduledAppUpdateCheck, 10000);

  if (appUpdateCheckTimer) clearInterval(appUpdateCheckTimer);
  appUpdateCheckTimer = setInterval(runScheduledAppUpdateCheck, 2 * 60 * 60 * 1000);
};
