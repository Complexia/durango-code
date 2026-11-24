import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatToolInput, stringifySummary } from './stream-adapters.js';
import { antigravityToolLabel } from './antigravity-tool-labels.js';

// Antigravity subagents (agy 1.5's invoke_subagent tool). On ACP the launch is
// an ordinary tool call that completes as soon as the child is spawned, with
// no child id; the child then works in its own conversation and reports to
// the parent with send_message, and the parent replies by itself after its
// prompt has ended. Everything about the child is on disk under
// ~/.gemini/antigravity-cli/brain (verified on agy 1.5.14; the same files
// T3 Code reads in apps/server/src/provider/acp/AntigravityChildWork.ts):
//   brain/<parent>/.system_generated/subagents/<child>.json   child list
//   brain/<child>/.system_generated/messages/<id>.json        child inbox; the
//     launch message's sourceMetadata.tool.toolCall.id is the ACP toolCallId
//   brain/<child>/.system_generated/logs/transcript.jsonl     child steps
//   brain/<parent>/.system_generated/messages/<id>.json       the child's
//     report (sender = child id) marks it finished

export const ANTIGRAVITY_SUBAGENT_TOOLS = new Set(['invoke_subagent', 'start_subagent']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const antigravityBrainDir = () => path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
const generated = (conversationId, ...parts) =>
  path.join(antigravityBrainDir(), conversationId, '.system_generated', ...parts);
const generatedParts = (conversationId, ...parts) => [conversationId, '.system_generated', ...parts];

const isSafeSegment = (segment) =>
  typeof segment === 'string' &&
  segment.length > 0 &&
  segment !== '.' &&
  segment !== '..' &&
  !segment.includes('/') &&
  !segment.includes('\\') &&
  !segment.includes('\0');

// Walks every managed component under `os.homedir()` with lstat + realpath so
// symlinks anywhere under `.gemini/antigravity-cli/brain` are rejected while
// allowing symlinked OS ancestors above `os.homedir()` (e.g. macOS `/var`).
const resolveSafeBrainPath = async (parts, expectedType) => {
  let realHome;
  try {
    realHome = await fs.realpath(os.homedir());
  } catch {
    return null;
  }
  const segments = ['.gemini', 'antigravity-cli', 'brain', ...parts];
  let current = realHome;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!isSafeSegment(segment)) return null;
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return null;
    const isLeaf = index === segments.length - 1;
    if (isLeaf) {
      if (expectedType === 'file' && !stat.isFile()) return null;
      if (expectedType === 'dir' && !stat.isDirectory()) return null;
    } else if (!stat.isDirectory()) {
      return null;
    }
  }
  try {
    const realTarget = await fs.realpath(current);
    return realTarget === current ? realTarget : null;
  } catch {
    return null;
  }
};

const readJson = async (parts) => {
  const safePath = await resolveSafeBrainPath(parts, 'file');
  if (!safePath) return null;
  try {
    return JSON.parse(await fs.readFile(safePath, 'utf8'));
  } catch {
    return null;
  }
};

const listJson = async (parts) => {
  const safeDir = await resolveSafeBrainPath(parts, 'dir');
  if (!safeDir) return [];
  try {
    return (await fs.readdir(safeDir)).filter((name) => name.endsWith('.json') && name !== 'read.json');
  } catch {
    return [];
  }
};

/** The child conversation id a launch tool call started, or null while it isn't on disk yet. */
export const resolveAntigravityChild = async (parentSessionId, toolCallId) => {
  if (!UUID.test(String(parentSessionId)) || !toolCallId) return null;
  for (const name of await listJson(generatedParts(parentSessionId, 'subagents'))) {
    const childId = name.slice(0, -'.json'.length);
    if (!UUID.test(childId)) continue;
    for (const messageName of await listJson(generatedParts(childId, 'messages'))) {
      const message = await readJson(generatedParts(childId, 'messages', messageName));
      const call = message?.sourceMetadata?.tool?.toolCall;
      if (message?.sender === parentSessionId && call?.id === toolCallId) return childId;
    }
  }
  return null;
};

