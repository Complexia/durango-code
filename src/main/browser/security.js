// Isolation of built-in browser tabs: their own persistent partition, a
// sandboxed renderer with no preload, no permissions beyond clipboard writes
// and fullscreen, a URL policy on every navigation, and downloads kept in
// Durango Code's data folder (never opened automatically).
import { app, session as electronSession } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BROWSER_PARTITION, checkBrowserUrl, isBrowserPermissionAllowed } from './policy.js';

export const browserGuestWebPreferences = () => ({
  partition: BROWSER_PARTITION,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  // Agents drive tabs the person is not looking at.
  backgroundThrottling: false,
  spellcheck: false,
  safeDialogs: true,
  navigateOnDragDrop: false,
});

export const browserDownloadsDirectory = () => path.join(app.getPath('userData'), 'browser-downloads');
export const browserScreenshotsDirectory = () => path.join(app.getPath('userData'), 'browser-shots');

const safeDownloadName = (filename) =>
  path.basename(String(filename || 'download')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'download';

// Final paths promised to downloads still in flight or waiting for the user's
// answer: two tabs downloading report.txt at once must not both pick it.
const reservedDownloadPaths = new Set();

const downloadPathCandidates = function* (directory, filename) {
  const safe = safeDownloadName(filename);
  const extension = path.extname(safe);
  const stem = safe.slice(0, safe.length - extension.length);
  yield path.join(directory, safe);
  for (let index = 1; index < 1000; index += 1) yield path.join(directory, `${stem} (${index})${extension}`);
};

/** Picks a free name in `directory` (no file there, no other download promised it) and reserves it. */
export const reserveDownloadPath = (directory, filename) => {
  let candidate = null;
  for (candidate of downloadPathCandidates(directory, filename)) {
    if (!reservedDownloadPaths.has(candidate) && !fs.existsSync(candidate)) break;
  }
  reservedDownloadPaths.add(candidate);
  return candidate;
};

export const releaseDownloadPath = (filePath) => {
  reservedDownloadPaths.delete(filePath);
};

// Moves `from` to `to` without replacing an existing file (a hard link fails
// with EEXIST; copyFile with COPYFILE_EXCL where links are not supported).
const moveWithoutOverwrite = async (from, to) => {
  try {
    await fsp.link(from, to);
  } catch (error) {
    if (error?.code === 'EEXIST') throw error;
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  }
  await fsp.rm(from, { force: true });
};

/**
 * Moves a held download into place at `finalPath` (reserved by
 * reserveDownloadPath), or the next free name if a file appeared there since,
 * and releases the reservation. Returns the path it was saved to.
 */
export const moveHeldDownload = async (holdPath, finalPath) => {
  try {
    for (const candidate of downloadPathCandidates(path.dirname(finalPath), path.basename(finalPath))) {
      if (candidate !== finalPath && reservedDownloadPaths.has(candidate)) continue;
      try {
        await moveWithoutOverwrite(holdPath, candidate);
        return candidate;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    throw new Error(`no free name for ${path.basename(finalPath)}`);
  } finally {
    releaseDownloadPath(finalPath);
  }
};

// The manager's download callbacks, kept apart from the one-time session setup
// so they apply whichever code touched the session first (Clear browsing data
// can run before any tab exists).
let downloadHandlers = {};
/**
 * `onDownloadStart({ item, webContents, savePath })` runs as a download begins
 * and may return `{ holdPath }` to download there first (the manager holds the
 * file while the user decides, then moves it with moveHeldDownload and owns
 * the savePath reservation); `onDownload({ item, webContents, savePath,
 * state })` reports where it finished.
 */
export const setBrowserDownloadHandlers = ({ onDownload, onDownloadStart } = {}) => {
  downloadHandlers = { onDownload, onDownloadStart };
};

let configuredSession = null;
export const getBrowserSession = () => {
  const browserSession = electronSession.fromPartition(BROWSER_PARTITION);
  if (configuredSession === browserSession) return browserSession;
  configuredSession = browserSession;
  browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isBrowserPermissionAllowed(permission));
  });
  browserSession.setPermissionCheckHandler((_webContents, permission) => isBrowserPermissionAllowed(permission));
  try {
    browserSession.setDevicePermissionHandler(() => false);
  } catch {}
  try {
    // No screen sharing from guest pages: an empty answer denies the request.
    browserSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  } catch {}
  browserSession.on('will-download', (_event, item, webContents) => {
    const directory = browserDownloadsDirectory();
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch {}
    const { onDownloadStart, onDownload } = downloadHandlers;
    const savePath = reserveDownloadPath(directory, item.getFilename());
    let holdPath = null;
    try {
      holdPath = onDownloadStart?.({ item, webContents, savePath })?.holdPath ?? null;
    } catch {}
    if (holdPath) {
      try {
        fs.mkdirSync(path.dirname(holdPath), { recursive: true });
      } catch {}
    }
    item.setSavePath(holdPath ?? savePath);
    item.once('done', (_doneEvent, state) => {
      // A held download keeps its reservation until the manager moves it.
      if (!holdPath) releaseDownloadPath(savePath);
      onDownload?.({ item, webContents, savePath: holdPath ?? savePath, state, url: item.getURL() });
    });
  });
  return browserSession;
};

/**
 * Applies the URL policy and popup handling to a guest webContents.
 * `getProjectPath()` names the directory file: URLs may come from;
 * `getFullAccess()` lifts the file:/data:/javascript: limits (see checkBrowserUrl);
 * `onBlocked(reason)` reports a refused navigation; `onPopup(details)` is asked
 * about window.open / target=_blank once the URL passes the policy and returns
 * `adopt(options)` (which turns the popup's WebContents, created by Electron so
 * window.opener, postMessage and a form's POST body survive, into a tab and
 * returns it) or null to refuse the popup.
 */
export const attachGuestPolicy = (webContents, { getProjectPath, getFullAccess = () => false, onBlocked, onPopup }) => {
  const guard = (event, url, isMainFrame) => {
    const verdict = checkBrowserUrl(url, { projectPath: getProjectPath(), topLevel: isMainFrame, fullAccess: getFullAccess() });
    if (!verdict.ok) {
      event.preventDefault();
      onBlocked?.(verdict.reason);
    }
  };
  webContents.on('will-frame-navigate', (details) => {
    guard(details, details.url, details.isMainFrame);
  });
  webContents.on('will-redirect', (details) => {
    guard(details, details.url, details.isMainFrame);
  });
  webContents.setWindowOpenHandler((details) => {
    const verdict = checkBrowserUrl(details.url, { projectPath: getProjectPath(), topLevel: true, fullAccess: getFullAccess() });
    if (!verdict.ok) {
      onBlocked?.(verdict.reason);
      return { action: 'deny' };
    }
    const adopt = onPopup?.(details);
    if (!adopt) return { action: 'deny' };
    // The popup's session is its opener's; the rest are the guest preferences.
    const { partition: _partition, ...webPreferences } = browserGuestWebPreferences();
    return {
      action: 'allow',
      // A popup is a tab of its own: closing the opener leaves it open.
      outlivesOpener: true,
      overrideBrowserWindowOptions: { show: false, webPreferences },
      createWindow: (options) => adopt(options),
    };
  });
  // Never let a guest attach a <webview> of its own.
  webContents.on('will-attach-webview', (event) => event.preventDefault());
};
