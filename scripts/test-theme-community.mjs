// Community themes (src/main/theme-community.js): sharing a theme to
// durango.sh and installing one, against an in-memory stand-in for the
// durango.sh API and storage. Plain Node: no Electron, no network.
//
//   node --no-warnings scripts/test-theme-community.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/main/ui-themes-store.js';
import { BUILTIN_THEMES } from '../src/ui-themes-builtin.js';
import {
  communitySlugFrom,
  configureCommunityThemes,
  installCommunityTheme,
  previewCommunityTheme,
  shareTheme,
  themeFileNames,
  themeInstallLinkSlug,
  unshareTheme,
} from '../src/main/theme-community.js';
import { DurangoError } from '../src/main/durango-client.js';
import { themeShareFingerprint } from '../src/ui-themes.js';

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// --- a fake durango.sh -----------------------------------------------------------------
const objects = new Map(); // "owner/sha" → bytes
const shared = new Map(); // slug → { ownerId, theme, assets, version, listed }
let slugCounter = 0;
const calls = [];

const fakeClient = (ownerId) => ({
  async baseUrl() {
    return 'https://durango.test';
  },
  async prepareThemeUploads(assets) {
    calls.push(['uploads', assets.length]);
    return assets.map((asset) => ({
      ...asset,
      contentType: asset.name.endsWith('.png') ? 'image/png' : 'video/mp4',
      uploadUrl: objects.has(`${ownerId}/${asset.sha256}`) ? null : `https://storage.test/put/${ownerId}/${asset.sha256}`,
    }));
  },
  async publishTheme(body) {
    calls.push(['publish', body.slug ?? null]);
    for (const field of ['id', 'threadId', 'saved', 'revision', 'published', 'origin']) {
      assert.ok(!(field in body.theme), `${field} is not shared`);
    }
    for (const asset of body.assets) assert.ok(objects.has(`${ownerId}/${asset.sha256}`), `${asset.name} was uploaded`);
    if (body.slug) {
      const current = shared.get(body.slug);
      if (!current || current.ownerId !== ownerId) throw new DurangoError('api', 'gone', { status: 404 });
      Object.assign(current, { theme: body.theme, assets: body.assets, version: current.version + 1 });
      return { slug: body.slug, version: current.version, listed: current.listed, url: `https://durango.test/code/themes/${body.slug}` };
    }
    const slug = `slug${String(++slugCounter).padStart(6, '0')}`;
    shared.set(slug, { ownerId, theme: body.theme, assets: body.assets, version: 1, listed: body.listed === true, thumbnail: body.thumbnail });
    return { slug, version: 1, listed: body.listed === true, url: `https://durango.test/code/themes/${slug}` };
  },
  async setSharedThemeListed(slug, listed) {
    shared.get(slug).listed = listed;
    return { slug, listed };
  },
  async deleteSharedTheme(slug) {
    shared.delete(slug);
    return { deleted: true };
  },
  async recordThemeInstall(slug) {
    calls.push(['install', slug]);
    return { installs: 1 };
  },
  async communityTheme(slug) {
    const entry = shared.get(slug);
    if (!entry) throw new DurangoError('api', 'No community theme has that link.', { status: 404 });
    return {
      slug,
      name: entry.theme.name,
      author: 'themecrafter',
      version: entry.version,
      installs: 3,
      url: `https://durango.test/code/themes/${slug}`,
      theme: entry.theme,
      assets: entry.assets.map((asset) => ({ ...asset, url: `https://storage.test/get/${entry.ownerId}/${asset.sha256}` })),
    };
  },
  async communityThemes() {
    return { themes: [] };
  },
});

let tamper = false;
let encode = false;
let oversize = false;
const fakeFetch = async (url, init = {}) => {
  const { pathname } = new URL(url);
  const [, kind, owner, hash] = pathname.split('/');
  if (kind === 'put' && init.method === 'PUT') {
    const bytes = Buffer.from(init.body);
    assert.equal(sha(bytes), hash, 'uploaded bytes match their hash');
    objects.set(`${owner}/${hash}`, bytes);
    return new Response(null, { status: 200 });
  }
  if (kind === 'get') {
    const bytes = objects.get(`${owner}/${hash}`);
    if (!bytes) return new Response('missing', { status: 404 });
    if (encode) return new Response(bytes, { status: 200, headers: { 'content-encoding': 'gzip' } });
    if (oversize) return new Response(Buffer.concat([bytes, Buffer.alloc(4096)]), { status: 200 });
    const body = tamper ? Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from([bytes.at(-1) ^ 1])]) : bytes;
    return new Response(body, { status: 200 });
  }
  return new Response('?', { status: 400 });
};

