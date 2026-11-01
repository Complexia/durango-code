import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';

// Simulator tools are opt-in twice over (userData/devices.json):
//   useDevices           the user can list, open, screenshot and close iOS
//                        Simulators and Android Emulators from Durango Code;
//   agentsCanUseDevices  agents get the device_* tools and the agent-device
//                        CLI. Meaningless without useDevices: it reads back
//                        false while that is off, and turning it off clears it.
// Every agent-facing entry point re-reads the file at call time, so turning
// either toggle off takes effect on the next tool call of a running agent.

export const DEFAULT_DEVICE_SETTINGS = Object.freeze({ useDevices: false, agentsCanUseDevices: false });

let dataRootOverride = null;
/** Root for devices.json and userData/devices/* (tests point it at a temp dir). */
export const deviceDataRoot = () => dataRootOverride ?? app.getPath('userData');
export const setDeviceDataRootForTests = (dir) => {
  dataRootOverride = dir;
  cachedSettings = null;
};

export const deviceSettingsFile = () => path.join(deviceDataRoot(), 'devices.json');

export const normalizeDeviceSettings = (raw) => {
  const useDevices = raw?.useDevices === true;
  return { useDevices, agentsCanUseDevices: useDevices && raw?.agentsCanUseDevices === true };
};

export const agentDeviceAccessAllowed = (settings) =>
  Boolean(settings?.useDevices && settings?.agentsCanUseDevices);

let cachedSettings = null;

/** Last settings read or written by this process; defaults before the first read. */
export const getCachedDeviceSettings = () => cachedSettings ?? { ...DEFAULT_DEVICE_SETTINGS };

/** Reads devices.json (missing or invalid → defaults, both off). Never throws. */
export const readDeviceSettings = async () => {
  let raw = null;
  try {
    raw = JSON.parse(await fs.readFile(deviceSettingsFile(), 'utf8'));
  } catch {}
  cachedSettings = normalizeDeviceSettings(raw);
  return cachedSettings;
};

let writeQueue = Promise.resolve();

/** Merges `patch` into the stored settings and returns the normalized result. */
export const writeDeviceSettings = (patch) => {
  const run = async () => {
    const current = await readDeviceSettings();
    const next = normalizeDeviceSettings({
      ...current,
      ...(typeof patch?.useDevices === 'boolean' ? { useDevices: patch.useDevices } : {}),
      ...(typeof patch?.agentsCanUseDevices === 'boolean'
        ? { agentsCanUseDevices: patch.agentsCanUseDevices }
        : {}),
    });
    // Turning devices off also withdraws agent access, so turning devices back
    // on later never silently re-grants it.
    if (!next.useDevices) next.agentsCanUseDevices = false;
    const file = deviceSettingsFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, file);
    cachedSettings = next;
    return next;
  };
  const result = writeQueue.then(run, run);
  writeQueue = result.catch(() => {});
  return result;
};

/** Agent-facing refusal, or null when agents may use devices right now. */
export const agentDeviceRefusal = async () => {
  const settings = await readDeviceSettings();
  if (!settings.useDevices) {
    return 'Simulator tools are turned off in Durango Code (Settings → Devices → Use devices). Ask the user to turn them on if they want you to use a simulator or emulator.';
  }
  if (!settings.agentsCanUseDevices) {
    return 'The user has not allowed agents to use devices (Settings → Devices → Agents can use devices). Ask them to turn it on if they want you to drive a simulator or emulator.';
  }
  return null;
};
