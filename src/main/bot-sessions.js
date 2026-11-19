import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Bot sessions: one resumed Claude Code session per bot, so a bot reply on
// this machine reads its conversation from the prompt cache instead of
// re-sending it.
//
// A bot reply used to start a fresh Claude Code session with the whole
// conversation (summary, recent messages, the new ones) as one prompt: only
// Claude Code's own system prompt and tools were cached between replies, and
// the conversation (15-45K tokens) was read at full price, written to the
// cache and never read back. Now each bot keeps one session here: a reply
// resumes it and sends only what the session hasn't seen (messages answered
// elsewhere meanwhile, the new ones) and this turn's context. The session
// starts over, seeded with the summary (in the system prompt) and the recent
// messages, when:
// - its basis changes: the bot's appended system prompt (a new summary after
//   compaction, a job or project note change), its model or its tools;
// - it is missing or broken (a failed, stopped or crashed reply drops it);
// - its context grew past `sessionResetTokens` (tool results pile up in a
//   session), or the next prompt would pass `maxPromptTokens`.
// Sessions are kept per bot and model (replies to the person and routine runs
// use different models, so different caches anyway).
// A second reply for the same bot while one runs gets a fresh session of its
// own that isn't kept (it would fork the conversation); its messages reach
// the kept session later as "since your last reply" messages, like replies
// that ran on another machine or in Durango's cloud.
//
// Prompt size: a fresh prompt is kept under `maxPromptTokens` the way
// Durango's cloud fits a turn (andromedus lib/chat-turn/context-window.ts):
// very long older messages are cut in the middle, then the oldest messages
// are left out (in chunks, starting the kept part on an incoming message),
// and a new message too long on its own is cut in the middle with a marker.
// A reply never fails or moves because of its size.
//
// Pure functions plus a small store; no Electron.

/** The bot's part of a reply's prompt (its system prompt and the conversation) stays under this. */
export const BOT_MAX_PROMPT_TOKENS = 150_000;
/** A resumed session whose context passed this starts over (tool results pile up in a session). */
export const BOT_SESSION_RESET_TOKENS = 100_000;
/** Older messages above this are cut in the middle once the prompt is over budget (as in the cloud). */
export const BOT_MAX_OLDER_MESSAGE_TOKENS = 6_000;
/** Any one message above this (a huge paste, a long task report) is cut in the middle. */
export const BOT_MAX_MESSAGE_TOKENS = 30_000;
/** Messages are left out in multiples of this (as in the cloud), so a fresh prompt's start changes rarely. */
export const BOT_DROP_CHUNK_MESSAGES = 8;
/** The unsummarized part above this means compaction fell behind: ask for one. */
export const BOT_COMPACT_BEHIND_TOKENS = 60_000;
const SEEN_MAX = 4_000;
const MESSAGE_OVERHEAD_TOKENS = 4;
const MIN_BUDGET_TOKENS = 4_000;

export const BOT_REPLY_INSTRUCTION =
  'Write your reply to the new messages now. Your final text is sent to the person as your message in the thread.';

const str = (value) => (typeof value === 'string' ? value : '');

/** `DURANGO_BOT_MAX_PROMPT_TOKENS` (20K-900K), or the default. */
export const maxPromptTokensFromEnv = (env = process.env) => {
  const value = Number.parseInt(str(env?.DURANGO_BOT_MAX_PROMPT_TOKENS), 10);
  return Number.isFinite(value) && value >= 20_000 && value <= 900_000 ? value : BOT_MAX_PROMPT_TOKENS;
};

/** Estimated tokens of a text: ~4 ASCII characters a token, other characters one each (as in the cloud). */
export const estimateTextTokens = (text) => {
  const value = str(text);
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) ascii += 1;
    else if (code < 0xdc00 || code > 0xdfff) other += 1;
  }
  return Math.ceil(ascii / 4) + other;
};

