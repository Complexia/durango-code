// ---------------------------------------------------------------------------
// On-demand MCP server loading for Claude Agent SDK sessions (both Durango
// Code threads in claude-driver.js and bot replies in bot-replies.js).
//
// MCP servers connected to Durango Code or to the Durango account (Notion,
// Whoop, Cronometer, ...) are not connected when a session starts or a turn
// begins: the agent loads the ones a task needs with `load_tools`, mid-turn.
// They join the live session over the SDK control channel (`setMcpServers`)
// rather than `mcpServers` (which the SDK puts on the CLI's argv, exposing
// OAuth tokens and device keys to `ps`).
//
// Pure Node (no Electron imports) so both desktop drivers and unit tests use
// the exact same code.
// ---------------------------------------------------------------------------

export const CLAUDE_MCP_SYNC_TIMEOUT_MS = 20_000;
export const CLAUDE_MCP_LOAD_TIMEOUT_MS = 30_000;

export const liveClaudeMcpServers = (session) => {
  const available = session.orionMcpServers ?? {};
  const live = {};
  for (const name of session.loadedMcpServers ?? []) {
    if (name in available) live[name] = available[name];
  }
  return live;
};

export const setClaudeLiveMcpServers = async (
  session,
  timeoutMs,
  { baseServerName = 'orion', getBaseServer = (target) => target.orionMcpServer } = {}
) => {
  const next = liveClaudeMcpServers(session);
  const key = JSON.stringify(next);
  const previous = session.liveMcpNames ?? [];
  const removed = previous.filter((name) => !(name in next));
  if (key === (session.orionMcpKey === undefined ? '{}' : session.orionMcpKey)) return {};
  const baseServer = getBaseServer(session);
  if (!session.query || !baseServer) return {};
  if (typeof session.query.setMcpServers !== 'function') {
    throw new Error('This Claude Code runtime does not support loading MCP servers on demand.');
  }
  // A partial failure can change the live set. Invalidate the previous key
  // until every server is synchronized, including when reverting to that set.
  session.orionMcpKey = null;
  session.liveMcpNames = [...new Set([...previous, ...Object.keys(next)])];
  let timer;
  try {
    const result = await Promise.race([
      session.query.setMcpServers({ ...next, [baseServerName]: baseServer }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out connecting MCP servers.')), timeoutMs);
      }),
    ]);
    const errors = result?.errors && typeof result.errors === 'object' ? result.errors : {};
    if (removed.length > 0 && Object.keys(errors).length > 0) {
      throw new Error(`Could not confirm MCP removal: ${removed.join(', ')}.`);
    }
    if (Object.keys(errors).length === 0) {
      session.orionMcpKey = key;
      session.liveMcpNames = Object.keys(next);
    }
    return errors;
  } finally {
    clearTimeout(timer);
  }
};

// Called before every turn with the servers the agent may load. Returns
// per-server errors; throws when the live tool set is unknown, and the caller
// must then discard the session before another prompt can use stale tools.
export const syncClaudeMcpServers = async (session, servers = {}, options = {}) => {
  session.orionMcpServers = servers && typeof servers === 'object' ? servers : {};
  try {
    return await setClaudeLiveMcpServers(session, CLAUDE_MCP_SYNC_TIMEOUT_MS, options);
  } catch (error) {
    throw new Error(`Could not synchronize MCP servers: ${error?.message ?? String(error)}`, { cause: error });
  }
};

const availableClaudeMcpList = (session) => {
  const names = Object.keys(session.orionMcpServers ?? {});
  return names.length > 0 ? names.join(', ') : 'none';
};

export const loadToolsDescription = (session) =>
  "Load the tools of an app the user connected (an MCP server such as Notion or Gmail), then call them directly. " +
  "Their tools are not loaded until you load the app, so load one only when the task needs it. " +
  `Apps available when this session started: ${availableClaudeMcpList(session)}. ` +
  "Call with no apps for the current list. If a tool of an app you loaded earlier is missing, load the app again.";

// `load_tools`: connects the named servers mid-turn. Loads are queued so
// concurrent calls never race the control channel. Never throws: the agent
// gets a readable outcome and the turn goes on.
export const loadClaudeMcpServers = (session, apps, options = {}) => {
  const run = async () => {
    const available = session.orionMcpServers ?? {};
    const requested = [...new Set((Array.isArray(apps) ? apps : []).map((app) => String(app).trim().replace(/^@/, '')).filter(Boolean))];
    if (requested.length === 0) {
      return `Apps you can load: ${availableClaudeMcpList(session)}.`;
    }
    const unknown = requested.filter((name) => !(name in available));
    const wanted = requested.filter((name) => name in available);
    const lines = [];
    if (wanted.length > 0) {
      const before = session.loadedMcpServers ?? [];
      session.loadedMcpServers = [...new Set([...before, ...wanted])];
      let errors = {};
      try {
        errors = await setClaudeLiveMcpServers(session, CLAUDE_MCP_LOAD_TIMEOUT_MS, options);
      } catch (error) {
        // Unknown live state: forget the key so the next load or turn retries.
        session.orionMcpKey = null;
        session.loadedMcpServers = before;
        return `Could not load ${wanted.join(', ')}: ${error?.message ?? String(error)}`;
      }
      const failed = wanted.filter((name) => errors[name]);
      if (failed.length > 0) {
        session.loadedMcpServers = session.loadedMcpServers.filter((name) => !failed.includes(name));
        lines.push(
          ...failed.map((name) => `Could not connect ${name}: ${String(errors[name]).slice(0, 300)}`)
        );
      }
      const loaded = wanted.filter((name) => !failed.includes(name));
      if (loaded.length > 0) {
        lines.push(
          `Loaded ${loaded.join(', ')}. Their tools are named ${loaded.map((name) => `mcp__${name}__<tool>`).join(', ')}; call them directly (find a tool's schema with ToolSearch if it is not in your tool list yet).`
        );
      }
    }
    if (unknown.length > 0) {
      lines.push(`Not connected: ${unknown.join(', ')}. Apps you can load: ${availableClaudeMcpList(session)}.`);
    }
    return lines.join('\n');
  };
  const pending = (session.mcpLoadChain ?? Promise.resolve()).then(run, run);
  session.mcpLoadChain = pending.catch(() => {});
  return pending;
};
