import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  commandPathCache,
  execFileAsync,
  findExecutableInPath,
  resolveCommandPath,
  resyncShellPath,
  parseCommandPath,
  shellPathProbeCommand,
  startShellPathSync,
} from '../src/main/shell-env.js';
import { createFocusCooldown, isSameGitState } from '../src/app/focusCooldown.ts';

// --- 1. Shell PATH probe command (POSIX + fish + other shells) ----------------

assert.match(
  shellPathProbeCommand('/opt/homebrew/bin/fish'),
  /string join : -- \$PATH/,
  'fish uses colon-joined PATH rather than space-separated "$PATH"'
);
assert.match(
  shellPathProbeCommand('/bin/zsh'),
  /"\$PATH"/,
  'zsh reads colon-separated $PATH'
);
assert.match(
  shellPathProbeCommand('/usr/local/bin/elvish'),
  /printenv PATH/,
  'unknown non-POSIX shells use printenv PATH for colon-separated PATH'
);

// --- 2. Direct PATH resolution (POSIX + Windows) ------------------------------

const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'orion-shell-env-test-'));
try {
  const dirA = path.join(fixtureDir, 'bin-a');
  const dirB = path.join(fixtureDir, 'bin-b');
  const dirSpace = path.join(fixtureDir, 'Program Files', 'My CLI');
  const targetDir = path.join(fixtureDir, 'targets');
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  await mkdir(dirSpace, { recursive: true });
  await mkdir(targetDir, { recursive: true });

  // A directory named `mycli` in dirA must be skipped even though directories have +x.
  await mkdir(path.join(dirA, 'mycli'));
  // A non-executable file named `mycli` in a middle dir must be skipped on POSIX.
  const dirNonExec = path.join(fixtureDir, 'bin-nonexec');
  await mkdir(dirNonExec, { recursive: true });
  await writeFile(path.join(dirNonExec, 'mycli'), '#!/bin/sh\n', 'utf8');
  await chmod(path.join(dirNonExec, 'mycli'), 0o644);
  // Real executable in dirB.
  const realCli = path.join(dirB, 'mycli');
  await writeFile(realCli, '#!/bin/sh\n', 'utf8');
  await chmod(realCli, 0o755);

  const testPath = [dirA, dirNonExec, dirB].join(':');
  assert.equal(
    await findExecutableInPath('mycli', { PATH: testPath }, 'linux'),
    realCli,
    'skips directories and non-executable files and resolves first executable in PATH order'
  );

  // Precedence: executable in dirA wins over dirB.
  const firstWinner = path.join(dirA, 'winner');
  const secondWinner = path.join(dirB, 'winner');
  await writeFile(firstWinner, '#!/bin/sh\n', 'utf8');
  await writeFile(secondWinner, '#!/bin/sh\n', 'utf8');
  await chmod(firstWinner, 0o755);
  await chmod(secondWinner, 0o755);
  assert.equal(
    await findExecutableInPath('winner', { PATH: `${dirA}:${dirB}` }, 'linux'),
    firstWinner,
    'respects PATH precedence order'
  );

  // Symlink to executable works.
  const linkedTarget = path.join(targetDir, 'real-tool');
  const linkedCmd = path.join(dirA, 'linked-tool');
  await writeFile(linkedTarget, '#!/bin/sh\n', 'utf8');
  await chmod(linkedTarget, 0o755);
  await symlink(linkedTarget, linkedCmd);
  assert.equal(
    await findExecutableInPath('linked-tool', { PATH: dirA }, 'linux'),
    linkedCmd,
    'resolves symlinks pointing to executable files'
  );

  // Absolute paths (including paths with spaces!) resolve; relative/invalid names return null.
  const spacedCli = path.join(dirSpace, 'my tool');
  await writeFile(spacedCli, '#!/bin/sh\n', 'utf8');
  await chmod(spacedCli, 0o755);
  assert.equal(await findExecutableInPath(realCli, { PATH: '' }, 'linux'), realCli);
  assert.equal(
    await findExecutableInPath(spacedCli, { PATH: '' }, 'linux'),
    spacedCli,
    'absolute paths containing spaces must resolve'
  );
  assert.equal(await findExecutableInPath(path.join(dirA, 'mycli'), { PATH: '' }, 'linux'), null);
  assert.equal(await findExecutableInPath('./mycli', { PATH: dirB }, 'linux'), null);
  assert.equal(await findExecutableInPath('', { PATH: dirB }, 'linux'), null);
  assert.equal(await findExecutableInPath('my cli', { PATH: dirB }, 'linux'), null);
  assert.equal(await findExecutableInPath('nonexistent-cli-xyz', { PATH: testPath }, 'linux'), null);

  // --- Windows PATH resolution (runs unconditionally across all host OSes) ---
  const winFiles = new Set([
    'c:\\users\\alice\\appdata\\roaming\\npm\\claude', // extensionless POSIX shim
    'c:\\users\\alice\\appdata\\roaming\\npm\\claude.cmd',
    'c:\\users\\alice\\appdata\\roaming\\npm\\codex', // extensionless shim in earlier dir
    'c:\\tools\\codex.exe', // real binary in later dir
    'c:\\program files\\nodejs\\npm.cmd',
    'c:\\tools\\both.com',
    'c:\\tools\\both.exe',
  ]);
  const fakeWinExec = async (candidate) => winFiles.has(candidate.toLowerCase());
  const winEnv = {
    Path: '"C:\\Users\\Alice\\AppData\\Roaming\\npm";"C:\\Program Files\\nodejs";C:\\Tools',
    PathExt: '.COM;.EXE;.BAT;.CMD',
  };
  assert.equal(
    await findExecutableInPath('claude', winEnv, 'win32', fakeWinExec),
    'C:\\Users\\Alice\\AppData\\Roaming\\npm\\claude.cmd',
    'Windows skips extensionless npm shims and picks .cmd'
  );
  assert.equal(
    await findExecutableInPath('codex', winEnv, 'win32', fakeWinExec),
    'C:\\Tools\\codex.exe',
    'Windows extensionless shim in earlier PATH dir does not shadow .exe in later dir'
  );
  assert.equal(
    await findExecutableInPath('both', winEnv, 'win32', fakeWinExec),
    'C:\\Tools\\both.com',
    'Windows respects PATHEXT ordering (.COM before .EXE)'
  );
  assert.equal(
    await findExecutableInPath('npm', winEnv, 'win32', fakeWinExec),
    'C:\\Program Files\\nodejs\\npm.cmd',
    'Windows handles quoted PATH entries with spaces and mixed-case Path/PathExt'
  );
  assert.equal(
    await findExecutableInPath('C:\\Program Files\\nodejs\\npm.cmd', winEnv, 'win32', fakeWinExec),
    'C:\\Program Files\\nodejs\\npm.cmd',
    'Windows handles explicit absolute paths with spaces'
  );
  assert.equal(
    await findExecutableInPath('C:\\Program Files\\nodejs\\npm', winEnv, 'win32', fakeWinExec),
    'C:\\Program Files\\nodejs\\npm.cmd',
    'Windows appends PATHEXT to extensionless absolute paths'
  );
  assert.equal(
    await findExecutableInPath('C:\\Users\\Alice\\AppData\\Roaming\\npm\\codex', winEnv, 'win32', fakeWinExec),
    null,
    'Windows does not treat extensionless absolute shims as runnable executables'
  );

  // Parity with `command -v` against the synced process.env.PATH (avoids macOS
  // `/etc/zprofile` path_helper reordering between `-ilc` and `-lc`).
  await startShellPathSync();
  for (const cmd of ['sh', 'git', 'node']) {
    commandPathCache.clear();
    const direct = await resolveCommandPath(cmd);
    const { stdout } = await execFileAsync('/bin/sh', ['-c', `command -v '${cmd}'`], {
      env: process.env,
      timeout: 4000,
    });
    const shellResolved = parseCommandPath(stdout);
    assert.equal(direct, shellResolved, `resolveCommandPath(${cmd}) matches command -v on synced PATH`);
  }

  // resyncShellPath() clears cached entries and prevents stale lookups from sticking.
  commandPathCache.set('resync-sentinel', { path: '/stale/path', expiresAt: Date.now() + 60_000 });
  await resyncShellPath();
  assert.equal(commandPathCache.has('resync-sentinel'), false, 'resyncShellPath clears commandPathCache');
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}

