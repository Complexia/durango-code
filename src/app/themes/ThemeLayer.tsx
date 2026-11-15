import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOrionStore } from '../../store';
import {
  effectiveBackdrop,
  isValueName,
  themeToCss,
  themeValueSpec,
  themeValueAttribute,
  themeValuesCss,
  type ThemeBackdrop,
  type ThemeSnapshot,
  type UiTheme,
} from '../../ui-themes.js';
import { ThemeSceneFrame, runningThreadIds } from './ThemeSceneFrame';
import {
  broadcastScene,
  startThemeSync,
  themeAssetUrl,
  useActiveTheme,
  useThemeState,
  useThemeValues,
} from './themeState';

/**
 * Applies the active theme (Settings → Themes) to the whole window:
 * a <style> with its tokens and CSS, a backdrop layer behind the app, an
 * optional overlay scene above it with pointer events off, and the theme's
 * own controls (ThemeControls). Stock = nothing here at all. HTML scenes run
 * in sandboxed frames with no network (ThemeSceneFrame). The theme's values
 * are reflected as `data-tv-<name>` on <html> and `--tv-<name>` custom
 * properties, so its CSS can follow them, and pick the backdrop variant.
 */

// Loaded only for a theme with controls (it brings the Lucide icon index).
const ThemeControls = lazy(() => import('./ThemeControls'));

const STYLE_ID = 'durango-theme-style';
const VALUES_STYLE_ID = 'durango-theme-values';
const BACKDROP_FADE_MS = 700;

/** Settings' "Preview celebration" button. */
export const previewThemeCelebration = () => broadcastScene({ event: 'celebrate', detail: {} });

/** Turn starts/ends, the pointer, focus and typing → every scene frame. */
const useSceneEvents = (enabled: boolean) => {
  useEffect(() => {
    if (!enabled) return undefined;
    const statuses = new Map(useOrionStore.getState().threads.map((thread) => [thread.id, thread.status]));
    let runningCount = runningThreadIds().length;
    const unsubscribe = useOrionStore.subscribe((state, previous) => {
      if (state.threads === previous.threads) return;
      let changed = false;
      for (const thread of state.threads) {
        const before = statuses.get(thread.id);
        if (before === thread.status) continue;
        statuses.set(thread.id, thread.status);
        if (thread.status === 'running') {
          broadcastScene({ event: 'turn-start', detail: { threadId: thread.id } });
          changed = true;
        } else if (before === 'running') {
          // Stop leaves the thread idle with its last run marked stopped:
          // only a run that finished celebrates.
          const runStatus = thread.summary?.lastAgentRun?.status;
          const status =
            thread.status === 'error' || runStatus === 'error'
              ? 'error'
              : thread.status === 'done' && runStatus !== 'stopped'
                ? 'done'
                : 'stopped';
          broadcastScene({ event: 'turn-end', detail: { threadId: thread.id, status } });
          changed = true;
        }
      }
      if (!changed) return;
      const count = runningThreadIds().length;
      if ((count > 0) !== (runningCount > 0) || count !== runningCount) {
        runningCount = count;
        broadcastScene({ event: 'working', detail: { working: count > 0, count } });
      }
    });
    let frame = 0;
    let pointer = { x: 0.5, y: 0.5 };
    const onPointer = (event: PointerEvent) => {
      pointer = { x: event.clientX / Math.max(1, window.innerWidth), y: event.clientY / Math.max(1, window.innerHeight) };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        broadcastScene({ event: 'pointer', detail: pointer });
      });
    };
    const onFocus = () => broadcastScene({ event: 'focus', detail: { focused: true } });
    const onBlur = () => broadcastScene({ event: 'focus', detail: { focused: false } });
    let lastTyping = 0;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.('.composer-shell')) return;
      const now = Date.now();
      if (now - lastTyping < 120) return;
      lastTyping = now;
      broadcastScene({ event: 'typing', detail: {} });
    };
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKey, true);
    return () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [enabled]);
};

