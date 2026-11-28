// "Needs you" requests of bot-started threads, in their bot's chat.
//
// A thread a Durango bot started that waits on the person (a request_user_action
// card, a request_secret card, a question or an approval) shows the same card
// in the bot's chat, on any device, and makes the bot stand out in the Bots
// sidebar until it is answered. This machine reports what its own bot-started
// threads wait on (startBotThreadRequestSync → main's bots:syncThreadRequests →
// Durango), as a whole set whenever it changes and every few seconds while
// anything waits; the same call brings back the answers the person gave in a
// bot's chat elsewhere, which are applied here exactly as the card's own
// buttons would (a secret's value is opened and applied by main alone). The
// Bots view shows a bot's cards from Durango's list and, for threads on (or
// mirrored to) this computer, from the live store (botNeedsYouCards), so
// answering in either place clears both.

import type { Thread, UserAction } from '../store';
import type { DesktopBotRequestResolution, DesktopBotRequestResolutionBy, DesktopBotRequestResolutionOp } from './bots';
import { botThreadOwner, safeApprovalReason, type BotThreadOwner, type PendingInputRequest } from './durangoDispatch';
import { pendingUserActions, type PendingUserAction } from './threadLists';

export type BotThreadRequestKind = 'action' | 'secret' | 'input';

/** One request as Durango lists it for a bot (convex botThreadRequestPolicy publicThreadRequest). */
export type BotThreadRequest = {
  id: string;
  botId: string;
  machineId: string;
  machineName: string | null;
  threadId: string;
  actionThreadId: string | null;
  subagentTitle: string | null;
  threadTitle: string | null;
  projectName: string | null;
  requestId: string;
  kind: BotThreadRequestKind;
  text: string;
  url: string | null;
  secretLabel: string | null;
  secretPlaceholder: string | null;
  /** The machine's key a secret's value is sealed to; null when its Durango Code can't take one from here. */
  secretKey: string | null;
  requestedAt: number;
  /** answering: answered in a bot's chat, on its way to the thread. resolved: no longer waiting. */
  status: 'pending' | 'answering' | 'resolved';
  answeredAt: number | null;
  answer: 'done' | 'reply' | 'dismiss' | 'save' | 'decline' | null;
  resolved?: DesktopBotRequestResolution | null;
  /** Why the last answer didn't go through there, and when Durango recorded it. */
  error: string | null;
  errorAt?: number | null;
};

export type BotThreadOwnerRefs = { botId?: string; taskId?: string; dispatchId?: string; botName?: string };

export type BotThreadSyncedRequest = {
  requestId: string;
  kind: BotThreadRequestKind;
  text: string;
  url?: string;
  actionThreadId?: string;
  subagentTitle?: string;
  secretLabel?: string;
  secretPlaceholder?: string;
  requestedAt: number;
};

export type BotThreadRequestSyncThread = {
  threadId: string;
  owner: BotThreadOwnerRefs;
  threadTitle?: string;
  projectName?: string;
  requests: BotThreadSyncedRequest[];
};

/** An answer from a bot's chat this machine couldn't apply (Durango shows the card again, with why). */
export type BotThreadRequestFailure = { threadId: string; requestId: string; at: number; error: string };

/** A resolution that happened on this machine (in the thread, via local panel card, or answer_thread_request). */
export type BotThreadRequestResolution = {
  threadId: string;
  actionThreadId?: string;
  owner?: BotThreadOwnerRefs;
  requestId: string;
  kind?: BotThreadRequestKind;
  op: DesktopBotRequestResolutionOp;
  by: DesktopBotRequestResolutionBy;
  byName?: string;
  at: number;
};

export type BotThreadRequestSyncInput = {
  threads: BotThreadRequestSyncThread[];
  failed?: BotThreadRequestFailure[];
  resolved?: BotThreadRequestResolution[];
};

/** An answer given in a bot's chat on another device, for this machine to press. */
export type BotThreadRequestAnswer = {
  threadId: string;
  actionThreadId: string;
  requestId: string;
  op: 'done' | 'reply' | 'dismiss';
  reply?: string;
  at: number;
};

const LOCAL_BOT_DISPATCH_PREFIX = 'localbot:';
const BOT_TASK_DISPATCH_PREFIX = 'bottask:';

/** The bot references Durango finds a thread's bot by (main's botOwnerRefs). */
export const botOwnerRefs = (owner: BotThreadOwner): BotThreadOwnerRefs => {
  const origin = owner.originDispatchId?.trim() ?? '';
  const taskId = origin.startsWith(BOT_TASK_DISPATCH_PREFIX) ? origin.slice(BOT_TASK_DISPATCH_PREFIX.length).slice(0, 128) : '';
  const dispatchId =
    origin && !origin.startsWith(BOT_TASK_DISPATCH_PREFIX) && !origin.startsWith(LOCAL_BOT_DISPATCH_PREFIX) ? origin.slice(0, 128) : '';
  return {
    ...(owner.botId ? { botId: owner.botId.slice(0, 128) } : {}),
    ...(owner.botName ? { botName: owner.botName.slice(0, 80) } : {}),
    ...(taskId ? { taskId } : {}),
    ...(dispatchId ? { dispatchId } : {}),
  };
};

