import path from 'node:path';
import { claudeNoticeActivity, claudeUserContent, createClaudeInputRequests } from './claude-input.js';
import { withClaudeEnv } from './claude-env.js';
import { CLAUDE_CHROME_BROWSER_TIPS, claudeChromeLeaseHooks } from './claude-chrome.js';
import { claudeForegroundWaitHooks } from './claude-foreground-wait.js';
import { existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { emitAgentEvent } from './events.js';
import { captureGitChangeSnapshot, summarizeChangedFiles } from './git-utils.js';
import { requestSubagentSpawn, requestSubagentStop } from './mcp-bridge.js';
import { READ_THREAD_DEFAULT_LIMIT, READ_THREAD_MAX_LIMIT, readThreadForAgent } from './thread-reader.js';
import {
  DURANGO_TOOL_DESCRIPTIONS,
  READ_CHAT_DEFAULT_LIMIT,
  READ_CHAT_MAX_LIMIT,
  SEARCH_CHATS_DEFAULT_LIMIT,
  SEARCH_CHATS_MAX_LIMIT,
  runDurangoTool,
} from './durango-tools.js';
import { orionBuiltinToolNamesForAccessMode } from './thread-reader-routing.js';
import { USER_ACTION_MAX_CHARS, USER_ACTION_TOOL_DESCRIPTIONS, USER_ACTION_TOOL_INPUT_SCHEMAS, runUserActionTool } from './user-actions.js';
import { claudeEffortForCli, claudeModelArgForContextWindow, defaultClaudeContextWindow, defaultClaudeReasoningEffort, parseExtraArgs } from './models.js';
import { finalizingAgentRuns, startingAgentRuns } from './run-registry.js';
import { execFileAsync, resolveCommandPath } from './shell-env.js';
import { extractActivitiesFromJsonEvent, extractClaudeReasoningFromJsonEvent, extractClaudeTextFromJsonEvent, extractSessionIdFromJsonEvent, stringifySummary } from './stream-adapters.js';
import { claudeTaskOutputCandidates, createSubagentTracker, handleClaudeSubagentLine } from './subagent-trackers.js';

export let claudeSdkModulePromise = null;
export const loadClaudeSdk = () => {
  claudeSdkModulePromise ??= import('@anthropic-ai/claude-agent-sdk');
  return claudeSdkModulePromise;
};

export let zodModulePromise = null;
export const loadZod = () => {
  zodModulePromise ??= import('zod');
  return zodModulePromise;
};

// Prefer an up-to-date user CLI; an older install must not shadow the bundled
// runtime and prevent Fable 5.1 or current SDK controls from working.
export const supportsClaudeSdkRuntime = (version) => {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 261)));
};
export const bundledClaudeBinary = () => {
  if (!process.resourcesPath) return null;
  const binary = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules',
    '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'claude.exe' : 'claude');
  return existsSync(binary) ? binary : null;
};
export let claudeBinaryPromise = null;
export const resolveClaudeBinary = () => {
  claudeBinaryPromise ??= (async () => {
    const binary = await resolveCommandPath('claude');
    if (!binary) return bundledClaudeBinary();
    try {
      const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 5000 });
      return supportsClaudeSdkRuntime(stdout) ? binary : bundledClaudeBinary();
    } catch { return bundledClaudeBinary(); }
  })();
  return claudeBinaryPromise;
};

export const claudeSdkSessions = new Map(); // threadId -> session
// Slash commands reported by the CLI (built-ins, .claude/commands, skills,
// plugins). Keyed by projectPath — custom commands are user+project scoped, so
// every thread in a project shares one list. Survives session eviction; the
// next live session's init refreshes it.
export const claudeSlashCommandCache = new Map(); // projectPath -> SlashCommandInfo[]
// Cold-project harvests in flight (short-lived promptless CLI boots that only
// call supportedCommands()). Deduped per project so a burst of renderer pulls
// shares one spawn.
export const claudeSlashCommandHarvests = new Map(); // projectPath -> Promise<SlashCommandInfo[] | null>
// Sessions removed from claudeSdkSessions but whose SDK/CLI process has not
// acknowledged AbortController.abort() yet. Destructive workspace teardown
// waits for every entry for the thread instead of mistaking "removed from the
// active map" for "process exited".
export const terminatingClaudeSdkSessions = new Map(); // threadId -> Set<session>
// A foreground turn can finish while Claude-owned background agents keep
// running. Retain that completed run id as a cancellable handle until the
// background work settles or a new turn takes over.
export const claudeBackgroundRunSessions = new Map(); // runId -> session

export const clearClaudeBackgroundRun = (session) => {
  if (!session.backgroundRunId) return;
  if (claudeBackgroundRunSessions.get(session.backgroundRunId) === session) {
    claudeBackgroundRunSessions.delete(session.backgroundRunId);
  }
  session.backgroundRunId = null;
};

export const retainClaudeBackgroundRun = (session, runId) => {
  clearClaudeBackgroundRun(session);
  session.backgroundRunId = runId;
  claudeBackgroundRunSessions.set(runId, session);
};

// Claude only: other providers have no background-task roster to attach to.
export const WAIT_FOR_BACKGROUND_TASKS_DESCRIPTION =
  'Keep this Durango Code thread in Working while background commands you are waiting on run. Call it right after starting a background Bash command (run_in_background) whose result you will act on, such as a build, deploy, release, test run, or a wait-until loop, passing the task id it printed. When the command finishes you are re-invoked with its result, and the thread reads as Working the whole time instead of finished. Do not use it for work you leave running (dev servers, watchers, log tails). While the thread idles on a command that is still running, Durango Code re-invokes you to check on it (after check_in_seconds, then at doubling intervals), so a command that finished its work but has not exited does not hold the thread. `waiting: false` stops waiting without stopping the command.';

// The tool is usually deferred (only its name is listed), so say when to use it.
export const CLAUDE_BACKGROUND_WAIT_TIP = [
  '# Background commands (Durango Code)',
  'Never wait in the foreground. Anything that can run for more than a couple of minutes (a deploy, a release, a long build or test run, a loop that polls until something finishes) goes in the background: a foreground command blocks the thread with no progress and no way to steer you until it exits, so Durango Code refuses foreground Bash calls with a timeout over 5 minutes, and polling loops or blocking TaskOutput waits over 2.',
  'When you start a background Bash command (run_in_background) and will wait for its result before you are done, such as a build, deploy, release, test run or a wait-until loop, call mcp__orion__wait_for_background_tasks with its task id right after starting it. Durango Code then keeps the thread Working until it finishes and you are re-invoked. Without it, ending your turn shows the thread as finished while you are still waiting. Skip it for work you leave running (dev servers, watchers).',
  'Make a background command exit as soon as its work is done: a pipeline only ends when every part has, so never feed a prompt from a pipeline padded with a long `sleep`, and give polling loops a stop condition.',
].join('\n');

// SDK hooks are one object per session; join each event's matchers.
const mergeClaudeHooks = (...sets) => {
  const merged = {};
  for (const set of sets) {
    for (const [event, matchers] of Object.entries(set)) merged[event] = [...(merged[event] ?? []), ...matchers];
  }
  return merged;
};

// Same reason: say when to reach for request_user_action (user-actions.js).
export const CLAUDE_USER_ACTION_TIP = [
  '# Actions only the user can take (Durango Code)',
  'When you need the user to do something outside this chat, such as finishing a login or authorization in a browser window you opened (npm login, OAuth, a device code), approving a prompt on their machine, or giving you a value you cannot get yourself, call mcp__orion__request_user_action with one clear instruction (and the url, if there is one). Durango Code flags the thread as needing them and pins the action above the composer, so it is not lost among your messages. Keep working on anything that does not depend on it, and call mcp__orion__resolve_user_action with the returned action_id as soon as it is done. When the user clicks Done on it, you get a message starting with "Done:". If they reply instead, you get one starting with "Not done:" followed by what they want instead; follow it rather than asking again.',
].join('\n');

// Mirrored in mcp-bridge-shim.cjs's spawn_subagent schema; keep in step.
const SPAWN_SUBAGENT_EFFORT_DESCRIPTION =
  'Reasoning effort for the subagent, e.g. "low", "medium", "high", "xhigh" or "max" (the levels the model supports in its effort picker). Omit to keep the default: the effort this thread last used for that provider.';

