import { useEffect, useState } from 'react';
import { create } from 'zustand';

/**
 * When a theme's moving parts (video backdrops, HTML scenes) play, in one
 * place:
 *
 * - **still**: the "Animated backdrops and effects" switch is off, or the OS
 *   asks for reduced motion. Videos show their poster, overlays go away, and
 *   HTML backdrops are told `reducedMotion` and then frozen.
 * - **paused**: frozen where they are. The window is hidden (minimized, another
 *   Space), or Durango Code has not been the focused app for
 *   INACTIVE_FREEZE_MS, unless "Keep animating in the background" is on.
 *
 * Unfocused counts the app window, not the page: a built-in browser tab taking
 * focus is still using the app (main.js sends the window's own focus). A
 * window fully covered by another app's window is not reliably reported as
 * hidden on macOS, but the other app then has focus, so it pauses too.
 */
export const INACTIVE_FREEZE_MS = 12_000;

const BACKGROUND_KEY = 'durango.themes.animateInBackground';

const readBackground = () => {
  try {
    return window.localStorage.getItem(BACKGROUND_KEY) === 'on';
  } catch {
    return false;
  }
};

type MotionSettings = {
  /** Settings → Customizations → Keep animating in the background. */
  animateInBackground: boolean;
  setAnimateInBackground: (on: boolean) => void;
};

export const useMotionSettings = create<MotionSettings>((set) => ({
  animateInBackground: typeof window === 'undefined' ? false : readBackground(),
  setAnimateInBackground: (on) => {
    try {
      window.localStorage.setItem(BACKGROUND_KEY, on ? 'on' : 'off');
    } catch {}
    set({ animateInBackground: on });
  },
}));

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.(REDUCED_MOTION_QUERY).matches === true;

/** The OS reduced-motion setting, following changes. */
const useReducedMotion = (enabled: boolean) => {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (!enabled || !window.matchMedia) return undefined;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [enabled]);
  return reduced;
};

/** True once the app has been hidden, or unfocused for INACTIVE_FREEZE_MS. */
const useAway = (enabled: boolean) => {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  const [inactive, setInactive] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setInactive(false);
      return undefined;
    }
    let timer = 0;
    let disposed = false;
    // A focus event that arrives before the first query answers is newer.
    let heard = false;
    const onFocusChange = (focused: boolean) => {
      window.clearTimeout(timer);
      timer = 0;
      if (focused) setInactive(false);
      else timer = window.setTimeout(() => setInactive(true), INACTIVE_FREEZE_MS);
    };
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
    let unsubscribe: (() => void) | undefined;
    const orion = window.orion;
    if (orion?.onWindowFocusChange && orion.isWindowFocused) {
      unsubscribe = orion.onWindowFocusChange((focused) => {
        heard = true;
        onFocusChange(focused);
      });
      void orion
        .isWindowFocused()
        .then((focused) => {
          if (!disposed && !heard) onFocusChange(focused);
        })
        .catch(() => {});
    } else {
      // Outside Electron (tests, web preview): the page's own focus.
      const onFocus = () => onFocusChange(true);
      const onBlur = () => onFocusChange(false);
      window.addEventListener('focus', onFocus);
      window.addEventListener('blur', onBlur);
      onFocusChange(document.hasFocus());
      unsubscribe = () => {
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('blur', onBlur);
      };
    }
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe?.();
    };
  }, [enabled]);
  return { hidden, inactive };
};

export type ThemeMotion = {
  /** Moving parts may play: the switch is on and reduced motion is off. */
  animate: boolean;
  /** Freeze what is showing (still, hidden, or away for a while). */
  paused: boolean;
};

/**
 * `animate`: the "Animated backdrops and effects" switch. `enabled`: the theme
 * has anything that moves (no listeners otherwise).
 */
export const useThemeMotion = (animate: boolean, enabled: boolean): ThemeMotion => {
  const reduced = useReducedMotion(enabled);
  const { hidden, inactive } = useAway(enabled);
  const animateInBackground = useMotionSettings((state) => state.animateInBackground);
  const moving = animate && !reduced;
  return {
    animate: moving,
    paused: !moving || hidden || (inactive && !animateInBackground),
  };
};
