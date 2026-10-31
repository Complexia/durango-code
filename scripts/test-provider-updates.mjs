import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  checkProviderUpdate,
  isNativeClaudeInstall,
  providerUpdaterConfigs,
  readClaudeUpdateChannel,
  readCliVersion,
  updateProviderTool,
} from '../src/main/provider-updates.js';

const kimiConfig = providerUpdaterConfigs.find((config) => config.id === 'kimi');
assert.ok(kimiConfig, 'Kimi updater configuration should exist');
assert.equal(
  'updateTimeoutMs' in kimiConfig,
  false,
  'provider downloads should remain user-controlled instead of timing out'
);

const museConfig = providerUpdaterConfigs.find((config) => config.id === 'muse');
assert.ok(museConfig, 'Muse updater configuration should exist');
assert.deepEqual(
  museConfig.versionEnv,
  { MUSE_NO_AUTO_UPDATE: '1' },
  'routine Muse version reads should disable the launcher update path'
);
assert.equal(
  museConfig.probeUpdateCommand,
  false,
  'the managed Muse update should not invoke the launcher once before progress tracking starts'
);

const claudeConfig = providerUpdaterConfigs.find((config) => config.id === 'claude');
assert.ok(claudeConfig?.readLatestVersion, 'Claude Code should resolve its latest version from its install source');
assert.equal(
  claudeConfig.verifyAfterUpdate,
  true,
  'a Claude Code update that leaves the version unchanged should not report success'
);

const claudeFixtureDir = await mkdtemp(path.join(os.tmpdir(), 'orion-claude-install-'));
const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
try {
  const versionsDir = path.join(claudeFixtureDir, 'share', 'claude', 'versions');
  const binDir = path.join(claudeFixtureDir, 'bin');
  await mkdir(versionsDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(versionsDir, '2.1.314'), '#!/bin/sh\n', 'utf8');
  await symlink(path.join(versionsDir, '2.1.314'), path.join(binDir, 'claude'));
  await writeFile(path.join(claudeFixtureDir, 'npm-claude'), '#!/bin/sh\n', 'utf8');
  assert.equal(
    await isNativeClaudeInstall(path.join(binDir, 'claude')),
    true,
    'a claude command linked into claude/versions is a native install'
  );
  assert.equal(
    await isNativeClaudeInstall(path.join(claudeFixtureDir, 'npm-claude')),
    false,
    'other claude commands are package-manager installs'
  );

  process.env.CLAUDE_CONFIG_DIR = path.join(claudeFixtureDir, 'config');
  assert.equal(await readClaudeUpdateChannel(), 'latest', 'the channel defaults to latest');
  await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  await writeFile(
    path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'),
    JSON.stringify({ autoUpdatesChannel: 'stable' }),
    'utf8'
  );
  assert.equal(await readClaudeUpdateChannel(), 'stable', 'autoUpdatesChannel selects the stable channel');
} finally {
  if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  await rm(claudeFixtureDir, { recursive: true });
}

const streamAdapterSource = (await readFile(
  new URL('../src/main/stream-adapters.js', import.meta.url),
  'utf8'
)).replace("import { shell } from 'electron';", 'const shell = { openExternal: async () => {} };');
const { isTerminalJsonEvent } = await import(
  `data:text/javascript;base64,${Buffer.from(streamAdapterSource).toString('base64')}`
);
assert.equal(
  isTerminalJsonEvent('muse', { payload_type: 'run.terminal.completed' }),
  true,
  'completed Muse runs should use the terminal-event completion path'
);
assert.equal(
  isTerminalJsonEvent('muse', { payload_type: 'run.terminal.failed' }),
  false,
  'failed Muse runs must remain on the non-zero process-exit path'
);
assert.equal(
  isTerminalJsonEvent('grok', { type: 'end' }),
  true,
  'the existing Grok terminal event should remain supported'
);

