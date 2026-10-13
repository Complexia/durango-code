import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readConfiguredMcps, readMcpOverrides } from './mcps.js';
import { addOrionMcpForOperation, nicknamePattern, readOrionMcpRegistryForMatching, reservedNicknames, withMcpBearerToken, withOrionMcpConnection } from './orion-mcps.js';
import { execFileAsync, loginShell, shellQuote, shellPathSyncPromise } from './shell-env.js';
import { withClaudeEnv } from './claude-env.js';
import { parseExtraArgs } from './models.js';

// ---------------------------------------------------------------------------
// MCP servers the user connected to a provider directly (`claude mcp add`,
// Claude Code plugins, `codex mcp add`) rather than to Orion. Those load only
// when that provider runs. Settings → Skills & MCPs lists them grouped across
// providers, and sharing one copies it into Orion's own registry so every
// provider gets it.
//
// Discovery reads the providers' config files (Claude) or CLI (Codex) in the
// main process. Only names, transports and endpoints reach the renderer; the
// headers and env values are re-read here when a server is shared.

const homeDir = () => os.homedir();
const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), '.claude');
// Claude Code keeps MCP servers in the global config file, which moves into
// CLAUDE_CONFIG_DIR when that is set.
const claudeGlobalConfigPath = () =>
  process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(homeDir(), '.claude.json');

const isPlainRecord = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const stringRecord = (value) =>
  isPlainRecord(value)
    ? Object.fromEntries(Object.entries(value).filter(([key, entry]) => key.trim() && typeof entry === 'string'))
    : {};

const stringList = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []);

const readJson = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return null;
  }
};

const errorMessage = (error, fallback) =>
  (error instanceof Error ? error.message : typeof error === 'string' ? error : '') || fallback;

// --- Identity ----------------------------------------------------------------

