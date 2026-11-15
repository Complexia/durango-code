import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {
  BACKDROP_TYPES,
  STOCK_THEME_ID,
  THEME_CONTROL_KINDS,
  THEME_LIMITS,
  THEME_SCENE_EVENTS,
  THEME_SLOTS,
  THEME_TOKENS,
  THEME_UI_MAP_SCRIPT,
  isValueName,
  isVideoAsset,
  themeSummary,
} from '../ui-themes.js';
import { DurangoError } from './durango-client.js';
import {
  canUndoTheme,
  getActiveTheme,
  getTheme,
  importThemeAsset,
  listThemes,
  sceneErrorsFor,
  setThemeSaved,
  setThemeValues,
  themeValuesFor,
  updateTheme,
  workingThemeFor,
  writeThemeAsset,
} from './ui-themes-store.js';

// Theme tools on Durango Code's built-in `orion` MCP server: an agent restyles
// Durango Code itself, live, from an ordinary thread ("make it look like a
// synthwave sunset"). Like T3 Code's theme tools, plus: animated HTML scenes
// behind and above the app that react to agent activity, backdrops generated
// with Durango inference (generate_theme_media), and screenshots so the agent
// can check its work instead of asking the user to.
//
// Each thread shapes one working theme at a time (ui-themes-store.js). It is
// applied as soon as it changes and stays unsaved until the user turns Save
// on in the theme card the tool leaves in the transcript (or in Settings →
// Themes), or asks the agent to save it.
//
// Schemas live here only: Claude registers them on the in-process SDK server
// (claude-driver.js) and the bridge shim lists them through `__tools`
// (mcp-bridge.js), so there is one source.

export const THEME_TOOL_NAMES = Object.freeze(['get_app_theme', 'set_app_theme', 'generate_theme_media']);
export const THEME_READ_TOOL_NAMES = Object.freeze(['get_app_theme']);
/** Only change how Durango Code looks on this computer: approved in every mode. */
export const THEME_LOCAL_TOOL_NAMES = Object.freeze(['get_app_theme', 'set_app_theme']);

export const DEFAULT_THEME_IMAGE_MODEL = 'google/gemini-3.1-flash-image-preview';
export const DEFAULT_THEME_VIDEO_MODEL = 'google/veo-3.1-fast';
const VIDEO_POLL_MS = 5_000;
const VIDEO_WAIT_MS = 8 * 60 * 1000;
const SETTLE_MS = 1_400;

const tokenTable = () =>
  Object.entries(THEME_TOKENS)
    .map(([name, { stock, label }]) => `${name}: ${label} (stock ${stock})`)
    .join('; ');

const sceneEvents = () =>
  Object.entries(THEME_SCENE_EVENTS)
    .map(([name, text]) => `${name}: ${text}`)
    .join('; ');

const slotList = () =>
  Object.entries(THEME_SLOTS)
    .map(([name, text]) => `${name} (${text})`)
    .join('; ');

const SELECTOR_GUIDE = [
  '.app-shellbar (title bar)',
  '.sidebar (thread list column)',
  '.main-content / .agents-panel (right side)',
  '.thread-pane (one open thread)',
  '.chat-scroll / .chat-container (transcript)',
  '.message.user (user prompt bubble)',
  '.message.agent (agent reply) and .markdown-content inside it',
  '.composer-shell (prompt box)',
  '.settings-page / .settings-sidebar / .settings-panel',
  'pre, code (code blocks)',
  '.theme-backdrop (your backdrop layer)',
].join(', ');

