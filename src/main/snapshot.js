// SnapShot (macOS): a global trigger captures the window the user is working
// in — its image and, optionally, its accessibility outline — and attaches
// both to the selected thread's draft. See docs/snapshot.md.
//
// The trigger is armed from userData/snapshot.json at launch, so it works
// before the renderer loads; the renderer pushes changes with
// snapshot:configure. Captures go into a pending queue that the renderer
// drains with snapshot:takePending (on mount, and on each snapshot:available
// event), so a capture taken while no window is open is not lost.
import { BrowserWindow, app, globalShortcut, ipcMain, nativeImage, systemPreferences } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { getAttachmentDirectoryPath } from './paths.js';
import {
  SNAPSHOT_DEFAULT_ACCELERATOR,
  SNAPSHOT_MAX_PNG_BYTES,
  fitSnapShotImageSize,
  formatSnapShotOutline,
  normalizeSnapShotSettings,
  selectSnapShotWindow,
  snapShotFileBase,
} from './snapshot-format.js';

const supported = process.platform === 'darwin';
const helperName = 'durango-snapshot';
const axDeadlineMs = 2300;
const axHardTimeoutMs = 2500;
const captureSoundPaths = [
  '/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Screen Capture.aif',
  '/System/Library/Sounds/Tink.aiff',
];

let settings = normalizeSnapShotSettings(null);
let helperPath = null;
let helperStatus = supported ? 'unknown' : 'unsupported';
let helperBuild = null;
let watcher = null;
let watcherRestarts = [];
let registeredAccelerator = null;
let trigger = { kind: 'off', fallback: false, error: null };
let capturing = false;
let lastError = null;
let pending = [];
let openWindow = () => null;
let disposed = false;
// Set once the renderer has pushed its settings; launch-time arming from the
// file must not overwrite them.
let configured = false;

const settingsFile = () => path.join(app.getPath('userData'), 'snapshot.json');

const packagedHelperPath = () => path.join(process.resourcesPath, helperName);
const devHelperPath = () => path.join(app.getAppPath(), 'native', 'snapshot-helper', 'build', helperName);
const devBuildScript = () => path.join(app.getAppPath(), 'scripts', 'build-snapshot-helper.mjs');

const run = (file, args, { timeout = 10000 } = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });

const commandExists = (command) =>
  run('/usr/bin/xcrun', ['--find', command], { timeout: 15000 }).then(
    () => true,
    () => false
  );

// Packaged builds ship the helper as an extra resource. Development builds
// compile it on first use (the script skips work when it is up to date) when
// the Swift toolchain is installed; otherwise Settings shows it unavailable.
const resolveHelper = async () => {
  if (!supported) return null;
  if (app.isPackaged) {
    helperPath = existsSync(packagedHelperPath()) ? packagedHelperPath() : null;
    helperStatus = helperPath ? 'ready' : 'missing';
    return helperPath;
  }
  if (helperBuild) return helperBuild;
  helperBuild = (async () => {
    try {
      if (!(await commandExists('swiftc'))) {
        helperPath = existsSync(devHelperPath()) ? devHelperPath() : null;
        helperStatus = helperPath ? 'ready' : 'missing';
        return helperPath;
      }
      helperStatus = 'building';
      await new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          [devBuildScript(), '--if-needed', '--host-only'],
          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 180000 },
          (error, _stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve())
        );
      });
      helperPath = devHelperPath();
      helperStatus = 'ready';
    } catch (error) {
      console.error('SnapShot helper build failed', error);
      helperPath = existsSync(devHelperPath()) ? devHelperPath() : null;
      helperStatus = helperPath ? 'ready' : 'missing';
    }
    return helperPath;
  })().finally(() => {
    helperBuild = null;
  });
  return helperBuild;
};

