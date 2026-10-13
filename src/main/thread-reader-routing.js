const mcpBridgeProviderIds = new Set(['codex', 'cursor', 'grok', 'kimi', 'muse', 'opencode']);

// Tools served by Durango Code's own `orion` MCP server (in-process for
// Claude, the bridge shim for everyone else).
export const ORION_BUILTIN_TOOL_NAMES = Object.freeze([
  'spawn_subagent',
  'stop_subagent',
  'read_thread',
  'search_chats',
  'read_chat',
  'recall_memory',
  'remember',
]);

// Headless runs cannot show permission prompts, so drivers pre-approve the
// orion tools by qualified name. They are safe in every access mode: spawned
// subthreads inherit the driver's mode, read_thread and the Durango Chat
// readers only read the user's own data. `remember` writes to the user's
// Durango memory, an external mutation, so Read only leaves it unapproved
// (and the tool itself refuses in that mode).
export const orionBuiltinToolNamesForAccessMode = (accessMode) =>
  accessMode === 'read-only'
    ? ORION_BUILTIN_TOOL_NAMES.filter((name) => name !== 'remember')
    : ORION_BUILTIN_TOOL_NAMES;

/** `name` is the unqualified orion tool name (e.g. `read_chat`). */
export const isPreapprovedOrionTool = (name, accessMode) =>
  typeof name === 'string' && orionBuiltinToolNamesForAccessMode(accessMode).includes(name);

const runPluginHelpCommand = (providerId) =>
  providerId === 'cursor'
    ? 'cursor-agent --help'
    : providerId === 'grok'
      ? 'grok agent --help'
      : null;

export const probeProviderRunPluginSupport = async (
  providerId,
  { shellPathReady, runShellCommand }
) => {
  const helpCommand = runPluginHelpCommand(providerId);
  if (!helpCommand) return true;

  // Finder-launched builds begin with a minimal PATH. Do not cache a failed
  // Grok/Cursor capability result until Orion has imported the user's shell
  // PATH, otherwise the composer hides @thread choices for the whole app run.
  await shellPathReady;
  try {
    const { stdout, stderr } = await runShellCommand(helpCommand, 10000);
    return `${stdout}\n${stderr}`.includes('--plugin-dir');
  } catch {
    return false;
  }
};

export const isMcpBridgeProvider = (providerId) => mcpBridgeProviderIds.has(providerId);

export const requiresRegisteredThreadReaderBridge = (providerId, hasThreadMentions) =>
  hasThreadMentions === true && isMcpBridgeProvider(providerId);

// OpenCode and Muse take the bridge through provider-specific config that can
// fail to build after registration succeeds (inline config merge / synthetic
// settings root), so their readiness needs that extra signal.
export const isEffectiveThreadReaderBridgeReady = (
  providerId,
  bridgeRegistered,
  openCodeConfigReady,
  museConfigReady
) =>
  bridgeRegistered === true &&
  (providerId !== 'opencode' || openCodeConfigReady === true) &&
  (providerId !== 'muse' || museConfigReady === true);

export const isRequiredThreadReaderBridgeMissing = (
  providerId,
  hasThreadMentions,
  bridgeRegistered
) => requiresRegisteredThreadReaderBridge(providerId, hasThreadMentions) && !bridgeRegistered;
