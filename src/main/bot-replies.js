import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DurangoError } from './durango-client.js';
import { answeredRequestSummary } from './durango-dispatch.js';
import { selectFinalMessage } from '../report-clip.js';
import { claudePermissionOptionsForAccessMode, fullAccessApproves, withClaudeEnv } from './claude-env.js';
import { zodShapeForInputSchema } from './json-schema-zod.js';
import { recordClaudeRateLimit } from './usage-limits.js';
import { BOT_THREAD_ACCESS_MODES, SHIP_VIA_THREAD_MESSAGE, resolveThreadModelChoice } from './bot-thread-tools.js';

// What a thread action from Durango (the claim's threadActions / legacy
// settleThreads) can't ever do here: acknowledged at once. Anything else (no
// window, a save that failed) is tried again on later polls, up to
// THREAD_ACTION_ATTEMPTS times. (`a bot started|can only settle` stays for
// backwards compatibility with older desktop error messages.)
const THREAD_ACTION_FINAL_ERROR =
  /^No thread |matches several threads|matches several models|a bot started|can only settle|running a turn|still running|no running turn|title is required|requires at least one of|has no model|takes effort|has no effort setting|isn't available on|cannot be selected remotely|could not be branched|branching a thread that runs on|unsupported (?:thread action|access[_ ]mode|codex_service_tier|claude_context_window)|runs on another machine|not found on this machine|not available here|no pending (?:request|"Needs you")|secret request|waits on \d+ requests|unsupported answer|needs `reply`|no longer waiting/i;
const THREAD_ACTION_ATTEMPTS = 5;

// A Durango bot's manage_thread on a machine: as on Durango, it can name the
// machine that has the thread (used when it isn't this one).
const withRunOn = (definition) =>
  definition?.name === 'manage_thread' || definition?.name === 'settle_thread'
    ? {
        ...definition,
        inputSchema: {
          ...definition.inputSchema,
          properties: {
            ...definition.inputSchema.properties,
            run_on: { type: 'string', maxLength: 80, description: 'The machine that has it (list_machines), when it is not this one and you know it.' },
          },
        },
      }
    : definition;

// Ensure delegate_task exposes the full desktop thread controls (model/effort/
// access_mode/tier/context window) when running on this machine, even if the
// server's cloud-oriented schema omits desktop-only options.
const enrichDelegateTaskTool = (definition) => {
  if (definition?.name !== 'delegate_task' || !definition?.inputSchema?.properties) return definition;
  const props = definition.inputSchema.properties;
  return {
    ...definition,
    inputSchema: {
      ...definition.inputSchema,
      properties: {
        ...props,
        ...(props.effort
          ? {}
          : {
              effort: {
                type: 'string',
                maxLength: 40,
                description:
                  'Reasoning effort level for a Durango Code thread (from list_thread_models, e.g. "low", "medium", "high", "xhigh", "max").',
              },
            }),
        access_mode: {
          type: 'string',
          enum: BOT_THREAD_ACCESS_MODES,
          description: 'Access mode for a Durango Code thread on this computer ("read-only", "workspace-write", or "full-access"; default "full-access").',
        },
        codex_service_tier: {
          type: 'string',
          enum: ['default', 'priority'],
          description: 'Codex service tier when starting a Codex thread on this computer.',
        },
        claude_context_window: {
          type: 'string',
          enum: ['200k', '1m'],
          description: 'Claude context window when starting a Claude thread on this computer.',
        },
      },
    },
  };
};
import { ATTACH_FILES_TOOL, BOT_REPORT_GUIDE, createReplyFiles, finishReplyFiles, messageMediaOf } from './bot-reply-extras.js';
import {
  BOT_SESSION_COLD_MS,
  BOT_SESSION_MAX_TOKENS,
  BOT_SESSION_RESET_TOKENS,
  contextTokensOf,
  createBotSessionStore,
  cutMiddle,
  estimateTextTokens,
  maxPromptTokensFromEnv,
  normalizeLaneSession,
  planBotPrompt,
  replyUsageOf,
  sessionBasis,
  splitMemorySection,
} from './bot-sessions.js';

export { createBotSessionStore };

// Bot replies: a Durango bot's reply, run here on the person's own Claude Code.
//
// Durango bots are always-on assistants with a chat thread on Durango. While
// the person is signed in, Claude Code is available here and "Answer your
// bots on this computer" is on (Settings → Durango; on by default, separate
// from the dispatch opt-in), this worker long-polls `POST /api/v1/code/bots/claim`
// (polling is this machine's bot presence on Durango: its name, projects and
// Claude models). Messages the person sends from here run here first.
// A claimed reply ("lane") runs through the Claude Agent SDK with the bot's
// prompt appended to Claude Code's system prompt and the bot's tools served
// from an in-process MCP server whose handlers call Durango. Progress (the
// reply so far, the tool running) streams back; messages that reach the bot
// meanwhile come back as its inbox and are handed to the running session
// without interrupting it. The final text goes to `…/finish`. When Claude Code
// can't run the reply here (usage limit, signed out of Claude, no runtime),
// the finish asks Durango to run it elsewhere.
//
// Access: a bot reply runs with the access set for bots (Settings → Durango,
// Workspace write by default), mapped to Claude Code exactly as agent threads
// map it. No one is at the machine to approve anything, so outside Full access
// tools that would ask are declined (the bot's own tools are always allowed).

export const BOT_REPLIES_CAPABILITY = 'bot-replies';
// Bots always work with Full access: nobody is there to approve their
// commands, and their threads run on their own (the person's decision,
// 2026-11-19). A saved older choice (Workspace write) no longer applies.
export const BOT_DEFAULT_ACCESS_MODE = 'full-access';

/** Settings → Durango for bots: `{ enabled }` (on unless turned off); `accessMode` is always Full access. */
export const normalizeBotSettings = (raw) => {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: value.enabled !== false,
    accessMode: BOT_DEFAULT_ACCESS_MODE,
  };
};
/** Claim feature: this machine keeps a Claude Code session per bot (bot-sessions.js). */
export const BOT_SESSIONS_FEATURE = 'bot-sessions';
// Claim feature: replies go out as messages (the job's `messages`): text a
// reply writes before a tool call is sent as its own message when the call
// starts, and the text after its last tool call is its final answer.
export const BOT_REPLY_MESSAGES_FEATURE = 'reply-messages';
/** Claim feature: this machine drains queued threadActions and runs manage_thread locally. */
export const BOT_THREAD_ACTIONS_FEATURE = 'thread-actions';
/** Claim feature: this machine supports manage_thread action "configure" (model/effort/access). */
export const BOT_THREAD_CONFIGURE_FEATURE = 'thread-configure';
/** Claim feature: this machine answers threads' "Needs you" requests (queued answer_thread_request). */
export const BOT_THREAD_REQUESTS_FEATURE = 'thread-requests';
// A reply's messages before its final answer, at most (Durango's
// BOT_REPLY_MESSAGES_MAX): past it, the text goes into the final answer.
export const BOT_REPLY_MESSAGES_MAX = 30;
/** The id of a reply's `index`-th message before its final answer (Durango's botReplyMessageId). */
export const botReplyMessageId = (replyMessageId, index) => `${replyMessageId}_m${String(index).padStart(2, '0')}`;
export const BOT_MAX_LANES = 3;
export const BOT_MCP_SERVER = 'durango_bot';
export const BOT_PROGRESS_THROTTLE_MS = 1_000;
export const BOT_CLAIM_WAIT_MS = 25_000;
export const BOT_INBOX_HEADER =
  "(Bot inbox: arrived while you were working. Take it into what you're doing and answer it in this reply too.)";
export const BOT_FINAL_INBOX_HEADER =
  "(Bot inbox: arrived before your final answer was posted. Your draft above wasn't sent — take this into account and write a single final answer covering everything that needs an answer.)";
// Maximum extra rounds a reply takes when new person messages arrive right
// before its final answer is posted (Durango's BOT_FINAL_INBOX_MAX_ROUNDS).
export const BOT_FINAL_INBOX_MAX_ROUNDS = 2;
export const BOT_FAILURE_MAX_CHARS = 500;
const MAX_BACKOFF_MS = 60_000;
const OFFLINE_RECHECK_MS = 15_000;
const UNAVAILABLE_RECHECK_MS = 60_000;
const REPORT_RETRY_DELAYS_MS = [1_000, 4_000, 10_000];

const BOT_TOOL_PREFIX = `mcp__${BOT_MCP_SERVER}__`;

const formatBotInboxItems = (items) =>
  items.map((item) =>
    item.source === 'person' ? item.content : `[${item.label || item.source}]\n${item.content}`
  );

/** One inbox batch as the user message the running session reads. */
export const formatBotInbox = (items) => [BOT_INBOX_HEADER, ...formatBotInboxItems(items)].join('\n\n');

/**
 * One inbox batch claimed right before posting the final answer: when
 * `replacedDraft` is true, the unposted draft text was discarded so the model
 * writes one cohesive final answer covering everything.
 */
export const formatBotFinalInbox = (items, { replacedDraft = false } = {}) =>
  replacedDraft ? [BOT_FINAL_INBOX_HEADER, ...formatBotInboxItems(items)].join('\n\n') : formatBotInbox(items);

const CLAUDE_BOT_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** A bot lane's reasoning effort mapped to Claude Code's CLI/SDK `effort` option, or null. */
export const claudeEffortForBot = (value) => {
  const clean = String(value ?? '').trim().toLowerCase();
  if (!clean) return null;
  if (clean === 'none') return 'low';
  return CLAUDE_BOT_EFFORTS.has(clean) ? clean : null;
};

/** "claude-opus-5-5" (or "claude-opus-5-5[1m]", "claude-haiku-5-5-20261001") → "anthropic/claude-opus-5.5". */
export const durangoModelIdForClaude = (model) => {
  const match = String(model ?? '')
    .trim()
    .replace(/\[1m\]$/i, '')
    .replace(/-\d{8}$/, '')
    .match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/);
  if (!match) return null;
  return `anthropic/claude-${match[1]}-${match[2]}${match[3] ? `.${match[3]}` : ''}`;
};

// Assistant-message errors that mean "this machine's Claude Code can't run it
// now", not "this reply went wrong": another machine or the cloud can.
const RETRY_ELSEWHERE_ASSISTANT_ERRORS = new Set([
  'rate_limit',
  'billing_error',
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'model_not_found',
]);
const RETRY_ELSEWHERE_TEXT =
  /usage limit|rate[ _-]?limit|limit reached|out of (?:extra )?usage|credit balance|not logged in|\/login|log ?in again|invalid api key|oauth|authenticat|unauthori[sz]ed|ENOENT|EACCES|spawn|native binary|executable not found|cannot find module/i;

/** The model refused the prompt for its size. */
const PROMPT_TOO_LONG = /prompt is too long|too many (?:input )?tokens|context (?:length|window)|maximum context/i;

/** Error text that reads as a usage limit, a signed-out Claude Code or a missing runtime. */
export const isRetryElsewhereError = (text) => RETRY_ELSEWHERE_TEXT.test(String(text ?? ''));

const shorten = (value, max = BOT_FAILURE_MAX_CHARS) => {
  const text = String(value ?? '').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
};

