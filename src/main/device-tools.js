import path from 'node:path';
import fs from 'node:fs/promises';
import { agentDeviceRefusal, deviceDataRoot } from './devices/device-settings.js';
import { ORION_DEVICE_TOOL_NAMES } from './thread-reader-routing.js';
import { AGENT_DEVICE, ensureToolInstalled } from './devices/device-toolchain.js';
import {
  AVD_PREFIX,
  bootDevice,
  listDevices,
  screenshotDevice,
  showDevice,
  shutdownDevice,
} from './devices/device-platforms.js';
import {
  closeAgentDeviceSession,
  pruneLaunchers,
  removeLauncher,
  stopAgentDeviceDaemon,
  writeAgentDeviceLauncher,
} from './devices/agent-device-launcher.js';

// Side-effecting dependencies, swappable in tests (setDeviceToolDepsForTests).
const deps = {
  listDevices,
  bootDevice,
  screenshotDevice,
  shutdownDevice,
  ensureToolInstalled,
  writeAgentDeviceLauncher,
  closeAgentDeviceSession,
  removeLauncher,
  stopAgentDeviceDaemon,
};
const realDeps = { ...deps };

// Simulator tools on Durango Code's built-in `orion` MCP server: device_list,
// device_open, device_screenshot, device_close. They are only offered when the
// user turned on Settings → Devices → "Use devices" and "Agents can use
// devices"; every call re-checks both, so turning them off mid-run refuses
// the next call. Claude registers them on the in-process SDK server
// (claude-driver.js); every other provider gets them from the bridge shim
// (mcp-bridge-shim.cjs → mcp-bridge.js) when registerMcpBridgeForRun passes
// --devices. The shim duplicates the descriptions and schemas below;
// test-durango-tools.mjs keeps them in sync.
//
// Driving the UI is not a tool: device_open returns an agent-device launcher
// bound to the device and a short quick start. agent-device's semantic
// snapshots (refs like @e3) are what agents need, and the CLI keeps its own
// help current with its version.
//
// Handlers resolve to `{ ok, text, content? }` and never throw. `content` is
// MCP content blocks (an image for device_screenshot) that the bridge passes
// through as-is.
//
// Access mode: in Read only, agents may list devices and screenshot running
// ones; device_open (boots, hands out a launcher that drives the UI) and
// device_close (ends sessions, can shut down) are refused. Every path passes
// the run's mode (claude-driver.js, mcp-bridge.js), so this holds even where
// the provider auto-approves every `orion` tool.
//
// Concurrency: open, close and shutdown of one device run one at a time
// (withDeviceLock), and every registry record carries a generation, so a
// close that was queued behind a reopen skips its cleanup and its event
// instead of deleting the new launcher. A device is open in at most one
// thread: agent-device allows one session per device, so device_open names
// the owning thread instead of returning a launcher that would fail.
// device_open re-reads the device under the lock when a shutdown ran since it
// listed devices (a reopen queued behind Close + Shut down boots it again).
//
// Cleanup (thread delete, quit) also covers opens still in flight: it cancels
// them (they then neither register nor keep a launcher; a device one of them
// booted keeps running, as after a normal close) and waits for them to settle
// before it resolves. Quit also refuses opens that start after it.

export const DEVICE_TOOL_NAMES = ORION_DEVICE_TOOL_NAMES;

export const DEVICE_TOOL_DESCRIPTIONS = Object.freeze({
  device_list:
    'List the iOS Simulators and Android Emulators on this machine (id, name, platform, OS version, state, and whether this thread has it open), plus whether each platform is available and why not. Use it before device_open when you need a specific device.',
  device_open:
    'Open an iOS Simulator or Android Emulator for this thread, booting it if needed; the user watches it in Durango Code. Returns the path of an agent-device command bound to that device and a quick start for driving it (open an app, snapshot, press, fill, screenshot). Without arguments it picks a booted device, else a default iPhone simulator.',
  device_screenshot:
    'Take a screenshot of a device and return it as an image (also saved to a file whose path is returned). Without deviceId it uses the device this thread has open. Durango Code also shows it to the user.',
  device_close:
    "Close a device this thread opened: ends its agent-device session (quitting the app that session opened) and removes the launcher. Pass shutdown: true to also shut the simulator or emulator down. Without deviceId it closes this thread's only open device.",
});

