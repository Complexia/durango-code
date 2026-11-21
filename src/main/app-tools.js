// Agents using Durango Code itself: read what is on screen in the app window and
// click, type, press keys and scroll there, the way the user would. Clicks and
// keys go in as real input (the DevTools protocol's Input domain), so they reach
// everything the user can reach, including theme controls and their sandboxed
// HTML widgets (see withInput). Claude runs serve these from the in-process SDK server
// (claude-driver.js); other providers get them from the bridge's `__tools`
// (mcp-bridge.js). Approval: app_snapshot only reads, so every mode approves it;
// the others act as the user, so Full access approves them, Workspace write asks
// for each, and Read only refuses them (thread-reader-routing.js).
import { captureWindow } from './theme-tools.js';

export const APP_READ_TOOL_NAMES = Object.freeze(['app_snapshot']);
export const APP_TOOL_NAMES = Object.freeze(['app_snapshot', 'app_click', 'app_type', 'app_press', 'app_scroll']);

const SETTLE_MS = 250;
const SNAPSHOT_LIMIT = 300;
const INPUT_TIMEOUT_MS = 5000;

const SCREENSHOT_PROPERTY = {
  type: 'boolean',
  description: 'Also return a picture of the window (after the action, for the action tools).',
};
const REF_PROPERTY = { type: 'string', description: 'An element ref from the latest app_snapshot, e.g. "e12".' };
const X_PROPERTY = { type: 'number', description: 'Window x in CSS pixels (instead of ref).' };
const Y_PROPERTY = { type: 'number', description: 'Window y in CSS pixels (instead of ref).' };

export const APP_TOOL_DESCRIPTIONS = Object.freeze({
  app_snapshot: `See what is on screen in Durango Code itself (the app the user is talking to you in): every visible button, link, field, tab, menu item, switch and theme control in the window, grouped by area (title bar, sidebar, thread, prompt box, settings, dialogs), each with a ref (e12), its role, name, state (pressed, checked, selected, expanded, disabled, focused) and box [x,y width x height]. Use it before app_click, app_type, app_press or app_scroll, and again after the app changes: refs from an older snapshot stop working. Use it when the user asks you to do something in Durango Code itself (open settings, switch a setting, press a theme's button, open a thread, start a new thread…), not for their project or websites (the browser tools are for those). filter narrows the list to entries whose role, name or area contains the text. screenshot: true adds a picture.`,
  app_click: `Click in Durango Code's own window as the user would (real mouse input, so it works on theme controls and their HTML widgets too): ref from app_snapshot (scrolled into view first) or x/y in window CSS pixels. double: true double-clicks; button: "right" opens context menus. It does what the user's click would do, so it can change settings, approve or deny prompts, send, stop or delete things: only click what the user asked for or clearly wants. The window does not need to be focused, and it is not brought to the front. Take a new app_snapshot afterwards to see the result.`,
  app_type: `Type text into Durango Code's own window: ref (a field from app_snapshot, clicked first to focus it) or the element that has focus now. clear: true empties the field first; submit: true presses Enter afterwards. Typing into the prompt box and submitting sends a message, like the user would.`,
  app_press: `Press a key or shortcut in Durango Code's own window, sent to whatever has focus there: "Enter", "Escape", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space", a letter or digit, or F1-F12, with modifiers such as "Meta+K", "Control+Shift+P" or "CmdOrCtrl+," (Command on macOS, Control elsewhere).`,
  app_scroll: `Scroll in Durango Code's own window: over a ref from app_snapshot or at x/y (default the middle of the window), by dy pixels down (negative scrolls up) and dx right.`,
});

