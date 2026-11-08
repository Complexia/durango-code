import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { getThreadsDirectoryPath, getThreadsFilePath } from './paths.js';
import {
  messageSearchText,
  persistedShellOf,
  scoreBodyToken,
  summarizeThreadMessages,
  threadShellOf,
  transcriptExcerpt,
  withSubagentDetails,
} from '../thread-shell.js';

// On-disk format (version 3). Every thread is two content-addressed files
// plus its manifest entry:
//
//   <id>.<shellHash>.shell.json            the shell: every field but the transcript
//   <id>.<transcriptHash>.transcript.json  { messages, btwExchanges? }
//   <id>.<transcriptHash>.search           normalized search text, one line per message
//   manifest.json                          { version: 3, revision, entries }
//
// (<id> is the thread id in base64url.) The manifest is the commit point:
// files are written first, the manifest names the current version of each,
// and replaced versions are removed afterwards. Renaming or pinning a thread
// writes a new shell file and the manifest; the transcript is never read or
// rewritten for it. Each entry also carries the shell without subagent
// prompts and reports, the transcript summary, and flat index fields, so
// startup and the main-side index readers need only the manifest.
//
// Version 2 stored each thread as one combined `<id>.<hash>.json` file; the
// first launch on version 3 splits them (migrateFromV2). Version 1 was a
// single `orion-threads.json` (migrateLegacy).
const MANIFEST_VERSION = 3;
const LEGACY_MANIFEST_VERSION = 2;
// The renderer's patch and response envelopes (unchanged by the file format).
const PATCH_VERSION = 2;
const MANIFEST_FILE = 'manifest.json';
const LEGACY_BACKUP_FILE = 'orion-threads.v1-backup.json';
// Bounded IPC responses: one carrying the whole corpus made Electron's main
// process retain multi-gigabyte PartitionAlloc/Mojo regions after hydration.
const MAX_BATCH_BYTES = 8 * 1024 * 1024;
const PAGE_ENVELOPE_BYTES = 512;
const MAX_BATCH_IDS = 1000;
// Thread files read at once. Reads are I/O bound; hashing and the IPC
// response stay sequential in manifest order.
const READ_CONCURRENCY = 16;
let initializingStorage = false;

const encodeId = (id) => Buffer.from(id, 'utf8').toString('base64url');
const shellFileName = (id, hash) => `${encodeId(id)}.${hash}.shell.json`;
const transcriptFileName = (id, hash) => `${encodeId(id)}.${hash}.transcript.json`;
const searchFileName = (id, hash) => `${encodeId(id)}.${hash}.search`;
// Version 2's combined thread file (kept only for a thread that couldn't be
// read during the migration: see unreadableFile).
const legacyThreadFileName = (id, hash) => `${encodeId(id)}.${hash}.json`;
const inDirectory = (name, directory = getThreadsDirectoryPath()) => path.join(directory, name);
const manifestPath = (directory = getThreadsDirectoryPath()) => path.join(directory, MANIFEST_FILE);
const backupPath = () => path.join(path.dirname(getThreadsFilePath()), LEGACY_BACKUP_FILE);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

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

// A thread split into what its two files hold.
const transcriptOfThread = (thread) => {
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  return Array.isArray(thread.btwExchanges) ? { messages, btwExchanges: thread.btwExchanges } : { messages };
};

const serializedShell = (shell) => {
  const raw = JSON.stringify(shell);
  return { raw, hash: sha256(raw), bytes: Buffer.byteLength(raw, 'utf8') };
};
const serializedTranscript = (transcript) => {
  const raw = JSON.stringify(transcript);
  return { raw, hash: sha256(raw), bytes: Buffer.byteLength(raw, 'utf8') };
};

// The whole thread's JSON from its two files' bytes, without parsing either:
// the shell object's fields, then the transcript's. (A shell always has an
// id and a transcript always has messages, so neither object is empty.)
const joinThreadRaw = (shellRaw, transcriptRaw) => `${shellRaw.slice(0, -1)},${transcriptRaw.slice(1)}`;

const searchTextOf = (transcript) =>
  (Array.isArray(transcript.messages) ? transcript.messages : []).map(messageSearchText).join('\n');

// The manifest entry for a thread version. `hash` names the whole version
// (shell and transcript); index readers (workspace sync) use it to see what
// changed.
const entryFor = ({ shell, summary, shellHash, transcriptHash, shellBytes, transcriptBytes, unreadableFile, legacyHash }) => ({
  id: shell.id,
  hash: sha256(`${shellHash ?? ''}\n${transcriptHash ?? ''}`),
  shellHash,
  transcriptHash,
  // File sizes (workspace sync batches its reads by them).
  ...(shellBytes !== undefined ? { shellBytes } : {}),
  ...(transcriptBytes !== undefined ? { transcriptBytes } : {}),
  projectId: typeof shell.projectId === 'string' ? shell.projectId : null,
  parentThreadId: typeof shell.parentThreadId === 'string' ? shell.parentThreadId : null,
  subagent: shell.subagent === true,
  title: typeof shell.title === 'string' ? shell.title : '',
  status: typeof shell.status === 'string' ? shell.status : null,
  modelId: typeof shell.modelId === 'string' ? shell.modelId : null,
  createdAt: shell.createdAt ?? null,
  updatedAt: summary.lastMessage?.ts ?? shell.createdAt ?? null,
  messageCount: summary.messageCount,
  // Latest activity, for consumers that order threads from the index alone.
  activityAt: latestTime(
    shell.createdAt,
    summary.lastMessage?.ts,
    summary.lastMessage?.completedAt,
    shell.wokeAt,
    shell.unpinnedAt
  ),
  pinnedAt: typeof shell.pinnedAt === 'string' ? shell.pinnedAt : null,
  // What the renderer hydrates every thread from (thread-shell.js).
  shell: persistedShellOf(shell),
  summary,
  ...(unreadableFile ? { unreadableFile } : {}),
  ...(legacyHash ? { legacyHash } : {}),
});

const validateEntries = (manifest) => {
  if (!Array.isArray(manifest?.entries)) throw new Error('Invalid Orion threads manifest.');
  const ids = new Set();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) {
      throw new Error('Invalid Orion threads manifest entry.');
    }
    ids.add(entry.id);
  }
  return manifest;
};

// Version 2's manifest: one file holding every entry. Only read, to migrate.
const parseLegacyManifest = (value) => validateEntries(JSON.parse(value));

const emptyManifest = () => ({ version: MANIFEST_VERSION, revision: 0, entries: [] });

const writeAtomic = async (filePath, value, suffix = 'tmp') => {
  const tempPath = `${filePath}.${process.pid}.${suffix}`;
  await fs.writeFile(tempPath, value, 'utf8');
  await fs.rename(tempPath, filePath);
};

// The migration commits its manifest durably (each shard and the root
// flushed to disk before the rename that follows it, and the directory after),
// so power loss can't leave a committed root naming shards that never reached
// the disk. Thread files aren't flushed one by one (that made the migration
// about 5x slower): a damaged one is recovered from its version 2 file, which
// stays until a later launch has verified the new files
// (retireLegacyThreadFiles).
const writeAtomicDurableSync = (filePath, value, suffix = 'sync.tmp') => {
  const tempPath = `${filePath}.${process.pid}.${suffix}`;
  const fd = openSync(tempPath, 'w');
  try {
    writeFileSync(fd, value, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, filePath);
};
const syncDirectory = (directory) => {
  let fd;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch {
    // Not every file system lets a directory be flushed.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

const writeAtomicSync = (filePath, value, suffix = 'sync.tmp') => {
  const tempPath = `${filePath}.${process.pid}.${suffix}`;
  writeFileSync(tempPath, value, 'utf8');
  renameSync(tempPath, filePath);
};

// ---------------------------------------------------------------------------
// The manifest. Its entries are spread over MANIFEST_SHARDS content-addressed
// shard files (by a hash of the thread id), and `manifest.json` — the commit
// point — lists the thread order and the current file of each shard:
//
//   manifest.json                 { version: 3, revision, order: [ids], shards: { key: hash } }
//   manifest.<key>.<hash>.json    [entries]
//
// So a save rewrites the root and the shards of the threads it touched
// (tens of KB), not every thread's entry. In memory the manifest is one
// object, { version, revision, entries } in order, as before.
const MANIFEST_SHARDS = 64;
const shardFileName = (key, hash) => `manifest.${key}.${hash}.json`;
const shardKeys = new Map();
const shardKeyOf = (id) => {
  let key = shardKeys.get(id);
  if (key === undefined) {
    key = (parseInt(sha256(id).slice(0, 4), 16) % MANIFEST_SHARDS).toString(16).padStart(2, '0');
    shardKeys.set(id, key);
  }
  return key;
};

// Each manifest's shards: key → { hash, entries }, for the next write to
// reuse unchanged shards.
const manifestShards = new WeakMap();
// Parsed shard files by hash (they never change), for the shards still in use.
let shardCache = new Map();

const manifestFileNames = (manifest) =>
  [...(manifestShards.get(manifest)?.entries() ?? [])].map(([key, shard]) => shardFileName(key, shard.hash));

const assembleManifest = (root, shardsByKey) => {
  if (!Array.isArray(root?.order) || !root.shards || typeof root.shards !== 'object') {
    throw corrupt(new Error('Invalid Orion threads manifest.'));
  }
  const byId = new Map();
  for (const shard of shardsByKey.values()) for (const entry of shard.entries) byId.set(entry.id, entry);
  const entries = root.order.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw corrupt(new Error(`Orion threads manifest lists ${id} without its entry.`));
    return entry;
  });
  const manifest = validateEntries({ version: MANIFEST_VERSION, revision: root.revision ?? 0, entries });
  manifestShards.set(manifest, shardsByKey);
  shardCache = new Map([...shardsByKey.values()].map((shard) => [shard.hash, shard.entries]));
  return manifest;
};

// Damage, as opposed to a read that failed for now (EMFILE, EIO, …): the
// only errors that may open the previous root.
const corrupt = (error) => Object.assign(error, { corrupt: true });
const isCorruption = (error) => error?.corrupt === true || error instanceof SyntaxError;

const shardFromRaw = (key, hash, raw) => {
  let entries;
  try {
    entries = JSON.parse(checkedRaw(hash, `manifest shard ${key}`, raw));
  } catch (error) {
    throw corrupt(error);
  }
  if (!Array.isArray(entries)) throw corrupt(new Error('Invalid Orion threads manifest shard.'));
  return { hash, entries };
};
// A shard the root names but that isn't there is damage too.
const readShardFile = async (filePath) => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw error?.code === 'ENOENT' ? corrupt(error) : error;
  }
};
const readShardFileSync = (filePath) => {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    throw error?.code === 'ENOENT' ? corrupt(error) : error;
  }
};

