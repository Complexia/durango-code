import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const UNSUPPORTED_CHMOD_CODES = new Set(['ENOTSUP', 'ENOSYS', 'EROFS']);
const WIN_RENAME_MAX_ATTEMPTS = 5;
const WIN_RENAME_BASE_DELAY_MS = 15;

const tempPathFor = (filePath) =>
  `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const syncPause = (ms) => {
  try {
    const view = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(view, 0, 0, ms);
  } catch {
    // Fallback when SharedArrayBuffer is unavailable: retry immediately.
  }
};

const renameWithRetry = async (
  fromPath,
  toPath,
  { platform = process.platform, renameImpl = fs.rename, sleepImpl = defaultSleep } = {}
) => {
  const maxAttempts = platform === 'win32' ? WIN_RENAME_MAX_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameImpl(fromPath, toPath);
      return;
    } catch (error) {
      if (attempt >= maxAttempts || !RETRYABLE_RENAME_CODES.has(error?.code)) throw error;
      await sleepImpl(WIN_RENAME_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
};

const renameSyncWithRetry = (
  fromPath,
  toPath,
  { platform = process.platform, renameImpl = renameSync, pauseImpl = syncPause } = {}
) => {
  const maxAttempts = platform === 'win32' ? WIN_RENAME_MAX_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameImpl(fromPath, toPath);
      return;
    } catch (error) {
      if (attempt >= maxAttempts || !RETRYABLE_RENAME_CODES.has(error?.code)) throw error;
      pauseImpl(WIN_RENAME_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
};

/**
 * Atomically writes `data` to `filePath` via an exclusively-created (`wx`)
 * sibling temp file and rename, ensuring the parent directory exists and
 * cleaning up the temp file on failure.
 *
 * Options:
 * - `encoding`: text encoding (default `'utf8'`).
 * - `mode`: POSIX permission mode (e.g. `0o600`), enforced via `fchmod` on the
 *   temp file before renaming over the target.
 * - `durable`: call `fsync` on the temp file before closing and renaming.
 */
export const writeFileAtomic = async (
  filePath,
  data,
  { encoding = 'utf8', mode, durable = false, platform = process.platform, renameImpl = fs.rename, sleepImpl = defaultSleep } = {}
) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = tempPathFor(filePath);
  let handle = null;
  try {
    handle = await fs.open(tempPath, 'wx', mode);
    try {
      await handle.writeFile(data, { encoding });
      if (mode !== undefined && platform !== 'win32') {
        try {
          await handle.chmod(mode);
        } catch (error) {
          if (!UNSUPPORTED_CHMOD_CODES.has(error?.code)) throw error;
        }
      }
      if (durable) {
        await handle.sync();
      }
    } finally {
      await handle.close();
      handle = null;
    }
    await renameWithRetry(tempPath, filePath, { platform, renameImpl, sleepImpl });
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
};

/**
 * Synchronous variant of `writeFileAtomic` for quit-time flushes and sync
 * persistence timers.
 */
export const writeFileAtomicSync = (
  filePath,
  data,
  { encoding = 'utf8', mode, durable = false, platform = process.platform, renameImpl = renameSync, pauseImpl = syncPause } = {}
) => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = tempPathFor(filePath);
  let fd = null;
  try {
    fd = openSync(tempPath, 'wx', mode);
    try {
      writeFileSync(fd, data, { encoding });
      if (mode !== undefined && platform !== 'win32') {
        try {
          fchmodSync(fd, mode);
        } catch (error) {
          if (!UNSUPPORTED_CHMOD_CODES.has(error?.code)) throw error;
        }
      }
      if (durable) {
        fsyncSync(fd);
      }
    } finally {
      closeSync(fd);
      fd = null;
    }
    renameSyncWithRetry(tempPath, filePath, { platform, renameImpl, pauseImpl });
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      rmSync(tempPath, { force: true });
    } catch {}
    throw error;
  }
};
