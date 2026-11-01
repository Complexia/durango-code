import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { deviceDataRoot, deviceSettingsFile } from './device-settings.js';
import { nodeRuntime } from './device-toolchain.js';

// Per-(thread, device) launchers for the agent-device CLI. device_open writes
// userData/devices/targets/<session>/agent-device, a tiny sh wrapper that runs
// agent-device.mjs next to it on Durango Code's own executable as Node. That
// launcher injects the bound --platform, device selector and --session, so
// the agent never needs target flags and cannot wander onto another device:
//   - its own --platform/--udid/--serial/--device/--session flags are refused;
//   - commands that would replace or reconfigure agent-device's connection
//     (connect, disconnect, auth, daemon, connection, proxy, mcp, plugins,
//     device ownership recovery) are refused;
//   - flags that point agent-device at another state dir, daemon, config
//     file or tenant (DAEMON_FLAGS) are refused, so every call uses the
//     daemon Durango Code manages and stops on Close and quit;
//   - AGENT_DEVICE_STATE_DIR is pinned to userData/devices/agent-device and
//     every other AGENT_DEVICE_* variable from the caller's env is dropped
//     (that includes AGENT_DEVICE_DAEMON_BASE_URL, AGENT_DEVICE_CONFIG and
//     AGENT_DEVICE_HOME);
//   - every invocation re-reads devices.json and refuses unless the user
//     still has "Use devices" and "Agents can use devices" on (fails closed
//     on a missing or unreadable file), so turning either off stops a
//     launcher an agent already holds;
//   - before a command it checks it can reach agent-device's local daemon,
//     and names a network sandbox when that is what blocks localhost.
// The command is found the way agent-device's own parser finds it (flag
// values are consumed, so `--run-id help snapshot` runs snapshot), and the
// refused commands and flags are checked before the informational shortcut
// (help, --help, --version), so nothing reaches agent-device unbound.
// The launcher's logic is the LAUNCHER_SOURCE string below (it runs outside
// the app bundle); its pure argument handling is mirrored by buildLauncherArgs
// so tests can exercise it. Keep the two in step (test-devices.mjs runs both
// on the same argv and compares).
//
// The refused-command idea and the sandbox diagnosis follow T3 Code's
// AgentDeviceShim (MIT, © 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md);
// this implementation is Durango Code's own.