const readShards = async (root, directory) => {
  const shards = new Map();
  await mapConcurrent(Object.entries(root.shards ?? {}), READ_CONCURRENCY, async ([key, hash]) => {
    const cached = shardCache.get(hash);
    shards.set(
      key,
      cached
        ? { hash, entries: cached }
        : shardFromRaw(key, hash, await readShardFile(inDirectory(shardFileName(key, hash), directory)))
    );
  });
  return shards;
};

const readShardsSync = (root, directory) => {
  const shards = new Map();
  for (const [key, hash] of Object.entries(root.shards ?? {})) {
    const cached = shardCache.get(hash);
    shards.set(
      key,
      cached ? { hash, entries: cached } : shardFromRaw(key, hash, readShardFileSync(inDirectory(shardFileName(key, hash), directory)))
    );
  }
  return shards;
};

// The files writing `manifest` takes: changed shards (unchanged ones, by
// entry identity, keep their file) and the root.
const manifestWrite = (manifest, previous) => {
  const before = (previous && manifestShards.get(previous)) || new Map();
  const grouped = new Map();
  for (const entry of manifest.entries) {
    const key = shardKeyOf(entry.id);
    const list = grouped.get(key);
    if (list) list.push(entry);
    else grouped.set(key, [entry]);
  }
  const shards = new Map();
  const files = [];
  for (const [key, entries] of grouped) {
    const prior = before.get(key);
    if (prior && prior.entries.length === entries.length && prior.entries.every((entry, index) => entry === entries[index])) {
      shards.set(key, prior);
      continue;
    }
    const raw = JSON.stringify(entries);
    const hash = sha256(raw);
    shards.set(key, { hash, entries });
    files.push({ name: shardFileName(key, hash), raw });
  }
  return { shards, files, root: rootJson(manifest, shards) };
};

const rootJson = (manifest, shards) =>
  JSON.stringify({
    version: MANIFEST_VERSION,
    revision: manifest.revision,
    order: manifest.entries.map((entry) => entry.id),
    shards: Object.fromEntries([...shards].map(([key, shard]) => [key, shard.hash])),
  });

// The root each commit replaces, kept (as a hard link to the very file that
// was committed, never rewritten) for recovery: saves aren't flushed to disk
// (flushing the shards and root costs ~20 ms a save), so a crash can tear the
// newest root or one of its shards. Its files outlive the commit after it
// (scheduleVersionCleanup). See recoverManifestSync.
const PREVIOUS_MANIFEST_FILE = 'manifest.prev.json';
const previousManifestPath = (directory = getThreadsDirectoryPath()) => path.join(directory, PREVIOUS_MANIFEST_FILE);

