import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { resolveCommandPath } from '../shell-env.js';
import { deviceDataRoot } from './device-settings.js';
import toolVersions from './device-tool-versions.json';

// External device tools (today only agent-device) are installed on demand at
// a pinned version into userData/devices/tools/<name>/<version>, never
// bundled and never fetched at run time (no bunx/npx): the first device_open
// after a reboot must not depend on the registry.
//
// Install = a staging directory with a minimal package.json, the package
// installed into it at the exact pinned version, verify the package's bin
// entry exists, write .install-complete, then rename the staging directory
// into place. A half-finished install is never mistaken for a good one, and
// one in-memory lock per tool keeps the Settings button and a device_open
// from installing twice at once.
//
// The installer is bun when it is on the machine (`bun add --exact`), else
// npm, which comes with Node.js (`npm install --prefix <staging> --no-save
// --exact`, never global). Neither runs the package's install scripts
// (bun does not for dependencies; npm gets --ignore-scripts). Only when
// neither is found does Settings ask the user to install Node.js.
//
// The tools run on Durango Code's own executable as Node
// (ELECTRON_RUN_AS_NODE=1, the fuse forge.config.js keeps enabled for the MCP
// shim). agent-device needs Node >= 22.12; Electron ships a newer one.

export const AGENT_DEVICE = 'agent-device';
export const INSTALL_MARKER = '.install-complete';
export const NODE_INSTALL_URL = 'https://nodejs.org';
export const INSTALLER_MISSING_HINT = `Install Node.js (it includes npm) from ${NODE_INSTALL_URL}`;
export const INSTALL_TIMEOUT_MS = 5 * 60_000;

export const pinnedToolVersion = (name) => {
  const version = toolVersions[name];
  if (typeof version !== 'string' || !version) throw new Error(`No pinned version for ${name}.`);
  return version;
};

export const toolsRoot = () => path.join(deviceDataRoot(), 'devices', 'tools');
export const toolInstallDir = (name, version = pinnedToolVersion(name)) =>
  path.join(toolsRoot(), name, version);

/** `env[name]` looked up case-insensitively (Windows env names are, e.g. `Path`). */
const envValue = (env, name) => {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
};

/**
 * Windows: the first `command` + PATHEXT extension found on PATH (what
 * where.exe resolves), e.g. C:\Program Files\nodejs\npm.cmd; null when none.
 * Extensionless files (npm's sh script for Git Bash) are not runnable there.
 */
export const findOnWindowsPath = (command, { env = process.env, exists = existsSync } = {}) => {
  const exts = (envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);
  for (const raw of String(envValue(env, 'PATH') ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.win32.join(dir, `${command}${ext.toLowerCase()}`);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
};

/**
 * `command` on the user's PATH: the login shell's (`command -v`) on macOS and
 * Linux, PATH + PATHEXT on Windows (no POSIX shell there).
 */
const lookupCommand = async (command, { resolve, platform, env, exists }) =>
  platform === 'win32'
    ? findOnWindowsPath(command, { env, exists })
    : resolve(command).catch(() => null);

/** bun on the user's PATH, else the default ~/.bun/bin/bun; null when neither exists. */
export const locateBun = async ({
  resolve = resolveCommandPath,
  home = os.homedir(),
  exists = existsSync,
  platform = process.platform,
  env = process.env,
} = {}) => {
  const onPath = await lookupCommand('bun', { resolve, platform, env, exists });
  if (onPath && exists(onPath)) return onPath;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const fallback = join(home, '.bun', 'bin', platform === 'win32' ? 'bun.exe' : 'bun');
  return exists(fallback) ? fallback : null;
};

const newestNvmBin = (home, listDir) => {
  try {
    const versions = listDir(path.join(home, '.nvm', 'versions', 'node'))
      .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => {
        const [x, y] = [a, b].map((name) => name.slice(1).split('.').map(Number));
        return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
      });
    return versions.length ? path.join(home, '.nvm', 'versions', 'node', versions[0], 'bin') : null;
  } catch {
    return null;
  }
};

/**
 * npm on the user's PATH (the login shell's on macOS/Linux; PATH + PATHEXT on
 * Windows, where it is npm.cmd), else the usual Node.js install locations
 * (Homebrew, the nodejs.org installer, Volta, the newest nvm version; on
 * Windows Program Files\nodejs and %APPDATA%\npm); null when none exists.
 */
export const locateNpm = async ({
  resolve = resolveCommandPath,
  home = os.homedir(),
  exists = existsSync,
  listDir = (dir) => readdirSync(dir),
  platform = process.platform,
  env = process.env,
} = {}) => {
  const onPath = await lookupCommand('npm', { resolve, platform, env, exists });
  if (onPath && exists(onPath)) return onPath;
  if (platform === 'win32') {
    const programFiles = envValue(env, 'PROGRAMFILES');
    const appData = envValue(env, 'APPDATA');
    for (const dir of [programFiles && path.win32.join(programFiles, 'nodejs'), appData && path.win32.join(appData, 'npm')]) {
      if (dir && exists(path.win32.join(dir, 'npm.cmd'))) return path.win32.join(dir, 'npm.cmd');
    }
    return null;
  }
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.volta', 'bin'), newestNvmBin(home, listDir)]) {
    if (dir && exists(path.join(dir, 'npm'))) return path.join(dir, 'npm');
  }
  return null;
};

