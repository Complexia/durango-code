import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findProjectIcon, findProjectIconPath, projectIconToDataUrl } from '../src/main/project-icon.js';

const SVG_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#000"/></svg>';
// Minimal 1x1 PNG
const PNG_ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
// Minimal 16x16 ICO header + payload bytes (decoded directly as image/x-icon)
const ICO_ICON = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00, 0x01, 0x00, 0x20, 0x00]);
const WEBP_ICON = Buffer.from('RIFF\x18\x00\x00\x00WEBPVP8L\x0c\x00\x00\x00', 'binary');

const writeFile = async (root, relPath, content) => {
  const fullPath = path.join(root, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
  return fullPath;
};

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-project-icon-test-'));

try {
  // 1. Empty project -> null
  const emptyDir = path.join(tmpRoot, 'empty');
  await fs.mkdir(emptyDir, { recursive: true });
  assert.equal(await findProjectIcon(emptyDir), null, 'empty directory has no project icon');

  // 2. HTML <link rel="icon" href="/brand.svg?v=2"> resolves into public/ (not filesystem root)
  const viteDir = path.join(tmpRoot, 'vite-app');
  await writeFile(
    viteDir,
    'index.html',
    '<html><head><link rel="icon" href="https://example.com/remote.ico"><link rel="icon" href="/brand.svg?v=2"></head></html>'
  );
  const viteIcon = await writeFile(viteDir, 'public/brand.svg', SVG_ICON);
  await writeFile(viteDir, 'public/favicon.ico', ICO_ICON);
  assert.equal(await findProjectIconPath(viteDir), viteIcon, 'leading / in index.html resolves into public/');
  const viteDataUrl = await findProjectIcon(viteDir);
  assert.ok(viteDataUrl?.startsWith('data:image/svg+xml;base64,'), 'svg icon converts to svg data URL');

  // 3. HTML path traversal outside project root is rejected
  const traversalDir = path.join(tmpRoot, 'traversal');
  await writeFile(tmpRoot, 'secret-outside.svg', SVG_ICON);
  await writeFile(
    traversalDir,
    'index.html',
    '<html><head><link rel="icon" href="../secret-outside.svg"></head></html>'
  );
  assert.equal(await findProjectIconPath(traversalDir), null, 'html icon cannot escape project directory');

  // 4. High-res SVG/PNG preferred over .ico and generic logo
  const priorityDir = path.join(tmpRoot, 'priority');
  await writeFile(priorityDir, 'public/favicon.ico', ICO_ICON);
  await writeFile(priorityDir, 'public/logo.png', PNG_ICON);
  const svgFavicon = await writeFile(priorityDir, 'public/favicon.svg', SVG_ICON);
  assert.equal(await findProjectIconPath(priorityDir), svgFavicon, 'prefers favicon.svg over favicon.ico and logo.png');

  // 5. .ico and .webp return native data URLs without relying on nativeImage
  const icoDir = path.join(tmpRoot, 'ico-only');
  await writeFile(icoDir, 'public/favicon.ico', ICO_ICON);
  const icoUrl = await findProjectIcon(icoDir);
  assert.ok(icoUrl?.startsWith('data:image/x-icon;base64,'), '.ico returns image/x-icon data URL');

  const webpDir = path.join(tmpRoot, 'webp-only');
  await writeFile(webpDir, 'public/favicon.webp', WEBP_ICON);
  const webpUrl = await findProjectIcon(webpDir);
  assert.ok(webpUrl?.startsWith('data:image/webp;base64,'), '.webp returns image/webp data URL');

  // 6. app.json (Expo) icon discovery
  const expoDir = path.join(tmpRoot, 'expo-app');
  const expoIcon = await writeFile(expoDir, 'assets/custom-app-icon.png', PNG_ICON);
  await writeFile(expoDir, 'app.json', JSON.stringify({ expo: { icon: './assets/custom-app-icon.png' } }));
  assert.equal(await findProjectIconPath(expoDir), expoIcon, 'reads expo.icon from app.json');

  // 7. Web manifest icon discovery prefers square ~128px / SVG icon
  const manifestDir = path.join(tmpRoot, 'manifest-app');
  await writeFile(manifestDir, 'public/icons/tiny.png', PNG_ICON);
  const bestManifestIcon = await writeFile(manifestDir, 'public/icons/app-192.png', PNG_ICON);
  await writeFile(
    manifestDir,
    'public/manifest.json',
    JSON.stringify({
      icons: [
        { src: '/icons/tiny.png', sizes: '16x16' },
        { src: '/icons/app-192.png', sizes: '192x192' },
      ],
    })
  );
  assert.equal(await findProjectIconPath(manifestDir), bestManifestIcon, 'picks crisp square icon from manifest.json');

  // 8. Monorepo depth-1 (frontend/) and depth-2 (apps/web/) discovery, skipping ignored dirs
  const monoDepth1 = path.join(tmpRoot, 'mono-depth1');
  await writeFile(monoDepth1, 'docs/public/favicon.svg', SVG_ICON);
  await writeFile(monoDepth1, 'node_modules/pkg/favicon.svg', SVG_ICON);
  const frontendIcon = await writeFile(monoDepth1, 'frontend/src/app/icon.svg', SVG_ICON);
  assert.equal(await findProjectIconPath(monoDepth1), frontendIcon, 'finds depth-1 frontend icon and ignores docs/node_modules');

  const monoDepth2 = path.join(tmpRoot, 'mono-depth2');
  await writeFile(monoDepth2, 'templates/starter/public/favicon.png', PNG_ICON);
  const appsWebIcon = await writeFile(monoDepth2, 'apps/web/public/favicon.png', PNG_ICON);
  assert.equal(await findProjectIconPath(monoDepth2), appsWebIcon, 'finds depth-2 apps/web icon and ignores templates/');

  // 9. Aspect-ratio-preserving resize via nativeImage when raster exceeds 128px
  const resizeArgs = [];
  const makeFakeNativeImage = (width, height) => ({
    createFromPath: () => ({
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      resize: (opts) => {
        resizeArgs.push(opts);
        return { toDataURL: () => 'data:image/png;base64,RESIZED' };
      },
      toDataURL: () => 'data:image/png;base64,ORIGINAL',
    }),
  });
  const pngPath = await writeFile(tmpRoot, 'wide.png', PNG_ICON);
  assert.equal(
    await projectIconToDataUrl(pngPath, { nativeImage: makeFakeNativeImage(1024, 512) }),
    'data:image/png;base64,RESIZED'
  );
  assert.deepEqual(resizeArgs.at(-1), { width: 128 }, 'wide raster resizes by width only to preserve aspect ratio');

  assert.equal(
    await projectIconToDataUrl(pngPath, { nativeImage: makeFakeNativeImage(256, 512) }),
    'data:image/png;base64,RESIZED'
  );
  assert.deepEqual(resizeArgs.at(-1), { height: 128 }, 'tall raster resizes by height only to preserve aspect ratio');

  assert.equal(
    await projectIconToDataUrl(pngPath, { nativeImage: makeFakeNativeImage(64, 64) }),
    'data:image/png;base64,ORIGINAL',
    'icons <= 128px are not downscaled'
  );

  console.log('project-icon tests passed');
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
