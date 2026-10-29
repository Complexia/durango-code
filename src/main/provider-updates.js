import path from 'node:path';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { loginShell, resolveCommandPath, runShellCommand, shellQuote } from './shell-env.js';
import { readFxConnections } from './fx-provider.js';

export const providerUpdaterConfigs = [
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    packageName: '@openai/codex',
    updateCommands: [['update']],
    authCommands: [['login']],
    statusCommand: ['login', 'status'],
  },
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    packageName: '@anthropic-ai/claude-code',
    updateCommands: [['update']],
    authCommands: [['auth', 'login']],
    statusCommand: ['auth', 'status'],
  },
  {
    id: 'cursor',
    label: 'Cursor Agent',
    command: 'cursor-agent',
    updateCommands: [['update']],
    authCommands: [['login']],
    statusCommand: ['status', '--format', 'json'],
  },
  {
    id: 'grok',
    label: 'Grok',
    command: 'grok',
    updateCommands: [['update']],
    checkCommand: ['update', '--check', '--json'],
    // Grok installed via the official script self-updates in place
    // ("installer":"internal" in `grok update --check --json`), but older
    // builds and npm-detected installs route through `npm i -g`, which fails
    // with EEXIST against the script-managed binary. When the self-updater
    // fails or leaves the version unchanged, reinstall from the official
    // script instead of npm.
    fallbackInstallCommand: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    verifyAfterUpdate: true,
    authCommands: [['login', '--oauth']],
    statusCommand: ['models'],
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    command: 'kimi',
    latestVersionUrl: 'https://code.kimi.com/kimi-code/latest',
    updateCommands: [['upgrade']],
    manualInstallCommandPattern: /To update manually, run:\s*([^\r\n]+)/i,
    verifyAfterUpdate: true,
    authCommands: [['login']],
    statusCommand: ['provider', 'list'],
  },
  {
    id: 'fx',
    label: 'fx',
    command: 'fx',
    latestVersionUrl: 'https://releases.fx.sh/latest.txt',
    updateCommands: [['upgrade']],
    probeUpdateCommand: false,
    versionEnv: { FX_AUTO_UPGRADE: '0' },
    verifyAfterUpdate: true,
    // fx connects several model providers (Settings → Providers → fx);
    // status comes from getFxAuthStatus and sign-in from that panel.
  },
  {
    id: 'muse',
    label: 'Muse Code',
    command: 'muse',
    // `muse` is a self-updating launcher script, so routine version reads must
    // explicitly disable its automatic update path. There is no separate
    // update subcommand, so the managed update run forces an immediate check
    // (MUSE_UPDATE_INTERVAL_SECONDS=0) and makes the install synchronous
    // (MUSE_SYNC_UPDATE=1) — otherwise verification would race the detached
    // download. The channel manifest and `muse --version` both carry the
    // R-suffixed build ("0.1.0-R708.1"); the
    // versionPattern pins version extraction to that form on both sides,
    // because comparing the bare semver against the suffixed build would flag
    // a phantom update forever.
    latestVersionUrl: 'https://api.meta.ai/muse-code/channels/muse-stable',
    versionPattern: /\d+\.\d+\.\d+-R[\d.]+/,
    versionEnv: { MUSE_NO_AUTO_UPDATE: '1' },
    updateCommands: [['--version']],
    probeUpdateCommand: false,
    updateEnv: { MUSE_UPDATE_INTERVAL_SECONDS: '0', MUSE_SYNC_UPDATE: '1' },
    verifyAfterUpdate: true,
    authCommands: [['login']],
    // Auth status comes from the credential file (see getProviderAuthStatus)
    // — the CLI has no status subcommand.
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    packageName: 'opencode-ai',
    updateCommands: [['upgrade']],
    authCommands: [['providers', 'login'], ['auth', 'login']],
    statusCommand: ['models'],
  },
];

export const parseVersion = (value) => {
  const match = String(value || '').match(/\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?/);
  return match ? match[0] : null;
};

export const compareVersionStrings = (left, right) => {
  const leftParts = String(left || '').match(/\d+/g)?.map(Number) ?? [];
  const rightParts = String(right || '').match(/\d+/g)?.map(Number) ?? [];
  const length = Math.max(leftParts.length, rightParts.length, 3);

  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }

  return 0;
};

