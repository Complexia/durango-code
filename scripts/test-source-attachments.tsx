import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { create } from 'zustand';
import { setSourceAttachmentAccount, sourceAttachmentSrc } from '../src/app/sourceAttachments';
import { createSourceAttachmentHandler, parseSourceAttachmentUrl } from '../src/main/source-attachments.js';

mock.module('../src/store', () => ({ useOrionStore: create(() => ({ threads: [] })) }));
const { MarkdownContent } = await import('../src/app/markdown');

// --- Renderer: which image links load through the main process -------------

const appUrl = 'orion-source-attachment://source/complexia/durango/att_nya4w6q2np4hhv4u5owo?account=user_a';
const src = (value: string, account: string | null = 'user_a') => sourceAttachmentSrc(value, account);
// The Markdown `durango-code change attach` prints (root-relative).
assert.equal(src('/api/source/repos/complexia/durango/attachments/att_nya4w6q2np4hhv4u5owo'), appUrl);
// The absolute form (SOURCE_UI_ORIGIN set), on durango.sh and its old host.
assert.equal(src('https://durango.sh/api/source/repos/complexia/durango/attachments/att_nya4w6q2np4hhv4u5owo'), appUrl);
assert.equal(src('https://code.durango.sh/api/source/repos/complexia/durango/attachments/att_nya4w6q2np4hhv4u5owo'), appUrl);
// Anything else keeps its own loading.
for (const value of [
  'https://evil.example/api/source/repos/complexia/durango/attachments/att_x1',
  'http://durango.sh/api/source/repos/complexia/durango/attachments/att_x1',
  '//durango.sh/api/source/repos/complexia/durango/attachments/att_x1',
  '/api/source/repos/complexia/durango/attachments/../secrets',
  '/api/source/repos/complexia/durango/changes/chg_1',
  '/tmp/shot.png',
  'https://example.com/a.png',
  'data:image/png;base64,AAAA',
]) {
  assert.equal(src(value), null, value);
}
// Signed out: no rewrite. Another account: another URL (so nothing cached for
// the first one is reused).
assert.equal(src('/api/source/repos/complexia/durango/attachments/att_x1', null), null);
assert.equal(
  src('/api/source/repos/complexia/durango/attachments/att_x1', 'user b'),
  'orion-source-attachment://source/complexia/durango/att_x1?account=user%20b'
);

