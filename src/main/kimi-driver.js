import { protocol } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { getMimeTypeForMediaPath } from './media.js';
import { killAgentChild } from './run-registry.js';
import { isPreapprovedOrionTool } from './thread-reader-routing.js';
import { findKimiSessionIndexEntry } from './session-fork.js';
import { loginShell } from './shell-env.js';
import { countDiffLines, formatToolInput, formatToolOutput, stringifySummary } from './stream-adapters.js';

// ---------------------------------------------------------------------------
// Kimi ACP driver. kimi's prompt mode (`kimi -p --output-format stream-json`)
// only emits whole chat messages — no streaming deltas, thinking, tool
// progress, or permission dialog — so real turns run `kimi acp` and speak ACP
// (line-delimited JSON-RPC) instead. That stream carries token-level text and
// thought chunks, tool calls with streamed argument previews, live status and
// terminal output, plan (todo) updates, and permission requests Orion answers
// programmatically. Model (session/set_config_option, configId "model") and
// permission mode (session/set_mode: plan/default/yolo) are pinned per
// session over the dialog; verified live on kimi-code 0.26.0.

export const KIMI_TOOL_KINDS = {
  Bash: 'execute',
  Read: 'read',
  ReadMediaFile: 'read',
  Write: 'edit',
  Edit: 'edit',
  Grep: 'search',
  Glob: 'search',
  WebSearch: 'search',
  FetchURL: 'fetch',
  Agent: 'task',
  AgentSwarm: 'task',
};

export const KIMI_TOOL_LABELS = {
  Bash: 'Command',
  Read: 'Read',
  ReadMediaFile: 'Read media',
  Write: 'Write',
  Edit: 'Edit',
  Grep: 'Grep',
  Glob: 'Glob',
  WebSearch: 'Web search',
  FetchURL: 'Web fetch',
  Agent: 'Subagent',
  AgentSwarm: 'Subagent swarm',
  TodoList: 'Tasks',
  Skill: 'Skill',
  AskUserQuestion: 'Question',
};

export const kimiToolLabel = (name) => {
  if (!name) return 'Tool';
  return (
    KIMI_TOOL_LABELS[name] ??
    String(name)
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^\w/, (letter) => letter.toUpperCase())
  );
};

// Cumulative session token usage from the session's on-disk wire log — the
// ACP prompt response carries no usage metadata, but kimi appends a
// usage.record entry per LLM step. Summing the whole file gives cumulative
// totals for the session, matching how codex reports thread token usage.
export const kimiStatsFromSessionDisk = async (sessionId) => {
  try {
    const entry = await findKimiSessionIndexEntry(sessionId);
    if (!entry?.sessionDir) return null;
    const wirePath = path.join(entry.sessionDir, 'agents', 'main', 'wire.jsonl');
    const content = await fs.readFile(wirePath, 'utf8');
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedReadTokens = 0;
    let modelId = null;
    let seen = false;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('"usage.record"')) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const record = parsed?.type === 'context.append_loop_event' ? parsed.event : parsed;
      if (record?.type !== 'usage.record' || !record.usage || typeof record.usage !== 'object') {
        continue;
      }
      seen = true;
      const usage = record.usage;
      inputTokens +=
        (usage.inputOther ?? 0) + (usage.inputCacheRead ?? 0) + (usage.inputCacheCreation ?? 0);
      outputTokens += usage.output ?? 0;
      cachedReadTokens += usage.inputCacheRead ?? 0;
      if (typeof record.model === 'string' && record.model) modelId = record.model;
    }
    if (!seen) return null;
    const stats = {
      inputTokens,
      outputTokens,
      cachedReadTokens,
      totalTokens: inputTokens + outputTokens,
    };
    if (modelId) stats.modelId = modelId;
    return stats;
  } catch {
    return null;
  }
};

// kimi's ACP layer reports a failed turn as a clean `end_turn` unless the
// failure is an auth error (turnEndReasonToStopReason maps `failed` →
// `end_turn`, verified on kimi-code 0.26.0), so a provider outage or API
// error looks identical to a successful empty response on the wire. The
// real error is only recorded in the session's log file:
//   WARN  acp: turn ended with failed reason  error="{\"code\":...}"
// Capture the current end of the session log before prompting so the
// completion check can inspect only records appended by this turn. A byte
// cursor avoids timestamp tolerances that can accidentally include a prior
// failed turn when the user retries quickly.
export const kimiTurnFailureLogCursor = async (sessionId) => {
  try {
    const entry = await findKimiSessionIndexEntry(sessionId);
    if (!entry?.sessionDir) return 0;
    const logPath = path.join(entry.sessionDir, 'logs', 'kimi-code.log');
    const stat = await fs.stat(logPath);
    return stat.size;
  } catch {
    return 0;
  }
};