export const DEVICE_TOOL_INPUT_SCHEMAS = Object.freeze({
  device_list: {
    type: 'object',
    properties: {
      platform: { type: 'string', enum: ['ios', 'android'], description: 'Only list devices of this platform' },
    },
    additionalProperties: false,
  },
  device_open: {
    type: 'object',
    properties: {
      deviceId: {
        type: 'string',
        description: 'Device id from device_list (a simulator UDID, an adb serial, or avd:<name>)',
      },
      platform: {
        type: 'string',
        enum: ['ios', 'android'],
        description: 'Pick a device of this platform when no deviceId is given',
      },
    },
    additionalProperties: false,
  },
  device_screenshot: {
    type: 'object',
    properties: {
      deviceId: { type: 'string', description: "Device id; defaults to this thread's open device" },
    },
    additionalProperties: false,
  },
  device_close: {
    type: 'object',
    properties: {
      deviceId: { type: 'string', description: "Device id; defaults to this thread's only open device" },
      shutdown: { type: 'boolean', description: 'Also shut the simulator or emulator down (default false)' },
    },
    additionalProperties: false,
  },
});

/** One-line system-prompt hint for Claude when agent access is on. */
export const DEVICE_TOOLS_PROMPT_HINT = [
  '# Simulators and emulators (Durango Code)',
  'For iOS Simulator or Android Emulator UI work, call mcp__orion__device_open and drive the device with the agent-device launcher it returns (the user watches the device in Durango Code); use simctl or adb only for what those tools do not cover.',
].join('\n');

/** Long edge of the screenshot handed to the agent (the saved file stays full size). */
export const AGENT_SCREENSHOT_MAX_EDGE = 1568;
/** Long edge of the copy shown on the device card (it polls, so keep it small). */
export const CARD_SCREENSHOT_MAX_EDGE = 900;
const pngDataUrl = (png) => `data:image/png;base64,${png.toString('base64')}`;
const SCREENSHOTS_KEPT = 10;

export const quickStartText = ({ device, command, session }) => {
  const q = command.includes(' ') ? `"${command}"` : command;
  const lines = [
    `Opened ${device.name} (${device.platform === 'ios' ? 'iOS' : 'Android'}${device.version ? ` ${device.version}` : ''}, id ${device.id}). The user is watching it in Durango Code.`,
    '',
    `Drive it with this exact command (it is already bound to this device and to agent-device session ${session}; do not add --platform, --udid, --serial or --session):`,
    `  ${q}`,
    '',
    'Quick start:',
    `  ${q} open <bundle-id or package> --foreground   # start here; returns a snapshot with @refs`,
    `  ${q} snapshot -i                                 # interactive elements with refs like @e3`,
    `  ${q} press @e3 --settle                          # tap, wait for the UI to settle, print the diff`,
    `  ${q} fill @e5 "text" --settle                    # replace the text of an input`,
    `  ${q} screenshot                                  # or device_screenshot to see it yourself`,
    `  ${q} help workflow                               # refs, selectors, waits, recovery`,
    '',
    'Prefer refs (@e3) and selectors over coordinates; refs go stale after the screen changes, so re-snapshot when one fails. Use agent-device for UI, not simctl or adb. Run commands one at a time and stop once the requested state is visible.',
  ];
  if (device.platform === 'ios') {
    lines.push(
      'The first iOS command on a simulator builds and installs agent-device\'s XCTest runner, which can take a few minutes; let it finish instead of retrying.'
    );
  }
  lines.push(
    'If the command reports that a sandbox blocks localhost, run it again with network access (outside the sandbox). Call device_close when you are done with the device.'
  );
  return lines.join('\n');
};

