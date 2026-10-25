import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { create } from 'zustand';

mock.module('../src/store', () => ({ useOrionStore: create(() => ({ threads: [] })) }));
const { MarkdownContent } = await import('../src/app/markdown');

const html = (content: string) => renderToStaticMarkup(<MarkdownContent content={content} />);
const previews = (markup: string) =>
  [...markup.matchAll(/<(?:img|video)[^>]*data-path-preview[^>]*>/g)].map((match) =>
    decodeURIComponent(/path=([^&"]+)/.exec(match[0])?.[1] ?? '')
  );

// The report from the thread that prompted this: paths in code spans.
const report = html(
  [
    '**Screenshots:**',
    '- Dark, top of the page: `/tmp/source-ui-shots/source-dark-top.jpg`',
    '- Light: `~/Desktop/Screenshot 2026-10-26 at 7.12.15 AM.png`',
  ].join('\n')
);
assert.deepEqual(previews(report), [
  '/tmp/source-ui-shots/source-dark-top.jpg',
  '~/Desktop/Screenshot 2026-10-26 at 7.12.15 AM.png',
]);
assert.match(report, /<code>\/tmp\/source-ui-shots\/source-dark-top\.jpg<\/code>/, 'the path itself stays visible');
assert.match(report, /alt="source-dark-top\.jpg"/);
assert.match(report, /data-lightbox=""/, 'previews open in the lightbox');

// Prose, links, file:// URLs, and videos; one preview per path.
const prose = html(
  [
    'Saved to /tmp/a.png. Also see [the recording](/tmp/run.mp4) and file:///tmp/b.webp, and /tmp/a.png again.',
    '',
    'Then (/tmp/c.gif)',
  ].join('\n')
);
assert.deepEqual(previews(prose), ['/tmp/a.png', '/tmp/run.mp4', '/tmp/b.webp', '/tmp/c.gif']);
assert.match(prose, /<video[^>]*data-path-preview/);

// Already-embedded images aren't shown twice; relative paths, URLs, other
// file types, and fenced code stay text.
const inert = html(
  [
    '![home](/tmp/home.png) is `/tmp/home.png`.',
    '',
    'Edit `assets/logo.png`, https://example.com/x.png, example.com/y.png, `/tmp/notes.txt`, /tmp/a.pngx.',
    '',
    '```',
    '/tmp/fenced.png',
    '```',
  ].join('\n')
);
assert.deepEqual(previews(inert), []);
assert.equal(inert.match(/<img/g)?.length, 1, 'only the embedded image');

console.log('media path preview tests passed');