// --- 3. Focus cooldown (leading + trailing throttle) & git state equality -----

let fakeNow = 1000;
const scheduled = [];
const fakeTimers = {
  setTimer: (fn, ms) => {
    const entry = { id: scheduled.length + 1, fn, ms, runAt: fakeNow + ms, cancelled: false };
    scheduled.push(entry);
    return entry;
  },
  clearTimer: (entry) => {
    entry.cancelled = true;
  },
};
const flushTimersTo = (targetNow) => {
  fakeNow = targetNow;
  for (const entry of scheduled) {
    if (!entry.cancelled && entry.runAt <= fakeNow) {
      entry.cancelled = true;
      entry.fn();
    }
  }
};

const cooldown = createFocusCooldown(5000, () => fakeNow, fakeTimers);
assert.equal(cooldown.tryRun(), true, 'first run succeeds');
assert.equal(cooldown.tryRun(), false, 'immediate repeat is suppressed');
fakeNow += 4999;
assert.equal(cooldown.tryRun(), false, 'repeat just before cooldown expiry is suppressed');
fakeNow += 1;
assert.equal(cooldown.tryRun(), true, 'run at cooldown boundary succeeds');
fakeNow += 1000;
cooldown.mark();
fakeNow += 4000;
assert.equal(cooldown.tryRun(), false, 'mark() refreshes cooldown window');
cooldown.reset();
assert.equal(cooldown.tryRun(), true, 'reset() clears cooldown immediately');