const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const appUpdaterSource = await readFile(new URL('../src/main/app-updater.js', import.meta.url), 'utf8');
const providerUpdateCadence = appSource.match(
  /const PROVIDER_UPDATE_CHECK_INTERVAL_MS = ([^;]+);/
)?.[1];
const appUpdateCadence = appUpdaterSource.match(
  /appUpdateCheckTimer = setInterval\(runScheduledAppUpdateCheck, ([^)]+)\);/
)?.[1];
assert.equal(
  providerUpdateCadence,
  appUpdateCadence,
  'provider update checks should use the same two-hour cadence as app update checks'
);
assert.match(
  appSource,
  /const interval = window\.setInterval\(\(\) => \{\s*void refreshProviderUpdates\(\);\s*\}, PROVIDER_UPDATE_CHECK_INTERVAL_MS\);[\s\S]*?return \(\) => \{\s*window\.clearInterval\(interval\);\s*\};/,
  'provider update checks should repeat during a long-running renderer and clean up their timer'
);
const windowAllClosedHandler = mainSource.match(
  /app\.on\('window-all-closed',[\s\S]*?\n}\);/
)?.[0];
assert.ok(windowAllClosedHandler, 'the last-window lifecycle handler should remain present');
assert.doesNotMatch(
  windowAllClosedHandler,
  /cancelActiveProviderUpdate\(/,
  'closing the last macOS window should not cancel a provider update'
);
assert.match(
  mainSource,
  /lastProgress: \{[\s\S]*?phase: 'checking',[\s\S]*?output: '',[\s\S]*?current: 0,[\s\S]*?total: 0,[\s\S]*?percent: null,/,
  'a provider operation should have a complete progress payload before it can be cancelled'
);
assert.match(
  mainSource,
  /now - lastOutputPublishAt < PROVIDER_UPDATE_PROGRESS_INTERVAL_MS/,
  'streamed provider output should be rate-limited before publishing progress'
);

const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'orion-provider-update-'));
const fixtureCommand = path.join(fixtureDir, 'slow-provider');

try {
  await writeFile(
    fixtureCommand,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  if [ "\${ORION_TEST_NO_AUTO_UPDATE:-}" != "1" ]; then
    printf 'unmanaged update attempted\n' >&2
    exit 42
  fi
  printf 'Fixture Provider 1.2.3\n'
  exit 0
fi
if [ "$2" = "--help" ]; then
  exit 0
fi
if [ "$1" = "quick" ]; then
  printf 'Downloading provider fixture 100%%\n'
  exit 0
fi
printf 'Downloading provider fixture\n'
sleep 2
`,
    'utf8'
  );
  await chmod(fixtureCommand, 0o755);

  const versionState = await checkProviderUpdate({
    id: 'fixture-version',
    label: 'Fixture Version Provider',
    command: fixtureCommand,
    versionEnv: { ORION_TEST_NO_AUTO_UPDATE: '1' },
  });
  assert.equal(
    versionState.currentVersion,
    '1.2.3',
    'provider checks should pass the non-updating environment to version reads'
  );
  assert.equal(
    await readCliVersion(fixtureCommand),
    null,
    'the fixture should reject an unguarded version read'
  );

  const controller = new AbortController();
  const chunks = [];
  const result = await updateProviderTool(
    {
      id: 'fixture',
      label: 'Fixture Provider',
      command: fixtureCommand,
      updateCommands: [['upgrade']],
    },
    null,
    {
      signal: controller.signal,
      onOutput: ({ chunk }) => {
        chunks.push(chunk);
        if (chunk.includes('Downloading provider fixture')) controller.abort();
      },
    }
  );

  assert.equal(result.ok, false, 'an aborted update should not report success');
  assert.equal(result.cancelled, true, 'the updater should distinguish user cancellation from failure');
  assert.equal(result.error, 'Fixture Provider update cancelled.');
  assert.match(
    result.output,
    /Downloading provider fixture/,
    'captured updater progress should remain available for diagnostics'
  );
  assert.match(chunks.join(''), /Downloading provider fixture/);

  const completedChunks = [];
  const completed = await updateProviderTool(
    {
      id: 'fixture',
      label: 'Fixture Provider',
      command: fixtureCommand,
      updateCommands: [['quick']],
    },
    null,
    {
      onOutput: ({ chunk }) => completedChunks.push(chunk),
    }
  );
  assert.equal(completed.ok, true, 'a streaming update should complete without a deadline');
  assert.match(completedChunks.join(''), /100%/, 'live progress should be emitted before completion');
} finally {
  await rm(fixtureDir, { recursive: true });
}

console.log('Provider update regression tests passed.');
