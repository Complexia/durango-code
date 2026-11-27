import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BOT_FINAL_INBOX_MAX_ROUNDS,
  BOT_REPLY_MESSAGES_MAX,
  botProjectsForLane,
  botProjectsNote,
  botReplyMessageId,
  botToolLabel,
  botWorkDir,
  formatBotFinalInbox,
  formatBotInbox,
  isRetryElsewhereError,
  saveLaneAttachments,
} from './bot-replies.js';
import { ATTACH_FILES_TOOL, createReplyFiles, finishReplyFiles, messageMediaOf } from './bot-reply-extras.js';
import {
  BOT_SESSION_MAX_TOKENS,
  BOT_SESSION_RESET_TOKENS,
  cutMiddle,
  estimateTextTokens,
  maxPromptTokensFromEnv,
  normalizeLaneSession,
  planBotPrompt,
  sessionBasis,
  splitMemorySection,
} from './bot-sessions.js';
import { selectFinalMessage } from '../report-clip.js';

// Bot replies on this machine's other harnesses: Codex (GPT), Antigravity
// (Gemini), Grok and Muse Code, the ones Durango Code threads already use.
// Claude models keep running on Claude Code (bot-replies.js
// createClaudeLaneRunner); this runner takes every other model a machine
// advertises (bot-harness-models.js).
//
// A reply behaves like a Claude Code one: the bot's tools come from a local
// MCP server (`durango_bot`, mcp-bridge.js registerBotToolsBridge) handed to
// the harness through its own supported intake; the reply streams as it is
// written and goes out as messages (the text before a tool call is a message
// of its own); messages that reach the bot meanwhile are handed to the
// running turn where the harness can take them mid-turn (Codex turn/steer,
// an Antigravity ACP session/prompt), and otherwise, and always before the
// final answer is posted, as a follow-up prompt in the same session; each
// bot keeps its harness session (bot-sessions.js), resumed by its next
// reply; a reply that can't run here (not installed, signed out, a usage
// limit, an error before anything was written) moves to the next place.
//
// Each harness is driven only through its documented interface:
// - Codex: `codex app-server` JSON-RPC (thread/start|resume, turn/start,
//   turn/steer; bot tools as an `mcp_servers.durango_bot` config entry).
// - Antigravity: `agy acp`, the Agent Client Protocol only (initialize,
//   session/new|resume|load with `mcpServers`, session/set_model,
//   session/prompt, session/cancel; the bot's instructions through the
//   `_meta.antigravity.systemPrompt.append` extension agy advertises in
//   initialize). Nothing else: no reading of agy's files, tokens or session
//   databases, no Google endpoints.
// - Grok: `grok agent stdio` ACP, the same way (no steering: its ACP has none).
// - Muse: `muse exec --json` (one run per prompt, `--session-id` to go on;
//   bot tools through Muse's settings file in a private config root).

export const HARNESS_HANDSHAKE_TIMEOUT_MS = 60_000;
const FAILURE_MAX_CHARS = 500;
const STDERR_TAIL_CHARS = 4_000;
const BOT_TOOLS_SERVER = 'durango_bot';

const str = (value) => (typeof value === 'string' ? value : '');
const shorten = (value, max = FAILURE_MAX_CHARS) => {
  const text = String(value ?? '').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
};

/** A harness that can't take this reply: `retryElsewhere` → the next place runs it; `resumeFailed` → start over fresh. */
export class HarnessError extends Error {
  constructor(message, { retryElsewhere = false, resumeFailed = false } = {}) {
    super(message);
    this.name = 'HarnessError';
    this.retryElsewhere = retryElsewhere;
    this.resumeFailed = resumeFailed;
  }
}

const errorText = (error) =>
  typeof error === 'string' ? error : str(error?.message) || str(error?.data?.message) || (error ? JSON.stringify(error).slice(0, 400) : '');

// An upstream API failure Antigravity reports as the turn's only text with a
// clean end_turn: the whole answer is one error line in agy's own shape
// ("Error 429, Message: …, Status: RESOURCE_EXHAUSTED" or "UNAVAILABLE (code
// 503): …"). A reply that merely talks about such an error isn't one.
const API_ERROR_TEXT = /^\s*(?:Error \d{3}, Message: [^\n]+, Status: [A-Z_0-9]+[^\n]*|[A-Z_]{4,} \(code \d{3}\): [^\n]+)\s*$/;
const API_ERROR_MAX_CHARS = 2_000;
/** Is this turn's whole answer an upstream error line (and no tool ran)? */
export const isApiErrorAnswer = (text, toolsRan = 0) => {
  const value = String(text ?? '');
  return toolsRan === 0 && value.length <= API_ERROR_MAX_CHARS && API_ERROR_TEXT.test(value);
};
/** An upstream error that means "not now" (quota, rate limit, overloaded): the harness is left out for a while. */
export const isApiLimitError = (text) => /\b(?:429|503)\b|RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED|UNAVAILABLE|rate.?limit|quota/i.test(String(text ?? ''));

/** The instructions folded into a fresh session's first prompt, for a harness with no system prompt of its own. */
export const botInstructionsBlock = (instructions) =>
  instructions.trim()
    ? `<bot_instructions>\nYou are answering as a Durango bot. Follow these instructions for this whole conversation:\n\n${instructions.trim()}\n</bot_instructions>\n\n`
    : '';

// --- a line-delimited JSON-RPC peer over a child's stdio -------------------------------

/**
 * child: { stdin, stdout, stderr, on('exit'|'error'), kill() }.
 * onRequest(message) → result (or a Promise of it; throw for an error reply);
 * onNotification(message). → { request(method, params, { timeoutMs }), notify, close, closed, stderrTail }
 */
