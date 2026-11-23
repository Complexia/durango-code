import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { agentProviders, fallbackAgentModels, type AgentModel } from '../src/agentCatalog';
import {
  buildGeneralInstructionsContext,
  buildOrchestrationContext,
  formatScopedInstructionsBody,
  resolveScopedInstructions,
} from '../src/app/promptContext';
import { InstructionsSetting } from '../src/app/InstructionsSetting';
import { RoleModelPicker } from '../src/app/RoleModelPicker';
import { defaultOrchestrationSettings, useOrionStore, type OrchestrationSettings } from '../src/store';

const neon: AgentModel = {
  id: 'antigravity:gemini-4-neon',
  providerId: 'antigravity',
  providerLabel: 'Antigravity',
  label: 'Gemini 4 Neon',
  slug: 'gemini-4-neon',
};

const flash: AgentModel = {
  id: 'antigravity:gemini-3.8-flash',
  providerId: 'antigravity',
  providerLabel: 'Antigravity',
  label: 'Gemini 3.8 Flash',
  slug: 'gemini-3.8-flash',
};

const claudeOpus: AgentModel = {
  id: 'claude:claude-opus-5-5',
  providerId: 'claude',
  providerLabel: 'Claude',
  label: 'Claude Opus 5.5',
  slug: 'claude-opus-5-5',
};

// 1. Empty settings produce nothing.
assert.equal(
  buildGeneralInstructionsContext(resolveScopedInstructions(defaultOrchestrationSettings, neon)),
  ''
);

