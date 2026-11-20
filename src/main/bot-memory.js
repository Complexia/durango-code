// A local bot's long-term memory (local-bots.js): its summary chain and the
// search over its own thread. Mirrors Durango's cloud bots
// (andromedus lib/bots/compaction.ts and convex/bots.ts searchHistory). Pure.
//
// Summary chain: compaction used to replace one ~1,200-word summary each
// time, so older detail faded a little more with every pass. Now the memory
// has two parts: a compact "earlier history" (one line per older topic,
// decision or finished piece of work, bounded) and the latest detailed
// summary. What leaves the detailed summary moves into the earlier history
// instead of being dropped; search_history finds the exact older messages.
// Both change only when compaction runs, so the bot's prompt prefix stays
// cached in between.

export const EARLIER_HISTORY_MAX_CHARS = 5_000;
export const SUMMARY_MAX_CHARS = 12_000;

export const COMPACTION_PROMPT = `You maintain the long-term memory of an always-on assistant bot's conversation with a person. The bot will see ONLY this memory plus the most recent messages, so anything you drop is forgotten (it can search its full history by keyword, but only for what it knows to look for).

The memory has two parts:
- <earlier>: a compact record of the older history, oldest first: one short line per topic, decision, fact or finished piece of work worth knowing about (with its date when known, and names, numbers, ids, links). At most 500 words.
- <summary>: the detailed working summary of the recent conversation. Keep, concretely (names, numbers, dates, links, ids, exact wording of preferences):
  1. Standing instructions and preferences the person gave (how they want things done, what not to do).
  2. Open items: requests not yet finished, promises the bot made, questions waiting on the person, tasks running and what they were for.
  3. Decisions made and their reasons; things already done (so they aren't redone).
  4. Key facts learned about the person, their situation and their projects.
  5. The bot's other bots / routines it set up, and what they are for (if mentioned).
  At most 1,200 words.

Update both from the previous memory and the new messages. Fold the new messages into <summary>. Detail that leaves <summary> (resolved, superseded, or no longer needed day to day) moves into <earlier> as one line instead of being dropped; standing instructions and open items always stay in <summary>. When <earlier> gets too long, merge its oldest lines into broader ones. Drop greetings and chit-chat. Use short headed sections and bullet points in <summary>; newest state wins over older. Write in third person ("The person…", "You (the bot)…").

Output exactly, and nothing else:
<earlier>
…
</earlier>
<summary>
…
</summary>`;

const str = (value) => (typeof value === 'string' ? value : '');
const clip = (value, max) => {
  const text = str(value).trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
};

/** The summarizer's prompt: the previous memory and the messages to fold. */
export const compactionInput = ({ earlier, summary, transcript }) =>
  [
    str(earlier).trim() ? `<previous_earlier>\n${str(earlier).trim()}\n</previous_earlier>` : '<previous_earlier>(none yet)</previous_earlier>',
    str(summary).trim() ? `<previous_summary>\n${str(summary).trim()}\n</previous_summary>` : '<previous_summary>(none yet)</previous_summary>',
    `<new_messages>\n${transcript}\n</new_messages>`,
  ].join('\n\n');

/**
 * The summarizer's answer → `{ earlier, summary }` (each bounded), or null
 * when it gave nothing. An answer without the tags is all summary, and the
 * earlier history stays as it was.
 */
