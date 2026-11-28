import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// What a bot reply shows besides its text (chat/docs/bots.md → "Rich replies"):
//
// - Files from this computer (`attach_files`, and screenshots its text points
//   at): signed in they are uploaded to the person's library when the reply
//   finishes and stored as Durango Chat's `asset-gallery` card, so every
//   device shows them; signed out they are copied into the bots folder.
// - Cards, in Durango Chat's ui part shape `{ id, component, props }`:
//   `html` (show_html, a sandboxed page) and `bot-actions` (show_actions,
//   buttons). Signed in, Durango runs those tools and keeps the cards with the
//   reply; signed out, local-bots.js runs them with the normalizers below.

export const REPLY_FILES_MAX = 10;

/** Added to the report a thread a bot started writes, so the bot gets compact, complete outcomes. */
export const BOT_REPORT_GUIDE =
  'Keep the report compact: use plain `path:line` code references (not `file://` markdown links), leave long detail in the thread or a saved file, name every screenshot or file the person should see by its full path, and give the id and link of any Durango Source change you opened.';
export const REPLY_FILE_MAX_BYTES = 25 * 1024 * 1024;

export const ATTACH_FILES_TOOL = Object.freeze({
  name: 'attach_files',
  description:
    'Show files from this computer in your reply: screenshots and other images appear as thumbnails that open full size, other files as attachments, on every device the person uses. Pass full paths (~/ works), up to 10 per reply, 25 MB each. Use it whenever your reply is about screenshots, images, recordings or files the person should see, instead of telling them where the files are. Returns what was attached.',
  inputSchema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Full paths of the files on this computer.' },
    },
    required: ['paths'],
  },
});

