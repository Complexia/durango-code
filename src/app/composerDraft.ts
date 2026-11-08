import type { ComposerDraft, FileAttachment } from '../store';

// The composer's draft lives outside React state so typing re-renders only the
// composer (it subscribes with useSyncExternalStore) and never the app shell.
// App reads and writes the draft at event time through this controller —
// send, steer, queue, slash commands, restoring a failed submission — and
// subscribes to narrow derived values (e.g. "the draft is non-empty") that
// only change on transitions.
//
// Per-thread drafts: `switchTo(threadId)` swaps the visible draft, keeping the
// previous thread's in memory. Drafts are written to the persisted store
// (`composerDrafts`) debounced, so a keystroke never serializes the store or
// wakes its subscribers; `flush()` writes pending drafts at once and runs on
// thread switch, send, window blur, visibility hidden and unload.

export type ComposerDraftSnapshot = {
  // Thread whose draft is on screen (the selected thread).
  readonly key: string | null;
  readonly text: string;
  readonly attachments: FileAttachment[];
  // Threads whose send is past the composer but whose turn hasn't started
  // (linked-task refresh, workspace setup, mention preflight...).
  readonly starting: ReadonlySet<string>;
};

export type ComposerDraftControllerOptions = {
  // The persisted draft of a thread this session hasn't touched yet.
  load: (threadId: string) => ComposerDraft | undefined;
  // Persist a draft (an empty one removes it).
  save: (threadId: string, draft: ComposerDraft) => void;
  // A thread's draft got content for the first time this session.
  onDraftTyped?: (threadId: string) => void;
  debounceMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type DraftUpdate = (draft: ComposerDraft) => ComposerDraft;

export type ComposerDraftController = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ComposerDraftSnapshot;
  // The visible draft.
  getDraft: () => ComposerDraft;
  hasActiveContent: () => boolean;
  setText: (text: string | ((current: string) => string)) => void;
  setAttachments: (update: (current: FileAttachment[]) => FileAttachment[]) => void;
  // Empties the visible draft (text and attachments).
  clear: () => void;
  switchTo: (threadId: string | null) => void;
  // Any thread's draft: the visible one, this session's copy, or the saved one.
  getThreadDraft: (threadId: string) => ComposerDraft | undefined;
  hasThreadDraft: (threadId: string) => boolean;
  // Edits any thread's draft. The visible one updates the composer; another
  // thread's is saved at once (it isn't being typed into).
  updateThreadDraft: (threadId: string, update: DraftUpdate) => void;
  setStarting: (threadId: string, starting: boolean) => void;
  flush: () => void;
  // The composer's textarea, registered while it is mounted.
  setInput: (element: HTMLTextAreaElement | null) => void;
  getInput: () => HTMLTextAreaElement | null;
  focus: (caret?: number) => void;
  dispose: () => void;
};

export const COMPOSER_DRAFT_SAVE_DEBOUNCE_MS = 400;

const EMPTY_ATTACHMENTS: FileAttachment[] = [];
const EMPTY_STARTING: ReadonlySet<string> = new Set();

export const draftHasContent = (draft: ComposerDraft | undefined | null) =>
  !!draft && (!!draft.text.trim() || draft.attachments.length > 0);

