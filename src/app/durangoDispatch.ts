import type { Message, Thread } from '../store';

// Renderer side of Durango Chat dispatch (main: src/main/durango-dispatch.js).

export const DISPATCH_SUMMARY_MAX_CHARS = 2_000;

/** The end of a long final response is where agents put their conclusion. */
export const dispatchSummaryText = (content: string, max = DISPATCH_SUMMARY_MAX_CHARS) => {
  const text = content.trim();
  if (text.length <= max) return text;
  return `…${text.slice(-(max - 1)).trimStart()}`;
};

const WAIT_ENDED_PREFIX =
  'The background work it was waiting on has ended (it finished, was stopped, or Durango Code quit) without the thread taking another turn. Its last words:\n\n';

export type DurangoDispatchOutcome =
  | {
      outcome: 'finished';
      summary: string;
      /**
       * The turn ended but the thread isn't done: what it still waits on
       * (background commands it left running, actions waiting on the person).
       * It reports again when it resumes on its own and settles, or when
       * that wait ends without another turn.
       */
      waiting?: string[];
      /**
       * This run already reported that it was waiting, and the wait ended
       * without the thread taking another turn (the commands finished or were
       * stopped, or Durango Code quit). The watcher sends it only after a
       * short grace period, since a turn that resumes looks like this until
       * its run message appears.
       */
      waitEnded?: boolean;
      seq: number;
    }
  | { outcome: 'failed'; error: string; seq: number };

/**
 * A report's sequence number, growing with every report one dispatch sends:
 * two per agent run, the odd one when its turn ended still waiting, so the
 * end of that wait (the even one) reports again for the same run.
 */
export const dispatchReportSeq = (position: number, waiting: boolean) => 2 * (position + 1) - (waiting ? 1 : 0);

/**
 * The dispatched run and the turns the thread then started on its own (a
 * background command it waited on finished, a subagent reported back, the
 * person answered a request), and the rest of a run a steer split in two:
 * positions in `runs`, the dispatched one first. A turn the person started
 * ends the chain: later turns are theirs.
 */
const dispatchRunPositions = (runs: Message[], offset: number) => {
  if (!runs[offset]) return [];
  const positions = [offset];
  while (runs[positions.length + offset]?.continuation) positions.push(positions.length + offset);
  return positions;
};

/**
 * Whether `durangoDispatch` may have a report left to send (cheap: from the
 * thread's shell). A report that said the thread was waiting always may: its
 * wait can end without a new run.
 */
export const durangoDispatchHasNewRuns = (dispatch: NonNullable<Thread['durangoDispatch']>, agentRunCount: number) =>
  !dispatch.reportedAt ||
  (dispatch.reportedSeq !== undefined && (dispatch.reportedSeq % 2 === 1 || dispatchReportSeq(agentRunCount - 1, false) > dispatch.reportedSeq));

/**
 * How a dispatched thread's work ended, or null while it is still running
 * (or has not started, or this was already reported). The dispatched run
 * counts: the thread's first run, or for a follow-up dispatch the run at
 * `runOffset` (the runs it already had), together with the turns the thread
 * then resumed by itself; the report is the latest of those. A turn that ends
 * while the thread still waits on background work reports as `waiting`, and
 * the turn that resumes and settles later (or the end of that wait) reports
 * again. Turns the person starts are their own.
 */
