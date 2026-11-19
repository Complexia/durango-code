import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { durangoModelIdForClaude } from './bot-replies.js';
import { BOT_SHIPPING_RULE, BOT_THREAD_TOOLS, withThreadReportFooter } from './bot-thread-tools.js';

// Local bots: Durango bots that live on this device, for people who aren't
// signed in to Durango. Same semantics as Durango's bots (always-on
// assistants with one thread each; messages never block; a reply in progress
// takes in what arrives between its steps; a parallel reply starts when a
// message waits more than a few seconds), but every reply runs here through
// the person's own Claude Code (createClaudeLaneRunner in bot-replies.js), the
// bots' tools run in this process, and everything is stored as JSON under
// `<dir>` (bots.json + one `<botId>.json` per bot). When the person signs in,
// exportForSync() is uploaded to their Durango account and markSynced() moves
// the files aside, so nothing is uploaded twice or deleted.

export const LOCAL_BOT_PLACE = 'machine:local';
export const LOCAL_BOT_DEFAULT_MODEL = 'claude-sonnet-5-5';
export const LOCAL_PRIMARY_BOT_MODEL = 'claude-opus-5-5';
export const LOCAL_BOT_COMPACTION_MODEL = 'claude-haiku-5-5';
export const LOCAL_BOT_PARALLEL_AFTER_MS = 5_000;
export const LOCAL_BOT_MAX_REPLIES = 2;
export const LOCAL_BOT_MAX_TASKS = 3;
export const LOCAL_BOT_MESSAGE_CAP = 2_000;
export const LOCAL_BOT_ROUTINE_TICK_MS = 60_000;
export const LOCAL_BOT_MIN_INTERVAL_MINUTES = 15;
export const COMPACT_TRIGGER_TOKENS = 40_000;
export const COMPACT_KEEP_TOKENS = 12_000;
export const COMPACT_MIN_KEEP_MESSAGES = 8;
const HEARTBEAT_MS = 10_000;
const PROMPT_HISTORY_MAX_CHARS = 240_000;
const SUMMARY_ROW_CHARS = 8_000;
const INBOX_LABEL = { routine: 'Routine: ', task: 'Task: ', bot: 'Bot: ' };
const INDEX_FILE = 'bots.json';
const PROJECTS_FILE = 'projects.json';
const PROJECT_FILES_DIR = 'project-files';
export const LOCAL_PROJECT_LIMITS = { noteChars: 2_000, notesPerProject: 200, fileBytes: 10 * 1024 * 1024, filesPerProject: 200, readChars: 60_000, promptNotesChars: 6_000 };

// --- prompts ------------------------------------------------------------------------------

export const LOCAL_BOT_PROMPT = `## You are a Durango bot

You are one of the person's always-on bots in Durango Code: a capable assistant they text like a person. You live on this computer, and every reply of yours runs here through the person's own Claude Code. You remember what you've been told (your earlier conversation and its summary).

How your inbox works:
- The person texts you like a person: often several messages in a row, and more while you're working. Nothing they send waits for you to finish, and nothing interrupts you. Your inbox holds the person's own messages, routine runs (labelled "${INBOX_LABEL.routine}…"), reports from tasks you handed off ("${INBOX_LABEL.task}…") and messages from their other bots ("${INBOX_LABEL.bot}…").
- The messages this reply answers come last in the conversation. Handle every one: answer each (briefly, in a natural order, related ones together); don't skip any or answer only the last.
- Messages that arrive while you work appear between your tool calls ("Bot inbox: … arrived while you were working"). Take them in: if one is related or quick, fold it into what you're doing and answer it in this same reply (e.g. "and Almaty?" while you look up SF weather: look up both, answer both).
- Sometimes another reply of yours is already in progress for earlier messages (your context says which). Don't answer those again; answer only yours.

Stay responsive:
- Reply fast, like a person texting: short, warm, direct. No preambles or recaps of the question.
- Quick things (a fact, a lookup, a short draft, one or two tool calls) you do yourself, right away.
- Anything bigger (research, multi-step work, long writing, browsing many pages, code, comparing many options) you hand off with delegate_task and tell the person you're on it. Several independent pieces of work: several tasks, started together. The task runs in the background on this computer; its report comes back to your inbox and you then tell the person what matters.
- Never pretend something is done when it was only handed off or drafted.

Routines and reports:
- A routine run is an instruction you gave yourself on a schedule. Do it. If nothing is worth the person's attention, reply with one short line (they may not read it) and don't notify them.
- When a task report or routine finds something the person should see, write it up in your reply and call notify_user so it shows as a notification on this computer.
- When you need a decision or information from the person, call ask_user with the question and a few short options, and write the question and its options in your reply too (the person reads your reply, not the tool call). Wait for the answer; don't guess on things that matter (money, sending messages, applying, deleting).

Where you run: on this computer, through the person's Claude Code, with the tools it allows here and the person's own logins on this computer. You see the person's Durango Code projects on this computer (listed below with their folders); real work in one goes to a Durango Code thread there (delegate_task with \`project\`), which the person can watch in the app. There are no connected apps (Gmail and others) and nothing runs anywhere else: if something needs an account or service you can't reach from here, say so.

Schedules (manage_routine): when the person wants something done regularly or at a time ("every morning", "remind me Friday", "keep an eye on…"), set a routine on yourself (or on the bot that owns that job). Times are local times on this computer. Routines run while Durango Code is open on this computer.

Other bots:
- The person can have many bots, each with its own job (e.g. a job hunter, a news digest). When they want a standing helper for an ongoing job, create one with create_bot: a clear name, a precise job, and usually a routine. Tell them it exists and what it will do.
- Talk to another bot with message_bot (asynchronous: its answer comes back to your inbox later) and check on it with read_bot. Don't micromanage: bots run on their own.

${BOT_SHIPPING_RULE}

Acting for the person: draft first and confirm before anything irreversible or public (sending email or messages, posting, buying, applying, deleting), unless they told you to go ahead for that kind of thing.`;

export const LOCAL_PRIMARY_BOT_PROMPT = `You are the person's primary bot: their main point of contact, across all their projects. You see their other bots (listed each turn) and answer for all of them: "what are my bots up to?", "is anything waiting on me?". Create, adjust, pause or retire bots when the person asks, and suggest a new bot when a job clearly deserves one. Projects don't get bots on their own: create a project's bot only when the person asks (create_bot with \`project\`). You coordinate; you don't redo other bots' work.`;

export const LOCAL_TASK_PROMPT = `## You are running a task for a Durango bot

A bot handed you this task. It runs in the background on this computer through Claude Code. Work through it fully and on your own: there is no one to answer questions mid-task, so make sensible assumptions and note them. Use your tools as needed.

Your final reply is the report the bot receives: lead with the outcome or answer, then the details that matter (links, numbers, names, drafts), concise and complete. If something couldn't be done, say exactly what and why. Don't send, post, buy, apply or delete anything unless the task explicitly says to.`;

export const LOCAL_COMPACTION_PROMPT = `You maintain the long-term working summary of an always-on assistant bot's conversation with a person. The bot will see ONLY this summary plus the most recent messages, so anything you drop is forgotten.

Merge the previous summary with the new messages into one updated summary. Keep, concretely (names, numbers, dates, links, ids, exact wording of preferences):
1. Standing instructions and preferences the person gave (how they want things done, what not to do).
2. Open items: requests not yet finished, promises the bot made, questions waiting on the person, tasks running and what they were for.
3. Decisions made and their reasons; things already done (so they aren't redone).
4. Key facts learned about the person, their situation and their projects.
5. The bot's other bots / routines it set up, and what they are for (if mentioned).
Drop greetings, chit-chat, and detail that no longer matters. Resolved items shrink to one line. Use short headed sections and bullet points, newest state wins over older. Write in third person ("The person…", "You (the bot)…"). Stay under 1,200 words. Output only the summary.`;

// --- small helpers ------------------------------------------------------------------------

const str = (value) => (typeof value === 'string' ? value : '');
const clip = (value, max) => {
  const text = str(value);
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
};
const oneLine = (value) => str(value).replace(/\s+/g, ' ').trim();
const newId = (prefix) => `${prefix}${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);

export class LocalBotError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const inboxSourceOf = (authorLabel) => {
  if (!authorLabel) return 'person';
  if (authorLabel.startsWith(INBOX_LABEL.routine)) return 'routine';
  if (authorLabel.startsWith(INBOX_LABEL.task)) return 'task';
  if (authorLabel.startsWith(INBOX_LABEL.bot)) return 'bot';
  return 'person';
};
const inboxLabel = (source, name) => `${INBOX_LABEL[source]}${clip(oneLine(name), 60)}`;

/** "claude-opus-5-5" → "anthropic/claude-opus-5.5" for Durango; anything unrecognised → the default bot model. */
export const durangoModelForLocalBot = (model) =>
  durangoModelIdForClaude(model) ?? durangoModelIdForClaude(LOCAL_BOT_DEFAULT_MODEL);

/** A Claude Code model id from what a bot asked for ("anthropic/claude-opus-5.5" works too), or null. */
const claudeModelFrom = (value) => {
  const raw = oneLine(value).toLowerCase().replace(/^anthropic\//, '').replace(/\./g, '-');
  return /^claude-[a-z0-9-]{2,60}(\[1m\])?$/.test(raw) ? raw : null;
};

const estimateTokens = (text) => Math.ceil(str(text).length / 4);

/** The newest seq to fold into the summary, or null while the tail is small enough. Pure. */
export const compactionBoundary = (
  rows,
  { trigger = COMPACT_TRIGGER_TOKENS, keep = COMPACT_KEEP_TOKENS, minKeepMessages = COMPACT_MIN_KEEP_MESSAGES } = {}
) => {
  const tokens = rows.map((row) => estimateTokens(row.content) + 8);
  const total = tokens.reduce((sum, value) => sum + value, 0);
  if (total < trigger || rows.length <= minKeepMessages) return null;
  let kept = 0;
  let keptMessages = 0;
  let index = rows.length - 1;
  for (; index >= 0; index -= 1) {
    if (keptMessages >= minKeepMessages && kept + tokens[index] > keep) break;
    kept += tokens[index];
    keptMessages += 1;
  }
  if (index < 0) return null;
  // The kept part starts with an incoming message: fold the replies in front of it too.
  while (index + 1 < rows.length - 1 && rows[index + 1].role !== 'user') index += 1;
  return rows[index].seq;
};

// --- schedules (local time on this computer) ------------------------------------------------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** The tool's schedule input (or a stored schedule) → the stored shape. Throws with a message the bot can act on. */
export const parseSchedule = (input, now) => {
  const value = input && typeof input === 'object' ? input : {};
  switch (value.kind) {
    case 'once': {
      const at = typeof value.at === 'number' ? value.at : Date.parse(str(value.at));
      if (!Number.isFinite(at)) throw new Error('A one-off routine needs `at` as an ISO date-time (e.g. 2026-11-20T09:00:00).');
      if (at < now - 60_000) throw new Error('That time has already passed.');
      return { kind: 'once', at };
    }
    case 'interval': {
      const every = Number(value.every_minutes ?? value.everyMinutes);
      if (!Number.isInteger(every) || every < LOCAL_BOT_MIN_INTERVAL_MINUTES) {
        throw new Error(`An interval routine needs \`every_minutes\` (a whole number, at least ${LOCAL_BOT_MIN_INTERVAL_MINUTES}).`);
      }
      return { kind: 'interval', everyMinutes: every };
    }
    case 'daily': {
      const time = str(value.time ?? value.localTime).trim();
      const match = time.match(/^(\d{1,2}):(\d{2})$/);
      if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('A daily routine needs `time` as HH:MM (24-hour, local time).');
      const days = Array.isArray(value.days)
        ? [...new Set(value.days.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort()
        : ALL_DAYS;
      if (!days.length) throw new Error('`days` needs at least one weekday (0 = Sunday … 6 = Saturday).');
      return { kind: 'daily', localTime: `${match[1].padStart(2, '0')}:${match[2]}`, days };
    }
    default:
      throw new Error('A schedule needs `kind`: "once", "interval" or "daily".');
  }
};

