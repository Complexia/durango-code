import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-orion-mcps-test-'));
process.env.ORION_MCPS_PATH = path.join(testRoot, 'orion-mcps.json');
process.env.ORION_MCP_CREDENTIALS_PATH = path.join(testRoot, 'orion-mcp-credentials.json');

const { app, shell } = await import('electron');
const orionMcps = await import('../src/main/orion-mcps.js');
const { mcpBridgePluginConfig, openCodeMcpConfigContent, orionAcpMcpServers } = await import(
  '../src/main/mcp-bridge.js'
);
const { syncClaudeOrionMcpServers, createClaudeSdkSession, claudeSdkSessions, runClaudeSdkTurn, terminatingClaudeSdkSessions } = await import('../src/main/claude-driver.js');
const { createKimiAcpDriver } = await import('../src/main/kimi-driver.js');
const { codexAppServerConfig } = await import('../src/main/codex-driver.js');
const { buildMcpMentionsContext, mergeMcpAttachments, parseMcpMentions, splitCommandLine, suggestMcpNickname } =
  await import('../src/app/orionMcps.ts');

// --- A local MCP server with an optional fake OAuth authorization server ------

const counters = { register: 0, token: 0, refresh: 0 };
const validTokens = new Set();
let origin = '';
let holdMcpRequest = null;
let holdRefreshRequest = null;
let holdCodeExchange = null;
let rotateRefreshTokens = false;
let acceptedRefreshToken = 'refresh-1';
const legacyTransports = new Map();

const makeMcpServer = () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  server.registerTool(
    'echo',
    { description: 'Echo text', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text }] })
  );
  return server;
};

const readBody = (req) =>
  new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });

const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
};

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  if (url.pathname === '/legacy/sse' && req.method === 'GET') {
    const transport = new SSEServerTransport('/legacy/messages', res);
    legacyTransports.set(transport.sessionId, transport);
    res.on('close', () => legacyTransports.delete(transport.sessionId));
    return makeMcpServer().connect(transport);
  }
  if (url.pathname === '/legacy/messages' && req.method === 'POST') {
    return legacyTransports.get(url.searchParams.get('sessionId')).handlePostMessage(req, res);
  }
  if (url.pathname === '/legacy/sse') return res.writeHead(405).end();
  // Discovery is available only at the advertised URL, with a separate issuer
  // path and token endpoint. Guessing from the MCP URL cannot refresh tokens.
  if (url.pathname === '/custom-resource-metadata') {
    return json(res, 200, { resource: `${origin}/secure/mcp`, authorization_servers: [`${origin}/oauth-issuer`] });
  }
  if (url.pathname === '/tenant-resource-metadata') {
    return json(res, 200, { resource: `${origin}/tenant/mcp`, authorization_servers: [`${origin}/oauth-issuer`] });
  }
  if (url.pathname === '/.well-known/oauth-authorization-server/oauth-issuer') {
    return json(res, 200, {
      issuer: `${origin}/oauth-issuer`,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/oauth-token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }
  if (url.pathname === '/register') {
    counters.register += 1;
    const metadata = JSON.parse(await readBody(req));
    assert.equal(metadata.client_name, 'Durango Code');
    assert.equal(metadata.client_uri, 'https://code.durango.sh');
    assert.match(metadata.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    return json(res, 201, { ...metadata, client_id: `client-${counters.register}` });
  }
  if (url.pathname === '/authorize') {
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const redirect = new URL(url.searchParams.get('redirect_uri'));
    redirect.searchParams.set('code', 'auth-code');
    redirect.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { Location: redirect.toString() });
    return res.end();
  }
  if (url.pathname === '/oauth-token') {
    const params = new URLSearchParams(await readBody(req));
    if (params.get('grant_type') === 'refresh_token') {
      counters.refresh += 1;
      if (params.get('refresh_token') !== acceptedRefreshToken) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'Refresh token was already used.' });
      }
      if (rotateRefreshTokens) acceptedRefreshToken = `rotated-${counters.refresh}`;
      if (holdRefreshRequest) await holdRefreshRequest();
      validTokens.add('token-refreshed');
      return json(res, 200, {
        access_token: 'token-refreshed', token_type: 'Bearer', expires_in: 3600,
        ...(rotateRefreshTokens ? { refresh_token: acceptedRefreshToken } : {}),
      });
    }
    if (holdCodeExchange) await holdCodeExchange();
    counters.token += 1;
    assert.equal(params.get('code'), 'auth-code');
    assert.ok(params.get('code_verifier'));
    validTokens.add('token-1');
    acceptedRefreshToken = 'refresh-1';
    return json(res, 200, {
      access_token: 'token-1',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'refresh-1',
    });
  }
  if (['/open/mcp', '/secure/mcp', '/tenant/mcp', '/api-key/mcp', '/query-key/mcp'].includes(url.pathname)) {
    if (url.pathname === '/query-key/mcp' && url.searchParams.get('api_key') !== 'private-query-key') return res.writeHead(403).end();
    const tenant = url.pathname === '/tenant/mcp';
    if (tenant && req.headers['x-tenant'] !== 'tenant-test') return res.writeHead(404).end();
    if (url.pathname === '/api-key/mcp' && req.headers.authorization !== 'Bearer fixture-key') return res.writeHead(401).end();
    if (url.pathname === '/secure/mcp' || tenant) {
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (!validTokens.has(token)) {
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${origin}/${tenant ? 'tenant-resource-metadata' : 'custom-resource-metadata'}"`,
        });
        return res.end();
      }
    }
    const body = req.method === 'POST' ? JSON.parse(await readBody(req)) : undefined;
    if (holdMcpRequest) await holdMcpRequest(body);
    if (res.destroyed) return;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = makeMcpServer();
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    return transport.handleRequest(req, res, body);
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${httpServer.address().port}`;

// The "browser": follow the authorization redirect back to Orion's loopback.
const openedUrls = [];
shell.openExternal = async (url) => {
  openedUrls.push(url);
  await fetch(url);
};

try {
  // --- Renderer helpers ----------------------------------------------------------
  const servers = [
    { id: 'a', nickname: 'durango', enabled: false },
    { id: 'b', nickname: 'durango-dev', enabled: true },
  ];
  assert.deepEqual(parseMcpMentions('make a clip with @durango please', servers).map((s) => s.id), ['a']);
  assert.deepEqual(parseMcpMentions('@durango-dev and @DURANGO', servers).map((s) => s.id), ['a', 'b']);
  assert.deepEqual(parseMcpMentions('mail me at x@durango', servers), []);
  assert.deepEqual(mergeMcpAttachments(['b', 'gone'], [servers[0], servers[1]], servers), ['b', 'a']);
  assert.match(buildMcpMentionsContext([servers[0]]), /\[MCP mentions\][\s\S]*@durango/);
  assert.equal(suggestMcpNickname('https://mcp.durango.sh/mcp', 'http'), 'durango');
  assert.equal(suggestMcpNickname('https://developers.openai.com/mcp', 'http'), 'openai');
  assert.equal(
    suggestMcpNickname('npx -y @modelcontextprotocol/server-filesystem ~/Documents', 'stdio'),
    'filesystem'
  );
  assert.equal(suggestMcpNickname('npx -y @modelcontextprotocol/server-github', 'stdio'), 'github');
  for (const [command, expected] of [
    ['node mcp-server.js --api-key private-test-key-123', 'node'],
    ['node -e "private-test-key-123"', 'node'],
    ['/opt/bin/custom-mcp --token private-test-key-123', 'custom'],
    ['npx -y @modelcontextprotocol/server-github@1.2.3 --token private-test-key-123', 'github'],
    ['bunx --yes server-github --token private-test-key-123', 'github'],
    ['uvx server-github --token private-test-key-123', 'github'],
    ['npx --registry private-test-key-123 server-github', 'npx'],
    ['uvx --from private-test-key-123 server-github', 'uvx'],
    ['npx https://user:private-test-key-123@example.test/server', 'npx'],
  ]) {
    assert.equal(suggestMcpNickname(command, 'stdio'), expected, 'argument values must not become public nicknames');
  }
  assert.deepEqual(splitCommandLine(`node "my server.js" --flag='a b' c\\ d`, false), [
    'node',
    'my server.js',
    '--flag=a b',
    'c d',
  ]);
  assert.deepEqual(splitCommandLine(String.raw`"C:\Program Files\nodejs\node.exe" "C:\tools\mcp-server.js"`, true), [
    String.raw`C:\Program Files\nodejs\node.exe`, String.raw`C:\tools\mcp-server.js`,
  ]);
  assert.deepEqual(splitCommandLine(String.raw`C:\node\node.exe .\server.js \\host\share\tools\server.js`, true), [
    String.raw`C:\node\node.exe`, String.raw`.\server.js`, String.raw`\\host\share\tools\server.js`,
  ]);
  assert.deepEqual(splitCommandLine(String.raw`node "C:\tools\\" "say \"hello\"" ""`, true), [
    'node', 'C:\\tools\\', 'say "hello"', '',
  ]);
  // POSIX double quotes preserve backslashes before ordinary characters too.
  assert.deepEqual(splitCommandLine(String.raw`node "C:\tools\server.js" "a\\b" "say \"hello\""`, false), [
    'node', String.raw`C:\tools\server.js`, String.raw`a\b`, 'say "hello"',
  ]);

  // --- Validation ------------------------------------------------------------------
  assert.equal((await orionMcps.addOrionMcp({ nickname: 'orion', url: `${origin}/open/mcp` })).ok, false);
  const browserCollision = await orionMcps.addOrionMcp({ nickname: 'chrome_devtools', url: `${origin}/open/mcp` });
  assert.equal(browserCollision.ok, false);
  assert.match(browserCollision.error, /reserved/);
  assert.equal((await orionMcps.addOrionMcp({ nickname: 'Bad Name', url: `${origin}/open/mcp` })).ok, false);
  assert.equal((await orionMcps.addOrionMcp({ nickname: 'x', url: 'ftp://nope' })).ok, false);
  const unreachable = await orionMcps.addOrionMcp({ nickname: 'missing', url: `${origin}/nothing` });
  assert.equal(unreachable.ok, false);
  assert.deepEqual((await orionMcps.listOrionMcps()).servers, [], 'failed adds must leave nothing behind');
  const legacy = await orionMcps.addOrionMcp({ nickname: 'legacy', url: `${origin}/legacy/sse` });
  assert.equal(legacy.ok, false, 'SSE-only servers must not be saved as streamable HTTP connections');
  assert.deepEqual((await orionMcps.listOrionMcps()).servers, []);

  // --- No-auth HTTP server -------------------------------------------------------------
  const open = await orionMcps.addOrionMcp({
    nickname: 'open',
    transport: 'http',
    url: `${origin}/open/mcp`,
  });
  assert.equal(open.ok, true, open.error);
  assert.deepEqual(open.tools, ['echo']);
  assert.equal(open.server.auth, 'none');
  assert.equal(open.server.enabled, false, 'new servers default to @-mention only');
  assert.equal((await orionMcps.updateOrionMcp({ id: open.server.id, nickname: 'chrome_devtools' })).ok, false);
  assert.equal(openedUrls.length, 0);
  assert.equal(
    (await orionMcps.addOrionMcp({ nickname: 'open', url: `${origin}/open/mcp` })).ok,
    false,
    'nicknames are unique'
  );

  // Full URLs can contain credentials. Save them privately and keep the
  // exact URL for runtime, matching and reconnect, including after migration.
  const queryUrl = `${origin}/query-key/mcp?api_key=private-query-key&team=one`;
  const queryMcp = await orionMcps.addOrionMcp({ nickname: 'query-key', transport: 'http', url: queryUrl });
  assert.equal(queryMcp.ok, true, queryMcp.error);
  assert.equal(JSON.stringify(queryMcp).includes('private-query-key'), false);
  const queryCredentialsPath = process.env.ORION_MCP_CREDENTIALS_PATH;
  const queryRegistryPath = process.env.ORION_MCPS_PATH;
  assert.equal((await fs.readFile(queryRegistryPath, 'utf8')).includes('private-query-key'), false);
  const queryCredentials = JSON.parse(await fs.readFile(queryCredentialsPath, 'utf8'));
  const queryEntries = JSON.parse(queryCredentials.value);
  assert.equal(queryEntries[queryMcp.server.id].url, queryUrl);
  assert.equal((await orionMcps.resolveOrionMcpsForRun([queryMcp.server.id])).servers[0].url, queryUrl);
  assert.equal((await orionMcps.readOrionMcpRegistryForMatching()).find((entry) => entry.id === queryMcp.server.id).url, queryUrl);
  assert.equal((await orionMcps.reconnectOrionMcp({ id: queryMcp.server.id })).ok, true);
  const legacyQueryRegistry = JSON.parse(await fs.readFile(queryRegistryPath, 'utf8'));
  const legacyQuery = legacyQueryRegistry.servers.find((entry) => entry.id === queryMcp.server.id);
  delete legacyQuery.endpoint;
  legacyQuery.url = queryUrl;
  delete queryEntries[queryMcp.server.id].url;
  await fs.writeFile(queryRegistryPath, JSON.stringify(legacyQueryRegistry));
  const legacyQueryBytes = await fs.readFile(queryRegistryPath, 'utf8');
  await fs.writeFile(queryCredentialsPath, 'invalid');
  assert.equal((await orionMcps.listOrionMcps()).ok, false);
  assert.equal(await fs.readFile(queryRegistryPath, 'utf8'), legacyQueryBytes, 'failed migration preserves the original URL');
  await fs.writeFile(queryCredentialsPath, JSON.stringify({ ...queryCredentials, value: JSON.stringify(queryEntries) }));
  const migratedQueryList = await orionMcps.listOrionMcps();
  assert.equal(migratedQueryList.ok, true);
  assert.equal(JSON.stringify(migratedQueryList).includes('private-query-key'), false);
  assert.equal((await fs.readFile(queryRegistryPath, 'utf8')).includes('private-query-key'), false);
  assert.equal((await orionMcps.reconnectOrionMcp({ id: queryMcp.server.id })).ok, true);
  assert.equal((await orionMcps.resolveOrionMcpsForRun([queryMcp.server.id])).servers[0].url, queryUrl);
  assert.equal((await orionMcps.removeOrionMcp({ id: queryMcp.server.id })).ok, true);

  // A successful registry commit must not be followed by a fallible read
  // whose cleanup could delete the now-referenced credentials.
  for (const failure of ['post-commit-read', 'registry-write']) {
    const originalRename = fs.rename;
    const originalReadFile = fs.readFile;
    const beforeRegistry = await fs.readFile(queryRegistryPath, 'utf8');
    const beforeCredentials = await fs.readFile(queryCredentialsPath, 'utf8');
    let committed = false;
    let postCommitReads = 0;
    fs.rename = async (...args) => {
      if (args[1] === queryRegistryPath && failure === 'registry-write') {
        throw Object.assign(new Error('simulated registry write failure'), { code: 'EIO' });
      }
      const result = await originalRename(...args);
      if (args[1] === queryRegistryPath) committed = true;
      return result;
    };
    fs.readFile = async (target, ...args) => {
      if (target === queryCredentialsPath && committed) {
        postCommitReads++;
        throw Object.assign(new Error('simulated credential read failure'), { code: 'EIO' });
      }
      return originalReadFile(target, ...args);
    };
    let result;
    try {
      result = await orionMcps.addOrionMcp({ nickname: 'commit-test', url: `${origin}/open/mcp` });
    } finally {
      fs.rename = originalRename;
      fs.readFile = originalReadFile;
    }
    if (failure === 'post-commit-read') {
      assert.equal(result.ok, true, result.error);
      assert.equal(postCommitReads, 0);
      assert.equal((await orionMcps.resolveOrionMcpsForRun([result.server.id])).servers[0].url, `${origin}/open/mcp`);
      assert.equal((await orionMcps.reconnectOrionMcp({ id: result.server.id })).ok, true);
      assert.equal((await orionMcps.removeOrionMcp({ id: result.server.id })).ok, true);
    } else {
      assert.equal(result.ok, false);
      assert.match(result.error, /simulated registry write failure/);
      assert.equal(await fs.readFile(queryRegistryPath, 'utf8'), beforeRegistry);
      assert.equal(await fs.readFile(queryCredentialsPath, 'utf8'), beforeCredentials, 'failed registry commit cleans up unreferenced credentials');
    }
  }

  // --- OAuth HTTP server: discovery, DCR, PKCE, loopback callback -------------------
  const secure = await orionMcps.addOrionMcp({
    nickname: 'secure',
    transport: 'http',
    url: `${origin}/secure/mcp`,
    enabled: false,
  });
  assert.equal(secure.ok, true, secure.error);
  assert.deepEqual(secure.tools, ['echo']);
  assert.equal(secure.server.auth, 'oauth');
  assert.equal(secure.server.status, 'ready');
  assert.equal(openedUrls.length, 1);
  assert.equal(counters.register, 1);
  assert.equal(counters.token, 1);

  const listed = await orionMcps.listOrionMcps();
  assert.deepEqual(listed.servers.map((server) => server.nickname), ['open', 'secure']);
  assert.equal(JSON.stringify(listed).includes('token-1'), false, 'tokens never reach the renderer');
  const registryText = await fs.readFile(process.env.ORION_MCPS_PATH, 'utf-8');
  assert.equal(registryText.includes('token-1'), false, 'the registry file carries no secrets');

  // --- Run resolution: off servers load only when attached -------------------------
  assert.deepEqual((await orionMcps.resolveOrionMcpsForRun([])).servers, []);
  const attached = await orionMcps.resolveOrionMcpsForRun([secure.server.id]);
  assert.deepEqual(attached.servers, [
    {
      name: 'secure',
      transport: 'http',
      url: `${origin}/secure/mcp`,
      headers: { Authorization: 'Bearer token-1' },
    },
  ]);
  assert.deepEqual((await orionMcps.updateOrionMcp({ id: open.server.id, enabled: true })), { ok: true });
  assert.deepEqual(
    (await orionMcps.resolveOrionMcpsForRun([])).servers.map((server) => server.name),
    ['open'],
    'enabled servers load in every run'
  );
  assert.equal(
    (await orionMcps.updateOrionMcp({ id: open.server.id, nickname: 'secure' })).ok,
    false,
    'renames keep nicknames unique'
  );

  // Near-expiry tokens refresh before the run instead of failing mid-turn.
  const credentialsPath = process.env.ORION_MCP_CREDENTIALS_PATH;
  const stored = JSON.parse(await fs.readFile(credentialsPath, 'utf-8'));
  assert.equal(stored.encrypted, false, 'dev builds skip the keychain');
  const credentials = JSON.parse(stored.value);
  assert.equal(credentials[secure.server.id].oauth.discovery.resourceMetadataUrl, `${origin}/custom-resource-metadata`);
  assert.equal(credentials[secure.server.id].oauth.discovery.authorizationServerUrl, `${origin}/oauth-issuer`);
  assert.equal(credentials[secure.server.id].oauth.discovery.authorizationServerMetadata.token_endpoint, `${origin}/oauth-token`);
  credentials[secure.server.id].oauth.obtainedAt = Date.now() - 3590 * 1000;
  await fs.writeFile(credentialsPath, JSON.stringify({ ...stored, value: JSON.stringify(credentials) }));
  const refreshed = await orionMcps.resolveOrionMcpsForRun([secure.server.id]);
  assert.equal(counters.refresh, 1);
  assert.equal(
    refreshed.servers.find((server) => server.name === 'secure').headers.Authorization,
    'Bearer token-refreshed'
  );
  let afterRefresh = JSON.parse(JSON.parse(await fs.readFile(credentialsPath, 'utf-8')).value);
  assert.equal(
    afterRefresh[secure.server.id].oauth.tokens.refresh_token,
    'refresh-1',
    'a refresh response without a refresh token keeps the previous one'
  );

  // Concurrent threads must share a rotating-token refresh. A second request
  // with the old token would invalidate even the winner's saved credentials.
  afterRefresh[secure.server.id].oauth.obtainedAt = Date.now() - 3590 * 1000;
  await fs.writeFile(credentialsPath, JSON.stringify({ ...stored, value: JSON.stringify(afterRefresh) }));
  rotateRefreshTokens = true;
  let refreshStarted;
  let releaseRefresh;
  const startedRefresh = new Promise((resolve) => { refreshStarted = resolve; });
  const heldRefresh = new Promise((resolve) => { releaseRefresh = resolve; });
  holdRefreshRequest = async () => { refreshStarted(); await heldRefresh; };
  const beforeConcurrentRefresh = counters.refresh;
  try {
    const firstRun = orionMcps.resolveOrionMcpsForRun([secure.server.id]);
    await startedRefresh;
    const otherRuns = [
      orionMcps.resolveOrionMcpsForRun([secure.server.id]),
      orionMcps.resolveOrionMcpsForRun([secure.server.id]),
    ];
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseRefresh();
    const runs = await Promise.all([firstRun, ...otherRuns]);
    assert.equal(counters.refresh, beforeConcurrentRefresh + 1);
    for (const run of runs) {
      assert.deepEqual(run.needsSignIn, []);
      assert.equal(run.servers.find((server) => server.name === 'secure').headers.Authorization, 'Bearer token-refreshed');
    }
  } finally {
    releaseRefresh();
    holdRefreshRequest = null;
  }
  afterRefresh = JSON.parse(JSON.parse(await fs.readFile(credentialsPath, 'utf8')).value);
  assert.equal(afterRefresh[secure.server.id].oauth.tokens.refresh_token, acceptedRefreshToken);
  // The in-flight entry must clear: the next expiration needs a fresh request.
  afterRefresh[secure.server.id].oauth.obtainedAt = 0;
  await fs.writeFile(credentialsPath, JSON.stringify({ ...stored, value: JSON.stringify(afterRefresh) }));
  assert.deepEqual((await orionMcps.resolveOrionMcpsForRun([secure.server.id])).needsSignIn, []);
  assert.equal(counters.refresh, beforeConcurrentRefresh + 2);
  afterRefresh = JSON.parse(JSON.parse(await fs.readFile(credentialsPath, 'utf8')).value);
  assert.equal(afterRefresh[secure.server.id].oauth.tokens.refresh_token, acceptedRefreshToken);
  rotateRefreshTokens = false;

  // A dead refresh token is reported, never silently opens a browser mid-run.
  afterRefresh[secure.server.id].oauth.obtainedAt = 0;
  afterRefresh[secure.server.id].oauth.tokens.refresh_token = undefined;
  await fs.writeFile(credentialsPath, JSON.stringify({ ...stored, value: JSON.stringify(afterRefresh) }));
  const expired = await orionMcps.resolveOrionMcpsForRun([secure.server.id]);
  assert.deepEqual(expired.needsSignIn, ['secure']);
  assert.equal(openedUrls.length, 1);
  assert.equal(
    (await orionMcps.listOrionMcps()).servers.find((server) => server.nickname === 'secure').status,
    'needs-sign-in'
  );
  const reconnected = await orionMcps.reconnectOrionMcp({ id: secure.server.id });
  assert.equal(reconnected.ok, true, reconnected.error);
  assert.equal(openedUrls.length, 2);
  assert.equal(
    (await orionMcps.listOrionMcps()).servers.find((server) => server.nickname === 'secure').status,
    'ready'
  );

  // Cancellation must still abort sign-in after the loopback callback has
  // resolved, while the authorization-code token exchange is in flight.
  let codeExchangeStarted;
  let releaseCodeExchange;
  const startedCodeExchange = new Promise((resolve) => { codeExchangeStarted = resolve; });
  const heldCodeExchange = new Promise((resolve) => { releaseCodeExchange = resolve; });
  holdCodeExchange = async () => { codeExchangeStarted(); await heldCodeExchange; };
  try {
    const reconnecting = orionMcps.reconnectOrionMcp({ id: secure.server.id });
    await startedCodeExchange;
    orionMcps.cancelOrionMcpSignIn(secure.server.id);
    const result = await Promise.race([
      reconnecting,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Cancelled token exchange did not settle')), 2000)),
    ]);
    assert.equal(result.ok, false);
    assert.match(result.error, /cancelled/i);
    releaseCodeExchange();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const cancelledCredentials = JSON.parse(JSON.parse(await fs.readFile(credentialsPath, 'utf8')).value);
    assert.equal(cancelledCredentials[secure.server.id].oauth.tokens, undefined, 'cancelled exchanges cannot save tokens');
  } finally {
    releaseCodeExchange();
    holdCodeExchange = null;
  }
  // Cancellation is registered before even the first registry read.
  const earlyReconnect = orionMcps.reconnectOrionMcp({ id: secure.server.id });
  orionMcps.cancelOrionMcpSignIn(secure.server.id);
  assert.equal((await earlyReconnect).ok, false);
  assert.equal((await orionMcps.reconnectOrionMcp({ id: secure.server.id })).ok, true);

  // Tenant headers must accompany both initial OAuth probing and reconnect.
  const tenant = await orionMcps.addOrionMcp({
    nickname: 'tenant', url: `${origin}/tenant/mcp`, headers: {
      'X-Tenant': 'tenant-test', authorization: 'Bearer expired-api-token', AUTHORIZATION: 'Bearer another-expired-token',
    },
  });
  assert.equal(tenant.ok, true, tenant.error);
  assert.equal(tenant.server.auth, 'oauth');
  const tenantRun = await orionMcps.resolveOrionMcpsForRun([tenant.server.id]);
  assert.deepEqual(tenantRun.servers.find((server) => server.name === 'tenant').headers, {
    'X-Tenant': 'tenant-test', Authorization: 'Bearer token-1',
  });
  assert.deepEqual((await orionMcps.readOrionMcpRegistryForMatching()).find((server) => server.id === tenant.server.id).headers, {
    'X-Tenant': 'tenant-test', Authorization: 'Bearer token-1',
  }, 'matching uses the same effective headers as connection and runtime');
  const tenantCredentials = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
  const tenantEntries = JSON.parse(tenantCredentials.value);
  tenantEntries[tenant.server.id].oauth.obtainedAt = 0;
  await fs.writeFile(credentialsPath, JSON.stringify({ ...tenantCredentials, value: JSON.stringify(tenantEntries) }));
  const refreshedTenant = await orionMcps.resolveOrionMcpsForRun([tenant.server.id]);
  assert.deepEqual(refreshedTenant.servers.find((server) => server.name === 'tenant').headers, {
    'X-Tenant': 'tenant-test', Authorization: 'Bearer token-refreshed',
  }, 'refresh replaces every stale authorization spelling');
  const tenantReconnect = await orionMcps.reconnectOrionMcp({ id: tenant.server.id });
  assert.equal(tenantReconnect.ok, true, tenantReconnect.error);
  assert.deepEqual(await orionMcps.removeOrionMcp({ id: tenant.server.id }), { ok: true });
  const browserCountBeforeApiKey = openedUrls.length;
  const apiKey = await orionMcps.addOrionMcp({
    nickname: 'api-key', url: `${origin}/api-key/mcp`, headers: { authorization: 'Bearer fixture-key' },
  });
  assert.equal(apiKey.ok, true, apiKey.error);
  assert.equal(apiKey.server.auth, 'none');
  assert.equal(openedUrls.length, browserCountBeforeApiKey, 'working API keys do not trigger OAuth');
  assert.deepEqual(await orionMcps.removeOrionMcp({ id: apiKey.server.id }), { ok: true });

  // A stopped turn stops waiting promptly without cancelling another turn's
  // shared refresh. A stalled refresh has a separate application deadline.
  const expireSecureToken = async () => {
    const saved = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
    const entries = JSON.parse(saved.value);
    entries[secure.server.id].oauth.obtainedAt = 0;
    await fs.writeFile(credentialsPath, JSON.stringify({ ...saved, value: JSON.stringify(entries) }));
  };
  for (const scenario of ['cancel-waiter', 'deadline']) {
    await expireSecureToken();
    let started, release;
    const refreshing = new Promise((resolve) => { started = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    holdRefreshRequest = async () => { started(); await held; };
    const originalSetTimeout = globalThis.setTimeout;
    try {
      if (scenario === 'deadline') {
        globalThis.setTimeout = (callback, ms, ...args) => originalSetTimeout(callback, ms === 20_000 ? 200 : ms, ...args);
      }
      const controller = new AbortController();
      const first = orionMcps.resolveOrionMcpsForRun([secure.server.id], { signal: controller.signal });
      await refreshing;
      if (scenario === 'cancel-waiter') {
        const second = orionMcps.resolveOrionMcpsForRun([secure.server.id]);
        const stopped = assert.rejects(first, /Turn stopped/);
        controller.abort(new Error('Turn stopped'));
        await Promise.race([stopped, new Promise((_, reject) => originalSetTimeout(() => reject(new Error('Stop did not release the waiter')), 2000))]);
        release();
        assert.deepEqual((await second).needsSignIn, [], 'another turn still receives the refreshed token');
      } else {
        const result = await Promise.race([first, new Promise((_, reject) => originalSetTimeout(() => reject(new Error('Refresh deadline did not settle')), 2000))]);
        assert.deepEqual(result.needsSignIn, ['secure']);
        const afterTimeout = JSON.parse(JSON.parse(await fs.readFile(credentialsPath, 'utf8')).value);
        assert.equal(afterTimeout[secure.server.id].oauth.obtainedAt, 0, 'timed-out refresh cannot write tokens');
      }
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      release();
      holdRefreshRequest = null;
    }
  }
  assert.deepEqual((await orionMcps.resolveOrionMcpsForRun([secure.server.id])).needsSignIn, [], 'a new run retries after timeout');
  // Restore the fixture token used by the provider-shape assertions below.
  assert.equal((await orionMcps.reconnectOrionMcp({ id: secure.server.id })).ok, true);

  // --- Local (stdio) server with environment -------------------------------------------
  const sdkRoot = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'node_modules',
    '@modelcontextprotocol',
    'sdk',
    'dist',
    'esm',
    'server'
  );
  const stdioScript = path.join(testRoot, 'stdio-server.mjs');
  // A hex-only value can accidentally occur inside the public random UUID.
  const privateEnvValue = 'orion-private-env-sentinel';
  await fs.writeFile(
    stdioScript,
    `import { McpServer } from ${JSON.stringify(path.join(sdkRoot, 'mcp.js'))};