const MEDIA_EXTENSIONS = 'apng|avif|gif|jpe?g|png|svg|webp|mp4|webm|mov|m4v';
const MEDIA_NAME = new RegExp(`\\.(?:${MEDIA_EXTENSIONS})$`, 'i');
// Markdown image embeds: ![alt](target) or ![alt](<target>).
const EMBED = /!\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;
// Absolute (or ~/, file://) paths in prose or code spans, ending at whitespace or punctuation.
const ABSOLUTE_PATH = /(?<=^|[\s(`'"])(?:file:\/\/|~\/|\/)[^\s`'"<>()[\]]+/g;
// Bare file names (`a-inbox-list.png`), found next to a folder the text names.
const BARE_MEDIA_NAME = new RegExp(`(?<=^|[\\s(\`'"])[A-Za-z0-9][A-Za-z0-9._ -]{0,118}\\.(?:${MEDIA_EXTENSIONS})(?=$|[\\s,;:!?)\`'"]|\\.(?:\\s|$))`, 'gi');

/** Candidates looked at per reply (each costs a stat). */
const MENTIONED_MAX = 200;

const trimPunctuation = (value) => value.replace(/[.,;:!?]+$/, '');

/** `~/x`, `file:///x` → an absolute path here; anything else unchanged. */
export const resolveLocalPath = (value, home = os.homedir()) => {
  const raw = String(value ?? '').trim();
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2));
  if (/^file:\/\//i.test(raw)) {
    try {
      return fileURLToPath(raw);
    } catch {
      return raw;
    }
  }
  return raw;
};

/**
 * The files a reply's text points at (pure): images it embeds with a local
 * path, absolute media paths it mentions, and bare media file names next to a
 * folder it names ("in /tmp/shots/: `a.png`, `b.png`").
 */
export const mentionedMediaPaths = (text) => {
  const source = String(text ?? '');
  const paths = [];
  const folders = [];
  for (const match of source.matchAll(EMBED)) {
    const target = match[1];
    if (/^(?:https?|data|blob):/i.test(target)) continue;
    if (target.startsWith('/') || target.startsWith('~/') || /^file:\/\//i.test(target)) paths.push(target);
  }
  for (const match of source.matchAll(ABSOLUTE_PATH)) {
    const value = trimPunctuation(match[0]);
    if (MEDIA_NAME.test(value)) paths.push(value);
    else if (value.length > 1) folders.push(value.replace(/\/+$/, '') || '/');
  }
  const names = [];
  if (folders.length) {
    for (const match of source.matchAll(BARE_MEDIA_NAME)) {
      const name = match[0].trim();
      if (!name.includes('/')) names.push(name);
    }
  }
  const unique = (list) => [...new Set(list)];
  return {
    paths: unique(paths).slice(0, MENTIONED_MAX),
    joined: unique(unique(folders).slice(0, 10).flatMap((folder) => unique(names).slice(0, 40).map((name) => `${folder}/${name}`))).slice(0, MENTIONED_MAX),
  };
};

/**
 * The files one reply attaches. `add(paths)` checks each (a regular file, at
 * most 25 MB, at most 10 per reply) → a line per path for the model.
 */
export const createReplyFiles = ({ stat = (file) => fs.stat(file), home = os.homedir(), max = REPLY_FILES_MAX } = {}) => {
  const files = [];
  const add = async (paths, { quiet = false } = {}) => {
    const lines = [];
    for (const raw of Array.isArray(paths) ? paths : []) {
      const resolved = resolveLocalPath(raw, home);
      if (!resolved || !path.isAbsolute(resolved)) {
        if (!quiet) lines.push(`${raw}: not a full path on this computer.`);
        continue;
      }
      const filePath = path.normalize(resolved);
      if (files.some((file) => file.path === filePath)) {
        if (!quiet) lines.push(`${raw}: already attached.`);
        continue;
      }
      if (files.length >= max) {
        if (!quiet) lines.push(`${raw}: not attached (at most ${max} files per reply).`);
        continue;
      }
      const info = await stat(filePath).catch(() => null);
      if (!info?.isFile?.()) {
        if (!quiet) lines.push(`${raw}: no such file.`);
        continue;
      }
      if (info.size > REPLY_FILE_MAX_BYTES) {
        if (!quiet) lines.push(`${raw}: over 25 MB, not attached.`);
        continue;
      }
      files.push({ path: filePath, name: path.basename(filePath), size: info.size });
      lines.push(`${raw}: attached.`);
    }
    return lines;
  };
  return { add, list: () => files.map((file) => ({ ...file })) };
};

/**
 * One of a reply's messages before its final answer, right away (it is sent
 * before the reply writes on): the media files its text points at (to attach
 * with the reply, `paths`), and its text without the image embeds of the ones
 * on this computer (they show as the reply's files instead).
 */
export const messageMediaOf = (text, { home = os.homedir() } = {}) => {
  const mentioned = mentionedMediaPaths(text);
  const paths = [...mentioned.paths, ...mentioned.joined];
  const isFile = (target) => {
    try {
      const info = statSync(path.normalize(resolveLocalPath(target, home)));
      return info.isFile() && info.size <= REPLY_FILE_MAX_BYTES;
    } catch {
      return false;
    }
  };
  const stripped = String(text ?? '')
    .replace(EMBED, (embed, target) => (isFile(target) ? '' : embed))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: stripped || String(text ?? ''), paths };
};

/**
 * The reply's final text and files: what its text points at is attached too
 * (screenshots named by path, or by name next to their folder), and image
 * embeds of attached files leave the text, since they show as the reply's
 * files instead (an embedded /tmp path shows nowhere but this computer).
 */
export const finishReplyFiles = async (text, replyFiles, { home = os.homedir() } = {}) => {
  const mentioned = mentionedMediaPaths(text);
  await replyFiles.add(mentioned.paths, { quiet: true });
  await replyFiles.add(mentioned.joined, { quiet: true });
  const files = replyFiles.list();
  if (!files.length) return { text, files };
  const attached = new Set(files.map((file) => file.path));
  const stripped = String(text ?? '')
    .replace(EMBED, (embed, target) => (attached.has(path.normalize(resolveLocalPath(target, home))) ? '' : embed))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: stripped, files };
};

