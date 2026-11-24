import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { RestartToUpdateDialog } from '../src/app/AppUpdateUi';
import { ConfirmModal, confirmDialog, useConfirmDialog } from '../src/app/ConfirmDialog';

// 1. Imperative confirmDialog queues concurrent requests in FIFO order and resolves cleanly.
const firstPromise = confirmDialog({
  title: 'Delete bot?',
  description: 'This removes the bot and its conversation.',
  confirmLabel: 'Delete',
  tone: 'danger',
});
const secondPromise = confirmDialog({
  title: 'Land c42?',
  confirmLabel: 'Land',
});

assert.equal(useConfirmDialog.getState().queue.length, 2);
assert.equal(useConfirmDialog.getState().queue[0]?.options.title, 'Delete bot?');

useConfirmDialog.getState().settle(true);
assert.equal(await firstPromise, true);
assert.equal(useConfirmDialog.getState().queue.length, 1);
assert.equal(useConfirmDialog.getState().queue[0]?.options.title, 'Land c42?');

useConfirmDialog.getState().settle(false);
assert.equal(await secondPromise, false);
assert.equal(useConfirmDialog.getState().queue.length, 0);

// cancelAll resolves every queued dialog to false.
const queuedA = confirmDialog({ title: 'First?' });
const queuedB = confirmDialog({ title: 'Second?' });
useConfirmDialog.getState().cancelAll();
assert.deepEqual(await Promise.all([queuedA, queuedB]), [false, false]);
assert.equal(useConfirmDialog.getState().queue.length, 0);

// 2. ConfirmModal renders accessible alertdialog markup with optional detail and danger styling.
const dangerHtml = renderToStaticMarkup(
  <ConfirmModal
    title="Delete helper?"
    description="This removes the bot and its conversation."
    detail="line 1\nline 2"
    confirmLabel="Delete"
    cancelLabel="Cancel"
    tone="danger"
    onCancel={() => {}}
    onConfirm={() => {}}
  />
);
assert.match(dangerHtml, /role="alertdialog"/);
assert.match(dangerHtml, /aria-modal="true"/);
assert.match(dangerHtml, /aria-labelledby="[^"]+"/);
assert.match(dangerHtml, /aria-describedby="[^"]+"/);
assert.match(dangerHtml, /Delete helper\?/);
assert.match(dangerHtml, /This removes the bot and its conversation\./);
assert.match(dangerHtml, /<pre[^>]*>line 1/);
assert.match(dangerHtml, /from-\[#ef5350\] to-\[#dc2626\]/);

const titleOnlyHtml = renderToStaticMarkup(
  <ConfirmModal title="Proceed?" onCancel={() => {}} onConfirm={() => {}} />
);
assert.doesNotMatch(titleOnlyHtml, /aria-describedby=/);
assert.match(titleOnlyHtml, />Cancel<\/button>/);
assert.match(titleOnlyHtml, />Confirm<\/button>/);

// 3. RestartToUpdateDialog shares ConfirmModal and keeps its test id and copy.
const restartHtml = renderToStaticMarkup(
  <RestartToUpdateDialog version="v1.0.228" runningThreadCount={2} onCancel={() => {}} onConfirm={() => {}} />
);
assert.match(restartHtml, /data-testid="restart-to-update-dialog"/);
assert.match(restartHtml, /role="alertdialog"/);
assert.match(restartHtml, /Install update v1\.0\.228 and restart Durango Code\?/);
assert.match(restartHtml, /2 threads are running right now\./);

// 4. App root mounts ConfirmDialogHost, BrowserPanel detects alertdialog overlays,
//    and no renderer TypeScript file invokes native browser confirm/alert/prompt.
const srcDir = new URL('../src', import.meta.url).pathname;
const [appSource, browserPanelSource] = await Promise.all([
  readFile(path.join(srcDir, 'App.tsx'), 'utf8'),
  readFile(path.join(srcDir, 'app/BrowserPanel.tsx'), 'utf8'),
]);
assert.match(appSource, /<ConfirmDialogHost \/>/, 'ConfirmDialogHost must be mounted once at the app root');
assert.match(browserPanelSource, /\[role="alertdialog"\]/, 'BrowserPanel must hide native web views behind alertdialogs');

const collectTsFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(full)));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
};

const stripCommentsAndStrings = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""');

const nativeDialogPattern = /(?:^|[^.\w$])(?:window\.)?(?:confirm|alert|prompt)\(/m;
const offenders: string[] = [];
for (const file of await collectTsFiles(srcDir)) {
  const source = await readFile(file, 'utf8');
  if (nativeDialogPattern.test(stripCommentsAndStrings(source))) {
    offenders.push(path.relative(srcDir, file));
  }
}
assert.deepEqual(offenders, [], `Native JS dialog calls found in renderer: ${offenders.join(', ')}`);

console.log('confirm dialog tests passed');
