# Themes (Settings → Customizations)

Users restyle Durango Code by asking an agent in an ordinary thread ("make it a synthwave sunset",
"generate a misty forest wallpaper"). The agent calls the theme tools on the built-in `orion` MCP
server and the app changes live. Each thread shapes one working theme; it stays unsaved until the
user turns **Save** on in the theme card the tool leaves in the transcript (or the agent passes
`save: true` when asked). Saved themes, six prebuilt ones and **Stock** (the original look, no
theme at all) are switched in Settings → Customizations.

## Pieces

| File | Role |
|---|---|
| `src/ui-themes.js` | The format, shared by main and renderer: `THEME_TOKENS` (CSS custom properties a theme may set, with stock values equal to `src/index.css` `:root`), `sanitizeTheme`, `mergeTheme`, `themeToCss`, HTML scene documents (`buildSceneDocument`, CSP + `window.durango` bootstrap). |
| `src/ui-themes-builtin.js` | The prebuilt themes (animated HTML scenes, no files). |
| `src/main/ui-themes-store.js` | Storage under `<userData>/themes/` (`state.json` = active id, `<id>/theme.json`, `<id>/history.json` for Undo, `<id>/<asset>` backdrop files). Broadcasts `themes:changed`. Unsaved themes nobody uses are pruned after 14 days. |
| `src/main/theme-tools.js` | `get_app_theme`, `set_app_theme`, `generate_theme_media` (one schema source: Claude registers them in `claude-driver.js`, the bridge lists them through `__tools`). |
| `src/app/themes/ThemeLayer.tsx` | Applies the active theme: a `<style>` (textContent only), the backdrop behind the app (`z-index: -1` in `body`), an overlay scene above it (pointer events off), and agent activity → scene events. |
| `src/app/themes/ThemeCard.tsx` | The transcript card: preview, Save toggle, Use, Undo, Back to stock. |
| `src/app/themes/CustomizationsSettings.tsx` | Settings tab: "Customize with an agent", gallery, effects toggle, celebration preview. |

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
  `focus`, `typing`, `celebrate`) and report script errors back (shown to the agent).
- Stock is always reachable: Settings → Customizations, the transcript card, the macOS app menu, and
  **Cmd/Ctrl+Alt+Shift+0** (handled in the main process, so theme CSS cannot hide it).
- `generate_theme_media` spends Durango credits: refused in Read only mode. It uses the desktop's
  `code`-scoped Durango key on `/api/v1/images/generations` and `/api/v1/videos/generations`.

## Tests

`bun run test:ui-themes` (format, built-ins, store, tools) and `bun run test:durango-tools` (Claude and
bridge schemas stay in step).
