import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// Deploy watcher: deploys changes that were landed somewhere other than this
// Mac (the web Land button, the Durango MCP, an AI client, another machine).
//
// Off by default ("Deploy changes landed elsewhere" in Settings → Durango).
// While it is on and the user is signed in, every ~45 s it asks Durango
// Source which deploy targets are pending (`GET /api/repos/:id/deploys`) for
// the repositories of the user's projects that have a checkout here and a
// durango.toml with at least one `deploy` command: one GET per repository per
// interval while nothing is pending. When a target is pending, no deploy
// holds a target of that repository, no runner is already going for it on
// this Mac (~/.durango/deploys/<repo>.pid), and durango.toml at main (asked
// from Durango Source only then, once per pending work) still has a `deploy`
// command for a pending target, it starts the bundled CLI's
// `deploys run --detach` in the repository's base checkout, unless the
// watcher was turned off, signed out or paused meanwhile.
// That runner is the same one `durango-code land` starts: detached from the
// app (quitting Durango Code does not stop it), it claims targets with
// leases (safe next to a runner on another Mac), runs each target's `deploy`
// command with this Mac's logins and exits when nothing is left.

export const DEPLOY_WATCH_INTERVAL_MS = 45_000;
const MAX_BACKOFF_MS = 10 * 60_000;
const OFFLINE_RECHECK_MS = 15_000;
/** Projects are re-read (git link, durango.toml) this often, and whenever the project list changes. */
export const DEPLOY_REINSPECT_MS = 10 * 60_000;
/**
 * A runner this watcher started exited with the same work still pending
 * (blocked behind a target that never settled, a claim it could not take,
 * a crash): start another one for that same work only after this long.
 */
export const DEPLOY_SAME_WORK_RETRY_MS = 30 * 60_000;
/** A repository Durango Source refuses (403/404) is skipped this long. */
const UNAVAILABLE_RETRY_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export const defaultDeployWatcherSettings = Object.freeze({ enabled: false });

export const normalizeDeployWatcherSettings = (raw) => ({
  enabled: Boolean(raw && typeof raw === 'object' && raw.enabled === true),
});

