import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const execFileAsync = promisify(execFile);
export const loginShell = process.env.SHELL || '/bin/zsh';
export let shellPathSyncPromise = Promise.resolve();
export const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const SHELL_PATH_RETRY_COOLDOWN_MS = 30_000;
const MAX_INTERACTIVE_SYNC_RETRIES = 2;
let shellPathSynced = process.platform === 'win32';
let shellPathInteractiveSynced = process.platform === 'win32';
let shellPathInteractiveRetries = 0;
let shellPathSyncInFlight = false;
let lastShellPathSyncAttemptAt = 0;
let commandPathCacheEpoch = 0;

export const shellPathProbeCommand = (shell = loginShell) => {
  const name = path.basename(String(shell || '')).toLowerCase();
  if (name === 'fish') {
    // fish stores $PATH as a list; "$PATH" would expand space-separated.
    return `printf '__ORION_PATH__'; string join : -- $PATH; printf '__ORION_PATH__'`;
  }
  if (
    name === 'zsh' ||
    name === 'bash' ||
    name === 'sh' ||
    name === 'dash' ||
    name === 'ksh' ||
    name === 'ash'
  ) {
    return `printf '__ORION_PATH__%s__ORION_PATH__' "$PATH"`;
  }
  return `printf '__ORION_PATH__'; printenv PATH; printf '__ORION_PATH__'`;
};

const readShellPath = async (flags, timeout = 8000, shell = loginShell) => {
  const { stdout } = await execFileAsync(shell, [flags, shellPathProbeCommand(shell)], {
    timeout,
    env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
  });
  const match = stdout.match(/__ORION_PATH__([\s\S]*)__ORION_PATH__/);
  return match?.[1]?.trim() || '';
};

const needsShellPathRetry = () =>
  process.platform !== 'win32' &&
  (!shellPathSynced ||
    (!shellPathInteractiveSynced && shellPathInteractiveRetries < MAX_INTERACTIVE_SYNC_RETRIES));

// Finder-launched apps inherit launchd's minimal PATH, and most CLI
// installers (nvm, bun, grok, ...) export PATH from ~/.zshrc, which only
// interactive shells source. Capture the interactive login shell's PATH once
// at startup so provider detection and agent runs can find the CLIs.
export const syncPathFromUserShell = async () => {
  if (process.platform === 'win32') {
    shellPathSynced = true;
    shellPathInteractiveSynced = true;
    return true;
  }
  lastShellPathSyncAttemptAt = Date.now();
  shellPathSyncInFlight = true;
  try {
    let shellPath = '';
    try {
      shellPath = await readShellPath('-ilc', 8000);
      if (shellPath) shellPathInteractiveSynced = true;
    } catch {
      // Interactive init files (e.g. a slow or broken ~/.zshrc) can fail or time
      // out; fall back once to a non-interactive login shell so ~/.zprofile /
      // Homebrew paths are still captured.
    }
    if (!shellPath) {
      shellPathInteractiveRetries += 1;
      try {
        shellPath = await readShellPath('-lc', 4000);
      } catch {
        // Keep the inherited PATH; a rate-limited retry runs on subsequent misses.
      }
    }
    if (!shellPath) return false;
    const merged = [
      ...new Set([...shellPath.split(':'), ...String(process.env.PATH || '').split(':')]),
    ]
      .filter(Boolean)
      .join(':');
    process.env.PATH = merged;
    shellPathSynced = true;
    return true;
  } finally {
    shellPathSyncInFlight = false;
  }
};

export const runShellCommand = async (command, timeout = 30000, env = {}) => {
  const { stdout, stderr } = await execFileAsync(loginShell, ['-lc', command], {
    timeout,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      ...env,
    },
    maxBuffer: 1024 * 1024 * 8,
  });
  return { stdout: stdout || '', stderr: stderr || '' };
};

export const COMMAND_PATH_CACHE_TTL_MS = 5 * 60 * 1000;
export const COMMAND_PATH_MISS_CACHE_TTL_MS = 5 * 1000;
export const commandPathCache = new Map();
export const commandPathPromises = new Map();
export const parseCommandPath = (stdout) => {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (path.isAbsolute(lines[index])) return lines[index];
  }
  return null;
};

