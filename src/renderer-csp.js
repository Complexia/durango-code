// Content-Security-Policy for the Durango Code renderer (shared by index.html,
// vite.renderer.config.mjs, main.js, and tests). Pure JS: no Node/Electron/DOM.
//
// Notes on specific directives:
// - `script-src 'self' 'unsafe-inline'`: Chromium inherits the parent CSP into
//   `about:srcdoc` iframes (`HtmlVisual` / show_html and `ThemeSceneFrame`),
//   which run sandboxed inline scripts under their own stricter meta CSP
//   (`VISUAL_CSP` / `THEME_SCENE_CSP`). Keeping `'unsafe-inline'` allows those
//   sandboxed frames, index.html's boot-skeleton script, and Vite React Refresh
//   in dev mode, while still blocking `'unsafe-eval'`, remote script URLs,
//   `data:` scripts, and `blob:` scripts.
// - `style-src 'self' 'unsafe-inline'`: required for Tailwind/React inline
//   styles, Monaco dynamic stylesheets, and theme `<style>` injection; blocks
//   remote stylesheets as defense in depth behind `sanitizeThemeCss`.
// - `worker-src 'self' blob:`: Shiki syntax-highlight module worker (`'self'`)
//   and Monaco workers (`'self'` / `blob:`).
// - `frame-src 'self' orion-attachment:`: `about:srcdoc` visuals/theme scenes
//   and Code-tab PDF preview iframes (`orion-attachment://`).
// - `connect-src`: no external network in production (the renderer talks to
//   main over IPC); dev mode adds the Vite dev server HTTP + WebSocket origins
//   for HMR.

const DEV_CONNECT_FALLBACK = [
  'http://localhost:*',
  'http://127.0.0.1:*',
  'ws://localhost:*',
  'ws://127.0.0.1:*',
];

const devConnectOrigins = (devServerUrl) => {
  if (!devServerUrl) return [];
  try {
    const parsed = new URL(String(devServerUrl));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [];
    const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return [parsed.origin, `${wsProtocol}//${parsed.host}`];
  } catch {
    return [];
  }
};

export const buildRendererCsp = ({
  devServerUrl = null,
  devMode = false,
  includeFrameAncestors = false,
} = {}) => {
  const extraConnect = devServerUrl
    ? devConnectOrigins(devServerUrl)
    : devMode
      ? DEV_CONNECT_FALLBACK
      : [];

  const connectSrc = [
    "'self'",
    'data:',
    'blob:',
    'orion-attachment:',
    'orion-source-attachment:',
    ...extraConnect,
  ].join(' ');

  const directives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: orion-attachment: orion-source-attachment: https: http:",
    "media-src 'self' data: blob: orion-attachment: orion-source-attachment: https: http:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "worker-src 'self' blob:",
    "frame-src 'self' orion-attachment:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ];

  if (includeFrameAncestors) {
    directives.push("frame-ancestors 'none'");
  }

  return directives.join('; ');
};

export const RENDERER_CSP_PROD = buildRendererCsp();

export const RENDERER_CSP_DEV = buildRendererCsp({ devMode: true });

/**
 * Returns updated responseHeaders with the renderer CSP applied when `details`
 * is a main-frame load belonging to one of our main renderer windows, or null
 * to leave the response untouched (subframes, browser-panel guests, assets).
 */
export const rendererCspResponseHeaders = (
  details,
  { isMainWindow, devServerUrl = null } = {}
) => {
  if (!details || details.resourceType !== 'mainFrame') return null;
  if (typeof isMainWindow === 'function' && !isMainWindow(details.webContentsId)) return null;
  const csp = buildRendererCsp({
    devServerUrl,
    includeFrameAncestors: true,
  });
  const nextHeaders = {};
  for (const [key, value] of Object.entries(details.responseHeaders ?? {})) {
    if (key.toLowerCase() === 'content-security-policy') continue;
    nextHeaders[key] = value;
  }
  nextHeaders['Content-Security-Policy'] = [csp];
  return nextHeaders;
};
