import fs from 'node:fs/promises';
import { getStorageFilePath } from './paths.js';
import { readThreadById, readThreadsIndex } from './thread-storage.js';

// The read_thread MCP tool: lets an agent browse another Orion thread's
// transcript on demand. @thread mentions inject only metadata into the
// prompt; this is where the actual content comes from, one page at a time.

export const READ_THREAD_DEFAULT_LIMIT = 30;
export const READ_THREAD_MAX_LIMIT = 200;
// Per-message and whole-reply caps so one giant transcript page can't blow
// out the calling model's context. Dropped content is always announced.
const MAX_MESSAGE_CONTENT_CHARS = 6000;
// Default multi-message read gives the newest message up to 24,000 chars (enough
// for full audit reports without evicting the user prompt on short threads);
// explicit single-message reads (limit=1 / char_offset) get 34,000 chars per page.
const MAX_FINAL_MESSAGE_CONTENT_CHARS = 24_000;
const MAX_SINGLE_MESSAGE_CONTENT_CHARS = 34_000;
const MAX_MESSAGE_DETAILS_CHARS = 10_000;
// When a message's text content is already large, shrink its tool/metadata details
// so tool logs don't evict earlier messages or bloat bot sessions.
const LARGE_CONTENT_DETAILS_THRESHOLD = 12_000;
const MAX_LARGE_CONTENT_DETAILS_CHARS = 2_000;
const MAX_OUTPUT_CHARS = 48_000;
const MAX_ACTIVITIES_SHOWN = 12;
const MAX_ACTIVITY_INPUT_CHARS = 2000;
const MAX_ACTIVITY_OUTPUT_CHARS = 4000;
const MAX_LINKED_TASKS_SHOWN = 10;
const MAX_ATTACHMENTS_SHOWN = 20;
const MAX_CHANGED_FILES_SHOWN = 50;

const formatCharCount = (count) => String(Math.max(0, Math.round(count))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

/** Slice `[start, end)` without splitting a UTF-16 surrogate pair at either edge. */
const sliceSafe = (text, start, end) => {
  let safeStart = Math.max(0, Math.min(start, text.length));
  let safeEnd = Math.max(safeStart, Math.min(end, text.length));
  if (safeStart > 0 && safeStart < text.length && isLowSurrogate(text.charCodeAt(safeStart))) {
    safeStart += 1;
  }
  if (safeEnd < text.length && safeEnd > safeStart && isHighSurrogate(text.charCodeAt(safeEnd - 1))) {
    safeEnd -= 1;
  }
  return safeStart >= safeEnd ? '' : text.slice(safeStart, safeEnd);
};

const readJson = async (filePath) => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
};

const normalizeId = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

// Resolve the thread_id argument leniently: exact id first, then id prefix,
// then the 8-character fragment that ends an @thread mention token (the model
// may pass the whole token back).
const matchThreads = (threads, rawId) => {
  const exact = threads.filter((thread) => thread?.id === rawId);
  if (exact.length > 0) return exact;
  const withoutPrefix = /^thread:/i.test(rawId) ? rawId.slice('thread:'.length) : rawId;
  const norm = normalizeId(withoutPrefix);
  if (!norm) return [];
  return threads.filter((thread) => {
    const id = normalizeId(thread?.id);
    if (!id) return false;
    return id.startsWith(norm) || (norm.length >= 8 && norm.endsWith(id.slice(0, 8)));
  });
};

const truncate = (value, max) => {
  const text = String(value ?? '');
  return text.length > max ? `${sliceSafe(text, 0, max)}…` : text;
};

const truncateBlock = (value, max, label) => {
  const text = String(value ?? '').trim();
  if (text.length <= max) return text;
  return `${sliceSafe(text, 0, max)}\n…[${label} truncated]`;
};

const indentBlock = (value) => value.split('\n').map((line) => `    ${line}`).join('\n');