// -------------------- Per-thread registry --------------------

// threadId -> Map(deviceId -> { device, session, command, entry, openedAt, generation })
const openDevices = new Map();
let generationSeq = 0;

// deviceId -> tail of that device's open/close/shutdown chain.
const deviceLocks = new Map();
/** Runs `fn` after every earlier open/close/shutdown of `deviceId` settled. */
const withDeviceLock = (deviceId, fn) => {
  const previous = deviceLocks.get(deviceId) ?? Promise.resolve();
  const run = previous.then(() => fn());
  const tail = run.then(
    () => {},
    () => {}
  );
  deviceLocks.set(deviceId, tail);
  void tail.then(() => {
    if (deviceLocks.get(deviceId) === tail) deviceLocks.delete(deviceId);
  });
  return run;
};

// Bumped when a device tool shuts a device down: a device_open that listed
// devices before then re-reads its device under the lock.
let shutdownSeq = 0;

// threadId -> Set of in-flight device_open operations `{ cancelled, done }`.
const pendingOpens = new Map();
let quitting = false;

/** Cancels the in-flight opens of `threadId` (every thread when omitted); returns them. */
const cancelPendingOpens = (threadId) => {
  const ops = threadId === undefined ? [...pendingOpens.values()].flatMap((set) => [...set]) : [...(pendingOpens.get(threadId) ?? [])];
  for (const op of ops) op.cancelled = true;
  return ops;
};

const isCurrentRecord = (threadId, record) =>
  openDevices.get(threadId)?.get(record.device.id)?.generation === record.generation;
// agent-device entry of the last launcher written: its daemon may be running
// (it outlives sessions), so quitting stops it even with no device open.
let daemonEntry = null;

export const openDevicesForThread = (threadId) => [...(openDevices.get(threadId)?.values() ?? [])];

const publicOpenDevice = (entry) => ({
  device: entry.device,
  session: entry.session,
  command: entry.command,
  openedAt: entry.openedAt,
});

export const listOpenDevices = (threadId) => openDevicesForThread(threadId).map(publicOpenDevice);

const isOpenAnywhere = (deviceId) => [...openDevices.values()].some((devices) => devices.has(deviceId));

/** The thread (other than `threadId`) that has `deviceId` open, or null. */
const otherOwner = (threadId, deviceId) => {
  for (const [owner, devices] of openDevices) {
    if (owner !== threadId && devices.has(deviceId)) return owner;
  }
  return null;
};

const READ_ONLY_REFUSAL = (name) =>
  `This thread is in Read only mode, so ${name} is not available: ${name === 'device_open' ? 'opening boots a simulator or emulator and hands out a launcher that drives it' : 'closing ends the device session and can shut the device down'}. In Read only you can list devices (device_list) and take screenshots of running ones (device_screenshot). Ask the user to switch the thread's access mode if you need more.`;

const sendDeviceEvent = (getSender, payload) => {
  const sender = getSender?.();
  if (!sender || sender.isDestroyed?.()) return;
  try {
    sender.send('agent:device', payload);
  } catch {}
};

let lastSender = null;
/** Remembers the window that last ran a device tool, for user-side events. */
const rememberSender = (getSender) => {
  if (getSender) lastSender = getSender;
};

const formatDevice = (device, threadId) => {
  const here = openDevices.get(threadId)?.has(device.id);
  const elsewhere = !here && otherOwner(threadId, device.id);
  return `- ${device.name} — ${device.platform === 'ios' ? 'iOS' : 'Android'}${device.version ? ` ${device.version}` : ''}, ${device.state}${device.kind === 'physical' ? ', physical device' : ''}${here ? ', open in this thread' : ''}${elsewhere ? `, open in another thread (${elsewhere})` : ''} — id ${device.id}`;
};

const availabilityLine = (name, value) =>
  `${name}: ${value.available ? 'available' : 'unavailable'}${value.reason ? ` (${value.reason})` : ''}`;