const normalizedUrl = (value) => {
  try {
    const url = new URL(value);
    return `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
};

// Matching uses the complete connection, including credentials, only in main.
// The shortened URL above is exclusively for display.
const connectionIdentity = (source, defaultCwd) => {
  if (!source) return null;
  const server = 'connection' in source ? source.connection : source;
  if (!server) return null;
  if (server?.url) {
    try {
      const url = new URL(server.url).href;
      const headers = [...new Headers(stringRecord(server.headers)).entries()].sort(([a], [b]) => a.localeCompare(b));
      return `url:${JSON.stringify([server.transport || 'http', url, headers])}`;
    } catch {
      return null;
    }
  }
  if (typeof server?.command === 'string' && server.command) {
    const cwd = server.cwd || source.projectPath || defaultCwd || null;
    const env = Object.entries(stringRecord(server.env)).sort(([a], [b]) => a.localeCompare(b));
    return `cmd:${JSON.stringify([server.command, stringList(server.args), cwd, env])}`;
  }
  return null;
};

export const mcpIdentity = (source, defaultCwd) => {
  // Provider-managed OAuth accounts are opaque to Orion. Equal endpoints do
  // not establish equal accounts; never suppress either connection by guess.
  if (source?.authStatus === 'o_auth' || source?.authStatus === 'oauth') return null;
  if (source?.auth === 'oauth' && !source.headers?.Authorization) return null;
  return connectionIdentity(source, defaultCwd);
};

const sourceFingerprint = (source) => {
  const identity = connectionIdentity(source);
  return identity ? createHash('sha256').update(identity).digest('hex') : null;
};

// Arguments can contain credentials in any position, including after short
// flags. Only the executable name is safe to include in a public description.
const publicDetail = (source) => {
  if (source.url) return normalizedUrl(source.url);
  return source.command ? path.basename(source.command) : null;
};

// --- Claude Code -----------------------------------------------------------------

const claudeTransport = (config) => {
  const type = typeof config.type === 'string' ? config.type : config.command ? 'stdio' : config.url ? 'http' : '';
  if (type === 'stdio' || type === 'http' || type === 'sse' || type === 'ws') return type;
  return 'unknown';
};

const claudeSource = (name, config, { scope, projectPath, plugin, pluginRoot }) => {
  if (!isPlainRecord(config) || !name) return null;
  const transport = claudeTransport(config);
  const scopeId = scope === 'plugin' ? `${plugin}${projectPath ? `:${projectPath}` : ''}` : projectPath ?? '';
  return {
    id: `claude:${scope}:${scopeId}:${name}`,
    provider: 'claude',
    name,
    scope,
    ...(projectPath ? { projectPath } : {}),
    ...(plugin ? { plugin, pluginRoot } : {}),
    transport,
    url: typeof config.url === 'string' ? config.url : null,
    command: typeof config.command === 'string' ? config.command : null,
    args: stringList(config.args),
    headers: stringRecord(config.headers),
    env: stringRecord(config.env),
    headersHelper: typeof config.headersHelper === 'string' && Boolean(config.headersHelper),
    enabled: true,
  };
};

const sourcesFromMap = (servers, options) =>
  isPlainRecord(servers)
    ? Object.entries(servers)
        .map(([name, config]) => claudeSource(name, config, options))
        .filter(Boolean)
    : [];

// `.mcp.json` files hold either { mcpServers: {...} } or the map itself.
const mcpJsonServers = (parsed) =>
  isPlainRecord(parsed?.mcpServers) ? parsed.mcpServers : isPlainRecord(parsed) ? parsed : {};

const readPluginServers = async (pluginRoot) => {
  const manifest = await readJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
  const declared = manifest?.mcpServers;
  if (isPlainRecord(declared)) return declared;
  const files = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? stringList(declared) : ['.mcp.json'];
  const merged = {};
  for (const file of files) {
    Object.assign(merged, mcpJsonServers(await readJson(path.resolve(pluginRoot, file))));
  }
  return merged;
};

const readClaudeSettings = (projectPath) => Promise.all([
  readJson(path.join(claudeConfigDir(), 'settings.json')),
  ...(projectPath ? [
    readJson(path.join(projectPath, '.claude', 'settings.json')),
    readJson(path.join(projectPath, '.claude', 'settings.local.json')),
  ] : []),
]);

// Plugin flags merge by key, with project and local settings overriding the
// user's defaults. Only installations applicable to this project may load.
const readClaudePluginSources = async (projectPath) => {
  const installed = await readJson(path.join(claudeConfigDir(), 'plugins', 'installed_plugins.json'));
  if (!isPlainRecord(installed?.plugins)) return [];
  const settings = await readClaudeSettings(projectPath);
  const enabledPlugins = Object.assign({}, ...settings.map((entry) =>
    isPlainRecord(entry?.enabledPlugins) ? entry.enabledPlugins : {}));
  const sources = [];
  const priority = { user: 0, project: 1, local: 2, managed: 3 };
  for (const [key, records] of Object.entries(installed.plugins)) {
    const record = (Array.isArray(records) ? records : [records])
      .filter((entry) => isPlainRecord(entry) && typeof entry.installPath === 'string' &&
        (entry.scope === 'user' || entry.scope === 'managed' ||
          (projectPath && entry.projectPath === projectPath)))
      .sort((a, b) => (priority[b.scope] ?? -1) - (priority[a.scope] ?? -1))[0];
    if (!record || enabledPlugins[key] !== true) continue;
    const plugin = key.split('@')[0];
    const servers = await readPluginServers(record.installPath);
    sources.push(...sourcesFromMap(servers, { scope: 'plugin', plugin, pluginRoot: record.installPath, projectPath }));
  }
  return sources;
};

// Project MCP exclusions are settings, not fields in ~/.claude.json's
// project record. Claude reads all three settings scopes for these lists.
const readProjectMcpPolicy = async (projectPath) => {
  const settings = await readClaudeSettings(projectPath);
  return {
    disabled: new Set(settings.flatMap((entry) => stringList(entry?.disabledMcpjsonServers))),
    enabled: new Set(settings.flatMap((entry) => stringList(entry?.enabledMcpjsonServers))),
    enableAll: settings.reduce((enabled, entry) =>
      typeof entry?.enableAllProjectMcpServers === 'boolean' ? entry.enableAllProjectMcpServers : enabled, false),
  };
};

/**
 * Every MCP server Claude Code would load somewhere: user scope, local scope
 * (per project, from the global config), project `.mcp.json` files for the
 * given projects, and enabled plugins. claude.ai connectors live in the
 * user's claude.ai account and are not visible locally.
 */
export const readClaudeCodeMcpSources = async ({ projectPaths = [] } = {}) => {
  const global = (await readJson(claudeGlobalConfigPath())) ?? {};
  const sources = sourcesFromMap(global.mcpServers, { scope: 'user' });
  const projects = isPlainRecord(global.projects) ? global.projects : {};
  for (const [projectPath, project] of Object.entries(projects)) {
    const disabled = new Set(stringList(project?.disabledMcpServers));
    sources.push(...sourcesFromMap(project?.mcpServers, { scope: 'local', projectPath })
      .map((source) => ({ ...source, enabled: !disabled.has(source.name) })));
  }
  for (const projectPath of new Set(projectPaths.filter((entry) => typeof entry === 'string' && entry))) {
    const policy = await readProjectMcpPolicy(projectPath);
    const servers = mcpJsonServers(await readJson(path.join(projectPath, '.mcp.json')));
    sources.push(
      ...sourcesFromMap(servers, { scope: 'project', projectPath })
        .map((source) => ({ ...source, enabled: !policy.disabled.has(source.name) &&
          (policy.enableAll || policy.enabled.has(source.name)) }))
    );
  }
  sources.push(...(await readClaudePluginSources()));
  for (const projectPath of new Set(projectPaths.filter((entry) => typeof entry === 'string' && entry))) {
    sources.push(...(await readClaudePluginSources(projectPath)));
  }
  return sources;
};

// --- Codex -------------------------------------------------------------------------

const codexTransport = (type) => {
  if (type === 'stdio') return 'stdio';
  if (type === 'streamable_http' || type === 'http') return 'http';
  if (type === 'sse') return 'sse';
  return 'unknown';
};

const codexSources = (configured, overrides = {}) =>
  (Array.isArray(configured) ? configured : [])
    .filter((entry) => isPlainRecord(entry) && typeof entry.name === 'string' && entry.name && entry.name !== 'orion')
    .map((entry) => {
      const transport = isPlainRecord(entry.transport) ? entry.transport : {};
      const configuredEnabled = entry.enabled !== false;
      return {
        id: `codex:config::${entry.name}`,
        provider: 'codex',
        name: entry.name,
        scope: 'config',
        transport: codexTransport(transport.type ?? (transport.command ? 'stdio' : '')),
        url: typeof transport.url === 'string' ? transport.url : null,
        command: typeof transport.command === 'string' ? transport.command : null,
        args: stringList(transport.args),
        cwd: typeof transport.cwd === 'string' && transport.cwd ? transport.cwd : null,
        headers: stringRecord(transport.http_headers),
        headersHelper: typeof transport.http_headers_helper === 'string' && Boolean(transport.http_headers_helper),
        env: stringRecord(transport.env),
        envVars: stringList(transport.env_vars),
        envHttpHeaders: stringRecord(transport.env_http_headers),
        bearerTokenEnvVar: typeof transport.bearer_token_env_var === 'string' ? transport.bearer_token_env_var : null,
        authStatus:
          typeof entry.auth_status === 'string' && entry.auth_status !== 'unsupported' ? entry.auth_status : null,
        configuredEnabled,
        enabled: typeof overrides[entry.name] === 'boolean' ? overrides[entry.name] : configuredEnabled,
      };
    });

// `codex mcp list` spawns the CLI, so runs reuse a recent answer.
const CODEX_LIST_CACHE_MS = 60_000;
const codexListCache = new Map();
const readCodexConfigured = async (options = {}) => {
  options = { ...options, shellCwd: options.shellCwd ?? options.cwd ?? homeDir() };
  const key = JSON.stringify([options.cwd ?? null, options.shellCwd ?? null, options.configArgs ?? []]);
  const cached = codexListCache.get(key);
  if (!options.fresh && cached && Date.now() - cached.at < CODEX_LIST_CACHE_MS) return cached.promise;
  const promise = readConfiguredMcps(options);
  codexListCache.set(key, { at: Date.now(), promise });
  promise.catch(() => codexListCache.delete(key));
  return promise;
};

export const readCodexMcpSources = async (options = {}) => {
  const [configured, overrides] = await Promise.all([readCodexConfigured(options), readMcpOverrides()]);
  return codexSources(configured, overrides);
};

// --- Grouping ------------------------------------------------------------------------

const scopeOrder = { user: 0, plugin: 1, local: 2, project: 3, config: 4 };

const publicSource = (source) => ({
  id: source.id,
  provider: source.provider,
  name: source.name,
  scope: source.scope,
  ...(source.projectPath ? { projectPath: source.projectPath } : {}),
  ...(source.plugin ? { plugin: source.plugin } : {}),
  enabled: source.enabled,
  ...(source.provider === 'codex'
    ? { configuredEnabled: source.configuredEnabled, authStatus: source.authStatus ?? null }
    : {}),
});

const shareBlocker = (source) => {
  if (source.transport === 'sse' || source.transport === 'ws') {
    return `${source.transport.toUpperCase()} servers can't be shared yet; add its streamable HTTP URL in Durango Code instead.`;
  }
  if (source.transport === 'unknown') return 'Durango Code does not recognize this server type.';
  if (source.headersHelper) return 'It gets its headers from a helper script, which Durango Code cannot run.';
  return null;
};

