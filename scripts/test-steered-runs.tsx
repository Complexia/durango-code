// A message steered into a live run doesn't end the run on screen: the run's
// parts render under one header that keeps counting, nothing folds until the
// whole run is over, and the steered message shows sent, then seen.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentRunGroup, groupTranscriptRuns } from '../src/app/chat';
import { STEERED_RUN_CAPTION, type AgentActivity, type Message } from '../src/store';

const step = (id: string, fields: Partial<AgentActivity> = {}): AgentActivity => ({
  id,
  type: 'command',
  title: 'Command - node scripts/deploy.mjs',
  detail: 'node scripts/deploy.mjs --no-ci',
  status: 'done',
  ts: '2026-11-15T07:25:00.000Z',
  contentOffset: 0,
  ...fields,
});
const readNote = step('read', {
  key: 'steer-1',
  type: 'result',
  title: 'Read your message',
  detail: undefined,
});

const prompt: Message = { id: 'u1', role: 'user', content: 'release the desktop app', ts: '2026-11-15T07:24:00.000Z' };
// The part a steer closed (recordSteeredMessage in App.tsx).
const before: Message = {
  id: 'r1',
  role: 'agent',
  kind: 'agent-run',
  modelId: 'claude:claude-opus-5-5',
  status: 'done',
  statusText: STEERED_RUN_CAPTION,
  ts: '2026-11-15T07:24:01.000Z',
  startedAt: '2026-11-15T07:24:01.000Z',
  completedAt: '2026-11-15T07:29:19.000Z',
  content: 'Building 1.0.205.',
  activities: [step('s1', { contentOffset: 17 })],
};
const steer: Message = { id: 'u2', role: 'user', content: 'is it finished?', steer: true, ts: '2026-11-15T07:29:19.000Z' };
const after: Message = {
  id: 'r2',
  role: 'agent',
  kind: 'agent-run',
  modelId: 'claude:claude-opus-5-5',
  status: 'running',
  ts: '2026-11-15T07:29:19.000Z',
  startedAt: '2026-11-15T07:29:19.000Z',
  content: '',
  activities: [],
};
// The run as the transcript draws it: grouped from the whole thread.
const html = (parts: Message[], messages: Message[] = [prompt, ...parts], start = 0) => {
  const item = groupTranscriptRuns(messages, start).find((entry) => entry.kind === 'run');
  assert.ok(item && item.kind === 'run');
  return renderToStaticMarkup(
    <AgentRunGroup
      parts={item.parts}
      btwAsides={item.parts.map(() => undefined)}
      workSince={prompt.ts}
      liveRunId={item.parts.at(-1)!.id}
      steersRead={item.steersRead}
      reportsReads={item.reportsReads}
    />
  );
};

