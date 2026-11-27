// Environment an agent run gets so the `durango-code` CLI can tell Durango
// Source which thread and model made a change: DURANGO_THREAD_ID (Durango
// Tasks follow the change through that thread), DURANGO_MODEL
// ("<providerId>:<slug>", e.g. claude:claude-opus-5-5) and DURANGO_MODEL_LABEL
// ("Claude Opus 5.5", "Codex GPT-5.6 Sol"). The CLI sends them as the
// revision's `agent` on `change create` / `change amend`; the change page lists
// every model that worked on the change.

/** The label Durango Source shows: the model's label, led by the harness unless it already starts with it. */
export const durangoModelLabel = (model) => {
  const label = typeof model?.label === 'string' ? model.label.replace(/\s+/g, ' ').trim() : '';
  if (!label) return '';
  const harness = typeof model?.providerLabel === 'string' ? model.providerLabel.trim() : '';
  if (!harness || label.toLowerCase().startsWith(harness.toLowerCase())) return label;
  return `${harness} ${label}`;
};

/**
 * DURANGO_THREAD_ID / DURANGO_MODEL / DURANGO_MODEL_LABEL for a run of
 * `model` in `threadId`; keys without a value are left out.
 */
export const durangoAgentEnv = ({ threadId, model } = {}) => {
  const env = {};
  if (typeof threadId === 'string' && threadId) env.DURANGO_THREAD_ID = threadId;
  const id = typeof model?.id === 'string' ? model.id : '';
  if (/^[a-z][a-z0-9-]*:\S+$/.test(id)) {
    env.DURANGO_MODEL = id;
    const label = durangoModelLabel(model);
    if (label) env.DURANGO_MODEL_LABEL = label;
  }
  return env;
};

/**
 * The same values as Codex config overrides, for runs on Orion's shared Codex
 * app-server (one process for every thread, so its environment can't carry
 * them): `shell_environment_policy.set.<NAME>` adds them to the commands of
 * this thread only, keeping the user's own policy.
 */
export const codexAgentEnvConfig = (agentEnv) =>
  Object.fromEntries(Object.entries(agentEnv).map(([name, value]) => [`shell_environment_policy.set.${name}`, value]));