export const REFUSED_COMMANDS = Object.freeze([
  'connect',
  'disconnect',
  'connection',
  'auth',
  'daemon',
  'proxy',
  'mcp',
  'plugins',
  'device',
]);
export const BOUND_FLAGS = Object.freeze(['--platform', '--udid', '--serial', '--device', '--session']);
// Flags that would make agent-device use another state dir, daemon, config
// file, tenant or simulator set (agent-device 0.21.35: explicit flags beat the
// environment), i.e. a daemon or session that Close and quit never clean up.
export const DAEMON_FLAGS = Object.freeze([
  '--state-dir',
  '--daemon-base-url',
  '--daemon-auth-token',
  '--daemon-transport',
  '--daemon-server-mode',
  '--config',
  '--remote-config',
  '--tenant',
  '--session-isolation',
  '--lease-id',
  '--lease-backend',
  '--ios-simulator-device-set',
]);
// agent-device 0.21.35 flags that take a value (`--flag value` or
// `--flag=value`): its string, int and enum flags without a fixed value.
// Regenerate from dist/src/back-mode.js when the pinned version changes; a
// missing entry lets `--flag <command>` hide the real command.
export const VALUE_FLAGS = Object.freeze([
  '--activity', '--android-device-allowlist', '--app', '--appium-version', '--artifact', '--artifacts-dir',
  '--aws-app-arn', '--aws-device-arn', '--aws-interaction-mode', '--aws-project-arn', '--aws-region', '--baseline',
  '--bearer-token', '--bundle-url', '--button', '--config', '--count', '--custom-network', '--daemon-auth-token',
  '--daemon-base-url', '--daemon-server-mode', '--daemon-transport', '--delay-ms', '--depth', '--device',
  '--device-orientation', '--dsym', '--duration-ms', '--env', '--fps', '--from', '--geo-location',
  '--github-actions-artifact', '--header', '--hold-ms', '--host', '--image-tag', '--include', '--interval-ms',
  '--ios-simulator-device-set', '--ios-xctest-derived-data-path', '--ios-xctest-env-dir', '--ios-xctestrun-file',
  '--jitter-px', '--keyframes', '--kind', '--language', '--launch-args', '--launch-console', '--launch-url',
  '--lease-backend', '--lease-id', '--level', '--listen-host', '--locale', '--max-passes', '--max-steps',
  '--metro-host', '--metro-kind', '--metro-port', '--network-profile', '--on-error', '--os', '--os-version', '--out',
  '--pattern', '--pause-ms', '--pick', '--pixels', '--plan-digest', '--platform', '--pointer-count', '--port',
  '--probe-timeout-ms', '--project-root', '--provider', '--provider-app', '--provider-appium-version',
  '--provider-build', '--provider-custom-network', '--provider-device-orientation', '--provider-device-type',
  '--provider-geo-location', '--provider-language', '--provider-locale', '--provider-network-hosts',
  '--provider-network-profile', '--provider-os-version', '--provider-project', '--provider-session',
  '--provider-session-name', '--provider-timezone', '--proxy-base-url', '--public-base-url', '--quality',
  '--record-as', '--remote-config', '--report-junit', '--reporter', '--retention-ms', '--retries', '--run-id',
  '--runtime-file', '--scope', '--search-path', '--serial', '--session', '--session-isolation', '--session-lock',
  '--settle-quiet', '--shard-all', '--shard-split', '--startup-timeout-ms', '--state-dir', '--status-host', '--steps',
  '--steps-file', '--surface', '--target', '--target-app', '--template', '--tenant', '--threshold', '--timeout',
  '--timezone', '--udid', '--until', '--wait', '-b', '-d', '-e', '-s',
]);
// Takes the next argument only when it looks like a path (agent-device's
// booleanOrString flags).
export const OPTIONAL_VALUE_FLAGS = Object.freeze(['--save-script']);
const INFORMATIONAL = new Set(['help', '--help', '-h', '--version', '-V']);

export const targetsRoot = () => path.join(deviceDataRoot(), 'devices', 'targets');
export const agentDeviceStateDir = () => path.join(deviceDataRoot(), 'devices', 'agent-device');

/** Stable agent-device session name for one thread on one device. */
export const deviceSessionName = (threadId, deviceId) =>
  `dc-${crypto.createHash('sha256').update(`${threadId}\0${deviceId}`).digest('hex').slice(0, 12)}`;

export const boundFlagsFor = ({ platform, deviceId, session }) => [
  '--platform',
  platform,
  platform === 'ios' ? '--udid' : '--serial',
  deviceId,
  '--session',
  session,
];

const flagName = (arg) => (arg.startsWith('--') ? arg.split('=')[0] : arg);

/**
 * The command agent-device 0.21.35 would run for `args` (its first
 * positional), or null when there is none. Mirrors agent-device's parser:
 * `--` ends the options, `--flag=value` carries its value, a value flag
 * consumes the next argument unless that is another flag (`--` itself is a
 * value there), and --save-script consumes it only when it looks like a path.
 * Mirrors LAUNCHER_SOURCE.
 */
export const launcherCommand = (args) => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') return args[index + 1] ?? null;
    if (!arg.startsWith('-') || arg === '-') return arg;
    if (arg.startsWith('--') && arg.includes('=')) continue;
    const next = args[index + 1];
    if (next === undefined || (next.startsWith('-') && next !== '-' && next !== '--')) continue;
    if (VALUE_FLAGS.includes(arg)) index += 1;
    else if (OPTIONAL_VALUE_FLAGS.includes(arg) && looksLikePath(next)) index += 1;
  }
  return null;
};

