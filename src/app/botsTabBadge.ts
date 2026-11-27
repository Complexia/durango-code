import { useEffect, useSyncExternalStore } from 'react';
import { botIsWorking, type DesktopBot } from './bots';
import { createFocusCooldown } from './focusCooldown';

// The Bots tab's badge in the sidebar header (SidebarModeHeader.tsx): while
// the Threads tab is open, the Bots tab shows when a bot has a new reply, is
// working, or needs you. The Bots view (BotsWorkspace.tsx) reports every list
// it loads here; on Threads a slow poll keeps it fresh, and only for a profile
// that has opened Bots before, so people who don't use bots make no calls.

export type BotsTabBadge = { unread: number; working: boolean; needsYou: boolean };

const EMPTY: BotsTabBadge = { unread: 0, working: false, needsYou: false };
const POLL_MS = 30_000;

let badge: BotsTabBadge = EMPTY;
const listeners = new Set<() => void>();

export const botsTabBadgeOf = (bots: readonly DesktopBot[] | null): BotsTabBadge => {
  if (!bots?.length) return EMPTY;
  return {
    unread: bots.reduce((sum, bot) => sum + Math.max(0, bot.unread || 0), 0),
    working: bots.some((bot) => botIsWorking(bot)),
    needsYou: bots.some((bot) => bot.needsYou),
  };
};

/** The latest bot list (null: signed out or none to show). */
export const noteBotList = (bots: readonly DesktopBot[] | null) => {
  const next = botsTabBadgeOf(bots);
  if (next.unread === badge.unread && next.working === badge.working && next.needsYou === badge.needsYou) return;
  badge = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/**
 * The Bots tab's badge. `poll`: keep it fresh from here (the Threads tab is
 * open and this profile has used Bots); the Bots view reports its own loads.
 */
export const useBotsTabBadge = (poll: boolean): BotsTabBadge => {
  const current = useSyncExternalStore(subscribe, () => badge, () => EMPTY);
  useEffect(() => {
    if (!poll) return undefined;
    let stopped = false;
    const focusCooldown = createFocusCooldown();
    const load = async () => {
      if (!visible()) return;
      focusCooldown.mark();
      const result = await window.orion?.listBots?.().catch(() => null);
      if (stopped || !result) return;
      // Any failure (signed out, another account, no Claude Code here, offline)
      // clears it: a badge must never show another account's bots.
      noteBotList(result.ok && result.allowed !== false ? (result.bots ?? []) : null);
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    const onFocus = () => {
      if (focusCooldown.tryRun()) void load();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [poll]);
  return current;
};
