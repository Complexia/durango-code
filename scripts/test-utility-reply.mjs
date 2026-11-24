// node --no-warnings scripts/test-utility-reply.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// stream-adapters.js imports Electron; load both modules with it stubbed.
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const streamAdapters = dataUrl(
  (await readFile(new URL('../src/main/stream-adapters.js', import.meta.url), 'utf8')).replace(
    "import { shell } from 'electron';",
    'const shell = { openExternal: async () => {} };'
  )
);
const { titleFromResponseText, utilityReplyFromOutput } = await import(
  dataUrl(
    (await readFile(new URL('../src/main/utility-reply.js', import.meta.url), 'utf8')).replace(
      "from './stream-adapters.js'",
      `from '${streamAdapters}'`
    )
  )
);

const jsonl = (...events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';

// Codex narrated, ran a read-only command, then answered (the real turn that
// titled a thread "I'll trace the existing "Restart Durango Code" update confirmation…").
const codexNarrated = jsonl(
  { type: 'thread.started', thread_id: 't' },
  { type: 'turn.started' },
  {
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'agent_message',
      text: 'I’ll trace the existing “Restart Durango Code” update confirmation modal and find the standard JavaScript dialogs to replace.',
    },
  },
  { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'rg -n confirm code/src', status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'rg -n confirm code/src', aggregated_output: '…', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Replace Native Confirm Dialogs with Tailwind Modals' } },
  { type: 'turn.completed', usage: {} }
);
assert.equal(
  titleFromResponseText(utilityReplyFromOutput(codexNarrated, 'codex')),
  'Replace Native Confirm Dialogs with Tailwind Modals'
);

// Codex commentary then a final answer with no tool step between: still the last message.
const codexTwoMessages = jsonl(
  { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'Let me think about a name.' } },
  { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'Fix sidebar dots' } }
);
assert.equal(titleFromResponseText(utilityReplyFromOutput(codexTwoMessages, 'codex')), 'Fix sidebar dots');

// A plain Codex answer is unchanged, and a multi-line commit message survives whole.
const codexCommit = jsonl({
  type: 'item.completed',
  item: { id: 'a', type: 'agent_message', text: 'Fix title parsing\n\n- Keep the final answer' },
});
assert.equal(utilityReplyFromOutput(codexCommit, 'codex').trim(), 'Fix title parsing\n\n- Keep the final answer');

// Claude streams text deltas: text, a tool call, then more text. Only the text
// after the tool counts (the adapter's paragraph break is not left in front).
const delta = (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const claudeNarrated = jsonl(
  { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text', text: '' } } },
  delta('I’ll look at the code first.'),
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'I’ll look at the code first.' },
        { type: 'tool_use', id: 'tu_1', name: 'Grep', input: { pattern: 'confirm' } },
      ],
    },
  },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '…' }] } },
  { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text', text: '' } } },
  delta('Replace native '),
  delta('confirm dialogs'),
  { type: 'result', subtype: 'success', result: 'Replace native confirm dialogs' }
);
assert.equal(utilityReplyFromOutput(claudeNarrated, 'claude'), 'Replace native confirm dialogs');
assert.equal(titleFromResponseText(utilityReplyFromOutput(claudeNarrated, 'claude')), 'Replace native confirm dialogs');

// Claude text in several deltas with no tool stays one reply.
const claudePlain = jsonl(delta('Fix the '), delta('sidebar dots'));
assert.equal(utilityReplyFromOutput(claudePlain, 'claude'), 'Fix the sidebar dots');

// Narration is never a title: the thread keeps its heuristic one.
for (const narration of [
  'I’ll trace the existing “Restart Durango Code” update confirmation modal',
  "I'll look into this",
  'I will check the code',
  "I'm going to search the repo",
  'Let me look at the restart dialog',
  'Okay, I’ll start by reading the files',
  'Sure, let me check',
]) {
  assert.equal(titleFromResponseText(narration), '', narration);
}
// Titles that only look a little like narration stay.
for (const title of ['Letterbox video crop fix', 'Illustrations for onboarding', 'Let’s Encrypt certificate renewal', 'I18n for settings']) {
  assert.equal(titleFromResponseText(title), title, title);
}

// The first non-empty line is the title (a leading blank line used to empty it).
assert.equal(titleFromResponseText('\n\nFix sidebar dots\nmore'), 'Fix sidebar dots');
assert.equal(titleFromResponseText('Title: Fix sidebar dots'), 'Fix sidebar dots');

console.log('utility-reply: all cases passed');