export const APP_TOOL_INPUT_SCHEMAS = Object.freeze({
  app_snapshot: {
    type: 'object',
    properties: {
      filter: { type: 'string', description: 'Only list entries whose role, name or area contains this text (case-insensitive).' },
      screenshot: SCREENSHOT_PROPERTY,
    },
    additionalProperties: false,
  },
  app_click: {
    type: 'object',
    properties: {
      ref: REF_PROPERTY,
      x: X_PROPERTY,
      y: Y_PROPERTY,
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
      double: { type: 'boolean', description: 'Double-click.' },
      screenshot: SCREENSHOT_PROPERTY,
    },
    additionalProperties: false,
  },
  app_type: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The text to type.' },
      ref: { type: 'string', description: 'The field to type into (a ref from app_snapshot); leave it out to type where focus is.' },
      clear: { type: 'boolean', description: 'Empty the field first.' },
      submit: { type: 'boolean', description: 'Press Enter afterwards.' },
      screenshot: SCREENSHOT_PROPERTY,
    },
    required: ['text'],
    additionalProperties: false,
  },
  app_press: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'A key, optionally with modifiers: "Escape", "Meta+K", "CmdOrCtrl+,".' },
      screenshot: SCREENSHOT_PROPERTY,
    },
    required: ['key'],
    additionalProperties: false,
  },
  app_scroll: {
    type: 'object',
    properties: {
      ref: REF_PROPERTY,
      x: X_PROPERTY,
      y: Y_PROPERTY,
      dy: { type: 'number', description: 'Pixels to scroll down (negative: up). Default 400.' },
      dx: { type: 'number', description: 'Pixels to scroll right (negative: left).' },
      screenshot: SCREENSHOT_PROPERTY,
    },
    additionalProperties: false,
  },
});

export const appToolsForAccessMode = (accessMode) => (accessMode === 'read-only' ? APP_READ_TOOL_NAMES : APP_TOOL_NAMES);

export const appMcpToolDefinitions = (accessMode) =>
  appToolsForAccessMode(accessMode).map((name) => ({
    name,
    description: APP_TOOL_DESCRIPTIONS[name],
    inputSchema: APP_TOOL_INPUT_SCHEMAS[name],
    ...(APP_READ_TOOL_NAMES.includes(name) ? { annotations: { readOnlyHint: true } } : {}),
  }));

// Providers on the bridge can't be relied on to ask before each action (Codex
// approves every `orion` tool), so there the actions need Full access: they
// are listed only then, and runAppTool refuses them otherwise
// (requireFullAccess), as machine-tools.js does.
export const appBridgeToolDefinitions = (accessMode) =>
  appMcpToolDefinitions(accessMode === 'full-access' ? 'full-access' : 'read-only');

/** System-prompt hint for Claude runs (claude-driver.js). */
export const APP_TOOLS_PROMPT_HINT = [
  '# Using Durango Code itself (Durango Code)',
  'To do something in the Durango Code app itself (press a button, change a setting, open a thread or panel), use mcp__orion__app_snapshot and app_click / app_type / app_press / app_scroll; never for the project or websites.',
].join('\n');

// --- in the window -------------------------------------------------------------------

