// The deploy watcher (src/main/durango-deploy-watcher.js): durango.toml
// parsing, project inspection against real git repositories, the runner pid
// check, the Durango Source fetcher against a fake server on localhost, and
// the watch loop with injected client / runner / clock.
//
//   node --no-warnings scripts/test-durango-deploy-watcher.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  createDeployWatcher,
  createSourceConfigFetcher,
  createSourceDeploysFetcher,
  deployRunnerAlive,
  deployTargetsFromToml,
  inspectDeployProject,
  normalizeDeployWatcherSettings,
  pendingDeployWork,
  startBundledDeployRunner,
} from '../src/main/durango-deploy-watcher.js';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const testRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'durango-deploy-watcher-')));

let failures = 0;
const liveWatchers = new Set();
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  } finally {
    for (const watcher of liveWatchers) watcher.stop();
    await Promise.all([...liveWatchers].map((watcher) => watcher.idle()));
    liveWatchers.clear();
  }
};

const waitFor = async (predicate, what, timeoutMs = 3_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

const SAMPLE_TOML = `
# durango.toml
[visibility]
default = "private"

[[visibility.public]]
prefix = "code"

[target.convex-prod]
roots  = ["chat/convex"]
deploy = "cd chat && bun run convex:deploy"     # must precede the app

[target.desktop]
roots = ["code"]
# deploy = "cd code && bun run deploy"

[target."quoted name"] # a comment
deploy = 'railway up x'

[target.empty]
deploy = ""

[target.multi]
deploy = """
railway up y
"""

[secret.TOKEN]
deploy = "not a target"
`;

// --- Pure helpers --------------------------------------------------------------------

await test('deployTargetsFromToml keeps targets with a deploy command', () => {
  assert.deepEqual([...deployTargetsFromToml(SAMPLE_TOML)].sort(), ['convex-prod', 'multi', 'quoted name']);
  assert.equal(deployTargetsFromToml('').size, 0);
  assert.equal(deployTargetsFromToml(null).size, 0);
});

await test("deployTargetsFromToml reads this monorepo's durango.toml", async () => {
  const text = await fs.readFile(path.join(here, '..', '..', 'durango.toml'), 'utf8').catch(() => null);
  if (text === null) return; // the public projection has no monorepo durango.toml
  const targets = deployTargetsFromToml(text);
  assert.ok(targets.has('andromedus') && targets.has('convex-prod') && targets.has('git-worker'));
  for (const manual of ['durango-code-desktop', 'orion-cli', 'durango-cli', 'durango-ios']) {
    assert.ok(!targets.has(manual), `${manual} deploys manually`);
  }
});

await test('normalizeDeployWatcherSettings is off unless enabled is exactly true', () => {
  assert.deepEqual(normalizeDeployWatcherSettings(undefined), { enabled: false });
  assert.deepEqual(normalizeDeployWatcherSettings({ enabled: 'yes' }), { enabled: false });
  assert.deepEqual(normalizeDeployWatcherSettings({ enabled: true }), { enabled: true });
});

await test('pendingDeployWork: pending deployable targets, blocked while any deploy holds one', () => {
  const deployable = new Set(['a', 'b', 'c']);
  const idle = pendingDeployWork(
    [
      { target: 'b', pending: true, running: false, wantedAt: '2026-11-06T10:00:00.000Z' },
      { target: 'a', pending: true, running: false, wantedAt: '2026-11-06T09:00:00.000Z' },
      { target: 'manual', pending: true, running: false, wantedAt: 'x' },
      { target: 'c', pending: false, running: false },
    ],
    deployable
  );
  assert.deepEqual(idle.pending, ['a', 'b']);
  assert.equal(idle.deploy, true);
  assert.equal(idle.signature, 'a@2026-11-06T09:00:00.000Z,b@2026-11-06T10:00:00.000Z');
  const held = pendingDeployWork(
    [
      { target: 'a', pending: true, running: true },
      { target: 'b', pending: true, running: false },
    ],
    deployable
  );
  assert.equal(held.deploy, false, 'a runner holds a; it deploys b after');
  assert.deepEqual(held.running, ['a']);
  assert.equal(pendingDeployWork([{ target: 'c', pending: false }], deployable).deploy, false);
  assert.equal(pendingDeployWork(null, deployable).deploy, false);
});

// --- Local checkout ------------------------------------------------------------------

const git = (cwd, ...args) => execFileAsync('git', ['-C', cwd, ...args]).then(({ stdout }) => stdout.trim());
const makeRepo = async (name, { toml = SAMPLE_TOML, repoId = 'repo_abc123' } = {}) => {
  const dir = path.join(testRoot, name);
  await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'Test');
  if (toml !== null) await fs.writeFile(path.join(dir, 'durango.toml'), toml);
  await fs.writeFile(path.join(dir, 'sub', 'file.txt'), 'x');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'init');
  if (repoId) await git(dir, 'config', '--local', 'orion.cloudrepoid', repoId);
  return dir;
};

