import path from 'node:path';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';

// Workspace-write boundary for ACP harnesses without a filesystem sandbox of
// their own (kimi, fx): every reported mutation target is resolved against
// the workspace, including any symlinked ancestors, and must stay inside it.
export const createWorkspaceBoundary = (cwd) => {
  const workspaceRoot = path.resolve(cwd || '.');
  let canonicalWorkspaceRoot = null;
  try {
    canonicalWorkspaceRoot = realpathSync(workspaceRoot);
  } catch {}

  // realpathSync requires the final target to exist, but Write commonly
  // creates a new file. Canonicalize the deepest existing ancestor and append
  // the missing suffix. lstatSync intentionally detects broken symlinks too:
  // following one can still create its target outside the workspace.
  const canonicalizeMutationTarget = (candidate, depth = 0) => {
    if (depth > 40) throw new Error('Too many symbolic links');
    const resolved = path.resolve(candidate);
    let ancestor = resolved;
    let stats;
    while (true) {
      try {
        stats = lstatSync(ancestor);
        break;
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }

    const missingSuffix = path.relative(ancestor, resolved);
    let canonicalAncestor;
    try {
      canonicalAncestor = realpathSync(ancestor);
    } catch (error) {
      if (!stats.isSymbolicLink()) throw error;
      const canonicalParent = canonicalizeMutationTarget(path.dirname(ancestor), depth + 1);
      canonicalAncestor = canonicalizeMutationTarget(
        path.resolve(canonicalParent, readlinkSync(ancestor)),
        depth + 1
      );
    }
    return path.resolve(canonicalAncestor, missingSuffix);
  };

  const isInsideWorkspace = (candidate) => {
    if (!canonicalWorkspaceRoot) return false;
    try {
      const resolvedCandidate = path.resolve(workspaceRoot, candidate);
      const canonicalCandidate = canonicalizeMutationTarget(resolvedCandidate);
      const relative = path.relative(canonicalWorkspaceRoot, canonicalCandidate);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    } catch {
      return false;
    }
  };

  return { isInsideWorkspace };
};
