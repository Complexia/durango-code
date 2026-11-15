import { create } from 'zustand';
import { coerceThemeValue, themeValueSpec, type ThemeSnapshot, type ThemeValue, type UiTheme } from '../../ui-themes.js';

/**
 * The renderer's copy of the theme store (src/main/ui-themes-store.js): the
 * main process owns themes (agents change them from tool calls), and
 * broadcasts every change; this mirrors the latest snapshot.
 */
type ThemeState = {
  snapshot: ThemeSnapshot | null;
  /** Values changed here and not yet confirmed by the store, by theme id. */
  pendingValues: Record<string, Record<string, ThemeValue>>;
  /** Whether scenes animate (Settings → Themes; local to this window). */
  animate: boolean;
  setAnimate: (animate: boolean) => void;
};

const ANIMATE_KEY = 'durango.themes.animate';

const readAnimate = () => {
  try {
    return window.localStorage.getItem(ANIMATE_KEY) !== 'off';
  } catch {
    return true;
  }
};

export const useThemeState = create<ThemeState>((set) => ({
  snapshot: null,
  pendingValues: {},
  animate: typeof window === 'undefined' ? true : readAnimate(),
  setAnimate: (animate) => {
    try {
      window.localStorage.setItem(ANIMATE_KEY, animate ? 'on' : 'off');
    } catch {}
    set({ animate });
  },
}));

let started = false;

/** Load the themes once and follow changes (ThemeLayer calls it at startup). */
export const startThemeSync = () => {
  if (started || typeof window === 'undefined' || !window.orion?.themes) return;
  started = true;
  window.orion.themes.onChanged((snapshot) => useThemeState.setState({ snapshot }));
  void window.orion.themes.list().then((result) => {
    if (result.ok) useThemeState.setState({ snapshot: result.value });
  });
};

export const useActiveTheme = (): UiTheme | null =>
  useThemeState((state) => {
    const snapshot = state.snapshot;
    if (!snapshot?.activeId) return null;
    return snapshot.themes.find((theme) => theme.id === snapshot.activeId) ?? null;
  });

export const useThemeById = (id: string | null | undefined): UiTheme | null =>
  useThemeState((state) => (id ? state.snapshot?.themes.find((theme) => theme.id === id) ?? null : null));

/** A URL the renderer can load for one of a theme's files. */
export const themeAssetUrl = (snapshot: ThemeSnapshot | null, theme: UiTheme, asset: string) => {
  if (!snapshot?.dir || theme.builtIn) return '';
  const separator = snapshot.dir.includes('\\') ? '\\' : '/';
  const filePath = [snapshot.dir, theme.id, asset].join(separator);
  return `orion-attachment://local/media?path=${encodeURIComponent(filePath)}&rev=${theme.revision}`;
};

