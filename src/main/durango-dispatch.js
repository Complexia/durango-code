import { DurangoError } from './durango-client.js';

// Dispatch worker: runs agents that the user started from Durango Chat
// (merge plan Phase 5, contracts §7 "Dispatch").
//
// Off by default ("Allow Durango Chat and Tasks to start agents on this Mac" in
// Settings → Durango). While it is on and the user is signed in, this
// machine registers itself (`POST /api/v1/code/machines`, allowlisted
// projects only) and long-polls `POST /api/v1/code/dispatches/claim`. A
// claimed dispatch is resolved to a local project and handed to the renderer
// through the same command bridge remote control uses for `runTurn`, so the
// renderer stays the authority over threads. Status goes back to Durango:
// `running` (repeated as the lease heartbeat), then `finished` with the
// agent's final response or `failed` with the reason.
//
// Safety: a dispatch never runs with more access than the configured
// default (Read only unless the user picks otherwise), only in allowlisted
// projects, and never while signed out.

export const DISPATCH_ACCESS_MODES = ['read-only', 'workspace-write', 'full-access'];
// Durango Chat's confirmation card offers "ask" (ask before editing) and
// "auto-edit"; Tasks always sends "auto-edit". Durango Code has no per-edit
// approval prompt, so "ask" runs Read only: the agent can investigate and
// propose, not change files. "auto-edit" runs with this Mac's limit, so
// choosing Full access in Settings is what a Tasks run gets (Workspace write
// makes Claude ask before every Bash command, which no one is there to answer).

export const DISPATCH_SUMMARY_MAX_CHARS = 2_000;
export const DISPATCH_ERROR_MAX_CHARS = 1_000;
export const DISPATCH_HEARTBEAT_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
const OFFLINE_RECHECK_MS = 15_000;
const WINDOW_RECHECK_MS = 5_000;
const REPORT_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];

export const defaultDispatchSettings = Object.freeze({
  enabled: false,
  /** null = every project on this Mac. */
  allowedProjectIds: null,
  /** Ceiling and default for dispatched runs. */
  accessMode: 'read-only',
  /** null = the project's usual model (inherited from its last thread). */
  modelId: null,
  /**
   * Dispatched runs at a time; null = no limit. Replaces maxConcurrent (1 | 2,
   * default 1) under a new key so existing installs move to no limit.
   */
  maxRunning: null,
});

export const normalizeDispatchSettings = (raw) => {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: value.enabled === true,
    allowedProjectIds: Array.isArray(value.allowedProjectIds)
      ? [...new Set(value.allowedProjectIds.filter((id) => typeof id === 'string' && id))]
      : null,
    accessMode: DISPATCH_ACCESS_MODES.includes(value.accessMode) ? value.accessMode : defaultDispatchSettings.accessMode,
    modelId: typeof value.modelId === 'string' && value.modelId.trim() ? value.modelId.trim() : null,
    maxRunning: Number.isInteger(value.maxRunning) && value.maxRunning > 0 ? value.maxRunning : null,
  };
};

/** "ask" runs Read only; anything else runs with this Mac's limit. */
export const clampDispatchAccessMode = (requested, ceiling) => {
  const limit = DISPATCH_ACCESS_MODES.includes(ceiling) ? ceiling : defaultDispatchSettings.accessMode;
  return requested === 'ask' ? 'read-only' : limit;
};

export const isProjectAllowed = (projectId, allowedProjectIds) =>
  allowedProjectIds === null || allowedProjectIds === undefined || allowedProjectIds.includes(projectId);

const nameKey = (value) => String(value ?? '').trim().toLowerCase();

/**
 * The local project a dispatch runs in. Same order Durango matches machines
 * (repo id, then project id, then case-insensitive name), restricted to the
 * allowlist. `projects`: [{ id, name, path, repoId }].
 */