export class DeployWatchError extends Error {
  constructor(message, { status = null, code = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DeployWatchError';
    this.status = status;
    this.code = code;
  }
}

// --- durango.toml ------------------------------------------------------------------

const unquoteKey = (value) => {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
};

/**
 * The `[target.<name>]` tables of a durango.toml with a non-empty `deploy`
 * command. Only as much TOML as durango.toml's target tables use: a header
 * line, then `key = value` lines. A commented-out `# deploy = …` (a manual
 * target) does not count.
 */
export const deployTargetsFromToml = (text) => {
  const targets = new Set();
  let current = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const header = /^\[\s*([^[\]]+?)\s*\](?:\s*#.*)?$/.exec(line);
      const match = header ? /^target\s*\.\s*(.+)$/.exec(header[1]) : null;
      current = match ? unquoteKey(match[1]) : null;
      continue;
    }
    if (!current) continue;
    const deploy = /^deploy\s*=\s*(.*)$/.exec(line);
    if (!deploy) continue;
    const value = deploy[1].trim();
    if (/^("""|''')/.test(value)) {
      targets.add(current);
      continue;
    }
    const quoted = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(value);
    if (quoted && (quoted[1] ?? quoted[2] ?? '').trim()) targets.add(current);
  }
  return targets;
};

// --- Local checkout ------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const defaultGit = async (cwd, args) =>
  (await execFileAsync('git', ['-C', cwd, ...args], { timeout: 15_000 })).stdout.trim();

/**
 * Where a project's repository deploys from on this Mac: its Durango Source
 * repo id (`git config orion.cloudrepoid`, as the CLI reads it), the base
 * checkout (the main worktree, where `deploys run` runs) and the targets its
 * durango.toml can deploy. Null when any of them is missing.
 */
export const inspectDeployProject = async (projectPath, { git = defaultGit, readFile = (file) => fs.readFile(file, 'utf8') } = {}) => {
  if (typeof projectPath !== 'string' || !projectPath) return null;
  let gitRoot;
  try {
    gitRoot = await git(projectPath, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
  if (!gitRoot) return null;
  let checkout = gitRoot;
  try {
    const first = /^worktree (.+)$/m.exec(await git(gitRoot, ['worktree', 'list', '--porcelain']))?.[1];
    if (first) checkout = first;
  } catch {}
  let config;
  try {
    config = await readFile(path.join(checkout, 'durango.toml'));
  } catch {
    return null;
  }
  const deployTargets = deployTargetsFromToml(config);
  if (deployTargets.size === 0) return null;
  let repoId = '';
  try {
    repoId = await git(checkout, ['config', '--local', 'orion.cloudrepoid']);
  } catch {}
  if (!repoId) return null;
  return { repoId, checkout, deployTargets };
};

const durangoHome = (home) => path.join(home ?? os.homedir(), '.durango');

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const defaultCommandOf = async (pid) => {
  try {
    return (await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5_000 })).stdout.trim();
  } catch {
    return '';
  }
};

/**
 * Whether a `deploys run` holds the repository's runner lock on this Mac
 * (the CLI's ~/.durango/deploys/<repo>.pid; same check as its
 * ensureLocalDeployer).
 */
export const deployRunnerAlive = async (repoId, { home, commandOf = defaultCommandOf, isAlive = pidAlive } = {}) => {
  if (!/^[A-Za-z0-9_-]+$/.test(String(repoId ?? ''))) return false;
  let pid;
  try {
    pid = JSON.parse(await fs.readFile(path.join(durangoHome(home), 'deploys', `${repoId}.pid`), 'utf8'))?.pid;
  } catch {
    return false;
  }
  if (!isAlive(pid)) return false;
  return /\bdeploys\s+run\b/.test(await commandOf(pid));
};

// --- Durango Source ------------------------------------------------------------------

/**
 * A Durango Source GET with the desktop session (Durango Source accepts it
 * like a CLI token). Throws a DeployWatchError with the HTTP status on
 * failure (null: unreachable).
 */
const createSourceGet = ({ readSession, baseUrl, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) =>
  async (apiPath, { signal } = {}) => {
    const session = await readSession();
    if (!session?.token) throw new DeployWatchError('Not signed in to Durango.', { status: 401, code: 'not_signed_in' });
    const url = new URL(apiPath, await baseUrl());
    const timeout = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${session.token}`, accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error',
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new DeployWatchError(
        error?.name === 'TimeoutError' ? 'Durango Source timed out.' : `Could not reach Durango Source (${error?.message ?? error}).`,
        { cause: error }
      );
    }
    let data = null;
    try {
      data = await response.json();
    } catch {}
    if (!response.ok) {
      const message = typeof data?.error === 'string' ? data.error : data?.error?.message;
      throw new DeployWatchError(message || `Durango Source answered ${response.status}.`, {
        status: response.status,
        code: typeof data?.code === 'string' ? data.code : typeof data?.error?.code === 'string' ? data.error.code : null,
      });
    }
    return data;
  };

/** `GET /api/repos/:id/deploys` → `{ targets }`. The one request per repository per interval. */
export const createSourceDeploysFetcher = (options) => {
  const get = createSourceGet(options);
  return async (repoId, { signal } = {}) => {
    const data = await get(`/api/repos/${encodeURIComponent(repoId)}/deploys`, { signal });
    return { targets: Array.isArray(data?.targets) ? data.targets : [] };
  };
};

/**
 * The targets that have a `deploy` command in durango.toml at the tip of the
 * default branch, as Durango Source reads it (`GET /api/repos/:id/source/config`):
 * what a runner can actually claim. Only asked when something is pending.
 * `{ oid, deployTargets: Set<string> }`; an empty set when the file is
 * missing or does not parse (a runner could not claim anything either).
 */
export const createSourceConfigFetcher = (options) => {
  const get = createSourceGet(options);
  return async (repoId, { signal } = {}) => {
    const data = await get(`/api/repos/${encodeURIComponent(repoId)}/source/config`, { signal });
    const targets = data?.config?.targets && typeof data.config.targets === 'object' ? data.config.targets : {};
    const deployTargets = new Set(
      Object.entries(targets)
        .filter(([, target]) => typeof target?.deploy === 'string' && target.deploy.trim())
        .map(([name]) => name)
    );
    return { oid: typeof data?.oid === 'string' ? data.oid : null, deployTargets };
  };
};

// --- Decision ------------------------------------------------------------------------

/**
 * What to do about one repository given its deploy targets from Durango
 * Source. `deployTargets`: the targets with a `deploy` command (null: every
 * pending target counts). `deploy`: pending deployable targets, and no deploy
 * holds any target of the repository (a runner that holds one, here or on
 * another Mac, also deploys the rest once their `after` targets settle).
 */
export const pendingDeployWork = (targets, deployTargets) => {
  const list = Array.isArray(targets) ? targets.filter((target) => target && typeof target.target === 'string') : [];
  const pending = list
    .filter((target) => target.pending === true && (!deployTargets || deployTargets.has(target.target)))
    .sort((left, right) => left.target.localeCompare(right.target));
  const running = list.filter((target) => target.running === true).map((target) => target.target);
  return {
    pending: pending.map((target) => target.target),
    running,
    /** The work itself: which targets want which landing. */
    signature: pending.map((target) => `${target.target}@${target.wantedAt ?? target.wantedOid ?? ''}`).join(','),
    deploy: pending.length > 0 && running.length === 0,
  };
};

// --- Starting the runner -------------------------------------------------------------

const CANCELLED = Object.freeze({ ok: false, cancelled: true });

/**
 * Starts `deploys run --detach` with the bundled CLI, giving up (resolving
 * `{ ok: false, cancelled: true }`) whenever the watcher stopped wanting it
 * during the preparation: every await is a point where the user may have
 * turned the setting off, signed out, or the Mac went to sleep. The last
 * check (signal, watcher state, a fresh signed-in read) sits right before the
 * spawn; once spawned, the runner is detached and runs on its own.
 *
 * deps: hasCli(), preparePath(), installCli(), signInCli() → { signedIn, error? },
 * isSignedIn(), runCli(args, { cwd }) → { code, json, stderr }, cliError(result, fallback)
 */
export const startBundledDeployRunner = async ({ repoId, checkout, signal, stillWanted = () => true }, deps) => {
  const wanted = () => !signal?.aborted && stillWanted();
  if (!wanted()) return CANCELLED;
  if (!deps.hasCli()) return { ok: false, error: 'This Durango Code build does not include the durango-code CLI.' };
  // Deploy commands need the user's PATH (railway, bun, wrangler), not launchd's.
  await Promise.resolve(deps.preparePath()).catch(() => {});
  if (!wanted()) return CANCELLED;
  await deps.installCli();
  if (!wanted()) return CANCELLED;
  const cliSignIn = await deps.signInCli();
  if (!wanted()) return CANCELLED;
  if (!cliSignIn?.signedIn) return { ok: false, error: cliSignIn?.error ?? 'The durango-code CLI is not signed in.' };
  const signedIn = await Promise.resolve(deps.isSignedIn()).catch(() => false);
  if (!signedIn || !wanted()) return CANCELLED;
  const result = await deps.runCli(['deploys', 'run', '--detach', '--json', '--project', repoId, '--path', checkout], { cwd: checkout });
  if (result?.code !== 0 || result?.json?.ok !== true) {
    return { ok: false, error: deps.cliError(result, 'The deploy runner did not start.') };
  }
  const runner = result.json.runner ?? {};
  return { ok: true, pid: runner.pid, log: runner.log, started: runner.started !== false };
};

// --- Watcher -------------------------------------------------------------------------

const abortableSleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

const isAbort = (error) => error?.name === 'AbortError' || error?.cause?.name === 'AbortError';

const errorText = (error) => String(error?.message ?? error ?? 'unknown error');

/**
 * deps:
 * - fetchDeploys(repoId, { signal }): Promise<{ targets }>   throws { status } on failure
 * - fetchConfig(repoId, { signal }): Promise<{ deployTargets: Set<string> }>   Source's durango.toml at
 *     main; only asked when a runner would start, once per distinct pending work
 * - inspectProject(path): Promise<{ repoId, checkout, deployTargets: Set<string> } | null>
 * - isRunnerAlive(repoId): Promise<boolean>     a `deploys run` is going for it on this Mac
 * - startRunner({ repoId, checkout, targets, signal, stillWanted }): Promise<{ ok, pid?, log?, started?, error?, cancelled? }>
 *     `signal` aborts (and `stillWanted()` turns false) when the watcher is turned off, signs out,
 *     sleeps or stops: check it after every await and right before spawning, and resolve
 *     `{ ok: false, cancelled: true }` instead of starting.
 * - isSignedIn(): Promise<boolean>
 * - isOnline(): boolean
 * - notify({ repoId, name, checkout, targets, pid, log }): void   a runner was started
 * - onStateChange(state): void
 */
export const createDeployWatcher = ({
  fetchDeploys,
  fetchConfig = null,
  inspectProject = inspectDeployProject,
  isRunnerAlive = deployRunnerAlive,
  startRunner,
  isSignedIn = async () => true,
  isOnline = () => true,
  notify = () => {},
  onStateChange = () => {},
  sleep = abortableSleep,
  random = Math.random,
  now = () => Date.now(),
  intervalMs = DEPLOY_WATCH_INTERVAL_MS,
  reinspectMs = DEPLOY_REINSPECT_MS,
  sameWorkRetryMs = DEPLOY_SAME_WORK_RETRY_MS,
  log = (...args) => console.warn('[durango deploys]', ...args),
}) => {
  let settings = normalizeDeployWatcherSettings(null);
  let projects = [];
  let projectsSignature = '';
  let inspectedSignature = null;
  let inspectedAt = 0;
  let signedIn = false;
  let suspended = false;
  let generation = 0;
  let controller = null;
  let loopPromise = null;
  let status = 'off';
  let lastError = null;
  let lastCheckAt = null;
  /** repoId -> { repoId, name, checkout, deployTargets (local durango.toml), pending, state, error, startedAt, startSignature, startError, config, pid, log, skipUntil } */
  const repos = new Map();

  const publish = () => {
    try {
      onStateChange(getState());
    } catch {}
  };
  const setStatus = (next, error = null) => {
    if (status === next && lastError === error) return;
    status = next;
    lastError = error;
    publish();
  };

  const shouldRun = () => settings.enabled && signedIn && !suspended;

  const jitter = (ms) => Math.round(ms * (0.85 + random() * 0.3));

  /** Re-reads the projects' links and durango.toml; keeps what is known about repositories still present. */
  const inspect = async () => {
    const signature = projectsSignature;
    const found = new Map();
    for (const project of projects) {
      if (!project?.path) continue;
      let info = null;
      try {
        info = await inspectProject(project.path);
      } catch (error) {
        log(`could not inspect ${project.path}:`, errorText(error));
      }
      if (!info?.repoId || !info.checkout || found.has(info.repoId)) continue;
      found.set(info.repoId, { ...info, name: project.name || path.basename(info.checkout) });
    }
    for (const repoId of [...repos.keys()]) if (!found.has(repoId)) repos.delete(repoId);
    for (const [repoId, info] of found) {
      const known = repos.get(repoId);
      if (known) {
        known.name = info.name;
        known.checkout = info.checkout;
        known.deployTargets = info.deployTargets;
      } else {
        repos.set(repoId, {
          repoId,
          name: info.name,
          checkout: info.checkout,
          deployTargets: info.deployTargets,
          pending: [],
          state: 'idle',
          error: null,
          startedAt: null,
          startSignature: null,
          startError: null,
          /** { signature, at, deployTargets }: Source's deployable targets for that pending work. */
          config: null,
          pid: null,
          log: null,
          skipUntil: 0,
        });
      }
    }
    inspectedSignature = signature;
    inspectedAt = now();
    publish();
  };

  /**
   * Which pending targets a runner could deploy: Durango Source's config at
   * main when available (a target added on main counts before this checkout
   * has it; one that lost its `deploy` never starts runners), else the local
   * durango.toml. Asked once per distinct pending work (and again after
   * `reinspectMs` while that work stays pending, in case durango.toml changed
   * without touching the target), so steady polling stays one request per
   * repository and an idle repository never asks.
   */
  const deployableFor = async (repo, signature, signal) => {
    if (!fetchConfig) return repo.deployTargets;
    if (repo.config?.signature === signature && now() - repo.config.at < reinspectMs) return repo.config.deployTargets;
    let deployTargets;
    try {
      ({ deployTargets } = await fetchConfig(repo.repoId, { signal }));
    } catch (error) {
      // A Durango Source without the config endpoint: the local file decides.
      if (error?.status !== 404 || error?.code === 'repo_not_found') throw error;
      deployTargets = repo.deployTargets;
    }
    repo.config = { signature, at: now(), deployTargets: deployTargets instanceof Set ? deployTargets : new Set() };
    return repo.config.deployTargets;
  };

  const checkRepo = async (repo, signal, stillWanted) => {
    const { targets } = await fetchDeploys(repo.repoId, { signal });
    const all = pendingDeployWork(targets, null);
    repo.pending = all.pending;
    repo.error = null;
    if (all.pending.length === 0) {
      repo.state = 'idle';
      repo.config = null;
      return;
    }
    if (!all.deploy || (await isRunnerAlive(repo.repoId))) {
      repo.state = 'deploying';
      return;
    }
    if (!stillWanted()) return;
    const work = pendingDeployWork(targets, await deployableFor(repo, all.signature, signal));
    repo.pending = work.pending;
    if (work.pending.length === 0) {
      // Pending on Source, but nothing main can deploy any more.
      repo.state = 'idle';
      return;
    }
    if (repo.startSignature === work.signature && repo.startedAt !== null && now() - repo.startedAt < sameWorkRetryMs) {
      // Started (or tried to) for exactly this work and it is still pending
      // with no runner: something stopped it. Don't loop on it.
      repo.state = repo.startError ? 'error' : 'stalled';
      repo.error = repo.startError;
      return;
    }
    if (!stillWanted()) return;
    let result;
    try {
      result = await startRunner({ repoId: repo.repoId, checkout: repo.checkout, targets: work.pending, signal, stillWanted });
    } catch (error) {
      result = { ok: false, error: errorText(error) };
    }
    if (result?.cancelled) return;
    const retry = repo.startSignature === work.signature;
    repo.startSignature = work.signature;
    repo.startedAt = now();
    if (!result?.ok) {
      repo.state = 'error';
      repo.error = repo.startError = result?.error || 'The deploy runner did not start.';
      log(`could not start the deploy runner for ${repo.name}:`, repo.error);
      return;
    }
    repo.startError = null;
    repo.state = 'started';
    repo.pid = Number.isInteger(result.pid) ? result.pid : null;
    repo.log = typeof result.log === 'string' && result.log ? result.log : null;
    log(
      `${result.started === false ? 'joined the deploy runner' : 'started a deploy runner'} for ${repo.name} (${work.pending.join(', ')})` +
        `${repo.pid ? `, pid ${repo.pid}` : ''}${repo.log ? `, log ${repo.log}` : ''}`
    );
    if (result.started !== false && !retry) {
      try {
        notify({ repoId: repo.repoId, name: repo.name, checkout: repo.checkout, targets: work.pending, pid: repo.pid, log: repo.log });
      } catch {}
    }
  };

  const loop = async (myGeneration, signal) => {
    let failures = 0;
    const current = () => myGeneration === generation && !signal.aborted && shouldRun();
    while (current()) {
      if (!isOnline()) {
        setStatus('offline');
        await sleep(OFFLINE_RECHECK_MS, signal);
        continue;
      }
      if (!(await isSignedIn().catch(() => false))) {
        setStatus('signed_out');
        break;
      }
      if (inspectedSignature !== projectsSignature || now() - inspectedAt >= reinspectMs) await inspect();
      if (!current()) break;
      let failed = null;
      let signedOut = false;
      for (const repo of [...repos.values()]) {
        if (!current()) break;
        if (repo.skipUntil > now()) continue;
        try {
          await checkRepo(repo, signal, current);
        } catch (error) {
          if (!current() || isAbort(error)) break;
          if (error?.status === 401) {
            signedOut = true;
            break;
          }
          repo.error = errorText(error);
          if (error?.status === 403 || error?.status === 404) {
            // No access to the repository (or it is gone): leave it alone.
            repo.state = 'unavailable';
            repo.skipUntil = now() + UNAVAILABLE_RETRY_MS;
            continue;
          }
          repo.state = 'error';
          failed = error;
        }
      }
      if (!current()) break;
      if (signedOut) {
        setStatus('signed_out');
        break;
      }
      lastCheckAt = new Date(now()).toISOString();
      if (failed) {
        failures += 1;
        setStatus('error', errorText(failed));
        await sleep(jitter(Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** Math.min(failures - 1, 6))), signal);
        continue;
      }
      failures = 0;
      // Always publish: the repositories' states change without the status.
      status = 'watching';
      lastError = null;
      publish();
      await sleep(jitter(intervalMs), signal);
    }
  };

  const restart = () => {
    generation += 1;
    controller?.abort();
    controller = null;
    if (!shouldRun()) {
      setStatus(!settings.enabled ? 'off' : !signedIn ? 'signed_out' : 'paused');
      return;
    }
    const myController = new AbortController();
    controller = myController;
    const myGeneration = generation;
    const previous = loopPromise ?? Promise.resolve();
    loopPromise = previous
      .catch(() => {})
      .then(() => loop(myGeneration, myController.signal))
      .catch((error) => {
        log('deploy watcher stopped', errorText(error));
        if (myGeneration === generation) setStatus('error', errorText(error));
      });
  };

  function getState() {
    return {
      enabled: settings.enabled,
      signedIn,
      status,
      lastError,
      lastCheckAt,
      repos: [...repos.values()].map((repo) => ({
        repoId: repo.repoId,
        name: repo.name,
        checkout: repo.checkout,
        state: repo.state,
        pending: repo.pending,
        error: repo.error,
        startedAt: repo.startedAt ? new Date(repo.startedAt).toISOString() : null,
        pid: repo.pid,
        log: repo.log,
      })),
    };
  }

  return {
    getState,
    /** Settings and the project list ([{ id, name, path }]) from the renderer (startup and every change). */
    configure({ settings: nextSettings, projects: nextProjects } = {}) {
      const previous = settings;
      settings = normalizeDeployWatcherSettings(nextSettings);
      if (Array.isArray(nextProjects)) {
        projects = nextProjects.filter((project) => typeof project?.path === 'string' && project.path);
        projectsSignature = JSON.stringify(projects.map((project) => [project.path, project.name ?? '']));
      }
      if (previous.enabled !== settings.enabled || !loopPromise) restart();
      else publish();
    },
    /** Account transitions. Sign-out stops checking at once. */
    accountChanged(isSignedInNow) {
      const next = Boolean(isSignedInNow);
      if (next === signedIn && !(next && (status === 'signed_out' || status === 'error'))) return;
      signedIn = next;
      restart();
    },
    suspend() {
      if (suspended) return;
      suspended = true;
      restart();
    },
    resume() {
      if (suspended) {
        suspended = false;
        restart();
      }
    },
    /** Quit: stop checking. Runners already started keep going (they are detached). */
    stop() {
      settings = { ...settings, enabled: false };
      restart();
    },
    /** For tests: resolves when the current loop exits. */
    idle: () => loopPromise ?? Promise.resolve(),
  };
};
