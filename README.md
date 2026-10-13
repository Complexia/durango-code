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

Desktop login targets the Durango Code web origin: development (`npm run start`)
defaults to `http://localhost:3000`, packaged builds default to
`https://code.durango.sh` (`orioncode.xyz` remains a legacy alias of the same service). Set `ORION_WEB_URL` to override either (the origin
must have Clerk and the desktop auth routes configured).

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

By default this bumps the patch version, builds the current platform/architecture, uploads artifacts to versioned R2 keys under `releases/v<version>/`, and updates `releases/latest.json`.

macOS builds are Developer ID signed, notarized, stapled DMGs. See [docs/macos-signing-release.md](docs/macos-signing-release.md) for local keychain setup and verification commands.

Useful overrides:

```bash
bun run deploy --bump minor
bun run deploy --version 1.2.3
bun run deploy --bump none
bun run deploy --resume-upload
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
