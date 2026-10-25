# Durango workspaces

Durango Code gives each new thread in a Durango repository its own Durango
workspace, so parallel agents never edit the same checkout. A workspace is what
`durango-code ws new` makes: a detached git worktree of the repository's base
checkout under `~/.durango/ws/<repo>/<name>`, copy-on-write clones of its
`node_modules` and `target` directories, and a private port block in
`.durango/ws.env`. The app drives the same CLI agents use, so a workspace the
app made and one an agent made with the CLI are interchangeable.

Workspaces replace Rifts (per-epic copy-on-write clones), which were removed.
Persisted epics lose their Rift pointers on load; any `.rifts/` directories they
created stay on disk untouched.

## When a thread gets one

On a thread's first turn, before the agent starts, when all of these hold:

- **Settings → Workspaces → Create a workspace for each new thread** is on (the
  default);
- the thread's project is inside the main checkout of a git repository with a
  `durango.toml` at its root (a project that is itself a worktree does not
  qualify);
- the thread has never run: no provider session and no earlier agent run.
  Threads that already ran keep the directory their sessions were recorded in.

The name comes from the first message (`fix-sidebar-dots-k3f9`). The agent runs
in the project's directory inside the workspace, and a fresh session is told so
in a `[Durango workspace]` prompt block, so project instructions that say
"create a workspace first" are already satisfied. While the workspace is being
created (dependency clones can take a few seconds) the composer says so; if
creation fails the turn does not start and the error says why.

Branches and subagents share their source thread's workspace: their sessions
are forks of sessions recorded there. The deployment agent's thread works where
the Deploy button acted (the selected thread's workspace, or the project).
Claude Code CLI (terminal) threads and No project chats work in the project
directory.

## In the thread

The thread header shows the workspace instead of the branch picker: its path
and ports, the change it holds (`.durango/change.json`, with its status and
Source link), **Run dev server** (`ws serve`, waiting for a server slot like the
CLI), **Land** (`land`, which waits until the change is merged and live), and
**Remove workspace** (`ws rm`). Removing it asks first, and asks again before
discarding work that has not landed; the threads that worked in it keep their
transcripts, and their next message starts a fresh session in a new workspace.
Deleting the last thread that uses a workspace removes it too, unless it holds
unlanded work, which is never discarded silently.

## The bundled CLI

The app ships the `durango-code` CLI (the pinned `durango-code` npm dependency,
unpacked from the asar) and runs it on Electron's own Node, so installs do not
need a global CLI. On launch `src/main/bundled-cli.js` writes `durango-code`,
`ds`, `durango-source` and `orion-cli` launchers into `<userData>/bin` and
appends that directory to `PATH` for agents and the embedded terminal. A CLI the
user installed globally comes first on `PATH` and keeps winning for agents; the
app's own workspace features always run the bundled copy. A small wrapper keeps
`ELECTRON_RUN_AS_NODE` away from the processes the CLI starts (dev servers,
`ws run` commands), except the CLI's own background train.

Agents need a signed-in CLI to open and land changes. When the CLI has no
credential, the app signs it in with the Durango account (Settings → Workspaces
→ Sign in the CLI, or automatically before creating a workspace): it mints a
separate device token with the account session, exactly like
`durango-code login`, and saves it to the CLI's credentials file as a managed
token, so `durango-code logout` revokes it. An existing CLI sign-in is never
replaced, and development builds pointed at another origin never write one.

Update the bundled CLI by publishing a new `durango-code` release, then bumping
the exact pin in `package.json` (`bun add durango-code@<version> --exact`) and
the `package-lock.json` entry.

## Implementation

- `src/main/bundled-cli.js`: launchers, `runBundledCli`, CLI sign-in.
- `src/main/durango-workspaces.js`: eligibility, `ws new` / `ws rm` /
  `ws list` / `ws serve` / `ws stop` / `change show` / `land`, all with `--json`.
- IPC: `durangoCli:*` and `durangoWorkspace:*` in `src/main.js`.
- Renderer: `ensureThreadDurangoWorkspace` and `handleRemoveThreadWorkspace` in
  `src/App.tsx`, `Thread.durangoWorkspace` in `src/store.ts`, the header pill in
  `src/app/DurangoWorkspaceControl.tsx`, settings in
  `src/app/WorkspacesSettings.tsx`.

```sh
bun run test:durango-workspaces   # launchers, ws new/list/rm, sign-in guards (Electron)
bun run test:ui-improvements
```