const runHelper = async (args, timeout = 5000) => {
  const helper = helperPath ?? (await resolveHelper());
  if (!helper) throw new Error('The SnapShot helper is unavailable.');
  const stdout = await run(helper, args, { timeout });
  const line = String(stdout).trim().split('\n').pop();
  const result = JSON.parse(line || '{}');
  if (result.ok === false) throw new Error(result.error || 'The SnapShot helper failed.');
  return result;
};

// ---------------------------------------------------------------------------
// Trigger

const publishState = () => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('snapshot:state', snapShotState());
  }
};

const stopWatcher = () => {
  const child = watcher;
  watcher = null;
  if (child && child.exitCode === null) child.kill();
};

const unregisterAccelerator = () => {
  if (registeredAccelerator) {
    try {
      globalShortcut.unregister(registeredAccelerator);
    } catch {
      // already gone
    }
  }
  registeredAccelerator = null;
};

const registerAccelerator = (accelerator, { fallback = false } = {}) => {
  unregisterAccelerator();
  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, () => void captureSnapShot({ source: 'shortcut' }));
  } catch (error) {
    trigger = { kind: 'accelerator', accelerator, fallback, error: error?.message ?? String(error) };
    return false;
  }
  if (!ok) {
    trigger = {
      kind: 'accelerator',
      accelerator,
      fallback,
      error: `${accelerator} is already used by another app.`,
    };
    return false;
  }
  registeredAccelerator = accelerator;
  trigger = { kind: 'accelerator', accelerator, fallback, error: null };
  return true;
};

const fallBackToAccelerator = (reason) => {
  stopWatcher();
  console.warn('SnapShot modifier watcher unavailable; using the key chord.', reason);
  registerAccelerator(SNAPSHOT_DEFAULT_ACCELERATOR, { fallback: true });
  if (trigger.error) trigger.error = `${reason} ${trigger.error}`;
  else trigger.error = reason;
  publishState();
};

// Polls the modifier flags in the helper (no event tap: no Input Monitoring
// permission) and fires on each press of both keys. Restarted if it dies,
// at most three times a minute; after that the default key chord takes over.
const startWatcher = async () => {
  const helper = await resolveHelper();
  if (disposed || !settings.enabled || settings.shortcut.kind !== 'modifier-pair') return;
  if (!helper) {
    fallBackToAccelerator('The SnapShot helper is unavailable.');
    return;
  }
  stopWatcher();
  const child = spawn(helper, ['watch-modifiers', '--pair', settings.shortcut.modifier, '--parent-pid', String(process.pid)], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  watcher = child;
  trigger = { kind: 'modifier-pair', modifier: settings.shortcut.modifier, fallback: false, error: null };
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.event === 'trigger') void captureSnapShot({ source: 'shortcut' });
  });
  child.on('error', (error) => {
    if (watcher !== child) return;
    fallBackToAccelerator(`Could not start the Shift-key watcher (${error.message}).`);
  });
  child.on('exit', () => {
    if (watcher !== child) return;
    watcher = null;
    const now = Date.now();
    watcherRestarts = watcherRestarts.filter((at) => now - at < 60000);
    if (watcherRestarts.length >= 3) {
      fallBackToAccelerator('The Shift-key watcher keeps stopping.');
      return;
    }
    watcherRestarts.push(now);
    setTimeout(() => {
      if (!watcher && !disposed && settings.enabled && settings.shortcut.kind === 'modifier-pair') void startWatcher();
    }, 1000);
  });
  publishState();
};

const armTrigger = async () => {
  stopWatcher();
  unregisterAccelerator();
  watcherRestarts = [];
  if (!supported || disposed || !settings.enabled) {
    trigger = { kind: 'off', fallback: false, error: null };
    publishState();
    return;
  }
  if (settings.shortcut.kind === 'accelerator') {
    registerAccelerator(settings.shortcut.accelerator);
    publishState();
    return;
  }
  await startWatcher();
};

const readSettingsFile = async () => {
  try {
    return normalizeSnapShotSettings(JSON.parse(await fs.readFile(settingsFile(), 'utf8')));
  } catch {
    return normalizeSnapShotSettings(null);
  }
};

