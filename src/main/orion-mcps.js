import { app, safeStorage, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { auth, discoverOAuthServerInfo, extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { shellPathSyncPromise } from './shell-env.js';

// ---------------------------------------------------------------------------
// MCP servers connected to Orion itself (Settings → Skills & MCPs). Unlike the
// Codex-configured list in mcps.js, these belong to Orion and are handed to
// every provider for a run. Each has a user-picked nickname that doubles as
// the server name agents see (mcp__<nickname>__*) and as its @-mention token.
//
// A server that is switched off is never loaded — unless the thread has it
// attached through an @-mention, which loads it for that thread's turns only.
//
// The registry (no secrets) and the credentials (URLs, arguments, headers, env, OAuth tokens)
// live in separate files; credentials are keychain-encrypted in packaged
// builds and never cross to the renderer.

const registryFileName = 'orion-mcps.json';
const credentialsFileName = 'orion-mcp-credentials.json';
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;
const STDIO_PROBE_TIMEOUT_MS = 60_000;
// Refresh a little before the server would reject the token mid-run.
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

// Names Orion already uses for its own servers, plus the other @-mention kinds.
export const reservedNicknames = new Set(['orion', 'thread', 'model', 'mcp', 'claude-in-chrome', 'chrome_devtools']);
export const nicknamePattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const orionMcpRegistryPath = () =>
  process.env.ORION_MCPS_PATH || path.join(app.getPath('userData'), registryFileName);
export const orionMcpCredentialsPath = () =>
  process.env.ORION_MCP_CREDENTIALS_PATH || path.join(app.getPath('userData'), credentialsFileName);

const isPlainRecord = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const stringRecord = (value) =>
  isPlainRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          ([key, entry]) => typeof key === 'string' && key.trim() && typeof entry === 'string'
        )
      )
    : {};

// --- Persistence -------------------------------------------------------------

let mutationQueue = Promise.resolve();
const serialized = (task) => {
  const queued = mutationQueue.then(task, task);
  mutationQueue = queued.catch(() => {});
  return queued;
};

const writeFileAtomic = async (target, content, signal) => {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o600 });
    signal?.throwIfAborted();
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
};

const normalizeSharedFrom = (value) =>
  typeof value?.id === 'string' && typeof value?.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint)
    ? { sharedFrom: { id: value.id, fingerprint: value.fingerprint } }
    : {};

const normalizeServer = (value) => {
  if (!isPlainRecord(value)) return null;
  const { id, nickname, transport } = value;
  if (typeof id !== 'string' || !id) return null;
  if (typeof nickname !== 'string' || !nicknamePattern.test(nickname)) return null;
  const base = {
    id,
    nickname,
    enabled: value.enabled === true,
    auth: value.auth === 'oauth' ? 'oauth' : 'none',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    ...normalizeSharedFrom(value.sharedFrom),
  };
  if (transport === 'http') {
    if (typeof value.url === 'string' && value.url) {
      return { ...base, transport: 'http', url: value.url }; // Legacy entry, migrated on read.
    }
    if (typeof value.endpoint === 'string' && value.endpoint) {
      return { ...base, transport: 'http', endpoint: value.endpoint };
    }
  }
  if (transport === 'stdio' && typeof value.command === 'string' && value.command) {
    return {
      ...base,
      transport: 'stdio',
      auth: 'none',
      command: value.command,
      ...(Array.isArray(value.args) ? { args: value.args.filter((arg) => typeof arg === 'string') } : {}),
      ...(typeof value.cwd === 'string' && value.cwd ? { cwd: value.cwd } : {}),
    };
  }
  return null;
};

const readRegistry = async () => {
  let contents;
  try {
    contents = await fs.readFile(orionMcpRegistryPath(), 'utf-8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error('Could not read saved MCP servers. The file has been preserved.', { cause: error });
  }
  try {
    const parsed = JSON.parse(contents);
    if (!isPlainRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.servers)) {
      throw new Error('Invalid MCP registry.');
    }
    const servers = parsed.servers.map(normalizeServer);
    if (servers.some((server) => !server)) throw new Error('Invalid MCP server entry.');
    return servers;
  } catch (error) {
    // A failed read must never become an empty read-modify-write.
    throw new Error('Could not open saved MCP servers. The file has been preserved.', { cause: error });
  }
};

const writeRegistry = (servers, signal) =>
  writeFileAtomic(
    orionMcpRegistryPath(),
    `${JSON.stringify({ version: 1, servers }, null, 2)}\n`,
    signal
  );

