import { useEffect, useMemo, useRef, useState } from 'react';
import type { Thread } from '../store';

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
 * Threads with a question or approval waiting on the user. Agents announce a
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
): ReadonlySet<string> => {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const onAttentionRef = useRef(onAttention);
  onAttentionRef.current = onAttention;
  const generationRef = useRef(new Map<string, number>());
  const initialRunningRef = useRef(runningThreadIds);

  useEffect(() => {
    if (!enabled) {
      setPending((current) => (current.size ? new Set() : current));
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
        const next = new Set(current);
        if (waiting) next.add(threadId);
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
