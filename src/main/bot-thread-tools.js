import path from 'node:path';
import { dispatchEffort, resolveDispatchModel } from './durango-dispatch.js';

// A bot's Durango Code thread tools, run on this machine (bot-replies.js for
// a Durango bot's reply here, local-bots.js signed out): list available models
// and reasoning efforts, list the threads of this machine's projects, read one,
// send a follow-up (or steer a running turn), and manage any thread
// (settle/archive, unsettle/restore, snooze, unsnooze/wake, pin, unpin, rename,
// configure model/effort/access, branch, stop, delete). A follow-up is an
// ordinary turn in that thread (it runs like a message the person sends), and
// its outcome comes back to the bot's inbox like a task's. Starting new threads
// is delegate_task with `project` (with optional `model`, `effort`, `access_mode`).

export const BOT_THREAD_ACTIONS = [
  'settle',
  'unsettle',
  'snooze',
  'unsnooze',
  'pin',
  'unpin',
  'rename',
  'configure',
  'branch',
  'stop',
  'delete',
];
export const BOT_THREAD_TOOL_NAMES = [
  'list_thread_models',
  'list_threads',
  'read_thread',
  'message_thread',
  'manage_thread',
  'answer_thread_request',
];
// What a bot can do with a thread's "Needs you" request (request_user_action):
// the card's own Done, Reply and dismiss (X) buttons.
export const BOT_REQUEST_ANSWERS = ['done', 'reply', 'dismiss'];
export const BOT_THREAD_ACCESS_MODES = ['read-only', 'workspace-write', 'full-access'];

const EFFORT_FIELD_BY_PROVIDER = {
  claude: 'claudeReasoningEffort',
  codex: 'codexReasoningEffort',
  antigravity: 'antigravityReasoningEffort',
  grok: 'grokReasoningEffort',
  muse: 'museReasoningEffort',
  opencode: 'openCodeReasoningEffort',
};

/** The active reasoning effort stored on a thread/shell for its current model's provider, or null. */
export const threadActiveEffort = (thread) => {
  const modelId = typeof thread?.modelId === 'string' ? thread.modelId : '';
  const provider = modelId.includes(':') ? modelId.slice(0, modelId.indexOf(':')) : '';
  const field = EFFORT_FIELD_BY_PROVIDER[provider];
  const value = field ? thread?.[field] : null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/** Cloud-style Anthropic model id ("anthropic/claude-opus-5.5") → Claude Code slug ("claude-opus-5-5"). */
const cloudClaudeSlug = (value) => {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw.startsWith('anthropic/')) return null;
  const slug = raw.slice('anthropic/'.length).replace(/\./g, '-');
  return /^claude-[a-z0-9-]{2,60}$/.test(slug) ? slug : null;
};

/**
 * Resolve and validate thread settings (model, reasoning effort, access mode,
 * provider-specific options) against this machine's available agent models.
 * Returns `{ ok: true, modelId, reasoningEffort, accessMode, codexServiceTier,
 * claudeContextWindow, model }` or `{ ok: false, error }`.
 */
export const resolveThreadModelChoice = ({
  model,
  effort,
  currentModelId = null,
  models = [],
  machineName = 'this computer',
  accessMode,
  codexServiceTier,
  claudeContextWindow,
} = {}) => {
  const catalog = Array.isArray(models) ? models : [];
  const wantedModel = String(model ?? '').trim();
  const rawEffort = String(effort ?? '').trim();
  let resolvedModel = null;
  let modelId = null;

  if (wantedModel) {
    if (catalog.length > 0) {
      let resolved = resolveDispatchModel(wantedModel, catalog, machineName);
      if (!resolved.ok) {
        const alias = cloudClaudeSlug(wantedModel);
        if (alias) resolved = resolveDispatchModel(alias, catalog, machineName);
      }
      if (!resolved.ok) return { ok: false, error: resolved.error };
      resolvedModel = resolved.model;
      modelId = resolved.model?.id ?? null;
    } else {
      modelId = wantedModel;
    }
  }

  let reasoningEffort = null;
  if (rawEffort) {
    const targetModel =
      resolvedModel ??
      (currentModelId && catalog.length > 0
        ? catalog.find((candidate) => candidate.id === currentModelId) ?? null
        : null);
    const normalized = dispatchEffort(rawEffort, targetModel);
    if (targetModel) {
      const efforts = Array.isArray(targetModel.efforts) ? targetModel.efforts : [];
      if (!normalized || !efforts.includes(normalized)) {
        const label = targetModel.label || targetModel.id;
        return {
          ok: false,
          error:
            efforts.length > 0
              ? `${label} takes effort ${efforts.join(', ')}, not "${rawEffort}".`
              : `${label} has no effort setting; leave effort out.`,
        };
      }
    }
    reasoningEffort = normalized;
  }

  let normalizedAccessMode = null;
  if (accessMode !== undefined && accessMode !== null && String(accessMode).trim() !== '') {
    const candidate = String(accessMode).trim().toLowerCase();
    if (!BOT_THREAD_ACCESS_MODES.includes(candidate)) {
      return {
        ok: false,
        error: `Unsupported access_mode "${accessMode}". Use one of: ${BOT_THREAD_ACCESS_MODES.join(', ')}.`,
      };
    }
    normalizedAccessMode = candidate;
  }

  let normalizedTier = null;
  if (codexServiceTier !== undefined && codexServiceTier !== null && String(codexServiceTier).trim() !== '') {
    const candidate = String(codexServiceTier).trim().toLowerCase();
    if (candidate !== 'default' && candidate !== 'priority') {
      return { ok: false, error: `Unsupported codex_service_tier "${codexServiceTier}". Use "default" or "priority".` };
    }
    normalizedTier = candidate;
  }

  let normalizedContext = null;
  if (claudeContextWindow !== undefined && claudeContextWindow !== null && String(claudeContextWindow).trim() !== '') {
    const candidate = String(claudeContextWindow).trim().toLowerCase();
    if (candidate !== '200k' && candidate !== '1m') {
      return { ok: false, error: `Unsupported claude_context_window "${claudeContextWindow}". Use "200k" or "1m".` };
    }
    normalizedContext = candidate;
  }

  return {
    ok: true,
    modelId,
    reasoningEffort,
    accessMode: normalizedAccessMode,
    codexServiceTier: normalizedTier,
    claudeContextWindow: normalizedContext,
    model: resolvedModel,
  };
};

/**
 * How a bot manages and settles Durango Code threads (manage_thread): in every
 * bot's instructions (local-bots.js, bot-replies.js); Durango's copy is in
 * chat/andromedus/lib/bots/prompt.ts ("Managing and settling threads").
 */
