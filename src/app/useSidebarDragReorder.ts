import { useCallback, useEffect, useRef, useState } from 'react';

export type DragItemGeometry = {
  id: string;
  /** Top edge relative to scroll container content top (px). */
  top: number;
  /** Element height (px). */
  height: number;
  /** Bottom edge relative to scroll container content top (px). */
  bottom: number;
  /** Outer height including gap to the next sibling (px). */
  outerHeight: number;
};

export type ActiveDrag<Meta = unknown> = {
  /** Scope key separating independent lists (e.g. `"projects"` or `"bots:<projectKey>"`). */
  scope: string;
  id: string;
  fromIndex: number;
  toIndex: number;
  /** Original measured geometries of all items in this list (in content coordinates). */
  items: DragItemGeometry[];
  /** Visual bounding rect of the dragged element at drag start (viewport px). */
  initialRect: { left: number; top: number; width: number; height: number };
  /** Pointer offset from dragged element's top-left at grab time. */
  grabOffset: { x: number; y: number };
  /** Current viewport coordinates of the floating overlay's top-left corner. */
  overlayPos: { x: number; y: number };
  meta: Meta;
};

const DRAG_THRESHOLD_PX = 5;
const AUTOSCROLL_EDGE_PX = 44;
const AUTOSCROLL_MAX_PX_PER_FRAME = 14;
const MAX_HORIZONTAL_SWAY_PX = 4;

/**
 * Given original (untransformed) item geometries in scroll-content coordinates,
 * computes the target index for `pointerContentY`. Pure and oscillation-free
 * for both uniform and variable-height items.
 */
export function computeTargetIndex(
  items: readonly DragItemGeometry[],
  fromIndex: number,
  pointerContentY: number
): number {
  const n = items.length;
  if (n <= 1 || fromIndex < 0 || fromIndex >= n) return fromIndex;
  const fromMid = items[fromIndex].top + items[fromIndex].height * 0.5;
  if (pointerContentY < fromMid) {
    for (let index = 0; index < fromIndex; index += 1) {
      const mid = items[index].top + items[index].height * 0.5;
      if (pointerContentY < mid) return index;
    }
    return fromIndex;
  }
  if (pointerContentY > fromMid) {
    for (let index = n - 1; index > fromIndex; index -= 1) {
      const mid = items[index].top + items[index].height * 0.5;
      if (pointerContentY > mid) return index;
    }
    return fromIndex;
  }
  return fromIndex;
}

/**
 * Computes the vertical CSS transform displacement (px) for item at `index`
 * while dragging `fromIndex` toward `toIndex`. Pure.
 *
 * Siblings shift out of the way by `items[fromIndex].outerHeight`, and the
 * source placeholder shifts cleanly into the vacated landing slot.
 */
export function computeItemDisplacement(
  items: readonly DragItemGeometry[],
  fromIndex: number,
  toIndex: number,
  index: number
): number {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) {
    return 0;
  }
  const draggedOuter = items[fromIndex].outerHeight;
  if (toIndex > fromIndex) {
    if (index === fromIndex) return items[toIndex].bottom - items[fromIndex].bottom;
    if (index > fromIndex && index <= toIndex) return -draggedOuter;
    return 0;
  }
  if (index === fromIndex) return items[toIndex].top - items[fromIndex].top;
  if (index >= toIndex && index < fromIndex) return draggedOuter;
  return 0;
}

/**
 * Computes the Y offset (px relative to the list's first item top) where the
 * crisp drop indicator line should sit, or `null` when `toIndex === fromIndex`.
 */
export function computeDropIndicatorOffset(
  items: readonly DragItemGeometry[],
  fromIndex: number,
  toIndex: number
): number | null {
  if (fromIndex === toIndex || items.length < 2 || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) {
    return null;
  }
  const listTop = items[0].top;
  if (toIndex < fromIndex) {
    const gapAbove = toIndex > 0 ? Math.max(0, items[toIndex].top - items[toIndex - 1].bottom) : 0;
    return Math.max(0, items[toIndex].top - listTop - gapAbove * 0.5);
  }
  const landingTop = items[toIndex].bottom - items[fromIndex].height;
  const shiftedPrevBottom = items[toIndex].bottom - items[fromIndex].outerHeight;
  const seam = (shiftedPrevBottom + landingTop) * 0.5;
  return Math.max(0, seam - listTop);
}

