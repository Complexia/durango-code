import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  BASELINE_GITIGNORE,
  classifyRemoteUrl,
  configureOrionSourceControl,
  canReuseLinkedCloudRepo,
  ensureBaselineGitignore,
  ensureGitRepository,
  describeGitPushFailure,
  gitPushWasAlreadyUpToDate,
  inspectSourceControl,
  isEquivalentOrionGitRemote,
  isOrionRepoRemoteUrl,
  parseNamedGitRefs,
  planGithubRefImport,
  pushSourceControl,
  runAuthenticatedGit,
  shouldReconcileDefaultBranch,
  shouldMirrorGithubLocally,
  switchSourceControlToOrion,
  withGitAskPass,
} from '../src/main/source-control.js';
import { readOriginRemote } from '../src/main/git-utils.js';

const execFileAsync = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-source-control-test-'));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const initRepo = async (name) => {
  const repo = path.join(root, name);
  await fs.mkdir(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Orion Test');
  git(repo, 'config', 'user.email', 'orion-test@example.com');
  await fs.writeFile(path.join(repo, 'README.md'), `# ${name}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  return repo;
};
const makeBare = (name) => {
  const target = path.join(root, name);
  execFileSync('git', ['init', '--bare', target]);
  return target;
};

try {
  assert.deepEqual(classifyRemoteUrl(null), {
    kind: 'none', url: null, host: null, owner: null, repo: null,
  });
  assert.deepEqual(
    classifyRemoteUrl('git@github.com:Complexia/orion.git'),
    {
      kind: 'github',
      url: 'git@github.com:Complexia/orion.git',
      host: 'github.com',
      owner: 'Complexia',
      repo: 'orion',
    }
  );
  assert.equal(classifyRemoteUrl('https://github.com/Complexia/orion').kind, 'github');
  assert.equal(classifyRemoteUrl('https://git.orioncode.xyz/complexia/orion.git').kind, 'orion');
  assert.equal(classifyRemoteUrl('https://notgithub.com/Complexia/orion.git').kind, 'other');
  assert.equal(classifyRemoteUrl('/tmp/local.git').kind, 'other');
  assert.equal(isOrionRepoRemoteUrl('https://git.orioncode.xyz/r/repo_123.git', 'repo_123'), true);
  assert.equal(isOrionRepoRemoteUrl('https://attacker.example/r/repo_123.git', 'repo_other'), false);
  console.log('ok  remote URLs classify without fuzzy-host false positives');

  // Durango rebrand: git.durango.sh is canonical, git.orioncode.xyz remotes in
  // existing clones must keep classifying and verifying as Cloud remotes.
  assert.equal(classifyRemoteUrl('https://git.durango.sh/r/repo_123.git').kind, 'orion');
  assert.equal(classifyRemoteUrl('https://git.orioncode.xyz/r/repo_123.git', { orionHosts: ['git.durango.sh'] }).kind, 'orion');
  assert.equal(classifyRemoteUrl('https://git.durango.sh/r/repo_123.git', { orionHosts: ['git.orioncode.xyz'] }).kind, 'orion');
  assert.equal(classifyRemoteUrl('https://git.durango.sh.attacker.example/r/repo_123.git').kind, 'other');
  const advertised = 'https://git.durango.sh/r/repo_123.git';
  assert.equal(isEquivalentOrionGitRemote(advertised, advertised), true);
  assert.equal(isEquivalentOrionGitRemote('https://git.orioncode.xyz/r/repo_123.git', advertised), true);
  assert.equal(isEquivalentOrionGitRemote('https://git.durango.sh/r/repo_123.git', 'https://git.orioncode.xyz/r/repo_123.git'), true);
  assert.equal(isEquivalentOrionGitRemote('https://git.orioncode.xyz/r/repo_999.git', advertised), false);
  assert.equal(isEquivalentOrionGitRemote('http://git.orioncode.xyz/r/repo_123.git', advertised), false);
  assert.equal(isEquivalentOrionGitRemote('https://user:pw@git.orioncode.xyz/r/repo_123.git', advertised), false);
  assert.equal(isEquivalentOrionGitRemote('https://attacker.example/r/repo_123.git', advertised), false);
  assert.equal(isEquivalentOrionGitRemote('https://localhost:4000/r/repo_123.git', 'https://localhost:4000/r/repo_123.git'), true);
  console.log('ok  legacy git.orioncode.xyz remotes stay trusted next to git.durango.sh');

  const markerOnlyRepo = await initRepo('marker-only');
  git(markerOnlyRepo, 'remote', 'add', 'origin', 'https://attacker.example/collect.git');
  git(markerOnlyRepo, 'config', '--local', 'orion.sourcecontrol', 'orion');
  git(markerOnlyRepo, 'config', '--local', 'orion.cloudrepoid', 'repo_123');
  assert.equal((await readOriginRemote(markerOnlyRepo)).provider, 'other');
  console.log('ok  an Orion marker alone never routes authenticated Git');

  assert.deepEqual(
    parseNamedGitRefs({
      stdout: [
        `refs/remotes/origin/HEAD\t${'a'.repeat(40)}`,
        `refs/remotes/origin/main\t${'b'.repeat(40)}`,
        `refs/remotes/origin/feature/x\t${'c'.repeat(40)}`,
      ].join('\n'),
      namespace: 'refs/remotes/origin',
      field: 'branch',
    }),
    [
      { branch: 'HEAD', oid: 'a'.repeat(40) },
      { branch: 'main', oid: 'b'.repeat(40) },
      { branch: 'feature/x', oid: 'c'.repeat(40) },
    ]
  );
  assert.equal(
    canReuseLinkedCloudRepo({
      repo: { id: 'canonical', name: 'orion-web' },
      expectedName: 'orion-web',
    }),
    true
  );
  assert.equal(
    canReuseLinkedCloudRepo({
      repo: { id: 'duplicate', name: 'orion-web-orion' },
      expectedName: 'orion-web',
    }),
    false
  );
  console.log('ok  conversion reuses the canonical link without importing remote namespaces');

  const plain = path.join(root, 'plain');
  await fs.mkdir(plain);
  const plainState = await inspectSourceControl(plain);
  assert.equal(plainState.isGitRepository, false);
  assert.equal(plainState.sourceControl, 'none');
  const initialized = await ensureGitRepository(plain);
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.gitignoreCreated, true);
  assert.equal(git(plain, 'branch', '--show-current'), 'main');
  assert.equal(await fs.readFile(path.join(plain, '.gitignore'), 'utf8'), BASELINE_GITIGNORE);
  const secondInit = await ensureGitRepository(plain);
  assert.equal(secondInit.initialized, false);
  assert.equal(secondInit.gitignoreCreated, false);
  console.log('ok  plain projects initialize on main with a deterministic baseline');

  const customIgnore = path.join(root, 'custom-ignore');
  await fs.mkdir(customIgnore);
  git(customIgnore, 'init', '-b', 'main');
  await fs.writeFile(path.join(customIgnore, '.gitignore'), 'mine-only\n');
  const ignoreResult = await ensureBaselineGitignore(customIgnore);
  assert.equal(ignoreResult.created, false);
  assert.equal(await fs.readFile(path.join(customIgnore, '.gitignore'), 'utf8'), 'mine-only\n');
  console.log('ok  an existing .gitignore is never overwritten');

  const githubRepo = await initRepo('github-source');
  const githubUrl = 'git@github.com:Complexia/github-source.git';
  git(githubRepo, 'remote', 'add', 'origin', githubUrl);
  const githubState = await inspectSourceControl(githubRepo);
  assert.equal(githubState.canSwitchToOrion, true);
  assert.equal(githubState.origin.repo, 'github-source');
  await configureOrionSourceControl({
    gitRoot: githubRepo,
    orionUrl: 'https://git.orioncode.xyz/complexia/github-source.git',
    repoId: 'repo_123',
    repoName: 'github-source',
  });
  assert.equal(git(githubRepo, 'remote', 'get-url', 'github'), githubUrl);
  assert.equal(
    git(githubRepo, 'remote', 'get-url', 'origin'),
    'https://git.orioncode.xyz/complexia/github-source.git'
  );
  assert.equal(git(githubRepo, 'config', '--local', 'orion.sourcecontrol'), 'orion');
  assert.equal(git(githubRepo, 'config', '--local', 'orion.cloudrepoid'), 'repo_123');
  assert.equal(git(githubRepo, 'config', '--local', 'orion.githubMirrorUrl'), githubUrl);
  console.log('ok  switching remotes preserves GitHub as the mirror and stores Orion metadata');

  const provisionProject = path.join(root, 'provision-project');
  await fs.mkdir(provisionProject);
  let provisionInput;
  const switched = await switchSourceControlToOrion({
    projectPath: provisionProject,
    provisionRepo: async (input) => {
      provisionInput = input;
      return {
        repo: { id: 'repo_new', name: input.name },
        cloneUrl: `https://git.orioncode.xyz/test/${input.name}.git`,
      };
    },
  });
  assert.equal(provisionInput.defaultBranch, 'main');
  assert.equal(provisionInput.github, null);
  assert.equal(switched.initialized, true);
  assert.equal(git(provisionProject, 'remote', 'get-url', 'origin'), switched.originUrl);
  console.log('ok  provisioning is injectable for new projects without Git or an origin');

  assert.equal(
    shouldReconcileDefaultBranch({
      repo: { id: 'repo_existing', defaultBranch: 'grok-attempt-2' },
      authoritativeDefaultBranch: 'main',
    }),
    true
  );
  assert.equal(
    shouldReconcileDefaultBranch({
      repo: { id: 'repo_existing', defaultBranch: 'main' },
      authoritativeDefaultBranch: 'main',
    }),
    false
  );
  console.log('ok  reused cloud repositories reconcile to the authoritative default branch');

  const detachedRepo = await initRepo('detached-source');
  const detachedGithubUrl = 'https://github.com/Complexia/detached-source.git';
  git(detachedRepo, 'remote', 'add', 'origin', detachedGithubUrl);
  git(detachedRepo, 'checkout', '--detach');
  let detachedProvisioned = false;
  await assert.rejects(
    switchSourceControlToOrion({
      projectPath: detachedRepo,
      provisionRepo: async () => {
        detachedProvisioned = true;
        return { repo: { id: 'never' }, cloneUrl: 'https://git.orioncode.xyz/r/never.git' };
      },
    }),
    /detached HEAD/i
  );
  assert.equal(detachedProvisioned, false);
  assert.equal(git(detachedRepo, 'remote', 'get-url', 'origin'), detachedGithubUrl);
  console.log('ok  detached repositories fail before provisioning or remote mutation');

  const refPlan = planGithubRefImport({
    localBranches: [
      { branch: 'main', oid: 'local-main' },
      { branch: 'local-only', oid: 'local-only-oid' },
    ],
    githubBranches: [
      { branch: 'main', oid: 'github-main' },
      { branch: 'orion-local/main', oid: 'occupied-prefix' },
    ],
    localTags: [{ tag: 'v1', oid: 'local-tag' }],
    githubTags: [{ tag: 'v1', oid: 'github-tag' }],
  });
  assert.equal(refPlan.targetBranches.get('main'), 'github-main');
  assert.equal(refPlan.targetBranches.get('local-only'), 'local-only-oid');
  assert.equal(refPlan.branchPreservations[0].preserved, 'orion-local/main-2');
  assert.equal(refPlan.targetBranches.get('orion-local/main-2'), 'local-main');
  assert.equal(refPlan.targetTags.get('v1'), 'github-tag');
  assert.equal(refPlan.targetTags.get('orion-local/v1'), 'local-tag');
  console.log('ok  conflicting local refs are preserved while GitHub keeps canonical names');

  const tagImportRepo = await initRepo('tag-import-source');
  const tagImportBare = makeBare('tag-import-github.git');
  git(tagImportRepo, 'remote', 'add', 'origin', tagImportBare);
  git(tagImportRepo, 'tag', 'shared-tag');
  git(tagImportRepo, 'push', 'origin', 'main', '--tags');
  const githubTagOid = git(tagImportRepo, 'rev-parse', 'shared-tag');
  await fs.writeFile(path.join(tagImportRepo, 'local-tag-change.txt'), 'local\n');
  git(tagImportRepo, 'add', '.');
  git(tagImportRepo, 'commit', '-m', 'local tag change');
  git(tagImportRepo, 'tag', '-f', 'shared-tag');
  const localTagOid = git(tagImportRepo, 'rev-parse', 'shared-tag');
  assert.notEqual(localTagOid, githubTagOid);
  git(
    tagImportRepo,
    'fetch',
    '--prune',
    'origin',
    '+refs/heads/*:refs/remotes/origin/*',
    '+refs/tags/*:refs/orion-import/github-tags/*'
  );
  assert.equal(git(tagImportRepo, 'rev-parse', 'shared-tag'), localTagOid);
  assert.equal(
    git(tagImportRepo, 'rev-parse', 'refs/orion-import/github-tags/shared-tag'),
    githubTagOid
  );
  console.log('ok  GitHub tags import through temporary refs without rewriting local tags');

  const secret = 'token-that-must-not-touch-disk';
  let askPassPath;
  await withGitAskPass({ token: secret }, async ({ env, askPassPath: candidate }) => {
    askPassPath = candidate;
    const source = await fs.readFile(candidate, 'utf8');
    assert.doesNotMatch(source, new RegExp(secret));
    assert.equal(env.ORION_GIT_TOKEN, secret);
    assert.equal((await execFileAsync(candidate, ['Username for Orion'], { env })).stdout.trim(), 'orion');
    assert.equal((await execFileAsync(candidate, ['Password for Orion'], { env })).stdout.trim(), secret);
  });
  await assert.rejects(fs.access(askPassPath));

  let observedInvocation;
  const authAbort = new AbortController();
  await runAuthenticatedGit({
    gitRoot: githubRepo,
    args: ['status', '--short'],
    token: secret,
    signal: authAbort.signal,
    execFileImpl: async (command, args, options) => {
      observedInvocation = { command, args, options };
      return { stdout: '', stderr: '' };
    },
  });
  assert.equal(observedInvocation.command, 'git');
  assert.equal(observedInvocation.args.includes(secret), false);
  assert.equal(JSON.stringify(observedInvocation.options).includes(secret), true);
  assert.equal(observedInvocation.options.signal, authAbort.signal);
  const credentialConfig = await execFileAsync(
    'git',
    ['-C', githubRepo, 'config', '--local', '--get-regexp', 'credential|token']
  ).then(({ stdout }) => stdout.trim(), () => '');
  assert.equal(credentialConfig, '');
  console.log('ok  authenticated Git uses transient askpass state without token arguments or config');

  const pushRepo = await initRepo('push-source');
  const orionBare = makeBare('orion.git');
  const githubBare = makeBare('github.git');
  const publicOrionUrl = 'https://git.orioncode.xyz/test/push-source.git';
  git(pushRepo, 'config', `url.file://${orionBare}.insteadOf`, publicOrionUrl);
  git(pushRepo, 'remote', 'add', 'origin', publicOrionUrl);
  git(pushRepo, 'remote', 'add', 'github', githubBare);
  const pushed = await pushSourceControl({ gitRoot: pushRepo, token: 'local-test-token' });
  assert.equal(pushed.ok, true);
  assert.equal(pushed.alreadyUpToDate, false);
  assert.equal(pushed.mirroredToGithub, true);
  assert.equal(pushed.mirrorWarning, null);
  assert.equal(git(orionBare, 'rev-parse', 'refs/heads/main'), git(pushRepo, 'rev-parse', 'HEAD'));
  assert.equal(git(githubBare, 'rev-parse', 'refs/heads/main'), git(pushRepo, 'rev-parse', 'HEAD'));
  console.log('ok  pushes update Orion first and then the GitHub mirror');

  const noOpPush = await pushSourceControl({ gitRoot: pushRepo, token: 'local-test-token' });
  assert.equal(noOpPush.ok, true);
  assert.equal(noOpPush.alreadyUpToDate, true);
  assert.equal(gitPushWasAlreadyUpToDate({ stderr: 'Everything up-to-date' }), true);
  assert.equal(gitPushWasAlreadyUpToDate({ stderr: 'main -> main' }), false);
  assert.deepEqual(
    describeGitPushFailure(
      { stderr: '! [rejected] main -> main (fetch first)\nerror: failed to push some refs\nhint: pull first' },
      { committed: true }
    ),
    {
      error: 'Committed locally, but the push was rejected',
      errorDetail: 'The remote has newer changes. Pull them, resolve any divergence, then try again.',
    }
  );
  console.log('ok  push outcomes distinguish successful no-ops and concise rejection guidance');

  assert.equal(shouldMirrorGithubLocally(null), true);
  assert.equal(shouldMirrorGithubLocally({ delivery: 'desktop', status: 'active' }), true);
  assert.equal(
    shouldMirrorGithubLocally({ delivery: 'cloud', status: 'authorization_required' }),
    true
  );
  assert.equal(shouldMirrorGithubLocally({ delivery: 'cloud', status: 'unconfigured' }), true);
  assert.equal(shouldMirrorGithubLocally({ delivery: 'cloud', status: 'disabled' }), true);
  assert.equal(shouldMirrorGithubLocally({ delivery: 'cloud', status: 'active' }), false);
  assert.equal(shouldMirrorGithubLocally({ delivery: 'cloud', status: 'queued' }), false);
  assert.equal(shouldMirrorGithubLocally({ delivery: 'cloud', status: 'syncing' }), false);
  assert.equal(shouldMirrorGithubLocally({ delivery: 'cloud', status: 'disabling' }), false);
  assert.equal(
    shouldMirrorGithubLocally({ delivery: 'cloud', status: 'reconnect_required' }),
    false
  );
  assert.equal(shouldMirrorGithubLocally({ delivery: 'cloud', status: 'error' }), false);
  console.log('ok  Cloud mirror ownership disables Desktop delivery only after authorization');

  await fs.writeFile(path.join(pushRepo, 'cloud-owned.txt'), 'cloud-owned\n');
  git(pushRepo, 'add', '.');
  git(pushRepo, 'commit', '-m', 'cloud owned mirror');
  const githubOidBeforeCloudPush = git(githubBare, 'rev-parse', 'refs/heads/main');
  const cloudOwnedPush = await pushSourceControl({
    gitRoot: pushRepo,
    token: 'local-test-token',
    mirrorGithub: false,
  });
  assert.equal(cloudOwnedPush.mirroredToGithub, false);
  assert.equal(cloudOwnedPush.mirrorWarning, null);
  assert.equal(git(orionBare, 'rev-parse', 'refs/heads/main'), git(pushRepo, 'rev-parse', 'HEAD'));
  assert.equal(git(githubBare, 'rev-parse', 'refs/heads/main'), githubOidBeforeCloudPush);
  console.log('ok  a Cloud-owned mirror pushes only to Orion');

  git(pushRepo, 'push', 'github', 'refs/heads/main:refs/heads/main');

  const beforeAbortOid = git(pushRepo, 'rev-parse', 'HEAD');
  await fs.writeFile(path.join(pushRepo, 'abort.txt'), 'abort\n');
  git(pushRepo, 'add', '.');
  git(pushRepo, 'commit', '-m', 'abortable');
  const pushAbort = new AbortController();
  pushAbort.abort();
  await assert.rejects(
    pushSourceControl({ gitRoot: pushRepo, token: 'local-test-token', signal: pushAbort.signal }),
    { name: 'AbortError' }
  );
  assert.equal(git(orionBare, 'rev-parse', 'refs/heads/main'), beforeAbortOid);
  assert.equal(git(githubBare, 'rev-parse', 'refs/heads/main'), beforeAbortOid);
  await pushSourceControl({ gitRoot: pushRepo, token: 'local-test-token' });
  console.log('ok  push cancellation reaches Git before either remote is updated');

  await fs.writeFile(path.join(pushRepo, 'next.txt'), 'next\n');
  git(pushRepo, 'add', '.');
  git(pushRepo, 'commit', '-m', 'next');
  git(pushRepo, 'remote', 'set-url', 'github', path.join(root, 'missing', 'github.git'));
  const mirrorFailure = await pushSourceControl({ gitRoot: pushRepo, token: 'local-test-token' });
  assert.equal(mirrorFailure.ok, true);
  assert.equal(mirrorFailure.mirroredToGithub, false);
  assert.match(mirrorFailure.mirrorWarning, /Pushed to Durango Cloud.*GitHub mirror/i);
  assert.equal(git(orionBare, 'rev-parse', 'refs/heads/main'), git(pushRepo, 'rev-parse', 'HEAD'));
  console.log('ok  a mirror failure returns a warning after the Orion push succeeds');

  const [mainSource, preloadSource, appSource, cloudSyncSource] = await Promise.all([
    fs.readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/preload.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/cloud-sync.js', import.meta.url), 'utf8'),
  ]);
  assert.match(mainSource, /git:changeSourceControlToOrion/);
  assert.match(mainSource, /\/api\/git\/repos\/\$\{encodeURIComponent\(link\.repoId\)\}\/pulls/);
  assert.match(mainSource, /pushBranchToSourceControl/);
  assert.match(mainSource, /githubOwner: state\.origin\.owner/);
  assert.match(mainSource, /githubName: state\.origin\.repo/);
  assert.match(mainSource, /resolveGithubMirrorDelivery/);
  assert.match(mainSource, /verifyOrionGitRemote/);
  assert.match(mainSource, /!isEquivalentOrionGitRemote\(actual, expected\)/);
  assert.match(mainSource, /!isEquivalentOrionGitRemote\(pushDestinations\[0\], expected\)/);
  assert.match(mainSource, /const legacyFallback = error\?\.status === 404 && persistedDelivery !== 'cloud'/);
  assert.match(mainSource, /args: \['push', '--atomic', cloneUrl, \.\.\.refspecs\]/);
  assert.match(mainSource, /git:authorizeGithubMirror/);
  const conversionSource = mainSource.slice(mainSource.indexOf('const convertGithubSourceControl'));
  assert.match(conversionSource, /\+refs\/heads\/\*:refs\/remotes\/origin\/\*/);
  assert.match(conversionSource, /\+refs\/tags\/\*:refs\/orion-import\/github-tags\/\*/);
  assert.match(conversionSource, /planGithubRefImport/);
  assert.match(conversionSource, /shouldReconcileDefaultBranch/);
  assert.ok(
    conversionSource.indexOf("args: ['push', '--atomic', cloneUrl, ...refspecs]") <
      conversionSource.indexOf("body: { defaultBranch: githubDefaultBranch }"),
    'default-branch reconciliation must happen after the authoritative branch is imported'
  );
  assert.match(conversionSource, /clearGithubImportTagRefs/);
  assert.ok(
    conversionSource.indexOf("args: ['push', '--atomic', cloneUrl, ...refspecs]") <
      conversionSource.indexOf('/github-mirror'),
    'conversion must seed Orion before configuring the continuous mirror'
  );
  assert.match(preloadSource, /changeSourceControlToOrion/);
  assert.match(preloadSource, /authorizeGithubMirror/);
  // Navbar entry points are intentionally hidden; retain the underlying IPC
  // and handlers so moving these actions elsewhere doesn't remove support.
  assert.match(appSource, /const handleChangeSourceControlToOrion = async/);
  assert.match(appSource, /window\.orion\.changeSourceControlToOrion\(\{ projectPath: activeWorkingDir \}\)/);
  assert.match(appSource, /Authorize GitHub/);
  assert.match(appSource, /handleAuthorizeGithubMirror/);
  assert.match(cloudSyncSource, /mirror: state\.mirror/);
  console.log('ok  desktop IPC, provider-aware PRs, and retained cloud handlers stay wired');

  console.log('\nAll source-control tests passed.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
