import { create } from 'zustand';
import type { ThemeSnapshot, UiTheme } from '../../ui-themes.js';

/**
 * The renderer's copy of the theme store (src/main/ui-themes-store.js): the
 * main process owns themes (agents change them from tool calls), and
 * broadcasts every change; this mirrors the latest snapshot.
 */
type ThemeState = {
  snapshot: ThemeSnapshot | null;
  /** Whether scenes animate (Settings → Customizations; local to this window). */
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
