import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  configureGlobalGitCredentialHelper,
  gitCredentialHelperCommand,
  installGitCredentialHelper,
} from '../src/main/git-credential-helper.js';

// Drives real git (`git credential fill`) through the installed helper, with
// a stale "keychain" helper in system config like Xcode's osxkeychain.
const exec = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'durango-git-credential-test-'));
const binDir = path.join(root, 'bin with space');
const configDir = path.join(root, 'cli');
const globalConfig = path.join(root, 'gitconfig');
const systemConfig = path.join(root, 'gitconfig-system');
const token = `orion_pat_${'a'.repeat(64)}`;

const baseEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_CONFIG_SYSTEM: systemConfig,
  GIT_TERMINAL_PROMPT: '0',
  DURANGO_CODE_CONFIG_DIR: configDir,
};
for (const name of ['DURANGO_CODE_TOKEN', 'ORION_TOKEN', 'DURANGO_CODE_ORIGIN', 'ORION_ORIGIN', 'ORION_CONFIG_DIR', 'GIT_ASKPASS', 'SSH_ASKPASS']) {
  delete baseEnv[name];
}

const fill = async (url, env = baseEnv) => {
  const { protocol, host } = new URL(url);
  const child = exec('git', ['credential', 'fill'], { env, cwd: root });
  child.child.stdin.end(`protocol=${protocol.slice(0, -1)}\nhost=${host}\n\n`);
  try {
    const { stdout } = await child;
    return Object.fromEntries(stdout.trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2)));
  } catch {
    return null; // git found no credential and could not prompt
  }
};
const globalHelpers = async (host) =>
  (await exec('git', ['config', '--global', '--get-all', `credential.https://${host}.helper`], { env: baseEnv })).stdout
    .split('\n')
    .slice(0, -1);

try {
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'credentials.json'), JSON.stringify({ 'https://durango.sh': { token } }));
  await fs.writeFile(
    systemConfig,
    `[credential]\n\thelper = "!f() { test \\"$1\\" = get && echo username=stale && echo password=stale-keychain; }; f"\n`
  );

  const helperPath = await installGitCredentialHelper({ binDir, env: baseEnv, checkGit: async () => true });
  const command = gitCredentialHelperCommand(helperPath);
  assert.deepEqual(await globalHelpers('git.durango.sh'), ['', command]);
  assert.deepEqual(await globalHelpers('git.orioncode.xyz'), ['', command]);

  assert.deepEqual(await fill('https://git.durango.sh'), {
    protocol: 'https', host: 'git.durango.sh', username: 'orion', password: token,
  });
  assert.equal((await fill('https://git.orioncode.xyz'))?.password, token);
  console.log('ok  git gets the Durango sign-in for Durango Source hosts, ahead of a stale keychain helper');

  assert.equal((await fill('https://example.invalid'))?.password, 'stale-keychain');
  assert.equal((await fill('http://git.durango.sh'))?.password, 'stale-keychain');
  console.log('ok  other hosts and plain http are left to the existing helpers');

  assert.equal(await fill('https://git.durango.sh', { ...baseEnv, DURANGO_CODE_ORIGIN: 'http://127.0.0.1:3001' }), null);
  assert.equal(
    (await fill('https://git.durango.sh', { ...baseEnv, DURANGO_CODE_TOKEN: `orion_pat_${'b'.repeat(64)}` }))?.password,
    `orion_pat_${'b'.repeat(64)}`
  );
  await fs.rm(path.join(configDir, 'credentials.json'));
  assert.equal(await fill('https://git.durango.sh'), null);
  console.log('ok  the helper follows the CLI sign-in: env token, other origins, signed out');

  assert.deepEqual(await configureGlobalGitCredentialHelper({ command, env: baseEnv }), []);
  // Another working Durango helper (say the CLI's) is not taken over.
  const other = gitCredentialHelperCommand(path.join(root, 'durango-code')) + ' git-credential';
  await fs.writeFile(path.join(root, 'durango-code'), '');
  await configureGlobalGitCredentialHelper({ command: other, env: baseEnv });
  assert.deepEqual(await configureGlobalGitCredentialHelper({ command, env: baseEnv }), []);
  assert.deepEqual(await globalHelpers('git.durango.sh'), ['', command]);
  await exec('git', ['config', '--global', '--replace-all', 'credential.https://git.durango.sh.helper', other], { env: baseEnv });
  assert.deepEqual(await configureGlobalGitCredentialHelper({ command, env: baseEnv }), []);
  await fs.rm(path.join(root, 'durango-code'));
  assert.deepEqual(await configureGlobalGitCredentialHelper({ command, env: baseEnv }), ['git.durango.sh']);
  assert.deepEqual(await globalHelpers('git.durango.sh'), ['', command]);
  // A helper the user set up themselves is never replaced.
  await exec('git', ['config', '--global', '--replace-all', 'credential.https://git.durango.sh.helper', 'store'], { env: baseEnv });
  assert.deepEqual(await configureGlobalGitCredentialHelper({ command, env: baseEnv }), []);
  assert.deepEqual(await globalHelpers('git.durango.sh'), ['store']);
  console.log('ok  installs are idempotent; a working Durango helper or the user’s own helper is kept');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
