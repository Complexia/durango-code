import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Source checkout: when Durango asks this machine to run an agent in a Durango
// Source repository it doesn't have (a run started from Durango Chat, Tasks,
// the API, or a paired machine), clone it with the bundled CLI's
// `durango-code clone` (signed in as this app's account), which also restores
// the repository's development env files from its vault, and add the clone as
// a project. From then on it is an ordinary project: threads get workspaces
// cut from it, open changes and land from it like anywhere else.
//
// Clones go to ~/Durango/<repository name> (DURANGO_CHECKOUT_ROOT overrides).
// An existing clone of the same repository there is reused; a folder of the
// same name holding something else gets the repository id appended.

export const CLONE_TIMEOUT_MS = 60 * 60_000;

/** The first durango-code CLI with `clone` (and `env files`). */
export const CLI_CLONE_VERSION = '0.10.0';

/** Whether a CLI version (x.y.z) has `clone`. */
export const cliSupportsClone = (version) => {
  const parse = (value) => String(value ?? '').split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10));
  const have = parse(version);
  if (have.length < 3 || have.some((part) => !Number.isFinite(part))) return false;
  const need = parse(CLI_CLONE_VERSION);
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== need[index]) return have[index] > need[index];
  }
  return true;
};

export const sourceCheckoutRoot = (env = process.env, home = os.homedir()) =>
  env.DURANGO_CHECKOUT_ROOT && path.isAbsolute(env.DURANGO_CHECKOUT_ROOT)
    ? env.DURANGO_CHECKOUT_ROOT
    : path.join(home, 'Durango');

/** A folder name for the repository: its name made safe, else its id. */
export const checkoutFolderName = (name, repoId) => {
  const cleaned = String(name ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return cleaned || String(repoId).replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 64) || 'repository';
};

const linkedRepoId = async (dir) => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'config', '--local', '--get', 'orion.cloudrepoid'], {
      timeout: 15_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

const isEmptyDir = (dir) => {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length === 0;
  } catch {
    return false;
  }
};

/** Where to clone `repoId`: its own clone if one is there, else a free folder. */
export const chooseCheckoutDir = async (root, { repoId, name }, readLink = linkedRepoId) => {
  const base = checkoutFolderName(name, repoId);
  for (const folder of [base, `${base}-${checkoutFolderName(null, repoId)}`]) {
    const dir = path.join(root, folder);
    if (!existsSync(dir) || isEmptyDir(dir)) return dir;
    if ((await readLink(dir)) === repoId) return dir;
  }
  throw new Error(`${path.join(root, base)} already holds something else. Move it, or add the repository as a project yourself.`);
};

/**
 * `runCli(args, options)` runs the bundled CLI (bundled-cli.js runBundledCli),
 * `prepareCli()` installs it and signs it in, `addProject({ name, path })` →
 * `{ id }` adds (or finds) the project in the renderer, `existingProject(repoId)`
 * → a project this machine already has for the repository, if any.
 */
export const createSourceCheckout = ({ runCli, prepareCli, addProject, existingProject = async () => null, root = () => sourceCheckoutRoot(), cliError }) => {
  const inFlight = new Map(); // repoId -> { promise, controller, callers }

  const checkout = async ({ repoId, name, signal }) => {
    const existing = await existingProject(repoId);
    if (existing) return existing;
    await prepareCli();
    const parent = root();
    mkdirSync(parent, { recursive: true });
    const dir = await chooseCheckoutDir(parent, { repoId, name });
    const result = await runCli(['clone', repoId, dir, '--json'], { cwd: parent, timeout: CLONE_TIMEOUT_MS, signal });
    if (result.code !== 0 || !result.json?.ok) {
      throw new Error(cliError ? cliError(result, 'durango-code clone failed.') : 'durango-code clone failed.');
    }
    const clonedPath = typeof result.json.path === 'string' ? result.json.path : dir;
    const projectName = (typeof result.json.name === 'string' && result.json.name) || name || path.basename(clonedPath);
    const added = await addProject({ name: projectName, path: clonedPath });
    if (!added?.id) throw new Error(added?.error || 'The clone could not be added as a project.');
    return {
      id: added.id,
      name: projectName,
      path: clonedPath,
      repoId,
      env: result.json.env ?? null,
      envError: result.json.envError ?? null,
    };
  };

  /**
   * One clone per repository at a time; concurrent requests share it. The
   * shared clone has its own cancellation: a caller's `signal` only detaches
   * that caller (its promise rejects), and the clone stops once no caller
   * still wants it.
   */
  return ({ repoId, name = null, signal } = {}) => {
    // Starts with a letter or digit, so it can never read as a CLI flag.
    if (typeof repoId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(repoId)) {
      return Promise.reject(new Error('A Durango Source repository id is required.'));
    }
    if (signal?.aborted) return Promise.reject(new Error('The checkout was cancelled.'));
    let shared = inFlight.get(repoId);
    if (!shared) {
      const controller = new AbortController();
      shared = { controller, callers: 0, promise: null };
      shared.promise = checkout({ repoId, name, signal: controller.signal }).finally(() => {
        if (inFlight.get(repoId) === shared) inFlight.delete(repoId);
      });
      inFlight.set(repoId, shared);
    }
    const entry = shared;
    entry.callers += 1;
    return new Promise((resolve, reject) => {
      let done = false;
      const detach = () => {
        if (done) return;
        done = true;
        entry.callers -= 1;
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (done) return;
        detach();
        if (entry.callers === 0) entry.controller.abort();
        reject(new Error('The checkout was cancelled.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        (project) => {
          if (done) return;
          detach();
          resolve(project);
        },
        (error) => {
          if (done) return;
          detach();
          reject(error);
        }
      );
    });
  };
};
