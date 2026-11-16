# Agents using Durango Code itself (app tools)

Agents can use the Durango Code window the way the user does: see what is on screen, then click,
type, press keys and scroll. This is for requests about the app itself ("turn the snow off", "open
Settings → Themes", "switch this thread to Opus"), next to the theme tools that restyle it. Websites
and the user's project use the browser tools instead.

| Tool | What it does |
|---|---|
| `app_snapshot` | Every visible button, link, field, tab, menu item, switch and theme control, grouped by area (title bar, sidebar, thread, prompt box, settings, dialogs, menus), each with a ref (`e12`), role, name, state (pressed, checked, selected, expanded, disabled, focused, field value) and box. `filter` narrows it; `screenshot: true` adds a picture. |
| `app_click` | Clicks a ref (scrolled into view first) or x/y. `double`, `button: "right"`. |
| `app_type` | Clicks a field ref to focus it (or types where focus is), `clear` empties it first, `submit` presses Enter. |
| `app_press` | A key or shortcut: `Escape`, `ArrowDown`, `Meta+K`, `CmdOrCtrl+,`. |
| `app_scroll` | Wheel scroll over a ref or x/y. |

## How it works

`src/main/app-tools.js` holds the schemas, descriptions and the code. Claude runs register the tools in
`claude-driver.js` (`claudeAppTools`), and other providers get them through the bridge's `__tools`
(`mcp-bridge.js`). Both convert the JSON Schemas to zod with `src/main/json-schema-zod.js`.

- **Snapshot** runs a script in the window (`executeJavaScript`). It lists interactive elements, plus
  outermost `cursor: pointer` elements for React `onClick` divs, and skips anything hidden, inert or
  `aria-hidden`. A pointer-cursor guess inside a listed element is folded into it, but real controls inside
  a row (a rename field, a menu button) keep their own refs. Each listed element is stored under its ref in `window.__durangoAppRefs` (as `WeakRef`s).
  The next snapshot replaces the refs, and a ref whose element has left the DOM fails with a clear
  message. A sandboxed theme widget (`iframe.theme-control-widget`) is one entry, named after its title
  and tagged with its control id.
- **Input** is real input. Mouse and keys go through the DevTools protocol's `Input` domain
  (`webContents.debugger`, attached for one action and then detached, one action at a time per window).
  It is routed like real input, so it reaches out-of-process frames: the sandboxed theme widgets.
  `webContents.sendInputEvent` only reaches the main frame, so it is used only in two cases:
  - Command shortcuts on macOS, which the protocol never delivers to the page.
  - The wheel, because protocol wheel events wait for a frame that a covered window may never draw.
- Every protocol command times out after 5 s, so a minimized window fails the tool instead of hanging it.
- A hidden window (minimized, or never shown) gets no real mouse input. While the page is
  `visibilityState: hidden`, a click goes to the element itself instead: focus, then the pointer, mouse and
  click events a click makes. A theme widget's own frame can't be clicked that way, so the tool says so.
  Typing and keys still reach a hidden window.
- `clear` uses the `selectAll` editing command, so it works in whichever frame has focus. The tool then
  checks that a main-frame field really is empty, and fails without typing if it is not.
- The window is not focused or brought to the front.

## Approval

`app_snapshot` only reads, so it is approved in every mode. Clicking, typing, keys and scrolling act as
the user does: they can change settings or answer the app's own prompts.

- Claude: Full access approves the actions and Workspace write asks for each one
  (`orionAppToolNamesForAccessMode` in `thread-reader-routing.js`).
- Bridge providers: these can't be relied on to ask, because Codex approves every `orion` tool. So the
  actions are listed only in Full access (`appBridgeToolDefinitions`), and `runAppTool` refuses them below
  it (`requireFullAccess`), as the machine tools do.
- Read only refuses the actions in the tool and does not list them.

Refs keep counting across snapshots (`window.__durangoAppRefSeq`). A ref from an older snapshot fails
instead of naming a different element.

## Tests

`bun run test:app-tools` drives a real Electron window. It checks:

- The snapshot's areas, refs and states.
- Clicks on a button, a clickable row and a sandboxed widget iframe.
- Typing with clear and submit.
- `Escape` and `CmdOrCtrl+K`.
- Scrolling, stale and invalid refs, and the Read only refusal.

`bun run test:durango-tools` keeps Claude's registration and the bridge listing in step.
