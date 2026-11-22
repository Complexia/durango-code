import { spawn } from 'node:child_process';
import { killAgentChild } from './run-registry.js';
import { isPreapprovedOrionTool } from './thread-reader-routing.js';
import { buildKimiPromptBlocks } from './kimi-driver.js';
import { loginShell } from './shell-env.js';
import { countDiffLines, formatToolInput, formatToolOutput, stringifySummary } from './stream-adapters.js';
import { createWorkspaceBoundary } from './workspace-boundary.js';
import { antigravityToolLabel } from './antigravity-tool-labels.js';
import { antigravityConversationWork, antigravityStepCursor, antigravityTurnFailure } from './antigravity-turn-outcome.js';
import {
  ANTIGRAVITY_SUBAGENT_TOOLS,
  antigravityChildReport,
  antigravityChildState,
  antigravityPendingReply,
  resolveAntigravityChild,
} from './antigravity-child-work.js';
import { antigravityReasoningEffortForModel, antigravityWireModelId } from './models.js';

// ---------------------------------------------------------------------------
// Antigravity ACP driver. Every turn runs Google's Antigravity CLI as
// `agy acp` (line-delimited JSON-RPC over stdio): token-level message and
// thought chunks, tool calls carrying their native name (`name`) and raw
// input up front, permission requests Orion answers by access-mode policy,
// and a prompt response carrying the turn's own token usage (per turn, not
// cumulative). Model selection is session/set_model with the flat ids
// `agy models` prints (`gemini-3.8-flash-low` pins both model and thinking
// level). The session runs in agy's `default` mode, which asks before edits,
// commands and MCP tools, so every action goes through answerPermission:
// agy rejects `yolo`, and its `auto` mode self-approves commands on any path.
// Verified live on agy 1.5.14.
//
// Sign-in is agy's own (OS keyring): `agy` in a terminal, or
// `agy acp --login`. Orion never handles Google credentials.

export { ANTIGRAVITY_TOOL_LABELS, antigravityToolLabel } from './antigravity-tool-labels.js';

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

// Live drivers by runId: steering (agent:steerTurn) and native questions
// (agent:getCodexQuestions / answerCodexQuestions). Cleaned up in finalizeRun.
export const antigravityRunDrivers = new Map();

export const steerAntigravityRun = (runId, text, attachments) => {
  const driver = antigravityRunDrivers.get(runId);
  return driver ? driver.steer(text, attachments) : false;
};