setSourceAttachmentAccount('user_a');
const markup = renderToStaticMarkup(
  <MarkdownContent content={'![Official server card](/api/source/repos/complexia/durango/attachments/att_nya4w6q2np4hhv4u5owo)'} />
);
assert.match(markup, new RegExp(`<img[^>]*src="${appUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
assert.match(markup, /alt="Official server card"/);
assert.match(markup, /data-lightbox=""/, 'opens in the lightbox like other images');
setSourceAttachmentAccount(null);
assert.doesNotMatch(
  renderToStaticMarkup(<MarkdownContent content={'![x](/api/source/repos/complexia/durango/attachments/att_nya4w6q2np4hhv4u5owo)'} />),
  /orion-source-attachment/,
  'signed out: no Source image URL'
);

// --- Main: the protocol handler -------------------------------------------

assert.deepEqual(parseSourceAttachmentUrl(appUrl), {
  owner: 'complexia',
  name: 'durango',
  attachmentId: 'att_nya4w6q2np4hhv4u5owo',
  account: 'user_a',
});
assert.equal(parseSourceAttachmentUrl('orion-source-attachment://source/complexia/durango/att_nya4w6q2np4hhv4u5owo'), null, 'needs an account');
assert.equal(parseSourceAttachmentUrl('orion-source-attachment://source/complexia/durango/not-an-id'), null);
assert.equal(parseSourceAttachmentUrl('orion-source-attachment://source/complexia/%2e%2e/att_1'), null);
assert.equal(parseSourceAttachmentUrl('orion-source-attachment://source/a/b/c/att_1'), null);
assert.equal(parseSourceAttachmentUrl('orion-source-attachment://other/a/b/att_1'), null);

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const calls: Array<{ url: string; authorization: string | null; redirect: string | undefined }> = [];
let answer: () => Response = () => new Response(png, { headers: { 'content-type': 'image/png' } });
const fetchImpl = async (url: URL, init: RequestInit) => {
  calls.push({ url: String(url), authorization: new Headers(init.headers).get('authorization'), redirect: init.redirect });
  return answer();
};
let signedInAs: string | null = 'user_a';
const credentials = {
  get: async () => {
    if (!signedInAs) throw Object.assign(new Error('Sign in to Durango once to authorize repository access on this device.'), { needsAuth: true });
    return { token: `orion_pat_${signedInAs}`, user: { id: signedInAs } };
  },
};
const sourceAttachments = createSourceAttachmentHandler({ credentials, webOrigin: () => 'https://durango.sh/', fetchImpl });

const first = await sourceAttachments.handle(new Request(appUrl));
assert.equal(first.status, 200);
assert.equal(first.headers.get('content-type'), 'image/png');
assert.equal(first.headers.get('cache-control'), 'no-store', 'Chromium must not keep it across accounts');
assert.deepEqual(new Uint8Array(await first.arrayBuffer()), png);
assert.deepEqual(calls, [
  {
    url: 'https://durango.sh/api/source/repos/complexia/durango/attachments/att_nya4w6q2np4hhv4u5owo',
    authorization: 'Bearer orion_pat_user_a',
    redirect: 'error',
  },
]);

// Cached: the same image again (and concurrently) makes no new request.
await Promise.all([sourceAttachments.handle(new Request(appUrl)), sourceAttachments.handle(new Request(appUrl))]);
assert.equal(calls.length, 1);

// Concurrent first loads share one request.
const other = 'orion-source-attachment://source/complexia/durango/att_other1?account=user_a';
const [a, b] = await Promise.all([sourceAttachments.handle(new Request(other)), sourceAttachments.handle(new Request(other))]);
assert.equal(a.status, 200);
assert.equal(b.status, 200);
assert.equal(calls.length, 2);

// Durango's 404 (no access, or no such image) passes through and isn't cached.
answer = () => Response.json({ error: 'Repository not found.' }, { status: 404 });
const missing = 'orion-source-attachment://source/someone/private/att_nope1?account=user_a';
assert.equal((await sourceAttachments.handle(new Request(missing))).status, 404);
assert.equal((await sourceAttachments.handle(new Request(missing))).status, 404);
assert.equal(calls.length, 4);

// A non-image answer is refused.
answer = () => new Response('<html>', { headers: { 'content-type': 'text/html' } });
assert.equal((await sourceAttachments.handle(new Request('orion-source-attachment://source/a/b/att_html1?account=user_a'))).status, 502);

// A URL for another account is refused without a request.
assert.equal((await sourceAttachments.handle(new Request(appUrl.replace('user_a', 'user_b')))).status, 401);
assert.equal(calls.length, 5);

// Signed out: no request, 401. Sign-out also drops the cache.
signedInAs = null;
sourceAttachments.clear();
assert.equal((await sourceAttachments.handle(new Request(appUrl))).status, 401);
assert.equal(calls.length, 5);

// Malformed app URLs never reach the network.
signedInAs = 'user_a';
assert.equal((await sourceAttachments.handle(new Request('orion-source-attachment://source/a/b/c?account=user_a'))).status, 404);
assert.equal(calls.length, 5);

// A load in flight when the account changes is aborted, never returned and
// never cached: the next request (as the new account) fetches again.
{
  const deferredCalls: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = [];
  const deferredFetch = (_url: URL, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(signal.reason));
      deferredCalls.push({ signal, resolve });
    });
  const racing = createSourceAttachmentHandler({ credentials, webOrigin: () => 'https://durango.sh', fetchImpl: deferredFetch });
  const url = 'orion-source-attachment://source/complexia/durango/att_race1?account=user_a';
  const pending = racing.handle(new Request(url));
  while (!deferredCalls.length) await new Promise((resolve) => setTimeout(resolve, 1));
  racing.clear(); // sign-out
  assert.equal(deferredCalls[0].signal.aborted, true, 'the old load is aborted');
  assert.equal((await pending).status, 401, 'the old load is not returned');
  signedInAs = 'user_b';
  const asB = racing.handle(new Request(url.replace('user_a', 'user_b')));
  while (deferredCalls.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  deferredCalls[1].resolve(new Response(png, { headers: { 'content-type': 'image/png' } }));
  assert.equal((await asB).status, 200, "B's own load");
  assert.equal(deferredCalls.length, 2, 'B fetched with its own token instead of reusing A');

  // A load whose response lands after clear() (fetch already resolved) is
  // dropped too.
  const late = createSourceAttachmentHandler({
    credentials,
    webOrigin: () => 'https://durango.sh',
    fetchImpl: async () => {
      late.clear();
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    },
  });
  const lateUrl = 'orion-source-attachment://source/complexia/durango/att_late1?account=user_b';
  assert.equal((await late.handle(new Request(lateUrl))).status, 401);
}

console.log('source attachments: ok');
