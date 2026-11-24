import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Antigravity on-disk session file inspection & cleanup.
// Verifies workspace ownership via `<sessionId>.meta` or the protobuf
// `trajectory_metadata_blob` inside `conversations/<sessionId>.db` before
// removing any session files, using symlink-safe path checks throughout.

export const TRAJECTORY_WORKSPACES = 1;
export const WORKSPACE_URI = 1;
export const TRAJECTORY_SESSION_ID = 6;
export const TRAJECTORY_WORKSPACE_URIS = 7;

const SESSION_ID = /^[\w-]+$/;
const META_MAX_BYTES = 2 * 1024 * 1024;

export const antigravityCliHome = () => path.join(os.homedir(), '.gemini', 'antigravity-cli');

const isSafeSegment = (segment) =>
  typeof segment === 'string' &&
  segment.length > 0 &&
  segment !== '.' &&
  segment !== '..' &&
  !segment.includes('/') &&
  !segment.includes('\\') &&
  !segment.includes('\0');

/**
 * Minimal protobuf wire reader that extracts all length-delimited (wire type 2)
 * fields as a Map<fieldNumber, Uint8Array[]>. Safely skips varint/fixed fields
 * and stops on truncated or malformed input without throwing.
 */
export const protoFields = (input) => {
  const fields = new Map();
  if (!input) return fields;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let offset = 0;

  const readVarint = () => {
    let result = 0;
    let multiplier = 1;
    let count = 0;
    while (offset < bytes.length && count < 10) {
      const byte = bytes[offset++];
      result += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return result;
      multiplier *= 128;
      count += 1;
    }
    return null;
  };

  while (offset < bytes.length) {
    const tag = readVarint();
    if (tag === null || tag <= 0) break;
    const wireType = tag & 7;
    const fieldNumber = Math.floor(tag / 8);
    if (fieldNumber <= 0) break;

    if (wireType === 0) {
      if (readVarint() === null) break;
    } else if (wireType === 1) {
      if (offset + 8 > bytes.length) break;
      offset += 8;
    } else if (wireType === 2) {
      const length = readVarint();
      if (length === null || length < 0 || offset + length > bytes.length) break;
      const slice = bytes.subarray(offset, offset + length);
      offset += length;
      let list = fields.get(fieldNumber);
      if (!list) {
        list = [];
        fields.set(fieldNumber, list);
      }
      list.push(slice);
    } else if (wireType === 5) {
      if (offset + 4 > bytes.length) break;
      offset += 4;
    } else {
      break;
    }
  }

  return fields;
};

const utf8Decoder = new TextDecoder();

const workspaceUriToPath = (raw) => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      try {
        return decodeURIComponent(trimmed.replace(/^file:\/\//i, ''));
      } catch {
        return null;
      }
    }
  }
  return trimmed;
};

/** Decodes `trajectory_metadata_blob` bytes into `{ sessionId, workspaceUris, workspacePaths }`. */
export const decodeTrajectoryMetadata = (bytes) => {
  const fields = protoFields(bytes);
  const sessionBytes = fields.get(TRAJECTORY_SESSION_ID)?.[0];
  const sessionId = sessionBytes ? utf8Decoder.decode(sessionBytes).trim() || null : null;

  const uriSet = new Set();
  for (const wsBytes of fields.get(TRAJECTORY_WORKSPACES) ?? []) {
    const wsFields = protoFields(wsBytes);
    for (const uriBytes of wsFields.get(WORKSPACE_URI) ?? []) {
      const uri = utf8Decoder.decode(uriBytes).trim();
      if (uri) uriSet.add(uri);
    }
  }
  for (const uriBytes of fields.get(TRAJECTORY_WORKSPACE_URIS) ?? []) {
    const uri = utf8Decoder.decode(uriBytes).trim();
    if (uri) uriSet.add(uri);
  }

  const workspaceUris = [...uriSet];
  const workspacePaths = workspaceUris.map(workspaceUriToPath).filter(Boolean);
  return { sessionId, workspaceUris, workspacePaths };
};

