// Agent env for Durango Source model attribution (src/main/durango-agent-env.js).
import assert from 'node:assert/strict';
import { codexAgentEnvConfig, durangoAgentEnv, durangoModelLabel } from '../src/main/durango-agent-env.js';

const opus = { id: 'claude:claude-opus-5-5', providerId: 'claude', providerLabel: 'Claude', label: 'Claude Opus 5.5' };
const sol = { id: 'codex:gpt-5.6-sol', providerId: 'codex', providerLabel: 'Codex', label: 'GPT-5.6 Sol' };
const agyOpus = { id: 'antigravity:claude-opus-5-5', providerId: 'antigravity', providerLabel: 'Antigravity', label: 'Claude Opus 5.5' };

assert.equal(durangoModelLabel(opus), 'Claude Opus 5.5');
assert.equal(durangoModelLabel(sol), 'Codex GPT-5.6 Sol');
assert.equal(durangoModelLabel(agyOpus), 'Antigravity Claude Opus 5.5');
assert.equal(durangoModelLabel({ id: 'kimi:kimi-code/k3', providerLabel: 'Kimi', label: 'K3' }), 'Kimi K3');
assert.equal(durangoModelLabel({ id: 'x:y' }), '');

assert.deepEqual(durangoAgentEnv({ threadId: 'thread-1', model: sol }), {
  DURANGO_THREAD_ID: 'thread-1',
  DURANGO_MODEL: 'codex:gpt-5.6-sol',
  DURANGO_MODEL_LABEL: 'Codex GPT-5.6 Sol',
});
// No thread (a utility run) still names the model; a malformed id is left out.
assert.deepEqual(durangoAgentEnv({ threadId: null, model: opus }), { DURANGO_MODEL: 'claude:claude-opus-5-5', DURANGO_MODEL_LABEL: 'Claude Opus 5.5' });
assert.deepEqual(durangoAgentEnv({ threadId: 't', model: { id: 'Claude Opus', label: 'x' } }), { DURANGO_THREAD_ID: 't' });
assert.deepEqual(durangoAgentEnv(), {});

assert.deepEqual(codexAgentEnvConfig(durangoAgentEnv({ threadId: 'thread-1', model: sol })), {
  'shell_environment_policy.set.DURANGO_THREAD_ID': 'thread-1',
  'shell_environment_policy.set.DURANGO_MODEL': 'codex:gpt-5.6-sol',
  'shell_environment_policy.set.DURANGO_MODEL_LABEL': 'Codex GPT-5.6 Sol',
});
console.log('durango agent env: ok');
