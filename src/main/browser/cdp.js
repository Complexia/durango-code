// Chrome DevTools Protocol access to one built-in browser tab through
// Electron's webContents.debugger. Attaches lazily, re-attaches after a
// detach (a crashed renderer, a DevTools window taking over), tracks
// JavaScript dialogs and main-frame navigations for the tab.

const DEFAULT_TIMEOUT_MS = 15_000;
const DOMAINS = ['Page.enable', 'DOM.enable', 'Accessibility.enable', 'Runtime.enable'];
const ATTACH_STEP_TIMEOUT_MS = 3_000;

const withTimeout = (promise, timeoutMs, label) => {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
};

export const createCdp = (webContents, { onDialog, onMainFrameNavigated } = {}) => {
  let attachPromise = null;
  let mainFrameId = null;
  const dbg = webContents.debugger;

  const handleMessage = (_event, method, params) => {
    if (method === 'Page.javascriptDialogOpening') {
      onDialog?.({
        type: params.type,
        message: String(params.message ?? ''),
        defaultPrompt: String(params.defaultPrompt ?? ''),
        url: String(params.url ?? ''),
      });
    } else if (method === 'Page.javascriptDialogClosed') {
      onDialog?.(null);
    } else if (method === 'Page.frameNavigated') {
      if (!params.frame?.parentId) {
        mainFrameId = params.frame?.id ?? mainFrameId;
        onMainFrameNavigated?.(params.frame?.url ?? '');
      }
    } else if (method === 'Page.navigatedWithinDocument') {
      // Same-document navigations (pushState) keep the DOM, so refs survive.
    }
  };

  const handleDetach = () => {
    attachPromise = null;
  };

  const attach = () => {
    if (attachPromise) return attachPromise;
    attachPromise = (async () => {
      if (webContents.isDestroyed()) throw new Error('The tab is closed.');
      if (!dbg.isAttached()) {
        try {
          dbg.attach('1.3');
        } catch (error) {
          throw new Error(`Could not attach to the tab (is DevTools open on it?): ${error?.message ?? error}`);
        }
        dbg.removeListener('message', handleMessage);
        dbg.removeListener('detach', handleDetach);
        dbg.on('message', handleMessage);
        dbg.on('detach', handleDetach);
      }
      // A tab that never navigated has no renderer yet and answers nothing;
      // never let enabling a domain hold every later command.
      let complete = true;
      for (const method of DOMAINS) {
        try {
          await withTimeout(dbg.sendCommand(method, {}), ATTACH_STEP_TIMEOUT_MS, method);
        } catch {
          complete = false;
        }
      }
      // Enable again on the next command once the page has a renderer.
      if (!complete) queueMicrotask(() => { attachPromise = null; });
      try {
        const tree = await withTimeout(dbg.sendCommand('Page.getFrameTree', {}), ATTACH_STEP_TIMEOUT_MS, 'Page.getFrameTree');
        mainFrameId = tree?.frameTree?.frame?.id ?? null;
      } catch {}
    })();
    attachPromise.catch(() => {
      attachPromise = null;
    });
    return attachPromise;
  };

  const send = async (method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    await attach();
    return withTimeout(dbg.sendCommand(method, params), timeoutMs, method);
  };

  const detach = () => {
    try {
      dbg.removeListener('message', handleMessage);
      dbg.removeListener('detach', handleDetach);
      if (dbg.isAttached()) dbg.detach();
    } catch {}
    attachPromise = null;
  };

  return { attach, send, detach, get mainFrameId() { return mainFrameId; } };
};
