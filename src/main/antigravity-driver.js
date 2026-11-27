import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killAgentChild } from './run-registry.js';
import { isPreapprovedOrionTool } from './thread-reader-routing.js';
import { buildAcpPromptBlocks } from './acp-prompt-blocks.js';
import { loginShell } from './shell-env.js';
import { countDiffLines, formatToolInput, formatToolOutput, stringifySummary } from './stream-adapters.js';
import { createWorkspaceBoundary } from './workspace-boundary.js';
import { antigravityToolLabel } from './antigravity-tool-labels.js';
import {
  antigravityConversationWork,
  antigravitySnapshotDbIdentity,
  antigravityStepCursor,
  antigravityTurnFailure,
} from './antigravity-turn-outcome.js';
import {
  ANTIGRAVITY_SUBAGENT_TOOLS,
  antigravityChildReport,
  antigravityChildState,
  antigravityPendingReply,
  resolveAntigravityChild,
} from './antigravity-child-work.js';
import {
  antigravityCommandOutlivesPrompt,
  antigravityEditDiff,
  antigravityIsDaemonTool,
  antigravitySecurityWarning,
  antigravityToolOutlivesPrompt,
  boundCommandLine,
  boundCommandText,
  boundQuestionText,
  readAntigravityPreEditFile,
  sanitizeAntigravityToolPayload,
} from './antigravity-protocol.js';
import { removeAntigravitySessionFiles } from './antigravity-session-files.js';
import { antigravityReasoningEffortForModel, antigravityWireModelId } from './models.js';

// ---------------------------------------------------------------------------
// Antigravity ACP driver. Runs Google's Antigravity CLI as `agy acp`
// (line-delimited JSON-RPC over stdio): supports persistent warm sessions
// across turns (skipping cold launch and session/load history replay),
// session/resume preference on reconnect, graceful session/cancel on Stop,
// native `_meta.antigravity.systemPrompt.append`, direct HTTP MCP when
// advertised, full multi-modal ACP attachments, interactive `interaction_*`
// and generalized JSON Schema elicitation questions, native `auto` review
// mode + interactive approval cards with `agy.security.warning`, pre-edit
// unified diff placement, payload sanitization, and bounded timeouts.
//
// Sign-in is agy's own (OS keyring): `agy` in a terminal, or
// `agy acp --login`. Orion never handles Google credentials.

export { ANTIGRAVITY_TOOL_LABELS, antigravityToolLabel } from './antigravity-tool-labels.js';

export const ANTIGRAVITY_HANDSHAKE_TIMEOUT_MS = 60_000;
export const ANTIGRAVITY_PROMPT_INACTIVITY_TIMEOUT_MS = 15 * 60_000;
export const ANTIGRAVITY_POST_SETTLE_COMMAND_HOLD_MS = 30 * 60_000;
export const ANTIGRAVITY_CANCEL_WAIT_MS = 1_500;
export const ANTIGRAVITY_TRANSIENT_MAX_RETRIES = 1;
export const ANTIGRAVITY_TRANSIENT_RETRY_DELAY_MS = 1_500;

// agy's raw tool inputs use PascalCase keys (CommandLine, Path,
// AbsolutePath, TargetFile, …); look them up case-insensitively.
const pickField = (record, names) => {
  if (!record || typeof record !== 'object') return undefined;
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(record)) {
    if (wanted.has(key.toLowerCase()) && typeof value === 'string' && value) return value;
  }
  return undefined;
};
const PATH_FIELDS = ['path', 'file_path', 'filepath', 'absolutepath', 'targetfile', 'target_file', 'file'];
const MUTATION_PATH_FIELDS = [
  ...PATH_FIELDS,
  'old_path',
  'new_path',
  'source',
  'destination',
];
const COMMAND_FIELDS = ['commandline', 'command', 'command_line'];
const QUERY_FIELDS = ['query', 'searchquery', 'url', 'pattern', 'searchpath', 'directorypath'];
const EDIT_TOOL_NAMES = new Set([
  'replace_file_content',
  'multi_replace_file_content',
  'edit_file',
  'write_file',
  'write_to_file',
]);

// The prompt response's usage is this turn's own; input excludes cache reads.
export const antigravityStatsFromPromptResult = (result) => {
  const usage = result?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const number = (value) => (Number.isFinite(value) ? value : 0);
  const inputTokens = number(usage.inputTokens);
  const outputTokens = number(usage.outputTokens);
  const cachedReadTokens = number(usage.cachedReadTokens);
  const reasoningTokens = number(usage.thoughtTokens);
  if (!inputTokens && !outputTokens && !cachedReadTokens) return null;
  return {
    inputTokens,
    outputTokens,
    cachedReadTokens,
    reasoningTokens,
    totalTokens:
      number(usage.totalTokens) || inputTokens + outputTokens + cachedReadTokens + reasoningTokens,
  };
};

// Sessions need agy 1.5 (its ACP model list, session/set_model, steering
// with a second session/prompt, and the permission flow this driver answers).
export const ANTIGRAVITY_MIN_VERSION = '1.5.0';
const versionParts = (value) => String(value || '').match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
export const antigravityVersionError = (version, minimumVersion = ANTIGRAVITY_MIN_VERSION) => {
  const found = versionParts(version);
  if (!found.length) return null;
  const minimum = versionParts(minimumVersion);
  for (let index = 0; index < 3; index += 1) {
    const a = found[index] ?? 0;
    const b = minimum[index] ?? 0;
    if (a > b) return null;
    if (a < b) {
      return `Antigravity ${version} is too old: Durango Code needs ${minimumVersion.replace(/\.0$/, '')} or newer. Update it in Settings → Providers, or run \`agy update\`.`;
    }
  }
  return null;
};

const SIGN_IN_HINT =
  'Sign in to Antigravity first: run `agy` in a terminal and finish the Google sign-in, then send the message again.';

const isAuthError = (error) =>
  error?.code === -32000 || /auth|sign.?in|log.?in|credential|unauthenticated/i.test(error?.message ?? '');

const errorMessage = (error, fallback) => {
  // Messages this driver composed are already complete sentences.
  if (typeof error === 'string') return error || fallback;
  if (isAuthError(error)) return SIGN_IN_HINT;
  return error?.message ? `Antigravity: ${error.message}` : fallback;
};

const extractAvailableModes = (setupResult) => {
  const fromModes = Array.isArray(setupResult?.modes?.availableModes)
    ? setupResult.modes.availableModes
        .map((mode) => (typeof mode?.id === 'string' ? mode.id : ''))
        .filter(Boolean)
    : [];
  if (fromModes.length) return fromModes;
  const modeOption = Array.isArray(setupResult?.configOptions)
    ? setupResult.configOptions.find((option) => option?.id === 'mode' || option?.category === 'mode')
    : null;
  if (modeOption?.type === 'select' && Array.isArray(modeOption.options)) {
    return modeOption.options
      .flatMap((entry) => ('value' in entry ? [entry.value] : Array.isArray(entry?.options) ? entry.options.map((o) => o?.value) : []))
      .filter((value) => typeof value === 'string' && value);
  }
  return [];
};

const supportsSystemPromptAppend = (agentCapabilities) =>
  agentCapabilities?._meta?.antigravity?.systemPrompt?.append === true;

const mergeFallbackSystemPrompt = (promptText, systemPromptAppend) => {
  const append = typeof systemPromptAppend === 'string' ? systemPromptAppend.trim() : '';
  if (!append) return promptText;
  const text = String(promptText ?? '');
  if (!text.trim()) return append;
  if (text.trimStart().startsWith('/')) {
    return `${text.trimStart()}\n\n${append}`;
  }
  return `${append}\n\n${text}`;
};

const normalizeSlashCommands = (commands) => {
  if (!Array.isArray(commands)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of commands) {
    const name = typeof entry?.name === 'string' ? entry.name.trim().replace(/^\/+/, '') : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const description = typeof entry?.description === 'string' ? entry.description.trim() : '';
    const argumentHint =
      typeof entry?.input?.hint === 'string'
        ? entry.input.hint.trim()
        : typeof entry?.argumentHint === 'string'
          ? entry.argumentHint.trim()
          : '';
    out.push({ name, description, argumentHint });
  }
  return out;
};

// Live drivers by runId: steering (agent:steerTurn), native questions &
// approvals (agent:getCodexQuestions / answerCodexQuestions), and cancel.
// Cleaned up in finalizeRun.
export const antigravityRunDrivers = new Map();

export const steerAntigravityRun = (runId, text, attachments) => {
  const driver = antigravityRunDrivers.get(runId);
  return driver ? driver.steer(text, attachments) : false;
};

export const cancelAntigravityRun = async (runId) => {
  const driver = antigravityRunDrivers.get(runId);
  if (!driver?.cancel) return false;
  return driver.cancel();
};