await test('inspectDeployProject finds the repo id, base checkout and deploy targets', async () => {
  const repo = await makeRepo('linked');
  const info = await inspectDeployProject(path.join(repo, 'sub'));
  assert.equal(info.repoId, 'repo_abc123');
  assert.equal(info.checkout, repo);
  assert.deepEqual([...info.deployTargets].sort(), ['convex-prod', 'multi', 'quoted name']);
  // A workspace (worktree) deploys from the base checkout.
  const worktree = path.join(testRoot, 'linked-ws');
  await git(repo, 'worktree', 'add', '-q', '--detach', worktree);
  const fromWorktree = await inspectDeployProject(worktree);
  assert.equal(fromWorktree.checkout, repo);
  assert.equal(fromWorktree.repoId, 'repo_abc123');
});

await test('inspectDeployProject skips projects it cannot deploy', async () => {
  assert.equal(await inspectDeployProject(await makeRepo('unlinked', { repoId: null })), null, 'no Durango Source link');
  assert.equal(await inspectDeployProject(await makeRepo('no-config', { toml: null })), null, 'no durango.toml');
  assert.equal(
    await inspectDeployProject(await makeRepo('manual-only', { toml: '[target.app]\nroots = ["."]\n# deploy = "x"\n' })),
    null,
    'no deploy commands'
  );
  const plain = path.join(testRoot, 'not-git');
  await fs.mkdir(plain, { recursive: true });
  assert.equal(await inspectDeployProject(plain), null, 'not a git repository');
  assert.equal(await inspectDeployProject(path.join(testRoot, 'missing')), null, 'missing directory');
  assert.equal(await inspectDeployProject(''), null);
});

await test('deployRunnerAlive reads the CLI pid file and checks the process', async () => {
  const home = path.join(testRoot, 'home');
  await fs.mkdir(path.join(home, '.durango', 'deploys'), { recursive: true });
  assert.equal(await deployRunnerAlive('repo_1', { home }), false, 'no pid file');
  await fs.writeFile(path.join(home, '.durango', 'deploys', 'repo_1.pid'), JSON.stringify({ pid: process.pid }));
  const runner = async () => '/Applications/Durango Code.app/x index.js deploys run --project repo_1 --path /r';
  assert.equal(await deployRunnerAlive('repo_1', { home, commandOf: runner }), true);
  assert.equal(await deployRunnerAlive('repo_1', { home, commandOf: async () => 'vim notes.txt' }), false, 'pid reused');
  assert.equal(await deployRunnerAlive('repo_1', { home, commandOf: runner, isAlive: () => false }), false, 'runner gone');
  await fs.writeFile(path.join(home, '.durango', 'deploys', 'repo_2.pid'), 'garbage');
  assert.equal(await deployRunnerAlive('repo_2', { home, commandOf: runner }), false, 'unreadable pid file');
  assert.equal(await deployRunnerAlive('../etc', { home, commandOf: runner }), false, 'repo id is a file name');
});

