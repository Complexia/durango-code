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
// Bounded IPC responses: one carrying the whole corpus made Electron's main
// process retain multi-gigabyte PartitionAlloc/Mojo regions after hydration.
const MAX_BATCH_BYTES = 8 * 1024 * 1024;
const PAGE_ENVELOPE_BYTES = 512;
const MAX_HEAD_THREADS = 500;
const MAX_BATCH_IDS = 1000;
// Transcript files read at once. Reads are I/O bound; hashing and the IPC
// response stay sequential in manifest order.
const READ_CONCURRENCY = 16;
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

const latestTime = (...values) => {
  let latest = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const ms = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(ms) && ms > latestMs) {
      latest = value;
      latestMs = ms;
    }
  }
  return latest;
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
  // What the sidebar sorts by, so startup can load the rows it shows first
  // (readThreadsHead) without opening every transcript.
  activityAt: latestTime(
    thread.createdAt,
    Array.isArray(thread.messages) ? thread.messages.at(-1)?.ts : null,
    Array.isArray(thread.messages) ? thread.messages.at(-1)?.completedAt : null,
    thread.wokeAt,
    thread.unpinnedAt
  ),
  pinnedAt: typeof thread.pinnedAt === 'string' ? thread.pinnedAt : null,
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

// The verified on-disk JSON of one transcript. The hash proves the bytes are
// exactly what a patch wrote, so callers can hand them on without parsing.
const readEntryRaw = async (entry) => {
  const readVersion = async (candidate) => {
    const value = await fs.readFile(threadPath(candidate.id, candidate.hash), 'utf8');
    const actualHash = crypto.createHash('sha256').update(value).digest('hex');
    if (actualHash !== candidate.hash) throw new Error(`Stored Orion thread ${candidate.id} failed its checksum.`);
    return value;
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

const readEntry = async (entry) => assertThread(JSON.parse(await readEntryRaw(entry)));

// Reads entries in order with several files in flight. `accept` sees each
// result in order and returns false to stop; reads started past that point
// are discarded.
const readRawInOrder = async (entries, accept = () => true) => {
  const raws = [];
  const inFlight = [];
  let next = 0;
  const fill = () => {
    while (inFlight.length < READ_CONCURRENCY && next < entries.length) {
      inFlight.push(readEntryRaw(entries[next]));
      next += 1;
    }
  };
  fill();
  try {
    while (inFlight.length > 0) {
      const raw = await inFlight.shift();
      if (!accept(raw, raws.length)) break;
      raws.push(raw);
      fill();
    }
  } finally {
    for (const pending of inFlight) pending.catch(() => {});
  }
  return raws;
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

const sortTime = (entry) => {
  const ms = Date.parse(entry.activityAt ?? entry.updatedAt ?? entry.createdAt ?? '');
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
};

// Startup hydration loads in two steps so the window is usable at once. The
// head is what the first frame shows: the first `count` threads in stored
// order, the `count` most recently active ones (the sidebar's order), every
// pinned one, the `ids` the renderer names (selected thread, panes, saved
// views) with their parents, and every subagent thread under any of those.
// The renderer then loads the rest in the background with readThreadsBatch.
// Both return JSON text assembled from the verified file bytes: parsing each
// transcript here only to serialize it again for IPC was most of the cost.
export const readThreadsHead = async ({ count = 0, ids = [] } = {}) => {
  const manifest = await ensureManifest();
  if (!manifest) return JSON.stringify({ version: MANIFEST_VERSION, present: false, order: [], threads: [] });
  const entries = manifest.entries;
  const limit = Math.min(Math.max(Number.isInteger(count) ? count : 0, 0), MAX_HEAD_THREADS);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const children = new Map();
  for (const entry of entries) {
    if (!entry.parentThreadId) continue;
    const siblings = children.get(entry.parentThreadId) ?? [];
    siblings.push(entry.id);
    children.set(entry.parentThreadId, siblings);
  }

  const selected = new Set();
  const roots = [];
  const add = (id) => {
    if (selected.has(id) || !byId.has(id)) return;
    selected.add(id);
    roots.push(id);
  };
  for (const entry of entries.slice(0, limit)) add(entry.id);
  for (const entry of [...entries].sort((a, b) => sortTime(b) - sortTime(a)).slice(0, limit)) add(entry.id);
  for (const entry of entries) if (entry.pinnedAt) add(entry.id);
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string') continue;
    // A named subagent thread needs its parents for the breadcrumb and nesting.
    let current = byId.get(id);
    for (let depth = 0; current && depth < entries.length; depth += 1) {
      add(current.id);
      current = current.parentThreadId ? byId.get(current.parentThreadId) : undefined;
    }
  }
  while (roots.length > 0) {
    for (const childId of children.get(roots.pop()) ?? []) add(childId);
  }

  const raws = await readRawInOrder(entries.filter((entry) => selected.has(entry.id)));
  return `{"version":${MANIFEST_VERSION},"present":true,"order":${JSON.stringify(
    entries.map((entry) => entry.id)
  )},"threads":[${raws.join(',')}]}`;
};

// The rest of the transcripts, by id, in responses of about `maxBytes`.
// `consumed` says how many of `ids` this response covered (ids no longer
// stored are skipped), so the caller continues from there. One transcript
// larger than the budget is returned alone rather than blocking the rest.
export const readThreadsBatch = async ({ ids = [], maxBytes = MAX_BATCH_BYTES } = {}) => {
  if (!Array.isArray(ids) || ids.length > MAX_BATCH_IDS) throw new Error('Invalid Orion threads batch.');
  const requestedBytes = Number.isFinite(maxBytes) ? Math.trunc(maxBytes) : MAX_BATCH_BYTES;
  const budget =
    Math.min(Math.max(requestedBytes, PAGE_ENVELOPE_BYTES * 2), MAX_BATCH_BYTES) - PAGE_ENVELOPE_BYTES;
  const manifest = await ensureManifest();
  const byId = new Map((manifest?.entries ?? []).map((entry) => [entry.id, entry]));
  const wanted = [];
  const positions = [];
  ids.forEach((id, index) => {
    const entry = typeof id === 'string' ? byId.get(id) : undefined;
    if (!entry) return;
    wanted.push(entry);
    positions.push(index);
  });

  let bytes = 0;
  const raws = await readRawInOrder(wanted, (raw, taken) => {
    const size = Buffer.byteLength(raw, 'utf8') + (taken > 0 ? 1 : 0);
    if (taken > 0 && bytes + size > budget) return false;
    bytes += size;
    return true;
  });
  // Ids up to the last one returned are covered, including any unknown ids
  // between them; with everything returned, the whole request is.
  const consumed = raws.length === wanted.length ? ids.length : positions[raws.length];
  return `{"version":${MANIFEST_VERSION},"consumed":${consumed},"threads":[${raws.join(',')}]}`;
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
