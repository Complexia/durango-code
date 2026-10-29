import {
  ClaudeBrandIcon,
  CodexBrandIcon,
  CursorBrandIcon,
  FxBrandIcon,
  GrokBrandIcon,
  KimiBrandIcon,
  MuseBrandIcon,
  OpenCodeBrandIcon,
  OrionBrandIcon,
  type ProviderIconComponent,
} from './providerIcons';

export type AgentProviderId =
  | 'orion'
  | 'grok'
  | 'codex'
  | 'claude'
  | 'cursor'
  | 'kimi'
  | 'fx'
  | 'muse'
  | 'opencode';

export type AgentModel = {
  id: string;
  providerId: AgentProviderId;
  providerLabel: string;
  label: string;
  slug: string;
  shortcut?: string;
  favorite?: boolean;
  reasoningVariants?: string[];
  // Effort tiers (low → high) and default from the provider's live catalog;
  // absent on static fallback rows.
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  available?: boolean;
  unavailableReason?: string;
};

export type AgentProvider = {
  id: AgentProviderId;
  label: string;
  icon: ProviderIconComponent;
};

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type CodexServiceTier = 'default' | 'priority';
export type ClaudeReasoningEffort =
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultracode'
  | 'ultrathink';
export type ClaudeContextWindow = '200k' | '1m';
export type GrokReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type MuseReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';

type ReasoningEffortOption = {
  value: string;
  label: string;
  default?: boolean;
  description?: string;
};

// Canonical low → high order of every tier any harness advertises; mirrors
// reasoningEffortTiers in src/main/models.js.
const reasoningEffortTiers = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const reasoningEffortLabels: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

const effortRank = (effort: string) => {
  const rank = reasoningEffortTiers.indexOf(effort);
  return rank === -1 ? reasoningEffortTiers.length : rank;
};

// A model's effort menu: the given tiers (live catalog or static fallback)
// in low → high order, labelled from the provider's option table, with the
// default mark on `defaultEffort` (else the table's default, if offered).
const effortMenu = <T extends ReasoningEffortOption>(
  table: readonly T[],
  efforts: readonly string[],
  defaultEffort?: string
): T[] => {
  const tiers = [...new Set(efforts)].sort((a, b) => effortRank(a) - effortRank(b));
  const menuDefault =
    defaultEffort && tiers.includes(defaultEffort)
      ? defaultEffort
      : table.find((option) => option.default && tiers.includes(option.value))?.value;
  return tiers.map((value) => {
    const { default: _default, ...option } =
      table.find((candidate) => candidate.value === value) ??
      ({ value, label: reasoningEffortLabels[value] ?? value } as T);
    return (value === menuDefault ? { ...option, default: true } : option) as T;
  });
};

// Keep an effort the menu offers; otherwise step down to the nearest offered
// tier (Ultra → Max → Extra High), else the menu's default. Mirrors
// clampReasoningEffort in src/main/models.js.
const clampEffort = <T extends string>(
  options: readonly ReasoningEffortOption[],
  effort: string | undefined,
  fallback: T
): T => {
  const offered = (value: string) => options.some((option) => option.value === value);
  const menuDefault = (options.find((option) => option.default)?.value ?? fallback) as T;
  if (!effort) return menuDefault;
  if (offered(effort)) return effort as T;
  for (let rank = reasoningEffortTiers.indexOf(effort) - 1; rank >= 0; rank -= 1) {
    if (offered(reasoningEffortTiers[rank])) return reasoningEffortTiers[rank] as T;
  }
  return menuDefault;
};

const liveEfforts = (model: AgentModel | undefined) =>
  model?.reasoningEfforts && model.reasoningEfforts.length > 0 ? model.reasoningEfforts : null;

export type CodexReasoningOption = {
  value: CodexReasoningEffort;
  label: string;
  default?: boolean;
  description?: string;
};

export const codexReasoningOptions: CodexReasoningOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium', default: true },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
];

// The GPT-5.6 family renames Low to Light.
const gpt56CodexReasoningOptions: CodexReasoningOption[] = [
  { value: 'low', label: 'Light' },
  { value: 'medium', label: 'Medium', default: true },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra', description: 'Consumes usage limits faster' },
];

const gpt6CodexReasoningOptions: CodexReasoningOption[] = [
  ...codexReasoningOptions,
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra', description: 'Maximum reasoning with automatic task delegation' },
];

const gpt56CodexModelSlugs = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);

