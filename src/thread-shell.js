// Thread shells and transcripts, shared by the renderer store and main's
// thread storage (plain JS so both, and the node test scripts, can import it).
//
// A stored thread is a shell (title, status, settings, sidebar state: what
// every list and header needs) plus its transcript (`messages` and the
// `/btw` asides). The renderer keeps every shell in memory and loads
// transcripts on demand, so whatever the shell shows that used to be read off
// the transcript lives in `summary`, kept current by the store actions and
// recomputed by main whenever it writes a transcript.

/**
 * The caption of a Claude turn that finished while the agent still waits on
 * background tasks (waitingOnBackgroundStatusText in App.tsx; keep the two in
 * sync). The thread stays Working until the follow-up turn.
 */
export const WAITING_ON_BACKGROUND_CAPTION = /^Waiting on (\d+ background (?:agents?|tasks?)|background task)\b.*…$/;

/** The caption of a run bubble closed where a steer split it (App.tsx); the run goes on below. */
export const STEERED_RUN_CAPTION = 'Steered — the agent continues below.';

/** Thread fields that make up the transcript; everything else is the shell. */
export const TRANSCRIPT_KEYS = ['messages', 'btwExchanges'];

// Claude Code re-invokes the model right after a turn that ended while a
// background task's notification was still queued (the task finished during
// the turn, so the turn didn't end "Waiting on…"). A run that starts this soon
// after the previous one finished continues its work. The run starts when the
// model's first output streams in, which takes longer on a large uncached
// context, hence the slack; a scheduled wake-up is normally much later.
const FOLLOW_UP_TURN_GAP_MS = 2 * 60_000;

// Whether the run after `earlier` (starting at `nextStart`) is the same work:
// the turn ended waiting on background tasks, was split by a steer, or was
// re-invoked straight after it ended.
const workContinuesAfter = (earlier, nextStart) => {
  const caption = earlier.statusText ?? '';
  if (WAITING_ON_BACKGROUND_CAPTION.test(caption) || caption === STEERED_RUN_CAPTION) return true;
  const completedAt = earlier.completedAt ? Date.parse(earlier.completedAt) : Number.NaN;
  return nextStart - completedAt <= FOLLOW_UP_TURN_GAP_MS;
};

// A user message steered into a running turn. Older builds didn't flag it;
// the bubble the steer split shows it.
const isSteer = (messages, index) =>
  messages[index].steer === true || messages[index - 1]?.statusText === STEERED_RUN_CAPTION;

/**
 * When the work leading up to `message` (an agent run) began: the user's
 * prompt before it. Turns the agent was re-invoked for while it waited on
 * background tasks (the thread stayed Working), turns re-invoked right after
 * they ended, and steered messages count as the same stretch, so a release
 * that finishes in a follow-up turn still counts from the request. A run that
 * starts well after one that finished outright (a scheduled wake-up) starts
 * its own stretch.
 */
export const workStartedAt = (messages, message) => {
  const index = messages.indexOf(message);
  let since = Date.parse(message.startedAt ?? message.ts);
  for (let i = index - 1; i >= 0; i -= 1) {
    const earlier = messages[i];
    if (earlier.role === 'user') {
      if (isSteer(messages, i)) continue;
      return Math.min(since, Date.parse(earlier.ts));
    }
    if (earlier.kind !== 'agent-run') continue;
    if (!workContinuesAfter(earlier, since)) break;
    since = Math.min(since, Date.parse(earlier.startedAt ?? earlier.ts));
  }
  return since;
};

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

