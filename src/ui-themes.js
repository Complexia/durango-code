// Durango Code themes (Settings → Customizations), shared by the main process
// (src/main/ui-themes-store.js, src/main/theme-tools.js) and the renderer
// (src/app/themes/*). Pure: no DOM, no Node, so scripts/test-ui-themes.mjs
// runs it directly.
//
// A theme is data, never code that runs in the app:
// - `tokens` override the app's CSS custom properties (src/index.css :root).
//   Values are checked so they can never leave their declaration.
// - `css` is extra CSS for the app document (imports and remote urls removed).
// - `backdrop` paints behind the app: a CSS background, an image or video file
//   kept in the theme's folder, or an animated HTML scene.
// - `overlay` is an HTML scene painted above the app with pointer events off
//   (snow, confetti, fireworks when a turn finishes).
// HTML scenes run in sandboxed frames with no network, like show_html visuals
// (src/app/visualDocument.ts); they learn what the app is doing through
// messages (THEME_SCENE_EVENTS) and never touch the app's DOM.
//
// "Stock" is no theme at all: the app's own stylesheet, untouched. It is
// always available and is what every reset returns to.

export const STOCK_THEME_ID = 'stock';
export const THEME_FORMAT_VERSION = 1;

export const THEME_LIMITS = Object.freeze({
  name: 60,
  description: 240,
  css: 60_000,
  html: 200_000,
  tokenValue: 400,
});

/**
 * Every token a theme may set: the app's CSS custom property (without `--`)
 * → its stock value and what it paints. Keep stock values equal to
 * src/index.css :root (scripts/test-ui-themes.mjs checks).
 */
export const THEME_TOKENS = Object.freeze({
  'bg-base': { stock: '#101012', kind: 'color', label: 'Window background behind everything' },
  'bg-raised': { stock: '#141416', kind: 'color', label: 'Sidebar, composer, settings panels' },
  'bg-surface': { stock: '#1d1d21', kind: 'color', label: 'Cards, inputs, code blocks, menus' },
  'bg-elevated': { stock: '#26262b', kind: 'color', label: 'Popovers and raised controls' },
  'bg-hover': { stock: '#303036', kind: 'color', label: 'Hovered rows and buttons' },
  'shell-bg': {
    stock: 'linear-gradient(180deg, #141416 0%, #111113 100%)',
    kind: 'background',
    label: 'Title bar strip across the top (a color or gradient)',
  },
  'settings-sidebar-bg': { stock: '#0c0c0e', kind: 'color', label: 'Settings navigation column' },
  'border-subtle': { stock: 'rgb(255 255 255 / 5.5%)', kind: 'color', label: 'Faint dividers' },
  'border-default': { stock: 'rgb(255 255 255 / 8%)', kind: 'color', label: 'Panel and card borders' },
  'border-strong': { stock: 'rgb(255 255 255 / 13%)', kind: 'color', label: 'Focused and emphasized borders' },
  'text-primary': { stock: '#ececef', kind: 'color', label: 'Main text' },
  'text-secondary': { stock: '#a0a0a8', kind: 'color', label: 'Secondary text, descriptions' },
  'text-muted': { stock: '#6b6b74', kind: 'color', label: 'Hints, timestamps, placeholders' },
  accent: { stock: '#4d8dff', kind: 'color', label: 'Links, focus rings, primary buttons, selection' },
  'on-accent': { stock: '#fff', kind: 'color', label: 'Text and icons on accent fills (your prompt bubbles, send and primary buttons); dark for bright accents' },
  link: { stock: '#4da3ff', kind: 'color', label: 'Links in replies (follows accent if unset)' },
  'accent-soft': { stock: 'rgb(77 141 255 / 14%)', kind: 'color', label: 'Accent tint behind selected items' },
  'accent-glow': { stock: 'rgb(77 141 255 / 28%)', kind: 'color', label: 'Accent glow and focus halos' },
  'agent-violet': { stock: '#8b7cf6', kind: 'color', label: 'Agent and subagent highlights' },
  success: { stock: '#34d399', kind: 'color', label: 'Success, additions, done' },
  warning: { stock: '#f4a261', kind: 'color', label: 'Warnings, waiting' },
  danger: { stock: '#f87171', kind: 'color', label: 'Errors, deletions' },
  'font-ui': {
    stock: "'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif",
    kind: 'font',
    label: 'Interface font stack (fonts installed on this computer; no web fonts)',
  },
  'font-mono': {
    stock: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    kind: 'font',
    label: 'Code and terminal font stack',
  },
  'radius-sm': { stock: '6px', kind: 'length', label: 'Small corner radius (chips, small buttons)' },
  'radius-md': { stock: '10px', kind: 'length', label: 'Medium corner radius (inputs, cards)' },
  'radius-lg': { stock: '14px', kind: 'length', label: 'Large corner radius (panels, composer)' },
  'radius-xl': { stock: '18px', kind: 'length', label: 'Extra large corner radius (dialogs)' },
});