export const gpt6CodexModelSlugs: ReadonlySet<string> = new Set([
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-6-luna',
]);

// Static tiers for when the CLI's model cache is unavailable (mirrors it as
// of Codex 0.163): the GPT-6 and GPT-5.6 families offer Max and Ultra except
// Luna, which stops at Max; Sol models default to Low, the rest to Medium.
const codexLowDefaultModelSlugs = new Set(['gpt-6.1-sol', 'gpt-5.6-sol']);
const codexNoUltraModelSlugs = new Set(['gpt-6-luna', 'gpt-5.6-luna']);

export const codexReasoningOptionsForModel = (
  model: AgentModel | undefined
): CodexReasoningOption[] => {
  const slug = model?.slug ?? '';
  const isGpt56 = gpt56CodexModelSlugs.has(slug);
  const table = isGpt56 ? gpt56CodexReasoningOptions : gpt6CodexReasoningOptions;
  const staticEfforts =
    isGpt56 || gpt6CodexModelSlugs.has(slug)
      ? table
          .map((option) => option.value)
          .filter((value) => value !== 'ultra' || !codexNoUltraModelSlugs.has(slug))
      : codexReasoningOptions.map((option) => option.value);
  return effortMenu(
    table,
    liveEfforts(model) ?? staticEfforts,
    model?.defaultReasoningEffort ?? (codexLowDefaultModelSlugs.has(slug) ? 'low' : defaultCodexReasoningEffort)
  );
};

// Clamp a stored effort to what the model actually offers (e.g. a thread that
// picked Ultra on Sol and then switched to Luna steps down to Max).
export const getEffectiveCodexReasoningEffort = (
  model: AgentModel | undefined,
  effort: CodexReasoningEffort | undefined
): CodexReasoningEffort =>
  clampEffort(codexReasoningOptionsForModel(model), effort, defaultCodexReasoningEffort);

export const codexServiceTierOptions: Array<{
  value: CodexServiceTier;
  label: string;
  default?: boolean;
}> = [
  { value: 'default', label: 'Standard', default: true },
  { value: 'priority', label: 'Fast' },
];

export const defaultCodexReasoningEffort: CodexReasoningEffort = 'medium';
export const defaultCodexServiceTier: CodexServiceTier = 'default';
export const defaultClaudeReasoningEffort: ClaudeReasoningEffort = 'high';
export const defaultClaudeContextWindow: ClaudeContextWindow = '200k';

export const claudeReasoningOptions: Array<{
  value: ClaudeReasoningEffort;
  label: string;
}> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
  { value: 'max', label: 'Max' },
  { value: 'ultracode', label: 'Ultracode' },
  { value: 'ultrathink', label: 'Ultrathink' },
];

// Ultracode and Ultrathink are Durango Code modes that run the CLI at Extra
// High and High (see claudeEffortForCli), so they need those tiers.
const claudeCliEffortForOption: Partial<Record<ClaudeReasoningEffort, string>> = {
  ultracode: 'xhigh',
  ultrathink: 'high',
};

// Claude Code's catalog lists each model's effort tiers; without it every
// option is offered. Durango Code keeps High as its default effort.
export const claudeReasoningOptionsForModel = (model: AgentModel | undefined) => {
  const efforts = liveEfforts(model);
  if (!efforts) return claudeReasoningOptions;
  return claudeReasoningOptions.filter((option) =>
    efforts.includes(claudeCliEffortForOption[option.value] ?? option.value)
  );
};

export const getEffectiveClaudeReasoningEffort = (
  model: AgentModel | undefined,
  effort: ClaudeReasoningEffort | undefined
): ClaudeReasoningEffort => {
  const options = claudeReasoningOptionsForModel(model);
  const fallback = options.some((option) => option.value === defaultClaudeReasoningEffort)
    ? defaultClaudeReasoningEffort
    : ((options.find((option) => option.value === model?.defaultReasoningEffort) ?? options[0])?.value ??
      defaultClaudeReasoningEffort);
  return clampEffort(options, effort, fallback);
};

export const claudeContextWindowOptions: Array<{
  value: ClaudeContextWindow;
  label: string;
}> = [
  { value: '200k', label: '200k' },
  { value: '1m', label: '1M' },
];

// Grok exposes reasoning effort over ACP; labels/descriptions mirror the
// tiers the agent itself advertises in session/new model metadata. Without
// the CLI's model cache, Extra High is assumed only for Grok 4.6 and newer.
export const defaultGrokReasoningEffort: GrokReasoningEffort = 'high';