/**
 * The package manager that installs device tools: bun when present, else
 * npm (most machines with Node.js have it). `{ kind, path }` or null when
 * neither is on this machine.
 */
export const locateInstaller = async ({ findBun = locateBun, findNpm = locateNpm } = {}) => {
  const bun = await findBun().catch(() => null);
  if (bun) return { kind: 'bun', path: bun };
  const npm = await findNpm().catch(() => null);
  if (npm) return { kind: 'npm', path: npm };
  return null;
};

/** argv for installing `spec` into `stagingDir` with `kind` (exact version, local, no scripts for npm). */
export const installerArgs = (kind, stagingDir, spec) =>
  kind === 'bun'
    ? ['add', '--exact', '--cwd', stagingDir, spec]
    : [
        'install',
        '--prefix',
        stagingDir,
        '--no-save',
        '--exact',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--loglevel=error',
        spec,
      ];

/** The package's bin entry (absolute) inside an install dir, or null when it is missing. */
export const readToolEntry = async (installDir, name) => {
  const packageDir = path.join(installDir, 'node_modules', name);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[name];
  if (typeof bin !== 'string' || !bin) return null;
  const entry = path.resolve(packageDir, bin);
  // A bin path escaping the package would be a broken (or hostile) manifest.
  if (!entry.startsWith(`${packageDir}${path.sep}`) || !existsSync(entry)) return null;
  return entry;
};

/** `{ name, version, installed, entry }` for the pinned version. */
export const toolInstallState = async (name) => {
  const version = pinnedToolVersion(name);
  const dir = toolInstallDir(name, version);
  if (!existsSync(path.join(dir, INSTALL_MARKER))) return { name, version, installed: false, entry: null };
  const entry = await readToolEntry(dir, name);
  return { name, version, installed: Boolean(entry), entry };
};

/**
 * How to execFile the installer: `{ file, args, options }` (options without
 * cwd/timeout). On Windows npm is npm.cmd, which Node only runs through
 * cmd.exe (`shell: true`, since the CVE-2024-27980 fix); that joins argv with
 * spaces, so each part is quoted. PATH gets the installer's directory first
 * (npm's launcher needs `node` next to it: nvm, Volta, Homebrew, nodejs.org),
 * set under the env's own PATH key (`Path` on Windows) so the child does not
 * get two.
 */
export const installerInvocation = (installer, stagingDir, spec, { platform = process.platform, env = process.env } = {}) => {
  const viaShell = platform === 'win32' && /\.(cmd|bat)$/i.test(installer.path);
  const quote = (value) => (viaShell ? `"${value}"` : value);
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  return {
    file: quote(installer.path),
    args: installerArgs(installer.kind, stagingDir, spec).map(quote),
    options: {
      shell: viaShell,
      windowsHide: true,
      env: {
        ...env,
        [pathKey]: [pathApi.dirname(installer.path), env[pathKey]].filter(Boolean).join(pathApi.delimiter),
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        ...(installer.kind === 'npm' ? { npm_config_update_notifier: 'false' } : {}),
      },
    },
  };
};