export const durangoDispatchOutcome = (
  thread: Pick<Thread, 'status' | 'durangoDispatch'> & Partial<Pick<Thread, 'userActions'>>,
  messages: Message[]
): DurangoDispatchOutcome | null => {
  const dispatch = thread.durangoDispatch;
  if (!dispatch) return null;
  if (thread.status === 'running') return null;
  // Reported by a build before reports had sequence numbers: once, as it always was.
  if (dispatch.reportedAt && dispatch.reportedSeq === undefined) return null;
  const reportedSeq = dispatch.reportedAt ? (dispatch.reportedSeq ?? 0) : 0;
  const runs = messages.filter((message) => message.role === 'agent' && message.kind === 'agent-run');
  const offset = dispatch.runOffset ?? 0;
  // The run message exists before `durangoDispatch` is stamped, so take the
  // runs by position rather than filtering by time.
  const positions = dispatchRunPositions(runs, offset);
  if (positions.length === 0) {
    if (dispatch.reportedAt) return null;
    // Start failures before any run message (rare): report the thread error.
    if (thread.status === 'error') return { outcome: 'failed', error: 'The agent failed to start.', seq: dispatchReportSeq(offset, false) };
    return null;
  }
  const position = positions[positions.length - 1];
  // Nothing newer than the last report can come from an earlier run.
  if (dispatchReportSeq(position, false) <= reportedSeq) return null;
  const run = runs[position];
  if (run.status === 'running') return null;
  const seq = dispatchReportSeq(position, false);
  if (run.status === 'error' || (thread.status === 'error' && run.status !== 'done')) {
    return { outcome: 'failed', error: (run.error || run.statusText || 'The agent stopped with an error.').trim(), seq };
  }
  if (run.status === 'stopped') {
    return {
      outcome: 'failed',
      error:
        run.statusText && /restart/i.test(run.statusText)
          ? 'Durango Code quit before the agent finished.'
          : 'Stopped in Durango Code before it finished.',
      seq,
    };
  }
  if (run.status === 'done') {
    const summary = dispatchSummaryText(run.content || '') || 'The agent finished without a written summary.';
    const waiting = dispatchWaitingOn(thread, messages, run);
    if (waiting.length) {
      const waitingSeq = dispatchReportSeq(position, true);
      return waitingSeq > reportedSeq ? { outcome: 'finished', summary, waiting, seq: waitingSeq } : null;
    }
    // This run reported it was waiting; that wait is over and no turn followed.
    if (reportedSeq === dispatchReportSeq(position, true)) {
      return {
        outcome: 'finished',
        summary: `${WAIT_ENDED_PREFIX}${dispatchSummaryText(run.content || '', DISPATCH_SUMMARY_MAX_CHARS - WAIT_ENDED_PREFIX.length) || '(none)'}`,
        waitEnded: true,
        seq,
      };
    }
    return { outcome: 'finished', summary, seq };
  }
  return null;
};

const clipLine = (text: string, max = 160) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * What a settled turn left the thread waiting on: background commands still
 * running after it (the "Left running in the background" card that follows
 * the run), and actions it asked the person for. Empty: the work is done.
 */
const dispatchWaitingOn = (
  thread: Partial<Pick<Thread, 'userActions'>>,
  messages: Message[],
  run: Message
): string[] => {
  const after = messages.slice(messages.indexOf(run) + 1);
  const commands = after
    .filter(
      (message) =>
        message.kind === 'claude-background-intervention' &&
        (message.claudeBackgroundIntervention?.status === 'pending' || message.claudeBackgroundIntervention?.status === 'stopping')
    )
    .flatMap((message) => message.claudeBackgroundIntervention?.tasks ?? [])
    .map((task) => `background command: ${clipLine(task)}`);
  const person = (thread.userActions ?? []).map((action) => `the person: ${clipLine(action.action)}`);
  return [...new Set([...commands, ...person])].slice(0, 6);
};

// The renderer's dispatch reporter (mounted by App.tsx): report each
// dispatched thread's outcome back to whoever started it (Durango Chat, a
// bot) once its run settles (finished → summary, error/stop → failed). Runs
// off the persisted thread state, so a run interrupted by a restart is still
// reported (as failed) on the next launch. A turn that ends while the thread
// still waits on background work reports as waiting; each turn the thread then
// resumes by itself, or the end of that wait, reports again.

type ReporterState = {
  threads: Thread[];
  transcripts: Record<string, { messages: Message[] } | undefined>;
};

export type DispatchSettledInput = {
  dispatchId: string;
  threadId: string;
  workspacePath?: string;
  outcome: 'finished' | 'failed';
  summary?: string;
  error?: string;
  waiting?: string[];
  seq?: number;
};

export type DurangoDispatchReporterDeps = {
  getState: () => ReporterState;
  subscribe: (listener: (state: ReporterState, previous: ReporterState) => void) => () => void;
  /** Loads a thread's transcript into the state. */
  ensureTranscript: (threadId: string) => Promise<unknown>;
  /** Main's durango:dispatchSettled: `{ retry: true }` (or a throw) = not delivered, try again later. */
  settle: (input: DispatchSettledInput) => Promise<unknown> | unknown;
  /** Persists `durangoDispatch.reportedAt / reportedSeq` (only if the thread still has that dispatch). */
  markReported: (threadId: string, dispatchId: string, reported: { reportedAt: string; reportedSeq: number }) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  now?: () => number;
  /**
   * A wait that ended with no turn after it is reported only once it has
   * looked that way this long: a turn that resumes settles the background
   * card a beat before its run message appears.
   */
  waitEndedGraceMs?: number;
  /** Delay before trying an undelivered report again. */
  retryMs?: number;
};

