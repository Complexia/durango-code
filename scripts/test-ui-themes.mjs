// Themes (Settings → Customizations): the shared format (src/ui-themes.js),
// the built-ins, the main-process store (src/main/ui-themes-store.js) and the
// agent tools (src/main/theme-tools.js). Plain Node: no Electron needed.
//
//   node --no-warnings scripts/test-ui-themes.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  THEME_TOKENS,
  buildSceneDocument,
  mergeTheme,
  parseSceneMessage,
  sanitizeTheme,
  sanitizeThemeCss,
  sanitizeTokenValue,
  themeSummary,
  themeToCss,
} from '../src/ui-themes.js';
import { BUILTIN_THEMES } from '../src/ui-themes-builtin.js';
import * as store from '../src/main/ui-themes-store.js';
import {
  THEME_TOOL_INPUT_SCHEMAS,
  THEME_TOOL_NAMES,
  runThemeTool,
  setThemeToolsClient,
  themeMcpToolDefinitions,
} from '../src/main/theme-tools.js';
import { ORION_THEME_TOOL_NAMES, isPreapprovedOrionTool, orionThemeToolNamesForAccessMode } from '../src/main/thread-reader-routing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
};

// --- format ------------------------------------------------------------------

await test('stock token values match index.css :root', async () => {
  const css = await fs.readFile(path.join(here, '../src/index.css'), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  for (const [name, { stock }] of Object.entries(THEME_TOKENS)) {
    const match = root.match(new RegExp(`--${name}:\\s*([^;]+);`));
    assert.ok(match, `--${name} is declared in :root`);
    assert.equal(match[1].trim(), stock, `--${name} stock value`);
  }
});

await test('token values cannot escape their declaration or load anything', () => {
  assert.equal(sanitizeTokenValue('#ff00aa'), '#ff00aa');
  assert.equal(sanitizeTokenValue('linear-gradient(180deg, #000 0%, rgb(1 2 3 / 50%) 100%)'), 'linear-gradient(180deg, #000 0%, rgb(1 2 3 / 50%) 100%)');
  assert.equal(sanitizeTokenValue("'Avenir Next', sans-serif"), "'Avenir Next', sans-serif");
  assert.equal(sanitizeTokenValue('red; } body { display: none'), null);
  assert.equal(sanitizeTokenValue('url(https://example.com/x.png)'), null);
  assert.equal(sanitizeTokenValue("'unclosed, serif"), null);
  assert.equal(sanitizeTokenValue('rgb(1 2 3'), null);
  assert.equal(sanitizeTokenValue('</style><script>'), null);
});

await test('theme CSS drops imports, font-face and remote urls', () => {
  const css = sanitizeThemeCss(
    '@import url(https://evil.example/x.css);\n.a{background:url("https://evil.example/p.png")}\n.b{background:url(data:image/png;base64,AAA)}\n@font-face{font-family:x;src:url(https://f)}'
  );
  // Remote URLs may remain as text, but never inside a loading function.
  assert.ok(!/url\s*\(\s*['"]?\s*https?:/i.test(css), css);
  assert.ok(!css.includes('@import'));
  assert.ok(!css.includes('@font-face'));
  assert.ok(css.includes('data:image/png;base64,AAA'));
  // Review findings: other resource functions, escapes, quoted ")" and raw attachment URLs.
  const sneaky = sanitizeThemeCss(
    [
      '.a{background:image-set("https://evil.example/1.png" 1x)}',
      '.b{background:-webkit-image-set(url(https://evil.example/2.png) 1x)}',
      '.c{background:u\\rl(https://evil.example/3.png)}',
      '.d{background:\\75 rl(https://evil.example/4.png)}',
      '.e{background:url("https://evil.example/5.png?a)b")}',
      '.f{background:url(orion-attachment://local/media?path=/etc/x.png)}',
      '.g{background:cross-fade(url(https://evil.example/6.png), red)}',
      '.h{background:URL( https://evil.example/7.png )}',
      '@namespace url(https://evil.example/ns);',
    ].join('\n')
  );
  assert.ok(!/url\s*\(\s*['"]?\s*(https?:|orion-attachment:)/i.test(sneaky), sneaky);
  assert.ok(!/image-set\s*\(|cross-fade\s*\(/i.test(sneaky), sneaky);
  assert.ok(!/\\/.test(sneaky), 'escapes removed');
  const asset = themeToCss(
    mergeTheme(null, { css: '.x{background:theme-asset("backdrop-1.png")}' }, { id: 'tasset' }).theme,
    { assetUrl: (name) => `orion-attachment://local/media?path=/themes/tasset/${name}` }
  );
  assert.match(asset, /url\("orion-attachment:\/\/local\/media\?path=\/themes\/tasset\/backdrop-1\.png"\)/, 'theme-asset() still resolves');
});

await test('mergeTheme patches, removes and reports what it ignored', () => {
  const { theme, ignored } = mergeTheme(null, {
    name: 'Neon',
    tokens: { accent: '#ff4fd8', '--bg-base': '#0b0717', bogus: '#fff', danger: 'url(x)' },
    backdrop: { type: 'css', css: 'radial-gradient(circle, #f0f 0%, #000 100%)', dim: 2 },
  }, { id: 'tneon' });
  assert.equal(theme.name, 'Neon');
  assert.equal(theme.tokens.accent, '#ff4fd8');
  assert.equal(theme.tokens['bg-base'], '#0b0717');
  assert.equal(theme.backdrop.dim, 0.9, 'dim is clamped');
  assert.equal(ignored.length, 2);
  const next = mergeTheme(theme, { tokens: { accent: null }, backdrop: null }, {}).theme;
  assert.equal(next.tokens.accent, undefined);
  assert.equal(next.backdrop, undefined);
  assert.equal(next.revision, 2);
  assert.equal(next.tokens['bg-base'], '#0b0717');
});

await test('themeToCss: tokens, see-through panels over a backdrop, derived accent tints', () => {
  const { theme } = mergeTheme(null, {
    tokens: { accent: '#ff4fd8', 'bg-raised': '#120a22' },
    backdrop: { type: 'css', css: '#000' },
    surfaceOpacity: 0.5,
  }, { id: 'tcss' });
  const css = themeToCss(theme);
  assert.match(css, /--accent: #ff4fd8;/);
  assert.match(css, /--accent-soft: color-mix\(in srgb, #ff4fd8 14%, transparent\);/);
  assert.match(css, /--bg-raised: color-mix\(in srgb, #120a22 50%, transparent\);/);
  assert.match(css, /--bg-base: color-mix\(in srgb, #101012 50%, transparent\);/, 'stock values go see-through too');
  assert.match(css, /\.theme-backdrop-css \{ background: #000; \}/);
  assert.equal(themeToCss(null), '', 'stock is no CSS at all');
  const plain = themeToCss(mergeTheme(null, { tokens: { 'bg-base': '#111' } }, { id: 'tplain' }).theme);
  assert.match(plain, /--bg-base: #111;/, 'no backdrop: opaque');
});

await test('scene documents put the CSP first and expose the event API', () => {
  const doc = buildSceneDocument('<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://x"><link rel=stylesheet href="https://x"></head><body><canvas></canvas><script>durango.on("turn-end",()=>{})</script></body></html>');
  const head = doc.indexOf('<head>');
  assert.ok(doc.indexOf('Content-Security-Policy') > head && doc.indexOf('Content-Security-Policy') < doc.indexOf('<script>'));
  assert.ok(!doc.includes('refresh'));
  assert.ok(!doc.includes('<link'));
  assert.ok(doc.includes("connect-src 'none'"));
  assert.ok(doc.includes('<canvas></canvas>'));
  assert.deepEqual(parseSceneMessage({ source: 'durango-theme-scene', type: 'error', message: ' boom ' }), { type: 'error', message: 'boom' });
  assert.equal(parseSceneMessage({ source: 'other', type: 'error', message: 'x' }), null);
});

await test('built-in themes are valid and keep every field', () => {
  assert.ok(BUILTIN_THEMES.length >= 5);
  const ids = new Set();
  for (const raw of BUILTIN_THEMES) {
    const theme = sanitizeTheme(raw);
    assert.ok(theme, `${raw.id} sanitizes`);
    assert.ok(theme.builtIn && theme.saved);
    assert.ok(!ids.has(theme.id));
    ids.add(theme.id);
    assert.deepEqual(Object.keys(theme.tokens).sort(), Object.keys(raw.tokens).sort(), `${raw.id}: no token dropped`);
    assert.equal(Boolean(theme.backdrop), Boolean(raw.backdrop), `${raw.id}: backdrop kept`);
    assert.equal(Boolean(theme.overlay), Boolean(raw.overlay), `${raw.id}: overlay kept`);
    assert.ok(themeSummary(theme).swatches.length === 5);
  }
});

// --- store + tools ---------------------------------------------------------------

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'durango-themes-'));
const broadcasts = [];
store.configureThemeStore({ dir, send: (snapshot) => broadcasts.push(snapshot) });

const events = [];
const sender = {
  isDestroyed: () => false,
  capturePage: async () => ({
    getSize: () => ({ width: 2000, height: 1200 }),
    resize: function () {
      return this;
    },
    toJPEG: () => Buffer.from('jpeg'),
  }),
};
const context = (threadId, extra = {}) => ({
  threadId,
  runId: `run-${threadId}`,
  getSender: () => sender,
  emitEvent: (_sender, event) => events.push(event),
  accessMode: 'full-access',
  ...extra,
});

await test('stock by default; built-ins listed', async () => {
  const snapshot = await store.listThemes();
  assert.equal(snapshot.activeId, null);
  assert.equal(snapshot.themes.filter((theme) => theme.builtIn).length, BUILTIN_THEMES.length);
});

let firstId;
await test('set_app_theme starts a working theme, applies it, leaves a card, unsaved', async () => {
  const result = await runThemeTool('set_app_theme', { name: 'Neon Sunset', tokens: { accent: '#ff4fd8' } }, context('thread-a'));
  assert.equal(result.ok, true, result.text);
  const snapshot = await store.listThemes();
  const theme = snapshot.themes.find((entry) => entry.name === 'Neon Sunset');
  assert.ok(theme);
  firstId = theme.id;
  assert.equal(snapshot.activeId, theme.id);
  assert.equal(theme.saved, false);
  assert.equal(theme.threadId, 'thread-a');
  assert.match(result.text, /not saved yet/);
  const card = events.at(-1);
  assert.equal(card.activity.kind, 'theme');
  assert.equal(card.activity.theme.id, theme.id);
  assert.equal(card.runId, 'run-thread-a');
  assert.ok(broadcasts.length > 0);
});

await test('later calls in the same thread change the same theme; save keeps it', async () => {
  const result = await runThemeTool('set_app_theme', { tokens: { 'bg-base': '#0b0717' }, save: true }, context('thread-a'));
  assert.equal(result.ok, true, result.text);
  const theme = await store.getTheme(firstId);
  assert.equal(theme.tokens.accent, '#ff4fd8');
  assert.equal(theme.tokens['bg-base'], '#0b0717');
  assert.equal(theme.saved, true);
  assert.equal(theme.revision, 2);
  assert.equal(await store.canUndoTheme(firstId), true);
  const undone = await store.undoTheme(firstId);
  assert.equal(undone.tokens['bg-base'], undefined);
  assert.equal(undone.saved, true, 'undo keeps the save state');
});

await test('overlapping undos and edits stay consistent (one change at a time)', async () => {
  await runThemeTool('set_app_theme', { tokens: { warning: '#111111' } }, context('thread-a'));
  await runThemeTool('set_app_theme', { tokens: { warning: '#222222' } }, context('thread-a'));
  const before = await store.getTheme(firstId);
  assert.equal(before.tokens.warning, '#222222');
  await Promise.all([store.undoTheme(firstId), store.undoTheme(firstId)]);
  const after = await store.getTheme(firstId);
  assert.equal(after.tokens.warning, undefined, 'two undos step back two revisions');
});

await test('another thread starts its own theme from the look in use', async () => {
  await runThemeTool('set_app_theme', { tokens: { danger: '#ff0000' } }, context('thread-b'));
  const working = await store.workingThemeFor('thread-b');
  assert.ok(working && working.id !== firstId);
  assert.equal(working.tokens.accent, '#ff4fd8', 'copied from the active theme');
  assert.equal(working.name, 'Neon Sunset remix');
  const fresh = await runThemeTool('set_app_theme', { start_from: 'stock', name: 'Clean' }, context('thread-b'));
  assert.equal(fresh.ok, true);
  const clean = await store.workingThemeFor('thread-b');
  assert.equal(clean.name, 'Clean');
  assert.deepEqual(clean.tokens, {});
});

await test('backdrop image_path copies the file into the theme', async () => {
  const image = path.join(dir, 'wallpaper.png');
  await fs.writeFile(image, Buffer.from([137, 80, 78, 71]));
  const result = await runThemeTool('set_app_theme', { backdrop: { type: 'image', image_path: image, dim: 0.3 } }, context('thread-c'));
  assert.equal(result.ok, true, result.text);
  const theme = await store.workingThemeFor('thread-c');
  assert.equal(theme.backdrop.type, 'image');
  assert.match(theme.backdrop.asset, /^backdrop-.*\.png$/);
  await fs.access(path.join(dir, theme.id, theme.backdrop.asset));
});

await test('screenshot comes back as an image block', async () => {
  const result = await runThemeTool('get_app_theme', { screenshot: true }, context('thread-c'));
  assert.equal(result.ok, true);
  assert.equal(result.content.find((block) => block.type === 'image').mimeType, 'image/jpeg');
  assert.match(result.text, /working theme/);
});

await test('generate_theme_media: Durango inference image becomes the backdrop', async () => {
  setThemeToolsClient({
    generateImage: async ({ model, prompt }) => {
      assert.equal(model, 'google/gemini-3.1-flash-image-preview');
      assert.ok(prompt.includes('forest'));
      return { data: Buffer.from([1, 2, 3]), mimeType: 'image/png', creditsUsed: 4 };
    },
  });
  const result = await runThemeTool('generate_theme_media', { prompt: 'misty forest' }, context('thread-d'));
  assert.equal(result.ok, true, result.text);
  const theme = await store.workingThemeFor('thread-d');
  assert.equal(theme.backdrop.type, 'image');
  assert.equal(theme.backdrop.dim, 0.35);
  const readOnly = await runThemeTool('generate_theme_media', { prompt: 'x' }, context('thread-d', { accessMode: 'read-only' }));
  assert.equal(readOnly.ok, false);
});

await test('generate_theme_media: video polls until done', async () => {
  let polls = 0;
  setThemeToolsClient({
    startVideoGeneration: async () => ({ runId: 'run1' }),
    videoGeneration: async () => (++polls < 2 ? { status: 'running', videoUrls: [] } : { status: 'completed', videoUrls: ['https://durango.sh/api/v1/videos/v1'], creditsUsed: 30 }),
    downloadGeneratedMedia: async () => ({ data: Buffer.from([0, 0, 0, 24]), mimeType: 'video/mp4' }),
  });
  // Poll interval is real time; keep the test fast by aborting nothing and waiting.
  const result = await runThemeTool('generate_theme_media', { prompt: 'rain', kind: 'video' }, context('thread-e'));
  assert.equal(result.ok, true, result.text);
  const theme = await store.workingThemeFor('thread-e');
  assert.equal(theme.backdrop.type, 'video');
  assert.match(theme.backdrop.asset, /\.mp4$/);
});

await test('switch, duplicate, delete, and stock is always reachable', async () => {
  await store.setActiveTheme('builtin-' + BUILTIN_THEMES[0].id.replace(/^builtin-/, ''));
  assert.equal((await store.listThemes()).activeId, BUILTIN_THEMES[0].id);
  const copy = await store.duplicateTheme(BUILTIN_THEMES[0].id);
  assert.equal(copy.builtIn, undefined);
  assert.equal(copy.saved, true);
  await store.setActiveTheme(copy.id);
  await store.deleteTheme(copy.id);
  assert.equal((await store.listThemes()).activeId, null, 'deleting the active theme returns to stock');
  await assert.rejects(store.deleteTheme(BUILTIN_THEMES[0].id));
  await store.setActiveTheme(firstId);
  await store.setActiveTheme('stock');
  assert.equal((await store.listThemes()).activeId, null);
});

await test('state survives a restart; unsaved drafts are kept while recent', async () => {
  await store.setActiveTheme(firstId);
  store.configureThemeStore({ dir, send: () => {} });
  const snapshot = await store.listThemes();
  assert.equal(snapshot.activeId, firstId);
  assert.ok(snapshot.themes.some((theme) => theme.threadId === 'thread-b'));
});

await test('tool schemas: one source for Claude and the bridge; read-only drops generation', async () => {
  assert.deepEqual([...ORION_THEME_TOOL_NAMES], [...THEME_TOOL_NAMES]);
  assert.deepEqual(themeMcpToolDefinitions('full-access').map((tool) => tool.name), [...THEME_TOOL_NAMES]);
  assert.ok(!themeMcpToolDefinitions('read-only').some((tool) => tool.name === 'generate_theme_media'));
  assert.ok(!orionThemeToolNamesForAccessMode('read-only').includes('generate_theme_media'));
  for (const mode of ['read-only', 'workspace-write', 'full-access']) {
    assert.equal(isPreapprovedOrionTool('set_app_theme', mode), true, `set_app_theme in ${mode}`);
    assert.equal(isPreapprovedOrionTool('get_app_theme', mode), true);
  }
  assert.equal(isPreapprovedOrionTool('generate_theme_media', 'read-only'), false);
  assert.equal(isPreapprovedOrionTool('generate_theme_media', 'workspace-write'), true);
  for (const name of THEME_TOOL_NAMES) assert.equal(THEME_TOOL_INPUT_SCHEMAS[name].type, 'object');
  const noThread = await runThemeTool('set_app_theme', {}, { threadId: '' });
  assert.equal(noThread.ok, false);
});

await fs.rm(dir, { recursive: true, force: true });
console.log(`ui themes: ${passed} checks passed`);
