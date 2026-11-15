import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  STOCK_THEME_ID,
  isThemeAssetName,
  isThemeId,
  mergeTheme,
  sanitizeTheme,
} from '../ui-themes.js';
import { BUILTIN_THEMES } from '../ui-themes-builtin.js';

// Theme storage for Settings → Customizations (src/ui-themes.js holds the
// format). The main process owns it so agent tools (theme-tools.js), the
// renderer (IPC in main.js) and the "Use Stock Theme" shortcut all see one
// state:
//
//   <userData>/themes/state.json          { activeId }  (null = stock)
//   <userData>/themes/<id>/theme.json      one theme (built-ins are code)
//   <userData>/themes/<id>/history.json    earlier revisions, for Undo
//   <userData>/themes/<id>/<asset>         backdrop images and videos
//
// Every change is broadcast to the renderer ('themes:changed'). A theme an
// agent makes in a thread is that thread's working theme: it is applied at
// once and kept unsaved (not in the gallery) until the user turns Save on, in
// the thread's theme card or in Settings. Unsaved themes nobody uses are
// pruned after UNSAVED_TTL_MS.

const STATE_FILE = 'state.json';
const THEME_FILE = 'theme.json';
const HISTORY_FILE = 'history.json';
const HISTORY_LIMIT = 12;
const UNSAVED_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SCENE_ERROR_LIMIT = 8;

let themesDir = null;
let broadcast = () => {};
let loaded = null;
const themes = new Map();
const sceneErrors = new Map();
let activeId = null;
let writeChain = Promise.resolve();

/** Wire the store (main.js): where themes live and how to tell the renderer. */
export const configureThemeStore = ({ dir, send }) => {
  themesDir = dir;
  broadcast = typeof send === 'function' ? send : () => {};
  loaded = null;
  themes.clear();
  activeId = null;
};

const builtInById = new Map(
  BUILTIN_THEMES.map((theme) => sanitizeTheme(theme)).filter(Boolean).map((theme) => [theme.id, theme])
);

const themeDir = (id) => path.join(themesDir, id);

// Every change is one read-modify-write run alone (an Undo racing an agent's
// edit must not restore the same revision twice or drop history).
let opChain = Promise.resolve();
const exclusive = (task) => {
  const run = opChain.then(task, task);
  opChain = run.catch(() => {});
  return run;
};

// Writes go through one chain so a burst of agent edits lands in order.
const queueWrite = (task) => {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => {});
  return run;
};

const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 6)}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, file);
};

const readJson = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

const ensureLoaded = () => {
  if (!themesDir) throw new Error('Theme storage is not configured.');
  loaded ??= (async () => {
    await fs.mkdir(themesDir, { recursive: true });
    const state = await readJson(path.join(themesDir, STATE_FILE));
    const entries = await fs.readdir(themesDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !isThemeId(entry.name) || builtInById.has(entry.name)) continue;
      const theme = sanitizeTheme(await readJson(path.join(themesDir, entry.name, THEME_FILE)));
      if (theme && theme.id === entry.name) themes.set(theme.id, theme);
    }
    const wanted = typeof state?.activeId === 'string' ? state.activeId : null;
    activeId = wanted && (themes.has(wanted) || builtInById.has(wanted)) ? wanted : null;
    // Unsaved drafts nobody kept.
    const cutoff = Date.now() - UNSAVED_TTL_MS;
    for (const theme of [...themes.values()]) {
      if (theme.saved || theme.id === activeId) continue;
      if (Date.parse(theme.updatedAt ?? '') < cutoff) {
        themes.delete(theme.id);
        await fs.rm(themeDir(theme.id), { recursive: true, force: true }).catch(() => {});
      }
    }
  })();
  return loaded;
};

const snapshot = () => ({
  activeId,
  dir: themesDir,
  themes: [...builtInById.values(), ...[...themes.values()].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))],
});

const notify = () => {
  try {
    broadcast(snapshot());
  } catch {}
};

/** Everything the renderer needs: themes (built-ins first), the active id, the folder. */
export const listThemes = async () => {
  await ensureLoaded();
  return snapshot();
};

export const getTheme = async (id) => {
  await ensureLoaded();
  return builtInById.get(id) ?? themes.get(id) ?? null;
};

export const getActiveTheme = async () => {
  await ensureLoaded();
  return activeId ? (builtInById.get(activeId) ?? themes.get(activeId) ?? null) : null;
};

export const getActiveThemeId = async () => {
  await ensureLoaded();
  return activeId;
};

