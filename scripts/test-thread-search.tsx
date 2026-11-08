import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { Message, Thread, ThreadTranscript } from '../src/store';
import { summarizeThreadMessages } from '../src/thread-shell.js';

// Keep fixtures in memory: no app persistence or real thread data is touched.
// The store holds every thread's shell and only some transcripts; search
// scores loaded transcripts itself and asks main about the rest.
const state = {
  threads: [] as Thread[],
  transcripts: {} as Record<string, ThreadTranscript>,
  projects: [],
};
mock.module(new URL('../src/store.ts', import.meta.url).pathname, () => ({
  useOrionStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state,
  }),
}));

const searchRequests: string[][] = [];
const excerptRequests: Array<Array<{ id: string; tokens: string[] }>> = [];
let mainScores: Record<string, number[]> = {};
let mainExcerpts: Record<string, string | null> = {};
let warmups = 0;
globalThis.window = {
  orion: {
    searchThreads: async ({ tokens }: { tokens: string[] }) => {
      searchRequests.push(tokens);
      return { ok: true, tokens, scores: mainScores };
    },
    threadSearchExcerpts: async ({ items }: { items: Array<{ id: string; tokens: string[] }> }) => {
      excerptRequests.push(items);
      return { ok: true, excerpts: mainExcerpts };
    },
    warmThreadSearch: async () => {
      warmups += 1;
      return true;
    },
  },
  setTimeout,
  clearTimeout,
} as unknown as Window & typeof globalThis;

const {
  SidebarSearchPanel,
  compareThreadSearchResults,
  getThreadSearchEntry,
  getThreadSearchExcerpt,
  parseSearchQuery,
  releaseRemoteBodyScores,
  requestRemoteBodyScores,
  requestRemoteExcerpts,
  scoreThreadSearchEntry,
  warmSearchIndex,
} = await import('../src/app/threadSearch');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const makeThread = (id: string, ts: string, messages: Message[] = []): Thread => ({
  id, projectId: 'p', title: 'Review', modelId: 'm', status: 'idle',
  accessMode: 'read-only', createdAt: ts, summary: summarizeThreadMessages(messages),
});

let contentReads = 0;
const makeMessages = (index: number, count: number, ts: string): Message[] =>
  Array.from({ length: count }, (_, messageIndex) => ({
    id: String(messageIndex), role: 'user' as const, ts,
    get content() {
      contentReads += 1;
      return messageIndex === count - 1 ? `Latest excerpt ${index}` : 'Earlier transcript text';
    },
  }));

// 200 threads, all with loaded transcripts of 100 messages each.
const loadHistory = (count: number, messages: number) => {
  state.threads = [];
  state.transcripts = {};
  for (let index = 0; index < count; index += 1) {
    const ts = new Date(Date.UTC(2025, 0, index + 1)).toISOString();
    const transcript = { messages: makeMessages(index, messages, ts) };
    contentReads = 0;
    state.threads.push(makeThread(String(index), ts, transcript.messages));
    state.transcripts[String(index)] = transcript;
  }
  contentReads = 0;
};

loadHistory(200, 100);
const renderRecent = () => renderToString(
  <SidebarSearchPanel projects={[]} onSelectThread={() => {}} onSelectProject={() => {}} />
);
const html = renderRecent();
assert.equal((html.match(/role="option"/g) ?? []).length, 12);
assert.equal(contentReads, 12, 'empty search reads only the displayed excerpts, not all 20,000 messages');
assert.ok(html.indexOf('Latest excerpt 199') < html.indexOf('Latest excerpt 198'));
assert.ok(!html.includes('Latest excerpt 187'), 'recent results are capped before transcript access');
// A later populated search must still index a thread displayed as a recent result.
const recentEntry = getThreadSearchEntry(state.threads[199], 'Example', '/example');
assert.ok(scoreThreadSearchEntry(recentEntry, 'earlier transcript') > 0);
assert.equal(recentEntry.body?.length, 100, 'summary entries must not pollute the full index cache');

const oldTs = new Date(Date.now() - 90 * 86400000).toISOString();
const newerTs = new Date(Date.now() - 30 * 86400000).toISOString();
const matches = Array.from({ length: 41 }, (_, index) => {
  const thread = makeThread(String(index), oldTs);
  // Terminal activity must count even without a newer chat message.
  if (index === 40) thread.terminalActivityAt = newerTs;
  const entry = getThreadSearchEntry(thread, 'Example', '/example');
  return { entry, score: scoreThreadSearchEntry(entry, 'review') };
});
assert.ok(matches.every(({ score }) => score === matches[0].score), 'fixture scores tie after recency bonuses expire');
const ranked = matches.sort(compareThreadSearchResults).slice(0, 40);
assert.equal(ranked[0].entry.thread.id, '40', 'most recently active match survives the result cap');
assert.ok(compareThreadSearchResults({ ...ranked[1], score: 200 }, ranked[0]) < 0, 'relevance still wins over recency');

