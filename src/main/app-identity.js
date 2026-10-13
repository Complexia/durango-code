import path from 'node:path';

// The product ships as "Durango Code" (package.json productName, the macOS
// bundle name, window titles, menus), but the app keeps its internal Orion
// identity so installed users keep their data and credentials:
//
// - Electron derives the default userData directory from the app name
//   (`~/Library/Application Support/<name>`), and on macOS it names the
//   safeStorage keychain item "<name> Safe Storage" (account "<name>") from
//   the app name it sees when the browser process sets up its message loop,
//   which happens after the main script's top-level code runs but before
//   `ready`. Every encrypted account session, MCP credential and remote
//   control secret on disk was encrypted with the key in "Orion Safe Storage".
// - productName "Durango Code" would silently move both, so the main process
//   pins the internal name and the legacy userData path before anything reads
//   a path or touches safeStorage. See docs/durango-rebrand.md.
//
// This module must stay free of the `electron` import so plain-node tests can
// exercise the path logic; `pin-app-identity.js` applies it to the real app.

export const INTERNAL_APP_NAME = 'Orion';
export const PRODUCT_DISPLAY_NAME = 'Durango Code';
export const APP_BUNDLE_ID = 'com.complexia.orion';
export const DEV_USER_DATA_SUFFIX = ' (dev)';

export const legacyUserDataPath = (appDataPath, internalName = INTERNAL_APP_NAME) =>
  path.join(appDataPath, internalName);

export const devUserDataPath = (liveUserDataPath) => `${liveUserDataPath}${DEV_USER_DATA_SUFFIX}`;

// Keychain service Electron uses on macOS for safeStorage, for diagnostics
// and the identity probe test.
export const safeStorageKeychainService = (internalName = INTERNAL_APP_NAME) =>
  `${internalName} Safe Storage`;

// Pin the internal identity on an Electron `app`. Must run before `ready` and
// before any module calls `app.getPath('userData')` or uses safeStorage.
export const pinInternalAppIdentity = (electronApp, { internalName = INTERNAL_APP_NAME } = {}) => {
  electronApp.setName(internalName);
  // Set unconditionally: reading the default userData first could make
  // Electron create an empty "<productName>" directory.
  electronApp.setPath('userData', legacyUserDataPath(electronApp.getPath('appData'), internalName));
  return { name: electronApp.getName(), userDataPath: electronApp.getPath('userData') };
};
