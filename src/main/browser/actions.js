// Page actions of the built-in browser, run against one tab through CDP and
// Electron's webContents input APIs. Every action throws an Error whose
// message is safe to hand to the model; manager.js turns it into a tool error.
import fs from 'node:fs/promises';
import path from 'node:path';
import { beginRefGeneration, resolveRef } from './policy.js';
import { buildSnapshot } from './snapshot.js';

export const EVALUATE_MAX_CHARS = 32 * 1024;
export const NAVIGATION_DEFAULT_TIMEOUT_MS = 15_000;
export const NAVIGATION_MAX_TIMEOUT_MS = 30_000;
export const WAIT_FOR_DEFAULT_TIMEOUT_MS = 10_000;
export const SCREENSHOT_MAX_WIDTH = 1280;
export const RESIZE_PRESETS = {
  mobile: { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 },
  tablet: { width: 820, height: 1180, mobile: true, deviceScaleFactor: 2 },
  desktop: { width: 1280, height: 800, mobile: false, deviceScaleFactor: 0 },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clampTimeout = (value, fallback, max) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(max, Math.max(100, Math.round(number)));
};

export const pageLine = (tab) => {
  const wc = tab.view.webContents;
  return `${wc.getURL() || 'about:blank'} · ${JSON.stringify(wc.getTitle() || '')}`;
};

// ---- Snapshots ---------------------------------------------------------------

const flattenFrames = (frameTree) => {
  const out = [];
  const walk = (node) => {
    for (const child of node?.childFrames ?? []) {
      out.push(child.frame);
      walk(child);
    }
  };
  walk(frameTree);
  return out;
};

const maskedNodeIds = async (cdp) => {
  const ids = new Set();
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: 'input[type="password" i]',
    });
    for (const nodeId of nodeIds ?? []) {
      try {
        const { node } = await cdp.send('DOM.describeNode', { nodeId });
        if (typeof node?.backendNodeId === 'number') ids.add(node.backendNodeId);
      } catch {}
    }
  } catch {}
  return ids;
};

export const snapshotTab = async (tab, { maxChars, notes = [] } = {}) => {
  const { cdp } = tab;
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {});
  const frames = new Map();
  try {
    const { frameTree } = await cdp.send('Page.getFrameTree', {});
    for (const frame of flattenFrames(frameTree).slice(0, 20)) {
      try {
        const owner = await cdp.send('DOM.getFrameOwner', { frameId: frame.id });
        const { nodes: frameNodes } = await cdp.send('Accessibility.getFullAXTree', { frameId: frame.id });
        if (typeof owner?.backendNodeId === 'number' && frameNodes?.length) {
          frames.set(owner.backendNodeId, frameNodes);
        }
      } catch {
        // Cross-process (out-of-process) frames have their own target; v1
        // reads only same-process frames.
      }
    }
  } catch {}
  const masked = await maskedNodeIds(cdp);
  const allocateRef = beginRefGeneration(tab.refs);
  const wc = tab.view.webContents;
  return buildSnapshot({
    tabId: tab.id,
    url: wc.getURL(),
    title: wc.getTitle(),
    nodes,
    frames,
    maskedNodeIds: masked,
    allocateRef,
    maxChars,
    notes,
  });
};

// ---- Element helpers ---------------------------------------------------------

const backendNodeForRef = (tab, ref) => {
  const resolved = resolveRef(tab.refs, ref);
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.backendNodeId;
};

const resolveObject = async (cdp, backendNodeId, ref) => {
  try {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
    if (!object?.objectId) throw new Error('no object');
    return object.objectId;
  } catch {
    throw new Error(`Element ${ref} is no longer on the page. Take a new browser_snapshot.`);
  }
};

const callOn = async (cdp, objectId, functionDeclaration, args = []) => {
  const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    arguments: args.map((value) =>
      value && typeof value === 'object' && 'objectId' in value ? value : { value }
    ),
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || 'Script failed.');
  }
  return result?.value;
};