// Threads whose transcript isn't loaded: their body scores and excerpts come
// from main, never from transcripts the renderer would have to load.
state.threads = [makeThread('cold', oldTs), makeThread('cold-miss', oldTs), makeThread('warm', oldTs)];
state.transcripts = {
  warm: { messages: [{ id: 'w', role: 'agent', ts: oldTs, content: 'The flaky migration again' }] },
};
const coldEntry = getThreadSearchEntry(state.threads[0], 'Example', '/example');
const coldMissEntry = getThreadSearchEntry(state.threads[1], 'Example', '/example');
const warmEntry = getThreadSearchEntry(state.threads[2], 'Example', '/example');
assert.equal(coldEntry.body, null, 'an unloaded transcript has no local index');
assert.equal(scoreThreadSearchEntry(coldEntry, 'migration'), 0, 'no transcript score before main answers');
assert.ok(scoreThreadSearchEntry(warmEntry, 'migration') > 0, 'a loaded transcript is scored locally');

mainScores = { cold: [18] };
requestRemoteBodyScores(['migration']);
requestRemoteBodyScores(['migration']);
await settle();
assert.deepEqual(searchRequests, [['migration']], 'one request per token while it is fresh');
assert.ok(scoreThreadSearchEntry(coldEntry, 'migration') > 0, "main's transcript match counts");
assert.equal(scoreThreadSearchEntry(coldMissEntry, 'migration'), 0, 'threads main did not match stay out');
assert.equal(scoreThreadSearchEntry(coldEntry, 'migration missing'), 0, 'every word must match somewhere');

const query = parseSearchQuery('migration');
assert.equal(getThreadSearchExcerpt(coldEntry, query), '/example', 'the project path stands in until main answers');
mainExcerpts = { cold: '…the migration failed on CI' };
requestRemoteExcerpts([{ threadId: 'cold', tokens: ['migration'] }]);
await settle();
assert.deepEqual(excerptRequests, [[{ id: 'cold', tokens: ['migration'] }]]);
assert.equal(getThreadSearchExcerpt(coldEntry, query), '…the migration failed on CI');
assert.equal(getThreadSearchExcerpt(warmEntry, query), 'The flaky migration again', 'loaded excerpts stay local');

// Typing on while a request is in flight: main supersedes the older scan, so
// the newer request carries every token the search still lacks, and a
// superseded request is never re-asked (no loops).
const inFlight: Array<{ tokens: string[]; resolve: (value: unknown) => void }> = [];
(window.orion as unknown as { searchThreads: unknown }).searchThreads = ({ tokens }: { tokens: string[] }) =>
  new Promise((resolve) => inFlight.push({ tokens, resolve }));
requestRemoteBodyScores(['react', 'ho'], 'panel');
requestRemoteBodyScores(['react', 'hoo'], 'panel');
assert.deepEqual(
  inFlight.map((request) => request.tokens),
  [['react', 'ho'], ['react', 'hoo']],
  'the newer request carries "react", still unanswered'
);
inFlight[0].resolve({ ok: false, superseded: true });
inFlight[1].resolve({ ok: true, tokens: ['react', 'hoo'], scores: { cold: [18, 8] } });
await settle();
assert.ok(scoreThreadSearchEntry(coldEntry, 'react') > 0, '"react" is scored although its first request was superseded');
assert.equal(inFlight.length, 2, 'nothing was asked again');
releaseRemoteBodyScores('panel');

// Scores map onto the tokens main says it scored. An over-long pasted path
// isn't asked for at all; a token main skips anyway (e.g. past its limit of
// 16) neither shifts the others' scores nor is recorded as "no match".
inFlight.length = 0;
requestRemoteBodyScores(['/' + 'x'.repeat(250), 'alpha', 'deploy'], 'paste');
assert.deepEqual(inFlight[0].tokens, ['alpha', 'deploy'], 'the over-long token is not sent');
inFlight[0].resolve({ ok: true, tokens: ['deploy'], scores: { cold: [18] } });
await settle();
assert.ok(scoreThreadSearchEntry(coldEntry, 'deploy') > 0, 'the scored word gets its own scores');
releaseRemoteBodyScores('paste');
requestRemoteBodyScores(['alpha'], 'paste-again');
assert.equal(inFlight.length, 2, 'the word main skipped was not cached as "no match": it is asked again');
assert.deepEqual(inFlight[1].tokens, ['alpha']);
inFlight[1].resolve({ ok: true, tokens: ['alpha'], scores: {} });
await settle();
releaseRemoteBodyScores('paste-again');

// Warming search before the first keystroke goes to main once per window.
warmSearchIndex();
warmSearchIndex();
await settle();
assert.equal(warmups, 1, 'hover/focus share one warmup');

console.log('Thread search regression checks passed.');
