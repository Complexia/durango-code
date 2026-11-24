import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import mcpBridgeShimSource from '../mcp-bridge-shim.cjs?raw';
import mcpBridgeShimModule from '../mcp-bridge-shim.cjs';
import { runShellCommand, shellPathSyncPromise } from './shell-env.js';
import { readThreadForAgent } from './thread-reader.js';
import { DURANGO_TOOL_NAMES, runDurangoTool } from './durango-tools.js';
import { USER_ACTION_TOOL_NAMES, runUserActionTool } from './user-actions.js';
import { SECRET_TOOL_NAMES, cancelSecretRequests, redactSecrets, resolveSecretRefs, runSecretTool } from './secret-requests.js';
import { VISUAL_TOOL_NAMES, runVisualTool } from './visual-tools.js';
import { THEME_TOOL_NAMES, runThemeTool, themeMcpToolDefinitions } from './theme-tools.js';
import { APP_TOOL_NAMES, appBridgeToolDefinitions, runAppTool } from './app-tools.js';
import { PROJECT_NOTES_TOOL_NAMES, projectNotesToolDefinitions, runProjectNotesTool } from './project-notes-tool.js';
import { BROWSER_TOOL_NAMES, browserMcpToolDefinitions, hasBuiltinBrowser, runBrowserTool, signedInBrowserFor } from './browser-tools.js';
import { DEVICE_TOOL_NAMES, runDeviceTool } from './device-tools.js';
import { MACHINE_TOOL_NAMES, machineMcpToolDefinitions, machineToolsAvailable, runMachineTool } from './machine-tools.js';
import {
  CALL_APP_TOOL_NAME,
  LOAD_TOOLS_TOOL_NAME,
  createOnDemandMcps,
  onDemandMcpToolDefinitions,
} from './mcp-on-demand.js';
import { agentDeviceAccessAllowed, readDeviceSettings } from './devices/device-settings.js';
import {
  acpOrionMcpServers,
  museOrionMcpServers,
  openCodeOrionMcpServers,
  pluginOrionMcpServers,
} from './orion-mcps.js';
import {
  isMcpBridgeProvider,
  probeProviderRunPluginSupport,
  providerDefersMcpToolsNatively,
} from './thread-reader-routing.js';

import {
  createBackgroundSubagents,
  spawnsSubagentsInBackground,
  subagentStartedText,
  waitSubagentsText,
  waitSubagentsTimeoutMs,
} from './background-subagents.js';

export let legacyMcpCleanupPromise = Promise.resolve();

// Orchestration: spawn_subagent calls waiting on the renderer to run the
// subthread and report back via the orchestration:subagentResult invoke.
export const pendingSubagentSpawns = new Map(); // spawnId -> { resolve, onOutcome, background, getSender, threadId }

// Subagents spawned in the background (providers whose MCP calls time out;
// see background-subagents.js): their reports wait here for wait_subagents.
// One nobody collected tells the renderer, which delivers it to the driver
// thread as a new message once that thread's turn has ended.
export const backgroundSubagents = createBackgroundSubagents({
  onUncollected: (entry) => {
    const sender = entry.getSender?.();
    if (!sender || sender.isDestroyed()) return;
    try {
      sender.send('orchestration:subagentReportsReady', { threadId: entry.driverThreadId });
    } catch {}
  },
});

const subagentOutcomeText = (payload) =>
  payload.ok
    ? payload.result || '(subagent returned no output)'
    : `Subagent failed: ${payload.result || 'unknown error'}`;

// The renderer created a spawn's subthread. A background spawn's call
// returns here; the report comes later through backgroundSubagents.
export const handleSubagentStarted = (payload) => {
  const pending = pendingSubagentSpawns.get(payload?.spawnId);
  if (!pending?.background) return { ok: false };
  pendingSubagentSpawns.delete(payload.spawnId);
  const entry = backgroundSubagents.start(payload.spawnId, {
    driverThreadId: pending.threadId,
    childThreadId: String(payload.childThreadId ?? ''),
    title: typeof payload.title === 'string' ? payload.title : '',
    model: typeof payload.model === 'string' ? payload.model : '',
    getSender: pending.getSender,
  });
  pending.resolve(subagentStartedText(entry));
  return { ok: true };
};

// The renderer reports a spawned subagent's outcome: it unblocks the
// spawn_subagent call that asked for it, or waits for wait_subagents when
// that call already returned (background spawns).
export const handleSubagentResult = (payload) => {
  const pending = pendingSubagentSpawns.get(payload?.spawnId);
  if (pending) {
    pendingSubagentSpawns.delete(payload.spawnId);
    // Stopped or deleted by the user (not a failure of its own).
    pending.onOutcome?.({ stopped: payload.stopped === true });
    pending.resolve(subagentOutcomeText(payload));
    return { ok: true };
  }
  const recorded = backgroundSubagents.finish(payload?.spawnId, {
    ok: payload?.ok === true,
    stopped: payload?.stopped === true,
    result: payload ? subagentOutcomeText(payload) : '',
  });
  return { ok: recorded };
};

// A driver thread whose turn ended takes the reports nobody collected.
export const takeSubagentReports = (threadId) =>
  typeof threadId === 'string' && threadId ? backgroundSubagents.take(threadId) : [];

// Orchestration: stop_subagent calls waiting on the renderer to halt the
// subthread and report back via the orchestration:subagentStopResult invoke.
export const pendingSubagentStops = new Map(); // stopId -> { resolve }

