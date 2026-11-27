// Direct loopback HTTP MCP bridge (src/main/mcp-bridge.js):
// ACP providers advertising `mcpCapabilities.http === true` (like Antigravity)
// connect directly to Durango Code's local authenticated Streamable HTTP MCP
// endpoint instead of spawning an ELECTRON_RUN_AS_NODE stdio shim child.
//
//   node scripts/run-electron-test.mjs scripts/test-mcp-http-bridge.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  closeMcpBridge,
  dispatchBridgeToolCall,
  ensureMcpHttpBridge,
  mcpBridgeSessions,
  orionAcpHttpMcpServers,
  orionAcpMcpServers,
  pendingSubagentSpawns,
  registerMcpBridgeForRun,
} from '../src/main/mcp-bridge.js';
import { setProjectNotesReader } from '../src/main/project-notes-tool.js';
import { setDeviceDataRootForTests } from '../src/main/devices/device-settings.js';
import { writeThreadsPatch } from '../src/main/thread-storage.js';

const testRoot = await fs.mkdtemp(path.join('/tmp', 'om-'));
app.setPath('userData', testRoot);
setDeviceDataRootForTests(path.join(testRoot, 'device-data'));

const postRpc = async (url, token, body, extraHeaders = {}) => {
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extraHeaders,
  };
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const raw = await response.text();
  let json = null;
  if (raw) {
    try {
      json = JSON.parse(raw);
    } catch {}
  }
  return { status: response.status, headers: response.headers, raw, json };
};

const rawHttpRequest = ({ port, method = 'POST', requestPath = '/mcp', headers = {}, body = '' }) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: requestPath, headers },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

