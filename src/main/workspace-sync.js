import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { clearCloudRepoLink, getCloudRepoLink, publishRepo, pushRepo } from '../cloud-sync.js';
import { isOrionRepoRemoteUrl } from './source-control.js';

const execFileAsync = promisify(execFile);

// Workspace sync engine (contract: orion-web/docs/workspace-sync.md). Mirrors
// the local workspace — projects, threads with full transcripts, token
// usage, and (optionally) code as Durango Cloud repos — to Durango Code web.
// The user-facing name is "Share coding work with Durango": Durango Code web
// generates the work digests that Durango Chat's memory uses from each
// completed thread sync, so a finished turn should reach it promptly.
//
// Everything here is gated twice: the setting (on by default since the
// Durango merge — see app/workspaceSyncConsent.ts — pushed from the renderer
// over sync:configure) AND a signed-in account. While either is missing the
// engine is inert — no timers, no network, no capture — so users who turn
// sharing off are entirely unaffected. All work happens on debounced timers
// in this process; failures land in the status broadcast, never in the
// agent-run path.
//
// Timing: every threads/store save calls notifyWorkspaceChanged(). The pass
// runs SYNC_DEBOUNCE_MS (15 s) after the last save, so a thread that just
// finished its turn (its final save is the turn-end write) syncs ~15 s later
// — prompt enough for digests, while a streaming turn's many saves coalesce
// into one pass. SYNC_MAX_WAIT_MS caps the debounce: another thread streaming
// continuously cannot postpone a finished thread's sync for longer than 60 s.

const THREAD_SYNC_BATCH = 50;
const SYNC_DEBOUNCE_MS = 15_000;
const SYNC_MAX_WAIT_MS = 60_000;
const CODE_POLL_MS = 60_000;
const MIN_SYNC_GAP_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

// Injected by main.js at startup so this module needs no knowledge of Electron
// state: { getWebUrl, readSession, readStoreState, readThreadsIndex,
// readThreadsByIds, broadcast }.
let deps = null;

let settings = { enabled: false, syncCode: true };
let status = {
  enabled: false,
  authenticated: false,
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  backfillDone: false,
  counts: null,
};

let syncTimer = null;
let codePollTimer = null;
let syncInFlight = null;
let syncQueuedOptions = null;
let scheduledSyncOptions = null;
// When the currently pending (debounced) pass was first requested.
let scheduledSyncFirstRequestedAt = 0;
let syncGeneration = 0;
let activeSyncController = null;
let lastSyncStartedAt = 0;
// Per-thread server state, seeded on the first pass so unchanged transcripts
// stay skipped. A server-side zero-token row is deliberately left unchecked
// once so older Codex threads can be backfilled from their provider rollout.
let knownThreadStates = new Map();
let serverStateSeeded = false;
// gitRoot -> complete refs/heads state successfully pushed.
const pushedBranchStates = new Map();
// gitRoot -> { message, branchState } of the last failed auto publish/push.
// Retried when the repo's refs move or on explicit "Sync now" — never on the
// unchanged state that just failed. Without this, a repo whose push can never
// succeed (e.g. a pack too large for the server) was re-packed and re-uploaded
// on every pass: gigabytes of pack data rebuilt and buffered each time.
const publishFailures = new Map();
// Runtime ownership of local Orion Cloud links. A link without an entry is
// adopted by the first signed-in account that observes it; a later account
// must not reuse that inaccessible repository id.
const repoLinkOwners = new Map();
let syncOwnerId = null;
let totals = { projects: 0, threads: 0, transcriptsUploaded: 0, codePushes: 0 };

const readThreadIndex = async () => {
  if (deps.readThreadsIndex) return deps.readThreadsIndex();
  const threads = (await deps.readThreadsFile?.())?.threads ?? [];
  return {
    entries: threads.map((thread) => ({
      id: thread.id,
      hash: crypto.createHash('sha256').update(JSON.stringify(thread)).digest('hex'),
    })),
    legacyThreads: threads,
  };
};

const readChangedThreads = async (threadIndex, ids) => {
  if (deps.readThreadsByIds) return deps.readThreadsByIds(ids);
  return (threadIndex.legacyThreads ?? []).filter((thread) => ids.includes(thread?.id));
};

