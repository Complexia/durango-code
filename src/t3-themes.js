// T3 Code theme compatibility (docs/themes.md → "T3 Code themes"). A T3 Code
// theme is JSON: a name, an appearance, colors for its roles (or just a
// canvas and an accent), and CSS written against its stable hooks
// ([data-slot="sidebar"], [data-user-message-bubble], …). Converting:
//
// - T3 → Durango (t3ThemeToDurango): roles become our tokens; every role is
//   kept as compat.t3.colors, so its CSS still finds --app-theme-* and T3's
//   shadcn variables (t3-theme-format.js). The CSS is rewritten: T3's hooks
//   become our elements (:is(.sidebar)…; hooks with no counterpart never
//   match), T3's shadcn variables get the --t3- prefix (ours share names like
//   --accent), and `.dark` follows the theme's appearance.
// - Durango → T3 (durangoThemeToT3): our tokens fill every role; the CSS is
//   rewritten the other way (our classes become T3's hooks, our variables get
//   the --dc- prefix and are defined at the top, the theme's values take their
//   defaults), and an image backdrop can come along as a small data: picture.
//   What T3 Code can't run (HTML scenes, video, controls) stays behind.
//
// Pure: no Node or DOM APIs (main and tests use it; main embeds pictures).

import {
  T3_ALIAS_NAMES,
  T3_ALIAS_PREFIX,
  T3_STOCK_COLORS,
  T3_THEME_ROLES,
} from './t3-theme-format.js';
import { THEME_LIMITS, THEME_TOKEN_NAMES, THEME_TOKENS, sanitizeThemeCss, sanitizeTokenValue } from './ui-themes.js';

export const T3_CSS_MAX_LENGTH = 50_000;
export const T3_NAME_MAX = 48;
const T3_RESERVED_IDS = new Set(['system', 'light', 'dark', 't3-chat', 'grove', 'ocean', 'ember', 'iris']);
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const ROLE_SET = new Set(T3_THEME_ROLES);

// --- hooks --------------------------------------------------------------------------