// Returns the error appended after `logCursor`, or null if this turn added no
// failure. If kimi rotates/truncates the log during the turn, scan the new
// file from its beginning rather than retaining an invalid cursor.
export const kimiTurnFailureFromSessionDisk = async (sessionId, logCursor = 0) => {
  try {
    const entry = await findKimiSessionIndexEntry(sessionId);
    if (!entry?.sessionDir) return null;
    const logPath = path.join(entry.sessionDir, 'logs', 'kimi-code.log');
    const bytes = await fs.readFile(logPath);
    const offset =
      Number.isSafeInteger(logCursor) && logCursor >= 0 && logCursor <= bytes.length
        ? logCursor
        : 0;
    const content = bytes.subarray(offset).toString('utf8');
    const marker = 'acp: turn ended with failed reason';
    let lastError = null;
    for (const line of content.split('\n')) {
      if (!line.includes(marker)) continue;
      const match = line.match(/error="(.*)"\s*$/);
      if (!match) {
        lastError = 'Kimi turn failed.';
        continue;
      }
      try {
        // The logged value is a JSON object with backslash-escaped quotes —
        // a valid JSON string body, so unescape it with one string parse
        // and then parse the object it contains.
        const parsed = JSON.parse(JSON.parse(`"${match[1]}"`));
        lastError = typeof parsed?.message === 'string' && parsed.message ? parsed.message : 'Kimi turn failed.';
      } catch {
        lastError = 'Kimi turn failed.';
      }
    }
    return lastError;
  } catch {
    return null;
  }
};

// --- kimi native subagents (Agent / AgentSwarm tools) ------------------------
// Each spawned subagent runs as an in-process loop with its own wire log at
// <sessionDir>/agents/<agentId>/wire.jsonl (the main agent's transcript lives
// under agents/main/). Spawns are detected by watching the agents/ directory;
// pre-existing agents are baselined only for resumed sessions. For new
// sessions, an agent may appear while the session-index watcher is attaching,
// so existing directories must still be emitted.

