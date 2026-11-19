import path from 'node:path';

// A bot's Durango Code thread tools, run on this machine (bot-replies.js for
// a Durango bot's reply here, local-bots.js signed out): list the threads of
// this machine's projects, read one, and send a follow-up into one. A
// follow-up is an ordinary turn in that thread (it runs like a message the
// person sends), and its outcome comes back to the bot's inbox like a task's.
// Starting new threads is delegate_task with `project`. settle_thread puts
// away a thread a bot started once the bot judges its work truly finished.

export const BOT_THREAD_TOOL_NAMES = ['list_threads', 'read_thread', 'message_thread', 'settle_thread'];

/**
 * When a bot settles a thread it started (settle_thread): its own call, from
 * what the thread reports, never a rule on its status. In every bot's
 * instructions (local-bots.js, bot-replies.js); Durango's copy is in
 * chat/andromedus/lib/bots/prompt.ts ("Settling threads").
 */
export const BOT_SETTLE_RULE = `Settling threads: a Durango Code thread you started stays in the person's sidebar until it is settled. Settle it yourself (settle_thread) only when you judge its work truly finished from what it reports: the change landed or merged, the release went out, the question was answered and nothing is left to do. Leave it unsettled while it is still running or waiting on something (a watcher, a deploy, a long run), while a change is open for review, when it asks the person something or needs their input, or when you aren't sure: "done" in a report alone doesn't mean finished. Settling only files it away (a new message brings it back); it never stops or deletes anything.`;

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

const MAX_LISTED = 40;

export const BOT_THREAD_TOOLS = [
  {
    name: 'list_threads',
    description:
      "List Durango Code threads on this computer, newest first: the person's own and the ones bots started. Filter by project (name) to see where a project stands; each has its id, title, project, status (running, idle, error…) and last activity.",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', maxLength: 200, description: 'Only threads in this project (by name). Omit for all projects.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LISTED, description: `How many (default 15, at most ${MAX_LISTED}).` },
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
    name: 'settle_thread',
    description:
      "Settle a Durango Code thread a bot started (by id, from a task report): it leaves the person's sidebar list for Settled, like their own Settle button, and comes back if it gets a new message. Call it when you judge, from what the thread reported, that its work is truly finished (e.g. its change landed or merged, the release went out), not while it is running, waiting on something, open for review or needs the person. Only threads a bot started can be settled, and not while a turn runs.",
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', minLength: 1, maxLength: 200 },
        reason: { type: 'string', maxLength: 300, description: 'Why it is finished, in a few words (e.g. "change landed and deployed").' },
      },
      required: ['thread_id'],
    },
  },
];

const projectKey = (value) => String(value ?? '').trim().toLowerCase();

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/**
 * deps:
 * - readIndex(): { entries } (thread-storage.js readThreadsIndex)
 * - readThread(args): transcript page text (thread-reader.js readThreadForAgent)
 * - getProjects(): this machine's projects the bot may use ([{ id, name, path }])
 * - liveStatus(threadId): the renderer's status for a thread now, or null (optional)
 * - settleThread(threadId): settles a thread a bot started, as the person's Settle button
 *   does → { ok, error? } (optional; main.js asks the renderer, which refuses a thread
 *   no bot started or one running a turn)
 */
export const createBotThreadTools = ({ readIndex, readThread, getProjects, liveStatus = () => null, settleThread = null }) => {
  const projectsById = async () => {
    const list = (await Promise.resolve(getProjects()).catch(() => [])) ?? [];
    return new Map(list.filter((project) => project && typeof project.id === 'string').map((project) => [project.id, project]));
  };

  /** The thread (by exact id, or a unique prefix unless `exact`) if it belongs to an allowed project. */
  const findThread = async (rawId, { exact = false } = {}) => {
    const id = String(rawId ?? '').trim();
    if (!id) throw new Error('thread_id is required.');
    const [{ entries }, projects] = await Promise.all([readIndex(), projectsById()]);
    const visible = entries.filter((entry) => !entry.subagent && projects.has(entry.projectId));
    const matches = visible.filter((entry) => entry.id === id);
    const found = matches.length || exact ? matches : visible.filter((entry) => entry.id.startsWith(id));
    if (found.length !== 1) {
      throw new Error(found.length ? `"${id}" matches several threads: use the full id.` : `No thread "${id}" in this computer's projects.`);
    }
    return { entry: found[0], project: projects.get(found[0].projectId) };
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
      const limit = Math.min(MAX_LISTED, Math.max(1, Number.isInteger(input.limit) ? input.limit : 15));
      const threads = entries
        .filter((entry) => !entry.subagent && projects.has(entry.projectId) && (!project || entry.projectId === project.id))
        .sort((a, b) => (b.activityAt ?? b.updatedAt ?? 0) - (a.activityAt ?? a.updatedAt ?? 0))
        .slice(0, limit)
        .map((entry) => ({
          id: entry.id,
          title: entry.title || '(untitled)',
          project: projects.get(entry.projectId)?.name ?? null,
          status: liveStatus(entry.id) ?? entry.status ?? 'idle',
          messages: entry.messageCount ?? null,
          lastActivity: iso(entry.activityAt ?? entry.updatedAt),
        }));
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
     * settle_thread: a thread here a bot started, once the bot judges its work
     * finished. `exact`: the full id only (a request from Durango, which every
     * machine of the person may get).
     */
    async settle(input = {}, { exact = false } = {}) {
      if (!settleThread) return { ok: false, error: 'Settling threads is not available here.' };
      const { entry } = await findThread(input.thread_id, { exact });
      // The renderer refuses a running thread too (the index's status can be stale).
      if (liveStatus(entry.id) === 'running') {
        return { ok: false, error: 'That thread is running a turn: settle it only once its work is finished.' };
      }
      const result = await Promise.resolve(settleThread(entry.id)).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
      if (!result?.ok) return { ok: false, error: result?.error || 'The thread could not be settled.' };
      return { ok: true, threadId: entry.id, settled: true, note: 'Settled: it moved to Settled in the sidebar; a new message brings it back.' };
    },
  };
};