export const getProcessErrorMessage = (error) => {
  const output = `${error?.stdout || ''}\n${error?.stderr || ''}`.trim();
  return output || error?.message || String(error);
};

export const getProviderUpdateError = (error) => {
  const stderr = String(error?.stderr || '').trim();
  if (stderr) return stderr;
  return error?.message || String(error);
};

const PROVIDER_UPDATE_OUTPUT_LIMIT = 8 * 1024 * 1024;
const appendProviderUpdateOutput = (current, chunk) => {
  const combined = `${current}${chunk}`;
  return combined.length > PROVIDER_UPDATE_OUTPUT_LIMIT
    ? combined.slice(-PROVIDER_UPDATE_OUTPUT_LIMIT)
    : combined;
};

export const isProviderUpdateCancelled = (error) =>
  error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.cancelled === true;

export const runStreamingShellCommand = (command, options = {}) =>
  new Promise((resolve, reject) => {
    const { signal, onOutput, env } = options;
    if (signal?.aborted) {
      const error = new Error('Provider update cancelled.');
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      error.cancelled = true;
      reject(error);
      return;
    }

    const child = spawn(loginShell, ['-lc', command], {
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        ...(env || {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // A separate process group lets Abort terminate installer children such
      // as curl/npm as well as the login shell that launched them.
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelled = false;
    let forceKillTimer = null;

    const emitOutput = (stream, buffer) => {
      const chunk = buffer.toString();
      if (stream === 'stderr') stderr = appendProviderUpdateOutput(stderr, chunk);
      else stdout = appendProviderUpdateOutput(stdout, chunk);
      try {
        onOutput?.({ stream, chunk });
      } catch {}
    };

    const killProcessGroup = (signalName) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signalName);
        else process.kill(-child.pid, signalName);
      } catch {
        try {
          child.kill(signalName);
        } catch {}
      }
    };

    const abort = () => {
      if (settled || cancelled) return;
      cancelled = true;
      killProcessGroup('SIGTERM');
      forceKillTimer = setTimeout(() => killProcessGroup('SIGKILL'), 2000);
      forceKillTimer.unref?.();
    };

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result);
    };

    child.stdout?.on('data', (buffer) => emitOutput('stdout', buffer));
    child.stderr?.on('data', (buffer) => emitOutput('stderr', buffer));
    child.once('spawn', () => {
      if (cancelled) killProcessGroup('SIGTERM');
      else if (signal?.aborted) abort();
    });
    child.on('error', (error) => {
      error.stdout = stdout;
      error.stderr = stderr;
      finish(error);
    });
    child.on('close', (code, processSignal) => {
      if (cancelled || signal?.aborted) {
        const error = new Error('Provider update cancelled.');
        error.name = 'AbortError';
        error.code = 'ABORT_ERR';
        error.cancelled = true;
        error.stdout = stdout;
        error.stderr = stderr;
        finish(error);
        return;
      }
      if (code === 0) {
        finish(null, { stdout, stderr });
        return;
      }
      const error = new Error(
        processSignal
          ? `Provider updater terminated by ${processSignal}.`
          : `Provider updater exited with code ${code ?? 'unknown'}.`
      );
      error.code = code;
      error.signal = processSignal;
      error.stdout = stdout;
      error.stderr = stderr;
      finish(error);
    });
    signal?.addEventListener('abort', abort, { once: true });
  });

// A config's versionPattern narrows what counts as the version in CLI and
// remote output. Muse needs it: `muse --version` prints both the bare semver
// and the full channel build ("Muse Code 0.1.0 (0.1.0-R708.1)"), and only the
// R-suffixed build compares correctly against the release channel.
export const extractVersion = (text, versionPattern) =>
  (versionPattern ? String(text || '').match(versionPattern)?.[0] : null) ?? parseVersion(text);

export const readCliVersion = async (command, versionPattern, env) => {
  try {
    const { stdout, stderr } = await runShellCommand(
      `${shellQuote(command)} --version`,
      8000,
      env
    );
    return extractVersion(`${stdout}\n${stderr}`, versionPattern);
  } catch (error) {
    return extractVersion(getProcessErrorMessage(error), versionPattern);
  }
};