/** `text` cut in the middle to about `maxTokens`, with a marker where it was cut. */
export const cutMiddle = (text, maxTokens) => {
  const value = str(text);
  const tokens = estimateTextTokens(value);
  if (tokens <= maxTokens) return value;
  const keep = Math.max(0, Math.floor(value.length * (maxTokens / tokens)));
  let head = Math.floor((keep * 2) / 3);
  let tail = value.length - (keep - head);
  if (head > 0 && /[\uD800-\uDBFF]/.test(value[head - 1])) head -= 1;
  if (tail < value.length && /[\uDC00-\uDFFF]/.test(value[tail])) tail += 1;
  return `${value.slice(0, head)}\n\n[… ${tail - head} characters omitted to fit the model's context window …]\n\n${value.slice(tail)}`;
};

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** What a kept session depends on: a different basis starts a new session. */
export const sessionBasis = ({ systemPrompt, model, tools }) =>
  hash(
    JSON.stringify([
      str(systemPrompt),
      str(model),
      (Array.isArray(tools) ? tools : []).map((tool) => str(tool?.name ?? tool)).sort(),
    ])
  ).slice(0, 32);

const contextKey = (text) => hash(text).slice(0, 16);

/**
 * A lane's structured conversation (`lane.session`), validated:
 * - history: the messages after the bot's summary, oldest first, the ones
 *   this reply answers last: `{ id, seq, role: 'user' | 'assistant', text, label? }`
 * - answering: the seqs this reply answers
 * - context: this turn's context, `{ text, steady? }` (steady parts are sent
 *   to a kept session only when they changed)
 */
export const normalizeLaneSession = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const history = (Array.isArray(raw.history) ? raw.history : [])
    .filter((row) => row && typeof row === 'object' && Number.isInteger(row.seq) && (row.role === 'user' || row.role === 'assistant'))
    .slice(-2_000)
    .map((row) => ({
      id: str(row.id).slice(0, 200),
      seq: row.seq,
      role: row.role,
      text: str(row.text),
      ...(str(row.label) ? { label: str(row.label).slice(0, 200) } : {}),
    }));
  const answering = (Array.isArray(raw.answering) ? raw.answering : []).filter((seq) => Number.isInteger(seq)).slice(0, 500);
  const context = (Array.isArray(raw.context) ? raw.context : [])
    .map((part) => (typeof part === 'string' ? { text: part } : part))
    .filter((part) => part && typeof part.text === 'string' && part.text.trim())
    .slice(0, 40)
    .map((part) => ({ text: part.text, ...(part.steady ? { steady: true } : {}) }));
  if (!answering.length) return null;
  return { history, answering, context };
};

const speaker = (row, botName) =>
  row.role === 'assistant' ? `${botName} (you)` : row.label ? `[${row.label}]` : 'Person';

export const renderRow = (row, botName) => `${speaker(row, botName)}:\n${str(row.text).trim() || '(no text)'}`;
const rowTokens = (row, botName) => estimateTextTokens(renderRow(row, botName)) + MESSAGE_OVERHEAD_TOKENS;

const omittedNote = (count) =>
  `(Automatic note: the ${count} oldest message${count === 1 ? '' : 's'} after your summary ${
    count === 1 ? 'was' : 'were'
  } left out to fit the context window. search_history finds ${count === 1 ? 'it' : 'them'}.)`;

/**
 * Fits `earlier` + `answering` (+ `fixedTokens` of other prompt text) into
 * `budget`: oversized messages are cut, then the oldest earlier messages are
 * left out in chunks, then the new messages are cut to what's left. Pure.
 */
