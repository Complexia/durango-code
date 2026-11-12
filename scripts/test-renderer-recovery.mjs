import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { reloadWhenRendererGone } from '../src/main/renderer-recovery.js';

const fakeWindow = () => {
  const webContents = new EventEmitter();
  return { webContents, destroyed: false, isDestroyed() { return this.destroyed; } };
};
const quietLog = { error: () => {} };
const gone = (window, reason) => window.webContents.emit('render-process-gone', {}, { reason, exitCode: 15 });

// A killed renderer (SIGTERM from a stray pkill) reloads the window.
{
  const window = fakeWindow();
  let reloads = 0;
  reloadWhenRendererGone(window, { reload: () => reloads++, log: quietLog });
  gone(window, 'killed');
  gone(window, 'crashed');
  gone(window, 'oom');
  assert.equal(reloads, 3);
}

// A normal renderer exit, app shutdown, or a destroyed window: no reload.
{
  const window = fakeWindow();
  let reloads = 0;
  let shuttingDown = false;
  reloadWhenRendererGone(window, { reload: () => reloads++, isShuttingDown: () => shuttingDown, log: quietLog });
  gone(window, 'clean-exit');
  shuttingDown = true;
  gone(window, 'killed');
  shuttingDown = false;
  window.destroyed = true;
  gone(window, 'killed');
  assert.equal(reloads, 0);
}

// A renderer that keeps dying stops being reloaded after the limit, and is
// reloaded again once the earlier deaths fall out of the window.
{
  const window = fakeWindow();
  let reloads = 0;
  let clock = 0;
  reloadWhenRendererGone(window, { reload: () => reloads++, now: () => clock, log: quietLog, limit: 3, windowMs: 60_000 });
  for (let i = 0; i < 5; i++) {
    gone(window, 'crashed');
    clock += 1_000;
  }
  assert.equal(reloads, 3);
  clock += 60_000;
  gone(window, 'crashed');
  assert.equal(reloads, 4);
}

// The returned function stops watching.
{
  const window = fakeWindow();
  let reloads = 0;
  const stop = reloadWhenRendererGone(window, { reload: () => reloads++, log: quietLog });
  stop();
  gone(window, 'killed');
  assert.equal(reloads, 0);
}

console.log('renderer recovery tests passed');