export const resolveDispatchProject = (dispatch, projects, allowedProjectIds = null) => {
  const wanted = dispatch?.project ?? {};
  const label = wanted.name || wanted.repoId || wanted.id;
  if (!wanted.repoId && !wanted.id && !nameKey(wanted.name)) {
    return {
      ok: false,
      error: `${dispatchSourceLabel(dispatch)} did not say which project to use. Name the project and start the agent again.`,
    };
  }
  const list = Array.isArray(projects) ? projects : [];
  const match =
    (wanted.repoId && list.find((project) => project.repoId && project.repoId === wanted.repoId)) ||
    (wanted.id && list.find((project) => project.id === wanted.id)) ||
    (nameKey(wanted.name) && list.find((project) => nameKey(project.name) === nameKey(wanted.name))) ||
    null;
  if (!match) {
    return {
      ok: false,
      error: `This Mac has no project matching "${label}". Add it to Durango Code, or start the agent on another machine.`,
    };
  }
  if (!isProjectAllowed(match.id, allowedProjectIds)) {
    return {
      ok: false,
      error: `"${match.name}" is not allowed to run agents from Durango on this Mac. Allow it in Durango Code → Settings → Durango.`,
    };
  }
  return { ok: true, project: match };
};

/** `POST /api/v1/code/machines` body. Only allowlisted projects are advertised. */
export const buildMachinePayload = ({ machineId, name, platform, projects, allowedProjectIds = null }) => ({
  machineId,
  name: String(name ?? '').trim().slice(0, 120) || 'Mac',
  platform: String(platform ?? '').slice(0, 40) || 'unknown',
  projects: (Array.isArray(projects) ? projects : [])
    .filter((project) => project?.id && project?.name && isProjectAllowed(project.id, allowedProjectIds))
    .slice(0, 500)
    .map((project) => ({
      id: String(project.id).slice(0, 200),
      name: String(project.name).slice(0, 200),
      repoId: typeof project.repoId === 'string' && project.repoId ? project.repoId : null,
    })),
});

/** Where a dispatch was started: Run in Durango Code on a task, or a chat. */
export const dispatchSourceLabel = (dispatch) => (dispatch?.origin === 'tasks' ? 'Durango Tasks' : 'Durango Chat');

/** The page the run was started from (the task, or the chat). */
export const dispatchSourceUrl = (dispatch) =>
  (dispatch?.origin === 'tasks' ? dispatch?.taskUrl : dispatch?.sourceChat?.url) ?? null;

/** The thread's first prompt: a provenance header, then what the user asked. */
export const buildDispatchPrompt = (dispatch) => {
  const label = dispatchSourceLabel(dispatch);
  const url = dispatchSourceUrl(dispatch);
  const header = url ? `[Started from ${label}: ${url}]` : `[Started from ${label}]`;
  return `${header}\n\n${String(dispatch?.prompt ?? '').trim()}`;
};