// --- Durango Source fetcher ------------------------------------------------------------

await test('createSourceDeploysFetcher sends the desktop session and reports HTTP failures', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    const status = req.url.includes('missing') ? 404 : req.url.includes('expired') ? 401 : 200;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        status === 200
          ? { targets: [{ target: 'app', pending: true, running: false }], deployments: [] }
          : { error: status === 404 ? 'Repository not found.' : 'Invalid token.', code: status === 404 ? 'repo_not_found' : 'unauthorized' }
      )
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const session = { value: { token: 'desktop-session' } };
    const fetchDeploys = createSourceDeploysFetcher({ readSession: async () => session.value, baseUrl: () => base });
    const result = await fetchDeploys('repo_1');
    assert.deepEqual(result.targets, [{ target: 'app', pending: true, running: false }]);
    assert.deepEqual(requests[0], { url: '/api/repos/repo_1/deploys', auth: 'Bearer desktop-session' });
    await assert.rejects(fetchDeploys('missing'), (error) => error.status === 404 && error.code === 'repo_not_found');
    await assert.rejects(fetchDeploys('expired'), (error) => error.status === 401);
    session.value = null;
    await assert.rejects(fetchDeploys('repo_1'), (error) => error.status === 401 && error.code === 'not_signed_in');
    assert.equal(requests.length, 3, 'no request without a session');
    const unreachable = createSourceDeploysFetcher({ readSession: async () => ({ token: 't' }), baseUrl: () => 'http://127.0.0.1:9' });
    await assert.rejects(unreachable('repo_1'), (error) => error.status === null && /Could not reach/.test(error.message));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- The watcher -----------------------------------------------------------------------

const REPO = { repoId: 'repo_1', checkout: '/src/app', deployTargets: new Set(['api', 'web']) };
const pending = (target, wantedAt = '2026-11-06T10:00:00.000Z', extra = {}) => ({ target, pending: true, running: false, wantedAt, ...extra });

/** A watcher with fakes; `server.targets` is what Durango Source answers for each repo. */
const harness = (overrides = {}) => {
  const calls = { fetches: [], configs: [], starts: [], notifications: [], sleeps: [], inspections: [], states: [] };
  const clock = { value: 1_000_000 };
  const world = {
    signedIn: true,
    online: true,
    runnerAlive: false,
    /** The started runner takes the repository's lock (a real one does within milliseconds). */
    runnerTakesLock: false,
    targets: { repo_1: [] },
    fetchError: null,
    /** Targets with a deploy command in durango.toml at main, per Durango Source. */
    config: new Set(['api', 'web']),
    configError: null,
    startResult: { ok: true, pid: 4242, log: '/logs/run-repo_1.log', started: true },
    projects: { '/src/app': REPO, '/src/app/sub': REPO },
  };
  const watcher = createDeployWatcher({
    fetchDeploys: async (repoId) => {
      calls.fetches.push(repoId);
      if (world.fetchError) throw world.fetchError;
      return { targets: world.targets[repoId] ?? [] };
    },
    fetchConfig: async (repoId) => {
      calls.configs.push(repoId);
      if (world.configError) throw world.configError;
      return { oid: 'tip', deployTargets: world.config };
    },
    inspectProject: async (projectPath) => {
      calls.inspections.push(projectPath);
      return world.projects[projectPath] ?? null;
    },
    isRunnerAlive: async () => world.runnerAlive,
    startRunner: async ({ repoId, checkout, targets, signal, stillWanted }) => {
      calls.starts.push({ repoId, checkout, targets });
      assert.ok(signal instanceof AbortSignal && typeof stillWanted === 'function');
      if (world.beforeStart) await world.beforeStart({ signal, stillWanted });
      if (signal.aborted || !stillWanted()) return { ok: false, cancelled: true };
      if (world.runnerTakesLock && world.startResult.ok) world.runnerAlive = true;
      return world.startResult;
    },
    isSignedIn: async () => world.signedIn,
    isOnline: () => world.online,
    notify: (payload) => calls.notifications.push(payload),
    onStateChange: (state) => calls.states.push(state),
    // Fast, abortable sleeps; delays are recorded for the backoff check.
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        calls.sleeps.push(ms);
        if (signal?.aborted) return resolve();
        const timer = setTimeout(resolve, 1);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      }),
    random: () => 0.5,
    now: () => clock.value,
    intervalMs: 45_000,
    log: () => {},
    ...overrides,
  });
  liveWatchers.add(watcher);
  const projects = [
    { id: 'p1', name: 'app', path: '/src/app' },
    { id: 'p2', name: 'app sub', path: '/src/app/sub' },
    { id: 'p3', name: 'notes', path: '/src/notes' },
  ];
  const enable = (enabled = true) => watcher.configure({ settings: { enabled }, projects });
  return { watcher, calls, world, clock, enable, projects };
};