const formatMessage = (
  message,
  index,
  total,
  { toolCall = 'read_thread', contentBudget = MAX_MESSAGE_CONTENT_CHARS, detailsBudget = MAX_MESSAGE_DETAILS_CHARS, charOffset = 1 } = {}
) => {
  const role = message.role === 'user' ? 'User' : message.role === 'agent' ? 'Agent' : 'System';
  const status =
    typeof message.status === 'string' && message.status !== 'done' ? ` [${message.status}]` : '';
  const lines = [`### Message ${index + 1}/${total} — ${role}${message.ts ? ` (${message.ts})` : ''}${status}`];
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  const startChar = Number.isInteger(charOffset) && charOffset > 1 ? charOffset - 1 : 0;
  let shownContentChars = 0;
  if (content) {
    let safeStart = startChar;
    if (safeStart > 0 && safeStart < content.length && isLowSurrogate(content.charCodeAt(safeStart))) {
      safeStart += 1;
    }
    if (safeStart >= content.length) {
      lines.push(
        `Requested char_offset ${charOffset} is past the end of message ${index + 1} (${formatCharCount(content.length)} chars).`
      );
    } else if (safeStart > 0 || content.length > contentBudget) {
      let endChar = Math.min(content.length, safeStart + Math.max(1, contentBudget));
      if (
        endChar < content.length &&
        endChar > safeStart + 1 &&
        isHighSurrogate(content.charCodeAt(endChar - 1))
      ) {
        endChar -= 1;
      }
      const chunk = content.slice(safeStart, endChar);
      shownContentChars = chunk.length;
      lines.push(chunk);
      if (endChar < content.length) {
        lines.push(
          `…[message truncated: showing chars ${formatCharCount(safeStart + 1)}–${formatCharCount(endChar)} of ${formatCharCount(content.length)} — call ${toolCall} with offset=${index + 1}, limit=1, char_offset=${endChar + 1} to read more]`
        );
      } else {
        lines.push(
          `(Showing chars ${formatCharCount(safeStart + 1)}–${formatCharCount(endChar)} of ${formatCharCount(content.length)}; end of message.)`
        );
      }
    } else {
      shownContentChars = content.length;
      lines.push(content);
    }
  } else if (startChar > 0) {
    lines.push(`Message ${index + 1} has no text content (requested char_offset ${charOffset}).`);
  }
  const detailLines = [];
  if (startChar === 0 && detailsBudget > 0) {
    const linkedTasks = Array.isArray(message.linkedTasks) ? message.linkedTasks : [];
    if (linkedTasks.length > 0) {
      detailLines.push(`Linked board ${linkedTasks.length === 1 ? 'task' : `tasks (${linkedTasks.length})`}:`);
      for (const task of linkedTasks.slice(0, MAX_LINKED_TASKS_SHOWN)) {
        detailLines.push(`- ${truncate(task?.title || '(untitled task)', 500)}`);
        const description = truncateBlock(task?.description, 4000, 'task description');
        if (description) detailLines.push(indentBlock(description));
      }
      if (linkedTasks.length > MAX_LINKED_TASKS_SHOWN) {
        detailLines.push(`- …${linkedTasks.length - MAX_LINKED_TASKS_SHOWN} more linked tasks omitted`);
      }
    }
    const activities = Array.isArray(message.activities) ? message.activities : [];
    if (activities.length > 0) {
      detailLines.push(`Tool activity (${activities.length} steps):`);
      for (const activity of activities.slice(0, MAX_ACTIVITIES_SHOWN)) {
        const detail = activity?.detail ? `: ${truncate(activity.detail, 200)}` : '';
        detailLines.push(`- ${truncate(activity?.title ?? '', 200)}${detail}`);
        if (activity?.input) {
          detailLines.push(
            '  Input:',
            indentBlock(truncateBlock(activity.input, MAX_ACTIVITY_INPUT_CHARS, 'activity input'))
          );
        }
        if (activity?.output) {
          detailLines.push(
            '  Output:',
            indentBlock(truncateBlock(activity.output, MAX_ACTIVITY_OUTPUT_CHARS, 'activity output'))
          );
        }
      }
      if (activities.length > MAX_ACTIVITIES_SHOWN) {
        detailLines.push(`- …${activities.length - MAX_ACTIVITIES_SHOWN} more steps omitted`);
      }
    }
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    if (attachments.length > 0) {
      detailLines.push(`Attachments (${attachments.length}):`);
      for (const attachment of attachments.slice(0, MAX_ATTACHMENTS_SHOWN)) {
        detailLines.push(`- ${truncate(attachment?.name ?? 'file', 200)} (${truncate(attachment?.path ?? 'no path', 500)})`);
      }
      if (attachments.length > MAX_ATTACHMENTS_SHOWN) {
        detailLines.push(`- …${attachments.length - MAX_ATTACHMENTS_SHOWN} more attachments omitted`);
      }
    }
    const changedFiles = Array.isArray(message.changedFiles) ? message.changedFiles : [];
    if (changedFiles.length > 0) {
      detailLines.push(`Changed files (${changedFiles.length}):`);
      for (const file of changedFiles.slice(0, MAX_CHANGED_FILES_SHOWN)) {
        detailLines.push(`- ${truncate(file?.path ?? '(unknown path)', 500)} (${truncate(file?.status ?? 'unknown', 100)})`);
      }
      if (changedFiles.length > MAX_CHANGED_FILES_SHOWN) {
        detailLines.push(`- …${changedFiles.length - MAX_CHANGED_FILES_SHOWN} more changed files omitted`);
      }
    }
  }
  if (detailLines.length > 0) {
    const details = detailLines.join('\n');
    const effectiveDetailsBudget =
      shownContentChars > LARGE_CONTENT_DETAILS_THRESHOLD
        ? Math.min(detailsBudget, MAX_LARGE_CONTENT_DETAILS_CHARS)
        : detailsBudget;
    if (details.length <= effectiveDetailsBudget) {
      lines.push(details);
    } else {
      const notice = '\n…[message details truncated]';
      const keep = Math.max(0, effectiveDetailsBudget - notice.length);
      lines.push(`${sliceSafe(details, 0, keep)}${notice}`);
    }
  }
  if (lines.length === 1) lines.push('(empty message)');
  return lines.join('\n');
};