export const truncateText = (value, max) => {
  const text = String(value ?? '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

const abortableSleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

const isAbort = (error) =>
  error?.name === 'AbortError' ||
  error?.cause?.name === 'AbortError' ||
  (error instanceof DurangoError && error.code === 'network' && error.cause?.name === 'AbortError');

/**
 * deps:
 * - client: { registerMachine, claimDispatch, reportDispatch }
 * - getMachineId(): Promise<string|null>   stable per-install id
 * - getMachineName(): string|Promise<string>
 * - platform: string
 * - isSignedIn(): Promise<boolean>
 * - startRun({ dispatch, project, prompt, accessMode, modelId }): Promise<{ ok, threadId?, threadTitle?, error? }>
 * - stopRun(threadId, reason): Promise<void>     cancelled from Durango Chat
 * - notify({ dispatch, project, threadId }): void
 * - isOnline(): boolean
 * - canStart(): boolean            a renderer can take commands (a window is open)
 * - onStateChange(state): void
 */
export const createDispatchWorker = ({
  client,
  getMachineId,
  getMachineName = () => 'Mac',
  platform = process.platform,
  isSignedIn,
  startRun,
  stopRun = async () => {},
  notify = () => {},
  isOnline = () => true,
  canStart = () => true,
  onStateChange = () => {},
  sleep = abortableSleep,
  random = Math.random,
  heartbeatMs = DISPATCH_HEARTBEAT_MS,
  reportRetryDelaysMs = REPORT_RETRY_DELAYS_MS,
  log = (...args) => console.warn('[durango dispatch]', ...args),
}) => {
  let settings = normalizeDispatchSettings(null);
  let projects = [];
  let signedIn = false;
  let suspended = false;
  let generation = 0;
  let controller = null;
  let loopPromise = null;
  let status = 'off';
  let lastError = null;
  let registeredSignature = null;
  let registering = null;
  const running = new Map(); // dispatchId -> entry
  const cancelled = new Set();
  let slotWaiters = [];

  const publish = () => {
    try {
      onStateChange(getState());
    } catch {}
  };
  const setStatus = (next, error = lastError) => {
    if (status === next && lastError === error) return;
    status = next;
    lastError = error;
    publish();
  };

  const shouldRun = () => settings.enabled && signedIn && !suspended;

  const wakeSlotWaiters = () => {
    const waiters = slotWaiters;
    slotWaiters = [];
    for (const resolve of waiters) resolve();
  };
  const atLimit = () => settings.maxRunning !== null && running.size >= settings.maxRunning;
  const waitForSlot = (signal) =>
    new Promise((resolve) => {
      if (signal?.aborted || !atLimit()) return resolve();
      slotWaiters.push(resolve);
      signal?.addEventListener('abort', resolve, { once: true });
    });

  const registrationSignature = async () => {
    const machineId = await getMachineId();
    if (!machineId) return null;
    const payload = buildMachinePayload({
      machineId,
      name: await getMachineName(),
      platform,
      projects,
      allowedProjectIds: settings.allowedProjectIds,
    });
    return { payload, signature: JSON.stringify(payload) };
  };

  const register = async ({ force = false } = {}) => {
    if (registering) return registering;
    registering = (async () => {
      const next = await registrationSignature();
      if (!next) throw new Error('Durango Code could not create a device id for this Mac.');
      if (!force && next.signature === registeredSignature) return next.payload;
      await client.registerMachine(next.payload);
      registeredSignature = next.signature;
      return next.payload;
    })();
    try {
      return await registering;
    } finally {
      registering = null;
    }
  };

  // --- reporting -------------------------------------------------------------------

  const machineIdForReports = async () => (await getMachineId().catch(() => null)) ?? undefined;

  /** One report; resolves to 'ok' | 'conflict' (cancelled/settled elsewhere) | 'failed'. */
  const sendReport = async (dispatchId, body, { retries = [] } = {}) => {
    const machineId = await machineIdForReports();
    for (let attempt = 0; ; attempt += 1) {
      try {
        await client.reportDispatch(dispatchId, { ...body, ...(machineId ? { machineId } : {}) });
        return 'ok';
      } catch (error) {
        if (error instanceof DurangoError && error.status === 409) return 'conflict';
        if (error instanceof DurangoError && (error.code === 'not_signed_in' || error.status === 404)) {
          log(`report ${body.status} for ${dispatchId} dropped:`, error.message);
          return 'failed';
        }
        if (attempt >= retries.length) {
          log(`report ${body.status} for ${dispatchId} failed:`, error?.message ?? error);
          return 'failed';
        }
        await sleep(retries[attempt]);
      }
    }
  };

  // Reports for one dispatch go out in order (running before finished).
  const queueReport = (entry, body, options) => {
    const next = entry.reports.then(() => sendReport(entry.dispatch.id, body, options));
    entry.reports = next.catch(() => 'failed');
    return next;
  };

  const release = (entry) => {
    if (entry.heartbeat) clearInterval(entry.heartbeat);
    entry.heartbeat = null;
    if (running.get(entry.dispatch.id) === entry) running.delete(entry.dispatch.id);
    wakeSlotWaiters();
    publish();
  };

  const cancelFromChat = async (entry) => {
    if (entry.settled) return;
    entry.settled = true;
    cancelled.add(entry.dispatch.id);
    release(entry);
    if (entry.threadId) {
      try {
        await stopRun(entry.threadId, 'Cancelled from Durango Chat.');
      } catch (error) {
        log('could not stop a cancelled dispatch', error?.message ?? error);
      }
    }
  };

  const fail = async (entry, error) => {
    entry.settled = true;
    release(entry);
    await queueReport(
      entry,
      { status: 'failed', error: truncateText(error, DISPATCH_ERROR_MAX_CHARS) || 'The agent could not start.' },
      { retries: reportRetryDelaysMs }
    );
  };

  const handleDispatch = async (dispatch) => {
    const entry = {
      dispatch,
      project: null,
      threadId: null,
      heartbeat: null,
      settled: false,
      reports: Promise.resolve('ok'),
      startedAt: Date.now(),
    };
    running.set(dispatch.id, entry);
    publish();
    try {
      if (!(await isSignedIn())) {
        // Signed out between claim and start: never run. The lease expires
        // and Durango offers the dispatch again.
        entry.settled = true;
        release(entry);
        return;
      }
      if (!String(dispatch.prompt ?? '').trim()) {
        await fail(entry, 'The dispatch had an empty prompt.');
        return;
      }
      const resolved = resolveDispatchProject(dispatch, projects, settings.allowedProjectIds);
      if (!resolved.ok) {
        await fail(entry, resolved.error);
        return;
      }
      entry.project = resolved.project;
      const accessMode = clampDispatchAccessMode(dispatch.accessMode, settings.accessMode);
      let result;
      try {
        result = await startRun({
          dispatch,
          project: resolved.project,
          prompt: buildDispatchPrompt(dispatch),
          accessMode,
          modelId: dispatch.modelId ?? settings.modelId ?? null,
        });
      } catch (error) {
        result = { ok: false, error: error?.message ?? String(error) };
      }
      if (!result?.ok || !result.threadId) {
        await fail(entry, result?.error || 'The agent could not start.');
        return;
      }
      entry.threadId = result.threadId;
      publish();
      // The renderer may already have reported a very quick finish; that
      // report is queued behind nothing, so do not send `running` after it.
      if (entry.settled) return;
      const outcome = await queueReport(entry, {
        status: 'running',
        codeThreadId: result.threadId,
        ...(result.threadTitle ? { codeThreadTitle: String(result.threadTitle).slice(0, 200) } : {}),
      });
      if (outcome === 'conflict') {
        await cancelFromChat(entry);
        return;
      }
      try {
        notify({ dispatch, project: resolved.project, threadId: result.threadId });
      } catch {}
      if (entry.settled) return;
      entry.heartbeat = setInterval(() => {
        if (entry.settled) return;
        void queueReport(entry, { status: 'running', codeThreadId: entry.threadId }).then((beat) => {
          if (beat === 'conflict') void cancelFromChat(entry);
        });
      }, heartbeatMs);
      entry.heartbeat.unref?.();
    } catch (error) {
      if (!entry.settled) await fail(entry, error?.message ?? String(error));
    }
  };

  // --- claim loop ------------------------------------------------------------------

  const loop = async (myGeneration, signal) => {
    let failures = 0;
    let reRegistered = false;
    const current = () => myGeneration === generation && !signal.aborted && shouldRun();
    const backoff = async (error) => {
      failures += 1;
      const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(failures - 1, 6));
      const delay = Math.round(base * (0.75 + random() * 0.5));
      setStatus('error', error?.message ?? String(error));
      await sleep(delay, signal);
    };
    while (current()) {
      if (!isOnline()) {
        setStatus('offline', null);
        await sleep(OFFLINE_RECHECK_MS, signal);
        continue;
      }
      try {
        await register();
      } catch (error) {
        if (!current()) break;
        if (error instanceof DurangoError && error.code === 'not_signed_in') {
          setStatus('signed_out', null);
          break;
        }
        await backoff(error);
        continue;
      }
      // No window to create the thread in (macOS keeps running without
      // one): leave dispatches queued on Durango instead of failing them.
      if (!canStart()) {
        setStatus('no_window', null);
        await sleep(WINDOW_RECHECK_MS, signal);
        continue;
      }
      if (atLimit()) {
        setStatus('busy', null);
        await waitForSlot(signal);
        continue;
      }
      if (!current()) break;
      setStatus('listening', null);
      let claimed;
      try {
        const machineId = await getMachineId();
        claimed = await client.claimDispatch({ machineId, signal });
        failures = 0;
        reRegistered = false;
      } catch (error) {
        if (!current() || isAbort(error)) continue;
        if (error instanceof DurangoError && error.apiCode === 'machine_not_registered') {
          // Durango forgot this machine (pruned, or another account's
          // registration): register again right away, back off if it repeats.
          registeredSignature = null;
          if (reRegistered) await backoff(error);
          reRegistered = true;
          continue;
        }
        if (error instanceof DurangoError && error.code === 'not_signed_in') {
          setStatus('signed_out', null);
          break;
        }
        await backoff(error);
        continue;
      }
      const dispatch = claimed?.dispatch;
      if (!dispatch) continue;
      if (!current() || running.has(dispatch.id) || cancelled.has(dispatch.id)) continue;
      void handleDispatch(dispatch);
    }
  };

  const restart = () => {
    generation += 1;
    controller?.abort();
    controller = null;
    wakeSlotWaiters();
    if (!shouldRun()) {
      setStatus(
        !settings.enabled ? 'off' : !signedIn ? 'signed_out' : suspended ? 'paused' : 'off',
        null
      );
      return;
    }
    const myController = new AbortController();
    controller = myController;
    const myGeneration = generation;
    const previous = loopPromise ?? Promise.resolve();
    loopPromise = previous
      .catch(() => {})
      .then(() => loop(myGeneration, myController.signal))
      .catch((error) => log('claim loop stopped', error?.message ?? error))
      .finally(() => {
        if (myGeneration === generation && status !== 'signed_out' && status !== 'error') {
          if (!shouldRun()) setStatus(!settings.enabled ? 'off' : 'paused', null);
        }
      });
  };

  const stopHeartbeats = () => {
    for (const entry of running.values()) {
      if (entry.heartbeat) clearInterval(entry.heartbeat);
      entry.heartbeat = null;
    }
  };

  function getState() {
    return {
      enabled: settings.enabled,
      signedIn,
      status,
      lastError,
      maxRunning: settings.maxRunning,
      running: [...running.values()].map((entry) => ({
        dispatchId: entry.dispatch.id,
        threadId: entry.threadId,
        projectName: entry.project?.name ?? entry.dispatch.project?.name ?? null,
      })),
    };
  }

  return {
    getState,
    /** Settings and the project list from the renderer (startup and every change). */
    configure({ settings: nextSettings, projects: nextProjects } = {}) {
      const previous = settings;
      settings = normalizeDispatchSettings(nextSettings);
      if (Array.isArray(nextProjects)) projects = nextProjects;
      const lifecycleChanged = previous.enabled !== settings.enabled;
      if (lifecycleChanged || !loopPromise) {
        restart();
      } else {
        if (settings.maxRunning !== previous.maxRunning) wakeSlotWaiters();
        // Projects or the allowlist changed: re-register now (no-op when the
        // payload is unchanged) instead of after the current long-poll.
        if (shouldRun()) void register().catch((error) => log('registration failed', error?.message ?? error));
      }
      publish();
    },
    /** Account transitions. Sign-out stops polling at once. */
    accountChanged(isSignedInNow) {
      const next = Boolean(isSignedInNow);
      // Same state: only a loop that gave up on the account (the key could
      // not be minted) restarts; an active long-poll is left alone.
      if (next === signedIn && !(next && (status === 'signed_out' || status === 'error'))) return;
      signedIn = next;
      registeredSignature = null;
      if (!signedIn) stopHeartbeats();
      restart();
    },
    suspend() {
      if (suspended) return;
      suspended = true;
      restart();
    },
    resume() {
      if (!suspended) return;
      suspended = false;
      restart();
    },
    /**
     * The renderer saw a dispatched thread settle. `outcome`: finished |
     * failed. Also accepted for dispatches this process no longer tracks
     * (app restarted mid-run).
     */
    async settle({ dispatchId, threadId, outcome, summary, error }) {
      if (!dispatchId || cancelled.has(dispatchId)) return { ok: true, skipped: true };
      const entry = running.get(dispatchId) ?? {
        dispatch: { id: dispatchId, project: {} },
        threadId: threadId ?? null,
        heartbeat: null,
        settled: false,
        reports: Promise.resolve('ok'),
      };
      if (entry.settled && running.get(dispatchId) !== entry) return { ok: true, skipped: true };
      entry.settled = true;
      release(entry);
      const body =
        outcome === 'finished'
          ? {
              status: 'finished',
              ...(threadId || entry.threadId ? { codeThreadId: threadId || entry.threadId } : {}),
              summary: truncateText(summary, DISPATCH_SUMMARY_MAX_CHARS) || 'The agent finished.',
            }
          : {
              status: 'failed',
              ...(threadId || entry.threadId ? { codeThreadId: threadId || entry.threadId } : {}),
              error: truncateText(error, DISPATCH_ERROR_MAX_CHARS) || 'The agent stopped with an error.',
            };
      const result = await queueReport(entry, body, { retries: reportRetryDelaysMs });
      return { ok: result !== 'failed', result };
    },
    /** Quit: stop polling and heartbeats (in-flight runs die with the app). */
    stop() {
      settings = { ...settings, enabled: false };
      stopHeartbeats();
      restart();
    },
    /** For tests: resolves when the current loop exits. */
    idle: () => loopPromise ?? Promise.resolve(),
  };
};