// Ask the renderer to run a subagent subthread and resolve with its final
// report. Failures resolve as text (never reject) so every caller — the
// Claude SDK tool and the socket bridge below — hands the model a readable
// outcome instead of a protocol error.
// `onOutcome({ stopped })` hears, just before the report resolves, whether
// the user stopped or deleted the subagent.
// `background`: resolve once the subthread has started instead of when it
// finishes (handleSubagentStarted); the report then waits in
// backgroundSubagents.
export const requestSubagentSpawn = ({ getSender, threadId, projectPath, accessMode }, args, { onOutcome, background = false } = {}) =>
  new Promise((resolve) => {
    // Read the sender at call time: sessions rebind it when the window
    // closes and reopens.
    const sender = getSender();
    if (!sender || sender.isDestroyed()) {
      resolve('Unable to spawn subagent: the Durango Code window is no longer available.');
      return;
    }
    const spawnId = crypto.randomUUID();
    pendingSubagentSpawns.set(spawnId, { resolve, onOutcome, background, getSender, threadId });
    try {
      sender.send('orchestration:spawnRequest', {
        spawnId,
        threadId,
        projectPath,
        accessMode,
        model: String(args.model ?? ''),
        prompt: String(args.prompt ?? ''),
        ...(args.title ? { title: String(args.title) } : {}),
        ...(args.role ? { role: String(args.role) } : {}),
        ...(args.effort ? { effort: String(args.effort) } : {}),
      });
    } catch {
      pendingSubagentSpawns.delete(spawnId);
      resolve('Unable to spawn subagent: the Durango Code window is no longer available.');
    }
  });

// Ask the renderer to stop a running subagent subthread of the calling
// driver thread. Resolves as text for the same reason as spawns above.
export const requestSubagentStop = ({ getSender, threadId }, args) =>
  new Promise((resolve) => {
    const sender = getSender();
    if (!sender || sender.isDestroyed()) {
      resolve('Unable to stop subagent: the Durango Code window is no longer available.');
      return;
    }
    const stopId = crypto.randomUUID();
    pendingSubagentStops.set(stopId, { resolve });
    try {
      sender.send('orchestration:stopRequest', {
        stopId,
        threadId,
        ...(args.model ? { model: String(args.model) } : {}),
        ...(args.title ? { title: String(args.title) } : {}),
        ...(args.all === true ? { all: true } : {}),
      });
    } catch {
      pendingSubagentStops.delete(stopId);
      resolve('Unable to stop subagent: the Durango Code window is no longer available.');
    }
  });

// -------------------- Orion MCP bridge (non-Claude providers) --------------------
// Claude turns get spawn_subagent from the in-process SDK MCP server below;
// every other provider CLI is handed the dependency-free stdio shim written
// to userData. Cursor and Grok receive it through process-only plugins;
// Codex, Kimi, and OpenCode accept per-run MCP configuration directly. Every
// path carries an exact token, so concurrent runs never route by cwd.
export const mcpBridgeSessions = new Map(); // token -> { getSender, threadId, runId, projectPath, accessMode }