export const BOT_SETTLE_RULE = `Managing and settling threads (manage_thread): you can manage any Durango Code thread — ones you started, ones other bots started, or the person's own — to settle (archive), unsettle (restore), snooze, unsnooze (wake), pin, unpin, rename, configure (change model, reasoning effort, or access mode), branch (fork a copy to try another direction), stop a running turn, or delete it. You can also steer a running thread mid-turn with message_thread (\`steer: true\`), or switch its model/effort on a follow-up, and check available models and effort levels with list_thread_models.
- Settling on your own: a Durango Code thread stays in the person's sidebar until it is settled. Settle a thread you started yourself (manage_thread with action "settle") only when you judge its work truly finished from what it reports: the change landed or merged, the release went out, the question was answered and nothing is left to do. Leave it unsettled while it is still running or waiting on something (a watcher, a deploy, a long run), while a change is open for review, when it asks the person something or needs their input, or when you aren't sure: "done" in a report alone doesn't mean finished.
- Any thread and other actions: you may settle, unsettle (restore), snooze, unsnooze (wake), pin, unpin, rename, configure, branch or stop any thread — including threads you didn't start — when the person asks or when it clearly follows from what they asked. Settling only files a thread away (a new message brings it back); it never stops or deletes anything.
- Deleting: deleting a thread is permanent and cannot be undone. Only use action "delete" when the person explicitly asks you to delete a thread — never on your own.`;

// What a bot sends the thread that made a change when the person asks to
// ship it (land, deploy, merge, release). How a project ships is its own (the
// code may live on GitHub rather than Durango Source, it may deploy through a
// website, it may need Convex before the web app, migrations or seeding), and
// the thread that did the work knows it. A Ship button on a bot's reply sends
// this too (message_thread to the change's thread).
export const SHIP_VIA_THREAD_MESSAGE =
  "Ship this change now, following this project's own process for shipping it (where the code lives, how it lands, the deploy order, migrations or seeding, anything else this project needs). Report what was landed, what was deployed, and how you verified it.";

// The bots' rule for shipping, in every bot's instructions (local-bots.js;
// Durango's own copy is in chat/andromedus/lib/bots/prompt.ts).
/**
 * How a bot briefs a Durango Code thread (local bots' prompt, and a Durango
 * bot's reply on this machine, bot-replies.js). Durango's copy: BOT_PROMPT
 * "Briefing threads", chat/andromedus/lib/bots/prompt.ts.
 */
export const BOT_BRIEF_RULE = `Briefing a Durango Code thread (delegate_task with \`project\`, or a follow-up with message_thread): check \`project_notes\` first when project conventions, decisions, or preferences may affect your brief or approach (notes aren't pasted into your prompt; also check before \`remember_project\` to avoid duplicates). The thread itself is a capable engineer that reads the project (its code, AGENTS.md, and the project's notes through its project_notes tool) and plans its own work. Keep the brief short and goal-level: what to solve and why, plus only what it can't find on its own (what the person asked for and decided, constraints, ids, links, error text, where earlier work stands). Leave the how to it: no numbered requirement lists, step-by-step plans or file-by-file edits, and don't repeat the project's own rules or process. A few sentences is usually enough; add detail only where the person was specific.`;

export const BOT_SHIPPING_RULE = `Shipping (land, ship, deploy, merge, release, publish): the Durango Code thread that made a change ships it, not you. How a project ships is its own (its code may live on GitHub rather than Durango Source, it may deploy through a website, it may need an order such as Convex before the web app, migrations or seeding), and that thread has the context; you usually don't. So when the person asks to ship something, find the thread that did the work (the thread id in its task report, or list_threads and read_thread in that project) and send it the request with message_thread, e.g. "${SHIP_VIA_THREAD_MESSAGE}" Then tell the person what it reports (what landed, what deployed, how it was checked). Only when there is no such thread (deleted, or the work wasn't done in one) start a new thread in that project with delegate_task to ship it, with the change id and what it can't find on its own. Don't land or deploy it yourself (the durango-code CLI, git, provider CLIs) unless the person explicitly tells you to do it yourself. Shipping is public and hard to undo: confirm with the person first unless they already asked you to ship it.`;

/**
 * How a bot handles a thread's "Needs you" request (request_user_action: sign
 * in somewhere, approve something, plug something in) when the person answers
 * it to the bot instead of on the card. Durango's copy: BOT_PROMPT "Needs you
 * requests", chat/andromedus/lib/bots/prompt.ts.
 */
export const BOT_THREAD_REQUEST_RULE = `"Needs you" requests: a Durango Code thread that needs the person to do something only they can (sign in in a browser, approve a prompt, plug in a device) pins a request card on the thread and waits on it; its report or notice gives the request id (ua_…), and list_threads / read_thread show a thread's pending requests. When the person tells you they did it ("done", "signed in"), press Done for them: answer_thread_request with answer "done" (and the request id when the thread has more than one). When they answer it some other way (it's wrong, they can't, they want something else), use answer "reply" with what they said. Use "dismiss" only when the request no longer applies and the thread needn't hear about it. The thread then carries on exactly as if the person had clicked the button. A message_thread (or steer) to a thread waiting on a request goes to it as a reply too, but only press Done when the person said it's done. Never answer one on your own guess; a secret request (an API key, password, code) can only be answered by the person on its card.`;

/**
 * The line a thread's report to a bot ends with: which thread it was, so the
 * bot can follow up there (message_thread), e.g. to ship the change.
 */
// `cloud`: the bot is a Durango one, whose replies may also run in the cloud
// (where a follow-up is delegate_task with thread_id; Durango's own copy is
// threadReportFooter in chat/convex/botPolicy.ts).
export const threadReportFooter = ({ threadId, project, machine, cloud = false } = {}) => {
  const id = String(threadId ?? '').trim();
  if (!id) return '';
  const where = [project ? `project ${project}` : null, machine ? `on ${machine}` : null].filter(Boolean).join(', ');
  const how = cloud ? `message_thread thread_id "${id}", or delegate_task thread_id "${id}" from the cloud` : `message_thread thread_id "${id}"`;
  return `(Durango Code thread ${id}${where ? `, ${where}` : ''}. Follow up there, e.g. to ship it, with ${how}.)`;
};

/** A thread's report with its footer (threadReportFooter) after it. */
export const withThreadReportFooter = (report, thread) => {
  const footer = threadReportFooter(thread);
  const text = String(report ?? '').trim();
  return footer ? (text ? `${text}\n\n${footer}` : footer) : text;
};

/**
 * A thread's report to a bot when its turn ended but its work didn't: it is
 * still waiting on background work (or on the person), and reports again
 * once it resumes and finishes. Durango's own copy: threadReportText in
 * chat/convex/botPolicy.ts.
 * `later`: a report after an earlier one (the thread resumed on its own, or
 * the work it waited on ended).
 */