/** Measures all sibling DOM elements of a sortable list in scroll-content coordinates. */
function measureListGeometry(
  ids: readonly string[],
  nodes: ReadonlyMap<string, HTMLElement>,
  scrollEl: HTMLElement | null
): DragItemGeometry[] | null {
  const containerTop = scrollEl ? scrollEl.getBoundingClientRect().top : 0;
  const scrollTop = scrollEl ? scrollEl.scrollTop : 0;
  const raw: { id: string; top: number; height: number; bottom: number }[] = [];
  for (const id of ids) {
    const el = nodes.get(id);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const top = rect.top - containerTop + scrollTop;
    raw.push({ id, top, height: rect.height, bottom: top + rect.height });
  }
  return raw.map((item, index) => {
    let outerHeight = item.height;
    if (index < raw.length - 1) {
      outerHeight = Math.max(item.height, raw[index + 1].top - item.top);
    } else if (index > 0) {
      const prevGap = Math.max(0, item.top - raw[index - 1].bottom);
      outerHeight = item.height + prevGap;
    }
    return { ...item, outerHeight };
  });
}

/** Keyboard handler for accessible reordering (`Option+Up/Down` on macOS, `Alt+Up/Down` elsewhere). */
export function handleReorderKeyDown(
  event: React.KeyboardEvent,
  index: number,
  count: number,
  onMove: (fromIndex: number, toIndex: number) => void
): boolean {
  if (!event.altKey || event.ctrlKey || event.metaKey) return false;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
  if (count <= 1) return false;
  event.preventDefault();
  event.stopPropagation();
  const delta = event.key === 'ArrowUp' ? -1 : 1;
  const nextIndex = index + delta;
  if (nextIndex >= 0 && nextIndex < count) {
    onMove(index, nextIndex);
  }
  return true;
}

type PendingDrag<Meta> = {
  scope: string;
  id: string;
  orderedIds: string[];
  fromIndex: number;
  pointerId: number;
  startX: number;
  startY: number;
  meta: Meta;
  onCommit: (fromIndex: number, toIndex: number) => void;
};

/**
 * Smooth pointer-driven drag-and-drop reorder hook for vertical lists (both
 * fixed-height rows and variable-height collapsible groups):
 * - Small 5px activation threshold so ordinary clicks and hover menus work cleanly
 * - Zero-rerender 120fps floating overlay transform tracking
 * - Springy GPU-composited sibling displacement with zero drop flicker
 * - Auto-scroll near the top/bottom edges of the sidebar scroll container
 * - Escape, blur, and pointercancel cleanly cancel without mutating order
 */
