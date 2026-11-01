import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  codexBrowserEnvironmentNote,
  codexBrowserMcpConfig,
  codexBrowserUseMode,
  codexConfigArgs,
  codexModelConfig,
  codexPersonalizationConfig,
  codexUtilityPrivacyOptions,
} from '../src/main/codex-config.js';
import {
  codexBrowserOptionsForIntegration,
  parseCodexChromePlugin,
  parseCodexNodeReplEnabled,
  probeCodexBrowserIntegration,
} from '../src/main/codex-browser-integration.js';

const astraModel = { slug: 'gpt-6-astra' };
const contextFlag = 'features.context_management.experimental_mode';
assert.deepEqual(codexModelConfig(astraModel), { [contextFlag]: true });
assert.deepEqual(codexModelConfig(astraModel, { codexContextManagementMode: 'inherit' }), { [contextFlag]: true });
assert.deepEqual(codexModelConfig(astraModel, { codexContextManagementMode: 'disabled' }), { [contextFlag]: false });
assert.deepEqual(codexModelConfig(astraModel, { codexContextManagementMode: 'codex' }), {});
assert.deepEqual(codexModelConfig({ slug: 'gpt-5.6-sol' }), {}, 'other models keep native context defaults');
assert.deepEqual(codexModelConfig({ slug: 'gpt-5.6-sol' }, { codexContextManagementMode: 'enabled' }), { [contextFlag]: true });
assert.deepEqual(codexPersonalizationConfig({ codexContextManagementMode: 'enabled' }), {}, 'within-chat context must not enable cross-chat memories');

assert.deepEqual(codexPersonalizationConfig(), {});
assert.deepEqual(
  codexPersonalizationConfig({
    codexMemoryMode: 'inherit',
    codexChronicleMode: 'inherit',
    codexMemoryExternalContextMode: 'inherit',
    codexPersonality: 'inherit',
    codexDeveloperInstructions: '   ',
  }),
  {}
);

assert.deepEqual(
  codexPersonalizationConfig({
    codexMemoryMode: 'enabled',
    codexChronicleMode: 'enabled',
    codexMemoryExternalContextMode: 'enabled',
    codexPersonality: 'pragmatic',
    codexDeveloperInstructions: '  Keep responses compact.  ',
  }),
  {
    'features.memories': true,
    'memories.use_memories': true,
    'memories.generate_memories': true,
    'features.chronicle': true,
    'memories.disable_on_external_context': false,
    personality: 'pragmatic',
    developer_instructions: 'Keep responses compact.',
  }
);

assert.deepEqual(
  codexPersonalizationConfig({
    codexMemoryMode: 'disabled',
    codexChronicleMode: 'disabled',
    codexMemoryExternalContextMode: 'disabled',
    codexPersonality: 'unexpected',
  }),
  {
    'features.memories': false,
    'memories.use_memories': false,
    'memories.generate_memories': false,
    'features.chronicle': false,
    'memories.disable_on_external_context': true,
  }
);

assert.deepEqual(codexPersonalizationConfig(codexUtilityPrivacyOptions), {
  'features.memories': false,
  'memories.use_memories': false,
  'memories.generate_memories': false,
  'features.chronicle': false,
  'memories.disable_on_external_context': true,
});

assert.deepEqual(codexConfigArgs({
  'features.memories': true,
  developer_instructions: 'Use "quoted" guidance.',
}), [
  '--config',
  'features.memories=true',
  '--config',
  'developer_instructions="Use \\"quoted\\" guidance."',
]);

