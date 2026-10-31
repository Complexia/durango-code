// Connectors from the Durango account (src/main/account-connectors.js) and the
// Durango client's listConnectors (src/main/durango-client.js), against a fake
// Durango server on localhost.
//
//   node --no-warnings scripts/test-account-connectors.mjs
import assert from 'node:assert/strict';
import http from 'node:http';

import { createDurangoClient } from '../src/main/durango-client.js';
import { createAccountConnectors } from '../src/main/account-connectors.js';

let listResponse = { status: 200, body: { connectors: [] } };
let listDelayMs = 0;
let listCalls = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/v1/connectors') {
    listCalls += 1;
    assert.equal(req.headers.authorization, 'Bearer dgo_test');
    setTimeout(() => {
      res.writeHead(listResponse.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(listResponse.body));
    }, listDelayMs);
    return;
  }
  res.writeHead(404).end();
});
const base = await new Promise((resolve) =>
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
);

const credentials = {
  async get() {
    return { key: 'dgo_test', keyId: 'key_1', baseUrl: base };
  },
  async refresh() {
    return { key: 'dgo_test', keyId: 'key_1', baseUrl: base };
  },
  async peek() {
    return { key: 'dgo_test', keyId: 'key_1', baseUrl: base };
  },
};
const session = { value: { token: 'desktop-session' } };
const client = createDurangoClient({ credentials, readSession: async () => session.value, webOrigin: () => base });

let clock = 1_000_000;
const connectors = createAccountConnectors({
  getClient: () => client,
  isSignedIn: async () => Boolean(session.value),
  reservedNames: new Set(['orion']),
  now: () => clock,
});

const reset = () => {
  connectors.clear();
  listCalls = 0;
  listDelayMs = 0;
};

// listConnectors keeps only Durango's connector proxy paths, on this device's Durango origin.
listResponse = {
  status: 200,
  body: {
    connectors: [
      { id: 'cn_1', kind: 'notion', name: 'Notion', serverName: 'durango-notion', url: `${base}/api/v1/connectors/cn_1/mcp` },
      { id: 'cn_2', kind: 'custom', name: 'Elsewhere', serverName: 'durango-elsewhere', url: 'https://evil.example/mcp' },
      { id: 'cn_3', kind: 'custom', name: 'Bad name', serverName: 'Bad Name!', url: `${base}/api/v1/connectors/cn_3/mcp` },
      { id: 'cn_4', kind: 'custom', name: 'Linear', serverName: 'durango-linear', url: 'http://localhost:9/api/v1/connectors/cn_4/mcp' },
    ],
  },
};
{
  const listed = await client.listConnectors();
  assert.deepEqual(listed.connectors.map((connector) => connector.serverName), ['durango-notion', 'durango-linear']);
  // A host alias of the same deployment is moved onto this device's origin.
  assert.equal(listed.connectors[1].url, `${base}/api/v1/connectors/cn_4/mcp`);
  assert.equal(listed.authorization, 'Bearer dgo_test');
}

// forRun: HTTP entries with this device's key; local names win.
{
  reset();
  const servers = await connectors.forRun({ taken: ['durango-linear'] });
  assert.deepEqual(servers, [
    {
      name: 'durango-notion',
      transport: 'http',
      url: `${base}/api/v1/connectors/cn_1/mcp`,
      headers: { Authorization: 'Bearer dgo_test' },
    },
  ]);
}

// Cached for a minute, then re-read.
{
  reset();
  await connectors.forRun();
  await connectors.forRun();
  assert.equal(listCalls, 1);
  clock += 61_000;
  await connectors.forRun();
  assert.equal(listCalls, 2);
}

// A failing listing never fails the run.
{
  reset();
  listResponse = { status: 500, body: { error: { message: 'down' } } };
  assert.deepEqual(await connectors.forRun(), []);
  const listed = await connectors.list();
  assert.equal(listed.ok, false);
}

// A slow listing doesn't hold up a turn that has nothing cached.
{
  reset();
  listResponse = { status: 200, body: { connectors: [] } };
  listDelayMs = 4_500;
  const started = Date.now();
  assert.deepEqual(await connectors.forRun(), []);
  assert.ok(Date.now() - started < 4_400, 'forRun waited for the slow listing');
}

// A listing that was in flight when the account changed is never handed out.
{
  reset();
  listResponse = {
    status: 200,
    body: { connectors: [{ id: 'cn_1', kind: 'notion', name: 'Notion', serverName: 'durango-notion', url: `${base}/api/v1/connectors/cn_1/mcp` }] },
  };
  listDelayMs = 300;
  const before = connectors.forRun();
  await new Promise((resolve) => setTimeout(resolve, 50));
  connectors.clear();
  listResponse = { status: 200, body: { connectors: [] } };
  listDelayMs = 0;
  const after = await connectors.forRun();
  assert.deepEqual(await before, []);
  assert.deepEqual(after, []);
  assert.deepEqual(await connectors.forRun(), []);
}

// Signed out: nothing, and Settings says so.
{
  reset();
  session.value = null;
  assert.deepEqual(await connectors.forRun(), []);
  assert.deepEqual(await connectors.list(), { ok: true, signedIn: false, connectors: [] });
  assert.equal(listCalls, 0);
}

await new Promise((resolve) => setTimeout(resolve, 600));
server.close();
console.log('account connectors: ok');
