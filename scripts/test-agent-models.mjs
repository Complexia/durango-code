import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  agentModels,
  claudeModelsFromCatalog,
  claudeOneMillionContextModels,
  codexModelsFromCache,
  codexReasoningEffortForModel,
  configureAgentModelsCache,
  getAgentModels,
  grokModelsFromCache,
  invalidateAgentModelsCache,
  onAgentModelsChanged,
  cursorFrontierModelSlugs,
  cursorFallbackModels,
  museFallbackModels,
  museModelsFromCatalogRows,
  openCodeFallbackModels,
  parseCursorModelsOutput,
  parseOpenCodeModelsOutput,
} from '../src/main/models.js';
import { validateAgentWorkspace } from '../src/main/agent-run-preflight.js';

const grokModels = agentModels.filter((model) => model.providerId === 'grok');
assert.deepEqual(
  grokModels.map(({ slug, shortcut }) => ({ slug, shortcut })),
  [
    { slug: 'grok-4.7', shortcut: '⌘1' },
    { slug: 'grok-4.7-build-fast', shortcut: '⌘2' },
    { slug: 'grok-4.6', shortcut: '⌘3' },
    { slug: 'grok-4.5', shortcut: '⌘4' },
  ],
  'the Grok fallback should mirror `grok models`: Grok 4.7 (and its Fast variant) first, no Composer 2.5 Fast'
);

const codexModels = agentModels.filter((model) => model.providerId === 'codex');
assert.deepEqual(
  codexModels.map((model) => model.slug),
  ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  "the Codex fallback should follow Codex's own priority order and drop the retired GPT-5.5/5.4/5.3 models"
);
assert.equal(
  codexReasoningEffortForModel({ slug: 'gpt-6.1-sol' }),
  'low',
  'GPT-6.1 Sol should inherit the Codex Low default'
);
assert.equal(
  codexReasoningEffortForModel({ slug: 'gpt-6.1-sol' }, 'ultra'),
  'ultra',
  'GPT-6.1 Sol should keep Ultra'
);
assert.equal(
  codexReasoningEffortForModel({ slug: 'gpt-6.1-sol' }, 'max'),
  'max',
  'GPT-6.1 Sol should keep Max'
);
assert.equal(
  codexReasoningEffortForModel({ slug: 'gpt-6-sol' }),
  'medium',
  'GPT-6 Sol should inherit the Codex Medium default like Astra'
);
assert.equal(
  codexReasoningEffortForModel({ slug: 'gpt-6-sol' }, 'ultra'),
  'ultra',
  'GPT-6 Sol should keep Ultra'
);
assert.equal(
  codexReasoningEffortForModel({ slug: 'gpt-6-luna' }, 'ultra'),
  'max',
  'GPT-6 Luna should clamp Ultra to Max since the CLI does not advertise Ultra for it'
);
assert.equal(
  codexReasoningEffortForModel({ slug: 'gpt-6-luna' }, 'max'),
  'max',
  'GPT-6 Luna should keep Max'
);
assert.equal(
  codexReasoningEffortForModel({ slug: 'gpt-5.6-sol' }),
  'low',
  'GPT-5.6 Sol should inherit the Codex Low default'
);
assert.equal(
  codexReasoningEffortForModel({ slug: 'gpt-5.6-terra' }),
  'medium',
  'GPT-5.6 Terra should inherit the Codex Medium default'
);
assert.equal(
  codexReasoningEffortForModel({ slug: 'gpt-5.6-luna' }, 'ultra'),
  'max',
  'GPT-5.6 Luna should clamp Ultra to Max'
);
assert.equal(
  codexReasoningEffortForModel({ slug: 'some-older-codex' }, 'ultra'),
  'xhigh',
  'models without Max or Ultra should step Ultra down to Extra High'
);
assert.equal(
  codexReasoningEffortForModel(
    { slug: 'gpt-6-sol', reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'high' },
    'ultra'
  ),
  'high',
  "live-catalog tiers should override the static ones when clamping"
);
assert.equal(
  codexReasoningEffortForModel({ slug: 'gpt-6-sol', reasoningEfforts: ['low', 'medium'], defaultReasoningEffort: 'low' }),
  'low',
  "a live-catalog default should win over the static default"
);