export const createJsonRpcPeer = (child, { onRequest = () => null, onNotification = () => {}, onExit = () => {} } = {}) => {
  let nextId = 1;
  const pending = new Map();
  let buffer = '';
  let closed = false;
  let stderrTail = '';
  const write = (message) => {
    if (closed) return false;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  };
  const settleAll = (reason) => {
    for (const resolve of pending.values()) resolve({ error: { message: reason } });
    pending.clear();
  };
  const handleLine = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && message.id !== null && !message.method) {
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
      return;
    }
    if (message.id !== undefined && message.id !== null && message.method) {
      Promise.resolve()
        .then(() => onRequest(message))
        .then(
          (result) =>
            result === undefined
              ? write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } })
              : write({ jsonrpc: '2.0', id: message.id, result }),
          (error) => write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: errorText(error) || 'failed' } })
        );
      return;
    }
    if (message.method) onNotification(message);
  };
  child.stdout?.on('data', (data) => {
    buffer += data.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr?.on('data', (data) => {
    stderrTail = `${stderrTail}${data}`.slice(-STDERR_TAIL_CHARS);
  });
  const ended = (reason) => {
    if (closed) return;
    closed = true;
    settleAll(reason);
    onExit(reason);
  };
  // 'close' comes once stdout is drained (its last lines handled); 'exit' alone
  // only after a moment, for a process whose pipes a child of its holds open.
  child.on?.('close', (code) => ended(`The process exited (${code ?? 'signal'}).`));
  child.on?.('exit', (code) => {
    const timer = setTimeout(() => ended(`The process exited (${code ?? 'signal'}).`), 1_500);
    timer.unref?.();
  });
  child.on?.('error', (error) => ended(error?.message ?? 'The process failed to start.'));
  return {
    request: (method, params, { timeoutMs = 0 } = {}) =>
      new Promise((resolve) => {
        const id = nextId++;
        let timer = null;
        pending.set(id, (message) => {
          if (timer) clearTimeout(timer);
          resolve(message);
        });
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            if (pending.delete(id)) resolve({ error: { message: `${method} timed out.` } });
          }, timeoutMs);
          timer.unref?.();
        }
        if (!write({ jsonrpc: '2.0', id, method, params })) {
          pending.delete(id);
          if (timer) clearTimeout(timer);
          resolve({ error: { message: 'The connection is closed.' } });
        }
      }),
    notify: (method, params) => write({ jsonrpc: '2.0', method, params }),
    get closed() {
      return closed;
    },
    stderrTail: () => stderrTail,
    close: () => {
      ended('Closed.');
      try {
        child.stdin?.end?.();
      } catch {}
      try {
        child.kill?.();
      } catch {}
    },
  };
};

/**
 * While a harness opens (a handshake can take a minute): an abort closes the
 * connection, and every step after an await checks it. → { check(), done() }
 */
const abortWhileOpening = (signal, close) => {
  const onAbort = () => close();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  return {
    check: () => {
      if (signal?.aborted) {
        close();
        throw new HarnessError('The reply was stopped while the harness was starting.');
      }
    },
    done: () => signal?.removeEventListener?.('abort', onAbort),
  };
};

const signInText = /not (?:logged|signed) in|log ?in|sign ?in|authenticat|auth(?:entication)? required|unauthori[sz]ed|credentials|oauth|api key/i;

/** Does a harness error mean "not here, now" (move the reply) rather than "this reply failed"? */
export const isHarnessUnavailableError = (text) => isRetryElsewhereError(text) || signInText.test(String(text ?? ''));

// --- Codex: `codex app-server` -------------------------------------------------------

const CODEX_TEXTLESS_ITEMS = new Set(['agentMessage', 'reasoning', 'userMessage', 'contextCompaction', 'plan', 'hookPrompt']);

/**
 * deps: spawnProcess(argv, { cwd, env }) → child. open() → a session (see
 * createHarnessLaneRunner). Full access: danger-full-access sandbox and no
 * approvals (nobody is at the machine during a bot reply; the person's choice).
 */
export const createCodexBotHarness = ({ spawnProcess, clientVersion = '0.0.0', handshakeTimeoutMs = HARNESS_HANDSHAKE_TIMEOUT_MS }) => ({
  id: 'codex',
  steers: true,
  async open({ cwd, model, effort, instructions, resumeSessionId, mcp, onEvent, signal }) {
    if (signal?.aborted) throw new HarnessError('The reply was stopped before Codex started.');
    let threadId = null;
    let activeTurnId = null;
    let turnWaiter = null;
    let lastError = null;
    let contextTokens = 0;
    let usage = null;
    const child = spawnProcess(['codex', 'app-server'], { cwd: os.homedir() });
    const peer = createJsonRpcPeer(child, {
      onRequest: (message) => {
        const method = message.method;
        if (method === 'currentTime/read') return { currentTimeAt: Math.floor(Date.now() / 1000) };
        if (method === 'item/tool/requestUserInput') return { answers: {} };
        if (/requestApproval$|Approval$/.test(method)) return { decision: 'accept' };
        return undefined;
      },
      onNotification: (message) => {
        const params = message.params ?? {};
        if (params.threadId && threadId && params.threadId !== threadId) return;
        switch (message.method) {
          case 'item/agentMessage/delta':
            if (typeof params.delta === 'string' && params.delta) onEvent({ type: 'text', delta: params.delta });
            return;
          case 'item/started': {
            const item = params.item ?? {};
            if (item.type === 'agentMessage') onEvent({ type: 'text-break' });
            else if (item.type && !CODEX_TEXTLESS_ITEMS.has(item.type) && item.id) {
              onEvent({ type: 'tool-start', id: String(item.id), name: str(item.tool) || str(item.server && `${item.server}.${item.tool}`) || item.type });
            }
            return;
          }
          case 'item/completed': {
            const item = params.item ?? {};
            if (item.type && !CODEX_TEXTLESS_ITEMS.has(item.type) && item.id) onEvent({ type: 'tool-end', id: String(item.id) });
            return;
          }
          case 'turn/started':
            activeTurnId = typeof params.turn?.id === 'string' ? params.turn.id : activeTurnId;
            return;
          case 'turn/completed': {
            const turn = params.turn ?? {};
            if (activeTurnId && turn.id && turn.id !== activeTurnId) return;
            activeTurnId = null;
            const waiter = turnWaiter;
            turnWaiter = null;
            waiter?.(
              turn.status === 'completed'
                ? { ok: true, contextTokens, usage }
                : { ok: false, error: errorText(turn.error) || lastError || `Codex turn ${turn.status || 'ended'}.`, cancelled: turn.status === 'interrupted' }
            );
            return;
          }
          case 'thread/tokenUsage/updated': {
            const last = params.tokenUsage?.last ?? params.tokenUsage?.total ?? null;
            if (last) {
              contextTokens = Number(last.inputTokens ?? 0) + Number(last.outputTokens ?? 0) || contextTokens;
              usage = {
                input: Math.max(0, Number(last.inputTokens ?? 0) - Number(last.cachedInputTokens ?? 0)),
                cacheRead: Number(last.cachedInputTokens ?? 0),
                output: Number(last.outputTokens ?? 0),
              };
            }
            return;
          }
          case 'error':
            if (!params.willRetry) lastError = errorText(params.error) || lastError;
            return;
          default:
        }
      },
      onExit: (reason) => {
        const waiter = turnWaiter;
        turnWaiter = null;
        waiter?.({ ok: false, error: lastError || `Codex stopped: ${reason}\n${peer.stderrTail()}` });
      },
    });
    const fail = (error, options) => {
      const text = errorText(error) || 'Codex did not start.';
      peer.close();
      throw new HarnessError(`${text}\n${peer.stderrTail()}`.trim(), { retryElsewhere: isHarnessUnavailableError(`${text}\n${peer.stderrTail()}`), ...options });
    };
    const opening = abortWhileOpening(signal, () => peer.close());
    let resumed = false;
    try {
    const init = await peer.request(
      'initialize',
      { clientInfo: { name: 'durango-code-bots', title: 'Durango Code bots', version: clientVersion }, capabilities: { experimentalApi: true } },
      { timeoutMs: handshakeTimeoutMs }
    );
    opening.check();
    if (init.error) fail(init.error, { retryElsewhere: true });
    peer.notify('initialized', {});
    const config = {
      ...(effort ? { model_reasoning_effort: effort } : {}),
      ...(mcp
        ? {
            [`mcp_servers.${BOT_TOOLS_SERVER}.command`]: mcp.command,
            [`mcp_servers.${BOT_TOOLS_SERVER}.args`]: mcp.args,
            [`mcp_servers.${BOT_TOOLS_SERVER}.env`]: mcp.env ?? {},
            [`mcp_servers.${BOT_TOOLS_SERVER}.startup_timeout_sec`]: 30,
            [`mcp_servers.${BOT_TOOLS_SERVER}.tool_timeout_sec`]: 3600,
            // The bot's own tools: nobody is there to approve them.
            [`mcp_servers.${BOT_TOOLS_SERVER}.default_tools_approval_mode`]: 'approve',
          }
        : {}),
    };
    const threadParams = {
      cwd,
      model: model.slug,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      config,
      ...(instructions ? { developerInstructions: instructions } : {}),
    };
    if (resumeSessionId) {
      const response = await peer.request('thread/resume', { threadId: resumeSessionId, ...threadParams }, { timeoutMs: handshakeTimeoutMs });
      opening.check();
      // Signed out is the machine's problem, not the session's: move the reply.
      if (response.error) fail(response.error, isHarnessUnavailableError(errorText(response.error)) ? {} : { resumeFailed: true });
      threadId = response.result?.thread?.id ?? resumeSessionId;
      resumed = true;
    } else {
      const response = await peer.request('thread/start', threadParams, { timeoutMs: handshakeTimeoutMs });
      opening.check();
      threadId = response.result?.thread?.id ?? null;
      if (response.error || typeof threadId !== 'string') fail(response.error ?? 'Codex did not return a thread id.');
    }
    } finally {
      opening.done();
    }
    const input = (text) => [{ type: 'text', text }];
    return {
      sessionId: threadId,
      resumed,
      instructionsApplied: true,
      async prompt(text) {
        lastError = null;
        const done = new Promise((resolve) => {
          turnWaiter = resolve;
        });
        const started = await peer.request('turn/start', { threadId, input: input(text), ...(effort ? { effort } : {}) });
        if (started.error) {
          turnWaiter = null;
          return { ok: false, error: errorText(started.error) };
        }
        if (typeof started.result?.turn?.id === 'string' && !activeTurnId) activeTurnId = started.result.turn.id;
        return await done;
      },
      async steer(text) {
        if (!activeTurnId) return false;
        const expectedTurnId = activeTurnId;
        const response = await peer.request('turn/steer', { threadId, expectedTurnId, input: input(text) });
        return !response.error && response.result?.turnId === expectedTurnId;
      },
      async cancel() {
        if (activeTurnId) await peer.request('turn/interrupt', { threadId, turnId: activeTurnId }, { timeoutMs: 3_000 });
      },
      close: () => peer.close(),
    };
  },
});

