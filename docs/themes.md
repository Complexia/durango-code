# Themes (Settings → Themes)

Users restyle Durango Code by asking an agent in an ordinary thread ("make it a synthwave sunset",
"generate a misty forest wallpaper"). The agent calls the theme tools on the built-in `orion` MCP
server and the app changes live. Each thread shapes one working theme; it stays unsaved until the
user turns **Save** on in the theme card the tool leaves in the transcript (or the agent passes
`save: true` when asked). Saved themes, six prebuilt ones and **Stock** (the original look, no
theme at all) are switched in Settings → Themes.

Agents can do everything that page does through `manage_app_themes`: list, apply, stock, save,
unsave, rename, duplicate, delete, undo, turn animated effects on or off, play the celebration, and
`measure` (CPU of each Durango Code process over a few seconds, from `app.getAppMetrics`).
`set_app_theme` with `theme_id` changes a theme the user already has in place instead of a copy; the
thread then shapes that theme.

## Pieces

| File | Role |
|---|---|
| `src/ui-themes.js` | The format, shared by main and renderer: `THEME_TOKENS` (CSS custom properties a theme may set, with stock values equal to `src/index.css` `:root`), `sanitizeTheme`, `mergeTheme`, `themeToCss`, HTML scene documents (`buildSceneDocument`, CSP + `window.durango` bootstrap). |
| `src/ui-themes-builtin.js` | The prebuilt themes (animated HTML scenes, no files). |
| `src/main/ui-themes-store.js` | Storage under `<userData>/themes/` (`state.json` = active id, each theme's current values and the animated-effects setting, `<id>/theme.json`, `<id>/history.json` for Undo, `<id>/<asset>` backdrop files). Broadcasts `themes:changed`. Unsaved themes nobody uses are pruned after 14 days. |
| `src/main/theme-tools.js` | `get_app_theme`, `set_app_theme`, `manage_app_themes`, `generate_theme_media` (one schema source: Claude registers them in `claude-driver.js`, the bridge lists them through `__tools`). |
| `src/app/themes/ThemeLayer.tsx` | Applies the active theme: a `<style>` (textContent only), the backdrop behind the app (`z-index: -1` in `body`), an overlay scene above it (pointer events off), and agent activity → scene events. |
| `src/app/themes/ThemeControls.tsx` | The theme's own controls (lazy-loaded): places a host for each control in a slot, next to or inside a selector's element, or floating; re-places them as the app re-renders; draws toggle / choice / slider / menu / button, or the theme's HTML widget. |
| `src/app/themes/ThemeControlsSettings.tsx` | Settings → Themes → "<theme> controls": the active theme's values as plain settings (switch, segmented, slider), where each control sits, Run for action buttons, Reset to defaults. |
| `src/app/themes/ThemeSlot.tsx` | Empty named spots the app renders for controls (`THEME_SLOTS`: title bar, sidebar, prompt box, split-pane header). |
| `src/app/themes/ThemeSceneFrame.tsx` | One sandboxed scene frame (backdrop, overlay or widget): app events in; `durango.set` / `action` / `resize` out. |
| `src/app/themes/ThemeCard.tsx` | The transcript card: preview, Save toggle, Use, Undo, Back to stock. |
| `src/app/themes/CustomizationsSettings.tsx` | Settings tab: "Customize with an agent", gallery, effects toggle, celebration preview. |

## Values and controls

A theme declares `values` (`boolean`, `number`, `choice`) and `controls` that change them. The user's current
choice lives in `state.json` (`values[themeId]`, defaults not stored), not in the theme: changing it is no
revision and no Undo step. The active theme's values are reflected as `data-tv-<name>` on `<html>` and
`--tv-<name>` custom properties (so theme CSS follows them), sent to scenes and widgets (`durango.values`, the
`value` event), and pick `backdrop.variants` (`when: { name: value }`, first match wins, crossfade).

Control kinds: `toggle`, `choice` (cycle or segmented), `slider`, `menu`, `button` (action and/or set values),
`html` (a sandboxed widget that takes input). Placement: `slot`, or `selector` + `before | after | start | end`,
or `float` at a corner of an element or the window. `get_app_theme` reports where each control is on screen and,
with `ui_map: true`, an outline of the UI with selectors and boxes; `generate_theme_media` with `variant_when`
adds a generated picture as a variant.

## Performance

A theme runs all day, often on a laptop, while agents work, so it should cost close to Stock.
Measured on an M-series MacBook Air with the window focused and an agent working, in % of one CPU core:
Stock ~25; a snow overlay that built a radial gradient per flake per frame at 60 fps over 14px frosted
panels ~68; the same snow drawn from one sprite at 30 fps ~62; with static frost too ~33.

- **Static frost.** `backdrop-filter` re-runs every frame something behind or above a panel changes,
  and an overlay damages the whole window. For an image backdrop with an overlay, `ThemeLayer`
  (`useStaticFrost`) asks main for a small copy of the picture (`themes:frost`, made once with
  `nativeImage`, saved as `frost-<width>-<asset>.jpg`) and the `html.theme-static-frost` rules in
  `index.css` paint each panel as its tint over the dim veil over that copy, `fixed` to the window
  so it lines up with the backdrop. The browser's smooth upscale does the blurring. Video and HTML
  backdrops change every frame, so they keep the live blur, and the tools tell the agent to keep
  `panel_blur` at 0 with them.
- **Guidance.** The rules (`PERFORMANCE_GUIDE` in `theme-tools.js`) come back in `get_app_theme`'s result and in a
  thread's first `set_app_theme` result, not in the tool descriptions, so only theme work loads them (tool
  descriptions are listed to some providers on every request). They say: draw particles from a pre-rendered sprite
  (no per-particle gradients, `shadowBlur` or `ctx.filter`), at most 30 fps (15 unfocused), a capped
  devicePixelRatio, nothing while `document.hidden`, one still frame on `reducedMotion`, and CSS
  animations of transform and opacity only.
