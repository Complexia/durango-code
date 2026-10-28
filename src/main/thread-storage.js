import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { getThreadsDirectoryPath, getThreadsFilePath } from './paths.js';

const MANIFEST_VERSION = 2;
const MANIFEST_FILE = 'manifest.json';
const LEGACY_BACKUP_FILE = 'orion-threads.v1-backup.json';
const DEFAULT_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_REQUESTED_PAGE_BYTES = 8 * 1024 * 1024;
const PAGE_ENVELOPE_BYTES = 512;
let initializingStorage = false;

const threadFileName = (id, hash) =>
  `${Buffer.from(id, 'utf8').toString('base64url')}.${hash}.json`;
const manifestPath = (directory = getThreadsDirectoryPath()) => path.join(directory, MANIFEST_FILE);
const threadPath = (id, hash, directory = getThreadsDirectoryPath()) =>
  path.join(directory, threadFileName(id, hash));
const backupPath = () => path.join(path.dirname(getThreadsFilePath()), LEGACY_BACKUP_FILE);

const assertThread = (thread) => {
  if (!thread || typeof thread !== 'object' || Array.isArray(thread) || typeof thread.id !== 'string' || !thread.id) {
    throw new Error('Invalid persisted thread.');
  }
  return thread;
};

const metadataFor = (thread, serialized = JSON.stringify(thread)) => ({
  id: thread.id,
  hash: crypto.createHash('sha256').update(serialized).digest('hex'),
  projectId: typeof thread.projectId === 'string' ? thread.projectId : null,
  parentThreadId: typeof thread.parentThreadId === 'string' ? thread.parentThreadId : null,
  subagent: thread.subagent === true,
  title: typeof thread.title === 'string' ? thread.title : '',
  status: typeof thread.status === 'string' ? thread.status : null,
  modelId: typeof thread.modelId === 'string' ? thread.modelId : null,
  createdAt: thread.createdAt ?? null,
  updatedAt: Array.isArray(thread.messages) ? thread.messages.at(-1)?.ts ?? thread.createdAt ?? null : thread.createdAt ?? null,
  messageCount: Array.isArray(thread.messages) ? thread.messages.length : 0,
});

const parseManifest = (value) => {
  const manifest = JSON.parse(value);
  if (manifest?.version !== MANIFEST_VERSION || !Array.isArray(manifest.entries)) {
    throw new Error('Invalid Orion threads manifest.');
  }
  const ids = new Set();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) {
      throw new Error('Invalid Orion threads manifest entry.');
    }
    ids.add(entry.id);
  }
  return manifest;
};

const emptyManifest = () => ({ version: MANIFEST_VERSION, revision: 0, entries: [] });

const writeAtomic = async (filePath, value, suffix = 'tmp') => {
  const tempPath = `${filePath}.${process.pid}.${suffix}`;
  await fs.writeFile(tempPath, value, 'utf8');
  await fs.rename(tempPath, filePath);
};

const writeAtomicSync = (filePath, value, suffix = 'sync.tmp') => {
  const tempPath = `${filePath}.${process.pid}.${suffix}`;
  writeFileSync(tempPath, value, 'utf8');
  renameSync(tempPath, filePath);
};

const migrateLegacy = async () => {
  const legacyPath = getThreadsFilePath();
  let value;
  try {
    value = await fs.readFile(legacyPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed?.threads)) throw new Error('Legacy transcript file does not contain a threads array.');

  const directory = getThreadsDirectoryPath();
  const staging = `${directory}.migrating-${process.pid}-${Date.now()}`;
  await fs.mkdir(staging, { recursive: false });
  try {
    const entries = [];
    const ids = new Set();
    for (const candidate of parsed.threads) {
      const thread = assertThread(candidate);
      if (ids.has(thread.id)) throw new Error('Legacy transcript file contains duplicate thread ids.');
      ids.add(thread.id);
      const serialized = JSON.stringify(thread);
      const metadata = metadataFor(thread, serialized);
      await fs.writeFile(threadPath(thread.id, metadata.hash, staging), serialized, 'utf8');
      entries.push(metadata);
    }
    const manifest = { version: MANIFEST_VERSION, revision: 1, entries };
    await fs.writeFile(manifestPath(staging), JSON.stringify(manifest), 'utf8');
    await fs.rename(staging, directory);
    try {
      await fs.rename(legacyPath, backupPath());
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EEXIST') {
        console.warn('Could not archive legacy Orion threads file', error);
      }
    }
    return manifest;
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
};

