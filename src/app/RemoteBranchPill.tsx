import React from 'react';
import { FolderGit2, GitBranch } from 'lucide-react';
import type { RemoteEvent } from '../types';

// Where a thread on another machine works there: its Durango workspace and
// branch, read from that machine (remote:threadGit). Shown above the prompt
// box in place of this machine's branch picker, which doesn't apply. Read
// only: the agent there changes branches itself.

const REFRESH_MIN_INTERVAL_MS = 3_000;
const POLL_MS = 30_000;

type Props = {
  machineId: string;
  machineName: string;
  /** The thread's id on that machine. */
  threadId: string;
};

type GitInfo = { branch: string | null; detachedHead: string | null; workspaceName: string | null; dirty: boolean };

const RemoteBranchPill = React.memo(function RemoteBranchPill({ machineId, machineName, threadId }: Props) {
  const [info, setInfo] = React.useState<GitInfo | null>(null);
  const lastRef = React.useRef(0);
  const timerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setInfo(null);
    lastRef.current = 0;
    const refresh = async () => {
      lastRef.current = Date.now();
      const result = await window.orion?.remoteThreadGit?.({ machineId, threadId }).catch(() => null);
      if (cancelled || !result?.ok) return;
      setInfo({
        branch: result.branch ?? null,
        detachedHead: result.detachedHead ?? null,
        workspaceName: result.workspaceName ?? null,
        dirty: result.dirty === true,
      });
    };
    const schedule = () => {
      if (timerRef.current !== null) return;
      const wait = Math.max(0, REFRESH_MIN_INTERVAL_MS - (Date.now() - lastRef.current));
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void refresh();
      }, wait);
    };
    void refresh();
    // A turn there may switch branches or create the workspace.
    const unsubscribe = window.orion?.onRemoteEvent?.((event: RemoteEvent) => {
      if (event.machineId === machineId && event.kind === 'workspaceChanged') schedule();
    });
    const poll = window.setInterval(schedule, POLL_MS);
    return () => {
      cancelled = true;
      unsubscribe?.();
      window.clearInterval(poll);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [machineId, threadId]);

  const label = info?.branch ?? (info?.detachedHead ? `Detached @ ${info.detachedHead}` : null);
  if (!info || (!label && !info.workspaceName)) return null;
  const Icon = info.workspaceName ? FolderGit2 : GitBranch;
  const title = [
    info.workspaceName ? `Workspace ${info.workspaceName}` : null,
    label ? `Branch ${label}` : null,
    info.dirty ? 'Uncommitted changes' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="shell-branch-control">
      <span className="shell-branch-trigger remote-branch-pill" title={`${title} on ${machineName}`}>
        <Icon size={14} />
        <span className="truncate">{info.workspaceName ?? label}</span>
        {info.workspaceName && label && <span className="remote-branch-pill-branch truncate">{label}</span>}
        {info.dirty && <span className="remote-branch-pill-dirty" aria-label="Uncommitted changes" />}
      </span>
    </div>
  );
});

export default RemoteBranchPill;