export const threadReportText = ({ summary, waiting, later = false } = {}) => {
  const text = String(summary ?? '').trim();
  const list = (Array.isArray(waiting) ? waiting : []).map((item) => String(item ?? '').trim()).filter(Boolean);
  if (list.length) {
    return [
      `NOT FINISHED YET: the thread ended its turn but still has work pending: ${list.join('; ')}. When that ends it resumes by itself and reports again (a command it left running on purpose, like a dev server, may just keep running). Don't treat this as its final report.`,
      text ? `What it said so far:\n\n${text}` : '',
    ].filter(Boolean).join('\n\n');
  }
  return later ? `A later report from the thread, after its earlier one:\n\n${text}` : text;
};

/**
 * What a bot hears from a thread it started that is still running: it is
 * blocked on the person (`input`: an approval, a question, an action), or it
 * went quiet with nothing of its own to wait on (`stuck`). Durango's own copy:
 * threadNoticeText in chat/convex/botPolicy.ts.
 */
export const threadNoticeText = (title, kind, detail) => {
  const name = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Durango Code thread';
  const head =
    kind === 'input'
      ? `NEEDS THE PERSON: the task "${name}" is blocked: its thread is waiting for the person and does nothing until they answer. Tell the person now, in your reply, what it's waiting for; they answer it in that thread in Durango Code, or tell you. For a request with an id (ua_…), when they tell you they did it, mark it done yourself with answer_thread_request (answer "done"; "reply" with what they said otherwise). This isn't its report: it reports when its work ends.`
      : `LOOKS STUCK: the task "${name}" is still running but has shown no progress for a while, and it isn't waiting on anything it started itself (a command, a subagent, a background wait). Check before you assume it hung (read the thread, or send it a message), and tell the person if it needs them. This isn't its report.`;
  const body = String(detail ?? '').trim();
  return body ? `${head}\n\n${body}` : head;
};

const clipText = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

/**
 * Title inside `Task: <title>` for a non-bot-dispatched turn in a bot-started
 * thread (Ship button or the person typing in the thread). Durango's copy:
 * chat/convex/botPolicy.ts botThreadTurnTitle.
 */
export const botThreadTurnTitle = (trigger, threadTitle, changeId) => {
  const title = clipText(threadTitle, 60);
  if (trigger === 'ship_button') {
    const change = String(changeId ?? '').trim();
    return title ? `Ship button — ${title}` : change ? `Ship button (${change})` : 'Ship button';
  }
  return title ? `Person in thread — ${title}` : 'Person in thread';
};

const botThreadTurnActor = (trigger, { threadTitle, changeId, surface } = {}) => {
  const title = clipText(threadTitle, 120) || 'Durango Code thread';
  if (trigger === 'ship_button') {
    const change = String(changeId ?? '').trim();
    return `The person tapped the Ship button${change ? ` for ${change}` : ''} in the thread "${title}" you started (not your own request).`;
  }
  const cleanSurface = String(surface ?? '').replace(/\s+/g, ' ').trim();
  const via = cleanSurface && cleanSurface.toLowerCase() !== 'desktop' ? ` (via ${clipText(cleanSurface, 60)})` : '';
  return `The person sent a message directly in the thread "${title}" you started${via} (not your own request).`;
};

/**
 * Report body for a non-bot-dispatched turn in a bot-started thread.
 * Durango's copy: chat/convex/botPolicy.ts botThreadTurnReportText.
 */
export const botThreadTurnReportText = ({
  trigger,
  status,
  report,
  threadTitle,
  changeId,
  surface,
  promptPreview,
  waiting = [],
  later = false,
} = {}) => {
  const stillWaiting = status === 'done' && Array.isArray(waiting) && waiting.length > 0;
  const actor = botThreadTurnActor(trigger, { threadTitle, changeId, surface });
  const preview = trigger === 'person' ? clipText(promptPreview, 240) : '';
  const asked = preview ? `\nWhat they asked: "${preview}"` : '';
  const verb = status === 'done' ? 'finished' : 'failed';
  const header = stillWaiting
    ? `${actor} That turn isn't finished yet: the thread ended a turn but is still working in the background.${asked}\nIts update:`
    : later
      ? `${actor} The thread reported again after its earlier update: it has now ${verb}.${asked}\nIts report:`
      : `${actor} That turn ${verb}.${asked}\nIts report:`;
  const body = threadReportText({
    summary: String(report ?? '').trim() || 'The thread finished without a written summary.',
    waiting: stillWaiting ? waiting : [],
  });
  return `${header}\n\n${body}`;
};

/**
 * Notice body while a person- or Ship-button-started turn in a bot-started
 * thread still runs and needs the person or looks stuck.
 * Durango's copy: chat/convex/botPolicy.ts botThreadTurnNoticeText.
 */
export const botThreadTurnNoticeText = ({ trigger, kind, detail, threadTitle, changeId, surface } = {}) => {
  const title = clipText(threadTitle, 120) || 'Durango Code thread';
  const cleanSurface = String(surface ?? '').replace(/\s+/g, ' ').trim();
  const via = cleanSurface && cleanSurface.toLowerCase() !== 'desktop' ? ` (via ${clipText(cleanSurface, 60)})` : '';
  const change = String(changeId ?? '').trim();
  const from =
    trigger === 'ship_button'
      ? `the person's Ship button${change ? ` for ${change}` : ''}`
      : `a message the person sent in the thread${via}`;
  const head =
    kind === 'input'
      ? `NEEDS THE PERSON: the thread "${title}" (from ${from}, not your own request) is blocked: its thread is waiting for the person and does nothing until they answer. Tell the person now, in your reply, what it's waiting for; they answer it in that thread in Durango Code, or tell you. For a request with an id (ua_…), when they tell you they did it, mark it done yourself with answer_thread_request (answer "done"; "reply" with what they said otherwise). This isn't its report: it reports when its work ends.`
      : `LOOKS STUCK: the thread "${title}" (from ${from}, not your own request) is still running but has shown no progress for a while, and it isn't waiting on anything it started itself (a command, a subagent, a background wait). Check before you assume it hung (read the thread, or send it a message), and tell the person if it needs them. This isn't its report.`;
  const body = String(detail ?? '').trim();
  return body ? `${head}\n\n${body}` : head;
};

export const botThreadTurnMessageId = (threadId, seq) => {
  const safe = String(threadId ?? '').trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'thread';
  return `btt_${safe}_${seq}`;
};

export const botThreadTurnNoticeId = (threadId, key) => {
  const safe = String(threadId ?? '').trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'thread';
  return `btt_${safe}_n_${key}`;
};

