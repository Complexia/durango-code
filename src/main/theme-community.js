import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { isCommunityThemeSlug, isThemeAssetName, shareableTheme, themeShareFingerprint } from '../ui-themes.js';
import { DurangoError } from './durango-client.js';
import { getTheme, installTheme, listThemes, setActiveTheme, setThemePublished, themeAssetPath } from './ui-themes-store.js';
import { importT3Theme, isT3ThemeSource, previewT3Theme, t3FileForTheme } from './theme-t3.js';

// Community themes (docs/themes.md → "Sharing"): share a theme to
// durango.sh/code/themes and install other people's. The gallery, the
// manifests and the files live on durango.sh; the app only uploads and
// downloads. Sharing needs no account: signed out, the theme is shared as this
// device's anonymous owner (a random key kept in userData, sent as
// X-Durango-Theme-Owner), and `published.anonymous` remembers that, so later
// updates and Stop sharing use the same owner even after signing in. Sharing:
//   1. hash every file the theme uses; durango.sh answers with a presigned
//      PUT for each one it doesn't have (POST /api/v1/themes/uploads);
//   2. PUT those bytes straight to storage;
//   3. POST /api/v1/themes with the theme (local fields left out); the slug
//      of an earlier share updates that one.
// Installing downloads the files, checks each one's size and sha256 against
// the manifest, and adds the theme through the store, which sanitizes it
// like any other theme (ui-themes.js), so a shared theme can do nothing an
// agent-made one couldn't.

export const SHARED_ASSET_MAX_BYTES = 25 * 1024 * 1024;
export const SHARED_TOTAL_MAX_BYTES = 60 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

let client = null;
let fetchImpl = (...args) => fetch(...args);
let makeThumbnail = null;
let anonymousOwnerKey = null;

/**
 * main.js wires the Durango client, `thumbnail(bytes) → JPEG bytes | null`
 * (nativeImage) and `anonymousKey() → Promise<string>` (this device's owner
 * key for sharing without an account); tests pass fakes and a fake fetch.
 */
export const configureCommunityThemes = ({ durangoClient, fetch: fetchOverride, thumbnail, anonymousKey } = {}) => {
  client = durangoClient ?? null;
  if (fetchOverride) fetchImpl = fetchOverride;
  if (thumbnail !== undefined) makeThumbnail = typeof thumbnail === 'function' ? thumbnail : null;
  if (anonymousKey !== undefined) anonymousOwnerKey = typeof anonymousKey === 'function' ? anonymousKey : null;
};

/**
 * Who shares `theme`: the owner it was shared as, else the signed-in account,
 * else this device without an account. `{}` = the account; `{ anonymousKey }`.
 */
const sharerFor = async (theme, api) => {
  const anonymous = theme.published ? theme.published.anonymous === true : !(await api.signedIn());
  if (!anonymous) return {};
  if (!anonymousOwnerKey) throw new Error('Sign in to your Durango account in Durango Code to share themes.');
  return { anonymousKey: await anonymousOwnerKey() };
};

export const THUMBNAIL_NAME = 'community-thumbnail.jpg';
const THUMBNAIL_MAX_BYTES = 1024 * 1024;

/** The picture that stands for the theme: the backdrop image, a video's poster, or a variant's image. */
const thumbnailSource = (theme, files) => {
  const backdrop = theme.backdrop;
  const isImage = (name) => typeof name === 'string' && /\.(png|jpe?g|webp|gif|avif)$/i.test(name);
  const candidates = [backdrop?.type === 'image' ? backdrop.asset : null, backdrop?.poster];
  for (const variant of backdrop?.variants ?? []) candidates.push(variant?.asset, variant?.poster);
  const name = candidates.find((candidate) => isImage(candidate) && files.some((file) => file.name === candidate));
  return name ? files.find((file) => file.name === name) : null;
};

/** A small JPEG for the gallery (the full picture can be several MB), or null. */
const thumbnailFile = async (theme, files) => {
  if (!makeThumbnail || files.some((file) => file.name === THUMBNAIL_NAME)) return null;
  const source = thumbnailSource(theme, files);
  if (!source) return null;
  try {
    const bytes = await makeThumbnail(source.bytes);
    if (!bytes || !bytes.length || bytes.length > THUMBNAIL_MAX_BYTES) return null;
    const buffer = Buffer.from(bytes);
    return { name: THUMBNAIL_NAME, sha256: sha256(buffer), size: buffer.length, bytes: buffer };
  } catch {
    return null;
  }
};

const needClient = () => {
  if (!client) throw new Error('Community themes are not available in this build.');
  return client;
};

