// The host's ufw check (src/main/remote-control.js ufwBlocksPort): Settings
// tells a Linux host whose firewall drops the remote-control port how to open
// it, because machines on its network otherwise reach it only through the
// (much slower) internet relay.
//
//   node --no-warnings scripts/test-remote-firewall.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

process.env.ORION_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-remote-firewall-'));
register('./remote-control-loader.mjs', import.meta.url);
const { ufwBlocksPort } = await import('../src/main/remote-control.js');

const enabled = 'ENABLED=yes\nLOGLEVEL=low\n';
const dropDefaults = 'DEFAULT_INPUT_POLICY="DROP"\nDEFAULT_OUTPUT_POLICY="ACCEPT"\n';
// What Omarchy ships: LocalSend and Docker DNS open, nothing else.
const omarchyRules = [
  '### tuple ### allow udp 53317 0.0.0.0/0 any 0.0.0.0/0 in',
  '-A ufw-user-input -p udp --dport 53317 -j ACCEPT',
  '### tuple ### allow tcp 53317 0.0.0.0/0 any 0.0.0.0/0 in',
  '-A ufw-user-input -p tcp --dport 53317 -j ACCEPT',
  '### tuple ### allow udp 53 172.17.0.1 any 172.16.0.0/12 in comment=616c6c6f772d646f636b65722d646e73',
].join('\n');

assert.equal(ufwBlocksPort({ conf: enabled, rules: omarchyRules, defaults: dropDefaults }, 47615), true, 'Omarchy defaults drop the port');
assert.equal(ufwBlocksPort({ conf: 'ENABLED=no\n', rules: omarchyRules, defaults: dropDefaults }, 47615), false, 'ufw off');
assert.equal(
  ufwBlocksPort({ conf: enabled, rules: omarchyRules, defaults: 'DEFAULT_INPUT_POLICY="ACCEPT"\n' }, 47615),
  false,
  'incoming accepted by default'
);
const allowRule = (tuple) => `${omarchyRules}\n### tuple ### ${tuple}\n`;
for (const tuple of [
  'allow tcp 47615 0.0.0.0/0 any 0.0.0.0/0 in',
  'allow any 47615 0.0.0.0/0 any 0.0.0.0/0 in',
  'allow tcp 47000:48000 0.0.0.0/0 any 0.0.0.0/0 in',
  'allow tcp 22,47615 0.0.0.0/0 any 0.0.0.0/0 in',
  'allow any any 0.0.0.0/0 any 192.168.1.0/24 in',
]) {
  assert.equal(ufwBlocksPort({ conf: enabled, rules: allowRule(tuple), defaults: dropDefaults }, 47615), false, tuple);
}
for (const tuple of [
  'deny tcp 47615 0.0.0.0/0 any 0.0.0.0/0 in',
  'allow udp 47615 0.0.0.0/0 any 0.0.0.0/0 in',
  'allow tcp 47615 0.0.0.0/0 any 0.0.0.0/0 out',
]) {
  assert.equal(ufwBlocksPort({ conf: enabled, rules: allowRule(tuple), defaults: dropDefaults }, 47615), true, tuple);
}
console.log('ok  the ufw check finds a dropped remote-control port and the rules that open it');
fs.rmSync(process.env.ORION_TEST_USERDATA, { recursive: true, force: true });
