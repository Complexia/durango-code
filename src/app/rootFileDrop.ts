import { useSyncExternalStore } from 'react';

export type RootFileDropTarget = 'thread' | 'bot' | 'none';

export type RootFileDropContext = {
  settingsOpen: boolean;
  activeTab: 'agents' | 'code';
  botsTabOpen: boolean;
  sidebarV3View: 'bot' | 'thread' | 'projects' | 'project';
  hasModalOpen: boolean;
  canAttachToThread: boolean;
  hasBotDropHandler: boolean;
};

export type BotFileDropHandler = {
  /** Display name of the open bot, shown in the whole-view drop overlay. */
  botName: string;
  /** Stages and attaches dropped files using the open bot composer's path. */
  onDrop: (files: FileList | File[]) => void | Promise<void>;
};

let botFileDropHandler: BotFileDropHandler | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

/**
 * Registers the mounted bot composer as the active Bots-view file drop target.
 * Returns an unregister callback that only clears the slot if this registration
 * is still current (safe across rapid bot switches and StrictMode re-mounts).
 */
export const registerBotFileDropHandler = (handler: BotFileDropHandler): (() => void) => {
  botFileDropHandler = handler;
  emit();
  return () => {
    if (botFileDropHandler === handler) {
      botFileDropHandler = null;
      emit();
    }
  };
};

export const getBotFileDropHandler = (): BotFileDropHandler | null => botFileDropHandler;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useBotFileDropHandler = (): BotFileDropHandler | null =>
  useSyncExternalStore(subscribe, getBotFileDropHandler, () => null);

/** True when a drag event carries external files. */
export const hasFileDrag = (dataTransfer: Pick<DataTransfer, 'types'> | null | undefined): boolean =>
  Boolean(dataTransfer && Array.from(dataTransfer.types ?? []).includes('Files'));

const MODAL_DIALOG_SELECTOR = '[aria-modal="true"], dialog[open]';

/** True when a blocking modal dialog covers the current view. */
export const hasOpenModalDialog = (root?: ParentNode | null): boolean => {
  const container = root ?? (typeof document !== 'undefined' ? document : null);
  if (!container || typeof container.querySelector !== 'function') return false;
  if (container.querySelector(MODAL_DIALOG_SELECTOR)) return true;
  try {
    return Boolean(container.querySelector(':modal'));
  } catch {
    return false;
  }
};

/**
 * Decides which visible view owns an app-root file drop.
 *
 * A drop must only land in the composer that is actually on screen:
 * - Settings, Code, Projects, Project pages, empty/loading states, and blocking
 *   modals ignore app-root file drops (specialized child zones such as the
 *   Project Library still handle their own drops via stopPropagation).
 * - The Bots conversation view routes drops anywhere in the window to the open
 *   bot's composer when one is mounted.
 * - Normal thread views (Threads tab, or a thread opened from the Bots tab)
 *   route drops to the visible focused thread when its composer can attach files.
 */
export const resolveRootFileDropTarget = (context: RootFileDropContext): RootFileDropTarget => {
  if (context.settingsOpen || context.hasModalOpen) return 'none';
  if (context.activeTab !== 'agents') return 'none';
  if (context.botsTabOpen) {
    if (context.sidebarV3View === 'thread') {
      return context.canAttachToThread ? 'thread' : 'none';
    }
    if (context.sidebarV3View === 'projects' || context.sidebarV3View === 'project') {
      return 'none';
    }
    return context.hasBotDropHandler ? 'bot' : 'none';
  }
  return context.canAttachToThread ? 'thread' : 'none';
};

export const rootFileDropOverlayLabel = (
  target: RootFileDropTarget,
  botName?: string | null
): string | null => {
  if (target === 'none') return null;
  if (target === 'bot') {
    const trimmed = botName?.trim();
    return trimmed ? `Drop files to attach to ${trimmed}` : 'Drop files to attach';
  }
  return 'Drop files to attach';
};