// Lists what can be used on screen, remembering each listed element under its
// ref (window.__durangoAppRefs) for the action tools. Returns
// { lines, total, shown }.
const snapshotScript = (filter) => `(() => {
  const FILTER = ${JSON.stringify(String(filter ?? '').toLowerCase().slice(0, 200))};
  const LIMIT = ${SNAPSHOT_LIMIT};
  const AREAS = [
    ['[role="dialog"], [role="alertdialog"], [aria-modal="true"]', 'Dialog'],
    ['[role="menu"], [role="listbox"]', 'Menu'],
    ['.settings-page', 'Settings'],
    ['.app-shellbar', 'Title bar'],
    ['.sidebar', 'Sidebar'],
    ['.composer-shell', 'Prompt box'],
    ['.thread-pane', 'Thread'],
    ['.agents-panel', 'Agents panel'],
    ['.main-content', 'Main'],
  ];
  const INTERACTIVE = 'button, a[href], input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="switch"], [role="radio"], [role="slider"], [role="combobox"], [role="treeitem"], [role="textbox"], [contenteditable=""], [contenteditable="true"], [tabindex]:not([tabindex="-1"]), iframe.theme-control-widget';
  const W = window.innerWidth, H = window.innerHeight;
  const clean = (text, max = 80) => {
    const t = String(text ?? '').replace(/\\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) return null;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return null;
    if (el.closest('[inert], [aria-hidden="true"]') && !el.closest('[data-theme-control]')) return null;
    return r;
  };
  const roleOf = (el) => {
    if (el.classList.contains('theme-control-widget')) return 'theme widget';
    const role = el.getAttribute('role');
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea' || el.isContentEditable) return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'range') return 'slider';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      return 'textbox';
    }
    return 'clickable';
  };
  const nameOf = (el) => {
    const labelled = el.getAttribute('aria-labelledby');
    const byId = labelled ? labelled.split(/\\s+/).map((id) => document.getElementById(id)?.innerText ?? '').join(' ') : '';
    const fieldLabel = el.labels && el.labels.length ? el.labels[0].innerText : '';
    return clean(
      el.getAttribute('aria-label') || byId || fieldLabel || el.getAttribute('title') || el.getAttribute('alt') ||
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.getAttribute('placeholder') : '') ||
      el.innerText || el.getAttribute('placeholder') || ''
    );
  };
  const stateOf = (el) => {
    const out = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    const checked = el.getAttribute('aria-checked') ?? (el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : null);
    if (checked === 'true') out.push('checked');
    else if (checked === 'false') out.push('unchecked');
    if (el.getAttribute('aria-pressed') === 'true') out.push('pressed');
    if (el.getAttribute('aria-selected') === 'true') out.push('selected');
    if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') out.push('current');
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) out.push(expanded === 'true' ? 'expanded' : 'collapsed');
    if (document.activeElement === el) out.push('focused');
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') && el.value && el.type !== 'checkbox' && el.type !== 'radio') {
      out.push('value: ' + (el.type === 'password' ? '•••' : JSON.stringify(clean(el.value, 60))));
    } else if (el.isContentEditable && el.innerText.trim()) out.push('text: ' + JSON.stringify(clean(el.innerText, 60)));
    return out;
  };
  const areaOf = (el) => {
    for (const [selector, label] of AREAS) if (el.closest(selector)) return label;
    return 'Window';
  };
  const picked = new Set();
  for (const el of document.querySelectorAll(INTERACTIVE)) picked.add(el);
  // Clickable divs (React onClick, no role): the outermost element with a
  // pointer cursor that is not inside something already listed.
  for (const el of document.body.querySelectorAll('div, span, li, label, img, svg')) {
    if (picked.has(el)) continue;
    if (getComputedStyle(el).cursor !== 'pointer') continue;
    const parent = el.parentElement;
    if (parent && getComputedStyle(parent).cursor === 'pointer') continue;
    picked.add(el);
  }
  const entries = [];
  for (const el of picked) {
    // A pointer-cursor guess inside a listed element (an icon or label in a
    // button or row) is part of it. Real controls inside one (a rename field or
    // menu button in a thread row) stay listed on their own.
    if (roleOf(el) === 'clickable') {
      let outer = el.parentElement, nested = false;
      while (outer) { if (picked.has(outer)) { nested = true; break; } outer = outer.parentElement; }
      if (nested) continue;
    }
    const r = visible(el);
    if (!r) continue;
    const cx = Math.min(W - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(H - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(cx, cy);
    const covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el);
    const control = el.closest('[data-theme-control]')?.getAttribute('data-theme-control');
    const state = stateOf(el);
    if (control) state.push('theme control ' + control);
    entries.push({ el, r, role: roleOf(el), name: nameOf(el), state, area: areaOf(el), covered });
  }
  // Headings and dialog titles give the list some context.
  for (const el of document.querySelectorAll('h1, h2, h3, [role="heading"]')) {
    const r = visible(el);
    if (r && el.innerText.trim()) entries.push({ el, r, role: 'heading', name: clean(el.innerText), state: [], area: areaOf(el), heading: true });
  }
  const order = (a, b) => (a.el === b.el ? 0 : a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  entries.sort(order);
  // Ref numbers keep counting across snapshots, so a ref from an older one can
  // never name a different element: it is simply not in the map any more.
  const refs = new Map();
  window.__durangoAppRefs = refs;
  let seq = Number(window.__durangoAppRefSeq) || 0;
  const byArea = new Map();
  let total = 0, shown = 0;
  for (const entry of entries) {
    const text = (entry.role + ' ' + entry.name + ' ' + entry.area).toLowerCase();
    if (FILTER && !text.includes(FILTER)) continue;
    total++;
    if (shown >= LIMIT) continue;
    shown++;
    const box = '[' + Math.round(entry.r.left) + ',' + Math.round(entry.r.top) + ' ' + Math.round(entry.r.width) + 'x' + Math.round(entry.r.height) + ']';
    let line;
    if (entry.heading) line = '  ' + entry.role + ' "' + entry.name + '"';
    else {
      const ref = 'e' + ++seq;
      window.__durangoAppRefSeq = seq;
      refs.set(ref, new WeakRef(entry.el));
      const state = entry.state.concat(entry.covered ? ['covered by something on top'] : []);
      line = '  ' + ref + ' ' + entry.role + (entry.name ? ' "' + entry.name.replace(/"/g, "'") + '"' : '') + ' ' + box + (state.length ? ' (' + state.join(', ') + ')' : '');
    }
    if (!byArea.has(entry.area)) byArea.set(entry.area, []);
    byArea.get(entry.area).push(line);
  }
  const lines = [];
  for (const [area, list] of byArea) lines.push(area + ':', ...list);
  return { lines, total, shown, width: W, height: H };
})()`;