let antigravityReg = null;
let codexReg = null;
try {
  // --- Registration shape + orionAcpHttpMcpServers helper ------------------------------
  const spawnEvents = [];
  const fakeSender = {
    isDestroyed: () => false,
    send: (channel, payload) => spawnEvents.push({ channel, payload }),
  };

  antigravityReg = await registerMcpBridgeForRun({
    getSender: () => fakeSender,
    threadId: 'thread-ag-http',
    runId: 'run-ag-http',
    projectPath: testRoot,
    projectId: 'proj-http',
    providerId: 'antigravity',
    modelId: 'antigravity:gemini-3.8-flash',
    accessMode: 'full-access',
    browserMode: 'off',
    userServers: [],
  });
  assert.ok(antigravityReg, 'antigravity bridge registered');
  assert.match(antigravityReg.httpUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.deepEqual(antigravityReg.httpHeaders, [
    { name: 'Authorization', value: `Bearer ${antigravityReg.token}` },
  ]);

  const httpAcp = orionAcpHttpMcpServers(antigravityReg);
  assert.deepEqual(httpAcp, [
    {
      type: 'http',
      name: 'orion',
      url: antigravityReg.httpUrl,
      headers: [{ name: 'Authorization', value: `Bearer ${antigravityReg.token}` }],
    },
  ]);

  // Fallback to stdio when httpUrl is absent, and empty array when null.
  const stdioOnlyBridge = {
    command: '/orion',
    args: ['shim.cjs'],
    userServers: [{ name: 'docs', transport: 'http', url: 'https://docs.test/mcp', headers: { 'X-Api': '1' } }],
  };
  assert.deepEqual(orionAcpHttpMcpServers(stdioOnlyBridge), orionAcpMcpServers(stdioOnlyBridge));
  assert.deepEqual(orionAcpHttpMcpServers(null), []);
  assert.deepEqual(
    orionAcpHttpMcpServers({ ...stdioOnlyBridge, httpUrl: antigravityReg.httpUrl, httpHeaders: antigravityReg.httpHeaders }),
    [
      { type: 'http', name: 'docs', url: 'https://docs.test/mcp', headers: [{ name: 'X-Api', value: '1' }] },
      { type: 'http', name: 'orion', url: antigravityReg.httpUrl, headers: antigravityReg.httpHeaders },
    ]
  );

  const parsedUrl = new URL(antigravityReg.httpUrl);
  const port = Number(parsedUrl.port);

  // --- Auth & security checks ----------------------------------------------------------
  const noAuth = await postRpc(antigravityReg.httpUrl, null, { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(noAuth.status, 401, 'missing Authorization rejected with 401');
  assert.equal(noAuth.headers.get('www-authenticate'), 'Bearer');

  const wrongToken = await postRpc(antigravityReg.httpUrl, 'not-a-valid-token', { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(wrongToken.status, 401, 'invalid bearer token rejected with 401');

  const sameLenWrongToken = await postRpc(
    antigravityReg.httpUrl,
    '0'.repeat(antigravityReg.token.length),
    { jsonrpc: '2.0', id: 1, method: 'ping' }
  );
  assert.equal(sameLenWrongToken.status, 401, 'same-length invalid token rejected with 401');

  const wrongScheme = await postRpc(
    antigravityReg.httpUrl,
    null,
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { Authorization: `Basic ${antigravityReg.token}` }
  );
  assert.equal(wrongScheme.status, 401, 'non-Bearer scheme rejected with 401');

  const unauthDelete = await fetch(antigravityReg.httpUrl, { method: 'DELETE' });
  assert.equal(unauthDelete.status, 401, 'unauthenticated DELETE rejected with 401');

  const badHost = await rawHttpRequest({
    port,
    headers: {
      Host: `evil.example:${port}`,
      Authorization: `Bearer ${antigravityReg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(badHost.status, 403, 'non-loopback Host header rejected with 403');

  const badOrigin = await rawHttpRequest({
    port,
    headers: {
      Host: `127.0.0.1:${port}`,
      Origin: 'https://evil.example',
      Authorization: `Bearer ${antigravityReg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(badOrigin.status, 403, 'non-loopback Origin header rejected with 403');

  const notFound = await fetch(`http://127.0.0.1:${port}/other`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${antigravityReg.token}` },
  });
  assert.equal(notFound.status, 404, 'unknown path returns 404');

  const getMethod = await fetch(antigravityReg.httpUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${antigravityReg.token}` },
  });
  assert.equal(getMethod.status, 405, 'GET /mcp returns 405');
  assert.equal(getMethod.headers.get('allow'), 'POST, DELETE');

  const badJson = await postRpc(antigravityReg.httpUrl, antigravityReg.token, '{not json');
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error.code, -32700, 'invalid JSON returns -32700 parse error');

  // --- MCP JSON-RPC lifecycle (Antigravity: compact + background-subagents) ------------
  const init = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agy', version: '1.5.14' } },
  });
  assert.equal(init.status, 200);
  assert.deepEqual(init.json, {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'orion', version: '1.0.0' },
    },
  });

  const initialized = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  assert.equal(initialized.status, 202, 'notifications/initialized returns 202 Accepted');
  assert.equal(initialized.raw, '');

  const customNotification = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 99 },
  });
  assert.equal(customNotification.status, 202, 'other notifications return 202 Accepted');

  const ping = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'ping',
  });
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.json, { jsonrpc: '2.0', id: 2, result: {} });

  const resources = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'resources/list',
  });
  assert.deepEqual(resources.json.result, { resources: [] });

  const prompts = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    id: 4,
    method: 'prompts/list',
  });
  assert.deepEqual(prompts.json.result, { prompts: [] });

  const unknownMethod = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    id: 5,
    method: 'sampling/createMessage',
  });
  assert.equal(unknownMethod.status, 200);
  assert.equal(unknownMethod.json.error.code, -32601);

  // tools/list for antigravity: compact mode + background-subagents (includes wait_subagents)
  const listResp = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/list',
    params: {},
  });
  assert.equal(listResp.status, 200);
  const tools = listResp.json.result.tools;
  const toolNames = tools.map((tool) => tool.name);
  assert.equal(toolNames[0], 'load_tools', 'compact mode lists load_tools first');
  assert.ok(toolNames.includes('wait_subagents'), 'antigravity includes wait_subagents');
  assert.ok(toolNames.includes('spawn_subagent'));
  assert.ok(toolNames.includes('read_thread'));
  assert.ok(toolNames.includes('project_notes'));
  assert.equal(toolNames.includes('browser_open'), false, 'browser tools absent while browserMode is off');
  const compactSpawn = tools.find((tool) => tool.name === 'spawn_subagent');
  assert.ok(compactSpawn.description.length <= 120, 'compact tool has one-line summary');
  assert.equal(compactSpawn.inputSchema.required, undefined, 'compact schema leaves required open');

  // Settling browserMode after registration is reflected immediately by HTTP tools/list.
  antigravityReg.setBrowserMode('builtin');
  const listWithBrowser = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/list',
  });
  assert.ok(
    listWithBrowser.json.result.tools.some((tool) => tool.name === 'browser_open'),
    'browser tools appear after setBrowserMode("builtin")'
  );

  // --- tools/call: load_tools, compact validation, real dispatch & errors --------------
  const loadSummary = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'load_tools', arguments: {} },
  });
  assert.equal(loadSummary.status, 200);
  assert.equal(loadSummary.json.result.isError, false);
  assert.match(loadSummary.json.result.content[0].text, /Durango Code tools you can load:.*wait_subagents/);

  const loadSpecific = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'load_tools', arguments: { tools: ['spawn_subagent', 'wait_subagents'] } },
  });
  assert.equal(loadSpecific.json.result.isError, false);
  const loadedPayload = JSON.parse(loadSpecific.json.result.content[0].text);
  const fullSpawn = loadedPayload.tools.find((tool) => tool.name === 'spawn_subagent');
  assert.match(fullSpawn.description, /Returns as soon as the subagent has started/, 'antigravity gets background spawn description');
  assert.ok(loadedPayload.tools.some((tool) => tool.name === 'wait_subagents'));

  // Compact validation: first bad call returns the full definition; second omits it.
  const badReadFirst = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'read_thread', arguments: { wrong: true } },
  });
  assert.equal(badReadFirst.json.result.isError, true);
  assert.match(badReadFirst.json.result.content[0].text, /read_thread did not run: `thread_id` is required; `wrong` is not an argument\. Its full definition/);

  const badReadSecond = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'read_thread', arguments: {} },
  });
  assert.equal(badReadSecond.json.result.isError, true);
  assert.equal(badReadSecond.json.result.content[0].text, 'read_thread did not run: `thread_id` is required.');

  // Real tool call: read_thread (non-existent thread returns readable text; blank id returns isError: true)
  const realRead = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'read_thread', arguments: { thread_id: 'nonexistent-thread-id-xyz' } },
  });
  assert.equal(realRead.status, 200);
  assert.equal(realRead.json.result.isError, false);
  assert.match(realRead.json.result.content[0].text, /No Durango Code thread|not found|no longer stored/i);

  const blankRead = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    id: 120,
    method: 'tools/call',
    params: { name: 'read_thread', arguments: { thread_id: '   ' } },
  });
  assert.equal(blankRead.status, 200);
  assert.equal(blankRead.json.result.isError, true);
  assert.match(blankRead.json.result.content[0].text, /requires a string `thread_id`/);

  // Thread-reads-thread over HTTP MCP bridge (e.g. plan rewrite reading an AgentMail research thread):
  // returns a long final report in full and pages a >34k report cleanly with char_offset.
  {
    const researchCore = 'AGENTMAIL_KEY_FINDING_AT_14K: webhook signature uses Svix HMAC-SHA256';
    const researchTail = 'AGENTMAIL_TAIL_PAST_34K: pricing tier limits';
    const researchThread = {
      id: 'research-agentmail-0001',
      projectId: 'proj-http',
      title: 'AgentMail research',
      status: 'done',
      modelId: 'claude:opus',
      createdAt: '2026-11-27T00:00:00.000Z',
      messages: [
        { role: 'user', content: 'Research AgentMail integration.' },
        {
          role: 'agent',
          content: `OPENING\n${'a'.repeat(14_000)}\n${researchCore}\n${'b'.repeat(21_000)}\n${researchTail}`,
        },
      ],
    };
    await writeThreadsPatch({ version: 2, upserts: [researchThread], deletes: [], order: [researchThread.id] });
    const readFull = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
      jsonrpc: '2.0',
      id: 121,
      method: 'tools/call',
      params: { name: 'read_thread', arguments: { thread_id: researchThread.id, limit: 1 } },
    });
    assert.equal(readFull.status, 200);
    assert.equal(readFull.json.result.isError, false);
    const page1Text = readFull.json.result.content[0].text;
    assert.ok(page1Text.includes(researchCore), 'thread-reads-thread receives finding past 6k on first call');
    const nextPtr = page1Text.match(/offset=(\d+), limit=1, char_offset=(\d+)/);
    assert.ok(nextPtr, 'thread-reads-thread gets exact char_offset continuation pointer');
    const readRest = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
      jsonrpc: '2.0',
      id: 122,
      method: 'tools/call',
      params: {
        name: 'read_thread',
        arguments: {
          thread_id: researchThread.id,
          offset: Number(nextPtr[1]),
          limit: 1,
          char_offset: Number(nextPtr[2]),
        },
      },
    });
    assert.equal(readRest.status, 200);
    assert.equal(readRest.json.result.isError, false);
    assert.ok(readRest.json.result.content[0].text.includes(researchTail), 'thread-reads-thread reads tail via char_offset');
  }

  // Real tool call: project_notes (happy path through dispatchBridgeToolCall)
  let capturedProjectRun = null;
  setProjectNotesReader(async (run) => {
    capturedProjectRun = run;
    return { name: 'Demo', notes: [{ content: 'HTTP MCP works.', createdAt: 1 }], files: [] };
  });
  try {
    const notesCall = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'project_notes', arguments: {} },
    });
    assert.equal(notesCall.status, 200);
    assert.equal(notesCall.json.result.isError, false);
    assert.match(notesCall.json.result.content[0].text, /HTTP MCP works\./);
    assert.deepEqual(capturedProjectRun, { projectId: 'proj-http', projectPath: testRoot });
  } finally {
    setProjectNotesReader(null);
  }

  // Real tool call: wait_subagents with no pending subagents returns immediately
  const waitCall = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/call',
    params: { name: 'wait_subagents', arguments: { timeout_seconds: 1 } },
  });
  assert.equal(waitCall.status, 200);
  assert.equal(waitCall.json.result.isError, false);
  assert.match(waitCall.json.result.content[0].text, /No subagents are waiting to be collected/);

  // Unknown tool returns JSON-RPC -32602
  const unknownTool = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/call',
    params: { name: 'does_not_exist', arguments: {} },
  });
  assert.equal(unknownTool.status, 200);
  assert.equal(unknownTool.json.error.code, -32602);

  // Direct dispatchBridgeToolCall parity check
  const directUnknown = await dispatchBridgeToolCall(mcpBridgeSessions.get(antigravityReg.token), 'does_not_exist', {});
  assert.equal(directUnknown.ok, false);
  assert.equal(directUnknown.text, 'Unknown tool: does_not_exist');

  // --- Interop check with real @modelcontextprotocol/sdk StreamableHTTPClientTransport --
  const sdkClient = new Client({ name: 'sdk-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(antigravityReg.httpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${antigravityReg.token}` } },
  });
  try {
    await sdkClient.connect(transport);
    const sdkTools = await sdkClient.listTools();
    assert.equal(sdkTools.tools[0].name, 'load_tools');
    assert.ok(sdkTools.tools.some((tool) => tool.name === 'wait_subagents'));
    const sdkWait = await sdkClient.callTool({ name: 'wait_subagents', arguments: { timeout_seconds: 0 } });
    assert.notEqual(sdkWait.isError, true);
    assert.match(sdkWait.content[0].text, /No subagents are waiting/);
  } finally {
    await sdkClient.close();
  }

  // --- Non-compact provider (Codex): full list, instructions, no wait_subagents --------
  codexReg = await registerMcpBridgeForRun({
    getSender: () => fakeSender,
    threadId: 'thread-codex-http',
    runId: 'run-codex-http',
    projectPath: testRoot,
    providerId: 'codex',
    accessMode: 'read-only',
    browserMode: 'off',
    userServers: [],
  });
  assert.equal(codexReg.httpUrl, antigravityReg.httpUrl, 'reuses the single loopback HTTP server');

  const codexInit = await postRpc(codexReg.httpUrl, codexReg.token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  });
  assert.match(codexInit.json.result.instructions, /^Durango Code, the app running you:/, 'codex gets server instructions');

  const codexList = await postRpc(codexReg.httpUrl, codexReg.token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  });
  const codexTools = codexList.json.result.tools;
  assert.equal(codexTools.some((tool) => tool.name === 'wait_subagents'), false, 'codex omits wait_subagents');
  assert.equal(codexTools.some((tool) => tool.name === 'load_tools'), false, 'no user servers + non-compact omits load_tools');
  const codexSpawn = codexTools.find((tool) => tool.name === 'spawn_subagent');
  assert.match(codexSpawn.description, /Blocks until the subagent finishes/, 'codex gets full blocking description');
  assert.deepEqual(codexSpawn.inputSchema.required, ['model', 'prompt'], 'codex gets full schema');

  // --- DELETE /mcp returns 204 and resets HTTP handler state ---------------------------
  const delResp = await fetch(antigravityReg.httpUrl, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${antigravityReg.token}` },
  });
  assert.equal(delResp.status, 204, 'DELETE /mcp returns 204');

  // After DELETE, compact loadedTools state was cleared so a bad call shows the definition again.
  const badReadAfterDelete = await postRpc(antigravityReg.httpUrl, antigravityReg.token, {
    jsonrpc: '2.0',
    id: 16,
    method: 'tools/call',
    params: { name: 'read_thread', arguments: {} },
  });
  assert.match(badReadAfterDelete.json.result.content[0].text, /Its full definition/, 'DELETE reset per-session compact state');

  // --- Late body arriving after session release must be rejected with 401 --------------
  const lateReg = await registerMcpBridgeForRun({
    getSender: () => ({ isDestroyed: () => false, send: () => {} }),
    threadId: 'thread-late-revoke',
    runId: 'run-late-revoke',
    projectPath: testRoot,
    providerId: 'antigravity',
    modelId: 'antigravity:gemini-3.8-flash',
    accessMode: 'full-access',
  });
  const latePort = Number(new URL(lateReg.httpUrl).port);
  const lateResp = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: latePort,
        method: 'POST',
        path: '/mcp',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${lateReg.token}`,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'project_notes', arguments: {} } });
    // Send headers + first byte so the server passes initial auth and awaits the body,
    // then release the session before finishing the body.
    req.write(body.slice(0, 10));
    setTimeout(() => {
      lateReg.release();
      req.end(body.slice(10));
    }, 30);
  });
  assert.equal(lateResp.status, 401, 'body completing after token release must return 401 without dispatching');

  // --- abortTurn() blocks idle out-of-turn calls until rebindTurn() starts next turn ---
  const warmReg = await registerMcpBridgeForRun({
    getSender: () => ({ isDestroyed: () => false, send: () => {} }),
    threadId: 'thread-warm-abort',
    runId: 'run-warm-1',
    projectPath: testRoot,
    providerId: 'antigravity',
    modelId: 'antigravity:gemini-3.8-flash',
    accessMode: 'full-access',
  });
  warmReg.abortTurn();
  const whileIdle = await postRpc(warmReg.httpUrl, warmReg.token, { jsonrpc: '2.0', id: 100, method: 'ping' });
  assert.equal(whileIdle.status, 401, 'abortTurn() rejects idle out-of-turn requests with 401');
  warmReg.rebindTurn({ runId: 'run-warm-2' });
  const afterRebind = await postRpc(warmReg.httpUrl, warmReg.token, { jsonrpc: '2.0', id: 101, method: 'ping' });
  assert.equal(afterRebind.status, 200, 'rebindTurn() restores authorization for the next turn');
  const hostNoPort = await rawHttpRequest({
    port: Number(new URL(warmReg.httpUrl).port),
    headers: { Host: '127.0.0.1', 'Content-Type': 'application/json', Authorization: `Bearer ${warmReg.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'ping' }),
  });
  assert.equal(hostNoPort.status, 403, 'Host header missing expected port is rejected with 403');
  warmReg.release();

  // --- Session release revokes token immediately ---------------------------------------
  const revokedToken = antigravityReg.token;
  const revokedUrl = antigravityReg.httpUrl;
  antigravityReg.release();
  antigravityReg = null;
  const afterRelease = await postRpc(revokedUrl, revokedToken, {
    jsonrpc: '2.0',
    id: 17,
    method: 'ping',
  });
  assert.equal(afterRelease.status, 401, 'released session token is rejected immediately with 401');

  // Codex session still works while Antigravity's was released.
  const codexPing = await postRpc(codexReg.httpUrl, codexReg.token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'ping',
  });
  assert.equal(codexPing.status, 200, 'other active session remains unaffected');
  codexReg.release();
  codexReg = null;

  // --- closeMcpBridge() shuts down cleanly and allows restart --------------------------
  await closeMcpBridge();
  await assert.rejects(
    fetch(revokedUrl, { method: 'POST', headers: { Authorization: `Bearer ${revokedToken}` } }),
    'closed server no longer accepts connections'
  );
  const restarted = await ensureMcpHttpBridge();
  assert.match(restarted.httpUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  await closeMcpBridge();

  console.log('mcp http bridge: ok');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  antigravityReg?.release();
  codexReg?.release();
  for (const id of [...pendingSubagentSpawns.keys()]) pendingSubagentSpawns.delete(id);
  await closeMcpBridge();
  await fs.rm(testRoot, { recursive: true, force: true });
  app.exit(process.exitCode ?? 0);
}