let mcpBridgeInstanceIdCache = null;
// The single-instance lock already prevents two processes from sharing one
// profile. Hashing userData keeps dev and packaged profiles distinct while
// leaving one stable socket path that can be unlinked on restart. Computed
// lazily because the dev build swaps userData after startup imports.
const mcpBridgeInstanceId = () => {
  mcpBridgeInstanceIdCache ??= crypto
    .createHash('sha256')
    .update(app.getPath('userData'))
    .digest('hex')
    .slice(0, 16);
  return mcpBridgeInstanceIdCache;
};
export const mcpBridgeSocketPath = () =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\orion-mcp-${mcpBridgeInstanceId()}`
    : path.join(app.getPath('userData'), `orion-mcp-${mcpBridgeInstanceId()}.sock`);

const { createOrionMcpBridgeHandler } = mcpBridgeShimModule;

// Shared tool dispatcher used by both the Unix socket bridge (stdio shim) and
// the direct loopback HTTP MCP endpoint. Always returns a secret-scrubbed
// `{ ok, text, ... }` result and never rejects.
export const dispatchBridgeToolCall = async (session, tool, rawArgs) => {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  // `alsoValues`: secrets this call was handed through refs, scrubbed
  // whatever their length.
  let alsoValues = [];
  const finish = (ok, text, extra) =>
    redactSecrets({ ok, text, ...(extra ?? {}) }, { alsoValues });

  // The shim's tools/list (and the HTTP handler) asks which tools this run
  // gets beyond its fixed set, so the browser_* schemas live only in
  // browser-tools.js.
  if (tool === '__tools') {
    return finish(true, '', {
      tools: [
        ...(hasBuiltinBrowser(session.browserMode) ? browserMcpToolDefinitions(session.accessMode) : []),
        // The user's other machines, while remote control can reach one.
        ...(session.machinesEnabled ? machineMcpToolDefinitions(session.accessMode) : []),
        // The run's MCP servers load on demand (mcp-on-demand.js).
        ...onDemandMcpToolDefinitions(session.onDemandMcps?.names() ?? []),
        // Restyling Durango Code itself (theme-tools.js).
        ...themeMcpToolDefinitions(session.accessMode),
        // Using Durango Code's own window (app-tools.js).
        ...appBridgeToolDefinitions(session.accessMode),
        // The thread's project notes (project-notes-tool.js).
        ...projectNotesToolDefinitions(),
      ],
    });
  }
  if (tool === LOAD_TOOLS_TOOL_NAME || tool === CALL_APP_TOOL_NAME) {
    if (!session.onDemandMcps || session.onDemandMcps.names().length === 0) {
      return finish(false, 'No connected apps are available in this run.');
    }
    // A connected app's tool takes secrets: refs in its arguments become
    // the values (secret-requests.js).
    let appArgs = args;
    if (tool === CALL_APP_TOOL_NAME) {
      const resolved = resolveSecretRefs(args, { threadId: session.threadId });
      if (!resolved.ok) return finish(false, resolved.text);
      appArgs = resolved.value;
      alsoValues = resolved.values;
    }
    try {
      const { ok, text, content } =
        tool === LOAD_TOOLS_TOOL_NAME
          ? await session.onDemandMcps.load(args)
          : await session.onDemandMcps.call(appArgs, { accessMode: session.accessMode });
      return finish(ok, text, Array.isArray(content) && content.length ? { content } : undefined);
    } catch (error) {
      return finish(false, `${tool} failed: ${error?.message ?? error}`);
    }
  }
  if (BROWSER_TOOL_NAMES.includes(tool)) {
    if (!hasBuiltinBrowser(session.browserMode)) {
      return finish(false, 'The built-in browser is turned off for this provider in Durango Code settings.');
    }
    try {
      const { ok, text, images } = await runBrowserTool(tool, args, {
        ...session,
        signedInBrowser: signedInBrowserFor(session.browserMode),
      });
      return finish(
        ok,
        text,
        images?.length
          ? {
              content: [
                { type: 'text', text },
                ...images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType })),
              ],
            }
          : undefined
      );
    } catch (error) {
      return finish(false, `Browser tool failed: ${error?.message ?? error}`);
    }
  }
  if (tool === 'spawn_subagent') {
    if (
      typeof args.model !== 'string' ||
      !args.model.trim() ||
      typeof args.prompt !== 'string' ||
      !args.prompt.trim()
    ) {
      return finish(false, 'spawn_subagent requires string `model` and `prompt` arguments.');
    }
    if (args.effort !== undefined && typeof args.effort !== 'string') {
      return finish(false, 'spawn_subagent takes an optional string `effort` argument.');
    }
    const text = await requestSubagentSpawn(session, args, {
      background: spawnsSubagentsInBackground(session.providerId),
    });
    return finish(true, text);
  }
  if (tool === 'wait_subagents') {
    if (args.timeout_seconds !== undefined && typeof args.timeout_seconds !== 'number') {
      return finish(false, 'wait_subagents takes an optional number `timeout_seconds` argument.');
    }
    const outcome = await backgroundSubagents.wait(session.threadId, {
      timeoutMs: waitSubagentsTimeoutMs(args.timeout_seconds),
      signal: session.abortController?.signal,
    });
    return finish(true, waitSubagentsText(outcome));
  }
  if (tool === 'stop_subagent') {
    if (
      (args.model !== undefined && typeof args.model !== 'string') ||
      (args.title !== undefined && typeof args.title !== 'string') ||
      (args.all !== undefined && typeof args.all !== 'boolean')
    ) {
      return finish(
        false,
        'stop_subagent takes optional string `model`/`title` and boolean `all` arguments.'
      );
    }
    const text = await requestSubagentStop(session, args);
    return finish(true, text);
  }
  if (tool === 'read_thread') {
    if (typeof args.thread_id !== 'string' || !args.thread_id.trim()) {
      return finish(false, 'read_thread requires a string `thread_id` argument.');
    }
    try {
      const text = await readThreadForAgent(args);
      return finish(true, text);
    } catch (error) {
      return finish(false, `Could not read the thread: ${error?.message ?? error}`);
    }
  }
  if (DURANGO_TOOL_NAMES.includes(tool)) {
    // Resolves (never rejects) with readable text, including when the
    // user is signed out or Durango is unreachable.
    try {
      const { ok, text } = await runDurangoTool(tool, args, { accessMode: session.accessMode });
      return finish(ok, text);
    } catch (error) {
      return finish(false, `Durango request failed: ${error?.message ?? error}`);
    }
  }
  if (USER_ACTION_TOOL_NAMES.includes(tool)) {
    const { ok, text } = await runUserActionTool(tool, args, session);
    return finish(ok, text);
  }
  if (SECRET_TOOL_NAMES.includes(tool)) {
    // Blocks until the user answers; the run's release cancels it.
    const { ok, text } = await runSecretTool(tool, args, { ...session, owner: session });
    return finish(ok, text);
  }
  if (THEME_TOOL_NAMES.includes(tool)) {
    // Resolves, never rejects; screenshots come back as image blocks.
    const { ok, text, content } = await runThemeTool(tool, args, {
      getSender: session.getSender,
      threadId: session.threadId,
      runId: session.runId,
      accessMode: session.accessMode,
      signal: session.abortController?.signal,
    });
    return finish(ok, text, Array.isArray(content) && content.length ? { content } : undefined);
  }
  if (APP_TOOL_NAMES.includes(tool)) {
    // Re-checks the run's access mode; resolves, never rejects. These
    // providers can't be relied on to ask before an action (Codex approves
    // every orion tool), so actions need Full access here.
    const { ok, text, content } = await runAppTool(tool, args, {
      getSender: session.getSender,
      threadId: session.threadId,
      accessMode: session.accessMode,
      requireFullAccess: true,
    });
    return finish(ok, text, Array.isArray(content) && content.length ? { content } : undefined);
  }
  if (PROJECT_NOTES_TOOL_NAMES.includes(tool)) {
    const { ok, text } = await runProjectNotesTool(tool, args, {
      projectId: session.projectId,
      projectPath: session.projectPath,
    });
    return finish(ok, text);
  }
  if (VISUAL_TOOL_NAMES.includes(tool)) {
    const { ok, text } = await runVisualTool(tool, args, session);
    return finish(ok, text);
  }
  if (DEVICE_TOOL_NAMES.includes(tool)) {
    // Re-checks the user's device settings and the run's access mode
    // itself; resolves, never rejects.
    const { ok, text, content } = await runDeviceTool(tool, args, {
      threadId: session.threadId,
      getSender: session.getSender,
      accessMode: session.accessMode,
    });
    return finish(ok, text, Array.isArray(content) && content.length ? { content } : undefined);
  }
  if (MACHINE_TOOL_NAMES.includes(tool)) {
    if (!session.machinesEnabled) {
      return finish(false, 'No other machine was reachable when this run started.');
    }
    // Re-checks remote control and the run's access mode; resolves,
    // never rejects.
    const { ok, text } = await runMachineTool(tool, args, {
      accessMode: session.accessMode,
      projectPath: session.projectPath,
      threadId: session.threadId,
      providerId: session.providerId,
      modelId: session.modelId,
      // These providers can't be relied on to ask before a command
      // (Codex approves every orion tool): Full access only.
      requireFullAccess: true,
      // Stopping the run cancels a command there and ends a wait.
      signal: session.abortController?.signal,
    });
    return finish(ok, text);
  }
  return finish(false, `Unknown tool: ${tool}`);
};

export const handleMcpBridgeConnection = (socket) => {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message = null;
      try {
        message = JSON.parse(line);
      } catch {}
      if (!message || message.id === undefined) continue;
      const sendReply = (payload) => {
        try {
          socket.write(`${JSON.stringify({ id: message.id, ...payload })}\n`);
        } catch {}
      };
      const session =
        typeof message.token === 'string' && message.token
          ? mcpBridgeSessions.get(message.token)
          : undefined;
      if (!session || session.released || session.abortController?.signal?.aborted) {
        sendReply({
          ok: false,
          text: 'This Durango Code agent session token is missing, invalid, or expired.',
        });
        continue;
      }
      void dispatchBridgeToolCall(session, message.tool, message.args).then(sendReply);
    }
  });
  socket.on('error', () => {});
};

// -------------------- Direct HTTP MCP bridge (Streamable HTTP) --------------------
// ACP providers that advertise `mcpCapabilities.http === true` (e.g. Antigravity)
// connect directly to this loopback HTTP endpoint with a per-run bearer token
// instead of spawning an ELECTRON_RUN_AS_NODE stdio shim child process.
const MCP_HTTP_MAX_BODY_BYTES = 10 * 1024 * 1024;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

const isAllowedLoopbackHost = (hostHeader, expectedPort) => {
  if (typeof hostHeader !== 'string' || !hostHeader.trim()) return false;
  try {
    const parsed = new URL(`http://${hostHeader.trim()}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return false;
    }
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) return false;
    if (expectedPort && (!parsed.port || Number(parsed.port) !== expectedPort)) return false;
    return true;
  } catch {
    return false;
  }
};