const claudeModels = agentModels.filter((model) => model.providerId === 'claude');
assert.deepEqual(
  claudeModels.map(({ slug, shortcut }) => ({ slug, shortcut })),
  [
    { slug: 'claude-fable-5-1', shortcut: '⌘1' },
    { slug: 'claude-opus-5-5', shortcut: '⌘2' },
    { slug: 'claude-sonnet-5-5', shortcut: '⌘3' },
    { slug: 'claude-haiku-5-5', shortcut: '⌘4' },
    { slug: 'claude-fable-5', shortcut: '⌘5' },
    { slug: 'claude-opus-5', shortcut: '⌘6' },
    { slug: 'claude-code-cli', shortcut: undefined },
  ],
  'the Claude provider should lead with Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5 and drop Sonnet 5, Haiku 4.5 and the 4.x Opus/Sonnet models'
);
assert.ok(
  claudeOneMillionContextModels.has('claude-opus-5-5'),
  'Claude Opus 5.5 should advertise the 1M context window like Opus 5'
);
assert.ok(
  claudeOneMillionContextModels.has('claude-sonnet-5-5'),
  'Claude Sonnet 5.5 should advertise the 1M context window like Sonnet 5'
);
assert.ok(
  claudeOneMillionContextModels.has('claude-haiku-5-5'),
  'Claude Haiku 5.5 should advertise the 1M context window'
);

const parsed = parseCursorModelsOutput(`
Available models

auto - Auto (current, default)
gpt-5.3-codex-low - Codex 5.3 Low
cursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast
composer-2.5 - Composer 2.5

Tip: use --model <id> to switch.
`);

assert.deepEqual(
  parsed.map(({ slug, label, favorite }) => ({ slug, label, favorite })),
  [
    { slug: 'auto', label: 'Auto', favorite: true },
    {
      slug: 'cursor-grok-4.6-high-fast',
      label: 'Cursor Grok 4.6 Fast',
      favorite: true,
    },
    { slug: 'composer-2.5', label: 'Composer 2.5', favorite: true },
    { slug: 'gpt-5.3-codex-low', label: 'Codex 5.3 Low', favorite: false },
  ],
  'Cursor CLI discovery should parse current rows and promote primary models above legacy rows'
);

const frontierFixture = parseCursorModelsOutput(`
gpt-5.3-codex-low - Codex 5.3 Low
gemini-3.6-flash-high - Gemini 3.6 Flash
gpt-5.6-terra-high - GPT-5.6 Terra 1M High
claude-opus-5-thinking-high - Opus 5 1M Thinking
cursor-grok-4.6-high-fast - Cursor Grok 4.6 Fast
auto - Auto (default)
future-model - Future Model
`);
assert.deepEqual(
  frontierFixture.map((model) => model.slug),
  [
    'auto',
    'cursor-grok-4.6-high-fast',
    'claude-opus-5-thinking-high',
    'gpt-5.6-terra-high',
    'gemini-3.6-flash-high',
    'gpt-5.3-codex-low',
    'future-model',
  ],
  'available frontier representatives should lead while all other CLI models retain their order'
);
assert.ok(
  cursorFrontierModelSlugs.includes('gpt-5.6-terra-high') &&
    cursorFrontierModelSlugs.includes('gemini-3.6-flash-high'),
  'the promoted Cursor set should cover current GPT and Gemini frontier families'
);