// In-process MCP server offered to every Claude SDK session (not only
// orchestrator ones — @-mentions can request delegation from any thread).
// The tool asks the renderer to spawn a subthread on another model and
// blocks until the subagent's final report arrives.
export const createOrionMcpServer = ({ createSdkMcpServer, tool }, { z }, session) =>
  createSdkMcpServer({
    name: 'orion',
    version: '1.0.0',
    tools: [
      tool(
        'spawn_subagent',
        'Spawn a Durango Code subagent on a specific model to perform a task. Blocks until the subagent finishes and returns its final report. Safe to call multiple times in one message — parallel calls run their subagents concurrently. Use for delegating work to specialized models (computer use, exploration, implementation, image/video generation) or to a model the user asks for, whether by @-mention or by name ("review this with gpt-6.1-sol"). Prefer it to running that model\'s CLI yourself.',
        {
          model: z.string().describe('Target model: model id (e.g. "codex:gpt-5.6-sol"), slug, or label'),
          prompt: z
            .string()
            .describe('Complete, self-contained task for the subagent, including all context it needs and what to report back'),
          title: z.string().optional().describe('Short title for the subthread shown in the sidebar'),
          role: z
            .string()
            .optional()
            .describe('Orchestration role this delegation fulfils: computerUse | exploring | implementation | imageVideoGen'),
          effort: z
            .string()
            .optional()
            .describe(SPAWN_SUBAGENT_EFFORT_DESCRIPTION),
        },
        async (args) => {
          const resultText = await requestSubagentSpawn(
            {
              getSender: () => session.sender,
              threadId: session.threadId,
              projectPath: session.projectPath,
              accessMode: session.accessMode,
            },
            args
          );
          return { content: [{ type: 'text', text: resultText }] };
        },
        {
          // INTENTIONAL, NOT A BUG — do not remove this annotation. It has
          // been flagged (and once wrongly "fixed") by automated review as an
          // unsafe hint on a mutating tool; removing it breaks multi-subagent
          // orchestration outright.
          //
          // Why it exists: Claude Code only runs MCP tool calls from one
          // assistant message concurrently when the tool's annotations
          // declare readOnlyHint (isConcurrencySafe falls back to false
          // otherwise). Since spawn_subagent blocks until its child's entire
          // multi-minute run completes, removing the hint serializes parallel
          // spawns behind the first child — killing subagent fan-out — and
          // queues a same-message stop_subagent behind the very spawn it is
          // meant to cancel.
          //
          // Why it is safe: the hint is honest at the layer it operates on.
          // The call mutates nothing in the driver's own session, and the
          // spawned child inherits the driver's access mode rather than
          // escalating it. No Orion driver keys approval off this hint —
          // every driver special-cases the orion tools by qualified name —
          // so in practice it governs call scheduling only, never
          // permissions. Concurrent children sharing one checkout is a
          // deliberate, prompt-level tradeoff the orchestrating model
          // manages, same as any client's native parallel task tools.
          //
          // Mirrored in mcp-bridge-shim.cjs for the non-Claude providers;
          // keep the two in sync.
          annotations: { readOnlyHint: true },
        }
      ),
      tool(
        'stop_subagent',
        'Stop a running Durango Code subagent that was started with spawn_subagent. Identify it by model and/or title; the selector must match exactly one running subagent unless `all` is true, which stops every match. With no arguments, stops the single running subagent. Use when the user asks to cancel a delegation or when abandoning a stalled subagent in favor of another. Returns a description of what was stopped, or the list of running subagents when the selector was ambiguous or matched nothing.',
        {
          model: z
            .string()
            .optional()
            .describe('Model of the subagent to stop: model id, slug, or label (fuzzy match)'),
          title: z
            .string()
            .optional()
            .describe('Title (or substring) of the subagent subthread to stop'),
          all: z
            .boolean()
            .optional()
            .describe(
              'Stop every running subagent the selector matches (or every running subagent when no selector is given) instead of requiring a unique match'
            ),
        },
        async (args) => {
          const resultText = await requestSubagentStop(
            {
              getSender: () => session.sender,
              threadId: session.threadId,
            },
            args
          );
          return { content: [{ type: 'text', text: resultText }] };
        },
        {
          // INTENTIONAL, NOT A BUG — do not remove; see the rationale on
          // spawn_subagent above. This hint matters even more here: without
          // it, a stop_subagent issued in the same assistant message queues
          // behind the blocking spawn it is trying to cancel, so the
          // "replace a stalled subagent" flow this tool exists for cannot
          // work at all. Yes, stopping is effectful — but no Orion driver
          // keys approval off this hint (each special-cases the orion tools
          // by qualified name), so it only governs call scheduling, and the
          // call mutates nothing in the driver's own session.
          annotations: { readOnlyHint: true },
        }
      ),
      tool(
        'read_thread',
        'Read the transcript of another Durango Code thread (a separate agent conversation in this app) by thread_id — use it when the user @-mentions a thread (the [Thread mentions] context block carries the ids) or when you need context from prior Durango Code work. Returns thread metadata plus a page of its messages, the newest page by default; browse earlier messages with offset/limit.',
        {
          thread_id: z
            .string()
            .describe('Thread id — the exact id from the [Thread mentions] block (a unique prefix or the @thread mention token also resolve)'),
          offset: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('1-based index of the first message to return; messages are ordered oldest to newest. Omit to get the newest messages.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(READ_THREAD_MAX_LIMIT)
            .optional()
            .describe(`Maximum number of messages to return (default ${READ_THREAD_DEFAULT_LIMIT})`),
        },
        async (args) => {
          const resultText = await readThreadForAgent(args);
          return { content: [{ type: 'text', text: resultText }] };
        },
        {
          // Genuinely read-only: reads persisted transcripts from disk and
          // mutates nothing. Mirrored in mcp-bridge-shim.cjs; keep in sync.
          annotations: { readOnlyHint: true },
        }
      ),
      tool(
        'wait_for_background_tasks',
        WAIT_FOR_BACKGROUND_TASKS_DESCRIPTION,
        {
          task_ids: z
            .array(z.string())
            .min(1)
            .max(20)
            .describe('Background task ids, as printed when the command started ("running in background with ID: …")'),
          waiting: z
            .boolean()
            .optional()
            .describe('false stops waiting on these tasks (they keep running); default true'),
          check_in_seconds: z
            .number()
            .int()
            .min(CLAUDE_BACKGROUND_CHECK_IN_MIN_S)
            .max(CLAUDE_BACKGROUND_CHECK_IN_MAX_S)
            .optional()
            .describe(
              `Seconds until you are re-invoked to check on a task that is still running (default ${CLAUDE_BACKGROUND_CHECK_IN_DEFAULT_S}; later check-ins double, up to ${CLAUDE_BACKGROUND_CHECK_IN_MAX_S}). Set it to when you expect the work to be done.`
            ),
        },
        async ({ task_ids: taskIds, waiting = true, check_in_seconds: checkInSeconds }) => {
          const { matched, unmatched } = setClaudeBackgroundTasksAwaited(session, taskIds, waiting);
          if (matched.length > 0) {
            updateClaudeBackgroundCheckIn(
              session,
              checkInSeconds === undefined ? undefined : checkInSeconds * 1000
            );
          }
          const lines = [];
          if (matched.length > 0) {
            lines.push(
              waiting
                ? `Waiting on ${matched.join(', ')}: the thread stays Working until ${matched.length === 1 ? 'it finishes' : 'they finish'} and you are re-invoked with the result. If ${matched.length === 1 ? 'it is' : 'any is'} still running in ${formatClaudeCheckInDelay(session.backgroundCheckIn?.delayMs)}, you are re-invoked to check on ${matched.length === 1 ? 'it' : 'them'}.`
                : `No longer waiting on ${matched.join(', ')}. ${matched.length === 1 ? 'It keeps' : 'They keep'} running.`
            );
          }
          if (unmatched.length > 0) {
            lines.push(`No running background task has the id ${unmatched.join(', ')}.`);
          }
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            ...(matched.length === 0 ? { isError: true } : {}),
          };
        },
        // Only changes how Durango Code presents this thread's own turn.
        { annotations: { readOnlyHint: true } }
      ),
      // User actions (user-actions.js). Mirrored in mcp-bridge-shim.cjs;
      // test-durango-tools.mjs keeps them in sync.
      tool(
        'request_user_action',
        USER_ACTION_TOOL_DESCRIPTIONS.request_user_action,
        {
          action: z
            .string()
            .max(USER_ACTION_MAX_CHARS)
            .describe(USER_ACTION_TOOL_INPUT_SCHEMAS.request_user_action.properties.action.description),
          url: z.string().optional().describe(USER_ACTION_TOOL_INPUT_SCHEMAS.request_user_action.properties.url.description),
        },
        async (args) =>
          durangoToolResult(
            await runUserActionTool('request_user_action', args, {
              getSender: () => session.sender,
              threadId: session.threadId,
            })
          ),
        // Only changes how Durango Code presents this thread.
        { annotations: { readOnlyHint: true } }
      ),
      tool(
        'resolve_user_action',
        USER_ACTION_TOOL_DESCRIPTIONS.resolve_user_action,
        {
          action_id: z
            .string()
            .optional()
            .describe(USER_ACTION_TOOL_INPUT_SCHEMAS.resolve_user_action.properties.action_id.description),
        },
        async (args) =>
          durangoToolResult(
            await runUserActionTool('resolve_user_action', args, {
              getSender: () => session.sender,
              threadId: session.threadId,
            })
          ),
        { annotations: { readOnlyHint: true } }
      ),
      // Durango Chat tools (durango-tools.js). Mirrored in mcp-bridge-shim.cjs
      // for the other providers; test-durango-tools.mjs keeps them in sync.
      tool(
        'search_chats',
        DURANGO_TOOL_DESCRIPTIONS.search_chats,
        {
          query: z.string().describe('Keywords to search chat titles and content'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(SEARCH_CHATS_MAX_LIMIT)
            .optional()
            .describe(`Maximum number of chats to return (default ${SEARCH_CHATS_DEFAULT_LIMIT})`),
        },
        async (args) => durangoToolResult(await runDurangoTool('search_chats', args, session)),
        { annotations: { readOnlyHint: true } }
      ),
      tool(
        'read_chat',
        DURANGO_TOOL_DESCRIPTIONS.read_chat,
        {
          chatId: z
            .string()
            .describe('Durango chat id — from the [Durango chat mentions] block, an @chat token, or search_chats'),
          cursor: z
            .string()
            .optional()
            .describe('Paging cursor returned by a previous read_chat call; omit for the newest messages'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(READ_CHAT_MAX_LIMIT)
            .optional()
            .describe(`Maximum number of messages to return (default ${READ_CHAT_DEFAULT_LIMIT})`),
        },
        async (args) => durangoToolResult(await runDurangoTool('read_chat', args, session)),
        { annotations: { readOnlyHint: true } }
      ),
      tool(
        'recall_memory',
        DURANGO_TOOL_DESCRIPTIONS.recall_memory,
        {
          query: z.string().describe('What to recall, e.g. "deployment preferences for futuremail"'),
        },
        async (args) => durangoToolResult(await runDurangoTool('recall_memory', args, session)),
        { annotations: { readOnlyHint: true } }
      ),
      tool(
        'remember',
        DURANGO_TOOL_DESCRIPTIONS.remember,
        {
          fact: z.string().describe('One short, self-contained fact, e.g. "Prefers bun over npm."'),
        },
        // Writes a pending memory candidate on Durango; refused in Read only.
        async (args) => durangoToolResult(await runDurangoTool('remember', args, session))
      ),
    ],
  });

const durangoToolResult = ({ ok, text }) => ({
  content: [{ type: 'text', text }],
  ...(ok ? {} : { isError: true }),
});

// Legacy extra-flags string ("--foo bar --baz") -> SDK extraArgs map.
export const claudeExtraArgsMap = (extraArgsString) => {
  const tokens = parseExtraArgs(extraArgsString);
  const map = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const eq = key.indexOf('=');
    if (eq !== -1) {
      map[key.slice(0, eq)] = key.slice(eq + 1);
      continue;
    }
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      map[key] = next;
      i += 1;
    } else {
      map[key] = null;
    }
  }
  return map;
};

export const claudeSdkOptionsForInput = (model, input) => {
  const accessMode = input.accessMode || 'full-access';
  const providerOptions =
    input.providerOptions && typeof input.providerOptions === 'object' ? input.providerOptions : {};
  const reasoningEffort = input.claudeReasoningEffort || defaultClaudeReasoningEffort;
  const contextWindow = input.claudeContextWindow || defaultClaudeContextWindow;
  // Browser MCP tools can mutate signed-in external state, so Read only must
  // not expose or pre-approve them even though the filesystem sandbox would
  // otherwise remain intact.
  const chrome = providerOptions.chrome === true && accessMode !== 'read-only';
  const allowedTools =
    accessMode !== 'full-access'
      ? String(providerOptions.allowedTools || '')
          .split(',')
          .map((tool) => tool.trim())
          .filter(
            (tool) =>
              Boolean(tool) &&
              (accessMode !== 'read-only' || !tool.startsWith('mcp__claude-in-chrome'))
          )
      : [];
  // Claude in Chrome tools are MCP tools; headless runs can't show permission
  // prompts, so Workspace write pre-approves the server. Read only disabled it
  // above because browser actions are external mutations.
  if (chrome && accessMode !== 'full-access') allowedTools.push('mcp__claude-in-chrome');
  const extraArgs = claudeExtraArgsMap(providerOptions.extraArgs);
  // Browser control via the Claude Chrome extension. Verified to work in
  // headless --print/stream-json sessions (exposes mcp__claude-in-chrome__*).
  if (chrome) extraArgs.chrome = null; // bare --chrome flag
  return {
    model: claudeModelArgForContextWindow(model.slug, contextWindow),
    effort: claudeEffortForCli(reasoningEffort),
    accessMode,
    ultracode: reasoningEffort === 'ultracode',
    allowedTools,
    extraArgs,
  };
};