export const createComposerDraftController = (
  options: ComposerDraftControllerOptions
): ComposerDraftController => {
  const debounceMs = options.debounceMs ?? COMPOSER_DRAFT_SAVE_DEBOUNCE_MS;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  // This session's drafts, empty ones included, so a thread cleared here
  // never falls back to a stale saved copy.
  const drafts = new Map<string, ComposerDraft>();
  const unsaved = new Set<string>();
  const typed = new Set<string>();
  const listeners = new Set<() => void>();
  let snapshot: ComposerDraftSnapshot = {
    key: null,
    text: '',
    attachments: EMPTY_ATTACHMENTS,
    starting: EMPTY_STARTING,
  };
  let saveTimer: unknown = null;
  let input: HTMLTextAreaElement | null = null;

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  const flush = () => {
    if (saveTimer !== null) {
      clearTimer(saveTimer);
      saveTimer = null;
    }
    if (unsaved.size === 0) return;
    const ids = [...unsaved];
    unsaved.clear();
    for (const threadId of ids) {
      const draft = drafts.get(threadId);
      if (draft) options.save(threadId, draft);
    }
  };

  const scheduleSave = () => {
    if (saveTimer !== null) clearTimer(saveTimer);
    saveTimer = setTimer(() => {
      saveTimer = null;
      flush();
    }, debounceMs);
  };

  const remember = (threadId: string, draft: ComposerDraft) => {
    drafts.set(threadId, draft);
    unsaved.add(threadId);
    if (!typed.has(threadId) && draftHasContent(draft)) {
      typed.add(threadId);
      options.onDraftTyped?.(threadId);
    }
  };

  const threadDraft = (threadId: string): ComposerDraft | undefined => {
    if (threadId === snapshot.key) return { text: snapshot.text, attachments: snapshot.attachments };
    return drafts.get(threadId) ?? options.load(threadId);
  };

  const setVisible = (text: string, attachments: FileAttachment[]) => {
    if (text === snapshot.text && attachments === snapshot.attachments) return;
    snapshot = { ...snapshot, text, attachments };
    if (snapshot.key) {
      remember(snapshot.key, { text, attachments });
      scheduleSave();
    }
    emit();
  };

  const controller: ComposerDraftController = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getDraft: () => ({ text: snapshot.text, attachments: snapshot.attachments }),
    hasActiveContent: () => !!snapshot.text.trim() || snapshot.attachments.length > 0,
    setText: (next) => {
      const text = typeof next === 'function' ? next(snapshot.text) : next;
      setVisible(text, snapshot.attachments);
    },
    setAttachments: (update) => {
      setVisible(snapshot.text, update(snapshot.attachments));
    },
    clear: () => {
      setVisible('', snapshot.attachments.length === 0 ? snapshot.attachments : EMPTY_ATTACHMENTS);
    },
    switchTo: (threadId) => {
      if (threadId === snapshot.key) return;
      // The previous thread's draft is final for now: write it before the
      // swap so a quit right after switching can't lose it.
      flush();
      const draft = threadId ? (drafts.get(threadId) ?? options.load(threadId)) : undefined;
      if (threadId && draft && !typed.has(threadId) && draftHasContent(draft)) typed.add(threadId);
      snapshot = {
        ...snapshot,
        key: threadId,
        text: draft?.text ?? '',
        attachments: draft?.attachments ?? EMPTY_ATTACHMENTS,
      };
      emit();
    },
    getThreadDraft: threadDraft,
    hasThreadDraft: (threadId) => draftHasContent(threadDraft(threadId)),
    updateThreadDraft: (threadId, update) => {
      if (threadId === snapshot.key) {
        const next = update({ text: snapshot.text, attachments: snapshot.attachments });
        setVisible(next.text, next.attachments);
        return;
      }
      const current = drafts.get(threadId) ?? options.load(threadId) ?? { text: '', attachments: [] };
      remember(threadId, update(current));
      flush();
    },
    setStarting: (threadId, starting) => {
      if (snapshot.starting.has(threadId) === starting) return;
      const next = new Set(snapshot.starting);
      if (starting) next.add(threadId);
      else next.delete(threadId);
      snapshot = { ...snapshot, starting: next };
      emit();
    },
    flush,
    setInput: (element) => {
      input = element;
    },
    getInput: () => input,
    focus: (caret) => {
      const element = input;
      if (!element) return;
      element.focus();
      if (caret !== undefined) element.setSelectionRange(caret, caret);
    },
    dispose: () => {
      flush();
      listeners.clear();
    },
  };
  return controller;
};
