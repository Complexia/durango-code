import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { app } from 'electron';

// Point the updater at a port nothing listens on so every check fails fast
// with a real network error, the same shape as launching before the network
// is up. (Chromium rejects well-known low ports as unsafe, so find a free
// high port and release it.)
const closedPort = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
process.env.ORION_UPDATE_FEED_URL = `http://127.0.0.1:${closedPort}/`;
app.setPath('userData', await mkdtemp(path.join(os.tmpdir(), 'orion-app-updater-test-')));

// Electron emits 'ready' only after the ESM entry has finished evaluating, so
// awaiting whenReady() at top level would deadlock. Run everything from the
// ready callback instead.
const main = async () => {
  // electron-updater and runAppUpdateCheck both bail out for unpackaged apps.
  Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
  assert.equal(app.isPackaged, true, 'the test needs the app to look packaged');

  const updater = await import('../src/main/app-updater.js');

  try {
    // --- Automatic (background) checks never surface "Update failed". ---
    const background = await updater.checkForAppUpdate({ background: true });
    assert.equal(background.status, 'idle', 'a failed background check should leave the update button hidden');
    assert.match(background.error ?? '', /ECONNREFUSED|ERR_CONNECTION_REFUSED/i, 'the failure reason should be kept on the state for diagnostics');
    assert.ok(updater.appUpdateRetryTimer, 'a failed background check should schedule a retry');
    assert.equal(updater.appUpdateRetryAttempt, 1, 'the first retry should be the first backoff step');
    assert.equal(updater.activeAppUpdateCheck, null, 'the in-flight marker should be cleared after the check settles');

    // A second failure keeps the same pending timer and advances the backoff.
    await updater.checkForAppUpdate({ force: true, background: true });
    assert.equal(updater.appUpdateState.status, 'idle');
    assert.equal(updater.appUpdateRetryAttempt, 1, 'a pending retry should not be rescheduled by another failure');

    // --- A known available update is kept on screen through a failed re-check. ---
    updater.publishAppUpdateState({ status: 'available', availableVersion: '9.9.9', error: null, progress: null });
    await updater.checkForAppUpdate({ force: true, background: true });
    assert.equal(updater.appUpdateState.status, 'available', 'a failed background re-check should restore the offered update');
    assert.equal(updater.appUpdateState.availableVersion, '9.9.9');

    // --- A background check racing a download must not clobber it. ---
    updater.publishAppUpdateState({ status: 'downloading', availableVersion: '9.9.9', error: null, progress: { percent: 5, transferred: 1, total: 20, bytesPerSecond: 1 } });
    await updater.checkForAppUpdate({ force: true, background: true });
    assert.equal(updater.appUpdateState.status, 'downloading', 'a failed background check should not replace an in-flight download');
    updater.publishAppUpdateState({ status: 'idle', availableVersion: null, error: null, progress: null });

    // --- User-initiated checks still report the failure. ---
    await assert.rejects(updater.checkForAppUpdate({ force: true }), 'a user-initiated check should reject on failure');
    assert.equal(updater.appUpdateState.status, 'error', 'a user-initiated check failure should be visible');
    assert.ok(updater.appUpdateState.error, 'the visible failure should carry the reason');

    // --- A user joining an in-flight background check sees its outcome. ---
    updater.publishAppUpdateState({ status: 'idle', availableVersion: null, error: null, progress: null });
    const joinedBackground = updater.checkForAppUpdate({ force: true, background: true });
    const joinedUser = updater.checkForAppUpdate({ force: true });
    assert.equal(joinedUser, joinedBackground, 'concurrent checks should share one request');
    await assert.rejects(joinedUser);
    assert.equal(updater.appUpdateState.status, 'error', 'a shared check a user joined should surface the failure');

    // --- The scheduled check path is silent. ---
    updater.publishAppUpdateState({ status: 'idle', availableVersion: null, error: null, progress: null });
    updater.clearAppUpdateRetry();
    updater.runScheduledAppUpdateCheck();
    await updater.appUpdateCheckPromise;
    assert.equal(updater.appUpdateState.status, 'idle', 'the scheduled check should stay silent when it fails');
    assert.ok(updater.appUpdateRetryTimer, 'the scheduled check should fall back to the retry schedule');

    // --- Release notes from the feed become one line per change. ---
    assert.deepEqual(updater.normalizeReleaseNotes('- Icon-only update button\n- Show "What\'s new"\n'), [
      'Icon-only update button',
      'Show "What\'s new"',
    ]);
    assert.deepEqual(updater.normalizeReleaseNotes('<ul><li>One</li><li>Two</li></ul>'), ['One', 'Two']);
    assert.deepEqual(updater.normalizeReleaseNotes([{ version: '9.9.9', note: '* Three' }]), ['Three']);
    assert.equal(updater.normalizeReleaseNotes(null), null);
    assert.equal(updater.normalizeReleaseNotes('  \n'), null);

    // --- "What's new" shows once per version updated to, never on a fresh install. ---
    const fs = await import('node:fs/promises');
    const { getStorageFilePath } = await import('../src/main/paths.js');
    const whatsNew = await import('../src/main/whats-new.js');
    const whatsNewFile = path.join(app.getPath('userData'), 'whats-new.json');
    assert.equal((await whatsNew.getWhatsNew()).unseen, false, 'a fresh install has nothing to announce');
    assert.equal(JSON.parse(await fs.readFile(whatsNewFile, 'utf8')).seenVersion, app.getVersion());
    await fs.rm(whatsNewFile);
    await fs.writeFile(getStorageFilePath(), '{}');
    assert.equal((await whatsNew.getWhatsNew()).unseen, true, 'updating from a version without the record announces');
    await fs.writeFile(whatsNewFile, JSON.stringify({ seenVersion: '0.0.1' }));
    const due = await whatsNew.getWhatsNew();
    assert.equal(due.unseen, true, 'a newer version than the one last announced is due');
    assert.equal(due.version, app.getVersion());
    assert.deepEqual(due.notes, [], 'raw source has no bundled notes');
    await whatsNew.markWhatsNewSeen();
    assert.equal((await whatsNew.getWhatsNew()).unseen, false, 'dismissing hides it until the next version');

    console.log('App updater regression tests passed.');
    process.exitCode = 0;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    updater.clearAppUpdateRetry();
    app.exit(process.exitCode ?? 1);
  }
};

void app.whenReady().then(main, (error) => {
  console.error(error);
  app.exit(1);
});
