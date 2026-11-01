// Pure rules of the built-in browser (no Electron imports, so unit tests can
// load them under plain Node): which URLs a tab may open, and who may drive
// which tab.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BROWSER_PARTITION = 'persist:durango-browser';
export const MAX_TABS_PER_OWNER = 6;
export const MAX_TABS_TOTAL = 20;
export const USER_OWNER = 'user';
// Real input from the person in a guest page counts as them driving it for
// this long, so an agent action does not land in the middle of their typing.
export const HUMAN_INPUT_GRACE_MS = 750;

const isInside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// Turns what someone typed in the URL bar (or an agent passed) into a URL:
// bare hosts get https://, localhost and IPs get http://.
export const normalizeBrowserUrl = (raw) => {
  const value = String(raw ?? '').trim();
  if (!value) return 'about:blank';
  // A scheme, unless what follows the colon is a port (localhost:3000).
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(value)) return value;
  if (value.startsWith('/')) return `file://${value}`;
  const local = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(value);
  return `${local ? 'http' : 'https'}://${value}`;
};

/**
 * Whether a tab may navigate to `url`.
 * - http(s) and about:blank always;
 * - file: only inside the owning thread's project directory;
 * - data: only for subframes (top-level data: URLs are a phishing vector);
 * - blob: only for subframes;
 * - everything else (javascript:, chrome:, devtools:, custom app schemes) never.
 * Returns { ok: true } or { ok: false, reason }.
 */
// `fullAccess`: the tab is driven in Full access (or by the user), where the
// agent can already read any file and run page JavaScript, so file: anywhere,
// top-level data: and javascript: are allowed too.
export const checkBrowserUrl = (url, { projectPath = null, topLevel = true, fullAccess = false } = {}) => {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, reason: `"${url}" is not a valid URL.` };
  }
  const scheme = parsed.protocol;
  if (scheme === 'http:' || scheme === 'https:') return { ok: true };
  if (scheme === 'about:') {
    return parsed.href === 'about:blank' || parsed.href === 'about:srcdoc'
      ? { ok: true }
      : { ok: false, reason: `${parsed.href} is not available in the built-in browser.` };
  }
  if (fullAccess && (scheme === 'data:' || scheme === 'blob:' || scheme === 'javascript:')) return { ok: true };
  if (scheme === 'file:') {
    if (fullAccess) {
      try {
        fileURLToPath(parsed);
        return { ok: true };
      } catch {
        return { ok: false, reason: `"${url}" is not a valid file URL.` };
      }
    }
    if (!projectPath) {
      return { ok: false, reason: 'file: URLs are only allowed inside the thread\'s project directory, and this tab has none.' };
    }
    let filePath;
    try {
      filePath = fileURLToPath(parsed);
    } catch {
      return { ok: false, reason: `"${url}" is not a valid file URL.` };
    }
    return isInside(path.resolve(filePath), path.resolve(projectPath))
      ? { ok: true }
      : { ok: false, reason: `file: URLs are only allowed inside the project directory (${projectPath}).` };
  }
  if (!topLevel && (scheme === 'data:' || scheme === 'blob:')) return { ok: true };
  if (scheme === 'data:') return { ok: false, reason: 'Top-level data: URLs are blocked in the built-in browser.' };
  return { ok: false, reason: `${scheme} URLs are blocked in the built-in browser.` };
};

// Permission requests a guest page may get without asking: writing (sanitized)
// text to the clipboard and going fullscreen inside its own view.
export const ALLOWED_BROWSER_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
export const isBrowserPermissionAllowed = (permission) => ALLOWED_BROWSER_PERMISSIONS.has(permission);

// ---- Ownership -------------------------------------------------------------

/** Owner key of a caller: its thread, or `thread:agent` for a Claude Task subagent. */
export const ownerKeyFor = ({ threadId, agentId } = {}) =>
  agentId ? `${threadId}:${agentId}` : String(threadId ?? '');

/** Root of a thread's subagent chain, following `parents` (child -> parent). */
export const threadRoot = (threadId, parents) => {
  let current = threadId;
  const seen = new Set();
  while (parents.has(current) && !seen.has(current)) {
    seen.add(current);
    current = parents.get(current);
  }
  return current;
};