// 2. Global-only keeps the exact historical wording with no extra headers.
const globalOnly: OrchestrationSettings = {
  ...defaultOrchestrationSettings,
  generalInstructions: 'Use bun instead of npm.',
};
const globalResolved = resolveScopedInstructions(globalOnly, neon);
assert.equal(formatScopedInstructionsBody(globalResolved), 'Use bun instead of npm.');
const globalContext = buildGeneralInstructionsContext(globalResolved);
assert.match(globalContext, /apply to every agent session run through Durango Code/);
assert.doesNotMatch(globalContext, /\[Provider instructions|\[Model instructions/);

// 3. String overload stays backward compatible.
assert.equal(buildGeneralInstructionsContext('Use bun instead of npm.'), globalContext);

// 4. Provider + model instructions layer cleanly on top of global.
const layered: OrchestrationSettings = {
  ...defaultOrchestrationSettings,
  generalInstructions: 'Use bun.',
  providerInstructions: {
    antigravity: 'Keep summaries concise.',
    claude: 'Prefer small diffs.',
  },
  modelInstructions: {
    'antigravity:gemini-4-neon': 'Skip internal function names in final recaps.',
  },
};

const neonBody = formatScopedInstructionsBody(resolveScopedInstructions(layered, neon));
assert.equal(
  neonBody,
  [
    'Use bun.',
    '[Provider instructions — Antigravity]\nKeep summaries concise.',
    '[Model instructions — Gemini 4 Neon]\nSkip internal function names in final recaps.',
  ].join('\n\n')
);

const neonContext = buildGeneralInstructionsContext(resolveScopedInstructions(layered, neon));
assert.match(neonContext, /provider- and model-specific sections layer on top of general ones/);
assert.match(neonContext, /\[Provider instructions — Antigravity\]/);
assert.match(neonContext, /\[Model instructions — Gemini 4 Neon\]/);

// 5. Sibling model in the same provider inherits global + provider, NOT neon's model instructions.
const flashBody = formatScopedInstructionsBody(resolveScopedInstructions(layered, flash));
assert.equal(
  flashBody,
  ['Use bun.', '[Provider instructions — Antigravity]\nKeep summaries concise.'].join('\n\n')
);

// 6. Different provider gets its own provider instructions, not Antigravity's.
const opusBody = formatScopedInstructionsBody(resolveScopedInstructions(layered, claudeOpus));
assert.equal(
  opusBody,
  ['Use bun.', '[Provider instructions — Claude]\nPrefer small diffs.'].join('\n\n')
);

// 7. Model-only (without global or provider) still emits a valid context block.
const modelOnly: OrchestrationSettings = {
  ...defaultOrchestrationSettings,
  generalInstructions: '   ',
  providerInstructions: { antigravity: '  ' },
  modelInstructions: { 'antigravity:gemini-4-neon': 'High-level recap only.' },
};
const modelOnlyContext = buildGeneralInstructionsContext(resolveScopedInstructions(modelOnly, neon));
assert.match(modelOnlyContext, /^\[Orion general instructions\]/);
assert.match(modelOnlyContext, /\[Model instructions — Gemini 4 Neon\]\nHigh-level recap only\./);
assert.doesNotMatch(modelOnlyContext, /\[Provider instructions/);

// 8. Orchestration context includes the formatted layered instructions body.
const orchContext = buildOrchestrationContext(
  [{ role: 'implementation', modelLabel: 'GPT-6.1 Sol', slug: 'gpt-6.1-sol' }],
  opusBody,
  'full-access'
);
assert.match(orchContext, /Use bun\./);
assert.match(orchContext, /\[Provider instructions — Claude\]\nPrefer small diffs\./);

// 9. UI renders without any native <select> element and shows configured scope pills.
const modelGroups = agentProviders
  .filter((provider) => provider.id === 'claude' || provider.id === 'antigravity')
  .map((provider) => ({
    provider,
    models: [
      ...fallbackAgentModels.filter((model) => model.providerId === provider.id),
      ...(provider.id === 'antigravity' ? [neon] : []),
    ],
  }));

const markup = renderToStaticMarkup(
  <InstructionsSetting
    settings={layered}
    modelGroups={modelGroups}
    onChangeGlobal={() => {}}
    onChangeProvider={() => {}}
    onChangeModel={() => {}}
  />
);
assert.doesNotMatch(markup, /<select\b/i, 'must use custom Tailwind dropdown, never <select>');
assert.match(markup, /aria-haspopup="listbox"/);
assert.match(markup, /All models/);
assert.match(markup, /All Antigravity/);
assert.match(markup, /Gemini 4 Neon/);
assert.match(markup, /All Claude/);
assert.match(markup, /Use bun\./);

// 9b. The Claude Code CLI terminal can carry its own model instructions: it is
// listed with the Claude models and its saved text resolves for terminal runs.
const cliModel = fallbackAgentModels.find((model) => model.id === 'claude:claude-code-cli');
assert.ok(cliModel, 'Claude Code CLI model is in the catalog');
const withCli: OrchestrationSettings = {
  ...layered,
  modelInstructions: { ...layered.modelInstructions, 'claude:claude-code-cli': 'Terminal only.' },
};
const cliMarkup = renderToStaticMarkup(
  <InstructionsSetting
    settings={withCli}
    modelGroups={modelGroups}
    onChangeGlobal={() => {}}
    onChangeProvider={() => {}}
    onChangeModel={() => {}}
  />
);
assert.match(cliMarkup, /Claude Code CLI/);
assert.doesNotMatch(cliMarkup, /<select\b/i);
const cliBody = formatScopedInstructionsBody(
  resolveScopedInstructions(withCli, {
    id: 'claude:claude-code-cli',
    providerId: 'claude',
    providerLabel: 'Claude',
    label: 'Claude Code CLI',
  })
);
assert.match(cliBody, /\[Model instructions — Claude Code CLI\]\nTerminal only\./);

// 9c. Orchestration role pickers use the shared model picker, not <select>.
const roleMarkup = renderToStaticMarkup(
  <RoleModelPicker label="Main driver" modelGroups={modelGroups} value="claude:claude-opus-5-5" onChange={() => {}} />
);
assert.doesNotMatch(roleMarkup, /<select\b/i);
assert.match(roleMarkup, /Claude Opus 5\.5/);

// 10. Store actions update and prune scoped instructions without clobbering sibling scopes.
const store = useOrionStore.getState();
store.setOrchestrationGeneralInstructions('Use bun.');
store.setOrchestrationProviderInstructions('antigravity', 'Be brief.');
store.setOrchestrationModelInstructions('antigravity:gemini-4-neon', 'Skip function names.');

let next = useOrionStore.getState().orchestrationSettings;
assert.equal(next.generalInstructions, 'Use bun.');
assert.equal(next.providerInstructions?.antigravity, 'Be brief.');
assert.equal(next.modelInstructions?.['antigravity:gemini-4-neon'], 'Skip function names.');

// Clearing a provider/model scope removes its key while leaving other scopes intact.
store.setOrchestrationProviderInstructions('antigravity', '');
next = useOrionStore.getState().orchestrationSettings;
assert.equal('antigravity' in (next.providerInstructions ?? {}), false);
assert.equal(next.generalInstructions, 'Use bun.');
assert.equal(next.modelInstructions?.['antigravity:gemini-4-neon'], 'Skip function names.');

store.setOrchestrationModelInstructions('antigravity:gemini-4-neon', '');
next = useOrionStore.getState().orchestrationSettings;
assert.equal('antigravity:gemini-4-neon' in (next.modelInstructions ?? {}), false);
assert.equal(next.generalInstructions, 'Use bun.');

// Changing an orchestration role model preserves scoped instructions.
store.setOrchestrationProviderInstructions('claude', 'Prefer concise answers.');
store.setOrchestrationRoleModel('exploring', 'claude:claude-haiku-5-5');
next = useOrionStore.getState().orchestrationSettings;
assert.equal(next.providerInstructions?.claude, 'Prefer concise answers.');

console.log('scoped instructions tests passed');
