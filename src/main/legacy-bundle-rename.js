// Installs that predate the Durango Code rebrand were updated in place, so the
// bundle on disk is still /Applications/Orion.app. macOS shows the bundle's
// file name in the Dock tooltip, Finder, Spotlight and Launchpad, so those
// users keep seeing "Orion". On launch, rename such a bundle to
// "Durango Code.app" and relaunch from the new path.
//
// Safe because the bundle name is not part of the code signature seal, TCC
// grants are keyed on the bundle id/designated requirement (not the path),
// Dock and Finder aliases follow renames, and userData/keychain identity is
// pinned separately (pin-app-identity.js). Updates install over whatever path
// the app runs from, so later updates land on the renamed bundle.
import fs from 'node:fs';
import path from 'node:path';

export const LEGACY_BUNDLE_NAME = 'Orion.app';
export const CURRENT_BUNDLE_NAME = 'Durango Code.app';

/** `/X/Foo.app/Contents/MacOS/bin` → `/X/Foo.app`, else null. */
export const bundlePathFromExe = (exePath) => {
  const macosDir = path.dirname(exePath);
  const contentsDir = path.dirname(macosDir);
  if (path.basename(macosDir) !== 'MacOS' || path.basename(contentsDir) !== 'Contents') return null;
  const bundle = path.dirname(contentsDir);
  return bundle.endsWith('.app') ? bundle : null;
};

/** Pure decision, exported for tests. */
export const planLegacyBundleRename = ({ platform, isPackaged, exePath, env = {}, exists, isWritableDir }) => {
  if (platform !== 'darwin') return { action: 'skip', reason: 'not-macos' };
  if (!isPackaged) return { action: 'skip', reason: 'not-packaged' };
  if (env.DURANGO_CODE_SKIP_BUNDLE_RENAME === '1') return { action: 'skip', reason: 'disabled' };
  const bundle = bundlePathFromExe(exePath);
  if (!bundle) return { action: 'skip', reason: 'no-bundle' };
  if (path.basename(bundle) !== LEGACY_BUNDLE_NAME) return { action: 'skip', reason: 'already-renamed' };
  // Running from a mounted DMG or a Gatekeeper translocation copy: renaming
  // would fail or rename the wrong thing.
  if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
    return { action: 'skip', reason: 'transient-location' };
  }
  const target = path.join(path.dirname(bundle), CURRENT_BUNDLE_NAME);
  // A separate Durango Code.app (e.g. installed from the new DMG next to the
  // old one) must never be overwritten.
  if (exists(target)) return { action: 'skip', reason: 'target-exists' };
  if (!isWritableDir(path.dirname(bundle))) return { action: 'skip', reason: 'not-writable' };
  return {
    action: 'rename',
    from: bundle,
    to: target,
    execPath: path.join(target, path.relative(bundle, exePath)),
  };
};

const isWritableDir = (dir) => {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Renames a legacy Orion.app bundle and schedules a relaunch from the new
 * path. Returns true when the app is exiting for the relaunch.
 */
export const renameLegacyBundleAndRelaunch = (app, { platform = process.platform, env = process.env } = {}) => {
  let plan;
  try {
    plan = planLegacyBundleRename({
      platform,
      isPackaged: app.isPackaged,
      exePath: app.getPath('exe'),
      env,
      exists: (target) => fs.existsSync(target),
      isWritableDir,
    });
  } catch (error) {
    console.warn('Could not plan the Durango Code bundle rename:', error);
    return false;
  }
  if (plan.action !== 'rename') return false;
  try {
    fs.renameSync(plan.from, plan.to);
  } catch (error) {
    console.warn(`Could not rename ${plan.from} to ${plan.to}; keeping the legacy bundle name:`, error);
    return false;
  }
  app.relaunch({ execPath: plan.execPath });
  app.exit(0);
  return true;
};