const DESCRIBE_NODE = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return 'an unknown node';
  let label = el.tagName.toLowerCase();
  if (el.id) label += '#' + el.id;
  if (typeof el.className === 'string' && el.className.trim()) {
    label += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
  }
  const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
  return text ? label + ' "' + text + '"' : label;
}`;

const CONTAINS_HIT = `function (hit) {
  let node = hit;
  while (node) {
    if (node === this) return true;
    node = node.parentNode || node.host || null;
  }
  const el = hit && (hit.nodeType === 1 ? hit : hit.parentElement);
  const label = el && el.closest ? el.closest('label') : null;
  return Boolean(label && (label.control === this || label.contains(this)));
}`;

const centerOfQuads = (quads) => {
  for (const quad of quads ?? []) {
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    if (width < 1 || height < 1) continue;
    return { x: xs.reduce((a, b) => a + b, 0) / 4, y: ys.reduce((a, b) => a + b, 0) / 4 };
  }
  return null;
};

// Scrolls the element into view and finds a clickable point; refuses with
// what is on top when another element would take the click.
const clickPointForRef = async (tab, ref) => {
  const { cdp } = tab;
  const backendNodeId = backendNodeForRef(tab, ref);
  try {
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
  } catch {}
  let quads;
  try {
    ({ quads } = await cdp.send('DOM.getContentQuads', { backendNodeId }));
  } catch {
    throw new Error(`Element ${ref} is not rendered (hidden or detached). Take a new browser_snapshot.`);
  }
  const point = centerOfQuads(quads);
  if (!point) throw new Error(`Element ${ref} has no visible box to click.`);
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  try {
    const hit = await cdp.send('DOM.getNodeForLocation', {
      x,
      y,
      includeUserAgentShadowDOM: true,
      ignorePointerEventsNone: false,
    });
    if (typeof hit?.backendNodeId === 'number' && hit.backendNodeId !== backendNodeId) {
      const targetObject = await resolveObject(cdp, backendNodeId, ref);
      const { object: hitObject } = await cdp.send('DOM.resolveNode', { backendNodeId: hit.backendNodeId });
      if (hitObject?.objectId) {
        const inside = await callOn(cdp, targetObject, CONTAINS_HIT, [{ objectId: hitObject.objectId }]);
        if (!inside) {
          const covering = await callOn(cdp, hitObject.objectId, DESCRIBE_NODE).catch(() => 'another element');
          throw new Error(
            `Element ${ref} is covered by ${covering} at (${x}, ${y}); the click would land on it. Close or scroll past the overlay, or click at x/y to click it anyway.`
          );
        }
      }
    }
  } catch (error) {
    if (/is covered by/.test(error?.message)) throw error;
    // Hit testing is advisory: some pages (cross-process frames) can't answer.
  }
  return { x, y, backendNodeId };
};

const MODIFIER_BITS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const modifierMask = (modifiers) =>
  (Array.isArray(modifiers) ? modifiers : []).reduce(
    (mask, name) => mask | (MODIFIER_BITS[String(name).toLowerCase()] ?? 0),
    0
  );

// A JavaScript dialog opened by the event blocks the page, so Chromium only
// acknowledges the input event once the dialog is answered: stop waiting for
// the acknowledgement as soon as the dialog shows up.
const sendInputUntilDialog = (tab, params, timeoutMs) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      callback(value);
    };
    const timer = setInterval(() => {
      if (tab.dialog) finish(resolve);
    }, 25);
    tab.cdp.send('Input.dispatchMouseEvent', params, timeoutMs).then(
      (value) => finish(resolve, value),
      (error) => finish(tab.dialog ? resolve : reject, error)
    );
  });

// Where a press is let go when the agent loses the tab mid-click: outside the
// page, so the release (and the click Chromium then sends to the common
// ancestor, <html>) never lands on the pressed element.
export const CANCEL_RELEASE_POINT = { x: -1, y: -1 };

// Lets go of a held press without activating the pressed element. The
// pointer first moves out of the page as a plain hover (no `button`, no
// `buttons`): on Electron 42 that makes the page lose pointer capture
// (setPointerCapture in pointerdown, active or still pending), which would
// otherwise route the release, and the click, to the captured element wherever
// the release happens. (A move that reports the pressed button keeps the
// capture: the release then still clicks the element.) The release then lands
// outside the page: `pointerup`/`mouseup` go to <html> and the click to the
// common ancestor (<html>), as when a person drags off a button.
const cancelPress = async (tab, { button, clickCount, modifiers }) => {
  await tab.cdp
    .send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...CANCEL_RELEASE_POINT, modifiers }, 2_000)
    .catch(() => {});
  await sendInputUntilDialog(
    tab,
    { type: 'mouseReleased', ...CANCEL_RELEASE_POINT, button, buttons: 0, clickCount, modifiers },
    2_000
  ).catch(() => {});
};

// A click whose mousedown opened a JavaScript dialog returns with the button
// still down (tab.pendingPress), since the page can't take the release until
// the dialog is answered. Called once it is (answerTabDialog) and before the
// tab's next agent action: the release completes the click on the element
// while the agent still controls the tab, and is let go without a click
// (cancelPress) when the user took over meanwhile or the page moved on
// (navigation, crash, dialogs cancelled). Either way the page sees its
// mouseup, so drag state it keeps from mousedown ends.
export const settlePendingPress = async (tab) => {
  const press = tab.pendingPress;
  if (!press || tab.dialog) return;
  tab.pendingPress = null;
  let complete = !press.cancel;
  if (complete) {
    try {
      tab.markAgentInput?.();
    } catch {
      complete = false;
    }
  }
  tab.agentBusy += 1;
  try {
    if (complete) {
      await sendInputUntilDialog(tab, {
        type: 'mouseReleased', x: press.x, y: press.y, button: press.button, buttons: 0, clickCount: press.clickCount, modifiers: press.modifiers,
      }).catch(() => {});
    } else {
      await cancelPress(tab, press);
    }
  } finally {
    tab.agentBusy -= 1;
  }
};

const dispatchClick = async (tab, { x, y, button = 'left', double = false, modifiers = [] }) => {
  const { cdp } = tab;
  const mask = modifierMask(modifiers);
  const buttonName = ['left', 'right', 'middle'].includes(button) ? button : 'left';
  const buttons = { left: 1, right: 2, middle: 4 }[buttonName];
  tab.markAgentInput?.();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: mask });
  for (let count = 1; count <= (double ? 2 : 1); count += 1) {
    tab.markAgentInput?.();
    await sendInputUntilDialog(tab, {
      type: 'mousePressed', x, y, button: buttonName, buttons, clickCount: count, modifiers: mask,
    });
    const press = { x, y, button: buttonName, buttons, clickCount: count, modifiers: mask };
    if (tab.dialog) {
      // The mousedown opened a dialog; the release follows its answer.
      tab.pendingPress = press;
      return;
    }
    // Take over (or closing the tab) while the press was on its way: let go
    // of the button without clicking the element, then fail.
    try {
      tab.markAgentInput?.();
    } catch (error) {
      await cancelPress(tab, press);
      throw error;
    }
    await sendInputUntilDialog(tab, {
      type: 'mouseReleased', x, y, button: buttonName, buttons: 0, clickCount: count, modifiers: mask,
    });
    if (tab.dialog) return;
  }
};

// After an action that may navigate, give the page a moment to start and
// settle so the reply reflects where it ended up.
const settleAfterAction = async (tab, maxMs = 5_000) => {
  const wc = tab.view.webContents;
  await sleep(120);
  if (!wc.isLoading()) return;
  const started = Date.now();
  while (wc.isLoading() && Date.now() - started < maxMs) await sleep(100);
};

export const clickAction = async (tab, args) => {
  const hasPoint = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y)) && args.ref === undefined;
  if (!hasPoint && !args.ref) throw new Error('browser_click needs a `ref` from browser_snapshot, or `x` and `y`.');
  const target = hasPoint
    ? { x: Math.round(Number(args.x)), y: Math.round(Number(args.y)) }
    : await clickPointForRef(tab, args.ref);
  await dispatchClick(tab, { ...target, button: args.button, double: args.double === true, modifiers: args.modifiers });
  await settleAfterAction(tab);
  const what = hasPoint ? `(${target.x}, ${target.y})` : args.ref;
  return `${args.double ? 'Double-clicked' : 'Clicked'} ${what} in tab ${tab.id}. Now at ${pageLine(tab)}.${tab.dialog ? ` A ${tab.dialog.type} dialog is open: ${JSON.stringify(tab.dialog.message)}. Answer it with browser_dialog.` : ''}`;
};

// ---- Keyboard ------------------------------------------------------------------
// Keyboard input goes through webContents.sendInputEvent / insertText rather
// than CDP Input.dispatchKeyEvent: CDP key events follow the app window's
// focus, so with the panel unfocused they could reach Durango Code's own UI.

const KEY_ALIASES = {
  enter: 'Return', return: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace',
  delete: 'Delete', del: 'Delete', insert: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  arrowup: 'Up', up: 'Up', arrowdown: 'Down', down: 'Down', arrowleft: 'Left', left: 'Left',
  arrowright: 'Right', right: 'Right', space: 'Space', ' ': 'Space',
};
const MODIFIER_NAMES = {
  shift: 'shift', control: 'control', ctrl: 'control', alt: 'alt', option: 'alt', meta: 'meta', cmd: 'meta',
  command: 'meta', cmdorctrl: process.platform === 'darwin' ? 'meta' : 'control',
};

export const parseKeyCombo = (combo) => {
  const raw = String(combo ?? '').trim();
  if (!raw) throw new Error('browser_press needs a `key`, e.g. "Enter", "Tab", "Escape" or "Control+a".');
  const parts = raw === '+' ? ['+'] : raw.split('+').filter((part, index, all) => part || index === all.length - 1);
  const keyPart = parts.pop() || '+';
  const modifiers = [];
  for (const part of parts) {
    const name = MODIFIER_NAMES[part.toLowerCase()];
    if (!name) throw new Error(`Unknown modifier "${part}" in "${raw}". Use Shift, Control, Alt or Meta.`);
    modifiers.push(name);
  }
  const alias = KEY_ALIASES[keyPart.toLowerCase()];
  let keyCode;
  let char = null;
  if (alias) {
    keyCode = alias;
    if (alias === 'Return') char = '\r';
    if (alias === 'Space') char = ' ';
  } else if (/^f([1-9]|1\d|2[0-4])$/i.test(keyPart)) {
    keyCode = keyPart.toUpperCase();
  } else if ([...keyPart].length === 1) {
    keyCode = keyPart;
    char = keyPart;
  } else {
    throw new Error(`Unknown key "${keyPart}". Use a single character or a name like Enter, Tab, Escape, Backspace, ArrowDown, PageUp, F5.`);
  }
  // Shortcuts (Control/Meta) send no character.
  if (modifiers.includes('control') || modifiers.includes('meta')) char = null;
  return { keyCode, modifiers, char };
};

export const pressKey = async (tab, combo) => {
  const { keyCode, modifiers, char } = parseKeyCombo(combo);
  const wc = tab.view.webContents;
  tab.markAgentInput?.();
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (char !== null) wc.sendInputEvent({ type: 'char', keyCode: char, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
};

export const pressAction = async (tab, args) => {
  await pressKey(tab, args.key);
  await settleAfterAction(tab);
  return `Pressed ${args.key} in tab ${tab.id}. Now at ${pageLine(tab)}.`;
};

const EDITABLE_CHECK = `function (clear) {
  const el = this;
  const blocked = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'color', 'range', 'hidden'];
  const editable =
    el.isContentEditable ||
    el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && !blocked.includes((el.type || '').toLowerCase()));
  if (!editable) return { ok: false, tag: el.tagName.toLowerCase(), type: el.type || '' };
  if (el.disabled || el.readOnly) return { ok: false, disabled: true, tag: el.tagName.toLowerCase() };
  el.focus();
  if (clear) {
    if (typeof el.select === 'function' && 'value' in el) {
      el.select();
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  } else if ('value' in el && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
  }
  return { ok: true };
}`;

export const typeAction = async (tab, args) => {
  if (!args.ref) throw new Error('browser_type needs a `ref` from browser_snapshot.');
  if (typeof args.text !== 'string') throw new Error('browser_type needs a string `text`.');
  const { cdp } = tab;
  const backendNodeId = backendNodeForRef(tab, args.ref);
  try {
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
  } catch {}
  const objectId = await resolveObject(cdp, backendNodeId, args.ref);
  try {
    await cdp.send('DOM.focus', { backendNodeId });
  } catch {}
  const check = await callOn(cdp, objectId, EDITABLE_CHECK, [args.clear === true]);
  if (!check?.ok) {
    throw new Error(
      check?.disabled
        ? `Element ${args.ref} is disabled or read-only.`
        : `Element ${args.ref} (${check?.tag}${check?.type ? ` type=${check.type}` : ''}) does not take text. Pick a textbox ref from browser_snapshot.`
    );
  }
  const wc = tab.view.webContents;
  tab.markAgentInput?.();
  if (args.text) {
    await wc.insertText(args.text);
  } else if (args.clear === true) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
  }
  if (args.submit === true) {
    await pressKey(tab, 'Enter');
    await settleAfterAction(tab);
  }
  // A secret from a ref (request_secret) is never echoed, however short.
  const typed = args[Symbol.for('durango.secretTyped')]
    ? 'the secret'
    : args.text.length > 60
      ? `${args.text.length} characters`
      : JSON.stringify(args.text);
  return `Typed ${typed} into ${args.ref}${args.clear ? ' (replacing its contents)' : ''}${args.submit ? ' and pressed Enter' : ''} in tab ${tab.id}. Now at ${pageLine(tab)}.`;
};

const SELECT_OPTIONS = `function (values) {
  const el = this;
  if (el.tagName !== 'SELECT') return { ok: false, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '' };
  if (el.disabled) return { ok: false, disabled: true };
  const wanted = values.map((value) => String(value).trim());
  const matched = [];
  for (const option of el.options) {
    const hit =
      wanted.includes(option.value) ||
      wanted.includes(option.label.trim()) ||
      wanted.includes(option.textContent.trim());
    const take = hit && (el.multiple || matched.length === 0);
    option.selected = take;
    if (take) matched.push(option.label.trim() || option.value);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return {
    ok: true,
    matched,
    available: Array.from(el.options).slice(0, 50).map((option) => option.label.trim() || option.value),
  };
}`;

export const selectAction = async (tab, args) => {
  if (!args.ref) throw new Error('browser_select needs a `ref` of a <select> from browser_snapshot.');
  const values = Array.isArray(args.values) ? args.values : args.values !== undefined ? [args.values] : [];
  if (values.length === 0) throw new Error('browser_select needs `values` (option values or labels).');
  const { cdp } = tab;
  const backendNodeId = backendNodeForRef(tab, args.ref);
  const objectId = await resolveObject(cdp, backendNodeId, args.ref);
  tab.markAgentInput?.();
  const result = await callOn(cdp, objectId, SELECT_OPTIONS, [values]);
  if (!result?.ok) {
    throw new Error(
      result?.disabled
        ? `The <select> ${args.ref} is disabled.`
        : `Element ${args.ref} is a ${result?.tag}${result?.role ? ` (role ${result.role})` : ''}, not a <select>. For custom dropdowns, click to open them and click the option.`
    );
  }
  if (result.matched.length === 0) {
    throw new Error(`No option of ${args.ref} matches ${JSON.stringify(values)}. Options: ${JSON.stringify(result.available)}.`);
  }
  await settleAfterAction(tab, 2_000);
  return `Selected ${JSON.stringify(result.matched)} in ${args.ref} (tab ${tab.id}).`;
};

// ---- Script ------------------------------------------------------------------

export const evaluateAction = async (tab, args) => {
  if (typeof args.expression !== 'string' || !args.expression.trim()) {
    throw new Error('browser_evaluate needs a JavaScript `expression`.');
  }
  const timeout = clampTimeout(args.timeout_ms, 10_000, NAVIGATION_MAX_TIMEOUT_MS);
  tab.markAgentInput?.();
  const { result, exceptionDetails } = await tab.cdp.send(
    'Runtime.evaluate',
    {
      expression: args.expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      timeout,
    },
    timeout + 2_000
  );
  if (exceptionDetails) {
    throw new Error(
      `The expression threw: ${exceptionDetails.exception?.description || exceptionDetails.text || 'unknown error'}`
    );
  }
  let text;
  if (result?.type === 'undefined') text = 'undefined';
  else if ('value' in (result ?? {})) {
    try {
      text = typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2);
    } catch {
      text = String(result.value);
    }
  } else text = result?.description ?? String(result?.type ?? 'undefined');
  if (text === undefined) text = result?.description ?? 'undefined';
  if (text.length > EVALUATE_MAX_CHARS) {
    text = `${text.slice(0, EVALUATE_MAX_CHARS)}\n… (truncated: the result was ${text.length} characters; return less)`;
  }
  return text;
};

export const waitForAction = async (tab, args) => {
  const { text, text_gone: textGone, url_includes: urlIncludes } = args;
  if (!text && !textGone && !urlIncludes) {
    throw new Error('browser_wait_for needs `text`, `text_gone` or `url_includes`.');
  }
  const timeout = clampTimeout(args.timeout_ms, WAIT_FOR_DEFAULT_TIMEOUT_MS, NAVIGATION_MAX_TIMEOUT_MS);
  const wc = tab.view.webContents;
  const started = Date.now();
  const check = async () => {
    if (urlIncludes && !wc.getURL().includes(String(urlIncludes))) return false;
    if (text || textGone) {
      let body = '';
      try {
        const { result } = await tab.cdp.send(
          'Runtime.evaluate',
          { expression: 'document.body ? document.body.innerText : ""', returnByValue: true },
          2_000
        );
        body = String(result?.value ?? '');
      } catch {
        return false;
      }
      if (text && !body.includes(String(text))) return false;
      if (textGone && body.includes(String(textGone))) return false;
    }
    return true;
  };
  while (Date.now() - started < timeout) {
    if (tab.dialog) {
      throw new Error(`A ${tab.dialog.type} dialog opened while waiting: ${JSON.stringify(tab.dialog.message)}. Answer it with browser_dialog.`);
    }
    if (await check()) {
      return `Condition met after ${((Date.now() - started) / 1000).toFixed(1)} s in tab ${tab.id}. Now at ${pageLine(tab)}.`;
    }
    await sleep(100);
  }
  throw new Error(`Timed out after ${Math.round(timeout / 1000)} s waiting in tab ${tab.id}. Now at ${pageLine(tab)}.`);
};

// Answers the tab's open JavaScript dialog: through the held dialog callback
// when guest-dialogs.js routes the tab's dialogs, otherwise through CDP (which
// leaves Electron's native dialog on screen, see guest-dialogs.js).
// Answering the last held dialog also lets go of a click's press it
// interrupted (settlePendingPress).
export const answerTabDialog = async (tab, { accept, promptText }) => {
  // With the hook, the next queued dialog (if any) becomes tab.dialog.
  if (!tab.guestDialogs?.answer(accept !== false, promptText)) {
    await tab.cdp.send('Page.handleJavaScriptDialog', {
      accept: accept !== false,
      ...(typeof promptText === 'string' ? { promptText } : {}),
    });
    tab.dialog = null;
  }
  await settlePendingPress(tab);
};

export const dialogAction = async (tab, args) => {
  if (!tab.dialog) return `No dialog is open in tab ${tab.id}.`;
  const dialog = tab.dialog;
  await answerTabDialog(tab, { accept: args.accept, promptText: args.prompt_text });
  await settleAfterAction(tab, 3_000);
  const next = tab.dialog ? ` Another ${tab.dialog.type} dialog is open now: ${JSON.stringify(tab.dialog.message)}. Answer it with browser_dialog.` : '';
  return `${args.accept !== false ? 'Accepted' : 'Dismissed'} the ${dialog.type} dialog ${JSON.stringify(dialog.message)} in tab ${tab.id}.${next}`;
};

export const resizeAction = async (tab, args) => {
  const { cdp } = tab;
  if (args.preset === 'reset' || (args.preset === undefined && args.width === undefined && args.height === undefined)) {
    await cdp.send('Emulation.clearDeviceMetricsOverride', {});
    tab.viewport = null;
    return `Tab ${tab.id} uses the panel's size again.`;
  }
  const preset = args.preset ? RESIZE_PRESETS[args.preset] : null;
  if (args.preset && !preset) throw new Error('`preset` must be mobile, tablet, desktop or reset.');
  const width = Math.round(Number(args.width ?? preset?.width ?? 1280));
  const height = Math.round(Number(args.height ?? preset?.height ?? 800));
  if (!(width >= 200 && width <= 3840 && height >= 200 && height <= 2160)) {
    throw new Error('Width must be 200–3840 and height 200–2160 CSS pixels.');
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: preset?.deviceScaleFactor ?? 0,
    mobile: preset?.mobile ?? false,
  });
  tab.viewport = { width, height };
  return `Tab ${tab.id} now renders at ${width}×${height}${preset?.mobile ? ' as a mobile device' : ''}.`;
};

