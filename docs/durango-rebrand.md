# Durango Code rebrand (desktop)

The desktop app ships as **Durango Code**. Only customer-facing names changed.
The app keeps its internal Orion identity because installed users depend on it.
Merge plan: Phase 2.2 in the epic's `durango-merge-plan.md` and `contracts.md`
§1–2.

## What changed

| Area | Now |
|---|---|
| `package.json` `productName`, forge `packagerConfig.name` | `Durango Code`. The bundle is `Durango Code.app` and the executable is `Contents/MacOS/Durango Code`. |
| Info.plist | `CFBundleName` and `CFBundleDisplayName` are `Durango Code`. `NSAppleEventsUsageDescription` says Durango Code. |
| DMG | Title `Durango Code Installer`. The background has no brand mark, so it is unchanged. |
| Window, `index.html`, About panel, macOS app menu | `Durango Code` ("About / Hide / Quit Durango Code"). |
| Copy | "Durango Code" for the app, "Durango Cloud" for Orion Cloud, "Durango account" for the account, and "Sign in to your Durango account". |
| Orchestrator pseudo-model label | `Durango Code` (the id `orion:orchestrator` and slug `orion` are unchanged). |
| Web origin (packaged default for `DURANGO_URL` / `ORION_WEB_URL`) | `https://durango.sh` (was `https://code.durango.sh` until the Durango Code web app merged into durango.sh). Dev uses `http://localhost:3000`. |
| Update feed (default for `ORION_UPDATE_FEED_URL`) | `https://durango.sh/api/update/macos`. |
| MCP OAuth client metadata | `client_name: "Durango Code"`, `client_uri: "https://durango.sh"`. |
| Icons | `assets/icon.{png,icns,ico}` and `public/icon.png` come from `assets-source/durango-code-icon.png` (a copy of `durango-chat/andromedus/public/assets/durango-code-icon.png`). The iconset is in `assets-source/durango-code.iconset`. The old Orion sources stay in `assets-source/` for reference. |
| Bundled skill `use-orion-cli` | Same directory and skill name. The content is synced from `orion-cli/SKILL.md` (the Durango Code CLI `durango-code`, with `orion-cli` as an alias). The skill installs only once per machine, so existing users keep their copy. |
| Release artifacts | `Durango-Code-<version>-<os>-<arch>.<ext>` (see below). |

### Legacy hosts stay accepted

- **Web:** the APIs once served by `orioncode.xyz` and `code.durango.sh` now live on `durango.sh`, against the same tokens.
  - `src/main/web-origin.js` treats both retired origins as `https://durango.sh` when comparing a saved credential's origin.
  - A repository credential (`orion_pat_…`) or Durango key minted against a retired origin is reused, not re-minted.
- **Git:** `git.durango.sh` and `git.orioncode.xyz` are one alias group (`src/main/source-control.js`).
  - Remotes on either host classify as Durango Cloud remotes.
  - `verifyOrionGitRemote` accepts an existing clone whose `origin` points at the alias of the host that Cloud advertises.
  - The scheme, port and path must still match exactly, and the URL must carry no credentials.
  - Existing clones keep pushing to `git.orioncode.xyz`.
- **Relay:** `wss://relay.orioncode.xyz` is infrastructure and is unchanged.

## What intentionally still says Orion

Changing any of these breaks installed users, transcripts or other services.

- **Identity:**
  - Bundle id `com.complexia.orion` (TCC permissions, keychain ACL, updater identity).
  - `app.getName()` is `Orion`.
  - userData is `~/Library/Application Support/Orion` (dev: `Orion (dev)`).
  - The keychain item is `Orion Safe Storage`.
  - The logs directory is `~/Library/Logs/Orion`.
  - The `setAppUserModelId` is unchanged.
- **Protocols:** `orion://` (desktop auth callback, thread links) and `orion-attachment://`.
- **Files:**
  - `orion-store.json`, `orion-threads*`, `orion-account-session.json`, `orion-mcp*`, `orion-remote-control.json`.
  - The `.orion-bundled-skills.json` receipt.
  - The updater cache `orion-updater`.
  - The persist key `orion-storage`.
- **Code ids:**
  - `window.orion` and the IPC channel names.
  - `orion:orchestrator` and `orion:no-project`.
  - Internal component and function names (`OrionBrandIcon`, `getOrionWebUrl`, …).
