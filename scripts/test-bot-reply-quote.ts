import assert from 'node:assert/strict';
import {
  BOT_REPLY_EXCERPT_CHARS,
  botReplyAuthor,
  botReplyExcerpt,
  botReplyTarget,
  parseBotReplyQuote,
  withBotReplyQuote,
} from '../src/app/botReplyQuote';
import { botWindowAround, BOT_WINDOW_INITIAL } from '../src/app/botThreadWindow';

// Round trip: the quote line in front of the text, parsed back.
const content = withBotReplyQuote('  and what about Almaty?  ', { author: 'Durango', seq: 42, when: 'Nov 27, 3:15 PM', excerpt: 'SF is 18°C (sunny): light wind' });
assert.equal(content, '> **Replying to Durango** (message #42, Nov 27, 3:15 PM): SF is 18°C (sunny): light wind\n\nand what about Almaty?');
assert.deepEqual(parseBotReplyQuote(content), {
  author: 'Durango',
  seq: 42,
  when: 'Nov 27, 3:15 PM',
  excerpt: 'SF is 18°C (sunny): light wind',
  text: 'and what about Almaty?',
});

// No text (files only): just the quote line.
const bare = withBotReplyQuote('', { author: 'my message', seq: 3, excerpt: 'x' });
assert.equal(bare, '> **Replying to my message** (message #3): x');
assert.deepEqual(parseBotReplyQuote(bare), { author: 'my message', seq: 3, when: null, excerpt: 'x', text: '' });

// Ordinary messages and other quotes aren't replies.
assert.equal(parseBotReplyQuote('hello'), null);
assert.equal(parseBotReplyQuote('> **Answering:** Which city?\n\nSF'), null);
assert.equal(parseBotReplyQuote('> Replying to Durango (message #4): x'), null);

// Names can't break the line: asterisks, newlines and parentheses are dropped.
const odd = withBotReplyQuote('ok', { author: '**Task: a\nb**', seq: 7, when: 'Nov (27)', excerpt: 'line one\nline two' });
assert.equal(parseBotReplyQuote(odd)?.author, 'Task: a b');
assert.equal(parseBotReplyQuote(odd)?.when, 'Nov 27');
assert.equal(parseBotReplyQuote(odd)?.excerpt, 'line one line two');

// Excerpts: flattened, clipped, a reply's own quote left out.
assert.equal(botReplyExcerpt('**Bold** start\n\n```js\nx()\n```\n> quoted'), 'Bold start [code] quoted');
assert.equal(botReplyExcerpt(content), 'and what about Almaty?');
const long = botReplyExcerpt('word '.repeat(400));
assert.equal(long.length, BOT_REPLY_EXCERPT_CHARS);
assert.ok(long.endsWith('…'));

// Authors: the bot, the person ("my message"), inbox labels.
assert.equal(botReplyAuthor({ role: 'assistant' }, 'Durango'), 'Durango');
assert.equal(botReplyAuthor({ role: 'user', authorLabel: null }, 'Durango'), 'my message');
assert.equal(botReplyAuthor({ role: 'user', authorLabel: 'Task: Fix the sidebar' }, 'Durango'), 'Task: Fix the sidebar');
assert.equal(botReplyAuthor({ role: 'user', authorLabel: 'Routine: Morning brief' }, 'Durango'), 'Routine: Morning brief');

// A target for a files-only message names the files.
const target = botReplyTarget({ id: 'm1', seq: 9, role: 'user', content: '', createdAt: Date.UTC(2026, 10, 27, 4, 15), files: [{ name: 'a.png' }] }, 'Durango');
assert.equal(target.excerpt, '[attached: a.png]');
assert.equal(target.author, 'my message');
assert.equal(target.seq, 9);
assert.ok(target.when.length > 0);

// The window shown around a jumped-to message always contains it.
for (const count of [1, 5, BOT_WINDOW_INITIAL, 100, 500]) {
  for (const index of [0, Math.floor(count / 2), count - 1]) {
    const range = botWindowAround(count, index);
    assert.ok(range.start <= index && index < range.end, `${count}/${index}`);
    assert.ok(range.end - range.start <= BOT_WINDOW_INITIAL + 1);
    assert.equal(range.following, range.end === count);
  }
}

console.log('bot reply quote: ok');