const MAX_LISTED = 40;
const MAX_MODELS_LISTED = 200;

export const BOT_THREAD_TOOLS = [
  {
    name: 'list_thread_models',
    description:
      'List the Durango Code agent models available on this computer (Claude, Codex, Antigravity/Gemini, Grok, Muse, OpenCode…) with each model\'s exact `id`, `label`, `provider`, and supported reasoning `efforts`. Use these ids and efforts with delegate_task (`project`), message_thread, or manage_thread (`action: "configure"`).',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', maxLength: 60, description: 'Filter by provider (e.g. "claude", "codex", "antigravity", "grok", "muse", "opencode").' },
        search: { type: 'string', maxLength: 120, description: 'Filter by substring in model id, label or provider (e.g. "gemini", "neon", "opus").' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_MODELS_LISTED, description: `How many (default 60, at most ${MAX_MODELS_LISTED}).` },
      },
    },
  },
  {
    name: 'list_threads',
    description:
      "List Durango Code threads on this computer, newest first: the threads in the person's sidebar, their own and the ones bots started. Filter by project (name) or sidebar state (active, settled, snoozed, pinned) to see where a project stands; each has its id, title, project, status (running, idle, error…), model, reasoning effort, accessMode, sidebar flags (settled, snoozed, pinned), last activity, and `needsYou`: the \"Needs you\" requests it waits on the person for (answer them with answer_thread_request). Subagent threads (ones a thread spawned, e.g. reviews) aren't in the sidebar and aren't listed: their parent shows how many it has (`subagents`); they come and go with it, so there's nothing to settle there. Pass include_subagents to list them too (each with its parentThreadId).",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', maxLength: 200, description: 'Only threads in this project (by name). Omit for all projects.' },
        state: {
          type: 'string',
          enum: ['all', 'active', 'settled', 'snoozed', 'pinned'],
          description: 'Filter by sidebar state (default "all"). "active" excludes settled and snoozed threads.',
        },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LISTED, description: `How many (default 15, at most ${MAX_LISTED}).` },
        include_subagents: {
          type: 'boolean',
          description: 'Also list subagent threads (default false), each with its parentThreadId; they follow their parent\'s sidebar state.',
        },
      },
    },
  },
  {
    name: 'read_thread',
    description:
      "Read a Durango Code thread's transcript (by id from list_threads or a task report): what was asked, what the agent did, changed files and its final answer, plus `needsYou`: the \"Needs you\" requests it waits on the person for. Long threads come in pages: pass offset to read more.",
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', minLength: 1, maxLength: 200 },
        offset: { type: 'integer', minimum: 0, description: 'Message offset (see the page header).' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['thread_id'],
    },
  },
  {
    name: 'message_thread',
    description:
      "Send a follow-up message into an existing Durango Code thread on this computer (by id, from list_threads or a task report), as the person would: e.g. answer its question, ask for a fix, tell it to continue or wrap up. Also how you ship a change (land, deploy, merge, release): message the thread that made it and let it ship the change the way its project ships, rather than landing or deploying it yourself. Optionally pass `model`, `effort`, or `access_mode` to switch the thread's settings before running the turn (ids and efforts from list_thread_models). Don't send a normal follow-up to a thread that is running right now — pass `steer: true` to steer a running turn mid-flight instead (without changing model/effort/access_mode). A thread waiting on a \"Needs you\" request takes the message as the person's reply to it (no new turn or task); to press Done on it, use answer_thread_request.",
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', minLength: 1, maxLength: 200 },
        message: { type: 'string', minLength: 1, maxLength: 16_000, description: 'What you need and why, plus anything the thread can\'t see (what the person said). It has its own context: don\'t repeat it or spell out steps.' },
        title: { type: 'string', maxLength: 80, description: 'Short title for the follow-up as a task, e.g. "Fix the failing test".' },
        model: { type: 'string', maxLength: 120, description: 'Optional Durango Code model id, slug or label (from list_thread_models) to switch this thread to before running the turn.' },
        effort: { type: 'string', maxLength: 40, description: 'Optional reasoning effort level supported by the model (from list_thread_models, e.g. "low", "medium", "high", "xhigh", "max").' },
        access_mode: { type: 'string', enum: BOT_THREAD_ACCESS_MODES, description: 'Optional access mode for this turn ("read-only", "workspace-write", "full-access").' },
        steer: { type: 'boolean', description: 'Set true to steer a currently running turn in this thread mid-flight instead of starting a new turn.' },
      },
      required: ['thread_id', 'message'],
    },
  },
  {
    name: 'manage_thread',
    description:
      "Manage any Durango Code thread on this computer (by id, from list_threads or a task report) — whether started by a bot or by the person: settle (archive), unsettle (restore/unarchive), snooze, unsnooze (wake), pin, unpin, rename (with `title`), configure (change `model`, `effort`, `access_mode`, `codex_service_tier`, or `claude_context_window` without sending a message), branch (fork a copy of the thread and return the new thread's id), stop (stop a running turn), or delete (permanent — requires the full thread_id, and only when the person explicitly asks). Cannot settle or configure a thread while a turn is running.",
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', minLength: 1, maxLength: 200, description: 'Thread id (full id required for action "delete").' },
        action: {
          type: 'string',
          enum: BOT_THREAD_ACTIONS,
          description:
            'What to do: "settle" (archive to Settled), "unsettle" (restore to sidebar), "snooze", "unsnooze" (wake), "pin", "unpin", "rename" (requires `title`), "configure" (change `model`, `effort`, `access_mode`, `codex_service_tier` or `claude_context_window`), "branch" (fork the thread into a new thread), "stop" (stop a running turn), or "delete" (permanent; requires the full thread_id, and only when explicitly asked).',
        },
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'New thread title (required for action "rename").' },
        model: { type: 'string', maxLength: 120, description: 'New Durango Code model id, slug or label from list_thread_models (for action "configure").' },
        effort: { type: 'string', maxLength: 40, description: 'New reasoning effort level supported by the model (for action "configure").' },
        access_mode: { type: 'string', enum: BOT_THREAD_ACCESS_MODES, description: 'New access mode (for action "configure").' },
        codex_service_tier: { type: 'string', enum: ['default', 'priority'], description: 'Codex service tier (for action "configure" on a Codex thread).' },
        claude_context_window: { type: 'string', enum: ['200k', '1m'], description: 'Claude context window (for action "configure" on a Claude thread).' },
        reason: { type: 'string', maxLength: 300, description: 'Optional short note on why (e.g. "change landed and deployed").' },
      },
      required: ['thread_id', 'action'],
    },
  },
  {
    name: 'answer_thread_request',
    description:
      "Answer a Durango Code thread's \"Needs you\" request for the person (a request card the thread pinned, e.g. sign in somewhere, approve a prompt): exactly what the card's buttons do, and the thread carries on as if the person had clicked. answer \"done\" when the person told you they did it; \"reply\" with `reply` when they answered it another way (it's wrong, they can't, they want something else); \"dismiss\" when it no longer applies (the thread isn't told). The request id (ua_…) is in the thread's report or notice, and list_threads / read_thread show pending requests; leave request_id out when the thread has only one. Only on the person's word: never mark a request done on your own guess. Secret requests (keys, passwords, codes) are only answered by the person on the card.",
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', minLength: 1, maxLength: 200 },
        request_id: { type: 'string', maxLength: 80, description: 'The request id (ua_…); optional when the thread has only one pending request.' },
        answer: { type: 'string', enum: BOT_REQUEST_ANSWERS, description: '"done" (the person did it), "reply" (with `reply`), or "dismiss" (no longer needed).' },
        reply: { type: 'string', maxLength: 8_000, description: 'For answer "reply": what the person said, as it should reach the thread.' },
      },
      required: ['thread_id', 'answer'],
    },
  },
];

