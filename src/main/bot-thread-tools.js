import path from 'node:path';

// A bot's Durango Code thread tools, run on this machine (bot-replies.js for
// a Durango bot's reply here, local-bots.js signed out): list the threads of
// this machine's projects, read one, send a follow-up into one, and manage any
// thread (settle/archive, unsettle/restore, snooze, unsnooze/wake, pin, unpin,
// rename, stop, delete). A follow-up is an ordinary turn in that thread (it
// runs like a message the person sends), and its outcome comes back to the
// bot's inbox like a task's. Starting new threads is delegate_task with `project`.

export const BOT_THREAD_ACTIONS = ['settle', 'unsettle', 'snooze', 'unsnooze', 'pin', 'unpin', 'rename', 'stop', 'delete'];
export const BOT_THREAD_TOOL_NAMES = ['list_threads', 'read_thread', 'message_thread', 'manage_thread'];

/**
 * How a bot manages and settles Durango Code threads (manage_thread): in every
 * bot's instructions (local-bots.js, bot-replies.js); Durango's copy is in
 * chat/andromedus/lib/bots/prompt.ts ("Managing and settling threads").
 */
export const BOT_SETTLE_RULE = `Managing and settling threads (manage_thread): you can manage any Durango Code thread — ones you started, ones other bots started, or the person's own — to settle (archive), unsettle (restore), snooze, unsnooze (wake), pin, unpin, rename, stop a running turn, or delete it.
- Settling on your own: a Durango Code thread stays in the person's sidebar until it is settled. Settle a thread you started yourself (manage_thread with action "settle") only when you judge its work truly finished from what it reports: the change landed or merged, the release went out, the question was answered and nothing is left to do. Leave it unsettled while it is still running or waiting on something (a watcher, a deploy, a long run), while a change is open for review, when it asks the person something or needs their input, or when you aren't sure: "done" in a report alone doesn't mean finished.
- Any thread and other actions: you may settle, unsettle (restore), snooze, unsnooze (wake), pin, unpin, rename or stop any thread — including threads you didn't start — when the person asks or when it clearly follows from what they asked. Settling only files a thread away (a new message brings it back); it never stops or deletes anything.
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
export const BOT_BRIEF_RULE = `Briefing a Durango Code thread (delegate_task with \`project\`, or a follow-up with message_thread): the thread is a capable engineer that reads the project itself (its code, AGENTS.md, the project's notes through its project_notes tool) and plans its own work. Keep the brief short and goal-level: what to solve and why, plus only what it can't find on its own (what the person asked for and decided, constraints, ids, links, error text, where earlier work stands). Leave the how to it: no numbered requirement lists, step-by-step plans or file-by-file edits, and don't repeat the project's own rules or process. A few sentences is usually enough; add detail only where the person was specific.`;

export const BOT_SHIPPING_RULE = `Shipping (land, ship, deploy, merge, release, publish): the Durango Code thread that made a change ships it, not you. How a project ships is its own (its code may live on GitHub rather than Durango Source, it may deploy through a website, it may need an order such as Convex before the web app, migrations or seeding), and that thread has the context; you usually don't. So when the person asks to ship something, find the thread that did the work (the thread id in its task report, or list_threads and read_thread in that project) and send it the request with message_thread, e.g. "${SHIP_VIA_THREAD_MESSAGE}" Then tell the person what it reports (what landed, what deployed, how it was checked). Only when there is no such thread (deleted, or the work wasn't done in one) start a new thread in that project with delegate_task to ship it, with the change id and what it can't find on its own. Don't land or deploy it yourself (the durango-code CLI, git, provider CLIs) unless the person explicitly tells you to do it yourself. Shipping is public and hard to undo: confirm with the person first unless they already asked you to ship it.`;

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
      ? `NEEDS THE PERSON: the task "${name}" is blocked: its thread is waiting for the person and does nothing until they answer. Tell the person now, in your reply, what it's waiting for; they answer it in that thread in Durango Code. This isn't its report: it reports when its work ends.`
      : `LOOKS STUCK: the task "${name}" is still running but has shown no progress for a while, and it isn't waiting on anything it started itself (a command, a subagent, a background wait). Check before you assume it hung (read the thread, or send it a message), and tell the person if it needs them. This isn't its report.`;
  const body = String(detail ?? '').trim();
  return body ? `${head}\n\n${body}` : head;
};

const MAX_LISTED = 40;