export const themeAssetPath = (id, asset) =>
  isThemeId(id) && isThemeAssetName(asset) ? path.join(themeDir(id), asset) : null;

const persistState = () => queueWrite(() => writeJson(path.join(themesDir, STATE_FILE), { activeId }));

/** Apply a theme (or stock: null / 'stock'). */
export const setActiveTheme = (id) => exclusive(async () => {
  await ensureLoaded();
  const next = !id || id === STOCK_THEME_ID ? null : id;
  if (next && !builtInById.has(next) && !themes.has(next)) throw new Error('That theme no longer exists.');
  if (next === activeId) return snapshot();
  activeId = next;
  await persistState();
  notify();
  return snapshot();
});

const appendHistory = async (previous) => {
  const file = path.join(themeDir(previous.id), HISTORY_FILE);
  const history = (await readJson(file)) ?? [];
  const list = Array.isArray(history) ? history : [];
  list.push(previous);
  await writeJson(file, list.slice(-HISTORY_LIMIT));
};

const storeTheme = async (theme, { previous } = {}) => {
  themes.set(theme.id, theme);
  await queueWrite(async () => {
    if (previous) await appendHistory(previous);
    await writeJson(path.join(themeDir(theme.id), THEME_FILE), theme);
  });
};

export const newThemeId = () => `t${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

/** The theme an agent in `threadId` is shaping: its most recent one. */
export const workingThemeFor = async (threadId) => {
  await ensureLoaded();
  if (!threadId) return null;
  let found = null;
  for (const theme of themes.values()) {
    if (theme.threadId !== threadId) continue;
    if (!found || (theme.updatedAt ?? '') > (found.updatedAt ?? '')) found = theme;
  }
  return found;
};

/**
 * Change a theme (or create one from `base`, a theme to start from) and apply
 * it. `patch` uses mergeTheme's fields. Returns `{ theme, ignored }`.
 */
export const updateTheme = ({ id, patch, threadId, base, activate = true, saved }) => exclusive(async () => {
  await ensureLoaded();
  const current = id ? themes.get(id) ?? null : null;
  if (id && !current) throw new Error('That theme no longer exists.');
  const start = current ?? (base ? { ...base, id: undefined, builtIn: false, saved: false, revision: 0, createdAt: undefined } : null);
  const themeId = current?.id ?? newThemeId();
  const { theme, ignored } = mergeTheme(start, patch ?? {}, { id: themeId, threadId: current?.threadId ?? threadId });
  if (!theme) throw new Error('The theme could not be built from those values.');
  if (typeof saved === 'boolean') theme.saved = saved;
  else theme.saved = current?.saved ?? false;
  // Built-in files (a base built-in has none) carry over from a user base.
  if (!current && base && !base.builtIn && base.id && themes.has(base.id)) {
    await copyAssets(base.id, themeId);
  }
  await storeTheme(theme, { previous: current ?? undefined });
  if (activate && activeId !== theme.id) {
    activeId = theme.id;
    await persistState();
  }
  sceneErrors.delete(theme.id);
  notify();
  return { theme, ignored };
});

/** Turn Save on or off (on = listed in Settings and never pruned). */
export const setThemeSaved = (id, saved) => exclusive(async () => {
  await ensureLoaded();
  const theme = themes.get(id);
  if (!theme) throw new Error('That theme no longer exists.');
  const next = { ...theme, saved: Boolean(saved) };
  await storeTheme(next);
  notify();
  return next;
});

export const renameTheme = (id, name) => exclusive(async () => {
  await ensureLoaded();
  const theme = themes.get(id);
  if (!theme) throw new Error('That theme no longer exists.');
  const next = sanitizeTheme({ ...theme, name });
  await storeTheme(next);
  notify();
  return next;
});

const copyAssets = async (fromId, toId) => {
  const entries = await fs.readdir(themeDir(fromId)).catch(() => []);
  await fs.mkdir(themeDir(toId), { recursive: true });
  for (const name of entries) {
    if (isThemeAssetName(name)) await fs.copyFile(path.join(themeDir(fromId), name), path.join(themeDir(toId), name));
  }
};

/** A saved copy of any theme (built-ins included) the user can change. */
export const duplicateTheme = (id, { name } = {}) => exclusive(async () => {
  await ensureLoaded();
  const source = builtInById.get(id) ?? themes.get(id);
  if (!source) throw new Error('That theme no longer exists.');
  const copyId = newThemeId();
  const now = new Date().toISOString();
  const copy = sanitizeTheme({
    ...source,
    id: copyId,
    builtIn: false,
    saved: true,
    threadId: undefined,
    name: name ?? `${source.name} copy`,
    createdAt: now,
    updatedAt: now,
    revision: 1,
  });
  if (!source.builtIn) await copyAssets(source.id, copyId);
  await storeTheme(copy);
  notify();
  return copy;
});

export const deleteTheme = (id) => exclusive(async () => {
  await ensureLoaded();
  if (!themes.has(id)) throw new Error('Built-in themes cannot be deleted.');
  themes.delete(id);
  sceneErrors.delete(id);
  if (activeId === id) {
    activeId = null;
    await persistState();
  }
  await queueWrite(() => fs.rm(themeDir(id), { recursive: true, force: true }));
  notify();
  return snapshot();
});

/** Step a theme back to its previous revision. */
export const undoTheme = (id) => exclusive(async () => {
  await ensureLoaded();
  const current = themes.get(id);
  if (!current) throw new Error('That theme no longer exists.');
  const file = path.join(themeDir(id), HISTORY_FILE);
  const history = (await readJson(file)) ?? [];
  const previous = sanitizeTheme(Array.isArray(history) ? history[history.length - 1] : null);
  if (!previous || previous.id !== id) throw new Error('There is nothing to undo for this theme.');
  const restored = {
    ...previous,
    saved: current.saved,
    name: previous.name,
    revision: (current.revision ?? 1) + 1,
    updatedAt: new Date().toISOString(),
  };
  themes.set(id, restored);
  await queueWrite(async () => {
    await writeJson(file, history.slice(0, -1));
    await writeJson(path.join(themeDir(id), THEME_FILE), restored);
  });
  if (activeId !== id) {
    activeId = id;
    await persistState();
  }
  sceneErrors.delete(id);
  notify();
  return restored;
});

export const canUndoTheme = async (id) => {
  if (!themes.has(id)) return false;
  const history = await readJson(path.join(themeDir(id), HISTORY_FILE));
  return Array.isArray(history) && history.length > 0;
};

const extensionFor = (mimeOrExt) => {
  const value = String(mimeOrExt ?? '').toLowerCase().replace(/^\./, '');
  if (/png/.test(value)) return 'png';
  if (/jpe?g/.test(value)) return 'jpg';
  if (/webp/.test(value)) return 'webp';
  if (/gif/.test(value)) return 'gif';
  if (/avif/.test(value)) return 'avif';
  if (/mp4/.test(value)) return 'mp4';
  if (/webm/.test(value)) return 'webm';
  if (/mov|quicktime/.test(value)) return 'mov';
  return null;
};

export const THEME_ASSET_MAX_BYTES = 200 * 1024 * 1024;

/** Store bytes as a theme file; returns its name. */
export const writeThemeAsset = async (id, data, mimeOrExt, prefix = 'backdrop') => {
  if (!isThemeId(id)) throw new Error('Bad theme id.');
  const ext = extensionFor(mimeOrExt);
  if (!ext) throw new Error('Only images (png, jpg, webp, gif, avif) and videos (mp4, webm, mov) can be theme files.');
  if (data.length > THEME_ASSET_MAX_BYTES) throw new Error('That file is too large for a theme (200 MB at most).');
  const name = `${prefix}-${Date.now().toString(36)}.${ext}`;
  await fs.mkdir(themeDir(id), { recursive: true });
  await fs.writeFile(path.join(themeDir(id), name), data);
  return name;
};

/** Copy a file on disk into a theme; returns its name. */
export const importThemeAsset = async (id, sourcePath, prefix = 'backdrop') => {
  const stats = await fs.stat(sourcePath).catch(() => null);
  if (!stats?.isFile()) throw new Error(`No file at ${sourcePath}.`);
  if (stats.size > THEME_ASSET_MAX_BYTES) throw new Error('That file is too large for a theme (200 MB at most).');
  return writeThemeAsset(id, await fs.readFile(sourcePath), path.extname(sourcePath), prefix);
};

/** Script errors a theme's scenes reported in the renderer (for the agent). */
export const recordSceneError = (id, message) => {
  if (!isThemeId(id) || typeof message !== 'string') return;
  const list = sceneErrors.get(id) ?? [];
  if (list.includes(message)) return;
  list.push(message.slice(0, 300));
  sceneErrors.set(id, list.slice(-SCENE_ERROR_LIMIT));
};

export const sceneErrorsFor = (id) => [...(sceneErrors.get(id) ?? [])];