export const THEME_TOOL_DESCRIPTIONS = Object.freeze({
  get_app_theme: `Read Durango Code's current look before restyling it: the active theme (or stock), the theme this thread is shaping, every theme token with its stock value, CSS hooks, the scene event API, and script errors your scenes reported. Pass screenshot: true to also get a picture of the app window as it looks now, to check your work, and ui_map: true for an outline of what is on screen (elements as CSS selectors with their boxes, the theme slots, your placed controls) to find where to put a control or what to style. It also lists the theme's values (current choice) and where each of its controls is on screen. Use it with set_app_theme when the user asks to customize, theme, restyle or decorate Durango Code itself (this app), not their project.`,
  set_app_theme: `Restyle Durango Code itself (the app the user is talking to you in), live: colors, fonts, corner radius, an animated or image backdrop behind the app, an effects overlay above it, and extra CSS. Use it whenever the user asks to customize how Durango Code looks ("make it pink", "synthwave theme", "add snow"); never edit Durango Code's source or files for that. Each call changes this thread's working theme and applies it at once; values you leave out stay as they are (tokens: { name: null } removes one; backdrop/overlay: null removes them; css: "" clears it). The first call starts from the theme in use (pass start_from: "stock" for a clean slate, or "new" for a second theme in this thread). The theme stays unsaved until the user turns Save on in the theme card in this thread (or Settings → Themes), or asks you to: then pass save: true. The user can always return to the original look in Settings → Themes → Stock, or with Cmd/Ctrl+Alt+Shift+0.

Tokens (CSS custom properties; plain colors, gradients, lengths, font lists; no url()): ${tokenTable()}.
Over a backdrop, bg-base/bg-raised/bg-surface/settings-sidebar-bg turn translucent by surface_opacity (default 0.72) so it shows through (base_opacity sets the main transcript area separately); panel_blur frosts panels. Keep text readable: text-primary at least 7:1 against your panels.
Backdrops: {type:"css", css:"<background value>"} | {type:"image", image_path:"/abs/file.png"} | {type:"video", video_path:"/abs/file.mp4"} (muted loop) | {type:"html", html:"<canvas>…<script>…"} (animated scene), each with optional dim (0-0.9 black veil), blur (px), saturate (0-2). To make a backdrop with AI, call generate_theme_media instead.
HTML scenes (backdrop.html, overlay.html) run full-window in a sandbox with no network (inline <style>/<script>, canvas, SVG, data: URIs only), transparent page background; overlay scenes sit above the app with pointer events off, so keep them sparse (particles, confetti, scanlines). In a scene, window.durango.on(event, fn) and durango.state ({working, count, pointer, focused, reducedMotion, appearance}) tell you what the app is doing: ${sceneEvents()}. Make scenes react (calm when idle, livelier while an agent works, a celebration on turn-end "done"), cap devicePixelRatio at 1.5, throttle when !focused, stop when document.hidden, and draw a still frame when reducedMotion.
css: extra CSS for the app (no @import or remote url(); theme-asset("file") refers to this theme's files). Hooks: ${SELECTOR_GUIDE}. Prefer tokens over CSS; use CSS for shapes, shadows, gradients on specific parts, letter-spacing and the like.
Values and controls (the theme's own UI, anywhere the user wants it): declare values, e.g. values: { snow: {type:"boolean", default:true, label:"Snow"}, time: {type:"choice", options:[{value:"day", icon:"sun", label:"Day"}, {value:"night", icon:"moon", label:"Night"}], default:"day"}, glow: {type:"number", min:0, max:1, step:0.05, default:0.6} }, and controls that change them: controls: [{id, kind, value (the value it changes; defaults to id), placement, icon | svg | label, tooltip, show_label}]. Kinds: ${THEME_CONTROL_KINDS.join(', ')}. toggle: a boolean (on/off: {icon, svg, label} per state). choice: a choice value, style "cycle" (one button stepping through the options, showing the current one) or "segmented" (a button per option). menu: a choice value as a dropdown. slider: a number value (width in px). button: action: "<name>" (scenes and widgets hear the action event) and/or set: {value: x}. html: your own widget (any UI: knob, clock, mini player…): html page, width, height, in a sandboxed frame that takes clicks and keys; in it durango.values, durango.set(name, value), durango.action(name, detail), durango.resize(width, height), and durango.state.colors (the theme's resolved colors) to match the app. Icons: any Lucide name (lucide.dev: "snowflake", "sun", "moon", "cloud-snow", "sparkles"…) or svg: "<svg viewBox='0 0 24 24'>…</svg>" (shapes only, stroke currentColor).
Placement: {slot: "<name>"} for spots the app keeps for theme controls: ${slotList()}. Or {selector: "<css selector>", position: "before" | "after" | "start" | "end"} to sit next to or inside any element (get_app_theme with ui_map: true shows what is on screen with selectors and boxes). Or position: "float" to hover over the window (no slot/selector) or over an element, at corner top-left | top-right | bottom-left | bottom-right | center, moved by x/y px. all: true repeats a control for every match (each split pane); order sorts controls sharing a spot. Controls merge by id (a control with an existing id replaces it; {id, remove: true} drops it; controls: null removes all); values: {name: null} removes a value.
What values change: CSS sees each as data-tv-<name> on <html> (:root[data-tv-snow="false"] .theme-overlay { display: none }) and --tv-<name> (booleans 1/0, numbers as they are, choices as a quoted string; opacity: var(--tv-glow)). Scenes and widgets get durango.values and the value event. backdrop.variants switch the backdrop: variants: [{when: {time: "night"}, image_path: "/abs/night.png" (or asset: "<file already in the theme>"), dim, blur, saturate, position…}] (first match wins; it crossfades). generate_theme_media with variant_when makes such a picture for you. Style controls with CSS on [data-theme-control="<id>"] (.theme-control-button, .is-on for a pressed toggle or chosen option). set_values: {name: value} changes the current choice (what the user would click) without redefining anything; values reset with null.
When the user asks for a control, build all of it in one go: the value, the control where they asked, and everything it should change (CSS, scene code that listens, a generated second picture for a variant). Then check with screenshot: true (and get_app_theme for where the controls landed).
Pass screenshot: true to see the result. Keep each html page under ${Math.round(THEME_LIMITS.html / 1000)} KB.`,
  generate_theme_media: `Generate a backdrop for Durango Code's theme with Durango inference (image or looping video models, billed to the user's Durango credits) and apply it to this thread's working theme. Use it when the user wants an AI-made wallpaper, scene, or animated backdrop for the app ("a misty forest at dawn behind everything"). Image takes a few seconds to a minute; video takes one to several minutes (you wait here). Write a vivid prompt for a backdrop: wide, atmospheric, low-detail center with interest at the edges, no text; say "seamless loop, slow subtle motion" for video. With variant_when: {value: x} (a value the theme declares, e.g. {time: "night"}) the media becomes a backdrop variant shown while the values match, instead of replacing the backdrop: keep the same composition as the main picture so the switch reads as the same place. Afterwards tune tokens (accent, surfaces) with set_app_theme so the palette matches the picture, and check with screenshot: true.`,
});