await test('off by default: no requests, no inspection, even when signed in', async () => {
  const { watcher, calls, enable } = harness();
  watcher.accountChanged(true);
  watcher.configure({ settings: undefined, projects: [{ id: 'p1', name: 'app', path: '/src/app' }] });
  enable(false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.fetches.length, 0);
  assert.equal(calls.inspections.length, 0);
  assert.equal(watcher.getState().status, 'off');
});

await test('signed out: nothing runs until sign-in', async () => {
  const { watcher, calls, world, enable } = harness();
  world.signedIn = false;
  enable();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.fetches.length, 0);
  assert.equal(watcher.getState().status, 'signed_out');
  world.signedIn = true;
  watcher.accountChanged(true);
  await waitFor(() => calls.fetches.length >= 1, 'first check after sign-in');
});

await test('one GET per repository per interval; nothing pending starts nothing', async () => {
  const { watcher, calls, enable } = harness();
  watcher.accountChanged(true);
  enable();
  await waitFor(() => calls.fetches.length >= 3, 'three checks');
  watcher.stop();
  await watcher.idle();
  // Two projects share repo_1; /src/notes is not deployable: one GET per interval.
  const intervals = calls.sleeps.filter((ms) => ms === 45_000).length;
  assert.ok(calls.fetches.length <= intervals + 1, `${calls.fetches.length} fetches for ${intervals} intervals`);
  assert.ok(calls.fetches.every((repoId) => repoId === 'repo_1'));
  assert.equal(calls.inspections.length, 3, 'projects inspected once, not every interval');
  assert.equal(calls.starts.length, 0);
  assert.equal(calls.configs.length, 0, 'no config request while nothing is pending');
  assert.equal(watcher.getState().repos[0].state, 'idle');
});

await test('a pending target starts the runner once, in the base checkout, and notifies', async () => {
  const { watcher, calls, world, enable } = harness();
  world.targets.repo_1 = [pending('web'), pending('api'), pending('manual'), { target: 'old', pending: false, running: false }];
  world.runnerTakesLock = true;
  watcher.accountChanged(true);
  enable();
  await waitFor(() => calls.starts.length === 1, 'runner start');
  assert.deepEqual(calls.starts[0], { repoId: 'repo_1', checkout: '/src/app', targets: ['api', 'web'] });
  assert.equal(calls.notifications.length, 1);
  assert.deepEqual(calls.notifications[0].targets, ['api', 'web']);
  assert.equal(calls.notifications[0].log, '/logs/run-repo_1.log');
  await waitFor(() => calls.states.some((state) => state.repos[0]?.state === 'started'), 'started state');
  const repo = calls.states.find((state) => state.repos[0]?.state === 'started').repos[0];
  assert.equal(repo.pid, 4242);
  assert.equal(repo.log, '/logs/run-repo_1.log');
  // The runner is going: later checks leave it alone.
  const seen = calls.fetches.length;
  await waitFor(() => calls.fetches.length >= seen + 3, 'more checks');
  assert.equal(calls.starts.length, 1, 'no second runner while one runs');
  assert.equal(watcher.getState().repos[0].state, 'deploying');
});

