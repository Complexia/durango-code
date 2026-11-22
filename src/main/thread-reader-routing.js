const mcpBridgeProviderIds = new Set(['codex', 'cursor', 'grok', 'kimi', 'antigravity', 'fx', 'muse', 'opencode']);

// Bridge providers whose CLI keeps MCP tool definitions out of the model's
// context until the agent looks a tool up, as Claude's deferred tools do:
// Codex (0.169: deferred `mcp__orion` namespace, searched from code mode),
// Grok (search_tool / use_tool) and Cursor (MCP meta tool with slim
// descriptors). The others (Kimi, Antigravity, OpenCode, Muse, fx) send every listed
// tool's full definition with each request, so their bridge shim lists
// one-line summaries and serves full definitions through load_tools
// (--compact-tools in mcp-bridge-shim.cjs).
const nativeDeferredMcpProviderIds = new Set(['codex', 'grok', 'cursor']);
export const providerDefersMcpToolsNatively = (providerId) => nativeDeferredMcpProviderIds.has(providerId);

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

// Theme tools (theme-tools.js): get/set/manage only change how Durango Code looks on
// this computer, so every mode approves them; generate_theme_media spends
// Durango credits, an external mutation, so Read only leaves it unapproved
// (and the tool refuses in that mode). Served through `__tools` for the
// bridge, so the shim's static list does not include them.
export const ORION_THEME_TOOL_NAMES = Object.freeze(['get_app_theme', 'set_app_theme', 'manage_app_themes', 'generate_theme_media']);
export const orionThemeToolNamesForAccessMode = (accessMode) =>
  accessMode === 'read-only'
    ? ORION_THEME_TOOL_NAMES.filter((name) => name !== 'generate_theme_media')
    : ORION_THEME_TOOL_NAMES;

// Using Durango Code's own window (app-tools.js): app_snapshot only reads, so
// every mode approves it; clicking, typing, keys and scrolling act as the user
// (they can change settings or answer prompts), so only Full access approves
// them, Workspace write asks for each, and Read only refuses them in the tool.
// Served through `__tools` for the bridge, like the theme tools.
export const ORION_APP_READ_TOOL_NAMES = Object.freeze(['app_snapshot']);
export const ORION_APP_TOOL_NAMES = Object.freeze(['app_snapshot', 'app_click', 'app_type', 'app_press', 'app_scroll']);
export const orionAppToolNamesForAccessMode = (accessMode) =>
  accessMode === 'full-access' ? ORION_APP_TOOL_NAMES : ORION_APP_READ_TOOL_NAMES;

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

// The user's other machines (machine-tools.js), offered while remote control
// can reach one. Listing and reading are pre-approved in every mode; running
// commands and agents there only in Full access, so Workspace write asks for
// each (Read only refuses them in the tool itself).
export const ORION_MACHINE_READ_TOOL_NAMES = Object.freeze(['machine_list', 'machine_threads', 'machine_read_thread']);
export const ORION_MACHINE_TOOL_NAMES = Object.freeze([
  ...ORION_MACHINE_READ_TOOL_NAMES,
  'machine_exec',
  'machine_run_agent',
  'machine_stop_agent',
]);
export const orionMachineToolNamesForAccessMode = (accessMode) =>
  accessMode === 'full-access' ? ORION_MACHINE_TOOL_NAMES : ORION_MACHINE_READ_TOOL_NAMES;

// The thread's project notes (project-notes-tool.js) only read the person's
// own notes, so every mode approves them. Served through `__tools` for the
// bridge, like the theme tools.
export const ORION_PROJECT_NOTES_TOOL_NAMES = Object.freeze(['project_notes']);

// load_tools (mcp-on-demand.js, mcp-bridge-shim.cjs) only returns tool
// definitions and connects servers the user set up; their tools keep their
// own approval. Claude pre-approves it in every mode too.
export const ORION_LOADER_TOOL_NAME = 'load_tools';

/** `name` is the unqualified orion tool name (e.g. `read_chat`). */
export const isPreapprovedOrionTool = (name, accessMode) =>
  typeof name === 'string' &&
  (name === ORION_LOADER_TOOL_NAME ||
    orionBuiltinToolNamesForAccessMode(accessMode).includes(name) ||
    (name.startsWith('browser_') && (accessMode !== 'read-only' || BROWSER_READ_TOOL_NAMES.includes(name))) ||
    orionDeviceToolNamesForAccessMode(accessMode).includes(name) ||
    orionMachineToolNamesForAccessMode(accessMode).includes(name) ||
    orionThemeToolNamesForAccessMode(accessMode).includes(name) ||
    orionAppToolNamesForAccessMode(accessMode).includes(name) ||
    ORION_PROJECT_NOTES_TOOL_NAMES.includes(name));

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