const findDevice = (devices, deviceId) => {
  const wanted = String(deviceId).trim();
  return (
    devices.find((device) => device.id === wanted) ??
    devices.find((device) => device.avd && `${AVD_PREFIX}${device.avd}` === wanted) ??
    devices.find((device) => device.name.toLowerCase() === wanted.toLowerCase())
  );
};

/**
 * Default device for device_open: one this thread already has open, else
 * (skipping devices other threads have open and physical devices) booted
 * first, then an iPhone, then any.
 */
export const pickDefaultDevice = (devices, platform, { mine = new Set(), taken = new Set() } = {}) => {
  const matching = devices.filter((device) => !platform || device.platform === platform);
  const own = matching.find((device) => mine.has(device.id));
  if (own) return own;
  const candidates = matching.filter((device) => !taken.has(device.id) && device.kind !== 'physical');
  return (
    candidates.find((device) => device.state === 'booted' && device.platform === 'ios') ??
    candidates.find((device) => device.state === 'booted') ??
    candidates.find((device) => device.platform === 'ios' && device.kind === 'phone') ??
    candidates[0] ??
    null
  );
};

const screenshotsDir = (session) => path.join(deviceDataRoot(), 'devices', 'screenshots', session);

const saveScreenshot = async (key, png) => {
  const dir = screenshotsDir(key);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  await fs.writeFile(file, png);
  const existing = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.png')).sort();
  await Promise.all(
    existing.slice(0, Math.max(0, existing.length - SCREENSHOTS_KEPT)).map((name) =>
      fs.rm(path.join(dir, name), { force: true }).catch(() => {})
    )
  );
  return file;
};

// Electron's nativeImage scales the agent's copy; outside Electron (tests)
// the original is returned.
let nativeImageModule;
const loadNativeImage = async () => {
  if (nativeImageModule !== undefined) return nativeImageModule;
  try {
    nativeImageModule = (await import('electron')).nativeImage ?? null;
  } catch {
    nativeImageModule = null;
  }
  return nativeImageModule;
};

/** `{ png, width, height, originalWidth, originalHeight }` with the long edge <= maxEdge. */
export const scaleScreenshot = async (png, maxEdge = AGENT_SCREENSHOT_MAX_EDGE) => {
  const nativeImage = await loadNativeImage();
  if (!nativeImage?.createFromBuffer) return { png, width: null, height: null, originalWidth: null, originalHeight: null };
  const image = nativeImage.createFromBuffer(png);
  const { width, height } = image.getSize();
  if (!width || !height) return { png, width: null, height: null, originalWidth: null, originalHeight: null };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  if (scale === 1) return { png, width, height, originalWidth: width, originalHeight: height };
  const resized = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' });
  const size = resized.getSize();
  return { png: resized.toPNG(), width: size.width, height: size.height, originalWidth: width, originalHeight: height };
};

/** Screenshot of any device (user or agent): `{ png, file }`. */
export const captureDeviceScreenshot = async (device, key = device.id) => {
  const png = await deps.screenshotDevice(device);
  const file = await saveScreenshot(key.replace(/[^\w.-]/g, '_'), png);
  return { png, file };
};

const resolveTarget = async (threadId, deviceId, { requireOpen = false } = {}) => {
  const mine = openDevicesForThread(threadId);
  if (!deviceId) {
    if (mine.length === 1) return { entry: mine[0], device: mine[0].device };
    if (mine.length > 1) {
      return {
        error: `This thread has ${mine.length} devices open (${mine.map((entry) => `${entry.device.name}: ${entry.device.id}`).join(', ')}); pass deviceId.`,
      };
    }
    if (requireOpen) return { error: 'This thread has no device open. Call device_open first.' };
    const { devices } = await deps.listDevices();
    const booted = devices.filter((device) => device.state === 'booted');
    if (booted.length === 1) return { device: booted[0] };
    return {
      error:
        booted.length === 0
          ? 'No device is running. Call device_open first.'
          : 'Several devices are running and this thread has none open; pass deviceId (see device_list).',
    };
  }
  const entry = mine.find((candidate) => candidate.device.id === deviceId);
  if (entry) return { entry, device: entry.device };
  if (requireOpen) return { error: `This thread does not have ${deviceId} open.` };
  const { devices } = await deps.listDevices();
  const device = findDevice(devices, deviceId);
  return device ? { device } : { error: `No device with id ${deviceId}. Call device_list to see the ids.` };
};

