import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  activityAction,
  activityLabel,
  liveThoughtPreview,
  partitionLiveActivities,
  summarizeActivities,
} from '../src/app/activity';
import { ChatMessage } from '../src/app/chat';
import { createReasoningStream } from '../src/main/reasoning-stream.js';
import type { AgentActivity, Message } from '../src/store';

const step = (id: string, fields: Partial<AgentActivity>): AgentActivity => ({
  id,
  type: 'tool',
  title: 'Tool - Read',
  status: 'done',
  ts: `2026-10-28T05:00:0${id.length % 10}.000Z`,
  ...fields,
});

const command = step('c1', { type: 'command', title: 'Command - git status', detail: 'git status --short', output: ' M a.ts' });
const read = step('r1', { title: 'Tool - Read', detail: '/Users/me/projects/durango/code/src/app/activity.tsx' });
const read2 = step('r2', { title: 'Tool - Read', detail: 'src/store.ts' });
const edit = step('e1', { title: 'Tool - Edit', detail: 'src/app/chat.tsx', diff: { path: 'src/app/chat.tsx', additions: 4, deletions: 2 } });
const mcp = step('m1', { title: 'Tool - mcp__orion__read_thread', detail: '{"thread_id":"x"}' });
const notice = step('n1', { title: 'Background task completed', detail: 'desktop release' });

// --- Labels: one line saying what the step did ---------------------------------------------
assert.deepEqual(activityLabel(command), { text: 'git status --short', code: true });
assert.equal(activityLabel(read).text, 'Read …/src/app/activity.tsx', 'long paths keep their tail');
assert.equal(activityLabel(read2).text, 'Read src/store.ts');
assert.equal(activityLabel(edit).text, 'Edited src/app/chat.tsx');
assert.equal(activityLabel(mcp).text, 'Read thread · orion', 'MCP calls read as their tool, without the JSON input');
assert.equal(activityLabel(notice).text, 'Background task completed · desktop release');
assert.equal(activityAction(notice), 'update');
// ACP drivers (Antigravity, Kimi, Grok) emit `kind` + `"Edit file - <path>"` instead of `"Tool - Edit"`.
assert.equal(
  activityLabel(
    step('acp-edit', {
      kind: 'edit',
      title: 'Edit file - /Users/me/.durango/ws/durango/chat-multi-message/chat/andromedus/components/chat/chat-composer.tsx',
      detail: '/Users/me/.durango/ws/durango/chat-multi-message/chat/andromedus/components/chat/chat-composer.tsx',
    })
  ).text,
  'Edited …/components/chat/chat-composer.tsx',
  'ACP file edits shorten long paths instead of duplicating them'
);
assert.equal(
  activityLabel(
    step('acp-read', {
      kind: 'read',
      title: 'Read file - /Users/me/.durango/ws/durango/chat-multi-message/chat/andromedus/lib/chat/follow-ups.ts',
      detail: '/Users/me/.durango/ws/durango/chat-multi-message/chat/andromedus/lib/chat/follow-ups.ts',
    })
  ).text,
  'Read …/lib/chat/follow-ups.ts',
  'ACP file reads shorten long paths instead of duplicating them'
);
assert.equal(
  activityLabel(
    step('acp-search', {
      kind: 'search',
      title: 'Search - followUpQueue',
      detail: 'followUpQueue',
    })
  ).text,
  'Search · followUpQueue',
  'ACP titles embedding detail do not repeat detail twice'
);

// --- Summaries: the two weightiest kinds, in order -----------------------------------------
assert.equal(summarizeActivities([command]), 'Ran 1 command');
assert.equal(summarizeActivities([read, command, read2]), 'Read 2 files and ran 1 command');
assert.equal(summarizeActivities([command, edit, read, mcp]), 'Ran 1 command, changed 1 file, and performed 2 other actions');
assert.equal(summarizeActivities([step('t1', { type: 'thought', title: 'Thinking', detail: 'hmm' })]), 'Thought');

// --- A finished turn: steps fold into one summary line between the agent's text ------------
const done: Message = {
  id: 'run-done',
  role: 'agent',
  kind: 'agent-run',
  status: 'done',
  ts: '2026-10-28T05:00:00.000Z',
  startedAt: '2026-10-28T05:00:00.000Z',
  completedAt: '2026-10-28T05:01:10.000Z',
  content: 'Checking the tree:\n\nAll clean.',
  activities: [
    { ...read, contentOffset: 18 },
    { ...read2, contentOffset: 18 },
    { ...command, contentOffset: 18 },
  ],
};
const doneHtml = renderToStaticMarkup(<ChatMessage message={done} runRunning={false} />);
assert.match(doneHtml, /Worked for/);

