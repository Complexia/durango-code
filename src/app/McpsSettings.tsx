import React from 'react';
import { ExternalLink, Globe, LogIn, Plus, RefreshCw, Share2, TerminalSquare, Trash2 } from 'lucide-react';
import { useOrionStore } from '../store';
import type { AccountConnectorsListResult, OrionMcpEntry, ProviderMcpEntry, ProviderMcpSource, ProviderMcpsListResult } from '../types';
import { parseKeyValueLines, splitCommandLine, suggestMcpNickname } from './orionMcps';

// Settings and the composer's @-mention list share the connected-server list;
// mutations here tell the composer to re-read it.
export const ORION_MCPS_CHANGED_EVENT = 'orion-mcps-changed';
const notifyOrionMcpsChanged = () => window.dispatchEvent(new Event(ORION_MCPS_CHANGED_EVENT));

const transportLabel = (transport: string) => {
  if (transport === 'stdio') return 'Local';
  if (transport === 'http') return 'HTTP';
  if (transport === 'sse') return 'SSE';
  return transport === 'unknown' ? 'MCP' : transport.toUpperCase();
};

type AddFormState = {
  transport: 'http' | 'stdio';
  source: string;
  nickname: string;
  nicknameEdited: boolean;
  secrets: string;
  showSecrets: boolean;
  enabled: boolean;
};

const emptyAddForm: AddFormState = {
  transport: 'http',
  source: '',
  nickname: '',
  nicknameEdited: false,
  secrets: '',
  showSecrets: false,
  enabled: false,
};