// Dev builds run under the stock Electron binary, whose signature never
// matches the keychain ACL, so safeStorage would prompt on every access. Same
// policy as the Orion account token in main.js.
const canUseSafeStorage = () => {
  try {
    return app.isPackaged && safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
};

const readCredentials = async () => {
  let contents;
  try {
    contents = await fs.readFile(orionMcpCredentialsPath(), 'utf-8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error('Could not read saved MCP credentials.', { cause: error });
  }
  try {
    const parsed = JSON.parse(contents);
    if (!isPlainRecord(parsed) || typeof parsed.value !== 'string' || typeof parsed.encrypted !== 'boolean') {
      throw new Error('Invalid credentials file.');
    }
    let payload = parsed.value;
    if (parsed.encrypted) {
      if (!canUseSafeStorage()) throw new Error('Credential encryption is unavailable.');
      payload = safeStorage.decryptString(Buffer.from(parsed.value, 'base64'));
    }
    const credentials = JSON.parse(payload);
    if (!isPlainRecord(credentials)) throw new Error('Invalid credentials payload.');
    return credentials;
  } catch (error) {
    // Never let a failed read/decryption become an empty read-modify-write.
    throw new Error('Could not open saved MCP credentials. The file has been preserved.', { cause: error });
  }
};

const writeCredentials = async (credentials, signal) => {
  const plain = JSON.stringify(credentials);
  const stored = canUseSafeStorage()
    ? { version: 1, encrypted: true, value: safeStorage.encryptString(plain).toString('base64') }
    : { version: 1, encrypted: false, value: plain };
  await writeFileAtomic(orionMcpCredentialsPath(), `${JSON.stringify(stored)}\n`, signal);
};

const updateCredentials = (id, update, signal) =>
  serialized(async () => {
    signal?.throwIfAborted();
    const credentials = await readCredentials();
    signal?.throwIfAborted();
    const next = update(isPlainRecord(credentials[id]) ? credentials[id] : {});
    if (next) credentials[id] = next;
    else delete credentials[id];
    await writeCredentials(credentials, signal);
  });

const publicEndpoint = (value) => {
  const url = new URL(value);
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
};

// Called under mutationQueue, including by registry mutations. Persist the
// credentials first so an interrupted migration never loses connection data.
const readAndMigrateRegistry = async () => {
  const servers = await readRegistry();
  const legacy = servers.filter((server) =>
    (server.transport === 'stdio' && Array.isArray(server.args)) ||
    (server.transport === 'http' && typeof server.url === 'string'));
  if (legacy.length === 0) return servers;
  const credentials = await readCredentials();
  for (const server of legacy) {
    if (server.transport === 'http') {
      credentials[server.id] = { ...credentials[server.id], url: server.url };
      server.endpoint = publicEndpoint(server.url);
      delete server.url;
    } else {
      credentials[server.id] = { ...credentials[server.id], args: server.args };
      delete server.args;
    }
  }
  await writeCredentials(credentials);
  await writeRegistry(servers);
  return servers;
};

export const readOrionMcpRegistry = () => serialized(readAndMigrateRegistry);

// --- OAuth -------------------------------------------------------------------

const serverOperations = new Map();
const removingServers = new Set();
const pendingReconnects = new Map();

// Register before any reads. Removal blocks new operations and aborts every
// existing writer; the same signal also guards the atomic credential rename.
const beginServerOperation = (id) => {
  if (removingServers.has(id)) throw new Error('This MCP server is being removed.');
  const controller = new AbortController();
  const operations = serverOperations.get(id) ?? new Set();
  operations.add(controller);
  serverOperations.set(id, operations);
  return {
    controller,
    signal: controller.signal,
    finish: () => {
      operations.delete(controller);
      if (operations.size === 0 && serverOperations.get(id) === operations) serverOperations.delete(id);
    },
  };
};

const abortServerOperations = (id, reason) => {
  for (const controller of serverOperations.get(id) ?? []) controller.abort(reason);
};

const fetchWithAbort = (signal) => (url, init) => fetch(url, {
  ...init,
  signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
});

const tokenExpiresAt = (oauth) => {
  const expiresIn = Number(oauth?.tokens?.expires_in);
  const obtainedAt = Number(oauth?.obtainedAt);
  return Number.isFinite(expiresIn) && expiresIn > 0 && Number.isFinite(obtainedAt)
    ? obtainedAt + expiresIn * 1000
    : null;
};

/**
 * OAuthClientProvider backed by the credentials file. Interactive providers
 * open the system browser; non-interactive ones (token refresh before a run)
 * only record that the user must sign in again.
 */
class OrionOAuthProvider {
  constructor(serverId, { redirectUrl = null, interactive = false, signal } = {}) {
    this.serverId = serverId;
    this._redirectUrl = redirectUrl;
    this.interactive = interactive;
    this.signal = signal;
    this.needsAuthorization = false;
    this.expectedState = null;
    this.verifier = null;
    this.grantTypes = ['authorization_code', 'refresh_token'];
  }

  get redirectUrl() {
    // A placeholder keeps the SDK on the authorization-code path when
    // refreshing; non-interactive providers never actually redirect.
    return this._redirectUrl ?? 'http://127.0.0.1/callback';
  }

  get clientMetadata() {
    return {
      client_name: 'Durango Code',
      client_uri: 'https://durango.sh',
      redirect_uris: [String(this.redirectUrl)],
      grant_types: this.grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state() {
    this.expectedState = crypto.randomBytes(24).toString('base64url');
    return this.expectedState;
  }

  async stored() {
    this.signal?.throwIfAborted();
    const credentials = await readCredentials();
    this.signal?.throwIfAborted();
    return isPlainRecord(credentials[this.serverId]?.oauth) ? credentials[this.serverId].oauth : {};
  }

  async saveOAuth(update) {
    await updateCredentials(this.serverId, (entry) => {
      this.signal?.throwIfAborted();
      return { ...entry, oauth: update(isPlainRecord(entry.oauth) ? entry.oauth : {}) };
    }, this.signal);
  }

  async clientInformation() {
    const oauth = await this.stored();
    if (!isPlainRecord(oauth.client)) return undefined;
    // Dynamically registered clients are bound to the loopback port they
    // registered with; a new sign-in listens on a fresh port and registers
    // again. Refreshes do not send a redirect_uri, so any client works there.
    if (this.interactive && oauth.clientRedirectUrl !== String(this.redirectUrl)) return undefined;
    return oauth.client;
  }

  async saveClientInformation(client) {
    await this.saveOAuth((oauth) => ({
      ...oauth,
      client,
      clientRedirectUrl: String(this.redirectUrl),
    }));
  }

  async discoveryState() {
    // A reconnect has a fresh WWW-Authenticate challenge; rediscover there.
    return this.interactive ? undefined : (await this.stored()).discovery;
  }

  async saveDiscoveryState(discovery) {
    await this.saveOAuth((oauth) => ({ ...oauth, discovery }));
  }

  async tokens() {
    return (await this.stored()).tokens;
  }

  async saveTokens(tokens) {
    await this.saveOAuth((oauth) => ({
      ...oauth,
      tokens: {
        ...tokens,
        // Servers may omit the refresh token on refresh; keep the old one.
        ...(tokens.refresh_token || !oauth.tokens?.refresh_token
          ? {}
          : { refresh_token: oauth.tokens.refresh_token }),
      },
      obtainedAt: Date.now(),
    }));
  }

  async redirectToAuthorization(authorizationUrl) {
    this.signal?.throwIfAborted();
    this.needsAuthorization = true;
    if (!this.interactive) return;
    await shell.openExternal(authorizationUrl.toString());
  }

  saveCodeVerifier(verifier) {
    this.verifier = verifier;
  }

  codeVerifier() {
    if (!this.verifier) throw new Error('OAuth sign-in lost its PKCE verifier. Try connecting again.');
    return this.verifier;
  }

  async invalidateCredentials(scope) {
    await this.saveOAuth((oauth) => {
      if (scope === 'all') return {};
      const next = { ...oauth };
      if (scope === 'client') {
        delete next.client;
        delete next.clientRedirectUrl;
      }
      if (scope === 'tokens') {
        delete next.tokens;
        delete next.obtainedAt;
      }
      if (scope === 'discovery') delete next.discovery;
      return next;
    });
    if (scope === 'all' || scope === 'verifier') this.verifier = null;
  }
}

const callbackPage = (title, detail) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  '<body style="font-family:-apple-system,system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">' +
  `<div style="text-align:center"><h2 style="font-weight:600">${title}</h2><p style="color:#999">${detail}</p></div></body>`;

// One loopback listener per sign-in. Resolves with the authorization code
// once the browser returns with the state this flow generated.
const startOAuthCallbackServer = () =>
  new Promise((resolve, reject) => {
    let settleCode;
    let failCode;
    const codePromise = new Promise((resolveCode, rejectCode) => {
      settleCode = resolveCode;
      failCode = rejectCode;
    });
    codePromise.catch(() => {});
    let expectedState = null;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (!expectedState || state !== expectedState) {
        res.writeHead(400).end(callbackPage('Sign-in failed', 'This sign-in link is stale. Start again from Durango Code.'));
        return;
      }
      if (error || !code) {
        const detail = url.searchParams.get('error_description') || error || 'No authorization code was returned.';
        res.writeHead(400).end(callbackPage('Sign-in failed', detail));
        failCode(new Error(`Sign-in failed: ${detail}`));
        return;
      }
      res.writeHead(200).end(callbackPage('Connected to Durango Code', 'You can close this tab and return to Durango Code.'));
      settleCode(code);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        redirectUrl: `http://127.0.0.1:${port}/callback`,
        setExpectedState: (state) => {
          expectedState = state;
        },
        code: codePromise,
        fail: failCode,
        close: () => server.close(),
      });
    });
  });

