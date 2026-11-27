import { useEffect, useMemo } from 'react';
import { flushIntoStoreBeforeUnload, useOrionStore, type BotDraft } from '../store';
import type { BotAttachmentFile } from './bots';

// Unsent bot prompts, kept like v2 thread drafts: one per box in the persisted
// store (`botDrafts`), so switching bots, tabs (Threads/Bots, Settings...),
// opening a thread, or restarting the app brings the text and files back. A
// box keeps its draft in React state while it's on screen and writes it here
// debounced, so a keystroke never serializes the store; the pending write is
// flushed when the box goes away, the window blurs or hides, and on unload.

export const BOT_DRAFT_SAVE_DEBOUNCE_MS = 400;

/** A bot's conversation box (bot ids are already unique per account). */
export const botDraftKey = (botId: string) => `bot:${botId}`;
/**
 * A project page's "ask the project bot" box. Projects are this computer's,
 * shared by every account (and signed-out local bots), so the key carries
 * the account the Bots view is showing: one account's text never shows up
 * for another.
 */
export const projectBotDraftKey = (account: string | null, projectId: string) =>
  `project:${account ?? 'none'}:${projectId}`;

const IMAGE_PATH = /\.(png|jpe?g|gif|webp)$/i;

/**
 * The thumbnail URL of a file on disk. Built from the raw path: the markdown
 * media helper decodes %xx escapes, which would turn a file literally named
 * `diagram%20v2.png` into `diagram v2.png`.
 */
export const botDraftThumbnail = (filePath: string) =>
  `orion-attachment://local/media?path=${encodeURIComponent(filePath.replace(/\\/g, '/'))}`;

/** The saved draft as the box's files: thumbnails come back from the files on disk. */
export const loadBotDraft = (key: string): { text: string; files: BotAttachmentFile[] } => {
  const draft = useOrionStore.getState().botDrafts[key];
  if (!draft) return { text: '', files: [] };
  const files = (Array.isArray(draft.files) ? draft.files : [])
    .filter((file) => file && typeof file.path === 'string' && file.path)
    .map((file) => ({
      path: file.path,
      name: typeof file.name === 'string' && file.name ? file.name : 'file',
      size: typeof file.size === 'number' ? file.size : 0,
      ...(IMAGE_PATH.test(file.path) ? { preview: botDraftThumbnail(file.path) } : {}),
    }));
  return { text: typeof draft.text === 'string' ? draft.text : '', files };
};

const sameDraft = (a: BotDraft | undefined, b: BotDraft) =>
  (a?.text ?? '') === b.text &&
  (a?.files.length ?? 0) === b.files.length &&
  b.files.every((file, index) => a?.files[index]?.path === file.path);

export type BotDraftSaver = {
  /** The box's draft changed. Debounced; an emptied draft (sent or cleared) is written at once. */
  save: (text: string, files?: BotAttachmentFile[]) => void;
  /** Write a pending change now. */
  flush: () => void;
  /**
   * The draft is being sent: drop any pending write and forget the saved
   * copy, so leaving the box before the send finishes can't bring a sent
   * prompt back. Edits made after this are saved as usual.
   */
  discard: () => void;
};

export const createBotDraftSaver = (
  key: string,
  options: {
    debounceMs?: number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {}
): BotDraftSaver => {
  const debounceMs = options.debounceMs ?? BOT_DRAFT_SAVE_DEBOUNCE_MS;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let pending: BotDraft | null = null;
  let timer: unknown = null;

  const cancelTimer = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };
  const write = (draft: BotDraft) => {
    const state = useOrionStore.getState();
    if (!sameDraft(state.botDrafts[key], draft)) state.setBotDraft(key, draft);
  };
  const flush = () => {
    cancelTimer();
    const draft = pending;
    pending = null;
    if (draft) write(draft);
  };

  return {
    save: (text, files = []) => {
      pending = { text, files: files.map(({ path, name, size }) => ({ path, name, size })) };
      if (!text.trim() && files.length === 0) {
        flush();
        return;
      }
      cancelTimer();
      timer = setTimer(() => {
        timer = null;
        flush();
      }, debounceMs);
    },
    flush,
    discard: () => {
      cancelTimer();
      pending = null;
      write({ text: '', files: [] });
    },
  };
};

/**
 * A send failed: put its text back, unless the box has a newer draft (typed
 * after sending) that must not be overwritten.
 */
export const restoreUnsentBotDraft = (key: string, draft: BotDraft) => {
  const state = useOrionStore.getState();
  if (state.botDrafts[key]) return;
  state.setBotDraft(key, draft);
};

/**
 * Merges newly staged files directly into a bot's persisted draft (used when
 * an async drop or file pick finishes after the composer has already unmounted).
 * Deduplicates by path, respects `maxFiles`, and strips transient preview URLs.
 */
export const appendBotDraftFiles = (key: string, next: BotAttachmentFile[], maxFiles: number) => {
  if (next.length === 0) return;
  const state = useOrionStore.getState();
  const existing = state.botDrafts[key];
  const merged = [...(existing?.files ?? [])];
  let added = false;
  for (const file of next) {
    if (!file.path || merged.some((item) => item.path === file.path) || merged.length >= maxFiles) continue;
    merged.push({ path: file.path, name: file.name, size: file.size });
    added = true;
  }
  if (!added) return;
  state.setBotDraft(key, { text: existing?.text ?? '', files: merged });
};

/** A box's saver, flushed when it goes away (another bot, tab or thread), the window blurs or hides, and on unload. */
export const useBotDraftSaver = (key: string): BotDraftSaver => {
  const saver = useMemo(() => createBotDraftSaver(key), [key]);
  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') saver.flush();
    };
    const offUnload = flushIntoStoreBeforeUnload(saver.flush);
    window.addEventListener('blur', saver.flush);
    document.addEventListener('visibilitychange', flushWhenHidden);
    return () => {
      offUnload();
      window.removeEventListener('blur', saver.flush);
      document.removeEventListener('visibilitychange', flushWhenHidden);
      saver.flush();
    };
  }, [saver]);
  return saver;
};