export const fitConversation = ({ earlier, answering, botName, budget, fixedTokens = 0 }) => {
  const cap = (row, max) => {
    const text = cutMiddle(row.text, max);
    return text === row.text ? row : { ...row, text };
  };
  let shrunk = 0;
  // Any one message past BOT_MAX_MESSAGE_TOKENS is cut, whatever the budget.
  const newRows = answering.map((row) => {
    const next = cap(row, BOT_MAX_MESSAGE_TOKENS);
    if (next !== row) shrunk += 1;
    return next;
  });
  let olderRows = earlier.map((row) => {
    const next = cap(row, BOT_MAX_MESSAGE_TOKENS);
    if (next !== row) shrunk += 1;
    return next;
  });
  const sum = (rows) => rows.reduce((total, row) => total + rowTokens(row, botName), 0);
  let total = fixedTokens + sum(olderRows) + sum(newRows);
  const unchanged = { earlier: olderRows, answering: newRows, omitted: 0, shrunk, estimatedTokens: total };
  if (total <= budget) return unchanged;

  // 1. Long older messages, oldest first.
  olderRows = olderRows.map((row) => {
    if (total <= budget) return row;
    const next = cap(row, BOT_MAX_OLDER_MESSAGE_TOKENS);
    if (next === row) return row;
    total += rowTokens(next, botName) - rowTokens(row, botName);
    shrunk += 1;
    return next;
  });
  // 2. The oldest messages: as few as fit, rounded up to a chunk, then on to
  // an incoming message so the kept part starts with one.
  let omitted = 0;
  if (total > budget && olderRows.length) {
    let needed = total + estimateTextTokens(omittedNote(olderRows.length)) - budget;
    while (omitted < olderRows.length && needed > 0) {
      needed -= rowTokens(olderRows[omitted], botName);
      omitted += 1;
    }
    omitted = Math.min(olderRows.length, Math.ceil(omitted / BOT_DROP_CHUNK_MESSAGES) * BOT_DROP_CHUNK_MESSAGES);
    while (omitted < olderRows.length && olderRows[omitted].role !== 'user') omitted += 1;
    olderRows = olderRows.slice(omitted);
    total = fixedTokens + sum(olderRows) + sum(newRows) + (omitted ? estimateTextTokens(omittedNote(omitted)) : 0);
  }
  // 3. Still over (the new messages alone are too long): cut them to share what's left.
  let fittedNew = newRows;
  if (total > budget && newRows.length) {
    const room = Math.max(MIN_BUDGET_TOKENS, budget - (total - sum(newRows)));
    const each = Math.max(500, Math.floor(room / newRows.length) - 50);
    fittedNew = newRows.map((row) => {
      const next = cap(row, each);
      if (next !== row) shrunk += 1;
      return next;
    });
    total = total - sum(newRows) + sum(fittedNew);
  }
  return { earlier: olderRows, answering: fittedNew, omitted, shrunk, estimatedTokens: total };
};

const contextBlock = (parts, { unchangedNote = false } = {}) => {
  const texts = parts.map((part) => part.text.trim()).filter(Boolean);
  if (unchangedNote) texts.push('(The rest of your context is as in your last message here.)');
  return texts.length ? `<context>\n${texts.join('\n')}\n</context>` : null;
};

/** A fresh session's first prompt: the conversation so far, the new messages, the context. Pure. */
export const renderFreshPrompt = ({ botName, earlier, answering, context, omitted = 0 }) =>
  [
    earlier.length || omitted
      ? `<conversation_so_far>\n${[omitted ? omittedNote(omitted) : null, ...earlier.map((row) => renderRow(row, botName))]
          .filter(Boolean)
          .join('\n\n')}\n</conversation_so_far>`
      : null,
    `<new_messages>\n${answering.map((row) => renderRow(row, botName)).join('\n\n')}\n</new_messages>`,
    contextBlock(context),
    BOT_REPLY_INSTRUCTION,
  ]
    .filter(Boolean)
    .join('\n\n');

/** A kept session's next prompt: what it hasn't seen, the new messages, the changed context. Pure. */
export const renderResumePrompt = ({ botName, unseen, answering, context, unchangedNote }) =>
  [
    unseen.length
      ? `<since_your_last_reply>\nMessages in your thread since your last reply in this conversation (answered by another reply of yours, or that came in meanwhile), oldest first:\n\n${unseen
          .map((row) => renderRow(row, botName))
          .join('\n\n')}\n</since_your_last_reply>`
      : null,
    `<new_messages>\n${answering.map((row) => renderRow(row, botName)).join('\n\n')}\n</new_messages>`,
    contextBlock(context, { unchangedNote }),
    BOT_REPLY_INSTRUCTION,
  ]
    .filter(Boolean)
    .join('\n\n');

