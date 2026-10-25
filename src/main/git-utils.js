import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFileAsync } from './shell-env.js';
import { classifyRemoteUrl, isOrionRepoRemoteUrl } from './source-control.js';

export const getGitStatusKind = (rawStatus) => {
  if (rawStatus === '??') return 'untracked';
  if (rawStatus.includes('U')) return 'conflicted';
  if (rawStatus.includes('D')) return 'deleted';
  if (rawStatus.includes('R')) return 'renamed';
  if (rawStatus.includes('C')) return 'copied';
  if (rawStatus.includes('A')) return 'added';
  if (rawStatus.includes('M')) return 'modified';
  return null;
};

export const normalizeGitPath = (value) => value.replace(/^"|"$/g, '').replace(/\\/g, '/');

export const getGitRoot = async (dirPath) => {
  const { stdout } = await execFileAsync('git', [
    '-C',
    dirPath,
    'rev-parse',
    '--show-toplevel',
  ]);
  return stdout.trim();
};

export const parseGitStatusOutput = (stdout, gitRoot) => {
  const entries = [];

  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const rawStatus = line.slice(0, 2);
    const kind = getGitStatusKind(rawStatus);
    if (!kind) continue;

    const rawPath = line.slice(3);
    const relativePath = normalizeGitPath(
      rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath
    );

    entries.push({
      kind,
      relativePath,
      fullPath: path.resolve(gitRoot, relativePath),
    });
  }

  return entries;
};