/** What the shell knows about a transcript; see ThreadSummary in thread-shell.d.ts. */
export const summarizeThreadMessages = (messages) => {
  const list = Array.isArray(messages) ? messages : [];
  let agentRunCount = 0;
  let hasUserMessage = false;
  let workedMs = 0;
  const runningRunStarts = [];
  let lastAgentRun = null;
  for (const message of list) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'user') hasUserMessage = true;
    if (message.kind !== 'agent-run') continue;
    if (message.role === 'agent') agentRunCount += 1;
    lastAgentRun = message;
    if (!message.startedAt) continue;
    const started = Date.parse(message.startedAt);
    if (message.completedAt) {
      const ended = Date.parse(message.completedAt);
      if (Number.isFinite(started) && Number.isFinite(ended) && ended > started) workedMs += ended - started;
    } else if (message.status === 'running' && Number.isFinite(started)) {
      runningRunStarts.push(started);
    }
  }
  const last = list.at(-1);
  // "Working 12s" in the sidebar: the start of the newest stretch of work.
  let workingSince = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (message?.kind === 'agent-run') {
      workingSince = finiteOrNull(workStartedAt(list, message));
      break;
    }
    if (message?.role === 'agent') {
      workingSince = finiteOrNull(Date.parse(message.ts));
      break;
    }
  }
  return {
    messageCount: list.length,
    lastMessage:
      last && typeof last === 'object'
        ? {
            id: last.id,
            role: last.role,
            ...(last.kind ? { kind: last.kind } : {}),
            ts: last.ts,
            ...(last.status ? { status: last.status } : {}),
            ...(last.completedAt ? { completedAt: last.completedAt } : {}),
          }
        : null,
    lastAgentRun: lastAgentRun
      ? {
          id: lastAgentRun.id,
          ts: lastAgentRun.ts,
          ...(lastAgentRun.status ? { status: lastAgentRun.status } : {}),
          ...(lastAgentRun.startedAt ? { startedAt: lastAgentRun.startedAt } : {}),
          ...(lastAgentRun.completedAt ? { completedAt: lastAgentRun.completedAt } : {}),
          ...(lastAgentRun.stats?.totalTokens ? { totalTokens: lastAgentRun.stats.totalTokens } : {}),
        }
      : null,
    agentRunCount,
    hasUserMessage,
    workingSince,
    workedMs,
    runningRunStarts,
  };
};

const sameFlat = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    const left = a[key];
    const right = b[key];
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length || left.some((value, index) => value !== right[index])) return false;
    } else if (left !== right) {
      return false;
    }
  }
  return true;
};

/** Value equality for two summaries, so an unchanged summary keeps its shell. */
export const sameThreadSummary = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.messageCount === b.messageCount &&
    a.agentRunCount === b.agentRunCount &&
    a.hasUserMessage === b.hasUserMessage &&
    a.workingSince === b.workingSince &&
    a.workedMs === b.workedMs &&
    sameFlat(a.runningRunStarts, b.runningRunStarts) &&
    sameFlat(a.lastMessage, b.lastMessage) &&
    sameFlat(a.lastAgentRun, b.lastAgentRun)
  );
};

/** A stored thread without its transcript (and without a stale summary). */
export const threadShellOf = (record) => {
  const shell = {};
  for (const key of Object.keys(record)) {
    if (key === 'messages' || key === 'btwExchanges' || key === 'summary') continue;
    shell[key] = record[key];
  }
  return shell;
};

// Subagent prompts and final reports can be long (most of the shell bytes on
// a busy machine), and nothing outside the transcript view reads them, so the
// manifest's copy of a shell leaves them out. Saving such a shell back merges
// them in from the stored file (mergeShellWithStored).
const SUBAGENT_DETAIL_KEYS = ['prompt', 'summary'];
const lightSubagent = (info) => {
  if (!info || typeof info !== 'object') return info;
  if (!SUBAGENT_DETAIL_KEYS.some((key) => key in info)) return info;
  const light = { ...info };
  for (const key of SUBAGENT_DETAIL_KEYS) delete light[key];
  return light;
};

/** The shell main keeps in the manifest: threadShellOf minus subagent details. */
export const persistedShellOf = (record) => {
  const shell = threadShellOf(record);
  if (shell.subagent) shell.subagent = lightSubagent(shell.subagent);
  if (shell.inheritedSubagent) shell.inheritedSubagent = lightSubagent(shell.inheritedSubagent);
  return shell;
};

const sameSubagent = (a, b) =>
  a && b && typeof a === 'object' && typeof b === 'object' && a.id === b.id && a.providerId === b.providerId;

/**
 * Fill subagent details a light shell left out from a fuller copy of the same
 * subagent. Returns `info` itself when there is nothing to add.
 */
export const withSubagentDetails = (info, fuller) => {
  if (!sameSubagent(info, fuller)) return info;
  let merged = info;
  for (const key of SUBAGENT_DETAIL_KEYS) {
    if (merged[key] === undefined && fuller[key] !== undefined) {
      if (merged === info) merged = { ...info };
      merged[key] = fuller[key];
    }
  }
  return merged;
};