export const THEME_TOKEN_NAMES = Object.freeze(Object.keys(THEME_TOKENS));

/** Background tokens that turn translucent over a backdrop (surfaceOpacity). */
const SEE_THROUGH_TOKENS = Object.freeze({ 'bg-base': 0, 'bg-raised': 0, 'settings-sidebar-bg': 0, 'bg-surface': 0.12 });

export const BACKDROP_TYPES = Object.freeze(['css', 'image', 'video', 'html']);
export const THEME_APPEARANCES = Object.freeze(['dark', 'light']);

/**
 * What an HTML scene (backdrop or overlay) hears from the app, through
 * `durango.on(type, fn)` in the frame (see THEME_SCENE_BOOTSTRAP).
 */
export const THEME_SCENE_EVENTS = Object.freeze({
  working: 'An agent started or stopped working in any thread: { working: boolean, count: number }',
  'turn-start': 'An agent turn started: { threadId }',
  'turn-end': 'An agent turn ended: { threadId, status: "done" | "error" | "stopped" }; "done" is the moment to celebrate',
  pointer: 'The mouse moved over the window: { x, y } from 0 to 1 (throttled to animation frames)',
  focus: 'The window gained or lost focus: { focused: boolean }',
  celebrate: 'The user pressed Preview celebration in Settings: { }',
  typing: 'The user typed in the composer: { }',
});

// --- value checks -------------------------------------------------------------

