import assert from 'node:assert/strict';
import {
  applyOptimisticBotOrder,
  normalizeProjectOrder,
  reorderList,
  sortProjectBots,
  sortProjectGroups,
  type SortableProjectBot,
  type SortableProjectGroup,
} from '../src/app/botOrder';
import {
  computeDropIndicatorOffset,
  computeItemDisplacement,
  computeTargetIndex,
  handleReorderKeyDown,
  type DragItemGeometry,
} from '../src/app/useSidebarDragReorder';

const bot = (
  id: string,
  opts: Partial<SortableProjectBot & { project?: { key: string; name: string; repoId: string | null } | null }> = {}
) => ({
  id,
  projectPrimary: opts.projectPrimary ?? false,
  sortOrder: opts.sortOrder ?? null,
  lastActivityAt: opts.lastActivityAt ?? 100,
  createdAt: opts.createdAt ?? 100,
  project: opts.project ?? { key: 'repo:durango', name: 'durango', repoId: 'durango' },
});

const group = (groupKey: string, name: string, latestActivityAt: number, earliestCreatedAt = 100): SortableProjectGroup => ({
  groupKey,
  name,
  latestActivityAt,
  earliestCreatedAt,
});

// --- 1. Bot ordering within a project group ---
{
  // Default order (no manual sortOrder): primary first, then most recently active.
  const b1 = bot('b1', { projectPrimary: true, lastActivityAt: 10, createdAt: 1 });
  const b2 = bot('b2', { lastActivityAt: 500, createdAt: 2 });
  const b3 = bot('b3', { lastActivityAt: 200, createdAt: 3 });
  const input = [b3, b2, b1];
  const sorted = sortProjectBots(input);
  assert.deepEqual(
    sorted.map((b) => b.id),
    ['b1', 'b2', 'b3']
  );
  // Never mutates input.
  assert.deepEqual(
    input.map((b) => b.id),
    ['b3', 'b2', 'b1']
  );

  // Manual order wins over projectPrimary; primary keeps its badge where placed.
  const manual = [
    bot('b1', { projectPrimary: true, sortOrder: 2, lastActivityAt: 999, createdAt: 1 }),
    bot('b2', { sortOrder: 0, lastActivityAt: 10, createdAt: 2 }),
    bot('b3', { sortOrder: 1, lastActivityAt: 20, createdAt: 3 }),
  ];
  assert.deepEqual(
    sortProjectBots(manual).map((b) => b.id),
    ['b2', 'b3', 'b1']
  );

  // New bots (no sortOrder) go to the end of a manually ordered group, in creation order (newest last),
  // even when they have a newer lastActivityAt.
  const withNew = [
    ...manual,
    bot('b5', { sortOrder: null, lastActivityAt: 10_000, createdAt: 500 }),
    bot('b4', { sortOrder: undefined, lastActivityAt: 5_000, createdAt: 400 }),
  ];
  assert.deepEqual(
    sortProjectBots(withNew).map((b) => b.id),
    ['b2', 'b3', 'b1', 'b4', 'b5']
  );
}

// --- 2. Project group ordering ---
{
  const gA = group('repo:ossmeta', 'ossmeta-build', 300, 10);
  const gB = group('repo:durango', 'durango', 500, 20);
  const gC = group('repo:newwave', 'newwavehealthcare-operational-suite', 100, 30);

  // Default order: latestActivityAt desc, then name asc.
  assert.deepEqual(
    sortProjectGroups([gC, gA, gB], []).map((g) => g.groupKey),
    ['repo:durango', 'repo:ossmeta', 'repo:newwave']
  );

  // Manual order wins; new projects append to the end (oldest first -> newest last).
  const gD = group('repo:new1', 'alpha-new', 9_999, 40);
  const gE = group('repo:new2', 'beta-new', 99_999, 50);
  assert.deepEqual(
    sortProjectGroups([gE, gA, gC, gD, gB], ['repo:newwave', 'repo:ossmeta', 'repo:durango']).map((g) => g.groupKey),
    ['repo:newwave', 'repo:ossmeta', 'repo:durango', 'repo:new1', 'repo:new2']
  );

  // normalizeProjectOrder trims, deduplicates, drops blanks.
  assert.deepEqual(normalizeProjectOrder(['  a ', '', 'b', 'a', '  ', 'c']), ['a', 'b', 'c']);
}

