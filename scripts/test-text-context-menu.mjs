import assert from 'node:assert/strict';
import { buildTextContextMenuTemplate } from '../src/main/text-context-menu.js';

const calls = [];
const actions = new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, ...args]) });
const labels = (t) => t.map((i) => i.label ?? i.role ?? i.type);
const flags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };

// Misspelled word in the composer: suggestions first, Learn Spelling, then edit actions.
let t = buildTextContextMenuTemplate(
  { isEditable: true, misspelledWord: 'defficiency', dictionarySuggestions: ['deficiency', 'efficiency'], editFlags: flags },
  actions,
  'darwin'
);
assert.deepEqual(labels(t), ['deficiency', 'efficiency', 'separator', 'Learn Spelling', 'separator', 'cut', 'copy', 'paste', 'selectAll']);
t[0].click();
t[3].click();
assert.deepEqual(calls, [['replaceMisspelling', 'deficiency'], ['learnWord', 'defficiency']]);

// No guesses: a disabled hint instead of an empty section.
t = buildTextContextMenuTemplate({ isEditable: true, misspelledWord: 'qzxv', dictionarySuggestions: [], editFlags: flags }, actions, 'darwin');
assert.equal(t[0].label, 'No Guesses Found');
assert.equal(t[0].enabled, false);

// At most six suggestions.
t = buildTextContextMenuTemplate({ isEditable: true, misspelledWord: 'x', dictionarySuggestions: 'abcdefghij'.split(''), editFlags: flags }, actions, 'darwin');
assert.equal(t.findIndex((i) => i.type === 'separator'), 6);

// Selected text outside an input: Look Up (macOS) + Copy.
t = buildTextContextMenuTemplate({ selectionText: '  a fairly long selected sentence here  ' }, actions, 'darwin');
assert.deepEqual(labels(t), ['Look Up “a fairly long selected…”', 'separator', 'copy']);
t = buildTextContextMenuTemplate({ selectionText: 'word' }, actions, 'linux');
assert.deepEqual(labels(t), ['copy']);

// Whitespace-only selection outside an input: Copy, but no Look Up.
t = buildTextContextMenuTemplate({ selectionText: ' \n ' }, actions, 'darwin');
assert.deepEqual(labels(t), ['copy']);

// Links: only http(s).
t = buildTextContextMenuTemplate({ linkURL: 'https://durango.sh' }, actions, 'darwin');
assert.deepEqual(labels(t), ['Open Link in Browser', 'Copy Link']);
assert.deepEqual(buildTextContextMenuTemplate({ linkURL: 'javascript:alert(1)' }, actions, 'darwin'), []);

// Plain right-click on nothing: no menu at all.
assert.deepEqual(buildTextContextMenuTemplate({}, actions, 'darwin'), []);
assert.deepEqual(buildTextContextMenuTemplate(undefined, actions, 'darwin'), []);

console.log('text context menu: ok');
