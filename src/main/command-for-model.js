import { app } from 'electron';
import { chromeDevtoolsMcpPackage, claudeEffortForCli, claudeModelArgForContextWindow, codexReasoningEffortForModel, defaultClaudeContextWindow, defaultClaudeReasoningEffort, defaultCodexServiceTier, defaultMuseReasoningEffort, parseExtraArgs } from './models.js';
import { codexBrowserEnvironmentNote, codexBrowserMcpConfig, codexConfigArgs, codexModelConfig, codexPersonalizationConfig, splitCodexConfigContextArgs } from './codex-config.js';
import { grokPermissionModeForAccessMode } from './grok-access-mode.js';
import { CLAUDE_CHROME_BROWSER_TIPS } from './claude-chrome.js';

export const commandForModel = (model, input) => {
  const prompt =
    model.providerId === 'claude' && input.claudeReasoningEffort === 'ultrathink'
      ? `ultrathink\n\n${input.prompt}`
      : input.prompt;
  const cwd = input.projectPath;
  const modelArg = model.slug;
  const accessMode = input.accessMode || 'full-access';
  const options = input.providerOptions && typeof input.providerOptions === 'object' ? input.providerOptions : {};
  const extraArgs = parseExtraArgs(options.extraArgs);
  const resumeSessionId =
    typeof input.resumeSessionId === 'string' && input.resumeSessionId ? input.resumeSessionId : null;

  if (model.providerId === 'codex') {
    // Codex turns speak JSON-RPC over `codex app-server` so Orion can deliver
    // native turn/steer input while a turn is still running. Model, sandbox,
    // and config overrides travel in the dialog, not argv.
    if (input.codexAppServer || input.codexGoal || input.codexReview) {
      const { configArgs, commandArgs } = splitCodexConfigContextArgs(options);
      return ['codex', ...configArgs, 'app-server', ...commandArgs];
    }
    const reasoningEffort = codexReasoningEffortForModel(model, input.codexReasoningEffort);
    const serviceTier = input.codexServiceTier || defaultCodexServiceTier;
    const configArgs = [
      '--config',
      `model_reasoning_effort="${reasoningEffort}"`,
      // GPT-5.6 models default to no reasoning summaries on the CLI — request
      // them so the Reasoning activity streams like the desktop app.
      '--config',
      'model_reasoning_summary="detailed"',
      '--config',
      `service_tier="${serviceTier}"`,
      ...codexConfigArgs(codexPersonalizationConfig(options)),
      ...codexConfigArgs(codexModelConfig(model, options)),
    ];
    if (options.networkAccess) configArgs.push('--config', 'sandbox_workspace_write.network_access=true');
    if (options.webSearch) configArgs.push('--config', 'tools.web_search=true');
    configArgs.push(
      ...codexConfigArgs(codexBrowserMcpConfig(options, accessMode, chromeDevtoolsMcpPackage))
    );
    // Orion's spawn_subagent bridge (@-mention delegation / orchestration).
    // A spawned subagent can run for a long time, so lift codex's 60s default
    // MCP tool timeout well clear of real runs.
    if (input.orionMcp) {
      configArgs.push(
        '--config',
        `mcp_servers.orion.command=${JSON.stringify(input.orionMcp.command)}`,
        '--config',
        `mcp_servers.orion.args=${JSON.stringify(input.orionMcp.args)}`,
        '--config',
        'mcp_servers.orion.env={ELECTRON_RUN_AS_NODE = "1"}',
        '--config',
        'mcp_servers.orion.startup_timeout_sec=30',
        '--config',
        'mcp_servers.orion.tool_timeout_sec=7200',
        // codex 0.144 gates MCP tools behind an approval prompt that headless
        // exec runs auto-cancel ("user cancelled MCP tool call") — pre-approve
        // Orion's own tool. The spawned subthread runs with the driver
        // thread's access mode, so this grants nothing extra.
        '--config',
        'mcp_servers.orion.default_tools_approval_mode="approve"',
      );
    }
    // The selected and runtime-verified browser backend gets an explicit steer
    // so Codex does not try the unavailable alternative first and stop there.
    const browserNote = codexBrowserEnvironmentNote(options, accessMode);
    const codexPrompt = `${browserNote}${prompt}`;

    if (resumeSessionId) {
      // `exec resume` has no --cd/--sandbox/--color flags: cwd comes from the
      // spawn cwd and the sandbox from a config override.
      const accessArgs =
        accessMode === 'full-access'
          ? ['--dangerously-bypass-approvals-and-sandbox']
          : ['--config', `sandbox_mode="${accessMode === 'read-only' ? 'read-only' : 'workspace-write'}"`];
      return [
        'codex',
        'exec',
        'resume',
        resumeSessionId,
        '--json',
        '--skip-git-repo-check',
        '--model',
        modelArg,
        ...configArgs,
        ...accessArgs,
        ...extraArgs,
        codexPrompt,
      ];
    }

    const accessArgs =
      accessMode === 'full-access'
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['--sandbox', accessMode === 'read-only' ? 'read-only' : 'workspace-write'];
    return [
      'codex',
      'exec',
      '--json',
      '--cd',
      cwd,
      '--skip-git-repo-check',
      '--color',
      'never',
      '--model',
      modelArg,
      ...configArgs,
      ...accessArgs,
      ...extraArgs,
      codexPrompt,
    ];
  }

  if (model.providerId === 'claude') {
    const reasoningEffort = input.claudeReasoningEffort || defaultClaudeReasoningEffort;
    const contextWindow = input.claudeContextWindow || defaultClaudeContextWindow;
    const claudeModelArg = claudeModelArgForContextWindow(modelArg, contextWindow);
    const settingsArgs = reasoningEffort === 'ultracode' ? ['--settings', JSON.stringify({ ultracode: true })] : [];
    const accessArgs =
      accessMode === 'full-access'
        ? ['--dangerously-skip-permissions']
        : ['--permission-mode', accessMode === 'read-only' ? 'plan' : 'acceptEdits'];
    // Headless runs can't show permission prompts, so tools outside the
    // permission mode's defaults must be pre-approved here. Claude in Chrome
    // tools are MCP tools, so enabling --chrome also pre-approves its server.
    const chromeEnabled = options.chrome === true && accessMode !== 'read-only';
    // One-shot runs have no SDK hooks, so they get the usage tips but not the
    // cross-thread Chrome lease.
    const chromeArgs = chromeEnabled
      ? ['--chrome', '--append-system-prompt', CLAUDE_CHROME_BROWSER_TIPS]
      : [];
    const configuredAllowedTools = String(options.allowedTools || '')
      .split(',')
      .map((tool) => tool.trim())
      .filter(
        (tool) =>
          Boolean(tool) &&
          (accessMode !== 'read-only' || !tool.startsWith('mcp__claude-in-chrome'))
      );
    const allowedTools = [...configuredAllowedTools, chromeEnabled ? 'mcp__claude-in-chrome' : '']
      .filter(Boolean)
      .join(',');
    // MUST be the single-token --flag=value form: --allowedTools is variadic
    // (space-separated), so `--allowedTools a,b <prompt>` swallows the prompt.
    const allowedToolsArgs =
      accessMode !== 'full-access' && allowedTools ? [`--allowedTools=${allowedTools}`] : [];
    const resumeArgs = resumeSessionId
      ? ['--resume', resumeSessionId, ...(input.forkSession ? ['--fork-session'] : [])]
      : [];
    return [
      'claude',
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--model',
      claudeModelArg,
      '--effort',
      claudeEffortForCli(reasoningEffort),
      ...settingsArgs,
      ...accessArgs,
      ...chromeArgs,
      ...allowedToolsArgs,
      ...resumeArgs,
      ...extraArgs,
      prompt,
    ];
  }

  if (model.providerId === 'cursor') {
    const accessArgs = accessMode === 'read-only' ? ['--mode', 'plan'] : ['--force'];
    const resumeArgs = resumeSessionId ? ['--resume', resumeSessionId] : [];
    const pluginArgs = input.orionMcp?.pluginDir
      ? ['--plugin-dir', input.orionMcp.pluginDir]
      : [];
    return [
      'cursor-agent',
      '--print',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--trust',
      '--workspace',
      cwd,
      '--model',
      modelArg,
      ...pluginArgs,
      ...accessArgs,
      ...resumeArgs,
      ...extraArgs,
      prompt,
    ];
  }

  if (model.providerId === 'grok') {
    // Real turns speak ACP (JSON-RPC over `grok agent stdio`): the prompt,
    // cwd, session resume, and permission answers travel over the dialog, not
    // flags. The headless streaming-json format only ever emits thought/text/
    // end, so ACP is the only way to stream tool calls, plans, and diffs.
    if (input.acp) {
      const effortArgs = input.grokReasoningEffort
        ? ['--reasoning-effort', input.grokReasoningEffort]
        : [];
      const pluginArgs = input.orionMcp?.pluginDir
        ? ['--plugin-dir', input.orionMcp.pluginDir]
        : [];
      const permissionMode = grokPermissionModeForAccessMode(accessMode);
      return [
        'grok',
        ...(permissionMode
          ? ['--permission-mode', permissionMode]
          : ['--always-approve']),
        'agent',
        '-m',
        modelArg,
        ...effortArgs,
        ...pluginArgs,
        ...extraArgs,
        'stdio',
      ];
    }

    // One-shot text-only path (thread title generation). --reasoning-effort is
    // a global flag, so it applies here as well as on the ACP path above.
    const effortArgs = input.grokReasoningEffort
      ? ['--reasoning-effort', input.grokReasoningEffort]
      : [];
    const accessArgs =
      accessMode === 'full-access'
        ? ['--permission-mode', 'bypassPermissions', '--always-approve']
        : ['--permission-mode', grokPermissionModeForAccessMode(accessMode)];
    const resumeArgs = resumeSessionId
      ? ['--resume', resumeSessionId, ...(input.forkSession ? ['--fork-session'] : [])]
      : [];
    return [
      'grok',
      '--cwd',
      cwd,
      '--model',
      modelArg,
      '--output-format',
      'streaming-json',
      ...effortArgs,
      ...accessArgs,
      ...resumeArgs,
      ...extraArgs,
      '--single',
      prompt,
    ];
  }

  if (model.providerId === 'muse') {
    // Muse Code turns run over `muse exec --json` (headless JSONL events on
    // stdout); the cwd becomes the workspace root, so no path flag is needed.
    // Approval prompts cannot be answered headlessly, so approval is always
    // off and the access mode maps onto muse's sandbox/write/shell switches:
    // full access lifts the sandbox entirely (--yolo, which also trusts the
    // workspace), workspace write keeps the OS sandbox on and trusts the
    // workspace's own skills/rules, and read only additionally disables the
    // shell and all filesystem writes. `--session-id <id>` appends the turn
    // to that session's event log, which is muse's resume (verified live on
    // 0.1.0: reruns with the same id continue the prior conversation).
    const effortArgs = [
      '--reasoning-effort',
      input.museReasoningEffort || defaultMuseReasoningEffort,
    ];
    const accessArgs =
      accessMode === 'full-access'
        ? ['--yolo']
        : accessMode === 'read-only'
          ? ['--disable-approval', '--disable-write', '--disable-shell']
          : ['--disable-approval', '--trust-workspace'];
    const resumeArgs = resumeSessionId ? ['--session-id', resumeSessionId] : [];
    return [
      'muse',
      'exec',
      '--json',
      '--model',
      modelArg,
      ...effortArgs,
      ...accessArgs,
      ...resumeArgs,
      ...extraArgs,
      prompt,
    ];
  }

  if (model.providerId === 'kimi') {
    // kimi always speaks ACP (JSON-RPC over `kimi acp`): the prompt, cwd,
    // session resume (session/load), model selection (session/set_config_option)
    // and permission mode (session/set_mode: plan/default/yolo) all travel
    // over the dialog, not argv. Prompt mode (`kimi -p`) is never used, even
    // for hidden one-shot turns: it auto-approves every tool and rejects
    // --plan ("Cannot combine --prompt with --plan" on 0.26), so it cannot
    // honor any access mode below Full access. Title generation goes through
    // kimiPlanModeOneShot (ACP plan mode) instead.
    return ['kimi', ...extraArgs, 'acp'];
  }

  if (model.providerId === 'fx') {
    // fx always speaks ACP (`fx acp`): the route (provider + model), cwd,
    // session resume and permission mode travel over the dialog, and its
    // startup provider and credentials in the environment (prepareFxLaunch).
    // Global flags such as --add-dir must precede `acp`.
    return ['fx', ...extraArgs, 'acp'];
  }

  // OpenCode's JSONL stream carries the session id, text deltas, reasoning,
  // and completed tool calls. Its run command resumes with --session and can
  // fork that session natively, keeping branched Orion threads isolated.
  const resumeArgs = resumeSessionId
    ? ['--session', resumeSessionId, ...(input.forkSession ? ['--fork'] : [])]
    : [];
  const variantArgs =
    input.openCodeReasoningEffort && input.openCodeReasoningEffort !== 'default'
      ? ['--variant', input.openCodeReasoningEffort]
      : [];
  const accessArgs = accessMode === 'full-access' ? ['--auto'] : [];
  return [
    'opencode',
    'run',
    '--format',
    'json',
    '--model',
    modelArg,
    ...resumeArgs,
    ...variantArgs,
    ...accessArgs,
    ...extraArgs,
    prompt,
  ];
};
