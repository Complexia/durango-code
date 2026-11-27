// Renderer security hardening checks: CSP (prod & dev), theme CSS sanitizer
// bypasses, and external URL scheme validation. Plain Node: no Electron needed.
//
//   node --no-warnings scripts/test-renderer-security.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RENDERER_CSP_DEV,
  RENDERER_CSP_PROD,
  buildRendererCsp,
  rendererCspResponseHeaders,
} from '../src/renderer-csp.js';
import { sanitizeThemeCss } from '../src/ui-themes.js';
import { externalWebUrl, openExternalWebUrl } from '../src/main/linked-navigation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const codeRoot = path.resolve(here, '..');

// --- 1. Renderer CSP (index.html + main.js headers + Vite dev HMR) ----------

const indexHtml = await fs.readFile(path.join(codeRoot, 'index.html'), 'utf8');
const metaMatch = indexHtml.match(
  /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/>/i
);
assert.ok(metaMatch, 'code/index.html declares a Content-Security-Policy meta tag');
assert.equal(metaMatch[1], RENDERER_CSP_PROD, 'index.html meta CSP matches RENDERER_CSP_PROD verbatim');

// Production CSP directives.
assert.match(RENDERER_CSP_PROD, /default-src 'self'/);
assert.doesNotMatch(RENDERER_CSP_PROD, /unsafe-eval/, 'prod CSP never allows eval');
assert.doesNotMatch(RENDERER_CSP_PROD, /frame-ancestors/, 'meta CSP omits frame-ancestors (HTTP-only)');
assert.match(RENDERER_CSP_PROD, /style-src 'self' 'unsafe-inline'/);
assert.doesNotMatch(RENDERER_CSP_PROD, /style-src[^;]*https?:/, 'remote stylesheets are blocked');
assert.match(RENDERER_CSP_PROD, /img-src[^;]*orion-attachment:/);
assert.match(RENDERER_CSP_PROD, /img-src[^;]*orion-source-attachment:/);
assert.match(RENDERER_CSP_PROD, /img-src[^;]*data:/);
assert.match(RENDERER_CSP_PROD, /img-src[^;]*blob:/);
assert.match(RENDERER_CSP_PROD, /media-src[^;]*orion-attachment:/);
assert.match(RENDERER_CSP_PROD, /media-src[^;]*blob:/);
assert.match(RENDERER_CSP_PROD, /worker-src 'self' blob:/);
assert.match(RENDERER_CSP_PROD, /frame-src 'self' orion-attachment:/);
assert.match(RENDERER_CSP_PROD, /object-src 'none'/);
assert.match(RENDERER_CSP_PROD, /base-uri 'self'/);
assert.match(RENDERER_CSP_PROD, /form-action 'none'/);
assert.doesNotMatch(RENDERER_CSP_PROD, /connect-src[^;]*https?:/, 'prod renderer cannot fetch remote origins directly');
assert.doesNotMatch(RENDERER_CSP_PROD, /connect-src[^;]*wss?:/, 'prod renderer cannot open WebSockets');

// Dev-mode CSP allows Vite HMR connections without relaxing script/style/object rules.
assert.match(RENDERER_CSP_DEV, /connect-src[^;]*ws:\/\/localhost:\*/);
assert.match(RENDERER_CSP_DEV, /connect-src[^;]*http:\/\/localhost:\*/);
assert.doesNotMatch(RENDERER_CSP_DEV, /unsafe-eval/);

const devFromUrl = buildRendererCsp({ devServerUrl: 'http://localhost:5173', includeFrameAncestors: true });
assert.match(devFromUrl, /connect-src[^;]*http:\/\/localhost:5173 ws:\/\/localhost:5173/);
assert.match(devFromUrl, /frame-ancestors 'none'/);

// Header injection applies ONLY to main-frame responses of tracked main windows.
const mainHeaders = rendererCspResponseHeaders(
  {
    resourceType: 'mainFrame',
    webContentsId: 1,
    responseHeaders: { 'content-security-policy': ['old'], 'X-Test': ['1'] },
  },
  { isMainWindow: (id) => id === 1, devServerUrl: null }
);
assert.ok(mainHeaders);
assert.equal(mainHeaders['content-security-policy'], undefined, 'replaces case-variant CSP headers');
assert.deepEqual(mainHeaders['X-Test'], ['1']);
assert.equal(
  mainHeaders['Content-Security-Policy'][0],
  buildRendererCsp({ includeFrameAncestors: true })
);

