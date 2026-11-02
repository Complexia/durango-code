// The built-in browser: tabs are WebContentsViews owned by the main process
// (they survive the panel closing and renderer reloads). The renderer's
// browser panel reports where its placeholder sits; the visible tab's view is
// laid over it, every other tab stays attached but hidden.
//
// Each tab has an owner (a thread, `thread:agent` for a Claude Task subagent,
// or `user`), a controller (`agent` or `user`), one action queue, and its
// snapshot ref state. Agent tools reach tabs through browser-tools.js.
import { WebContentsView } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCdp } from './cdp.js';
import { routeGuestDialogs } from './guest-dialogs.js';
import {
  HUMAN_INPUT_GRACE_MS,
  USER_OWNER,
  checkBrowserUrl,
  checkTabAccess,
  checkTabLimits,
  createRefState,
  invalidateRefs,
  normalizeBrowserUrl,
  ownerKeyFor,
  sameThreadFamily,
} from './policy.js';
import {
  attachGuestPolicy,
  browserGuestWebPreferences,
  browserScreenshotsDirectory,
  getBrowserSession,
  moveHeldDownload,
  releaseDownloadPath,
  setBrowserDownloadHandlers,
} from './security.js';
import { answerTabDialog, describeNavigation, navigationTimeout, settlePendingPress, waitForNavigation } from './actions.js';

const HIDDEN_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 };
const STATE_DEBOUNCE_MS = 40;
const SCREENSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// loadURL options for a popup Electron could not create itself: its form POST
// body and referrer (as Electron does for the windows it opens).
const loadOptionsFor = ({ postBody, referrer }) => {
  const options = {};
  if (referrer?.url) options.httpReferrer = referrer;
  if (postBody?.data?.length) {
    options.postData = postBody.data;
    const contentType = postBody.contentType || 'application/x-www-form-urlencoded';
    options.extraHeaders = `content-type: ${contentType}${postBody.boundary ? `; boundary=${postBody.boundary}` : ''}`;
  }
  return options;
};