const runInstaller = (installer, stagingDir, spec) =>
  new Promise((resolve, reject) => {
    const label = installer.kind === 'bun' ? `bun add ${spec}` : `npm install ${spec}`;
    const { file, args, options } = installerInvocation(installer, stagingDir, spec);
    execFile(
      file,
      args,
      {
        ...options,
        cwd: stagingDir,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim().split('\n').slice(-6).join('\n');
          reject(new Error(`${label} failed: ${detail}`));
          return;
        }
        resolve();
      }
    );
  });

const installLocks = new Map(); // name -> Promise<state>
const installErrors = new Map(); // name -> last error message

export const toolInstallInProgress = (name) => installLocks.has(name);
export const lastToolInstallError = (name) => installErrors.get(name) ?? null;

/**
 * Installs the pinned version of `name` (no-op when it already is). Resolves
 * to the install state; rejects with a readable error (no bun or npm,
 * network). `installer` ({ kind, path }), `findInstaller` and `runAdd` are
 * injectable for tests.
 */
export const ensureToolInstalled = (
  name,
  { installer: givenInstaller, findInstaller = locateInstaller, runAdd = runInstaller } = {}
) => {
  const running = installLocks.get(name);
  if (running) return running;
  const job = (async () => {
    const current = await toolInstallState(name);
    if (current.installed) return current;
    const installer = givenInstaller ?? (await findInstaller());
    if (!installer) {
      throw new Error(
        `Installing ${name} needs npm (part of Node.js) or bun, and neither was found. ${INSTALLER_MISSING_HINT}, then try again.`
      );
    }
    const version = current.version;
    const finalDir = toolInstallDir(name, version);
    const parent = path.dirname(finalDir);
    await fs.mkdir(parent, { recursive: true });
    const stagingDir = path.join(parent, `.staging-${version}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      await fs.mkdir(stagingDir, { recursive: true });
      await fs.writeFile(
        path.join(stagingDir, 'package.json'),
        `${JSON.stringify({ name: 'durango-device-tool', private: true }, null, 2)}\n`
      );
      await runAdd(installer, stagingDir, `${name}@${version}`);
      const stagedEntry = await readToolEntry(stagingDir, name);
      if (!stagedEntry) throw new Error(`${name}@${version} installed without its command entry.`);
      await fs.writeFile(
        path.join(stagingDir, INSTALL_MARKER),
        `${JSON.stringify({ name, version, installedAt: new Date().toISOString() })}\n`
      );
      // An earlier interrupted install may have left an unmarked final dir.
      await fs.rm(finalDir, { recursive: true, force: true });
      await fs.rename(stagingDir, finalDir);
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
    const installed = await toolInstallState(name);
    if (!installed.installed) throw new Error(`${name}@${version} did not install correctly.`);
    return installed;
  })();
  installLocks.set(name, job);
  job.then(
    () => installErrors.delete(name),
    (error) => installErrors.set(name, error?.message ?? String(error))
  );
  job.finally(() => installLocks.delete(name)).catch(() => {});
  return job;
};

/** Settings-facing summary of one tool, including which installer it would use. */
export const toolStatus = async (name, { findInstaller = locateInstaller } = {}) => {
  const state = await toolInstallState(name);
  // Only look for an installer when one is still needed.
  const installer = state.installed ? null : await findInstaller();
  return {
    ...state,
    installing: toolInstallInProgress(name),
    error: lastToolInstallError(name),
    installer: installer?.kind ?? null,
    installerPath: installer?.path ?? null,
    installerMissingHint: state.installed || installer ? null : INSTALLER_MISSING_HINT,
  };
};

/** Command + env that run a tool entry on Durango Code's executable as Node. */
export const nodeRuntime = () => ({
  command: process.execPath,
  env: { ELECTRON_RUN_AS_NODE: '1' },
});
