import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  addPromptContext,
  buildSlashCommandCandidates,
  filterSlashCommands,
  getSlashToken,
  parseCodexReviewCommand,
} from '../src/app/slashCommands.ts';

const [appSource, composerSource, mainSource, claudeDriverSource] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/Composer.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/main/claude-driver.js', import.meta.url), 'utf8'),
]);

const section = (source, start, end) => {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
};

let slashPrompt = '/review 42';
slashPrompt = addPromptContext(slashPrompt, 'linked task context', true);
slashPrompt = addPromptContext(slashPrompt, '[Orion orchestration]', true);
assert.equal(
  slashPrompt,
  '/review 42\n\nlinked task context\n\n[Orion orchestration]',
  'Claude context must follow a slash command so the CLI can expand it'
);
assert.equal(
  addPromptContext('  /compact', 'inherited context', true),
  '/compact\n\ninherited context',
  'leading whitespace must not survive ahead of a Claude slash command'
);
assert.equal(
  addPromptContext('implement it', 'linked task context', true),
  'linked task context\n\nimplement it',
  'ordinary prompts must retain context-first ordering'
);

assert.deepEqual(getSlashToken('/rev'), { query: 'rev' });
assert.equal(getSlashToken('/review base '), null);
assert.deepEqual(parseCodexReviewCommand('/review'), {
  review: { mode: 'uncommitted' },
});
assert.deepEqual(parseCodexReviewCommand('/review base main'), {
  review: { mode: 'base', base: 'main' },
});
assert.deepEqual(parseCodexReviewCommand('/review commit abc1234'), {
  review: { mode: 'commit', commit: 'abc1234' },
});
assert.deepEqual(parseCodexReviewCommand('/review focus on lifecycle races'), {
  review: { mode: 'custom', instructions: 'focus on lifecycle races' },
});
assert.deepEqual(parseCodexReviewCommand('/review base'), {
  error: 'Name a base branch, e.g. “/review base main”.',
});
assert.equal(parseCodexReviewCommand('please review this'), null);
const filtered = filterSlashCommands(
  buildSlashCommandCandidates(
    { providerId: 'claude', claudeBacked: true, isTerminal: false },
    [{ name: 'review', description: 'Review a pull request', argumentHint: '<number>' }]
  ),
  'rev'
);
assert.equal(filtered[0]?.command.name, 'review');

const emptyReplacement = buildSlashCommandCandidates(
  { providerId: 'claude', claudeBacked: true, isTerminal: false },
  []
);
assert.equal(
  emptyReplacement.some((candidate) => candidate.command.name === 'compact'),
  false,
  'a live empty replacement must not fall back to stale built-ins'
);

const startTurn = section(
  appSource,
  '  const startTurnForThreadUnlocked = useCallback(',
  '  const startTurnForThread = useCallback('
);
assert.match(
  startTurn,
  /model\.providerId === 'claude' && promptText\.trimStart\(\)\.startsWith\('\/'\)/,
  'SDK prompt assembly must preserve Claude slash commands'
);
for (const contextCall of [
  /addAgentContext\(buildLinkedTaskContext/,
  /addAgentContext\(inheritedSubagentResumeContext/,
  /addAgentContext\(buildModelMentionsContext/,
  /addAgentContext\(threadMentionsContext\)/,
  /addAgentContext\(orchestrationContext\)/,
]) {
  assert.match(startTurn, contextCall, 'every prepended context path must use slash-safe assembly');
}

const modelCommand = section(
  appSource,
  '    // `/model` — open the model picker instead of sending anything.',
  '    // Agent mid-run:'
);
assert.match(
  modelCommand,
  /if \(isSending\) \{[\s\S]*return;[\s\S]*setModelPickerOpen\(true\)/,
  '/model must reject active runs before opening the picker'
);

const remoteCommands = section(
  appSource,
  '  // Remote runTurn/stopTurn commands from paired controllers',
  '  const openAccountSettings = useCallback('
);
assert.match(
  remoteCommands,
  /parseCodexReviewCommand\(promptText\)[\s\S]*turnModel\?\.providerId === 'codex'/,
  'remote Codex review text must be recognized by the authoritative Desktop host'
);
assert.match(
  remoteCommands,
  /claimRemoteSideEffect\(canPrepare, claimStart\)[\s\S]*startReviewForThread/,
  'remote Codex reviews must claim the command before starting the dedicated reviewer'
);

const draftSwap = section(
  composerSource,
  '  // A different thread\'s draft: its dismissed slash menu isn\'t this one\'s.',
  '  // Autosize the composer to its content.'
);
assert.match(
  draftSwap,
  /setSlashDismissedDraft\(null\)/,
  'switching composer threads must clear slash-menu dismissal'
);
const composerInput = section(composerSource, '        value={chatInput}', '        onKeyDown={handleChatKeyDown}');
assert.match(
  composerInput,
  /onChange=\{\(e\) => \{\s*setSlashDismissedDraft\(null\);/,
  'editing the textarea must clear slash-menu dismissal'
);

const pushCommands = section(
  claudeDriverSource,
  'export const pushSlashCommands =',
  'export const refreshClaudeSlashCommands ='
);
assert.doesNotMatch(
  pushCommands,
  /normalized\.length === 0/,
  'empty command lists are valid replacements'
);
assert.match(
  pushCommands,
  /claudeSlashCommandCache\.set\(projectPath, normalized\)[\s\S]*sender\.send/,
  'every normalized replacement must update the cache before renderer push'
);

const listCommands = section(
  claudeDriverSource,
  'export const listClaudeSlashCommands =',
  'export const handleClaudeSessionMessage ='
);
assert.match(
  listCommands,
  /session\.sender = sender;\s*session\.createParams\.sender = sender;[\s\S]*refreshClaudeSlashCommands\(session\)/,
  'a renderer pull must rebind future pushes before refreshing the live session'
);
const ipcListHandler = section(
  mainSource,
  "ipcMain.handle('agent:listSlashCommands'",
  '// `/clear` in the composer'
);
assert.match(
  ipcListHandler,
  /sender: event\.sender/,
  'main must pass the reopened renderer sender to the persistent session'
);

console.log('slash command tests passed');
