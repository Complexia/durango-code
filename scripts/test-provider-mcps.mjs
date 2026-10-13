import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

// Discovery of MCP servers connected to Claude Code / Codex directly, sharing
// one into Orion, and the per-run dedupe against the provider's own config.

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-provider-mcps-test-'));
const claudeDir = path.join(testRoot, 'claude');
const projectPath = path.join(testRoot, 'project');
const pluginRoot = path.join(claudeDir, 'plugins', 'cache', 'market', 'stripe', '1.0.0');
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.ORION_MCPS_PATH = path.join(testRoot, 'orion-mcps.json');
process.env.ORION_MCP_CREDENTIALS_PATH = path.join(testRoot, 'orion-mcp-credentials.json');
process.env.ORION_MCP_SETTINGS_PATH = path.join(testRoot, 'mcp-settings.json');
process.env.DURANGO_TOKEN = 'secret-token';
process.env.LINEAR_KEY = 'linear-secret';

// --- A local MCP server standing in for "Durango" -----------------------------------

let seenAuthorization = null;
const httpServer = http.createServer(async (req, res) => {
  if (new URL(req.url, 'http://x').pathname !== '/mcp') return res.writeHead(404).end();
  seenAuthorization = req.headers.authorization ?? null;
  let body = '';
  for await (const chunk of req) body += chunk;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = new McpServer({ name: 'durango', version: '1.0.0' });
  server.registerTool('ping', { description: 'Ping', inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }));
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  return transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
});
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
const durangoUrl = `http://127.0.0.1:${httpServer.address().port}/mcp`;

// --- Provider configs ----------------------------------------------------------------

const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
};

await writeJson(path.join(claudeDir, '.claude.json'), {
  mcpServers: {
    durango: { type: 'http', url: durangoUrl, headers: { Authorization: 'Bearer ${DURANGO_TOKEN}' } },
    railway: { command: 'railway', args: ['mcp'] },
    needsenv: { command: 'thing', env: { KEY: '${ORION_TEST_MISSING_VAR_XYZ}' } },
    legacy: { type: 'sse', url: 'https://legacy.example.com/sse' },
  },
  projects: {
    [projectPath]: { mcpServers: { localonly: { command: 'local-server' } } },
    '/somewhere/else': { mcpServers: { elsewhere: { command: 'elsewhere-server' } } },
  },
});
await writeJson(path.join(projectPath, '.mcp.json'), {
  mcpServers: { projectdb: { command: 'db-mcp', args: ['--url', 'postgres://secret'] } },
});
await writeJson(path.join(projectPath, '.claude', 'settings.local.json'), { enableAllProjectMcpServers: true });
await writeJson(path.join(claudeDir, 'settings.json'), {
  enabledPlugins: { 'stripe@market': true, 'off@market': false },
});
await writeJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'), {
  version: 2,
  plugins: {
    'stripe@market': [{ scope: 'user', installPath: pluginRoot }],
    'off@market': [{ scope: 'user', installPath: path.join(testRoot, 'off') }],
  },
});
await writeJson(path.join(pluginRoot, '.mcp.json'), {
  mcpServers: { stripe: { type: 'http', url: 'https://mcp.stripe.com' } },
});
await writeJson(path.join(testRoot, 'off', '.mcp.json'), { mcpServers: { hidden: { command: 'x' } } });