/** The next run strictly after `after` (ms), or null when there is none. */
export const nextRunAfter = (schedule, after) => {
  if (schedule.kind === 'once') return schedule.at > after ? schedule.at : null;
  if (schedule.kind === 'interval') return after + schedule.everyMinutes * 60_000;
  const [hours, minutes] = schedule.localTime.split(':').map(Number);
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = new Date(after);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getTime() > after && schedule.days.includes(candidate.getDay())) return candidate.getTime();
  }
  return null;
};

const scheduleText = (schedule) => {
  if (schedule.kind === 'once') return `once, ${formatAt(schedule.at)}`;
  if (schedule.kind === 'interval') return `every ${schedule.everyMinutes} min`;
  const days = schedule.days.length === 7 ? 'every day' : schedule.days.map((day) => DAY_NAMES[day]).join(', ');
  return `daily at ${schedule.localTime} (${days})`;
};

const formatAt = (ms) => {
  try {
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms);
  } catch {
    return new Date(ms).toISOString();
  }
};

const ago = (ms, now) => {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
};

const systemTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};

// --- the bots' tools ----------------------------------------------------------------------

const botIdSchema = { type: 'string', maxLength: 64, description: "A bot's id (from your context)." };
const scheduleSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['once', 'interval', 'daily'] },
    at: { type: 'string', description: 'once: when, as an ISO 8601 date-time (local time on this computer unless it has an offset), e.g. 2026-11-20T09:00:00.' },
    every_minutes: { type: 'integer', description: `interval: minutes between runs (at least ${LOCAL_BOT_MIN_INTERVAL_MINUTES}).` },
    time: { type: 'string', description: "daily: local time HH:MM on this computer's clock." },
    days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: 'daily: weekdays to run, 0 = Sunday … 6 = Saturday. Omit for every day.' },
  },
  required: ['kind'],
};

const LOCAL_PROJECT_TOOLS = [
  {
    name: 'project_notes',
    description: "A project's notes and files (your home project by default, or name one). Notes are what its bots keep in mind about the project; files are its documents.",
    inputSchema: { type: 'object', properties: { project: { type: 'string', maxLength: 200, description: 'Project name (default: your own project).' } } },
  },
  {
    name: 'remember_project',
    description:
      "Keep a note in a project's memory (your home project by default): decisions, conventions, where things are, what's in progress, the person's preferences for this project. Every bot and every thread started in the project sees its notes. One fact per note; check project_notes to avoid repeats.",
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', minLength: 1, maxLength: 2_000 }, project: { type: 'string', maxLength: 200 } },
      required: ['note'],
    },
  },
  {
    name: 'forget_project_note',
    description: 'Remove a project note that is wrong or out of date (its id from project_notes).',
    inputSchema: { type: 'object', properties: { note_id: { type: 'string', minLength: 1, maxLength: 64 } }, required: ['note_id'] },
  },
  {
    name: 'read_project_file',
    description: "Read one of a project's files (your home project by default). Text files come back as text; other files as their path on this computer.",
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, project: { type: 'string', maxLength: 200 } },
      required: ['name'],
    },
  },
  {
    name: 'save_project_file',
    description:
      "Save a text document to a project's files (your home project by default): specs, plans, research, meeting notes, checklists. Saving under an existing name replaces it. Use a clear name with an extension, e.g. 'launch-plan.md'.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 160 },
        content: { type: 'string', minLength: 1, maxLength: 500_000 },
        project: { type: 'string', maxLength: 200 },
      },
      required: ['name', 'content'],
    },
  },
];

export const LOCAL_BOT_TOOLS = [
  {
    name: 'delegate_task',
    description:
      "Hand off a piece of work to run in the background as its own task, on this computer through Claude Code (with its own tools: web, shell, files…). Returns at once; the task's report arrives in your inbox when it's done, and you tell the person. Use it for anything that takes more than a couple of quick tool calls, so you stay responsive. Write complete, self-contained instructions: the task sees nothing else.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 80, description: "Short title the person will see, e.g. 'Find 5 remote senior frontend roles'." },
        instructions: { type: 'string', minLength: 1, maxLength: 16_000, description: 'Everything the task needs: goal, context, constraints, what to report back.' },
        project: {
          type: 'string',
          maxLength: 200,
          description:
            "A Durango Code project on this computer (by name, as listed in your instructions): the task runs as a Durango Code thread in it, with every tool a thread has, and the person can watch and continue it in the app. The project's notes are added for it. Omit for work that isn't about a project.",
        },
      },
      required: ['title', 'instructions'],
    },
  },
  {
    name: 'create_bot',
    description:
      "Create a new bot for the person: a standing helper with its own job, thread and schedules (e.g. a job hunter, a news digest). Give it a clear name and a precise job (what to do, how, what to report, what never to do without asking), its routines, and optionally a first message to get it started. It sees its routines in its own context, so it won't set them again. With `project`, it is that Durango Code project's bot (only when the person asks for one; projects don't get bots on their own): it leads the project and threads it starts default there. A project has at most one bot: if it already has one, that bot is returned.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 40, description: "Its name (a project bot defaults to the project's name)." },
        job: { type: 'string', minLength: 1, maxLength: 8_000, description: "Its standing instructions, in second person ('You find…'). Required unless it's a project bot." },
        project: { type: 'string', maxLength: 200, description: 'A Durango Code project on this computer (by name): makes this the project\'s bot.' },
        emoji: { type: 'string', maxLength: 8 },
        routines: {
          type: 'array',
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 80 },
              instructions: { type: 'string', minLength: 1, maxLength: 4_000 },
              schedule: scheduleSchema,
            },
            required: ['title', 'instructions', 'schedule'],
          },
          description: 'Its schedules, set before it starts (rather than with manage_routine afterwards).',
        },
        first_message: { type: 'string', maxLength: 8_000, description: 'A first message from you to get it going (it answers in its own thread).' },
      },
      required: [],
    },
  },
  {
    name: 'update_bot',
    description: `Change a bot (yourself by default): its name, job, emoji, Claude model (e.g. "${LOCAL_PRIMARY_BOT_MODEL}", "${LOCAL_BOT_DEFAULT_MODEL}", "claude-haiku-5-5"), or pause/resume it. A paused bot keeps its messages and answers them when resumed.`,
    inputSchema: {
      type: 'object',
      properties: {
        bot_id: botIdSchema,
        name: { type: 'string', minLength: 1, maxLength: 40 },
        job: { type: 'string', maxLength: 8_000 },
        emoji: { type: 'string', maxLength: 8 },
        model: { type: 'string', maxLength: 80 },
        paused: { type: 'boolean' },
      },
    },
  },
  {
    name: 'message_bot',
    description:
      "Send a message to another of the person's bots (it lands in that bot's inbox and starts its reply). Asynchronous: its answer, if any, comes back to your inbox later.",
    inputSchema: {
      type: 'object',
      properties: { bot_id: botIdSchema, message: { type: 'string', minLength: 1, maxLength: 8_000 } },
      required: ['bot_id', 'message'],
    },
  },
  {
    name: 'read_bot',
    description: "Read another bot's latest messages (what it's been doing and saying).",
    inputSchema: {
      type: 'object',
      properties: { bot_id: botIdSchema, limit: { type: 'integer', minimum: 1, maximum: 40 } },
      required: ['bot_id'],
    },
  },
  {
    name: 'manage_routine',
    description:
      "Create, change or delete a routine: instructions that arrive in a bot's inbox on a schedule (once, every N minutes, or daily at a local time on chosen weekdays). The bot (you, by default) does them each time. Times are local times on this computer; routines run while Durango Code is open here (a run missed while it was closed happens when it opens).",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete'] },
        bot_id: { ...botIdSchema, description: 'create: the bot that runs it (default: you).' },
        routine_id: { type: 'string', maxLength: 64, description: 'update/delete: the routine.' },
        title: { type: 'string', maxLength: 80 },
        instructions: { type: 'string', maxLength: 4_000, description: 'What to do each run, self-contained.' },
        schedule: scheduleSchema,
        enabled: { type: 'boolean' },
      },
      required: ['action'],
    },
  },
  {
    name: 'notify_user',
    description:
      'Show the person a notification on this computer about something in your reply that deserves their attention now (a result, a find, something time-sensitive). Not for routine chatter or replies to what they just asked. Keep it to one line.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', minLength: 1, maxLength: 120 }, message: { type: 'string', maxLength: 600 } },
      required: ['title'],
    },
  },
  {
    name: 'ask_user',
    description:
      'Mark that you need the person to answer a question before going on (their bot list shows you as waiting on them, and they get a notification). The person only sees your reply text, so write the question and these options in your reply too. End your reply after asking; their answer arrives as their next message.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 1, maxLength: 500 },
        options: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 120 }, minItems: 1, maxItems: 6 },
      },
      required: ['question', 'options'],
    },
  },
  ...LOCAL_PROJECT_TOOLS,
];

// --- the engine ---------------------------------------------------------------------------

const normalizeRoutine = (raw) => {
  if (!raw || typeof raw !== 'object' || !raw.schedule) return null;
  let schedule;
  try {
    schedule = parseSchedule(raw.schedule, -Infinity);
  } catch {
    return null;
  }
  return {
    id: str(raw.id) || newId('lr'),
    title: clip(str(raw.title) || 'Routine', 80),
    instructions: str(raw.instructions),
    schedule,
    nextRunAt: Number.isFinite(raw.nextRunAt) ? raw.nextRunAt : null,
    enabled: raw.enabled !== false,
  };
};

