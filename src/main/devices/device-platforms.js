import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { resolveCommandPath, shellPathSyncPromise } from '../shell-env.js';

// Local iOS Simulators (xcrun simctl) and Android Emulators (adb/emulator).
// Everything here is plain CLI work: list, boot, show, screenshot, shut down.
// Driving the UI is agent-device's job (agent-device-launcher.js).
//
// Device ids: an iOS simulator is its UDID; a running Android device or
// emulator is its adb serial; an Android Virtual Device that is not running
// is `avd:<name>` until it boots (then it is its emulator serial).

export const AVD_PREFIX = 'avd:';

const run = (command, args, { timeout = 30_000, encoding = 'utf8', maxBuffer = 32 * 1024 * 1024 } = {}) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout, encoding, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || '').trim() || error.message;
        reject(Object.assign(new Error(detail), { code: error.code, stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

// -------------------- iOS --------------------

const RUNTIME_PREFIX = 'com.apple.CoreSimulator.SimRuntime.';

/** "com.apple.CoreSimulator.SimRuntime.iOS-26-3" → { os: 'iOS', version: '26.3' }. */
export const parseSimRuntime = (key) => {
  const name = String(key || '').startsWith(RUNTIME_PREFIX) ? key.slice(RUNTIME_PREFIX.length) : String(key || '');
  const match = name.match(/^([A-Za-z]+)-(\d+(?:-\d+)*)$/);
  if (!match) return { os: name, version: '' };
  return { os: match[1], version: match[2].replace(/-/g, '.') };
};

const simState = (state) => {
  const value = String(state || '').toLowerCase();
  if (value === 'booted') return 'booted';
  if (value === 'shutdown') return 'shutdown';
  if (value === 'booting') return 'booting';
  if (value === 'shutting down') return 'shutting-down';
  return value || 'unknown';
};

/**
 * Parses `xcrun simctl list devices --json` into iOS (and iPadOS) simulators
 * on available runtimes, booted first, then newest runtime, then name.
 */
export const parseSimctlDevices = (json) => {
  let parsed = json;
  if (typeof json === 'string') {
    try {
      parsed = JSON.parse(json);
    } catch {
      return [];
    }
  }
  const devices = [];
  for (const [runtimeKey, list] of Object.entries(parsed?.devices ?? {})) {
    const runtime = parseSimRuntime(runtimeKey);
    if (runtime.os !== 'iOS' || !Array.isArray(list)) continue;
    for (const device of list) {
      if (!device || device.isAvailable === false || typeof device.udid !== 'string') continue;
      devices.push({
        id: device.udid,
        name: String(device.name ?? device.udid),
        platform: 'ios',
        version: runtime.version,
        state: simState(device.state),
        kind: /iPad/i.test(String(device.deviceTypeIdentifier ?? device.name ?? '')) ? 'tablet' : 'phone',
      });
    }
  }
  const versionKey = (version) => version.split('.').map((part) => part.padStart(4, '0')).join('.');
  return devices.sort(
    (a, b) =>
      Number(b.state === 'booted') - Number(a.state === 'booted') ||
      versionKey(b.version).localeCompare(versionKey(a.version)) ||
      Number(a.kind === 'tablet') - Number(b.kind === 'tablet') ||
      a.name.localeCompare(b.name)
  );
};

export const iosAvailability = async () => {
  if (process.platform !== 'darwin') return { available: false, reason: 'iOS Simulators need macOS.' };
  await shellPathSyncPromise;
  if (!existsSync('/usr/bin/xcrun')) {
    return { available: false, reason: 'Xcode command line tools are not installed (xcrun is missing).' };
  }
  try {
    await run('/usr/bin/xcrun', ['simctl', 'list', 'runtimes', '--json'], { timeout: 20_000 });
  } catch (error) {
    return {
      available: false,
      reason: `simctl is unavailable: ${firstLine(error.message)}. Install Xcode and open it once to finish setup.`,
    };
  }
  return { available: true, reason: null };
};

export const listIosDevices = async () => {
  const { stdout } = await run('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
    timeout: 20_000,
  });
  return parseSimctlDevices(stdout);
};

export const showIosSimulator = async (udid) => {
  await run('/usr/bin/open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid], { timeout: 15_000 });
};

export const bootIos = async (udid) => {
  try {
    await run('/usr/bin/xcrun', ['simctl', 'boot', udid], { timeout: 120_000 });
  } catch (error) {
    // Booting a booted simulator is fine.
    if (!/current state: Booted/i.test(error.message)) throw error;
  }
  await showIosSimulator(udid).catch(() => {});
  await run('/usr/bin/xcrun', ['simctl', 'bootstatus', udid, '-b'], { timeout: 180_000 });
};

export const shutdownIos = async (udid) => {
  try {
    await run('/usr/bin/xcrun', ['simctl', 'shutdown', udid], { timeout: 60_000 });
  } catch (error) {
    if (!/current state: Shutdown/i.test(error.message)) throw error;
  }
};

export const screenshotIos = async (udid) => {
  const file = path.join(os.tmpdir(), `durango-sim-${udid}-${process.pid}-${Date.now()}.png`);
  try {
    await run('/usr/bin/xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', file], { timeout: 30_000 });
    return await fs.readFile(file);
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
};

// -------------------- Android --------------------

export const androidSdkCandidates = (env = process.env, home = os.homedir(), platform = process.platform) =>
  [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    platform === 'darwin' ? path.join(home, 'Library', 'Android', 'sdk') : null,
    platform === 'linux' ? path.join(home, 'Android', 'Sdk') : null,
    platform === 'win32' && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Android', 'Sdk') : null,
  ].filter((value, index, all) => typeof value === 'string' && value && all.indexOf(value) === index);

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

/** `{ sdkRoot, adb, emulator }`: absolute paths or null. */
export const resolveAndroidTools = async () => {
  await shellPathSyncPromise;
  const sdkRoot = androidSdkCandidates().find((dir) => existsSync(dir)) ?? null;
  const inSdk = (...parts) => {
    if (!sdkRoot) return null;
    const candidate = path.join(sdkRoot, ...parts);
    return existsSync(candidate) ? candidate : null;
  };
  const adb = inSdk('platform-tools', exe('adb')) ?? (await resolveCommandPath('adb'));
  const emulator = inSdk('emulator', exe('emulator')) ?? (await resolveCommandPath('emulator'));
  return { sdkRoot, adb: adb || null, emulator: emulator || null };
};

export const androidAvailability = async (tools) => {
  const { adb, emulator, sdkRoot } = tools ?? (await resolveAndroidTools());
  if (!adb) {
    return {
      available: false,
      reason: sdkRoot
        ? `adb is missing from the Android SDK at ${sdkRoot}. Install "Android SDK Platform-Tools" in Android Studio's SDK Manager.`
        : 'No Android SDK found (checked ANDROID_HOME, ANDROID_SDK_ROOT and the default location). Install Android Studio to use emulators.',
    };
  }
  return {
    available: true,
    reason: emulator ? null : 'The Android emulator is not installed, so only devices that are already running are listed.',
  };
};

/** Parses `adb devices -l`. */
export const parseAdbDevices = (stdout) => {
  const devices = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('List of devices') || trimmed.startsWith('*')) continue;
    const [serial, state, ...rest] = trimmed.split(/\s+/);
    if (!serial || !state) continue;
    const props = {};
    for (const part of rest) {
      const index = part.indexOf(':');
      if (index > 0) props[part.slice(0, index)] = part.slice(index + 1);
    }
    devices.push({
      serial,
      state,
      model: props.model ? props.model.replace(/_/g, ' ') : null,
      emulator: serial.startsWith('emulator-'),
    });
  }
  return devices;
};

/** Parses `emulator -list-avds` (skips the emulator's own log lines). */
export const parseAvdList = (stdout) =>
  String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && /^[\w.\- ]+$/.test(line) && !/^(INFO|WARNING|ERROR)\b/.test(line));