const projectKey = (value) => String(value ?? '').trim().toLowerCase();

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

const ACTION_NOTES = {
  settle: 'Settled: it moved to Settled in the sidebar; a new message brings it back.',
  unsettle: 'Restored: it is back in the sidebar.',
  snooze: 'Snoozed: it left the sidebar until its run finishes or it is woken.',
  unsnooze: 'Woken: it is back in the sidebar.',
  pin: 'Pinned to the top of the sidebar.',
  unpin: 'Unpinned from the sidebar.',
  rename: 'Renamed the thread.',
  configure: 'Updated the thread settings.',
  branch: 'Branched the thread into a new copy.',
  stop: 'Stopped the running turn on that thread.',
  delete: 'Deleted the thread.',
};

const entrySidebarFlags = (entry) => {
  const settledAt = entry?.shell?.settledAt ?? entry?.settledAt ?? null;
  const snoozedAt = entry?.shell?.snoozedAt ?? entry?.snoozedAt ?? null;
  const pinnedAt = entry?.shell?.pinnedAt ?? entry?.pinnedAt ?? null;
  return {
    settled: Boolean(settledAt),
    snoozed: Boolean(snoozedAt && !settledAt),
    pinned: Boolean(pinnedAt),
  };
};

/**
 * Which index entries the sidebar lists, the same rule as the renderer's
 * (App.tsx childThreadIds and sidebarV2ThreadLists): a thread whose parent
 * thread is here (a spawn_subagent child, a provider's own subagent) is
 * hidden under it, and a blank draft (no messages, not running, never filed)
 * isn't shown until it is used. A child whose parent is gone shows on its own.
 * Returns `root(entry)`: the listed thread an entry sits under (itself when
 * it is listed), or null for a blank draft.
 */
// A provider's own subagent (a Claude Task/Explore run, a Codex subagent): its
// transcript is read-only inside its parent's session. The index's top-level
// `subagent` is only `true` for an old shape; its shell has the details object.
export const isProviderSubagent = (entry) => entry?.subagent === true || Boolean(entry?.shell?.subagent);

export const sidebarThreadRoots = (entries) => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const parentOf = (entry) => entry?.parentThreadId ?? entry?.shell?.parentThreadId ?? null;
  const rootOf = (entry) => {
    let root = entry;
    const seen = new Set([root.id]);
    for (let parent = byId.get(parentOf(root)); parent && !seen.has(parent.id); parent = byId.get(parentOf(root))) {
      seen.add(parent.id);
      root = parent;
    }
    return root;
  };
  const isBlankDraft = (entry) => {
    if (entry.messageCount !== 0 || entry.status === 'running') return false;
    const flags = entrySidebarFlags(entry);
    return !flags.settled && !flags.snoozed && !flags.pinned && entry.modelId !== CLAUDE_CODE_CLI_MODEL_ID;
  };
  return (entry) => {
    const root = rootOf(entry);
    // Its own parent (a self-cycle): the sidebar hides it like any child.
    if (root === entry && byId.has(parentOf(entry))) return null;
    return isBlankDraft(root) ? null : root;
  };
};

const REQUEST_TEXT_MAX = 400;
const clipRequest = (text) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > REQUEST_TEXT_MAX ? `${line.slice(0, REQUEST_TEXT_MAX - 1)}…` : line;
};

/** A pending request as a bot sees it: id, what it asks, its page, and the subagent thread that asked (when not the thread itself). */
const publicRequest = (action, threadId) => ({
  id: action.id,
  action: clipRequest(action.action),
  ...(typeof action.url === 'string' && action.url ? { url: action.url } : {}),
  ...(action.threadId && action.threadId !== threadId ? { threadId: action.threadId } : {}),
});

/**
 * A thread's pending "Needs you" requests (request_user_action) in the saved
 * index: its own and its subagents' (its card shows both, as the renderer's
 * pendingUserActions). `requests` are the ones a bot can answer; `secretIds`
 * are request_secret cards, which only the person answers.
 */
export const indexThreadRequests = (entries, threadId) => {
  const list = Array.isArray(entries) ? entries : [];
  const children = new Map();
  for (const entry of list) {
    const parent = entry?.parentThreadId ?? entry?.shell?.parentThreadId ?? null;
    if (!parent) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(entry);
  }
  const byId = new Map(list.map((entry) => [entry?.id, entry]));
  const requests = [];
  const secretIds = [];
  const seen = new Set();
  const queue = byId.has(threadId) ? [byId.get(threadId)] : [];
  while (queue.length) {
    const entry = queue.shift();
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const actions = entry.shell?.userActions ?? entry.userActions;
    for (const action of Array.isArray(actions) ? actions : []) {
      if (!action || typeof action.id !== 'string' || !action.id) continue;
      if (action.secret) secretIds.push(action.id);
      else if (typeof action.action === 'string') requests.push(publicRequest({ ...action, threadId: entry.id }, threadId));
    }
    queue.push(...(children.get(entry.id) ?? []));
  }
  return { requests, secretIds };
};

const requestList = (requests) => requests.map((request) => `${request.id} ("${request.action.slice(0, 120)}")`).join('; ');

const REQUEST_ANSWER_NOTES = {
  done: 'Marked done for the person, as their Done button would: the thread is told and carries on.',
  reply: "Sent as the person's reply to it, as their Reply button would: the thread reads it and carries on.",
  dismiss: "Dismissed, as the card's X would: the card is gone and the thread isn't told.",
};