assert.ok(
  cursorFallbackModels.some(
    (model) =>
      model.slug === 'cursor-grok-4.6-high-fast' && model.label === 'Cursor Grok 4.6 Fast'
  ),
  'the authenticated-account fallback should include Cursor Grok 4.6'
);
assert.ok(
  cursorFallbackModels.some((model) => model.slug === 'claude-opus-5-thinking-high'),
  'the fallback should include Cursor Opus 5'
);
assert.ok(
  cursorFallbackModels.some((model) => model.slug === 'gpt-5.6-sol-high'),
  'the fallback should include Cursor GPT-5.6 Sol'
);

const openCodeModels = parseOpenCodeModelsOutput(`
\u001b[32mopencode/big-pickle\u001b[0m
anthropic/claude-sonnet-4-6
openai/gpt-5.6
anthropic/claude-sonnet-4-6
Error: ignored diagnostic
`);
assert.deepEqual(
  openCodeModels.map(({ id, slug, label, favorite }) => ({ id, slug, label, favorite })),
  [
    {
      id: 'opencode:opencode/big-pickle',
      slug: 'opencode/big-pickle',
      label: 'Big Pickle',
      favorite: true,
    },
    {
      id: 'opencode:anthropic/claude-sonnet-4-6',
      slug: 'anthropic/claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6 (Anthropic)',
      favorite: false,
    },
    {
      id: 'opencode:openai/gpt-5.6',
      slug: 'openai/gpt-5.6',
      label: 'GPT 5.6 (OpenAI)',
      favorite: false,
    },
  ],
  'OpenCode discovery should keep every provider/model slug, remove duplicates, and disambiguate labels'
);
assert.equal(openCodeFallbackModels.length, 9, 'OpenCode should retain its built-in Zen catalog as fallback');
assert.deepEqual(
  openCodeFallbackModels.slice(0, 3).map(({ label, reasoningVariants }) => ({ label, reasoningVariants })),
  [
    { label: 'Flint 40B Free', reasoningVariants: ['low', 'medium', 'high', 'xhigh', 'max'] },
    {
      label: 'Nemotron 3.5 Super VL Free',
      reasoningVariants: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    },
    { label: 'Beam Free', reasoningVariants: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ],
  'the fallback should mirror OpenCode display names, newest-first order, and model variants'
);
assert.ok(
  !openCodeFallbackModels.some((model) => model.slug === 'anthropic/claude-sonnet-4-6'),
  'the OpenCode fallback must not advertise an unconfigured Anthropic model'
);

const verboseOpenCodeModels = parseOpenCodeModelsOutput(`
opencode/big-pickle
{
  "name": "Big Pickle",
  "release_date": "2025-10-17",
  "variants": {}
}
opencode/muse-spark-1.2-contributor-free
{
  "name": "Muse Spark 1.2 Free",
  "release_date": "2026-08-05",
  "variants": { "minimal": {}, "low": {}, "medium": {}, "high": {}, "xhigh": {} }
}
opencode/x-preview-f-free
{
  "name": "Ox Alpha Free (Unlimited)",
  "release_date": "2026-08-21",
  "variants": { "low": {}, "high": {}, "max": {} }
}
`);
assert.deepEqual(
  verboseOpenCodeModels.map(({ slug, label, reasoningVariants }) => ({
    slug,
    label,
    reasoningVariants,
  })),
  [
    {
      slug: 'opencode/x-preview-f-free',
      label: '0x Alpha Free (Unlimited)',
      reasoningVariants: ['low', 'high', 'max'],
    },
    {
      slug: 'opencode/muse-spark-1.2-contributor-free',
      label: 'Muse Spark 1.2 Free',
      reasoningVariants: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    },
    { slug: 'opencode/big-pickle', label: 'Big Pickle', reasoningVariants: undefined },
  ],
  'verbose discovery should use OpenCode names and variant keys and sort like its model picker'
);

const streamAdapterSource = (await readFile(
  new URL('../src/main/stream-adapters.js', import.meta.url),
  'utf8'
)).replace("import { shell } from 'electron';", 'const shell = { openExternal: async () => {} };');
const {
  extractCursorTextFromJsonEvent,
  extractOpenCodeActivitiesFromJsonEvent,
  extractOpenCodeTextFromJsonEvent,
  extractSessionIdFromJsonEvent,
} = await import(
  `data:text/javascript;base64,${Buffer.from(streamAdapterSource).toString('base64')}`
);
const cursorContext = { textSeen: false };
let cursorText = '';
for (const event of [
  { type: 'assistant', timestamp_ms: 1, message: { content: [{ type: 'text', text: 'HELLO' }] } },
  { type: 'assistant', timestamp_ms: 2, message: { content: [{ type: 'text', text: '_CURSOR' }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'HELLO_CURSOR' }] } },
  { type: 'result', result: 'HELLO_CURSOR' },
]) {
  const chunk = extractCursorTextFromJsonEvent(event, cursorContext);
  if (chunk) {
    cursorText += chunk;
    cursorContext.textSeen = true;
  }
}
assert.equal(cursorText, 'HELLO_CURSOR', 'Cursor partial output and its final aggregates should render once');

