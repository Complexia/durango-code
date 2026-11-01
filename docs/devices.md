# Simulator tools (devices)

Agents on every provider can list, open, screenshot and close iOS Simulators
and Android Emulators on the user's machine and drive apps on them with
[agent-device](https://github.com/callstack/agent-device). It is opt-in and
off by default. This document covers what ships today (phase 1) and the plan
for live streaming and input (phase 2).

## Phase 1: what ships

### Consent

`userData/devices.json` holds two switches, both off by default
(`src/main/devices/device-settings.js`, Settings → Devices):

- **Use devices.** The user can list, boot, screenshot and shut down devices
  from Durango Code, and the thread device card shows.
- **Agents can use devices.** Agents get the `device_*` tools and the
  agent-device CLI. Needs "Use devices": turning that off also clears this one,
  so turning devices back on never re-grants agent access silently.

Every agent-facing call re-reads the file, so turning a switch off refuses a
running agent's next device call. That includes every invocation of an
agent-device launcher an agent already holds: the launcher reads
`devices.json` itself and refuses (exit 2, fails closed on a missing or
unreadable file) unless both switches are still on. Whether the tools are *listed* is decided
when a run starts (the bridge shim's `--devices` flag, Claude's in-process
server); a run started before the switch was turned on gets the tools on its
next session.

### Tools

`src/main/device-tools.js`, served by Durango Code's own `orion` MCP server:
in-process for Claude (`createOrionMcpServer` in `claude-driver.js`), the stdio
bridge shim for every other provider (`mcp-bridge-shim.cjs` →
`mcp-bridge.js`). `scripts/test-durango-tools.mjs` keeps the two copies of the
descriptions and schemas in sync.

| Tool | Does |
|---|---|
| `device_list {platform?}` | Devices (`id, name, platform, version, state`, open in this thread?) and per-platform availability with reasons. |
| `device_open {deviceId?, platform?}` | Picks a device (booted first, else an iPhone), installs agent-device if needed, boots it, writes the launcher, returns the quick start and `{deviceId, command, session}`. |
| `device_screenshot {deviceId?}` | MCP image block (long edge ≤ 1568 px) plus the path of the full-size PNG; also updates the card. |
| `device_close {deviceId?, shutdown?}` | Ends the agent-device session, removes the launcher, optionally shuts the device down (not if another thread still has it open). |

Pre-approval (`thread-reader-routing.js`): list and screenshot in every access
mode; open and close outside Read only.

**Access mode.** Some providers approve every `orion` tool regardless of the
list above (Codex), so the handler enforces it too: both paths pass the run's
access mode into `runDeviceTool` (Claude's in-process server from its session,
the bridge from `mcpBridgeSessions`). In Read only, `device_list` and
`device_screenshot` of a running device work; `device_open` and
`device_close` are refused with a message that says why, so nothing is booted,
closed or shut down and no launcher is handed out.

**Concurrency and ownership.** Open, close and shutdown of one device run one
at a time (a per-device promise chain), and every registry record has a
generation: a close that captured a record which was closed (and maybe
reopened) while it waited does nothing and emits no `closed` event. A device
is open in at most one thread, since agent-device drives a device from one
session at a time: `device_open` of a device another thread has open returns
a refusal naming that thread and suggesting a free device; without a
`deviceId` it picks this thread's open device, else an unused one.
`device_list` marks devices open in another thread.

**Bridge content passthrough.** A bridge reply is `{id, ok, text, content?}`;
`content` is MCP content blocks such as `{type: 'image', data, mimeType}`. The
shim returns `content` when present, else `[{type: 'text', text}]`. Claude's
side uses `durangoToolContentResult`, the image-capable sibling of
`durangoToolResult`.

### agent-device

- **Install** (`devices/device-toolchain.js`): pinned in
  `devices/device-tool-versions.json`; installed into
  `userData/devices/tools/<name>/<version>` through a staging directory,
  verified by its package `bin`, marked with `.install-complete`, renamed into
  place; one in-memory lock per tool. The installer is bun when it is on the
  machine (`bun add --exact`), else npm, which comes with Node.js (`npm install
  --prefix <staging> --no-save --exact --ignore-scripts <name>@<version>`;
  never global). npm is looked up on the login shell's PATH, then Homebrew,
  `/usr/local/bin`, Volta and the newest nvm version; on Windows as `npm.cmd`
  on PATH (PATH + PATHEXT, no POSIX shell), then `Program Files\nodejs` and
  `%APPDATA%\npm`, and run through cmd.exe with each argument quoted. Turning on agent access
  starts the install when either is present; only when neither is found does
  Settings ask the user to install Node.js. Never fetched at run time (no
  `bunx`/`npx`; agent-device's own `cdp` command runs `npm exec` internally).
- **Runtime:** Durango Code's own executable as Node
  (`ELECTRON_RUN_AS_NODE=1`; the fuse is kept on for the MCP shim). agent-device
  needs Node ≥ 22.12.
- **Launcher** (`devices/agent-device-launcher.js`): per (thread, device)
  session `dc-<12 hex>`, `userData/devices/targets/<session>/agent-device` (sh)
  + `agent-device.mjs`. It appends `--platform`, `--udid`/`--serial` and
  `--session`; refuses the agent's own copies of those flags and the commands
  that manage agent-device's connection (`connect`, `disconnect`,
  `connection`, `auth`, `daemon`, `proxy`, `mcp`, `plugins`, `device`);
  refuses the flags that would point it at another daemon or state
  (`--state-dir`, `--daemon-base-url`, `--daemon-auth-token`,
  `--daemon-transport`, `--daemon-server-mode`, `--config`, `--remote-config`,
  `--tenant`, `--session-isolation`, `--lease-id`, `--lease-backend`,
  `--ios-simulator-device-set`; in agent-device 0.21.35 explicit flags beat
  the environment, and a project `agent-device.json` cannot set the state dir
  or daemon URL); pins `AGENT_DEVICE_STATE_DIR=userData/devices/agent-device`,
  sets `AGENT_DEVICE_NO_UPDATE_NOTIFIER=1` and drops every other
  `AGENT_DEVICE_*` variable (including `AGENT_DEVICE_DAEMON_BASE_URL`,
  `AGENT_DEVICE_CONFIG`, `AGENT_DEVICE_HOME`). The command is found the way
  agent-device's parser finds it (value flags consume their value, so
  `--run-id help snapshot` is `snapshot`; the value-flag list is generated
  from 0.21.35 and must be regenerated with the pin), and the refusals run over
  every argument before the help/`--version` pass-through. It re-reads the consent
  switches before every invocation (see Consent). agent-device talks to a detached local daemon over 127.0.0.1 (port
  in `daemon.json`); the launcher probes it first and, when loopback is
  blocked, says a sandbox is the cause and to rerun with network access.