const TEXT_MAX = 4_000;
const clip = (text: string, max = TEXT_MAX) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const plainToolName = (name: string) => name.trim().split('__').pop()?.split('.').pop()?.trim() || '';

/** A question or approval as its card in the bot's chat says it (what the call does stays in the thread). */
export const pendingInputCardText = (request: PendingInputRequest) => {
  const approval = Boolean(request.approval) || (request.questions.length === 1 && request.questions[0]?.id === 'permission');
  if (approval) {
    const tool = plainToolName(request.approval?.toolName || request.questions[0]?.header || '') || 'a tool';
    const reason = safeApprovalReason(request);
    return clip([`Approve a **${tool}** call in the thread.`, reason ? `Why it asked: ${reason}` : ''].filter(Boolean).join('\n\n'));
  }
  return clip(
    request.questions
      .map((question) => {
        const options = (question.options ?? []).map((option) => option.label).filter(Boolean);
        return `${question.question}${options.length ? `\n\n${options.map((label) => `- ${label}`).join('\n')}` : ''}`;
      })
      .join('\n\n')
  );
};

const syncedAction = (action: PendingUserAction, rootId: string): BotThreadSyncedRequest => ({
  requestId: action.id,
  kind: action.secret ? 'secret' : 'action',
  text: clip(action.secret ? action.secret.reason || action.secret.label : action.action),
  ...(action.url ? { url: action.url } : {}),
  ...(action.threadId !== rootId ? { actionThreadId: action.threadId, subagentTitle: action.threadTitle } : {}),
  ...(action.secret ? { secretLabel: action.secret.label, ...(action.secret.placeholder ? { secretPlaceholder: action.secret.placeholder } : {}) } : {}),
  requestedAt: Date.parse(action.requestedAt) || 0,
});

const threadsById = (threads: Thread[]) => new Map(threads.map((thread) => [thread.id, thread]));

/** The thread the sidebar shows for `thread` (a subagent's top parent), when a Durango bot started it. */
const ownedRootOf = (byId: ReadonlyMap<string, Thread>, thread: Thread): Thread | null => {
  let root = thread;
  for (let depth = 0; root.parentThreadId && depth < 20; depth += 1) {
    const parent = byId.get(root.parentThreadId);
    if (!parent) return null;
    root = parent;
  }
  return botThreadOwner(root)?.mode === 'durango' ? root : null;
};

/** Running threads of bot-started families (the thread and its subagents): only they can wait on a question. */
const runningOwnedThreads = (threads: Thread[]) => {
  const byId = threadsById(threads);
  return threads.filter((thread) => thread.status === 'running' && ownedRootOf(byId, thread) !== null);
};

/**
 * What this machine's bot-started threads (Durango bots; not signed-out local
 * bots, not mirrors of another machine's threads) wait on the person for:
 * their cards and their subagents', and the questions and approvals main
 * holds for any thread of the family (`inputs`, by thread).
 */
export const botThreadRequestSet = (
  threads: Thread[],
  inputs: ReadonlyMap<string, PendingInputRequest[]>,
  projectName: (projectId: string | null) => string | undefined = () => undefined
): BotThreadRequestSyncThread[] => {
  const byId = threadsById(threads);
  // Each thread with questions, under its bot-started root.
  const inputsByRoot = new Map<string, Thread[]>();
  for (const threadId of inputs.keys()) {
    const thread = byId.get(threadId);
    const root = thread ? ownedRootOf(byId, thread) : null;
    if (!thread || !root) continue;
    inputsByRoot.set(root.id, [...(inputsByRoot.get(root.id) ?? []), thread]);
  }
  const out: BotThreadRequestSyncThread[] = [];
  for (const thread of threads) {
    const owner = botThreadOwner(thread);
    if (!owner || owner.mode !== 'durango') continue;
    const refs = botOwnerRefs(owner);
    if (!refs.botId && !refs.taskId && !refs.dispatchId && !refs.botName) continue;
    const requests = pendingUserActions(threads, thread.id).map((action) => syncedAction(action, thread.id));
    for (const asker of inputsByRoot.get(thread.id) ?? []) {
      const own = asker.id === thread.id;
      for (const request of inputs.get(asker.id) ?? []) {
        if (request.async) continue;
        requests.push({
          requestId: `q:${own ? '' : `${asker.id}:`}${String(request.requestId)}`.slice(0, 128),
          kind: 'input',
          text: pendingInputCardText(request),
          ...(own ? {} : { actionThreadId: asker.id, subagentTitle: asker.title }),
          // Durango keeps the time it first saw it.
          requestedAt: 0,
        });
      }
    }
    if (!requests.length) continue;
    const project = projectName(thread.projectId ?? null);
    out.push({
      threadId: thread.id,
      owner: refs,
      ...(thread.title ? { threadTitle: thread.title.slice(0, 200) } : {}),
      ...(project ? { projectName: project } : {}),
      requests,
    });
  }
  return out;
};

