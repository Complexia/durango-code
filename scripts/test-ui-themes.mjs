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
import vm from 'node:vm';
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
import { backdropVideoNote, probeVideo } from '../src/main/video-probe.js';
import {
  THEME_TOOL_INPUT_SCHEMAS,
  THEME_TOOL_NAMES,
  performanceNotes,
  runThemeTool,
  setThemeToolsClient,
  setThemeToolsMetrics,
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

  // Multi-pass splice bypasses, unclosed rules/tags, and extra resource functions.
  const bypasses = sanitizeThemeCss(
    [
      '@imp@namespace;ort "https://evil.example/splice1.css";',
      '@imp@font-face{}ort "https://evil.example/splice2.css";',
      '@im/*comment*/port "https://evil.example/splice3.css";',
      '@im@imp@namespace;ort;port "https://evil.example/nested.css";',
      '@import url("https://evil.example/semi;colon.css");',
      '@font-face { font-family: x; a: { } src: url("https://evil.example/f.woff2"); }',
      '@font-face { src: url("https://evil.example/unclosed.woff2")',
      '</st@namespace;yle><script>alert(1)</script>',
      '</style',
      '.i{background:image("https://evil.example/img4.png")}',
      '.j{background:-webkit-cross-fade(url(https://evil.example/cf.png), red)}',
      '.k{width:expression(alert(1))}',
      '.l{background:u\u0000rl(https://evil.example/nul.png)}',
      '.m{color:red}\\',
    ].join('\n')
  );
  assert.ok(!/@import/i.test(bypasses), `no @import survives: ${bypasses}`);
  assert.ok(!/@namespace/i.test(bypasses), `no @namespace survives: ${bypasses}`);
  assert.ok(!/@font-face/i.test(bypasses), `no @font-face survives: ${bypasses}`);
  assert.ok(!/<\/?style/i.test(bypasses), `no style tag survives: ${bypasses}`);
  assert.ok(!/\b(?:url|image-set|cross-fade|image|src|expression)\s*\(/i.test(bypasses), `no loader survives: ${bypasses}`);
  assert.ok(!/[\\\u0000]/.test(bypasses), `no backslash or NUL survives: ${bypasses}`);
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
const sent = [];
const sender = {
  isDestroyed: () => false,
  isFocused: () => true,
  send: (channel) => sent.push(channel),
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

await test('manage_app_themes: everything Settings → Customizations does', async () => {
  store.configureThemeStore({ dir, send: (snapshot) => broadcasts.push(snapshot) });
  const manage = (args, thread = 'thread-m') => runThemeTool('manage_app_themes', args, context(thread));
  const list = await manage({ action: 'list' });
  assert.equal(list.ok, true, list.text);
  assert.match(list.text, /"Neon Sunset" \(t[a-z0-9]+\) · saved · IN USE/);
  assert.match(list.text, /Animated backdrops and effects: on/);

  // Apply by id or unique name; stock; a built-in by name.
  assert.equal((await manage({ action: 'stock' })).ok, true);
  assert.equal((await store.listThemes()).activeId, null);
  assert.equal((await manage({ action: 'apply', theme_id: 'neon sunset' })).ok, true);
  assert.equal((await store.listThemes()).activeId, firstId);
  assert.equal((await manage({ action: 'apply', theme_id: BUILTIN_THEMES[0].name })).ok, true);
  assert.equal((await store.listThemes()).activeId, BUILTIN_THEMES[0].id);
  assert.equal((await manage({ action: 'apply', theme_id: 'nope' })).ok, false);

  // Duplicate a built-in, rename, unsave/save, undo after an in-place edit, delete.
  const dup = await manage({ action: 'duplicate', theme_id: BUILTIN_THEMES[0].id, name: 'Mine' });
  assert.equal(dup.ok, true, dup.text);
  const mine = (await store.listThemes()).themes.find((theme) => theme.name === 'Mine');
  assert.ok(mine && mine.saved);
  assert.equal((await manage({ action: 'rename', theme_id: mine.id, name: 'Mine too' })).ok, true);
  assert.equal((await store.getTheme(mine.id)).name, 'Mine too');
  assert.equal((await manage({ action: 'rename', theme_id: BUILTIN_THEMES[0].id, name: 'x' })).ok, false);
  assert.equal((await manage({ action: 'unsave', theme_id: mine.id })).ok, true);
  assert.equal((await store.getTheme(mine.id)).saved, false);
  assert.equal((await manage({ action: 'save', theme_id: mine.id })).ok, true);
  assert.equal((await store.getTheme(mine.id)).saved, true);

  // set_app_theme theme_id changes that theme in place (no copy) and this thread then shapes it.
  const count = (await store.listThemes()).themes.length;
  const dangerBefore = (await store.getTheme(mine.id)).tokens.danger;
  const edit = await runThemeTool('set_app_theme', { theme_id: mine.id, tokens: { accent: '#00ff88' } }, context('thread-m'));
  assert.equal(edit.ok, true, edit.text);
  assert.equal((await store.listThemes()).themes.length, count, 'no copy');
  assert.equal((await store.getTheme(mine.id)).tokens.accent, '#00ff88');
  assert.equal((await store.workingThemeFor('thread-m')).id, mine.id);
  await runThemeTool('set_app_theme', { tokens: { danger: '#ff3355' } }, context('thread-m'));
  assert.equal((await store.getTheme(mine.id)).tokens.danger, '#ff3355', 'later calls keep shaping it');
  const builtInEdit = await runThemeTool('set_app_theme', { theme_id: BUILTIN_THEMES[0].id, tokens: { accent: '#000' } }, context('thread-m'));
  assert.equal(builtInEdit.ok, false);
  assert.match(builtInEdit.text, /duplicate/i);

  assert.equal((await manage({ action: 'undo', theme_id: mine.id })).ok, true);
  assert.equal((await store.getTheme(mine.id)).tokens.danger, dangerBefore);
  assert.equal((await store.getTheme(mine.id)).tokens.accent, '#00ff88');
  assert.equal((await store.listThemes()).activeId, mine.id);

  assert.equal((await manage({ action: 'delete', theme_id: BUILTIN_THEMES[0].id })).ok, false);
  const deleted = await manage({ action: 'delete', theme_id: mine.id });
  assert.equal(deleted.ok, true);
  assert.match(deleted.text, /Stock now/);
  assert.equal(await store.getTheme(mine.id), null);

  // Animated effects persist with the rest of the state.
  assert.equal((await manage({ action: 'animate', animate: false })).ok, true);
  assert.equal((await store.listThemes()).animate, false);
  assert.equal(broadcasts.at(-1).animate, false);
  store.configureThemeStore({ dir, send: (snapshot) => broadcasts.push(snapshot) });
  assert.equal((await store.listThemes()).animate, false, 'kept across a restart');
  assert.equal((await manage({ action: 'animate', animate: true })).ok, true);

  // Celebrate needs a theme in use and tells the window.
  assert.equal((await manage({ action: 'celebrate' })).ok, false);
  await manage({ action: 'apply', theme_id: firstId });
  assert.equal((await manage({ action: 'celebrate' })).ok, true);
  assert.equal(sent.at(-1), 'themes:celebrate');

  assert.equal((await manage({ action: 'fly' })).ok, false);
});

await test('manage_app_themes measure reports CPU per process', async () => {
  let calls = 0;
  setThemeToolsMetrics(() => {
    calls += 1;
    return [
      { pid: 1, type: 'Browser', name: '', cpu: 1.5, memoryKb: 200_000 },
      { pid: 2, type: 'GPU', name: '', cpu: 12.25, memoryKb: 300_000 },
      { pid: 3, type: 'Tab', name: '', cpu: 9, memoryKb: 100_000 },
    ];
  });
  const result = await runThemeTool('manage_app_themes', { action: 'measure', seconds: 2 }, context('thread-m'));
  assert.equal(result.ok, true, result.text);
  assert.equal(calls, 2, 'one call resets the counters, one reads them');
  assert.match(result.text, /22\.8% of one CPU core over 2s/);
  assert.match(result.text, /GPU pid 2: 12\.3%/);
  assert.match(result.text, /window focused/);
  setThemeToolsMetrics(null);
  assert.equal((await runThemeTool('manage_app_themes', { action: 'measure', seconds: 2 }, context('thread-m'))).ok, false);
});

await test('performance notes flag per-frame costs and stay quiet for a light theme', async () => {
  const heavy = sanitizeTheme({
    id: 'theavy1',
    name: 'Heavy',
    panelBlur: 14,
    backdrop: { type: 'html', html: '<canvas></canvas><script>function f(){requestAnimationFrame(f);const g=x.createRadialGradient(0,0,0,0,0,4);x.shadowBlur=8;}f();const d=devicePixelRatio;</script>' },
    css: '@keyframes glow { from { box-shadow: 0 0 4px red } to { box-shadow: 0 0 20px red } }',
  });
  const notes = performanceNotes(heavy);
  assert.match(notes, /panel_blur 14 over a html backdrop/);
  assert.match(notes, /canvas gradients/);
  assert.match(notes, /shadowBlur/);
  assert.match(notes, /document\.hidden/);
  assert.match(notes, /not focused/);
  assert.match(notes, /reducedMotion/);
  assert.match(notes, /devicePixelRatio is not capped/);
  assert.match(notes, /css animates/);
  const light = sanitizeTheme({
    id: 'tlight1',
    name: 'Light',
    panelBlur: 14,
    backdrop: { type: 'image', asset: 'backdrop-a.jpg' },
    overlay: { html: '<script>function f(){requestAnimationFrame(f);if(document.hidden)return;if(D.state.reducedMotion)return;const s=focused?33:66;}const dpr=Math.min(devicePixelRatio,1.5);</script>' },
  });
  assert.equal(performanceNotes(light), null, 'image backdrop + overlay gets static frost; a careful scene is fine');
  const setResult = await runThemeTool('set_app_theme', { start_from: 'stock', name: 'Busy', panel_blur: 10, backdrop: { type: 'html', html: '<script>requestAnimationFrame(()=>{})</script>' } }, context('thread-p'));
  assert.match(setResult.text, /Performance notes/);
});

await test('review fixes: ownership, undo, animate migration, resets, frost notes', async () => {
  store.configureThemeStore({ dir, send: (snapshot) => broadcasts.push(snapshot) });
  // A thread's stale edit after another thread took the theme over is refused.
  await runThemeTool('set_app_theme', { start_from: 'stock', name: 'Owned' }, context('thread-r1'));
  const owned = await store.workingThemeFor('thread-r1');
  const taken = await runThemeTool('set_app_theme', { theme_id: owned.id, tokens: { accent: '#abcdef' } }, context('thread-r2'));
  assert.equal(taken.ok, true, taken.text);
  await assert.rejects(store.updateTheme({ id: owned.id, patch: { tokens: { accent: '#000000' } }, threadId: 'thread-r1' }), /took this theme over/);
  assert.equal((await store.getTheme(owned.id)).tokens.accent, '#abcdef');
  // Undo keeps the new owner.
  await store.undoTheme(owned.id);
  assert.equal((await store.getTheme(owned.id)).threadId, 'thread-r2');
  assert.equal((await store.workingThemeFor('thread-r2')).id, owned.id);
  // The legacy animate value only fills a gap.
  const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'durango-themes-animate-'));
  store.configureThemeStore({ dir: fresh, send: () => {} });
  assert.equal((await store.adoptLegacyThemesAnimate(false)).animate, false, 'no stored setting: adopted');
  assert.equal((await store.adoptLegacyThemesAnimate(true)).animate, false, 'stored: ignored');
  store.configureThemeStore({ dir: fresh, send: () => {} });
  assert.equal((await store.adoptLegacyThemesAnimate(true)).animate, false, 'stored across restart: ignored');
  await store.setThemesAnimate(true);
  await fs.rm(fresh, { recursive: true, force: true });
  store.configureThemeStore({ dir, send: (snapshot) => broadcasts.push(snapshot) });
  // null resets the numeric settings, and the schemas allow it.
  await runThemeTool('set_app_theme', { surface_opacity: 0.5, base_opacity: 0.3, panel_blur: 8 }, context('thread-r2'));
  const reset = await runThemeTool('set_app_theme', { surface_opacity: null, base_opacity: null, panel_blur: null }, context('thread-r2'));
  assert.equal(reset.ok, true, reset.text);
  const after = await store.getTheme(owned.id);
  assert.equal(after.surfaceOpacity, undefined);
  assert.equal(after.baseOpacity, undefined);
  assert.equal(after.panelBlur, undefined);
  for (const key of ['surface_opacity', 'base_opacity', 'panel_blur']) {
    assert.ok(THEME_TOOL_INPUT_SCHEMAS.set_app_theme.properties[key].type.includes('null'), `${key} is nullable`);
  }
  // Frost steps aside for panel background css or contain, and the notes say so.
  const scene = '<script>function f(){requestAnimationFrame(f);if(document.hidden)return;if(D.state.reducedMotion)return;const s=focused?33:66;}</script>';
  const styled = sanitizeTheme({ id: 'tstyled1', name: 'Styled', panelBlur: 12, backdrop: { type: 'image', asset: 'backdrop-a.jpg' }, overlay: { html: scene }, css: '.sidebar { background: #123; }' });
  assert.match(performanceNotes(styled), /panel background/);
  const contain = sanitizeTheme({ id: 'tcontain1', name: 'Contain', panelBlur: 12, backdrop: { type: 'image', asset: 'backdrop-a.jpg', fit: 'contain' }, overlay: { html: scene } });
  assert.match(performanceNotes(contain), /fit is contain/);
});

await test('performance rules load with theme work, not with the tool list', async () => {
  const [getDef, setDef] = ['get_app_theme', 'set_app_theme'].map((name) => themeMcpToolDefinitions('full-access').find((tool) => tool.name === name));
  assert.ok(!setDef.description.includes('pre-rendered sprite'), 'the rules are not in the always-listed description');
  assert.match(setDef.description, /performance rules get_app_theme returns/);
  assert.match(getDef.description, /performance rules/);
  const read = await runThemeTool('get_app_theme', {}, context('thread-q'));
  assert.match(read.text, /pre-rendered sprite/);
  const first = await runThemeTool('set_app_theme', { start_from: 'stock', name: 'Quiet' }, context('thread-q'));
  assert.match(first.text, /pre-rendered sprite/, "a thread's first change repeats them");
  const second = await runThemeTool('set_app_theme', { tokens: { accent: '#123456' } }, context('thread-q'));
  assert.ok(!second.text.includes('pre-rendered sprite'), 'later changes do not');
});

await test('tool schemas: one source for Claude and the bridge; read-only drops generation', async () => {
  assert.deepEqual([...ORION_THEME_TOOL_NAMES], [...THEME_TOOL_NAMES]);
  assert.deepEqual(themeMcpToolDefinitions('full-access').map((tool) => tool.name), [...THEME_TOOL_NAMES]);
  assert.ok(!themeMcpToolDefinitions('read-only').some((tool) => tool.name === 'generate_theme_media'));
  assert.ok(!orionThemeToolNamesForAccessMode('read-only').includes('generate_theme_media'));
  for (const mode of ['read-only', 'workspace-write', 'full-access']) {
    assert.equal(isPreapprovedOrionTool('set_app_theme', mode), true, `set_app_theme in ${mode}`);
    assert.equal(isPreapprovedOrionTool('get_app_theme', mode), true);
    assert.equal(isPreapprovedOrionTool('manage_app_themes', mode), true);
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

// --- motion: video size notes, posters, frozen scenes ---------------------------------

// A minimal MP4: moov > trak > (tkhd, mdia > (mdhd, hdlr 'vide', minf > stbl > stts)).
const mp4Box = (type, ...parts) => {
  const body = Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const syntheticMp4 = ({ width, height, timescale, delta, frames = 120 }) => {
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(width * 65536, 76);
  tkhd.writeUInt32BE(height * 65536, 80);
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(timescale, 12);
  const hdlr = Buffer.alloc(24);
  hdlr.write('vide', 8, 'latin1');
  const stts = Buffer.alloc(16);
  stts.writeUInt32BE(1, 4);
  stts.writeUInt32BE(frames, 8);
  stts.writeUInt32BE(delta, 12);
  return Buffer.concat([
    mp4Box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')),
    mp4Box('moov', mp4Box('trak', mp4Box('tkhd', tkhd), mp4Box('mdia', mp4Box('mdhd', mdhd), mp4Box('hdlr', hdlr), mp4Box('minf', mp4Box('stbl', mp4Box('stts', stts)))))),
  ]);
};

await test('video probe reads size and frame rate; notes only heavy backdrops', () => {
  assert.deepEqual(probeVideo(syntheticMp4({ width: 3840, height: 2160, timescale: 60000, delta: 1000 })), { width: 3840, height: 2160, fps: 60 });
  assert.deepEqual(probeVideo(syntheticMp4({ width: 1280, height: 720, timescale: 24000, delta: 1001 })), { width: 1280, height: 720, fps: 23.98 });
  assert.match(backdropVideoNote(syntheticMp4({ width: 3840, height: 2160, timescale: 60000, delta: 1000 })), /3840×2160 at 60 fps/);
  assert.match(backdropVideoNote(syntheticMp4({ width: 1920, height: 1080, timescale: 60, delta: 1 })), /1920×1080 at 60 fps/);
  assert.equal(backdropVideoNote(syntheticMp4({ width: 1920, height: 1080, timescale: 30, delta: 1 })), null);
  assert.equal(backdropVideoNote(syntheticMp4({ width: 1280, height: 720, timescale: 24000, delta: 1001 })), null);
  assert.equal(probeVideo(Buffer.from('not a video at all, just text')), null);
  assert.equal(probeVideo(Buffer.from([0, 0, 0, 24])), null);
});

await test('a 4K60 backdrop video gets a performance note; a poster is saved once', async () => {
  const video = path.join(dir, 'big.mp4');
  await fs.writeFile(video, syntheticMp4({ width: 3840, height: 2160, timescale: 60000, delta: 1000 }));
  const result = await runThemeTool('set_app_theme', { backdrop: { type: 'video', video_path: video } }, context('thread-motion'));
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /Performance: this video is 3840×2160 at 60 fps/);
  const theme = await store.workingThemeFor('thread-motion');
  assert.equal(theme.backdrop.type, 'video');
  const bytes = await store.videoForPoster(theme.id, theme.backdrop.asset);
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0, 'the posterless video comes back for a frame');
  assert.equal(await store.videoForPoster(theme.id, 'backdrop-other.mp4'), null, 'only the current backdrop');
  await assert.rejects(store.setVideoPoster(theme.id, theme.backdrop.asset, new Uint8Array(200)), /JPEG/);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
  const revision = theme.revision;
  const historyFile = path.join(dir, theme.id, 'history.json');
  const historyBefore = await fs.readFile(historyFile, 'utf8').catch(() => '');
  const poster = await store.setVideoPoster(theme.id, theme.backdrop.asset, jpeg);
  assert.match(poster, /^poster-.*\.jpg$/);
  const updated = await store.getTheme(theme.id);
  assert.equal(updated.backdrop.poster, poster);
  assert.equal(updated.backdrop.asset, theme.backdrop.asset);
  assert.equal(updated.revision, revision, 'a poster is not an edit');
  assert.equal(await fs.readFile(historyFile, 'utf8').catch(() => ''), historyBefore, 'nor an undo step');
  await fs.access(path.join(dir, theme.id, poster));
  assert.equal(await store.setVideoPoster(theme.id, theme.backdrop.asset, jpeg), null, 'a theme with a poster keeps it');
  assert.equal(await store.videoForPoster(theme.id, theme.backdrop.asset), null);
  const other = path.join(dir, 'other.mp4');
  await fs.writeFile(other, syntheticMp4({ width: 1280, height: 720, timescale: 30, delta: 1 }));
  await runThemeTool('set_app_theme', { backdrop: { video_path: other } }, context('thread-motion'));
  const swapped = await store.getTheme(theme.id);
  assert.notEqual(swapped.backdrop.asset, theme.backdrop.asset);
  assert.equal(swapped.backdrop.poster, undefined, "a new video drops the old one's poster");
  await runThemeTool('set_app_theme', { backdrop: { dim: 0.5 } }, context('thread-motion'));
  const small = path.join(dir, 'small.mp4');
  await fs.writeFile(small, syntheticMp4({ width: 1280, height: 720, timescale: 24, delta: 1 }));
  const light = await runThemeTool('set_app_theme', { backdrop: { type: 'video', video_path: small } }, context('thread-motion'));
  assert.doesNotMatch(light.text, /Performance:/);
});

await test('a paused scene freezes: animation frames held, CSS paused, videos paused', async () => {
  const frames = [];
  const nativeCancels = [];
  const listeners = {};
  const classes = new Set();
  const docListeners = {};
  const video = { paused: false, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
  const parent = { postMessage() {} };
  const sandbox = {
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: (id) => { nativeCancels.push(id); },
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    document: {
      documentElement: { classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) } },
      querySelectorAll: (selector) => (selector.split(',').includes('video') ? [video] : []),
      addEventListener: (type, fn) => { (docListeners[type] ??= []).push(fn); },
    },
    setTimeout,
    clearTimeout,
    Map,
    Array,
    Promise,
    ErrorEvent: class {},
  };
  sandbox.window = sandbox;
  sandbox.parent = parent;
  vm.createContext(sandbox);
  vm.runInContext(THEME_SCENE_BOOTSTRAP, sandbox);
  const send = (detail) => {
    for (const fn of listeners.message) fn({ source: parent, data: { source: THEME_SCENE_SOURCE, type: 'event', event: 'state', detail } });
  };
  const tick = () => {};
  sandbox.window.requestAnimationFrame(tick);
  assert.equal(frames.length, 1, 'running: frames go through');
  send({ paused: true });
  assert.equal(sandbox.durango.state.paused, true);
  sandbox.window.requestAnimationFrame(tick);
  assert.equal(frames.length, 2, 'for a second, so a still frame can draw');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.ok(classes.has('durango-paused'), 'CSS animations pause');
  assert.equal(video.paused, true, 'a playing video pauses');
  const held = sandbox.window.requestAnimationFrame(tick);
  assert.ok(held < 0 && frames.length === 2, 'frozen: the frame is held');
  const cancelled = sandbox.window.requestAnimationFrame(tick);
  sandbox.window.cancelAnimationFrame(cancelled);
  for (const fn of listeners.resize) fn();
  assert.equal(frames.length, 3, 'a resize lets one held frame run (the cancelled one does not)');
  // A held frame flushed by the resize can still be cancelled by its old id.
  const late = sandbox.window.requestAnimationFrame(() => assert.fail('a cancelled frame ran'));
  for (const fn of listeners.resize) fn();
  const flushed = frames.at(-1);
  sandbox.window.cancelAnimationFrame(late);
  assert.equal(nativeCancels.length, 1, 'cancelling a flushed frame cancels its native request');
  frames.splice(frames.indexOf(flushed), 1);
  // Media that starts playing while frozen is paused, and resumes with the rest.
  const late2 = { paused: false, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
  for (const fn of docListeners.play) fn({ target: late2 });
  assert.equal(late2.paused, true, 'a video started while frozen is paused');
  sandbox.window.requestAnimationFrame(tick);
  send({ paused: false });
  assert.equal(classes.has('durango-paused'), false);
  assert.equal(video.paused, false, 'the video plays again');
  assert.equal(late2.paused, false, 'so does the one started while frozen');
  assert.equal(frames.length, 4, 'held frames run on resume');
  frames[3](0);
  send({ paused: true });
  send({ paused: false });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(classes.has('durango-paused'), false, 'unpausing within the second cancels the freeze');
});

await fs.rm(dir, { recursive: true, force: true });
console.log(`ui themes: ${passed} checks passed`);