const capList = (values) => [...new Set(values)].slice(-SEEN_MAX);

/**
 * Decides how a reply's prompt goes out. Pure.
 * - session: normalizeLaneSession(lane.session)
 * - state: the bot's kept session (null: none, or another reply holds it)
 * - basis: sessionBasis(...) of this reply
 * - busy: another reply of this bot holds the kept session
 * - systemTokens: estimated tokens of the bot's appended system prompt
 * → { mode: 'resume' | 'fresh', keep, reason, prompt, estimatedTokens,
 *     omitted, shrunk, compact, seenSeqs, seenIds, contextKeys }
 * `keep`: whether this reply's session is kept for the next one.
 * `compact`: the bot's history should be compacted (fell behind, or a kept
 * session grew too large).
 */
export const planBotPrompt = ({
  botName,
  session,
  state = null,
  basis,
  busy = false,
  systemTokens = 0,
  maxPromptTokens = BOT_MAX_PROMPT_TOKENS,
  sessionResetTokens = BOT_SESSION_RESET_TOKENS,
}) => {
  const answeringSet = new Set(session.answering);
  const answeringRows = session.history.filter((row) => answeringSet.has(row.seq));
  const earlierRows = session.history.filter((row) => !answeringSet.has(row.seq));
  const tailTokens = session.history.reduce((total, row) => total + rowTokens(row, botName), 0);
  const behind = tailTokens > BOT_COMPACT_BEHIND_TOKENS;
  const contextTokens = (parts) => parts.reduce((total, part) => total + estimateTextTokens(part.text) + 1, 0);

  let reason = busy ? 'busy' : !state ? 'new' : 'resume';
  if (!busy && state) {
    if (state.basis !== basis || !state.sessionId) reason = 'basis';
    else if ((state.contextTokens ?? 0) > sessionResetTokens) reason = 'size';
  }
  if (reason === 'resume') {
    const seenSeqs = new Set(state.seenSeqs ?? []);
    const seenIds = new Set(state.seenIds ?? []);
    const unseenAll = earlierRows.filter((row) => !seenSeqs.has(row.seq) && !(row.id && seenIds.has(row.id)));
    const sentKeys = new Set(state.contextKeys ?? []);
    const parts = session.context.filter((part) => !(part.steady && sentKeys.has(contextKey(part.text))));
    const unchangedNote = parts.length < session.context.length;
    const budget = maxPromptTokens - (state.contextTokens ?? 0);
    const fit = fitConversation({
      earlier: unseenAll,
      answering: answeringRows,
      botName,
      budget: Number.MAX_SAFE_INTEGER,
      fixedTokens: contextTokens(parts),
    });
    if (fit.estimatedTokens <= budget) {
      return {
        mode: 'resume',
        keep: true,
        reason,
        prompt: renderResumePrompt({ botName, unseen: fit.earlier, answering: fit.answering, context: parts, unchangedNote }),
        estimatedTokens: (state.contextTokens ?? 0) + fit.estimatedTokens,
        omitted: 0,
        shrunk: fit.shrunk,
        compact: behind,
        seenSeqs: capList([...(state.seenSeqs ?? []), ...session.history.map((row) => row.seq)]),
        seenIds: capList([...(state.seenIds ?? []), ...session.history.map((row) => row.id).filter(Boolean)]),
        contextKeys: capList([...(state.contextKeys ?? []), ...session.context.filter((part) => part.steady).map((part) => contextKey(part.text))]),
      };
    }
    reason = 'size';
  }
  const fixed = systemTokens + contextTokens(session.context) + estimateTextTokens(BOT_REPLY_INSTRUCTION) + 40;
  const fit = fitConversation({
    earlier: earlierRows,
    answering: answeringRows,
    botName,
    budget: Math.max(MIN_BUDGET_TOKENS, maxPromptTokens),
    fixedTokens: fixed,
  });
  return {
    mode: 'fresh',
    keep: !busy,
    reason,
    prompt: renderFreshPrompt({ botName, earlier: fit.earlier, answering: fit.answering, context: session.context, omitted: fit.omitted }),
    estimatedTokens: fit.estimatedTokens,
    omitted: fit.omitted,
    shrunk: fit.shrunk,
    compact: behind || reason === 'size' || fit.omitted > 0,
    seenSeqs: capList(session.history.map((row) => row.seq)),
    seenIds: capList(session.history.map((row) => row.id).filter(Boolean)),
    contextKeys: capList(session.context.filter((part) => part.steady).map((part) => contextKey(part.text))),
  };
};

