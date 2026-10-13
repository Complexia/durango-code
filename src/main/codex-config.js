import { parseExtraArgs } from './models.js';

const codexSettingMode = (value) =>
  value === 'enabled' || value === 'disabled' ? value : 'inherit';

const codexConfigValueFlags = new Set([
  '-c',
  '--config',
  '-p',
  '--profile',
  '--enable',
  '--disable',
]);

const isInlineCodexConfigFlag = (argument) =>
  argument.startsWith('--config=') ||
  argument.startsWith('--profile=') ||
  argument.startsWith('--enable=') ||
  argument.startsWith('--disable=') ||
  (/^-[cp].+/.test(argument) && argument !== '-c' && argument !== '-p');

/**
 * Keep process-level Codex config flags in one ordered list so auxiliary
 * commands (such as `mcp list`) resolve the same profile and overrides as the
 * app-server process that consumes their output.
 */
export const splitCodexConfigContextArgs = (providerOptions) => {
  const options =
    providerOptions && typeof providerOptions === 'object' ? providerOptions : {};
  const extraArgs = parseExtraArgs(options.extraArgs);
  const configArgs = [];
  const commandArgs = [];

  for (let index = 0; index < extraArgs.length; index += 1) {
    const argument = extraArgs[index];
    if (codexConfigValueFlags.has(argument)) {
      configArgs.push(argument);
      if (index + 1 < extraArgs.length) configArgs.push(extraArgs[++index]);
      continue;
    }
    if (argument === '--strict-config' || isInlineCodexConfigFlag(argument)) {
      configArgs.push(argument);
      continue;
    }
    commandArgs.push(argument);
  }

  return { configArgs, commandArgs };
};

// Hidden title/git-message turns should never read from or contribute to the
// user's memories. Keep this in the shared config module so every utility
// caller gets the same fail-closed policy without renderer-provided settings.
export const codexUtilityPrivacyOptions = Object.freeze({
  codexMemoryMode: 'disabled',
  codexChronicleMode: 'disabled',
  codexMemoryExternalContextMode: 'disabled',
});

// This is within-thread context retention, separate from cross-chat memories.
// Astra opts in by default; other models retain their native Codex settings.
export const codexModelConfig = (model, providerOptions) => {
  const mode = providerOptions?.codexContextManagementMode;
  if (mode === 'disabled') return { 'features.context_management.experimental_mode': false };
  if (mode === 'enabled' || (mode !== 'codex' && model?.slug === 'gpt-6-astra')) {
    return { 'features.context_management.experimental_mode': true };
  }
  return {};
};

/**
 * Config shared by `codex exec` and app-server-backed turns.
 *
 * The modes are deliberately tri-state. An absent Orion preference must keep
 * honoring the user's normal $CODEX_HOME/config.toml instead of quietly
 * turning a privacy-sensitive Codex feature on or off.
 */
export const codexPersonalizationConfig = (providerOptions) => {
  const options =
    providerOptions && typeof providerOptions === 'object' ? providerOptions : {};
  const config = {};

  const memoryMode = codexSettingMode(options.codexMemoryMode);
  if (memoryMode !== 'inherit') {
    const enabled = memoryMode === 'enabled';
    config['features.memories'] = enabled;
    config['memories.use_memories'] = enabled;
    config['memories.generate_memories'] = enabled;
  }

  const chronicleMode = codexSettingMode(options.codexChronicleMode);
  if (chronicleMode !== 'inherit') {
    config['features.chronicle'] = chronicleMode === 'enabled';
  }

  const externalContextMode = codexSettingMode(
    options.codexMemoryExternalContextMode
  );
  if (externalContextMode !== 'inherit') {
    config['memories.disable_on_external_context'] =
      externalContextMode === 'disabled';
  }

  if (
    options.codexPersonality === 'none' ||
    options.codexPersonality === 'friendly' ||
    options.codexPersonality === 'pragmatic'
  ) {
    config.personality = options.codexPersonality;
  }

  const developerInstructions =
    typeof options.codexDeveloperInstructions === 'string'
      ? options.codexDeveloperInstructions.trim()
      : '';
  if (developerInstructions) {
    config.developer_instructions = developerInstructions;
  }

  return config;
};