/** Short label of a tool for `activeTool` ("mcp__durango_bot__web_search" → "web_search"). */
export const botToolLabel = (toolName) => {
  const name = String(toolName ?? '');
  const mcp = name.match(/^mcp__[^_]+(?:_[^_]+)*?__(.+)$/);
  return shorten(mcp ? mcp[1] : name, 80) || null;
};

const BOT_PROJECTS_MAX = 40;

const ACCESS_NOTES = {
  'read-only': 'Read only: you can read them, not change them',
  'workspace-write': 'Workspace write: you can read and edit files in them',
  'full-access': 'Full access',
};

/**
 * The machine's Durango Code projects a reply may use (absolute paths, at most
 * BOT_PROJECTS_MAX), deduplicated by path.
 */
export const botProjectsForLane = (projects) => {
  const seen = new Set();
  const out = [];
  for (const project of Array.isArray(projects) ? projects : []) {
    const name = typeof project?.name === 'string' ? project.name.trim() : '';
    const dir = typeof project?.path === 'string' ? project.path : '';
    if (!name || !dir || !path.isAbsolute(dir) || seen.has(dir)) continue;
    seen.add(dir);
    out.push({ name, path: dir });
    if (out.length >= BOT_PROJECTS_MAX) break;
  }
  return out;
};

/**
 * What a reply running here is told about this machine's Durango Code
 * projects: their folders (readable, and writable as far as the machine's
 * access allows) and how to start real Durango Code threads in them.
 * `threads`: 'local' (signed out) or 'machine' (a Durango bot's reply), both
 * starting threads with delegate_task `project`; null for a task (no hand-off).
 */
export const botProjectsNote = ({ projects, accessMode, threads }) => {
  const list = botProjectsForLane(projects);
  if (!list.length) {
    return threads
      ? "## This computer's Durango Code projects\n\nNone are open in Durango Code on this computer (or none are allowed for Durango). If the person wants work done in a project, ask them to add it in Durango Code."
      : '';
  }
  const lines = [
    "## This computer's Durango Code projects",
    '',
    ...list.map((project) => `- ${project.name}: ${project.path}`),
    '',
    `You can work in these folders directly (this computer's access for Durango: ${ACCESS_NOTES[accessMode] ?? ACCESS_NOTES['read-only']}). Quick looks (a file, git log, a grep) you do yourself.`,
  ];
  if (threads) {
    lines.push(
      'For real work in a project (code changes, builds, tests, investigations, anything longer than a few steps), start a Durango Code thread there with delegate_task and `project` set to the project name: it starts on this computer. You can pick any available model (`model`), reasoning effort (`effort`), and `access_mode` — call list_thread_models to see the exact model ids and supported effort levels on this computer. It is an ordinary Durango Code thread: every tool a thread has, the person can watch and continue it in the app, and its result comes back to your inbox. It sees nothing of this conversation, but reads the project itself (its code, AGENTS.md, the project\'s notes with project_notes). See where a project stands with list_threads and read_thread (the person\'s threads too), steer or follow up in a thread with message_thread (switching `model`/`effort` if needed, or `steer: true` to steer a running turn), and manage any thread (bot-started or the person\'s own) with manage_thread: settle (archive), unsettle (restore), snooze, unsnooze (wake), pin, unpin, rename, configure (change model/effort/access_mode), branch (fork a copy), stop, or delete when explicitly asked.',
      `To ship a change (land, deploy, merge, release), message the thread that made it (message_thread; its id is in the task report) with something like "${SHIP_VIA_THREAD_MESSAGE}": it knows how its project ships. A thread on another of the person's machines: delegate_task with \`thread_id\` (and no \`project\`). Land or deploy yourself only when the person explicitly tells you to.`
    );
  }
  return lines.join('\n');
};

/** A project by name (or folder name), case-insensitive. */
export const findProject = (projects, name) => {
  const wanted = String(name ?? '').trim().toLowerCase();
  if (!wanted) return null;
  const list = (Array.isArray(projects) ? projects : []).filter((project) => project && typeof project.id === 'string');
  return (
    list.find((project) => String(project.name ?? '').trim().toLowerCase() === wanted) ??
    list.find((project) => path.basename(String(project.path ?? '')).toLowerCase() === wanted) ??
    null
  );
};

/** What the claim tells Durango about this machine (bots.botMachines). */
export const presenceOf = (info) => ({
  name: String(info?.name ?? '').trim().slice(0, 120) || os.hostname(),
  projects: botProjectsForLane(info?.projects).map((project) => project.name),
  // Ids and repo ids: Durango names a project's key from them (e.g. for the
  // main bot creating a project's bot).
  projectRefs: (Array.isArray(info?.projects) ? info.projects : [])
    .filter((project) => typeof project?.id === 'string' && typeof project?.name === 'string')
    .slice(0, 100)
    .map((project) => ({ name: project.name, id: project.id, repoId: typeof project.repoId === 'string' && project.repoId ? project.repoId : null })),
  models: (Array.isArray(info?.models) ? info.models : []).filter((model) => typeof model === 'string' && model).slice(0, 20),
});

/** The bot's working directory: `<botsDir>/<botId>`, the id made path-safe. */
// --- attachments ---------------------------------------------------------------
/** Files a reply saves for Claude Code: at most this many, each at most this big. */
const LANE_ATTACHMENTS_MAX = 10;
const LANE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

const safeFileName = (name) =>
  String(name ?? 'file')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 120) || 'file';

const defaultDownload = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > LANE_ATTACHMENT_MAX_BYTES) throw new Error('over 25 MB');
  return bytes;
};

/**
 * Saves a reply's attachments in its work folder (`attachments/`, inside its
 * cwd, so Claude Code can read them in any access mode): from a local copy on
 * this computer (`item.path` or `resolveLocalPath(item)`), else from Durango's
 * download links. → a note for the prompt naming each file and where it is, or
 * '' when there are none.
 */
export const saveLaneAttachments = async (
  attachments,
  dir,
  { download = defaultDownload, copyFile = (from, to) => fs.copyFile(from, to), resolveLocalPath = null } = {}
) => {
  const list = (Array.isArray(attachments) ? attachments : []).slice(-LANE_ATTACHMENTS_MAX);
  if (!list.length) return '';
  await fs.mkdir(dir, { recursive: true });
  const lines = [];
  for (const item of list) {
    const name = safeFileName(item?.name);
    const tag = String(item?.id ?? item?.pendingId ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
    const target = path.join(dir, tag ? `${tag}-${name}` : name);
    try {
      const existing = await fs.stat(target).catch(() => null);
      if (!existing?.isFile()) {
        const localPath =
          (typeof item?.path === 'string' && item.path ? item.path : null) ??
          (typeof resolveLocalPath === 'function' ? resolveLocalPath(item) : null);
        if (localPath) await copyFile(localPath, target);
        else if (typeof item?.url === 'string' && /^https:\/\//.test(item.url)) await fs.writeFile(target, await download(item.url));
        else continue;
      }
      lines.push(`- ${item?.name ?? name}: ${target}`);
    } catch (error) {
      lines.push(`- ${item?.name ?? name}: couldn't be saved here (${error?.message ?? error})`);
    }
  }
  return lines.length
    ? `<attachments>\nFiles attached in this conversation, saved on this computer (read them with your tools):\n${lines.join('\n')}\n</attachments>`
    : '';
};

export const botWorkDir = (botsDir, botId) => {
  const id = String(botId ?? '');
  const safe = /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : crypto.createHash('sha256').update(id).digest('hex').slice(0, 32);
  return path.join(botsDir, safe);
};

const userMessage = (text) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
});

const toolDenial = (toolName, accessMode) => {
  if (toolName === 'AskUserQuestion') {
    return 'No one can answer questions during a bot reply. Ask in your reply instead.';
  }
  if (toolName === 'ExitPlanMode') {
    return 'This bot reply runs Read only on this machine: answer without changing anything here.';
  }
  if (accessMode === 'full-access') {
    // Full access approves Claude Code's own safety-check asks; this one came
    // from the person's ask rules or a hook on this machine.
    return `This machine's settings (an ask rule or a hook) require a person to approve this ${toolName} call, and no one is at this machine during a bot reply. Do without it, or say in your reply what you would need.`;
  }
  return `No one is at this machine to approve ${toolName} for this bot reply (it runs with the machine's ${accessMode} access). Do without it, or say in your reply what you would need.`;
};

const str = (value) => (typeof value === 'string' ? value : '');