const adbState = (state) => (state === 'device' ? 'booted' : state === 'offline' ? 'booting' : state);

export const emulatorAvdName = async (adb, serial) => {
  try {
    const { stdout } = await run(adb, ['-s', serial, 'emu', 'avd', 'name'], { timeout: 5_000 });
    const name = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line && line !== 'OK');
    return name || null;
  } catch {
    return null;
  }
};

const androidVersion = async (adb, serial) => {
  try {
    const { stdout } = await run(adb, ['-s', serial, 'shell', 'getprop', 'ro.build.version.release'], {
      timeout: 5_000,
    });
    return stdout.trim();
  } catch {
    return '';
  }
};

export const listAndroidDevices = async (tools) => {
  const { adb, emulator } = tools ?? (await resolveAndroidTools());
  if (!adb) return [];
  const { stdout } = await run(adb, ['devices', '-l'], { timeout: 15_000 });
  const attached = parseAdbDevices(stdout);
  const running = await Promise.all(
    attached.map(async (device) => {
      const avd = device.emulator ? await emulatorAvdName(adb, device.serial) : null;
      const state = adbState(device.state);
      return {
        id: device.serial,
        name: avd ? avd.replace(/_/g, ' ') : device.model ?? device.serial,
        platform: 'android',
        version: state === 'booted' ? await androidVersion(adb, device.serial) : '',
        state,
        kind: device.emulator ? 'emulator' : 'physical',
        avd,
      };
    })
  );
  let avds = [];
  if (emulator) {
    try {
      avds = parseAvdList((await run(emulator, ['-list-avds'], { timeout: 15_000 })).stdout);
    } catch {}
  }
  const runningAvds = new Set(running.map((device) => device.avd).filter(Boolean));
  const stopped = avds
    .filter((avd) => !runningAvds.has(avd))
    .map((avd) => ({
      id: `${AVD_PREFIX}${avd}`,
      name: avd.replace(/_/g, ' '),
      platform: 'android',
      version: '',
      state: 'shutdown',
      kind: 'emulator',
      avd,
    }));
  return [...running, ...stopped];
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts AVD `avd` and resolves to its serial once Android finished booting. */
export const bootAndroidAvd = async (avd, { timeoutMs = 240_000 } = {}) => {
  const tools = await resolveAndroidTools();
  if (!tools.adb || !tools.emulator) throw new Error('The Android emulator or adb is not installed.');
  const child = spawn(tools.emulator, ['-avd', avd], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  const deadline = Date.now() + timeoutMs;
  let serial = null;
  while (Date.now() < deadline) {
    if (!serial) {
      const { stdout } = await run(tools.adb, ['devices', '-l'], { timeout: 10_000 }).catch(() => ({ stdout: '' }));
      for (const device of parseAdbDevices(stdout).filter((entry) => entry.emulator)) {
        if ((await emulatorAvdName(tools.adb, device.serial)) === avd) serial = device.serial;
      }
    }
    if (serial) {
      try {
        const { stdout } = await run(tools.adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
          timeout: 5_000,
        });
        if (stdout.trim() === '1') return serial;
      } catch {}
    }
    await sleep(2_000);
  }
  throw new Error(`The ${avd} emulator did not finish booting within ${Math.round(timeoutMs / 1000)}s.`);
};

export const shutdownAndroid = async (serial) => {
  const { adb } = await resolveAndroidTools();
  if (!adb) throw new Error('adb is not installed.');
  if (!serial.startsWith('emulator-')) throw new Error('Only emulators can be shut down; this is a physical device.');
  await run(adb, ['-s', serial, 'emu', 'kill'], { timeout: 30_000 });
};

export const screenshotAndroid = async (serial) => {
  const { adb } = await resolveAndroidTools();
  if (!adb) throw new Error('adb is not installed.');
  const { stdout } = await run(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], {
    timeout: 30_000,
    encoding: 'buffer',
  });
  if (!Buffer.isBuffer(stdout) || stdout.length < 8) throw new Error('adb returned an empty screenshot.');
  return stdout;
};

