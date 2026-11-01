import { useEffect, useMemo, useState } from 'react';
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
