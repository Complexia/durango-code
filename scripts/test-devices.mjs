// Simulator tools (src/main/devices/*, src/main/device-tools.js): settings and
// consent gating, the agent-device toolchain install, simctl/adb parsing, and
// the per-(thread, device) agent-device launcher. Tool sync between the Claude
// server and the bridge shim lives in test-durango-tools.mjs.
//
//   node scripts/run-electron-test.mjs scripts/test-devices.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

import {
  agentDeviceRefusal,
  getCachedDeviceSettings,
  normalizeDeviceSettings,
  readDeviceSettings,
  setDeviceDataRootForTests,
  writeDeviceSettings,
} from '../src/main/devices/device-settings.js';
import {
  AGENT_DEVICE,
  INSTALL_MARKER,
  ensureToolInstalled,
  findOnWindowsPath,
  installerArgs,
  installerInvocation,
  locateBun,
  locateInstaller,
  locateNpm,
  pinnedToolVersion,
  readToolEntry,
  toolInstallDir,
  toolInstallState,
  toolStatus,
} from '../src/main/devices/device-toolchain.js';
import {
  androidSdkCandidates,
  parseAdbDevices,
  parseAvdList,
  parseSimRuntime,
  parseSimctlDevices,
} from '../src/main/devices/device-platforms.js';
import {
  BOUND_FLAGS,
  DAEMON_FLAGS,
  REFUSED_COMMANDS,
  agentDeviceStateDir,
  buildLauncherArgs,
  launcherCommand,
  launcherConsentRefusal,
  deviceSessionName,
  pruneLaunchers,
  targetsRoot,
  writeAgentDeviceLauncher,
} from '../src/main/devices/agent-device-launcher.js';
import {
  closeAllDevices,
  closeDeviceForUser,
  closeThreadDevices,
  listOpenDevices,
  pickDefaultDevice,
  quickStartText,
  resetDeviceRegistryForTests,
  restoreDeviceToolDepsForTests,
  runDeviceTool,
  setDeviceToolDepsForTests,
} from '../src/main/device-tools.js';
import { resetDeviceShutdownForTests, shutdownDevices } from '../src/main/devices/device-ipc.js';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'durango-devices-'));

