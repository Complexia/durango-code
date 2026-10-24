// Git and GitHub Actions steps of a release started on a Mac: the Windows and
// Linux builds run in .github/workflows/release.yml for the pushed version
// tag, so the tag must point at exactly the source the Mac builds.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { productName, releaseTag } from './release-manifest.mjs';

export const ciWorkflowFile = 'release.yml';

function tryCapture(cwd, command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  // Trailing whitespace only: `git status --porcelain` lines start with a
  // significant space.
  return result.status === 0 ? result.stdout.trimEnd() : null;
}

function capture(cwd, command, commandArgs) {
  const output = tryCapture(cwd, command, commandArgs);
  if (output === null) throw new Error(`${command} ${commandArgs.join(' ')} failed`);
  return output;
}

function run(cwd, command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${result.status}`);
  }
}

// Uncommitted or untracked files would ship on macOS only, so refuse to
// start. The exception is the version field the deploy script writes itself;
// CI applies the same version from the tag.
export function assertReleaseSourceCommitted(rootDir) {
  const stripVersion = {
    'package.json': (json) => {
      delete json.version;
    },
    'package-lock.json': (json) => {
      delete json.version;
      if (json.packages?.['']) delete json.packages[''].version;
    },
  };
  const unexpected = capture(rootDir, 'git', ['status', '--porcelain', '--untracked-files=all'])
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2), file: line.slice(3) }))
    .filter(({ status, file }) => {
      if (!stripVersion[file] || !/^[ M]{2}$/.test(status)) return true;
      const committed = JSON.parse(capture(rootDir, 'git', ['show', `HEAD:${file}`]));
      const working = JSON.parse(readFileSync(path.join(rootDir, file), 'utf8'));
      stripVersion[file](committed);
      stripVersion[file](working);
      return JSON.stringify(committed) !== JSON.stringify(working);
    });

  if (unexpected.length > 0) {
    throw new Error(
      'Commit or stash these changes before releasing; Windows and Linux are built from the committed source:\n'
      + unexpected.map(({ status, file }) => `  ${status} ${file}`).join('\n')
      + '\nPass --no-ci to build and publish macOS only.',
    );
  }
}

function remoteTagCommit(rootDir, tag) {
  const refs = capture(rootDir, 'git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
  // Annotated tags list the tag object plus the commit it peels to.
  const commit = refs.find(([, ref]) => ref === `refs/tags/${tag}^{}`) ?? refs.find(([, ref]) => ref === `refs/tags/${tag}`);
  return commit?.[0] ?? null;
}

// Tags HEAD as v<version> and pushes it, which starts the CI workflow. A tag
// already on origin at HEAD (a re-run, or the second macOS arch) is left alone.
export function pushReleaseTag(rootDir, version) {
  const tag = releaseTag(version);
  const head = capture(rootDir, 'git', ['rev-parse', 'HEAD']);
  const localTag = tryCapture(rootDir, 'git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
  if (localTag && localTag !== head) {
    throw new Error(`Tag ${tag} already points at ${localTag.slice(0, 12)}, not HEAD (${head.slice(0, 12)}). Release a new version, or pass --no-ci.`);
  }
  const remoteTag = remoteTagCommit(rootDir, tag);
  if (remoteTag && remoteTag !== head) {
    throw new Error(`Tag ${tag} on origin points at ${remoteTag.slice(0, 12)}, not HEAD (${head.slice(0, 12)}). Release a new version, or pass --no-ci.`);
  }

  if (!localTag) run(rootDir, 'git', ['tag', '-a', tag, '-m', `${productName} ${version}`]);
  if (remoteTag) {
    console.log(`${tag} is already on origin; its Windows and Linux builds started when it was first pushed.`);
    return { tag, pushed: false };
  }
  run(rootDir, 'git', ['push', 'origin', `refs/tags/${tag}`]);
  console.log(`Pushed ${tag}; GitHub Actions is building Windows and Linux: ${ciWorkflowUrl(rootDir)}`);
  return { tag, pushed: true };
}

export function ciWorkflowUrl(rootDir) {
  const origin = tryCapture(rootDir, 'git', ['remote', 'get-url', 'origin']) ?? '';
  const slug = origin.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1];
  return slug ? `https://github.com/${slug}/actions/workflows/${ciWorkflowFile}` : `the ${ciWorkflowFile} workflow on GitHub`;
}

// Waits for the tag's Windows and Linux builds so one command reports the
// whole release.
export async function watchCiRelease(rootDir, { tag }) {
  if (tryCapture(rootDir, 'gh', ['--version']) === null) {
    console.log(`Install the GitHub CLI (gh) to follow the Windows and Linux builds from here. Until then see ${ciWorkflowUrl(rootDir)}`);
    return;
  }

  let runId = null;
  for (let attempt = 0; attempt < 20 && !runId; attempt += 1) {
    const runs = tryCapture(rootDir, 'gh', ['run', 'list', '--workflow', ciWorkflowFile, '--branch', tag, '--limit', '1', '--json', 'databaseId']);
    runId = runs ? JSON.parse(runs)[0]?.databaseId ?? null : null;
    if (!runId) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (!runId) {
    throw new Error(`Could not find the GitHub Actions run for ${tag}; check ${ciWorkflowUrl(rootDir)}`);
  }

  console.log(`Waiting for the Windows and Linux builds of ${tag}`);
  const watched = spawnSync('gh', ['run', 'watch', String(runId), '--exit-status', '--compact', '--interval', '30'], {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (watched.status !== 0) {
    throw new Error(`The Windows/Linux build of ${tag} failed; macOS is already published. Inspect it with: gh run view ${runId} --log-failed`);
  }
  console.log(`Windows and Linux builds of ${tag} published`);
}