/** Run a theme action; returns the error text, if any (callers toast it). */
export const runThemeAction = async <T,>(
  action: (api: NonNullable<Window['orion']['themes']>) => Promise<{ ok: true; value: T } | { ok: false; error: string }>
): Promise<string | null> => {
  const api = window.orion?.themes;
  if (!api) return 'Themes are not available in this build.';
  try {
    const result = await action(api);
    return result.ok ? null : result.error;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

// --- values and actions -------------------------------------------------------------

const EMPTY_VALUES: Record<string, ThemeValue> = Object.freeze({}) as Record<string, ThemeValue>;
const valuesCache = new Map<string, { stored: unknown; pending: unknown; merged: Record<string, ThemeValue> }>();

/** A theme's current values (store + changes on their way), stable between renders. */
export const useThemeValues = (themeId: string | null | undefined): Record<string, ThemeValue> =>
  useThemeState((state) => {
    if (!themeId) return EMPTY_VALUES;
    const stored = state.snapshot?.values?.[themeId];
    const pending = state.pendingValues[themeId];
    const cached = valuesCache.get(themeId);
    if (cached && cached.stored === stored && cached.pending === pending) return cached.merged;
    const merged = stored || pending ? { ...(stored ?? {}), ...(pending ?? {}) } : EMPTY_VALUES;
    valuesCache.set(themeId, { stored, pending, merged });
    return merged;
  });

const SAVE_DELAY_MS = 160;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const unsaved = new Map<string, Record<string, ThemeValue>>();

/**
 * Change some of the active theme's values from a control or a scene: shown at
 * once, saved to the store shortly after (a slider drag is one write).
 */
export const setThemeValues = (theme: UiTheme, patch: Record<string, unknown>) => {
  const clean: Record<string, ThemeValue> = {};
  for (const [name, value] of Object.entries(patch)) {
    const next = coerceThemeValue(themeValueSpec(theme, name), value);
    if (next !== undefined) clean[name] = next;
  }
  if (!Object.keys(clean).length) return;
  useThemeState.setState((state) => ({
    pendingValues: { ...state.pendingValues, [theme.id]: { ...(state.pendingValues[theme.id] ?? {}), ...clean } },
  }));
  unsaved.set(theme.id, { ...(unsaved.get(theme.id) ?? {}), ...clean });
  const existing = saveTimers.get(theme.id);
  if (existing) clearTimeout(existing);
  saveTimers.set(
    theme.id,
    setTimeout(() => {
      saveTimers.delete(theme.id);
      const values = unsaved.get(theme.id);
      unsaved.delete(theme.id);
      if (!values) return;
      const api = window.orion?.themes;
      if (!api?.setValues) return;
      void api
        .setValues(theme.id, values)
        .catch(() => null)
        .finally(() => {
          // The store's broadcast came first: drop only what this save sent
          // and nothing changed since (a later save may still be on its way).
          useThemeState.setState((state) => {
            const pending = state.pendingValues[theme.id];
            if (!pending) return {};
            const rest = { ...pending };
            for (const [name, value] of Object.entries(values)) if (rest[name] === value) delete rest[name];
            const next = { ...state.pendingValues };
            if (Object.keys(rest).length) next[theme.id] = rest;
            else delete next[theme.id];
            return { pendingValues: next };
          });
        });
    }, SAVE_DELAY_MS)
  );
};

export type SceneEvent = { event: string; detail?: Record<string, unknown> };
type SceneListener = (message: SceneEvent) => void;
const sceneListeners = new Set<SceneListener>();

/** Every scene and HTML widget frame listens here. */
export const addSceneListener = (listener: SceneListener) => {
  sceneListeners.add(listener);
  return () => {
    sceneListeners.delete(listener);
  };
};

export const broadcastScene = (message: SceneEvent) => {
  for (const listener of sceneListeners) listener(message);
};

/** A theme button or a scene's durango.action(): tell every scene and widget. */
export const fireThemeAction = (name: string, detail: unknown = null) =>
  broadcastScene({ event: 'action', detail: { name, detail } });

/** The theme's colors as the app resolves them, for HTML widgets to match. */
export const themeColors = () => {
  const style = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const name of ['accent', 'on-accent', 'text-primary', 'text-secondary', 'text-muted', 'bg-surface', 'bg-elevated', 'bg-hover', 'border-default', 'border-strong', 'font-ui']) {
    const value = style.getPropertyValue(`--${name}`).trim();
    if (value) out[name] = value;
  }
  return out;
};

/** Every value of a theme back to its default (Settings → Themes → Reset). */
export const resetThemeValues = async (theme: UiTheme): Promise<string | null> => {
  const timer = saveTimers.get(theme.id);
  if (timer) clearTimeout(timer);
  saveTimers.delete(theme.id);
  unsaved.delete(theme.id);
  useThemeState.setState((state) => {
    const next = { ...state.pendingValues };
    delete next[theme.id];
    return { pendingValues: next };
  });
  return runThemeAction((api) => api.resetValues(theme.id));
};