const migrateLegacySync = () => {
  const legacyPath = getThreadsFilePath();
  if (!existsSync(legacyPath)) return null;
  const parsed = JSON.parse(readFileSync(legacyPath, 'utf8'));
  if (!Array.isArray(parsed?.threads)) throw new Error('Legacy transcript file does not contain a threads array.');

  const directory = getThreadsDirectoryPath();
  const staging = `${directory}.migrating-${process.pid}-${Date.now()}`;
  mkdirSync(staging, { recursive: false });
  try {
    const entries = [];
    const ids = new Set();
    for (const candidate of parsed.threads) {
      const thread = assertThread(candidate);
      if (ids.has(thread.id)) throw new Error('Legacy transcript file contains duplicate thread ids.');
      ids.add(thread.id);
      const serialized = JSON.stringify(thread);
      const metadata = metadataFor(thread, serialized);
      writeFileSync(threadPath(thread.id, metadata.hash, staging), serialized, 'utf8');
      entries.push(metadata);
    }
    const manifest = { version: MANIFEST_VERSION, revision: 1, entries };
    writeFileSync(manifestPath(staging), JSON.stringify(manifest), 'utf8');
    renameSync(staging, directory);
    try {
      renameSync(legacyPath, backupPath());
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EEXIST') {
        console.warn('Could not archive legacy Orion threads file', error);
      }
    }
    return manifest;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
};