await test('a deploy holding any target (this Mac or another) means no new runner', async () => {
  const { watcher, calls, world, enable } = harness();
  world.targets.repo_1 = [pending('api', undefined, { running: true }), pending('web')];
  watcher.accountChanged(true);
  enable();
  await waitFor(() => calls.fetches.length >= 3, 'checks');
  assert.equal(calls.starts.length, 0);
  assert.equal(watcher.getState().repos[0].state, 'deploying');
  // The holder finished api and died before web: its claim ran out.
  world.targets.repo_1 = [{ target: 'api', pending: false, running: false }, pending('web')];
  await waitFor(() => calls.starts.length === 1, 'runner for what is left');
  assert.deepEqual(calls.starts[0].targets, ['web']);
});

await test('pending targets this checkout does not deploy are ignored', async () => {
  const { watcher, calls, world, enable } = harness();
  world.targets.repo_1 = [pending('desktop-release')];
  watcher.accountChanged(true);
  enable();
  await waitFor(() => calls.fetches.length >= 3, 'checks');
  assert.equal(calls.starts.length, 0);
});

await test('the same work is not restarted in a loop; new landings are', async () => {
  const { watcher, calls, world, clock, enable } = harness();
  world.targets.repo_1 = [pending('api', '2026-11-06T10:00:00.000Z')];
  watcher.accountChanged(true);
  enable();
  await waitFor(() => calls.starts.length === 1, 'first start');
  // The runner exited (world.runnerAlive stays false) with api still pending.
  let seen = calls.fetches.length;
  await waitFor(() => calls.fetches.length >= seen + 3, 'checks');
  assert.equal(calls.starts.length, 1, 'no restart for the same work right away');
  assert.equal(watcher.getState().repos[0].state, 'stalled');
  // Much later it tries again, quietly.
  clock.value += 31 * 60_000;
  await waitFor(() => calls.starts.length === 2, 'retry after the cooldown');
  assert.equal(calls.notifications.length, 1, 'retries do not notify again');
  // A new landing wants api again: start at once.
  world.targets.repo_1 = [pending('api', '2026-11-06T11:00:00.000Z')];
  await waitFor(() => calls.starts.length === 3, 'start for the new landing');
  assert.equal(calls.notifications.length, 2);
  seen = calls.fetches.length;
  await waitFor(() => calls.fetches.length >= seen + 2, 'checks');
  assert.equal(calls.starts.length, 3);
});

await test('a runner that fails to start is reported, not retried in a loop', async () => {
  const { watcher, calls, world, enable } = harness();
  world.targets.repo_1 = [pending('api')];
  world.startResult = { ok: false, error: 'The durango-code CLI is not signed in.' };
  watcher.accountChanged(true);
  enable();
  await waitFor(() => calls.starts.length === 1, 'start attempt');
  await waitFor(() => watcher.getState().repos[0]?.state === 'error', 'error state');
  assert.equal(watcher.getState().repos[0].error, 'The durango-code CLI is not signed in.');
  const seen = calls.fetches.length;
  await waitFor(() => calls.fetches.length >= seen + 3, 'checks');
  assert.equal(calls.starts.length, 1);
  assert.equal(calls.notifications.length, 0);
});

await test('errors back off and recover; 401 stops until the account changes', async () => {
  const { watcher, calls, world, enable } = harness();
  world.fetchError = Object.assign(new Error('Durango Source answered 502.'), { status: 502 });
  watcher.accountChanged(true);
  enable();
  await waitFor(() => calls.fetches.length >= 3, 'retries');
  const backoffs = calls.sleeps.filter((ms) => ms > 45_000);
  assert.deepEqual(calls.sleeps.slice(0, 3), [45_000, 90_000, 180_000], 'doubles from the interval');
  assert.ok(backoffs.every((ms) => ms <= 10 * 60_000), 'capped');
  assert.equal(watcher.getState().status, 'error');
  assert.match(watcher.getState().lastError, /502/);
  world.fetchError = null;
  await waitFor(() => watcher.getState().status === 'watching', 'recovered');
  world.fetchError = Object.assign(new Error('Invalid token.'), { status: 401 });
  await waitFor(() => watcher.getState().status === 'signed_out', 'signed out');
  await watcher.idle();
  const seen = calls.fetches.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.fetches.length, seen, 'stopped');
  world.fetchError = null;
  watcher.accountChanged(true);
  await waitFor(() => calls.fetches.length > seen, 'restarted on sign-in');
});