// No choice (and the legacy separate-profile toggle) means the built-in browser.
assert.match(codexBrowserEnvironmentNote({}, 'full-access'), /built-in browser: the browser_\* tools of the orion MCP server/);
assert.match(codexBrowserEnvironmentNote({}, 'full-access'), /untrusted/);
assert.equal(codexBrowserEnvironmentNote({}, 'full-access', { builtinAvailable: false }), '', 'no orion bridge, no built-in browser note');
assert.equal(codexBrowserEnvironmentNote({ browserUseMode: 'disabled' }, 'full-access'), '');
assert.equal(codexBrowserEnvironmentNote({ browserControl: true }, 'read-only'), '');
assert.equal(codexBrowserUseMode({}), 'builtin');
assert.equal(codexBrowserUseMode({ browserControl: true }), 'builtin');
assert.equal(codexBrowserUseMode({ browserUseMode: 'disabled' }), 'disabled');
assert.equal(codexBrowserUseMode({ browserUseMode: 'builtin' }), 'builtin');
assert.deepEqual(codexBrowserMcpConfig({}, 'full-access', 'test'), {}, 'the built-in browser needs no chrome-devtools MCP');
assert.equal(codexBrowserUseMode({ browserControl: true, browserAutoConnect: true }), 'mcp');
assert.equal(codexBrowserUseMode({ browserControl: true, browserUseMode: 'extension' }), 'extension');
const extensionNote = codexBrowserEnvironmentNote({ browserUseMode: 'extension' }, 'full-access');
assert.match(extensionNote, /ChatGPT Chrome extension/);
assert.match(extensionNote, /cua_repl/);
assert.match(extensionNote, /skill actually listed in this session/);
// With the built-in browser: signed-in Chrome for logins, built-in for the rest.
assert.match(extensionNote, /signed-in Chrome for anything that needs their accounts[\s\S]*Cloudflare/);
assert.match(extensionNote, /browser_\* tools of the orion MCP server[\s\S]*never ask the user to sign in there/);
assert.match(extensionNote, /request_user_action either to fix the ChatGPT Chrome extension or to sign in to that site in the built-in browser panel/);
assert.match(codexBrowserEnvironmentNote({}, 'full-access'), /request_user_action to sign in to that site in the built-in browser panel/);
assert.doesNotMatch(extensionNote, /chrome_devtools|dedicated browser profile/, 'no separate-profile fallback next to the built-in browser');
assert.doesNotMatch(extensionNote, /control-chrome|verified Codex browser integration/);
const bridgelessExtensionNote = codexBrowserEnvironmentNote({ browserUseMode: 'extension' }, 'full-access', { builtinAvailable: false });
assert.match(bridgelessExtensionNote, /chrome_devtools MCP tools/);
assert.match(bridgelessExtensionNote, /dedicated browser profile/);
assert.doesNotMatch(bridgelessExtensionNote, /browser_\*/);
const mcpNote = codexBrowserEnvironmentNote({ browserUseMode: 'mcp' }, 'full-access');
assert.match(mcpNote, /chrome_devtools MCP tools/);
assert.match(mcpNote, /real signed-in Chrome/);
assert.match(mcpNote, /remote debugging toggle/);
assert.match(mcpNote, /built-in browser: the browser_\* tools[\s\S]*never ask the user to sign in there/);
const fallbackMcpNote = codexBrowserEnvironmentNote(
  { browserUseMode: 'mcp', browserAutoConnect: false },
  'full-access'
);
assert.match(fallbackMcpNote, /dedicated browser profile/);
assert.doesNotMatch(fallbackMcpNote, /enable Chrome remote debugging/);
assert.deepEqual(
  codexBrowserMcpConfig({ browserUseMode: 'mcp' }, 'full-access', 'chrome-devtools-mcp@test'),
  {
    'mcp_servers.chrome_devtools.command': 'npx',
    'mcp_servers.chrome_devtools.args': ['-y', 'chrome-devtools-mcp@test', '--autoConnect'],
    'mcp_servers.chrome_devtools.startup_timeout_sec': 90,
  }
);
assert.deepEqual(
  codexBrowserMcpConfig({ browserUseMode: 'extension' }, 'full-access', 'chrome-devtools-mcp@test'),
  {
    'mcp_servers.chrome_devtools.command': 'npx',
    'mcp_servers.chrome_devtools.args': ['-y', 'chrome-devtools-mcp@test'],
    'mcp_servers.chrome_devtools.startup_timeout_sec': 90,
  }
);
assert.deepEqual(
  codexBrowserMcpConfig({ browserUseMode: 'extension', browserAutoConnect: true }, 'full-access', 'chrome-devtools-mcp@test'),
  codexBrowserMcpConfig({ browserUseMode: 'extension' }, 'full-access', 'chrome-devtools-mcp@test'),
  'extension fallback must never inherit signed-in remote debugging access'
);
assert.deepEqual(
  codexBrowserMcpConfig({ browserUseMode: 'extension' }, 'full-access', 'chrome-devtools-mcp@test', { builtinAvailable: true }),
  {},
  'the built-in browser replaces the extension mode\'s separate-profile fallback'
);
for (const browserUseMode of ['disabled', 'extension']) {
  assert.deepEqual(codexBrowserMcpConfig({ browserUseMode }, 'read-only', 'test'), {});
}
assert.deepEqual(codexBrowserMcpConfig({ browserUseMode: 'disabled' }, 'full-access', 'test'), {});
assert.deepEqual(
  codexBrowserMcpConfig(
    { browserUseMode: 'mcp', browserAutoConnect: false },
    'full-access',
    'chrome-devtools-mcp@test'
  ),
  {
    'mcp_servers.chrome_devtools.command': 'npx',
    'mcp_servers.chrome_devtools.args': ['-y', 'chrome-devtools-mcp@test'],
    'mcp_servers.chrome_devtools.startup_timeout_sec': 90,
  }
);
assert.deepEqual(
  codexBrowserMcpConfig({ browserUseMode: 'mcp' }, 'read-only', 'chrome-devtools-mcp@test'),
  {}
);