const isAllowedOrigin = (originHeader) => {
  if (originHeader === undefined) return true;
  if (typeof originHeader !== 'string' || !originHeader.trim()) return false;
  try {
    const parsed = new URL(originHeader.trim());
    return LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};

const constantTimeTokenEqual = (presented, candidate) => {
  const presentedBuf = Buffer.from(presented, 'utf8');
  const candidateBuf = Buffer.from(candidate, 'utf8');
  if (presentedBuf.length !== candidateBuf.length) return false;
  return crypto.timingSafeEqual(presentedBuf, candidateBuf);
};

const authenticateMcpHttpSession = (authHeader) => {
  if (typeof authHeader !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  if (!match) return null;
  const presented = match[1];
  let matchedSession = null;
  for (const [candidateToken, candidateSession] of mcpBridgeSessions.entries()) {
    if (constantTimeTokenEqual(presented, candidateToken)) {
      matchedSession = candidateSession;
    }
  }
  return matchedSession;
};

const getHttpMcpHandler = (session) => {
  if (!session.httpMcpHandler) {
    session.httpMcpHandler = createOrionMcpBridgeHandler({
      devicesEnabled: session.devicesEnabled === true,
      compactTools:
        session.compactTools !== undefined
          ? session.compactTools === true
          : !providerDefersMcpToolsNatively(session.providerId),
      describeServer:
        session.describeServer !== undefined
          ? session.describeServer === true
          : session.providerId === 'codex',
      backgroundSubagents:
        session.backgroundSubagents !== undefined
          ? session.backgroundSubagents === true
          : spawnsSubagentsInBackground(session.providerId),
      cacheExtraTools: false,
      callOrion: (tool, args) => {
        if (session.released || session.abortController?.signal?.aborted) {
          return Promise.resolve({ ok: false, text: 'This agent turn has already ended.' });
        }
        return dispatchBridgeToolCall(session, tool, args);
      },
    });
  }
  return session.httpMcpHandler;
};

const sendHttpJson = (res, status, payload, extraHeaders = {}) => {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(payload));
};

const readHttpRequestBody = (req, maxBytes = MCP_HTTP_MAX_BODY_BYTES) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error('Request body too large');
        error.code = 'PAYLOAD_TOO_LARGE';
        fail(error);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', fail);
  });

const handleMcpHttpJsonRpcMessage = async (handler, message) => {
  if (!isPlainRecord(message)) {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    };
  }
  if (typeof message.method !== 'string') {
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== undefined;
    // A JSON-RPC response sent by the client has no method; accept silently.
    if (!hasId || Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error')) {
      return null;
    }
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32600, message: 'Invalid Request' },
    };
  }
  return handler.handleMessage(message);
};

