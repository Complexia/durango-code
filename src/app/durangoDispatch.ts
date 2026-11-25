import { clipMiddle } from '../report-clip.js';
import type { AgentActivity, Message, Thread } from '../store';

// Renderer side of Durango Chat dispatch (main: src/main/durango-dispatch.js).

/** Lines up with DISPATCH_LIMITS.maxSummaryChars (4,000) for agent dispatches. */
export const DISPATCH_SUMMARY_MAX_CHARS = 4_000;
/**
 * Budget for bot task threads (`bottask:` / `localbot:`) whose inbox ceiling
 * is BOT_LIMITS.taskResultChars (12,000), leaving room for the refs block,
 * thread footer and `NOT FINISHED YET` header so nothing gets cut off.
 */
export const BOT_TASK_SUMMARY_MAX_CHARS = 9_000;

const summaryMaxCharsFor = (dispatchId: string) =>
  /^(bottask|localbot):/.test(dispatchId) ? BOT_TASK_SUMMARY_MAX_CHARS : DISPATCH_SUMMARY_MAX_CHARS;

/**
 * Prefer the turn's actual final message (text after the last tool/command/step)
 * over earlier progress narration from the same run. Visuals (`show_html`) and
 * theme cards stay inline with the answer they belong to. If the turn ended on
 * a tool call with no trailing text, falls back to the last non-empty text
 * segment before it (and to the whole content when activities carry no offsets).
 */
export const dispatchRunFinalText = (run: Pick<Message, 'content' | 'activities'>): string => {
  const content = run.content || '';
  if (!content.trim()) return '';
  const offsets: number[] = [];
  for (const activity of run.activities ?? []) {
    if (activity.visual || activity.theme) continue;
    const offset = Math.max(0, Math.min(activity.contentOffset ?? 0, content.length));
    if (offset > 0) offsets.push(offset);
  }
  if (offsets.length === 0) return content.trim();
  const boundaries = [0, ...new Set(offsets.sort((a, b) => a - b)), content.length];
  for (let index = boundaries.length - 1; index > 0; index -= 1) {
    const segment = content.slice(boundaries[index - 1], boundaries[index]).trim();
    if (segment) return segment;
  }
  return content.trim();
};

/** Keep the opening summary and the closing outcome/links when a report exceeds `max`. */
export const dispatchSummaryText = (content: string, max = DISPATCH_SUMMARY_MAX_CHARS) => clipMiddle(content, max);

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
 * The run a running dispatched thread is on for whoever dispatched it: the
 * dispatched run or a turn it resumed by itself, possibly ended while the
 * thread waits on background work it started, with its position among the
 * thread's runs (its reports' sequence numbers come from it). Null when the
 * thread isn't running or a turn the person started took over (that work is
 * theirs).
 */
export const durangoDispatchLiveRunAt = (
  thread: Pick<Thread, 'status' | 'durangoDispatch'>,
  messages: Message[]
): { run: Message; position: number } | null => {
  const dispatch = thread.durangoDispatch;
  if (!dispatch || thread.status !== 'running') return null;
  const runs = messages.filter((message) => message.role === 'agent' && message.kind === 'agent-run');
  const positions = dispatchRunPositions(runs, dispatch.runOffset ?? 0);
  const last = positions[positions.length - 1];
  return last !== undefined && last === runs.length - 1 ? { run: runs[last], position: last } : null;
};

