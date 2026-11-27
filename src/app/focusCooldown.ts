// Shared focus/visibility cooldown helper and shallow-value comparators used to
// keep window.focus storms from re-running git, cloud, MCP, bot, and workspace
// refreshes back-to-back.

export const DEFAULT_FOCUS_COOLDOWN_MS = 5_000;

export type FocusCooldown = {
  /** Record that a refresh ran at `at` (defaults to `now()`). */
  mark: (at?: number) => void;
  /** Clear the recorded timestamp (e.g. when the target project changes). */
  reset: () => void;
  /** True when at least `cooldownMs` has passed since the last run; marks now on true. */
  tryRun: (at?: number) => boolean;
};

export function createFocusCooldown(
  cooldownMs = DEFAULT_FOCUS_COOLDOWN_MS,
  now: () => number = Date.now
): FocusCooldown {
  let lastRunAt = -Infinity;
  return {
    mark(at = now()) {
      lastRunAt = at;
    },
    reset() {
      lastRunAt = -Infinity;
    },
    tryRun(at = now()): boolean {
      if (at - lastRunAt < cooldownMs) return false;
      lastRunAt = at;
      return true;
    },
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