assert.equal(
  extractCursorTextFromJsonEvent(
    { type: 'assistant', message: { content: [{ type: 'text', text: 'FALLBACK' }] } },
    { textSeen: false }
  ),
  'FALLBACK',
  'the final Cursor assistant aggregate should remain a fallback when no partial output arrived'
);

const openCodeTextEvent = {
  type: 'text',
  sessionID: 'ses_test',
  part: { type: 'text', text: 'OPENCODE_OK' },
};
assert.equal(extractSessionIdFromJsonEvent('opencode', openCodeTextEvent), 'ses_test');
assert.equal(extractOpenCodeTextFromJsonEvent(openCodeTextEvent), 'OPENCODE_OK');
assert.deepEqual(
  extractOpenCodeActivitiesFromJsonEvent({
    type: 'tool_use',
    part: {
      type: 'tool',
      tool: 'bash',
      callID: 'call_test',
      title: 'pwd',
      state: {
        status: 'completed',
        input: { command: 'pwd' },
        output: '/tmp\n',
        metadata: { exit: 0 },
      },
    },
  }),
  [
    {
      key: 'call_test',
      type: 'command',
      title: 'Command - pwd',
      detail: 'pwd',
      status: 'done',
      input: '{\n  "command": "pwd"\n}',
      output: '/tmp',
      exitCode: 0,
    },
  ],
  'OpenCode tool events should render as completed Orion activity rows'
);

assert.equal(
  await validateAgentWorkspace('/existing', async () => ({ isDirectory: () => true })),
  null
);
assert.match(
  await validateAgentWorkspace('/missing-workspace', async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  }),
  /workspace no longer exists.*start a new thread/i,
  'missing workspaces should fail before spawning a provider'
);
assert.match(
  await validateAgentWorkspace('/locked', async () => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  }),
  /could not access.*permission denied/i,
  'workspace access failures should not be misreported as deleted workspaces'
);

console.log('Agent model catalog regression tests passed.');