// Colors, gradients, lengths, numbers, simple functions and font names. No
// semicolons, braces or angle brackets (cannot leave the declaration), no
// url() (no network, no files outside the theme), no backslashes (escapes).
const TOKEN_VALUE_PATTERN = /^[#a-zA-Z0-9\s(),.%/+*'"-]+$/;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const cleanText = (value, max) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** A token value safe to place in `--name: value`, or null. */
export const sanitizeTokenValue = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > THEME_LIMITS.tokenValue) return null;
  if (!TOKEN_VALUE_PATTERN.test(trimmed)) return null;
  if (/url\s*\(|expression\s*\(|image-set|-webkit-image-set/i.test(trimmed)) return null;
  // Quotes must pair up so a font name cannot swallow the rest of the rule.
  if ((trimmed.match(/'/g) ?? []).length % 2 || (trimmed.match(/"/g) ?? []).length % 2) return null;
  let depth = 0;
  for (const char of trimmed) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) return null;
  }
  return depth === 0 ? trimmed : null;
};

/**
 * Extra CSS for the app document, made unable to load anything: CSS escapes
 * and comments removed first (they can spell any function name or URL), then
 * `@import`, `@font-face` and `@namespace` dropped, the other resource
 * functions (image-set, cross-fade, element, src) disabled, and every url()
 * that is not an inline data:image/ URI disabled. A theme's own files are
 * reached with theme-asset("name"), resolved after this (themeToCss); a raw
 * orion-attachment: URL is refused like any other.
 */
export const sanitizeThemeCss = (css) => {
  if (typeof css !== 'string') return '';
  return css
    .slice(0, THEME_LIMITS.css)
    .replace(/\\(?:[0-9a-f]{1,6}\s?|[\s\S])/gi, '')
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '')
    .replace(/<\/?style[^>]*>/gi, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/@namespace[^;]*;?/gi, '')
    .replace(/@font-face\s*\{[^}]*\}/gi, '')
    .replace(/(?:-webkit-)?image-set\s*\(|cross-fade\s*\(|\belement\s*\(|\bsrc\s*\(/gi, 'none(')
    // Whatever the quoting (a quoted URL may contain ")"), only data images.
    .replace(/url\s*\(\s*(?!['"]?\s*data:image\/)/gi, 'none(');
};

const sanitizeHtml = (html) => (typeof html === 'string' ? html.trim().slice(0, THEME_LIMITS.html) : '');

const ASSET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,80}\.(png|jpe?g|webp|gif|avif|mp4|webm|mov)$/i;
export const isThemeAssetName = (name) => typeof name === 'string' && ASSET_NAME_PATTERN.test(name) && !name.includes('..');
export const isVideoAsset = (name) => /\.(mp4|webm|mov)$/i.test(name ?? '');

/** A backdrop or null (no backdrop). */
export const sanitizeBackdrop = (input) => {
  if (!input || typeof input !== 'object') return null;
  const type = BACKDROP_TYPES.includes(input.type) ? input.type : null;
  if (!type) return null;
  const out = { type };
  if (type === 'css') {
    const css = sanitizeTokenValue(input.css);
    if (!css) return null;
    out.css = css;
  } else if (type === 'html') {
    const html = sanitizeHtml(input.html);
    if (!html) return null;
    out.html = html;
  } else {
    if (!isThemeAssetName(input.asset)) return null;
    if ((type === 'video') !== isVideoAsset(input.asset)) return null;
    out.asset = input.asset;
    const position = cleanText(input.position, 40);
    if (position && /^[a-z0-9\s%.-]+$/i.test(position)) out.position = position;
    if (input.fit === 'contain' || input.fit === 'cover') out.fit = input.fit;
  }
  if (typeof input.dim === 'number' && Number.isFinite(input.dim)) out.dim = clamp(input.dim, 0, 0.9);
  if (typeof input.blur === 'number' && Number.isFinite(input.blur)) out.blur = clamp(input.blur, 0, 40);
  if (typeof input.saturate === 'number' && Number.isFinite(input.saturate)) out.saturate = clamp(input.saturate, 0, 2);
  // A still frame for previews and for when animation is off (generated
  // video and HTML scenes): an image asset in the same folder.
  if (isThemeAssetName(input.poster) && !isVideoAsset(input.poster)) out.poster = input.poster;
  return out;
};

const sanitizeOverlay = (input) => {
  if (!input || typeof input !== 'object') return null;
  const html = sanitizeHtml(input.html);
  return html ? { html } : null;
};

const sanitizeTokens = (input) => {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [rawName, value] of Object.entries(input)) {
    const name = rawName.replace(/^--/, '');
    if (!THEME_TOKENS[name]) continue;
    const clean = sanitizeTokenValue(value);
    if (clean) out[name] = clean;
  }
  return out;
};

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const isThemeId = (id) => typeof id === 'string' && ID_PATTERN.test(id) && id !== STOCK_THEME_ID;

/**
 * A theme record from anywhere (disk, IPC, a built-in) with every field
 * checked, or null if it is not a theme.
 */
export const sanitizeTheme = (input) => {
  if (!input || typeof input !== 'object' || !isThemeId(input.id)) return null;
  const theme = {
    id: input.id,
    version: THEME_FORMAT_VERSION,
    name: cleanText(input.name, THEME_LIMITS.name) || 'Untitled theme',
    appearance: input.appearance === 'light' ? 'light' : 'dark',
    tokens: sanitizeTokens(input.tokens),
  };
  const description = cleanText(input.description, THEME_LIMITS.description);
  if (description) theme.description = description;
  if (input.builtIn === true) theme.builtIn = true;
  theme.saved = input.builtIn === true || input.saved === true;
  if (typeof input.threadId === 'string' && input.threadId.length <= 200) theme.threadId = input.threadId;
  for (const key of ['createdAt', 'updatedAt']) {
    if (typeof input[key] === 'string' && !Number.isNaN(Date.parse(input[key]))) theme[key] = input[key];
  }
  theme.revision = Number.isInteger(input.revision) && input.revision > 0 ? input.revision : 1;
  if (typeof input.surfaceOpacity === 'number' && Number.isFinite(input.surfaceOpacity)) {
    theme.surfaceOpacity = clamp(input.surfaceOpacity, 0.1, 1);
  }
  if (typeof input.baseOpacity === 'number' && Number.isFinite(input.baseOpacity)) {
    theme.baseOpacity = clamp(input.baseOpacity, 0.05, 1);
  }
  if (typeof input.panelBlur === 'number' && Number.isFinite(input.panelBlur)) {
    theme.panelBlur = clamp(input.panelBlur, 0, 40);
  }
  const backdrop = sanitizeBackdrop(input.backdrop);
  if (backdrop) theme.backdrop = backdrop;
  const overlay = sanitizeOverlay(input.overlay);
  if (overlay) theme.overlay = overlay;
  const css = sanitizeThemeCss(input.css);
  if (css.trim()) theme.css = css;
  return theme;
};

// --- CSS ------------------------------------------------------------------------

/** Relative luminance of a #rgb/#rrggbb color; 1 for anything else. */
const luminance = (color) => {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color ?? '').trim());
  if (!match) return 1;
  const hex = match[1].length === 3 ? match[1].replace(/./g, '$&$&') : match[1];
  const [r, g, b] = [0, 2, 4].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Default panel opacity over a backdrop when the theme does not say. */
export const DEFAULT_SURFACE_OPACITY = 0.72;

const seeThrough = (value, opacity) => {
  const percent = Math.round(clamp(opacity, 0, 1) * 1000) / 10;
  return percent >= 100 ? value : `color-mix(in srgb, ${value} ${percent}%, transparent)`;
};

/**
 * The stylesheet that applies `theme` to the app document. `assetUrl(name)`
 * maps a file in the theme's folder to a URL the renderer can load.
 * Stock (`null`) is the empty string.
 */
export const themeToCss = (input, { assetUrl = () => '' } = {}) => {
  const theme = sanitizeTheme(input);
  if (!theme) return '';
  const declarations = [];
  const hasBackdrop = Boolean(theme.backdrop);
  const opacity = theme.surfaceOpacity ?? (hasBackdrop ? DEFAULT_SURFACE_OPACITY : 1);
  for (const name of THEME_TOKEN_NAMES) {
    let value = theme.tokens[name];
    // The main reading area (bg-base) may be clearer than the panels.
    const tokenOpacity = name === 'bg-base' && hasBackdrop && theme.baseOpacity !== undefined ? theme.baseOpacity : opacity;
    if (name in SEE_THROUGH_TOKENS && tokenOpacity < 1) {
      value = seeThrough(value ?? THEME_TOKENS[name].stock, Math.min(1, tokenOpacity + SEE_THROUGH_TOKENS[name]));
    }
    if (name === 'shell-bg' && !value && opacity < 1) {
      value = seeThrough(theme.tokens['bg-raised'] ?? THEME_TOKENS['bg-raised'].stock, opacity);
    }
    if (value) declarations.push(`--${name}: ${value};`);
  }
  // An accent without its tints: derive them so selection and focus follow.
  if (theme.tokens.accent && !theme.tokens['accent-soft']) {
    declarations.push(`--accent-soft: color-mix(in srgb, ${theme.tokens.accent} 14%, transparent);`);
  }
  if (theme.tokens.accent && !theme.tokens['accent-glow']) {
    declarations.push(`--accent-glow: color-mix(in srgb, ${theme.tokens.accent} 28%, transparent);`);
  }
  if (theme.tokens.accent && !theme.tokens.link) {
    declarations.push(`--link: color-mix(in srgb, ${theme.tokens.accent} 82%, white);`);
  }
  if (theme.tokens.accent) {
    // Dark text on the accent (a bright accent) needs the fills to stay light.
    const darkText = luminance(theme.tokens['on-accent']) < 0.2;
    declarations.push(`--accent-strong: color-mix(in srgb, ${theme.tokens.accent} ${darkText ? 100 : 88}%, black);`);
    declarations.push(`--accent-deep: color-mix(in srgb, ${theme.tokens.accent} ${darkText ? 90 : 72}%, black);`);
  }
  declarations.push(`--theme-panel-blur: ${theme.panelBlur ?? 0}px;`);
  if (theme.appearance === 'light') declarations.push('color-scheme: light;');
  const parts = [`:root {\n  ${declarations.join('\n  ')}\n}`];
  if (theme.backdrop?.type === 'css') {
    parts.push(`.theme-backdrop-css { background: ${theme.backdrop.css}; }`);
  }
  if (theme.css) {
    // Theme files are reachable as theme-asset("name") in the theme's CSS.
    parts.push(
      theme.css.replace(/theme-asset\(\s*['"]?([^'")]+)['"]?\s*\)/g, (match, name) =>
        isThemeAssetName(name) ? `url("${assetUrl(name)}")` : 'none'
      )
    );
  }
  return parts.join('\n\n');
};

// --- editing (set_app_theme) ------------------------------------------------------

/**
 * Apply an agent's or the user's change to `base` (a theme or null for a new
 * one). `patch` uses the theme's field names; `tokens: { name: null }` removes
 * one token, `backdrop: null` / `overlay: null` / `css: ""` clear them.
 * Returns `{ theme, ignored }`: `ignored` lists what was dropped and why.
 */
export const mergeTheme = (base, patch, { id, now = new Date().toISOString(), threadId } = {}) => {
  const ignored = [];
  const next = {
    ...(base ?? {}),
    id: base?.id ?? id,
    tokens: { ...(base?.tokens ?? {}) },
  };
  delete next.builtIn;
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.appearance !== undefined) {
    if (THEME_APPEARANCES.includes(patch.appearance)) next.appearance = patch.appearance;
    else ignored.push(`appearance "${patch.appearance}" (use dark or light)`);
  }
  if (patch.tokens && typeof patch.tokens === 'object') {
    for (const [rawName, value] of Object.entries(patch.tokens)) {
      const name = rawName.replace(/^--/, '');
      if (!THEME_TOKENS[name]) {
        ignored.push(`token "${rawName}" (not a theme token; use css for anything else)`);
        continue;
      }
      if (value === null || value === '') {
        delete next.tokens[name];
        continue;
      }
      const clean = sanitizeTokenValue(value);
      if (clean) next.tokens[name] = clean;
      else ignored.push(`${name}: ${JSON.stringify(value).slice(0, 80)} (not a plain color, gradient, length or font list; url() is not allowed)`);
    }
  }
  if (patch.surfaceOpacity !== undefined) {
    if (patch.surfaceOpacity === null) delete next.surfaceOpacity;
    else next.surfaceOpacity = patch.surfaceOpacity;
  }
  if (patch.baseOpacity !== undefined) {
    if (patch.baseOpacity === null) delete next.baseOpacity;
    else next.baseOpacity = patch.baseOpacity;
  }
  if (patch.panelBlur !== undefined) {
    if (patch.panelBlur === null) delete next.panelBlur;
    else next.panelBlur = patch.panelBlur;
  }
  if (patch.backdrop !== undefined) {
    if (patch.backdrop === null) delete next.backdrop;
    else {
      // Keep the current file when only the look of the backdrop changes.
      const merged =
        base?.backdrop && (patch.backdrop.type === undefined || patch.backdrop.type === base.backdrop.type)
          ? { ...base.backdrop, ...patch.backdrop, type: base.backdrop.type }
          : patch.backdrop;
      const clean = sanitizeBackdrop(merged);
      if (clean) next.backdrop = clean;
      else ignored.push('backdrop (needs type css with a css value, html with a page, or an image/video file)');
    }
  }
  if (patch.overlay !== undefined) {
    if (patch.overlay === null) delete next.overlay;
    else if (sanitizeOverlay(patch.overlay)) next.overlay = patch.overlay;
    else ignored.push('overlay (needs an html page)');
  }
  if (patch.css !== undefined) {
    if (!patch.css) delete next.css;
    else {
      if (typeof patch.css === 'string' && patch.css.length > THEME_LIMITS.css) {
        ignored.push(`css past ${THEME_LIMITS.css} characters`);
      }
      next.css = patch.css;
    }
  }
  next.createdAt = base?.createdAt ?? now;
  next.updatedAt = now;
  next.revision = (base?.revision ?? 0) + 1;
  if (threadId) next.threadId = threadId;
  const theme = sanitizeTheme(next);
  return { theme, ignored };
};

/** A small summary for transcript cards and other machines: name + swatches. */
export const themeSummary = (theme) => {
  if (!theme) return null;
  const pick = (name) => theme.tokens?.[name] ?? THEME_TOKENS[name].stock;
  return {
    id: theme.id,
    name: theme.name,
    revision: theme.revision ?? 1,
    swatches: [pick('bg-base'), pick('bg-raised'), pick('accent'), pick('text-primary'), pick('agent-violet')],
    backdrop: theme.backdrop?.type ?? null,
    overlay: Boolean(theme.overlay),
  };
};

// --- HTML scenes --------------------------------------------------------------------

export const THEME_SCENE_SOURCE = 'durango-theme-scene';

export const THEME_SCENE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
].join('; ');

/**
 * Runs before the scene's own code. Gives the page `window.durango`:
 *   durango.on(type, fn) / durango.off(type, fn)   (THEME_SCENE_EVENTS)
 *   durango.state  { working, count, pointer: {x, y}, focused, reducedMotion, appearance }
 * Uncaught errors go to the app (the agent sees them in get_app_theme).
 * Only messages from the app window are accepted.
 */
export const THEME_SCENE_BOOTSTRAP = `(function(){
"use strict";
var S=${JSON.stringify(THEME_SCENE_SOURCE)},P=window.parent,sent=0,seen={},L={};
function post(m){try{m.source=S;P.postMessage(m,"*");}catch(e){}}
function report(t){t=String(t||"Script error").slice(0,300);if(seen[t]||sent>=8)return;seen[t]=1;sent++;post({type:"error",message:t});}
["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","WebSocket","EventSource","Worker","SharedWorker"].forEach(function(k){try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false});}catch(e){}});
window.addEventListener("error",function(e){if(!(e instanceof ErrorEvent))return;report(e.message||"Script error");e.preventDefault();});
window.addEventListener("unhandledrejection",function(e){var r=e.reason;report("Unhandled promise rejection: "+(r&&r.message?r.message:String(r)));e.preventDefault();});
var state={working:false,count:0,pointer:{x:0.5,y:0.5},focused:true,reducedMotion:false,appearance:"dark"};
var api={state:state,on:function(t,f){if(typeof f!=="function")return;(L[t]=L[t]||[]).push(f);},off:function(t,f){var a=L[t];if(!a)return;var i=a.indexOf(f);if(i>=0)a.splice(i,1);}};
try{Object.defineProperty(window,"durango",{value:api,writable:false,configurable:false});}catch(e){window.durango=api;}
window.addEventListener("message",function(e){if(e.source!==P)return;var d=e.data;if(!d||d.source!==S||d.type!=="event"||typeof d.event!=="string")return;var x=d.detail&&typeof d.detail==="object"?d.detail:{};
if(d.event==="state"){for(var k in x){if(Object.prototype.hasOwnProperty.call(state,k))state[k]=x[k];}return;}
if(d.event==="working"){state.working=!!x.working;state.count=+x.count||0;}
if(d.event==="pointer"){state.pointer={x:+x.x||0,y:+x.y||0};}
if(d.event==="focus"){state.focused=!!x.focused;}
var a=(L[d.event]||[]).slice();for(var i=0;i<a.length;i++){try{a[i](x);}catch(err){report(err&&err.message?err.message:String(err));}}});
post({type:"ready"});
})();`;

const SCENE_BASE_STYLE = `*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}
canvas{display:block}`;

const tagPattern = (names) => new RegExp(`<\\/?(?:${names})(?=[\\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi');

/** The agent's scene as body content: wrappers and tags that act without script removed. */
export const normalizeSceneHtml = (html) =>
  String(html ?? '')
    .replace(/^﻿/, '')
    .replace(/<!doctype(?:[^>"']|"[^"]*"|'[^']*')*>/gi, '')
    .replace(tagPattern('html|head|body'), '')
    .replace(tagPattern('meta'), (tag) => (/http-equiv/i.test(tag) ? '' : tag))
    .replace(tagPattern('base|link|iframe|frame|object|embed'), '')
    .trim();

/** Full srcdoc for a backdrop or overlay scene. The CSP comes first. */
export const buildSceneDocument = (html) =>
  [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    `<meta http-equiv="Content-Security-Policy" content="${THEME_SCENE_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<meta http-equiv="x-dns-prefetch-control" content="off">',
    `<style>${SCENE_BASE_STYLE}</style>`,
    `<script>${THEME_SCENE_BOOTSTRAP}</script>`,
    '</head>',
    '<body>',
    normalizeSceneHtml(html),
    '</body>',
    '</html>',
  ].join('\n');

/** A message from a scene frame (caller checked event.source), or null. */
export const parseSceneMessage = (data) => {
  if (!data || typeof data !== 'object' || data.source !== THEME_SCENE_SOURCE) return null;
  if (data.type === 'ready') return { type: 'ready' };
  if (data.type === 'error' && typeof data.message === 'string') {
    const message = data.message.replace(/\s+/g, ' ').trim().slice(0, 300);
    return message ? { type: 'error', message } : null;
  }
  return null;
};