const defaultClaudeEnv = () => withClaudeEnv({ ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' });

/**
 * A bot reply's Claude Code environment: the hour-long prompt cache (Claude
 * Code's default on a Claude subscription; an API key's default is 5
 * minutes), since a bot's conversation is picked up again after the person's
 * pauses. The person's own setting wins.
 */
export const botClaudeEnv = (baseEnv) =>
  str(baseEnv?.CLAUDE_CODE_PROMPT_CACHE_TTL).trim() ? baseEnv : { ...baseEnv, CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' };

const truthyEnv = (value) => /^(1|true|yes|on)$/i.test(str(value).trim());

/** How long a kept session's prompt cache lasts with that environment, less a margin (bot-sessions.js `cold`). */
export const botCacheColdMs = (baseEnv) => {
  const resolved = botClaudeEnv(baseEnv ?? {});
  if (truthyEnv(resolved.FORCE_PROMPT_CACHING_5M)) return 4.5 * 60_000;
  return str(resolved.CLAUDE_CODE_PROMPT_CACHE_TTL).trim().toLowerCase() === '1h' ? BOT_SESSION_COLD_MS : 4.5 * 60_000;
};

/**
 * One prompt, one answer, no tools (a local bot's history summary). deps:
 * loadSdk, resolveBinary and env as createClaudeLaneRunner's; cwd (or a
 * function returning it). → ({ model, systemPrompt, prompt, signal }) => text.
 * Throws when Claude Code ends without an answer.
 */
export const createClaudeOneShot = ({
  loadSdk,
  resolveBinary = async () => null,
  env = defaultClaudeEnv,
  cwd = () => os.tmpdir(),
}) => async ({ model, systemPrompt, prompt, signal }) => {
  const [sdk, binary] = await Promise.all([loadSdk(), resolveBinary()]);
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let query = null;
  let text = '';
  let failure = null;
  try {
    query = sdk.query({
      prompt,
      options: {
        cwd: typeof cwd === 'function' ? cwd() : cwd,
        ...(model ? { model } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        tools: [],
        maxTurns: 1,
        persistSession: false,
        settingSources: [],
        ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
        abortController,
        env: env(),
      },
    });
    for await (const message of query) {
      if (message?.type !== 'result') continue;
      if (message.subtype === 'success' && !message.is_error && typeof message.result === 'string') text = message.result;
      else failure = (Array.isArray(message.errors) && message.errors.filter(Boolean).join('; ')) || `Claude Code stopped (${message.subtype}).`;
      break;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      query?.close?.();
    } catch {}
    try {
      abortController.abort();
    } catch {}
  }
  if (!text.trim()) throw new Error(failure || 'Claude Code gave no answer.');
  return text.trim();
};

/**
 * Runs lanes on the Claude Agent SDK. deps:
 * - loadSdk(): the SDK module ({ query, tool, createSdkMcpServer })
 * - loadZod(): the zod module ({ z })
 * - resolveBinary(): Claude Code executable path or null (the SDK's own)
 * - createInputQueue(): streaming-input queue ({ push, close, stream })
 * - botsDir: parent of the per-bot working directories (or a function returning it)
 * - env(): the claude process environment
 * - getProjects(): this machine's Durango Code projects the reply may use
 *   ([{ name, path }], already limited to the ones allowed for Durango)
 * - sessions: createBotSessionStore(...) (bot-sessions.js): each bot's kept
 *   Claude Code session, resumed by its next reply (null: a fresh session every reply)
 * - maxPromptTokens / sessionResetTokens / sessionMaxTokens: the prompt and session size limits (bot-sessions.js)
 * - sessionColdMs: a kept session unused this long starts over (default: from the prompt cache's TTL)
 * - log(...): one line per reply with its token usage
 *
 * lane.threads: how the reply starts Durango Code threads in a project
 * ('machine' | 'local'; absent for tasks), see botProjectsNote.
 * lane.session: the conversation, structured (normalizeLaneSession); without
 * it, lane.prompt is sent as is (in a fresh session, cut to the size limit).
 *
 * → (lane, ctx) => { text, sent, modelId, failure?, retryElsewhere?, aborted?, usage?, compact? }
 * ctx: { signal, accessMode, update({ text, activeTool }), takeInbox(): Promise<items>,
 *        callTool({ name, input, toolCallId, message }): Promise<{ result }>,
 *        sendMessage?({ index, text, modelId }): Promise<boolean> }
 * With `sendMessage`, the reply is the messages it sends: the text written
 * before a tool call goes out as message `index` (0, 1, …) when the call
 * starts, and `text` is the final answer (what it wrote after its last tool
 * call; `sent` messages came before it). `update` shows the message being
 * written now; `callTool`'s `message` is the index of the message the call
 * was made with (null: made before any text of its own, so it goes with the
 * next message). Without it (a task), `text` is everything the reply wrote.
 * `compact`: the bot's history should be compacted (its kept session grew too large, or
 * compaction fell behind).
 */
export const createClaudeLaneRunner = ({
  loadSdk,
  loadZod,
  resolveBinary = async () => null,
  createInputQueue,
  botsDir,
  env = defaultClaudeEnv,
  getProjects = () => [],
  mkdir = (dir) => fs.mkdir(dir, { recursive: true }),
  randomId = () => crypto.randomUUID(),
  downloadAttachment = defaultDownload,
  resolveLocalAttachment = null,
  sessions = null,
  maxPromptTokens = maxPromptTokensFromEnv(),
  sessionResetTokens = BOT_SESSION_RESET_TOKENS,
  sessionMaxTokens = BOT_SESSION_MAX_TOKENS,
  sessionColdMs = null,
  maxFinalInboxRounds = BOT_FINAL_INBOX_MAX_ROUNDS,
  log = (...args) => console.info('[bot replies]', ...args),
}) => async (lane, ctx) => {
  const accessMode = ctx.accessMode || 'read-only';
  let sdk;
  let zod;
  let binary;
  let cwd;
  let projects = [];
  try {
    projects = botProjectsForLane(await getProjects());
  } catch {}
  const projectsNote = botProjectsNote({
    projects,
    accessMode,
    threads: lane.threads === 'machine' || lane.threads === 'local' ? lane.threads : null,
  });
  try {
    [sdk, zod, binary] = await Promise.all([loadSdk(), loadZod(), resolveBinary()]);
    cwd = botWorkDir(typeof botsDir === 'function' ? botsDir() : botsDir, lane.botId);
    await mkdir(cwd);
  } catch (error) {
    return { text: '', retryElsewhere: true, failure: shorten(`Claude Code is not available here: ${error?.message ?? error}`) };
  }
  if (ctx.signal?.aborted) return { text: '', aborted: true };
  // Files attached in the conversation: saved next to the reply for Claude Code
  // (using any local staged copy on this computer before downloading).
  const attachmentsDir = path.join(cwd, 'attachments');
  const attachmentsNote = await saveLaneAttachments(lane.attachments, attachmentsDir, {
    download: downloadAttachment,
    resolveLocalPath: resolveLocalAttachment,
  }).catch(() => '');
  const z = zod?.z ?? zod;
  const systemAppend = projectsNote ? `${lane.systemPrompt}\n\n${projectsNote}` : lane.systemPrompt;

  // --- the bot's tools ---------------------------------------------------------------
  const toolUseIds = new Map(); // tool name -> tool_use ids waiting for their handler
  const botTools = lane.tools.map((definition) =>
    sdk.tool(
      definition.name,
      definition.description || definition.name,
      zodShapeForInputSchema(z, definition.inputSchema),
      async (args) => {
        const toolCallId = toolUseIds.get(definition.name)?.shift() || randomId();
        try {
          // The message this call was made with is sent (and known) first.
          const message = await messageOfCall(toolCallId);
          const { result } = await ctx.callTool({ name: definition.name, input: args ?? {}, toolCallId, message });
          return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? null) }] };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `The ${definition.name} tool failed: ${error?.message ?? error}` }],
            isError: true,
          };
        }
      },
      { alwaysLoad: true }
    )
  );
  // Files from this computer the reply shows (attach_files, and what its text
  // points at): the caller uploads or copies them when the reply finishes.
  // A background task's lane (`replyFiles: false`) writes a report, not a reply: it names paths instead.
  const replyFiles = createReplyFiles();
  const attaches = lane.replyFiles !== false;
  if (attaches && !lane.tools.some((definition) => definition.name === ATTACH_FILES_TOOL.name)) {
    botTools.push(
      sdk.tool(
        ATTACH_FILES_TOOL.name,
        ATTACH_FILES_TOOL.description,
        zodShapeForInputSchema(z, ATTACH_FILES_TOOL.inputSchema),
        async (args) => {
          const lines = await replyFiles.add(Array.isArray(args?.paths) ? args.paths : []);
          return { content: [{ type: 'text', text: lines.join('\n') || 'Nothing to attach.' }] };
        },
        { alwaysLoad: true }
      )
    );
  }
  const mcpServers = botTools.length
    ? { [BOT_MCP_SERVER]: sdk.createSdkMcpServer({ name: BOT_MCP_SERVER, version: '1.0.0', tools: botTools }) }
    : {};
  const recordToolUse = async (input) => {
    const name = String(input?.tool_name ?? '');
    if (name.startsWith(BOT_TOOL_PREFIX) && input?.tool_use_id) {
      const short = name.slice(BOT_TOOL_PREFIX.length);
      toolUseIds.set(short, [...(toolUseIds.get(short) ?? []), input.tool_use_id]);
    }
    return { continue: true };
  };

  // --- the prompt: a kept session's next message, or a fresh session's whole conversation --
  const session = normalizeLaneSession(lane.session);
  const keptSessions = session && sessions ? sessions : null;
  // One kept session per bot and model: replies to the person (the bot's
  // model) and routine runs (its cheap routine model) don't reset each other.
  const sessionKey = lane.model ? `${lane.botId}__${String(lane.model).replace(/[^A-Za-z0-9_-]/g, '_')}` : lane.botId;
  // Its basis leaves out the bot's summary: a kept session goes on with the
  // instructions it started with (the summary it had then) after compaction.
  const { steady: steadyPrompt, memory } = splitMemorySection(lane.systemPrompt);
  const basis = sessionBasis({ systemPrompt: projectsNote ? `${steadyPrompt}\n\n${projectsNote}` : steadyPrompt, model: lane.model, tools: lane.tools });
  const coldAfterMs = sessionColdMs ?? botCacheColdMs(env());
  // Checked out from here until the reply ends (the `finally` below hands it
  // back); nothing that can throw runs before that `try` without handing it back.
  const claimed = keptSessions ? await keptSessions.begin(sessionKey) : { state: null, busy: false };
  const planFor = (state, budget = maxPromptTokens) =>
    session
      ? planBotPrompt({
          botName: lane.botName,
          session,
          state,
          basis,
          threadId: lane.threadId,
          // Without a store nothing is kept: a fresh, unkept session.
          busy: claimed.busy || !keptSessions,
          systemTokens: estimateTextTokens(systemAppend),
          maxPromptTokens: budget,
          sessionResetTokens,
          sessionMaxTokens,
          coldAfterMs,
          memory,
        })
      : {
          mode: 'fresh',
          keep: false,
          reason: 'legacy',
          // A prompt built by an older Durango: cut in the middle (its oldest messages) to the limit.
          prompt: cutMiddle(lane.prompt, Math.max(4_000, budget - estimateTextTokens(systemAppend))),
          compact: false,
        };
  let plan;
  try {
    plan = planFor(claimed.state);
  } catch (error) {
    if (keptSessions && !claimed.busy) await keptSessions.end(sessionKey, null).catch(() => {});
    throw error;
  }
  const withAttachments = (prompt) => (attachmentsNote ? `${prompt}\n\n${attachmentsNote}` : prompt);

  // --- the reply's messages and the tool running ---------------------------------------
  // With ctx.sendMessage the reply is the messages it sends, like texting: the
  // text of a step that calls a tool goes out as its own message when the
  // call starts (an acknowledgement, a progress update); what it writes after
  // its last tool call is its final answer. Nothing is joined or left out
  // afterwards. Without it (a task), everything it writes is one text.
  const sendsMessages = typeof ctx.sendMessage === 'function';
  const blocks = []; // finished text blocks of the message being written (main loop)
  let finalStart = 0; // blocks index where text after the last tool call begins
  const toolBoundaries = []; // blocks indices where tool calls happened (for finalMessageOnly)
  let partial = ''; // the text block streaming now
  const toolCalls = new Map(); // tool_use id -> tool name (main loop)
  let sentCount = 0; // messages sent before the final answer
  const unsent = []; // index -> text of a message that couldn't be sent: it goes out with the final answer
  let sending = Promise.resolve(); // every send and file lookup so far
  const fileLookups = []; // files the sent messages point at, being added
  let stepId = null; // the main-loop step streaming now (its assistant message id)
  let stepMessage = null; // the index of the message the step's text went out as
  const callMessages = new Map(); // tool_use id -> that index (null: no text of its own)
  const callWaiters = new Map(); // tool_use id -> resolve, for a handler that ran before the loop saw its call
  let modelOfReply = lane.model ?? null;
  const pendingText = () =>
    blocks
      .map((part) => String(part ?? '').trim())
      .filter(Boolean)
      .join('\n\n');
  // The message being written now (live): its finished blocks and the one streaming.
  const currentText = () => [pendingText(), partial.trim()].filter(Boolean).join('\n\n');
  // Sends the message written so far as one of its own → its index, or null (nothing to send).
  const sendPending = () => {
    if (!sendsMessages || sentCount >= BOT_REPLY_MESSAGES_MAX) return null;
    const text = pendingText();
    if (!text) return null;
    const index = sentCount;
    sentCount += 1;
    blocks.length = 0;
    finalStart = 0;
    toolBoundaries.length = 0;
    const modelId = durangoModelIdForClaude(modelOfReply);
    // Screenshots and files it names are attached (with its final answer, or
    // its last message); their local embeds leave the text.
    const media = attaches ? messageMediaOf(text) : { text, paths: [] };
    if (media.paths.length) fileLookups.push(replyFiles.add(media.paths, { quiet: true }).catch(() => []));
    // Handed over now, before the reply writes on: its place and the live text
    // move on to the next message only once this one is stored.
    let result;
    try {
      result = Promise.resolve(ctx.sendMessage({ index, text: media.text, ...(modelId ? { modelId } : {}) }));
    } catch {
      result = Promise.resolve(false);
    }
    const stored = result.then(
      (ok) => ok !== false,
      () => false
    );
    sending = Promise.all([
      sending,
      stored.then((ok) => {
        if (!ok) unsent[index] = text;
      }),
    ]);
    return index;
  };
  const noteToolCall = (id) => {
    if (!callMessages.has(id)) callMessages.set(id, stepMessage);
    callWaiters.get(id)?.();
    callWaiters.delete(id);
  };
  // The message a tool call was made with, once it was sent (the loop may not have seen the call yet).
  const messageOfCall = async (toolCallId) => {
    if (!sendsMessages) return null;
    if (!callMessages.has(toolCallId)) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
        callWaiters.set(toolCallId, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await sending;
    return callMessages.get(toolCallId) ?? null;
  };
  const activeTool = () => {
    const names = [...toolCalls.values()];
    return names.length ? botToolLabel(names[names.length - 1]) : null;
  };
  const update = () => ctx.update({ text: currentText(), activeTool: activeTool() });

  // --- inbox: taken between steps, read at the next tool result or turn end -------
  const pendingInbox = [];
  const deliveredSeqs = []; // inbox messages the session read
  const deliveredItems = []; // ...and the items themselves (handed back if the attempt is redone)
  let inboxRequest = null;
  let finalInboxRounds = 0;
  const enrichInboxItem = async (item) => {
    if (!resolveLocalAttachment || !Array.isArray(item?.attachments) || !item.attachments.length) return item;
    const localItems = item.attachments.filter((att) => Boolean(resolveLocalAttachment(att)));
    if (!localItems.length) return item;
    const note = await saveLaneAttachments(localItems, attachmentsDir, {
      download: downloadAttachment,
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
          if (Array.isArray(items) && items.length) {
            const enriched = await Promise.all(items.map(enrichInboxItem));
            pendingInbox.push(...enriched);
          }
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
  // Like a steer in an agent thread (claudeSteerHooks): the main loop reads
  // what arrived at its next tool result, without interrupting the step.
  const deliverAtToolResult = (hookEventName) => async (input) => {
    if (input?.agent_id) return { continue: true };
    const items = takePending();
    if (finalInboxRounds < maxFinalInboxRounds) void requestInbox();
    if (!items.length) return { continue: true };
    return { hookSpecificOutput: { hookEventName, additionalContext: formatBotInbox(items) } };
  };

  // --- the run -------------------------------------------------------------------------
  // One attempt: a resumed session that turns out missing or broken gets a
  // second, fresh one (before anything was written).
  const runAttempt = async (attemptPlan) => {
    const inputQueue = createInputQueue();
    const abortController = new AbortController();
    const attempt = {
      model: lane.model,
      // A resumed session goes on with the instructions it started with (its
      // cache); a fresh one gets the bot's current ones.
      systemAppend: attemptPlan.mode === 'resume' && typeof attemptPlan.systemAppend === 'string' ? attemptPlan.systemAppend : systemAppend,
      sawInit: false,
      sessionId: null,
      result: null,
      assistantError: null,
      rateLimited: false,
      thrown: null,
      stderrTail: '',
      contextTokens: 0,
      // A tool ran (anything with effects: a task started, a message sent, a
      // file attached): redoing the attempt would do it again.
      usedTools: false,
    };
    let lastAssistantId = null;
    let query = null;
    const onAbort = () => {
      inputQueue.close();
      try {
        abortController.abort();
      } catch {}
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    const baseEnv = env();
    const effort = claudeEffortForBot(lane.reasoningEffort);
    try {
      inputQueue.push(userMessage(withAttachments(attemptPlan.prompt)));
      query = sdk.query({
        prompt: inputQueue.stream(),
        options: {
          cwd,
          ...(lane.model ? { model: lane.model } : {}),
          ...(effort ? { effort } : {}),
          systemPrompt: { type: 'preset', preset: 'claude_code', append: attempt.systemAppend },
          settingSources: ['user', 'project', 'local'],
          includePartialMessages: true,
          ...(projects.length ? { additionalDirectories: projects.map((project) => project.path) } : {}),
          mcpServers,
          ...claudePermissionOptionsForAccessMode(accessMode),
          ...(accessMode !== 'full-access' && botTools.length
            ? { allowedTools: [...lane.tools.map((definition) => `${BOT_TOOL_PREFIX}${definition.name}`), ...(attaches ? [`${BOT_TOOL_PREFIX}${ATTACH_FILES_TOOL.name}`] : [])] }
            : {}),
          canUseTool: async (toolName, toolInput, toolOptions) =>
            toolName.startsWith(BOT_TOOL_PREFIX) || fullAccessApproves(accessMode, toolName, toolOptions)
              ? { behavior: 'allow', updatedInput: toolInput }
              : { behavior: 'deny', message: toolDenial(toolName, accessMode) },
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async (input) => {
                    attempt.usedTools = true;
                    return recordToolUse(input);
                  },
                ],
              },
            ],
            PostToolUse: [{ hooks: [deliverAtToolResult('PostToolUse')] }],
            PostToolUseFailure: [{ hooks: [deliverAtToolResult('PostToolUseFailure')] }],
          },
          // The kept session: resumed. A session that won't be kept isn't saved.
          ...(attemptPlan.mode === 'resume' ? { resume: attemptPlan.sessionId } : {}),
          ...(attemptPlan.keep ? {} : { persistSession: false }),
          ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
          abortController,
          stderr: (data) => {
            attempt.stderrTail = `${attempt.stderrTail}${data}`.slice(-2000);
          },
          env: botClaudeEnv(baseEnv),
        },
      });
      for await (const message of query) {
        if (ctx.signal?.aborted) break;
        const mainLoop = !message?.parent_tool_use_id;
        if (message?.type === 'system' && message.subtype === 'init') {
          attempt.sawInit = true;
          if (typeof message.model === 'string' && message.model) attempt.model = modelOfReply = message.model;
          if (typeof message.session_id === 'string' && message.session_id) attempt.sessionId = message.session_id;
          continue;
        }
        if (message?.type === 'rate_limit_event') {
          recordClaudeRateLimit(message);
          if (message.rate_limit_info?.status === 'rejected') attempt.rateLimited = true;
          continue;
        }
        if (message?.type === 'stream_event' && mainLoop) {
          const event = message.event;
          if (event?.type === 'content_block_start' && event.content_block?.type === 'text') partial = '';
          if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            partial += event.delta.text ?? '';
            update();
          }
          continue;
        }
        if (message?.type === 'assistant' && mainLoop) {
          if (message.error) attempt.assistantError = message.error;
          const synthetic = Boolean(message.error) || message.message?.model === '<synthetic>';
          const id = message.message?.id ?? null;
          if (!synthetic && id !== stepId) {
            stepId = id;
            stepMessage = null;
          }
          if (!synthetic && message.message?.usage) attempt.contextTokens = contextTokensOf(message.message.usage);
          for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
            if (block?.type === 'text' && !synthetic) {
              blocks.push(String(block.text ?? ''));
              partial = '';
            } else if (block?.type === 'tool_use' && block.id) {
              attempt.usedTools = true;
              if (!synthetic && id !== lastAssistantId) {
                lastAssistantId = id;
                // A tool step: take what arrived meanwhile, read at its next tool result.
                if (finalInboxRounds < maxFinalInboxRounds) void requestInbox();
              }
              toolCalls.set(block.id, block.name);
              // The step's text is a message of its own, sent as its first call starts.
              if (stepMessage === null) stepMessage = sendPending();
              finalStart = blocks.length;
              toolBoundaries.push(blocks.length);
              noteToolCall(block.id);
            }
          }
          if (synthetic) partial = '';
          update();
          continue;
        }
        if (message?.type === 'user' && mainLoop) {
          const content = message.message?.content;
          let changed = false;
          for (const block of Array.isArray(content) ? content : []) {
            if (block?.type === 'tool_result' && block.tool_use_id && toolCalls.delete(block.tool_use_id)) changed = true;
          }
          if (changed) update();
          continue;
        }
        if (message?.type === 'result') {
          attempt.result = message;
          if (typeof message.session_id === 'string' && message.session_id) attempt.sessionId = message.session_id;
          partial = '';
          toolCalls.clear();
          if (message.is_error || message.subtype !== 'success') break;
          // Before posting the final answer: check for unclaimed new messages
          // from the person (capped so a burst never loops forever).
          if (inboxRequest) await inboxRequest;
          if (finalInboxRounds < maxFinalInboxRounds && !ctx.signal?.aborted) {
            await requestInbox({ beforeFinish: true });
          }
          if (ctx.signal?.aborted) break;
          const items = takePending();
          if (!items.length) break;
          finalInboxRounds += 1;
          attempt.result = null;
          if (items.some((item) => item?.source === 'person')) {
            // Discard the unposted final draft so the bot writes a single
            // cohesive final answer covering the new message(s) instead of
            // posting two separate replies (e.g. "He" then "Hey").
            const hadDraft = blocks.slice(finalStart).some((part) => String(part ?? '').trim());
            blocks.length = finalStart;
            while (toolBoundaries.length && toolBoundaries[toolBoundaries.length - 1] > finalStart) toolBoundaries.pop();
            update();
            inputQueue.push(userMessage(formatBotFinalInbox(items, { replacedDraft: hadDraft })));
          } else {
            // Non-person items (e.g. a routine already claimed mid-reply):
            // keep what was answered so far as its own message and go on.
            sendPending();
            finalStart = blocks.length;
            toolBoundaries.push(blocks.length);
            update();
            inputQueue.push(userMessage(formatBotInbox(items)));
          }
        }
      }
    } catch (error) {
      attempt.thrown = error;
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort);
      inputQueue.close();
      try {
        query?.close?.();
      } catch {}
      try {
        abortController.abort();
      } catch {}
    }
    return attempt;
  };

  const succeeded = (attempt) => attempt.result && !attempt.result.is_error && attempt.result.subtype === 'success';
  const failureText = (attempt) =>
    [
      attempt.thrown?.message ?? '',
      Array.isArray(attempt.result?.errors) ? attempt.result.errors.join('; ') : '',
      typeof attempt.result?.result === 'string' ? attempt.result.result : '',
      attempt.assistantError ?? '',
      attempt.stderrTail,
    ].join('\n');
  // Failed before writing or doing anything, for a reason another try here can
  // fix (not a usage limit, a sign-in or a missing runtime). An attempt that
  // ran a tool isn't redone: its effects (a task, a message, a file) would repeat.
  const retryableHere = (attempt) =>
    !succeeded(attempt) &&
    !ctx.signal?.aborted &&
    !currentText().trim() &&
    sentCount === 0 &&
    !attempt.usedTools &&
    !attempt.rateLimited &&
    !RETRY_ELSEWHERE_ASSISTANT_ERRORS.has(attempt.assistantError) &&
    !isRetryElsewhereError(failureText(attempt));
  const startOver = async (nextPlan) => {
    plan = nextPlan;
    blocks.length = 0;
    finalStart = 0;
    toolBoundaries.length = 0;
    finalInboxRounds = 0;
    partial = '';
    toolCalls.clear();
    // Messages the failed attempt was handed (at its turn's end) are this
    // reply's to answer: the fresh one gets them again, and only what it
    // reads counts as seen.
    pendingInbox.unshift(...deliveredItems.splice(0));
    deliveredSeqs.length = 0;
    return await runAttempt(plan);
  };
  let attempt;
  let resumeFailed = false;
  try {
    attempt = await runAttempt(
      plan.mode === 'resume' ? { ...plan, sessionId: claimed.state.sessionId, systemAppend: claimed.state.systemAppend } : plan
    );
    if (plan.mode === 'resume' && retryableHere(attempt)) {
      // The kept session couldn't be resumed (missing, broken): start over fresh.
      resumeFailed = true;
      attempt = await startOver(planFor(null));
    }
    if (retryableHere(attempt) && PROMPT_TOO_LONG.test(failureText(attempt))) {
      // The estimate was off (a reply never fails for its size): half the room.
      attempt = await startOver(planFor(null, Math.floor(maxPromptTokens / 2)));
    }
  } finally {
    // The session is kept only after a complete reply; anything else starts the next one fresh.
    if (keptSessions && !claimed.busy) {
      const keep = plan.keep && attempt && succeeded(attempt) && !ctx.signal?.aborted && attempt.sessionId;
      await keptSessions.end(
        sessionKey,
        keep
          ? {
              sessionId: attempt.sessionId,
              basis,
              ...(lane.threadId ? { threadId: lane.threadId } : {}),
              systemAppend: attempt.systemAppend,
              memoryKey: plan.memoryKey,
              model: lane.model ?? null,
              seenSeqs: [...plan.seenSeqs, ...deliveredSeqs].slice(-4_000),
              // This reply, as the thread stores it (its message id).
              // …and the messages it sent before its final answer.
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
      );
    }
  }

  const usage = attempt.result?.usage ? replyUsageOf(attempt.result) : null;
  const sessionInfo = {
    mode: plan.mode,
    reason: resumeFailed ? 'broken' : plan.reason,
    contextTokens: attempt.contextTokens,
    ...(plan.omitted ? { omitted: plan.omitted } : {}),
    ...(plan.shrunk ? { shrunk: plan.shrunk } : {}),
  };
  if (usage) {
    log(
      `bot ${lane.botId} reply usage`,
      JSON.stringify({ model: attempt.model, ...sessionInfo, ...usage, uncached: usage.input })
    );
  }
  const compact = Boolean(plan.compact || (attempt.contextTokens && attempt.contextTokens > sessionResetTokens));
  const extras = { ...(usage ? { usage: { ...usage, ...sessionInfo } } : {}), ...(compact ? { compact: true } : {}) };

  // The final answer: what it wrote after its last message, after any message that couldn't be sent.
  await sending;
  await Promise.all(fileLookups);
  const finalMessageText = () => {
    const allBlocks = partial.trim() ? [...blocks, partial] : blocks;
    const boundaries = [0, ...new Set(toolBoundaries.filter((n) => n > 0 && n < allBlocks.length).sort((a, b) => a - b)), allBlocks.length];
    const segments = [];
    for (let index = 1; index < boundaries.length; index += 1) {
      const segment = allBlocks
        .slice(boundaries[index - 1], boundaries[index])
        .map((part) => String(part ?? '').trim())
        .filter(Boolean)
        .join('\n\n');
      if (segment) segments.push(segment);
    }
    return selectFinalMessage(segments);
  };
  const written =
    lane.finalMessageOnly && !sendsMessages
      ? finalMessageText()
      : [...unsent.filter(Boolean), currentText()].filter((text) => text.trim()).join('\n\n');
  const modelId = durangoModelIdForClaude(attempt.model);
  const withModel = modelId ? { modelId } : {};
  // Messages it sent before its final answer.
  const withSent = sentCount ? { sent: sentCount } : {};
  if (ctx.signal?.aborted) return { text: written, aborted: true, ...withSent, ...withModel, ...extras };
  // Screenshots the text names are attached too; their /tmp embeds leave the text.
  const { text, files } = attaches
    ? await finishReplyFiles(written, replyFiles).catch(() => ({ text: written, files: replyFiles.list() }))
    : { text: written, files: [] };
  const withFiles = files.length ? { files } : {};
  if (succeeded(attempt)) return { text, ...withSent, ...withFiles, ...withModel, ...extras };

  const { result, thrown, assistantError } = attempt;
  const resultErrors = Array.isArray(result?.errors) ? result.errors.filter(Boolean).join('; ') : '';
  const reason =
    (thrown ? thrown?.message ?? String(thrown) : '') ||
    resultErrors ||
    (typeof result?.result === 'string' ? result.result : '') ||
    (assistantError ? `Claude Code stopped (${assistantError}).` : '') ||
    (result?.subtype && result.subtype !== 'success' ? `Claude Code stopped (${result.subtype}).` : '') ||
    'Claude Code ended before finishing the reply.';
  // A reply that failed before writing anything (a usage limit, no login, an
  // older Claude Code that doesn't have the model, an API error) loses nothing
  // by moving: the next place (another machine or the cloud) answers instead.
  const retryElsewhere =
    (!text.trim() && sentCount === 0) ||
    attempt.rateLimited ||
    RETRY_ELSEWHERE_ASSISTANT_ERRORS.has(assistantError) ||
    (Boolean(thrown) && !attempt.sawInit) ||
    isRetryElsewhereError(`${reason}\n${attempt.stderrTail}`);
  return { text, failure: shorten(reason), retryElsewhere, ...withSent, ...withFiles, ...withModel, ...extras };
};