const normalizeBot = (raw, now) => {
  const role = raw?.role === 'primary' ? 'primary' : 'bot';
  return {
    id: str(raw?.id),
    name: clip(str(raw?.name) || 'Bot', 40),
    emoji: str(raw?.emoji) || null,
    role,
    job: str(raw?.job),
    model: claudeModelFrom(raw?.model) ?? (role === 'primary' ? LOCAL_PRIMARY_BOT_MODEL : LOCAL_BOT_DEFAULT_MODEL),
    createdAt: finite(raw?.createdAt, now),
    lastActivityAt: finite(raw?.lastActivityAt, now),
    lastPreview: typeof raw?.lastPreview === 'string' ? raw.lastPreview : null,
    unread: Number.isInteger(raw?.unread) && raw.unread > 0 ? raw.unread : 0,
    needsYou: raw?.needsYou === true,
    paused: raw?.paused === true,
    summary: typeof raw?.summary === 'string' && raw.summary.trim() ? raw.summary : null,
    compactedThroughSeq: Number.isInteger(raw?.compactedThroughSeq) ? raw.compactedThroughSeq : 0,
    routines: (Array.isArray(raw?.routines) ? raw.routines : []).map(normalizeRoutine).filter(Boolean),
    nextSeq: Number.isInteger(raw?.nextSeq) && raw.nextSeq > 0 ? raw.nextSeq : 1,
    processedSeq: Number.isInteger(raw?.processedSeq) ? raw.processedSeq : 0,
    // Claimed by a reply not stored yet (saved, so a crash can't lose them),
    // and released ones waiting for the next reply. A crash's in-flight
    // claims are released when the bots load again.
    inFlight: [],
    requeue: [...new Set([...seqList(raw?.requeue), ...seqList(raw?.inFlight)])].sort((a, b) => a - b),
    project: normalizeProject(raw?.project),
  };
};

const seqList = (value) => (Array.isArray(value) ? value.filter((seq) => Number.isInteger(seq) && seq > 0) : []);

/** A local project bot's project: `{ key, name, projectId, repoId }` (key as Durango's projectKeyFor). */
const normalizeProject = (raw) =>
  raw && typeof raw === 'object' && str(raw.key) && str(raw.name)
    ? { key: str(raw.key), name: clip(str(raw.name), 120), projectId: str(raw.projectId) || null, repoId: str(raw.repoId) || null }
    : null;

/** Durango's project key for a project (convex/botPolicy.ts projectKeyFor). */
export const localProjectKey = ({ repoId, machineId, projectId }) =>
  str(repoId).trim() ? `repo:${str(repoId).trim()}` : str(machineId).trim() && str(projectId).trim() ? `local:${str(machineId).trim()}:${str(projectId).trim()}` : null;

// Signed out, a project without a Source repo is keyed on this device.
const LOCAL_MACHINE = 'this-device';

// Project bots first started with this icon; now they show their robot face.
const LEGACY_PROJECT_BOT_EMOJI = '🗂️';

export const localProjectBotJob = (name) =>
  `You lead the ${name} project: you know where it stands, keep its notes and files organized, and get work done in it by starting Durango Code threads there (several at once when the work splits), following them up and reporting what matters. Work outside the project too when asked.`;

