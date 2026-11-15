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
import { useThemeMotion } from './motionPolicy';
import { useVideoPoster } from './videoPoster';

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

/** A playing backdrop video, frozen on its current frame while `paused`. */
const BackdropVideo: React.FC<React.VideoHTMLAttributes<HTMLVideoElement> & { paused: boolean }> = ({ paused, ...props }) => {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (paused) video.pause();
    else void video.play().catch(() => {});
  }, [paused, props.src]);
  return <video ref={ref} {...props} autoPlay={!paused} />;
};

/** One look of the backdrop (the base or a variant), with its veil. */
const BackdropLook: React.FC<{
  theme: UiTheme;
  backdrop: ThemeBackdrop;
  snapshot: ThemeSnapshot | null;
  animate: boolean;
  /** Freeze moving looks where they are (motionPolicy.ts). */
  paused: boolean;
  entering: boolean;
}> = ({ theme, backdrop, snapshot, animate, paused, entering }) => {
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
      <BackdropVideo
        key={backdrop.asset}
        paused={paused}
        className="theme-backdrop-fill"
        src={themeAssetUrl(snapshot, theme, backdrop.asset)}
        poster={poster || undefined}
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
        <ThemeSceneFrame theme={theme} html={backdrop.html} role="backdrop" animate={animate} paused={paused} />
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

const Backdrop: React.FC<{ theme: UiTheme; animate: boolean; paused: boolean }> = ({ theme, animate, paused }) => {
  const snapshot = useThemeState((state) => state.snapshot);
  useVideoPoster(theme);
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
        <BackdropLook key={`leaving:${leaving.key}`} theme={theme} backdrop={leaving.backdrop} snapshot={snapshot} animate={animate} paused={paused} entering={false} />
      ) : null}
      <BackdropLook key={key} theme={theme} backdrop={backdrop} snapshot={snapshot} animate={animate} paused={paused} entering={Boolean(leaving)} />
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

/**
 * Static frost: a live backdrop-filter under an animated overlay re-blurs
 * every panel on every frame (the overlay damages the whole window), which
 * roughly doubled the GPU time of an image theme with falling snow. For an
 * image backdrop, a small copy of the picture (main.js themes:frost), drawn
 * fixed behind each panel and smoothed by the browser's upscale, looks the
 * same and is painted once. Video and HTML backdrops change, so they keep the
 * live blur.
 */
const FROST_PANELS = /\.(sidebar|app-shellbar|composer-shell|settings-panel|settings-sidebar|thread-pane-header)\b/;

/** Theme CSS that paints a panel's background itself: static frost would replace it, so keep the live blur. */
const themeStylesPanels = (css: string | undefined) => {
  if (!css) return false;
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (FROST_PANELS.test(match[1]) && /(^|[;\s])background(-color|-image)?\s*:/i.test(match[2])) return true;
  }
  return false;
};

/** Window width, re-read after resizes settle. */
const useWindowWidth = (enabled: boolean) => {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth));
  useEffect(() => {
    if (!enabled) return undefined;
    let timer = 0;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setWidth(window.innerWidth), 250);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, [enabled]);
  return width;
};

