import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundledCliCommand, bundledCliEntry, bundledCliError, runBundledCli } from './bundled-cli.js';
import { execFileAsync } from './shell-env.js';

// Durango workspaces (docs/workspaces.md): an isolated checkout per thread,
// owned by the bundled durango-code CLI. Main never edits the workspace
// registry (~/.durango/workspaces.json) or server-slots.json itself; it runs
// `ws new`, `ws rm`, `ws serve`, `ws stop`, `change show` and `land` with
// --json, and reads ~/.durango/workspaces.json, ~/.durango/server-slots.json
// and the workspace's own `.durango/change.json` directly (read-only) for
// status lookups without spawning a CLI process on every poll.

const WS_NEW_TIMEOUT_MS = 15 * 60_000;
const LAND_TIMEOUT_MS = 3 * 60 * 60_000;

const durangoHome = () => path.join(os.homedir(), '.durango');
const registryPath = () => path.join(durangoHome(), 'workspaces.json');
const slotsPath = () => path.join(durangoHome(), 'server-slots.json');

const jsonFileCache = new Map(); // path -> { mtimeMs, size, ino, data }

const readCachedJsonFile = (filePath) => {
  try {
    const stats = statSync(filePath);
    const cached = jsonFileCache.get(filePath);
    if (
      cached &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.size === stats.size &&
      cached.ino === stats.ino
    ) {
      return cached.data;
    }
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    jsonFileCache.set(filePath, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      ino: stats.ino,
      data: parsed,
    });
    return parsed;
  } catch {
    jsonFileCache.delete(filePath);
    return null;
  }
};

const pidAlive = (pid) => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const groupAlive = (pgid) => {
  if (typeof pgid !== 'number' || !Number.isInteger(pgid) || pgid <= 0) return false;
  if (process.platform === 'win32') return pidAlive(pgid);
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

/** Read-only view of `~/.durango/workspaces.json` (written atomically by the CLI). */
export const readWorkspaceRegistry = () => {
  const parsed = readCachedJsonFile(registryPath());
  return Array.isArray(parsed?.workspaces) ? parsed.workspaces : [];
};

/**
 * Read-only view of `~/.durango/server-slots.json` with live PID/process-group
 * filtering matching `cli/orion/src/server-slots.ts` (`pruneState`).
 */
export const readWorkspaceServerSlots = () => {
  const parsed = readCachedJsonFile(slotsPath());
  const running = new Set();
  const queued = new Set();
  if (Array.isArray(parsed?.running)) {
    for (const server of parsed.running) {
      if (server?.workspace && (pidAlive(server.pid) || groupAlive(server.childPid))) {
        running.add(server.workspace);
      }
    }
  }
  if (Array.isArray(parsed?.queue)) {
    for (const waiter of parsed.queue) {
      if (waiter?.workspace && pidAlive(waiter.pid)) {
        queued.add(waiter.workspace);
      }
    }
  }
  return { running, queued };
};

const realpath = (value) => {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};

const git = async (cwd, args) => (await execFileAsync('git', ['-C', cwd, ...args], { timeout: 15_000 })).stdout.trim();

/**
 * Whether threads in `projectPath` get a workspace: it must be inside the main
 * checkout of a git repository with a durango.toml at its root. A project that
 * is itself a worktree (a workspace opened as a project, say) is not eligible —
 * workspaces are always cut from the base checkout.
 */
export const inspectDurangoWorkspaceProject = async (projectPath) => {
  if (typeof projectPath !== 'string' || !projectPath || !existsSync(projectPath)) {
    return { ok: true, eligible: false, reason: 'missing' };
  }
  let gitRoot;
  try {
    gitRoot = realpath(await git(projectPath, ['rev-parse', '--show-toplevel']));
  } catch {
    return { ok: true, eligible: false, reason: 'not-git' };
  }
  let baseRoot = gitRoot;
  try {
    const listing = await git(gitRoot, ['worktree', 'list', '--porcelain']);
    const first = /^worktree (.+)$/m.exec(listing)?.[1];
    if (first) baseRoot = realpath(first);
  } catch {}
  if (baseRoot !== gitRoot) return { ok: true, eligible: false, reason: 'worktree', gitRoot, baseRoot };
  if (!existsSync(path.join(baseRoot, 'durango.toml'))) {
    return { ok: true, eligible: false, reason: 'no-config', gitRoot, baseRoot };
  }
  const relativeDir = path.relative(gitRoot, realpath(projectPath));
  return { ok: true, eligible: true, gitRoot, baseRoot, relativeDir: relativeDir.startsWith('..') ? '' : relativeDir };
};

const workspaceFromCli = (workspace, relativeDir) => ({
  name: workspace.name,
  path: workspace.path,
  workingDir: relativeDir ? path.join(workspace.path, relativeDir) : workspace.path,
  repo: workspace.repo,
  portBase: workspace.portBase,
  portBlock: workspace.portBlock,
  createdAt: workspace.createdAt ?? new Date().toISOString(),
});

/**
 * `ws new` from the project's base checkout. A name taken by an earlier
 * workspace gets a numeric suffix rather than failing the thread's turn.
 * `threadId` (DURANGO_THREAD_ID, which CLIs without thread support ignore)
 * records the thread on the workspace, so the changes opened from it carry it
 * and a Durango task linked to the thread follows them.
 */
export const createDurangoWorkspace = async ({ projectPath, name, threadId, env }) => {
  const project = await inspectDurangoWorkspaceProject(projectPath);
  if (!project.eligible) {
    return { ok: false, error: 'This project is not in a Durango repository (no durango.toml at its root).' };
  }
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = attempt === 0 ? name : `${name.slice(0, 45)}-${attempt + 1}`;
    const result = await runBundledCli(['ws', 'new', candidate, '--repo', project.baseRoot, '--json'], {
      cwd: project.baseRoot,
      env: typeof threadId === 'string' && threadId ? { ...env, DURANGO_THREAD_ID: threadId } : env,
      timeout: WS_NEW_TIMEOUT_MS,
    });
    if (result.json?.ok && result.json.workspace) {
      return {
        ok: true,
        workspace: workspaceFromCli(result.json.workspace, project.relativeDir),
        failedClones: (result.json.clones ?? []).filter((clone) => !clone.ok).map((clone) => clone.path),
        hints: result.json.hints ?? [],
        configErrors: result.json.configErrors ?? [],
      };
    }
    lastError = bundledCliError(result, 'durango-code ws new failed.');
    if (!/already exists|already uses the workspace directory/i.test(lastError)) break;
  }
  return { ok: false, error: lastError };
};