import { StdioServerTransport } from ${JSON.stringify(path.join(sdkRoot, 'stdio.js'))};
const server = new McpServer({ name: 'stdio', version: '1.0.0' });
server.registerTool('secret_' + process.env.TEST_SECRET, { description: 'x' }, async () => ({ content: [] }));
await server.connect(new StdioServerTransport());
`
  );
  const local = await orionMcps.addOrionMcp({
    nickname: 'local_tools',
    transport: 'stdio',
    command: process.execPath,
    args: [stdioScript, '--token', 'private-argument-value'],
    env: { ELECTRON_RUN_AS_NODE: '1', TEST_SECRET: privateEnvValue },
  });
  assert.equal(local.ok, true, local.error);
  assert.deepEqual(local.tools, [`secret_${privateEnvValue}`]);
  const localEntry = (await orionMcps.listOrionMcps()).servers.find((server) => server.id === local.server.id);
  assert.deepEqual(localEntry.envNames, ['ELECTRON_RUN_AS_NODE', 'TEST_SECRET']);
  assert.equal(JSON.stringify(localEntry).includes(privateEnvValue), false);
  assert.equal(JSON.stringify({ ...localEntry, id: '00000000-0000-4000-8000-000000000abc' }).includes(privateEnvValue), false);

  const privateArgs = [stdioScript, '--token', 'private-argument-value'];
  assert.equal(JSON.stringify(local).includes('private-argument-value'), false);
  assert.equal(JSON.stringify(localEntry).includes('private-argument-value'), false);
  assert.equal((await fs.readFile(process.env.ORION_MCPS_PATH, 'utf8')).includes('private-argument-value'), false);
  const savedLocalCredentials = JSON.parse(JSON.parse(await fs.readFile(credentialsPath, 'utf8')).value);
  assert.deepEqual(savedLocalCredentials[local.server.id].args, privateArgs);
  assert.deepEqual((await orionMcps.readOrionMcpRegistryForMatching()).find((entry) => entry.id === local.server.id).args, privateArgs);
  assert.equal((await orionMcps.reconnectOrionMcp({ id: local.server.id })).ok, true);

  // Migrate an older registry without losing arguments or other credentials.
  const legacyRegistry = JSON.parse(await fs.readFile(process.env.ORION_MCPS_PATH, 'utf8'));
  legacyRegistry.servers.find((entry) => entry.id === local.server.id).args = privateArgs;
  await fs.writeFile(process.env.ORION_MCPS_PATH, JSON.stringify(legacyRegistry));
  const beforeMigration = await fs.readFile(process.env.ORION_MCPS_PATH, 'utf8');
  const credentialBackup = await fs.readFile(credentialsPath, 'utf8');
  await fs.writeFile(credentialsPath, 'broken');
  assert.equal((await orionMcps.listOrionMcps()).ok, false);
  assert.equal(await fs.readFile(process.env.ORION_MCPS_PATH, 'utf8'), beforeMigration);
  delete savedLocalCredentials[local.server.id].args;
  await fs.writeFile(credentialsPath, JSON.stringify({ ...JSON.parse(credentialBackup), value: JSON.stringify(savedLocalCredentials) }));
  assert.equal((await orionMcps.listOrionMcps()).ok, true);
  assert.equal((await fs.readFile(process.env.ORION_MCPS_PATH, 'utf8')).includes('private-argument-value'), false);
  const migratedRun = await orionMcps.resolveOrionMcpsForRun([local.server.id]);
  assert.deepEqual(migratedRun.servers.find((entry) => entry.name === 'local_tools').args, privateArgs);
  assert.equal((await orionMcps.reconnectOrionMcp({ id: local.server.id })).ok, true);

  // --- Provider shapes ------------------------------------------------------------------
  const run = await orionMcps.resolveOrionMcpsForRun([secure.server.id, local.server.id]);
  assert.deepEqual(run.servers.map((server) => server.name).sort(), ['local_tools', 'open', 'secure']);
  const claude = orionMcps.claudeOrionMcpServers(run.servers);
  assert.equal(claude.secure.type, 'http');
  assert.equal(claude.secure.headers.Authorization, 'Bearer token-1');
  assert.equal(claude.local_tools.type, 'stdio');

  const codex = orionMcps.withCodexOrionMcps(
    { mcp_servers: { github: { enabled: false } } },
    run.servers,
    'workspace-write'
  );
  assert.deepEqual(codex.mcp_servers.github, { enabled: false }, 'Codex overrides are preserved');
  assert.equal(codex.mcp_servers.secure.http_headers.Authorization, 'Bearer token-1');
  assert.equal(codex.mcp_servers.secure.default_tools_approval_mode, 'approve');
  assert.equal(codex.mcp_servers.local_tools.env.TEST_SECRET, privateEnvValue);
  assert.equal(
    orionMcps.withCodexOrionMcps({}, run.servers, 'read-only').mcp_servers.secure.default_tools_approval_mode,
    undefined,
    'Read only never pre-approves external tools'
  );
  assert.deepEqual(orionMcps.withCodexOrionMcps({}, [], 'full-access'), {});
  // Codex rejects a config map mixing an mcp_servers table with dotted
  // mcp_servers.orion.* keys, so the bridge must fold into the table.
  const appServer = codexAppServerConfig(
    { providerId: 'codex', slug: 'gpt-6-luna' },
    {
      accessMode: 'full-access',
      providerOptions: {},
      mcpRuntimeConfig: codex,
      orionMcp: { command: '/orion', args: ['shim.cjs'] },
    }
  );
  assert.equal(
    Object.keys(appServer).some((key) => key.startsWith('mcp_servers.')),
    false,
    'no dotted mcp_servers keys remain beside the table'
  );
  assert.equal(appServer.mcp_servers.orion.command, '/orion');
  assert.equal(appServer.mcp_servers.orion.default_tools_approval_mode, 'approve');
  assert.equal(appServer.mcp_servers.secure.url, `${origin}/secure/mcp`);
  const bridgeOnly = codexAppServerConfig(
    { providerId: 'codex', slug: 'gpt-6-luna' },
    { accessMode: 'full-access', providerOptions: {}, orionMcp: { command: '/orion', args: [] } }
  );
  assert.equal(bridgeOnly['mcp_servers.orion.command'], '/orion', 'plain runs keep the dotted form');

  const bridge = { command: '/orion', args: ['shim.cjs'], userServers: run.servers };
  const plugin = mcpBridgePluginConfig(bridge);
  assert.deepEqual(Object.keys(plugin.mcpServers).sort(), ['local_tools', 'open', 'orion', 'secure']);
  assert.equal(plugin.mcpServers.secure.type, 'http');
  const acp = orionAcpMcpServers(bridge);
  assert.equal(acp.at(-1).name, 'orion');
  assert.deepEqual(
    acp.find((server) => server.name === 'secure').headers,
    [{ name: 'Authorization', value: 'Bearer token-1' }]
  );
  const openCode = JSON.parse(openCodeMcpConfigContent(bridge, JSON.stringify({ mcp: { mine: {} } })));
  assert.deepEqual(Object.keys(openCode.mcp).sort(), ['local_tools', 'mine', 'open', 'orion', 'secure']);
  assert.equal(openCode.mcp.secure.type, 'remote');
  assert.deepEqual(openCode.mcp.local_tools.command, [process.execPath, ...privateArgs]);

  assert.throws(() => orionMcps.museOrionMcpServers(run.servers), /Muse does not support HTTP MCP servers: @open, @secure/);
  assert.deepEqual(Object.keys(orionMcps.museOrionMcpServers(run.servers.filter((server) => server.transport === 'stdio'))), ['local_tools']);

  // Negotiate a fake ACP agent through the real driver. Unsupported transports
  // must fail before session creation or resume; supported HTTP is passed intact.
  for (const httpSupport of [undefined, false, true]) {
    for (const resumeSessionId of [undefined, 'existing']) {
      const requests = [];
      const failures = [];
      let driver;
      driver = createKimiAcpDriver({
        child: { stdin: { write: (line) => {
          const request = JSON.parse(line);
          requests.push(request);
          const response = request.method === 'initialize'
            ? { result: { agentCapabilities: { mcpCapabilities: { http: httpSupport } } } }
            : { error: { message: 'fixture stopped after session request' } };
          queueMicrotask(() => driver.handleMessage({ id: request.id, ...response }));
        } } },
        cwd: testRoot, model: { slug: 'test' }, promptText: 'test', resumeSessionId,
        mcpServers: acp, callbacks: { onFatal: (message) => failures.push(message), onResumeFallback: () => {} },
      });
      await driver.start();
      if (httpSupport === true) {
        assert.deepEqual(requests[1].params.mcpServers, acp);
        assert.equal(requests[1].method, resumeSessionId ? 'session/load' : 'session/new');
      } else {
        assert.deepEqual(requests.map((request) => request.method), ['initialize']);
        assert.match(failures[0], /does not support HTTP MCP servers: @open, @secure/);
      }
    }
  }

  // Servers shared from Codex can depend on cwd for both their script and
  // data files. Exercise every provider's launch config from another folder,
  // including literal shell metacharacters, with real MCP stdio traffic.
  const serverCwd = path.join(testRoot, "server ' $(literal) folder");
  await fs.mkdir(serverCwd);
  await fs.writeFile(path.join(serverCwd, 'data.txt'), 'relative data');
  await fs.writeFile(path.join(serverCwd, 'server.mjs'), `
