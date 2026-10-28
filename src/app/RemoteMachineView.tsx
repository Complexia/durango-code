import React from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  MonitorSmartphone,
  RefreshCw,
  Send,
  Square,
} from 'lucide-react';
import type { Thread } from '../store';
import type { RemoteEvent, RemoteSnapshot, RemoteThreadMeta } from '../types';
import { createLatestOperationGate } from './remote-operation-gate';
import { formatShortTime } from './time';

// Read-and-drive view of a paired machine's workspace: its projects
// and threads, a simplified transcript, and a composer that starts/continues
// turns on the remote host. Truth lives on the host — this component only
// mirrors host snapshots and refreshes when the host pushes change events, so
// it never diverges from what the host's own UI shows.
export type RemoteMachineViewProps = {
  machineId: string;
  machineName: string;
  status: 'connected' | 'connecting' | 'offline' | 'error';
  onBack: () => void;
};

const remoteStatusLabel: Record<Thread['status'], string> = {
  idle: 'Idle',
  running: 'Running',
  done: 'Finished',
  error: 'Error',
};

const remoteMachineErrorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

const RemoteMachineView = React.memo(function RemoteMachineView({
  machineId,
  machineName,
  status,
  onBack,
}: RemoteMachineViewProps) {
  const [snapshot, setSnapshot] = React.useState<RemoteSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [selectedThreadId, setSelectedThreadId] = React.useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = React.useState<string | null>(null);
  const [thread, setThread] = React.useState<Thread | null>(null);
  const [threadLoading, setThreadLoading] = React.useState(false);
  const [threadError, setThreadError] = React.useState<string | null>(null);
  const [prompt, setPrompt] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [collapsedProjects, setCollapsedProjects] = React.useState<Record<string, boolean>>({});
  const mountedRef = React.useRef(true);
  const activeMachineIdRef = React.useRef(machineId);
  const selectedThreadIdRef = React.useRef<string | null>(null);
  const snapshotGateRef = React.useRef(createLatestOperationGate());
  const threadGateRef = React.useRef(createLatestOperationGate());
  const commandGateRef = React.useRef(createLatestOperationGate());
  const snapshotTimerRef = React.useRef<number | null>(null);
  const threadTimerRef = React.useRef<number | null>(null);
  const transcriptRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (snapshotTimerRef.current) window.clearTimeout(snapshotTimerRef.current);
      if (threadTimerRef.current) window.clearTimeout(threadTimerRef.current);
    };
  }, []);

  React.useLayoutEffect(() => {
    activeMachineIdRef.current = machineId;
    snapshotGateRef.current.invalidate();
    threadGateRef.current.invalidate();
    commandGateRef.current.invalidate();
  }, [machineId]);

  React.useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);

  const refreshSnapshot = React.useCallback(async () => {
    const requestedMachineId = machineId;
    const operation = snapshotGateRef.current.begin();
    const isCurrent = () =>
      mountedRef.current &&
      activeMachineIdRef.current === requestedMachineId &&
      snapshotGateRef.current.isCurrent(operation);
    try {
      const result = await window.orion?.remoteFetchSnapshot?.({ machineId });
      if (!isCurrent()) return;
      if (result?.ok && result.snapshot) {
        setSnapshot(result.snapshot);
        setSnapshotError(null);
      } else {
        setSnapshotError(result?.error ?? 'Could not load the remote workspace.');
      }
    } catch (cause) {
      if (isCurrent()) {
        setSnapshotError(remoteMachineErrorMessage(cause, 'Could not load the remote workspace.'));
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [machineId]);

  const refreshThread = React.useCallback(
    async (threadId: string) => {
      const requestedMachineId = machineId;
      const operation = threadGateRef.current.begin();
      const isCurrent = () =>
        mountedRef.current &&
        activeMachineIdRef.current === requestedMachineId &&
        selectedThreadIdRef.current === threadId &&
        threadGateRef.current.isCurrent(operation);
      try {
        const result = await window.orion?.remoteFetchThread?.({ machineId, threadId });
        if (!isCurrent()) return;
        if (result?.ok && result.thread) {
          setThread(result.thread);
          setThreadError(null);
        } else {
          setThreadError(result?.error ?? 'Could not load this thread.');
        }
      } catch (cause) {
        if (isCurrent()) {
          setThreadError(remoteMachineErrorMessage(cause, 'Could not load this thread.'));
        }
      } finally {
        if (isCurrent()) setThreadLoading(false);
      }
    },
    [machineId]
  );

  // Connect (idempotent) and load, whenever the target machine changes.
  React.useEffect(() => {
    if (snapshotTimerRef.current) window.clearTimeout(snapshotTimerRef.current);
    if (threadTimerRef.current) window.clearTimeout(threadTimerRef.current);
    snapshotTimerRef.current = null;
    threadTimerRef.current = null;
    selectedThreadIdRef.current = null;
    setSnapshot(null);
    setSelectedThreadId(null);
    setSelectedProjectId(null);
    setThread(null);
    setThreadLoading(false);
    setThreadError(null);
    setPrompt('');
    setSending(false);
    setActionError(null);
    setCollapsedProjects({});
    setLoading(true);
    setSnapshotError(null);
    const requestedMachineId = machineId;
    void (async () => {
      try {
        const result = await window.orion?.remoteConnectMachine?.({ machineId });
        if (!mountedRef.current || activeMachineIdRef.current !== requestedMachineId) return;
        if (result?.ok) {
          void refreshSnapshot();
        } else {
          setSnapshotError(result?.error ?? 'Could not connect to this machine.');
          setLoading(false);
        }
      } catch (cause) {
        if (!mountedRef.current || activeMachineIdRef.current !== requestedMachineId) return;
        setSnapshotError(remoteMachineErrorMessage(cause, 'Could not connect to this machine.'));
        setLoading(false);
      }
    })();
  }, [machineId, refreshSnapshot]);

  // Host push events: workspace changes refresh both the snapshot and the open
  // transcript. The latter matters because workspaceChanged is emitted only
  // after the host persists threads; an earlier turnEvent may have raced the
  // host's transcript flush and read stale running state. Both paths are
  // throttled because the host streams chunk events far faster than a remote
  // viewer needs.
  React.useEffect(() => {
    const unsubscribe = window.orion?.onRemoteEvent?.((event: RemoteEvent) => {
      if (event.machineId !== machineId) return;
      if (event.kind === 'workspaceChanged') {
        if (snapshotTimerRef.current) return;
        snapshotTimerRef.current = window.setTimeout(() => {
          snapshotTimerRef.current = null;
          void refreshSnapshot();
          const current = selectedThreadIdRef.current;
          if (current) void refreshThread(current);
        }, 1000);
        return;
      }
      if (event.kind === 'turnEvent') {
        const threadId = event.payload?.threadId;
        if (!threadId || threadId !== selectedThreadIdRef.current) return;
        if (threadTimerRef.current) return;
        threadTimerRef.current = window.setTimeout(() => {
          threadTimerRef.current = null;
          const current = selectedThreadIdRef.current;
          if (current) void refreshThread(current);
        }, 1200);
      }
    });
    return () => unsubscribe?.();
  }, [machineId, refreshSnapshot, refreshThread]);

  // Keep the transcript pinned to the bottom as remote turns stream in.
  React.useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread?.messages.length, thread?.messages.at(-1)?.content.length]);

  const selectThread = (meta: RemoteThreadMeta) => {
    threadGateRef.current.invalidate();
    commandGateRef.current.invalidate();
    selectedThreadIdRef.current = meta.id;
    setSelectedThreadId(meta.id);
    setSelectedProjectId(meta.projectId);
    setThread(null);
    setThreadError(null);
    setThreadLoading(true);
    setSending(false);
    setActionError(null);
    void refreshThread(meta.id);
  };

  const selectProject = (projectId: string) => {
    threadGateRef.current.invalidate();
    commandGateRef.current.invalidate();
    selectedThreadIdRef.current = null;
    setSelectedProjectId(projectId);
    setSelectedThreadId(null);
    setThread(null);
    setThreadLoading(false);
    setThreadError(null);
    setSending(false);
    setActionError(null);
  };

  const handleSend = async () => {
    const draft = prompt;
    const text = draft.trim();
    if (!text || sending) return;
    const requestedMachineId = machineId;
    const requestedThreadId = selectedThreadId;
    const requestedProjectId = selectedProjectId;
    const operation = commandGateRef.current.begin();
    setSending(true);
    setActionError(null);
    try {
      const result = await window.orion?.remoteRunTurn?.({
        machineId: requestedMachineId,
        ...(requestedThreadId ? { threadId: requestedThreadId } : { projectId: requestedProjectId ?? undefined }),
        prompt: text,
      });
      if (
        !mountedRef.current ||
        activeMachineIdRef.current !== requestedMachineId ||
        !commandGateRef.current.isCurrent(operation)
      ) return;
      if (result?.ok) {
        setPrompt((current) => (current === draft ? '' : current));
        if (!requestedThreadId && result.threadId) {
          selectedThreadIdRef.current = result.threadId;
          setSelectedThreadId(result.threadId);
          setThreadLoading(true);
          void refreshThread(result.threadId);
        } else if (requestedThreadId) {
          void refreshThread(requestedThreadId);
        }
        void refreshSnapshot();
      } else {
        setActionError(result?.error ?? 'The remote machine could not start the turn.');
      }
    } catch (cause) {
      if (
        mountedRef.current &&
        activeMachineIdRef.current === requestedMachineId &&
        commandGateRef.current.isCurrent(operation)
      ) {
        setActionError(remoteMachineErrorMessage(cause, 'The remote machine could not start the turn.'));
      }
    } finally {
      if (
        mountedRef.current &&
        activeMachineIdRef.current === requestedMachineId &&
        commandGateRef.current.isCurrent(operation)
      ) setSending(false);
    }
  };

  const handleStop = async () => {
    if (!selectedThreadId) return;
    const requestedMachineId = machineId;
    const requestedThreadId = selectedThreadId;
    const operation = commandGateRef.current.begin();
    setActionError(null);
    try {
      const result = await window.orion?.remoteStopTurn?.({
        machineId: requestedMachineId,
        threadId: requestedThreadId,
      });
      if (
        !mountedRef.current ||
        activeMachineIdRef.current !== requestedMachineId ||
        !commandGateRef.current.isCurrent(operation)
      ) return;
      if (!result?.ok) setActionError(result?.error ?? 'Could not stop the remote turn.');
      else void refreshThread(requestedThreadId);
    } catch (cause) {
      if (
        mountedRef.current &&
        activeMachineIdRef.current === requestedMachineId &&
        commandGateRef.current.isCurrent(operation)
      ) {
        setActionError(remoteMachineErrorMessage(cause, 'Could not stop the remote turn.'));
      }
    }
  };

  const projects = snapshot?.projects ?? [];
  // Subagent/child threads are runtime details of their parent; the remote
  // overview lists top-level threads only, newest activity first.
  const visibleThreads = React.useMemo(
    () =>
      (snapshot?.threads ?? [])
        .filter((candidate) => !candidate.parentThreadId && !candidate.subagent)
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
    [snapshot]
  );
  const threadsByProject = React.useMemo(() => {
    const map = new Map<string, RemoteThreadMeta[]>();
    for (const meta of visibleThreads) {
      const list = map.get(meta.projectId) ?? [];
      list.push(meta);
      map.set(meta.projectId, list);
    }
    return map;
  }, [visibleThreads]);
  const selectedMeta = visibleThreads.find((candidate) => candidate.id === selectedThreadId) ?? null;
  const liveStatus = thread?.status ?? selectedMeta?.status;
  const running = liveStatus === 'running';
  const composerPlaceholder = selectedThreadId
    ? `Message this agent on ${machineName}...`
    : selectedProjectId
      ? `Start a new agent on ${machineName}...`
      : 'Select a project or thread first';

  return (
    <div className="panel agents-panel remote-machine-panel">
      <div className="remote-machine-header">
        <button type="button" className="btn secondary small" onClick={onBack} title="Back to this machine">
          <ArrowLeft size={13} />
          This machine
        </button>
        <div className="remote-machine-title">
          <MonitorSmartphone size={16} />
          <span>{machineName}</span>
          <span className={`remote-status-chip ${status}`}>
            {status === 'connected'
              ? 'Connected'
              : status === 'connecting'
                ? 'Connecting…'
                : status === 'error'
                  ? 'Error'
                  : 'Offline'}
          </span>
        </div>
        <button
          type="button"
          className="btn secondary small"
          onClick={() => {
            setLoading(true);
            void refreshSnapshot();
          }}
          title="Refresh the remote workspace"
        >
          <RefreshCw size={13} className={loading ? 'spinning' : ''} />
          Refresh
        </button>
      </div>

      {snapshotError && <div className="remote-machine-error">{snapshotError}</div>}

      <div className="remote-machine-body">
        <div className="remote-machine-list">
          {loading && !snapshot && <div className="remote-machine-hint">Loading workspace…</div>}
          {snapshot && projects.length === 0 && (
            <div className="remote-machine-hint">No projects on {machineName} yet.</div>
          )}
          {projects.map((project) => {
            const projectThreads = threadsByProject.get(project.id) ?? [];
            const collapsed = collapsedProjects[project.id] ?? false;
            return (
              <div key={project.id} className="remote-project-section">
                <div className="remote-project-header-row">
                  <button
                    type="button"
                    className="project-collapse-toggle"
                    title={collapsed ? 'Expand threads' : 'Collapse threads'}
                    aria-expanded={!collapsed}
                    onClick={() => {
                      setCollapsedProjects((prev) => ({ ...prev, [project.id]: !collapsed }));
                    }}
                  >
                    <ChevronRight
                      size={12}
                      className={`sidebar-section-chevron ${collapsed ? '' : 'open'}`}
                    />
                  </button>
                  <button
                    type="button"
                    className={`remote-project-header${selectedProjectId === project.id ? ' selected' : ''}`}
                    title={project.path}
                    onClick={() => selectProject(project.id)}
                  >
                    <Folder size={13} />
                    <span className="truncate">{project.name}</span>
                    <span className="sidebar-section-count">{projectThreads.length}</span>
                  </button>
                </div>
                {!collapsed &&
                  projectThreads.map((meta) => (
                    <button
                      key={meta.id}
                      type="button"
                      className={`remote-thread-item${selectedThreadId === meta.id ? ' selected' : ''}`}
                      onClick={() => selectThread(meta)}
                      title={meta.title}
                    >
                      <span className={`remote-thread-dot ${meta.status}`} />
                      <span className="truncate">{meta.title}</span>
                      <span className="remote-thread-time">
                        {meta.updatedAt ? formatShortTime(new Date(meta.updatedAt)) : ''}
                      </span>
                    </button>
                  ))}
              </div>
            );
          })}
        </div>

        <div className="remote-machine-main">
          {!selectedThreadId ? (
            <div className="remote-machine-empty">
              <MonitorSmartphone size={26} />
              <div>
                {selectedProjectId
                  ? 'Start a new agent below, or pick a thread to follow it.'
                  : `Select a project or thread from ${machineName}.`}
              </div>
            </div>
          ) : (
            <div className="remote-transcript" ref={transcriptRef}>
              {threadLoading && !thread && <div className="remote-machine-hint">Loading thread…</div>}
              {threadError && <div className="remote-machine-error">{threadError}</div>}
              {thread?.messages.map((message) => (
                <div key={message.id} className={`remote-message remote-message-${message.role}`}>
                  <div className="remote-message-meta">
                    <span className="remote-message-role">
                      {message.role === 'user' ? 'You' : message.role === 'agent' ? 'Agent' : 'System'}
                    </span>
                    {message.kind === 'agent-run' && message.status && (
                      <span className={`remote-status-chip ${message.status === 'running' ? 'connecting' : ''}`}>
                        {message.status === 'running'
                          ? (message.statusText ?? 'Running…')
                          : message.status === 'error'
                            ? 'Error'
                            : message.status === 'stopped'
                              ? 'Stopped'
                              : 'Finished'}
                      </span>
                    )}
                    <span className="remote-message-time">{formatShortTime(new Date(message.ts))}</span>
                  </div>
                  {(message.activities?.length ?? 0) > 0 && (
                    <div className="remote-message-activities">
                      {message.activities!.length} step{message.activities!.length === 1 ? '' : 's'} ·{' '}
                      {message.activities!.at(-1)?.title}
                    </div>
                  )}
                  {message.content && <div className="remote-message-content">{message.content}</div>}
                  {message.error && <div className="remote-machine-error">{message.error}</div>}
                </div>
              ))}
              {thread && thread.messages.length === 0 && (
                <div className="remote-machine-hint">This thread has no messages yet.</div>
              )}
            </div>
          )}

          <div className="remote-composer">
            {actionError && <div className="remote-machine-error">{actionError}</div>}
            <div className="remote-composer-row">
              <textarea
                value={prompt}
                placeholder={composerPlaceholder}
                disabled={(!selectedThreadId && !selectedProjectId) || status === 'offline'}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                rows={2}
              />
              {running ? (
                <button type="button" className="btn secondary small" onClick={() => void handleStop()} title="Stop the remote turn">
                  <Square size={13} />
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="btn small"
                  disabled={sending || !prompt.trim() || (!selectedThreadId && !selectedProjectId)}
                  onClick={() => void handleSend()}
                  title={selectedThreadId ? 'Send to this remote thread' : 'Start a new remote agent'}
                >
                  <Send size={13} />
                  {sending ? 'Sending…' : 'Send'}
                </button>
              )}
            </div>
            <div className="remote-composer-caption">
              Runs on {machineName}. {selectedThreadId ? 'Continues the selected thread.' : 'Starts a new thread in the selected project.'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

export default RemoteMachineView;
