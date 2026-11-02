# Built-in browser

Durango Code has its own browser (globe button in the title bar): a small
preview in the bottom-right corner of the chat that opens into a modal with the
live page, tabs and address bar when clicked. Its tabs agents drive through the `browser_*` tools of Durango
Code's `orion` MCP server. Every provider gets the same tools; the user can
watch, take over and hand back.

## Pieces

| File | Role |
|---|---|
| `src/main/browser/manager.js` | Tab registry. Each tab is a `WebContentsView` owned by the main process (tabs survive the panel closing and renderer reloads), with an owner, a controller, one action queue and its snapshot refs. Lays the visible tab over the expanded panel's placeholder (the corner preview is a `thumbnail` capture, since a native view would swallow its clicks); every other tab stays attached but hidden at its last size (1280×800 if never shown). Emits `browser:state`. |
| `src/main/browser/cdp.js` | `webContents.debugger` wrapper: attach on demand, per-command timeouts, main-frame navigation tracking (and JavaScript dialog tracking when `guest-dialogs.js` is unavailable). |
| `src/main/browser/guest-dialogs.js` | The only use of a private Electron hook: keeps a tab's alert/confirm out of native UI (see Rules). |
| `src/main/browser/snapshot.js` | Pure: accessibility tree (`Accessibility.getFullAXTree`, plus same-process child frames) → the text outline with `[ref=eN]`. |
| `src/main/browser/actions.js` | click / type / press / select / evaluate / wait_for / dialog / resize / screenshot / navigation waits. |
| `src/main/browser/policy.js` | Pure: URL policy, ownership rules, tab limits, ref generations. |
| `src/main/browser/security.js` | Partition `persist:durango-browser`, sandboxed guest preferences, permission denial, downloads, `will-frame-navigate` / popup handling. |
| `src/main/browser-tools.js` | The one source of the tools' names, descriptions and JSON schemas; `runBrowserTool`; `browserModeFor`; the agent tips. |
| `src/app/BrowserPanel.tsx`, `src/app/useBrowserTabs.ts`, `src/app/BrowserSettings.tsx` | Panel, tab state hook, settings rows. |

## Routing

- **Claude** (in-process SDK server, `createOrionMcpServer` in
  `claude-driver.js`): zod schemas are generated from `BROWSER_TOOLS`. A
  `PreToolUse` hook stamps a Task subagent's `agent_id` into `_agent` so the
  subagent gets its own tabs (`thread:agent` owner).
- **Every other provider** (bridge shim `src/mcp-bridge-shim.cjs`): the shim's
  `tools/list` asks the app for run-specific tools (`{tool: '__tools'}`), so the
  schemas are not copied into the dependency-free shim. Bridge replies are
  `{id, ok, text, content?}`; the shim returns `content` (MCP blocks, e.g.
  screenshots as `{type:'image', data, mimeType}`) when present, else one text
  block.

Browser modes come from `browserModeFor`: `builtin`, `chrome` (Claude in
Chrome), `external` (Codex's ChatGPT Chrome extension, or chrome-devtools-mcp
attached to the user's Chrome) or `off`. **Every mode but `off` lists the
browser_* tools** (`hasBuiltinBrowser`); `chrome` and `external` add the user's
signed-in Chrome on top. Settings: Claude `providerOptions.browser` (`chrome`
= your Chrome + built-in, `builtin` = built-in only, `off`; legacy
`chrome: true` → `chrome`); Codex `browserUseMode` (`extension` / `mcp` = your
Chrome + built-in, `builtin`, `disabled`); everyone else
`providerOptions.browser` (`builtin` | `off`). Read only drops the signed-in
Chrome and lists only `browser_status` and `browser_snapshot`.

### Signed-in Chrome first for logins

The user's logins live in their Chrome, never in the built-in browser
(`persist:durango-browser` starts empty). So:

- The prompt routes by task: `builtinBrowserTips(signedInBrowser)` for Claude
  and `codexBrowserEnvironmentNote` for Codex say anything behind a login
  (dashboards, account settings, email) goes to the user's Chrome, and the
  built-in browser is for local dev servers, previews and public pages. Without
  a signed-in Chrome they say to hand the step to the user
  (`request_user_action`) instead of asking them to sign in to the built-in
  browser.
- `browser_open`, `browser_navigate` and `browser_snapshot` append a hint when
  the page looks like a sign-in page (`looksLikeSignIn`: an auth-looking host
  or path, or a password textbox in the snapshot), naming the session's Chrome
  tools (`signInHint`).
- Codex's extension probe is advisory (it reports "not ready" for setups that
  connect at run time), so an unverified extension stays selected when the run
  has the built-in browser; the separate-profile chrome-devtools fallback is
  only used for runs without Durango Code's bridge.

## Rules

- Owners: a thread id, `thread:agent` (Claude Task subagent), or `user`.
  Mutating tools need ownership; status and snapshots work on any tab of the
  caller's thread family (driver thread + spawned subagent threads; the
  renderer sends child → parent links). User tabs need **Let agent use**.
- **Take over** sets the controller to `user`; agent actions then fail with
  "The user is controlling tab tN; wait or ask them." Real keyboard or mouse
  input in a page delays agent actions for 750 ms. Access is checked again
  after every wait in `runOnTab` and right before an action sends input
  (`tab.markAgentInput`), so an action that was queued or waiting when the
  user took over fails the same way instead of running.