// T3 Code's stable hooks (packages/shared/src/themeCss.ts) → our elements.
// null: nothing of ours matches (the rule stays inert).
const T3_HOOKS_TO_OURS = [
  ['[data-slot="sidebar"]', '.sidebar'],
  ['[data-slot="sidebar-inner"]', '.sidebar-content'],
  ['[data-thread-item]', '.thread-item'],
  ['[data-slot="project-monogram"]', '.project-icon'],
  ['[data-chat-header]', '.app-shellbar'],
  ['[data-workspace-area="conversation"]', '.thread-pane'],
  ['.messages-timeline-scroll', '.chat-scroll'],
  ['[data-timeline-row-kind="message"]', '.message'],
  ['[data-timeline-row-kind="work"]', '.work-group, .work-row'],
  ['[data-timeline-row-kind]', '.message, .work-group'],
  ['[data-message-role="user"]', '.message.user'],
  ['[data-user-message-bubble]', '.message.user'],
  ['[data-message-role="assistant"]', '.message.agent'],
  ['.chat-markdown-codeblock', '.code-block'],
  ['.chat-markdown', '.markdown-content'],
  ['[data-chat-composer-form]', '.composer-shell'],
  ['[data-slot="composer-host"]', '.composer-shell'],
  ['.composer-tiptap', '.chat-input'],
  ['[data-thread-details-card]', null],
  ['[data-thread-terminal-drawer]', '.terminal-view'],
  ['[data-settings-page-scroll]', '.settings-page'],
  ['[data-slot="button"]', 'button'],
  ['[data-slot="input"]', 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea'],
  ['[data-slot="switch"]', '.provider-toggle'],
  ['[data-slot="select-trigger"]', '[aria-haspopup="listbox"]'],
  ['[data-slot="dialog-popup"]', '.modal'],
  ['[data-slot="popover-popup"]', '.model-picker-popover, .mention-popover, .slash-popover, .access-mode-popover, .codex-settings-popover, .task-picker-popover'],
  ['[data-slot="menu-popup"]', '[role="menu"]'],
  ['[data-slot="tooltip-popup"]', '[role="tooltip"]'],
  ['[data-slot="scroll-area-scrollbar"]', null],
  ['[data-slot="scroll-area-thumb"]', null],
];

// Our classes → T3 Code's hooks (export). Longer selectors first.
const OURS_TO_T3_HOOKS = [
  ['.message.user', '[data-user-message-bubble]'],
  ['.message.agent', '[data-message-role="assistant"]'],
  ['.message', '[data-timeline-row-kind="message"]'],
  ['.work-group', '[data-timeline-row-kind="work"]'],
  ['.work-row', '[data-timeline-row-kind="work"]'],
  ['.markdown-content', '.chat-markdown'],
  ['.code-block', '.chat-markdown-codeblock'],
  ['.sidebar-content', '[data-slot="sidebar-inner"]'],
  ['.sidebar', '[data-slot="sidebar"]'],
  ['.thread-item', '[data-thread-item]'],
  ['.project-icon', '[data-slot="project-monogram"]'],
  ['.app-shellbar', '[data-chat-header]'],
  ['.chat-scroll', '.messages-timeline-scroll'],
  ['.chat-container', '.messages-timeline-scroll'],
  ['.thread-pane', '[data-workspace-area="conversation"]'],
  ['.composer-shell', '[data-slot="composer-host"]'],
  ['.chat-input', '.composer-tiptap'],
  ['.terminal-view', '[data-thread-terminal-drawer]'],
  ['.settings-page', '[data-settings-page-scroll]'],
  ['.modal', '[data-slot="dialog-popup"]'],
  ['.btn', '[data-slot="button"]'],
  ['.provider-toggle', '[data-slot="switch"]'],
];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NEVER = ':not(*)';
// Each rewritten hook keeps a marker no element of ours has ([data-t3-hook="…"]),
// so exporting turns it back into exactly the hook it was.
const hookMarker = (hook) => `[data-t3-hook="${hook.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')}"]`;
const ourHook = (hook, selector) => `:is(${selector ? `${selector}, ` : ''}${hookMarker(hook)})`;
const DARK_HOOK = '.dark';

// An attribute selector in any quoting: [data-x], [data-x="v"], [data-x='v'], [data-x=v].
const ATTRIBUTE_SELECTOR = /\[\s*(data-[a-z0-9-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s"']+))\s*)?\]/gi;
const attributeKey = (name, value) => (value === undefined ? `[${name}]` : `[${name}="${value}"]`);
const T3_ATTRIBUTE_HOOKS = new Map(T3_HOOKS_TO_OURS.filter(([hook]) => hook.startsWith('[')).map(([hook, ours]) => [hook, ours]));
const T3_CLASS_HOOKS = T3_HOOKS_TO_OURS.filter(([hook]) => hook.startsWith('.'));

// Strings and url(…) are text, not selectors or variables: the rewrites skip
// them (content: "[data-thread-item]" stays as written). Attribute selectors
// are matched first so their quoted values stay rewritable.
const PROTECTED = /\[(?:[^\]"']|"[^"]*"|'[^']*')*\]|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|url\((?:[^)"']|"[^"]*"|'[^']*')*\))/gi;
const PLACEHOLDER = /\u0000(\d+)\u0000/g;
const outsideStrings = (css, rewrite) => {
  const kept = [];
  const masked = String(css ?? '')
    .replace(/\u0000/g, '')
    .replace(PROTECTED, (match, text) => {
      if (text === undefined) return match;
      kept.push(text);
      return `\u0000${kept.length - 1}\u0000`;
    });
  return rewrite(masked).replace(PLACEHOLDER, (match, index) => kept[Number(index)] ?? '');
};

/** Rewrites T3 Code CSS for Durango Code (see the file comment). */
export const rewriteT3Css = (css, appearance) =>
  outsideStrings(String(css ?? '').replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ''), (text) => rewriteT3Selectors(text, appearance));

const rewriteT3Selectors = (css, appearance) => {
  let out = css;
  out = out.replace(ATTRIBUTE_SELECTOR, (match, name, double, single, bare) => {
    const value = double ?? single ?? bare;
    const key = attributeKey(name.toLowerCase(), value);
    return T3_ATTRIBUTE_HOOKS.has(key) ? ourHook(key, T3_ATTRIBUTE_HOOKS.get(key)) : match;
  });
  for (const [hook, ours] of T3_CLASS_HOOKS) {
    out = out.replace(new RegExp(`${escapeRegExp(hook)}(?![\\w-])`, 'g'), ourHook(hook, ours));
  }
  // T3 Code puts .dark on <html> for dark mode; ours is the theme's appearance.
  out = out.replace(/\.dark(?![\w-])/g, ourHook(DARK_HOOK, appearance === 'light' ? null : ':root'));
  // Its shadcn variables share names with ours (--accent, --warning).
  const aliases = [...T3_ALIAS_NAMES].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  out = out.replace(new RegExp(`(?<![\\w-])--(${aliases})(?![\\w-])`, 'g'), `--${T3_ALIAS_PREFIX}$1`);
  return out;
};

// --- colors ----------------------------------------------------------------------------

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** #rgb[a], #rrggbb[aa], rgb()/rgba() (comma or space syntax), white/black/transparent → {r,g,b,a}, else null. */
export const parseColor = (input) => {
  const value = String(input ?? '').trim().toLowerCase();
  if (value === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (value === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
  if (match) {
    let hex = match[1];
    if (hex.length <= 4) hex = [...hex].map((char) => char + char).join('');
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a };
  }
  match = /^rgba?\(\s*([^)]*)\)$/.exec(value);
  if (!match) return null;
  const parts = match[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const channel = (part) => (part.endsWith('%') ? (parseFloat(part) / 100) * 255 : parseFloat(part));
  const [r, g, b] = parts.slice(0, 3).map(channel);
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  if (![r, g, b, alpha].every(Number.isFinite)) return null;
  return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(alpha, 0, 1) };
};

const hex2 = (value) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0');
export const toHex = ({ r, g, b, a = 1 }) => `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ''}`;

/** `amount` of `top` over `bottom` (both parsed), as an opaque-ish color. */
const mixColors = (top, bottom, amount) => ({
  r: top.r * amount + bottom.r * (1 - amount),
  g: top.g * amount + bottom.g * (1 - amount),
  b: top.b * amount + bottom.b * (1 - amount),
  a: top.a * amount + bottom.a * (1 - amount),
});

// CSS color functions T3 Code's parser (culori) reads as they are.
const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)$/i;
// CSS named colors (culori reads them too).
const NAMED_COLORS = new Set(
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent'.split(' ')
);
// T3 Code's published format allows 64 characters per color.
const T3_COLOR_MAX = 64;

/** A single color T3 Code accepts from one of our token values (first color of a gradient), or null. */
export const exportColor = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const parsed = parseColor(trimmed);
  if (parsed) return toHex(parsed);
  if (NAMED_COLORS.has(trimmed.toLowerCase())) return trimmed.toLowerCase();
  if (COLOR_FUNCTION.test(trimmed) && !/var\(|calc\(/i.test(trimmed) && trimmed.length <= T3_COLOR_MAX) return trimmed;
  if (/gradient\(/i.test(trimmed)) {
    const first = /#[0-9a-f]{3,8}\b|rgba?\([^()]*\)/i.exec(trimmed);
    const color = first ? parseColor(first[0]) : null;
    if (color) return toHex(color);
  }
  return null;
};

// --- parsing a T3 theme file ---------------------------------------------------------------

/**
 * A T3 Code theme file (its Export, or the published format: version 1,
 * name, appearance, colors and/or canvas + accent, variants, css), checked
 * like T3 Code does. Throws with a reason.
 */
export const parseT3ThemeFile = (input) => {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input.replace(/^﻿/, ''));
    } catch {
      throw new Error('That is not JSON, so it is not a T3 Code theme file.');
    }
  }
  if (!isRecord(data)) throw new Error('A T3 Code theme file is a JSON object.');
  if (data.version !== undefined && data.version !== 1) throw new Error('This T3 Code theme file has an unsupported version (expected 1).');
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name || name.length > T3_NAME_MAX) throw new Error('A T3 Code theme needs a name (48 characters or fewer).');
  if (data.appearance !== 'light' && data.appearance !== 'dark') throw new Error('A T3 Code theme needs an appearance of "light" or "dark".');
  if (data.colors !== undefined && !isRecord(data.colors)) throw new Error('A T3 Code theme\'s colors must be an object.');
  const colors = cleanRoles(data.colors ?? {});
  const hex = (value) => (typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim()) ? value.trim() : null);
  const canvas = hex(data.canvas);
  const accent = hex(data.accent);
  if (!Object.keys(colors).length && !(canvas && accent)) {
    throw new Error('A T3 Code theme needs colors (or a canvas and an accent).');
  }
  // The other appearance's colors (T3 Code switches with the system).
  const variants = {};
  if (isRecord(data.variants)) {
    for (const look of ['light', 'dark']) {
      if (look === data.appearance || !isRecord(data.variants[look])) continue;
      const roles = cleanRoles(data.variants[look]);
      if (Object.keys(roles).length) variants[look] = roles;
    }
  }
  if (data.css !== undefined && typeof data.css !== 'string') throw new Error('A T3 Code theme\'s css must be text.');
  if (typeof data.css === 'string' && data.css.length > 60_000) throw new Error('This T3 Code theme\'s CSS is too long.');
  return { name, appearance: data.appearance, colors, variants, canvas, accent, css: typeof data.css === 'string' ? data.css : '' };
};

