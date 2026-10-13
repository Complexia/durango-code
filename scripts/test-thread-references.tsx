import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { create } from 'zustand';

import type { Thread } from '../src/store';

const thread = (id: string, title: string) => ({ id, title, projectId: 'p', messages: [] }) as unknown as Thread;
const audit = thread('3fff374b-2675-4bdd-be1a-3236df5c6415', 'Full-App Performance Audit Plan');
const other = thread('6a45b7ad-417d-429d-b47a-b0521d3a0c78', 'Find the App Optimization Thread');
const threads = [audit, other];

// Server rendering reads a zustand store's initial state, so stand in a store
// that starts out holding these threads.
mock.module('../src/store', () => ({ useOrionStore: create(() => ({ threads })) }));
const { MarkdownContent, ThreadReferenceText } = await import('../src/app/markdown');
const { resolveThreadReference, threadMentionToken } = await import('../src/app/promptContext');

// Full ids, mention tokens (even after a retitle), and bare fragments resolve.
assert.equal(resolveThreadReference(audit.id, threads), audit);
assert.equal(resolveThreadReference(audit.id.toUpperCase(), threads), audit);
assert.equal(resolveThreadReference(threadMentionToken(audit).slice('thread:'.length), threads), audit);
assert.equal(resolveThreadReference('old-title-6a45b7ad', threads), other);
assert.equal(resolveThreadReference('3fff374b', threads), audit);
assert.equal(resolveThreadReference('deadbeef', threads), undefined);
const twin = thread('3fff374b-0000-0000-0000-000000000000', 'Twin');
assert.equal(resolveThreadReference('3fff374b', [audit, twin]), undefined, 'an ambiguous fragment is not guessed');

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

// Agent markdown: prose, bold, and a whole code span become thread chips.
const prose = html(<MarkdownContent content={`I found it: **@thread:${audit.id}**, and \`@thread:6a45b7ad\`.`} />);
assert.equal(prose.match(/class="thread-reference"/g)?.length, 2);
assert.match(prose, /<strong><button[^>]*class="thread-reference"[\s\S]*?Full-App Performance Audit Plan/);
assert.match(prose, /Find the App Optimization Thread/);
assert.doesNotMatch(prose, /<code>/, 'a code span that is only a reference renders as the chip');

// Unknown threads, fenced code, existing links, and look-alikes stay as written.
const inert = html(
  <MarkdownContent
    content={[
      '@thread:deadbeef-0000',
      '',
      '```',
      `@thread:${audit.id}`,
      '```',
      '',
      `[docs](https://example.com/@thread:${audit.id}) user@thread:${audit.id}`,
    ].join('\n')}
  />
);
assert.doesNotMatch(inert, /class="thread-reference"/);
assert.match(inert, /title="This thread isn&#x27;t available in Durango Code">@thread:deadbeef-0000</);

// User bubbles are plain text; their mention tokens are clickable too.
const user = html(<ThreadReferenceText text={`look at @${threadMentionToken(other)} please`} />);
assert.match(user, /^look at <button[^>]*class="thread-reference"[\s\S]*Find the App Optimization Thread[\s\S]*<\/button> please$/);
assert.equal(html(<ThreadReferenceText text="no refs here" />), 'no refs here');

// Durango chat references (@chat:<slug>-<chatId> or @chat:<chatId>) render
// as browser links, titled from chats seen in @-mention search results.
const { rememberDurangoChats, chatMentionToken } = await import('../src/app/durangoChats');
const chat = { id: 'jd7abc123chat', title: 'Billing rewrite plan', url: 'https://durango.sh/chats/p1?node=jd7abc123chat' };
rememberDurangoChats([chat]);
const chatProse = html(
  <MarkdownContent content={`See @chat:${chat.id}, \`@chat:${chat.id}\`, @chat:other-k57unknownchat and @thread:${audit.id}.`} />
);
assert.equal(chatProse.match(/class="thread-reference chat-reference"/g)?.length, 3);
assert.match(chatProse, /Open Durango chat &quot;Billing rewrite plan&quot; in your browser/);
assert.match(chatProse, />@chat:other-k57unknownchat</, 'unknown chats keep the token as their label');
assert.equal(chatProse.match(/class="thread-reference"/g)?.length, 1, 'thread chips are unaffected');
const fenced = html(<MarkdownContent content={['```', `@chat:${chat.id}`, '```', '', `mail@chat:${chat.id}`].join('\n')} />);
assert.doesNotMatch(fenced, /chat-reference/);
const chatUser = html(<ThreadReferenceText text={`compare @${chatMentionToken(chat)} with @${threadMentionToken(other)}`} />);
assert.match(chatUser, /^compare <button[^>]*chat-reference[\s\S]*Billing rewrite plan[\s\S]*<\/button> with <button[^>]*class="thread-reference"/);

console.log('thread reference tests passed');