const pendingSignIns = new Map(); // server id -> { cancel }
const pendingAdds = new Map(); // renderer operation id -> AbortController

export const cancelOrionMcpSignIn = (id, operationId) => {
  pendingAdds.get(operationId)?.abort(new Error('Connection was cancelled.'));
  pendingReconnects.get(id)?.abort(new Error('Sign-in was cancelled.'));
  pendingSignIns.get(id)?.cancel();
  return { ok: true };
};

const runInteractiveOAuth = async (server, { resourceMetadataUrl, scope, signal } = {}) => {
  signal?.throwIfAborted();
  pendingSignIns.get(server.id)?.cancel();
  const controller = new AbortController();
  signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const callback = await startOAuthCallbackServer();
  const provider = new OrionOAuthProvider(server.id, {
    redirectUrl: callback.redirectUrl,
    interactive: true,
    signal,
  });
  const originalState = provider.state.bind(provider);
  provider.state = () => {
    const state = originalState();
    callback.setExpectedState(state);
    return state;
  };
  let timer = null;
  const pending = { cancel: () => controller.abort(new Error('Sign-in was cancelled.')) };
  pendingSignIns.set(server.id, pending);
  const onAbort = () => callback.fail(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const fetchFn = fetchWithAbort(signal);
    const options = {
      serverUrl: server.url,
      fetchFn,
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      ...(scope ? { scope } : {}),
    };
    // Stored tokens that still refresh are enough; only a REDIRECT needs the browser.
    let first;
    try {
      // Register only for grants the server offers: strict registration
      // endpoints reject metadata asking for refresh_token when it has none.
      const discovered = await discoverOAuthServerInfo(server.url, {
        fetchFn,
        ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      });
      const supported = discovered.authorizationServerMetadata?.grant_types_supported;
      if (Array.isArray(supported) && !supported.includes('refresh_token')) {
        provider.grantTypes = ['authorization_code'];
      }
      first = await auth(provider, options);
      signal?.throwIfAborted();
    } catch (error) {
      if (provider.needsAuthorization) throw error;
      throw new Error(
        `This server requires authentication but OAuth sign-in could not start (${errorMessage(error, 'discovery failed')}). If it uses an API key, add it as an Authorization header instead.`
      );
    }
    if (first === 'AUTHORIZED') return;
    timer = setTimeout(
      () => controller.abort(new Error('Timed out waiting for the browser sign-in.')),
      OAUTH_TIMEOUT_MS
    );
    const code = await callback.code;
    const second = await auth(provider, { ...options, authorizationCode: code });
    signal?.throwIfAborted();
    if (second !== 'AUTHORIZED') throw new Error('The server did not accept the sign-in.');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (timer) clearTimeout(timer);
    callback.close();
    if (pendingSignIns.get(server.id) === pending) pendingSignIns.delete(server.id);
  }
};

