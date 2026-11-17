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
| `src/main/theme-tools.js` | `get_app_theme`, `set_app_theme`, `manage_app_themes`, `generate_theme_media` (one schema source: Claude registers them in `claude-driver.js`, converted to zod by `src/main/json-schema-zod.js`, which keeps value declarations, `set_values` and `variant_when` as objects and mixed scalars; the bridge lists them through `__tools`). Agents press a theme's controls like any other part of the app with the app tools ([app-control.md](app-control.md)). |
| `src/app/themes/ThemeLayer.tsx` | Applies the active theme: a `<style>` (textContent only), the backdrop behind the app (`z-index: -1` in `body`), an overlay scene above it (pointer events off), and agent activity → scene events. |
| `src/app/themes/ThemeControls.tsx` | The theme's own controls (lazy-loaded): places a host for each control in a slot, next to or inside a selector's element, or floating; re-places them as the app re-renders; draws toggle / choice / slider / menu / button, or the theme's HTML widget. |
| `src/app/themes/ThemeControlsSettings.tsx` | Settings → Themes → "<theme> controls": the active theme's values as plain settings (switch, segmented, slider), where each control sits, Run for action buttons, Reset to defaults. |
| `src/app/themes/ThemeSlot.tsx` | Empty named spots the app renders for controls (`THEME_SLOTS`: title bar, sidebar, prompt box, split-pane header). |
| `src/app/themes/ThemeSceneFrame.tsx` | One sandboxed scene frame (backdrop, overlay or widget): app events in; `durango.set` / `action` / `resize` out. |
| `src/app/themes/ThemeCard.tsx` | The transcript card: preview, Save toggle, Use, Undo, Back to stock. |
| `src/app/themes/CustomizationsSettings.tsx` | Settings tab: "Customize with an agent", gallery, effects toggle, celebration preview. |
| `src/main/theme-community.js` | Community themes: share a theme to durango.sh, install one (see "Sharing"). |
| `src/t3-theme-format.js`, `src/t3-themes.js`, `src/main/theme-t3.js` | T3 Code themes in and out (see "T3 Code themes"). |
| `src/app/themes/CommunityThemes.tsx` | The Share dialog (theme ⋯ menu), the install dialog, and Settings → Themes → Community. |

## Sharing (community themes)

People share themes on **durango.sh/code/themes**. The gallery, the theme pages and the shared files
live on durango.sh, so the app only gains an upload and a download path.

