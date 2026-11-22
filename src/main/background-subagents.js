// Background subagents, for providers whose MCP tool calls have a hard time
// limit. Antigravity cancels any MCP call after 3 minutes and sends one call
// to a server at a time, so a spawn_subagent that blocks until a 10-minute
// review finishes times out there: the report has nowhere to go, parallel
// spawns start one after another, and the agent tends to stop the subagents
// or start the same work again. For those providers spawn_subagent returns as
// soon as the subthread has started, the report waits here, and the agent
// collects it with wait_subagents, whose every call returns well inside the
// limit. A report the agent never collected wakes its thread as a new message
// once that thread's turn has ended.

export const BACKGROUND_SUBAGENT_PROVIDERS = new Set(['antigravity']);
export const spawnsSubagentsInBackground = (providerId) => BACKGROUND_SUBAGENT_PROVIDERS.has(providerId);

// Under Antigravity's 3-minute limit with room for the call's own overhead.
export const WAIT_SUBAGENTS_MAX_MS = 150_000;
export const waitSubagentsTimeoutMs = (seconds) =>
  typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? Math.min(Math.round(seconds * 1000), WAIT_SUBAGENTS_MAX_MS)
    : WAIT_SUBAGENTS_MAX_MS;

const describe = (entry) => `"${entry.title}"${entry.model ? ` (${entry.model})` : ''}`;

export const subagentStartedText = (entry) =>
  `Started subagent ${describe(entry)} in the background (subthread ${entry.childThreadId}). ` +
  'It keeps running after this call returns. Do not spawn it again. ' +
  'Call wait_subagents to collect its report: each call waits up to 2.5 minutes, so call it again while it says ' +
  'a subagent is still running. Start every subagent you need first, then wait for them together. ' +
  'If your turn ends before a report is collected, it arrives later as a new message in this thread.';

const reportBlock = (entry) =>
  `### ${describe(entry)}${entry.stopped ? ' — stopped' : entry.ok ? '' : ' — failed'}\n\n${entry.result}`;

export const waitSubagentsText = ({ finished, running }) => {
  if (finished.length === 0 && running.length === 0) {
    return 'No subagents are waiting to be collected: every report from this thread has already been delivered.';
  }
  const parts = [];
  if (finished.length > 0) {
    parts.push(`${finished.length} subagent report${finished.length === 1 ? '' : 's'}:\n\n${finished.map(reportBlock).join('\n\n')}`);
  }
  if (running.length > 0) {
    parts.push(
      `Still running: ${running.map(describe).join(', ')}. Call wait_subagents again to keep waiting ` +
        '(do not spawn them again).'
    );
  }
  return parts.join('\n\n');
};

export const subagentReportsMessage = (entries) =>
  `Your background subagent${entries.length === 1 ? ' has' : 's have'} finished. ` +
  `Report${entries.length === 1 ? '' : 's'}:\n\n${entries.map(reportBlock).join('\n\n')}`;

/**
 * `onUncollected(entry)` hears of a report that finished while nobody was
 * waiting for it (not for stopped subagents: whoever stopped them knows).
 */
export const createBackgroundSubagents = ({ onUncollected } = {}) => {
  const entries = new Map(); // spawnId -> entry
  const listeners = new Set();

  const forDriver = (driverThreadId) =>
    [...entries.values()].filter((entry) => entry.driverThreadId === driverThreadId);

  const collect = (list) => {
    for (const entry of list) entries.delete(entry.spawnId);
    return list;
  };

  return {
    has: (spawnId) => entries.has(spawnId),

    start(spawnId, { driverThreadId, childThreadId, title, model, getSender }) {
      entries.set(spawnId, {
        spawnId,
        driverThreadId,
        childThreadId,
        title: title || 'Subagent',
        model: model || '',
        getSender,
        finished: false,
        ok: false,
        stopped: false,
        result: '',
      });
      return entries.get(spawnId);
    },

    /** Records a report. Returns false for a spawn this registry doesn't hold. */
    finish(spawnId, { ok, stopped = false, result }) {
      const entry = entries.get(spawnId);
      if (!entry || entry.finished) return false;
      Object.assign(entry, { finished: true, ok: ok === true, stopped: stopped === true, result: String(result ?? '') });
      // A waiting wait_subagents collects synchronously here.
      for (const listener of [...listeners]) listener();
      if (entries.has(spawnId) && !entry.stopped) onUncollected?.(entry);
      return true;
    },

    /**
     * Waits until every uncollected subagent of the driver has finished, the
     * timeout passes, or `signal` aborts; collects the finished ones.
     */
    wait(driverThreadId, { timeoutMs = WAIT_SUBAGENTS_MAX_MS, signal } = {}) {
      return new Promise((resolve) => {
        let timer = null;
        // An aborted wait (the driver's run ended) collects nothing: its
        // answer has no reader, so the reports stay for take().
        const settle = (aborted = false) => {
          listeners.delete(check);
          if (timer) clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
          const mine = forDriver(driverThreadId);
          resolve({
            finished: aborted ? [] : collect(mine.filter((entry) => entry.finished)),
            running: mine.filter((entry) => !entry.finished),
          });
        };
        const onAbort = () => settle(true);
        const check = () => {
          if (forDriver(driverThreadId).every((entry) => entry.finished)) settle();
        };
        if (signal?.aborted) {
          settle(true);
          return;
        }
        if (forDriver(driverThreadId).every((entry) => entry.finished)) {
          settle();
          return;
        }
        listeners.add(check);
        timer = setTimeout(() => settle(), Math.max(0, timeoutMs));
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });
    },

    /** Finished reports for a driver whose turn has ended (stopped ones are dropped, not delivered). */
    take(driverThreadId) {
      const done = collect(forDriver(driverThreadId).filter((entry) => entry.finished));
      return done.filter((entry) => !entry.stopped);
    },
  };
};
