import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { nativeImage } from 'electron';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

// HEIC/HEIF (iPhone photos) can't be shown by Chromium and isn't accepted by
// the model APIs, so attachments in these formats are converted to JPEG.
const heicMimeTypes = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);
const heicExtensionPattern = /\.(heic|heif|hif)$/i;

export const isHeicInput = (name, mimeType) =>
  heicMimeTypes.has(String(mimeType || '').toLowerCase()) ||
  heicExtensionPattern.test(String(name || ''));

export const jpegNameForHeic = (name) =>
  heicExtensionPattern.test(name) ? name.replace(heicExtensionPattern, '.jpg') : `${name}.jpg`;

const JPEG_QUALITY = 90;

// macOS ships a HEIC decoder (ImageIO) behind `sips`, which also keeps the
// photo's color profile and orientation.
const convertWithSips = async (inputPath, outputPath) => {
  await execFileAsync(
    '/usr/bin/sips',
    [
      '-s',
      'format',
      'jpeg',
      '-s',
      'formatOptions',
      String(JPEG_QUALITY),
      inputPath,
      '--out',
      outputPath,
    ],
    { timeout: 60_000 },
  );
  const stats = await fs.stat(outputPath);
  if (!stats.isFile() || stats.size === 0) throw new Error('sips produced no image');
};

// Everywhere else: libheif compiled to WebAssembly. It is loaded at run time
// (not bundled into the main bundle) and forge.config.js copies it into the
// packaged app as its own module, because it is LGPL-licensed.
let libheifModule = null;
const loadLibheif = () => {
  libheifModule ??= require('libheif-js/wasm-bundle');
  return libheifModule;
};

const convertWithLibheif = async (inputPath, outputPath) => {
  const libheif = loadLibheif();
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(new Uint8Array(await fs.readFile(inputPath)));
  try {
    const image = images[0];
    if (!image) throw new Error('No image found in the HEIC file');
    const width = image.get_width();
    const height = image.get_height();
    const rgba = await new Promise((resolve, reject) => {
      image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (result) =>
        result ? resolve(result.data) : reject(new Error('Could not decode the HEIC image')),
      );
    });
    // nativeImage bitmaps are BGRA.
    const bgra = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    for (let i = 0; i < bgra.length; i += 4) {
      const red = bgra[i];
      bgra[i] = bgra[i + 2];
      bgra[i + 2] = red;
    }
    const jpeg = nativeImage.createFromBitmap(bgra, { width, height }).toJPEG(JPEG_QUALITY);
    if (!jpeg.length) throw new Error('Could not encode the converted image');
    await fs.writeFile(outputPath, jpeg);
  } finally {
    for (const image of images) image.free();
    decoder.decoder.delete();
  }
};

export const convertHeicToJpeg = async (inputPath, outputPath) => {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (process.platform === 'darwin') {
    try {
      await convertWithSips(inputPath, outputPath);
      return;
    } catch (error) {
      console.warn('sips could not convert HEIC; falling back to libheif', error);
      await fs.rm(outputPath, { force: true });
    }
  }
  await convertWithLibheif(inputPath, outputPath);
};
