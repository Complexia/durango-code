import { app, protocol } from 'electron';
import path from 'node:path';
import { chromeDevtoolsMcpPackage, codexReasoningEffortForModel, defaultCodexServiceTier } from './models.js';
import { codexBrowserEnvironmentNote, codexBrowserMcpConfig, codexModelConfig, codexPersonalizationConfig } from './codex-config.js';
import { killAgentChild } from './run-registry.js';
import { spawnCodexServerProcess } from './codex-server-process.js';
import { loginShell } from './shell-env.js';
import { formatToolInput, formatToolOutput, stringifySummary } from './stream-adapters.js';
import { validQuestionAnswers } from './codex-questions.js';

// ---------------------------------------------------------------------------
// Codex app-server runs. Goals (/goal) live in the app-server's thread manager:
// the runtime auto-starts continuation turns while a goal is active, so
// `codex exec` cannot drive them. Inline reviews (/review) also belong here:
// review/start can resume the current thread, preserving the conversation
// context that `codex exec review` would discard.

// Mirrors the --config overrides the codex exec path builds in
// commandForModel; app-server takes them as a config map on thread/start.
export const codexAppServerConfig = (model, input) => {
  const options =
    input.providerOptions && typeof input.providerOptions === 'object' ? input.providerOptions : {};
  const config = {
    model_reasoning_effort: codexReasoningEffortForModel(model, input.codexReasoningEffort),
    // Same override as the exec paths: 5.6 models default summaries to none.
    model_reasoning_summary: 'detailed',
    service_tier: input.codexServiceTier || defaultCodexServiceTier,
    ...codexPersonalizationConfig(options),
    ...codexModelConfig(model, options),
  };
  if (options.networkAccess) config['sandbox_workspace_write.network_access'] = true;
  if (options.webSearch) config['tools.web_search'] = true;
  Object.assign(config, codexBrowserMcpConfig(options, input.accessMode, chromeDevtoolsMcpPackage));
  // Full resolved definitions are required for plugin-provided MCPs. They are
  // kept off argv and passed only across this local JSON-RPC connection.
  Object.assign(config, input.mcpRuntimeConfig);
  // Orion's spawn_subagent bridge — same overrides as the exec path builds.
  if (input.orionMcp) {
    config['mcp_servers.orion.command'] = input.orionMcp.command;
    config['mcp_servers.orion.args'] = input.orionMcp.args;
    config['mcp_servers.orion.env'] = { ELECTRON_RUN_AS_NODE: '1' };
    config['mcp_servers.orion.startup_timeout_sec'] = 30;
    config['mcp_servers.orion.tool_timeout_sec'] = 7200;
    config['mcp_servers.orion.default_tools_approval_mode'] = 'approve';
  }
  // Codex fails to load a config map that mixes an `mcp_servers` table
  // (Orion MCPs, toggle overrides) with dotted `mcp_servers.<name>.<key>`
  // entries ("invalid transport in mcp_servers.orion"). Fold the dotted
  // entries into the table so both shapes can coexist.
  const servers = config.mcp_servers;
  if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
    const merged = { ...servers };
    for (const key of Object.keys(config)) {
      const match = key.match(/^mcp_servers\.([^.]+)\.(.+)$/);
      if (!match) continue;
      merged[match[1]] = { ...merged[match[1]], [match[2]]: config[key] };
      delete config[key];
    }
    config.mcp_servers = merged;
  }
  return config;
};

// Attach images as native vision inputs as well as retaining the file-path
// references in the prompt. Keep screenshots at original detail for Astra.
export const codexUserInput = (text, attachments, model) => {
  const items = [{ type: 'text', text }];
  const seen = new Set();
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const filePath = attachment?.path;
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || seen.has(filePath)) continue;
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(attachment?.mimeType || '')) continue;
    seen.add(filePath);
    items.push({
      type: 'localImage',
      path: filePath,
      ...(model?.slug === 'gpt-6-astra' ? { detail: 'original' } : {}),
    });
  }
  return items;
};

// thread/tokenUsage/updated carries cumulative totals for the thread's loaded
// turns — map the total breakdown onto Orion's TurnTokenStats.
export const codexStatsFromTokenUsage = (tokenUsage, modelId) => {
  const total = tokenUsage?.total;
  if (!total || typeof total !== 'object') return null;
  const stats = { modelId };
  if (typeof total.totalTokens === 'number') stats.totalTokens = total.totalTokens;
  if (typeof total.inputTokens === 'number') stats.inputTokens = total.inputTokens;
  if (typeof total.outputTokens === 'number') stats.outputTokens = total.outputTokens;
  if (typeof total.cachedInputTokens === 'number') stats.cachedReadTokens = total.cachedInputTokens;
  if (typeof total.reasoningOutputTokens === 'number') stats.reasoningTokens = total.reasoningOutputTokens;
  if (typeof tokenUsage?.last?.inputTokens === 'number') stats.contextTokens = tokenUsage.last.inputTokens;
  if (typeof tokenUsage?.modelContextWindow === 'number') stats.contextWindow = tokenUsage.modelContextWindow;
  return stats;
};

const CODEX_CONTEXT_ACTIVITY_KEY = 'codex-context-compaction';
const CODEX_RETRY_ACTIVITY_KEY = 'codex-response-retry';

const codexErrorInfoSummary = (error) => {
  const info = error?.codexErrorInfo;
  if (!info) return '';
  if (typeof info === 'string') return info.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  if (typeof info !== 'object') return '';
  const [kind, value] = Object.entries(info)[0] ?? [];
  if (!kind) return '';
  const label = kind.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const status = Number(value?.httpStatusCode);
  return Number.isFinite(status) && status > 0 ? `${label} (HTTP ${status})` : label;
};

export const codexErrorDetail = (error) =>
  [stringifySummary(error?.message ?? '', 300), codexErrorInfoSummary(error)]
    .filter(Boolean)
    .join(' · ');

const CODEX_CONTEXT_RECOVERY_ERROR_KINDS = new Set([
  'contextWindowExceeded',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
]);

export const isRecoverableCodexContextError = (error) => {
  const info = error?.codexErrorInfo;
  if (typeof info === 'string') return CODEX_CONTEXT_RECOVERY_ERROR_KINDS.has(info);
  if (!info || typeof info !== 'object') return false;
  return Object.keys(info).some((kind) => CODEX_CONTEXT_RECOVERY_ERROR_KINDS.has(kind));
};

