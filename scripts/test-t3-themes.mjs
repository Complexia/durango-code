// T3 Code theme compatibility (src/t3-themes.js, src/t3-theme-format.js,
// src/main/theme-t3.js): import a T3 Code theme, export ours, round trips,
// and that exports follow T3 Code's own rules (version, id, name, roles,
// CSS length and its no-remote-files check). Plain Node, no network.
//
//   node --no-warnings scripts/test-t3-themes.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/main/ui-themes-store.js';
import { configureT3Themes, exportThemeToT3, importT3Theme, isT3ThemeSource, previewT3Theme, t3FileForTheme } from '../src/main/theme-t3.js';
import { T3_ROLE_VARIABLES, T3_STOCK_COLORS, T3_THEME_ROLES } from '../src/t3-theme-format.js';
import {
  T3_CSS_MAX_LENGTH,
  durangoThemeToT3,
  exportColor,
  looksLikeT3Theme,
  parseT3ThemeFile,
  rewriteT3Css,
  t3CssLoadsRemoteFiles,
  t3ThemeToDurango,
} from '../src/t3-themes.js';
import { BUILTIN_THEMES } from '../src/ui-themes-builtin.js';
import { THEME_LIMITS, sanitizeTheme, themeToCss } from '../src/ui-themes.js';
import { runThemeTool } from '../src/main/theme-tools.js';

// A T3 Code theme as T3 Code exports one (made up for this test).
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const T3_FILE = {
  version: 1,
  id: 'neon-dusk',
  name: 'Neon Dusk',
  appearance: 'dark',
  colors: {
    canvas: '#0d0b14',
    surface: '#15121f',
    surfaceRaised: '#120f1b',
    surfaceOverlay: '#1b1727',
    text: '#ece8ff',
    textMuted: '#9a93b8',
    border: '#2a2440',
    accent: '#ff4fd8',
    accentForeground: '#140010',
    secondary: '#1a1626',
    errorSurface: 'oklch(0.3 0.08 20)',
    sidebar: '#08070d',
  },
  css: [
    '[data-slot="sidebar"], [data-chat-header] { font-family: var(--font-mono, monospace); }',
    "[data-user-message-bubble] { border-radius: 4px; background: var(--accent); color: var(--foreground); }",
    "[data-slot='composer-host'] { outline: 1px solid var(--app-theme-accent); }",
    '[data-chat-composer-form] { box-shadow: 0 0 24px var(--ring) !important; }',
    '.dark [data-workspace-area="conversation"] { background: #000 url("' + PIXEL + '") center / cover; }',
    ':root:not(.dark) .chat-markdown { color: red; }',
    '[data-timeline-row-kind="work"] { opacity: .8 } [data-thread-details-card] { display: none }',
    '@keyframes glow { from { opacity: .4 } to { opacity: 1 } } [data-slot="button"] { animation: glow 2s infinite alternate; }',
    '[data-model-picker-content] { color: lime; }',
  ].join('\n'),
};

// T3 Code's rules for a theme file (apps/web/src/themePalette.ts parseThemeFile;
// colors: literal CSS colors, which T3 parses with culori).
const COLOR_LITERAL = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]*\))$/i;
const assertT3Valid = (file, label) => {
  assert.equal(file.version, 1, `${label}: version`);
  assert.ok(typeof file.name === 'string' && file.name.trim() && file.name.trim().length <= 48, `${label}: name`);
  assert.ok(file.appearance === 'light' || file.appearance === 'dark', `${label}: appearance`);
  assert.match(file.id, /^[a-z0-9](?:[a-z0-9-]{0,47})$/, `${label}: id`);
  assert.ok(!['system', 'light', 'dark'].includes(file.id), `${label}: reserved id`);
  assert.deepEqual(Object.keys(file.colors).sort(), [...T3_THEME_ROLES].sort(), `${label}: every role`);
  for (const [role, value] of Object.entries(file.colors)) {
    assert.match(value, COLOR_LITERAL, `${label}: ${role} is a literal color`);
    assert.ok(value.length <= 64, `${label}: ${role} length`);
  }
  if (file.css !== undefined) {
    assert.ok(file.css.length <= T3_CSS_MAX_LENGTH, `${label}: css length`);
    assert.ok(!file.css.includes('\\'), `${label}: no backslashes`);
    assert.equal(t3CssLoadsRemoteFiles(file.css), false, `${label}: css loads nothing`);
  }
};

