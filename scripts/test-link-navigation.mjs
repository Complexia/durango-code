import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { markdownUrlTransform } from '../src/app/markdown.tsx';
import { externalWebUrl, linkedFileCandidates, openExternalWebUrl } from '../src/main/linked-navigation.js';

assert.equal(externalWebUrl('https://example.com/docs'), 'https://example.com/docs');
assert.equal(externalWebUrl('http://localhost:4173/test'), 'http://localhost:4173/test');
assert.equal(externalWebUrl(new URL('https://example.com/oauth?x=1')), 'https://example.com/oauth?x=1');
assert.equal(externalWebUrl('  https://example.com/trimmed  '), 'https://example.com/trimmed');
assert.equal(externalWebUrl('file:///tmp/test.ts'), null);
assert.equal(externalWebUrl('javascript:alert(1)'), null);
assert.equal(externalWebUrl('data:text/html,<script>alert(1)</script>'), null);
assert.equal(externalWebUrl('smb://attacker.example/share/payload'), null);
assert.equal(externalWebUrl('ssh://user@host.example'), null);
assert.equal(externalWebUrl('ms-msdt:/id PCWDiagnostic'), null);
assert.equal(externalWebUrl('x-apple.systempreferences:com.apple.preference.security'), null);
assert.equal(externalWebUrl('orion://auth/callback'), null);
assert.equal(externalWebUrl('ht\ntp://example.com'), null);
assert.equal(externalWebUrl('https://example.com/\r\n'), null);
assert.equal(externalWebUrl('http://'), null);
assert.equal(externalWebUrl(''), null);
assert.equal(externalWebUrl(null), null);
assert.equal(externalWebUrl(undefined), null);
assert.equal(externalWebUrl({ toString: () => 'https://example.com' }), null);

const openedExternally = [];
const opened = await openExternalWebUrl('https://example.com/ok', async (u) => {
  openedExternally.push(u);
});
assert.equal(opened, 'https://example.com/ok');
assert.deepEqual(openedExternally, ['https://example.com/ok']);
await assert.rejects(
  openExternalWebUrl('file:///Applications/Calculator.app', async (u) => {
    openedExternally.push(u);
  }),
  /http and https/
);
assert.deepEqual(openedExternally, ['https://example.com/ok'], 'blocked scheme never reaches shell.openExternal');

assert.deepEqual(
  linkedFileCandidates('/workspace/src/app.ts:42:7', ['/ignored'], '/Users/test'),
  ['/workspace/src/app.ts:42:7', '/workspace/src/app.ts']
);
assert.deepEqual(
  linkedFileCandidates('src/app.ts#L42-L45', ['/workspace'], '/Users/test'),
  ['/workspace/src/app.ts#L42-L45', '/workspace/src/app.ts']
);
assert.deepEqual(
  linkedFileCandidates('src/app.ts:42', ['/first', '/second'], '/Users/test'),
  [
    '/first/src/app.ts:42',
    '/first/src/app.ts',
    '/second/src/app.ts:42',
    '/second/src/app.ts',
  ]
);
assert.deepEqual(
  linkedFileCandidates('app.ts:42', ['/workspace'], '/Users/test'),
  ['/workspace/app.ts:42', '/workspace/app.ts']
);
assert.deepEqual(
  linkedFileCandidates('Makefile:42', ['/workspace'], '/Users/test'),
  ['/workspace/Makefile:42', '/workspace/Makefile']
);
assert.deepEqual(
  linkedFileCandidates('Dockerfile:10:3', ['/workspace'], '/Users/test'),
  ['/workspace/Dockerfile:10:3', '/workspace/Dockerfile']
);
assert.deepEqual(
  linkedFileCandidates('README.md#install', ['/workspace'], '/Users/test'),
  ['/workspace/README.md#install', '/workspace/README.md']
);
assert.deepEqual(
  linkedFileCandidates('file:///workspace/My%20File.ts:9', [], '/Users/test'),
  ['/workspace/My File.ts:9', '/workspace/My File.ts']
);
assert.deepEqual(
  linkedFileCandidates('~/notes.md:3', [], '/Users/test'),
  ['/Users/test/notes.md:3', '/Users/test/notes.md']
);
assert.deepEqual(linkedFileCandidates('https://example.com/file.ts', ['/workspace'], '/Users/test'), []);
assert.deepEqual(linkedFileCandidates('#heading', ['/workspace'], '/Users/test'), []);

assert.equal(markdownUrlTransform('app.ts:42'), 'app.ts:42');
assert.equal(markdownUrlTransform('src/app.ts:42:7'), 'src/app.ts:42:7');
assert.equal(markdownUrlTransform('Makefile:42'), 'Makefile:42');
assert.equal(markdownUrlTransform('Dockerfile:10'), 'Dockerfile:10');
assert.equal(markdownUrlTransform('javascript:alert(1)'), '');

const [mainSource, markdownSource, preloadSource] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/markdown.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/preload.js', import.meta.url), 'utf8'),
]);

assert.match(mainSource, /setWindowOpenHandler[\s\S]*action: 'deny'/);
assert.match(mainSource, /webContents\.on\('will-navigate'[\s\S]*event\.preventDefault\(\)/);
assert.match(mainSource, /ipcMain\.handle\('fs:openLinkedFile'/);
assert.match(markdownSource, /components=\{markdownComponents\}/);
assert.match(markdownSource, /openExternalUrl\(webHref\)/);
assert.match(markdownSource, /openLinkedFile\(\{ href, baseDirs \}\)[\s\S]*setActiveTab\('code'\)/);
assert.match(preloadSource, /openLinkedFile: \(input\) => ipcRenderer\.invoke\('fs:openLinkedFile', input\)/);

console.log(`Link navigation tests passed on ${path.basename(process.cwd())}.`);