export const codexConfigArgs = (config) =>
  Object.entries(config).flatMap(([key, value]) => [
    '--config',
    `${key}=${JSON.stringify(value)}`,
  ]);

export const codexBrowserUseMode = (providerOptions) => {
  const options =
    providerOptions && typeof providerOptions === 'object' ? providerOptions : {};
  if (
    options.browserUseMode === 'disabled' ||
    options.browserUseMode === 'extension' ||
    options.browserUseMode === 'mcp'
  ) {
    return options.browserUseMode;
  }
  // Only migrate users who explicitly enabled the old signed-in Chrome
  // auto-connect option. browserControl by itself meant a separate profile
  // and must not be reinterpreted as access to the user's normal Chrome.
  return options.browserControl === true && options.browserAutoConnect === true
    ? 'mcp'
    : 'disabled';
};

export const codexBrowserMcpConfig = (providerOptions, accessMode, mcpPackage) => {
  const mode = codexBrowserUseMode(providerOptions);
  if (accessMode === 'read-only' || mode === 'disabled') return {};
  const options =
    providerOptions && typeof providerOptions === 'object' ? providerOptions : {};
  return {
    'mcp_servers.chrome_devtools.command': 'npx',
    'mcp_servers.chrome_devtools.args': [
      '-y',
      mcpPackage,
      // Extension setup does not guarantee its app-owned runtime can connect
      // from Orion. Always provide a self-contained fallback, without granting
      // access to the user's signed-in profile through remote debugging.
      ...(mode === 'mcp' && options.browserAutoConnect !== false ? ['--autoConnect'] : []),
    ],
    'mcp_servers.chrome_devtools.startup_timeout_sec': 90,
  };
};

// Keep browser steering shared by exec and app-server turns. The extension
// setup probe is advisory: the actual tools in a turn determine whether the
// extension can be used. Both modes retain a working MCP browser path.
export const codexBrowserEnvironmentNote = (providerOptions, accessMode) => {
  if (accessMode === 'read-only') return '';
  const mode = codexBrowserUseMode(providerOptions);
  if (mode === 'extension') {
    return `[Environment note: the user selected the ChatGPT Chrome extension for browser tasks. Discover the browser tools available in this session and follow their tool-provided instructions (for example, cua_repl), or a browser skill actually listed in this session. Extension setup alone does not guarantee a usable connection. If the extension workflow is missing or cannot connect, use the available chrome_devtools MCP tools for browser verification instead of stopping at a missing skill. This fallback uses a dedicated browser profile without the user's signed-in Chrome tabs, logins, or cookies; if the task requires those, explain that limitation. When using signed-in Chrome, preserve tabs you did not open.]\n\n`;
  }
  if (mode === 'mcp') {
    if (providerOptions?.browserAutoConnect === false) {
      return `[Environment note: Durango Code configured a dedicated browser for this session. For browser tasks, discover and use the chrome_devtools MCP tools available in this session. They run in a dedicated browser profile, so signed-in Chrome tabs, logins, and cookies are unavailable. Browser verification does not require a separate Chrome skill.]\n\n`;
    }
    return `[Environment note: for browser tasks, discover and use the chrome_devtools MCP tools available in this session; they attach to the user's real signed-in Chrome, so treat open tabs and logins with care and do not close tabs you did not open. If those tools report "Could not connect to Chrome", tell the user to open chrome://inspect/#remote-debugging in Chrome, turn the remote debugging toggle on, quit and reopen Chrome (the server only starts on launch), and retry — do not attempt workarounds.]\n\n`;
  }
  return '';
};
