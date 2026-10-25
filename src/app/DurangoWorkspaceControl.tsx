import React from 'react';
import {
  ChevronDown,
  FolderGit2,
  GitMerge,
  Play,
  Square,
  SquareArrowOutUpRight,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import type { ThreadDurangoWorkspace } from '../store';
import type { DurangoWorkspaceStatus } from '../types';

// Thread header pill for the thread's Durango workspace (docs/workspaces.md):
// where it is, the change it holds, its dev server, landing, and removal. The
// status is main-process state (the workspace's change file, `ws list`), so
// the pill polls it while mounted and asks Durango Source for the change's
// own status only when the menu opens.

const STATUS_POLL_MS = 10_000;

const changeStatusLabel: Record<string, string> = {
  open: 'Open',
  queued: 'On the train',
  landed: 'Merged',
  abandoned: 'Abandoned',
};

type Props = {
  workspace: ThreadDurangoWorkspace;
  /** Repository work is running or the workspace is changing. */
  disabled: boolean;
  onRemove: () => void;
};

const DurangoWorkspaceControl = React.memo(function DurangoWorkspaceControl({ workspace, disabled, onRemove }: Props) {
  const [open, setOpen] = React.useState(false);
  const [status, setStatus] = React.useState<DurangoWorkspaceStatus | null>(null);
  const [busy, setBusy] = React.useState<'land' | 'serve' | 'stop' | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const lastPorts = workspace.portBase + workspace.portBlock - 1;
  const localUrl = `http://127.0.0.1:${workspace.portBase}`;

  const refresh = React.useCallback(
    async (remote = false) => {
      const next = await window.orion
        ?.durangoWorkspaceStatus?.({ path: workspace.path, name: workspace.name, repo: workspace.repo, remote })
        .catch(() => null);
      if (next?.ok) {
        // A local poll keeps the URL and title the last remote lookup found.
        setStatus((current) =>
          !remote && next.change && current?.change?.changeId === next.change.changeId
            ? {
                ...next,
                change: {
                  ...next.change,
                  url: current.change.url,
                  title: current.change.title,
                  status: next.change.status ?? current.change.status,
                },
              }
            : next
        );
      }
    },
    [workspace.name, workspace.path, workspace.repo]
  );

  React.useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => void refresh(false), STATUS_POLL_MS);
    const unsubscribe = window.orion?.onDurangoWorkspaceServerExited?.(({ path, code, error }) => {
      if (path !== workspace.path) return;
      if (code) toast.error(`The ${workspace.name} dev server stopped`, { description: error ?? undefined });
      void refresh(false);
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe?.();
    };
  }, [refresh, workspace.name, workspace.path]);

  React.useEffect(() => {
    if (!open) return undefined;
    void refresh(true);
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open, refresh]);

  const change = status?.change ?? null;
  const landing = busy === 'land' || status?.landing === true;
  const serverRunning = status?.server === 'running';
  const serverPending = status?.server === 'queued' || status?.server === 'starting';

  const land = async () => {
    if (!change || !window.orion?.landDurangoWorkspace) return;
    if (
      !confirm(
        `Land ${change.changeId}?\n\nIt goes on the train, which runs the checks, deploys the affected targets, and only then moves main.`
      )
    ) {
      return;
    }
    setOpen(false);
    setBusy('land');
    toast.info(`Landing ${change.changeId} — it is on the train`);
    try {
      const result = await window.orion.landDurangoWorkspace({ path: workspace.path });
      if (result.ok) {
        toast.success(`${result.changeId ?? change.changeId} is merged and live`, {
          ...(result.url
            ? { action: { label: 'Open', onClick: () => void window.orion?.openExternalUrl(result.url!) } }
            : {}),
        });
      } else {
        toast.error(
          result.exitCode === 3 ? 'The change conflicts with main' : `Could not land ${change.changeId}`,
          { description: result.error }
        );
      }
    } finally {
      setBusy(null);
      void refresh(true);
    }
  };

  const toggleServer = async () => {
    setOpen(false);
    if (serverRunning || serverPending) {
      setBusy('stop');
      const result = await window.orion?.stopDurangoWorkspaceServer?.({
        path: workspace.path,
        name: workspace.name,
        repo: workspace.repo,
      });
      if (result && !result.ok) toast.error('Could not stop the dev server', { description: result.error });
    } else {
      setBusy('serve');
      const result = await window.orion?.serveDurangoWorkspace?.({
        path: workspace.path,
        name: workspace.name,
        repo: workspace.repo,
      });
      if (result && !result.ok) toast.error('Could not start the dev server', { description: result.error });
    }
    setBusy(null);
    void refresh(false);
  };

  return (
    <div className="shell-branch-control" ref={rootRef}>
      <button
        type="button"
        className="shell-branch-trigger"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        title={`Durango workspace · ${workspace.path}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <FolderGit2 size={14} />
        <span className="truncate">{workspace.name}</span>
        {(landing || serverRunning) && (
          <span
            className={`size-1.5 shrink-0 rounded-full ${landing ? 'bg-[var(--warning)]' : 'bg-[var(--success)]'}`}
            aria-hidden="true"
          />
        )}
        <ChevronDown size={13} className={`project-pill-chevron ${open ? 'open' : ''}`} />
      </button>
      {open && !disabled && (
        <div className="shell-branch-picker" role="menu">
          <div className="branch-picker-note">
            <div className="truncate text-[var(--text-secondary)]" title={workspace.path}>
              {workspace.path}
            </div>
            <div>
              Ports {workspace.portBase}–{lastPorts} · <code>.durango/ws.env</code>
            </div>
            {status && !status.exists && <div className="text-[var(--danger)]">The workspace directory is missing.</div>}
          </div>
          <div className="project-picker-divider" />
          {change ? (
            <>
              <div className="branch-picker-note">
                <div className="truncate text-[var(--text-secondary)]" title={change.title ?? change.changeId}>
                  {change.title ?? change.changeId}
                </div>
                <div>
                  {change.changeId} · {landing ? 'Landing…' : changeStatusLabel[change.status ?? ''] ?? 'Change'}
                </div>
                {change.rejection && change.status === 'open' && (
                  <div className="text-[var(--danger)]">Sent back: {change.rejection}</div>
                )}
              </div>
              {change.url && (
                <button
                  type="button"
                  className="branch-picker-item"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    void window.orion?.openExternalUrl(change.url!);
                  }}
                >
                  <SquareArrowOutUpRight size={13} /> Open change
                </button>
              )}
              {(change.status === 'open' || landing) && (
                <button
                  type="button"
                  className="branch-picker-item"
                  role="menuitem"
                  disabled={landing}
                  onClick={() => void land()}
                  title="durango-code land: put the change on the train and wait until it is merged and live"
                >
                  <GitMerge size={13} /> {landing ? 'Landing…' : 'Land'}
                </button>
              )}
            </>
          ) : (
            <div className="branch-picker-note">No change yet — the agent opens one with durango-code change create.</div>
          )}
          <div className="project-picker-divider" />
          <button
            type="button"
            className="branch-picker-item"
            role="menuitem"
            disabled={busy === 'serve' || busy === 'stop' || status?.exists === false}
            onClick={() => void toggleServer()}
            title={
              serverRunning || serverPending
                ? 'durango-code ws stop'
                : 'durango-code ws serve: run [workspace] serve from durango.toml on this workspace’s ports'
            }
          >
            {serverRunning || serverPending ? <Square size={13} /> : <Play size={13} />}
            {serverRunning
              ? 'Stop dev server'
              : serverPending
                ? 'Waiting for a server slot… (stop)'
                : 'Run dev server'}
          </button>
          {serverRunning && (
            <button
              type="button"
              className="branch-picker-item"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void window.orion?.openExternalUrl(localUrl);
              }}
            >
              <SquareArrowOutUpRight size={13} /> Open {localUrl.replace('http://', '')}
            </button>
          )}
          <div className="project-picker-divider" />
          <button
            type="button"
            className="branch-picker-item project-picker-item danger"
            role="menuitem"
            disabled={landing}
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
          >
            <Trash2 size={13} /> Remove workspace
          </button>
        </div>
      )}
    </div>
  );
});

export default DurangoWorkspaceControl;