// Current access token for a run, refreshing it when it is about to expire.
// Never opens a browser: a server that needs a fresh sign-in is reported back.
const refreshAccessTokenForRun = async (server, signal) => {
  // Read inside the shared operation: another run may have already refreshed
  // since resolveOrionMcpsForRun took its credentials snapshot.
  const credentials = (await readCredentials())[server.id];
  signal.throwIfAborted();
  const oauth = isPlainRecord(credentials?.oauth) ? credentials.oauth : {};
  const token = oauth.tokens?.access_token;
  const expiresAt = tokenExpiresAt(oauth);
  const fresh = token && (expiresAt === null || expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now());
  if (fresh) return { token };
  if (!oauth.tokens?.refresh_token) {
    return token && expiresAt > Date.now() ? { token } : { needsSignIn: true };
  }
  try {
    const provider = new OrionOAuthProvider(server.id, { signal });
    const result = await auth(provider, { serverUrl: server.url, fetchFn: fetchWithAbort(signal) });
    const refreshed = await provider.tokens();
    signal.throwIfAborted();
    if (result === 'AUTHORIZED' && refreshed?.access_token) return { token: refreshed.access_token };
  } catch (error) {
    if (!signal.aborted) console.warn(`Orion MCP ${server.nickname}: token refresh failed`, error);
  }
  return { needsSignIn: true };
};

const pendingTokenRefreshes = new Map();
const accessTokenForRun = (server) => {
  if (removingServers.has(server.id) || pendingReconnects.has(server.id)) {
    return Promise.resolve({ needsSignIn: true });
  }
  const existing = pendingTokenRefreshes.get(server.id);
  if (existing) return existing;
  const operation = beginServerOperation(server.id);
  const timer = setTimeout(() => operation.controller.abort(new Error('MCP token refresh timed out.')), PROBE_TIMEOUT_MS);
  const pending = refreshAccessTokenForRun(server, operation.signal).catch((error) => {
    if (operation.signal.aborted) return { needsSignIn: true };
    throw error;
  }).finally(() => {
    clearTimeout(timer);
    operation.finish();
    if (pendingTokenRefreshes.get(server.id) === pending) pendingTokenRefreshes.delete(server.id);
  });
  pendingTokenRefreshes.set(server.id, pending);
  return pending;
};

// --- Probing -------------------------------------------------------------------

const withTimeout = (promise, ms, message, signal) => {
  let timer;
  let onAbort;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
    ...(signal ? [new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    })] : []),
  ]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
};

// Ask the server to initialize without credentials. A 401 means it expects
// OAuth (or an API key header); the WWW-Authenticate hints feed discovery.
const probeHttpAuthRequirement = async (url, headers, signal) => {
  const response = await withTimeout(
    fetch(url, {
      signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'Durango Code', version: app.getVersion() },
        },
      }),
    }),
    PROBE_TIMEOUT_MS,
    'The server did not respond.'
  );
  response.body?.cancel().catch(() => {});
  if (response.status !== 401 && response.status !== 403) return { requiresAuth: false };
  const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
  return { requiresAuth: true, resourceMetadataUrl, scope };
};