// The parsed manifest, reused while the root file is unchanged: every thread
// load and save starts here. Entries are shared, so nothing may mutate a
// manifest or its entries.
let manifestCache = null;
const statKey = (stat) => `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
const remember = (filePath, manifest, stat) => {
  manifestCache = { path: filePath, key: statKey(stat), manifest };
  return manifest;
};

// Version 3 assembled from its shards, or version 2 as it is (to migrate).
const assembleRootRaw = async (raw, directory) => {
  const root = JSON.parse(raw);
  if (root?.version === LEGACY_MANIFEST_VERSION) return parseLegacyManifest(raw);
  if (root?.version !== MANIFEST_VERSION) throw new Error('Invalid Orion threads manifest.');
  return assembleManifest(root, await readShards(root, directory));
};
const assembleRootRawSync = (raw, directory) => {
  const root = JSON.parse(raw);
  if (root?.version === LEGACY_MANIFEST_VERSION) return parseLegacyManifest(raw);
  if (root?.version !== MANIFEST_VERSION) throw new Error('Invalid Orion threads manifest.');
  return assembleManifest(root, readShardsSync(root, directory));
};

// The previous root, assembled (the sweep keeps what it names).
const readPreviousManifestSync = (directory) => {
  const manifest = assembleRootRawSync(readFileSync(previousManifestPath(directory), 'utf8'), directory);
  if (manifest.version !== MANIFEST_VERSION) throw new Error('Invalid previous Orion threads manifest.');
  return manifest;
};
// ---------------------------------------------------------------------------
// Recovery. When the committed manifest won't assemble (a torn root or shard,
// a missing shard), the store is rebuilt from what is on disk and committed
// again, so it always opens with the most recent recoverable state:
//
// - The current root parses: its order and every shard that verifies are
//   kept; the threads of a damaged shard are rebuilt from their files.
// - Only the previous root parses: its threads (plus any whose files are
//   newer than it) are taken from its shards where those still name each
//   thread's newest files, and rebuilt from the files otherwise.
// - No root parses: every thread with files is rebuilt.
//
// A rebuilt thread takes its newest shell and transcript files (by mtime)
// whose bytes match their content hash, never one that fails verification,
// or its version 2 file. One with no readable transcript stays listed as
// unreadable. A copy of the damaged root is kept for a week
// (manifest.damaged-<time>.json); meanwhile the sweep keeps every file of the
// threads it names.
const DAMAGED_MANIFEST_PREFIX = 'manifest.damaged-';
const DAMAGED_MANIFEST_FILE = /^manifest\.damaged-(\d+)\.json$/;
const DAMAGED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const TRANSIENT_READ_ATTEMPTS = 3;
let reportedDamage = false;

const THREAD_VERSION_FILE = /^([A-Za-z0-9_-]+)\.([0-9a-f]{64})\.(shell\.json|transcript\.json|json)$/;
const threadFilesOnDisk = (directory) => {
  const byId = new Map();
  for (const name of readdirSync(directory)) {
    const match = THREAD_VERSION_FILE.exec(name);
    if (!match) continue;
    let id;
    try {
      id = Buffer.from(match[1], 'base64url').toString('utf8');
    } catch {
      continue;
    }
    if (!id || encodeId(id) !== match[1]) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path.join(directory, name)).mtimeMs;
    } catch {
      continue;
    }
    const kind = match[3] === 'shell.json' ? 'shells' : match[3] === 'transcript.json' ? 'transcripts' : 'legacy';
    const files = byId.get(id) ?? { shells: [], transcripts: [], legacy: [] };
    files[kind].push({ name, hash: match[2], mtimeMs });
    byId.set(id, files);
  }
  for (const files of byId.values()) {
    for (const list of [files.shells, files.transcripts, files.legacy]) list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
  return byId;
};

// The newest file of `list` whose bytes match its name's hash, parsed.
const newestVerified = (list, directory) => {
  for (const file of list) {
    try {
      const raw = readFileSync(path.join(directory, file.name), 'utf8');
      if (sha256(raw) !== file.hash) continue;
      return { file, raw, value: JSON.parse(raw) };
    } catch {}
  }
  return null;
};

const rebuildEntry = (id, files, directory) => {
  if (!files) return null;
  const shell = newestVerified(files.shells, directory);
  const transcript = newestVerified(files.transcripts, directory);
  const legacy = transcript && shell ? null : newestVerified(files.legacy, directory);
  if (legacy && legacy.value?.id === id) {
    // The version 2 file stands in for what's missing.
    const split = splitThread(legacy.value, directory);
    const shellPart = shell ?? { file: { hash: split.entry.shellHash }, raw: split.files[0].raw, value: JSON.parse(split.files[0].raw) };
    const transcriptPart = transcript ?? {
      file: { hash: split.entry.transcriptHash },
      raw: split.files[1].raw,
      value: JSON.parse(split.files[1].raw),
    };
    for (const file of split.files) {
      try {
        writeAtomicSync(file.path, file.raw, 'rebuild.tmp');
      } catch {}
    }
    return entryFor({
      shell: shellPart.value,
      summary: summarizeThreadMessages(transcriptPart.value.messages),
      shellHash: shellPart.file.hash,
      transcriptHash: transcriptPart.file.hash,
      shellBytes: Buffer.byteLength(shellPart.raw, 'utf8'),
      transcriptBytes: Buffer.byteLength(transcriptPart.raw, 'utf8'),
      legacyHash: transcript ? undefined : legacy.file.hash,
    });
  }
  if (!shell || shell.value?.id !== id) return null;
  if (!transcript) {
    // Listed, but its transcript can't be read.
    return entryFor({ shell: shell.value, summary: summarizeThreadMessages([]), shellHash: shell.file.hash, transcriptHash: null });
  }
  return entryFor({
    shell: shell.value,
    summary: summarizeThreadMessages(transcript.value.messages),
    shellHash: shell.file.hash,
    transcriptHash: transcript.file.hash,
    shellBytes: Buffer.byteLength(shell.raw, 'utf8'),
    transcriptBytes: Buffer.byteLength(transcript.raw, 'utf8'),
  });
};

const parsedRoot = (filePath) => {
  try {
    const raw = readFileSync(filePath, 'utf8');
    try {
      const root = JSON.parse(raw);
      return { raw, root: root?.version === MANIFEST_VERSION && Array.isArray(root.order) && root.shards ? root : null };
    } catch {
      return { raw, root: null };
    }
  } catch {
    return { raw: null, root: null };
  }
};

// Shard entries of `root` that verify, by thread id; keys that didn't.
const verifiedShardEntries = (root, directory) => {
  const byId = new Map();
  const damagedKeys = new Set();
  for (const [key, hash] of Object.entries(root.shards)) {
    try {
      for (const entry of shardFromRaw(key, hash, readFileSync(inDirectory(shardFileName(key, hash), directory), 'utf8')).entries) {
        if (entry && typeof entry.id === 'string') byId.set(entry.id, entry);
      }
    } catch {
      damagedKeys.add(key);
    }
  }
  return { byId, damagedKeys };
};

const recoverManifestSync = (directory, cause) => {
  const current = parsedRoot(manifestPath(directory));
  const previous = parsedRoot(previousManifestPath(directory));
  const files = threadFilesOnDisk(directory);
  const newestOf = (list) => list?.[0]?.hash;
  let ids;
  let entryOf;
  let revision;
  if (current.root) {
    const { byId } = verifiedShardEntries(current.root, directory);
    ids = current.root.order;
    entryOf = (id) => byId.get(id) ?? rebuildEntry(id, files.get(id), directory);
    revision = current.root.revision ?? 0;
  } else if (previous.root) {
    const { byId } = verifiedShardEntries(previous.root, directory);
    let previousTime = 0;
    try {
      previousTime = statSync(previousManifestPath(directory)).mtimeMs;
    } catch {}
    const known = new Set(previous.root.order);
    const newer = [...files].filter(([id, list]) => !known.has(id) && (list.shells[0]?.mtimeMs ?? 0) > previousTime).map(([id]) => id);
    ids = [...newer, ...previous.root.order];
    entryOf = (id) => {
      const entry = byId.get(id);
      const list = files.get(id);
      // Still naming the newest files: keep it as it was.
      if (entry && newestOf(list?.shells) === entry.shellHash && (!entry.transcriptHash || newestOf(list?.transcripts) === entry.transcriptHash)) {
        return entry;
      }
      return rebuildEntry(id, list, directory) ?? entry ?? null;
    };
    revision = previous.root.revision ?? 0;
  } else {
    ids = [...files.keys()];
    entryOf = (id) => rebuildEntry(id, files.get(id), directory);
    revision = 0;
  }
  const seen = new Set();
  const entries = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = entryOf(id);
    if (entry) entries.push(entry);
  }
  if (!current.root && !previous.root) {
    // No order survived: newest activity first, as the sidebar shows them.
    entries.sort((a, b) => String(b.activityAt ?? '').localeCompare(String(a.activityAt ?? '')));
  }
  // Keep the damaged root (whatever of it is readable) for recovery by hand.
  if (current.raw !== null) {
    try {
      writeAtomicSync(path.join(directory, `${DAMAGED_MANIFEST_PREFIX}${Date.now()}.json`), current.raw, 'damaged.tmp');
    } catch {}
  }
  const recovered = { version: MANIFEST_VERSION, revision: revision + 1, entries };
  writeManifestSync(recovered, null, 'manifest.recover.tmp', directory, { durable: true });
  if (!reportedDamage) {
    reportedDamage = true;
    console.error(
      `The Orion threads manifest was damaged (${cause?.message ?? cause}); rebuilt it from the thread files ` +
        `(${entries.length} threads). A copy of the damaged one is kept for a week.`
    );
  }
  return recovered;
};

const readManifestFile = async () => {
  const filePath = manifestPath();
  const stat = await fs.stat(filePath);
  if (manifestCache && manifestCache.path === filePath && manifestCache.key === statKey(stat)) {
    return manifestCache.manifest;
  }
  // Stat first: a rename between the two reads is caught by the next stat.
  const directory = path.dirname(filePath);
  let manifest;
  for (let attempt = 1; ; attempt += 1) {
    let rootRaw;
    try {
      rootRaw = await fs.readFile(filePath, 'utf8');
      manifest = await assembleRootRaw(rootRaw, directory);
      break;
    } catch (error) {
      if (!isCorruption(error)) {
        // A read that failed for now (or a root replaced meanwhile): retry,
        // never open the previous root for it.
        if (attempt >= TRANSIENT_READ_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        continue;
      }
      void rootRaw;
      // Committed (and cached) by the recovery itself.
      return recoverManifestSync(directory, error);
    }
  }
  return remember(filePath, manifest, stat);
};

const readManifestFileSync = () => {
  const filePath = manifestPath();
  const stat = statSync(filePath);
  if (manifestCache && manifestCache.path === filePath && manifestCache.key === statKey(stat)) {
    return manifestCache.manifest;
  }
  const directory = path.dirname(filePath);
  let manifest;
  let rootRaw;
  try {
    rootRaw = readFileSync(filePath, 'utf8');
    manifest = assembleRootRawSync(rootRaw, directory);
  } catch (error) {
    // No waiting here: a transient failure throws (the caller retries).
    if (!isCorruption(error)) throw error;
    void rootRaw;
    return recoverManifestSync(directory, error);
  }
  return remember(filePath, manifest, stat);
};

const committed = (filePath, manifest, shards, stat) => {
  manifestShards.set(manifest, shards);
  shardCache = new Map([...shards.values()].map((shard) => [shard.hash, shard.entries]));
  try {
    remember(filePath, manifest, stat());
  } catch {
    manifestCache = null;
  }
};

// Shards first, the root (the commit) last.
const writeManifest = async (manifest, previous, directory = getThreadsDirectoryPath()) => {
  const { shards, files, root } = manifestWrite(manifest, previous);
  for (const file of files) await writeAtomic(inDirectory(file.name, directory), file.raw, 'shard.tmp');
  const filePath = manifestPath(directory);
  await writeAtomic(filePath, root, 'manifest.tmp');
  if (directory === getThreadsDirectoryPath()) {
    const stat = await fs.stat(filePath).catch(() => null);
    committed(filePath, manifest, shards, () => {
      if (!stat) throw new Error('Manifest vanished.');
      return stat;
    });
  }
};

const writeManifestSync = (
  manifest,
  previous,
  suffix = 'manifest.sync.tmp',
  directory = getThreadsDirectoryPath(),
  { durable = false } = {}
) => {
  const { shards, files, root } = manifestWrite(manifest, previous);
  const write = durable ? writeAtomicDurableSync : writeAtomicSync;
  for (const file of files) write(inDirectory(file.name, directory), file.raw, 'shard.sync.tmp');
  // Everything the root will name is on disk before the root commits it.
  if (durable) syncDirectory(directory);
  const filePath = manifestPath(directory);
  write(filePath, root, suffix);
  if (durable) syncDirectory(directory);
  if (directory === getThreadsDirectoryPath()) committed(filePath, manifest, shards, () => statSync(filePath));
};

// ---------------------------------------------------------------------------
// Writing one thread's files. The caller commits the returned entry to the
// manifest; nothing before that changes what readers see.

// Version files are named by their content hash and always written whole
// (atomically), so writing one again also repairs a damaged copy.
const writeVersionFile = (filePath, raw, suffix) => writeAtomic(filePath, raw, suffix);
const writeVersionFileSync = (filePath, raw, suffix) => writeAtomicSync(filePath, raw, suffix);

// The files of a whole thread (shell and transcript), and its entry.
const splitThread = (thread, directory) => {
  const shell = threadShellOf(thread);
  const transcript = transcriptOfThread(thread);
  const shellFile = serializedShell(shell);
  const transcriptFile = serializedTranscript(transcript);
  return {
    files: [
      { path: inDirectory(shellFileName(shell.id, shellFile.hash), directory), raw: shellFile.raw, suffix: 'shell.tmp' },
      {
        path: inDirectory(transcriptFileName(shell.id, transcriptFile.hash), directory),
        raw: transcriptFile.raw,
        suffix: 'transcript.tmp',
      },
    ],
    transcript,
    entry: entryFor({
      shell,
      summary: summarizeThreadMessages(transcript.messages),
      shellHash: shellFile.hash,
      transcriptHash: transcriptFile.hash,
      shellBytes: shellFile.bytes,
      transcriptBytes: transcriptFile.bytes,
    }),
  };
};

const shellOnlyEntry = (shell, previous, storedShell, directory) => {
  // The manifest's copy of a shell (and so the renderer's, for a thread it
  // hasn't loaded) leaves out subagent prompts and reports: keep the stored
  // ones.
  let next = threadShellOf(shell);
  if (storedShell) {
    if (next.subagent) next = { ...next, subagent: withSubagentDetails(next.subagent, storedShell.subagent) };
    if (next.inheritedSubagent) {
      next = { ...next, inheritedSubagent: withSubagentDetails(next.inheritedSubagent, storedShell.inheritedSubagent) };
    }
  }
  const shellFile = serializedShell(next);
  const files = [
    { path: inDirectory(shellFileName(next.id, shellFile.hash), directory), raw: shellFile.raw, suffix: 'shell.tmp' },
  ];
  if (!previous) {
    // Never stored: it starts with an empty transcript.
    const transcriptFile = serializedTranscript({ messages: [] });
    files.push({
      path: inDirectory(transcriptFileName(next.id, transcriptFile.hash), directory),
      raw: transcriptFile.raw,
      suffix: 'transcript.tmp',
    });
    return {
      files,
      entry: entryFor({
        shell: next,
        summary: summarizeThreadMessages([]),
        shellHash: shellFile.hash,
        transcriptHash: transcriptFile.hash,
        shellBytes: shellFile.bytes,
        transcriptBytes: transcriptFile.bytes,
      }),
    };
  }
  return {
    files,
    entry: entryFor({
      shell: next,
      summary: previous.summary ?? summarizeThreadMessages([]),
      shellHash: shellFile.hash,
      transcriptHash: previous.transcriptHash,
      shellBytes: shellFile.bytes,
      transcriptBytes: previous.transcriptBytes,
      unreadableFile: previous.unreadableFile,
      // Still the migrated transcript: still recoverable from the v2 file.
      legacyHash: previous.legacyHash,
    }),
  };
};

// ---------------------------------------------------------------------------
// Reading. Every reader of a stored thread goes through these, so the shell
// and transcript it sees are the ones the current manifest names.

const checkedRaw = (expectedHash, label, value) => {
  if (sha256(value) !== expectedHash) throw new Error(`Stored Orion thread ${label} failed its checksum.`);
  return value;
};

const unreadableError = (entry) =>
  Object.assign(new Error(`Stored Orion thread ${entry.id} could not be read when its storage was upgraded.`), {
    unreadable: true,
  });

const readShellFileOf = async (entry) => {
  if (!entry.shellHash) throw unreadableError(entry);
  return checkedRaw(entry.shellHash, entry.id, await fs.readFile(inDirectory(shellFileName(entry.id, entry.shellHash)), 'utf8'));
};
const readTranscriptFileOf = async (entry) => {
  if (!entry.transcriptHash) throw unreadableError(entry);
  return checkedRaw(
    entry.transcriptHash,
    entry.id,
    await fs.readFile(inDirectory(transcriptFileName(entry.id, entry.transcriptHash)), 'utf8')
  );
};
const readShellFileOfSync = (entry) => {
  if (!entry.shellHash) throw unreadableError(entry);
  return checkedRaw(entry.shellHash, entry.id, readFileSync(inDirectory(shellFileName(entry.id, entry.shellHash)), 'utf8'));
};
const readTranscriptFileOfSync = (entry) => {
  if (!entry.transcriptHash) throw unreadableError(entry);
  return checkedRaw(
    entry.transcriptHash,
    entry.id,
    readFileSync(inDirectory(transcriptFileName(entry.id, entry.transcriptHash)), 'utf8')
  );
};

// A thread still at the version the migration wrote has its version 2 file
// until a later launch has verified the new files (retireLegacyThreadFiles).
// When a new file is damaged (power loss right after the migration), the
// thread is read from that file instead and its new files written again.
// The part of the v2 copy that matches what `entry` names: its transcript
// (while the entry still points at the v2 file) and, if the shell is also
// still the migrated one, its shell.
const legacyPartsOf = (entry, raw) => {
  const split = splitThread(assertThread(JSON.parse(checkedRaw(entry.legacyHash, entry.id, raw))), getThreadsDirectoryPath());
  const [shellFile, transcriptFile] = split.files;
  return {
    shell: split.entry.shellHash === entry.shellHash ? shellFile : null,
    transcript: split.entry.transcriptHash === entry.transcriptHash ? transcriptFile : null,
  };
};
const recoverFromLegacy = async (entry, part) => {
  if (!entry.legacyHash) return null;
  let file;
  try {
    file = legacyPartsOf(entry, await fs.readFile(inDirectory(legacyThreadFileName(entry.id, entry.legacyHash)), 'utf8'))[part];
  } catch {
    return null;
  }
  if (!file) return null;
  await writeAtomic(file.path, file.raw, 'recover.tmp').catch(() => {});
  console.warn(`Recovered the ${part} of Orion thread ${entry.id} from its copy from before the storage upgrade`);
  return file.raw;
};
const recoverFromLegacySync = (entry, part) => {
  if (!entry.legacyHash) return null;
  let file;
  try {
    file = legacyPartsOf(entry, readFileSync(inDirectory(legacyThreadFileName(entry.id, entry.legacyHash)), 'utf8'))[part];
  } catch {
    return null;
  }
  if (!file) return null;
  try {
    writeAtomicSync(file.path, file.raw, 'recover.sync.tmp');
  } catch {}
  return file.raw;
};

// A damaged or missing file of the entry the current manifest still names
// (not one a newer save replaced: withCurrentEntry handles that).
const isDamage = async (entry, error) => {
  if (error?.unreadable) return false;
  if (error?.code !== 'ENOENT') return true;
  const current = await ensureManifest().catch(() => null);
  return current?.entries.find((candidate) => candidate.id === entry.id)?.hash === entry.hash;
};
const recovering = (readFile, part) => async (entry) => {
  try {
    return await readFile(entry);
  } catch (error) {
    if (!(await isDamage(entry, error))) throw error;
    const recovered = await recoverFromLegacy(entry, part);
    if (recovered === null) throw error;
    return recovered;
  }
};
const recoveringSync = (readFile, part) => (entry) => {
  try {
    return readFile(entry);
  } catch (error) {
    if (error?.unreadable) throw error;
    const recovered = recoverFromLegacySync(entry, part);
    if (recovered === null) throw error;
    return recovered;
  }
};
const readShellRawOf = recovering(readShellFileOf, 'shell');
const readTranscriptRawOf = recovering(readTranscriptFileOf, 'transcript');
const readShellRawOfSync = recoveringSync(readShellFileOfSync, 'shell');
const readTranscriptRawOfSync = recoveringSync(readTranscriptFileOfSync, 'transcript');

// A reader can take the manifest just before a writer commits a newer
// version of the thread and removes the old files. Retry through the current
// manifest instead of surfacing that transient ENOENT.
const withCurrentEntry = async (entry, read) => {
  try {
    return await read(entry);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const current = await ensureManifest();
    const replacement = current?.entries.find((candidate) => candidate.id === entry.id);
    if (!replacement || replacement.hash === entry.hash) throw error;
    return read(replacement);
  }
};

const readThreadRawOf = async (entry) => {
  const [shellRaw, transcriptRaw] = await Promise.all([readShellRawOf(entry), readTranscriptRawOf(entry)]);
  return joinThreadRaw(shellRaw, transcriptRaw);
};

// The verified JSON of one whole thread, as the current manifest names it.
const readEntryRaw = (entry) => withCurrentEntry(entry, readThreadRawOf);
const readEntry = async (entry) => assertThread(JSON.parse(await readEntryRaw(entry)));
const readEntryTranscript = async (entry) => JSON.parse(await withCurrentEntry(entry, readTranscriptRawOf));
const readEntryShell = async (entry) => JSON.parse(await withCurrentEntry(entry, readShellRawOf));

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

// Runs `task` over `items` with `limit` in flight; results in input order.
const mapConcurrent = async (items, limit, task) => {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

// ---------------------------------------------------------------------------
// Migrations. Both build the version 3 files first and commit the manifest
// last, so an interruption at any point leaves the previous format intact
// (or the migration done); running again picks up from there.

// A thread that couldn't be read keeps its entry (and its version 2 file, for
// recovery): readers report it as unreadable, and it can still be renamed,
// pinned or deleted.
const fallbackShell = (entry) => ({
  id: entry.id,
  projectId: entry.projectId ?? '',
  title: entry.title || 'Untitled',
  status: entry.status === 'running' ? 'idle' : entry.status ?? 'idle',
  modelId: entry.modelId ?? '',
  accessMode: 'read-only',
  createdAt: entry.createdAt ?? new Date(0).toISOString(),
  ...(entry.parentThreadId ? { parentThreadId: entry.parentThreadId } : {}),
  ...(entry.pinnedAt ? { pinnedAt: entry.pinnedAt } : {}),
});
const unreadableEntry = (legacy) => {
  const shell = legacy.shell && typeof legacy.shell === 'object' ? { ...legacy.shell, id: legacy.id } : fallbackShell(legacy);
  return entryFor({
    shell,
    summary: legacy.summary ?? summarizeThreadMessages([]),
    shellHash: null,
    transcriptHash: null,
    unreadableFile: legacyThreadFileName(legacy.id, legacy.hash),
  });
};

// Version 2 → 3: split each combined file into a shell and a transcript file
// (writing its search text while it is open), then commit a version 3
// manifest. Old files go in the sweep that follows.
// A migrated entry remembers its thread's version 2 hash twice, for two
// different lifetimes:
// - `syncHash`: the hash workspace sync had uploaded the thread under, so an
//   unchanged thread isn't uploaded again. Any save of the thread drops it.
// - `legacyHash`: the version 2 file the thread can be recovered from while
//   its transcript is still the one the migration wrote (shell-only saves
//   keep it; a transcript save drops it). Retirement verifies that
//   transcript before removing the file.
const migratedEntry = (entry, legacyHash, { recoverable = true } = {}) => ({
  ...entry,
  syncHash: legacyHash,
  ...(recoverable ? { legacyHash } : {}),
});

let migration = null;
// Set by a launch that migrated: it leaves the version 2 files for a later
// launch's sweep, so they outlive the first commit of the new format.
let migratedThisLaunch = false;
const migrateFromV2 = (legacy) => {
  // A caller that read the version 2 manifest just before another finished
  // migrating it gets the result, not a second migration.
  try {
    const current = readManifestFileSync();
    if (current.version === MANIFEST_VERSION) return Promise.resolve(current);
  } catch {}
  migration ??= (async () => {
    const directory = getThreadsDirectoryPath();
    const entries = await mapConcurrent(legacy.entries, READ_CONCURRENCY, async (old) => {
      let thread;
      try {
        thread = assertThread(
          JSON.parse(
            checkedRaw(old.hash, old.id, await fs.readFile(inDirectory(legacyThreadFileName(old.id, old.hash)), 'utf8'))
          )
        );
        if (thread.id !== old.id) throw new Error(`Stored Orion thread ${old.id} holds another thread.`);
      } catch (error) {
        console.warn(`Could not read Orion thread ${old.id} while upgrading thread storage`, error);
        return unreadableEntry(old);
      }
      const split = splitThread(thread, directory);
      for (const file of split.files) await writeAtomic(file.path, file.raw, file.suffix.replace('.tmp', '.migrate.tmp'));
      const searchPath = inDirectory(searchFileName(old.id, split.entry.transcriptHash), directory);
      if (!existsSync(searchPath)) {
        await writeAtomic(searchPath, searchTextOf(split.transcript), 'search.migrate.tmp').catch(() => {});
      }
      return migratedEntry(split.entry, old.hash);
    });
    // Commit synchronously, and only over the version 2 manifest this read:
    // the quit-time path may have migrated (and saved) meanwhile.
    const current = readManifestFileSync();
    if (current.version !== LEGACY_MANIFEST_VERSION || current.revision !== legacy.revision) return current;
    const migrated = { version: MANIFEST_VERSION, revision: (legacy.revision ?? 0) + 1, entries };
    writeManifestSync(migrated, null, 'manifest.migrate.tmp', directory, { durable: true });
    migratedThisLaunch = true;
    return migrated;
  })().finally(() => {
    migration = null;
  });
  return migration;
};

const migrateFromV2Sync = (legacy) => {
  const directory = getThreadsDirectoryPath();
  const entries = legacy.entries.map((old) => {
    let thread;
    try {
      thread = assertThread(
        JSON.parse(checkedRaw(old.hash, old.id, readFileSync(inDirectory(legacyThreadFileName(old.id, old.hash)), 'utf8')))
      );
      if (thread.id !== old.id) throw new Error(`Stored Orion thread ${old.id} holds another thread.`);
    } catch (error) {
      console.warn(`Could not read Orion thread ${old.id} while upgrading thread storage`, error);
      return unreadableEntry(old);
    }
    const split = splitThread(thread, directory);
    for (const file of split.files) writeAtomicSync(file.path, file.raw, file.suffix.replace('.tmp', '.migrate-sync.tmp'));
    return migratedEntry(split.entry, old.hash);
  });
  const migrated = { version: MANIFEST_VERSION, revision: (legacy.revision ?? 0) + 1, entries };
  writeManifestSync(migrated, null, 'manifest.migrate-sync.tmp', directory, { durable: true });
  migratedThisLaunch = true;
  return migrated;
};

// Version 1 (one orion-threads.json) → 3, built in a staging directory that
// becomes the threads directory in one rename.
const legacyThreads = (value) => {
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed?.threads)) throw new Error('Legacy transcript file does not contain a threads array.');
  const ids = new Set();
  return parsed.threads.map((candidate) => {
    const thread = assertThread(candidate);
    if (ids.has(thread.id)) throw new Error('Legacy transcript file contains duplicate thread ids.');
    ids.add(thread.id);
    return thread;
  });
};

const archiveLegacyFile = (rename) => {
  try {
    rename(getThreadsFilePath(), backupPath());
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'EEXIST') {
      console.warn('Could not archive legacy Orion threads file', error);
    }
  }
};

const migrateLegacy = async () => {
  let value;
  try {
    value = await fs.readFile(getThreadsFilePath(), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const threads = legacyThreads(value);
  const directory = getThreadsDirectoryPath();
  const staging = `${directory}.migrating-${process.pid}-${Date.now()}`;
  await fs.mkdir(staging, { recursive: false });
  try {
    const entries = [];
    for (const thread of threads) {
      const split = splitThread(thread, staging);
      for (const file of split.files) await fs.writeFile(file.path, file.raw, 'utf8');
      entries.push(migratedEntry(split.entry, sha256(JSON.stringify(thread)), { recoverable: false }));
    }
    const manifest = { version: MANIFEST_VERSION, revision: 1, entries };
    await writeManifest(manifest, null, staging);
    await fs.rename(staging, directory);
    manifestCache = null;
    try {
      await fs.rename(getThreadsFilePath(), backupPath());
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
  if (!existsSync(getThreadsFilePath())) return null;
  const threads = legacyThreads(readFileSync(getThreadsFilePath(), 'utf8'));
  const directory = getThreadsDirectoryPath();
  const staging = `${directory}.migrating-${process.pid}-${Date.now()}`;
  mkdirSync(staging, { recursive: false });
  try {
    const entries = [];
    for (const thread of threads) {
      const split = splitThread(thread, staging);
      for (const file of split.files) writeFileSync(file.path, file.raw, 'utf8');
      entries.push(migratedEntry(split.entry, sha256(JSON.stringify(thread)), { recoverable: false }));
    }
    const manifest = { version: MANIFEST_VERSION, revision: 1, entries };
    writeManifestSync(manifest, null, 'manifest.sync.tmp', staging);
    renameSync(staging, directory);
    manifestCache = null;
    archiveLegacyFile(renameSync);
    return manifest;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
};

// Once per process, before anything is written: remove files no manifest
// entry names — version 2 thread files and their search files after the
// migration, files an interrupted migration or save left behind, versions
// whose cleanup didn't run. Synchronous, so no save can commit in between
// and have its fresh files taken for leftovers. Temporary files of writes in
// flight are left alone.
let swept = false;
const THREAD_FILE =
  /^(?:[A-Za-z0-9_-]+\.[0-9a-f]{64}\.(?:shell\.json|transcript\.json|search|json|json\.search)|manifest\.[0-9a-f]{2}\.[0-9a-f]{64}\.json)$/;
// Files this young may belong to a save that has written them but not yet
// committed the manifest that names them; a later launch sweeps them if
// they really are leftovers.
const SWEEP_MIN_AGE_MS = 10 * 60 * 1000;
const LEGACY_THREAD_FILE = /^[A-Za-z0-9_-]+\.[0-9a-f]{64}\.(?:json|json\.search)$/;
// `<file>.<pid>.<kind>.tmp`: a write that never got renamed into place
// (a crash, a full disk). Swept once old enough to belong to no live write.
const TEMP_FILE = /\.\d+\.[a-z.]*tmp$/;
// The files a manifest names, for the sweep: the current one's and the
// previous root's (still the fallback).
const keptFiles = (manifest) => {
  const keep = new Set([MANIFEST_FILE, PREVIOUS_MANIFEST_FILE, ...liveFiles(manifest)]);
  try {
    for (const name of liveFiles(readPreviousManifestSync(getThreadsDirectoryPath()))) keep.add(name);
  } catch {}
  return keep;
};

const LEGACY_SEARCH_FILE = /^[A-Za-z0-9_-]+\.[0-9a-f]{64}\.json\.search$/;

const sweepUnreferencedFiles = (readManifest) => {
  if (swept || readManifest.version !== MANIFEST_VERSION) return;
  swept = true;
  // The manifest passed in may predate a save that committed since it was
  // read: decide against the one committed now.
  let manifest = readManifest;
  try {
    const current = readManifestFileSync();
    if (current?.version !== MANIFEST_VERSION) return;
    manifest = current;
  } catch {
    return;
  }
  const directory = getThreadsDirectoryPath();
  const sweepStartedAt = Date.now();
  const keep = keptFiles(manifest);
  // Damaged roots kept for recovery by hand (for a week): every file of the
  // threads one names is kept with it; one that can't be read keeps all.
  const protectedIds = new Set();
  let protectAll = false;
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    const damaged = DAMAGED_MANIFEST_FILE.exec(name);
    if (!damaged) continue;
    if (sweepStartedAt - Number(damaged[1]) > DAMAGED_KEEP_MS) {
      rmSync(path.join(directory, name), { force: true });
      continue;
    }
    try {
      const order = JSON.parse(readFileSync(path.join(directory, name), 'utf8'))?.order;
      if (!Array.isArray(order)) throw new Error('No order.');
      for (const id of order) if (typeof id === 'string') protectedIds.add(encodeId(id));
    } catch {
      protectAll = true;
    }
  }
  let legacyThreadFiles = 0;
  for (const name of names) {
    if (keep.has(name)) continue;
    if (!TEMP_FILE.test(name) && (protectAll || protectedIds.has(name.slice(0, name.indexOf('.'))))) {
      if (LEGACY_THREAD_FILE.test(name) && !LEGACY_SEARCH_FILE.test(name)) legacyThreadFiles += 1;
      continue;
    }
    const temp = TEMP_FILE.test(name);
    if (!temp && !THREAD_FILE.test(name)) continue;
    // Version 2 thread files go only through retireLegacyThreadFiles, which
    // first verifies the new files (their search files are disposable).
    if (!temp && LEGACY_THREAD_FILE.test(name) && !LEGACY_SEARCH_FILE.test(name)) {
      legacyThreadFiles += 1;
      continue;
    }
    try {
      const filePath = path.join(directory, name);
      // Files this young may belong to a write still in flight.
      if (!LEGACY_SEARCH_FILE.test(name) && sweepStartedAt - statSync(filePath).mtimeMs < SWEEP_MIN_AGE_MS) continue;
      rmSync(filePath, { force: true });
    } catch {}
  }
  if (legacyThreadFiles > 0 && !migratedThisLaunch) scheduleLegacyRetirement();
};

// ---------------------------------------------------------------------------
// Retiring version 2 files. They stay through the launch that migrated, then
// go one at a time in the background once the thread's new files verify
// (content hashes, not sizes): a damaged new file is rewritten from the old
// one first, and the old one kept until a later launch verifies it. Version 2
// files of threads that changed or were deleted since are outdated copies.
const LEGACY_RETIRE_DELAY_MS = 30_000;
const LEGACY_RETIRE_CONCURRENCY = 2;
let legacyRetirement = null;
const scheduleLegacyRetirement = () => {
  if (legacyRetirement) return;
  legacyRetirement = setTimeout(() => {
    void retireLegacyThreadFiles().catch((error) => console.warn('Could not retire version 2 Orion thread files', error));
  }, LEGACY_RETIRE_DELAY_MS);
  legacyRetirement.unref?.();
};

const legacyFileParts = (name) => {
  const match = /^([A-Za-z0-9_-]+)\.([0-9a-f]{64})\.json$/.exec(name);
  if (!match) return null;
  try {
    return { id: Buffer.from(match[1], 'base64url').toString('utf8'), hash: match[2] };
  } catch {
    return null;
  }
};

/** Remove the version 2 thread files whose new copies verify. Returns how many went. */
export const retireLegacyThreadFiles = async () => {
  if (migratedThisLaunch) return 0;
  const manifest = await ensureManifest();
  if (manifest?.version !== MANIFEST_VERSION) return 0;
  const directory = getThreadsDirectoryPath();
  const names = (await fs.readdir(directory)).filter((name) => legacyFileParts(name));
  // The previous root (the recovery fallback) may still point at a v2 file
  // the current entry no longer does: keep it until that root moves on.
  const previousPointers = new Set();
  try {
    for (const entry of readPreviousManifestSync(directory).entries) {
      if (entry.legacyHash) previousPointers.add(legacyThreadFileName(entry.id, entry.legacyHash));
    }
  } catch {}
  let retired = 0;
  await mapConcurrent(names, LEGACY_RETIRE_CONCURRENCY, async (name) => {
    const { id, hash } = legacyFileParts(name);
    const current = (await ensureManifest())?.entries.find((entry) => entry.id === id);
    if (current?.unreadableFile === name) return;
    if (previousPointers.has(name) && current?.legacyHash !== hash) return;
    // The current entry still takes its transcript (and, until its first
    // save, its shell) from the migration: verify those files before this
    // copy goes. Shell-only saves keep the pointer, so a renamed or pinned
    // thread whose transcript never reached the disk keeps its copy.
    if (current && current.legacyHash === hash) {
      let damaged = false;
      try {
        await readTranscriptFileOf(current);
      } catch {
        damaged = true;
        await recoverFromLegacy(current, 'transcript');
      }
      if (current.syncHash === hash) {
        try {
          await readShellFileOf(current);
        } catch {
          damaged = true;
          await recoverFromLegacy(current, 'shell');
        }
      }
      // Keep it until a later run verifies the rewritten files.
      if (damaged) return;
    }
    await fs.rm(path.join(directory, name), { force: true });
    retired += 1;
  });
  return retired;
};

const ensureManifest = async ({ create = false } = {}) => {
  let manifest = null;
  try {
    manifest = await readManifestFile();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (manifest?.version === LEGACY_MANIFEST_VERSION) manifest = await migrateFromV2(manifest);
  if (manifest) {
    sweepUnreferencedFiles(manifest);
    return manifest;
  }
  // A threads directory without its commit-point manifest is an interrupted
  // or damaged write. Never treat it as an empty workspace and overwrite the
  // still-recoverable thread files inside it.
  if (existsSync(getThreadsDirectoryPath())) {
    if (create && initializingStorage) return emptyManifest();
    throw new Error('Orion threads directory is missing its manifest.');
  }
  const migrated = await migrateLegacy();
  if (migrated) return migrated;
  if (!create) return null;
  initializingStorage = true;
  await fs.mkdir(getThreadsDirectoryPath(), { recursive: true });
  return emptyManifest();
};

const ensureManifestSync = ({ create = false } = {}) => {
  let manifest = null;
  try {
    manifest = readManifestFileSync();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (manifest?.version === LEGACY_MANIFEST_VERSION) manifest = migrateFromV2Sync(manifest);
  if (manifest) {
    sweepUnreferencedFiles(manifest);
    return manifest;
  }
  if (existsSync(getThreadsDirectoryPath())) {
    if (create && initializingStorage) return emptyManifest();
    throw new Error('Orion threads directory is missing its manifest.');
  }
  const migrated = migrateLegacySync();
  if (migrated) return migrated;
  if (!create) return null;
  initializingStorage = true;
  mkdirSync(getThreadsDirectoryPath(), { recursive: true });
  return emptyManifest();
};

// ---------------------------------------------------------------------------
// Patches.

const withoutSummary = (thread) => {
  if (!('summary' in thread)) return thread;
  const { summary: _summary, ...rest } = thread;
  return rest;
};

const lastById = (threads) => [...new Map(threads.map((thread) => [thread.id, thread])).values()];

// A patch carries full upserts (a thread with its transcript), shell-only
// upserts (`shells`: every field but the transcript — the stored transcript
// is kept, and isn't even read), deletes, and optionally the full order.
const normalizePatch = (patch) => {
  if (!patch || typeof patch !== 'object' || patch.version !== PATCH_VERSION) {
    throw new Error('Invalid Orion threads patch.');
  }
  const upserts = lastById((Array.isArray(patch.upserts) ? patch.upserts : []).map(assertThread).map(withoutSummary));
  const upsertIds = new Set(upserts.map((thread) => thread.id));
  const shells = lastById((Array.isArray(patch.shells) ? patch.shells : []).map(assertThread).map(withoutSummary))
    // A full upsert of the same thread already carries every field.
    .filter((shell) => !upsertIds.has(shell.id));
  const writtenIds = new Set([...upsertIds, ...shells.map((shell) => shell.id)]);
  const deletes = Array.isArray(patch.deletes)
    ? patch.deletes.filter((id) => typeof id === 'string' && id)
    : [];
  const order = Array.isArray(patch.order)
    ? patch.order.filter((id) => typeof id === 'string' && id)
    : null;
  return { upserts, shells, deletes: deletes.filter((id) => !writtenIds.has(id)), order };
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

// The files a manifest entry names.
const entryFiles = (entry) => [
  ...(entry.shellHash ? [shellFileName(entry.id, entry.shellHash)] : []),
  ...(entry.transcriptHash
    ? [transcriptFileName(entry.id, entry.transcriptHash), searchFileName(entry.id, entry.transcriptHash)]
    : []),
  ...(entry.unreadableFile ? [entry.unreadableFile] : []),
];

// Async patch writes and version cleanups run one at a time: a shell that
// goes back to an earlier version (pin, then unpin) rewrites a file that a
// cleanup may be about to remove, and must not lose it between its write and
// its manifest commit. (Synchronous writes can't interleave with either.)
let storageChain = Promise.resolve();
const serialized = (task) => {
  const run = storageChain.then(task, task);
  storageChain = run.catch(() => {});
  return run;
};

// Files of versions the new manifest no longer names, removed a moment later
// (a reader may still be on the previous manifest; it retries on ENOENT).
// Checked against the newest manifest and removed in one synchronous step.
const liveFiles = (manifest) => new Set([...manifest.entries.flatMap(entryFiles), ...manifestFileNames(manifest)]);
// The manifest each commit replaced: the previous root names it, so its
// files stay until the commit after next.
let retainedPrevious = null;
const scheduleVersionCleanup = (previous, updated) => {
  const older = retainedPrevious;
  retainedPrevious = previous;
  if (!older) return;
  const live = new Set([...liveFiles(previous), ...liveFiles(updated)]);
  const retired = [...liveFiles(older)].filter((name) => !live.has(name));
  if (retired.length === 0) return;
  const timer = setTimeout(() => {
    void serialized(() => {
      try {
        const latest = ensureManifestSync();
        const stillLive = new Set([
          ...(latest ? liveFiles(latest) : []),
          ...(retainedPrevious ? liveFiles(retainedPrevious) : []),
        ]);
        for (const name of retired) {
          if (!stillLive.has(name)) rmSync(inDirectory(name), { force: true });
        }
      } catch {}
    });
  }, 1000);
  timer.unref?.();
};

// Commit `updated` (computed from `previous`): keep the root being replaced
// as the fallback, then write the new shards and root.
const keepRootAsPrevious = () => {
  const linkPath = `${previousManifestPath()}.${process.pid}.link.tmp`;
  try {
    rmSync(linkPath, { force: true });
    linkSync(manifestPath(), linkPath);
    renameSync(linkPath, previousManifestPath());
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('Could not keep the previous Orion threads manifest', error);
  }
};
const commitManifestSync = (updated, previous) => {
  if (manifestShards.get(previous) && previous.version === MANIFEST_VERSION) keepRootAsPrevious();
  writeManifestSync(updated, previous);
  initializingStorage = false;
  scheduleVersionCleanup(previous, updated);
};

// Whether `manifest` is still the committed one (a synchronous save — quit,
// window reload — may have committed since it was read).
const isCommittedManifest = (manifest) => {
  try {
    return readManifestFileSync() === manifest;
  } catch (error) {
    if (error?.code === 'ENOENT') return manifest.entries.length === 0 && !manifestShards.has(manifest);
    throw error;
  }
};

// The files and entry for each thread in a patch, one thread at a time.
async function* patchWrites(normalized, manifest) {
  const byId = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const directory = getThreadsDirectoryPath();
  for (const thread of normalized.upserts) yield splitThread(thread, directory);
  for (const shell of normalized.shells) {
    const previous = byId.get(shell.id);
    let storedShell = null;
    if (previous?.shellHash) {
      try {
        storedShell = await readEntryShell(previous);
      } catch (error) {
        console.warn(`Could not read the stored shell of Orion thread ${shell.id}`, error);
      }
    }
    yield shellOnlyEntry(shell, previous, storedShell, directory);
  }
}

function* patchWritesSync(normalized, manifest) {
  const byId = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const directory = getThreadsDirectoryPath();
  for (const thread of normalized.upserts) yield splitThread(thread, directory);
  for (const shell of normalized.shells) {
    const previous = byId.get(shell.id);
    let storedShell = null;
    if (previous?.shellHash) {
      try {
        storedShell = JSON.parse(readShellRawOfSync(previous));
      } catch (error) {
        console.warn(`Could not read the stored shell of Orion thread ${shell.id}`, error);
      }
    }
    yield shellOnlyEntry(shell, previous, storedShell, directory);
  }
}

export const writeThreadsPatch = (patch) => serialized(() => writeThreadsPatchNow(patch));

const REBASE_ATTEMPTS = 5;

// A patch rebased onto a manifest committed after the one it was computed
// from. The renderer saves in order, so whatever committed meanwhile (the
// quit or reload flush) is newer state: for every thread it touched, it
// wins, and this patch's upsert, shell or delete of that thread is dropped
// (the newer commit already carries in-flight threads). The rest applies.
// The order goes too: the newer commit's order is the newer one.
const rebasePatch = (normalized, base, current) => {
  const baseIds = new Map(base.entries.map((entry) => [entry.id, entry.hash]));
  const currentIds = new Map(current.entries.map((entry) => [entry.id, entry.hash]));
  const unchanged = (id) => (baseIds.get(id) ?? null) === (currentIds.get(id) ?? null);
  return {
    upserts: normalized.upserts.filter((thread) => unchanged(thread.id)),
    shells: normalized.shells.filter((shell) => unchanged(shell.id)),
    deletes: normalized.deletes.filter((id) => unchanged(id)),
    order: null,
  };
};

const writeThreadsPatchNow = async (patch) => {
  let normalized = normalizePatch(patch);
  for (let attempt = 1; ; attempt += 1) {
    const manifest = await ensureManifest({ create: true });
    const metadata = [];
    for await (const write of patchWrites(normalized, manifest)) {
      for (const file of write.files) await writeVersionFile(file.path, file.raw, file.suffix);
      metadata.push(write.entry);
    }
    // The commit is synchronous, and only on top of the manifest the entries
    // were computed from. If a synchronous save committed while these files
    // were written, rebase: its threads keep its (newer) state, and the rest
    // of this patch is computed again on top of it.
    if (!isCommittedManifest(manifest)) {
      if (attempt >= REBASE_ATTEMPTS) throw new Error('Orion thread storage kept changing during a save.');
      normalized = rebasePatch(normalized, manifest, readManifestFileSync());
      continue;
    }
    const updated = nextManifest(manifest, normalized, metadata);
    commitManifestSync(updated, manifest);
    return updated;
  }
};

export const writeThreadsPatchSync = (patch) => {
  const normalized = normalizePatch(patch);
  const manifest = ensureManifestSync({ create: true });
  const metadata = [];
  for (const write of patchWritesSync(normalized, manifest)) {
    for (const file of write.files) writeVersionFileSync(file.path, file.raw, file.suffix.replace('.tmp', '.sync.tmp'));
    metadata.push(write.entry);
  }
  const updated = nextManifest(manifest, normalized, metadata);
  commitManifestSync(updated, manifest);
  return updated;
};

// ---------------------------------------------------------------------------
// Readers.

export const readThreadsIndex = async () => (await ensureManifest()) ?? emptyManifest();

export const readThreadById = async (id) => {
  const manifest = await ensureManifest();
  const entry = manifest?.entries.find((candidate) => candidate.id === id);
  if (!entry) return null;
  return readEntry(entry);
};

// The verified stored JSON of one whole thread, read synchronously: the
// renderer's quit-time flush uses it for changes still waiting on a
// transcript load. Null when the thread isn't stored.
export const readThreadRawSync = (id) => {
  const manifest = ensureManifestSync();
  const entry = manifest?.entries.find((candidate) => candidate.id === id);
  if (!entry) return null;
  return joinThreadRaw(readShellRawOfSync(entry), readTranscriptRawOfSync(entry));
};

// The version of a thread workspace sync uploads it under: the hash it was
// uploaded under before the storage upgrade while the thread is still at its
// migrated version, the entry's own version hash after that.
export const syncVersionOf = (entry) => entry.syncHash ?? entry.hash;

/**
 * Stored threads for workspace sync, each with the sync version of exactly
 * the stored version that was read (a save between the index and this read
 * is uploaded under its own version, never an older one). A thread that
 * can't be read is reported, not thrown, so it doesn't stop the others.
 */
export const readThreadsForSync = async (ids) => {
  const manifest = await ensureManifest();
  if (!manifest) return [];
  const available = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const results = [];
  for (const id of ids) {
    let entry = available.get(id);
    if (!entry) continue;
    try {
      let raw;
      try {
        raw = await readThreadRawOf(entry);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        const current = (await ensureManifest())?.entries.find((candidate) => candidate.id === id);
        if (!current || current.hash === entry.hash) throw error;
        entry = current;
        raw = await readThreadRawOf(entry);
      }
      results.push({ thread: assertThread(JSON.parse(raw)), version: syncVersionOf(entry) });
    } catch (error) {
      results.push({ id, version: syncVersionOf(entry), error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
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

// Startup hydration. Every thread's shell (from the manifest: no thread file
// is read), plus the whole stored threads the renderer names (its open
// panes), as JSON text assembled from the manifest and the verified file
// bytes. The renderer loads any other transcript when it needs it
// (readThreadsBatch).
export const readThreadShells = async ({ ids = [] } = {}) => {
  const manifest = await ensureManifest();
  if (!manifest) {
    return JSON.stringify({ version: PATCH_VERSION, present: false, shells: [], threads: [] });
  }
  const wanted = new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string'));
  // A thread that can't be read here stays unloaded; the renderer retries it
  // like any other lazy load.
  const raws = (
    await mapConcurrent(manifest.entries.filter((entry) => wanted.has(entry.id)), READ_CONCURRENCY, (entry) =>
      readEntryRaw(entry).catch((error) => {
        console.warn(`Could not read Orion thread ${entry.id}`, error);
        return null;
      })
    )
  ).filter((raw) => raw !== null);
  const shells = manifest.entries.map((entry) => JSON.stringify({ ...entry.shell, id: entry.id, summary: entry.summary }));
  return `{"version":${PATCH_VERSION},"present":true,"shells":[${shells.join(',')}],"threads":[${raws.join(',')}]}`;
};

// Stored threads by id, in responses of about `maxBytes`. `consumed` says
// how many of `ids` this response covered (ids no longer stored are skipped),
// so the caller continues from there. One thread larger than the budget is
// returned alone rather than blocking the rest.
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
  return `{"version":${PATCH_VERSION},"consumed":${consumed},"threads":[${raws.join(',')}]}`;
};

// ---------------------------------------------------------------------------
// Full-text search over every stored transcript, so the renderer doesn't need
// them in memory. Each transcript version has a search-text file (one
// normalized line per message); while searches keep coming the texts stay in
// memory, and they are dropped a minute after the last one.

const SEARCH_CACHE_MS = 60_000;
// Search texts kept in memory between searches, by total length, so a
// search never holds every transcript's text at once. Every search scans all
// of them in the same order, so the cache admits texts until it is full and
// then stops (no eviction): a recency policy would evict, on each scan, just
// what the next scan needs first, and hit almost nothing.
const SEARCH_CACHE_CHARS = 48 * 1024 * 1024;
const SEARCH_CONCURRENCY = 32;
const MAX_SEARCH_TOKENS = 16;
const MAX_EXCERPT_ITEMS = 100;
let searchTexts = new Map();
let searchTextsChars = 0;
let searchCacheTimer = null;

const forgetSearchText = (key) => {
  const text = searchTexts.get(key);
  if (text === undefined) return;
  searchTexts.delete(key);
  searchTextsChars -= text.length;
};
const clearSearchTexts = () => {
  searchTexts = new Map();
  searchTextsChars = 0;
};
const rememberSearchText = (key, text) => {
  if (searchTexts.has(key) || searchTextsChars + text.length > SEARCH_CACHE_CHARS) return;
  searchTexts.set(key, text);
  searchTextsChars += text.length;
};
const cachedSearchText = (key) => searchTexts.get(key);

const keepSearchTexts = () => {
  if (searchCacheTimer) clearTimeout(searchCacheTimer);
  searchCacheTimer = setTimeout(() => {
    searchCacheTimer = null;
    clearSearchTexts();
  }, SEARCH_CACHE_MS);
  searchCacheTimer.unref?.();
};

const searchKey = (entry) => `${entry.id}\u0000${entry.transcriptHash}`;

// The search text of exactly the transcript version `entry` names: built
// from that version's file when missing, never from a newer one (which would
// file it under the wrong name). A version removed meanwhile is skipped; the
// next search sees its replacement.
const searchTextFor = async (entry) => {
  if (!entry.transcriptHash) return null;
  const key = searchKey(entry);
  const cached = cachedSearchText(key);
  if (cached !== undefined) return cached;
  const filePath = inDirectory(searchFileName(entry.id, entry.transcriptHash));
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    try {
      text = searchTextOf(JSON.parse(await readTranscriptRawOf(entry)));
    } catch {
      return null;
    }
    await writeAtomic(filePath, text, 'search.tmp').catch(() => {});
  }
  rememberSearchText(key, text);
  return text;
};

// Every stored thread's search text in turn, a few at a time: `visit` sees
// each one and nothing keeps it beyond the bounded cache. Stops early (and
// resolves false) once `cancelled()` says the scan was superseded.
const forEachSearchText = async (visit, cancelled = () => false) => {
  const manifest = await ensureManifest();
  const entries = manifest?.entries ?? [];
  const live = new Set(entries.map(searchKey));
  for (const key of [...searchTexts.keys()]) if (!live.has(key)) forgetSearchText(key);
  await mapConcurrent(entries, SEARCH_CONCURRENCY, async (entry) => {
    if (cancelled()) return;
    const text = await searchTextFor(entry);
    if (text && !cancelled()) visit(entry, text);
  });
  keepSearchTexts();
  return !cancelled();
};

// One scan at a time. A new query supersedes the scan in flight (typing
// "hello" asks for "he", "hel", "hell", "hello" in turn: only the last one
// is worth finishing); a warm-up never supersedes a query.
let scanGeneration = 0;
let scanChain = Promise.resolve();
const runScan = (visit, { supersede }) => {
  const generation = supersede ? ++scanGeneration : scanGeneration;
  const cancelled = () => generation !== scanGeneration;
  const run = scanChain.then(() => (cancelled() ? false : forEachSearchText(visit, cancelled)));
  scanChain = run.catch(() => {});
  return run;
};

const searchTokens = (tokens) =>
  Array.isArray(tokens)
    ? [...new Set(tokens.filter((token) => typeof token === 'string' && token && token.length <= 200))].slice(
        0,
        MAX_SEARCH_TOKENS
      )
    : [];

/** Build missing search texts (and fill the cache) ahead of a search, e.g. when search is about to open. */
export const warmThreadSearch = async () => {
  await runScan(() => {}, { supersede: false });
  return true;
};

/**
 * Transcript scores for the query tokens main scored (`tokens`: those within
 * the limits, in order), per thread that matched at least one, aligned with
 * `tokens` (scoreBodyToken: BODY_MATCH_WORD, BODY_MATCH_SUBSTRING or 0).
 * Null when a newer query superseded this one before it finished.
 */
export const searchThreadBodies = async ({ tokens = [] } = {}) => {
  const wanted = searchTokens(tokens);
  const results = {};
  if (wanted.length === 0) return { tokens: wanted, scores: results };
  const matches = [];
  const finished = await runScan(
    (entry, text) => {
      let any = false;
      const scores = wanted.map((token) => {
        const score = scoreBodyToken([text], token);
        if (score > 0) any = true;
        return score;
      });
      if (any) matches.push([entry.id, scores]);
    },
    { supersede: true }
  );
  if (!finished) return null;
  for (const [id, scores] of matches) results[id] = scores;
  return { tokens: wanted, scores: results };
};

/** The excerpt each listed thread shows in search results (transcriptExcerpt), by id. */
export const searchThreadExcerpts = async ({ items = [] } = {}) => {
  const manifest = await ensureManifest();
  const byId = new Map((manifest?.entries ?? []).map((entry) => [entry.id, entry]));
  const list = (Array.isArray(items) ? items : []).slice(0, MAX_EXCERPT_ITEMS);
  const excerpts = {};
  await mapConcurrent(list, READ_CONCURRENCY, async (item) => {
    const entry = typeof item?.id === 'string' ? byId.get(item.id) : undefined;
    if (!entry) return;
    try {
      // The cached per-message lines belong to this version: use them only
      // with this version's messages (a newer one is read without them).
      let transcript;
      let body;
      try {
        transcript = JSON.parse(await readTranscriptRawOf(entry));
        body = cachedSearchText(searchKey(entry))?.split('\n');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        transcript = await readEntryTranscript(entry);
      }
      excerpts[entry.id] = transcriptExcerpt(transcript.messages, searchTokens(item.tokens), body);
    } catch {}
  });
  return excerpts;
};

export const clearThreadsStorage = async () => {
  initializingStorage = false;
  manifestCache = null;
  shardCache = new Map();
  clearSearchTexts();
  await Promise.all([
    fs.rm(getThreadsDirectoryPath(), { recursive: true, force: true }),
    fs.rm(getThreadsFilePath(), { force: true }),
    fs.rm(backupPath(), { force: true }),
  ]);
};

// Tests only: forget what this process learned about the storage (the
// cached manifest, the one-time sweep), as a fresh launch would.
export const resetThreadStorageStateForTests = () => {
  migratedThisLaunch = false;
  reportedDamage = false;
  retainedPrevious = null;
  if (legacyRetirement) clearTimeout(legacyRetirement);
  legacyRetirement = null;
  manifestCache = null;
  shardCache = new Map();
  swept = false;
  initializingStorage = false;
  clearSearchTexts();
};