// A thread listed here that runs on another machine (a remote-control mirror,
// `remote: { machineId, machineName, threadId }`) is read from that machine:
// this machine's copy is only what was last fetched (often nothing, for a
// thread never opened here). main.js installs the fetcher
// (remote-control.js fetchRemoteThread, after the engine starts).
let fetchRemoteThreadForReader = null;
export const setThreadReaderRemoteFetch = (fetcher) => {
  fetchRemoteThreadForReader = typeof fetcher === 'function' ? fetcher : null;
};

const remoteOf = (entry) => {
  const remote = entry?.remote ?? entry?.shell?.remote;
  return remote && typeof remote.machineId === 'string' && typeof remote.threadId === 'string' && remote.threadId
    ? remote
    : null;
};

// Always resolves to readable text (never rejects) so every caller — the
// Claude SDK tool and the socket bridge — hands the model an outcome it can
// act on instead of a protocol error.
export const readThreadForAgent = async (args = {}) => {
  const rawId = typeof args.thread_id === 'string' ? args.thread_id.trim() : '';
  if (!rawId) return 'read_thread requires a `thread_id` string argument.';

  let threads = [];
  try {
    threads = (await readThreadsIndex()).entries;
  } catch {
    return 'Durango Code could not read the stored thread index.';
  }
  if (threads.length === 0) return 'No Durango Code threads are stored yet.';

  const matches = matchThreads(threads, rawId);
  if (matches.length === 0) {
    return `No Durango Code thread matches thread_id "${rawId}". Use the exact id from the [Thread mentions] block.`;
  }
  if (matches.length > 1) {
    const listing = matches
      .slice(0, 10)
      .map((thread) => `- ${thread.id} — "${thread.title}"`)
      .join('\n');
    return `thread_id "${rawId}" is ambiguous; it matches ${matches.length} threads. Call read_thread again with one exact id:\n${listing}`;
  }

  let thread;
  try {
    thread = await readThreadById(matches[0].id);
  } catch {
    return `Durango Code could not read thread "${matches[0].id}".`;
  }
  if (!thread) return `Durango Code thread "${matches[0].id}" is no longer stored.`;
  const storeState = (await readJson(getStorageFilePath()))?.state;
  const project = Array.isArray(storeState?.projects)
    ? storeState.projects.find((candidate) => candidate?.id === thread.projectId)
    : undefined;

  const remote = remoteOf(thread) ?? remoteOf(matches[0]);
  if (remote) {
    const machineName = String(remote.machineName ?? 'another machine');
    let fetched = null;
    let error = 'remote control is not running';
    if (fetchRemoteThreadForReader) {
      try {
        const result = await fetchRemoteThreadForReader({ machineId: remote.machineId, threadId: remote.threadId });
        if (result?.ok && result.thread) fetched = result.thread;
        else error = result?.error ?? 'no transcript';
      } catch (fetchError) {
        error = fetchError?.message ?? String(fetchError);
      }
    }
    // The host's transcript under this machine's id, so paging and links
    // keep pointing at the thread as listed here.
    const source = fetched ? { ...fetched, id: thread.id, title: fetched.title || thread.title } : thread;
    return formatThreadForAgent(source, {
      project,
      offset: args.offset,
      limit: args.limit,
      charOffset: args.char_offset,
      extraHeader: [
        fetched
          ? `machine: ${machineName} (this thread runs there; transcript read from it just now)`
          : `machine: ${machineName} (this thread runs there, but it could not be reached: ${error}. Showing the copy this machine last fetched, which may be incomplete.)`,
      ],
    });
  }
  return formatThreadForAgent(thread, { project, offset: args.offset, limit: args.limit, charOffset: args.char_offset });
};

