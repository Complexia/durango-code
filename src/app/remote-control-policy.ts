// Kept free of agentCatalog / store imports so node --experimental-strip-types
// unit tests can load this module without extension resolution for the whole
// catalog tree. Option sets mirror agentCatalog.ts / modelPrefs.ts.

export const remoteThreadRuntime = (modelId: string): 'agent' | 'terminal' =>
  modelId === 'claude:claude-code-cli' ? 'terminal' : 'agent';

export const remoteThreadRunError = (modelId: string) =>
  remoteThreadRuntime(modelId) === 'terminal'
    ? 'Claude Code CLI terminal threads cannot be run through Remote Control because their output is only available in the host terminal.'
    : null;

const GROK_REASONING = new Set(['low', 'medium', 'high']);
const GROK_XHIGH_REASONING = new Set([...GROK_REASONING, 'xhigh']);
// Extra High is advertised by Grok 4.6 and newer; older Grok models reject it.
const GROK_XHIGH_SLUGS = new Set(['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6']);
const MUSE_REASONING = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const CLAUDE_REASONING = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultracode',
  'ultrathink',
]);
const CODEX_REASONING = new Set(['low', 'medium', 'high', 'xhigh']);
const GPT6_CODEX_REASONING = new Set([...CODEX_REASONING, 'max', 'ultra']);
// Luna offers Max but not Ultra.
const GPT6_LUNA_CODEX_REASONING = new Set([...CODEX_REASONING, 'max']);
const GPT6_CODEX_SLUGS = new Set([
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
]);
const CODEX_LUNA_SLUGS = new Set(['gpt-6-luna', 'gpt-5.6-luna']);
// Durango Code's Ultracode and Ultrathink run Claude at Extra High and High.
const CLAUDE_CLI_EFFORT: Record<string, string> = { ultracode: 'xhigh', ultrathink: 'high' };
const CLAUDE_1M_ONLY_SLUGS = new Set([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5',
  'claude-opus-5',
]);

type RemoteAgentSettingsThread = {
  modelId?: string;
  codexReasoningEffort?: string;
  codexServiceTier?: string;
  claudeReasoningEffort?: string;
  claudeContextWindow?: string;
  grokReasoningEffort?: string;
  museReasoningEffort?: string;
  openCodeReasoningEffort?: string;
};

type RemoteAgentSettingsModel = {
  providerId?: string;
  slug?: string;
  reasoningVariants?: string[];
  // Live-catalog tiers; when present they replace the static sets below.
  reasoningEfforts?: string[];
};

/**
 * Map provider-agnostic remote runTurn settings onto the thread fields the
 * local composer would have written. Unknown / wrong-provider values are
 * dropped (same spirit as sanitizeAccessMode) so a controller never poisons
 * the host store with a tier the local picker could not pick.
 */
export const remoteAgentSettingsPatch = (
  thread: RemoteAgentSettingsThread,
  model: RemoteAgentSettingsModel | undefined,
  input: {
    reasoningEffort?: string;
    codexServiceTier?: string;
    claudeContextWindow?: string;
  }
): RemoteAgentSettingsThread => {
  const patch: RemoteAgentSettingsThread = {};
  if (!model?.providerId) return patch;

  if (input.reasoningEffort) {
    const liveEfforts =
      model.reasoningEfforts && model.reasoningEfforts.length > 0 ? new Set(model.reasoningEfforts) : null;
    if (model.providerId === 'grok') {
      const allowed =
        liveEfforts ?? (model.slug && GROK_XHIGH_SLUGS.has(model.slug) ? GROK_XHIGH_REASONING : GROK_REASONING);
      if (allowed.has(input.reasoningEffort) && thread.grokReasoningEffort !== input.reasoningEffort) {
        patch.grokReasoningEffort = input.reasoningEffort;
      }
    } else if (model.providerId === 'muse') {
      if ((liveEfforts ?? MUSE_REASONING).has(input.reasoningEffort) && thread.museReasoningEffort !== input.reasoningEffort) {
        patch.museReasoningEffort = input.reasoningEffort;
      }
    } else if (model.providerId === 'claude') {
      if (
        CLAUDE_REASONING.has(input.reasoningEffort) &&
        (!liveEfforts || liveEfforts.has(CLAUDE_CLI_EFFORT[input.reasoningEffort] ?? input.reasoningEffort)) &&
        thread.claudeReasoningEffort !== input.reasoningEffort
      ) {
        patch.claudeReasoningEffort = input.reasoningEffort;
      }
    } else if (model.providerId === 'codex') {
      const allowed =
        liveEfforts ??
        (model.slug && CODEX_LUNA_SLUGS.has(model.slug)
          ? GPT6_LUNA_CODEX_REASONING
          : model.slug && GPT6_CODEX_SLUGS.has(model.slug)
            ? GPT6_CODEX_REASONING
            : CODEX_REASONING);
      if (allowed.has(input.reasoningEffort) && thread.codexReasoningEffort !== input.reasoningEffort) {
        patch.codexReasoningEffort = input.reasoningEffort;
      }
    } else if (model.providerId === 'opencode') {
      const allowed = new Set(['default', ...(model.reasoningVariants ?? [])]);
      if (
        allowed.has(input.reasoningEffort) &&
        thread.openCodeReasoningEffort !== input.reasoningEffort
      ) {
        patch.openCodeReasoningEffort = input.reasoningEffort;
      }
    }
  }

  if (input.codexServiceTier && model.providerId === 'codex') {
    if (
      (input.codexServiceTier === 'default' || input.codexServiceTier === 'priority') &&
      thread.codexServiceTier !== input.codexServiceTier
    ) {
      patch.codexServiceTier = input.codexServiceTier;
    }
  }

  if (input.claudeContextWindow && model.providerId === 'claude') {
    const requested =
      input.claudeContextWindow === '200k' || input.claudeContextWindow === '1m'
        ? input.claudeContextWindow
        : null;
    if (requested) {
      const effective =
        model.slug && CLAUDE_1M_ONLY_SLUGS.has(model.slug) ? '1m' : requested;
      if (thread.claudeContextWindow !== effective) patch.claudeContextWindow = effective;
    }
  }

  return patch;
};

