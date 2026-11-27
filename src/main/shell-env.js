import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const execFileAsync = promisify(execFile);
export const loginShell = process.env.SHELL || '/bin/zsh';
export let shellPathSyncPromise = Promise.resolve();
export const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const readShellPath = async (flags, timeout = 8000) => {
  const marker = '__ORION_PATH__';
  const { stdout } = await execFileAsync(
    loginShell,
    [flags, `printf "${marker}%s${marker}" "$PATH"`],
    { timeout, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } }
  );
  const match = stdout.match(/__ORION_PATH__([\s\S]*)__ORION_PATH__/);
  return match?.[1]?.trim() || '';
};

// Finder-launched apps inherit launchd's minimal PATH, and most CLI
// installers (nvm, bun, grok, ...) export PATH from ~/.zshrc, which only
// interactive shells source. Capture the interactive login shell's PATH once
// at startup so provider detection and agent runs can find the CLIs.
export const syncPathFromUserShell = async () => {
  if (process.platform === 'win32') return;
  let shellPath = '';
  try {
    shellPath = await readShellPath('-ilc', 8000);
  } catch {
    // Interactive init files (e.g. a slow or broken ~/.zshrc) can fail or time
    // out; fall back once to a non-interactive login shell so ~/.zprofile /
    // Homebrew paths are still captured.
  }
  if (!shellPath) {
    try {
      shellPath = await readShellPath('-lc', 4000);
    } catch {
      // Keep the inherited PATH; provider checks will report what they can see.
    }
  }
  if (!shellPath) return;
  const merged = [
    ...new Set([...shellPath.split(':'), ...String(process.env.PATH || '').split(':')]),
  ]
    .filter(Boolean)
    .join(':');
  process.env.PATH = merged;
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
  String(env?.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean);

const windowsCandidates = (basePath, env) => {
  const extensions = windowsPathExtensions(env);
  const lower = basePath.toLowerCase();
  const hasKnownExt = extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
  return hasKnownExt ? [basePath] : [basePath, ...extensions.map((ext) => `${basePath}${ext}`)];
};

/**
 * Direct filesystem lookup against `env.PATH` (populated once at startup by
 * `syncPathFromUserShell`), avoiding spawning a login shell per CLI check.
 */
export const findExecutableInPath = async (command, env = process.env, platform = process.platform) => {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed || /[\s\0]/.test(trimmed)) return null;

  const isWin = platform === 'win32';
  const pathMod = isWin ? path.win32 : path.posix;
  const hasSeparator = trimmed.includes('/') || (isWin && trimmed.includes('\\'));

  if (hasSeparator) {
    if (!pathMod.isAbsolute(trimmed)) return null;
    const candidates = isWin ? windowsCandidates(trimmed, env) : [trimmed];
    for (const candidate of candidates) {
      if (await isExecutableFile(candidate, platform)) return candidate;
    }
    return null;
  }

  const rawPath = env?.PATH || (isWin ? env?.Path : '') || '';
  const delimiter = isWin ? ';' : ':';
  const seen = new Set();
  for (const rawDir of String(rawPath).split(delimiter)) {
    const dir = isWin ? rawDir.trim().replace(/^"(.*)"$/, '$1') : rawDir;
    if (!dir || !pathMod.isAbsolute(dir) || seen.has(dir)) continue;
    seen.add(dir);
    const base = pathMod.join(dir, trimmed);
    const candidates = isWin ? windowsCandidates(base, env) : [base];
    for (const candidate of candidates) {
      if (await isExecutableFile(candidate, platform)) return candidate;
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

  const lookup = shellPathSyncPromise
    .then(() => findExecutableInPath(command))
    .catch(() => null);
  const sharedLookup = lookup
    .then((resolvedPath) => {
      commandPathCache.set(command, {
        path: resolvedPath,
        expiresAt:
          Date.now() +
          (resolvedPath ? COMMAND_PATH_CACHE_TTL_MS : COMMAND_PATH_MISS_CACHE_TTL_MS),
      });
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
  shellPathSyncPromise = syncPathFromUserShell();
  return shellPathSyncPromise;
};