await test('a repository Durango Source refuses is skipped', async () => {
  const { watcher, calls, world, enable } = harness();
  world.fetchError = Object.assign(new Error('Repository not found.'), { status: 404 });
  watcher.accountChanged(true);
  enable();
  await waitFor(() => calls.fetches.length >= 1, 'first check');
  await waitFor(() => calls.sleeps.length >= 4, 'more intervals');
  assert.equal(calls.fetches.length, 1, 'not asked again');
  assert.equal(watcher.getState().repos[0].state, 'unavailable');
  assert.equal(watcher.getState().status, 'watching');
});

await test('offline, sleep and sign-out pause checking', async () => {
  const { watcher, calls, world, enable } = harness();
  world.online = false;
  watcher.accountChanged(true);
  enable();
  await waitFor(() => watcher.getState().status === 'offline', 'offline');
  assert.equal(calls.fetches.length, 0);
  world.online = true;
  await waitFor(() => calls.fetches.length >= 1, 'back online');
  watcher.suspend();
  await watcher.idle();
  assert.equal(watcher.getState().status, 'paused');
  let seen = calls.fetches.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.fetches.length, seen);
  watcher.resume();
  await waitFor(() => calls.fetches.length > seen, 'resumed');
  watcher.accountChanged(false);
  await watcher.idle();
  assert.equal(watcher.getState().status, 'signed_out');
  seen = calls.fetches.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.fetches.length, seen, 'stopped on sign-out');
});

await test('project changes are re-inspected; removed repositories drop out', async () => {
  const { watcher, calls, world, enable, projects } = harness();
  watcher.accountChanged(true);
  enable();
  await waitFor(() => watcher.getState().repos.length === 1, 'repo found');
  world.projects['/src/other'] = { repoId: 'repo_2', checkout: '/src/other', deployTargets: new Set(['svc']) };
  watcher.configure({ settings: { enabled: true }, projects: [...projects, { id: 'p4', name: 'other', path: '/src/other' }] });
  await waitFor(() => calls.fetches.includes('repo_2'), 'new repo checked');
  watcher.configure({ settings: { enabled: true }, projects: [{ id: 'p4', name: 'other', path: '/src/other' }] });
  await waitFor(() => watcher.getState().repos.length === 1 && watcher.getState().repos[0].repoId === 'repo_2', 'repo_1 dropped');
});

await test('stop() ends the loop (quit); turning it off stops checking', async () => {
  const { watcher, calls, enable } = harness();
  watcher.accountChanged(true);
  enable();
  await waitFor(() => calls.fetches.length >= 1, 'first check');
  enable(false);
  await watcher.idle();
  assert.equal(watcher.getState().status, 'off');
  const seen = calls.fetches.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.fetches.length, seen);
});