export const nicknameFromName = (name) =>
  String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32);

const availableNickname = (names, registry, nativeNames = []) => {
  const taken = new Set([...registry.map((server) => server.nickname), ...nativeNames]);
  const base = names.map(nicknameFromName).find((name) => nicknamePattern.test(name)) || 'mcp-server';
  for (let index = 1; index < 100; index += 1) {
    const candidate = index === 1 ? base : `${base.slice(0, 29)}-${index}`;
    if (!taken.has(candidate) && !reservedNicknames.has(candidate)) return candidate;
  }
  return null;
};

/**
 * Group equivalent connections and note whether Orion already carries them.
 * Names alone never establish connection equivalence.
 */
export const groupProviderMcps = (sources, registry = []) => {
  const groups = [];
  const sorted = [...sources].sort(
    (a, b) =>
      (a.provider === b.provider ? 0 : a.provider === 'claude' ? -1 : 1) ||
      scopeOrder[a.scope] - scopeOrder[b.scope] ||
      a.name.localeCompare(b.name)
  );
  for (const source of sorted) {
    const identity = mcpIdentity(source);
    const group = groups.find(
      (candidate) => identity && candidate.identities.has(identity)
    );
    if (group) {
      group.sources.push(source);
      if (identity) group.identities.add(identity);
    } else {
      groups.push({ sources: [source], identities: new Set(identity ? [identity] : []) });
    }
  }
  return groups.map((group) => {
    const primary = group.sources[0];
    const orion = registry.find(
      (server) =>
        group.identities.has(mcpIdentity(server)) ||
        group.sources.some((source) => server.sharedFrom?.id === source.id &&
          server.sharedFrom.fingerprint === sourceFingerprint(source))
    );
    const blocker = group.sources.map(shareBlocker).every(Boolean) ? shareBlocker(primary) : null;
    return {
      key: primary.id,
      name: primary.name,
      transport: primary.transport,
      detail: publicDetail(primary),
      sources: group.sources,
      orion: orion ? { id: orion.id, nickname: orion.nickname, enabled: orion.enabled } : null,
      shareBlockedReason: blocker,
      headerNames: [...new Set(group.sources.flatMap((source) => Object.keys(source.headers ?? {})))],
      envNames: [...new Set(group.sources.flatMap((source) => Object.keys(source.env ?? {})))],
    };
  });
};

