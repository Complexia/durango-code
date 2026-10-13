---
name: use-orion-cli
description: Operate Durango Code source control and Durango Cloud with the Durango Code CLI (`durango-code`; the older `orion-cli` command is the same CLI). Use for Durango Code (formerly Orion) repositories, pull requests, deployments, services, environments, previews, variables, domains, buckets, logs, GitHub mirroring, or when a user explicitly asks for a plan that should be published and shared as a link.
---

# Durango Code CLI

Use `durango-code` from the relevant project directory. `orion-cli` and
`orion-cloud` are aliases of the same CLI and accept identical arguments, so
existing scripts keep working; prefer `durango-code` in new commands. Prefer
`--json`, parse the single JSON object on stdout, and treat a nonzero exit as
failure. Run `durango-code help` or `<command> --help` when the installed
command contract is unclear. Read [references/commands.md](references/commands.md)
when using anything beyond the quick workflows below.

## Guardrails

- Authenticate with `durango-code login` or `DURANGO_CODE_TOKEN` (the legacy
  `ORION_TOKEN` is still read). Never print, persist in a remote URL, or pass a
  token in a command argument other than the explicit `login --token` flow.
- Inspect before changing state with `whoami`, `status`, `list`, `repo list`,
  `resources list`, or `pr view`.
- Resolve exact app, repository, environment, service, and domain targets
  before a mutation. Use `--yes` only for an intended destructive command.
- Deploy through Durango Cloud. Do not substitute direct Railway, Vercel, or
  provider-dashboard deployment unless the user explicitly asks for that.
- Commit app changes before deployment. Durango Cloud deploys `HEAD`, not
  uncommitted work. Verify the terminal deploy state and smoke-test the
  returned URL.

## Publish a requested plan

Publish a plan only when the user explicitly asks for a plan of something. Do
not upload routine internal planning, status notes, or plans created merely to
organize implementation work.

1. Write a self-contained HTML plan with no credentials, secrets, or private
   data. Anyone with the returned link can view it.
2. Run `durango-code plan upload <plan.html> --json`.
3. Confirm the JSON has `ok: true`, then include its exact `url` in the response
   to the user.
4. If upload fails, report the failure and do not imply that a share link was
   created.
5. When the user asks to update a plan that already has a link, run
   `durango-code plan update <link-or-id> <plan.html> --json` so the existing link
   shows the new content. Do not publish a second link unless the update is
   refused (for example, the plan belongs to another account).

## Deploy and verify

```sh
durango-code deploy --json
durango-code status --json
```

Treat deployment as successful only when the deploy response reports
`ok: true` and `status: "deployed"`. Use its `url` for live verification.

## Resolve and merge a pull request

```sh
durango-code pr view <number> --json
durango-code pr checkout <number>
durango-code pr update-branch <number>
# Resolve conflicts, test, and commit if the merge remains in progress.
durango-code pr push <number> --json
durango-code pr view <number> --json
durango-code pr merge <number> --merge --json
```