const handleMcpHttpRequest = async (req, res, expectedPort) => {
  try {
    if (!isAllowedLoopbackHost(req.headers.host, expectedPort) || !isAllowedOrigin(req.headers.origin)) {
      sendHttpJson(res, 403, { error: 'Forbidden' });
      return;
    }
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      sendHttpJson(res, 400, { error: 'Invalid URL' });
      return;
    }
    if (pathname !== '/mcp') {
      sendHttpJson(res, 404, { error: 'Not found' });
      return;
    }
    const session = authenticateMcpHttpSession(req.headers.authorization);
    if (!session || session.released || session.abortController?.signal?.aborted) {
      sendHttpJson(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    const expectedGeneration = session.turnGeneration ?? 0;
    const isSessionStillValid = () =>
      !session.released &&
      authenticateMcpHttpSession(req.headers.authorization) === session &&
      (session.turnGeneration ?? 0) === expectedGeneration &&
      !session.abortController?.signal?.aborted;
    const method = (req.method || '').toUpperCase();
    if (method === 'GET') {
      sendHttpJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST, DELETE' });
      return;
    }
    if (method === 'DELETE') {
      session.httpMcpHandler = null;
      if (!res.writableEnded && !res.destroyed) res.writeHead(204).end();
      return;
    }
    if (method !== 'POST') {
      sendHttpJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST, DELETE' });
      return;
    }
    let rawBody;
    try {
      rawBody = await readHttpRequestBody(req);
    } catch (error) {
      if (error?.code === 'PAYLOAD_TOO_LARGE') {
        sendHttpJson(res, 413, { error: 'Request body too large' });
        return;
      }
      throw error;
    }
    // Revalidate token registration, turn generation, and abort state after
    // awaiting the request body so a late-arriving body cannot execute after
    // the turn stopped, rebound, or released its bridge token.
    if (!isSessionStillValid()) {
      sendHttpJson(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      sendHttpJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }
    const handler = getHttpMcpHandler(session);
    const dispatchGuarded = (entry) => {
      if (!isSessionStillValid()) {
        return Promise.resolve({
          jsonrpc: '2.0',
          id: isPlainRecord(entry) && entry.id !== undefined ? entry.id : null,
          error: { code: -32001, message: 'Session ended.' },
        });
      }
      return handleMcpHttpJsonRpcMessage(handler, entry);
    };
    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        sendHttpJson(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid Request' },
        });
        return;
      }
      const replies = (
        await Promise.all(payload.map((entry) => dispatchGuarded(entry)))
      ).filter((reply) => reply !== null);
      if (replies.length === 0) {
        if (!res.writableEnded && !res.destroyed) res.writeHead(202).end();
        return;
      }
      sendHttpJson(res, 200, replies);
      return;
    }
    if (!isPlainRecord(payload)) {
      sendHttpJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      });
      return;
    }
    const reply = await dispatchGuarded(payload);
    if (reply === null) {
      if (!res.writableEnded && !res.destroyed) res.writeHead(202).end();
      return;
    }
    sendHttpJson(res, 200, reply);
  } catch (error) {
    console.error('Orion HTTP MCP bridge request error:', error);
    sendHttpJson(res, 500, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Internal error' },
    });
  }
};

let mcpBridgeServer = null;
let mcpHttpServer = null;

export let mcpBridgePromise = null;
export const ensureMcpBridge = () => {
  if (!mcpBridgePromise) {
    mcpBridgePromise = (async () => {
      const shimPath = path.join(app.getPath('userData'), 'orion-mcp-bridge.cjs');
      let existing = null;
      try {
        existing = await fs.readFile(shimPath, 'utf-8');
      } catch {}
      if (existing !== mcpBridgeShimSource) await fs.writeFile(shimPath, mcpBridgeShimSource);
      const socketPath = mcpBridgeSocketPath();
      if (process.platform !== 'win32') {
        try {
          await fs.unlink(socketPath);
        } catch {}
      }
      const server = net.createServer(handleMcpBridgeConnection);
      await new Promise((resolve, reject) => {
        const onStartupError = (error) => reject(error);
        server.once('error', onStartupError);
        server.listen(socketPath, () => {
          server.off('error', onStartupError);
          server.on('error', (error) => console.error('Orion MCP bridge server error:', error));
          resolve();
        });
      });
      mcpBridgeServer = server;
      return { shimPath, socketPath };
    })().catch((error) => {
      // Allow a later run to retry a failed setup instead of caching the error.
      mcpBridgePromise = null;
      throw error;
    });
  }
  return mcpBridgePromise;
};

export let mcpHttpBridgePromise = null;
export const ensureMcpHttpBridge = () => {
  if (!mcpHttpBridgePromise) {
    mcpHttpBridgePromise = (async () => {
      let port = 0;
      const server = http.createServer((req, res) => {
        void handleMcpHttpRequest(req, res, port);
      });
      await new Promise((resolve, reject) => {
        const onStartupError = (error) => reject(error);
        server.once('error', onStartupError);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', onStartupError);
          server.on('error', (error) => console.error('Orion HTTP MCP bridge server error:', error));
          const address = server.address();
          port = typeof address === 'object' && address ? address.port : 0;
          resolve();
        });
      });
      mcpHttpServer = server;
      return { port, httpUrl: `http://127.0.0.1:${port}/mcp` };
    })().catch((error) => {
      mcpHttpBridgePromise = null;
      throw error;
    });
  }
  return mcpHttpBridgePromise;
};

