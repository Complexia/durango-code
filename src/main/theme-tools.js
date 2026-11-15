import crypto from 'node:crypto';
import {
  BACKDROP_TYPES,
  STOCK_THEME_ID,
  THEME_LIMITS,
  THEME_SCENE_EVENTS,
  THEME_TOKENS,
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
// Customizations), or asks the agent to save it.
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
  get_app_theme: `Read Durango Code's current look before restyling it: the active theme (or stock), the theme this thread is shaping, every theme token with its stock value, CSS hooks, the scene event API, and script errors your scenes reported. Pass screenshot: true to also get a picture of the app window as it looks now, to check your work. Use it with set_app_theme when the user asks to customize, theme, restyle or decorate Durango Code itself (this app), not their project.`,
  set_app_theme: `Restyle Durango Code itself (the app the user is talking to you in), live: colors, fonts, corner radius, an animated or image backdrop behind the app, an effects overlay above it, and extra CSS. Use it whenever the user asks to customize how Durango Code looks ("make it pink", "synthwave theme", "add snow"); never edit Durango Code's source or files for that. Each call changes this thread's working theme and applies it at once; values you leave out stay as they are (tokens: { name: null } removes one; backdrop/overlay: null removes them; css: "" clears it). The first call starts from the theme in use (pass start_from: "stock" for a clean slate, or "new" for a second theme in this thread). The theme stays unsaved until the user turns Save on in the theme card in this thread (or Settings → Customizations), or asks you to: then pass save: true. The user can always return to the original look in Settings → Customizations → Stock, or with Cmd/Ctrl+Alt+Shift+0.

Tokens (CSS custom properties; plain colors, gradients, lengths, font lists; no url()): ${tokenTable()}.
Over a backdrop, bg-base/bg-raised/bg-surface/settings-sidebar-bg turn translucent by surface_opacity (default 0.72) so it shows through (base_opacity sets the main transcript area separately); panel_blur frosts panels. Keep text readable: text-primary at least 7:1 against your panels.
Backdrops: {type:"css", css:"<background value>"} | {type:"image", image_path:"/abs/file.png"} | {type:"video", video_path:"/abs/file.mp4"} (muted loop) | {type:"html", html:"<canvas>…<script>…"} (animated scene), each with optional dim (0-0.9 black veil), blur (px), saturate (0-2). To make a backdrop with AI, call generate_theme_media instead.
HTML scenes (backdrop.html, overlay.html) run full-window in a sandbox with no network (inline <style>/<script>, canvas, SVG, data: URIs only), transparent page background; overlay scenes sit above the app with pointer events off, so keep them sparse (particles, confetti, scanlines). In a scene, window.durango.on(event, fn) and durango.state ({working, count, pointer, focused, reducedMotion, appearance}) tell you what the app is doing: ${sceneEvents()}. Make scenes react (calm when idle, livelier while an agent works, a celebration on turn-end "done"), cap devicePixelRatio at 1.5, throttle when !focused, stop when document.hidden, and draw a still frame when reducedMotion.
css: extra CSS for the app (no @import or remote url(); theme-asset("file") refers to this theme's files). Hooks: ${SELECTOR_GUIDE}. Prefer tokens over CSS; use CSS for shapes, shadows, gradients on specific parts, letter-spacing and the like.
Pass screenshot: true to see the result. Keep each html page under ${Math.round(THEME_LIMITS.html / 1000)} KB.`,
  generate_theme_media: `Generate a backdrop for Durango Code's theme with Durango inference (image or looping video models, billed to the user's Durango credits) and apply it to this thread's working theme. Use it when the user wants an AI-made wallpaper, scene, or animated backdrop for the app ("a misty forest at dawn behind everything"). Image takes a few seconds to a minute; video takes one to several minutes (you wait here). Write a vivid prompt for a backdrop: wide, atmospheric, low-detail center with interest at the edges, no text; say "seamless loop, slow subtle motion" for video. Afterwards tune tokens (accent, surfaces) with set_app_theme so the palette matches the picture, and check with screenshot: true.`,
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
          image_path: { type: 'string', description: 'type image: absolute path of an image file to copy into the theme.' },
          video_path: { type: 'string', description: 'type video: absolute path of a video file to copy into the theme.' },
          dim: { type: 'number', minimum: 0, maximum: 0.9, description: 'Black veil over the backdrop (0-0.9).' },
          blur: { type: 'number', minimum: 0, maximum: 40, description: 'Blur of the backdrop, in px.' },
          saturate: { type: 'number', minimum: 0, maximum: 2, description: 'Saturation of the backdrop (1 = as is).' },
          position: { type: 'string', description: 'image/video: CSS position, e.g. "center" or "left bottom".' },
          fit: { type: 'string', enum: ['cover', 'contain'], description: 'image/video: cover (default) or contain.' },
        },
        additionalProperties: false,
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
  'When the user asks to change how Durango Code itself looks (a theme, colors, fonts, a backdrop or wallpaper, animated effects, "make the app look like…"), use mcp__orion__set_app_theme (and get_app_theme first to see the current look): it restyles the app live from this thread, with no code changes. For AI-made wallpapers or looping video backdrops, use mcp__orion__generate_theme_media (Durango inference). Make it delightful: a coherent palette with readable text, and HTML scenes that react to agent activity. Check your work with screenshot: true, then tell the user they can keep it with Save on the theme card and switch themes or go back to Stock in Settings → Customizations.',
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