const ensureManifest = async ({ create = false } = {}) => {
  try {
    return parseManifest(await fs.readFile(manifestPath(), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // A v2 directory without its commit-point manifest is an interrupted or
  // damaged write. Never treat it as an empty workspace and overwrite the
  // still-recoverable transcript files inside it.
  if (existsSync(getThreadsDirectoryPath())) {
    if (create && initializingStorage) return emptyManifest();
    throw new Error('Orion threads directory is missing its manifest.');
  }
  const migrated = await migrateLegacy();
  if (migrated) return migrated;
  if (!create) return null;
  const manifest = emptyManifest();
  initializingStorage = true;
  await fs.mkdir(getThreadsDirectoryPath(), { recursive: true });
  return manifest;
};

const ensureManifestSync = ({ create = false } = {}) => {
  try {
    return parseManifest(readFileSync(manifestPath(), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existsSync(getThreadsDirectoryPath())) {
    if (create && initializingStorage) return emptyManifest();
    throw new Error('Orion threads directory is missing its manifest.');
  }
  const migrated = migrateLegacySync();
  if (migrated) return migrated;
  if (!create) return null;
  const manifest = emptyManifest();
  initializingStorage = true;
  mkdirSync(getThreadsDirectoryPath(), { recursive: true });
  return manifest;
};

const normalizePatch = (patch) => {
  if (!patch || typeof patch !== 'object' || patch.version !== MANIFEST_VERSION) {
    throw new Error('Invalid Orion threads patch.');
  }
  const upserts = Array.isArray(patch.upserts) ? patch.upserts.map(assertThread) : [];
  const upsertIds = new Set(upserts.map((thread) => thread.id));
  const deletes = Array.isArray(patch.deletes)
    ? patch.deletes.filter((id) => typeof id === 'string' && id)
    : [];
  const order = Array.isArray(patch.order)
    ? patch.order.filter((id) => typeof id === 'string' && id)
    : null;
  return { upserts, deletes: deletes.filter((id) => !upsertIds.has(id)), order };
};

const nextManifest = (manifest, normalized, metadata) => {
  const byId = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  for (const id of normalized.deletes) byId.delete(id);
  for (const entry of metadata) byId.set(entry.id, entry);
  const ordered = [];
  const included = new Set();
  for (const id of normalized.order ?? manifest.entries.map((entry) => entry.id)) {
    const entry = byId.get(id);
    if (entry && !included.has(id)) {
      ordered.push(entry);
      included.add(id);
    }
  }
  for (const [id, entry] of byId) {
    if (!included.has(id)) ordered.push(entry);
  }
  return { version: MANIFEST_VERSION, revision: (manifest.revision ?? 0) + 1, entries: ordered };
};

const scheduleVersionCleanup = (previous, updated) => {
  const currentVersions = new Map(updated.entries.map((entry) => [entry.id, entry.hash]));
  const retired = previous.entries.filter(
    (entry) => currentVersions.get(entry.id) !== entry.hash
  );
  if (retired.length === 0) return;
  const timer = setTimeout(async () => {
    try {
      const latest = await ensureManifest();
      const liveVersions = new Map((latest?.entries ?? []).map((entry) => [entry.id, entry.hash]));
      await Promise.all(
        retired.map((entry) =>
          liveVersions.get(entry.id) === entry.hash
            ? undefined
            : fs.rm(threadPath(entry.id, entry.hash), { force: true })
        )
      );
    } catch {}
  }, 1000);
  timer.unref?.();
};

export const readThreadsIndex = async () => (await ensureManifest()) ?? emptyManifest();

const readEntry = async (entry) => {
  const readVersion = async (candidate) => {
    const value = await fs.readFile(threadPath(candidate.id, candidate.hash), 'utf8');
    const actualHash = crypto.createHash('sha256').update(value).digest('hex');
    if (actualHash !== candidate.hash) throw new Error(`Stored Orion thread ${candidate.id} failed its checksum.`);
    return assertThread(JSON.parse(value));
  };
  try {
    return await readVersion(entry);
  } catch (error) {
    // A reader can take the old manifest immediately before a writer commits
    // the new one and removes the old immutable version. Retry through the
    // current manifest instead of surfacing a transient ENOENT.
    if (error?.code !== 'ENOENT') throw error;
    const current = await ensureManifest();
    const replacement = current?.entries.find((candidate) => candidate.id === entry.id);
    if (!replacement || replacement.hash === entry.hash) throw error;
    return readVersion(replacement);
  }
};

export const readThreadById = async (id) => {
  const manifest = await ensureManifest();
  const entry = manifest?.entries.find((candidate) => candidate.id === id);
  if (!entry) return null;
  return readEntry(entry);
};

export const readThreadsByIds = async (ids) => {
  const manifest = await ensureManifest();
  if (!manifest) return [];
  const available = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const threads = [];
  for (const id of ids) {
    const entry = available.get(id);
    if (!entry) continue;
    threads.push(await readEntry(entry));
  }
  return threads;
};

export const readAllThreads = async () => {
  const manifest = await ensureManifest();
  if (!manifest) return null;
  const threads = [];
  for (const entry of manifest.entries) {
    threads.push(await readEntry(entry));
  }
  return threads;
};

// Startup hydration deliberately reads bounded pages. Returning the entire
// transcript corpus through one IPC response caused Electron's main process
// to retain multi-gigabyte PartitionAlloc/Mojo regions after deserializing a
// comparatively modest history file.
export const readThreadsPage = async ({ offset = 0, revision, maxBytes = DEFAULT_PAGE_BYTES } = {}) => {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid Orion threads page offset.');
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) {
    throw new Error('Invalid Orion threads page revision.');
  }
  const requestedBytes = Number.isFinite(maxBytes) ? Math.trunc(maxBytes) : DEFAULT_PAGE_BYTES;
  const pageBytes = Math.min(Math.max(requestedBytes, PAGE_ENVELOPE_BYTES * 2), MAX_REQUESTED_PAGE_BYTES);
  const manifest = await ensureManifest();
  if (!manifest) {
    return {
      version: MANIFEST_VERSION,
      present: false,
      stale: false,
      revision: 0,
      offset: 0,
      total: 0,
      threads: [],
      nextOffset: null,
    };
  }

  const manifestRevision = manifest.revision ?? 0;
  if (revision !== undefined && revision !== manifestRevision) {
    return {
      version: MANIFEST_VERSION,
      present: true,
      stale: true,
      revision: manifestRevision,
      offset: 0,
      total: manifest.entries.length,
      threads: [],
      nextOffset: 0,
    };
  }
  if (offset > manifest.entries.length) throw new Error('Invalid Orion threads page offset.');

  const threads = [];
  const contentBudget = pageBytes - PAGE_ENVELOPE_BYTES;
  let contentBytes = 0;
  let cursor = offset;
  while (cursor < manifest.entries.length) {
    const thread = await readEntry(manifest.entries[cursor]);
    const threadBytes = Buffer.byteLength(JSON.stringify(thread), 'utf8');
    const separatorBytes = threads.length > 0 ? 1 : 0;
    if (threads.length > 0 && contentBytes + separatorBytes + threadBytes > contentBudget) break;
    // An individual transcript can exceed the target. Return it alone rather
    // than making one large agent response prevent every transcript from
    // hydrating; the response is still bounded by one record, never the corpus.
    threads.push(thread);
    contentBytes += separatorBytes + threadBytes;
    cursor += 1;
  }

  // A write may commit while this page is being read. Never return a page
  // labelled with the old revision if any entry could have been replaced.
  const latest = await ensureManifest();
  const latestRevision = latest?.revision ?? 0;
  if (!latest || latestRevision !== manifestRevision) {
    return {
      version: MANIFEST_VERSION,
      present: Boolean(latest),
      stale: true,
      revision: latestRevision,
      offset: 0,
      total: latest?.entries.length ?? 0,
      threads: [],
      nextOffset: 0,
    };
  }

  return {
    version: MANIFEST_VERSION,
    present: true,
    stale: false,
    revision: manifestRevision,
    offset,
    total: manifest.entries.length,
    threads,
    nextOffset: cursor < manifest.entries.length ? cursor : null,
  };
};

export const writeThreadsPatch = async (patch) => {
  const normalized = normalizePatch(patch);
  const manifest = await ensureManifest({ create: true });
  const metadata = [];
  for (const thread of normalized.upserts) {
    const serialized = JSON.stringify(thread);
    const entry = metadataFor(thread, serialized);
    const filePath = threadPath(thread.id, entry.hash);
    await writeAtomic(filePath, serialized, 'thread.tmp');
    metadata.push(entry);
  }
  const updated = nextManifest(manifest, normalized, metadata);
  await writeAtomic(manifestPath(), JSON.stringify(updated), 'manifest.tmp');
  initializingStorage = false;
  scheduleVersionCleanup(manifest, updated);
  return updated;
};

export const writeThreadsPatchSync = (patch) => {
  const normalized = normalizePatch(patch);
  const manifest = ensureManifestSync({ create: true });
  const metadata = [];
  for (const thread of normalized.upserts) {
    const serialized = JSON.stringify(thread);
    const entry = metadataFor(thread, serialized);
    const filePath = threadPath(thread.id, entry.hash);
    writeAtomicSync(filePath, serialized, 'thread.sync.tmp');
    metadata.push(entry);
  }
  const updated = nextManifest(manifest, normalized, metadata);
  writeAtomicSync(manifestPath(), JSON.stringify(updated), 'manifest.sync.tmp');
  initializingStorage = false;
  scheduleVersionCleanup(manifest, updated);
  return updated;
};

export const clearThreadsStorage = async () => {
  initializingStorage = false;
  await Promise.all([
    fs.rm(getThreadsDirectoryPath(), { recursive: true, force: true }),
    fs.rm(getThreadsFilePath(), { force: true }),
    fs.rm(backupPath(), { force: true }),
  ]);
};