/** A set's identity: an unchanged set isn't sent again until the next poll. */
const setKey = (set: BotThreadRequestSyncThread[]) => JSON.stringify(set);

export const BOT_REQUEST_POLL_MS = 4_000;
export const BOT_REQUEST_SLOW_POLL_MS = 15_000;
/** How long after the set last changed the brisk poll lasts. */
export const BOT_REQUEST_BRISK_FOR_MS = 10 * 60_000;
const RETRY_MS = 30_000;
const SIGNED_OUT_RETRY_MS = 120_000;

type SyncState = { threads: Thread[] };

export type BotThreadRequestSyncDeps = {
  getState: () => SyncState;
  subscribe: (listener: (state: SyncState, previous: SyncState) => void) => () => void;
  /** Agent turn events: a `user-input` one means a question or approval may have come or gone. */
  onTurnEvent?: (listener: (event: { threadId?: string; type: string }) => void) => (() => void) | undefined;
  /** The questions and approvals waiting on the person in a thread (main's pending lists). */
  pendingInput?: (threadId: string) => Promise<PendingInputRequest[]>;
  sync: (
    input: BotThreadRequestSyncInput
  ) => Promise<
    | { ok: boolean; code?: string; answers?: BotThreadRequestAnswer[]; ended?: Array<{ threadId: string; requestId: string }> }
    | undefined
  >;
  /** Presses a card's button for an answer given in a bot's chat elsewhere (throws when it can't). */
  apply: (answer: BotThreadRequestAnswer) => void;
  /** Drops a secret card whose request already ended (main no longer waits on it), as the thread view does. */
  dropCard?: (threadId: string, requestId: string) => void;
  /**
   * Resolves once the store holds this machine's threads (persist hydration):
   * a set read before it would be empty and clear Durango's copy, answers
   * waiting in it included.
   */
  whenReady?: () => Promise<void>;
  projectName?: (projectId: string | null) => string | undefined;
  /**
   * Whether Durango may still hold requests from this machine (it sent a
   * non-empty set last time): only then does an empty set go out at start,
   * so machines whose bot threads never wait on anyone send nothing.
   */
  hadRequests?: () => boolean;
  setHadRequests?: (value: boolean) => void;
  /** Resolution queue for this machine (defaults to the shared `botResolvedRequests` store). */
  resolutions?: {
    subscribe: (listener: () => void) => () => void;
    pending: () => BotThreadRequestResolution[];
    acknowledge: (sent: readonly BotThreadRequestResolution[]) => void;
  };
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

/** Keeps Durango's copy of this machine's bot-thread requests current; returns a stop function. */
export const startBotThreadRequestSync = ({
  getState,
  subscribe,
  onTurnEvent,
  pendingInput,
  sync,
  apply,
  dropCard,
  whenReady = () => Promise.resolve(),
  projectName,
  hadRequests = () => true,
  setHadRequests = () => undefined,
  resolutions = botResolvedRequests,
  now = () => Date.now(),
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}: BotThreadRequestSyncDeps) => {
  let stopped = false;
  let timer: unknown = null;
  let timerAt = Infinity;
  let inFlight = false;
  let again = false;
  // Durango has something from this machine to clear: send even an empty set once.
  let dirty = hadRequests();
  // Otherwise Durango holds nothing from here: an empty set needn't go out.
  let sentKey: string | null = dirty ? null : setKey([]);
  let changedAt = now();
  let ready = false;
  const applied = new Set<string>();
  // Answers that couldn't be pressed, reported with the next sync.
  let failures: BotThreadRequestFailure[] = [];
  const inputs = new Map<string, PendingInputRequest[]>();
  const readingInputs = new Set<string>();

  const schedule = (ms: number) => {
    if (stopped) return;
    const at = now() + ms;
    if (timer !== null && timerAt <= at) return;
    if (timer !== null) clearTimer(timer);
    timerAt = at;
    timer = setTimer(() => {
      timer = null;
      timerAt = Infinity;
      void tick();
    }, ms);
  };

  /** Reads a thread's questions and approvals; a change sends the set soon. */
  const readInputs = (threadId: string) => {
    if (!pendingInput || readingInputs.has(threadId)) return;
    readingInputs.add(threadId);
    void Promise.resolve()
      .then(() => pendingInput(threadId))
      .then(
        (requests) => {
          const blocking = (requests ?? []).filter((request) => !request.async);
          const before = JSON.stringify(inputs.get(threadId) ?? []);
          if (blocking.length) inputs.set(threadId, blocking);
          else inputs.delete(threadId);
          if (JSON.stringify(blocking) !== before) schedule(300);
        },
        () => undefined
      )
      .finally(() => readingInputs.delete(threadId));
  };

  const tick = async () => {
    if (stopped || !ready) return;
    if (inFlight) {
      again = true;
      return;
    }
    const { threads } = getState();
    // Questions only wait while a turn runs; a stopped thread's are gone.
    const running = new Set(runningOwnedThreads(threads).map((thread) => thread.id));
    for (const id of [...inputs.keys()]) if (!running.has(id)) inputs.delete(id);
    const set = botThreadRequestSet(threads, inputs, projectName);
    const key = setKey(set);
    if (key !== sentKey) changedAt = now();
    const waiting = set.length > 0;
    const pendingResolved = resolutions.pending();
    if (key === sentKey && !dirty && !waiting && failures.length === 0 && pendingResolved.length === 0) return;
    inFlight = true;
    const reporting = failures;
    let result: Awaited<ReturnType<typeof sync>>;
    try {
      result = await sync({
        threads: set,
        ...(reporting.length ? { failed: reporting } : {}),
        ...(pendingResolved.length ? { resolved: pendingResolved } : {}),
      });
    } catch {
      result = undefined;
    }
    inFlight = false;
    if (stopped) return;
    if (!result?.ok) {
      // Signed out (local bots), or Durango can't be reached: look again later.
      schedule(result?.code === 'local' ? SIGNED_OUT_RETRY_MS : RETRY_MS);
      return;
    }
    sentKey = key;
    dirty = false;
    failures = failures.filter((failure) => !reporting.includes(failure));
    if (pendingResolved.length) resolutions.acknowledge(pendingResolved);
    setHadRequests(waiting);
    for (const ended of result.ended ?? []) {
      try {
        dropCard?.(ended.threadId, ended.requestId);
      } catch {
        // Gone already.
      }
      schedule(300);
    }
    for (const answer of result.answers ?? []) {
      const id = `${answer.threadId}\n${answer.requestId}\n${answer.at}`;
      if (applied.has(id)) continue;
      applied.add(id);
      if (applied.size > 200) applied.delete(applied.values().next().value as string);
      const current = getState().threads;
      const family = pendingUserActions(current, answer.threadId);
      if (!family.some((action) => action.id === answer.requestId && !action.secret)) continue;
      try {
        apply(answer);
      } catch (error) {
        // The card stays: Durango shows it again, with why, and a new answer can come.
        failures.push({
          threadId: answer.threadId,
          requestId: answer.requestId,
          at: answer.at,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 300) || 'It could not be answered there.',
        });
      }
      // Its card is gone now: say so at once.
      schedule(300);
    }
    if (again) {
      again = false;
      schedule(0);
      return;
    }
    if (waiting) {
      // Questions come and go inside a turn; read them on each poll too.
      for (const thread of runningOwnedThreads(getState().threads)) readInputs(thread.id);
      schedule(now() - changedAt < BOT_REQUEST_BRISK_FOR_MS ? BOT_REQUEST_POLL_MS : BOT_REQUEST_SLOW_POLL_MS);
    }
  };

  const unsubscribe = subscribe((state, previous) => {
    if (stopped || state.threads === previous.threads) return;
    const before = new Map(previous.threads.map((thread) => [thread.id, thread]));
    const byId = threadsById(state.threads);
    let relevant = false;
    for (const thread of state.threads) {
      const old = before.get(thread.id);
      if (old?.userActions !== thread.userActions || old?.title !== thread.title || (old?.status === 'running') !== (thread.status === 'running')) {
        relevant = true;
        if (thread.status === 'running' && ownedRootOf(byId, thread)) readInputs(thread.id);
      }
    }
    if (relevant || state.threads.length !== previous.threads.length) schedule(300);
  });
  const unsubscribeEvents = onTurnEvent?.((event) => {
    if (stopped || event.type !== 'user-input' || !event.threadId) return;
    const threads = getState().threads;
    const thread = threads.find((candidate) => candidate.id === event.threadId);
    if (thread && ownedRootOf(threadsById(threads), thread)) readInputs(thread.id);
  });
  const unsubscribeResolutions = resolutions.subscribe(() => {
    if (stopped || resolutions.pending().length === 0) return;
    schedule(150);
  });
  // Only once the app has loaded its threads (then Durango drops what this machine no longer waits on).
  void Promise.resolve()
    .then(() => whenReady())
    .catch(() => undefined)
    .then(() => {
      if (stopped) return;
      ready = true;
      for (const thread of runningOwnedThreads(getState().threads)) readInputs(thread.id);
      schedule(1_500);
    });

  return () => {
    stopped = true;
    unsubscribe();
    unsubscribeEvents?.();
    unsubscribeResolutions();
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
};

// --- The Bots view's cards ----------------------------------------------------------

/**
 * A card in a bot's chat. `here`: its thread is on (or mirrored to) this
 * computer, so its buttons act on the live card like the thread view's;
 * otherwise they go through Durango to the machine it runs on.
 */
export type BotNeedsYouCard = {
  key: string;
  kind: BotThreadRequestKind;
  /** The card's request as the thread view's UserActionCards takes it (threadId: where its buttons act). */
  action: PendingUserAction;
  /** The bot-started thread (to open it). */
  threadId: string;
  threadTitle: string;
  machineName: string | null;
  projectName: string | null;
  here: boolean;
  /** Durango's request (null for one only this computer knows of yet). */
  request: BotThreadRequest | null;
};

const asUserAction = (request: BotThreadRequest): UserAction => ({
  id: request.requestId,
  action: request.text,
  ...(request.url ? { url: request.url } : {}),
  requestedAt: new Date(request.requestedAt || Date.now()).toISOString(),
  ...(request.kind === 'secret'
    ? {
        secret: {
          label: request.secretLabel || 'A value only you have',
          // The machine sends the label as the text when the request had no reason: don't say it twice.
          reason: request.text && request.text !== request.secretLabel ? request.text : '',
          ...(request.secretPlaceholder ? { placeholder: request.secretPlaceholder } : {}),
          expiresAt: '',
        },
      }
    : {}),
});

/** The thread here a request's thread id names: its own, or this computer's mirror of it. */
const threadHere = (threads: Thread[], threadId: string) =>
  threads.find((thread) => thread.id === threadId) ??
  threads.find((thread) => thread.remote?.threadId === threadId) ??
  null;

/**
 * A bot's "Needs you" cards, oldest first: Durango's requests for it, each
 * bound to the live card when its thread is here, plus requests of this
 * computer's threads Durango hasn't listed yet (signed out, or just asked).
 * Questions and approvals (kind "input") are answered in their thread.
 */
export const botNeedsYouCards = (botId: string, requests: BotThreadRequest[] | undefined, threads: Thread[]): BotNeedsYouCard[] => {
  const cards: BotNeedsYouCard[] = [];
  const seen = new Set<string>();
  for (const request of requests ?? []) {
    if (request.status === 'resolved') continue;
    const key = `${request.threadId}:${request.requestId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const root = threadHere(threads, request.threadId);
    if (request.kind === 'input') {
      cards.push({
        key,
        kind: 'input',
        action: { ...asUserAction(request), threadId: root?.id ?? request.threadId, threadTitle: request.threadTitle ?? '' },
        threadId: root?.id ?? request.threadId,
        threadTitle: request.threadTitle || root?.title || 'A thread',
        machineName: request.machineName,
        projectName: request.projectName,
        here: Boolean(root),
        request,
      });
      continue;
    }
    // The live card, when the thread here still shows it; answered here
    // already: it goes (Durango catches up on the machine's next sync).
    const live = root ? pendingUserActions(threads, root.id).find((action) => action.id === request.requestId) : undefined;
    if (root && !root.remote && !live && request.status === 'pending') continue;
    cards.push({
      key,
      kind: request.kind,
      action: live ?? { ...asUserAction(request), threadId: request.actionThreadId ?? request.threadId, threadTitle: request.subagentTitle ?? '' },
      threadId: root?.id ?? request.threadId,
      threadTitle: request.threadTitle || root?.title || 'A thread',
      machineName: request.machineName,
      projectName: request.projectName,
      here: Boolean(live),
      request,
    });
  }
  // This computer's own threads the bot started, before Durango lists them.
  for (const thread of threads) {
    const owner = botThreadOwner(thread);
    if (!owner || owner.botId !== botId) continue;
    for (const action of pendingUserActions(threads, thread.id)) {
      const key = `${thread.id}:${action.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push({
        key,
        kind: action.secret ? 'secret' : 'action',
        action,
        threadId: thread.id,
        threadTitle: thread.title || 'A thread',
        machineName: null,
        projectName: null,
        here: true,
        request: null,
      });
    }
  }
  return cards.sort((a, b) => (Date.parse(a.action.requestedAt) || 0) - (Date.parse(b.action.requestedAt) || 0));
};

// --- Answers sent from this computer's bot chats ----------------------------------

/**
 * An answer sent through Durango from a bot chat here, kept while it is on
 * its way. `at`: when Durango took it (its clock); `sawAnswering`: Durango's
 * list has shown the card as answered since.
 */
export type SentBotAnswer = { op: string; machineName: string | null; online: boolean; at?: number; sawAnswering?: boolean };

let sentAnswers: ReadonlyMap<string, SentBotAnswer> = new Map();
const sentListeners = new Set<() => void>();
const setSent = (next: ReadonlyMap<string, SentBotAnswer>) => {
  if (next === sentAnswers) return;
  sentAnswers = next;
  for (const listener of sentListeners) listener();
};

/**
 * What the Bots view answered through Durango and is waiting to see go: the
 * panel shows those cards as sent, and the sidebar stops highlighting the bot
 * at once instead of on Durango's next list (useSyncExternalStore).
 */
export const botSentAnswers = {
  get: () => sentAnswers,
  subscribe(listener: () => void) {
    sentListeners.add(listener);
    return () => {
      sentListeners.delete(listener);
    };
  },
  set(key: string, entry: SentBotAnswer | null) {
    const next = new Map(sentAnswers);
    if (entry) next.set(key, entry);
    else next.delete(key);
    setSent(next);
  },
  /**
   * Against every listed bot's cards: an answer is forgotten once its card
   * left the list (the machine took it, the row went stale, the bot or the
   * account went), once the machine reported it failed (the card has an
   * error newer than the answer), or once the card is pending again after
   * Durango showed it answered (re-opened). Otherwise it is marked seen as
   * answered when Durango shows it so.
   */
  reconcile(cards: Iterable<BotNeedsYouCard>) {
    if (sentAnswers.size === 0) return;
    const byKey = new Map<string, BotNeedsYouCard>();
    for (const card of cards) byKey.set(card.key, card);
    let changed = false;
    const next = new Map<string, SentBotAnswer>();
    for (const [key, entry] of sentAnswers) {
      const request = byKey.get(key)?.request;
      if (!request) {
        changed = true;
        continue;
      }
      if (request.error && (entry.at === undefined || (request.errorAt ?? 0) >= entry.at)) {
        changed = true;
        continue;
      }
      if (request.status === 'answering') {
        if (!entry.sawAnswering) changed = true;
        next.set(key, entry.sawAnswering ? entry : { ...entry, sawAnswering: true });
        continue;
      }
      if (entry.sawAnswering) {
        changed = true;
        continue;
      }
      next.set(key, entry);
    }
    if (changed) setSent(next);
  },
  /** Another account, or signed out: nothing sent from here applies any more. */
  clear() {
    if (sentAnswers.size) setSent(new Map());
  },
};

/** Every card of the listed bots (what botSentAnswers.reconcile checks against). */
export const allBotCards = (bots: ReadonlyArray<{ id: string; requests?: BotThreadRequest[] }> | null, threads: Thread[]) =>
  (bots ?? []).flatMap((bot) => botNeedsYouCards(bot.id, bot.requests, threads));

/**
 * Whether a bot's card still needs the person: questions do until their
 * thread has them; others until answered here or there (Durango's
 * `answering` / `resolved`, or sent from this computer and on its way).
 */
export const cardNeedsYou = (card: BotNeedsYouCard, sent: ReadonlyMap<string, SentBotAnswer>) =>
  card.kind === 'input' || (card.request?.status !== 'answering' && card.request?.status !== 'resolved' && !sent.has(card.key));

/**
 * The bot list with `needsYou` as it stands on this computer now: the bot
 * asked something, or a card of a thread it started (Durango's or this
 * computer's own) still needs the person. Answering a card here clears it at
 * once; a thread here asking sets it before Durango's next list. Older
 * Durango servers (no `asked`) keep their own `needsYou`.
 */
export const withNeedsYouNow = <T extends { id: string; needsYou: boolean; asked?: boolean; requests?: BotThreadRequest[] }>(
  bots: T[] | null,
  threads: Thread[],
  sent: ReadonlyMap<string, SentBotAnswer>
): T[] | null => {
  if (!bots) return bots;
  return bots.map((bot) => {
    const cards = botNeedsYouCards(bot.id, bot.requests, threads);
    const fromCards = cards.some((card) => cardNeedsYou(card, sent));
    const needsYou = bot.asked === undefined ? bot.needsYou || fromCards : bot.asked || fromCards;
    return needsYou === bot.needsYou ? bot : { ...bot, needsYou };
  });
};

/** What withNeedsYouNow reads from the threads, as a key: it changes only when a card or a bot's thread does. */
export const threadCardsKey = (threads: Thread[]) => {
  let key = '';
  for (const thread of threads) {
    if (!thread.userActions?.length && !thread.remote) continue;
    key += `${thread.id}:${thread.remote?.threadId ?? ''}:${(thread.userActions ?? []).map((action) => action.id).join('|')};`;
  }
  return key;
};

/**
 * The bots whose threads on this computer wait on the person right now (a
 * card on the thread or one of its subagents), joined into a stable key: the
 * Bots view highlights them before Durango's list says so (and signed out).
 */
export const localNeedsYouBotKey = (threads: Thread[]): string => {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const ids = new Set<string>();
  for (const thread of threads) {
    if (!thread.userActions?.length) continue;
    let root: Thread = thread;
    for (let depth = 0; root.parentThreadId && depth < 20; depth += 1) {
      const parent = byId.get(root.parentThreadId);
      if (!parent) break;
      root = parent;
    }
    const botId = botThreadOwner(root)?.botId;
    if (botId) ids.add(botId);
  }
  return [...ids].sort().join('\n');
};

/** The bot list with `needsYou` set for the bots in `localKey` too (localNeedsYouBotKey). */
export const withLocalNeedsYou = <T extends { id: string; needsYou: boolean }>(bots: T[] | null, localKey: string): T[] | null => {
  if (!bots || !localKey) return bots;
  const local = new Set(localKey.split('\n'));
  return bots.map((bot) => (!bot.needsYou && local.has(bot.id) ? { ...bot, needsYou: true } : bot));
};

// --- Resolutions recorded on this computer ----------------------------------------

export const BOT_RESOLVED_KEEP_MS = 10 * 60_000;

export type LocalResolvedBotRequest = {
  key: string;
  botId: string | null;
  threadId: string;
  actionThreadId?: string;
  threadTitle: string;
  requestId: string;
  kind: BotThreadRequestKind;
  text: string;
  resolved: DesktopBotRequestResolution;
};

let localResolvedMap: ReadonlyMap<string, LocalResolvedBotRequest> = new Map();
let pendingResolutionMap = new Map<string, BotThreadRequestResolution>();
const resolvedListeners = new Set<() => void>();

const emitResolved = () => {
  for (const listener of resolvedListeners) listener();
};

const pruneLocalResolved = (map: ReadonlyMap<string, LocalResolvedBotRequest>, now = Date.now()) => {
  let pruned = false;
  const next = new Map<string, LocalResolvedBotRequest>();
  for (const [key, item] of map) {
    if (now - item.resolved.at >= BOT_RESOLVED_KEEP_MS) {
      pruned = true;
      continue;
    }
    next.set(key, item);
  }
  while (next.size > 60) {
    next.delete(next.keys().next().value as string);
    pruned = true;
  }
  return pruned ? next : map;
};

/**
 * Resolutions that happened on this computer (in a thread, via a local bot chat
 * panel card, or via answer_thread_request). Holds two things:
 * - a short-lived local cache (`get`) so desktop Bots views update immediately
 *   at 0 ms (and signed-out local bots show the confirmation strip too), and
 * - a pending queue (`pending` / `acknowledge`) flushed on the next
 *   `syncBotThreadRequests` call so Durango stamps the inbox card and notifies
 *   all other devices.
 */
export const botResolvedRequests = {
  get: () => localResolvedMap,
  subscribe(listener: () => void) {
    resolvedListeners.add(listener);
    return () => {
      resolvedListeners.delete(listener);
    };
  },
  pending: (): BotThreadRequestResolution[] => [...pendingResolutionMap.values()],
  acknowledge(sent: readonly BotThreadRequestResolution[]) {
    let changed = false;
    for (const item of sent) {
      const k = `${item.threadId}\n${item.requestId}`;
      if (pendingResolutionMap.get(k) === item) {
        pendingResolutionMap.delete(k);
        changed = true;
      }
    }
    if (changed) emitResolved();
  },
  record(entry: LocalResolvedBotRequest, syncPayload?: BotThreadRequestResolution | null) {
    const base = pruneLocalResolved(localResolvedMap);
    const next = new Map(base);
    next.set(entry.key, entry);
    localResolvedMap = next;
    if (syncPayload) {
      pendingResolutionMap.set(`${syncPayload.threadId}\n${syncPayload.requestId}`, syncPayload);
      while (pendingResolutionMap.size > 50) {
        pendingResolutionMap.delete(pendingResolutionMap.keys().next().value as string);
      }
    }
    emitResolved();
  },
  clear() {
    if (localResolvedMap.size === 0 && pendingResolutionMap.size === 0) return;
    localResolvedMap = new Map();
    pendingResolutionMap = new Map();
    emitResolved();
  },
};

/** Finds the bot-started root of `threadId` (Durango or local) and records a request resolution. */
export const recordBotThreadRequestResolution = (
  threads: Thread[],
  input: {
    threadId: string;
    requestId: string;
    kind: BotThreadRequestKind;
    text?: string;
    op: DesktopBotRequestResolutionOp;
    by: DesktopBotRequestResolutionBy;
    byName?: string;
    at?: number;
  }
): { owner: BotThreadOwner; root: Thread; resolution: DesktopBotRequestResolution; requestId: string } | null => {
  const byId = threadsById(threads);
  const thread = byId.get(input.threadId);
  if (!thread) return null;
  let root = thread;
  for (let depth = 0; root.parentThreadId && depth < 20; depth += 1) {
    const parent = byId.get(root.parentThreadId);
    if (!parent) return null;
    root = parent;
  }
  const owner = botThreadOwner(root);
  if (!owner) return null;
  const own = root.id === thread.id;
  const requestId =
    input.kind === 'input' && !input.requestId.startsWith('q:')
      ? `q:${own ? '' : `${thread.id}:`}${input.requestId}`.slice(0, 128)
      : input.requestId.slice(0, 128);
  const at = input.at ?? Date.now();
  const byName = input.byName?.trim().slice(0, 80) || undefined;
  const resolution: DesktopBotRequestResolution = {
    op: input.op,
    by: input.by,
    ...(byName ? { byName } : {}),
    at,
  };
  const key = `${root.id}:${requestId}`;
  const entry: LocalResolvedBotRequest = {
    key,
    botId: owner.botId ?? null,
    threadId: root.id,
    ...(!own ? { actionThreadId: thread.id } : {}),
    threadTitle: root.title || 'A thread',
    requestId,
    kind: input.kind,
    text: clip(input.text?.trim() || 'Request', 400),
    resolved: resolution,
  };
  const syncPayload: BotThreadRequestResolution | null =
    owner.mode === 'durango'
      ? {
          threadId: root.id,
          ...(!own ? { actionThreadId: thread.id } : {}),
          owner: botOwnerRefs(owner),
          requestId,
          kind: input.kind,
          op: resolution.op,
          by: resolution.by,
          ...(byName ? { byName } : {}),
          at,
        }
      : null;
  botResolvedRequests.record(entry, syncPayload);
  return { owner, root, resolution, requestId };
};

/** Looks up a local resolution matching a `NEEDS THE PERSON` notice's request ref (for 0 ms optimistic inbox updates). */
export const localResolutionForNotice = (
  localResolved: ReadonlyMap<string, LocalResolvedBotRequest>,
  ref: { kind: 'action' | 'input'; id: string } | null
): DesktopBotRequestResolution | null => {
  if (!ref || localResolved.size === 0) return null;
  for (const item of localResolved.values()) {
    if (ref.kind === 'action' && item.kind !== 'input' && item.requestId === ref.id) return item.resolved;
    if (ref.kind === 'input' && item.kind === 'input') {
      let raw = item.requestId.startsWith('q:') ? item.requestId.slice(2) : item.requestId;
      if (item.actionThreadId && raw.startsWith(`${item.actionThreadId}:`)) raw = raw.slice(item.actionThreadId.length + 1);
      if (raw === ref.id) return item.resolved;
    }
  }
  return null;
};

export type BotResolvedCard = {
  key: string;
  dismissKey: string;
  threadId: string;
  threadTitle: string;
  machineName: string | null;
  text: string;
  resolved: DesktopBotRequestResolution;
};

/**
 * Resolved request confirmations to show briefly above the composer: merges
 * Durango's `resolvedRequests` and this machine's `localResolved`, drops any
 * that are dismissed, expired, or superseded by a newer bot assistant reply.
 */
export const visibleResolvedBotCards = ({
  botId,
  resolvedRequests,
  localResolved,
  activeKeys,
  dismissed,
  latestAssistantAt,
  now = Date.now(),
}: {
  botId: string;
  resolvedRequests?: readonly BotThreadRequest[];
  localResolved: ReadonlyMap<string, LocalResolvedBotRequest>;
  activeKeys?: ReadonlySet<string>;
  dismissed: ReadonlySet<string>;
  latestAssistantAt?: number;
  now?: number;
}): BotResolvedCard[] => {
  const byKey = new Map<string, BotResolvedCard>();
  for (const request of resolvedRequests ?? []) {
    if (request.status !== 'resolved' || !request.resolved) continue;
    const key = `${request.threadId}:${request.requestId}`;
    if (activeKeys?.has(key)) continue;
    byKey.set(key, {
      key,
      dismissKey: `${key}:${request.resolved.at}`,
      threadId: request.threadId,
      threadTitle: request.threadTitle || 'A thread',
      machineName: request.machineName,
      text: request.kind === 'secret' ? request.secretLabel || request.text : request.text,
      resolved: request.resolved,
    });
  }
  for (const item of localResolved.values()) {
    if (item.botId !== botId) continue;
    if (activeKeys?.has(item.key) || byKey.has(item.key)) continue;
    byKey.set(item.key, {
      key: item.key,
      dismissKey: `${item.key}:${item.resolved.at}`,
      threadId: item.threadId,
      threadTitle: item.threadTitle,
      machineName: null,
      text: item.text,
      resolved: item.resolved,
    });
  }
  return [...byKey.values()]
    .filter((card) => {
      if (dismissed.has(card.dismissKey)) return false;
      if (now - card.resolved.at >= BOT_RESOLVED_KEEP_MS) return false;
      if (typeof latestAssistantAt === 'number' && latestAssistantAt > card.resolved.at) return false;
      return true;
    })
    .sort((a, b) => a.resolved.at - b.resolved.at);
};