// Canonicalizes an existing OR deleted path by resolving the deepest existing
// ancestor with `realpathSync` and appending the missing relative suffix.
const canonicalizePath = (targetPath) => {
  const resolved = path.resolve(targetPath);
  let ancestor = resolved;
  while (true) {
    try {
      const realAncestor = fs.realpathSync(ancestor);
      const suffix = path.relative(ancestor, resolved);
      return suffix ? path.resolve(realAncestor, suffix) : realAncestor;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return resolved;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return resolved;
      ancestor = parent;
    }
  }
};

const normalizeForCompare = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

const samePath = (a, b) => normalizeForCompare(canonicalizePath(a)) === normalizeForCompare(canonicalizePath(b));

const resolveSafeCliHome = (cliHome) => {
  if (cliHome) {
    try {
      const stat = fs.lstatSync(cliHome);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
      return fs.realpathSync(cliHome);
    } catch {
      return null;
    }
  }
  let realHome;
  try {
    realHome = fs.realpathSync(os.homedir());
  } catch {
    return null;
  }
  let current = realHome;
  for (const segment of ['.gemini', 'antigravity-cli']) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    } catch {
      return null;
    }
  }
  try {
    const realTarget = fs.realpathSync(current);
    return realTarget === current ? realTarget : null;
  } catch {
    return null;
  }
};

const resolveSafeManagedPath = (realCliHome, segments, expectedType) => {
  if (!realCliHome) return null;
  let current = realCliHome;
  let stat = null;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!isSafeSegment(segment)) return null;
    current = path.join(current, segment);
    try {
      stat = fs.lstatSync(current);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return null;
    const isLeaf = index === segments.length - 1;
    if (isLeaf) {
      if (expectedType === 'file' && !stat.isFile()) return null;
      if (expectedType === 'dir' && !stat.isDirectory()) return null;
    } else if (!stat.isDirectory()) {
      return null;
    }
  }
  try {
    const realTarget = fs.realpathSync(current);
    return realTarget === current ? { path: realTarget, stat } : null;
  } catch {
    return null;
  }
};

let sqliteModule;
const loadSqlite = async () => {
  if (sqliteModule === undefined) {
    try {
      sqliteModule = await import('node:sqlite');
    } catch {
      sqliteModule = null;
    }
  }
  return sqliteModule;
};

const extractWorkspacePathsFromMetaJson = (parsed) => {
  if (!parsed || typeof parsed !== 'object') return [];
  const raw = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) raw.push(value.trim());
  };
  push(parsed.cwd);
  push(parsed.workspace);
  push(parsed.workspaceUri);
  push(parsed.workspace_uri);
  push(parsed.workspacePath);
  push(parsed.workspace_path);
  for (const key of ['workspaceUris', 'workspace_uris', 'workspacePaths', 'workspace_paths']) {
    if (Array.isArray(parsed[key])) {
      for (const item of parsed[key]) push(item);
    }
  }
  if (Array.isArray(parsed.workspaces)) {
    for (const item of parsed.workspaces) {
      if (typeof item === 'string') push(item);
      else if (item && typeof item === 'object') {
        push(item.uri);
        push(item.workspaceUri);
        push(item.workspace_uri);
        push(item.path);
        push(item.workspacePath);
        push(item.workspace_path);
        push(item.cwd);
      }
    }
  }
  return raw.map(workspaceUriToPath).filter(Boolean);
};

const readSessionWorkspacesFromMeta = (realCliHome, sessionId) => {
  const resolved = resolveSafeManagedPath(realCliHome, ['conversations', `${sessionId}.meta`], 'file');
  if (!resolved || resolved.stat.size > META_MAX_BYTES) return [];
  let bytes;
  try {
    bytes = fs.readFileSync(resolved.path);
  } catch {
    return [];
  }
  const text = bytes.toString('utf8').trim();
  if (text.startsWith('{')) {
    try {
      return extractWorkspacePathsFromMetaJson(JSON.parse(text));
    } catch {}
  }
  return decodeTrajectoryMetadata(bytes).workspacePaths;
};

