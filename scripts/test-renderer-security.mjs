// Renderer security hardening checks: CSP (prod, Vite dev HMR across IPv4/IPv6/
// HTTPS/LAN, header scoping), theme CSS & token sanitizer bypasses, and
// exhaustive external URL scheme validation. Plain Node: no Electron needed.
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
  rewriteIndexHtmlCsp,
} from '../src/renderer-csp.js';
import { rendererDevCspPlugin } from '../vite.renderer.config.mjs';
import { sanitizeThemeCss, sanitizeTokenValue } from '../src/ui-themes.js';
import { externalWebUrl, openExternalWebUrl } from '../src/main/linked-navigation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const codeRoot = path.resolve(here, '..');

// --- 1. Renderer CSP (index.html + Vite dev plugin + main.js headers) --------

const indexHtml = await fs.readFile(path.join(codeRoot, 'index.html'), 'utf8');
const extractMetaCsp = (html) => {
  const match = html.match(
    /<meta\b[^>]*\bhttp-equiv\s*=\s*"Content-Security-Policy"[^>]*\bcontent\s*=\s*"([^"]+)"[^>]*\/?>/i
  );
  return match?.[1] ?? null;
};

const prodMetaCsp = extractMetaCsp(indexHtml);
assert.ok(prodMetaCsp, 'code/index.html declares a Content-Security-Policy meta tag');
assert.equal(prodMetaCsp, RENDERER_CSP_PROD, 'index.html meta CSP matches RENDERER_CSP_PROD verbatim');

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
assert.match(RENDERER_CSP_PROD, /img-src[^;]*https:/);
assert.doesNotMatch(RENDERER_CSP_PROD, /img-src[^;]*\bhttp:/, 'prod img-src blocks cleartext http:');
assert.match(RENDERER_CSP_PROD, /media-src[^;]*orion-attachment:/);
assert.match(RENDERER_CSP_PROD, /media-src[^;]*blob:/);
assert.match(RENDERER_CSP_PROD, /media-src[^;]*https:/);
assert.doesNotMatch(RENDERER_CSP_PROD, /media-src[^;]*\bhttp:/, 'prod media-src blocks cleartext http:');
assert.match(RENDERER_CSP_PROD, /worker-src 'self' blob:/);
assert.match(RENDERER_CSP_PROD, /frame-src 'self' orion-attachment:/);
assert.match(RENDERER_CSP_PROD, /object-src 'none'/);
assert.match(RENDERER_CSP_PROD, /base-uri 'self'/);
assert.match(RENDERER_CSP_PROD, /form-action 'none'/);
assert.doesNotMatch(RENDERER_CSP_PROD, /connect-src[^;]*https?:/, 'prod renderer cannot fetch remote origins directly');
assert.doesNotMatch(RENDERER_CSP_PROD, /connect-src[^;]*wss?:/, 'prod renderer cannot open WebSockets');

// Dev-mode CSP fallback covers IPv4, IPv6, HTTP, and HTTPS localhost/loopback.
for (const expectedOrigin of [
  'http://localhost:*',
  'https://localhost:*',
  'http://127.0.0.1:*',
  'http://[::1]:*',
  'ws://localhost:*',
  'wss://localhost:*',
  'ws://127.0.0.1:*',
  'ws://[::1]:*',
]) {
  assert.ok(RENDERER_CSP_DEV.includes(expectedOrigin), `RENDERER_CSP_DEV includes ${expectedOrigin}`);
}
assert.doesNotMatch(RENDERER_CSP_DEV, /unsafe-eval/);

// Exercise the actual Vite transformIndexHtml plugin against real code/index.html.
const devPlugin = rendererDevCspPlugin();
assert.equal(
  extractMetaCsp(devPlugin.transformIndexHtml(indexHtml, {})),
  RENDERER_CSP_PROD,
  'prod build leaves index.html CSP untouched'
);
assert.equal(
  extractMetaCsp(devPlugin.transformIndexHtml(indexHtml, { server: {} })),
  RENDERER_CSP_DEV,
  'dev serve without resolvedUrls falls back to RENDERER_CSP_DEV'
);
const ipv6DevHtml = devPlugin.transformIndexHtml(indexHtml, {
  server: { resolvedUrls: { local: ['http://[::1]:5173/'], network: [] } },
});
assert.match(extractMetaCsp(ipv6DevHtml) ?? '', /connect-src[^;]*http:\/\/\[::1\]:5173 ws:\/\/\[::1\]:5173/);
const httpsLanDevHtml = devPlugin.transformIndexHtml(indexHtml, {
  server: { resolvedUrls: { local: ['https://localhost:5173/'], network: ['https://192.168.1.10:5173/'] } },
});
const httpsLanCsp = extractMetaCsp(httpsLanDevHtml) ?? '';
assert.match(httpsLanCsp, /connect-src[^;]*https:\/\/localhost:5173 wss:\/\/localhost:5173/);
assert.match(httpsLanCsp, /connect-src[^;]*https:\/\/192\.168\.1\.10:5173 wss:\/\/192\.168\.1\.10:5173/);

