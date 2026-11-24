import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ACP_MAX_IMAGE_BYTES,
  ACP_MAX_TEXT_BYTES,
  ACP_MAX_TOTAL_BYTES,
  buildAcpPromptBlocks,
  normalizeMimeType,
  resolveAttachmentMimeType,
} from '../src/main/acp-prompt-blocks.js';

// --- normalizeMimeType & resolveAttachmentMimeType -------------------------

assert.equal(normalizeMimeType('image/png; charset=binary'), 'image/png');
assert.equal(normalizeMimeType('  TEXT/PLAIN ; charset=utf-8  '), 'text/plain');
assert.equal(normalizeMimeType('application/pdf; version=1.7'), 'application/pdf');
assert.equal(normalizeMimeType(''), '');
assert.equal(normalizeMimeType(null), '');
assert.equal(normalizeMimeType(undefined), '');

// Parameterized, generic, and missing MIME types (shared by ACP, Claude, and Codex).
assert.equal(
  resolveAttachmentMimeType({ mimeType: 'image/png; charset=binary' }, '/tmp/shot.bin'),
  'image/png'
);
assert.equal(
  resolveAttachmentMimeType({ mimeType: 'image/*' }, '/tmp/photo.JPG'),
  'image/jpeg'
);
assert.equal(
  resolveAttachmentMimeType({ mimeType: 'application/octet-stream' }, '/tmp/report.pdf'),
  'application/pdf'
);
assert.equal(
  resolveAttachmentMimeType({ mimeType: '' }, '/tmp/diagram.webp'),
  'image/webp'
);
assert.equal(
  resolveAttachmentMimeType({}, '/tmp/bitmap.bmp'),
  'image/bmp'
);
assert.equal(
  resolveAttachmentMimeType({}, '/tmp/voice.mp3'),
  'audio/mpeg'
);
assert.equal(
  resolveAttachmentMimeType({}, '/tmp/clip.wav'),
  'audio/wav'
);
assert.equal(
  resolveAttachmentMimeType({}, '/tmp/memo.m4a'),
  'audio/mp4'
);
assert.equal(
  resolveAttachmentMimeType({}, '/tmp/track.ogg'),
  'audio/ogg'
);
assert.equal(
  resolveAttachmentMimeType({}, '/tmp/lossless.flac'),
  'audio/flac'
);
assert.equal(
  resolveAttachmentMimeType({}, '/tmp/sound.aac'),
  'audio/aac'
);
assert.equal(
  resolveAttachmentMimeType({ mimeType: 'audio/webm; codecs=opus' }, '/tmp/voice.webm'),
  'audio/webm'
);
assert.equal(
  resolveAttachmentMimeType({ mimeType: 'audio/*' }, '/tmp/voice.webm'),
  'audio/webm'
);
assert.equal(
  resolveAttachmentMimeType({}, '/tmp/app.tsx'),
  'text/typescript'
);
assert.equal(
  resolveAttachmentMimeType({}, '/tmp/config.yaml'),
  'application/yaml'
);
assert.equal(
  resolveAttachmentMimeType({}, '/tmp/main.rs'),
  'text/x-rust'
);
assert.equal(
  resolveAttachmentMimeType({ mimeType: 'application/pdf; charset=binary' }, '/tmp/noext'),
  'application/pdf'
);

// --- buildAcpPromptBlocks --------------------------------------------------

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-acp-blocks-'));