// --- run --------------------------------------------------------------------------------
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'theme-community-'));
store.configureThemeStore({ dir: tmp, send: () => {} });

// Links.
assert.equal(communitySlugFrom('abcdefghjk'), 'abcdefghjk');
assert.equal(communitySlugFrom('durango.sh/code/themes/abcdefghjk'), 'abcdefghjk');
assert.equal(communitySlugFrom('https://durango.sh/code/themes/abcdefghjk/'), 'abcdefghjk');
assert.equal(communitySlugFrom('orion://theme/install?slug=abcdefghjk'), 'abcdefghjk');
assert.equal(communitySlugFrom('https://durango.sh/code/themes/../etc'), null);
assert.equal(themeInstallLinkSlug('orion://theme/install?slug=abcdefghjk', 'orion'), 'abcdefghjk');
assert.equal(themeInstallLinkSlug('orion://auth/callback?code=1', 'orion'), null);
assert.equal(themeInstallLinkSlug('orion://theme/install?slug=../../x', 'orion'), null);

// A theme with an image backdrop, a variant and a CSS file reference.
const { theme: draft } = await store.updateTheme({
  patch: { name: 'Night Pines', tokens: { accent: '#7fd3ff' } },
  threadId: 'thread-1',
});
const wall = Buffer.from(`fake png ${crypto.randomUUID()}`);
const night = Buffer.from(`fake night png ${crypto.randomUUID()}`);
const wallName = await store.writeThemeAsset(draft.id, wall, 'png', 'backdrop');
const nightName = await store.writeThemeAsset(draft.id, night, 'png', 'night');
const { theme: mine } = await store.updateTheme({
  id: draft.id,
  threadId: 'thread-1',
  patch: {
    backdrop: { type: 'image', asset: wallName, dim: 0.2, variants: [{ when: { time: 'night' }, asset: nightName }] },
    values: { time: { type: 'choice', options: [{ value: 'day' }, { value: 'night' }], default: 'day' } },
    css: `.x{background:theme-asset("${wallName}")}`,
  },
});
assert.deepEqual(themeFileNames(mine).sort(), [nightName, wallName].sort());

const thumbnailFor = (bytes) => Buffer.from(`thumb of ${bytes.length}`);
configureCommunityThemes({ durangoClient: fakeClient('owner'), fetch: fakeFetch, thumbnail: thumbnailFor });

// Share: uploads both files and a thumbnail of the backdrop, publishes, remembers the link.
const first = await shareTheme(mine.id, { listed: true });
assert.equal(first.shared.slug, 'slug000001');
assert.deepEqual(first.theme.published, {
  slug: 'slug000001',
  version: 1,
  listed: true,
  revision: mine.revision,
  fingerprint: themeShareFingerprint(mine),
});
// A rename is not a new revision, but it changes what would be shared.
const renamed = await store.renameTheme(mine.id, 'Night Pines II');
assert.equal(renamed.revision, first.theme.revision);
assert.notEqual(themeShareFingerprint(renamed), renamed.published.fingerprint);
await store.renameTheme(mine.id, 'Night Pines');
assert.equal(objects.size, 3);
assert.equal(shared.get('slug000001').thumbnail, 'community-thumbnail.jpg');

// Edit and share again: same link, new version, no re-upload of unchanged files.
calls.length = 0;
await store.updateTheme({ id: mine.id, threadId: 'thread-1', patch: { tokens: { accent: '#ffb86b' } } });
const second = await shareTheme(mine.id);
assert.equal(second.shared.slug, 'slug000001');
assert.equal(second.theme.published.version, 2);
assert.equal(second.theme.published.listed, true, 'keeps listed when not given');
assert.deepEqual(calls, [['uploads', 3], ['publish', 'slug000001']]);

