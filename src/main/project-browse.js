import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Folder browsing for the project picker's "Add project" view: the renderer
// types a path (`~/projects/`), this lists the directories in it, and adding
// resolves the typed path to an absolute folder (creating it on request).

const expandHome = (value, homeDir) => {
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2));
  return value;
};

/**
 * Lists the directories inside `requestedPath` (a directory path, usually
 * with a trailing `/`). Unreadable or missing directories list as empty with
 * `exists: false` rather than throwing.
 */
export const browseDirectories = async (requestedPath) => {
  const homeDir = os.homedir();
  const requested = typeof requestedPath === 'string' && requestedPath ? requestedPath : '~/';
  const expanded = expandHome(requested, homeDir);
  const directory = path.resolve(expanded);
  const directoryPath = directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`;
  const parent = path.dirname(directory);
  const base = { requestedPath: requested, homeDir, directoryPath, parentPath: parent === directory ? null : parent };
  let dirents;
  try {
    dirents = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return { ...base, exists: false, entries: [] };
  }
  const entries = [];
  await Promise.all(
    dirents.map(async (dirent) => {
      const fullPath = path.join(directory, dirent.name);
      let isDirectory = dirent.isDirectory();
      if (!isDirectory && dirent.isSymbolicLink()) {
        isDirectory = await fs
          .stat(fullPath)
          .then((stat) => stat.isDirectory())
          .catch(() => false);
      }
      if (isDirectory) entries.push({ name: dirent.name, fullPath });
    })
  );
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  return { ...base, exists: true, entries };
};

/**
 * Resolves a typed project path to an absolute directory. A missing folder is
 * created when `create` is set; a path that exists but isn't a directory is
 * refused.
 */
export const resolveProjectDirectory = async (inputPath, { create = false } = {}) => {
  if (typeof inputPath !== 'string' || !inputPath.trim()) return { ok: false, error: 'Enter a folder path' };
  const resolved = path.resolve(expandHome(inputPath.trim(), os.homedir()));
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) return { ok: false, error: `${resolved} is a file, not a folder` };
    return { ok: true, path: resolved, created: false };
  } catch (error) {
    if (error?.code !== 'ENOENT') return { ok: false, error: error?.message ?? String(error) };
  }
  if (!create) return { ok: false, error: `${resolved} doesn’t exist` };
  try {
    await fs.mkdir(resolved, { recursive: true });
    return { ok: true, path: resolved, created: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
};