- **Lifetimes:** launchers are pruned at app start; deleting a thread closes
  its sessions; quitting ends every session and stops the daemon. Devices keep
  running in both cases. Both also cancel the `device_open` calls still in
  flight (installing or booting) and wait for them, so none registers or
  leaves a launcher afterwards; quitting refuses later opens. A `device_open`
  queued behind a close that shut its device down re-reads the device under
  the lock and boots it again. The quit cleanup is one idempotent promise
  (`shutdownDevices` in `devices/device-ipc.js`) that both the ordinary and the
  updater quit barriers in `main.js` wait for, bounded at 10 s so a wedged
  agent-device cannot hold quit open.

### Platforms

`devices/device-platforms.js`: iOS through `xcrun simctl` (`list devices
available --json`, `boot` + `open -a Simulator` + `bootstatus -b`, `shutdown`,
`io screenshot`). Android through the SDK found in `ANDROID_HOME`,
`ANDROID_SDK_ROOT` or the default location (`adb devices -l`, `emulator
-list-avds`, `emulator -avd` then `sys.boot_completed`, `adb exec-out screencap
-p`, `adb emu kill`). A stopped AVD's id is `avd:<name>` until it boots.

### UI

- `src/app/DevicesSettings.tsx`: the two switches, iOS/Android availability
  with reasons, the device count, agent-device install state and button.
