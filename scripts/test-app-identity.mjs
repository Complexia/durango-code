// Proves the Durango Code rebrand keeps installed users' data and secrets:
//
// 1. Path logic (plain node): the internal "Orion" name and the legacy
//    userData path are pinned no matter what productName says, and the
//    packaging config keeps the bundle id while showing "Durango Code".
// 2. Keychain probe (macOS, real Electron): an app encrypts with safeStorage
//    under an old name, then the same app relaunched with a NEW productName
//    plus pinInternalAppIdentity() must resolve the same userData and decrypt
//    the value. A control run without the pin must NOT be able to decrypt
//    (it gets a fresh "<new name> Safe Storage" keychain item), which shows
//    the pin is what carries the secret across. The probe uses throwaway
//    names and deletes its keychain items and userData directories; it never
//    touches the real "Orion Safe Storage" item.
//
// Skip the probe with --skip-keychain or ORION_SKIP_KEYCHAIN_PROBE=1.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  APP_BUNDLE_ID,
  INTERNAL_APP_NAME,
  PRODUCT_DISPLAY_NAME,
  devUserDataPath,
  legacyUserDataPath,
  pinInternalAppIdentity,
  safeStorageKeychainService,
} from '../src/main/app-identity.js';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), 'utf8');

// --- 1. Path logic and packaging config ------------------------------------

const appData = '/Users/someone/Library/Application Support';
assert.equal(INTERNAL_APP_NAME, 'Orion');
assert.equal(PRODUCT_DISPLAY_NAME, 'Durango Code');
assert.equal(APP_BUNDLE_ID, 'com.complexia.orion');
assert.equal(legacyUserDataPath(appData), path.join(appData, 'Orion'));
assert.equal(devUserDataPath(legacyUserDataPath(appData)), path.join(appData, 'Orion (dev)'));
assert.equal(safeStorageKeychainService(), 'Orion Safe Storage');

const fakeApp = () => {
  const paths = { appData, userData: path.join(appData, 'Durango Code') };
  let name = 'Durango Code';
  const calls = [];
  return {
    calls,
    getName: () => name,
    setName: (value) => { calls.push(['setName', value]); name = value; },
    getPath: (key) => paths[key],
    setPath: (key, value) => { calls.push(['setPath', key, value]); paths[key] = value; },
  };
};
{
  const app = fakeApp();
  const pinned = pinInternalAppIdentity(app);
  assert.deepEqual(pinned, { name: 'Orion', userDataPath: path.join(appData, 'Orion') });
  assert.deepEqual(app.calls[0], ['setName', 'Orion'], 'the name is pinned before userData is resolved');
}

const packageJson = JSON.parse(read('package.json'));
assert.equal(packageJson.productName, 'Durango Code');
const forgeConfig = require(path.join(rootDir, 'forge.config.js'));
assert.equal(forgeConfig.packagerConfig.name, 'Durango Code');
assert.equal(forgeConfig.packagerConfig.appBundleId, 'com.complexia.orion', 'bundle id must never change');
assert.equal(forgeConfig.packagerConfig.extendInfo.CFBundleDisplayName, 'Durango Code');
assert.ok(!/orion/i.test(forgeConfig.packagerConfig.extendInfo.NSAppleEventsUsageDescription));
const dmg = forgeConfig.makers.find((maker) => maker.name === '@electron-forge/maker-dmg');
assert.equal(dmg.config.title, 'Durango Code Installer');