const devFromUrl = buildRendererCsp({ devServerUrl: 'http://localhost:5173', includeFrameAncestors: true });
assert.match(devFromUrl, /connect-src[^;]*http:\/\/localhost:5173/);
assert.match(devFromUrl, /connect-src[^;]*ws:\/\/localhost:5173/);
assert.match(devFromUrl, /connect-src[^;]*ws:\/\/127\.0\.0\.1:\*/);
assert.match(devFromUrl, /connect-src[^;]*ws:\/\/\[::1\]:\*/);
assert.match(devFromUrl, /img-src[^;]*http:\/\/localhost:\*/);
assert.match(devFromUrl, /media-src[^;]*http:\/\/127\.0\.0\.1:\*/);
assert.match(devFromUrl, /frame-ancestors 'none'/);

// HTTP dev header and Vite <meta> CSP share loopback origins even when dev hostnames differ.
const devHeader = rendererCspResponseHeaders(
  { resourceType: 'mainFrame', webContentsId: 1, responseHeaders: {} },
  { isMainWindow: (id) => id === 1, devServerUrl: 'http://localhost:5173' }
);
assert.match(devHeader['Content-Security-Policy'][0], /connect-src[^;]*ws:\/\/127\.0\.0\.1:\*/);
assert.match(devHeader['Content-Security-Policy'][0], /connect-src[^;]*ws:\/\/\[::1\]:\*/);

// rewriteIndexHtmlCsp uses a function replacer so "$" sequences in CSP are never interpreted.
const dollarRewritten = rewriteIndexHtmlCsp(indexHtml, "default-src 'self' $& $1");
assert.equal(extractMetaCsp(dollarRewritten), "default-src 'self' $& $1");

// Header injection applies ONLY to main-frame responses of tracked main windows and fails closed.
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
  rendererCspResponseHeaders({ resourceType: 'mainFrame', webContentsId: 1, responseHeaders: {} }),
  null,
  'fails closed when isMainWindow predicate is omitted'
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

// --- 2. sanitizeThemeCss & sanitizeTokenValue bypasses ----------------------

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

// Token values reject CSS resource/dynamic functions, comments, and interleaved quotes.
for (const badToken of [
  'url("//evil.example/x.png")',
  'image("//evil.example/x.png")',
  'cross-fade("//evil.example/x.png", red)',
  '-webkit-cross-fade("//evil.example/x.png", red)',
  'src("//evil.example/x.png")',
  'element(#x)',
  'image-set("//evil.example/x.png" 1x)',
  '-webkit-image-set("//evil.example/x.png" 1x)',
  'expression(1)',
  '#111 /*',
  '*/ #111',
  '#111 /* comment */',
  "'a\"b' c\"",
  '"a\'b" c\'',
]) {
  assert.equal(sanitizeTokenValue(badToken), null, `sanitizeTokenValue blocks ${badToken}`);
}
assert.equal(
  sanitizeTokenValue("'Avenir Next', \"Segoe UI\", sans-serif"),
  "'Avenir Next', \"Segoe UI\", sans-serif"
);
assert.equal(
  sanitizeTokenValue('linear-gradient(180deg, #141416 0%, #111113 100%)'),
  'linear-gradient(180deg, #141416 0%, #111113 100%)'
);

// --- 3. External URL scheme validation + exhaustive source audit ------------

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

// Exhaustive audit: every shell.openExternal( call across code/src/ must be
// guarded by externalWebUrl, openExternalWebUrl, or the explicit macOS
// x-apple.systempreferences: allowlist.
const walkFiles = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(full)));
    else if (/\.(?:js|mjs|cjs|ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
};

const srcFiles = await walkFiles(path.join(codeRoot, 'src'));
let totalOpenExternalCalls = 0;
for (const file of srcFiles) {
  const rel = path.relative(codeRoot, file);
  const content = await fs.readFile(file, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('shell.openExternal(')) continue;
    totalOpenExternalCalls += 1;
    const context = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
    const isGuarded =
      /openExternalWebUrl\(/.test(context) ||
      /externalWebUrl\(/.test(context) ||
      /externalUrl\(/.test(context) ||
      /startsWith\('x-apple\.systempreferences:'\)/.test(context);
    assert.ok(
      isGuarded,
      `Unvalidated shell.openExternal call at ${rel}:${i + 1}:\n${context}`
    );
  }
}
assert.ok(totalOpenExternalCalls >= 10, `expected to audit all shell.openExternal sites (found ${totalOpenExternalCalls})`);

const mainSource = await fs.readFile(path.join(codeRoot, 'src/main.js'), 'utf8');
assert.match(mainSource, /attachMainWindowCsp\(mainWindow\)/);

console.log(`Renderer security checks passed (${totalOpenExternalCalls} shell.openExternal sites audited).`);