/**
 * Closes one registry record under its device's lock. Resolves to false (and
 * touches nothing) when the record is stale: it was closed, or closed and
 * reopened, while this call waited. Callers emit `closed` only on true.
 */
const closeEntry = (threadId, record, { shutdown = false } = {}) =>
  withDeviceLock(record.device.id, async () => {
    if (!isCurrentRecord(threadId, record)) return false;
    openDevices.get(threadId)?.delete(record.device.id);
    if (openDevices.get(threadId)?.size === 0) openDevices.delete(threadId);
    if (record.entry) {
      await deps
        .closeAgentDeviceSession(record.entry, {
          platform: record.device.platform,
          deviceId: record.device.id,
          session: record.session,
        })
        .catch(() => {});
    }
    await deps.removeLauncher(record.session);
    if (shutdown && !isOpenAnywhere(record.device.id)) {
      shutdownSeq += 1;
      await deps.shutdownDevice(record.device);
    }
    return true;
  });

// -------------------- Tool handlers --------------------

const fail = (text) => ({ ok: false, text });

const handleList = async (args, { threadId }) => {
  const platform = args?.platform === 'ios' || args?.platform === 'android' ? args.platform : undefined;
  const { devices, availability, errors } = await deps.listDevices({ platform });
  const lines = [
    availabilityLine('iOS Simulators', availability.ios),
    availabilityLine('Android Emulators', availability.android),
    ...Object.entries(errors).map(([name, message]) => `Could not list ${name} devices: ${message}`),
    '',
    devices.length ? `Devices (${devices.length}):` : 'No devices found.',
    ...devices.map((device) => formatDevice(device, threadId)),
  ];
  return { ok: true, text: lines.join('\n') };
};

const inUseText = (device, owner, alternative) =>
  `${device.name} (id ${device.id}) is already open in another Durango Code thread (${owner}), and agent-device drives a device from one session at a time. ${
    alternative
      ? `Use another device, for example ${alternative.name} (id ${alternative.id}), or`
      : 'Use another device (see device_list), or'
  } ask the user to close it in that thread (Close on its device card).`;

const CANCELLED_TEXT = (device) =>
  `${device ? device.name : 'The device'} was not opened: this thread was deleted or Durango Code is quitting.`;

/** device_open, tracked so cleanup can cancel and wait for it. */
const handleOpen = (args, session) => {
  if (quitting) return Promise.resolve(fail(CANCELLED_TEXT(null)));
  const op = { cancelled: false, done: null };
  const run = openDevice(args, session, op);
  op.done = run.then(
    () => {},
    () => {}
  );
  if (!pendingOpens.has(session.threadId)) pendingOpens.set(session.threadId, new Set());
  pendingOpens.get(session.threadId).add(op);
  void op.done.then(() => {
    const ops = pendingOpens.get(session.threadId);
    ops?.delete(op);
    if (ops?.size === 0) pendingOpens.delete(session.threadId);
  });
  return run;
};