const toPublicGroup = ({ sources, ...group }) => ({ ...group, sources: sources.map(publicSource) });

const discover = async ({ projectPaths = [], fresh = false } = {}) => {
  const [claude, codex, registry] = await Promise.all([
    readClaudeCodeMcpSources({ projectPaths }).then(resolveProviderConnections).then(
      (sources) => ({ sources }),
      (error) => ({ sources: [], error: errorMessage(error, 'Could not read Claude Code MCP servers.') })
    ),
    readCodexMcpSources({ fresh }).then(resolveProviderConnections).then(
      (sources) => ({ sources }),
      (error) => ({ sources: [], error: errorMessage(error, 'Could not read Codex MCP servers.') })
    ),
    readOrionMcpRegistryForMatching(),
  ]);
  return {
    groups: groupProviderMcps([...claude.sources, ...codex.sources], registry),
    registry,
    errors: {
      ...(claude.error ? { claude: claude.error } : {}),
      ...(codex.error ? { codex: codex.error } : {}),
    },
  };
};

export const listProviderMcps = async (input = {}) => {
  try {
    const { groups, errors } = await discover({
      projectPaths: stringList(input?.projectPaths),
      fresh: input?.fresh !== false,
    });
    return { ok: true, servers: groups.map(toPublicGroup), errors };
  } catch (error) {
    return { ok: false, servers: [], errors: {}, error: errorMessage(error, 'Could not read provider MCP servers.') };
  }
};