// The middle of a listed element, scrolled into view; { error } when the ref is
// unknown or gone.
const locateScript = (ref) => `(() => {
  const el = window.__durangoAppRefs?.get(${JSON.stringify(ref)})?.deref();
  if (!el) return { error: 'unknown' };
  if (!el.isConnected) return { error: 'gone' };
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { error: 'hidden' };
  const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
  const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
  const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.getAttribute('placeholder') || el.tagName.toLowerCase()).replace(/\\s+/g, ' ').trim().slice(0, 60);
  return { x, y, label, hidden: document.visibilityState === 'hidden', frame: el.tagName === 'IFRAME' };
})()`;

// While the window is hidden (minimized, or never shown) real input is not
// delivered, so a click goes to the element itself: the pointer and mouse
// events a click makes, then the click (focus first, for fields). The
// element is the ref's, or the one at x/y.
const domClickScript = ({ ref, x, y, button, double }) => `(() => {
  const el = ${ref ? `window.__durangoAppRefs?.get(${JSON.stringify(ref)})?.deref()` : `document.elementFromPoint(${Number(x)}, ${Number(y)})`};
  if (!el || !el.isConnected) return { error: 'gone' };
  if (el.tagName === 'IFRAME') return { error: 'frame' };
  const r = el.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: ${button === 'right' ? 2 : button === 'middle' ? 1 : 0} };
  if (typeof el.focus === 'function') el.focus({ preventScroll: true });
  const clicks = ${double ? 2 : 1};
  for (let detail = 1; detail <= clicks; detail++) {
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, detail, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...init, detail }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, detail, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...init, detail }));
    if (${button === 'right' ? 'true' : 'false'}) el.dispatchEvent(new MouseEvent('contextmenu', { ...init, detail }));
    else el.dispatchEvent(new MouseEvent('click', { ...init, detail }));
  }
  if (clicks === 2) el.dispatchEvent(new MouseEvent('dblclick', { ...init, detail: 2 }));
  return { ok: true };
})()`;

const HIDDEN_SCRIPT = `document.visibilityState === 'hidden'`;

// What is left in the main frame's focused field after clearing; null when
// focus is not in a field of the main frame (inside a widget frame, say).
const FOCUSED_TEXT_SCRIPT = `(() => {
  const el = document.activeElement;
  if (!el || el.tagName === 'IFRAME') return null;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value;
  if (el.isContentEditable) return el.innerText.replace(/\\n$/, '');
  return null;
})()`;

// --- input -------------------------------------------------------------------------

const fail = (text) => ({ ok: false, text });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const windowFor = (getSender) => {
  const sender = getSender?.();
  if (!sender || sender.isDestroyed?.() || typeof sender.executeJavaScript !== 'function') return null;
  return sender;
};

const run = async (sender, script) => {
  try {
    return await sender.executeJavaScript(script, true);
  } catch {
    return null;
  }
};

// Keys as CDP describes them: key, code, Windows virtual key code, and the text
// a plain press types.
const NAMED_KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  del: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};
const PUNCTUATION = {
  ',': [188, 'Comma'],
  '.': [190, 'Period'],
  '/': [191, 'Slash'],
  ';': [186, 'Semicolon'],
  "'": [222, 'Quote'],
  '[': [219, 'BracketLeft'],
  ']': [221, 'BracketRight'],
  '\\': [220, 'Backslash'],
  '-': [189, 'Minus'],
  '=': [187, 'Equal'],
  '`': [192, 'Backquote'],
  ' ': [32, 'Space'],
};
const MODIFIER_ALIASES = {
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  control: 'control',
  ctrl: 'control',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};
const MODIFIER_BITS = { alt: 1, control: 2, meta: 4, shift: 8 };