const writeSettingsFile = async (next) => {
  try {
    await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2));
  } catch (error) {
    console.error('Could not save SnapShot settings', error);
  }
};

export const configureSnapShot = async (raw) => {
  configured = true;
  const next = normalizeSnapShotSettings(raw);
  const changed = JSON.stringify(next) !== JSON.stringify(settings);
  settings = next;
  if (changed) {
    await writeSettingsFile(next);
    await armTrigger();
  }
  return snapShotState();
};

// ---------------------------------------------------------------------------
// Capture

const permissionsState = () =>
  supported
    ? {
        screenRecording: systemPreferences.getMediaAccessStatus('screen'),
        accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied',
      }
    : { screenRecording: 'unsupported', accessibility: 'unsupported' };

export const snapShotState = () => ({
  supported,
  settings,
  helper: helperStatus,
  trigger,
  capturing,
  lastError,
  pendingCount: pending.length,
  ...permissionsState(),
});

const playCaptureSound = () => {
  const sound = captureSoundPaths.find((candidate) => existsSync(candidate));
  if (!sound) return;
  try {
    const child = spawn('/usr/bin/afplay', [sound], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no sound is fine
  }
};

const focusApp = () => {
  let window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()) ?? null;
  if (!window) window = openWindow() ?? null;
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
};

const deliver = (attachments) => {
  pending.push(...attachments);
  focusApp();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('snapshot:available');
  }
};

const reportError = (message) => {
  lastError = { message, at: new Date().toISOString() };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('snapshot:error', lastError);
  }
  publishState();
};

const readAccessibility = async (window) => {
  const args = [
    'ax',
    '--pid', String(window.pid),
    '--window-bounds', [window.bounds.x, window.bounds.y, window.bounds.width, window.bounds.height].join(','),
    '--max-nodes', '2000',
    '--max-depth', '40',
    '--deadline-ms', String(axDeadlineMs),
  ];
  if (window.title) args.push('--title', window.title);
  return runHelper(args, axHardTimeoutMs + 500);
};

const encodeImage = (image) => {
  const size = image.getSize();
  const fitted = fitSnapShotImageSize(size);
  const resized = fitted.scaled ? image.resize({ width: fitted.width, height: fitted.height, quality: 'best' }) : image;
  const finalSize = resized.getSize();
  const png = resized.toPNG();
  if (png.byteLength <= SNAPSHOT_MAX_PNG_BYTES) {
    return { data: png, mimeType: 'image/png', extension: 'png', size: finalSize };
  }
  for (const quality of [85, 70, 55]) {
    const jpeg = resized.toJPEG(quality);
    if (jpeg.byteLength <= SNAPSHOT_MAX_PNG_BYTES || quality === 55) {
      return { data: jpeg, mimeType: 'image/jpeg', extension: 'jpg', size: finalSize };
    }
  }
  return { data: png, mimeType: 'image/png', extension: 'png', size: finalSize };
};