// Wire goal → the shape persisted on Thread.goal in the renderer store.
export const codexGoalForRenderer = (goal) => ({
  objective: String(goal.objective ?? ''),
  status: goal.status,
  tokenBudget: typeof goal.tokenBudget === 'number' ? goal.tokenBudget : null,
  tokensUsed: typeof goal.tokensUsed === 'number' ? goal.tokensUsed : 0,
  timeUsedSeconds: typeof goal.timeUsedSeconds === 'number' ? goal.timeUsedSeconds : 0,
  updatedAt: typeof goal.updatedAt === 'number' ? goal.updatedAt : undefined,
});

// v2 app-server thread items are the camelCase cousins of the exec --json
// items codexActivityFromItem maps; completion carries aggregated output.
export const codexAppServerActivityFromItem = (item, completed) => {
  if (!item || typeof item !== 'object') return null;
  const failed =
    item.status === 'failed' ||
    item.status === 'declined' ||
    (typeof item.exitCode === 'number' && item.exitCode !== 0);
  const status = failed ? 'error' : completed || item.status === 'completed' ? 'done' : 'running';
  const base = { key: typeof item.id === 'string' ? item.id : undefined, status };

  if (item.type === 'commandExecution') {
    const activity = {
      ...base,
      type: 'command',
      kind: 'execute',
      title: `Command - ${stringifySummary(item.command, 80)}`,
      detail: stringifySummary(item.command),
      input: formatToolInput(item.command),
    };
    if (completed) {
      const output = formatToolOutput(item.aggregatedOutput);
      if (output) activity.output = output;
    }
    if (typeof item.exitCode === 'number') activity.exitCode = item.exitCode;
    return activity;
  }
  if (item.type === 'fileChange') {
    const paths = Array.isArray(item.changes)
      ? item.changes.map((change) => change?.path).filter(Boolean)
      : [];
    return {
      ...base,
      type: 'tool',
      kind: 'edit',
      title: `File changes (${paths.length})`,
      detail: stringifySummary(paths.join(', ')),
      input: formatToolInput(item.changes),
    };
  }
  if (item.type === 'mcpToolCall') {
    const name = [item.server, item.tool].filter(Boolean).join('.');
    const activity = {
      ...base,
      type: 'tool',
      title: `Tool - ${name || 'MCP'}`,
      detail: stringifySummary(item.arguments ?? ''),
      input: formatToolInput(item.arguments),
    };
    const output = formatToolOutput(item.result ?? item.output);
    if (output) activity.output = output;
    return activity;
  }
  if (item.type === 'webSearch') {
    return {
      ...base,
      type: 'tool',
      kind: 'search',
      title: `Web search - ${stringifySummary(item.query ?? '', 80)}`,
      detail: stringifySummary(item.query ?? ''),
      input: formatToolInput(item.query),
    };
  }
  if (item.type === 'imageGeneration') {
    return { ...base, type: 'tool', title: 'Image generation' };
  }
  if (item.type === 'functionCallOutput' || item.type === 'dynamicToolCall') {
    return {
      ...base,
      type: 'tool',
      title: `Tool - ${[item.namespace, item.name || item.tool].filter(Boolean).join('.') || 'Codex'}`,
      input: formatToolInput(item.arguments),
      output: formatToolOutput(item.output ?? item.contentItems),
    };
  }
  if (item.type === 'sleep') {
    return { ...base, type: 'tool', title: 'Waiting', detail: `Up to ${Math.ceil((item.durationMs || 0) / 1000)} seconds; new input can interrupt this wait.` };
  }
  if (item.type === 'imageView') {
    return { ...base, type: 'tool', title: 'Inspecting image', detail: item.path || '' };
  }
  if (item.type === 'subAgentActivity') {
    return { ...base, type: 'tool', title: `Subagent ${item.kind || 'activity'}`, detail: item.agentPath || item.agentThreadId || '' };
  }
  if (item.type === 'contextCompaction') {
    return {
      ...base,
      type: 'tool',
      kind: 'context',
      title: completed ? 'Codex context optimized' : 'Optimizing Codex context',
      detail: completed
        ? 'Codex compacted the conversation and continued this turn.'
        : 'Codex is compacting this long-running conversation.',
    };
  }
  return null;
};

export const CODEX_GOAL_END_NOTES = {
  complete: '\n\n_Goal achieved._',
  paused: '\n\n_Goal paused — send `/goal resume` to continue._',
  blocked: '\n\n_Goal blocked — the agent can’t make progress without help. `/goal resume` to retry._',
  usageLimited: '\n\n_Goal hit usage limits — `/goal resume` once limits reset._',
  budgetLimited: '\n\n_Goal token budget exhausted — `/goal resume` to keep going._',
};

export const codexReviewTarget = (review) => {
  const threadContext =
    typeof review?.threadContext === 'string' ? review.threadContext.trim() : '';
  if (threadContext) {
    const scope =
      review?.mode === 'base' && review.base
        ? `Review the changes against the base branch ${review.base}.`
        : review?.mode === 'commit' && review.commit
          ? `Review the changes introduced by commit ${review.commit}.`
          : review?.mode === 'custom' && review.instructions
            ? String(review.instructions).trim()
            : 'Review all staged, unstaged, and untracked changes in the current repository.';
    return {
      type: 'custom',
      instructions: `${scope}\n\n${threadContext}`,
    };
  }
  if (review?.mode === 'base' && review.base) {
    return { type: 'baseBranch', branch: review.base };
  }
  if (review?.mode === 'commit' && review.commit) {
    return { type: 'commit', sha: review.commit };
  }
  if (review?.mode === 'custom') {
    return { type: 'custom', instructions: String(review.instructions ?? '').trim() };
  }
  return { type: 'uncommittedChanges' };
};

