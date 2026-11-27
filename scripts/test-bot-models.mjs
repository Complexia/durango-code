import assert from 'node:assert/strict';
import { mergeDesktopBotModelCatalog } from '../src/main/bot-models.js';
import { filterBotModelChoices, isLocalBotModelChoice } from '../src/app/BotModelMenu.tsx';

const RECOMMENDED = [
  { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5', note: 'Smartest (the default)', provider: 'Anthropic', lab: 'anthropic', claude: true, recommended: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  { id: 'anthropic/claude-fable-5.2', label: 'Claude Fable 5.2', note: 'Deep reasoning', provider: 'Anthropic', lab: 'anthropic', claude: true, recommended: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5', note: 'Fast and capable', provider: 'Anthropic', lab: 'anthropic', claude: true, recommended: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', note: 'Cheapest, for routines', provider: 'Anthropic', lab: 'anthropic', claude: true, recommended: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', note: "OpenAI's flagship", provider: 'OpenAI', lab: 'openai', claude: false, recommended: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', note: 'Fast', provider: 'OpenAI', lab: 'openai', claude: false, recommended: true, efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'google/gemini-4-neon', label: 'Gemini 4 Neon', note: 'Google', provider: 'Google', lab: 'google', claude: false, recommended: true, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
];

const EXTRA_CLOUD = [
  { id: 'openai/gpt-6.2-astra', label: 'GPT-6.2 Astra', note: 'OpenAI', provider: 'OpenAI', lab: 'openai', claude: false, recommended: false },
  { id: 'x-ai/grok-4.7', label: 'Grok 4.7', note: 'SpaceXAI', provider: 'SpaceXAI', lab: 'xai', claude: false, recommended: false },
  { id: 'google/gemini-4-argon', label: 'Gemini 4 Argon', note: 'Google', provider: 'Google', lab: 'google', claude: false, recommended: false, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  { id: 'anthropic/claude-opus-5.5-fast', label: 'Claude Opus 5.5 (Fast)', note: 'Anthropic', provider: 'Anthropic', lab: 'anthropic', claude: false, recommended: false },
  { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8', note: 'Anthropic', provider: 'Anthropic', lab: 'anthropic', claude: false, recommended: false, legacy: true },
  { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5', note: 'Anthropic', provider: 'Anthropic', lab: 'anthropic', claude: true, recommended: false, legacy: true },
  { id: 'deepseek/deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro', note: 'DeepSeek', provider: 'DeepSeek', lab: 'deepseek', claude: false, recommended: false },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini', note: 'OpenAI', provider: 'OpenAI', lab: 'openai', claude: false, recommended: false, legacy: true },
];

const LOCAL_CLAUDE = [
  { slug: 'claude-opus-5-5', label: 'Claude Opus 5.5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'claude-opus-5', label: 'Claude Opus 5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'claude-code-cli', label: 'Claude Code CLI' },
];

// 1. Merging marks only Claude models runnable locally (recommended + discovered Claude slugs), never GPT/Gemini/Grok/Fast variants.
const merged = mergeDesktopBotModelCatalog({
  mode: 'durango',
  modelChoices: RECOMMENDED,
  modelCatalog: [...RECOMMENDED, ...EXTRA_CLOUD],
  localClaudeModels: LOCAL_CLAUDE,
});

assert.equal(merged.some((m) => m.id === 'claude-code-cli' || m.id === 'anthropic/claude-code-cli'), false, 'CLI pseudo-model excluded');
assert.deepEqual(
  merged.filter((m) => isLocalBotModelChoice(m, false)).map((m) => m.id),
  [
    'anthropic/claude-opus-5.5',
    'anthropic/claude-fable-5.2',
    'anthropic/claude-sonnet-5.5',
    'anthropic/claude-haiku-5.5',
    'anthropic/claude-opus-5',
  ],
  'only Claude models available to Claude Code show as Local'
);
assert.equal(isLocalBotModelChoice(merged.find((m) => m.id === 'google/gemini-4-neon'), false), false);
assert.equal(isLocalBotModelChoice(merged.find((m) => m.id === 'openai/gpt-6.1-sol'), false), false);
assert.equal(isLocalBotModelChoice(merged.find((m) => m.id === 'anthropic/claude-opus-5.5-fast'), false), false);
assert.equal(isLocalBotModelChoice(merged.find((m) => m.id === 'anthropic/claude-opus-4.8'), false), false);

// 2. Filtering: Recommended shows exact 7; searching from Recommended searches across All providers (including legacy).
const rec = filterBotModelChoices({
  allChoices: merged,
  recommendedChoices: merged.filter((m) => m.recommended),
  selectedModelId: 'anthropic/claude-opus-5.5',
  tab: 'recommended',
  query: '',
  localMode: false,
  showLegacy: false,
});
assert.equal(rec.items.length, 7);
assert.equal(rec.items[6].id, 'google/gemini-4-neon');

const searchGrok = filterBotModelChoices({
  allChoices: merged,
  recommendedChoices: merged.filter((m) => m.recommended),
  selectedModelId: 'anthropic/claude-opus-5.5',
  tab: 'recommended',
  query: 'grok',
  localMode: false,
  showLegacy: false,
});
assert.deepEqual(searchGrok.items.map((m) => m.id), ['x-ai/grok-4.7']);

// 3. Searching Local for "gemini" yields 0 local hits and points to Cloud (2 hits: Neon + Argon).
const searchLocalGemini = filterBotModelChoices({
  allChoices: merged,
  recommendedChoices: merged.filter((m) => m.recommended),
  selectedModelId: 'anthropic/claude-opus-5.5',
  tab: 'local',
  query: 'gemini',
  localMode: false,
  showLegacy: false,
});
assert.equal(searchLocalGemini.items.length, 0);
assert.equal(searchLocalGemini.alternateTab, 'cloud');
assert.equal(searchLocalGemini.alternateMatchesCount, 2);

// 4. All tab folds legacy unless selected or toggled on.
const allNoLegacy = filterBotModelChoices({
  allChoices: merged,
  recommendedChoices: merged.filter((m) => m.recommended),
  selectedModelId: 'anthropic/claude-opus-5.5',
  tab: 'all',
  query: '',
  localMode: false,
  showLegacy: false,
});
assert.equal(allNoLegacy.hiddenLegacyCount, 3);
assert.equal(allNoLegacy.items.some((m) => m.id === 'openai/gpt-4o-mini'), false);

const allWithLegacySelected = filterBotModelChoices({
  allChoices: merged,
  recommendedChoices: merged.filter((m) => m.recommended),
  selectedModelId: 'openai/gpt-4o-mini',
  tab: 'all',
  query: '',
  localMode: false,
  showLegacy: false,
});
assert.equal(allWithLegacySelected.items.some((m) => m.id === 'openai/gpt-4o-mini'), true, 'currently selected legacy model stays visible');

// 5. Local-only (signed-out) mode merges LOCAL_BOT_MODEL_CHOICES + discovered Claude models.
const localOnly = mergeDesktopBotModelCatalog({
  mode: 'local',
  modelChoices: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Smartest (the default)', claude: true },
  ],
  localClaudeModels: LOCAL_CLAUDE,
});
assert.deepEqual(localOnly.map((m) => m.id), ['claude-opus-5-5', 'claude-opus-5']);
assert.equal(localOnly.every((m) => m.local === true && m.claude === true), true);

console.log('✓ bot model catalog & picker tests passed');