export const grokExtraHighReasoningSlugs: ReadonlySet<string> = new Set([
  'grok-4.7',
  'grok-4.7-build-fast',
  'grok-4.6',
]);

export type GrokReasoningOption = {
  value: GrokReasoningEffort;
  label: string;
  default?: boolean;
  description?: string;
};

export const grokReasoningOptions: GrokReasoningOption[] = [
  { value: 'low', label: 'Low', description: 'Quick, fast implementations' },
  { value: 'medium', label: 'Medium', description: 'Balanced effort with standard implementation and testing' },
  { value: 'high', label: 'High', default: true, description: 'Higher implementation quality with extensive reasoning' },
  { value: 'xhigh', label: 'Extra High', description: 'Highest effort and reasoning level' },
];

export const grokReasoningOptionsForModel = (
  model: AgentModel | undefined
): GrokReasoningOption[] =>
  effortMenu(
    grokReasoningOptions,
    liveEfforts(model) ??
      grokReasoningOptions
        .map((option) => option.value)
        .filter((value) => value !== 'xhigh' || Boolean(model?.slug && grokExtraHighReasoningSlugs.has(model.slug))),
    model?.defaultReasoningEffort
  );

export const getEffectiveGrokReasoningEffort = (
  model: AgentModel | undefined,
  effort: GrokReasoningEffort | undefined
): GrokReasoningEffort => clampEffort(grokReasoningOptionsForModel(model), effort, defaultGrokReasoningEffort);

// Muse Code's reasoning-effort tiers, the wire values `muse exec
// --reasoning-effort` accepts. The CLI defaults to high; its model catalog
// narrows the tiers per model (e.g. Spark 1.2 has no Max).
export const defaultMuseReasoningEffort: MuseReasoningEffort = 'high';