export const readNpmLatestVersion = async (packageName) => {
  try {
    const { stdout } = await runShellCommand(`npm view ${shellQuote(packageName)} version`, 20000);
    return parseVersion(stdout);
  } catch {
    return null;
  }
};

export const readRemoteLatestVersion = async (url, versionPattern) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    return extractVersion(await response.text(), versionPattern);
  } catch {
    return null;
  }
};

export const parseJsonFromOutput = (output) => {
  const text = String(output || '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const jsonLine = text
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.trim().startsWith('{'));

  if (!jsonLine) return null;

  try {
    return JSON.parse(jsonLine);
  } catch {
    return null;
  }
};

// muse stores credentials at $XDG_CONFIG_HOME/muse/auth.json (or
// ~/.config/muse; MUSE_AUTH_PATH overrides), written by `muse login` (Meta
// account OAuth) or `muse auth set` (API key). The CLI has no status
// subcommand, so authentication is read straight off that file. META_API_KEY
// in the environment always takes priority over the stored login.
export const museAuthFilePath = () =>
  process.env.MUSE_AUTH_PATH ||
  path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'muse',
    'auth.json'
  );

export const getMuseAuthStatus = async () => {
  if (process.env.META_API_KEY) {
    return {
      authenticated: true,
      status: 'authenticated',
      label: 'Authenticated',
      detail: 'META_API_KEY',
    };
  }
  try {
    const parsed = JSON.parse(await readFile(museAuthFilePath(), 'utf8'));
    const meta = parsed?.providers?.meta;
    const authenticated = Boolean(meta?.access_token || meta?.api_key);
    return {
      authenticated,
      status: authenticated ? 'authenticated' : 'unauthenticated',
      label: authenticated ? 'Authenticated' : 'Not authenticated',
      detail: typeof meta?.user_email === 'string' ? meta.user_email : undefined,
    };
  } catch {
    return {
      authenticated: false,
      status: 'unauthenticated',
      label: 'Not authenticated',
      detail: 'Run muse login.',
    };
  }
};

// fx is ready when any route can serve a model: the Durango account (usage
// credits), a ChatGPT or Grok subscription signed in through fx, or Vercel
// AI Gateway credentials.
export const getFxAuthStatus = async () => {
  const connections = await readFxConnections();
  const names = [
    connections.durango && 'Durango credits',
    connections.codex && 'ChatGPT',
    connections.grok && 'Grok',
    connections.gateway && 'Vercel AI Gateway',
  ].filter(Boolean);
  return {
    authenticated: names.length > 0,
    status: names.length > 0 ? 'authenticated' : 'unauthenticated',
    label: names.length > 0 ? 'Ready' : 'No model provider',
    detail:
      names.length > 0
        ? `Ready — ${names.join(' · ')}`
        : 'Sign in to Durango or connect a provider in fx options.',
  };
};

