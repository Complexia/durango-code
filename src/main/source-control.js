import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_GIT_BUFFER = 64 * 1024 * 1024;

// Durango Cloud git hosts. git.durango.sh is canonical after the Durango Code
// rebrand; git.orioncode.xyz is the same service and keeps serving
// indefinitely, so existing clones whose remotes point there must keep being
// recognized, verified and pushed to (contracts.md §2).
export const ORION_GIT_HOST_ALIAS_GROUPS = Object.freeze([
  Object.freeze(['git.durango.sh', 'git.orioncode.xyz']),
]);
export const DEFAULT_ORION_GIT_HOSTS = Object.freeze(['git.durango.sh', 'git.orioncode.xyz']);

/** Add every alias of the given Cloud git hosts (case-insensitive). */
export const withOrionGitHostAliases = (hosts) => {
  const result = new Set();
  for (const host of hosts ?? []) {
    const normalized = String(host ?? '').trim().toLowerCase();
    if (!normalized) continue;
    result.add(normalized);
    for (const group of ORION_GIT_HOST_ALIAS_GROUPS) {
      if (group.includes(normalized)) for (const alias of group) result.add(alias);
    }
  }
  return [...result];
};

/**
 * True when `remoteUrl` is `expectedUrl`, or the same URL on an alias host of
 * the Cloud-advertised git host (scheme, port, path and credentials-free form
 * must match exactly).
 */
export const isEquivalentOrionGitRemote = (remoteUrl, expectedUrl) => {
  const actual = String(remoteUrl ?? '').trim().replace(/\/+$/, '');
  const expected = String(expectedUrl ?? '').trim().replace(/\/+$/, '');
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  let actualUrl;
  let expectedParsed;
  try {
    actualUrl = new URL(actual);
    expectedParsed = new URL(expected);
  } catch {
    return false;
  }
  if (actualUrl.username || actualUrl.password || actualUrl.search || actualUrl.hash) return false;
  if (
    actualUrl.protocol !== expectedParsed.protocol ||
    actualUrl.port !== expectedParsed.port ||
    actualUrl.pathname !== expectedParsed.pathname
  ) {
    return false;
  }
  return withOrionGitHostAliases([expectedParsed.hostname]).includes(actualUrl.hostname.toLowerCase());
};

// Intentionally small and ecosystem-neutral. A deploy agent can replace this
// for a new project later, but source control must be safe before that agent
// runs. Existing .gitignore files are never changed.
export const BASELINE_GITIGNORE = `# Dependencies
node_modules/
.pnpm-store/

# Build output
dist/
build/
.next/
.output/
coverage/

# Local environment and secrets
.env
.env.*
!.env.example

# Logs and local tooling
*.log
.DS_Store
.idea/
.vscode/
`;

const runGit = async (gitRoot, args, options = {}) => {
  const { stdout, stderr } = await execFileAsync('git', ['-C', gitRoot, ...args], {
    maxBuffer: MAX_GIT_BUFFER,
    ...options,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
};

const tryGit = async (gitRoot, args) => {
  try {
    return (await runGit(gitRoot, args)).stdout;
  } catch {
    return null;
  }
};

const remoteHost = (remoteUrl) => {
  const value = String(remoteUrl ?? '').trim();
  if (!value) return null;

  // Git's common SCP-like syntax is not understood by URL.
  const scp = /^(?:[^@/:]+@)?(\[[^\]]+\]|[^/:]+):(.+)$/.exec(value);
  if (scp && !value.includes('://') && !/^[A-Za-z]:[\\/]/.test(value)) {
    return scp[1].replace(/^\[|\]$/g, '').toLowerCase();
  }

  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const githubCoordinates = (remoteUrl) => {
  const value = String(remoteUrl ?? '').trim();
  let pathname = '';
  const scp = /^(?:[^@/:]+@)?(?:github\.com|www\.github\.com):(.+)$/i.exec(value);
  if (scp) {
    pathname = scp[1];
  } else {
    try {
      pathname = new URL(value).pathname;
    } catch {
      return { owner: null, repo: null };
    }
  }
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2) return { owner: null, repo: null };
  return {
    owner: parts[0] || null,
    repo: parts[1]?.replace(/\.git$/i, '') || null,
  };
};

/** Classify a Git remote without contacting it. */
export const classifyRemoteUrl = (remoteUrl, { orionHosts = DEFAULT_ORION_GIT_HOSTS } = {}) => {
  const url = String(remoteUrl ?? '').trim();
  if (!url) return { kind: 'none', url: null, host: null, owner: null, repo: null };

  const host = remoteHost(url);
  if (host === 'github.com' || host === 'www.github.com') {
    return { kind: 'github', url, host, ...githubCoordinates(url) };
  }

  const normalizedOrionHosts = new Set(withOrionGitHostAliases(orionHosts));
  if (host && normalizedOrionHosts.has(host)) {
    return { kind: 'orion', url, host, owner: null, repo: null };
  }

  return { kind: 'other', url, host, owner: null, repo: null };
};

export const sanitizeRepositoryName = (value) =>
  String(value ?? '')
    .trim()
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 100);