// Leading + trailing throttle: quick terminal round-trip within cooldown is
// coalesced into ONE trailing run rather than dropped permanently.
let triggerCount = 0;
let busy = false;
const trailing = createFocusCooldown(5000, () => fakeNow, fakeTimers);
trailing.mark(10_000);
fakeNow = 12_000;
assert.equal(trailing.trigger(() => { triggerCount += 1; }, { isBusy: () => busy }), false);
fakeNow = 12_500;
assert.equal(trailing.trigger(() => { triggerCount += 1; }, { isBusy: () => busy }), false);
assert.equal(triggerCount, 0, 'rapid focus events inside cooldown do not run immediately');
flushTimersTo(15_000);
assert.equal(triggerCount, 1, 'coalesced trailing run fires once when cooldown expires');

// If busy when cooldown expires, trailing run defers until not busy.
busy = true;
fakeNow = 20_000;
assert.equal(trailing.trigger(() => { triggerCount += 1; }, { isBusy: () => busy }), false);
flushTimersTo(20_250);
assert.equal(triggerCount, 1, 'still deferred while busy');
busy = false;
flushTimersTo(20_500);
assert.equal(triggerCount, 2, 'runs once busy clears');

// Paired OS events (e.g. visibilitychange + focus within < 250 ms) do not
// schedule a duplicate trailing refresh when idle.
let dedupeCount = 0;
const paired = createFocusCooldown(5000, () => fakeNow, fakeTimers);
fakeNow = 40_000;
assert.equal(paired.trigger(() => { dedupeCount += 1; }), true, 'leading event fires immediately');
fakeNow = 40_010;
assert.equal(paired.trigger(() => { dedupeCount += 1; }), false, 'paired echo within 250ms is ignored');
flushTimersTo(46_000);
assert.equal(dedupeCount, 1, 'paired echo did not schedule a duplicate trailing refresh');

// A real human return after >= 250 ms (still inside 5s cooldown) DOES schedule a trailing refresh.
fakeNow = 46_000;
assert.equal(paired.trigger(() => { dedupeCount += 1; }), true);
fakeNow = 47_500;
assert.equal(paired.trigger(() => { dedupeCount += 1; }), false);
flushTimersTo(51_000);
assert.equal(dedupeCount, 3, 'return after dedupe window schedules one trailing refresh');

// Explicit mark() cancels any queued trailing retry; cancel() prevents firing.
fakeNow = 21_000;
trailing.trigger(() => { triggerCount += 1; });
trailing.mark(21_500);
flushTimersTo(26_000);
assert.equal(triggerCount, 2, 'explicit mark() cancels stale trailing timer');
fakeNow = 23_000;
assert.equal(trailing.trigger(() => { triggerCount += 1; }), false, 'inside cooldown queues trailing timer');
trailing.cancel();
flushTimersTo(35_000);
assert.equal(triggerCount, 2, 'cancel() prevents queued trailing timer from firing');

const gitA = {
  ok: true,
  isGitRepository: true,
  root: '/repo',
  originUrl: 'https://example.com/repo.git',
  sourceProvider: 'orion',
  githubMirrorUrl: null,
  currentBranch: 'main',
  detachedHead: null,
  branches: [
    { name: 'main', current: true, hasUpstream: true },
    { name: 'feat', current: false, hasUpstream: false },
  ],
  hasUncommittedChanges: false,
  ahead: 0,
  behind: 0,
};
const gitClone = structuredClone(gitA);
assert.equal(isSameGitState(gitA, gitClone), true, 'equal git states compare identical');
assert.equal(isSameGitState(gitA, { ...gitClone, ahead: 1 }), false, 'ahead change detected');
assert.equal(isSameGitState(gitA, { ...gitClone, hasUncommittedChanges: true }), false, 'dirty change detected');
assert.equal(isSameGitState(gitA, { ...gitClone, currentBranch: 'feat' }), false, 'branch change detected');
assert.equal(
  isSameGitState(gitA, { ...gitClone, branches: [{ name: 'main', current: true, hasUpstream: true }] }),
  false,
  'branch list change detected'
);
assert.equal(isSameGitState(null, gitA), false);
assert.equal(isSameGitState(null, null), true);

console.log('Shell env and focus cooldown tests passed.');