export const parseCompaction = (text, previousEarlier = null) => {
  const value = str(text).trim();
  if (!value) return null;
  const tag = (name) => {
    const match = value.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*(?:</${name}>|$)`));
    return match ? match[1].trim() : null;
  };
  const summary = tag('summary');
  const earlier = tag('earlier');
  if (summary === null) return { earlier: str(previousEarlier).trim() ? clip(previousEarlier, EARLIER_HISTORY_MAX_CHARS) : null, summary: clip(value, SUMMARY_MAX_CHARS) };
  if (!summary) return null;
  const keptEarlier = earlier && !/^\(none( yet)?\)$/i.test(earlier) ? earlier : str(previousEarlier).trim();
  return { earlier: keptEarlier ? clip(keptEarlier, EARLIER_HISTORY_MAX_CHARS) : null, summary: clip(summary, SUMMARY_MAX_CHARS) };
};

/**
 * Where the bot's memory starts in its instructions. It is their last section,
 * here and in Durango's cloud (chat/andromedus/lib/bots/prompt.ts uses the
 * same heading and intro): a machine reply keeps its session across a new summary
 * (bot-sessions.js splitMemorySection).
 */
export const MEMORY_SECTION_HEADING = '## Your earlier conversation with the person (summary)';
/** The memory section's first paragraph (the same text in Durango's cloud). */
export const MEMORY_SECTION_INTRO =
  "Older messages of your thread were condensed into this memory; the messages after it follow in full. When you need a detail it doesn't have (exact wording, a link, a number, a name, what was said or decided when), search_history finds the older messages.";

/** The bot's memory as a section of its instructions (null without one). */
export const memorySection = ({ summary, earlier }) => {
  if (!str(summary).trim()) return null;
  const intro = MEMORY_SECTION_INTRO;
  return str(earlier).trim()
    ? `${MEMORY_SECTION_HEADING}\n\n${intro}\n\n### Earlier history (condensed)\n\n${str(earlier).trim()}\n\n### Recent conversation\n\n${str(summary).trim()}`
    : `${MEMORY_SECTION_HEADING}\n\n${intro}\n\n${str(summary).trim()}`;
};

export const SEARCH_HISTORY_TOOL = {
  name: 'search_history',
  description:
    "Search your own thread's full history by keywords, including the older messages that were condensed into your summary. Returns the matching messages (newest first) with when they were sent and a snippet around the match. Use it when your summary lacks a detail you need: exact wording, a link, a number, a name, or what was said or decided on a date.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 2, maxLength: 200, description: 'Keywords to find (every word must appear), e.g. "flight Tokyo".' },
      from: { type: 'string', maxLength: 40, description: 'Only messages on or after this date (YYYY-MM-DD or an ISO date-time).' },
      to: { type: 'string', maxLength: 40, description: 'Only messages on or before this date (YYYY-MM-DD or an ISO date-time).' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'At most this many messages (default 8).' },
    },
    required: ['query'],
  },
};

/** Lowercase search terms (each at least 2 characters, at most 8). */
export const searchTerms = (query) =>
  str(query)
    .normalize('NFKC')
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((term) => term.length >= 2)
    .slice(0, 8);

/** "2026-11-19" (the whole day) or an ISO date-time → epoch ms; null when absent or unreadable. */
export const searchDate = (value, { endOfDay = false } = {}) => {
  const text = str(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    return endOfDay ? new Date(year, month - 1, day, 23, 59, 59, 999).getTime() : new Date(year, month - 1, day).getTime();
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
};

/** A one-line excerpt around the first matching term. */
export const searchSnippet = (text, terms, maxChars = 320) => {
  const flat = str(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  const lower = flat.toLowerCase();
  const hit = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, Math.min(hit - Math.floor(maxChars / 3), flat.length - maxChars));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + maxChars).trim()}${start + maxChars < flat.length ? '…' : ''}`;
};

/**
 * search_history over a bot's stored messages ({ seq, role, content,
 * authorLabel, createdAt }): every term must appear; newest first.
 */
export const searchMessages = (messages, { query, from, to, limit, botName = 'You' } = {}) => {
  const terms = searchTerms(query);
  if (!terms.length) return { ok: false, error: 'Give a query of at least one word (2+ characters).' };
  const after = searchDate(from);
  const before = searchDate(to, { endOfDay: true });
  const max = Math.min(20, Math.max(1, Number.isInteger(limit) ? limit : 8));
  const matches = [];
  for (let index = messages.length - 1; index >= 0 && matches.length < max; index -= 1) {
    const message = messages[index];
    if (after !== null && message.createdAt < after) continue;
    if (before !== null && message.createdAt > before) continue;
    const haystack = str(message.content).normalize('NFKC').toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) continue;
    matches.push({
      seq: message.seq,
      at: new Date(message.createdAt).toISOString(),
      from: message.role === 'assistant' ? `${botName} (you)` : message.authorLabel ?? 'Person',
      snippet: searchSnippet(message.content, terms),
    });
  }
  return {
    ok: true,
    results: matches,
    ...(matches.length ? {} : { note: 'Nothing matched. Try fewer or different words, or a wider date range.' }),
  };
};