// --- cards: signed-out bots run show_html and show_actions here ----------------------------

export const LOCAL_CARD_TOOLS = Object.freeze([
  {
    name: 'show_html',
    description:
      'Render a custom HTML/CSS/JS visual inline in your reply, in a sandboxed frame: a chart of numbers, a comparison, a mockup, an illustrated explainer, a small interactive explorer. Fully self-contained: inline <style>/<script>, vanilla JS, inline SVG/canvas, data: URIs; no network. Leave html and body without background, border or outer padding; let content set the height. Theme via CSS variables: --background --foreground --card --muted --muted-foreground --border --primary --success --warning --danger --viz-1…--viz-8. Say the takeaway in a sentence; don\'t restate the page.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, sentence case.' },
        description: { type: 'string', description: 'One line: what it is.' },
        html: { type: 'string', description: 'Self-contained HTML (fragment or full document), under ~40 KB.' },
        height: { type: 'string', enum: ['sm', 'md', 'lg', 'auto'], description: 'Frame height: sm 260px, md 420px, lg 640px, auto (default) fits the content.' },
      },
      required: ['title', 'html'],
    },
  },
  {
    name: 'show_actions',
    description:
      'Show buttons under your reply that the person can tap. Kinds: open_thread (a Durango Code thread on this computer, thread_id), open_url (a web page, url + label), reply (sends text, or the label, as the person\'s next message: quick replies). ship_change ships a Durango Source change (chg_…) through the thread that made it: give its thread_id from the task report too (the person confirms first; that thread ships it its project\'s way). open_change takes a change id and needs the person signed in. At most 6 buttons; never invent ids or URLs. The buttons go on the text you wrote right before the call in the same step; called with no text before it, on the next message you write. For buttons under your final answer: call it first, then write the answer (don\'t mention the buttons, and never write [Showed buttons…] or <bot_card_history …> notes in your text).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One short line above the buttons (optional).' },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['ship_change', 'open_change', 'open_thread', 'open_url', 'reply'] },
              label: { type: 'string', description: 'Button text; short. Required for open_url and reply.' },
              change_id: { type: 'string' },
              thread_id: { type: 'string' },
              url: { type: 'string' },
              text: { type: 'string', description: 'reply: what the button sends (default: the label).' },
            },
            required: ['kind'],
          },
        },
      },
      required: ['actions'],
    },
  },
]);

const HTML_MAX_CHARS = 120_000;
const CHANGE_ID = /^chg_[a-z0-9]{8,40}$/;
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const WEB_URL = /^https?:\/\/[^\s]+$/i;
const ACTION_KINDS = new Set(['ship_change', 'open_change', 'open_thread', 'open_url', 'reply']);
const cut = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** show_html's input → html card props, or an error for the model. */
export const normalizeHtmlCard = (input) => {
  const title = cut(input?.title, 90);
  const html = typeof input?.html === 'string' ? input.html : '';
  if (!title || !html.trim()) return { error: 'show_html needs a title and html.' };
  if (html.length > HTML_MAX_CHARS) return { error: 'That page is too large: simplify it (under ~40 KB) and call again.' };
  const height = ['sm', 'md', 'lg', 'auto'].includes(input?.height) ? input.height : undefined;
  const description = cut(input?.description, 240);
  return { props: { title, html, ...(description ? { description } : {}), ...(height ? { height } : {}) } };
};