const EFFORT_FIELD_BY_PROVIDER = {
  claude: 'claudeReasoningEffort',
  codex: 'codexReasoningEffort',
  antigravity: 'antigravityReasoningEffort',
  grok: 'grokReasoningEffort',
  muse: 'museReasoningEffort',
  opencode: 'openCodeReasoningEffort',
};

const activeReasoningEffortOf = (thread) => {
  const modelId = typeof thread?.modelId === 'string' ? thread.modelId : '';
  const provider = modelId.includes(':') ? modelId.slice(0, modelId.indexOf(':')) : '';
  const field = EFFORT_FIELD_BY_PROVIDER[provider];
  const value = field ? thread?.[field] : null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/**
 * One page of a thread's transcript for an agent (read_thread, and
 * machine_read_thread for a thread on another machine). `toolCall` names how
 * to read more pages; `extraHeader` adds lines under the title.
 */
export const formatThreadForAgent = (
  thread,
  { project, offset, limit: requestedLimit, charOffset: requestedCharOffset, toolCall = 'read_thread', extraHeader = [], link = true } = {}
) => {
  const args = { offset, limit: requestedLimit };
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const total = messages.length;
  const charOffset = Number.isInteger(requestedCharOffset) && requestedCharOffset >= 1 ? requestedCharOffset : 1;
  const pagingSingleMessage = charOffset > 1;
  const limit = pagingSingleMessage
    ? 1
    : Math.min(
        READ_THREAD_MAX_LIMIT,
        Math.max(1, Number.isInteger(args.limit) ? args.limit : READ_THREAD_DEFAULT_LIMIT)
      );
  const startIndex = Number.isInteger(args.offset)
    ? Math.max(args.offset - 1, 0)
    : Math.max(0, total - limit);

  const effort = activeReasoningEffortOf(thread);
  const access = typeof thread.accessMode === 'string' && thread.accessMode ? thread.accessMode : null;
  const header = [
    `# Durango Code thread "${thread.title}"`,
    `thread_id: ${thread.id}`,
    ...extraHeader,
    ...(link
      ? [`link: @thread:${thread.id} (write this in your reply to give the user a clickable link to the thread)`]
      : []),
    `status: ${thread.status}; model: ${thread.modelId}${effort ? `; effort: ${effort}` : ''}${access ? `; access: ${access}` : ''}; created: ${thread.createdAt}`,
    ...(project ? [`project: ${project.name} (${project.path})`] : []),
    ...(thread.status === 'running'
      ? ['Note: this thread is currently running; its transcript may lag behind by a few seconds.']
      : []),
  ];

  if (total === 0) return [...header, '', 'This thread has no messages yet.'].join('\n');
  if (startIndex >= total) {
    return [
      ...header,
      '',
      `Requested offset ${args.offset} is past the end of this transcript (${total} messages). No messages returned.`,
    ].join('\n');
  }

  const page = messages.slice(startIndex, startIndex + limit);

  const singleRequested = limit === 1;
  const contentBudgetFor = (absIndex) => {
    if (singleRequested || pagingSingleMessage) return MAX_SINGLE_MESSAGE_CONTENT_CHARS;
    if (absIndex === total - 1) return MAX_FINAL_MESSAGE_CONTENT_CHARS;
    return MAX_MESSAGE_CONTENT_CHARS;
  };
  const formatted = page.map((message, index) => {
    const absIndex = startIndex + index;
    return formatMessage(message, absIndex, total, {
      toolCall,
      contentBudget: contentBudgetFor(absIndex),
      detailsBudget: MAX_MESSAGE_DETAILS_CHARS,
      charOffset: pagingSingleMessage ? charOffset : 1,
    });
  });
  // Trim oldest entries in the page if it still exceeds the reply budget.
  let dropped = 0;
  const buildRangeLines = (shownCount) => {
    const shownStart = startIndex + dropped;
    return [
      `Showing messages ${shownStart + 1}–${shownStart + shownCount} of ${total} (oldest first).`,
      ...(dropped > 0
        ? [
            `${dropped} messages of this page were dropped to fit the reply budget; re-request the omitted range with offset=${startIndex + 1}, limit=${dropped}.`,
          ]
        : []),
      ...(shownStart > 0 && dropped === 0
        ? [`Earlier messages exist — call ${toolCall} with offset (1-based message index) to read them, e.g. offset=${Math.max(1, shownStart + 1 - limit)}, limit=${limit}.`]
        : []),
      ...(shownStart + shownCount < total
        ? [`Later messages exist — call ${toolCall} with offset=${shownStart + shownCount + 1} to continue.`]
        : []),
    ];
  };
  const buildReplyPrefix = (shownCount) =>
    `${[...header, '', ...buildRangeLines(shownCount), ''].join('\n')}\n`;

  let shownCount = formatted.length;
  let bodyLength = formatted.reduce((sum, entry) => sum + entry.length, 0) +
    Math.max(0, formatted.length - 1) * 2;
  let prefix = buildReplyPrefix(shownCount);
  while (shownCount > 1 && prefix.length + bodyLength > MAX_OUTPUT_CHARS) {
    bodyLength -= formatted[dropped].length + 2;
    dropped += 1;
    shownCount -= 1;
    prefix = buildReplyPrefix(shownCount);
  }
  const shownEntries = formatted.slice(dropped);
  if (prefix.length + bodyLength > MAX_OUTPUT_CHARS && shownEntries.length === 1) {
    // Re-format the single remaining message with tighter details/content budgets
    // so truncation pointers and surrogate pairs stay intact instead of slicing the tail off.
    const absIndex = startIndex + dropped;
    const message = page[dropped];
    const available = Math.max(0, MAX_OUTPUT_CHARS - prefix.length);
    const withoutDetails = formatMessage(message, absIndex, total, {
      toolCall,
      contentBudget: contentBudgetFor(absIndex),
      detailsBudget: 0,
      charOffset: pagingSingleMessage ? charOffset : 1,
    });
    if (withoutDetails.length <= available) {
      const remainingForDetails = available - withoutDetails.length - 1;
      shownEntries[0] =
        remainingForDetails >= 120
          ? formatMessage(message, absIndex, total, {
              toolCall,
              contentBudget: contentBudgetFor(absIndex),
              detailsBudget: remainingForDetails,
              charOffset: pagingSingleMessage ? charOffset : 1,
            })
          : withoutDetails;
    } else {
      const tightenedContent = Math.max(200, available - 300);
      shownEntries[0] = formatMessage(message, absIndex, total, {
        toolCall,
        contentBudget: tightenedContent,
        detailsBudget: 0,
        charOffset: pagingSingleMessage ? charOffset : 1,
      });
    }
    if (prefix.length + shownEntries[0].length > MAX_OUTPUT_CHARS) {
      const notice = '\n…[message truncated to fit reply budget]';
      const keep = Math.max(0, MAX_OUTPUT_CHARS - prefix.length - notice.length);
      shownEntries[0] = `${sliceSafe(shownEntries[0], 0, keep)}${notice}`;
    }
  }
  const reply = `${prefix}${shownEntries.join('\n\n')}`;
  // Defensive final cap for unexpectedly large thread metadata in the header.
  if (reply.length > MAX_OUTPUT_CHARS) {
    const notice = '\n…[reply truncated to fit reply budget]';
    return `${sliceSafe(reply, 0, Math.max(0, MAX_OUTPUT_CHARS - notice.length))}${notice}`;
  }
  return reply;
};