const CONTENT_TYPES = { md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv', html: 'text/html', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', svg: 'image/svg+xml' };
const guessContentType = (name) => CONTENT_TYPES[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
const isTextFile = (file) => /^(text\/|application\/(json|xml|yaml|javascript))/i.test(file.contentType ?? '') || /\.(md|markdown|txt|json|ya?ml|toml|csv|tsv|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|sh|sql|ini|log)$/i.test(file.name);

const safeFileName = (name) => clip(str(name).replace(/[\\/\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim(), 160);

const normalizeMessage = (raw) =>
  raw && typeof raw === 'object' && Number.isInteger(raw.seq) && typeof raw.content === 'string'
    ? {
        id: str(raw.id) || newId('lm'),
        seq: raw.seq,
        role: raw.role === 'assistant' ? 'assistant' : 'user',
        content: raw.content,
        authorLabel: typeof raw.authorLabel === 'string' && raw.authorLabel ? raw.authorLabel : null,
        createdAt: finite(raw.createdAt, 0),
        // Files sent with it, copied into the bots folder (attachments/<message id>/).
        ...(Array.isArray(raw.attachments) && raw.attachments.length
          ? {
              attachments: raw.attachments
                .filter((item) => item && typeof item.name === 'string' && typeof item.path === 'string')
                .map((item) => ({ name: item.name, path: item.path, size: finite(item.size, 0), contentType: str(item.contentType) })),
            }
          : {}),
      }
    : null;

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * deps:
 * - dir: storage directory (or a function returning it), e.g. `<userData>/bots/local`
 * - runLane(lane, ctx): createClaudeLaneRunner(...) from bot-replies.js
 * - summarize({ model, systemPrompt, prompt }): one-shot text (createClaudeOneShot); optional
 * - getAccessMode(): the machine's dispatch access mode ('read-only' by default)
 * - listProjects(): this computer's Durango Code projects bots may use ([{ id, name, path }])
 * - startProjectThread({ projectId, prompt, key, botName, title, accessMode }): starts a
 *   Durango Code thread in a project → { ok, threadId?, error? }. Its outcome comes back
 *   through threadSettled({ key, … }).
 * - startThreadFollowUp({ threadId, prompt, key, botName, accessMode }): a follow-up turn in
 *   a thread (message_thread), settled the same way
 * - threadTools: createBotThreadTools(...) (list_threads, read_thread, findThread)
 * - notify({ title, body })
 * - now(), sleep(ms) (the parallel-reply delay), log(...), onChange()
 * - setTimer(fn, ms) / clearTimer(handle): the routine timer (setInterval by default)
 * - platform, timeZone()
 */
export const createLocalBotEngine = ({
  dir,
  runLane,
  summarize = null,
  getAccessMode = () => 'read-only',
  listProjects = async () => [],
  startProjectThread = null,
  startThreadFollowUp = null,
  threadTools = null,
  notify = () => {},
  now = Date.now,
  sleep = defaultSleep,
  log = (...args) => console.warn('[local bots]', ...args),
  onChange = () => {},
  setTimer = (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimer = (handle) => clearInterval(handle),
  routineTickMs = LOCAL_BOT_ROUTINE_TICK_MS,
  parallelAfterMs = LOCAL_BOT_PARALLEL_AFTER_MS,
  maxReplies = LOCAL_BOT_MAX_REPLIES,
  platform = process.platform,
  timeZone = systemTimeZone,
}) => {
  const storageDir = () => (typeof dir === 'function' ? dir() : dir);
  let loaded = null; // Promise while/after loading
  let entries = new Map(); // botId -> { bot, messages, compacting }
  const runtimes = new Map(); // botId -> { replies: Map, tasks: Map, pendingChecks }
  const work = new Set(); // promises of running replies/tasks (idle())
  let generation = 0; // bumped by markSynced(): stale work never writes
  let active = false;
  let timer = null;

  const changed = () => {
    try {
      onChange();
    } catch {}
  };
  const track = (promise) => {
    work.add(promise);
    promise.finally(() => work.delete(promise)).catch(() => {});
    return promise;
  };
  const runtimeFor = (botId) => {
    let runtime = runtimes.get(botId);
    if (!runtime) {
      runtime = { replies: new Map(), tasks: new Map(), threads: new Map(), pendingChecks: 0 };
      runtimes.set(botId, runtime);
    }
    return runtime;
  };

  // --- storage ------------------------------------------------------------------------

  const writes = new Map(); // file -> last write promise
  const queued = new Set(); // files with a write queued but not started
  const atomicWrite = async (file, text) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temp, text, 'utf8');
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  };
  /**
   * Queues a write of `snapshot()` (read when the write starts; null skips it).
   * → whether it landed (never rejects; a failure is logged).
   */
  const persistFile = (name, snapshot) => {
    const file = path.join(storageDir(), name);
    if (queued.has(file)) return writes.get(file);
    queued.add(file);
    const myGeneration = generation;
    const next = (writes.get(file) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        queued.delete(file);
        if (myGeneration !== generation) return true;
        const data = snapshot();
        if (data == null) return true;
        await atomicWrite(file, JSON.stringify(data));
        return true;
      })
      .catch((error) => {
        log(`couldn't save ${name}:`, error?.message ?? error);
        return false;
      });
    writes.set(file, next);
    return next;
  };
  const persistIndex = () =>
    persistFile(INDEX_FILE, () => ({ version: 1, bots: [...entries.values()].map((entry) => entry.bot) }));
  /** What a bot has claimed and answered: saved in its transcript file, with the messages it refers to. */
  const claimStateOf = (bot) => ({
    nextSeq: bot.nextSeq,
    processedSeq: bot.processedSeq,
    compactedThroughSeq: bot.compactedThroughSeq,
    requeue: bot.requeue ?? [],
    inFlight: bot.inFlight ?? [],
  });
  /**
   * Saves a bot: its transcript file holds its messages and its claim state
   * together (one atomic write), so a crash never leaves a claim without the
   * message it names, or a message marked answered without its reply. The
   * index (the bot list and settings) is saved too. → whether both landed.
   */
  // eslint-disable-next-line no-unused-vars -- callers still say whether messages changed
  const persistBot = (entry, _options = {}) => {
    const index = persistIndex();
    const id = entry.bot.id;
    const transcript = persistFile(`${id}.json`, () => {
      const current = entries.get(id);
      return current ? { version: 2, botId: id, messages: current.messages, claims: claimStateOf(current.bot) } : null;
    });
    const saved = Promise.all([index, transcript]).then(([a, b]) => a && b);
    entry.saved = saved;
    return saved;
  };
  /** Resolves when every queued write (including ones queued meanwhile) has landed. */
  const flush = async () => {
    let pending;
    do {
      pending = [...writes.values()];
      await Promise.all(pending);
    } while (writes.size !== pending.length || [...writes.values()].some((promise, index) => promise !== pending[index]));
  };

  const readJson = async (file) => {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      log(`couldn't read ${path.basename(file)}:`, error?.message ?? error);
      // Keep an unreadable file for the person; start without it.
      await fs.rename(file, `${file}.unreadable-${now()}`).catch(() => {});
      return null;
    }
  };

  const ensureLoaded = () => {
    loaded ??= (async () => {
      const base = storageDir();
      const index = await readJson(path.join(base, INDEX_FILE));
      const next = new Map();
      for (const raw of Array.isArray(index?.bots) ? index.bots : []) {
        const bot = normalizeBot(raw, now());
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(bot.id) || next.has(bot.id)) continue;
        const file = await readJson(path.join(base, `${bot.id}.json`));
        const messages = (Array.isArray(file?.messages) ? file.messages : []).map(normalizeMessage).filter(Boolean);
        messages.sort((a, b) => a.seq - b.seq);
        // The claim state saved with these messages wins over the index's
        // (written separately, it may be ahead of or behind the transcript).
        if (file?.claims && typeof file.claims === 'object') {
          const claims = file.claims;
          if (Number.isInteger(claims.processedSeq)) bot.processedSeq = claims.processedSeq;
          if (Number.isInteger(claims.compactedThroughSeq)) bot.compactedThroughSeq = claims.compactedThroughSeq;
          if (Number.isInteger(claims.nextSeq) && claims.nextSeq > 0) bot.nextSeq = Math.max(1, claims.nextSeq);
          bot.inFlight = [];
          bot.requeue = [...new Set([...seqList(claims.requeue), ...seqList(claims.inFlight)])].sort((a, b) => a - b);
        }
        const lastSeq = messages.length ? messages[messages.length - 1].seq : 0;
        if (bot.nextSeq <= lastSeq) bot.nextSeq = lastSeq + 1;
        next.set(bot.id, { bot, messages, compacting: false });
      }
      entries = next;
    })();
    return loaded;
  };

  // --- bots ---------------------------------------------------------------------------

  const createBotEntry = ({ name, job = '', emoji = null, role = 'bot', model = null, project = null }) => {
    const at = now();
    const bot = normalizeBot(
      {
        id: newId('lb'),
        name,
        job,
        emoji,
        role,
        project,
        model: claudeModelFrom(model) ?? (role === 'primary' ? LOCAL_PRIMARY_BOT_MODEL : LOCAL_BOT_DEFAULT_MODEL),
        createdAt: at,
        lastActivityAt: at,
      },
      at
    );
    const entry = { bot, messages: [], compacting: false };
    entries.set(bot.id, entry);
    persistBot(entry);
    changed();
    return entry;
  };

  const ensurePrimary = async () => {
    await ensureLoaded();
    const existing = [...entries.values()].find((entry) => entry.bot.role === 'primary');
    if (existing) return existing;
    return createBotEntry({ name: 'Durango', emoji: '✨', role: 'primary' });
  };

  const entryFor = (botId) => {
    const entry = entries.get(str(botId).trim());
    if (!entry) throw new LocalBotError('not_found', 'No such bot on this device.');
    return entry;
  };

  const lastPreview = (content) => clip(oneLine(content), 160) || null;

  const toDesktopBot = (entry) => {
    const { bot } = entry;
    const runtime = runtimes.get(bot.id);
    const replies = runtime ? [...runtime.replies.values()].map((reply) => ({ messageId: reply.id, place: LOCAL_BOT_PLACE })) : [];
    const waking = !bot.paused && !replies.length && (runtime?.pendingChecks > 0 || hasUnclaimed(entry));
    return {
      id: bot.id,
      name: bot.name,
      emoji: bot.emoji === LEGACY_PROJECT_BOT_EMOJI ? null : bot.emoji,
      role: bot.role,
      job: bot.job,
      model: bot.model,
      status: replies.length ? 'running' : waking ? 'waking' : 'idle',
      paused: bot.paused,
      replies,
      lastActivityAt: bot.lastActivityAt,
      lastPreview: bot.lastPreview,
      unread: bot.unread,
      needsYou: bot.needsYou,
      project: bot.project ? { key: bot.project.key, name: bot.project.name, repoId: bot.project.repoId } : null,
    };
  };

  const sortedEntries = () =>
    [...entries.values()].sort((a, b) =>
      a.bot.role !== b.bot.role ? (a.bot.role === 'primary' ? -1 : 1) : b.bot.lastActivityAt - a.bot.lastActivityAt
    );

  // --- inbox and replies --------------------------------------------------------------

  const unclaimed = (entry) => {
    const out = [];
    for (let index = entry.messages.length - 1; index >= 0; index -= 1) {
      const message = entry.messages[index];
      if (message.seq <= entry.bot.processedSeq) break;
      if (message.role === 'user') out.unshift(message);
    }
    // Released ones (a stopped or crashed reply's) first.
    const requeue = new Set(entry.bot.requeue ?? []);
    const released = requeue.size ? entry.messages.filter((message) => requeue.has(message.seq) && message.role === 'user') : [];
    return [...released, ...out];
  };
  function hasUnclaimed(entry) {
    return unclaimed(entry).length > 0;
  }

  const trimMessages = (entry) => {
    while (entry.messages.length > LOCAL_BOT_MESSAGE_CAP && entry.messages[0].seq <= entry.bot.compactedThroughSeq) {
      entry.messages.shift();
    }
  };

  /** Stores an incoming message (the person's, or labelled) and wakes the bot. Idempotent by id. */
  const appendInbox = (entry, { id, content, authorLabel = null, attachments = null }) => {
    if (id) {
      const existing = entry.messages.find((message) => message.id === id);
      if (existing) return existing;
    }
    const { bot } = entry;
    const message = {
      id: id || newId('lm'),
      seq: bot.nextSeq,
      role: 'user',
      content,
      authorLabel,
      createdAt: now(),
      ...(attachments?.length ? { attachments } : {}),
    };
    bot.nextSeq += 1;
    entry.messages.push(message);
    trimMessages(entry);
    bot.lastActivityAt = message.createdAt;
    bot.lastPreview = lastPreview(content);
    if (!authorLabel) bot.needsYou = false;
    persistBot(entry);
    changed();
    wake(entry);
    return message;
  };

  /** A reply starts if none runs; with one running, a parallel one after a few seconds if the message is still waiting. */
  const wake = (entry) => {
    if (!active || entry.bot.paused || !hasUnclaimed(entry)) return;
    const runtime = runtimeFor(entry.bot.id);
    if (runtime.replies.size === 0) {
      startReply(entry);
      return;
    }
    const myGeneration = generation;
    runtime.pendingChecks += 1;
    void Promise.resolve()
      .then(() => sleep(parallelAfterMs))
      .then(() => {
        runtime.pendingChecks -= 1;
        const current = entries.get(entry.bot.id);
        if (myGeneration !== generation || !active || current !== entry || entry.bot.paused) return;
        if (hasUnclaimed(entry) && runtime.replies.size < maxReplies) startReply(entry);
        changed();
      })
      .catch((error) => log('parallel reply check failed:', error?.message ?? error));
  };

  const inboxItem = (message) => {
    const source = inboxSourceOf(message.authorLabel);
    return { seq: message.seq, source, label: message.authorLabel, content: message.content };
  };

  /** Claims every unanswered inbox message for `reply`. */
  const claim = (entry, reply) => {
    const items = unclaimed(entry);
    if (!items.length) {
      // Requeued seqs whose messages are gone (trimmed): nothing to answer.
      if (entry.bot.requeue?.length) entry.bot.requeue = [];
      return [];
    }
    const seqs = items.map((message) => message.seq);
    entry.bot.processedSeq = Math.max(entry.bot.processedSeq, ...seqs);
    entry.bot.requeue = (entry.bot.requeue ?? []).filter((seq) => !seqs.includes(seq));
    entry.bot.inFlight = [...new Set([...(entry.bot.inFlight ?? []), ...seqs])];
    for (const message of items) reply.claimSeqs.push(message.seq);
    persistBot(entry, { messages: false });
    changed();
    return items;
  };

  const speaker = (message, botName) => {
    if (message.role === 'assistant') return `${botName} (you)`;
    return message.authorLabel ? `[${message.authorLabel}]` : 'Person';
  };
  const renderLine = (message, botName) => {
    const files = (message.attachments ?? []).map((item) => `[attached file: ${item.name}]`).join('\n');
    const text = message.content.trim();
    return `${speaker(message, botName)}:\n${[text, files].filter(Boolean).join('\n') || '(no text)'}`;
  };

  const renderContext = (entry, reply, claims) => {
    const { bot } = entry;
    const at = now();
    const counts = { person: 0, routine: 0, task: 0, bot: 0 };
    for (const message of claims) counts[inboxSourceOf(message.authorLabel)] += 1;
    const parts = [
      counts.person ? `${counts.person} message${counts.person === 1 ? '' : 's'} from the person` : null,
      counts.routine ? `${counts.routine} routine run${counts.routine === 1 ? '' : 's'}` : null,
      counts.task ? `${counts.task} task report${counts.task === 1 ? '' : 's'}` : null,
      counts.bot ? `${counts.bot} message${counts.bot === 1 ? '' : 's'} from other bots` : null,
    ].filter(Boolean);
    const zone = timeZone();
    const lines = [
      '(Bot context, not from the person.)',
      `This reply answers: ${parts.length ? parts.join(', ') : 'nothing new'} (the last messages above). Handle each one.`,
    ];
    const runtime = runtimeFor(bot.id);
    const others = [...runtime.replies.values()].filter((other) => other !== reply);
    if (others.length) {
      const seqs = new Set(others.flatMap((other) => other.claimSeqs));
      const answering = entry.messages.filter((message) => seqs.has(message.seq));
      if (answering.length) {
        lines.push(
          `Another reply of yours is already answering: ${answering
            .map((message) => `"${clip(oneLine(message.content), 120)}"`)
            .join('; ')}. Don't answer those here.`
        );
      }
    }
    lines.push(
      `You're running on this computer (${platform}) through the person's Claude Code. Now: ${formatAt(at)}${zone ? ` (${zone})` : ''}.`
    );
    if (counts.person === 0) {
      lines.push("The person didn't write this time: reply only as much as the items need, and use notify_user only for something worth their attention.");
    }
    if (runtime.tasks.size || runtime.threads.size) {
      lines.push(
        `Your tasks still running: ${[...runtime.tasks.values(), ...runtime.threads.values()]
          .map(
            (task) =>
              `"${task.title}" (${task.id}${task.project ? `, a Durango Code thread in ${task.project}` : ''}, started ${ago(task.startedAt, at)})`
          )
          .join('; ')}.`
      );
    }
    if (bot.routines.length) {
      lines.push(
        `Your routines: ${bot.routines
          .map(
            (routine) =>
              `"${routine.title}" (${routine.id}): ${scheduleText(routine.schedule)}${
                !routine.enabled ? ', off' : routine.nextRunAt ? `, next ${formatAt(routine.nextRunAt)}` : ''
              }`
          )
          .join('; ')}.`
      );
    }
    const roster = sortedEntries()
      .filter((other) => other !== entry)
      .map((other) => {
        const desktop = toDesktopBot(other);
        const state = [other.bot.role === 'primary' ? 'primary' : null, other.bot.paused ? 'paused' : desktop.status, other.bot.needsYou ? 'waiting on the person' : null]
          .filter(Boolean)
          .join(', ');
        const last = other.bot.lastPreview ? ` Last: "${clip(other.bot.lastPreview, 90)}" (${ago(other.bot.lastActivityAt, at)}).` : '';
        return `- ${other.bot.name} (${other.bot.id}; ${state}). Job: ${other.bot.job || 'general'}.${last}`;
      });
    if (roster.length) {
      lines.push(`${bot.role === 'primary' ? "The person's other bots" : "The person's other bots (message them with message_bot)"}:\n${roster.join('\n')}`);
    } else if (bot.role === 'primary') {
      lines.push('The person has no other bots yet.');
    }
    return lines.join('\n');
  };

  const botSystemPrompt = (bot) =>
    [
      LOCAL_BOT_PROMPT,
      `Your name is ${bot.name}.`,
      bot.role === 'primary' ? LOCAL_PRIMARY_BOT_PROMPT : null,
      bot.job.trim() ? `## Your job\n\n${bot.job.trim()}` : null,
      bot.project ? projectSection(bot.project) : null,
      bot.summary?.trim()
        ? `## Your earlier conversation with the person (summary)\n\nOlder messages of your thread were condensed into this summary; the messages after it follow in full.\n\n${bot.summary.trim()}`
        : null,
    ]
      .filter(Boolean)
      .join('\n\n');

  const buildLane = (entry, reply, claims) => {
    const { bot } = entry;
    const claimSeqs = new Set(claims.map((message) => message.seq));
    const lastClaim = claims[claims.length - 1].seq;
    const earlierAll = entry.messages.filter(
      (message) => message.seq > bot.compactedThroughSeq && message.seq <= lastClaim && !claimSeqs.has(message.seq)
    );
    // Bounded even when compaction keeps failing: the newest earlier messages.
    const earlier = [];
    let chars = 0;
    for (let index = earlierAll.length - 1; index >= 0; index -= 1) {
      const line = renderLine(earlierAll[index], bot.name);
      if (chars + line.length > PROMPT_HISTORY_MAX_CHARS && earlier.length) break;
      chars += line.length;
      earlier.unshift(line);
    }
    const prompt = [
      earlier.length ? `<conversation_so_far>\n${earlier.join('\n\n')}\n</conversation_so_far>` : null,
      `<new_messages>\n${claims.map((message) => renderLine(message, bot.name)).join('\n\n')}\n</new_messages>`,
      `<context>\n${renderContext(entry, reply, claims)}\n</context>`,
      'Write your reply to the new messages now. Your final text is sent to the person as your message in the thread.',
    ]
      .filter(Boolean)
      .join('\n\n');
    return {
      laneId: reply.id,
      botId: bot.id,
      botName: bot.name,
      model: bot.model,
      systemPrompt: botSystemPrompt(bot),
      prompt,
      tools: threadTools ? [...LOCAL_BOT_TOOLS, ...BOT_THREAD_TOOLS] : LOCAL_BOT_TOOLS,
      threads: 'local',
      heartbeatMs: HEARTBEAT_MS,
      // Files attached in the conversation (the newest): the runner copies them for Claude Code.
      attachments: entry.messages
        .flatMap((message) => (message.attachments ?? []).map((item) => ({ id: message.id, name: item.name, path: item.path })))
        .slice(-10),
    };
  };

  const startReply = (entry) => {
    const runtime = runtimeFor(entry.bot.id);
    if (runtime.replies.size >= maxReplies) return;
    const reply = {
      id: newId('lm'),
      abort: new AbortController(),
      text: '',
      activeTool: null,
      claimSeqs: [],
      startedAt: now(),
    };
    const claims = claim(entry, reply);
    if (!claims.length) return;
    runtime.replies.set(reply.id, reply);
    changed();
    const lane = buildLane(entry, reply, claims);
    track(runReply(entry, reply, lane));
  };

  const runReply = async (entry, reply, lane) => {
    const myGeneration = generation;
    const runtime = runtimeFor(entry.bot.id);
    let outcome;
    try {
      outcome = await runLane(lane, {
        signal: reply.abort.signal,
        accessMode: getAccessMode() || 'read-only',
        update: ({ text, activeTool } = {}) => {
          if (reply.abort.signal.aborted) return;
          if (typeof text === 'string') reply.text = text;
          // The reply takes its place in the thread when it first shows text:
          // what the person sends after that comes below it.
          if (reply.seq === undefined && reply.text.trim()) {
            reply.seq = entry.bot.nextSeq;
            entry.bot.nextSeq += 1;
            persistBot(entry, { messages: false });
          }
          reply.activeTool = activeTool || null;
          changed();
        },
        takeInbox: async () => (reply.abort.signal.aborted ? [] : claim(entry, reply).map(inboxItem)),
        callTool: async ({ name, input }) => ({ result: await callTool(entry, name, input) }),
      });
    } catch (error) {
      outcome = { text: reply.text, failure: error?.message ?? String(error) };
    }
    runtime.replies.delete(reply.id);
    const current = myGeneration === generation && entries.get(entry.bot.id) === entry;
    if (!current) return;
    const settleClaims = () => {
      entry.bot.inFlight = (entry.bot.inFlight ?? []).filter((seq) => !reply.claimSeqs.includes(seq));
    };
    if (reply.abort.signal.aborted || outcome?.aborted) {
      // Stopped here (quit, sign-in): these messages are answered next time.
      settleClaims();
      entry.bot.requeue = [...new Set([...(entry.bot.requeue ?? []), ...reply.claimSeqs])].sort((a, b) => a - b);
      persistBot(entry, { messages: false });
      changed();
      return;
    }
    settleClaims();
    const text = str(outcome?.text).trim();
    const failure = outcome?.failure ? clip(oneLine(outcome.failure), 300) : null;
    const content = text || (failure ? `Couldn't reply on this computer: ${failure}` : '');
    if (content) {
      const { bot } = entry;
      const message = { id: reply.id, seq: reply.seq ?? bot.nextSeq, role: 'assistant', content, authorLabel: null, createdAt: now() };
      if (reply.seq === undefined) bot.nextSeq += 1;
      // In thread order: a reply placed early stays above what came after it.
      const at = entry.messages.findIndex((existing) => existing.seq > message.seq);
      if (at === -1) entry.messages.push(message);
      else entry.messages.splice(at, 0, message);
      trimMessages(entry);
      bot.lastActivityAt = message.createdAt;
      bot.lastPreview = lastPreview(content);
      bot.unread += 1;
    }
    persistBot(entry, { messages: Boolean(content) });
    changed();
    if (!runtime.replies.size && hasUnclaimed(entry) && active && !entry.bot.paused) startReply(entry);
    await compactIfNeeded(entry);
  };

  // --- compaction ---------------------------------------------------------------------

  const compactIfNeeded = async (entry) => {
    if (!summarize || entry.compacting) return;
    const { bot } = entry;
    const rows = entry.messages.filter((message) => message.seq > bot.compactedThroughSeq);
    const boundary = compactionBoundary(rows);
    if (boundary === null) return;
    entry.compacting = true;
    const myGeneration = generation;
    const expected = bot.compactedThroughSeq;
    try {
      const folded = rows.filter((row) => row.seq <= boundary);
      const transcript = folded
        .map((row) => {
          const text = row.content.length > SUMMARY_ROW_CHARS ? `${row.content.slice(0, SUMMARY_ROW_CHARS)} […]` : row.content;
          return `[${row.role === 'assistant' ? `${bot.name} (you)` : row.authorLabel ?? 'Person'}]\n${text.trim() || '(no text)'}`;
        })
        .join('\n\n');
      const summary = await summarize({
        model: LOCAL_BOT_COMPACTION_MODEL,
        systemPrompt: LOCAL_COMPACTION_PROMPT,
        prompt: [
          bot.summary?.trim() ? `<previous_summary>\n${bot.summary.trim()}\n</previous_summary>` : '<previous_summary>(none yet)</previous_summary>',
          `<new_messages>\n${transcript}\n</new_messages>`,
        ].join('\n\n'),
      });
      const text = str(summary).trim();
      if (!text || myGeneration !== generation || entries.get(bot.id) !== entry || bot.compactedThroughSeq !== expected) return;
      bot.summary = text;
      bot.compactedThroughSeq = boundary;
      trimMessages(entry);
      persistBot(entry);
    } catch (error) {
      log(`couldn't summarize ${bot.name}'s older messages:`, error?.message ?? error);
    } finally {
      entry.compacting = false;
    }
  };

  // --- tasks --------------------------------------------------------------------------

  const startTask = (entry, { title, instructions }) => {
    const runtime = runtimeFor(entry.bot.id);
    if (runtime.tasks.size >= LOCAL_BOT_MAX_TASKS) {
      throw new Error(`You already have ${runtime.tasks.size} tasks running: wait for a report first.`);
    }
    const task = { id: newId('lt'), title: clip(oneLine(title), 80) || 'Task', startedAt: now(), abort: new AbortController() };
    runtime.tasks.set(task.id, task);
    const myGeneration = generation;
    const lane = {
      laneId: task.id,
      botId: entry.bot.id,
      botName: entry.bot.name,
      model: entry.bot.model,
      systemPrompt: `${LOCAL_TASK_PROMPT}\n\nThe bot "${entry.bot.name}" handed you the task "${task.title}". The task follows as the message.`,
      prompt: instructions,
      tools: [],
      heartbeatMs: HEARTBEAT_MS,
    };
    track(
      (async () => {
        let outcome;
        try {
          outcome = await runLane(lane, {
            signal: task.abort.signal,
            accessMode: getAccessMode() || 'read-only',
            update: () => {},
            takeInbox: async () => [],
            callTool: async ({ name }) => ({ result: { ok: false, error: `No tool named ${name} in a task.` } }),
          });
        } catch (error) {
          outcome = { text: '', failure: error?.message ?? String(error) };
        }
        runtime.tasks.delete(task.id);
        if (myGeneration !== generation || entries.get(entry.bot.id) !== entry || task.abort.signal.aborted || outcome?.aborted) return;
        const text = str(outcome?.text).trim();
        const report = text || `The task couldn't finish: ${clip(oneLine(outcome?.failure) || 'it ended without a report.', 300)}`;
        appendInbox(entry, { content: report, authorLabel: inboxLabel('task', task.title) });
      })()
    );
    changed();
    return task;
  };

  // A task in a project: a real Durango Code thread there (started through the
  // app's window, like an agent from Durango Chat). Its outcome comes back
  // through threadSettled and lands in the bot's inbox as a task report.
  const projectNameKey = (value) => str(value).trim().toLowerCase();
  /** A project from listProjects → Durango's key (its repo, else this device's project). */
  const projectKeyOf = (project) => localProjectKey({ repoId: project.repoId ?? null, machineId: LOCAL_MACHINE, projectId: project.id });

  const resolveProject = async (name) => {
    const projects = (await listProjects().catch(() => [])) ?? [];
    const wanted = projectNameKey(name);
    const match =
      projects.find((project) => projectNameKey(project?.name) === wanted) ??
      projects.find((project) => projectNameKey(path.basename(str(project?.path))) === wanted);
    if (!match) {
      const names = projects.map((project) => project?.name).filter(Boolean);
      throw new Error(
        names.length
          ? `No Durango Code project named "${name}" on this computer. Projects: ${names.join(', ')}.`
          : 'No Durango Code projects are open on this computer (or none are allowed for Durango).'
      );
    }
    return match;
  };

  const startThreadTask = async (entry, { title, instructions, project: projectName }) => {
    if (!startProjectThread) throw new Error('Durango Code threads are not available here.');
    const runtime = runtimeFor(entry.bot.id);
    if (runtime.threads.size >= LOCAL_BOT_MAX_TASKS) {
      throw new Error(`You already have ${runtime.threads.size} Durango Code threads running: wait for a report first.`);
    }
    const project = await resolveProject(projectName);
    const task = { id: newId('lt'), title: clip(oneLine(title), 80) || 'Task', project: project.name, startedAt: now() };
    const key = `${entry.bot.id}:${task.id}`;
    runtime.threads.set(key, task);
    await loadProjects();
    const brief = projectBriefFor(projectKeyOf(project), project.name);
    const started = await Promise.resolve(
      startProjectThread({
        projectId: project.id,
        prompt: `${brief ? `${brief}\n\n` : ''}${instructions}\n\nWhen you're done, end with a concise report of the outcome (with the change id and its URL, if you opened one): it goes back to the bot "${entry.bot.name}" that asked for this.`,
        key,
        botName: entry.bot.name,
        title: task.title,
        accessMode: getAccessMode() || 'read-only',
      })
    ).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
    if (!started?.ok) {
      runtime.threads.delete(key);
      throw new Error(started?.error || 'The Durango Code thread could not start.');
    }
    task.threadId = started.threadId ?? null;
    changed();
    return task;
  };

  // --- projects: project bots, notes and files ----------------------------------------
  // Notes and file records by project key in projects.json; file bytes under
  // project-files/<hash of the key>/<name>.

  let projectStore = null; // { [key]: { notes: [...], files: [...] } }
  const loadProjects = async () => {
    if (projectStore) return projectStore;
    const raw = await readJson(path.join(storageDir(), PROJECTS_FILE));
    projectStore = raw && typeof raw.projects === 'object' && raw.projects ? raw.projects : {};
    return projectStore;
  };
  const persistProjects = () => persistFile(PROJECTS_FILE, () => (projectStore ? { version: 1, projects: projectStore } : null));
  const projectOf = (key, name) => {
    projectStore[key] ??= { notes: [], files: [] };
    const record = projectStore[key];
    if (name) record.name = name;
    record.notes = Array.isArray(record.notes) ? record.notes : [];
    record.files = Array.isArray(record.files) ? record.files : [];
    return record;
  };
  const projectDir = (key) => path.join(storageDir(), PROJECT_FILES_DIR, crypto.createHash('sha256').update(key).digest('hex').slice(0, 24));

  const projectBotEntries = () => [...entries.values()].filter((entry) => entry.bot.project);

  /**
   * Which project a tool call means: a project name (or its bot's name, or
   * any project on this computer), else the bot's own. → { key, name }.
   */
  const resolveHomeProject = async (self, name) => {
    const wanted = oneLine(name).toLowerCase();
    if (!wanted) {
      if (self?.bot.project) return self.bot.project;
      throw new Error('Name the project.');
    }
    const match = projectBotEntries().find((entry) => entry.bot.project.name.toLowerCase() === wanted || entry.bot.name.toLowerCase() === wanted);
    if (match) return match.bot.project;
    const project = await resolveProject(name);
    return { key: projectKeyOf(project), name: project.name };
  };

  const notesBlock = (notes) => {
    const lines = [];
    let used = 0;
    for (let index = notes.length - 1; index >= 0; index -= 1) {
      const line = `- ${oneLine(notes[index].content)}`;
      if (used + line.length > LOCAL_PROJECT_LIMITS.promptNotesChars && lines.length) break;
      used += line.length;
      lines.unshift(line);
    }
    return lines.join('\n');
  };

  // Read synchronously by the prompt builders (the store is loaded before replies start).
  const projectSection = (project) => {
    const record = projectStore?.[project.key] ?? { notes: [], files: [] };
    const notes = notesBlock(record.notes ?? []);
    const files = (record.files ?? []).map((file) => file.name);
    return [
      `## Your project: ${project.name}`,
      `You are this project's bot: its Durango Code project on this computer. Work in it by starting Durango Code threads there (delegate_task with \`project: "${project.name}"\`), several at once when the work splits; see where it stands with list_threads and read_thread, steer threads with message_thread, and report what matters. Keep what should be remembered about the project in its notes (remember_project) and its documents in its files (save_project_file): every bot and every thread you start there sees them. You aren't limited to this project.`,
      notes ? `Project notes (oldest first):\n${notes}` : 'No project notes yet.',
      files.length ? `Project files (read_project_file): ${files.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('\n\n');
  };

  /** A project's notes for a thread started in it (or ''), by its key: a project needs no bot. */
  const projectBriefFor = (key, name) => {
    const record = projectStore?.[key];
    if (!record || (!record.notes?.length && !record.files?.length)) return '';
    return [
      `[Project notes: ${name}]`,
      notesBlock(record.notes ?? []) || null,
      record.files?.length ? `Project files (kept with the project): ${record.files.map((file) => file.name).join(', ')}` : null,
      '[/Project notes]',
    ]
      .filter(Boolean)
      .join('\n');
  };

  const addNote = async (project, content, author) => {
    await loadProjects();
    const text = str(content).trim();
    if (!text) throw new Error('Write the note first.');
    if (text.length > LOCAL_PROJECT_LIMITS.noteChars) throw new Error(`Keep a note under ${LOCAL_PROJECT_LIMITS.noteChars} characters.`);
    const record = projectOf(project.key, project.name);
    if (record.notes.some((note) => note.content.trim().toLowerCase() === text.toLowerCase())) return { ok: true, duplicate: true };
    if (record.notes.length >= LOCAL_PROJECT_LIMITS.notesPerProject) throw new Error('This project has too many notes: forget some first.');
    const note = { id: newId('ln'), content: text, author: clip(oneLine(author) || 'you', 60), createdAt: now() };
    record.notes.push(note);
    persistProjects();
    changed();
    return { ok: true, noteId: note.id };
  };

  const deleteNote = async (noteId) => {
    await loadProjects();
    for (const record of Object.values(projectStore)) {
      const index = (record.notes ?? []).findIndex((note) => note.id === noteId);
      if (index >= 0) {
        record.notes.splice(index, 1);
        persistProjects();
        changed();
        return { ok: true };
      }
    }
    return { ok: false };
  };

  const filePath = (project, name) => path.join(projectDir(project.key), safeFileName(name));

  const saveFile = async (project, name, bytes, { author = 'you', contentType = null } = {}) => {
    await loadProjects();
    const fileName = safeFileName(name);
    if (!fileName) throw new Error('Give the file a name.');
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(str(bytes), 'utf8');
    if (buffer.length > LOCAL_PROJECT_LIMITS.fileBytes) throw new Error('Files can be up to 10 MB.');
    const record = projectOf(project.key, project.name);
    const existing = record.files.find((file) => file.name === fileName);
    if (!existing && record.files.length >= LOCAL_PROJECT_LIMITS.filesPerProject) throw new Error('This project has too many files: remove some first.');
    await fs.mkdir(projectDir(project.key), { recursive: true });
    await atomicWrite(filePath(project, fileName), buffer);
    const meta = { name: fileName, size: buffer.length, contentType: contentType || guessContentType(fileName), author: clip(oneLine(author) || 'you', 60), updatedAt: now() };
    if (existing) Object.assign(existing, meta);
    else record.files.push(meta);
    persistProjects();
    changed();
    return { ok: true, name: fileName, replaced: Boolean(existing) };
  };

  const deleteFile = async (project, name) => {
    await loadProjects();
    const record = projectOf(project.key);
    const index = record.files.findIndex((file) => file.name === name);
    if (index < 0) return { ok: false };
    record.files.splice(index, 1);
    await fs.rm(filePath(project, name), { force: true }).catch(() => {});
    persistProjects();
    changed();
    return { ok: true };
  };

  const projectView = async (entry) => {
    await loadProjects();
    const { project } = entry.bot;
    const record = projectStore[project.key] ?? { notes: [], files: [] };
    return {
      projectKey: project.key,
      name: project.name,
      botId: entry.bot.id,
      notes: [...(record.notes ?? [])].sort((a, b) => b.createdAt - a.createdAt).map((note) => ({ ...note })),
      files: [...(record.files ?? [])]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((file) => ({ id: file.name, ...file, url: null, path: filePath(project, file.name) })),
    };
  };

  const ensureProjectBot = async ({ name, projectId, repoId, machineId }) => {
    await ensurePrimary();
    await loadProjects();
    const key = localProjectKey({ repoId, machineId: machineId || 'this-device', projectId });
    if (!key) throw new LocalBotError('invalid', 'A project needs its id.');
    const projectName = clip(oneLine(name), 120) || 'Project';
    const existing = projectBotEntries().find((entry) => entry.bot.project.key === key);
    if (existing) {
      if (existing.bot.emoji === LEGACY_PROJECT_BOT_EMOJI) {
        existing.bot.emoji = null;
        persistBot(existing, { messages: false });
        changed();
      }
      if (existing.bot.project.name !== projectName) {
        if (existing.bot.name === clip(existing.bot.project.name, 40)) existing.bot.name = clip(projectName, 40);
        existing.bot.project = { ...existing.bot.project, name: projectName };
        persistBot(existing, { messages: false });
        changed();
      }
      return existing;
    }
    return createBotEntry({
      name: clip(projectName, 40),
      job: localProjectBotJob(projectName),
      project: { key, name: projectName, projectId: projectId || null, repoId: repoId || null },
    });
  };

  // --- routines -----------------------------------------------------------------------

  const findRoutine = (routineId, botId) => {
    for (const entry of botId ? [entryFor(botId)] : entries.values()) {
      const routine = entry.bot.routines.find((candidate) => candidate.id === routineId);
      if (routine) return { entry, routine };
    }
    throw new Error('No such routine.');
  };

  const firstRunAt = (schedule) => (schedule.kind === 'once' ? schedule.at : nextRunAfter(schedule, now()));

  const addRoutine = (entry, { title, instructions, schedule }) => {
    const parsed = parseSchedule(schedule, now());
    const routine = {
      id: newId('lr'),
      title: clip(oneLine(title), 80) || 'Routine',
      instructions: str(instructions),
      schedule: parsed,
      nextRunAt: firstRunAt(parsed),
      enabled: true,
    };
    entry.bot.routines.push(routine);
    persistBot(entry, { messages: false });
    return routine;
  };

  const routineResult = (routine) => ({
    ok: true,
    routineId: routine.id,
    title: routine.title,
    schedule: scheduleText(routine.schedule),
    enabled: routine.enabled,
    nextRunAt: routine.nextRunAt ? new Date(routine.nextRunAt).toISOString() : null,
  });

  const tickRoutines = async () => {
    await ensureLoaded();
    const at = now();
    for (const entry of [...entries.values()]) {
      let touched = false;
      for (const routine of entry.bot.routines) {
        if (!routine.enabled || routine.nextRunAt == null || routine.nextRunAt > at) continue;
        touched = true;
        routine.nextRunAt = nextRunAfter(routine.schedule, Math.max(at, routine.nextRunAt));
        if (routine.schedule.kind === 'once') routine.enabled = false;
        // A paused bot skips its runs (they don't pile up).
        if (!entry.bot.paused) {
          appendInbox(entry, { content: routine.instructions || routine.title, authorLabel: inboxLabel('routine', routine.title) });
        }
      }
      if (touched) persistBot(entry, { messages: false });
    }
  };

  // --- tool calls ---------------------------------------------------------------------

  const peek = (entry, limit) =>
    entry.messages.slice(-limit).map((message) => ({
      role: message.role,
      from: message.role === 'assistant' ? entry.bot.name : message.authorLabel ?? 'Person',
      content: clip(message.content, 2_000),
      at: new Date(message.createdAt).toISOString(),
    }));

  const callTool = async (self, name, rawInput) => {
    const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
    try {
      switch (name) {
        case 'delegate_task': {
          const title = oneLine(input.title);
          const instructions = str(input.instructions).trim();
          if (!title || !instructions) throw new Error('delegate_task needs a title and instructions.');
          if (str(input.project).trim()) {
            const task = await startThreadTask(self, { title, instructions, project: str(input.project).trim() });
            return {
              ok: true,
              taskId: task.id,
              title: task.title,
              project: task.project,
              ...(task.threadId ? { threadId: task.threadId } : {}),
              status: 'running',
              note: 'A Durango Code thread is working on it in that project; the person can watch it in the app. Its report will arrive in your inbox.',
            };
          }
          const task = startTask(self, { title, instructions });
          return { ok: true, taskId: task.id, title: task.title, status: 'running', note: 'The report will arrive in your inbox.' };
        }
        case 'create_bot': {
          const botName = oneLine(input.name);
          const job = str(input.job).trim();
          const routines = Array.isArray(input.routines) ? input.routines.slice(0, 5) : [];
          for (const routine of routines) parseSchedule(routine?.schedule, now()); // fail before creating anything
          let created;
          if (oneLine(input.project)) {
            const project = await resolveProject(input.project);
            const key = projectKeyOf(project);
            const existed = projectBotEntries().find((entry) => entry.bot.project.key === key);
            if (existed) return { ok: true, botId: existed.bot.id, name: existed.bot.name, project: existed.bot.project.name, note: 'That project already has this bot.' };
            created = await ensureProjectBot({ name: project.name, projectId: project.id, repoId: project.repoId ?? null, machineId: LOCAL_MACHINE });
            if (botName) created.bot.name = clip(botName, 40);
            if (job) created.bot.job = job;
            if (botName || job) persistBot(created, { messages: false });
          } else {
            if (!botName || !job) throw new Error('create_bot needs a name and a job.');
            created = createBotEntry({ name: clip(botName, 40), job, emoji: clip(oneLine(input.emoji), 8) || null });
          }
          const titles = routines.map((routine) => addRoutine(created, routine).title);
          if (str(input.first_message).trim()) {
            appendInbox(created, { content: str(input.first_message).trim(), authorLabel: inboxLabel('bot', self.bot.name) });
          }
          return { ok: true, botId: created.bot.id, name: created.bot.name, routines: titles };
        }
        case 'update_bot': {
          const target = input.bot_id ? entryFor(input.bot_id) : self;
          const { bot } = target;
          if (input.model !== undefined) {
            const model = claudeModelFrom(input.model);
            if (!model) throw new Error('Use a Claude model id, e.g. "claude-sonnet-5-5".');
            bot.model = model;
          }
          if (input.name !== undefined && oneLine(input.name)) bot.name = clip(oneLine(input.name), 40);
          if (input.job !== undefined) bot.job = str(input.job).trim();
          if (input.emoji !== undefined) bot.emoji = clip(oneLine(input.emoji), 8) || null;
          if (typeof input.paused === 'boolean') bot.paused = input.paused;
          persistBot(target, { messages: false });
          changed();
          // Paused: no new replies (one in progress finishes). Resumed: answer what waited.
          if (!bot.paused) wake(target);
          return { ok: true, bot: { id: bot.id, name: bot.name, model: bot.model, paused: bot.paused } };
        }
        case 'message_bot': {
          const target = entryFor(input.bot_id);
          if (target === self) throw new Error("That's you: message another bot.");
          const message = str(input.message).trim();
          if (!message) throw new Error('message_bot needs a message.');
          appendInbox(target, { content: message, authorLabel: inboxLabel('bot', self.bot.name) });
          return { ok: true, to: target.bot.name };
        }
        case 'read_bot': {
          const target = entryFor(input.bot_id);
          const limit = Math.min(40, Math.max(1, Number.isInteger(input.limit) ? input.limit : 10));
          const desktop = toDesktopBot(target);
          return {
            ok: true,
            bot: { id: target.bot.id, name: target.bot.name, job: target.bot.job, status: desktop.status, paused: target.bot.paused, needsYou: target.bot.needsYou },
            messages: peek(target, limit),
          };
        }
        case 'manage_routine': {
          if (input.action === 'create') {
            if (!str(input.title).trim() || !str(input.instructions).trim() || !input.schedule) {
              throw new Error('create needs title, instructions and schedule.');
            }
            const target = input.bot_id ? entryFor(input.bot_id) : self;
            return routineResult(addRoutine(target, input));
          }
          if (input.action !== 'update' && input.action !== 'delete') throw new Error('action must be create, update or delete.');
          if (!str(input.routine_id)) throw new Error(`${input.action} needs routine_id.`);
          const { entry, routine } = findRoutine(str(input.routine_id), input.bot_id ? str(input.bot_id) : null);
          if (input.action === 'delete') {
            entry.bot.routines = entry.bot.routines.filter((candidate) => candidate !== routine);
            persistBot(entry, { messages: false });
            return { ok: true, deleted: routine.id };
          }
          if (input.schedule) {
            routine.schedule = parseSchedule(input.schedule, now());
            routine.nextRunAt = firstRunAt(routine.schedule);
          }
          if (input.title !== undefined && oneLine(input.title)) routine.title = clip(oneLine(input.title), 80);
          if (input.instructions !== undefined && str(input.instructions).trim()) routine.instructions = str(input.instructions);
          if (typeof input.enabled === 'boolean') {
            routine.enabled = input.enabled;
            if (input.enabled && routine.nextRunAt == null) routine.nextRunAt = firstRunAt(routine.schedule);
          }
          persistBot(entry, { messages: false });
          return routineResult(routine);
        }
        case 'project_notes': {
          await loadProjects();
          const project = (await resolveHomeProject(self, input.project));
          const record = projectStore[project.key] ?? { notes: [], files: [] };
          return {
            ok: true,
            project: project.name,
            notes: (record.notes ?? []).map((note) => ({ id: note.id, note: note.content, by: note.author })),
            files: (record.files ?? []).map((file) => ({ name: file.name, size: file.size, type: file.contentType })),
          };
        }
        case 'remember_project':
          return await addNote((await resolveHomeProject(self, input.project)), input.note, self.bot.name);
        case 'forget_project_note':
          return await deleteNote(str(input.note_id));
        case 'read_project_file': {
          await loadProjects();
          const project = (await resolveHomeProject(self, input.project));
          const record = projectStore[project.key] ?? { notes: [], files: [] };
          const wanted = str(input.name).trim();
          const file =
            (record.files ?? []).find((item) => item.name === wanted) ??
            (record.files ?? []).find((item) => item.name.toLowerCase() === wanted.toLowerCase());
          if (!file) throw new Error(`No file "${wanted}" in ${project.name}. Files: ${(record.files ?? []).map((item) => item.name).join(', ') || 'none'}.`);
          const location = filePath(project, file.name);
          if (!isTextFile(file)) return { ok: true, name: file.name, type: file.contentType, size: file.size, path: location, note: 'Not a text file: open it from its path.' };
          const text = await fs.readFile(location, 'utf8');
          const max = LOCAL_PROJECT_LIMITS.readChars;
          return { ok: true, name: file.name, content: text.length > max ? `${text.slice(0, max)}\n…[${text.length - max} more characters]` : text };
        }
        case 'save_project_file':
          return await saveFile((await resolveHomeProject(self, input.project)), input.name, str(input.content), { author: self.bot.name });
        case 'list_threads':
        case 'read_thread': {
          if (!threadTools) throw new Error('Threads are not available here.');
          return name === 'list_threads' ? await threadTools.list(input) : await threadTools.read(input);
        }
        case 'message_thread': {
          if (!threadTools || !startThreadFollowUp) throw new Error('Follow-ups are not available here.');
          const { entry: thread } = await threadTools.findThread(input.thread_id);
          const message = str(input.message).trim();
          if (!message) throw new Error('message_thread needs a message.');
          const runtime = runtimeFor(self.bot.id);
          const task = { id: newId('lt'), title: clip(oneLine(input.title) || `Follow-up: ${thread.title || 'thread'}`, 80), project: null, threadId: thread.id, startedAt: now() };
          const key = `${self.bot.id}:${task.id}`;
          runtime.threads.set(key, task);
          const started = await Promise.resolve(
            startThreadFollowUp({
              threadId: thread.id,
              prompt: `${message}\n\n(From the bot "${self.bot.name}": end with a concise report of the outcome, with the change id and its URL if there is one; it goes back to the bot.)`,
              key,
              botName: self.bot.name,
              accessMode: getAccessMode() || 'read-only',
            })
          ).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
          if (!started?.ok) {
            runtime.threads.delete(key);
            throw new Error(started?.error || 'The follow-up could not start.');
          }
          changed();
          return { ok: true, taskId: task.id, threadId: thread.id, status: 'running', note: 'The thread is working on it; the outcome will arrive in your inbox.' };
        }
        case 'notify_user': {
          const title = oneLine(input.title);
          if (!title) throw new Error('notify_user needs a title.');
          notify({ title: clip(`${self.bot.name}: ${title}`, 120), body: clip(str(input.message).trim(), 600) });
          return { ok: true };
        }
        case 'ask_user': {
          const question = oneLine(input.question);
          const options = (Array.isArray(input.options) ? input.options : []).map(oneLine).filter(Boolean).slice(0, 6);
          if (!question) throw new Error('ask_user needs a question.');
          self.bot.needsYou = true;
          persistBot(self, { messages: false });
          changed();
          notify({ title: clip(`${self.bot.name} needs you`, 120), body: clip(question, 600) });
          return {
            ok: true,
            asked: question,
            options,
            note: 'Write the question and these options in your reply now (the person reads your reply), then end it. Their answer arrives as their next message.',
          };
        }
        default:
          return { ok: false, error: `No tool named ${name}.` };
      }
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  };

  // --- lifecycle ----------------------------------------------------------------------

  const abortAll = () => {
    for (const runtime of runtimes.values()) {
      for (const reply of runtime.replies.values()) reply.abort.abort();
      for (const task of runtime.tasks.values()) task.abort.abort();
    }
  };

  const resumePending = async () => {
    await ensureLoaded();
    if (!active) return;
    for (const entry of entries.values()) wake(entry);
  };

  // --- export ---------------------------------------------------------------------------

  const exportForSync = async () => {
    await ensureLoaded();
    await loadProjects();
    const zone = timeZone();
    return {
      bots: sortedEntries().map(({ bot, messages }) => ({
        localId: bot.id,
        name: bot.name,
        emoji: bot.emoji,
        role: bot.role,
        job: bot.job,
        model: durangoModelForLocalBot(bot.model),
        summary: bot.summary,
        messages: messages.map((message) => ({
          // Its id here: the upload keys it by this, so a retried upload
          // recognises it whatever else was added meanwhile.
          ...(message.id ? { id: String(message.id) } : {}),
          role: message.role,
          content: message.attachments?.length
            ? `${message.content}${message.content ? '\n' : ''}[attached on this device: ${message.attachments.map((item) => item.name).join(', ')}]`
            : message.content,
          authorLabel: message.authorLabel,
          createdAt: message.createdAt,
          // Not answered here yet: Durango answers it after the upload.
          ...(message.role === 'user' &&
          (message.seq > bot.processedSeq || (bot.requeue ?? []).includes(message.seq) || (bot.inFlight ?? []).includes(message.seq))
            ? { pending: true }
            : {}),
        })),
        routines: bot.routines.map((routine) => ({
          title: routine.title,
          instructions: routine.instructions,
          schedule: routine.schedule.kind === 'daily' && zone ? { ...routine.schedule, timeZone: zone } : routine.schedule,
        })),
        ...(bot.project ? exportProject(bot.project) : {}),
      })),
      projects: exportProjects(),
    };
  };

  // A local project bot uploads with its project (Durango's key: the repo, or
  // this machine's project) and the project's notes; files go up separately
  // (projectFilesForSync), after the bots exist on Durango.
  const exportProject = (project) => ({
    project: {
      name: project.name,
      ...(project.repoId ? { repoId: project.repoId } : {}),
      ...(project.key.startsWith('local:') ? { machineId: project.key.split(':')[1], projectId: project.projectId } : {}),
    },
  });

  // Every project library with notes (a project needs no bot for them), by key.
  const exportProjects = () =>
    Object.entries(projectStore ?? {})
      .filter(([, record]) => (record?.notes ?? []).length > 0)
      .map(([key, record]) => {
        const bot = projectBotEntries().find((entry) => entry.bot.project.key === key);
        return { key, name: bot?.bot.project.name ?? record.name ?? key, notes: record.notes.map((note) => note.content) };
      });

  return {
    ensurePrimary: async () => toDesktopBot(await ensurePrimary()),
    async list() {
      await ensurePrimary();
      return { allowed: true, bots: sortedEntries().map(toDesktopBot) };
    },
    async thread(botId, { limit = 120, read = false } = {}) {
      await ensureLoaded();
      const entry = entryFor(botId);
      if (read && entry.bot.unread) {
        entry.bot.unread = 0;
        persistBot(entry, { messages: false });
      }
      const count = Math.min(500, Math.max(1, Number.isInteger(limit) ? limit : 120));
      const runtime = runtimes.get(entry.bot.id);
      return {
        bot: toDesktopBot(entry),
        messages: entry.messages.slice(-count).map(({ attachments, ...message }) => ({
          ...message,
          ...(attachments?.length ? { files: attachments.map((item) => ({ name: item.name, size: item.size })) } : {}),
        })),
        live: runtime
          ? [...runtime.replies.values()].map((reply) => ({
              messageId: reply.id,
              seq: reply.seq ?? null,
              place: LOCAL_BOT_PLACE,
              content: reply.text,
              activeTool: reply.activeTool,
            }))
          : [],
        hasMore: entry.messages.length > count,
      };
    },
    async markRead(botId) {
      await ensureLoaded();
      const entry = entryFor(botId);
      if (!entry.bot.unread) return;
      entry.bot.unread = 0;
      persistBot(entry, { messages: false });
      changed();
    },
    /** The person's message: stored, then answered (never blocked by a reply in progress). → { seq } */
    async send(botId, { messageId, content, files = [] } = {}) {
      await ensureLoaded();
      const entry = entryFor(botId);
      const text = str(content);
      const picked = (Array.isArray(files) ? files : []).filter((file) => file && typeof file.path === 'string' && file.path).slice(0, 10);
      if (!text.trim() && !picked.length) throw new LocalBotError('invalid', 'Write a message first.');
      const id = str(messageId).slice(0, 128) || newId('lm');
      // Copied into the bots folder: the message keeps them even if the originals move.
      const attachments = [];
      if (picked.length && !entry.messages.some((message) => message.id === id)) {
        const dir = path.join(storageDir(), 'attachments', id.replace(/[^A-Za-z0-9_-]/g, '_'));
        await fs.mkdir(dir, { recursive: true });
        for (const file of picked) {
          const stat = await fs.stat(file.path).catch(() => null);
          if (!stat?.isFile()) throw new LocalBotError('invalid', `Can't read ${path.basename(file.path)}.`);
          if (stat.size > 25 * 1024 * 1024) throw new LocalBotError('invalid', `${path.basename(file.path)} is over 25 MB.`);
          const name = (str(file.name) || path.basename(file.path)).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120) || 'file';
          const target = path.join(dir, `${attachments.length}-${name}`);
          await fs.copyFile(file.path, target);
          attachments.push({ name, path: target, size: stat.size, contentType: str(file.contentType) });
        }
      }
      const message = appendInbox(entry, { id, content: text, ...(attachments.length ? { attachments } : {}) });
      // "Sent" only once it is on disk (a retry with the same id is harmless).
      if (!(await (entry.saved ?? Promise.resolve(true)))) {
        throw new LocalBotError('storage', 'Couldn’t save your message on this device. Try again.');
      }
      return { seq: message.seq };
    },
    /**
     * A Durango Code thread a bot started in a project (startProjectThread) ended:
     * its report goes to the bot's inbox. `key` is the one it was started with.
     */
    async threadSettled({ key, threadId, outcome, summary, error } = {}) {
      await ensureLoaded();
      const [botId] = str(key).split(':');
      const entry = entries.get(botId);
      if (!entry) return { ok: false };
      const runtime = runtimeFor(botId);
      const task = runtime.threads.get(str(key));
      runtime.threads.delete(str(key));
      const title = task?.title ?? 'Durango Code thread';
      const where = task?.project ? `the Durango Code thread in ${task.project}` : 'the Durango Code thread';
      // Which thread it was, so the bot can follow up there (e.g. to ship the change).
      const thread = { threadId: str(threadId).trim() || task?.threadId || '', project: task?.project ?? null };
      const report =
        outcome === 'finished'
          ? withThreadReportFooter(str(summary).trim() || 'The thread finished without a written summary.', thread)
          : withThreadReportFooter(`The task couldn't finish (${where}): ${clip(oneLine(error) || 'the thread stopped.', 300)}`, thread);
      appendInbox(entry, { content: report, authorLabel: inboxLabel('task', title) });
      return { ok: true };
    },
    /** Routines fire and waiting messages are answered only while active (signed out of Durango). */
    setActive(next) {
      const value = Boolean(next);
      if (value === active) return;
      active = value;
      if (active) {
        timer = setTimer(() => void tickRoutines().catch((error) => log('routines failed:', error?.message ?? error)), routineTickMs);
        void resumePending().catch((error) => log("couldn't load local bots:", error?.message ?? error));
      } else {
        if (timer) clearTimer(timer);
        timer = null;
        abortAll();
      }
    },
    isActive: () => active,
    tickRoutines,
    async hasDataToSync() {
      await ensureLoaded();
      await loadProjects();
      return (
        [...entries.values()].some((entry) => entry.messages.length > 0 || entry.bot.project) ||
        Object.values(projectStore).some((record) => (record?.notes ?? []).length > 0 || (record?.files ?? []).length > 0)
      );
    },
    exportForSync,
    /** Project files to upload after a sync: [{ localId, files: [{ name, path, contentType }] }] (project bots only). */
    /** Project files to upload after a sync: [{ key, files: [{ name, path, contentType }] }], every project with files. */
    async projectFilesForSync() {
      await ensureLoaded();
      await loadProjects();
      return Object.entries(projectStore)
        .map(([key, record]) => ({
          key,
          files: (record?.files ?? []).map((file) => ({ name: file.name, path: filePath({ key }, file.name), contentType: file.contentType })),
        }))
        .filter((item) => item.files.length);
    },
    /** The project's bot on this device, created the first time: `{ name, projectId, repoId?, machineId? }`. */
    async ensureProjectBot(input = {}) {
      return toDesktopBot(await ensureProjectBot(input));
    },
    /** A project's notes and files by its key (`{ key, name }`), whether or not it has a bot. */
    async projectByKey({ key, name }) {
      await ensureLoaded();
      await loadProjects();
      const record = projectStore[key] ?? { notes: [], files: [] };
      const bot = projectBotEntries().find((entry) => entry.bot.project.key === key) ?? null;
      const project = { key, name: bot?.bot.project.name ?? name };
      return {
        projectKey: key,
        name: project.name,
        botId: bot?.bot.id ?? null,
        notes: [...(record.notes ?? [])].sort((a, b) => b.createdAt - a.createdAt).map((note) => ({ ...note })),
        files: [...(record.files ?? [])]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((file) => ({ id: file.name, ...file, url: null, path: filePath(project, file.name) })),
      };
    },
    addProjectNoteByKey: async (project, content) => addNote(project, content, 'you'),
    saveProjectFileByKey: async (project, { name, bytes, contentType }) => saveFile(project, name, bytes, { contentType }),
    deleteProjectFileByKey: async (project, name) => deleteFile(project, str(name)),
    async projectFilePathByKey(project, name) {
      await loadProjects();
      const file = (projectStore[project.key]?.files ?? []).find((item) => item.name === str(name));
      return file ? filePath(project, file.name) : null;
    },
    /** A project bot's notes and files (files with their local `path`), or null. */
    async project(botId) {
      await ensureLoaded();
      const entry = entryFor(botId);
      return entry.bot.project ? await projectView(entry) : null;
    },
    async addProjectNote(botId, content) {
      await ensureLoaded();
      const entry = entryFor(botId);
      if (!entry.bot.project) throw new LocalBotError('invalid', 'This bot has no project.');
      return await addNote(entry.bot.project, content, 'you');
    },
    deleteProjectNote: async (noteId) => deleteNote(str(noteId)),
    async saveProjectFile(botId, { name, bytes, contentType }) {
      await ensureLoaded();
      const entry = entryFor(botId);
      if (!entry.bot.project) throw new LocalBotError('invalid', 'This bot has no project.');
      return await saveFile(entry.bot.project, name, bytes, { contentType });
    },
    async deleteProjectFile(botId, name) {
      await ensureLoaded();
      const entry = entryFor(botId);
      if (!entry.bot.project) return { ok: false };
      return await deleteFile(entry.bot.project, str(name));
    },
    async projectFilePath(botId, name) {
      await ensureLoaded();
      const entry = entryFor(botId);
      if (!entry.bot.project) return null;
      await loadProjects();
      const file = (projectStore[entry.bot.project.key]?.files ?? []).find((item) => item.name === str(name));
      return file ? filePath(entry.bot.project, file.name) : null;
    },
    /** After an upload: moves the files to `<dir>/synced-<timestamp>/` (nothing deleted) and starts afresh. */
    async markSynced() {
      await ensureLoaded();
      await flush();
      const ids = [...entries.keys()];
      generation += 1;
      abortAll();
      entries = new Map();
      runtimes.clear();
      loaded = Promise.resolve();
      const base = storageDir();
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      const target = path.join(base, `synced-${stamp}`);
      await fs.mkdir(target, { recursive: true });
      projectStore = null;
      for (const name of [INDEX_FILE, PROJECTS_FILE, PROJECT_FILES_DIR, ...ids.map((id) => `${id}.json`)]) {
        await fs.rename(path.join(base, name), path.join(target, name)).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      }
      changed();
      return { movedTo: target };
    },
    /** Quit: stop the timer and abort running replies (their messages are answered next time). */
    async stop() {
      if (timer) clearTimer(timer);
      timer = null;
      active = false;
      abortAll();
      await flush().catch(() => {});
    },
    flush,
    /** For tests: resolves when no reply or task is running. */
    async idle() {
      while (work.size) await Promise.allSettled([...work]);
      await flush();
    },
  };
};