export const getProviderAuthStatus = async (config) => {
  if (!(await resolveCommandPath(config.command))) {
    return {
      authenticated: false,
      status: 'missing',
      label: 'Not installed',
      detail: `${config.command} is not installed.`,
    };
  }

  if (config.id === 'muse') {
    return getMuseAuthStatus();
  }

  if (config.id === 'fx') {
    return getFxAuthStatus();
  }

  if (!config.statusCommand) {
    return {
      authenticated: null,
      status: 'unknown',
      label: 'Unknown',
      detail: 'No status command is available.',
    };
  }

  try {
    const command = [config.command, ...config.statusCommand].map(shellQuote).join(' ');
    const { stdout, stderr } = await runShellCommand(command, 15000);
    const output = `${stdout}\n${stderr}`.trim();
    const parsed = parseJsonFromOutput(output);
    const lowerOutput = output.toLowerCase();

    if (config.id === 'codex') {
      const authenticated = /logged in/i.test(output) && !/not logged in/i.test(output);
      return {
        authenticated,
        status: authenticated ? 'authenticated' : 'unauthenticated',
        label: authenticated ? 'Authenticated' : 'Not authenticated',
        detail: output,
      };
    }

    if (config.id === 'claude') {
      const authenticated = parsed
        ? parsed.loggedIn === true
        : /logged in|authenticated/i.test(output) && !/not logged/i.test(output);
      return {
        authenticated,
        status: authenticated ? 'authenticated' : 'unauthenticated',
        label: authenticated ? 'Authenticated' : 'Not authenticated',
        detail: parsed?.email || parsed?.authMethod || output,
      };
    }

    if (config.id === 'cursor') {
      const authenticated = parsed
        ? parsed.isAuthenticated === true || parsed.status === 'authenticated'
        : /authenticated|logged in/i.test(output) && !/not authenticated|not logged/i.test(output);
      return {
        authenticated,
        status: authenticated ? 'authenticated' : 'unauthenticated',
        label: authenticated ? 'Authenticated' : 'Not authenticated',
        detail: parsed?.message || parsed?.status || output,
      };
    }

    if (config.id === 'grok') {
      const authenticated =
        /logged in|available models|default model/i.test(output) &&
        !/not logged|unauthenticated|login required|sign in required/i.test(output);
      return {
        authenticated,
        status: authenticated ? 'authenticated' : lowerOutput ? 'unauthenticated' : 'unknown',
        label: authenticated ? 'Authenticated' : 'Not authenticated',
        detail: output.split(/\r?\n/).find((line) => line.trim()) || output,
      };
    }

    if (config.id === 'kimi') {
      // `kimi provider list` prints the managed provider row (source=oauth)
      // and the default model when the CLI is configured and logged in.
      const authenticated =
        /source=oauth|default model/i.test(output) &&
        !/not logged|login required|unauthenticated|authentication required/i.test(output);
      return {
        authenticated,
        status: authenticated ? 'authenticated' : lowerOutput ? 'unauthenticated' : 'unknown',
        label: authenticated ? 'Authenticated' : 'Not authenticated',
        detail: output.split(/\r?\n/).find((line) => line.trim()) || output,
      };
    }

    if (config.id === 'opencode') {
      const models = output
        .replace(/\u001b\[[0-9;]*m/g, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i.test(line));
      const ready = models.length > 0;
      return {
        authenticated: ready,
        status: ready ? 'authenticated' : lowerOutput ? 'unauthenticated' : 'unknown',
        label: ready ? 'Ready' : 'No models available',
        detail: ready
          ? `Ready — ${models.length} model${models.length === 1 ? '' : 's'} available`
          : output,
      };
    }

    const authenticated =
      /authenticated|logged in|signed in/i.test(output) &&
      !/not authenticated|not logged|signed out/i.test(output);
    return {
      authenticated,
      status: authenticated ? 'authenticated' : 'unknown',
      label: authenticated ? 'Authenticated' : 'Unknown',
      detail: output,
    };
  } catch (error) {
    const message = getProcessErrorMessage(error);
    const unauthenticated = /unauth|not logged|login required|sign in required/i.test(message);
    return {
      authenticated: unauthenticated ? false : null,
      status: unauthenticated ? 'unauthenticated' : 'error',
      label: unauthenticated ? 'Not authenticated' : 'Status unavailable',
      detail: message,
    };
  }
};

export const normalizeEnabledProviderIds = (input) => {
  if (!input || !Array.isArray(input.enabledProviderIds)) return null;
  return new Set(input.enabledProviderIds.map(String));
};

export const checkProviderUpdate = async (config, enabledProviderIds = null) => {
  const commandPath = await resolveCommandPath(config.command);
  const enabled = !enabledProviderIds || enabledProviderIds.has(config.id);
  const auth = await getProviderAuthStatus(config);
  const base = {
    id: config.id,
    label: config.label,
    command: config.command,
    enabled,
    installed: Boolean(commandPath),
    path: commandPath,
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    status: commandPath ? 'unknown' : 'missing',
    auth,
  };

  if (!commandPath) return base;

  const currentVersion = await readCliVersion(
    config.command,
    config.versionPattern,
    config.versionEnv
  );
  const withCurrentVersion = { ...base, currentVersion };

  if (config.checkCommand) {
    try {
      const command = [config.command, ...config.checkCommand].map(shellQuote).join(' ');
      const { stdout, stderr } = await runShellCommand(command, 30000);
      const payload = `${stdout}\n${stderr}`.trim();
      const jsonLine = payload
        .split(/\r?\n/)
        .reverse()
        .find((line) => line.trim().startsWith('{'));
      const parsed = jsonLine ? JSON.parse(jsonLine) : JSON.parse(payload);
      const latestVersion = parseVersion(parsed.latestVersion);
      const reportedCurrentVersion = parseVersion(parsed.currentVersion) ?? currentVersion;
      const updateAvailable =
        enabled && (parsed.updateAvailable === true ||
        (reportedCurrentVersion && latestVersion
          ? compareVersionStrings(reportedCurrentVersion, latestVersion) < 0
          : false));

      return {
        ...withCurrentVersion,
        currentVersion: reportedCurrentVersion,
        latestVersion,
        updateAvailable,
        status: updateAvailable ? 'available' : 'current',
      };
    } catch (error) {
      return {
        ...withCurrentVersion,
        status: 'error',
        error: getProcessErrorMessage(error),
      };
    }
  }

  if (config.packageName) {
    const latestVersion = await readNpmLatestVersion(config.packageName);
    const updateAvailable =
      enabled && currentVersion && latestVersion
        ? compareVersionStrings(currentVersion, latestVersion) < 0
        : false;

    return {
      ...withCurrentVersion,
      latestVersion,
      updateAvailable,
      status: latestVersion ? (updateAvailable ? 'available' : 'current') : 'unknown',
    };
  }

  if (config.latestVersionUrl) {
    const latestVersion = await readRemoteLatestVersion(config.latestVersionUrl, config.versionPattern);
    const updateAvailable =
      enabled && currentVersion && latestVersion
        ? compareVersionStrings(currentVersion, latestVersion) < 0
        : false;

    return {
      ...withCurrentVersion,
      latestVersion,
      updateAvailable,
      status: latestVersion ? (updateAvailable ? 'available' : 'current') : 'unknown',
    };
  }

  return withCurrentVersion;
};

export const runProviderUpdateCheck = async (input = {}) => {
  const enabledProviderIds = normalizeEnabledProviderIds(input);
  const providers = await Promise.all(
    providerUpdaterConfigs.map((config) => checkProviderUpdate(config, enabledProviderIds))
  );
  return {
    checkedAt: new Date().toISOString(),
    updatesAvailable: providers.filter((provider) => provider.updateAvailable).length,
    providers,
  };
};

export const providerUpdateCheckPromises = new Map();
export const checkProviderUpdates = (input = {}) => {
  const enabledProviderIds = normalizeEnabledProviderIds(input);
  const key = enabledProviderIds ? [...enabledProviderIds].sort().join(',') : '*';
  const existing = providerUpdateCheckPromises.get(key);
  if (existing) return existing;

  const check = runProviderUpdateCheck(input);
  const sharedCheck = check.finally(() => {
    if (providerUpdateCheckPromises.get(key) === sharedCheck) {
      providerUpdateCheckPromises.delete(key);
    }
  });
  providerUpdateCheckPromises.set(key, sharedCheck);
  return sharedCheck;
};

export const getProviderStatuses = async () => checkProviderUpdates();

export const resolveProviderUpdateCommand = async (config) => {
  if (config.probeUpdateCommand === false) return config.updateCommands[0] ?? null;

  for (const args of config.updateCommands) {
    try {
      await runShellCommand([config.command, ...args, '--help'].map(shellQuote).join(' '), 8000);
      return args;
    } catch (error) {
      const output = getProcessErrorMessage(error);
      if (!/unknown command|invalid command|unrecognized subcommand|not found/i.test(output)) {
        return args;
      }
    }
  }

  return config.updateCommands[0] ?? null;
};

export const updateProviderTool = async (config, expectedLatestVersion = null, options = {}) => {
  const { signal, onOutput, onPhase } = options;
  const commandPath = await resolveCommandPath(config.command);
  if (!commandPath) {
    return {
      id: config.id,
      label: config.label,
      command: config.command,
      ok: true,
      skipped: true,
      message: `${config.command} is not installed.`,
    };
  }

  const args = await resolveProviderUpdateCommand(config);
  if (!args) {
    return {
      id: config.id,
      label: config.label,
      command: config.command,
      ok: false,
      error: `No updater command is configured for ${config.command}.`,
    };
  }

  const updateCommand = [config.command, ...args].map(shellQuote).join(' ');
  const runUpdateCommand = (command) =>
    runStreamingShellCommand(command, { signal, onOutput, env: config.updateEnv });

  try {
    onPhase?.('updating');
    const { stdout, stderr } = await runUpdateCommand(updateCommand);
    const outputParts = [`${stdout}\n${stderr}`.trim()].filter(Boolean);
    const manualInstallCommand = config.manualInstallCommandPattern
      ? outputParts[0]?.match(config.manualInstallCommandPattern)?.[1]?.trim()
      : null;

    // Some self-updaters only print a source-specific install command when
    // stdin is not a TTY. Run that command explicitly so the background
    // update path performs the install instead of reporting a no-op success.
    if (manualInstallCommand) {
      onPhase?.('installing');
      const manualResult = await runUpdateCommand(manualInstallCommand);
      const manualOutput = `${manualResult.stdout}\n${manualResult.stderr}`.trim();
      if (manualOutput) outputParts.push(manualOutput);
    }

    if (config.verifyAfterUpdate && expectedLatestVersion) {
      onPhase?.('verifying');
      let installedVersion = await readCliVersion(
        config.command,
        config.versionPattern,
        config.versionEnv
      );
      const isStale = (version) =>
        !version || compareVersionStrings(version, expectedLatestVersion) < 0;

      // A self-updater can exit 0 without installing anything (e.g. grok
      // routing through a broken npm path). Reinstall from the configured
      // source before declaring failure.
      if (isStale(installedVersion) && config.fallbackInstallCommand) {
        onPhase?.('installing');
        try {
          const fallbackResult = await runUpdateCommand(config.fallbackInstallCommand);
          const fallbackOutput = `${fallbackResult.stdout}\n${fallbackResult.stderr}`.trim();
          if (fallbackOutput) outputParts.push(fallbackOutput);
        } catch (fallbackError) {
          // Cancellation propagates to the outer handler; any other failure
          // must not fall through to the catch block, which would run the
          // same fallback command a second time.
          if (isProviderUpdateCancelled(fallbackError)) throw fallbackError;
          const fallbackOutput =
            `${fallbackError?.stdout || ''}\n${fallbackError?.stderr || ''}`.trim();
          if (fallbackOutput) outputParts.push(fallbackOutput);
          return {
            id: config.id,
            label: config.label,
            command: config.command,
            ok: false,
            error: getProviderUpdateError(fallbackError),
            output: outputParts.join('\n\n'),
          };
        }
        onPhase?.('verifying');
        installedVersion = await readCliVersion(
          config.command,
          config.versionPattern,
          config.versionEnv
        );
      }

      if (isStale(installedVersion)) {
        return {
          id: config.id,
          label: config.label,
          command: config.command,
          ok: false,
          error: installedVersion
            ? `${config.label} is still on ${installedVersion}; expected ${expectedLatestVersion}.`
            : `Could not verify the installed ${config.label} version after updating.`,
          output: outputParts.join('\n\n'),
        };
      }
    }

    return {
      id: config.id,
      label: config.label,
      command: config.command,
      ok: true,
      output: outputParts.join('\n\n'),
    };
  } catch (error) {
    if (isProviderUpdateCancelled(error)) {
      return {
        id: config.id,
        label: config.label,
        command: config.command,
        ok: false,
        cancelled: true,
        error: `${config.label} update cancelled.`,
        output: `${error?.stdout || ''}\n${error?.stderr || ''}`.trim(),
      };
    }

    const fallbackCommand =
      config.fallbackInstallCommand ??
      (config.packageName ? `npm install -g ${shellQuote(`${config.packageName}@latest`)}` : null);
    if (fallbackCommand) {
      try {
        onPhase?.('installing');
        const { stdout, stderr } = await runUpdateCommand(fallbackCommand);
        const fallbackOutput = `${stdout}\n${stderr}`.trim();

        if (config.verifyAfterUpdate && expectedLatestVersion) {
          onPhase?.('verifying');
          const installedVersion = await readCliVersion(
            config.command,
            config.versionPattern,
            config.versionEnv
          );
          if (
            !installedVersion ||
            compareVersionStrings(installedVersion, expectedLatestVersion) < 0
          ) {
            return {
              id: config.id,
              label: config.label,
              command: config.command,
              ok: false,
              error: installedVersion
                ? `${config.label} is still on ${installedVersion}; expected ${expectedLatestVersion}.`
                : `Could not verify the installed ${config.label} version after updating.`,
              output: fallbackOutput,
            };
          }
        }

        return {
          id: config.id,
          label: config.label,
          command: config.command,
          ok: true,
          output: fallbackOutput,
        };
      } catch (fallbackError) {
        if (isProviderUpdateCancelled(fallbackError)) {
          return {
            id: config.id,
            label: config.label,
            command: config.command,
            ok: false,
            cancelled: true,
            error: `${config.label} update cancelled.`,
            output: `${fallbackError?.stdout || ''}\n${fallbackError?.stderr || ''}`.trim(),
          };
        }
        return {
          id: config.id,
          label: config.label,
          command: config.command,
          ok: false,
          error: getProviderUpdateError(fallbackError),
          output: `${fallbackError?.stdout || ''}\n${fallbackError?.stderr || ''}`.trim(),
        };
      }
    }

    return {
      id: config.id,
      label: config.label,
      command: config.command,
      ok: false,
      error: getProviderUpdateError(error),
      output: `${error?.stdout || ''}\n${error?.stderr || ''}`.trim(),
    };
  }
};

export const authenticateProviderTool = async (providerId) => {
  const config = providerUpdaterConfigs.find((provider) => provider.id === providerId);
  if (!config) {
    return {
      result: { ok: false, error: `Unknown provider: ${providerId}` },
      completion: null,
    };
  }

  const commandPath = await resolveCommandPath(config.command);
  if (!commandPath) {
    return {
      result: { ok: false, error: `${config.command} is not installed.` },
      completion: null,
    };
  }

  for (const args of config.authCommands ?? []) {
    try {
      const command = [config.command, ...args].map(shellQuote).join(' ');
      const child = spawn(loginShell, ['-lc', command], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
      });
      const completion = new Promise((resolve) => {
        child.once('error', (error) => {
          resolve({ ok: false, error: getProcessErrorMessage(error) });
        });
        child.once('exit', (code, signal) => {
          resolve({
            ok: code === 0,
            code,
            signal,
            ...(code === 0 ? {} : { error: `Authentication exited with code ${code ?? signal}.` }),
          });
        });
      });
      child.unref();
      return { result: { ok: true }, completion };
    } catch (error) {
      return {
        result: { ok: false, error: getProcessErrorMessage(error) },
        completion: null,
      };
    }
  }

  return {
    result: {
      ok: false,
      error: `No authentication command is configured for ${config.command}.`,
    },
    completion: null,
  };
};

export const PROVIDER_AUTH_POLL_MS = 5000;
export const PROVIDER_AUTH_POLL_ATTEMPTS = 24;
export const providerAuthenticationGenerations = new Map();

export const waitForProviderAuthentication = async (providerId, completion) => {
  const config = providerUpdaterConfigs.find((provider) => provider.id === providerId);
  if (!config || !completion) return false;

  // The provider may already be authenticated while the user is switching
  // accounts. Waiting for this specific login process prevents the old
  // session from being mistaken for completion of the new authentication.
  const processResult = await completion;
  if (!processResult.ok) return false;

  // Providers without a machine-readable status command still get a refresh
  // once their successful login process exits.
  if (!config.statusCommand) return true;

  // Most CLIs publish credentials before exiting. Retry status briefly for
  // providers whose credential store settles just after the process does.
  for (let attempt = 0; attempt < PROVIDER_AUTH_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, PROVIDER_AUTH_POLL_MS));
    }
    const auth = await getProviderAuthStatus(config);
    if (auth.authenticated === true) return true;
  }
  return false;
};