- `src/app/DeviceCard.tsx`: a floating card at the top of a thread pane while
  that thread has a device open: name and OS, latest screenshot (pushed when
  the agent takes one, on Refresh, and every 2 s while expanded, Live is on and
  the window is visible), Show in Simulator, Close, Shut down.

## Phase 2: live view and input (design)

Goal: the card (or a pane) shows the device live and the user can tap and
type into it, without exposing anything new on the network.

### expo-device-hub behind a proxy

[expo-device-hub](https://www.npmjs.com/package/expo-device-hub) (0.19.1;
MIT AND Apache-2.0 AND BSD-3-Clause) bundles serve-sim (iOS: CoreSimulator
framebuffer → AVCC H.264 or MJPEG, input over a WebSocket) and serve-emu
(Android: SEMU-framed H.264 + JSON gestures over one WebSocket). Install it the
same way as agent-device (pinned, staged, bun or npm), only after a separate consent
step ("Live device view"), and run it as a supervised child on Durango Code's
Node, bound to 127.0.0.1 on a random port.

The hub must never be reachable directly: serve-sim has a shell-exec route
whose token its own unauthenticated `/api` returns, and serve-emu's action
routes have no auth. So the renderer only ever talks to an **authenticated
loopback proxy** in the main process:

- Per-launch 256-bit random token (`crypto.randomBytes(32)`), handed to the
  renderer over IPC, never written to disk. `<img>`/`WebSocket` cannot send
  headers, so it travels as `?t=`; the proxy compares it in constant time and
  **strips `t` before forwarding**.
- Bound to 127.0.0.1; checks `Origin` (the app's own origin or none) and
  `Host` (DNS rebinding).
- A regex **path allowlist** of stream, config and screenshot routes; anything
  else is 404. Never the exec channel, never the hub's `/api` token route.
- **GET only**, except screenshot capture and the WebRTC offer/answer route.
- Strips hop-by-hop, cookie and auth headers both ways; responses get
  `Cache-Control: no-store, no-transform` (`no-transform` so nothing buffers an
  endless MJPEG body).
- Device settings (appearance, locale, location…) never go through the hub:
  typed IPC actions run `simctl`/`adb` directly, as phase 1 does.

### Steps

1. **MJPEG first.** iOS MJPEG into an `<img>` in the card. Browsers paint a
   multipart part only when the next one begins and the hub writes only on
   change, so the proxy re-sends the last part after a short quiet period.
2. **WebCodecs.** iOS AVCC and Android SEMU H.264 decoded with WebCodecs into
   a canvas (Electron's renderer is a secure context, so it is available);
   MJPEG stays the fallback.
3. **Input.** Pointer and keyboard events mapped to device coordinates over
   the hub's input socket, behind the same proxy; a "takeover" state pauses
   agent input (`agent-device takeover`) while the user drives.

### Risks

- **Native addon ABI.** serve-sim loads private CoreSimulator frameworks
  through a native addon built for Node's ABI; under `ELECTRON_RUN_AS_NODE`
  Electron's Node ABI differs, so the addon may fail to load. Mitigations, in
  order: check the prebuilds it ships; run the hub on a user-installed Node
  (found like npm) when the addon cannot load; as a last resort, rebuild
  against Electron's headers at install time.
- Private CoreSimulator APIs can break with Xcode releases; keep the phase 1
  screenshot path as the fallback.
- Licenses: expo-device-hub is MIT AND Apache-2.0 AND BSD-3-Clause; add its
  notices to `THIRD_PARTY_NOTICES.md` with the install.

## Not yet

- Physical devices (listed for Android, refused by `device_open`).
- Windows/Linux are untested (the launcher writes a `.cmd` on Windows; iOS is
  macOS only).
- Providers' system prompts: only Claude gets a one-line hint; the others see
  the tool descriptions.
- The user's own `~/.agent-device/config.json` still applies to launcher
  calls (it is the user's configuration); the launcher's pinned state dir
  overrides any `stateDir` in it, but a `daemonBaseUrl` there would be used.