- **Git:** config keys `orion.*`, the Rift branch namespace `orion/...`, `orion-local/...` preserved refs, and the `# Orion Rift metadata` exclude line.
- **Agents:**
  - The MCP server name `orion` (`mcp__orion__*`) and its tool names.
  - The `<!-- ORION:ORCHESTRATION:START/END -->` markers.
  - Prompt context tags such as `[Orion orchestration]`, `[Orion thread context]` and `[Orion general instructions]`. The managed CLAUDE.md block and prompts refer to these as functional markers.
  - Codex `clientInfo.name: 'orion'` (the title is now "Durango Code").
- **Environment variables:** `ORION_*`.
- **Fallback email:** the git author email fallback `orion@users.noreply.orioncode.xyz`.
- **Release config:**
  - The R2 bucket `orion-builds` and the key layout `releases/v<v>/<os>/<arch>/…`.
  - The S3 object metadata `product: orion`.
  - The notary profile `orion-notary`.
- **Code comments** and internal log messages.

## userData and safeStorage pinning

### How Electron derives them (Electron 42.5.0)

- At startup Electron sets `app.name` from `package.json` `productName`, falling back to `name`.
- The default `userData` path is `<appData>/<app.name>`.
- On macOS, safeStorage (Chromium OSCrypt) uses the keychain generic password whose service is `"<app.name> Safe Storage"` and whose account is `<app.name>`.
- The browser process reads the name while it sets up its message loop. That happens after the main script's top-level code runs and before `ready`.
- So `app.setName()` must run synchronously at the top of the main script. Setting it after `ready` is too late.

With `productName: "Durango Code"` and no pin, the updated build would:

- look in `~/Library/Application Support/Durango Code`, which is empty, so the user would lose projects, threads and settings;
- create a new `Durango Code Safe Storage` key, so every safeStorage value would fail to decrypt. That covers the account session, MCP OAuth credentials and remote-control secrets.

### The pin

`src/main/pin-app-identity.js` is the **first import** in `src/main.js`. The production Vite bundle is CommonJS and keeps module evaluation order, so this module runs before any other module's top-level code. It calls `pinInternalAppIdentity(app)` from `src/main/app-identity.js`, which:

1. calls `app.setName('Orion')`, which pins the keychain service to `Orion Safe Storage`;
2. calls `app.setPath('userData', path.join(app.getPath('appData'), 'Orion'))` unconditionally. It never reads the default first, because that could create an empty `Durango Code` directory.

In the Forge/Vite build (`.vite/build/main-*.js`), the pin is the first module code that runs. Only Node built-in `require`s come before it. A dev launch (`electron-forge start`) showed a "Durango Code" window and brand, loaded the existing `Orion (dev)` profile, and created no `~/Library/Application Support/Durango Code` directory.

The dev-profile logic later appends ` (dev)` (`devUserDataPath`). The `ready` handler sets the name to `Orion` again as before.

Electron builds its default app menu from `app.getName()`, which would label the items "About Orion" and "Quit Orion". So on macOS the main process installs an equivalent menu with explicit "Durango Code" labels and `setAboutPanelOptions({ applicationName: 'Durango Code' })`.

Two things keep the keychain ACL valid across the update:

- The Developer ID signature's designated requirement is the bundle id plus the team, and both are unchanged.
- The item name is unchanged.

So the updated app reads `Orion Safe Storage` without a keychain prompt.

### Evidence: `bun run test:app-identity`

`scripts/test-app-identity.mjs` has two parts.

1. **Path and config checks** (plain node):
   - The pinned name and path are correct.
   - The pin calls `setName` before it resolves userData.
   - `pin-app-identity.js` is the first import of `main.js`.
   - The dev profile is `<legacy> (dev)`.
   - `package.json` and forge use productName `Durango Code`, bundle id `com.complexia.orion`, CFBundleDisplayName, the DMG title, and a usage string without "Orion".
   - The `paths.js` file names and protocols are unchanged.
   - The web-origin aliases and defaults are correct.
