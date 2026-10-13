import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orion-mcps-test-'));
process.env.ORION_MCP_SETTINGS_PATH = path.join(testRoot, 'mcp-settings.json');

const {
  listMcps,
  mcpRuntimeConfig,
  normalizeMcpList,
  readMcpOverrides,
  readMcpRuntimeConfig,
  setMcpEnabled,
} = await import('../src/main/mcps.js');
const { commandForModel } = await import('../src/main/command-for-model.js');
const { splitCodexConfigContextArgs } = await import('../src/main/codex-config.js');
const { codexAppServerConfig } = await import('../src/main/codex-driver.js');
const { app } = await import('electron');

const configured = [
  {
    name: 'github',
    enabled: true,
    auth_status: 'bearer_token',
    transport: {
      type: 'streamable_http',
      url: 'https://mcp.example.test/private/path?token=do-not-expose',
      http_headers: { Authorization: 'do-not-expose' },
    },
  },
  {
    name: 'local.tools',
    enabled: false,
    transport: {
      type: 'stdio',
      command: '/opt/tools/local-mcp',
      args: ['--token', 'do-not-expose'],
      env: { SECRET: 'do-not-expose' },
    },
  },
  {
    name: 'orion',
    enabled: true,
    transport: { type: 'stdio', command: '/tmp/not-the-real-orion' },
  },
];

const run = async (_command, args) => {
  assert.deepEqual(args, ['mcp', 'list', '--json']);
  return { stdout: JSON.stringify(configured), stderr: '' };
};

