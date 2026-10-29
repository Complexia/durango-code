import { spawn } from 'node:child_process';
import { killAgentChild } from './run-registry.js';
import { isPreapprovedOrionTool } from './thread-reader-routing.js';
import { buildKimiPromptBlocks } from './kimi-driver.js';
import { loginShell } from './shell-env.js';
import { countDiffLines, formatToolInput, formatToolOutput, stringifySummary } from './stream-adapters.js';
import { createWorkspaceBoundary } from './workspace-boundary.js';
import { prepareFxLaunch } from './fx-provider.js';

// ---------------------------------------------------------------------------
// fx ACP driver. Every fx turn runs `fx acp` (line-delimited JSON-RPC over
// stdio): token-level message chunks, tool calls with their raw input up
// front, tool completion updates, permission requests Orion answers by
// access-mode policy, and a prompt response carrying the turn's token usage.
// Each turn pins the route (session/set_config_option "provider", then
// "model") from prepareFxLaunch's ordered candidates — a subscription fx
// rejects, or a model it doesn't serve, falls through to the next one — and
// the permission mode (session/set_mode: ask / full-access). Messages sent
// while a turn runs steer it: a second session/prompt flagged
// `_meta.fx.steer`, which fx folds in at its next model boundary. Verified
// live on fx 0.0.15.

// Live fx drivers by runId, for agent:steerTurn. Cleaned up in finalizeRun.
export const fxSteerableRunDrivers = new Map();

export const steerFxRun = (runId, text, attachments) => {
  const driver = fxSteerableRunDrivers.get(runId);
  return driver ? driver.steer(text, attachments) : false;
};

// How long a steer waits for fx to reject it outright. fx only answers an
// accepted steer when the whole turn ends, so silence means accepted.
const FX_STEER_REJECTION_WINDOW_MS = 750;

export const FX_TOOL_LABELS = {
  read_file: 'Read',
  glob_files: 'Glob',
  grep_files: 'Grep',
  edit_file: 'Edit',
  write_file: 'Write',
  shell: 'Command',
  subagent: 'Subagent',
  capability_search: 'Capability search',
  skill: 'Skill',
  install_skill: 'Install skill',
  mcp_select_tool: 'MCP tool',
  ask_user_question: 'Question',
  web_fetch: 'Web fetch',
  web_search: 'Web search',
  read_tool_result: 'Read tool result',
};

export const fxToolLabel = (name) => {
  if (!name) return 'Tool';
  return (
    FX_TOOL_LABELS[name] ??
    String(name)
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^\w/, (letter) => letter.toUpperCase())
  );
};

export const fxStatsFromPromptResult = (result) => {
  const usage = result?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
  const outputTokens = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
  if (!inputTokens && !outputTokens) return null;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
};

// fx streams provider failures as the turn's message text ("HTTP 502:
// {…}") and ends the prompt with a non-end_turn stop reason. Translate the
// failures a Durango route can produce into something actionable.
const fxFailureMessage = (stopReason, errorText) => {
  const text = String(errorText || '');
  if (/insufficient_credits|free_usage_limit_reached/.test(text)) {
    return 'Out of Durango credits. Add credits at durango.sh, connect a subscription, or switch fx to your Vercel AI Gateway in Settings → Providers → fx.';
  }
  if (/insufficient_scope/.test(text)) {
    return "Durango inference isn't enabled for this desktop yet. Update Durango Code, or turn off Durango credits for fx in Settings → Providers → fx.";
  }
  if (/model_not_found/.test(text)) {
    return "This model isn't in Durango's catalog. Pick another fx model.";
  }
  const detail =
    stopReason === 'cancelled'
      ? 'was cancelled'
      : stopReason === 'max_tokens'
        ? 'reached the model token limit'
        : stopReason === 'max_turn_requests'
          ? 'reached the maximum turn limit'
          : stopReason === 'refusal' || stopReason === 'refused'
            ? 'was refused'
            : `stopped (${stopReason})`;
  const firstLine = text.split('\n').find((line) => line.trim());
  return firstLine && /^HTTP \d{3}:/.test(firstLine.trim())
    ? `fx turn failed: ${stringifySummary(firstLine.trim(), 300)}`
    : `fx turn ${detail}.`;
};

