import React, { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useOrionStore } from '../../store';
import {
  THEME_SCENE_SOURCE,
  buildSceneDocument,
  parseSceneMessage,
  themeToCss,
  type UiTheme,
} from '../../ui-themes.js';
import { startThemeSync, themeAssetUrl, useActiveTheme, useThemeState } from './themeState';

/**
 * Applies the active theme (Settings → Customizations) to the whole window:
 * a <style> with its tokens and CSS, a backdrop layer behind the app, and an
 * optional overlay scene above it with pointer events off. Stock = nothing
 * here at all. HTML scenes run in sandboxed frames with no network
 * (ui-themes.js buildSceneDocument); the main window refuses any navigation
 * of an about:srcdoc frame (main.js guardVisualFrames). Scenes hear what the
 * app is doing (agents working, turns ending, the pointer) through messages.
 */

const STYLE_ID = 'durango-theme-style';
const SANDBOX = 'allow-scripts';

type SceneEvent = { event: string; detail?: Record<string, unknown> };
type SceneListener = (message: SceneEvent) => void;

const sceneListeners = new Set<SceneListener>();
const broadcastScene = (message: SceneEvent) => {
  for (const listener of sceneListeners) listener(message);
};

/** Settings' "Preview celebration" button. */
export const previewThemeCelebration = () => broadcastScene({ event: 'celebrate', detail: {} });

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

const SceneFrame: React.FC<{ theme: UiTheme; html: string; role: 'backdrop' | 'overlay'; animate: boolean }> = ({
  theme,
  html,
  role,
  animate,
}) => {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const srcDoc = useMemo(() => buildSceneDocument(html), [html]);
  const themeId = theme.id;
  const appearance = theme.appearance;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const post = (message: SceneEvent) => {
      try {
        frame.contentWindow?.postMessage({ source: THEME_SCENE_SOURCE, type: 'event', ...message }, '*');
      } catch {}
    };
    const sendState = () => {
      const running = runningThreadIds();
      post({
        event: 'state',
        detail: {
          working: running.length > 0,
          count: running.length,
          focused: document.hasFocus(),
          reducedMotion: !animate || prefersReducedMotion(),
          appearance,
        },
      });
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const message = parseSceneMessage(event.data);
      if (!message) return;
      if (message.type === 'ready') sendState();
      else window.orion?.themes?.reportSceneError(themeId, `${role}: ${message.message}`);
    };
    window.addEventListener('message', onMessage);
    sceneListeners.add(post);
    sendState();
    return () => {
      window.removeEventListener('message', onMessage);
      sceneListeners.delete(post);
    };
  }, [themeId, role, animate, appearance, srcDoc]);

  return (
    <iframe
      ref={frameRef}
      className={`theme-scene theme-scene-${role}`}
      title={`${theme.name} ${role}`}
      sandbox={SANDBOX}
      srcDoc={srcDoc}
      tabIndex={-1}
      aria-hidden="true"
    />
  );
};

const runningThreadIds = () =>
  useOrionStore
    .getState()
    .threads.filter((thread) => thread.status === 'running')
    .map((thread) => thread.id);

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

const Backdrop: React.FC<{ theme: UiTheme; animate: boolean }> = ({ theme, animate }) => {
  const snapshot = useThemeState((state) => state.snapshot);
  const backdrop = theme.backdrop;
  if (!backdrop) return null;
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
    content = <div className="theme-backdrop-fill theme-backdrop-css" style={fillStyle} />;
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
        <SceneFrame theme={theme} html={backdrop.html} role="backdrop" animate={animate} />
      </div>
    );
  }
  return (
    <div className="theme-backdrop" aria-hidden="true">
      {content}
      {backdrop.dim ? <div className="theme-backdrop-dim" style={{ opacity: backdrop.dim }} /> : null}
    </div>
  );
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

  const hasScene = Boolean(theme && (theme.backdrop?.type === 'html' || theme.overlay));
  useSceneEvents(hasScene);

  if (!theme) return null;
  return createPortal(
    <>
      {theme.backdrop ? <Backdrop key={`${theme.id}-backdrop`} theme={theme} animate={animate} /> : null}
      {theme.overlay?.html && animate ? (
        <div className="theme-overlay" aria-hidden="true">
          <SceneFrame key={`${theme.id}-overlay`} theme={theme} html={theme.overlay.html} role="overlay" animate={animate} />
        </div>
      ) : null}
    </>,
    document.body
  );
};

export default ThemeLayer;
