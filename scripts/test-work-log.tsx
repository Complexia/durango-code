import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { activityAction, activityLabel, summarizeActivities } from '../src/app/activity';
import { ChatMessage } from '../src/app/chat';
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

// Between steps the summary and Thinking share the steps column, so the next step swaps in
// for Thinking without moving the summary above it.
const between: Message = {
  ...live,
  id: 'run-between',
  activities: [{ ...read, contentOffset: 20 }, { ...read2, contentOffset: 20 }, { ...command, contentOffset: 20 }],
};
const betweenHtml = renderToStaticMarkup(<ChatMessage message={between} runRunning />);
assert.match(betweenHtml, /<div class="agent-steps">.*Read 2 files and ran 1 command.*>Thinking<\/span><\/span><\/div><\/div>/s, 'Thinking ends the steps column');
const nextStep = renderToStaticMarkup(
  <ChatMessage message={{ ...between, activities: [...between.activities!, { ...command, id: 'c2', contentOffset: 20, status: 'running', output: undefined }] }} runRunning />
);
assert.match(nextStep, /Read 2 files and ran 1 command/, 'the summary line keeps its text while the next step runs');
assert.doesNotMatch(nextStep, />Thinking</);

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
  await writeFile(
    process.env.WORK_LOG_PREVIEW,
    `<!doctype html><html class="dark"><head><style>${css}</style><style>body{background:#121212;padding:32px 64px;font-family:Inter,system-ui,sans-serif;color:#e5e5e5;font-size:15px}.message{max-width:820px}</style></head><body><div class="chat-container">${doneHtml}${longTurn}</div></body></html>`
  );
}

console.log('work log tests passed');