/**
 * A workspace an agent made itself (`durango-code ws new` in a turn), by name,
 * from the workspace registry (`~/.durango/workspaces.json`). Null when the
 * CLI doesn't know it, its directory is gone, or it belongs to another repo.
 */
export const findDurangoWorkspace = async ({ projectPath, name }) => {
  const project = await inspectDurangoWorkspaceProject(projectPath);
  if (!project.eligible) return { ok: true, workspace: null };
  const entry = readWorkspaceRegistry().find(
    (workspace) =>
      workspace?.name === name &&
      typeof workspace.path === 'string' &&
      existsSync(workspace.path) &&
      realpath(workspace.repo ?? '') === project.baseRoot
  );
  return { ok: true, workspace: entry ? workspaceFromCli(entry, project.relativeDir) : null };
};

/**
 * `ws rm`. Without `force` the CLI refuses while the workspace holds work that
 * has not landed; that refusal comes back as `unlanded` so the renderer can
 * ask before discarding it. A workspace the CLI no longer knows is reported
 * as removed.
 */
export const removeDurangoWorkspace = async ({ name, repo, force = false }) => {
  const cwd = repo && existsSync(repo) ? repo : os.homedir();
  const result = await runBundledCli(
    ['ws', 'rm', name, ...(repo ? ['--repo', repo] : []), '--json', ...(force ? ['--force'] : [])],
    { cwd, timeout: 120_000 }
  );
  if (result.json?.ok) return { ok: true };
  const error = bundledCliError(result, 'durango-code ws rm failed.');
  if (/^No workspace named/i.test(error)) return { ok: true, alreadyRemoved: true };
  return { ok: false, error, unlanded: /unlanded change/i.test(error) };
};

const PRUNE_TIMEOUT_MS = 10 * 60_000;
let pruneTail = Promise.resolve();
const pruneRuns = new Map(); // args key -> pending result

/**
 * `ws prune` (docs/workspaces.md): the CLI decides which workspaces are done
 * with (change merged or abandoned, or idle with no change and no edits) and
 * never touches one a process runs in. `keep` names the workspaces of threads
 * that are running; `only` limits it to the given workspaces; `dryRun` asks
 * what it would remove. Runs go one at a time; an identical pending one is shared.
 * `unsupported` means the bundled CLI predates `ws prune`.
 */