// --- Sharing -------------------------------------------------------------------------

// Forwarded to every stdio server anyway; never worth copying into Orion.
const inheritedEnvNames = new Set([
  'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_CACHE_HOME',
]);

// Codex starts in a non-interactive login shell. Read its exported environment
// after startup, including overrides and unsets of Orion's inherited values.
// NUL framing preserves newlines/empty values and excludes startup chatter.
// These credentials remain in main; never surface stdout or shell errors.
const readCodexEnvironment = async (options = {}) => {
  await shellPathSyncPromise;
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...options.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform === 'win32') return env;
  const marker = `ORION_ENV_${randomUUID()}`;
  const script = `printf '\\0%s\\0' ${shellQuote(marker)}; /usr/bin/env -0 && printf '%s\\0' ${shellQuote(marker)}`;
  try {
    const { stdout } = await execFileAsync(options.shell || loginShell, ['-lc', script], {
      cwd: options.shellCwd ?? options.cwd ?? homeDir(),
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
      env,
      signal: options.signal,
    });
    const start = stdout.indexOf(`\0${marker}\0`);
    const end = stdout.indexOf(`${marker}\0`, start + marker.length + 2);
    if (start < 0 || end < 0) throw new Error('Incomplete environment snapshot.');
    return Object.fromEntries(stdout.slice(start + marker.length + 2, end).split('\0')
      .filter((entry) => entry.includes('='))
      .map((entry) => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
  } catch {
    throw new Error('Could not read the Codex launch environment.');
  }
};

// Claude Code expands ${VAR} and ${VAR:-default} in command, args, env, url
// and headers; plugins also get ${CLAUDE_PLUGIN_ROOT}.
const claudeVariablePattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

const expandClaude = (value, variables, missing) =>
  value.replace(claudeVariablePattern, (_, name, fallback) => {
    if (variables[name] !== undefined) return variables[name];
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return '';
  });

const mapValues = (record, map) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]));