const pluginList = `chrome@openai-bundled  installed, enabled  1.2.3  /tmp/chrome-plugin`;
assert.deepEqual(parseCodexChromePlugin(pluginList), {
  installed: true,
  enabled: true,
  path: '/tmp/chrome-plugin',
});
assert.equal(parseCodexNodeReplEnabled('node_repl  /tmp/node_repl  -  -  -  enabled  Unsupported'), true);
assert.equal(parseCodexNodeReplEnabled('node_repl_old  /tmp/node_repl  -  -  -  enabled  Unsupported'), false);
assert.deepEqual(
  codexBrowserOptionsForIntegration({ browserUseMode: 'extension', webSearch: true }, { ready: false }),
  { browserUseMode: 'extension', webSearch: true },
  'the probe is advisory: an unverified extension stays the choice'
);
assert.deepEqual(
  codexBrowserOptionsForIntegration({ browserUseMode: 'extension', webSearch: true }, { ready: false, builtinAvailable: false }),
  { browserUseMode: 'mcp', browserAutoConnect: false, webSearch: true },
  'runs without the bridge keep the separate-profile fallback'
);
assert.deepEqual(
  codexBrowserOptionsForIntegration({ browserUseMode: 'extension' }, { ready: true }),
  { browserUseMode: 'extension' }
);
const probeCommands = [];
const readyProbe = await probeCodexBrowserIntegration(async (command) => {
  probeCommands.push(command);
  if (command === 'codex plugin list') return { stdout: pluginList };
  if (command === 'codex mcp list') {
    return { stdout: 'node_repl  /tmp/node_repl  -  -  -  enabled  Unsupported' };
  }
  if (command.includes('check-extension-installed.js')) {
    return { stdout: JSON.stringify({ installed: true, enabled: true }) };
  }
  if (command.includes('check-native-host-manifest.js')) {
    return { stdout: JSON.stringify({ correct: true }) };
  }
  throw new Error(`Unexpected command: ${command}`);
}, async (skillPath) => {
  assert.equal(skillPath, '/tmp/chrome-plugin/skills/control-chrome/SKILL.md');
  return 'Legacy browser instructions';
});
assert.equal(readyProbe.ready, true);
assert.equal(probeCommands.length, 4);

const browserProbe = (mcpOutput, skillContents) => probeCodexBrowserIntegration(async (command) => {
  if (command === 'codex plugin list') return { stdout: pluginList };
  if (command === 'codex mcp list') return { stdout: mcpOutput };
  return { stdout: JSON.stringify(command.includes('check-extension-installed.js')
    ? { installed: true, enabled: true } : { correct: true }) };
}, async () => {
  if (skillContents === undefined) throw new Error('ENOENT');
  return skillContents;
});
const missingSkillProbe = await browserProbe('node_repl  /tmp/node_repl  enabled');
assert.equal(missingSkillProbe.ready, false, 'extension and native host cannot conceal a removed browser skill');
assert.equal(missingSkillProbe.browserWorkflowAvailable, false);
assert.match(missingSkillProbe.detail, /no available Chrome browser workflow/);
assert.equal(codexBrowserOptionsForIntegration({ browserUseMode: 'extension' }, missingSkillProbe).browserUseMode, 'extension');
assert.equal((await browserProbe('node_repl  /tmp/node_repl  enabled', '')).ready, false);
const modernProbe = await browserProbe('cua_repl  /tmp/cua_repl  enabled');
assert.equal(modernProbe.ready, true, 'self-describing CUA does not require the removed skill or old node_repl');
assert.equal(modernProbe.browserWorkflowAvailable, true);
assert.match(modernProbe.detail, /checks the connection when a task uses it/);
assert.equal((await browserProbe('cua_repl  /tmp/cua_repl  disabled')).ready, false);
const unavailableProbe = await probeCodexBrowserIntegration(async () => { throw new Error('unavailable'); });
assert.equal(unavailableProbe.ready, false);
assert.equal(unavailableProbe.browserWorkflowAvailable, false);
const missingExtensionProbe = await probeCodexBrowserIntegration(async (command) => {
  if (command === 'codex plugin list') return { stdout: pluginList };
  if (command === 'codex mcp list') {
    return { stdout: 'node_repl  /tmp/node_repl  -  -  -  enabled  Unsupported' };
  }
  const error = new Error('diagnostic reported missing setup');
  error.stdout = command.includes('check-extension-installed.js')
    ? JSON.stringify({ installed: false, enabled: false })
    : JSON.stringify({ correct: true });
  throw error;
}, async () => 'Legacy browser instructions');
assert.equal(missingExtensionProbe.ready, false);
assert.equal(missingExtensionProbe.extensionInstalled, false);
assert.match(missingExtensionProbe.detail, /Install and enable/);

const [commandSource, appServerSource, settingsSource, preloadSource] = await Promise.all([
  readFile(new URL('../src/main/command-for-model.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/main/codex-driver.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/SettingsPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/preload.js', import.meta.url), 'utf8'),
]);
for (const source of [commandSource, appServerSource]) {
  assert.match(source, /chromeDevtoolsMcpPackage/);
  assert.match(source, /codexBrowserMcpConfig/);
}
assert.match(settingsSource, /Browser use/);
assert.match(settingsSource, /Install extension/);
assert.match(settingsSource, /Your Chrome \(MCP\)/);
assert.match(settingsSource, /browserAutoConnect/);
assert.match(settingsSource, /Set up in Chrome/);
assert.match(preloadSource, /openChromeDebugSetup/);

console.log('Codex personalization config tests passed.');
