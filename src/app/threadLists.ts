import { useEffect, useMemo, useRef, useState } from 'react';
import { WAITING_ON_BACKGROUND_CAPTION, type Message, type Thread } from '../store';
import { getThreadActivityTime } from './time';

export type SidebarV2View = 'pinned' | 'recent' | 'snoozed' | 'settled';
export type SidebarV2ViewsSettings = Record<SidebarV2View, boolean>;

/**
 * How a sidebar v2 row is tinted: yellow while the thread needs the user (a
 * question or approval is waiting, or its run failed), green when its run
 * finished and it hasn't been opened since. Snoozed threads that wake up keep
 * the tone they woke with until they are opened.
 */
export type ThreadSidebarTone = 'attention' | 'finished' | null;

export const threadSidebarTone = (thread: Thread, hasPendingInput: boolean): ThreadSidebarTone => {
  if (thread.status === 'running') return hasPendingInput ? 'attention' : null;
  if (hasPendingInput || thread.wokeReason === 'attention') return 'attention';
  if (thread.finishedUnseenAt) return thread.status === 'error' ? 'attention' : 'finished';
  if (thread.wokeReason === 'finished') return 'finished';
  return null;
};

/**
 * The sidebar v2 lists. Recent has every thread you haven't snoozed or
 * settled, pinned or not; pinned ones are also in Pinned. Settling a pinned
 * thread keeps it in Pinned (and adds it to Settled); snoozing one moves it to
 * Snoozed but keeps its pin, so it comes back pinned.
 */
export type SidebarV2Lists = Record<SidebarV2View, Thread[]>;

export const sidebarV2ThreadLists = (
  threads: Thread[],
  isChild: (thread: Thread) => boolean,
  compareRecent: (a: Thread, b: Thread) => number
): SidebarV2Lists => {
  const lists: SidebarV2Lists = { pinned: [], recent: [], snoozed: [], settled: [] };
  for (const thread of threads) {
    if (isChild(thread)) continue;
    if (thread.settledAt) lists.settled.push(thread);
    else if (thread.snoozedAt) lists.snoozed.push(thread);
    else lists.recent.push(thread);
    if (thread.pinnedAt && (thread.settledAt || !thread.snoozedAt)) lists.pinned.push(thread);
  }
  const newest = (key: 'pinnedAt' | 'snoozedAt' | 'settledAt') => (a: Thread, b: Thread) =>
    new Date(b[key] ?? 0).getTime() - new Date(a[key] ?? 0).getTime();
  lists.pinned.sort(newest('pinnedAt'));
  lists.recent.sort(compareRecent);
  lists.snoozed.sort(newest('snoozedAt'));
  lists.settled.sort(newest('settledAt'));
  return lists;
};

/**
 * Where a thread sits in sidebar v2's Recent list: newest event first. A
 * thread moves up when it is created or sent a message, when its run ends,
 * and when it starts needing the user (`attentionSince`); streaming output
 * doesn't move it. So the thread you just started stays on top, and another
 * one only passes it by finishing or asking for you.
 */