// Async iterable the SDK reads user turns from; push() hands the next turn to
// a paused reader, close() ends the stream (and with it the CLI process).
export const createClaudeInputQueue = () => {
  const pending = [];
  let wake = null;
  let closed = false;
  return {
    push(message) {
      pending.push(message);
      if (wake) {
        const resolve = wake;
        wake = null;
        resolve();
      }
    },
    close() {
      closed = true;
      if (wake) {
        const resolve = wake;
        wake = null;
        resolve();
      }
    },
    async *stream() {
      while (true) {
        while (pending.length > 0) yield pending.shift();
        if (closed) return;
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
  };
};

export const claudeStatsFromResult = (result) => {
  const usage = result?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const cachedRead = usage.cache_read_input_tokens ?? 0;
  const inputTokens =
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + cachedRead;
  const outputTokens = usage.output_tokens ?? 0;
  if (inputTokens + outputTokens <= 0) return null;
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cachedReadTokens: cachedRead,
  };
};

export const CLAUDE_SDK_REASONING_EMIT_INTERVAL_MS = 150;

export const createClaudeTurnState = (runId, snapshot) => ({
  runId,
  snapshot,
  streamContext: { textSeen: false },
  knownToolActivities: new Map(),
  pendingReasoning: '',
  reasoningEmitted: false,
  reasoningEmitTimer: null,
  lastReasoningEmitAt: 0,
  toolWrittenPaths: new Set(),
});

// Files this turn edited through the harness's file tools. Changed-files
// summaries diff the shared working tree, so this is the only signal that a
// change detected during the turn's window was actually this turn's doing
// (vs. a concurrent thread in the same workspace) — see summarizeChangedFiles.
export const CLAUDE_FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export const trackClaudeFileWrites = (turn, message) => {
  if (message?.type !== 'assistant') return;
  const content = Array.isArray(message?.message?.content) ? message.message.content : [];
  for (const part of content) {
    if (part?.type !== 'tool_use' || !CLAUDE_FILE_WRITE_TOOLS.has(part?.name)) continue;
    const filePath = part.input?.file_path ?? part.input?.notebook_path;
    if (typeof filePath === 'string' && filePath) {
      turn.toolWrittenPaths.add(path.resolve(filePath));
    }
  }
};

export const sendClaudeTurnReasoning = (session, turn, status = 'running') => {
  const detailDelta = turn.pendingReasoning;
  turn.pendingReasoning = '';
  if (!detailDelta && !turn.reasoningEmitted) return;
  turn.reasoningEmitted = true;
  emitAgentEvent(session.sender, {
    runId: turn.runId,
    threadId: session.threadId,
    type: 'activity',
    activity: { key: `${turn.runId}:reasoning`, type: 'thought', title: 'Reasoning', detailDelta, status },
  });
};

export const queueClaudeTurnReasoning = (session, turn) => {
  const elapsed = Date.now() - turn.lastReasoningEmitAt;
  if (elapsed >= CLAUDE_SDK_REASONING_EMIT_INTERVAL_MS) {
    turn.lastReasoningEmitAt = Date.now();
    sendClaudeTurnReasoning(session, turn);
    return;
  }
  if (turn.reasoningEmitTimer) return;
  turn.reasoningEmitTimer = setTimeout(() => {
    turn.reasoningEmitTimer = null;
    turn.lastReasoningEmitAt = Date.now();
    sendClaudeTurnReasoning(session, turn);
  }, CLAUDE_SDK_REASONING_EMIT_INTERVAL_MS - elapsed);
};

export const finishClaudeTurnReasoning = (session, turn) => {
  if (turn.reasoningEmitTimer) {
    clearTimeout(turn.reasoningEmitTimer);
    turn.reasoningEmitTimer = null;
  }
  sendClaudeTurnReasoning(session, turn, 'done');
};

// Only model output opens a turn on its own; bookkeeping system messages
// (background_tasks_changed, task_updated, status, ...) between turns don't.
// task_notification specifically must NOT open a turn: the harness sometimes
// delivers the notification without re-invoking the model, and a turn opened
// for it would never receive a `result` — leaving the thread stuck "running"
// forever (and poisoning the FIFO turn queue for every later turn). Pending
// notifications are stashed and flushed into the next turn that opens.
export const claudeMessageOpensTurn = (message) =>
  message?.type === 'assistant' || message?.type === 'stream_event';

// Claude Code's visible task list (the TUI's ctrl+t checklist) is driven by
// the TaskCreate/TaskUpdate tools (legacy CLIs: TodoWrite). Track them into a
// session-scoped task map — the CLI's list persists across turns — and emit
// the same 'plan' activity shape grok's ACP plan updates produce, so the
// renderer's existing task-checklist card renders Claude tasks unchanged.
// The raw tool rows are suppressed via session.taskToolUseIds (both the
// tool_use row and its tool_result update) so the plan card is the only
// surface, matching the Claude Code TUI.
export const CLAUDE_TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite']);
export const CLAUDE_TASK_STATUSES = new Set(['pending', 'in_progress', 'completed']);

// Returns true when the session's task list changed.
export const processClaudeTaskMessage = (session, message) => {
  const content = Array.isArray(message?.message?.content) ? message.message.content : [];
  let changed = false;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;

    if (part.type === 'tool_use' && CLAUDE_TASK_TOOLS.has(part.name)) {
      if (typeof part.id === 'string') session.taskToolUseIds.add(part.id);
      if (part.name === 'TodoWrite') {
        // Legacy full-replacement list: input.todos is the complete new state.
        const todos = Array.isArray(part.input?.todos) ? part.input.todos : [];
        session.tasks = new Map(
          todos.map((todo, index) => [
            `todo:${index}`,
            {
              subject: String(todo?.content ?? ''),
              status: CLAUDE_TASK_STATUSES.has(todo?.status) ? todo.status : 'pending',
            },
          ])
        );
        changed = true;
      } else if (typeof part.id === 'string') {
        // TaskCreate/TaskUpdate apply on their tool_result: the create result
        // carries the harness-assigned task id, and applying on the result
        // also skips calls that errored or were interrupted.
        session.pendingTaskToolUses.set(part.id, { name: part.name, input: part.input ?? {} });
      }
      continue;
    }

    if (part.type === 'tool_result' && typeof part.tool_use_id === 'string') {
      const pending = session.pendingTaskToolUses.get(part.tool_use_id);
      if (!pending) continue;
      session.pendingTaskToolUses.delete(part.tool_use_id);
      if (part.is_error === true) continue;
      // The CLI/SDK put the structured result on the message envelope.
      const structured = message?.tool_use_result;

      if (pending.name === 'TaskCreate') {
        const subject = String(pending.input.subject ?? pending.input.description ?? '').trim();
        let taskId = structured?.task?.id != null ? String(structured.task.id) : null;
        if (!taskId) {
          const text = typeof part.content === 'string' ? part.content : '';
          taskId = /Task #(\S+?):?\s/.exec(`${text} `)?.[1] ?? crypto.randomUUID();
        }
        session.tasks.set(taskId, { subject: subject || `Task #${taskId}`, status: 'pending' });
        changed = true;
      } else if (pending.name === 'TaskUpdate') {
        const taskId = pending.input.taskId != null ? String(pending.input.taskId) : null;
        if (!taskId) continue;
        const status = String(structured?.statusChange?.to ?? pending.input.status ?? '');
        const task = session.tasks.get(taskId) ?? { subject: `Task #${taskId}`, status: 'pending' };
        if (typeof pending.input.subject === 'string' && pending.input.subject.trim()) {
          task.subject = pending.input.subject.trim();
        }
        if (status === 'deleted' || status === 'cancelled') {
          session.tasks.delete(taskId);
        } else {
          if (CLAUDE_TASK_STATUSES.has(status)) task.status = status;
          session.tasks.set(taskId, task);
        }
        changed = true;
      }
    }
  }
  return changed;
};

// Same activity shape as grok's handlePlanUpdate so the renderer's plan card
// (checklist + "Tasks (n/m)" header) applies unchanged.
export const claudeTaskPlanActivity = (session) => {
  const list = [...session.tasks.values()];
  const total = list.length;
  const completed = list.filter((task) => task.status === 'completed').length;
  const active = list.find((task) => task.status === 'in_progress');
  return {
    key: 'plan',
    type: 'plan',
    kind: 'plan',
    title: active
      ? `Tasks (${completed}/${total}) - ${stringifySummary(active.subject, 60)}`
      : `Tasks (${completed}/${total})`,
    status: total > 0 && completed === total ? 'done' : 'running',
    plan: list.map((task) => ({ content: task.subject, status: task.status })),
  };
};

export const claudeTaskNotificationActivity = (message) => ({
  key: `task:${message.task_id ?? crypto.randomUUID()}`,
  type: 'tool',
  title: `Background task ${message.status ?? 'update'}`,
  detail: stringifySummary(message.summary ?? message.task_id, 300),
  status: 'done',
});

// Emit any task notifications that arrived while no turn was active into the
// turn that just opened (the model reacts to them in that turn anyway).
export const flushPendingClaudeTaskNotifications = (session, turn) => {
  const pending = session.pendingTaskNotifications.splice(0);
  for (const activity of pending) {
    emitAgentEvent(session.sender, {
      runId: turn.runId,
      threadId: session.threadId,
      type: 'activity',
      activity,
    });
  }
};

// Claude Code keeps background shells distinct from work the model is waiting
// to rejoin. Agent/workflow completion re-invokes the model, so those tasks
// keep Orion working between turns. A local_bash dev server, log tail, or
// monitor can intentionally run forever: keep it visible and stoppable, but
// never let it pin the completed turn or the persistent SDK session forever —
// unless the model declared it waits on that shell (wait_for_background_tasks),
// which only it can know.
const liveClaudeBackgroundTasks = (session) =>
  [...session.backgroundTasks.entries()].filter(
    ([taskId]) => !session.skipTranscriptTaskIds.has(taskId)
  );

// Claude Code reports backgrounded Bash commands as local_bash. Keep the set
// deliberately narrow so an unknown provider task remains awaited rather than
// being mistaken for a disposable monitor.
const CLAUDE_BACKGROUND_SHELL_TASK_TYPES = new Set(['local_bash', 'bash', 'shell']);
const isClaudeBackgroundShellTask = (task) =>
  CLAUDE_BACKGROUND_SHELL_TASK_TYPES.has(task.taskType);
const claudeBackgroundTaskHoldsTurn = (session, taskId, task) =>
  !isClaudeBackgroundShellTask(task) || Boolean(session.awaitedBackgroundTaskIds?.has(taskId));

export const pendingClaudeBackgroundTasks = (session) =>
  liveClaudeBackgroundTasks(session)
    .filter(([taskId, task]) => claudeBackgroundTaskHoldsTurn(session, taskId, task))
    .map(([, task]) => task.description);

// wait_for_background_tasks: mark (or unmark) live background shells as work
// the model rejoins when they finish. Unknown ids are reported back so the
// model can correct a typo instead of silently ending its turn.
export const setClaudeBackgroundTasksAwaited = (session, taskIds, waiting = true) => {
  session.awaitedBackgroundTaskIds ??= new Set();
  const matched = [];
  const unmatched = [];
  for (const taskId of new Set(taskIds)) {
    if (!session.backgroundTasks.has(taskId)) {
      unmatched.push(taskId);
      continue;
    }
    matched.push(taskId);
    if (waiting) session.awaitedBackgroundTaskIds.add(taskId);
    else session.awaitedBackgroundTaskIds.delete(taskId);
  }
  return { matched, unmatched };
};

// An awaited shell can outlive its work: a pipeline held open by a trailing
// `sleep`, a prompt nobody will answer, a poll loop without a stop condition.
// Only the model can tell that from the output, so while the thread idles on
// one, re-invoke it on a backing-off schedule instead of waiting for an exit
// that may be many minutes away.
export const CLAUDE_BACKGROUND_CHECK_IN_DEFAULT_S = 120;
export const CLAUDE_BACKGROUND_CHECK_IN_MIN_S = 30;
export const CLAUDE_BACKGROUND_CHECK_IN_MAX_S = 30 * 60;

const awaitedLiveClaudeBackgroundTasks = (session) =>
  [...(session.awaitedBackgroundTaskIds ?? [])]
    .filter((taskId) => session.backgroundTasks.has(taskId))
    .map((taskId) => [taskId, session.backgroundTasks.get(taskId)]);