/** The addOrionMcp input for a provider source, with secrets resolved. */
export const orionInputForSource = async (source, options = {}) => {
  const blocker = shareBlocker(source);
  if (blocker) return { ok: false, error: blocker };
  const missing = new Set();
  if (source.provider === 'claude') {
    const variables = {
      // Claude's SDK launches its binary directly, without a login shell.
      ...withClaudeEnv({ ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...options.env }),
      ...(source.pluginRoot ? { CLAUDE_PLUGIN_ROOT: source.pluginRoot } : {}),
    };
    const expand = (value) => expandClaude(value, variables, missing);
    const input =
      source.transport === 'http'
        ? { transport: 'http', url: expand(source.url ?? ''), headers: mapValues(source.headers, expand) }
        : {
            transport: 'stdio',
            command: expand(source.command ?? ''),
            args: source.args.map(expand),
            env: mapValues(source.env, expand),
            ...((source.pluginRoot || source.projectPath) ? { cwd: source.pluginRoot || source.projectPath } : {}),
          };
    if (missing.size) {
      return {
        ok: false,
        error: `Claude Code fills in ${[...missing].map((name) => `$${name}`).join(', ')} from its environment, and ${missing.size === 1 ? 'it is' : 'they are'} not available to Durango Code's Claude process.`,
      };
    }
    return { ok: true, input };
  }

  // Codex: env_vars forward named variables, env_http_headers and
  // bearer_token_env_var fill headers from named variables.
  const named = [
    ...source.envVars.filter((name) => !inheritedEnvNames.has(name)),
    ...Object.values(source.envHttpHeaders),
    ...(source.bearerTokenEnvVar ? [source.bearerTokenEnvVar] : []),
  ];
  const variables = named.length ? await (options.readCodexEnv?.() ?? readCodexEnvironment(options)) : {};
  const lookup = (name) => {
    if (variables[name] === undefined) missing.add(name);
    return variables[name] ?? '';
  };
  let input;
  if (source.transport === 'http') {
    const headers = withMcpBearerToken(
      { ...source.headers, ...mapValues(source.envHttpHeaders, lookup) },
      source.bearerTokenEnvVar ? lookup(source.bearerTokenEnvVar) : undefined
    );
    input = { transport: 'http', url: source.url ?? '', headers };
  } else {
    const env = { ...source.env };
    for (const name of source.envVars) {
      if (inheritedEnvNames.has(name)) continue;
      // Codex skips unset forwarded variables; so does Orion.
      if (variables[name] !== undefined) env[name] = variables[name];
    }
    input = {
      transport: 'stdio',
      command: source.command ?? '',
      args: source.args,
      env,
      ...(source.cwd ? { cwd: source.cwd } : {}),
    };
  }
  if (missing.size) {
    return {
      ok: false,
      error: `Codex reads ${[...missing].map((name) => `$${name}`).join(', ')} from your environment, and Durango Code could not find ${missing.size === 1 ? 'it' : 'them'} in your shell.`,
    };
  }
  return { ok: true, input };
};

// Resolve environment references before comparing a native server with the
// copy Orion saved. Unresolved connections are kept, never guessed equal.
const resolveProviderConnections = (sources, options = {}) => {
  // One snapshot per batch keeps comparisons consistent and avoids starting
  // a separate shell for every env-backed server. Never cache across runs.
  let environment;
  const readCodexEnv = () => (environment ??= readCodexEnvironment(options));
  return Promise.all(sources.map(async (source) => {
    try {
      const resolved = await orionInputForSource(source, { ...options, readCodexEnv });
      return { ...source, connection: resolved.ok ? resolved.input : null };
    } catch {
      return { ...source, connection: null };
    }
  }));
};

/**
 * Copy a provider-configured server into Orion so every provider loads it.
 * Uses the same connection operation as addOrionMcp: OAuth servers sign in to Orion in the browser
 * (the provider's own tokens stay with that provider), and nothing is saved
 * until the server answers with its tools.
 */
