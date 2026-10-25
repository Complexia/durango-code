import { app } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The durango-code CLI (source control, Durango workspaces, changes, deploys)
// ships inside the app as the pinned `durango-code` npm dependency, unpacked
// from the asar. It is dependency-free JavaScript, so it runs on Electron's
// own Node (ELECTRON_RUN_AS_NODE) and nobody has to install it separately.
//
// installBundledCliShims() writes small `durango-code` / `ds` / `durango-source`
// / `orion-cli` launchers into <userData>/bin, and main appends that directory
// to PATH so agents and the embedded terminal can run the CLI. It is appended,
// not prepended: a CLI the user installed globally keeps winning for them. The
// app's own workspace features always run the bundled copy (runBundledCli).

export const CLI_ALIASES = ['durango-code', 'ds', 'durango-source', 'orion-cli'];

/** The CLI's default origin (cli/orion/src/config.ts DEFAULT_ORIGIN). */
export const CLI_DEFAULT_ORIGIN = 'https://code.durango.sh';
/** Origins the CLI treats as the same backend (config.ts EQUIVALENT_ORIGINS). */
const CLI_EQUIVALENT_ORIGINS = [CLI_DEFAULT_ORIGIN, 'https://orioncode.xyz'];

const cliPackageRoots = () => {
  // Tests run main modules outside the app bundle.
  if (process.env.ORION_BUNDLED_CLI_DIR) return [process.env.ORION_BUNDLED_CLI_DIR];
  const appPath = app.getAppPath();
  const roots = [appPath];
  // Packaged builds keep the CLI unpacked next to the asar (forge.config.js),
  // where a separate Node process can read it.
  if (appPath.endsWith('.asar')) roots.unshift(`${appPath}.unpacked`);
  return roots.map((root) => path.join(root, 'node_modules', 'durango-code'));
};

export const bundledCliEntry = () => {
  for (const root of cliPackageRoots()) {
    const entry = path.join(root, 'dist', 'index.js');
    if (existsSync(entry)) return entry;
  }
  return null;
};

export const bundledCliVersion = () => {
  for (const root of cliPackageRoots()) {
    try {
      const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))?.version;
      if (version) return version;
    } catch {}
  }
  return null;
};

export const bundledCliBinDir = () => path.join(app.getPath('userData'), 'bin');
const wrapperPath = () => path.join(bundledCliBinDir(), 'durango-code.mjs');

// Runs before the CLI. Electron only behaves as Node while
// ELECTRON_RUN_AS_NODE is set, but every process the CLI starts (`ws serve`
// dev servers, `ws run` commands) would inherit it, and an Electron app
// launched that way would never open a window. So the wrapper clears it for
// children and restores it only for the CLI's own re-launch of this binary
// (the local train, train.ts ensureLocalTrain).
const wrapperSource = (entry) => `// Written by Durango Code: runs the durango-code CLI bundled with the app.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
delete process.env.ELECTRON_RUN_AS_NODE;
const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (command === process.execPath) {
    const hasArgs = Array.isArray(args);
    const spawnOptions = (hasArgs ? options : args) ?? {};
    const env = { ...(spawnOptions.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' };
    return hasArgs
      ? spawn.call(this, command, args, { ...spawnOptions, env })
      : spawn.call(this, command, { ...spawnOptions, env });
  }
  return spawn.apply(this, arguments);
};
syncBuiltinESMExports();

// The CLI words its hints after the alias it was invoked as (ui.ts).
const invokedAs = process.env.DURANGO_CODE_INVOKED_AS;
delete process.env.DURANGO_CODE_INVOKED_AS;
if (invokedAs) process.argv[1] = path.join(path.dirname(process.argv[1]), invokedAs);

await import(pathToFileURL(${JSON.stringify(entry)}).href);
`;

const posixQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const posixShim = (alias) => `#!/bin/sh
# Written by Durango Code: runs the durango-code CLI bundled with the app.
ELECTRON_RUN_AS_NODE=1 DURANGO_CODE_NO_UPDATE_CHECK=1 DURANGO_CODE_INVOKED_AS=${alias} exec ${posixQuote(process.execPath)} ${posixQuote(wrapperPath())} "$@"
`;

const windowsShim = (alias) => `@echo off
rem Written by Durango Code: runs the durango-code CLI bundled with the app.
set ELECTRON_RUN_AS_NODE=1
set DURANGO_CODE_NO_UPDATE_CHECK=1
set DURANGO_CODE_INVOKED_AS=${alias}
"${process.execPath}" "${wrapperPath()}" %*
`;

const writeIfChanged = async (target, content, mode) => {
  try {
    if ((await fs.readFile(target, 'utf8')) === content) {
      if (mode) await fs.chmod(target, mode);
      return;
    }
  } catch {}
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { mode: mode ?? 0o644 });
  await fs.rename(temporary, target);
};

/**
 * Writes the wrapper and the alias launchers. The app path and Electron
 * binary change with every update (and differ between dev and packaged
 * builds), so this runs on every launch. Returns the bin directory, or null
 * when this build has no bundled CLI.
 */
export const installBundledCliShims = async () => {
  const entry = bundledCliEntry();
  if (!entry) return null;
  const binDir = bundledCliBinDir();
  await fs.mkdir(binDir, { recursive: true });
  await writeIfChanged(wrapperPath(), wrapperSource(entry));
  for (const alias of CLI_ALIASES) {
    if (process.platform === 'win32') {
      await writeIfChanged(path.join(binDir, `${alias}.cmd`), windowsShim(alias));
    } else {
      await writeIfChanged(path.join(binDir, alias), posixShim(alias), 0o755);
    }
  }
  return binDir;
};

/** How to start the bundled CLI as a child process: `spawn(command, [...args, ...cliArgs], { env })`. */
export const bundledCliCommand = () => ({
  command: process.execPath,
  args: [wrapperPath()],
  env: { ELECTRON_RUN_AS_NODE: '1', DURANGO_CODE_NO_UPDATE_CHECK: '1' },
});

const CLI_KILL_GRACE_MS = 2_000;

/**
 * Runs the bundled CLI and resolves with its exit code and output. `--json`
 * commands print one JSON line on stdout (also on failure); it is parsed into
 * `json` when present.
 */
export const runBundledCli = (args, { cwd, env, timeout = 120_000, signal } = {}) =>
  new Promise((resolve, reject) => {
    const entry = bundledCliEntry();
    if (!entry) {
      reject(new Error('This Durango Code build does not include the durango-code CLI.'));
      return;
    }
    if (signal?.aborted) {
      reject(new Error(`durango-code ${args[0]} was cancelled.`));
      return;
    }
    const cli = bundledCliCommand();
    const child = spawn(cli.command, [...cli.args, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...env, ...cli.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64_000) stderr += chunk;
    });
    const stop = () => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, CLI_KILL_GRACE_MS).unref();
    };
    const timer = timeout ? setTimeout(stop, timeout) : null;
    signal?.addEventListener('abort', stop, { once: true });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve(result);
    };
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, closeSignal) => {
      let json = null;
      const lastLine = stdout.trim().split('\n').at(-1);
      if (lastLine?.startsWith('{')) {
        try {
          json = JSON.parse(lastLine);
        } catch {}
      }
      finish({ code: code ?? (closeSignal ? 1 : 0), signal: closeSignal, stdout, stderr, json });
    });
  });