const openDevice = async (args, { threadId, getSender }, op) => {
  const platform = args?.platform === 'ios' || args?.platform === 'android' ? args.platform : undefined;
  const listedAt = shutdownSeq;
  const { devices, availability } = await deps.listDevices({ platform });
  const mine = new Set(openDevicesForThread(threadId).map((entry) => entry.device.id));
  const taken = new Set(devices.map((device) => device.id).filter((id) => otherOwner(threadId, id)));
  const alternativeTo = (device) =>
    pickDefaultDevice(
      devices.filter((candidate) => candidate.id !== device.id),
      device.platform,
      { taken }
    );
  let device;
  if (typeof args?.deviceId === 'string' && args.deviceId.trim()) {
    device = findDevice(devices, args.deviceId);
    if (!device) return fail(`No device with id ${args.deviceId}. Call device_list to see the ids.`);
  } else {
    device = pickDefaultDevice(devices, platform, { mine, taken });
    if (!device) {
      if (devices.some((candidate) => taken.has(candidate.id))) {
        const owned = devices.filter((candidate) => taken.has(candidate.id));
        return fail(
          `Every ${platform ? `${platform === 'ios' ? 'iOS' : 'Android'} ` : ''}device is open in another Durango Code thread (${owned
            .map((candidate) => `${candidate.name}: ${otherOwner(threadId, candidate.id)}`)
            .join(', ')}), and agent-device drives a device from one session at a time. Ask the user to close one there (Close on its device card), or to create another simulator or emulator.`
        );
      }
      const reasons = Object.entries(availability)
        .filter(([name, value]) => (!platform || name === platform) && !value.available)
        .map(([name, value]) => `${name}: ${value.reason}`);
      return fail(`No simulator or emulator is available.${reasons.length ? ` ${reasons.join(' ')}` : ''}`);
    }
  }
  if (device.kind === 'physical') {
    return fail('device_open only drives simulators and emulators; that is a physical device.');
  }
  const ownerBefore = otherOwner(threadId, device.id);
  if (ownerBefore) return fail(inUseText(device, ownerBefore, alternativeTo(device)));
  let entryPath;
  try {
    entryPath = (await deps.ensureToolInstalled(AGENT_DEVICE)).entry;
  } catch (error) {
    return fail(`Could not install agent-device: ${error?.message ?? error}`);
  }
  if (op.cancelled) return fail(CANCELLED_TEXT(device));
  // Boot and register under the device's lock, so a concurrent close or
  // shutdown of the same device finishes first (or waits for this).
  return withDeviceLock(device.id, async () => {
    if (op.cancelled) return fail(CANCELLED_TEXT(device));
    const lockedOwner = otherOwner(threadId, device.id);
    if (lockedOwner) return fail(inUseText(device, lockedOwner, alternativeTo(device)));
    // A close queued ahead of this may have shut the device down (an
    // emulator's serial is then gone; its AVD is listed instead): re-read it
    // rather than trust the state listed before the lock.
    let target = device;
    if (shutdownSeq !== listedAt) {
      const { devices: current } = await deps.listDevices({ platform: device.platform });
      target =
        current.find((candidate) => candidate.id === device.id) ??
        (device.avd ? current.find((candidate) => candidate.avd === device.avd) : undefined);
      if (!target) return fail(`${device.name} (id ${device.id}) is no longer available. Call device_list to see the devices.`);
      if (op.cancelled) return fail(CANCELLED_TEXT(device));
    }
    let bootedId;
    try {
      bootedId = await deps.bootDevice(target);
    } catch (error) {
      return fail(`Could not boot ${target.name}: ${error?.message ?? error}`);
    }
    const opened = { ...target, id: bootedId, state: 'booted' };
    const register = async () => {
      // Cancelled by cleanup: register nothing and leave no launcher. A
      // device this booted keeps running, as after a normal close.
      if (op.cancelled) return fail(CANCELLED_TEXT(opened));
      const owner = otherOwner(threadId, opened.id);
      if (owner) return fail(inUseText(opened, owner, alternativeTo(opened)));
      let record = openDevices.get(threadId)?.get(opened.id);
      if (!record) {
        const { session, command } = await deps.writeAgentDeviceLauncher({ threadId, device: opened, entry: entryPath });
        if (op.cancelled) {
          await deps.removeLauncher(session);
          return fail(CANCELLED_TEXT(opened));
        }
        record = {
          device: opened,
          session,
          command,
          entry: entryPath,
          openedAt: Date.now(),
          generation: ++generationSeq,
        };
        if (!openDevices.has(threadId)) openDevices.set(threadId, new Map());
        openDevices.get(threadId).set(opened.id, record);
      }
      daemonEntry = entryPath;
      sendDeviceEvent(getSender, { type: 'opened', threadId, ...publicOpenDevice(record) });
      const { session, command } = record;
      return {
        ok: true,
        text: `${quickStartText({ device: opened, command, session })}\n\n${JSON.stringify({ deviceId: opened.id, command, session })}`,
      };
    };
    // A stopped AVD (avd:<name>) boots into an adb serial: register under that
    // id's lock too (never the same lock twice, which would deadlock).
    return opened.id === device.id ? register() : withDeviceLock(opened.id, register);
  });
};