// The pin must be the first module main.js evaluates so no other module's
// top-level code can resolve userData (or touch safeStorage) before it.
const mainSource = read('src/main.js');
const firstImport = mainSource.match(/^import\s[^;]*?from\s+'([^']+)'|^import\s+'([^']+)'/m);
assert.equal(firstImport?.[2] ?? firstImport?.[1], './main/pin-app-identity.js');
assert.match(mainSource, /devUserDataPath\(liveUserData\)/, 'dev profile stays "<legacy> (dev)"');
assert.doesNotMatch(mainSource, /app\.setName\('Durango/, 'the internal app name must stay Orion');

// Internal file names and protocols stay put.
const pathsSource = read('src/main/paths.js');
for (const literal of ["'orion-store.json'", "'orion-threads.json'", "'orion-threads'", "'orion-account-session.json'", "'orion-attachment'", "appProtocol = 'orion'"]) {
  assert.ok(pathsSource.includes(literal), `paths.js keeps ${literal}`);
}
// Web origin: code.durango.sh is canonical, orioncode.xyz is the same service.
const webOrigin = await import('../src/main/web-origin.js');
assert.equal(webOrigin.DEFAULT_PACKAGED_WEB_URL, 'https://code.durango.sh');
assert.equal(webOrigin.DEFAULT_DEV_WEB_URL, 'http://localhost:3000');
assert.equal(webOrigin.DEFAULT_UPDATE_FEED_URL, 'https://code.durango.sh/api/update/macos');
assert.equal(webOrigin.isSameWebOrigin('https://orioncode.xyz', 'https://code.durango.sh/'), true);
assert.equal(webOrigin.isSameWebOrigin('https://code.durango.sh', 'https://code.durango.sh'), true);
assert.equal(webOrigin.isSameWebOrigin('http://localhost:3000', 'https://code.durango.sh'), false);
assert.equal(webOrigin.isSameWebOrigin('https://orioncode.xyz.evil.example', 'https://code.durango.sh'), false);
assert.equal(webOrigin.isSameWebOrigin(undefined, 'https://code.durango.sh'), false);

console.log('app identity: path logic and packaging config OK');

// --- 2. Real Electron safeStorage probe (macOS) ------------------------------

const skipProbe = process.argv.includes('--skip-keychain') || process.env.ORION_SKIP_KEYCHAIN_PROBE === '1';
if (process.platform !== 'darwin' || skipProbe) {
  console.log(`app identity: keychain probe skipped (${process.platform !== 'darwin' ? 'not macOS' : 'requested'})`);
  process.exit(0);
}

const { build } = await import('esbuild');
const electronPath = require('electron');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-identity-probe-'));
const suffix = crypto.randomBytes(4).toString('hex');
const legacyName = `OrionIdentityProbe${suffix}`;
const rebrandedName = `Durango Code Identity Probe ${suffix}`;
const realAppData = path.join(os.homedir(), 'Library', 'Application Support');
const keychainServices = [safeStorageKeychainService(legacyName), safeStorageKeychainService(rebrandedName)];

const keychainItemExists = (service) =>
  spawnSync('security', ['find-generic-password', '-s', service], { stdio: 'ignore', timeout: 15000 }).status === 0;

const cleanup = () => {
  for (const service of keychainServices) {
    for (let attempt = 0; attempt < 3 && keychainItemExists(service); attempt += 1) {
      spawnSync('security', ['delete-generic-password', '-s', service], { stdio: 'ignore', timeout: 15000 });
    }
  }
  for (const name of [legacyName, rebrandedName]) {
    fs.rmSync(path.join(realAppData, name), { recursive: true, force: true });
  }
  fs.rmSync(workDir, { recursive: true, force: true });
};

try {
  const bundlePath = path.join(workDir, 'main.cjs');
  await build({
    entryPoints: [path.join(rootDir, 'scripts', 'app-identity-probe.mjs')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent',
  });

  let phase = 0;
  const runProbe = (productName, config) => {
    phase += 1;
    const appDir = path.join(workDir, `app-${phase}`);
    fs.mkdirSync(appDir);
    fs.copyFileSync(bundlePath, path.join(appDir, 'main.cjs'));
    fs.writeFileSync(
      path.join(appDir, 'package.json'),
      JSON.stringify({ name: 'orion-identity-probe', productName, version: '0.0.0', main: 'main.cjs' })
    );
    const resultPath = path.join(workDir, `result-${phase}.json`);
    const run = spawnSync(electronPath, [appDir], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ORION_IDENTITY_PROBE: JSON.stringify({ ...config, resultPath }) },
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.ok(fs.existsSync(resultPath), `probe ${phase} produced no result (status ${run.status}): ${run.stderr}`);
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  };

  const plaintext = `durango-rebrand-${suffix}`;
  // Installed build: productName is the old name, nothing pinned.
  const original = runProbe(legacyName, { mode: 'encrypt', plaintext });
  assert.equal(original.encryptionAvailable, true, 'safeStorage unavailable; is the login keychain unlocked?');
  assert.equal(original.name, legacyName);
  assert.equal(original.userData, path.join(realAppData, legacyName));
  assert.ok(original.ciphertext && !original.error, original.error);
  assert.ok(keychainItemExists(safeStorageKeychainService(legacyName)), 'old-name keychain item created');

  // Updated build: new productName, internal identity pinned.
  const updated = runProbe(rebrandedName, {
    mode: 'decrypt', ciphertext: original.ciphertext, pin: true, internalName: legacyName,
  });
  assert.equal(updated.startupName, rebrandedName, 'Electron picked up the new productName');
  assert.equal(updated.name, legacyName);
  assert.equal(updated.userData, original.userData, 'userData resolves to the legacy path');
  assert.equal(updated.error, undefined, `decrypt failed under the pinned name: ${updated.error}`);
  assert.equal(updated.plaintext, plaintext, 'safeStorage decrypts the value encrypted under the old name');
  assert.equal(
    keychainItemExists(safeStorageKeychainService(rebrandedName)),
    false,
    'the pinned build must not create a keychain item under the new name'
  );

  // Control: the new productName without the pin loses the secret.
  const unpinned = runProbe(rebrandedName, { mode: 'decrypt', ciphertext: original.ciphertext });
  assert.equal(unpinned.name, rebrandedName);
  assert.notEqual(unpinned.userData, original.userData);
  assert.notEqual(unpinned.plaintext, plaintext, 'control run unexpectedly decrypted without the pin');
  console.log(
    `app identity: keychain probe OK (pinned build decrypted; unpinned control ${unpinned.error ? `failed: ${unpinned.error}` : 'returned garbage'})`
  );
} finally {
  cleanup();
}