export const closeMcpBridge = async () => {
  const socketServer = mcpBridgeServer;
  const httpServer = mcpHttpServer;
  const pendingSocket = mcpBridgePromise;
  const pendingHttp = mcpHttpBridgePromise;
  mcpBridgeServer = null;
  mcpHttpServer = null;
  mcpBridgePromise = null;
  mcpHttpBridgePromise = null;

  const closeServer = (server) =>
    new Promise((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      try {
        server.closeAllConnections?.();
      } catch {}
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });

  await Promise.all([
    closeServer(socketServer),
    closeServer(httpServer),
    pendingSocket
      ?.then(() => {
        if (mcpBridgeServer && mcpBridgeServer !== socketServer) {
          const late = mcpBridgeServer;
          mcpBridgeServer = null;
          return closeServer(late);
        }
      })
      .catch(() => {}),
    pendingHttp
      ?.then(() => {
        if (mcpHttpServer && mcpHttpServer !== httpServer) {
          const late = mcpHttpServer;
          mcpHttpServer = null;
          return closeServer(late);
        }
      })
      .catch(() => {}),
  ]);

  if (process.platform !== 'win32') {
    try {
      await fs.unlink(mcpBridgeSocketPath());
    } catch {}
  }
};

// Registers a run with the bridge and returns everything the provider needs
// to launch the shim. Returns null when the bridge can't start — the run then
// simply proceeds without the spawn_subagent tool.
export const isPlainRecord = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Orion-connected MCP servers ride along in the same per-run plugin, so
// Cursor and Grok load them without touching the user's own config files.
export const mcpBridgePluginConfig = ({ command, args, userServers = [] }) => ({
  mcpServers: {
    ...pluginOrionMcpServers(userServers),
    orion: {
      command,
      args,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
  },
});

export const writeMcpBridgePlugin = async ({ token, command, args, userServers }) => {
  // Keep the leaf directory stable (`orion`) so Cursor's plugin-qualified
  // server name remains stable, while the token parent isolates every run.
  const tokenRoot = path.join(app.getPath('userData'), 'mcp-runs', token);
  const pluginDir = path.join(tokenRoot, 'orion');
  const cursorManifestDir = path.join(pluginDir, '.cursor-plugin');
  const grokManifestDir = path.join(pluginDir, '.claude-plugin');
  await Promise.all([
    fs.mkdir(cursorManifestDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(grokManifestDir, { recursive: true, mode: 0o700 }),
  ]);
  const manifest = JSON.stringify(
    { name: 'orion', version: '1.0.0', description: 'Durango Code subagent bridge' },
    null,
    2
  );
  const mcpConfig = JSON.stringify(mcpBridgePluginConfig({ command, args, userServers }), null, 2);
  await Promise.all([
    fs.writeFile(path.join(cursorManifestDir, 'plugin.json'), `${manifest}\n`, { mode: 0o600 }),
    fs.writeFile(path.join(grokManifestDir, 'plugin.json'), `${manifest}\n`, { mode: 0o600 }),
    fs.writeFile(path.join(pluginDir, 'mcp.json'), `${mcpConfig}\n`, { mode: 0o600 }),
    fs.writeFile(path.join(pluginDir, '.mcp.json'), `${mcpConfig}\n`, { mode: 0o600 }),
  ]);
  return { pluginDir, tokenRoot };
};

export const runPluginSupportPromises = new Map();
export const providerSupportsRunPlugin = (providerId) => {
  if (providerId !== 'cursor' && providerId !== 'grok') return Promise.resolve(true);
  if (!runPluginSupportPromises.has(providerId)) {
    runPluginSupportPromises.set(
      providerId,
      probeProviderRunPluginSupport(providerId, {
        shellPathReady: shellPathSyncPromise,
        runShellCommand,
      })
    );
  }
  return runPluginSupportPromises.get(providerId);
};

// Claude registers read_thread in-process. The other supported providers use
// the per-run bridge; Cursor and Grok can only receive it when their installed
// CLI exposes --plugin-dir.
export const providerSupportsThreadReader = async (providerId) => {
  if (providerId === 'claude') return true;
  if (!isMcpBridgeProvider(providerId)) return false;
  return providerSupportsRunPlugin(providerId);
};

export const registerMcpBridgeForRun = async ({
  getSender,
  threadId,
  runId,
  projectPath,
  projectId = null,
  providerId,
  modelId,
  accessMode,
  browserMode = 'off',
  userServers = [],
}) => {
  try {
    await legacyMcpCleanupPromise;
    const [{ shimPath, socketPath }, httpBridge] = await Promise.all([
      ensureMcpBridge(),
      ensureMcpHttpBridge().catch((error) => {
        console.error('Orion HTTP MCP bridge unavailable:', error);
        return null;
      }),
    ]);
    const token = crypto.randomUUID();
    // ELECTRON_RUN_AS_NODE turns Orion's own binary into a plain Node runtime;
    // forge.config.js deliberately keeps that fuse enabled for this shim.
    const command = process.execPath;
    // --devices: the shim lists the device_* tools (the user let agents use
    // simulators). The tools re-check the setting on every call.
    const devicesEnabled = agentDeviceAccessAllowed(await readDeviceSettings());
    // --compact-tools: the provider would put every tool's full definition
    // in each request, so the shim lists summaries and load_tools serves the
    // rest. Providers that defer MCP tools themselves get the full list.
    const compactTools = !providerDefersMcpToolsNatively(providerId);
    // spawn_subagent returns once the subthread starts and wait_subagents
    // collects reports (background-subagents.js).
    const backgroundSubagents = spawnsSubagentsInBackground(providerId);
    // Codex lists the server as a deferred namespace: give it a one-line
    // description of what the tools are for.
    const describeServer = providerId === 'codex';
    const args = [
      shimPath,
      '--socket',
      socketPath,
      '--token',
      token,
      ...(devicesEnabled ? ['--devices'] : []),
      ...(compactTools ? ['--compact-tools'] : []),
      ...(backgroundSubagents ? ['--background-subagents'] : []),
      ...(describeServer ? ['--instructions'] : []),
    ];
    // The run's MCP servers stay out of the provider's config: the bridge
    // connects them only when the agent loads them (mcp-on-demand.js).
    const { pluginDir, tokenRoot } = await writeMcpBridgePlugin({
      token,
      command,
      args,
      userServers: [],
    });
    const onDemandMcps = createOnDemandMcps(userServers);
    const session = {
      getSender,
      threadId,
      runId,
      projectPath,
      // The thread's Durango Code project (project_notes); projectPath may be a workspace outside it.
      projectId: typeof projectId === 'string' && projectId ? projectId : null,
      providerId,
      modelId,
      accessMode,
      browserMode,
      devicesEnabled,
      compactTools,
      backgroundSubagents,
      describeServer,
      onDemandMcps,
      // Fixed for the run, like the device tools (each call re-checks).
      machinesEnabled: machineToolsAvailable(),
      // Aborted when the run ends: tool calls still in flight stop.
      abortController: new AbortController(),
      released: false,
      turnGeneration: 1,
    };
    mcpBridgeSessions.set(token, session);
    return {
      token,
      socketPath,
      shimPath,
      command,
      args,
      pluginDir,
      tokenRoot,
      ...(httpBridge
        ? {
            httpUrl: httpBridge.httpUrl,
            httpHeaders: [{ name: 'Authorization', value: `Bearer ${token}` }],
          }
        : {}),
      // Provider-specific MCP intakes (ACP session params, OpenCode inline
      // config, Muse root) get only the bridge: the run's own servers load
      // on demand through it.
      userServers: [],
      // Settled browser mode after provider-specific fallbacks (Codex's
      // extension check runs after registration).
      setBrowserMode: (mode) => {
        session.browserMode = mode;
      },
      // Persistent ACP sessions (Antigravity) reuse one MCP bridge lease across
      // turns so the registered server stays connected; each turn refreshes the
      // mutable per-turn metadata and gets a fresh AbortController.
      rebindTurn: ({
        runId: nextRunId,
        modelId: nextModelId,
        accessMode: nextAccessMode,
        browserMode: nextBrowserMode,
        getSender: nextGetSender,
      } = {}) => {
        if (nextRunId) session.runId = nextRunId;
        if (nextModelId) session.modelId = nextModelId;
        if (nextAccessMode) session.accessMode = nextAccessMode;
        if (nextBrowserMode !== undefined) session.browserMode = nextBrowserMode;
        if (typeof nextGetSender === 'function') session.getSender = nextGetSender;
        session.turnGeneration = (session.turnGeneration ?? 0) + 1;
        session.abortController = new AbortController();
      },
      abortTurn: () => {
        session.turnGeneration = (session.turnGeneration ?? 0) + 1;
        // Leave `abortController` aborted while the warm session sits idle so
        // no out-of-turn MCP call can execute until `rebindTurn()` starts the
        // next turn with a fresh controller.
        session.abortController.abort();
        cancelSecretRequests({ owner: session });
      },
      release: () => {
        session.released = true;
        session.turnGeneration = (session.turnGeneration ?? 0) + 1;
        mcpBridgeSessions.delete(token);
        session.httpMcpHandler = null;
        session.abortController.abort();
        cancelSecretRequests({ owner: session });
        void onDemandMcps.close();
        void fs.rm(tokenRoot, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (error) {
    console.error('Orion MCP bridge unavailable:', error);
    return null;
  }
};

// Muse reads MCP servers only from `<config root>/muse/settings.json`
// (`mcp_servers`, a map of Claude-style {transport, command, args, env}
// entries) and `muse exec` has no per-run config flag — so each muse run gets
// a synthetic XDG_CONFIG_HOME under the run's token directory. The override
// leaks into the model's shell commands, where XDG-aware tools (git, gh)
// resolve config through it, so every non-muse entry of the real root is
// symlinked through. Inside muse/ every file except settings.json is
// symlinked too (auth.json token refreshes land in the real file);
// settings.json is the user's own settings plus the bridge entry. Muse scrubs
// its own environment from MCP server children, so ELECTRON_RUN_AS_NODE must
// travel in the entry's env map (all verified live on muse 0.1.0).
export const museUserConfigRoot = () =>
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');

export const writeMuseMcpConfigRoot = async (orionMcp) => {
  if (!orionMcp?.tokenRoot) return null;
  const userServers = museOrionMcpServers(orionMcp.userServers);
  try {
    const syntheticRoot = path.join(orionMcp.tokenRoot, 'muse-xdg');
    const syntheticMuseDir = path.join(syntheticRoot, 'muse');
    await fs.mkdir(syntheticMuseDir, { recursive: true, mode: 0o700 });

    const realRoot = museUserConfigRoot();
    const mirror = async (sourceDir, targetDir, skip) => {
      let entries = [];
      try {
        entries = await fs.readdir(sourceDir);
      } catch {
        return;
      }
      await Promise.all(
        entries
          .filter((name) => !skip.has(name))
          .map((name) =>
            fs.symlink(path.join(sourceDir, name), path.join(targetDir, name)).catch(() => {})
          )
      );
    };
    await mirror(realRoot, syntheticRoot, new Set(['muse']));
    await mirror(path.join(realRoot, 'muse'), syntheticMuseDir, new Set(['settings.json']));

    let settings = {};
    try {
      const parsed = JSON.parse(
        await fs.readFile(path.join(realRoot, 'muse', 'settings.json'), 'utf-8')
      );
      if (isPlainRecord(parsed)) settings = parsed;
    } catch {}
    await fs.writeFile(
      path.join(syntheticMuseDir, 'settings.json'),
      `${JSON.stringify(
        {
          schema_version: 1,
          ...settings,
          mcp_servers: {
            ...(isPlainRecord(settings.mcp_servers) ? settings.mcp_servers : {}),
            ...userServers,
            orion: {
              transport: 'stdio',
              command: orionMcp.command,
              args: orionMcp.args,
              env: { ELECTRON_RUN_AS_NODE: '1' },
            },
          },
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    return syntheticRoot;
  } catch (error) {
    console.error('Muse MCP config root unavailable:', error);
    return null;
  }
};

// The ACP wire shape (session/new + session/load mcpServers) for the bridge.
export const orionAcpMcpServers = (orionMcp) =>
  orionMcp
    ? [
        ...acpOrionMcpServers(orionMcp.userServers),
        {
          name: 'orion',
          command: orionMcp.command,
          args: orionMcp.args,
          env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
        },
      ]
    : [];

// Direct HTTP ACP wire shape for providers advertising `mcpCapabilities.http === true`.
// Falls back to the stdio shim when the HTTP endpoint is unavailable.
export const orionAcpHttpMcpServers = (orionMcp) =>
  orionMcp?.httpUrl
    ? [
        ...acpOrionMcpServers(orionMcp.userServers),
        {
          type: 'http',
          name: 'orion',
          url: orionMcp.httpUrl,
          headers: Array.isArray(orionMcp.httpHeaders) ? orionMcp.httpHeaders : [],
        },
      ]
    : orionAcpMcpServers(orionMcp);

export const openCodeMcpConfigContent = (orionMcp, existingContent) => {
  if (!orionMcp) return null;
  let base = {};
  if (typeof existingContent === 'string' && existingContent.trim()) {
    try {
      base = JSON.parse(existingContent);
    } catch (error) {
      console.error('OpenCode inline config is invalid; Orion MCP bridge omitted:', error);
      return null;
    }
    if (!isPlainRecord(base)) {
      console.error('OpenCode inline config must be an object; Orion MCP bridge omitted.');
      return null;
    }
  }
  const existingMcp = base.mcp === undefined ? {} : base.mcp;
  if (!isPlainRecord(existingMcp)) {
    console.error('OpenCode inline `mcp` config must be an object; Orion MCP bridge omitted.');
    return null;
  }
  return JSON.stringify({
    ...base,
    mcp: {
      ...existingMcp,
      ...openCodeOrionMcpServers(orionMcp.userServers),
      orion: {
        type: 'local',
        command: [orionMcp.command, ...orionMcp.args],
        environment: { ELECTRON_RUN_AS_NODE: '1' },
        enabled: true,
      },
    },
  });
};

// Remove only the persistent bridge entries written by the short-lived
// global-config implementation. Current runs use process-only plugins, so
// leaving these behind would load duplicate/stale Orion servers.
export const grokMcpBlockStart = '# >>> orion mcp bridge >>>';
export const grokMcpBlockEnd = '# <<< orion mcp bridge <<<';
export const cleanupLegacyMcpBridgeConfigs = async () => {
  // Per-run plugins are disposable. A crash may leave an old tokenized
  // directory behind, but no active process can legitimately use it after a
  // fresh app launch.
  await fs
    .rm(path.join(app.getPath('userData'), 'mcp-runs'), { recursive: true, force: true })
    .catch(() => {});

  const grokConfigPath = path.join(os.homedir(), '.grok', 'config.toml');
  try {
    const existing = await fs.readFile(grokConfigPath, 'utf-8');
    const startIndex = existing.indexOf(grokMcpBlockStart);
    const endIndex =
      startIndex === -1 ? -1 : existing.indexOf(grokMcpBlockEnd, startIndex);
    if (startIndex !== -1 && endIndex !== -1) {
      const afterIndex = endIndex + grokMcpBlockEnd.length;
      const before = existing.slice(0, startIndex);
      let after = existing.slice(afterIndex);
      if (before.endsWith('\n') && after.startsWith('\n')) after = after.slice(1);
      await fs.writeFile(grokConfigPath, `${before}${after}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error('Could not remove legacy Grok MCP bridge:', error);
  }

  const cursorConfigPath = path.join(os.homedir(), '.cursor', 'mcp.json');
  try {
    const existing = await fs.readFile(cursorConfigPath, 'utf-8');
    const config = JSON.parse(existing);
    const entry = config?.mcpServers?.orion;
    const legacyArgs = Array.isArray(entry?.args) ? entry.args : [];
    const isLegacyEntry =
      typeof entry?.command === 'string' &&
      legacyArgs.some(
        (value) => typeof value === 'string' && path.basename(value) === 'orion-mcp-bridge.cjs'
      ) &&
      entry?.env?.ELECTRON_RUN_AS_NODE === '1';
    if (isLegacyEntry) {
      delete config.mcpServers.orion;
      await fs.writeFile(cursorConfigPath, `${JSON.stringify(config, null, 2)}\n`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error('Could not remove legacy Cursor MCP bridge:', error);
  }
};

export const startLegacyMcpCleanup = () => {
  legacyMcpCleanupPromise = cleanupLegacyMcpBridgeConfigs().catch((error) => {
    console.error('Could not finish legacy MCP bridge cleanup:', error);
  });
  return legacyMcpCleanupPromise;
};