const THEME_TOKENS_SCHEMA = {
  type: 'object',
  description:
    'Token values by name (see the description), e.g. {"bg-base":"#0b0717","accent":"#ff4fd8","font-ui":"\'Avenir Next\', sans-serif"}. null removes a token.',
  additionalProperties: { type: ['string', 'null'] },
};

export const THEME_TOOL_INPUT_SCHEMAS = Object.freeze({
  get_app_theme: {
    type: 'object',
    properties: {
      screenshot: { type: 'boolean', description: 'Also return a picture of the Durango Code window as it looks now.' },
      ui_map: {
        type: 'boolean',
        description: 'Also return an outline of what is on screen: elements as CSS selectors with their boxes, theme slots and placed controls.',
      },
    },
    additionalProperties: false,
  },
  set_app_theme: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Theme name shown in Settings, e.g. "Neon Sunset".' },
      description: { type: 'string', description: 'One short sentence about the look.' },
      appearance: { type: 'string', enum: ['dark', 'light'], description: 'Light or dark (form controls and scrollbars follow).' },
      tokens: THEME_TOKENS_SCHEMA,
      surface_opacity: {
        type: 'number',
        minimum: 0.1,
        maximum: 1,
        description: 'How opaque panels are over a backdrop (0.1-1, default 0.72). null resets it.',
      },
      base_opacity: {
        type: 'number',
        minimum: 0.05,
        maximum: 1,
        description: 'Opacity of the main transcript area over a backdrop (defaults to surface_opacity); lower lets the scene show more behind the conversation.',
      },
      panel_blur: { type: 'number', minimum: 0, maximum: 40, description: 'Frosted-glass blur of panels over the backdrop, in px.' },
      backdrop: {
        type: ['object', 'null'],
        description: 'What paints behind the app; null removes it. See the description for the types.',
        properties: {
          type: { type: 'string', enum: [...BACKDROP_TYPES] },
          css: { type: 'string', description: 'type css: a CSS background value (gradients, colors).' },
          html: { type: 'string', description: 'type html: a self-contained animated scene page.' },
          image_path: {
            type: 'string',
            description:
              'type image: absolute path of a new image file to copy into the theme (one the user gave you or you made). Leave it out to keep the current picture; dim, blur, saturate, position and fit then change in place. Never a screenshot from screenshot: true.',
          },
          video_path: { type: 'string', description: 'type video: absolute path of a new video file to copy into the theme. Leave it out to keep the current video.' },
          dim: { type: 'number', minimum: 0, maximum: 0.9, description: 'Black veil over the backdrop (0-0.9).' },
          blur: { type: 'number', minimum: 0, maximum: 40, description: 'Blur of the backdrop, in px.' },
          saturate: { type: 'number', minimum: 0, maximum: 2, description: 'Saturation of the backdrop (1 = as is).' },
          position: { type: 'string', description: 'image/video: CSS position, e.g. "center" or "left bottom".' },
          fit: { type: 'string', enum: ['cover', 'contain'], description: 'image/video: cover (default) or contain.' },
          variants: {
            type: 'array',
            description:
              'Other looks of the backdrop picked by the theme values: [{when: {name: value}, image_path | video_path | asset | css | html, type, dim, blur, saturate, position, fit}]. Replaces the list; [] removes them.',
            items: { type: 'object' },
          },
        },
        additionalProperties: false,
      },
      values: {
        type: ['object', 'null'],
        description:
          'Value declarations by name (lowercase, dashes): {type: "boolean"|"number"|"choice", default, label, min, max, step, options: [{value, label, icon, svg}]}. Merged by name; {name: null} removes one; null removes all.',
        additionalProperties: { type: ['object', 'null'] },
      },
      controls: {
        type: ['array', 'null'],
        description: 'Controls to add or replace by id (see the description); {id, remove: true} drops one; null removes all.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Lowercase id, e.g. "snow-toggle"; CSS hook [data-theme-control="<id>"].' },
            kind: { type: 'string', enum: [...THEME_CONTROL_KINDS] },
            value: { type: 'string', description: 'The value it changes (toggle/choice/menu/slider); defaults to id.' },
            label: { type: 'string' },
            tooltip: { type: 'string' },
            icon: { type: 'string', description: 'Lucide icon name.' },
            svg: { type: 'string', description: 'Inline <svg> icon (shapes only).' },
            show_label: { type: 'boolean', description: 'Show the label next to the icon.' },
            on: { type: 'object', description: 'toggle: {icon, svg, label} when on.' },
            off: { type: 'object', description: 'toggle: {icon, svg, label} when off.' },
            style: { type: 'string', enum: ['cycle', 'segmented'], description: 'choice: one stepping button or a button per option.' },
            width: { type: 'number', description: 'slider/html: width in px.' },
            height: { type: 'number', description: 'html: height in px.' },
            action: { type: 'string', description: 'button: action name scenes and widgets hear.' },
            set: { type: 'object', description: 'button: values to set when clicked.' },
            html: { type: 'string', description: 'html: the widget page.' },
            placement: {
              type: 'object',
              properties: {
                slot: { type: 'string', enum: Object.keys(THEME_SLOTS) },
                selector: { type: 'string', description: 'CSS selector of the element to sit next to, inside, or over.' },
                position: { type: 'string', enum: ['before', 'after', 'start', 'end', 'float'] },
                corner: { type: 'string', enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'] },
                x: { type: 'number' },
                y: { type: 'number' },
                all: { type: 'boolean', description: 'Repeat for every element the selector matches.' },
                order: { type: 'number' },
              },
              additionalProperties: false,
            },
            remove: { type: 'boolean', description: 'Drop the control with this id.' },
          },
          required: ['id'],
        },
      },
      set_values: {
        type: 'object',
        description: "Change the current choice of the theme's values, e.g. {\"time\": \"night\"}; null returns one to its default.",
        additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
      },
      overlay: {
        type: ['object', 'null'],
        description: 'An HTML scene above the app with pointer events off (sparse effects); null removes it.',
        properties: { html: { type: 'string', description: 'A self-contained scene page.' } },
        additionalProperties: false,
      },
      css: { type: 'string', description: 'Extra CSS for the app; replaces the theme\'s previous css. "" clears it.' },
      start_from: {
        type: 'string',
        description:
          '"current" (default: keep shaping this thread\'s theme, or start from the look in use), "stock" (clean slate), "new" (a second theme in this thread, from the look in use), or a theme id to copy.',
      },
      save: { type: 'boolean', description: 'true when the user asks to keep the theme (lists it in Settings); false unsaves it.' },
      screenshot: { type: 'boolean', description: 'Return a picture of the app after the change.' },
    },
    additionalProperties: false,
  },
  generate_theme_media: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What to generate (see the description for tips).' },
      kind: { type: 'string', enum: ['image', 'video'], description: 'image (default) or a looping video.' },
      model: {
        type: 'string',
        description: `Durango model id; default ${DEFAULT_THEME_IMAGE_MODEL} for images, ${DEFAULT_THEME_VIDEO_MODEL} for video.`,
      },
      aspect_ratio: { type: 'string', description: 'Default 16:9.' },
      duration: { type: 'integer', minimum: 1, maximum: 15, description: 'Video length in seconds (default 6).' },
      dim: { type: 'number', minimum: 0, maximum: 0.9, description: 'Black veil over the backdrop (default 0.35).' },
      blur: { type: 'number', minimum: 0, maximum: 40, description: 'Blur of the backdrop, in px (default 0).' },
      apply: { type: 'boolean', description: 'Use it as the backdrop now (default true). false only saves the file into the theme.' },
      variant_when: {
        type: 'object',
        description: 'Add it as a backdrop variant shown while these theme values match, e.g. {"time": "night"}, instead of replacing the backdrop.',
        additionalProperties: { type: ['string', 'number', 'boolean'] },
      },
      screenshot: { type: 'boolean', description: 'Return a picture of the app afterwards.' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
});

