'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NODE_PTY_BUILD_ONLY_ENTRIES = [
  'binding.gyp',
  'deps',
  'src',
  'third_party',
  'scripts',
  'typings',
  'node-addon-api',
  'bin',
  'README.md',
];

const NODE_PTY_BUILD_ONLY_SET = new Set(NODE_PTY_BUILD_ONLY_ENTRIES);

const NODE_PTY_RELEASE_JUNK_ENTRIES = [
  'obj.target',
  'node-addon-api',
  '.deps',
  '.forge-meta',
];

const WINDOWS_DEBUG_ARTIFACT_PATTERN = /\.(?:pdb|ilk|exp|lib|iobj|ipdb)$/i;
const NODE_PTY_LIB_NON_RUNTIME_PATTERN = /(?:\.test\.js|\.js\.map)$/i;

const removeMatchingFiles = (dirPath, pattern) => {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      removeMatchingFiles(entryPath, pattern);
    } else if (pattern.test(entry.name)) {
      fs.rmSync(entryPath, { force: true });
    }
  }
};

/**
 * Returns whether a `node-pty/prebuilds/<entry>` directory belongs to the
 * target platform/arch being packaged.
 */
const isTargetPrebuildDir = (dirName, platform, arch) => {
  if (arch === 'universal') {
    return dirName.startsWith(`${platform}-`);
  }
  return dirName === `${platform}-${arch}`;
};

/**
 * Filter passed to `fs.cpSync` when staging `node_modules/node-pty` into the
 * packager build directory (before `@electron/rebuild` runs).
 *
 * Keeps source files needed by `node-gyp` on macOS/Linux while skipping:
 * - prebuilds for non-target platforms/architectures (e.g. 58 MB of Windows
 *   prebuilds on macOS/Linux, or wrong-arch Windows prebuilds),
 * - Windows `.pdb` debug symbols inside kept prebuilds,
 * - any stale host-ABI `build/` directory from `node_modules`,
 * - build-only entries on Windows (where `rebuildConfig` ignores `node-pty`).
 */
const shouldCopyNodePtyEntry = (srcRoot, srcPath, platform, arch) => {
  const rel = path.relative(srcRoot, srcPath);
  if (!rel) return true;
  const parts = rel.split(path.sep);
  if (parts[0] === 'build') {
    return false;
  }
  if (platform === 'win32' && NODE_PTY_BUILD_ONLY_SET.has(parts[0])) {
    return false;
  }
  if (parts[0] === 'prebuilds') {
    if (parts.length === 1) return true;
    if (!isTargetPrebuildDir(parts[1], platform, arch)) return false;
    if (parts.length > 2 && /\.pdb$/i.test(parts[parts.length - 1])) return false;
  }
  return true;
};

/**
 * Restores the executable bit on `spawn-helper` binaries inside `node-pty` on
 * Unix platforms (npm strips exec bits from prebuild tarballs).
 */
const restoreSpawnHelperPermissions = (ptyDir, platform) => {
  if (platform === 'win32') return;
  const candidates = [path.join(ptyDir, 'build', 'Release', 'spawn-helper')];
  const prebuildsDir = path.join(ptyDir, 'prebuilds');
  if (fs.existsSync(prebuildsDir)) {
    for (const entry of fs.readdirSync(prebuildsDir)) {
      candidates.push(path.join(prebuildsDir, entry, 'spawn-helper'));
    }
  }
  for (const helper of candidates) {
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
    }
  }
};

/**
 * Removes build-only files from the staged app after `@electron/rebuild`
 * finishes and before `@electron/packager` creates `app.asar`:
 * - `node_modules/node-addon-api` (C++ headers only needed while node-gyp runs),
 * - `node_modules/node-pty` build sources, Makefiles, intermediate objects,
 *   unused `@electron/rebuild` `bin/` copy, `lib/` test/sourcemap files,
 *   unreachable `prebuilds/` when `build/Release` was compiled, non-target
 *   prebuilds, and `.pdb` debug symbols.
 */
const prunePackagedBuild = (buildPath, platform, arch) => {
  fs.rmSync(path.join(buildPath, 'node_modules', 'node-addon-api'), {
    recursive: true,
    force: true,
  });

  const ptyDir = path.join(buildPath, 'node_modules', 'node-pty');
  if (!fs.existsSync(ptyDir)) return;

  for (const entry of NODE_PTY_BUILD_ONLY_ENTRIES) {
    fs.rmSync(path.join(ptyDir, entry), { recursive: true, force: true });
  }

  const libDir = path.join(ptyDir, 'lib');
  if (fs.existsSync(libDir)) {
    removeMatchingFiles(libDir, NODE_PTY_LIB_NON_RUNTIME_PATTERN);
  }

  const buildDir = path.join(ptyDir, 'build');
  if (fs.existsSync(buildDir)) {
    const releaseDir = path.join(buildDir, 'Release');
    if (fs.existsSync(releaseDir)) {
      for (const entry of fs.readdirSync(buildDir)) {
        if (entry !== 'Release') {
          fs.rmSync(path.join(buildDir, entry), { recursive: true, force: true });
        }
      }
      for (const entry of NODE_PTY_RELEASE_JUNK_ENTRIES) {
        fs.rmSync(path.join(releaseDir, entry), { recursive: true, force: true });
      }
      for (const entry of fs.readdirSync(releaseDir)) {
        if (WINDOWS_DEBUG_ARTIFACT_PATTERN.test(entry)) {
          fs.rmSync(path.join(releaseDir, entry), { recursive: true, force: true });
        }
      }
      if (fs.readdirSync(releaseDir).length === 0) {
        fs.rmSync(buildDir, { recursive: true, force: true });
      }
    } else {
      fs.rmSync(buildDir, { recursive: true, force: true });
    }
  }

  // `node-pty/lib/utils.js` always resolves `build/Release` before `prebuilds/`.
  // When `@electron/rebuild` produced the native binary (plus `spawn-helper` on
  // macOS) under `build/Release/`, drop `prebuilds/` so unreachable Mach-O
  // binaries are not shipped or code-signed.
  const hasRebuiltPty =
    platform !== 'win32' &&
    fs.existsSync(path.join(ptyDir, 'build', 'Release', 'pty.node')) &&
    (platform !== 'darwin' || fs.existsSync(path.join(ptyDir, 'build', 'Release', 'spawn-helper')));

  const prebuildsDir = path.join(ptyDir, 'prebuilds');
  if (fs.existsSync(prebuildsDir)) {
    if (hasRebuiltPty) {
      fs.rmSync(prebuildsDir, { recursive: true, force: true });
    } else {
      for (const dirName of fs.readdirSync(prebuildsDir)) {
        const dirPath = path.join(prebuildsDir, dirName);
        if (!isTargetPrebuildDir(dirName, platform, arch)) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          continue;
        }
        if (fs.statSync(dirPath).isDirectory()) {
          removeMatchingFiles(dirPath, /\.pdb$/i);
        }
      }
      if (fs.readdirSync(prebuildsDir).length === 0) {
        fs.rmSync(prebuildsDir, { recursive: true, force: true });
      }
    }
  }

  restoreSpawnHelperPermissions(ptyDir, platform);
};

module.exports = {
  isTargetPrebuildDir,
  prunePackagedBuild,
  restoreSpawnHelperPermissions,
  shouldCopyNodePtyEntry,
};
