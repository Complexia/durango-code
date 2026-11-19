import { useSyncExternalStore } from 'react';

/**
 * The shell bar's title spot while Sidebar v3 shows a bot: App renders an
 * empty element there and the open bot's pane portals its header (avatar,
 * name, status) into it, so the bot is the first thing at the top instead of
 * a "Bots" title over a second header row.
 */
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** Ref callback for the element in the shell bar. */
export const setBotsShellSlot = (element: HTMLElement | null) => {
  if (slot === element) return;
  slot = element;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The shell bar's bot title element, or null when it isn't on screen. */
export const useBotsShellSlot = () => useSyncExternalStore(subscribe, () => slot, () => null);