/** Known roles with values our sanitizer accepts (no gradients). */
const cleanRoles = (input) => {
  const out = {};
  for (const [role, value] of Object.entries(input)) {
    if (!ROLE_SET.has(role)) continue;
    const clean = sanitizeTokenValue(value);
    if (clean && !/gradient\(/i.test(clean)) out[role] = clean;
  }
  return out;
};

/** Whether a JSON value looks like a T3 Code theme (rather than a Durango one). */
export const looksLikeT3Theme = (data) =>
  isRecord(data) &&
  (data.appearance === 'light' || data.appearance === 'dark') &&
  typeof data.name === 'string' &&
  (isRecord(data.colors) || (typeof data.canvas === 'string' && typeof data.accent === 'string')) &&
  !('tokens' in data);

// --- T3 → Durango ----------------------------------------------------------------------------

/** canvas + accent only (T3 derives a palette): an approximation with color-mix. */
const derivedPalette = (canvas, accent, appearance) => {
  const toward = appearance === 'light' ? 'black' : 'white';
  const mix = (percent) => `color-mix(in oklab, ${canvas} ${100 - percent}%, ${toward})`;
  return {
    canvas,
    chrome: canvas,
    toolbar: canvas,
    surface: mix(4),
    surfaceRaised: mix(3),
    surfaceOverlay: mix(6),
    sidebar: mix(2),
    border: mix(10),
    input: mix(14),
    accentSurface: mix(8),
    toolbarControlHover: mix(8),
    sidebarRowHover: mix(6),
    accent,
    focus: accent,
    messageAction: accent,
    update: accent,
  };
};

/**
 * A theme patch for the store (name, appearance, tokens, css, compat) from a
 * parsed T3 Code theme file.
 */
export const t3ThemeToDurango = (file, { appearance: wanted } = {}) => {
  const parsed = isRecord(file) && 'colors' in file && 'css' in file && typeof file.name === 'string' ? file : parseT3ThemeFile(file);
  const base = parsed.appearance;
  const baseColors = {
    ...(parsed.canvas && parsed.accent ? derivedPalette(parsed.canvas, parsed.accent, base) : {}),
    ...parsed.colors,
  };
  // The file's other appearance, when it has one and it is asked for.
  const appearance = wanted && wanted !== base && parsed.variants?.[wanted] ? wanted : base;
  const own = appearance === base ? baseColors : parsed.variants[appearance];
  const colors = { ...T3_STOCK_COLORS[appearance], ...own };
  const variants = { ...(parsed.variants ?? {}) };
  delete variants[appearance];
  if (appearance !== base) variants[base] = baseColors;
  const tokens = tokensFromT3Colors(colors);
  let css = '';
  if (parsed.css) {
    const rewritten = rewriteT3Css(parsed.css, appearance);
    if (rewritten.length > THEME_LIMITS.css) {
      throw new Error(`This T3 Code theme's CSS is ${rewritten.length.toLocaleString('en-US')} characters once mapped to Durango Code, over the ${THEME_LIMITS.css.toLocaleString('en-US')} a theme can hold.`);
    }
    css = sanitizeThemeCss(rewritten);
  }
  return {
    name: parsed.name,
    description: 'Imported from T3 Code.',
    appearance,
    tokens,
    ...(css.trim() ? { css } : {}),
    compat: { t3: { colors, ...(Object.keys(variants).length ? { variants } : {}) } },
  };
};

/** Which appearances a T3 Code theme file has (its own, and a variant's). */
export const t3ThemeAppearances = (parsed) => [parsed.appearance, ...Object.keys(parsed.variants ?? {})];

/** Our tokens from a full set of T3 roles (import, and to tell which tokens were edited since). */
const tokensFromT3Colors = (colors) => {
  const tokens = {
    'bg-base': colors.canvas,
    'bg-raised': colors.surfaceRaised,
    'bg-surface': colors.surface,
    'bg-elevated': colors.surfaceOverlay,
    'bg-hover': colors.accentSurface,
    'shell-bg': colors.chrome,
    'settings-sidebar-bg': colors.sidebar,
    'border-subtle': colors.sidebarBorder,
    'border-default': colors.border,
    'border-strong': colors.input,
    'text-primary': colors.text,
    'text-secondary': colors.textMuted,
    'text-muted': colors.placeholder,
    accent: colors.accent,
    'on-accent': colors.accentForeground,
    link: colors.accent,
    warning: colors.warning,
    danger: colors.error,
  };
  for (const [name, value] of Object.entries(tokens)) {
    const clean = sanitizeTokenValue(value);
    if (clean) tokens[name] = clean;
    else delete tokens[name];
  }
  return tokens;
};

// --- Durango → T3 ------------------------------------------------------------------------------

// Each role from our tokens: a token name, or [kind, token, other, amount] to mix.
const ROLE_SOURCES = {
  canvas: 'bg-base',
  chrome: 'bg-raised',
  toolbar: 'bg-raised',
  toolbarForeground: 'text-primary',
  toolbarBorder: 'border-default',
  toolbarControl: 'bg-surface',
  toolbarControlForeground: 'text-primary',
  toolbarControlHover: 'bg-hover',
  surface: 'bg-surface',
  surfaceRaised: 'bg-raised',
  surfaceOverlay: 'bg-elevated',
  text: 'text-primary',
  textMuted: 'text-secondary',
  border: 'border-default',
  input: 'border-strong',
  focus: 'accent',
  accent: 'accent',
  accentForeground: 'on-accent',
  secondary: 'bg-surface',
  secondaryForeground: 'text-primary',
  muted: 'bg-surface',
  mutedForeground: 'text-muted',
  placeholder: 'text-muted',
  secondaryLabel: 'text-secondary',
  iconMuted: 'text-muted',
  error: 'danger',
  errorForeground: 'danger',
  errorSurface: ['mix', 'danger', 'bg-base', 0.14],
  warning: 'warning',
  warningForeground: 'warning',
  warningSurface: ['mix', 'warning', 'bg-base', 0.14],
  update: 'accent',
  updateForeground: 'link',
  updateSurface: ['mix', 'accent', 'bg-base', 0.14],
  accentSurface: 'bg-hover',
  accentSurfaceForeground: 'text-primary',
  messageSurface: 'bg-surface',
  messageForeground: 'text-primary',
  messageAction: 'accent',
  messageActionForeground: 'on-accent',
  messageActionHover: ['mix', 'accent', 'text-primary', 0.85],
  codeBackground: 'bg-surface',
  codeForeground: 'text-primary',
  sidebar: 'bg-raised',
  sidebarForeground: 'text-primary',
  sidebarMutedForeground: 'text-secondary',
  sidebarControlSurface: 'bg-surface',
  sidebarRowHover: 'bg-hover',
  sidebarRowActive: ['mix', 'accent', 'bg-raised', 0.16],
  sidebarRowSelected: 'bg-hover',
  sidebarBorder: 'border-subtle',
  terminalBackground: 'bg-base',
  terminalForeground: 'text-primary',
  terminalCursor: 'accent',
  terminalSelection: ['mix', 'accent', 'bg-base', 0.3],
  terminalScrollbar: 'border-strong',
  terminalScrollbarHover: 'text-muted',
};

// Our variables a theme's CSS may use: every token and what themeToCss derives.
// Fonts and radii mean the same in both apps, so they keep their names.
const SHARED_VARIABLES = new Set(['font-mono', 'radius-sm', 'radius-md', 'radius-lg', 'radius-xl']);
const OUR_VARIABLES = [...THEME_TOKEN_NAMES.filter((name) => !SHARED_VARIABLES.has(name)), 'accent-strong', 'accent-deep', 'theme-panel-blur'];
export const DURANGO_VARIABLE_PREFIX = 'dc-';

/** Our token values for export: the theme's, else stock for dark themes (our stock is dark). */
const exportTokens = (theme) => {
  const out = {};
  for (const name of THEME_TOKEN_NAMES) {
    const own = theme.tokens?.[name];
    out[name] = own ?? (theme.appearance === 'light' ? null : THEME_TOKENS[name].stock);
  }
  if (out.accent && !theme.tokens?.link && theme.tokens?.accent) out.link = out.accent;
  return out;
};

const roleColor = (role, tokens) => {
  const source = ROLE_SOURCES[role];
  if (typeof source === 'string') return exportColor(tokens[source]);
  if (Array.isArray(source)) {
    const [, top, bottom, amount] = source;
    const a = parseColor(exportColor(tokens[top]));
    const b = parseColor(exportColor(tokens[bottom]));
    return a && b ? toHex(mixColors(a, b, amount)) : null;
  }
  return null;
};

const sourceTokens = (role) => {
  const source = ROLE_SOURCES[role];
  return typeof source === 'string' ? [source] : Array.isArray(source) ? [source[1], source[2]] : [];
};

/**
 * Every role for T3 Code. A theme imported from T3 Code keeps its own value
 * for each role unless a token that role follows was changed since; other
 * roles come from our tokens, else T3's stock palette.
 */
export const exportT3Colors = (theme) => {
  const tokens = exportTokens(theme);
  const imported = theme.compat?.t3?.colors ?? {};
  const importedTokens = theme.compat?.t3 ? tokensFromT3Colors({ ...T3_STOCK_COLORS[theme.appearance === 'light' ? 'light' : 'dark'], ...imported }) : {};
  const edited = (name) => (theme.tokens?.[name] ?? null) !== (importedTokens[name] ?? null);
  const stock = T3_STOCK_COLORS[theme.appearance === 'light' ? 'light' : 'dark'];
  const colors = {};
  for (const role of T3_THEME_ROLES) {
    const keepImported = imported[role] && !sourceTokens(role).some(edited);
    colors[role] = (keepImported ? exportColor(imported[role]) : null) ?? roleColor(role, tokens) ?? exportColor(imported[role]) ?? stock[role];
  }
  return colors;
};

/** Our hooks back from an import (:is(.sidebar)…), then our classes, as T3 hooks. */
const toT3Selectors = (css) => {
  let out = css;
  for (const [hook, ours] of T3_HOOKS_TO_OURS) out = out.split(ourHook(hook, ours)).join(hook);
  out = out.split(ourHook(DARK_HOOK, ':root')).join(DARK_HOOK).split(ourHook(DARK_HOOK, null)).join(DARK_HOOK);
  for (const [ours, hook] of OURS_TO_T3_HOOKS) {
    out = out.replace(new RegExp(`${escapeRegExp(ours)}(?![\\w-])`, 'g'), hook);
  }
  return out;
};

// What one of our variables is in T3 Code when the theme didn't set it: the
// role it was exported to (so it matches the colors), or a mix of one.
const T3_EQUIVALENTS = {
  'bg-base': 'var(--app-theme-canvas)',
  'bg-raised': 'var(--app-theme-surface-raised)',
  'bg-surface': 'var(--app-theme-surface)',
  'bg-elevated': 'var(--app-theme-surface-overlay)',
  'bg-hover': 'var(--app-theme-accent-surface)',
  'shell-bg': 'var(--app-theme-chrome)',
  'settings-sidebar-bg': 'var(--app-theme-sidebar)',
  'border-subtle': 'var(--app-theme-sidebar-border)',
  'border-default': 'var(--app-theme-border)',
  'border-strong': 'var(--app-theme-input)',
  'text-primary': 'var(--app-theme-text)',
  'text-secondary': 'var(--app-theme-text-muted)',
  'text-muted': 'var(--app-theme-placeholder)',
  accent: 'var(--app-theme-accent)',
  'on-accent': 'var(--app-theme-accent-foreground)',
  link: 'var(--app-theme-update-foreground)',
  warning: 'var(--app-theme-warning)',
  danger: 'var(--app-theme-error)',
  'accent-soft': 'color-mix(in srgb, var(--app-theme-accent) 14%, transparent)',
  'accent-glow': 'color-mix(in srgb, var(--app-theme-accent) 28%, transparent)',
  'accent-strong': 'color-mix(in srgb, var(--app-theme-accent) 88%, black)',
  'accent-deep': 'color-mix(in srgb, var(--app-theme-accent) 72%, black)',
  'font-ui': 'var(--font-sans)',
};

/** The theme's values at their defaults: [data-tv-x="default"] always, other values never. */
const resolveValues = (css, theme) => {
  const specs = theme.values ?? {};
  const defaults = {};
  for (const [name, spec] of Object.entries(specs)) defaults[name] = spec?.default;
  const asText = (value) => (value === undefined || value === null ? '' : String(value));
  return css.replace(ATTRIBUTE_SELECTOR, (match, attribute, double, single, bare) => {
    const lower = attribute.toLowerCase();
    if (!lower.startsWith('data-tv-')) return match;
    const name = lower.slice('data-tv-'.length);
    if (!(name in defaults)) return NEVER;
    const value = double ?? single ?? bare;
    if (value === undefined) return '';
    return value === asText(defaults[name]) ? '' : NEVER;
  });
};

const cssValueForDefault = (spec) => {
  const value = spec?.default;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  return null;
};

// Our variable names (--accent → --dc-accent), noting which were used.
const OUR_VARIABLE_PATTERN = () =>
  new RegExp(`(?<![\\w-])--(${[...OUR_VARIABLES].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?![\\w-])`, 'g');
const renameOurVariables = (text, used) =>
  text.replace(OUR_VARIABLE_PATTERN(), (match, name) => {
    used.add(name);
    return `--${DURANGO_VARIABLE_PREFIX}${name}`;
  });

/** Our selectors, values and variables as T3 Code's (strings already masked). */
const ourCssForT3 = (text, theme, used) => {
  let css = text.replace(/theme-asset\(\s*['"]?[^'")]*['"]?\s*\)/g, 'none');
  css = resolveValues(css, theme);
  // Ours first (--accent → --dc-accent), then an import's T3 names back (--t3-accent → --accent).
  css = renameOurVariables(css, used);
  if (theme.compat?.t3) css = css.replace(new RegExp(`(?<![\\w-])--${escapeRegExp(T3_ALIAS_PREFIX)}`, 'g'), '--');
  return toT3Selectors(css);
};

/**
 * The theme's CSS for T3 Code (without a picture). Our variables become
 * --dc-*, defined at the top with the theme's values.
 */
export const durangoCssForT3 = (theme, { backdropCss = '' } = {}) => {
  const used = new Set();
  const css = outsideStrings(typeof theme.css === 'string' ? theme.css : '', (text) => ourCssForT3(text, theme, used)).trim();
  // A CSS backdrop may use our variables too (its picture is a data: URL, never renamed).
  const backdrop = backdropCss ? outsideStrings(backdropCss, (text) => renameOurVariables(text, used)) : '';

  // Fonts and radius, which T3 Code reads under its own names.
  const shared = [];
  if (theme.tokens?.['font-ui']) shared.push(`--font-sans: ${renameOurVariables(theme.tokens['font-ui'], used)};`);
  if (theme.tokens?.['font-mono']) shared.push(`--font-mono: ${renameOurVariables(theme.tokens['font-mono'], used)};`);
  if (theme.tokens?.['radius-lg']) shared.push(`--radius: ${renameOurVariables(theme.tokens['radius-lg'], used)};`);
  // Each of our variables in use, and the ones their values use in turn
  // (accent-soft: color-mix(… var(--accent) …) needs --dc-accent too).
  const declarations = [];
  const defined = new Set();
  for (let pending = [...used]; pending.length; pending = [...used].filter((name) => !defined.has(name))) {
    for (const name of pending) {
      defined.add(name);
      const value = theme.tokens?.[name] ?? T3_EQUIVALENTS[name] ?? (name === 'theme-panel-blur' ? `${theme.panelBlur ?? 0}px` : THEME_TOKENS[name]?.stock);
      if (value) declarations.push(`--${DURANGO_VARIABLE_PREFIX}${name}: ${renameOurVariables(value, used)};`);
    }
  }
  for (const [name, spec] of Object.entries(theme.values ?? {})) {
    const value = cssValueForDefault(spec);
    if (value !== null && css.includes(`--tv-${name}`)) declarations.push(`--tv-${name}: ${value};`);
  }
  declarations.push(...shared);
  const parts = [];
  if (declarations.length) parts.push(`:root {\n  ${declarations.join('\n  ')}\n}`);
  if (backdrop) parts.push(backdrop);
  if (css) parts.push(css);
  return parts.join('\n\n');
};

/** The CSS that paints a backdrop behind T3 Code's conversation (a data: picture or a CSS background). */
export const t3BackdropCss = (theme, dataUrl) => {
  const backdrop = theme.backdrop;
  const dim = typeof backdrop?.dim === 'number' ? backdrop.dim : 0;
  let layer = null;
  if (dataUrl) layer = `url("${dataUrl}") ${backdrop?.position ?? 'center'} / cover no-repeat`;
  else if (backdrop?.type === 'css' && backdrop.css) layer = backdrop.css;
  if (!layer) return '';
  const veil = dim > 0 ? `linear-gradient(rgb(0 0 0 / ${dim}), rgb(0 0 0 / ${dim})), ` : '';
  return [
    `[data-workspace-area="conversation"] {\n  background: ${veil}${layer} !important;\n}`,
    // T3 Code paints the layers inside the conversation too; let the picture through.
    '[data-workspace-area="conversation"] > *, .messages-timeline-scroll {\n  background-color: transparent !important;\n}',
  ].join('\n');
};

/** A T3 Code theme id from a name (not one of T3 Code's own). */
export const t3ThemeId = (name) => {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 44);
  const id = `dc-${slug || 'theme'}`.slice(0, 48).replace(/-+$/, '');
  return T3_RESERVED_IDS.has(id) ? `${id}-1` : id;
};