export const readGitStatusEntries = async (gitRoot) => {
  const { stdout } = await execFileAsync('git', [
    '-C',
    gitRoot,
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);

  return parseGitStatusOutput(stdout, gitRoot);
};

export const getFileSignature = async (filePath) => {
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      return `dir:${stat.mtimeMs}`;
    }

    const content = await fs.readFile(filePath);
    const hash = crypto.createHash('sha1').update(content).digest('hex');
    return `file:${stat.size}:${hash}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    return 'unknown';
  }
};

export const captureGitChangeSnapshot = async (dirPath) => {
  try {
    const gitRoot = await getGitRoot(dirPath);
    const entries = await readGitStatusEntries(gitRoot);
    const signatures = new Map();

    await Promise.all(
      entries.map(async (entry) => {
        signatures.set(entry.relativePath, await getFileSignature(entry.fullPath));
      })
    );

    return { gitRoot, signatures };
  } catch {
    return null;
  }
};

export const hasGitHead = async (gitRoot) => {
  try {
    await execFileAsync('git', ['-C', gitRoot, 'rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
};

export const getLineCount = async (filePath) => {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    if (content.length === 0) return 0;
    const lines = content.split(/\r\n|\r|\n/).length;
    return /\r\n$|\r$|\n$/.test(content) ? lines - 1 : lines;
  } catch {
    return 0;
  }
};

export const readNumstatMap = async (gitRoot) => {
  const numstat = new Map();

  if (!(await hasGitHead(gitRoot))) {
    return numstat;
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', gitRoot, 'diff', '--numstat', 'HEAD']);
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [rawAdditions, rawDeletions, ...pathParts] = line.split('\t');
      const rawPath = pathParts.join('\t');
      const relativePath = normalizeGitPath(
        rawPath.includes(' => ') ? rawPath.split(' => ').pop().replace(/[{}]/g, '') : rawPath
      );
      numstat.set(relativePath, {
        additions: Number.parseInt(rawAdditions, 10) || 0,
        deletions: Number.parseInt(rawDeletions, 10) || 0,
      });
    }
  } catch {}

  return numstat;
};

// Content versions already reported by a finished run: gitRoot ->
// (relativePath -> signature). Concurrent turns in the same workspace (threads
// sharing a Durango workspace) each diff the working tree against their own
// turn-start snapshot, so one agent's save lands inside every overlapping
// turn's window and would show up in each of their summaries. The first run
// to finalize claims that content version; later runs skip it unless they
// wrote the file themselves (`toolWrittenPaths`).
const attributedSignatures = new Map();

export const summarizeChangedFiles = async (dirPath, beforeSnapshot, { toolWrittenPaths } = {}) => {
  try {
    const gitRoot = beforeSnapshot?.gitRoot ?? (await getGitRoot(dirPath));
    const [entries, numstat] = await Promise.all([readGitStatusEntries(gitRoot), readNumstatMap(gitRoot)]);
    const claimed = attributedSignatures.get(gitRoot);
    const nextClaimed = new Map();
    // git reports the physical toplevel while tool inputs may spell the same
    // file through a symlink (e.g. /tmp vs /private/tmp) — index both forms.
    let writtenPaths = null;
    if (toolWrittenPaths?.size) {
      writtenPaths = new Set();
      for (const writtenPath of toolWrittenPaths) {
        writtenPaths.add(writtenPath);
        try {
          writtenPaths.add(await fs.realpath(writtenPath));
        } catch {}
      }
    }
    const summaries = [];

    for (const entry of entries) {
      const signature = await getFileSignature(entry.fullPath);
      const priorClaim = claimed?.get(entry.relativePath);
      if (beforeSnapshot?.signatures.get(entry.relativePath) === signature) {
        if (priorClaim !== undefined) nextClaimed.set(entry.relativePath, priorClaim);
        continue;
      }

      const wroteItself = writtenPaths?.has(entry.fullPath) === true;
      if (!wroteItself && priorClaim === signature) {
        nextClaimed.set(entry.relativePath, signature);
        continue;
      }
      nextClaimed.set(entry.relativePath, signature);

      let counts = numstat.get(entry.relativePath);
      if (!counts && (entry.kind === 'added' || entry.kind === 'untracked')) {
        counts = {
          additions: await getLineCount(entry.fullPath),
          deletions: 0,
        };
      }

      summaries.push({
        path: entry.relativePath,
        status: entry.kind,
        additions: counts?.additions ?? 0,
        deletions: counts?.deletions ?? 0,
      });
    }

    attributedSignatures.set(gitRoot, nextClaimed);
    summaries.sort((a, b) => a.path.localeCompare(b.path));
    return summaries;
  } catch {
    return [];
  }
};

export const gitStatusLabels = {
  added: 'A',
  copied: 'C',
  conflicted: '!',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  untracked: 'U',
};

export const gitStatusRank = {
  conflicted: 0,
  deleted: 1,
  modified: 2,
  added: 3,
  renamed: 4,
  copied: 5,
  untracked: 6,
};

export const buildGitStatusMaps = (entries, gitRoot) => {
  const directStatuses = new Map();
  const aggregateStatuses = new Map();

  for (const entry of entries) {
    const status = {
      kind: entry.kind,
      label: gitStatusLabels[entry.kind],
    };

    directStatuses.set(entry.fullPath, status);

    let ancestor = path.dirname(entry.fullPath);
    while (ancestor.startsWith(gitRoot) && ancestor !== gitRoot) {
      const existing = aggregateStatuses.get(ancestor);
      if (!existing || gitStatusRank[entry.kind] < gitStatusRank[existing.kind]) {
        aggregateStatuses.set(ancestor, status);
      }
      ancestor = path.dirname(ancestor);
    }
  }

  return { directStatuses, aggregateStatuses };
};

// A tree refresh fans one fs:readDirectory out per expanded folder, and each
// call needs the same repo-wide status. Without sharing, one agent completion
// launches dozens of full `git status --untracked-files=all` scans. Both maps
// depend only on the git root, so concurrent and near-in-time callers share a
// single scan. A refresh burst lands within one render tick, so the TTL
// stays short; keeping it under the renderer's 300ms post-turn debounce
// guarantees the refresh after a completed turn never reuses a scan taken
// before the agent's final writes, and re-resolves the git root so an agent
// creating or removing a nested repo is honored on that same refresh (the
// rev-parse is trivial next to the status scan). The cache is deliberately
// local to the tree path — change-snapshot and diff logic keep their
// uncached reads.
export const GIT_TREE_CACHE_TTL_MS = 250;
export const treeGitRootCache = new Map(); // dirPath → { at, promise }
export const treeGitStatusCache = new Map(); // gitRoot → { at, settled, promise }

// Explorer-driven mutations (save, create, delete, rename) reload the tree
// immediately — inside the TTL — so a surviving pre-mutation scan would pin
// stale badges until some later refresh. Agent-driven writes don't need this:
// their refresh is debounced past the TTL.
export const invalidateTreeGitStatusCache = () => {
  treeGitStatusCache.clear();
};

export const getGitStatusMap = async (dirPath) => {
  try {
    const now = Date.now();
    let root = treeGitRootCache.get(dirPath);
    if (!root || now - root.at >= GIT_TREE_CACHE_TTL_MS) {
      root = { at: now, promise: getGitRoot(dirPath) };
      root.promise.catch(() => {
        if (treeGitRootCache.get(dirPath) === root) treeGitRootCache.delete(dirPath);
      });
      treeGitRootCache.set(dirPath, root);
    }
    const gitRoot = await root.promise;

    let status = treeGitStatusCache.get(gitRoot);
    if (!status || now - status.at >= GIT_TREE_CACHE_TTL_MS) {
      // In a repo whose scan outlives the TTL, an expired-but-pending entry
      // must not spawn a concurrent duplicate — that recreates the fan-out
      // this cache exists to prevent. Chain the fresh scan behind it instead:
      // it starts after the in-flight one finishes (still after this caller
      // arrived, preserving post-write freshness) and is shared by every
      // caller that found the old entry expired.
      const inFlight = status && !status.settled ? status.promise : null;
      const scan = () =>
        readGitStatusEntries(gitRoot).then((entries) => buildGitStatusMaps(entries, gitRoot));
      const entry = { at: now, settled: false, promise: null };
      entry.promise = inFlight ? inFlight.then(scan, scan) : scan();
      entry.promise.then(
        () => {
          entry.settled = true;
        },
        () => {
          entry.settled = true;
          if (treeGitStatusCache.get(gitRoot) === entry) treeGitStatusCache.delete(gitRoot);
        }
      );
      treeGitStatusCache.set(gitRoot, entry);
      status = entry;
    }
    return await status.promise;
  } catch {
    return { directStatuses: new Map(), aggregateStatuses: new Map() };
  }
};

export const commandSucceeds = async (command, args) => {
  try {
    await execFileAsync(command, args);
    return true;
  } catch {
    return false;
  }
};

export const getCurrentGitBranch = async (gitRoot) => {
  const { stdout } = await execFileAsync('git', ['-C', gitRoot, 'branch', '--show-current']);
  const branch = stdout.trim();
  return branch || null;
};

const getDetachedGitHead = async (gitRoot) => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', gitRoot, 'rev-parse', '--short', 'HEAD']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

export const readGitBranches = async (gitRoot, currentBranch) => {
  const { stdout } = await execFileAsync('git', [
    '-C',
    gitRoot,
    'for-each-ref',
    '--format=%(refname:short)\t%(upstream:short)',
    'refs/heads',
  ]);

  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, upstream] = line.split('\t');
      return {
        name,
        current: name === currentBranch,
        hasUpstream: Boolean(upstream),
      };
    })
    .sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
};

export const readGitAheadBehind = async (gitRoot) => {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      gitRoot,
      'rev-list',
      '--left-right',
      '--count',
      '@{u}...HEAD',
    ]);
    const [behind, ahead] = stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10) || 0);
    return { ahead, behind };
  } catch {
    return { ahead: 0, behind: 0 };
  }
};

export const sourceProviderForRemoteUrl = (remoteUrl) => classifyRemoteUrl(remoteUrl).kind;

export const readOriginRemote = async (gitRoot) => {
  try {
    const { stdout } = await execFileAsync('git', ['-C', gitRoot, 'remote', 'get-url', 'origin']);
    const url = stdout.trim();
    let provider = sourceProviderForRemoteUrl(url);
    try {
      const [{ stdout: configured }, { stdout: repoId }] = await Promise.all([
        execFileAsync('git', ['-C', gitRoot, 'config', '--local', 'orion.sourcecontrol']),
        execFileAsync('git', ['-C', gitRoot, 'config', '--local', 'orion.cloudrepoid']),
      ]);
      if (configured.trim() === 'orion' && isOrionRepoRemoteUrl(url, repoId.trim())) {
        provider = 'orion';
      }
    } catch {}
    return { url: url || null, provider };
  } catch {
    return { url: null, provider: 'none' };
  }
};

export const readGithubMirrorRemote = async (gitRoot) => {
  for (const args of [
    ['config', '--local', '--get', 'orion.githubMirrorUrl'],
    ['remote', 'get-url', 'github'],
  ]) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', gitRoot, ...args]);
      const url = stdout.trim();
      if (url && sourceProviderForRemoteUrl(url) === 'github') return url;
    } catch {}
  }
  return null;
};

export const getGitStateForPath = async (projectPath) => {
  const gitRoot = await getGitRoot(projectPath);
  const [currentBranch, entries, aheadBehind, origin, githubMirrorUrl] = await Promise.all([
    getCurrentGitBranch(gitRoot),
    readGitStatusEntries(gitRoot),
    readGitAheadBehind(gitRoot),
    readOriginRemote(gitRoot),
    readGithubMirrorRemote(gitRoot),
  ]);
  const branches = await readGitBranches(gitRoot, currentBranch);
  const detachedHead = currentBranch === null ? await getDetachedGitHead(gitRoot) : null;

  return {
    ok: true,
    isGitRepository: true,
    root: gitRoot,
    originUrl: origin.url,
    sourceProvider: origin.provider,
    githubMirrorUrl,
    currentBranch,
    detachedHead,
    branches,
    hasUncommittedChanges: entries.length > 0,
    ...aheadBehind,
  };
};

export const validateNewBranchName = async (branchName) => {
  if (!branchName || branchName.startsWith('-')) return false;
  return commandSucceeds('git', ['check-ref-format', '--branch', branchName]);
};

export const commitMessageForEntries = (entries) => {
  if (entries.length === 0) return 'Update project';
  if (entries.length === 1) {
    const [entry] = entries;
    const verbs = {
      added: 'Add',
      copied: 'Copy',
      conflicted: 'Resolve',
      deleted: 'Remove',
      modified: 'Update',
      renamed: 'Rename',
      untracked: 'Add',
    };
    return `${verbs[entry.kind] ?? 'Update'} ${entry.relativePath}`;
  }

  const counts = entries.reduce((acc, entry) => {
    acc[entry.kind] = (acc[entry.kind] ?? 0) + 1;
    return acc;
  }, {});
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'modified';
  const labels = {
    added: 'new files',
    copied: 'copied files',
    conflicted: 'conflict resolutions',
    deleted: 'removed files',
    modified: 'files',
    renamed: 'renamed files',
    untracked: 'new files',
  };
  return `Update ${entries.length} ${labels[dominant] ?? 'files'}`;
};
