import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  prunePackagedBuild,
  restoreSpawnHelperPermissions,
  shouldCopyNodePtyEntry,
} = require('./packaging-prune.cjs');

const writeFiles = (root, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
};

const listRelativeFiles = (root) => {
  const results = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else results.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return results.sort();
};

const createFakeNodePtySource = (root) => {
  const ptySrc = path.join(root, 'node_modules', 'node-pty');
  writeFiles(ptySrc, {
    'package.json': '{"name":"node-pty","main":"./lib/index.js"}',
    'LICENSE': 'MIT',
    'README.md': 'readme',
    'binding.gyp': '{}',
    'lib/index.js': 'module.exports = {};',
    'lib/index.js.map': '{}',
    'lib/unixTerminal.js': 'module.exports = {};',
    'lib/unixTerminal.test.js': 'test',
    'lib/unixTerminal.test.js.map': '{}',
    'lib/windowsPtyAgent.js': 'module.exports = {};',
    'lib/worker/conoutSocketWorker.js': '',
    'lib/worker/conoutSocketWorker.js.map': '{}',
    'src/unix/pty.cc': '',
    'deps/winpty/src/winpty.cc': '',
    'third_party/conpty/1.23/win10-x64/conpty.dll': 'dup',
    'third_party/conpty/1.23/win10-arm64/OpenConsole.exe': 'dup',
    'scripts/prebuild.js': '',
    'typings/node-pty.d.ts': '',
    'node-addon-api/node_addon_api.target.mk': '',
    'build/Makefile': 'stale host build',
    'build/Release/pty.node': 'stale host abi binary',
    'prebuilds/darwin-arm64/pty.node': 'mac-arm64-pty',
    'prebuilds/darwin-arm64/spawn-helper': 'mac-arm64-helper',
    'prebuilds/darwin-x64/pty.node': 'mac-x64-pty',
    'prebuilds/darwin-x64/spawn-helper': 'mac-x64-helper',
    'prebuilds/win32-x64/pty.node': 'win-x64-pty',
    'prebuilds/win32-x64/pty.pdb': 'win-x64-pdb',
    'prebuilds/win32-x64/conpty.node': 'win-x64-conpty',
    'prebuilds/win32-x64/conpty.pdb': 'win-x64-conpty-pdb',
    'prebuilds/win32-x64/conpty_console_list.node': 'win-x64-list',
    'prebuilds/win32-x64/conpty_console_list.pdb': 'win-x64-list-pdb',
    'prebuilds/win32-x64/winpty.dll': 'win-x64-dll',
    'prebuilds/win32-x64/winpty.pdb': 'win-x64-winpty-pdb',
    'prebuilds/win32-x64/winpty-agent.exe': 'win-x64-agent',
    'prebuilds/win32-x64/winpty-agent.pdb': 'win-x64-agent-pdb',
    'prebuilds/win32-x64/conpty/conpty.dll': 'win-x64-conpty-dll',
    'prebuilds/win32-x64/conpty/OpenConsole.exe': 'win-x64-openconsole',
    'prebuilds/win32-arm64/pty.node': 'win-arm64-pty',
    'prebuilds/win32-arm64/pty.pdb': 'win-arm64-pdb',
    'prebuilds/win32-arm64/conpty/conpty.dll': 'win-arm64-conpty-dll',
  });
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(ptySrc, 'prebuilds/darwin-arm64/spawn-helper'), 0o644);
    fs.chmodSync(path.join(ptySrc, 'prebuilds/darwin-x64/spawn-helper'), 0o644);
  }
  return ptySrc;
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-packaging-prune-test-'));
try {
  const srcRoot = path.join(tmpRoot, 'source');
  const ptySrc = createFakeNodePtySource(srcRoot);

  // 1. Linux x64: no prebuilds kept, rebuilt build/Release/pty.node kept, lib tests/maps & node-addon-api removed.
  {
    const buildPath = path.join(tmpRoot, 'build-linux-x64');
    const ptyDest = path.join(buildPath, 'node_modules', 'node-pty');
    writeFiles(path.join(buildPath, 'node_modules', 'node-addon-api'), { 'napi.h': '// header' });
    fs.cpSync(ptySrc, ptyDest, {
      recursive: true,
      dereference: true,
      filter: (entryPath) => shouldCopyNodePtyEntry(ptySrc, entryPath, 'linux', 'x64'),
    });
    assert.ok(fs.existsSync(path.join(ptyDest, 'binding.gyp')), 'linux copy keeps binding.gyp for rebuild');
    assert.ok(!fs.existsSync(path.join(ptyDest, 'build')), 'linux copy skips stale host build/');
    assert.ok(!fs.existsSync(path.join(ptyDest, 'prebuilds', 'win32-x64')), 'linux copy skips win32 prebuilds');

    // Simulate @electron/rebuild output on Linux
    writeFiles(ptyDest, {
      'build/Makefile': 'mk',
      'build/config.gypi': '{}',
      'build/Release/pty.node': 'electron-linux-x64-pty',
      'build/Release/obj.target/pty.node': 'dup',
      'build/Release/node-addon-api/stamp': '',
      'bin/linux-x64-146/node-pty.node': 'dup-bin',
    });
    prunePackagedBuild(buildPath, 'linux', 'x64');

    assert.ok(!fs.existsSync(path.join(buildPath, 'node_modules', 'node-addon-api')), 'node-addon-api removed');
    assert.deepEqual(listRelativeFiles(ptyDest), [
      'LICENSE',
      'build/Release/pty.node',
      'lib/index.js',
      'lib/unixTerminal.js',
      'lib/windowsPtyAgent.js',
      'lib/worker/conoutSocketWorker.js',
      'package.json',
    ]);
  }

  // 2. macOS arm64 (rebuilt): keeps build/Release/{pty.node,spawn-helper} with 0755; drops unreachable prebuilds/.
  {
    const buildPath = path.join(tmpRoot, 'build-darwin-arm64');
    const ptyDest = path.join(buildPath, 'node_modules', 'node-pty');
    writeFiles(path.join(buildPath, 'node_modules', 'node-addon-api'), { 'napi.h': '// header' });
    fs.cpSync(ptySrc, ptyDest, {
      recursive: true,
      dereference: true,
      filter: (entryPath) => shouldCopyNodePtyEntry(ptySrc, entryPath, 'darwin', 'arm64'),
    });
    restoreSpawnHelperPermissions(ptyDest, 'darwin');

    // Simulate @electron/rebuild output on macOS
    writeFiles(ptyDest, {
      'build/Release/pty.node': 'electron-darwin-arm64-pty',
      'build/Release/spawn-helper': 'electron-darwin-arm64-helper',
      'build/Release/obj.target/pty.node': 'dup',
      'build/Makefile': 'mk',
    });
    if (process.platform !== 'win32') {
      fs.chmodSync(path.join(ptyDest, 'build/Release/spawn-helper'), 0o644);
    }
    prunePackagedBuild(buildPath, 'darwin', 'arm64');

    assert.ok(!fs.existsSync(path.join(buildPath, 'node_modules', 'node-addon-api')), 'node-addon-api removed');
    assert.deepEqual(listRelativeFiles(ptyDest), [
      'LICENSE',
      'build/Release/pty.node',
      'build/Release/spawn-helper',
      'lib/index.js',
      'lib/unixTerminal.js',
      'lib/windowsPtyAgent.js',
      'lib/worker/conoutSocketWorker.js',
      'package.json',
    ]);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(ptyDest, 'build/Release/spawn-helper')).mode & 0o777, 0o755);
    }
  }

  // 3. macOS arm64 (prebuild fallback when build/Release is absent or missing spawn-helper):
  // removes any incomplete build/ so it cannot shadow prebuilds/darwin-arm64 (with 0755).
  {
    const buildPath = path.join(tmpRoot, 'build-darwin-arm64-prebuild');
    const ptyDest = path.join(buildPath, 'node_modules', 'node-pty');
    fs.cpSync(ptySrc, ptyDest, {
      recursive: true,
      dereference: true,
      filter: (entryPath) => shouldCopyNodePtyEntry(ptySrc, entryPath, 'darwin', 'arm64'),
    });
    // Simulate incomplete rebuild (pty.node without spawn-helper)
    writeFiles(ptyDest, { 'build/Release/pty.node': 'incomplete-rebuild' });
    prunePackagedBuild(buildPath, 'darwin', 'arm64');
    assert.deepEqual(listRelativeFiles(ptyDest), [
      'LICENSE',
      'lib/index.js',
      'lib/unixTerminal.js',
      'lib/windowsPtyAgent.js',
      'lib/worker/conoutSocketWorker.js',
      'package.json',
      'prebuilds/darwin-arm64/pty.node',
      'prebuilds/darwin-arm64/spawn-helper',
    ]);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(ptyDest, 'prebuilds/darwin-arm64/spawn-helper')).mode & 0o777, 0o755);
    }
  }

  // 4. Windows x64: skips build-only dirs during copy; keeps only win32-x64 runtime binaries (including conpty/conpty.dll + OpenConsole.exe), drops .pdb, win32-arm64, darwin-*.
  {
    const buildPath = path.join(tmpRoot, 'build-win32-x64');
    const ptyDest = path.join(buildPath, 'node_modules', 'node-pty');
    fs.cpSync(ptySrc, ptyDest, {
      recursive: true,
      dereference: true,
      filter: (entryPath) => shouldCopyNodePtyEntry(ptySrc, entryPath, 'win32', 'x64'),
    });
    assert.ok(!fs.existsSync(path.join(ptyDest, 'third_party')), 'win32 copy skips build-only third_party/');
    assert.ok(!fs.existsSync(path.join(ptyDest, 'deps')), 'win32 copy skips build-only deps/');
    prunePackagedBuild(buildPath, 'win32', 'x64');
    assert.deepEqual(listRelativeFiles(ptyDest), [
      'LICENSE',
      'lib/index.js',
      'lib/unixTerminal.js',
      'lib/windowsPtyAgent.js',
      'lib/worker/conoutSocketWorker.js',
      'package.json',
      'prebuilds/win32-x64/conpty.node',
      'prebuilds/win32-x64/conpty/OpenConsole.exe',
      'prebuilds/win32-x64/conpty/conpty.dll',
      'prebuilds/win32-x64/conpty_console_list.node',
      'prebuilds/win32-x64/pty.node',
      'prebuilds/win32-x64/winpty-agent.exe',
      'prebuilds/win32-x64/winpty.dll',
    ]);
  }

  // 5. Verify forge.config.js invariants and icon source parity.
  {
    const forgeConfig = require('../forge.config.js');
    assert.ok(
      !forgeConfig.packagerConfig.extraResource.some((entry) => path.basename(entry) === 'icon.png'),
      'extraResource must not duplicate icon.png',
    );
    assert.notEqual(
      forgeConfig.packagerConfig.prune,
      false,
      'packagerConfig.prune must stay enabled so packageAfterPrune runs',
    );
    assert.equal(typeof forgeConfig.hooks.packageAfterPrune, 'function', 'packageAfterPrune hook must be registered');

    const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const assetsIcon = fs.readFileSync(path.join(codeDir, 'assets', 'icon.png'));
    const publicIcon = fs.readFileSync(path.join(codeDir, 'public', 'icon.png'));
    assert.ok(
      assetsIcon.equals(publicIcon),
      'assets/icon.png (dev/deb) and public/icon.png (packaged/renderer) must stay identical',
    );
  }

  console.log('Packaging prune tests passed.');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