export const shareProviderMcp = (input = {}) =>
  withOrionMcpConnection(input?.operationId, async (signal) => {
    const { groups, registry } = await discover({ projectPaths: stringList(input?.projectPaths), fresh: true });
    signal.throwIfAborted();
    const group = groups.find((candidate) => candidate.sources.some((source) => source.id === input?.key));
    if (!group) return { ok: false, error: 'That MCP server is no longer configured.' };
    if (group.orion) return { ok: false, error: `Already in Durango Code as @${group.orion.nickname}.` };
    const source = group.sources.find((candidate) => !shareBlocker(candidate));
    if (!source) return { ok: false, error: group.shareBlockedReason ?? 'This server cannot be shared.' };
    const resolved = await orionInputForSource(source);
    signal.throwIfAborted();
    if (!resolved.ok) return resolved;
    // Codex merges same-named definitions. Keep shares independent of its
    // native names, including OAuth accounts and servers later switched off.
    const codexNames = groups.flatMap((entry) => entry.sources
      .filter((candidate) => candidate.provider === 'codex')
      .map((candidate) => candidate.name));
    const nickname = availableNickname([...group.sources.map((entry) => entry.name)], registry, codexNames);
    if (!nickname) return { ok: false, error: 'Could not pick a free nickname for this server.' };
    return await addOrionMcpForOperation(
      {
        ...resolved.input,
        nickname,
        // Provenance recognizes a completed share even when Orion signed in
        // separately. It is never used to suppress a runtime connection.
        sharedFrom: { id: source.id, fingerprint: sourceFingerprint({ ...source, connection: resolved.input }) },
        // Shares are available in every thread by default.
        enabled: true,
      },
      signal
    );
  });

// --- Runs ----------------------------------------------------------------------------

// OpenCode recursively merges inline MCP definitions with all its other
// config layers. Ask the CLI for the effective names before injecting any
// Orion servers; inspecting OPENCODE_CONFIG_CONTENT alone misses project,
// global, and OPENCODE_CONFIG definitions. Never cache this security check.
export const assertOpenCodeMcpNamesAvailable = async (servers, options = {}) => {
  if (!servers?.length) return;
  const extraArgs = parseExtraArgs(options.providerOptions?.extraArgs);
  const configArgs = [];
  let directory;
  for (let index = 0; index < extraArgs.length; index += 1) {
    const arg = extraArgs[index];
    if (arg === '--') break;
    if (arg === '--attach' || arg.startsWith('--attach=')) {
      throw new Error('Durango Code MCPs cannot be loaded with OpenCode --attach. Remove that option to run locally with these connections.');
    }
    if (arg === '--dir' || arg.startsWith('--dir=')) {
      directory = arg === '--dir' ? extraArgs[++index] : arg.slice('--dir='.length);
      if (!directory || directory.startsWith('--')) throw new Error('OpenCode --dir needs a directory.');
    }
    if (/^--(?:no-)?pure(?:=|$)/.test(arg)) {
      configArgs.push(arg);
      if (arg === '--pure' && /^(true|false)$/.test(extraArgs[index + 1] ?? '')) configArgs.push(extraArgs[++index]);
    }
  }
  let names;
  try {
    await shellPathSyncPromise;
    options.signal?.throwIfAborted();
    // Match runTurn's login shell, PATH resolution, and environment. Finder
    // launches do not inherit exports such as OPENCODE_CONFIG from .zprofile.
    // Apply --dir only after shell startup, just as `opencode run` does.
    const command = [options.openCodePath || 'opencode', 'debug', 'config', ...configArgs].map(shellQuote).join(' ');
    const shellCommand = directory ? `cd -- ${shellQuote(directory)} && ${command}` : command;
    const { stdout } = await (options.run || execFileAsync)(options.shell || loginShell, ['-lc', shellCommand], {
      cwd: options.cwd,
      env: withClaudeEnv({ ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...options.env }),
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      signal: options.signal,
    });
    options.signal?.throwIfAborted();
    const config = JSON.parse(String(stdout));
    if (!isPlainRecord(config) || (config.mcp !== undefined && !isPlainRecord(config.mcp))) {
      throw new Error('Invalid resolved MCP configuration.');
    }
    names = new Set(Object.keys(config.mcp ?? {}));
  } catch {
    options.signal?.throwIfAborted();
    // CLI output/errors can include credentials. Do not expose them in IPC.
    throw new Error('Could not check Durango Code MCP nicknames against the current OpenCode configuration. Try again before starting this turn.');
  }
  const collisions = servers.filter((server) => names.has(server.name));
  if (collisions.length > 0) {
    throw new Error(`Durango Code MCP nicknames conflict with configured OpenCode servers: ${collisions.map((server) => `@${server.name}`).join(', ')}. Reconnect these Durango Code MCPs with different nicknames in Settings → Skills & MCPs.`);
  }
};