// --- Live after a steer: one run, still working ---------------------------------------------
const live = html([before, steer, after]);
assert.equal(live.match(/class="agent-run-header"/g)?.length, 1, 'one header for the whole run');
assert.match(live, /Working for/);
assert.doesNotMatch(live, /Worked for/, 'the part before the steer does not read as finished');
assert.doesNotMatch(live, /Steered — the agent continues below/);
assert.match(live, /Building 1\.0\.205\./, 'what came before the steer stays unfolded');
assert.match(live, /is it finished\?/);
assert.match(live, /message user steered/);
assert.match(live, /steer-receipt pending" role="status">.*Sent/s, 'the steered message shows it was sent');
assert.match(live, />Thinking</, 'the run keeps working below the message');
assert.ok(live.indexOf('Building') < live.indexOf('is it finished') && live.indexOf('is it finished') < live.indexOf('Thinking'));

// --- The agent read it: seen, and its "Read your message" step folds into the receipt -------
const read = html([before, steer, { ...after, content: 'No, not yet.', activities: [readNote] }]);
assert.match(read, /steer-receipt seen".*Seen/s);
assert.doesNotMatch(read, /Read your message/);

// The note can reach the transcript before the steer splits it (a question card the steer
// answered): it lands in the part above the message and still counts.
const early = html([{ ...before, activities: [...before.activities!, readNote] }, steer, after]);
assert.match(early, /steer-receipt seen/);
assert.doesNotMatch(early, /Read your message/);

// Two messages, one read so far: the first is seen, the second still pending.
const steer2: Message = { ...steer, id: 'u4', content: 'and the tag?' };
const twoSteers = html([before, steer, { ...after, id: 'r2a', status: 'done', statusText: STEERED_RUN_CAPTION, activities: [readNote] }, steer2, { ...after, id: 'r2b' }]);
assert.match(twoSteers, /is it finished\?.*steer-receipt seen.*and the tag\?.*steer-receipt pending/s);
// "Read your 2 messages" covers both.
const bothRead = html([before, steer, steer2, { ...after, activities: [{ ...readNote, title: 'Read your 2 messages' }] }]);
assert.equal(bothRead.match(/steer-receipt seen/g)?.length, 2);

// Drivers that don't report reads (Codex, fx): a plain "sent", never stuck on pending.
const codex = (message: Message): Message => ({ ...message, modelId: 'codex:gpt-6.1-sol' });
const codexLive = html([codex(before), steer, codex(after)]);
assert.match(codexLive, /steer-receipt sent".*Sent · the agent takes it in at its next step/s);
assert.doesNotMatch(codexLive, /steer-receipt-dot/);

// --- Over: the whole run folds as one, the steered message stays -----------------------------
const done = html([
  before,
  steer,
  {
    ...after,
    status: 'done',
    statusText: 'Finished.',
    completedAt: '2026-11-15T07:40:00.000Z',
    content: 'No, not yet.\n\nReleased 1.0.205.',
    activities: [readNote, step('s2', { contentOffset: 13 })],
  },
]);
assert.equal(done.match(/class="agent-run-header"/g)?.length, 1);
assert.match(done, /Worked for 16m/, 'counts from the prompt to the end of the last part');
assert.doesNotMatch(done, /Building 1\.0\.205\./, 'earlier parts fold with the run');
assert.doesNotMatch(done, /No, not yet\./, 'text before the last step folds');
assert.match(done, /Released 1\.0\.205\./, 'the final answer stays');
assert.match(done, /is it finished\?/, 'the steered message stays');
assert.doesNotMatch(done, /steer-receipt/, 'no receipt once the run is over');

// --- Stopped after a steer: the run's own outcome shows, not the steer caption ----------------
const stopped = html([before, steer, { ...after, status: 'stopped', statusText: 'Stopped.', completedAt: after.ts }]);
assert.match(stopped, /agent-status-line"><span>Stopped\./);
assert.doesNotMatch(stopped, /Steered — the agent continues below/);

// --- Grouping: a run gathers its steered messages and their parts -----------------------------
const next: Message = { id: 'u3', role: 'user', content: 'thanks', ts: '2026-11-15T07:41:00.000Z' };
const nextRun: Message = { ...after, id: 'r3', status: 'done', ts: '2026-11-15T07:41:01.000Z' };
const shape = (messages: Message[], start = 0) =>
  groupTranscriptRuns(messages, start).map((item) =>
    item.kind === 'run' ? item.parts.map((part) => part.id).join('+') : item.message.id
  );
assert.deepEqual(shape([prompt, before, steer, after, next, nextRun]), ['u1', 'r1+u2+r2', 'u3', 'r3']);
// Steered before the run showed output: the empty bubble moved below the message.
assert.deepEqual(shape([prompt, steer, after]), ['u1', 'u2+r2']);
// ... twice: both messages belong to the run.
assert.deepEqual(shape([prompt, steer, steer2, after]), ['u1', 'u2+u4+r2']);
// Older builds didn't flag steered messages; the caption of the part before marks them.
assert.deepEqual(shape([prompt, before, { ...steer, steer: undefined }, after]), ['u1', 'r1+u2+r2']);
// A plain follow-up after a finished run starts its own item.
assert.deepEqual(shape([prompt, { ...before, statusText: 'Finished.' }, next, nextRun]), ['u1', 'r1', 'u3', 'r3']);
// The transcript window can start inside the thread, or inside a run: the run keeps the key
// of its first message, so loading the earlier page doesn't remount what is on screen.
assert.deepEqual(shape([prompt, before, steer, after], 1), ['r1+u2+r2']);
assert.deepEqual(shape([prompt, before, steer, after], 2), ['u2+r2']);
const cut = groupTranscriptRuns([prompt, before, steer, after], 2)[0];
const whole = groupTranscriptRuns([prompt, before, steer, after], 0)[1];
assert.ok(cut.kind === 'run' && whole.kind === 'run');
assert.equal(cut.key, 'r1');
assert.equal(whole.key, 'r1');
// Reads count against the run's messages in order, including ones above the window.
const windowed = groupTranscriptRuns([prompt, before, steer, { ...after, id: 'r2a', status: 'done', statusText: STEERED_RUN_CAPTION, activities: [readNote] }, steer2, { ...after, id: 'r2b' }], 3)[0];
assert.ok(windowed.kind === 'run');
assert.deepEqual([windowed.parts.map((part) => part.id).join('+'), windowed.steersRead], ['r2a+u4+r2b', 0]);

console.log('steered run tests passed');
