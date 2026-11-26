// Pure ordering helpers for the Bots sidebar (project groups and bots within
// each project group). Mirrors chat/convex/botPolicy.ts so the desktop app
// stays self-contained for its public projection.

export const BOT_ORDER_LIMITS = {
  maxProjectKeys: 200,
  maxProjectKeyChars: 420,
} as const;

/** Deduplicates, trims, and bounds a manual project-group order list. Pure. */
export function normalizeProjectOrder(projectKeys: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(projectKeys)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of projectKeys) {
    if (typeof raw !== 'string') continue;
    const key = raw.trim().slice(0, BOT_ORDER_LIMITS.maxProjectKeyChars);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= BOT_ORDER_LIMITS.maxProjectKeys) break;
  }
  return out;
}

export type SortableProjectBot = {
  id: string;
  projectPrimary?: boolean;
  sortOrder?: number | null;
  lastActivityAt: number;
  createdAt?: number;
};

export const hasManualSortOrder = (bot: Pick<SortableProjectBot, 'sortOrder'>): bot is { sortOrder: number } =>
  typeof bot.sortOrder === 'number' && Number.isFinite(bot.sortOrder);

/**
 * Sorts bots within a single project group. Pure (never mutates input).
 *
 * - Before a manual order is set on the group (no bot has a finite `sortOrder`),
 *   the project's primary bot sits first, followed by most recently active.
 * - Once a manual order is set (at least one bot has a finite `sortOrder`),
 *   the person's order wins (`sortOrder` ascending); the primary keeps its
 *   badge at whatever slot the person placed it. Newly added bots (no
 *   `sortOrder`) append to the end in creation order (`createdAt` ascending).
 */
export function sortProjectBots<T extends SortableProjectBot>(bots: readonly T[]): T[] {
  const list = [...bots];
  const manual = list.some(hasManualSortOrder);
  if (!manual) {
    return list.sort(
      (a, b) =>
        Number(Boolean(b.projectPrimary)) - Number(Boolean(a.projectPrimary)) ||
        b.lastActivityAt - a.lastActivityAt ||
        (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER) ||
        a.id.localeCompare(b.id)
    );
  }
  return list.sort((a, b) => {
    const aHas = hasManualSortOrder(a);
    const bHas = hasManualSortOrder(b);
    if (aHas && bHas) {
      return (
        a.sortOrder! - b.sortOrder! ||
        (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER) ||
        a.id.localeCompare(b.id)
      );
    }
    if (aHas) return -1;
    if (bHas) return 1;
    return (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id);
  });
}

export type SortableProjectGroup = {
  groupKey: string;
  name: string;
  latestActivityAt: number;
  earliestCreatedAt?: number;
};

/**
 * Sorts project groups in the Bots sidebar. Pure (never mutates input).
 *
 * - Before a manual project order is set (`projectOrder` empty/absent), groups
 *   sort by latest activity descending, then name ascending.
 * - Once a manual order is set, ordered groups appear in that exact sequence;
 *   any newly created project not yet in `projectOrder` appends to the end
 *   (oldest first, so newer projects land at the very bottom).
 */
export function sortProjectGroups<T extends SortableProjectGroup>(
  groups: readonly T[],
  projectOrder?: readonly string[] | null
): T[] {
  const list = [...groups];
  const normalized = normalizeProjectOrder(projectOrder);
  if (normalized.length === 0) {
    return list.sort(
      (a, b) =>
        b.latestActivityAt - a.latestActivityAt ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
        a.groupKey.localeCompare(b.groupKey)
    );
  }
  const rank = new Map<string, number>();
  normalized.forEach((key, index) => rank.set(key, index));
  return list.sort((a, b) => {
    const aRank = rank.get(a.groupKey);
    const bRank = rank.get(b.groupKey);
    if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
    if (aRank !== undefined) return -1;
    if (bRank !== undefined) return 1;
    return (
      (a.earliestCreatedAt ?? Number.MAX_SAFE_INTEGER) - (b.earliestCreatedAt ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
      a.groupKey.localeCompare(b.groupKey)
    );
  });
}

/** Moves an item from `fromIndex` to `toIndex`, returning a new array (or `items` unchanged when no-op). Pure. */
export function reorderList<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
    return [...items];
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * Optimistically assigns sequential `sortOrder` (0, 1, 2…) to every bot in
 * `projectKey` matching `orderedBotIds`, keeping any sibling not listed at the
 * end so concurrent additions are never dropped. Pure.
 */
export function applyOptimisticBotOrder<
  T extends { id: string; project?: { key: string } | null; sortOrder?: number | null; projectPrimary?: boolean; lastActivityAt: number; createdAt?: number },
>(bots: readonly T[], projectKey: string, orderedBotIds: readonly string[]): T[] {
  const rank = new Map<string, number>();
  for (const id of orderedBotIds) {
    if (!rank.has(id)) rank.set(id, rank.size);
  }
  const extras = sortProjectBots(
    bots.filter((bot) => bot.project?.key === projectKey && !rank.has(bot.id))
  );
  extras.forEach((bot) => rank.set(bot.id, rank.size));
  return bots.map((bot) => {
    if (bot.project?.key !== projectKey) return bot;
    const nextOrder = rank.get(bot.id);
    if (nextOrder === undefined || bot.sortOrder === nextOrder) return bot;
    return { ...bot, sortOrder: nextOrder };
  });
}
