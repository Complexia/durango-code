import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  commandPathCache,
  findExecutableInPath,
  resolveCommandPath,
  runShellCommand,
  parseCommandPath,
  startShellPathSync,
} from '../src/main/shell-env.js';
import { createFocusCooldown, isSameGitState } from '../src/app/focusCooldown.ts';

// --- 1. Direct PATH resolution in shell-env.js --------------------------------

const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'orion-shell-env-test-'));
try {
  const dirA = path.join(fixtureDir, 'bin-a');
  const dirB = path.join(fixtureDir, 'bin-b');
  const targetDir = path.join(fixtureDir, 'targets');
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
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

  // Absolute paths resolve; relative paths and invalid names return null.
  assert.equal(await findExecutableInPath(realCli, { PATH: '' }, 'linux'), realCli);
  assert.equal(await findExecutableInPath(path.join(dirA, 'mycli'), { PATH: '' }, 'linux'), null);
  assert.equal(await findExecutableInPath('./mycli', { PATH: dirB }, 'linux'), null);
  assert.equal(await findExecutableInPath('', { PATH: dirB }, 'linux'), null);
  assert.equal(await findExecutableInPath('my cli', { PATH: dirB }, 'linux'), null);
  assert.equal(await findExecutableInPath('nonexistent-cli-xyz', { PATH: testPath }, 'linux'), null);

  // Parity with login shell `command -v` after startShellPathSync().
  await startShellPathSync();
  for (const cmd of ['sh', 'git', 'node']) {
    commandPathCache.clear();
    const direct = await resolveCommandPath(cmd);
    const { stdout } = await runShellCommand(`command -v '${cmd}'`, 4000);
    const shellResolved = parseCommandPath(stdout);
    assert.equal(direct, shellResolved, `resolveCommandPath(${cmd}) matches command -v`);
  }
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}

// --- 2. Focus cooldown & git state equality -----------------------------------

let fakeNow = 1000;
const cooldown = createFocusCooldown(5000, () => fakeNow);
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
