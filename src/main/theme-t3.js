import fs from 'node:fs/promises';
import path from 'node:path';
import { durangoThemeToT3, looksLikeT3Theme, parseT3ThemeFile, t3BackdropImageAsset, t3ThemeAppearances, t3ThemeId, t3ThemeToDurango, T3_CSS_MAX_LENGTH } from '../t3-themes.js';
import { getTheme, installTheme, listThemes, themeAssetPath } from './ui-themes-store.js';
import { writeFileAtomic } from './atomic-write.js';

// T3 Code themes in and out (src/t3-themes.js converts; docs/themes.md →
// "T3 Code themes"). Import takes a T3 Code theme file (its Export, or the
// published format) from a path, a link or JSON text, and adds it as a saved
// theme. Export writes one file that T3 Code's Settings → Appearance → Import
// and `t3 theme set <file>` both read, with the backdrop picture embedded
// when it fits in T3 Code's 50,000 characters of CSS.

const T3_FILE_MAX_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

let makePicture = null;
let fetchImpl = (...args) => fetch(...args);

/**
 * main.js wires `picture(bytes, maxChars) → data: URL | null` (nativeImage:
 * a JPEG small enough to fit); tests pass fakes and a fake fetch.
 */
export const configureT3Themes = ({ picture, fetch: fetchOverride } = {}) => {
  if (picture !== undefined) makePicture = typeof picture === 'function' ? picture : null;
  if (fetchOverride) fetchImpl = fetchOverride;
};

const isHttpUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
};

/** Whether `input` could be a T3 Code theme source (JSON text, a .json path, or a link), not a community link. */
export const isT3ThemeSource = (input) => {
  const value = String(input ?? '').trim();
  if (!value) return false;
  if (value.startsWith('{')) return true;
  if (isHttpUrl(value)) return true;
  return path.isAbsolute(value) && /\.json$/i.test(value);
};

const readSource = async (input) => {
  const value = String(input ?? '').trim();
  if (value.startsWith('{')) return value;
  if (isHttpUrl(value)) {
    let response;
    try {
      response = await fetchImpl(value, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
    } catch (error) {
      throw new Error(`Could not download that theme (${error?.message ?? error}).`);
    }
    if (!response.ok) throw new Error(`Could not download that theme (${response.status}).`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > T3_FILE_MAX_BYTES) {
      void response.body?.cancel().catch(() => {});
      throw new Error('That file is too large to be a theme.');
    }
    // Read at most the limit (after any decompression), whatever the server says.
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > T3_FILE_MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw new Error('That file is too large to be a theme.');
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return Buffer.concat(chunks, received).toString('utf8');
  }
  if (path.isAbsolute(value)) {
    const stats = await fs.stat(value).catch(() => null);
    if (!stats?.isFile()) throw new Error(`No file at ${value}.`);
    if (stats.size > T3_FILE_MAX_BYTES) throw new Error('That file is too large to be a theme.');
    return fs.readFile(value, 'utf8');
  }
  throw new Error('Pass a T3 Code theme file: a path to a .json file, a link to one, or its JSON.');
};

const parseSource = async (input) => {
  const text = await readSource(input);
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('That is not a T3 Code theme file (not JSON).');
  }
  if (!looksLikeT3Theme(data)) throw new Error('That JSON is not a T3 Code theme (it needs name, appearance and colors).');
  return parseT3ThemeFile(data);
};

/** What the install dialog shows for a T3 Code theme link. */
export const previewT3Theme = async (input) => {
  const parsed = await parseSource(input);
  const installed = (await listThemes()).themes.find((theme) => theme.compat?.t3 && theme.name === parsed.name) ?? null;
  return {
    kind: 't3',
    slug: null,
    name: parsed.name,
    description: '',
    author: null,
    appearance: parsed.appearance,
    installs: 0,
    version: 1,
    url: isHttpUrl(String(input).trim()) ? String(input).trim() : null,
    previewUrl: null,
    bytes: 0,
    animated: /@keyframes|animation\s*:/i.test(parsed.css),
    /** The appearances the file has (its own first); the dialog lets the user pick. */
    appearances: t3ThemeAppearances(parsed),
    installedId: installed?.id ?? null,
  };
};

/** Adds a T3 Code theme (path, link or JSON) as a saved theme and applies it. */
export const importT3Theme = async (input, { activate = true, appearance } = {}) => {
  const parsed = await parseSource(input);
  const patch = t3ThemeToDurango(parsed, { appearance: appearance === 'light' || appearance === 'dark' ? appearance : undefined });
  const theme = await installTheme({ theme: patch, files: {}, origin: undefined, activate });
  return { theme, alreadyInstalled: false };
};

const DATA_URL_SLACK = 400;

/** A data: picture of the backdrop that fits next to the rest of the CSS, or null. */
const backdropPicture = async (theme) => {
  if (!makePicture || theme.builtIn) return null;
  const asset = t3BackdropImageAsset(theme);
  const filePath = asset ? themeAssetPath(theme.id, asset) : null;
  const bytes = filePath ? await fs.readFile(filePath).catch(() => null) : null;
  if (!bytes) return null;
  const { file } = durangoThemeToT3(theme);
  const budget = T3_CSS_MAX_LENGTH - (file.css?.length ?? 0) - DATA_URL_SLACK;
  if (budget < 6_000) return null;
  try {
    return (await makePicture(bytes, budget)) || null;
  } catch {
    return null;
  }
};

/** A T3 Code theme file for one of our themes: `{ file, notes }`. */
export const t3FileForTheme = async (themeOrId) => {
  const theme = typeof themeOrId === 'string' ? await getTheme(themeOrId) : themeOrId;
  if (!theme) throw new Error('That theme no longer exists.');
  const picture = await backdropPicture(theme);
  const result = durangoThemeToT3(theme, { backdropDataUrl: picture });
  if (theme.backdrop?.type === 'image' && !picture && !result.notes.length) {
    result.notes.push('The backdrop picture could not be made small enough for T3 Code, so it was left out.');
  }
  return result;
};

/**
 * Writes the T3 Code file for a theme to `filePath` (a .json path); resolves
 * `{ filePath, notes }`. An existing file is only replaced when it is itself a
 * T3 Code theme, unless `allowOverwrite` (the user picked it in a save dialog).
 */
export const exportThemeToT3 = async (id, filePath, { allowOverwrite = false } = {}) => {
  if (!filePath || !path.isAbsolute(filePath)) throw new Error('Pass an absolute path to save the T3 Code theme file to.');
  if (!/\.json$/i.test(filePath)) throw new Error('A T3 Code theme file must end in .json.');
  if (!allowOverwrite) {
    const existing = await fs.readFile(filePath, 'utf8').catch(() => null);
    let replaceable = existing === null;
    if (existing !== null) {
      try {
        replaceable = looksLikeT3Theme(JSON.parse(existing));
      } catch {}
    }
    if (!replaceable) throw new Error(`There is already a file at ${filePath} that is not a T3 Code theme; pass a new path.`);
  }
  const { file, notes } = await t3FileForTheme(id);
  await writeFileAtomic(filePath, `${JSON.stringify(file, null, 2)}\n`);
  return { filePath, notes, name: file.name };
};

/**
 * A file name for a theme's T3 Code export: `t3 theme set <file>` takes the
 * theme's id from the file name, so it is the id (dc-snowfall-pines.json).
 */
export const t3FileName = (name) => `${t3ThemeId(name)}.json`;

