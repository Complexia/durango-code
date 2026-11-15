// Themes (Settings → Themes): the shared format (src/ui-themes.js),
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
  THEME_SCENE_BOOTSTRAP,
  THEME_SCENE_SOURCE,
  THEME_SLOTS,
  THEME_TOKENS,
  THEME_UI_MAP_SCRIPT,
  buildSceneDocument,
  checkThemeValuePatch,
  effectiveBackdrop,
  mergeTheme,
  resolveThemeValues,
  themeValuesCss,
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

await test('a returned screenshot is refused as a backdrop; dim without image_path keeps the picture', async () => {
  // What happened: generate_theme_media with screenshot: true, Claude saved the
  // screenshot under tool-results/, and the agent passed it as image_path.
  const generated = await runThemeTool('generate_theme_media', { prompt: 'misty forest', screenshot: true }, context('thread-d'));
  assert.equal(generated.ok, true, generated.text);
  const before = await store.workingThemeFor('thread-d');
  const shot = generated.content.find((block) => block.type === 'image');
  const saved = path.join(dir, 'mcp-orion-blob-1.jpg');
  await fs.writeFile(saved, Buffer.from(shot.data, 'base64'));
  const refused = await runThemeTool('set_app_theme', { backdrop: { type: 'image', image_path: saved, dim: 0.05 } }, context('thread-d'));
  assert.equal(refused.ok, false);
  assert.match(refused.text, /screenshot of Durango Code/);
  assert.equal((await store.workingThemeFor('thread-d')).revision, before.revision, 'nothing changed');
  const tuned = await runThemeTool('set_app_theme', { backdrop: { dim: 0.05, saturate: 1.1 } }, context('thread-d'));
  assert.equal(tuned.ok, true, tuned.text);
  const after = await store.workingThemeFor('thread-d');
  assert.equal(after.backdrop.asset, before.backdrop.asset);
  assert.equal(after.backdrop.dim, 0.05);
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

// --- values and controls -----------------------------------------------------------

const SNOW = {
  values: {
    snow: { type: 'boolean', default: true, label: 'Snow' },
    time: { type: 'choice', options: [{ value: 'day', icon: 'sun' }, { value: 'night', icon: 'moon' }], default: 'day' },
    glow: { min: 0, max: 1, step: 0.05, default: 0.6 },
  },
  controls: [
    { id: 'snow', kind: 'toggle', icon: 'snowflake', placement: { slot: 'titlebar-right' } },
    { id: 'time', kind: 'choice', placement: { selector: '.composer-controls .model-trigger', position: 'before' } },
    { id: 'glow', kind: 'slider', placement: { position: 'float', corner: 'bottom-left', x: 12, y: 12 } },
    { id: 'burst', kind: 'button', icon: 'sparkles', action: 'burst', set: { snow: true } },
    { id: 'clock', kind: 'html', html: '<b>12:00</b>', width: 60, height: 24, placement: { slot: 'sidebar-bottom' } },
  ],
};

await test('values and controls: declared, checked, and tied together', () => {
  const theme = sanitizeTheme({ id: 'tv1', name: 'Snow', ...SNOW });
  assert.deepEqual(Object.keys(theme.values), ['snow', 'time', 'glow']);
  assert.equal(theme.values.glow.type, 'number', 'type inferred from min/max');
  assert.deepEqual(theme.controls.map((control) => control.id), ['snow', 'time', 'glow', 'burst', 'clock']);
  assert.equal(theme.controls[0].value, 'snow');
  assert.deepEqual(theme.controls[0].placement, { slot: 'titlebar-right', position: 'end' });
  assert.equal(theme.controls[2].placement.position, 'float');
  assert.equal(theme.controls[3].placement.position, 'float', 'no slot or selector floats over the window');
  assert.deepEqual(theme.controls[3].set, { snow: true });
  assert.equal(theme.controls[4].width, 60);
  // A control needs a value of its kind; a selector can never become a rule.
  const bad = sanitizeTheme({
    id: 'tv2',
    name: 'x',
    values: SNOW.values,
    controls: [
      { id: 'a', kind: 'slider', value: 'snow' },
      { id: 'b', kind: 'toggle' },
      { id: 'c', kind: 'toggle', value: 'snow', placement: { selector: 'body} * { display:none' } },
      { id: 'Bad Id', kind: 'toggle', value: 'snow' },
      { id: 'd', kind: 'button' },
    ],
  });
  assert.deepEqual(bad.controls.map((control) => control.id), ['c']);
  assert.equal(bad.controls[0].placement.selector, undefined);
  assert.equal(bad.controls[0].placement.position, 'float');
  assert.equal(sanitizeTheme({ id: 'tv3', name: 'x', values: { 'Bad Name': { default: true }, ok: { default: false } } }).values.ok.type, 'boolean');
});

await test('values resolve against their declarations; CSS and attributes follow', () => {
  const theme = sanitizeTheme({ id: 'tv1', name: 'Snow', ...SNOW });
  assert.deepEqual(resolveThemeValues(theme, {}), { snow: true, time: 'day', glow: 0.6 });
  assert.deepEqual(resolveThemeValues(theme, { snow: 'false', time: 'dusk', glow: 7, extra: 1 }), { snow: false, time: 'day', glow: 1 });
  const { values, ignored } = checkThemeValuePatch(theme, { time: 'night', glow: 'loud', nope: true, snow: null });
  assert.deepEqual(values, { time: 'night', snow: true });
  assert.equal(ignored.length, 2);
  const css = themeValuesCss({ snow: false, time: 'night"; } body { x', glow: 0.25 });
  assert.match(css, /--tv-snow: 0;/);
  assert.match(css, /--tv-glow: 0\.25;/);
  assert.ok(!/[;{}]\s*body/.test(css.replace(/--tv-time: "[^"]*";/, '')), 'a choice cannot leave its declaration');
  assert.match(css, /--tv-time: "night  body  x";/);
});

await test('backdrop variants follow the values', () => {
  const theme = sanitizeTheme({
    id: 'tv4',
    name: 'x',
    values: SNOW.values,
    backdrop: {
      type: 'image',
      asset: 'day.jpg',
      dim: 0.3,
      variants: [
        { when: { time: 'night' }, asset: 'night.jpg', dim: 0.5 },
        { when: { time: 'night', snow: false }, type: 'css', css: '#000' },
        { when: {}, asset: 'never.jpg' },
        { when: { time: 'x' }, asset: '../escape.jpg' },
      ],
    },
  });
  assert.equal(theme.backdrop.variants.length, 2);
  assert.equal(effectiveBackdrop(theme.backdrop, { time: 'day' }).asset, 'day.jpg');
  assert.deepEqual(effectiveBackdrop(theme.backdrop, { time: 'night', snow: true }), { type: 'image', asset: 'night.jpg', dim: 0.5 });
  assert.equal(effectiveBackdrop(theme.backdrop, { time: 'night', snow: false }).asset, 'night.jpg', 'first match wins');
  // A dim tweak to the base keeps the variants.
  const { theme: tuned } = mergeTheme(theme, { backdrop: { dim: 0.1 } });
  assert.equal(tuned.backdrop.dim, 0.1);
  assert.equal(tuned.backdrop.variants.length, 2);
  const { theme: cleared } = mergeTheme(theme, { backdrop: { variants: [] } });
  assert.equal(cleared.backdrop.variants, undefined);
});

await test('mergeTheme: controls by id, remove, values by name', () => {
  const base = sanitizeTheme({ id: 'tv5', name: 'x', ...SNOW });
  const { theme, ignored } = mergeTheme(base, {
    values: { glow: null, wind: { type: 'number', min: 0, max: 10, default: 2 } },
    controls: [
      { id: 'snow', kind: 'toggle', icon: 'cloud-snow', placement: { slot: 'sidebar-top' } },
      { id: 'burst', remove: true },
      { id: 'wind', kind: 'slider', width: 120 },
      { id: 'oops', kind: 'toggle', value: 'missing' },
    ],
  });
  assert.equal(theme.controls.find((control) => control.id === 'snow').icon, 'cloud-snow');
  assert.ok(!theme.controls.some((control) => control.id === 'burst'));
  assert.ok(!theme.controls.some((control) => control.id === 'glow'), 'a control whose value went away goes too');
  assert.equal(theme.controls.find((control) => control.id === 'wind').width, 120);
  assert.match(ignored.join(' '), /oops.*declare value "missing"/);
  const { theme: none } = mergeTheme(theme, { controls: null, values: null });
  assert.equal(none.controls, undefined);
  assert.equal(none.values, undefined);
});

await test('scene messages: set, action, resize are checked', () => {
  const S = THEME_SCENE_SOURCE;
  assert.deepEqual(parseSceneMessage({ source: S, type: 'set', name: 'snow', value: false }), { type: 'set', name: 'snow', value: false });
  assert.equal(parseSceneMessage({ source: S, type: 'set', name: 'snow', value: { a: 1 } }), null);
  assert.equal(parseSceneMessage({ source: S, type: 'set', name: '__proto__', value: 1 }), null);
  assert.deepEqual(parseSceneMessage({ source: S, type: 'action', name: 'burst', detail: { n: 3 } }), { type: 'action', name: 'burst', detail: { n: 3 } });
  assert.deepEqual(parseSceneMessage({ source: S, type: 'resize', width: 5000, height: 2 }), { type: 'resize', width: 2000, height: 8 });
  assert.ok(THEME_SCENE_BOOTSTRAP.includes('set:function') && THEME_SCENE_BOOTSTRAP.includes('"value"'));
  new Function(THEME_SCENE_BOOTSTRAP);
  new Function(`return ${THEME_UI_MAP_SCRIPT}`);
  assert.ok(Object.keys(THEME_SLOTS).includes('composer-toolbar'));
});

await test('store: the user\'s choice is kept per theme, outside the theme, and survives a restart', async () => {
  store.configureThemeStore({ dir, send: (snapshot) => broadcasts.push(snapshot) });
  const { theme } = await store.updateTheme({ patch: { name: 'Snow controls', ...SNOW }, threadId: 'thread-v' });
  assert.deepEqual((await store.listThemes()).values[theme.id], { snow: true, time: 'day', glow: 0.6 });
  const before = theme.revision;
  const result = await store.setThemeValues(theme.id, { time: 'night', glow: 0.2, nope: 1 });
  assert.deepEqual(result.values, { snow: true, time: 'night', glow: 0.2 });
  assert.equal(result.ignored.length, 1);
  assert.equal((await store.getTheme(theme.id)).revision, before, 'a value change is not a theme revision');
  assert.deepEqual(broadcasts.at(-1).values[theme.id].time, 'night');
  const state = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(state.values[theme.id], { time: 'night', glow: 0.2 });
  store.configureThemeStore({ dir, send: (snapshot) => broadcasts.push(snapshot) });
  assert.equal((await store.themeValuesFor(theme.id)).time, 'night');
  await store.setThemeValues(theme.id, { time: 'day' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')).values[theme.id], { glow: 0.2 }, 'defaults are not stored');
  await store.resetThemeValues(theme.id);
  assert.equal((await store.themeValuesFor(theme.id)).glow, 0.6);
  await store.deleteTheme(theme.id);
});

await test('set_app_theme: values, controls, set_values and a variant from a file', async () => {
  const night = path.join(dir, 'night.png');
  await fs.writeFile(night, Buffer.from([137, 80, 78, 71, 1]));
  const placedSender = {
    ...sender,
    executeJavaScript: async (script) => (script.includes('data-theme-control') && !script.includes('MAX_LINES') ? { snow: [[900, 8, 30, 30]], time: [null] } : 'Window 1440x900\n◆ slot titlebar-right'),
  };
  const ctx = context('thread-w', { getSender: () => placedSender });
  const result = await runThemeTool(
    'set_app_theme',
    {
      name: 'Snowfall',
      ...SNOW,
      backdrop: { type: 'css', css: '#123', variants: [{ when: { time: 'night' }, image_path: night, dim: 0.4 }] },
      set_values: { time: 'night', snow: 'maybe' },
    },
    ctx
  );
  assert.equal(result.ok, true, result.text);
  const theme = await store.workingThemeFor('thread-w');
  assert.equal(theme.controls.length, 5);
  assert.equal(theme.backdrop.type, 'css');
  assert.match(theme.backdrop.variants[0].asset, /^backdrop-.*\.png$/);
  await fs.access(path.join(dir, theme.id, theme.backdrop.variants[0].asset));
  assert.equal((await store.themeValuesFor(theme.id)).time, 'night');
  assert.match(result.text, /set_values snow/, 'a bad value is reported');
  assert.match(result.text, /snow \(toggle → snow\) in slot titlebar-right — on screen \[900,8 30x30\]/);
  assert.match(result.text, /time \(choice → time\) before ".composer-controls .model-trigger" — placed but not visible/);
  assert.match(result.text, /clock \(html\) in slot sidebar-bottom — not on screen now/);
  const read = await runThemeTool('get_app_theme', { ui_map: true }, ctx);
  assert.match(read.text, /Values \(current\): snow = true .*time = "night"/);
  assert.match(read.text, /UI map:\nWindow 1440x900/);
  assert.match(read.text, /Theme slots for controls: titlebar-left/);
  const ignored = await runThemeTool('set_app_theme', { controls: [{ id: 'x', kind: 'menu', value: 'snow' }] }, ctx);
  assert.match(ignored.text, /control "x" \(value "snow" is boolean; a menu needs a choice value\)/);
});

await test('generate_theme_media variant_when adds a variant and keeps the backdrop', async () => {
  setThemeToolsClient({ generateImage: async () => ({ data: Buffer.from([9, 9, 9]), mimeType: 'image/png', creditsUsed: 4 }) });
  const before = await store.workingThemeFor('thread-w');
  const result = await runThemeTool('generate_theme_media', { prompt: 'same forest at night', variant_when: { time: 'night' } }, context('thread-w'));
  assert.equal(result.ok, true, result.text);
  const after = await store.workingThemeFor('thread-w');
  assert.equal(after.backdrop.css, before.backdrop.css, 'main backdrop unchanged');
  assert.equal(after.backdrop.variants.length, 1, 'the variant for the same condition is replaced');
  assert.notEqual(after.backdrop.variants[0].asset, before.backdrop.variants[0].asset);
  assert.match(result.text, /backdrop variant shown while time = "night"/);
  assert.ok(!/It is the backdrop now/.test(result.text));
  const undeclared = await runThemeTool('generate_theme_media', { prompt: 'storm', variant_when: { weather: 'storm' } }, context('thread-w'));
  assert.match(undeclared.text, /Declare weather in values/);
});

// --- review fixes ---------------------------------------------------------------------

await test('inherited names are never value declarations ("constructor", __proto__)', () => {
  const theme = sanitizeTheme({
    id: 'tv6',
    name: 'x',
    values: { snow: { default: true } },
    controls: [
      { id: 'a', kind: 'button', icon: 'x', set: { constructor: true, snow: false } },
      { id: 'constructor', kind: 'toggle' },
      { id: 'b', kind: 'toggle', value: 'constructor' },
    ],
  });
  assert.deepEqual(theme.controls.map((control) => control.id), ['a']);
  assert.deepEqual(theme.controls[0].set, { snow: false });
  const patch = checkThemeValuePatch(theme, JSON.parse('{"constructor": true, "__proto__": 1, "snow": true}'));
  assert.deepEqual(patch.values, { snow: true });
  assert.equal(patch.ignored.length, 2);
  // A declared "constructor" value is a real, own declaration.
  const own = sanitizeTheme({ id: 'tv7', name: 'x', values: { constructor: { default: false } }, controls: [{ id: 'constructor', kind: 'toggle' }] });
  assert.equal(own.controls.length, 1);
  assert.deepEqual(resolveThemeValues(own, {}), { constructor: false });
});

await test('scenes and widgets get their values at load, through state and value listeners', async () => {
  const vm = await import('node:vm');
  const sent = [];
  const listeners = [];
  const parent = { postMessage: (message) => sent.push(message) };
  const window = {
    parent,
    addEventListener: (type, fn) => type === 'message' && listeners.push(fn),
  };
  window.window = window;
  vm.runInNewContext(THEME_SCENE_BOOTSTRAP, window);
  const seen = [];
  window.durango.on('value', (detail) => seen.push(['value', detail.values.snow]));
  window.durango.on('state', (state) => seen.push(['state', state.values.snow]));
  for (const fn of listeners) {
    fn({ source: parent, data: { source: THEME_SCENE_SOURCE, type: 'event', event: 'state', detail: { values: { snow: false }, working: false } } });
  }
  assert.deepEqual(seen, [['state', false], ['value', false]]);
  assert.equal(window.durango.values.snow, false);
  window.durango.set('snow', true);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: 'set', name: 'snow', value: true, source: THEME_SCENE_SOURCE });
});

await test('backdrop variants past the limit are reported, and generation refuses before spending', async () => {
  const many = Array.from({ length: 9 }, (_, index) => ({ when: { glow: index }, type: 'css', css: '#000' }));
  const { ignored } = mergeTheme(sanitizeTheme({ id: 'tv8', name: 'x', backdrop: { type: 'css', css: '#111' } }), { backdrop: { variants: many } });
  assert.match(ignored.join(' '), /past the first 8/);
  const ctx = context('thread-x');
  await runThemeTool('set_app_theme', { values: { glow: { min: 0, max: 10, default: 0 } }, backdrop: { type: 'css', css: '#111', variants: many.slice(0, 8) } }, ctx);
  let generated = 0;
  setThemeToolsClient({ generateImage: async () => (generated++, { data: Buffer.from([1]), mimeType: 'image/png' }) });
  const full = await runThemeTool('generate_theme_media', { prompt: 'x', variant_when: { glow: 9 } }, ctx);
  assert.equal(full.ok, false);
  assert.match(full.text, /already has 8 variants/);
  const replace = await runThemeTool('generate_theme_media', { prompt: 'x', variant_when: { glow: 3 } }, ctx);
  assert.equal(replace.ok, true, 'replacing an existing condition is fine');
  const badWhen = await runThemeTool('generate_theme_media', { prompt: 'x', variant_when: { 'Bad Name': 1 } }, ctx);
  assert.equal(badWhen.ok, false);
  assert.equal(generated, 1, 'refusals spend nothing');
});

await fs.rm(dir, { recursive: true, force: true });
console.log(`ui themes: ${passed} checks passed`);