const friendly = (error, doing) => {
  if (error instanceof DurangoError) {
    if (error.code === 'not_signed_in') return new Error(`Sign in to your Durango account in Durango Code to ${doing}.`);
    if (error.code === 'network') return new Error(`Could not reach durango.sh to ${doing}. Check your connection and try again.`);
  }
  return error instanceof Error ? error : new Error(String(error));
};

/** A slug from a slug, a theme page URL or an orion://theme/install link; null otherwise. */
export const communitySlugFrom = (input) => {
  const value = String(input ?? '').trim();
  if (isCommunityThemeSlug(value)) return value;
  try {
    // "durango.sh/code/themes/<slug>" pasted without https://.
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
    const fromQuery = url.searchParams.get('slug');
    if (isCommunityThemeSlug(fromQuery)) return fromQuery;
    const match = /\/themes\/([a-z0-9]{10})\/?$/.exec(url.pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
};

/** `orion://theme/install?slug=<slug>` (the gallery's Install button). */
export const themeInstallLinkSlug = (rawUrl, protocol) => {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== `${protocol}:` || url.hostname !== 'theme' || url.pathname !== '/install') return null;
    const slug = url.searchParams.get('slug');
    return isCommunityThemeSlug(slug) ? slug : null;
  } catch {
    return null;
  }
};

/** Every file a theme uses: backdrop, poster, variants, theme-asset("…") in its CSS. */
export const themeFileNames = (theme) => {
  const names = new Set();
  const add = (value) => {
    if (isThemeAssetName(value)) names.add(value);
  };
  const backdrop = theme?.backdrop;
  if (backdrop) {
    add(backdrop.asset);
    add(backdrop.poster);
    for (const variant of backdrop.variants ?? []) {
      add(variant?.asset);
      add(variant?.poster);
    }
  }
  if (typeof theme?.css === 'string') {
    for (const match of theme.css.matchAll(/theme-asset\(\s*['"]?([^'")]+)['"]?\s*\)/g)) add(match[1]?.trim());
  }
  return [...names];
};

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** What a theme would upload: `{ name, sha256, size, bytes }` each, within the limits. */
export const collectThemeFiles = async (theme) => {
  const files = [];
  let total = 0;
  for (const name of themeFileNames(theme)) {
    const filePath = themeAssetPath(theme.id, name);
    const bytes = filePath ? await fs.readFile(filePath).catch(() => null) : null;
    if (!bytes) throw new Error(`The theme's file ${name} is missing, so it can't be shared. Ask an agent to fix the theme first.`);
    if (bytes.length > SHARED_ASSET_MAX_BYTES) {
      throw new Error(`${name} is ${megabytes(bytes.length)}; shared theme files are limited to ${megabytes(SHARED_ASSET_MAX_BYTES)} each. Ask an agent to make a smaller version (a 1080p or 720p video, a compressed image).`);
    }
    total += bytes.length;
    files.push({ name, sha256: sha256(bytes), size: bytes.length, bytes });
  }
  if (total > SHARED_TOTAL_MAX_BYTES) {
    throw new Error(`The theme's files add up to ${megabytes(total)}; a shared theme is limited to ${megabytes(SHARED_TOTAL_MAX_BYTES)}.`);
  }
  return files;
};

// Share, update, list and unshare of one theme run one at a time: two
// overlapping first shares would otherwise make two public copies and remember
// only one of them.
const themeChains = new Map();
const oneAtATime = (id, task) => {
  const previous = themeChains.get(id) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => {});
  themeChains.set(id, tail);
  void tail.then(() => {
    if (themeChains.get(id) === tail) themeChains.delete(id);
  });
  return run;
};