const serverEnv = (credentials) => stringRecord(credentials?.env);
const serverHeaders = (credentials) => stringRecord(credentials?.headers);
// HTTP field names are case-insensitive. Keeping a differently cased
// Authorization key makes fetch combine the stale and current tokens.
export const withMcpBearerToken = (headers, token) => token
  ? {
      ...Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization')),
      Authorization: `Bearer ${token}`,
    }
  : headers;
const serverArgs = (credentials) => Array.isArray(credentials?.args) ? credentials.args : [];
const withPrivateConnection = (server, credentials) => {
  if (server.transport === 'stdio') return { ...server, args: serverArgs(credentials) };
  const url = credentials?.url;
  if (typeof url !== 'string' || !url) {
    throw new Error(`The saved connection URL for @${server.nickname} is missing. Disconnect and add this MCP again in Settings.`);
  }
  return { ...server, url };
};

// Main-process-only comparison data. Credential values must not be exposed
// by the provider list IPC, which returns only sanitized source summaries.
export const readOrionMcpRegistryForMatching = async () => {
  const servers = await readOrionMcpRegistry();
  const credentials = await readCredentials();
  return servers.map((server) => {
    const entry = credentials[server.id];
    const headers = withMcpBearerToken(serverHeaders(entry),
      server.auth === 'oauth' ? entry?.oauth?.tokens?.access_token : undefined);
    return { ...withPrivateConnection(server, entry), env: serverEnv(entry), headers };
  });
};

// Connect a throwaway client and list tools: proof the server works with the
// credentials Orion will hand to agents.
const listServerTools = async (server, { headers = {}, env = {}, signal } = {}) => {
  signal?.throwIfAborted();
  const client = new Client({ name: 'Durango Code', version: app.getVersion() });
  const connectAndList = async (transport) => {
    await client.connect(transport);
    signal?.throwIfAborted();
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor && tools.length < 500);
    return tools;
  };
  try {
    if (server.transport === 'stdio') {
      await shellPathSyncPromise;
      signal?.throwIfAborted();
      return await withTimeout(
        connectAndList(
          new StdioClientTransport({
            command: server.command,
            args: server.args,
            env: { ...process.env, ...env },
            ...(server.cwd ? { cwd: server.cwd } : {}),
            stderr: 'ignore',
          })
        ),
        STDIO_PROBE_TIMEOUT_MS,
        'The server did not start in time.',
        signal
      );
    }
    const requestInit = { headers };
    const fetchWithSignal = signal
      ? (url, init) => fetch(url, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) })
      : undefined;
    // Validate the same transport handed to providers. Accepting a legacy
    // SSE fallback here would save a connection that cannot work in runs.
    return await withTimeout(
      connectAndList(new StreamableHTTPClientTransport(new URL(server.url), { requestInit, fetch: fetchWithSignal })),
      PROBE_TIMEOUT_MS,
      'The server did not respond using streamable HTTP.',
      signal
    );
  } finally {
    await client.close().catch(() => {});
  }
};

const errorMessage = (error, fallback) => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message || fallback;
};

// --- Public API (IPC) ------------------------------------------------------------

const toPublicEntry = (server, credentials) => {
  const entry = credentials[server.id] ?? {};
  const oauth = isPlainRecord(entry.oauth) ? entry.oauth : {};
  const signedIn = Boolean(oauth.tokens?.access_token);
  const expiresAt = tokenExpiresAt(oauth);
  const expired = signedIn && !oauth.tokens?.refresh_token && expiresAt !== null && expiresAt < Date.now();
  const endpoint = server.endpoint ?? (server.url ? publicEndpoint(server.url) : null);
  return {
    id: server.id,
    nickname: server.nickname,
    transport: server.transport,
    // Query strings can carry keys; show host + path only.
    detail: server.transport === 'http' ? endpoint : path.basename(server.command),
    enabled: server.enabled,
    auth: server.auth,
    status: server.auth === 'oauth' && (!signedIn || expired) ? 'needs-sign-in' : 'ready',
    headerNames: Object.keys(serverHeaders(entry)),
    envNames: Object.keys(serverEnv(entry)),
    createdAt: server.createdAt,
  };
};

export const listOrionMcps = async () => {
  try {
    const servers = await readOrionMcpRegistry();
    const credentials = await readCredentials();
    return {
      ok: true,
      servers: servers
        .map((server) => toPublicEntry(server, credentials))
        .sort((a, b) => a.nickname.localeCompare(b.nickname)),
    };
  } catch (error) {
    return { ok: false, servers: [], error: errorMessage(error, 'Could not read Durango Code MCP servers.') };
  }
};

const validateNickname = (nickname, servers, exceptId) => {
  if (typeof nickname !== 'string' || !nicknamePattern.test(nickname)) {
    return 'Nicknames use lowercase letters, numbers, - or _ (up to 32 characters).';
  }
  if (reservedNicknames.has(nickname)) return `“${nickname}” is reserved by Durango Code.`;
  if (servers.some((server) => server.id !== exceptId && server.nickname === nickname)) {
    return `Another MCP is already called @${nickname}.`;
  }
  return null;
};

