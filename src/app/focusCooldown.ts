// Shared focus/visibility cooldown helper and shallow-value comparators used to
// keep window.focus storms from re-running git, cloud, MCP, bot, and workspace
// refreshes back-to-back without leaving state stale after quick round-trips.

export const DEFAULT_FOCUS_COOLDOWN_MS = 5_000;
export const DEFAULT_EVENT_DEDUPE_MS = 250;

export type FocusCooldown = {
  /** Record that a refresh ran at `at` (defaults to `now()`), cancelling any queued trailing retry. */
  mark: (at?: number) => void;
  /** Clear the recorded timestamp and cancel any queued trailing retry. */
  reset: () => void;
  /** Cancel any queued trailing retry timer (call on effect cleanup). */
  cancel: () => void;
  /** True when at least `cooldownMs` has passed since the last run; marks now on true. */
  tryRun: (at?: number) => boolean;
  /**
   * Leading + trailing throttle: runs `fn` immediately when cooldown has
   * elapsed and `isBusy?.()` is false; ignores paired burst events within
   * `dedupeMs` of the last run (e.g. visibilitychange + focus firing together)
   * when not busy; otherwise coalesces into one trailing call once the
   * cooldown finishes (re-checking `isBusy?.()`).
   */
  trigger: (fn: () => void, options?: { isBusy?: () => boolean }) => boolean;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export function createFocusCooldown(
  cooldownMs = DEFAULT_FOCUS_COOLDOWN_MS,
  now: () => number = Date.now,
  timers: {
    setTimer?: (fn: () => void, ms: number) => TimerHandle;
    clearTimer?: (handle: TimerHandle) => void;
    dedupeMs?: number;
  } = {}
): FocusCooldown {
  const setTimer = timers.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = timers.clearTimer ?? ((handle) => globalThis.clearTimeout(handle));
  const dedupeMs = Math.min(timers.dedupeMs ?? DEFAULT_EVENT_DEDUPE_MS, cooldownMs);
  let lastRunAt = -Infinity;
  let timer: TimerHandle | null = null;
  let pendingFn: (() => void) | null = null;
  let pendingIsBusy: (() => boolean) | undefined;

  const cancel = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    pendingFn = null;
    pendingIsBusy = undefined;
  };

  const trigger = (fn: () => void, options?: { isBusy?: () => boolean }): boolean => {
    const current = now();
    const elapsed = current - lastRunAt;
    if (elapsed >= cooldownMs && !options?.isBusy?.()) {
      cancel();
      lastRunAt = current;
      fn();
      return true;
    }
    // Paired OS events (visibilitychange + focus, or initial mount + focus)
    // arrive milliseconds apart; ignore the immediate echo so it does not
    // schedule a redundant trailing refresh.
    if (elapsed >= 0 && elapsed < dedupeMs && timer === null && !options?.isBusy?.()) {
      return false;
    }
    pendingFn = fn;
    pendingIsBusy = options?.isBusy;
    if (timer === null) {
      const remaining =
        elapsed >= cooldownMs ? Math.min(250, Math.max(1, cooldownMs)) : Math.max(1, cooldownMs - elapsed);
      timer = setTimer(() => {
        timer = null;
        const nextFn = pendingFn;
        const nextIsBusy = pendingIsBusy;
        pendingFn = null;
        pendingIsBusy = undefined;
        if (!nextFn) return;
        if (nextIsBusy?.()) {
          trigger(nextFn, { isBusy: nextIsBusy });
          return;
        }
        lastRunAt = now();
        nextFn();
      }, remaining);
    }
    return false;
  };

  return {
    mark(at = now()) {
      cancel();
      lastRunAt = at;
    },
    reset() {
      cancel();
      lastRunAt = -Infinity;
    },
    cancel,
    tryRun(at = now()): boolean {
      if (at - lastRunAt < cooldownMs) return false;
      cancel();
      lastRunAt = at;
      return true;
    },
    trigger,
  };
}

export type ComparableGitState = {
  ok: boolean;
  isGitRepository?: boolean;
  root?: string;
  originUrl?: string | null;
  sourceProvider?: string;
  githubMirrorUrl?: string | null;
  currentBranch?: string | null;
  detachedHead?: string | null;
  branches: Array<{
    name: string;
    current: boolean;
    hasUpstream: boolean;
  }>;
  hasUncommittedChanges: boolean;
  ahead?: number;
  behind?: number;
  error?: string;
};

/**
 * Value equality for `git:getState` responses. Keeps the previous object
 * reference when nothing changed on focus so effects keyed on `gitState`
 * (such as `refreshCloudState`) do not cascade needlessly.
 */
export function isSameGitState(
  left: ComparableGitState | null | undefined,
  right: ComparableGitState | null | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (
    left.ok !== right.ok ||
    left.isGitRepository !== right.isGitRepository ||
    left.root !== right.root ||
    left.originUrl !== right.originUrl ||
    left.sourceProvider !== right.sourceProvider ||
    left.githubMirrorUrl !== right.githubMirrorUrl ||
    left.currentBranch !== right.currentBranch ||
    left.detachedHead !== right.detachedHead ||
    left.hasUncommittedChanges !== right.hasUncommittedChanges ||
    left.ahead !== right.ahead ||
    left.behind !== right.behind ||
    left.error !== right.error ||
    left.branches.length !== right.branches.length
  ) {
    return false;
  }
  for (let index = 0; index < left.branches.length; index += 1) {
    const a = left.branches[index];
    const b = right.branches[index];
    if (a.name !== b.name || a.current !== b.current || a.hasUpstream !== b.hasUpstream) {
      return false;
    }
  }
  return true;
}