2. **Keychain probe** (macOS, real Electron 42 from `node_modules`). It uses throwaway names and never touches the real `Orion Safe Storage`.
   1. An app with productName `OrionIdentityProbe<rand>` encrypts a value with safeStorage.
   2. The same app relaunched with productName `Durango Code Identity Probe <rand>` and the pin must:
      - see the new productName at startup;
      - resolve the same userData;
      - decrypt the value;
      - create no `<new name> Safe Storage` keychain item.
   3. A control run with the new productName and no pin must fail to decrypt. It does fail: "Error while decrypting the ciphertext provided to safeStorage.decryptString."

   The probe deletes its keychain items and userData directories afterwards. Skip it with `--skip-keychain` or `ORION_SKIP_KEYCHAIN_PROBE=1`.

Result on this machine (2026-10-13):

```
app identity: path logic and packaging config OK
app identity: keychain probe OK (pinned build decrypted; unpinned control failed: Error while decrypting the ciphertext provided to safeStorage.decryptString.)
```

### Manual upgrade check before shipping (packaged, signed)

The probe runs the unsigned dev Electron. Before release, verify a real in-place upgrade once:

1. Install the last Orion release (1.0.147) in `/Applications/Orion.app`, sign in, add an OAuth MCP and enable remote control.
2. Run `security find-generic-password -s "Orion Safe Storage"`. Exactly one item should exist.
3. Build and sign the new version (`bun run make`, or `bun run deploy` to a staging bucket). Update through the in-app updater, or quit and replace `Orion.app`'s contents with the new `Durango Code.app` the same way Squirrel does.
4. Launch it and check:
   - The Dock, menu and About panel say Durango Code.
   - The account is still signed in, with no keychain password prompt.
   - Projects and threads are present.
   - The MCP stays connected without signing in again.
   - Remote control still lists its paired machines.
5. Check that `~/Library/Application Support/Durango Code` does **not** exist and that `security find-generic-password -s "Durango Code Safe Storage"` finds nothing.

## Auto-update and release artifacts

- Squirrel.Mac (through electron-updater) installs an update into the running bundle's location. Existing installs keep the `/Applications/Orion.app` path and show the new name inside. Only fresh downloads are named `Durango Code.app`.
- The update zip contains `Durango Code.app`. Squirrel picks the bundle by bundle id, so the name does not matter.
- Builds poll `https://durango.sh/api/update/<os>/<arch>/`. Older builds poll `https://code.durango.sh/…` or `https://orioncode.xyz/…`; they only find updates while those hosts keep answering the update feed.

`scripts/deploy.mjs` handles naming and the manifest:

- It uploads `Durango-Code-<version>-<os>-<arch>.<ext>` to the unchanged key layout `releases/v<version>/<os>/<arch>/<fileName>`.
- It keeps writing `releases/v<version>/manifest.json` and `releases/latest.json` with the same shape: `version`, `releasedAt`, `downloads.<os>.<arch>` and `updates.<os>.<arch>`, each holding `{ key, fileName, size, sha512, … }`.
- The manifest's `product` field is now `Durango Code`, but no route reads it.
- It finds `out/Durango Code-darwin-<arch>/Durango Code.app` for signing and notarization checks.

The web app's `/api/download/macos` and `/api/update/macos/[arch]/latest-mac.yml` read only `version`, `releasedAt`, `key`, `fileName`, `size` and `sha512`, and don't parse artifact names. They stay compatible. One cosmetic follow-up is for orion-web: their fallback download filename is still `Orion-macos.zip`. It applies only when `fileName` is missing, which deploy.mjs never produces.

## Legacy bundle file name (1.0.149)

Updates install in place, so pre-rebrand installs kept running from
`/Applications/Orion.app`. macOS shows the bundle's *file* name in the Dock
tooltip, Finder, Spotlight and Launchpad, so those users still saw "Orion".
`src/main/legacy-bundle-rename.js` (imported right after the identity pin)
renames a packaged `Orion.app` to `Durango Code.app` on launch and relaunches
from the new path. Renaming does not affect the code signature (verified with
`codesign --verify --deep --strict`), TCC grants (bundle id), Dock/Finder
aliases (they follow renames) or userData/keychain (pinned separately).

It skips: non-macOS, unpackaged/dev runs, mounted DMGs and App Translocation
paths, non-writable parent folders, and — never overwriting — when a
`Durango Code.app` already exists next to it. Opt out with
`DURANGO_CODE_SKIP_BUNDLE_RENAME=1`. Tests: `bun run test:legacy-bundle-rename`.
