# Durango Code CLI command reference

Every command below also runs as `orion-cli …` or `orion-cloud …`; those are
aliases of `durango-code`.

## Authentication and discovery

```sh
durango-code login
durango-code whoami --json
durango-code list --json
durango-code status --json
durango-code open
```

`DURANGO_CODE_ORIGIN` selects the Durango web origin (default
`https://durango.sh`). `DURANGO_CODE_TOKEN` overrides saved credentials for
CI and agent runs. `DURANGO_CODE_CONFIG_DIR` selects the local credential
directory (default `~/.config/durango-code`). `DURANGO_CODE_NO_UPDATE_CHECK=1`
skips the daily version check. The legacy `ORION_ORIGIN`, `ORION_TOKEN`,
`ORION_CONFIG_DIR`, and `ORION_NO_UPDATE_CHECK` names still work; the
`DURANGO_CODE_*` name wins when both are set.

## Repositories and collaborators

```sh
durango-code repo list --json
durango-code repo create <name> --default-branch main --json
durango-code repo configure <name-or-id> --visibility private --description <text> --json
durango-code collaborator list --project <name-or-id> --json
durango-code collaborator add <handle> --project <name-or-id> --role write --json
durango-code collaborator role <handle> --project <name-or-id> --role admin --json
durango-code collaborator remove <handle> --project <name-or-id> --yes --json
durango-code repo delete <name-or-id> --yes --json
```

## Source control and GitHub mirroring

```sh
durango-code source status --json
durango-code source use-durango --json
durango-code source mirror status --json
durango-code source mirror authorize
durango-code source mirror disconnect --json
```

`source use-durango` (also accepted as `source use-orion`) imports refs, makes
Durango Code authoritative, preserves GitHub as
the `github` remote, and starts mirroring unless `--no-github-mirror` is set.

## Pull requests

```sh
durango-code pr list --state open --json
durango-code pr view <number> --json
durango-code pr create --title <title> --body <body> --base <branch> --head <branch> --json
durango-code pr checkout <number>
durango-code pr update-branch <number>
durango-code pr push <number> --json
durango-code pr merge <number> --merge --json
durango-code pr close <number> --json
durango-code pr reopen <number> --json
```

`pr update-branch` may intentionally leave a conflicted merge in progress.
Resolve it, test, commit, and use `pr push` before rechecking mergeability.

## Deployments and configuration

```sh
durango-code deploy --json
durango-code deploy --project <id> --no-push --json
durango-code configure --root <dir> --build-command <cmd> --start-command <cmd> --healthcheck /healthz --json
durango-code activity --json
durango-code logs <deployment-id> --stream build --json
```

The first deploy creates and links a Durango Code repository when needed. Later
deploys reuse the `orion.cloudrepoid` Git config value. `deploy` waits for a
terminal state and returns the app and management URLs.

## Environments, previews, and vaults

```sh
durango-code environment list --json
durango-code environment create <name> --slug <slug> --json
durango-code preview configure --enable --pull-request-previews --ttl 72 --json
durango-code env list --environment production --json
durango-code env push <file> --environment production --json
printf '%s' "$VALUE" | durango-code env set NAME --stdin --environment production --json
durango-code env reveal NAME --environment production
```

Prefer `env push` or `env set --stdin`; keep secret values out of argv and
output. Preview environments should normally be limited to open pull requests.

## Services, domains, and storage

```sh
durango-code service list --json
durango-code service create <name> --root <dir> --inherit DATABASE_URL --json
durango-code service configure <name> --no-deploy-on-push --json
durango-code service deploy <name> --json
durango-code domain list --json
durango-code domain add <hostname> --json
durango-code domain primary <hostname> --json
durango-code domain add <hostname> --service <name> --json
durango-code bucket list --json
durango-code bucket create <name> --json
durango-code resources list --json
durango-code resources sync <resources.json> --json
```

## Plans

```sh
durango-code plan upload <plan.html> --json
durango-code plan update <id-or-link> <plan.html> --json
```

The plan must be non-empty HTML no larger than 5 MB. The result contains the
opaque plan `id`, unlisted public `url`, and `revision`. Upload only for an
explicit user request for a plan, and always return the URL to that user.

`plan update` replaces the HTML behind an existing link and keeps the link.
It accepts the share link or the bare id, requires the account that published
the plan, and returns the incremented `revision` and `updatedAt`. A 403 means a
different account owns the plan; a 404 means no plan exists at that id.
