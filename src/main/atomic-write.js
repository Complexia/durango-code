import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const tempPathFor = (filePath) =>
  `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;

/**
 * Atomically writes `data` to `filePath` via a unique sibling temp file and
 * rename, ensuring the parent directory exists and cleaning up the temp file
 * on failure. When `mode` is provided (e.g. `0o600`), permissions are set on
 * the temp file before renaming over the target.
 */
export const writeFileAtomic = async (filePath, data, { encoding = 'utf8', mode } = {}) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = tempPathFor(filePath);
  const options = mode !== undefined ? { encoding, mode } : { encoding };
  try {
    await fs.writeFile(tempPath, data, options);
    if (mode !== undefined && process.platform !== 'win32') {
      await fs.chmod(tempPath, mode).catch(() => {});
    }
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
};

/**
 * Synchronous variant of `writeFileAtomic` for quit-time flushes and sync
 * persistence timers.
 */
export const writeFileAtomicSync = (filePath, data, { encoding = 'utf8', mode } = {}) => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = tempPathFor(filePath);
  const options = mode !== undefined ? { encoding, mode } : { encoding };
  try {
    writeFileSync(tempPath, data, options);
    if (mode !== undefined && process.platform !== 'win32') {
      try {
        chmodSync(tempPath, mode);
      } catch {}
    }
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {}
    throw error;
  }
};