// Muse: the static fallback carries Wonder (and Wonder Full) plus both tiers
// of each Spark generation, and the live catalog reader orders/dedupes the
// CLI's cached provider rows.
assert.deepEqual(
  museFallbackModels.map(({ id, slug, label, shortcut, favorite }) => ({ id, slug, label, shortcut, favorite })),
  [
    {
      id: 'muse:muse-wonder-full-1.0',
      slug: 'muse-wonder-full-1.0',
      label: 'Muse Wonder Full 1.0',
      shortcut: '⌘1',
      favorite: false,
    },
    { id: 'muse:muse-wonder-1.0', slug: 'muse-wonder-1.0', label: 'Muse Wonder 1.0', shortcut: '⌘2', favorite: true },
    { id: 'muse:muse-spark-1.3', slug: 'muse-spark-1.3', label: 'Muse Spark 1.3', shortcut: '⌘3', favorite: true },
    {
      id: 'muse:muse-spark-1.3-contributor',
      slug: 'muse-spark-1.3-contributor',
      label: 'Muse Spark 1.3 Contributor',
      shortcut: '⌘4',
      favorite: true,
    },
    { id: 'muse:muse-spark-1.2', slug: 'muse-spark-1.2', label: 'Muse Spark 1.2', shortcut: '⌘5', favorite: false },
    {
      id: 'muse:muse-spark-1.2-contributor',
      slug: 'muse-spark-1.2-contributor',
      label: 'Muse Spark 1.2 Contributor',
      shortcut: '⌘6',
      favorite: false,
    },
  ],
  'the Muse fallback should list Wonder Full, Wonder, then Spark 1.3 and 1.2 in both standard and contributor tiers'
);
assert.deepEqual(
  agentModels.filter((model) => model.providerId === 'muse').map((model) => model.slug),
  museFallbackModels.map((model) => model.slug),
  'the static agent catalog should carry the Muse fallback block'
);

const museCatalogRow = (model_id, overrides = {}) => ({
  model_id,
  display_label: model_id,
  provider_id: 'meta',
  profile_id: 'tbh',
  visibility: 'visible',
  release_date: '2026-08-05',
  display_order: null,
  is_current: false,
  is_default: false,
  ...overrides,
});

const discoveredMuse = museModelsFromCatalogRows([
  // Cached in an arbitrary order, across two provider profiles, with a
  // duplicate and a hidden row.
  museCatalogRow('muse-spark-1.2-contributor'),
  museCatalogRow('muse-spark-1.3-contributor', { release_date: '2026-09-02', is_default: true, is_current: true }),
  museCatalogRow('muse-spark-1.2'),
  museCatalogRow('muse-spark-1.3', { release_date: '2026-09-02' }),
  museCatalogRow('muse-spark-1.3', { release_date: '2026-09-02', profile_id: 'other' }),
  museCatalogRow('muse-spark-internal', { visibility: 'hidden', release_date: '2026-09-10' }),
  { model_id: '' },
  null,
]);
assert.deepEqual(
  discoveredMuse.map(({ id, slug, label, shortcut, favorite, command }) => ({ id, slug, label, shortcut, favorite, command })),
  [
    { id: 'muse:muse-spark-1.3', slug: 'muse-spark-1.3', label: 'Muse Spark 1.3', shortcut: '⌘1', favorite: true, command: 'muse' },
    {
      id: 'muse:muse-spark-1.3-contributor',
      slug: 'muse-spark-1.3-contributor',
      label: 'Muse Spark 1.3 Contributor',
      shortcut: '⌘2',
      favorite: true,
      command: 'muse',
    },
    { id: 'muse:muse-spark-1.2', slug: 'muse-spark-1.2', label: 'Muse Spark 1.2', shortcut: '⌘3', favorite: false, command: 'muse' },
    {
      id: 'muse:muse-spark-1.2-contributor',
      slug: 'muse-spark-1.2-contributor',
      label: 'Muse Spark 1.2 Contributor',
      shortcut: '⌘4',
      favorite: false,
      command: 'muse',
    },
  ],
  'Muse catalog rows should be deduped, hidden rows dropped, newest generation first with standard ahead of contributor'
);

assert.deepEqual(
  museModelsFromCatalogRows([
    museCatalogRow('muse-spark-1.2', { display_order: 1 }),
    museCatalogRow('muse-spark-1.3', { display_order: 0, release_date: '2026-09-02' }),
    museCatalogRow('muse-spark-1.3-contributor', { release_date: '2026-09-02' }),
  ]).map((model) => model.slug),
  ['muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.3-contributor'],
  'an explicit display_order from the provider should win over release date, with unordered rows last'
);

