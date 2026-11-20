import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { create } from 'zustand';

import type { Thread } from '../src/store';

// Changes and threads named in bot replies render as chips with their titles
// (src/app/botRefs.tsx); ids nothing resolves stay as the bot wrote them.

const here = { id: '3fff374b-2675-4bdd-be1a-3236df5c6415', title: 'Fix sidebar dots', projectId: 'p', messages: [] } as unknown as Thread;
const elsewhereId = '6a45b7ad-417d-429d-b47a-b0521d3a0c78';
const unknownId = '0b1c2d3e-4f5a-4b6c-8d9e-0f1a2b3c4d5e';
const change = 'chg_vydj323rliixemtqg74d';
const landed = 'chg_qv5aox2sz7wuejk5vhyc';
const missing = 'chg_aaaaaaaaaaaaaaaaaaaa';

// A thread whose UUID starts like the tail of an unknown id, and two mirrors of other machines' threads.
const lookalike = { id: 'deadbeef-1111-4222-8333-444455556666', title: 'Lookalike', projectId: 'p', messages: [] } as unknown as Thread;
const mirrored = { id: 'mirror-1', title: 'On omarchy', projectId: 'p', messages: [], remote: { threadId: 'host-thread-1' } } as unknown as Thread;
const twinA = { id: 'mirror-2', title: 'Twin A', projectId: 'p', messages: [], remote: { threadId: 'host-twin' } } as unknown as Thread;
const twinB = { id: 'mirror-3', title: 'Twin B', projectId: 'p', messages: [], remote: { threadId: 'host-twin' } } as unknown as Thread;

// The store, with thread loading the test finishes by hand (onAllThreadsLoaded).
let threadsLoaded = false;
const loadedListeners = new Set<() => void>();
const selected: string[] = [];
const useOrionStore = create(() => ({
  threads: [here, lookalike, mirrored, twinA, twinB],
  sidebarTab: 'threads',
  selectThread: (id: string) => selected.push(id),
  openThreadInSplit: (id: string) => selected.push(`split:${id}`),
  setSettingsOpen: () => {},
  setActiveTab: () => {},
  setSidebarV3Settings: () => {},
}));
mock.module('../src/store', () => ({
  useOrionStore,
  onAllThreadsLoaded: (listener: () => void) => {
    if (threadsLoaded) {
      listener();
      return () => {};
    }
    loadedListeners.add(listener);
    return () => loadedListeners.delete(listener);
  },
}));
const toasts: string[] = [];
mock.module('sonner', () => ({ toast: { error: (message: string) => toasts.push(message) } }));

const asked: { changes: string[]; threads: string[] }[] = [];
// What Durango answers next (tests change it to see revalidation); null = the lookup fails.
let answer: { changes: Record<string, unknown>; threads: Record<string, unknown> } | null = {
  changes: {
    [change]: { title: 'Bots: every bot on Opus 5.5', status: 'open', url: `https://durango.sh/source/durango/monorepo/changes/${change}` },
    [landed]: { title: 'Open changes', status: 'landed', url: `https://durango.sh/source/durango/monorepo/changes/${landed}` },
  },
  threads: { [elsewhereId]: { title: 'Release on omarchy' }, t_42: { title: 'Underscored thread' } },
};
(globalThis as { window?: unknown }).window = {
  orion: {
    botRefs: async (input: { changes: string[]; threads: string[] }) => {
      asked.push(input);
      if (!answer) return { ok: false, error: 'offline' };
      return { ok: true, ...answer };
    },
  },
};

const { MarkdownContent, StreamingMarkdownContent } = await import('../src/app/markdown');
const { listenForThreadLinks } = await import('../src/app/botRefLinks');
const { requestBotRef, findBotRefs, threadForLink, botRefFromAnswer, botRefTiming, watchBotRef, readBotRef } = await import(
  '../src/app/botRefs'
);

// Batches go out sooner here than in the app (where an id still streaming in is replaced first).
botRefTiming.batchDelayMs = 20;

// Titles load in one batch.
for (const id of [change, landed, missing]) requestBotRef('change', id);
for (const id of [elsewhereId, unknownId, 't_42']) requestBotRef('thread', id);
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(asked.length, 1, 'one request for the batch');
assert.deepEqual(asked[0].changes.sort(), [change, landed, missing].sort());

const html = (content: string, refLinks = true) => renderToStaticMarkup(<MarkdownContent content={content} refLinks={refLinks} />);

