import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { linuxRelaunchCommand, relaunchApp } from '../src/main/linux-relaunch.js';
import {
  hasNoNewPrivs,
  installLinuxPackage,
  linuxInstallCommand,
  manualInstallCommand,
  readLinuxPackageType,
} from '../src/main/linux-package-install.js';

const executables = (names) => async (name) => (names.includes(name) ? `/usr/bin/${name}` : null);
const file = '/home/u/.cache/orion-updater/pending/Durango-Code-1.0.187-linux-x64.pacman';

// package-type picks the package manager; anything else stays with electron-updater.
const resources = await mkdtemp(path.join(os.tmpdir(), 'durango-package-type-'));
try {
  assert.equal(await readLinuxPackageType(resources), null, 'no package-type file: AppImage or dev');
  await writeFile(path.join(resources, 'package-type'), 'pacman\n');
  assert.equal(await readLinuxPackageType(resources), 'pacman');
  await writeFile(path.join(resources, 'package-type'), 'rpm\n');
  assert.equal(await readLinuxPackageType(resources), null, 'rpm is not built, so it is not handled');
} finally {
  await rm(resources, { recursive: true });
}

assert.deepEqual(await linuxInstallCommand('pacman', file, executables(['pacman'])), [
  '/usr/bin/pacman',
  '-U',
  '--noconfirm',
  file,
]);
assert.deepEqual(
  await linuxInstallCommand('deb', '/tmp/a.deb', executables(['apt-get', 'dpkg'])),
  ['/usr/bin/apt-get', 'install', '-y', '--allow-downgrades', '/tmp/a.deb'],
  'apt-get installs the dependencies too'
);
assert.deepEqual(await linuxInstallCommand('deb', '/tmp/a.deb', executables(['dpkg'])), [
  '/usr/bin/dpkg',
  '-i',
  '/tmp/a.deb',
]);
assert.equal(await linuxInstallCommand('pacman', file, executables([])), null);
assert.equal(
  manualInstallCommand(['/usr/bin/pacman', '-U', '--noconfirm', '/home/u/My Files/x.pacman']),
  "sudo pacman -U --noconfirm '/home/u/My Files/x.pacman'"
);

// One pkexec call runs the package manager itself: no bash -c, no pacman -Sy retry.
const calls = [];
const recorder =
  (result) =>
  async (program, args) => {
    calls.push([program, ...args]);
    return result;
  };
const ok = await installLinuxPackage({
  type: 'pacman',
  file,
  isRoot: false,
  noNewPrivs: false,
  findExecutable: executables(['pacman', 'pkexec']),
  run: recorder({ code: 0, stderr: '' }),
});
assert.deepEqual(ok, { ok: true });
assert.deepEqual(calls, [['/usr/bin/pkexec', '--disable-internal-agent', '/usr/bin/pacman', '-U', '--noconfirm', file]]);

calls.length = 0;
await installLinuxPackage({
  type: 'pacman',
  file,
  isRoot: true,
  findExecutable: executables(['pacman', 'pkexec']),
  run: recorder({ code: 0, stderr: '' }),
});
assert.deepEqual(calls, [['/usr/bin/pacman', '-U', '--noconfirm', file]], 'root needs no pkexec');

const dismissed = await installLinuxPackage({
  type: 'pacman',
  file,
  isRoot: false,
  findExecutable: executables(['pacman', 'pkexec']),
  run: recorder({ code: 126, stderr: 'Error executing command as another user: Request dismissed' }),
});
assert.deepEqual(dismissed, { ok: false, cancelled: true }, 'a dismissed password dialog is not an error');

const noAgent = await installLinuxPackage({
  type: 'pacman',
  file,
  isRoot: false,
  findExecutable: executables(['pacman', 'pkexec']),
  run: recorder({ code: 127, stderr: 'Error executing command as another user: No authentication agent found.\n' }),
});
assert.equal(noAgent.ok, false);
assert.match(noAgent.error, /no polkit authentication agent is running/);
assert.match(noAgent.error, /sudo pacman -U --noconfirm \/home\/u\/\.cache\/orion-updater\/pending\/Durango-Code-1\.0\.187-linux-x64\.pacman/);

const notAuthorized = await installLinuxPackage({
  type: 'pacman',
  file,
  isRoot: false,
  findExecutable: executables(['pacman', 'pkexec']),
  run: recorder({ code: 127, stderr: 'Error executing command as another user: Not authorized\n\nThis incident has been reported.\n' }),
});
assert.match(notAuthorized.error, /pkexec said: .*Not authorized/, "pkexec's own words are kept");

const conflict = await installLinuxPackage({
  type: 'pacman',
  file,
  isRoot: false,
  findExecutable: executables(['pacman', 'pkexec']),
  run: recorder({ code: 1, stderr: 'error: failed to commit transaction (conflicting files)\nErrors occurred, no packages were upgraded.\n' }),
});
assert.match(conflict.error, /^pacman could not install the update: .*conflicting files/);