export const createAntigravityAcpDriver = ({
  child,
  cwd,
  model,
  reasoningEffort,
  promptText,
  attachments = [],
  resumeSessionId,
  accessMode,
  mcpServers = [],
  threadId = null,
  callbacks,
}) => {
  let nextRequestId = 1;
  const pendingRequests = new Map();
  const toolCalls = new Map();
  // session/load replays the whole prior conversation as session/update
  // notifications before its response resolves; Orion keeps its own
  // transcript, so the replay is suppressed.
  let replayingSession = false;
  let textSeen = false;
  let pendingTextBreak = false;
  let activeSessionId = null;
  let agentVersion = null;
  let steeringSupported = false;
  let turnActive = false;
  let ended = false;
  let promptSequence = 0;
  let stepCursor = -1;
  // The session's last step before this process's first prompt: steps at or
  // before it belong to earlier runs (a killed run can leave one RUNNING).
  let runStepCursor = null;
  // Subagents launched this turn (by launch toolCallId) and the wait for
  // them after the prompt ends (see settleAfterPrompt).
  const children = new Map();
  let settleTimer = null;
  let settling = false;
  let replyOpen = false;
  // A command was still running when a prompt ended (agy moved it to the
  // background): when it finishes, agy wakes the model to carry on by itself.
  let commandOutlivedPrompt = false;
  let lastUpdateAt = Date.now();
  // Native questions waiting on the user (elicitation/create), by request id.
  const pendingUserInputs = new Map();
  const ambiguousOrionPrefix = mcpServers.some(
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

  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextRequestId++;
      pendingRequests.set(id, resolve);
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
      state.input = formatToolInput(rawInput);
      const command = pickField(rawInput, COMMAND_FIELDS);
      if (command) state.command = command;
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

    if (Array.isArray(update.content)) {
      for (const entry of update.content) {
        if (entry?.type === 'diff' && typeof entry.path === 'string') {
          state.filePath = state.filePath ?? entry.path;
          state.diff = {
            path: entry.path,
            additions: countDiffLines(entry.newText),
            deletions: countDiffLines(entry.oldText),
          };
        }
        if (entry?.type === 'content' && typeof entry.content?.text === 'string' && entry.content.text) {
          state.output = entry.content.text;
        }
      }
    }

    const rawOutput = update.rawOutput;
    if (typeof rawOutput === 'string' && rawOutput.trim()) {
      state.output = rawOutput;
    } else if (rawOutput && typeof rawOutput === 'object') {
      if (typeof rawOutput.exit_code === 'number') state.exitCode = rawOutput.exit_code;
      if (typeof rawOutput.output === 'string' && rawOutput.output.trim()) state.output = rawOutput.output;
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

  // agy asks its own multiple-choice questions over session/request_permission
  // with an `interaction_` tool call id; the options are answers, not
  // approvals. Orion runs turns unattended, so the question is shown in the
  // transcript and cancelled: the user answers in their next message.
  const answerQuestion = (message) => {
    const params = message.params ?? {};
    const toolCall = params.toolCall ?? {};
    const options = Array.isArray(params.options) ? params.options : [];
    const question =
      pickField(toolCall.rawInput, ['question', 'prompt', 'message']) ||
      (typeof toolCall.title === 'string' ? toolCall.title : '') ||
      'Antigravity asked a question.';
    const choices = options
      .map((option) => String(option?.name || option?.optionId || '').trim())
      .filter(Boolean);
    write({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } });
    callbacks.onActivity({
      key: toolCall.toolCallId || `question:${message.id}`,
      type: 'tool',
      kind: 'other',
      title: `Question - ${stringifySummary(question, 80)}`,
      detail: question,
      status: 'done',
      output: `${question}${choices.length ? `\n\nOptions:\n${choices.map((choice) => `- ${choice}`).join('\n')}` : ''}\n\nAnswer in your next message.`,
    });
  };

  // agy 1.5's ask_question tool asks over ACP elicitation (form mode): one
  // `qN` property per question (a string with `oneOf` choices, or an array
  // of `anyOf` items for multi-select) and an optional `qN_other` free-text
  // field. The question shows as a card (agent:getCodexQuestions) and the
  // turn waits on it; the answer is `{ action: 'accept', content }` with the
  // choices' `const` values.
  const parseElicitation = (params) => {
    const properties = params?.requestedSchema?.properties;
    if (!properties || typeof properties !== 'object') return null;
    const questions = [];
    const choices = new Map();
    for (const [key, property] of Object.entries(properties)) {
      if (!/^q\d+$/.test(key) || !property || typeof property !== 'object') continue;
      const multiSelect = property.type === 'array';
      const entries = (multiSelect ? property.items?.anyOf : property.oneOf) ?? [];
      const options = (Array.isArray(entries) ? entries : [])
        .filter((entry) => entry && (typeof entry.const === 'string' || typeof entry.const === 'number'))
        .map((entry) => ({ value: String(entry.const), label: String(entry.title ?? entry.const) }));
      const other = properties[`${key}_other`];
      if (!options.length && !other) continue;
      choices.set(key, { options, multiSelect, other: Boolean(other) });
      questions.push({
        id: key,
        header: 'Question',
        question: String(property.title || params.message || 'Antigravity has a question.'),
        multiSelect,
        allowCustom: Boolean(other),
        options: options.map((option) => ({ label: option.label, description: '' })),
      });
    }
    return questions.length ? { questions, choices } : null;
  };

  const answerElicitation = (message) => {
    const parsed = parseElicitation(message.params);
    if (!parsed || !callbacks.onUserInput || ended) {
      write({ jsonrpc: '2.0', id: message.id, result: { action: 'decline' } });
      return;
    }
    pendingUserInputs.set(message.id, { id: message.id, ...parsed });
    callbacks.onUserInput();
  };

  const getUserInputs = () =>
    [...pendingUserInputs.values()].map(({ id, questions }) => ({
      requestId: id,
      threadId,
      questions,
    }));

  // `answers`: per question id, the picked labels and any typed text.
  const answerUserInput = (requestId, answers) => {
    const pending = pendingUserInputs.get(requestId);
    if (!pending || ended || !answers || typeof answers !== 'object') return false;
    const content = {};
    for (const question of pending.questions) {
      const values = Array.isArray(answers[question.id]) ? answers[question.id].map((value) => String(value).trim()).filter(Boolean) : [];
      if (!values.length) return false;
      const { options, multiSelect, other } = pending.choices.get(question.id);
      const picked = [];
      const typed = [];
      for (const value of values) {
        const option = options.find((entry) => entry.label === value);
        if (option) picked.push(option.value);
        else typed.push(value);
      }
      if (typed.length && !other) return false;
      if (picked.length) content[question.id] = multiSelect ? picked : picked[0];
      if (typed.length) content[`${question.id}_other`] = typed.join(', ');
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
    for (const id of pendingUserInputs.keys()) write({ jsonrpc: '2.0', id, result: { action: 'cancel' } });
    pendingUserInputs.clear();
    callbacks.onUserInput?.();
  };

  // Approvals are answered by access-mode policy, as in the kimi driver:
  // Full access allows everything; Read only allows read-only tools; Workspace
  // write allows file changes whose every target resolves inside the
  // workspace (agy has no filesystem sandbox of its own here) and denies
  // commands, whose filesystem reach is unknowable.
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
    // Orion's own MCP tools are safe in every mode (see the kimi driver).
    // agy names MCP tools `mcp_<server>_<tool>`.
    // A user MCP server named `orion_…` would make the prefix ambiguous
    // (`mcp_orion_x_read_thread`), so such names never pre-approve.
    const isOrionTool =
      toolName.startsWith('mcp_orion_') &&
      !ambiguousOrionPrefix &&
      isPreapprovedOrionTool(toolName.slice('mcp_orion_'.length), accessMode);
    let allow;
    let denialDetail = "mode doesn't permit this tool.";
    if (isOrionTool || accessMode === 'full-access') {
      allow = true;
    } else if (accessMode !== 'workspace-write') {
      allow = readOnly;
    } else if (readOnly) {
      allow = true;
    } else if (kind === 'edit' || kind === 'delete' || kind === 'move') {
      const targets = mutationTargets(toolCall, known);
      allow = targets.length > 0 && targets.every(isInsideWorkspace);
      if (!allow) {
        denialDetail = targets.length
          ? 'mode only permits file changes inside the workspace.'
          : 'mode requires a known target path for file changes.';
      }
    } else {
      allow = false;
    }

    // Never pick an "always" option: it would let agy self-approve later
    // calls of the same tool without asking, past the per-call policy above.
    const options = (Array.isArray(params.options) ? params.options : []).filter(
      (option) =>
        option?.kind !== 'allow_always' &&
        option?.kind !== 'reject_always' &&
        !/always/i.test(`${option?.optionId ?? ''} ${option?.name ?? ''}`)
    );
    const pick = (wanted, pattern) =>
      options.find((option) => option?.kind === wanted) ??
      options.find((option) => pattern.test(`${option?.optionId ?? ''} ${option?.name ?? ''}`));
    const chosen = allow ? pick('allow_once', /allow|approve|yes/i) : pick('reject_once', /reject|deny|no/i);

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
        accessMode === 'read-only' ? 'Read only' : 'Workspace write'
      } ${denialDetail} Switch to Full Access to allow it.`;
      emitToolActivity(known, true);
    }
  };

  const stopSettling = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    settling = false;
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

  const fail = (error, fallback = 'Antigravity agent protocol error.') => {
    if (ended) return;
    ended = true;
    turnActive = false;
    stopSettling();
    cancelUserInputs();
    flushToolEmits();
    flushHeldText();
    callbacks.onFatal(errorMessage(error, fallback));
    resolvePendingRequests();
  };

  // The run was stopped or its process went away: stop every wait and timer
  // without reporting anything more for it.
  const dispose = () => {
    if (ended) return;
    ended = true;
    turnActive = false;
    stopSettling();
    pendingUserInputs.clear();
    resolvePendingRequests();
  };

  const start = async () => {
    const init = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        // Questions come over elicitation only when someone can answer them.
        ...(callbacks.onUserInput ? { elicitation: { form: {} } } : {}),
      },
      clientInfo: { name: 'durango-code', version: '1' },
    });
    if (init.error) return fail(init.error);
    agentVersion = init.result?.agentInfo?.version ?? null;
    const versionError = antigravityVersionError(agentVersion);
    if (versionError) return fail(versionError);
    const unsupported = mcpServers.filter((server) => server?.type === 'http');
    if (init.result?.agentCapabilities?.mcpCapabilities?.http !== true && unsupported.length) {
      return fail(
        `This provider does not support HTTP MCP servers: ${unsupported.map((server) => `@${server.name}`).join(', ')}. Switch providers, or switch these MCPs off and remove their thread attachments.`
      );
    }

    let sessionId = null;
    if (resumeSessionId) {
      replayingSession = true;
      const loaded = await request('session/load', { sessionId: resumeSessionId, cwd, mcpServers });
      replayingSession = false;
      if (loaded.error) {
        if (isAuthError(loaded.error)) return fail(loaded.error);
        callbacks.onResumeFallback?.();
      } else {
        sessionId = resumeSessionId;
      }
    }
    if (!sessionId) {
      const created = await request('session/new', { cwd, mcpServers });
      if (created.error || typeof created.result?.sessionId !== 'string') {
        return fail(created.error, 'Antigravity did not return a session id.');
      }
      sessionId = created.result.sessionId;
    }
    callbacks.onSessionId(sessionId);

    // Pin the thread's model and thinking level. Sessions (including resumed
    // ones) open on the CLI's default; flat `<model>-<effort>` ids set both in
    // one call, and `session/set_config_option` (`model` + `thought_level`) is
    // the fallback for family ids.
    const effectiveEffort = antigravityReasoningEffortForModel(model, reasoningEffort);
    const wireModelId = antigravityWireModelId(model, effectiveEffort);
    const setModel = await request('session/set_model', { sessionId, modelId: wireModelId });
    if (setModel.error) {
      const setOption = await request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: model.slug,
      });
      if (setOption.error) {
        return fail(setModel.error, `Antigravity rejected model "${wireModelId}".`);
      }
      if (effectiveEffort) {
        const setEffort = await request('session/set_config_option', {
          sessionId,
          configId: 'thought_level',
          value: effectiveEffort,
        });
        if (setEffort.error) {
          return fail(setEffort.error, `Antigravity rejected thinking level "${effectiveEffort}".`);
        }
      }
    }

    // `default` asks before edits, commands and MCP tools; the policy in
    // answerPermission decides each one.
    const setMode = await request('session/set_mode', { sessionId, modeId: 'default' });
    if (setMode.error) {
      return fail(setMode.error, 'Antigravity could not enter its ask-first permission mode.');
    }

    activeSessionId = sessionId;
    steeringSupported = antigravityVersionError(agentVersion, '1.5.0') === null;
    await sendPrompt(await buildKimiPromptBlocks(promptText, attachments));
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
    const sequence = ++promptSequence;
    turnActive = true;
    stopSettling();
    // The outcome check reads only the steps this prompt (or a later steer)
    // added: snapshot the session's step index first.
    stepCursor = await antigravityStepCursor(activeSessionId);
    runStepCursor ??= stepCursor;
    if (ended) return;
    await followPrompt(sequence, request('session/prompt', { sessionId: activeSessionId, prompt }));
  };

  const finishPrompt = async (response, sequence) => {
    flushToolEmits();
    if (response.error) return fail(response.error);
    const stopReason = response.result?.stopReason;
    // agy maps only an exhausted quota to `refusal`; other upstream failures
    // end `end_turn` with an error step in the session database.
    const failure = await antigravityTurnFailure(activeSessionId, stepCursor, stopReason);
    if (sequence !== promptSequence || ended) return;
    if (failure) {
      if (failure.brokenSession) callbacks.onSessionBroken?.();
      return fail(failure.message);
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
    const work = await antigravityConversationWork(activeSessionId, runStepCursor ?? stepCursor);
    if (sequence !== promptSequence || ended) return;
    settleAfterPrompt(response.result ?? {}, work);
  };

  // The prompt has ended, but agy may not be done: subagents keep working
  // and report back, and the parent then replies by itself (its own text,
  // closed by a usage_update). A command that outlives its WaitMsBeforeAsync
  // moves to the background and the model often ends its prompt to wait for
  // it; when it finishes, agy wakes the model the same way (verified on agy
  // 1.5.14). The agy process is this turn's: ending the turn ends it and
  // everything it still runs. So the turn stays open for as long as agy's own
  // record says work is in flight, however long that is: every child has
  // reported, no step of this run is running (agy's session database), the
  // woken reply has finished, and nothing arrived for 3s. There is no idle
  // limit: a long silent command (a release upload) is work, not a stall. A
  // command that never exits (a dev server) keeps the thread Working until
  // the person stops it or steers the model to stop it.
  const SETTLE_POLL_MS = 1000;
  const SETTLE_QUIET_MS = 3000;
  // A launch whose child never appears on disk (it failed to spawn) isn't
  // waited on for longer than this. A child that did spawn is on disk within
  // moments of its launch call completing.
  const UNRESOLVED_CHILD_MS = 20_000;
  const runningCommands = () =>
    [...toolCalls.values()].some((state) => state.kind === 'execute' && state.status === 'running');
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
      // the ACP view missed does. The ACP view stands in only when the
      // database can't be read.
      const work = await antigravityConversationWork(activeSessionId, runStepCursor ?? stepCursor);
      if (!current()) return;
      const commandsRunning = work ? work.running > 0 : runningCommands();
      const generating = Boolean(work?.generating);
      // A child reported (or a background command finished) and agy woke
      // the model, but its reply hasn't streamed yet or is between steps: a
      // thinking model can be silent for well over the quiet period.
      const replyPending =
        !waitingOnChildren &&
        !commandsRunning &&
        !generating &&
        !replyOpen &&
        (children.size > 0 || commandOutlivedPrompt) &&
        (await antigravityPendingReply(activeSessionId));
      if (!current()) return;
      const busy =
        waitingOnChildren || commandsRunning || generating || replyOpen || replyPending || pendingUserInputs.size > 0;
      if (!busy && Date.now() - lastUpdateAt >= SETTLE_QUIET_MS) return finishTurn();
      settleTimer = setTimeout(() => void tick(), SETTLE_POLL_MS);
    };
    if (runningCommands() || initialWork?.running > 0) commandOutlivedPrompt = true;
    // Plain turns (no children, nothing running, nobody asked) end right
    // away. A /goal turn always waits out the quiet period: agy can keep
    // pursuing the goal after the prompt's response.
    if (!goalTurn && !children.size && !commandOutlivedPrompt && !replyOpen && pendingUserInputs.size === 0) {
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
    const prompt = await buildKimiPromptBlocks(text, steerAttachments);
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
      lastUpdateAt = Date.now();
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
    if (kind === 'plan') handlePlanUpdate(update.entries);
    // usage_update / session_info_update / available_commands_update /
    // config_option_update / current_mode_update are bookkeeping.
  };

  return { start, handleMessage, steer, getUserInputs, answerUserInput, dispose };
};

// One-shot, tool-free Antigravity text turn over ACP for hidden utility turns
// (titles, commit messages): Read only policy denies every non-read tool.
// Resolves with the reply text, or '' on failure. Cancellation waits for the
// ACP child to exit so callers may safely tear down its cwd.
export const antigravityReadOnlyOneShot = (
  model,
  promptText,
  cwd,
  { signal, threadId, reasoningEffort } = {}
) => {
  if (signal?.aborted) return Promise.resolve('');
  return new Promise((resolve) => {
    const child = spawn(loginShell, ['-lc', 'agy acp'], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let text = '';
    let settled = false;
    let deadline = null;
    const cleanup = () => {
      if (deadline) clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (success = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      void killAgentChild(child, threadId).then(() => resolve(success ? text : ''));
    };
    const abort = () => finish(false);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    // The ACP server idles after the prompt resolves and never exits on its
    // own; cap the whole turn so a wedged server can't leak a process.
    deadline = setTimeout(finish, 60_000);
    const driver = createAntigravityAcpDriver({
      child,
      cwd,
      model,
      reasoningEffort,
      promptText,
      resumeSessionId: null,
      accessMode: 'read-only',
      callbacks: {
        onSessionId: () => {},
        onReasoning: () => {},
        onActivity: () => {},
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
    driver.start();
  });
};
