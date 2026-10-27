import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getStorageFilePath } from './paths.js';

// "What's new" after an update: the release notes scripts/deploy.mjs baked
// into this build, and whether this version's notice has been dismissed yet.
// whats-new.json remembers the last version whose notice was dismissed; the
// notice shows once for each version a user updates to.

const whatsNewFileName = 'whats-new.json';
const getWhatsNewFilePath = () => path.join(app.getPath('userData'), whatsNewFileName);

// vite.main.config.mjs defines __DURANGO_RELEASE_NOTES__; the raw-source test
// scripts load this file without it.
export const getBundledReleaseNotes = () => {
  try {
    const notes = JSON.parse(typeof __DURANGO_RELEASE_NOTES__ === 'string' ? __DURANGO_RELEASE_NOTES__ : '[]');
    return Array.isArray(notes) ? notes.filter((note) => typeof note === 'string' && note.trim()) : [];
  } catch {
    return [];
  }
};

const readSeenVersion = async () => {
  try {
    const parsed = JSON.parse(await fs.readFile(getWhatsNewFilePath(), 'utf8'));
    return typeof parsed?.seenVersion === 'string' ? parsed.seenVersion : null;
  } catch {
    return null;
  }
};

export const markWhatsNewSeen = async (version = app.getVersion()) => {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(getWhatsNewFilePath(), `${JSON.stringify({ seenVersion: version })}\n`);
};

const fileExists = (filePath) => fs.access(filePath).then(() => true, () => false);

export const getWhatsNew = async () => {
  const version = app.getVersion();
  const notes = getBundledReleaseNotes();
  let seenVersion = await readSeenVersion();
  if (seenVersion === null) {
    // No record yet. With saved app state this is the first launch after
    // updating from a version that kept none, so the notice is due; without
    // it this is a fresh install, which has nothing to announce.
    if (!(await fileExists(getStorageFilePath()))) {
      await markWhatsNewSeen(version).catch(() => {});
      seenVersion = version;
    }
  }
  // Development builds have no release to announce unless notes were passed
  // in through DURANGO_RELEASE_NOTES.
  const unseen = seenVersion !== version && (app.isPackaged || notes.length > 0);
  return { version, notes, unseen };
};
