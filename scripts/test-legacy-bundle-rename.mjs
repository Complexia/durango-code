import assert from 'node:assert/strict';
import { bundlePathFromExe, planLegacyBundleRename } from '../src/main/legacy-bundle-rename.js';

const exe = '/Applications/Orion.app/Contents/MacOS/Durango Code';
const base = { platform: 'darwin', isPackaged: true, exePath: exe, env: {}, exists: () => false, isWritableDir: () => true };

assert.equal(bundlePathFromExe(exe), '/Applications/Orion.app');
assert.equal(bundlePathFromExe('/usr/local/bin/electron'), null);

assert.deepEqual(planLegacyBundleRename(base), {
  action: 'rename',
  from: '/Applications/Orion.app',
  to: '/Applications/Durango Code.app',
  execPath: '/Applications/Durango Code.app/Contents/MacOS/Durango Code',
});

// User-level Applications folders work the same way.
assert.equal(planLegacyBundleRename({ ...base, exePath: '/Users/me/Applications/Orion.app/Contents/MacOS/Durango Code' }).to,
  '/Users/me/Applications/Durango Code.app');

const reason = (overrides) => planLegacyBundleRename({ ...base, ...overrides }).reason;
assert.equal(reason({ platform: 'linux' }), 'not-macos');
assert.equal(reason({ isPackaged: false }), 'not-packaged');
assert.equal(reason({ env: { DURANGO_CODE_SKIP_BUNDLE_RENAME: '1' } }), 'disabled');
assert.equal(reason({ exePath: '/Applications/Durango Code.app/Contents/MacOS/Durango Code' }), 'already-renamed');
assert.equal(reason({ exePath: '/Volumes/Durango Code/Orion.app/Contents/MacOS/Durango Code' }), 'transient-location');
assert.equal(reason({ exePath: '/private/var/folders/x/AppTranslocation/ABC/d/Orion.app/Contents/MacOS/Durango Code' }), 'transient-location');
assert.equal(reason({ exists: (p) => p === '/Applications/Durango Code.app' }), 'target-exists');
assert.equal(reason({ isWritableDir: () => false }), 'not-writable');

console.log('legacy bundle rename: ok');