// A fake `codex` CLI answering `codex mcp list --json`.
const codexList = [
  { name: 'railway', enabled: true, transport: { type: 'stdio', command: 'railway', args: ['mcp'] } },
  {
    name: 'openaiDeveloperDocs',
    enabled: true,
    transport: { type: 'streamable_http', url: 'https://developers.openai.com/mcp' },
  },
  {
    name: 'linear',
    enabled: false,
    transport: {
      type: 'streamable_http',
      url: 'https://mcp.linear.app/mcp',
      bearer_token_env_var: 'LINEAR_KEY',
      http_headers: { 'X-Team': 'core' },
    },
  },
  {
    name: 'blender',
    enabled: true,
    transport: { type: 'stdio', command: 'uvx', args: ['blender-mcp'], env: { PORT: '9876' }, env_vars: ['HOME', 'LINEAR_KEY'], cwd: '/tmp' },
  },
];
const fakeCodex = path.join(testRoot, 'codex');
await fs.writeFile(fakeCodex, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(codexList)}\nJSON\n`, { mode: 0o755 });

const { app } = await import('electron');
// Discovery resolves the executable inside the login shell. Isolate its
// startup files and PATH so this suite never reads the user's Codex config.
process.env.ZDOTDIR = testRoot;
await fs.writeFile(path.join(testRoot, '.zprofile'), `export PATH='${testRoot}':"$PATH"\n`);
process.env.PATH = `${testRoot}${path.delimiter}${process.env.PATH}`;
const { shellQuote } = await import('../src/main/shell-env.js');
const providerMcps = await import('../src/main/provider-mcps.js');
const orionMcps = await import('../src/main/orion-mcps.js');

try {
  // --- Discovery -------------------------------------------------------------------
  const listed = await providerMcps.listProviderMcps({ projectPaths: [projectPath] });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.errors, {});
  const byName = Object.fromEntries(listed.servers.map((entry) => [entry.name, entry]));
  assert.deepEqual(Object.keys(byName).sort(), [
    'blender',
    'durango',
    'elsewhere',
    'legacy',
    'linear',
    'localonly',
    'needsenv',
    'openaiDeveloperDocs',
    'projectdb',
    'railway',
    'stripe',
  ]);
  // The same launch configuration across providers shares one row.
  assert.deepEqual(
    byName.railway.sources.map((source) => `${source.provider}:${source.scope}`),
    ['claude:user', 'codex:config']
  );
  assert.equal(byName.stripe.sources[0].scope, 'plugin');
  assert.equal(byName.stripe.sources[0].plugin, 'stripe');
  assert.equal(byName.localonly.sources[0].projectPath, projectPath);
  assert.equal(byName.projectdb.sources[0].scope, 'project');
  // Nothing secret reaches the renderer: header/env names only, no args with values.
  const serialized = JSON.stringify(listed);
  assert.ok(!serialized.includes('secret'), serialized);
  assert.ok(!serialized.includes('${DURANGO_TOKEN}'));
  assert.deepEqual(byName.durango.headerNames, ['Authorization']);
  assert.equal(byName.projectdb.detail, 'db-mcp');
  assert.equal(byName.railway.detail, 'railway');
  assert.equal(byName.openaiDeveloperDocs.detail, 'developers.openai.com/mcp');
  assert.equal(byName.linear.sources[0].enabled, false);
  assert.match(byName.legacy.shareBlockedReason, /SSE/);
  assert.equal(byName.durango.orion, null);

  for (const args of [
    ['-y', 'example-mcp', '-t', 'private-token'],
    ['-y', 'example-mcp', '--token', 'private-token'],
    ['example-mcp', 'private-token'],
    ['--token=private-token'],
  ]) {
    const row = providerMcps.groupProviderMcps([{
      id: 'private-args', provider: 'claude', scope: 'user', name: 'private',
      transport: 'stdio', command: '/bin/npx', args, env: {}, enabled: true,
    }])[0];
    assert.equal(row.detail, 'npx', 'no native arguments enter public descriptions');
  }

  // Codex redacts helper scripts in CLI output. Even a redacted helper is
  // enough to know we cannot reproduce or deduplicate that connection.
  const helperConfig = [{ name: 'helper-server', enabled: true, transport: {
    type: 'streamable_http', url: durangoUrl, http_headers_helper: '<redacted>',
  } }];
  const helperOptions = { fresh: true, cwd: testRoot, run: async () => ({ stdout: JSON.stringify(helperConfig) }) };
  const helperSources = await providerMcps.readCodexMcpSources(helperOptions);
  assert.equal(helperSources[0].headersHelper, true);
  const helperInput = await providerMcps.orionInputForSource(helperSources[0]);
  assert.equal(helperInput.ok, false);
  assert.match(helperInput.error, /helper script/);
  assert.match(providerMcps.groupProviderMcps(helperSources)[0].shareBlockedReason, /helper script/);
  const helperCandidate = [{ name: 'remote', transport: 'http', url: durangoUrl, headers: {} }];
  assert.deepEqual(await providerMcps.withoutCodexNativeMcps(helperCandidate, helperOptions), helperCandidate);

  // --- Grouping by endpoint when names differ ----------------------------------------
  const grouped = providerMcps.groupProviderMcps(
    [
      { id: 'claude:user::docs', provider: 'claude', name: 'docs', scope: 'user', transport: 'http', url: 'https://developers.openai.com/mcp', args: [], headers: {}, env: {}, enabled: true },
      { id: 'codex:config::openaiDeveloperDocs', provider: 'codex', name: 'openaiDeveloperDocs', scope: 'config', transport: 'http', url: 'https://DEVELOPERS.openai.com/mcp', args: [], headers: {}, env: {}, enabled: true },
    ],
    [{ id: 'o1', nickname: 'openai-developer-docs', transport: 'http', url: 'https://x.example.com', enabled: true }]
  );
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].sources.length, 2);
  assert.equal(grouped[0].orion, null, 'a matching nickname does not establish an equal connection');
  assert.equal(providerMcps.nicknameFromName('openaiDeveloperDocs'), 'openai-developer-docs');

  // Remote scheme, query, path, transport and credentials all affect identity.
  const firstRemote = {
    id: 'remote-first', provider: 'claude', scope: 'user', name: 'remote', transport: 'http',
    url: 'https://mcp.example.test/mcp?project=prod',
    headers: { Authorization: 'Bearer first-secret', 'X-Team': 'core' }, enabled: true,
  };
  for (const patch of [
    { url: 'https://mcp.example.test/mcp?project=stage' },
    { url: 'http://mcp.example.test/mcp?project=prod' },
    { url: 'https://mcp.example.test/mcp/?project=prod' },
    { transport: 'sse' },
    { headers: { Authorization: 'Bearer second-secret', 'X-Team': 'core' } },
    { headers: { Authorization: 'Bearer first-secret', 'X-Team': 'other' } },
  ]) {
    const second = { ...firstRemote, ...patch, id: 'remote-second' };
    assert.equal(providerMcps.groupProviderMcps([firstRemote, second]).length, 2);
    assert.equal(providerMcps.groupProviderMcps([firstRemote], [{ ...second, nickname: 'remote' }])[0].orion, null);
    assert.deepEqual(providerMcps.withoutNativeMcps([second], [firstRemote], 'claude'), [second]);
    const renamed = { ...second, name: 'remote-copy' };
    assert.deepEqual(providerMcps.withoutNativeMcps([renamed], [firstRemote], 'codex'), [renamed]);
  }
  const sameRemote = { ...firstRemote, id: 'same', name: 'remote-copy', headers: { 'x-team': 'core', authorization: 'Bearer first-secret' } };
  assert.equal(providerMcps.groupProviderMcps([firstRemote, sameRemote]).length, 1);
  assert.equal(providerMcps.groupProviderMcps([firstRemote], [{ ...sameRemote, nickname: 'saved' }])[0].orion.nickname, 'saved');
  assert.deepEqual(providerMcps.withoutNativeMcps([sameRemote], [firstRemote], 'claude'), [sameRemote], 'an alias must retain its requested tool name');
  assert.deepEqual(providerMcps.withoutNativeMcps([{ ...sameRemote, name: firstRemote.name }], [firstRemote], 'claude'), []);
  assert.deepEqual(providerMcps.withoutNativeMcps([sameRemote], [{ ...firstRemote, authStatus: 'o_auth' }], 'codex'), [sameRemote]);

  // An equivalent alias must not hide a different server occupying the
  // requested nickname. Codex rejects the collision; Claude receives the
  // requested definition under that name instead of falling back to native.
  const billing = { name: 'billing', transport: 'http', url: 'https://requested.example/mcp', headers: {} };
  const billingAlias = { ...billing, name: 'billing-copy', enabled: true };
  const billingConflict = { ...billing, url: 'https://other-account.example/mcp', enabled: true };
  for (const provider of ['claude', 'codex']) {
    assert.deepEqual(providerMcps.withoutNativeMcps([billing], [billingAlias], provider), [billing]);
    assert.deepEqual(providerMcps.withoutNativeMcps([billing], [{ ...billing, enabled: true }], provider), []);
  }
  assert.throws(() => providerMcps.withoutNativeMcps([billing], [billingConflict, billingAlias], 'codex'), /nicknames conflict.*@billing/);
  const claudeBilling = providerMcps.withoutNativeMcps([billing], [billingConflict, billingAlias], 'claude');
  assert.deepEqual(claudeBilling, [billing]);
  assert.equal(orionMcps.claudeOrionMcpServers(claudeBilling).billing.url, billing.url);

  // --- Distinct local configurations never collapse by name or basename ------------
  const firstLocal = {
    id: 'first', provider: 'claude', scope: 'user', name: 'local', transport: 'stdio',
    command: '/first/bin/node', args: ['server.js'], cwd: '/first/install',
    env: { TARGET: 'first', MODE: 'read' }, headers: {}, enabled: true,
  };
  for (const patch of [
    { command: '/second/bin/node' },
    { cwd: '/second/install' },
    { env: { TARGET: 'second', MODE: 'read' } },
    { args: ['other-server.js'] },
  ]) {
    const secondLocal = { ...firstLocal, ...patch, id: 'second' };
    assert.equal(providerMcps.groupProviderMcps([firstLocal, secondLocal]).length, 2);
    const attached = { ...secondLocal, name: 'attached' };
    for (const provider of ['claude', 'codex']) {
      assert.deepEqual(providerMcps.withoutNativeMcps([attached], [firstLocal], provider), [attached]);
    }
    assert.deepEqual(providerMcps.withoutNativeMcps([secondLocal], [firstLocal], 'claude'), [secondLocal]);
    assert.equal(providerMcps.groupProviderMcps([firstLocal], [{ ...secondLocal, nickname: 'local' }])[0].orion, null);
  }
  // Argument boundaries and sorted environment entries are significant.
  assert.notEqual(
    providerMcps.mcpIdentity({ ...firstLocal, args: ['a b', 'c'] }),
    providerMcps.mcpIdentity({ ...firstLocal, args: ['a', 'b c'] })
  );
  const identicalLocal = { ...firstLocal, id: 'alias', env: { MODE: 'read', TARGET: 'first' } };
  assert.equal(providerMcps.groupProviderMcps([firstLocal, identicalLocal]).length, 1);
  assert.deepEqual(providerMcps.withoutNativeMcps([identicalLocal], [firstLocal], 'claude'), []);
  assert.deepEqual(
    providerMcps.withoutNativeMcps([identicalLocal], [{ ...firstLocal, connection: null }], 'claude'),
    [identicalLocal], 'an unresolved environment must never count as an equivalent native server'
  );
  assert.deepEqual(
    providerMcps.withoutNativeMcps([identicalLocal], [{ ...firstLocal, cwd: null }], 'claude', firstLocal.cwd),
    [], 'an implicit cwd matches the actual run directory'
  );

  // --- Resolving secrets for a share ---------------------------------------------------
  const codexSources = await providerMcps.readCodexMcpSources();
  const linear = await providerMcps.orionInputForSource(codexSources.find((source) => source.name === 'linear'));
  const mixedAuthSource = {
    ...codexSources.find((source) => source.name === 'linear'),
    headers: { authorization: 'Bearer stale-header', 'X-Team': 'core' },
    envHttpHeaders: { AUTHORIZATION: 'DURANGO_TOKEN' },
  };
  assert.deepEqual((await providerMcps.orionInputForSource(mixedAuthSource)).input.headers, {
    'X-Team': 'core', Authorization: 'Bearer linear-secret',
  }, 'a named bearer token replaces differently cased native headers');
  assert.deepEqual(linear, {
    ok: true,
    input: {
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { 'X-Team': 'core', Authorization: 'Bearer linear-secret' },
    },
  });
  const blender = await providerMcps.orionInputForSource(codexSources.find((source) => source.name === 'blender'));
  assert.deepEqual(blender.input, {
    transport: 'stdio',
    command: 'uvx',
    args: ['blender-mcp'],
    env: { PORT: '9876', LINEAR_KEY: 'linear-secret' },
    cwd: '/tmp',
  });
  const claudeSources = await providerMcps.readClaudeCodeMcpSources({ projectPaths: [projectPath] });
  const missing = await providerMcps.orionInputForSource(claudeSources.find((source) => source.name === 'needsenv'));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /\$ORION_TEST_MISSING_VAR_XYZ/);

  // Cancellation must cover discovery, before addOrionMcp starts. Reusing a
  // completed operation id below also proves the cancelled reservation clears.
  const cancelledShare = providerMcps.shareProviderMcp({
    key: byName.durango.key, operationId: 'share-durango', projectPaths: [projectPath],
  });
  const duplicateShare = await providerMcps.shareProviderMcp({
    key: byName.durango.key, operationId: 'share-durango',
  });
  assert.equal(duplicateShare.ok, false);
  orionMcps.cancelOrionMcpSignIn(undefined, 'share-durango');
  const cancelled = await cancelledShare;
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /cancelled/i);
  assert.deepEqual((await orionMcps.listOrionMcps()).servers, []);
  assert.equal(seenAuthorization, null, 'cancelled discovery must not contact the MCP server');

  // --- Share Durango from Claude Code into Orion -------------------------------------
  const shared = await providerMcps.shareProviderMcp({
    key: byName.durango.key, projectPaths: [projectPath], operationId: 'share-durango',
  });
  assert.equal(shared.ok, true, shared.error);
  assert.equal(shared.server.nickname, 'durango');
  assert.equal(shared.server.enabled, true);
  assert.deepEqual(shared.tools, ['ping']);
  assert.equal(seenAuthorization, 'Bearer secret-token');
  const again = await providerMcps.shareProviderMcp({ key: byName.durango.key });
  assert.equal(again.ok, false);
  assert.match(again.error, /Already in Durango Code as @durango/);
  const relisted = await providerMcps.listProviderMcps({ projectPaths: [projectPath], fresh: false });
  assert.equal(relisted.servers.find((entry) => entry.name === 'durango').orion.nickname, 'durango');
  assert.ok(!JSON.stringify(relisted).includes('secret-token'));
  assert.ok(!JSON.stringify(relisted).includes('sharedFrom'));
  assert.ok(!JSON.stringify(relisted).includes('connection'));
  const sharedRegistry = await orionMcps.readOrionMcpRegistry();
  const sharedSource = (await providerMcps.readClaudeCodeMcpSources()).find((source) => source.name === 'durango');
  const shareConnection = (await providerMcps.orionInputForSource(sharedSource)).input;
  assert.equal(providerMcps.groupProviderMcps([{ ...sharedSource, connection: shareConnection }], sharedRegistry)[0].orion.nickname, 'durango', 'share provenance survives without comparing live OAuth tokens');
  assert.equal(providerMcps.groupProviderMcps([{ ...sharedSource, connection: { ...shareConnection, headers: { Authorization: 'Bearer changed-secret' } } }], sharedRegistry)[0].orion, null, 'changed source credentials invalidate share provenance');
  const blocked = await providerMcps.shareProviderMcp({ key: byName.legacy.key });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /SSE/);

  // --- Runs skip what the provider already loads ------------------------------------------
  const resolved = await orionMcps.resolveOrionMcpsForRun([]);
  assert.deepEqual(resolved.servers.map((server) => server.name), ['durango']);
  assert.deepEqual(await providerMcps.withoutClaudeNativeMcps(resolved.servers, projectPath), []);
  // Codex has no Durango, so Codex runs get Orion's copy.
  assert.deepEqual(
    (await providerMcps.withoutCodexNativeMcps(resolved.servers)).map((server) => server.name),
    ['durango']
  );
  const extra = [
    { name: 'railway', transport: 'stdio', command: 'railway', args: ['mcp'], env: {} },
    { name: 'openai-developer-docs', transport: 'http', url: 'https://developers.openai.com/mcp', headers: {} },
    { name: 'linear-copy', transport: 'http', url: 'https://mcp.linear.app/mcp', headers: {} },
  ];
  // Equivalent active connections are reused only under the same name.
  // A differently named copy of a switched-off server can still be loaded.
  assert.deepEqual(
    (await providerMcps.withoutCodexNativeMcps(extra)).map((server) => server.name),
    ['openai-developer-docs', 'linear-copy']
  );
  // Codex merges table fields instead of replacing a server. Conflicts must
  // never reach thread/start, where native headers/env could be sent to the
  // new endpoint/process or a mixed transport could prevent startup.
  for (const collision of [
    { name: 'railway', transport: 'http', url: durangoUrl, headers: {} },
    { name: 'linear', transport: 'http', url: durangoUrl, headers: {} },
    { name: 'blender', transport: 'stdio', command: 'different-server', args: [], env: {} },
  ]) {
    await assert.rejects(providerMcps.withoutCodexNativeMcps([collision]), /nicknames conflict/);
  }
  // Opaque OAuth accounts must not be guessed equivalent by endpoint/name.
  assert.throws(() => providerMcps.withoutNativeMcps(
    [{ name: 'oauth', transport: 'http', url: durangoUrl, headers: {} }],
    [{ name: 'oauth', transport: 'http', url: durangoUrl, enabled: true, authStatus: 'oauth' }],
    'codex',
  ), /nicknames conflict/);
  // A name added after discovery must not slip through the one-minute cache.
  const originalCodexScript = await fs.readFile(fakeCodex, 'utf8');
  try {
    const newSource = { name: 'new-server', enabled: false, transport: {
      type: 'streamable_http', url: 'http://127.0.0.1:9/original', http_headers: { Authorization: 'Bearer dummy-native-secret' },
    } };
    await fs.writeFile(fakeCodex, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify([...codexList, newSource])}\nJSON\n`);
    const requested = [{ name: 'new-server', transport: 'http', url: durangoUrl, headers: {} }];
    await assert.rejects(providerMcps.withoutCodexNativeMcps(requested, { fresh: false }), /@new-server/);
    await fs.writeFile(fakeCodex, '#!/bin/sh\nexit 1\n');
    await assert.rejects(providerMcps.withoutCodexNativeMcps(requested), /Could not check Durango Code MCP nicknames/);
    assert.deepEqual(await providerMcps.withoutCodexNativeMcps([]), [], 'no Orion servers requires no discovery');
  } finally {
    await fs.writeFile(fakeCodex, originalCodexScript);
    await providerMcps.readCodexMcpSources({ fresh: true });
  }
  // Finder does not inherit CODEX_HOME set in .zprofile. Both the direct
  // and shared-server startup contexts must see that native configuration.
  if (process.platform === 'darwin') {
    const shellRoot = path.join(testRoot, "codex shell's profile");
    const nativeHome = path.join(shellRoot, 'native');
    const shellBin = path.join(shellRoot, 'bin');
    await fs.mkdir(nativeHome, { recursive: true });
    await fs.mkdir(shellBin);
    const native = [{ name: 'shell-only', enabled: true, transport: {
      type: 'streamable_http', url: 'http://127.0.0.1:9/native',
      http_headers: { Authorization: 'Bearer shell-only-secret' },
    } }];
    await writeJson(path.join(nativeHome, 'servers.json'), native);
    await fs.writeFile(path.join(shellRoot, '.zprofile'), [
      `export CODEX_HOME=${shellQuote(nativeHome)}`,
      `export PATH=${shellQuote(shellBin)}:"$PATH"`,
      'export ORION_TEST_STARTUP_CWD="$(pwd -P)"',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(shellBin, 'codex'), [
      '#!/bin/sh',
      '[ "$ORION_TEST_STARTUP_CWD" = "$ORION_TEST_EXPECTED_STARTUP_CWD" ] || exit 2',
      `[ "$(pwd -P)" = ${shellQuote(await fs.realpath(projectPath))} ] || exit 3`,
      '[ -z "$ELECTRON_RUN_AS_NODE" ] || exit 4',
      '[ "$1" = mcp ] && [ "$2" = list ] && [ "$3" = --json ] || exit 5',
      'cat "$CODEX_HOME/servers.json"',
      '',
    ].join('\n'), { mode: 0o755 });
    const requested = [{ name: 'shell-only', transport: 'http', url: durangoUrl, headers: {} }];
    for (const shellCwd of [projectPath, testRoot]) {
      const options = {
        cwd: projectPath, shellCwd, shell: '/bin/zsh',
        env: { ZDOTDIR: shellRoot, CODEX_HOME: testRoot, ELECTRON_RUN_AS_NODE: '1',
          ORION_TEST_EXPECTED_STARTUP_CWD: await fs.realpath(shellCwd) },
      };
      await assert.rejects(providerMcps.withoutCodexNativeMcps(requested, options), /nicknames conflict.*@shell-only/);
      const renamed = [{ ...requested[0], name: 'distinct' }];
      assert.deepEqual(await providerMcps.withoutCodexNativeMcps(renamed, options), renamed);
    }
  }

  // Native credentials must be read from the same launch environment as the
  // provider, including shell overrides/unsets and shared vs direct cwd.
  if (process.platform === 'darwin') {
    const profileRoot = path.join(testRoot, 'credential profile');
    await fs.mkdir(profileRoot);
    await fs.writeFile(path.join(profileRoot, '.zprofile'), [
      'export ORION_ENV_TOKEN="profile:$PWD"',
      'export ORION_ENV_HEADER="profile-header"',
      'export ORION_ENV_EMPTY=""',
      "export ORION_ENV_MULTILINE='first line",
      "second=line'",
      'unset ORION_ENV_UNSET',
      'ORION_ENV_LOCAL="not-exported"',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(profileRoot, '.zshrc'), 'export ORION_ENV_TOKEN="interactive-wrong-account"\n');
    const envCodex = path.join(profileRoot, 'codex');
    const envConfig = [
      { name: 'env-account', enabled: true, transport: {
        type: 'streamable_http', url: durangoUrl, bearer_token_env_var: 'ORION_ENV_TOKEN',
        env_http_headers: { 'X-Profile': 'ORION_ENV_HEADER' },
      } },
      { name: 'env-unset', enabled: true, transport: {
        type: 'streamable_http', url: durangoUrl, bearer_token_env_var: 'ORION_ENV_UNSET',
      } },
      { name: 'env-local', enabled: true, transport: {
        type: 'stdio', command: 'fixture-command', env_vars: ['ORION_ENV_EMPTY', 'ORION_ENV_MULTILINE', 'ORION_ENV_UNSET', 'ORION_ENV_LOCAL'],
      } },
    ];
    await fs.writeFile(envCodex, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(envConfig)}\nJSON\n`, { mode: 0o755 });
    for (const shellCwd of [testRoot, projectPath]) {
      const options = {
        cwd: projectPath, shellCwd, shell: '/bin/zsh', codexPath: envCodex, fresh: true,
        env: { ZDOTDIR: profileRoot, ORION_ENV_TOKEN: 'inherited-wrong-account',
          ORION_ENV_HEADER: 'inherited-header', ORION_ENV_UNSET: 'inherited-unset', ELECTRON_RUN_AS_NODE: '1' },
      };
      const sources = await providerMcps.readCodexMcpSources(options);
      const resolved = await providerMcps.orionInputForSource(sources[0], options);
      const headers = { Authorization: `Bearer profile:${await fs.realpath(shellCwd)}`, 'X-Profile': 'profile-header' };
      assert.deepEqual(resolved.input.headers, headers, 'use login-shell exports, not inherited or interactive values');
      const matching = [{ name: 'env-account', ...resolved.input }];
      assert.deepEqual(await providerMcps.withoutCodexNativeMcps(matching, options), []);
      const wrongAccount = [{ ...matching[0], headers: { Authorization: 'Bearer inherited-wrong-account', 'X-Profile': 'inherited-header' } }];
      await assert.rejects(providerMcps.withoutCodexNativeMcps(wrongAccount, options), /nicknames conflict.*@env-account/);
      const unset = await providerMcps.orionInputForSource(sources[1], options);
      assert.equal(unset.ok, false, 'an explicitly unset token cannot fall back to the inherited value');
      assert.match(unset.error, /ORION_ENV_UNSET/);
      await assert.rejects(providerMcps.withoutCodexNativeMcps([
        { name: 'env-unset', transport: 'http', url: durangoUrl, headers: { Authorization: 'Bearer inherited-unset' } },
      ], options), /nicknames conflict.*@env-unset/);
      const local = await providerMcps.orionInputForSource(sources[2], options);
      assert.deepEqual(local.input.env, { ORION_ENV_EMPTY: '', ORION_ENV_MULTILINE: 'first line\nsecond=line' }, 'only exported values reach the provider');

      // Claude bypasses shell startup entirely, including .zprofile overrides.
      const claudeInput = await providerMcps.orionInputForSource({
        provider: 'claude', transport: 'http', url: durangoUrl,
        headers: { Authorization: 'Bearer ${ORION_ENV_TOKEN}' }, args: [], env: {},
      }, options);
      assert.equal(claudeInput.input.headers.Authorization, 'Bearer inherited-wrong-account');
    }
    const failureShell = path.join(profileRoot, 'failed-shell');
    await fs.writeFile(failureShell, '#!/bin/sh\necho fixture-private-token >&2\nexit 1\n', { mode: 0o755 });
    const failureSource = (await providerMcps.readCodexMcpSources({ codexPath: envCodex, fresh: true }))[0];
    await assert.rejects(providerMcps.orionInputForSource(failureSource, { shell: failureShell }),
      (error) => /Could not read the Codex launch environment/.test(error.message) && !String(error).includes('fixture-private-token') && !error.cause);
    await assert.rejects(providerMcps.withoutCodexNativeMcps([
      { name: 'env-account', transport: 'http', url: durangoUrl, headers: { Authorization: 'Bearer inherited-wrong-account' } },
    ], { shell: failureShell, run: async () => ({ stdout: JSON.stringify(envConfig) }), fresh: true }), /nicknames conflict/);

    // Default discovery/sharing also uses the home login-shell context, and
    // stores the resolved credentials that the local MCP actually received.
    await fs.appendFile(path.join(profileRoot, '.zprofile'), `export PATH=${shellQuote(profileRoot)}:"$PATH"\n`);
    const previousEnv = Object.fromEntries(['ZDOTDIR', 'ORION_ENV_TOKEN'].map((name) => [name, process.env[name]]));
    let sharedId;
    try {
      process.env.ZDOTDIR = profileRoot;
      process.env.ORION_ENV_TOKEN = 'inherited-wrong-account';
      const result = await providerMcps.shareProviderMcp({ key: 'codex:config::env-account' });
      assert.equal(result.ok, true, result.error);
      sharedId = result.server.id;
      const expectedAuthorization = `Bearer profile:${await fs.realpath(os.homedir())}`;
      assert.equal(seenAuthorization, expectedAuthorization);
      const saved = (await orionMcps.resolveOrionMcpsForRun([])).servers.find((entry) => entry.name === result.server.nickname);
      assert.equal(saved.headers.Authorization, expectedAuthorization);
      assert.equal(saved.headers['X-Profile'], 'profile-header');
      assert.equal(JSON.stringify(result).includes('profile:'), false, 'resolved credentials stay out of IPC');
    } finally {
      if (sharedId) await orionMcps.removeOrionMcp({ id: sharedId });
      for (const [name, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await providerMcps.readCodexMcpSources({ fresh: true });
    }
  }

  // Claude: railway's user configuration is an exact match.
  assert.deepEqual(
    (await providerMcps.withoutClaudeNativeMcps(extra, projectPath)).map((server) => server.name),
    ['openai-developer-docs', 'linear-copy']
  );

  // OpenCode's resolved config covers every native layer, not just inline
  // JSON. Reject collisions before any Orion credentials can be merged.
  const openCodeServer = { name: 'demo', transport: 'http', url: durangoUrl, headers: {} };
  const openCodeOptions = { openCodePath: '/fixture/opencode', shell: '/fixture/login-shell', cwd: projectPath };
  for (const native of [
    { type: 'remote', url: 'https://native.example/mcp', headers: { Authorization: 'Bearer native-secret' } },
    { type: 'remote', url: 'https://native.example/mcp', enabled: false, headers: { Authorization: 'Bearer native-secret' } },
    { type: 'local', command: ['native-server'], environment: { API_KEY: 'native-secret' } },
    { enabled: false },
  ]) {
    await assert.rejects(providerMcps.assertOpenCodeMcpNamesAvailable([openCodeServer], {
      ...openCodeOptions,
      run: async (command, args, options) => {
        assert.equal(command, openCodeOptions.shell);
        assert.deepEqual(args, ['-lc', "'/fixture/opencode' 'debug' 'config'"]);
        assert.equal(options.cwd, projectPath);
        return { stdout: JSON.stringify({ mcp: { demo: native } }) };
      },
    }), /nicknames conflict.*@demo/);
  }
  for (const config of [{}, { mcp: { unrelated: { enabled: false } } }]) {
    await providerMcps.assertOpenCodeMcpNamesAvailable([openCodeServer], {
      ...openCodeOptions, run: async () => ({ stdout: JSON.stringify(config) }),
    });
  }
  for (const extraArgs of ['--dir ../other --pure', '--dir=../other --pure']) {
    await providerMcps.assertOpenCodeMcpNamesAvailable([openCodeServer], {
      ...openCodeOptions, providerOptions: { extraArgs },
      run: async (_command, args, options) => {
        assert.equal(options.cwd, projectPath, 'login startup uses the original workspace');
        assert.deepEqual(args, ['-lc', "cd -- '../other' && '/fixture/opencode' 'debug' 'config' '--pure'"]);
        return { stdout: '{}' };
      },
    });
  }
  await assert.rejects(providerMcps.assertOpenCodeMcpNamesAvailable([openCodeServer], {
    ...openCodeOptions, providerOptions: { extraArgs: '--attach=http://localhost:4096' },
    run: async () => { assert.fail('A remote runtime cannot be checked with local config'); },
  }), /cannot be loaded with OpenCode --attach/);
  for (const stdout of ['', 'not JSON', '[]', '{"mcp":null}', '{"mcp":[]}']) {
    await assert.rejects(providerMcps.assertOpenCodeMcpNamesAvailable([openCodeServer], {
      ...openCodeOptions, run: async () => ({ stdout }),
    }), /Could not check Durango Code MCP nicknames/);
  }
  await assert.rejects(providerMcps.assertOpenCodeMcpNamesAvailable([openCodeServer], {
    ...openCodeOptions, run: async () => { throw new Error('native-secret'); },
  }), (error) => /Could not check/.test(error.message) && !String(error).includes('native-secret') && !error.cause);
  const cancelledCheck = new AbortController();
  cancelledCheck.abort(new Error('Stopped before discovery'));
  await assert.rejects(providerMcps.assertOpenCodeMcpNamesAvailable([openCodeServer], {
    ...openCodeOptions, signal: cancelledCheck.signal,
    run: async () => { assert.fail('Cancelled startup must not discover config'); },
  }), /Stopped before discovery/);
  await providerMcps.assertOpenCodeMcpNamesAvailable([], {
    run: async () => { assert.fail('No Orion MCPs needs no discovery'); },
  });

  // A real login shell must choose the same CLI and config as runTurn.
  // Keep shell files isolated; never read or modify the user's profile.
  if (process.platform === 'darwin') {
    const profileRoot = path.join(testRoot, 'login profile');
    const shellBin = path.join(profileRoot, 'bin');
    const shellConfig = path.join(profileRoot, 'native.json');
    await fs.mkdir(shellBin, { recursive: true });
    await writeJson(shellConfig, { mcp: { demo: {
      type: 'remote', url: 'https://native.example/mcp', headers: { Authorization: 'Bearer shell-only-secret' },
    } } });
    await fs.writeFile(path.join(profileRoot, '.zprofile'), [
      `export PATH=${shellQuote(shellBin)}:"$PATH"`,
      `export OPENCODE_CONFIG=${shellQuote(shellConfig)}`,
      'export ORION_TEST_STARTUP_CWD="$(pwd -P)"',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(shellBin, 'opencode'), [
      '#!/bin/sh',
      `[ "$ORION_TEST_STARTUP_CWD" = ${shellQuote(await fs.realpath(projectPath))} ] || exit 2`,
      '[ "$1" = debug ] && [ "$2" = config ] || exit 3',
      'cat "$OPENCODE_CONFIG"',
      '',
    ].join('\n'), { mode: 0o755 });
    const shellOptions = {
      shell: '/bin/zsh', cwd: projectPath,
      env: { ZDOTDIR: profileRoot, OPENCODE_CONFIG: '' },
    };
    await assert.rejects(providerMcps.assertOpenCodeMcpNamesAvailable([openCodeServer], shellOptions), /nicknames conflict.*@demo/);
    // Shell startup must happen in the original workspace even with --dir.
    const otherDir = path.join(projectPath, "other's folder");
    await fs.mkdir(otherDir);
    await assert.rejects(providerMcps.assertOpenCodeMcpNamesAvailable([openCodeServer], {
      ...shellOptions, providerOptions: { extraArgs: `--dir "${path.basename(otherDir)}"` },
    }), /nicknames conflict.*@demo/);
    await providerMcps.assertOpenCodeMcpNamesAvailable([{ ...openCodeServer, name: 'separate' }], shellOptions);
  }

  // Native env_vars must be resolved before comparing the copied connection.
  const blenderCopy = { name: 'blender-copy', ...blender.input };
  assert.deepEqual(await providerMcps.withoutCodexNativeMcps([blenderCopy]), [blenderCopy]);
  assert.deepEqual(await providerMcps.withoutCodexNativeMcps([{ ...blenderCopy, name: 'blender' }]), []);
  const otherBlender = { ...blenderCopy, env: { ...blenderCopy.env, LINEAR_KEY: 'another-secret' } };
  assert.deepEqual(await providerMcps.withoutCodexNativeMcps([otherBlender]), [otherBlender]);

  // Discovery can recognize a shared local server using its saved environment,
  // while all secret values and comparison data remain outside the renderer.
  const registry = await orionMcps.readOrionMcpRegistry();
  await writeJson(process.env.ORION_MCPS_PATH, {
    version: 1, servers: [...registry, {
      id: 'saved-blender', nickname: 'blender-copy', enabled: true, transport: 'stdio',
      command: blender.input.command, args: blender.input.args, cwd: blender.input.cwd, auth: 'none',
    }],
  });
  const savedCredentials = JSON.parse(await fs.readFile(process.env.ORION_MCP_CREDENTIALS_PATH, 'utf8'));
  const credentials = JSON.parse(savedCredentials.value);
  credentials['saved-blender'] = { env: blender.input.env };
  await writeJson(process.env.ORION_MCP_CREDENTIALS_PATH, { ...savedCredentials, value: JSON.stringify(credentials) });
  const localSharedList = await providerMcps.listProviderMcps({ projectPaths: [projectPath], fresh: false });
  assert.equal(localSharedList.servers.find((entry) => entry.name === 'blender').orion.nickname, 'blender-copy');
  assert.ok(!JSON.stringify(localSharedList).includes('linear-secret'));
  assert.ok(!JSON.stringify(localSharedList).includes('connection'));

  // Native disables are per project, including those of user-scope servers.
  // Explicit Orion attachments must survive when the native copy won't load.
  const claudeGlobalPath = path.join(claudeDir, '.claude.json');
  const claudeGlobal = JSON.parse(await fs.readFile(claudeGlobalPath, 'utf8'));
  claudeGlobal.projects[projectPath].disabledMcpServers = ['railway', 'localonly', 'plugin:stripe:stripe'];
  await writeJson(claudeGlobalPath, claudeGlobal);
  const railwayCopy = { ...extra[0] };
  const localCopy = { name: 'localonly', transport: 'stdio', command: 'local-server', args: [], env: {}, cwd: projectPath };
  const pluginCopy = { name: 'plugin:stripe:stripe', transport: 'http', url: 'https://mcp.stripe.com', headers: {} };
  assert.deepEqual(await providerMcps.withoutClaudeNativeMcps([railwayCopy, localCopy, pluginCopy], projectPath), [railwayCopy, localCopy, pluginCopy]);
  assert.deepEqual(await providerMcps.withoutClaudeNativeMcps([railwayCopy], '/somewhere/else'), [], 'one project must not disable a native server in another');
  assert.deepEqual(await providerMcps.withoutClaudeNativeMcps([pluginCopy], '/somewhere/else'), [], 'plugin disables also apply only to their project');
  const pluginAlias = { ...pluginCopy, name: 'stripe' };
  assert.deepEqual(await providerMcps.withoutClaudeNativeMcps([pluginAlias], '/somewhere/else'), [pluginAlias], 'plugin-qualified tools do not satisfy an unqualified nickname');
  const projectCopy = { name: 'projectdb', transport: 'stdio', command: 'db-mcp', args: ['--url', 'postgres://secret'], env: {}, cwd: projectPath };
  for (const settingsPath of [
    path.join(claudeDir, 'settings.json'),
    path.join(projectPath, '.claude', 'settings.json'),
    path.join(projectPath, '.claude', 'settings.local.json'),
  ]) {
    const original = await fs.readFile(settingsPath, 'utf8').catch(() => null);
    try {
      await writeJson(settingsPath, { ...(original ? JSON.parse(original) : {}), disabledMcpjsonServers: ['projectdb'] });
      assert.deepEqual(await providerMcps.withoutClaudeNativeMcps([projectCopy], projectPath), [projectCopy], settingsPath);
      const discovered = await providerMcps.readClaudeCodeMcpSources({ projectPaths: [projectPath] });
      assert.equal(discovered.find((source) => source.name === 'projectdb').enabled, false);
    } finally {
      if (original !== null) await fs.writeFile(settingsPath, original);
      else await fs.rm(settingsPath, { force: true });
    }
  }
  assert.deepEqual(await providerMcps.withoutClaudeNativeMcps([projectCopy], projectPath), [], 'enabled project servers still deduplicate');

  // Sharing a native server with Orion's browser name chooses a safe nickname.
  claudeGlobal.mcpServers.chrome_devtools = { type: 'http', url: durangoUrl, headers: { 'X-Server': 'browser-name-test' } };
  await writeJson(claudeGlobalPath, claudeGlobal);
  const browserShare = await providerMcps.shareProviderMcp({ key: 'claude:user::chrome_devtools' });
  assert.equal(browserShare.ok, true, browserShare.error);
  assert.equal(browserShare.server.nickname, 'chrome_devtools-2');
  const { codexAppServerConfig } = await import('../src/main/codex-driver.js');
  const browserConfig = codexAppServerConfig({ providerId: 'codex', slug: 'gpt-6-luna' }, {
    accessMode: 'full-access', providerOptions: { browserUseMode: 'extension' },
    mcpRuntimeConfig: orionMcps.withCodexOrionMcps({}, (await orionMcps.resolveOrionMcpsForRun([])).servers),
  });
  assert.equal(browserConfig.mcp_servers.chrome_devtools.url, undefined);
  assert.equal(browserConfig.mcp_servers['chrome_devtools-2'].url, durangoUrl);
  assert.equal(browserConfig.mcp_servers['chrome_devtools-2'].command, undefined);

  // Compare only Claude's winning definition: local > project > user.
  delete claudeGlobal.projects[projectPath].disabledMcpServers;
  claudeGlobal.mcpServers.shadow = { command: '/test/user-server' };
  claudeGlobal.projects[projectPath].mcpServers.shadow = { command: '/test/local-server' };
  await writeJson(claudeGlobalPath, claudeGlobal);
  const projectConfigPath = path.join(projectPath, '.mcp.json');
  const projectConfig = JSON.parse(await fs.readFile(projectConfigPath, 'utf8'));
  projectConfig.mcpServers.shadow = { command: '/test/project-server' };
  await writeJson(projectConfigPath, projectConfig);
  const copies = ['user', 'project', 'local'].map((scope) => ({
    name: 'shadow', transport: 'stdio', command: `/test/${scope}-server`, args: [], env: {},
    ...(scope === 'user' ? {} : { cwd: projectPath }),
  }));
  assert.deepEqual(await providerMcps.withoutClaudeNativeMcps(copies, projectPath), copies.slice(0, 2));
  delete claudeGlobal.projects[projectPath].mcpServers.shadow;
  await writeJson(claudeGlobalPath, claudeGlobal);
  assert.deepEqual(await providerMcps.withoutClaudeNativeMcps(copies, projectPath), [copies[0], copies[2]]);
  await writeJson(path.join(projectPath, '.claude', 'settings.local.json'), { disabledMcpjsonServers: ['shadow'] });
  assert.deepEqual(await providerMcps.withoutClaudeNativeMcps(copies, projectPath), copies.slice(1), 'excluded project definitions leave the user definition active');
  await writeJson(path.join(projectPath, '.claude', 'settings.local.json'), {});
  assert.deepEqual(await providerMcps.withoutClaudeNativeMcps(copies, projectPath), copies.slice(1), 'unapproved project definitions also leave user scope active');
  await writeJson(path.join(projectPath, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['shadow'] });
  assert.deepEqual(await providerMcps.withoutClaudeNativeMcps(copies, projectPath), [copies[0], copies[2]], 'named approval enables the project override');

  // Project plugin flags override user settings, and local flags override
  // project flags. Only the applicable installation may suppress a copy.
  await writeJson(path.join(projectPath, '.claude', 'settings.json'), { enabledPlugins: { 'stripe@market': false, 'off@market': true } });
  assert.deepEqual(await providerMcps.withoutClaudeNativeMcps([pluginCopy], projectPath), [pluginCopy]);
  const projectPlugins = await providerMcps.readClaudeCodeMcpSources({ projectPaths: [projectPath] });
  assert.ok(projectPlugins.some((source) => source.plugin === 'off' && source.projectPath === projectPath));
  await writeJson(path.join(projectPath, '.claude', 'settings.local.json'), { enabledPlugins: { 'stripe@market': true } });
  assert.deepEqual(await providerMcps.withoutClaudeNativeMcps([pluginCopy], projectPath), []);
  await writeJson(path.join(projectPath, '.claude', 'settings.local.json'), { enabledPlugins: { 'stripe@market': false } });
  assert.deepEqual(await providerMcps.withoutClaudeNativeMcps([pluginCopy], projectPath), [pluginCopy]);
  assert.deepEqual(await providerMcps.withoutClaudeNativeMcps([pluginCopy], '/somewhere/else'), []);

  const installations = ['other', 'user', 'project'].map((scope) => ({
    scope: scope === 'user' ? 'user' : 'project',
    ...(scope === 'user' ? {} : { projectPath: scope === 'project' ? projectPath : '/another/project' }),
    installPath: path.join(testRoot, `scoped-${scope}`),
  }));
  for (const [index, entry] of installations.entries()) {
    await writeJson(path.join(entry.installPath, '.mcp.json'), { mcpServers: { scoped: { command: `/test/plugin-${index}` } } });
  }
  const installedPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
  const installed = JSON.parse(await fs.readFile(installedPath, 'utf8'));
  installed.plugins['scoped@market'] = installations;
  await writeJson(installedPath, installed);
  const settingsPath = path.join(claudeDir, 'settings.json');
  const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  settings.enabledPlugins['scoped@market'] = true;
  await writeJson(settingsPath, settings);
  assert.equal((await providerMcps.claudeNativeMcpSources(projectPath)).find((source) => source.plugin === 'scoped').command, '/test/plugin-2');
  assert.equal((await providerMcps.claudeNativeMcpSources('/unrelated')).find((source) => source.plugin === 'scoped').command, '/test/plugin-1');

  // Sharing expands Claude variables in main, but never persists those
  // resolved argument values in the public registry or returns them over IPC.
  const sdkRoot = fileURLToPath(new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/server/', import.meta.url));
  const privateScript = path.join(testRoot, 'private-args.mjs');
  await fs.writeFile(privateScript, `
import { McpServer } from ${JSON.stringify(path.join(sdkRoot, 'mcp.js'))};
import { StdioServerTransport } from ${JSON.stringify(path.join(sdkRoot, 'stdio.js'))};
if (process.argv[2] !== '--token' || process.argv[3] !== 'secret-token') throw new Error('Missing argument');
const server = new McpServer({ name: 'private', version: '1.0.0' });
server.registerTool('ping', {}, async () => ({ content: [] }));
await server.connect(new StdioServerTransport());
`);
  claudeGlobal.mcpServers.privateargs = {
    command: process.execPath, args: [privateScript, '--token', '${DURANGO_TOKEN}'], env: { ELECTRON_RUN_AS_NODE: '1' },
  };
  await writeJson(claudeGlobalPath, claudeGlobal);
  const privateSource = (await providerMcps.listProviderMcps()).servers.find((server) => server.name === 'privateargs');
  const privateShared = await providerMcps.shareProviderMcp({ key: privateSource.key });
  assert.equal(privateShared.ok, true, privateShared.error);
  assert.equal(JSON.stringify(privateShared).includes('secret-token'), false);
  assert.equal(JSON.stringify(await orionMcps.listOrionMcps()).includes('secret-token'), false);
  assert.equal((await fs.readFile(process.env.ORION_MCPS_PATH, 'utf8')).includes('secret-token'), false);
  const privateRun = (await orionMcps.resolveOrionMcpsForRun([])).servers.filter((server) => server.name === 'privateargs');
  assert.deepEqual(privateRun[0].args, [privateScript, '--token', 'secret-token']);
  assert.deepEqual(await providerMcps.withoutClaudeNativeMcps(privateRun, projectPath), [], 'private arguments still establish native identity');
  assert.equal((await orionMcps.reconnectOrionMcp({ id: privateShared.server.id })).ok, true);

  // Share through the real discovery/probe/persistence path. Native OAuth
  // identity is opaque and disabled servers cannot be reused. Active shares
  // also need an independent name so a later native toggle cannot break runs.
  const beforeShareCodexScript = await fs.readFile(fakeCodex, 'utf8');
  const sharedIds = [];
  const shareFixtures = [
    { name: 'native-disabled', enabled: false },
    { name: 'native-oauth', enabled: true, auth_status: 'o_auth' },
    { name: 'native-active', enabled: true },
  ].map((entry) => ({ ...entry, transport: {
    type: 'streamable_http', url: `${durangoUrl}?fixture=${entry.name}`,
  } }));
  const suffixConflicts = shareFixtures.map((entry) => ({
    name: `${entry.name}-2`, enabled: false,
    transport: { type: 'streamable_http', url: `${durangoUrl}?occupied=${entry.name}` },
  }));
  try {
    // Warm the old list, then change the config. Sharing must re-read names.
    await providerMcps.readCodexMcpSources({ fresh: true });
    let nativeConfig = [...codexList, ...shareFixtures, ...suffixConflicts];
    await fs.writeFile(fakeCodex, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(nativeConfig)}\nJSON\n`);
    for (const fixture of shareFixtures) {
      const result = await providerMcps.shareProviderMcp({ key: `codex:config::${fixture.name}` });
      assert.equal(result.ok, true, result.error);
      sharedIds.push(result.server.id);
      assert.equal(result.server.nickname, `${fixture.name}-3`, 'skip both original and occupied suffix names');
      assert.equal(result.server.enabled, true);
      const requested = (await orionMcps.resolveOrionMcpsForRun([])).servers
        .filter((entry) => entry.name === result.server.nickname);
      assert.equal(requested.length, 1);
      assert.deepEqual(await providerMcps.withoutCodexNativeMcps(requested), requested, 'a completed share must be runnable in Codex');
      if (fixture.name === 'native-active') {
        nativeConfig = nativeConfig.map((entry) => entry.name === fixture.name ? { ...entry, enabled: false } : entry);
        await fs.writeFile(fakeCodex, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(nativeConfig)}\nJSON\n`);
        assert.deepEqual(await providerMcps.withoutCodexNativeMcps(requested), requested, 'turning off the native copy keeps the Orion share usable');
      }
    }
  } finally {
    for (const id of sharedIds) await orionMcps.removeOrionMcp({ id });
    await fs.writeFile(fakeCodex, beforeShareCodexScript);
    await providerMcps.readCodexMcpSources({ fresh: true });
  }

  console.log('provider MCP tests passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  httpServer.close();
  await fs.rm(testRoot, { recursive: true, force: true });
  app.exit(process.exitCode ?? 0);
}