// --- parsing ---------------------------------------------------------------------------
assert.ok(looksLikeT3Theme(T3_FILE));
assert.ok(!looksLikeT3Theme({ name: 'x', appearance: 'dark', tokens: {} }), 'a Durango theme is not a T3 one');
assert.throws(() => parseT3ThemeFile('nope'), /not JSON/);
assert.throws(() => parseT3ThemeFile({ name: 'x', appearance: 'dim', colors: { canvas: '#000' } }), /appearance/);
assert.throws(() => parseT3ThemeFile({ name: 'x', appearance: 'dark' }), /needs colors/);
assert.throws(() => parseT3ThemeFile({ version: 2, name: 'x', appearance: 'dark', colors: { canvas: '#000' } }), /version/);
const env = parseT3ThemeFile({ name: 'Nightfall', appearance: 'dark', canvas: '#1a1b26', accent: '#7aa2f7', colors: { error: '#f7768e', nope: '#fff', canvasX: 1 } });
assert.equal(env.canvas, '#1a1b26');
assert.deepEqual(env.colors, { error: '#f7768e' });
assert.equal(exportColor('rgb(255 255 255 / 8%)'), '#ffffff14');
assert.equal(exportColor('linear-gradient(180deg, #141416 0%, #111113 100%)'), '#141416');
assert.equal(exportColor('color-mix(in srgb, red 10%, blue)'), null);
assert.equal(exportColor('RebeccaPurple'), 'rebeccapurple', 'named colors export');
assert.equal(exportColor(`oklch(0.62 0.2 280 / ${'0'.repeat(60)}.5)`), null, 'longer than T3 allows');
assert.equal(durangoThemeToT3(sanitizeTheme({ id: 'tnamed', name: 'N', tokens: { accent: 'red' } })).file.colors.accent, 'red');

