// Keeps a built-in browser tab's JavaScript dialogs (alert / confirm) out of
// native UI. Electron 42 has no public API to take over a page's dialogs: its
// own handler, an internal '-run-dialog' listener every WebContents gets in
// lib/browser/api/web-contents.ts, shows them with dialog.showMessageBox on
// the window that holds the tab. That sheet brings a hidden window on screen,
// takes key focus, and stays up after the page was answered through CDP
// (Page.handleJavaScriptDialog). `disableDialogs` is no substitute: it makes
// confirm() return false at once instead of blocking until answered.
//
// This is the one place that touches the private hook. It replaces Electron's
// listener on built-in browser tabs only, and only when it finds exactly that
// listener (one '-run-dialog' listener that calls showMessageBox). Otherwise
// it leaves the WebContents alone (`installed: false`) and the tab falls back
// to Electron's native dialog, still answerable from the panel or
// browser_dialog. scripts/test-builtin-browser.mjs fails if the hook is not
// installed or a native dialog shows, so an Electron upgrade that changes it
// is caught there. See docs/builtin-browser.md.
//
// The held callbacks are Chromium's dialog-closed callbacks: the page stays
// blocked until answer() runs one. Frames in different renderer processes
// (cross-site iframes) can each have a dialog open at once, so they wait in
// a FIFO queue: the head is the dialog shown (onOpen), answering it settles
// that frame only and shows the next. A main-frame navigation starting, a
// crash ('-cancel-dialogs') and closing the tab (cancelAll) settle every held
// dialog with false, so no renderer stays blocked. Chromium runs each callback at most once whichever
// path answers first (CDP or this), so a stale call is a no-op.
// prompt() never reaches this: Electron's renderer throws "prompt() is not
// supported" before asking the browser process.

export const RUN_DIALOG_EVENT = '-run-dialog';
export const CANCEL_DIALOGS_EVENT = '-cancel-dialogs';

const isElectronDialogHandler = (listener) => {
  try {
    return /showMessageBox/.test(Function.prototype.toString.call(listener));
  } catch {
    return false;
  }
};

// Whether `webContents` still has Electron's own dialog handler, i.e. the
// hook can be installed.
export const canRouteGuestDialogs = (webContents) => {
  if (!webContents || typeof webContents.listeners !== 'function' || webContents.isDestroyed?.()) return false;
  const listeners = webContents.listeners(RUN_DIALOG_EVENT);
  return listeners.length === 1 && isElectronDialogHandler(listeners[0]);
};

// onOpen({ type, message, defaultPrompt, url }) when a dialog becomes the one
// shown (the page opened it with none waiting, or the one before it was
// answered); onClose() when the last one is answered, onClose({ cancelled:
// true }) when they are all cancelled.
export const routeGuestDialogs = (webContents, { onOpen, onClose } = {}) => {
  if (!canRouteGuestDialogs(webContents)) {
    return { installed: false, answer: () => false, cancelAll: () => false, get pending() { return false; }, get count() { return 0; } };
  }
  const queue = [];
  const settle = (entry, accept, text) => {
    try {
      entry.callback(accept, text);
    } catch {}
  };
  const showHead = () => {
    if (queue.length > 0) onOpen?.({ ...queue[0].info });
    else onClose?.();
  };
  // Settles every held dialog (navigation, crash, closing the tab).
  const cancelAll = () => {
    if (queue.length === 0) return false;
    for (const entry of queue.splice(0)) settle(entry, false, '');
    onClose?.({ cancelled: true });
    return true;
  };
  webContents.removeAllListeners(RUN_DIALOG_EVENT);
  webContents.on(RUN_DIALOG_EVENT, (info, callback) => {
    let url = '';
    try {
      url = String(info?.frame?.url ?? '');
    } catch {}
    queue.push({
      callback,
      info: {
        type: String(info?.dialogType ?? 'alert'),
        message: String(info?.messageText ?? ''),
        defaultPrompt: String(info?.defaultPromptText ?? ''),
        url,
      },
    });
    if (queue.length === 1) showHead();
  });
  webContents.on(CANCEL_DIALOGS_EVENT, cancelAll);
  // Chromium cancels dialogs only when a navigation commits, and a navigation
  // of a page whose renderer waits on a dialog never commits (it fails), so
  // the URL field, back/forward or reload would hang on the open dialog. Like
  // Chrome's own dialog manager, settle them when a main-frame navigation
  // starts (renderer-initiated ones can't start while the page is blocked).
  webContents.on('did-start-navigation', (details) => {
    if (details?.isMainFrame && !details.isSameDocument) cancelAll();
  });
  return {
    installed: true,
    // Answers the dialog shown (the head) and shows the next one; false when
    // none is held.
    answer: (accept, promptText) => {
      const entry = queue.shift();
      if (!entry) return false;
      settle(entry, accept !== false, typeof promptText === 'string' ? promptText : '');
      showHead();
      return true;
    },
    cancelAll,
    get pending() {
      return queue.length > 0;
    },
    // Dialogs held, the one shown included.
    get count() {
      return queue.length;
    },
  };
};