// agentCatalog.ts claudeCodeCliModelId: a CLI thread keeps its conversation
// in the terminal, so the sidebar always shows it.
const CLAUDE_CODE_CLI_MODEL_ID = 'claude:claude-code-cli';

/**
 * deps:
 * - readIndex(): { entries } (thread-storage.js readThreadsIndex)
 * - readThread(args): transcript page text (thread-reader.js readThreadForAgent)
 * - getProjects(): this machine's projects the bot may use ([{ id, name, path }])
 * - listModels(): available agent models on this computer ([{ id, label, slug?, providerId?, provider, efforts, available }])
 * - liveStatus(threadId): the renderer's status for a thread now, or null (optional)
 * - manageThread({ threadId, action, title?, modelId?, reasoningEffort?, accessMode?, codexServiceTier?, claudeContextWindow? }):
 *   runs a thread action on any thread here → { ok, threadId?, threadTitle?, modelId?, reasoningEffort?, accessMode?, mirrored?, error? }
 * - settleThread(threadId): legacy fallback for settle only when manageThread is omitted
 * - threadTurnState(threadId): the renderer's live view of a thread → { ok, running, requests: [{ id, action, url?, threadId? }],
 *   secretIds } (optional: without it, or when it fails, the saved index and liveStatus stand in)
 * - answerRequest({ threadId, actionId, op: 'done' | 'reply' | 'dismiss', reply?, botName? }): presses that button on
 *   a thread's "Needs you" card → { ok, error? } (answer_thread_request)
 */