import fs from 'node:fs/promises';
import { McpServer } from ${JSON.stringify(path.join(sdkRoot, 'mcp.js'))};
import { StdioServerTransport } from ${JSON.stringify(path.join(sdkRoot, 'stdio.js'))};
const server = new McpServer({ name: 'cwd-test', version: '1.0.0' });
server.registerTool('inspect', {}, async () => ({ content: [{ type: 'text', text: JSON.stringify({
  cwd: process.cwd(), args: process.argv.slice(2), data: await fs.readFile('data.txt', 'utf8'),
  secret: process.env.TEST_SECRET, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, pid: process.pid,
}) }] }));
await server.connect(new StdioServerTransport());
`);
  const literalArg = `space ' " $(not-a-command) & ;`;
  const cwdServer = {
    name: 'cwd-test', transport: 'stdio', command: 'node', args: ['server.mjs', literalArg],
    env: { TEST_SECRET: 'cwd-secret' }, cwd: serverCwd,
  };
  const acpCwd = orionMcps.acpOrionMcpServers([cwdServer])[0];
  const openCodeCwd = orionMcps.openCodeOrionMcpServers([cwdServer])['cwd-test'];
  const cwdConfigs = {
    claude: orionMcps.claudeOrionMcpServers([cwdServer])['cwd-test'],
    codex: orionMcps.codexOrionMcpServers([cwdServer])['cwd-test'],
    plugin: orionMcps.pluginOrionMcpServers([cwdServer])['cwd-test'],
    acp: { ...acpCwd, env: Object.fromEntries(acpCwd.env.map(({ name, value }) => [name, value])) },
    opencode: { command: openCodeCwd.command[0], args: openCodeCwd.command.slice(1), env: openCodeCwd.environment },
    muse: orionMcps.museOrionMcpServers([cwdServer])['cwd-test'],
  };
  for (const [provider, config] of Object.entries(cwdConfigs)) {
    const client = new Client({ name: 'cwd-regression', version: '1.0.0' });
    const transport = new StdioClientTransport({ ...config, cwd: config.cwd ?? testRoot, stderr: 'pipe' });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'inspect', arguments: {} });
      const observed = JSON.parse(result.content[0].text);
      assert.equal(await fs.realpath(observed.cwd), await fs.realpath(serverCwd), provider);
      assert.deepEqual(observed.args, [literalArg], provider);
      assert.equal(observed.data, 'relative data', provider);
      assert.equal(observed.secret, 'cwd-secret', provider);
      assert.equal(observed.runAsNode, process.env.ELECTRON_RUN_AS_NODE ?? null, provider);
      if (provider === 'claude') {
        // A provider stopping the launcher must also terminate the MCP child.
        const closed = new Promise((resolve) => { transport.onclose = resolve; });
        process.kill(transport.pid, 'SIGTERM');
        await closed;
        assert.throws(() => process.kill(observed.pid, 0), { code: 'ESRCH' });
      }
    } finally {
      await client.close();
    }
  }

  // --- Claude: live sessions sync through setMcpServers, keeping `orion` -------------------
  const calls = [];
  const session = {
    orionMcpServer: { type: 'sdk', name: 'orion' },
    query: {
      setMcpServers: async (value) => {
        calls.push(value);
        return { added: Object.keys(value), removed: [], errors: {} };
      },
    },
  };
  assert.deepEqual(await syncClaudeOrionMcpServers(session, {}), {}, 'no Orion MCPs: no control request');
  assert.equal(calls.length, 0);
  await syncClaudeOrionMcpServers(session, claude);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['local_tools', 'open', 'orion', 'secure']);
  assert.equal(calls[0].orion, session.orionMcpServer);
  await syncClaudeOrionMcpServers(session, claude);
  assert.equal(calls.length, 1, 'an unchanged set is not re-sent');
  await syncClaudeOrionMcpServers(session, {});
  assert.deepEqual(Object.keys(calls[1]), ['orion'], 'detaching unloads the server but keeps Orion tools');
  session.query.setMcpServers = async () => ({ errors: { open: 'boom' } });
  assert.deepEqual(await syncClaudeOrionMcpServers(session, { open: claude.open }), { open: 'boom' });
  assert.deepEqual(
    await syncClaudeOrionMcpServers(session, { open: claude.open }),
    { open: 'boom' },
    'a failed connection is retried and its error remains visible'
  );
  let recoveredCalls = 0;
  session.query.setMcpServers = async () => {
    recoveredCalls++;
    return { errors: {} };
  };
  await syncClaudeOrionMcpServers(session, { open: claude.open });
  await syncClaudeOrionMcpServers(session, { open: claude.open });
  assert.equal(recoveredCalls, 1, 'only a successful retry is cached');
  session.query.setMcpServers = async () => ({ errors: { local_tools: 'offline' } });
  await syncClaudeOrionMcpServers(session, claude);
  session.query.setMcpServers = async () => {
    recoveredCalls++;
    return { errors: {} };
  };
  await syncClaudeOrionMcpServers(session, { open: claude.open });
  assert.equal(recoveredCalls, 2, 'reverting after a partial failure must also resynchronize');
  session.query.setMcpServers = async () => { throw new Error('control channel failed'); };
  await assert.rejects(syncClaudeOrionMcpServers(session, {}), /control channel failed/);
  session.query.setMcpServers = async () => {
    recoveredCalls++;
    return { errors: {} };
  };
  await syncClaudeOrionMcpServers(session, {});
  assert.equal(recoveredCalls, 3, 'failed detaches are retried even when the desired set is empty');

  // A real turn must dispose the session and never enqueue a prompt if the
  // old MCP set could not be removed, including a control request timeout.
  for (const failure of ['reject', 'timeout', 'partial-removal']) {
    const sender = { isDestroyed: () => false, send() {} };
    const input = { threadId: `detach-${failure}`, projectPath: testRoot, prompt: 'next turn', accessMode: 'full-access', orionMcpServers: {} };
    const model = { providerId: 'claude', slug: 'claude-sonnet-4-6' };
    const live = createClaudeSdkSession({ sender, threadId: input.threadId, projectPath: testRoot, model, input });
    live.orionMcpServers = { open: claude.open };
    live.orionMcpKey = JSON.stringify(live.orionMcpServers);
    live.orionMcpServer = {};
    live.query = { setMcpServers: async () => {
      if (failure === 'timeout') return new Promise(() => {});
      if (failure === 'partial-removal') return { errors: { open: 'could not unload' } };
      throw new Error('control channel failed');
    } };
    let prompts = 0;
    live.pushUserMessage = () => { prompts++; };
    claudeSdkSessions.set(input.threadId, live);
    const originalSetTimeout = globalThis.setTimeout;
    try {
      globalThis.setTimeout = (callback, ms, ...args) => originalSetTimeout(callback, ms === 20_000 ? 20 : ms, ...args);
      const result = await runClaudeSdkTurn({ sender, input, model, runId: input.threadId, initialSnapshot: null });
      assert.equal(result.ok, false, failure);
      assert.match(result.error, /synchronize MCP/);
      assert.equal(live.disposed, true);
      assert.equal(live.abortController.signal.aborted, true);
      assert.equal(prompts, 0);
      assert.equal(claudeSdkSessions.has(input.threadId), false);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      claudeSdkSessions.delete(input.threadId);
      terminatingClaudeSdkSessions.delete(input.threadId);
    }
  }

  // --- Add cancellation: early startup, browser wait, and late tool discovery -------
  const registryBeforeCancel = await fs.readFile(process.env.ORION_MCPS_PATH, 'utf8');
  const credentialsBeforeCancel = await fs.readFile(credentialsPath, 'utf8');
  const earlyAdd = orionMcps.addOrionMcp({
    operationId: 'cancel-early', nickname: 'cancel-early', url: `${origin}/secure/mcp`,
  });
  orionMcps.cancelOrionMcpSignIn(undefined, 'cancel-early');
  assert.equal((await earlyAdd).ok, false, 'Cancel works before the first async read finishes');

  const originalOpenExternal = shell.openExternal;
  let browserOpened;
  const browserReady = new Promise(resolve => { browserOpened = resolve; });
  shell.openExternal = async url => { browserOpened(url); };
  try {
    const browserAdd = orionMcps.addOrionMcp({
      operationId: 'cancel-browser', nickname: 'cancel-browser', url: `${origin}/secure/mcp`,
    });
    await browserReady;
    orionMcps.cancelOrionMcpSignIn(undefined, 'unrelated-operation');
    // An unrelated operation must not cancel this listener or its credentials.
    orionMcps.cancelOrionMcpSignIn(undefined, 'cancel-browser');
    const result = await browserAdd;
    assert.equal(result.ok, false);
    assert.match(result.error, /cancelled/i);
  } finally {
    shell.openExternal = originalOpenExternal;
  }

  for (const method of ['initialize', 'tools/list']) {
    let requestStarted;
    let releaseRequest;
    const started = new Promise(resolve => { requestStarted = resolve; });
    const held = new Promise(resolve => { releaseRequest = resolve; });
    holdMcpRequest = async body => {
      if (body?.method === method) {
        requestStarted();
        await held;
      }
    };
    try {
      const pending = orionMcps.addOrionMcp({
        operationId: 'cancel-probe', nickname: 'cancel-probe', url: `${origin}/open/mcp`,
      });
      await started;
      orionMcps.cancelOrionMcpSignIn(undefined, 'cancel-probe');
      const result = await pending;
      assert.equal(result.ok, false, `Cancel during ${method} must stop the add`);
      assert.match(result.error, /cancelled/i);
    } finally {
      holdMcpRequest = null;
      releaseRequest();
    }
  }
  assert.equal(await fs.readFile(process.env.ORION_MCPS_PATH, 'utf8'), registryBeforeCancel);
  assert.equal(await fs.readFile(credentialsPath, 'utf8'), credentialsBeforeCancel, 'cancelled adds leave no credentials');

  // --- Credential failures preserve both files and surface an error ----------------
  for (const unreadable of [
    '{broken',
    JSON.stringify({ version: 1, encrypted: false }),
    JSON.stringify({ version: 1, encrypted: false, value: '[]' }),
    JSON.stringify({ version: 1, encrypted: true, value: 'unavailable-keychain' }),
  ]) {
    await fs.writeFile(credentialsPath, unreadable);
    try {
      assert.equal((await orionMcps.listOrionMcps()).ok, false);
      assert.equal((await orionMcps.removeOrionMcp({ id: local.server.id })).ok, false);
      assert.equal((await orionMcps.addOrionMcp({ nickname: 'blocked', url: `${origin}/open/mcp` })).ok, false);
      assert.equal(await fs.readFile(credentialsPath, 'utf8'), unreadable, 'failed writes preserve the original bytes');
      assert.equal(await fs.readFile(process.env.ORION_MCPS_PATH, 'utf8'), registryBeforeCancel);
    } finally {
      await fs.writeFile(credentialsPath, credentialsBeforeCancel);
    }
  }
  const originalReadFile = fs.readFile;
  fs.readFile = async (target, ...args) => {
    if (target === credentialsPath) throw Object.assign(new Error('Access denied'), { code: 'EACCES' });
    return originalReadFile(target, ...args);
  };
  try {
    assert.equal((await orionMcps.removeOrionMcp({ id: local.server.id })).ok, false);
  } finally {
    fs.readFile = originalReadFile;
  }
  assert.equal(await fs.readFile(credentialsPath, 'utf8'), credentialsBeforeCancel);
  assert.equal(await fs.readFile(process.env.ORION_MCPS_PATH, 'utf8'), registryBeforeCancel);

  // Registry failures must have the same preservation guarantee as credentials.
  const registryPath = process.env.ORION_MCPS_PATH;
  for (const unreadable of [
    '{broken', '{}', '[]',
    JSON.stringify({ version: 1, servers: [null] }),
    JSON.stringify({ version: 2, servers: [] }),
  ]) {
    await fs.writeFile(registryPath, unreadable);
    try {
      assert.equal((await orionMcps.listOrionMcps()).ok, false);
      assert.equal((await orionMcps.removeOrionMcp({ id: local.server.id })).ok, false);
      assert.equal((await orionMcps.updateOrionMcp({ id: local.server.id, enabled: true })).ok, false);
      assert.equal((await orionMcps.reconnectOrionMcp({ id: local.server.id })).ok, false);
      assert.equal((await orionMcps.addOrionMcp({ nickname: 'blocked', url: `${origin}/open/mcp` })).ok, false);
      assert.equal(await fs.readFile(registryPath, 'utf8'), unreadable);
      assert.equal(await fs.readFile(credentialsPath, 'utf8'), credentialsBeforeCancel);
    } finally {
      await fs.writeFile(registryPath, registryBeforeCancel);
    }
  }
  fs.readFile = async (target, ...args) => {
    if (target === registryPath) throw Object.assign(new Error('Access denied'), { code: 'EACCES' });
    return originalReadFile(target, ...args);
  };
  try {
    assert.equal((await orionMcps.listOrionMcps()).ok, false);
    assert.equal((await orionMcps.removeOrionMcp({ id: local.server.id })).ok, false);
    assert.equal((await orionMcps.addOrionMcp({ nickname: 'blocked', url: `${origin}/open/mcp` })).ok, false);
  } finally {
    fs.readFile = originalReadFile;
  }
  assert.equal(await fs.readFile(registryPath, 'utf8'), registryBeforeCancel);
  assert.equal(await fs.readFile(credentialsPath, 'utf8'), credentialsBeforeCancel);

  // --- Removal -----------------------------------------------------------------------------
  // A pending refresh must not resurrect credentials after deletion, and must
  // settle without waiting for the authorization server's held response.
  const beforeRemoval = JSON.parse(JSON.parse(await fs.readFile(credentialsPath, 'utf8')).value);
  beforeRemoval[secure.server.id].oauth.obtainedAt = 0;
  await fs.writeFile(credentialsPath, JSON.stringify({ ...stored, value: JSON.stringify(beforeRemoval) }));
  let removalRefreshStarted;
  let releaseRemovalRefresh;
  const startedRemovalRefresh = new Promise((resolve) => { removalRefreshStarted = resolve; });
  const heldRemovalRefresh = new Promise((resolve) => { releaseRemovalRefresh = resolve; });
  holdRefreshRequest = async () => { removalRefreshStarted(); await heldRemovalRefresh; };
  try {
    const refreshing = orionMcps.resolveOrionMcpsForRun([secure.server.id]);
    await startedRemovalRefresh;
    assert.deepEqual(await orionMcps.removeOrionMcp({ id: secure.server.id }), { ok: true });
    const result = await Promise.race([
      refreshing,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Removed refresh did not settle')), 2000)),
    ]);
    assert.ok(!result.servers.some((server) => server.name === 'secure'));
    releaseRemovalRefresh();
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    releaseRemovalRefresh();
    holdRefreshRequest = null;
  }
  const finalCredentials = JSON.parse(JSON.parse(await fs.readFile(credentialsPath, 'utf-8')).value);
  assert.equal(finalCredentials[secure.server.id], undefined, 'removal deletes stored tokens');
  assert.deepEqual(
    (await orionMcps.resolveOrionMcpsForRun([secure.server.id])).servers.map((server) => server.name),
    ['open'],
    'attachments to removed servers are ignored'
  );

  // --- main.js wiring --------------------------------------------------------------------------
  const mainSource = await fs.readFile(new URL('../src/main.js', import.meta.url), 'utf-8');
  const runTurnSource = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('agent:runTurn'"),
    mainSource.indexOf("ipcMain.handle('agent:steerTurn'")
  );
  // Execute the actual launch block: a missing shared lease and a failed
  // live connection both fall back directly without changing shell context.
  const shellContextStart = runTurnSource.indexOf('    const codexHasProcessArgs =');
  const shellContextEnd = runTurnSource.indexOf('    let runtimeInput =', shellContextStart);
  const launchStart = runTurnSource.indexOf('    const persistentCodexAppServer =');
  const launchEnd = runTurnSource.indexOf("    let stderr = '';", launchStart);
  assert.ok(shellContextStart >= 0 && shellContextEnd > shellContextStart);
  assert.ok(launchStart >= 0 && launchEnd > launchStart);
  const captureLaunch = new Function('input', 'useCodexAppServer', 'forceDirectCodexAppServer', 'codexAppServerLease', 'os', `
    const model = { providerId: 'codex' };
    const runtimeInput = input;
    const useAcp = false;
    const resumeSessionId = null;
    const forkWithNativeFlag = false;
    const orionMcp = null;
    const openCodeConfig = null;
    const museConfigRoot = null;
    const loginShell = '/bin/zsh';
    const process = { env: {} };
    const commandForModel = () => ['codex', 'app-server'];
    const shellQuote = (value) => value;
    const withClaudeEnv = (value) => value;
    const spawnCodexServerProcess = (_command, _args, options) => ({ kind: 'codex', options });
    const spawn = (_command, _args, options) => ({ kind: 'exec', options });
    ${runTurnSource.slice(shellContextStart, shellContextEnd)}
    ${runTurnSource.slice(launchStart, launchEnd)}
    return child;
  `);
  const launchInput = { projectPath: path.join(testRoot, 'workspace') };
  const launchOs = { homedir: () => testRoot };
  const sharedChild = { kind: 'shared' };
  const sharedLease = { persistent: true, child: sharedChild };
  for (const [lease, forceDirect] of [
    [{ persistent: false, child: null }, false], // service unavailable at acquire
    [sharedLease, true], // existing connection failed; retry this turn directly
  ]) {
    const launched = captureLaunch(launchInput, true, forceDirect, lease, launchOs);
    assert.equal(launched.kind, 'codex');
    assert.equal(launched.options.cwd, testRoot, 'fallback must preserve the checked home-shell environment');
  }
  assert.equal(captureLaunch(launchInput, true, false, sharedLease, launchOs), sharedChild);
  const customizedLaunch = captureLaunch({ ...launchInput, providerOptions: { extraArgs: '--profile work' } }, true, false, null, launchOs);
  assert.equal(customizedLaunch.options.cwd, launchInput.projectPath, 'customized runs retain their checked project-shell environment');
  assert.equal(captureLaunch(launchInput, false, false, null, launchOs).options.cwd, launchInput.projectPath, 'other launches still start in the project');
  const resolutionStart = runTurnSource.indexOf('    const orionMcps =');
  const resolutionEnd = runTurnSource.indexOf("    if (model.providerId === 'muse')", resolutionStart);
  assert.ok(resolutionStart >= 0 && resolutionEnd > resolutionStart);
  const resolveStartup = new (Object.getPrototypeOf(async function () {}).constructor)(
    'input', 'startupController', 'startingAgentRuns', 'runId', 'resolveOrionMcpsForRun',
    runTurnSource.slice(resolutionStart, resolutionEnd) + '\nreturn orionMcps;',
  );
  const startupCredentialsBackup = await fs.readFile(credentialsPath, 'utf8');
  try {
    await fs.writeFile(credentialsPath, 'invalid-json');
    await assert.rejects(
      resolveStartup({}, new AbortController(), new Map(), 'failed-start', orionMcps.resolveOrionMcpsForRun),
      /saved MCP credentials/,
      'startup must propagate storage failures before invoking a provider',
    );
    const cancelled = new AbortController();
    cancelled.abort(new Error('cancelled'));
    assert.deepEqual(
      await resolveStartup({}, cancelled, new Map(), 'cancelled-start', orionMcps.resolveOrionMcpsForRun),
      { ok: true, runId: 'cancelled-start' },
      'cancelled startup keeps its existing terminal result',
    );
    assert.deepEqual(await resolveStartup({ aside: true }, new AbortController(), new Map(), 'aside', orionMcps.resolveOrionMcpsForRun), { servers: [], needsSignIn: [] });
  } finally {
    await fs.writeFile(credentialsPath, startupCredentialsBackup);
  }
  // Exercise the actual startup configuration block with unavailable plugin
  // support and failed registration/configuration, before any prompt is sent.
  const routing = await import('../src/main/thread-reader-routing.js');
  const openCodeCheckStart = runTurnSource.indexOf('    // Check before allocating a bridge or passing credentials to OpenCode.');
  const openCodeCheckEnd = runTurnSource.indexOf('    // spawn_subagent for non-Claude drivers:', openCodeCheckStart);
  assert.ok(openCodeCheckStart >= 0 && openCodeCheckEnd > openCodeCheckStart);
  const checkOpenCodeStartup = new (Object.getPrototypeOf(async function () {}).constructor)(
    'model', 'input', 'orionMcps', 'startupController', 'startingAgentRuns', 'runId', 'assertOpenCodeMcpNamesAvailable',
    runTurnSource.slice(openCodeCheckStart, openCodeCheckEnd) + '\nreturn { proceeded: true };',
  );
  const requestedServers = [{ name: 'conflict' }];
  await assert.rejects(checkOpenCodeStartup(
    { providerId: 'opencode' }, { projectPath: testRoot }, { servers: requestedServers },
    new AbortController(), new Map(), 'collision',
    async (servers, options) => {
      assert.deepEqual(servers, requestedServers);
      assert.equal(options.cwd, testRoot);
      assert.ok(options.signal instanceof AbortSignal);
      throw new Error('OpenCode nicknames conflict');
    },
  ), /OpenCode nicknames conflict/);
  const stoppedCheck = new AbortController();
  assert.deepEqual(await checkOpenCodeStartup(
    { providerId: 'opencode' }, { projectPath: testRoot }, { servers: requestedServers },
    stoppedCheck, new Map(), 'stopped', async () => {
      stoppedCheck.abort(new Error('Stopped during discovery'));
      throw stoppedCheck.signal.reason;
    },
  ), { ok: true, runId: 'stopped' });
  const bridgeStart = runTurnSource.indexOf('    const bridgeProvider = isMcpBridgeProvider(model.providerId);');
  assert.ok(openCodeCheckEnd < bridgeStart, 'collision checks happen before bridge allocation');
  const bridgeEnd = runTurnSource.indexOf("    if (\n      model.providerId === 'codex'", bridgeStart);
  assert.ok(bridgeStart >= 0 && bridgeEnd > bridgeStart);
  const prepareBridge = new (Object.getPrototypeOf(async function () {}).constructor)(
    'model', 'input', 'orionMcps', 'isMcpBridgeProvider', 'providerSupportsRunPlugin',
    'registerMcpBridgeForRun', 'openCodeMcpConfigContent', 'writeMuseMcpConfigRoot',
    'isEffectiveThreadReaderBridgeReady', 'isRequiredThreadReaderBridgeMissing',
    runTurnSource.slice(bridgeStart, bridgeEnd) + '\nreturn { proceeded: true };',
  );
  for (const providerId of ['cursor', 'grok', 'kimi', 'opencode', 'muse', 'codex']) {
    for (const failure of ['unsupported', 'registration', 'config', 'none']) {
      for (const hasServers of [false, true]) {
        let registered = false;
        let released = false;
        const servers = hasServers ? [{ name: 'requested', transport: 'stdio', command: 'test', args: [], env: {} }] : [];
        const result = await prepareBridge(
          { providerId }, { projectPath: testRoot, mcpServerIds: hasServers ? ['attached'] : [] }, { servers },
          routing.isMcpBridgeProvider, async () => failure !== 'unsupported',
          async () => {
            registered = true;
            return failure === 'registration' ? null : { release: () => { released = true; } };
          },
          () => failure === 'config' ? null : '{}', async () => failure === 'config' ? null : '/fixture/config',
          routing.isEffectiveThreadReaderBridgeReady, routing.isRequiredThreadReaderBridgeMissing,
        );
        const mustFail = hasServers && providerId !== 'codex' &&
          (failure === 'unsupported' || failure === 'registration' ||
            (failure === 'config' && ['opencode', 'muse'].includes(providerId)));
        if (mustFail) {
          assert.equal(result.ok, false, `${providerId}: ${failure}`);
          assert.match(result.error, /@requested/);
          if (failure === 'unsupported') assert.equal(registered, false, 'reject before allocating a bridge');
          if (failure === 'config') assert.equal(released, true, 'release a bridge whose provider config failed');
        } else {
          assert.deepEqual(result, { proceeded: true }, `${providerId}: ${failure}, servers=${hasServers}`);
        }
      }
    }
  }
  const resolveIndex = runTurnSource.indexOf('resolveOrionMcpsForRun(input.mcpServerIds, { signal: startupController.signal })');
  assert.ok(resolveIndex >= 0, 'runTurn resolves Orion MCPs');
  assert.ok(
    resolveIndex < runTurnSource.indexOf('runClaudeSdkTurn({'),
    'Orion MCPs resolve before the Claude branch'
  );
  assert.match(
    runTurnSource,
    /orionMcpServers: claudeOrionMcpServers\(\s*await withoutClaudeNativeMcps\(orionMcps\.servers, input\.projectPath\)/
  );
  assert.ok(runTurnSource.indexOf('museOrionMcpServers(orionMcps.servers)') < runTurnSource.indexOf('writeMuseMcpConfigRoot(orionMcp)'));
  assert.match(runTurnSource, /withCodexOrionMcps\(/);
  assert.match(runTurnSource, /await withoutCodexNativeMcps\(orionMcps\.servers,/);
  assert.match(runTurnSource, /userServers: model\.providerId === 'codex' \? \[\] : orionMcps\.servers/);

  console.log('Orion MCP regression checks passed.');
} finally {
  httpServer.close();
  await fs.rm(testRoot, { recursive: true, force: true });
  app.quit();
}
