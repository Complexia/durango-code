import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

import {
  CodexAppServerClient,
  createCodexAppServerManager,
} from '../src/main/codex-app-server-manager.js';

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const pendingQuitWorkSource = mainSource.match(
  /const waitForPendingQuitWork = \(\) =>[\s\S]*?\.then\(\(\) => threadsSaveQueue/
)?.[0];
assert.ok(pendingQuitWorkSource, 'the pending quit-work barrier should remain present');
assert.doesNotMatch(
  pendingQuitWorkSource,
  /codexAppServerShutdownPromise/,
  'the auxiliary Codex server must not strand Orion inside the global quit barrier'
);
assert.match(
  mainSource,
  /codexAppServerShutdownPromise = waitForPendingAgentShutdowns\(\)\.then\(\(\) =>\s*codexAppServerManager\.shutdown\(\)/,
  'the shared server should still stop after active agent connections are reaped'
);
assert.match(
  mainSource,
  /const appShutdownError = \(\) =>\s*appShutdownReason === 'update'[\s\S]*?'Durango Code is shutting down\.'/,
  'ordinary shutdown must not be mislabeled as an update installation'
);
assert.match(
  mainSource,
  /const settleQuitBarrierForUpdate = async \(\) =>[\s\S]*?disposeForQuit\('update'\)/,
  'only the updater pre-drain should select the update-specific shutdown message'
);
assert.match(
  mainSource,
  /app\.on\('activate', \(\) => \{\s*\/\/[\s\S]*?if \(appShutdownRequested\) return;/,
  'macOS activation must not recreate an unusable renderer during shutdown'
);

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  stderr = new EventEmitter();

  kill(signal = 'SIGTERM') {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.signalCode = signal;
    queueMicrotask(() => {
      this.emit('exit', null, signal);
      this.emit('close', null, signal);
    });
    return true;
  }
}

const createHarness = ({
  ready = true,
  connect = true,
  idleTimeoutMs = 1000,
  maxClients = 100,
  maxConnectFailures = 2,
  terminateGate = null,
} = {}) => {
  const servers = [];
  const clients = [];
  let endpointNumber = 0;
  const manager = createCodexAppServerManager({
    spawnServer: () => {
      const child = new FakeChild();
      servers.push(child);
      queueMicrotask(() => {
        if (ready) {
          child.stderr.emit(
            'data',
            Buffer.from(`codex app-server\n  listening on: ws://127.0.0.1:${5000 + ++endpointNumber}\n`)
          );
        }
      });
      return child;
    },
    connectClient: async (...args) => {
      const shouldConnect = typeof connect === 'function' ? connect(...args) : connect;
      if (!shouldConnect) throw new Error('connection failed');
      const child = new FakeChild();
      clients.push(child);
      return child;
    },
    terminateServer: async (child) => {
      if (terminateGate) await terminateGate;
      child.kill('SIGTERM');
      await delay();
    },
    startupTimeoutMs: 20,
    connectTimeoutMs: 20,
    idleTimeoutMs,
    maxClients,
    maxConnectFailures,
    logger: { warn: () => {} },
  });
  return { manager, servers, clients };
};

{
  const socket = new EventTarget();
  socket.readyState = 1;
  socket.closeCalls = 0;
  socket.close = () => {
    socket.closeCalls += 1;
  };
  socket.send = () => {};
  let abortCalls = 0;
  const client = new CodexAppServerClient(socket, {
    abortTransport: () => {
      abortCalls += 1;
    },
  });
  const exited = new Promise((resolve) => client.once('exit', resolve));
  assert.equal(client.kill('SIGTERM'), true);
  assert.equal(socket.closeCalls, 1, 'SIGTERM should request a graceful WebSocket close');
  assert.equal(client.kill('SIGKILL'), true);
  await exited;
  assert.equal(abortCalls, 1, 'SIGKILL must abort the underlying WebSocket transport');
  assert.equal(client.signalCode, 'SIGKILL');
  assert.equal(client.closed, true, 'forced termination must settle child shutdown immediately');
}

{
  const { manager, servers, clients } = createHarness();
  const [first, second] = await Promise.all([manager.acquire(), manager.acquire()]);
  assert.equal(servers.length, 1, 'concurrent clients must share one server startup');
  assert.equal(clients.length, 2, 'each run must keep an isolated protocol connection');
  assert.equal(first.persistent, true);
  assert.equal(second.persistent, true);
  assert.equal(first.endpoint, second.endpoint);
  assert.notEqual(first.child, second.child);
  assert.deepEqual(manager.snapshot(), {
    permanentlyStopped: false,
    running: true,
    starting: false,
    activeClients: 2,
    clientsSinceStart: 2,
    endpoint: 'ws://127.0.0.1:5001',
  });
  first.release();
  first.release();
  second.release();
  assert.equal(manager.snapshot().activeClients, 0, 'leases must release exactly once');
  await manager.shutdown();
}

{
  const { manager, servers } = createHarness();
  const first = await manager.acquire();
  const firstEndpoint = first.endpoint;
  servers[0].exitCode = 1;
  servers[0].emit('exit', 1, null);
  first.release();

  const second = await manager.acquire();
  assert.equal(servers.length, 2, 'a crashed server must be restarted on the next client');
  assert.notEqual(second.endpoint, firstEndpoint, 'restart must use a fresh endpoint');
  second.release();
  await manager.shutdown();
}

{
  const { manager, servers } = createHarness({ maxClients: 2 });
  const first = await manager.acquire();
  const second = await manager.acquire();
  first.release();
  second.release();
  await delay(10);
  assert.equal(manager.snapshot().running, false, 'the client cap must recycle an idle server');

  const third = await manager.acquire();
  assert.equal(servers.length, 2, 'work after a bounded recycle must lazily start a new server');
  third.release();
  await manager.shutdown();
}

{
  let releaseTermination;
  const terminateGate = new Promise((resolve) => {
    releaseTermination = resolve;
  });
  const { manager, servers } = createHarness({ terminateGate });
  const first = await manager.acquire();
  first.release();
  const recycle = manager.recycle();
  const left = manager.acquire();
  const right = manager.acquire();
  await delay();
  assert.equal(servers.length, 1, 'acquires must wait while the old server is recycling');
  releaseTermination();
  const [leftLease, rightLease] = await Promise.all([left, right]);
  await recycle;
  assert.equal(servers.length, 2, 'recycle waiters must share one replacement startup');
  assert.equal(leftLease.persistent, true);
  assert.equal(rightLease.persistent, true);
  assert.equal(leftLease.endpoint, rightLease.endpoint);
  leftLease.release();
  rightLease.release();
  await manager.shutdown();
}

{
  const { manager, servers } = createHarness({ ready: false });
  const lease = await manager.acquire();
  assert.equal(lease.persistent, false, 'startup failure must fall back to direct app-server');
  assert.equal(servers.length, 1);
  assert.equal(manager.snapshot().running, false);
  await manager.shutdown();
}

{
  let connectionAttempts = 0;
  const { manager, servers } = createHarness({
    connect: () => {
      connectionAttempts += 1;
      return connectionAttempts > 2;
    },
    idleTimeoutMs: 60_000,
  });
  const first = await manager.acquire();
  assert.equal(first.persistent, false, 'connection failure must fall back to direct app-server');
  assert.equal(servers.length, 1);
  assert.equal(manager.snapshot().running, true, 'one transient failure may retain the server');

  const second = await manager.acquire();
  assert.equal(second.persistent, false, 'a repeated failure must keep the direct fallback');
  assert.equal(manager.snapshot().activeClients, 0);
  assert.equal(manager.snapshot().running, false, 'repeated failures must recycle the bad endpoint');
  assert.equal(servers[0].signalCode, 'SIGTERM', 'the unusable server must be terminated');

  const third = await manager.acquire();
  assert.equal(third.persistent, true, 'the next turn must use a fresh persistent server');
  assert.equal(servers.length, 2, 'the recycled endpoint must not be retried');
  third.release();
  await manager.shutdown();
}

{
  let connectionAttempts = 0;
  const { manager, servers } = createHarness({
    connect: () => {
      connectionAttempts += 1;
      return connectionAttempts === 1 || connectionAttempts >= 4;
    },
    idleTimeoutMs: 60_000,
  });
  const active = await manager.acquire();
  assert.equal(active.persistent, true);
  assert.equal((await manager.acquire()).persistent, false);
  assert.equal((await manager.acquire()).persistent, false);
  assert.equal(manager.snapshot().running, true, 'recycling must wait for active clients');
  assert.equal(servers[0].signalCode, null, 'active clients must not be interrupted');

  const invalidated = await manager.acquire();
  assert.equal(invalidated.persistent, false, 'an invalidated endpoint must not be retried');
  assert.equal(connectionAttempts, 3);

  active.release();
  await delay(10);
  assert.equal(manager.snapshot().running, false, 'an invalidated server must recycle when idle');
  const replacement = await manager.acquire();
  assert.equal(replacement.persistent, true);
  assert.equal(servers.length, 2);
  replacement.release();
  await manager.shutdown();
}

{
  const { manager, servers } = createHarness();
  const lease = await manager.acquire();
  lease.release();
  await manager.shutdown();
  const afterShutdown = await manager.acquire();
  assert.equal(afterShutdown.persistent, false, 'shutdown must permanently disable restarts');
  assert.equal(servers.length, 1);
}

{
  const { manager, servers } = createHarness({ idleTimeoutMs: 5 });
  const lease = await manager.acquire();
  lease.release();
  await delay(15);
  assert.equal(servers.length, 1);
  assert.equal(manager.snapshot().running, false, 'an unused server must release its memory');
  await manager.shutdown();
}

console.log('Codex app-server manager tests passed.');
