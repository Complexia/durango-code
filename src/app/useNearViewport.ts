import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/** The nearest ancestor that scrolls vertically: the transcript, a preview pane. */
const findScrollParent = (element: HTMLElement): HTMLElement | null => {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return node;
  }
  return null;
};

/**
 * Blocks of one message share their scroll container: look it up once per
 * `.markdown-content` (a style walk up the tree), not once per block.
 */
const scrollParents = new WeakMap<Element, HTMLElement | null>();
const scrollParent = (element: HTMLElement): HTMLElement | null => {
  const anchor = element.closest('.markdown-content') ?? element;
  const cached = scrollParents.get(anchor);
  // Still around the element (a message moved to another pane would not be).
  if (cached !== undefined && (cached === null || cached.contains(element))) return cached;
  const found = findScrollParent(element);
  scrollParents.set(anchor, found);
  return found;
};

type Watcher = (entry: IntersectionObserverEntry) => void;
type SharedObserver = { observer: IntersectionObserver; watchers: Map<Element, Watcher> };

/** One IntersectionObserver per scroll container and margin, shared by its blocks. */
const observers = new Map<Element | null, Map<number, SharedObserver>>();

const watch = (element: Element, root: Element | null, margin: number, watcher: Watcher) => {
  let byMargin = observers.get(root);
  if (!byMargin) {
    byMargin = new Map();
    observers.set(root, byMargin);
  }
  let shared = byMargin.get(margin);
  if (!shared) {
    const watchers = new Map<Element, Watcher>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) watchers.get(entry.target)?.(entry);
      },
      // The scroll container as root: a margin around the window would be clipped by it.
      { root, rootMargin: `${margin}px 0px` }
    );
    shared = { observer, watchers };
    byMargin.set(margin, shared);
  }
  const { observer, watchers } = shared;
  watchers.set(element, watcher);
  observer.observe(element);
  return () => {
    if (watchers.get(element) !== watcher) return;
    watchers.delete(element);
    observer.unobserve(element);
    if (!watchers.size) {
      observer.disconnect();
      byMargin.delete(margin);
      if (!byMargin.size) observers.delete(root);
    }
  };
};

/**
 * Whether the element is within `margin` pixels of its scroll container's
 * visible area. Lets expensive rendering (syntax highlighting, diagram
 * layout) wait until a block is about to be seen, so opening a long thread
 * doesn't do it for every block at once.
 *
 * `sticky` (the default) stays true once reached. Otherwise it follows the
 * element in and out, for work that should pause off screen.
 *
 * With `checkNow`, also checked before the first paint, so a block that
 * mounts on screen with something to show at once (highlighting from the
 * cache, or from the block it replaces) never shows a frame of its fallback.
 * That check reads layout during the commit, so it is only for such blocks;
 * the rest learn from the observer a frame later.
 */
export const useNearViewport = (
  ref: RefObject<HTMLElement | null>,
  margin = 800,
  sticky = true,
  checkNow: boolean | (() => boolean) = false
): boolean => {
  const [near, setNear] = useState(false);
  const done = sticky && near;
  // Before the first paint, and only when asked: reads layout during the commit.
  useLayoutEffect(() => {
    // A function is asked here, in the commit: after the cleanups of blocks this
    // one replaces have run (a streaming block hands over its colors then).
    if (!(typeof checkNow === 'function' ? checkNow() : checkNow)) return;
    const element = ref.current;
    if (!element) return;
    const root = scrollParent(element);
    const box = element.getBoundingClientRect();
    const area = root?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    if (box.height > 0 && box.bottom >= area.top - margin && box.top <= area.bottom + margin) setNear(true);
    // `checkNow` only matters on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // After paint: the shared observer.
  useEffect(() => {
    if (done) return;
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    let stop = () => {};
    stop = watch(element, scrollParent(element), margin, (entry) => {
      if (sticky && !entry.isIntersecting) return;
      setNear(entry.isIntersecting);
      if (sticky) stop();
    });
    return () => stop();
  }, [ref, done, margin, sticky]);
  return near;
};