/** One button, checked per kind (the same rules as Durango's lib/bots/ui.ts), or null. */
export const normalizeBotAction = (raw) => {
  const kind = typeof raw?.kind === 'string' ? raw.kind : '';
  if (!ACTION_KINDS.has(kind)) return null;
  const label = cut(raw.label, 40);
  const url = cut(raw.url, 2000);
  if (url && !WEB_URL.test(url)) return null;
  const action = { kind, ...(label ? { label } : {}) };
  if (kind === 'ship_change' || kind === 'open_change') {
    const changeId = cut(raw.change_id, 64);
    if (!CHANGE_ID.test(changeId)) return null;
    // Ship: the thread that made the change ships it (bots' Shipping rule).
    const threadId = kind === 'ship_change' ? cut(raw.thread_id, 128) : '';
    return { ...action, change_id: changeId, ...(THREAD_ID.test(threadId) ? { thread_id: threadId } : {}), ...(url ? { url } : {}) };
  }
  if (kind === 'open_thread') {
    const threadId = cut(raw.thread_id, 128);
    return THREAD_ID.test(threadId) ? { ...action, thread_id: threadId } : null;
  }
  if (kind === 'open_url') return url && label ? { ...action, url } : null;
  const text = cut(raw.text, 500);
  return label ? { ...action, ...(text ? { text } : {}) } : null;
};

/** show_actions's input → bot-actions card props, or an error for the model. */
export const normalizeActionsCard = (input) => {
  const actions = (Array.isArray(input?.actions) ? input.actions : []).slice(0, 6).map(normalizeBotAction).filter(Boolean);
  if (!actions.length) return { error: 'show_actions needs at least one valid button (see each kind\'s fields).' };
  const title = cut(input?.title, 120);
  return { props: { ...(title ? { title } : {}), actions } };
};

/** A local reply's card from one of LOCAL_CARD_TOOLS → `{ card }` or `{ error }`. */
export const localCard = (name, input, id) => {
  const normalized = name === 'show_html' ? normalizeHtmlCard(input) : name === 'show_actions' ? normalizeActionsCard(input) : null;
  if (!normalized) return null;
  if (normalized.error) return { error: normalized.error };
  return { card: { id, component: name === 'show_html' ? 'html' : 'bot-actions', props: normalized.props } };
};

// --- card history markers & outgoing reply guards -------------------------------------------
// Mirrors chat/convex/botPolicy.ts (code/ is projected publicly and stays standalone).

/** Formats a card for a bot's conversation history as a system-record tag instead of bracketed prose. */
export const formatBotCardHistoryNote = (tool, body, { status } = {}) => {
  const clean = String(body ?? '')
    .replace(/\s+/g, ' ')
    .replace(/<\/?bot_card_history\b/gi, '')
    .trim();
  const statusAttr = status
    ? ` status="${String(status).replace(/\s+/g, ' ').replace(/"/g, "'").trim()}"`
    : '';
  return `<bot_card_history tool="${tool}"${statusAttr}>${clean}</bot_card_history>`;
};