export const formatClaudeCheckInDelay = (delayMs = CLAUDE_BACKGROUND_CHECK_IN_DEFAULT_S * 1000) => {
  const seconds = Math.round(delayMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
};

export const clearClaudeBackgroundCheckIn = (session) => {
  if (session.backgroundCheckIn?.timer) clearTimeout(session.backgroundCheckIn.timer);
  session.backgroundCheckIn = null;
};

// delayMs given: (re)arm with it. Omitted: keep an armed schedule (a repeated
// wait call must not undo the backoff), else arm the default. Nothing awaited
// any more: disarm.
export const updateClaudeBackgroundCheckIn = (session, delayMs) => {
  if (session.ended || awaitedLiveClaudeBackgroundTasks(session).length === 0) {
    clearClaudeBackgroundCheckIn(session);
    return;
  }
  if (delayMs === undefined && session.backgroundCheckIn) return;
  const nextDelayMs = delayMs ?? CLAUDE_BACKGROUND_CHECK_IN_DEFAULT_S * 1000;
  const waitingSince = session.backgroundCheckIn?.waitingSince ?? Date.now();
  clearClaudeBackgroundCheckIn(session);
  session.backgroundCheckIn = {
    delayMs: nextDelayMs,
    waitingSince,
    timer: setTimeout(() => runClaudeBackgroundCheckIn(session), nextDelayMs),
  };
  session.backgroundCheckIn.timer.unref?.();
};

export const claudeBackgroundCheckInPrompt = (tasks, waitedMs, nextDelayMs) => {
  const list = tasks
    .map(([taskId, task]) => `- ${taskId}: ${task.description}`)
    .join('\n');
  const one = tasks.length === 1;
  return [
    `[Durango Code check-in] You are waiting on ${one ? 'a background command that is' : 'background commands that are'} still running after ${formatClaudeCheckInDelay(waitedMs)}:`,
    list,
    `Read ${one ? 'its' : 'their'} output now. If the work ${one ? 'it was' : 'they were'} started for is done, or ${one ? 'it is' : 'one is'} stuck (for example a pipeline held open by a \`sleep\`, or a prompt nobody will answer), stop ${one ? 'it' : 'that one'} and carry on with the task. If ${one ? 'it is' : 'they are'} still making progress, say so in one short line and end your turn: you stay waiting without calling wait_for_background_tasks again, and the next check-in is in ${formatClaudeCheckInDelay(nextDelayMs)} (pass check_in_seconds to change that).`,
  ].join('\n');
};

export const runClaudeBackgroundCheckIn = (session) => {
  const checkIn = session.backgroundCheckIn;
  if (!checkIn || session.ended || session.disposed) return;
  const tasks = awaitedLiveClaudeBackgroundTasks(session);
  if (tasks.length === 0) {
    clearClaudeBackgroundCheckIn(session);
    return;
  }
  const nextDelayMs = Math.min(checkIn.delayMs * 2, CLAUDE_BACKGROUND_CHECK_IN_MAX_S * 1000);
  const waitedMs = Date.now() - checkIn.waitingSince;
  // A busy model sees its tasks itself; look again after the next interval.
  if (session.activeTurns.length === 0 && session.query) {
    openClaudeBackgroundTurn(
      session,
      session.backgroundRunId ?? crypto.randomUUID(),
      'claude — checking on background work'
    );
    session.pushUserMessage(claudeBackgroundCheckInPrompt(tasks, waitedMs, nextDelayMs));
  }
  updateClaudeBackgroundCheckIn(session, nextDelayMs);
};

export const discardableClaudeBackgroundShellTasks = (session) => {
  const liveTasks = liveClaudeBackgroundTasks(session);
  if (
    liveTasks.length === 0 ||
    liveTasks.some(([taskId, task]) => claudeBackgroundTaskHoldsTurn(session, taskId, task))
  ) {
    return [];
  }
  return liveTasks.map(([taskId, task]) => ({
    taskId,
    description: task.description,
  }));
};

// SDK stopTask is the Claude Code-native way to end background work. Bound
// each acknowledgement independently: Stop must still reach the parent turn
// and runtime teardown when one child task's control channel is wedged.
export const stopClaudeBackgroundTasks = async (session, tasks, timeoutMs = 1500) => {
  if (typeof session.query?.stopTask !== 'function' || tasks.length === 0) return;
  await Promise.allSettled(
    tasks.map(async ({ taskId }) => {
      let timeoutId;
      try {
        await Promise.race([
          session.query.stopTask(taskId),
          new Promise((resolve) => {
            timeoutId = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    })
  );
};

// A thread left "working" by a done event that carried pending background
// tasks normally settles when a finished task's notification re-invokes the
// model (that turn's own done event finishes the thread). This timer covers
// the paths that never re-invoke — the task was killed or failed, or its
// notification was suppressed — so the thread can't hang in the working state.
// The delay gives an imminent task_notification time to open its turn first.
export const CLAUDE_BACKGROUND_SETTLE_DELAY_MS = 5000;
export const updateClaudeBackgroundSettle = (session) => {
  const shouldSettle =
    !session.ended &&
    session.activeTurns.length === 0 &&
    liveClaudeBackgroundTasks(session).length === 0;
  if (!shouldSettle) {
    if (session.backgroundSettleTimer) {
      clearTimeout(session.backgroundSettleTimer);
      session.backgroundSettleTimer = null;
    }
    return;
  }
  if (session.backgroundSettleTimer) return;
  session.backgroundSettleTimer = setTimeout(() => {
    session.backgroundSettleTimer = null;
    if (session.activeTurns.length > 0) return;
    clearClaudeBackgroundRun(session);
    emitAgentEvent(session.sender, {
      runId: crypto.randomUUID(),
      threadId: session.threadId,
      type: 'background-settled',
    });
  }, CLAUDE_BACKGROUND_SETTLE_DELAY_MS);
};

export const finalizeClaudeTurn = async (session, resultMessage) => {
  const turn = session.activeTurns.shift();
  if (!turn) return;
  // Steering interrupts the current Claude loop so a user instruction can
  // take effect immediately, even while the model is blocked in a long tool
  // call. That interrupted result is only a transport boundary: the visible
  // Orion run continues with the same run id, so do not emit a terminal event
  // that would clear the renderer's owner before the continuation is pushed.
  if (session.pendingSteerBoundary === turn) {
    finishClaudeTurnReasoning(session, turn);
    turn.resolveSteerBoundary?.(true);
    turn.resolveSteerBoundary = null;
    return;
  }
  // The turn is forgotten but its terminal event still awaits git
  // summarization below — advertise the gap so a racing steer can wait for
  // the real outcome (agent:isRunFinalizing).
  finalizingAgentRuns.add(turn.runId);
  try {
    await finalizeClaudeTurnInner(session, resultMessage, turn);
  } finally {
    finalizingAgentRuns.delete(turn.runId);
  }
};

export const finalizeClaudeTurnInner = async (session, resultMessage, turn) => {
  finishClaudeTurnReasoning(session, turn);
  let changedFiles = [];
  try {
    changedFiles = await summarizeChangedFiles(session.projectPath, turn.snapshot, {
      toolWrittenPaths: turn.toolWrittenPaths,
    });
    // Refresh the baseline so a later harness-initiated turn attributes the
    // files that background agents change while the thread sits idle.
    session.lastTurnEndSnapshot = await captureGitChangeSnapshot(session.projectPath);
  } catch {}
  const stats = claudeStatsFromResult(resultMessage);
  // Error results (auth failure, max turns, execution error) must not read
  // as a finished run. When subtype is 'success' the error text has already
  // streamed as a chunk via the adapter, so keep the event's message short.
  const resultIsError = resultMessage?.is_error === true;
  let errorText = null;
  if (resultIsError) {
    const details = Array.isArray(resultMessage.errors)
      ? resultMessage.errors.filter(Boolean).join('; ')
      : '';
    errorText =
      details ||
      (resultMessage.subtype && resultMessage.subtype !== 'success'
        ? `Claude ended the turn with an error (${resultMessage.subtype}).`
        : 'Claude reported an error for this turn.');
  }
  // Agent/workflow tasks keep the thread working because their completion
  // re-invokes the model. Shell-only work is reported separately: the turn is
  // finished, while Orion retains a bounded, stoppable monitor handle.
  const pendingBackgroundTasks = resultIsError ? [] : pendingClaudeBackgroundTasks(session);
  const pendingBackgroundShellTasks = resultIsError
    ? []
    : discardableClaudeBackgroundShellTasks(session).map((task) => task.description);
  if (!resultIsError && liveClaudeBackgroundTasks(session).length > 0) {
    retainClaudeBackgroundRun(session, turn.runId);
  } else {
    clearClaudeBackgroundRun(session);
  }
  // A successful end finishes whatever checklist task was in flight, even if
  // the agent skipped the closing update. session.tasks persists across
  // turns, so a stale in_progress entry would re-emit as spinning next turn.
  if (!resultIsError && pendingBackgroundTasks.length === 0 && session.tasks) {
    for (const task of session.tasks.values()) {
      if (task.status === 'in_progress') task.status = 'completed';
    }
  }
  emitAgentEvent(session.sender, {
    runId: turn.runId,
    threadId: session.threadId,
    type: resultIsError ? 'error' : 'done',
    exitCode: resultIsError ? 1 : 0,
    changedFiles,
    ...(stats ? { stats } : {}),
    ...(errorText ? { error: errorText } : {}),
    ...(pendingBackgroundTasks.length > 0 ? { pendingBackgroundTasks } : {}),
    ...(pendingBackgroundShellTasks.length > 0 ? { pendingBackgroundShellTasks } : {}),
    providerId: 'claude',
  });
};

// Lazy per-session tracker for claude-native subagents (the harness's task
// system). Lives on the session, not a turn: a subagent can span turn
// boundaries (backgrounded Agent tool), and the tracker survives with it.
export const claudeSessionSubagentTracker = (session) => {
  if (!session.subagentTracker) {
    session.subagentTracker = createSubagentTracker({
      providerId: 'claude',
      threadId: session.threadId,
      getSender: () => session.sender,
      getRunId: () =>
        session.activeTurns[0]?.runId ?? session.backgroundRunId ?? 'claude-session',
    });
  }
  return session.subagentTracker;
};

// Normalize SDK SlashCommand objects to the plain shape the renderer caches;
// drops anything without a usable name and dedupes by name (skills and custom
// commands can shadow each other — e.g. a project and a user skill both named
// "verify" — and the CLI resolves the first one the same way).
// Commands the CLI reports but that only function in server-launched sessions;
// listing them in Orion's menu would offer commands that can never work.
const INTERNAL_CLAUDE_COMMANDS = new Set(['workflow-launch-exec']);

export const normalizeSlashCommands = (commands) => {
  const seen = new Set();
  return (Array.isArray(commands) ? commands : [])
    .map((command) => ({
      name: typeof command?.name === 'string' ? command.name.replace(/^\//, '').trim() : '',
      description: typeof command?.description === 'string' ? command.description : '',
      argumentHint: typeof command?.argumentHint === 'string' ? command.argumentHint : '',
      ...(Array.isArray(command?.aliases) && command.aliases.length > 0
        ? { aliases: command.aliases.map((alias) => String(alias).replace(/^\//, '')) }
        : {}),
    }))
    .filter((command) => {
      if (!command.name || seen.has(command.name)) return false;
      if (command.name.startsWith('__') || INTERNAL_CLAUDE_COMMANDS.has(command.name)) return false;
      seen.add(command.name);
      return true;
    });
};

export const pushSlashCommands = (sender, projectPath, commands) => {
  const normalized = normalizeSlashCommands(commands);
  claudeSlashCommandCache.set(projectPath, normalized);
  if (sender && !sender.isDestroyed()) {
    sender.send('agent:slashCommands', { projectPath, commands: normalized });
  }
};

export const refreshClaudeSlashCommands = async (session) => {
  if (!session.query || session.ended || session.disposed) return null;
  try {
    // supportedCommands() is a control-protocol request; guard with a timeout
    // so a wedged CLI can't hold anything hostage (nothing awaits this on the
    // turn path, but listClaudeSlashCommands does).
    const commands = await Promise.race([
      session.query.supportedCommands(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    pushSlashCommands(session.sender, session.projectPath, commands);
    return claudeSlashCommandCache.get(session.projectPath) ?? null;
  } catch {
    return null;
  }
};

// A project with no session yet still deserves the real command list: boot the
// CLI with a prompt stream that never yields, ask supportedCommands() (a
// control request — no user turn, no model call, no tokens), cache + push the
// answer, and abort the process. settingSources matches real sessions so
// custom commands, skills, and plugin commands all appear; strictMcpConfig
// keeps the user's MCP servers from being spawned for a menu prefetch (their
// prompt-commands arrive later from the first real session's init).
export const harvestClaudeSlashCommands = ({ sender, projectPath }) => {
  const inFlight = claudeSlashCommandHarvests.get(projectPath);
  if (inFlight) return inFlight;
  const harvest = (async () => {
    const abortController = new AbortController();
    try {
      const [sdk, claudeBinary] = await Promise.all([loadClaudeSdk(), resolveClaudeBinary()]);
      const query = sdk.query({
        prompt: (async function* () {
          await new Promise(() => {});
        })(),
        options: {
          cwd: projectPath,
          settingSources: ['user', 'project', 'local'],
          strictMcpConfig: true,
          ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
          abortController,
          env: withClaudeEnv({ ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }),
        },
      });
      const commands = await Promise.race([
        query.supportedCommands(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('slash command harvest timed out')), 20000)
        ),
      ]);
      pushSlashCommands(sender, projectPath, commands);
      return claudeSlashCommandCache.get(projectPath) ?? null;
    } catch {
      return null;
    } finally {
      try {
        abortController.abort();
      } catch {}
      claudeSlashCommandHarvests.delete(projectPath);
    }
  })();
  claudeSlashCommandHarvests.set(projectPath, harvest);
  return harvest;
};

// Renderer pull (agent:listSlashCommands). Prefers a live session for the
// thread, then the project cache (possibly stale after eviction — the next
// real turn's init refreshes it), then any live sibling session in the same
// project, and finally a one-shot harvest boot for cold projects.
export const listClaudeSlashCommands = async ({ sender, threadId, projectPath }) => {
  const session = threadId ? claudeSdkSessions.get(threadId) : null;
  if (session && !session.ended && !session.disposed && session.query) {
    // Pulls come from the currently open renderer. Persistent sessions can
    // outlive a closed BrowserWindow, so future commands_changed pushes must
    // follow the new webContents rather than the destroyed original sender.
    if (sender && !sender.isDestroyed()) {
      session.sender = sender;
      session.createParams.sender = sender;
    }
    const commands = await refreshClaudeSlashCommands(session);
    if (commands) return { ok: true, commands, source: 'live' };
  }
  const cached = projectPath ? claudeSlashCommandCache.get(projectPath) : null;
  if (cached) return { ok: true, commands: cached, source: 'cache' };
  if (!projectPath) return { ok: false };
  // Command lists are project-scoped, so any sibling thread's session answers
  // for this thread too — cheaper than booting a harvest process.
  for (const sibling of claudeSdkSessions.values()) {
    if (sibling.projectPath !== projectPath || sibling.ended || sibling.disposed || !sibling.query)
      continue;
    const commands = await refreshClaudeSlashCommands(sibling);
    if (commands) return { ok: true, commands, source: 'live' };
    break;
  }
  const harvested = await harvestClaudeSlashCommands({ sender, projectPath });
  if (harvested) return { ok: true, commands: harvested, source: 'harvest' };
  return { ok: false };
};

export const handleClaudeSessionMessage = async (session, message) => {
  session.lastActivityAt = Date.now();
  if (!session.sessionId) {
    const sessionId = extractSessionIdFromJsonEvent('claude', message);
    if (sessionId) {
      session.sessionId = sessionId;
      const runId = session.activeTurns[0]?.runId;
      if (runId) {
        emitAgentEvent(session.sender, {
          runId,
          threadId: session.threadId,
          type: 'session',
          providerId: 'claude',
          sessionId,
        });
      }
    }
  }
  if (message?.type === 'system' && message.subtype === 'init') {
    session.sawInit = true;
    // Fetch the full command list (init's slash_commands is names-only — no
    // descriptions or argument hints). Fire-and-forget; pushed to the
    // renderer + cached per project on resolve.
    void refreshClaudeSlashCommands(session);
  }
  if (message?.type === 'system' && message.subtype === 'commands_changed') {
    // Mid-session change (e.g. skills discovered as the agent works). The SDK
    // contract is REPLACE, not merge.
    pushSlashCommands(session.sender, session.projectPath, message.commands);
  }

  // Track the harness's live background tasks so a turn that ends while
  // subagents are still running doesn't read as Finished. skip_transcript
  // tasks are ambient housekeeping and never hold the thread open.
  if (message?.type === 'system' && message.subtype === 'task_started' && message.skip_transcript) {
    session.skipTranscriptTaskIds.add(message.task_id);
  }
  // A spawned subagent: tail its task output file (the subagent's own
  // session transcript) so the renderer can show it as a live, switchable
  // subagent thread.
  if (
    message?.type === 'system' &&
    message.subtype === 'task_started' &&
    !message.skip_transcript &&
    message.task_id &&
    /agent/i.test(String(message.task_type ?? ''))
  ) {
    const tracker = claudeSessionSubagentTracker(session);
    const taskId = message.task_id;
    const fileRef = { path: typeof message.output_file === 'string' ? message.output_file : null };
    session.subagentFileRefs.set(taskId, fileRef);
    const candidates = session.sessionId
      ? claudeTaskOutputCandidates(session.projectPath, session.sessionId, taskId)
      : [];
    tracker.start(
      {
        id: taskId,
        title: String(message.description ?? 'Subagent'),
        kind: typeof message.subagent_type === 'string' ? message.subagent_type : undefined,
        prompt: typeof message.prompt === 'string' ? message.prompt : undefined,
      },
      {
        resolveFile: async () => {
          if (fileRef.path && existsSync(fileRef.path)) return fileRef.path;
          return candidates.find((candidate) => existsSync(candidate)) ?? null;
        },
        handleLine: handleClaudeSubagentLine,
      }
    );
  }
  // Terminal task updates lack the notification's stats/summary — finish
  // after a grace window unless the richer task_notification lands first.
  if (
    message?.type === 'system' &&
    message.subtype === 'task_updated' &&
    message.task_id &&
    session.subagentTracker?.has(message.task_id)
  ) {
    const status = message.patch?.status;
    if (status === 'failed' || status === 'killed') {
      session.subagentTracker.finish(message.task_id, { status: 'error' });
    } else if (status === 'completed') {
      session.subagentTracker.finishSoon(message.task_id, { status: 'done' });
    }
  }
  if (message?.type === 'system' && message.subtype === 'background_tasks_changed') {
    // REPLACE semantics: the payload is the complete live set after the change.
    session.backgroundTasks = new Map(
      (Array.isArray(message.tasks) ? message.tasks : []).map((task) => [
        task.task_id,
        {
          taskType: String(task.task_type ?? ''),
          description: String(task.description ?? task.task_id ?? ''),
        },
      ])
    );
    // An awaited shell that left the live set is no longer waited on.
    for (const taskId of session.awaitedBackgroundTaskIds ?? []) {
      if (!session.backgroundTasks.has(taskId)) session.awaitedBackgroundTaskIds.delete(taskId);
    }
    updateClaudeBackgroundCheckIn(session);
    // A tracked subagent that left the live set without a terminal signal
    // (its notification was suppressed) still has to settle in the UI.
    if (session.subagentTracker) {
      for (const taskId of session.subagentTracker.ids()) {
        if (!session.backgroundTasks.has(taskId)) {
          session.subagentTracker.finishSoon(taskId, { status: 'done' });
        }
      }
    }
    updateClaudeBackgroundSettle(session);
    return;
  }

  let turn = session.activeTurns[0];

  // Subagent frames (parent_tool_use_id set) ride the main stream too, but
  // the subagent tracker already renders them from the subagent transcript.
  // They must never open a turn: a background subagent acting while the main
  // loop is idle would otherwise open a synthetic turn that no `result` ever
  // settles, leaving the thread "running" and unsteerable. Preserve shared
  // checklist updates and the live turn's changed-file attribution.
  if (message?.parent_tool_use_id) {
    if (turn) trackClaudeFileWrites(turn, message);
    const tasksChanged = processClaudeTaskMessage(session, message);
    const runId = turn?.runId ?? session.backgroundRunId;
    if (tasksChanged && runId) {
      emitAgentEvent(session.sender, {
        runId,
        threadId: session.threadId,
        type: 'activity',
        activity: claudeTaskPlanActivity(session),
      });
    }
    return;
  }

  // A task_notification never opens a turn (the harness may not re-invoke the
  // model for it, and a turn without a coming `result` dangles forever). With
  // no turn active, stash it; it flushes into the next turn that opens.
  if (message?.type === 'system' && message.subtype === 'task_notification') {
    if (message.task_id && session.subagentTracker?.has(message.task_id)) {
      const fileRef = session.subagentFileRefs.get(message.task_id);
      if (fileRef && typeof message.output_file === 'string') fileRef.path = message.output_file;
      session.subagentTracker.finish(message.task_id, {
        status: message.status === 'completed' ? 'done' : 'error',
        stats:
          typeof message.usage?.total_tokens === 'number'
            ? { totalTokens: message.usage.total_tokens }
            : undefined,
        summary: typeof message.summary === 'string' ? message.summary : undefined,
      });
    }
    const activity = claudeTaskNotificationActivity(message);
    if (turn) {
      emitAgentEvent(session.sender, {
        runId: turn.runId,
        threadId: session.threadId,
        type: 'activity',
        activity,
      });
    } else {
      session.pendingTaskNotifications.push(activity);
    }
    return;
  }

  if (!turn && claudeMessageOpensTurn(message)) {
    // The harness re-invoked the model between user turns (a background
    // subagent finished). Open a synthetic turn; the renderer adds a message.
    turn = createClaudeTurnState(crypto.randomUUID(), session.lastTurnEndSnapshot);
    session.activeTurns.push(turn);
    // The CLI owes this harness-initiated turn a result message of its own.
    session.resultsOwed += 1;
    updateClaudeBackgroundSettle(session); // a live turn cancels any pending settle
    emitAgentEvent(session.sender, {
      runId: turn.runId,
      threadId: session.threadId,
      type: 'started',
      background: true,
      command: 'claude — background work continued',
    });
    flushPendingClaudeTaskNotifications(session, turn);
  }
  if (!turn) return;
  const notice = claudeNoticeActivity(message);
  if (notice) emitAgentEvent(session.sender, {
    runId: turn.runId, threadId: session.threadId, type: 'activity', activity: notice,
  });

  // The SDK yields the same message shapes the CLI's stream-json emits, so
  // the one-shot path's claude adapter functions apply unchanged.
  if (
    message?.type !== 'assistant' &&
    message?.type !== 'user' &&
    message?.type !== 'stream_event' &&
    message?.type !== 'result'
  ) {
    return;
  }

  const reasoningDelta = extractClaudeReasoningFromJsonEvent(message, turn.streamContext);
  if (reasoningDelta) {
    turn.pendingReasoning = `${turn.pendingReasoning}${reasoningDelta}`;
    queueClaudeTurnReasoning(session, turn);
  }

  trackClaudeFileWrites(turn, message);

  // Task tools drive the live checklist card instead of generic tool rows.
  if (processClaudeTaskMessage(session, message)) {
    emitAgentEvent(session.sender, {
      runId: turn.runId,
      threadId: session.threadId,
      type: 'activity',
      activity: claudeTaskPlanActivity(session),
    });
  }

  for (const { updateForKey, ...activity } of extractActivitiesFromJsonEvent(message)) {
    // Task tool calls and their results stay hidden — the plan card above is
    // their only surface (mirrors the Claude Code TUI).
    if (
      (activity.key && session.taskToolUseIds.has(activity.key)) ||
      (updateForKey && session.taskToolUseIds.has(updateForKey))
    ) {
      continue;
    }
    if (updateForKey) {
      const known = turn.knownToolActivities.get(updateForKey);
      if (known) {
        // The result block carries what the tool returned; fold it onto the
        // original row so expanding it shows the call and its output.
        if (activity.output) known.output = activity.output;
        emitAgentEvent(session.sender, {
          runId: turn.runId,
          threadId: session.threadId,
          type: 'activity',
          activity: {
            ...known,
            key: updateForKey,
            status: activity.status === 'error' || activity.type === 'error' ? 'error' : 'done',
          },
        });
        continue;
      }
    }
    if (activity.key) {
      const { key, status, ...rest } = activity;
      turn.knownToolActivities.set(key, rest);
    }
    emitAgentEvent(session.sender, {
      runId: turn.runId,
      threadId: session.threadId,
      type: 'activity',
      activity,
    });
  }

  const text = extractClaudeTextFromJsonEvent(message, turn.streamContext);
  if (text) {
    turn.streamContext.textSeen = true;
    emitAgentEvent(session.sender, {
      runId: turn.runId,
      threadId: session.threadId,
      type: 'chunk',
      chunk: text,
    });
  }

  if (message?.type === 'result') {
    session.resultsOwed = Math.max(0, session.resultsOwed - 1);
    await finalizeClaudeTurn(session, message);
  }
};

export const endClaudeSession = (session, error) => {
  if (session.ended) return;
  session.ended = true;
  session.userInputs?.cancelAll();
  session.resolveEnded?.();
  const terminating = terminatingClaudeSdkSessions.get(session.threadId);
  if (terminating) {
    terminating.delete(session);
    if (terminating.size === 0) terminatingClaudeSdkSessions.delete(session.threadId);
  }
  clearClaudeBackgroundRun(session);
  session.subagentTracker?.dispose(
    session.disposed ? 'stopped' : error ? 'error' : 'done'
  );
  if (session.backgroundSettleTimer) {
    clearTimeout(session.backgroundSettleTimer);
    session.backgroundSettleTimer = null;
  }
  clearClaudeBackgroundCheckIn(session);
  if (claudeSdkSessions.get(session.threadId) === session) {
    claudeSdkSessions.delete(session.threadId);
  }

  const interruptedSteer = session.pendingSteerBoundary;
  session.pendingSteerBoundary = null;
  interruptedSteer?.resolveSteerBoundary?.(false);
  if (interruptedSteer) interruptedSteer.resolveSteerBoundary = null;
  const pendingTurns = session.activeTurns.splice(0);

  // The stored session may be gone (harness cache cleared, expired, or a CLI
  // update): the process dies before its init event. Retry once fresh,
  // re-driving the same runId so the renderer's message keeps streaming.
  if (
    error &&
    !session.disposed &&
    !session.sawInit &&
    session.resumeSessionId &&
    session.firstPrompt &&
    pendingTurns.length > 0
  ) {
    emitAgentEvent(session.sender, {
      runId: pendingTurns[0].runId,
      threadId: session.threadId,
      type: 'chunk',
      chunk: '_Could not resume the previous session; starting a fresh one._\n\n',
    });
    const fresh = createClaudeSdkSession({
      ...session.createParams,
      resumeSessionId: null,
      forkSession: false,
    });
    claudeSdkSessions.set(session.threadId, fresh);
    fresh.activeTurns.push(pendingTurns[0]);
    fresh
      .start()
      .then(() => syncClaudeOrionMcpServers(fresh, session.orionMcpServers))
      .then(() => fresh.pushUserMessage(session.firstPrompt, { content: session.firstContent }))
      .catch((startError) => {
        fresh.dispose();
        endClaudeSession(fresh, startError);
      });
    return;
  }

  for (const turn of pendingTurns) {
    finishClaudeTurnReasoning(session, turn);
    const stderrTail = session.stderrTail.trim();
    const errorText = session.disposed
      ? null
      : [error?.message ?? 'Claude session ended unexpectedly.', stderrTail]
          .filter(Boolean)
          .join('\n');
    emitAgentEvent(session.sender, {
      runId: turn.runId,
      threadId: session.threadId,
      type: session.disposed ? 'done' : 'error',
      exitCode: session.disposed ? 0 : 1,
      changedFiles: [],
      ...(errorText ? { error: errorText } : {}),
      // Lets the renderer offer the Authenticate button when the failure text
      // reads as a logged-out CLI (e.g. "OAuth session expired").
      ...(session.disposed ? {} : { providerId: 'claude' }),
    });
  }

  // The interrupted boundary may already have been shifted and deliberately
  // hidden while steerClaudeSdkRun was preparing its continuation. If the
  // harness dies in that narrow gap, give the renderer a terminal event so
  // it can dispatch the steer's queued fallback instead of retaining a run
  // that can no longer produce output.
  if (interruptedSteer && !pendingTurns.includes(interruptedSteer)) {
    const errorText =
      !session.disposed && error
        ? [error.message ?? 'Claude session ended unexpectedly.', session.stderrTail.trim()]
            .filter(Boolean)
            .join('\n')
        : null;
    emitAgentEvent(session.sender, {
      runId: interruptedSteer.runId,
      threadId: session.threadId,
      type: errorText ? 'error' : 'done',
      exitCode: errorText ? 1 : 0,
      changedFiles: [],
      ...(errorText ? { error: errorText, providerId: 'claude' } : {}),
    });
  }

  // A thread left waiting on background agents (its last done event carried
  // pending tasks, no turn active) must not stay "working" after the session
  // that owned those agents is gone (stop, options change, process death).
  // With pending turns the done/error events above already settle the thread.
  if (pendingTurns.length === 0) {
    emitAgentEvent(session.sender, {
      runId: crypto.randomUUID(),
      threadId: session.threadId,
      type: 'background-settled',
    });
  }
};

export const pumpClaudeSession = async (session) => {
  try {
    for await (const message of session.query) {
      if (session.disposed) break;
      await handleClaudeSessionMessage(session, message);
    }
    endClaudeSession(session, null);
  } catch (error) {
    endClaudeSession(session, error);
  }
};

// Orion-connected MCP servers join a live session over the SDK control
// channel rather than `mcpServers` (which the SDK puts on the CLI's argv,
// exposing OAuth tokens to `ps`). Called before every turn; a no-op unless the
// set changed, so @-mentioning a server mid-thread loads it for the next
// message and switching it off unloads it again. Returns per-server errors.
const CLAUDE_MCP_SYNC_TIMEOUT_MS = 20_000;
export const syncClaudeOrionMcpServers = async (session, servers = {}) => {
  const next = servers && typeof servers === 'object' ? servers : {};
  const key = JSON.stringify(next);
  const removed = Object.keys(session.orionMcpServers ?? {}).filter((name) => !(name in next));
  session.orionMcpServers = next;
  if (key === (session.orionMcpKey === undefined ? '{}' : session.orionMcpKey)) return {};
  if (!session.query || !session.orionMcpServer) return {};
  // A partial failure can change the live set. Invalidate the previous key
  // until every server is synchronized, including when reverting to that set.
  session.orionMcpKey = null;
  let timer;
  try {
    const result = await Promise.race([
      session.query.setMcpServers({ ...next, orion: session.orionMcpServer }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out connecting MCP servers.')),
          CLAUDE_MCP_SYNC_TIMEOUT_MS
        );
      }),
    ]);
    const errors = result?.errors && typeof result.errors === 'object' ? result.errors : {};
    if (removed.length > 0 && Object.keys(errors).length > 0) {
      throw new Error(`Could not confirm MCP removal: ${removed.join(', ')}.`);
    }
    if (Object.keys(errors).length === 0) session.orionMcpKey = key;
    return errors;
  } catch (error) {
    // A failed control request leaves the live tool set unknown, including
    // on an empty desired set. The caller must discard this session before
    // another prompt can use stale tools or a late timed-out configuration.
    throw new Error(`Could not synchronize MCP servers: ${error?.message ?? String(error)}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
};

export const createClaudeSdkSession = ({
  sender,
  threadId,
  projectPath,
  model,
  input,
  resumeSessionId,
  forkSession,
}) => {
  const sdkOptions = claudeSdkOptionsForInput(model, input);
  const inputQueue = createClaudeInputQueue();
  const abortController = new AbortController();
  let resolveEnded;
  const endedPromise = new Promise((resolve) => {
    resolveEnded = resolve;
  });
  const session = {
    threadId,
    projectPath,
    accessMode: sdkOptions.accessMode,
    sender,
    optionsKey: JSON.stringify([projectPath, sdkOptions]),
    createParams: { sender, threadId, projectPath, model, input },
    resumeSessionId: resumeSessionId ?? null,
    sessionId: null,
    sawInit: false,
    firstPrompt: null,
    activeTurns: [],
    // Task notifications that arrived while no turn was active; flushed as
    // activities into the next turn that opens.
    pendingTaskNotifications: [],
    // Exact foreground owner whose interrupted result is a hidden steering
    // boundary. Cleared as soon as its continuation is reserved, or by
    // session teardown so a lost handoff still settles the renderer.
    pendingSteerBoundary: null,
    // How many `result` messages the CLI still owes (one per pushed user turn
    // and per harness-initiated synthetic turn). A steer first consumes the
    // interrupted turn's result, then reserves one for its continuation. When
    // this hits zero, any turn still queued
    // can never finalize on its own — see
    // interruptClaudeSdkRun, which uses it to recover instead of interrupting.
    resultsOwed: 0,
    backgroundTasks: new Map(), // task_id -> { taskType, description }
    awaitedBackgroundTaskIds: new Set(), // shells the model waits on (wait_for_background_tasks)
    skipTranscriptTaskIds: new Set(),
    // Native subagents (Agent/Task tool): created lazily on first spawn.
    subagentTracker: null,
    subagentFileRefs: new Map(), // task_id -> { path } (output file, once known)
    // Visible task list (TaskCreate/TaskUpdate/TodoWrite) → plan activity.
    tasks: new Map(), // taskId -> { subject, status }
    pendingTaskToolUses: new Map(), // tool_use id -> { name, input }
    taskToolUseIds: new Set(), // suppress these ids from generic tool rows
    backgroundSettleTimer: null,
    backgroundCheckIn: null, // { timer, delayMs, waitingSince } while awaiting shells
    backgroundRunId: null,
    lastTurnEndSnapshot: null,
    inputQueue,
    abortController,
    query: null,
    stderrTail: '',
    disposed: false,
    ended: false,
    endedPromise,
    resolveEnded,
    // Feeds idle eviction: bumped on every user push and every CLI message,
    // so background-agent chatter counts as activity.
    lastActivityAt: Date.now(),
  };

  session.userInputs = createClaudeInputRequests(session);
  session.pushUserMessage = (text, { expectResult = true, content = [{ type: 'text', text }] } = {}) => {
    if (session.firstPrompt === null) {
      session.firstPrompt = text;
      session.firstContent = content;
    }
    session.lastActivityAt = Date.now();
    if (expectResult) session.resultsOwed += 1;
    inputQueue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    });
  };

  session.start = async () => {
    const [sdk, zod, claudeBinary] = await Promise.all([
      loadClaudeSdk(),
      loadZod(),
      resolveClaudeBinary(),
    ]);
    const orionMcpServer = createOrionMcpServer(sdk, zod, session);
    // setMcpServers replaces every SDK-supplied server, so later syncs must
    // resend this same instance alongside the Orion-connected ones.
    session.orionMcpServer = orionMcpServer;
    const chromeEnabled = 'chrome' in sdkOptions.extraArgs;
    // Headless runs can't show permission prompts, so outside bypass mode the
    // spawn/stop tools must be pre-approved alongside any user-configured
    // allowlist.
    const allowedTools =
      sdkOptions.accessMode === 'full-access'
        ? sdkOptions.allowedTools
        : [
            ...new Set([
              ...sdkOptions.allowedTools,
              ...[
                ...orionBuiltinToolNamesForAccessMode(sdkOptions.accessMode),
                'wait_for_background_tasks',
              ].map((name) => `mcp__orion__${name}`),
            ]),
          ];
    session.query = sdk.query({
      prompt: inputQueue.stream(),
      options: {
        cwd: projectPath,
        model: sdkOptions.model,
        effort: sdkOptions.effort,
        // Servers the user connected to Orion (and enabled or @-mentioned)
        // are trusted like Codex's pre-approved ones; Read only still asks.
        canUseTool: (toolName, toolInput, toolOptions) =>
          sdkOptions.accessMode !== 'read-only' &&
          Object.keys(session.orionMcpServers ?? {}).some((name) =>
            toolName.startsWith(`mcp__${name}__`)
          )
            ? Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
            : session.userInputs.canUseTool(toolName, toolInput, toolOptions),
        includePartialMessages: true,
        // Without this declaration every interrupt kills running background
        // agents/workflows, so steering a turn would silently stop them. Stop
        // still halts everything: it stops each live task explicitly via
        // stopTask and then disposes the session.
        perTaskStopAffordance: true,
        // Match the CLI's behavior: the SDK defaults to a minimal/empty
        // system prompt, which drops Claude Code's narration + progress-update
        // guidance (runs go silent between tool calls without it).
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: [CLAUDE_BACKGROUND_WAIT_TIP, CLAUDE_USER_ACTION_TIP, ...(chromeEnabled ? [CLAUDE_CHROME_BROWSER_TIPS] : [])].join('\n\n'),
        },
        // Match the CLI's behavior: without this the SDK loads no user or
        // project settings — no CLAUDE.md, no skills, no MCP servers.
        settingSources: ['user', 'project', 'local'],
        mcpServers: { orion: orionMcpServer },
        // Refuses long foreground waits, and serializes Claude in Chrome
        // across Orion's Claude threads.
        hooks: mergeClaudeHooks(
          claudeForegroundWaitHooks(),
          chromeEnabled
            ? claudeChromeLeaseHooks(session, {
                emitActivity: (activity) => {
                  const turn = session.activeTurns[0];
                  if (!turn) return;
                  emitAgentEvent(session.sender, {
                    runId: turn.runId, threadId: session.threadId, type: 'activity', activity,
                  });
                },
              })
            : {}
        ),
        ...(sdkOptions.ultracode ? { settings: JSON.stringify({ ultracode: true }) } : {}),
        ...(sdkOptions.accessMode === 'full-access'
          ? { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
          : { permissionMode: sdkOptions.accessMode === 'read-only' ? 'plan' : 'acceptEdits' }),
        ...(allowedTools.length > 0 ? { allowedTools } : {}),
        ...(Object.keys(sdkOptions.extraArgs).length > 0 ? { extraArgs: sdkOptions.extraArgs } : {}),
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        ...(forkSession ? { forkSession: true } : {}),
        ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
        abortController,
        stderr: (data) => {
          session.stderrTail = `${session.stderrTail}${data}`.slice(-2000);
        },
        env: withClaudeEnv({ ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }),
      },
    });
    void pumpClaudeSession(session);
  };

  session.dispose = () => {
    if (session.disposed) return;
    session.disposed = true;
    session.userInputs.cancelAll();
    inputQueue.close();
    try {
      abortController.abort();
    } catch {}
  };

  return session;
};

export const runClaudeSdkTurn = async ({ sender, input, model, runId, initialSnapshot }) => {
  const threadId = input.threadId;
  // A slash command must be the very start of the prompt or the CLI won't
  // expand it, so the ultrathink keyword is skipped for command prompts.
  const prompt =
    input.claudeReasoningEffort === 'ultrathink' && !input.prompt.trimStart().startsWith('/')
      ? `ultrathink\n\n${input.prompt}`
      : input.prompt;

  const content = await claudeUserContent(prompt, input.attachments);

  // The window can close and reopen (macOS keeps the app alive) while
  // sessions persist; a session bound to the old, destroyed webContents would
  // silently drop every event. Rebind to the live renderer on each turn.
  for (const persisted of claudeSdkSessions.values()) {
    if (persisted.sender.isDestroyed()) {
      persisted.sender = sender;
      persisted.createParams.sender = sender;
    }
  }

  const sdkOptions = claudeSdkOptionsForInput(model, input);
  const optionsKey = JSON.stringify([input.projectPath, sdkOptions]);
  const existing = claudeSdkSessions.get(threadId);
  let session =
    existing && !existing.ended && !existing.disposed && existing.optionsKey === optionsKey
      ? existing
      : null;
  if (session) {
    session.sender = sender;
    session.createParams.sender = sender;
    // Claim the session before the startup awaits below (git snapshot): a
    // session idling near the eviction threshold must not be disposed out
    // from under a turn that is about to push into it — the push would land
    // in a closed input queue and the run would never get a terminal event.
    // Synchronous with the selection above, so the sweeper can't interleave.
    session.lastActivityAt = Date.now();
  }

  if (existing && !session) {
    // Model, effort, access mode, or project changed: replace the harness
    // process, resuming the same conversation. Background agents started by
    // the old process do not survive this. Route the old harness through the
    // tracked disposal path so destructive workspace teardown also waits for
    // it after the replacement takes over the thread's active map entry.
    disposeClaudeSdkSession(threadId);
  }

  if (!session) {
    const resumeSessionId =
      existing?.sessionId ??
      (typeof input.resumeSessionId === 'string' && input.resumeSessionId
        ? input.resumeSessionId
        : null);
    // A branched thread's first turn forks the parent session instead of
    // resuming it in place; replacement sessions resume their own id.
    const forkSession = Boolean(input.forkSession) && Boolean(resumeSessionId) && !existing;
    session = createClaudeSdkSession({
      sender,
      threadId,
      projectPath: input.projectPath,
      model,
      input,
      resumeSessionId,
      forkSession,
    });
    claudeSdkSessions.set(threadId, session);
    try {
      await session.start();
    } catch (error) {
      session.dispose();
      if (claudeSdkSessions.get(threadId) === session) claudeSdkSessions.delete(threadId);
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  let mcpErrors;
  try {
    mcpErrors = await syncClaudeOrionMcpServers(session, input.orionMcpServers);
  } catch (error) {
    if (claudeSdkSessions.get(threadId) === session) disposeClaudeSdkSession(threadId);
    else session.dispose();
    return { ok: false, error: error?.message ?? String(error) };
  }
  const failedMcpNames = Object.keys(mcpErrors);
  if (failedMcpNames.length > 0) {
    emitAgentEvent(sender, {
      runId,
      threadId,
      type: 'chunk',
      chunk: `_Could not connect ${failedMcpNames
        .map((name) => `@${name} (${String(mcpErrors[name]).slice(0, 200)})`)
        .join(', ')}._\n\n`,
    });
  }

  // A new foreground instruction supersedes any retained "waiting on
  // background agents" handle. The background work itself remains owned by
  // this persistent session unless the caller explicitly disposes it.
  clearClaudeBackgroundRun(session);
  const snapshot =
    initialSnapshot === undefined
      ? await captureGitChangeSnapshot(input.projectPath)
      : initialSnapshot;
  // A stop/steer raced this startup (session/snapshot awaits above) and
  // aborted the run before its turn was registered anywhere stoppable —
  // honor it instead of pushing a turn the renderer already settled.
  const abortedStart = startingAgentRuns.get(runId);
  if (abortedStart?.aborted) {
    // An explicit Stop (terminateBackground) also means the just-started or
    // reused CLI process must not linger until idle eviction. A steer abort
    // keeps the session — its follow-up turn reuses it moments later. Stop
    // disposes the thread's current session even when it owns background
    // work: terminateBackground explicitly means that work must be aborted.
    if (
      abortedStart.terminateBackground &&
      claudeSdkSessions.get(threadId) === session
    ) {
      disposeClaudeSdkSession(threadId);
    }
    return { ok: true, runId };
  }
  const turn = createClaudeTurnState(runId, snapshot);
  session.activeTurns.push(turn);
  updateClaudeBackgroundSettle(session); // a live turn cancels any pending settle
  emitAgentEvent(sender, {
    runId,
    threadId,
    type: 'started',
    command: `claude --model ${sdkOptions.model} --effort ${sdkOptions.effort} (persistent session)`,
  });
  if (session.sessionId) {
    emitAgentEvent(sender, {
      runId,
      threadId,
      type: 'session',
      providerId: 'claude',
      sessionId: session.sessionId,
    });
  }
  session.pushUserMessage(prompt, { content });
  // Notifications that landed while the thread sat idle (and never re-invoked
  // the model) surface in this turn — the model reads them here anyway.
  flushPendingClaudeTaskNotifications(session, turn);
  return { ok: true, runId };
};

// Steering must redirect a live run immediately. Streaming a second user
// message alone is insufficient: Claude does not consume that input while a
// blocking tool call (notably a delegated Orion subagent) is in flight, which
// leaves the renderer's split continuation bubble waiting indefinitely. End
// the current loop through the SDK control channel, suppress that intermediate
// result boundary, then push the instruction as a continuation owned by the
// same Orion run id.
//
// With only a retained background handle there is no foreground loop to
// interrupt, so open one and use normal result accounting. Returns false when
// the run/session disappears or an interrupt cannot be completed promptly;
// the renderer then preserves the message as an ordinary queued follow-up.
// Open a foreground turn on an idle session that only holds background work
// (retained run id, or none), for input Durango Code pushes on its own.
const openClaudeBackgroundTurn = (session, runId, command) => {
  clearClaudeBackgroundRun(session);
  const turn = createClaudeTurnState(runId, session.lastTurnEndSnapshot);
  session.activeTurns.push(turn);
  updateClaudeBackgroundSettle(session);
  emitAgentEvent(session.sender, {
    runId,
    threadId: session.threadId,
    type: 'started',
    background: true,
    command,
  });
  flushPendingClaudeTaskNotifications(session, turn);
  return turn;
};

export const steerClaudeSdkRun = async (runId, text, attachments) => {
  const content = await claudeUserContent(text, attachments);
  for (const session of claudeSdkSessions.values()) {
    const activeOwner = session.activeTurns.find((turn) => turn.runId === runId);
    const retainedOwner = session.backgroundRunId === runId;
    const ownsRun = Boolean(activeOwner) || retainedOwner;
    if (!ownsRun) continue;
    if (session.ended || session.disposed || !session.query) return false;
    if (activeOwner) {
      session.userInputs?.cancelAll();
      let resolveSteerBoundary;
      const steerBoundary = new Promise((resolve) => {
        resolveSteerBoundary = resolve;
      });
      activeOwner.resolveSteerBoundary = resolveSteerBoundary;
      session.pendingSteerBoundary = activeOwner;
      try {
        await Promise.race([
          session.query.interrupt(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Claude steer interrupt timed out.')), 3000)
          ),
        ]);
      } catch {
        // A natural result can release the owner while the control request is
        // failing or timing out. In that case the hidden boundary already
        // committed and must continue; only fall back while the exact owner
        // is still live, which is a synchronous/atomic check here.
        if (session.activeTurns.includes(activeOwner)) {
          if (session.pendingSteerBoundary === activeOwner) {
            session.pendingSteerBoundary = null;
          }
          activeOwner.resolveSteerBoundary = null;
          return false;
        }
      }

      // The control response can arrive before the interrupted `result` that
      // releases the FIFO owner. The explicit settlement signal makes the
      // timeout atomic with finalize/teardown; polling the array left a race
      // where finalize could suppress the boundary just after a timeout had
      // decided to fall back.
      const boundaryReleased = await Promise.race([
        steerBoundary,
        new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      if (
        boundaryReleased !== true ||
        session.ended ||
        session.disposed ||
        claudeSdkSessions.get(session.threadId) !== session
      ) {
        // Let a late result settle normally if the interrupt acknowledgement
        // did not produce a boundary. The renderer will queue the steer, so
        // no instruction is lost and no empty continuation bubble is opened.
        if (session.pendingSteerBoundary === activeOwner) {
          session.pendingSteerBoundary = null;
        }
        activeOwner.resolveSteerBoundary = null;
        return false;
      }

      const continuation = createClaudeTurnState(runId, activeOwner.snapshot);
      // Changed-file attribution spans both halves of the visible run. Carry
      // explicit tool writes forward because the intermediate boundary was
      // intentionally hidden from the renderer.
      for (const filePath of activeOwner.toolWrittenPaths) {
        continuation.toolWrittenPaths.add(filePath);
      }
      session.pendingSteerBoundary = null;
      session.activeTurns.push(continuation);
      updateClaudeBackgroundSettle(session);
      flushPendingClaudeTaskNotifications(session, continuation);
      session.pushUserMessage(text, { content });
      return true;
    }
    openClaudeBackgroundTurn(session, runId, 'claude — steered background work');
    session.pushUserMessage(text, { content });
    return true;
  }
  return false;
};

// The renderer offers this only after a Claude turn has produced its final
// response while every remaining task is a background shell. Recheck that
// invariant here at click time: task membership may have changed while the
// intervention card was visible, and useful subagents/workflows must never be
// discarded by this narrow action.
export const discardClaudeBackgroundShellTasks = async (runId) => {
  const session = claudeBackgroundRunSessions.get(runId);
  if (!session || session.ended || session.disposed) {
    return { ok: true, alreadySettled: true, tasks: [] };
  }
  if (session.activeTurns.length > 0) {
    return {
      ok: false,
      error: 'Claude has resumed foreground work, so Durango Code left its background tasks alone.',
    };
  }
  const shellTasks = discardableClaudeBackgroundShellTasks(session);
  if (shellTasks.length === 0) {
    if (pendingClaudeBackgroundTasks(session).length === 0) {
      return { ok: true, alreadySettled: true, tasks: [] };
    }
    return {
      ok: false,
      error: 'Claude is now waiting on non-shell work, so Durango Code did not discard it.',
    };
  }

  // Ask Claude Code to stop each exact task first so it can tear down the
  // child process cleanly. Then dispose the now-shell-only persistent runtime
  // to prevent task notifications from starting a synthetic follow-up turn;
  // the next user prompt can still resume from the stored Claude session id.
  await stopClaudeBackgroundTasks(session, shellTasks);
  try {
    await disposeClaudeSdkSessionAndWait(session.threadId);
  } catch {
    // The bounded teardown force-closes and finalizes a wedged query before it
    // throws, so the requested shell discard has still completed locally.
  }
  return {
    ok: true,
    alreadySettled: false,
    tasks: shellTasks.map((task) => task.description),
  };
};

export const interruptClaudeSdkRun = async (runId, { terminateBackground = false } = {}) => {
  for (const session of claudeSdkSessions.values()) {
    if (session.activeTurns.some((turn) => turn.runId === runId)) {
      session.userInputs?.cancelAll();
      // The CLI owes no results: nothing is running, so there is nothing to
      // interrupt and the queued turns can never finalize on their own (a
      // legacy dangling turn, e.g. opened by a task_notification that never
      // re-invoked the model). Drain them as done so the thread un-wedges
      // instead of poisoning the FIFO for every later turn.
      if (session.resultsOwed <= 0) {
        while (session.activeTurns.length > 0) {
          await finalizeClaudeTurn(session, null);
        }
        if (terminateBackground) {
          await disposeClaudeSdkSessionAndWait(session.threadId);
        }
        return true;
      }
      if (terminateBackground) {
        // Explicit Stop: the user wants ALL work halted, including background
        // subagents still mutating the working tree. Ask Claude Code to stop
        // every exact task first, then interrupt the parent and tear down the
        // harness. This mirrors Claude Code/T3 stop-everything semantics while
        // keeping every control acknowledgement bounded.
        await stopClaudeBackgroundTasks(
          session,
          liveClaudeBackgroundTasks(session).map(([taskId, task]) => ({
            taskId,
            description: task.description,
          }))
        );
        try {
          await Promise.race([
            session.query?.interrupt?.(),
            new Promise((resolve) => setTimeout(resolve, 1000)),
          ]);
        } catch {}
        await disposeClaudeSdkSessionAndWait(session.threadId);
        return true;
      }
      // Steer: interrupt the turn in place; the session and any background
      // subagents it spawned keep running. Await the CLI's acknowledgement so
      // the steer's follow-up prompt (pushed right after stopTurn resolves)
      // can't race the interrupt and be swallowed with the aborted turn —
      // but cap the wait so a wedged process can never hang the renderer.
      try {
        await Promise.race([
          session.query?.interrupt?.(),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      } catch {}
      // The in-place interrupt only frees the FIFO for the follow-up turn if
      // the CLI flushes a `result` for the aborted turn (that's what shifts
      // it off activeTurns). When that result never lands — interrupt
      // unsupported by the installed CLI, or the ack raced out — the stale
      // head would swallow every event of the next turn under the dead runId
      // and the steer hangs on "Waiting for the agent to produce output".
      // Wait briefly for the finalize; failing that, degrade to the Stop
      // path's teardown: the follow-up turn resumes the conversation in a
      // fresh process via the stored session id. Costs any background
      // subagents, but only on a session that is already wedged.
      const interrupted = session.activeTurns.find((turn) => turn.runId === runId);
      if (interrupted) {
        const deadline = Date.now() + 3000;
        while (
          session.activeTurns.includes(interrupted) &&
          !session.ended &&
          !session.disposed &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (session.activeTurns.includes(interrupted) && !session.ended && !session.disposed) {
          disposeClaudeSdkSession(session.threadId);
        }
      }
      return true;
    }
  }
  const backgroundSession = claudeBackgroundRunSessions.get(runId);
  if (backgroundSession) {
    clearClaudeBackgroundRun(backgroundSession);
    if (terminateBackground) {
      await stopClaudeBackgroundTasks(
        backgroundSession,
        liveClaudeBackgroundTasks(backgroundSession).map(([taskId, task]) => ({
          taskId,
          description: task.description,
        }))
      );
      await disposeClaudeSdkSessionAndWait(backgroundSession.threadId);
    }
    // With no foreground turn there is nothing to interrupt. Returning true
    // still acknowledges the retained handle; a steer may now push a fresh
    // instruction, while Stop disposes the session above.
    return true;
  }
  return false;
};

export const disposeClaudeSdkSession = (threadId) => {
  const session = claudeSdkSessions.get(threadId);
  if (!session) return false;
  // Remove first so a late pump completion cannot affect a replacement
  // session created for the same thread id.
  claudeSdkSessions.delete(threadId);
  clearClaudeBackgroundRun(session);
  let terminating = terminatingClaudeSdkSessions.get(threadId);
  if (!terminating) {
    terminating = new Set();
    terminatingClaudeSdkSessions.set(threadId, terminating);
  }
  terminating.add(session);
  session.dispose();
  return true;
};

// Workspace removal must not delete a workspace while its persistent Claude process
// is still unwinding after AbortController.abort(). The ordinary disposal API
// stays synchronous for UI/model-switch call sites; destructive workspace
// lifecycle paths use this bounded acknowledgement.
export const disposeClaudeSdkSessionAndWait = async (threadId, timeoutMs = 3000) => {
  const sessions = new Set(terminatingClaudeSdkSessions.get(threadId) ?? []);
  const activeSession = claudeSdkSessions.get(threadId);
  if (activeSession) {
    disposeClaudeSdkSession(threadId);
    sessions.add(activeSession);
  }
  if (sessions.size === 0) return false;
  if ([...sessions].every((session) => session.ended)) return true;

  let timeoutId;
  const ended = await Promise.race([
    Promise.all([...sessions].map((session) => session.endedPromise)).then(() => true),
    new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  if (!ended) {
    // Abort is normally enough to unwind the SDK pump, but a wedged query
    // must not remain in terminatingClaudeSdkSessions forever. Force-close
    // only the sessions captured by this wait, then finalize their local
    // state so a later teardown attempt can make progress. A replacement
    // session added while this wait was pending remains tracked separately.
    for (const session of sessions) {
      if (session.ended) continue;
      try {
        session.query?.close?.();
      } catch {}
      endClaudeSession(session, null);
    }
    throw new Error(`Claude runtime for thread ${threadId} did not stop in time.`);
  }
  return true;
};

export const disposeAllClaudeSdkSessions = () => {
  // Keep every disposed harness in the terminating map until its query
  // acknowledges shutdown. On macOS a new window can open before those
  // acknowledgements arrive, and a workspace removal must still see
  // and wait for sessions owned by the previous window.
  for (const threadId of [...claudeSdkSessions.keys()]) {
    disposeClaudeSdkSession(threadId);
  }
  claudeBackgroundRunSessions.clear();
};

// Each persistent session pins a ~200-450MB CLI process, and threads are
// rarely deleted — without eviction every thread touched since launch keeps
// its process forever. Evict sessions idle past the threshold; the next turn
// cold-starts via --resume with the same conversation. Live agent/workflow
// tasks block eviction. Shell-only monitors do not: after the idle window the
// SDK runtime is torn down, which also prevents forgotten dev servers from
// surviving for hours.
export const CLAUDE_SESSION_IDLE_EVICT_MS = 15 * 60 * 1000;
export const evictIdleClaudeSdkSessions = (now = Date.now()) => {
  for (const session of claudeSdkSessions.values()) {
    if (session.ended || session.disposed) continue;
    if (session.activeTurns.length > 0 || session.resultsOwed > 0) continue;
    if (pendingClaudeBackgroundTasks(session).length > 0) continue;
    if (now - session.lastActivityAt < CLAUDE_SESSION_IDLE_EVICT_MS) continue;
    // dispose() aborts the SDK query; the pump loop then runs
    // endClaudeSession, which removes the session from the map and settles
    // the thread without surfacing an error (disposed sessions end cleanly).
    session.dispose();
  }
};
setInterval(evictIdleClaudeSdkSessions, 60 * 1000);
