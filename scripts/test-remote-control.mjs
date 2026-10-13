// Integration test for the remote-control engine (src/main/remote-control.js):
// spawns a HOST and a CONTROLLER as separate node processes (each with its own
// stubbed electron userData, so each mints its own machine identity), then
// drives the full flow over real TCP: pairing (good + wrong code + wrong
// account), session establishment, snapshot/thread fetch, runTurn round-trip
// through the host's renderer-command bridge, and revocation.
//
//   node scripts/test-remote-control.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const role = process.env.ORION_REMOTE_TEST_ROLE;

// ---------------------------------------------------------------------------
// Child roles

if (
  role === 'host' ||
  role === 'controller' ||
  role === 'account-expiry' ||
  role === 'shutdown-race' ||
  role === 'persistence-unavailable' ||
    role === 'persistence-corrupt' ||
    role === 'persistence-race' ||
    role === 'persistence-drain' ||
    role === 'outbound-disable-race' ||
    role === 'established-disable-race' ||
    role === 'pairing-disable-race' ||
    role === 'pairing-retry-race'
) {
  const { register } = await import('node:module');
  register('./remote-control-loader.mjs', import.meta.url);
  const engine = await import('../src/main/remote-control.js');

  const userId = process.env.ORION_REMOTE_TEST_USER ?? 'user_test_1';
  const testSessionToken = `test-token:${userId}`;
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
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  let releaseBlockedPairingSave = null;

  if (role === 'host' && process.env.ORION_REMOTE_TEST_BLOCK_HOST_SAVE === '1') {
    const userData = process.env.ORION_TEST_USERDATA;
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(
      path.join(userData, 'orion-remote-control.json'),
      `${JSON.stringify({
        version: 1,
        machineId: 'pairing-save-race-host',
        machineName: 'Pairing save race host',
        hostDevices: [],
        remoteMachines: [],
      }, null, 2)}\n`
    );
    const fsPromises = (await import('node:fs/promises')).default;
    const originalRename = fsPromises.rename;
    let blocked = false;
    fsPromises.rename = async (...args) => {
      if (!blocked) {
        blocked = true;
        send({ kind: 'hostPairingSaveStarted' });
        await new Promise((resolve) => {
          releaseBlockedPairingSave = resolve;
        });
      }
      return originalRename(...args);
    };
  }

  if (role === 'persistence-race') {
    const userData = process.env.ORION_TEST_USERDATA;
    const statePath = path.join(userData, 'orion-remote-control.json');
    fs.mkdirSync(userData, { recursive: true });
    const device = (id) => ({
      id,
      name: id,
      userId,
      secret: { encrypted: false, value: crypto.randomBytes(32).toString('base64') },
      pairedAt: '2026-08-01T00:00:00.000Z',
      lastSeenAt: null,
    });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        machineId: 'persistence-race-host',
        machineName: 'Persistence race host',
        hostDevices: [device('device-a'), device('device-b')],
        remoteMachines: [],
      }, null, 2)}\n`
    );
    const fsPromises = (await import('node:fs/promises')).default;
    const originalRename = fsPromises.rename;
    let releaseFirstRename;
    const firstRenameBlocked = new Promise((resolve) => {
      releaseFirstRename = resolve;
    });
    let markFirstRenameStarted;
    const firstRenameStarted = new Promise((resolve) => {
      markFirstRenameStarted = resolve;
    });
    let renameCalls = 0;
    fsPromises.rename = async (...args) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        markFirstRenameStarted();
        await firstRenameBlocked;
        const error = new Error('simulated transient rename failure');
        error.code = 'EIO';
        throw error;
      }
      return originalRename(...args);
    };
    try {
      await engine.initRemoteControl({
        readSession: async () => ({ token: testSessionToken, user: { id: userId } }),
        readStoreState: async () => ({}),
        readThreadsFile: async () => ({ threads: [] }),
        broadcast: () => 0,
        dispatchRendererCommand: () => 0,
        ...remoteAccountProofDeps,
        getAppVersion: () => '0.0.0-test',
      });
      const first = engine.revokeRemoteDevice({ deviceId: 'device-a' });
      await firstRenameStarted;
      const second = engine.revokeRemoteDevice({ deviceId: 'device-b' });
      releaseFirstRename();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      const state = engine.getRemoteControlState();
      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      send({ kind: 'persistenceRace', firstResult, secondResult, state, persisted });
    } finally {
      fsPromises.rename = originalRename;
    }
    process.exit(0);
  }

  if (role === 'persistence-drain') {
    const userData = process.env.ORION_TEST_USERDATA;
    const statePath = path.join(userData, 'orion-remote-control.json');
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        machineId: 'persistence-drain-host',
        machineName: 'Persistence drain host',
        hostDevices: ['device-a', 'device-b'].map((id) => ({
          id,
          name: id,
          userId,
          secret: { encrypted: false, value: crypto.randomBytes(32).toString('base64') },
          pairedAt: '2026-08-03T00:00:00.000Z',
          lastSeenAt: null,
        })),
        remoteMachines: [{
          id: 'machine-a',
          name: 'Machine A',
          host: '127.0.0.1',
          port: 47902,
          userId,
          secret: { encrypted: false, value: crypto.randomBytes(32).toString('base64') },
          pairedAt: '2026-08-03T00:00:00.000Z',
        }],
      }, null, 2)}\n`
    );
    const fsPromises = (await import('node:fs/promises')).default;
    const originalRename = fsPromises.rename;
    let releaseRename;
    let markRenameStarted;
    const renameStarted = new Promise((resolve) => {
      markRenameStarted = resolve;
    });
    fsPromises.rename = async (...args) => {
      markRenameStarted();
      await new Promise((resolve) => {
        releaseRename = resolve;
      });
      return originalRename(...args);
    };
    try {
      await engine.initRemoteControl({
        readSession: async () => ({ token: testSessionToken, user: { id: userId } }),
        readStoreState: async () => ({}),
        readThreadsFile: async () => ({ threads: [] }),
        broadcast: () => 0,
        dispatchRendererCommand: () => 0,
        ...remoteAccountProofDeps,
        getAppVersion: () => '0.0.0-test',
      });
      const revoke = engine.revokeRemoteDevice({ deviceId: 'device-a' });
      await renameStarted;
      engine.shutdownRemoteControl();
      let drained = false;
      const drain = engine.waitForRemoteControlPersistence().then(() => {
        drained = true;
      });
      const lateRevoke = engine.revokeRemoteDevice({ deviceId: 'device-b' });
      const lateRemove = engine.removeRemoteMachine({ machineId: 'machine-a' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const drainedBeforeWrite = drained;
      releaseRename();
      const [revokeResult, lateRevokeResult, lateRemoveResult] = await Promise.all([
        revoke,
        lateRevoke,
        lateRemove,
        drain,
      ]);
      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      send({
        kind: 'persistenceDrain',
        drainedBeforeWrite,
        revokeResult,
        lateRevokeResult,
        lateRemoveResult,
        persisted,
      });
    } finally {
      fsPromises.rename = originalRename;
    }
    process.exit(0);
  }

  if (role === 'account-expiry') {
    const expiresAt = new Date(Date.now() + 700).toISOString();
    await engine.initRemoteControl({
      readSession: async () => ({ token: testSessionToken, user: { id: userId }, expiresAt }),
      readStoreState: async () => ({}),
      readThreadsFile: async () => ({ threads: [] }),
      broadcast: () => 0,
      dispatchRendererCommand: () => 0,
      ...remoteAccountProofDeps,
      getAppVersion: () => '0.0.0-test',
    });
    await engine.configureRemoteControl({
      enabled: true,
      allowIncoming: true,
      port: Number(process.env.ORION_REMOTE_TEST_PORT),
    });
    const before = engine.getRemoteControlState();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const after = engine.getRemoteControlState();
    engine.shutdownRemoteControl();
    send({ kind: 'accountExpiry', before, after });
    process.exit(0);
  }

  if (role === 'shutdown-race') {
    let sessionReadCount = 0;
    let releaseRefresh;
    const refreshStarted = new Promise((resolve) => {
      releaseRefresh = () => resolve({ token: testSessionToken, user: { id: userId } });
    });
    let markRefreshStarted;
    const refreshIsPending = new Promise((resolve) => {
      markRefreshStarted = resolve;
    });
    await engine.initRemoteControl({
      readSession: async () => {
        sessionReadCount += 1;
        if (sessionReadCount === 1) return { token: testSessionToken, user: { id: userId } };
        markRefreshStarted();
        return refreshStarted;
      },
      readStoreState: async () => ({}),
      readThreadsFile: async () => ({ threads: [] }),
      broadcast: () => {},
      dispatchRendererCommand: () => 0,
      ...remoteAccountProofDeps,
      getAppVersion: () => '0.0.0-test',
    });
    const configuring = engine.configureRemoteControl({
      enabled: true,
      allowIncoming: true,
      port: Number(process.env.ORION_REMOTE_TEST_PORT),
    });
    await refreshIsPending;
    engine.shutdownRemoteControl();
    releaseRefresh();
    await configuring;
    send({ kind: 'shutdownRace', state: engine.getRemoteControlState() });
    process.exit(0);
  }

  if (role === 'persistence-unavailable') {
    const userData = process.env.ORION_TEST_USERDATA;
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(
      path.join(userData, 'orion-remote-control.json'),
      `${JSON.stringify({
        version: 1,
        machineId: 'packaged-machine',
        machineName: 'Packaged machine',
        hostDevices: [{
          id: 'controller-1',
          name: 'Controller',
          userId,
          secret: { encrypted: false, value: crypto.randomBytes(32).toString('base64') },
          pairedAt: '2026-08-01T00:00:00.000Z',
          lastSeenAt: null,
        }],
        remoteMachines: [{
          id: 'host-1',
          name: 'Host',
          host: '127.0.0.1',
          port: 47615,
          userId,
          secret: { encrypted: false, value: crypto.randomBytes(32).toString('base64') },
          pairedAt: '2026-08-01T00:00:00.000Z',
        }],
      }, null, 2)}\n`
    );
    await engine.initRemoteControl({
      readSession: async () => ({ token: testSessionToken, user: { id: userId } }),
      readStoreState: async () => ({}),
      readThreadsFile: async () => ({ threads: [] }),
      broadcast: () => {},
      dispatchRendererCommand: () => 0,
      ...remoteAccountProofDeps,
      getAppVersion: () => '0.0.0-test',
    });
    const before = fs.readFileSync(path.join(userData, 'orion-remote-control.json'), 'utf-8');
    const revoke = await engine.revokeRemoteDevice({ deviceId: 'controller-1' });
    const remove = await engine.removeRemoteMachine({ machineId: 'host-1' });
    const after = fs.readFileSync(path.join(userData, 'orion-remote-control.json'), 'utf-8');
    send({
      kind: 'persistenceUnavailable',
      state: engine.getRemoteControlState(),
      revoke,
      remove,
      fileUnchanged: before === after,
    });
    process.exit(0);
  }

  if (role === 'persistence-corrupt') {
    const userData = process.env.ORION_TEST_USERDATA;
    const statePath = path.join(userData, 'orion-remote-control.json');
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        machineId: 'corrupt-pairing-host',
        machineName: 'Corrupt pairing host',
        hostDevices: [{
          id: 'controller-corrupt',
          name: 'Controller with corrupt secret',
          userId,
          secret: { encrypted: true, value: 'not-decryptable' },
          pairedAt: '2026-08-01T00:00:00.000Z',
          lastSeenAt: null,
        }],
        remoteMachines: [],
      }, null, 2)}\n`
    );
    const before = fs.readFileSync(statePath, 'utf-8');
    await engine.initRemoteControl({
      readSession: async () => ({ token: testSessionToken, user: { id: userId } }),
      readStoreState: async () => ({}),
      readThreadsFile: async () => ({ threads: [] }),
      broadcast: () => 0,
      dispatchRendererCommand: () => 0,
      ...remoteAccountProofDeps,
      getAppVersion: () => '0.0.0-test',
    });
    const revoke = await engine.revokeRemoteDevice({ deviceId: 'controller-corrupt' });
    const after = fs.readFileSync(statePath, 'utf-8');
    send({
      kind: 'persistenceCorrupt',
      state: engine.getRemoteControlState(),
      revoke,
      fileUnchanged: before === after,
    });
    process.exit(0);
  }

  if (role === 'outbound-disable-race') {
    const userData = process.env.ORION_TEST_USERDATA;
    const hostId = process.env.ORION_REMOTE_TEST_HOST_ID;
    const secret = process.env.ORION_REMOTE_TEST_SECRET;
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(
      path.join(userData, 'orion-remote-control.json'),
      `${JSON.stringify({
        version: 1,
        machineId: 'race-controller',
        machineName: 'Race controller',
        hostDevices: [],
        remoteMachines: [{
          id: hostId,
          name: 'Slow host',
          host: '127.0.0.1',
          port: Number(process.env.ORION_REMOTE_TEST_PORT),
          userId,
          secret: { encrypted: false, value: secret },
          pairedAt: '2026-08-01T00:00:00.000Z',
        }],
      }, null, 2)}\n`
    );
    await engine.initRemoteControl({
      readSession: async () => ({ token: testSessionToken, user: { id: userId } }),
      readStoreState: async () => ({}),
      readThreadsFile: async () => ({ threads: [] }),
      broadcast: () => {},
      dispatchRendererCommand: () => 0,
      ...remoteAccountProofDeps,
      getAppVersion: () => '0.0.0-test',
    });
    await engine.configureRemoteControl({ enabled: true, allowIncoming: false, port: 47901 });
    let request = null;
    let disabled = false;
    process.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== 'disable' || disabled) continue;
        disabled = true;
        void engine.configureRemoteControl({ enabled: false, allowIncoming: false, port: 47901 }).then(async (result) => {
          send({ kind: 'disabled', result });
          send({ kind: 'outboundResult', result: await request });
          process.exit(0);
        });
      }
    });
    request = engine.runRemoteTurn({ machineId: hostId, projectId: 'p1', prompt: 'must not send' });
    send({ kind: 'outboundStarted' });
    await new Promise(() => {});
  }

  if (role === 'established-disable-race') {
    const userData = process.env.ORION_TEST_USERDATA;
    const hostId = process.env.ORION_REMOTE_TEST_HOST_ID;
    const secret = process.env.ORION_REMOTE_TEST_SECRET;
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(
      path.join(userData, 'orion-remote-control.json'),
      `${JSON.stringify({
        version: 1,
        machineId: 'established-race-controller',
        machineName: 'Established race controller',
        hostDevices: [],
        remoteMachines: [{
          id: hostId,
          name: 'Established host',
          host: '127.0.0.1',
          port: Number(process.env.ORION_REMOTE_TEST_PORT),
          userId,
          secret: { encrypted: false, value: secret },
          pairedAt: '2026-08-01T00:00:00.000Z',
        }],
      }, null, 2)}\n`
    );
    let blockAccountRead = false;
    let releaseAccountRead = null;
    await engine.initRemoteControl({
      readSession: async () => {
        if (blockAccountRead) {
          send({ kind: 'accountReadPending' });
          await new Promise((resolve) => {
            releaseAccountRead = resolve;
          });
        }
        return { token: testSessionToken, user: { id: userId } };
      },
      readStoreState: async () => ({}),
      readThreadsFile: async () => ({ threads: [] }),
      broadcast: () => {},
      dispatchRendererCommand: () => 0,
      ...remoteAccountProofDeps,
      getAppVersion: () => '0.0.0-test',
    });
    await engine.configureRemoteControl({ enabled: true, allowIncoming: false, port: 47_901 });
    process.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() === 'disable') {
          blockAccountRead = true;
          const configuring = engine.configureRemoteControl({
            enabled: false,
            allowIncoming: false,
            port: 47_901,
          });
          send({ kind: 'disableStarted', state: engine.getRemoteControlState() });
          void configuring.then((result) => send({ kind: 'disabled', result }));
        }
        if (line.trim() === 'release-account-read') {
          blockAccountRead = false;
          releaseAccountRead?.();
          releaseAccountRead = null;
        }
      }
    });
    const request = engine.runRemoteTurn({
      machineId: hostId,
      projectId: 'p1',
      prompt: 'must be cancelled before claim',
    });
    send({ kind: 'outboundStarted' });
    void request.then((result) => send({ kind: 'outboundResult', result }));
    await new Promise(() => {});
  }

  if (role === 'pairing-disable-race') {
    await engine.initRemoteControl({
      readSession: async () => ({ token: testSessionToken, user: { id: userId } }),
      readStoreState: async () => ({}),
      readThreadsFile: async () => ({ threads: [] }),
      broadcast: () => 0,
      dispatchRendererCommand: () => 0,
      createRemotePairingProof: async ({ token, challenge, machineId, signal }) => {
        const proofUserId = String(token).startsWith('test-token:') ? String(token).slice(11) : '';
        send({ kind: 'pairingProofStarted' });
        return new Promise((resolve, reject) => {
          const cancel = () => {
            send({ kind: 'pairingProofAborted' });
            reject(signal?.reason ?? new Error('pairing proof cancelled'));
          };
          if (signal?.aborted) cancel();
          else signal?.addEventListener('abort', cancel, { once: true });
        });
      },
      verifyRemotePairingProof: remoteAccountProofDeps.verifyRemotePairingProof,
      getAppVersion: () => '0.0.0-test',
    });
    const pairArgs = {
      host: '127.0.0.1',
      port: Number(process.env.ORION_REMOTE_TEST_PORT),
      code: process.env.ORION_REMOTE_TEST_CODE,
    };
    const disabledAtEntry = await engine.pairWithRemoteHost(pairArgs);
    await engine.configureRemoteControl({ enabled: true, allowIncoming: false, port: 47_901 });
    const pendingPairing = engine.pairWithRemoteHost(pairArgs);
    process.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() !== 'disable') continue;
        void engine.configureRemoteControl({ enabled: false, allowIncoming: false, port: 47_901 }).then(async () => {
          const result = await pendingPairing;
          const persisted = JSON.parse(
            fs.readFileSync(path.join(process.env.ORION_TEST_USERDATA, 'orion-remote-control.json'), 'utf-8')
          );
          send({
            kind: 'pairingDisabled',
            disabledAtEntry,
            result,
            state: engine.getRemoteControlState(),
            persistedMachines: persisted.remoteMachines,
          });
          process.exit(0);
        });
      }
    });
    await new Promise(() => {});
  }

  if (role === 'pairing-retry-race') {
    let proofCalls = 0;
    let markFirstProofStarted;
    const firstProofStarted = new Promise((resolve) => {
      markFirstProofStarted = resolve;
    });
    let firstProofAborted = false;
    await engine.initRemoteControl({
      readSession: async () => ({ token: testSessionToken, user: { id: userId } }),
      readStoreState: async () => ({}),
      readThreadsFile: async () => ({ threads: [] }),
      broadcast: () => 0,
      dispatchRendererCommand: () => 0,
      createRemotePairingProof: async ({ token, challenge, machineId, signal }) => {
        proofCalls += 1;
        if (proofCalls === 1) {
          markFirstProofStarted();
          return new Promise((resolve, reject) => {
            const cancel = () => {
              firstProofAborted = true;
              reject(signal?.reason ?? new Error('pairing proof cancelled'));
            };
            if (signal?.aborted) cancel();
            else signal?.addEventListener('abort', cancel, { once: true });
          });
        }
        return remoteAccountProofDeps.createRemotePairingProof({ token, challenge, machineId });
      },
      verifyRemotePairingProof: remoteAccountProofDeps.verifyRemotePairingProof,
      getAppVersion: () => '0.0.0-test',
    });
    await engine.configureRemoteControl({ enabled: true, allowIncoming: false, port: 47_901 });
    const pairArgs = {
      host: '127.0.0.1',
      port: Number(process.env.ORION_REMOTE_TEST_PORT),
      code: process.env.ORION_REMOTE_TEST_CODE,
    };
    const first = engine.pairWithRemoteHost(pairArgs);
    await firstProofStarted;
    const second = engine.pairWithRemoteHost(pairArgs);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    send({ kind: 'pairingRetried', firstProofAborted, firstResult, secondResult });
    process.exit(0);
  }

  const fixtureThreads = [
    {
      id: 't-no-project',
      projectId: 'orion:no-project',
      title: 'Plain chat',
      status: 'idle',
      modelId: 'claude:sonnet',
      createdAt: '2026-08-01T10:00:00.000Z',
      messages: [],
    },
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
  if (process.env.ORION_REMOTE_TEST_LARGE_THREAD === '1') {
    fixtureThreads.push({
      id: 't-large',
      projectId: 'p1',
      title: 'Large transcript',
      status: 'idle',
      modelId: 'claude:sonnet',
      createdAt: '2026-08-01T10:00:00.000Z',
      messages: [
        {
          id: 'm-large',
          role: 'agent',
          content: 'x'.repeat(9 * 1024 * 1024),
          ts: '2026-08-01T10:00:05.000Z',
          kind: 'agent-run',
          status: 'done',
        },
      ],
    });
  }

  let rendererAvailable = true;
  let activeSessionUserId = userId;
  let blockedSessionRead = null;
  let releasePairingProof = null;
  let delayedRendererCommandId = null;
  let snapshotReadFailure = null;
  const hostPairingProofDeps =
    role === 'host' && process.env.ORION_REMOTE_TEST_BLOCK_HOST_PROOF === '1'
      ? {
          ...remoteAccountProofDeps,
          verifyRemotePairingProof: async (input) => {
            send({ kind: 'hostPairingProofStarted' });
            return new Promise((resolve, reject) => {
              let settled = false;
              const cancel = () => {
                if (settled) return;
                settled = true;
                send({ kind: 'hostPairingProofAborted' });
                reject(input.signal?.reason ?? new Error('host pairing proof cancelled'));
              };
              if (input.signal?.aborted) cancel();
              else input.signal?.addEventListener('abort', cancel, { once: true });
              releasePairingProof = async () => {
                if (settled) return;
                settled = true;
                input.signal?.removeEventListener('abort', cancel);
                resolve(await remoteAccountProofDeps.verifyRemotePairingProof(input));
              };
            });
          },
        }
      : remoteAccountProofDeps;
  let largeThreadMutated = false;
  await engine.initRemoteControl({
    readSession: async () => {
      const sessionUserId = activeSessionUserId;
      if (blockedSessionRead) {
        send({ kind: 'accountReadPending' });
        await blockedSessionRead.promise;
      }
      if (!sessionUserId) return null;
      return {
        token: `test-token:${sessionUserId}`,
        user: { id: sessionUserId },
      };
    },
    readStoreState: async () => {
      if (snapshotReadFailure === 'store') throw new Error('Test store snapshot read failed.');
      return {
        projects: [{ id: 'p1', name: 'orion', path: '/tmp/orion' }],
        noProject: { id: 'orion:no-project', name: 'No project', path: '/tmp/orion-chats' },
        epics: [{ id: 'e1', name: 'Remote epic', description: '', createdAt: '2026-08-01T09:00:00.000Z' }],
      };
    },
    readThreadsFile: async ({ threadId } = {}) => {
      if (snapshotReadFailure === 'threads') throw new Error('Test transcript snapshot read failed.');
      if (
        process.env.ORION_REMOTE_TEST_MUTATE_LARGE_THREAD_DURING_FETCH === '1' &&
        threadId === 't-large' &&
        !largeThreadMutated
      ) {
        // Snapshot the transcript returned for the first large-thread chunk,
        // then simulate the normal live transcript saver changing the source
        // before the controller asks for chunk two.
        const capturedThreads = structuredClone(fixtureThreads);
        fixtureThreads.find((thread) => thread.id === 't-large')?.messages.push({
          id: 'm-live-update',
          role: 'agent',
          content: 'new output saved while the transfer is in progress',
          ts: '2026-08-01T10:00:06.000Z',
          kind: 'agent-run',
          status: 'running',
        });
        largeThreadMutated = true;
        send({ kind: 'largeThreadMutated' });
        return { threads: capturedThreads };
      }
      return { threads: fixtureThreads };
    },
    // The terminal pseudo-model must be filtered out on the host, and the
    // internal `command` field must never reach the wire.
    listAgentModels: async () => [
      {
        id: 'claude:claude-opus-5',
        providerId: 'claude',
        providerLabel: 'Claude',
        label: 'Claude Opus 5',
        slug: 'claude-opus-5',
        shortcut: '⌘2',
        favorite: true,
        available: true,
      },
      {
        id: 'grok:grok-4.5',
        providerId: 'grok',
        providerLabel: 'Grok',
        label: 'Grok 4.5',
        slug: 'grok-4.5',
        available: false,
        unavailableReason: 'Install or authenticate grok on PATH.',
        command: 'grok',
      },
      {
        id: 'claude:claude-code-cli',
        providerId: 'claude',
        providerLabel: 'Claude',
        label: 'Claude Code CLI',
        slug: 'claude-code-cli',
        available: true,
      },
    ],
    broadcast: (channel, payload) => {
      if (channel === 'remote:event') send({ kind: 'remoteEvent', event: payload });
      return rendererAvailable ? 1 : 0;
    },
    // Host side: stand in for a renderer only after its command listener has
    // announced readiness. Turning this off simulates startup/reload/crash.
    dispatchRendererCommand: (payload) => {
      if (!rendererAvailable) return 0;
      const { commandId, command, expiresAt } = payload;
      if (
        process.env.ORION_REMOTE_TEST_DELAY_CLAIMED_STOP === '1' &&
        command.kind === 'stopTurn' &&
        delayedRendererCommandId === null
      ) {
        delayedRendererCommandId = commandId;
        send({ kind: 'stopCommandSeen', commandId, expiresAt, command });
        setTimeout(() => {
          const result = engine.claimRemoteCommand({ commandId });
          send({ kind: 'claimedStop', result });
          if (!result.ok) return;
          setTimeout(() => {
            engine.resolveRemoteCommand({ commandId, ok: true, threadId: command.threadId });
          }, Number(process.env.ORION_REMOTE_TEST_COMPLETION_DELAY_MS));
        }, Number(process.env.ORION_REMOTE_TEST_CLAIM_DELAY_MS));
        return 1;
      }
      if (
        process.env.ORION_REMOTE_TEST_DELAY_FIRST_RUN === '1' &&
        command.kind === 'runTurn' &&
        delayedRendererCommandId === null
      ) {
        delayedRendererCommandId = commandId;
        send({ kind: 'commandSeen', commandId, expiresAt, command });
        return 1;
      }
      if (
        process.env.ORION_REMOTE_TEST_DELAY_STOP === '1' &&
        command.kind === 'stopTurn' &&
        delayedRendererCommandId === null
      ) {
        delayedRendererCommandId = commandId;
        send({ kind: 'stopCommandSeen', commandId, expiresAt, command });
        return 1;
      }
      if (command.kind === 'runTurn') {
        engine.resolveRemoteCommand({ commandId, ok: true, threadId: command.threadId ?? 't-new' });
      } else if (command.kind === 'createEpic') {
        engine.resolveRemoteCommand({ commandId, ok: true, epicId: 'epic-new' });
      } else if (command.kind === 'stopTurn') {
        engine.resolveRemoteCommand({ commandId, ok: true, threadId: command.threadId });
      }
      send({ kind: 'commandSeen', commandId, expiresAt, command });
      return 1;
    },
    ...hostPairingProofDeps,
    getAppVersion: () => '0.0.0-test',
    ...(process.env.ORION_REMOTE_TEST_RUN_TIMEOUT_MS
      ? { runTurnTimeoutMs: Number(process.env.ORION_REMOTE_TEST_RUN_TIMEOUT_MS) }
      : {}),
    ...(process.env.ORION_REMOTE_TEST_REQUEST_TIMEOUT_MS
      ? { requestTimeoutMs: Number(process.env.ORION_REMOTE_TEST_REQUEST_TIMEOUT_MS) }
      : {}),
    ...(process.env.ORION_REMOTE_TEST_COMPLETION_TIMEOUT_MS
      ? { rendererCommandCompletionTimeoutMs: Number(process.env.ORION_REMOTE_TEST_COMPLETION_TIMEOUT_MS) }
      : {}),
    ...(process.env.ORION_REMOTE_TEST_RESPONSE_GRACE_MS
      ? { clientResponseGraceMs: Number(process.env.ORION_REMOTE_TEST_RESPONSE_GRACE_MS) }
      : {}),
  });

  if (role === 'host') {
    const port = Number(process.env.ORION_REMOTE_TEST_PORT);
    await engine.configureRemoteControl({ enabled: true, allowIncoming: true, port });
    const listenState = engine.getRemoteControlState();
    assert.ok(
      listenState.host?.listening,
      `host should be listening on ${port}: ${listenState.host?.error ?? 'unknown error'}`
    );
    const pairing = engine.startRemotePairing();
    assert.equal(pairing.ok, true, `pairing should start: ${pairing.error}`);
    send({ kind: 'ready', code: pairing.code, port });
    process.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() === 'state') send({ kind: 'state', state: engine.getRemoteControlState() });
        if (line.trim() === 'pair-again') {
          const next = engine.startRemotePairing();
          send({ kind: 'ready', code: next.code, port });
        }
        if (line.trim() === 'cancel-pairing') {
          engine.cancelRemotePairing();
          send({ kind: 'pairingCancelled' });
        }
        if (line.trim() === 'renderer-off') {
          rendererAvailable = false;
          engine.notifyRemoteCommandRendererLost();
          send({ kind: 'rendererState', available: false });
        }
        if (line.trim() === 'renderer-on') {
          rendererAvailable = true;
          send({ kind: 'rendererState', available: true });
        }
        if (line.trim().startsWith('snapshot-read-failure ')) {
          snapshotReadFailure = line.trim().slice('snapshot-read-failure '.length);
          send({ kind: 'snapshotReadFailureMode', mode: snapshotReadFailure });
        }
        if (line.trim() === 'snapshot-read-restore') {
          snapshotReadFailure = null;
          send({ kind: 'snapshotReadFailureMode', mode: null });
        }
        if (line.trim() === 'release-pairing-proof') {
          releasePairingProof?.();
          releasePairingProof = null;
          send({ kind: 'hostPairingProofReleased' });
        }
        if (line.trim() === 'release-pairing-save') {
          releaseBlockedPairingSave?.();
          releaseBlockedPairingSave = null;
          setTimeout(() => {
            const persisted = JSON.parse(
              fs.readFileSync(path.join(process.env.ORION_TEST_USERDATA, 'orion-remote-control.json'), 'utf-8')
            );
            send({ kind: 'hostPairingSaveReleased', state: engine.getRemoteControlState(), persisted });
          }, 150);
        }
        if (line.trim().startsWith('revoke ')) {
          void engine.revokeRemoteDevice({ deviceId: line.trim().slice(7) }).then((result) => {
            send({ kind: 'revoked', result });
          });
        }
        if (line.trim() === 'disable-incoming-slow') {
          let release;
          const promise = new Promise((resolve) => {
            release = resolve;
          });
          blockedSessionRead = { promise, release };
          const configuring = engine.configureRemoteControl({
            enabled: true,
            allowIncoming: false,
            port,
          });
          send({ kind: 'incomingDisabledImmediate', state: engine.getRemoteControlState() });
          void configuring.then(() => send({ kind: 'incomingDisabledComplete' }));
        }
        if (line.trim() === 'release-account-read') {
          const blocked = blockedSessionRead;
          blockedSessionRead = null;
          blocked?.release();
          setTimeout(() => send({ kind: 'accountReadReleased', state: engine.getRemoteControlState() }), 25);
        }
        if (line.trim() === 'enable-incoming') {
          void engine
            .configureRemoteControl({ enabled: true, allowIncoming: true, port })
            .then(() => send({ kind: 'incomingEnabled', state: engine.getRemoteControlState() }));
        }
        if (line.trim().startsWith('switch-account ')) {
          activeSessionUserId = line.trim().slice('switch-account '.length);
          engine.notifyRemoteControlAccountChanged();
          void engine
            .configureRemoteControl({ enabled: true, allowIncoming: true, port })
            .then(() => send({ kind: 'accountSwitched', state: engine.getRemoteControlState() }));
        }
        if (line.trim() === 'sign-out-slow') {
          let release;
          const promise = new Promise((resolve) => {
            release = resolve;
          });
          blockedSessionRead = { promise, release };
          // Start a read that captures the old session, then sign out while it
          // is blocked. Its eventual result must not resurrect authorization.
          engine.notifyRemoteControlAccountChanged();
          setImmediate(() => {
            activeSessionUserId = null;
            engine.notifyRemoteControlAccountChanged(null, { reconcile: false });
            send({ kind: 'signedOutImmediate', state: engine.getRemoteControlState() });
          });
        }
        if (line.trim().startsWith('claim ')) {
          const commandId = line.trim().slice('claim '.length);
          send({ kind: 'claimResult', result: engine.claimRemoteCommand({ commandId }) });
        }
        if (line.trim() === 'exit') process.exit(0);
      }
    });
  } else {
    await engine.configureRemoteControl({ enabled: true, allowIncoming: false, port: 47901 });
    const hostPort = Number(process.env.ORION_REMOTE_TEST_PORT);
    const code = process.env.ORION_REMOTE_TEST_CODE;
    const results = {};

    // Wrong code first (also consumes one pairing attempt on the host).
    results.wrongCode = await engine.pairWithRemoteHost({
      host: '127.0.0.1',
      port: hostPort,
      code: 'AAAA-BBBB-CCCC-DDDD',
    });

    results.pair = await engine.pairWithRemoteHost({ host: '127.0.0.1', port: hostPort, code });
    results.snapshot = await engine.fetchRemoteSnapshot({ machineId: results.pair.machine?.id });
    results.thread = await engine.fetchRemoteThread({ machineId: results.pair.machine?.id, threadId: 't1' });
    if (process.env.ORION_REMOTE_TEST_LARGE_THREAD === '1') {
      const largeThread = await engine.fetchRemoteThread({
        machineId: results.pair.machine?.id,
        threadId: 't-large',
      });
      results.largeThread = {
        ok: largeThread.ok,
        error: largeThread.error,
        contentLength: largeThread.thread?.messages?.[0]?.content?.length ?? 0,
      };
    }
    results.missingThread = await engine.fetchRemoteThread({
      machineId: results.pair.machine?.id,
      threadId: 'nope',
    });
    results.runTurn = await engine.runRemoteTurn({
      machineId: results.pair.machine?.id,
      projectId: 'p1',
      prompt: 'build the thing',
    });
    results.continueTurn = await engine.runRemoteTurn({
      machineId: results.pair.machine?.id,
      threadId: 't1',
      prompt: 'keep going',
    });
    results.stopTurn = await engine.stopRemoteTurn({ machineId: results.pair.machine?.id, threadId: 't1' });
    results.createEpic = await engine.createRemoteEpic({
      machineId: results.pair.machine?.id,
      name: 'Remote Epic',
      description: 'Created from the web controller',
      projectIds: ['p1'],
      createRift: true,
    });
    results.emptyPrompt = await engine.runRemoteTurn({ machineId: results.pair.machine?.id, prompt: '   ' });
    results.state = engine.getRemoteControlState();
    send({ kind: 'results', results });
    if (process.env.ORION_REMOTE_TEST_STAY_CONNECTED !== '1') process.exit(0);
    process.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim() === 'snapshot') {
          void engine
            .fetchRemoteSnapshot({ machineId: results.pair.machine?.id })
            .then((result) => send({ kind: 'snapshotResult', result }));
        }
        if (line.trim() === 'state') send({ kind: 'state', state: engine.getRemoteControlState() });
        if (line.trim() === 'exit') process.exit(0);
      }
    });
    await new Promise(() => {});
  }
} else {
  // -------------------------------------------------------------------------
  // Parent orchestrator

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-remote-test-'));
  const port = 47_000 + crypto.randomInt(500);

  // A child that outlives a failed run keeps its port bound and breaks every
  // later run with a confusing "enable incoming control first".
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

  const spawnRole = (childRole, extraEnv) => {
    const child = spawn(process.execPath, [selfPath], {
      env: {
        ...process.env,
        ORION_REMOTE_TEST_ROLE: childRole,
        ORION_TEST_USERDATA: path.join(tmpRoot, childRole + (extraEnv?.ORION_REMOTE_TEST_USER ?? '')),
        ORION_REMOTE_TEST_PORT: String(port),
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
    const waitFor = (kind, timeoutMs = 15_000) =>
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

  // A packaged build without OS-backed safeStorage must fail closed. In
  // particular, revocation/removal may not report success while leaving the
  // old credential on disk to return after restart.
  {
    const unavailable = spawnRole('persistence-unavailable', {
      ORION_TEST_PACKAGED: '1',
    });
    const result = await unavailable.waitFor('persistenceUnavailable');
    assert.equal(result.state.available, false);
    assert.match(result.state.error, /secure storage/i);
    assert.equal(result.revoke.ok, false);
    assert.equal(result.remove.ok, false);
    assert.equal(result.fileUnchanged, true);
    console.log('ok  unavailable secure storage fails pairing mutations closed');
  }

  // Electron reports encryption as available for Linux's basic_text backend,
  // but that backend uses a fixed plaintext password and must not hold remote
  // control credentials.
  {
    const basicText = spawnRole('persistence-unavailable', {
      ORION_TEST_PACKAGED: '1',
      ORION_TEST_SAFE_STORAGE: '1',
      ORION_TEST_STORAGE_BACKEND: 'basic_text',
    });
    const result = await basicText.waitFor('persistenceUnavailable');
    assert.equal(result.state.available, false);
    assert.match(result.state.error, /basic-text/i);
    assert.equal(result.revoke.ok, false);
    assert.equal(result.remove.ok, false);
    assert.equal(result.fileUnchanged, true);
    console.log('ok  Linux basic-text credential storage fails pairing mutations closed');
  }

  // If even one saved secret cannot decrypt, the complete credential file is
  // held read-only. Silently dropping that entry would let the next ordinary
  // pairing mutation permanently rewrite the file without it.
  {
    const corrupt = spawnRole('persistence-corrupt', {
      ORION_TEST_PACKAGED: '1',
      ORION_TEST_SAFE_STORAGE: '1',
      ORION_TEST_STORAGE_BACKEND: 'kwallet',
    });
    const result = await corrupt.waitFor('persistenceCorrupt');
    assert.equal(result.state.available, false);
    assert.match(result.state.error, /pairing file/i);
    assert.equal(result.revoke.ok, false);
    assert.equal(result.fileUnchanged, true);
    console.log('ok  undecryptable persisted secrets fail closed without rewriting pairings');
  }

  // A failed persistence write must roll back only its own mutation before a
  // later revoke snapshots state. Otherwise memory can resurrect both devices
  // after the second revoke has durably removed them.
  {
    const persistenceRace = spawnRole('persistence-race');
    const result = await persistenceRace.waitFor('persistenceRace');
    assert.equal(result.firstResult.ok, false, 'the simulated failed revoke must report failure');
    assert.equal(result.secondResult.ok, true, 'the later revoke should still succeed');
    assert.deepEqual(result.state.host.devices.map((device) => device.id), ['device-a']);
    assert.deepEqual(result.persisted.hostDevices.map((device) => device.id), ['device-a']);
    console.log('ok  persisted credential mutations serialize through rollback');
  }

  {
    const persistenceDrain = spawnRole('persistence-drain');
    const result = await persistenceDrain.waitFor('persistenceDrain');
    assert.equal(result.drainedBeforeWrite, false, 'the persistence drain must wait for the pending rename');
    assert.equal(result.revokeResult.ok, true);
    assert.equal(result.lateRevokeResult.ok, false);
    assert.match(result.lateRevokeResult.error, /shutting down/i);
    assert.equal(result.lateRemoveResult.ok, false);
    assert.match(result.lateRemoveResult.error, /shutting down/i);
    assert.deepEqual(result.persisted.hostDevices.map((device) => device.id), ['device-b']);
    assert.deepEqual(result.persisted.remoteMachines.map((machine) => machine.id), ['machine-a']);
    console.log('ok  shutdown drains in-flight persistence and rejects later credential mutations');
  }

  // will-quit can race an account refresh already queued by configure. Once
  // shutdown begins, that reconciliation must not start the listener after
  // its await resumes.
  {
    const shutdownRace = spawnRole('shutdown-race');
    const result = await shutdownRace.waitFor('shutdownRace');
    assert.equal(result.state.host.listening, false);
    assert.equal(result.state.host.enabled, true, 'settings remain enabled while lifecycle is terminal');
    console.log('ok  shutdown prevents awaited reconciliation from reopening the listener');
  }

  // Remote authorization must end at the persisted account-session expiry,
  // even if no renderer asks the global account manager to verify it.
  {
    const expiring = spawnRole('account-expiry', {
      ORION_REMOTE_TEST_PORT: String(port + 4),
    });
    const result = await expiring.waitFor('accountExpiry');
    assert.equal(result.before.authenticated, true);
    assert.equal(result.before.host.listening, true);
    assert.equal(result.after.authenticated, false);
    assert.equal(result.after.host.listening, false);
    console.log('ok  account expiry automatically stops incoming remote control');
  }

  // A renderer that finishes preparation after the host's startup deadline may
  // not claim the command and begin work after the controller saw a timeout.
  {
    const timeoutPort = port + 9;
    const timeoutHost = spawnRole('host', {
      ORION_REMOTE_TEST_PORT: String(timeoutPort),
      ORION_REMOTE_TEST_DELAY_FIRST_RUN: '1',
      ORION_REMOTE_TEST_RUN_TIMEOUT_MS: '50',
      ORION_TEST_USERDATA: path.join(tmpRoot, 'renderer-timeout-host'),
    });
    const timeoutReady = await timeoutHost.waitFor('ready');
    const delayedCommand = timeoutHost.waitFor('commandSeen');
    const timeoutController = spawnRole('controller', {
      ORION_REMOTE_TEST_PORT: String(timeoutPort),
      ORION_REMOTE_TEST_CODE: timeoutReady.code,
      ORION_TEST_USERDATA: path.join(tmpRoot, 'renderer-timeout-controller'),
    });
    const seen = await delayedCommand;
    const timeoutResults = await timeoutController.waitFor('results', 30_000);
    assert.equal(timeoutResults.results.runTurn.ok, false);
    assert.match(timeoutResults.results.runTurn.error, /did not respond in time/i);
    assert.ok(seen.expiresAt > 0, 'renderer commands carry an absolute startup deadline');
    const claimResult = timeoutHost.waitFor('claimResult');
    timeoutHost.send(`claim ${seen.commandId}`);
    assert.equal((await claimResult).result.ok, false, 'an expired command must not be reclaimable');
    timeoutHost.send('exit');
    console.log('ok  timed-out renderer commands cannot claim ownership and start later');
  }

  // A renderer reload/crash after delivery must release unclaimed controller
  // work immediately. The replacement renderer never receives the old event.
  {
    const lossPort = port + 14;
    const lossHost = spawnRole('host', {
      ORION_REMOTE_TEST_PORT: String(lossPort),
      ORION_REMOTE_TEST_DELAY_FIRST_RUN: '1',
      ORION_REMOTE_TEST_RUN_TIMEOUT_MS: '5000',
      ORION_TEST_USERDATA: path.join(tmpRoot, 'renderer-loss-host'),
    });
    const lossReady = await lossHost.waitFor('ready');
    const delayedCommand = lossHost.waitFor('commandSeen');
    const lossController = spawnRole('controller', {
      ORION_REMOTE_TEST_PORT: String(lossPort),
      ORION_REMOTE_TEST_CODE: lossReady.code,
      ORION_TEST_USERDATA: path.join(tmpRoot, 'renderer-loss-controller'),
    });
    const seen = await delayedCommand;
    const lostAt = Date.now();
    const rendererState = lossHost.waitFor('rendererState');
    lossHost.send('renderer-off');
    await rendererState;
    const lossResults = await lossController.waitFor('results', 30_000);
    assert.equal(lossResults.results.runTurn.ok, false);
    assert.match(lossResults.results.runTurn.error, /Open a Durango Code window/i);
    assert.ok(Date.now() - lostAt < 2000, 'renderer loss should not wait for the 5-second run timeout');
    const claimResult = lossHost.waitFor('claimResult');
    lossHost.send(`claim ${seen.commandId}`);
    assert.equal((await claimResult).result.ok, false, 'a renderer-lost command must not remain claimable');
    lossHost.send('exit');
    console.log('ok  renderer loss immediately settles unclaimed remote commands');
  }

  // Claiming transfers a renderer command from its startup budget to a fresh,
  // bounded completion budget. The controller must observe that transition or
  // it can report failure while the host still applies the command.
  {
    const claimedPort = port + 13;
    const timingEnv = {
      ORION_REMOTE_TEST_REQUEST_TIMEOUT_MS: '1000',
      ORION_REMOTE_TEST_COMPLETION_TIMEOUT_MS: '1500',
      ORION_REMOTE_TEST_RESPONSE_GRACE_MS: '500',
    };
    const claimedHost = spawnRole('host', {
      ...timingEnv,
      ORION_REMOTE_TEST_PORT: String(claimedPort),
      ORION_REMOTE_TEST_DELAY_CLAIMED_STOP: '1',
      ORION_REMOTE_TEST_CLAIM_DELAY_MS: '600',
      ORION_REMOTE_TEST_COMPLETION_DELAY_MS: '1200',
      ORION_TEST_USERDATA: path.join(tmpRoot, 'claimed-deadline-host'),
    });
    const claimedReady = await claimedHost.waitFor('ready');
    const claimedController = spawnRole('controller', {
      ...timingEnv,
      ORION_REMOTE_TEST_PORT: String(claimedPort),
      ORION_REMOTE_TEST_CODE: claimedReady.code,
      ORION_TEST_USERDATA: path.join(tmpRoot, 'claimed-deadline-controller'),
    });
    const claimed = await claimedHost.waitFor('claimedStop');
    assert.equal(claimed.result.ok, true);
    const claimedResults = await claimedController.waitFor('results', 30_000);
    assert.equal(claimedResults.results.stopTurn.ok, true, claimedResults.results.stopTurn.error);
    claimedHost.send('exit');
    console.log('ok  claimed commands extend the controller completion deadline');
  }

  // Delivery to the renderer is not authorization forever. Revoking the
  // source device before claim must cancel the queued command and make the
  // command id permanently unclaimable.
  {
    const revokePort = port + 10;
    const revokeHost = spawnRole('host', {
      ORION_REMOTE_TEST_PORT: String(revokePort),
      ORION_REMOTE_TEST_DELAY_FIRST_RUN: '1',
      ORION_TEST_USERDATA: path.join(tmpRoot, 'queued-revoke-host'),
    });
    const revokeReady = await revokeHost.waitFor('ready');
    const delayedCommand = revokeHost.waitFor('commandSeen');
    const revokeController = spawnRole('controller', {
      ORION_REMOTE_TEST_PORT: String(revokePort),
      ORION_REMOTE_TEST_CODE: revokeReady.code,
      ORION_TEST_USERDATA: path.join(tmpRoot, 'queued-revoke-controller'),
    });
    const seen = await delayedCommand;
    const revoked = revokeHost.waitFor('revoked');
    revokeHost.send(`revoke ${seen.command.source.machineId}`);
    assert.equal((await revoked).result.ok, true);
    const claimResult = revokeHost.waitFor('claimResult');
    revokeHost.send(`claim ${seen.commandId}`);
    assert.equal((await claimResult).result.ok, false);
    revokeController.child.kill();
    revokeHost.child.kill();
    console.log('ok  revocation cancels unclaimed renderer commands from that device');
  }

  // Incoming-control opt-out invalidates the whole host authorization
  // generation synchronously, before the account refresh inside configure can
  // complete.
  {
    const optOutPort = port + 11;
    const optOutHost = spawnRole('host', {
      ORION_REMOTE_TEST_PORT: String(optOutPort),
      ORION_REMOTE_TEST_DELAY_FIRST_RUN: '1',
      ORION_TEST_USERDATA: path.join(tmpRoot, 'queued-opt-out-host'),
    });
    const optOutReady = await optOutHost.waitFor('ready');
    const delayedCommand = optOutHost.waitFor('commandSeen');
    const optOutController = spawnRole('controller', {
      ORION_REMOTE_TEST_PORT: String(optOutPort),
      ORION_REMOTE_TEST_CODE: optOutReady.code,
      ORION_TEST_USERDATA: path.join(tmpRoot, 'queued-opt-out-controller'),
    });
    const seen = await delayedCommand;
    const disabled = optOutHost.waitFor('incomingDisabledImmediate');
    optOutHost.send('disable-incoming-slow');
    assert.equal((await disabled).state.host.enabled, false);
    const claimResult = optOutHost.waitFor('claimResult');
    optOutHost.send(`claim ${seen.commandId}`);
    assert.equal((await claimResult).result.ok, false);
    optOutController.child.kill();
    optOutHost.child.kill();
    console.log('ok  incoming opt-out cancels unclaimed renderer commands immediately');
  }

  // Stop is a mutating renderer command too. If account authorization ends
  // while its event is queued, main must reject the later atomic claim.
  {
    const stopPort = port + 12;
    const stopHost = spawnRole('host', {
      ORION_REMOTE_TEST_PORT: String(stopPort),
      ORION_REMOTE_TEST_DELAY_STOP: '1',
      ORION_TEST_USERDATA: path.join(tmpRoot, 'queued-stop-host'),
    });
    const stopReady = await stopHost.waitFor('ready');
    const delayedStop = stopHost.waitFor('stopCommandSeen');
    const stopController = spawnRole('controller', {
      ORION_REMOTE_TEST_PORT: String(stopPort),
      ORION_REMOTE_TEST_CODE: stopReady.code,
      ORION_TEST_USERDATA: path.join(tmpRoot, 'queued-stop-controller'),
    });
    const seen = await delayedStop;
    const signedOut = stopHost.waitFor('signedOutImmediate');
    stopHost.send('sign-out-slow');
    await signedOut;
    const claimResult = stopHost.waitFor('claimResult');
    stopHost.send(`claim ${seen.commandId}`);
    assert.equal((await claimResult).result.ok, false);
    stopController.child.kill();
    stopHost.child.kill();
    console.log('ok  queued remote Stop cannot claim after account authorization ends');
  }

  // Invalid hello frames are failed handshakes too. After the per-IP budget is
  // spent, a well-formed follow-up must be refused before handshake work.
  {
    const net = await import('node:net');
    const { REMOTE_PROTOCOL_VERSION, SecureChannel, createEphemeralKeyPair } = await import(
      '../src/main/remote-crypto.js'
    );
    const malformedPort = port + 3;
    const malformedHost = spawnRole('host', {
      ORION_REMOTE_TEST_PORT: String(malformedPort),
      ORION_TEST_USERDATA: path.join(tmpRoot, 'malformed-host'),
    });
    await malformedHost.waitFor('ready');
    for (let index = 0; index < 10; index += 1) {
      const socket = net.connect(malformedPort, '127.0.0.1');
      socket.on('error', () => {});
      await new Promise((resolve) => socket.on('connect', resolve));
      const channel = new SecureChannel(socket, { maxFrame: 4096 });
      const closed = new Promise((resolve) => channel.onClose(() => resolve('closed')));
      channel.send({ t: 'invalidHello' });
      const outcome = await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
      ]);
      assert.equal(outcome, 'closed', `malformed handshake ${index + 1} should be closed`);
    }

    const socket = net.connect(malformedPort, '127.0.0.1');
    socket.on('error', () => {});
    await new Promise((resolve) => socket.on('connect', resolve));
    const channel = new SecureChannel(socket, { maxFrame: 4096 });
    const eph = createEphemeralKeyPair();
    const outcome = await new Promise((resolve) => {
      channel.onMessage((message) => {
        if (message.t === 'helloAck') resolve('ack');
      });
      channel.onClose(() => resolve('closed'));
      channel.send({
        t: 'hello',
        v: REMOTE_PROTOCOL_VERSION,
        mode: 'pair',
        pub: eph.publicDer.toString('base64'),
        nonce: crypto.randomBytes(16).toString('base64'),
      });
      setTimeout(() => resolve('timeout'), 2000);
    });
    assert.equal(outcome, 'closed', 'rate-limited IP must be refused before helloAck');
    malformedHost.send('exit');
    console.log('ok  malformed hellos consume the failed-handshake rate limit');
  }

  // Disabling remote control while openChannel is awaiting the host's confirm
  // used to remove the map entry before the channel was attached. Once the slow
  // host resumed, that orphan could still be promoted and dispatch runTurn.
  {
    const net = await import('node:net');
    const {
      REMOTE_PROTOCOL_VERSION,
      SecureChannel,
      confirmationMac,
      createEphemeralKeyPair,
      deriveHandshakeKeys,
      handshakeTranscript,
      macsEqual,
    } = await import('../src/main/remote-crypto.js');
    const fakePort = port + 2;
    const fakeHostId = 'slow-host';
    const secret = crypto.randomBytes(32);
    let releaseHost = null;
    let requestSeen = false;
    let markClientConfirmed;
    const clientConfirmed = new Promise((resolve) => {
      markClientConfirmed = resolve;
    });
    const fakeServer = net.createServer((socket) => {
      const channel = new SecureChannel(socket, { maxFrame: 4096 });
      const eph = createEphemeralKeyPair();
      let stage = 'hello';
      let transcript = null;
      let keys = null;
      channel.onMessage((message, raw) => {
        if (stage === 'hello') {
          assert.equal(message.t, 'hello');
          assert.equal(message.v, REMOTE_PROTOCOL_VERSION);
          const ackRaw = channel.send({
            t: 'helloAck',
            v: REMOTE_PROTOCOL_VERSION,
            pub: eph.publicDer.toString('base64'),
            nonce: crypto.randomBytes(16).toString('base64'),
          });
          transcript = handshakeTranscript(raw, ackRaw);
          keys = deriveHandshakeKeys({
            privateKey: eph.privateKey,
            peerPublicDer: Buffer.from(message.pub, 'base64'),
            psk: secret,
            transcript,
            isClient: false,
          });
          stage = 'confirm';
          return;
        }
        if (stage === 'confirm') {
          const received = Buffer.from(String(message.mac ?? ''), 'base64');
          assert.ok(macsEqual(confirmationMac(keys.macKey, 'client', transcript), received));
          stage = 'waiting';
          releaseHost = () => {
            channel.send({
              t: 'confirm',
              mac: confirmationMac(keys.macKey, 'server', transcript).toString('base64'),
            });
            channel.enableEncryption(keys);
            channel.setMaxFrame(8 * 1024 * 1024);
            channel.send({
              t: 'welcome',
              machine: { id: fakeHostId, name: 'Slow host' },
              userId: 'user_test_1',
              appVersion: '0.0.0-test',
            });
            stage = 'ready';
          };
          markClientConfirmed();
          return;
        }
        if (stage === 'ready' && message.t === 'runTurn') {
          requestSeen = true;
          channel.send({ t: 'res', reqId: message.reqId, ok: true, threadId: 'should-not-run' });
        }
      });
    });
    await new Promise((resolve, reject) => {
      fakeServer.once('error', reject);
      fakeServer.listen(fakePort, '127.0.0.1', resolve);
    });
    const raceController = spawnRole('outbound-disable-race', {
      ORION_REMOTE_TEST_PORT: String(fakePort),
      ORION_REMOTE_TEST_HOST_ID: fakeHostId,
      ORION_REMOTE_TEST_SECRET: secret.toString('base64'),
    });
    await raceController.waitFor('outboundStarted');
    await clientConfirmed;
    const disabled = raceController.waitFor('disabled');
    const outcome = raceController.waitFor('outboundResult');
    raceController.send('disable');
    await disabled;
    releaseHost();
    const { result } = await outcome;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(result.ok, false, 'the pending request must fail when remote control is disabled');
    assert.equal(requestSeen, false, 'the orphaned handshake must not dispatch runTurn');
    await new Promise((resolve) => fakeServer.close(resolve));
    console.log('ok  disabling remote control aborts an outbound handshake before dispatch');
  }

  // The master switch must also close an already-established outbound
  // session before configure awaits its account refresh. Otherwise a runTurn
  // already waiting on the host renderer remains claimable while Settings
  // visibly says Remote Control is off.
  {
    const net = await import('node:net');
    const {
      REMOTE_PROTOCOL_VERSION,
      SecureChannel,
      confirmationMac,
      createEphemeralKeyPair,
      deriveHandshakeKeys,
      handshakeTranscript,
      macsEqual,
    } = await import('../src/main/remote-crypto.js');
    const fakePort = port + 16;
    const fakeHostId = 'established-host';
    const secret = crypto.randomBytes(32);
    let markRequestSeen;
    const requestSeen = new Promise((resolve) => {
      markRequestSeen = resolve;
    });
    let markSessionClosed;
    const sessionClosed = new Promise((resolve) => {
      markSessionClosed = resolve;
    });
    const fakeServer = net.createServer((socket) => {
      const channel = new SecureChannel(socket, { maxFrame: 4096 });
      const eph = createEphemeralKeyPair();
      let stage = 'hello';
      let transcript = null;
      let keys = null;
      channel.onClose(() => markSessionClosed());
      channel.onMessage((message, raw) => {
        if (stage === 'hello') {
          assert.equal(message.t, 'hello');
          assert.equal(message.v, REMOTE_PROTOCOL_VERSION);
          const ackRaw = channel.send({
            t: 'helloAck',
            v: REMOTE_PROTOCOL_VERSION,
            pub: eph.publicDer.toString('base64'),
            nonce: crypto.randomBytes(16).toString('base64'),
          });
          transcript = handshakeTranscript(raw, ackRaw);
          keys = deriveHandshakeKeys({
            privateKey: eph.privateKey,
            peerPublicDer: Buffer.from(message.pub, 'base64'),
            psk: secret,
            transcript,
            isClient: false,
          });
          stage = 'confirm';
          return;
        }
        if (stage === 'confirm') {
          assert.ok(
            macsEqual(
              confirmationMac(keys.macKey, 'client', transcript),
              Buffer.from(String(message.mac ?? ''), 'base64')
            )
          );
          channel.send({
            t: 'confirm',
            mac: confirmationMac(keys.macKey, 'server', transcript).toString('base64'),
          });
          channel.enableEncryption(keys);
          channel.setMaxFrame(8 * 1024 * 1024);
          channel.send({
            t: 'welcome',
            machine: { id: fakeHostId, name: 'Established host' },
            userId: 'user_test_1',
            appVersion: '0.0.0-test',
          });
          stage = 'ready';
          return;
        }
        if (stage === 'ready' && message.t === 'runTurn') {
          markRequestSeen();
          // Deliberately leave the command unclaimed and unanswered.
        }
      });
    });
    await new Promise((resolve, reject) => {
      fakeServer.once('error', reject);
      fakeServer.listen(fakePort, '127.0.0.1', resolve);
    });
    const raceController = spawnRole('established-disable-race', {
      ORION_REMOTE_TEST_PORT: String(fakePort),
      ORION_REMOTE_TEST_HOST_ID: fakeHostId,
      ORION_REMOTE_TEST_SECRET: secret.toString('base64'),
    });
    await raceController.waitFor('outboundStarted');
    await requestSeen;
    const accountReadPending = raceController.waitFor('accountReadPending');
    const disableStarted = raceController.waitFor('disableStarted');
    const outcome = raceController.waitFor('outboundResult');
    raceController.send('disable');
    assert.equal((await disableStarted).state.host.enabled, false);
    await accountReadPending;
    await sessionClosed;
    assert.equal(
      (await outcome).result.ok,
      false,
      'the pending command must fail before the blocked reconciliation read is released'
    );
    const disabled = raceController.waitFor('disabled');
    raceController.send('release-account-read');
    await disabled;
    raceController.child.kill();
    await new Promise((resolve) => fakeServer.close(resolve));
    console.log('ok  disabling remote control closes established outbound sessions before account refresh');
  }

  // Inbound authorization ends synchronously at the opt-out boundary, even
  // while account reconciliation is blocked. A direct A -> B account change
  // also drops A's established controller before the listener is re-armed.
  {
    const lifecyclePort = port + 6;
    const lifecycleHost = spawnRole('host', {
      ORION_REMOTE_TEST_PORT: String(lifecyclePort),
      ORION_TEST_USERDATA: path.join(tmpRoot, 'lifecycle-host'),
    });
    const lifecycleReady = await lifecycleHost.waitFor('ready');
    const lifecycleController = spawnRole('controller', {
      ORION_REMOTE_TEST_PORT: String(lifecyclePort),
      ORION_REMOTE_TEST_CODE: lifecycleReady.code,
      ORION_REMOTE_TEST_STAY_CONNECTED: '1',
      ORION_TEST_USERDATA: path.join(tmpRoot, 'lifecycle-controller'),
    });
    const lifecycleResults = await lifecycleController.waitFor('results', 30_000);
    assert.equal(lifecycleResults.results.snapshot.ok, true);

    lifecycleHost.send('state');
    const connected = await lifecycleHost.waitFor('state');
    assert.equal(connected.state.host.devices[0]?.connected, true);

    const accountReadPending = lifecycleHost.waitFor('accountReadPending');
    const disabledImmediate = lifecycleHost.waitFor('incomingDisabledImmediate');
    lifecycleHost.send('disable-incoming-slow');
    await accountReadPending;
    const disabled = await disabledImmediate;
    assert.equal(disabled.state.host.enabled, false);
    assert.equal(disabled.state.host.listening, false);
    assert.equal(disabled.state.host.devices[0]?.connected, false);
    lifecycleController.send('snapshot');
    const disabledSnapshot = await lifecycleController.waitFor('snapshotResult');
    assert.equal(disabledSnapshot.result.ok, false);
    const disableComplete = lifecycleHost.waitFor('incomingDisabledComplete');
    lifecycleHost.send('release-account-read');
    await disableComplete;
    console.log('ok  inbound opt-out closes established access before account refresh completes');

    const enabled = lifecycleHost.waitFor('incomingEnabled');
    lifecycleHost.send('enable-incoming');
    assert.equal((await enabled).state.host.listening, true);
    const reconnectedSnapshot = lifecycleController.waitFor('snapshotResult');
    lifecycleController.send('snapshot');
    assert.equal((await reconnectedSnapshot).result.ok, true);

    const signOutReadPending = lifecycleHost.waitFor('accountReadPending');
    const signedOutImmediate = lifecycleHost.waitFor('signedOutImmediate');
    lifecycleHost.send('sign-out-slow');
    await signOutReadPending;
    const signedOut = await signedOutImmediate;
    assert.equal(signedOut.state.authenticated, false);
    assert.equal(signedOut.state.host.listening, false);
    assert.equal(signedOut.state.host.devices[0]?.connected, false);
    const signedOutSnapshot = lifecycleController.waitFor('snapshotResult');
    lifecycleController.send('snapshot');
    assert.equal((await signedOutSnapshot).result.ok, false);
    const accountReadReleased = lifecycleHost.waitFor('accountReadReleased');
    lifecycleHost.send('release-account-read');
    const afterStaleRead = await accountReadReleased;
    assert.equal(afterStaleRead.state.authenticated, false);
    assert.equal(afterStaleRead.state.host.listening, false);
    const signedBackIn = lifecycleHost.waitFor('accountSwitched');
    lifecycleHost.send('switch-account user_test_1');
    assert.equal((await signedBackIn).state.host.listening, true);
    const restoredSnapshot = lifecycleController.waitFor('snapshotResult');
    lifecycleController.send('snapshot');
    assert.equal((await restoredSnapshot).result.ok, true);
    console.log('ok  sign-out synchronously closes established remote authorization');

    const accountSwitched = lifecycleHost.waitFor('accountSwitched');
    lifecycleHost.send('switch-account user_test_2');
    const switched = await accountSwitched;
    assert.equal(switched.state.authenticated, true);
    assert.equal(switched.state.host.listening, true);
    assert.equal(switched.state.host.devices[0]?.connected, false);
    const oldAccountSnapshot = lifecycleController.waitFor('snapshotResult');
    lifecycleController.send('snapshot');
    assert.equal((await oldAccountSnapshot).result.ok, false);
    console.log('ok  account identity changes close sessions owned by the previous user');

    lifecycleController.send('exit');
    lifecycleHost.send('exit');
  }

  // Closing the authenticated channel while host-side proof verification is
  // pending must leave neither an authorized device nor a consumed code.
  {
    const closeRacePort = port + 7;
    const closeRaceHost = spawnRole('host', {
      ORION_REMOTE_TEST_PORT: String(closeRacePort),
      ORION_REMOTE_TEST_BLOCK_HOST_PROOF: '1',
      ORION_TEST_USERDATA: path.join(tmpRoot, 'pairing-close-host'),
    });
    const closeRaceReady = await closeRaceHost.waitFor('ready');
    const closeRaceController = spawnRole('controller', {
      ORION_REMOTE_TEST_PORT: String(closeRacePort),
      ORION_REMOTE_TEST_CODE: closeRaceReady.code,
      ORION_TEST_USERDATA: path.join(tmpRoot, 'pairing-close-controller'),
    });
    await closeRaceHost.waitFor('hostPairingProofStarted');
    const proofAborted = closeRaceHost.waitFor('hostPairingProofAborted');
    closeRaceController.child.kill('SIGKILL');
    if (closeRaceController.child.exitCode === null) {
      await new Promise((resolve) => closeRaceController.child.once('exit', resolve));
    }
    await proofAborted;
    await new Promise((resolve) => setTimeout(resolve, 100));
    closeRaceHost.send('state');
    const afterClose = await closeRaceHost.waitFor('state');
    assert.equal(afterClose.state.host.devices.length, 0, 'closed pairing must not authorize the controller');
    assert.equal(afterClose.state.host.pairing?.code, closeRaceReady.code, 'the unused code should remain active');
    closeRaceHost.send('exit');
    console.log('ok  pairing aborts when its authenticated channel closes');
  }

  // Replacing a live code owns the same host-side proof lifecycle even while
  // the authenticated controller remains connected.
  {
    const retryPort = port + 17;
    const retryHost = spawnRole('host', {
      ORION_REMOTE_TEST_PORT: String(retryPort),
      ORION_REMOTE_TEST_BLOCK_HOST_PROOF: '1',
      ORION_TEST_USERDATA: path.join(tmpRoot, 'pairing-retry-host'),
    });
    const retryReady = await retryHost.waitFor('ready');
    const retryController = spawnRole('controller', {
      ORION_REMOTE_TEST_PORT: String(retryPort),
      ORION_REMOTE_TEST_CODE: retryReady.code,
      ORION_TEST_USERDATA: path.join(tmpRoot, 'pairing-retry-controller'),
    });
    await retryHost.waitFor('hostPairingProofStarted');
    const retryOutcome = Promise.all([
      retryHost.waitFor('hostPairingProofAborted'),
      retryHost.waitFor('ready'),
    ]);
    retryHost.send('pair-again');
    const [proofAborted, replacement] = await retryOutcome;
    assert.equal(proofAborted.kind, 'hostPairingProofAborted');
    assert.notEqual(replacement.code, retryReady.code);
    retryHost.send('state');
    const afterRetry = await retryHost.waitFor('state');
    assert.equal(afterRetry.state.host.devices.length, 0);
    assert.equal(afterRetry.state.host.pairing?.code, replacement.code);
    retryController.child.kill('SIGKILL');
    retryHost.send('exit');
    console.log('ok  replacing a pairing code aborts stale host proof verification');
  }

  // A second controller submission supersedes an older POST immediately and
  // can use the still-live host code itself.
  {
    const retryPort = port + 18;
    const retryHost = spawnRole('host', {
      ORION_REMOTE_TEST_PORT: String(retryPort),
      ORION_TEST_USERDATA: path.join(tmpRoot, 'controller-retry-host'),
    });
    const retryReady = await retryHost.waitFor('ready');
    const retryController = spawnRole('pairing-retry-race', {
      ORION_REMOTE_TEST_PORT: String(retryPort),
      ORION_REMOTE_TEST_CODE: retryReady.code,
      ORION_TEST_USERDATA: path.join(tmpRoot, 'controller-retry-controller'),
    });
    const retried = await retryController.waitFor('pairingRetried');
    assert.equal(retried.firstProofAborted, true);
    assert.equal(retried.firstResult.ok, false);
    assert.match(retried.firstResult.error, /newer pairing attempt/i);
    assert.equal(retried.secondResult.ok, true, retried.secondResult.error);
    retryHost.send('exit');
    console.log('ok  retrying pairing aborts the superseded controller proof request');
  }

  // The same ownership rule applies on the far side of the durable write. If
  // the channel closes while rename is pending, the just-written credential
  // must be removed again before the operation releases the persistence queue.
  {
    const saveRacePort = port + 8;
    const saveRaceHost = spawnRole('host', {
      ORION_REMOTE_TEST_PORT: String(saveRacePort),
      ORION_REMOTE_TEST_BLOCK_HOST_SAVE: '1',
      ORION_TEST_USERDATA: path.join(tmpRoot, 'pairing-save-host'),
    });
    const saveRaceReady = await saveRaceHost.waitFor('ready');
    const saveRaceController = spawnRole('controller', {
      ORION_REMOTE_TEST_PORT: String(saveRacePort),
      ORION_REMOTE_TEST_CODE: saveRaceReady.code,
      ORION_TEST_USERDATA: path.join(tmpRoot, 'pairing-save-controller'),
    });
    await saveRaceHost.waitFor('hostPairingSaveStarted');
    saveRaceController.child.kill('SIGKILL');
    if (saveRaceController.child.exitCode === null) {
      await new Promise((resolve) => saveRaceController.child.once('exit', resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    saveRaceHost.send('release-pairing-save');
    const afterSaveClose = await saveRaceHost.waitFor('hostPairingSaveReleased');
    assert.equal(afterSaveClose.state.host.devices.length, 0, 'closed pairing must roll back host authorization');
    assert.equal(afterSaveClose.persisted.hostDevices.length, 0, 'closed pairing must roll back the persisted secret');
    assert.equal(afterSaveClose.state.host.pairing?.code, saveRaceReady.code, 'the unused code should remain active');
    saveRaceHost.send('exit');
    console.log('ok  pairing disconnect during persistence rolls back durably');
  }

  const host = spawnRole('host', {
    ORION_REMOTE_TEST_LARGE_THREAD: '1',
    ORION_REMOTE_TEST_MUTATE_LARGE_THREAD_DURING_FETCH: '1',
  });
  const ready = await host.waitFor('ready');
  assert.match(ready.code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);

  // Pairing is not a reusable client session, but the master switch still
  // owns it. Disable while the Orion account proof is pending and ensure the
  // channel closes without saving the host credential.
  {
    const pairingRace = spawnRole('pairing-disable-race', {
      ORION_REMOTE_TEST_CODE: ready.code,
      ORION_TEST_USERDATA: path.join(tmpRoot, 'pairing-disable-race'),
    });
    await pairingRace.waitFor('pairingProofStarted');
    const pairingOutcome = Promise.all([
      pairingRace.waitFor('pairingProofAborted'),
      pairingRace.waitFor('pairingDisabled'),
    ]);
    pairingRace.send('disable');
    const [proofAborted, outcome] = await pairingOutcome;
    assert.equal(proofAborted.kind, 'pairingProofAborted');
    assert.equal(outcome.disabledAtEntry.ok, false, 'pairing must be gated while Remote Control is off');
    assert.match(outcome.disabledAtEntry.error, /disabled/i);
    assert.equal(outcome.result.ok, false, 'pending pairing must fail when Remote Control is disabled');
    assert.match(outcome.result.error, /off|disabled/i);
    assert.equal(outcome.state.machines.length, 0);
    assert.equal(outcome.persistedMachines.length, 0, 'cancelled pairing must not be persisted');
    console.log('ok  disabling remote control aborts and does not persist pairing');
  }

  // Wrong account: pairing must be refused even with the correct code.
  {
    const wrongUser = spawnRole('controller', {
      ORION_REMOTE_TEST_USER: 'user_other',
      ORION_REMOTE_TEST_CODE: ready.code,
    });
    const { results } = await wrongUser.waitFor('results');
    assert.equal(results.pair.ok, false, 'pairing must fail across accounts');
    assert.match(results.pair.error, /same Durango account/i);
    wrongUser.child.kill();
    console.log('ok  cross-account pairing refused');
  }

  // The wrong-account pairing attempt consumed the single-use code state —
  // mint a fresh code for the real controller.
  host.send('pair-again');
  const ready2 = await host.waitFor('ready');

  let establishedController = null;
  {
    const largeThreadMutated = host.waitFor('largeThreadMutated');
    const controller = spawnRole('controller', {
      ORION_REMOTE_TEST_CODE: ready2.code,
      ORION_REMOTE_TEST_STAY_CONNECTED: '1',
      ORION_REMOTE_TEST_LARGE_THREAD: '1',
    });
    establishedController = controller;
    const commandSeen = host.waitFor('commandSeen');
    const { results } = await controller.waitFor('results', 30_000);
    await largeThreadMutated;

    assert.equal(results.wrongCode.ok, false, 'wrong pairing code must fail');
    assert.equal(results.pair.ok, true, `pairing failed: ${results.pair.error}`);
    assert.equal(results.snapshot.ok, true, `snapshot failed: ${results.snapshot.error}`);
    assert.equal(results.snapshot.snapshot.projects.length, 2);
    const noProject = results.snapshot.snapshot.projects.find((project) => project.id === 'orion:no-project');
    assert.deepEqual(noProject, { id: 'orion:no-project', name: 'No project', path: '/tmp/orion-chats' });
    assert.equal(
      results.snapshot.snapshot.threads.filter((thread) => thread.projectId === noProject.id).length,
      1,
      'The remote project groups must expose No project chats'
    );
    assert.equal(results.snapshot.snapshot.epics.length, 1);
    assert.equal(results.snapshot.snapshot.threads.length, 3);
    assert.equal(results.thread.ok, true);
    assert.equal(results.thread.thread.messages.length, 2);
    assert.equal(results.largeThread.ok, true, `large thread failed: ${results.largeThread.error}`);
    assert.equal(results.largeThread.contentLength, 9 * 1024 * 1024);
    assert.equal(results.missingThread.ok, false);
    assert.equal(results.runTurn.ok, true, `runTurn failed: ${results.runTurn.error}`);
    assert.equal(results.runTurn.threadId, 't-new');
    assert.equal(results.continueTurn.ok, true);
    assert.equal(results.continueTurn.threadId, 't1');
    assert.equal(results.stopTurn.ok, true, `stopTurn failed: ${results.stopTurn.error}`);
    assert.equal(results.createEpic.ok, true, `createEpic failed: ${results.createEpic.error}`);
    assert.equal(results.createEpic.epicId, 'epic-new');
    assert.equal(results.emptyPrompt.ok, false);
    assert.equal(results.state.machines.length, 1);
    assert.equal(results.state.machines[0].status, 'connected');
    const seen = await commandSeen;
    assert.equal(seen.command.kind, 'runTurn');
    assert.equal(seen.command.prompt, 'build the thing');
    console.log('ok  live large-thread transfer uses one stable snapshot across chunks');

    for (const [mode, errorPattern] of [
      ['store', /store snapshot read failed/i],
      ['threads', /transcript snapshot read failed/i],
    ]) {
      const modeChanged = host.waitFor('snapshotReadFailureMode');
      host.send(`snapshot-read-failure ${mode}`);
      assert.equal((await modeChanged).mode, mode);
      const failedSnapshot = controller.waitFor('snapshotResult');
      controller.send('snapshot');
      const failed = await failedSnapshot;
      assert.equal(failed.result.ok, false);
      assert.match(failed.result.error, errorPattern);
    }
    const readsRestored = host.waitFor('snapshotReadFailureMode');
    host.send('snapshot-read-restore');
    assert.equal((await readsRestored).mode, null);
    const restoredSnapshot = controller.waitFor('snapshotResult');
    controller.send('snapshot');
    assert.equal((await restoredSnapshot).result.ok, true);
    console.log('ok  snapshot source read failures reach the controller without empty replacement data');
  }

  // Pairing the same controller identity again rotates its device secret. The
  // durable replacement must close sessions authenticated with the old secret,
  // even though the device id and account remain unchanged.
  {
    host.send('pair-again');
    const rotationReady = await host.waitFor('ready');
    const replacementController = spawnRole('controller', {
      ORION_REMOTE_TEST_CODE: rotationReady.code,
      ORION_TEST_USERDATA: path.join(tmpRoot, 'controller'),
    });
    const replacement = await replacementController.waitFor('results', 30_000);
    assert.equal(replacement.results.pair.ok, true, `re-pairing failed: ${replacement.results.pair.error}`);
    const oldState = establishedController.waitFor('state');
    establishedController.send('state');
    const { state: retiredState } = await oldState;
    assert.equal(retiredState.machines[0].status, 'offline');
    establishedController.child.kill();
    establishedController = null;
    console.log('ok  rotating a device secret terminates sessions using the old credential');
  }

  // Host state must show the paired device.
  host.send('state');
  const { state } = await host.waitFor('state');
  assert.equal(state.host.devices.length, 1);
  assert.equal(state.host.listening, true);
  console.log('ok  host records the paired device');

  // Established-session request dispatch: the `models` catalog request, the
  // runTurn accessMode field (valid passed through, unknown dropped), and the
  // catch-all "Unsupported request." answer that keeps unknown types
  // forward-compatible. Uses a raw session client so arbitrary wire messages
  // can be sent with the paired device's credential.
  {
    const net = await import('node:net');
    const {
      REMOTE_PROTOCOL_VERSION,
      SecureChannel,
      confirmationMac,
      createEphemeralKeyPair,
      deriveHandshakeKeys,
      handshakeTranscript,
      macsEqual,
    } = await import('../src/main/remote-crypto.js');
    const persisted = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'host', 'orion-remote-control.json'), 'utf-8')
    );
    const device = persisted.hostDevices[0];

    const socket = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => socket.on('connect', resolve));
    const channel = new SecureChannel(socket, { maxFrame: 4096 });
    const eph = createEphemeralKeyPair();
    const inbox = [];
    const waiters = [];
    channel.onMessage((message, raw) => {
      const entry = { message, raw };
      const waiter = waiters.shift();
      if (waiter) waiter(entry);
      else inbox.push(entry);
    });
    const nextMessage = () =>
      inbox.length > 0
        ? Promise.resolve(inbox.shift())
        : new Promise((resolve) => waiters.push(resolve));

    const helloRaw = channel.send({
      t: 'hello',
      v: REMOTE_PROTOCOL_VERSION,
      mode: 'session',
      deviceId: device.id,
      pub: eph.publicDer.toString('base64'),
      nonce: crypto.randomBytes(16).toString('base64'),
    });
    const ack = await nextMessage();
    assert.equal(ack.message.t, 'helloAck');
    const transcript = handshakeTranscript(helloRaw, ack.raw);
    const keys = deriveHandshakeKeys({
      privateKey: eph.privateKey,
      peerPublicDer: Buffer.from(ack.message.pub, 'base64'),
      psk: Buffer.from(device.secret.value, 'base64'),
      transcript,
      isClient: true,
    });
    channel.send({ t: 'confirm', mac: confirmationMac(keys.macKey, 'client', transcript).toString('base64') });
    const confirm = await nextMessage();
    assert.ok(
      macsEqual(
        confirmationMac(keys.macKey, 'server', transcript),
        Buffer.from(String(confirm.message.mac ?? ''), 'base64')
      )
    );
    channel.enableEncryption(keys);
    channel.setMaxFrame(8 * 1024 * 1024);
    assert.equal((await nextMessage()).message.t, 'welcome');

    channel.send({ t: 'models', reqId: 'models-1' });
    const models = (await nextMessage()).message;
    assert.equal(models.t, 'res');
    assert.equal(models.reqId, 'models-1');
    assert.equal(models.ok, true, `models request failed: ${models.error}`);
    // Exact shapes: the terminal pseudo-model is filtered out and the grok
    // entry's internal `command` field does not leak.
    assert.deepEqual(models.models, [
      {
        id: 'claude:claude-opus-5',
        providerId: 'claude',
        providerLabel: 'Claude',
        label: 'Claude Opus 5',
        slug: 'claude-opus-5',
        shortcut: '⌘2',
        favorite: true,
        available: true,
      },
      {
        id: 'grok:grok-4.5',
        providerId: 'grok',
        providerLabel: 'Grok',
        label: 'Grok 4.5',
        slug: 'grok-4.5',
        available: false,
        unavailableReason: 'Install or authenticate grok on PATH.',
      },
    ]);
    console.log('ok  models request returns the sanitized catalog without the terminal pseudo-model');

    const validAccessSeen = host.waitFor('commandSeen');
    channel.send({
      t: 'runTurn',
      reqId: 'access-1',
      projectId: 'p1',
      prompt: 'run with workspace access',
      accessMode: 'workspace-write',
    });
    assert.equal((await nextMessage()).message.ok, true);
    assert.equal((await validAccessSeen).command.accessMode, 'workspace-write');
    const invalidAccessSeen = host.waitFor('commandSeen');
    channel.send({
      t: 'runTurn',
      reqId: 'access-2',
      projectId: 'p1',
      prompt: 'run with unknown access',
      accessMode: 'root-of-all-evil',
    });
    assert.equal((await nextMessage()).message.ok, true, 'an unknown accessMode must not fail the turn');
    assert.equal((await invalidAccessSeen).command.accessMode, undefined);
    console.log('ok  runTurn passes valid accessMode through and drops unknown values');

    const validEffortSeen = host.waitFor('commandSeen');
    channel.send({
      t: 'runTurn',
      reqId: 'effort-1',
      projectId: 'p1',
      prompt: 'run with high reasoning',
      reasoningEffort: 'high',
      codexServiceTier: 'priority',
      claudeContextWindow: '1m',
    });
    assert.equal((await nextMessage()).message.ok, true);
    const validEffortCommand = (await validEffortSeen).command;
    assert.equal(validEffortCommand.reasoningEffort, 'high');
    assert.equal(validEffortCommand.codexServiceTier, 'priority');
    assert.equal(validEffortCommand.claudeContextWindow, '1m');
    const invalidEffortSeen = host.waitFor('commandSeen');
    channel.send({
      t: 'runTurn',
      reqId: 'effort-2',
      projectId: 'p1',
      prompt: 'run with unknown effort',
      reasoningEffort: 'ludicrous',
      codexServiceTier: 'turbo',
      claudeContextWindow: '10m',
    });
    assert.equal((await nextMessage()).message.ok, true, 'unknown effort fields must not fail the turn');
    const invalidEffortCommand = (await invalidEffortSeen).command;
    assert.equal(invalidEffortCommand.reasoningEffort, undefined);
    assert.equal(invalidEffortCommand.codexServiceTier, undefined);
    assert.equal(invalidEffortCommand.claudeContextWindow, undefined);
    console.log('ok  runTurn passes valid reasoning/tier/context through and drops unknown values');

    channel.send({ t: 'definitely-not-a-request', reqId: 'unknown-1' });
    const unknown = (await nextMessage()).message;
    assert.equal(unknown.t, 'res');
    assert.equal(unknown.reqId, 'unknown-1');
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, 'Unsupported request.');
    console.log('ok  genuinely unknown request types still answer "Unsupported request."');

    socket.destroy();
  }

  // macOS keeps the listener alive after the final renderer closes. Reads can
  // continue, but renderer-owned commands must fail immediately and clearly.
  {
    host.send('renderer-off');
    const rendererState = await host.waitFor('rendererState');
    assert.equal(rendererState.available, false);
    host.send('pair-again');
    const noRendererPairing = await host.waitFor('ready');
    const controller = spawnRole('controller', {
      ORION_REMOTE_TEST_CODE: noRendererPairing.code,
      ORION_TEST_USERDATA: path.join(tmpRoot, 'controller-no-renderer'),
    });
    const { results } = await controller.waitFor('results', 30_000);
    assert.equal(results.snapshot.ok, true, 'read-only snapshots should remain available');
    for (const result of [results.runTurn, results.continueTurn, results.stopTurn]) {
      assert.equal(result.ok, false);
      assert.match(result.error, /Open a Durango Code window/i);
    }
    host.send('renderer-on');
    const restored = await host.waitFor('rendererState');
    assert.equal(restored.available, true);
    controller.child.kill();
    console.log('ok  renderer-owned commands reject immediately when no host window exists');
  }

  // A socket authenticated with code A must not become a pairing session after
  // the user replaces it with code B. Otherwise it can submit `pair`, cancel B,
  // and gain control with a retired code.
  {
    const net = await import('node:net');
    const {
      REMOTE_PROTOCOL_VERSION,
      SecureChannel,
      confirmationMac,
      createEphemeralKeyPair,
      deriveHandshakeKeys,
      handshakeTranscript,
      pairingCodeToPsk,
    } = await import('../src/main/remote-crypto.js');
    host.send('pair-again');
    const challenged = await host.waitFor('ready');
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => {});
    await new Promise((resolve) => socket.on('connect', resolve));
    const channel = new SecureChannel(socket, { maxFrame: 4096 });
    const eph = createEphemeralKeyPair();
    const closed = new Promise((resolve) => channel.onClose(() => resolve('closed')));
    let markConfirmed;
    const confirmed = new Promise((resolve) => {
      markConfirmed = () => resolve('confirmed');
    });
    const helloRaw = channel.send({
      t: 'hello',
      v: REMOTE_PROTOCOL_VERSION,
      mode: 'pair',
      pub: eph.publicDer.toString('base64'),
      nonce: crypto.randomBytes(16).toString('base64'),
    });
    const ack = await new Promise((resolve) => {
      channel.onMessage((message, raw) => {
        if (message.t === 'helloAck') resolve({ message, raw });
        if (message.t === 'confirm') markConfirmed();
      });
      setTimeout(() => resolve(null), 3000);
    });
    assert.ok(ack, 'host should challenge the live pairing code');
    const transcript = handshakeTranscript(helloRaw, ack.raw);
    const keys = deriveHandshakeKeys({
      privateKey: eph.privateKey,
      peerPublicDer: Buffer.from(ack.message.pub, 'base64'),
      psk: pairingCodeToPsk(challenged.code),
      transcript,
      isClient: true,
    });

    host.send('pair-again');
    const replacement = await host.waitFor('ready');
    channel.send({
      t: 'confirm',
      mac: confirmationMac(keys.macKey, 'client', transcript).toString('base64'),
    });
    const outcome = await Promise.race([
      closed,
      confirmed,
      new Promise((resolve) => setTimeout(() => resolve('survived'), 2500)),
    ]);
    assert.equal(outcome, 'closed', 'a retired pairing code must not be confirmed');
    host.send('state');
    const { state: afterReplacement } = await host.waitFor('state');
    assert.equal(afterReplacement.host.pairing?.code, replacement.code, 'code B must remain active');
    console.log('ok  pairing confirmation is bound to the challenged code');
  }

  // Revocation must reach a connection parked between hello and confirm: the
  // attacker holds a valid device secret and only completes the handshake
  // after the user revokes it.
  {
    const {
      REMOTE_PROTOCOL_VERSION,
      SecureChannel,
      confirmationMac,
      createEphemeralKeyPair,
      deriveHandshakeKeys,
      handshakeTranscript,
    } = await import('../src/main/remote-crypto.js');
    const net = await import('node:net');

    // Recover the paired device's secret from the host's on-disk state.
    const hostStateFile = path.join(tmpRoot, 'host', 'orion-remote-control.json');
    const persisted = JSON.parse(fs.readFileSync(hostStateFile, 'utf-8'));
    const device = persisted.hostDevices[0];
    const psk = Buffer.from(device.secret.value, 'base64');

    const socket = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => socket.on('connect', resolve));
    const channel = new SecureChannel(socket, { maxFrame: 4096 });
    const eph = createEphemeralKeyPair();
    const closed = new Promise((resolve) => channel.onClose(() => resolve('closed')));
    let welcomed = null;

    const helloRaw = channel.send({
      t: 'hello',
      v: REMOTE_PROTOCOL_VERSION,
      mode: 'session',
      deviceId: device.id,
      pub: eph.publicDer.toString('base64'),
      nonce: crypto.randomBytes(16).toString('base64'),
    });
    const ack = await new Promise((resolve) => {
      channel.onMessage((message, raw) => {
        if (message.t === 'helloAck') resolve({ message, raw });
        if (message.t === 'welcome') welcomed = message;
      });
      setTimeout(() => resolve(null), 5000);
    });
    assert.ok(ack, 'host should answer hello');
    const transcript = handshakeTranscript(helloRaw, ack.raw);
    const keys = deriveHandshakeKeys({
      privateKey: eph.privateKey,
      peerPublicDer: Buffer.from(ack.message.pub, 'base64'),
      psk,
      transcript,
      isClient: true,
    });

    // Park here: revoke the device, THEN complete the handshake.
    host.send(`revoke ${device.id}`);
    await host.waitFor('revoked');
    channel.send({ t: 'confirm', mac: confirmationMac(keys.macKey, 'client', transcript).toString('base64') });

    const outcome = await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(() => resolve('survived'), 2500)),
    ]);
    assert.equal(outcome, 'closed', 'a parked connection must not survive revocation');
    assert.equal(welcomed, null, 'a revoked device must never receive a welcome');
    console.log('ok  revocation kills a connection parked before confirm');
  }

  // Anonymous probes must not burn the pairing code.
  {
    const net = await import('node:net');
    const { REMOTE_PROTOCOL_VERSION, SecureChannel, createEphemeralKeyPair } = await import(
      '../src/main/remote-crypto.js'
    );
    host.send('pair-again');
    const fresh = await host.waitFor('ready');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const socket = net.connect(port, '127.0.0.1');
      await new Promise((resolve) => socket.on('connect', resolve));
      const channel = new SecureChannel(socket, { maxFrame: 4096 });
      const eph = createEphemeralKeyPair();
      channel.send({
        t: 'hello',
        v: REMOTE_PROTOCOL_VERSION,
        mode: 'pair',
        pub: eph.publicDer.toString('base64'),
        nonce: crypto.randomBytes(16).toString('base64'),
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      socket.destroy();
    }
    host.send('state');
    const { state: after } = await host.waitFor('state');
    assert.ok(after.host.pairing, 'anonymous probes must not destroy the pairing code');
    assert.equal(after.host.pairing.code, fresh.code);
    console.log('ok  anonymous probes cannot burn the pairing code');
  }

  // Sockets parked BEFORE a code exists must not be able to burn it either:
  // they complete a handshake with a garbage MAC the instant one is minted.
  // Only guesses against a live code may count against the attempt cap.
  {
    const net = await import('node:net');
    const { REMOTE_PROTOCOL_VERSION, SecureChannel, createEphemeralKeyPair } = await import(
      '../src/main/remote-crypto.js'
    );
    // Retire the current code so these connections say hello with none active
    // — that is the case the attempt cap must not charge them for.
    host.send('cancel-pairing');
    await host.waitFor('pairingCancelled');
    const parked = [];
    for (let index = 0; index < 5; index += 1) {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('error', () => {});
      await new Promise((resolve) => socket.on('connect', resolve));
      const channel = new SecureChannel(socket, { maxFrame: 4096 });
      const eph = createEphemeralKeyPair();
      channel.send({
        t: 'hello',
        v: REMOTE_PROTOCOL_VERSION,
        mode: 'pair',
        pub: eph.publicDer.toString('base64'),
        nonce: crypto.randomBytes(16).toString('base64'),
      });
      parked.push(channel);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    host.send('pair-again');
    const minted = await host.waitFor('ready');
    for (const channel of parked) {
      channel.send({ t: 'confirm', mac: crypto.randomBytes(32).toString('base64') });
    }
    await new Promise((resolve) => setTimeout(resolve, 400));

    host.send('state');
    const { state: survived } = await host.waitFor('state');
    assert.ok(survived.host.pairing, 'a code must survive confirms from sockets parked before it existed');
    assert.equal(survived.host.pairing.code, minted.code);
    console.log('ok  pre-parked sockets cannot burn a freshly generated code');
  }

  // ...nor may a guess against an OLD code be charged to its replacement: the
  // attempt cap must follow the code that was actually challenged.
  {
    const net = await import('node:net');
    const { REMOTE_PROTOCOL_VERSION, SecureChannel, createEphemeralKeyPair } = await import(
      '../src/main/remote-crypto.js'
    );
    // A code is live now (previous block). Hello against it, then regenerate.
    const stale = [];
    for (let index = 0; index < 5; index += 1) {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('error', () => {});
      await new Promise((resolve) => socket.on('connect', resolve));
      const channel = new SecureChannel(socket, { maxFrame: 4096 });
      const eph = createEphemeralKeyPair();
      channel.send({
        t: 'hello',
        v: REMOTE_PROTOCOL_VERSION,
        mode: 'pair',
        pub: eph.publicDer.toString('base64'),
        nonce: crypto.randomBytes(16).toString('base64'),
      });
      stale.push(channel);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    host.send('pair-again');
    const replacement = await host.waitFor('ready');
    for (const channel of stale) {
      channel.send({ t: 'confirm', mac: crypto.randomBytes(32).toString('base64') });
    }
    await new Promise((resolve) => setTimeout(resolve, 400));

    host.send('state');
    const { state: kept } = await host.waitFor('state');
    assert.ok(kept.host.pairing, 'guesses against a retired code must not burn its replacement');
    assert.equal(kept.host.pairing.code, replacement.code);
    console.log('ok  guesses against a retired code do not burn its replacement');
  }

  // ...but a genuine wrong guess against the LIVE code still trips the cap.
  // This runs against its own host: the tests above deliberately generate
  // handshake failures, and by now this IP has spent its rate-limit budget on
  // the shared host — new connections there are refused before the handshake.
  {
    const net = await import('node:net');
    const {
      REMOTE_PROTOCOL_VERSION,
      SecureChannel,
      confirmationMac,
      createEphemeralKeyPair,
      deriveHandshakeKeys,
      handshakeTranscript,
      pairingCodeToPsk,
    } = await import('../src/main/remote-crypto.js');

    const guessPort = port + 1;
    // 'guess-host' names the data directory only; the child runs as a host.
    const guessHost = spawnRole('guess-host', {
      ORION_REMOTE_TEST_ROLE: 'host',
      ORION_REMOTE_TEST_PORT: String(guessPort),
    });
    await guessHost.waitFor('ready');
    for (let index = 0; index < 5; index += 1) {
      const socket = net.connect(guessPort, '127.0.0.1');
      socket.on('error', () => {});
      await new Promise((resolve) => socket.on('connect', resolve));
      const channel = new SecureChannel(socket, { maxFrame: 4096 });
      const eph = createEphemeralKeyPair();
      const helloRaw = channel.send({
        t: 'hello',
        v: REMOTE_PROTOCOL_VERSION,
        mode: 'pair',
        pub: eph.publicDer.toString('base64'),
        nonce: crypto.randomBytes(16).toString('base64'),
      });
      // A real guess: a well-formed confirm derived from the WRONG code.
      const ack = await new Promise((resolve) => {
        channel.onMessage((message, raw) => {
          if (message.t === 'helloAck') resolve({ message, raw });
        });
        setTimeout(() => resolve(null), 3000);
      });
      if (!ack) break;
      const transcript = handshakeTranscript(helloRaw, ack.raw);
      const keys = deriveHandshakeKeys({
        privateKey: eph.privateKey,
        peerPublicDer: Buffer.from(ack.message.pub, 'base64'),
        psk: pairingCodeToPsk('WRON-GCOD-EWRO-NGCO'),
        transcript,
        isClient: true,
      });
      channel.send({ t: 'confirm', mac: confirmationMac(keys.macKey, 'client', transcript).toString('base64') });
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    guessHost.send('state');
    const { state: burned } = await guessHost.waitFor('state');
    assert.equal(burned.host.pairing, null, 'repeated wrong guesses at the live code must retire it');
    guessHost.send('exit');
    console.log('ok  repeated wrong guesses still retire the live code');
  }

  // Unauthenticated connections must not be able to make the host buffer
  // unbounded data: pre-handshake frames are capped well below the 8 MB
  // post-auth budget, and concurrent connections are capped per IP.
  {
    const net = await import('node:net');
    const sockets = [];
    for (let index = 0; index < 40; index += 1) {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('error', () => {});
      sockets.push(
        new Promise((resolve) => {
          socket.on('connect', () => {
            // Declare a max-size frame, then dribble payload without ever
            // authenticating.
            const header = Buffer.alloc(4);
            header.writeUInt32BE(8 * 1024 * 1024);
            socket.write(header);
            socket.write(Buffer.alloc(512 * 1024));
            resolve(socket);
          });
          socket.on('close', () => resolve(socket));
          setTimeout(() => resolve(socket), 2000);
        })
      );
    }
    await Promise.all(sockets);
    await new Promise((resolve) => setTimeout(resolve, 500));
    host.send('state');
    const { state: stillUp } = await host.waitFor('state');
    assert.equal(stillUp.host.listening, true, 'host must survive an anonymous flood');
    console.log('ok  anonymous flood rejected without taking down the host');
    for (const socket of await Promise.all(sockets)) socket.destroy();
  }

  host.send('exit');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('All remote-control integration tests passed.');
  process.exit(0);
}