const broadcastStatus = () => {
  deps?.broadcast('sync:state', { ...status, counts: totals.threads > 0 ? { ...totals } : status.counts });
};

const setStatus = (updates) => {
  status = { ...status, ...updates };
  broadcastStatus();
};

const fetchForSync = async (input, options = {}) => {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => {
    const error = new Error('Workspace sync request timed out.');
    error.name = 'TimeoutError';
    timeoutController.abort(error);
  }, REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    return await fetch(input, { ...options, signal });
  } finally {
    clearTimeout(timeout);
  }
};

const api = async (token, apiPath, options = {}) => {
  const response = await fetchForSync(new URL(apiPath, deps.getWebUrl()), {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  let data = null;
  try {
    data = await response.json();
  } catch {}
  if (!response.ok) {
    const error = new Error(data?.error || `Sync request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
};

const syncOwnerIdentity = (session) => {
  const userId = session?.user?.id ?? session?.userId;
  if (typeof userId === 'string' && userId) return userId;
  // Authenticated desktop sessions normally include user.id. Keep the
  // fallback opaque and in-memory if an older session shape does not.
  return session?.token
    ? `token:${crypto.createHash('sha256').update(session.token).digest('hex')}`
    : null;
};

const resetAccountScopedState = (ownerId) => {
  syncOwnerId = ownerId;
  serverStateSeeded = false;
  knownThreadStates = new Map();
  pushedBranchStates.clear();
  publishFailures.clear();
  totals = { projects: 0, threads: 0, transcriptsUploaded: 0, codePushes: 0 };
  status = {
    ...status,
    lastSyncAt: null,
    lastError: null,
    backfillDone: false,
    counts: null,
  };
};

const ensureCurrentSync = (generation, signal) => {
  if (generation !== syncGeneration || signal?.aborted || !settings.enabled) {
    const error = new Error('Workspace sync was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
};

const invalidateActiveSync = () => {
  syncGeneration += 1;
  syncQueuedOptions = null;
  scheduledSyncOptions = null;
  activeSyncController?.abort();
};

const isCancelledSync = (error, generation, signal) =>
  generation !== syncGeneration || signal?.aborted || error?.name === 'AbortError';

// --- Usage rollups ------------------------------------------------------------

const providerOfModel = (modelId) =>
  typeof modelId === 'string' && modelId.includes(':') ? modelId.split(':', 1)[0] : '';

const emptyTotals = () => ({
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
});

const statsTotals = (stats) => ({
  totalTokens: Number(stats?.totalTokens) || 0,
  inputTokens: Number(stats?.inputTokens) || 0,
  outputTokens: Number(stats?.outputTokens) || 0,
  cachedTokens: Number(stats?.cachedReadTokens) || 0,
  reasoningTokens: Number(stats?.reasoningTokens) || 0,
});

const addTotals = (target, source) => {
  target.totalTokens += source.totalTokens;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cachedTokens += source.cachedTokens;
  target.reasoningTokens += source.reasoningTokens;
};

const cumulativeDelta = (current, previous) => {
  if (!previous || current.totalTokens < previous.totalTokens) return current;
  return {
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    cachedTokens: Math.max(0, current.cachedTokens - previous.cachedTokens),
    reasoningTokens: Math.max(0, current.reasoningTokens - previous.reasoningTokens),
  };
};

const normalizedTurnModelId = (message, thread) => {
  const messageModelId =
    typeof message?.modelId === 'string' && message.modelId ? message.modelId : null;
  const statsModelId =
    typeof message?.stats?.modelId === 'string' && message.stats.modelId
      ? message.stats.modelId
      : null;
  const threadModelId =
    typeof thread?.modelId === 'string' && thread.modelId ? thread.modelId : null;
  const threadProviderId = providerOfModel(threadModelId);
  const providerHint =
    providerOfModel(messageModelId) ||
    providerOfModel(statsModelId) ||
    (threadProviderId !== 'orion' ? threadProviderId : '');
  const modelId = messageModelId || statsModelId || threadModelId || 'unknown:unknown';
  return modelId.includes(':') || !providerHint ? modelId : `${providerHint}:${modelId}`;
};

/**
 * Per-model usage for one thread. Provider stat semantics differ (see the
 * driver notes in src/main/*-driver.js): codex and kimi report cumulative
 * provider-session totals on every turn. Derive their chronological provider
 * delta before assigning it to a model, because a resumed session can switch
 * models without resetting its cumulative counters. Claude/grok report
 * per-turn stats, so their full reports are assigned directly.
 */
export const computeThreadUsage = (thread) => {
  const groups = new Map();
  const previousCumulativeByProvider = new Map();
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  for (const message of messages) {
    if (message?.kind !== 'agent-run') continue;
    const modelId = normalizedTurnModelId(message, thread);
    const providerId = providerOfModel(modelId);
    let group = groups.get(modelId);
    if (!group) {
      group = { modelId, providerId, turns: 0, totals: emptyTotals() };
      groups.set(modelId, group);
    }
    group.turns += 1;
    if (!message.stats) continue;
    const turnTotals = statsTotals(message.stats);
    if (providerId === 'codex' || providerId === 'kimi') {
      const previous = previousCumulativeByProvider.get(providerId);
      addTotals(group.totals, cumulativeDelta(turnTotals, previous));
      previousCumulativeByProvider.set(providerId, turnTotals);
    } else {
      addTotals(group.totals, turnTotals);
    }
  }

  const usage = emptyTotals();
  const models = [];
  for (const group of groups.values()) {
    addTotals(usage, group.totals);
    models.push({
      modelId: group.modelId,
      providerId: group.providerId,
      turns: group.turns,
      ...group.totals,
    });
  }
  return { usage, models };
};

const codexStatsAreMissing = (message, thread) =>
  message?.kind === 'agent-run' &&
  providerOfModel(normalizedTurnModelId(message, thread)) === 'codex' &&
  statsTotals(message.stats).totalTokens <= 0;

const codexSessionDayDirs = (thread, codexHome) => {
  const dirs = new Set();
  const timestamps = [
    thread?.createdAt,
    ...(Array.isArray(thread?.messages)
      ? thread.messages.flatMap((message) => [message?.ts, message?.completedAt])
      : []),
  ];
  for (const value of timestamps) {
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) continue;
    for (const offset of [-1, 0, 1]) {
      const date = new Date(time + offset * 86400000);
      const parts = [
        [date.getFullYear(), date.getMonth() + 1, date.getDate()],
        [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()],
      ];
      for (const [year, month, day] of parts) {
        dirs.add(
          path.join(
            codexHome,
            'sessions',
            String(year),
            String(month).padStart(2, '0'),
            String(day).padStart(2, '0')
          )
        );
      }
    }
  }
  return [...dirs];
};

const findCodexRollout = async (thread, codexHome) => {
  const sessionId = thread?.agentSessionIds?.codex;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const suffix = `-${sessionId}.jsonl`;
  for (const dir of codexSessionDayDirs(thread, codexHome)) {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    const name = names.find((entry) => entry.endsWith(suffix));
    if (name) return path.join(dir, name);
  }
  return null;
};

const totalsFromCodexRollout = (value) => {
  const raw = value?.payload?.info?.total_token_usage;
  if (!raw || typeof raw !== 'object') return null;
  const totalTokens = Number(raw.total_tokens);
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return null;
  return {
    totalTokens,
    inputTokens: Number(raw.input_tokens) || 0,
    outputTokens: Number(raw.output_tokens) || 0,
    cachedReadTokens: Number(raw.cached_input_tokens) || 0,
    reasoningTokens: Number(raw.reasoning_output_tokens) || 0,
    cumulative: true,
  };
};

export const readCodexUsageCompletions = async (filePath, options = {}) => {
  const completions = [];
  let activeTurn = null;
  let latestTotals = null;
  let input;
  const abort = () => input?.destroy(new Error('Workspace sync was cancelled.'));
  try {
    if (options.signal?.aborted) return [];
    input = createReadStream(filePath, { encoding: 'utf8' });
    options.signal?.addEventListener('abort', abort, { once: true });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = value?.payload;
      if (value?.type !== 'event_msg' || !payload || typeof payload !== 'object') continue;
      if (payload.type === 'task_started') {
        activeTurn = {
          turnId: typeof payload.turn_id === 'string' ? payload.turn_id : null,
          startedAt: value.timestamp ?? null,
        };
        latestTotals = null;
        continue;
      }
      if (payload.type === 'token_count' && activeTurn) {
        latestTotals = totalsFromCodexRollout(value) ?? latestTotals;
        continue;
      }
      if (
        payload.type === 'task_complete' &&
        activeTurn &&
        (!activeTurn.turnId || !payload.turn_id || payload.turn_id === activeTurn.turnId)
      ) {
        if (latestTotals) {
          completions.push({
            startedAt: activeTurn.startedAt,
            completedAt: value.timestamp ?? null,
            stats: latestTotals,
          });
        }
        activeTurn = null;
        latestTotals = null;
      }
    }
  } catch {
    input?.destroy();
    return [];
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
  return completions;
};

export const backfillCodexThreadUsage = async (thread, options = {}) => {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const missingIndexes = messages
    .map((message, index) => (codexStatsAreMissing(message, thread) ? index : -1))
    .filter((index) => index >= 0);
  if (missingIndexes.length === 0) return thread;

  const configuredHome =
    typeof options.codexHome === 'string' && options.codexHome
      ? options.codexHome
      : typeof process.env.CODEX_HOME === 'string' && process.env.CODEX_HOME
        ? process.env.CODEX_HOME
        : path.join(os.homedir(), '.codex');
  const rollout = await findCodexRollout(thread, configuredHome);
  if (!rollout) return thread;
  const completions = await readCodexUsageCompletions(rollout, options);
  if (completions.length === 0) return thread;

  const used = new Set();
  const nextMessages = [...messages];
  let changed = false;
  for (const messageIndex of missingIndexes) {
    const message = messages[messageIndex];
    const completedAt = new Date(message?.completedAt).getTime();
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    if (Number.isFinite(completedAt)) {
      for (let index = 0; index < completions.length; index += 1) {
        if (used.has(index)) continue;
        const candidateTime = new Date(completions[index].completedAt).getTime();
        if (!Number.isFinite(candidateTime)) continue;
        const distance = Math.abs(candidateTime - completedAt);
        if (distance < bestDistance) {
          bestIndex = index;
          bestDistance = distance;
        }
      }
    }
    // Provider completion and renderer persistence normally differ by less
    // than a second. Keep a generous bound for busy machines, then fall back
    // to chronological matching only when the rollout and agent-run counts
    // are identical.
    if (bestDistance > 15 * 60_000) bestIndex = -1;
    if (bestIndex < 0 && completions.length === missingIndexes.length) {
      bestIndex = missingIndexes.indexOf(messageIndex);
    }
    if (bestIndex < 0 || used.has(bestIndex)) continue;
    used.add(bestIndex);
    nextMessages[messageIndex] = {
      ...message,
      stats: {
        ...completions[bestIndex].stats,
        modelId: message?.modelId ?? thread?.modelId,
      },
    };
    changed = true;
  }
  return changed ? { ...thread, messages: nextMessages } : thread;
};

const threadLastActivity = (thread) => {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const last = messages[messages.length - 1];
  return last?.completedAt || last?.ts || thread?.createdAt || null;
};

const threadPayload = async (thread, transcriptHash, options = {}) => {
  const usageThread = await backfillCodexThreadUsage(thread, options);
  const { usage, models } = computeThreadUsage(usageThread);
  return {
    id: thread.id,
    projectId: thread.projectId ?? null,
    parentThreadId: thread.parentThreadId ?? null,
    title: typeof thread.title === 'string' ? thread.title : '',
    // The desktop's transient statuses map onto the synced vocabulary.
    status: ['idle', 'running', 'done', 'error'].includes(thread.status) ? thread.status : 'idle',
    modelId: thread.modelId ?? null,
    isSubagent: Boolean(thread.subagent),
    messageCount: Array.isArray(thread.messages) ? thread.messages.length : 0,
    createdAt: thread.createdAt ?? null,
    lastActivityAt: threadLastActivity(thread),
    transcriptHash,
    usage,
    models,
  };
};

// --- Sync passes --------------------------------------------------------------

const syncSnapshot = async (token, storeState, threads, { ownerId, generation, signal }) => {
  const projects = Array.isArray(storeState?.projects) ? storeState.projects : [];

  // Resolve each project's cloud repo link so the web UI can cross-link the
  // synced code. Cheap local git config reads; failures just leave it null.
  const projectPayloads = [];
  for (const project of projects) {
    if (typeof project?.id !== 'string') continue;
    let repoId = null;
    try {
      const gitRoot = await getGitRootSafe(project.path);
      ensureCurrentSync(generation, signal);
      if (gitRoot) {
        repoId =
          (await getCloudRepoLinkForOwner(gitRoot, ownerId, { generation, signal }))?.repoId ?? null;
      }
    } catch (error) {
      if (isCancelledSync(error, generation, signal)) throw error;
    }
    projectPayloads.push({ id: project.id, name: project.name ?? '', path: project.path ?? '', repoId });
  }

  ensureCurrentSync(generation, signal);
  await api(token, '/api/sync/snapshot', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      projects: projectPayloads,
      threadIds: threads.map((thread) => thread.id),
      complete: true,
    }),
  });
  totals.projects = projectPayloads.length;
};

const syncThreads = async (token, threadIndex, { generation, signal }) => {
  // The local manifest already carries the content hash written alongside
  // each transcript. Load and serialize only threads that differ from the
  // server instead of rebuilding every historical transcript every minute.
  const changedIds = threadIndex.entries
    .filter((entry) => {
      if (typeof entry?.id !== 'string') return false;
      const known = knownThreadStates.get(entry.id);
      return !known || known.transcriptHash !== entry.hash || known.usageChecked !== true;
    })
    .map((entry) => entry.id);
  totals.threads = threadIndex.entries.length;
  if (changedIds.length === 0) return;
  const threads = await readChangedThreads(threadIndex, changedIds);
  const entries = [];
  for (const thread of threads) {
    ensureCurrentSync(generation, signal);
    if (typeof thread?.id !== 'string') continue;
    const serialized = JSON.stringify(thread);
    const hash = crypto.createHash('sha256').update(serialized).digest('hex');
    entries.push({ thread, serialized, hash });
  }
  if (entries.length === 0) return;

  for (let index = 0; index < entries.length; index += THREAD_SYNC_BATCH) {
    ensureCurrentSync(generation, signal);
    const batch = entries.slice(index, index + THREAD_SYNC_BATCH);
    const payloads = [];
    // Historical rollouts can be large. Stream them one at a time so a
    // zero-usage backfill cannot open an entire 50-thread batch concurrently.
    for (const entry of batch) {
      ensureCurrentSync(generation, signal);
      payloads.push({
        entry,
        payload: await threadPayload(entry.thread, entry.hash, { signal }),
      });
    }
    ensureCurrentSync(generation, signal);
    const response = await api(token, '/api/sync/threads', {
      method: 'POST',
      signal,
      body: JSON.stringify({
        threads: payloads.map(({ payload }) => payload),
      }),
    });

    const uploads = Array.isArray(response?.uploads) ? response.uploads : [];
    const byThreadId = new Map(batch.map((entry) => [entry.thread.id, entry]));
    const confirmed = [];
    for (const upload of uploads) {
      const entry = byThreadId.get(upload?.threadId);
      if (!entry || !upload?.url) continue;
      const put = await fetchForSync(upload.url, {
        method: 'PUT',
        body: entry.serialized,
        signal,
        headers: { 'content-type': 'application/json' },
      });
      if (!put.ok) throw new Error(`Transcript upload failed (${put.status})`);
      confirmed.push({
        threadId: entry.thread.id,
        transcriptHash: entry.hash,
        transcriptSize: Buffer.byteLength(entry.serialized),
      });
    }
    if (confirmed.length > 0) {
      await api(token, '/api/sync/threads/complete', {
        method: 'POST',
        signal,
        body: JSON.stringify({ uploads: confirmed }),
      });
    }
    // Threads whose transcript the server already had (hash match) are synced
    // too — remember every hash in the batch, not just fresh uploads.
    for (const { entry, payload } of payloads) {
      knownThreadStates.set(entry.thread.id, {
        transcriptHash: entry.hash,
        totalTokens: payload.usage.totalTokens,
        usageChecked: true,
      });
    }
    totals.transcriptsUploaded += confirmed.length;
  }
};

const getGitRootSafe = async (startPath) => {
  if (!startPath || typeof startPath !== 'string') return null;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startPath,
    });
    const root = stdout.trim();
    return root || null;
  } catch {
    return null;
  }
};

const gitBranchState = async (gitRoot) => {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['for-each-ref', '--sort=refname', '--format=%(refname) %(objectname)', 'refs/heads'],
      { cwd: gitRoot }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

const usesOrionOrigin = async (gitRoot) => {
  try {
    const [{ stdout: configured }, { stdout: repoId }, { stdout: originUrl }] = await Promise.all([
      execFileAsync('git', ['config', '--local', '--get', 'orion.sourcecontrol'], { cwd: gitRoot }),
      execFileAsync('git', ['config', '--local', '--get', 'orion.cloudrepoid'], { cwd: gitRoot }),
      execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: gitRoot }),
    ]);
    return configured.trim() === 'orion' && isOrionRepoRemoteUrl(originUrl.trim(), repoId.trim());
  } catch {
    return false;
  }
};

const getCloudRepoLinkForOwner = async (
  gitRoot,
  ownerId,
  { generation, signal }
) => {
  const link = await getCloudRepoLink(gitRoot);
  ensureCurrentSync(generation, signal);
  if (!link) {
    repoLinkOwners.delete(gitRoot);
    return null;
  }

  const recorded = repoLinkOwners.get(gitRoot);
  if (recorded && recorded.ownerId !== ownerId) {
    // The git config link is account-specific. Remove it before snapshots or
    // pushes can expose/reuse the previous account's inaccessible repository.
    await clearCloudRepoLink(gitRoot);
    ensureCurrentSync(generation, signal);
    repoLinkOwners.delete(gitRoot);
    return null;
  }

  repoLinkOwners.set(gitRoot, { ownerId, repoId: link.repoId });
  return link;
};

// Auto-publish unlinked git projects and push linked ones whose branch refs
// moved. A branch ref only moves when Git creates a commit: dirty working-tree
// edits are deliberately invisible here, so repository sync exposes immutable
// save points rather than a stream of file saves. Serialized on purpose:
// pushes are I/O-heavy and this must never compete with the agent-run path for
// resources.
const syncCode = async (
  token,
  storeState,
  { retryFailedPublishes = false, ownerId, generation, signal }
) => {
  const projects = Array.isArray(storeState?.projects) ? storeState.projects : [];
  const seenRoots = new Set();
  const failures = [];
  for (const project of projects) {
    ensureCurrentSync(generation, signal);
    const gitRoot = await getGitRootSafe(project?.path);
    if (!gitRoot || seenRoots.has(gitRoot)) continue;
    seenRoots.add(gitRoot);

    const branchState = await gitBranchState(gitRoot);
    ensureCurrentSync(generation, signal);
    if (!branchState) continue; // empty repo — nothing to push yet

    const priorFailure = publishFailures.get(gitRoot);
    if (priorFailure && !retryFailedPublishes && priorFailure.branchState === branchState) {
      failures.push(priorFailure.message);
      continue;
    }

    let link = null;
    try {
      if (await usesOrionOrigin(gitRoot)) {
        if (pushedBranchStates.get(gitRoot) === branchState) continue;
        if (typeof deps.pushOrionSourceControl !== 'function') {
          throw new Error('This Durango Code build cannot authenticate the repository origin.');
        }
        await deps.pushOrionSourceControl({ gitRoot, token, signal });
        ensureCurrentSync(generation, signal);
        publishFailures.delete(gitRoot);
        pushedBranchStates.set(gitRoot, branchState);
        totals.codePushes += 1;
        continue;
      }
      link = await getCloudRepoLinkForOwner(gitRoot, ownerId, { generation, signal });
      if (!link) {
        const name = path
          .basename(gitRoot)
          .replace(/[^A-Za-z0-9._-]+/g, '-')
          .replace(/^[-.]+/, '')
          .slice(0, 100);
        if (!name) continue;
        // Claim any link publishRepo creates even if cancellation arrives
        // between repository creation and its first code upload.
        repoLinkOwners.set(gitRoot, { ownerId, repoId: null });
        const result = await publishRepo({
          gitRoot,
          name,
          baseUrl: deps.getWebUrl(),
          token,
          signal,
        });
        ensureCurrentSync(generation, signal);
        if (!result?.ok || result?.skipped?.length > 0) {
          throw new Error(
            result?.error ||
              result?.skipped?.[0]?.reason ||
              'Cloud repository publish failed.'
          );
        }
        if (result.repo?.id) {
          repoLinkOwners.set(gitRoot, { ownerId, repoId: result.repo.id });
        }
        publishFailures.delete(gitRoot);
        pushedBranchStates.set(gitRoot, branchState);
        totals.codePushes += 1;
        continue;
      }
      if (pushedBranchStates.get(gitRoot) === branchState) continue;
      const result = await pushRepo({
        gitRoot,
        repoId: link.repoId,
        baseUrl: deps.getWebUrl(),
        token,
        signal,
      });
      ensureCurrentSync(generation, signal);
      if (!result?.ok || result?.skipped?.length > 0) {
        throw new Error(
          result?.error || result?.skipped?.[0]?.reason || 'Cloud repository push failed.'
        );
      }
      publishFailures.delete(gitRoot);
      pushedBranchStates.set(gitRoot, branchState);
      totals.codePushes += 1;
    } catch (error) {
      if (isCancelledSync(error, generation, signal)) throw error;
      const failure = `${path.basename(gitRoot)}: ${error?.message || String(error)}`;
      publishFailures.set(gitRoot, { message: failure, branchState });
      failures.push(failure);
    }
  }
  return failures;
};

const seedServerState = async (token, signal) => {
  if (serverStateSeeded) return;
  const state = await api(token, '/api/sync/state', { signal });
  knownThreadStates = new Map(
    (state?.threads ?? [])
      .filter((thread) => typeof thread?.id === 'string')
      .map((thread) => {
        const totalTokens = Number(thread.totalTokens) || 0;
        return [
          thread.id,
          {
            transcriptHash: thread.transcriptHash ?? null,
            totalTokens,
            usageChecked: totalTokens > 0,
          },
        ];
      })
  );
  serverStateSeeded = true;
};

const runSyncPass = async (
  { retryFailedPublishes = false } = {},
  { generation, signal }
) => {
  try {
    const session = await deps.readSession();
    const authenticated = Boolean(session?.token);
    if (!settings.enabled || !authenticated) {
      setStatus({ enabled: settings.enabled, authenticated, syncing: false });
      return;
    }

    const ownerId = syncOwnerIdentity(session);
    if (syncOwnerId !== ownerId) {
      resetAccountScopedState(ownerId);
    }
    ensureCurrentSync(generation, signal);
    setStatus({ enabled: true, authenticated: true, syncing: true, lastError: null });

    await seedServerState(session.token, signal);
    ensureCurrentSync(generation, signal);

    const [storeState, threadIndex] = await Promise.all([
      deps.readStoreState(),
      readThreadIndex(),
    ]);
    ensureCurrentSync(generation, signal);
    const entries = Array.isArray(threadIndex?.entries) ? threadIndex.entries : [];

    await syncSnapshot(session.token, storeState, entries, {
      ownerId,
      generation,
      signal,
    });
    ensureCurrentSync(generation, signal);
    await syncThreads(session.token, { ...threadIndex, entries }, { generation, signal });
    ensureCurrentSync(generation, signal);
    let codeFailures = [];
    if (settings.syncCode) {
      codeFailures = await syncCode(session.token, storeState, {
        retryFailedPublishes,
        ownerId,
        generation,
        signal,
      });
    }
    ensureCurrentSync(generation, signal);

    setStatus({
      syncing: false,
      lastSyncAt: new Date().toISOString(),
      lastError: codeFailures.length > 0 ? codeFailures.join('\n') : null,
      backfillDone: true,
      counts: { ...totals },
    });
  } catch (error) {
    if (isCancelledSync(error, generation, signal)) return;
    if (error?.status === 401) {
      setStatus({ syncing: false, authenticated: false, lastError: 'Session expired — sign in again.' });
      return;
    }
    setStatus({ syncing: false, lastError: error?.message || String(error) });
  }
};

const runSync = (options) => {
  if (syncInFlight) {
    syncQueuedOptions = { ...(syncQueuedOptions ?? {}), ...(options ?? {}) };
    return syncInFlight;
  }
  const generation = syncGeneration;
  const controller = new AbortController();
  activeSyncController = controller;
  lastSyncStartedAt = Date.now();
  syncInFlight = runSyncPass(options, { generation, signal: controller.signal }).finally(() => {
    syncInFlight = null;
    if (activeSyncController === controller) activeSyncController = null;
    if (syncQueuedOptions) {
      const queuedOptions = syncQueuedOptions;
      syncQueuedOptions = null;
      scheduleSync(SYNC_DEBOUNCE_MS, queuedOptions);
    }
  });
  return syncInFlight;
};

const scheduleSync = (delayMs = SYNC_DEBOUNCE_MS, options) => {
  if (!settings.enabled) return;
  if (options) {
    scheduledSyncOptions = { ...(scheduledSyncOptions ?? {}), ...options };
  }
  const now = Date.now();
  if (syncTimer) clearTimeout(syncTimer);
  else scheduledSyncFirstRequestedAt = now;
  const sinceLast = now - lastSyncStartedAt;
  // Trailing debounce, bounded: never push a pending pass past
  // SYNC_MAX_WAIT_MS after it was first requested.
  const untilMaxWait = Math.max(0, scheduledSyncFirstRequestedAt + SYNC_MAX_WAIT_MS - now);
  const delay = Math.max(Math.min(delayMs, untilMaxWait), MIN_SYNC_GAP_MS - sinceLast);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    const nextOptions = scheduledSyncOptions;
    scheduledSyncOptions = null;
    void runSync(nextOptions ?? undefined);
  }, delay);
  // Don't hold the process open for a pending sync.
  syncTimer.unref?.();
};

const startCodePoll = () => {
  if (codePollTimer) return;
  codePollTimer = setInterval(() => {
    // The full pass cheaply skips repos whose complete branch-ref state is unchanged.
    void runSync();
  }, CODE_POLL_MS);
  codePollTimer.unref?.();
};

const stopTimers = () => {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  scheduledSyncOptions = null;
  if (codePollTimer) clearInterval(codePollTimer);
  codePollTimer = null;
};

// --- Public surface (called from main.js) ------------------------------------

export const initWorkspaceSync = (injectedDeps) => {
  deps = injectedDeps;
};

/** Renderer pushes the persisted settings on hydration and every change. */
export const configureWorkspaceSync = (nextSettings) => {
  const wasEnabled = settings.enabled;
  settings = {
    enabled: nextSettings?.enabled === true,
    syncCode: nextSettings?.syncCode !== false,
  };
  if (settings.enabled && !wasEnabled) {
    // First enable (or re-enable): backfill everything in the background.
    setStatus({ enabled: true, backfillDone: false });
    startCodePoll();
    scheduleSync(1_000);
  } else if (!settings.enabled && wasEnabled) {
    invalidateActiveSync();
    stopTimers();
    setStatus({ enabled: false, syncing: false });
  } else {
    setStatus({ enabled: settings.enabled });
  }
  return { ...status };
};

/** Debounced change signal — safe to call on every threads/store save. */
export const notifyWorkspaceChanged = () => {
  if (!settings.enabled) return;
  scheduleSync();
};

export const workspaceSyncNow = () => {
  if (!settings.enabled) return Promise.resolve({ ...status });
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  return runSync({ retryFailedPublishes: true }).then(() => ({ ...status }));
};

export const getWorkspaceSyncStatus = () => ({ ...status });

/** Account changes flip authentication without touching the setting. */
export const notifyAccountChanged = () => {
  invalidateActiveSync();
  serverStateSeeded = false;
  knownThreadStates = new Map();
  if (!settings.enabled) return;
  setStatus({ syncing: false });
  scheduleSync(1_000);
};

export const shutdownWorkspaceSync = () => {
  invalidateActiveSync();
  stopTimers();
};