assert.deepEqual(museModelsFromCatalogRows(undefined), [], 'a missing Muse catalog yields no models');

// Muse catalog rows carry per-model effort tiers.
assert.deepEqual(
  museModelsFromCatalogRows([
    museCatalogRow('muse-spark-1.2', {
      reasoning_effort_variants: [{ tier: 'xhigh' }, { tier: 'low' }, { tier: 'minimal' }],
    }),
  ])[0].reasoningEfforts,
  ['minimal', 'low', 'xhigh'],
  'Muse discovery should keep each model\'s effort tiers, ordered low to high'
);

// Codex: models_cache.json rows, hidden rows dropped, Codex priority order.
assert.deepEqual(
  codexModelsFromCache({
    models: [
      {
        slug: 'gpt-6-astra',
        display_name: 'GPT-6-Astra',
        priority: 2,
        visibility: 'list',
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }, { effort: 'ultra' }],
      },
      { slug: 'codex-auto-review', display_name: 'Codex Auto Review', priority: 0, visibility: 'hide' },
      { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', priority: 1, visibility: 'list' },
      { slug: 'gpt-6.1-sol', display_name: 'duplicate', priority: 3, visibility: 'list' },
      null,
    ],
  }).map(({ id, label, reasoningEfforts, defaultReasoningEffort, command }) => ({
    id,
    label,
    reasoningEfforts,
    defaultReasoningEffort,
    command,
  })),
  [
    { id: 'codex:gpt-6.1-sol', label: 'GPT-6.1 Sol', reasoningEfforts: undefined, defaultReasoningEffort: undefined, command: 'codex' },
    {
      id: 'codex:gpt-6-astra',
      label: 'GPT-6 Astra',
      reasoningEfforts: ['low', 'max', 'ultra'],
      defaultReasoningEffort: 'medium',
      command: 'codex',
    },
  ],
  'Codex discovery should read its model cache in priority order with per-model tiers'
);
assert.deepEqual(codexModelsFromCache(undefined), [], 'a missing Codex cache yields no models');

// Grok: models_cache.json keyed by id in picker order.
assert.deepEqual(
  grokModelsFromCache({
    models: {
      'grok-4.7': {
        info: {
          id: 'grok-4.7',
          name: 'Grok 4.7',
          supports_reasoning_effort: true,
          reasoning_effort: 'high',
          reasoning_efforts: [
            { value: 'xhigh', default: false },
            { value: 'high', default: true },
            { value: 'low', default: false },
          ],
        },
      },
      'grok-internal': { info: { id: 'grok-internal', name: 'Internal', hidden: true } },
      'grok-4.5': { info: { id: 'grok-4.5', name: 'Grok 4.5', supports_reasoning_effort: false } },
    },
  }).map(({ id, label, shortcut, favorite, reasoningEfforts, defaultReasoningEffort }) => ({
    id,
    label,
    shortcut,
    favorite,
    reasoningEfforts,
    defaultReasoningEffort,
  })),
  [
    {
      id: 'grok:grok-4.7',
      label: 'Grok 4.7',
      shortcut: '⌘1',
      favorite: true,
      reasoningEfforts: ['low', 'high', 'xhigh'],
      defaultReasoningEffort: 'high',
    },
    {
      id: 'grok:grok-4.5',
      label: 'Grok 4.5',
      shortcut: '⌘2',
      favorite: false,
      reasoningEfforts: undefined,
      defaultReasoningEffort: undefined,
    },
  ],
  'Grok discovery should drop hidden models and keep per-model effort tiers'
);

