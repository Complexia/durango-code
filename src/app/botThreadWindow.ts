// Long bot threads (BotsWorkspace's BotPane): the messages are loaded a page at
// a time (newest first, older ones as you scroll up), polled by cursor (only
// what is new since the last poll), and only a window of them is mounted, so a
// thread of thousands of messages opens and scrolls like a short one.
//
// The pure helpers here are tested in scripts/test-bot-thread-window.mjs.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DesktopBotLive, DesktopBotMessage } from './bots';

/** Messages asked for when a thread opens, per older page, and per poll. */
export const BOT_THREAD_FIRST_PAGE = 40;
export const BOT_THREAD_OLDER_PAGE = 60;
export const BOT_THREAD_POLL_PAGE = 100;
/** Polls in a row that may each say "more after these" before the thread reloads from the newest page. */
export const BOT_THREAD_POLL_ROUNDS = 5;

/** Mounted rows: the newest this many at first, growing by a step as you scroll, at most the max. */
export const BOT_WINDOW_INITIAL = 30;
export const BOT_WINDOW_STEP = 30;
export const BOT_WINDOW_MAX = 90;
/** How close to the top (or bottom) of the list, in pixels, scrolling pages in more. */
const BOT_WINDOW_MARGIN = 600;

const sameFiles = (a: DesktopBotMessage['files'], b: DesktopBotMessage['files']) =>
  a === b ||
  (!a?.length && !b?.length) ||
  (a?.length === b?.length &&
    (a ?? []).every((file, index) => {
      const other = b?.[index];
      return (
        file.name === other?.name &&
        file.size === other?.size &&
        file.assetId === other?.assetId &&
        file.path === other?.path &&
        file.contentType === other?.contentType &&
        file.pendingId === other?.pendingId &&
        file.status === other?.status &&
        file.error === other?.error
      );
    }));