await test("deployability comes from Source's durango.toml at main, asked once per pending work", async () => {
  const { watcher, calls, world, clock, enable } = harness();
  // `worker` was added on main; this checkout's durango.toml only knows api and web.
  world.config = new Set(['api', 'web', 'worker']);
  world.targets.repo_1 = [pending('worker')];
  watcher.accountChanged(true);
  enable();
  await waitFor(() => calls.starts.length === 1, 'runner for the new target');
  assert.deepEqual(calls.starts[0].targets, ['worker']);
  assert.equal(calls.configs.length, 1);
  // A target whose deploy command was removed on main stays pending forever:
  // it never starts a runner, and the config is not asked every interval.
  world.config = new Set(['api']);
  world.targets.repo_1 = [pending('gone', '2026-11-06T12:00:00.000Z')];
  let seen = calls.fetches.length;
  await waitFor(() => calls.fetches.length >= seen + 5, 'checks');
  assert.equal(calls.starts.length, 1);
  assert.equal(calls.configs.length, 2, 'one config request for the new pending work');
  assert.deepEqual(watcher.getState().repos[0].pending, []);
  // After the re-check period it asks once more (durango.toml may have changed without the target).
  clock.value += 11 * 60_000;
  await waitFor(() => calls.configs.length === 3, 'config re-checked');
  seen = calls.fetches.length;
  await waitFor(() => calls.fetches.length >= seen + 3, 'checks');
  assert.equal(calls.configs.length, 3);
  assert.equal(calls.starts.length, 1);
});

await test('no config request while a deploy holds a target or a local runner is going', async () => {
  const { watcher, calls, world, enable } = harness();
  world.targets.repo_1 = [pending('api', undefined, { running: true }), pending('web')];
  watcher.accountChanged(true);
  enable();
  await waitFor(() => calls.fetches.length >= 3, 'checks');
  world.targets.repo_1 = [pending('web')];
  world.runnerAlive = true;
  const seen = calls.fetches.length;
  await waitFor(() => calls.fetches.length >= seen + 3, 'checks');
  assert.equal(calls.configs.length, 0);
  assert.equal(calls.starts.length, 0);
});

await test('config: an older Durango Source without the endpoint falls back to the local durango.toml; errors back off', async () => {
  const { watcher, calls, world, enable } = harness();
  world.configError = Object.assign(new Error('Durango Source answered 404.'), { status: 404 });
  world.targets.repo_1 = [pending('worker'), pending('api')];
  watcher.accountChanged(true);
  enable();
  await waitFor(() => calls.starts.length === 1, 'start from the local file');
  assert.deepEqual(calls.starts[0].targets, ['api'], 'worker is unknown to the local file');
  const other = harness();
  other.world.configError = Object.assign(new Error('Durango Source answered 502.'), { status: 502 });
  other.world.targets.repo_1 = [pending('api')];
  other.watcher.accountChanged(true);
  other.enable();
  await waitFor(() => other.watcher.getState().status === 'error', 'error');
  assert.equal(other.calls.starts.length, 0);
  assert.ok(other.calls.sleeps.includes(90_000), 'backs off');
  other.world.configError = null;
  await waitFor(() => other.calls.starts.length === 1, 'starts once Source answers');
});

await test('turning it off, signing out or sleeping while the runner is being prepared starts nothing', async () => {
  for (const interrupt of ['off', 'signed out', 'sleep', 'quit']) {
    const { watcher, calls, world, enable } = harness();
    world.targets.repo_1 = [pending('api')];
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let reached = false;
    world.beforeStart = async () => {
      reached = true;
      await gate;
    };
    watcher.accountChanged(true);
    enable();
    await waitFor(() => reached, `preparation (${interrupt})`);
    if (interrupt === 'off') enable(false);
    if (interrupt === 'signed out') watcher.accountChanged(false);
    if (interrupt === 'sleep') watcher.suspend();
    if (interrupt === 'quit') watcher.stop();
    release();
    await watcher.idle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.notifications.length, 0, `nothing started after ${interrupt}`);
    assert.notEqual(watcher.getState().repos[0]?.state, 'started', interrupt);
    if (interrupt === 'sleep') {
      // A cancelled start is not remembered as an attempt: waking up starts it.
      world.beforeStart = null;
      watcher.resume();
      await waitFor(() => calls.notifications.length === 1, 'started after resume');
    }
    watcher.stop();
  }
});