export const pruneDurangoWorkspaces = ({ keep = [], only = [], dryRun = false, idleDays } = {}) => {
  const args = ['ws', 'prune', '--json'];
  if (dryRun) args.push('--dry-run');
  if (Number.isFinite(idleDays) && idleDays >= 0) args.push('--idle-days', String(idleDays));
  for (const dir of keep) args.push('--keep', dir);
  for (const dir of only) args.push('--only', dir);
  const key = JSON.stringify(args);
  const pending = pruneRuns.get(key);
  if (pending) return pending;
  const run = pruneTail
    .then(() => runBundledCli(args, { cwd: os.homedir(), timeout: PRUNE_TIMEOUT_MS }))
    .then((result) => {
      if (result.json && Array.isArray(result.json.removed)) {
        return {
          ok: result.json.ok !== false,
          removed: result.json.removed,
          kept: result.json.kept ?? [],
          failed: result.json.failed ?? [],
        };
      }
      const error = bundledCliError(result, 'durango-code ws prune failed.');
      return { ok: false, error, unsupported: /Unknown ws command/i.test(error) };
    })
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }))
    .finally(() => pruneRuns.delete(key));
  pruneRuns.set(key, run);
  pruneTail = run.then(() => undefined);
  return run;
};

/**
 * The workspace directories in `paths` that no longer exist: removed by an
 * agent's own `ws rm`, or outside the app. Cheap enough to poll.
 */
export const missingDurangoWorkspaces = (paths) => paths.filter((workspacePath) => !existsSync(workspacePath));

const readLocalChange = (workspacePath) => {
  try {
    const state = JSON.parse(readFileSync(path.join(workspacePath, '.durango', 'change.json'), 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch {
    return {};
  }
};

const landRuns = new Map(); // workspace path -> { promise, startedAt }
const serveRuns = new Map(); // workspace path -> { child, queued }

/**
 * Everything the workspace bar shows. Local by default (reads
 * `~/.durango/workspaces.json`, `~/.durango/server-slots.json`, and the
 * workspace's `.durango/change.json` directly with zero subprocess spawns);
 * `remote` adds the change's Source status and URL, which needs the network
 * and a signed-in CLI.
 */
export const durangoWorkspaceStatus = async ({ path: workspacePath, name, repo, remote = false, env }) => {
  const exists = typeof workspacePath === 'string' && existsSync(workspacePath);
  const local = exists ? readLocalChange(workspacePath) : {};
  const changeId = local.changeId ?? local.lastChangeId ?? null;
  const entry = readWorkspaceRegistry().find(
    (candidate) =>
      candidate.path === workspacePath ||
      (Boolean(name) && candidate.name === name && candidate.repo === repo)
  );
  let server = null;
  if (entry?.name) {
    const slots = readWorkspaceServerSlots();
    server = slots.running.has(entry.name) ? 'running' : slots.queued.has(entry.name) ? 'queued' : null;
  }
  const served = serveRuns.get(workspacePath);
  if (!server && served) server = served.queued ? 'queued' : 'starting';
  let change = changeId ? { changeId, status: local.status ?? null, url: null, title: null, rejection: null } : null;
  if (remote && change && exists) {
    const shown = await runBundledCli(['change', 'show', changeId, '--json'], { cwd: workspacePath, env, timeout: 30_000 }).catch(
      () => null
    );
    if (shown?.json?.ok && shown.json.change) {
      change = {
        changeId,
        status: shown.json.change.status ?? change.status,
        url: shown.json.url ?? null,
        title: shown.json.change.title ?? null,
        rejection: shown.json.change.rejection?.message ?? null,
      };
    } else if (shown?.json && !shown.json.ok) {
      change.error = shown.json.error ?? null;
    }
  }
  return {
    ok: true,
    exists,
    registered: Boolean(entry),
    server,
    change,
    landing: landRuns.has(workspacePath),
  };
};

/**
 * `land`, waiting until the change is merged and live (or sent back), exactly
 * as the CLI does for an agent. Killing it would change nothing on the server,
 * so a run that outlives the window is simply forgotten on quit.
 */
export const landDurangoWorkspace = ({ path: workspacePath, env }) => {
  const existing = landRuns.get(workspacePath);
  if (existing) return existing.promise;
  const promise = runBundledCli(['land', '--json'], { cwd: workspacePath, env, timeout: LAND_TIMEOUT_MS })
    .then((result) => {
      if (result.json?.ok) {
        return { ok: true, changeId: result.json.changeId ?? null, url: result.json.url ?? null };
      }
      return {
        ok: false,
        error: bundledCliError(result, 'durango-code land failed.'),
        code: result.json?.code ?? null,
        url: result.json?.url ?? null,
        conflictFiles: result.json?.conflictFiles ?? null,
        exitCode: result.code,
      };
    })
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }))
    .finally(() => landRuns.delete(workspacePath));
  landRuns.set(workspacePath, { promise, startedAt: Date.now() });
  return promise;
};

const CHANGE_ID = /^chg_[a-z0-9]{8,40}$/;

/**
 * Where a Durango Source change can be acted on from this computer (a bot's
 * Ship / View change buttons): the workspace holding it, else a checkout of
 * its repository that knows it (`change show`). → `{ workspace?, repo, url, status }` or null.
 */