assert.equal(
  rendererCspResponseHeaders(
    { resourceType: 'subFrame', webContentsId: 1, responseHeaders: {} },
    { isMainWindow: (id) => id === 1 }
  ),
  null,
  'never overwrites CSP on subframes (srcdoc visuals/themes, PDF iframes)'
);
assert.equal(
  rendererCspResponseHeaders(
    { resourceType: 'mainFrame', webContentsId: 99, responseHeaders: {} },
    { isMainWindow: (id) => id === 1 }
  ),
  null,
  'never applies renderer CSP to built-in browser WebContentsViews'
);

// --- 2. sanitizeThemeCss multi-pass & splice bypasses -----------------------

const spliceCases = [
  '@imp@namespace;ort "https://evil.example/a.css";',
  '@imp@font-face{}ort "https://evil.example/b.css";',
  '@im/*x*/port url("https://evil.example/c.css");',
  '@im@imp@namespace;ort;port "https://evil.example/d.css";',
  '@IMPORT "https://evil.example/upper.css";',
  '@import url("https://evil.example/a;b.css");',
  '@font-face { font-family: evil; src: url("https://evil.example/font.woff2"); }',
  '@font-face { src: url("https://evil.example/unclosed.woff2")',
  '</st@namespace;yle><script>alert(1)</script>',
  '.x { background: u\\rl("https://evil.example/e.png"); }',
  '.y { background: image-set("https://evil.example/f.png" 1x); }',
  '.z { background: image("https://evil.example/g.png"); }',
  '.w { background: url(orion-attachment://local/media?path=/etc/passwd); }',
];

for (const payload of spliceCases) {
  const out = sanitizeThemeCss(payload);
  assert.doesNotMatch(out, /@import/i, `payload leaked @import: ${payload} -> ${out}`);
  assert.doesNotMatch(out, /@namespace/i, `payload leaked @namespace: ${payload} -> ${out}`);
  assert.doesNotMatch(out, /@font-face/i, `payload leaked @font-face: ${payload} -> ${out}`);
  assert.doesNotMatch(out, /<\/?style/i, `payload leaked style tag: ${payload} -> ${out}`);
  assert.doesNotMatch(out, /\b(?:url|image-set|cross-fade|image|src|element|expression)\s*\(/i, `payload leaked loader: ${payload} -> ${out}`);
  assert.doesNotMatch(out, /\\/, `payload leaked backslash: ${payload} -> ${out}`);
}

// Deeply nested splice payload breaks on pass 1 and never forms @import/@namespace.
let deeplyNested = '@namespace;';
for (let i = 0; i < 20; i += 1) {
  deeplyNested = `@imp${deeplyNested}ort;`;
}
const nestedOut = sanitizeThemeCss(deeplyNested);
assert.doesNotMatch(nestedOut, /@import|@namespace/i, 'deeply nested splice payload leaves nothing dangerous');

// Safe data:image/ URLs and normal CSS survive untouched.
const safeCss = '.card { background: url("data:image/png;base64,iVBORw0KGgo="); color: var(--accent); }';
assert.equal(sanitizeThemeCss(safeCss), safeCss);

// --- 3. External URL scheme validation + source audit -----------------------

for (const safe of ['https://durango.sh/code', 'http://127.0.0.1:8080/authorize', new URL('https://example.com/a')]) {
  assert.ok(externalWebUrl(safe), `allows safe URL: ${safe}`);
}
for (const unsafe of [
  'file:///etc/passwd',
  'javascript:alert(1)',
  'data:text/html,hi',
  'smb://evil.example/share',
  'ssh://evil.example',
  'ms-msdt:/id PCWDiagnostic',
  'x-apple.systempreferences:com.apple.preference.security',
  'ht\ntp://example.com',
  'https://example.com\r\n',
  '',
  null,
]) {
  assert.equal(externalWebUrl(unsafe), null, `blocks unsafe URL: ${String(unsafe)}`);
}

let openerCalls = 0;
await assert.rejects(
  openExternalWebUrl('file:///System/Applications/Calculator.app', async () => {
    openerCalls += 1;
  }),
  /http and https/
);
assert.equal(openerCalls, 0);

// Static check: main.js and orion-mcps.js wire CSP and never pass unvalidated URLs to shell.openExternal.
const [mainSource, mcpsSource] = await Promise.all([
  fs.readFile(path.join(codeRoot, 'src/main.js'), 'utf8'),
  fs.readFile(path.join(codeRoot, 'src/main/orion-mcps.js'), 'utf8'),
]);
assert.match(mainSource, /attachMainWindowCsp\(mainWindow\)/);
assert.doesNotMatch(mainSource, /shell\.openExternal\(result\.url\)/, 'provider auth URL must be validated');
assert.doesNotMatch(mcpsSource, /shell\.openExternal\(authorizationUrl\.toString\(\)\)/, 'OAuth authorization_endpoint must be validated');

console.log('Renderer security checks passed.');