- **Share** (a theme's ⋯ menu → Share…, or `manage_app_themes` `share`). `theme-community.js`:
  - hashes every file the theme uses (backdrop, poster, variants, `theme-asset()` in its CSS);
  - asks durango.sh which files it lacks (`POST /api/v1/themes/uploads`);
  - PUTs those straight to storage with presigned URLs that sign the exact size and type;
  - publishes the theme without its local fields (`POST /api/v1/themes`). The fields left out are
    `id`, `threadId`, `saved`, `revision`, the dates, `published` and `origin`.

  It also uploads a ~960px JPEG of the backdrop (`community-thumbnail.jpg`, made with `nativeImage`)
  for the gallery. The theme remembers `published: { slug, version, listed, revision }`. Sharing it
  again updates the same link and bumps the version. The dialog offers Update when the theme's
  revision moved past the shared one. Themes are link-only unless "List in the community gallery"
  is on. Stop sharing deletes the shared copy; installed copies stay with the people who have them.
  Sharing needs no account. Signed in, the theme belongs to the Durango account (the desktop's
  `code`-scoped key); signed out, to this device: a random owner key made on first use
  (`<userData>/community-theme-owner.key`) and sent as `X-Durango-Theme-Owner`, which durango.sh stores
  only as a hash. `published.anonymous` remembers which, so updates and Stop sharing keep using the
  owner the theme was shared as, even after signing in. Anonymous sharing is rate limited per network
  address. Sharing is refused in Read only mode.
- **Install.** A theme page's Install button opens `orion://theme/install?slug=<slug>`. `main.js`
  keeps the link until the renderer takes it, and the install dialog asks first. Pasting a link in
  Settings → Themes → Community, or `manage_app_themes` `install`, works too. The app:
  - reads `GET /api/v1/themes/<slug>` (public, so no sign-in is needed);
  - downloads each file the theme uses and checks its size and sha256;
  - adds the theme through the store as a saved theme with `origin: { slug, version, author, name }`,
    sanitized like any theme, and applies it.

  A copy of the same version already on this computer is applied instead of installed twice.
  Installs are counted once per signed-in account.
- **Remix.** An installed theme is a normal saved theme, and agents change it like any other.
  Sharing it sends `remixedFrom` with the original's slug, and the new theme page links back to it.
- **Limits:** 25 MB per file, 60 MB per theme, 24 files, and a 512 KB theme object.
- **Web previews.** durango.sh never applies a shared theme's CSS. Its pages draw a sketch of the
  app with the theme's colors (only plain color and gradient values pass) over its thumbnail, video
  or HTML scene. Scenes run in `sandbox="allow-scripts"` frames with the same no-network CSP as the
  app: always on a theme page, and on hover in the gallery.
- **Moderation.** Signed-in viewers can report a theme. Admins can hide a theme from its page, which
  removes it from the gallery and its link.

## T3 Code themes

[T3 Code](https://github.com/pingdotgg/t3code) themes work in Durango Code, and ours work in T3 Code. A T3
Code theme is JSON: a name, an appearance, colors for its 61 roles (or only a `canvas` and an `accent`),
optional light/dark `variants`, and up to 50,000 characters of CSS. That CSS is written against T3 Code's
stable hooks (`[data-slot="sidebar"]`, `[data-user-message-bubble]`, …, `THEME_CSS_HOOKS` in its
`packages/shared/src/themeCss.ts`) and its variables (`--app-theme-<role>`, and shadcn ones such as
`--background` and `--accent`). It can use `:has()`, `@keyframes` and `data:` pictures, but no scripts.
`src/t3-theme-format.js` holds T3 Code's roles, variable names, stock palettes and aliases (copied from
its source, MIT).

- **Import** (Settings → Themes → Community → Import file…, a `.json` link in "Install from a link",
  or `manage_app_themes import_t3`). `t3ThemeToDurango`:
  - maps the roles onto our tokens and keeps all of them as `compat.t3.colors`;
  - while the theme is on, `themeToCss` defines every `--app-theme-*` (for roles we have, our token
    with the theme's color as fallback, so later edits follow) and T3 Code's aliases as `--t3-*`;
  - rewrites the CSS:
    - each T3 hook becomes `:is(<our element>, [data-t3-hook="…"])`; the marker never matches and
      lets export restore the exact hook, and hooks with no counterpart only keep the marker;
    - `.dark` follows the theme's appearance;
    - T3's shadcn variable names get the `--t3-` prefix, because ours share names (`--accent`,
      `--warning`).
  - Selectors that only exist in T3 Code stay and never match.
  - Strings, `url()` and comments are never rewritten.
  - CSS that would exceed a theme's 160,000 characters once mapped is refused, not cut off.
  - A file's light/dark `variants` are kept in `compat.t3.variants`. The install dialog (or
    `import_t3 appearance`) can import the other appearance; export writes the other one back as a
    variant.
- **Export** (a theme's ⋯ menu → Export for T3 Code…, `manage_app_themes export_t3`, and every share,
  which durango.sh offers as "Download for T3 Code"). `durangoThemeToT3`:
  - fills every role from our tokens. An imported theme keeps its own colors unless the token they
    follow changed, so import → export gives back the same file.
  - rewrites the CSS:
    - our classes become T3's hooks;
    - our variables become `--dc-*`, defined at the top from the theme's values or the matching T3
      role;
    - the theme's controls take their defaults (`[data-tv-x="default"]` always matches, other values
      never);
    - `theme-asset()` becomes `none`.
  - embeds the backdrop picture as a JPEG `data:` URL (`nativeImage`, the largest that fits; it's
    left out if it can't fit).
  - Scenes, video and controls stay in Durango Code; the export says so.
  - Never overwrites a file that isn't a T3 theme unless the user chose it in the save dialog.
  - Not available in Read only mode.
  - The file is named after its id (`dc-<name>.json`) because `t3 theme set <file>` takes the id
    from the file name. It passes T3 Code's checks: version 1, id pattern, name ≤ 48, literal colors,
    CSS ≤ 50,000 and T3's no-remote-files check.
- **Checked against T3 Code itself** (nightly 0.1.10-nightly.20261116):
  - `t3 theme set` accepted an exported Snowfall Pines and showed its colors and wallpaper;
  - a T3 theme file round-trips with identical colors and CSS (`bun run test:t3-themes`).

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

`bun run test:ui-themes` (format, built-ins, store, tools), `bun run test:theme-community` (share and install against a fake durango.sh) and `bun run test:durango-tools` (Claude and
bridge schemas stay in step).
