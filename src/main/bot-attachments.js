import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Local staging + background cloud upload for bot message attachments.
 *
 * Sending a message with files no longer blocks on uploading them to Durango's
 * library:
 * 1. Each attached file is copied into a local staging folder immediately and
 *    given a `pendingId`, so the message posts right away and any bot reply
 *    running on this same computer reads the local copy straight away without
 *    waiting for the upload or downloading the file back.
 * 2. Each file uploads to Durango in the background (`POST /api/v1/bots/attachments`
 *    with `botId`/`messageId`/`pendingId`, falling back to `PATCH .../attachments`),
 *    so phone, web, other machines, cloud replies and history get it too.
 * 3. Upload progress, completion and failure are reported to the renderer and
 *    failed uploads can be retried from the staged local copy.
 */

const SAFE_ID = /[^A-Za-z0-9_-]/g;
const MAX_TRACKED_ENTRIES = 200;
const STAGED_MAX_AGE_MS = 24 * 60 * 60_000;

const safeFileName = (name) =>
  String(name ?? 'file')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 120) || 'file';

const safeDirPart = (value) => String(value ?? 'msg').replace(SAFE_ID, '_').slice(0, 80) || 'msg';

const shortError = (error) => {
  const message = String(error?.message ?? error ?? 'Upload failed.').trim();
  return message.length <= 180 ? message || 'Upload failed.' : `${message.slice(0, 179).trimEnd()}…`;
};

/** Broad asset kind matching Durango's library kinds (hint only; server re-classifies on upload). */
export const attachmentKindFor = (contentType, name = '') => {
  const type = String(contentType ?? '').toLowerCase();
  const ext = path.extname(String(name ?? '')).toLowerCase();
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|apng|heic|heif|svg)$/.test(ext)) return 'image';
  if (type.startsWith('video/') || /\.(mp4|mov|webm|m4v|mkv)$/.test(ext)) return 'video';
  if (type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac|aac)$/.test(ext)) return 'audio';
  if (type === 'application/pdf' || ext === '.pdf') return 'pdf';
  return 'file';
};

