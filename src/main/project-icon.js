import fs from 'node:fs/promises';
import path from 'node:path';

const ICON_MIME_BY_EXT = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

const DIRECT_BASE64_EXTS = new Set(['.svg', '.ico', '.webp', '.gif']);
const MAX_DIRECT_ICON_BYTES = 512 * 1024;
const MAX_RASTER_ICON_BYTES = 10 * 1024 * 1024;
const MAX_RASTER_DIMENSION = 128;

// Ordered by visual quality and specificity: vector/PNG favicons and app icons
// first, then .ico / desktop icons, and generic logos last.
const HIGH_RES_ICON_CANDIDATES = [
  'favicon.svg',
  'favicon.png',
  'public/favicon.svg',
  'public/favicon.png',
  'app/icon.svg',
  'app/icon.png',
  'src/app/icon.svg',
  'src/app/icon.png',
  'static/favicon.svg',
  'static/favicon.png',
  'icon.svg',
  'icon.png',
  'public/icon.svg',
  'public/icon.png',
  'public/apple-touch-icon.png',
  'public/apple-icon.png',
  'public/icons/favicon.svg',
  'public/icons/favicon.png',
  'public/icons/apple-touch-icon.png',
  'public/icons/icon-192x192.png',
  'public/icons/icon.svg',
  'public/icons/icon.png',
  'app/apple-icon.png',
  'src/app/apple-icon.png',
  'assets/icon.svg',
  'assets/icon.png',
  'src/assets/icon.svg',
  'src/assets/icon.png',
  'icons/icon.svg',
  'icons/icon.png',
];

const FALLBACK_ICON_CANDIDATES = [
  'favicon.ico',
  'favicon.webp',
  'public/favicon.ico',
  'public/favicon.webp',
  'public/favicon-96x96.png',
  'public/favicon-32x32.png',
  'public/icons/favicon-32x32.png',
  'app/favicon.ico',
  'app/icon.ico',
  'app/favicon.png',
  'app/favicon.svg',
  'src/app/favicon.ico',
  'src/app/icon.ico',
  'src/app/favicon.png',
  'src/app/favicon.svg',
  'static/favicon.ico',
  'static/icon.svg',
  'static/icon.png',
  'icon.ico',
  'public/icon.ico',
  'assets/icon.ico',
  'assets/favicon.svg',
  'assets/favicon.png',
  'assets/favicon.ico',
  'build/icon.png',
  'build/icon.svg',
  'resources/icon.png',
  'src-tauri/icons/128x128.png',
  'src-tauri/icons/icon.png',
  'src-tauri/icons/32x32.png',
  'icons/favicon.svg',
  'icons/favicon.png',
  'icons/favicon.ico',
  'images/favicon.png',
  'images/favicon.ico',
  'public/images/favicon.svg',
  'public/images/favicon.png',
  'public/images/favicon.ico',
];

const LOGO_CANDIDATES = [
  'logo.svg',
  'logo.png',
  'public/logo.svg',
  'public/logo.png',
  'assets/logo.svg',
  'assets/logo.png',
  'src/assets/logo.svg',
  'src/assets/logo.png',
  'static/logo.svg',
  'static/logo.png',
  'images/logo.svg',
  'images/logo.png',
  'public/images/logo.svg',
  'public/images/logo.png',
];

const HTML_CANDIDATES = ['index.html', 'public/index.html', 'src/index.html', 'app/index.html'];
const WEB_MANIFEST_CANDIDATES = [
  'public/manifest.json',
  'public/site.webmanifest',
  'static/manifest.json',
  'manifest.json',
  'site.webmanifest',
];

// Monorepo / multi-folder projects: search likely app directories first and
// skip build artifacts, dependencies, tests, docs, and template folders.
const PRIORITY_SUBDIRS = [
  'web',
  'frontend',
  'app',
  'client',
  'site',
  'ui',
  'apps',
  'desktop',
  'code',
  'chat',
  'mobile',
  'packages',
  'cloud',
];