/** "CmdOrCtrl+Shift+P" → { key: 'p', code: 'KeyP', keyCode: 80, text: 'p', modifiers: ['meta', 'shift'] }; null if unknown. */
export const parseKey = (input, platform = process.platform) => {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const parts = raw === '+' ? ['+'] : raw.split(/\+(?!$)/);
  const keyPart = parts.pop();
  const modifiers = [];
  for (const part of parts) {
    const lower = part.trim().toLowerCase();
    const modifier = lower === 'cmdorctrl' || lower === 'commandorcontrol' ? (platform === 'darwin' ? 'meta' : 'control') : MODIFIER_ALIASES[lower];
    if (!modifier) return null;
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  const named = NAMED_KEYS[keyPart.toLowerCase()];
  if (named) return { ...named, modifiers };
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(keyPart);
  if (fn) return { key: `F${fn[1]}`, code: `F${fn[1]}`, keyCode: 111 + Number(fn[1]), modifiers };
  if ([...keyPart].length !== 1) return null;
  if (/^[a-z]$/i.test(keyPart)) {
    const upper = keyPart.toUpperCase();
    const key = modifiers.includes('shift') ? upper : keyPart;
    return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key, modifiers };
  }
  if (/^[0-9]$/.test(keyPart)) return { key: keyPart, code: `Digit${keyPart}`, keyCode: keyPart.charCodeAt(0), text: keyPart, modifiers };
  const [keyCode, code] = PUNCTUATION[keyPart] ?? [0, ''];
  return { key: keyPart, code, keyCode, text: keyPart, modifiers };
};

// Input goes in through the DevTools protocol (Input.*): unlike
// webContents.sendInputEvent, which only reaches the main frame, it is routed
// like real input, into out-of-process frames (sandboxed theme widgets) too.
// One action at a time per window; the debugger is attached for the action
// and detached after (left alone when something else attached it).
const inputQueues = new WeakMap();
const withInput = (sender, task) => {
  const previous = inputQueues.get(sender) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const debuggerApi = sender.debugger;
      const attachedHere = !debuggerApi.isAttached();
      if (attachedHere) debuggerApi.attach('1.3');
      // Input the window cannot take (minimized, never shown) would wait forever.
      const send = (method, params) => {
        let timer;
        return Promise.race([
          debuggerApi.sendCommand(method, params),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('the Durango Code window did not take the input (is it minimized?)')), INPUT_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
      };
      try {
        return await task(send);
      } finally {
        if (attachedHere && !sender.isDestroyed() && debuggerApi.isAttached()) {
          try {
            debuggerApi.detach();
          } catch {}
        }
      }
    });
  inputQueues.set(sender, next);
  return next;
};

// Electron's names for sendInputEvent (accelerator style).
const ELECTRON_KEY_NAMES = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space' };

const pressKey = async (send, key, sender) => {
  // On macOS the protocol's key events never reach the page with Command held
  // (key equivalents are taken first), while sendInputEvent's do: Command
  // shortcuts go that way, to the main frame's focused element.
  if (process.platform === 'darwin' && key.modifiers.includes('meta') && sender) {
    const keyCode = ELECTRON_KEY_NAMES[key.key] ?? (key.key.length === 1 ? key.key.toUpperCase() : key.key);
    sender.sendInputEvent({ type: 'keyDown', keyCode, modifiers: key.modifiers });
    sender.sendInputEvent({ type: 'keyUp', keyCode, modifiers: key.modifiers });
    return;
  }
  const modifiers = key.modifiers.reduce((bits, modifier) => bits | MODIFIER_BITS[modifier], 0);
  // Text only for plain or shifted keys: with Control/Alt the key is a
  // shortcut, not typing.
  const text = key.text && !key.modifiers.some((modifier) => modifier !== 'shift') ? key.text : undefined;
  const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers };
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
};

const click = async (send, x, y, { button = 'left', double = false } = {}) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let clickCount = 1; clickCount <= (double ? 2 : 1); clickCount += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
  }
};