/** One look of the backdrop (the base or a variant), with its veil. */
const BackdropLook: React.FC<{ theme: UiTheme; backdrop: ThemeBackdrop; snapshot: ThemeSnapshot | null; animate: boolean; entering: boolean }> = ({
  theme,
  backdrop,
  snapshot,
  animate,
  entering,
}) => {
  const filters = [
    backdrop.blur ? `blur(${backdrop.blur}px)` : '',
    backdrop.saturate !== undefined && backdrop.saturate !== 1 ? `saturate(${backdrop.saturate})` : '',
  ]
    .filter(Boolean)
    .join(' ');
  // Blur bleeds transparent edges in; overscan hides them.
  const overscan = backdrop.blur ? Math.ceil(backdrop.blur * 2) : 0;
  const fillStyle: React.CSSProperties = {
    filter: filters || undefined,
    ...(overscan
      ? { top: -overscan, left: -overscan, width: `calc(100% + ${overscan * 2}px)`, height: `calc(100% + ${overscan * 2}px)` }
      : {}),
  };
  const mediaStyle: React.CSSProperties = {
    ...fillStyle,
    objectFit: backdrop.fit ?? 'cover',
    objectPosition: backdrop.position ?? 'center',
  };
  const poster = backdrop.poster ? themeAssetUrl(snapshot, theme, backdrop.poster) : '';
  let content: React.ReactNode = null;
  if (backdrop.type === 'css') {
    // A variant's css is inline: the stylesheet only carries the base one.
    content = <div className="theme-backdrop-fill theme-backdrop-css" style={{ ...fillStyle, background: backdrop.css }} />;
  } else if (backdrop.type === 'image' && backdrop.asset) {
    content = <img className="theme-backdrop-fill" src={themeAssetUrl(snapshot, theme, backdrop.asset)} alt="" draggable={false} style={mediaStyle} />;
  } else if (backdrop.type === 'video' && backdrop.asset) {
    content = animate ? (
      <video
        key={backdrop.asset}
        className="theme-backdrop-fill"
        src={themeAssetUrl(snapshot, theme, backdrop.asset)}
        poster={poster || undefined}
        autoPlay
        muted
        loop
        playsInline
        disablePictureInPicture
        style={mediaStyle}
      />
    ) : poster ? (
      <img className="theme-backdrop-fill" src={poster} alt="" draggable={false} style={mediaStyle} />
    ) : (
      <video
        key={`${backdrop.asset}-still`}
        className="theme-backdrop-fill"
        src={`${themeAssetUrl(snapshot, theme, backdrop.asset)}#t=0.1`}
        muted
        playsInline
        preload="metadata"
        style={mediaStyle}
      />
    );
  } else if (backdrop.type === 'html' && backdrop.html) {
    content = (
      <div className="theme-backdrop-fill" style={fillStyle}>
        <ThemeSceneFrame theme={theme} html={backdrop.html} role="backdrop" />
      </div>
    );
  }
  return (
    <div className={`theme-backdrop-look${entering ? ' entering' : ''}`}>
      {content}
      {backdrop.dim ? <div className="theme-backdrop-dim" style={{ opacity: backdrop.dim }} /> : null}
    </div>
  );
};

/** What makes two looks different pictures (a crossfade), not just a different veil. */
const lookKey = (backdrop: ThemeBackdrop) =>
  `${backdrop.type}:${backdrop.asset ?? ''}:${backdrop.type === 'css' ? backdrop.css : ''}:${backdrop.type === 'html' ? backdrop.html?.length : ''}`;

const Backdrop: React.FC<{ theme: UiTheme; animate: boolean }> = ({ theme, animate }) => {
  const snapshot = useThemeState((state) => state.snapshot);
  const values = useThemeValues(theme.id);
  const backdrop = useMemo(() => effectiveBackdrop(theme.backdrop, values), [theme.backdrop, values]);
  const key = backdrop ? lookKey(backdrop) : '';
  // The look before a switch stays underneath while the new one fades in
  // (derived during render, so the new look's first frame already fades).
  const [fade, setFade] = useState<{ key: string; backdrop: ThemeBackdrop | null; leaving: { key: string; backdrop: ThemeBackdrop } | null }>({
    key,
    backdrop,
    leaving: null,
  });
  if (fade.key !== key) {
    setFade({ key, backdrop, leaving: fade.backdrop && backdrop && animate ? { key: fade.key, backdrop: fade.backdrop } : null });
  } else if (fade.backdrop !== backdrop) {
    setFade({ ...fade, backdrop });
  }
  const leaving = fade.key === key ? fade.leaving : null;
  useEffect(() => {
    if (!leaving) return undefined;
    const timer = setTimeout(() => setFade((current) => (current.leaving === leaving ? { ...current, leaving: null } : current)), BACKDROP_FADE_MS);
    return () => clearTimeout(timer);
  }, [leaving]);
  if (!backdrop) return null;
  return (
    <div className="theme-backdrop" aria-hidden="true">
      {leaving ? (
        <BackdropLook key={`leaving:${leaving.key}`} theme={theme} backdrop={leaving.backdrop} snapshot={snapshot} animate={animate} entering={false} />
      ) : null}
      <BackdropLook key={key} theme={theme} backdrop={backdrop} snapshot={snapshot} animate={animate} entering={Boolean(leaving)} />
    </div>
  );
};

