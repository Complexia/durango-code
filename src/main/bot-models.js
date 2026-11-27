import { durangoModelIdForClaude } from './bot-replies.js';
import { LOCAL_BOT_REASONING_EFFORTS } from './local-bots.js';

const CLAUDE_CODE_CLI_SLUG = 'claude-code-cli';
const CLAUDE_EFFORTS = [...LOCAL_BOT_REASONING_EFFORTS];
/** Mirrors chat/convex/botPolicy.ts `isClaudeBotModel`: Claude 5+ non-fast models runnable in Claude Code. */
const LOCAL_CLAUDE_DURANGO_ID = /^anthropic\/claude-(?:opus|sonnet|haiku|fable)-(?:5(?:\.\d{1,2})?|[6-9](?:\.\d{1,2})?)$/;

const isLocalClaudeSlug = (slug) =>
  typeof slug === 'string' && /^claude-[a-z0-9-]{2,60}$/i.test(slug.trim()) && slug.trim().toLowerCase() !== CLAUDE_CODE_CLI_SLUG;

const normalizeDiscoveredEfforts = (efforts) => {
  if (!Array.isArray(efforts) || efforts.length === 0) return CLAUDE_EFFORTS;
  const allowed = new Set(CLAUDE_EFFORTS);
  const filtered = efforts.filter((effort) => typeof effort === 'string' && allowed.has(effort));
  return filtered.length > 0 ? filtered : CLAUDE_EFFORTS;
};

/**
 * Combines the server's recommended/cloud bot model catalog with what this
 * machine's Claude Code can actually run locally.
 *
 * Truthful routing rule (chat/convex/botPolicy.ts `isClaudeBotModel` +
 * chat/convex/bots.ts `routeLane`): only Claude models run locally through
 * Claude Code; every other provider routes to Durango's cloud.
 */
export function mergeDesktopBotModelCatalog({
  mode,
  modelChoices,
  modelCatalog,
  localClaudeModels = [],
}) {
  const discovered = (Array.isArray(localClaudeModels) ? localClaudeModels : []).filter((item) =>
    isLocalClaudeSlug(item?.slug)
  );

  if (mode === 'local') {
    const base = Array.isArray(modelChoices) ? modelChoices : [];
    const out = base.map((choice) => ({
      ...choice,
      provider: choice.provider || 'Anthropic',
      lab: choice.lab || 'anthropic',
      claude: true,
      local: true,
      recommended: choice.recommended !== false,
    }));
    const seen = new Set(out.map((choice) => choice.id));
    for (const item of discovered) {
      const slug = item.slug.trim();
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({
        id: slug,
        label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : slug,
        note: 'Claude Code on this machine',
        provider: 'Anthropic',
        lab: 'anthropic',
        claude: true,
        local: true,
        recommended: false,
        efforts: normalizeDiscoveredEfforts(item.reasoningEfforts),
        defaultEffort: /haiku/i.test(slug) ? 'medium' : 'high',
      });
    }
    return out;
  }

  // Signed in ("durango"): merge full cloud catalog (or fallback to recommended choices)
  // with the Claude models discovered in this machine's Claude Code catalog.
  const recommended = Array.isArray(modelChoices) ? modelChoices : [];
  const recommendedIds = new Set(recommended.map((choice) => choice.id));
  const rawCatalog = Array.isArray(modelCatalog) && modelCatalog.length > 0 ? modelCatalog : recommended;
  const discoveredByDurangoId = new Map();
  for (const item of discovered) {
    const durangoId = durangoModelIdForClaude(item.slug);
    if (!durangoId || !LOCAL_CLAUDE_DURANGO_ID.test(durangoId)) continue;
    if (!discoveredByDurangoId.has(durangoId)) discoveredByDurangoId.set(durangoId, item);
  }

  const isRunnableLocally = (choice) => {
    if (!choice.claude) return false;
    // Align strictly with server routeLane (`isClaudeBotModel` in botPolicy.ts):
    // every Claude 5+ non-fast model routes to local Claude Code; `-fast` and legacy 4.x route to Cloud.
    return LOCAL_CLAUDE_DURANGO_ID.test(choice.id);
  };

  const out = [];
  const seen = new Set();

  const pushChoice = (choice, isRec) => {
    if (!choice?.id || seen.has(choice.id)) return;
    seen.add(choice.id);
    const claude = typeof choice.claude === 'boolean' ? choice.claude : LOCAL_CLAUDE_DURANGO_ID.test(choice.id);
    const normalized = {
      ...choice,
      claude,
      recommended: isRec || choice.recommended === true,
      provider: choice.provider || (choice.id.startsWith('anthropic/') ? 'Anthropic' : choice.id.split('/')[0] || 'Other'),
      lab: choice.lab || (choice.id.startsWith('anthropic/') ? 'anthropic' : choice.id.split('/')[0] || 'other'),
    };
    out.push({
      ...normalized,
      local: isRunnableLocally(normalized),
    });
  };

  for (const choice of recommended) pushChoice(choice, true);
  for (const choice of rawCatalog) pushChoice(choice, recommendedIds.has(choice.id));

  // Include any Claude model installed locally that isn't in the cloud snapshot yet.
  for (const [durangoId, item] of discoveredByDurangoId.entries()) {
    if (seen.has(durangoId)) continue;
    seen.add(durangoId);
    out.push({
      id: durangoId,
      label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : item.slug,
      note: 'Anthropic',
      provider: 'Anthropic',
      lab: 'anthropic',
      claude: true,
      local: true,
      recommended: false,
      efforts: normalizeDiscoveredEfforts(item.reasoningEfforts),
      defaultEffort: /haiku/i.test(durangoId) ? 'medium' : 'high',
    });
  }

  return out;
}