const BOT_CARD_HISTORY_FAST_RE =
  /(?:<bot_card_history|\[showed buttons|\[asked the (?:person|user)|\[showed a page|\[displayed html artifact)/i;

const findInlineCodeSpansOnLine = (line) => {
  const runs = [];
  for (let i = 0; i < line.length; ) {
    if (line.charCodeAt(i) !== 96) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < line.length && line.charCodeAt(i) === 96) i += 1;
    runs.push({ start, len: i - start });
  }
  if (runs.length < 2) return [];
  const byLen = new Map();
  for (let r = 0; r < runs.length; r += 1) {
    const list = byLen.get(runs[r].len);
    if (list) list.push(r);
    else byLen.set(runs[r].len, [r]);
  }
  const cursor = new Map();
  const spans = [];
  for (let r = 0; r < runs.length; ) {
    const len = runs[r].len;
    const list = byLen.get(len);
    let c = cursor.get(len) ?? 0;
    while (c < list.length && list[c] <= r) c += 1;
    cursor.set(len, c);
    if (c < list.length) {
      const closeIdx = list[c];
      spans.push([runs[r].start, runs[closeIdx].start + runs[closeIdx].len]);
      r = closeIdx + 1;
    } else {
      r += 1;
    }
  }
  return spans;
};

const splitMarkdownCodeSegments = (text) => {
  const segments = [];
  const push = (slice, isCode) => {
    if (!slice) return;
    const prev = segments[segments.length - 1];
    if (prev && prev.isCode === isCode) prev.text += slice;
    else segments.push({ text: slice, isCode });
  };

  let pos = 0;
  let fenceChar = '';
  let fenceLen = 0;
  let fenceStart = -1;

  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl + 1;
    const rawLine = text.slice(pos, lineEnd);
    const lineBody = rawLine.endsWith('\r\n')
      ? rawLine.slice(0, -2)
      : rawLine.endsWith('\n')
        ? rawLine.slice(0, -1)
        : rawLine;

    if (fenceChar) {
      let indent = 0;
      while (indent < lineBody.length && indent < 3 && (lineBody[indent] === ' ' || lineBody[indent] === '\t')) {
        indent += 1;
      }
      let run = indent;
      while (run < lineBody.length && lineBody[run] === fenceChar) run += 1;
      let tail = run;
      while (tail < lineBody.length && (lineBody[tail] === ' ' || lineBody[tail] === '\t')) tail += 1;
      if (run - indent >= fenceLen && tail === lineBody.length) {
        const bodyEnd = pos + lineBody.length;
        push(text.slice(fenceStart, bodyEnd), true);
        if (bodyEnd < lineEnd) push(text.slice(bodyEnd, lineEnd), false);
        fenceChar = '';
        fenceLen = 0;
        fenceStart = -1;
      }
      pos = lineEnd;
      continue;
    }

    let indent = 0;
    while (indent < lineBody.length && indent < 3 && (lineBody[indent] === ' ' || lineBody[indent] === '\t')) {
      indent += 1;
    }
    const ch = lineBody[indent];
    if (ch === '`' || ch === '~') {
      let run = indent;
      while (run < lineBody.length && lineBody[run] === ch) run += 1;
      const count = run - indent;
      if (count >= 3 && (ch === '~' || lineBody.indexOf('`', run) === -1)) {
        fenceChar = ch;
        fenceLen = count;
        fenceStart = pos;
        pos = lineEnd;
        continue;
      }
    }

    const spans = rawLine.includes('`') ? findInlineCodeSpansOnLine(rawLine) : [];
    if (!spans.length) {
      push(rawLine, false);
    } else {
      let last = 0;
      for (const [s, e] of spans) {
        if (s > last) push(rawLine.slice(last, s), false);
        push(rawLine.slice(s, e), true);
        last = e;
      }
      if (last < rawLine.length) push(rawLine.slice(last), false);
    }
    pos = lineEnd;
  }

  if (fenceChar && fenceStart >= 0) {
    push(text.slice(fenceStart), true);
  }
  return segments;
};

const isHorizontalSpace = (ch) => ch === ' ' || ch === '\t';

const matchesBracketCardPrefix = (lower, index, allowStreamingTail) => {
  if (lower.startsWith('[showed buttons', index)) {
    const after = index + '[showed buttons'.length;
    if (after === lower.length) return allowStreamingTail;
    const next = lower[after];
    if (next === ']' || next === ':') return true;
    if (isHorizontalSpace(next)) {
      let p = after;
      while (p < lower.length && isHorizontalSpace(lower[p])) p += 1;
      if (lower[p] === ':') return true;
      if (lower.startsWith('under', p)) {
        const u = p + 'under'.length;
        return u === lower.length ? allowStreamingTail : isHorizontalSpace(lower[u]);
      }
    }
    return false;
  }
  for (const prefix of ['[asked the person', '[asked the user']) {
    if (lower.startsWith(prefix, index)) {
      let p = index + prefix.length;
      while (p < lower.length && isHorizontalSpace(lower[p])) p += 1;
      return lower[p] === ':';
    }
  }
  for (const prefix of ['[showed a page', '[displayed html artifact']) {
    if (lower.startsWith(prefix, index)) {
      let p = index + prefix.length;
      if (p === lower.length || !isHorizontalSpace(lower[p])) continue;
      while (p < lower.length && isHorizontalSpace(lower[p])) p += 1;
      return lower[p] === '"' || lower[p] === '\u201c';
    }
  }
  return false;
};

const findClosingBracketOnLine = (text, openIndex, lineEnd) => {
  let depth = 1;
  let quote = '';
  for (let j = openIndex + 1; j < lineEnd; j += 1) {
    const ch = text[j];
    if (quote) {
      if (ch === '\\' && j + 1 < lineEnd) {
        j += 1;
        continue;
      }
      if ((quote === '"' && ch === '"') || (quote === '\u201c' && (ch === '\u201d' || ch === '"'))) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === '\u201c') {
      quote = ch;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  if (quote) {
    depth = 1;
    for (let j = openIndex + 1; j < lineEnd; j += 1) {
      const ch = text[j];
      if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) return j;
      }
    }
  }
  return -1;
};

const stripCardNotesFromSegment = (segment, allowStreamingTail) => {
  const lower = segment.toLowerCase();
  const spans = [];
  let nextXmlClose = -2;
  let cachedLineEnd = -1;
  let cachedLineBreak = -1;

  for (let i = 0; i < segment.length; ) {
    const ch = segment[i];
    if (ch === '<' && lower.startsWith('<bot_card_history', i)) {
      const afterName = i + '<bot_card_history'.length;
      const boundary = segment[afterName];
      const validBoundary =
        afterName === segment.length
          ? allowStreamingTail
          : boundary === '>' || boundary === '/' || boundary === ' ' || boundary === '\t' || boundary === '\r' || boundary === '\n';
      if (!validBoundary) {
        i += 1;
        continue;
      }
      let gt = -1;
      let quote = '';
      const tagLimit = Math.min(segment.length, i + 512);
      for (let j = afterName; j < tagLimit; j += 1) {
        const c = segment[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === '>') {
          gt = j;
          break;
        }
      }
      if (gt === -1) {
        if (allowStreamingTail && segment.length - i <= 512) {
          spans.push({ start: i, end: segment.length });
          break;
        }
        i += 1;
        continue;
      }
      if (nextXmlClose === -2 || (nextXmlClose !== -1 && nextXmlClose <= gt)) {
        nextXmlClose = lower.indexOf('</bot_card_history>', gt + 1);
      }
      if (nextXmlClose !== -1 && nextXmlClose - gt <= 4000) {
        const end = nextXmlClose + '</bot_card_history>'.length;
        spans.push({ start: i, end });
        i = end;
        continue;
      }
      if (allowStreamingTail && nextXmlClose === -1 && segment.length - i <= 4000) {
        spans.push({ start: i, end: segment.length });
        break;
      }
      i = gt + 1;
      continue;
    }

    if (ch === '[' && matchesBracketCardPrefix(lower, i, allowStreamingTail)) {
      if (i > cachedLineBreak) {
        const nl = segment.indexOf('\n', i);
        cachedLineBreak = nl === -1 ? segment.length : nl;
        cachedLineEnd = nl === -1
          ? segment.length
          : nl > 0 && segment[nl - 1] === '\r'
            ? nl - 1
            : nl;
      }
      const lineEnd = cachedLineEnd;
      const scanLimit = Math.min(lineEnd, i + 2501);
      const closeIdx = findClosingBracketOnLine(segment, i, scanLimit);
      if (closeIdx !== -1) {
        const nextChar = segment[closeIdx + 1];
        if (nextChar === '(' || nextChar === '[') {
          i = closeIdx + 1;
          continue;
        }
        spans.push({ start: i, end: closeIdx + 1 });
        i = closeIdx + 1;
        continue;
      }
      if (allowStreamingTail && lineEnd === segment.length && segment.length - i <= 2500) {
        spans.push({ start: i, end: segment.length });
        break;
      }
    }

    i += 1;
  }

  if (!spans.length) return { text: segment, changed: false };

  let out = '';
  let cursor = 0;
  for (const span of spans) {
    let start = span.start;
    const end = span.end;
    if (start < cursor) start = cursor;
    let wsBefore = start;
    while (wsBefore > cursor && isHorizontalSpace(segment[wsBefore - 1])) wsBefore -= 1;
    let wsAfter = end;
    while (wsAfter < segment.length && isHorizontalSpace(segment[wsAfter])) wsAfter += 1;

    const atLineStart = wsBefore === 0 || segment[wsBefore - 1] === '\n';
    const atLineEnd = wsAfter === segment.length || segment[wsAfter] === '\n' || segment[wsAfter] === '\r';

    if (atLineStart && atLineEnd) {
      out += segment.slice(cursor, wsBefore);
      let nextPos = wsAfter;
      if (segment[nextPos] === '\r' && segment[nextPos + 1] === '\n') nextPos += 2;
      else if (segment[nextPos] === '\n') nextPos += 1;
      cursor = nextPos;
    } else if (atLineEnd) {
      out += segment.slice(cursor, wsBefore);
      cursor = wsAfter;
    } else if (atLineStart) {
      out += segment.slice(cursor, start);
      cursor = wsAfter;
    } else {
      const beforeChar = wsBefore > cursor ? segment[wsBefore - 1] : out[out.length - 1] ?? '';
      const afterChar = segment[wsAfter] ?? '';
      out += segment.slice(cursor, wsBefore);
      if (beforeChar && !/\s/.test(beforeChar) && afterChar && !/\s/.test(afterChar)) {
        out += ' ';
      }
      cursor = wsAfter;
    }
  }
  if (cursor < segment.length) out += segment.slice(cursor);

  const normalized = out.replace(/\r?\n[ \t]*(?=\r?\n)/g, '\n').replace(/\n{3,}/g, '\n\n');
  return { text: normalized, changed: true };
};

/**
 * Defensive guard for outgoing bot text: strips leaked card-history markers
 * (`<bot_card_history …>`, `[Showed buttons…]`, `[Asked the person: …]`,
 * `[showed a page "…"]`, `[Displayed html artifact "…"]`) outside fenced and
 * inline code spans in strict O(n) time while leaving normal prose, links,
 * and code untouched. Pure.
 */
export const stripBotCardHistoryNotes = (text, { streaming = false } = {}) => {
  if (typeof text !== 'string' || !text) return '';
  if (!BOT_CARD_HISTORY_FAST_RE.test(text)) return text;
  const segments = splitMarkdownCodeSegments(text);
  let changed = false;
  const outSegments = segments.map((segment, index) => {
    if (segment.isCode) return segment;
    const isFinalTail = streaming === true && index === segments.length - 1;
    const cleaned = stripCardNotesFromSegment(segment.text, isFinalTail);
    if (cleaned.changed) changed = true;
    return { text: cleaned.text, isCode: false };
  });
  if (!changed) return text;
  let first = 0;
  while (first < outSegments.length && !outSegments[first].isCode && !outSegments[first].text.trim()) first += 1;
  let last = outSegments.length - 1;
  while (last >= first && !outSegments[last].isCode && !outSegments[last].text.trim()) last -= 1;
  if (first > last) return '';
  const trimmed = outSegments.slice(first, last + 1);
  if (!trimmed[0].isCode) trimmed[0] = { ...trimmed[0], text: trimmed[0].text.replace(/^\s+/, '') };
  const tailIdx = trimmed.length - 1;
  if (!trimmed[tailIdx].isCode) trimmed[tailIdx] = { ...trimmed[tailIdx], text: trimmed[tailIdx].text.replace(/\s+$/, '') };
  return trimmed.map((seg) => seg.text).join('');
};

/** Canonical text for spotting an identical consecutive message within a single bot reply. Pure. */
export const normalizeBotReplyForDedup = (text) => stripBotCardHistoryNotes(text).replace(/\s+/g, ' ').trim();