export const watchKimiSubagentSpawns = ({ sessionDir, baselineExisting, onSpawn }) => {
  const seen = new Set(['main']);
  const agentsDir = path.join(sessionDir, 'agents');
  if (baselineExisting) {
    try {
      for (const name of readdirSync(agentsDir)) seen.add(name);
    } catch {
      // agents/ not created yet; the poller picks it up when it appears.
    }
  }
  let stopped = false;
  let polling = false;

  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      let entries;
      try {
        entries = await fs.readdir(agentsDir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (seen.has(name)) continue;
        seen.add(name);
        onSpawn({
          agentId: name,
          wirePath: path.join(agentsDir, name, 'wire.jsonl'),
        });
      }
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(() => void poll(), 1000);
  void poll();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
};

// Translate a subagent's wire.jsonl into subagent turn events. Loop events
// are wrapped in context.append_loop_event envelopes; unwrap before matching.
export const handleKimiSubagentLine = (value, api, ctx) => {
  if (!value || typeof value !== 'object') return;
  const event = value.type === 'context.append_loop_event' ? value.event : value;
  if (!event || typeof event !== 'object') return;

  if (event.type === 'turn.prompt') {
    if (!ctx.promptSeen) {
      ctx.promptSeen = true;
      const text = (Array.isArray(event.input) ? event.input : [])
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join('');
      if (text) api.prompt(text);
    }
    return;
  }

  if (event.type === 'content.part') {
    const part = event.part;
    if (part?.type === 'think' && typeof part.think === 'string' && part.think) {
      api.reasoning(`${part.think}\n\n`);
    } else if (part?.type === 'text' && typeof part.text === 'string' && part.text) {
      api.text(ctx.textSeen ? `\n\n${part.text}` : part.text);
      ctx.textSeen = true;
    }
    return;
  }

  if (event.type === 'tool.call') {
    const name = typeof event.name === 'string' ? event.name : '';
    const args = event.args && typeof event.args === 'object' ? event.args : {};
    const kind = KIMI_TOOL_KINDS[name];
    const label = kimiToolLabel(name);
    const detail =
      typeof args.command === 'string'
        ? args.command
        : typeof args.path === 'string'
          ? args.path
          : typeof args.query === 'string'
            ? args.query
            : typeof args.url === 'string'
              ? args.url
              : undefined;
    const activity = {
      key: typeof event.toolCallId === 'string' ? event.toolCallId : undefined,
      type: kind === 'execute' ? 'command' : 'tool',
      title: detail ? `${label} - ${stringifySummary(detail, 80)}` : label,
      status: 'running',
    };
    if (kind) activity.kind = kind;
    if (detail) activity.detail = detail;
    const input = formatToolInput(event.args);
    if (input) activity.input = input;
    api.activity(activity);
    return;
  }

  if (event.type === 'tool.result') {
    if (typeof event.toolCallId === 'string') {
      api.activity({
        updateForKey: event.toolCallId,
        type: 'result',
        title: 'Tool result',
        output: formatToolOutput(event.result?.content ?? event.result),
        status: event.result?.isError ? 'error' : 'done',
      });
    }
    return;
  }

  if (event.type === 'usage.record') {
    const usage = event.usage;
    if (usage && typeof usage === 'object') {
      ctx.totalTokens =
        (ctx.totalTokens ?? 0) +
        (usage.inputOther ?? 0) +
        (usage.inputCacheRead ?? 0) +
        (usage.inputCacheCreation ?? 0) +
        (usage.output ?? 0);
      api.stats({ totalTokens: ctx.totalTokens });
    }
    return;
  }

  // A step that ends without requesting tools is the end of the subagent's
  // loop — there is no dedicated finish marker in the wire log.
  if (event.type === 'step.end') {
    if (typeof event.finishReason === 'string' && event.finishReason !== 'tool_use') {
      api.finish({ status: 'done' });
    }
  }
};

export const buildKimiPromptBlocks = async (promptText, attachments = []) => {
  const blocks = [{ type: 'text', text: promptText }];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const filePath = typeof attachment?.path === 'string' ? attachment.path : '';
    if (!filePath) continue;

    const declaredMimeType = String(attachment?.mimeType || '').trim().toLowerCase();
    const inferredMimeType = getMimeTypeForMediaPath(filePath);
    const mimeType =
      declaredMimeType.startsWith('image/') && declaredMimeType !== 'image/*'
        ? declaredMimeType
        : inferredMimeType;
    if (!mimeType.startsWith('image/')) continue;

    try {
      const data = await fs.readFile(filePath);
      blocks.push({ type: 'image', data: data.toString('base64'), mimeType });
    } catch (error) {
      // The text prompt still contains the local path, so a failed inline read
      // can fall back to Kimi's ReadMediaFile tool instead of failing the turn.
      console.warn(`Kimi could not inline attachment "${filePath}".`, error);
    }
  }
  return blocks;
};

