import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkCommandAvailable, execFileAsync, shellPathSyncPromise } from './shell-env.js';

// Canonical low→high order of every reasoning tier any harness advertises.
export const reasoningEffortTiers = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// Keep an effort the model supports; otherwise step down to the nearest tier
// it does support (Ultra → Max → Extra High), or use the model's default.
export const clampReasoningEffort = (effort, efforts, fallback) => {
  if (!effort) return fallback;
  if (efforts.includes(effort)) return effort;
  for (let rank = reasoningEffortTiers.indexOf(effort) - 1; rank >= 0; rank -= 1) {
    if (efforts.includes(reasoningEffortTiers[rank])) return reasoningEffortTiers[rank];
  }
  return fallback;
};

// Effort tiers discovered from a provider's live catalog, when there are any.
export const discoveredReasoningEfforts = (model) =>
  Array.isArray(model?.reasoningEfforts) && model.reasoningEfforts.length > 0 ? model.reasoningEfforts : null;

export const defaultCodexReasoningEffort = 'medium';
// Static Codex tiers for when the CLI's models_cache.json is unavailable
// (mirrors that cache as of Codex 0.163). The GPT-6 and GPT-5.6 families
// accept Max and Ultra, except Luna, which stops at Max; Sol models default to
// Low, everything else to Medium.
export const gpt56CodexModelSlugs = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
export const gpt6CodexModelSlugs = new Set(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']);
const codexLowDefaultModelSlugs = new Set(['gpt-6.1-sol', 'gpt-5.6-sol']);
const codexNoUltraModelSlugs = new Set(['gpt-6-luna', 'gpt-5.6-luna']);
export const codexReasoningEffortsForModel = (model) => {
  const discovered = discoveredReasoningEfforts(model);
  if (discovered) return discovered;
  if (!gpt6CodexModelSlugs.has(model.slug) && !gpt56CodexModelSlugs.has(model.slug)) {
    return ['low', 'medium', 'high', 'xhigh'];
  }
  return codexNoUltraModelSlugs.has(model.slug)
    ? ['low', 'medium', 'high', 'xhigh', 'max']
    : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
};
export const codexDefaultReasoningEffortForModel = (model) =>
  model.defaultReasoningEffort ||
  (codexLowDefaultModelSlugs.has(model.slug) ? 'low' : defaultCodexReasoningEffort);
export const codexReasoningEffortForModel = (model, effort) =>
  clampReasoningEffort(effort, codexReasoningEffortsForModel(model), codexDefaultReasoningEffortForModel(model));
export const defaultCodexServiceTier = 'default';
export const defaultClaudeReasoningEffort = 'high';
// Matches the muse CLI's own --reasoning-effort default.
export const defaultMuseReasoningEffort = 'high';
export const defaultClaudeContextWindow = '200k';
export const claudeOneMillionContextModels = new Set([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5',
  'claude-opus-5',
]);

// Cursor's CLI catalog is account-backed, but its raw order currently starts
// with legacy Codex 5.3 variants. Pin one representative from each current
// frontier family ahead of that raw order while retaining every discovered
// model below them.
export const cursorFrontierModelSlugs = [
  'auto',
  'cursor-grok-4.6-high-fast',
  'claude-opus-5-thinking-high',
  'claude-fable-5-thinking-high',
  'claude-sonnet-5-thinking-high',
  'gpt-5.6-sol-high',
  'gpt-5.6-terra-high',
  'gpt-5.6-luna-high',
  'kimi-k3-high',
  'gemini-3.6-flash-high',
  'composer-2.5',
];

const cursorFrontierModelRank = new Map(
  cursorFrontierModelSlugs.map((slug, index) => [slug, index])
);

export const sortCursorModels = (models) =>
  models
    .map((model, index) => ({ model, index }))
    .sort((a, b) => {
      const aRank = cursorFrontierModelRank.get(a.model.slug);
      const bRank = cursorFrontierModelRank.get(b.model.slug);
      if (aRank !== undefined || bRank !== undefined) {
        if (aRank === undefined) return 1;
        if (bRank === undefined) return -1;
        return aRank - bRank;
      }
      return a.index - b.index;
    })
    .map(({ model }) => model);

export const cursorFallbackModels = [
  {
    id: 'cursor:auto',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Auto',
    slug: 'auto',
    command: 'cursor-agent',
    favorite: true,
  },
  {
    id: 'cursor:cursor-grok-4.6-high-fast',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Cursor Grok 4.6 Fast',
    slug: 'cursor-grok-4.6-high-fast',
    command: 'cursor-agent',
    favorite: true,
  },
  {
    id: 'cursor:claude-opus-5-thinking-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Opus 5 1M Thinking',
    slug: 'claude-opus-5-thinking-high',
    command: 'cursor-agent',
  },
  {
    id: 'cursor:claude-fable-5-thinking-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Fable 5 1M Thinking (NO ZDR)',
    slug: 'claude-fable-5-thinking-high',
    command: 'cursor-agent',
  },
  {
    id: 'cursor:claude-sonnet-5-thinking-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Sonnet 5 1M Thinking',
    slug: 'claude-sonnet-5-thinking-high',
    command: 'cursor-agent',
  },
  {
    id: 'cursor:gpt-5.6-sol-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'GPT-5.6 Sol 1M High',
    slug: 'gpt-5.6-sol-high',
    command: 'cursor-agent',
  },
  {
    id: 'cursor:gpt-5.6-terra-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'GPT-5.6 Terra 1M High',
    slug: 'gpt-5.6-terra-high',
    command: 'cursor-agent',
  },
  {
    id: 'cursor:gpt-5.6-luna-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'GPT-5.6 Luna 1M High',
    slug: 'gpt-5.6-luna-high',
    command: 'cursor-agent',
  },
  {
    id: 'cursor:kimi-k3-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Kimi K3 High',
    slug: 'kimi-k3-high',
    command: 'cursor-agent',
  },
  {
    id: 'cursor:gemini-3.6-flash-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Gemini 3.6 Flash',
    slug: 'gemini-3.6-flash-high',
    command: 'cursor-agent',
  },
  {
    id: 'cursor:composer-2.5',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Composer 2.5',
    slug: 'composer-2.5',
    command: 'cursor-agent',
    favorite: true,
  },
  {
    id: 'cursor:cursor-grok-4.5-high-fast',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Cursor Grok 4.5 Fast',
    slug: 'cursor-grok-4.5-high-fast',
    command: 'cursor-agent',
  },
  {
    id: 'cursor:claude-opus-4-8-thinking-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Opus 4.8 1M Thinking',
    slug: 'claude-opus-4-8-thinking-high',
    command: 'cursor-agent',
  },
  {
    id: 'cursor:gpt-5.5-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'GPT-5.5 1M High',
    slug: 'gpt-5.5-high',
    command: 'cursor-agent',
  },
];

// Kimi Code's managed models (K3.1 Pro shipped 2026-10-23), in the order
// listKimiModels pins them; the live list (including any user-added
// providers) comes from `kimi provider list --json` and replaces this block.
export const kimiFallbackModels = [
  {
    id: 'kimi:kimi-code/k3.1-pro',
    providerId: 'kimi',
    providerLabel: 'Kimi',
    label: 'K3.1 Pro',
    slug: 'kimi-code/k3.1-pro',
    command: 'kimi',
    shortcut: '⌘1',
    favorite: true,
  },
  {
    id: 'kimi:kimi-code/k3.1-pro-highspeed',
    providerId: 'kimi',
    providerLabel: 'Kimi',
    label: 'K3.1 Pro Highspeed',
    slug: 'kimi-code/k3.1-pro-highspeed',
    command: 'kimi',
    shortcut: '⌘2',
  },
  {
    id: 'kimi:kimi-code/k3',
    providerId: 'kimi',
    providerLabel: 'Kimi',
    label: 'K3',
    slug: 'kimi-code/k3',
    command: 'kimi',
    shortcut: '⌘3',
    favorite: true,
  },
  {
    id: 'kimi:kimi-code/kimi-for-coding',
    providerId: 'kimi',
    providerLabel: 'Kimi',
    label: 'K2.8 Preview',
    slug: 'kimi-code/kimi-for-coding',
    command: 'kimi',
    shortcut: '⌘4',
  },
  {
    id: 'kimi:kimi-code/kimi-for-coding-highspeed',
    providerId: 'kimi',
    providerLabel: 'Kimi',
    label: 'K2.7 Code Highspeed',
    slug: 'kimi-code/kimi-for-coding-highspeed',
    command: 'kimi',
    shortcut: '⌘5',
  },
  {
    id: 'kimi:kimi-code/k3-256k',
    providerId: 'kimi',
    providerLabel: 'Kimi',
    label: 'K3-256k',
    slug: 'kimi-code/k3-256k',
    command: 'kimi',
    shortcut: '⌘6',
  },
];

// Muse Code (Meta) ships the Muse Wonder and Muse Spark families. Wonder Full
// is subscription-only (Power/Maximum plans) and never appears in the API.
// Each Spark generation comes in two tiers: the standard model and a
// discounted "contributor" tier whose sessions may be used by Meta for
// product improvement. The CLI caches the provider's live catalog on disk
// after each run, which listMuseModels reads to replace this block; these
// are the current rows as of Muse Code 1.4.12.
export const museFallbackModelSpecs = [
  ['muse-wonder-full-1.0', 'Muse Wonder Full 1.0'],
  ['muse-wonder-1.0', 'Muse Wonder 1.0'],
  ['muse-spark-1.3', 'Muse Spark 1.3'],
  ['muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor'],
  ['muse-spark-1.2', 'Muse Spark 1.2'],
  ['muse-spark-1.2-contributor', 'Muse Spark 1.2 Contributor'],
];

export const museFavoriteModelSlugs = new Set([
  'muse-wonder-1.0',
  'muse-spark-1.3',
  'muse-spark-1.3-contributor',
]);

export const museFallbackModels = museFallbackModelSpecs.map(([slug, label], index) => ({
  id: `muse:${slug}`,
  providerId: 'muse',
  providerLabel: 'Muse',
  label,
  slug,
  command: 'muse',
  ...(index < 9 ? { shortcut: `⌘${index + 1}` } : {}),
  favorite: museFavoriteModelSlugs.has(slug),
}));

// OpenCode exposes the models that are actually usable with the current
// installation (built-in Zen models plus models from configured providers)
// through `opencode models`. Keep its current built-ins as a launch fallback;
// live discovery replaces this entire block whenever the CLI is available.
export const openCodeFallbackModels = [
  ['opencode/flint-40b-free', 'Flint 40B Free', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['opencode/nemotron-3.5-super-vl-free', 'Nemotron 3.5 Super VL Free', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']],
  ['opencode/beam-free', 'Beam Free', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['opencode/mimo-v2.6-flash-free', 'MiMo-V2.6-Flash Free', []],
  ['opencode/deepseek-v4.1-flash-free', 'DeepSeek V4.1 Flash Free', ['low', 'high', 'max']],
  ['opencode/glm-5.3-flash-free', 'GLM-5.3-Flash Free', ['low', 'high', 'max']],
  ['opencode/nemotron-3.5-lightning-free', 'Nemotron 3.5 Lightning Free', []],
  ['opencode/nemotron-3-ultra-free', 'Nemotron 3 Ultra Free', []],
  ['opencode/big-pickle', 'Big Pickle', []],
].map(([slug, label, reasoningVariants], index) => ({
  id: `opencode:${slug}`,
  providerId: 'opencode',
  providerLabel: 'OpenCode',
  label,
  slug,
  command: 'opencode',
  ...(reasoningVariants.length > 0 ? { reasoningVariants } : {}),
  ...(index < 9 ? { shortcut: `⌘${index + 1}` } : {}),
  favorite: slug === 'opencode/big-pickle',
}));

// Embedded-terminal pseudo-model: the thread runs the interactive `claude`
// TUI in a PTY (see the terminal:* IPC handlers), never agent:runTurn. Live
// Claude discovery re-appends it after the discovered models.
export const claudeCodeCliModel = {
  id: 'claude:claude-code-cli',
  providerId: 'claude',
  providerLabel: 'Claude',
  label: 'Claude Code CLI',
  slug: 'claude-code-cli',
  command: 'claude',
};

export const agentModels = [
  // Pseudo-model: the renderer resolves it to the configured main-driver
  // model (and attaches an `orchestration` payload) before agent:runTurn.
  // No `command` — agent:listModels reports it as always available.
  {
    id: 'orion:orchestrator',
    providerId: 'orion',
    providerLabel: 'Durango Code',
    label: 'Durango Code',
    slug: 'orion',
  },
  {
    id: 'grok:grok-4.7',
    providerId: 'grok',
    providerLabel: 'Grok',
    label: 'Grok 4.7',
    slug: 'grok-4.7',
    command: 'grok',
    shortcut: '⌘1',
    favorite: true,
  },
  {
    // The CLI's model id for the fast variant is `grok-4.7-build-fast`
    // (advertised as "Grok 4.7 Fast — 2x the price").
    id: 'grok:grok-4.7-build-fast',
    providerId: 'grok',
    providerLabel: 'Grok',
    label: 'Grok 4.7 Fast',
    slug: 'grok-4.7-build-fast',
    command: 'grok',
    shortcut: '⌘2',
  },
  {
    id: 'grok:grok-4.6',
    providerId: 'grok',
    providerLabel: 'Grok',
    label: 'Grok 4.6',
    slug: 'grok-4.6',
    command: 'grok',
    shortcut: '⌘3',
  },
  {
    id: 'grok:grok-4.5',
    providerId: 'grok',
    providerLabel: 'Grok',
    label: 'Grok 4.5',
    slug: 'grok-4.5',
    command: 'grok',
    shortcut: '⌘4',
  },
  // Codex's own priority order (models_cache.json); live discovery replaces
  // this block whenever the CLI has cached its catalog.
  {
    id: 'codex:gpt-6.1-sol',
    providerId: 'codex',
    providerLabel: 'Codex',
    label: 'GPT-6.1 Sol',
    slug: 'gpt-6.1-sol',
    command: 'codex',
  },
  {
    id: 'codex:gpt-6-astra',
    providerId: 'codex',
    providerLabel: 'Codex',
    label: 'GPT-6 Astra',
    slug: 'gpt-6-astra',
    command: 'codex',
  },
  {
    id: 'codex:gpt-6-sol',
    providerId: 'codex',
    providerLabel: 'Codex',
    label: 'GPT-6 Sol',
    slug: 'gpt-6-sol',
    command: 'codex',
  },
  {
    id: 'codex:gpt-6-luna',
    providerId: 'codex',
    providerLabel: 'Codex',
    label: 'GPT-6 Luna',
    slug: 'gpt-6-luna',
    command: 'codex',
  },
  {
    id: 'codex:gpt-5.6-sol',
    providerId: 'codex',
    providerLabel: 'Codex',
    label: 'GPT-5.6 Sol',
    slug: 'gpt-5.6-sol',
    command: 'codex',
  },
  {
    id: 'codex:gpt-5.6-terra',
    providerId: 'codex',
    providerLabel: 'Codex',
    label: 'GPT-5.6 Terra',
    slug: 'gpt-5.6-terra',
    command: 'codex',
  },
  {
    id: 'codex:gpt-5.6-luna',
    providerId: 'codex',
    providerLabel: 'Codex',
    label: 'GPT-5.6 Luna',
    slug: 'gpt-5.6-luna',
    command: 'codex',
  },
  {
    id: 'claude:claude-fable-5-1',
    providerId: 'claude',
    providerLabel: 'Claude',
    label: 'Claude Fable 5.1',
    slug: 'claude-fable-5-1',
    command: 'claude',
    shortcut: '⌘1',
  },
  {
    id: 'claude:claude-opus-5-5',
    providerId: 'claude',
    providerLabel: 'Claude',
    label: 'Claude Opus 5.5',
    slug: 'claude-opus-5-5',
    command: 'claude',
    shortcut: '⌘2',
  },
  {
    id: 'claude:claude-sonnet-5-5',
    providerId: 'claude',
    providerLabel: 'Claude',
    label: 'Claude Sonnet 5.5',
    slug: 'claude-sonnet-5-5',
    command: 'claude',
    shortcut: '⌘3',
  },
  {
    id: 'claude:claude-haiku-5-5',
    providerId: 'claude',
    providerLabel: 'Claude',
    label: 'Claude Haiku 5.5',
    slug: 'claude-haiku-5-5',
    command: 'claude',
    shortcut: '⌘4',
  },
  {
    id: 'claude:claude-fable-5',
    providerId: 'claude',
    providerLabel: 'Claude',
    label: 'Claude Fable 5',
    slug: 'claude-fable-5',
    command: 'claude',
    shortcut: '⌘5',
  },
  {
    id: 'claude:claude-opus-5',
    providerId: 'claude',
    providerLabel: 'Claude',
    label: 'Claude Opus 5',
    slug: 'claude-opus-5',
    command: 'claude',
    shortcut: '⌘6',
  },
  claudeCodeCliModel,
  ...kimiFallbackModels,
  ...museFallbackModels,
  ...cursorFallbackModels,
  ...openCodeFallbackModels,
];
export const humanizeModelSlug = (slug) =>
  String(slug)
    .replace(/^[^/]+\//, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/(\d) (?=\d\b)/g, '$1.')
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bMimo\b/g, 'MiMo')
    .replace(/\bOpenai\b/g, 'OpenAI')
    .replace(/\bAi\b/g, 'AI');

export const cleanCursorModelLabel = (label) =>
  String(label || '')
    .replace(
      /\s+\((?:current|default|selected)(?:\s*,\s*(?:current|default|selected))*\)/gi,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();

// Keep favorites stable as Cursor changes the ordering of `--list-models`.
// These are primary selector entries, not every effort/fast variant.
export const cursorFavoriteModelSlugs = new Set([
  'auto',
  'cursor-grok-4.6-high-fast',
  'composer-2.5',
]);

export const cursorModelFromCliRow = (slug, label) => {
  const cleanSlug = String(slug || '').trim();
  if (!cleanSlug) return null;
  const cleanLabel = cleanCursorModelLabel(label) || humanizeModelSlug(cleanSlug);
  return {
    id: `cursor:${cleanSlug}`,
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: cleanLabel,
    slug: cleanSlug,
    command: 'cursor-agent',
    favorite: cursorFavoriteModelSlugs.has(cleanSlug),
  };
};

export const parseCursorModelObject = (value) => {
  if (!value || typeof value !== 'object') return null;
  const slug =
    value.id ||
    value.model ||
    value.name ||
    value.slug ||
    value.modelId ||
    value.sku ||
    value.value;
  const label =
    value.label ||
    value.displayName ||
    value.display_name ||
    value.title ||
    value.name ||
    value.model ||
    slug;
  return cursorModelFromCliRow(slug, label);
};

export const parseCursorModelsOutput = (output) => {
  const text = String(output || '').trim();
  if (!text || /no models available/i.test(text) || /authentication required/i.test(text)) return [];

  try {
    const parsed = JSON.parse(text);
    const values = Array.isArray(parsed) ? parsed : parsed.models || parsed.data || parsed.items;
    if (Array.isArray(values)) {
      return sortCursorModels(values.map(parseCursorModelObject).filter(Boolean));
    }
  } catch {}

  const models = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^[-\s|]+$/.test(trimmed) || /^id\s+/i.test(trimmed)) continue;

    const dashMatch = trimmed.match(/^(\S+)\s+-\s+(.+)$/);
    if (dashMatch) {
      const model = cursorModelFromCliRow(dashMatch[1], dashMatch[2]);
      if (model) models.push(model);
      continue;
    }

    const columns = trimmed.split(/\s{2,}/).filter(Boolean);
    if (columns.length >= 2) {
      const model = cursorModelFromCliRow(columns[0], columns.slice(1).join(' '));
      if (model) models.push(model);
      continue;
    }

    if (/^[a-z0-9][a-z0-9._:/[\]=,-]*$/i.test(trimmed)) {
      const model = cursorModelFromCliRow(trimmed, trimmed);
      if (model) models.push(model);
    }
  }

  const seen = new Set();
  return sortCursorModels(models.filter((model) => {
    if (seen.has(model.slug)) return false;
    seen.add(model.slug);
    return true;
  }));
};

export const listCursorAgentModels = async () => {
  if (!(await checkCommandAvailable('cursor-agent'))) return [];

  for (const args of [['--list-models'], ['models']]) {
    try {
      const { stdout, stderr } = await execFileAsync('cursor-agent', args, {
        timeout: 15000,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
      });
      const models = parseCursorModelsOutput(`${stdout || ''}\n${stderr || ''}`);
      if (models.length > 0) return models;
    } catch (error) {
      const models = parseCursorModelsOutput(`${error?.stdout || ''}\n${error?.stderr || ''}`);
      if (models.length > 0) return models;
    }
  }

  return [];
};

export const kimiPinnedModelAliases = ['kimi-code/k3.1-pro', 'kimi-code/k3.1-pro-highspeed', 'kimi-code/k3'];
export const kimiFavoriteModelAliases = new Set(['kimi-code/k3.1-pro', 'kimi-code/k3']);

// Kimi models come from the CLI's own provider registry (managed kimi-code
// models plus any custom providers the user imported). Aliases double as
// model slugs: they are what `-m` and the ACP model config option accept.
export const listKimiModels = async () => {
  if (!(await checkCommandAvailable('kimi'))) return [];
  try {
    const { stdout } = await execFileAsync('kimi', ['provider', 'list', '--json'], {
      timeout: 15000,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const parsed = JSON.parse(String(stdout || '').trim());
    const models = parsed?.models && typeof parsed.models === 'object' ? parsed.models : {};
    // The CLI registry's key order puts newer models last; pin the current
    // flagships to the top of the picker (stable sort keeps the rest in
    // registry order).
    const pinRank = (alias) => {
      const rank = kimiPinnedModelAliases.indexOf(alias);
      return rank === -1 ? kimiPinnedModelAliases.length : rank;
    };
    return Object.entries(models)
      .sort(([a], [b]) => pinRank(a) - pinRank(b))
      .map(([alias, value], index) => {
        if (!alias || typeof alias !== 'string') return null;
        const label =
          (value && typeof value === 'object' && typeof value.displayName === 'string' && value.displayName) ||
          humanizeModelSlug(alias);
        return {
          id: `kimi:${alias}`,
          providerId: 'kimi',
          providerLabel: 'Kimi',
          label,
          slug: alias,
          command: 'kimi',
          ...(index < 9 ? { shortcut: `⌘${index + 1}` } : {}),
          favorite: kimiFavoriteModelAliases.has(alias),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};

// Pull the effort tier names out of a catalog's per-model effort list,
// ordered low → high.
const effortValues = (list, key) =>
  [...new Set(
    (Array.isArray(list) ? list : [])
      .map((entry) => (typeof entry === 'string' ? entry : entry?.[key]))
      .filter((value) => typeof value === 'string' && value)
  )].sort((a, b) => effortRank(a) - effortRank(b));

const effortRank = (effort) => {
  const rank = reasoningEffortTiers.indexOf(effort);
  return rank === -1 ? reasoningEffortTiers.length : rank;
};

const readJsonFile = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8'));

// Muse Code has no models subcommand, but it caches each provider profile's
// live catalog under its XDG data dir after every run (rows carry model_id,
// display_label, visibility, is_default). Reading that cache costs no process
// spawn and needs no auth; a user who has never run muse just keeps the
// static fallback.
export const museModelCatalogDir = () =>
  path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'muse',
    'model-catalog'
  );

// Turn the catalog rows (possibly from several provider profiles) into
// picker entries. Rows honour the provider's display_order when it is set;
// otherwise newest release first, with the standard tier ahead of its
// contributor tier. The row muse itself marks as the default is a favorite,
// as is the newest standard model so both tiers of the current generation
// surface at the top of the picker.
export const museModelsFromCatalogRows = (rows) => {
  const seen = new Set();
  const records = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.model_id !== 'string' || !row.model_id) continue;
    if (row.visibility === 'hidden') continue;
    const slug = row.model_id.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    records.push({
      slug,
      row,
      index: records.length,
      releasedAt: Date.parse(row.release_date || '') || 0,
      contributor: /(^|-)contributor(-|$)/i.test(slug),
    });
  }
  records.sort((a, b) => {
    const aOrder = typeof a.row.display_order === 'number' ? a.row.display_order : null;
    const bOrder = typeof b.row.display_order === 'number' ? b.row.display_order : null;
    if (aOrder !== null || bOrder !== null) {
      if (aOrder === null) return 1;
      if (bOrder === null) return -1;
      if (aOrder !== bOrder) return aOrder - bOrder;
    }
    return (
      b.releasedAt - a.releasedAt ||
      Number(a.contributor) - Number(b.contributor) ||
      a.index - b.index
    );
  });
  const newestStandard = records.find((record) => !record.contributor) ?? records[0];
  return records.map(({ slug, row }, index) => {
    const reasoningEfforts = effortValues(row.reasoning_effort_variants, 'tier');
    return {
      id: `muse:${slug}`,
      providerId: 'muse',
      providerLabel: 'Muse',
      label: humanizeModelSlug(row.display_label || slug),
      slug,
      command: 'muse',
      ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
      ...(index < 9 ? { shortcut: `⌘${index + 1}` } : {}),
      favorite: row.is_default === true || slug === newestStandard?.slug,
    };
  });
};

export const listMuseModels = async () => {
  if (!(await checkCommandAvailable('muse'))) return [];
  try {
    const catalogDir = museModelCatalogDir();
    const files = (await fs.readdir(catalogDir)).filter((name) => name.endsWith('.json'));
    const rows = [];
    for (const name of files) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(catalogDir, name), 'utf8'));
        if (Array.isArray(parsed?.rows)) rows.push(...parsed.rows);
      } catch {}
    }
    return museModelsFromCatalogRows(rows);
  } catch {
    return [];
  }
};

// Codex caches the account's model catalog (the list its own /model picker
// shows) in $CODEX_HOME/models_cache.json. Rows carry a visibility
// ("list"/"hide"), a priority (lower first), and per-model reasoning tiers
// and default, so reading it costs no process spawn.
export const codexModelsCachePath = () =>
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');

// Codex hyphenates the variant word ("GPT-6.1-Sol"); the picker spaces it
// ("GPT-6.1 Sol") like the static catalog.
export const codexModelLabel = (displayName, slug) =>
  String(displayName || '').trim().replace(/-(?=[A-Za-z])/g, ' ') || humanizeModelSlug(slug);

export const codexModelsFromCache = (cache) => {
  const priority = (row) => (typeof row.priority === 'number' ? row.priority : Number.MAX_SAFE_INTEGER);
  const seen = new Set();
  return (Array.isArray(cache?.models) ? cache.models : [])
    .filter((row) => row && typeof row.slug === 'string' && row.slug.trim() && row.visibility !== 'hide')
    .map((row, index) => ({ row, index }))
    .sort((a, b) => priority(a.row) - priority(b.row) || a.index - b.index)
    .filter(({ row }) => !seen.has(row.slug) && seen.add(row.slug))
    .map(({ row }) => {
      const slug = row.slug.trim();
      const reasoningEfforts = effortValues(row.supported_reasoning_levels, 'effort');
      return {
        id: `codex:${slug}`,
        providerId: 'codex',
        providerLabel: 'Codex',
        label: codexModelLabel(row.display_name, slug),
        slug,
        command: 'codex',
        ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
        ...(typeof row.default_reasoning_level === 'string' && row.default_reasoning_level
          ? { defaultReasoningEffort: row.default_reasoning_level }
          : {}),
      };
    });
};

export const listCodexModels = async () => {
  if (!(await checkCommandAvailable('codex'))) return [];
  try {
    return codexModelsFromCache(await readJsonFile(codexModelsCachePath()));
  } catch {
    return [];
  }
};

// Grok Build caches the account's model catalog (what `grok models` prints)
// in ~/.grok/models_cache.json, keyed by model id in picker order, with each
// model's reasoning tiers and default.
export const grokModelsCachePath = () => path.join(os.homedir(), '.grok', 'models_cache.json');

export const grokFavoriteModelSlugs = new Set(['grok-4.7']);

export const grokModelsFromCache = (cache) => {
  const models = [];
  const entries = cache?.models && typeof cache.models === 'object' ? Object.entries(cache.models) : [];
  for (const [key, value] of entries) {
    const info = value?.info && typeof value.info === 'object' ? value.info : {};
    const slug = String(info.id || key || '').trim();
    if (!slug || info.hidden === true || models.some((model) => model.slug === slug)) continue;
    const reasoningEfforts =
      info.supports_reasoning_effort === false ? [] : effortValues(info.reasoning_efforts, 'value');
    const defaultReasoningEffort =
      (Array.isArray(info.reasoning_efforts) && info.reasoning_efforts.find((effort) => effort?.default)?.value) ||
      info.reasoning_effort;
    const index = models.length;
    models.push({
      id: `grok:${slug}`,
      providerId: 'grok',
      providerLabel: 'Grok',
      label: (typeof info.name === 'string' && info.name.trim()) || humanizeModelSlug(slug),
      slug,
      command: 'grok',
      ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
      ...(reasoningEfforts.length > 0 && typeof defaultReasoningEffort === 'string' && defaultReasoningEffort
        ? { defaultReasoningEffort }
        : {}),
      ...(index < 9 ? { shortcut: `⌘${index + 1}` } : {}),
      favorite: grokFavoriteModelSlugs.has(slug),
    });
  }
  return models;
};

export const listGrokModels = async () => {
  if (!(await checkCommandAvailable('grok'))) return [];
  try {
    return grokModelsFromCache(await readJsonFile(grokModelsCachePath()));
  } catch {
    return [];
  }
};

// Claude Code caches its model picker catalog per account under
// <config dir>/cache/model-catalog. Models in the "main" section are the
// current lineup; of the older "overflow" section only the models listed
// here stay in the picker (Sonnet 5, Haiku 4.5 and the 4.x line are left out
// on purpose).
export const claudeModelCatalogDir = () =>
  path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    'cache',
    'model-catalog'
  );

export const claudeOverflowModelSlugs = new Set(['claude-fable-5', 'claude-opus-5']);

export const claudeModelsFromCatalog = (cacheFile) => {
  const rows = cacheFile?.catalog?.config?.models;
  const seen = new Set();
  const kept = (Array.isArray(rows) ? rows : []).filter((row) => {
    const slug = typeof row?.id === 'string' ? row.id.trim() : '';
    if (!slug || seen.has(slug) || row.hidden === true) return false;
    if (row.section !== 'main' && !claudeOverflowModelSlugs.has(slug)) return false;
    seen.add(slug);
    return true;
  });
  // Main section first, each section in catalog order.
  const ordered = [
    ...kept.filter((row) => row.section === 'main'),
    ...kept.filter((row) => row.section !== 'main'),
  ];
  return ordered.map((row, index) => {
    const slug = row.id.trim();
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const reasoningEfforts = effortValues(row.runtime?.effort_levels);
    const defaultReasoningEffort = row.runtime?.default_effort;
    return {
      id: `claude:${slug}`,
      providerId: 'claude',
      providerLabel: 'Claude',
      label: name ? (/^claude\b/i.test(name) ? name : `Claude ${name}`) : humanizeModelSlug(slug),
      slug,
      command: 'claude',
      ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
      ...(typeof defaultReasoningEffort === 'string' && defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      ...(index < 9 ? { shortcut: `⌘${index + 1}` } : {}),
    };
  });
};

// The catalog file most recently fetched belongs to the account Claude Code
// is signed in to now. The embedded-terminal pseudo-model rides along.
export const listClaudeModels = async () => {
  if (!(await checkCommandAvailable('claude'))) return [];
  try {
    const catalogDir = claudeModelCatalogDir();
    const files = (await fs.readdir(catalogDir)).filter((name) => name.endsWith('.json'));
    let latest = null;
    for (const name of files) {
      try {
        const parsed = await readJsonFile(path.join(catalogDir, name));
        if (!latest || (Number(parsed?.fetchedAt) || 0) > (Number(latest?.fetchedAt) || 0)) latest = parsed;
      } catch {}
    }
    const models = claudeModelsFromCatalog(latest);
    return models.length > 0 ? [...models, claudeCodeCliModel] : [];
  } catch {
    return [];
  }
};

export const openCodeModelFromCliRow = (slug, metadata = {}, index = 0) => {
  const cleanSlug = String(slug || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i.test(cleanSlug)) return null;
  const slashIndex = cleanSlug.indexOf('/');
  const providerSlug = cleanSlug.slice(0, slashIndex);
  const modelSlug = cleanSlug.slice(slashIndex + 1);
  const modelLabel = humanizeModelSlug(modelSlug);
  const discoveredLabel = typeof metadata.name === 'string' ? metadata.name.trim() : '';
  const baseLabel = discoveredLabel || modelLabel;
  const label = cleanSlug === 'opencode/x-preview-f-free'
    ? '0x Alpha Free (Unlimited)'
    : providerSlug === 'opencode'
      ? baseLabel
      : `${baseLabel} (${humanizeModelSlug(providerSlug)})`;
  const reasoningVariants =
    metadata.variants && typeof metadata.variants === 'object'
      ? Object.keys(metadata.variants).filter(Boolean)
      : [];
  return {
    id: `opencode:${cleanSlug}`,
    providerId: 'opencode',
    providerLabel: 'OpenCode',
    label,
    slug: cleanSlug,
    command: 'opencode',
    ...(reasoningVariants.length > 0 ? { reasoningVariants } : {}),
    ...(index < 9 ? { shortcut: `⌘${index + 1}` } : {}),
    favorite: cleanSlug === 'opencode/big-pickle',
  };
};

export const parseOpenCodeModelsOutput = (output) => {
  const text = String(output || '').replace(/\u001b\[[0-9;]*m/g, '');
  const matches = [...text.matchAll(/^([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*)\s*$/gim)];
  const seen = new Set();
  const records = matches
    .map((match, index) => {
      const slug = match[1];
      if (seen.has(slug)) return null;
      seen.add(slug);
      const block = text
        .slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? text.length)
        .trim();
      let metadata = {};
      if (block.startsWith('{')) {
        try {
          metadata = JSON.parse(block);
        } catch {}
      }
      return {
        slug,
        metadata,
        index,
        releasedAt: Date.parse(metadata.release_date || '') || 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.releasedAt - a.releasedAt || a.index - b.index);
  return records
    .map((record, index) => openCodeModelFromCliRow(record.slug, record.metadata, index))
    .filter(Boolean);
};

export const listOpenCodeModels = async () => {
  if (!(await checkCommandAvailable('opencode'))) return [];
  for (const args of [['models', '--verbose'], ['models']]) {
    try {
      const { stdout } = await execFileAsync('opencode', args, {
        timeout: 20000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      const models = parseOpenCodeModelsOutput(stdout);
      if (models.length > 0) return models;
    } catch (error) {
      const models = parseOpenCodeModelsOutput(`${error?.stdout || ''}\n${error?.stderr || ''}`);
      if (models.length > 0) return models;
    }
  }
  return [];
};

// Replace a provider's static catalog block with its discovered models,
// keeping the block's position in the picker order.
export const spliceProviderModels = (models, providerId, replacements) => {
  if (replacements.length === 0) return models;
  const firstIndex = models.findIndex((model) => model.providerId === providerId);
  if (firstIndex === -1) return [...models, ...replacements];
  return [
    ...models.slice(0, firstIndex).filter((model) => model.providerId !== providerId),
    ...replacements,
    ...models.slice(firstIndex).filter((model) => model.providerId !== providerId),
  ];
};

// One live reader per provider. Codex, Grok, Claude and Muse parse the
// catalog their CLI already caches on disk (no spawn, no auth); Cursor, Kimi
// and OpenCode have to spawn their CLI. A reader returns [] when it cannot
// discover anything, which keeps that provider's previous block.
export const agentModelDiscoverers = {
  grok: listGrokModels,
  codex: listCodexModels,
  claude: listClaudeModels,
  kimi: listKimiModels,
  muse: listMuseModels,
  cursor: listCursorAgentModels,
  opencode: listOpenCodeModels,
};

const providerCommands = {
  grok: 'grok',
  codex: 'codex',
  claude: 'claude',
  kimi: 'kimi',
  muse: 'muse',
  cursor: 'cursor-agent',
  opencode: 'opencode',
};

// Discovered blocks replace the static ones in place; providers without a
// block keep their static fallback.
export const buildAgentModels = (providerBlocks) =>
  Object.entries(providerBlocks).reduce(
    (models, [providerId, block]) => spliceProviderModels(models, providerId, block),
    agentModels
  );

export const discoverAgentModels = async (discoverers = agentModelDiscoverers) => {
  // Finder-launched builds start with launchd's minimal PATH. The renderer can
  // request models as soon as its window loads, so do not let that first
  // request cache fallback catalogs before the interactive-shell PATH arrives.
  await shellPathSyncPromise;
  return Object.fromEntries(
    await Promise.all(
      Object.entries(discoverers).map(async ([providerId, discover]) => [
        providerId,
        await discover().catch(() => []),
      ])
    )
  );
};

// Model catalog cache. Stale-while-revalidate: once any catalog exists (from
// this session or the on-disk copy of the last discovery), callers get it
// immediately and an expired one refreshes in the background, so neither a
// turn, a title generation nor a model switch ever waits on CLI probes. Only
// the very first launch (no disk cache yet) or an explicit fresh request
// waits for discovery. Listeners hear about every refresh that changes the
// list, so the renderer can pick it up.
export const AGENT_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const AGENT_MODELS_DISK_CACHE_VERSION = 1;
let agentModelsCacheFile = null;
let activeAgentModelDiscoverers = agentModelDiscoverers;
let agentModelsDiskCacheLoad = Promise.resolve();
let agentModelsDiscoveryPromise = null;
let discoveredProviderModels = {};
let cachedAgentModels = null;
let cachedAgentModelsAt = 0;
let agentModelsCacheGeneration = 0;
const agentModelsListeners = new Set();

export const onAgentModelsChanged = (listener) => {
  agentModelsListeners.add(listener);
  return () => agentModelsListeners.delete(listener);
};

// Only well-formed rows for the provider survive a reload, and the spawn
// command always comes from this module rather than the file.
const sanitizeProviderBlocks = (providers) =>
  Object.fromEntries(
    Object.entries(providers && typeof providers === 'object' ? providers : {})
      .filter(([providerId, block]) => providerCommands[providerId] && Array.isArray(block))
      .map(([providerId, block]) => [
        providerId,
        block
          .filter(
            (model) =>
              model &&
              model.providerId === providerId &&
              typeof model.id === 'string' &&
              typeof model.slug === 'string' &&
              typeof model.label === 'string'
          )
          .map((model) => ({ ...model, command: providerCommands[providerId] })),
      ])
      .filter(([, block]) => block.length > 0)
  );

const loadAgentModelsDiskCache = async (filePath) => {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    // A discovery that finished first is newer than anything on disk.
    if (parsed?.version !== AGENT_MODELS_DISK_CACHE_VERSION || cachedAgentModels) return;
    discoveredProviderModels = sanitizeProviderBlocks(parsed.providers);
    cachedAgentModels = buildAgentModels(discoveredProviderModels);
    cachedAgentModelsAt = Math.min(Number(parsed.savedAt) || 0, Date.now());
  } catch {}
};

const saveAgentModelsDiskCache = async (providers) => {
  if (!agentModelsCacheFile) return;
  const tempPath = `${agentModelsCacheFile}.${process.pid}.tmp`;
  try {
    await fs.writeFile(
      tempPath,
      JSON.stringify({ version: AGENT_MODELS_DISK_CACHE_VERSION, savedAt: Date.now(), providers })
    );
    await fs.rename(tempPath, agentModelsCacheFile);
  } catch {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
};

// Called once at startup with a path under userData. Tests swap in fake
// discoverers so no provider CLI is spawned.
export const configureAgentModelsCache = (filePath, { discoverers = agentModelDiscoverers } = {}) => {
  agentModelsCacheFile = filePath;
  activeAgentModelDiscoverers = discoverers;
  agentModelsDiskCacheLoad = loadAgentModelsDiskCache(filePath);
  return agentModelsDiskCacheLoad;
};

// Marks the catalog stale (after a CLI update or sign-in) without dropping
// it: the next request still answers from it while a fresh discovery runs,
// and a discovery already in flight is not committed.
export const invalidateAgentModelsCache = () => {
  agentModelsCacheGeneration += 1;
  agentModelsDiscoveryPromise = null;
  cachedAgentModelsAt = 0;
};

const refreshAgentModels = () => {
  if (agentModelsDiscoveryPromise) return agentModelsDiscoveryPromise;
  const cacheGeneration = agentModelsCacheGeneration;
  const discovery = discoverAgentModels(activeAgentModelDiscoverers).then((blocks) => {
    const providers = { ...discoveredProviderModels };
    for (const [providerId, block] of Object.entries(blocks)) {
      if (block.length > 0) providers[providerId] = block;
    }
    const models = buildAgentModels(providers);
    if (cacheGeneration !== agentModelsCacheGeneration) return models;
    const changed = !cachedAgentModels || JSON.stringify(models) !== JSON.stringify(cachedAgentModels);
    discoveredProviderModels = providers;
    cachedAgentModels = models;
    cachedAgentModelsAt = Date.now();
    if (changed) {
      void saveAgentModelsDiskCache(providers);
      for (const listener of agentModelsListeners) {
        try {
          listener(models);
        } catch {}
      }
    }
    return models;
  });
  const sharedDiscovery = discovery.finally(() => {
    if (agentModelsDiscoveryPromise === sharedDiscovery) {
      agentModelsDiscoveryPromise = null;
    }
  });
  agentModelsDiscoveryPromise = sharedDiscovery;
  return sharedDiscovery;
};

export const getAgentModels = async ({ fresh = false } = {}) => {
  await agentModelsDiskCacheLoad;
  if (cachedAgentModels && !fresh) {
    if (Date.now() - cachedAgentModelsAt >= AGENT_MODELS_CACHE_TTL_MS) {
      refreshAgentModels().catch(() => {});
    }
    return cachedAgentModels;
  }
  return refreshAgentModels();
};

// Shared by the agent:listModels IPC and the remote-control `models` request.
// Availability is probed once per provider CLI (not per model), and the
// internal `command` field never leaves the main process.
export const listAgentModelsWithAvailability = async ({ fresh = false } = {}) => {
  const models = await getAgentModels({ fresh });
  const uniqueCommands = [...new Set(models.map((model) => model.command).filter(Boolean))];
  const availability = new Map(
    await Promise.all(
      uniqueCommands.map(async (command) => [command, await checkCommandAvailable(command)])
    )
  );

  return models.map(({ command, ...model }) => {
    // Pseudo-models (Orion orchestrator) have no CLI to probe.
    if (!command) return { ...model, available: true };
    const available = availability.get(command) === true;
    return {
      ...model,
      available,
      ...(available ? {} : { unavailableReason: `Install or authenticate ${command} on PATH.` }),
    };
  });
};

export const claudeEffortForCli = (reasoningEffort = defaultClaudeReasoningEffort) => {
  if (reasoningEffort === 'ultracode') return 'xhigh';
  if (reasoningEffort === 'ultrathink') return defaultClaudeReasoningEffort;
  return reasoningEffort;
};

export const claudeModelArgForContextWindow = (modelArg, contextWindow = defaultClaudeContextWindow) => {
  if (contextWindow !== '1m' || !claudeOneMillionContextModels.has(modelArg)) return modelArg;
  return `${modelArg}[1m]`;
};

// Tokenize a user-provided flags string, respecting single/double quotes.
export const parseExtraArgs = (value) => {
  const text = String(value || '').trim();
  if (!text) return [];
  const args = [];
  const tokenPattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = tokenPattern.exec(text))) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
};

// Browser control runs through npx rather than Orion's bundled node_modules,
// so keep the reviewed MCP release explicit. Never use @latest here: that
// would let a published Orion build silently execute different third-party
// code on a later run.
export const chromeDevtoolsMcpPackage = 'chrome-devtools-mcp@1.6.0';
