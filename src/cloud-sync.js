// Orion Cloud git sync.
//
// Talks to orion-web's /api/git endpoints to push and pull git repositories
// without a server-side git binary. The desktop side (this module) does all
// git plumbing with the system git:
//
//   push: pack-objects an incremental packfile (everything the server's refs
//         don't reach), upload pack + per-branch file manifests + raw blobs
//         (for web browsing) via presigned URLs, then commit the ref moves
//         with a compare-and-swap so concurrent pushes/web edits can't clobber
//         each other.
//   pull: download packfiles and loose objects straight into .git/objects
//         (both are inert, content-addressed formats git reads natively),
//         point refs/remotes/orion/* at the server refs, then fast-forward
//         the current branch when possible.
//
// Pure Node — no Electron imports — so it can be exercised outside the app.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { createWriteStream, openAsBlob } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const MAX_GIT_BUFFER = 512 * 1024 * 1024;
const BLOB_URL_BATCH = 200;
const UPLOAD_CONCURRENCY = 6;
// Every request gets a deadline. A presigned-URL PUT that stalls (server gone,
// dev server rejecting a large body without draining it) otherwise hangs its
// fetch forever — pinning the request body in memory and wedging the caller's
// serialized sync queue behind it.
const API_TIMEOUT_MS = 60 * 1000;
const TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;

