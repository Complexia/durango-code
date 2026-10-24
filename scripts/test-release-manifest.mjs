import assert from 'node:assert/strict';
import {
  buildLegacyMacManifest,
  buildPlatformManifest,
  isPrereleaseVersion,
  isReleaseArtifact,
  isReleaseVersion,
  platformLatestKey,
  platformManifestKey,
  releaseArtifactLocation,
  releaseOsName,
  selectPlatformArtifacts,
} from './release-manifest.mjs';

const artifact = (osName, arch, format, version = '1.2.3') => ({
  format,
  platform: osName,
  arch,
  version,
  ...releaseArtifactLocation({ version, osName, arch, format }),
  size: 10,
  sha256: `${format}-sha256`,
  sha512: `${format}-sha512`,
  contentType: 'application/octet-stream',
});

// Platform names and versions.
assert.equal(releaseOsName('darwin'), 'macos');
assert.equal(releaseOsName('win32'), 'windows');
assert.equal(releaseOsName('linux'), 'linux');
assert.throws(() => releaseOsName('freebsd'), /Unsupported release platform/);
assert.equal(isReleaseVersion('1.0.150'), true);
assert.equal(isReleaseVersion('1.0.150-rc.1'), true);
assert.equal(isReleaseVersion('v1.0.150'), false);
assert.equal(isReleaseVersion('1.0'), false);
assert.equal(isPrereleaseVersion('1.0.150'), false);
assert.equal(isPrereleaseVersion('1.0.150-rc.1'), true);

// Every key a build writes is scoped to its own platform and architecture, so
// parallel builds never write the same object.
const writtenKeys = (osName, arch, formats) => [
  ...formats.map((format) => releaseArtifactLocation({ version: '1.2.3', osName, arch, format }).key),
  platformManifestKey({ version: '1.2.3', osName, arch }),
  platformLatestKey({ osName, arch }),
];
const builds = [
  writtenKeys('macos', 'arm64', ['dmg', 'zip']),
  writtenKeys('macos', 'x64', ['dmg', 'zip']),
  writtenKeys('windows', 'x64', ['exe']),
  writtenKeys('linux', 'x64', ['deb']),
];
const allKeys = builds.flat();
assert.equal(new Set(allKeys).size, allKeys.length, 'no two builds share an R2 key');
assert.deepEqual(builds[2], [
  'releases/v1.2.3/windows/x64/Durango-Code-1.2.3-windows-x64.exe',
  'releases/v1.2.3/windows/x64/manifest.json',
  'releases/latest/windows-x64.json',
]);

// Artifact discovery: only installer/update formats count, once each.
assert.equal(isReleaseArtifact('out/make/nsis/x64/Durango-Code-Setup-1.2.3-x64.exe'), true);
assert.equal(isReleaseArtifact('out/make/nsis/x64/Durango-Code-Setup-1.2.3-x64.exe.blockmap'), false);
assert.equal(isReleaseArtifact('out/make/nsis/x64/latest.yml'), false);
assert.equal(isReleaseArtifact('out/make/rpm/x64/durango-code-1.2.3-1.x86_64.rpm'), false);
assert.deepEqual(
  [...selectPlatformArtifacts('macos', ['a/Durango Code-1.2.3-arm64.dmg', 'b/Durango Code-darwin-arm64-1.2.3.zip'])],
  [['dmg', 'a/Durango Code-1.2.3-arm64.dmg'], ['zip', 'b/Durango Code-darwin-arm64-1.2.3.zip']],
);
assert.throws(() => selectPlatformArtifacts('macos', ['a.dmg']), /did not produce a \.zip/);
assert.throws(() => selectPlatformArtifacts('windows', []), /did not produce a \.exe/);
assert.throws(() => selectPlatformArtifacts('linux', ['a.deb', 'b.deb']), /more than one \.deb/);
assert.deepEqual([...selectPlatformArtifacts('linux', ['x/durango-code_1.2.3_amd64.deb'])], [['deb', 'x/durango-code_1.2.3_amd64.deb']]);

// Platform manifests name the default download and the update file.
const windows = buildPlatformManifest({
  version: '1.2.3',
  osName: 'windows',
  arch: 'x64',
  releasedAt: '2026-10-24T00:00:00.000Z',
  artifacts: [artifact('windows', 'x64', 'exe')],
  signed: false,
});
assert.equal(windows.platform, 'windows');
assert.equal(windows.channel, 'stable');
assert.equal(windows.download, 'exe');
assert.equal(windows.update, 'exe');
assert.equal(windows.artifacts.exe.key, 'releases/v1.2.3/windows/x64/Durango-Code-1.2.3-windows-x64.exe');
assert.equal(windows.notarized, false);

const linux = buildPlatformManifest({
  version: '1.2.4-rc.1',
  osName: 'linux',
  arch: 'x64',
  releasedAt: '2026-10-24T00:00:00.000Z',
  artifacts: [artifact('linux', 'x64', 'deb', '1.2.4-rc.1')],
  signed: false,
});
assert.equal(linux.channel, 'prerelease');
assert.equal(linux.download, 'deb');
assert.equal(linux.update, 'deb');

// The legacy latest.json keeps the shape older orion-next deploys read.
const mac = buildPlatformManifest({
  version: '1.2.3',
  osName: 'macos',
  arch: 'arm64',
  releasedAt: '2026-10-24T00:00:00.000Z',
  artifacts: [artifact('macos', 'arm64', 'dmg'), artifact('macos', 'arm64', 'zip')],
  signed: true,
});
const legacy = buildLegacyMacManifest(mac);
assert.equal(legacy.version, '1.2.3');
assert.equal(legacy.signed, true);
assert.equal(legacy.notarized, true);
assert.equal(legacy.unsigned, false);
assert.equal(legacy.downloads.macos.arm64.key, 'releases/v1.2.3/macos/arm64/Durango-Code-1.2.3-macos-arm64.dmg');
assert.equal(legacy.downloads.macos.arm64.kind, 'installer');
assert.equal(legacy.updates.macos.arm64.key, 'releases/v1.2.3/macos/arm64/Durango-Code-1.2.3-macos-arm64.zip');
assert.equal(legacy.updates.macos.arm64.kind, 'update');
assert.equal(legacy.updates.macos.arm64.sha512, 'zip-sha512');
assert.equal(legacy.updates.macos.arm64.size, 10);
assert.deepEqual(Object.keys(legacy.downloads), ['macos']);
assert.throws(() => buildLegacyMacManifest(windows), /only describes macOS/);

console.log('release manifest tests passed');