const looksLikePath = (value) => {
  const trimmed = value.trim();
  if (!trimmed || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return false;
  return trimmed.includes('/') || trimmed.includes('\\');
};

/**
 * Refusal when devices.json (parsed, or null when missing/unreadable) no
 * longer lets agents use devices; null when it does. Mirrors LAUNCHER_SOURCE.
 */
export const launcherConsentRefusal = (settings) => {
  if (settings?.useDevices !== true) {
    return 'Simulator tools are turned off in Durango Code (Settings → Devices → Use devices), so this agent-device launcher no longer runs. Ask the user to turn them on if they want you to use a simulator or emulator.';
  }
  if (settings?.agentsCanUseDevices !== true) {
    return 'The user turned off "Agents can use devices" in Durango Code (Settings → Devices), so this agent-device launcher no longer runs. Ask them to turn it on if they want you to drive a simulator or emulator.';
  }
  return null;
};

const daemonFlagRefusal = (flag) =>
  `Durango Code runs agent-device against its own daemon and state, so ${flag} is not available through this launcher; run the command without it.`;

/**
 * The argv the launcher hands agent-device for `args`, or `{ error }` when it
 * refuses. Mirrors LAUNCHER_SOURCE.
 */
export const buildLauncherArgs = (bound, args) => {
  const command = launcherCommand(args);
  // Refusals first, over every argument: no informational shortcut skips them.
  if (command && REFUSED_COMMANDS.includes(command.toLowerCase())) {
    return {
      error: `Durango Code manages agent-device's connection to this device, so \`${command}\` is not available through this launcher.`,
    };
  }
  const daemonFlag = args.find((arg) => DAEMON_FLAGS.includes(flagName(arg)));
  if (daemonFlag) return { error: daemonFlagRefusal(flagName(daemonFlag)) };
  const overridden = args.find((arg) => BOUND_FLAGS.includes(flagName(arg)));
  if (overridden) {
    return {
      error: `This launcher is bound to ${bound.name} (${bound.platform} ${bound.deviceId}); drop ${flagName(overridden)}. To use another device, call device_open for it and use the launcher it returns.`,
    };
  }
  // help/--help/--version reject device flags, and run nothing on a device.
  if (command === 'help' || (command === null && args.every((arg) => INFORMATIONAL.has(arg)))) return { args };
  // cdp talks to Metro, not the device, and refuses device flags.
  if (command === 'cdp') return { args };
  return { args: [...args, ...boundFlagsFor(bound)] };
};

export const LAUNCHER_SOURCE = String.raw`// Durango Code agent-device launcher (generated; do not edit).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';

const BOUND = __BOUND__;
const REFUSED = __REFUSED__;
const BOUND_FLAGS = __BOUND_FLAGS__;
const DAEMON_FLAGS = __DAEMON_FLAGS__;
const VALUE_FLAGS = __VALUE_FLAGS__;
const OPTIONAL_VALUE_FLAGS = __OPTIONAL_VALUE_FLAGS__;
const INFORMATIONAL = new Set(['help', '--help', '-h', '--version', '-V']);
const args = process.argv.slice(2);
const flagName = (arg) => (arg.startsWith('--') ? arg.split('=')[0] : arg);
const looksLikePath = (value) => {
  const trimmed = value.trim();
  if (!trimmed || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return false;
  return trimmed.includes('/') || trimmed.includes('\\');
};
// agent-device's command: its first positional, skipping flag values.
const findCommand = () => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') return args[index + 1] ?? null;
    if (!arg.startsWith('-') || arg === '-') return arg;
    if (arg.startsWith('--') && arg.includes('=')) continue;
    const next = args[index + 1];
    if (next === undefined || (next.startsWith('-') && next !== '-' && next !== '--')) continue;
    if (VALUE_FLAGS.includes(arg)) index += 1;
    else if (OPTIONAL_VALUE_FLAGS.includes(arg) && looksLikePath(next)) index += 1;
  }
  return null;
};
const fail = (message) => {
  console.error(message);
  process.exit(2);
};

// The user's consent, re-read on every invocation; missing or unreadable = off.
let settings = null;
try {
  settings = JSON.parse(readFileSync(BOUND.settingsFile, 'utf8'));
} catch {}
if (settings?.useDevices !== true) {
  fail('Simulator tools are turned off in Durango Code (Settings → Devices → Use devices), so this agent-device launcher no longer runs. Ask the user to turn them on if they want you to use a simulator or emulator.');
}
if (settings?.agentsCanUseDevices !== true) {
  fail('The user turned off "Agents can use devices" in Durango Code (Settings → Devices), so this agent-device launcher no longer runs. Ask them to turn it on if they want you to drive a simulator or emulator.');
}

const command = findCommand();
// Refusals first, over every argument: no informational shortcut skips them.
if (command && REFUSED.includes(command.toLowerCase())) {
  fail('Durango Code manages agent-device\'s connection to this device, so \x60' + command + '\x60 is not available through this launcher.');
}
const daemonFlag = args.find((arg) => DAEMON_FLAGS.includes(flagName(arg)));
if (daemonFlag) {
  fail('Durango Code runs agent-device against its own daemon and state, so ' + flagName(daemonFlag) + ' is not available through this launcher; run the command without it.');
}
const overridden = args.find((arg) => BOUND_FLAGS.includes(flagName(arg)));
if (overridden) {
  fail('This launcher is bound to ' + BOUND.name + ' (' + BOUND.platform + ' ' + BOUND.deviceId + '); drop ' + flagName(overridden) + '. To use another device, call device_open for it and use the launcher it returns.');
}
const informational = command === 'help' || (command === null && args.every((arg) => INFORMATIONAL.has(arg)));
let finalArgs = args;
if (!informational && command !== 'cdp') {
  finalArgs = [...args, '--platform', BOUND.platform, BOUND.platform === 'ios' ? '--udid' : '--serial', BOUND.deviceId, '--session', BOUND.session];
}

const canConnect = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (error) => {
      socket.destroy();
      resolve(error ? error.code || error.message : null);
    };
    socket.setTimeout(2000, () => done(new Error('timeout')));
    socket.once('connect', () => done(null));
    socket.once('error', done);
  });

const loopbackProbe = () =>
  new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', (error) => resolve(error.code || error.message));
    server.listen(0, '127.0.0.1', async () => {
      const failure = await canConnect(server.address().port);
      server.close();
      resolve(failure);
    });
  });

const SANDBOX = (detail) =>
  'This shell cannot reach agent-device\'s local daemon on 127.0.0.1 (' + detail + '): a sandbox is blocking localhost network access. Run this command again with network access / outside the sandbox (for example, request escalated permissions for it).';

if (!informational) {
  let port = null;
  try {
    port = Number(JSON.parse(readFileSync(BOUND.stateDir + '/daemon.json', 'utf8')).port) || null;
  } catch {}
  const failure = port ? await canConnect(port) : 'no daemon';
  // A stale daemon.json (refused) or no daemon yet is fine: agent-device
  // starts one. Only a blocked loopback means a sandbox.
  if (failure && failure !== 'ECONNREFUSED' && failure !== 'no daemon') fail(SANDBOX('connect ' + failure));
  if (failure) {
    const probe = await loopbackProbe();
    if (probe) fail(SANDBOX(probe));
  }
}

const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith('AGENT_DEVICE_') && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
}
env.AGENT_DEVICE_STATE_DIR = BOUND.stateDir;
env.AGENT_DEVICE_NO_UPDATE_NOTIFIER = '1';
env.ELECTRON_RUN_AS_NODE = '1';

const child = spawn(process.execPath, [BOUND.entry, ...finalArgs], { stdio: 'inherit', env });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {}
  });
}
child.on('error', (error) => fail('Could not start agent-device: ' + error.message));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`;

const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

export const launcherSource = (bound) =>
  LAUNCHER_SOURCE.replace('__BOUND__', JSON.stringify(bound))
    .replace('__REFUSED__', JSON.stringify(REFUSED_COMMANDS))
    .replace('__BOUND_FLAGS__', JSON.stringify(BOUND_FLAGS))
    .replace('__DAEMON_FLAGS__', JSON.stringify(DAEMON_FLAGS))
    .replace('__VALUE_FLAGS__', JSON.stringify(VALUE_FLAGS))
    .replace('__OPTIONAL_VALUE_FLAGS__', JSON.stringify(OPTIONAL_VALUE_FLAGS));

/**
 * Writes the launcher for one (thread, device) and returns
 * `{ session, dir, command }`. `entry` is agent-device's installed bin.
 */
export const writeAgentDeviceLauncher = async ({ threadId, device, entry }) => {
  const session = deviceSessionName(threadId, device.id);
  const dir = path.join(targetsRoot(), session);
  const stateDir = agentDeviceStateDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const bound = {
    name: device.name,
    platform: device.platform,
    deviceId: device.id,
    session,
    stateDir,
    settingsFile: deviceSettingsFile(),
    entry,
  };
  const mjs = path.join(dir, 'agent-device.mjs');
  await fs.writeFile(mjs, launcherSource(bound), { mode: 0o600 });
  const { command: executable } = nodeRuntime();
  let command;
  if (process.platform === 'win32') {
    command = path.join(dir, 'agent-device.cmd');
    await fs.writeFile(
      command,
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${executable}" "${mjs}" %*\r\n`
    );
  } else {
    command = path.join(dir, 'agent-device');
    await fs.writeFile(
      command,
      `#!/bin/sh\n# Durango Code: agent-device bound to ${device.name.replace(/\n/g, ' ')} (${device.platform} ${device.id}), session ${session}.\nELECTRON_RUN_AS_NODE=1 exec ${shQuote(executable)} ${shQuote(mjs)} "$@"\n`,
      { mode: 0o700 }
    );
    await fs.chmod(command, 0o700);
  }
  return { session, dir, command };
};

/** Runs agent-device directly (not through a launcher) with Durango's state dir. */
export const runAgentDevice = (entry, args, { timeoutMs = 30_000 } = {}) =>
  new Promise((resolve) => {
    const { command, env: runtimeEnv } = nodeRuntime();
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith('AGENT_DEVICE_')) env[key] = value;
    }
    Object.assign(env, runtimeEnv, {
      AGENT_DEVICE_STATE_DIR: agentDeviceStateDir(),
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
    });
    let output = '';
    let child;
    try {
      child = spawn(command, [entry, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ ok: false, output: error.message });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: error.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.slice(-4000) });
    });
  });

/** Ends the bound agent-device session (quits the app it opened). Best effort. */
export const closeAgentDeviceSession = (entry, bound) =>
  runAgentDevice(entry, ['close', ...boundFlagsFor(bound)], { timeoutMs: 20_000 });

export const stopAgentDeviceDaemon = (entry) => runAgentDevice(entry, ['daemon', 'stop'], { timeoutMs: 10_000 });

export const removeLauncher = (session) =>
  fs.rm(path.join(targetsRoot(), session), { recursive: true, force: true }).catch(() => {});

/** Removes every launcher whose session is not in `keep` (all of them at app start). */
export const pruneLaunchers = async (keep = new Set()) => {
  let entries = [];
  try {
    entries = await fs.readdir(targetsRoot());
  } catch {
    return;
  }
  await Promise.all(entries.filter((name) => !keep.has(name)).map((name) => removeLauncher(name)));
};