export const captureSnapShot = async ({ source = 'manual' } = {}) => {
  if (!supported) return { ok: false, error: 'SnapShot is only available on macOS.' };
  if (capturing) return { ok: false, error: 'A SnapShot is already being captured.' };
  capturing = true;
  publishState();
  const captureDir = path.join(getAttachmentDirectoryPath(), 'snapshots', crypto.randomUUID());
  try {
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      throw new Error(
        'SnapShot needs the Screen Recording permission. Grant it in Settings → Computer Use, then relaunch Durango Code.'
      );
    }
    const listing = await runHelper(['windows'], 5000);
    const window = selectSnapShotWindow(listing, [process.pid]);
    if (!window) throw new Error('There is no window to capture.');

    // Every app is read the same way: the user chose this window by pressing
    // the shortcut on it (password managers included).
    const axAllowed = settings.includeAppText && systemPreferences.isTrustedAccessibilityClient(false);
    const accessibility = axAllowed
      ? readAccessibility(window).catch((error) => {
          console.warn('SnapShot accessibility capture failed', error?.message ?? error);
          return null;
        })
      : Promise.resolve(null);

    await fs.mkdir(captureDir, { recursive: true });
    const rawImagePath = path.join(captureDir, 'capture-raw.png');
    // -l: one window; -o: no window shadow; -x: no sound; -t: format.
    await run('/usr/sbin/screencapture', ['-l', String(window.windowId), '-o', '-x', '-t', 'png', rawImagePath], {
      timeout: 10000,
    });
    if (source === 'shortcut' && settings.sound) playCaptureSound();
    const image = nativeImage.createFromPath(rawImagePath);
    if (image.isEmpty()) throw new Error('The window could not be captured. It may have closed.');
    const encoded = encodeImage(image);
    await fs.rm(rawImagePath, { force: true });

    const base = snapShotFileBase(window.appName, window.title);
    const imageName = `${base}.${encoded.extension}`;
    const imagePath = path.join(captureDir, imageName);
    await fs.writeFile(imagePath, encoded.data);
    const snapshotMeta = { appName: window.appName, windowTitle: window.title, bundleId: window.bundleId };
    const attachments = [
      {
        id: crypto.randomUUID(),
        name: imageName,
        path: imagePath,
        mimeType: encoded.mimeType,
        size: encoded.data.byteLength,
        snapshot: { kind: 'image', ...snapshotMeta },
      },
    ];

    const tree = await accessibility;
    if (tree && Array.isArray(tree.nodes)) {
      const outline = formatSnapShotOutline({
        appName: window.appName,
        bundleId: window.bundleId,
        title: window.title,
        imageSize: encoded.size,
        windowBounds: window.bounds,
        nodes: tree.nodes,
        truncated: tree.truncated === true,
      });
      const outlineName = `${base}.snapshot.md`;
      const outlinePath = path.join(captureDir, outlineName);
      await fs.writeFile(outlinePath, outline, 'utf8');
      attachments.push({
        id: crypto.randomUUID(),
        name: outlineName,
        path: outlinePath,
        mimeType: 'text/markdown',
        size: Buffer.byteLength(outline, 'utf8'),
        snapshot: { kind: 'accessibility', ...snapshotMeta, truncated: tree.truncated === true },
      });
    }

    lastError = null;
    deliver(attachments);
    return { ok: true, attachments };
  } catch (error) {
    await fs.rm(captureDir, { recursive: true, force: true }).catch(() => {});
    const message = error?.message ?? String(error);
    console.error('SnapShot capture failed', message);
    if (source === 'shortcut') {
      focusApp();
      reportError(message);
    }
    return { ok: false, error: message };
  } finally {
    capturing = false;
    publishState();
  }
};

// ---------------------------------------------------------------------------
// Lifecycle

export const registerSnapShotIpc = ({ createWindow }) => {
  if (typeof createWindow === 'function') openWindow = createWindow;
  ipcMain.handle('snapshot:configure', async (_event, raw) => configureSnapShot(raw));
  ipcMain.handle('snapshot:getState', async () => {
    if (supported && helperStatus === 'unknown') await resolveHelper();
    return snapShotState();
  });
  ipcMain.handle('snapshot:takePending', () => {
    const taken = pending;
    pending = [];
    return taken;
  });
  ipcMain.handle('snapshot:captureNow', async () => {
    const result = await captureSnapShot({ source: 'manual' });
    return result.ok ? { ok: true, count: result.attachments.length } : result;
  });
};

// Arms the trigger from the last saved settings so SnapShot works as soon as
// the app launches, before the renderer has loaded its store.
export const startSnapShot = async () => {
  if (!supported) return;
  const saved = await readSettingsFile();
  if (configured) return;
  settings = saved;
  if (settings.enabled) await armTrigger();
};

export const disposeSnapShot = () => {
  disposed = true;
  stopWatcher();
  unregisterAccelerator();
};
