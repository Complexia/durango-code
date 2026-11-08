import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app, nativeImage } from 'electron';
import { convertHeicToJpeg, isHeicInput, jpegNameForHeic } from '../src/main/heic.js';

// scripts/fixtures/red-blue.heic: 48x32, left half red, right half blue.
const fixture = path.resolve('scripts/fixtures/red-blue.heic');

const assertRedBlueJpeg = async (filePath, label) => {
  const image = nativeImage.createFromBuffer(await fs.readFile(filePath));
  assert.deepEqual(image.getSize(), { width: 48, height: 32 }, `${label}: size`);
  const bitmap = image.toBitmap(); // BGRA
  const pixel = (x, y) => {
    const i = (y * 48 + x) * 4;
    return { r: bitmap[i + 2], g: bitmap[i + 1], b: bitmap[i] };
  };
  const left = pixel(8, 16);
  const right = pixel(40, 16);
  assert.ok(
    left.r > 180 && left.b < 80,
    `${label}: left half should be red, got ${JSON.stringify(left)}`,
  );
  assert.ok(
    right.b > 180 && right.r < 80,
    `${label}: right half should be blue, got ${JSON.stringify(right)}`,
  );
};

app.whenReady().then(async () => {
  try {
    assert.equal(isHeicInput('IMG_8336.HEIC', ''), true);
    assert.equal(isHeicInput('photo', 'image/heif'), true);
    assert.equal(isHeicInput('diagram.png', 'image/png'), false);
    assert.equal(jpegNameForHeic('IMG_8336.HEIC'), 'IMG_8336.jpg');
    assert.equal(jpegNameForHeic('photo'), 'photo.jpg');

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heic-test-'));
    try {
      // The platform's converter (sips on macOS).
      await convertHeicToJpeg(fixture, path.join(dir, 'native.jpg'));
      await assertRedBlueJpeg(path.join(dir, 'native.jpg'), process.platform);

      // The libheif (WebAssembly) converter used on Windows and Linux.
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'linux' });
      try {
        await convertHeicToJpeg(fixture, path.join(dir, 'libheif.jpg'));
        await assert.rejects(
          convertHeicToJpeg(path.join(dir, 'native.jpg'), path.join(dir, 'bad.jpg')),
          'libheif must reject files that are not HEIC'
        );
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
      await assertRedBlueJpeg(path.join(dir, 'libheif.jpg'), 'libheif');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    console.log('HEIC attachment tests passed.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.exit(process.exitCode ?? 0);
  }
});
