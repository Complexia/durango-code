import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  attachmentKindLabel,
  buildPromptWithAttachments,
  isHeicFile,
  isImageFile,
  isVideoFile,
} from '../src/app/attachments';
import { linkedTaskAttachments } from '../src/app/promptContext';
import { ensureMediaExtension, getMimeTypeForMediaPath } from '../src/main/media.js';

const pdfAttachment = {
  id: 'pdf-1',
  name: 'requirements.pdf',
  path: '/tmp/requirements.pdf',
  mimeType: 'application/pdf',
  size: 2048,
};
const imageAttachment = {
  id: 'image-1',
  name: 'diagram.png',
  path: '/tmp/diagram.png',
  mimeType: 'image/png',
  size: 1024,
};

assert.equal(attachmentKindLabel([pdfAttachment]), 'file');
assert.equal(attachmentKindLabel([imageAttachment]), 'image');
assert.equal(attachmentKindLabel([pdfAttachment, imageAttachment]), 'files');
assert.match(
  buildPromptWithAttachments('Summarize this', [pdfAttachment]),
  /Summarize this\n\nAttached file:\nUse these local file paths as references[\s\S]*requirements\.pdf: \/tmp\/requirements\.pdf/,
  'PDF attachments must be described by their readable local path'
);

assert.equal(isImageFile(new File(['image'], 'diagram.png', { type: '' })), true);
assert.equal(isHeicFile(new File(['image'], 'IMG_8336.HEIC', { type: '' })), true);
assert.equal(isHeicFile(new File(['image'], 'photo', { type: 'image/heif' })), true);
assert.equal(isHeicFile(new File(['image'], 'diagram.png', { type: 'image/png' })), false);
assert.equal(isVideoFile(new File(['video'], 'walkthrough.mov', { type: '' })), true);
assert.equal(ensureMediaExtension('pasted-image', 'image/png'), 'pasted-image.png');
assert.equal(ensureMediaExtension('screen-recording', 'video/quicktime'), 'screen-recording.mov');
assert.equal(ensureMediaExtension('diagram.webp', 'image/webp'), 'diagram.webp');
assert.equal(ensureMediaExtension('requirements', 'application/pdf'), 'requirements');
assert.equal(
  getMimeTypeForMediaPath(`/tmp/${ensureMediaExtension('pasted-image', 'image/png')}`),
  'image/png',
  'Copied extensionless media must retain a path-derived content type'
);

const boardAttachments = linkedTaskAttachments([
  {
    id: 'task-1',
    title: 'Read the spec',
    description: '',
    injected: false,
    attachments: [
      {
        id: 'attachment-1',
        name: 'spec.pdf',
        path: '/tmp/spec.pdf',
        mimeType: 'application/pdf',
        size: 42,
      },
    ],
  },
]);
assert.equal(boardAttachments[0]?.name, 'spec.pdf', 'Board PDFs must stay attached to the turn');

const [appSource, mainSource] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
]);

assert.match(
  appSource,
  /type="file"[\s\S]*multiple[\s\S]*attachmentInputRef\.current\?\.click\(\)/,
  'The composer must expose a multi-file picker'
);
assert.doesNotMatch(
  appSource,
  /Array\.from\(files\)\.filter\(isMediaFile\)/,
  'Dropped and picked files must not be filtered down to media'
);
assert.match(mainSource, /ipcMain\.handle\('attachment:save', saveAttachment\)/);
assert.doesNotMatch(
  mainSource,
  /Only image and video attachments are supported/,
  'The persistence boundary must accept arbitrary file types'
);

console.log('Attachment tests passed.');
