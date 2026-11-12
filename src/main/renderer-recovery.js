// The main window's renderer can die while the app keeps running: a crash, an
// out-of-memory kill, or a stray signal (an agent's over-broad `pkill -f` once
// SIGTERMed it). Electron then leaves the window blank until a restart. Reload
// it instead: the renderer rebuilds itself from the persisted store, the same
// as a manual reload. A renderer that keeps dying right after load is left
// alone after a few tries so it can't spin.

export const RENDERER_RELOAD_LIMIT = 3;
export const RENDERER_RELOAD_WINDOW_MS = 60_000;

/**
 * Reloads `window` whenever its renderer goes away unexpectedly.
 * Returns a function that removes the listener.
 */
export function reloadWhenRendererGone(
  window,
  {
    reload = () => window.webContents.reload(),
    isShuttingDown = () => false,
    now = Date.now,
    log = console,
    limit = RENDERER_RELOAD_LIMIT,
    windowMs = RENDERER_RELOAD_WINDOW_MS,
  } = {}
) {
  const reloads = [];
  const onGone = (_event, details) => {
    const reason = details?.reason ?? 'unknown';
    // 'clean-exit' is a renderer closing normally (window teardown).
    if (reason === 'clean-exit' || isShuttingDown() || window.isDestroyed()) return;
    const at = now();
    while (reloads.length > 0 && at - reloads[0] > windowMs) reloads.shift();
    if (reloads.length >= limit) {
      log.error(
        `Main window renderer gone (${reason}, exit code ${details?.exitCode}); ` +
          `already reloaded ${reloads.length} times in ${Math.round(windowMs / 1000)}s, not reloading again`
      );
      return;
    }
    reloads.push(at);
    log.error(`Main window renderer gone (${reason}, exit code ${details?.exitCode}); reloading`);
    reload();
  };
  window.webContents.on('render-process-gone', onGone);
  return () => {
    if (!window.isDestroyed()) window.webContents.removeListener('render-process-gone', onGone);
  };
}