// Cards (show_html pages, buttons, files galleries): small and rarely changed, compared by content.
const sameCards = (a: DesktopBotMessage['cards'], b: DesktopBotMessage['cards']) =>
  a === b || (!a?.length && !b?.length) || JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** Whether a fetched message says the same as the one shown (then the shown object is kept, and its row isn't redrawn). */
export const sameBotMessage = (a: DesktopBotMessage, b: DesktopBotMessage) =>
  a.id === b.id &&
  a.seq === b.seq &&
  a.role === b.role &&
  a.content === b.content &&
  a.authorLabel === b.authorLabel &&
  a.createdAt === b.createdAt &&
  a.silentRead?.at === b.silentRead?.at &&
  a.silentRead?.reason === b.silentRead?.reason &&
  a.requestResolved?.at === b.requestResolved?.at &&
  a.requestResolved?.op === b.requestResolved?.op &&
  a.requestResolved?.by === b.requestResolved?.by &&
  a.requestResolved?.byName === b.requestResolved?.byName &&
  a.requestResolved?.machineName === b.requestResolved?.machineName &&
  sameFiles(a.files, b.files) &&
  sameCards(a.cards, b.cards);

/**
 * `incoming` merged into `current` (both in seq order), by id: new ones added,
 * changed ones replaced, unchanged ones kept as the same objects. → `current`
 * itself when nothing changed, so nothing redraws.
 */
export const mergeBotMessages = (current: DesktopBotMessage[], incoming: DesktopBotMessage[] | undefined): DesktopBotMessage[] => {
  if (!incoming?.length) return current;
  const byId = new Map(current.map((message) => [message.id, message]));
  let changed = false;
  for (const message of incoming) {
    const shown = byId.get(message.id);
    if (shown && sameBotMessage(shown, message)) continue;
    byId.set(message.id, message);
    changed = true;
  }
  if (!changed) return current;
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
};

/**
 * Where a poll picks up: after the newest message shown, but before any reply
 * still being written that has taken its place (`seq`) in the thread: it is
 * stored there when it finishes, possibly below messages already shown. A
 * reply that sent messages (`firstSeq`) has them read again until it ends.
 * (Replies that take a place later get one above everything shown.) null: no
 * messages yet (load the newest page).
 */
export const botPollCursor = (messages: DesktopBotMessage[], live: DesktopBotLive[] | undefined): number | null => {
  if (!messages.length) return null;
  let cursor = messages[messages.length - 1].seq;
  for (const reply of live ?? []) {
    if (typeof reply.seq === 'number' && reply.seq <= cursor) cursor = Math.min(cursor, reply.seq - 1);
    // Its messages so far are read again: cards are added to them while it runs and when it ends.
    if (typeof reply.firstSeq === 'number' && reply.firstSeq <= cursor) cursor = Math.min(cursor, reply.firstSeq - 1);
  }
  // Messages with attachments still uploading are re-read until they resolve (assetId or failed).
  for (const message of messages) {
    if (message.seq <= cursor && message.files?.some((file) => file.status === 'uploading')) {
      cursor = Math.min(cursor, message.seq - 1);
    }
  }
  return cursor;
};

/** The mounted slice of `count` messages: `[start, end)`. */
export type BotWindow = { start: number; end: number; following: boolean };

/**
 * The mounted range: from `startId` (null: the newest BOT_WINDOW_INITIAL) to
 * `endId` (null: following the newest; new messages come into view).
 * An id no longer in the list falls back to the newest.
 */
export const botWindowRange = (ids: readonly string[], startId: string | null, endId: string | null): BotWindow => {
  const count = ids.length;
  const endIndex = endId === null ? -1 : ids.indexOf(endId);
  const following = endIndex < 0;
  const end = following ? count : endIndex + 1;
  const startIndex = startId === null ? -1 : ids.indexOf(startId);
  const start = startIndex >= 0 && startIndex < end ? startIndex : Math.max(0, end - BOT_WINDOW_INITIAL);
  return { start, end, following };
};

/** The window after scrolling near its top (`up`) or bottom: grown by a step, trimmed at the far side to BOT_WINDOW_MAX. */
export const botWindowStep = (count: number, range: BotWindow, direction: 'up' | 'down'): BotWindow => {
  if (direction === 'up') {
    const start = Math.max(0, range.start - BOT_WINDOW_STEP);
    const end = Math.min(range.end, start + BOT_WINDOW_MAX);
    return { start, end, following: range.following && end === count };
  }
  const end = Math.min(count, range.end + BOT_WINDOW_STEP);
  const start = Math.max(range.start, end - BOT_WINDOW_MAX);
  return { start, end, following: end === count };
};

/** The window that shows the message at `index` with some context around it (BOT_WINDOW_INITIAL rows). */
export const botWindowAround = (count: number, index: number): BotWindow => {
  const half = Math.floor(BOT_WINDOW_INITIAL / 2);
  const end = Math.min(count, Math.max(index + 1 + half, Math.min(count, BOT_WINDOW_INITIAL)));
  const start = Math.max(0, Math.min(index - half, end - BOT_WINDOW_INITIAL));
  return { start, end, following: end === count };
};

type Anchor = { id: string; top: number };

/**
 * The mounted window of a bot thread and its scrolling: near the top it grows
 * upward (paging older messages in from Durango when the loaded ones run
 * out), near the bottom it grows back down, and at most BOT_WINDOW_MAX rows
 * are mounted. Whatever row is at the top of the view stays put when rows are
 * added or removed above it. Rows carry `data-bot-row="<message id>"`.
 */
export const useBotMessageWindow = ({
  ids,
  scrollRef,
  hasMore,
  loadOlder,
  resetKey,
}: {
  ids: readonly string[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Older messages left on the server. */
  hasMore: boolean;
  /** Loads the page before the oldest loaded message. → whether it did. */
  loadOlder: () => Promise<boolean>;
  /** The thread: a new one starts at its newest messages. */
  resetKey: string;
}) => {
  const [state, setState] = useState<{ key: string; startId: string | null; endId: string | null }>({ key: resetKey, startId: null, endId: null });
  const current = state.key === resetKey ? state : { key: resetKey, startId: null, endId: null };
  const range = useMemo(() => botWindowRange(ids, current.startId, current.endId), [ids, current.startId, current.endId]);
  const anchor = useRef<Anchor | null>(null);
  const loading = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const live = useRef({ ids, range, hasMore, loadOlder, resetKey });
  live.current = { ids, range, hasMore, loadOlder, resetKey };

  /** The row at the top of the view, to keep in place across the next change. */
  const captureAnchor = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    for (const row of element.querySelectorAll<HTMLElement>('[data-bot-row]')) {
      const box = row.getBoundingClientRect();
      if (box.bottom > top) {
        anchor.current = { id: row.dataset.botRow ?? '', top: box.top };
        return;
      }
    }
  }, [scrollRef]);

  const apply = useCallback(
    (next: BotWindow) => {
      const { ids: all, resetKey: key } = live.current;
      captureAnchor();
      setState({
        key,
        startId: next.following && next.end - next.start <= BOT_WINDOW_INITIAL ? null : all[next.start] ?? null,
        endId: next.following ? null : all[next.end - 1] ?? null,
      });
    },
    [captureAnchor]
  );

  // The mounted rows are held by id, so a page loaded above them moves
  // nothing; once it is in, scrolling (or, still at the top, the effect
  // below) shows it. A failed load waits for the next scroll.
  const check = useRef<() => void>(() => {});
  const pageOlder = useCallback(async () => {
    if (loading.current || !live.current.hasMore) return;
    loading.current = true;
    setLoadingOlder(true);
    try {
      await live.current.loadOlder();
    } finally {
      loading.current = false;
      setLoadingOlder(false);
    }
  }, []);

  /** Call from the list's onScroll. */
  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const { ids: all, range: shown, hasMore: more } = live.current;
    const nearTop = element.scrollTop < Math.max(BOT_WINDOW_MARGIN, element.clientHeight);
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < Math.max(BOT_WINDOW_MARGIN, element.clientHeight);
    if (nearTop) {
      if (shown.start > 0) apply(botWindowStep(all.length, shown, 'up'));
      // Running low on loaded messages above: fetch the page before them.
      if (shown.start <= BOT_WINDOW_STEP && more) void pageOlder();
    } else if (nearBottom && !shown.following) {
      apply(botWindowStep(all.length, shown, 'down'));
    }
  }, [apply, pageOlder, scrollRef]);
  check.current = onScroll;

  /** Back to the newest messages (sending, or "Jump to latest"). */
  const toLatest = useCallback(() => {
    anchor.current = null;
    setState({ key: live.current.resetKey, startId: null, endId: null });
  }, []);

  /**
   * Mounts the rows around message `id` (a reply quote jumping to the message
   * it answers), so the caller can scroll it into view once they are drawn.
   * → false when it isn't loaded.
   */
  const reveal = useCallback((id: string) => {
    const { ids: all, resetKey: key } = live.current;
    const index = all.indexOf(id);
    if (index < 0) return false;
    anchor.current = null;
    const next = botWindowAround(all.length, index);
    setState({
      key,
      startId: next.following && next.end - next.start <= BOT_WINDOW_INITIAL ? null : all[next.start] ?? null,
      endId: next.following ? null : all[next.end - 1] ?? null,
    });
    return true;
  }, []);

  /** Back at the bottom while following: let a window grown by reading back shrink again. */
  const settle = useCallback(() => {
    const { range: shown } = live.current;
    if (shown.following && shown.end - shown.start > BOT_WINDOW_INITIAL + BOT_WINDOW_STEP) {
      anchor.current = null;
      setState({ key: live.current.resetKey, startId: null, endId: null });
    }
  }, []);

  // After a change, still near the top (rows that don't fill the view, or a
  // page just loaded while at the top): page in more without waiting for a
  // scroll. It stops once the top is out of reach, or nothing is left.
  useEffect(() => {
    const frame = requestAnimationFrame(() => check.current());
    return () => cancelAnimationFrame(frame);
  }, [ids.length, range.start, range.end, hasMore]);

  // Rows were added or removed above the view: move the scroll offset by as
  // much as that moved the row being read.
  useLayoutEffect(() => {
    const saved = anchor.current;
    anchor.current = null;
    const element = scrollRef.current;
    if (!saved || !element) return;
    const row = element.querySelector<HTMLElement>(`[data-bot-row="${CSS.escape(saved.id)}"]`);
    if (!row) return;
    const delta = row.getBoundingClientRect().top - saved.top;
    if (Math.abs(delta) >= 1) element.scrollTop += delta;
  }, [range.start, range.end, ids, scrollRef]);

  return { range, onScroll, toLatest, settle, reveal, loadingOlder };
};