export const createAntigravityAcpDriver = ({
  child,
  cwd,
  model,
  reasoningEffort,
  promptText,
  systemPromptAppend = '',
  attachments = [],
  resumeSessionId,
  accessMode,
  mcpServers = [],
  httpMcpServers = [],
  threadId = null,
  sessionState = null,
  nextRequestId: externalNextRequestId = null,
  handshakeTimeoutMs = ANTIGRAVITY_HANDSHAKE_TIMEOUT_MS,
  promptInactivityTimeoutMs = ANTIGRAVITY_PROMPT_INACTIVITY_TIMEOUT_MS,
  postSettleCommandHoldMs = ANTIGRAVITY_POST_SETTLE_COMMAND_HOLD_MS,
  maxTransientRetries = ANTIGRAVITY_TRANSIENT_MAX_RETRIES,
  transientRetryDelayMs = ANTIGRAVITY_TRANSIENT_RETRY_DELAY_MS,
  callbacks,
}) => {
  let localNextRequestId = 1;
  const allocateRequestId = () =>
    typeof externalNextRequestId === 'function' ? externalNextRequestId() : localNextRequestId++;
  const pendingRequests = new Map();
  const toolCalls = new Map();
  // session/load replays the whole prior conversation as session/update
  // notifications before its response resolves; Orion keeps its own
  // transcript, so the replay is suppressed.
  let replayingSession = false;
  let textSeen = false;
  let pendingTextBreak = false;
  let activeSessionId = sessionState?.sessionId ?? null;
  let agentVersion = sessionState?.initialized?.agentVersion ?? null;
  let agentCapabilities = sessionState?.initialized?.agentCapabilities ?? null;
  let availableModes = Array.isArray(sessionState?.availableModes) ? [...sessionState.availableModes] : [];
  let nativeAutoModeActive = sessionState?.currentModeId === 'auto';
  let steeringSupported = Boolean(sessionState?.initialized && antigravityVersionError(agentVersion, '1.5.0') === null);
  let turnActive = false;
  let ended = false;
  let promptSequence = 0;
  let stepCursor = -1;
  let dbIdentity = null;
  // The session's last step before this process's first prompt: steps at or
  // before it belong to earlier runs (a killed run can leave one RUNNING).
  let runStepCursor = null;
  // Subagents launched this turn (by launch toolCallId) and the wait for
  // them after the prompt ends (see settleAfterPrompt).
  const children = new Map();
  let settleTimer = null;
  let settling = false;
  let replyOpen = false;
  // A non-daemon command or schedule was still running when a prompt ended:
  // when it finishes, agy wakes the model to carry on by itself.
  let workOutlivedPrompt = false;
  let commandHoldStartedAt = null;
  let lastUpdateAt = Date.now();
  let inactivityTimer = null;
  let cancelResolve = null;
  let transientRetryCount = 0;
  let lastSentPromptBlocks = null;
  let retryTimer = null;
  let retryWake = null;
  // Native questions & interactive approvals waiting on the user, by request id.
  const pendingUserInputs = new Map();
  const allConfiguredMcps = [...(Array.isArray(mcpServers) ? mcpServers : []), ...(Array.isArray(httpMcpServers) ? httpMcpServers : [])];
  const ambiguousOrionPrefix = allConfiguredMcps.some(
    (server) => typeof server?.name === 'string' && server.name !== 'orion' && server.name.startsWith('orion_')
  );
  // Bumped whenever a settle wait starts or stops, so a check that was
  // already reading files when a steer arrived can't end the steered turn.
  let settleGeneration = 0;
  const goalTurn = /^\s*\/goal\b/i.test(String(promptText || ''));
  // agy ends a finished /goal with `<!-- GOAL_COMPLETE -->`, which streams in
  // pieces: hold back a possible comment start until it closes or proves to
  // be ordinary text.
  let heldText = '';
  const stripGoalMarker = (chunk) => {
    if (!goalTurn) return chunk;
    let text = `${heldText}${chunk}`.replace(/\s*<!--\s*GOAL_COMPLETE\s*-->/g, '');
    heldText = '';
    const open = text.lastIndexOf('<!--');
    const partialOpen = /<(?:!(?:-)?)?$/.exec(text);
    let holdFrom = open !== -1 && !text.slice(open).includes('-->') ? open : partialOpen ? partialOpen.index : -1;
    // The whitespace before a marker goes with it.
    while (holdFrom > 0 && /\s/.test(text[holdFrom - 1])) holdFrom -= 1;
    if (holdFrom !== -1 && text.length - holdFrom < 64) {
      heldText = text.slice(holdFrom);
      text = text.slice(0, holdFrom);
    }
    return text;
  };

  const write = (message) => {
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {}
  };

  const request = (method, params, { timeoutMs = 0 } = {}) =>
    new Promise((resolve) => {
      const id = allocateRequestId();
      let timer = null;
      const done = (value) => {
        if (timer) clearTimeout(timer);
        timer = null;
        pendingRequests.delete(id);
        resolve(value);
      };
      pendingRequests.set(id, done);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          done({ error: { message: `Timed out waiting for Antigravity (${method}).` } });
        }, timeoutMs);
        timer.unref?.();
      }
      write({ jsonrpc: '2.0', id, method, params });
    });

  const buildActivity = (state) => {
    const activity = {
      key: state.id,
      type: state.kind === 'execute' ? 'command' : 'tool',
      title: state.title || antigravityToolLabel(state.toolName),
      status: state.status ?? 'running',
    };
    if (state.kind) activity.kind = state.kind;
    if (state.detail) activity.detail = state.detail;
    if (state.input) activity.input = state.input;
    if (state.output) activity.output = formatToolOutput(state.output);
    if (typeof state.exitCode === 'number') activity.exitCode = state.exitCode;
    if (state.diff) activity.diff = state.diff;
    return activity;
  };

  // Terminal output can update many times a second; throttle output-only
  // refreshes, but always emit status changes immediately.
  const TOOL_EMIT_INTERVAL_MS = 130;
  const emitToolActivity = (state, immediate) => {
    const send = () => {
      state.emitTimer = null;
      state.lastEmitAt = Date.now();
      callbacks.onActivity(buildActivity(state));
    };
    if (immediate || Date.now() - (state.lastEmitAt ?? 0) >= TOOL_EMIT_INTERVAL_MS) {
      if (state.emitTimer) {
        clearTimeout(state.emitTimer);
        state.emitTimer = null;
      }
      send();
      return;
    }
    if (!state.emitTimer) state.emitTimer = setTimeout(send, TOOL_EMIT_INTERVAL_MS);
  };

  const flushToolEmits = () => {
    for (const state of toolCalls.values()) {
      if (state.emitTimer) {
        clearTimeout(state.emitTimer);
        state.emitTimer = null;
        callbacks.onActivity(buildActivity(state));
      }
    }
  };

  const refreshToolPresentation = (state) => {
    const label = antigravityToolLabel(state.toolName);
    if (state.kind === 'execute' && state.command) {
      state.title = `Command - ${stringifySummary(state.command, 80)}`;
      state.detail = state.command;
    } else if (state.filePath) {
      state.title = `${label} - ${stringifySummary(state.filePath, 80)}`;
      state.detail = state.filePath;
    } else if (state.query) {
      state.title = `${label} - ${stringifySummary(state.query, 80)}`;
      state.detail = state.query;
    } else if (state.subagentRole) {
      state.title = `Subagent - ${stringifySummary(state.subagentRole, 80)}`;
    } else if (state.summary) {
      state.title = `${label} - ${stringifySummary(state.summary, 80)}`;
    } else {
      state.title = label;
    }
  };

  const upsertToolCall = (update) => {
    const id = update.toolCallId;
    if (typeof id !== 'string' || !id) return;
    const created = !toolCalls.has(id);
    let state = toolCalls.get(id);
    if (!state) {
      state = { id, status: 'running' };
      toolCalls.set(id, state);
    }
    const previousStatus = state.status;

    if (typeof update.name === 'string' && update.name) state.toolName = update.name;
    if (typeof update.title === 'string' && update.title) state.rawTitle = update.title;
    if (update.kind) state.kind = update.kind === 'write' ? 'edit' : update.kind;
    if (ANTIGRAVITY_SUBAGENT_TOOLS.has(state.toolName) && !children.has(id) && update._meta?.is_mcp_tool_call !== true) {
      const launch = update.rawInput ?? update.args ?? {};
      const role = pickField(launch, ['role']) || 'Antigravity subagent';
      const childPrompt = pickField(launch, ['prompt']) || '';
      children.set(id, { id, role, prompt: childPrompt, childId: null, done: false, launchedAt: Date.now() });
      state.subagentRole = role;
      callbacks.onSubagentSpawn?.({ id, role, prompt: childPrompt, parentSessionId: activeSessionId });
    }

    const rawInput = update.rawInput ?? update.args;
    if (rawInput && typeof rawInput === 'object') {
      const sanitizedInput = sanitizeAntigravityToolPayload(rawInput);
      state.rawInput = sanitizedInput && typeof sanitizedInput === 'object' ? sanitizedInput : rawInput;
      state.input = formatToolInput(state.rawInput);
      const command = pickField(rawInput, COMMAND_FIELDS);
      if (command) state.command = boundCommandLine(command);
      const filePath = pickField(rawInput, PATH_FIELDS);
      if (filePath) state.filePath = filePath;
      const query = pickField(rawInput, QUERY_FIELDS);
      if (query) state.query = query;
      const summary = pickField(rawInput, ['toolSummary']);
      if (summary) state.summary = summary;
    }
    if (!state.filePath) {
      const location = (Array.isArray(update.locations) ? update.locations : []).find(
        (entry) => typeof entry?.path === 'string' && entry.path
      );
      if (location) state.filePath = location.path;
    }

    // Build a pre-edit unified diff with real line numbers while the edit is
    // still pending/in_progress (before the file on disk is overwritten).
    const isEditCall =
      state.kind === 'edit' || (typeof state.toolName === 'string' && EDIT_TOOL_NAMES.has(state.toolName));
    if (
      isEditCall &&
      state.filePath &&
      rawInput &&
      typeof rawInput === 'object' &&
      !state.diff?.patch &&
      (update.status === 'pending' || update.status === 'in_progress' || created)
    ) {
      const computed = antigravityEditDiff({
        path: state.filePath,
        rawInput,
        locations: update.locations,
        readPreEditFile:
          update.status === 'pending' || created
            ? (targetPath) => readAntigravityPreEditFile(targetPath, cwd)
            : null,
      });
      if (computed) {
        state.diff = {
          path: computed.path,
          additions: computed.additions,
          deletions: computed.deletions,
          ...(computed.patch ? { patch: computed.patch } : {}),
        };
      }
    }

    if (Array.isArray(update.content)) {
      for (const entry of update.content) {
        if (entry?.type === 'diff' && typeof entry.path === 'string') {
          state.filePath = state.filePath ?? entry.path;
          const existingPatch = state.diff?.patch;
          state.diff = {
            path: entry.path,
            additions: countDiffLines(entry.newText),
            deletions: countDiffLines(entry.oldText),
            ...(existingPatch ? { patch: existingPatch } : {}),
          };
        }
        if (entry?.type === 'content' && typeof entry.content?.text === 'string' && entry.content.text) {
          state.output = boundCommandText(entry.content.text);
        }
      }
    }

    const rawOutput = update.rawOutput;
    if (typeof rawOutput === 'string' && rawOutput.trim()) {
      state.output = boundCommandText(rawOutput);
    } else if (rawOutput && typeof rawOutput === 'object') {
      const sanitizedOutput = sanitizeAntigravityToolPayload(rawOutput);
      const outputRecord = sanitizedOutput && typeof sanitizedOutput === 'object' ? sanitizedOutput : rawOutput;
      const exitCode = outputRecord.exit_code ?? outputRecord.exitCode;
      if (typeof exitCode === 'number') state.exitCode = exitCode;
      const textOut =
        outputRecord.output ?? outputRecord.combinedOutput ?? outputRecord.combined_output;
      if (typeof textOut === 'string' && textOut.trim()) state.output = boundCommandText(textOut);
    }

    if (update.status === 'completed') state.status = 'done';
    else if (update.status === 'failed' || update.status === 'cancelled') state.status = 'error';
    else if (update.status === 'pending' || update.status === 'in_progress') {
      if (state.status !== 'error') state.status = 'running';
    }
    if (typeof state.exitCode === 'number' && state.exitCode !== 0) state.status = 'error';
    // A launch that failed (or was denied) never starts a child to wait for.
    if (state.status === 'error' && children.has(id) && !children.get(id).done) {
      markChildDone(children.get(id), { status: 'error' });
    }

    refreshToolPresentation(state);
    emitToolActivity(state, created || state.status !== previousStatus);
  };

  const handlePlanUpdate = (entries) => {
    const list = Array.isArray(entries) ? entries : [];
    const total = list.length;
    const completed = list.filter((entry) => entry?.status === 'completed').length;
    const active = list.find((entry) => entry?.status === 'in_progress');
    callbacks.onActivity({
      key: 'plan',
      type: 'plan',
      kind: 'plan',
      title: active
        ? `Tasks (${completed}/${total}) - ${stringifySummary(active.content, 60)}`
        : `Tasks (${completed}/${total})`,
      status: total > 0 && completed === total ? 'done' : 'running',
      plan: list.map((entry) => ({
        content: String(entry?.content ?? ''),
        status:
          entry?.status === 'completed'
            ? 'completed'
            : entry?.status === 'in_progress'
              ? 'in_progress'
              : 'pending',
      })),
    });
  };

  // agy asks multiple-choice questions over session/request_permission with an
  // `interaction_` toolCallId; the options are answers, not approvals. When an
  // interactive UI listener is attached (`callbacks.onUserInput`), surface it as
  // an inline question card and answer within the same turn; when unattended,
  // record it in the transcript and cancel so the user can answer next turn.
  const answerQuestion = (message) => {
    const params = message.params ?? {};
    const toolCall = params.toolCall ?? {};
    const rawOptions = Array.isArray(params.options) ? params.options : [];
    const questionText = boundQuestionText(
      pickField(toolCall.rawInput, ['question', 'prompt', 'message']) ||
        (typeof toolCall.title === 'string' && toolCall.title.trim()) ||
        'Antigravity asked a question.',
      8_000
    );
    const validOptions = [];
    const seenIds = new Set();
    for (const option of rawOptions) {
      const optionId = typeof option?.optionId === 'string' ? option.optionId.trim() : '';
      if (!optionId || seenIds.has(optionId)) continue;
      seenIds.add(optionId);
      const label = boundQuestionText(String(option?.name || optionId).trim() || optionId, 512);
      validOptions.push({ optionId, label });
    }

    if (callbacks.onUserInput && validOptions.length > 0 && !ended) {
      const questionId = toolCall.toolCallId || `interaction_${message.id}`;
      pendingUserInputs.set(message.id, {
        id: message.id,
        kind: 'permission-question',
        questionId,
        options: validOptions,
        questions: [
          {
            id: questionId,
            header: 'Question',
            question: questionText,
            multiSelect: false,
            allowCustom: false,
            options: validOptions.map((option) => ({ label: option.label, description: '' })),
          },
        ],
      });
      callbacks.onUserInput();
      return;
    }

    const choices = validOptions.map((option) => option.label);
    write({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } });
    callbacks.onActivity({
      key: toolCall.toolCallId || `question:${message.id}`,
      type: 'tool',
      kind: 'other',
      title: `Question - ${stringifySummary(questionText, 80)}`,
      detail: questionText,
      status: 'done',
      output: `${questionText}${choices.length ? `\n\nOptions:\n${choices.map((choice) => `- ${choice}`).join('\n')}` : ''}\n\nAnswer in your next message.`,
    });
  };

  // Parse ACP `elicitation/create` form schemas: supports agy 1.5's `qN` +
  // `qN_other` pattern as well as general JSON Schema properties (`oneOf`,
  // `anyOf`, `enum`, `string`, `boolean`, `number`/`integer`, `*__other`).
  const parseElicitation = (params) => {
    const schema = params?.requestedSchema;
    const properties = schema?.properties;
    if (!properties || typeof properties !== 'object') return null;
    const requiredSet = new Set(
      Array.isArray(schema.required) ? schema.required.filter((k) => typeof k === 'string') : []
    );

    const isAllowedConst = (value) =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

    const extractOptions = (entries) =>
      (Array.isArray(entries) ? entries : [])
        .filter((entry) => entry && isAllowedConst(entry.const))
        .map((entry) => ({
          value: entry.const,
          key: String(entry.const),
          label: boundQuestionText(String(entry.title ?? entry.const), 512),
          description: typeof entry.description === 'string' ? boundQuestionText(entry.description, 512) : '',
        }));

    const extractEnumOptions = (entries) =>
      (Array.isArray(entries) ? entries : [])
        .filter((entry) => isAllowedConst(entry))
        .map((entry) => {
          const text = boundQuestionText(String(entry), 512);
          return { value: entry, key: String(entry), label: text, description: '' };
        });

    const extractSchemaChoiceOptions = (schemaNode) => {
      if (!schemaNode || typeof schemaNode !== 'object') return [];
      if (Array.isArray(schemaNode.oneOf)) return extractOptions(schemaNode.oneOf);
      if (Array.isArray(schemaNode.anyOf)) return extractOptions(schemaNode.anyOf);
      if (Array.isArray(schemaNode.enum)) return extractEnumOptions(schemaNode.enum);
      return [];
    };

    // Identify companion `*_other` / `*__other` text fields only for choice/array
    // parents so unrelated scalar fields ending in `_other` are never hidden.
    const isChoiceParent = (prop) =>
      Boolean(
        prop &&
          typeof prop === 'object' &&
          (prop.type === 'array' ||
            Array.isArray(prop.oneOf) ||
            Array.isArray(prop.anyOf) ||
            Array.isArray(prop.enum))
      );
    const companions = new Map();
    const folded = new Set();
    for (const [key, prop] of Object.entries(properties)) {
      if (!isChoiceParent(prop)) continue;
      for (const suffix of ['_other', '__other']) {
        const companionKey = `${key}${suffix}`;
        const companion = properties[companionKey];
        if (companion && typeof companion === 'object' && companion.type === 'string') {
          companions.set(key, companionKey);
          folded.add(companionKey);
          break;
        }
      }
    }

    const questions = [];
    const fields = new Map();
    for (const [key, property] of Object.entries(properties)) {
      if (folded.has(key) || !property || typeof property !== 'object') continue;
      const companionKey = companions.get(key) ?? null;
      const isRequired = requiredSet.has(key);
      const header = boundQuestionText(
        typeof property.title === 'string' && property.title.trim() ? property.title.trim() : 'Question',
        256
      );
      const questionPrompt = boundQuestionText(
        String(
          (typeof property.description === 'string' && property.description.trim()) ||
            (typeof property.title === 'string' && property.title.trim()) ||
            params.message ||
            'Antigravity has a question.'
        ),
        8_000
      );

      if (property.type === 'array') {
        const items = property.items ?? {};
        const options = extractSchemaChoiceOptions(items);
        if (!options.length && !companionKey) continue;
        const minItems = typeof property.minItems === 'number' ? property.minItems : 0;
        const maxItems = typeof property.maxItems === 'number' ? property.maxItems : Infinity;
        if (maxItems === 0 || minItems > maxItems) continue;
        fields.set(key, {
          kind: 'multiChoice',
          options,
          minItems,
          maxItems,
          companionKey,
          required: isRequired,
        });
        questions.push({
          id: key,
          header: /^q\d+$/.test(key) ? 'Question' : header,
          question: /^q\d+$/.test(key)
            ? boundQuestionText(String(property.title || params.message || 'Antigravity has a question.'), 8_000)
            : questionPrompt,
          multiSelect: true,
          allowCustom: Boolean(companionKey),
          required: isRequired && minItems > 0,
          options: options.map((option) => ({ label: option.label, description: option.description })),
        });
      } else if (property.type === 'boolean') {
        const options = [
          { value: true, key: 'true', label: 'Yes', description: '' },
          { value: false, key: 'false', label: 'No', description: '' },
        ];
        fields.set(key, { kind: 'boolean', options, companionKey: null, required: isRequired });
        questions.push({
          id: key,
          header,
          question: questionPrompt,
          multiSelect: false,
          allowCustom: false,
          required: isRequired,
          options: options.map((option) => ({ label: option.label, description: '' })),
        });
      } else {
        const choiceOptions = extractSchemaChoiceOptions(property);
        if (choiceOptions.length > 0) {
          fields.set(key, {
            kind: 'choice',
            options: choiceOptions,
            companionKey,
            required: isRequired,
          });
          questions.push({
            id: key,
            header: /^q\d+$/.test(key) ? 'Question' : header,
            question: /^q\d+$/.test(key)
              ? boundQuestionText(String(property.title || params.message || 'Antigravity has a question.'), 8_000)
              : questionPrompt,
            multiSelect: false,
            allowCustom: Boolean(companionKey),
            required: isRequired,
            options: choiceOptions.map((option) => ({ label: option.label, description: option.description })),
          });
        } else if (property.type === 'string') {
          fields.set(key, {
            kind: 'text',
            options: [],
            companionKey: null,
            required: isRequired,
            minLength: typeof property.minLength === 'number' ? property.minLength : undefined,
            maxLength: typeof property.maxLength === 'number' ? property.maxLength : undefined,
          });
          questions.push({
            id: key,
            header,
            question: questionPrompt,
            multiSelect: false,
            allowCustom: true,
            required: isRequired,
            options: [],
          });
        } else if (property.type === 'number' || property.type === 'integer') {
          fields.set(key, {
            kind: 'number',
            integer: property.type === 'integer',
            minimum: typeof property.minimum === 'number' ? property.minimum : undefined,
            maximum: typeof property.maximum === 'number' ? property.maximum : undefined,
            exclusiveMinimum:
              typeof property.exclusiveMinimum === 'number' ? property.exclusiveMinimum : undefined,
            exclusiveMaximum:
              typeof property.exclusiveMaximum === 'number' ? property.exclusiveMaximum : undefined,
            options: [],
            companionKey: null,
            required: isRequired,
          });
          questions.push({
            id: key,
            header,
            question: questionPrompt,
            multiSelect: false,
            allowCustom: true,
            required: isRequired,
            options: [],
          });
        }
      }
    }
    return questions.length ? { questions, fields } : null;
  };

  const answerElicitation = (message) => {
    const parsed = parseElicitation(message.params);
    if (!parsed || !callbacks.onUserInput || ended) {
      write({ jsonrpc: '2.0', id: message.id, result: { action: 'decline' } });
      return;
    }
    pendingUserInputs.set(message.id, { id: message.id, kind: 'elicitation', ...parsed });
    callbacks.onUserInput();
  };

  const getUserInputs = () =>
    [...pendingUserInputs.values()].map((entry) => ({
      providerId: 'antigravity',
      requestId: entry.id,
      threadId,
      questions: entry.questions,
      ...(entry.approval ? { approval: entry.approval } : {}),
    }));

  // `answers`: per question id, the picked labels and/or typed text.
  const answerUserInput = (requestId, answers) => {
    const pending = pendingUserInputs.get(requestId);
    if (!pending || ended || !answers || typeof answers !== 'object') return false;

    if (pending.kind === 'permission-question') {
      const raw = Array.isArray(answers[pending.questionId])
        ? answers[pending.questionId].map((v) => String(v).trim()).filter(Boolean)
        : [];
      const chosenValue = raw[0];
      if (!chosenValue) return false;
      const option =
        pending.options.find((entry) => entry.optionId === chosenValue) ??
        pending.options.find((entry) => entry.label === chosenValue);
      if (!option) return false;
      write({
        jsonrpc: '2.0',
        id: requestId,
        result: { outcome: { outcome: 'selected', optionId: option.optionId } },
      });
      pendingUserInputs.delete(requestId);
      lastUpdateAt = Date.now();
      callbacks.onUserInput?.();
      return true;
    }

    if (pending.kind === 'permission-approval') {
      const raw = Array.isArray(answers.permission) ? answers.permission : [];
      const decision = String(raw[0] ?? '').trim();
      let chosenOption = null;
      let allowed = false;
      if (decision === 'Allow for this thread' && pending.allowAlways) {
        chosenOption = pending.allowAlways;
        allowed = true;
      } else if (decision === 'Allow once' && pending.allowOnce) {
        chosenOption = pending.allowOnce;
        allowed = true;
      } else if (decision === 'Deny') {
        chosenOption = pending.rejectOnce ?? null;
        allowed = false;
      } else {
        return false;
      }
      write(
        chosenOption
          ? {
              jsonrpc: '2.0',
              id: requestId,
              result: { outcome: { outcome: 'selected', optionId: chosenOption.optionId } },
            }
          : { jsonrpc: '2.0', id: requestId, result: { outcome: { outcome: 'cancelled' } } }
      );
      pendingUserInputs.delete(requestId);
      if (pending.toolState) {
        pending.toolState.status = allowed ? 'running' : 'error';
        if (!allowed) pending.toolState.output = 'Denied by user.';
        emitToolActivity(pending.toolState, true);
      }
      lastUpdateAt = Date.now();
      callbacks.onUserInput?.();
      return true;
    }

    // Elicitation form — validate every field against the requested schema
    // before accepting and clearing the pending question.
    const content = {};
    for (const question of pending.questions) {
      const field = pending.fields.get(question.id);
      const values = Array.isArray(answers[question.id])
        ? answers[question.id].map((value) => String(value).trim()).filter(Boolean)
        : [];
      if (!values.length) {
        if (field.kind === 'multiChoice' && field.required) {
          if (field.minItems > 0) return false;
          content[question.id] = [];
          continue;
        }
        if (field.required) return false;
        continue;
      }
      if (field.kind === 'text') {
        const textValue = values.join('\n');
        if (field.minLength !== undefined && textValue.length < field.minLength) return false;
        if (field.maxLength !== undefined && textValue.length > field.maxLength) return false;
        content[question.id] = textValue;
      } else if (field.kind === 'boolean') {
        const lower = values[0].toLowerCase();
        if (lower === 'yes' || lower === 'true') content[question.id] = true;
        else if (lower === 'no' || lower === 'false') content[question.id] = false;
        else return false;
      } else if (field.kind === 'number') {
        const parsed = Number(values[0]);
        if (!Number.isFinite(parsed) || (field.integer && !Number.isInteger(parsed))) return false;
        if (field.minimum !== undefined && parsed < field.minimum) return false;
        if (field.maximum !== undefined && parsed > field.maximum) return false;
        if (field.exclusiveMinimum !== undefined && parsed <= field.exclusiveMinimum) return false;
        if (field.exclusiveMaximum !== undefined && parsed >= field.exclusiveMaximum) return false;
        content[question.id] = parsed;
      } else {
        const picked = [];
        const typed = [];
        for (const value of values) {
          const option = field.options.find((entry) => entry.label === value || entry.key === value);
          if (option) picked.push(option.value);
          else typed.push(value);
        }
        if (typed.length && !field.companionKey) return false;
        if (field.kind === 'multiChoice') {
          if (picked.length) {
            if (picked.length < field.minItems || picked.length > field.maxItems) return false;
            content[question.id] = picked;
          } else if (field.required) {
            if (field.minItems > 0) return false;
            content[question.id] = [];
          }
        } else {
          if (picked.length > 1) return false;
          if (picked.length === 1) {
            content[question.id] = picked[0];
          } else if (field.required && !typed.length) {
            return false;
          }
        }
        if (typed.length && field.companionKey) {
          content[field.companionKey] = typed.join(', ');
        }
      }
    }
    write({ jsonrpc: '2.0', id: requestId, result: { action: 'accept', content } });
    pendingUserInputs.delete(requestId);
    // The turn continues inside the same prompt.
    lastUpdateAt = Date.now();
    callbacks.onUserInput?.();
    return true;
  };

  const cancelUserInputs = () => {
    if (!pendingUserInputs.size) return;
    for (const [id, pending] of pendingUserInputs.entries()) {
      if (pending.kind === 'elicitation') {
        write({ jsonrpc: '2.0', id, result: { action: 'cancel' } });
      } else {
        write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
      }
    }
    pendingUserInputs.clear();
    callbacks.onUserInput?.();
  };

  // Approvals are answered by access-mode policy:
  // - Full access allows everything.
  // - Read only allows read-only & preapproved Orion tools; denies everything else.
  // - Workspace write allows read-only, Orion tools, and inside-workspace file edits;
  //   commands / outside-workspace edits prompt interactively when `onUserInput`
  //   is attached (or auto-deny when unattended).
  // - Auto runs agy in native `auto` review mode (when advertised), auto-allows
  //   preapproved Orion tools, and routes escalated approvals to `ApprovalCard`
  //   when interactive (or auto-denies when unattended).
  const { isInsideWorkspace } = createWorkspaceBoundary(cwd);
  const mutationTargets = (toolCall, known) => {
    const targets = [];
    const pushFrom = (record) => {
      if (!record || typeof record !== 'object') return;
      const wanted = new Set(MUTATION_PATH_FIELDS);
      for (const [key, value] of Object.entries(record)) {
        if (wanted.has(key.toLowerCase()) && typeof value === 'string' && value) targets.push(value);
      }
    };
    pushFrom(toolCall.rawInput ?? toolCall.args);
    for (const location of Array.isArray(toolCall.locations) ? toolCall.locations : []) {
      if (typeof location?.path === 'string' && location.path) targets.push(location.path);
    }
    for (const entry of Array.isArray(toolCall.content) ? toolCall.content : []) {
      if (entry?.type === 'diff' && typeof entry.path === 'string' && entry.path) targets.push(entry.path);
    }
    if (!targets.length && typeof known?.filePath === 'string' && known.filePath) {
      targets.push(known.filePath);
    }
    return targets;
  };

  const buildAntigravityApprovalView = (toolCall, known, { reason, warning, allowForThread }) => {
    const rawInput = toolCall.rawInput ?? toolCall.args ?? known?.rawInput ?? {};
    const toolName =
      (typeof toolCall.name === 'string' && toolCall.name) || known?.toolName || 'tool';
    const command = pickField(rawInput, COMMAND_FIELDS) || known?.command;
    const filePath = pickField(rawInput, PATH_FIELDS) || known?.filePath;
    const url = pickField(rawInput, ['url']);
    const title =
      (typeof toolCall.title === 'string' && toolCall.title.trim()) ||
      (command
        ? 'Antigravity wants to run a command'
        : filePath
          ? `Antigravity wants to edit ${path.basename(filePath)}`
          : `Antigravity wants to use ${antigravityToolLabel(toolName)}`);
    const sanitized = sanitizeAntigravityToolPayload(rawInput);
    const inputText =
      sanitized && typeof sanitized === 'object' && Object.keys(sanitized).length
        ? JSON.stringify(sanitized, null, 2)
        : undefined;
    return {
      toolName,
      title,
      ...(reason ? { reason } : {}),
      ...(warning ? { warning } : {}),
      ...(allowForThread ? { allowForThread: true } : {}),
      ...(command ? { command: boundCommandLine(command) } : {}),
      ...(filePath ? { path: filePath } : {}),
      ...(url ? { url } : {}),
      ...(!command && !filePath && !url && inputText ? { input: inputText } : {}),
    };
  };

  const answerPermission = (message) => {
    const params = message.params ?? {};
    const toolCall = params.toolCall ?? {};
    if (typeof toolCall.toolCallId === 'string' && toolCall.toolCallId.startsWith('interaction_')) {
      return answerQuestion(message);
    }
    const known = typeof toolCall.toolCallId === 'string' ? toolCalls.get(toolCall.toolCallId) : null;
    const toolName =
      (typeof toolCall.name === 'string' && toolCall.name) || known?.toolName || '';
    const kind = toolCall.kind ?? known?.kind;
    const readOnly = kind === 'read' || kind === 'search' || kind === 'fetch' || kind === 'think';
    // Orion's own MCP tools are safe in every mode.
    // agy names MCP tools `mcp_<server>_<tool>` (or puts ServerName/ToolName in rawInput).
    const rawInput = toolCall.rawInput ?? toolCall.args;
    const isOrionByName =
      toolName.startsWith('mcp_orion_') &&
      !ambiguousOrionPrefix &&
      isPreapprovedOrionTool(toolName.slice('mcp_orion_'.length), accessMode);
    const isOrionByInput =
      rawInput?.ServerName === 'orion' &&
      typeof rawInput?.ToolName === 'string' &&
      !ambiguousOrionPrefix &&
      isPreapprovedOrionTool(rawInput.ToolName, accessMode);
    const isOrionTool = isOrionByName || isOrionByInput;

    const allOptions = Array.isArray(params.options) ? params.options : [];
    const onceOptions = allOptions.filter(
      (option) =>
        option?.kind !== 'allow_always' &&
        option?.kind !== 'reject_always' &&
        !/always/i.test(`${option?.optionId ?? ''} ${option?.name ?? ''}`)
    );
    const pick = (list, wanted, pattern) =>
      list.find((option) => option?.kind === wanted) ??
      list.find((option) => pattern.test(`${option?.optionId ?? ''} ${option?.name ?? ''}`));
    const allowOnce = pick(onceOptions, 'allow_once', /allow|approve|yes/i);
    const allowAlways = allOptions.find((option) => option?.kind === 'allow_always' && option?.optionId);
    const rejectOnce = pick(onceOptions, 'reject_once', /reject|deny|no/i);

    let decision = 'deny'; // 'allow' | 'ask' | 'deny'
    let denialDetail = "mode doesn't permit this tool.";
    const effectiveAutoReview = accessMode === 'auto' && nativeAutoModeActive;
    if (isOrionTool || accessMode === 'full-access') {
      decision = 'allow';
    } else if (effectiveAutoReview) {
      // agy's native Auto already reviewed what it sent here: escalate to the
      // user when interactive, or auto-deny when unattended.
      decision = callbacks.onUserInput ? 'ask' : 'deny';
      denialDetail = 'mode requires your approval for this action.';
    } else if (accessMode !== 'workspace-write' && accessMode !== 'auto') {
      decision = readOnly ? 'allow' : 'deny';
    } else if (readOnly) {
      decision = 'allow';
    } else if (kind === 'edit' || kind === 'delete' || kind === 'move') {
      const targets = mutationTargets(toolCall, known);
      const inside = targets.length > 0 && targets.every(isInsideWorkspace);
      if (inside) {
        decision = 'allow';
      } else {
        decision = callbacks.onUserInput ? 'ask' : 'deny';
        denialDetail = targets.length
          ? 'mode only permits file changes inside the workspace.'
          : 'mode requires a known target path for file changes.';
      }
    } else {
      decision = callbacks.onUserInput ? 'ask' : 'deny';
    }

    if (decision === 'ask' && callbacks.onUserInput && !ended && allowOnce) {
      const warning = allowAlways ? antigravitySecurityWarning(allowAlways) : undefined;
      const reason =
        effectiveAutoReview
          ? 'Antigravity Auto review flagged this call for your approval.'
          : `Workspace write ${denialDetail}`;
      const approval = buildAntigravityApprovalView(toolCall, known, {
        reason,
        warning,
        allowForThread: Boolean(allowAlways),
      });
      if (known) {
        known.status = 'waiting';
        emitToolActivity(known, true);
      }
      pendingUserInputs.set(message.id, {
        id: message.id,
        kind: 'permission-approval',
        allowOnce,
        allowAlways: allowAlways ?? null,
        rejectOnce: rejectOnce ?? null,
        toolState: known,
        approval,
        questions: [
          {
            id: 'permission',
            header: antigravityToolLabel(toolName),
            question: approval.title,
            allowCustom: false,
            options: [
              { label: 'Allow once', description: 'Approve this call only.' },
              ...(allowAlways
                ? [{ label: 'Allow for this thread', description: warning || 'Approve similar calls for this thread.' }]
                : []),
              { label: 'Deny', description: 'Do not run this tool call.' },
            ],
          },
        ],
      });
      callbacks.onUserInput();
      return;
    }

    const allow = decision === 'allow';
    const chosen = allow ? allowOnce : rejectOnce;
    write(
      chosen
        ? {
            jsonrpc: '2.0',
            id: message.id,
            result: { outcome: { outcome: 'selected', optionId: chosen.optionId } },
          }
        : { jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } }
    );

    if (!allow && known) {
      known.status = 'error';
      known.output = `Skipped — ${
        accessMode === 'read-only'
          ? 'Read only'
          : accessMode === 'auto'
            ? 'Auto'
            : 'Workspace write'
      } ${denialDetail} Switch to Full Access to allow it.`;
      emitToolActivity(known, true);
    }
  };

  const clearInactivityTimer = () => {
    if (!inactivityTimer) return;
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  };

  const hasActiveWorkForInactivity = () => {
    if (pendingUserInputs.size > 0) return true;
    for (const state of toolCalls.values()) {
      if ((state.status === 'running' || state.status === 'waiting') && !antigravityIsDaemonTool(state)) {
        return true;
      }
    }
    for (const child of children.values()) {
      if (!child.done) return true;
    }
    return false;
  };

  const armInactivityTimer = () => {
    clearInactivityTimer();
    if (ended || !turnActive || settling || !(promptInactivityTimeoutMs > 0)) return;
    const elapsed = Date.now() - lastUpdateAt;
    const remaining = Math.max(10, promptInactivityTimeoutMs - elapsed);
    inactivityTimer = setTimeout(() => {
      inactivityTimer = null;
      if (ended || !turnActive || settling) return;
      if (hasActiveWorkForInactivity()) {
        lastUpdateAt = Date.now();
        armInactivityTimer();
        return;
      }
      if (Date.now() - lastUpdateAt < promptInactivityTimeoutMs) {
        armInactivityTimer();
        return;
      }
      fail(
        'Antigravity stopped responding during this turn. Send your message again to continue.',
        'Antigravity prompt timed out.'
      );
    }, remaining);
    inactivityTimer.unref?.();
  };

  const stopSettling = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    settling = false;
    commandHoldStartedAt = null;
    settleGeneration += 1;
  };

  const flushHeldText = () => {
    if (heldText && !/^\s*<!--\s*GOAL_COMPLETE/.test(heldText)) callbacks.onText(heldText);
    heldText = '';
  };

  const resolvePendingRequests = () => {
    for (const resolve of pendingRequests.values()) resolve({ error: { message: 'Antigravity run ended.' } });
    pendingRequests.clear();
  };

  const cancelPendingRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    const wake = retryWake;
    retryWake = null;
    wake?.(false);
  };

  const fail = (error, fallback = 'Antigravity agent protocol error.', meta = null) => {
    if (ended) return;
    ended = true;
    turnActive = false;
    cancelPendingRetry();
    clearInactivityTimer();
    stopSettling();
    cancelUserInputs();
    flushToolEmits();
    flushHeldText();
    callbacks.onFatal(errorMessage(error, fallback), meta ?? undefined);
    resolvePendingRequests();
    cancelResolve?.(false);
    cancelResolve = null;
  };

  // The run was stopped or its process went away: stop every wait and timer
  // without reporting anything more for it.
  const dispose = () => {
    if (ended) return;
    ended = true;
    turnActive = false;
    cancelPendingRetry();
    clearInactivityTimer();
    stopSettling();
    pendingUserInputs.clear();
    resolvePendingRequests();
    cancelResolve?.(true);
    cancelResolve = null;
  };

  // Graceful ACP cancellation on Stop: send `session/cancel` and wait briefly
  // for the running prompt to wind down before the caller tears down.
  const cancel = async () => {
    if (ended) return true;
    if (!activeSessionId || !turnActive || settling) {
      dispose();
      return true;
    }
    write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: activeSessionId } });
    const settled = await new Promise((resolve) => {
      cancelResolve = resolve;
      const timer = setTimeout(() => {
        if (cancelResolve === resolve) cancelResolve = null;
        resolve(false);
      }, ANTIGRAVITY_CANCEL_WAIT_MS);
      timer.unref?.();
    });
    dispose();
    return settled;
  };

  const chooseMcpServers = () => {
    const useHttp =
      agentCapabilities?.mcpCapabilities?.http === true &&
      Array.isArray(httpMcpServers) &&
      httpMcpServers.length > 0;
    return useHttp ? httpMcpServers : mcpServers;
  };

  // Follow the ACP baseline: only emit media/embedded resource blocks that the
  // runtime explicitly advertised in `initialize`.
  const resolvePromptCapabilities = () =>
    agentCapabilities?.promptCapabilities ?? { image: false, audio: false, embeddedContext: false };

  const start = async () => {
    const handshake = { timeoutMs: handshakeTimeoutMs };
    let reusedProcess = Boolean(sessionState?.initialized);
    if (!reusedProcess) {
      const init = await request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            // Questions come over elicitation only when someone can answer them.
            ...(callbacks.onUserInput ? { elicitation: { form: {} } } : {}),
          },
          clientInfo: { name: 'durango-code', version: '1' },
        },
        handshake
      );
      if (init.error) return fail(init.error);
      agentVersion = init.result?.agentInfo?.version ?? null;
      agentCapabilities = init.result?.agentCapabilities ?? {};
      const versionError = antigravityVersionError(agentVersion);
      if (versionError) return fail(versionError);
      const unsupported = mcpServers.filter((server) => server?.type === 'http');
      if (agentCapabilities?.mcpCapabilities?.http !== true && unsupported.length) {
        return fail(
          `This provider does not support HTTP MCP servers: ${unsupported.map((server) => `@${server.name}`).join(', ')}. Switch providers, or switch these MCPs off and remove their thread attachments.`
        );
      }
      if (sessionState) {
        sessionState.initialized = { agentVersion, agentCapabilities };
      }
    }

    const activeMcpServers = chooseMcpServers();
    const trimmedSystemPromptAppend =
      typeof systemPromptAppend === 'string' ? systemPromptAppend.trim() : '';
    const canAppendSystemPrompt =
      Boolean(trimmedSystemPromptAppend) && supportsSystemPromptAppend(agentCapabilities);
    const sessionMeta = canAppendSystemPrompt
      ? { antigravity: { systemPrompt: { append: trimmedSystemPromptAppend } } }
      : undefined;

    let sessionId = null;
    let sessionSetupResult = null;
    let appliedSystemPromptNatively = false;
    const reuseWarmSession = Boolean(
      reusedProcess &&
        resumeSessionId &&
        sessionState?.sessionId &&
        sessionState.sessionId === resumeSessionId
    );
    if (reuseWarmSession) {
      sessionId = sessionState.sessionId;
      const previouslyApplied = sessionState?.systemPromptAppendApplied;
      if (
        canAppendSystemPrompt &&
        typeof previouslyApplied === 'string' &&
        (previouslyApplied === trimmedSystemPromptAppend ||
          previouslyApplied.startsWith(`${trimmedSystemPromptAppend}\n\n`))
      ) {
        appliedSystemPromptNatively = true;
      }
    } else if (resumeSessionId) {
      const supportsResume = agentCapabilities?.sessionCapabilities?.resume != null;
      if (supportsResume) {
        const resumed = await request(
          'session/resume',
          { sessionId: resumeSessionId, cwd, mcpServers: activeMcpServers },
          handshake
        );
        if (!resumed.error) {
          sessionId = resumeSessionId;
          sessionSetupResult = resumed.result ?? null;
        } else if (isAuthError(resumed.error)) {
          return fail(resumed.error);
        }
      }
      if (!sessionId) {
        replayingSession = true;
        const loaded = await request(
          'session/load',
          { sessionId: resumeSessionId, cwd, mcpServers: activeMcpServers },
          handshake
        );
        replayingSession = false;
        if (loaded.error) {
          if (isAuthError(loaded.error)) return fail(loaded.error);
          callbacks.onResumeFallback?.();
        } else {
          sessionId = resumeSessionId;
          sessionSetupResult = loaded.result ?? null;
        }
      }
    }
    if (!sessionId) {
      const created = await request(
        'session/new',
        {
          cwd,
          mcpServers: activeMcpServers,
          ...(sessionMeta ? { _meta: sessionMeta } : {}),
        },
        handshake
      );
      if (created.error || typeof created.result?.sessionId !== 'string') {
        return fail(created.error, 'Antigravity did not return a session id.');
      }
      sessionId = created.result.sessionId;
      sessionSetupResult = created.result;
      if (sessionMeta) {
        appliedSystemPromptNatively = true;
        if (sessionState) sessionState.systemPromptAppendApplied = trimmedSystemPromptAppend;
      }
    }
    if (sessionSetupResult) {
      const modes = extractAvailableModes(sessionSetupResult);
      if (modes.length) availableModes = modes;
      if (sessionState) sessionState.availableModes = availableModes;
      if (Array.isArray(sessionSetupResult.configOptions)) {
        callbacks.onConfigOptions?.(sessionSetupResult.configOptions);
      }
    }
    if (sessionState) sessionState.sessionId = sessionId;
    callbacks.onSessionId(sessionId);

    // Pin the thread's model and thinking level (skip if unchanged on a warm session).
    const effectiveEffort = antigravityReasoningEffortForModel(model, reasoningEffort);
    const wireModelId = antigravityWireModelId(model, effectiveEffort);
    const modelKey = `${wireModelId}:${effectiveEffort ?? ''}`;
    if (!reuseWarmSession || sessionState?.currentModelKey !== modelKey) {
      const setModel = await request('session/set_model', { sessionId, modelId: wireModelId }, handshake);
      if (setModel.error) {
        const setOption = await request(
          'session/set_config_option',
          { sessionId, configId: 'model', value: model.slug },
          handshake
        );
        if (setOption.error) {
          return fail(setModel.error, `Antigravity rejected model "${wireModelId}".`);
        }
        if (Array.isArray(setOption.result?.configOptions)) {
          callbacks.onConfigOptions?.(setOption.result.configOptions);
        }
        if (effectiveEffort) {
          const wireEffort = model.antigravityThoughtLevelValues?.[effectiveEffort] ?? effectiveEffort;
          const setEffort = await request(
            'session/set_config_option',
            { sessionId, configId: 'thought_level', value: wireEffort },
            handshake
          );
          if (setEffort.error) {
            return fail(setEffort.error, `Antigravity rejected thinking level "${wireEffort}".`);
          }
        }
      }
      if (sessionState) sessionState.currentModelKey = modelKey;
    }

    // Use agy's native `auto` review mode when requested and advertised;
    // otherwise use `default` so every action goes through answerPermission.
    const desiredModeId =
      accessMode === 'auto' && availableModes.includes('auto') ? 'auto' : 'default';
    if (!reuseWarmSession || sessionState?.currentModeId !== desiredModeId) {
      const setMode = await request('session/set_mode', { sessionId, modeId: desiredModeId }, handshake);
      if (setMode.error) {
        if (desiredModeId === 'auto') {
          const fallbackMode = await request('session/set_mode', { sessionId, modeId: 'default' }, handshake);
          if (fallbackMode.error) {
            return fail(fallbackMode.error, 'Antigravity could not enter its ask-first permission mode.');
          }
          nativeAutoModeActive = false;
          if (sessionState) sessionState.currentModeId = 'default';
        } else {
          return fail(setMode.error, 'Antigravity could not enter its ask-first permission mode.');
        }
      } else {
        nativeAutoModeActive = desiredModeId === 'auto';
        if (sessionState) sessionState.currentModeId = desiredModeId;
      }
    } else {
      nativeAutoModeActive = desiredModeId === 'auto';
    }

    activeSessionId = sessionId;
    steeringSupported = antigravityVersionError(agentVersion, '1.5.0') === null;
    // If the runtime doesn't support native systemPrompt.append (or this is a
    // resumed session / changed instructions that weren't installed via `_meta`
    // on `session/new`), keep any standing instructions intact by folding them
    // into the prompt text. Warm follow-ups with unchanged instructions stay clean
    // because agy persists `_meta.antigravity.systemPrompt.append` for the session.
    const effectivePromptText = appliedSystemPromptNatively
      ? promptText
      : mergeFallbackSystemPrompt(promptText, systemPromptAppend);
    await sendPrompt(await buildAcpPromptBlocks(effectivePromptText, attachments, resolvePromptCapabilities()));
  };

  // Every session/prompt of the turn, the steers included: agy answers the
  // running one `end_turn` as soon as a newer prompt arrives and carries the
  // turn on under that one, so only the newest prompt's response ends it.
  // The older responses only add their usage.
  const usageTotals = {};
  const addUsage = (usage) => {
    if (!usage || typeof usage !== 'object') return;
    for (const [key, value] of Object.entries(usage)) {
      if (Number.isFinite(value)) usageTotals[key] = (usageTotals[key] ?? 0) + value;
    }
  };
  // A refused steer ("already processing") is resent each second a few
  // times; if agy still won't take it, it isn't a steer and the caller sends
  // it as the next turn.
  const BUSY = /already processing/i;
  const STEER_ACCEPT_WAIT_MS = 1500;
  const STEER_ATTEMPTS = 8;

  // Follows one accepted prompt to its response.
  const followPrompt = async (sequence, pending) => {
    const response = await pending;
    addUsage(response.result?.usage);
    if (sequence !== promptSequence || ended) return;
    await finishPrompt(response, sequence);
  };

  const sendPrompt = async (prompt) => {
    if (ended) return;
    lastSentPromptBlocks = prompt;
    const sequence = ++promptSequence;
    turnActive = true;
    stopSettling();
    lastUpdateAt = Date.now();
    armInactivityTimer();
    // The outcome check reads only the steps this prompt (or a later steer)
    // added: snapshot the session's step index and DB identity first.
    stepCursor = await antigravityStepCursor(activeSessionId);
    dbIdentity = antigravitySnapshotDbIdentity(activeSessionId);
    runStepCursor ??= stepCursor;
    if (ended) return;
    await followPrompt(sequence, request('session/prompt', { sessionId: activeSessionId, prompt }));
  };

  const finishPrompt = async (response, sequence) => {
    clearInactivityTimer();
    flushToolEmits();
    if (response.error) return fail(response.error);
    const stopReason = response.result?.stopReason;
    if (stopReason === 'cancelled' && cancelResolve) {
      cancelResolve(true);
      cancelResolve = null;
      dispose();
      return;
    }
    // agy maps only an exhausted quota to `refusal`; other upstream failures
    // end `end_turn` with an error step in the session database.
    const failure = await antigravityTurnFailure(activeSessionId, stepCursor, stopReason, dbIdentity);
    if (sequence !== promptSequence || ended) return;
    if (failure) {
      const shouldContinue = failure.resumeWith === 'continue' || textSeen || toolCalls.size > 0;
      if (
        failure.retryable &&
        !failure.brokenSession &&
        transientRetryCount < Math.max(0, maxTransientRetries)
      ) {
        transientRetryCount += 1;
        const retryKey = `antigravity-retry-${transientRetryCount}`;
        callbacks.onActivity?.({
          key: retryKey,
          type: 'result',
          status: 'running',
          title: shouldContinue
            ? 'Transient error — continuing automatically…'
            : 'Transient error — retrying automatically…',
          detail: failure.message,
        });
        const proceed = await new Promise((resolve) => {
          retryWake = resolve;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            retryWake = null;
            resolve(true);
          }, Math.max(0, transientRetryDelayMs));
          retryTimer.unref?.();
        });
        if (!proceed || sequence !== promptSequence || ended) return;
        callbacks.onActivity?.({
          key: retryKey,
          type: 'result',
          status: 'done',
          title: shouldContinue
            ? 'Retried after transient error (continued turn)'
            : 'Retried after transient error',
          detail: failure.message,
        });
        if (textSeen) pendingTextBreak = true;
        const nextPrompt = shouldContinue
          ? [{ type: 'text', text: 'Continue.' }]
          : (lastSentPromptBlocks ?? [{ type: 'text', text: 'Continue.' }]);
        await sendPrompt(nextPrompt);
        return;
      }
      if (failure.brokenSession) callbacks.onSessionBroken?.();
      return fail(failure.message, undefined, {
        retryable: Boolean(failure.retryable),
        ...(failure.retryable ? { resumeWith: shouldContinue ? 'continue' : 'retry' } : {}),
      });
    }
    if (stopReason && stopReason !== 'end_turn') {
      const detail =
        stopReason === 'cancelled'
          ? 'was cancelled'
          : stopReason === 'max_tokens'
            ? 'reached the model token limit'
            : stopReason === 'max_turn_requests'
              ? 'reached the maximum turn limit'
              : `stopped (${stopReason})`;
      return fail(`Antigravity turn ${detail}.`);
    }
    // A command agy moved to the background can be missing from the ACP view
    // (its in_progress update raced the prompt response): its own step says.
    const work = await antigravityConversationWork(activeSessionId, runStepCursor ?? stepCursor, dbIdentity);
    if (sequence !== promptSequence || ended) return;
    settleAfterPrompt(response.result ?? {}, work);
  };

  // The prompt has ended, but agy may not be done: subagents keep working
  // and report back, a non-daemon background command or scheduled wake may
  // finish and wake the model to reply by itself (closed by usage_update).
  // Daemons (`IsDaemon: true`) do not hold the turn open, and a silent
  // post-settle command hold is bounded by `postSettleCommandHoldMs` (30m)
  // so a dropped wake never wedges the thread forever.
  const SETTLE_POLL_MS = 1000;
  const SETTLE_QUIET_MS = 3000;
  // A launch whose child never appears on disk (it failed to spawn) isn't
  // waited on for longer than this.
  const UNRESOLVED_CHILD_MS = 20_000;
  const runningOutlivingWork = () =>
    [...toolCalls.values()].some(
      (state) => state.status === 'running' && antigravityToolOutlivesPrompt(state)
    );
  const runningOutlivingCommand = () =>
    [...toolCalls.values()].some(
      (state) => state.status === 'running' && antigravityCommandOutlivesPrompt(state)
    );
  const runningDaemonCount = () =>
    [...toolCalls.values()].filter(
      (state) => state.status === 'running' && antigravityIsDaemonTool(state)
    ).length;
  const unexplainedDbRunning = (work) => {
    if (!work || !(work.running > 0)) return false;
    // Subtract only explicitly marked running daemons (`IsDaemon: true`), never
    // ordinary reads/edits/MCP tools, so missed background commands still hold.
    return work.running > runningDaemonCount();
  };
  // Children whose own step waits on a person: their approvals never reach
  // ACP, so nobody can answer them and they can't go on.
  let stalledChildren = 0;

  const markChildDone = (child, info) => {
    if (child.done) return;
    child.done = true;
    child.doneAt = Date.now();
    lastUpdateAt = Date.now();
    callbacks.onSubagentDone?.(child.id, info);
  };

  const checkChildren = async () => {
    for (const child of children.values()) {
      if (child.done) continue;
      child.childId ??= await resolveAntigravityChild(activeSessionId, child.id);
      if (!child.childId) {
        if (Date.now() - child.launchedAt > UNRESOLVED_CHILD_MS) markChildDone(child, { status: 'error' });
        continue;
      }
      const report = await antigravityChildReport(activeSessionId, child.childId);
      const state = report === null ? await antigravityChildState(activeSessionId, child.childId) : null;
      if (report !== null || state === 'KILLED') {
        markChildDone(child, {
          status: report !== null ? 'done' : 'error',
          ...(report ? { summary: report.slice(0, 4000) } : {}),
        });
        continue;
      }
      // Seen waiting on two polls in a row, so a step agy is about to move
      // on from isn't mistaken for one nobody will answer.
      const work = await antigravityConversationWork(child.childId);
      child.waitingPolls = work?.waiting > 0 ? (child.waitingPolls ?? 0) + 1 : 0;
      if (child.waitingPolls >= 2) {
        stalledChildren += 1;
        markChildDone(child, { status: 'error' });
      }
    }
  };

  const stalledChildrenNotice = () =>
    !stalledChildren
      ? undefined
      : accessMode !== 'full-access'
        ? "_An Antigravity subagent stopped: it needed an approval, and subagents can't ask for one. Below Full access they stall on any command or edit; switch to Full access to let them work._"
        : "_An Antigravity subagent stopped: it was waiting for an approval subagents can't ask for._";

  const settleAfterPrompt = (result, initialWork = null) => {
    turnActive = true;
    settling = true;
    settleGeneration += 1;
    const generation = settleGeneration;
    const current = () => !ended && settling && generation === settleGeneration;
    const finishTurn = () => {
      if (!current()) return;
      ended = true;
      turnActive = false;
      clearInactivityTimer();
      stopSettling();
      flushToolEmits();
      for (const child of children.values()) {
        if (!child.done) callbacks.onSubagentDone?.(child.id, { status: 'error' });
      }
      cancelUserInputs();
      flushHeldText();
      const notice = stalledChildrenNotice();
      if (notice) callbacks.onText(`${textSeen ? '\n\n' : ''}${notice}`);
      callbacks.onTurnEnd({ ...result, usage: { ...usageTotals } }, activeSessionId);
    };
    const tick = async () => {
      settleTimer = null;
      if (!current()) return;
      await checkChildren();
      // A steer (or the end of the run) during the reads above owns the turn now.
      if (!current()) return;
      const waitingOnChildren = [...children.values()].some((child) => !child.done);
      // agy's step statuses are the record of what it still runs: a command
      // whose ACP completion never arrived doesn't hold the turn, and one
      // the ACP view missed does. Ignore DB running count when the only
      // running ACP tools are explicit daemons (`IsDaemon: true`).
      const work = await antigravityConversationWork(activeSessionId, runStepCursor ?? stepCursor, dbIdentity);
      if (!current()) return;
      const dbRunning = unexplainedDbRunning(work);
      const commandsRunning = work ? dbRunning : runningOutlivingWork();
      const generating = Boolean(work?.generating);
      // Bound silent post-settle background command holds (e.g. a dropped wake).
      // Only applies when waiting solely on a background command with no DB step
      // activity or ACP updates for `postSettleCommandHoldMs`.
      const silentCommandHoldExpired =
        postSettleCommandHoldMs > 0 &&
        !waitingOnChildren &&
        !generating &&
        !replyOpen &&
        pendingUserInputs.size === 0 &&
        runningOutlivingCommand() &&
        !dbRunning &&
        Date.now() - Math.max(lastUpdateAt, commandHoldStartedAt ?? lastUpdateAt) >= postSettleCommandHoldMs;
      if (silentCommandHoldExpired) return finishTurn();
      // A child reported (or a background command / schedule finished) and agy
      // woke the model, but its reply hasn't streamed yet or is between steps.
      const replyPending =
        !waitingOnChildren &&
        !commandsRunning &&
        !generating &&
        !replyOpen &&
        (children.size > 0 || workOutlivedPrompt) &&
        (await antigravityPendingReply(activeSessionId));
      if (!current()) return;
      const busy =
        waitingOnChildren || commandsRunning || generating || replyOpen || replyPending || pendingUserInputs.size > 0;
      if (!busy && Date.now() - lastUpdateAt >= SETTLE_QUIET_MS) return finishTurn();
      settleTimer = setTimeout(() => void tick(), SETTLE_POLL_MS);
    };
    const hasOutliving = runningOutlivingWork() || unexplainedDbRunning(initialWork);
    if (hasOutliving) {
      workOutlivedPrompt = true;
      commandHoldStartedAt = Date.now();
    }
    // Plain turns (no children, nothing running, nobody asked) end right
    // away. A /goal turn always waits out the quiet period: agy can keep
    // pursuing the goal after the prompt's response.
    if (!goalTurn && !children.size && !workOutlivedPrompt && !replyOpen && pendingUserInputs.size === 0) {
      return finishTurn();
    }
    settleTimer = setTimeout(() => void tick(), SETTLE_POLL_MS);
  };

  // A message sent while the turn runs goes into it (agy 1.5+): a second
  // session/prompt, which agy folds in at its next step. agy answers a
  // refused steer at once; an accepted one only when the turn ends. False
  // when there is no running turn to take it (or agy keeps refusing it), so
  // the caller sends it as the next turn instead.
  const steer = async (text, steerAttachments = []) => {
    if (!steeringSupported || !turnActive || ended || !activeSessionId) return false;
    const prompt = await buildAcpPromptBlocks(text, steerAttachments, resolvePromptCapabilities());
    for (let attempt = 0; attempt < STEER_ATTEMPTS; attempt += 1) {
      if (!turnActive || ended) return false;
      const sequence = ++promptSequence;
      stopSettling();
      const pending = request('session/prompt', { sessionId: activeSessionId, prompt });
      const early = await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve(null), STEER_ACCEPT_WAIT_MS)),
      ]);
      if (early?.error && BUSY.test(early.error.message ?? '')) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      if (textSeen) pendingTextBreak = true;
      lastSentPromptBlocks = prompt;
      lastUpdateAt = Date.now();
      armInactivityTimer();
      void followPrompt(sequence, pending);
      return true;
    }
    return false;
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

    if (message.id !== undefined && message.method) {
      lastUpdateAt = Date.now();
      if (message.method === 'session/request_permission') return answerPermission(message);
      if (message.method === 'elicitation/create') return answerElicitation(message);
      write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not supported' },
      });
      return;
    }

    if (replayingSession) return;
    const update = message.method === 'session/update' ? message.params?.update : null;
    if (!update || typeof update !== 'object') return;

    const kind = update.sessionUpdate;
    lastUpdateAt = Date.now();
    if (turnActive && !settling) armInactivityTimer();
    // After the prompt ended, agy's own reply (to a subagent report) runs
    // until its closing usage_update.
    if (kind === 'usage_update') replyOpen = false;
    else if (settling && (kind === 'agent_message_chunk' || kind === 'tool_call' || kind === 'agent_thought_chunk')) {
      replyOpen = true;
    }
    if (kind === 'agent_thought_chunk') {
      const text = update.content?.text;
      if (typeof text === 'string' && text) callbacks.onReasoning(text);
      return;
    }
    if (kind === 'agent_message_chunk') {
      const text = stripGoalMarker(typeof update.content?.text === 'string' ? update.content.text : '');
      if (!text) return;
      const prefix = pendingTextBreak && textSeen ? '\n\n' : '';
      pendingTextBreak = false;
      textSeen = true;
      callbacks.onText(`${prefix}${text}`);
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      if (textSeen) pendingTextBreak = true;
      upsertToolCall(update);
      return;
    }
    if (kind === 'plan') {
      handlePlanUpdate(update.entries);
      return;
    }
    if (kind === 'available_commands_update') {
      const commands = normalizeSlashCommands(update.availableCommands ?? update.commands);
      callbacks.onSlashCommands?.(commands);
      return;
    }
    if (kind === 'current_mode_update') {
      const modeId = update.currentModeId ?? update.modeId;
      if (typeof modeId === 'string' && modeId && sessionState) {
        sessionState.currentModeId = modeId;
      }
      return;
    }
    if (kind === 'config_option_update') {
      const configOptions = Array.isArray(update.configOptions) ? update.configOptions : [];
      const modes = extractAvailableModes({ configOptions });
      if (modes.length) {
        availableModes = modes;
        if (sessionState) sessionState.availableModes = availableModes;
      }
      callbacks.onConfigOptions?.(configOptions);
    }
  };

  return { start, handleMessage, steer, cancel, getUserInputs, answerUserInput, dispose };
};