const OrionMcpsSection = React.memo(function OrionMcpsSection() {
  const [servers, setServers] = React.useState<OrionMcpEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<AddFormState | null>(null);
  const [connecting, setConnecting] = React.useState(false);
  const [pendingSignInId, setPendingSignInId] = React.useState<string | null>(null);
  const mountedRef = React.useRef(true);
  const pendingAddRef = React.useRef<string | null>(null);

  const cancelPendingAdd = () => {
    const operationId = pendingAddRef.current;
    pendingAddRef.current = null;
    if (operationId) void window.orion?.cancelOrionMcpSignIn?.({ operationId });
  };

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelPendingAdd();
    };
  }, []);

  const refresh = React.useCallback(async () => {
    if (!window.orion?.listOrionMcps) {
      setLoading(false);
      setError('This build of Durango Code cannot connect MCP servers. Restart the app after updating.');
      return;
    }
    try {
      const result = await window.orion.listOrionMcps();
      if (!mountedRef.current) return;
      setServers(result?.servers ?? []);
      if (result?.ok === false) setError(result.error ?? 'Could not read Durango Code MCP servers.');
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Sharing a Claude Code or Codex server below adds one here.
  React.useEffect(() => {
    const onChanged = () => void refresh();
    window.addEventListener(ORION_MCPS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ORION_MCPS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  const updateForm =(patch: Partial<AddFormState>) =>
    setForm((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      // Suggest a nickname from the URL/command until the user types their own.
      if (!next.nicknameEdited && (patch.source !== undefined || patch.transport !== undefined)) {
        next.nickname = suggestMcpNickname(next.source, next.transport);
      }
      return next;
    });

  const handleConnect = async () => {
    if (!form || !window.orion?.addOrionMcp || pendingAddRef.current) return;
    const source = form.source.trim();
    if (!source) {
      setError(form.transport === 'http' ? 'Enter the MCP server URL.' : 'Enter the command that starts the server.');
      return;
    }
    const secrets = parseKeyValueLines(form.secrets, form.transport === 'http' ? ':' : '=');
    if (!secrets.ok) {
      setError(secrets.error);
      return;
    }
    const words = form.transport === 'stdio' ? splitCommandLine(source) : [];
    const operationId = crypto.randomUUID();
    pendingAddRef.current = operationId;
    setConnecting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.orion.addOrionMcp({
        operationId,
        nickname: form.nickname.trim().toLowerCase(),
        transport: form.transport,
        ...(form.transport === 'http'
          ? { url: source, headers: secrets.entries }
          : { command: words[0] ?? '', args: words.slice(1), env: secrets.entries }),
        enabled: form.enabled,
      });
      if (!mountedRef.current || pendingAddRef.current !== operationId) return;
      if (!result?.ok) {
        setError(result?.error ?? 'Could not connect the MCP server.');
        return;
      }
      const toolCount = result.tools?.length ?? 0;
      setNotice(
          `Connected @${result.server?.nickname ?? form.nickname} · ${toolCount} tool${toolCount === 1 ? '' : 's'}. ${
          form.enabled ? 'It loads in every thread.' : 'Mention it in a message to use it.'
        }`
      );
      setForm(null);
      await refresh();
      notifyOrionMcpsChanged();
    } catch (caught) {
      if (mountedRef.current && pendingAddRef.current === operationId) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (pendingAddRef.current === operationId) {
        pendingAddRef.current = null;
        if (mountedRef.current) setConnecting(false);
      }
    }
  };

  const handleToggle = async (server: OrionMcpEntry, enabled: boolean) => {
    if (!window.orion?.updateOrionMcp) return;
    setBusyId(server.id);
    setServers((current) => current.map((entry) => (entry.id === server.id ? { ...entry, enabled } : entry)));
    try {
      const result = await window.orion.updateOrionMcp({ id: server.id, enabled });
      if (!result?.ok) setError(result?.error ?? `Could not update @${server.nickname}.`);
      else setError(null);
    } finally {
      if (mountedRef.current) setBusyId(null);
      await refresh();
      notifyOrionMcpsChanged();
    }
  };

  const handleRemove = async (server: OrionMcpEntry) => {
    if (!window.orion?.removeOrionMcp) return;
    if (!window.confirm(`Disconnect @${server.nickname}? Threads that mention it will no longer load it.`)) return;
    setBusyId(server.id);
    try {
      const result = await window.orion.removeOrionMcp({ id: server.id });
      if (!result?.ok) setError(result?.error ?? `Could not remove @${server.nickname}.`);
      else setNotice(`Disconnected @${server.nickname}.`);
    } finally {
      if (mountedRef.current) setBusyId(null);
      await refresh();
      notifyOrionMcpsChanged();
    }
  };

  const handleReconnect = async (server: OrionMcpEntry) => {
    if (!window.orion?.reconnectOrionMcp) return;
    setBusyId(server.id);
    setPendingSignInId(server.auth === 'oauth' ? server.id : null);
    setError(null);
    setNotice(null);
    try {
      const result = await window.orion.reconnectOrionMcp({ id: server.id });
      if (!mountedRef.current) return;
      if (!result?.ok) setError(result?.error ?? `Could not reconnect @${server.nickname}.`);
      else {
        const toolCount = result.tools?.length ?? 0;
        setNotice(`@${server.nickname} is working · ${toolCount} tool${toolCount === 1 ? '' : 's'}.`);
      }
    } finally {
      if (mountedRef.current) {
        setBusyId(null);
        setPendingSignInId(null);
      }
      await refresh();
    }
  };

  const activeCount = servers.filter((server) => server.enabled).length;
  const isHttp = form?.transport === 'http';

  return (
    <>
      <div className="settings-group-label">Durango Code MCPs</div>
      <div className="settings-group">
        <div className="skills-toolbar">
          <div className="skills-toolbar-main">
            <div className="skills-toolbar-total">
              {loading && servers.length === 0
                ? 'Reading connected MCPs...'
                : `${servers.length} connected · ${activeCount} always on`}
            </div>
            <div className="skills-toolbar-caption">
              Connect an MCP server once to use it with compatible providers. Mention it as @nickname in a message to
              load it for that thread, even while it is switched off. Switch it on to load it in every thread.
              HTTP servers require provider support; Muse supports local servers only.
            </div>
          </div>
          <div className="skills-toolbar-actions">
            <button
              type="button"
              className="btn small"
              disabled={Boolean(form) || connecting}
              onClick={() => {
                setForm(emptyAddForm);
                setError(null);
                setNotice(null);
              }}
            >
              <Plus size={13} />
              Add MCP
            </button>
          </div>
        </div>

        {error && <div className="skills-message error">{error}</div>}
        {notice && !error && <div className="skills-message">{notice}</div>}

        {form && (
          <div className="mcp-add-form">
            <div className="mcp-add-segmented" role="tablist" aria-label="Server type">
              {(
                [
                  { value: 'http', label: 'Remote URL', Icon: Globe },
                  { value: 'stdio', label: 'Local command', Icon: TerminalSquare },
                ] as const
              ).map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={form.transport === value}
                  className={form.transport === value ? 'active' : ''}
                  disabled={connecting}
                  onClick={() => updateForm({ transport: value })}
                >
                  <Icon size={13} />
                  {label}
                </button>
              ))}
            </div>

            <label className="mcp-add-field">
              <span>{isHttp ? 'Server URL' : 'Command'}</span>
              <input
                type="text"
                className="skills-filter-input"
                placeholder={
                  isHttp ? 'https://mcp.durango.sh/mcp' : 'npx -y @modelcontextprotocol/server-filesystem ~/Documents'
                }
                value={form.source}
                disabled={connecting}
                autoFocus
                spellCheck={false}
                onChange={(event) => updateForm({ source: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleConnect();
                }}
              />
            </label>

            <label className="mcp-add-field">
              <span>Nickname</span>
              <div className="mcp-add-nickname">
                <span aria-hidden>@</span>
                <input
                  type="text"
                  className="skills-filter-input"
                  placeholder="durango"
                  value={form.nickname}
                  disabled={connecting}
                  spellCheck={false}
                  maxLength={32}
                  onChange={(event) =>
                    updateForm({
                      nickname: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''),
                      nicknameEdited: true,
                    })
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleConnect();
                  }}
                />
              </div>
              <em>Mention @{form.nickname || 'nickname'} in any thread to use this server there.</em>
            </label>

            {form.showSecrets ? (
              <label className="mcp-add-field">
                <span>{isHttp ? 'Headers' : 'Environment'}</span>
                <textarea
                  className="skills-filter-input mcp-add-textarea"
                  placeholder={isHttp ? 'Authorization: Bearer sk-...' : 'API_KEY=...'}
                  value={form.secrets}
                  disabled={connecting}
                  spellCheck={false}
                  rows={3}
                  onChange={(event) => updateForm({ secrets: event.target.value })}
                />
                <em>
                  {isHttp
                    ? 'One “Name: value” per line. Leave empty to sign in with OAuth when the server asks for it.'
                    : 'One KEY=value per line, passed to the server process.'}
                </em>
              </label>
            ) : (
              <button
                type="button"
                className="mcp-add-link"
                disabled={connecting}
                onClick={() => updateForm({ showSecrets: true })}
              >
                {isHttp ? '+ Add headers (API key)' : '+ Add environment variables'}
              </button>
            )}

            <label className="mcp-add-toggle">
              <span className="provider-toggle">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  disabled={connecting}
                  onChange={(event) => updateForm({ enabled: event.target.checked })}
                />
                <span />
              </span>
              <span>
                Load in every thread
                <em>{form.enabled ? 'Always available to agents.' : 'Off: loaded only where you @mention it.'}</em>
              </span>
            </label>

            <div className="mcp-add-actions">
              {connecting && isHttp && (
                <span className="mcp-add-status">Connecting… finish signing in in your browser if it opened.</span>
              )}
              {connecting && !isHttp && <span className="mcp-add-status">Starting the server…</span>}
              <button
                type="button"
                className="btn secondary small"
                onClick={() => {
                  cancelPendingAdd();
                  setConnecting(false);
                  setForm(null);
                  setError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn small"
                disabled={connecting || !form.source.trim() || !form.nickname.trim()}
                onClick={() => void handleConnect()}
              >
                {connecting ? <RefreshCw size={13} className="spinning" /> : <Plus size={13} />}
                Connect
              </button>
            </div>
          </div>
        )}

        {!loading && servers.length === 0 && !form && (
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-label-desc">
                No MCPs connected to Durango Code yet. Add one with a URL (OAuth sign-in happens automatically) or a local
                command.
              </div>
            </div>
          </div>
        )}

        {servers.length > 0 && (
          <div className="skills-list">
            {servers.map((server) => {
              const busy = busyId === server.id;
              const needsSignIn = server.status === 'needs-sign-in';
              return (
                <div key={server.id} className={`skills-row${server.enabled ? '' : ' inactive'}`}>
                  <div className="skills-row-main">
                    <div className="skills-row-head">
                      <div className="mcp-row-name truncate" title={`@${server.nickname}`}>
                        @{server.nickname}
                      </div>
                      {!server.enabled && <span className="provider-status-chip">@ only</span>}
                      {needsSignIn && <span className="provider-status-chip unauthenticated">Sign in needed</span>}
                    </div>
                    <div className="skills-row-desc">
                      {server.transport === 'http' ? 'HTTP' : 'Local'} MCP server
                      {server.detail ? ` · ${server.detail}` : ''}
                    </div>
                    <div className="skills-row-meta truncate">
                      Durango Code
                      {server.auth === 'oauth' ? ' · OAuth' : ''}
                      {server.headerNames.length ? ` · ${server.headerNames.join(', ')}` : ''}
                      {server.envNames.length ? ` · ${server.envNames.join(', ')}` : ''}
                    </div>
                  </div>
                  {pendingSignInId === server.id ? (
                    <button
                      type="button"
                      className="btn secondary small"
                      onClick={() => void window.orion?.cancelOrionMcpSignIn?.({ id: server.id })}
                    >
                      Cancel sign-in
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="settings-item-action"
                      title={server.auth === 'oauth' ? 'Sign in again and test' : 'Test connection'}
                      disabled={busy}
                      onClick={() => void handleReconnect(server)}
                    >
                      {server.auth === 'oauth' ? <LogIn size={13} /> : <RefreshCw size={13} />}
                    </button>
                  )}
                  <button
                    type="button"
                    className="settings-item-action danger"
                    title="Disconnect this MCP"
                    disabled={busy}
                    onClick={() => void handleRemove(server)}
                  >
                    <Trash2 size={13} />
                  </button>
                  <label
                    className="provider-toggle"
                    title={server.enabled ? 'Only load where @mentioned' : 'Load in every thread'}
                  >
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      disabled={busy}
                      onChange={(event) => void handleToggle(server, event.target.checked)}
                    />
                    <span />
                  </label>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
});

const providerLabel = (provider: ProviderMcpSource['provider']) => (provider === 'claude' ? 'Claude Code' : 'Codex');

const projectName = (projectPath?: string) => projectPath?.split(/[\\/]/).filter(Boolean).pop() ?? 'project';

const sourceLabel = (source: ProviderMcpSource) => {
  if (source.provider === 'codex') {
    return `Codex${source.authStatus ? ` (${source.authStatus.replaceAll('_', ' ')})` : ''}${
      source.enabled !== source.configuredEnabled ? ' · Durango Code override' : ''
    }`;
  }
  if (source.scope === 'plugin') return `Claude Code (${source.plugin ?? 'plugin'} plugin)`;
  if (source.scope === 'local') return `Claude Code (local to ${projectName(source.projectPath)})`;
  if (source.scope === 'project') return `Claude Code (${projectName(source.projectPath)}/.mcp.json)`;
  return 'Claude Code (user)';
};

// Plugin-managed servers can carry a dozen env names; the first few are enough.
const shortList = (names: string[]) =>
  names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3} more` : names.join(', ');

// Which Orion providers load the server today, without the user @-mentioning it.
const providerCoverage = (entry: ProviderMcpEntry) => {
  if (entry.orion) {
    return {
      label: entry.orion.enabled ? 'All providers' : 'All providers via @',
      className: 'authenticated',
      title: `Shared through Durango Code as @${entry.orion.nickname}`,
    };
  }
  const active = [...new Set(entry.sources.filter((source) => source.enabled).map((source) => source.provider))];
  if (active.length === 0) return { label: 'Off', className: '', title: 'No provider loads this server' };
  const names = active.map(providerLabel);
  return {
    label: active.length === 1 ? `${names[0]} only` : names.join(' + '),
    className: 'limited',
    title: `Only ${names.join(' and ')} runs load this server. Share it to use it with every Durango Code provider.`,
  };
};

const ProviderMcpsSection = React.memo(function ProviderMcpsSection() {
  const projects = useOrionStore((state) => state.projects);
  const projectPaths = React.useMemo(
    () => [...new Set(projects.map((project) => project.path).filter(Boolean))],
    [projects]
  );
  const projectPathsRef = React.useRef(projectPaths);
  projectPathsRef.current = projectPaths;
  const [servers, setServers] = React.useState<ProviderMcpEntry[]>([]);
  const [providerErrors, setProviderErrors] = React.useState<ProviderMcpsListResult['errors']>({});
  const [loading, setLoading] = React.useState(true);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [sharingKey, setSharingKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const mountedRef = React.useRef(true);
  const pendingShareRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const operationId = pendingShareRef.current;
      pendingShareRef.current = null;
      if (operationId) void window.orion?.cancelOrionMcpSignIn?.({ operationId });
    };
  }, []);

  const refresh = React.useCallback(async (options?: { preserveMessage?: boolean; fresh?: boolean }) => {
    if (!window.orion?.listProviderMcps) {
      setLoading(false);
      setError('This build of Durango Code cannot read provider MCP servers. Restart the app after updating.');
      return;
    }
    setLoading(true);
    try {
      const result = await window.orion.listProviderMcps({
        projectPaths: projectPathsRef.current,
        fresh: options?.fresh ?? true,
      });
      if (!mountedRef.current) return;
      setServers(result?.servers ?? []);
      setProviderErrors(result?.errors ?? {});
      if (result?.ok === false) setError(result.error ?? 'Could not read provider MCP servers.');
      else if (!options?.preserveMessage) setError(null);
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Connecting, removing or toggling an Orion MCP changes which rows are shared.
  React.useEffect(() => {
    const onChanged = () => void refresh({ preserveMessage: true, fresh: false });
    window.addEventListener(ORION_MCPS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ORION_MCPS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  const handleCodexToggle = async (source: ProviderMcpSource, enabled: boolean) => {
    if (!window.orion?.setMcpEnabled) return;
    setBusyId(source.id);
    setServers((current) =>
      current.map((entry) => ({
        ...entry,
        sources: entry.sources.map((candidate) => (candidate.id === source.id ? { ...candidate, enabled } : candidate)),
      }))
    );
    let failed = false;
    try {
      const result = await window.orion.setMcpEnabled({ id: source.name, enabled });
      failed = !result?.ok;
      if (failed && mountedRef.current) {
        setError(result?.error ?? `Could not ${enabled ? 'enable' : 'disable'} ${source.name} for Codex.`);
      }
    } catch (caught) {
      failed = true;
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (mountedRef.current) setBusyId(null);
      await refresh({ preserveMessage: failed });
    }
  };

  const handleShare = async (entry: ProviderMcpEntry) => {
    if (!window.orion?.shareProviderMcp || pendingShareRef.current) return;
    const operationId = crypto.randomUUID();
    pendingShareRef.current = operationId;
    setSharingKey(entry.key);
    setError(null);
    setNotice(null);
    let failed = false;
    try {
      const result = await window.orion.shareProviderMcp({
        key: entry.key,
        projectPaths: projectPathsRef.current,
        operationId,
      });
      if (!mountedRef.current || pendingShareRef.current !== operationId) return;
      failed = !result?.ok;
      if (!result?.ok) {
        setError(result?.error ?? `Could not share ${entry.name}.`);
        return;
      }
      const toolCount = result.tools?.length ?? 0;
      setNotice(
        `Shared ${entry.name} as @${result.server?.nickname ?? entry.name} · ${toolCount} tool${
          toolCount === 1 ? '' : 's'
        }. Every Durango Code provider loads it now; switch it to @-only under Durango Code MCPs.`
      );
      notifyOrionMcpsChanged();
    } catch (caught) {
      failed = true;
      if (mountedRef.current && pendingShareRef.current === operationId) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (pendingShareRef.current === operationId) {
        pendingShareRef.current = null;
        if (mountedRef.current) setSharingKey(null);
      }
      if (mountedRef.current) await refresh({ preserveMessage: failed, fresh: false });
    }
  };

  const cancelShare = () => {
    const operationId = pendingShareRef.current;
    pendingShareRef.current = null;
    setSharingKey(null);
    if (operationId) void window.orion?.cancelOrionMcpSignIn?.({ operationId });
  };

  const query = search.trim().toLowerCase();
  const visible = query
    ? servers.filter((entry) =>
        `${entry.name} ${entry.transport} ${entry.detail ?? ''} ${entry.sources.map(sourceLabel).join(' ')}`
          .toLowerCase()
          .includes(query)
      )
    : servers;
  const unsharedCount = servers.filter((entry) => !entry.orion).length;
  const providerErrorLines = (Object.entries(providerErrors) as Array<[ProviderMcpSource['provider'], string]>).map(
    ([provider, message]) => `${providerLabel(provider)}: ${message}`
  );

  return (
    <>
      <div className="settings-group-label">From Claude Code &amp; Codex</div>
      <div className="settings-group">
        <div className="skills-toolbar">
          <div className="skills-toolbar-main">
            <div className="skills-toolbar-total">
              {loading && servers.length === 0
                ? 'Reading MCP servers...'
                : `${servers.length} MCP${servers.length === 1 ? '' : 's'} · ${unsharedCount} not shared with Durango Code`}
            </div>
            <div className="skills-toolbar-caption">
              Servers you connected to Claude Code (claude mcp add, plugins, .mcp.json) or Codex only load when that
              provider runs. Share one to connect it to Durango Code so compatible providers can use it. Codex toggles only change
              Codex runs in Durango Code; your underlying setup stays intact.
            </div>
          </div>
          <div className="skills-toolbar-actions">
            <button
              type="button"
              className="btn secondary small"
              disabled={loading}
              onClick={() => void refresh()}
              title="Re-read Claude Code and Codex MCP servers"
            >
              <RefreshCw size={13} className={loading ? 'spinning' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {error && <div className="skills-message error">{error}</div>}
        {notice && !error && <div className="skills-message">{notice}</div>}
        {providerErrorLines.map((line) => (
          <div key={line} className="skills-message">
            {line}
          </div>
        ))}

        {servers.length > 6 && (
          <div className="skills-filter">
            <input
              type="text"
              className="skills-filter-input"
              placeholder="Filter MCPs"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        )}

        {!loading && servers.length === 0 && !error && (
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-label-desc">
                Neither Claude Code nor Codex has MCP servers configured. Servers you add there show up here.
              </div>
            </div>
          </div>
        )}

        {servers.length > 0 && visible.length === 0 && (
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-label-desc">No MCP matches “{search.trim()}”.</div>
            </div>
          </div>
        )}

        {visible.length > 0 && (
          <div className="skills-list">
            {visible.map((entry) => {
              const coverage = providerCoverage(entry);
              const codexSource = entry.sources.find((source) => source.provider === 'codex');
              const sharing = sharingKey === entry.key;
              const active = Boolean(entry.orion) || entry.sources.some((source) => source.enabled);
              return (
                <div key={entry.key} className={`skills-row${active ? '' : ' inactive'}`}>
                  <div className="skills-row-main">
                    <div className="skills-row-head">
                      <div className="mcp-row-name truncate" title={entry.name}>
                        {entry.name}
                      </div>
                      <span className={`provider-status-chip ${coverage.className}`} title={coverage.title}>
                        {coverage.label}
                      </span>
                    </div>
                    <div className="skills-row-desc">
                      {transportLabel(entry.transport)} MCP server
                      {entry.detail ? ` · ${entry.detail}` : ''}
                    </div>
                    <div className="skills-row-meta truncate">
                      {entry.sources.map(sourceLabel).join(' · ')}
                      {entry.orion ? ` · Durango Code (@${entry.orion.nickname})` : ''}
                      {entry.headerNames.length ? ` · ${shortList(entry.headerNames)}` : ''}
                      {entry.envNames.length ? ` · ${shortList(entry.envNames)}` : ''}
                    </div>
                    {sharing && (
                      <div className="skills-row-meta">
                        Connecting to Durango Code… finish signing in in your browser if it opened.
                      </div>
                    )}
                  </div>
                  {!entry.orion &&
                    (sharing ? (
                      <button type="button" className="btn secondary small" onClick={cancelShare}>
                        Cancel
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn secondary small"
                        disabled={Boolean(sharingKey) || Boolean(entry.shareBlockedReason)}
                        title={
                          entry.shareBlockedReason ??
                          'Connect this server to Durango Code so Claude Code, Codex, Cursor, Grok and every other provider can use it'
                        }
                        onClick={() => void handleShare(entry)}
                      >
                        <Share2 size={13} />
                        Share with all
                      </button>
                    ))}
                  {codexSource ? (
                    <label
                      className="provider-toggle"
                      title={codexSource.enabled ? 'Stop loading in Codex runs' : 'Load in Codex runs'}
                    >
                      <input
                        type="checkbox"
                        checked={codexSource.enabled}
                        disabled={busyId === codexSource.id}
                        onChange={(event) => void handleCodexToggle(codexSource, event.target.checked)}
                      />
                      <span />
                    </label>
                  ) : (
                    <span className="provider-toggle-spacer" aria-hidden />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
});

// Connectors added on durango.sh (Settings → Connectors). Read-only here:
// they're managed on the account, and runs load them next to the servers above.
const AccountConnectorsSection = React.memo(function AccountConnectorsSection() {
  const [result, setResult] = React.useState<AccountConnectorsListResult | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async () => {
    if (!window.orion?.listAccountConnectors) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setResult(await window.orion.listAccountConnectors());
    } catch (caught) {
      setResult({ ok: false, signedIn: true, connectors: [], error: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!window.orion?.listAccountConnectors) return null;
  const connectors = result?.connectors ?? [];

  return (
    <>
      <div className="settings-group-label">From your Durango account</div>
      <div className="settings-group">
        <div className="skills-toolbar">
          <div className="skills-toolbar-main">
            <div className="skills-toolbar-total">
              {loading && !result
                ? 'Reading connectors...'
                : result?.signedIn === false
                  ? 'Not signed in to Durango'
                  : `${connectors.length} connector${connectors.length === 1 ? '' : 's'}`}
            </div>
            <div className="skills-toolbar-caption">
              Apps and MCP servers you connect in Durango (Settings → Connectors) load in every run while Durango Code is
              signed in to the same account. Their sign-ins stay on Durango; a server above with the same name takes
              precedence.
            </div>
          </div>
          <div className="skills-toolbar-actions">
            <button
              type="button"
              className="btn secondary small"
              disabled={loading}
              onClick={() => void refresh()}
              title="Re-read connectors from your Durango account"
            >
              <RefreshCw size={13} className={loading ? 'spinning' : ''} />
              Refresh
            </button>
            {result?.manageUrl && result.signedIn !== false && (
              <button
                type="button"
                className="btn secondary small"
                onClick={() => void window.orion?.openExternalUrl(result.manageUrl!)}
                title="Add or remove connectors on Durango"
              >
                <ExternalLink size={13} />
                Manage
              </button>
            )}
          </div>
        </div>

        {result?.ok === false && result.error && <div className="skills-message error">{result.error}</div>}

        {result?.signedIn === false && (
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-label-desc">
                Sign in to Durango (Settings → Account) to use the connectors on your account. The MCP servers above work
                without it.
              </div>
            </div>
          </div>
        )}

        {result?.signedIn && result.ok && connectors.length === 0 && (
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-label-desc">
                No connectors on your Durango account yet. Connect Notion or any remote MCP server there and it shows up
                here.
              </div>
            </div>
          </div>
        )}

        {connectors.length > 0 && (
          <div className="skills-list">
            {connectors.map((connector) => (
              <div key={connector.id} className="skills-row">
                <div className="skills-row-main">
                  <div className="skills-row-head">
                    <div className="mcp-row-name truncate" title={connector.name}>
                      {connector.name}
                    </div>
                  </div>
                  <div className="skills-row-desc">Durango connector · mcp__{connector.serverName}__*</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
});

const McpsSettings = React.memo(function McpsSettings() {
  return (
    <>
      <OrionMcpsSection />
      <AccountConnectorsSection />
      <ProviderMcpsSection />
    </>
  );
});

export default McpsSettings;