const parseHttpUrl = (value) => {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
};

/**
 * Own cancellation across the entire connection, including provider discovery
 * when sharing. A renderer operation id is registered before any async work.
 */
export const withOrionMcpConnection = async (operationId, connect) => {
  if (operationId !== undefined && (typeof operationId !== 'string' || !operationId || pendingAdds.has(operationId))) {
    return { ok: false, error: 'Invalid or duplicate connection operation.' };
  }
  const controller = new AbortController();
  // Register before the first await so Cancel also works during initial reads/probes.
  if (operationId) pendingAdds.set(operationId, controller);
  try {
    return await connect(controller.signal);
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Could not connect to the MCP server.') };
  } finally {
    if (operationId) pendingAdds.delete(operationId);
  }
};

export const addOrionMcp = (input) =>
  withOrionMcpConnection(input?.operationId, (signal) => addOrionMcpForOperation(input, signal));

// Validate, sign in, and list tools before persisting. A failed add leaves
// nothing behind.
// Shares reuse their existing operation so discovery and connection have one
// cancellation lifetime, with no gap or second registration.
export const addOrionMcpForOperation = async (input, signal) => {
  signal.throwIfAborted();
  const servers = await readOrionMcpRegistry();
  signal.throwIfAborted();
  const nickname = String(input?.nickname ?? '').trim().toLowerCase();
  const nicknameError = validateNickname(nickname, servers);
  if (nicknameError) return { ok: false, error: nicknameError };

  const id = crypto.randomUUID();
  const headers = stringRecord(input?.headers);
  const env = stringRecord(input?.env);
  let server;
  if (input?.transport === 'stdio') {
    const command = String(input?.command ?? '').trim();
    if (!command) return { ok: false, error: 'Enter the command that starts the server.' };
    server = {
      id,
      nickname,
      transport: 'stdio',
      command,
      args: Array.isArray(input?.args) ? input.args.filter((arg) => typeof arg === 'string') : [],
      // Servers shared from a provider may start relative to their own folder.
      ...(typeof input?.cwd === 'string' && path.isAbsolute(input.cwd) ? { cwd: input.cwd } : {}),
      auth: 'none',
    };
  } else {
    const url = parseHttpUrl(input?.url);
    if (!url) return { ok: false, error: 'Enter a valid http(s) MCP server URL.' };
    server = { id, nickname, transport: 'http', url, auth: 'none' };
  }
  server.enabled = input?.enabled === true;
  server.createdAt = new Date().toISOString();
  Object.assign(server, normalizeSharedFrom(input?.sharedFrom));

  try {
    // Fail before opening a browser or starting a command if the store cannot be read.
    await readCredentials();
    signal.throwIfAborted();
    if (server.transport === 'http') {
      const requirement = await probeHttpAuthRequirement(server.url, headers, signal);
      signal.throwIfAborted();
      if (requirement.requiresAuth) {
        server.auth = 'oauth';
        await runInteractiveOAuth(server, { ...requirement, signal });
      }
    }
    const credentials = await readCredentials();
    signal.throwIfAborted();
    const token = credentials[id]?.oauth?.tokens?.access_token;
    const tools = await listServerTools(server, {
      headers: withMcpBearerToken(headers, token),
      env,
      signal,
    });
    let savedEntry;
    await updateCredentials(id, (entry) => {
      signal.throwIfAborted();
      const next = { ...entry };
      if (Object.keys(headers).length) next.headers = headers;
      if (Object.keys(env).length) next.env = env;
      if (server.transport === 'stdio') next.args = server.args;
      else next.url = server.url;
      savedEntry = next;
      return next;
    }, signal);
    // Prepare the response before committing the registry. No fallible reads
    // may run after commit and enter cleanup that deletes saved credentials.
    const result = {
      ok: true,
      server: toPublicEntry(server, { [id]: savedEntry }),
      tools: tools.map((tool) => tool.name),
    };
    await serialized(async () => {
      const current = await readAndMigrateRegistry();
      signal.throwIfAborted();
      const conflict = validateNickname(nickname, current);
      if (conflict) throw new Error(conflict);
      const { args: _privateArgs, url: privateUrl, ...registryServer } = server;
      if (privateUrl) registryServer.endpoint = publicEndpoint(privateUrl);
      await writeRegistry([...current, registryServer], signal);
    });
    return result;
  } catch (error) {
    await updateCredentials(id, () => null).catch(() => {});
    return { ok: false, error: errorMessage(error, 'Could not connect to the MCP server.') };
  }
};