// --- ACP: Antigravity (`agy acp`) and Grok (`grok agent stdio`) ------------------------

/**
 * deps: spawnProcess(argv, { cwd, env }) → child; provider 'antigravity' | 'grok'.
 * The lane's model is set with session/set_model (`model.acpModelId`, e.g.
 * agy's "gemini-4-neon-high") or, for Grok, its `-m` flag.
 */
export const createAcpBotHarness = ({ provider, spawnProcess, handshakeTimeoutMs = HARNESS_HANDSHAKE_TIMEOUT_MS }) => ({
  id: provider,
  // Antigravity takes a session/prompt during a running turn and carries the
  // turn on under it (its ACP steering); Grok's ACP has no such thing.
  steers: provider === 'antigravity',
  async open({ cwd, model, effort, instructions, resumeSessionId, mcp, projects = [], onEvent, signal }) {
    if (signal?.aborted) throw new HarnessError(`The reply was stopped before ${provider} started.`);
    const argv =
      provider === 'antigravity'
        ? ['agy', 'acp', '--dangerously-skip-permissions']
        : ['grok', '--always-approve', 'agent', '-m', model.slug, ...(effort ? ['--reasoning-effort', effort] : []), 'stdio'];
    const child = spawnProcess(argv, { cwd });
    let replaying = false;
    let turnText = '';
    let turnTools = 0; // tool calls this turn
    let usage = null;
    let contextTokens = 0;
    const tools = new Set();
    const peer = createJsonRpcPeer(child, {
      onRequest: (message) => {
        if (message.method === 'session/request_permission') {
          const toolCallId = str(message.params?.toolCall?.toolCallId);
          // agy asks the person multiple-choice questions this way (an
          // `interaction_` call, its options are answers): nobody is there
          // during a bot reply, so it's cancelled, never answered for them.
          if (toolCallId.startsWith('interaction_')) return { outcome: { outcome: 'cancelled' } };
          // Bots work with Full access (bot-replies.js normalizeBotSettings):
          // an approval is allowed, by its ACP kind only.
          const options = Array.isArray(message.params?.options) ? message.params.options : [];
          const chosen = options.find((option) => option?.kind === 'allow_once') ?? options.find((option) => option?.kind === 'allow_always');
          return chosen ? { outcome: { outcome: 'selected', optionId: chosen.optionId } } : { outcome: { outcome: 'cancelled' } };
        }
        return undefined;
      },
      onNotification: (message) => {
        if (replaying) return;
        const update = message.method === 'session/update' || message.method === '_x.ai/session_notification' ? message.params?.update : null;
        if (!update || typeof update !== 'object') return;
        const kind = update.sessionUpdate;
        if (kind === 'agent_message_chunk') {
          const text = update.content?.text;
          if (typeof text === 'string' && text) {
            turnText += text;
            onEvent({ type: 'text', delta: text });
          }
          return;
        }
        if (kind === 'tool_call' || kind === 'tool_call_update') {
          const id = str(update.toolCallId);
          if (!id) return;
          if (!tools.has(id) && update.status !== 'completed' && update.status !== 'failed') {
            tools.add(id);
            turnTools += 1;
            onEvent({ type: 'tool-start', id, name: str(update.title) || str(update.kind) || 'tool' });
          }
          if (tools.has(id) && (update.status === 'completed' || update.status === 'failed' || update.status === 'cancelled')) {
            tools.delete(id);
            onEvent({ type: 'tool-end', id });
          }
          return;
        }
        if (kind === 'usage_update' && Number.isFinite(update.used)) contextTokens = update.used;
      },
    });
    const fail = (error, options = {}) => {
      const text = `${errorText(error) || `${provider} did not start.`}\n${peer.stderrTail()}`.trim();
      peer.close();
      throw new HarnessError(text, { retryElsewhere: isHarnessUnavailableError(text), ...options });
    };
    const handshake = { timeoutMs: handshakeTimeoutMs };
    const opening = abortWhileOpening(signal, () => peer.close());
    let caps;
    let sessionId = null;
    let resumed = false;
    let nativeInstructions = false;
    try {
    const init = await peer.request(
      'initialize',
      { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }, clientInfo: { name: 'durango-code-bots', version: '1' } },
      handshake
    );
    opening.check();
    if (init.error) fail(init.error, { retryElsewhere: true });
    caps = init.result?.agentCapabilities ?? {};
    const useHttp = caps.mcpCapabilities?.http === true && mcp?.httpUrl;
    const mcpServers = mcp
      ? useHttp
        ? [{ type: 'http', name: BOT_TOOLS_SERVER, url: mcp.httpUrl, headers: mcp.httpHeaders ?? [] }]
        : [{ name: BOT_TOOLS_SERVER, command: mcp.command, args: mcp.args, env: Object.entries(mcp.env ?? {}).map(([name, value]) => ({ name, value })) }]
      : [];
    // agy advertises a system-prompt extension in initialize; elsewhere the
    // instructions open the session's first prompt.
    nativeInstructions = provider === 'antigravity' && caps._meta?.antigravity?.systemPrompt?.append === true && Boolean(instructions);
    const extraDirs = caps.sessionCapabilities?.additionalDirectories && projects.length ? { additionalDirectories: projects } : {};
    if (resumeSessionId) {
      // session/resume (no replay) where advertised, else session/load (replays; ignored).
      if (caps.sessionCapabilities?.resume) {
        const response = await peer.request('session/resume', { sessionId: resumeSessionId, cwd, mcpServers, ...extraDirs }, handshake);
        opening.check();
        if (!response.error) sessionId = resumeSessionId;
        else if (signInText.test(errorText(response.error))) fail(response.error, { retryElsewhere: true });
      }
      if (!sessionId && caps.loadSession) {
        replaying = true;
        const response = await peer.request('session/load', { sessionId: resumeSessionId, cwd, mcpServers, ...extraDirs }, handshake);
        replaying = false;
        opening.check();
        if (!response.error) sessionId = resumeSessionId;
        else if (signInText.test(errorText(response.error))) fail(response.error, { retryElsewhere: true });
      }
      if (!sessionId) fail(`${provider} could not resume the bot's session.`, { resumeFailed: true });
      resumed = true;
    } else {
      const response = await peer.request(
        'session/new',
        {
          cwd,
          mcpServers,
          ...extraDirs,
          ...(nativeInstructions ? { _meta: { antigravity: { systemPrompt: { append: instructions } } } } : {}),
        },
        handshake
      );
      opening.check();
      sessionId = response.result?.sessionId ?? null;
      if (response.error || typeof sessionId !== 'string') fail(response.error ?? `${provider} did not return a session id.`);
    }
    if (provider === 'antigravity' && model.acpModelId) {
      // ACP session/set_model with agy's `<model>-<effort>` id; an agy that
      // takes the model and thinking level as ACP config options instead gets
      // session/set_config_option (`model`, `thought_level`).
      const response = await peer.request('session/set_model', { sessionId, modelId: model.acpModelId }, handshake);
      opening.check();
      if (response.error) {
        const setModel = await peer.request('session/set_config_option', { sessionId, configId: 'model', value: model.slug }, handshake);
        opening.check();
        if (setModel.error) fail(response.error);
        if (effort) {
          const value = model.antigravityThoughtLevelValues?.[effort] ?? effort;
          const setEffort = await peer.request('session/set_config_option', { sessionId, configId: 'thought_level', value }, handshake);
          opening.check();
          if (setEffort.error) fail(setEffort.error);
        }
      }
    }
    } finally {
      opening.done();
    }
    // Every session/prompt of a turn, steers included: agy ends a running
    // prompt as soon as a newer one arrives and carries the turn on under the
    // newest, so only that one's response ends the turn.
    // Superseded prompts answer at once (end_turn), a refused steer with an
    // error, the newest at the turn's end: the turn's outcome is the newest
    // answer that isn't an error.
    // A steer that fails (refused at once, or an error later) is reported as
    // not taken by steer(), which resolves only once its prompt is answered:
    // the runner then folds its messages into the final answer instead.
    let prompts = [];
    let turnActive = false;
    const send = (text) => {
      const entry = { settled: false, failed: false, value: null };
      entry.done = peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }).then((response) => {
        entry.settled = true;
        entry.value = { response };
        if (response.error) entry.failed = true;
        return entry.value;
      });
      prompts.push(entry);
      return entry;
    };
    const runTurn = async (text) => {
      turnText = '';
      turnTools = 0;
      prompts = [];
      turnActive = true;
      const first = send(text);
      while (prompts.some((entry) => !entry.settled)) await Promise.all(prompts.map((entry) => entry.done));
      turnActive = false;
      // The turn's outcome: the newest prompt that was answered (a failed
      // steer's messages go back to the runner; the first prompt's own error is the turn's).
      const outcome = (prompts.filter((entry) => !entry.failed).pop() ?? first).value;
      prompts = [];
      const { response } = outcome;
      if (response.error) return { ok: false, error: errorText(response.error) };
      const result = response.result ?? {};
      const meta = result.usage ?? result._meta?.usage ?? result._meta ?? null;
      if (meta) {
        const input = Number(meta.inputTokens ?? 0);
        const cached = Number(meta.cachedReadTokens ?? 0);
        const output = Number(meta.outputTokens ?? 0);
        // agy counts cached tokens apart from inputTokens (its total is their
        // sum); Grok's inputTokens include them.
        const separate = cached > 0 && Number(meta.totalTokens ?? 0) >= input + cached;
        usage = { input: separate ? input : Math.max(0, input - cached), cacheRead: cached, output };
        if (!contextTokens) contextTokens = Number(meta.totalTokens ?? 0);
      }
      if (result.stopReason === 'cancelled') return { ok: false, cancelled: true, error: `${provider} turn was cancelled.` };
      if (result.stopReason === 'refusal') return { ok: false, error: `${provider} refused the prompt.` };
      // An upstream failure reported as the answer (quota, a 5xx).
      if (isApiErrorAnswer(turnText, turnTools)) return { ok: false, error: turnText.trim(), apiError: true, errorText: turnText };
      return { ok: true, usage, contextTokens };
    };
    return {
      sessionId,
      resumed,
      instructionsApplied: nativeInstructions,
      prompt: runTurn,
      ...(provider === 'antigravity'
        ? {
            async steer(text) {
              if (!turnActive) return false;
              // Its answer is a new paragraph of the reply (agy may also take it as the next turn).
              onEvent({ type: 'text-break' });
              const entry = send(text);
              // Taken only once agy answered it: a refusal (at once) or a later error is not taken.
              await entry.done;
              return !entry.failed;
            },
          }
        : {}),
      async cancel() {
        peer.notify('session/cancel', { sessionId });
      },
      close: () => peer.close(),
    };
  },
});