const handleScreenshot = async (args, { threadId, getSender, readOnly }) => {
  const target = await resolveTarget(threadId, typeof args?.deviceId === 'string' ? args.deviceId.trim() : '');
  if (target.error) return fail(target.error);
  const { device } = target;
  if (device.state !== 'booted') {
    return fail(
      readOnly
        ? `${device.name} is not running, and this thread is in Read only mode, which cannot boot it. Screenshot a running device instead (device_list shows which are booted).`
        : `${device.name} is not running. Call device_open first.`
    );
  }
  let shot;
  try {
    shot = await captureDeviceScreenshot(device, target.entry?.session ?? device.id);
  } catch (error) {
    return fail(`Could not take a screenshot of ${device.name}: ${error?.message ?? error}`);
  }
  const scaled = await scaleScreenshot(shot.png);
  sendDeviceEvent(getSender, {
    type: 'screenshot',
    threadId,
    deviceId: device.id,
    file: shot.file,
    dataUrl: pngDataUrl((await scaleScreenshot(shot.png, CARD_SCREENSHOT_MAX_EDGE)).png),
    takenAt: Date.now(),
  });
  const sizeNote =
    scaled.originalWidth && scaled.width !== scaled.originalWidth
      ? ` Scaled to ${scaled.width}x${scaled.height} from ${scaled.originalWidth}x${scaled.originalHeight} pixels; the saved file is full size.`
      : '';
  const text = `Screenshot of ${device.name} saved to ${shot.file}.${sizeNote} Prefer agent-device refs (snapshot -i) over coordinates read from this image.`;
  return {
    ok: true,
    text,
    content: [
      { type: 'image', data: scaled.png.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text },
    ],
  };
};

const handleClose = async (args, { threadId, getSender }) => {
  const target = await resolveTarget(threadId, typeof args?.deviceId === 'string' ? args.deviceId.trim() : '', {
    requireOpen: true,
  });
  if (target.error) return fail(target.error);
  let closed;
  try {
    closed = await closeEntry(threadId, target.entry, { shutdown: args?.shutdown === true });
  } catch (error) {
    sendDeviceEvent(getSender, { type: 'closed', threadId, deviceId: target.device.id });
    return fail(`Closed the session, but could not shut ${target.device.name} down: ${error?.message ?? error}`);
  }
  // Stale: another close (the user's, or a thread delete) got there first.
  if (!closed) return { ok: true, text: `${target.device.name} was already closed.` };
  sendDeviceEvent(getSender, { type: 'closed', threadId, deviceId: target.device.id });
  return {
    ok: true,
    text: `Closed ${target.device.name}${args?.shutdown === true ? ' and shut it down' : ''}.`,
  };
};

/**
 * Runs one device tool for the thread `threadId` in the run's `accessMode`.
 * Resolves to `{ ok, text, content? }`, never throws. Refuses unless the user
 * turned on both device settings (re-read on every call), and refuses
 * device_open/device_close in Read only.
 */