try {
  setDeviceDataRootForTests(testRoot);

  // --- Settings and consent ------------------------------------------------------------------
  assert.deepEqual(await readDeviceSettings(), { useDevices: false, agentsCanUseDevices: false }, 'off by default');
  assert.deepEqual(normalizeDeviceSettings({ agentsCanUseDevices: true }), { useDevices: false, agentsCanUseDevices: false });
  assert.match(await agentDeviceRefusal(), /turned off/);
  for (const name of ['device_list', 'device_open', 'device_screenshot', 'device_close']) {
    const result = await runDeviceTool(name, {}, { threadId: 't1' });
    assert.equal(result.ok, false, `${name} refused while off`);
    assert.match(result.text, /turned off/);
  }
  assert.deepEqual(await writeDeviceSettings({ agentsCanUseDevices: true }), {
    useDevices: false,
    agentsCanUseDevices: false,
  }, 'agent access needs useDevices');
  await writeDeviceSettings({ useDevices: true });
  assert.match(await agentDeviceRefusal(), /not allowed agents/);
  assert.match((await runDeviceTool('device_list', {}, { threadId: 't1' })).text, /not allowed agents/);
  assert.deepEqual(await writeDeviceSettings({ agentsCanUseDevices: true }), { useDevices: true, agentsCanUseDevices: true });
  assert.equal(await agentDeviceRefusal(), null);
  assert.deepEqual(await writeDeviceSettings({ useDevices: false }), { useDevices: false, agentsCanUseDevices: false });
  assert.deepEqual(await writeDeviceSettings({ useDevices: true }), { useDevices: true, agentsCanUseDevices: false }, 'turning devices back on does not re-grant agent access');
  assert.deepEqual(getCachedDeviceSettings(), { useDevices: true, agentsCanUseDevices: false });
  // Consent is re-read at call time: an external edit takes effect on the next call.
  await fs.writeFile(path.join(testRoot, 'devices.json'), JSON.stringify({ useDevices: true, agentsCanUseDevices: true }));
  assert.equal(await agentDeviceRefusal(), null);
  await fs.writeFile(path.join(testRoot, 'devices.json'), '{not json');
  assert.match(await agentDeviceRefusal(), /turned off/, 'a corrupt file means off');
  assert.equal((await runDeviceTool('device_bogus', {}, { threadId: 't1' })).ok, false);

  // --- simctl / adb parsing -----------------------------------------------------------------
  assert.deepEqual(parseSimRuntime('com.apple.CoreSimulator.SimRuntime.iOS-26-3'), { os: 'iOS', version: '26.3' });
  assert.deepEqual(parseSimRuntime('com.apple.CoreSimulator.SimRuntime.watchOS-11-0'), { os: 'watchOS', version: '11.0' });
  const simctl = {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
        { udid: 'OLD', name: 'iPhone 16', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16' },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-3': [
        { udid: 'PAD', name: 'iPad Air 11-inch (M3)', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M3' },
        { udid: 'NEW', name: 'iPhone 17', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' },
        { udid: 'GONE', name: 'iPhone X', state: 'Shutdown', isAvailable: false },
        { udid: 'BOOT', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' },
      ],
      'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
        { udid: 'WATCH', name: 'Apple Watch', state: 'Shutdown', isAvailable: true },
      ],
    },
  };
  const sims = parseSimctlDevices(JSON.stringify(simctl));
  assert.deepEqual(sims.map((device) => device.id), ['BOOT', 'NEW', 'PAD', 'OLD'], 'booted, newest runtime, phones before tablets');
  assert.deepEqual(sims[0], { id: 'BOOT', name: 'iPhone 17 Pro', platform: 'ios', version: '26.3', state: 'booted', kind: 'phone' });
  assert.equal(sims.find((device) => device.id === 'PAD').kind, 'tablet');
  assert.deepEqual(parseSimctlDevices('not json'), []);
  assert.deepEqual(parseSimctlDevices({}), []);

  assert.deepEqual(
    parseAdbDevices(
      'List of devices attached\nemulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\nR58M123  unauthorized usb:1-1 transport_id:2\n\n'
    ),
    [
      { serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 arm64', emulator: true },
      { serial: 'R58M123', state: 'unauthorized', model: null, emulator: false },
    ]
  );
  assert.deepEqual(parseAvdList('INFO    | Storing crashdata\nPixel_9_API_35\nMedium_Phone\n'), ['Pixel_9_API_35', 'Medium_Phone']);
  assert.deepEqual(
    androidSdkCandidates({ ANDROID_HOME: '/sdk', ANDROID_SDK_ROOT: '/sdk' }, '/Users/me', 'darwin'),
    ['/sdk', '/Users/me/Library/Android/sdk']
  );
  assert.equal(pickDefaultDevice(sims).id, 'BOOT');
  assert.equal(pickDefaultDevice(sims.filter((device) => device.state !== 'booted')).id, 'NEW');
  assert.equal(pickDefaultDevice(sims, 'android'), null);

  // --- Toolchain: staged install with a fake `bun add` --------------------------------------
  const version = pinnedToolVersion(AGENT_DEVICE);
  assert.match(version, /^0\.21\.\d+$/);
  assert.equal((await toolInstallState(AGENT_DEVICE)).installed, false);
  let adds = 0;
  const fakeBun = { kind: 'bun', path: '/fake/bun' };
  const fakeAdd = async (installer, stagingDir, spec) => {
    adds += 1;
    assert.deepEqual(installer, fakeBun);
    assert.equal(spec, `${AGENT_DEVICE}@${version}`);
    assert.ok(path.basename(stagingDir).startsWith(`.staging-${version}-`), 'installs into a staging dir');
    assert.ok(existsSync(path.join(stagingDir, 'package.json')));
    const packageDir = path.join(stagingDir, 'node_modules', AGENT_DEVICE);
    await fs.mkdir(path.join(packageDir, 'bin'), { recursive: true });
    await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: AGENT_DEVICE, version, bin: { [AGENT_DEVICE]: 'bin/agent-device.mjs' } }));
    await fs.writeFile(path.join(packageDir, 'bin', 'agent-device.mjs'), 'console.log("fake")\n');
  };
  const [first, second] = await Promise.all([
    ensureToolInstalled(AGENT_DEVICE, { installer: fakeBun, runAdd: fakeAdd }),
    ensureToolInstalled(AGENT_DEVICE, { installer: fakeBun, runAdd: fakeAdd }),
  ]);
  assert.equal(adds, 1, 'one install at a time');
  assert.equal(first, second);
  assert.equal(first.installed, true);
  assert.equal(first.entry, path.join(toolInstallDir(AGENT_DEVICE), 'node_modules', AGENT_DEVICE, 'bin', 'agent-device.mjs'));
  assert.ok(existsSync(path.join(toolInstallDir(AGENT_DEVICE), INSTALL_MARKER)));
  assert.deepEqual(
    (await fs.readdir(path.dirname(toolInstallDir(AGENT_DEVICE)))).filter((name) => name.startsWith('.staging')),
    [],
    'staging dir removed'
  );
  await ensureToolInstalled(AGENT_DEVICE, { installer: fakeBun, runAdd: fakeAdd });
  assert.equal(adds, 1, 'installed stays installed');
  // A package without its bin never becomes an install.
  await fs.rm(path.join(testRoot, 'devices', 'tools'), { recursive: true, force: true });
  await assert.rejects(
    ensureToolInstalled(AGENT_DEVICE, { installer: fakeBun, runAdd: async () => {} }),
    /without its command entry/
  );
  assert.equal(existsSync(toolInstallDir(AGENT_DEVICE)), false);
  await assert.rejects(
    ensureToolInstalled(AGENT_DEVICE, { installer: fakeBun, runAdd: async () => { throw new Error('offline'); } }),
    /offline/
  );
  // A bin path escaping the package is not an entry.
  const hostile = path.join(testRoot, 'hostile');
  await fs.mkdir(path.join(hostile, 'node_modules', AGENT_DEVICE), { recursive: true });
  await fs.writeFile(path.join(hostile, 'node_modules', AGENT_DEVICE, 'package.json'), JSON.stringify({ bin: '../../../escape.mjs' }));
  assert.equal(await readToolEntry(hostile, AGENT_DEVICE), null);
  assert.equal(
    await locateBun({ resolve: async () => null, home: path.join(testRoot, 'no-home') }),
    null,
    'no bun anywhere'
  );

  // --- Installer selection: bun when present, else npm (fakes; nothing runs) ---------------
  assert.deepEqual(
    await locateInstaller({ findBun: async () => '/b/bun', findNpm: async () => '/n/npm' }),
    { kind: 'bun', path: '/b/bun' },
    'bun preferred'
  );
  assert.deepEqual(
    await locateInstaller({ findBun: async () => null, findNpm: async () => '/n/npm' }),
    { kind: 'npm', path: '/n/npm' },
    'npm when there is no bun'
  );
  assert.equal(await locateInstaller({ findBun: async () => null, findNpm: async () => null }), null);
  assert.equal(
    await locateInstaller({ findBun: async () => { throw new Error('x'); }, findNpm: async () => '/n/npm' }).then((found) => found.kind),
    'npm',
    'a failing bun lookup falls back to npm'
  );
  const exists = (paths) => (candidate) => paths.includes(candidate);
  assert.equal(
    await locateNpm({ resolve: async () => '/usr/bin/npm', exists: exists(['/usr/bin/npm']), platform: 'darwin' }),
    '/usr/bin/npm',
    'npm on the login shell PATH'
  );
  assert.equal(
    await locateNpm({ resolve: async () => null, home: '/h', exists: exists(['/opt/homebrew/bin/npm']), listDir: () => [], platform: 'darwin' }),
    '/opt/homebrew/bin/npm',
    'Homebrew npm'
  );
  assert.equal(
    await locateNpm({
      resolve: async () => null,
      home: '/h',
      exists: exists(['/h/.nvm/versions/node/v22.12.0/bin/npm', '/h/.nvm/versions/node/v9.0.0/bin/npm']),
      listDir: () => ['v9.0.0', 'v22.12.0', 'v22.2.0', 'system'],
      platform: 'darwin',
    }),
    '/h/.nvm/versions/node/v22.12.0/bin/npm',
    'newest nvm version'
  );
  assert.equal(
    await locateNpm({ resolve: async () => null, home: '/h', exists: () => false, listDir: () => { throw new Error('ENOENT'); }, platform: 'darwin' }),
    null
  );
  // Windows (platform injected): npm.cmd from PATH + PATHEXT, never the POSIX shell lookup.
  const noShell = async () => {
    throw new Error('the POSIX command -v lookup must not run on Windows');
  };
  const winEnv = {
    Path: 'C:\\Windows\\system32;"C:\\Program Files\\nodejs\\";C:\\Users\\me\\AppData\\Roaming\\npm',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ProgramFiles: 'C:\\Program Files',
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
  };
  assert.equal(
    await locateNpm({
      resolve: noShell,
      platform: 'win32',
      env: winEnv,
      // npm (the sh script for Git Bash) and npm.ps1 sit next to npm.cmd; only npm.cmd runs from execFile.
      exists: exists(['C:\\Program Files\\nodejs\\npm', 'C:\\Program Files\\nodejs\\npm.ps1', 'C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Users\\me\\AppData\\Roaming\\npm\\npm.cmd']),
    }),
    'C:\\Program Files\\nodejs\\npm.cmd',
    'Windows: first npm.cmd on PATH (quoted PATH entry, Path key)'
  );
  assert.equal(
    findOnWindowsPath('npm', { env: { PATH: 'D:\\node', PATHEXT: '.EXE;.CMD' }, exists: exists(['D:\\node\\npm.cmd']) }),
    'D:\\node\\npm.cmd'
  );
  assert.equal(findOnWindowsPath('npm', { env: { PATH: 'D:\\node' }, exists: exists(['D:\\node\\npm']) }), null, 'extensionless npm is not runnable');
  assert.equal(
    await locateNpm({ resolve: noShell, platform: 'win32', env: { ...winEnv, Path: '' }, exists: exists(['C:\\Users\\me\\AppData\\Roaming\\npm\\npm.cmd']) }),
    'C:\\Users\\me\\AppData\\Roaming\\npm\\npm.cmd',
    'Windows: %APPDATA%\\npm when PATH has none'
  );
  assert.equal(await locateNpm({ resolve: noShell, platform: 'win32', env: winEnv, exists: () => false }), null);
  assert.equal(
    await locateBun({ resolve: noShell, platform: 'win32', home: 'C:\\Users\\me', env: { Path: 'C:\\tools' }, exists: exists(['C:\\Users\\me\\.bun\\bin\\bun.exe']) }),
    'C:\\Users\\me\\.bun\\bin\\bun.exe',
    'Windows bun fallback'
  );
  // npm.cmd runs through cmd.exe with every part quoted; PATH is extended under the env's own key.
  const winRun = installerInvocation({ kind: 'npm', path: 'C:\\Program Files\\nodejs\\npm.cmd' }, 'C:\\data\\.staging x', 'agent-device@1.2.3', {
    platform: 'win32',
    env: { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' },
  });
  assert.equal(winRun.options.shell, true, 'npm.cmd goes through cmd.exe');
  assert.equal(winRun.file, '"C:\\Program Files\\nodejs\\npm.cmd"');
  assert.ok(winRun.args.every((arg) => arg.startsWith('"') && arg.endsWith('"')), 'every argument quoted');
  assert.ok(winRun.args.includes('"C:\\data\\.staging x"'));
  assert.equal(winRun.options.env.Path, 'C:\\Program Files\\nodejs;C:\\Windows', "installer dir first, on the env's Path key");
  assert.equal(winRun.options.env.PATH, undefined, 'no second PATH key');
  const macRun = installerInvocation({ kind: 'npm', path: '/opt/homebrew/bin/npm' }, '/s', 'agent-device@1.2.3', {
    platform: 'darwin',
    env: { PATH: '/usr/bin' },
  });
  assert.equal(macRun.options.shell, false, 'no shell elsewhere');
  assert.equal(macRun.file, '/opt/homebrew/bin/npm');
  assert.deepEqual(macRun.args, installerArgs('npm', '/s', 'agent-device@1.2.3'));
  assert.equal(macRun.options.env.PATH, '/opt/homebrew/bin:/usr/bin');
  assert.equal(
    installerInvocation({ kind: 'bun', path: 'C:\\Users\\me\\.bun\\bin\\bun.exe' }, 'C:\\s', 'x@1', { platform: 'win32', env: {} }).options.shell,
    false,
    'bun.exe runs directly'
  );
  assert.deepEqual(installerArgs('bun', '/s', 'agent-device@1.2.3'), ['add', '--exact', '--cwd', '/s', 'agent-device@1.2.3']);
  const npmArgs = installerArgs('npm', '/s', 'agent-device@1.2.3');
  assert.deepEqual(npmArgs.slice(0, 3), ['install', '--prefix', '/s'], 'local install into the staging dir');
  for (const flag of ['--no-save', '--exact', '--ignore-scripts']) assert.ok(npmArgs.includes(flag), `npm ${flag}`);
  assert.ok(!npmArgs.some((arg) => arg === '-g' || arg === '--global'), 'never global');
  assert.equal(npmArgs.at(-1), 'agent-device@1.2.3', 'pinned spec');
  // npm goes through the same staging + marker + rename flow.
  await fs.rm(path.join(testRoot, 'devices', 'tools'), { recursive: true, force: true });
  const seenInstallers = [];
  const npmInstall = await ensureToolInstalled(AGENT_DEVICE, {
    findInstaller: async () => ({ kind: 'npm', path: '/fake/npm' }),
    runAdd: async (installer, stagingDir, spec) => {
      seenInstallers.push(installer.kind);
      await fakeAdd(fakeBun, stagingDir, spec);
    },
  });
  assert.deepEqual(seenInstallers, ['npm']);
  assert.equal(npmInstall.installed, true);
  assert.ok(existsSync(path.join(toolInstallDir(AGENT_DEVICE), INSTALL_MARKER)));
  await fs.rm(path.join(testRoot, 'devices', 'tools'), { recursive: true, force: true });
  await assert.rejects(
    ensureToolInstalled(AGENT_DEVICE, { findInstaller: async () => null, runAdd: fakeAdd }),
    /needs npm \(part of Node\.js\) or bun.*nodejs\.org/,
    'asks for Node.js only when neither is found'
  );
  const missing = await toolStatus(AGENT_DEVICE, { findInstaller: async () => null });
  assert.equal(missing.installer, null);
  assert.match(missing.installerMissingHint, /Node\.js/);
  const viaNpm = await toolStatus(AGENT_DEVICE, { findInstaller: async () => ({ kind: 'npm', path: '/n/npm' }) });
  assert.equal(viaNpm.installer, 'npm');
  assert.equal(viaNpm.installerMissingHint, null);

  // --- Launcher: argument binding and refusals ---------------------------------------------
  const sessionA = deviceSessionName('thread-1', 'UDID-1');
  assert.match(sessionA, /^dc-[0-9a-f]{12}$/);
  assert.equal(sessionA, deviceSessionName('thread-1', 'UDID-1'), 'stable');
  assert.notEqual(sessionA, deviceSessionName('thread-2', 'UDID-1'), 'per thread');
  assert.notEqual(sessionA, deviceSessionName('thread-1', 'UDID-2'), 'per device');

  const bound = { name: 'iPhone 17', platform: 'ios', deviceId: 'UDID-1', session: sessionA };
  const boundTail = (target, session) => ['--platform', target.platform, '--udid', target.deviceId, '--session', session];
  assert.deepEqual(buildLauncherArgs(bound, ['snapshot', '-i']).args, [
    'snapshot', '-i', '--platform', 'ios', '--udid', 'UDID-1', '--session', sessionA,
  ]);
  assert.deepEqual(
    buildLauncherArgs({ ...bound, platform: 'android', deviceId: 'emulator-5554' }, ['press', '@e3']).args,
    ['press', '@e3', '--platform', 'android', '--serial', 'emulator-5554', '--session', sessionA]
  );
  for (const args of [[], ['--help'], ['help', 'open'], ['--version']]) {
    assert.deepEqual(buildLauncherArgs(bound, args).args, args, `${args.join(' ')} passes through unbound`);
  }
  assert.deepEqual(buildLauncherArgs(bound, ['cdp', 'targets']).args, ['cdp', 'targets']);
  for (const command of REFUSED_COMMANDS) {
    assert.match(buildLauncherArgs(bound, [command, 'x']).error, /manages agent-device's connection/, `${command} refused`);
  }
  for (const flag of BOUND_FLAGS) {
    assert.match(buildLauncherArgs(bound, ['snapshot', flag, 'x']).error, /bound to iPhone 17/, `${flag} refused`);
  }
  assert.match(buildLauncherArgs(bound, ['snapshot', '--udid=OTHER']).error, /drop --udid/);
  for (const flag of ['--state-dir', '--daemon-base-url', '--config', '--remote-config', '--tenant', '--session-isolation']) {
    assert.ok(DAEMON_FLAGS.includes(flag), `${flag} is a daemon flag`);
  }
  for (const flag of DAEMON_FLAGS) {
    assert.match(buildLauncherArgs(bound, ['snapshot', flag, '/x']).error, /its own daemon and state/, `${flag} refused`);
    assert.match(buildLauncherArgs(bound, ['snapshot', `${flag}=/x`]).error, /its own daemon and state/, `${flag}= refused`);
  }
  // The command is found the way agent-device finds it: flag values are
  // consumed, so a value that reads "help" cannot hide the real command, and
  // refused flags are checked before any informational shortcut.
  assert.equal(launcherCommand(['--run-id', 'help', 'snapshot']), 'snapshot');
  assert.equal(launcherCommand(['--run-id=help', 'snapshot']), 'snapshot');
  assert.equal(launcherCommand(['-d', '3', 'snapshot']), 'snapshot');
  assert.equal(launcherCommand(['--json', 'help', 'snapshot']), 'help', 'boolean flags take no value');
  assert.equal(launcherCommand(['--run-id', '--', 'snapshot']), 'snapshot', '-- is a value after a value flag');
  assert.equal(launcherCommand(['--json', '--', 'daemon', 'stop']), 'daemon', '-- ends the options');
  assert.equal(launcherCommand(['--save-script', './flow.ad', 'open', 'x']), 'open', '--save-script takes a path');
  assert.equal(launcherCommand(['--save-script', 'open', 'x']), 'open', '--save-script leaves a non-path alone');
  assert.equal(launcherCommand(['--json']), null);
  const bypass = ['--run-id', 'help', 'snapshot', '--state-dir', '/outside', '--udid', 'OTHER', '--session', 'other'];
  assert.match(buildLauncherArgs(bound, bypass).error, /its own daemon and state/, 'help as a flag value is not help');
  assert.match(
    buildLauncherArgs(bound, ['--run-id=help', 'snapshot', '--state-dir=/outside', '--udid=OTHER', '--session=other']).error,
    /its own daemon and state/,
    '--x=v form'
  );
  assert.match(buildLauncherArgs(bound, ['--run-id', 'help', 'snapshot', '--udid=OTHER']).error, /drop --udid/);
  assert.deepEqual(buildLauncherArgs(bound, ['--run-id', 'help', 'snapshot']).args, [
    '--run-id', 'help', 'snapshot', '--platform', 'ios', '--udid', 'UDID-1', '--session', sessionA,
  ], 'bound like any command');
  assert.deepEqual(buildLauncherArgs(bound, ['--run-id=help', 'snapshot']).args.slice(-6), boundTail(bound, sessionA));
  for (const args of [['--run-id', 'x', 'daemon', 'stop'], ['--json', '--', 'daemon', 'stop'], ['-d', '2', 'connect'], ['DAEMON', 'stop']]) {
    assert.match(buildLauncherArgs(bound, args).error, /manages agent-device's connection/, `${args.join(' ')} refused`);
  }
  for (const args of [['help', 'snapshot', '--udid', 'OTHER'], ['--help', '--session', 'x'], ['--version', '--state-dir=/x'], ['--run-id', '--', 'snapshot', '--udid', 'X']]) {
    assert.ok(buildLauncherArgs(bound, args).error, `${args.join(' ')} refused despite help/--`);
  }
  assert.match(launcherConsentRefusal(null), /turned off/);
  assert.match(launcherConsentRefusal({ useDevices: true }), /Agents can use devices/);
  assert.match(launcherConsentRefusal({ useDevices: false, agentsCanUseDevices: true }), /turned off/);
  assert.equal(launcherConsentRefusal({ useDevices: true, agentsCanUseDevices: true }), null);

  // The generated launcher, end to end, against a fake agent-device entry.
  const fakeEntry = path.join(testRoot, 'fake-agent-device.mjs');
  await fs.writeFile(
    fakeEntry,
    `const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AGENT_DEVICE_')));
console.log(JSON.stringify({ argv: process.argv.slice(2), env }));\n`
  );
  const device = { id: 'UDID-1', name: 'iPhone 17', platform: 'ios', version: '26.3', state: 'booted' };
  await writeDeviceSettings({ useDevices: true, agentsCanUseDevices: true });
  const launcher = await writeAgentDeviceLauncher({ threadId: 'thread-1', device, entry: fakeEntry });
  assert.equal(launcher.session, sessionA);
  assert.equal(launcher.command, path.join(targetsRoot(), sessionA, process.platform === 'win32' ? 'agent-device.cmd' : 'agent-device'));
  if (process.platform !== 'win32') {
    const run = (args) =>
      spawnSync(launcher.command, args, {
        encoding: 'utf8',
        env: { ...process.env, AGENT_DEVICE_DAEMON_BASE_URL: 'http://evil', AGENT_DEVICE_STATE_DIR: '/elsewhere', ELECTRON_RUN_AS_NODE: '' },
      });
    const ok = run(['snapshot', '-i']);
    assert.equal(ok.status, 0, ok.stderr);
    const seen = JSON.parse(ok.stdout.trim());
    assert.deepEqual(seen.argv, ['snapshot', '-i', '--platform', 'ios', '--udid', 'UDID-1', '--session', sessionA]);
    assert.deepEqual(seen.env, { AGENT_DEVICE_STATE_DIR: agentDeviceStateDir(), AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' }, 'caller AGENT_DEVICE_* dropped, state dir pinned');
    const refused = run(['daemon', 'stop']);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /not available through this launcher/);
    const override = run(['open', 'com.apple.Preferences', '--udid', 'OTHER']);
    assert.equal(override.status, 2);
    assert.match(override.stderr, /call device_open for it/);
    // A daemon.json pointing at a closed port is a stale daemon, not a sandbox.
    await fs.writeFile(path.join(agentDeviceStateDir(), 'daemon.json'), JSON.stringify({ port: 1 }));
    assert.equal(run(['devices']).status, 0, 'stale daemon.json is fine');
    // Flags that would start or reach another daemon are refused.
    for (const args of [['devices', '--state-dir', '/tmp/x'], ['snapshot', '--daemon-base-url=http://127.0.0.1:9']]) {
      const escaped = run(args);
      assert.equal(escaped.status, 2, args.join(' '));
      assert.match(escaped.stderr, /its own daemon and state/);
    }
    // The generated launcher decides exactly like buildLauncherArgs.
    for (const args of [
      ['snapshot', '-i'],
      ['help', 'open'],
      ['--version'],
      [],
      ['cdp', 'targets'],
      ['--run-id', 'help', 'snapshot'],
      ['--run-id=help', 'snapshot'],
      bypass,
      ['--run-id=help', 'snapshot', '--state-dir=/outside', '--udid=OTHER'],
      ['--run-id', 'x', 'daemon', 'stop'],
      ['--json', '--', 'daemon', 'stop'],
      ['--run-id', '--', 'snapshot', '--udid', 'X'],
      ['help', 'snapshot', '--session', 'other'],
      ['--save-script', './flow.ad', 'open', 'x'],
      ['-d', '3', 'snapshot'],
    ]) {
      const expected = buildLauncherArgs(bound, args);
      const result = run(args);
      if (expected.error) {
        assert.equal(result.status, 2, `launcher refuses ${args.join(' ')}`);
        assert.equal(result.stdout, '', `agent-device never ran for ${args.join(' ')}`);
      } else {
        assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
        assert.deepEqual(JSON.parse(result.stdout.trim()).argv, expected.args, `launcher argv for ${args.join(' ')}`);
      }
    }
    // Consent is re-read on every invocation, and fails closed.
    await writeDeviceSettings({ agentsCanUseDevices: false });
    const revoked = run(['snapshot', '-i']);
    assert.equal(revoked.status, 2, 'agent access off stops the launcher');
    assert.match(revoked.stderr, /Agents can use devices/);
    assert.equal(revoked.stdout, '', 'agent-device never ran');
    await writeDeviceSettings({ useDevices: false });
    assert.match(run(['--version']).stderr, /turned off/, 'devices off stops even informational calls');
    await fs.writeFile(path.join(testRoot, 'devices.json'), '{not json');
    assert.equal(run(['snapshot']).status, 2, 'unreadable settings = off');
    await fs.rm(path.join(testRoot, 'devices.json'));
    assert.equal(run(['snapshot']).status, 2, 'missing settings = off');
    await writeDeviceSettings({ useDevices: true, agentsCanUseDevices: true });
    assert.equal(run(['snapshot']).status, 0, 'back on');
  }
  await pruneLaunchers(new Set());
  assert.equal(existsSync(path.join(targetsRoot(), sessionA)), false, 'pruned');

  const quick = quickStartText({ device, command: launcher.command, session: sessionA });
  assert.match(quick, /user is watching/i);
  assert.match(quick, /open <bundle-id/);
  assert.match(quick, /snapshot -i/);
  assert.match(quick, /press @e3/);
  assert.match(quick, /fill @e5 "text"/);
  assert.match(quick, /XCTest runner/);
  assert.ok(quick.includes(launcher.command));

  // --- device_* tools with fake platforms: access mode, races, ownership ------------------
  await writeDeviceSettings({ useDevices: true, agentsCanUseDevices: true });
  const fakeDevices = [
    { id: 'SIM-A', name: 'iPhone A', platform: 'ios', version: '26.3', state: 'booted', kind: 'phone' },
    { id: 'SIM-B', name: 'iPhone B', platform: 'ios', version: '26.3', state: 'shutdown', kind: 'phone' },
  ];
  const calls = [];
  let releaseClose = null;
  setDeviceToolDepsForTests({
    listDevices: async ({ platform } = {}) => ({
      devices: fakeDevices.filter((candidate) => !platform || candidate.platform === platform),
      availability: { ios: { available: true, reason: null }, android: { available: false, reason: 'no SDK' } },
      errors: {},
    }),
    ensureToolInstalled: async () => ({ entry: fakeEntry }),
    bootDevice: async (target) => {
      calls.push(`boot ${target.id}`);
      return target.id;
    },
    shutdownDevice: async (target) => calls.push(`shutdown ${target.id}`),
    screenshotDevice: async () => Buffer.from('png'),
    closeAgentDeviceSession: async (_entry, target) => {
      calls.push(`close ${target.deviceId}`);
      if (releaseClose) await releaseClose.promise;
      return { ok: true };
    },
    stopAgentDeviceDaemon: async () => calls.push('daemon stop'),
  });
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    return { promise, resolve };
  };
  const events = [];
  const sender = { send: (_channel, payload) => events.push(`${payload.type} ${payload.threadId} ${payload.deviceId ?? payload.device?.id}`) };
  const ctx = (threadId, accessMode = 'full-access') => ({ threadId, getSender: () => sender, accessMode });
  try {
    resetDeviceRegistryForTests();

    // Read only: list and screenshot running devices; never open, close, boot or shut down.
    assert.equal((await runDeviceTool('device_list', {}, ctx('ro', 'read-only'))).ok, true);
    for (const [name, args] of [['device_open', {}], ['device_open', { deviceId: 'SIM-B' }], ['device_close', { shutdown: true }]]) {
      const refused = await runDeviceTool(name, args, ctx('ro', 'read-only'));
      assert.equal(refused.ok, false, `${name} refused in Read only`);
      assert.match(refused.text, /Read only/);
    }
    const roShot = await runDeviceTool('device_screenshot', { deviceId: 'SIM-A' }, ctx('ro', 'read-only'));
    assert.equal(roShot.ok, true, 'screenshot of a booted device in Read only');
    assert.equal(roShot.content[0].type, 'image');
    const roStopped = await runDeviceTool('device_screenshot', { deviceId: 'SIM-B' }, ctx('ro', 'read-only'));
    assert.equal(roStopped.ok, false);
    assert.match(roStopped.text, /Read only mode, which cannot boot it/);
    assert.deepEqual(calls, [], 'Read only never booted, closed or shut anything down');
    assert.deepEqual(await fs.readdir(targetsRoot()).catch(() => []), [], 'no launcher written in Read only');

    // Race: a close still ending its session when the same thread reopens the
    // device, plus a second close (thread delete) that captured the same record.
    const opened = await runDeviceTool('device_open', { deviceId: 'SIM-A' }, ctx('t1'));
    assert.equal(opened.ok, true, opened.text);
    const session = deviceSessionName('t1', 'SIM-A');
    const launcherPath = path.join(targetsRoot(), session, 'agent-device');
    assert.ok(existsSync(launcherPath));
    releaseClose = deferred();
    const userClosing = closeDeviceForUser({ threadId: 't1', deviceId: 'SIM-A' });
    const threadClosing = closeThreadDevices('t1'); // same record, queued behind the first close
    for (let i = 0; i < 100 && !calls.includes('close SIM-A'); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(calls.includes('close SIM-A'), 'the first close is ending its session');
    const reopening = runDeviceTool('device_open', { deviceId: 'SIM-A' }, ctx('t1'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.filter((call) => call === 'boot SIM-A').length, 1, 'the reopen waits for the close');
    releaseClose.resolve();
    releaseClose = null;
    const [userClosed, , reopened] = await Promise.all([userClosing, threadClosing, reopening]);
    assert.equal(userClosed.ok, true);
    assert.equal(reopened.ok, true, reopened.text);
    assert.ok(existsSync(launcherPath), "the earlier close did not delete the reopened device's launcher");
    assert.deepEqual(listOpenDevices('t1').map((entry) => entry.device.id), ['SIM-A'], 'reopened device stays registered');
    assert.deepEqual(
      events.filter((event) => event.endsWith(' t1 SIM-A')),
      ['opened t1 SIM-A', 'closed t1 SIM-A', 'opened t1 SIM-A'],
      'no stale closed after the reopen'
    );
    assert.equal(calls.filter((call) => call === 'close SIM-A').length, 1, 'the stale user close did nothing');

    // Ownership across threads: a specific device open elsewhere is named, not handed out.
    const busy = await runDeviceTool('device_open', { deviceId: 'SIM-A' }, ctx('t2'));
    assert.equal(busy.ok, false);
    assert.match(busy.text, /open in another Durango Code thread \(t1\)/);
    assert.match(busy.text, /iPhone B \(id SIM-B\)/, 'suggests a free device');
    assert.match((await runDeviceTool('device_list', {}, ctx('t2'))).text, /iPhone A .*open in another thread \(t1\)/);
    // Without a deviceId, t2 gets an unused device (SIM-B boots) instead of t1's.
    const other = await runDeviceTool('device_open', {}, ctx('t2'));
    assert.equal(other.ok, true, other.text);
    assert.match(other.text, /"deviceId":"SIM-B"/);
    assert.ok(calls.includes('boot SIM-B'));
    // With every device taken, a third thread is told who has them.
    const none = await runDeviceTool('device_open', {}, ctx('t3'));
    assert.equal(none.ok, false);
    assert.match(none.text, /iPhone A: t1, iPhone B: t2/);
    // t1 calling device_open again without arguments gets its own device back.
    assert.match((await runDeviceTool('device_open', {}, ctx('t1'))).text, /"deviceId":"SIM-A"/);
    // Concurrent opens of one free device by two threads: exactly one wins.
    await runDeviceTool('device_close', { deviceId: 'SIM-B' }, ctx('t2'));
    const [x, y] = await Promise.all([
      runDeviceTool('device_open', { deviceId: 'SIM-B' }, ctx('t4')),
      runDeviceTool('device_open', { deviceId: 'SIM-B' }, ctx('t5')),
    ]);
    assert.deepEqual([x.ok, y.ok].sort(), [false, true], 'one owner per device');

    // Quit: closes everything once and stops the daemon; bounded and idempotent.
    calls.length = 0;
    resetDeviceShutdownForTests();
    const firstShutdown = shutdownDevices();
    assert.equal(shutdownDevices(), firstShutdown, 'one shutdown promise');
    await firstShutdown;
    assert.deepEqual(listOpenDevices('t1'), []);
    assert.ok(calls.includes('daemon stop'));
    assert.equal(calls.filter((call) => call.startsWith('close ')).length, 2, 'both open devices closed');
    resetDeviceShutdownForTests();
    const started = Date.now();
    await shutdownDevices({ timeoutMs: 50, closeAll: () => new Promise(() => {}) });
    assert.ok(Date.now() - started < 2000, 'a wedged cleanup cannot hold quit open');
    resetDeviceShutdownForTests();
    await closeAllDevices();
    assert.match((await runDeviceTool('device_open', { deviceId: 'SIM-A' }, ctx('t1'))).text, /not opened.*quitting/, 'no open after quit');

    // --- Stateful fakes: reopen behind a shutdown, cleanup of in-flight opens ---
    resetDeviceRegistryForTests();
    const live = [
      { id: 'SIM-C', name: 'iPhone C', platform: 'ios', version: '26.3', state: 'booted', kind: 'phone' },
      { id: 'SIM-D', name: 'iPhone D', platform: 'ios', version: '26.3', state: 'shutdown', kind: 'phone' },
      { id: 'SIM-E', name: 'iPhone E', platform: 'ios', version: '26.3', state: 'booted', kind: 'phone' },
    ];
    const gates = { boot: null, install: null, close: null };
    const waitFor = async (predicate, what) => {
      for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(predicate(), what);
    };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
    calls.length = 0;
    events.length = 0;
    setDeviceToolDepsForTests({
      listDevices: async () => ({
        devices: live.map((candidate) => ({ ...candidate })),
        availability: { ios: { available: true, reason: null }, android: { available: false, reason: 'no SDK' } },
        errors: {},
      }),
      ensureToolInstalled: async () => {
        calls.push('install');
        if (gates.install) await gates.install.promise;
        return { entry: fakeEntry };
      },
      // Like the real bootDevice: a device listed as booted is not booted again.
      bootDevice: async (target) => {
        calls.push(`boot ${target.id} ${target.state}`);
        if (gates.boot) await gates.boot.promise;
        live.find((candidate) => candidate.id === target.id).state = 'booted';
        return target.id;
      },
      shutdownDevice: async (target) => {
        calls.push(`shutdown ${target.id}`);
        live.find((candidate) => candidate.id === target.id).state = 'shutdown';
      },
      closeAgentDeviceSession: async (_entry, target) => {
        calls.push(`close ${target.deviceId}`);
        if (gates.close) await gates.close.promise;
        return { ok: true };
      },
    });

    // Reopen queued behind Close + Shut down: the open listed SIM-C as booted,
    // but by the time it holds the lock the close shut it down, so it boots it.
    assert.equal((await runDeviceTool('device_open', { deviceId: 'SIM-C' }, ctx('t6'))).ok, true);
    gates.close = deferred();
    const shuttingDown = closeDeviceForUser({ threadId: 't6', deviceId: 'SIM-C', shutdown: true });
    await waitFor(() => calls.includes('close SIM-C'), 'close is ending its session');
    const reopenAfterShutdown = runDeviceTool('device_open', { deviceId: 'SIM-C' }, ctx('t6'));
    await tick();
    gates.close.resolve();
    gates.close = null;
    assert.equal((await shuttingDown).ok, true);
    const reopenedAfterShutdown = await reopenAfterShutdown;
    assert.equal(reopenedAfterShutdown.ok, true, reopenedAfterShutdown.text);
    assert.deepEqual(
      calls.filter((call) => call.startsWith('boot SIM-C') || call === 'shutdown SIM-C'),
      ['boot SIM-C booted', 'shutdown SIM-C', 'boot SIM-C shutdown'],
      'the queued open re-read the state and booted the shut-down simulator'
    );
    assert.equal(live[0].state, 'booted');
    assert.equal(listOpenDevices('t6')[0].device.state, 'booted');
    await closeThreadDevices('t6');

    // Thread delete while an open is still booting: the open is cancelled and
    // awaited; it registers nothing, writes no launcher and emits no event.
    const sessionD = deviceSessionName('t7', 'SIM-D');
    gates.boot = deferred();
    const bootingOpen = runDeviceTool('device_open', { deviceId: 'SIM-D' }, ctx('t7'));
    await waitFor(() => calls.includes('boot SIM-D shutdown'), 'the open is booting');
    let threadCleanupDone = false;
    const threadCleanup = closeThreadDevices('t7').then(() => (threadCleanupDone = true));
    await tick();
    assert.equal(threadCleanupDone, false, 'thread cleanup waits for the in-flight open');
    gates.boot.resolve();
    gates.boot = null;
    await threadCleanup;
    const cancelledOpen = await bootingOpen;
    assert.equal(cancelledOpen.ok, false);
    assert.match(cancelledOpen.text, /not opened: this thread was deleted/);
    assert.deepEqual(listOpenDevices('t7'), [], 'nothing registered after cleanup');
    assert.equal(existsSync(path.join(targetsRoot(), sessionD)), false, 'no launcher after cleanup');
    assert.ok(!events.some((event) => event.startsWith('opened t7')), 'no opened event');
    assert.ok(!calls.includes('shutdown SIM-D'), 'the booted device keeps running, as after a normal close');
    // An open still installing agent-device when the thread goes never boots.
    gates.install = deferred();
    calls.length = 0;
    const installingOpen = runDeviceTool('device_open', { deviceId: 'SIM-E' }, ctx('t7'));
    await waitFor(() => calls.includes('install'), 'the open is installing');
    const installCleanup = closeThreadDevices('t7');
    gates.install.resolve();
    gates.install = null;
    await installCleanup;
    assert.equal((await installingOpen).ok, false);
    assert.ok(!calls.some((call) => call.startsWith('boot')), 'cancelled before booting');
    assert.deepEqual(listOpenDevices('t7'), []);
    // Other threads are unaffected by t7's cleanup.
    assert.equal((await runDeviceTool('device_open', { deviceId: 'SIM-E' }, ctx('t8'))).ok, true);

    // Quit while another thread's open is booting: open sessions close and the
    // daemon stops without waiting for the boot; quit still waits for the open,
    // which registers nothing; later opens are refused.
    live[1].state = 'shutdown';
    calls.length = 0;
    events.length = 0;
    gates.boot = deferred();
    const quitBootingOpen = runDeviceTool('device_open', { deviceId: 'SIM-D' }, ctx('t9'));
    await waitFor(() => calls.includes('boot SIM-D shutdown'), 'the open is booting');
    resetDeviceShutdownForTests();
    let quitDone = false;
    const quit = shutdownDevices().then(() => (quitDone = true));
    await waitFor(() => calls.includes('daemon stop'), 'the daemon stops while the open boots');
    assert.ok(calls.includes('close SIM-E'), "t8's session closed");
    assert.equal(quitDone, false, 'quit waits for the in-flight open');
    gates.boot.resolve();
    gates.boot = null;
    await quit;
    assert.equal((await quitBootingOpen).ok, false);
    assert.deepEqual(listOpenDevices('t9'), [], 'nothing registered after quit');
    assert.equal(existsSync(path.join(targetsRoot(), deviceSessionName('t9', 'SIM-D'))), false, 'no launcher after quit');
    assert.ok(!events.some((event) => event.startsWith('opened t9')));
    assert.equal((await runDeviceTool('device_open', { deviceId: 'SIM-E' }, ctx('t10'))).ok, false, 'opens after quit are refused');
    resetDeviceShutdownForTests();
  } finally {
    restoreDeviceToolDepsForTests();
    resetDeviceRegistryForTests();
  }

  console.log('devices: ok');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
  app.exit(process.exitCode ?? 0);
}