export const themeMcpToolDefinitions = (accessMode) =>
  THEME_TOOL_NAMES.filter((name) => accessMode !== 'read-only' || name !== 'generate_theme_media').map((name) => ({
    name,
    description: THEME_TOOL_DESCRIPTIONS[name],
    inputSchema: THEME_TOOL_INPUT_SCHEMAS[name],
    ...(THEME_LOCAL_TOOL_NAMES.includes(name) ? { annotations: { readOnlyHint: true } } : {}),
  }));

/** System-prompt hint for Claude runs (claude-driver.js). */
export const THEME_TOOLS_PROMPT_HINT = [
  '# Customizing Durango Code (Durango Code)',
  'When the user asks to change how Durango Code itself looks (a theme, colors, fonts, a backdrop or wallpaper, animated effects, "make the app look like…"), use mcp__orion__set_app_theme (and get_app_theme first to see the current look): it restyles the app live from this thread, with no code changes. For AI-made wallpapers or looping video backdrops, use mcp__orion__generate_theme_media (Durango inference). Themes can also add their own controls anywhere in the app (toggles, choices, sliders, menus, buttons or custom HTML widgets in the title bar, sidebar, prompt box or next to any element) whose values drive the theme CSS, scenes and backdrop variants: build the whole feature when asked. Make it delightful: a coherent palette with readable text, and HTML scenes that react to agent activity. Check your work with screenshot: true, then tell the user they can keep it with Save on the theme card and switch themes or go back to Stock in Settings → Themes.',
].join('\n');

// --- helpers ----------------------------------------------------------------------

let durangoClient = null;
/** main.js wires the Durango client (generate_theme_media). */
export const setThemeToolsClient = (client) => {
  durangoClient = client;
};

const fail = (text) => ({ ok: false, text });

const wait = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

const SCREENSHOT_MAX_WIDTH = 1280;

