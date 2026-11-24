// Reading the reply of a hidden utility turn (thread titles, commit/PR
// messages, approval explanations) out of a provider CLI's output.

import { jsonAdapterForProvider, sendsJsonEvents } from './stream-adapters.js';

const isToolStep = (activity) => activity?.type === 'tool' || activity?.type === 'command';

// The model's reply in a one-shot CLI turn's stdout: only real text (no
// thoughts or protocol lines). Read-only turns can still read files, and a
// model that takes the prompt for a task narrates first ("I'll trace the
// existing …"), runs a tool, then answers. Only the answer is the reply: the
// text after the last tool step, and for Codex its last agent message (each
// completed agent_message is a separate commentary or final answer).
export const utilityReplyFromOutput = (stdout, providerId) => {
  if (!sendsJsonEvents(providerId)) return stdout;
  const adapter = jsonAdapterForProvider(providerId);
  const textContext = { textSeen: false };
  const eachTextIsNewReply = providerId === 'codex';
  let toolSinceText = false;
  let responseText = '';
  const addText = (text) => {
    if (textContext.textSeen && (eachTextIsNewReply || toolSinceText)) {
      responseText = text.replace(/^\s+/, '');
    } else {
      responseText += text;
    }
    toolSinceText = false;
    textContext.textSeen = true;
  };
  const noteActivities = (parsed) => {
    if (textContext.textSeen && adapter.activities(parsed).some(isToolStep)) toolSinceText = true;
  };

  let partial = '';
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const line = partial ? partial + rawLine : rawLine;
    const trimmed = line.trim();
    if (!trimmed) {
      partial = '';
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      const text = adapter.text(parsed, textContext);
      // A line without text (a thought, a tool step) is never part of the reply.
      if (text) addText(text);
      else noteActivities(parsed);
      partial = '';
    } catch {
      // Not (yet) valid JSON. If it doesn't look like the start of JSON, it's plain text.
      if (!/^\s*[\{\[]/.test(trimmed)) {
        responseText += rawLine + '\n';
        partial = '';
      } else {
        partial = line; // keep for a possible multi-line object (rare)
      }
    }
  }
  // Flush the last partial line if it parses.
  if (partial.trim()) {
    try {
      const parsed = JSON.parse(partial.trim());
      const text = adapter.text(parsed, textContext);
      if (text) addText(text);
    } catch {
      if (!/^\s*[\{\[]/.test(partial)) responseText += partial;
    }
  }
  return responseText;
};

// The model narrating what it is about to do instead of answering
// ("I'll trace …", "Let me look at …"). Never a title.
const PREAMBLE =
  /^(?:(?:ok(?:ay)?|sure|alright|first)[,!.]?\s+)?(?:i\s*['’]ll|i\s+will|i\s*['’]m\s+going\s+to|i\s+am\s+going\s+to|i\s+need\s+to|let\s+me)\s/i;

// Normalize a raw model response into a usable one-line thread title,
// or '' when nothing title-shaped survives.
export const titleFromResponseText = (responseText) => {
  let candidate = (responseText || '').split(/[\r\n]+/).find((line) => line.trim()) || '';
  candidate = candidate.trim();
  if (!candidate) return '';

  // Clean model output
  // Strip markdown formatting first (Kimi wraps titles in **bold** / headings)
  // so the quote/prefix cleanups below see plain text.
  candidate = candidate.replace(/^#{1,6}\s+/, '');
  // Paired code/strike/bold delimiters unwrap safely anywhere (the content
  // survives; bold requires non-space at the inner edges, per Markdown, so a
  // literal `**kwargs and **args` stays intact). Single * and __ pairs only
  // unwrap when they enclose the whole title — interior ones are likely
  // literal (glob patterns like *.ts, identifiers like __init__).
  candidate = candidate.replace(/`([^`]+)`/g, '$1');
  candidate = candidate.replace(/~~([^~]+)~~/g, '$1');
  candidate = candidate.replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, '$1');
  candidate = candidate.replace(/^\*([^*]+)\*$/, '$1');
  candidate = candidate.replace(/^__(.+)__$/, '$1');
  candidate = candidate.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2');
  candidate = candidate.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  candidate = candidate.replace(/^(title\s*[:：]\s*|here\s*(is|is a)\s*(a\s+)?(concise\s+)?title\s*[:：]?\s*|the title (is|should be)\s*[:：]?\s*)/i, '');
  candidate = candidate.replace(/\s+/g, ' ').trim();
  candidate = candidate.split(/[\.!?]\s/)[0].trim();
  if (candidate.length > 70) candidate = candidate.slice(0, 67).trim() + '…';

  // Hard guard: never accept raw protocol / JSON / thought lines as a title
  if (!candidate || /^[\{\[]/.test(candidate) || /"type"\s*:/i.test(candidate) || /"data"\s*:/i.test(candidate) || /\btype["\s]*:["\s]*thought\b/i.test(candidate)) {
    return '';
  }
  // Nor narration: the thread keeps its heuristic title instead.
  if (PREAMBLE.test(candidate)) return '';
  return candidate;
};