export const BOT_THREAD_TOOLS = [
  {
    name: 'list_threads',
    description:
      "List Durango Code threads on this computer, newest first: the threads in the person's sidebar, their own and the ones bots started. Filter by project (name) or sidebar state (active, settled, snoozed, pinned) to see where a project stands; each has its id, title, project, status (running, idle, error…), sidebar flags (settled, snoozed, pinned) and last activity. Subagent threads (ones a thread spawned, e.g. reviews) aren't in the sidebar and aren't listed: their parent shows how many it has (`subagents`); they come and go with it, so there's nothing to settle there. Pass include_subagents to list them too (each with its parentThreadId).",
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
      "Read a Durango Code thread's transcript (by id from list_threads or a task report): what was asked, what the agent did, changed files and its final answer. Long threads come in pages: pass offset to read more.",
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
      "Send a follow-up message into an existing Durango Code thread on this computer (by id, from list_threads or a task report), as the person would: e.g. answer its question, ask for a fix, tell it to continue or wrap up. Also how you ship a change (land, deploy, merge, release): message the thread that made it and let it ship the change the way its project ships, rather than landing or deploying it yourself. Its agent runs a new turn there; the outcome comes back to your inbox like a task's report. Don't message a thread that is running right now unless it's waiting on an answer.",
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', minLength: 1, maxLength: 200 },
        message: { type: 'string', minLength: 1, maxLength: 16_000, description: 'What you need and why, plus anything the thread can\'t see (what the person said). It has its own context: don\'t repeat it or spell out steps.' },
        title: { type: 'string', maxLength: 80, description: 'Short title for the follow-up as a task, e.g. "Fix the failing test".' },
      },
      required: ['thread_id', 'message'],
    },
  },
  {
    name: 'manage_thread',
    description:
      "Manage any Durango Code thread on this computer (by id, from list_threads or a task report) — whether started by a bot or by the person: settle (archive), unsettle (restore/unarchive), snooze, unsnooze (wake), pin, unpin, rename (with `title`), stop (stop a running turn), or delete (permanent — requires the full thread_id, and only when the person explicitly asks). Cannot settle a thread while a turn is running.",
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', minLength: 1, maxLength: 200, description: 'Thread id (full id required for action "delete").' },
        action: {
          type: 'string',
          enum: BOT_THREAD_ACTIONS,
          description:
            'What to do: "settle" (archive to Settled), "unsettle" (restore to sidebar), "snooze", "unsnooze" (wake), "pin", "unpin", "rename" (requires `title`), "stop" (stop a running turn), or "delete" (permanent; requires the full thread_id, and only when explicitly asked).',
        },
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'New thread title (required for action "rename").' },
        reason: { type: 'string', maxLength: 300, description: 'Optional short note on why (e.g. "change landed and deployed").' },
      },
      required: ['thread_id', 'action'],
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

// agentCatalog.ts claudeCodeCliModelId: a CLI thread keeps its conversation
// in the terminal, so the sidebar always shows it.
const CLAUDE_CODE_CLI_MODEL_ID = 'claude:claude-code-cli';

/**
 * deps:
 * - readIndex(): { entries } (thread-storage.js readThreadsIndex)
 * - readThread(args): transcript page text (thread-reader.js readThreadForAgent)
 * - getProjects(): this machine's projects the bot may use ([{ id, name, path }])
 * - liveStatus(threadId): the renderer's status for a thread now, or null (optional)
 * - manageThread({ threadId, action, title? }): runs a thread action (settle, unsettle,
 *   snooze, unsnooze, pin, unpin, rename, stop, delete) on any thread here → { ok, error? }
 * - settleThread(threadId): legacy fallback for settle only when manageThread is omitted
 */
export const createBotThreadTools = ({ readIndex, readThread, getProjects, liveStatus = () => null, manageThread = null, settleThread = null }) => {
  const projectsById = async () => {
    const list = (await Promise.resolve(getProjects()).catch(() => [])) ?? [];
    return new Map(list.filter((project) => project && typeof project.id === 'string').map((project) => [project.id, project]));
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
    const result = await Promise.resolve(
      runner({ threadId: entry.id, action, ...(title ? { title } : {}) })
    ).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!result?.ok) return { ok: false, error: result?.error || `The thread could not be updated (${action}).` };
    const note =
      result?.mirrored && action === 'delete'
        ? 'Removed the mirrored copy on this computer (the original thread stays on its host machine).'
        : result?.mirrored && action === 'rename'
          ? 'Renamed the mirrored copy on this computer (the thread runs on another machine).'
          : ACTION_NOTES[action];
    return {
      ok: true,
      threadId: entry.id,
      action,
      ...(action === 'settle' ? { settled: true } : {}),
      ...(title ? { title } : {}),
      ...(result?.mirrored ? { mirrored: true } : {}),
      note,
    };
  };

  return {
    names: BOT_THREAD_TOOL_NAMES,
    definitions: BOT_THREAD_TOOLS,
    findThread,
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
          return {
            id: entry.id,
            title: entry.title || '(untitled)',
            project: projects.get(entry.projectId)?.name ?? null,
            status: liveStatus(entry.id) ?? entry.status ?? 'idle',
            ...(root !== entry ? { subagent: true, parentThreadId: entry.parentThreadId ?? entry.shell?.parentThreadId ?? null } : {}),
            ...(flags.settled ? { settled: true } : {}),
            ...(flags.snoozed ? { snoozed: true } : {}),
            ...(flags.pinned ? { pinned: true } : {}),
            ...(subagents ? { subagents } : {}),
            messages: entry.messageCount ?? null,
            lastActivity: iso(entry.activityAt ?? entry.updatedAt),
          };
        });
      return { ok: true, threads };
    },
    async read(input = {}) {
      const { entry } = await findThread(input.thread_id);
      const text = await readThread({
        thread_id: entry.id,
        ...(Number.isInteger(input.offset) ? { offset: input.offset } : {}),
        ...(Number.isInteger(input.limit) ? { limit: input.limit } : {}),
      });
      return { ok: true, transcript: text };
    },
    /**
     * manage_thread: settle, unsettle, snooze, unsnooze, pin, unpin, rename,
     * stop or delete any thread here. `exact`: the full id only (a request
     * from Durango, which every machine of the person may get).
     */
    manage,
    /** Legacy helper for queued settleThreads from Durango. */
    settle(input = {}, options = {}) {
      return manage({ ...(input ?? {}), action: 'settle' }, options);
    },
  };
};