/**
 * Keep a provider-native subagent's persisted execution settings aligned with
 * the model and effort reported by its own transcript. The effort still goes
 * through the same provider/model validation as a remote composer change.
 */
export const reportedSubagentSettingsPatch = (
  thread: RemoteAgentSettingsThread,
  model: RemoteAgentSettingsModel | undefined,
  reportedModelId: string | undefined,
  reasoningEffort: string | undefined
): RemoteAgentSettingsThread => ({
  ...(reportedModelId && thread.modelId !== reportedModelId
    ? { modelId: reportedModelId }
    : {}),
  ...remoteAgentSettingsPatch(thread, model, { reasoningEffort }),
});

// A pairing code is usable over ANY live inbound route. In internet mode the
// LAN listener stays up too, so a relay outage must not disable "Generate
// code" while a LAN/VPN pair would still succeed — this mirrors the engine's
// own hostAcceptingConnections() (listening || relay listener).
export const canGenerateRemotePairingCode = ({
  connectionMode,
  hostListening,
  relayOnline,
}: {
  connectionMode: 'direct' | 'relay';
  hostListening: boolean;
  relayOnline: boolean;
}) => hostListening || (connectionMode === 'relay' && relayOnline);

export const remoteControlIsAuthenticated = (
  accountAuthenticated: boolean,
  engineAuthenticated: boolean | undefined
) => accountAuthenticated && engineAuthenticated === true;

export const parseRemotePortDraft = (value: string) => {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
};

export const mergeSynchronouslyTrackedRuns = (
  activeRunsByThread: Record<string, string>,
  trackedRuns: Iterable<[string, { threadId: string }]>
) => {
  const merged = new Map<string, string>(Object.entries(activeRunsByThread));
  for (const [runId, tracked] of trackedRuns) {
    // The synchronous registry wins when React's ref still holds the previous
    // render's run id for this thread.
    merged.set(tracked.threadId, runId);
  }
  return merged;
};

export const claimRemoteSideEffect = async (
  canPrepare: () => boolean,
  claim: () => Promise<boolean>
) => canPrepare() && (await claim());

export const claimRemoteThreadStart = async (
  claim: () => Promise<boolean>,
  applyClaimedSettings?: () => void
) => {
  if (!(await claim())) return false;
  applyClaimedSettings?.();
  return true;
};

export type RemoteCommandOutcome = {
  ok: boolean;
  threadId?: string;
  /** Durango Chat dispatch: the new thread's title, reported with `running`. */
  threadTitle?: string;
  error?: string;
};

export const persistSuccessfulRemoteCommand = async (
  outcome: RemoteCommandOutcome,
  persistThreads: () => Promise<boolean>
): Promise<RemoteCommandOutcome> => {
  if (!outcome.ok) return outcome;
  try {
    if (await persistThreads()) return outcome;
  } catch {}
  return {
    ok: false,
    threadId: outcome.threadId,
    error: 'The remote command changed the host, but its thread state could not be saved.',
  };
};