export const sidebarV2RecentRank = (thread: Thread, attentionSince?: number) => {
  const time = (value?: string) => {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  const last = thread.messages.at(-1);
  return Math.max(
    getThreadActivityTime(thread).getTime(),
    thread.status === 'running' ? Number.NEGATIVE_INFINITY : time(last?.completedAt),
    time(thread.wokeAt),
    time(thread.unpinnedAt),
    attentionSince ?? Number.NEGATIVE_INFINITY
  );
};

export const compareSidebarV2Recent =
  (attentionSince: ReadonlyMap<string, number>) => (a: Thread, b: Thread) =>
    sidebarV2RecentRank(b, attentionSince.get(b.id)) - sidebarV2RecentRank(a, attentionSince.get(a.id));

/**
 * When the work leading up to `message` (an agent run) began: the user's
 * message before it. Turns the agent was re-invoked for while it waited on
 * background tasks (the thread stayed Working) count as the same stretch, so
 * a release that finishes in a follow-up turn still counts from the request.
 * A run that follows one that finished outright (a scheduled wake-up) starts
 * its own stretch.
 */
export const workStartedAt = (messages: Message[], message: Message) => {
  const index = messages.indexOf(message);
  let since = Date.parse(message.startedAt ?? message.ts);
  for (let i = index - 1; i >= 0; i -= 1) {
    const earlier = messages[i];
    if (earlier.role === 'user') return Math.min(since, Date.parse(earlier.ts));
    if (earlier.kind !== 'agent-run') continue;
    if (!WAITING_ON_BACKGROUND_CAPTION.test(earlier.statusText ?? '')) break;
    since = Date.parse(earlier.startedAt ?? earlier.ts);
  }
  return since;
};

/**
 * How long a thread's agents have worked: the sum of its runs, from start to
 * completion (a run still going counts up to `now`).
 */
export const threadWorkedMs = (thread: Thread, now = Date.now()) => {
  let total = 0;
  for (const message of thread.messages) {
    if (message.kind !== 'agent-run' || !message.startedAt) continue;
    const started = Date.parse(message.startedAt);
    const ended = message.completedAt ? Date.parse(message.completedAt) : message.status === 'running' ? now : NaN;
    if (Number.isFinite(started) && Number.isFinite(ended) && ended > started) total += ended - started;
  }
  return total;
};

/** "7s", "38m", "2h 5m". */
export const formatWorkedDuration = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
};

const fetchPendingInput = async (threadId: string) => {
  const [codex, claude] = await Promise.all([
    window.orion?.getCodexQuestions?.(threadId),
    window.orion?.getClaudeQuestions?.(threadId),
  ]);
  return [...(codex ?? []), ...(claude ?? [])].some((request) => request.threadId === threadId);
};

/**
 * Threads with a question or approval waiting on the user, each with when it
 * started waiting (for the Recent order). Agents announce a
 * new (or answered) request with a `user-input` turn event; the pending list
 * itself lives in the main process, so it is re-read for that thread. Running
 * threads are checked once on mount to pick up requests from before a reload.
 *
 * `onAttention` fires when a thread starts needing the user, so a snoozed
 * thread can wake up.
 */
export const useThreadsNeedingInput = (
  enabled: boolean,
  runningThreadIds: string[],
  onAttention: (threadId: string) => void
): ReadonlyMap<string, number> => {
  const [pending, setPending] = useState<ReadonlyMap<string, number>>(() => new Map());
  const onAttentionRef = useRef(onAttention);
  onAttentionRef.current = onAttention;
  const generationRef = useRef(new Map<string, number>());
  const initialRunningRef = useRef(runningThreadIds);

  useEffect(() => {
    if (!enabled) {
      setPending((current) => (current.size ? new Map() : current));
      return undefined;
    }
    let disposed = false;
    const refresh = async (threadId: string) => {
      const generation = (generationRef.current.get(threadId) ?? 0) + 1;
      generationRef.current.set(threadId, generation);
      let waiting: boolean;
      try {
        waiting = await fetchPendingInput(threadId);
      } catch {
        return;
      }
      if (disposed || generationRef.current.get(threadId) !== generation) return;
      setPending((current) => {
        if (current.has(threadId) === waiting) return current;
        const next = new Map(current);
        if (waiting) next.set(threadId, Date.now());
        else next.delete(threadId);
        return next;
      });
      if (waiting) onAttentionRef.current(threadId);
    };
    const unsubscribe = window.orion?.onAgentTurnEvent?.((event) => {
      if (!event.threadId) return;
      if (event.type === 'user-input' || event.type === 'done' || event.type === 'error') {
        void refresh(event.threadId);
      }
    });
    for (const threadId of initialRunningRef.current) void refresh(threadId);
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [enabled]);

  return pending;
};

/** Stable Set identity for an id list, so memoized consumers don't churn. */
export const useStableIdList = (ids: string[]) => {
  const key = ids.join('\u0000');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ids, [key]);
};