await test('startBundledDeployRunner re-checks before every step and right before spawning', async () => {
  const deps = (overrides = {}) => {
    const seen = [];
    return {
      seen,
      hasCli: () => true,
      preparePath: async () => seen.push('path'),
      installCli: async () => seen.push('install'),
      signInCli: async () => (seen.push('sign-in'), { signedIn: true }),
      isSignedIn: async () => (seen.push('signed-in?'), true),
      runCli: async (args, options) => (seen.push(['run', args, options.cwd]), { code: 0, json: { ok: true, runner: { pid: 7, log: '/l.log', started: true } } }),
      cliError: (result, fallback) => result?.json?.error ?? fallback,
      ...overrides,
    };
  };
  const ok = deps();
  assert.deepEqual(await startBundledDeployRunner({ repoId: 'repo_1', checkout: '/src/app' }, ok), { ok: true, pid: 7, log: '/l.log', started: true });
  assert.deepEqual(ok.seen.at(-1), ['run', ['deploys', 'run', '--detach', '--json', '--project', 'repo_1', '--path', '/src/app'], '/src/app']);

  // Aborted during each await: never spawns.
  for (const step of ['preparePath', 'installCli', 'signInCli', 'isSignedIn']) {
    const controller = new AbortController();
    const d = deps();
    const original = d[step];
    d[step] = async () => {
      const value = await original();
      controller.abort();
      return value;
    };
    const result = await startBundledDeployRunner({ repoId: 'r', checkout: '/c', signal: controller.signal }, d);
    assert.deepEqual(result, { ok: false, cancelled: true }, step);
    assert.ok(!d.seen.some((entry) => Array.isArray(entry)), `no spawn after abort in ${step}`);
  }
  // The watcher stopped wanting it (setting off) without an abort: same.
  let wanted = true;
  const d = deps({ signInCli: async () => ((wanted = false), { signedIn: true }) });
  assert.deepEqual(await startBundledDeployRunner({ repoId: 'r', checkout: '/c', stillWanted: () => wanted }, d), { ok: false, cancelled: true });
  // Signed out just before the spawn.
  const signedOut = deps({ isSignedIn: async () => false });
  assert.deepEqual(await startBundledDeployRunner({ repoId: 'r', checkout: '/c' }, signedOut), { ok: false, cancelled: true });
  assert.ok(!signedOut.seen.some((entry) => Array.isArray(entry)));
  // Failures are errors, not cancellations.
  assert.match((await startBundledDeployRunner({ repoId: 'r', checkout: '/c' }, deps({ signInCli: async () => ({ signedIn: false, error: 'CLI says no' }) }))).error, /CLI says no/);
  assert.match((await startBundledDeployRunner({ repoId: 'r', checkout: '/c' }, deps({ hasCli: () => false }))).error, /does not include/);
  assert.equal(
    (await startBundledDeployRunner({ repoId: 'r', checkout: '/c' }, deps({ runCli: async () => ({ code: 1, json: { ok: false, error: 'no checkout' } }) }))).error,
    'no checkout'
  );
});

await test('createSourceConfigFetcher reads the deploy targets of durango.toml at main', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        req.url.includes('empty')
          ? { rev: 'main', oid: null, present: false, config: null, errors: [] }
          : {
              rev: 'main',
              oid: 'abc',
              present: true,
              config: { targets: { api: { name: 'api', deploy: 'railway up' }, desktop: { name: 'desktop', deploy: null }, blank: { name: 'blank', deploy: '  ' } } },
              errors: [],
            }
      )
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const fetchConfig = createSourceConfigFetcher({ readSession: async () => ({ token: 'desktop-session' }), baseUrl: () => base });
    const result = await fetchConfig('repo_1');
    assert.equal(result.oid, 'abc');
    assert.deepEqual([...result.deployTargets], ['api']);
    assert.deepEqual(requests[0], { url: '/api/repos/repo_1/source/config', auth: 'Bearer desktop-session' });
    assert.equal((await fetchConfig('empty')).deployTargets.size, 0, 'no durango.toml on main');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await fs.rm(testRoot, { recursive: true, force: true });

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log('durango deploy watcher: all tests passed');
