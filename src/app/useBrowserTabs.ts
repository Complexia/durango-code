import { useEffect, useMemo, useRef, useState } from 'react';
import type { Thread } from '../store';

export type BrowserTab = OrionBrowserTab;

const EMPTY: OrionBrowserState = { tabs: [], visibleTabId: null };

/**
 * Live tab list of the built-in browser (tabs live in the main process).
 * `onEvent` hears agent-opened / popup / dialog events as they happen.
 */
export const useBrowserTabs = (onEvent?: (event: NonNullable<OrionBrowserState['event']>) => void) => {
  const [state, setState] = useState<OrionBrowserState>(EMPTY);
  useEffect(() => {
    const api = window.orion?.browser;
    if (!api) return undefined;
    let cancelled = false;
    void api.list().then((initial) => {
      if (!cancelled && initial?.tabs) setState(initial);
    });
    const unsubscribe = window.orion.onBrowserState?.((next) => {
      setState({ tabs: next.tabs, visibleTabId: next.visibleTabId });
      if (next.event) onEvent?.(next.event);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
    // onEvent is read through a ref by callers that need it to change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
};

/** Root of a thread's spawn_subagent chain. */
export const threadFamilyRoot = (threadId: string, parentOf: Map<string, string>) => {
  let current = threadId;
  const seen = new Set<string>();
  while (parentOf.has(current) && !seen.has(current)) {
    seen.add(current);
    current = parentOf.get(current)!;
  }
  return current;
};

/** child -> parent for every subagent thread, kept in step with main for its access checks. */
export const useThreadParents = (threads: Thread[]) => {
  const parents = useMemo(() => {
    const map: Record<string, string> = {};
    for (const thread of threads) if (thread.parentThreadId) map[thread.id] = thread.parentThreadId;
    return map;
  }, [threads]);
  const key = useMemo(() => JSON.stringify(parents), [parents]);
  useEffect(() => {
    void window.orion?.browser?.setThreadParents(JSON.parse(key) as Record<string, string>);
  }, [key]);
  return parents;
};

// How long a thread must stay finished before its tabs close, so a queued
// follow-up or a steer (stop, then run again) keeps the pages it is using.
export const FINISHED_THREAD_TAB_GRACE_MS = 15_000;

/**
 * Closes a thread's built-in browser tabs once it stops working. Agents rarely
 * call browser_close, and a page left open (a dev server, a WebGL game) keeps
 * rendering in the background for as long as the app runs. Tabs the person
 * opened or is driving stay (see closeThreadTabs in main).
 */
export const useCloseTabsOfFinishedThreads = (threads: Thread[]) => {
  const statusRef = useRef(new Map<string, Thread['status']>());
  const runningRef = useRef(new Set<string>());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const previous = statusRef.current;
    const next = new Map<string, Thread['status']>();
    const running = new Set<string>();
    for (const thread of threads) {
      next.set(thread.id, thread.status);
      if (thread.status === 'running') running.add(thread.id);
    }
    runningRef.current = running;
    const timers = timersRef.current;
    for (const [threadId, status] of next) {
      if (status === 'running') {
        const timer = timers.get(threadId);
        if (timer) clearTimeout(timer);
        timers.delete(threadId);
        continue;
      }
      if (previous.get(threadId) !== 'running' || timers.has(threadId)) continue;
      timers.set(
        threadId,
        setTimeout(() => {
          timers.delete(threadId);
          if (runningRef.current.has(threadId)) return;
          void window.orion?.browser?.closeThreadTabs(threadId, { finished: true });
        }, FINISHED_THREAD_TAB_GRACE_MS)
      );
    }
    statusRef.current = next;
  }, [threads]);
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
};

/** Tabs the panel shows for a focused thread: its family's tabs and the person's own. */
export const tabsForThread = (tabs: BrowserTab[], focusedThreadId: string | null, parents: Record<string, string>) => {
  const parentOf = new Map(Object.entries(parents));
  const root = focusedThreadId ? threadFamilyRoot(focusedThreadId, parentOf) : null;
  return tabs.filter(
    (tab) =>
      tab.ownerKey === 'user' ||
      (root !== null && tab.threadId !== null && threadFamilyRoot(tab.threadId, parentOf) === root)
  );
};
