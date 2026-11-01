#!/usr/bin/env node
// Builds the macOS SnapShot helper (native/snapshot-helper/main.swift) into a
// universal arm64 + x86_64 binary at native/snapshot-helper/build/, which
// forge.config.js ships as an extra resource. Packaging runs this from a
// Forge hook; in development the app builds it on first use when swiftc is
// available (src/main/snapshot.js).
//
//   node scripts/build-snapshot-helper.mjs [--if-needed] [--host-only]
//
// --if-needed skips the build when the binary is newer than the source.
// --host-only builds just the current architecture (faster, for dev).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const snapshotHelperSource = path.join(root, 'native', 'snapshot-helper', 'main.swift');
export const snapshotHelperBuildDir = path.join(root, 'native', 'snapshot-helper', 'build');
export const snapshotHelperBinary = path.join(snapshotHelperBuildDir, 'durango-snapshot');
const minimumMacOS = '12.0';

const isFresh = () => {
  try {
    return fs.statSync(snapshotHelperBinary).mtimeMs >= fs.statSync(snapshotHelperSource).mtimeMs;
  } catch {
    return false;
  }
};

export const buildSnapshotHelper = ({ ifNeeded = false, hostOnly = false, log = console.log } = {}) => {
  if (process.platform !== 'darwin') throw new Error('The SnapShot helper only builds on macOS.');
  if (ifNeeded && isFresh()) return snapshotHelperBinary;
  fs.mkdirSync(snapshotHelperBuildDir, { recursive: true });
  const arches = hostOnly ? [process.arch === 'arm64' ? 'arm64' : 'x86_64'] : ['arm64', 'x86_64'];
  const slices = arches.map((arch) => {
    const output = path.join(snapshotHelperBuildDir, `durango-snapshot-${arch}`);
    log?.(`swiftc ${arch} → ${path.relative(root, output)}`);
    execFileSync(
      'xcrun',
      ['swiftc', '-O', '-target', `${arch}-apple-macos${minimumMacOS}`, '-o', output, snapshotHelperSource],
      { stdio: 'inherit' }
    );
    return output;
  });
  const staged = `${snapshotHelperBinary}.tmp`;
  if (slices.length === 1) fs.copyFileSync(slices[0], staged);
  else execFileSync('lipo', ['-create', '-output', staged, ...slices], { stdio: 'inherit' });
  fs.chmodSync(staged, 0o755);
  fs.renameSync(staged, snapshotHelperBinary);
  for (const slice of slices) fs.rmSync(slice, { force: true });
  log?.(`built ${path.relative(root, snapshotHelperBinary)}`);
  return snapshotHelperBinary;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSnapshotHelper({
    ifNeeded: process.argv.includes('--if-needed'),
    hostOnly: process.argv.includes('--host-only'),
  });
}
