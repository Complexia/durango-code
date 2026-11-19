import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ReleaseNotesList } from '../src/app/AppUpdateUi';

// The update button's card, the What's new notice and Settings all list
// release notes with ReleaseNotesList: each note's inline Markdown renders,
// and the note stays one tight list item.
const html = (notes: string[]) => renderToStaticMarkup(<ReleaseNotesList notes={notes} />);

const list = html([
  '**Your bots, answered here:** run `durango-code ws path <name>`, see [bots](https://durango.sh/bots).',
  '*Sidebar v3* is ~~gone~~ experimental',
]);
assert.match(list, /^<ul class="release-notes-list /);
assert.match(list, /<li[^>]*><strong>Your bots, answered here:<\/strong> run <code>durango-code ws path &lt;name&gt;<\/code>, see <a href="https:\/\/durango.sh\/bots" title="https:\/\/durango.sh\/bots">bots<\/a>\.<\/li>/);
assert.match(list, /<li[^>]*><em>Sidebar v3<\/em> is <del>gone<\/del> experimental<\/li>/);
assert.doesNotMatch(list, /\*\*|<p>/, 'no raw asterisks and no paragraph spacing inside list items');

// Raw HTML is never rendered, and only web links become links.
const unsafe = html(['Hi <img src=x onerror="alert(1)"><b>bold</b>', '[run](javascript:alert(1)) and [file](/etc/passwd)']);
assert.doesNotMatch(unsafe, /<img|<b>|onerror/);
assert.doesNotMatch(unsafe, /<a /);
assert.match(unsafe, /run and file/);

// Block Markdown inside a note is unwrapped to its text.
assert.match(html(['> quoted `x`']), /<li[^>]*>\s*quoted <code>x<\/code>\s*<\/li>/);

// Plain notes render as before.
assert.match(html(['Show images inline in chat']), /<li[^>]*>Show images inline in chat<\/li>/);

console.log('release notes UI tests passed');
