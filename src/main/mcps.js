import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileAsync, loginShell, shellQuote, shellPathSyncPromise } from './shell-env.js';

const settingsFileName = 'mcp-settings.json';
const reservedServerNames = new Set(['orion']);
let settingsMutationQueue = Promise.resolve();

export const mcpSettingsPath = () =>
  process.env.ORION_MCP_SETTINGS_PATH || path.join(app.getPath('userData'), settingsFileName);

const isPlainRecord = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeOverrides = (value) => {
  const source = isPlainRecord(value?.servers) ? value.servers : value;
  if (!isPlainRecord(source)) return {};
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name, enabled]) =>
        typeof name === 'string' &&
        name.trim().length > 0 &&
        !reservedServerNames.has(name) &&
        typeof enabled === 'boolean'
    )
  );
};

export const readMcpOverrides = async () => {
  try {
    return normalizeOverrides(JSON.parse(await fs.readFile(mcpSettingsPath(), 'utf-8')));
  } catch {
    return {};
  }
};

const writeMcpOverrides = async (overrides) => {
  const target = mcpSettingsPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(
      temporary,
      `${JSON.stringify({ version: 1, servers: normalizeOverrides(overrides) }, null, 2)}\n`,
      { mode: 0o600 }
    );
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
};

const safeEndpoint = (value) => {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
};

const transportSummary = (transport) => {
  if (!isPlainRecord(transport)) return { transport: 'unknown', detail: null };
  if (transport.type === 'stdio' || typeof transport.command === 'string') {
    const command = typeof transport.command === 'string' ? transport.command : '';
    return {
      transport: 'stdio',
      detail: command ? path.basename(command) : null,
    };
  }
  if (transport.type === 'streamable_http' || transport.type === 'http') {
    return { transport: 'http', detail: safeEndpoint(transport.url) };
  }
  if (transport.type === 'sse') {
    return { transport: 'sse', detail: safeEndpoint(transport.url) };
  }
  return {
    transport: typeof transport.type === 'string' ? transport.type : 'unknown',
    detail: safeEndpoint(transport.url),
  };
};