// --- the worker ------------------------------------------------------------------------

const abortableSleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

const isAbort = (error) =>
  error?.name === 'AbortError' ||
  error?.cause?.name === 'AbortError' ||
  (error instanceof DurangoError && error.code === 'network' && error.cause?.name === 'AbortError');

const isNetworkError = (error) => error instanceof DurangoError && error.code === 'network' && !isAbort(error);

/** Durango no longer has this lane for this machine: the reply moved elsewhere. */
const isLaneGone = (error) =>
  error instanceof DurangoError && (error.status === 404 || error.status === 409 || error.status === 410);

/**
 * deps:
 * - client: { claimBotLane, reportBotLaneProgress, callBotLaneTool, finishBotLane }
 * - getMachineId(): Promise<string|null>
 * - platform: string
 * - isSignedIn(): Promise<boolean>
 * - isOnline(): boolean
 * - isAvailable(): Promise<boolean>   Claude Code can run here
 * - runLane(lane, ctx): see createClaudeLaneRunner
 * - getMachineInfo(): { name, projects: [{ id, name, path, repoId?, key? }], models: string[] } for the
 *   claim (this machine's bot presence) and for starting threads here
 * - startProjectThread({ projectId, prompt, key, botId, botName, title, accessMode }): starts a
 *   Durango Code thread here → { ok, threadId?, error? }; its outcome is reported by the
 *   caller (POST …/bots/tasks/:taskId/report, key = the task id)
 * - startThreadFollowUp({ threadId, prompt, key, botName, accessMode }): a follow-up turn
 *   in an existing thread here, reported the same way (message_thread)
 * - threadTools: createBotThreadTools(...) (bot-thread-tools.js): list_threads,
 *   read_thread and manage_thread here; with startThreadFollowUp, message_thread. Its
 *   manage also handles the claim's threadActions and legacy settleThreads (from the cloud)
 * - stopThread(threadId, taskId): stops that task's run in a thread here (a task cancelled on Durango; a later turn is left alone)
 * - uploadReplyFile({ path, name, size }): uploads a file the reply attached to the
 *   person's library → its asset `{ id, name, kind }` (POST /api/v1/bots/attachments)
 * - onStateChange(state): void
 */