export const createBrowserManager = ({ getWindow, emit }) => {
  const tabs = new Map(); // id -> tab
  const lastTabByOwner = new Map(); // ownerKey -> tab id
  let parents = new Map(); // thread -> parent thread (spawn_subagent children)
  let nextTabNumber = 1;
  let nextDialogId = 1;
  let nextDownloadNumber = 1;
  // Synced from the renderer's Browser use settings; asks until told otherwise.
  const downloadOptions = { askBeforeDownload: true };
  let visibleTabId = null;
  let panelBounds = null;
  let panelVisible = false;
  let stateTimer = null;

  // ---- State to the renderer --------------------------------------------------

  const tabState = (tab) => {
    const wc = tab.view.webContents;
    const destroyed = wc.isDestroyed();
    return {
      id: tab.id,
      threadId: tab.threadId,
      agentId: tab.agentId,
      ownerKey: tab.ownerKey,
      openedBy: tab.openedBy,
      controller: tab.controller,
      url: destroyed ? '' : wc.getURL(),
      title: destroyed ? '' : wc.getTitle(),
      loading: destroyed ? false : wc.isLoading(),
      canGoBack: destroyed ? false : wc.navigationHistory.canGoBack(),
      canGoForward: destroyed ? false : wc.navigationHistory.canGoForward(),
      dialog: tab.dialog,
      crashed: tab.crashed,
      agentBusy: tab.agentBusy > 0,
      lastAgentActionAt: tab.lastAgentActionAt,
      createdAt: tab.createdAt,
      blocked: tab.lastBlocked,
      pendingDownload: tab.pendingDownload
        ? { id: tab.pendingDownload.id, filename: tab.pendingDownload.filename, url: tab.pendingDownload.url, totalBytes: tab.pendingDownload.totalBytes }
        : null,
      lastDownload: tab.lastDownload,
    };
  };

  const state = () => ({ tabs: [...tabs.values()].map(tabState), visibleTabId });

  const flushState = () => {
    stateTimer = null;
    emit('browser:state', state());
  };
  const scheduleState = () => {
    if (!stateTimer) stateTimer = setTimeout(flushState, STATE_DEBOUNCE_MS);
  };
  const emitEvent = (event) => {
    if (stateTimer) {
      clearTimeout(stateTimer);
      stateTimer = null;
    }
    emit('browser:state', { ...state(), event });
  };

  // ---- Layout -------------------------------------------------------------------

  const attachToWindow = (tab) => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    if (tab.window === window) return;
    try {
      tab.window?.contentView?.removeChildView(tab.view);
    } catch {}
    window.contentView.addChildView(tab.view);
    tab.window = window;
    // Size first, then hide: a view hidden or sized before it joined a
    // window keeps a 0×0 viewport.
    tab.view.setBounds(tab.bounds);
    tab.view.setVisible(tab.visible);
  };

  const applyLayout = () => {
    for (const tab of tabs.values()) {
      attachToWindow(tab);
      const show = tab.id === visibleTabId && panelVisible && panelBounds;
      if (show) {
        tab.bounds = panelBounds;
        tab.view.setBounds(panelBounds);
        tab.shown = true;
        // Re-adding moves the view above any other child view.
        try {
          tab.window?.contentView.addChildView(tab.view);
        } catch {}
      }
      tab.visible = Boolean(show);
      tab.view.setVisible(tab.visible);
    }
  };

  // ---- Tabs ---------------------------------------------------------------------

  // Downloads of every browser tab come here, whoever configured the session
  // first (Clear browsing data may run before any tab exists).
  setBrowserDownloadHandlers({
    onDownloadStart: ({ item, webContents, savePath }) => {
      // Like Chrome asking where to save: the file downloads to a holding
      // path while the user decides in the panel, and moves into place on
      // Save (Settings → Browser use → Ask before downloading files).
      if (!downloadOptions.askBeforeDownload) return null;
      const owner = [...tabs.values()].find((candidate) => candidate.view.webContents === webContents);
      if (!owner) return null;
      if (owner.pendingDownload) {
        // One question at a time per tab: a second download while one waits is dropped.
        try {
          item.cancel();
        } catch {}
        return null;
      }
      const id = `d${nextDownloadNumber++}`;
      const holdPath = path.join(path.dirname(savePath), '.pending', `${id}-${path.basename(savePath)}`);
      owner.pendingDownload = {
        id,
        item,
        filename: path.basename(savePath),
        url: item.getURL(),
        totalBytes: item.getTotalBytes() || null,
        finalPath: savePath,
        holdPath,
        finished: null,
        accepted: false,
      };
      emitEvent({ type: 'download-requested', tabId: owner.id, threadId: owner.threadId, ownerKey: owner.ownerKey });
      return { holdPath };
    },
    onDownload: ({ item, webContents, savePath, state: downloadState }) => {
      const owner = [...tabs.values()].find((candidate) => candidate.view.webContents === webContents);
      const pending = owner?.pendingDownload?.item === item ? owner.pendingDownload : null;
      if (pending) {
        pending.finished = downloadState;
        if (pending.accepted || downloadState !== 'completed') void settleDownload(owner, pending);
        return;
      }
      if (owner) {
        owner.lastDownload = { path: savePath, state: downloadState };
        scheduleState();
      }
    },
  });

  const findTab = (id) => {
    const value = String(id ?? '').trim();
    return tabs.get(value) ?? tabs.get(`t${value}`) ?? null;
  };

  const markHumanInput = (tab) => {
    if (tab.agentBusy > 0) return; // our own synthetic input
    tab.humanInputUntil = Date.now() + HUMAN_INPUT_GRACE_MS;
  };

  // `adoptWebContents`: a popup's WebContents created by Electron for
  // window.open / target=_blank (it is already loading its URL).
  const createTab = ({ ownerKey, threadId = null, agentId = null, projectPath = null, openedBy, controller, fullAccess = false, adoptWebContents = null }) => {
    const limits = checkTabLimits(tabs.values(), ownerKey);
    if (!limits.ok) throw new Error(limits.reason);
    getBrowserSession();
    const view = new WebContentsView({
      webPreferences: browserGuestWebPreferences(),
      ...(adoptWebContents ? { webContents: adoptWebContents } : {}),
    });
    view.setBackgroundColor('#ffffff');
    const id = `t${nextTabNumber}`;
    nextTabNumber += 1;
    const tab = {
      id,
      view,
      window: null,
      ownerKey,
      threadId,
      agentId,
      projectPath,
      openedBy,
      controller,
      fullAccess,
      pendingDownload: null,
      refs: createRefState(),
      dialog: null,
      // A click's press whose mousedown opened a JavaScript dialog: the
      // release is still owed (settlePendingPress in actions.js).
      pendingPress: null,
      crashed: false,
      agentBusy: 0,
      humanInputUntil: 0,
      lastAgentActionAt: 0,
      lastUsedAt: Date.now(),
      createdAt: Date.now(),
      lastBlocked: null,
      lastDownload: null,
      viewport: null,
      shown: false,
      // Tabs never shown render at a desktop size.
      bounds: HIDDEN_BOUNDS,
      visible: false,
      queue: Promise.resolve(),
    };
    // Runs right before an agent action sends input to the page: refuses if
    // the user took over (or closed the tab) while the action was on its way.
    tab.markAgentInput = () => {
      if (!tabs.has(tab.id)) throw new Error(`Tab ${tab.id} was closed.`);
      if (tab.controller === 'user') throw new Error(`The user is controlling tab ${tab.id}; wait or ask them.`);
      tab.humanInputUntil = 0;
    };
    const wc = view.webContents;
    // `tab.dialog` is the dialog shown (the head of guest-dialogs.js's queue
    // when several frames wait); its id lets the panel answer that one only.
    const setDialog = (dialog) => {
      if (!dialog && !tab.dialog) return;
      tab.dialog = dialog ? { ...dialog, id: nextDialogId++ } : null;
      emitEvent({ type: dialog ? 'dialog-opened' : 'dialog-closed', tabId: tab.id, threadId: tab.threadId });
    };
    // A press held across a dialog is let go without a click once the page
    // moved on (navigation, crash, dialogs cancelled).
    const abandonPendingPress = () => {
      if (tab.pendingPress) tab.pendingPress.cancel = true;
    };
    // JavaScript dialogs never open native UI: the panel and browser_dialog
    // answer them (guest-dialogs.js). Where the hook is unavailable, CDP's
    // dialog events track Electron's native dialog instead.
    tab.guestDialogs = routeGuestDialogs(wc, {
      onOpen: setDialog,
      onClose: ({ cancelled } = {}) => {
        if (cancelled) abandonPendingPress();
        setDialog(null);
      },
    });
    tab.cdp = createCdp(wc, {
      onDialog: (dialog) => {
        if (!tab.guestDialogs.installed) setDialog(dialog);
      },
      onMainFrameNavigated: () => {
        abandonPendingPress();
        invalidateRefs(tab.refs, 'navigation');
      },
    });
    attachGuestPolicy(wc, {
      getProjectPath: () => tab.projectPath,
      getFullAccess: () => tab.fullAccess,
      onBlocked: (reason) => {
        tab.lastBlocked = reason;
        scheduleState();
      },
      onPopup: (details) => {
        const limits = checkTabLimits(tabs.values(), tab.ownerKey);
        if (!limits.ok) {
          tab.lastBlocked = limits.reason;
          scheduleState();
          return null;
        }
        return (options) => {
          const popup = createTab({
            ownerKey: tab.ownerKey,
            threadId: tab.threadId,
            agentId: tab.agentId,
            projectPath: tab.projectPath,
            openedBy: tab.openedBy,
            controller: tab.controller,
            fullAccess: tab.fullAccess,
            adoptWebContents: options?.webContents ?? null,
          });
          // Without a WebContents from Electron the popup has no opener; load it here.
          if (!options?.webContents) {
            void loadUrl(popup, details.url, { waitUntil: 'none', postBody: details.postBody, referrer: details.referrer }).catch(() => {});
          }
          emitEvent({ type: 'popup-opened', tabId: popup.id, threadId: popup.threadId, ownerKey: popup.ownerKey, openerTabId: tab.id });
          return popup.view.webContents;
        };
      },
    });
    for (const event of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page']) {
      wc.on(event, scheduleState);
    }
    wc.on('did-start-navigation', (details) => {
      if (details?.isMainFrame && !details.isSameDocument) tab.lastBlocked = null;
    });
    wc.on('before-input-event', () => markHumanInput(tab));
    wc.on('before-mouse-event', (_event, mouse) => {
      if (mouse?.type === 'mouseDown' || mouse?.type === 'mouseWheel') markHumanInput(tab);
    });
    wc.on('render-process-gone', () => {
      tab.crashed = true;
      tab.guestDialogs.cancelAll();
      tab.dialog = null;
      tab.pendingPress = null;
      invalidateRefs(tab.refs, 'navigation');
      scheduleState();
    });
    wc.on('did-finish-load', () => {
      if (tab.crashed) {
        tab.crashed = false;
        scheduleState();
      }
    });
    // window.close() from a popup (or anything else destroying the page) closes its tab.
    wc.once('destroyed', () => {
      if (tabs.get(tab.id) === tab) closeTab(tab);
    });
    // Give the tab a document (and renderer) right away, then attach CDP so a
    // dialog the page opens on load is tracked. An adopted popup is already loading.
    if (!adoptWebContents) wc.loadURL('about:blank').catch(() => {});
    void tab.cdp.attach().catch(() => {});
    tabs.set(id, tab);
    attachToWindow(tab);
    scheduleState();
    return tab;
  };

  const loadUrl = async (tab, rawUrl, { waitUntil = 'load', timeoutMs, postBody = null, referrer = null } = {}) => {
    const url = normalizeBrowserUrl(rawUrl);
    const verdict = checkBrowserUrl(url, { projectPath: tab.projectPath, topLevel: true, fullAccess: tab.fullAccess });
    if (!verdict.ok) throw new Error(verdict.reason);
    const wc = tab.view.webContents;
    const timeout = navigationTimeout(timeoutMs);
    const waiter = waitForNavigation(wc, { waitUntil, timeoutMs: timeout });
    // loadURL rejects for aborted/failed loads; the waiter reports those.
    wc.loadURL(url, loadOptionsFor({ postBody, referrer })).catch(() => {});
    const result = await waiter.promise;
    return describeNavigation(tab, result, timeout);
  };

  // Finishes a held download once both the transfer and the user's answer are
  // in. It moves without replacing anything: another download may have taken
  // the name meanwhile, in which case it gets the next free one.
  const settleDownload = async (tab, pending) => {
    if (tab.pendingDownload !== pending) return;
    tab.pendingDownload = null;
    if (pending.accepted && pending.finished === 'completed') {
      try {
        const savedPath = await moveHeldDownload(pending.holdPath, pending.finalPath);
        tab.lastDownload = { path: savedPath, state: 'completed' };
      } catch (error) {
        tab.lastDownload = { path: pending.finalPath, state: `failed (${error?.message ?? error})` };
      }
    } else {
      releaseDownloadPath(pending.finalPath);
      await fs.rm(pending.holdPath, { force: true }).catch(() => {});
      tab.lastDownload = { path: pending.finalPath, state: pending.accepted ? pending.finished : 'cancelled' };
    }
    scheduleState();
  };

  const dropPendingDownload = (tab) => {
    const pending = tab.pendingDownload;
    if (!pending) return;
    pending.accepted = false;
    if (!pending.finished) {
      try {
        pending.item.cancel();
      } catch {}
    }
    void settleDownload(tab, pending);
  };

  const closeTab = (tab) => {
    dropPendingDownload(tab);
    tabs.delete(tab.id);
    // Settle held dialogs so no renderer stays blocked on them.
    tab.guestDialogs.cancelAll();
    tab.pendingPress = null;
    for (const [owner, id] of lastTabByOwner) if (id === tab.id) lastTabByOwner.delete(owner);
    if (visibleTabId === tab.id) visibleTabId = null;
    try {
      tab.cdp.detach();
    } catch {}
    try {
      tab.window?.contentView?.removeChildView(tab.view);
    } catch {}
    try {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    } catch {}
    scheduleState();
  };

  // ---- Agent access -----------------------------------------------------------------

  const resolveTabForCaller = (tabArg, caller, { mutating }) => {
    if (tabArg !== undefined && tabArg !== null && String(tabArg).trim() !== '') {
      const tab = findTab(tabArg);
      if (!tab) throw new Error(`There is no tab ${tabArg}. browser_status lists the tabs you can use.`);
      const access = checkTabAccess(tab, caller, { mutating, parents });
      if (!access.ok) throw new Error(access.reason);
      return tab;
    }
    const key = ownerKeyFor(caller);
    const recentId = lastTabByOwner.get(key);
    const recent = recentId ? tabs.get(recentId) : null;
    const candidates = recent
      ? [recent]
      : [...tabs.values()]
          .filter((tab) => tab.ownerKey === key || (!mutating && tab.ownerKey !== USER_OWNER && sameThreadFamily(tab.threadId, caller.threadId, parents)))
          .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    const tab = candidates[0];
    if (!tab) throw new Error('You have no browser tab yet. Open one with browser_open.');
    const access = checkTabAccess(tab, caller, { mutating, parents });
    if (!access.ok) throw new Error(access.reason);
    return tab;
  };

  const touch = (tab, caller) => {
    tab.lastUsedAt = Date.now();
    if (tab.ownerKey === ownerKeyFor(caller)) lastTabByOwner.set(tab.ownerKey, tab.id);
  };

  // Runs `fn` on the tab's action queue. Mutating actions wait out a moment of
  // human input and refuse while a JavaScript dialog blocks the page. Access
  // is checked again after every wait, so Take over (or closing the tab)
  // while an action is queued or waiting stops it.
  const runOnTab = (tab, caller, fn, { mutating, allowDialog = false } = {}) => {
    const checkAccess = () => {
      if (!tabs.has(tab.id)) throw new Error(`Tab ${tab.id} was closed.`);
      if (!mutating) return;
      const access = checkTabAccess(tab, caller, { mutating, parents });
      if (!access.ok) throw new Error(access.reason);
    };
    const job = async () => {
      checkAccess();
      if (mutating) {
        const deadline = Date.now() + 2_000;
        while (Date.now() < tab.humanInputUntil && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          checkAccess();
        }
        // An agent tab follows the access mode of whoever drives it now.
        if (tab.openedBy !== 'user') tab.fullAccess = (caller.accessMode ?? 'full-access') === 'full-access';
      }
      if (tab.dialog && !allowDialog) {
        throw new Error(
          `A ${tab.dialog.type} dialog is open in tab ${tab.id}: ${JSON.stringify(tab.dialog.message)}. Answer it with browser_dialog {accept: true|false} first.`
        );
      }
      if (tab.crashed && mutating) {
        tab.crashed = false;
        tab.view.webContents.reload();
        throw new Error(`Tab ${tab.id} had crashed; it is reloading. Try again after browser_wait_for or browser_snapshot.`);
      }
      touch(tab, caller);
      if (mutating) {
        tab.agentBusy += 1;
        tab.lastAgentActionAt = Date.now();
        scheduleState();
        try {
          await tab.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
          checkAccess();
          // A press still held from a click whose mousedown opened a dialog
          // is let go before this action sends anything.
          await settlePendingPress(tab);
          return await fn(tab);
        } finally {
          tab.agentBusy -= 1;
          scheduleState();
        }
      }
      return fn(tab);
    };
    const result = tab.queue.then(job, job);
    tab.queue = result.catch(() => {});
    return result;
  };

  const openTabForAgent = async (caller, { url, waitUntil, timeoutMs } = {}) => {
    const tab = createTab({
      ownerKey: ownerKeyFor(caller),
      threadId: caller.threadId,
      agentId: caller.agentId ?? null,
      projectPath: caller.projectPath ?? null,
      openedBy: 'agent',
      controller: 'agent',
      fullAccess: (caller.accessMode ?? 'full-access') === 'full-access',
    });
    touch(tab, caller);
    emitEvent({ type: 'agent-opened', tabId: tab.id, threadId: tab.threadId });
    if (!url || normalizeBrowserUrl(url) === 'about:blank') {
      return { tab, text: `Opened tab ${tab.id} (blank).` };
    }
    try {
      const navigation = await runOnTab(tab, caller, () => loadUrl(tab, url, { waitUntil, timeoutMs }), { mutating: true });
      return { tab, text: `Opened tab ${tab.id}. ${navigation.text}`, ok: navigation.ok };
    } catch (error) {
      return { tab, text: `Opened tab ${tab.id}, but: ${error?.message ?? error}`, ok: false };
    }
  };

  const tabsVisibleTo = (caller) =>
    [...tabs.values()].filter(
      (tab) => tab.ownerKey === USER_OWNER || sameThreadFamily(tab.threadId, caller.threadId, parents)
    );

  // ---- Renderer (person) actions --------------------------------------------------------

  const userActions = {
    list: () => state(),
    create: async ({ url, projectPath, threadId } = {}) => {
      const tab = createTab({
        ownerKey: USER_OWNER,
        threadId: typeof threadId === 'string' ? threadId : null,
        projectPath: typeof projectPath === 'string' && projectPath ? projectPath : null,
        openedBy: 'user',
        controller: 'user',
        fullAccess: true,
      });
      visibleTabId = tab.id;
      applyLayout();
      if (url) {
        try {
          await loadUrl(tab, url, { waitUntil: 'none' });
        } catch (error) {
          tab.lastBlocked = error?.message ?? String(error);
        }
      }
      scheduleState();
      return { ok: true, tabId: tab.id };
    },
    navigate: async ({ tabId, url }) => {
      const tab = findTab(tabId);
      if (!tab) return { ok: false, error: 'No such tab.' };
      markHumanInput(tab);
      try {
        await loadUrl(tab, url, { waitUntil: 'none' });
        return { ok: true };
      } catch (error) {
        tab.lastBlocked = error?.message ?? String(error);
        scheduleState();
        return { ok: false, error: tab.lastBlocked };
      }
    },
    back: ({ tabId }) => {
      const tab = findTab(tabId);
      if (tab?.view.webContents.navigationHistory.canGoBack()) {
        markHumanInput(tab);
        tab.view.webContents.navigationHistory.goBack();
      }
      return { ok: Boolean(tab) };
    },
    forward: ({ tabId }) => {
      const tab = findTab(tabId);
      if (tab?.view.webContents.navigationHistory.canGoForward()) {
        markHumanInput(tab);
        tab.view.webContents.navigationHistory.goForward();
      }
      return { ok: Boolean(tab) };
    },
    reload: ({ tabId }) => {
      const tab = findTab(tabId);
      if (tab) {
        markHumanInput(tab);
        tab.view.webContents.reload();
      }
      return { ok: Boolean(tab) };
    },
    stop: ({ tabId }) => {
      const tab = findTab(tabId);
      tab?.view.webContents.stop();
      return { ok: Boolean(tab) };
    },
    close: ({ tabId }) => {
      const tab = findTab(tabId);
      if (tab) closeTab(tab);
      return { ok: Boolean(tab) };
    },
    select: ({ tabId }) => {
      const tab = tabId ? findTab(tabId) : null;
      visibleTabId = tab ? tab.id : null;
      applyLayout();
      scheduleState();
      return { ok: true };
    },
    setBounds: (bounds) => {
      const valid =
        bounds &&
        ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(Number(bounds[key]))) &&
        bounds.width > 0 &&
        bounds.height > 0;
      panelBounds = valid
        ? {
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.max(1, Math.round(bounds.width)),
            height: Math.max(1, Math.round(bounds.height)),
          }
        : null;
      applyLayout();
      return { ok: true };
    },
    // Small JPEG of a tab for the corner preview (the panel shows the live
    // view only when expanded). stayHidden: a hidden tab paints for it.
    thumbnail: async ({ tabId, width }) => {
      const tab = findTab(tabId);
      if (!tab || tab.crashed) return { ok: false };
      let image = await tab.view.webContents.capturePage(undefined, { stayHidden: true });
      if (image.isEmpty()) return { ok: false };
      const target = Math.max(120, Math.min(Math.round(Number(width) || 640), 960));
      if (image.getSize().width > target) image = image.resize({ width: target, quality: 'good' });
      return { ok: true, dataUrl: `data:image/jpeg;base64,${image.toJPEG(72).toString('base64')}` };
    },
    setVisible: (visible) => {
      panelVisible = visible === true;
      applyLayout();
      return { ok: true };
    },
    takeControl: ({ tabId }) => {
      const tab = findTab(tabId);
      if (!tab) return { ok: false };
      tab.controller = 'user';
      void tab.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      scheduleState();
      return { ok: true };
    },
    releaseControl: ({ tabId }) => {
      const tab = findTab(tabId);
      if (!tab || tab.ownerKey === USER_OWNER) return { ok: false };
      tab.controller = 'agent';
      scheduleState();
      return { ok: true };
    },
    // "Let agent use": a tab the person opened goes to the focused thread.
    adopt: ({ tabId, threadId, projectPath }) => {
      const tab = findTab(tabId);
      if (!tab || typeof threadId !== 'string' || !threadId) return { ok: false };
      const limits = checkTabLimits([...tabs.values()].filter((other) => other !== tab), threadId);
      if (!limits.ok) return { ok: false, error: limits.reason };
      tab.ownerKey = threadId;
      tab.threadId = threadId;
      tab.agentId = null;
      tab.controller = 'agent';
      if (typeof projectPath === 'string' && projectPath) tab.projectPath = projectPath;
      lastTabByOwner.set(threadId, tab.id);
      scheduleState();
      return { ok: true };
    },
    setOptions: ({ askBeforeDownload } = {}) => {
      if (typeof askBeforeDownload === 'boolean') downloadOptions.askBeforeDownload = askBeforeDownload;
      return { ok: true };
    },
    answerDownload: async ({ tabId, id, accept }) => {
      const tab = findTab(tabId);
      const pending = tab?.pendingDownload;
      if (!pending || (id && pending.id !== id)) return { ok: false };
      if (accept !== true) {
        dropPendingDownload(tab);
        return { ok: true };
      }
      pending.accepted = true;
      if (pending.finished) await settleDownload(tab, pending);
      else scheduleState();
      return { ok: true };
    },
    // `dialogId`: the dialog the panel showed; a different one (the one it
    // showed was answered meanwhile and the next took its place) is left open.
    answerDialog: async ({ tabId, dialogId, accept, promptText }) => {
      const tab = findTab(tabId);
      if (!tab?.dialog) return { ok: false };
      if (dialogId !== undefined && dialogId !== null && tab.dialog.id !== dialogId) return { ok: false };
      try {
        await answerTabDialog(tab, { accept, promptText });
        scheduleState();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },
    closeThreadTabs: ({ threadId }) => {
      for (const tab of [...tabs.values()]) if (tab.threadId === threadId && tab.ownerKey !== USER_OWNER) closeTab(tab);
      return { ok: true };
    },
    setThreadParents: (map) => {
      const next = new Map();
      if (map && typeof map === 'object') {
        for (const [child, parent] of Object.entries(map)) {
          if (typeof parent === 'string' && parent) next.set(child, parent);
        }
      }
      parents = next;
      return { ok: true };
    },
    clearData: async () => {
      const browserSession = getBrowserSession();
      await browserSession.clearStorageData();
      await browserSession.clearCache();
      try {
        await browserSession.clearAuthCache();
      } catch {}
      return { ok: true };
    },
  };

  // Old screenshots are only references in transcripts; keep a week.
  void (async () => {
    try {
      const directory = browserScreenshotsDirectory();
      const now = Date.now();
      for (const name of await fs.readdir(directory)) {
        const filePath = path.join(directory, name);
        const stat = await fs.stat(filePath).catch(() => null);
        if (stat && now - stat.mtimeMs > SCREENSHOT_RETENTION_MS) await fs.rm(filePath, { force: true });
      }
    } catch {}
  })();

  return {
    tabs,
    get parents() {
      return parents;
    },
    findTab,
    state,
    createTab,
    closeTab,
    loadUrl,
    resolveTabForCaller,
    runOnTab,
    openTabForAgent,
    tabsVisibleTo,
    touch,
    applyLayout,
    userActions,
    emitEvent,
    scheduleState,
    closeAll: () => {
      for (const tab of [...tabs.values()]) closeTab(tab);
    },
  };
};