// --- 3. Optimistic reorder helpers ---
{
  assert.deepEqual(reorderList(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(reorderList(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c']);
  assert.deepEqual(reorderList(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c']);

  const all = [
    bot('p1-a', { project: { key: 'p1', name: 'P1', repoId: null }, projectPrimary: true, createdAt: 1 }),
    bot('p1-b', { project: { key: 'p1', name: 'P1', repoId: null }, createdAt: 2 }),
    bot('p1-c', { project: { key: 'p1', name: 'P1', repoId: null }, createdAt: 3 }),
    bot('p2-x', { project: { key: 'p2', name: 'P2', repoId: null }, projectPrimary: true, createdAt: 4 }),
  ];
  const updated = applyOptimisticBotOrder(all, 'p1', ['p1-c', 'p1-a']);
  const p1Sorted = sortProjectBots(updated.filter((b) => b.project?.key === 'p1'));
  // Unlisted concurrent sibling p1-b stays appended at the end.
  assert.deepEqual(
    p1Sorted.map((b) => [b.id, b.sortOrder]),
    [
      ['p1-c', 0],
      ['p1-a', 1],
      ['p1-b', 2],
    ]
  );
  // Other projects stay untouched (no sortOrder forced).
  assert.equal(updated.find((b) => b.id === 'p2-x')?.sortOrder, null);
}

// --- 4. Drag geometry, variable-height displacement & drop indicator ---
{
  // Uniform bot rows: 36px height + 1px gap = 37px outerHeight.
  const rows: DragItemGeometry[] = [
    { id: 'b0', top: 100, height: 36, bottom: 136, outerHeight: 37 },
    { id: 'b1', top: 137, height: 36, bottom: 173, outerHeight: 37 },
    { id: 'b2', top: 174, height: 36, bottom: 210, outerHeight: 37 },
  ];
  assert.equal(computeTargetIndex(rows, 0, 120), 0);
  assert.equal(computeTargetIndex(rows, 0, 156), 1);
  assert.equal(computeTargetIndex(rows, 0, 200), 2);
  assert.equal(computeTargetIndex(rows, 2, 110), 0);
  assert.equal(computeDropIndicatorOffset(rows, 0, 0), null);
  assert.equal(computeDropIndicatorOffset(rows, 0, 2), 73.5);
  assert.equal(computeDropIndicatorOffset(rows, 2, 0), 0);

  // Variable-height project groups: expanded 200px, collapsed 28px, expanded 100px (10px gap).
  const groups: DragItemGeometry[] = [
    { id: 'g0', top: 0, height: 200, bottom: 200, outerHeight: 210 },
    { id: 'g1', top: 210, height: 28, bottom: 238, outerHeight: 38 },
    { id: 'g2', top: 248, height: 100, bottom: 348, outerHeight: 110 },
  ];

  // Verify every (fromIndex, toIndex) pair produces contiguous, non-overlapping slots!
  for (let from = 0; from < groups.length; from += 1) {
    for (let to = 0; to < groups.length; to += 1) {
      const placed = groups
        .map((item, idx) => {
          const dy = computeItemDisplacement(groups, from, to, idx);
          return { id: item.id, top: item.top + dy, bottom: item.bottom + dy };
        })
        .sort((a, b) => a.top - b.top);
      const expectedOrder = reorderList(
        groups.map((g) => g.id),
        from,
        to
      );
      assert.deepEqual(
        placed.map((p) => p.id),
        expectedOrder,
        `order mismatch for ${from} -> ${to}`
      );
      assert.equal(placed[0].top, 0, `first slot starts at 0 for ${from} -> ${to}`);
      for (let i = 1; i < placed.length; i += 1) {
        assert.equal(placed[i].top - placed[i - 1].bottom, 10, `exact 10px gap for ${from} -> ${to}`);
      }
      const indicator = computeDropIndicatorOffset(groups, from, to);
      if (from === to) {
        assert.equal(indicator, null);
      } else {
        assert.ok(indicator !== null && indicator >= 0 && indicator <= 348);
      }
    }
  }
}

// --- 5. Keyboard reordering helper ---
{
  const moves: [number, number][] = [];
  const makeEvent = (key: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) => {
    let prevented = false;
    let stopped = false;
    return {
      key,
      altKey: mods.altKey ?? false,
      ctrlKey: mods.ctrlKey ?? false,
      metaKey: mods.metaKey ?? false,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
      get prevented() {
        return prevented;
      },
      get stopped() {
        return stopped;
      },
    };
  };

  const e1 = makeEvent('ArrowUp', { altKey: true });
  assert.equal(
    handleReorderKeyDown(e1 as unknown as React.KeyboardEvent, 1, 3, (from, to) => moves.push([from, to])),
    true
  );
  assert.deepEqual(moves, [[1, 0]]);
  assert.equal(e1.prevented, true);
  assert.equal(e1.stopped, true);

  // At boundary (top): handled & prevented, no out-of-bounds move.
  const e2 = makeEvent('ArrowUp', { altKey: true });
  assert.equal(
    handleReorderKeyDown(e2 as unknown as React.KeyboardEvent, 0, 3, (from, to) => moves.push([from, to])),
    true
  );
  assert.deepEqual(moves, [[1, 0]]);

  // Plain ArrowDown without Alt/Option is ignored.
  const e3 = makeEvent('ArrowDown', { altKey: false });
  assert.equal(
    handleReorderKeyDown(e3 as unknown as React.KeyboardEvent, 0, 3, (from, to) => moves.push([from, to])),
    false
  );
}

console.log('bot order & drag geometry: ok');
