# Themes (Settings → Themes)

Users restyle Durango Code by asking an agent in an ordinary thread ("make it a synthwave sunset",
"generate a misty forest wallpaper"). The agent calls the theme tools on the built-in `orion` MCP
server and the app changes live. Each thread shapes one working theme; it stays unsaved until the
user turns **Save** on in the theme card the tool leaves in the transcript (or the agent passes
`save: true` when asked). Saved themes, six prebuilt ones and **Stock** (the original look, no
theme at all) are switched in Settings → Themes.

## Pieces

| File | Role |
|---|---|
| `src/ui-themes.js` | The format, shared by main and renderer: `THEME_TOKENS` (CSS custom properties a theme may set, with stock values equal to `src/index.css` `:root`), `sanitizeTheme`, `mergeTheme`, `themeToCss`, HTML scene documents (`buildSceneDocument`, CSP + `window.durango` bootstrap). |
| `src/ui-themes-builtin.js` | The prebuilt themes (animated HTML scenes, no files). |
| `src/main/ui-themes-store.js` | Storage under `<userData>/themes/` (`state.json` = active id and each theme's current values, `<id>/theme.json`, `<id>/history.json` for Undo, `<id>/<asset>` backdrop files). Broadcasts `themes:changed`. Unsaved themes nobody uses are pruned after 14 days. |
| `src/main/theme-tools.js` | `get_app_theme`, `set_app_theme`, `generate_theme_media` (one schema source: Claude registers them in `claude-driver.js`, the bridge lists them through `__tools`). |
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