const envValue = (env, name) => {
  if (!env || typeof env !== 'object') return undefined;
  if (name in env && env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
};

const isExecutableFile = async (filePath, platform = process.platform) => {
  try {
    await fs.access(filePath, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
};

const windowsPathExtensions = (env) =>
  String(envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);

// On Windows, global npm/pnpm/yarn/bun installs place an extensionless POSIX
// shell shim alongside `<cmd>.cmd`. Only files with a PATHEXT extension are
// runnable directly on Windows, matching where.exe / device-toolchain.js.
const windowsCandidates = (basePath, env) => {
  const extensions = windowsPathExtensions(env);
  const lower = basePath.toLowerCase();
  const hasKnownExt = extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
  if (hasKnownExt) return [basePath];
  const candidates = [];
  const seen = new Set();
  for (const ext of extensions) {
    for (const variant of [ext.toLowerCase(), ext]) {
      const candidate = `${basePath}${variant}`;
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    }
  }
  return candidates;
};

/**
 * Direct filesystem lookup against `env.PATH` (populated once at startup by
 * `syncPathFromUserShell`), avoiding spawning a login shell per CLI check.
 */
export const findExecutableInPath = async (
  command,
  env = process.env,
  platform = process.platform,
  checkExecutable = isExecutableFile
) => {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed || trimmed.includes('\0')) return null;

  const isWin = platform === 'win32';
  const pathMod = isWin ? path.win32 : path.posix;
  const hasSeparator = trimmed.includes('/') || (isWin && trimmed.includes('\\'));

  if (hasSeparator) {
    if (!pathMod.isAbsolute(trimmed)) return null;
    const candidates = isWin ? windowsCandidates(trimmed, env) : [trimmed];
    for (const candidate of candidates) {
      if (await checkExecutable(candidate, platform)) return candidate;
    }
    return null;
  }

  // Bare command names cannot contain whitespace; absolute paths (handled above) can.
  if (/\s/.test(trimmed)) return null;

  const rawPath = (isWin ? envValue(env, 'PATH') : env?.PATH) || '';
  const delimiter = isWin ? ';' : ':';
  const seen = new Set();
  for (const rawDir of String(rawPath).split(delimiter)) {
    const dir = isWin ? rawDir.trim().replace(/^"(.*)"$/, '$1') : rawDir;
    if (!dir || !pathMod.isAbsolute(dir) || seen.has(dir)) continue;
    seen.add(dir);
    const base = pathMod.join(dir, trimmed);
    const candidates = isWin ? windowsCandidates(base, env) : [base];
    for (const candidate of candidates) {
      if (await checkExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
};

export const resolveCommandPath = (command) => {
  const cached = commandPathCache.get(command);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.path);
  if (cached) commandPathCache.delete(command);

  const existing = commandPathPromises.get(command);
  if (existing) return existing;

  const epoch = commandPathCacheEpoch;
  const lookup = shellPathSyncPromise
    .then(async () => {
      const found = await findExecutableInPath(command);
      if (found) return found;
      // If another miss already kicked off a PATH resync, wait for it so
      // concurrent lookups don't cache false misses before PATH updates.
      if (shellPathSyncInFlight) {
        await shellPathSyncPromise;
        return findExecutableInPath(command);
      }
      // If startup login-shell sync failed or only captured `-lc`, retry once
      // per cooldown window (bounded for `-ilc`) so slow-boot machines recover.
      if (
        needsShellPathRetry() &&
        Date.now() - lastShellPathSyncAttemptAt >= SHELL_PATH_RETRY_COOLDOWN_MS
      ) {
        await startShellPathSync();
        return findExecutableInPath(command);
      }
      return null;
    })
    .catch(() => null);
  const sharedLookup = lookup
    .then((resolvedPath) => {
      if (epoch === commandPathCacheEpoch) {
        commandPathCache.set(command, {
          path: resolvedPath,
          expiresAt:
            Date.now() +
            (resolvedPath ? COMMAND_PATH_CACHE_TTL_MS : COMMAND_PATH_MISS_CACHE_TTL_MS),
        });
      }
      return resolvedPath;
    })
    .finally(() => {
      if (commandPathPromises.get(command) === sharedLookup) {
        commandPathPromises.delete(command);
      }
    });
  commandPathPromises.set(command, sharedLookup);
  return sharedLookup;
};

export const checkCommandAvailable = async (command) => Boolean(await resolveCommandPath(command));

export const startShellPathSync = () => {
  if (shellPathSyncInFlight) return shellPathSyncPromise;
  shellPathSyncPromise = syncPathFromUserShell();
  return shellPathSyncPromise;
};

export const resyncShellPath = async () => {
  commandPathCacheEpoch += 1;
  commandPathCache.clear();
  commandPathPromises.clear();
  await startShellPathSync();
  commandPathCacheEpoch += 1;
  commandPathCache.clear();
  commandPathPromises.clear();
};