// One-shot, tool-free Antigravity text turn over ACP for hidden utility turns
// (titles, commit messages, approval explanations): runs in a private temp
// directory, aborts on any tool call, and deletes the temporary Antigravity
// session database/brain/annotations files afterwards so hidden helper calls
// never pollute `~/.gemini/antigravity-cli` or the user's project directory.
export const antigravityReadOnlyOneShot = async (
  model,
  promptText,
  _cwd,
  { signal, threadId, reasoningEffort } = {}
) => {
  if (signal?.aborted) return '';
  let tempCwd = null;
  try {
    tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'durango-agy-oneshot-'));
  } catch {
    return '';
  }

  let capturedSessionId = null;
  try {
    // Re-check cancellation after async temp-dir setup so we never spawn a
    // child for an already-aborted utility turn.
    if (signal?.aborted) return '';
    return await new Promise((resolve) => {
      const child = spawn(loginShell, ['-lc', 'agy acp'], {
        cwd: tempCwd,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let text = '';
      let settled = false;
      let deadline = null;
      let driver = null;
      const cleanup = () => {
        if (deadline) clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
      };
      const finish = (success = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          driver?.dispose?.();
        } catch {}
        void killAgentChild(child, threadId).then(() => resolve(success ? text : ''));
      };
      const abort = () => finish(false);
      // The ACP server idles after the prompt resolves and never exits on its
      // own; cap the whole turn so a wedged server can't leak a process.
      deadline = setTimeout(() => finish(false), 60_000);
      driver = createAntigravityAcpDriver({
        child,
        cwd: tempCwd,
        model,
        reasoningEffort,
        promptText,
        resumeSessionId: null,
        accessMode: 'read-only',
        callbacks: {
          onSessionId: (id) => {
            capturedSessionId = id;
          },
          onReasoning: () => {},
          onActivity: (activity) => {
            // Hidden utility turns must never run tools.
            if (activity?.type === 'tool' || activity?.type === 'command') {
              finish(false);
            }
          },
          onResumeFallback: () => {},
          onText: (delta) => {
            text += delta;
          },
          onTurnEnd: () => finish(true),
          onFatal: () => finish(false),
        },
      });
      let buffer = '';
      child.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            driver.handleMessage(JSON.parse(trimmed));
          } catch {}
        }
      });
      child.stderr.resume();
      child.on('error', () => finish(false));
      child.on('close', () => finish(false));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        Promise.resolve(driver.start()).catch(() => finish(false));
      } catch {
        finish(false);
      }
    });
  } finally {
    if (capturedSessionId) {
      await removeAntigravitySessionFiles({ sessionId: capturedSessionId, cwd: tempCwd }).catch(() => {});
    }
    await fs.rm(tempCwd, { recursive: true, force: true }).catch(() => {});
  }
};