// --- T3 → Durango -------------------------------------------------------------------------
const patch = t3ThemeToDurango(T3_FILE);
const imported = sanitizeTheme({ id: 'timported', saved: true, ...patch });
assert.equal(imported.name, 'Neon Dusk');
assert.equal(imported.tokens['bg-base'], '#0d0b14');
assert.equal(imported.tokens.accent, '#ff4fd8');
assert.equal(imported.tokens['bg-raised'], '#120f1b');
assert.equal(Object.keys(imported.compat.t3.colors).length, T3_THEME_ROLES.length, 'every role kept, stock filling the rest');
assert.equal(imported.compat.t3.colors.terminalCursor, T3_STOCK_COLORS.dark.terminalCursor);
const css = imported.css;
assert.ok(css.includes(':is(.sidebar, [data-t3-hook="data-slot-sidebar"])'), 'sidebar hook → ours');
assert.ok(css.includes(':is(.message.user, [data-t3-hook="data-user-message-bubble"])'), 'bubble hook → ours');
assert.ok(css.includes(':is(.composer-shell, [data-t3-hook="data-slot-composer-host"])'), "single-quoted hook → ours");
assert.ok(css.includes('var(--t3-accent)') && css.includes('var(--t3-foreground)') && css.includes('var(--t3-ring)'), 'shadcn variables renamed');
assert.ok(!/var\(--accent\)/.test(css), 'never our --accent');
assert.ok(css.includes('var(--app-theme-accent)'), 'theme variables stay');
assert.ok(css.includes(':is(:root, [data-t3-hook="dark"]) :is(.thread-pane'), '.dark matches a dark theme');
assert.ok(css.includes(':root:not(:is(:root, [data-t3-hook="dark"])) :is(.markdown-content'), ':root:not(.dark) never matches');
assert.ok(css.includes('[data-thread-details-card]') === false && css.includes('[data-t3-hook="data-thread-details-card"]'), 'no-counterpart hook stays inert');
assert.ok(css.includes('[data-model-picker-content]'), 'T3-only selectors stay (and never match)');
assert.ok(css.includes(PIXEL), 'data: pictures survive our sanitizer');
const full = themeToCss(imported);
assert.ok(full.includes(`${T3_ROLE_VARIABLES.canvas}: var(--bg-base, #0d0b14);`), 'canvas follows our token');
assert.ok(full.includes(`${T3_ROLE_VARIABLES.errorSurface}: oklch(0.3 0.08 20);`), 'unmapped roles keep their color');
assert.ok(full.includes('--t3-accent: var(--app-theme-accent-surface);') && full.includes('--t3-ring: var(--app-theme-focus);'), 'shadcn aliases');
assert.ok(full.includes('--t3-destructive: var(--t3-error);'), 'aliases of aliases are prefixed too');
// A light theme: .dark never matches, :root:not(.dark) does.
const lightCss = rewriteT3Css('.dark .x { a: b } :root:not(.dark) .y { c: d }', 'light');
assert.ok(lightCss.startsWith(':is([data-t3-hook="dark"]) .x'));
// canvas + accent only: a palette derived with color-mix.
const derived = sanitizeTheme({ id: 'tderived', ...t3ThemeToDurango({ name: 'Nightfall', appearance: 'dark', canvas: '#1a1b26', accent: '#7aa2f7' }) });
assert.equal(derived.tokens['bg-base'], '#1a1b26');
assert.match(derived.tokens['bg-surface'], /^color-mix\(in oklab, #1a1b26 96%, white\)$/);

// --- round trip: T3 → Durango → T3 ------------------------------------------------------
const { file: back } = durangoThemeToT3(imported);
assertT3Valid(back, 'round trip');
assert.equal(back.css, T3_FILE.css.replace(`[data-slot='composer-host']`, '[data-slot="composer-host"]'), 'CSS comes back as written');
for (const [role, value] of Object.entries(T3_FILE.colors)) assert.equal(back.colors[role], value, `${role} comes back`);
// Edit the accent in Durango Code: the roles that follow it change, the others stay.
const edited = sanitizeTheme({ ...imported, tokens: { ...imported.tokens, accent: '#00e5ff' } });
const { file: editedBack } = durangoThemeToT3(edited);
assert.equal(editedBack.colors.accent, '#00e5ff');
assert.equal(editedBack.colors.focus, '#00e5ff');
assert.equal(editedBack.colors.canvas, '#0d0b14');
assert.equal(editedBack.colors.errorSurface, 'oklch(0.3 0.08 20)');

// Strings are text: hooks, .dark and variable names inside them stay as written, both ways.
const quoted = sanitizeTheme({ id: 'tquoted', ...t3ThemeToDurango({ ...T3_FILE, css: '[data-thread-item]::after { content: "[data-thread-item] .dark --accent"; } [data-thread-item] { color: var(--accent) }' }) });
assert.ok(quoted.css.includes('content: "[data-thread-item] .dark --accent"'), 'import leaves strings alone');
assert.ok(quoted.css.includes(':is(.thread-item, [data-t3-hook="data-thread-item"])::after'));
assert.ok(quoted.css.includes('var(--t3-accent)'));
const { file: quotedBack } = durangoThemeToT3(quoted);
assert.equal(quotedBack.css, '[data-thread-item]::after { content: "[data-thread-item] .dark --accent"; } [data-thread-item] { color: var(--accent) }', 'and so does export');
const oursQuoted = durangoThemeToT3(sanitizeTheme({ id: 'tq2', name: 'Q', css: '.sidebar::before { content: ".sidebar var(--accent)"; color: var(--accent) }' })).file;
assert.ok(oursQuoted.css.includes('[data-slot="sidebar"]::before { content: ".sidebar var(--accent)"; color: var(--dc-accent) }'));

// Light and dark versions (T3 Code's variants): kept, chosen, and exported back.
const dual = { ...T3_FILE, variants: { light: { canvas: '#fafafa', text: '#111111', accent: '#c026d3' } } };
const dualDark = sanitizeTheme({ id: 'tdual', ...t3ThemeToDurango(dual) });
assert.equal(dualDark.appearance, 'dark');
assert.equal(dualDark.compat.t3.variants.light.canvas, '#fafafa');
assert.deepEqual(durangoThemeToT3(dualDark).file.variants, { light: { canvas: '#fafafa', text: '#111111', accent: '#c026d3' } }, 'the variant goes back');
const dualLight = sanitizeTheme({ id: 'tdual2', ...t3ThemeToDurango(dual, { appearance: 'light' }) });
assert.equal(dualLight.appearance, 'light');
assert.equal(dualLight.tokens['bg-base'], '#fafafa');
assert.equal(dualLight.tokens.accent, '#c026d3');
assert.equal(dualLight.compat.t3.variants.dark.canvas, '#0d0b14', 'the original appearance becomes the variant');
assert.ok(dualLight.css.includes(':is([data-t3-hook="dark"]) :is(.thread-pane'), '.dark follows the chosen appearance');
const dualLightBack = durangoThemeToT3(dualLight).file;
assertT3Valid(dualLightBack, 'light version');
assert.equal(dualLightBack.variants.dark.canvas, '#0d0b14');

// CSS that grows past what a theme holds once mapped is refused, never cut off.
const hooky = Array.from({ length: 1200 }, (_, i) => `[data-slot="popover-popup"] .x${i}{a:b}`).join('');
assert.ok(hooky.length < 50_000);
assert.throws(() => t3ThemeToDurango({ ...T3_FILE, css: hooky }), new RegExp(`over the ${THEME_LIMITS.css.toLocaleString('en-US')}`));

// --- Durango → T3 -----------------------------------------------------------------------------
for (const builtin of BUILTIN_THEMES) {
  const theme = sanitizeTheme(builtin);
  const { file, notes } = durangoThemeToT3(theme);
  assertT3Valid(file, theme.id);
  if (theme.backdrop?.type === 'html' || theme.overlay) assert.ok(notes.some((note) => /Animated scenes/.test(note)), `${theme.id} says its scene stays`);
}
const ours = sanitizeTheme({
  id: 'tours',
  name: 'A light theme with a name far longer than forty-eight characters',
  appearance: 'light',
  tokens: { accent: '#e11d48', 'bg-base': 'linear-gradient(180deg, #fff 0%, #f5f5f5 100%)', 'border-default': 'rgb(0 0 0 / 9%)', 'font-ui': "'Avenir Next', sans-serif" },
  values: { snow: { type: 'boolean', default: true }, time: { type: 'choice', options: [{ value: 'day' }, { value: 'night' }], default: 'day' } },
  css: ':root[data-tv-snow="false"] .theme-overlay { display: none } :root[data-tv-time="day"] .sidebar { background: var(--bg-raised) } .message.user { background: var(--accent-soft); opacity: var(--tv-snow); border-radius: var(--radius-lg) } .app-shellbar { background: theme-asset("x.png") }',
  backdrop: { type: 'css', css: 'radial-gradient(circle, #fde68a, #f59e0b)', dim: 0.2 },
});
const { file: oursFile } = durangoThemeToT3(ours);
assertT3Valid(oursFile, 'ours');
assert.equal(oursFile.name.length <= 48, true);
assert.equal(oursFile.colors.canvas, '#ffffff', 'a gradient token exports its first color');
assert.equal(oursFile.colors.border, '#00000017');
assert.ok(oursFile.css.includes(':root:not(*) .theme-overlay'), 'a value other than the default never matches');
assert.ok(oursFile.css.includes(' [data-slot="sidebar"] { background: var(--dc-bg-raised) }'), 'the default value always matches');
assert.ok(oursFile.css.includes('--dc-bg-raised: var(--app-theme-surface-raised);'), 'unset tokens follow T3 roles');
assert.ok(oursFile.css.includes('--dc-accent-soft: color-mix(in srgb, var(--app-theme-accent) 14%, transparent);'));
assert.ok(oursFile.css.includes('--tv-snow: 1;'));
assert.ok(oursFile.css.includes('--font-sans: \'Avenir Next\', sans-serif;'));
assert.ok(oursFile.css.includes('[data-user-message-bubble] {') && oursFile.css.includes('[data-chat-header] { background: none }'));
assert.ok(oursFile.css.includes('[data-workspace-area="conversation"] {\n  background: linear-gradient(rgb(0 0 0 / 0.2), rgb(0 0 0 / 0.2)), radial-gradient(circle, #fde68a, #f59e0b) !important;'), 'a CSS backdrop comes along');
assert.ok(!/var\(--accent\b/.test(oursFile.css), 'our --accent never leaks into T3 (its --accent is a hover color)');
// Token values that use our variables bring them along, renamed (never T3's --accent).
const deps = durangoThemeToT3(
  sanitizeTheme({
    id: 'tdeps',
    name: 'Deps',
    tokens: { accent: '#22c55e', 'accent-soft': 'color-mix(in srgb, var(--accent) 20%, transparent)' },
    css: '.sidebar { background: var(--accent-soft) }',
    backdrop: { type: 'css', css: 'linear-gradient(var(--accent), black)' },
  })
).file;
assert.ok(deps.css.includes('--dc-accent-soft: color-mix(in srgb, var(--dc-accent) 20%, transparent);'));
assert.ok(deps.css.includes('--dc-accent: #22c55e;'), 'the dependency is defined');
assert.ok(deps.css.includes('linear-gradient(var(--dc-accent), black)'), 'a CSS backdrop is renamed too');
assert.ok(!/var\(--accent\b/.test(deps.css));
// Too long for T3 Code even without a picture: refused with a reason.
assert.throws(() => durangoThemeToT3(sanitizeTheme({ id: 'tlong', name: 'Long', css: `.x{color:red}`.repeat(4000) })), /over its limit/);

// --- the store, files and links (theme-t3.js) ----------------------------------------------------
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 't3-themes-'));
store.configureThemeStore({ dir: tmp, send: () => {} });
assert.ok(isT3ThemeSource('{"name":"x"}') && isT3ThemeSource('https://files.example/x.json') && isT3ThemeSource('/abs/theme.json'));
assert.ok(!isT3ThemeSource('slug000001') && !isT3ThemeSource('relative.json'));

const filePath = path.join(tmp, 'neon-dusk.json');
await fs.writeFile(filePath, JSON.stringify(T3_FILE));
const { theme: fromFile } = await importT3Theme(filePath);
assert.equal(fromFile.saved, true);
assert.equal(await store.getActiveThemeId(), fromFile.id);
assert.ok(fromFile.compat?.t3);

configureT3Themes({
  fetch: async (url) => (String(url).endsWith('/neon.json') ? new Response(JSON.stringify(T3_FILE), { status: 200 }) : new Response('no', { status: 404 })),
});
const preview = await previewT3Theme('https://files.example/neon.json');
assert.equal(preview.kind, 't3');
assert.equal(preview.name, 'Neon Dusk');
assert.equal(preview.animated, true);
assert.equal(preview.installedId, fromFile.id);
await assert.rejects(previewT3Theme('https://files.example/missing.json'), /404/);
// A huge (or endless) response stops at the limit instead of filling memory.
let pulled = 0;
configureT3Themes({
  fetch: async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulled += 64 * 1024;
          if (pulled > 8 * 1024 * 1024) controller.close();
          else controller.enqueue(new Uint8Array(64 * 1024).fill(32));
        },
      }),
      { status: 200 }
    ),
});
await assert.rejects(previewT3Theme('https://files.example/endless.json'), /too large/);
assert.ok(pulled < 2 * 1024 * 1024, 'stopped reading near 1 MB');
configureT3Themes({
  fetch: async (url) => (String(url).endsWith('/neon.json') ? new Response(JSON.stringify(dual), { status: 200 }) : new Response('no', { status: 404 })),
});
assert.deepEqual((await previewT3Theme('https://files.example/neon.json')).appearances, ['dark', 'light']);
const { theme: lightImport } = await importT3Theme('https://files.example/neon.json', { appearance: 'light' });
assert.equal(lightImport.appearance, 'light');
await assert.rejects(importT3Theme('{"name":"x","appearance":"dark","tokens":{}}'), /not a T3 Code theme/);