const noPkexec = await installLinuxPackage({
  type: 'pacman',
  file,
  isRoot: false,
  findExecutable: executables(['pacman']),
  run: recorder({ code: 0, stderr: '' }),
});
assert.match(noPkexec.error, /pkexec is not installed.*sudo pacman -U/);

assert.match(
  (await installLinuxPackage({ type: 'pacman', file: null, isRoot: false, findExecutable: executables(['pacman', 'pkexec']) })).error,
  /could not be found/
);

// no_new_privs (an app restarted by Electron's app.relaunch()): setuid pkexec
// cannot work in this process, so it runs through systemd-run --user.
assert.equal(await hasNoNewPrivs(async () => 'Name:\tx\nNoNewPrivs:\t1\nSeccomp:\t0\n'), true);
assert.equal(await hasNoNewPrivs(async () => 'Name:\tx\nNoNewPrivs:\t0\nSeccomp:\t0\n'), false);
assert.equal(await hasNoNewPrivs(async () => { throw new Error('ENOENT'); }), false, 'no /proc (macOS)');

calls.length = 0;
const viaSystemdRun = await installLinuxPackage({
  type: 'pacman',
  file,
  isRoot: false,
  noNewPrivs: true,
  findExecutable: executables(['pacman', 'pkexec', 'systemd-run']),
  run: recorder({ code: 0, stderr: '' }),
});
assert.deepEqual(viaSystemdRun, { ok: true });
assert.deepEqual(calls, [
  ['/usr/bin/systemd-run', '--user', '--pipe', '--wait', '--collect', '--quiet', '--', '/usr/bin/pkexec', '--disable-internal-agent', '/usr/bin/pacman', '-U', '--noconfirm', file],
]);
const dismissedViaSystemdRun = await installLinuxPackage({
  type: 'pacman',
  file,
  isRoot: false,
  noNewPrivs: true,
  findExecutable: executables(['pacman', 'pkexec', 'systemd-run']),
  run: recorder({ code: 126, stderr: '' }),
});
assert.deepEqual(dismissedViaSystemdRun, { ok: false, cancelled: true }, "systemd-run --wait passes pkexec's exit code on");
const noSystemdRun = await installLinuxPackage({
  type: 'pacman',
  file,
  isRoot: false,
  noNewPrivs: true,
  findExecutable: executables(['pacman', 'pkexec']),
  run: recorder({ code: 0, stderr: '' }),
});
assert.match(noSystemdRun.error, /no_new_privs.*open it again.*sudo pacman -U/);

// Linux restarts go through a detached shell, not app.relaunch().
const relaunchCalls = [];
const fakeApp = { relaunch: () => relaunchCalls.push('app.relaunch') };
const fakeSpawn = (program, args, options) => {
  relaunchCalls.push([program, args, options.detached, options.stdio]);
  return { on() {}, unref() {} };
};
relaunchApp(fakeApp, { platform: 'darwin', spawnProcess: fakeSpawn });
assert.deepEqual(relaunchCalls, ['app.relaunch']);
relaunchCalls.length = 0;
relaunchApp(fakeApp, {
  platform: 'linux',
  env: {},
  argv: ['/usr/lib/durango-code/durango-code', '--flag'],
  execPath: '/usr/lib/durango-code/durango-code',
  pid: 42,
  spawnProcess: fakeSpawn,
});
assert.equal(relaunchCalls.length, 1);
assert.deepEqual(relaunchCalls[0][1].slice(2), ['durango-code-relaunch', '42', '/usr/lib/durango-code/durango-code', '--flag']);
assert.deepEqual(relaunchCalls[0].slice(2), [true, 'ignore']);
relaunchCalls.length = 0;
relaunchApp(fakeApp, { platform: 'linux', env: { APPIMAGE: '/home/u/Durango.AppImage' }, argv: ['/tmp/.mount_x/durango-code'], execPath: '/tmp/.mount_x/durango-code', pid: 42, spawnProcess: fakeSpawn });
assert.deepEqual(relaunchCalls[0][1].slice(4), ['/home/u/Durango.AppImage'], 'an AppImage restarts from the AppImage file');
relaunchCalls.length = 0;
relaunchApp(fakeApp, { platform: 'linux', env: {}, argv: ['x'], execPath: 'x', pid: 42, spawnProcess: () => { throw new Error('EAGAIN'); } });
assert.deepEqual(relaunchCalls, ['app.relaunch'], 'falls back to app.relaunch() if the shell cannot start');

// The real shell: waits for the old process to exit, then runs the app with its arguments.
const oldProcess = spawn('/bin/sh', ['-c', 'sleep 0.5'], { stdio: 'ignore' });
const oldExited = new Promise((resolve) => oldProcess.on('exit', () => resolve(Date.now())));
const [program, args] = linuxRelaunchCommand({ pid: oldProcess.pid, execPath: '/bin/echo', args: ['restarted', 'with spaces'] });
const { stdout } = await promisify(execFile)(program, args);
const shellDone = Date.now();
assert.equal(stdout, 'restarted with spaces\n');
assert.ok(shellDone >= (await oldExited), 'the new app starts only after the old process exited');

console.log('Linux package install tests passed.');