export const antigravityChildTranscriptPath = (childId) =>
  UUID.test(String(childId)) ? generated(childId, 'logs', 'transcript.jsonl') : null;

/** The child's report to the parent (its send_message), or null while it works. */
export const antigravityChildReport = async (parentSessionId, childId) => {
  if (!UUID.test(String(parentSessionId)) || !UUID.test(String(childId))) return null;
  for (const name of await listJson(generatedParts(parentSessionId, 'messages'))) {
    const message = await readJson(generatedParts(parentSessionId, 'messages', name));
    if (message?.sender === childId) return typeof message.content === 'string' ? message.content : '';
  }
  return null;
};

// The last complete step of a conversation's transcript.jsonl, or null.
const lastTranscriptStep = async (conversationId) => {
  const safePath = await resolveSafeBrainPath(generatedParts(conversationId, 'logs', 'transcript.jsonl'), 'file');
  if (!safePath) return null;
  let handle;
  try {
    handle = await fs.open(safePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const { size } = stat;
    // Steps are usually a few KB; a large tool output can make one longer.
    for (const window of [65536, 4 * 1024 * 1024]) {
      const length = Math.min(size, window);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const text = buffer.toString('utf8').trimEnd();
      const start = text.lastIndexOf('\n');
      if (start === -1 && length < size) continue;
      return JSON.parse(text.slice(start + 1));
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
};

const isWakingInboxMessage = (message) => {
  if (!message || typeof message !== 'object') return false;
  if (message.priority === 'MESSAGE_PRIORITY_LOW') return false;
  if (message.priority === undefined || message.priority === null || message.priority === '') return true;
  return message.priority === 'MESSAGE_PRIORITY_HIGH';
};

/**
 * agy is working on the conversation by itself, outside any prompt: it was
 * woken (a child's report, or a background command's "task finished" notice,
 * sits unread in its inbox, or its transcript ends on the delivered system
 * message) or it is between the steps of that reply (the transcript ends on a
 * tool call or its result, so another model step follows). The model can
 * think for a while before its first chunk streams. T3 Code's
 * readAntigravityPendingReply makes the inbox and system-message checks.
 */
export const antigravityPendingReply = async (parentSessionId) => {
  if (!UUID.test(String(parentSessionId))) return false;
  const read = (await readJson(generatedParts(parentSessionId, 'messages', 'read.json'))) ?? {};
  for (const name of await listJson(generatedParts(parentSessionId, 'messages'))) {
    const stem = name.slice(0, -'.json'.length);
    const message = await readJson(generatedParts(parentSessionId, 'messages', name));
    if (!message || typeof message !== 'object') continue;
    const messageId = typeof message.id === 'string' && message.id ? message.id : null;
    if (message.sender === parentSessionId) continue;
    if (read[stem] === true || (messageId && read[messageId] === true)) continue;
    if (isWakingInboxMessage(message)) return true;
  }
  const last = await lastTranscriptStep(parentSessionId);
  if (last?.type === 'SYSTEM_MESSAGE') {
    return !(typeof last.content === 'string' && last.content.includes('priority=MESSAGE_PRIORITY_LOW'));
  }
  if (last?.type === 'GENERIC') return true;
  return last?.type === 'PLANNER_RESPONSE' && Array.isArray(last.tool_calls) && last.tool_calls.length > 0;
};

/** `ALIVE`, `KILLED`, … from the parent's child list; null when unknown. */
export const antigravityChildState = async (parentSessionId, childId) => {
  if (!UUID.test(String(parentSessionId)) || !UUID.test(String(childId))) return null;
  const entry = await readJson(generatedParts(parentSessionId, 'subagents', `${childId}.json`));
  return typeof entry?.state === 'string' ? entry.state.replace(/^SUBAGENT_STATE_/, '') : null;
};

// Tool arguments in transcript.jsonl are JSON text per value ("\"ls -la\"").
const decodeArgs = (args) =>
  Object.fromEntries(
    Object.entries(args && typeof args === 'object' ? args : {}).map(([key, value]) => {
      if (typeof value !== 'string') return [key, value];
      try {
        return [key, JSON.parse(value)];
      } catch {
        return [key, value];
      }
    })
  );

const argText = (args, names) => {
  for (const [key, value] of Object.entries(args)) {
    if (names.includes(key.toLowerCase()) && typeof value === 'string' && value) return value;
  }
  return '';
};

/**
 * subagent-trackers line handler for a child's transcript.jsonl: model text,
 * tool calls as steps (resolved by the GENERIC result step that follows), and
 * the launch prompt as metadata.
 */
export const handleAntigravitySubagentLine = (value, api, ctx) => {
  if (!value || typeof value !== 'object') return;
  ctx.openTools ??= [];
  if (value.type === 'SYSTEM_MESSAGE') {
    // Step 0 carries the launch message; later ones are inbox deliveries.
    if (value.step_index === 0 && typeof value.content === 'string') {
      const match = /content=([\s\S]*?)\n<\/SYSTEM_MESSAGE>/.exec(value.content);
      if (match?.[1]) api.prompt(match[1].trim());
    }
    return;
  }
  if (value.type === 'PLANNER_RESPONSE') {
    if (typeof value.content === 'string' && value.content.trim()) {
      api.text(ctx.textSeen ? `\n\n${value.content}` : value.content);
      ctx.textSeen = true;
    }
    const stats = {};
    if (Number.isFinite(value.input_tokens)) stats.inputTokens = (ctx.inputTokens = (ctx.inputTokens ?? 0) + value.input_tokens);
    if (Number.isFinite(value.output_tokens)) stats.outputTokens = (ctx.outputTokens = (ctx.outputTokens ?? 0) + value.output_tokens);
    if (Number.isFinite(value.cache_read_tokens)) stats.cachedReadTokens = (ctx.cachedReadTokens = (ctx.cachedReadTokens ?? 0) + value.cache_read_tokens);
    if (Object.keys(stats).length) api.stats(stats);
    if (typeof value.model === 'string' && value.model) api.metadata({ model: value.model });
    (Array.isArray(value.tool_calls) ? value.tool_calls : []).forEach((call, index) => {
      const name = typeof call?.name === 'string' ? call.name : 'tool';
      const args = decodeArgs(call?.args);
      // The child's report to the parent is its answer: show it as its text.
      if (name === 'send_message' && typeof args.Message === 'string' && args.Message.trim()) {
        api.text(ctx.textSeen ? `\n\n${args.Message}` : args.Message);
        ctx.textSeen = true;
      }
      const command = argText(args, ['commandline', 'command']);
      const target = argText(args, ['path', 'absolutepath', 'targetfile', 'file_path', 'query', 'url']);
      const summary = command || target || argText(args, ['toolsummary', 'message']);
      const key = `step-${value.step_index}-${index}`;
      ctx.openTools.push(key);
      api.activity({
        key,
        type: command ? 'command' : 'tool',
        ...(command ? { kind: 'execute' } : {}),
        title: summary ? `${antigravityToolLabel(name)} - ${stringifySummary(summary, 80)}` : antigravityToolLabel(name),
        ...(command ? { detail: command } : target ? { detail: target } : {}),
        input: formatToolInput(args),
        status: 'running',
      });
    });
    return;
  }
  if (value.type === 'GENERIC') {
    // The result of the oldest open tool call.
    const key = ctx.openTools.shift();
    if (!key) return;
    const failed = value.status && value.status !== 'DONE';
    api.activity({
      updateForKey: key,
      type: failed ? 'error' : 'result',
      status: failed ? 'error' : 'done',
      ...(typeof value.content === 'string' && value.content ? { output: value.content } : {}),
    });
  }
};
