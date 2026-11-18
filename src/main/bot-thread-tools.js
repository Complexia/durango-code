import path from 'node:path';

// A bot's Durango Code thread tools, run on this machine (bot-replies.js for
// a Durango bot's reply here, local-bots.js signed out): list the threads of
// this machine's projects, read one, and send a follow-up into one. A
// follow-up is an ordinary turn in that thread (it runs like a message the
// person sends), and its outcome comes back to the bot's inbox like a task's.
// Starting new threads is delegate_task with `project`.

export const BOT_THREAD_TOOL_NAMES = ['list_threads', 'read_thread', 'message_thread'];

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
      "Send a follow-up message into an existing Durango Code thread on this computer (by id), as the person would: e.g. answer its question, ask for a fix, tell it to continue or wrap up. Its agent runs a new turn there; the outcome comes back to your inbox like a task's report. Don't message a thread that is running right now unless it's waiting on an answer.",
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', minLength: 1, maxLength: 200 },
        message: { type: 'string', minLength: 1, maxLength: 16_000, description: 'The message, complete and self-contained.' },
        title: { type: 'string', maxLength: 80, description: 'Short title for the follow-up as a task, e.g. "Fix the failing test".' },
      },
      required: ['thread_id', 'message'],
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
 */
export const createBotThreadTools = ({ readIndex, readThread, getProjects, liveStatus = () => null }) => {
  const projectsById = async () => {
    const list = (await Promise.resolve(getProjects()).catch(() => [])) ?? [];
    return new Map(list.filter((project) => project && typeof project.id === 'string').map((project) => [project.id, project]));
  };

  /** The thread (by exact id or a unique prefix) if it belongs to an allowed project. */
  const findThread = async (rawId) => {
    const id = String(rawId ?? '').trim();
    if (!id) throw new Error('thread_id is required.');
    const [{ entries }, projects] = await Promise.all([readIndex(), projectsById()]);
    const visible = entries.filter((entry) => !entry.subagent && projects.has(entry.projectId));
    const matches = visible.filter((entry) => entry.id === id);
    const found = matches.length ? matches : visible.filter((entry) => entry.id.startsWith(id));
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
  };
};