/** Whether T3 Code would refuse this CSS for loading files (its own check, packages/shared/src/themeCss.ts). */
export const t3CssLoadsRemoteFiles = (css) => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/@import/i.test(code)) return true;
  const outside = code.replace(
    /url\((?![ \t\n\f\r]*["'])[^)]*|url\([ \t\n\f\r]*("[^"\n\r\f]*"|'[^'\n\r\f]*')|"[^"\n\r\f]*"|'[^'\n\r\f]*'/gi,
    (token, urlString) => {
      if (urlString !== undefined) return /^["'](?:data:|#)/i.test(urlString) ? '' : 'url(';
      return token.startsWith('"') || token.startsWith("'") ? '' : token;
    }
  );
  return /image-set\(|\bsrc\(/i.test(outside) || /url\((?![ \t\n\f\r]*["']?(?:data:|#))/i.test(outside);
};

/**
 * A T3 Code theme file for `theme` (one file for T3 Code's Import and for
 * `t3 theme set`). `backdropDataUrl`: a small data: picture of the backdrop
 * (main.js makes it; dropped if the CSS would not fit). Returns
 * `{ file, notes }`: notes say what could not come along.
 */
export const durangoThemeToT3 = (theme, { backdropDataUrl = null } = {}) => {
  const notes = [];
  const name = (String(theme.name ?? '').trim() || 'Durango theme').slice(0, T3_NAME_MAX).trim();
  const appearance = theme.appearance === 'light' ? 'light' : 'dark';
  const subject = { ...theme, appearance };
  let css = durangoCssForT3(subject, { backdropCss: t3BackdropCss(subject, backdropDataUrl) });
  if (backdropDataUrl && css.length > T3_CSS_MAX_LENGTH) {
    css = durangoCssForT3(subject, { backdropCss: t3BackdropCss(subject, null) });
    notes.push('The backdrop picture did not fit in T3 Code\'s 50,000 characters of CSS, so it was left out.');
  }
  if (css.length > T3_CSS_MAX_LENGTH) {
    throw new Error(`This theme's CSS is ${css.length.toLocaleString('en-US')} characters for T3 Code, over its limit of 50,000. Ask an agent to shorten the theme's CSS.`);
  }
  if (t3CssLoadsRemoteFiles(css)) throw new Error('This theme\'s CSS would load files, which T3 Code refuses.');
  if (theme.backdrop?.type === 'video') notes.push('T3 Code can\'t play video backdrops; its still frame came along when there was one.');
  if (theme.backdrop?.type === 'html' || theme.overlay) notes.push('Animated scenes (HTML backdrop or overlay) can\'t run in T3 Code, so they stay in Durango Code.');
  if (theme.controls?.length) notes.push('The theme\'s controls stay in Durango Code; T3 Code gets each value\'s default.');
  // An imported theme's other appearance goes back as T3 Code's variant.
  const variants = {};
  for (const [look, roles] of Object.entries(theme.compat?.t3?.variants ?? {})) {
    if (look === appearance) continue;
    const colors = {};
    for (const [role, value] of Object.entries(roles)) {
      const color = exportColor(value);
      if (color) colors[role] = color;
    }
    if (Object.keys(colors).length) variants[look] = colors;
  }
  const file = {
    version: 1,
    id: t3ThemeId(name),
    name,
    appearance,
    colors: exportT3Colors(subject),
    ...(Object.keys(variants).length ? { variants } : {}),
    ...(css.trim() ? { css } : {}),
  };
  return { file, notes };
};

/** The image a backdrop has for T3 Code (picture, video poster or a variant's picture), or null. */
export const t3BackdropImageAsset = (theme) => {
  const backdrop = theme.backdrop;
  const isImage = (name) => typeof name === 'string' && /\.(png|jpe?g|webp|gif|avif)$/i.test(name);
  const candidates = [backdrop?.type === 'image' ? backdrop.asset : null, backdrop?.poster];
  for (const variant of backdrop?.variants ?? []) candidates.push(variant?.type === 'image' || !variant?.type ? variant?.asset : null, variant?.poster);
  return candidates.find(isImage) ?? null;
};
