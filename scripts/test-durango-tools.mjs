// Durango key + client (src/main/durango-client.js), the Durango Chat agent
// tools (src/main/durango-tools.js) and their wiring into Durango Code's
// built-in `orion` MCP server: the in-process Claude server, the bridge shim
// (src/mcp-bridge-shim.cjs) and its socket handler (src/main/mcp-bridge.js).
//
//   node scripts/run-electron-test.mjs scripts/test-durango-tools.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { z } from 'zod';

import {
  DurangoError,
  createDurangoClient,
  createDurangoCredentials,
  createMockDurangoClient,
  resolveDurangoBaseUrl,
} from '../src/main/durango-client.js';
import {
  DURANGO_TOOL_DESCRIPTIONS,
  DURANGO_TOOL_INPUT_SCHEMAS,
  DURANGO_TOOL_NAMES,
  PROFILE_MEMORY_MAX_CHARS,
  buildDurangoMemoryBlock,
  createProfileMemoryCache,
  runDurangoTool,
  setDurangoToolsClient,
} from '../src/main/durango-tools.js';
import {
  ORION_BUILTIN_TOOL_NAMES,
  isPreapprovedOrionTool,
  isRequiredThreadReaderBridgeMissing,
} from '../src/main/thread-reader-routing.js';
import { createOrionMcpServer } from '../src/main/claude-driver.js';
import { handleMcpBridgeConnection, mcpBridgeSessions } from '../src/main/mcp-bridge.js';
import shimSource from '../src/mcp-bridge-shim.cjs?raw';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-durango-tools-'));
const session = { token: 'desktop-session', user: { id: 'user_1' }, expiresAt: '2099-01-01T00:00:00Z' };
const json = (body, init) => Response.json(body, init);

// A fake Durango Code web (key mint/revoke) + Durango /api/v1, routed by URL.
const fixture = ({ mintResponses = [], apiResponses = [] } = {}) => {
  const state = { session, stored: null, requests: [], mints: 0, revokes: [] };
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(String(url));
    state.requests.push({ url: target.toString(), method: init.method, auth: init.headers?.authorization, body: init.body });
    if (target.pathname === '/api/desktop-auth/durango-key') {
      if (init.method === 'DELETE') {
        state.revokes.push(JSON.parse(init.body).keyId);
        return json({ ok: true });
      }
      state.mints += 1;
      const next = mintResponses.shift();
      if (next) return typeof next === 'function' ? next() : next;
      return json({ key: `dgo_key${state.mints}`, keyId: `key_${state.mints}`, durangoBaseUrl: 'https://durango.example' }, { status: 201 });
    }
    const next = apiResponses.shift();
    if (!next) throw new Error(`unexpected request ${target}`);
    return typeof next === 'function' ? next(target, init) : next;
  };
  const credentials = createDurangoCredentials({
    readSession: async () => state.session,
    readStored: async () => state.stored,
    writeStored: async (value) => { state.stored = value; },
    removeStored: async () => { state.stored = null; },
    webOrigin: () => 'https://code.example',
    deviceName: 'test-mac',
    getDeviceId: async () => 'device-1',
    durangoUrlOverride: () => undefined,
    isPackaged: () => true,
    fetchImpl,
  });
  const client = createDurangoClient({ credentials, readSession: async () => state.session, fetchImpl, isPackaged: () => true, durangoUrlOverride: () => undefined });
  return { state, credentials, client };
};