/**
 * Match Orion's smart-HTTP repository route without trusting a mutable marker
 * in .git/config. Host trust is checked separately against the Cloud-advertised
 * gitHttpUrl immediately before credentials are supplied.
 */
export const orionRepoIdFromRemoteUrl = (remoteUrl) => {
  try {
    const parsed = new URL(String(remoteUrl ?? '').trim());
    const match = /\/r\/([^/]+)\.git\/?$/.exec(parsed.pathname);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
};

export const isOrionRepoRemoteUrl = (remoteUrl, repoId) =>
  Boolean(repoId) && orionRepoIdFromRemoteUrl(remoteUrl) === String(repoId);

export const parseNamedGitRefs = ({ stdout, namespace, field }) => {
  const prefix = `${String(namespace).replace(/\/+$/, '')}/`;
  return String(stdout ?? '')
    .split('\n')
    .map((line) => line.trim().split('\t'))
    .filter(
      ([refName, oid]) =>
        refName?.startsWith(prefix) && /^[0-9a-f]{40,64}$/i.test(String(oid ?? ''))
    )
    .map(([refName, oid]) => ({ [field]: refName.slice(prefix.length), oid }));
};

export const canReuseLinkedCloudRepo = ({ repo, expectedName }) =>
  Boolean(repo?.id && repo?.name === expectedName);

export const shouldReconcileDefaultBranch = ({ repo, authoritativeDefaultBranch }) =>
  Boolean(
    repo?.id &&
    authoritativeDefaultBranch &&
    repo.defaultBranch !== authoritativeDefaultBranch
  );

const uniquePreservedRefName = (original, used) => {
  const base = `orion-local/${original}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  used.add(candidate);
  return candidate;
};

/**
 * Keep GitHub's names exact for the initial mirror authorization while giving
 * every differing local ref a stable, visible Orion name. No OID is discarded.
 */
export const planGithubRefImport = ({ localBranches, githubBranches, localTags, githubTags }) => {
  const githubBranchByName = new Map(githubBranches.map((ref) => [ref.branch, ref]));
  const githubTagByName = new Map(githubTags.map((ref) => [ref.tag, ref]));
  const usedBranches = new Set([
    ...localBranches.map((ref) => ref.branch),
    ...githubBranches.map((ref) => ref.branch),
  ]);
  const usedTags = new Set([...localTags.map((ref) => ref.tag), ...githubTags.map((ref) => ref.tag)]);
  const branchPreservations = [];
  const tagPreservations = [];
  const targetBranches = new Map(githubBranches.map((ref) => [ref.branch, ref.oid]));
  const targetTags = new Map(githubTags.map((ref) => [ref.tag, ref.oid]));

  for (const local of localBranches) {
    const github = githubBranchByName.get(local.branch);
    if (!github) targetBranches.set(local.branch, local.oid);
    else if (github.oid !== local.oid) {
      const preserved = uniquePreservedRefName(local.branch, usedBranches);
      branchPreservations.push({
        original: local.branch, preserved, localOid: local.oid, githubOid: github.oid,
      });
      targetBranches.set(preserved, local.oid);
    }
  }
  for (const local of localTags) {
    const github = githubTagByName.get(local.tag);
    if (!github) targetTags.set(local.tag, local.oid);
    else if (github.oid !== local.oid) {
      const preserved = uniquePreservedRefName(local.tag, usedTags);
      tagPreservations.push({
        original: local.tag, preserved, localOid: local.oid, githubOid: github.oid,
      });
      targetTags.set(preserved, local.oid);
    }
  }
  return { targetBranches, targetTags, branchPreservations, tagPreservations };
};

const readRemote = async (gitRoot, name) => tryGit(gitRoot, ['remote', 'get-url', name]);

/**
 * Inspect a project path without treating a plain directory or missing origin
 * as an error. `gitRoot` follows Git's normal behaviour for nested paths.
 */
export const inspectSourceControl = async (
  projectPath,
  { orionHosts = DEFAULT_ORION_GIT_HOSTS } = {}
) => {
  let gitRoot;
  try {
    gitRoot = (await runGit(projectPath, ['rev-parse', '--show-toplevel'])).stdout;
  } catch {
    return {
      isGitRepository: false,
      gitRoot: null,
      originUrl: null,
      origin: classifyRemoteUrl(null, { orionHosts }),
      remotes: [],
      sourceControl: 'none',
      canSwitchToOrion: false,
    };
  }

  const namesOutput = await tryGit(gitRoot, ['remote']);
  const names = namesOutput ? namesOutput.split('\n').filter(Boolean) : [];
  const remotes = [];
  for (const name of names) {
    const url = await readRemote(gitRoot, name);
    if (!url) continue;
    remotes.push({ name, url, ...classifyRemoteUrl(url, { orionHosts }) });
  }
  const originUrl = remotes.find((remote) => remote.name === 'origin')?.url ?? null;
  const origin = classifyRemoteUrl(originUrl, { orionHosts });

  return {
    isGitRepository: true,
    gitRoot,
    originUrl,
    origin,
    remotes,
    sourceControl: origin.kind,
    canSwitchToOrion: origin.kind === 'github',
  };
};

/** Create the deterministic baseline only when no .gitignore exists. */
export const ensureBaselineGitignore = async (gitRoot) => {
  const gitignorePath = path.join(gitRoot, '.gitignore');
  try {
    await fs.writeFile(gitignorePath, BASELINE_GITIGNORE, { encoding: 'utf8', flag: 'wx' });
    return { created: true, path: gitignorePath };
  } catch (error) {
    if (error?.code === 'EEXIST') return { created: false, path: gitignorePath };
    throw error;
  }
};

/** Initialize a plain project on main and return its actual repository root. */
export const ensureGitRepository = async (projectPath, { createGitignore = true } = {}) => {
  const before = await inspectSourceControl(projectPath);
  if (before.isGitRepository) {
    return { gitRoot: before.gitRoot, initialized: false, gitignoreCreated: false };
  }

  await runGit(projectPath, ['init', '-b', 'main']);
  const gitRoot = (await runGit(projectPath, ['rev-parse', '--show-toplevel'])).stdout;
  const gitignore = createGitignore
    ? await ensureBaselineGitignore(gitRoot)
    : { created: false };
  return { gitRoot, initialized: true, gitignoreCreated: gitignore.created };
};

const setRemote = async (gitRoot, name, url) => {
  if (await readRemote(gitRoot, name)) {
    await runGit(gitRoot, ['remote', 'set-url', name, url]);
  } else {
    await runGit(gitRoot, ['remote', 'add', name, url]);
  }
};

/**
 * Make Orion `origin`, retaining an original GitHub origin as the `github`
 * mirror. Metadata is local to this repository and contains no credentials.
 */
export const configureOrionSourceControl = async ({
  gitRoot,
  orionUrl,
  repoId,
  repoName,
  orionHosts = DEFAULT_ORION_GIT_HOSTS,
}) => {
  const orionRemote = classifyRemoteUrl(orionUrl, { orionHosts });
  if (orionRemote.kind !== 'orion') {
    throw new Error('The Durango Cloud repository URL is not hosted by a trusted Durango Git host.');
  }

  const state = await inspectSourceControl(gitRoot, { orionHosts });
  if (!state.isGitRepository) throw new Error('The project is not a Git repository.');
  if (state.origin.kind === 'other') {
    throw new Error('Only a GitHub origin or a project without an origin can switch automatically.');
  }

  let githubUrl = state.origin.kind === 'github'
    ? state.originUrl
    : state.remotes.find((remote) => remote.name === 'github' && remote.kind === 'github')?.url ?? null;
  if (githubUrl) await setRemote(gitRoot, 'github', githubUrl);
  await setRemote(gitRoot, 'origin', orionUrl);

  await runGit(gitRoot, ['config', '--local', 'orion.sourcecontrol', 'orion']);
  if (repoId) await runGit(gitRoot, ['config', '--local', 'orion.cloudrepoid', String(repoId)]);
  if (repoName) await runGit(gitRoot, ['config', '--local', 'orion.cloudreponame', String(repoName)]);
  if (githubUrl) {
    await runGit(gitRoot, ['config', '--local', 'orion.githubMirrorUrl', githubUrl]);
  }

  return {
    gitRoot,
    originUrl: orionUrl,
    githubUrl,
    repoId: repoId ?? null,
    repoName: repoName ?? null,
  };
};

const currentBranch = async (gitRoot) => {
  const branch = await tryGit(gitRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch) return branch;
  const head = await tryGit(gitRoot, ['rev-parse', '--verify', 'HEAD']);
  if (head) throw new Error('Cannot switch source control from a detached HEAD. Check out a branch first.');
  return 'main';
};

/**
 * Provisioning is injected so this pure module has no Electron/session/API
 * dependencies. Expected result: { repo: { id, name }, cloneUrl }.
 */
export const switchSourceControlToOrion = async ({
  projectPath,
  provisionRepo,
  name,
  orionHosts = DEFAULT_ORION_GIT_HOSTS,
}) => {
  if (typeof provisionRepo !== 'function') throw new TypeError('provisionRepo must be a function.');
  const initialized = await ensureGitRepository(projectPath);
  const state = await inspectSourceControl(initialized.gitRoot, { orionHosts });
  if (state.origin.kind === 'other') {
    throw new Error('Only GitHub repositories and projects without an origin can switch to Durango Cloud.');
  }

  const repoName = sanitizeRepositoryName(name || state.origin.repo || path.basename(initialized.gitRoot));
  if (!repoName) throw new Error('Could not determine a valid Durango Cloud repository name.');
  const provisioned = await provisionRepo({
    name: repoName,
    defaultBranch: await currentBranch(initialized.gitRoot),
    gitRoot: initialized.gitRoot,
    github: state.origin.kind === 'github'
      ? { url: state.originUrl, owner: state.origin.owner, repo: state.origin.repo }
      : null,
  });
  const repo = provisioned?.repo ?? provisioned;
  const orionUrl = provisioned?.cloneUrl ?? provisioned?.gitUrl ?? repo?.cloneUrl ?? repo?.gitUrl;
  if (!repo?.id || !orionUrl) {
    throw new Error('Durango Cloud repository provisioning did not return a repository ID and clone URL.');
  }

  const configured = await configureOrionSourceControl({
    gitRoot: initialized.gitRoot,
    orionUrl,
    repoId: repo.id,
    repoName: repo.name ?? repoName,
    orionHosts,
  });
  return { ...configured, ...initialized, repo };
};

const askPassSource = `#!/bin/sh
case "$1" in
  *[Uu]sername*) printf '%s\\n' "$ORION_GIT_USERNAME" ;;
  *) printf '%s\\n' "$ORION_GIT_TOKEN" ;;
