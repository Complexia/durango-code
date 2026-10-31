import assert from 'node:assert/strict';

import { fallbackAgentModels, type AgentModel } from '../src/agentCatalog';
import { buildModelMentionsContext, parseModelMentions } from '../src/app/promptContext';

const model = (id: string, providerLabel: string, label: string, slug: string) =>
  ({ id, providerId: id.split(':')[0], providerLabel, label, slug }) as AgentModel;
const models = [
  model('orion:orchestrator', 'Durango Code', 'Durango Code', 'orion'),
  model('codex:gpt-6.1-sol', 'Codex', 'GPT-6.1 Sol', 'gpt-6.1-sol'),
  model('codex:gpt-6-sol', 'Codex', 'GPT-6 Sol', 'gpt-6-sol'),
  model('grok:grok-4.7', 'Grok', 'Grok 4.7', 'grok-4.7'),
  model('grok:grok-4.7-build-fast', 'Grok', 'Grok 4.7 Fast', 'grok-4.7-build-fast'),
  model('claude:claude-opus-5-5', 'Claude', 'Claude Opus 5.5', 'claude-opus-5-5'),
  model('cursor:auto', 'Cursor', 'Auto', 'auto'),
  model('cursor:claude-opus-5-5', 'Cursor', 'Claude Opus 5.5', 'claude-opus-5-5'),
];
const ids = (text: string) => parseModelMentions(text, models).map((mention) => mention.modelId);

// @-mentions work as before.
assert.deepEqual(ids('you can use @gpt-6.1-sol for this'), ['codex:gpt-6.1-sol']);
assert.equal(parseModelMentions('@gpt-6.1-sol', models)[0].bare, undefined);
assert.deepEqual(ids('ask @grok-4.7-build-fast'), ['grok:grok-4.7-build-fast'], 'a longer slug is not its prefix');
assert.deepEqual(ids('ask @claude:claude-opus-5-5'), ['claude:claude-opus-5-5'], 'shared slugs need the id');

// Models named in plain text are mentions too: slug, id, label, or label without the provider.
assert.deepEqual(ids('run a quick review of the changes with gpt-6-sol on high reasoning'), ['codex:gpt-6-sol']);
assert.equal(parseModelMentions('review with gpt-6-sol', models)[0].bare, true);
assert.deepEqual(ids('have GPT-6.1 Sol look at it'), ['codex:gpt-6.1-sol']);
assert.deepEqual(ids('have gpt 6.1 sol look at it'), ['codex:gpt-6.1-sol']);
assert.deepEqual(ids('delegate to codex:gpt-6.1-sol.'), ['codex:gpt-6.1-sol'], 'a closing period is fine');
assert.deepEqual(ids('(grok 4.7) please'), ['grok:grok-4.7']);
assert.deepEqual(ids('get Opus 5.5 to plan it'), ['claude:claude-opus-5-5']);
assert.deepEqual(ids('get Claude Opus 5.5 to plan it'), ['claude:claude-opus-5-5', 'cursor:claude-opus-5-5']);
assert.deepEqual(ids('compare gpt-6-sol and grok-4.7'), ['codex:gpt-6-sol', 'grok:grok-4.7']);

// A shorter name inside a longer one is not a separate mention.
assert.deepEqual(ids('use Grok 4.7 Fast here'), ['grok:grok-4.7-build-fast']);
assert.deepEqual(ids('use Grok 4.7 Fast, then grok 4.7'), ['grok:grok-4.7', 'grok:grok-4.7-build-fast']);

// Names that run into paths, branches, versions or emails are not mentions,
// and unversioned names never match everyday words.
assert.deepEqual(ids('see src/gpt-6-sol/index.ts'), []);
assert.deepEqual(ids('branch feat-gpt-6-sol'), []);
assert.deepEqual(ids('gpt-6-sol-mini is unknown'), []);
assert.deepEqual(ids('gpt-6-sol.2 is unknown'), []);
assert.deepEqual(ids('mail me@gpt-6-sol'), []);
assert.deepEqual(ids('pick auto mode, orion'), []);

assert.deepEqual(ids('Read C:\\models\\gpt-6-sol\\config.json'), [], 'Windows paths are not mentions');

// An @-mention and the same model's plain name together still hide shorter names.
assert.deepEqual(ids('Use @grok-4.7-build-fast and Grok 4.7 Fast'), ['grok:grok-4.7-build-fast']);
assert.equal(parseModelMentions('@grok-4.7 or grok-4.7', models)[0].bare, undefined, '@ wins over a bare name');

// Against the real catalog: other software with versioned names is not a model,
// unless the provider is named with it.
const real = (text: string) =>
  parseModelMentions(text, fallbackAgentModels).map((mention) => mention.modelId);
assert.deepEqual(real('Use Composer 2.5 to install the PHP dependencies.'), []);
assert.deepEqual(real('Use Apache Spark 1.3 to process this CSV'), []);
assert.deepEqual(real('the K3 board'), []);
assert.deepEqual(real('ask cursor composer 2.5'), ['cursor:composer-2.5']);
assert.deepEqual(real('ask Muse Spark 1.3'), ['muse:muse-spark-1.3']);
assert.deepEqual(real('use gpt-6-sol'), ['codex:gpt-6-sol']);
assert.deepEqual(real('use codex gpt-6.1-sol'), ['codex:gpt-6.1-sol'], 'the provider picks among same-named models');

// Long pasted text parses quickly.
const started = performance.now();
parseModelMentions('Grok 4.7 Fast\n'.repeat(20000), fallbackAgentModels);
const elapsed = performance.now() - started;
assert.ok(elapsed < 2500, `parsing 280 KB took ${Math.round(elapsed)} ms`);

const context = buildModelMentionsContext(parseModelMentions('@grok-4.7 and gpt-6-sol', models));
assert.match(context, /spawn_subagent/);
assert.match(context, /^- @grok-4\.7 → Grok 4\.7 \(grok:grok-4\.7\)$/m);
assert.match(context, /^- gpt-6-sol → GPT-6 Sol \(codex:gpt-6-sol\)$/m);

console.log('model mentions: ok');
