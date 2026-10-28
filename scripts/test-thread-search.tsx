import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { Thread } from '../src/store';

// Keep fixtures in memory: no app persistence or real thread data is touched.
const state = { threads: [] as Thread[], projects: [] };
mock.module(new URL('../src/store.ts', import.meta.url).pathname, () => ({
  useOrionStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state,
  }),
}));
const {
  SidebarSearchPanel,
  compareThreadSearchResults,
  getThreadSearchEntry,
  scoreThreadSearchEntry,
  warmSearchIndex,
} = await import('../src/app/threadSearch');

const makeThread = (id: string, ts: string): Thread => ({
  id, projectId: 'p', title: 'Review', modelId: 'm', status: 'idle',
  accessMode: 'read-only', createdAt: ts, messages: [],
});

let contentReads = 0;
const makeHistory = (count: number, messages: number) => Array.from({ length: count }, (_, index) => ({
  ...makeThread(String(index), new Date(Date.UTC(2025, 0, index + 1)).toISOString()),
  messages: Array.from({ length: messages }, (_, messageIndex) => ({
    id: String(messageIndex), role: 'user' as const,
    ts: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    get content() {
      contentReads += 1;
      return messageIndex === messages - 1 ? `Latest excerpt ${index}` : 'Earlier transcript text';
    },
  })),
}));

state.threads = makeHistory(200, 100);
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
assert.equal(recentEntry.body.length, 100, 'summary entries must not pollute the full index cache');

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

// Exercise both schedulers with a long thread, ensuring work yields between
// messages, respects exhausted idle budgets, and coalesces hover/focus calls.
for (const idleAvailable of [true, false]) {
  state.threads = makeHistory(1, 200);
  contentReads = 0;
  const callbacks: Array<(deadline?: { timeRemaining: () => number }) => void> = [];
  globalThis.window = {
    ...(idleAvailable ? { requestIdleCallback: (callback: typeof callbacks[number]) => callbacks.push(callback) } : {}),
    setTimeout: (callback: typeof callbacks[number]) => callbacks.push(callback),
  } as unknown as Window & typeof globalThis;
  warmSearchIndex();
  warmSearchIndex();
  assert.equal(callbacks.length, 1, 'hover/focus share one pending pass');
  assert.equal(contentReads, 0, 'scheduling does not synchronously index transcripts');
  callbacks.shift()!({ timeRemaining: () => 0 });
  assert.ok(contentReads > 0 && contentReads < 200, 'one callback cannot consume an entire long thread');
  if (idleAvailable) assert.equal(contentReads, 1, 'an expired idle budget yields after making progress');
  let slices = 1;
  while (callbacks.length) {
    assert.ok(slices++ < 300, 'warmup must complete');
    callbacks.shift()!({ timeRemaining: () => 10 });
  }
  assert.equal(contentReads, 200, 'every message is warmed once');
  getThreadSearchEntry(state.threads[0], 'Unknown project', '');
  assert.equal(contentReads, 200, 'completed warmup fills the shared thread cache');
  warmSearchIndex();
  while (callbacks.length) callbacks.shift()!({ timeRemaining: () => 10 });
  assert.equal(contentReads, 200, 'repeated warmup reuses unchanged entries');
}

console.log('Thread search regression checks passed.');