export const durangoDispatchLiveRun = (thread: Pick<Thread, 'status' | 'durangoDispatch'>, messages: Message[]): Message | null =>
  durangoDispatchLiveRunAt(thread, messages)?.run ?? null;

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
    const maxSummary = summaryMaxCharsFor(dispatch.id);
    const finalText = dispatchRunFinalText(run);
    const summary = dispatchSummaryText(finalText, maxSummary) || 'The agent finished without a written summary.';
    const waiting = dispatchWaitingOn(thread, messages, run);
    if (waiting.length) {
      const waitingSeq = dispatchReportSeq(position, true);
      return waitingSeq > reportedSeq ? { outcome: 'finished', summary, waiting, seq: waitingSeq } : null;
    }
    // This run reported it was waiting; that wait is over and no turn followed.
    if (reportedSeq === dispatchReportSeq(position, true)) {
      return {
        outcome: 'finished',
        summary: `${WAIT_ENDED_PREFIX}${dispatchSummaryText(finalText, maxSummary - WAIT_ENDED_PREFIX.length) || '(none)'}`,
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

// While a thread a bot dispatched still runs, tell the bot when it can't go on
// without the person (a permission prompt, a question, an action only they can
// take) and when it has gone quiet with nothing of its own to wait on. Reports
// (app/durangoDispatch.ts) only go out when a turn ends, so without this a
// blocked thread looks exactly like a working one to its bot.
//
// A notice leaves this machine (Durango stores it in the bot's inbox), so it
// says what kind of thing is waiting and never carries the call itself: no
// tool arguments, no approval card details (Claude resolves secret refs into
// a call's input before it asks, so the card can hold a credential).

/** Quiet this long, with nothing it started to wait on, and the thread "looks stuck". */
export const DISPATCH_STUCK_AFTER_MS = 15 * 60_000;
const CHECK_EVERY_MS = 60_000;
const RETRY_MS = 60_000;
const DETAIL_MAX_CHARS = 1_500;
const REASON_MAX_CHARS = 300;

/** A pending question or approval card (CodexQuestionRequest's shape, as main lists it). */
export type PendingInputRequest = {
  requestId: string | number;
  /** The agent run that asked (main's run id). */
  runId?: string;
  /** Answered with an ordinary message later; the thread doesn't wait on it. */
  async?: boolean;
  detail?: string;
  approval?: {
    toolName?: string;
    /** Why the agent's harness asked (Claude Code's decision reason). */
    reason?: string;
    command?: string;
    path?: string;
    url?: string;
    input?: string;
    purpose?: string;
    title?: string;
  };
  questions: Array<{ id?: string; header: string; question: string; options?: Array<{ label: string }> | null }>;
};

export type DispatchNoticeInput = {
  dispatchId: string;
  threadId: string;
  kind: 'input' | 'stuck';
  /** One notice per key and dispatch. */
  key: string;
  /**
   * The sequence number the live run's final report will carry
   * (dispatchReportSeq): Durango drops a notice for a run it already has
   * that report for, so a notice that arrives late never contradicts it.
   */
  seq: number;
  detail: string;
};

type NoticesState = {
  threads: Thread[];
  transcripts: Record<string, { messages: Message[] } | undefined>;
};

export type DurangoDispatchNoticesDeps = {
  getState: () => NoticesState;
  subscribe: (listener: (state: NoticesState, previous: NoticesState) => void) => () => void;
  /** Agent turn events (window.orion.onAgentTurnEvent): any of them but `user-input` is progress. */
  onTurnEvent: (listener: (event: { threadId?: string; type: string }) => void) => (() => void) | undefined;
  /** The questions and approvals waiting on the person in this thread (main's pending lists). */
  pendingInput: (threadId: string) => Promise<PendingInputRequest[]>;
  /** The run message a main run id writes to, when known: a request from another run isn't this run's. */
  runMessageId?: (runId: string) => string | undefined;
  /** Main's durango:dispatchNotice: `{ retry: true }` (or a throw) = not delivered. */
  notice: (input: DispatchNoticeInput) => Promise<unknown> | unknown;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  stuckAfterMs?: number;
  checkEveryMs?: number;
};

const clipNotice = (text: string, max: number) => clipMiddle(text, max);

const isApproval = (request: PendingInputRequest) =>
  Boolean(request.approval) || (request.questions.length === 1 && request.questions[0]?.id === 'permission');

/** Pieces of a call's input long enough to matter (a path, a token, an argument). */
const inputPieces = (request: PendingInputRequest) => {
  const approval = request.approval ?? {};
  const texts = [approval.command, approval.path, approval.url, approval.input];
  const pieces = new Set<string>();
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    for (const piece of text.split(/[\s"'`=:,;()[\]{}<>|&]+/)) if (piece.length >= 6) pieces.add(piece);
  }
  return pieces;
};

/**
 * Why the harness asked, when that is safe to send: one line of its own words
 * that repeats nothing from the call (Claude Code's safety reasons are fixed
 * sentences; one that quotes the command, a path or a value is left out).
 */
export const safeApprovalReason = (request: PendingInputRequest) => {
  const reason = (request.approval?.reason ?? '').replace(/\s+/g, ' ').trim();
  if (!reason || reason.length > REASON_MAX_CHARS) return '';
  for (const piece of inputPieces(request)) if (reason.includes(piece)) return '';
  return reason;
};

/** A tool's name for the bot: `Bash`, `machine_run_agent` (an MCP tool by its own name). */
const plainToolName = (name: string) => name.trim().split('__').pop()?.split('.').pop()?.trim() || '';

/** What a pending card asks of the person, for the bot to pass on. Never the call itself (see above). */
export const pendingInputText = (request: PendingInputRequest) => {
  if (isApproval(request)) {
    const tool = plainToolName(request.approval?.toolName || request.questions[0]?.header || '') || 'a tool';
    const reason = safeApprovalReason(request);
    return clipNotice(
      [
        `It is waiting for the person to approve a ${tool} call in the thread (what the call does is shown there, not here).`,
        reason ? `Why it asked: ${reason}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      DETAIL_MAX_CHARS
    );
  }
  const lines = request.questions.map((question) => {
    const options = (question.options ?? []).map((option) => option.label).filter(Boolean);
    return `- ${question.question}${options.length ? ` (options: ${options.join(' / ')})` : ''}`;
  });
  return clipNotice(`It asked the person:\n${lines.join('\n')}`, DETAIL_MAX_CHARS);
};

/** request_user_action: what the agent asked the person to do, and the page (no query string or fragment). */
export const userActionText = (action: { action: string; url?: string }) => {
  let page = '';
  if (action.url) {
    try {
      const url = new URL(action.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') page = `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
    } catch {
      page = '';
    }
  }
  return clipNotice(`It asked the person to: ${action.action}${page ? `\n${page}` : ''}`, DETAIL_MAX_CHARS);
};

// Tools an agent waits on by its own choice: a background wait it set up, a
// subagent, a monitor. A quiet thread inside one of them isn't stuck.
const SELF_WAIT_TOOLS = new Set([
  'wait_for_background_tasks',
  'Monitor',
  'TaskOutput',
  'Agent',
  'Task',
  'spawn_subagent',
  'wait_subagents',
  'machine_run_agent',
  'browser_wait_for',
  'ScheduleWakeup',
]);

/**
 * The tool a step runs: its `toolName` (set by the drivers), else read from
 * the title of older steps, Claude's `Tool - mcp__orion__x` and Codex's
 * `Tool - orion.x` alike.
 */
export const activityToolName = (activity: Pick<AgentActivity, 'title' | 'toolName'>) =>
  plainToolName(activity.toolName || activity.title.replace(/^Tool - /, ''));

/**
 * Whether a quiet run is waiting on something it started itself: its turn
 * ended while the thread stays Working on background tasks or agents it
 * started, or the step in progress is one of those waits.
 */
export const runWaitsOnItself = (run: Message) => {
  if (run.status !== 'running') return true;
  return (run.activities ?? []).some(
    (activity) =>
      activity.status === 'running' &&
      (activity.kind === 'task' || (activity.type === 'tool' && SELF_WAIT_TOOLS.has(activityToolName(activity))))
  );
};

/** When the run last showed progress, from the transcript alone. */
const runProgressAt = (run: Message) => {
  let latest = Date.parse(run.startedAt ?? run.ts) || 0;
  for (const activity of run.activities ?? []) latest = Math.max(latest, Date.parse(activity.ts) || 0);
  return latest;
};

// What a stuck notice says about the step in progress: its kind and tool,
// never its arguments or output.
const stepText = (activity: AgentActivity) => {
  if (activity.type === 'command') return 'a shell command';
  const tool = activityToolName(activity);
  return tool ? `the ${tool} tool` : 'a tool call';
};

const stuckText = (run: Message, quietMs: number) => {
  const minutes = Math.round(quietMs / 60_000);
  const step = [...(run.activities ?? [])].reverse().find((activity) => activity.status === 'running');
  // Its latest words so far, preferring the current message over earlier progress lines.
  const words = dispatchRunFinalText(run);
  return clipNotice(
    [
      `No progress for ${minutes} minutes.`,
      step ? `The step in progress: ${stepText(step)} (what it runs is in the thread).` : 'No step is running: it is waiting on the model.',
      words ? `Its last words so far: ${dispatchSummaryText(words, 400)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    DETAIL_MAX_CHARS
  );
};

export const startDurangoDispatchNotices = ({
  getState,
  subscribe,
  onTurnEvent,
  pendingInput,
  runMessageId,
  notice,
  now = () => Date.now(),
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  stuckAfterMs = DISPATCH_STUCK_AFTER_MS,
  checkEveryMs = CHECK_EVERY_MS,
}: DurangoDispatchNoticesDeps) => {
  const startedAt = now();
  // Latest turn event per thread: the transcript keeps no timestamp for streamed text.
  const progressAt = new Map<string, number>();
  const sent = new Set<string>();
  // A pending-list read per thread at a time; a change while one is out reads again after it.
  const reading = new Set<string>();
  const readAgain = new Set<string>();
  // Threads last seen waiting on a card: they need the person, not a "looks stuck".
  const waitingOnPerson = new Set<string>();
  const timers = new Set<unknown>();
  let tick: unknown = null;
  let stopped = false;

  const later = (callback: () => void, ms: number) => {
    const timer = setTimer(() => {
      timers.delete(timer);
      if (!stopped) callback();
    }, ms);
    timers.add(timer);
    return timer;
  };

  type Live = { thread: Thread; run: Message; position: number };
  const liveOf = (thread: Thread, transcripts: NoticesState['transcripts']): Live | null => {
    if (!thread.durangoDispatch || thread.status !== 'running') return null;
    const messages = transcripts[thread.id]?.messages;
    const live = messages ? durangoDispatchLiveRunAt(thread, messages) : null;
    return live ? { thread, ...live } : null;
  };
  /** Running threads a dispatch is still working for, with that run. */
  const liveThreads = () => {
    const { threads, transcripts } = getState();
    const live: Live[] = [];
    for (const thread of threads) {
      const found = liveOf(thread, transcripts);
      if (found) live.push(found);
    }
    return live;
  };
  const liveThread = (threadId: string) => {
    const { threads, transcripts } = getState();
    const thread = threads.find((candidate) => candidate.id === threadId);
    return thread ? liveOf(thread, transcripts) : null;
  };
  const sameRun = (a: Live | null, b: Live | null) =>
    Boolean(a && b && a.thread.durangoDispatch?.id === b.thread.durangoDispatch?.id && a.run.id === b.run.id);

  const send = (live: Live, kind: DispatchNoticeInput['kind'], key: string, detail: string) => {
    const dispatchId = live.thread.durangoDispatch?.id;
    if (!dispatchId) return;
    const id = `${dispatchId}\n${key}`;
    if (sent.has(id)) return;
    sent.add(id);
    const threadId = live.thread.id;
    let result: unknown;
    try {
      result = notice({ dispatchId, threadId, kind, key, seq: dispatchReportSeq(live.position, false), detail });
    } catch (error) {
      result = Promise.reject(error);
    }
    void Promise.resolve(result)
      .then(
        (value) => (value as { retry?: boolean } | undefined)?.retry !== true,
        () => false
      )
      .then((delivered) => {
        if (delivered) return;
        // Not delivered: look again later and send it only if it still holds
        // (the request may have been answered, the run may have ended).
        later(() => {
          sent.delete(id);
          const current = liveThread(threadId);
          if (current) checkThread(current);
        }, RETRY_MS);
      });
  };

  // Actions the agent asked the person for (request_user_action) while it runs.
  const checkUserActions = (live: Live) => {
    for (const action of live.thread.userActions ?? []) send(live, 'input', `action:${action.id}`, userActionText(action));
  };

  const checkStuck = (live: Live) => {
    const { thread, run } = live;
    if (waitingOnPerson.has(thread.id) || (thread.userActions?.length ?? 0) > 0 || runWaitsOnItself(run)) return;
    const last = Math.max(progressAt.get(thread.id) ?? startedAt, runProgressAt(run));
    const quiet = now() - last;
    if (quiet < stuckAfterMs) return;
    // Once per quiet stretch: progress after it starts a new one.
    send(live, 'stuck', `stuck:${run.id}:${last}`, stuckText(run, quiet));
  };

  // Questions and approvals live in main: read them for this thread, then
  // (with what is waiting on the person now known) look for "stuck".
  const checkPendingInput = (threadId: string) => {
    if (reading.has(threadId)) {
      readAgain.add(threadId);
      return;
    }
    const before = liveThread(threadId);
    if (!before) return;
    reading.add(threadId);
    void Promise.resolve()
      .then(() => pendingInput(threadId))
      .then(
        (requests) => {
          if (stopped) return;
          // Only while the same dispatched run is still the live one.
          const live = liveThread(threadId);
          if (!live || !sameRun(before, live)) return;
          const blocking = requests.filter((request) => !request.async);
          if (blocking.length) waitingOnPerson.add(threadId);
          else waitingOnPerson.delete(threadId);
          for (const request of blocking) {
            const owner = request.runId && runMessageId ? runMessageId(request.runId) : undefined;
            if (owner !== undefined && owner !== live.run.id) continue;
            send(live, 'input', `input:${request.requestId}`, pendingInputText(request));
          }
          checkStuck(live);
        },
        () => undefined
      )
      .finally(() => {
        reading.delete(threadId);
        if (readAgain.delete(threadId) && !stopped) checkPendingInput(threadId);
      });
  };

  const checkThread = (live: Live) => {
    checkUserActions(live);
    checkPendingInput(live.thread.id);
  };

  const checkAll = () => {
    if (stopped) return;
    for (const live of liveThreads()) checkThread(live);
  };

  // The periodic look runs only while some dispatched thread is working.
  const schedule = () => {
    if (tick !== null || stopped || liveThreads().length === 0) return;
    tick = later(() => {
      tick = null;
      checkAll();
      schedule();
    }, checkEveryMs);
  };

  const unsubscribeEvents = onTurnEvent((event) => {
    if (stopped || !event.threadId) return;
    if (event.type !== 'user-input' && event.type !== 'prompt-suggestion') progressAt.set(event.threadId, now());
    if (event.type !== 'user-input') return;
    if (liveThread(event.threadId)) checkPendingInput(event.threadId);
  });
  const unsubscribeState = subscribe((state, previous) => {
    if (stopped || state.threads === previous.threads) return;
    const before = new Map(previous.threads.map((thread) => [thread.id, thread]));
    for (const live of liveThreads()) {
      if (before.get(live.thread.id)?.userActions !== live.thread.userActions) checkUserActions(live);
    }
    schedule();
  });
  checkAll();
  schedule();

  return () => {
    stopped = true;
    unsubscribeEvents?.();
    unsubscribeState();
    for (const timer of timers) clearTimer(timer);
    timers.clear();
  };
};

/** What main needs from each project to register this Mac (repo ids are read in main). */
export const dispatchProjectsPayload = (projects: Array<{ id: string; name: string; path: string }>) =>
  projects.map((project) => ({ id: project.id, name: project.name, path: project.path }));
