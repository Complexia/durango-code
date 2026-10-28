import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundledCliCommand, bundledCliEntry, bundledCliError, runBundledCli } from './bundled-cli.js';
import { execFileAsync } from './shell-env.js';

// Durango workspaces (docs/workspaces.md): an isolated checkout per thread,
// owned by the bundled durango-code CLI. Main never edits the workspace
// registry (~/.durango/workspaces.json) itself; it runs `ws new`, `ws rm`,
// `ws serve`, `ws stop`, `change show` and `land` with --json and reads the
// workspace's own `.durango/change.json` for the change it holds.

const WS_NEW_TIMEOUT_MS = 15 * 60_000;
const LAND_TIMEOUT_MS = 3 * 60 * 60_000;

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
 */
export const createDurangoWorkspace = async ({ projectPath, name, env }) => {
  const project = await inspectDurangoWorkspaceProject(projectPath);
  if (!project.eligible) {
    return { ok: false, error: 'This project is not in a Durango repository (no durango.toml at its root).' };
  }
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = attempt === 0 ? name : `${name.slice(0, 45)}-${attempt + 1}`;
    const result = await runBundledCli(['ws', 'new', candidate, '--repo', project.baseRoot, '--json'], {
      cwd: project.baseRoot,
      env,
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
 * from the project's base checkout's `ws list`. Null when the CLI doesn't know
 * it or it belongs to another repository.
 */
export const findDurangoWorkspace = async ({ projectPath, name }) => {
  const project = await inspectDurangoWorkspaceProject(projectPath);
  if (!project.eligible) return { ok: true, workspace: null };
  const result = await runBundledCli(['ws', 'list', '--json'], { cwd: project.baseRoot, timeout: 30_000 });
  if (!result.json?.ok) return { ok: false, error: bundledCliError(result, 'durango-code ws list failed.') };
  const entry = (result.json.workspaces ?? []).find(
    (workspace) =>
      workspace?.name === name && workspace.exists !== false && realpath(workspace.repo ?? '') === project.baseRoot
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
 * Everything the workspace bar shows. Local by default (the change file and
 * `ws list`); `remote` adds the change's Source status and URL, which needs
 * the network and a signed-in CLI.
 */
export const durangoWorkspaceStatus = async ({ path: workspacePath, name, repo, remote = false, env }) => {
  const exists = typeof workspacePath === 'string' && existsSync(workspacePath);
  const local = exists ? readLocalChange(workspacePath) : {};
  const changeId = local.changeId ?? local.lastChangeId ?? null;
  let server = null;
  const list = await runBundledCli(['ws', 'list', '--json'], { cwd: exists ? workspacePath : os.homedir(), timeout: 30_000 }).catch(
    () => null
  );
  const entry = list?.json?.workspaces?.find(
    (candidate) => candidate.path === workspacePath || (candidate.name === name && candidate.repo === repo)
  );
  server = entry?.server ?? null;
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