/** Where a ref or x/y points: { x, y, label } or { error }. */
const target = async (sender, args, { optional = false } = {}) => {
  if (typeof args.ref === 'string' && args.ref.trim()) {
    const ref = args.ref.trim();
    if (!/^e\d{1,9}$/.test(ref)) return { error: `"${ref}" is not a ref; take one from app_snapshot (e.g. "e12").` };
    const found = await run(sender, locateScript(ref));
    if (!found) return { error: 'The window did not answer.' };
    if (found.error === 'unknown') return { error: `${ref} is not in the latest app_snapshot; take a new one.` };
    if (found.error === 'gone') return { error: `${ref} is no longer on screen (the app re-rendered); take a new app_snapshot.` };
    if (found.error === 'hidden') return { error: `${ref} is hidden now; take a new app_snapshot.` };
    return { x: found.x, y: found.y, ref, label: `${ref} "${found.label}"`, hidden: found.hidden === true, frame: found.frame === true };
  }
  if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
    const hidden = (await run(sender, HIDDEN_SCRIPT)) === true;
    return { x: args.x, y: args.y, label: `(${Math.round(args.x)}, ${Math.round(args.y)})`, hidden };
  }
  if (optional) return null;
  return { error: 'Pass ref (from app_snapshot) or x and y.' };
};

const result = async (text, { screenshot, getSender }) => {
  if (!screenshot) return { ok: true, text };
  const shot = await captureWindow(getSender);
  if (!shot) return { ok: true, text: `${text}\n(No screenshot: the window is not available.)` };
  return {
    ok: true,
    text,
    content: [
      { type: 'text', text },
      { type: 'image', data: shot.data, mimeType: shot.mimeType },
    ],
    images: [shot],
  };
};

/** A click on the element itself, for a hidden window (see domClickScript). */
const domClick = async (sender, at, { button = 'left', double = false }) => {
  if (at.frame) return { error: `${at.label} is a theme widget in its own frame, which only takes real input: the Durango Code window is hidden (minimized?), so it cannot be clicked until the window is back on screen.` };
  const done = await run(sender, domClickScript({ ref: at.ref, x: at.x, y: at.y, button, double }));
  if (!done) return { error: 'The window did not answer.' };
  if (done.error === 'frame') return { error: `${at.label} is inside a theme widget's own frame, which only takes real input: the Durango Code window is hidden (minimized?), so it cannot be clicked until the window is back on screen.` };
  if (done.error) return { error: `${at.label} is no longer on screen; take a new app_snapshot.` };
  return { ok: true };
};

// --- tools -------------------------------------------------------------------------

const appSnapshot = async (args, context, sender) => {
  const snap = await run(sender, snapshotScript(args.filter));
  if (!snap || !Array.isArray(snap.lines)) return fail('The Durango Code window did not answer.');
  const header = `Durango Code window ${snap.width}x${snap.height}${args.filter ? `, entries matching "${args.filter}"` : ''}:`;
  const more = snap.total > snap.shown ? `\n… ${snap.total - snap.shown} more; pass filter to narrow the list.` : '';
  const body = snap.lines.length ? snap.lines.join('\n') : args.filter ? '  (nothing matches)' : '  (nothing to use on screen)';
  return result(`${header}\n${body}${more}`, { screenshot: args.screenshot === true, getSender: context.getSender });
};

const appClick = async (args, context, sender) => {
  const at = await target(sender, args);
  if (at.error) return fail(at.error);
  const button = ['left', 'right', 'middle'].includes(args.button) ? args.button : 'left';
  let note = '';
  if (at.hidden) {
    const done = await domClick(sender, at, { button, double: args.double === true });
    if (done.error) return fail(done.error);
    note = ' (the window is hidden, so the click went to the element directly)';
  } else {
    await withInput(sender, (send) => click(send, at.x, at.y, { button, double: args.double === true }));
  }
  await wait(SETTLE_MS);
  return result(`${args.double === true ? 'Double-clicked' : button === 'left' ? 'Clicked' : `${button[0].toUpperCase()}${button.slice(1)}-clicked`} ${at.label}${note}. Take a new app_snapshot to see what changed.`, {
    screenshot: args.screenshot === true,
    getSender: context.getSender,
  });
};