export const updateOrionMcp = async (input) => {
  const id = input?.id;
  if (typeof id !== 'string' || !id) return { ok: false, error: 'Invalid MCP server.' };
  try {
    await serialized(async () => {
      const servers = await readAndMigrateRegistry();
      const index = servers.findIndex((server) => server.id === id);
      if (index === -1) throw new Error('That MCP server no longer exists.');
      const next = { ...servers[index] };
      if (typeof input.enabled === 'boolean') next.enabled = input.enabled;
      if (input.nickname !== undefined) {
        const nickname = String(input.nickname).trim().toLowerCase();
        const nicknameError = validateNickname(nickname, servers, id);
        if (nicknameError) throw new Error(nicknameError);
        next.nickname = nickname;
      }
      servers[index] = next;
      await writeRegistry(servers);
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Could not update the MCP server.') };
  }
};

export const removeOrionMcp = async (input) => {
  const id = input?.id;
  if (typeof id !== 'string' || !id) return { ok: false, error: 'Invalid MCP server.' };
  if (removingServers.has(id)) return { ok: false, error: 'This MCP server is already being removed.' };
  removingServers.add(id);
  abortServerOperations(id, new Error('MCP server was removed.'));
  try {
    pendingSignIns.get(id)?.cancel();
    await serialized(async () => {
      const servers = await readAndMigrateRegistry();
      // A failed credential read must not partially remove the registry entry either.
      await readCredentials();
      await writeRegistry(servers.filter((server) => server.id !== id));
    });
    await updateCredentials(id, () => null);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Could not remove the MCP server.') };
  } finally {
    removingServers.delete(id);
  }
};

// Re-run sign-in (expired or revoked tokens) and re-list tools.
export const reconnectOrionMcp = async (input) => {
  const id = input?.id;
  if (typeof id !== 'string' || !id) return { ok: false, error: 'Invalid MCP server.' };
  let operation;
  try {
    // A new sign-in supersedes older refreshes and reconnects for this server.
    abortServerOperations(id, new Error('A new sign-in was started.'));
    operation = beginServerOperation(id);
    const { signal, controller } = operation;
    pendingReconnects.set(id, controller);
    let server = (await readOrionMcpRegistry()).find((candidate) => candidate.id === id);
    signal.throwIfAborted();
    if (!server) return { ok: false, error: 'That MCP server no longer exists.' };
    let credentials = await readCredentials();
    server = withPrivateConnection(server, credentials[server.id]);
    if (server.auth === 'oauth') {
      await updateCredentials(server.id, (entry) => ({
        ...entry,
        oauth: { ...(entry.oauth ?? {}), tokens: undefined, obtainedAt: undefined },
      }), signal);
      const requirement = await probeHttpAuthRequirement(server.url, serverHeaders(credentials[server.id]), signal).catch(() => {
        signal.throwIfAborted();
        return {};
      });
      await runInteractiveOAuth(server, { ...requirement, signal });
      credentials = await readCredentials();
    }
    const entry = credentials[server.id] ?? {};
    const token = entry.oauth?.tokens?.access_token;
    const headers = serverHeaders(entry);
    const tools = await listServerTools(server, {
      headers: withMcpBearerToken(headers, token),
      env: serverEnv(entry),
      signal,
    });
    signal.throwIfAborted();
    return { ok: true, tools: tools.map((tool) => tool.name) };
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Could not reconnect the MCP server.') };
  } finally {
    operation?.finish();
    if (operation && pendingReconnects.get(id) === operation.controller) pendingReconnects.delete(id);
  }
};

// --- Runs --------------------------------------------------------------------

/**
 * Resolve the Orion MCP servers a run should load: every enabled server plus
 * any the thread attached through an @-mention. Tokens are refreshed here;
 * servers that need a new browser sign-in are skipped and reported.
 *
 * Returned entries carry live secrets and must stay in the main process
 * (or travel only over the provider's private channel).
 */
// A stopped turn stops waiting without cancelling a refresh another turn
// still needs. The shared refresh has its own bounded lifetime above.
const waitForRunRefresh = (pending, signal) => {
  if (!signal) return pending;
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  return Promise.race([pending, cancelled]).finally(() => signal.removeEventListener('abort', onAbort));
};

export const resolveOrionMcpsForRun = async (attachedIds = [], { signal } = {}) => {
  signal?.throwIfAborted();
  const attached = new Set(Array.isArray(attachedIds) ? attachedIds : []);
  const servers = (await readOrionMcpRegistry()).filter(
    (server) => server.enabled || attached.has(server.id)
  );
  if (servers.length === 0) return { servers: [], needsSignIn: [] };
  const credentials = await readCredentials();
  signal?.throwIfAborted();
  const needsSignIn = [];
  const resolved = [];
  for (const savedServer of servers) {
    signal?.throwIfAborted();
    const entry = credentials[savedServer.id] ?? {};
    const server = withPrivateConnection(savedServer, entry);
    let headers = serverHeaders(entry);
    if (server.auth === 'oauth') {
      const { token, needsSignIn: signIn } = await waitForRunRefresh(accessTokenForRun(server), signal);
      if (signIn || !token) {
        needsSignIn.push(server.nickname);
        continue;
      }
      headers = withMcpBearerToken(headers, token);
    }
    resolved.push(
      server.transport === 'http'
        ? { name: server.nickname, transport: 'http', url: server.url, headers }
        : {
            name: server.nickname,
            transport: 'stdio',
            command: server.command,
            args: serverArgs(entry),
            env: serverEnv(entry),
            ...(server.cwd ? { cwd: server.cwd } : {}),
          }
    );
  }
  return { servers: resolved, needsSignIn };
};

// --- Provider config shapes --------------------------------------------------------

// These providers have no per-server cwd field. Launch through Orion's Node
// runtime (also available when packaged), passing all values as literal argv.
// Keep the child's stdio directly connected to its provider and forward stops.
const cwdStdioLauncher = `
const { spawn } = require('node:child_process');
const [cwd, runAsNode, command, ...args] = process.argv.slice(1);
const env = { ...process.env };
if (runAsNode) env.ELECTRON_RUN_AS_NODE = runAsNode;
else delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
child.on('error', (error) => { console.error(error.message); process.exit(1); });
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
`;

const stdioLaunch = (server) =>
  server.cwd
    ? {
        command: process.execPath,
        args: [
          '-e', cwdStdioLauncher, '--', server.cwd,
          server.env?.ELECTRON_RUN_AS_NODE ?? process.env.ELECTRON_RUN_AS_NODE ?? '',
          server.command, ...server.args,
        ],
        env: { ...server.env, ELECTRON_RUN_AS_NODE: '1' },
      }
    : { command: server.command, args: server.args, env: server.env };

// Claude Agent SDK (applied through setMcpServers, never argv).
export const claudeOrionMcpServers = (servers = []) =>
  Object.fromEntries(
    servers.map((server) => [
      server.name,
      server.transport === 'http'
        ? { type: 'http', url: server.url, headers: server.headers }
        : { type: 'stdio', ...stdioLaunch(server) },
    ])
  );

// Codex app-server `mcp_servers` entries (sent over local JSON-RPC only).
// Headless runs cannot answer Codex's MCP approval prompts, so the user's own
// servers are pre-approved — except in Read only, which must not act.
export const codexOrionMcpServers = (servers = [], accessMode = 'full-access') =>
  Object.fromEntries(
    servers.map((server) => [
      server.name,
      {
        enabled: true,
        ...(server.transport === 'http'
          ? {
              url: server.url,
              ...(Object.keys(server.headers).length ? { http_headers: server.headers } : {}),
            }
          : {
              command: server.command,
              args: server.args,
              ...(Object.keys(server.env).length ? { env: server.env } : {}),
              ...(server.cwd ? { cwd: server.cwd } : {}),
            }),
        startup_timeout_sec: 30,
        ...(accessMode === 'read-only' ? {} : { default_tools_approval_mode: 'approve' }),
      },
    ])
  );

export const withCodexOrionMcps = (runtimeConfig, servers, accessMode) => {
  if (!servers?.length) return runtimeConfig;
  return {
    ...runtimeConfig,
    mcp_servers: {
      ...(isPlainRecord(runtimeConfig?.mcp_servers) ? runtimeConfig.mcp_servers : {}),
      ...codexOrionMcpServers(servers, accessMode),
    },
  };
};

// ACP session/new + session/load shape (Kimi). HTTP entries are filtered by
// the driver against the agent's advertised mcpCapabilities.
export const acpOrionMcpServers = (servers = []) =>
  servers.map((server) => {
    const local = server.transport === 'stdio' ? stdioLaunch(server) : null;
    return server.transport === 'http'
      ? {
          type: 'http',
          name: server.name,
          url: server.url,
          headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
        }
      : {
          name: server.name,
          command: local.command,
          args: local.args,
          env: Object.entries(local.env).map(([name, value]) => ({ name, value })),
        };
  });

// Claude-plugin / Cursor `.mcp.json` entries (Grok and Cursor run plugins).
export const pluginOrionMcpServers = (servers = []) =>
  Object.fromEntries(
    servers.map((server) => [
      server.name,
      server.transport === 'http'
        ? { type: 'http', url: server.url, headers: server.headers }
        : stdioLaunch(server),
    ])
  );

// OpenCode inline config `mcp` entries.
export const openCodeOrionMcpServers = (servers = []) =>
  Object.fromEntries(
    servers.map((server) => {
      const local = server.transport === 'stdio' ? stdioLaunch(server) : null;
      return [
        server.name,
        server.transport === 'http'
          ? { type: 'remote', url: server.url, headers: server.headers, enabled: true }
          : {
              type: 'local',
              command: [local.command, ...local.args],
              environment: local.env,
              enabled: true,
            },
      ];
    })
  );

// Muse settings.json `mcp_servers` (stdio is the only documented transport).
export const museOrionMcpServers = (servers = []) => {
  const remote = servers.filter((server) => server.transport === 'http');
  if (remote.length) {
    throw new Error(`Muse does not support HTTP MCP servers: ${remote.map((server) => `@${server.name}`).join(', ')}. Switch providers, or switch these MCPs off and remove their thread attachments.`);
  }
  return Object.fromEntries(
    servers
      .filter((server) => server.transport === 'stdio')
      .map((server) => [
        server.name,
        { transport: 'stdio', ...stdioLaunch(server) },
      ])
  );
};