export function useSidebarDragReorder<Meta = unknown>(scrollContainerRef: React.RefObject<HTMLElement | null>) {
  const [activeDrag, setActiveDrag] = useState<ActiveDrag<Meta> | null>(null);
  const activeDragRef = useRef<ActiveDrag<Meta> | null>(null);
  const pendingRef = useRef<PendingDrag<Meta> | null>(null);
  const itemNodesRef = useRef<Map<string, Map<string, HTMLElement>>>(new Map());
  const overlayElRef = useRef<HTMLDivElement | null>(null);
  const pointerPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const onCommitRef = useRef<((fromIndex: number, toIndex: number) => void) | null>(null);
  // Suppresses the synthetic click emitted right after pointerup on a real drag.
  const suppressClickUntilRef = useRef<number>(0);

  const registerItem = useCallback((scope: string, id: string) => {
    return (node: HTMLElement | null) => {
      let map = itemNodesRef.current.get(scope);
      if (!map) {
        if (!node) return;
        map = new Map();
        itemNodesRef.current.set(scope, map);
      }
      if (node) map.set(id, node);
      else map.delete(id);
    };
  }, []);

  const updateOverlayTransform = useCallback((x: number, y: number) => {
    const el = overlayElRef.current;
    if (!el) return;
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(1.015)`;
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const clearBodyDragState = useCallback(() => {
    document.body.classList.remove('bots-dragging');
  }, []);

  const endDrag = useCallback(
    (commit: boolean) => {
      stopAutoScroll();
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      clearBodyDragState();
      const current = activeDragRef.current;
      const commitFn = onCommitRef.current;
      pendingRef.current = null;
      activeDragRef.current = null;
      onCommitRef.current = null;
      if (current) {
        suppressClickUntilRef.current = performance.now() + 80;
        // Clear drag state and commit the new order in the same React batch so
        // items swap cleanly into place without a single frame of flicker.
        setActiveDrag(null);
        if (commit && commitFn && current.fromIndex !== current.toIndex) {
          commitFn(current.fromIndex, current.toIndex);
        }
      }
    },
    [clearBodyDragState, stopAutoScroll]
  );

  const recomputeTargetFromPointer = useCallback(() => {
    const current = activeDragRef.current;
    if (!current) return;
    const scrollEl = scrollContainerRef.current;
    const containerTop = scrollEl ? scrollEl.getBoundingClientRect().top : 0;
    const scrollTop = scrollEl ? scrollEl.scrollTop : 0;
    const pointerContentY = pointerPosRef.current.y - containerTop + scrollTop;
    const nextTo = computeTargetIndex(current.items, current.fromIndex, pointerContentY);
    if (nextTo !== current.toIndex) {
      const updated: ActiveDrag<Meta> = { ...current, toIndex: nextTo };
      activeDragRef.current = updated;
      setActiveDrag(updated);
    }
  }, [scrollContainerRef]);

  const startAutoScrollLoop = useCallback(() => {
    stopAutoScroll();
    const tick = () => {
      const current = activeDragRef.current;
      const scrollEl = scrollContainerRef.current;
      if (!current || !scrollEl) {
        rafRef.current = null;
        return;
      }
      const rect = scrollEl.getBoundingClientRect();
      const y = pointerPosRef.current.y;
      let delta = 0;
      if (y < rect.top + AUTOSCROLL_EDGE_PX && scrollEl.scrollTop > 0) {
        const ratio = Math.min(1, Math.max(0, (rect.top + AUTOSCROLL_EDGE_PX - y) / AUTOSCROLL_EDGE_PX));
        delta = -Math.max(1.5, Math.round(AUTOSCROLL_MAX_PX_PER_FRAME * ratio * ratio));
      } else if (y > rect.bottom - AUTOSCROLL_EDGE_PX && scrollEl.scrollTop < scrollEl.scrollHeight - scrollEl.clientHeight) {
        const ratio = Math.min(1, Math.max(0, (y - (rect.bottom - AUTOSCROLL_EDGE_PX)) / AUTOSCROLL_EDGE_PX));
        delta = Math.max(1.5, Math.round(AUTOSCROLL_MAX_PX_PER_FRAME * ratio * ratio));
      }
      if (delta !== 0) {
        const before = scrollEl.scrollTop;
        scrollEl.scrollTop += delta;
        if (scrollEl.scrollTop !== before) {
          recomputeTargetFromPointer();
        }
      }
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);
  }, [recomputeTargetFromPointer, scrollContainerRef, stopAutoScroll]);

  const startPointerDrag = useCallback(
    (
      event: React.PointerEvent,
      options: {
        scope: string;
        id: string;
        orderedIds: string[];
        meta: Meta;
        disabled?: boolean;
        onCommit: (fromIndex: number, toIndex: number) => void;
      }
    ) => {
      if (options.disabled || options.orderedIds.length <= 1) return;
      // Primary button only; ignore interactive sub-controls (`…` menu, `+` button, inputs).
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-no-drag="true"], [role="menu"], input, textarea, select')) return;

      const fromIndex = options.orderedIds.indexOf(options.id);
      if (fromIndex < 0) return;

      // Cancel any stray prior session before starting a fresh one.
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }

      pendingRef.current = {
        scope: options.scope,
        id: options.id,
        orderedIds: options.orderedIds,
        fromIndex,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        meta: options.meta,
        onCommit: options.onCommit,
      };
      pointerPosRef.current = { x: event.clientX, y: event.clientY };

      const onPointerMove = (moveEvent: PointerEvent) => {
        const pending = pendingRef.current;
        if (pending && moveEvent.pointerId !== pending.pointerId) return;
        pointerPosRef.current = { x: moveEvent.clientX, y: moveEvent.clientY };

        if (!activeDragRef.current) {
          if (!pending) return;
          const dx = moveEvent.clientX - pending.startX;
          const dy = moveEvent.clientY - pending.startY;
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;

          const scopeNodes = itemNodesRef.current.get(pending.scope);
          const sourceEl = scopeNodes?.get(pending.id);
          const scrollEl = scrollContainerRef.current;
          if (!scopeNodes || !sourceEl) {
            endDrag(false);
            return;
          }
          const items = measureListGeometry(pending.orderedIds, scopeNodes, scrollEl);
          if (!items) {
            endDrag(false);
            return;
          }
          const rect = sourceEl.getBoundingClientRect();
          const grabOffset = { x: pending.startX - rect.left, y: pending.startY - rect.top };
          const swayX = Math.max(-MAX_HORIZONTAL_SWAY_PX, Math.min(MAX_HORIZONTAL_SWAY_PX, dx * 0.25));
          const overlayPos = {
            x: rect.left + swayX,
            y: moveEvent.clientY - grabOffset.y,
          };
          const containerTop = scrollEl ? scrollEl.getBoundingClientRect().top : 0;
          const scrollTop = scrollEl ? scrollEl.scrollTop : 0;
          const pointerContentY = moveEvent.clientY - containerTop + scrollTop;
          const toIndex = computeTargetIndex(items, pending.fromIndex, pointerContentY);

          const next: ActiveDrag<Meta> = {
            scope: pending.scope,
            id: pending.id,
            fromIndex: pending.fromIndex,
            toIndex,
            items,
            initialRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            grabOffset,
            overlayPos,
            meta: pending.meta,
          };
          activeDragRef.current = next;
          onCommitRef.current = pending.onCommit;
          document.body.classList.add('bots-dragging');
          // Dismiss any native text selection started before threshold was crossed.
          window.getSelection?.()?.removeAllRanges?.();
          setActiveDrag(next);
          startAutoScrollLoop();
          return;
        }

        moveEvent.preventDefault();
        const current = activeDragRef.current;
        const dx = pending ? moveEvent.clientX - pending.startX : 0;
        const swayX = Math.max(-MAX_HORIZONTAL_SWAY_PX, Math.min(MAX_HORIZONTAL_SWAY_PX, dx * 0.25));
        const nextX = current.initialRect.left + swayX;
        const nextY = moveEvent.clientY - current.grabOffset.y;
        current.overlayPos = { x: nextX, y: nextY };
        updateOverlayTransform(nextX, nextY);
        recomputeTargetFromPointer();
      };

      const onPointerUp = (upEvent: PointerEvent) => {
        const pending = pendingRef.current;
        if (pending && upEvent.pointerId !== pending.pointerId) return;
        endDrag(true);
      };

      const onPointerCancel = () => {
        endDrag(false);
      };

      const onKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === 'Escape' && activeDragRef.current) {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          endDrag(false);
        }
      };

      const onBlur = () => {
        endDrag(false);
      };

      const onSuppressClick = (clickEvent: MouseEvent) => {
        if (performance.now() <= suppressClickUntilRef.current) {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
        }
      };

      window.addEventListener('pointermove', onPointerMove, { passive: false });
      window.addEventListener('pointerup', onPointerUp, true);
      window.addEventListener('pointercancel', onPointerCancel, true);
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('blur', onBlur);
      window.addEventListener('click', onSuppressClick, true);

      cleanupRef.current = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp, true);
        window.removeEventListener('pointercancel', onPointerCancel, true);
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('blur', onBlur);
        // Keep click suppression alive briefly after pointerup so the trailing
        // click event from the completed drag is swallowed cleanly.
        window.setTimeout(() => window.removeEventListener('click', onSuppressClick, true), 120);
      };
    },
    [endDrag, recomputeTargetFromPointer, scrollContainerRef, startAutoScrollLoop, updateOverlayTransform]
  );

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      stopAutoScroll();
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      clearBodyDragState();
    };
  }, [clearBodyDragState, stopAutoScroll]);

  const shouldSuppressClick = useCallback(() => performance.now() <= suppressClickUntilRef.current, []);

  return {
    activeDrag,
    overlayElRef,
    registerItem,
    startPointerDrag,
    cancelDrag: useCallback(() => endDrag(false), [endDrag]),
    shouldSuppressClick,
  };
}