/** The failure a non-zero CLI run reports, preferring its JSON `error`. */
export const bundledCliError = (result, fallback) =>
  result?.json?.error ||
  result?.stderr
    ?.replace(/\u001b\[[0-9;]*m/g, '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .at(-1)
    ?.replace(/^✗\s*/, '') ||
  fallback;

// --- CLI sign-in ------------------------------------------------------------------

const cliConfigDir = () =>
  process.env.DURANGO_CODE_CONFIG_DIR || process.env.ORION_CONFIG_DIR || path.join(os.homedir(), '.config', 'durango-code');
const cliCredentialsPath = () => path.join(cliConfigDir(), 'credentials.json');
const legacyCliCredentialsPath = () =>
  process.env.DURANGO_CODE_CONFIG_DIR || process.env.ORION_CONFIG_DIR
    ? null
    : path.join(os.homedir(), '.config', 'orion', 'credentials.json');

const readJsonObject = async (file) => {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const sameOrigin = (left, right) => {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
};

/** Whether the CLI would pick up an app-minted credential for `origin`. */
export const cliUsesOrigin = (origin) =>
  !process.env.DURANGO_CODE_ORIGIN &&
  !process.env.ORION_ORIGIN &&
  CLI_EQUIVALENT_ORIGINS.some((candidate) => sameOrigin(candidate, origin));

/** The CLI's saved sign-in for its default origin, mirroring config.ts loadCredentials. */
export const readCliCredential = async () => {
  if (process.env.DURANGO_CODE_TOKEN || process.env.ORION_TOKEN) return { source: 'environment' };
  const current = await readJsonObject(cliCredentialsPath());
  const legacyPath = legacyCliCredentialsPath();
  const all = current ?? (legacyPath ? await readJsonObject(legacyPath) : null) ?? {};
  for (const origin of CLI_EQUIVALENT_ORIGINS) {
    if (typeof all[origin]?.token === 'string' && all[origin].token) {
      return { source: 'saved', user: all[origin].user ?? null };
    }
  }
  return null;
};

/**
 * Signs the CLI in with the app's Durango account when it has no credential
 * of its own, the same way `durango-code login` would: a dedicated device
 * token (minted with the account session) saved to the CLI's credentials
 * file. It is marked managed, so `durango-code logout` revokes it. Never
 * replaces an existing CLI sign-in.
 */
export const ensureCliSignedIn = async ({ readSession, origin }) => {
  const existing = await readCliCredential();
  if (existing) return { ok: true, signedIn: true, created: false, user: existing.user ?? null };
  if (!cliUsesOrigin(origin)) {
    return { ok: false, signedIn: false, error: `The CLI talks to ${CLI_DEFAULT_ORIGIN}, not ${new URL(origin).origin}.` };
  }
  const session = await readSession();
  if (!session?.token || (session.expiresAt && Date.parse(session.expiresAt) <= Date.now())) {
    return { ok: false, signedIn: false, needsSignIn: true, error: 'Sign in to Durango Code to sign in the CLI.' };
  }
  const response = await fetch(new URL('/api/desktop-auth/repository-token', origin), {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Durango Code CLI · ${os.hostname()}`.slice(0, 100) }),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !/^orion_pat_[0-9a-f]{64}$/.test(data.token ?? '')) {
    return {
      ok: false,
      signedIn: false,
      needsSignIn: response.status === 401,
      error: data.error || `Could not authorize the CLI (${response.status}).`,
    };
  }
  // Re-check: a `durango-code login` may have finished meanwhile.
  if (await readCliCredential()) {
    void fetch(new URL('/api/desktop-auth/repository-token', origin), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${data.token}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
    return { ok: true, signedIn: true, created: false };
  }
  const user = data.user ?? session.user ?? null;
  const file = cliCredentialsPath();
  const legacyPath = legacyCliCredentialsPath();
  const all = (await readJsonObject(file)) ?? (legacyPath ? await readJsonObject(legacyPath) : null) ?? {};
  for (const alias of CLI_EQUIVALENT_ORIGINS) delete all[alias];
  all[CLI_DEFAULT_ORIGIN] = {
    token: data.token,
    user: user ? { id: user.id, name: user.name ?? null, email: user.email ?? null } : null,
    expiresAt: null,
    managed: true,
  };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(all, null, 2), { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return { ok: true, signedIn: true, created: true, user };
};