// Agents get the window screenshots below back as files (Claude saves tool
// images under tool-results/), and have mistaken one for the backdrop they
// generated: the theme then painted a frozen copy of the thread behind the
// app. Remember what each screenshot hashes to and refuse it as a backdrop.
const SHOT_HASH_LIMIT = 200;
const shotHashes = new Set();
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const rememberShot = (data) => {
  shotHashes.add(sha256(data));
  if (shotHashes.size > SHOT_HASH_LIMIT) shotHashes.delete(shotHashes.values().next().value);
};

/** True when the file at `filePath` is a window screenshot a theme tool returned. */
const isAppScreenshotFile = async (filePath) => {
  if (!shotHashes.size) return false;
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size > 20 * 1024 * 1024) return false;
    return shotHashes.has(sha256(await fs.readFile(filePath)));
  } catch {
    return false;
  }
};

/** A JPEG of the app window, scaled down; null if the window is gone. */
const captureWindow = async (getSender) => {
  const sender = getSender?.();
  if (!sender || sender.isDestroyed?.() || typeof sender.capturePage !== 'function') return null;
  try {
    let image = await sender.capturePage();
    const size = image.getSize();
    if (size.width > SCREENSHOT_MAX_WIDTH) image = image.resize({ width: SCREENSHOT_MAX_WIDTH, quality: 'good' });
    const jpeg = image.toJPEG(82);
    rememberShot(jpeg);
    return { data: jpeg.toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return null;
  }
};

const emitThemeCard = async ({ getSender, threadId, runId, theme, emitEvent, note }) => {
  const sender = getSender?.();
  if (!runId || !threadId || !sender || sender.isDestroyed?.()) return;
  const emit = emitEvent ?? (await import('./events.js')).emitAgentEvent;
  try {
    emit(sender, {
      runId,
      threadId,
      type: 'activity',
      activity: {
        key: `theme:${theme.id}:${theme.revision}:${crypto.randomUUID().slice(0, 4)}`,
        type: 'tool',
        kind: 'theme',
        title: `Theme: ${theme.name}`,
        status: 'done',
        ...(note ? { detail: note } : {}),
        theme: themeSummary(theme),
      },
    });
  } catch {}
};

const describeTheme = (theme, { full = false } = {}) => {
  if (!theme) return null;
  const shown = { ...theme };
  if (!full) {
    for (const key of ['backdrop', 'overlay']) {
      if (shown[key]?.html && shown[key].html.length > 4000) {
        shown[key] = { ...shown[key], html: `${shown[key].html.slice(0, 4000)}… (${shown[key].html.length} chars)` };
      }
    }
    if (shown.css && shown.css.length > 6000) shown.css = `${shown.css.slice(0, 6000)}… (${shown.css.length} chars)`;
  }
  return shown;
};

const resultWithShot = async (text, { screenshot, getSender }) => {
  if (!screenshot) return { ok: true, text };
  const shot = await captureWindow(getSender);
  if (!shot) return { ok: true, text: `${text}\n(No screenshot: the window is not available.)` };
  return {
    ok: true,
    text,
    content: [
      { type: 'text', text },
      { type: 'image', data: shot.data, mimeType: shot.mimeType },
    ],
    images: [shot],
  };
};

const savedNote = (theme) =>
  theme.saved
    ? 'It is saved: it is in Settings → Themes.'
    : 'It is not saved yet: the user keeps it with Save on the theme card in this thread (or in Settings → Themes); if they ask you to keep it, call set_app_theme with save: true.';

/** The theme to change for this call, or the base a new one starts from. */
const resolveTarget = async (threadId, startFrom) => {
  const working = await workingThemeFor(threadId);
  const from = typeof startFrom === 'string' ? startFrom.trim() : 'current';
  if (!from || from === 'current') {
    if (working) return { id: working.id };
    return { base: await getActiveTheme() };
  }
  if (from === 'stock') return { base: null };
  if (from === 'new') return { base: await getActiveTheme() };
  if (from === STOCK_THEME_ID) return { base: null };
  const source = await getTheme(from);
  if (!source) throw new Error(`No theme with id ${from}. Leave start_from out, or use "current", "stock" or "new".`);
  return { base: source };
};

const withFile = async (input, themeIdForAssets) => {
  const { image_path: imagePath, video_path: videoPath, ...rest } = input;
  const patch = { ...rest };
  if (imagePath || videoPath) {
    if (await isAppScreenshotFile(String(imagePath || videoPath))) {
      throw new Error(
        `${imagePath || videoPath} is a screenshot of Durango Code that a theme tool returned, not a backdrop picture. ` +
          'To change how the current backdrop looks (dim, blur, saturate, position, fit), pass backdrop without image_path: the picture stays. Nothing was changed.'
      );
    }
    const asset = await importThemeAsset(themeIdForAssets, String(imagePath || videoPath));
    patch.type = isVideoAsset(asset) ? 'video' : 'image';
    patch.asset = asset;
  }
  return patch;
};

const needsFile = (input) =>
  Boolean(
    input &&
      (input.image_path ||
        input.video_path ||
        (Array.isArray(input.variants) && input.variants.some((variant) => variant?.image_path || variant?.video_path)))
  );

const backdropPatch = async (input, themeIdForAssets) => {
  if (input === null) return { backdrop: null };
  if (!input || typeof input !== 'object') return {};
  const patch = await withFile(input, themeIdForAssets);
  if (Array.isArray(input.variants)) {
    patch.variants = [];
    for (const variant of input.variants) {
      if (variant && typeof variant === 'object') patch.variants.push(await withFile(variant, themeIdForAssets));
    }
  }
  return { backdrop: patch };
};

/** Theme ids get created before assets are copied in; see setTheme. */
const defaultNameFor = (target) => (target.id ? undefined : target.base ? `${target.base.name} remix` : 'My theme');

const ensureThemeId = async ({ threadId, target }) => {
  if (target.id) return target.id;
  const { theme } = await updateTheme({
    patch: { name: defaultNameFor(target) },
    threadId,
    base: target.base,
    activate: false,
  });
  target.id = theme.id;
  return theme.id;
};

// --- tools --------------------------------------------------------------------------

/** Runs a script in the app window; null when there is no window (tests, closed). */
const runInWindow = async (getSender, script) => {
  const sender = getSender?.();
  if (!sender || sender.isDestroyed?.() || typeof sender.executeJavaScript !== 'function') return null;
  try {
    return await sender.executeJavaScript(script, true);
  } catch {
    return null;
  }
};

// Where each theme control is on screen right now: id → boxes.
const PLACED_CONTROLS_SCRIPT = `(() => {
  const out = {};
  for (const el of document.querySelectorAll('[data-theme-control]')) {
    const r = el.getBoundingClientRect();
    (out[el.dataset.themeControl] ||= []).push(r.width || r.height ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null);
  }
  return out;
})()`;

const describePlacement = (placement) => {
  const where = placement.slot ? `slot ${placement.slot}` : placement.selector ? `"${placement.selector}"` : 'the window';
  if (placement.position === 'float') return `floating over ${where} at ${placement.corner ?? 'top-right'}${placement.x || placement.y ? ` (+${placement.x ?? 0},+${placement.y ?? 0})` : ''}`;
  return placement.slot ? `in ${where}` : `${placement.position} ${where}`;
};

/** Lines about a theme's values and controls, with where the controls are now. */
const controlLines = async (theme, getSender) => {
  if (!theme?.values && !theme?.controls) return [];
  const lines = [];
  const current = await themeValuesFor(theme.id);
  if (theme.values) {
    lines.push(
      `Values (current): ${Object.entries(theme.values)
        .map(([name, spec]) => `${name} = ${JSON.stringify(current[name])} (${spec.type}${spec.type === 'choice' ? `: ${spec.options.map((option) => option.value).join('|')}` : spec.type === 'number' ? ` ${spec.min}..${spec.max}` : ''}, default ${JSON.stringify(spec.default)})`)
        .join('; ')}.`
    );
  }
  if (theme.controls?.length) {
    const placed = (await runInWindow(getSender, PLACED_CONTROLS_SCRIPT)) ?? null;
    lines.push(
      `Controls: ${theme.controls
        .map((control) => {
          const boxes = placed?.[control.id] ?? [];
          const shown = boxes.filter(Boolean);
          const status = !placed
            ? ''
            : shown.length
              ? ` — on screen ${shown.map((box) => `[${box[0]},${box[1]} ${box[2]}x${box[3]}]`).join(' ')}`
              : boxes.length
                ? ' — placed but not visible (its spot is hidden or zero-sized)'
                : ' — not on screen now (its slot/selector matches nothing showing)';
          return `${control.id} (${control.kind}${control.value ? ` → ${control.value}` : ''}${control.action ? ` → action ${control.action}` : ''}) ${describePlacement(control.placement)}${status}`;
        })
        .join('; ')}.`
    );
  }
  return lines;
};

const getAppTheme = async (args, context) => {
  const { activeId, themes } = await listThemes();
  const active = themes.find((theme) => theme.id === activeId) ?? null;
  const working = await workingThemeFor(context.threadId);
  const errors = active ? sceneErrorsFor(active.id) : [];
  const lines = [
    active
      ? `Active theme: "${active.name}" (${active.id}${active.builtIn ? ', built-in' : active.saved ? ', saved' : ', unsaved'}).`
      : 'Active theme: Stock (the original look, no theme).',
    working
      ? `This thread's working theme: "${working.name}" (${working.id}, revision ${working.revision}${working.id === activeId ? ', in use' : ', not in use; set_app_theme applies it again'}). ${savedNote(working)}`
      : 'This thread has no working theme yet; set_app_theme starts one from the look in use.',
    errors.length ? `Scene script errors: ${errors.join(' | ')}` : null,
    ...(await controlLines(working ?? active, context.getSender)),
    `Themes available: ${themes.map((theme) => `${theme.name} (${theme.id}${theme.builtIn ? ', built-in' : theme.saved ? '' : ', unsaved'})`).filter((_, index, list) => list.length < 40 || index < 40).join(', ')}.`,
    `Active theme JSON: ${active ? JSON.stringify(describeTheme(active)) : 'null'}`,
    `Theme slots for controls: ${slotList()}.`,
  ].filter(Boolean);
  if (args.ui_map === true) {
    const map = await runInWindow(context.getSender, THEME_UI_MAP_SCRIPT);
    lines.push(typeof map === 'string' ? `UI map:\n${map}` : 'UI map: the window is not available.');
  }
  return resultWithShot(lines.join('\n'), { screenshot: args.screenshot === true, getSender: context.getSender });
};

const setAppTheme = async (args, context) => {
  const { threadId } = context;
  const target = await resolveTarget(threadId, args.start_from);
  const patch = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.description !== undefined) patch.description = args.description;
  if (args.appearance !== undefined) patch.appearance = args.appearance;
  if (args.tokens !== undefined) patch.tokens = args.tokens;
  if (args.surface_opacity !== undefined) patch.surfaceOpacity = args.surface_opacity;
  if (args.panel_blur !== undefined) patch.panelBlur = args.panel_blur;
  if (args.base_opacity !== undefined) patch.baseOpacity = args.base_opacity;
  if (args.overlay !== undefined) patch.overlay = args.overlay;
  if (args.css !== undefined) patch.css = args.css;
  let themeId = target.id;
  if (args.values !== undefined) patch.values = args.values;
  if (args.controls !== undefined) patch.controls = args.controls;
  if (args.backdrop !== undefined) {
    if (needsFile(args.backdrop)) themeId = await ensureThemeId({ threadId, target });
    Object.assign(patch, await backdropPatch(args.backdrop, themeId));
  }
  if (patch.name === undefined && defaultNameFor(target)) patch.name = defaultNameFor(target);
  const { theme, ignored } = await updateTheme({
    id: themeId,
    patch,
    threadId,
    base: themeId ? undefined : target.base,
    ...(typeof args.save === 'boolean' ? { saved: args.save } : {}),
  });
  let valueNote = null;
  if (args.set_values && typeof args.set_values === 'object') {
    const { ignored: valueIgnored } = await setThemeValues(theme.id, args.set_values);
    if (valueIgnored.length) ignored.push(...valueIgnored.map((entry) => `set_values ${entry}`));
    else valueNote = 'Values set.';
  }
  await emitThemeCard({ ...context, theme });
  const hasScene = Boolean(theme.backdrop?.type === 'html' || theme.overlay || theme.controls?.length);
  if (hasScene || args.screenshot) await wait(SETTLE_MS, context.signal);
  const errors = sceneErrorsFor(theme.id);
  const text = [
    `Applied "${theme.name}" (${theme.id}, revision ${theme.revision}); Durango Code shows it now.`,
    savedNote(theme),
    ignored.length ? `Ignored: ${ignored.join('; ')}.` : null,
    errors.length ? `Scene script errors (fix them): ${errors.join(' | ')}` : hasScene ? 'Scenes loaded without script errors.' : null,
    valueNote,
    ...(await controlLines(theme, context.getSender)),
    'The user can return to the original look any time (Settings → Themes → Stock).',
  ]
    .filter(Boolean)
    .join('\n');
  return resultWithShot(text, { screenshot: args.screenshot === true, getSender: context.getSender });
};