export const startDurangoDispatchReporter = ({
  getState,
  subscribe,
  ensureTranscript,
  settle,
  markReported,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now = () => Date.now(),
  waitEndedGraceMs = 5_000,
  retryMs = 60_000,
}: DurangoDispatchReporterDeps) => {
  const inFlight = new Set<string>();
  const loading = new Set<string>();
  // Shells already looked at with no outcome (or an unreadable transcript).
  // An outcome can only appear when the shell changes (its status or
  // summary), so each shell version is examined (and its transcript loaded)
  // at most once. Except while a reported wait lasts: it ends in the
  // transcript (the background card settles), not the shell.
  const examined = new WeakSet<Thread>();
  const waitEndedSince = new Map<string, number>();
  const waitReported = (thread: Thread) => (thread.durangoDispatch?.reportedSeq ?? 0) % 2 === 1;
  const timers = new Set<unknown>();
  let recheck: unknown = null;
  let stopped = false;

  const later = (callback: () => void, ms: number) => {
    const timer = setTimer(() => {
      timers.delete(timer);
      if (!stopped) callback();
    }, ms);
    timers.add(timer);
    return timer;
  };
  const checkSoon = (delayMs: number) => {
    if (recheck !== null) return;
    recheck = later(() => {
      recheck = null;
      check(getState().threads);
    }, delayMs);
  };

  const check = (threads: Thread[]) => {
    if (stopped) return;
    const { transcripts } = getState();
    for (const thread of threads) {
      const dispatch = thread.durangoDispatch;
      if (!dispatch || inFlight.has(dispatch.id)) continue;
      if (!durangoDispatchHasNewRuns(dispatch, thread.summary.agentRunCount)) continue;
      if (thread.status === 'running' || (examined.has(thread) && !waitReported(thread))) continue;
      // No dispatched run yet, and no start failure to report.
      if (thread.summary.agentRunCount <= (dispatch.runOffset ?? 0) && thread.status !== 'error') {
        examined.add(thread);
        continue;
      }
      const transcript = transcripts[thread.id];
      if (!transcript) {
        // The outcome is in the transcript: load it, then look again.
        if (loading.has(thread.id)) continue;
        loading.add(thread.id);
        void Promise.resolve()
          .then(() => ensureTranscript(thread.id))
          .catch((error) => {
            console.warn('Could not load a dispatched thread to report its outcome', error);
            examined.add(thread);
            return null;
          })
          .finally(() => {
            loading.delete(thread.id);
            check(getState().threads);
          });
        continue;
      }
      const outcome = durangoDispatchOutcome(thread, transcript.messages);
      if (!outcome) {
        examined.add(thread);
        continue;
      }
      if (outcome.outcome === 'finished' && outcome.waitEnded) {
        const key = `${dispatch.id}:${outcome.seq}`;
        const since = waitEndedSince.get(key) ?? now();
        waitEndedSince.set(key, since);
        if (now() - since < waitEndedGraceMs) {
          checkSoon(waitEndedGraceMs - (now() - since) + 50);
          continue;
        }
        waitEndedSince.delete(key);
      }
      inFlight.add(dispatch.id);
      // An outcome counts as reported only once it was delivered: offline
      // through every retry, it is tried again later (and on the next
      // launch) instead of leaving a bot's task without its outcome.
      const reported = { reportedAt: new Date(now()).toISOString(), reportedSeq: outcome.seq };
      const { waitEnded: _waitEnded, ...report } = outcome as typeof outcome & { waitEnded?: boolean };
      let settled: unknown;
      try {
        settled = settle({
          dispatchId: dispatch.id,
          threadId: thread.id,
          ...(/^(bottask|localbot):/.test(dispatch.id) && thread.durangoWorkspace?.path ? { workspacePath: thread.durangoWorkspace.path } : {}),
          ...report,
        });
      } catch (error) {
        settled = Promise.reject(error);
      }
      void Promise.resolve(settled)
        .then(
          (result) => (result as { retry?: boolean } | undefined)?.retry !== true,
          () => false
        )
        .then((delivered) => {
          inFlight.delete(dispatch.id);
          if (stopped) return;
          if (delivered) {
            markReported(thread.id, dispatch.id, reported);
            // A turn that settled while this report was on its way.
            checkSoon(0);
            return;
          }
          later(() => check(getState().threads), retryMs);
        });
    }
  };

  check(getState().threads);
  const unsubscribe = subscribe((state, previous) => {
    if (state.threads !== previous.threads) check(state.threads);
    // A reported wait ends in the transcript (its background card settles).
    else if (state.transcripts !== previous.transcripts) {
      const waiting = state.threads.filter(waitReported);
      if (waiting.length) check(waiting);
    }
  });
  return () => {
    stopped = true;
    unsubscribe();
    for (const timer of timers) clearTimer(timer);
    timers.clear();
  };
};

/** What main needs from each project to register this Mac (repo ids are read in main). */
export const dispatchProjectsPayload = (projects: Array<{ id: string; name: string; path: string }>) =>
  projects.map((project) => ({ id: project.id, name: project.name, path: project.path }));
