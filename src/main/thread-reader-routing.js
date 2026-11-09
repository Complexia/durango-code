const mcpBridgeProviderIds = new Set(['codex', 'cursor', 'grok', 'kimi', 'fx', 'muse', 'opencode']);

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
  'request_user_action',
  'resolve_user_action',
  'request_secret',
  'show_html',
]);

// Headless runs cannot show permission prompts, so drivers pre-approve the
// orion tools by qualified name. They are safe in every access mode: spawned
// subthreads inherit the driver's mode, read_thread and the Durango Chat
// readers only read the user's own data, the user-action tools and
// show_html (a sandboxed page with no network) only change how Durango Code
// presents the thread, and request_secret saves only what the user enters. `remember` writes to the user's
// Durango memory, an external mutation, so Read only leaves it unapproved
// (and the tool itself refuses in that mode).
export const orionBuiltinToolNamesForAccessMode = (accessMode) =>
  accessMode === 'read-only'
    ? ORION_BUILTIN_TOOL_NAMES.filter((name) => name !== 'remember')
    : ORION_BUILTIN_TOOL_NAMES;

// The built-in browser's tools (browser-tools.js) are only listed for runs
// that use it. Like Claude in Chrome under Workspace write they are
// pre-approved; Read only lists just these two, which read existing tabs.
// test-builtin-browser.mjs keeps this list equal to the tools marked readOnly.
export const BROWSER_READ_TOOL_NAMES = Object.freeze(['browser_status', 'browser_snapshot']);
// Simulator tools (device-tools.js), offered only when the user let agents
// use devices. Listing and screenshots only read; opening boots a simulator
// and closing can shut one down, so Read only leaves those two unapproved.
export const ORION_DEVICE_TOOL_NAMES = Object.freeze([
  'device_list',
  'device_open',
  'device_screenshot',
  'device_close',
]);
export const orionDeviceToolNamesForAccessMode = (accessMode) =>
  accessMode === 'read-only'
    ? ORION_DEVICE_TOOL_NAMES.filter((name) => name === 'device_list' || name === 'device_screenshot')
    : ORION_DEVICE_TOOL_NAMES;

/** `name` is the unqualified orion tool name (e.g. `read_chat`). */
export const isPreapprovedOrionTool = (name, accessMode) =>
  typeof name === 'string' &&
  (orionBuiltinToolNamesForAccessMode(accessMode).includes(name) ||
    (name.startsWith('browser_') && (accessMode !== 'read-only' || BROWSER_READ_TOOL_NAMES.includes(name))) ||
    orionDeviceToolNamesForAccessMode(accessMode).includes(name));

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