/**
 * The kept sessions, one JSON file per bot under `dir` (or a function
 * returning it). begin() hands a bot's session to one reply at a time and
 * removes its file, so a reply that crashes leaves none (the next starts
 * fresh); end() keeps the session the reply left (or none).
 */
export const createBotSessionStore = ({ dir, log = () => {} }) => {
  const busy = new Set();
  const baseDir = () => (typeof dir === 'function' ? dir() : dir);
  const fileOf = (botId) => {
    const id = str(botId);
    const safe = /^[A-Za-z0-9_-]{1,160}$/.test(id) ? id : hash(id).slice(0, 32);
    return path.join(baseDir(), `${safe}.json`);
  };
  return {
    /** → { state, busy }: `state` is null when there's none or another reply holds it. */
    async begin(botId) {
      if (busy.has(botId)) return { state: null, busy: true };
      busy.add(botId);
      const file = fileOf(botId);
      let state = null;
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        if (parsed && parsed.version === 1 && typeof parsed.sessionId === 'string' && parsed.sessionId) state = parsed;
      } catch (error) {
        if (error?.code !== 'ENOENT') log(`couldn't read a bot session: ${error?.message ?? error}`);
      }
      await fs.rm(file, { force: true }).catch(() => {});
      return { state, busy: false };
    },
    /** Releases the bot's session; `state` (or null) is what the next reply resumes. */
    async end(botId, state) {
      try {
        if (state?.sessionId) {
          const file = fileOf(botId);
          await fs.mkdir(path.dirname(file), { recursive: true });
          const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
          await fs.writeFile(temp, JSON.stringify({ version: 1, ...state, updatedAt: Date.now() }), 'utf8');
          await fs.rename(temp, file);
        }
      } catch (error) {
        log(`couldn't keep a bot session: ${error?.message ?? error}`);
      } finally {
        busy.delete(botId);
      }
    },
    /** Forgets a bot's session (e.g. the bot was deleted). */
    async forget(botId) {
      if (busy.has(botId)) return;
      await fs.rm(fileOf(botId), { force: true }).catch(() => {});
    },
  };
};

/** Token usage of one reply, from Claude Code's result message (all of the reply's API calls). */
export const replyUsageOf = (result) => {
  const usage = result?.usage ?? {};
  const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  return {
    input: count(usage.input_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    cacheWrite1h: count(usage.cache_creation?.ephemeral_1h_input_tokens),
    output: count(usage.output_tokens),
    costUsd: Number.isFinite(result?.total_cost_usd) ? result.total_cost_usd : null,
    turns: Number.isFinite(result?.num_turns) ? result.num_turns : null,
  };
};

/** One message's context window (what the next API call re-sends), from its usage. */
export const contextTokensOf = (usage) => {
  if (!usage || typeof usage !== 'object') return 0;
  const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  return (
    count(usage.input_tokens) +
    count(usage.cache_read_input_tokens) +
    count(usage.cache_creation_input_tokens) +
    count(usage.output_tokens)
  );
};