/** Threads in the same family (a driver thread and its spawned subagent threads). */
export const sameThreadFamily = (a, b, parents) =>
  Boolean(a) && Boolean(b) && (a === b || threadRoot(a, parents) === threadRoot(b, parents));

/**
 * Whether `caller` may use `tab`. `mutating` covers every action that changes
 * the page or the tab; reads are status and snapshots.
 * Returns { ok: true } or { ok: false, reason }.
 */
export const checkTabAccess = (tab, caller, { mutating, parents = new Map(), now = Date.now() } = {}) => {
  if (tab.ownerKey === USER_OWNER) {
    return {
      ok: false,
      reason: `Tab ${tab.id} belongs to the user. Ask them to click "Let agent use" in the browser panel, or open your own tab with browser_open.`,
    };
  }
  if (!mutating) {
    return sameThreadFamily(tab.threadId, caller.threadId, parents)
      ? { ok: true }
      : { ok: false, reason: `Tab ${tab.id} belongs to another Durango Code thread.` };
  }
  if (tab.ownerKey !== ownerKeyFor(caller)) {
    return {
      ok: false,
      reason: sameThreadFamily(tab.threadId, caller.threadId, parents)
        ? `Tab ${tab.id} is driven by another agent of this thread. Open your own tab with browser_open {new_tab: true}.`
        : `Tab ${tab.id} belongs to another Durango Code thread.`,
    };
  }
  if (tab.controller === 'user') {
    return { ok: false, reason: `The user is controlling tab ${tab.id}; wait or ask them.` };
  }
  return { ok: true };
};

/** Whether a new tab may be opened for `ownerKey` given the open tabs. */
export const checkTabLimits = (tabs, ownerKey) => {
  const list = [...tabs];
  if (list.length >= MAX_TABS_TOTAL) {
    return { ok: false, reason: `The built-in browser already has ${MAX_TABS_TOTAL} tabs open. Close one with browser_close first.` };
  }
  if (ownerKey !== USER_OWNER && list.filter((tab) => tab.ownerKey === ownerKey).length >= MAX_TABS_PER_OWNER) {
    return { ok: false, reason: `You already have ${MAX_TABS_PER_OWNER} tabs open. Reuse one or close one with browser_close.` };
  }
  return { ok: true };
};

// ---- Refs ------------------------------------------------------------------
// Snapshot refs (e1, e2, …) keep counting up across snapshots of a tab, so a
// ref from an older snapshot never silently resolves to a different element.

export const createRefState = () => ({ generation: 0, next: 1, first: 1, map: new Map(), invalidated: null });

/** Starts a new snapshot generation; returns an allocator for its refs. */
export const beginRefGeneration = (refs) => {
  refs.generation += 1;
  refs.first = refs.next;
  refs.map = new Map();
  refs.invalidated = null;
  return (backendNodeId) => {
    const ref = `e${refs.next}`;
    refs.next += 1;
    refs.map.set(ref, backendNodeId);
    return ref;
  };
};

export const invalidateRefs = (refs, reason) => {
  refs.map = new Map();
  refs.first = refs.next;
  refs.invalidated = reason;
};

/** Resolves a ref to its backendDOMNodeId or explains why it can't. */
export const resolveRef = (refs, ref) => {
  const value = String(ref ?? '').trim().replace(/^\[?ref=/, '').replace(/\]$/, '');
  const match = /^e(\d+)$/.exec(value);
  if (!match) return { ok: false, reason: `"${ref}" is not a snapshot ref (refs look like e12).` };
  if (refs.map.has(value)) return { ok: true, backendNodeId: refs.map.get(value) };
  const number = Number(match[1]);
  if (refs.generation === 0) return { ok: false, reason: 'Take a browser_snapshot first; refs come from the latest snapshot.' };
  if (number < refs.first || refs.invalidated) {
    return {
      ok: false,
      reason: `Ref ${value} is stale: ${refs.invalidated === 'navigation' ? 'the page navigated since that snapshot' : 'it came from an older snapshot'}. Take a new browser_snapshot and use its refs.`,
    };
  }
  return { ok: false, reason: `Ref ${value} is not in the latest snapshot. Take a new browser_snapshot.` };
};
