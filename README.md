# Durango Code desktop (Orion)

**Durango Code** (internal name: Orion) is a lightweight Agentic IDE desktop application. The rebrand only changes customer-facing names; see [docs/durango-rebrand.md](docs/durango-rebrand.md) for what intentionally still says Orion.

## Features

### Agents Tab (default)
- Sidebar with projects and threads
- Add local folders as projects
- Create multiple threads per project (agentic runs)
- Simple chat interface per thread (mock agent for now — easily swappable for real Codex / Claude Code / Cursor agent integrations)
- Status indicators

### Code Tab
- File explorer for any folder or linked project
- Open multiple files as tabs
- Built-in editor with syntax-aware editing (textarea today, ready for full Monaco)
- Save files (Cmd/Ctrl+S)
- Close tabs (Cmd/Ctrl+W)

### Durango Cloud repositories
- Publish any git project to Durango Cloud and push/pull from the shell bar
- Browse and edit the code on Durango Code web (Monaco); web edits are real git commits you pull back
- See [docs/orion-cloud-repos.md](docs/orion-cloud-repos.md)

### Remote control
- Pair two Durango Code instances and drive one from the other's sidebar (Machines section)
- End-to-end encrypted connection, either direct over LAN/VPN or through Durango Cloud's internet relay; both machines must be signed in to the same account
- See [docs/remote-control.md](docs/remote-control.md)

### Architecture
- Electron + Vite + React + TypeScript
- IPC bridge for secure filesystem access (main process)
- Zustand for client state (persisted)
- VSCode-inspired dark theme

## Run

```bash
npm install
npm run start
```

Desktop login, repositories, sync, plans, the Durango API and the update feed all
live on one web origin: development (`npm run start`) defaults to
`http://localhost:3000` (the local Durango dev server), packaged builds default to
`https://durango.sh`. Set `DURANGO_URL` (or the older `ORION_WEB_URL`) to override
either (the origin must have Clerk and the desktop auth routes configured).

## Build

```bash
npm run package
npm run make   # produces distributables
```

## Release

Release tooling is pinned to Node.js 24.18.1. Run `nvm use` after entering the
repository so native packaging dependencies and the deploy process use the same
Node ABI. The deploy command checks both the Node major and the macOS DMG native
dependency before changing the package version.

To verify the pinned Node runtime and native DMG dependency without building,
bumping, or publishing a release, run `bun run deploy -- --check-runtime`.

Create `.env.release.local` from `.env.release.example`, then run:

```bash
bun run deploy
```

By default this bumps the patch version, builds macOS for the current architecture, and publishes it to R2. It also releases Windows and Linux: it tags HEAD as `v<version>` and pushes the tag, which starts [`.github/workflows/release.yml`](.github/workflows/release.yml). That workflow runs `scripts/deploy.mjs --ci` on Windows (NSIS `.exe`) and Linux (`.deb`) runners while the Mac builds, and the deploy command waits for it at the end (`gh` required to follow it).

Because CI builds the tagged commit, the release refuses to start with uncommitted or untracked changes (other than the version in `package.json`/`package-lock.json`). Pass `--no-ci` to release macOS only.

R2 layout (see [scripts/release-manifest.mjs](scripts/release-manifest.mjs)): every build writes only its own platform's keys, so the Mac and CI builds never overwrite each other.

- `releases/v<version>/<os>/<arch>/`: artifacts plus that build's `manifest.json`
- `releases/latest/<os>-<arch>.json`: the newest stable build per platform, read by durango.sh's `/api/download/<os>` and `/api/update/<os>/<arch>/` feeds
- `releases/latest.json`: the older macOS-only manifest, still written by macOS releases

Stable releases also update the Arch Linux package [`durango-code-bin`](https://aur.archlinux.org/packages/durango-code-bin) on the AUR: the workflow's `aur` job fills [packaging/aur/PKGBUILD](packaging/aur/PKGBUILD) with the version and the checksum of the published `.deb` and pushes it with the `AUR_SSH_PRIVATE_KEY` secret ([packaging/aur/publish.sh](packaging/aur/publish.sh)).

Prerelease versions (`--version 1.2.3-rc.1`) upload their artifacts without moving any `latest` pointer, which makes them a safe end-to-end test of the whole pipeline.

The workflow reads the R2 credentials from repository secrets (`ORION_R2_BUCKET`, `ORION_R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`). Set them from your release env file with `gh secret set -f .env.release.local`. To rebuild a tag's Windows/Linux releases, run `gh workflow run release.yml -f tag=v<version>`.

macOS builds are Developer ID signed, notarized, stapled DMGs. See [docs/macos-signing-release.md](docs/macos-signing-release.md) for local keychain setup and verification commands.

Useful overrides:

```bash
bun run deploy --bump minor
bun run deploy --version 1.2.3
bun run deploy --bump none
bun run deploy --resume-upload
bun run deploy --no-ci
```

Use `--resume-upload` after a network failure during artifact upload. It reuses
the existing versioned artifacts after verifying their signatures and
notarization instead of rebuilding or bumping the version again.

## Extending

### Real Agents
In `src/App.tsx`, the `sendMessage` function currently simulates replies. Replace the mock logic with calls to:
- Codex CLI
- Claude Code
- Cursor agent
- T3 Code compatible providers

Use child_process or the existing CLI tools via IPC in `src/main.js`.

### Full Monaco Editor
Uncomment the Monaco `<Editor>` component in the Code tab and import from `@monaco-editor/react`. The project is already set up for it (workers + config ready).

### Linting
Monaco + language servers (or simple ESLint worker) can be added to the editor pane.

## Notes
Inspired by T3 Code, OpenAI Codex desktop, and Cursor's agentic views.

Core is deliberately simple: two tabs, projects/threads, file explorer + editor.

MIT
