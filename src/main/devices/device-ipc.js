import { readDeviceSettings, writeDeviceSettings } from './device-settings.js';
import { AGENT_DEVICE, ensureToolInstalled, toolStatus } from './device-toolchain.js';
import { listDevices, platformAvailability } from './device-platforms.js';
import {
  closeAllDevices,
  closeDeviceForUser,
  closeThreadDevices,
  listOpenDevices,
  pruneDeviceLaunchersOnStart,
  screenshotForUser,
  showOpenDevice,
} from '../device-tools.js';

// Renderer-facing device IPC (Settings → Devices and the per-thread device
// card). User actions need "Use devices"; only agents need the second toggle.

const errorText = (error) => error?.message ?? String(error);

const usingDevices = async () => (await readDeviceSettings()).useDevices;
const devicesOff = { ok: false, error: 'Devices are turned off (Settings → Devices).' };

const startAgentDeviceInstall = () => {
  ensureToolInstalled(AGENT_DEVICE).catch((error) => console.error('agent-device install failed:', errorText(error)));
};

export const deviceStatus = async () => {
  const [settings, platforms, agentDevice] = await Promise.all([
    readDeviceSettings(),
    platformAvailability(),
    toolStatus(AGENT_DEVICE).catch((error) => ({ name: AGENT_DEVICE, installed: false, error: errorText(error) })),
  ]);
  return { settings, platforms, agentDevice };
};

export const registerDeviceIpc = (ipcMain) => {
  ipcMain.handle('devices:getSettings', () => readDeviceSettings());

  ipcMain.handle('devices:setSettings', async (_event, patch) => {
    const before = await readDeviceSettings();
    const settings = await writeDeviceSettings(patch ?? {});
    // Granting agent access is the consent to install agent-device; start it
    // now so the first device_open does not wait. Needs bun or npm (Settings
    // says to install Node.js when neither is there).
    if (settings.agentsCanUseDevices && !before.agentsCanUseDevices) {
      const status = await toolStatus(AGENT_DEVICE).catch(() => null);
      if (status && !status.installed && status.installer) startAgentDeviceInstall();
    }
    return settings;
  });

  ipcMain.handle('devices:status', () => deviceStatus());

  ipcMain.handle('devices:installAgentDevice', async () => {
    if (!(await readDeviceSettings()).agentsCanUseDevices) {
      return { ok: false, error: 'Turn on "Agents can use devices" first.', status: await deviceStatus() };
    }
    try {
      await ensureToolInstalled(AGENT_DEVICE);
      return { ok: true, status: await deviceStatus() };
    } catch (error) {
      return { ok: false, error: errorText(error), status: await deviceStatus() };
    }
  });

  ipcMain.handle('devices:list', async (_event, input) => {
    if (!(await usingDevices())) return { ...devicesOff, devices: [] };
    try {
      const platform = input?.platform === 'ios' || input?.platform === 'android' ? input.platform : undefined;
      return { ok: true, ...(await listDevices({ platform })) };
    } catch (error) {
      return { ok: false, error: errorText(error), devices: [] };
    }
  });

  ipcMain.handle('devices:openState', (_event, threadId) =>
    typeof threadId === 'string' ? listOpenDevices(threadId) : []
  );

  ipcMain.handle('devices:screenshot', async (_event, input) => {
    if (!(await usingDevices())) return devicesOff;
    return screenshotForUser({ threadId: String(input?.threadId ?? ''), deviceId: String(input?.deviceId ?? '') });
  });

  ipcMain.handle('devices:show', async (_event, input) => {
    if (!(await usingDevices())) return devicesOff;
    return showOpenDevice({ threadId: String(input?.threadId ?? ''), deviceId: String(input?.deviceId ?? '') });
  });

  // Closing is always allowed, even with devices turned off.
  ipcMain.handle('devices:close', (_event, input) =>
    closeDeviceForUser({
      threadId: String(input?.threadId ?? ''),
      deviceId: String(input?.deviceId ?? ''),
      shutdown: input?.shutdown === true,
    })
  );

  ipcMain.handle('devices:closeThread', async (_event, threadId) => {
    if (typeof threadId === 'string' && threadId) await closeThreadDevices(threadId);
    return { ok: true };
  });
};

/** App start: load settings into the cache and drop launchers left by the last run. */
export const initDevices = async () => {
  await readDeviceSettings();
  await pruneDeviceLaunchersOnStart();
};

/** Longest the quit barrier waits for device cleanup before letting the app exit. */
export const DEVICE_SHUTDOWN_TIMEOUT_MS = 10_000;
let shutdownPromise = null;

/**
 * App quit: end agent-device sessions and stop its daemon (devices keep
 * running). Idempotent: every caller (the ordinary and the updater quit
 * barriers) gets the same promise. Never rejects, and settles within
 * `timeoutMs` so a wedged agent-device cannot hold quit open.
 */
export const shutdownDevices = ({ timeoutMs = DEVICE_SHUTDOWN_TIMEOUT_MS, closeAll = closeAllDevices } = {}) => {
  shutdownPromise ??= new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    Promise.resolve()
      .then(() => closeAll())
      .catch((error) => console.error('Device cleanup on quit failed:', errorText(error)))
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
  return shutdownPromise;
};

/** Test hook. */
export const resetDeviceShutdownForTests = () => {
  shutdownPromise = null;
};
