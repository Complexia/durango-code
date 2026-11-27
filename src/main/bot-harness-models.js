// Which Durango bot models this machine can answer with, and on which harness.
//
// A Durango bot is set to a Durango model id ("openai/gpt-6.1-sol",
// "google/gemini-4-neon", …). A machine answers a bot's replies on its own
// harnesses, the ones Durango Code threads use: Claude Code for Claude,
// Codex for OpenAI's GPT models, Antigravity for Gemini, Grok for xAI's Grok
// and Muse Code for Meta's Muse. This maps the harnesses' models (the app's
// model list, models.js) to Durango ids and back. Pure, no Electron.

/** What a machine advertises for "any Claude model" (chat/convex/botPolicy.ts BOT_LOCAL_CLAUDE_WILDCARD). */
export const BOT_LOCAL_CLAUDE_WILDCARD = 'anthropic/*';

/** The harnesses a bot reply can run on here, besides Claude Code. */
export const BOT_HARNESS_PROVIDERS = ['codex', 'antigravity', 'grok', 'muse'];

export const BOT_HARNESS_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  grok: 'Grok',
  muse: 'Muse',
};

// Muse Code slugs whose Durango catalog id differs (andromedus lib/model-gateway-ids.ts).
const MUSE_DURANGO_ALIASES = { 'muse-wonder-1.0': 'meta/muse-wonder' };
const MUSE_LOCAL_ALIASES = Object.fromEntries(Object.entries(MUSE_DURANGO_ALIASES).map(([slug, id]) => [id, slug]));

const SLUG = /^[a-z0-9][a-z0-9._-]{0,78}$/i;

/**
 * A harness model (models.js entry: { providerId, slug }) as the Durango
 * model id a bot can be set to, or null when Durango has no such id (an
 * Antigravity-hosted Claude, the Claude Code CLI pseudo-model, …).
 */
export const durangoIdForHarnessModel = (model) => {
  const providerId = typeof model?.providerId === 'string' ? model.providerId : '';
  const slug = typeof model?.slug === 'string' ? model.slug.trim().toLowerCase() : '';
  if (!slug || !SLUG.test(slug)) return null;
  switch (providerId) {
    case 'codex':
      return /^(?:gpt|o\d)/.test(slug) ? `openai/${slug}` : null;
    case 'antigravity':
      // Antigravity also serves other labs' models: only Gemini is Google's own here.
      return slug.startsWith('gemini-') ? `google/${slug}` : null;
    case 'grok':
      return slug.startsWith('grok-') ? `x-ai/${slug}` : null;
    case 'muse':
      return MUSE_DURANGO_ALIASES[slug] ?? (slug.startsWith('muse-') ? `meta/${slug}` : null);
    default:
      return null;
  }
};

/**
 * The Durango model ids this machine answers bots with (its claim's
 * `machine.localModels`): BOT_LOCAL_CLAUDE_WILDCARD while Claude Code is
 * available, and every available Codex, Antigravity, Grok and Muse model
 * with a Durango id. `models`: listDispatchModels() rows ({ id, providerId,
 * slug, available }). `down(providerId)`: a harness that just failed for a
 * reason a retry won't fix soon (signed out, a usage limit), left out for now.
 */
export const localBotModelIds = (models, { down = () => false } = {}) => {
  const ids = new Set();
  for (const model of Array.isArray(models) ? models : []) {
    if (!model || model.available === false) continue;
    if (down(model.providerId)) continue;
    if (model.providerId === 'claude') {
      if (model.slug !== 'claude-code-cli') ids.add(BOT_LOCAL_CLAUDE_WILDCARD);
      continue;
    }
    const id = durangoIdForHarnessModel(model);
    if (id) ids.add(id);
  }
  return [...ids].sort((a, b) => Number(b === BOT_LOCAL_CLAUDE_WILDCARD) - Number(a === BOT_LOCAL_CLAUDE_WILDCARD) || a.localeCompare(b)).slice(0, 80);
};

/**
 * The harness model for a lane's Durango model id → { providerId, model } (the
 * models.js entry), or null when no available harness here has it. Claude
 * models aren't resolved here: they run on Claude Code (createClaudeLaneRunner).
 */
export const harnessModelFor = (models, durangoModelId) => {
  const wanted = String(durangoModelId ?? '').trim().toLowerCase();
  if (!wanted || wanted.startsWith('anthropic/')) return null;
  const museSlug = MUSE_LOCAL_ALIASES[wanted];
  for (const model of Array.isArray(models) ? models : []) {
    if (!model || model.available === false || !BOT_HARNESS_PROVIDERS.includes(model.providerId)) continue;
    if (durangoIdForHarnessModel(model) === wanted || (museSlug && model.providerId === 'muse' && model.slug === museSlug)) {
      return { providerId: model.providerId, model };
    }
  }
  return null;
};

/** Labels for the bot model picker: Durango id → the harness that runs it here ("Codex", …). */
export const localBotModelHarnesses = (models, options) => {
  const out = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    if (!model || model.available === false || options?.down?.(model.providerId)) continue;
    const id = durangoIdForHarnessModel(model);
    if (id && !out.has(id)) out.set(id, BOT_HARNESS_LABELS[model.providerId] ?? model.providerId);
  }
  return out;
};

const MUSE_BOT_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/**
 * A lane's reasoning effort for a Grok or Muse model (`clamp`: models.js
 * clampReasoningEffort). Grok: only a model that lists reasoning tiers takes
 * --reasoning-effort (null: none passed). Muse: the model's own tiers when it
 * lists them, else every tier Muse takes.
 */
export const grokOrMuseBotEffort = (providerId, model, wanted, clamp) => {
  const listed = Array.isArray(model?.reasoningEfforts) && model.reasoningEfforts.length ? model.reasoningEfforts : null;
  if (providerId === 'grok') return listed ? clamp(wanted || null, listed, null) : null;
  const efforts = listed ?? MUSE_BOT_EFFORTS;
  return clamp(wanted || null, efforts, efforts.includes('high') ? 'high' : efforts[efforts.length - 1]);
};
