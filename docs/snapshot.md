# SnapShot (macOS)

SnapShot attaches the window you are working in to the current draft. Press both Shift keys
together (or a key chord you pick) in any app: Durango Code captures that app's front window,
comes forward, and adds the capture to the selected thread's composer. If no thread is open it
starts one in the selected project. Captures join the draft even while the thread is running.

Off by default. Settings → Computer Use → SnapShot. The tab is hidden behind a notice on other
platforms.

## What a capture contains

Two files in `<userData>/attachments/snapshots/<id>/`:

- `<App> - <title>.png`: the window image (`screencapture -l <windowId> -o -x`), long edge capped
  at 1920 px, re-encoded as JPEG if the PNG is over 3.5 MB.
- `<App> - <title>.snapshot.md` (when **Include app text** is on): the window's accessibility
  tree as an indented outline, at most 200 KB:

  ```
  SnapShot of Safari - "PR #12" (com.apple.Safari), image 1920x1200 px; bounds are image pixels.

  - button "Back" [8,8,45,45]
  - text-field "Address and search bar" = "example.com/pr/12" [133,15,933,32] (focused)
  ```

  Layout-only containers (groups, scroll areas, web areas repeating the window title), scroll bars,
  and text repeating its control's label are left out. Bounds are pixels in the attached image, so
  an agent can point at elements in it. If the app is slow the outline is partial (it says so) and
  if it fails the capture is image-only.

Both attachments carry `FileAttachment.snapshot` (`kind: 'image' | 'accessibility'`, app name,
window title, bundle id). Claude and Codex receive the outline inline (first 16k characters) as an
extra text block framed as untrusted data the model must not take instructions from; every provider
also gets the file paths, labelled as SnapShot files, in the prompt (`buildPromptWithAttachments`).

Every app's window is read the same way, password managers included: the user picked the window by
pressing the shortcut on it. Turn off **Include app text** for image-only captures.

## How it works

- `native/snapshot-helper/main.swift`: a small helper, built universal (arm64 + x86_64) by
  `scripts/build-snapshot-helper.mjs` into `native/snapshot-helper/build/` (gitignored).
  Packaging builds it in Forge's `prePackage` hook and ships it as an extra resource; in development
  the app builds it on first use when `swiftc` is installed (otherwise Settings says it is
  unavailable). Commands print JSON:
  - `watch-modifiers --pair shift --parent-pid <pid>` polls `CGEventSourceFlagsState` every 50 ms
    for the left and right Shift device bits and prints a line on each press of both: only on the
    transition into both-down, with no other modifier held at that moment. Releasing or adding
    Cmd/Ctrl/Opt while both are held never fires; one Shift has to go up first
    (`modifierTriggerStep`, tested through the helper's `trigger-steps` hook). No event tap is
    installed. It exits when the app does.
  - `windows` lists on-screen windows front to back with the active app's pid.
    `selectSnapShotWindow` (`src/main/snapshot-format.js`) picks the front-most ordinary window not
    owned by Durango Code, preferring the active app's.
  - `ax --pid … --window-bounds … --deadline-ms 2300` reads the matching AX window (by bounds, then
    title, then the focused window) with batched attribute reads, 2000 nodes / depth 40, and returns
    frames in screen points; the app converts them to image pixels. Every AX read (the system-wide
    default, the app, each window and node) gets a messaging timeout of at most 0.75 s, cut to the
    time left before the deadline, so a stalled node costs only the remaining budget and the nodes
    read so far come back marked `truncated`; a watchdog prints them 250 ms after the deadline if
    a call hangs anyway (the app kills the helper at 3 s). It sets `AXManualAccessibility`
    on the target app so Chromium/Electron apps expose their tree.
- `src/main/snapshot.js`: settings (mirrored to `<userData>/snapshot.json` so the trigger is armed
  at launch, before the renderer loads), the trigger (the watcher; a `globalShortcut` accelerator
  when the user picks a key chord, or as a fallback when the watcher can't run), the capture, and a
  pending queue. The renderer collects captures with `snapshot:takePending` on mount and on each
  `snapshot:available`, so a capture taken with no window open is attached when one opens.
- Renderer: `appendComposerAttachments` in `App.tsx` (shared with file attachments),
  `src/app/SnapShotSettings.tsx` (settings panel, composer badge, opening the outline in the Code
  tab).

## Permissions

Screen Recording is required (without it macOS hides other apps' window contents; SnapShot refuses
to capture). Accessibility is needed only for app text. Both are requested through the existing
Computer Use permission flow; macOS attributes the helper to Durango Code. A new Screen Recording
grant applies after a relaunch.

## Tests

```bash
bun run test:snapshot          # outline, coordinates, window selection, settings, Shift trigger edges
bun run test:codex-driver      # Codex outline inlining
bun run build:snapshot-helper  # universal helper
```