const reply = html(
  [
    `Opened \`${change}\` (landed: ${landed}) in \`${here.id}\`; the release ran in @thread:${elsewhereId}.`,
    '',
    `Unknown: \`${missing}\`, ${unknownId}, @thread:deadbeef-0000.`,
    '',
    '```',
    change,
    '```',
  ].join('\n')
);
assert.match(reply, /<button[^>]*class="thread-reference change-reference"[^>]*title="chg_vydj323rliixemtqg74d · Open · open its page"[\s\S]*?<span>Bots: every bot on Opus 5.5<\/span><\/button>/);
assert.match(reply, /title="chg_qv5aox2sz7wuejk5vhyc · Merged · open its page"[\s\S]*?<span>Open changes<\/span>/);
assert.match(reply, /<button[^>]*class="thread-reference"[^>]*>[\s\S]*?<span>Fix sidebar dots<\/span><\/button>/, 'a thread here opens in the app');
assert.match(reply, /<span class="thread-reference is-elsewhere" title="&quot;Release on omarchy&quot; is on another computer">/);
assert.match(reply, /<code>chg_aaaaaaaaaaaaaaaaaaaa<\/code>/, 'an unknown change stays as written');
assert.match(reply, new RegExp(`, ${unknownId}, `), 'an unknown bare id stays text');
assert.match(reply, /@thread:deadbeef-0000/);
assert.match(reply, /<pre[\s\S]*chg_vydj323rliixemtqg74d/, 'code blocks are left alone');
assert.equal(reply.match(/class="thread-reference/g)?.length, 4);

// An agent's message in a normal thread (streamed or stored) gets the same links.
const agent = renderToStaticMarkup(
  <StreamingMarkdownContent content={`Done. Ship this in 1.0.219 with ${change} and ${missing}; details in ${here.id}.`} refLinks />
);
assert.match(agent, /class="thread-reference change-reference"[\s\S]*?<span>Bots: every bot on Opus 5.5<\/span>/);
assert.match(agent, /<span>Fix sidebar dots<\/span>/);
assert.match(agent, new RegExp(` and ${missing};`), 'an unknown change stays as written');
assert.doesNotMatch(renderToStaticMarkup(<StreamingMarkdownContent content={`with ${change}`} />), /thread-reference/, 'off unless asked for');

// Outside bot replies nothing changes: ids stay as written.
const thread = html(`Opened \`${change}\` in ${elsewhereId}.`, false);
assert.doesNotMatch(thread, /thread-reference/);

// The finder skips ids inside paths and longer words.
assert.deepEqual(findBotRefs(`/tmp/${here.id}/a.png x${change} ${change}_old`), []);

// Whole tokens only: file names, Windows paths and longer ids are never cut into a ref plus a rest.
assert.deepEqual(findBotRefs(`${change}.md notes/${change} C:\\work\\${change} ${change}\\x ${here.id}.log`), []);
assert.deepEqual(
  findBotRefs(`Done: ${change}. See @thread:t_42, (${here.id})`).map(({ kind, id }) => `${kind}:${id}`),
  [`change:${change}`, 'thread:t_42', `thread:${here.id}`],
  'sentence punctuation still ends a ref'
);
const tokens = html(`Wrote \`${change}.md\` and ${change}.md; ran in @thread:t_42.`);
assert.doesNotMatch(tokens, /change-reference/, 'a file named after a change stays text');
assert.match(tokens, /<code>chg_vydj323rliixemtqg74d\.md<\/code>/);
assert.match(tokens, /<span>Underscored thread<\/span>/, '@thread:t_42 is one ref, not @thread:t');
assert.doesNotMatch(tokens, /_42/, 'nothing of the id is left over');
// Outside bot replies the older matcher no longer cuts a longer token either.
assert.doesNotMatch(html('see @thread:t_42 and @thread:notes.md', false), /thread-reference/);

// An inherited property name is never a title (`constructor`), and a title must be text.
assert.equal(botRefFromAnswer({ changes: {}, threads: {} }, 'thread', 'constructor'), null);
assert.equal(botRefFromAnswer({ changes: {}, threads: { x: { title: '  ' } } }, 'thread', 'x'), null);
assert.equal(botRefFromAnswer({ changes: { [change]: { title: 'T' } }, threads: {} } as never, 'change', change), null);
assert.deepEqual(botRefFromAnswer({ changes: {}, threads: { x: { title: 'T' } } }, 'thread', 'x'), { title: 'T' });
requestBotRef('thread', 'constructor');
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(readBotRef('thread', 'constructor'), null);
assert.doesNotMatch(html('see @thread:constructor'), /thread-reference/, 'an unknown @thread:constructor stays text');

console.log('bot ref tests passed');

// orion://thread links open only the exact thread: this computer's id, or one mirror's id on its own machine.
const ids = (id: string) => threadForLink(id, useOrionStore.getState().threads)?.id ?? null;
assert.equal(ids(here.id), here.id);
assert.equal(ids(here.id.toUpperCase()), here.id);
assert.equal(ids('host-thread-1'), 'mirror-1', "another machine's id for its one mirror");
assert.equal(ids('fix-something-deadbeef'), null, 'an unknown id ending in a known id fragment opens nothing');
assert.equal(ids('deadbeef'), null, 'nor does a bare fragment');
assert.equal(ids('host-twin'), null, 'an ambiguous mirror id opens nothing');

// A link that launched the app waits for the thread list before it is taken.
let pending: string | null = here.id;
let takes = 0;
let push: ((id: string) => void) | null = null;
const stopLinks = listenForThreadLinks({
  takeThreadOpenRequest: async () => {
    takes += 1;
    const id = pending;
    pending = null;
    return id;
  },
  onThreadOpenRequest: (callback) => {
    push = callback;
    return () => {
      push = null;
    };
  },
});
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(takes, 0, 'not taken before the threads load');
assert.deepEqual(toasts, []);
threadsLoaded = true;
for (const listener of [...loadedListeners]) listener();
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(takes, 1);
assert.deepEqual(selected, [here.id], 'the thread on disk opens');
// Later links open at once; an unknown one says so and opens nothing else.
pending = 'fix-something-deadbeef';
push!(pending);
await new Promise((resolve) => setTimeout(resolve, 10));
assert.deepEqual(selected, [here.id]);
assert.deepEqual(toasts, ["That thread isn't on this computer."]);
stopLinks();
assert.equal(push, null);
console.log('thread link opening tests passed');

// Refs on screen are asked again when they expire: a thread that synced after a miss gets its title,
// a failed lookup keeps the title, and an answer without the ref drops it.
botRefTiming.missingTtlMs = 60;
botRefTiming.foundTtlMs = 60;
botRefTiming.minRevalidateDelayMs = 10;
const late = '7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const lookups = () => asked.filter((input) => input.threads.includes(late)).length;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const unwatch = watchBotRef('thread', late);
await wait(50);
assert.equal(lookups(), 1);
assert.equal(readBotRef('thread', late), null, 'not synced yet');
answer = { changes: {}, threads: { [late]: { title: 'Synced later' } } };
await wait(200);
assert.deepEqual(readBotRef('thread', late), { title: 'Synced later' }, 'asked again after the miss expired');
answer = null;
await wait(200);
assert.deepEqual(readBotRef('thread', late), { title: 'Synced later' }, 'a failed lookup keeps the title');
answer = { changes: {}, threads: {} };
await wait(200);
assert.equal(readBotRef('thread', late), null, 'a server miss drops it');
unwatch();
await wait(50);
const afterUnwatch = lookups();
await wait(200);
assert.equal(lookups(), afterUnwatch, 'refs off screen are not asked again');
console.log('bot ref revalidation tests passed');

// An id still streaming in is replaced on screen before its batch goes out: only the whole id is asked for.
const whole = 'chg_whndaj4mkfvhjum737mz';
const before = asked.length;
const unwatchPartial = watchBotRef('change', whole.slice(0, 14));
unwatchPartial();
const unwatchWhole = watchBotRef('change', whole);
await wait(60);
const sent = asked.slice(before).flatMap((input) => input.changes);
assert.deepEqual(sent, [whole], 'the partial id is never asked for');
unwatchWhole();
console.log('streaming id tests passed');

// Markdown links to a ref (`[name](@thread:<id>)`, `[name](chg_…)`) open it, in bot replies and agents' messages alike.
const linked = renderToStaticMarkup(
  <StreamingMarkdownContent content={`Open [the sidebar thread](@thread:${here.id}) and [the change](${change}); [docs](https://example.com) stay links.`} refLinks />
);
assert.match(linked, /<button[^>]*class="thread-reference"[^>]*>[\s\S]*?<span>Fix sidebar dots<\/span><\/button>/, 'a markdown link to @thread opens the thread');
assert.match(linked, /class="thread-reference change-reference"[\s\S]*?<span>Bots: every bot on Opus 5.5<\/span>/, 'a markdown link to a change opens it');
assert.match(linked, /<a href="https:\/\/example.com"/);
assert.doesNotMatch(linked, /href=""/, 'no dead links');
// An unknown thread in that form keeps its label as text.
assert.match(html(`[Old thread](@thread:deadbeef-0000)`), />Old thread</);
// `See:@thread:<id>` still links, as it did before agents' messages moved to this matcher.
assert.match(html(`See:@thread:${here.id}`), /<span>Fix sidebar dots<\/span>/);
assert.deepEqual(findBotRefs(`see:${change} x:${here.id}`), [], 'other refs after a colon stay text');
console.log('markdown link ref tests passed');

// A ref asked for outright is never dropped when a batch is full.
{
  const before = asked.length;
  const many = Array.from({ length: 50 }, (_, index) => `chg_full${String(index).padStart(8, '0')}`);
  const stops = many.map((id) => watchBotRef('change', id));
  const extra = 'chg_explicit0000000000';
  requestBotRef('change', extra);
  await wait(120);
  const sent = asked.slice(before).flatMap((input) => input.changes);
  assert.ok(sent.includes(extra), 'sent in the next batch');
  assert.equal(new Set(sent).size, 51, 'all 50 watched plus the one asked for');
  for (const stop of stops) stop();
  console.log('batch limit tests passed');
}

// orion://thread/<id> links (the web's thread links) name a thread id, nothing else.
const { threadOpenLinkId } = await import('../src/main/thread-links.js');
assert.equal(threadOpenLinkId(`orion://thread/${here.id}`, 'orion'), here.id);
assert.equal(threadOpenLinkId(`orion://thread/${here.id}/`, 'orion'), here.id);
assert.equal(threadOpenLinkId('orion://thread/../etc', 'orion'), null);
assert.equal(threadOpenLinkId('orion://theme/install?slug=abc', 'orion'), null);
assert.equal(threadOpenLinkId(`https://thread/${here.id}`, 'orion'), null);
console.log('thread link tests passed');