// Claude: the current "main" lineup plus only the curated overflow models.
assert.deepEqual(
  claudeModelsFromCatalog({
    catalog: {
      config: {
        models: [
          { id: 'claude-opus-5-5', name: 'Opus 5.5', section: 'main', runtime: { effort_levels: ['low', 'max'], default_effort: 'medium' } },
          { id: 'claude-opus-4-6', name: 'Opus 4.6', section: 'overflow' },
          { id: 'claude-fable-5', name: 'Fable 5', section: 'overflow' },
          { id: 'claude-fable-5-1', name: 'Fable 5.1', section: 'main' },
        ],
      },
    },
  }).map(({ id, label, shortcut, reasoningEfforts, defaultReasoningEffort }) => ({
    id,
    label,
    shortcut,
    reasoningEfforts,
    defaultReasoningEffort,
  })),
  [
    {
      id: 'claude:claude-opus-5-5',
      label: 'Claude Opus 5.5',
      shortcut: '⌘1',
      reasoningEfforts: ['low', 'max'],
      defaultReasoningEffort: 'medium',
    },
    { id: 'claude:claude-fable-5-1', label: 'Claude Fable 5.1', shortcut: '⌘2', reasoningEfforts: undefined, defaultReasoningEffort: undefined },
    { id: 'claude:claude-fable-5', label: 'Claude Fable 5', shortcut: '⌘3', reasoningEfforts: undefined, defaultReasoningEffort: undefined },
  ],
  'Claude discovery should list the main section first and skip un-curated overflow models'
);

// Cache: the on-disk copy answers immediately, an expired one revalidates in
// the background, an empty discovery keeps the previous block, and changes
// reach listeners and the disk.
{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-models-cache-'));
  const cacheFile = path.join(dir, 'agent-models-cache.json');
  const cachedCodex = { id: 'codex:gpt-cached', providerId: 'codex', providerLabel: 'Codex', label: 'Cached', slug: 'gpt-cached', command: 'rm' };
  await writeFile(cacheFile, JSON.stringify({ version: 1, savedAt: 0, providers: { codex: [cachedCodex], bogus: [cachedCodex] } }));

  let discoveries = 0;
  let releaseDiscovery;
  const discoveryGate = new Promise((resolve) => {
    releaseDiscovery = resolve;
  });
  const freshGrok = { id: 'grok:grok-9', providerId: 'grok', providerLabel: 'Grok', label: 'Grok 9', slug: 'grok-9', command: 'grok' };
  await configureAgentModelsCache(cacheFile, {
    discoverers: {
      codex: async () => {
        discoveries += 1;
        await discoveryGate;
        return [];
      },
      grok: async () => [freshGrok],
    },
  });
  const changed = new Promise((resolve) => {
    const stop = onAgentModelsChanged((models) => {
      stop();
      resolve(models);
    });
  });

  const fromDisk = await getAgentModels();
  assert.deepEqual(
    fromDisk.filter((model) => model.providerId === 'codex').map(({ id, command }) => ({ id, command })),
    [{ id: 'codex:gpt-cached', command: 'codex' }],
    'the disk cache should answer before discovery finishes, with the spawn command taken from code'
  );
  assert.equal(discoveries, 1, 'an expired disk cache should start one background refresh');
  await getAgentModels();
  assert.equal(discoveries, 1, 'callers during a refresh should share it rather than start another');

  releaseDiscovery();
  const refreshed = await changed;
  assert.deepEqual(
    refreshed.filter((model) => ['codex', 'grok'].includes(model.providerId)).map((model) => model.id),
    ['grok:grok-9', 'codex:gpt-cached'],
    'a refresh should replace discovered providers and keep the last good block for empty ones'
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const saved = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.deepEqual(Object.keys(saved.providers).sort(), ['codex', 'grok'], 'a changed catalog should be written back to disk');

  const beforeInvalidate = discoveries;
  invalidateAgentModelsCache();
  assert.equal((await getAgentModels()).length, refreshed.length, 'an invalidated catalog should still answer immediately');
  await getAgentModels({ fresh: true });
  assert.equal(discoveries, beforeInvalidate + 1, 'a fresh request after invalidation should await one new discovery');
  await rm(dir, { recursive: true, force: true });
}

console.log('Agent model discovery and cache tests passed.');