/**
 * The record to store for a shell-only save: every shell field as the
 * renderer has it now (including fields it removed), the transcript as
 * stored. Subagent details the light shell left out come from the stored copy.
 */
export const mergeShellWithStored = (shell, stored) => {
  const record = threadShellOf(shell);
  if (stored && typeof stored === 'object') {
    if (record.subagent) record.subagent = withSubagentDetails(record.subagent, stored.subagent);
    if (record.inheritedSubagent) {
      record.inheritedSubagent = withSubagentDetails(record.inheritedSubagent, stored.inheritedSubagent);
    }
  }
  record.messages = Array.isArray(stored?.messages) ? stored.messages : [];
  if (Array.isArray(stored?.btwExchanges)) record.btwExchanges = stored.btwExchanges;
  return record;
};

// ---------------------------------------------------------------------------
// Search text. The renderer scores names (titles, projects) itself; full-text
// search over transcripts runs in main against these per-message strings so
// the renderer never has to hold every transcript.

const NON_ASCII = /[^\x00-\x7f]/;

export const normalizeSearchText = (value) => {
  let text = String(value ?? '').toLowerCase();
  // NFKD is the slow step and only matters for accented input.
  if (NON_ASCII.test(text)) text = text.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return text
    .replace(/[^a-z0-9/_ .:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

// Activity details range from a one-line command to a whole file's output.
// Short ones (commands, paths) are worth finding; long ones only add noise
// and indexing cost.
export const ACTIVITY_DETAIL_INDEX_LIMIT = 400;

/** Normalized searchable text of one message (content, activity titles, short details, files). */
export const messageSearchText = (message) => {
  const parts = [typeof message?.content === 'string' ? message.content : ''];
  for (const activity of Array.isArray(message?.activities) ? message.activities : []) {
    if (typeof activity?.title === 'string') parts.push(activity.title);
    if (typeof activity?.detail === 'string' && activity.detail.length <= ACTIVITY_DETAIL_INDEX_LIMIT) {
      parts.push(activity.detail);
    }
  }
  for (const file of Array.isArray(message?.changedFiles) ? message.changedFiles : []) {
    if (typeof file?.path === 'string') parts.push(file.path);
  }
  for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
    if (typeof attachment?.name === 'string') parts.push(attachment.name);
  }
  return normalizeSearchText(parts.join(' '));
};

const WORD_SEPARATORS = ' /_.:-\n';
export const isWordStart = (text, index) => index === 0 || WORD_SEPARATORS.includes(text[index - 1]);

export const BODY_MATCH_WORD = 18;
export const BODY_MATCH_SUBSTRING = 8;

/** How well `token` matches transcript text: a word start, a substring, or not at all. */
export const scoreBodyToken = (chunks, token) => {
  if (token.length < 2) return 0;
  let found = false;
  for (const chunk of chunks) {
    let index = chunk.indexOf(token);
    // Common fragments recur thousands of times in a long transcript; a
    // handful of misses is enough to settle for a plain substring hit.
    for (let checks = 0; index !== -1 && checks < 8; checks += 1) {
      if (isWordStart(chunk, index)) return BODY_MATCH_WORD;
      found = true;
      index = chunk.indexOf(token, index + 1);
    }
    if (index !== -1) found = true;
  }
  return found ? BODY_MATCH_SUBSTRING : 0;
};

const excerptAround = (source, index) => {
  const start = index > 24 ? index - 24 : 0;
  const excerpt = source.slice(start, start + 140).trim();
  return `${start > 0 ? '…' : ''}${excerpt}${source.length > start + 140 ? '…' : ''}`;
};

const flattenText = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * The line a search result shows under a thread: where the transcript matched
 * one of `tokens` (the newest mention), else the newest message. `body` is
 * messageSearchText per message, computed when missing. Null when the
 * transcript has no text.
 */
export const transcriptExcerpt = (messages, tokens, body) => {
  const list = Array.isArray(messages) ? messages : [];
  const textAt = (index) => body?.[index] ?? messageSearchText(list[index]);
  for (const token of tokens) {
    if (token.length < 2) continue;
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (!textAt(index).includes(token)) continue;
      const source = flattenText(list[index]?.content);
      const hit = source.toLowerCase().indexOf(token);
      if (hit !== -1) return excerptAround(source, hit);
    }
  }
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const source = flattenText(list[index]?.content);
    if (source) return excerptAround(source, 0);
  }
  return null;
};
