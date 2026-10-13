// Durango identity cutover: the account's native Clerk id changes while the
// desktop session does not. Stored remote-control pairings must follow the
// account to its new id (src/main/remote-control.js migrateRemoteControlUserId)
// so users do not have to re-pair their machines.
//
//   node scripts/test-remote-control-identity.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-remote-identity-'));
process.env.ORION_TEST_USERDATA = userData;
register('./remote-control-loader.mjs', import.meta.url);
const engine = await import('../src/main/remote-control.js');

const stateFile = path.join(userData, 'orion-remote-control.json');
const secret = () => ({ encrypted: false, value: crypto.randomBytes(32).toString('base64') });
fs.writeFileSync(
  stateFile,
  `${JSON.stringify({
    version: 1,
    machineId: 'identity-host',
    machineName: 'Identity host',
    hostDevices: [
      { id: 'controller-old', name: 'Laptop', userId: 'user_old', secret: secret(), pairedAt: null, lastSeenAt: null },
      { id: 'controller-other', name: 'Other', userId: 'user_other', secret: secret(), pairedAt: null, lastSeenAt: null },
    ],
    remoteMachines: [
      { id: 'machine-old', name: 'Desktop', host: null, port: null, relay: true, userId: 'user_old', secret: secret(), pairedAt: null },
      { id: 'machine-lan', name: 'Studio', host: '10.0.0.2', port: 47615, relay: false, userId: 'user_old', secret: secret(), pairedAt: null },
    ],
  }, null, 2)}\n`
);
const before = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
let session = { token: 'desktop-session', user: { id: 'user_new' }, expiresAt: null };

try {
  // 1. A migration requested before the pairing file is loaded is deferred
  //    and applied as part of init (startup ordering race).
  const deferred = await engine.migrateRemoteControlUserId({ fromUserId: 'user_old', toUserId: 'user_new' });
  assert.equal(deferred.deferred, true);
  await engine.initRemoteControl({ readSession: async () => session, readStoreState: async () => null, broadcast: () => {} });
  await engine.waitForRemoteControlPersistence();
  let state = readState();
  assert.deepEqual(state.hostDevices.map((d) => [d.id, d.userId]), [
    ['controller-old', 'user_new'],
    ['controller-other', 'user_other'],
  ]);
  assert.deepEqual(state.remoteMachines.map((m) => [m.id, m.userId]), [
    ['machine-old', 'user_new'],
    ['machine-lan', 'user_new'],
  ]);
  // Secrets, machine identity and addressing survive the rewrite untouched.
  assert.equal(state.machineId, 'identity-host');
  assert.deepEqual(state.hostDevices.map((d) => d.secret), before.hostDevices.map((d) => d.secret));
  assert.deepEqual(state.remoteMachines.map((m) => m.secret), before.remoteMachines.map((m) => m.secret));
  assert.equal(state.remoteMachines[1].host, '10.0.0.2');
  assert.equal(engine.getRemoteControlState().machines.length, 2);

  // 2. Once loaded, a migration is applied immediately and persisted.
  session = { ...session, user: { id: 'user_newer' } };
  const live = await engine.migrateRemoteControlUserId({ fromUserId: 'user_new', toUserId: 'user_newer' });
  assert.equal(live.migrated, 3);
  state = readState();
  assert.equal(state.hostDevices.filter((d) => d.userId === 'user_newer').length, 1);
  assert.equal(state.remoteMachines.filter((m) => m.userId === 'user_newer').length, 2);
  assert.equal(state.hostDevices.find((d) => d.id === 'controller-other').userId, 'user_other');

  // 3. No-ops: same id, missing ids, and ids nothing is paired under.
  assert.equal((await engine.migrateRemoteControlUserId({ fromUserId: 'x', toUserId: 'x' })).migrated, 0);
  assert.equal((await engine.migrateRemoteControlUserId({ fromUserId: null, toUserId: 'x' })).migrated, 0);
  assert.equal((await engine.migrateRemoteControlUserId({ fromUserId: 'nobody', toUserId: 'x' })).migrated, 0);
  assert.deepEqual(readState(), state);
  console.log('remote-control identity migration: ok');
} finally {
  engine.shutdownRemoteControl();
  fs.rmSync(userData, { recursive: true, force: true });
}