const useStaticFrost = (theme: UiTheme | null, animate: boolean) => {
  // The picture on screen: a backdrop variant the theme's values pick, if any.
  const values = useThemeValues(theme?.id);
  const backdrop = useMemo(() => (theme?.backdrop ? effectiveBackdrop(theme.backdrop, values) : null), [theme?.backdrop, values]);
  const panelBlur = theme?.panelBlur ?? 0;
  const wanted = Boolean(
    theme &&
      animate &&
      theme.overlay?.html &&
      backdrop?.type === 'image' &&
      backdrop.asset &&
      // contain leaves bands the copy cannot line up with.
      (backdrop.fit ?? 'cover') === 'cover' &&
      panelBlur > 0 &&
      !themeStylesPanels(theme.css)
  );
  const viewport = useWindowWidth(wanted);
  // Box-downscale plus the smooth upscale blur by about 0.6 of the scale step.
  const sigma = wanted ? Math.hypot(panelBlur, backdrop?.blur ?? 0) : 0;
  const width = wanted ? Math.max(16, Math.min(320, Math.round(viewport / (sigma * 1.7) / 8) * 8 || 16)) : 0;
  // The live blur also saturates (index.css saturate(1.15)) on top of the backdrop's own saturate.
  const saturate = Math.round((backdrop?.saturate ?? 1) * 1.15 * 100) / 100;
  const key = wanted && theme && backdrop?.asset ? `${theme.id}:${backdrop.asset}:${width}:${saturate}` : '';
  const [frost, setFrost] = useState<{ key: string; asset: string } | null>(null);
  useEffect(() => {
    if (!key || !theme || !backdrop?.asset) return undefined;
    let cancelled = false;
    void window.orion?.themes
      ?.frost(theme.id, backdrop.asset, width, saturate)
      .then((result) => {
        if (!cancelled && result.ok && result.value) setFrost({ key, asset: result.value });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // key covers the theme, asset, size and saturation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return frost && frost.key === key ? { asset: frost.asset, backdrop } : null;
};

/** One background layer for a panel tint (a color, a gradient or none); null if it is not a valid layer. */
const tintLayer = (value: string) => {
  const trimmed = value.trim();
  const layer =
    !trimmed || trimmed === 'none' || trimmed === 'transparent'
      ? 'linear-gradient(transparent, transparent)'
      : /gradient\(/i.test(trimmed)
        ? trimmed
        : `linear-gradient(${trimmed}, ${trimmed})`;
  return typeof CSS !== 'undefined' && CSS.supports('background-image', layer) ? layer : null;
};

/**
 * CSS variables the html.theme-static-frost rules in index.css paint panels
 * with, or null when a panel tint cannot become a layer (keep the live blur).
 */
const frostCss = (url: string, backdrop: ThemeBackdrop | null) => {
  const style = getComputedStyle(document.documentElement);
  const raised = tintLayer(style.getPropertyValue('--bg-raised'));
  const shell = tintLayer(style.getPropertyValue('--shell-bg'));
  const settings = tintLayer(style.getPropertyValue('--settings-sidebar-bg'));
  if (!raised || !shell || !settings) return null;
  const position = backdrop?.position ?? 'center';
  if (typeof CSS !== 'undefined' && !CSS.supports('background-position', position)) return null;
  return `:root {
  --theme-frost: url("${url}");
  --theme-frost-dim: rgb(0 0 0 / ${Math.round((backdrop?.dim ?? 0) * 100)}%);
  --theme-frost-position: ${position};
  --theme-frost-raised: ${raised};
  --theme-frost-shell: ${shell};
  --theme-frost-settings: ${settings};
}`;
};

const ThemeLayer: React.FC = () => {
  const theme = useActiveTheme();
  const snapshot = useThemeState((state) => state.snapshot);
  const animateSetting = useThemeState((state) => state.animate);
  // The switch, reduced motion, and whether anyone is looking (motionPolicy.ts).
  const moving = Boolean(
    theme &&
      (theme.overlay ||
        [theme.backdrop, ...(theme.backdrop?.variants ?? [])].some((look) => look?.type === 'video' || look?.type === 'html'))
  );
  const motion = useThemeMotion(animateSetting, moving);
  const animate = motion.animate;

  useEffect(() => {
    startThemeSync();
    // An agent pressed Preview celebration (manage_app_themes).
    return window.orion?.themes?.onCelebrate?.(() => previewThemeCelebration());
  }, []);

  const frostLayer = useStaticFrost(theme, animate);
  const frostAsset = frostLayer?.asset ?? null;
  const frostBackdrop = frostLayer?.backdrop ?? null;

  const css = useMemo(
    () => (theme ? themeToCss(theme, { assetUrl: (name) => themeAssetUrl(snapshot, theme, name) }) : ''),
    [theme, snapshot]
  );

  useEffect(() => {
    const root = document.documentElement;
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    let frost: string | null = null;
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
      // After the tokens are in, so the tints read the theme's values.
      frost = theme && frostAsset ? frostCss(themeAssetUrl(snapshot, theme, frostAsset), frostBackdrop) : null;
      if (frost) style.textContent = `${css}\n\n${frost}`;
    }
    root.classList.toggle('durango-themed', Boolean(theme));
    root.classList.toggle('has-theme-backdrop', Boolean(theme?.backdrop));
    root.classList.toggle('theme-light', theme?.appearance === 'light');
    const staticFrost = Boolean(frost);
    root.classList.toggle('theme-static-frost', staticFrost);
    root.classList.toggle('theme-panel-blur', !staticFrost && (theme?.panelBlur ?? 0) > 0);
    if (theme) root.dataset.theme = theme.id;
    else delete root.dataset.theme;
  }, [css, theme, frostAsset, frostBackdrop, snapshot]);

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
          {theme.backdrop ? <Backdrop key={`${theme.id}-backdrop`} theme={theme} animate={animate} paused={motion.paused} /> : null}
          {theme.overlay?.html && animate ? (
            <div className="theme-overlay" aria-hidden="true">
              <ThemeSceneFrame
                key={`${theme.id}-overlay`}
                theme={theme}
                html={theme.overlay.html}
                role="overlay"
                animate={animate}
                paused={motion.paused}
              />
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