export const createBotReplyWorker = ({
  client,
  getMachineId,
  platform = process.platform,
  isSignedIn = async () => true,
  isOnline = () => true,
  isAvailable = async () => true,
  runLane,
  getMachineInfo = async () => null,
  listModels = null,
  startProjectThread = null,
  startThreadFollowUp = null,
  threadTools = null,
  stopThread = null,
  uploadReplyFile = null,
  maxLanes = BOT_MAX_LANES,
  claimWaitMs = BOT_CLAIM_WAIT_MS,
  throttleMs = BOT_PROGRESS_THROTTLE_MS,
  reportRetryDelaysMs = REPORT_RETRY_DELAYS_MS,
  unavailableRecheckMs = UNAVAILABLE_RECHECK_MS,
  sleep = abortableSleep,
  random = Math.random,
  onStateChange = () => {},
  log = (...args) => console.warn('[durango bots]', ...args),
}) => {
  let settings = normalizeBotSettings({ enabled: false });
  let signedIn = false;
  let suspended = false;
  let generation = 0;
  let controller = null;
  let loopPromise = null;
  let status = 'off';
  let lastError = null;
  const running = new Map(); // laneId -> entry
  let slotWaiters = [];
  // Set while the loop waits out an idle period (an account with no bots).
  let idleWait = null;
  // Task id -> the thread here working on it (started by a reply here), so a
  // task cancelled on Durango stops its thread (the claim's stopTasks). Each
  // stop is acknowledged on the next claim once handled; until then Durango
  // sends it again.
  const taskThreads = new Map();
  const STOP_WAIT_MS = 10 * 60_000;
  const awaitingThread = new Map(); // task id -> until when (its thread isn't known yet)
  const stopping = new Set();
  const stopAcks = new Set();
  // manage_thread (and legacy settle_thread) from a reply elsewhere (the cloud,
  // another machine): Durango hands pending actions to every machine that may
  // have the thread (the claim's threadActions / settleThreads), until each
  // acknowledges. A machine without the thread acknowledges too; one whose
  // window can't take it now tries again.
  const settling = new Set();
  const settleAcks = new Set();
  const settleAttempts = new Map(); // thread id -> failed attempts so far
  const settleQueuedThreads = (threadIds, isCurrent = () => true) => {
    for (const threadId of Array.isArray(threadIds) ? threadIds : []) {
      if (typeof threadId !== 'string' || !threadId || settling.has(threadId) || settleAcks.has(threadId)) continue;
      if (!threadTools) {
        settleAcks.add(threadId);
        continue;
      }
      settling.add(threadId);
      void Promise.resolve()
        // Turned off or signed out meanwhile: left for a later poll.
        .then(() => (isCurrent() ? threadTools.settle({ thread_id: threadId }, { exact: true }) : null))
        .catch((error) => ({ ok: false, error: error?.message ?? String(error) }))
        .then((result) => {
          if (!result) return;
          const error = String(result.error ?? '');
          if (!result.ok && !THREAD_ACTION_FINAL_ERROR.test(error)) {
            const attempts = (settleAttempts.get(threadId) ?? 0) + 1;
            settleAttempts.set(threadId, attempts);
            while (settleAttempts.size > 100) settleAttempts.delete(settleAttempts.keys().next().value);
            if (attempts < THREAD_ACTION_ATTEMPTS) {
              log(`settling thread ${threadId} failed (will retry):`, error);
              return;
            }
          }
          if (!result.ok && !/^No thread /.test(error)) log(`thread ${threadId} not settled:`, error);
          settleAttempts.delete(threadId);
          settleAcks.add(threadId);
        })
        .finally(() => settling.delete(threadId));
    }
  };
  const runningThreadActions = new Set();
  const threadActionAcks = new Set();
  const threadActionAttempts = new Map(); // action id -> failed attempts so far
  // Per-thread promise chain so multiple queued actions on the same thread
  // (e.g. rename then settle) run strictly in array order rather than racing.
  const threadActionChains = new Map(); // thread id -> tail promise
  const runQueuedThreadActions = (actions, isCurrent = () => true) => {
    for (const item of Array.isArray(actions) ? actions : []) {
      const id = typeof item?.id === 'string' ? item.id : '';
      const threadId = typeof item?.threadId === 'string' ? item.threadId : '';
      const action = typeof item?.action === 'string' ? item.action : '';
      if (!id || runningThreadActions.has(id) || threadActionAcks.has(id)) continue;
      if (!threadTools || !threadId || !action) {
        threadActionAcks.add(id);
        continue;
      }
      const invoke = () =>
        action === 'answer_request'
          ? typeof threadTools.answer === 'function'
            ? threadTools.answer(
                {
                  thread_id: threadId,
                  answer: item.answer,
                  ...(item.requestId ? { request_id: item.requestId } : {}),
                  ...(item.reply ? { reply: item.reply } : {}),
                },
                { exact: true, botName: typeof item.botName === 'string' ? item.botName : '' }
              )
            : { ok: false, error: 'Answering thread requests is not available here.' }
          : typeof threadTools.manage === 'function'
          ? threadTools.manage(
              {
                thread_id: threadId,
                action,
                ...(item.title ? { title: item.title } : {}),
                ...(item.modelId ? { modelId: item.modelId } : {}),
                ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
                ...(item.accessMode ? { accessMode: item.accessMode } : {}),
              },
              { exact: true }
            )
          : action === 'settle' && typeof threadTools.settle === 'function'
            ? threadTools.settle({ thread_id: threadId }, { exact: true })
            : { ok: false, error: `Managing threads (${action}) is not available here.` };
      runningThreadActions.add(id);
      const prev = threadActionChains.get(threadId) ?? Promise.resolve();
      const step = prev
        // Turned off or signed out meanwhile: left for a later poll.
        .then(() => (isCurrent() ? invoke() : null))
        .catch((error) => ({ ok: false, error: error?.message ?? String(error) }))
        .then((result) => {
          if (!result) return;
          const error = String(result.error ?? '');
          if (!result.ok && !THREAD_ACTION_FINAL_ERROR.test(error)) {
            const attempts = (threadActionAttempts.get(id) ?? 0) + 1;
            threadActionAttempts.set(id, attempts);
            while (threadActionAttempts.size > 100) threadActionAttempts.delete(threadActionAttempts.keys().next().value);
            if (attempts < THREAD_ACTION_ATTEMPTS) {
              log(`thread action ${action} on ${threadId} failed (will retry):`, error);
              return;
            }
          }
          if (!result.ok && !/^No thread /.test(error)) log(`thread ${threadId} action ${action} not applied:`, error);
          threadActionAttempts.delete(id);
          threadActionAcks.add(id);
        })
        .finally(() => {
          runningThreadActions.delete(id);
          if (threadActionChains.get(threadId) === step) threadActionChains.delete(threadId);
        });
      threadActionChains.set(threadId, step);
    }
  };
  const stopTaskThread = (taskId, threadId) => {
    if (stopping.has(taskId)) return;
    stopping.add(taskId);
    void Promise.resolve()
      .then(() => (stopThread ? stopThread(threadId, taskId) : { ok: true }))
      .then((result) => {
        // Already idle counts as stopped.
        if (result && result.ok === false && !/no running turn/i.test(String(result.error ?? ''))) {
          throw new Error(result.error || 'the thread did not stop');
        }
        taskThreads.delete(taskId);
        stopAcks.add(taskId);
      })
      .catch((error) => log(`stopping the thread of cancelled task ${taskId} failed (will retry):`, error?.message ?? error))
      .finally(() => stopping.delete(taskId));
  };
  const rememberTaskThread = (taskId, threadId) => {
    if (!taskId || !threadId) return;
    taskThreads.delete(taskId);
    taskThreads.set(taskId, threadId);
    while (taskThreads.size > 200) taskThreads.delete(taskThreads.keys().next().value);
    // Cancelled before its thread was known here: stop it now.
    const until = awaitingThread.get(taskId);
    if (until !== undefined) {
      awaitingThread.delete(taskId);
      if (until > Date.now()) stopTaskThread(taskId, threadId);
    }
  };
  const stopCancelledTasks = (taskIds) => {
    const now = Date.now();
    for (const [taskId, until] of awaitingThread) if (until <= now) awaitingThread.delete(taskId);
    for (const taskId of Array.isArray(taskIds) ? taskIds : []) {
      const threadId = taskThreads.get(taskId);
      if (threadId) {
        stopTaskThread(taskId, threadId);
        continue;
      }
      // Not known here (yet): a thread starting now is stopped once it registers.
      if (!awaitingThread.has(taskId)) awaitingThread.set(taskId, now + STOP_WAIT_MS);
      stopAcks.add(taskId);
    }
  };

  const publish = () => {
    try {
      onStateChange(getState());
    } catch {}
  };
  const setStatus = (next, error = lastError) => {
    if (status === next && lastError === error) return;
    status = next;
    lastError = error;
    publish();
  };

  const shouldRun = () => settings.enabled && signedIn && !suspended;

  const wakeSlotWaiters = () => {
    const waiters = slotWaiters;
    slotWaiters = [];
    for (const resolve of waiters) resolve();
  };
  const atLimit = () => running.size >= maxLanes;
  const waitForSlot = (signal) =>
    new Promise((resolve) => {
      if (signal?.aborted || !atLimit()) return resolve();
      slotWaiters.push(resolve);
      signal?.addEventListener('abort', resolve, { once: true });
    });

  /** One POST, retried on network errors. Throws the last error. */
  const withRetries = async (send) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send();
      } catch (error) {
        if (!isNetworkError(error) || attempt >= reportRetryDelaysMs.length) throw error;
        await sleep(reportRetryDelaysMs[attempt]);
      }
    }
  };

  // --- one lane ------------------------------------------------------------------------

  const handleLane = async (lane) => {
    const machineId = (await getMachineId().catch(() => null)) ?? undefined;
    const abort = new AbortController();
    const entry = {
      lane,
      abort,
      stopped: false, // Durango moved the reply elsewhere: never finish
      shutdown: false, // turned off / signed out / quit here
      text: '',
      activeTool: null,
      dirty: false,
      lastSentAt: 0,
      throttleTimer: null,
      heartbeatTimer: null,
      chain: Promise.resolve(),
      seenSeqs: new Set(),
    };
    running.set(lane.laneId, entry);
    publish();
    const heartbeatMs = lane.heartbeatMs || 10_000;

    const clearTimers = () => {
      if (entry.throttleTimer) clearTimeout(entry.throttleTimer);
      if (entry.heartbeatTimer) clearTimeout(entry.heartbeatTimer);
      entry.throttleTimer = null;
      entry.heartbeatTimer = null;
    };
    const stopLane = () => {
      if (entry.stopped) return;
      entry.stopped = true;
      clearTimers();
      abort.abort();
    };
    const armHeartbeat = () => {
      if (entry.heartbeatTimer) clearTimeout(entry.heartbeatTimer);
      if (abort.signal.aborted) return;
      entry.heartbeatTimer = setTimeout(() => void send(false), heartbeatMs);
      entry.heartbeatTimer.unref?.();
    };

    // Progress posts go out one at a time, in order. → the inbox items it took.
    const send = (takeInbox, { beforeFinish = false } = {}) => {
      const next = entry.chain.then(async () => {
        if (abort.signal.aborted) return [];
        entry.dirty = false;
        entry.lastSentAt = Date.now();
        armHeartbeat();
        // A take is named, and the name kept until it gets through: a retry
        // after a lost response returns the same messages (not none).
        if (takeInbox && !entry.pendingTakeId) entry.pendingTakeId = `t${(entry.takeCount = (entry.takeCount ?? 0) + 1)}`;
        const takeId = takeInbox ? entry.pendingTakeId : null;
        let response;
        try {
          response = await withRetries(() =>
            client.reportBotLaneProgress({
              laneId: lane.laneId,
              botId: lane.botId,
              machineId,
              text: entry.text,
              ...(entry.activeTool ? { activeTool: entry.activeTool } : {}),
              takeInbox: Boolean(takeInbox),
              ...(takeId ? { takeId } : {}),
              ...(beforeFinish ? { beforeFinish: true } : {}),
            })
          );
          if (takeId) entry.pendingTakeId = null;
        } catch (error) {
          if (isLaneGone(error) || (error instanceof DurangoError && error.code === 'not_signed_in')) {
            stopLane();
          } else {
            log(`progress for ${lane.laneId} failed:`, error?.message ?? error);
          }
          return [];
        }
        if (response?.stop) {
          stopLane();
          return [];
        }
        const items = [];
        for (const item of Array.isArray(response?.inbox) ? response.inbox : []) {
          if (item.seq !== null && item.seq !== undefined) {
            if (entry.seenSeqs.has(item.seq)) continue;
            entry.seenSeqs.add(item.seq);
          }
          items.push(item);
        }
        if (beforeFinish && items.some((item) => item?.source === 'person')) {
          entry.text = '';
        }
        return items;
      });
      entry.chain = next.catch(() => []);
      return next;
    };

    const update = ({ text, activeTool } = {}) => {
      if (abort.signal.aborted) return;
      const nextText = typeof text === 'string' ? text : entry.text;
      const nextTool = activeTool || null;
      if (nextText === entry.text && nextTool === entry.activeTool) return;
      entry.text = nextText;
      entry.activeTool = nextTool;
      entry.dirty = true;
      if (entry.throttleTimer) return;
      const wait = Math.max(0, entry.lastSentAt + throttleMs - Date.now());
      entry.throttleTimer = setTimeout(() => {
        entry.throttleTimer = null;
        if (entry.dirty && !abort.signal.aborted) void send(false);
      }, wait);
      entry.throttleTimer.unref?.();
    };

    const callServerTool = ({ name, input, toolCallId, message }) =>
      withRetries(() =>
        client.callBotLaneTool({
          laneId: lane.laneId,
          botId: lane.botId,
          machineId,
          name,
          input,
          toolCallId,
          // The message it was made with: a card it shows goes on it.
          ...(Number.isInteger(message) ? { message } : {}),
          signal: abort.signal,
        })
      );

    // One of the reply's messages before its final answer, in order with the
    // progress posts (the live text after it shows only what follows it).
    // → whether it was stored.
    const sendMessage = ({ index, text, modelId }) => {
      const next = entry.chain.then(async () => {
        if (abort.signal.aborted) return false;
        try {
          const response = await withRetries(() =>
            client.sendBotLaneMessage({
              laneId: lane.laneId,
              botId: lane.botId,
              machineId,
              index,
              text,
              ...(modelId ? { modelId } : {}),
            })
          );
          if (response?.stop) {
            stopLane();
            return false;
          }
          return response?.ok !== false;
        } catch (error) {
          if (isLaneGone(error) || (error instanceof DurangoError && error.code === 'not_signed_in')) stopLane();
          else log(`message ${index} of ${lane.laneId} failed:`, error?.message ?? error);
          return false;
        }
      });
      entry.chain = next.then(
        () => [],
        () => []
      );
      return next;
    };

    const loadModels = async () => {
      if (typeof listModels !== 'function') return [];
      const list = (await Promise.resolve(listModels()).catch(() => [])) ?? [];
      return Array.isArray(list) ? list : [];
    };

    // delegate_task in one of this machine's projects: a Durango Code thread
    // here, started by this app (no agent dispatch needed); Durango records
    // the task and gets the thread's outcome when it ends.
    const startThreadHere = async (input, toolCallId) => {
      const target = await localThreadTarget(input, machineId);
      if (!target) return null;
      if (target.error) return { ok: false, error: target.error };
      const title = String(input?.title ?? '').trim();
      const instructions = String(input?.instructions ?? '').trim();
      if (!title || !instructions) return { ok: false, error: 'delegate_task needs a title and instructions.' };
      const choice = resolveThreadModelChoice({
        model: input?.model,
        effort: input?.effort ?? input?.reasoning_effort,
        models: await loadModels(),
        machineName: target.machineName || 'this computer',
        accessMode: input?.access_mode,
        codexServiceTier: input?.codex_service_tier,
        claudeContextWindow: input?.claude_context_window,
      });
      if (!choice.ok) return { ok: false, error: choice.error };
      const accessMode = choice.accessMode ?? settings.accessMode;
      const created = await withRetries(() =>
        client.createBotLaneTask({
          laneId: lane.laneId,
          botId: lane.botId,
          machineId,
          title,
          instructions,
          project: target.project.name,
          ...(typeof target.project.key === 'string' ? { projectKey: target.project.key } : {}),
          // A retry after a lost response gets the same task back (no stray running task).
          ...(toolCallId ? { requestId: String(toolCallId) } : {}),
          // Its threads read the project's notes with project_notes: Durango sends no brief.
          readsProjectNotes: true,
          signal: abort.signal,
        })
      );
      const started = await Promise.resolve(
        startProjectThread({
          projectId: target.project.id,
          // The project's notes aren't pasted in: the thread reads them with project_notes.
          prompt: `${instructions}\n\nWhen you're done, end with a concise report of the outcome: it goes back to the bot "${lane.botName}" that asked for this. ${BOT_REPORT_GUIDE}`,
          key: created.taskId,
          botId: lane.botId,
          botName: lane.botName,
          title: created.title || title,
          accessMode,
          ...(choice.modelId ? { modelId: choice.modelId } : {}),
          ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
          ...(choice.codexServiceTier ? { codexServiceTier: choice.codexServiceTier } : {}),
          ...(choice.claudeContextWindow ? { claudeContextWindow: choice.claudeContextWindow } : {}),
        })
      ).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
      if (!started?.ok) {
        const error = started?.error || 'The Durango Code thread could not start.';
        void client.reportBotTask({ taskId: created.taskId, machineId, outcome: 'failed', error }).catch(() => {});
        return { ok: false, error };
      }
      rememberTaskThread(created.taskId, started.threadId);
      const effectiveModel = started.modelId ?? choice.modelId ?? null;
      const effectiveEffort = started.reasoningEffort ?? choice.reasoningEffort ?? null;
      const effectiveAccess = started.accessMode ?? accessMode ?? null;
      return {
        ok: true,
        taskId: created.taskId,
        title: created.title || title,
        project: target.project.name,
        ...(started.threadId ? { threadId: started.threadId } : {}),
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(effectiveEffort ? { effort: effectiveEffort } : {}),
        ...(effectiveAccess ? { accessMode: effectiveAccess } : {}),
        status: 'running',
        note: 'A Durango Code thread is working on it in that project on this computer; the person can watch it in the app. Its report will arrive in your inbox.',
      };
    };

    // message_thread: a follow-up turn (or live steer) in a thread here, recorded as a task.
    const messageThreadHere = async (input, toolCallId) => {
      const { entry } = await threadTools.findThread(input?.thread_id);
      const message = String(input?.message ?? '').trim();
      if (!message) return { ok: false, error: 'message_thread needs a message.' };
      // A thread waiting on a "Needs you" request takes the message as the
      // reply to it; one running a turn is refused before any task exists, so
      // a refusal never leaves a failed task card in the bot's chat.
      const routed =
        typeof threadTools.routeMessage === 'function'
          ? await threadTools.routeMessage(entry, { message, botName: lane.botName })
          : { running: threadTools.isRunning?.(entry.id) === true };
      if (routed.result) return routed.result;
      if (input?.steer === true) {
        const hasSettings =
          Boolean(String(input?.model ?? '').trim()) ||
          Boolean(String(input?.effort ?? input?.reasoning_effort ?? '').trim()) ||
          Boolean(String(input?.access_mode ?? '').trim()) ||
          Boolean(String(input?.codex_service_tier ?? '').trim()) ||
          Boolean(String(input?.claude_context_window ?? '').trim());
        if (hasSettings) {
          return {
            ok: false,
            error: 'Cannot change model, effort, or access_mode while steering a running turn; stop the turn or wait for it to finish first.',
          };
        }
        const steered = await Promise.resolve(
          startThreadFollowUp({
            threadId: entry.id,
            prompt: `${message}\n\n(Steered by your bot "${lane.botName}")`,
            botName: lane.botName,
            steer: true,
          })
        ).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
        if (!steered?.ok) {
          return { ok: false, error: steered?.error || 'That turn could not be steered.' };
        }
        return { ok: true, threadId: entry.id, steered: true, note: 'Steered the running turn in that thread.' };
      }
      if (routed.running || threadTools.isRunning?.(entry.id)) {
        return {
          ok: false,
          error: 'That thread is currently running a turn. Pass `steer: true` to steer it mid-turn, or wait until it finishes.',
        };
      }
      const choice = resolveThreadModelChoice({
        model: input?.model,
        effort: input?.effort ?? input?.reasoning_effort,
        currentModelId: entry.modelId ?? entry.shell?.modelId ?? null,
        models: await loadModels(),
        accessMode: input?.access_mode,
        codexServiceTier: input?.codex_service_tier,
        claudeContextWindow: input?.claude_context_window,
      });
      if (!choice.ok) return { ok: false, error: choice.error };
      const accessMode = choice.accessMode ?? settings.accessMode;
      const title = String(input?.title ?? '').trim() || `Follow-up: ${entry.title || 'thread'}`.slice(0, 80);
      const created = await withRetries(() =>
        client.createBotLaneTask({
          laneId: lane.laneId,
          botId: lane.botId,
          machineId,
          title,
          instructions: message,
          ...(toolCallId ? { requestId: String(toolCallId) } : {}),
          signal: abort.signal,
        })
      );
      const started = await Promise.resolve(
        startThreadFollowUp({
          threadId: entry.id,
          prompt: `${message}\n\n(From the bot "${lane.botName}": end with a concise report of the outcome; it goes back to the bot. ${BOT_REPORT_GUIDE})`,
          key: created.taskId,
          botName: lane.botName,
          accessMode,
          ...(choice.modelId ? { modelId: choice.modelId } : {}),
          ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
          ...(choice.codexServiceTier ? { codexServiceTier: choice.codexServiceTier } : {}),
          ...(choice.claudeContextWindow ? { claudeContextWindow: choice.claudeContextWindow } : {}),
        })
      ).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
      if (!started?.ok) {
        const error = started?.error || 'The follow-up could not start.';
        void client.reportBotTask({ taskId: created.taskId, machineId, outcome: 'failed', error }).catch(() => {});
        return { ok: false, error };
      }
      // The thread took it as the reply to a request it raised just now (the
      // renderer's own check): no turn of this task's runs, so it ends here.
      if (started.answeredRequest) {
        const summary = answeredRequestSummary(started.answeredRequest);
        void client.reportBotTask({ taskId: created.taskId, machineId, outcome: 'finished', summary }).catch(() => {});
        return { ok: true, threadId: entry.id, answeredRequest: started.answeredRequest, note: summary };
      }
      rememberTaskThread(created.taskId, entry.id);
      const effectiveModel = started.modelId ?? choice.modelId ?? null;
      const effectiveEffort = started.reasoningEffort ?? choice.reasoningEffort ?? null;
      const effectiveAccess = started.accessMode ?? accessMode ?? null;
      return {
        ok: true,
        taskId: created.taskId,
        threadId: entry.id,
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(effectiveEffort ? { effort: effectiveEffort } : {}),
        ...(effectiveAccess ? { accessMode: effectiveAccess } : {}),
        status: 'running',
        note: 'The thread is working on it; the outcome will arrive in your inbox.',
      };
    };

    const callTool = async ({ name, input, toolCallId, message }) => {
      // manage_thread (and legacy settle_thread): a thread here is updated here;
      // one elsewhere goes to Durango, which hands it to the machine that has it.
      if (name === 'manage_thread' || name === 'settle_thread') {
        const normalized = name === 'settle_thread' ? { ...(input ?? {}), action: 'settle' } : (input ?? {});
        const isDelete = String(normalized?.action ?? '').trim().toLowerCase() === 'delete';
        const here = threadTools ? await threadTools.findThread(input?.thread_id, { exact: isDelete }).catch(() => null) : null;
        if (!here) return callServerTool({ name, input, toolCallId });
        try {
          const outcome =
            typeof threadTools.manage === 'function'
              ? await threadTools.manage({ ...normalized, thread_id: here.entry.id })
              : await threadTools.settle({ ...normalized, thread_id: here.entry.id });
          return { result: outcome };
        } catch (error) {
          return { result: { ok: false, error: error?.message ?? String(error) } };
        }
      }
      // answer_thread_request: a thread here is answered here; one elsewhere
      // goes to Durango, which hands it to the machine that has it.
      if (name === 'answer_thread_request') {
        const here = threadTools?.answer ? await threadTools.findThread(input?.thread_id).catch(() => null) : null;
        if (!here) return callServerTool({ name, input, toolCallId });
        try {
          return { result: await threadTools.answer({ ...(input ?? {}), thread_id: here.entry.id }, { botName: lane.botName }) };
        } catch (error) {
          return { result: { ok: false, error: error?.message ?? String(error) } };
        }
      }
      if (threadTools && (name === 'list_thread_models' || name === 'list_threads' || name === 'read_thread' || name === 'message_thread')) {
        try {
          if (name === 'list_thread_models') {
            return {
              result:
                typeof threadTools.listModels === 'function'
                  ? await threadTools.listModels(input ?? {})
                  : { ok: false, error: 'Model catalog is not available here.' },
            };
          }
          if (name === 'list_threads') return { result: await threadTools.list(input ?? {}) };
          if (name === 'read_thread') return { result: await threadTools.read(input ?? {}) };
          if (!startThreadFollowUp) return { result: { ok: false, error: 'Follow-ups are not available here.' } };
          return { result: await messageThreadHere(input ?? {}, toolCallId) };
        } catch (error) {
          return { result: { ok: false, error: error?.message ?? String(error) } };
        }
      }
      // delegate_task with `thread_id` (a follow-up in an existing thread, e.g.
      // to ship its change): a thread here is a message_thread; one on another
      // machine goes to Durango, which sends it there.
      if (name === 'delegate_task' && String(input?.thread_id ?? '').trim()) {
        const here = threadTools && startThreadFollowUp ? await threadTools.findThread(input.thread_id).catch(() => null) : null;
        if (!here) return callServerTool({ name, input, toolCallId });
        try {
          return {
            result: await messageThreadHere(
              {
                thread_id: here.entry.id,
                message: input.instructions,
                title: input.title,
                model: input.model,
                effort: input.effort ?? input.reasoning_effort,
                access_mode: input.access_mode,
                codex_service_tier: input.codex_service_tier,
                claude_context_window: input.claude_context_window,
              },
              toolCallId
            ),
          };
        } catch (error) {
          return { result: { ok: false, error: error?.message ?? String(error) } };
        }
      }
      if (name === 'delegate_task' && startProjectThread) {
        try {
          const result = await startThreadHere(input, toolCallId);
          if (result) return { result };
        } catch (error) {
          return { result: { ok: false, error: error?.message ?? String(error) } };
        }
      }
      return callServerTool({ name, input, toolCallId, message });
    };

    let outcome;
    try {
      void send(false); // started: the first heartbeat
      try {
        // Threads in a project start here (delegate_task `project`); the
        // thread tools list models, read, follow up and manage this machine's threads.
        // This machine's thread tools replace Durango's (manage_thread / legacy settle_thread).
        const replacedNames = threadTools ? new Set([...threadTools.names, 'settle_thread']) : null;
        const tools = threadTools
          ? [
              ...lane.tools.filter((tool) => !replacedNames.has(tool?.name)).map(enrichDelegateTaskTool),
              ...threadTools.definitions.map(withRunOn),
            ]
          : lane.tools.map(enrichDelegateTaskTool);
        outcome = await runLane({ ...lane, threads: 'machine', tools }, {
          signal: abort.signal,
          accessMode: settings.accessMode,
          update,
          takeInbox: (options) => send(true, options),
          callTool,
          // A Durango that stores a reply's messages one by one (the job's `messages`).
          ...(lane.messages ? { sendMessage } : {}),
        });
      } catch (error) {
        const reason = error?.message ?? String(error);
        outcome = { text: entry.text, failure: shorten(reason), retryElsewhere: isRetryElsewhereError(reason) };
      }
      clearTimers();
      // Progress already queued goes out before the finish.
      await entry.chain;
      if (entry.stopped) return;
      let body;
      if (entry.shutdown) {
        // Turned off or signed out here mid-reply: Durango runs it elsewhere.
        body = { text: '', retryElsewhere: true };
      } else {
        const text = String(outcome?.text ?? '').trim();
        const failure = outcome?.failure ? shorten(outcome.failure) : null;
        // Messages it already sent (their files go on the last one).
        const sent = Number.isInteger(outcome?.sent) ? outcome.sent : 0;
        body =
          outcome?.retryElsewhere && !text
            ? { text: '', retryElsewhere: true, ...(failure ? { failure } : {}) }
            : { text, ...(failure ? { failure } : {}) };
        if (outcome?.modelId) body.modelId = outcome.modelId;
        // Its files go up now, in parallel (on its final answer, or its last message); one that doesn't is named under the text.
        if (!body.retryElsewhere && (body.text || sent) && outcome?.files?.length && uploadReplyFile) {
          const uploads = await Promise.all(
            outcome.files.map((file) =>
              Promise.resolve()
                .then(() => uploadReplyFile(file))
                .then(
                  (asset) => ({ file, asset }),
                  (error) => ({ file, error: error?.message ?? String(error) })
                )
            )
          );
          const assets = uploads.filter((item) => item.asset?.id).map((item) => item.asset);
          const failed = uploads.filter((item) => !item.asset?.id);
          if (assets.length) body.files = assets;
          if (failed.length) {
            log(`attaching ${failed.length} file(s) to ${lane.laneId} failed:`, failed.map((item) => item.error).join('; '));
            body.text = [body.text, `_Couldn't attach ${failed.map((item) => item.file.name).join(', ')}._`].filter(Boolean).join('\n\n');
          }
        }
        // Token usage (logged by Durango) and whether the bot's history should be compacted now.
        if (outcome?.usage) body.usage = outcome.usage;
        if (outcome?.compact) body.compact = true;
        // A take that never got through: its messages (if it claimed any)
        // never reached this reply, so they go back to the inbox.
        if (entry.pendingTakeId && !body.retryElsewhere) body.lostTakes = [entry.pendingTakeId];
      }
      try {
        await withRetries(() =>
          client.finishBotLane({ laneId: lane.laneId, botId: lane.botId, machineId, ...body })
        );
      } catch (error) {
        if (!isLaneGone(error)) log(`finish for ${lane.laneId} failed:`, error?.message ?? error);
      }
    } finally {
      clearTimers();
      abort.abort();
      if (running.get(lane.laneId) === entry) running.delete(lane.laneId);
      wakeSlotWaiters();
      publish();
    }
  };

  const shutdownLanes = () => {
    for (const entry of running.values()) {
      if (entry.abort.signal.aborted) continue;
      entry.shutdown = true;
      entry.abort.abort();
    }
  };

  // --- claim loop ------------------------------------------------------------------------

  const loop = async (myGeneration, signal) => {
    let failures = 0;
    const current = () => myGeneration === generation && !signal.aborted && shouldRun();
    const backoff = async (error) => {
      failures += 1;
      const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(failures - 1, 6));
      setStatus('error', error?.message ?? String(error));
      await sleep(Math.round(base * (0.75 + random() * 0.5)), signal);
    };
    while (current()) {
      if (!isOnline()) {
        setStatus('offline', null);
        await sleep(OFFLINE_RECHECK_MS, signal);
        continue;
      }
      if (!(await isAvailable().catch(() => false))) {
        if (!current()) break;
        setStatus('unavailable', null);
        await sleep(unavailableRecheckMs, signal);
        continue;
      }
      if (atLimit()) {
        setStatus('busy', null);
        await waitForSlot(signal);
        continue;
      }
      if (!current()) break;
      setStatus(running.size ? 'running' : 'listening', null);
      let claimed;
      try {
        const machineId = await getMachineId();
        const info = await Promise.resolve(getMachineInfo()).catch(() => null);
        const acks = [...stopAcks];
        const settled = [...settleAcks];
        const actionAcks = [...threadActionAcks];
        claimed = await client.claimBotLane({
          machineId,
          platform,
          ...(info ? { machine: presenceOf(info) } : {}),
          ...(acks.length ? { ackStopTasks: acks } : {}),
          ...(settled.length ? { ackSettleThreads: settled } : {}),
          ...(actionAcks.length ? { ackThreadActions: actionAcks } : {}),
          // Replies come as a structured conversation (lane.session): kept sessions;
          // go out as messages (lane.messages); drain queued threadActions; and support configure.
          features: [
            BOT_SESSIONS_FEATURE,
            BOT_REPLY_MESSAGES_FEATURE,
            BOT_THREAD_ACTIONS_FEATURE,
            BOT_THREAD_CONFIGURE_FEATURE,
            BOT_THREAD_REQUESTS_FEATURE,
          ],
          waitMs: claimWaitMs,
          signal,
        });
        for (const id of acks) stopAcks.delete(id);
        for (const id of settled) settleAcks.delete(id);
        for (const id of actionAcks) threadActionAcks.delete(id);
        failures = 0;
      } catch (error) {
        if (!current() || isAbort(error)) continue;
        if (error instanceof DurangoError && error.code === 'not_signed_in') {
          setStatus('signed_out', null);
          break;
        }
        await backoff(error);
        continue;
      }
      stopCancelledTasks(claimed?.stopTasks);
      if (current()) {
        settleQueuedThreads(claimed?.settleThreads, current);
        runQueuedThreadActions(claimed?.threadActions, current);
      }
      // No bots on the account: nothing to answer, so check back much later
      // (wake() — a bot made or messaged here — or a sign-in restarts sooner).
      if (claimed?.idleMs) {
        idleWait = new AbortController();
        await sleep(claimed.idleMs, AbortSignal.any([signal, idleWait.signal]));
        idleWait = null;
        continue;
      }
      const lane = claimed?.lane;
      if (!lane || running.has(lane.laneId)) continue;
      if (!current()) {
        // Turned off during the claim: let Durango send it elsewhere now.
        void client
          .finishBotLane({ laneId: lane.laneId, botId: lane.botId, machineId: await getMachineId(), text: '', retryElsewhere: true })
          .catch(() => {});
        continue;
      }
      void handleLane(lane).catch((error) => log('lane failed', error?.message ?? error));
    }
  };

  const restart = () => {
    generation += 1;
    controller?.abort();
    controller = null;
    wakeSlotWaiters();
    if (!shouldRun()) {
      shutdownLanes();
      setStatus(!settings.enabled ? 'off' : !signedIn ? 'signed_out' : suspended ? 'paused' : 'off', null);
      return;
    }
    const myController = new AbortController();
    controller = myController;
    const myGeneration = generation;
    const previous = loopPromise ?? Promise.resolve();
    loopPromise = previous
      .catch(() => {})
      .then(() => loop(myGeneration, myController.signal))
      .catch((error) => log('claim loop stopped', error?.message ?? error))
      .finally(() => {
        if (myGeneration === generation && status !== 'signed_out' && status !== 'error') {
          if (!shouldRun()) setStatus(!settings.enabled ? 'off' : 'paused', null);
        }
      });
  };

  // Whether delegate_task's `project` (and `run_on`) mean a thread on this
  // machine: → { project } | { error } | null (not here: Durango handles it).
  async function localThreadTarget(input, machineId) {
    const projectName = String(input?.project ?? '').trim();
    if (!projectName) return null;
    const runOn = String(input?.run_on ?? '').trim().toLowerCase();
    if (runOn === 'cloud' || runOn === 'web') return null;
    const info = await Promise.resolve(getMachineInfo()).catch(() => null);
    if (!info) return null;
    const name = String(info.name ?? '').trim().toLowerCase();
    const here =
      !runOn ||
      runOn === String(machineId ?? '').toLowerCase() ||
      runOn === `machine:${String(machineId ?? '').toLowerCase()}` ||
      (name && (runOn === name || name.includes(runOn)));
    if (!here) return null;
    const project = findProject(info.projects, projectName);
    if (project) return { project, machineName: info.name || 'this computer' };
    // Asked for here by name, or nothing else could have it: say what exists.
    if (runOn) {
      const names = botProjectsForLane(info.projects).map((item) => item.name);
      return { error: `No Durango Code project named "${projectName}" on this computer. Projects: ${names.join(', ') || 'none'}.` };
    }
    return null;
  }

  function getState() {
    return {
      enabled: settings.enabled,
      signedIn,
      status,
      lastError,
      running: [...running.values()].map((entry) => ({
        laneId: entry.lane.laneId,
        botId: entry.lane.botId,
        botName: entry.lane.botName,
      })),
    };
  }

  return {
    getState,
    /** The bot settings (normalizeBotSettings): `enabled` gates the worker, `accessMode` is every reply's. */
    configure({ settings: nextSettings } = {}) {
      const previous = settings;
      settings = normalizeBotSettings(nextSettings);
      if (previous.enabled !== settings.enabled || !loopPromise) restart();
      publish();
    },
    /**
     * A bot was just made or messaged here: stop waiting out an idle period.
     * Only that wait ends: a claim in flight (a reply being handed over) is left alone.
     */
    wake() {
      idleWait?.abort();
    },
    accountChanged(isSignedInNow) {
      const next = Boolean(isSignedInNow);
      if (next === signedIn && !(next && (status === 'signed_out' || status === 'error'))) return;
      signedIn = next;
      restart();
    },
    suspend() {
      if (suspended) return;
      suspended = true;
      restart();
    },
    resume() {
      if (!suspended) return;
      suspended = false;
      restart();
    },
    /** Quit: stop claiming and abort running replies. */
    stop() {
      settings = { ...settings, enabled: false };
      restart();
    },
    /** For tests: resolves when the current loop exits. */
    idle: () => loopPromise ?? Promise.resolve(),
  };
};