export const newPendingAttachmentId = () => `att_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

export const createBotAttachmentManager = ({
  stagingDir,
  client,
  copyFile = (from, to) => fs.copyFile(from, to),
  readFile = (filePath) => fs.readFile(filePath),
  mkdir = (dir) => fs.mkdir(dir, { recursive: true }),
  stat = (filePath) => fs.stat(filePath),
  rm = (target) => fs.rm(target, { recursive: true, force: true }),
  readdir = (dir) => fs.readdir(dir, { withFileTypes: true }),
  randomId = newPendingAttachmentId,
  now = () => Date.now(),
  onChange = () => {},
  log = (...args) => console.warn('[bot attachments]', ...args),
}) => {
  const byPendingId = new Map(); // pendingId -> entry
  const byAssetId = new Map(); // assetId -> entry
  const dirOf = () => (typeof stagingDir === 'function' ? stagingDir() : stagingDir);

  const snapshotOf = (entry) => ({
    botId: entry.botId,
    messageId: entry.messageId,
    pendingId: entry.pendingId,
    name: entry.name,
    size: entry.size,
    contentType: entry.contentType,
    kind: entry.kind,
    localPath: entry.localPath,
    status: entry.status,
    ...(entry.assetId ? { assetId: entry.assetId } : {}),
    ...(entry.error ? { error: entry.error } : {}),
    canRetry: entry.status === 'failed',
  });

  const emit = (entry) => {
    try {
      onChange(snapshotOf(entry));
    } catch {}
  };

  const pruneMemory = () => {
    while (byPendingId.size > MAX_TRACKED_ENTRIES) {
      let oldestKey = null;
      for (const [key, entry] of byPendingId) {
        if (!entry.inFlight && entry.status !== 'failed') {
          oldestKey = key;
          break;
        }
      }
      if (!oldestKey) oldestKey = byPendingId.keys().next().value;
      const dropped = byPendingId.get(oldestKey);
      byPendingId.delete(oldestKey);
      if (dropped?.assetId && byAssetId.get(dropped.assetId) === dropped) byAssetId.delete(dropped.assetId);
    }
  };

  /** Copies `files` into the local staging folder and tracks them as uploading. */
  const stageFiles = async ({ botId, messageId, files }) => {
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return [];
    const messageDir = path.join(dirOf(), safeDirPart(messageId));
    await mkdir(messageDir);
    const staged = [];
    for (const file of list) {
      const pendingId = randomId();
      const name = String(file.name || path.basename(file.path) || 'file').slice(0, 200);
      const contentType = String(file.contentType || 'application/octet-stream').slice(0, 120);
      const size = Number(file.size) || 0;
      const target = path.join(messageDir, `${pendingId}-${safeFileName(name)}`);
      await copyFile(file.path, target);
      const entry = {
        botId,
        messageId,
        pendingId,
        name,
        size,
        contentType,
        kind: attachmentKindFor(contentType, name),
        localPath: target,
        status: 'uploading',
        assetId: null,
        error: null,
        inFlight: false,
        createdAt: now(),
      };
      byPendingId.set(pendingId, entry);
      staged.push(entry);
    }
    pruneMemory();
    for (const entry of staged) emit(entry);
    return staged.map(snapshotOf);
  };

  /** Discards staged files for a message whose initial send failed before reaching Durango. */
  const discardMessage = async (messageId) => {
    for (const [key, entry] of byPendingId) {
      if (entry.messageId !== messageId) continue;
      byPendingId.delete(key);
      if (entry.assetId && byAssetId.get(entry.assetId) === entry) byAssetId.delete(entry.assetId);
    }
    await rm(path.join(dirOf(), safeDirPart(messageId))).catch(() => {});
  };

  const uploadOne = async (entry, { account, notifyUploading = false } = {}) => {
    if (entry.inFlight || entry.status === 'ready') return snapshotOf(entry);
    entry.inFlight = true;
    entry.status = 'uploading';
    entry.error = null;
    emit(entry);
    if (notifyUploading && typeof client.updateBotMessageAttachment === 'function') {
      void client
        .updateBotMessageAttachment({
          botId: entry.botId,
          messageId: entry.messageId,
          pendingId: entry.pendingId,
          status: 'uploading',
          account,
        })
        .catch(() => {});
    }
    try {
      const bytes = await readFile(entry.localPath);
      const uploaded = await client.uploadBotAttachment({
        name: entry.name,
        bytes,
        contentType: entry.contentType,
        account,
        botId: entry.botId,
        messageId: entry.messageId,
        pendingId: entry.pendingId,
      });
      const part = uploaded?.part;
      const assetId = part?.asset?.id;
      if (!assetId) throw new Error('Durango did not return the uploaded file.');
      if (uploaded?.attached !== true && typeof client.updateBotMessageAttachment === 'function') {
        await client.updateBotMessageAttachment({
          botId: entry.botId,
          messageId: entry.messageId,
          pendingId: entry.pendingId,
          status: 'included',
          part,
          account,
        });
      }
      entry.status = 'ready';
      entry.assetId = assetId;
      entry.error = null;
      entry.inFlight = false;
      byAssetId.set(assetId, entry);
      emit(entry);
      return snapshotOf(entry);
    } catch (error) {
      const message = shortError(error);
      entry.status = 'failed';
      entry.error = message;
      entry.inFlight = false;
      emit(entry);
      log(`upload failed for ${entry.name} (${entry.pendingId}):`, message);
      if (typeof client.updateBotMessageAttachment === 'function') {
        void client
          .updateBotMessageAttachment({
            botId: entry.botId,
            messageId: entry.messageId,
            pendingId: entry.pendingId,
            status: 'failed',
            error: message,
            account,
          })
          .catch(() => {});
      }
      return snapshotOf(entry);
    }
  };

  /** Starts background uploads for `pendingIds` in parallel. */
  const startUploads = ({ pendingIds, account }) => {
    const entries = (Array.isArray(pendingIds) ? pendingIds : [])
      .map((id) => byPendingId.get(id))
      .filter(Boolean);
    return Promise.all(entries.map((entry) => uploadOne(entry, { account })));
  };

  /** Retries a failed background upload from its local staged copy. */
  const retryUpload = async ({ botId, messageId, pendingId, account }) => {
    const entry = byPendingId.get(pendingId);
    if (!entry || (botId && entry.botId !== botId) || (messageId && entry.messageId !== messageId)) {
      return { ok: false, error: 'That file is no longer available on this computer.' };
    }
    if (entry.status === 'ready') return { ok: true, item: snapshotOf(entry) };
    if (entry.inFlight) return { ok: true, item: snapshotOf(entry) };
    const exists = await stat(entry.localPath)
      .then((info) => info?.isFile() === true)
      .catch(() => false);
    if (!exists) {
      return { ok: false, error: 'That file is no longer on this computer.' };
    }
    // Kick off in background so the UI flips back to "Uploading" immediately.
    void uploadOne(entry, { account, notifyUploading: true });
    return { ok: true, item: snapshotOf(entry) };
  };

  /**
   * Resolves a local file path for a machine reply attachment (by `pendingId`
   * while uploading OR by `assetId` / `id` after upload finishes), so this Mac
   * never waits for or re-downloads a file it sent itself.
   */
  const resolveLocalPath = (item) => {
    if (!item || typeof item !== 'object') return null;
    const entry =
      (typeof item.pendingId === 'string' && byPendingId.get(item.pendingId)) ||
      (typeof item.id === 'string' && byPendingId.get(item.id)) ||
      (typeof item.assetId === 'string' && byAssetId.get(item.assetId)) ||
      (typeof item.id === 'string' && byAssetId.get(item.id)) ||
      null;
    return entry?.localPath ?? null;
  };

  const listStatuses = ({ botId } = {}) => {
    const out = [];
    for (const entry of byPendingId.values()) {
      if (botId && entry.botId !== botId) continue;
      out.push(snapshotOf(entry));
    }
    return out;
  };

  /** Removes old staged directories from previous sessions on startup. */
  const pruneStagedFiles = async (maxAgeMs = STAGED_MAX_AGE_MS) => {
    const root = dirOf();
    const activeDirs = new Set([...byPendingId.values()].map((entry) => safeDirPart(entry.messageId)));
    const entries = await readdir(root).catch(() => []);
    const cutoff = now() - maxAgeMs;
    for (const dirent of entries) {
      if (!dirent?.isDirectory?.() || activeDirs.has(dirent.name)) continue;
      const full = path.join(root, dirent.name);
      const info = await stat(full).catch(() => null);
      if (info && info.mtimeMs < cutoff) await rm(full).catch(() => {});
    }
  };

  return {
    stageFiles,
    discardMessage,
    startUploads,
    retryUpload,
    resolveLocalPath,
    listStatuses,
    pruneStagedFiles,
  };
};
