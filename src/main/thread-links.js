// orion://thread/<id>: opens a Durango Code thread here. Durango's web links
// to it from a bot reply (a thread a bot names, its Open thread button), so
// the person lands in the thread in the app. Only the id travels; the
// renderer opens the thread if this computer has it and says so otherwise.

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The thread id of an `orion://thread/<id>` link (exactly that shape), else null. */
export const threadOpenLinkId = (rawUrl, protocol) => {
  const match = new RegExp(`^${escapeRegExp(protocol)}://thread/([A-Za-z0-9][A-Za-z0-9_-]{0,127})/?$`).exec(String(rawUrl ?? '').trim());
  return match ? match[1] : null;
};

/**
 * Hands thread links to the renderer: sent at once when a window is up, and
 * kept until the renderer asks (take) when it isn't loaded yet (a link that
 * launched the app).
 */
export const createThreadOpenLinks = ({ protocol, getWindow }) => {
  let pending = null;
  return {
    /** Handles the URL when it is a thread link; false otherwise. */
    handle(rawUrl) {
      const id = threadOpenLinkId(rawUrl, protocol);
      if (!id) return false;
      pending = id;
      const window = getWindow();
      if (window && !window.isDestroyed()) {
        window.webContents.send('threads:openRequest', id);
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }
      return true;
    },
    /** The link waiting for the renderer, once. */
    take() {
      const id = pending;
      pending = null;
      return id;
    },
  };
};