esac
`;

/**
 * Provide credentials through a short-lived askpass executable. The token is
 * present only in the child environment: never in a remote URL, Git config,
 * process argument, or the script on disk.
 */
export const withGitAskPass = async (
  { token, username = 'orion', env = process.env, tempRoot = os.tmpdir() },
  operation
) => {
  if (!token) throw new Error('A Durango Git token is required.');
  const tempDir = await fs.mkdtemp(path.join(tempRoot, 'orion-git-auth-'));
  const askPassPath = path.join(tempDir, 'askpass.sh');
  try {
    await fs.writeFile(askPassPath, askPassSource, { encoding: 'utf8', mode: 0o700 });
    const authenticatedEnv = {
      ...env,
      GIT_ASKPASS: askPassPath,
      GIT_ASKPASS_REQUIRE: 'force',
      GIT_TERMINAL_PROMPT: '0',
      ORION_GIT_USERNAME: username,
      ORION_GIT_TOKEN: token,
    };
    return await operation({ env: authenticatedEnv, askPassPath });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

export const runAuthenticatedGit = async ({
  gitRoot,
  args,
  token,
  username = 'orion',
  env,
  signal,
  timeout,
  maxBuffer = MAX_GIT_BUFFER,
  execFileImpl = execFileAsync,
}) => withGitAskPass({ token, username, env }, async ({ env: authenticatedEnv }) => {
  const { stdout = '', stderr = '' } = await execFileImpl(
    'git',
    ['-C', gitRoot, '-c', 'credential.helper=', '-c', 'http.extraHeader=', '-c', 'http.followRedirects=false', ...args],
    { env: authenticatedEnv, maxBuffer, signal, timeout }
  );
  return { stdout: stdout.toString().trim(), stderr: stderr.toString().trim() };
});

const pushRef = (branch) => `refs/heads/${branch}:refs/heads/${branch}`;

export const gitPushWasAlreadyUpToDate = (result) =>
  /(?:everything|already) up[- ]to[- ]date/i.test(
    `${String(result?.stdout ?? '')}\n${String(result?.stderr ?? '')}`
  );

const gitFailureText = (error) =>
  String(error?.stderr?.toString().trim() || error?.message || error || '').trim();

const conciseGitFailureDetail = (error) => {
  const lines = gitFailureText(error)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^hint:/i.test(line) && !/^to\s+/i.test(line));
  const useful = lines.find((line) => /^(?:fatal|error):/i.test(line)) ?? lines[0];
  if (!useful) return 'Git did not provide any more information.';
  return useful.length > 280 ? `${useful.slice(0, 277)}…` : useful;
};

/** Keep raw multi-line Git stderr out of compact renderer toasts. */
export const describeGitPushFailure = (error, { committed = false } = {}) => {
  const text = gitFailureText(error);
  const title = committed ? 'Committed locally, but the push failed' : 'Push failed';

  if (/(?:fetch first|non-fast-forward|rejected.*(?:stale info|remote contains work))/is.test(text)) {
    return {
      error: committed ? 'Committed locally, but the push was rejected' : 'Push rejected',
      errorDetail: 'The remote has newer changes. Pull them, resolve any divergence, then try again.',
    };
  }
  if (error?.status === 503 || /(?:503\b|authentication service temporarily unavailable)/i.test(text)) {
    return { error: title, errorDetail: 'Durango Git is temporarily unavailable. Your local changes are safe; retry shortly.' };
  }
  if (error?.status === 403 || /(?:requires repo:|insufficient.scope|403\b)/i.test(text)) {
    return { error: committed ? 'Committed locally, but permission was denied' : 'Push permission denied', errorDetail: 'Your source-control token lacks permission. For Durango Cloud repositories, check Settings > Access tokens and enable repo:write.' };
  }
  if (error?.status === 401 || error?.needsAuth || /(?:authentication failed|could not read username|access denied|unauthorized)/i.test(text)) {
    return {
      error: title,
      errorDetail: 'The source-control credential was rejected. For Durango Cloud repositories, sign in again to authorize this device; check Settings > Access tokens for revoked or expired tokens.',
    };
  }
  if (/(?:could not resolve host|enotfound|network is unreachable|connection timed out)/i.test(text)) {
    return {
      error: title,
      errorDetail: 'The remote could not be reached. Check your connection and try again.',
    };
  }
  return { error: title, errorDetail: conciseGitFailureDetail(error) };
};

/**
 * Cloud mirroring becomes authoritative only after GitHub has authorized it.
 * Older/unconfigured Orion Web deployments keep the existing Desktop mirror.
 */
export const shouldMirrorGithubLocally = (mirror) => {
  if (!mirror) return true;
  const status = String(mirror.status ?? '').trim().toLowerCase();
  if (
    status === 'authorization_required' ||
    status === 'unconfigured' ||
    status === 'disabled'
  ) return true;
  return mirror.delivery !== 'cloud';
};

/** Push Orion first. A GitHub failure never changes the successful result. */
export const pushSourceControl = async ({
  gitRoot,
  token,
  username = 'orion',
  branch,
  mirrorGithub = true,
  githubToken,
  signal,
}) => {
  const resolvedBranch = branch || await currentBranch(gitRoot);
  const refspec = pushRef(resolvedBranch);
  const originPush = await runAuthenticatedGit({
    gitRoot,
    args: ['push', '--set-upstream', 'origin', refspec],
    token,
    username,
    signal,
  });

  let mirroredToGithub = false;
  let mirrorWarning = null;
  if (mirrorGithub && await readRemote(gitRoot, 'github')) {
    try {
      if (githubToken) {
        await runAuthenticatedGit({
          gitRoot,
          args: ['push', 'github', refspec],
          token: githubToken,
          username: 'x-access-token',
          signal,
        });
      } else {
        await runGit(gitRoot, ['push', 'github', refspec], { signal });
      }
      mirroredToGithub = true;
    } catch (error) {
      if (signal?.aborted) throw error;
      const detail = error?.stderr?.toString().trim() || error?.message || String(error);
      mirrorWarning = `Pushed to Durango Cloud, but the GitHub mirror could not be updated: ${detail}`;
    }
  }

  return {
    ok: true,
    branch: resolvedBranch,
    pushedToOrion: true,
    mirroredToGithub,
    mirrorWarning,
    alreadyUpToDate: gitPushWasAlreadyUpToDate(originPush),
  };
};