// Export with a backdrop picture: it gets the room left in T3 Code's CSS.
const { theme: pictured } = await store.updateTheme({ patch: { name: 'Pictured', tokens: { accent: '#7fd3ff' } }, threadId: 'thread-t3' });
const wall = await store.writeThemeAsset(pictured.id, Buffer.from('fake image bytes'), 'png', 'backdrop');
const { theme: withWall } = await store.updateTheme({ id: pictured.id, threadId: 'thread-t3', patch: { backdrop: { type: 'image', asset: wall, dim: 0.3 } } });
let budgetSeen = 0;
configureT3Themes({
  picture: (bytes, maxChars) => {
    budgetSeen = maxChars;
    return `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
  },
});
const withPicture = await t3FileForTheme(withWall.id);
assertT3Valid(withPicture.file, 'with picture');
assert.ok(budgetSeen > 40_000 && budgetSeen < T3_CSS_MAX_LENGTH);
assert.ok(withPicture.file.css.includes('url("data:image/jpeg;base64,'));
const target = path.join(tmp, 'out', 'dc-pictured.json');
const written = await exportThemeToT3(withWall.id, target);
assert.equal(written.filePath, target);
assertT3Valid(JSON.parse(await fs.readFile(target, 'utf8')), 'written file');
// Exports never clobber other files, and need write access.
const precious = path.join(tmp, 'package.json');
await fs.writeFile(precious, '{"name":"precious"}');
await assert.rejects(exportThemeToT3(withWall.id, precious), /not a T3 Code theme/);
assert.equal(await fs.readFile(precious, 'utf8'), '{"name":"precious"}');
await assert.rejects(exportThemeToT3(withWall.id, path.join(tmp, 'theme.txt')), /\.json/);
await exportThemeToT3(withWall.id, target);
await exportThemeToT3(withWall.id, precious, { allowOverwrite: true });
const readOnly = await runThemeTool('manage_app_themes', { action: 'export_t3', theme_id: withWall.id, path: path.join(tmp, 'ro.json') }, { threadId: 'thread-t3', accessMode: 'read-only' });
assert.equal(readOnly.ok, false);
assert.match(readOnly.text, /Read only/);
configureT3Themes({ picture: () => `data:image/jpeg;base64,${'A'.repeat(60_000)}` });
const tooBig = await t3FileForTheme(withWall.id);
assert.ok(!tooBig.file.css?.includes('data:image/jpeg'));
assert.ok(tooBig.notes.some((note) => /did not fit/.test(note)));

await fs.rm(tmp, { recursive: true, force: true });
console.log('t3 themes: ok');