// ---- Screenshots ---------------------------------------------------------------

export const captureScreenshot = async (tab, { directory }) => {
  const wc = tab.view.webContents;
  // stayHidden: a tab that is not on screen still paints for the capture.
  let image = await wc.capturePage(undefined, { stayHidden: true });
  if (image.isEmpty()) throw new Error('The page has not painted yet; try again in a moment.');
  const { width } = image.getSize();
  if (width > SCREENSHOT_MAX_WIDTH) image = image.resize({ width: SCREENSHOT_MAX_WIDTH, quality: 'good' });
  const jpeg = image.toJPEG(70);
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${tab.id}-${Date.now()}.jpg`);
  await fs.writeFile(filePath, jpeg);
  const size = image.getSize();
  return { filePath, data: jpeg.toString('base64'), mimeType: 'image/jpeg', width: size.width, height: size.height };
};

// ---- Navigation ------------------------------------------------------------------

export const waitForNavigation = (wc, { waitUntil = 'load', timeoutMs = NAVIGATION_DEFAULT_TIMEOUT_MS } = {}) => {
  if (waitUntil === 'none') return { promise: Promise.resolve({ status: 'started' }), cancel: () => {} };
  let cleanup = () => {};
  const promise = new Promise((resolve) => {
    const doneEvent = waitUntil === 'domcontentloaded' ? 'dom-ready' : 'did-stop-loading';
    const onDone = () => finish({ status: 'loaded' });
    const onFail = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // -3 (ERR_ABORTED) is a navigation replaced by another, e.g. a redirect.
      if (isMainFrame && errorCode !== -3) finish({ status: 'failed', errorCode, errorDescription, url: validatedURL });
    };
    const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
    function finish(value) {
      cleanup();
      resolve(value);
    }
    cleanup = () => {
      clearTimeout(timer);
      wc.removeListener(doneEvent, onDone);
      wc.removeListener('did-fail-load', onFail);
    };
    wc.on(doneEvent, onDone);
    wc.on('did-fail-load', onFail);
  });
  return { promise, cancel: () => cleanup() };
};

export const describeNavigation = (tab, result, timeoutMs) => {
  if (result.status === 'failed') {
    return { ok: false, text: `Could not load ${result.url || 'the page'} in tab ${tab.id}: ${result.errorDescription || 'error'} (${result.errorCode}).` };
  }
  if (result.status === 'timeout') {
    return { ok: true, text: `Tab ${tab.id} is still loading after ${Math.round(timeoutMs / 1000)} s: ${pageLine(tab)}. Take a browser_snapshot or browser_wait_for to continue.` };
  }
  if (result.status === 'started') return { ok: true, text: `Tab ${tab.id} started loading: ${pageLine(tab)}.` };
  return { ok: true, text: `Tab ${tab.id} loaded ${pageLine(tab)}.` };
};

export const navigationTimeout = (value) =>
  clampTimeout(value, NAVIGATION_DEFAULT_TIMEOUT_MS, NAVIGATION_MAX_TIMEOUT_MS);