export const runDeviceTool = async (name, args, { threadId, getSender, accessMode } = {}) => {
  try {
    if (!DEVICE_TOOL_NAMES.includes(name)) return fail(`Unknown tool: ${name}`);
    const refusal = await agentDeviceRefusal();
    if (refusal) return fail(refusal);
    if (!threadId) return fail('This agent run is not attached to a Durango Code thread.');
    const readOnly = accessMode === 'read-only';
    if (readOnly && (name === 'device_open' || name === 'device_close')) return fail(READ_ONLY_REFUSAL(name));
    rememberSender(getSender);
    const session = { threadId, getSender, readOnly };
    if (name === 'device_list') return await handleList(args, session);
    if (name === 'device_open') return await handleOpen(args, session);
    if (name === 'device_screenshot') return await handleScreenshot(args, session);
    return await handleClose(args, session);
  } catch (error) {
    return fail(`${name} failed: ${error?.message ?? error}`);
  }
};

// -------------------- User-side (IPC) helpers --------------------

/** Closes devices the user closes from the card; emits `closed` like the tool. */
export const closeDeviceForUser = async ({ threadId, deviceId, shutdown = false }) => {
  const entry = openDevicesForThread(threadId).find((candidate) => candidate.device.id === deviceId);
  if (!entry) return { ok: false, error: 'That device is not open in this thread.' };
  let closed = true;
  try {
    closed = await closeEntry(threadId, entry, { shutdown });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  } finally {
    if (closed) sendDeviceEvent(lastSender, { type: 'closed', threadId, deviceId });
  }
};

export const showOpenDevice = async ({ threadId, deviceId }) => {
  const entry = openDevicesForThread(threadId).find((candidate) => candidate.device.id === deviceId);
  if (!entry) return { ok: false, error: 'That device is not open in this thread.' };
  try {
    await showDevice(entry.device);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
};

/** Screenshot for the card; `{ ok, dataUrl, takenAt }`. */
export const screenshotForUser = async ({ threadId, deviceId }) => {
  const entry = openDevicesForThread(threadId).find((candidate) => candidate.device.id === deviceId);
  if (!entry) return { ok: false, error: 'That device is not open in this thread.' };
  try {
    const { png } = await scaleScreenshot(await deps.screenshotDevice(entry.device), CARD_SCREENSHOT_MAX_EDGE);
    return { ok: true, dataUrl: pngDataUrl(png), takenAt: Date.now() };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
};

/**
 * Thread deleted: end its sessions (devices keep running). Opens still in
 * flight for the thread are cancelled and awaited, so none registers or
 * leaves a launcher after this resolves.
 */
export const closeThreadDevices = async (threadId) => {
  const pending = cancelPendingOpens(threadId);
  await Promise.all([
    ...openDevicesForThread(threadId).map((entry) => closeEntry(threadId, entry).catch(() => {})),
    ...pending.map((op) => op.done),
  ]);
};

/**
 * App quit: end every session and stop agent-device's daemon. Devices keep
 * running. In-flight opens are cancelled and awaited; later ones are refused.
 */
export const closeAllDevices = async () => {
  quitting = true;
  const pending = cancelPendingOpens();
  const entries = [...openDevices.entries()].flatMap(([threadId, devices]) =>
    [...devices.values()].map((entry) => ({ threadId, entry }))
  );
  // A cancelled open never runs agent-device, so the daemon can stop while
  // one still waits for a boot.
  const closeSessions = Promise.all(entries.map(({ threadId, entry }) => closeEntry(threadId, entry).catch(() => {}))).then(
    async () => {
      const entryPath = daemonEntry;
      daemonEntry = null;
      if (entryPath) await deps.stopAgentDeviceDaemon(entryPath).catch(() => {});
    }
  );
  await Promise.all([closeSessions, ...pending.map((op) => op.done)]);
};

/** App start: no session survives a restart, so drop every launcher. */
export const pruneDeviceLaunchersOnStart = () => pruneLaunchers(new Set());

/** Test hooks. */
export const resetDeviceRegistryForTests = () => {
  openDevices.clear();
  deviceLocks.clear();
  pendingOpens.clear();
  daemonEntry = null;
  quitting = false;
};
export const setDeviceToolDepsForTests = (overrides) => Object.assign(deps, overrides ?? realDeps);
export const restoreDeviceToolDepsForTests = () => Object.assign(deps, realDeps);