const IGNORED_SUBDIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'target',
  'vendor',
  'coverage',
  'tmp',
  'temp',
  '__pycache__',
  'venv',
  'env',
  'test',
  'tests',
  '__tests__',
  'e2e',
  'fixtures',
  'examples',
  'example',
  'samples',
  'sample',
  'templates',
  'create-templates',
  'scripts',
  'tools',
  'docs',
  'doc',
  'storybook',
  'public',
  'static',
  'assets',
  'src',
  'lib',
  'bin',
  'config',
  'migrations',
  'drizzle',
  'prisma',
  'pods',
  'deriveddata',
  'android',
  'ios',
]);

const MAX_DEPTH1_SUBDIRS = 24;
const MAX_DEPTH2_SUBDIRS = 32;

const statFileSize = async (filePath) => {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
};

const isProjectIconFile = async (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (!(ext in ICON_MIME_BY_EXT)) return false;
  const size = await statFileSize(filePath);
  return size !== null && size > 0 && size <= MAX_RASTER_ICON_BYTES;
};

const isWithinDir = (rootDir, targetPath) => {
  const relative = path.relative(rootDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const resolveIconRefCandidates = (rootDir, baseDir, rawRef) => {
  if (!rawRef || typeof rawRef !== 'string') return [];
  const trimmed = rawRef.trim();
  if (!trimmed || /^(?:https?:|data:|blob:|\/\/)/i.test(trimmed)) return [];
  if (/(?:\$\{|\{\{|<%)/.test(trimmed)) return [];

  const cleaned = trimmed
    .replace(/%(?:PUBLIC_URL|BASE_URL)%/g, '')
    .split('?')[0]
    .split('#')[0]
    .trim();
  if (!cleaned) return [];

  const roots = cleaned.startsWith('/')
    ? [path.join(rootDir, 'public'), path.join(rootDir, 'static'), rootDir, baseDir]
    : [baseDir, path.join(rootDir, 'public'), rootDir];
  const relativeRef = cleaned.replace(/^\/+/, '');
  const resolved = [];
  const seen = new Set();

  for (const base of roots) {
    const candidate = path.resolve(base, relativeRef);
    if (!isWithinDir(rootDir, candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    resolved.push(candidate);
  }
  return resolved;
};

const findHtmlIconsInDir = async (dir) => {
  const primary = [];
  const touch = [];

  for (const relativePath of HTML_CANDIDATES) {
    const htmlPath = path.join(dir, relativePath);
    const size = await statFileSize(htmlPath);
    if (size === null || size === 0 || size > 512 * 1024) continue;

    try {
      const html = await fs.readFile(htmlPath, 'utf-8');
      const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
      for (const linkTag of linkTags) {
        const relMatch = linkTag.match(/\brel\s*=\s*["']([^"']+)["']/i);
        const hrefMatch = linkTag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
        if (!relMatch || !hrefMatch) continue;
        const rel = relMatch[1].trim().toLowerCase().replace(/\s+/g, ' ');
        const isPrimaryIcon = rel === 'icon' || rel === 'shortcut icon';
        const isTouchIcon = rel === 'apple-touch-icon' || rel === 'apple-touch-icon-precomposed';
        if (!isPrimaryIcon && !isTouchIcon) continue;

        const candidates = resolveIconRefCandidates(dir, path.dirname(htmlPath), hrefMatch[1]);
        for (const iconPath of candidates) {
          if (await isProjectIconFile(iconPath)) {
            (isPrimaryIcon ? primary : touch).push(iconPath);
            break;
          }
        }
      }
    } catch {
      // ignore malformed html
    }
  }

  return [...primary, ...touch];
};

const findConfigIconsInDir = async (dir) => {
  const results = [];

  const packagePath = path.join(dir, 'package.json');
  const pkgSize = await statFileSize(packagePath);
  if (pkgSize !== null && pkgSize > 0 && pkgSize <= 512 * 1024) {
    try {
      const pkg = JSON.parse(await fs.readFile(packagePath, 'utf-8'));
      for (const ref of [pkg?.icon, pkg?.logo]) {
        for (const iconPath of resolveIconRefCandidates(dir, dir, ref)) {
          if (await isProjectIconFile(iconPath)) {
            results.push(iconPath);
            break;
          }
        }
      }
    } catch {
      // ignore malformed package.json
    }
  }

  const appJsonPath = path.join(dir, 'app.json');
  const appSize = await statFileSize(appJsonPath);
  if (appSize !== null && appSize > 0 && appSize <= 512 * 1024) {
    try {
      const cfg = JSON.parse(await fs.readFile(appJsonPath, 'utf-8'));
      for (const ref of [cfg?.expo?.icon, cfg?.icon]) {
        for (const iconPath of resolveIconRefCandidates(dir, dir, ref)) {
          if (await isProjectIconFile(iconPath)) {
            results.push(iconPath);
            break;
          }
        }
      }
    } catch {
      // ignore malformed app.json
    }
  }

  return results;
};

const parseManifestIconScore = (entry) => {
  const src = typeof entry?.src === 'string' ? entry.src : '';
  const ext = path.extname(src.split('?')[0].split('#')[0]).toLowerCase();
  if (ext === '.svg' || entry?.sizes === 'any') return 1000;
  const sizes = typeof entry?.sizes === 'string' ? entry.sizes : '';
  const match = sizes.match(/(\d+)\s*x\s*(\d+)/i);
  if (!match) return 50;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 50;
  // Prefer crisp 64-256px square icons over tiny 16px or huge 1024px icons.
  const squareBonus = width === height ? 100 : 0;
  const targetDistance = Math.abs(Math.min(width, height) - 128);
  return squareBonus + Math.max(0, 500 - targetDistance);
};

const findManifestIconsInDir = async (dir) => {
  const results = [];
  for (const relativePath of WEB_MANIFEST_CANDIDATES) {
    const manifestPath = path.join(dir, relativePath);
    const size = await statFileSize(manifestPath);
    if (size === null || size === 0 || size > 256 * 1024) continue;

    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
      const icons = Array.isArray(manifest?.icons) ? [...manifest.icons] : [];
      icons.sort((a, b) => parseManifestIconScore(b) - parseManifestIconScore(a));
      for (const entry of icons) {
        const candidates = resolveIconRefCandidates(dir, path.dirname(manifestPath), entry?.src);
        for (const iconPath of candidates) {
          if (await isProjectIconFile(iconPath)) {
            results.push(iconPath);
            break;
          }
        }
      }
    } catch {
      // ignore malformed manifest
    }
  }
  return results;
};

const checkCandidatesInDir = async (dir, candidates) => {
  const checks = await Promise.all(
    candidates.map(async (candidate) => {
      const iconPath = path.join(dir, candidate);
      return (await isProjectIconFile(iconPath)) ? iconPath : null;
    })
  );
  return checks.filter(Boolean);
};

const collectIconPathsInDir = async (dir) => {
  const seen = new Set();
  const ordered = [];
  const pushAll = (paths) => {
    for (const item of paths) {
      if (!seen.has(item)) {
        seen.add(item);
        ordered.push(item);
      }
    }
  };

  // Explicit declarations and high-resolution favicons first.
  const [htmlIcons, configIcons, highResIcons] = await Promise.all([
    findHtmlIconsInDir(dir),
    findConfigIconsInDir(dir),
    checkCandidatesInDir(dir, HIGH_RES_ICON_CANDIDATES),
  ]);
  pushAll(htmlIcons);
  pushAll(configIcons);
  pushAll(highResIcons);
  if (ordered.length > 0) return ordered;

  // Next: .ico / sized favicons / desktop icons / web manifests.
  const [fallbackIcons, manifestIcons] = await Promise.all([
    checkCandidatesInDir(dir, FALLBACK_ICON_CANDIDATES),
    findManifestIconsInDir(dir),
  ]);
  pushAll(fallbackIcons);
  pushAll(manifestIcons);
  if (ordered.length > 0) return ordered;

  // Last resort: generic logo files.
  pushAll(await checkCandidatesInDir(dir, LOGO_CANDIDATES));
  return ordered;
};

const listCandidateSubdirs = async (dir, limit) => {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name.startsWith('.')) continue;
    if (IGNORED_SUBDIRS.has(name.toLowerCase())) continue;
    names.push(name);
  }

  const priorityRank = (name) => {
    const idx = PRIORITY_SUBDIRS.indexOf(name.toLowerCase());
    return idx === -1 ? PRIORITY_SUBDIRS.length : idx;
  };
  names.sort((a, b) => {
    const rankDiff = priorityRank(a) - priorityRank(b);
    return rankDiff !== 0 ? rankDiff : a.localeCompare(b);
  });

  return names.slice(0, limit).map((name) => path.join(dir, name));
};

export const projectIconToDataUrl = async (filePath, { nativeImage } = {}) => {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ICON_MIME_BY_EXT[ext];
  if (!mime) return null;

  const size = await statFileSize(filePath);
  if (size === null || size === 0) return null;

  if (DIRECT_BASE64_EXTS.has(ext)) {
    if (size > MAX_DIRECT_ICON_BYTES) return null;
    const buffer = await fs.readFile(filePath);
    if (buffer.length === 0) return null;
    return `data:${mime};base64,${buffer.toString('base64')}`;
  }

  if (nativeImage?.createFromPath && size <= MAX_RASTER_ICON_BYTES) {
    try {
      const image = nativeImage.createFromPath(filePath);
      if (image && !image.isEmpty()) {
        const { width, height } = image.getSize();
        const resized =
          width > MAX_RASTER_DIMENSION || height > MAX_RASTER_DIMENSION
            ? image.resize(
                width >= height
                  ? { width: MAX_RASTER_DIMENSION }
                  : { height: MAX_RASTER_DIMENSION }
              )
            : image;
        const dataUrl = resized.toDataURL();
        if (dataUrl) return dataUrl;
      }
    } catch {
      // fall through to direct base64
    }
  }

  if (size > MAX_DIRECT_ICON_BYTES) return null;
  const buffer = await fs.readFile(filePath);
  if (buffer.length === 0) return null;
  return `data:${mime};base64,${buffer.toString('base64')}`;
};

const firstConvertibleIcon = async (paths, options) => {
  for (const iconPath of paths) {
    try {
      const dataUrl = await projectIconToDataUrl(iconPath, options);
      if (dataUrl) return { iconPath, dataUrl };
    } catch {
      // try next candidate
    }
  }
  return null;
};

const findProjectIconMatch = async (projectPath, options = {}) => {
  if (!projectPath || typeof projectPath !== 'string') return null;

  const rootPaths = await collectIconPathsInDir(projectPath);
  const rootMatch = await firstConvertibleIcon(rootPaths, options);
  if (rootMatch) return rootMatch;

  // Monorepo / nested app layout: check depth-1 subdirs first, then depth-2.
  const depth1Dirs = await listCandidateSubdirs(projectPath, MAX_DEPTH1_SUBDIRS);
  for (const subdir of depth1Dirs) {
    const subPaths = await collectIconPathsInDir(subdir);
    const match = await firstConvertibleIcon(subPaths, options);
    if (match) return match;
  }

  let depth2Checked = 0;
  for (const subdir of depth1Dirs) {
    if (depth2Checked >= MAX_DEPTH2_SUBDIRS) break;
    const nestedDirs = await listCandidateSubdirs(subdir, MAX_DEPTH2_SUBDIRS - depth2Checked);
    for (const nestedDir of nestedDirs) {
      depth2Checked += 1;
      const nestedPaths = await collectIconPathsInDir(nestedDir);
      const match = await firstConvertibleIcon(nestedPaths, options);
      if (match) return match;
    }
  }

  return null;
};

export const findProjectIconPath = async (projectPath, options = {}) => {
  const match = await findProjectIconMatch(projectPath, options);
  return match?.iconPath ?? null;
};

export const findProjectIcon = async (projectPath, options = {}) => {
  const match = await findProjectIconMatch(projectPath, options);
  return match?.dataUrl ?? null;
};