try {
  const settingsSource = await fs.readFile(
    new URL('../src/app/SettingsPage.tsx', import.meta.url),
    'utf-8'
  );
  assert.match(settingsSource, /label: 'Skills & MCPs'/);
  assert.match(settingsSource, />\s*Skills\s*<\/button>[\s\S]*?>\s*MCPs\s*<\/button>/);

  const normalized = normalizeMcpList(configured, { github: false });
  assert.deepEqual(
    normalized.map(({ id, enabled, configuredEnabled, transport, detail }) => ({
      id,
      enabled,
      configuredEnabled,
      transport,
      detail,
    })),
    [
      {
        id: 'github',
        enabled: false,
        configuredEnabled: true,
        transport: 'http',
        detail: 'https://mcp.example.test',
      },
      {
        id: 'local.tools',
        enabled: false,
        configuredEnabled: false,
        transport: 'stdio',
        detail: 'local-mcp',
      },
    ]
  );
  assert.equal(JSON.stringify(normalized).includes('do-not-expose'), false);

  const initial = await listMcps({ codexPath: '/fake/codex', run });
  assert.equal(initial.ok, true);
  assert.equal(initial.mcps.find((entry) => entry.id === 'github')?.enabled, true);

  assert.deepEqual(
    await setMcpEnabled(
      { id: 'github', enabled: false },
      { codexPath: '/fake/codex', run }
    ),
    { ok: true }
  );
  assert.deepEqual(await readMcpOverrides(), { github: false });

  assert.deepEqual(
    await setMcpEnabled(
      { id: 'local.tools', enabled: true },
      { codexPath: '/fake/codex', run }
    ),
    { ok: true }
  );
  assert.deepEqual(await readMcpOverrides(), { github: false, 'local.tools': true });
  const runtimeConfig = mcpRuntimeConfig(configured, await readMcpOverrides());
  assert.deepEqual(runtimeConfig, {
    mcp_servers: {
      github: {
        enabled: false,
        url: 'https://mcp.example.test/private/path?token=do-not-expose',
        http_headers: { Authorization: 'do-not-expose' },
      },
      'local.tools': {
        enabled: true,
        command: '/opt/tools/local-mcp',
        args: ['--token', 'do-not-expose'],
        env: { SECRET: 'do-not-expose' },
      },
    },
  });

  const model = {
    providerId: 'codex',
    slug: 'gpt-5.6-sol',
  };
  const input = {
    projectPath: testRoot,
    prompt: 'test',
    accessMode: 'full-access',
    codexReasoningEffort: 'medium',
    codexServiceTier: 'default',
    providerOptions: {},
    mcpRuntimeConfig: runtimeConfig,
  };
  const command = commandForModel(model, input);
  assert.equal(
    command.some((argument) => argument.includes('do-not-expose')),
    false,
    'resolved MCP secrets must never be placed on the command line'
  );

  const appServerConfig = codexAppServerConfig(model, input);
  assert.deepEqual(appServerConfig.mcp_servers, runtimeConfig.mcp_servers);
  assert.equal(appServerConfig.mcp_servers['local.tools'].enabled, true);

  const providerOptions = {
    extraArgs:
      '--profile project-profile --config mcp_servers.github.tool_timeout_sec=30 --strict-config --listen off',
  };
  const configContext = splitCodexConfigContextArgs(providerOptions);
  assert.deepEqual(configContext, {
    configArgs: [
      '--profile',
      'project-profile',
      '--config',
      'mcp_servers.github.tool_timeout_sec=30',
      '--strict-config',
    ],
    commandArgs: ['--listen', 'off'],
  });
  assert.deepEqual(
    commandForModel(model, { ...input, codexAppServer: true, providerOptions }),
    [
      'codex',
      ...configContext.configArgs,
      'app-server',
      ...configContext.commandArgs,
    ],
    'global config flags must precede the app-server subcommand'
  );

  let resolvedFromTurnContext = false;
  await readMcpRuntimeConfig({
    codexPath: '/fake/codex',
    cwd: testRoot,
    configArgs: configContext.configArgs,
    run: async (_command, args, runOptions) => {
      assert.deepEqual(args, [...configContext.configArgs, 'mcp', 'list', '--json']);
      assert.equal(runOptions.cwd, testRoot);
      resolvedFromTurnContext = true;
      return { stdout: JSON.stringify(configured), stderr: '' };
    },
  });
  assert.equal(resolvedFromTurnContext, true);

  await assert.rejects(
    readMcpRuntimeConfig({
      codexPath: '/fake/codex',
      run: async () => ({ stdout: '{malformed', stderr: '' }),
    }),
    /Could not apply Durango Code's MCP settings/
  );

  const mainSource = await fs.readFile(new URL('../src/main.js', import.meta.url), 'utf-8');
  const runTurnSource = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('agent:runTurn'"),
    mainSource.indexOf("ipcMain.handle('agent:steerTurn'")
  );
  const resolveConfigIndex = runTurnSource.indexOf('await readMcpRuntimeConfig({');
  const registerBridgeIndex = runTurnSource.indexOf('await registerMcpBridgeForRun({');
  assert.ok(resolveConfigIndex >= 0, 'runTurn must resolve Orion MCP overrides');
  assert.ok(registerBridgeIndex >= 0, 'runTurn must register its per-run bridge');
  assert.ok(
    resolveConfigIndex < registerBridgeIndex,
    'MCP configuration must resolve before the per-run bridge is allocated'
  );
  assert.match(
    runTurnSource.slice(resolveConfigIndex, registerBridgeIndex),
    /cwd: input\.projectPath[\s\S]*splitCodexConfigContextArgs\(input\.providerOptions\)\.configArgs/,
    'runTurn must resolve MCP definitions from the turn workspace and config arguments'
  );

  await Promise.all([
    setMcpEnabled(
      { id: 'github', enabled: true },
      { codexPath: '/fake/codex', run }
    ),
    setMcpEnabled(
      { id: 'local.tools', enabled: false },
      { codexPath: '/fake/codex', run }
    ),
  ]);
  assert.deepEqual(
    await readMcpOverrides(),
    {},
    'concurrent toggles back to the Codex defaults should not race or leave redundant overrides'
  );

  console.log('MCP management regression checks passed.');
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
  app.quit();
}