export const createCodexAppServerDriver = ({
  child,
  cwd,
  model,
  input,
  goal,
  review,
  resumeSessionId,
  accessMode,
  callbacks,
}) => {
  let nextRequestId = 1;
  const pendingRequests = new Map();
  const pendingUserInputs = new Map();
  let threadId = null;
  let textSeen = false;
  let pendingTextBreak = false;
  // Items whose text already streamed via deltas — their item.completed
  // payload must not be emitted a second time.
  const streamedTextItems = new Set();
  const streamedReasoningItems = new Set();
  const renderedQuestionItems = new Set();
  let goalStatus = null;
  let turnActive = false;
  let activeTurnId = null;
  let lastCompletedTurnId = null;
  let pendingTurnStart = null;
  let continuationTimer = null;
  let ended = false;
  let actionAccepted = false;
  let resumedExistingThread = false;
  let userTurnHadSubstantiveActivity = false;
  let nativeCompactionObserved = false;
  let lastTerminalTurnError = null;
  let contextRecoveryAttempted = false;
  let contextRecoveryActive = false;
  let recoveryCompactionTurnId = null;
  let recoveryCompactionErrorDetail = '';
  let resolveRecoveryCompaction = null;
  let restoreRolledBackPrompt = null;
  let recoveryPromise = null;
  let disposePromise = null;
  let retryActivityOpen = false;
  // A spawn's started item can carry the plaintext prompt before Codex knows
  // the receiver thread id. Merge the completed item into the same record so
  // callers always receive both pieces when the protocol splits them.
  const collabAgentItems = new Map();
  const collabThreadIds = new Set();

  // The goal runtime decides whether to continue after each turn; give it
  // this long to start the next turn (or flip the goal status) before Orion
  // concludes the pursuit stalled and pauses it.
  const CONTINUATION_GRACE_MS = 90_000;

  const write = (message) => {
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextRequestId++;
      pendingRequests.set(id, resolve);
      if (!write({ jsonrpc: '2.0', id, method, params })) {
        pendingRequests.delete(id);
        resolve({ error: { message: 'Codex app-server connection is closed.' } });
      }
    });

  const requestWithTimeout = async (method, params, timeoutMs) => {
    let timeout = null;
    const response = await Promise.race([
      request(method, params),
      new Promise((resolve) => {
        timeout = setTimeout(
          () => resolve({ error: { message: 'Codex app-server request timed out.' } }),
          timeoutMs
        );
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return response;
  };

  const settlePendingRequests = () => {
    for (const resolve of pendingRequests.values()) {
      resolve({ error: { message: 'Codex app-server run ended.' } });
    }
    pendingRequests.clear();
  };

  const emitText = (text) => {
    if (!text) return;
    const prefix = pendingTextBreak && textSeen ? '\n\n' : '';
    pendingTextBreak = false;
    textSeen = true;
    callbacks.onText(`${prefix}${text}`);
  };

  const clearContinuationTimer = () => {
    if (continuationTimer) {
      clearTimeout(continuationTimer);
      continuationTimer = null;
    }
  };

  const clearUserInputs = () => {
    for (const [id, pending] of pendingUserInputs) {
      if (!pending.async) write({ jsonrpc: '2.0', id, result: { answers: {} } });
    }
    pendingUserInputs.clear();
    callbacks.onUserInput?.();
  };

  const getUserInputs = () => [...pendingUserInputs.values()].map(({ id, params, async }) => ({
    requestId: id,
    threadId: input.threadId,
    questions: params.questions,
    ...(async ? { async: true } : {}),
  }));

  const answerUserInput = (id, answers) => {
    const pending = pendingUserInputs.get(id);
    if (ended || !pending || pending.sending || !validQuestionAnswers(pending.params.questions, answers)) return false;
    // Async questions have no protocol request to answer: the reply is an
    // ordinary user message the renderer steers into the turn. Claiming the
    // request here only guarantees the answer is sent once.
    if (pending.async) {
      pendingUserInputs.delete(id);
      callbacks.onUserInput?.();
      return true;
    }
    const entries = [];
    for (const question of pending.params.questions) {
      const value = answers[question.id];
      entries.push([question.id, { answers: value }]);
    }
    if (!write({ jsonrpc: '2.0', id, result: { answers: Object.fromEntries(entries) } })) return false;
    pendingUserInputs.delete(id);
    callbacks.onUserInput?.();
    return true;
  };

  const endRun = (note) => {
    if (ended) return;
    ended = true;
    // Transfer async questions before notifying the renderer or disposing the
    // run. Their answers can start a follow-up after this transport is gone.
    callbacks.onRetainUserInputs?.(getUserInputs().filter((request) => request.async));
    clearUserInputs();
    clearContinuationTimer();
    if (note) emitText(note);
    callbacks.onRunEnd();
  };

  const finishRetryActivity = () => {
    if (!retryActivityOpen) return;
    retryActivityOpen = false;
    callbacks.onActivity({
      key: CODEX_RETRY_ACTIVITY_KEY,
      type: 'tool',
      kind: 'network',
      title: 'Codex reconnected',
      detail: 'The response stream recovered.',
      status: 'done',
    });
  };

  const markActionAccepted = () => {
    if (actionAccepted) return;
    actionAccepted = true;
    callbacks.onActionAccepted?.();
  };

  const fail = (error) => {
    if (ended) return;
    ended = true;
    clearUserInputs();
    clearContinuationTimer();
    resolveRecoveryCompaction?.(false);
    resolveRecoveryCompaction = null;
    callbacks.onFatal(
      typeof error === 'string' ? error : error?.message ?? 'Codex app-server protocol error.'
    );
  };

  const armContinuationTimer = () => {
    clearContinuationTimer();
    continuationTimer = setTimeout(async () => {
      continuationTimer = null;
      if (ended || turnActive) return;
      // The runtime declined to keep going (idle work rejected, nothing left
      // to do, …) without flipping the goal status. Pause the stored goal so
      // it matches the fact that nothing is running, then end gracefully.
      if (goalStatus === 'active' && threadId) {
        try {
          await request('thread/goal/set', { threadId, status: 'paused' });
        } catch {}
      }
      endRun('\n\n_Goal run went idle — paused. Send `/goal resume` to continue._');
    }, CONTINUATION_GRACE_MS);
  };

  const handleGoalUpdated = (wireGoal) => {
    goalStatus = wireGoal.status;
    callbacks.onGoal(codexGoalForRenderer(wireGoal));
    if (wireGoal.status !== 'active') {
      clearContinuationTimer();
      // thread/resume emits the authoritative goal snapshot before an inline
      // review starts. Keep Orion's mirror synchronized without letting that
      // snapshot terminate the review run.
      if (goal && !review && !turnActive) {
        endRun(CODEX_GOAL_END_NOTES[wireGoal.status] ?? '');
      }
    }
  };

  const userTurnParams = () => ({
    threadId,
    input: codexUserInput(
      `${codexBrowserEnvironmentNote(input.providerOptions, accessMode)}${input.prompt}`,
      input.attachments,
      model
    ),
    effort: codexReasoningEffortForModel(model, input.codexReasoningEffort),
    serviceTier: input.codexServiceTier || defaultCodexServiceTier,
  });

  const requestUserTurn = async () => {
    userTurnHadSubstantiveActivity = false;
    nativeCompactionObserved = false;
    lastTerminalTurnError = null;
    const startedTurn = await request('turn/start', userTurnParams());
    if (startedTurn.error) return { ok: false, error: startedTurn.error };
    markActionAccepted();
    // When the thread is already busy, app-server folds this input into the
    // running turn and returns that turn's id without a new turn/started.
    // Adopt the id so Stop and steering can still address the live turn.
    const turnId = startedTurn.result?.turn?.id;
    if (typeof turnId === 'string' && turnId !== lastCompletedTurnId && !activeTurnId) {
      turnActive = true;
      activeTurnId = turnId;
    }
    return { ok: true };
  };

  const startUserTurn = () => {
    const started = requestUserTurn();
    pendingTurnStart = started;
    void started.finally(() => {
      if (pendingTurnStart === started) pendingTurnStart = null;
    });
    return started;
  };

  const finishFailedTurn = (turn, fallbackError) => {
    const error = turn.error ?? fallbackError;
    const message = error?.message ?? 'Codex turn failed.';
    callbacks.onActivity({
      type: 'error',
      title: 'Turn failed',
      detail: stringifySummary(message, 300),
      status: 'error',
    });
    if (review) {
      fail(message);
      return;
    }
    // The goal runtime skips continuation after turn errors — pause the
    // stored goal so its status matches reality, then end the run.
    void (async () => {
      if (goalStatus === 'active' && threadId) {
        try {
          const paused = await Promise.race([
            request('thread/goal/set', { threadId, status: 'paused' }),
            new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
          ]);
          // The adjacent goal-updated notification normally handles this,
          // but apply the response too in case process output was delayed.
          if (paused?.result?.goal) handleGoalUpdated(paused.result.goal);
        } catch {}
      }
      endRun('\n\n_Goal run stopped on an error — `/goal resume` to retry._');
    })();
  };

  const recoverFailedUserTurn = async (turn, error) => {
    contextRecoveryAttempted = true;
    contextRecoveryActive = true;
    retryActivityOpen = true;
    callbacks.onActivity({
      key: CODEX_RETRY_ACTIVITY_KEY,
      type: 'tool',
      kind: 'context',
      title: 'Codex recovering context',
      detail: 'The resumed turn failed before doing work. Compacting with Codex and retrying once.',
      status: 'running',
    });

    // turn/start persists its user item before sampling. Remove only that
    // side-effect-free failed turn so retrying the original prompt does not
    // duplicate it in Codex history. This compatibility fallback can go away
    // once app-server includes incoming items in pre-turn compaction checks.
    const rolledBack = await request('thread/rollback', { threadId, numTurns: 1 });
    if (rolledBack.error) {
      contextRecoveryActive = false;
      retryActivityOpen = false;
      if (ended) return;
      callbacks.onActivity({
        key: CODEX_RETRY_ACTIVITY_KEY,
        type: 'error',
        title: 'Codex context recovery failed',
        detail: codexErrorDetail(rolledBack.error) || 'Codex could not roll back the failed turn.',
        status: 'error',
      });
      finishFailedTurn(turn, error);
      return;
    }

    let failedTurnRolledBack = true;
    let restorationPromise = null;
    restoreRolledBackPrompt = async (detail) => {
      if (!failedTurnRolledBack) return detail;
      restorationPromise ??= requestWithTimeout(
        'thread/inject_items',
        {
          threadId,
          items: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: userTurnParams().input[0].text }],
            },
          ],
        },
        1500
      );
      const restored = await restorationPromise;
      if (!restored.error) {
        failedTurnRolledBack = false;
        return detail;
      }
      const restoreDetail = codexErrorDetail(restored.error);
      return `${detail} The failed prompt could not be restored to Codex history${
        restoreDetail ? `: ${restoreDetail}` : '.'
      }`;
    };

    if (ended) {
      await restoreRolledBackPrompt('Codex context recovery was cancelled.');
      return;
    }

    recoveryCompactionTurnId = null;
    recoveryCompactionErrorDetail = '';
    const completion = new Promise((resolve) => {
      resolveRecoveryCompaction = resolve;
    });
    const compactStarted = await request('thread/compact/start', { threadId });
    if (compactStarted.error) {
      resolveRecoveryCompaction = null;
      const detail = await restoreRolledBackPrompt(
        codexErrorDetail(compactStarted.error) || 'Codex could not compact this thread.'
      );
      contextRecoveryActive = false;
      retryActivityOpen = false;
      if (ended) return;
      callbacks.onActivity({
        key: CODEX_CONTEXT_ACTIVITY_KEY,
        type: 'error',
        title: 'Codex context optimization failed',
        detail,
        status: 'error',
      });
      finishFailedTurn(turn, error);
      return;
    }

    const compacted = await completion;
    resolveRecoveryCompaction = null;
    recoveryCompactionTurnId = null;
    if (!compacted) {
      const detail = await restoreRolledBackPrompt(
        recoveryCompactionErrorDetail || 'Codex could not compact this thread.'
      );
      contextRecoveryActive = false;
      retryActivityOpen = false;
      if (ended) return;
      callbacks.onActivity({
        key: CODEX_CONTEXT_ACTIVITY_KEY,
        type: 'error',
        title: 'Codex context optimization failed',
        detail,
        status: 'error',
      });
      finishFailedTurn(turn, error);
      return;
    }
    if (ended) {
      await restoreRolledBackPrompt('Codex context recovery was cancelled.');
      return;
    }

    contextRecoveryActive = false;
    const restarted = await startUserTurn();
    if (!restarted.ok) {
      contextRecoveryActive = true;
      const detail = await restoreRolledBackPrompt(
        codexErrorDetail(restarted.error) || 'Codex could not retry the turn.'
      );
      contextRecoveryActive = false;
      retryActivityOpen = false;
      if (ended) return;
      callbacks.onActivity({
        key: CODEX_RETRY_ACTIVITY_KEY,
        type: 'error',
        title: 'Codex context recovery failed',
        detail,
        status: 'error',
      });
      finishFailedTurn(turn, restarted.error);
      return;
    }
    failedTurnRolledBack = false;
  };

  const handleTurnCompleted = (params) => {
    turnActive = false;
    activeTurnId = null;
    const turn = params.turn ?? {};
    if (typeof turn.id === 'string') lastCompletedTurnId = turn.id;
    if (turn.status === 'failed') {
      const error = isRecoverableCodexContextError(turn.error)
        ? turn.error
        : lastTerminalTurnError ?? turn.error;
      if (
        !goal &&
        !review &&
        // The notes/searchable-history runtime owns recovery. The legacy
        // rollback/compact fallback would rewrite the history it searches.
        codexModelConfig(model, input.providerOptions)['features.context_management.experimental_mode'] !== true &&
        resumedExistingThread &&
        !contextRecoveryAttempted &&
        !userTurnHadSubstantiveActivity &&
        !nativeCompactionObserved &&
        isRecoverableCodexContextError(error)
      ) {
        recoveryPromise = recoverFailedUserTurn(turn, error).finally(() => {
          recoveryPromise = null;
          restoreRolledBackPrompt = null;
        });
        return;
      }
      finishFailedTurn(turn, error);
      return;
    }
    if (ended) return;
    if (review) {
      endRun();
      return;
    }
    if (!goal) {
      endRun();
      return;
    }
    if (goalStatus && goalStatus !== 'active') {
      endRun(CODEX_GOAL_END_NOTES[goalStatus] ?? '');
      return;
    }
    // Goal still active: the runtime should start a continuation turn.
    armContinuationTimer();
  };

  const handleItem = (params, completed) => {
    const item = params.item;
    if (!item || typeof item !== 'object') return;
    if (!contextRecoveryActive) {
      if (item.type === 'contextCompaction') nativeCompactionObserved = true;
      else if (item.type !== 'userMessage') userTurnHadSubstantiveActivity = true;
    }
    if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string') {
      collabThreadIds.add(item.agentThreadId);
    }
    if (item.type === 'collabAgentToolCall') {
      const previous = collabAgentItems.get(item.id) ?? {};
      const merged = {
        ...previous,
        ...(typeof item.tool === 'string' ? { tool: item.tool } : {}),
        ...(typeof item.prompt === 'string' && item.prompt ? { prompt: item.prompt } : {}),
        ...(typeof item.model === 'string' && item.model ? { model: item.model } : {}),
        ...(typeof item.reasoningEffort === 'string' && item.reasoningEffort
          ? { reasoningEffort: item.reasoningEffort }
          : {}),
        ...(Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.length > 0
          ? { receiverThreadIds: item.receiverThreadIds }
          : {}),
      };
      collabAgentItems.set(item.id, merged);
      if (merged.tool === 'spawnAgent' || merged.tool === 'spawn_agent') {
        for (const id of merged.receiverThreadIds ?? []) {
          if (typeof id !== 'string' || !id) continue;
          collabThreadIds.add(id);
          callbacks.onSubagent?.({
            id,
            prompt: merged.prompt,
            model: merged.model,
            reasoningEffort: merged.reasoningEffort,
          });
        }
      }
      if (completed) collabAgentItems.delete(item.id);
      return;
    }
    if (item.type === 'agentMessage') {
      if (completed) {
        if (!streamedTextItems.has(item.id) && typeof item.text === 'string' && item.text) {
          emitText(item.text);
        }
        // Astra asks questions with request_user_input_async: the turn keeps
        // running and the answer arrives as a steered user message. item.text
        // normally already lists the questions; only render ones it omits.
        if (Array.isArray(item.questions) && !renderedQuestionItems.has(item.id)) {
          renderedQuestionItems.add(item.id);
          const questions = item.questions.filter((question) => typeof question?.title === 'string' && question.title);
          const unrendered = questions.filter((question) => !item.text?.includes(question.title));
          if (unrendered.length) {
            emitText(`\n\n${unrendered.map((question) => [
              question.title,
              ...(Array.isArray(question.options) ? question.options.filter((option) => typeof option === 'string').map((option) => `- ${option}`) : []),
            ].join('\n')).join('\n\n')}`);
          }
          if (questions.length && !ended && callbacks.onUserInput) {
            pendingUserInputs.set(`async:${item.id}`, {
              id: `async:${item.id}`,
              async: true,
              params: {
                threadId,
                questions: questions.map((question, index) => ({
                  id: String(index),
                  header: 'Question',
                  question: question.title,
                  options: (Array.isArray(question.options) ? question.options : [])
                    .filter((option) => typeof option === 'string' && option)
                    .map((label) => ({ label, description: '' })),
                })),
              },
            });
            callbacks.onUserInput();
          }
        }
        pendingTextBreak = true;
      }
      return;
    }
    if (item.type === 'reasoning') {
      if (completed && !streamedReasoningItems.has(item.id)) {
        const parts = [
          ...(Array.isArray(item.summary) ? item.summary : []),
          ...(Array.isArray(item.content) ? item.content : []),
        ].filter((part) => typeof part === 'string' && part);
        if (parts.length) callbacks.onReasoning(`${parts.join('\n\n')}\n\n`);
      }
      return;
    }
    const activity = codexAppServerActivityFromItem(item, completed);
    if (activity) {
      // Text resuming after tool activity is a new paragraph.
      if (textSeen) pendingTextBreak = true;
      callbacks.onActivity(activity);
    }
  };

  const handlePlanUpdate = (params) => {
    const list = Array.isArray(params.plan) ? params.plan : [];
    const total = list.length;
    const completedCount = list.filter((step) => step?.status === 'completed').length;
    const isActive = (step) => step?.status === 'inProgress' || step?.status === 'in_progress';
    const active = list.find(isActive);
    callbacks.onActivity({
      key: 'plan',
      type: 'plan',
      kind: 'plan',
      title: active
        ? `Tasks (${completedCount}/${total}) - ${stringifySummary(active.step, 60)}`
        : `Tasks (${completedCount}/${total})`,
      status: total > 0 && completedCount === total ? 'done' : 'running',
      plan: list.map((step) => ({
        content: String(step?.step ?? ''),
        status: step?.status === 'completed' ? 'completed' : isActive(step) ? 'in_progress' : 'pending',
      })),
    });
  };

  // approvalPolicy 'never' means these should not fire; answer defensively by
  // access-mode policy so a stray request can never deadlock the run.
  const answerServerRequest = (message) => {
    const method = message.method;
    const respond = (result) => write({ jsonrpc: '2.0', id: message.id, result });
    if (method === 'currentTime/read') return respond({ currentTimeAt: Math.floor(Date.now() / 1000) });
    if (method === 'item/tool/requestUserInput') {
      const params = message.params ?? {};
      if (params.threadId !== threadId && !collabThreadIds.has(params.threadId)) return;
      if (
        ended || !callbacks.onUserInput ||
        !Array.isArray(params.questions) || !params.questions.length
      ) return respond({ answers: {} });
      userTurnHadSubstantiveActivity = true;
      pendingUserInputs.set(message.id, { id: message.id, params });
      callbacks.onUserInput();
      return;
    }
    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      return respond({ decision: accessMode === 'full-access' ? 'accept' : 'decline' });
    }
    if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      return respond({ decision: accessMode === 'read-only' ? 'decline' : 'accept' });
    }
    if (method === 'item/permissions/requestApproval') {
      return respond({ decision: accessMode === 'full-access' ? 'accept' : 'decline' });
    }
    write({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: 'Method not supported' },
    });
  };

  const start = async () => {
    const init = await request('initialize', {
      clientInfo: { name: 'orion', title: 'Durango Code', version: app.getVersion?.() ?? '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (init.error) return fail(init.error);
    write({ jsonrpc: '2.0', method: 'initialized', params: {} });

    const sandbox =
      accessMode === 'full-access'
        ? 'danger-full-access'
        : accessMode === 'read-only'
          ? 'read-only'
          : 'workspace-write';
    const threadParams = {
      cwd,
      model: model.slug,
      sandbox,
      approvalPolicy: 'never',
      config: codexAppServerConfig(model, input),
      ...(typeof input.codexInitialContext === 'string' && input.codexInitialContext.trim()
        ? { developerInstructions: input.codexInitialContext }
        : {}),
    };

    let resolvedThreadId = null;
    if (resumeSessionId) {
      const resumed = await request('thread/resume', { threadId: resumeSessionId, ...threadParams });
      if (ended) return;
      if (resumed.error) {
        // A busy writer, transport failure, or missing rollout does not grant
        // permission to replace the conversation. Retain the stored session
        // id and surface the provider's reason so the user can retry safely.
        return fail(`Could not resume the Codex session. The existing conversation has been preserved.\n\n${codexErrorDetail(resumed.error)}`);
      }
      resolvedThreadId = resumed.result?.thread?.id ?? resumeSessionId;
      resumedExistingThread = true;
    }
    if (!resolvedThreadId) {
      const started = await request('thread/start', threadParams);
      resolvedThreadId = started.result?.thread?.id;
      if (started.error || typeof resolvedThreadId !== 'string') {
        return fail(started.error ?? 'Codex app-server did not return a thread id.');
      }
    }
    threadId = resolvedThreadId;
    callbacks.onSessionId(threadId);

    if (review) {
      const startedReview = await request('review/start', {
        threadId,
        delivery: 'inline',
        target: codexReviewTarget(review),
      });
      if (startedReview.error) return fail(startedReview.error);
      markActionAccepted();
      return;
    }

    if (!goal) {
      const startedTurn = await startUserTurn();
      if (!startedTurn.ok) return fail(startedTurn.error);
      return;
    }

    // Goals require a persistent thread; setting one active immediately
    // starts the pursuit turn — no turn/start call needed.
    const setParams =
      goal.action === 'resume'
        ? { threadId, status: 'active' }
        : {
            threadId,
            objective: goal.objective,
            ...(typeof goal.tokenBudget === 'number' && goal.tokenBudget > 0
              ? { tokenBudget: Math.round(goal.tokenBudget) }
              : {}),
          };
    const set = await request('thread/goal/set', setParams);
    if (set.error) return fail(set.error);
    markActionAccepted();
    if (set.result?.goal) handleGoalUpdated(set.result.goal);
    // If no turn starts (e.g. the runtime immediately declines idle work),
    // the continuation watchdog pauses the goal and ends the run.
    if (!turnActive) armContinuationTimer();
  };

  // User stop = pause: the goal stays resumable and its stored status
  // matches the fact that nothing is running anymore.
  const stopGoalRun = async () => {
    ended = true;
    clearContinuationTimer();
    if (!threadId) return;
    const withTimeout = (promise, ms) =>
      Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
    try {
      const paused = await withTimeout(
        request('thread/goal/set', { threadId, status: 'paused' }),
        1500
      );
      // Do not depend solely on the adjacent notification: Stop may reap the
      // app-server before that notification is delivered to the renderer.
      if (paused?.result?.goal) handleGoalUpdated(paused.result.goal);
      await withTimeout(
        request('turn/interrupt', {
          threadId,
          ...(activeTurnId ? { turnId: activeTurnId } : {}),
        }),
        1000
      );
    } catch {}
  };

  const dispose = () => {
    if (disposePromise) return disposePromise;
    ended = true;
    clearUserInputs();
    clearContinuationTimer();
    const finishRecoveryCompaction = resolveRecoveryCompaction;
    resolveRecoveryCompaction = null;
    // On the shared app-server a turn outlives this run's connection, so
    // closing it does not stop Codex. Interrupt the live turn explicitly —
    // otherwise the next run's turn/start is folded into the stale turn.
    // A turn/start still in flight gets a bounded chance to report its id.
    const turnStart = contextRecoveryActive ? null : pendingTurnStart;
    const completedTurnAtStop = lastCompletedTurnId;
    const interruptOrdinaryTurn = async () => {
      if (turnStart) {
        let timeout;
        try {
          await Promise.race([turnStart, new Promise((resolve) => {
            timeout = setTimeout(resolve, 1000);
            timeout.unref?.();
          })]);
        } finally {
          clearTimeout(timeout);
        }
      }
      let turnId = turnActive ? activeTurnId : null;
      if (
        !turnId && threadId && turnStart && pendingTurnStart === turnStart &&
        lastCompletedTurnId === completedTurnAtStop && !contextRecoveryActive
      ) {
        // The start response may be delayed even though Codex is running.
        // Interruption requires a turn id; recover it from the loaded thread
        // before dropping the pending response and closing the connection.
        const snapshot = await requestWithTimeout('thread/read', { threadId, includeTurns: true }, 1000);
        const runningTurn = snapshot.result?.thread?.turns?.find((turn) => turn.status === 'inProgress');
        turnId = activeTurnId ?? runningTurn?.id;
      }
      // A completion notification can overtake the snapshot response.
      if (threadId && typeof turnId === 'string' && turnId !== lastCompletedTurnId && !contextRecoveryActive) {
        await requestWithTimeout('turn/interrupt', { threadId, turnId }, 1000);
      }
    };
    disposePromise = (async () => {
      await interruptOrdinaryTurn();
      // Recovery can itself be awaiting an app-server request. Release those
      // waits before joining recovery or disposal can deadlock with an
      // unresponsive app-server. Cleanup requests below remain bounded.
      settlePendingRequests();
      if (contextRecoveryActive && restoreRolledBackPrompt) {
        await requestWithTimeout(
          'turn/interrupt',
          {
            threadId,
            ...(recoveryCompactionTurnId ? { turnId: recoveryCompactionTurnId } : {}),
          },
          1000
        );
        await restoreRolledBackPrompt('Codex context recovery was cancelled.');
      }
      finishRecoveryCompaction?.(false);
      await recoveryPromise;
      settlePendingRequests();
    })();
    return disposePromise;
  };

  // Codex app-server accepts same-turn steering natively. The active turn id
  // is an ownership precondition, so a racing completion cannot redirect a
  // newer turn or silently turn this into an ordinary follow-up.
  const steer = async (text, attachments) => {
    if (ended || !threadId || !activeTurnId || typeof text !== 'string' || !text) return false;
    const expectedTurnId = activeTurnId;
    try {
      const response = await request('turn/steer', {
        threadId,
        expectedTurnId,
        input: codexUserInput(text, attachments, model),
      });
      return (
        !response?.error &&
        activeTurnId === expectedTurnId &&
        typeof response?.result?.turnId === 'string' &&
        response.result.turnId === expectedTurnId
      );
    } catch {
      return false;
    }
  };

  const answerAsyncUserInput = async (id, answers, text) => {
    const pending = pendingUserInputs.get(id);
    if (ended || !pending?.async || pending.sending || !activeTurnId ||
        !validQuestionAnswers(pending.params.questions, answers) || typeof text !== 'string' || !text.trim()) return false;
    pending.sending = true;
    const expectedTurnId = activeTurnId;
    try {
      // Goal turns accept native steering too. Do not consume the question
      // until its owning driver receives a successful acknowledgement.
      const response = await request('turn/steer', {
        threadId, expectedTurnId, input: codexUserInput(text, [], model),
      });
      if (response?.error || response?.result?.turnId !== expectedTurnId) return false;
      // An acknowledgement remains authoritative if the turn just completed.
      // The caller also removes any copy transferred to completed questions.
      pendingUserInputs.delete(id);
      callbacks.onUserInput?.();
      return true;
    } finally {
      pending.sending = false;
    }
  };

  const handleMessage = (message) => {
    if (!message || typeof message !== 'object') return;

    if (message.id !== undefined && !message.method) {
      const resolve = pendingRequests.get(message.id);
      if (resolve) {
        pendingRequests.delete(message.id);
        resolve(message);
      }
      return;
    }

    if (message.id !== undefined && message.method) return answerServerRequest(message);

    const params = message.params ?? {};
    if (message.method === 'serverRequest/resolved') {
      const pending = pendingUserInputs.get(params.requestId);
      if (pending?.params.threadId === params.threadId) {
        pendingUserInputs.delete(params.requestId);
        callbacks.onUserInput?.();
      }
      return;
    }
    // Defensive: the app-server can host many threads; only ours matters.
    // Collaboration descendants run on their own Codex thread ids but share
    // this run's protocol connection. Admit only a known descendant chain so
    // nested spawn prompts survive without accepting another Orion run's
    // notifications from the persistent server.
    const collabItem = ['collabAgentToolCall', 'subAgentActivity'].includes(params.item?.type) ? params.item : null;
    const collabSenderId = collabItem?.senderThreadId ?? params.threadId;
    const belongsToCollabFamily =
      Boolean(collabItem) &&
      (collabSenderId === threadId || collabThreadIds.has(collabSenderId));
    if (
      params.threadId &&
      threadId &&
      params.threadId !== threadId &&
      !belongsToCollabFamily
    ) {
      return;
    }

    if (contextRecoveryActive) {
      if (message.method === 'turn/started' && !recoveryCompactionTurnId) {
        recoveryCompactionTurnId = params.turn?.id ?? null;
        return;
      }
      if (
        message.method === 'turn/completed' &&
        recoveryCompactionTurnId &&
        params.turn?.id === recoveryCompactionTurnId
      ) {
        resolveRecoveryCompaction?.(params.turn?.status === 'completed');
        return;
      }
      if (message.method === 'thread/tokenUsage/updated') {
        const stats = codexStatsFromTokenUsage(params.tokenUsage, model.id);
        if (stats) callbacks.onStats(stats);
        return;
      }
      if (message.method === 'error') {
        const detail = codexErrorDetail(params.error);
        if (!params.willRetry) {
          recoveryCompactionErrorDetail =
            detail || 'Codex reported a context-compaction error.';
        }
        callbacks.onActivity({
          key: CODEX_CONTEXT_ACTIVITY_KEY,
          type: params.willRetry ? 'tool' : 'error',
          kind: 'context',
          title: params.willRetry
            ? 'Optimizing Codex context'
            : 'Codex context optimization failed',
          detail: detail || 'Codex reported a context-compaction error.',
          status: params.willRetry ? 'running' : 'error',
        });
        if (!params.willRetry) resolveRecoveryCompaction?.(false);
        return;
      }
      if (message.method === 'item/started' && params.item?.type === 'contextCompaction') {
        handleItem(params, false);
        return;
      }
      if (message.method === 'item/completed' && params.item?.type === 'contextCompaction') {
        handleItem(params, true);
        return;
      }
      // Recovery compaction is an internal app-server turn. Its native
      // contextCompaction item is visible, but its summarization internals are not.
      return;
    }

    if (
      retryActivityOpen &&
      (message.method?.startsWith('item/') ||
        message.method === 'turn/completed' ||
        message.method === 'thread/tokenUsage/updated')
    ) {
      finishRetryActivity();
    }

    switch (message.method) {
      case 'item/agentMessage/delta': {
        userTurnHadSubstantiveActivity = true;
        if (typeof params.itemId === 'string') streamedTextItems.add(params.itemId);
        if (typeof params.delta === 'string') emitText(params.delta);
        return;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        userTurnHadSubstantiveActivity = true;
        if (typeof params.itemId === 'string') streamedReasoningItems.add(params.itemId);
        if (typeof params.delta === 'string' && params.delta) callbacks.onReasoning(params.delta);
        return;
      }
      case 'item/reasoning/summaryPartAdded':
        userTurnHadSubstantiveActivity = true;
        callbacks.onReasoning('\n\n');
        return;
      case 'item/started':
        handleItem(params, false);
        return;
      case 'item/completed':
        handleItem(params, true);
        return;
      case 'turn/started': {
        // This notification can race ahead of the turn/start response. Once
        // seen, replaying the prompt on a replacement connection is unsafe.
        markActionAccepted();
        turnActive = true;
        activeTurnId = typeof params.turn?.id === 'string' ? params.turn.id : null;
        clearContinuationTimer();
        if (textSeen) pendingTextBreak = true;
        return;
      }
      case 'turn/completed':
        handleTurnCompleted(params);
        return;
      case 'turn/plan/updated':
        handlePlanUpdate(params);
        return;
      case 'thread/tokenUsage/updated': {
        const stats = codexStatsFromTokenUsage(params.tokenUsage, model.id);
        if (stats) callbacks.onStats(stats);
        return;
      }
      case 'thread/goal/updated': {
        if (params.goal) handleGoalUpdated(params.goal);
        return;
      }
      case 'thread/goal/cleared': {
        goalStatus = 'cleared';
        callbacks.onGoal(null);
        clearContinuationTimer();
        if (goal && !review && !turnActive) endRun('\n\n_Goal cleared._');
        return;
      }
      case 'warning':
      case 'guardianWarning':
      case 'configWarning': {
        const detail = [params.message || params.summary, params.details].filter((part) => typeof part === 'string' && part).join('\n');
        if (detail) callbacks.onActivity({
          type: 'tool',
          title: message.method === 'guardianWarning' ? 'Codex safety notice' : 'Codex notice',
          detail,
          status: 'done',
        });
        return;
      }
      case 'error': {
        const detail = codexErrorDetail(params.error);
        if (!params.willRetry) lastTerminalTurnError = params.error ?? null;
        if (detail) {
          const updatesRetryActivity = params.willRetry || retryActivityOpen;
          retryActivityOpen = Boolean(params.willRetry);
          callbacks.onActivity({
            key: updatesRetryActivity ? CODEX_RETRY_ACTIVITY_KEY : undefined,
            type: params.willRetry ? 'tool' : 'error',
            kind: params.willRetry ? 'network' : undefined,
            title: params.willRetry
              ? 'Codex reconnecting'
              : updatesRetryActivity
                ? 'Codex reconnect failed'
                : 'Codex error',
            detail,
            status: params.willRetry ? 'running' : 'error',
          });
        }
        return;
      }
      default:
        return;
    }
  };

  return { start, handleMessage, steer, stopGoalRun, dispose, getUserInputs, answerUserInput, answerAsyncUserInput };
};

// Ordinary Codex app-server turns addressable by Orion's renderer run id.
// Goal question replies address their owning driver separately; review turns
// do not support steering.
export const codexSteerableRunDrivers = new Map();

export const steerCodexAppServerRun = (runId, text, attachments) => {
  const driver = codexSteerableRunDrivers.get(runId);
  return driver ? driver.steer(text, attachments) : false;
};

// Goal runs whose driver must be asked to pause before the process is killed
// (agent:stopTurn). Keyed by runId; cleaned up in finalizeRun.
export const codexGoalRunDrivers = new Map();

// ---------------------------------------------------------------------------
// Claude persistent sessions (Agent SDK). The one-shot `claude --print` spawn
// ends the harness process with every turn, which kills any background
// subagents the model left running and silences the task notifications that
// are supposed to re-invoke it — long multi-phase runs died at each turn
// boundary. Claude turns therefore run on a persistent Agent SDK session per
// thread: one CLI process spans the whole conversation, user turns are pushed
// over stream-json stdin, steer/stop interrupt the turn in place instead of
// SIGTERMing the process, and turns the harness starts on its own (a
// background task finishing) are emitted as `started` events flagged
// `background` so the renderer can grow the transcript. `/btw` asides and
// title generation keep the one-shot CLI path.


// Goal ops on a thread with no live goal run (pause after the run already
// ended, clear, status refresh). Runs a short-lived app-server client dialog:
// initialize → thread/resume → goal op → disconnect. `appServerChild` can be
// an isolated connection to Orion's persistent server; direct app-server
// remains the compatibility fallback.
export const runCodexGoalOp = ({
  sessionId,
  threadId,
  cwd,
  action,
  signal,
  appServerChild = null,
}) => {
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, error: 'Codex goal operation was cancelled.' });
  }
  return new Promise((resolve) => {
    const child =
      appServerChild ??
      spawnCodexServerProcess(loginShell, ['-lc', 'codex app-server'], {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
    let nextId = 1;
    let buffer = '';
    const pending = new Map();
    let settled = false;
    let timeout = null;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    };
    const settle = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      void killAgentChild(child, threadId).then(() => resolve(value));
    };
    const abort = () => settle({ ok: false, error: 'Codex goal operation was cancelled.' });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    timeout = setTimeout(
      () => settle({ ok: false, error: 'Codex app-server timed out.' }),
      20000
    );
    const write = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {}
    };
    const request = (method, params) =>
      new Promise((res) => {
        const id = nextId++;
        pending.set(id, res);
        write({ jsonrpc: '2.0', id, method, params });
      });
    child.on('error', (error) => settle({ ok: false, error: error.message }));
    child.on('exit', () => settle({ ok: false, error: 'Codex app-server exited early.' }));
    child.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const message = JSON.parse(trimmed);
          if (message.id !== undefined && !message.method && pending.has(message.id)) {
            const res = pending.get(message.id);
            pending.delete(message.id);
            res(message);
          }
        } catch {}
      }
    });
    (async () => {
      try {
        const init = await request('initialize', {
          clientInfo: { name: 'orion', title: 'Durango Code', version: app.getVersion?.() ?? '0.0.0' },
          capabilities: { experimentalApi: true, requestAttestation: false },
        });
        if (init.error) return settle({ ok: false, error: init.error.message });
        write({ jsonrpc: '2.0', method: 'initialized', params: {} });
        const resumed = await request('thread/resume', { threadId: sessionId, cwd });
        if (resumed.error) return settle({ ok: false, error: resumed.error.message });
        if (action === 'pause') {
          const result = await request('thread/goal/set', { threadId: sessionId, status: 'paused' });
          if (result.error) return settle({ ok: false, error: result.error.message });
          return settle({ ok: true, goal: result.result?.goal ? codexGoalForRenderer(result.result.goal) : null });
        }
        if (action === 'clear') {
          const result = await request('thread/goal/clear', { threadId: sessionId });
          if (result.error) return settle({ ok: false, error: result.error.message });
          return settle({ ok: true, goal: null });
        }
        const result = await request('thread/goal/get', { threadId: sessionId });
        if (result.error) return settle({ ok: false, error: result.error.message });
        return settle({ ok: true, goal: result.result?.goal ? codexGoalForRenderer(result.result.goal) : null });
      } catch (error) {
        settle({ ok: false, error: error?.message ?? String(error) });
      }
    })();
  });
};
