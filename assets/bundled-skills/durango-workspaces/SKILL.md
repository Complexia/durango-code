---
name: durango-workspaces
description: Work safely in a repository that has a durango.toml at its root (Durango Source), where several agents work at once. Use before you edit files, install dependencies, run dev servers or tests that write, or commit in such a repository; when you finish a coding task there (open a change for review); when the user asks to land, ship or deploy a change; or to pick up an existing open change. Not needed to answer questions, read code, or look things up.
---

# Durango workspaces

A repository with a `durango.toml` is shared by several agents at once. Its
base checkout only tracks `main`: never edit, install, commit, or `git push`
there. Each task gets its own **workspace**: a detached git worktree under
`~/.durango/ws/<repo>/<name>` with copy-on-write clones of the dependency
directories and a private port block. Creating one takes a few seconds.

## When to create one

Create the workspace when the task needs to change something: edit files,
install packages, run a dev server, run tests that write files, or open a
change. Questions, explanations, code reading, `git log`, and other read-only
look-ups don't need one; answer them from the base checkout.

Skip creating one when you are already in a workspace: your working directory
is under `~/.durango/ws/`, or your prompt has a `[Durango workspace]` block that
names it. Use that one for the whole task and don't make a second.

## Start

```bash
durango-code ws new fix-sidebar-dots      # name it after the task; starts from main
cd "$(durango-code ws path fix-sidebar-dots)"
```

- Do all of the task's work inside the workspace, including installs, dev
  servers and tests. If your shell starts in the base checkout on later turns,
  `cd` back into the workspace (or use its paths) before running anything.
- Ports: use the workspace's block (`$PORT`, `$DURANGO_PORT_<TARGET>` in
  `.durango/ws.env`), never a hard-coded port.
- To continue an existing open change (yours from an earlier thread, or another
  agent's): `durango-code ws new <name> --change <id>`. `change amend` and
  `land` there update that same change.
- Durango Code puts `durango-code` (alias `ds`) on your `PATH`; don't install
  it.

## Run things

- Long-running dev servers go through the server queue so agents share a few
  slots: `durango-code ws serve <name>` (run it in the background). It waits for
  a free slot, first come first served. Check with `durango-code ws servers` and
  stop yours as soon as you're done: `durango-code ws stop <name>`. Don't start
  dev servers directly.
- Commands that finish (tests, typecheck, lint, builds) don't need a slot:
  `durango-code ws run <name> -- <cmd>`, or run them in the workspace directory.
- Secrets come from the vault, never from committed files:
  `durango-code run -- <cmd>` injects development values.

## Finish: open a change, don't land it

An open change is like an open pull request: the user reviews it and you amend
it as often as needed.

```bash
durango-code change create --title "Fix sidebar dots" --description-file /tmp/fix-sidebar-dots.md
durango-code change amend                       # more edits go into the same change
durango-code change amend --description-file /tmp/fix-sidebar-dots.md   # rewrite the description
```

- `change create` runs the repository's fast checks for the targets you touched
  and refuses without a description.
- Write the description like a pull request's, in Markdown: what changes and
  why (the ask, or the bug and its cause), how it works (approach, key files),
  how you verified it (tests, typecheck, what you saw running it), and anything
  risky or worth a close look (migrations, deploy order, follow-ups). Keep it
  current when an amend changes the approach.
- Show UI changes with screenshots: `durango-code change attach shot.png` uploads
  them and prints `![…](url)` lines to put in the description.
- Paths the repository publishes publicly (its `durango.toml` lists them) need
  `--public-description "…"` and must not depend on private paths.
- `durango-code change create --snapshot` backs up work in progress; snapshots
  never land.
- Report the change URL exactly as the CLI prints it. Opening the change ends
  the task: don't land, deploy, or touch production unless the user asks.

## Land only when the user says so

"Land it", "ship it", "finish this and land it": then run `durango-code land`
for what they asked.

- `land` waits until the change is merged (exit 0) or sent back to open (exit 1,
  with the reason). Exit 3 is a conflict: the workspace was rebased onto the new
  `main`; resolve the listed files and run `land` again.
- Landing then deploys the affected targets in the background;
  `durango-code deploys --watch` follows them. Report the outcome.
- `durango-code land --all` lands every open change, oldest first;
  `durango-code land <id> <id>…` lands specific ones; `land --cancel <id>` takes
  one off the train. Never deploy any other way.
- Land is refused when an added line contains a secret.
- Reverting a merged change: `durango-code change revert <id>` opens a revert
  change; land it like any other.

## Clean up

Keep the workspace until its change is merged or abandoned (the user may ask for
more edits), then remove it: `durango-code ws rm <name>`.