// --- A live turn: earlier steps stay put, the running step takes Thinking's place ------------
const live: Message = {
  ...done,
  id: 'run-live',
  status: 'running',
  completedAt: undefined,
  content: 'Checking the tree:\n\n',
  activities: [
    { ...read, contentOffset: 20 },
    { ...command, contentOffset: 20, status: 'running', output: undefined },
  ],
};
const liveHtml = renderToStaticMarkup(<ChatMessage message={live} runRunning />);
assert.match(liveHtml, /work-row-label code live">git status --short/, 'the running step shimmers');
assert.match(liveHtml, /Read …\/src\/app\/activity\.tsx/, 'the step before it stays where it was');
assert.doesNotMatch(liveHtml, />Thinking</, 'the running step replaces the Thinking line');

// Between steps the recent steps stay visible and Thinking ends the column; when the next
// step starts it swaps in for Thinking without flashing the recent rows closed.
const between: Message = {
  ...live,
  id: 'run-between',
  activities: [{ ...read, contentOffset: 20 }, { ...read2, contentOffset: 20 }, { ...command, contentOffset: 20 }],
};
const betweenHtml = renderToStaticMarkup(<ChatMessage message={between} runRunning />);
assert.match(betweenHtml, /Read …\/src\/app\/activity\.tsx/, 'recent steps stay visible between calls');
assert.match(betweenHtml, /git status --short/, 'most recent command stays visible');
assert.match(betweenHtml, /<div class="agent-steps">.*git status --short.*>Thinking<\/span><\/span><\/div><\/div>/s, 'Thinking ends the steps column');
const nextStep = renderToStaticMarkup(
  <ChatMessage message={{ ...between, activities: [...between.activities!, { ...command, id: 'c2', contentOffset: 20, status: 'running', output: undefined }] }} runRunning />
);
assert.match(nextStep, /Read …\/src\/app\/activity\.tsx/, 'recent steps stay visible while the next step runs');
assert.match(nextStep, /work-row-label code live">git status --short/, 'next running step shimmers');
assert.doesNotMatch(nextStep, />Thinking</);

// --- Long live tool-only run (e.g. Antigravity): summary + 4 recent actions + live thought ---
const thoughtDone = step('th0', { type: 'thought', title: 'Reasoning', detail: 'Earlier thought.', status: 'done' });
const thoughtLive = step('th1', {
  type: 'thought',
  title: 'Reasoning',
  status: 'running',
  detail: [
    'Initial inspection of backend files.',
    'Checking the turn settlement hook and remote sync effect.',
    'Verifying follow-up messages drain cleanly when the stream settles.',
    'Next: run the chat follow-ups test suite.',
  ].join('\n'),
});
const longActivities: AgentActivity[] = [
  thoughtDone,
  { ...read, id: 'old-r1', contentOffset: 0 },
  { ...read2, id: 'old-r2', contentOffset: 0 },
  { ...command, id: 'old-c1', detail: 'rg -n followUp chat/', contentOffset: 0 },
  { ...edit, id: 'rec-e1', detail: 'chat/andromedus/lib/chat/follow-ups.ts', diff: { path: 'chat/andromedus/lib/chat/follow-ups.ts', additions: 18, deletions: 4 }, contentOffset: 0 },
  { ...edit, id: 'rec-e2', detail: 'chat/andromedus/components/chat/chat-composer.tsx', diff: { path: 'chat/andromedus/components/chat/chat-composer.tsx', additions: 42, deletions: 11 }, contentOffset: 0 },
  { ...read, id: 'rec-r3', detail: 'chat/andromedus/components/chat/chat-thread.tsx', contentOffset: 0 },
  { ...command, id: 'rec-c2', detail: 'bun test chat/andromedus/lib/chat/follow-ups.test.ts', contentOffset: 0 },
  thoughtLive,
];

const partition = partitionLiveActivities(longActivities);
assert.equal(partition.hasOlderSteps, true);
assert.equal(partition.older.length, 4, 'older includes earlier tools and completed thoughts');
assert.deepEqual(
  partition.recentTools.map((a) => a.id),
  ['rec-e1', 'rec-e2', 'rec-r3', 'rec-c2'],
  'keeps the last 4 tool steps visible in chronological order'
);
assert.equal(partition.activeThought?.id, 'th1');

// Waiting-for-approval steps are never hidden behind the collapsed summary.
const waitingStep = step('w1', { type: 'command', title: 'Command - rm -rf tmp', detail: 'rm -rf tmp', status: 'waiting' });
const withWaiting = partitionLiveActivities([waitingStep, ...longActivities.slice(1, 8)]);
assert.ok(withWaiting.recentTools.some((a) => a.id === 'w1'), 'waiting step stays visible');

// Parallel running burst is capped cleanly at 4 live rows.
const parallelRunning = Array.from({ length: 10 }, (_, i) =>
  step(`p${i}`, { title: 'Tool - Edit', detail: `src/f${i}.ts`, status: 'running' })
);
assert.equal(partitionLiveActivities(parallelRunning).recentTools.length, 4);

// liveThoughtPreview keeps the latest 3 non-empty lines with leading ellipsis when truncated.
assert.equal(liveThoughtPreview(''), '');
assert.equal(liveThoughtPreview('Short check'), 'Short check');
assert.equal(
  liveThoughtPreview('Line 1\n\nLine 2\nLine 3\nLine 4'),
  '…Line 2\nLine 3\nLine 4'
);
const longPara = `${'word '.repeat(90)}final sentence here.`;
const previewed = liveThoughtPreview(longPara);
assert.ok(previewed.startsWith('…'), 'long single paragraph shows tail with leading ellipsis');
assert.ok(previewed.endsWith('final sentence here.'), 'tail preserves the newest words');
assert.ok(previewed.length <= 310);

const longLiveRun: Message = {
  id: 'run-agy-live',
  role: 'agent',
  kind: 'agent-run',
  status: 'running',
  ts: '2026-10-28T05:00:00.000Z',
  startedAt: '2026-10-28T05:00:00.000Z',
  content: '',
  activities: longActivities,
};
const longLiveHtml = renderToStaticMarkup(<ChatMessage message={longLiveRun} runRunning />);
assert.match(longLiveHtml, /Read 2 files and ran 1 command/, 'older steps fold into the summary line above the live trail');
assert.match(longLiveHtml, /Edited chat\/andromedus\/lib\/chat\/follow-ups\.ts/, 'recent edit stays visible live');
assert.match(longLiveHtml, /Edited …\/components\/chat\/chat-composer\.tsx/, 'long recent edit path keeps its tail');
assert.match(longLiveHtml, /bun test chat\/andromedus\/lib\/chat\/follow-ups\.test\.ts/, 'recent command stays visible live');
assert.match(longLiveHtml, /work-row-label live">Thinking/, 'live thought header shimmers');
assert.match(longLiveHtml, /work-row-thought-live">…Checking the turn settlement hook/, 'live thought shows multi-line tail preview');

// Once finished, the whole stretch folds back into a single compact summary line.
const longDoneHtml = renderToStaticMarkup(
  <ChatMessage message={{ ...longLiveRun, status: 'done', completedAt: '2026-10-28T05:20:00.000Z', content: 'All done.' }} runRunning={false} />
);
assert.doesNotMatch(longDoneHtml, /work-row-thought-live/, 'finished run folds away live thought preview');
assert.doesNotMatch(longDoneHtml, /Edited chat\/andromedus\/lib\/chat\/follow-ups\.ts/, 'finished run folds recent rows back into the summary');

// --- Per-step reasoning stream: each thinking phase closes before the next step -------------
const reasoningEvents: Array<{ key: string; status: string; detailDelta: string }> = [];
const reasoning = createReasoningStream({
  runId: 'run-1',
  intervalMs: 0,
  emit: (activity) => reasoningEvents.push({ key: activity.key, status: activity.status, detailDelta: activity.detailDelta }),
});
reasoning.push('\n\n');
assert.equal(reasoningEvents.length, 0, 'leading whitespace does not open an empty thought');
reasoning.push('Phase 1 ');
reasoning.push('thoughts.');
reasoning.finishStep();
reasoning.finishStep(); // idempotent when inactive
reasoning.push('\n\n');
assert.equal(reasoningEvents.filter((e) => e.key === 'run-1:reasoning:1').length, 0, 'whitespace after close does not open a new step');
reasoning.push('Phase 2 thoughts.');
reasoning.finishStep();
assert.deepEqual(
  reasoningEvents.map((e) => [e.key, e.status, e.detailDelta]),
  [
    ['run-1:reasoning:0', 'running', 'Phase 1 '],
    ['run-1:reasoning:0', 'running', 'thoughts.'],
    ['run-1:reasoning:0', 'done', ''],
    ['run-1:reasoning:1', 'running', 'Phase 2 thoughts.'],
    ['run-1:reasoning:1', 'done', ''],
  ]
);

// --- Expanded steps (Worked for › opened): a summary line, not every row --------------------
const stretch = renderToStaticMarkup(
  <ChatMessage
    message={{ ...done, id: 'run-steps', content: 'Checking:\n\nDone.', activities: done.activities!.map((a) => ({ ...a, contentOffset: 10 })) }}
    runRunning
  />
);
assert.ok(stretch.length > 0);

if (process.env.WORK_LOG_PREVIEW) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');
  const { AgentActivityCard } = await import('../src/app/activity');
  const longTurn = renderToStaticMarkup(
    <div className="message agent agent-run done">
      <div className="agent-run-header"><span>Worked for 3m 55s</span></div>
      <p>Writing the change description and opening the change:</p>
      <AgentActivityCard activities={[notice, { ...command, id: 'c9', detail: "cat > /tmp/sidebar-v2-settle-narrow-chat.md <<'EOF' ## What and why" }]} runStatus="done" runRunning={false} />
      <p>Change opened. Landing it, as you asked:</p>
      <AgentActivityCard activities={[{ ...command, id: 'c10', detail: 'cd /Users/complexia/.durango/ws/durango/sidebar-v2-settle-narrow-chat && durango-code land chg_vmoebqx76nok7ypgv7fp 2>&1 | tail -4' }]} runStatus="done" runRunning={false} />
      <p>Merged. Now the desktop release. Checking the clone:</p>
      <AgentActivityCard activities={[read, read2, edit, { ...command, id: 'c11', exitCode: 1, status: 'error' }]} runStatus="done" runRunning={false} />
      <p>Writing release notes for 1.0.156 and starting the deploy in the background:</p>
      <AgentActivityCard activities={[read, { ...command, id: 'c12', status: 'running', detail: 'bun run deploy --bump patch --notes-file ~/.durango/release/notes-1.0.156.md' }]} runStatus="running" runRunning live />
    </div>
  );
  const agyLivePreview = renderToStaticMarkup(
    <div className="message agent agent-run running">
      <div className="agent-run-header"><span>Working for 20m 12s</span></div>
      <AgentActivityCard
        activities={[
          thoughtDone,
          ...Array.from({ length: 26 }, (_, i) => ({ ...command, id: `oc-${i}`, detail: `rg -n queue${i} chat/` })),
          ...Array.from({ length: 17 }, (_, i) => ({
            ...edit,
            id: `oe-${i}`,
            detail: `chat/andromedus/lib/f${i}.ts`,
            diff: { path: `chat/andromedus/lib/f${i}.ts`, additions: 5, deletions: 2 },
          })),
          ...Array.from({ length: 79 }, (_, i) => ({ ...read, id: `or-${i}`, detail: `chat/convex/r${i}.ts` })),
          { ...command, id: 'oc-fail', detail: 'bun test chat/convex/messages.test.ts', exitCode: 1, status: 'error' },
          { ...edit, id: 'live-e1', detail: 'chat/andromedus/components/chat/chat-composer.tsx', diff: { path: 'chat/andromedus/components/chat/chat-composer.tsx', additions: 18, deletions: 4 } },
          { ...edit, id: 'live-e2', detail: 'chat/andromedus/components/chat/chat-thread.tsx', diff: { path: 'chat/andromedus/components/chat/chat-thread.tsx', additions: 42, deletions: 11 } },
          { ...edit, id: 'live-e3', detail: 'chat/andromedus/lib/chat/follow-ups.ts', diff: { path: 'chat/andromedus/lib/chat/follow-ups.ts', additions: 9, deletions: 2 } },
          { ...command, id: 'live-c1', detail: 'bun test chat/andromedus/lib/chat/follow-ups.test.ts' },
          thoughtLive,
        ]}
        runStatus="running"
        runRunning
        live
      />
    </div>
  );
  await writeFile(
    process.env.WORK_LOG_PREVIEW,
    `<!doctype html><html class="dark"><head><style>${css}</style><style>body{background:#121212;padding:32px 64px;font-family:Inter,system-ui,sans-serif;color:#e5e5e5;font-size:15px}.message{max-width:820px}h3{margin:24px 0 8px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#777}</style></head><body><div class="chat-container"><h3>Live long tool-only run (Antigravity)</h3>${agyLivePreview}<h3>Finished &amp; short live turns</h3>${doneHtml}${longTurn}</div></body></html>`
  );
}

console.log('work log tests passed');
