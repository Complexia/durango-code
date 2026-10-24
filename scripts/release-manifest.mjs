// R2 layout for Durango Code releases. Every build writes only keys scoped to
// its own platform and architecture, so the macOS release built on a Mac and
// the Windows/Linux releases built in GitHub Actions never overwrite each
// other, even when they publish at the same time:
//
//   releases/v<version>/<os>/<arch>/<artifact>        immutable artifacts
//   releases/v<version>/<os>/<arch>/manifest.json     that build's manifest
//   releases/latest/<os>-<arch>.json                  newest stable build per platform
//   releases/latest.json                              legacy, macOS only (see below)
//
// orion-next (code.durango.sh /api/download and /api/update) reads the
// per-platform pointers. releases/latest.json keeps its old macOS-only shape
// for orion-next deploys that predate the pointers.

import path from 'node:path';

export const productName = 'Durango Code';
export const artifactBaseName = 'Durango-Code';
export const legacyLatestKey = 'releases/latest.json';

const osNames = { darwin: 'macos', win32: 'windows', linux: 'linux' };

// `download` is the file the website hands out by default; `update` is the
// file electron-updater installs on that OS (latest-mac.yml, latest.yml,
// latest-linux.yml).
export const platformFormats = {
  macos: { download: 'dmg', update: 'zip' },
  windows: { download: 'exe', update: 'exe' },
  linux: { download: 'deb', update: 'deb' },
};

const contentTypes = {
  zip: 'application/zip',
  dmg: 'application/x-apple-diskimage',
  exe: 'application/vnd.microsoft.portable-executable',
  deb: 'application/vnd.debian.binary-package',
};

export const releaseOsName = (platform) => {
  const osName = osNames[platform];
  if (!osName) throw new Error(`Unsupported release platform "${platform}"`);
  return osName;
};

export const isReleaseVersion = (version) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);

// Prereleases (1.2.3-rc.1) are uploaded but never become the latest
// download or update, so a release can be tried end to end without users
// receiving it.
export const isPrereleaseVersion = (version) => version.includes('-');

export const releaseTag = (version) => `v${version}`;

export const artifactFormat = (filePath) => path.extname(filePath).slice(1).toLowerCase();

export const isReleaseArtifact = (filePath) => Object.hasOwn(contentTypes, artifactFormat(filePath));

export const contentTypeFor = (format) => contentTypes[format] ?? 'application/octet-stream';

export const releaseArtifactLocation = ({ version, osName, arch, format }) => {
  const fileName = `${artifactBaseName}-${version}-${osName}-${arch}.${format}`;
  return { fileName, key: `releases/v${version}/${osName}/${arch}/${fileName}` };
};

export const platformManifestKey = ({ version, osName, arch }) => `releases/v${version}/${osName}/${arch}/manifest.json`;

export const platformLatestKey = ({ osName, arch }) => `releases/latest/${osName}-${arch}.json`;

// Each format appears once per build. Two candidates for the same format
// (for example a stale installer left in out/make) would make it ambiguous
// which file users receive, so refuse instead of picking one.
export const selectPlatformArtifacts = (osName, artifactPaths) => {
  const formats = platformFormats[osName];
  const byFormat = new Map();
  for (const artifactPath of artifactPaths) {
    const format = artifactFormat(artifactPath);
    if (!isReleaseArtifact(artifactPath)) continue;
    if (byFormat.has(format)) {
      throw new Error(`Found more than one .${format} artifact: ${byFormat.get(format)} and ${artifactPath}`);
    }
    byFormat.set(format, artifactPath);
  }
  for (const required of new Set([formats.download, formats.update])) {
    if (!byFormat.has(required)) throw new Error(`${osName} release did not produce a .${required} artifact`);
  }
  return byFormat;
};

export const buildPlatformManifest = ({ version, osName, arch, releasedAt, artifacts, signed }) => {
  const formats = platformFormats[osName];
  return {
    product: productName,
    version,
    channel: isPrereleaseVersion(version) ? 'prerelease' : 'stable',
    releasedAt,
    platform: osName,
    arch,
    signed,
    notarized: osName === 'macos' && signed,
    download: formats.download,
    update: formats.update,
    artifacts: Object.fromEntries(artifacts.map((artifact) => [artifact.format, artifact])),
  };
};

// The pre-pointer manifest shape: `downloads.macos.<arch>` (DMG) and
// `updates.macos.<arch>` (ZIP).
export const buildLegacyMacManifest = (manifest) => {
  if (manifest.platform !== 'macos') throw new Error('The legacy latest.json only describes macOS releases');
  const legacyArtifact = (format, kind) => ({ kind, ...manifest.artifacts[format] });
  const download = legacyArtifact(manifest.download, 'installer');
  const update = legacyArtifact(manifest.update, 'update');
  return {
    product: manifest.product,
    version: manifest.version,
    channel: manifest.channel,
    releasedAt: manifest.releasedAt,
    signed: manifest.signed,
    notarized: manifest.notarized,
    unsigned: !manifest.signed,
    downloads: { macos: { [manifest.arch]: download } },
    updates: { macos: { [manifest.arch]: update } },
    artifacts: [download, update],
  };
};