/**
 * Reuse native connections only under the requested nickname. An equivalent
 * server under a different name cannot fulfill the injected @mention context.
 * Local servers match by launch configuration. Codex recursively merges
 * same-named definitions, including credentials and disabled transports.
 * Only equivalent active connections can be reused; reject any remaining
 * name collision before passing an Orion definition to the app-server.
 */
export const withoutNativeMcps = (servers, sources, providerId, defaultCwd) => {
  const remaining = servers.filter((server) => {
    const identity = mcpIdentity(server, defaultCwd);
    const sameName = sources.filter((source) =>
      (source.scope === 'plugin' ? `plugin:${source.plugin}:${source.name}` : source.name) === server.name);
    return !(identity && sameName.length > 0 && sameName.every((source) =>
      source.enabled && mcpIdentity(source, defaultCwd) === identity));
  });
  if (providerId === 'codex') {
    const names = new Set(sources.map((source) => source.name));
    const collisions = remaining.filter((server) => names.has(server.name));
    if (collisions.length > 0) {
      throw new Error(`Durango Code MCP nicknames conflict with configured Codex servers: ${collisions.map((server) => `@${server.name}`).join(', ')}. Reconnect these Durango Code MCPs with different nicknames in Settings → Skills & MCPs.`);
    }
  }
  return remaining;
};

// What a Claude run in projectPath loads by itself: user scope, that
// project's local scope and .mcp.json, and enabled plugins.
export const claudeNativeMcpSources = async (projectPath) => {
  const [sources, global, plugins] = await Promise.all([
    readClaudeCodeMcpSources({ projectPaths: projectPath ? [projectPath] : [] }),
    readJson(claudeGlobalConfigPath()),
    readClaudePluginSources(projectPath),
  ]);
  // /mcp disable applies per project, including to user-scope servers. It
  // must not mark the same user server disabled in every other project.
  const disabled = new Set(stringList(global?.projects?.[projectPath]?.disabledMcpServers));
  // Claude loads one definition per name: local > approved project > user.
  // Unapproved/excluded .mcp.json definitions do not override user entries.
  // /mcp disable applies to the resulting name after choosing its scope.
  const precedence = { user: 0, project: 1, local: 2 };
  const effective = new Map();
  for (const source of sources.filter((entry) => entry.scope !== 'plugin' &&
    (entry.scope !== 'project' || entry.enabled) &&
    (entry.scope === 'user' || entry.projectPath === projectPath))
    .sort((a, b) => precedence[a.scope] - precedence[b.scope])) {
    effective.set(source.name, source);
  }
  return [...effective.values(), ...plugins].map((source) => {
    const nativeName = source.scope === 'plugin' ? `plugin:${source.plugin}:${source.name}` : source.name;
    return { ...source, enabled: source.enabled && !disabled.has(nativeName) };
  });
};

export const withoutClaudeNativeMcps = async (servers, projectPath) => {
  if (!servers?.length) return servers ?? [];
  try {
    const sources = await resolveProviderConnections(await claudeNativeMcpSources(projectPath));
    return withoutNativeMcps(servers, sources, 'claude', projectPath);
  } catch {
    return servers;
  }
};

export const withoutCodexNativeMcps = async (servers, options = {}) => {
  if (!servers?.length) return servers ?? [];
  let sources;
  try {
    // A cached list or failed discovery cannot establish that names are safe.
    sources = await resolveProviderConnections(await readCodexMcpSources({ ...options, fresh: true }), options);
  } catch (error) {
    throw new Error('Could not check Durango Code MCP nicknames against the current Codex configuration. Try again before starting this turn.', { cause: error });
  }
  return withoutNativeMcps(servers, sources, 'codex', options.cwd);
};
