import { protocol } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { countDiffLines, formatToolInput, formatToolOutput, stringifySummary } from './stream-adapters.js';
import { grokSessionModeForAccessMode } from './grok-access-mode.js';
import { isPreapprovedOrionTool } from './thread-reader-routing.js';

// --- grok: <session dir>/updates.jsonl holds raw session/update lines -------

export const grokSubagentUpdatesFile = (projectPath, childSessionId) =>
  path.join(
    os.homedir(),
    '.grok',
    'sessions',
    encodeURIComponent(String(projectPath)),
    childSessionId,
    'updates.jsonl'
  );

// Compact sibling of the ACP driver's upsertToolCall — same update shapes,
// minus streaming-argument previews and permission states, which never
// appear in a subagent's persisted updates file.
export const handleGrokSubagentLine = (value, api, ctx) => {
  const update = value?.params?.update;
  if (!update || typeof update !== 'object') return;
  const kind = update.sessionUpdate;

  if (kind === 'user_message_chunk') {
    // The first user message is the spawn prompt — surface it as metadata
    // (the subagent_spawned notification itself only carries a description).
    if (!ctx.promptSeen) {
      ctx.promptSeen = true;
      const text = update.content?.text;
      if (typeof text === 'string' && text) api.prompt(text);
    }
    return;
  }
  if (kind === 'agent_thought_chunk') {
    const text = update.content?.text;
    if (typeof text === 'string' && text) api.reasoning(text);
    return;
  }
  if (kind === 'agent_message_chunk') {
    const text = update.content?.text;
    if (typeof text !== 'string' || !text) return;
    api.text(ctx.pendingBreak && ctx.textSeen ? `\n\n${text}` : text);
    ctx.pendingBreak = false;
    ctx.textSeen = true;
    return;
  }
  if (kind === 'plan') {
    const list = Array.isArray(update.entries) ? update.entries : [];
    const completed = list.filter((entry) => entry?.status === 'completed').length;
    api.activity({
      key: 'plan',
      type: 'plan',
      kind: 'plan',
      title: `Tasks (${completed}/${list.length})`,
      status: list.length > 0 && completed === list.length ? 'done' : 'running',
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
    return;
  }
  if (kind !== 'tool_call' && kind !== 'tool_call_update') return;

  if (ctx.textSeen) ctx.pendingBreak = true;
  const id = update.toolCallId;
  if (typeof id !== 'string' || !id) return;
  if (!ctx.calls) ctx.calls = new Map();
  let state = ctx.calls.get(id);
  if (!state) {
    state = { status: 'running' };
    ctx.calls.set(id, state);
  }

  const meta = update._meta?.['x.ai/tool'] ?? null;
  if (typeof meta?.name === 'string') state.toolName = meta.name;
  else if (kind === 'tool_call' && typeof update.title === 'string' && GROK_TOOL_LABELS[update.title]) {
    state.toolName = update.title;
  }
  const toolKind = update.kind ?? meta?.kind ?? state.kind ?? grokToolKindForName(state.toolName);
  if (toolKind) state.kind = toolKind === 'write' ? 'edit' : toolKind;
  if (typeof update.title === 'string' && update.title) state.grokTitle = update.title;

  const rawInput = update.rawInput;
  if (rawInput && typeof rawInput === 'object') {
    state.input = formatToolInput(rawInput);
    if (typeof rawInput.command === 'string') state.command = rawInput.command;
    const filePath = rawInput.file_path ?? rawInput.path;
    if (typeof filePath === 'string') state.filePath = filePath;
    if (typeof rawInput.query === 'string') state.query = rawInput.query;
    if (typeof rawInput.url === 'string') state.query = rawInput.url;
  }
  if (Array.isArray(update.content)) {
    for (const entry of update.content) {
      if (entry?.type === 'diff' && typeof entry.path === 'string') {
        state.filePath = entry.path;
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
  if (rawOutput && typeof rawOutput === 'object') {
    if (typeof rawOutput.exit_code === 'number') state.exitCode = rawOutput.exit_code;
    if (
      !state.output &&
      typeof rawOutput.output_for_prompt === 'string' &&
      rawOutput.output_for_prompt.trim()
    ) {
      state.output = rawOutput.output_for_prompt;
    }
  }
  if (update.status === 'completed') state.status = 'done';
  else if (update.status === 'failed' || update.status === 'cancelled') state.status = 'error';
  if (typeof state.exitCode === 'number' && state.exitCode !== 0) state.status = 'error';

  const label = state.toolName
    ? grokToolLabel(state.toolName)
    : { execute: 'Command', edit: 'Edit', read: 'Read', search: 'Web search', fetch: 'Web fetch', task: 'Subagent' }[
        state.kind
      ] ?? 'Tool';
  const activity = {
    key: id,
    type: state.kind === 'execute' ? 'command' : 'tool',
    title:
      state.kind === 'execute' && state.command
        ? `Command - ${stringifySummary(state.command, 80)}`
        : (state.kind === 'search' || state.kind === 'fetch') && state.query
          ? `${label} - ${stringifySummary(state.query, 80)}`
          : state.filePath
            ? `${label} - ${stringifySummary(state.filePath, 80)}`
            : state.grokTitle || label,
    status: state.status,
  };
  if (state.kind) activity.kind = state.kind;
  if (state.command) activity.detail = state.command;
  else if (state.query) activity.detail = state.query;
  else if (state.filePath) activity.detail = state.filePath;
  if (state.input) activity.input = state.input;
  if (state.output) activity.output = formatToolOutput(state.output);
  if (typeof state.exitCode === 'number') activity.exitCode = state.exitCode;
  if (state.diff) activity.diff = state.diff;
  api.activity(activity);
};

// ---------------------------------------------------------------------------
// Grok ACP driver. grok's headless streaming-json format only ever emits
// token-level thought/text events — no tool calls — so real turns run
// `grok agent stdio` and speak ACP (line-delimited JSON-RPC) instead. That
// stream carries tool calls with live terminal output and file diffs, plan
// (todo-list) updates, streaming tool-argument deltas, permission requests
// Orion answers programmatically, and per-turn token counts. The driver
// translates ACP messages into the same normalized turn events the other
// providers' adapters produce.

export const GROK_TOOL_LABELS = {
  write: 'Write',
  edit: 'Edit',
  read: 'Read',
  run_terminal_command: 'Command',
  web_search: 'Web search',
  web_fetch: 'Web fetch',
  task: 'Subagent',
};

export const grokToolKindForName = (name) => {
  if (name === 'write' || name === 'edit') return 'edit';
  if (name === 'run_terminal_command') return 'execute';
  if (name === 'read') return 'read';
  if (name === 'web_search') return 'search';
  if (name === 'web_fetch') return 'fetch';
  if (name === 'task') return 'task';
  return undefined;
};

export const grokToolLabel = (name) => {
  if (!name) return 'Tool';
  return (
    GROK_TOOL_LABELS[name] ??
    name.replace(/_/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase())
  );
};

export const grokStatsFromPromptMeta = (meta) => {
  if (!meta || typeof meta !== 'object') return null;
  const stats = {};
  for (const key of [
    'totalTokens',
    'inputTokens',
    'outputTokens',
    'cachedReadTokens',
    'reasoningTokens',
  ]) {
    if (typeof meta[key] === 'number') stats[key] = meta[key];
  }
  if (typeof meta.modelId === 'string') stats.modelId = meta.modelId;
  return Object.keys(stats).length ? stats : null;
};

export const createGrokAcpDriver = ({ child, cwd, promptText, resumeSessionId, accessMode, callbacks }) => {
  let nextRequestId = 1;
  const pendingRequests = new Map();
  const toolCalls = new Map();
  const toolIndexToCallId = new Map();
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

  const toolMeta = (value) =>
    value && typeof value === 'object' ? value._meta?.['x.ai/tool'] ?? null : null;

  const buildActivity = (state) => {
    const activity = {
      key: state.id,
      type: state.kind === 'execute' ? 'command' : 'tool',
      title: state.title || grokToolLabel(state.toolName),
      status: state.status ?? 'running',
    };
    if (state.kind) activity.kind = state.kind;
    if (state.detail) activity.detail = state.detail;
    // The expanded row shows the whole call: its arguments and what it
    // returned. Both are capped so a chatty command or a whole-file write
    // doesn't bloat the persisted store.
    if (state.input) activity.input = state.input;
    if (state.output) activity.output = formatToolOutput(state.output);
    if (typeof state.exitCode === 'number') activity.exitCode = state.exitCode;
    if (state.diff) activity.diff = state.diff;
    if (state.sources?.length) activity.sources = state.sources;
    return activity;
  };

  // Streaming terminal output can update many times a second; throttle
  // output-only refreshes like the reasoning card, but always emit status
  // changes immediately.
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
    // Backend tools (web search) never stream a tool name — fall back to a
    // label derived from the ACP kind.
    const kindLabels = {
      execute: 'Command',
      edit: 'Edit',
      read: 'Read',
      search: 'Web search',
      fetch: 'Web fetch',
      task: 'Subagent',
    };
    const label = state.toolName
      ? grokToolLabel(state.toolName)
      : kindLabels[state.kind] ?? 'Tool';
    // Drop the transient "Preparing…" detail once the real tool call lands —
    // tools with no path/command/query (e.g. todo updates) would otherwise
    // keep it forever.
    if (!state.preparing && state.preparingDetail) {
      state.detail = undefined;
      state.preparingDetail = false;
    }
    if (state.kind === 'execute' && state.command) {
      state.title = `Command - ${stringifySummary(state.command, 80)}`;
      state.detail = state.command;
    } else if ((state.kind === 'search' || state.kind === 'fetch') && state.query) {
      state.title = `${label} - ${stringifySummary(state.query, 80)}`;
      state.detail = state.query;
    } else if (state.filePath) {
      state.title = `${label} - ${stringifySummary(state.filePath, 80)}`;
      state.detail = state.filePath;
    } else if (state.preparing) {
      // Argument deltas stream before the tool_call lands — show the tool as
      // soon as the model starts writing its input (a large file write can
      // take a while to generate).
      state.title = label;
      state.detail = state.argsLength
        ? `Preparing… (${state.argsLength.toLocaleString()} chars)`
        : 'Preparing…';
      state.preparingDetail = true;
    } else if (state.grokTitle) {
      state.title = state.grokTitle;
    }
  };

  const getToolState = (id) => {
    let state = toolCalls.get(id);
    if (!state) {
      state = { id, status: 'running', preparing: false, argsLength: 0 };
      toolCalls.set(id, state);
    }
    return state;
  };

  const upsertToolCall = (update, isNew) => {
    const id = update.toolCallId;
    if (typeof id !== 'string' || !id) return;
    const created = !toolCalls.has(id);
    const state = getToolState(id);
    const previousStatus = state.status;
    state.preparing = false;

    const meta = toolMeta(update);
    if (typeof meta?.name === 'string') state.toolName = meta.name;
    else if (isNew && typeof update.title === 'string' && GROK_TOOL_LABELS[update.title]) {
      state.toolName = update.title;
    }
    const kind = update.kind ?? meta?.kind ?? state.kind ?? grokToolKindForName(state.toolName);
    if (kind) state.kind = kind === 'write' ? 'edit' : kind;
    if (typeof update.title === 'string' && update.title) state.grokTitle = update.title;

    const rawInput = update.rawInput;
    if (rawInput && typeof rawInput === 'object') {
      state.input = formatToolInput(rawInput);
      if (typeof rawInput.command === 'string') state.command = rawInput.command;
      const filePath = rawInput.file_path ?? rawInput.path;
      if (typeof filePath === 'string') state.filePath = filePath;
      if (typeof rawInput.query === 'string') state.query = rawInput.query;
      if (typeof rawInput.url === 'string') state.query = rawInput.url;
      // use_tool indirection: the real MCP tool name (e.g.
      // orion__spawn_subagent) only appears here, and answerPermission needs
      // it to recognize Orion's own spawn tool.
      if (typeof rawInput.tool_name === 'string') state.rawInputToolName = rawInput.tool_name;
    }

    if (Array.isArray(update.content)) {
      for (const entry of update.content) {
        if (entry?.type === 'diff' && typeof entry.path === 'string') {
          state.filePath = entry.path;
          state.diff = {
            path: entry.path,
            additions: countDiffLines(entry.newText),
            deletions: countDiffLines(entry.oldText),
          };
        }
        // Terminal output streams as cumulative text snapshots.
        if (entry?.type === 'content' && typeof entry.content?.text === 'string' && entry.content.text) {
          state.output = entry.content.text;
        }
      }
    }

    const rawOutput = update.rawOutput;
    if (rawOutput && typeof rawOutput === 'object') {
      if (typeof rawOutput.exit_code === 'number') state.exitCode = rawOutput.exit_code;
      if (
        !state.output &&
        typeof rawOutput.output_for_prompt === 'string' &&
        rawOutput.output_for_prompt.trim()
      ) {
        state.output = rawOutput.output_for_prompt;
      }
      const action = rawOutput.action;
      if (action && typeof action === 'object') {
        if (typeof action.query === 'string') state.query = action.query;
        if (Array.isArray(action.sources)) {
          const sources = action.sources
            .map((source) => (typeof source?.url === 'string' ? { url: source.url } : null))
            .filter(Boolean);
          if (sources.length) state.sources = sources;
        }
      }
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

  const handleXaiUpdate = (update) => {
    const kind = update?.sessionUpdate;
    if (kind === 'tool_call_delta_chunk') {
      if (typeof update.tool_index === 'number' && typeof update.tool_call_id === 'string') {
        toolIndexToCallId.set(update.tool_index, update.tool_call_id);
      }
      const callId =
        typeof update.tool_call_id === 'string'
          ? update.tool_call_id
          : toolIndexToCallId.get(update.tool_index);
      if (!callId) return;
      const created = !toolCalls.has(callId);
      const state = getToolState(callId);
      if (created) state.preparing = true;
      if (!state.preparing) return;
      if (typeof update.name === 'string' && update.name) {
        state.toolName = update.name;
        state.kind = grokToolKindForName(update.name);
      }
      if (typeof update.arguments_delta === 'string') {
        state.argsLength = (state.argsLength ?? 0) + update.arguments_delta.length;
      }
      refreshToolPresentation(state);
      emitToolActivity(state, created);
      return;
    }
    if (kind === 'pending_interaction' && update.kind === 'permission') {
      const state = toolCalls.get(update.tool_call_id);
      if (state && state.status === 'running') {
        state.status = 'waiting';
        emitToolActivity(state, true);
      }
      return;
    }
    if (kind === 'interaction_resolved') {
      const state = toolCalls.get(update.tool_call_id);
      if (state && state.status === 'waiting') {
        state.status = 'running';
        emitToolActivity(state, true);
      }
    }
  };

  // Approvals are answered by access-mode policy: Read only allows read-only
  // tools; Workspace write additionally allows edits but not commands. This
  // replaces the old headless behavior where a denied tool cancelled the
  // whole turn — now the model is told no and keeps going.
  const answerPermission = (message) => {
    const params = message.params ?? {};
    const toolCall = params.toolCall ?? {};
    const meta = toolMeta(toolCall);
    const known = typeof toolCall.toolCallId === 'string' ? toolCalls.get(toolCall.toolCallId) : null;
    const kind = toolCall.kind ?? meta?.kind ?? known?.kind;
    const readOnly =
      meta?.read_only === true || kind === 'read' || kind === 'search' || kind === 'fetch';
    // Orion's own MCP tools are safe in every mode: the spawned subthread
    // runs with the driver thread's access mode, never more; stopping one
    // only halts Orion's own child run; read_thread only reads persisted
    // transcripts. Grok routes MCP calls through use_tool, whose
    // rawInput.tool_name is the qualified MCP identity. Titles and wrapper
    // metadata are presentation fields and must not grant an exemption.
    const grokMcpToolName =
      typeof toolCall.rawInput?.tool_name === 'string'
        ? toolCall.rawInput.tool_name
        : known?.rawInputToolName;
    // The Durango Chat tools follow the same rule (`remember` excluded in
    // Read only — see thread-reader-routing.js).
    const isOrionSpawn =
      typeof grokMcpToolName === 'string' &&
      grokMcpToolName.startsWith('orion__') &&
      isPreapprovedOrionTool(grokMcpToolName.slice('orion__'.length), accessMode);
    const allow =
      isOrionSpawn || accessMode === 'full-access'
        ? true
        : accessMode === 'workspace-write'
          ? readOnly || kind !== 'execute'
          : readOnly;

    const options = Array.isArray(params.options) ? params.options : [];
    const pick = (kinds, pattern) =>
      kinds.map((wanted) => options.find((option) => option?.kind === wanted)).find(Boolean) ??
      options.find((option) => pattern.test(`${option?.optionId ?? ''} ${option?.name ?? ''}`));
    const chosen = allow
      ? pick(['allow_once', 'allow_always'], /allow|approve|yes/i) ?? options[0]
      : pick(['reject_once', 'reject_always'], /reject|deny|no/i);

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
      } mode doesn't permit this tool. Switch to Full Access to allow it.`;
      emitToolActivity(known, true);
    }
  };

  const fail = (error) => {
    flushToolEmits();
    callbacks.onFatal(
      typeof error === 'string' ? error : error?.message ?? 'Grok agent protocol error.'
    );
  };

  const start = async () => {
    const init = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    if (init.error) return fail(init.error);

    let sessionId = null;
    if (resumeSessionId) {
      replayingSession = true;
      const loaded = await request('session/load', {
        sessionId: resumeSessionId,
        cwd,
        mcpServers: [],
      });
      replayingSession = false;
      if (loaded.error) callbacks.onResumeFallback?.();
      else sessionId = resumeSessionId;
    }
    if (!sessionId) {
      const created = await request('session/new', { cwd, mcpServers: [] });
      if (created.error || typeof created.result?.sessionId !== 'string') {
        return fail(created.error ?? 'Grok agent did not return a session id.');
      }
      sessionId = created.result.sessionId;
    }
    callbacks.onSessionId(sessionId);

    // Grok's plan mode is an interactive implementation-planning workflow:
    // it writes plan.md and waits for an exit-plan approval. Gated modes use
    // normal answer behavior; their CLI permission mode and answerPermission
    // above enforce the tool policy instead.
    // Full access is covered by --always-approve at spawn.
    const sessionModeId = grokSessionModeForAccessMode(accessMode);
    if (sessionModeId) {
      await request('session/set_mode', {
        sessionId,
        modeId: sessionModeId,
      });
    }

    const response = await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: promptText }],
    });
    flushToolEmits();
    if (response.error) return fail(response.error);
    callbacks.onTurnEnd(response.result ?? {});
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
    const update =
      message.method === 'session/update' || message.method === '_x.ai/session_notification'
        ? message.params?.update
        : null;
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
      // Text resuming after tool activity is a new paragraph.
      if (textSeen) pendingTextBreak = true;
      upsertToolCall(update, kind === 'tool_call');
      return;
    }
    if (kind === 'plan') {
      handlePlanUpdate(update.entries);
      return;
    }
    // Subagent lifecycle (_x.ai notifications): handled by the run's
    // subagent tracker, which tails the child session's updates.jsonl.
    if (kind === 'subagent_spawned' || kind === 'subagent_finished') {
      callbacks.onSubagent?.(update);
      return;
    }
    handleXaiUpdate(update);
  };

  return { start, handleMessage };
};
