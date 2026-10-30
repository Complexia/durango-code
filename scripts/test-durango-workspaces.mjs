import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The bundled durango-code CLI and Durango workspaces end to end: the PATH
// launchers, and `ws new` / `ws list` / `ws rm` driven through the main
// process helpers against a throwaway repository. HOME points at a temp dir
// so the CLI's workspace registry and credentials never touch the real ones.

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orion-durango-ws-test-')));
process.env.HOME = path.join(testRoot, 'home');
await fs.mkdir(process.env.HOME);
process.env.ORION_BUNDLED_CLI_DIR = path.join(codeRoot, 'node_modules', 'durango-code');
for (const name of ['DURANGO_CODE_TOKEN', 'ORION_TOKEN', 'DURANGO_CODE_CONFIG_DIR', 'ORION_CONFIG_DIR', 'DURANGO_WS_ROOT']) {
  delete process.env[name];
}

const { app } = await import('electron');
app.setPath('userData', path.join(testRoot, 'userData'));
const cli = await import('../src/main/bundled-cli.js');
const workspaces = await import('../src/main/durango-workspaces.js');

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const run = (file, args, options = {}) =>
  execFileSync(file, args, { encoding: 'utf8', env: childEnv, ...options }).trim();
const git = (cwd, ...args) =>
  run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', cwd, ...args]);

try {
  // --- Launchers ---------------------------------------------------------------
  const binDir = await cli.installBundledCliShims();
  assert.equal(binDir, path.join(testRoot, 'userData', 'bin'));
  for (const alias of cli.CLI_ALIASES) assert.ok(existsSync(path.join(binDir, alias)), `${alias} launcher`);
  assert.equal(run(path.join(binDir, 'durango-code'), ['--version']), cli.bundledCliVersion());
  assert.equal(run(path.join(binDir, 'ds'), ['--version']), cli.bundledCliVersion());
  // Installing again over unchanged launchers is a no-op.
  assert.equal(await cli.installBundledCliShims(), binDir);

  // --- A Durango repository with a project in a subdirectory -------------------
  const repo = path.join(testRoot, 'repo');
  await fs.mkdir(path.join(repo, 'app'), { recursive: true });
  await fs.writeFile(path.join(repo, 'durango.toml'), '[workspace]\nport_block = 10\n');
  await fs.writeFile(path.join(repo, 'app', 'index.js'), 'console.log("hi");\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');

  const plain = path.join(testRoot, 'plain');
  await fs.mkdir(plain);
  git(plain, 'init', '-q');
  assert.equal((await workspaces.inspectDurangoWorkspaceProject(plain)).eligible, false, 'no durango.toml');
  assert.equal((await workspaces.inspectDurangoWorkspaceProject(testRoot)).eligible, false, 'not a repository');

  const inspection = await workspaces.inspectDurangoWorkspaceProject(path.join(repo, 'app'));
  assert.equal(inspection.eligible, true);
  assert.equal(inspection.baseRoot, repo);
  assert.equal(inspection.relativeDir, 'app');

  // --- ws new ------------------------------------------------------------------
  const created = await workspaces.createDurangoWorkspace({ projectPath: path.join(repo, 'app'), name: 'test-ws' });
  assert.equal(created.ok, true, created.error);
  const workspace = created.workspace;
  assert.equal(workspace.name, 'test-ws');
  assert.equal(workspace.repo, repo);
  assert.equal(workspace.workingDir, path.join(workspace.path, 'app'));
  assert.ok(existsSync(path.join(workspace.workingDir, 'index.js')));
  assert.equal(workspace.portBlock, 10);

  // A taken name gets a suffix instead of failing the thread's turn.
  const second = await workspaces.createDurangoWorkspace({ projectPath: repo, name: 'test-ws' });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.workspace.name, 'test-ws-2');
  assert.equal(second.workspace.workingDir, second.workspace.path);

  // A workspace opened as a project is not a base checkout.
  assert.equal((await workspaces.inspectDurangoWorkspaceProject(workspace.path)).reason, 'worktree');

  // Commands the CLI starts must not inherit Electron's run-as-Node switch.
  const childOutput = run(
    path.join(binDir, 'durango-code'),
    ['ws', 'run', 'test-ws', '--repo', repo, '--', 'sh', '-c', 'echo "${ELECTRON_RUN_AS_NODE:-unset} $DURANGO_WS"'],
    { cwd: repo }
  );
  assert.equal(childOutput, 'unset test-ws');

  // --- Status --------------------------------------------------------------------
  const status = await workspaces.durangoWorkspaceStatus({ path: workspace.path, name: workspace.name, repo });
  assert.equal(status.ok, true);
  assert.equal(status.exists, true);
  assert.equal(status.registered, true);
  assert.equal(status.server, null);
  assert.equal(status.change, null);
  assert.equal(status.landing, false);
  assert.deepEqual(workspaces.missingDurangoWorkspaces([workspace.path]), []);

  // --- ws rm ---------------------------------------------------------------------
  await fs.writeFile(path.join(workspace.workingDir, 'new.js'), 'export {};\n');
  const refused = await workspaces.removeDurangoWorkspace({ name: workspace.name, repo });
  assert.equal(refused.ok, false);
  assert.equal(refused.unlanded, true, refused.error);
  assert.ok(existsSync(workspace.path), 'unlanded work is never removed without force');

  const removed = await workspaces.removeDurangoWorkspace({ name: workspace.name, repo, force: true });
  assert.equal(removed.ok, true, removed.error);
  assert.equal(existsSync(workspace.path), false);
  assert.deepEqual(workspaces.missingDurangoWorkspaces([workspace.path]), [workspace.path], 'threads release it');
  assert.deepEqual(await workspaces.removeDurangoWorkspace({ name: workspace.name, repo }), {
    ok: true,
    alreadyRemoved: true,
  });
  assert.equal((await workspaces.removeDurangoWorkspace({ name: 'test-ws-2', repo })).ok, true, 'clean workspace');

  // --- CLI sign-in -----------------------------------------------------------------
  assert.equal(await cli.readCliCredential(), null);
  assert.equal(cli.cliUsesOrigin('https://durango.sh/'), true);
  assert.equal(cli.cliUsesOrigin('https://code.durango.sh/'), true, 'the retired origin is the same backend');
  assert.equal(cli.cliUsesOrigin('http://localhost:3001'), false);
  const devSignIn = await cli.ensureCliSignedIn({ readSession: async () => null, origin: 'http://localhost:3001' });
  assert.equal(devSignIn.signedIn, false, 'a dev build never writes a credential the CLI would not use');
  const signedOut = await cli.ensureCliSignedIn({ readSession: async () => null, origin: 'https://durango.sh' });
  assert.equal(signedOut.needsSignIn, true);
  const credentials = path.join(process.env.HOME, '.config', 'durango-code', 'credentials.json');
  await fs.mkdir(path.dirname(credentials), { recursive: true });
  // As if an older `durango-code login` had run against the retired origin;
  // the value is never sent anywhere.
  await fs.writeFile(credentials, JSON.stringify({ 'https://code.durango.sh': { token: 'fake', user: null } }));
  const existing = await cli.ensureCliSignedIn({
    readSession: async () => {
      throw new Error('an existing CLI sign-in must not mint another token');
    },
    origin: 'https://durango.sh',
  });
  assert.deepEqual([existing.signedIn, existing.created], [true, false]);

  console.log('Durango workspace and bundled CLI tests passed');
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
  app.quit();
}