const appType = async (args, context, sender) => {
  if (typeof args.text !== 'string') return fail('Pass text.');
  let where = 'the focused element';
  let at = null;
  if (args.ref) {
    at = await target(sender, args);
    if (at.error) return fail(at.error);
    where = at.label;
  }
  if (at?.hidden) {
    const done = await domClick(sender, at, {});
    if (done.error) return fail(done.error);
  }
  await withInput(sender, async (send) => {
    if (at && !at.hidden) {
      await click(send, at.x, at.y);
      await wait(60);
    }
    if (args.clear === true) {
      // The selectAll editing command runs in whichever frame has focus (a
      // widget frame too), unlike a script in the main frame.
      const base = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0 };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, commands: ['selectAll'] });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await pressKey(send, parseKey('Backspace'));
      const left = await run(sender, FOCUSED_TEXT_SCRIPT);
      if (typeof left === 'string' && left.length) throw new Error(`could not clear the field (${left.length} characters left); nothing was typed`);
    }
    if (args.text) await send('Input.insertText', { text: args.text });
    if (args.submit === true) {
      await wait(30);
      await pressKey(send, parseKey('Enter'));
    }
  });
  await wait(SETTLE_MS);
  return result(`Typed ${args.text.length} characters into ${where}${args.submit === true ? ' and pressed Enter' : ''}.`, {
    screenshot: args.screenshot === true,
    getSender: context.getSender,
  });
};

const appPress = async (args, context, sender) => {
  const key = parseKey(args.key);
  if (!key) return fail(`Unknown key "${args.key}". Use e.g. "Enter", "Escape", "ArrowDown", "Meta+K", "CmdOrCtrl+,".`);
  await withInput(sender, (send) => pressKey(send, key, sender));
  await wait(SETTLE_MS);
  return result(`Pressed ${args.key}.`, { screenshot: args.screenshot === true, getSender: context.getSender });
};

const appScroll = async (args, context, sender) => {
  let at = await target(sender, args, { optional: true });
  if (at?.error) return fail(at.error);
  if (!at) {
    const size = await run(sender, '[window.innerWidth, window.innerHeight]');
    at = { x: (size?.[0] ?? 800) / 2, y: (size?.[1] ?? 600) / 2, label: 'the middle of the window' };
  }
  const dy = Number.isFinite(args.dy) ? args.dy : Number.isFinite(args.dx) ? 0 : 400;
  const dx = Number.isFinite(args.dx) ? args.dx : 0;
  // sendInputEvent, not the protocol: its wheel events wait for the window to
  // draw a frame, which a covered window may not do for a long time.
  let zoom = 1;
  try {
    zoom = sender.getZoomFactor?.() || 1;
  } catch {}
  const x = Math.round(at.x * zoom);
  const y = Math.round(at.y * zoom);
  sender.sendInputEvent({ type: 'mouseMove', x, y });
  // Wheel deltas point the other way: negative deltaY scrolls down.
  sender.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: -dx, deltaY: -dy, canScroll: true });
  await wait(SETTLE_MS);
  return result(`Scrolled ${dy ? `${Math.abs(dy)}px ${dy > 0 ? 'down' : 'up'}` : ''}${dy && dx ? ' and ' : ''}${dx ? `${Math.abs(dx)}px ${dx > 0 ? 'right' : 'left'}` : ''} over ${at.label}.`, {
    screenshot: args.screenshot === true,
    getSender: context.getSender,
  });
};

/**
 * Run one app tool. Resolves `{ ok, text, content?, images? }`, never throws.
 * `content` carries MCP blocks (screenshots) for the bridge; `images` the same
 * for Claude's in-process server.
 */
export const runAppTool = async (name, rawArgs, context = {}) => {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  if (!APP_TOOL_NAMES.includes(name)) return fail(`Unknown tool: ${name}`);
  if (context.accessMode === 'read-only' && !APP_READ_TOOL_NAMES.includes(name)) {
    return fail(`${name} acts in Durango Code as the user, which Read only does not allow. app_snapshot still works.`);
  }
  if (context.requireFullAccess && context.accessMode !== 'full-access' && !APP_READ_TOOL_NAMES.includes(name)) {
    return fail(`${name} needs Full access for this provider, which can't ask the user before each action. The user can switch this thread to Full access; app_snapshot still works.`);
  }
  const sender = windowFor(context.getSender);
  if (!sender) return fail('The Durango Code window is not available.');
  try {
    if (name === 'app_snapshot') return await appSnapshot(args, context, sender);
    if (name === 'app_click') return await appClick(args, context, sender);
    if (name === 'app_type') return await appType(args, context, sender);
    if (name === 'app_press') return await appPress(args, context, sender);
    return await appScroll(args, context, sender);
  } catch (error) {
    return fail(`${name} failed: ${error?.message ?? error}`);
  }
};