// A duplicate is a new theme, not the shared one.
const copy = await store.duplicateTheme(mine.id);
assert.equal(copy.published, undefined);

// Built-ins can't be shared.
await assert.rejects(shareTheme(BUILTIN_THEMES[0].id), /Duplicate it/);

// Install as someone else: files checked, saved, applied, origin kept.
configureCommunityThemes({ durangoClient: fakeClient('someone'), fetch: fakeFetch });
const preview = await previewCommunityTheme('https://durango.test/code/themes/slug000001');
assert.equal(preview.name, 'Night Pines');
assert.equal(preview.bytes, wall.length + night.length);
assert.equal(preview.installedId, null);

tamper = true;
await assert.rejects(installCommunityTheme('slug000001'), /did not match/);
tamper = false;
encode = true;
await assert.rejects(installCommunityTheme('slug000001'), /encoded/);
encode = false;
oversize = true;
await assert.rejects(installCommunityTheme('slug000001'), /larger than/);
oversize = false;
assert.equal((await store.listThemes()).themes.filter((theme) => theme.origin).length, 0, 'a failed install leaves nothing');

const installed = await installCommunityTheme('slug000001');
assert.equal(installed.alreadyInstalled, false);
const theme = installed.theme;
assert.notEqual(theme.id, mine.id);
assert.equal(theme.saved, true);
assert.equal(theme.threadId, undefined);
assert.equal(theme.published, undefined);
assert.deepEqual(theme.origin, { slug: 'slug000001', version: 2, author: 'themecrafter', name: 'Night Pines' });
assert.equal(theme.tokens.accent, '#ffb86b');
assert.equal(await store.getActiveThemeId(), theme.id);
assert.deepEqual(await fs.readFile(store.themeAssetPath(theme.id, wallName)), wall);
assert.deepEqual(await fs.readFile(store.themeAssetPath(theme.id, nightName)), night);
await assert.rejects(fs.stat(store.themeAssetPath(theme.id, 'community-thumbnail.jpg')), 'the thumbnail is not installed');
assert.ok(calls.some(([kind, slug]) => kind === 'install' && slug === 'slug000001'));

// The same version again applies the copy it has.
await store.setActiveTheme(null);
const again = await installCommunityTheme('durango.sh/code/themes/slug000001');
assert.equal(again.alreadyInstalled, true);
assert.equal(again.theme.id, theme.id);
assert.equal(await store.getActiveThemeId(), theme.id);
assert.equal((await previewCommunityTheme('slug000001')).installedId, theme.id);

// Undo keeps community links; a remix shares with remixedFrom.
await store.updateTheme({ id: theme.id, threadId: 'thread-2', claim: true, patch: { tokens: { accent: '#00ff99' } } });
const undone = await store.undoTheme(theme.id);
assert.deepEqual(undone.origin, theme.origin);
const remix = await shareTheme(theme.id);
assert.notEqual(remix.shared.slug, 'slug000001');

// Stop sharing: the link is gone, the local theme stays.
configureCommunityThemes({ durangoClient: fakeClient('owner'), fetch: fakeFetch });
const unshared = await unshareTheme(mine.id);
assert.equal(unshared.published, undefined);
assert.ok(!shared.has('slug000001'));
await assert.rejects(installCommunityTheme('slug000001'), /No community theme/);

// Two overlapping first shares make one public copy, not two.
const fresh0 = (await store.duplicateTheme(mine.id, { name: 'Overlap' })).id;
const before = shared.size;
const [a, b] = await Promise.all([shareTheme(fresh0), shareTheme(fresh0)]);
assert.equal(a.shared.slug, b.shared.slug);
assert.equal(shared.size, before + 1);

// A shared theme removed on durango.sh is shared again as a new one.
const fresh = await shareTheme(mine.id);
shared.delete(fresh.shared.slug);
const reshared = await shareTheme(mine.id);
assert.notEqual(reshared.shared.slug, fresh.shared.slug);

await fs.rm(tmp, { recursive: true, force: true });
console.log('theme community: ok');