export const locateDurangoChange = async (changeId) => {
  if (!CHANGE_ID.test(String(changeId ?? ''))) return null;
  const workspaces = readWorkspaceRegistry().filter(
    (entry) => typeof entry?.path === 'string' && existsSync(entry.path)
  );
  const holder = workspaces.find((entry) => readLocalChange(entry.path).changeId === changeId);
  const show = async (cwd) => {
    const shown = await runBundledCli(['change', 'show', changeId, '--json'], { cwd, timeout: 30_000 }).catch(() => null);
    return shown?.json?.ok ? { url: shown.json.url ?? null, status: shown.json.change?.status ?? null } : null;
  };
  if (holder) return { workspace: holder.path, repo: holder.repo ?? null, ...((await show(holder.path)) ?? { url: null, status: null }) };
  const repos = [...new Set(workspaces.map((entry) => entry.repo).filter((repo) => typeof repo === 'string' && existsSync(repo)))];
  for (const repo of repos) {
    const shown = await show(repo);
    if (shown) return { repo, ...shown };
  }
  return null;
};

/**
 * Lands a change by id, the way the thread header's Land button does: from
 * the workspace holding it (`land` there, which checks and amends the tree
 * first), else `land <id>` in a checkout of its repository. Waits like the CLI.
 */
export const landDurangoChange = async ({ changeId, env }) => {
  const found = await locateDurangoChange(changeId);
  if (!found) return { ok: false, error: `Couldn't find ${changeId} in a Durango Source checkout on this computer.` };
  if (found.status && found.status !== 'open' && found.status !== 'queued') {
    return { ok: false, error: `${changeId} is ${found.status}, so there is nothing to land.`, url: found.url };
  }
  if (found.workspace) return landDurangoWorkspace({ path: found.workspace, env });
  const key = `change:${changeId}`;
  const existing = landRuns.get(key);
  if (existing) return existing.promise;
  const promise = runBundledCli(['land', changeId, '--json'], { cwd: found.repo, env, timeout: LAND_TIMEOUT_MS })
    .then((result) =>
      result.json?.ok
        ? { ok: true, changeId: result.json.changeId ?? changeId, url: result.json.url ?? found.url ?? null }
        : {
            ok: false,
            error: bundledCliError(result, 'durango-code land failed.'),
            code: result.json?.code ?? null,
            url: result.json?.url ?? found.url ?? null,
            exitCode: result.code,
          }
    )
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }))
    .finally(() => landRuns.delete(key));
  landRuns.set(key, { promise, startedAt: Date.now() });
  return promise;
};

/** `ws serve` in the background: the CLI waits for a server slot and runs `[workspace] serve`. */
export const serveDurangoWorkspace = ({ path: workspacePath, name, repo, onExit }) => {
  if (serveRuns.has(workspacePath)) return { ok: true };
  if (!existsSync(workspacePath)) return { ok: false, error: 'The workspace directory is missing.' };
  if (!bundledCliEntry()) return { ok: false, error: 'This Durango Code build does not include the durango-code CLI.' };
  const cli = bundledCliCommand();
  const child = spawn(cli.command, [...cli.args, 'ws', 'serve', name, ...(repo ? ['--repo', repo] : [])], {
    cwd: workspacePath,
    env: { ...process.env, ...cli.env },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  const run = { child, queued: false, stderr: '' };
  child.stderr.on('data', (chunk) => {
    run.stderr = `${run.stderr}${chunk}`.slice(-4000);
    if (/Waiting for a server slot/.test(chunk)) run.queued = true;
    if (/Server slot \d+\/\d+/.test(chunk)) run.queued = false;
  });
  const finish = (code) => {
    if (serveRuns.get(workspacePath) !== run) return;
    serveRuns.delete(workspacePath);
    onExit?.({ code, error: code ? run.stderr.trim().split('\n').at(-1) ?? null : null });
  };
  child.on('error', () => finish(1));
  child.on('close', (code) => finish(code ?? 0));
  serveRuns.set(workspacePath, run);
  return { ok: true };
};

export const stopDurangoWorkspaceServer = async ({ path: workspacePath, name, repo }) => {
  const run = serveRuns.get(workspacePath);
  const result = await runBundledCli(['ws', 'stop', name, '--json'], {
    cwd: repo && existsSync(repo) ? repo : os.homedir(),
    timeout: 30_000,
  }).catch(() => null);
  // A server still waiting for a slot holds none, so `ws stop` cannot see it.
  if (run && serveRuns.get(workspacePath) === run) run.child.kill('SIGTERM');
  return result?.json?.ok === false ? { ok: false, error: result.json.error } : { ok: true };
};

/** Quit: servers the app started stop with it (SIGTERM is forwarded to the dev server). */
export const stopAllDurangoWorkspaceServers = () => {
  for (const run of serveRuns.values()) run.child.kill('SIGTERM');
  serveRuns.clear();
};