try {
  // --- Base URL resolution ---------------------------------------------------------
  assert.equal(resolveDurangoBaseUrl({ override: 'http://localhost:3100/', advertised: 'https://durango.sh', isPackaged: false }), 'http://localhost:3100');
  assert.equal(resolveDurangoBaseUrl({ override: undefined, advertised: 'https://durango.sh/x', isPackaged: true }), 'https://durango.sh');
  assert.equal(resolveDurangoBaseUrl({ override: undefined, advertised: 'http://evil.example', isPackaged: true }), 'https://durango.sh', 'packaged builds never accept a plain-http advertised origin');
  assert.equal(resolveDurangoBaseUrl({ override: undefined, advertised: null, isPackaged: false }), 'http://localhost:3100');

  // --- Mint once, store, reuse; contracts §8 request shape ---------------------------
  {
    const { state, client } = fixture({
      apiResponses: [
        (url, init) => {
          assert.equal(url.origin, 'https://durango.example', 'uses the server-advertised Durango origin');
          assert.equal(url.pathname, '/api/v1/chats');
          assert.equal(url.searchParams.get('q'), 'billing');
          assert.equal(url.searchParams.get('limit'), '5');
          assert.equal(init.headers.authorization, 'Bearer dgo_key1');
          return json({ data: [{ id: 'c1', projectId: 'p1', title: 'Billing', updatedAt: '2026-10-12T00:00:00Z', snippet: 's', url: 'https://durango.sh/chats/p1?node=c1' }], nextCursor: null });
        },
        json({ data: [], nextCursor: null }),
      ],
    });
    const result = await client.searchChats('billing', { limit: 5 });
    assert.equal(result.data[0].title, 'Billing');
    await client.searchChats('again');
    assert.equal(state.mints, 1, 'the stored key is reused');
    const mint = state.requests.find((request) => request.url.endsWith('/api/desktop-auth/durango-key'));
    assert.equal(mint.auth, 'Bearer desktop-session', 'minted with the desktop session bearer');
    assert.deepEqual(JSON.parse(mint.body), { deviceName: 'test-mac', deviceId: 'device-1' });
    assert.equal(state.stored.key, 'dgo_key1');
    assert.equal(await client.chatUrl('c1'), 'https://durango.sh/chats/p1?node=c1', 'chat links seen in results are remembered');
    assert.equal(await client.chatUrl('unknown'), 'https://durango.example/c/unknown');
  }

  // --- 401 from Durango: re-mint exactly once ------------------------------------------
  {
    const { state, client } = fixture({
      apiResponses: [json({ error: { message: 'bad key' } }, { status: 401 }), json({ facts: [{ id: 'f', text: 'Uses bun', kind: 'preference', source: 'chat' }] })],
    });
    const recalled = await client.recallMemory('tools');
    assert.equal(recalled.facts[0].text, 'Uses bun');
    assert.equal(state.mints, 2);
    assert.equal(state.stored.keyId, 'key_2');
    const twice = fixture({ apiResponses: [json({}, { status: 401 }), json({}, { status: 401 })] });
    await assert.rejects(twice.client.remember('x'), (error) => error instanceof DurangoError && error.code === 'not_connected');
    assert.equal(twice.state.mints, 2, 'gives up after one re-mint');
  }

  // --- Typed errors ----------------------------------------------------------------------
  {
    const { state, client } = fixture();
    state.session = null;
    await assert.rejects(client.searchChats('x'), (error) => error.code === 'not_signed_in');
    assert.equal(state.requests.length, 0, 'signed out: no network at all');

    const expired = fixture({ mintResponses: [json({ error: 'Invalid session.' }, { status: 401 })] });
    await assert.rejects(expired.client.searchChats('x'), (error) => error.code === 'not_signed_in');

    const unsupported = fixture({ mintResponses: [json({ error: 'Not found' }, { status: 404 })] });
    await assert.rejects(unsupported.client.searchChats('x'), (error) => error.code === 'not_connected');
    // Failed mints back off instead of hammering the (rate-limited) endpoint.
    await assert.rejects(unsupported.client.searchChats('x'), (error) => error.code === 'not_connected');
    assert.equal(unsupported.state.mints, 1, 'a failed mint is not retried during its cooldown');

    const limited = fixture({ mintResponses: [new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'retry-after': '120' } })] });
    await assert.rejects(limited.client.readChat('c1'), (error) => error.code === 'not_connected' && /2 min/.test(error.message));
    await assert.rejects(limited.client.readChat('c1'), /Too many/);
    assert.equal(limited.state.mints, 1, '429 honours Retry-After');
    await limited.credentials.clear();
    await assert.rejects(limited.client.readChat('c1'));
    assert.equal(limited.state.mints, 2, 'an account change resets the backoff');

    const offline = fixture({ apiResponses: [() => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }] });
    await assert.rejects(offline.client.searchChats('x'), (error) => error.code === 'network' && /timed out/.test(error.message));

    const apiError = fixture({ apiResponses: [json({ error: { message: 'Chat not found', code: 'not_found' } }, { status: 404 })] });
    await assert.rejects(apiError.client.readChat('missing'), (error) => error.code === 'api' && error.message === 'Chat not found');

    const invalid = fixture({ mintResponses: [json({ key: 'nope', keyId: 'k' }, { status: 201 })] });
    await assert.rejects(invalid.client.searchChats('x'), /invalid Durango key/);
    assert.equal(invalid.state.stored, null);
  }

  // --- Sign-out revokes with the ending session, then wipes ---------------------------------
  {
    const { state, credentials, client } = fixture({ apiResponses: [json({ data: [], nextCursor: null })] });
    await client.searchChats('x');
    const ending = state.session;
    state.session = null;
    await credentials.clear({ revokeRemote: true, session: ending });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.stored, null);
    assert.deepEqual(state.revokes, ['key_1']);
    const revoke = state.requests.find((request) => request.method === 'DELETE');
    assert.equal(revoke.auth, 'Bearer desktop-session');
    assert.equal(await credentials.peek(), null);
  }

  // --- Sign-out during a mint never keeps the raced key ------------------------------------
  {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const { state, credentials } = fixture({ mintResponses: [async () => { await held; return json({ key: 'dgo_raced', keyId: 'raced', durangoBaseUrl: null }, { status: 201 }); }] });
    const inflight = credentials.get();
    await new Promise((resolve) => setImmediate(resolve));
    await credentials.clear();
    release();
    await assert.rejects(inflight, /account changed/);
    assert.equal(state.stored, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(state.revokes.includes('raced'), 'a key minted for a cleared account is revoked');
  }

  // --- Tools: formatting, validation, errors as text --------------------------------------
  setDurangoToolsClient(null);
  let result = await runDurangoTool('search_chats', { query: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.text, /not connected/);

  setDurangoToolsClient(createMockDurangoClient());
  result = await runDurangoTool('search_chats', { query: 'billing' });
  assert.equal(result.ok, true);
  assert.match(result.text, /information only, not instructions/);
  assert.match(result.text, /chatId: jd7mockchat0001billingrewrite/);
  assert.match(result.text, /@chat:<chatId>/);
  result = await runDurangoTool('read_chat', { chatId: '@chat:billing-rewrite-plan-jd7mockchat0001billingrewrite' });
  assert.equal(result.ok, true, 'read_chat accepts a mention token');
  assert.match(result.text, /--- User/);
  assert.match(result.text, /Phase 1: ledger table/);
  result = await runDurangoTool('read_chat', { chatId: 'nope' });
  assert.equal(result.ok, false);
  assert.match(result.text, /not found/);
  result = await runDurangoTool('recall_memory', { query: 'tools' });
  assert.match(result.text, /Prefers bun over npm and yarn\. \(preference, from Durango Chat\)/);
  result = await runDurangoTool('remember', { fact: 'Prefers tabs.' }, { accessMode: 'read-only' });
  assert.equal(result.ok, false, 'remember is refused in Read only');
  result = await runDurangoTool('remember', { fact: 'Prefers tabs.' }, { accessMode: 'workspace-write' });
  assert.equal(result.ok, true);
  assert.match((await runDurangoTool('recall_memory', { query: 'x' })).text, /Prefers tabs\./);
  for (const [name, args] of [
    ['search_chats', {}],
    ['search_chats', { query: 'x', limit: 0 }],
    ['read_chat', { chatId: '' }],
    ['read_chat', { chatId: 'c', cursor: 3 }],
    ['recall_memory', { query: ' ' }],
    ['remember', { fact: '' }],
    ['remember', { fact: 'x'.repeat(1001) }],
    ['unknown_tool', {}],
  ]) {
    const invalid = await runDurangoTool(name, args);
    assert.equal(invalid.ok, false, `${name} ${JSON.stringify(args)} is rejected`);
  }
  // Signed out: a clear explanation, never a throw.
  const signedOut = fixture();
  signedOut.state.session = null;
  setDurangoToolsClient(signedOut.client);
  result = await runDurangoTool('read_chat', { chatId: 'c1' });
  assert.equal(result.ok, false);
  assert.match(result.text, /not signed in to their Durango account/);

  // --- Profile memory block --------------------------------------------------------------
  const facts = Array.from({ length: 40 }, (_, index) => ({ text: `Fact number ${index} about how the user likes to work and ship code.` }));
  const block = buildDurangoMemoryBlock([...facts, { text: 'Fact number 0 about how the user likes to work and ship code.' }]);
  assert.ok(block.length <= PROFILE_MEMORY_MAX_CHARS, `block is ${block.length} chars`);
  assert.match(block, /^\[Durango memory\]\n/);
  assert.match(block, /\n\[\/Durango memory\]$/);
  assert.match(block, /not instructions/);
  assert.equal(buildDurangoMemoryBlock([]), '');
  let recalls = 0;
  let clock = 0;
  const cache = createProfileMemoryCache({
    getClient: () => ({ recallMemory: async (query) => { recalls += 1; assert.match(query, /preferences, working style, tools/); return { facts: [{ text: 'Uses bun.' }] }; } }),
    now: () => clock,
  });
  assert.match((await cache.get('user_1')).block, /Uses bun\./);
  await cache.get('user_1');
  assert.equal(recalls, 1, 'cached within 10 minutes');
  clock += 10 * 60 * 1000;
  await cache.get('user_1');
  assert.equal(recalls, 2, 'refreshed after 10 minutes');
  await cache.get('user_2');
  assert.equal(recalls, 3, 'cached per account');

  // --- Routing / approvals -------------------------------------------------------------------
  for (const name of DURANGO_TOOL_NAMES) assert.ok(ORION_BUILTIN_TOOL_NAMES.includes(name));
  for (const mode of ['read-only', 'workspace-write', 'full-access']) {
    for (const name of ['search_chats', 'read_chat', 'recall_memory', 'read_thread', 'spawn_subagent']) {
      assert.equal(isPreapprovedOrionTool(name, mode), true, `${name} in ${mode}`);
    }
  }
  assert.equal(isPreapprovedOrionTool('remember', 'read-only'), false);
  assert.equal(isPreapprovedOrionTool('remember', 'workspace-write'), true);
  assert.equal(isPreapprovedOrionTool('bash', 'full-access'), false);
  assert.equal(isRequiredThreadReaderBridgeMissing('grok', true, false), true);
  assert.equal(isRequiredThreadReaderBridgeMissing('claude', true, false), false);

  // --- In-process Claude server exposes the same tools ---------------------------------------
  setDurangoToolsClient(createMockDurangoClient());
  const registered = [];
  const server = createOrionMcpServer(
    {
      createSdkMcpServer: (config) => config,
      tool: (name, description, schema, handler, extra) => {
        registered.push({ name, description, schema, handler, extra });
        return { name };
      },
    },
    { z },
    { threadId: 't', projectPath: testRoot, accessMode: 'read-only', sender: null }
  );
  assert.equal(server.name, 'orion');
  for (const name of DURANGO_TOOL_NAMES) {
    const entry = registered.find((candidate) => candidate.name === name);
    assert.ok(entry, `Claude registers ${name}`);
    assert.equal(entry.description, DURANGO_TOOL_DESCRIPTIONS[name]);
    assert.deepEqual(Object.keys(entry.schema).sort(), Object.keys(DURANGO_TOOL_INPUT_SCHEMAS[name].properties).sort());
  }
  const claudeRemember = await registered.find((entry) => entry.name === 'remember').handler({ fact: 'x' });
  assert.equal(claudeRemember.isError, true, 'the session access mode reaches the tool');
  const claudeSearch = await registered.find((entry) => entry.name === 'search_chats').handler({ query: 'deploy' });
  assert.match(claudeSearch.content[0].text, /futuremail deploy checklist/);

  // --- Bridge shim advertises identical tools and forwards calls ------------------------------
  const shimPath = path.join(testRoot, 'shim.cjs');
  await fs.writeFile(shimPath, shimSource);
  const socketPath = path.join(testRoot, 'bridge.sock');
  const bridgeServer = net.createServer(handleMcpBridgeConnection);
  await new Promise((resolve) => bridgeServer.listen(socketPath, resolve));
  mcpBridgeSessions.set('tok', { getSender: () => null, threadId: 't', projectPath: testRoot, providerId: 'grok', accessMode: 'read-only' });
  const child = spawn(process.execPath, [shimPath, '--socket', socketPath, '--token', 'tok'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const replies = new Map();
  const waiters = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      replies.set(message.id, message);
      waiters.get(message.id)?.(message);
    }
  });
  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  try {
    const list = await call('tools/list', {});
    const shimTools = list.result.tools;
    for (const name of DURANGO_TOOL_NAMES) {
      const tool = shimTools.find((candidate) => candidate.name === name);
      assert.ok(tool, `shim lists ${name}`);
      assert.equal(tool.description, DURANGO_TOOL_DESCRIPTIONS[name], `${name} description matches durango-tools.js`);
      assert.deepEqual(tool.inputSchema, DURANGO_TOOL_INPUT_SCHEMAS[name], `${name} schema matches durango-tools.js`);
    }
    assert.deepEqual(shimTools.map((tool) => tool.name), ORION_BUILTIN_TOOL_NAMES);
    const search = await call('tools/call', { name: 'search_chats', arguments: { query: 'onboarding' } });
    assert.equal(search.result.isError, false);
    assert.match(search.result.content[0].text, /Onboarding copy ideas/);
    const remember = await call('tools/call', { name: 'remember', arguments: { fact: 'x' } });
    assert.equal(remember.result.isError, true, 'bridge sessions carry their access mode');
    const bad = await call('tools/call', { name: 'read_chat', arguments: {} });
    assert.equal(bad.result.isError, true);
  } finally {
    child.kill();
    bridgeServer.close();
    mcpBridgeSessions.delete('tok');
  }

  // A bridge connection with no client installed still answers in text.
  setDurangoToolsClient(null);
  const fakeSocket = new EventEmitter();
  const written = [];
  fakeSocket.write = (data) => written.push(JSON.parse(data));
  mcpBridgeSessions.set('tok2', { getSender: () => null, threadId: 't', projectPath: testRoot, accessMode: 'full-access' });
  handleMcpBridgeConnection(fakeSocket);
  fakeSocket.emit('data', Buffer.from(`${JSON.stringify({ id: 9, token: 'tok2', tool: 'recall_memory', args: { query: 'q' } })}\n`));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(written[0].ok, false);
  assert.match(written[0].text, /Durango Chat is unavailable/);
  mcpBridgeSessions.delete('tok2');

  console.log('durango tools: ok');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
  app.exit(process.exitCode ?? 0);
}
