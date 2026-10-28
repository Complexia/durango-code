# Orion Cloud repositories

Orion Desktop can publish any local git repository to Orion Cloud (Orion Web)
and keep it in sync — a lightweight GitHub alternative for code storage and
source control, built around real git data.

## Using it

Sign in to your Orion account (Settings → Account), then use the source-control
button in the shell bar:

- **Change source control to Orion** appears for a GitHub origin. It provisions
  an available Orion repository (using the same name when safe), fetches and imports every
  GitHub branch and tag, moves `origin` to Orion's smart-HTTP Git service, and
  preserves the old URL as the `github` mirror. Continuous mirroring is never
  enabled when that complete import cannot be verified. If a local branch or
  tag differs from GitHub under the same name, GitHub keeps the canonical name
  for the initial import and the local ref is preserved as
  `orion-local/<name>`. A conflicting checked-out branch is renamed in place,
  so its files and commits remain exactly as they were and can be merged or
  opened as a pull request against the imported branch.
- **Push to Orion** appears for a plain project or a Git repository without an
  origin. Plain projects are initialized on `main`, receive a conservative
  `.gitignore` when they do not already have one, and get an initial commit.
- **Commit and Push** and branch reads use
  the provider behind `origin`. An Orion push is authoritative. When the
  optional GitHub authorization is active, Orion Cloud continuously updates
  the preserved GitHub mirror even while Desktop is closed. Until then,
  Desktop retains its best-effort mirror and reports failures as warnings.
- **Pull** (cloud-download icon) — downloads new commits (including edits made
  in the web editor), updates `refs/remotes/origin/*` for converted repos (or
  the legacy `refs/remotes/orion/*` namespace), and fast-forwards the current
  branch when possible.
- **Globe** — opens the repository on Orion Web, where you can browse the file
  tree, edit files in Monaco, create and delete files. Every web edit is a real
  git commit (authored with your account identity) that the next pull brings
  down.

## How it works

Normal source-control operations use Orion's Git smart-HTTP service. The
desktop discovers its base URL from `/api/cli/whoami`, stores no credential in
the remote URL, and supplies the current desktop session through a transient
askpass process. Immediately before supplying that credential, Desktop checks
the complete `origin` URL against the endpoint Cloud advertises for the linked
repository; a mutable local provider marker is never sufficient. Repository linkage remains in local Git config through
`orion.cloudrepoid` and `orion.sourcecontrol`.

Continuous GitHub mirroring is optional and repository-scoped. Orion Cloud
returns an authorization link when its GitHub App still needs access. Once the
Cloud mirror is active, Desktop stops pushing the `github` remote itself;
reconnect and delivery errors stay owned by Cloud so two writers never race.
GitHub is read-only from Orion's product point of view: direct GitHub writes
are not imported back into Orion and Cloud's periodic reconciliation restores
Orion's branch and tag refs. GitHub organization rules can additionally block
human pushes when hard write prevention is required.

`src/cloud-sync.js` remains the object-transfer path used by Cloud pull,
deployment, and legacy publishing:

- **Push**: `git pack-objects --revs` builds one incremental packfile covering
  everything the server's refs don't reach. The pack, a per-branch file
  manifest (`git ls-tree`), and any raw file blobs the server is missing are
  uploaded directly to object storage via presigned URLs. Ref updates are
  committed atomically with a compare-and-swap; concurrent pushes or web edits
  can't clobber each other.
- **Pull**: packfiles and loose objects (web edits) are downloaded straight
  into `.git/objects` — both are inert, content-addressed formats git reads
  natively — then `refs/remotes/orion/*` is updated and the current branch is
  fast-forwarded (`git merge --ff-only`). Nothing is rewritten; a pull can at
  worst add unreferenced objects.
- JSON APIs use the existing Orion account desktop session as a bearer token;
  smart HTTP accepts that same session as the Basic-auth password.
- **Compaction**: every push adds one incremental pack and every web edit adds
  loose objects, so a background worker (`orion-web/git-worker`, Rust, hosted
  on Railway) periodically consolidates each repo into a single optimized pack
  with `git repack` and swaps it in atomically. Clients notice nothing — the
  next pull just downloads one pack instead of many. See its README for the
  full design (thresholds, tombstone GC, concurrency safety).
- **Hosted apps (opt-in deploy)**: pressing **Deploy** on a repo's Orion Cloud
  page provisions a hosted app at `https://<name>-<id>.andromedus.dev`. From
  then on every push to the default branch redeploys it automatically. The git
  worker deploys the default branch to Railway (Railpack auto-builds
  Next.js/Node/etc.), and `orion-web/gateway` — which holds the
  `*.andromedus.dev` wildcard domain — routes each subdomain to its app. The
  repo page shows live deploy status and links to the app.

## Local development

Run Orion Web locally (see its README: docker Postgres + MinIO, then
`bun run dev`) and start the desktop app with:

```bash
ORION_WEB_URL=http://localhost:3000 bun run start
```