export const createKimiAcpDriver = ({
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
      title: state.title || kimiToolLabel(state.toolName),
      status: state.status ?? 'running',
    };
    if (state.kind) activity.kind = state.kind;
    if (state.detail) activity.detail = state.detail;
    // The expanded row shows the whole call: its arguments and what it
    // returned. Both are capped so a chatty command or a whole-file write
    // doesn't bloat the persisted store. Before the real input lands, the
    // streamed argument preview is the only view of the call there is.
    const input = state.input ?? formatToolInput(state.argsPreview);
    if (input) activity.input = input;
    if (state.output) activity.output = formatToolOutput(state.output);
    if (typeof state.exitCode === 'number') activity.exitCode = state.exitCode;
    if (state.diff) activity.diff = state.diff;
    return activity;
  };

  // Streamed argument previews and terminal output can update many times a
  // second; throttle output-only refreshes like the reasoning card, but
  // always emit status changes immediately.
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
    const label = kimiToolLabel(state.toolName);
    // Drop the transient "Preparing…" detail once the real input lands.
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
      // Argument previews stream before the full input lands — show the tool
      // as soon as the model starts writing its input (a large file write can
      // take a while to generate).
      state.title = label;
      state.detail = state.argsLength
        ? `Preparing… (${state.argsLength.toLocaleString()} chars)`
        : 'Preparing…';
      state.preparingDetail = true;
    } else if (state.kimiTitle && !KIMI_TOOL_LABELS[state.kimiTitle]) {
      state.title = state.kimiTitle;
    }
  };

  const upsertToolCall = (update, isNew) => {
    const id = update.toolCallId;
    if (typeof id !== 'string' || !id) return;
    const created = !toolCalls.has(id);
    let state = toolCalls.get(id);
    if (!state) {
      state = { id, status: 'running', preparing: true, argsLength: 0 };
      toolCalls.set(id, state);
    }
    const previousStatus = state.status;

    // The initial tool_call announces the tool by name in its title; later
    // updates may replace the title with a human summary ("Running: …").
    if (typeof update.title === 'string' && update.title) {
      if (isNew || KIMI_TOOL_LABELS[update.title]) state.toolName = state.toolName ?? update.title;
      state.kimiTitle = update.title;
    }
    const kind = update.kind ?? state.kind ?? KIMI_TOOL_KINDS[state.toolName];
    if (kind) state.kind = kind === 'write' ? 'edit' : kind;

    const rawInput = update.rawInput;
    if (rawInput && typeof rawInput === 'object') {
      state.preparing = false;
      state.input = formatToolInput(rawInput);
      if (typeof rawInput.command === 'string') state.command = rawInput.command;
      const filePath = rawInput.file_path ?? rawInput.path;
      if (typeof filePath === 'string') state.filePath = filePath;
      if (typeof rawInput.query === 'string') state.query = rawInput.query;
      if (typeof rawInput.url === 'string') state.query = rawInput.url;
    }

    const terminal =
      update.status === 'completed' || update.status === 'failed' || update.status === 'cancelled';
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
          if (state.preparing && !terminal) {
            // Streamed tool-argument preview (partial JSON), not output.
            // Kept whole: it is the only place the target path is visible
            // when the permission request arrives (rawInput lands only after
            // the tool is approved).
            state.argsLength = entry.content.text.length;
            state.argsPreview = entry.content.text;
          } else {
            state.output = entry.content.text;
          }
        }
      }
    }

    // kimi's rawOutput is the tool's output snapshot (string or object).
    const rawOutput = update.rawOutput;
    if (typeof rawOutput === 'string' && rawOutput.trim()) {
      state.output = rawOutput;
    } else if (rawOutput && typeof rawOutput === 'object') {
      if (typeof rawOutput.exit_code === 'number') state.exitCode = rawOutput.exit_code;
      if (typeof rawOutput.output === 'string' && rawOutput.output.trim()) {
        state.output = rawOutput.output;
      }
    }

    if (update.status === 'completed') state.status = 'done';
    else if (update.status === 'failed' || update.status === 'cancelled') state.status = 'error';
    else if (update.status === 'pending' || update.status === 'in_progress') {
      if (state.status !== 'error') state.status = 'running';
    }
    if (typeof state.exitCode === 'number' && state.exitCode !== 0) state.status = 'error';
    if (terminal) state.preparing = false;

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

  // Approvals are answered by access-mode policy, mirroring the grok driver:
  // Read only allows read-only tools; Full access runs in yolo mode and never
  // asks. Workspace write allows file mutations only inside the workspace —
  // kimi has no filesystem sandbox of its own, so the boundary is enforced
  // here by resolving every reported target path against cwd, including any
  // symlinked ancestors. Mutations that report no target path fail closed,
  // and commands are denied outright since their filesystem reach is
  // unknowable.
  const workspaceRoot = path.resolve(cwd || '.');
  let canonicalWorkspaceRoot = null;
  try {
    canonicalWorkspaceRoot = realpathSync(workspaceRoot);
  } catch {}

  // realpathSync requires the final target to exist, but Write commonly
  // creates a new file. Canonicalize the deepest existing ancestor and append
  // the missing suffix. lstatSync intentionally detects broken symlinks too:
  // following one can still create its target outside the workspace.
  const canonicalizeMutationTarget = (candidate, depth = 0) => {
    if (depth > 40) throw new Error('Too many symbolic links');
    const resolved = path.resolve(candidate);
    let ancestor = resolved;
    let stats;
    while (true) {
      try {
        stats = lstatSync(ancestor);
        break;
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }

    const missingSuffix = path.relative(ancestor, resolved);
    let canonicalAncestor;
    try {
      canonicalAncestor = realpathSync(ancestor);
    } catch (error) {
      if (!stats.isSymbolicLink()) throw error;
      const canonicalParent = canonicalizeMutationTarget(path.dirname(ancestor), depth + 1);
      canonicalAncestor = canonicalizeMutationTarget(
        path.resolve(canonicalParent, readlinkSync(ancestor)),
        depth + 1
      );
    }
    return path.resolve(canonicalAncestor, missingSuffix);
  };
  const isInsideWorkspace = (candidate) => {
    if (!canonicalWorkspaceRoot) return false;
    try {
      const resolvedCandidate = path.resolve(workspaceRoot, candidate);
      const canonicalCandidate = canonicalizeMutationTarget(resolvedCandidate);
      const relative = path.relative(canonicalWorkspaceRoot, canonicalCandidate);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    } catch {
      return false;
    }
  };
  // kimi 0.26's permission payload carries no kind/rawInput/locations, and
  // rawInput on tool_call updates lands only after approval — at ask time the
  // target path lives solely in the completed argument preview (verified
  // live), so that is the fallback of last resort.
  const mutationTargets = (toolCall, known) => {
    const targets = [];
    const pushFrom = (record) => {
      if (!record || typeof record !== 'object') return;
      for (const key of ['file_path', 'path', 'old_path', 'new_path', 'source', 'destination']) {
        if (typeof record[key] === 'string' && record[key]) targets.push(record[key]);
      }
    };
    pushFrom(toolCall.rawInput);
    for (const location of Array.isArray(toolCall.locations) ? toolCall.locations : []) {
      if (typeof location?.path === 'string' && location.path) targets.push(location.path);
    }
    if (!targets.length && typeof known?.filePath === 'string' && known.filePath) {
      targets.push(known.filePath);
    }
    if (!targets.length && typeof known?.argsPreview === 'string') {
      try {
        pushFrom(JSON.parse(known.argsPreview));
      } catch {}
    }
    return targets;
  };
  const answerPermission = (message) => {
    const params = message.params ?? {};
    const toolCall = params.toolCall ?? {};
    const known = typeof toolCall.toolCallId === 'string' ? toolCalls.get(toolCall.toolCallId) : null;
    const kind =
      toolCall.kind ??
      known?.kind ??
      KIMI_TOOL_KINDS[typeof toolCall.title === 'string' ? toolCall.title : ''];
    const readOnly = kind === 'read' || kind === 'search' || kind === 'fetch' || kind === 'think';
    // Orion's own MCP tools are safe in every mode: the spawned subthread
    // runs with the driver thread's access mode, never more; stopping one
    // only halts Orion's own child run; read_thread and the Durango Chat
    // readers only read the user's own data (`remember`, a write to Durango
    // memory, is excluded in Read only — see thread-reader-routing.js).
    // Kimi's initial ACP tool_call records the qualified MCP identity in
    // toolName; permission titles are presentation fields and must not grant
    // access.
    const isOrionSpawn =
      typeof known?.toolName === 'string' &&
      known.toolName.startsWith('mcp__orion__') &&
      isPreapprovedOrionTool(known.toolName.slice('mcp__orion__'.length), accessMode);
    let allow;
    let denialDetail = "mode doesn't permit this tool.";
    if (isOrionSpawn) {
      allow = true;
    } else if (accessMode === 'full-access') {
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

    // A path-gated approval must never persist: choosing an "always allow"
    // option would let kimi self-approve later calls of the same tool without
    // asking, including ones that target paths outside the workspace.
    const pathGated = allow && accessMode === 'workspace-write' && !readOnly;
    const options = (Array.isArray(params.options) ? params.options : []).filter(
      (option) =>
        !pathGated ||
        (option?.kind !== 'allow_always' &&
          !/always/i.test(`${option?.optionId ?? ''} ${option?.name ?? ''}`))
    );
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
      } ${denialDetail} Switch to Full Access to allow it.`;
      emitToolActivity(known, true);
    }
  };

  const fail = (error) => {
    flushToolEmits();
    callbacks.onFatal(
      typeof error === 'string' ? error : error?.message ?? 'Kimi agent protocol error.'
    );
  };

  const start = async () => {
    const init = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    if (init.error) return fail(init.error);
    // ACP agents opt in to HTTP MCP transports; stdio is always supported.
    const unsupported = mcpServers.filter((server) => server?.type === 'http');
    if (init.result?.agentCapabilities?.mcpCapabilities?.http !== true && unsupported.length) {
      return fail(`This provider does not support HTTP MCP servers: ${unsupported.map((server) => `@${server.name}`).join(', ')}. Switch providers, or switch these MCPs off and remove their thread attachments.`);
    }
    const sessionMcpServers = mcpServers;

    let sessionId = null;
    let resumed = false;
    if (resumeSessionId) {
      replayingSession = true;
      const loaded = await request('session/load', {
        sessionId: resumeSessionId,
        cwd,
        mcpServers: sessionMcpServers,
      });
      replayingSession = false;
      if (loaded.error) callbacks.onResumeFallback?.();
      else {
        sessionId = resumeSessionId;
        resumed = true;
      }
    }
    if (!sessionId) {
      const created = await request('session/new', { cwd, mcpServers: sessionMcpServers });
      if (created.error || typeof created.result?.sessionId !== 'string') {
        return fail(created.error ?? 'Kimi agent did not return a session id.');
      }
      sessionId = created.result.sessionId;
    }
    callbacks.onSessionId(sessionId, { resumed });

    // Pin the thread's model: sessions open on the CLI's default_model.
    const setModel = await request('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: model.slug,
    });
    if (setModel.error) {
      return fail(setModel.error.message ?? `Kimi rejected model "${model.slug}".`);
    }

    // Pin the permission mode to the thread's access level. Full access uses
    // yolo (auto-approve everything, no permission round-trips); Read only
    // uses plan (no tool execution at all). Workspace write uses default —
    // kimi's auto mode self-approves writes and commands on any path the
    // process can reach, not just the workdir, so default (ask-first) is the
    // only mode that routes every mutation through answerPermission, where
    // the workspace boundary is enforced by path.
    const modeId =
      accessMode === 'full-access' ? 'yolo' : accessMode === 'read-only' ? 'plan' : 'default';
    const setMode = await request('session/set_mode', { sessionId, modeId });
    if (setMode.error) {
      return fail(
        setMode.error.message ?? `Kimi could not enable ${accessMode} permission mode.`
      );
    }

    const failureLogCursor = await kimiTurnFailureLogCursor(sessionId);
    const prompt = await buildKimiPromptBlocks(promptText, attachments);
    const response = await request('session/prompt', {
      sessionId,
      prompt,
    });
    flushToolEmits();
    if (response.error) return fail(response.error);
    const stopReason = response.result?.stopReason;
    if (stopReason && stopReason !== 'end_turn') {
      const detail =
        stopReason === 'refusal'
          ? 'was refused'
          : stopReason === 'cancelled'
            ? 'was cancelled'
            : stopReason === 'max_tokens'
              ? 'reached the model token limit'
              : stopReason === 'max_turn_requests'
                ? 'reached the maximum turn limit'
                : `stopped (${stopReason})`;
      return fail(`Kimi turn ${detail}.`);
    }
    // kimi reports a non-auth provider failure (e.g. an API 403/5xx) as a
    // clean `end_turn` — including mid-turn failures after tool calls and
    // text already streamed (a quota 403 twelve steps in looks like a
    // finished turn on the wire). The error only lands in the session's log
    // file; give the write a moment, then surface it instead of finishing a
    // successful-looking turn.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const failure = await kimiTurnFailureFromSessionDisk(sessionId, failureLogCursor);
    if (failure) return fail(failure);
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
      // Text resuming after tool activity is a new paragraph.
      if (textSeen) pendingTextBreak = true;
      upsertToolCall(update, kind === 'tool_call');
      return;
    }
    if (kind === 'plan') {
      handlePlanUpdate(update.entries);
    }
    // available_commands_update / config_option_update / current_mode_update
    // are session bookkeeping — nothing to surface.
  };

  return { start, handleMessage };
};

// One-shot, tool-free kimi text turn over ACP, used for title generation.
// Prompt mode (`kimi -p`) auto-approves every tool and rejects --plan
// ("Cannot combine --prompt with --plan" on 0.26), so hidden background
// prompts must go through ACP plan mode, which disables tool execution
// entirely (the driver's read-only permission policy backstops it).
// Resolves with the accumulated response text, or '' on failure. Cancellation
// waits for the ACP child to exit so callers may safely tear down its cwd.
export const kimiPlanModeOneShot = (model, promptText, cwd, { signal, threadId } = {}) => {
  if (signal?.aborted) return Promise.resolve('');
  return new Promise((resolve) => {
    const child = spawn(loginShell, ['-lc', 'kimi acp'], {
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
    const driver = createKimiAcpDriver({
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