export const normalizeMcpList = (value, overrides = {}) => {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry) =>
        isPlainRecord(entry) &&
        typeof entry.name === 'string' &&
        entry.name.trim().length > 0 &&
        !reservedServerNames.has(entry.name)
    )
    .map((entry) => {
      const configuredEnabled = entry.enabled !== false;
      const hasOverride = typeof overrides[entry.name] === 'boolean';
      const { transport, detail } = transportSummary(entry.transport);
      return {
        id: entry.name,
        name: entry.name,
        enabled: hasOverride ? overrides[entry.name] : configuredEnabled,
        configuredEnabled,
        transport,
        detail,
        authStatus:
          typeof entry.auth_status === 'string' && entry.auth_status !== 'unsupported'
            ? entry.auth_status
            : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
};

export const readConfiguredMcps = async (options = {}) => {
  await shellPathSyncPromise;
  const codexPath = options.codexPath || 'codex';
  const run =
    options.run ||
    ((command, args, runOptions) => {
      // App-servers run inside a login shell: Finder's environment alone
      // misses CODEX_HOME and PATH exports from the user's shell profile.
      // The shared server starts at home, then resolves each thread's cwd;
      // direct servers start in the project. Preserve that startup context.
      const shellCwd = options.shellCwd ?? runOptions?.cwd;
      const invocation = [command, ...args].map(shellQuote).join(' ');
      const script = runOptions?.cwd && shellCwd !== runOptions.cwd
        ? `cd -- ${shellQuote(runOptions.cwd)} && ${invocation}`
        : invocation;
      const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...options.env };
      // Match the app-server supervisor's environment cleanup.
      delete env.ELECTRON_RUN_AS_NODE;
      return execFileAsync(options.shell || loginShell, ['-lc', script], {
        env,
        cwd: shellCwd,
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
      });
    });
  const configArgs = Array.isArray(options.configArgs) ? options.configArgs : [];
  const { stdout } = await run(
    codexPath,
    [...configArgs, 'mcp', 'list', '--json'],
    { cwd: options.cwd }
  );
  const parsed = JSON.parse(String(stdout || '').trim() || '[]');
  if (!Array.isArray(parsed)) throw new Error('Codex returned an invalid MCP server list.');
  return parsed;
};

export const listMcps = async (options = {}) => {
  try {
    const [configured, overrides] = await Promise.all([
      readConfiguredMcps(options),
      readMcpOverrides(),
    ]);
    return { ok: true, mcps: normalizeMcpList(configured, overrides) };
  } catch (error) {
    return {
      ok: false,
      mcps: [],
      error: error instanceof Error ? error.message : 'Could not read configured MCP servers.',
    };
  }
};

export const setMcpEnabled = async ({ id, enabled }, options = {}) => {
  if (
    typeof id !== 'string' ||
    !id.trim() ||
    reservedServerNames.has(id) ||
    typeof enabled !== 'boolean'
  ) {
    return { ok: false, error: 'Invalid MCP server.' };
  }
  try {
    const listed = await listMcps(options);
    if (!listed.ok) return { ok: false, error: listed.error };
    if (!listed.mcps.some((entry) => entry.id === id)) {
      return { ok: false, error: 'That MCP server is no longer configured.' };
    }
    const configuredEnabled = listed.mcps.find((entry) => entry.id === id).configuredEnabled;
    const update = async () => {
      const overrides = await readMcpOverrides();
      // Returning a toggle to Codex's configured state restores inheritance
      // instead of pinning a redundant Orion override forever.
      if (enabled === configuredEnabled) delete overrides[id];
      else overrides[id] = enabled;
      await writeMcpOverrides(overrides);
    };
    const queued = settingsMutationQueue.then(update, update);
    settingsMutationQueue = queued.catch(() => {});
    await queued;
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not update the MCP server.',
    };
  }
};

const mcpServerConfig = (entry, enabled) => {
  const transport = isPlainRecord(entry?.transport) ? entry.transport : {};
  const config = { enabled };
  for (const key of [
    'command',
    'args',
    'env',
    'env_vars',
    'cwd',
    'url',
    'bearer_token_env_var',
    'http_headers',
    'env_http_headers',
  ]) {
    if (transport[key] !== undefined && transport[key] !== null) config[key] = transport[key];
  }
  if (entry.startup_timeout_sec !== undefined && entry.startup_timeout_sec !== null) {
    config.startup_timeout_sec = entry.startup_timeout_sec;
  }
  if (entry.tool_timeout_sec !== undefined && entry.tool_timeout_sec !== null) {
    config.tool_timeout_sec = entry.tool_timeout_sec;
  }
  return config;
};

/**
 * Build complete app-server config entries for Orion overrides. Plugin MCPs
 * cannot be overridden with `enabled` alone: Codex validates the user layer
 * before merging plugin transports. The full resolved definition stays in the
 * main process and travels only over the local app-server connection.
 */
export const mcpRuntimeConfig = (configured, overrides) => {
  const normalizedOverrides = normalizeOverrides(overrides);
  const byName = new Map(
    (Array.isArray(configured) ? configured : [])
      .filter((entry) => isPlainRecord(entry) && typeof entry.name === 'string')
      .map((entry) => [entry.name, entry])
  );
  const servers = Object.fromEntries(
    Object.entries(normalizedOverrides).flatMap(([name, enabled]) => {
      const entry = byName.get(name);
      return entry ? [[name, mcpServerConfig(entry, enabled)]] : [];
    })
  );
  return Object.keys(servers).length > 0 ? { mcp_servers: servers } : {};
};

export const readMcpRuntimeConfig = async (options = {}) => {
  const overrides = await readMcpOverrides();
  if (Object.keys(overrides).length === 0) return {};
  try {
    return mcpRuntimeConfig(await readConfiguredMcps(options), overrides);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not apply Durango Code's MCP settings: ${detail}`);
  }
};