/** `data-tv-<name>` on <html> and the --tv-<name> stylesheet, for the active theme's values. */
const useValueHooks = (theme: UiTheme | null) => {
  const values = useThemeValues(theme?.id);
  const applied = useRef<string[]>([]);
  useEffect(() => {
    const root = document.documentElement;
    const names = theme?.values ? Object.keys(values).filter((name) => isValueName(name) && themeValueSpec(theme, name)) : [];
    // The literal attribute name: dataset would fold "snow-3d" into data-tv-snow3d.
    for (const name of applied.current) if (!names.includes(name)) root.removeAttribute(`data-tv-${name}`);
    for (const name of names) root.setAttribute(`data-tv-${name}`, themeValueAttribute(values[name]));
    applied.current = names;
    let style = document.getElementById(VALUES_STYLE_ID) as HTMLStyleElement | null;
    const css = names.length ? themeValuesCss(Object.fromEntries(names.map((name) => [name, values[name]]))) : '';
    if (!css) style?.remove();
    else {
      if (!style) {
        style = document.createElement('style');
        style.id = VALUES_STYLE_ID;
        document.head.appendChild(style);
      }
      style.textContent = css;
    }
  }, [theme, values]);
};


const ThemeLayer: React.FC = () => {
  const theme = useActiveTheme();
  const snapshot = useThemeState((state) => state.snapshot);
  const animate = useThemeState((state) => state.animate);

  useEffect(() => {
    startThemeSync();
  }, []);

  const css = useMemo(
    () => (theme ? themeToCss(theme, { assetUrl: (name) => themeAssetUrl(snapshot, theme, name) }) : ''),
    [theme, snapshot]
  );

  useEffect(() => {
    const root = document.documentElement;
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!css) {
      style?.remove();
    } else {
      if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        // Last in <head>, so it wins over the app's own rules of equal weight.
        document.head.appendChild(style);
      }
      // textContent, never innerHTML: the theme's CSS cannot become markup.
      style.textContent = css;
    }
    root.classList.toggle('durango-themed', Boolean(theme));
    root.classList.toggle('has-theme-backdrop', Boolean(theme?.backdrop));
    root.classList.toggle('theme-light', theme?.appearance === 'light');
    root.classList.toggle('theme-panel-blur', (theme?.panelBlur ?? 0) > 0);
    if (theme) root.dataset.theme = theme.id;
    else delete root.dataset.theme;
  }, [css, theme]);

  useValueHooks(theme);

  const hasScene = Boolean(
    theme && (theme.backdrop?.type === 'html' || theme.backdrop?.variants?.some((variant) => variant.type === 'html') || theme.overlay || theme.controls?.some((control) => control.kind === 'html'))
  );
  useSceneEvents(hasScene);

  if (!theme) return null;
  return (
    <>
      {createPortal(
        <>
          {theme.backdrop ? <Backdrop key={`${theme.id}-backdrop`} theme={theme} animate={animate} /> : null}
          {theme.overlay?.html && animate ? (
            <div className="theme-overlay" aria-hidden="true">
              <ThemeSceneFrame key={`${theme.id}-overlay`} theme={theme} html={theme.overlay.html} role="overlay" />
            </div>
          ) : null}
        </>,
        document.body
      )}
      {theme.controls?.length ? (
        <Suspense fallback={null}>
          <ThemeControls key={`${theme.id}-controls`} theme={theme} />
        </Suspense>
      ) : null}
    </>
  );
};

export default ThemeLayer;