const readSessionWorkspacesFromDb = async (realCliHome, sessionId) => {
  const sqlite = await loadSqlite();
  if (!sqlite) return [];
  const resolved = resolveSafeManagedPath(realCliHome, ['conversations', `${sessionId}.db`], 'file');
  if (!resolved) return [];
  let database = null;
  try {
    database = new sqlite.DatabaseSync(resolved.path, { readOnly: true });
    const afterStat = fs.lstatSync(resolved.path);
    if (
      afterStat.isSymbolicLink() ||
      !afterStat.isFile() ||
      afterStat.dev !== resolved.stat.dev ||
      afterStat.ino !== resolved.stat.ino
    ) {
      return [];
    }
    database.exec('PRAGMA busy_timeout = 100');
    const hasTable = database
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'trajectory_metadata_blob'")
      .get();
    if (!hasTable) return [];
    const row =
      database.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1").get() ??
      database.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
    if (!row?.data) return [];
    return decodeTrajectoryMetadata(row.data).workspacePaths;
  } catch {
    return [];
  } finally {
    try {
      database?.close();
    } catch {}
  }
};

const readSessionWorkspacePaths = async (realCliHome, sessionId) => {
  const combined = new Map();
  const add = (wsPath) => {
    const canonical = canonicalizePath(wsPath);
    const key = normalizeForCompare(canonical);
    if (!combined.has(key)) combined.set(key, canonical);
  };
  for (const wsPath of readSessionWorkspacesFromMeta(realCliHome, sessionId)) add(wsPath);
  for (const wsPath of await readSessionWorkspacesFromDb(realCliHome, sessionId)) add(wsPath);
  return [...combined.values()];
};

const measurePathBytesNoFollow = (targetPath) => {
  let stat;
  try {
    stat = fs.lstatSync(targetPath);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(targetPath);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    total += measurePathBytesNoFollow(path.join(targetPath, entry));
  }
  return total;
};

const unlinkSafeManagedTargets = (realCliHome, sessionId) => {
  let removedAny = false;
  let bytesFreed = 0;

  const fileTargets = [
    ['conversations', `${sessionId}.db`],
    ['conversations', `${sessionId}.db-wal`],
    ['conversations', `${sessionId}.db-shm`],
    ['conversations', `${sessionId}.db-journal`],
    ['conversations', `${sessionId}.meta`],
    ['annotations', `${sessionId}.pbtxt`],
  ];

  for (const segments of fileTargets) {
    const resolved = resolveSafeManagedPath(realCliHome, segments, 'file');
    if (!resolved) continue;
    const size = resolved.stat.size;
    try {
      fs.unlinkSync(resolved.path);
      removedAny = true;
      bytesFreed += size;
    } catch {}
  }

  const brainDir = resolveSafeManagedPath(realCliHome, ['brain', sessionId], 'dir');
  if (brainDir) {
    const size = measurePathBytesNoFollow(brainDir.path);
    try {
      fs.rmSync(brainDir.path, { recursive: true, force: true });
      removedAny = true;
      bytesFreed += size;
    } catch {}
  }

  return { removed: removedAny, bytesFreed };
};

/**
 * Verifies that `sessionId` belongs to `cwd` via `<sessionId>.meta` or
 * `trajectory_metadata_blob` in `<sessionId>.db` (symlink-safe), then deletes
 * all session files (`.db*`, `.meta`, `brain/<id>`, `annotations/<id>.pbtxt`).
 */
export const removeAntigravitySessionFiles = async ({ sessionId, cwd, cliHome } = {}) => {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    return { removed: false, bytesFreed: 0 };
  }
  if (typeof cwd !== 'string' || !cwd.trim()) {
    return { removed: false, bytesFreed: 0 };
  }
  const realCliHome = resolveSafeCliHome(cliHome);
  if (!realCliHome) return { removed: false, bytesFreed: 0 };

  const workspacePaths = await readSessionWorkspacePaths(realCliHome, sessionId);
  if (!workspacePaths.length) return { removed: false, bytesFreed: 0 };
  if (!workspacePaths.every((wsPath) => samePath(wsPath, cwd))) {
    return { removed: false, bytesFreed: 0 };
  }

  return unlinkSafeManagedTargets(realCliHome, sessionId);
};

