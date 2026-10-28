// Integration test for remote control over the internet (relay) transport.
//
// Spawns a HOST and a CONTROLLER as separate node processes, exactly like
// scripts/test-remote-control.mjs does for TCP, but points them at a local
// fake relay (scripts/fake-relay-server.mjs) that implements /v1/host,
// /v1/connect and /v1/stream splicing per docs/remote-control-relay.md. It
// proves that pairing and a runTurn round-trip work over the relay exactly as
// they do over TCP, that the relay only ever carries ciphertext, and that
// 'direct' mode touches the relay zero times.
//
//   node scripts/test-remote-relay.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const role = process.env.ORION_RELAY_TEST_ROLE;

// ---------------------------------------------------------------------------
// Child roles

if (role) {
  const { register } = await import('node:module');
  register('./remote-control-loader.mjs', import.meta.url);
  const engine = await import('../src/main/remote-control.js');

  const userId = process.env.ORION_REMOTE_TEST_USER ?? 'user_test_1';
  let activeSessionUserId = userId;
  const activeSession = () =>
    activeSessionUserId
      ? { token: `test-token:${activeSessionUserId}`, user: { id: activeSessionUserId } }
      : null;
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

  // Stand-ins for the orion-next endpoints main.js calls. They count calls so
  // the direct-mode test can assert the engine never reaches for the relay.
  const relayCalls = { register: 0, ticket: 0, registeredUsers: [] };
  let markRelayTicketStarted = null;
  const relayDeps = {
    registerRelayDevice: async () => {
      relayCalls.register += 1;
      relayCalls.registeredUsers.push(activeSessionUserId);
      return { ok: true };
    },
    mintRelayTicket: async ({ role: ticketRole, machineId, signal }) => {
      relayCalls.ticket += 1;
      if (role === 'relay-api-cancel') {
        markRelayTicketStarted?.();
        return new Promise((resolve, reject) => {
          const cancel = () => reject(signal?.reason ?? new Error('cancelled'));
          if (signal?.aborted) cancel();
          else signal?.addEventListener('abort', cancel, { once: true });
        });
      }
      return {
        ticket: Buffer.from(
          JSON.stringify({ sub: activeSessionUserId ?? userId, role: ticketRole, machineId, exp: Date.now() + 120_000 })
        ).toString('base64url'),
        relayUrl: process.env.ORION_RELAY_TEST_URL,
      };
    },
  };

  const remoteAccountProofDeps = {
    createRemotePairingProof: async ({ token, challenge, machineId }) => {
      const proofUserId = String(token).startsWith('test-token:') ? String(token).slice(11) : '';
      if (!proofUserId) throw new Error('Invalid test account session.');
      return Buffer.from(JSON.stringify({ userId: proofUserId, challenge, machineId })).toString('base64url');
    },
    verifyRemotePairingProof: async ({ proof, challenge, machineId }) => {
      try {
        const payload = JSON.parse(Buffer.from(proof, 'base64url').toString('utf-8'));
        return payload.challenge === challenge && payload.machineId === machineId ? payload.userId : null;
      } catch {
        return null;
      }
    },
  };

  const fixtureThreads = [
    {
      id: 't1',
      projectId: 'p1',
      title: 'Fix the flaky test',
      status: 'idle',
      modelId: 'claude:sonnet',
      createdAt: '2026-08-01T10:00:00.000Z',
      messages: [
        { id: 'm1', role: 'user', content: 'hello from the host', ts: '2026-08-01T10:00:01.000Z' },
        { id: 'm2', role: 'agent', content: 'done', ts: '2026-08-01T10:00:05.000Z', kind: 'agent-run', status: 'done' },
      ],
    },
  ];

  if (role === 'relay-api-cancel') {
    const userData = process.env.ORION_TEST_USERDATA;
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(
      path.join(userData, 'orion-remote-control.json'),
      `${JSON.stringify({
        version: 1,
        machineId: 'relay-api-cancel-controller',
        machineName: 'Relay API cancellation controller',
        hostDevices: [],
        remoteMachines: [{
          id: 'stalled-host',
          name: 'Stalled host',
          host: null,
          port: null,
          relay: true,
          userId,
          secret: { encrypted: false, value: crypto.randomBytes(32).toString('base64') },
          pairedAt: '2026-08-03T00:00:00.000Z',
        }],
      }, null, 2)}\n`
    );
  }

  await engine.initRemoteControl({
    readSession: async () => activeSession(),
    readStoreState: async () => ({
      projects: [{ id: 'p1', name: 'orion', path: '/tmp/orion' }],
    }),
    readThreadsFile: async () => ({ threads: fixtureThreads }),
    broadcast: () => 1,
    dispatchRendererCommand: (payload) => {
      const { commandId, command } = payload;
      if (command.kind === 'runTurn') {
        engine.resolveRemoteCommand({ commandId, ok: true, threadId: command.threadId ?? 't-new' });
      } else if (command.kind === 'stopTurn') {
        engine.resolveRemoteCommand({ commandId, ok: true, threadId: command.threadId });
      }
      send({ kind: 'commandSeen', command });
      return 1;
    },
    ...remoteAccountProofDeps,
    ...relayDeps,
    getAppVersion: () => '0.0.0-test',
  });

  const waitForRelayOnline = async (timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = engine.getRemoteControlState();
      if (state.host?.relay?.online) return state;
      if (Date.now() > deadline) throw new Error('relay never came online');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  if (role === 'direct-mode') {
    // The hard requirement: in 'direct' mode nothing may reach for the relay.
    await engine.configureRemoteControl({
      enabled: true,
      allowIncoming: true,
      port: Number(process.env.ORION_RELAY_TEST_PORT),
      connectionMode: 'direct',
    });
    const state = engine.getRemoteControlState();
    const pairing = engine.startRemotePairing();
    // Pairing by machine id must be refused outright rather than quietly
    // falling back to the relay.
    const byMachineId = await engine.pairWithRemoteHost({
      machineId: crypto.randomUUID(),
      code: 'ABCD-EFGH-JKMN-PQRS',
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    engine.shutdownRemoteControl();
    send({ kind: 'directMode', state, pairing, byMachineId, relayCalls });
    process.exit(0);
  }

  if (role === 'relay-api-cancel') {
    const enabledSettings = {
      enabled: true,
      allowIncoming: false,
      port: 47_902,
      connectionMode: 'relay',
    };
    const disabledSettings = { ...enabledSettings, enabled: false };
    await engine.configureRemoteControl(enabledSettings);

    let ticketStarted = new Promise((resolve) => {
      markRelayTicketStarted = resolve;
    });
    const connection = engine.connectRemoteMachine({ machineId: 'stalled-host' });
    await ticketStarted;
    await engine.configureRemoteControl(disabledSettings);
    const connectionResult = await connection;

    await engine.configureRemoteControl(enabledSettings);
    ticketStarted = new Promise((resolve) => {
      markRelayTicketStarted = resolve;
    });
    const pairing = engine.pairWithRemoteHost({
      machineId: 'another-stalled-host',
      code: 'ABCD-EFGH-JKMN-PQRS',
    });
    await ticketStarted;
    await engine.configureRemoteControl(disabledSettings);
    const pairingResult = await pairing;

    engine.shutdownRemoteControl();
    send({ kind: 'relayApiCancelled', connectionResult, pairingResult, relayCalls });
    process.exit(0);
  }

  if (role === 'relay-reregister') {
    await engine.configureRemoteControl({
      enabled: true,
      allowIncoming: true,
      port: Number(process.env.ORION_RELAY_TEST_PORT),
      connectionMode: 'relay',
    });
    await waitForRelayOnline();
    activeSessionUserId = null;
    engine.notifyRemoteControlAccountChanged(null);
    activeSessionUserId = userId;
    engine.notifyRemoteControlAccountChanged(activeSession());
    await waitForRelayOnline();
    engine.shutdownRemoteControl();
    send({ kind: 'relayReregistered', relayCalls });
    process.exit(0);
  }

  if (role === 'host') {
    await engine.configureRemoteControl({
      enabled: true,
      allowIncoming: true,
      port: Number(process.env.ORION_RELAY_TEST_PORT),
      connectionMode: 'relay',
    });
    const online = await waitForRelayOnline();
    const pairing = engine.startRemotePairing();
    assert.equal(pairing.ok, true, `pairing should start: ${pairing.error}`);
    send({ kind: 'ready', code: pairing.code, machineId: online.machineId });
    process.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        const command = line.trim();
        if (command === 'state') send({ kind: 'state', state: engine.getRemoteControlState(), relayCalls });
        if (command === 'await-online') {
          void waitForRelayOnline(20_000).then(
            (state) => send({ kind: 'online', state }),
            (error) => send({ kind: 'online', error: error.message })
          );
        }
        if (command === 'pair-again') {
          const next = engine.startRemotePairing();
          send({ kind: 'ready', code: next.code, machineId: engine.getRemoteControlState().machineId });
        }
        if (command === 'direct') {
          void engine.configureRemoteControl({
            enabled: true,
            allowIncoming: true,
            port: Number(process.env.ORION_RELAY_TEST_PORT),
            connectionMode: 'direct',
          }).then(() => send({ kind: 'hostDirect', state: engine.getRemoteControlState() }));
        }
        if (command === 'exit') process.exit(0);
      }
    });
  } else if (role === 'controller') {
    // No listener of its own — a pure controller, reaching the host by id.
    await engine.configureRemoteControl({
      enabled: true,
      allowIncoming: false,
      port: 47_902,
      connectionMode: 'relay',
    });
    const hostMachineId = process.env.ORION_RELAY_TEST_HOST_ID;
    const code = process.env.ORION_RELAY_TEST_CODE;
    const results = {};

    results.wrongCode = await engine.pairWithRemoteHost({
      machineId: hostMachineId,
      code: 'AAAA-BBBB-CCCC-DDDD',
    });
    results.unknownMachine = await engine.pairWithRemoteHost({
      machineId: crypto.randomUUID(),
      code,
    });
    results.pair = await engine.pairWithRemoteHost({ machineId: hostMachineId, code });
    results.snapshot = await engine.fetchRemoteSnapshot({ machineId: results.pair.machine?.id });
    results.thread = await engine.fetchRemoteThread({ machineId: results.pair.machine?.id, threadId: 't1' });
    results.runTurn = await engine.runRemoteTurn({
      machineId: results.pair.machine?.id,
      projectId: 'p1',
      prompt: 'build the thing over the internet',
    });
    results.continueTurn = await engine.runRemoteTurn({
      machineId: results.pair.machine?.id,
      threadId: 't1',
      prompt: 'keep going',
    });
    results.stopTurn = await engine.stopRemoteTurn({ machineId: results.pair.machine?.id, threadId: 't1' });
    results.state = engine.getRemoteControlState();
    results.persisted = JSON.parse(
      fs.readFileSync(path.join(process.env.ORION_TEST_USERDATA, 'orion-remote-control.json'), 'utf-8')
    );
    send({ kind: 'results', results, relayCalls });
    process.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        const command = line.trim();
        if (command === 'direct') {
          void engine.configureRemoteControl({
            enabled: true,
            allowIncoming: false,
            port: 47_902,
            connectionMode: 'direct',
          }).then(() => send({ kind: 'controllerDirect', state: engine.getRemoteControlState() }));
        }
        if (command === 'relay') {
          void engine.configureRemoteControl({
            enabled: true,
            allowIncoming: false,
            port: 47_902,
            connectionMode: 'relay',
          }).then(async () => {
            const snapshot = await engine.fetchRemoteSnapshot({ machineId: hostMachineId });
            send({ kind: 'controllerReconnected', snapshot, state: engine.getRemoteControlState() });
          });
        }
        if (command === 'state') send({ kind: 'controllerState', state: engine.getRemoteControlState() });
        if (command === 'await-offline') {
          void (async () => {
            const deadline = Date.now() + 5000;
            for (;;) {
              const state = engine.getRemoteControlState();
              if (state.machines[0]?.status === 'offline' || Date.now() > deadline) {
                send({ kind: 'controllerOffline', state });
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          })();
        }
        if (command === 'exit') process.exit(0);
      }
    });
    await new Promise(() => {});
  }
} else {
  // -------------------------------------------------------------------------
  // Parent orchestrator

  const { startFakeRelay } = await import('./fake-relay-server.mjs');

  // Both native transports must terminate a peer whose pending write buffer
  // crosses the cap. Otherwise streamed turn events can accumulate forever
  // when a controller stops reading.
  {
    const { createRelayTransport, wrapTcpSocket } = await import('../src/main/remote-transport.js');
    class MockTcpSocket extends EventEmitter {
      connecting = false;
      destroyed = false;
      writableLength = 24;
      setNoDelay() {}
      write() {
        throw new Error('an over-limit TCP write must not reach the socket');
      }
      destroy(error) {
        this.destroyed = true;
        this.emit('error', error);
        this.emit('close');
      }
      end() {}
      setTimeout() {}
    }
    const tcpSocket = new MockTcpSocket();
    const tcpErrors = [];
    const tcp = wrapTcpSocket(tcpSocket, { maxPendingWriteBytes: 32 });
    tcp.onClose((error) => {
      if (error) tcpErrors.push(error);
    });
    assert.equal(tcp.write(Buffer.alloc(9)), false);
    assert.equal(tcpSocket.destroyed, true);
    assert.match(tcpErrors[0]?.message ?? '', /not reading data/i);

    const originalWebSocket = globalThis.WebSocket;
    const sockets = [];
    class SlowWebSocket {
      constructor(url, options) {
        this.url = url;
        this.options = options;
        this.readyState = 0;
        this.bufferedAmount = 24;
        this.listeners = new Map();
        this.sent = 0;
        sockets.push(this);
      }
      addEventListener(type, handler) {
        const handlers = this.listeners.get(type) ?? [];
        handlers.push(handler);
        this.listeners.set(type, handlers);
      }
      emit(type, event = {}) {
        for (const handler of this.listeners.get(type) ?? []) handler(event);
      }
      send() {
        this.sent += 1;
      }
      close() {
        this.readyState = 3;
        this.emit('close', { code: 1000 });
      }
    }
    globalThis.WebSocket = SlowWebSocket;
    try {
      const relay = createRelayTransport({
        relayUrl: 'ws://slow.test',
        ticket: 'ticket',
        machineId: 'machine',
        maxPendingWriteBytes: 32,
      });
      assert.equal(
        sockets[0].options?.dispatcher?.webSocketOptions?.maxPayloadSize,
        4 + 8 * 1024 * 1024,
        'relay data messages must be capped in the WebSocket parser'
      );
      let relayError = null;
      relay.onClose((error) => {
        relayError = error;
      });
      sockets[0].readyState = 1;
      sockets[0].emit('open');
      assert.equal(relay.write(Buffer.alloc(9)), false);
      assert.equal(sockets[0].sent, 0);
      assert.match(relayError?.message ?? '', /not reading data/i);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
    console.log('ok  slow TCP and relay peers cannot grow pending writes without bound');
  }

  // A relay can ignore the WebSocket closing handshake indefinitely. Data
  // transports own one dispatcher each so graceful-close expiry and destroy()
  // can abort the underlying Undici connection, not just release the wrapper.
  {
    const { createRelayTransport } = await import('../src/main/remote-transport.js');
    const originalWebSocket = globalThis.WebSocket;
    const sockets = [];
    class StubbornWebSocket {
      constructor(url, options) {
        this.url = url;
        this.options = options;
        this.readyState = 0;
        this.listeners = new Map();
        this.closeCalls = 0;
        sockets.push(this);
      }
      addEventListener(type, handler) {
        const handlers = this.listeners.get(type) ?? [];
        handlers.push(handler);
        this.listeners.set(type, handlers);
      }
      emit(type, event = {}) {
        for (const handler of this.listeners.get(type) ?? []) handler(event);
      }
      send() {}
      close() {
        this.closeCalls += 1;
        this.readyState = 2;
        // Deliberately never emit close: this relay ignores the handshake.
      }
    }
    globalThis.WebSocket = StubbornWebSocket;
    try {
      const graceful = createRelayTransport({
        relayUrl: 'ws://stubborn.test',
        ticket: 'ticket-a',
        machineId: 'machine-a',
        closeGraceMs: 8,
      });
      let gracefulCloses = 0;
      graceful.onClose(() => {
        gracefulCloses += 1;
      });
      sockets[0].readyState = 1;
      sockets[0].emit('open');
      graceful.close();
      assert.equal(sockets[0].options.dispatcher.destroyed, false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sockets[0].options.dispatcher.destroyed, true);
      assert.equal(gracefulCloses, 1);

      const forced = createRelayTransport({
        relayUrl: 'ws://stubborn.test',
        ticket: 'ticket-b',
        machineId: 'machine-b',
      });
      let forcedError = null;
      forced.onClose((error) => {
        forcedError = error;
      });
      sockets[1].readyState = 1;
      sockets[1].emit('open');
      forced.destroy(new Error('forced teardown'));
      assert.equal(sockets[1].options.dispatcher.destroyed, true);
      assert.match(forcedError?.message ?? '', /forced teardown/i);
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
    console.log('ok  relay data sockets cap parser payloads and abort ignored closes');
  }

  // The relay API deadline owns both the header wait and body read, while a
  // separate lifecycle signal can end the same request immediately.
  {
    const { fetchRelayApiJson } = await import('../src/main/remote-api.js');
    let timeoutSignal = null;
    const keepAlive = setTimeout(() => {}, 50);
    try {
      await assert.rejects(
        fetchRelayApiJson({
          url: new URL('https://cloud.invalid/relay'),
          token: 'token',
          body: {},
          timeoutMs: 8,
          fetchImpl: (_url, { signal }) => {
            timeoutSignal = signal;
            return {
              json: () =>
                new Promise((resolve, reject) => {
                  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                }),
            };
          },
        }),
        /in time/i
      );
    } finally {
      clearTimeout(keepAlive);
    }
    assert.equal(timeoutSignal?.aborted, true);

    const lifecycle = new AbortController();
    const cancelled = fetchRelayApiJson({
      url: new URL('https://cloud.invalid/relay'),
      token: 'token',
      body: {},
      signal: lifecycle.signal,
      timeoutMs: 1000,
      fetchImpl: (_url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    });
    lifecycle.abort(new Error('test lifecycle ended'));
    await assert.rejects(cancelled, /cancelled/i);
    console.log('ok  relay API requests time out and honor lifecycle cancellation');
  }

  // Pairing-proof POST/PUT calls have the same bounded lifecycle, including a
  // stalled response body after headers have arrived.
  {
    const { fetchRemotePairingProofJson } = await import('../src/main/remote-api.js');
    let requestOptions = null;
    const keepAlive = setTimeout(() => {}, 50);
    try {
      await assert.rejects(
        fetchRemotePairingProofJson({
          url: new URL('https://cloud.invalid/remote-pairing-proof'),
          method: 'POST',
          token: 'desktop-token',
          body: { challenge: 'challenge', machineId: 'machine' },
          timeoutMs: 8,
          fetchImpl: async (_url, options) => {
            requestOptions = options;
            return {
              ok: true,
              json: () =>
                new Promise((resolve, reject) => {
                  options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                }),
            };
          },
        }),
        /in time/i
      );
    } finally {
      clearTimeout(keepAlive);
    }
    assert.equal(requestOptions?.method, 'POST');
    assert.equal(requestOptions?.headers?.authorization, 'Bearer desktop-token');
    assert.equal(requestOptions?.signal?.aborted, true);

    const lifecycle = new AbortController();
    const cancelled = fetchRemotePairingProofJson({
      url: new URL('https://cloud.invalid/remote-pairing-proof'),
      method: 'PUT',
      body: { proof: 'proof' },
      signal: lifecycle.signal,
      timeoutMs: 1000,
      fetchImpl: (_url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    });
    lifecycle.abort(new Error('test pairing lifecycle ended'));
    await assert.rejects(cancelled, /cancelled/i);
    console.log('ok  pairing-proof requests time out and honor lifecycle cancellation');
  }

  // A relay can send many dials synchronously while ticket minting is still
  // pending. The listener must reserve those slots before awaiting the API.
  {
    const { createRelayListener } = await import('../src/main/remote-transport.js');
    const originalWebSocket = globalThis.WebSocket;
    const sockets = [];
    class MockWebSocket {
      constructor(url, options) {
        this.url = url;
        this.options = options;
        this.readyState = 0;
        this.listeners = new Map();
        sockets.push(this);
      }
      addEventListener(type, handler) {
        const handlers = this.listeners.get(type) ?? [];
        handlers.push(handler);
        this.listeners.set(type, handlers);
      }
      emit(type, event = {}) {
        for (const handler of this.listeners.get(type) ?? []) handler(event);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    const pendingTickets = [];
    let ticketCalls = 0;
    let listener = null;
    try {
      globalThis.WebSocket = MockWebSocket;
      listener = createRelayListener({
        relayUrl: 'ws://fallback.invalid',
        getTicket: async () => {
          ticketCalls += 1;
          if (ticketCalls === 1) {
            return { ticket: 'control-ticket', relayUrl: 'ws://ticket-control.test/base' };
          }
          return new Promise((resolve, reject) => pendingTickets.push({ resolve, reject }));
        },
        onStream: () => {},
      });
      listener.start();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(sockets.length, 1, 'the control socket should be created');
      assert.match(sockets[0].url, /^ws:\/\/ticket-control\.test\/base\/v1\/host\?/);
      assert.equal(
        sockets[0].options?.dispatcher?.webSocketOptions?.maxPayloadSize,
        4096,
        'the control WebSocket parser must cap messages before allocating them'
      );
      sockets[0].emit('open');
      for (let index = 0; index < 100; index += 1) {
        sockets[0].emit('message', {
          data: JSON.stringify({ t: 'dial', streamId: `hostile-${index}` }),
        });
      }
      assert.equal(ticketCalls, 13, 'only twelve stream tickets may be pending at once');
      assert.equal(pendingTickets.length, 12);

      for (const pending of pendingTickets.splice(0)) pending.reject(new Error('test rejection'));
      await new Promise((resolve) => setImmediate(resolve));
      sockets[0].emit('message', { data: JSON.stringify({ t: 'dial', streamId: 'after-failure' }) });
      assert.equal(ticketCalls, 14, 'failed ticket requests must release their slots');
      pendingTickets.shift().resolve({ ticket: 'stream-ticket', relayUrl: 'ws://ticket-stream.test/prefix' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(sockets.length, 2, 'a later dial may open after failed reservations are released');
      assert.match(sockets[1].url, /^ws:\/\/ticket-stream\.test\/prefix\/v1\/stream\?/);
      sockets[0].emit('message', { data: '{not-json' });
      assert.equal(sockets[0].readyState, 3, 'malformed control input must close the control socket');
      console.log('ok  relay dial floods cannot exceed the pending stream cap');
    } finally {
      listener?.stop();
      globalThis.WebSocket = originalWebSocket;
    }
  }

  // A control WebSocket that never completes its upgrade must be retired by an
  // app-owned deadline so its stale reference cannot suppress reconnection.
  {
    const { createRelayListener } = await import('../src/main/remote-transport.js');
    const originalWebSocket = globalThis.WebSocket;
    const sockets = [];
    class StalledWebSocket {
      constructor() {
        this.readyState = 0;
        this.listeners = new Map();
        sockets.push(this);
      }
      addEventListener(type, handler) {
        const handlers = this.listeners.get(type) ?? [];
        handlers.push(handler);
        this.listeners.set(type, handlers);
      }
      close() {
        this.readyState = 3;
      }
    }
    let listener = null;
    try {
      globalThis.WebSocket = StalledWebSocket;
      listener = createRelayListener({
        relayUrl: 'ws://stalled.test',
        getTicket: async () => ({ ticket: 'ticket', relayUrl: 'ws://stalled.test' }),
        onStream: () => {},
        openTimeoutMs: 8,
        reconnectBaseMs: 4,
        reconnectMaxMs: 4,
      });
      listener.start();
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(sockets[0].readyState, 3, 'the stalled control attempt must be closed');
      assert.ok(sockets.length >= 2, 'clearing the exact stalled socket must allow a reconnect');
      console.log('ok  stalled relay control upgrades time out and reconnect');
    } finally {
      listener?.stop();
      globalThis.WebSocket = originalWebSocket;
    }
  }

  // A relay that accepts control sockets only to reject them immediately must
  // retain exponential backoff. Merely reaching `open` is not evidence that the
  // connection is healthy, or every retry would reset to the shortest delay.
  {
    const { createRelayListener } = await import('../src/main/remote-transport.js');
    const originalWebSocket = globalThis.WebSocket;
    const sockets = [];
    class RejectingWebSocket {
      constructor() {
        this.readyState = 0;
        this.listeners = new Map();
        sockets.push(this);
        setImmediate(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          this.emit('open');
          setImmediate(() => {
            if (this.readyState === 1) {
              this.emit('message', { data: JSON.stringify({ t: 'unsupported' }) });
            }
          });
        });
      }
      addEventListener(type, handler) {
        const handlers = this.listeners.get(type) ?? [];
        handlers.push(handler);
        this.listeners.set(type, handlers);
      }
      emit(type, event = {}) {
        for (const handler of this.listeners.get(type) ?? []) handler(event);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    let listener = null;
    let ticketCalls = 0;
    try {
      globalThis.WebSocket = RejectingWebSocket;
      listener = createRelayListener({
        relayUrl: 'ws://rejecting.test',
        getTicket: async () => {
          ticketCalls += 1;
          return { ticket: `ticket-${ticketCalls}`, relayUrl: 'ws://rejecting.test' };
        },
        onStream: () => {},
        healthyConnectionMs: 1000,
        reconnectBaseMs: 8,
        reconnectMaxMs: 64,
        reconnectRandom: () => 0,
      });
      listener.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(ticketCalls >= 2, 'the listener should retry rejected control sockets');
      assert.ok(ticketCalls <= 7, 'short-lived control sockets must retain exponential backoff');
      assert.equal(sockets.length, ticketCalls);
      console.log('ok  short-lived relay control sockets retain exponential backoff');
    } finally {
      listener?.stop();
      globalThis.WebSocket = originalWebSocket;
    }
  }

  // Listener teardown owns ticket API requests too, including the initial
  // request that happens before a control WebSocket exists.
  {
    const { createRelayListener } = await import('../src/main/remote-transport.js');
    let ticketSignal = null;
    const listener = createRelayListener({
      relayUrl: 'ws://cancelled.test',
      getTicket: (_role, { signal }) => {
        ticketSignal = signal;
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      onStream: () => {},
    });
    listener.start();
    await new Promise((resolve) => setImmediate(resolve));
    listener.stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ticketSignal?.aborted, true);
    console.log('ok  stopping the relay listener aborts pending ticket requests');
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-relay-test-'));
  const basePort = 47_600 + crypto.randomInt(300);

  const children = new Set();
  const killChildren = () => {
    for (const child of children) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
    children.clear();
  };
  process.on('exit', killChildren);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      killChildren();
      process.exit(1);
    });
  }
  process.on('uncaughtException', (error) => {
    killChildren();
    console.error(error);
    process.exit(1);
  });

  // Short ping interval so the pong path is exercised inside the test's life —
  // the whole flow runs in well under a second against a loopback relay.
  const relay = await startFakeRelay({ pingIntervalMs: 60 });

  const waitUntil = async (predicate, description, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const spawnRole = (childRole, extraEnv) => {
    const child = spawn(process.execPath, [selfPath], {
      env: {
        ...process.env,
        ORION_RELAY_TEST_ROLE: childRole,
        ORION_RELAY_TEST_URL: relay.url,
        ORION_TEST_USERDATA: path.join(tmpRoot, extraEnv?.ORION_TEST_USERDATA_NAME ?? childRole),
        ORION_RELAY_TEST_PORT: String(basePort),
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    children.add(child);
    child.on('exit', () => children.delete(child));
    const listeners = new Set();
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        for (const listener of [...listeners]) listener(message);
      }
    });
    const waitFor = (kind, timeoutMs = 20_000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${kind}`)), timeoutMs);
        const listener = (message) => {
          if (message.kind !== kind) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(message);
        };
        listeners.add(listener);
      });
    return { child, waitFor, send: (line) => child.stdin.write(`${line}\n`) };
  };

  {
    const cancelled = spawnRole('relay-api-cancel');
    const result = await cancelled.waitFor('relayApiCancelled');
    assert.equal(result.connectionResult.ok, false);
    assert.match(result.connectionResult.error, /cancel|off|disabled/i);
    assert.equal(result.pairingResult.ok, false);
    assert.match(result.pairingResult.error, /cancel|off|disabled/i);
    assert.equal(result.relayCalls.ticket, 2);
    console.log('ok  disabling remote control aborts stalled relay API requests');
  }

  {
    const reregistered = spawnRole('relay-reregister', {
      ORION_RELAY_TEST_PORT: String(basePort + 2),
    });
    const result = await reregistered.waitFor('relayReregistered');
    assert.equal(result.relayCalls.register, 2);
    assert.deepEqual(result.relayCalls.registeredUsers, ['user_test_1', 'user_test_1']);
    console.log('ok  signing back in re-registers relay presence for the account');
  }

  // 1. 'direct' must be inert with respect to the relay: no registration, no
  // ticket, no socket. This is the whole promise of the default mode.
  {
    const upgradesBeforeDirect = relay.stats.upgrades;
    const direct = spawnRole('direct-mode', {
      ORION_RELAY_TEST_PORT: String(basePort + 1),
    });
    const result = await direct.waitFor('directMode');
    assert.equal(result.state.host.listening, true, 'direct mode still listens locally');
    assert.equal(result.state.connectionMode, 'direct');
    assert.equal(result.state.host.relay.enabled, false);
    assert.equal(result.state.host.relay.online, false);
    assert.equal(result.pairing.ok, true);
    assert.equal(result.byMachineId.ok, false);
    assert.match(result.byMachineId.error, /Over the internet/i);
    assert.equal(result.relayCalls.register, 0, 'direct mode must not register with the relay');
    assert.equal(result.relayCalls.ticket, 0, 'direct mode must not mint relay tickets');
    assert.equal(relay.stats.upgrades, upgradesBeforeDirect, 'direct mode must not open a relay socket');
    console.log('ok  direct mode makes zero relay calls');
  }

  const hostSocketsBeforeHost = relay.stats.hostSockets;
  const host = spawnRole('host');
  const ready = await host.waitFor('ready');
  assert.match(ready.code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.equal(relay.stats.hostSockets, hostSocketsBeforeHost + 1, 'the host opens one control socket');
  console.log('ok  host registers and holds the relay control socket');

  // 2. The full flow, addressed by machine id instead of host:port.
  let controller;
  {
    controller = spawnRole('controller', {
      ORION_RELAY_TEST_HOST_ID: ready.machineId,
      ORION_RELAY_TEST_CODE: ready.code,
    });
    const commandSeen = host.waitFor('commandSeen');
    const { results } = await controller.waitFor('results', 45_000);

    assert.equal(results.wrongCode.ok, false, 'a wrong code must fail over the relay too');
    assert.equal(results.unknownMachine.ok, false, 'an unregistered machine id must fail');
    assert.equal(results.pair.ok, true, `relay pairing failed: ${results.pair.error}`);
    assert.equal(results.pair.machine.id, ready.machineId);
    assert.equal(results.snapshot.ok, true, `snapshot failed: ${results.snapshot.error}`);
    assert.equal(results.snapshot.snapshot.projects.length, 1);
    assert.equal(results.snapshot.snapshot.threads.length, 1);
    assert.equal(results.thread.ok, true);
    assert.equal(results.thread.thread.messages.length, 2);
    assert.equal(results.runTurn.ok, true, `runTurn failed: ${results.runTurn.error}`);
    assert.equal(results.runTurn.threadId, 't-new');
    assert.equal(results.continueTurn.threadId, 't1');
    assert.equal(results.stopTurn.ok, true, `stopTurn failed: ${results.stopTurn.error}`);
    assert.equal(results.state.machines.length, 1);
    assert.equal(results.state.machines[0].status, 'connected');
    assert.equal(results.state.machines[0].relay, true);
    assert.equal(results.state.machines[0].host, null, 'a relay-paired machine has no address');
    assert.equal(results.persisted.remoteMachines[0].relay, true);
    assert.equal(results.persisted.remoteMachines[0].host, null);

    const seen = await commandSeen;
    assert.equal(seen.command.kind, 'runTurn');
    assert.equal(seen.command.prompt, 'build the thing over the internet');
    console.log('ok  pair + snapshot + thread + runTurn/stopTurn round trip over the relay');
  }

  // 3. The relay carried the bytes and understood none of them.
  {
    assert.ok(relay.stats.spliced >= 2, `expected several spliced streams, got ${relay.stats.spliced}`);
    assert.ok(relay.forwarded.length > 0, 'the relay should have carried traffic');
    const carried = Buffer.concat(relay.forwarded.map((entry) => entry.bytes));
    for (const secret of ['build the thing over the internet', 'runTurn', 'snapshot', 'Fix the flaky test', ready.code]) {
      assert.equal(carried.includes(Buffer.from(secret, 'utf-8')), false, `relay saw plaintext: ${secret}`);
    }
    // The handshake frames are plaintext by design (ephemeral public keys and
    // nonces only) — everything after `confirm` must not be.
    assert.ok(carried.includes(Buffer.from('helloAck', 'utf-8')), 'handshake frames do cross the relay');
    console.log('ok  the relay carries ciphertext only');
  }

  // 4. Presence survives a relay restart: the control socket reconnects on its
  // own, with backoff, and the machine becomes reachable again.
  {
    await waitUntil(() => relay.stats.pongs > 0, 'the host to answer a relay ping');
    const before = relay.stats.hostSockets;
    relay.dropAll();
    await waitUntil(
      () => relay.stats.hostSockets > before,
      'the host to open a new control socket after the relay drop',
      30_000
    );
    host.send('await-online');
    const online = await host.waitFor('online', 30_000);
    assert.equal(online.error, undefined, `host did not come back online: ${online.error}`);
    assert.equal(online.state.host.relay.online, true);
    assert.ok(relay.stats.hostSockets > before, 'the host reconnected its control socket');
    console.log('ok  the host answers relay pings and reconnects after the relay drops');
  }

  // 5. Turning internet mode off releases handed-off data sessions too, on
  // both the controller and host sides — not just the host control listener.
  {
    controller.send('direct');
    const controllerDirect = await controller.waitFor('controllerDirect');
    assert.equal(controllerDirect.state.connectionMode, 'direct');
    assert.equal(controllerDirect.state.machines[0].status, 'offline');
    assert.equal(controllerDirect.state.host.relay.enabled, false);

    controller.send('relay');
    const reconnected = await controller.waitFor('controllerReconnected');
    assert.equal(reconnected.snapshot.ok, true, `relay reconnect failed: ${reconnected.snapshot.error}`);
    assert.equal(reconnected.state.machines[0].status, 'connected');

    host.send('direct');
    const hostDirect = await host.waitFor('hostDirect');
    assert.equal(hostDirect.state.connectionMode, 'direct');
    assert.equal(hostDirect.state.host.relay.enabled, false);
    assert.equal(hostDirect.state.host.devices.length, 1, 'pairing remains recorded');
    assert.equal(hostDirect.state.host.devices[0].connected, false, 'relay inbound session must be closed');
    controller.send('await-offline');
    const controllerAfterHostOptOut = await controller.waitFor('controllerOffline');
    assert.equal(controllerAfterHostOptOut.state.machines[0].status, 'offline');
    console.log('ok  switching to network-only mode tears down relay data sessions');
  }

  controller.send('exit');
  host.send('exit');
  await relay.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('All remote-relay integration tests passed.');
  process.exit(0);
}