const upload = async (entry, file) => {
  let response;
  try {
    response = await fetchImpl(entry.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': entry.contentType },
      body: file.bytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Uploading ${file.name} failed (${error?.message ?? error}).`);
  }
  if (!response.ok) throw new Error(`Uploading ${file.name} failed (${response.status}).`);
};

/**
 * Share a theme (or update the user's shared copy of it). `listed` puts it in
 * the public gallery; otherwise only people with the link see it. Resolves
 * `{ theme, shared }` (shared: durango.sh's summary, with `url`).
 */
export const shareTheme = (id, { listed } = {}) => oneAtATime(id, () => shareThemeNow(id, { listed }));

const shareThemeNow = async (id, { listed } = {}) => {
  const api = needClient();
  const theme = await getTheme(id);
  if (!theme) throw new Error('That theme no longer exists.');
  if (theme.builtIn) throw new Error('Built-in themes come with Durango Code. Duplicate it, change the copy, and share that.');
  try {
    const files = await collectThemeFiles(theme);
    const thumbnail = await thumbnailFile(theme, files);
    if (thumbnail) files.push(thumbnail);
    const assets = files.map(({ name, sha256: hash, size }) => ({ name, sha256: hash, size }));
    const as = await sharerFor(theme, api);
    if (assets.length) {
      const uploads = await api.prepareThemeUploads(assets, as);
      const byName = new Map(files.map((file) => [file.name, file]));
      for (const entry of uploads) {
        const file = byName.get(entry?.name);
        if (file && typeof entry.uploadUrl === 'string' && entry.uploadUrl) await upload(entry, file);
      }
    }
    // The same theme for T3 Code, so its page can offer it there too.
    const t3 = await t3FileForTheme(theme).then(({ file }) => file, () => null);
    const body = {
      theme: shareableTheme(theme),
      ...(t3 ? { t3 } : {}),
      assets,
      listed: typeof listed === 'boolean' ? listed : theme.published?.listed === true,
      ...(thumbnail ? { thumbnail: thumbnail.name } : {}),
      ...(theme.origin?.slug && theme.origin.slug !== theme.published?.slug ? { remixedFrom: theme.origin.slug } : {}),
    };
    let shared;
    try {
      shared = await api.publishTheme({ ...body, ...(theme.published?.slug ? { slug: theme.published.slug } : {}) }, as);
    } catch (error) {
      // The shared copy was removed on durango.sh: share it as a new one.
      if (!(theme.published?.slug && error instanceof DurangoError && error.status === 404)) throw error;
      shared = await api.publishTheme(body, as);
    }
    if (!isCommunityThemeSlug(shared?.slug)) throw new Error('durango.sh did not return a link for the theme.');
    const updated = await setThemePublished(theme.id, {
      slug: shared.slug,
      version: shared.version,
      listed: shared.listed === true,
      revision: theme.revision,
      fingerprint: themeShareFingerprint(theme),
      ...(as.anonymousKey ? { anonymous: true } : {}),
    });
    return { theme: updated, shared };
  } catch (error) {
    throw friendly(error, 'share themes');
  }
};

/** List a shared theme in the gallery, or keep it link-only. */
export const setSharedThemeListed = (id, listed) => oneAtATime(id, async () => {
  const api = needClient();
  const theme = await getTheme(id);
  if (!theme?.published) throw new Error('That theme is not shared.');
  try {
    const shared = await api.setSharedThemeListed(theme.published.slug, listed, await sharerFor(theme, api));
    const updated = await setThemePublished(theme.id, { ...theme.published, listed: shared.listed === true });
    return { theme: updated, shared };
  } catch (error) {
    throw friendly(error, 'change a shared theme');
  }
});

/** Stop sharing: removes it from durango.sh (copies people installed stay theirs). */
export const unshareTheme = (id) => oneAtATime(id, async () => {
  const api = needClient();
  const theme = await getTheme(id);
  if (!theme?.published) throw new Error('That theme is not shared.');
  try {
    await api.deleteSharedTheme(theme.published.slug, await sharerFor(theme, api));
  } catch (error) {
    if (!(error instanceof DurangoError && error.status === 404)) throw friendly(error, 'stop sharing a theme');
  }
  return setThemePublished(theme.id, null);
});

const sanitizeSummary = (data) => ({
  slug: data.slug,
  name: typeof data.name === 'string' ? data.name.slice(0, 60) : 'Untitled theme',
  description: typeof data.description === 'string' ? data.description.slice(0, 240) : '',
  author: typeof data.author === 'string' ? data.author.slice(0, 40) : null,
  appearance: data.appearance === 'light' ? 'light' : 'dark',
  installs: Number.isInteger(data.installs) ? data.installs : 0,
  version: Number.isInteger(data.version) && data.version > 0 ? data.version : 1,
  url: typeof data.url === 'string' ? data.url : null,
  previewUrl: typeof data.previewUrl === 'string' ? data.previewUrl : null,
});

/** A shared theme's summary and size, for the install dialog. */
export const previewCommunityTheme = async (input) => {
  const slug = communitySlugFrom(input);
  if (!slug && isT3ThemeSource(input)) return previewT3Theme(input);
  if (!slug) throw new Error('That is not a community theme link (durango.sh/code/themes/…) or a T3 Code theme file.');
  try {
    const data = await needClient().communityTheme(slug);
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const installed = (await listThemes()).themes.find((theme) => theme.origin?.slug === slug) ?? null;
    return {
      kind: 'community',
      ...sanitizeSummary(data),
      bytes: assets
        .filter((asset) => themeFileNames(data.theme).includes(asset?.name))
        .reduce((sum, asset) => sum + (Number.isInteger(asset?.size) ? asset.size : 0), 0),
      animated: data.theme?.backdrop?.type === 'html' || data.theme?.backdrop?.type === 'video' || Boolean(data.theme?.overlay),
      installedId: installed?.id ?? null,
    };
  } catch (error) {
    throw friendly(error, 'open community themes');
  }
};

const isAllowedDownload = (rawUrl) => {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
};

const download = async (asset) => {
  if (!isAllowedDownload(asset.url)) throw new Error(`The theme's file ${asset.name} has no download address.`);
  let response;
  try {
    response = await fetchImpl(asset.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Downloading ${asset.name} failed (${error?.message ?? error}).`);
  }
  if (!response.ok) throw new Error(`Downloading ${asset.name} failed (${response.status}).`);
  // fetch() undoes a Content-Encoding before we see the bytes, so a small
  // compressed upload could expand without bound: refuse encoded responses,
  // and never read more than the file's listed size either way.
  const encoding = (response.headers.get('content-encoding') ?? '').trim().toLowerCase();
  if (encoding && encoding !== 'identity') {
    void response.body?.cancel().catch(() => {});
    throw new Error(`${asset.name} came back encoded (${encoding}); not installing it.`);
  }
  const chunks = [];
  let received = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`Downloading ${asset.name} failed (no body).`);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > asset.size) {
      void reader.cancel().catch(() => {});
      throw new Error(`${asset.name} is larger than the shared theme says; not installing it.`);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  const bytes = Buffer.concat(chunks, received);
  if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) {
    throw new Error(`${asset.name} did not match the shared theme (it may have just been updated); try again.`);
  }
  return bytes;
};

/**
 * Install a community theme (slug or link) and apply it. If this computer
 * already has that version, applies the copy it has instead. Resolves
 * `{ theme, alreadyInstalled }`.
 */
export const installCommunityTheme = async (input, { activate = true, appearance } = {}) => {
  const slug = communitySlugFrom(input);
  if (!slug && isT3ThemeSource(input)) return importT3Theme(input, { activate, appearance });
  if (!slug) throw new Error('That is not a community theme link (durango.sh/code/themes/…) or a T3 Code theme file.');
  const api = needClient();
  let data;
  try {
    data = await api.communityTheme(slug);
  } catch (error) {
    throw friendly(error, 'install community themes');
  }
  const summary = sanitizeSummary(data);
  const existing = (await listThemes()).themes.find(
    (theme) => theme.origin?.slug === slug && theme.origin.version === summary.version
  );
  if (existing) {
    if (activate) await setActiveTheme(existing.id);
    return { theme: existing, alreadyInstalled: true };
  }
  if (!data.theme || typeof data.theme !== 'object') throw new Error('durango.sh sent no theme.');
  const wanted = new Set(themeFileNames(data.theme));
  const assets = (Array.isArray(data.assets) ? data.assets : []).filter(
    (asset) =>
      asset &&
      wanted.has(asset.name) &&
      isThemeAssetName(asset.name) &&
      Number.isInteger(asset.size) &&
      asset.size > 0 &&
      asset.size <= SHARED_ASSET_MAX_BYTES &&
      /^[a-f0-9]{64}$/.test(asset.sha256 ?? '')
  );
  if (assets.reduce((sum, asset) => sum + asset.size, 0) > SHARED_TOTAL_MAX_BYTES) throw new Error('That theme is too large to install.');
  const files = {};
  for (const asset of assets) files[asset.name] = await download(asset);
  const theme = await installTheme({
    theme: data.theme,
    files,
    origin: { slug, version: summary.version, author: summary.author ?? undefined, name: summary.name },
    activate,
  });
  // Counted once per account; signed out (or offline) it simply isn't.
  void api.recordThemeInstall(slug).catch(() => {});
  return { theme, alreadyInstalled: false };
};

/** The public gallery, for agents: `[{ slug, name, description, author, installs, url }]`. */
export const browseCommunityThemes = async ({ q, sort, limit } = {}) => {
  try {
    const data = await needClient().communityThemes({ q, sort, limit });
    return (Array.isArray(data.themes) ? data.themes : []).filter((entry) => isCommunityThemeSlug(entry?.slug)).map(sanitizeSummary);
  } catch (error) {
    throw friendly(error, 'browse community themes');
  }
};

/** durango.sh/code/themes (or the dev server's). */
export const communityGalleryUrl = async () => {
  const base = client ? await client.baseUrl() : 'https://durango.sh';
  return new URL('/code/themes', base).toString();
};