const tempRootPrefixes = () => {
  const candidates = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', os.tmpdir()];
  const roots = new Set();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    roots.add(normalizeForCompare(resolved));
    roots.add(normalizeForCompare(canonicalizePath(resolved)));
  }
  return [...roots].map((root) => (root.endsWith(path.sep) ? root : `${root}${path.sep}`));
};

const isInsideTempDir = (targetPath, prefixes) => {
  const canonical = normalizeForCompare(canonicalizePath(targetPath));
  const resolved = normalizeForCompare(path.resolve(targetPath));
  return prefixes.some(
    (prefix) =>
      (canonical.startsWith(prefix) && canonical.length > prefix.length) ||
      (resolved.startsWith(prefix) && resolved.length > prefix.length)
  );
};

const pathExistsOnDisk = (targetPath) => {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch (error) {
    return error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR';
  }
};

export const DURANGO_ANTIGRAVITY_TEMP_PREFIXES = [
  'durango-agy-oneshot-',
  'durango-agy-models-',
];

const hasOwnedTempBasename = (targetPath, ownedPrefixes) => {
  if (!ownedPrefixes || ownedPrefixes.length === 0) return true;
  const base = path.basename(targetPath);
  return ownedPrefixes.some((prefix) => base.startsWith(prefix));
};

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Sweeps orphaned Durango-created temporary Antigravity sessions whose ALL
 * workspace paths live inside OS temp directories, match Durango's own temp
 * prefixes (`durango-agy-oneshot-`, `durango-agy-models-`), and no longer
 * exist on disk. Yields between entries so startup never blocks Electron.
 */
export const sweepOrphanAntigravityTempSessions = async ({
  cliHome,
  excludeSessionIds,
  ownedPrefixes = DURANGO_ANTIGRAVITY_TEMP_PREFIXES,
} = {}) => {
  const realCliHome = resolveSafeCliHome(cliHome);
  if (!realCliHome) return { removed: [], bytesFreed: 0 };

  const conversationsDir = resolveSafeManagedPath(realCliHome, ['conversations'], 'dir');
  if (!conversationsDir) return { removed: [], bytesFreed: 0 };

  const excluded = new Set(excludeSessionIds ? [...excludeSessionIds] : []);
  const prefixes = tempRootPrefixes();
  const removed = [];
  let bytesFreed = 0;

  let entries;
  try {
    entries = fs.readdirSync(conversationsDir.path);
  } catch {
    return { removed: [], bytesFreed: 0 };
  }

  let processed = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.db')) continue;
    const sessionId = entry.slice(0, -'.db'.length);
    if (!SESSION_ID.test(sessionId) || excluded.has(sessionId)) continue;

    processed += 1;
    if (processed % 4 === 0) await yieldToEventLoop();

    // Skip symlinked or non-regular DB files.
    const dbTarget = resolveSafeManagedPath(realCliHome, ['conversations', entry], 'file');
    if (!dbTarget) continue;

    const workspacePaths = await readSessionWorkspacePaths(realCliHome, sessionId);
    if (!workspacePaths.length) continue;

    const allOrphanTemp = workspacePaths.every(
      (wsPath) =>
        isInsideTempDir(wsPath, prefixes) &&
        hasOwnedTempBasename(wsPath, ownedPrefixes) &&
        !pathExistsOnDisk(wsPath)
    );
    if (!allOrphanTemp) continue;

    const outcome = unlinkSafeManagedTargets(realCliHome, sessionId);
    if (outcome.removed) {
      removed.push(sessionId);
      bytesFreed += outcome.bytesFreed;
    }
  }

  return { removed, bytesFreed };
};