- **Notes.** `performanceNotes(theme)` reads the theme after every change (`set_app_theme`, `apply`,
  `generate_theme_media`) and tells the agent what will cost CPU or GPU every frame.
- **Screenshots** are only for the agent to check its work: they show the user's threads, so the
  guidance says never to use one as a backdrop or theme file.

## Motion

`src/app/themes/motionPolicy.ts` decides when a theme's moving parts (video backdrops, HTML
scenes) play:

- **Still:** the "Animated backdrops and effects" switch is off, or the OS asks for reduced motion
  (followed live). A video shows its poster, the overlay is removed, and an HTML backdrop is told
  `reducedMotion` and then frozen.
- **Paused:** the window is hidden (minimized, `hide()`, another Space), or Durango Code has not been
  the focused app for 12 s, unless "Keep animating in the background" is on (off by default). A
  video freezes on its current frame; scenes freeze. Focus is the window's own (`app:windowFocus`
  from main), so a built-in browser tab taking focus still counts as using the app.
  - Measured in Electron 42.5: Chromium already stops a backdrop video when the window is
    minimized, hidden or on another Space. It kept playing when the window was fully covered by
    another window, which macOS did not reliably report as hidden, and when the app was simply
    unfocused. The other app has focus in both cases, so the 12 s rule covers them.
- **Freezing a scene** is enforced by the frame's bootstrap, not left to the scene's code
  (`THEME_SCENE_BOOTSTRAP` in `ui-themes.js`). One second after `state.paused`, so a
  reduced-motion still frame can draw first:
  - animation frame callbacks are held (one runs per resize, so a resized canvas redraws);
  - CSS animations pause (`html.durango-paused`);
  - playing `<video>`s pause.
- **Posters:** a video backdrop without a poster gets one. About 1.5 s after it shows, the renderer
  takes the frame at 0.1 s and saves it as `poster-*.jpg` (`videoPoster.ts`, `themes:videoForPoster`
  / `themes:savePoster`; videos up to 60 MB; not an undo step). The bytes come over IPC as a
  same-origin blob, because a canvas cannot export frames from `orion-attachment:` media. "Still"
  then shows an image instead of a paused video holding a decoder.
- **Video size:** `set_app_theme` (`video_path`) and `generate_theme_media` (video) tell the agent
  when a video is larger than 1920×1080 or faster than 30 fps (`src/main/video-probe.js` reads
  MP4/MOV boxes; no decoder). A backdrop decodes every frame for as long as it plays. Generated
  videos use the API's default resolution, 720p.

## Safety

- Tokens accept colors, gradients, lengths and font lists only (no `url()`, no `;{}<>`, no escapes).
- Theme CSS is cleaned before it is applied:
  - CSS escapes and comments are removed first, because they can spell any function name.
  - `@import`, `@font-face` and `@namespace` are dropped.
  - `image-set`, `cross-fade`, `element` and `src` are disabled.
  - Every `url()` that is not an inline `data:image/` URI is disabled, including raw `orion-attachment:` URLs.
  - A theme's own files are reached only through `theme-asset("name")`, which is resolved after this cleaning.
- Nothing a theme sets loads from the network.
- Store changes (edit, save, undo, rename, delete, switch) run one at a time, so overlapping Undo and agent edits stay consistent.
- HTML scenes run in `sandbox="allow-scripts"` frames (opaque origin) with a CSP that blocks all
  network, sockets and workers; the main window refuses any navigation of an `about:srcdoc` frame
  (`guardVisualFrames`). Scenes only receive messages (`working`, `turn-start`, `turn-end`, `pointer`,
  `focus`, `typing`, `celebrate`, `value`, `action`) and send back only checked messages: script errors
  (shown to the agent), `set` (a declared value, checked against its declaration), `action` (a name) and,
  for widgets, `resize` (clamped).
- Control placement uses `querySelectorAll` only; a selector with braces or angle brackets is dropped, so it
  can never become a CSS rule. Control icons are Lucide names or inline SVG rebuilt from an allowlist of
  shapes and geometry attributes (no scripts, links, styles or `url()`).
- Stock is always reachable: Settings → Themes, the transcript card, the macOS app menu, and
  **Cmd/Ctrl+Alt+Shift+0** (handled in the main process, so theme CSS cannot hide it).
- `generate_theme_media` spends Durango credits: refused in Read only mode. It uses the desktop's
  `code`-scoped Durango key on `/api/v1/images/generations` and `/api/v1/videos/generations`.

## Tests

`bun run test:ui-themes` (format, built-ins, store, tools) and `bun run test:durango-tools` (Claude and
bridge schemas stay in step).
