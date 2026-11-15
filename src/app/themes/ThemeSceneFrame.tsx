import React, { useEffect, useMemo, useRef } from 'react';
import { useOrionStore } from '../../store';
import { THEME_SCENE_SOURCE, buildSceneDocument, parseSceneMessage, themeValueSpec, type UiTheme } from '../../ui-themes.js';
import {
  addSceneListener,
  fireThemeAction,
  setThemeValues,
  themeColors,
  useThemeState,
  useThemeValues,
  type SceneEvent,
} from './themeState';

/**
 * One HTML scene of a theme in a sandboxed frame with no network
 * (ui-themes.js buildSceneDocument): the backdrop, the overlay, or an HTML
 * widget control. It hears what the app is doing (agents working, turns
 * ending, the pointer, the theme's values) and may change the theme's values
 * (durango.set), fire actions (durango.action) and, as a widget, size itself
 * (durango.resize). The main window refuses any navigation of an
 * about:srcdoc frame (main.js guardVisualFrames).
 */

const SANDBOX = 'allow-scripts';

export const runningThreadIds = () =>
  useOrionStore
    .getState()
    .threads.filter((thread) => thread.status === 'running')
    .map((thread) => thread.id);

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

type Props = {
  theme: UiTheme;
  html: string;
  role: 'backdrop' | 'overlay' | 'widget';
  /** For error reports: which widget. */
  name?: string;
  /** Widgets take pointer and keyboard input; scenes never do. */
  interactive?: boolean;
  onResize?: (size: { width: number; height: number }) => void;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  /** Backdrop and overlay: whether they may move (motionPolicy.ts); widgets follow the switch. */
  animate?: boolean;
  /** Freeze the scene: its bootstrap holds animation frames, CSS animations and media. */
  paused?: boolean;
};

export const ThemeSceneFrame: React.FC<Props> = ({
  theme,
  html,
  role,
  name,
  interactive = false,
  onResize,
  className,
  style,
  title,
  animate: animateProp,
  paused = false,
}) => {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const srcDoc = useMemo(() => buildSceneDocument(html), [html]);
  const animateSetting = useThemeState((state) => state.animate);
  const animate = animateProp ?? animateSetting;
  const values = useThemeValues(theme.id);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const themeId = theme.id;
  const appearance = theme.appearance;
  const label = name ? `${role} ${name}` : role;

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
          paused,
          appearance,
          values: valuesRef.current,
          colors: themeColors(),
        },
      });
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const message = parseSceneMessage(event.data);
      if (!message) return;
      if (message.type === 'ready') sendState();
      else if (message.type === 'set') {
        const current = themeRef.current;
        if (!themeValueSpec(current, message.name)) {
          window.orion?.themes?.reportSceneError(themeId, `${label}: durango.set("${message.name}") — not one of the theme's values`);
          return;
        }
        setThemeValues(current, { [message.name]: message.value });
      } else if (message.type === 'action') fireThemeAction(message.name, message.detail);
      else if (message.type === 'resize') onResizeRef.current?.({ width: message.width, height: message.height });
      else window.orion?.themes?.reportSceneError(themeId, `${label}: ${message.message}`);
    };
    window.addEventListener('message', onMessage);
    const remove = addSceneListener(post);
    sendState();
    return () => {
      window.removeEventListener('message', onMessage);
      remove();
    };
  }, [themeId, label, animate, paused, appearance, srcDoc]);

  // Values changed (a control, another scene, the agent): tell this frame.
  const previous = useRef(values);
  useEffect(() => {
    if (previous.current === values) return;
    const before = previous.current;
    previous.current = values;
    const frame = frameRef.current;
    const changed = Object.keys(values).filter((key) => before[key] !== values[key]);
    for (const key of changed.length ? changed : [null]) {
      try {
        frame?.contentWindow?.postMessage(
          {
            source: THEME_SCENE_SOURCE,
            type: 'event',
            event: 'value',
            detail: { name: key, value: key ? values[key] : null, values },
          },
          '*'
        );
      } catch {}
    }
  }, [values]);

  return (
    <iframe
      ref={frameRef}
      className={className ?? `theme-scene theme-scene-${role}`}
      style={style}
      title={title ?? `${theme.name} ${label}`}
      sandbox={SANDBOX}
      srcDoc={srcDoc}
      tabIndex={interactive ? 0 : -1}
      aria-hidden={interactive ? undefined : 'true'}
    />
  );
};