export const createFxAcpDriver = ({
  child,
  cwd,
  promptText,
  attachments = [],
  resumeSessionId,
  accessMode,
  routes,
  mcpServers = [],
  callbacks,
}) => {
  let nextRequestId = 1;
  const pendingRequests = new Map();
  const toolCalls = new Map();
  let textSeen = false;
  let pendingTextBreak = false;
  // The current message's text, for turning a streamed provider error into
  // the run's failure message.
  let lastMessageId = null;
  let lastMessageText = '';
  // Steering needs the live session and fx's advertised capability.
  let steeringSupported = false;
  let activeSessionId = null;
  let turnActive = false;

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
      title: state.title || fxToolLabel(state.toolName),
      status: state.status ?? 'running',
    };
    if (state.kind) activity.kind = state.kind;
    if (state.detail) activity.detail = state.detail;
    if (state.input) activity.input = state.input;
    if (state.output) activity.output = formatToolOutput(state.output);
    if (state.diff) activity.diff = state.diff;
    return activity;
  };

  const refreshToolPresentation = (state) => {
    const label = fxToolLabel(state.toolName);
    if (state.kind === 'execute' && state.command) {
      state.title = `Command - ${stringifySummary(state.command, 80)}`;
      state.detail = state.command;
    } else if ((state.kind === 'search' || state.kind === 'fetch') && state.query) {
      state.title = `${label} - ${stringifySummary(state.query, 80)}`;
      state.detail = state.query;
    } else if (state.filePath) {
      state.title = `${label} - ${stringifySummary(state.filePath, 80)}`;
      state.detail = state.filePath;
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

    // fx names the tool in `name` and puts a presentation verb ("Writing")
    // in `title`.
    if (typeof update.name === 'string' && update.name) state.toolName = update.name;
    if (typeof update.kind === 'string' && update.kind) {
      state.kind = update.kind === 'write' ? 'edit' : update.kind;
    }

    const rawInput = update.rawInput;
    if (rawInput && typeof rawInput === 'object') {
      state.input = formatToolInput(rawInput);
      if (typeof rawInput.command === 'string') state.command = rawInput.command;
      const filePath = rawInput.file_path ?? rawInput.path;
      if (typeof filePath === 'string') state.filePath = filePath;
      if (typeof rawInput.pattern === 'string') state.query = rawInput.pattern;
      if (typeof rawInput.query === 'string') state.query = rawInput.query;
      if (typeof rawInput.url === 'string') state.query = rawInput.url;
      if (
        state.toolName === 'write_file' &&
        typeof rawInput.path === 'string' &&
        typeof rawInput.content === 'string'
      ) {
        state.diff = { path: rawInput.path, additions: countDiffLines(rawInput.content), deletions: 0 };
      }
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
    if (typeof update.rawOutput === 'string' && update.rawOutput.trim()) {
      state.output = update.rawOutput;
    }

    if (update.status === 'completed') state.status = 'done';
    else if (update.status === 'failed' || update.status === 'cancelled') state.status = 'error';
    else if (update.status === 'pending' || update.status === 'in_progress') {
      if (state.status !== 'error') state.status = 'running';
    }

    refreshToolPresentation(state);
    if (created || state.status !== previousStatus || state.output) {
      callbacks.onActivity(buildActivity(state));
    }
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

  // Approvals are answered by access-mode policy, as in the kimi driver.
  // Full access runs fx's full-access mode and never asks. Read only and
  // Workspace write run fx's ask mode, which requests permission for every
  // change (reads run without asking): Read only allows only read-only
  // kinds; Workspace write allows file changes whose every target resolves
  // inside the workspace, and denies commands outright since their
  // filesystem reach is unknowable.
  const { isInsideWorkspace } = createWorkspaceBoundary(cwd);
  const mutationTargets = (toolCall, known) => {
    const targets = [];
    const record = toolCall.rawInput;
    if (record && typeof record === 'object') {
      for (const key of ['file_path', 'path', 'old_path', 'new_path', 'source', 'destination']) {
        if (typeof record[key] === 'string' && record[key]) targets.push(record[key]);
      }
    }
    for (const location of Array.isArray(toolCall.locations) ? toolCall.locations : []) {
      if (typeof location?.path === 'string' && location.path) targets.push(location.path);
    }
    if (!targets.length && typeof known?.filePath === 'string' && known.filePath) {
      targets.push(known.filePath);
    }
    return targets;
  };
  const answerPermission = (message) => {
    const params = message.params ?? {};
    const toolCall = params.toolCall ?? {};
    const known = typeof toolCall.toolCallId === 'string' ? toolCalls.get(toolCall.toolCallId) : null;
    const kind = toolCall.kind ?? known?.kind;
    const readOnly = kind === 'read' || kind === 'search' || kind === 'fetch' || kind === 'think';
    // Orion's own MCP tools are safe in every mode (see the kimi driver). The
    // qualified name comes from the tool call fx announced, never from a
    // permission title.
    const toolName = typeof known?.toolName === 'string' ? known.toolName : '';
    const isOrionTool =
      toolName.startsWith('mcp__orion__') &&
      isPreapprovedOrionTool(toolName.slice('mcp__orion__'.length), accessMode);
    let allow;
    let denialDetail = "mode doesn't permit this tool.";
    if (isOrionTool || accessMode === 'full-access') {
      allow = true;
    } else if (accessMode !== 'workspace-write') {
      allow = readOnly;
    } else if (readOnly) {
      allow = true;
    } else if (kind === 'execute') {
      allow = false;
    } else {
      const targets = mutationTargets(toolCall, known);
      allow = targets.length > 0 && targets.every(isInsideWorkspace);
      if (!allow) {
        denialDetail = targets.length
          ? 'mode only permits file changes inside the workspace.'
          : 'mode requires a known target path for file changes.';
      }
    }

    // A path-gated approval must never persist ("Allow for this session"
    // would let fx self-approve later calls outside the workspace).
    const pathGated = allow && accessMode === 'workspace-write' && !readOnly && !isOrionTool;
    const options = (Array.isArray(params.options) ? params.options : []).filter(
      (option) => !pathGated || option?.kind !== 'allow_always'
    );
    const pick = (kinds) =>
      kinds.map((wanted) => options.find((option) => option?.kind === wanted)).find(Boolean);
    const chosen = allow ? pick(['allow_once', 'allow_always']) : pick(['reject_once', 'reject_always']);

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
      callbacks.onActivity(buildActivity(known));
    }
  };

  const fail = (error) => {
    callbacks.onFatal(typeof error === 'string' ? error : error?.message ?? 'fx agent protocol error.');
  };

  // Pin the first route fx accepts. The process started on routes[0]
  // (FX_PROVIDER/FX_MODEL), but a resumed session restores its own saved
  // provider and model, so every turn sets both explicitly.
  const pinRoute = async (sessionId) => {
    const rejected = [];
    for (const route of routes) {
      const provider = await request('session/set_config_option', {
        sessionId,
        configId: 'provider',
        value: route.provider,
      });
      if (provider.error) {
        rejected.push({ route, reason: provider.error.message ?? 'unavailable' });
        continue;
      }
      const model = await request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: route.model,
      });
      if (model.error) {
        rejected.push({ route, reason: model.error.message ?? `doesn't serve ${route.model}` });
        continue;
      }
      return { route, rejected };
    }
    return { route: null, rejected };
  };

  const start = async () => {
    const init = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    if (init.error) return fail(init.error);
    steeringSupported = init.result?.agentCapabilities?._meta?.fx?.steering === true;

    let sessionId = null;
    let resumed = false;
    if (resumeSessionId) {
      // session/resume reconnects without replaying history (Orion keeps its
      // own transcript).
      const loaded = await request('session/resume', { sessionId: resumeSessionId, cwd, mcpServers });
      if (loaded.error) callbacks.onResumeFallback?.();
      else {
        sessionId = resumeSessionId;
        resumed = true;
      }
    }
    if (!sessionId) {
      const created = await request('session/new', { cwd, mcpServers });
      if (created.error || typeof created.result?.sessionId !== 'string') {
        return fail(created.error ?? 'fx did not return a session id.');
      }
      sessionId = created.result.sessionId;
    }
    callbacks.onSessionId(sessionId, { resumed });

    const { route, rejected } = await pinRoute(sessionId);
    if (!route) {
      return fail(
        `fx couldn't use any model provider. ${rejected
          .map(({ route: candidate, reason }) => `${candidate.label}: ${reason}`)
          .join(' ')}`
      );
    }
    // A connected subscription that doesn't serve this model (e.g. a -pro
    // variant) is worth saying, since the turn is now billed instead.
    if (rejected.length) {
      const skipped = rejected.map(({ route: candidate }) => candidate.label).join(' and ');
      callbacks.onNotice?.(`_${skipped} can't run this model; fx is using ${route.label}._\n\n`);
    }
    callbacks.onRoute?.(route);

    const setMode = await request('session/set_mode', {
      sessionId,
      modeId: accessMode === 'full-access' ? 'full-access' : 'ask',
    });
    if (setMode.error) {
      return fail(setMode.error.message ?? `fx could not enable ${accessMode} permission mode.`);
    }

    const prompt = await buildKimiPromptBlocks(promptText, attachments);
    activeSessionId = sessionId;
    turnActive = true;
    const response = await request('session/prompt', { sessionId, prompt });
    turnActive = false;
    if (response.error) return fail(response.error);
    const stopReason = response.result?.stopReason;
    if (stopReason && stopReason !== 'end_turn') {
      return fail(fxFailureMessage(stopReason, lastMessageText));
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
      if (update.messageId !== lastMessageId) {
        lastMessageId = update.messageId;
        lastMessageText = '';
      }
      lastMessageText += text;
      const prefix = pendingTextBreak && textSeen ? '\n\n' : '';
      pendingTextBreak = false;
      textSeen = true;
      callbacks.onText(`${prefix}${text}`);
      return;
    }
    if (kind === 'user_message_chunk') {
      // A steering message fx just folded in: what follows is a new paragraph.
      if (textSeen) pendingTextBreak = true;
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      // Text resuming after tool activity is a new paragraph.
      if (textSeen) pendingTextBreak = true;
      upsertToolCall(update);
      return;
    }
    if (kind === 'plan') {
      handlePlanUpdate(update.entries);
    }
    // available_commands_update / session_info_update / usage_update are
    // session bookkeeping — nothing to surface.
  };

  // Fold a message into the running turn. Resolves true once fx has taken
  // it (it applies steering at its next model boundary, continuing the turn
  // if the model had already finished), false when it can't be steered so
  // the caller sends it as the next turn instead. The steer's own response
  // only arrives with the end of the turn; one that wasn't absorbed is
  // reported so the message isn't silently dropped.
  const steer = async (text, steerAttachments = []) => {
    if (!steeringSupported || !turnActive || !activeSessionId) return false;
    if (typeof text !== 'string' || !text) return false;
    const prompt = await buildKimiPromptBlocks(text, steerAttachments);
    if (!turnActive) return false;
    const absorbed = (reply) => !reply.error && reply.result?._meta?.fx?.steering === 'absorbed';
    const response = request('session/prompt', {
      sessionId: activeSessionId,
      prompt,
      _meta: { fx: { steer: true } },
    });
    const early = await Promise.race([
      response,
      new Promise((resolve) => setTimeout(() => resolve(null), FX_STEER_REJECTION_WINDOW_MS)),
    ]);
    if (early) return absorbed(early);
    void response.then((reply) => {
      if (!absorbed(reply)) {
        callbacks.onNotice?.("_fx couldn't apply a steering message before the turn ended; send it again._\n\n");
      }
    });
    return true;
  };

  return { start, handleMessage, steer };
};

// One-shot, tool-free fx text turn over ACP (ask mode, every permission
// denied), used for thread titles and commit messages. Resolves with the
// response text, or '' on failure. Cancellation waits for the child to exit
// so callers may safely tear down its cwd.
export const fxReadOnlyOneShot = async (model, promptText, cwd, { signal, threadId } = {}) => {
  if (signal?.aborted) return '';
  let launch;
  try {
    launch = await prepareFxLaunch({ slug: model.slug, accessMode: 'read-only' });
  } catch {
    return '';
  }
  if (signal?.aborted) return '';
  return new Promise((resolve) => {
    const child = spawn(loginShell, ['-lc', 'fx acp'], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...launch.env },
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
    const driver = createFxAcpDriver({
      child,
      cwd,
      promptText,
      resumeSessionId: null,
      accessMode: 'read-only',
      routes: launch.routes,
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