export const createBotThreadTools = ({
  readIndex,
  readThread,
  getProjects,
  listModels = null,
  liveStatus = () => null,
  manageThread = null,
  settleThread = null,
  threadTurnState = null,
  answerRequest = null,
}) => {
  const projectsById = async () => {
    const list = (await Promise.resolve(getProjects()).catch(() => [])) ?? [];
    return new Map(list.filter((project) => project && typeof project.id === 'string').map((project) => [project.id, project]));
  };

  const loadModels = async () => {
    if (typeof listModels !== 'function') return [];
    const list = (await Promise.resolve(listModels()).catch(() => [])) ?? [];
    return Array.isArray(list) ? list : [];
  };

  /** The thread (by exact id, or a unique prefix unless `exact`) if it belongs to an allowed project. */
  const findThread = async (rawId, { exact = false } = {}) => {
    const id = String(rawId ?? '').trim();
    if (!id) throw new Error('thread_id is required.');
    const [{ entries }, projects] = await Promise.all([readIndex(), projectsById()]);
    const visible = entries.filter((entry) => !isProviderSubagent(entry) && projects.has(entry.projectId));
    const matches = visible.filter((entry) => entry.id === id);
    const found = matches.length || exact ? matches : visible.filter((entry) => entry.id.startsWith(id));
    if (found.length !== 1) {
      throw new Error(found.length ? `"${id}" matches several threads: use the full id.` : `No thread "${id}" in this computer's projects.`);
    }
    return { entry: found[0], project: projects.get(found[0].projectId) };
  };

  /**
   * Whether a thread runs a turn now, and the "Needs you" requests it waits
   * on: the renderer's live state, or the saved index when that isn't there.
   */
  const turnState = async (entry) => {
    const live = typeof threadTurnState === 'function' ? await Promise.resolve(threadTurnState(entry.id)).catch(() => null) : null;
    if (live?.ok) {
      const requests = (Array.isArray(live.requests) ? live.requests : [])
        .filter((request) => request && typeof request.id === 'string' && request.id && typeof request.action === 'string')
        .map((request) => publicRequest(request, entry.id));
      const secretIds = (Array.isArray(live.secretIds) ? live.secretIds : []).filter((id) => typeof id === 'string');
      return { running: live.running === true, requests, secretIds };
    }
    const { entries } = await readIndex();
    return { running: (liveStatus(entry.id) ?? entry.status) === 'running', ...indexThreadRequests(entries, entry.id) };
  };

  const pressRequest = async ({ entry, request, op, reply, botName }) => {
    if (typeof answerRequest !== 'function') return { ok: false, error: 'Answering thread requests is not available here.' };
    return Promise.resolve(
      answerRequest({ threadId: entry.id, actionId: request.id, op, ...(op === 'reply' ? { reply } : {}), botName })
    ).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
  };

  /**
   * answer_thread_request: Done, Reply or dismiss on a thread's "Needs you"
   * card, for the person. `exact`: the full thread id only (a request queued
   * on Durango). `botName`: shown to the thread with the answer.
   */
  const answer = async (input = {}, { exact = false, botName = '' } = {}) => {
    const op = String(input.answer ?? '').trim().toLowerCase();
    if (!BOT_REQUEST_ANSWERS.includes(op)) {
      return { ok: false, error: `Unsupported answer "${input.answer ?? ''}". Use one of: ${BOT_REQUEST_ANSWERS.join(', ')}.` };
    }
    const reply = String(input.reply ?? '').trim();
    if (op === 'reply' && !reply) return { ok: false, error: 'answer "reply" needs `reply`: what the person said.' };
    if (typeof answerRequest !== 'function') return { ok: false, error: 'Answering thread requests is not available here.' };
    const { entry } = await findThread(input.thread_id, { exact });
    const { requests, secretIds } = await turnState(entry);
    const wanted = String(input.request_id ?? '').trim();
    let request = null;
    if (wanted) {
      request = requests.find((candidate) => candidate.id === wanted) ?? null;
      if (!request) {
        if (secretIds.includes(wanted)) {
          return { ok: false, error: 'That is a secret request: only the person can answer it, on its card in Durango Code.' };
        }
        return {
          ok: false,
          error: requests.length
            ? `No pending request "${wanted}" on that thread. It waits on: ${requestList(requests)}.`
            : `No pending request "${wanted}" on that thread: it was answered or cleared already.`,
        };
      }
    } else if (requests.length === 1) {
      [request] = requests;
    } else if (requests.length > 1) {
      return { ok: false, error: `That thread waits on ${requests.length} requests: pass request_id, one of: ${requestList(requests)}.` };
    } else {
      return {
        ok: false,
        error: secretIds.length
          ? 'That thread only waits on a secret request: the person answers it themselves, on its card in Durango Code.'
          : 'That thread has no pending "Needs you" request: it was answered or cleared already.',
      };
    }
    const result = await pressRequest({ entry, request, op, reply, botName });
    if (!result?.ok) return { ok: false, error: result?.error || 'The request could not be answered.' };
    return { ok: true, threadId: entry.id, requestId: request.id, answer: op, request: request.action, note: REQUEST_ANSWER_NOTES[op] };
  };

  /**
   * Before a bot's message_thread (or steer) to `entry`: a thread waiting on
   * one "Needs you" request takes the message as the reply to it, as the
   * person's Reply button would (it carries on in its own turn, and its own
   * task reports as usual), rather than refusing it as busy.
   * → `{ result }` when that settled it (the tool's result), else
   *   `{ running }` for an ordinary follow-up or steer.
   */
  const routeMessage = async (entry, { message, botName = '' } = {}) => {
    const state = await turnState(entry);
    if (!state.requests.length || typeof answerRequest !== 'function') return { running: state.running };
    if (state.requests.length > 1) {
      return {
        result: {
          ok: false,
          error: `That thread is waiting on the person for ${state.requests.length} requests: answer the one this is about with answer_thread_request (request_id, answer "done" or "reply"). Requests: ${requestList(state.requests)}.`,
        },
      };
    }
    const [request] = state.requests;
    const result = await pressRequest({ entry, request, op: 'reply', reply: message, botName });
    if (!result?.ok) {
      // Answered meanwhile (by the person, its check, the agent): an ordinary message then.
      if (/no longer waiting/i.test(String(result?.error ?? ''))) return { running: state.running };
      return { result: { ok: false, error: result?.error || 'The message could not reach the thread.' } };
    }
    return {
      result: {
        ok: true,
        threadId: entry.id,
        answeredRequest: request.id,
        request: request.action,
        note: "That thread was waiting on the person for this request, so your message went to it as their reply (as the Reply button on its card would): it carries on from there. No new task was started; the thread's own task reports as usual. When the person says they did what it asked, answer_thread_request with answer \"done\" is the plainer signal.",
      },
    };
  };

  const manage = async (input = {}, { exact = false } = {}) => {
    const action = String(input.action ?? '').trim().toLowerCase();
    if (!BOT_THREAD_ACTIONS.includes(action)) {
      return { ok: false, error: `Unsupported thread action "${action}". Use one of: ${BOT_THREAD_ACTIONS.join(', ')}.` };
    }
    const runner = manageThread ?? (action === 'settle' && settleThread ? ({ threadId }) => settleThread(threadId) : null);
    if (!runner) {
      return { ok: false, error: action === 'settle' ? 'Settling threads is not available here.' : `Managing threads (${action}) is not available here.` };
    }
    const title = action === 'rename' ? String(input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    if (action === 'rename' && !title) {
      return { ok: false, error: 'A new title is required to rename a thread.' };
    }
    // Destructive deletes always require the exact full thread id (never a prefix).
    const { entry } = await findThread(input.thread_id, { exact: exact || action === 'delete' });
    // The renderer refuses a running thread too (the index's status can be stale).
    if (action === 'settle' && liveStatus(entry.id) === 'running') {
      return { ok: false, error: 'That thread is running a turn: settle it only once its work is finished.' };
    }
    let configureArgs = null;
    if (action === 'configure') {
      if (liveStatus(entry.id) === 'running') {
        return { ok: false, error: 'That thread is running a turn: stop it first or wait for it to finish before changing its settings.' };
      }
      const rawModel = input.model ?? input.modelId;
      const rawEffort = input.effort ?? input.reasoning_effort ?? input.reasoningEffort;
      const rawAccessMode = input.access_mode ?? input.accessMode;
      const rawCodexTier = input.codex_service_tier ?? input.codexServiceTier;
      const rawClaudeWindow = input.claude_context_window ?? input.claudeContextWindow;
      const hasAny =
        Boolean(String(rawModel ?? '').trim()) ||
        Boolean(String(rawEffort ?? '').trim()) ||
        Boolean(String(rawAccessMode ?? '').trim()) ||
        Boolean(String(rawCodexTier ?? '').trim()) ||
        Boolean(String(rawClaudeWindow ?? '').trim());
      if (!hasAny) {
        return { ok: false, error: 'action "configure" requires at least one of: model, effort, access_mode, codex_service_tier, claude_context_window.' };
      }
      const resolved = resolveThreadModelChoice({
        model: rawModel,
        effort: rawEffort,
        currentModelId: entry.modelId ?? entry.shell?.modelId ?? null,
        models: await loadModels(),
        accessMode: rawAccessMode,
        codexServiceTier: rawCodexTier,
        claudeContextWindow: rawClaudeWindow,
      });
      if (!resolved.ok) return { ok: false, error: resolved.error };
      configureArgs = {
        ...(resolved.modelId ? { modelId: resolved.modelId } : {}),
        ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
        ...(resolved.accessMode ? { accessMode: resolved.accessMode } : {}),
        ...(resolved.codexServiceTier ? { codexServiceTier: resolved.codexServiceTier } : {}),
        ...(resolved.claudeContextWindow ? { claudeContextWindow: resolved.claudeContextWindow } : {}),
      };
    }
    const result = await Promise.resolve(
      runner({ threadId: entry.id, action, ...(title ? { title } : {}), ...(configureArgs ?? {}) })
    ).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!result?.ok) return { ok: false, error: result?.error || `The thread could not be updated (${action}).` };
    const note =
      result?.mirrored && action === 'delete'
        ? 'Removed the mirrored copy on this computer (the original thread stays on its host machine).'
        : result?.mirrored && action === 'rename'
          ? 'Renamed the mirrored copy on this computer (the thread runs on another machine).'
          : ACTION_NOTES[action];
    if (action === 'branch') {
      const branchedId = typeof result.threadId === 'string' && result.threadId.trim() ? result.threadId.trim() : '';
      if (!branchedId || branchedId === entry.id) {
        return { ok: false, error: 'The thread could not be branched.' };
      }
      return {
        ok: true,
        threadId: branchedId,
        branchedFrom: entry.id,
        action,
        ...(result.threadTitle ? { title: result.threadTitle } : {}),
        ...(result.modelId ? { model: result.modelId } : {}),
        ...(result.reasoningEffort ? { effort: result.reasoningEffort } : {}),
        ...(result.accessMode ? { accessMode: result.accessMode } : {}),
        note,
      };
    }
    return {
      ok: true,
      threadId: entry.id,
      action,
      ...(action === 'settle' ? { settled: true } : {}),
      ...(title ? { title } : {}),
      ...(action === 'configure'
        ? {
            ...(result.modelId ?? configureArgs?.modelId ? { model: result.modelId ?? configureArgs?.modelId } : {}),
            ...(result.reasoningEffort ?? configureArgs?.reasoningEffort ? { effort: result.reasoningEffort ?? configureArgs?.reasoningEffort } : {}),
            ...(result.accessMode ?? configureArgs?.accessMode ? { accessMode: result.accessMode ?? configureArgs?.accessMode } : {}),
          }
        : {}),
      ...(result?.mirrored ? { mirrored: true } : {}),
      note,
    };
  };

  return {
    names: BOT_THREAD_TOOL_NAMES,
    definitions: BOT_THREAD_TOOLS,
    findThread,
    isRunning: (threadId) => liveStatus(threadId) === 'running',
    async listModels(input = {}) {
      if (typeof listModels !== 'function') {
        return { ok: false, error: 'Model catalog is not available here.' };
      }
      const raw = await loadModels();
      const providerFilter = projectKey(input.provider);
      const searchFilter = projectKey(input.search);
      const limit = Math.min(MAX_MODELS_LISTED, Math.max(1, Number.isInteger(input.limit) ? input.limit : 60));
      const available = raw.filter((model) => model && typeof model.id === 'string' && model.id && model.available !== false);
      const filtered = available.filter((model) => {
        if (providerFilter) {
          const pId = projectKey(model.providerId);
          const pLabel = projectKey(model.provider);
          if (pId !== providerFilter && pLabel !== providerFilter && !pLabel.includes(providerFilter)) return false;
        }
        if (searchFilter) {
          const hay = [model.id, model.label, model.slug, model.provider, model.providerId].filter(Boolean).join(' ').toLowerCase();
          if (!hay.includes(searchFilter)) return false;
        }
        return true;
      });
      const models = filtered.slice(0, limit).map((model) => ({
        id: model.id,
        label: String(model.label || model.id),
        provider: String(model.provider || model.providerId || ''),
        efforts: Array.isArray(model.efforts) ? model.efforts : [],
      }));
      return {
        ok: true,
        total: filtered.length,
        models,
        ...(filtered.length > models.length ? { truncated: true } : {}),
      };
    },
    async list(input = {}) {
      const [{ entries }, projects] = await Promise.all([readIndex(), projectsById()]);
      const wanted = projectKey(input.project);
      const project = wanted
        ? [...projects.values()].find((candidate) => projectKey(candidate.name) === wanted || projectKey(path.basename(candidate.path ?? '')) === wanted)
        : null;
      if (wanted && !project) {
        return {
          ok: false,
          error: `No project "${input.project}" on this computer. Projects: ${[...projects.values()].map((candidate) => candidate.name).join(', ') || 'none'}.`,
        };
      }
      const stateFilter = String(input.state ?? 'all').trim().toLowerCase();
      const limit = Math.min(MAX_LISTED, Math.max(1, Number.isInteger(input.limit) ? input.limit : 15));
      const withSubagents = input.include_subagents === true;
      // Only what the sidebar shows (sidebarThreadRoots); a subagent thread
      // is counted on the thread it sits under, or listed with
      // include_subagents. A provider's own subagent (isProviderSubagent) runs
      // inside its parent's session and can't be read or messaged: never listed.
      const rootFor = sidebarThreadRoots(entries);
      const roots = new Map();
      const subagentCounts = new Map();
      for (const entry of entries) {
        const root = rootFor(entry);
        if (!root) continue;
        roots.set(entry.id, root);
        if (root !== entry && !isProviderSubagent(entry)) subagentCounts.set(root.id, (subagentCounts.get(root.id) ?? 0) + 1);
      }
      const threads = entries
        .filter((entry) => {
          if (isProviderSubagent(entry) || !projects.has(entry.projectId)) return false;
          if (project && entry.projectId !== project.id) return false;
          const root = roots.get(entry.id);
          if (!root || (root !== entry && !withSubagents)) return false;
          const flags = entrySidebarFlags(root);
          if (stateFilter === 'active') return !flags.settled && !flags.snoozed;
          if (stateFilter === 'settled') return flags.settled;
          if (stateFilter === 'snoozed') return flags.snoozed;
          if (stateFilter === 'pinned') return flags.pinned;
          return true;
        })
        .sort((a, b) => (b.activityAt ?? b.updatedAt ?? 0) - (a.activityAt ?? a.updatedAt ?? 0))
        .slice(0, limit)
        .map((entry) => {
          const root = roots.get(entry.id);
          // A subagent thread is filed with its parent: its parent's flags.
          const flags = entrySidebarFlags(root);
          const subagents = subagentCounts.get(entry.id) ?? 0;
          const shell = entry.shell ?? entry;
          const model = entry.modelId ?? shell?.modelId ?? null;
          const effort = threadActiveEffort({ ...shell, ...(model ? { modelId: model } : {}) });
          const accessMode = typeof shell?.accessMode === 'string' && shell.accessMode ? shell.accessMode : null;
          return {
            id: entry.id,
            title: entry.title || '(untitled)',
            project: projects.get(entry.projectId)?.name ?? null,
            status: liveStatus(entry.id) ?? entry.status ?? 'idle',
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            ...(accessMode ? { accessMode } : {}),
            ...(root !== entry ? { subagent: true, parentThreadId: entry.parentThreadId ?? entry.shell?.parentThreadId ?? null } : {}),
            ...(flags.settled ? { settled: true } : {}),
            ...(flags.snoozed ? { snoozed: true } : {}),
            ...(flags.pinned ? { pinned: true } : {}),
            ...(subagents ? { subagents } : {}),
            ...(() => {
              const { requests } = indexThreadRequests(entries, entry.id);
              return requests.length ? { needsYou: requests } : {};
            })(),
            messages: entry.messageCount ?? null,
            lastActivity: iso(entry.activityAt ?? entry.updatedAt),
          };
        });
      return { ok: true, threads };
    },
    async read(input = {}) {
      const { entry } = await findThread(input.thread_id);
      const [text, state] = await Promise.all([
        readThread({
          thread_id: entry.id,
          ...(Number.isInteger(input.offset) ? { offset: input.offset } : {}),
          ...(Number.isInteger(input.limit) ? { limit: input.limit } : {}),
        }),
        turnState(entry).catch(() => ({ requests: [], secretIds: [] })),
      ]);
      return {
        ok: true,
        transcript: text,
        ...(state.requests.length ? { needsYou: state.requests } : {}),
        ...(state.secretIds.length ? { secretRequests: state.secretIds.length } : {}),
      };
    },
    /** answer_thread_request (Done / Reply / dismiss on a "Needs you" card). */
    answer,
    /** message_thread's check for a thread waiting on a request (see routeMessage). */
    routeMessage,
    /**
     * manage_thread: settle, unsettle, snooze, unsnooze, pin, unpin, rename,
     * configure, branch, stop or delete any thread here. `exact`: the full id
     * only (a request from Durango, which every machine of the person may get).
     */
    manage,
    /** Legacy helper for queued settleThreads from Durango. */
    settle(input = {}, options = {}) {
      return manage({ ...(input ?? {}), action: 'settle' }, options);
    },
  };
};
