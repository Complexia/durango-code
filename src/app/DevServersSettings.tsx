import React from 'react';
import { OctagonX, RefreshCw } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useOrionStore, type Thread } from '../store';
import type { DevServerEntry } from '../types';

// Dev servers are OS processes, not app state: every scan rebuilds the list
// from lsof/ps in the main process, so this panel keeps its own state (like
// SkillsSettings) and polls only while the tab is mounted. Thread attribution
// the main process cannot make (servers orphaned by finished runs) is
// completed here by matching the server's cwd against thread working dirs.
export type DevServersSettingsProps = {
  formatBytes: (bytes: number | null | undefined) => string;
};

const POLL_INTERVAL_MS = 3000;

// macOS reports /private-prefixed paths for some directories; the store holds
// the unprefixed spelling. Compare with the alias stripped, like main does.
const normalizeDir = (value: string | null | undefined) => {
  if (!value) return null;
  const trimmed = value.replace(/\/+$/, '');
  return trimmed.startsWith('/private/') ? trimmed.slice('/private'.length) : trimmed;
};

const formatUptime = (startedAt: number | null) => {
  if (!startedAt) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

const threadSourceLabel: Record<string, string> = {
  agent: 'Started by this agent run',
  terminal: "Started from this thread's terminal",
  session: "Running in this thread's workspace",
  cwd: 'Matched by working directory',
};

const DevServersSettings = React.memo(function DevServersSettings({ formatBytes }: DevServersSettingsProps) {
  const { threads, projects, epics } = useOrionStore(
    useShallow((state) => ({ threads: state.threads, projects: state.projects, epics: state.epics }))
  );
  const [servers, setServers] = React.useState<DevServerEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [scanned, setScanned] = React.useState(false);
  const [scanError, setScanError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<ReadonlySet<number>>(new Set());
  const [killing, setKilling] = React.useState<ReadonlySet<number>>(new Set());
  const mountedRef = React.useRef(true);
  const scanInFlightRef = React.useRef(false);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Scan scope: every project plus every epic's rift workspace.
  const roots = React.useMemo(() => {
    const set = new Set<string>();
    for (const project of projects) if (project.path) set.add(project.path);
    for (const epic of epics) {
      if (epic.riftPath) set.add(epic.riftPath);
      if (epic.riftWorkingDir) set.add(epic.riftWorkingDir);
    }
    return [...set];
  }, [projects, epics]);
  const rootsRef = React.useRef(roots);
  rootsRef.current = roots;

  const refresh = React.useCallback(async () => {
    if (!window.orion?.listDevServers) {
      setLoading(false);
      setScanError('This build of Durango Code cannot inspect dev servers. Restart the app after updating.');
      return;
    }
    if (scanInFlightRef.current) return;
    scanInFlightRef.current = true;
    try {
      const result = await window.orion.listDevServers({ roots: rootsRef.current });
      if (!mountedRef.current) return;
      setServers(result?.servers ?? []);
      setScanError(result?.ok === false ? result.error ?? 'Could not scan for dev servers.' : null);
      setScanned(true);
      // A vanished server must not stay selected and get its pid — possibly
      // recycled by now — killed on the next click.
      const alive = new Set((result?.servers ?? []).map((server) => server.pid));
      setSelected((current) => {
        const kept = new Set([...current].filter((pid) => alive.has(pid)));
        return kept.size === current.size ? current : kept;
      });
    } catch (caught) {
      if (mountedRef.current) setScanError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      scanInFlightRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  React.useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const threadsById = React.useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const projectsById = React.useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const epicsById = React.useMemo(() => new Map(epics.map((epic) => [epic.id, epic])), [epics]);

  const threadWorkingDir = React.useCallback(
    (thread: Thread) => {
      const epic = thread.epicId ? epicsById.get(thread.epicId) : undefined;
      if (epic?.riftPath) return normalizeDir(epic.riftWorkingDir ?? epic.riftPath);
      return normalizeDir(projectsById.get(thread.projectId)?.path);
    },
    [epicsById, projectsById]
  );

  // Completes attribution for servers main couldn't tie to a live run: the
  // thread whose working dir contains the server's cwd, preferring running
  // threads, then the most recently active.
  const resolveThread = React.useCallback(
    (server: DevServerEntry): { thread: Thread; source: string } | null => {
      if (server.threadId) {
        const thread = threadsById.get(server.threadId);
        if (thread) return { thread, source: server.threadSource ?? 'cwd' };
      }
      const cwd = normalizeDir(server.cwd);
      if (!cwd) return null;
      let best: Thread | null = null;
      let bestDepth = -1;
      const rank = (thread: Thread) =>
        `${thread.status === 'running' ? 1 : 0}:${thread.terminalActivityAt && thread.terminalActivityAt > thread.createdAt ? thread.terminalActivityAt : thread.createdAt}`;
      for (const thread of threads) {
        const dir = threadWorkingDir(thread);
        if (!dir || (cwd !== dir && !cwd.startsWith(`${dir}/`))) continue;
        // Deeper working dirs are more specific (a rift beats the project it
        // was copied from); among equals the busiest thread wins.
        if (dir.length > bestDepth || (dir.length === bestDepth && best && rank(thread) > rank(best))) {
          best = thread;
          bestDepth = dir.length;
        }
      }
      return best ? { thread: best, source: 'cwd' } : null;
    },
    [threads, threadsById, threadWorkingDir]
  );

  const projectNameFor = React.useCallback(
    (server: DevServerEntry) => {
      const cwd = normalizeDir(server.cwd);
      if (!cwd) return null;
      for (const project of projects) {
        const dir = normalizeDir(project.path);
        if (dir && (cwd === dir || cwd.startsWith(`${dir}/`))) return project.name;
      }
      return null;
    },
    [projects]
  );

  const openThread = React.useCallback((threadId: string) => {
    const store = useOrionStore.getState();
    store.setActiveTab('agents');
    store.selectThread(threadId);
    store.setSettingsOpen(false);
  }, []);

  const openPort = React.useCallback(async (port: number) => {
    if (!window.orion?.openDevServer) {
      setActionError('This build of Durango Code cannot open dev server ports. Restart the app after updating.');
      return;
    }
    try {
      const result = await window.orion.openDevServer({ port });
      if (!mountedRef.current) return;
      setActionError(result?.ok === false ? result.error ?? `Could not open localhost:${port}.` : null);
    } catch (caught) {
      if (mountedRef.current) setActionError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const killServers = React.useCallback(
    async (targets: DevServerEntry[]) => {
      if (!window.orion?.killDevServers || targets.length === 0) return;
      const summary = targets
        .map((server) => `${server.command}${server.ports.length ? ` on port ${server.ports.join(', ')}` : ''}`)
        .join('\n');
      const label = targets.length === 1 ? 'this dev server' : `these ${targets.length} dev servers`;
      if (!confirm(`Kill ${label}?\n\n${summary}`)) return;
      setKilling(new Set(targets.map((server) => server.pid)));
      try {
        const result = await window.orion.killDevServers({
          targets: targets.map((server) => ({ pid: server.pid, port: server.ports[0] ?? null })),
        });
        if (!mountedRef.current) return;
        const failed = (result?.results ?? []).filter((entry) => !entry.ok);
        if (failed.length > 0) {
          setActionError(failed.map((entry) => entry.error ?? `Could not kill process ${entry.pid}.`).join(' '));
        } else {
          setActionError(null);
          setNotice(targets.length === 1 ? `Killed ${targets[0].command}.` : `Killed ${targets.length} dev servers.`);
        }
      } catch (caught) {
        if (mountedRef.current) setActionError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (mountedRef.current) setKilling(new Set());
        await refresh();
      }
    },
    [refresh]
  );

  const allSelected = servers.length > 0 && servers.every((server) => selected.has(server.pid));
  const selectedServers = servers.filter((server) => selected.has(server.pid));
  const killingAny = killing.size > 0;
  const message = actionError || scanError || notice;

  return (
    <>
      <div className="settings-group-label">Running dev servers</div>
      <div className="settings-group">
        <div className="skills-toolbar">
          <div className="skills-toolbar-main">
            <div className="skills-toolbar-total">
              {!scanned && loading
                ? 'Scanning ports...'
                : `${servers.length} dev server${servers.length === 1 ? '' : 's'} running`}
            </div>
            <div className="skills-toolbar-caption">
              Processes listening on a TCP port inside one of your projects or rift workspaces — dev servers your
              agents started (and any you started there yourself). Killing one here sends SIGTERM, then SIGKILL if it
              lingers. The list refreshes every few seconds while this tab is open.
            </div>
          </div>
          <div className="skills-toolbar-actions">
            <button
              type="button"
              className="btn secondary small"
              disabled={loading && !scanned}
              onClick={() => void refresh()}
              title="Rescan listening ports now"
            >
              <RefreshCw size={13} className={loading && !scanned ? 'spinning' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {message && <div className={`skills-message${actionError || scanError ? ' error' : ''}`}>{message}</div>}

        {scanned && servers.length === 0 && !scanError && (
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-label-desc">
                No dev servers are running in your projects right now. Servers agents leave running in the background
                will show up here.
              </div>
            </div>
          </div>
        )}

        {servers.length > 0 && (
          <div className="dev-servers-list">
            <div className="dev-servers-list-header">
              <input
                type="checkbox"
                className="dev-server-check"
                checked={allSelected}
                disabled={killingAny}
                onChange={(event) =>
                  setSelected(event.target.checked ? new Set(servers.map((server) => server.pid)) : new Set())
                }
                title={allSelected ? 'Clear selection' : 'Select all'}
              />
              <span className="dev-servers-selected-count">
                {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
              </span>
              <button
                type="button"
                className="btn danger small"
                disabled={selectedServers.length === 0 || killingAny}
                onClick={() => void killServers(selectedServers)}
              >
                <OctagonX size={13} />
                {selectedServers.length > 1 ? `Kill ${selectedServers.length} servers` : 'Kill selected'}
              </button>
            </div>

            {servers.map((server) => {
              const resolved = resolveThread(server);
              const active = resolved?.thread.status === 'running';
              const busy = killing.has(server.pid);
              const projectName = projectNameFor(server);
              const uptime = formatUptime(server.startedAt);
              const stats = [
                server.cpuPercent === null ? null : `${server.cpuPercent.toFixed(server.cpuPercent >= 10 ? 0 : 1)}% CPU`,
                server.memoryBytes === null ? null : formatBytes(server.memoryBytes),
                uptime === null ? null : `up ${uptime}`,
              ].filter(Boolean);
              return (
                <div key={server.pid} className={`dev-server-row${busy ? ' busy' : ''}`}>
                  <input
                    type="checkbox"
                    className="dev-server-check"
                    checked={selected.has(server.pid)}
                    disabled={busy}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(server.pid);
                        else next.delete(server.pid);
                        return next;
                      })
                    }
                  />
                  <div className="dev-server-main">
                    <div className="dev-server-head">
                      <span className="dev-server-name">{server.command}</span>
                      {server.ports.map((port) => (
                        <button
                          key={port}
                          type="button"
                          className="dev-server-port"
                          title={`Open http://localhost:${port} in your browser`}
                          onClick={() => void openPort(port)}
                        >
                          :{port}
                        </button>
                      ))}
                      {active && (
                        <span className="dev-server-live" title="The attributed agent thread is running right now">
                          <span className="dev-server-live-dot" />
                          in use
                        </span>
                      )}
                    </div>
                    <div className="dev-server-meta truncate" title={server.commandLine}>
                      {server.commandLine}
                    </div>
                    <div className="dev-server-meta truncate" title={server.cwd ?? undefined}>
                      pid {server.pid}
                      {projectName ? ` · ${projectName}` : ''}
                      {server.cwd ? ` · ${server.cwd}` : ''}
                    </div>
                  </div>
                  <div className="dev-server-stats">{stats.join(' · ')}</div>
                  {resolved && (
                    <button
                      type="button"
                      className={`dev-server-thread${active ? ' active' : ''}`}
                      title={`${threadSourceLabel[resolved.source] ?? threadSourceLabel.cwd} — open “${resolved.thread.title}”`}
                      onClick={() => openThread(resolved.thread.id)}
                    >
                      {active && <span className="dev-server-live-dot" />}
                      <span className="truncate">{resolved.thread.title}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="archived-epic-action danger"
                    title={`Kill ${server.command} (pid ${server.pid})`}
                    disabled={busy}
                    onClick={() => void killServers([server])}
                  >
                    <OctagonX size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
});

export default DevServersSettings;