export const museReasoningOptions: Array<{
  value: MuseReasoningEffort;
  label: string;
  default?: boolean;
}> = [
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High', default: true },
  { value: 'xhigh', label: 'Extra High' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' },
];

export const museReasoningOptionsForModel = (model: AgentModel | undefined) =>
  effortMenu(
    museReasoningOptions,
    liveEfforts(model) ?? museReasoningOptions.map((option) => option.value),
    model?.defaultReasoningEffort
  );

export const getEffectiveMuseReasoningEffort = (
  model: AgentModel | undefined,
  effort: MuseReasoningEffort | undefined
): MuseReasoningEffort => clampEffort(museReasoningOptionsForModel(model), effort, defaultMuseReasoningEffort);

export type OpenCodeReasoningOption = {
  value: string;
  label: string;
  default?: boolean;
};

export const openCodeReasoningOptionsForModel = (
  model: AgentModel | undefined
): OpenCodeReasoningOption[] => [
  { value: 'default', label: 'Default', default: true },
  ...(model?.reasoningVariants ?? []).map((variant) => ({ value: variant, label: variant })),
];

export const getEffectiveOpenCodeReasoningEffort = (
  model: AgentModel | undefined,
  effort: string | undefined
): string => {
  const options = openCodeReasoningOptionsForModel(model);
  return effort && options.some((option) => option.value === effort) ? effort : 'default';
};

export type ProviderOptionDef = {
  key:
    | 'allowedTools'
    | 'networkAccess'
    | 'webSearch'
    | 'codexContextManagementMode'
    | 'codexMemoryMode'
    | 'codexChronicleMode'
    | 'codexMemoryExternalContextMode'
    | 'codexPersonality'
    | 'codexDeveloperInstructions'
    | 'experimentalMemory'
    | 'chrome'
    | 'browserControl'
    | 'extraArgs';
  label: string;
  description: string;
  type: 'boolean' | 'string' | 'select' | 'textarea';
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
};

const extraArgsOption = (command: string): ProviderOptionDef => ({
  key: 'extraArgs',
  label: 'Extra CLI flags',
  description: `Appended to every ${command} invocation. Quotes are respected.`,
  type: 'string',
  placeholder: '--flag value',
});

// Harness capabilities surfaced per provider. Everything here maps directly
// onto a CLI flag or config override in main.js's commandForModel.
export const providerOptionDefs: Record<AgentProviderId, ProviderOptionDef[]> = {
  // The Orion orchestrator is a pseudo-model, not a CLI harness — no options.
  orion: [],
  claude: [
    {
      key: 'allowedTools',
      label: 'Auto-allowed tools',
      description:
        'Tools approved without prompting in Read only / Workspace write modes (headless runs cannot ask). E.g. Bash, WebFetch, WebSearch. Browser tools remain disabled in Read only. Full Access already allows everything.',
      type: 'string',
      placeholder: 'Bash, WebFetch, WebSearch',
    },
    extraArgsOption('claude'),
  ],
  codex: [
    {
      key: 'codexContextManagementMode',
      label: 'Long-session context',
      description:
        'Keep notes and search earlier context windows within a chat. Experimental; requires a recent Codex CLI and eligible ChatGPT sign-in. Automatic enables it for Astra. This is separate from cross-chat memories.',
      type: 'select',
      options: [
        { value: 'inherit', label: 'Automatic (on for Astra)' },
        { value: 'enabled', label: 'Enabled in Durango Code' },
        { value: 'disabled', label: 'Disabled in Durango Code' },
        { value: 'codex', label: 'Use Codex configuration' },
      ],
    },
    {
      key: 'codexDeveloperInstructions',
      label: 'Custom instructions',
      description:
        'Additional instructions and context for Codex chats launched from Durango Code. Leave blank to use only your normal Codex configuration and AGENTS.md guidance.',
      type: 'textarea',
      placeholder: 'Add your custom instructions…',
    },
    {
      key: 'codexMemoryMode',
      label: 'Local memories',
      description:
        'Use locally stored Codex context across Durango Code chats and allow eligible Durango Code chats to contribute to future memories. Inherit follows $CODEX_HOME/config.toml.',
      type: 'select',
      options: [
        { value: 'inherit', label: 'Inherit Codex setting' },
        { value: 'enabled', label: 'Enabled in Durango Code' },
        { value: 'disabled', label: 'Disabled in Durango Code' },
      ],
    },
    {
      key: 'codexChronicleMode',
      label: 'Chronicle memories',
      description:
        'Let Codex use Chronicle screen-context memories in Durango Code when the ChatGPT desktop recorder is running. Chronicle is a macOS ChatGPT Pro research preview; Durango Code does not start or capture the recorder itself.',
      type: 'select',
      options: [
        { value: 'inherit', label: 'Inherit Codex setting' },
        { value: 'enabled', label: 'Enabled in Durango Code' },
        { value: 'disabled', label: 'Disabled in Durango Code' },
      ],
    },
    {
      key: 'codexMemoryExternalContextMode',
      label: 'Tool-assisted chat memories',
      description:
        'Choose whether chats that used MCP tools, web search, or tool search may generate local memories. Inherit keeps the host Codex privacy setting.',
      type: 'select',
      options: [
        { value: 'inherit', label: 'Inherit Codex setting' },
        { value: 'enabled', label: 'Allow generation' },
        { value: 'disabled', label: 'Exclude these chats' },
      ],
    },
    {
      key: 'codexPersonality',
      label: 'Personality',
      description:
        'Default communication style for Codex models that support personality. Inherit uses your normal Codex setting.',
      type: 'select',
      options: [
        { value: 'inherit', label: 'Inherit Codex setting' },
        { value: 'none', label: 'None' },
        { value: 'friendly', label: 'Friendly' },
        { value: 'pragmatic', label: 'Pragmatic' },
      ],
    },
    {
      key: 'networkAccess',
      label: 'Network access in sandbox',
      description:
        'Allow network inside the workspace-write sandbox (web fetches, npm install). Full Access is never sandboxed.',
      type: 'boolean',
    },
    {
      key: 'webSearch',
      label: 'Web search',
      description: 'Enable the Codex web search tool for all runs.',
      type: 'boolean',
    },
    extraArgsOption('codex'),
  ],
  // Grok turns run over `grok agent stdio` (ACP), which accepts far fewer
  // flags than the TUI — e.g. --experimental-memory is rejected there, so the
  // old cross-session memory toggle is gone.
  grok: [
    {
      key: 'extraArgs',
      label: 'Extra CLI flags',
      description:
        'Appended to every `grok agent` invocation. Flags must be valid for `grok agent` (not the interactive TUI). Quotes are respected.',
      type: 'string',
      placeholder: '--reasoning-effort high',
    },
  ],
  cursor: [extraArgsOption('cursor-agent')],
  // Kimi turns run over `kimi acp` (ACP over stdio), which takes no
  // model/permission flags — those travel in the JSON-RPC dialog. Extra flags
  // are inserted before the `acp` subcommand (e.g. --skills-dir, --add-dir).
  kimi: [
    {
      key: 'extraArgs',
      label: 'Extra CLI flags',
      description:
        'Inserted before the `acp` subcommand on every kimi invocation (e.g. --skills-dir, --add-dir). Quotes are respected.',
      type: 'string',
      placeholder: '--add-dir /path',
    },
  ],
  // fx turns run over `fx acp`; global flags (--add-dir, --context-limit)
  // must precede the subcommand. Routing (subscriptions, Durango credits,
  // Vercel AI Gateway) has its own panel in Settings → Providers → fx.
  fx: [
    {
      key: 'extraArgs',
      label: 'Extra CLI flags',
      description:
        'Inserted before the `acp` subcommand on every fx invocation (e.g. --add-dir, --context-limit). Quotes are respected.',
      type: 'string',
      placeholder: '--add-dir /path',
    },
  ],
  // Muse turns run over `muse exec` (headless JSONL); flags land between
  // `exec` and the prompt argument.
  muse: [
    {
      key: 'extraArgs',
      label: 'Extra CLI flags',
      description:
        'Appended to every `muse exec` invocation, before the prompt. Quotes are respected.',
      type: 'string',
      placeholder: '--sandbox-network enabled',
    },
  ],
  opencode: [extraArgsOption('opencode')],
};

// What each harness supports for messages sent while a run is in flight.
// queue: hold the message and send it as the next turn (session resume);
// dispatches automatically the moment the current turn ends.
// steer: deliver the message INTO the running turn without interrupting it —
// the same behavior as typing while Claude Code works. This needs a live
// mid-turn input channel: Claude folds the message into its persistent SDK
// session, Codex uses app-server's native turn/steer, and fx takes a
// steering session/prompt over its ACP dialog. The other
// harnesses run one-shot per turn or hold a single-prompt ACP dialog, so a
// follow-up cannot reach the running turn — it queues and sends when that
// turn finishes. Steer must never kill the running process; that is Stop's job.
export const providerFollowUpSupport: Record<AgentProviderId, { queue: boolean; steer: boolean }> = {
  // Steering an orchestrated thread would bypass the driver resolution.
  orion: { queue: true, steer: false },
  grok: { queue: true, steer: false },
  codex: { queue: true, steer: true },
  claude: { queue: true, steer: true },
  cursor: { queue: true, steer: false },
  kimi: { queue: true, steer: false },
  fx: { queue: true, steer: true },
  muse: { queue: true, steer: false },
  opencode: { queue: true, steer: false },
};

export const agentProviders: AgentProvider[] = [
  { id: 'orion', label: 'Durango Code', icon: OrionBrandIcon },
  { id: 'grok', label: 'Grok', icon: GrokBrandIcon },
  { id: 'codex', label: 'Codex', icon: CodexBrandIcon },
  { id: 'claude', label: 'Claude', icon: ClaudeBrandIcon },
  { id: 'kimi', label: 'Kimi', icon: KimiBrandIcon },
  { id: 'fx', label: 'fx', icon: FxBrandIcon },
  { id: 'muse', label: 'Muse', icon: MuseBrandIcon },
  { id: 'cursor', label: 'Cursor', icon: CursorBrandIcon },
  { id: 'opencode', label: 'OpenCode', icon: OpenCodeBrandIcon },
];

export const fallbackAgentModels: AgentModel[] = [
  {
    id: 'orion:orchestrator',
    providerId: 'orion',
    providerLabel: 'Durango Code',
    label: 'Durango Code',
    slug: 'orion',
    favorite: true,
  },
  {
    id: 'grok:grok-4.7',
    providerId: 'grok',
    providerLabel: 'Grok',
    label: 'Grok 4.7',
    slug: 'grok-4.7',
    shortcut: '⌘1',
    favorite: true,
  },
  {
    id: 'grok:grok-4.7-build-fast',
    providerId: 'grok',
    providerLabel: 'Grok',
    label: 'Grok 4.7 Fast',
    slug: 'grok-4.7-build-fast',
    shortcut: '⌘2',
  },
  {
    id: 'grok:grok-4.6',
    providerId: 'grok',
    providerLabel: 'Grok',
    label: 'Grok 4.6',
    slug: 'grok-4.6',
    shortcut: '⌘3',
  },
  {
    id: 'grok:grok-4.5',
    providerId: 'grok',
    providerLabel: 'Grok',
    label: 'Grok 4.5',
    slug: 'grok-4.5',
    shortcut: '⌘4',
  },
  {
    id: 'codex:gpt-6.1-sol',
    providerId: 'codex',
    providerLabel: 'Codex',
    label: 'GPT-6.1 Sol',
    slug: 'gpt-6.1-sol',
  },
  {
    id: 'codex:gpt-6-astra',
    providerId: 'codex',
    providerLabel: 'Codex',
    label: 'GPT-6 Astra',
    slug: 'gpt-6-astra',
  },
  {
    id: 'codex:gpt-6-sol',
    providerId: 'codex',
    providerLabel: 'Codex',
    label: 'GPT-6 Sol',
    slug: 'gpt-6-sol',
  },
  {
    id: 'codex:gpt-6-luna',
    providerId: 'codex',
    providerLabel: 'Codex',
    label: 'GPT-6 Luna',
    slug: 'gpt-6-luna',
  },
  {
    id: 'codex:gpt-5.6-sol',
    providerId: 'codex',
    providerLabel: 'Codex',
    label: 'GPT-5.6 Sol',
    slug: 'gpt-5.6-sol',
  },
  {
    id: 'codex:gpt-5.6-terra',
    providerId: 'codex',
    providerLabel: 'Codex',
    label: 'GPT-5.6 Terra',
    slug: 'gpt-5.6-terra',
  },
  {
    id: 'codex:gpt-5.6-luna',
    providerId: 'codex',
    providerLabel: 'Codex',
    label: 'GPT-5.6 Luna',
    slug: 'gpt-5.6-luna',
  },
  {
    id: 'claude:claude-fable-5-1',
    providerId: 'claude',
    providerLabel: 'Claude',
    label: 'Claude Fable 5.1',
    slug: 'claude-fable-5-1',
    shortcut: '⌘1',
  },
  {
    id: 'claude:claude-opus-5-5',
    providerId: 'claude',
    providerLabel: 'Claude',
    label: 'Claude Opus 5.5',
    slug: 'claude-opus-5-5',
    shortcut: '⌘2',
  },
  {
    id: 'claude:claude-sonnet-5-5',
    providerId: 'claude',
    providerLabel: 'Claude',
    label: 'Claude Sonnet 5.5',
    slug: 'claude-sonnet-5-5',
    shortcut: '⌘3',
  },
  {
    id: 'claude:claude-haiku-5-5',
    providerId: 'claude',
    providerLabel: 'Claude',
    label: 'Claude Haiku 5.5',
    slug: 'claude-haiku-5-5',
    shortcut: '⌘4',
  },
  {
    id: 'claude:claude-fable-5',
    providerId: 'claude',
    providerLabel: 'Claude',
    label: 'Claude Fable 5',
    slug: 'claude-fable-5',
    shortcut: '⌘5',
  },
  {
    id: 'claude:claude-opus-5',
    providerId: 'claude',
    providerLabel: 'Claude',
    label: 'Claude Opus 5',
    slug: 'claude-opus-5',
    shortcut: '⌘6',
  },
  {
    id: 'claude:claude-code-cli',
    providerId: 'claude',
    providerLabel: 'Claude',
    label: 'Claude Code CLI',
    slug: 'claude-code-cli',
  },
  {
    id: 'kimi:kimi-code/k3.1-pro',
    providerId: 'kimi',
    providerLabel: 'Kimi',
    label: 'K3.1 Pro',
    slug: 'kimi-code/k3.1-pro',
    shortcut: '⌘1',
    favorite: true,
  },
  {
    id: 'kimi:kimi-code/k3.1-pro-highspeed',
    providerId: 'kimi',
    providerLabel: 'Kimi',
    label: 'K3.1 Pro Highspeed',
    slug: 'kimi-code/k3.1-pro-highspeed',
    shortcut: '⌘2',
  },
  {
    id: 'kimi:kimi-code/k3',
    providerId: 'kimi',
    providerLabel: 'Kimi',
    label: 'K3',
    slug: 'kimi-code/k3',
    shortcut: '⌘3',
    favorite: true,
  },
  {
    id: 'kimi:kimi-code/kimi-for-coding',
    providerId: 'kimi',
    providerLabel: 'Kimi',
    label: 'K2.8 Preview',
    slug: 'kimi-code/kimi-for-coding',
    shortcut: '⌘4',
  },
  {
    id: 'kimi:kimi-code/kimi-for-coding-highspeed',
    providerId: 'kimi',
    providerLabel: 'Kimi',
    label: 'K2.7 Code Highspeed',
    slug: 'kimi-code/kimi-for-coding-highspeed',
    shortcut: '⌘5',
  },
  {
    id: 'kimi:kimi-code/k3-256k',
    providerId: 'kimi',
    providerLabel: 'Kimi',
    label: 'K3-256k',
    slug: 'kimi-code/k3-256k',
    shortcut: '⌘6',
  },
  // fx models are Durango catalog ids; each turn routes to a connected
  // subscription first, then Durango credits or Vercel AI Gateway. Mirrors
  // fxFallbackModels in src/main/fx-provider.js; Durango's live catalog
  // replaces this block when signed in.
  ...([
    ['anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5'],
    ['openai/gpt-6-astra', 'GPT-6 Astra'],
    ['anthropic/claude-opus-5.5', 'Claude Opus 5.5'],
    ['openai/gpt-6.1-sol', 'GPT-6.1 Sol'],
    ['x-ai/grok-4.7', 'Grok 4.7'],
    ['google/gemini-3.8-flash', 'Gemini 3.8 Flash'],
    ['moonshotai/kimi-k3', 'Kimi K3'],
    ['openai/gpt-6-luna', 'GPT-6 Luna'],
    ['anthropic/claude-haiku-5.5', 'Claude Haiku 5.5'],
  ] as const).map(
    ([slug, label], index): AgentModel => ({
      id: `fx:${slug}`,
      providerId: 'fx',
      providerLabel: 'fx',
      label,
      slug,
      shortcut: `⌘${index + 1}`,
      ...(index < 5 ? { favorite: true } : {}),
    })
  ),
  // Muse Wonder (Full is subscription-only), then Muse Spark, which ships in
  // two tiers per generation: standard, and a discounted "contributor" tier
  // whose sessions Meta may use for product improvement. Mirrors
  // museFallbackModels in src/main/models.js; live discovery from the CLI's
  // model-catalog cache replaces this block when muse is installed.
  ...([
    ['muse-wonder-full-1.0', 'Muse Wonder Full 1.0'],
    ['muse-wonder-1.0', 'Muse Wonder 1.0'],
    ['muse-spark-1.3', 'Muse Spark 1.3'],
    ['muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor'],
    ['muse-spark-1.2', 'Muse Spark 1.2'],
    ['muse-spark-1.2-contributor', 'Muse Spark 1.2 Contributor'],
  ] as Array<[string, string]>).map(([slug, label], index) => ({
    id: `muse:${slug}`,
    providerId: 'muse' as const,
    providerLabel: 'Muse',
    label,
    slug,
    shortcut: `⌘${index + 1}`,
    favorite: slug === 'muse-wonder-1.0' || slug.startsWith('muse-spark-1.3'),
  })),
  {
    id: 'cursor:auto',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Auto',
    slug: 'auto',
    favorite: true,
  },
  {
    id: 'cursor:cursor-grok-4.6-high-fast',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Cursor Grok 4.6 Fast',
    slug: 'cursor-grok-4.6-high-fast',
    favorite: true,
  },
  {
    id: 'cursor:claude-opus-5-thinking-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Opus 5 1M Thinking',
    slug: 'claude-opus-5-thinking-high',
  },
  {
    id: 'cursor:claude-fable-5-thinking-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Fable 5 1M Thinking (NO ZDR)',
    slug: 'claude-fable-5-thinking-high',
  },
  {
    id: 'cursor:claude-sonnet-5-thinking-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Sonnet 5 1M Thinking',
    slug: 'claude-sonnet-5-thinking-high',
  },
  {
    id: 'cursor:gpt-5.6-sol-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'GPT-5.6 Sol 1M High',
    slug: 'gpt-5.6-sol-high',
  },
  {
    id: 'cursor:gpt-5.6-terra-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'GPT-5.6 Terra 1M High',
    slug: 'gpt-5.6-terra-high',
  },
  {
    id: 'cursor:gpt-5.6-luna-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'GPT-5.6 Luna 1M High',
    slug: 'gpt-5.6-luna-high',
  },
  {
    id: 'cursor:kimi-k3-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Kimi K3 High',
    slug: 'kimi-k3-high',
  },
  {
    id: 'cursor:gemini-3.6-flash-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Gemini 3.6 Flash',
    slug: 'gemini-3.6-flash-high',
  },
  {
    id: 'cursor:composer-2.5',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Composer 2.5',
    slug: 'composer-2.5',
    favorite: true,
  },
  {
    id: 'cursor:cursor-grok-4.5-high-fast',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Cursor Grok 4.5 Fast',
    slug: 'cursor-grok-4.5-high-fast',
  },
  {
    id: 'cursor:claude-opus-4-8-thinking-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'Opus 4.8 1M Thinking',
    slug: 'claude-opus-4-8-thinking-high',
  },
  {
    id: 'cursor:gpt-5.5-high',
    providerId: 'cursor',
    providerLabel: 'Cursor',
    label: 'GPT-5.5 1M High',
    slug: 'gpt-5.5-high',
  },
  ...([
    ['opencode/flint-40b-free', 'Flint 40B Free', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['opencode/nemotron-3.5-super-vl-free', 'Nemotron 3.5 Super VL Free', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']],
    ['opencode/beam-free', 'Beam Free', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['opencode/mimo-v2.6-flash-free', 'MiMo-V2.6-Flash Free', []],
    ['opencode/deepseek-v4.1-flash-free', 'DeepSeek V4.1 Flash Free', ['low', 'high', 'max']],
    ['opencode/glm-5.3-flash-free', 'GLM-5.3-Flash Free', ['low', 'high', 'max']],
    ['opencode/nemotron-3.5-lightning-free', 'Nemotron 3.5 Lightning Free', []],
    ['opencode/nemotron-3-ultra-free', 'Nemotron 3 Ultra Free', []],
    ['opencode/big-pickle', 'Big Pickle', []],
  ] as Array<[string, string, string[]]>).map(([slug, label, reasoningVariants], index) => ({
    id: `opencode:${slug}`,
    providerId: 'opencode' as const,
    providerLabel: 'OpenCode',
    label,
    slug,
    ...(reasoningVariants.length > 0 ? { reasoningVariants } : {}),
    ...(index < 9 ? { shortcut: `⌘${index + 1}` } : {}),
    favorite: slug === 'opencode/big-pickle',
  })),
];

export const defaultAgentModelId = 'grok:grok-4.7';

// The Orion pseudo-model: not a CLI harness, resolved by the renderer into
// the per-role models configured in Settings → Orchestration.
export const orionOrchestratorModelId = 'orion:orchestrator';

// Claude Code CLI pseudo-model: the thread hosts the interactive `claude` TUI
// in an embedded terminal instead of the chat transcript. Turns never go
// through agent:runTurn — the composer feeds straight into the PTY.
export const claudeCodeCliModelId = 'claude:claude-code-cli';

export const isClaudeCodeCliModelId = (modelId: string | undefined | null): boolean =>
  modelId === claudeCodeCliModelId;

export const isOrionModelId = (modelId: string | undefined | null): boolean =>
  modelId === orionOrchestratorModelId || (modelId ?? '').startsWith('orion:');

// Retired models with a direct successor in the catalog. Saved threads and
// settings that still name one resolve to its successor instead of the
// generic same-provider fallback below.
export const agentModelSuccessors: Record<string, string> = {
  'claude:claude-sonnet-5': 'claude:claude-sonnet-5-5',
  'claude:claude-haiku-4-5': 'claude:claude-haiku-5-5',
  'codex:gpt-5.5': 'codex:gpt-6.1-sol',
  'codex:gpt-5.4': 'codex:gpt-6.1-sol',
  'codex:gpt-5.4-mini': 'codex:gpt-6-luna',
  'codex:gpt-5.3-codex-spark': 'codex:gpt-6-luna',
  'grok:grok-composer-2.5-fast': 'grok:grok-4.7-build-fast',
};

const providerIdOfModelId = (id: string | null | undefined) =>
  id && id.includes(':') ? id.slice(0, id.indexOf(':')) : '';

export const findAgentModel = (models: AgentModel[], id: string | null | undefined) =>
  models.find((model) => model.id === id) ??
  (id && agentModelSuccessors[id] ? models.find((model) => model.id === agentModelSuccessors[id]) : undefined) ??
  // Threads saved on a model the provider no longer lists (live discovery
  // dropped it, or it was retired) stay on that provider rather than
  // dropping to another provider's default.
  (providerIdOfModelId(id)
    ? models.find((model) => model.providerId === providerIdOfModelId(id))
    : undefined) ??
  models.find((model) => model.id === defaultAgentModelId) ??
  models[0];
