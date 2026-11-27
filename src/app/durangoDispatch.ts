import { clipMiddle, selectFinalMessage } from '../report-clip.js';
import type { AgentActivity, BotThreadTurn, Message, Thread } from '../store';

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

const isStepBoundaryActivity = (activity: AgentActivity) =>
  !activity.visual &&
  !activity.theme &&
  (activity.type === 'command' || activity.type === 'tool' || activity.type === 'plan');

/**
 * Prefer the turn's actual final message (text after the last tool/command/plan
 * step) over earlier progress narration from the same run. Reasoning entries,
 * visuals (`show_html`) and theme cards do not split the final answer. If the
 * turn ended on a tool call with no trailing text, falls back to the last
 * non-empty text segment before it; if it ended with a brief closing line right
 * after a substantial summary, keeps that summary too.
 */
export const dispatchRunFinalText = (run: Pick<Message, 'content' | 'activities'>): string => {
  const content = run.content || '';
  if (!content.trim()) return '';
  const offsets: number[] = [];
  for (const activity of run.activities ?? []) {
    if (!isStepBoundaryActivity(activity)) continue;
    const offset = Math.max(0, Math.min(activity.contentOffset ?? 0, content.length));
    if (offset > 0) offsets.push(offset);
  }
  if (offsets.length === 0) return content.trim();
  const boundaries = [0, ...new Set(offsets.sort((a, b) => a - b)), content.length];
  const segments: string[] = [];
  for (let index = 1; index < boundaries.length; index += 1) {
    const segment = content.slice(boundaries[index - 1], boundaries[index]).trim();
    if (segment) segments.push(segment);
  }
  return selectFinalMessage(segments) || content.trim();
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

/** Sequence number for a bot-started thread's non-dispatched turn, shifted by `seqBase` after transcript edits. */
export const botThreadTurnReportSeq = (position: number, waiting: boolean, seqBase = 0) =>
  dispatchReportSeq(position + seqBase, waiting);

const MAX_PENDING_BOT_THREAD_TURNS = 20;

/**
 * Stamps a newly started non-bot-dispatched turn onto a bot-started thread,
 * preserving any earlier `botThreadTurn` that still has an unreported outcome
 * in `pendingBotThreadTurns` (queued follow-ups, offline retries, sign-in sync).
 */
export const stampNextBotThreadTurn = (
  thread: Pick<Thread, 'botThreadTurn' | 'pendingBotThreadTurns' | 'botThreadTurnSeqBase'>,
  next: Omit<BotThreadTurn, 'seqBase'>
): Pick<Thread, 'botThreadTurn' | 'pendingBotThreadTurns'> => {
  const seqBase = thread.botThreadTurnSeqBase ?? 0;
  const stamped: BotThreadTurn = seqBase > 0 ? { ...next, seqBase } : { ...next };
  const pending = [...(thread.pendingBotThreadTurns ?? [])];
  const prev = thread.botThreadTurn;
  if (prev) {
    const prevBase = prev.seqBase ?? 0;
    const isEarlier = prev.runOffset < next.runOffset || prevBase < seqBase;
    const prevLastPos = Math.max(prev.runOffset, next.runOffset - 1);
    const needsReport =
      !prev.reportedAt ||
      (prev.reportedSeq !== undefined &&
        (prev.reportedSeq % 2 === 1 || botThreadTurnReportSeq(prevLastPos, false, prevBase) > prev.reportedSeq));
    if (isEarlier && needsReport) {
      const sameKey = (candidate: BotThreadTurn) =>
        candidate.runOffset === prev.runOffset && (candidate.seqBase ?? 0) === prevBase;
      if (!pending.some(sameKey)) pending.push(prev);
    }
  }
  const trimmed = pending.length > MAX_PENDING_BOT_THREAD_TURNS ? pending.slice(-MAX_PENDING_BOT_THREAD_TURNS) : pending;
  return {
    botThreadTurn: stamped,
    pendingBotThreadTurns: trimmed.length > 0 ? trimmed : undefined,
  };
};

/**
 * Marks a bot-started thread turn reported (whether it is still the active
 * `botThreadTurn` or was moved to `pendingBotThreadTurns` by a later turn).
 * A superseded pending turn whose final (even) report landed is pruned.
 */
export const applyBotThreadTurnReported = (
  thread: Pick<Thread, 'botThreadTurn' | 'pendingBotThreadTurns'>,
  runOffset: number,
  reported: { reportedAt: string; reportedSeq: number },
  seqBase = 0
): Partial<Pick<Thread, 'botThreadTurn' | 'pendingBotThreadTurns'>> | null => {
  const same = (turn: BotThreadTurn | undefined) =>
    Boolean(turn && turn.runOffset === runOffset && (turn.seqBase ?? 0) === seqBase);
  if (same(thread.botThreadTurn)) {
    return { botThreadTurn: { ...thread.botThreadTurn!, ...reported } };
  }
  const pending = thread.pendingBotThreadTurns ?? [];
  const index = pending.findIndex((turn) => same(turn));
  if (index === -1) return null;
  const nextPending =
    reported.reportedSeq % 2 === 0
      ? pending.filter((_turn, idx) => idx !== index)
      : pending.map((turn, idx) => (idx === index ? { ...turn, ...reported } : turn));
  return { pendingBotThreadTurns: nextPending.length > 0 ? nextPending : undefined };
};

/**
 * Updates a bot-started thread's turn-report tracking when the person edits an
 * earlier message and truncates the transcript from `priorRunCount` to
 * `keptRunCount`: advances `botThreadTurnSeqBase` so future turns never reuse
 * an already-reported `seq`, and drops turns whose runs were truncated away.
 */
export const botThreadTurnStateAfterEdit = (
  thread: Pick<Thread, 'botThreadTurn' | 'pendingBotThreadTurns' | 'botThreadTurnSeqBase'>,
  priorRunCount: number,
  keptRunCount: number
): Pick<Thread, 'botThreadTurn' | 'pendingBotThreadTurns' | 'botThreadTurnSeqBase'> => {
  const priorBase = thread.botThreadTurnSeqBase ?? 0;
  const priorMaxSeq = Math.max(
    thread.botThreadTurn?.reportedSeq ?? 0,
    ...(thread.pendingBotThreadTurns ?? []).map((turn) => turn.reportedSeq ?? 0)
  );
  const priorMaxSlot = Math.max(priorRunCount + priorBase, Math.ceil(priorMaxSeq / 2));
  const nextSeqBase = priorMaxSlot > keptRunCount ? Math.max(priorBase, priorMaxSlot - keptRunCount) : priorBase;
  const keepTurn = (turn: BotThreadTurn) => turn.runOffset < keptRunCount;
  const nextCurrent = thread.botThreadTurn && keepTurn(thread.botThreadTurn) ? thread.botThreadTurn : undefined;
  const nextPending = (thread.pendingBotThreadTurns ?? []).filter(keepTurn);
  return {
    botThreadTurn: nextCurrent,
    pendingBotThreadTurns: nextPending.length > 0 ? nextPending : undefined,
    botThreadTurnSeqBase: nextSeqBase > 0 ? nextSeqBase : undefined,
  };
};

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
 * Identifies the bot that started a Durango Code thread, so every later turn
 * started by the person or the Ship button reports back to that bot's inbox.
 * Returns null for threads not started by a bot, mirrored remote threads
 * (only the host machine reports), and subagents.
 */
export type BotThreadOwner = {
  mode: 'local' | 'durango';
  botId?: string;
  botName?: string;
  originDispatchId?: string;
};

const localBotIdFromDispatchId = (dispatchId: string): string | undefined => {
  if (!dispatchId.startsWith('localbot:')) return undefined;
  const rest = dispatchId.slice('localbot:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return undefined;
  const id = rest.slice(0, sep).trim();
  return id || undefined;
};

export const botThreadOwner = (
  thread: Pick<Thread, 'startedByBot' | 'startedByBotId' | 'startedByBotDispatchId' | 'durangoDispatch' | 'remote' | 'parentThreadId' | 'subagent'>
): BotThreadOwner | null => {
  if (thread.remote || thread.parentThreadId || thread.subagent) return null;
  const originDispatchId =
    thread.startedByBotDispatchId?.trim() ||
    (!thread.durangoDispatch?.followUp && !thread.durangoDispatch?.runOffset ? thread.durangoDispatch?.id?.trim() : undefined) ||
    undefined;
  const recordedId = thread.startedByBotId?.trim() || undefined;
  const recordedName = thread.startedByBot?.trim() || undefined;
  const isLocalDispatch = Boolean(originDispatchId?.startsWith('localbot:'));
  const isBotTaskDispatch = Boolean(originDispatchId?.startsWith('bottask:'));
  if (!recordedId && !recordedName && !isLocalDispatch && !isBotTaskDispatch) return null;
  const botId = recordedId ?? (originDispatchId ? localBotIdFromDispatchId(originDispatchId) : undefined);
  const botName = recordedName && recordedName !== 'bot' ? recordedName : undefined;
  const mode: 'local' | 'durango' = isLocalDispatch || (!isBotTaskDispatch && Boolean(botId?.startsWith('lb'))) ? 'local' : 'durango';
  return {
    mode,
    ...(botId ? { botId } : {}),
    ...(botName ? { botName } : {}),
    ...(originDispatchId ? { originDispatchId } : {}),
  };
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
 * The run a running non-bot-dispatched turn (Ship button or person) in a
 * bot-started thread is currently on, with its position among the thread's
 * runs. Disjoint from `durangoDispatchLiveRunAt` because a bot-dispatched
 * follow-up starts a non-continuation run at a newer offset.
 */
export const botThreadTurnLiveRunAt = (
  thread: Pick<
    Thread,
    'status' | 'startedByBot' | 'startedByBotId' | 'startedByBotDispatchId' | 'durangoDispatch' | 'remote' | 'parentThreadId' | 'subagent' | 'botThreadTurn'
  >,
  messages: Message[]
): { run: Message; position: number } | null => {
  const turn = thread.botThreadTurn;
  if (!turn || thread.status !== 'running' || !botThreadOwner(thread)) return null;
  const runs = messages.filter((message) => message.role === 'agent' && message.kind === 'agent-run');
  const positions = dispatchRunPositions(runs, turn.runOffset);
  const last = positions[positions.length - 1];
  return last !== undefined && last === runs.length - 1 ? { run: runs[last], position: last } : null;
};

/**
 * Whether `durangoDispatch` or a `botThreadTurn` may have a report left to send
 * (cheap: from the thread's shell). A report that said the thread was waiting
 * always may: its wait can end without a new run.
 */
export const durangoDispatchHasNewRuns = (
  tracked: { reportedAt?: string; reportedSeq?: number; seqBase?: number },
  agentRunCount: number
) =>
  !tracked.reportedAt ||
  (tracked.reportedSeq !== undefined &&
    (tracked.reportedSeq % 2 === 1 || botThreadTurnReportSeq(agentRunCount - 1, false, tracked.seqBase ?? 0) > tracked.reportedSeq));

const runChainOutcome = (
  thread: Pick<Thread, 'status'> & Partial<Pick<Thread, 'userActions'>>,
  messages: Message[],
  tracked: { runOffset: number; seqBase?: number; reportedAt?: string; reportedSeq?: number; maxSummary: number; superseded?: boolean }
): DurangoDispatchOutcome | null => {
  const seqBase = tracked.seqBase ?? 0;
  const superseded = tracked.superseded === true;
  if (thread.status === 'running' && !superseded) return null;
  // Reported by a build before reports had sequence numbers: once, as it always was.
  if (tracked.reportedAt && tracked.reportedSeq === undefined) return null;
  const reportedSeq = tracked.reportedAt ? (tracked.reportedSeq ?? 0) : 0;
  const runs = messages.filter((message) => message.role === 'agent' && message.kind === 'agent-run');
  const offset = tracked.runOffset;
  // The run message exists before tracking is stamped, so take the runs by position.
  const positions = dispatchRunPositions(runs, offset);
  if (positions.length === 0) {
    if (tracked.reportedAt || superseded) return null;
    // Start failures before any run message (rare): report the thread error.
    if (thread.status === 'error') return { outcome: 'failed', error: 'The agent failed to start.', seq: botThreadTurnReportSeq(offset, false, seqBase) };
    return null;
  }
  const position = positions[positions.length - 1];
  const hasLaterRun = position < runs.length - 1;
  // A superseded turn may settle while a newer turn is running only once that newer run exists.
  if (thread.status === 'running' && !(superseded && hasLaterRun)) return null;
  // Nothing newer than the last report can come from an earlier run.
  if (botThreadTurnReportSeq(position, false, seqBase) <= reportedSeq) return null;
  const run = runs[position];
  if (run.status === 'running') return null;
  const seq = botThreadTurnReportSeq(position, false, seqBase);
  if (run.status === 'error' || (!superseded && thread.status === 'error' && run.status !== 'done')) {
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
    const finalText = dispatchRunFinalText(run);
    const summary = dispatchSummaryText(finalText, tracked.maxSummary) || 'The agent finished without a written summary.';
    const waiting = dispatchWaitingOn(thread, messages, run, superseded && hasLaterRun);
    if (waiting.length) {
      const waitingSeq = botThreadTurnReportSeq(position, true, seqBase);
      return waitingSeq > reportedSeq ? { outcome: 'finished', summary, waiting, seq: waitingSeq } : null;
    }
    // This run reported it was waiting; that wait is over and no turn followed.
    if (reportedSeq === botThreadTurnReportSeq(position, true, seqBase)) {
      return {
        outcome: 'finished',
        summary: `${WAIT_ENDED_PREFIX}${dispatchSummaryText(finalText, tracked.maxSummary - WAIT_ENDED_PREFIX.length) || '(none)'}`,
        waitEnded: true,
        seq,
      };
    }
    return { outcome: 'finished', summary, seq };
  }
  return null;
};

/**
 * How a dispatched thread's work ended, or null while it is still running
 * (or has not started, or this was already reported). The dispatched run
 * counts: the thread's first run, or for a follow-up dispatch the run at
 * `runOffset` (the runs it already had), together with the turns the thread
 * then resumed by itself; the report is the latest of those. A turn that ends
 * while the thread still waits on background work reports as `waiting`, and
 * the turn that resumes and settles later (or the end of that wait) reports
 * again. Turns the person starts are handled separately by `botThreadTurnOutcome`.
 */
export const durangoDispatchOutcome = (
  thread: Pick<Thread, 'status' | 'durangoDispatch'> & Partial<Pick<Thread, 'userActions'>>,
  messages: Message[]
): DurangoDispatchOutcome | null => {
  const dispatch = thread.durangoDispatch;
  if (!dispatch) return null;
  return runChainOutcome(thread, messages, {
    runOffset: dispatch.runOffset ?? 0,
    reportedAt: dispatch.reportedAt,
    reportedSeq: dispatch.reportedSeq,
    maxSummary: summaryMaxCharsFor(dispatch.id),
  });
};

const botThreadTurnOutcomeFor = (
  thread: Pick<
    Thread,
    'status' | 'startedByBot' | 'startedByBotId' | 'startedByBotDispatchId' | 'durangoDispatch' | 'remote' | 'parentThreadId' | 'subagent'
  > &
    Partial<Pick<Thread, 'userActions'>>,
  messages: Message[],
  turn: BotThreadTurn,
  { superseded = false }: { superseded?: boolean } = {}
): DurangoDispatchOutcome | null => {
  if (!botThreadOwner(thread)) return null;
  return runChainOutcome(thread, messages, {
    runOffset: turn.runOffset,
    seqBase: turn.seqBase,
    reportedAt: turn.reportedAt,
    reportedSeq: turn.reportedSeq,
    maxSummary: BOT_TASK_SUMMARY_MAX_CHARS,
    superseded,
  });
};

/**
 * How a non-bot-dispatched turn (Ship button, person, or external) in a
 * bot-started thread ended, or null while running / not yet started / already reported.
 */
export const botThreadTurnOutcome = (
  thread: Pick<
    Thread,
    'status' | 'startedByBot' | 'startedByBotId' | 'startedByBotDispatchId' | 'durangoDispatch' | 'remote' | 'parentThreadId' | 'subagent' | 'botThreadTurn'
  > &
    Partial<Pick<Thread, 'userActions'>>,
  messages: Message[]
): DurangoDispatchOutcome | null => {
  const turn = thread.botThreadTurn;
  if (!turn) return null;
  return botThreadTurnOutcomeFor(thread, messages, turn);
};

const clipLine = (text: string, max = 160) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * What a settled turn left the thread waiting on: background commands still
 * running after it (the "Left running in the background" card that follows
 * the run, before any later agent run), and actions it asked the person for.
 * Empty: the work is done.
 */
const dispatchWaitingOn = (
  thread: Partial<Pick<Thread, 'userActions'>>,
  messages: Message[],
  run: Message,
  superseded = false
): string[] => {
  const startIndex = messages.indexOf(run) + 1;
  let endIndex = messages.length;
  for (let index = startIndex; index < messages.length; index += 1) {
    if (messages[index].role === 'agent' && messages[index].kind === 'agent-run') {
      endIndex = index;
      break;
    }
  }
  const after = messages.slice(startIndex, endIndex);
  const commands = after
    .filter(
      (message) =>
        message.kind === 'claude-background-intervention' &&
        (message.claudeBackgroundIntervention?.status === 'pending' || message.claudeBackgroundIntervention?.status === 'stopping')
    )
    .flatMap((message) => message.claudeBackgroundIntervention?.tasks ?? [])
    .map((task) => `background command: ${clipLine(task)}`);
  // With the request's id, so the bot can press Done for the person (answer_thread_request).
  // A superseded earlier turn does not own current userActions cards.
  const person = superseded
    ? []
    : (thread.userActions ?? []).map((action) =>
        action.secret
          ? `the person (secret request ${action.id}, only they can answer it): ${clipLine(action.action)}`
          : `the person (request ${action.id}): ${clipLine(action.action)}`
      );
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

export type BotThreadTurnSettledInput = {
  owner: BotThreadOwner;
  threadId: string;
  threadTitle?: string;
  projectName?: string;
  workspacePath?: string;
  trigger: 'person' | 'ship_button' | 'external';
  changeId?: string;
  surface?: string;
  promptPreview?: string;
  outcome: 'finished' | 'failed';
  summary?: string;
  error?: string;
  waiting?: string[];
  later?: boolean;
  seq: number;
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
  /** Main's bots:threadTurnSettled for non-dispatched turns in bot-started threads. */
  settleBotTurn?: (input: BotThreadTurnSettledInput) => Promise<unknown> | unknown;
  /** Persists `botThreadTurn.reportedAt / reportedSeq` (or updates/prunes a matching pending turn). */
  markBotTurnReported?: (
    threadId: string,
    runOffset: number,
    reported: { reportedAt: string; reportedSeq: number },
    seqBase?: number
  ) => void;
  /** Resolves a thread's project name for report footers. */
  getProjectName?: (projectId: string | null) => string | undefined;
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
  settleBotTurn,
  markBotTurnReported,
  getProjectName,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now = () => Date.now(),
  waitEndedGraceMs = 5_000,
  retryMs = 60_000,
}: DurangoDispatchReporterDeps) => {
  const inFlight = new Set<string>();
  const botTurnInFlight = new Set<string>();
  const loading = new Set<string>();
  // Shells already looked at with no outcome (or an unreadable transcript).
  // An outcome can only appear when the shell changes (its status or
  // summary), so each shell version is examined (and its transcript loaded)
  // at most once. Except while a reported wait lasts: it ends in the
  // transcript (the background card settles), not the shell.
  const examined = new WeakSet<Thread>();
  const botTurnExamined = new WeakSet<Thread>();
  const waitEndedSince = new Map<string, number>();
  const dispatchWaitReported = (thread: Thread) => (thread.durangoDispatch?.reportedSeq ?? 0) % 2 === 1;
  const botTurnWaitReported = (thread: Thread) =>
    (thread.botThreadTurn?.reportedSeq ?? 0) % 2 === 1 ||
    (thread.pendingBotThreadTurns ?? []).some((turn) => (turn.reportedSeq ?? 0) % 2 === 1);
  const waitReported = (thread: Thread) => dispatchWaitReported(thread) || botTurnWaitReported(thread);
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

  const loadTranscript = (thread: Thread, markExamined: WeakSet<Thread>) => {
    if (loading.has(thread.id)) return;
    loading.add(thread.id);
    void Promise.resolve()
      .then(() => ensureTranscript(thread.id))
      .catch((error) => {
        console.warn('Could not load a dispatched thread to report its outcome', error);
        markExamined.add(thread);
        return null;
      })
      .finally(() => {
        loading.delete(thread.id);
        check(getState().threads);
      });
  };

  const check = (threads: Thread[]) => {
    if (stopped) return;
    const { transcripts } = getState();
    for (const thread of threads) {
      // 1) Bot/Chat/Tasks/API dispatched run chain.
      const dispatch = thread.durangoDispatch;
      if (
        dispatch &&
        !inFlight.has(dispatch.id) &&
        durangoDispatchHasNewRuns(dispatch, thread.summary.agentRunCount) &&
        thread.status !== 'running' &&
        (!examined.has(thread) || dispatchWaitReported(thread))
      ) {
        if (thread.summary.agentRunCount <= (dispatch.runOffset ?? 0) && thread.status !== 'error') {
          examined.add(thread);
        } else {
          const transcript = transcripts[thread.id];
          if (!transcript) {
            loadTranscript(thread, examined);
          } else {
            const outcome = durangoDispatchOutcome(thread, transcript.messages);
            if (!outcome) {
              examined.add(thread);
            } else {
              let delayed = false;
              if (outcome.outcome === 'finished' && outcome.waitEnded) {
                const key = `${dispatch.id}:${outcome.seq}`;
                const since = waitEndedSince.get(key) ?? now();
                waitEndedSince.set(key, since);
                if (now() - since < waitEndedGraceMs) {
                  checkSoon(waitEndedGraceMs - (now() - since) + 50);
                  delayed = true;
                } else {
                  waitEndedSince.delete(key);
                }
              }
              if (!delayed) {
                inFlight.add(dispatch.id);
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
                      checkSoon(0);
                      return;
                    }
                    later(() => check(getState().threads), retryMs);
                  });
              }
            }
          }
        }
      }

      // 2) Non-bot-dispatched turns (Ship button, person typing on any surface, external)
      //    in a bot-started thread, including earlier unreported turns preserved in `pendingBotThreadTurns`.
      const botTurns: Array<{ turn: BotThreadTurn; superseded: boolean }> = [
        ...(thread.pendingBotThreadTurns ?? []).map((turn) => ({ turn, superseded: true })),
        ...(thread.botThreadTurn ? [{ turn: thread.botThreadTurn, superseded: false }] : []),
      ];
      const owner = botTurns.length > 0 && settleBotTurn ? botThreadOwner(thread) : null;
      if (owner && settleBotTurn && (!botTurnExamined.has(thread) || botTurnWaitReported(thread) || Boolean(thread.pendingBotThreadTurns?.length))) {
        let allExaminedWithoutOutcome = true;
        for (const { turn, superseded } of botTurns) {
          const seqBase = turn.seqBase ?? 0;
          const turnKey = `${thread.id}:${seqBase}:${turn.runOffset}`;
          if (botTurnInFlight.has(turnKey)) {
            allExaminedWithoutOutcome = false;
            continue;
          }
          if (!durangoDispatchHasNewRuns(turn, thread.summary.agentRunCount)) continue;
          if (thread.status === 'running' && !superseded) {
            allExaminedWithoutOutcome = false;
            continue;
          }
          if (thread.summary.agentRunCount <= turn.runOffset && (superseded || thread.status !== 'error')) continue;
          const transcript = transcripts[thread.id];
          if (!transcript) {
            allExaminedWithoutOutcome = false;
            loadTranscript(thread, botTurnExamined);
            break;
          }
          const outcome = botThreadTurnOutcomeFor(thread, transcript.messages, turn, { superseded });
          if (!outcome) continue;
          allExaminedWithoutOutcome = false;
          let delayed = false;
          if (outcome.outcome === 'finished' && outcome.waitEnded) {
            const key = `botturn:${turnKey}:${outcome.seq}`;
            const since = waitEndedSince.get(key) ?? now();
            waitEndedSince.set(key, since);
            if (now() - since < waitEndedGraceMs) {
              checkSoon(waitEndedGraceMs - (now() - since) + 50);
              delayed = true;
            } else {
              waitEndedSince.delete(key);
            }
          }
          if (!delayed) {
            botTurnInFlight.add(turnKey);
            const reported = { reportedAt: new Date(now()).toISOString(), reportedSeq: outcome.seq };
            const { waitEnded: _waitEnded, ...report } = outcome as typeof outcome & { waitEnded?: boolean };
            const projectName = getProjectName?.(thread.projectId);
            let settled: unknown;
            try {
              settled = settleBotTurn({
                owner,
                threadId: thread.id,
                ...(thread.title ? { threadTitle: thread.title } : {}),
                ...(projectName ? { projectName } : {}),
                ...(thread.durangoWorkspace?.path ? { workspacePath: thread.durangoWorkspace.path } : {}),
                trigger: turn.trigger,
                ...(turn.changeId ? { changeId: turn.changeId } : {}),
                ...(turn.surface ? { surface: turn.surface } : {}),
                ...(turn.promptPreview ? { promptPreview: turn.promptPreview } : {}),
                ...(turn.reportedAt ? { later: true } : {}),
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
                botTurnInFlight.delete(turnKey);
                if (stopped) return;
                if (delivered) {
                  markBotTurnReported?.(thread.id, turn.runOffset, reported, seqBase);
                  checkSoon(0);
                  return;
                }
                later(() => check(getState().threads), retryMs);
              });
          }
        }
        if (allExaminedWithoutOutcome && !thread.pendingBotThreadTurns?.length) {
          botTurnExamined.add(thread);
        }
      }
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

export type BotThreadTurnNoticeInput = {
  owner: BotThreadOwner;
  threadId: string;
  threadTitle?: string;
  projectName?: string;
  trigger: 'person' | 'ship_button' | 'external';
  changeId?: string;
  surface?: string;
  kind: 'input' | 'stuck';
  key: string;
  seq: number;
  detail: string;
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
  /** Main's bots:threadTurnNotice for non-dispatched turns in bot-started threads. */
  noticeBotTurn?: (input: BotThreadTurnNoticeInput) => Promise<unknown> | unknown;
  /** Resolves a thread's project name for notice footers. */
  getProjectName?: (projectId: string | null) => string | undefined;
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

/**
 * request_user_action: what the agent asked the person to do, the page (no
 * query string or fragment), and the request's id, which a bot answers it by
 * (answer_thread_request) when the person tells it they did it.
 */
export const userActionText = (action: { id?: string; action: string; url?: string; secret?: unknown }) => {
  let page = '';
  if (action.url) {
    try {
      const url = new URL(action.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') page = `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
    } catch {
      page = '';
    }
  }
  const id = action.id
    ? action.secret
      ? `\n(Secret request ${action.id}: only the person can answer it, on its card.)`
      : `\n(Request ${action.id}: when the person says they did it, mark it done with answer_thread_request.)`
    : '';
  // The id goes last but is never clipped away.
  return `${clipNotice(`It asked the person to: ${action.action}${page ? `\n${page}` : ''}`, DETAIL_MAX_CHARS - id.length)}${id}`;
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
  noticeBotTurn,
  getProjectName,
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

  type Live =
    | { channel: 'dispatch'; dispatchId: string; thread: Thread; run: Message; position: number }
    | {
        channel: 'botTurn';
        turnKey: string;
        owner: BotThreadOwner;
        turn: NonNullable<Thread['botThreadTurn']>;
        thread: Thread;
        run: Message;
        position: number;
      };
  const liveOf = (thread: Thread, transcripts: NoticesState['transcripts']): Live | null => {
    if (thread.status !== 'running') return null;
    const messages = transcripts[thread.id]?.messages;
    if (!messages) return null;
    if (thread.durangoDispatch) {
      const live = durangoDispatchLiveRunAt(thread, messages);
      if (live) return { channel: 'dispatch', dispatchId: thread.durangoDispatch.id, thread, ...live };
    }
    if (noticeBotTurn && thread.botThreadTurn) {
      const owner = botThreadOwner(thread);
      const live = owner ? botThreadTurnLiveRunAt(thread, messages) : null;
      if (owner && live) {
        return {
          channel: 'botTurn',
          turnKey: `botturn:${thread.id}:${thread.botThreadTurn.seqBase ?? 0}:${thread.botThreadTurn.runOffset}`,
          owner,
          turn: thread.botThreadTurn,
          thread,
          ...live,
        };
      }
    }
    return null;
  };
  /** Running threads a dispatch or bot-started turn is still working for, with that run. */
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
  const liveScopeKey = (live: Live) => (live.channel === 'dispatch' ? live.dispatchId : live.turnKey);
  const sameRun = (a: Live | null, b: Live | null) =>
    Boolean(a && b && a.channel === b.channel && liveScopeKey(a) === liveScopeKey(b) && a.run.id === b.run.id);

  const send = (live: Live, kind: DispatchNoticeInput['kind'], key: string, detail: string) => {
    const scope = liveScopeKey(live);
    if (!scope) return;
    const id = `${scope}\n${key}`;
    if (sent.has(id)) return;
    sent.add(id);
    const threadId = live.thread.id;
    const seq =
      live.channel === 'botTurn'
        ? botThreadTurnReportSeq(live.position, false, live.turn.seqBase ?? 0)
        : dispatchReportSeq(live.position, false);
    let result: unknown;
    try {
      if (live.channel === 'dispatch') {
        result = notice({ dispatchId: live.dispatchId, threadId, kind, key, seq, detail });
      } else {
        const projectName = getProjectName?.(live.thread.projectId);
        result = noticeBotTurn!({
          owner: live.owner,
          threadId,
          ...(live.thread.title ? { threadTitle: live.thread.title } : {}),
          ...(projectName ? { projectName } : {}),
          trigger: live.turn.trigger,
          ...(live.turn.changeId ? { changeId: live.turn.changeId } : {}),
          ...(live.turn.surface ? { surface: live.turn.surface } : {}),
          kind,
          key,
          seq,
          detail,
        });
      }
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