try {
  // 1. Empty prompt with no attachments still emits one text block; empty prompt with image omits empty text block.
  assert.deepEqual(await buildAcpPromptBlocks('', []), [{ type: 'text', text: '' }]);

  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const pngPath = path.join(dir, 'screen.png');
  await fs.writeFile(pngPath, pngBytes);

  const emptyPromptWithImage = await buildAcpPromptBlocks('', [{ path: pngPath, mimeType: 'image/png' }]);
  assert.deepEqual(emptyPromptWithImage, [
    { type: 'image', data: pngBytes.toString('base64'), mimeType: 'image/png' },
  ]);

  // 2. Images, MIME params, generic MIME fallback, deduplication across non-normalized paths, and image:false gating.
  const subDir = path.join(dir, 'sub');
  await fs.mkdir(subDir);
  const bmpPath = path.join(dir, 'icon.bmp');
  await fs.writeFile(bmpPath, Buffer.from([0x42, 0x4d, 0x00, 0x01]));
  const nonNormalizedPng = path.join(subDir, '..', 'screen.png');

  const imageBlocks = await buildAcpPromptBlocks('Inspect these', [
    { path: pngPath, mimeType: 'image/png; charset=binary' },
    { path: nonNormalizedPng, mimeType: 'image/png' },
    { path: bmpPath, mimeType: 'image/*' },
    { path: path.join(dir, 'missing.png'), mimeType: 'image/png' },
  ]);
  assert.deepEqual(imageBlocks, [
    { type: 'text', text: 'Inspect these' },
    { type: 'image', data: pngBytes.toString('base64'), mimeType: 'image/png' },
    { type: 'image', data: Buffer.from([0x42, 0x4d, 0x00, 0x01]).toString('base64'), mimeType: 'image/bmp' },
  ]);

  const imagesDisabled = await buildAcpPromptBlocks(
    'No images',
    [{ path: pngPath, mimeType: 'image/png' }],
    { image: false }
  );
  assert.deepEqual(imagesDisabled, [{ type: 'text', text: 'No images' }]);

  // 3. Audio gating: skipped unless promptCapabilities.audio === true.
  const wavBytes = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1');
  const wavPath = path.join(dir, 'clip.wav');
  await fs.writeFile(wavPath, wavBytes);

  const audioSkipped = await buildAcpPromptBlocks('Listen', [{ path: wavPath }], { image: true });
  assert.deepEqual(audioSkipped, [{ type: 'text', text: 'Listen' }]);

  const audioIncluded = await buildAcpPromptBlocks(
    'Listen',
    [{ path: wavPath, mimeType: 'audio/wav; rate=16000' }],
    { image: true, audio: true }
  );
  assert.deepEqual(audioIncluded, [
    { type: 'text', text: 'Listen' },
    { type: 'audio', data: wavBytes.toString('base64'), mimeType: 'audio/wav' },
  ]);

  // 4. PDF resource_link: gated on embeddedContext === true.
  const pdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
  const pdfPath = path.join(dir, 'spec.pdf');
  await fs.writeFile(pdfPath, pdfBytes);

  const pdfSkipped = await buildAcpPromptBlocks('Read PDF', [{ path: pdfPath }], { image: true });
  assert.deepEqual(pdfSkipped, [{ type: 'text', text: 'Read PDF' }]);

  const pdfIncluded = await buildAcpPromptBlocks(
    'Read PDF',
    [{ path: pdfPath, name: 'Architecture Spec.pdf', mimeType: 'application/octet-stream' }],
    { image: true, embeddedContext: true }
  );
  assert.deepEqual(pdfIncluded, [
    { type: 'text', text: 'Read PDF' },
    {
      type: 'resource_link',
      uri: pathToFileURL(pdfPath).href,
      name: 'Architecture Spec.pdf',
      mimeType: 'application/pdf',
      size: pdfBytes.length,
    },
  ]);

  // 5. Text/code files: UTF-8, UTF-16LE BOM, UTF-16BE BOM, binary NUL rejection, invalid UTF-8 rejection, folded pasted text.
  const utf8Path = path.join(dir, 'hello.ts');
  await fs.writeFile(utf8Path, 'export const greeting = "hello — world";\n', 'utf8');

  const utf16lePath = path.join(dir, 'utf16le.txt');
  const utf16leBody = 'UTF-16LE line ✓';
  await fs.writeFile(utf16lePath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf16leBody, 'utf16le')]));

  const utf16bePath = path.join(dir, 'utf16be.md');
  const utf16beBody = 'UTF-16BE café';
  const lePayload = Buffer.from(utf16beBody, 'utf16le');
  const bePayload = Buffer.alloc(lePayload.length);
  for (let i = 0; i < lePayload.length; i += 2) {
    bePayload[i] = lePayload[i + 1];
    bePayload[i + 1] = lePayload[i];
  }
  await fs.writeFile(utf16bePath, Buffer.concat([Buffer.from([0xfe, 0xff]), bePayload]));

  const nulBinaryPath = path.join(dir, 'binary.txt');
  await fs.writeFile(nulBinaryPath, Buffer.from([0x61, 0x62, 0x00, 0x63]));

  const badUtf8Path = path.join(dir, 'invalid-utf8.txt');
  await fs.writeFile(badUtf8Path, Buffer.from([0x80, 0xff, 0xfe]));

  const pastedBySourcePath = path.join(dir, 'pasted-a.txt');
  await fs.writeFile(pastedBySourcePath, 'folded pasted content A', 'utf8');
  const pastedByFlagPath = path.join(dir, 'pasted-b.txt');
  await fs.writeFile(pastedByFlagPath, 'folded pasted content B', 'utf8');

  const textSkipped = await buildAcpPromptBlocks('Inspect code', [{ path: utf8Path }], { image: true });
  assert.deepEqual(textSkipped, [{ type: 'text', text: 'Inspect code' }]);

  const textBlocks = await buildAcpPromptBlocks(
    'Inspect code',
    [
      { path: utf8Path },
      { path: utf16lePath, mimeType: 'text/plain; charset=utf-16le' },
      { path: utf16bePath },
      { path: nulBinaryPath, mimeType: 'text/plain' },
      { path: badUtf8Path, mimeType: 'text/plain' },
      { path: pastedBySourcePath, mimeType: 'text/plain', source: { _tag: 'pasted-text' } },
      { path: pastedByFlagPath, mimeType: 'text/plain', pastedText: true },
    ],
    { image: true, embeddedContext: true }
  );
  assert.deepEqual(textBlocks, [
    { type: 'text', text: 'Inspect code' },
    {
      type: 'resource',
      resource: {
        uri: pathToFileURL(utf8Path).href,
        mimeType: 'text/typescript',
        text: 'export const greeting = "hello — world";\n',
      },
    },
    {
      type: 'resource',
      resource: {
        uri: pathToFileURL(utf16lePath).href,
        mimeType: 'text/plain',
        text: utf16leBody,
      },
    },
    {
      type: 'resource',
      resource: {
        uri: pathToFileURL(utf16bePath).href,
        mimeType: 'text/markdown',
        text: utf16beBody,
      },
    },
  ]);

  // 6. SnapShot accessibility outlines: inlined even without embeddedContext, deduplicated, missing file skipped.
  const outlinePath = path.join(dir, 'Safari - PR.snapshot.md');
  await fs.writeFile(outlinePath, 'SnapShot of Safari.\n\n- button "Merge" [10,20,80,30]\n', 'utf8');
  const outlineAttachment = {
    path: outlinePath,
    mimeType: 'text/markdown',
    snapshot: { kind: 'accessibility', appName: 'Safari', windowTitle: 'PR' },
  };
  const snapshotBlocks = await buildAcpPromptBlocks(
    'Look at this window',
    [
      { path: pngPath, mimeType: 'image/png', snapshot: { kind: 'image', appName: 'Safari' } },
      outlineAttachment,
      outlineAttachment,
      { ...outlineAttachment, path: path.join(dir, 'gone.snapshot.md') },
    ],
    { image: true }
  );
  assert.deepEqual(
    snapshotBlocks.map((block) => block.type),
    ['text', 'image', 'text']
  );
  assert.match(snapshotBlocks[2].text, /^<snapshot_app_text app="Safari"/);
  assert.match(snapshotBlocks[2].text, /- button "Merge" \[10,20,80,30\]/);

  // 7. Size caps: 1 MiB text cap, 10 MiB image cap, 50 MiB total cap.
  const exactTextPath = path.join(dir, 'exact-1m.txt');
  await fs.writeFile(exactTextPath, Buffer.alloc(ACP_MAX_TEXT_BYTES, 0x61));
  const oversizeTextPath = path.join(dir, 'over-1m.txt');
  await fs.writeFile(oversizeTextPath, Buffer.alloc(ACP_MAX_TEXT_BYTES + 1, 0x61));

  const textCapBlocks = await buildAcpPromptBlocks(
    'Text cap',
    [{ path: exactTextPath }, { path: oversizeTextPath }],
    { embeddedContext: true }
  );
  assert.equal(textCapBlocks.length, 2);
  assert.equal(textCapBlocks[1].type, 'resource');
  assert.equal(textCapBlocks[1].resource.text.length, ACP_MAX_TEXT_BYTES);

  const oversizeImagePath = path.join(dir, 'over-10m.png');
  const overImgHandle = await fs.open(oversizeImagePath, 'w');
  await overImgHandle.truncate(ACP_MAX_IMAGE_BYTES + 1);
  await overImgHandle.close();

  const imageCapBlocks = await buildAcpPromptBlocks('Image cap', [{ path: oversizeImagePath }], {
    image: true,
  });
  assert.deepEqual(imageCapBlocks, [{ type: 'text', text: 'Image cap' }]);

  // 50 MiB total cap: a 45 MiB PDF resource_link fits, then a 6 MiB PDF exceeds 50 MiB and is skipped,
  // while a small image (8 bytes) after it still fits inside the remaining 5 MiB budget.
  const bigPdfPath = path.join(dir, 'big-45m.pdf');
  const bigPdfHandle = await fs.open(bigPdfPath, 'w');
  await bigPdfHandle.truncate(45 * 1024 * 1024);
  await bigPdfHandle.close();

  const secondPdfPath = path.join(dir, 'extra-6m.pdf');
  const secondPdfHandle = await fs.open(secondPdfPath, 'w');
  await secondPdfHandle.truncate(6 * 1024 * 1024);
  await secondPdfHandle.close();

  const totalCapBlocks = await buildAcpPromptBlocks(
    'Total cap',
    [
      { path: bigPdfPath, mimeType: 'application/pdf' },
      { path: secondPdfPath, mimeType: 'application/pdf' },
      { path: pngPath, mimeType: 'image/png' },
    ],
    { image: true, embeddedContext: true }
  );
  assert.deepEqual(
    totalCapBlocks.map((block) => block.type),
    ['text', 'resource_link', 'image']
  );
  assert.equal(totalCapBlocks[1].size, 45 * 1024 * 1024);

  const overTotalPdfPath = path.join(dir, 'over-50m.pdf');
  const overTotalHandle = await fs.open(overTotalPdfPath, 'w');
  await overTotalHandle.truncate(ACP_MAX_TOTAL_BYTES + 1);
  await overTotalHandle.close();
  const overTotalBlocks = await buildAcpPromptBlocks('Over 50M', [{ path: overTotalPdfPath }], {
    embeddedContext: true,
  });
  assert.deepEqual(overTotalBlocks, [{ type: 'text', text: 'Over 50M' }]);

  console.log('ok  ACP prompt blocks & cross-provider MIME normalization tests passed');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