- If the user takes over after an agent's mouse press but before its
  release, the button is let go outside the page (`cancelPress`): the pointer
  first moves to `CANCEL_RELEASE_POINT` as a plain hover (no `button` /
  `buttons`), which on Electron 42 drops pointer capture the page took in
  `pointerdown` (`setPointerCapture`; a move reporting the pressed button
  keeps it, and the release would then still click the captured element),
  then the button is released there. The pressed element is not clicked
  (Chromium sends the `mouseup`/`click` to `<html>`, as when a person drags
  off a button), and the click fails with the same "The user is controlling
  tab tN" error.
- A pending JavaScript dialog blocks every action but `browser_dialog`
  (the panel can answer it too). A click that opens one returns as soon as the
  dialog shows (Chromium only acknowledges the input once it is answered).
  When the dialog came from the press (a `mousedown` handler), the press is
  held (`tab.pendingPress`) and released once the dialog is answered, or
  before the tab's next agent action (`settlePendingPress`): on the element,
  completing the click, while the agent still controls the tab; outside the
  page without a click (as above) when the user took over or the page
  navigated meanwhile. Either way the page gets its `mouseup`, so drag state
  kept from `mousedown` ends.
- Frames in different renderer processes (cross-site iframes) can have a
  dialog open at once. They wait in a FIFO queue (`guest-dialogs.js`):
  `tab.dialog` is the first, answering it settles that frame only and shows
  the next (`browser_dialog`'s reply says so), and each dialog has an `id` so
  the panel's answer goes to the dialog it showed. A main-frame navigation
  starting (the URL field, back/forward, reload), a crash and closing the tab
  settle every held dialog with `false`, so no renderer stays blocked.
  Chromium itself cancels dialogs only when a navigation commits, which never
  happens while the page's renderer waits on one.
- JavaScript dialogs never open native UI. Electron 42 has no public API for
  this: its default handler is an internal `-run-dialog` listener on every
  WebContents (`lib/browser/api/web-contents.ts`) that calls
  `dialog.showMessageBox` on the window holding the tab. That sheet shows the
  window, takes key focus (so stray keystrokes answer the page) and stays up
  after the page was answered through CDP. `guest-dialogs.js` replaces that
  listener on built-in browser tabs only (feature-detected: exactly one
  listener, Electron's, which calls `showMessageBox`). It holds Chromium's
  dialog callbacks (queued, see above), so `alert`/`confirm` still block the
  page until the panel or `browser_dialog` answers, and reports the dialog
  shown to the manager; `-cancel-dialogs` (navigation commit, crash) and a
  main-frame navigation starting settle them. `disableDialogs` is not
  used: it would make `confirm()` return `false` at once. If the hook is not
  found the tab falls back to Electron's native dialog, tracked through CDP and
  still answerable from the panel or `browser_dialog`. After an Electron
  upgrade, `test:builtin-browser` fails if the hook is missing or a native
  dialog opens. `prompt()` throws "prompt() is not supported" in Electron's
  renderer before it reaches the browser process.
- Refs keep counting across snapshots of a tab, so a ref from an older
  snapshot or from before a navigation fails with a clear "stale" error
  instead of hitting another element.
- URLs: http(s) and `about:blank` always. In Full access (and on the user's own
  tabs) also `file:` anywhere, top-level `data:` and `javascript:`; otherwise
  `file:` only inside the thread's project and no top-level `data:` /
  `javascript:`. `chrome:`, `devtools:` and other apps' schemes are never
  opened.
- Popups (`window.open`, `target=_blank` links and forms) that pass the URL
  policy are created by Electron (`setWindowOpenHandler` → `createWindow`) and
  adopted as tabs of the opener's owner, so `window.opener`, `postMessage` and
  a form's POST body survive (popup sign-in flows work); `window.close()` in a
  popup closes its tab. Closing the opener leaves the popup open.
- Downloads: with **Ask before downloading files** (Settings → Browser use, on
  by default) a download is held in `<userData>/browser-downloads/.pending` and
  the panel opens with Save / Cancel; Save moves it to
  `<userData>/browser-downloads`, Cancel deletes it. With the setting off it
  saves there directly. A download reserves its file name until it is saved
  or dropped, so two held downloads of `report.txt` get `report.txt` and
  `report (1).txt`, and Save never replaces a file (it takes the next free
  name if one appeared meanwhile). The session's download callbacks are set
  apart from its one-time setup (`setBrowserDownloadHandlers`), so Clear
  browsing data before the first tab does not turn the question off. Downloads are never opened. `browser_status` and the
  result of the action that started it tell the agent what happened.
- Limits: 6 tabs per owner, 20 in all. A deleted thread's tabs close.

## Tests

`bun run test:builtin-browser` (Electron): policy, ownership, refs, snapshot
format, settings migration, the Claude/shim tool sync, and an end-to-end run
of every tool against real tabs in a hidden window, directly and through the
bridge shim (including held downloads after Clear browsing data, two tabs
downloading the same name, Take over while an action waits or between a
click's press and release (with and without `setPointerCapture`), a
`mousedown` that opens an alert (the release follows the answer, completing
the click or, after Take over, letting go outside the page), confirm/alert
answered from `browser_dialog` and the panel with no native dialog, two
cross-process frames confirming at once (answered in order, each gets its own
answer; navigating away settles both) (a control view without the hook shows that
the native-dialog counter works), and a popup that posts back to its opener
and closes plus a `target=_blank` form POST).