/** A JPEG of the app window, scaled down; null if the window is gone. */
const captureWindow = async (getSender) => {
  const sender = getSender?.();
  if (!sender || sender.isDestroyed?.() || typeof sender.capturePage !== 'function') return null;
  try {
    let image = await sender.capturePage();
    const size = image.getSize();
    if (size.width > SCREENSHOT_MAX_WIDTH) image = image.resize({ width: SCREENSHOT_MAX_WIDTH, quality: 'good' });
    return { data: image.toJPEG(82).toString('base64'), mimeType: 'image/jpeg' };
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
    ? 'It is saved: it is in Settings → Customizations.'
    : 'It is not saved yet: the user keeps it with Save on the theme card in this thread (or in Settings → Customizations); if they ask you to keep it, call set_app_theme with save: true.';

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

const backdropPatch = async (input, themeIdForAssets) => {
  if (input === null) return { backdrop: null };
  if (!input || typeof input !== 'object') return {};
  const { image_path: imagePath, video_path: videoPath, ...rest } = input;
  const patch = { ...rest };
  if (imagePath || videoPath) {
    const asset = await importThemeAsset(themeIdForAssets, String(imagePath || videoPath));
    patch.type = isVideoAsset(asset) ? 'video' : 'image';
    patch.asset = asset;
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
    `Themes available: ${themes.map((theme) => `${theme.name} (${theme.id}${theme.builtIn ? ', built-in' : theme.saved ? '' : ', unsaved'})`).filter((_, index, list) => list.length < 40 || index < 40).join(', ')}.`,
    `Active theme JSON: ${active ? JSON.stringify(describeTheme(active)) : 'null'}`,
  ].filter(Boolean);
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
  if (args.backdrop !== undefined) {
    const needsFile = args.backdrop && (args.backdrop.image_path || args.backdrop.video_path);
    if (needsFile) themeId = await ensureThemeId({ threadId, target });
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
  await emitThemeCard({ ...context, theme });
  const hasScene = Boolean(theme.backdrop?.type === 'html' || theme.overlay);
  if (hasScene || args.screenshot) await wait(SETTLE_MS, context.signal);
  const errors = sceneErrorsFor(theme.id);
  const text = [
    `Applied "${theme.name}" (${theme.id}, revision ${theme.revision}); Durango Code shows it now.`,
    savedNote(theme),
    ignored.length ? `Ignored: ${ignored.join('; ')}.` : null,
    errors.length ? `Scene script errors (fix them): ${errors.join(' | ')}` : hasScene ? 'Scenes loaded without script errors.' : null,
    'The user can return to the original look any time (Settings → Customizations → Stock).',
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
  if (apply) {
    const backdrop = {
      type: isVideoAsset(asset) ? 'video' : 'image',
      asset,
      dim: typeof args.dim === 'number' ? args.dim : 0.35,
      ...(typeof args.blur === 'number' ? { blur: args.blur } : {}),
    };
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
    apply
      ? 'It is the backdrop now. Tune the palette to match it with set_app_theme (accent, surfaces, surface_opacity, dim) and check with screenshot: true.'
      : `Use it with set_app_theme css as theme-asset("${asset}").`,
    theme ? savedNote(theme) : null,
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
