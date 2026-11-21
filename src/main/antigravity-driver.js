import { spawn } from 'node:child_process';
import { killAgentChild } from './run-registry.js';
import { isPreapprovedOrionTool } from './thread-reader-routing.js';
import { buildKimiPromptBlocks } from './kimi-driver.js';
import { loginShell } from './shell-env.js';
import { countDiffLines, formatToolInput, formatToolOutput, stringifySummary } from './stream-adapters.js';
import { createWorkspaceBoundary } from './workspace-boundary.js';

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

// agy's native tool names (the `name` field on tool_call updates).
export const ANTIGRAVITY_TOOL_LABELS = {
  run_command: 'Command',
  send_command_input: 'Command input',
  command_status: 'Command status',
  read_terminal: 'Terminal',
  view_file: 'Read',
  view_file_outline: 'Outline',
  view_code_item: 'Read',
  list_dir: 'List',
  find_by_name: 'Find',
  grep_search: 'Grep',
  codebase_search: 'Search',
  write_file: 'Write',
  write_to_file: 'Write',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  edit_file: 'Edit',
  search_web: 'Web search',
  read_url_content: 'Web fetch',
  view_content_chunk: 'Web fetch',
  browser_subagent: 'Browser',
  generate_image: 'Image',
  schedule: 'Schedule',
};

export const antigravityToolLabel = (name) => {
  if (!name) return 'Tool';
  if (ANTIGRAVITY_TOOL_LABELS[name]) return ANTIGRAVITY_TOOL_LABELS[name];
  const mcp = /^mcp_([^_]+)_(.+)$/.exec(name);
  if (mcp) return `${mcp[1]} · ${mcp[2].replace(/_/g, ' ')}`;
  return String(name)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (letter) => letter.toUpperCase());
};

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

const SIGN_IN_HINT =
  'Sign in to Antigravity first: run `agy` in a terminal and finish the Google sign-in, then send the message again.';

const isAuthError = (error) =>
  error?.code === -32000 || /auth|sign.?in|log.?in|credential|unauthenticated/i.test(error?.message ?? '');

const errorMessage = (error, fallback) => {
  if (isAuthError(error)) return SIGN_IN_HINT;
  const message = typeof error === 'string' ? error : error?.message;
  return message ? `Antigravity: ${message}` : fallback;
};

export const createAntigravityAcpDriver = ({
  child,
  cwd,
  model,
  promptText,
  attachments = [],
  resumeSessionId,
  accessMode,
  mcpServers = [],
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
    const isOrionTool =
      toolName.startsWith('mcp_orion_') &&
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

  const fail = (error, fallback = 'Antigravity agent protocol error.') => {
    flushToolEmits();
    callbacks.onFatal(errorMessage(error, fallback));
  };

  const start = async () => {
    const init = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'durango-code', version: '1' },
    });
    if (init.error) return fail(init.error);
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

    // Pin the thread's model. Sessions (including resumed ones) open on the
    // CLI's default; the flat ids from `agy models` also carry the thinking
    // level. Fall back to the model config option for family ids.
    const setModel = await request('session/set_model', { sessionId, modelId: model.slug });
    if (setModel.error) {
      const setOption = await request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: model.slug,
      });
      if (setOption.error) {
        return fail(setModel.error, `Antigravity rejected model "${model.slug}".`);
      }
    }

    // `default` asks before edits, commands and MCP tools; the policy in
    // answerPermission decides each one.
    const setMode = await request('session/set_mode', { sessionId, modeId: 'default' });
    if (setMode.error) {
      return fail(setMode.error, 'Antigravity could not enter its ask-first permission mode.');
    }

    const prompt = await buildKimiPromptBlocks(promptText, attachments);
    const response = await request('session/prompt', { sessionId, prompt });
    flushToolEmits();
    if (response.error) return fail(response.error);
    const stopReason = response.result?.stopReason;
    if (stopReason && stopReason !== 'end_turn') {
      // agy maps only an exhausted quota to `refusal`.
      const detail =
        stopReason === 'refusal'
          ? 'stopped: you have reached your Antigravity quota for this period'
          : stopReason === 'cancelled'
            ? 'was cancelled'
            : stopReason === 'max_tokens'
              ? 'reached the model token limit'
              : stopReason === 'max_turn_requests'
                ? 'reached the maximum turn limit'
                : `stopped (${stopReason})`;
      return fail(`Antigravity turn ${detail}.`);
    }
    callbacks.onTurnEnd(response.result ?? {}, sessionId);
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
    if (kind === 'agent_thought_chunk') {
      const text = update.content?.text;
      if (typeof text === 'string' && text) callbacks.onReasoning(text);
      return;
    }
    if (kind === 'agent_message_chunk') {
      const text = update.content?.text;
      if (typeof text !== 'string' || !text) return;
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

  return { start, handleMessage };
};

// One-shot, tool-free Antigravity text turn over ACP for hidden utility turns
// (titles, commit messages): Read only policy denies every non-read tool.
// Resolves with the reply text, or '' on failure. Cancellation waits for the
// ACP child to exit so callers may safely tear down its cwd.
export const antigravityReadOnlyOneShot = (model, promptText, cwd, { signal, threadId } = {}) => {
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