const deadlineSignal = (signal, timeoutMs) => {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

async function git(gitRoot, args, options = {}) {
  const { stdout } = await execFileAsync('git', ['-C', gitRoot, ...args], {
    maxBuffer: MAX_GIT_BUFFER,
    ...options,
  });
  return stdout.trim();
}

async function objectExists(gitRoot, oid, signal) {
  try {
    await git(gitRoot, ['cat-file', '-e', oid], { signal });
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

async function isAncestor(gitRoot, ancestor, descendant, signal) {
  try {
    await git(gitRoot, ['merge-base', '--is-ancestor', ancestor, descendant], { signal });
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

async function currentBranch(gitRoot, signal) {
  try {
    return (await git(gitRoot, ['symbolic-ref', '--short', '-q', 'HEAD'], { signal })) || null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

async function cloudTrackingRemote(gitRoot, signal) {
  try {
    const configured = await git(gitRoot, ['config', '--local', 'orion.sourcecontrol'], { signal });
    if (configured === 'orion') return 'origin';
  } catch {
    // Legacy cloud-linked repositories keep their separate `orion/*` refs.
  }
  return 'orion';
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function api(baseUrl, token, apiPath, options = {}) {
  const response = await fetch(new URL(apiPath, baseUrl), {
    ...options,
    signal: deadlineSignal(options.signal, API_TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    // non-JSON error body
  }
  if (!response.ok) {
    const error = new Error(data?.error || `Durango Cloud request failed (${response.status}).`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

// Smart-HTTP discovery lives behind the same bearer-authenticated CLI surface
// as repository provisioning. Keeping this server-provided avoids a packaged
// desktop accidentally targeting production while ORION_WEB_URL points at a
// local Orion Web instance (or vice versa).
export async function getCloudGitConnection({ baseUrl, token, signal }) {
  return await api(baseUrl, token, '/api/cli/whoami', { signal });
}

// POST /api/git/repos is intentionally strict about duplicate names. During a
// source-control conversion, a repo may already have been created from another
// machine, so adopt only an exact-name repo owned by this account. Never adopt
// a collaborator repo merely because its display name happens to match.
export async function findOwnedCloudRepo({ baseUrl, token, name, signal }) {
  const result = await api(baseUrl, token, '/api/cli/repos', { signal });
  return (
    (Array.isArray(result?.repos) ? result.repos : []).find(
      (repo) => repo?.role === 'owner' && repo?.name === name
    ) ?? null
  );
}

async function uploadTo(url, body, contentType = 'application/octet-stream', signal) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body,
    signal: deadlineSignal(signal, TRANSFER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Upload failed (${response.status}).`);
  }
}

// Uploads a file without reading it into memory: the file-backed Blob streams
// from disk with a known content-length. Packfiles reach gigabytes; buffering
// one (plus fetch's copy of the body) is how the main process ballooned to 5GB.
async function uploadFileTo(url, filePath, contentType, signal) {
  await uploadTo(url, await openAsBlob(filePath), contentType, signal);
}

async function download(url, signal) {
  const response = await fetch(url, { signal: deadlineSignal(signal, TRANSFER_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// Pack downloads can also reach gigabytes — stream them straight to disk.
async function downloadToFile(url, targetPath, signal) {
  const response = await fetch(url, { signal: deadlineSignal(signal, TRANSFER_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}).`);
  }
  const tempPath = `${targetPath}.orion-tmp-${process.pid}`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));
    await fs.rename(tempPath, targetPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function writeFileAtomic(targetPath, data) {
  const tempPath = `${targetPath}.orion-tmp-${process.pid}`;
  await fs.writeFile(tempPath, data);
  await fs.rename(tempPath, targetPath);
}

// --- Repo link (stored in the repo's local git config) -----------------------

export async function getCloudRepoLink(gitRoot) {
  try {
    const repoId = await git(gitRoot, ['config', '--local', 'orion.cloudrepoid']);
    if (!repoId) return null;
    let repoName = null;
    try {
      repoName = await git(gitRoot, ['config', '--local', 'orion.cloudreponame']);
    } catch {
      // optional
    }
    return { repoId, repoName };
  } catch {
    return null;
  }
}

export async function setCloudRepoLink(gitRoot, { repoId, repoName }) {
  await git(gitRoot, ['config', '--local', 'orion.cloudrepoid', repoId]);
  if (repoName) {
    await git(gitRoot, ['config', '--local', 'orion.cloudreponame', repoName]);
  }
}

export async function clearCloudRepoLink(gitRoot) {
  try {
    await git(gitRoot, ['config', '--local', '--unset', 'orion.cloudrepoid']);
    await git(gitRoot, ['config', '--local', '--unset', 'orion.cloudreponame']);
  } catch {
    // already unset
  }
}

// --- Local repo inspection ----------------------------------------------------

async function readLocalBranches(gitRoot, signal) {
  const output = await git(gitRoot, [
    'for-each-ref',
    'refs/heads',
    '--format=%(refname) %(objectname)',
  ], { signal });
  if (!output) return [];
  return output.split('\n').map((line) => {
    const [name, oid] = line.trim().split(' ');
    return { name, oid, branch: name.slice('refs/heads/'.length) };
  });
}

async function buildManifest(gitRoot, commitOid, signal) {
  const rootTree = await git(gitRoot, ['rev-parse', `${commitOid}^{tree}`], { signal });
  const raw = await git(
    gitRoot,
    ['ls-tree', '-r', '-t', '-l', '-z', '--full-tree', commitOid],
    { signal }
  );
  const entries = [];
  for (const record of raw.split('\0')) {
    if (!record) continue;
    const tabIndex = record.indexOf('\t');
    const [mode, type, oid, size] = record.slice(0, tabIndex).split(/\s+/);
    const entry = { path: record.slice(tabIndex + 1), mode, type, oid };
    if (type === 'blob') entry.size = size === '-' ? 0 : Number(size);
    entries.push(entry);
  }
  return { version: 1, commit: commitOid, rootTree, entries };
}

// Streams blob contents out of git without one process per blob.
async function* catFileBatch(gitRoot, oids, signal) {
  signal?.throwIfAborted();
  const child = spawn('git', ['-C', gitRoot, 'cat-file', '--batch'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const abort = () => child.kill();
  signal?.addEventListener('abort', abort, { once: true });
  child.stdin.write(oids.join('\n') + '\n');
  child.stdin.end();

  const chunks = child.stdout[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);

  const pull = async () => {
    const { value, done } = await chunks.next();
    if (done) throw new Error('git cat-file ended unexpectedly.');
    pending = Buffer.concat([pending, value]);
  };
  const readLine = async () => {
    let index;
    while ((index = pending.indexOf(10)) === -1) await pull();
    const line = pending.subarray(0, index).toString('utf8');
    pending = pending.subarray(index + 1);
    return line;
  };
  const readBytes = async (count) => {
    while (pending.length < count) await pull();
    const data = Buffer.from(pending.subarray(0, count));
    pending = pending.subarray(count);
    return data;
  };

  try {
    for (let index = 0; index < oids.length; index += 1) {
      signal?.throwIfAborted();
      const header = await readLine();
      const [oid, type, sizeText] = header.split(' ');
      if (type === 'missing' || sizeText === undefined) {
        yield { oid, missing: true };
        continue;
      }
      const content = await readBytes(Number(sizeText));
      await readBytes(1); // trailing newline
      yield { oid, type, content };
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    child.kill();
  }
}

// --- Push ---------------------------------------------------------------------

export async function pushRepo({
  gitRoot,
  repoId,
  baseUrl,
  token,
  onProgress = () => {},
  signal,
}) {
  signal?.throwIfAborted();
  const branches = await readLocalBranches(gitRoot, signal);
  if (branches.length === 0) {
    return { ok: false, error: 'Nothing to push yet — create a commit first.' };
  }

  onProgress('Checking cloud state…');
  const state = await api(baseUrl, token, `/api/git/repos/${repoId}`, { signal });
  const serverRefs = new Map(state.refs.map((ref) => [ref.name, ref.oid]));

  const refUpdates = [];
  const skipped = [];
  for (const branch of branches) {
    const serverOid = serverRefs.get(branch.name) ?? null;
    if (serverOid === branch.oid) continue;
    if (serverOid) {
      const known = await objectExists(gitRoot, serverOid, signal);
      signal?.throwIfAborted();
      const fastForward = known && (await isAncestor(gitRoot, serverOid, branch.oid, signal));
      if (!fastForward) {
        skipped.push({
          branch: branch.branch,
          reason: 'The cloud copy has changes you do not have locally. Pull first.',
        });
        continue;
      }
    }
    refUpdates.push({ name: branch.name, oldOid: serverOid, newOid: branch.oid });
  }

  if (refUpdates.length === 0) {
    return {
      ok: skipped.length === 0,
      upToDate: true,
      skipped,
      repo: state.repo,
      error: skipped.length > 0 ? skipped[0].reason : undefined,
    };
  }

  onProgress('Packing objects…');
  const haves = [];
  for (const oid of serverRefs.values()) {
    signal?.throwIfAborted();
    if (await objectExists(gitRoot, oid, signal)) haves.push(oid);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-push-'));
  try {
    const revListInput =
      [...refUpdates.map((update) => update.newOid), ...haves.map((oid) => `^${oid}`)].join('\n') +
      '\n';
    const packPromise = execFileAsync(
      'git',
      ['-C', gitRoot, 'pack-objects', '--revs', '-q', path.join(tmpDir, 'orion')],
      { maxBuffer: MAX_GIT_BUFFER, signal }
    );
    packPromise.child.stdin.write(revListInput);
    packPromise.child.stdin.end();
    const { stdout: packHash } = await packPromise;
    const hash = packHash.trim().split('\n').pop();
    const packPath = path.join(tmpDir, `orion-${hash}.pack`);
    const idxPath = path.join(tmpDir, `orion-${hash}.idx`);
    // Never read the pack itself into memory — it can reach gigabytes. The
    // object count lives in the 12-byte header, and the upload streams the
    // file from disk.
    const packSize = (await fs.stat(packPath)).size;
    const packHeader = Buffer.alloc(12);
    const packHandle = await fs.open(packPath, 'r');
    try {
      await packHandle.read(packHeader, 0, 12, 0);
    } finally {
      await packHandle.close();
    }
    const idxData = await fs.readFile(idxPath);
    const objectCount = packHeader.readUInt32BE(8);
    const packName = `pack-${hash}`;
    const hasPack = objectCount > 0;

    // File manifests + raw blob inventory for web browsing.
    const manifestCommits = [...new Set(refUpdates.map((update) => update.newOid))];
    const manifests = new Map();
    const blobSizes = new Map();
    for (const commit of manifestCommits) {
      signal?.throwIfAborted();
      const manifest = await buildManifest(gitRoot, commit, signal);
      manifests.set(commit, manifest);
      for (const entry of manifest.entries) {
        if (entry.type === 'blob') blobSizes.set(entry.oid, entry.size ?? 0);
      }
    }

    onProgress('Preparing upload…');
    const prepared = await api(baseUrl, token, `/api/git/repos/${repoId}/push/prepare`, {
      method: 'POST',
      signal,
      body: JSON.stringify({
        packName: hasPack ? packName : null,
        manifestCommits,
        blobs: [...blobSizes.entries()].map(([oid, size]) => ({ oid, size })),
      }),
    });

    if (hasPack) {
      onProgress(`Uploading pack (${Math.round(packSize / 1024)} KB)…`);
      await uploadFileTo(prepared.packPutUrl, packPath, 'application/octet-stream', signal);
      await uploadTo(prepared.packIdxPutUrl, idxData, 'application/octet-stream', signal);
    }

    for (const commit of manifestCommits) {
      signal?.throwIfAborted();
      await uploadTo(
        prepared.manifestPutUrls[commit],
        JSON.stringify(manifests.get(commit)),
        'application/json',
        signal
      );
    }

    const missing = prepared.missingBlobOids ?? [];
    if (missing.length > 0) {
      onProgress(`Uploading ${missing.length} file${missing.length === 1 ? '' : 's'}…`);
      for (let index = 0; index < missing.length; index += BLOB_URL_BATCH) {
        const batch = missing.slice(index, index + BLOB_URL_BATCH);
        const { urls } = await api(baseUrl, token, `/api/git/repos/${repoId}/push/blob-urls`, {
          method: 'POST',
          signal,
          body: JSON.stringify({ oids: batch }),
        });
        // Upload while streaming out of git so at most UPLOAD_CONCURRENCY
        // blobs are held in memory at once.
        const inFlight = new Set();
        try {
          for await (const blob of catFileBatch(gitRoot, batch, signal)) {
            signal?.throwIfAborted();
            if (blob.missing) continue;
            const url = urls[blob.oid];
            if (!url) continue;
            const promise = uploadTo(
              url,
              blob.content,
              'application/octet-stream',
              signal
            ).finally(() => inFlight.delete(promise));
            inFlight.add(promise);
            if (inFlight.size >= UPLOAD_CONCURRENCY) await Promise.race(inFlight);
          }
          await Promise.all(inFlight);
        } finally {
          await Promise.allSettled(inFlight);
        }
      }
    }

    onProgress('Finishing push…');
    const completed = await api(baseUrl, token, `/api/git/repos/${repoId}/push/complete`, {
      method: 'POST',
      signal,
      body: JSON.stringify({
        refUpdates,
        pack: hasPack ? { name: packName, size: packSize } : null,
        blobs: missing.map((oid) => ({ oid, size: blobSizes.get(oid) ?? 0 })),
      }),
    });

    for (const update of refUpdates) {
      signal?.throwIfAborted();
      const branch = update.name.slice('refs/heads/'.length);
      await git(gitRoot, ['update-ref', `refs/remotes/orion/${branch}`, update.newOid], {
        signal,
      });
    }

    return {
      ok: true,
      pushed: refUpdates.map((update) => update.name.slice('refs/heads/'.length)),
      skipped,
      refs: completed.refs,
      repo: state.repo,
      app: completed.app ?? null,
    };
  } catch (error) {
    if (error.status === 409) {
      return {
        ok: false,
        conflict: true,
        error: 'The cloud repository changed while pushing. Pull, then push again.',
      };
    }
    throw error;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export async function publishRepo({
  gitRoot,
  name,
  baseUrl,
  token,
  onProgress = () => {},
  signal,
}) {
  signal?.throwIfAborted();
  const branch = (await currentBranch(gitRoot, signal)) ?? 'main';
  onProgress('Creating cloud repository…');
  const created = await api(baseUrl, token, '/api/git/repos', {
    method: 'POST',
    signal,
    body: JSON.stringify({ name, defaultBranch: branch }),
  });
  await setCloudRepoLink(gitRoot, { repoId: created.repo.id, repoName: created.repo.name });
  const result = await pushRepo({
    gitRoot,
    repoId: created.repo.id,
    baseUrl,
    token,
    onProgress,
    signal,
  });
  return { ...result, repo: created.repo };
}

/** Create and link an empty repository so callers can seed an exact ref set. */
export async function createCloudRepo({ gitRoot, name, defaultBranch, baseUrl, token, signal }) {
  signal?.throwIfAborted();
  const created = await api(baseUrl, token, '/api/git/repos', {
    method: 'POST',
    signal,
    body: JSON.stringify({ name, defaultBranch }),
  });
  await setCloudRepoLink(gitRoot, { repoId: created.repo.id, repoName: created.repo.name });
  return created.repo;
}

// --- Pull ---------------------------------------------------------------------

export async function pullRepo({ gitRoot, repoId, baseUrl, token, onProgress = () => {} }) {
  onProgress('Checking cloud state…');
  const info = await api(baseUrl, token, `/api/git/repos/${repoId}/pull`);
  const gitDir = await git(gitRoot, ['rev-parse', '--absolute-git-dir']);
  const packDir = path.join(gitDir, 'objects', 'pack');
  await fs.mkdir(packDir, { recursive: true });

  let downloadedPacks = 0;
  for (const pack of info.packs) {
    const packPath = path.join(packDir, `${pack.name}.pack`);
    const idxPath = path.join(packDir, `${pack.name}.idx`);
    if (await fileExists(idxPath)) continue;
    onProgress(`Downloading objects (${Math.round(pack.size / 1024)} KB)…`);
    // Pack before idx: git only trusts an idx whose pack is present.
    await downloadToFile(pack.packUrl, packPath);
    await writeFileAtomic(idxPath, await download(pack.idxUrl));
    downloadedPacks += 1;
  }

  let downloadedLoose = 0;
  for (const object of info.loose) {
    if (await objectExists(gitRoot, object.oid)) continue;
    const objectDir = path.join(gitDir, 'objects', object.oid.slice(0, 2));
    await fs.mkdir(objectDir, { recursive: true });
    const data = await download(object.url);
    await writeFileAtomic(path.join(objectDir, object.oid.slice(2)), data);
    downloadedLoose += 1;
  }

  const branches = [];
  const trackingRemote = await cloudTrackingRemote(gitRoot);
  for (const ref of info.refs) {
    if (!ref.name.startsWith('refs/heads/')) continue;
    const branch = ref.name.slice('refs/heads/'.length);
    if (!(await objectExists(gitRoot, ref.oid))) {
      branches.push({ branch, oid: ref.oid, status: 'missing-objects' });
      continue;
    }
    await git(gitRoot, ['update-ref', `refs/remotes/${trackingRemote}/${branch}`, ref.oid]);
    branches.push({ branch, oid: ref.oid, status: 'fetched' });
  }

  let merge = { status: 'none' };
  const branch = await currentBranch(gitRoot);
  if (branch) {
    const serverRef = info.refs.find((ref) => ref.name === `refs/heads/${branch}`);
    if (serverRef && (await objectExists(gitRoot, serverRef.oid))) {
      let localOid = null;
      try {
        localOid = await git(gitRoot, ['rev-parse', 'HEAD']);
      } catch {
        // unborn branch (fresh repo)
      }
      if (!localOid) {
        const status = await git(gitRoot, ['status', '--porcelain']);
        if (status === '') {
          await git(gitRoot, ['reset', '--hard', serverRef.oid]);
          merge = { status: 'checked-out', to: serverRef.oid };
        } else {
          merge = {
            status: 'unborn-dirty',
            hint: `Check out refs/remotes/${trackingRemote}/${branch} manually.`,
          };
        }
      } else if (serverRef.oid === localOid) {
        merge = { status: 'up-to-date' };
      } else if (await isAncestor(gitRoot, localOid, serverRef.oid)) {
        try {
          await git(gitRoot, ['merge', '--ff-only', serverRef.oid]);
          merge = { status: 'fast-forwarded', to: serverRef.oid };
        } catch (error) {
          merge = {
            status: 'ff-failed',
            error: error?.stderr?.toString().trim() || error?.message || String(error),
          };
        }
      } else if (await isAncestor(gitRoot, serverRef.oid, localOid)) {
        merge = { status: 'local-ahead' };
      } else {
        merge = {
          status: 'diverged',
          hint: `Local and cloud history diverged — merge refs/remotes/${trackingRemote}/${branch} manually.`,
        };
      }
    }
  }

  return { ok: true, repo: info.repo, branches, merge, downloadedPacks, downloadedLoose };
}

// --- Deployments (Orion Cloud hosts the repo as an app) ----------------------

/**
 * Queue a build+deploy of the repo's current HEAD. The server builds on Railway
 * and hosts at https://<slug>.andromedus.dev, so this returns as soon as the
 * app row exists — `status` is usually `queued` here and settles via
 * {@link getAppState}. A 402 (free plan's app limit) reaches the caller as an
 * error with `.status`/`.data` so the UI can show the server's own message.
 */
export async function deployApp({ repoId, baseUrl, token, signal }) {
  const result = await api(baseUrl, token, `/api/git/repos/${repoId}/deploy`, {
    method: 'POST',
    signal,
    body: JSON.stringify({}),
  });
  return result.app ?? null;
}

export async function getAppState({ repoId, baseUrl, token, signal }) {
  const result = await api(baseUrl, token, `/api/git/repos/${repoId}/app`, { signal });
  return result.app ?? null;
}

// --- State for the UI -----------------------------------------------------------

export async function getCloudState({ gitRoot, baseUrl, token }) {
  const link = await getCloudRepoLink(gitRoot);
  if (!link) return { linked: false };

  try {
    const state = await api(baseUrl, token, `/api/git/repos/${link.repoId}`);
    const branch = await currentBranch(gitRoot);
    let sync = 'unknown';
    if (branch) {
      let localOid = null;
      try {
        localOid = await git(gitRoot, ['rev-parse', 'HEAD']);
      } catch {
        // unborn branch
      }
      const serverOid =
        state.refs.find((ref) => ref.name === `refs/heads/${branch}`)?.oid ?? null;
      if (!localOid) {
        sync = serverOid ? 'behind' : 'unknown';
      } else if (!serverOid) {
        sync = 'ahead';
      } else if (serverOid === localOid) {
        sync = 'synced';
      } else if (!(await objectExists(gitRoot, serverOid))) {
        sync = 'behind';
      } else if (await isAncestor(gitRoot, serverOid, localOid)) {
        sync = 'ahead';
      } else if (await isAncestor(gitRoot, localOid, serverOid)) {
        sync = 'behind';
      } else {
        sync = 'diverged';
      }
    }
    return {
      linked: true,
      repoId: link.repoId,
      repoName: state.repo.name,
      repo: state.repo,
      refs: state.refs,
      currentBranch: branch,
      sync,
      // Deployed app for this repo, if any. Older Orion Web deployments omit
      // the field entirely, so absent and "never deployed" both read as null.
      app: state.app ?? null,
      // Continuous downstream source-control mirror. Older Orion Web
      // deployments omit this field and Desktop retains its local fallback.
      mirror: state.mirror ?? state.githubMirror ?? null,
    };
  } catch (error) {
    if (error.status === 404) {
      return { linked: false, stale: true, repoId: link.repoId };
    }
    throw error;
  }
}