// --- Muse Code: `muse exec --json` -----------------------------------------------------

/**
 * deps: spawnProcess(argv, { cwd, env }) → child; writePromptFile(text) → path;
 * museEnv(mcp) → extra env (XDG_CONFIG_HOME with the bot tools entry,
 * mcp-bridge.js writeMuseMcpConfigRoot). One `muse exec` per prompt; the
 * session goes on with `--session-id`.
 */
export const createMuseBotHarness = ({ spawnProcess, museEnv = async () => ({}) }) => ({
  id: 'muse',
  steers: false,
  async open({ cwd, model, effort, resumeSessionId, mcp, onEvent, signal }) {
    if (signal?.aborted) throw new HarnessError('The reply was stopped before Muse started.');
    let sessionId = resumeSessionId || null;
    const env = await museEnv(mcp);
    if (signal?.aborted) throw new HarnessError('The reply was stopped before Muse started.');
    let running = null;
    const promptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'durango-bot-muse-'));
    let promptCount = 0;
    return {
      get sessionId() {
        return sessionId;
      },
      resumed: Boolean(resumeSessionId),
      instructionsApplied: false,
      async prompt(text) {
        const file = path.join(promptDir, `prompt-${(promptCount += 1)}.txt`);
        await fs.writeFile(file, text, { mode: 0o600 });
        const argv = [
          'muse',
          'exec',
          '--json',
          '--model',
          model.slug,
          ...(effort ? ['--reasoning-effort', effort] : []),
          '--yolo',
          ...(sessionId ? ['--session-id', sessionId] : []),
          '--prompt-file',
          file,
        ];
        const child = spawnProcess(argv, { cwd, env });
        running = child;
        let buffer = '';
        let stderr = '';
        let textSeen = false;
        let terminal = null;
        const toolTasks = new Set();
        const handle = (value) => {
          if (value?.stream?.kind === 'session' && typeof value.stream.id === 'string' && value.stream.id) sessionId ||= value.stream.id;
          const type = str(value?.payload_type);
          const payload = value?.payload ?? {};
          if (type === 'run.output.delta' && typeof payload.text === 'string' && payload.text) {
            textSeen = true;
            onEvent({ type: 'text', delta: payload.text });
          } else if (type === 'task.lifecycle.proposed' && str(payload.event?.task_kind).startsWith('tool.') && payload.task_id) {
            toolTasks.add(payload.task_id);
            onEvent({ type: 'tool-start', id: String(payload.task_id), name: str(payload.event.task_kind).slice('tool.'.length) });
          } else if (type.startsWith('task.lifecycle.') && type !== 'task.lifecycle.proposed' && toolTasks.has(payload.task_id) && /completed|failed|output|cancel/.test(type)) {
            toolTasks.delete(payload.task_id);
            onEvent({ type: 'tool-end', id: String(payload.task_id) });
          } else if (type.startsWith('run.terminal')) {
            terminal = { ok: payload.terminal === 'completed' || type === 'run.terminal.completed', text: str(payload.text), reason: str(payload.reason) };
            if (terminal.ok && !textSeen && terminal.text) onEvent({ type: 'text', delta: terminal.text });
          }
        };
        return await new Promise((resolve) => {
          child.stdout?.on('data', (data) => {
            buffer += data.toString();
            let newline;
            while ((newline = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (!line) continue;
              try {
                handle(JSON.parse(line));
              } catch {}
            }
          });
          child.stderr?.on('data', (data) => {
            stderr = `${stderr}${data}`.slice(-STDERR_TAIL_CHARS);
          });
          let finished = false;
          const finish = (code) => {
            if (finished) return;
            finished = true;
            if (running === child) running = null;
            // A last line without a newline.
            const rest = buffer.trim();
            buffer = '';
            if (rest) {
              try {
                handle(JSON.parse(rest));
              } catch {}
            }
            if (terminal?.ok) resolve({ ok: true });
            else resolve({ ok: false, error: terminal?.reason || terminal?.text || `${stderr.trim() || `muse exited (${code ?? 'signal'})`}` });
          };
          // 'close': stdout drained (the run's last events read). 'exit' alone
          // only after a moment (a child of muse's holding the pipes).
          child.on?.('close', finish);
          child.on?.('exit', (code) => {
            const timer = setTimeout(() => finish(code), 1_500);
            timer.unref?.();
          });
          child.on?.('error', (error) => {
            finished = true;
            resolve({ ok: false, error: error?.message ?? 'muse failed to start.' });
          });
        });
      },
      async cancel() {
        try {
          running?.kill?.();
        } catch {}
      },
      close: () => {
        try {
          running?.kill?.();
        } catch {}
        void fs.rm(promptDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  },
});

// --- the lane runner -------------------------------------------------------------------

/**
 * Runs lanes whose model is on one of this machine's other harnesses. deps:
 * - resolveModel(lane): { providerId, model: { slug, acpModelId? }, effort } | null
 * - harnesses: { codex, antigravity, grok, muse } (create*BotHarness)
 * - registerTools({ tools, call }): the bot tools' MCP server (mcp-bridge.js
 *   registerBotToolsBridge) → { command, args, env, httpUrl?, httpHeaders?, release() } | null
 * - botsDir, getProjects, mkdir, downloadAttachment, resolveLocalAttachment: as createClaudeLaneRunner's
 * - sessions: createBotSessionStore (each bot's harness session, resumed by its next reply)
 * - onUnavailable(providerId, reason): the harness can't take replies now (signed out, a limit)
 * - log(...)
 * → (lane, ctx) => outcome, the same contract as createClaudeLaneRunner.
 */
export const createHarnessLaneRunner = ({
  resolveModel,
  harnesses,
  registerTools,
  botsDir,
  getProjects = () => [],
  mkdir = (dir) => fs.mkdir(dir, { recursive: true }),
  randomId = () => crypto.randomUUID(),
  downloadAttachment,
  resolveLocalAttachment = null,
  sessions = null,
  maxPromptTokens = maxPromptTokensFromEnv(),
  sessionResetTokens = BOT_SESSION_RESET_TOKENS,
  sessionMaxTokens = BOT_SESSION_MAX_TOKENS,
  sessionColdMs = 55 * 60_000,
  maxFinalInboxRounds = BOT_FINAL_INBOX_MAX_ROUNDS,
  onUnavailable = () => {},
  log = (...args) => console.info('[bot replies]', ...args),
}) => async (lane, ctx) => {
  const resolved = await Promise.resolve(resolveModel(lane)).catch(() => null);
  const harness = resolved ? harnesses?.[resolved.providerId] : null;
  if (!resolved || !harness) {
    return { text: '', retryElsewhere: true, failure: shorten(`No harness on this machine runs ${lane.modelId || lane.model || 'this model'}.`) };
  }
  const providerId = resolved.providerId;
  const modelId = lane.modelId || null;
  let projects = [];
  try {
    projects = botProjectsForLane(await getProjects());
  } catch {}
  // Bots always work with Full access here (bot-replies.js normalizeBotSettings).
  const accessMode = ctx.accessMode || 'full-access';
  const projectsNote = botProjectsNote({ projects, accessMode, threads: lane.threads === 'machine' || lane.threads === 'local' ? lane.threads : null });
  let cwd;
  try {
    cwd = botWorkDir(typeof botsDir === 'function' ? botsDir() : botsDir, lane.botId);
    await mkdir(cwd);
  } catch (error) {
    return { text: '', retryElsewhere: true, failure: shorten(`The bot's folder could not be made: ${error?.message ?? error}`) };
  }
  if (ctx.signal?.aborted) return { text: '', aborted: true };
  const attachmentsDir = path.join(cwd, 'attachments');
  const attachmentsNote = await saveLaneAttachments(lane.attachments, attachmentsDir, {
    ...(downloadAttachment ? { download: downloadAttachment } : {}),
    resolveLocalPath: resolveLocalAttachment,
  }).catch(() => '');
  const systemAppend = projectsNote ? `${lane.systemPrompt}\n\n${projectsNote}` : lane.systemPrompt;
  const withAttachments = (prompt) => (attachmentsNote ? `${prompt}\n\n${attachmentsNote}` : prompt);

  // --- the reply's messages ------------------------------------------------------------
  const sendsMessages = typeof ctx.sendMessage === 'function';
  const replyFiles = createReplyFiles();
  const attaches = lane.replyFiles !== false;
  let blocks = []; // finished text blocks of the message being written
  let partial = ''; // the block streaming now
  let segments = []; // without messages: the text between tool calls (finalMessageOnly)
  let sentCount = 0;
  const unsent = [];
  let sending = Promise.resolve();
  const fileLookups = [];
  let stepMessage = null; // the message the current tool step's text went out as
  let afterTool = false; // text arriving now starts a new step
  const runningTools = new Map(); // id -> name
  let usedTools = false;
  const pendingText = () => [...blocks, partial].map((part) => String(part ?? '').trim()).filter(Boolean).join('\n\n');
  const activeTool = () => {
    const names = [...runningTools.values()];
    return names.length ? botToolLabel(names[names.length - 1]) : null;
  };
  const update = () => ctx.update({ text: pendingText(), activeTool: activeTool() });
  // The message written so far goes out as one of its own → its index, or null.
  const sendPending = () => {
    const text = pendingText();
    blocks = [];
    partial = '';
    if (!text) return null;
    if (!sendsMessages || sentCount >= BOT_REPLY_MESSAGES_MAX) {
      segments.push(text);
      return null;
    }
    const index = sentCount;
    sentCount += 1;
    const media = attaches ? messageMediaOf(text) : { text, paths: [] };
    if (media.paths.length) fileLookups.push(replyFiles.add(media.paths, { quiet: true }).catch(() => []));
    let result;
    try {
      result = Promise.resolve(ctx.sendMessage({ index, text: media.text, ...(modelId ? { modelId } : {}) }));
    } catch {
      result = Promise.resolve(false);
    }
    sending = Promise.all([
      sending,
      result.then(
        (ok) => {
          if (ok === false) unsent[index] = text;
        },
        () => {
          unsent[index] = text;
        }
      ),
    ]);
    return index;
  };
  // A tool step starts: the text written before it (if any) is a message of
  // its own, sent now; more calls in the same step go with that message.
  const startStep = () => {
    if (pendingText()) stepMessage = sendPending();
    afterTool = true;
  };

  // --- inbox -----------------------------------------------------------------------------
  const pendingInbox = [];
  const deliveredSeqs = [];
  const deliveredItems = [];
  let inboxRequest = null;
  let finalRounds = 0;
  // Files attached to a new message, from a local copy here: saved like the lane's.
  const enrichInboxItem = async (item) => {
    if (!resolveLocalAttachment || !Array.isArray(item?.attachments) || !item.attachments.length) return item;
    const local = item.attachments.filter((att) => Boolean(resolveLocalAttachment(att)));
    if (!local.length) return item;
    const note = await saveLaneAttachments(local, attachmentsDir, {
      ...(downloadAttachment ? { download: downloadAttachment } : {}),
      resolveLocalPath: resolveLocalAttachment,
    }).catch(() => '');
    return note ? { ...item, content: [item.content, note].filter(Boolean).join('\n\n') } : item;
  };
  const requestInbox = (options) => {
    if (inboxRequest) return inboxRequest;
    inboxRequest = Promise.resolve()
      .then(() => ctx.takeInbox(options))
      .then(
        async (items) => {
          if (Array.isArray(items) && items.length) pendingInbox.push(...(await Promise.all(items.map(enrichInboxItem))));
        },
        () => {}
      )
      .finally(() => {
        inboxRequest = null;
      });
    return inboxRequest;
  };
  const takePending = () => {
    const items = pendingInbox.splice(0);
    for (const item of items) if (Number.isInteger(item?.seq)) deliveredSeqs.push(item.seq);
    deliveredItems.push(...items);
    return items;
  };
  const giveBack = (items) => {
    for (const item of items) {
      const at = deliveredItems.indexOf(item);
      if (at >= 0) deliveredItems.splice(at, 1);
      if (Number.isInteger(item?.seq)) {
        const seqAt = deliveredSeqs.lastIndexOf(item.seq);
        if (seqAt >= 0) deliveredSeqs.splice(seqAt, 1);
      }
    }
    pendingInbox.unshift(...items);
  };

  // --- the bot's tools, served to the harness over MCP -------------------------------
  const toolDefinitions = [
    ...lane.tools,
    ...(attaches && !lane.tools.some((definition) => definition.name === ATTACH_FILES_TOOL.name) ? [ATTACH_FILES_TOOL] : []),
  ].map((definition) => ({ name: definition.name, description: definition.description || definition.name, inputSchema: definition.inputSchema ?? { type: 'object', properties: {} } }));
  const callBotTool = async (name, args) => {
    usedTools = true;
    if (name === ATTACH_FILES_TOOL.name && !lane.tools.some((definition) => definition.name === name)) {
      const lines = await replyFiles.add(Array.isArray(args?.paths) ? args.paths : []);
      return { ok: true, text: lines.join('\n') || 'Nothing to attach.' };
    }
    // The text written before this call goes out first; a card it shows goes on it.
    if (pendingText()) startStep();
    await sending;
    try {
      const { result } = await ctx.callTool({ name, input: args ?? {}, toolCallId: randomId(), message: sendsMessages ? stepMessage : null });
      return { ok: true, text: typeof result === 'string' ? result : JSON.stringify(result ?? null) };
    } catch (error) {
      return { ok: false, text: `The ${name} tool failed: ${error?.message ?? error}` };
    }
  };
  const mcp = toolDefinitions.length && registerTools ? await registerTools({ tools: toolDefinitions, call: callBotTool }).catch(() => null) : null;
  // Without its tools it isn't the same bot: the next place answers.
  if (toolDefinitions.length && registerTools && !mcp) {
    return { text: '', retryElsewhere: true, failure: "The bot's tools couldn't be served to the harness here." };
  }
  if (ctx.signal?.aborted) {
    mcp?.release?.();
    return { text: '', aborted: true };
  }

  // --- the prompt: a kept session's next message, or a fresh session's whole conversation --
  const session = normalizeLaneSession(lane.session);
  const keptSessions = session && sessions ? sessions : null;
  const sessionKey = `${lane.botId}__${providerId}__${String(modelId || resolved.model.slug).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const { steady: steadyPrompt, memory } = splitMemorySection(lane.systemPrompt);
  const basis = sessionBasis({ systemPrompt: projectsNote ? `${steadyPrompt}\n\n${projectsNote}` : steadyPrompt, model: `${providerId}:${modelId}`, tools: lane.tools });
  const claimed = keptSessions ? await keptSessions.begin(sessionKey) : { state: null, busy: false };
  const planFor = (state, budget = maxPromptTokens) =>
    session
      ? planBotPrompt({
          botName: lane.botName,
          session,
          state,
          basis,
          threadId: lane.threadId,
          busy: claimed.busy || !keptSessions,
          systemTokens: estimateTextTokens(systemAppend),
          maxPromptTokens: budget,
          sessionResetTokens,
          sessionMaxTokens,
          coldAfterMs: sessionColdMs,
          memory,
        })
      : { mode: 'fresh', keep: false, reason: 'legacy', prompt: cutMiddle(lane.prompt, Math.max(4_000, budget - estimateTextTokens(systemAppend))), compact: false };
  let plan;
  try {
    plan = planFor(claimed.state);
  } catch (error) {
    if (keptSessions && !claimed.busy) await keptSessions.end(sessionKey, null).catch(() => {});
    mcp?.release?.();
    throw error;
  }

  const onEvent = (event) => {
    if (!event || ctx.signal?.aborted) return;
    if (event.type === 'text') {
      if (afterTool && !runningTools.size) {
        // New text after the tool calls: the next step (its own message).
        afterTool = false;
        stepMessage = null;
      }
      partial += event.delta;
      update();
    } else if (event.type === 'text-break') {
      if (partial.trim()) blocks.push(partial);
      partial = '';
    } else if (event.type === 'tool-start') {
      usedTools = true;
      if (partial.trim()) blocks.push(partial);
      partial = '';
      // Every earlier call ended and nothing was written since: a step of its
      // own with no text, so a card it shows goes with the next message.
      if (afterTool && !runningTools.size && !pendingText()) stepMessage = null;
      startStep();
      runningTools.set(event.id, event.name);
      update();
      // New messages are taken mid-turn only where the harness can be given
      // them now; elsewhere the check before the final answer takes them.
      if (harness.steers && finalRounds < maxFinalInboxRounds) void requestInbox();
    } else if (event.type === 'tool-end') {
      if (!runningTools.delete(event.id)) return;
      update();
      void steerInbox();
    }
  };
  let current = null; // the open harness session
  let steering = Promise.resolve();
  // Like a steer in an agent thread: what arrived reaches the running turn after a tool result.
  const steerInbox = () => {
    steering = steering.then(async () => {
      if (!current?.steer || ctx.signal?.aborted) return;
      // The take started at this tool call may still be on its way.
      if (inboxRequest) await inboxRequest;
      if (!current?.steer || !pendingInbox.length || ctx.signal?.aborted) return;
      const items = takePending();
      const ok = await current.steer(formatBotInbox(items)).catch(() => false);
      log(`bot ${lane.botId} ${providerId} steer: ${ok ? 'taken into the running turn' : 'refused, kept for the final answer'}`);
      if (!ok) giveBack(items);
    });
    return steering;
  };

  // --- one attempt (a broken kept session gets a second, fresh one) -----------------
  const runAttempt = async (attemptPlan) => {
    const attempt = { ok: false, error: null, opened: false, unavailable: false, sessionId: null, systemAppend, contextTokens: 0, usage: null, apiError: false };
    const resume = attemptPlan.mode === 'resume';
    if (resume && typeof attemptPlan.systemAppend === 'string') attempt.systemAppend = attemptPlan.systemAppend;
    try {
      current = await harness.open({
        cwd,
        model: resolved.model,
        effort: resolved.effort ?? null,
        accessMode,
        instructions: attempt.systemAppend,
        resumeSessionId: resume ? attemptPlan.sessionId : null,
        mcp,
        projects: projects.map((project) => project.path),
        onEvent,
        signal: ctx.signal,
      });
    } catch (error) {
      attempt.error = error;
      attempt.unavailable = Boolean(error?.retryElsewhere);
      attempt.resumeFailed = Boolean(error?.resumeFailed);
      return attempt;
    }
    // Stopped (or moved elsewhere) while it opened: nothing is sent.
    if (ctx.signal?.aborted) {
      current.close?.();
      current = null;
      attempt.error = 'The reply was stopped.';
      return attempt;
    }
    attempt.opened = true;
    const session = current;
    const onAbort = () => {
      void session.cancel?.().catch(() => {});
      setTimeout(() => session.close?.(), 1_500).unref?.();
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const firstText = withAttachments(attemptPlan.prompt);
      let result = await current.prompt(resume || current.instructionsApplied ? firstText : `${botInstructionsBlock(attempt.systemAppend)}${firstText}`);
      for (;;) {
        await steering;
        attempt.sessionId = current.sessionId ?? attempt.sessionId;
        if (Number.isFinite(result?.contextTokens) && result.contextTokens) attempt.contextTokens = result.contextTokens;
        if (result?.usage) attempt.usage = result.usage;
        if (!result?.ok) {
          attempt.error = result?.error || 'The harness ended the reply.';
          attempt.apiError = Boolean(result?.apiError);
          // The error line it wrote as its answer is not the bot's reply.
          if (attempt.apiError) dropTrailingText(result.errorText ?? result.error);
          break;
        }
        // Before the final answer is posted: messages that arrived meanwhile
        // (unless some are waiting already: they get the next round as they are).
        if (inboxRequest) await inboxRequest;
        if (!pendingInbox.length && finalRounds < maxFinalInboxRounds && !ctx.signal?.aborted) await requestInbox({ beforeFinish: true });
        if (ctx.signal?.aborted) break;
        const items = takePending();
        if (!items.length) {
          attempt.ok = true;
          break;
        }
        finalRounds += 1;
        if (items.some((item) => item?.source === 'person')) {
          // The draft final answer isn't posted: one answer covers everything.
          const hadDraft = Boolean(pendingText());
          blocks = [];
          partial = '';
          afterTool = false;
          update();
          result = await current.prompt(formatBotFinalInbox(items, { replacedDraft: hadDraft }));
        } else {
          // Not from the person (a routine, a task report): what was answered
          // so far stays a message of its own, and the reply goes on.
          sendPending();
          afterTool = false;
          stepMessage = null;
          update();
          result = await current.prompt(formatBotInbox(items));
        }
      }
    } catch (error) {
      attempt.error = error;
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort);
      attempt.sessionId = current?.sessionId ?? attempt.sessionId;
      current?.close?.();
      current = null;
    }
    return attempt;
  };

  // Removes `text` from the end of what the reply wrote (its streamed error line).
  function dropTrailingText(text) {
    const wanted = String(text ?? '').trim();
    if (!wanted) return;
    if (partial.trim() === wanted || partial.trim().endsWith(wanted)) partial = partial.trim().slice(0, -wanted.length);
    else if (blocks.length && String(blocks[blocks.length - 1]).trim().endsWith(wanted)) {
      const last = String(blocks.pop()).trim().slice(0, -wanted.length);
      if (last.trim()) blocks.push(last);
    }
    update();
  }
  const failureOf = (attempt) => errorText(attempt.error) || 'The harness ended before finishing the reply.';
  const nothingDone = () => !pendingText() && sentCount === 0 && !usedTools && segments.length === 0;
  const retryableHere = (attempt) => !attempt.ok && !ctx.signal?.aborted && nothingDone() && !attempt.unavailable && !isHarnessUnavailableError(failureOf(attempt));
  let attempt;
  let resumeFailed = false;
  try {
    attempt = await runAttempt(plan.mode === 'resume' ? { ...plan, sessionId: claimed.state.sessionId, systemAppend: claimed.state.systemAppend } : plan);
    if (plan.mode === 'resume' && !ctx.signal?.aborted && !attempt.unavailable && (attempt.resumeFailed || retryableHere(attempt))) {
      resumeFailed = true;
      pendingInbox.unshift(...deliveredItems.splice(0));
      deliveredSeqs.length = 0;
      finalRounds = 0;
      plan = planFor(null);
      attempt = await runAttempt(plan);
    }
  } finally {
    if (keptSessions && !claimed.busy) {
      const keep = plan.keep && attempt?.ok && !ctx.signal?.aborted && attempt.sessionId;
      await keptSessions
        .end(
          sessionKey,
          keep
            ? {
                sessionId: attempt.sessionId,
                basis,
                ...(lane.threadId ? { threadId: lane.threadId } : {}),
                systemAppend: attempt.systemAppend,
                memoryKey: plan.memoryKey,
                model: modelId,
                seenSeqs: [...plan.seenSeqs, ...deliveredSeqs].slice(-4_000),
                seenIds: [
                  ...plan.seenIds,
                  ...Array.from({ length: sentCount }, (_, index) => botReplyMessageId(lane.replyMessageId || lane.laneId, index)),
                  lane.replyMessageId || lane.laneId,
                ]
                  .filter(Boolean)
                  .slice(-4_000),
                contextKeys: plan.contextKeys,
                contextTokens: attempt.contextTokens,
                replies: plan.mode === 'resume' ? (claimed.state?.replies ?? 0) + 1 : 1,
              }
            : null
        )
        .catch(() => {});
    }
    mcp?.release?.();
  }

  const sessionInfo = { mode: plan.mode, reason: resumeFailed ? 'broken' : plan.reason, contextTokens: attempt.contextTokens, harness: providerId };
  if (attempt.usage) log(`bot ${lane.botId} reply usage`, JSON.stringify({ model: modelId, ...sessionInfo, ...attempt.usage }));
  const compact = Boolean(plan.compact || (attempt.contextTokens && attempt.contextTokens > sessionResetTokens));
  const extras = {
    ...(attempt.usage ? { usage: { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, costUsd: null, turns: null, ...attempt.usage, ...sessionInfo } } : {}),
    ...(compact ? { compact: true } : {}),
  };
  await sending;
  await Promise.all(fileLookups);
  const written =
    lane.finalMessageOnly && !sendsMessages
      ? selectFinalMessage([...segments, pendingText()].filter((text) => text.trim()))
      : [...segments, ...unsent.filter(Boolean), pendingText()].filter((text) => text.trim()).join('\n\n');
  const withModel = modelId ? { modelId } : {};
  const withSent = sentCount ? { sent: sentCount } : {};
  if (ctx.signal?.aborted) return { text: written, aborted: true, ...withSent, ...withModel, ...extras };
  const { text, files } = attaches
    ? await finishReplyFiles(written, replyFiles).catch(() => ({ text: written, files: replyFiles.list() }))
    : { text: written, files: [] };
  const withFiles = files.length ? { files } : {};
  if (attempt.ok) return { text, ...withSent, ...withFiles, ...withModel, ...extras };
  const reason = failureOf(attempt);
  const unavailable = attempt.unavailable || isHarnessUnavailableError(reason) || (attempt.apiError && isApiLimitError(reason));
  if (unavailable) onUnavailable(providerId, reason);
  // Nothing written or done yet: the next place (another machine, the cloud) answers instead.
  const retryElsewhere = (!text.trim() && sentCount === 0) || unavailable;
  return { text, failure: shorten(reason), retryElsewhere, ...withSent, ...withFiles, ...withModel, ...extras };
};