const durangoFailure = (error) => {
  if (error instanceof DurangoError) {
    if (error.code === 'not_signed_in') return 'Sign in to Durango in Durango Code (Settings → Account) to generate media with Durango inference.';
    if (error.status === 402) return `Durango inference needs credits or a plan for this: ${error.message}`;
    if (error.status === 403) return `Durango refused: ${error.message}`;
    return `Durango inference failed: ${error.message}`;
  }
  return `Generation failed: ${error?.message ?? error}`;
};

const generateThemeMedia = async (args, context) => {
  if (context.accessMode === 'read-only') {
    return fail('generate_theme_media spends Durango credits, so it is unavailable in Read only access mode.');
  }
  if (!durangoClient) return fail('Durango inference is not available in this build.');
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return fail('generate_theme_media requires a prompt.');
  const kind = args.kind === 'video' ? 'video' : 'image';
  const model = typeof args.model === 'string' && args.model.trim()
    ? args.model.trim()
    : kind === 'video' ? DEFAULT_THEME_VIDEO_MODEL : DEFAULT_THEME_IMAGE_MODEL;
  const aspectRatio = typeof args.aspect_ratio === 'string' && args.aspect_ratio ? args.aspect_ratio : '16:9';
  const { signal, threadId } = context;
  const when = args.variant_when && typeof args.variant_when === 'object' && !Array.isArray(args.variant_when) ? args.variant_when : null;
  if (when) {
    // Check before spending credits: a variant must be able to show.
    const bad = Object.entries(when).filter(([name, value]) => !isValueName(name) || !['string', 'number', 'boolean'].includes(typeof value));
    if (!Object.keys(when).length || bad.length) {
      return fail('variant_when needs { name: value } pairs with value names (lowercase, dashes) and plain values, e.g. {"time": "night"}.');
    }
    const working = await workingThemeFor(threadId);
    const current = working ?? (await getActiveTheme());
    const key = JSON.stringify(when);
    const others = (current?.backdrop?.variants ?? []).filter((variant) => JSON.stringify(variant.when) !== key);
    if (others.length >= THEME_LIMITS.variants) {
      return fail(`The backdrop already has ${THEME_LIMITS.variants} variants (the most it can keep). Remove one with set_app_theme backdrop.variants first.`);
    }
  }
  let media;
  let creditsUsed = null;
  try {
    if (kind === 'image') {
      const image = await durangoClient.generateImage({ model, prompt, aspectRatio, imageSize: '2K', signal });
      media = image;
      creditsUsed = image.creditsUsed;
    } else {
      const duration = Number.isInteger(args.duration) ? args.duration : 6;
      const { runId } = await durangoClient.startVideoGeneration({ model, prompt, aspectRatio, duration, signal });
      const deadline = Date.now() + VIDEO_WAIT_MS;
      let run = null;
      while (Date.now() < deadline) {
        if (signal?.aborted) return fail('Stopped before the video finished.');
        await wait(VIDEO_POLL_MS, signal);
        run = await durangoClient.videoGeneration(runId, { signal });
        if (run.status !== 'running') break;
      }
      if (!run || run.status === 'running') return fail('The video is still generating after 8 minutes; try again later or use an image.');
      if (run.status === 'failed' || !run.videoUrls.length) return fail(`The video generation failed: ${run.error ?? 'no video came back'}.`);
      media = await durangoClient.downloadGeneratedMedia(run.videoUrls[0], { signal });
      creditsUsed = run.creditsUsed;
    }
  } catch (error) {
    if (signal?.aborted) return fail('Stopped before the generation finished.');
    return fail(durangoFailure(error));
  }
  const target = await resolveTarget(threadId, 'current');
  const themeId = await ensureThemeId({ threadId, target });
  const asset = await writeThemeAsset(themeId, media.data, media.mimeType || (kind === 'video' ? 'mp4' : 'png'));
  const apply = args.apply !== false;
  let theme = await getTheme(themeId);
  let variantNote = null;
  if (apply) {
    const look = {
      type: isVideoAsset(asset) ? 'video' : 'image',
      asset,
      ...(typeof args.dim === 'number' ? { dim: args.dim } : {}),
      ...(typeof args.blur === 'number' ? { blur: args.blur } : {}),
    };
    let backdrop = { ...look, dim: look.dim ?? 0.35 };
    if (when && theme?.backdrop) {
      // A variant beside the current backdrop (one per condition).
      const key = JSON.stringify(when);
      const variants = (theme.backdrop.variants ?? []).filter((variant) => {
        const { when: other } = variant;
        return JSON.stringify(other) !== key;
      });
      backdrop = { variants: [...variants, { when, ...look }] };
      const undeclared = Object.keys(when).filter((name) => !theme.values?.[name]);
      variantNote = `It is a backdrop variant shown while ${Object.entries(when).map(([name, value]) => `${name} = ${JSON.stringify(value)}`).join(' and ')}; the main backdrop is unchanged.${
        undeclared.length ? ` Declare ${undeclared.join(', ')} in values (set_app_theme) or it never shows.` : ''
      }`;
    } else if (when) {
      variantNote = 'The theme had no backdrop yet, so this became the main backdrop rather than a variant.';
    }
    ({ theme } = await updateTheme({
      id: themeId,
      patch: { backdrop },
      threadId,
    }));
    await emitThemeCard({ ...context, theme, note: `Generated with ${model}` });
    await wait(SETTLE_MS, signal);
  }
  const text = [
    `Generated a ${kind} with ${model}${creditsUsed ? ` (${creditsUsed} credits)` : ''} and saved it in theme "${theme?.name}" as ${asset}.`,
    variantNote,
    apply && variantNote?.startsWith('It is a backdrop variant')
      ? null
      : apply
      ? `It is the backdrop now (${asset}). Tune the palette to match it with set_app_theme (accent, surfaces, surface_opacity) and check with screenshot: true. To adjust the picture itself, pass backdrop { dim, blur, saturate } without image_path: the file stays.`
      : `Use it with set_app_theme css as theme-asset("${asset}").`,
    theme ? savedNote(theme) : null,
    args.screenshot === true ? 'The picture below is a screenshot of the app window, not the backdrop file: never pass it as image_path.' : null,
  ]
    .filter(Boolean)
    .join('\n');
  return resultWithShot(text, { screenshot: args.screenshot === true, getSender: context.getSender });
};

/**
 * Run one theme tool for thread `threadId`. Resolves `{ ok, text, content?,
 * images? }`, never throws. `content` carries MCP blocks (screenshots) for
 * the bridge; `images` the same for Claude's in-process server.
 */
export const runThemeTool = async (name, rawArgs, context = {}) => {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  if (!THEME_TOOL_NAMES.includes(name)) return fail(`Unknown tool: ${name}`);
  if (!context.threadId) return fail('This agent run is not attached to a Durango Code thread.');
  try {
    if (name === 'get_app_theme') return await getAppTheme(args, context);
    if (name === 'set_app_theme') return await setAppTheme(args, context);
    return await generateThemeMedia(args, context);
  } catch (error) {
    return fail(`${name} failed: ${error?.message ?? error}`);
  }
};

/** For the transcript card's Undo button availability. */
export { canUndoTheme, setThemeSaved };
