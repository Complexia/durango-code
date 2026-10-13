import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRepositoryCredentials } from '../src/main/repository-credentials.js';
import { describeGitPushFailure } from '../src/main/source-control.js';

const token = `orion_pat_${'a'.repeat(64)}`;
const session = { token: 'account-session', user: { id: 'user-a' }, expiresAt: '2099-01-01T00:00:00Z' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('push errors preserve recovery guidance from Cloud preflight', () => {
  assert.match(describeGitPushFailure(Object.assign(new Error('Invalid token.'), { status: 401 })).errorDetail, /sign in again/i);
  assert.match(describeGitPushFailure(Object.assign(new Error('denied'), { status: 403 })).errorDetail, /repo:write/);
  assert.match(describeGitPushFailure(Object.assign(new Error('unavailable'), { status: 503 })).errorDetail, /retry shortly/i);
});
function fixture(overrides = {}) {
  const state = { session, stored: null, requests: [], writes: 0, ...overrides.state };
  const options = {
    readSession: async () => state.session,
    readStored: async () => state.stored,
    writeStored: async value => { state.stored = value; state.writes++; },
    removeStored: async () => { state.stored = null; },
    origin: () => 'https://orion.example', deviceName: 'test-device',
    fetchImpl: async (url, init) => {
      state.requests.push({ url: String(url), method: init.method });
      return Response.json({ token, id: 'token-a' });
    }, ...overrides.options,
  };
  return { state, options, manager: createRepositoryCredentials(options) };
}

test('concurrent operations provision once; restart and account expiry reuse durable credential', async () => {
  const { state, options, manager } = fixture();
  const results = await Promise.all(Array.from({ length: 15 }, () => manager.get()));
  assert.equal(state.requests.length, 1);
  assert.equal(state.writes, 1);
  assert.ok(results.every(result => result.token === token));
  state.session = null;
  const restored = createRepositoryCredentials(options);
  assert.equal((await restored.get()).token, token);
  assert.equal(state.requests.length, 1);
});

test('sign-out during issuance cannot persist or return the old account token', async () => {
  const response = deferred();
  const { state, manager } = fixture({ options: { fetchImpl: () => response.promise } });
  const inflight = manager.get();
  await new Promise(resolve => setImmediate(resolve));
  await manager.clear();
  state.session = null;
  response.resolve(Response.json({ token, id: 'old-token' }));
  await assert.rejects(inflight, /account changed/);
  assert.equal(state.stored, null);
  await assert.rejects(manager.get(), /Sign in/);
});

test('sign-out during disk write removes the raced write and rejects its token', async () => {
  const writing = deferred(); const release = deferred();
  const { state, options } = fixture();
  const manager = createRepositoryCredentials({ ...options, writeStored: async value => { writing.resolve(); await release.promise; state.stored = value; } });
  const inflight = manager.get();
  await writing.promise;
  const clearing = manager.clear();
  release.resolve();
  await assert.rejects(inflight, /account changed/);
  await clearing;
  assert.equal(state.stored, null);
});

test('credentials are bound to the account and Cloud origin', async () => {
  const old = { origin: 'https://elsewhere.example', token: 'wrong-token', user: session.user };
  const { state, manager } = fixture({ state: { stored: old } });
  assert.equal((await manager.get()).token, token);
  assert.equal(state.requests.length, 1);
  const other = fixture({ state: { stored: { ...old, origin: 'https://orion.example', user: { id: 'user-b' } } } });
  assert.equal((await other.manager.get()).token, token);
  assert.equal(other.state.requests.length, 1);
});

test('invalid credentials and outages never downgrade to the account token', async () => {
  for (const status of [401, 403, 503]) {
    const { state, manager } = fixture({ options: { fetchImpl: async () => Response.json({ error: 'rejected' }, { status }) } });
    await assert.rejects(manager.get(), /rejected/);
    assert.equal(state.writes, 0);
  }
  const { manager } = fixture({ options: { fetchImpl: async () => Response.json({ token: 'invalid' }) } });
  await assert.rejects(manager.get(), /invalid repository credential/);
});

test('old server fallback is temporary; stored PATs are never replaced automatically', async () => {
  const { manager } = fixture({ options: { fetchImpl: async () => new Response('', { status: 404 }) } });
  assert.equal((await manager.get()).token, session.token);
  const { state, manager: stored } = fixture({ state: { stored: { token, origin: 'https://orion.example', user: session.user } } });
  assert.equal((await stored.get()).token, token);
  assert.equal(state.requests.length, 0);
});

test('expired legacy sessions require explicit reauthorization', async () => {
  const { manager, state } = fixture({ state: { session: { ...session, expiresAt: '2000-01-01' } } });
  await assert.rejects(manager.get(), /Sign in/);
  assert.equal(state.requests.length, 0);
});

test('identity cutover rebinds the stored credential instead of minting a second one', async () => {
  const stored = { origin: 'https://orion.example', token, id: 'token-a', user: { id: 'user-old' } };
  const { state, manager } = fixture({ state: { stored, session: { ...session, user: { id: 'user-new' } } } });
  assert.equal(await manager.rebindUser('user-old', { id: 'user-new', email: 'a@example.com' }), true);
  assert.equal(state.stored.user.id, 'user-new');
  assert.equal((await manager.get()).token, token);
  assert.equal(state.requests.length, 0);
  // A credential owned by a different id is never rebound.
  assert.equal(await manager.rebindUser('user-someone-else', { id: 'user-x' }), false);
  assert.equal(state.stored.user.id, 'user-new');
});
