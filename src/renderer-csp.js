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
// - `img-src` / `media-src`: allows app-local, `data:`, `blob:`,
//   `orion-attachment:`, `orion-source-attachment:`, and `https:` (avatars,
//   community theme previews, bot files, HTTPS Markdown media). Cleartext
//   `http:` is excluded in production to block LAN/localhost/metadata probing;
//   dev mode adds loopback `http:` origins for local Durango stacks.
// - `worker-src 'self' blob:`: Shiki syntax-highlight module worker (`'self'`)
//   and Monaco workers (`'self'` / `blob:`).
// - `frame-src 'self' orion-attachment:`: `about:srcdoc` visuals/theme scenes
//   and Code-tab PDF preview iframes (`orion-attachment://`).
// - `connect-src`: no external network in production (the renderer talks to
//   main over IPC); dev mode adds loopback + configured Vite dev server HTTP
//   and WebSocket origins for HMR so the HTTP header and `<meta>` CSP always
//   intersect cleanly across IPv4, IPv6, HTTPS, and custom HMR hosts/ports.

const DEV_LOOPBACK_HTTP = [
  'http://localhost:*',
  'http://127.0.0.1:*',
  'http://[::1]:*',
];

const DEV_CONNECT_FALLBACK = [
  'http://localhost:*',
  'https://localhost:*',
  'http://127.0.0.1:*',
  'https://127.0.0.1:*',
  'http://[::1]:*',
  'https://[::1]:*',
  'ws://localhost:*',
  'wss://localhost:*',
  'ws://127.0.0.1:*',
  'wss://127.0.0.1:*',
  'ws://[::1]:*',
  'wss://[::1]:*',
];

const devConnectOrigins = (input) => {
  const urls = Array.isArray(input) ? input : input ? [input] : [];
  const origins = new Set();
  for (const raw of urls) {
    if (!raw) continue;
    try {
      const parsed = new URL(String(raw));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      origins.add(parsed.origin);
      origins.add(`${wsProtocol}//${parsed.host}`);
    } catch {
      // Ignore malformed URL entries.
    }
  }
  return [...origins];
};

export const buildRendererCsp = ({
  devServerUrl = null,
  devServerUrls = null,
  devMode = false,
  includeFrameAncestors = false,
} = {}) => {
  const explicitDevOrigins = devConnectOrigins([
    ...(Array.isArray(devServerUrls) ? devServerUrls : []),
    ...(devServerUrl ? [devServerUrl] : []),
  ]);
  const isDev = Boolean(devMode || explicitDevOrigins.length > 0);
  const extraConnect = isDev
    ? [...new Set([...DEV_CONNECT_FALLBACK, ...explicitDevOrigins])]
    : [];
  const extraMedia = isDev ? DEV_LOOPBACK_HTTP : [];

  const connectSrc = [
    "'self'",
    'data:',
    'blob:',
    'orion-attachment:',
    'orion-source-attachment:',
    ...extraConnect,
  ].join(' ');

  const mediaOrigins = [
    "'self'",
    'data:',
    'blob:',
    'orion-attachment:',
    'orion-source-attachment:',
    'https:',
    ...extraMedia,
  ].join(' ');

  const directives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${mediaOrigins}`,
    `media-src ${mediaOrigins}`,
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

export const rewriteIndexHtmlCsp = (html, csp) =>
  String(html).replace(
    /(<meta\b[^>]*\bhttp-equiv\s*=\s*"Content-Security-Policy"[^>]*\bcontent\s*=\s*")[^"]*(")/i,
    (_match, before, after) => `${before}${csp}${after}`
  );

/**
 * Returns updated responseHeaders with the renderer CSP applied when `details`
 * is a main-frame load belonging to one of our main renderer windows, or null
 * to leave the response untouched (subframes, browser-panel guests, assets).
 * Fails closed (returns null) if `isMainWindow` is not provided.
 */
export const rendererCspResponseHeaders = (
  details,
  { isMainWindow, devServerUrl = null } = {}
) => {
  if (!details || details.resourceType !== 'mainFrame') return null;
  if (typeof isMainWindow !== 'function' || !isMainWindow(details.webContentsId)) return null;
  const csp = buildRendererCsp({
    devServerUrl,
    devMode: Boolean(devServerUrl),
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