// -------------------- Both --------------------

const firstLine = (text) => String(text || '').trim().split('\n')[0];

/** `{ ios: {available, reason}, android: {available, reason} }`. */
export const platformAvailability = async () => {
  const [ios, android] = await Promise.all([
    iosAvailability().catch((error) => ({ available: false, reason: firstLine(error.message) })),
    androidAvailability().catch((error) => ({ available: false, reason: firstLine(error.message) })),
  ]);
  return { ios, android };
};

/** Devices of the available platforms (optionally one platform) plus availability. */
export const listDevices = async ({ platform } = {}) => {
  const availability = await platformAvailability();
  const wants = (name) => !platform || platform === name;
  const errors = {};
  const [ios, android] = await Promise.all([
    wants('ios') && availability.ios.available
      ? listIosDevices().catch((error) => {
          errors.ios = firstLine(error.message);
          return [];
        })
      : [],
    wants('android') && availability.android.available
      ? listAndroidDevices().catch((error) => {
          errors.android = firstLine(error.message);
          return [];
        })
      : [],
  ]);
  return { devices: [...ios, ...android], availability, errors };
};

/** Boots `device` if needed; resolves to its (possibly new) id. */
export const bootDevice = async (device) => {
  if (device.platform === 'ios') {
    if (device.state !== 'booted') await bootIos(device.id);
    else await showIosSimulator(device.id).catch(() => {});
    return device.id;
  }
  if (device.id.startsWith(AVD_PREFIX)) return bootAndroidAvd(device.avd ?? device.id.slice(AVD_PREFIX.length));
  return device.id;
};

export const shutdownDevice = async (device) =>
  device.platform === 'ios' ? shutdownIos(device.id) : shutdownAndroid(device.id);

export const screenshotDevice = async (device) =>
  device.platform === 'ios' ? screenshotIos(device.id) : screenshotAndroid(device.id);

/** Brings the device's window forward (the Simulator app on iOS). */
export const showDevice = async (device) => {
  if (device.platform === 'ios') return showIosSimulator(device.id);
  return undefined;
};
