// Shared report clipping and final-message selection for Durango Code (renderer + main).
// Mirrors Durango's server-side report helpers so desktop and server behave
// identically when selecting a turn's final message or trimming overlong text.

const LONG_MIDDLE_MARKER_MIN_MAX = 120;
const MIN_CONTENT_BUDGET_FOR_MARKER = 40;
const SHORT_MIDDLE_MARKER = '…';

const SHORT_CLOSING_MAX_CHARS = 200;
const SUBSTANTIAL_PREV_MIN_CHARS = 300;
const SUBSTANTIAL_PREV_RATIO = 3;

const SOURCE_CODE_EXTENSIONS = new Set([
  'astro', 'bash', 'c', 'cc', 'cjs', 'clj', 'cljs', 'cmake', 'conf', 'cpp', 'cs', 'css', 'cts', 'cxx',
  'dart', 'dockerfile', 'env', 'erl', 'ex', 'exs', 'fish', 'go', 'gql', 'gradle', 'graphql', 'h', 'hpp',
  'hs', 'ini', 'java', 'js', 'jsx', 'kt', 'kts', 'less', 'lua', 'makefile', 'mjs', 'ml', 'mts', 'nix',
  'php', 'prisma', 'proto', 'py', 'r', 'rb', 'rs', 'sass', 'scala', 'scss', 'sh', 'sql', 'svelte', 'swift',
  'tf', 'toml', 'ts', 'tsx', 'vue', 'yaml', 'yml', 'zig', 'zsh',
]);

const formatCharCount = (count) => String(Math.max(0, Math.round(count))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const normalizeThreadId = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : '';
};

const middleMarkerText = ({ multiline, countText, threadId }) => {
  const core = threadId
    ? `…[middle trimmed: ${countText} chars omitted — full report is in thread ${threadId}; call read_thread to read it in full]…`
    : `…[middle trimmed: ${countText} chars omitted]…`;
  return multiline ? `\n\n${core}\n\n` : ` ${core} `;
};

const decodeFileUrl = (rawUrl) => {
  if (!/^file:\/\/(?:\/|localhost\/)/i.test(rawUrl)) return null;
  const hashIdx = rawUrl.indexOf('#');
  const queryIdx = rawUrl.indexOf('?');
  const endIdx =
    hashIdx >= 0 && queryIdx >= 0
      ? Math.min(hashIdx, queryIdx)
      : hashIdx >= 0
        ? hashIdx
        : queryIdx >= 0
          ? queryIdx
          : rawUrl.length;
  const body = rawUrl.slice(0, endIdx).replace(/^file:\/\/localhost/i, 'file://');
  let filePath = body.slice('file://'.length);
  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    // Keep raw path if percent-encoding is malformed.
  }
  if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1);
  if (!filePath) return null;
  const fragment = hashIdx >= 0 ? rawUrl.slice(hashIdx + 1) : '';
  return { filePath, fragment };
};

const formatLineFragment = (fragment) => {
  if (!fragment) return '';
  const match = /^L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i.exec(fragment);
  if (match) {
    return match[2] && match[2] !== match[1] ? `:${match[1]}-${match[2]}` : `:${match[1]}`;
  }
  return `#${fragment}`;
};

const normalizeRoots = (options) => {
  const raw = [];
  if (typeof options?.rootPath === 'string') raw.push(options.rootPath);
  if (Array.isArray(options?.rootPaths)) raw.push(...options.rootPaths);
  return raw
    .map((entry) => String(entry ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter((entry) => entry.length > 1)
    .sort((a, b) => b.length - a.length);
};

const isSourceCodePath = (filePath) => {
  const base = filePath.replace(/\\/g, '/').split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return SOURCE_CODE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
};

const stripMatchingRoot = (filePath, roots, hasLineRef) => {
  if (!roots.length) return filePath;
  // Strip rootPath only for line-anchored references or unambiguous source-code files.
  // Non-code artifacts without line refs (.png, .html, .md, .txt, .json, .tar.gz, .pdf, etc.)
  // keep their full absolute path so attach_files still works.
  if (!hasLineRef && !isSourceCodePath(filePath)) return filePath;
  const normalized = filePath.replace(/\\/g, '/');
  for (const root of roots) {
    if (normalized.startsWith(`${root}/`)) {
      return normalized.slice(root.length + 1);
    }
  }
  return filePath;
};

const extractLabelLineRef = (rawLabel) => {
  const clean = rawLabel.trim().replace(/^`+|`+$/g, '').trim();
  const parenMatch = /\s*\((?:lines?\s*|L)(\d+)(?:\s*[-–]\s*L?(\d+))?\)\s*$/i.exec(clean);
  if (parenMatch) {
    const lineRef =
      parenMatch[2] && parenMatch[2] !== parenMatch[1] ? `:${parenMatch[1]}-${parenMatch[2]}` : `:${parenMatch[1]}`;
    return { base: clean.slice(0, parenMatch.index).trim(), lineRef };
  }
  const suffixMatch = /(?::(\d+)(?:-(\d+))?|#L?(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?)$/i.exec(clean);
  if (suffixMatch) {
    const start = suffixMatch[1] || suffixMatch[3];
    const end = suffixMatch[2] || suffixMatch[4];
    const lineRef = end && end !== start ? `:${start}-${end}` : `:${start}`;
    return { base: clean.slice(0, suffixMatch.index).trim(), lineRef };
  }
  return { base: clean, lineRef: '' };
};

const labelBaseMatchesPath = (labelBase, fullPath) => {
  if (!labelBase) return true;
  const normalizedBase = labelBase.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  if (!normalizedBase) return true;
  const normFull = fullPath.replace(/\\/g, '/').toLowerCase();
  const basename = normFull.slice(normFull.lastIndexOf('/') + 1);
  return normalizedBase === basename || normalizedBase === normFull || normFull.endsWith(`/${normalizedBase}`);
};

const findClosingInlineTicks = (line, start, tickLen) => {
  let pos = start;
  while (pos < line.length) {
    if (line[pos] === '`') {
      let runEnd = pos;
      while (runEnd < line.length && line[runEnd] === '`') runEnd += 1;
      if (runEnd - pos === tickLen) return runEnd;
      pos = runEnd;
    } else {
      pos += 1;
    }
  }
  return -1;
};

const findClosingBracket = (line, openPos) => {
  let depth = 0;
  let pos = openPos;
  while (pos < line.length) {
    const ch = line[pos];
    if (ch === '\\' && pos + 1 < line.length) {
      pos += 2;
      continue;
    }
    if (ch === '`') {
      let runEnd = pos;
      while (runEnd < line.length && line[runEnd] === '`') runEnd += 1;
      const close = findClosingInlineTicks(line, runEnd, runEnd - pos);
      pos = close >= 0 ? close : runEnd;
      continue;
    }
    if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return pos;
    }
    pos += 1;
  }
  return -1;
};

const parseLinkDestination = (line, openParenPos) => {
  let pos = openParenPos + 1;
  if (pos >= line.length) return null;
  if (line[pos] === '<') {
    const closeAngle = line.indexOf('>', pos + 1);
    if (closeAngle < 0 || line[closeAngle + 1] !== ')') return null;
    return { rawUrl: line.slice(pos + 1, closeAngle), endPos: closeAngle + 2 };
  }
  let parenDepth = 0;
  const urlStart = pos;
  while (pos < line.length) {
    const ch = line[pos];
    if (ch === '\\' && pos + 1 < line.length) {
      pos += 2;
      continue;
    }
    if (ch === ' ' || ch === '\t') return null;
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      if (parenDepth === 0) {
        return { rawUrl: line.slice(urlStart, pos), endPos: pos + 1 };
      }
      parenDepth -= 1;
    }
    pos += 1;
  }
  return null;
};

const compactLineFileLinks = (line, roots) => {
  if (!line.includes('file://')) return line;
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      out += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '`') {
      let runEnd = i;
      while (runEnd < line.length && line[runEnd] === '`') runEnd += 1;
      const close = findClosingInlineTicks(line, runEnd, runEnd - i);
      const end = close >= 0 ? close : runEnd;
      out += line.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '!' && line[i + 1] === '[') {
      const closeBracket = findClosingBracket(line, i + 1);
      if (closeBracket >= 0 && line[closeBracket + 1] === '(') {
        const dest = parseLinkDestination(line, closeBracket + 1);
        if (dest) {
          out += line.slice(i, dest.endPos);
          i = dest.endPos;
          continue;
        }
      }
      out += '!';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const closeBracket = findClosingBracket(line, i);
      if (closeBracket > i + 1 && line[closeBracket + 1] === '(') {
        const dest = parseLinkDestination(line, closeBracket + 1);
        if (dest) {
          const decoded = decodeFileUrl(dest.rawUrl);
          if (decoded) {
            const label = line.slice(i + 1, closeBracket);
            const { base: labelBase, lineRef: labelLineRef } = extractLabelLineRef(label);
            const matchesPath = labelBaseMatchesPath(labelBase, decoded.filePath);
            const urlSuffix = formatLineFragment(decoded.fragment);
            const suffix = urlSuffix || (matchesPath ? labelLineRef : '');
            const hasLineRef = suffix.startsWith(':');
            const pathPart = stripMatchingRoot(decoded.filePath, roots, hasLineRef);
            const ref = `${pathPart}${suffix}`;
            out += matchesPath ? ref : `${label} (${ref})`;
            i = dest.endPos;
            continue;
          }
        }
      }
    }
    out += ch;
    i += 1;
  }
  return out;
};

const quoteInfoOf = (line) => {
  const match = /^([ \t]*(?:>[ \t]?)*)(.*)$/.exec(line);
  const prefix = match ? match[1] : '';
  let depth = 0;
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] === '>') depth += 1;
  }
  return { depth, rest: match ? match[2] : line };
};

const isClosingFence = (rest, char, minLen) => {
  const trimmed = rest.trim();
  if (trimmed.length < minLen) return false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== char) return false;
  }
  return true;
};

/**
 * Turn verbose `file://` markdown links (e.g. `[foo.js](file:///repo/foo.js#L12-L34)`)
 * into compact plain `path:line` references so link markup doesn't eat report budgets.
 * Handles balanced parentheses in paths, balanced brackets in labels, label-only line
 * ranges, blockquoted and variable-length CommonMark code fences, inline code spans,
 * and image embeds (`![...](file://...)`). Preserves full paths for non-code files
 * without line references so `attach_files` still receives absolute paths.
 */
export const compactFileLinks = (value, options = undefined) => {
  const text = String(value ?? '');
  if (!text || !text.includes('file://')) return text;
  const roots = normalizeRoots(options);
  const parts = text.split(/(\r?\n)/);
  let fence = null;
  for (let idx = 0; idx < parts.length; idx += 2) {
    const line = parts[idx];
    const { depth, rest } = quoteInfoOf(line);
    if (fence) {
      if (depth < fence.depth) {
        fence = null;
      } else {
        if (depth === fence.depth && isClosingFence(rest, fence.char, fence.len)) {
          fence = null;
        }
        continue;
      }
    }
    const openMatch = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(rest);
    if (openMatch) {
      const fenceChar = openMatch[1][0];
      if (fenceChar !== '`' || !openMatch[2].includes('`')) {
        fence = { depth, char: fenceChar, len: openMatch[1].length };
        continue;
      }
    }
    parts[idx] = compactLineFileLinks(line, roots);
  }
  return parts.join('');
};

const trimLoneTrailingHighSurrogate = (value) => {
  if (!value) return value;
  const code = value.charCodeAt(value.length - 1);
  return code >= 0xd800 && code <= 0xdbff ? value.slice(0, -1) : value;
};

const trimLoneLeadingLowSurrogate = (value) => {
  if (!value) return value;
  const code = value.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff ? value.slice(1) : value;
};

/**
 * Trim only the middle when text exceeds `max`, preserving both the opening
 * summary and the closing outcome/links. Snaps to nearby line or word breaks
 * when room allows, never splits UTF-16 surrogate pairs, and guarantees
 * `result.length <= max`.
 *
 * When `max` allows a full marker, announces how many characters were omitted
 * and — when `options.threadId` is given — that the full report is in that
 * thread via `read_thread`.
 */
export const clipMiddle = (value, max, options = undefined) => {
  const text = String(value ?? '').trim();
  if (max <= 0 || !text) return '';
  if (text.length <= max) return text;
  if (max === 1) return SHORT_MIDDLE_MARKER;

  const multiline = text.includes('\n');
  const threadId = normalizeThreadId(options?.threadId);
  const maxCountText = formatCharCount(text.length);

  let markerKind = 'short';
  let worstMarker = SHORT_MIDDLE_MARKER;
  if (max >= LONG_MIDDLE_MARKER_MIN_MAX) {
    if (threadId) {
      const withThread = middleMarkerText({ multiline, countText: maxCountText, threadId });
      if (max - withThread.length >= MIN_CONTENT_BUDGET_FOR_MARKER) {
        markerKind = 'thread';
        worstMarker = withThread;
      }
    }
    if (markerKind === 'short') {
      const withCount = middleMarkerText({ multiline, countText: maxCountText, threadId: '' });
      if (max - withCount.length >= MIN_CONTENT_BUDGET_FOR_MARKER) {
        markerKind = 'count';
        worstMarker = withCount;
      }
    }
  }

  const budget = max - worstMarker.length;
  if (budget <= 0) return SHORT_MIDDLE_MARKER.slice(0, max);

  const headBudget = Math.ceil(budget * 0.6);
  const tailBudget = budget - headBudget;

  let head = text.slice(0, headBudget);
  if (headBudget >= 40) {
    const minLine = Math.floor(headBudget * 0.8);
    const minSpace = Math.floor(headBudget * 0.85);
    const nl = head.lastIndexOf('\n');
    if (nl >= minLine) {
      head = head.slice(0, nl);
    } else {
      const sp = head.search(/\s+\S*$/);
      if (sp >= minSpace) head = head.slice(0, sp);
    }
  }
  const cleanHead = trimLoneTrailingHighSurrogate(head.trimEnd() || text.slice(0, headBudget));

  let tail = tailBudget > 0 ? text.slice(text.length - tailBudget) : '';
  if (tailBudget >= 40) {
    const maxLine = Math.floor(tailBudget * 0.2);
    const maxSpace = Math.floor(tailBudget * 0.15);
    const nl = tail.indexOf('\n');
    if (nl >= 0 && nl <= maxLine) {
      tail = tail.slice(nl + 1);
    } else {
      const match = /^\S*\s+/.exec(tail);
      if (match && match[0].length <= maxSpace) tail = tail.slice(match[0].length);
    }
  }
  const cleanTail = tailBudget > 0 ? trimLoneLeadingLowSurrogate(tail.trimStart() || text.slice(text.length - tailBudget)) : '';

  const omitted = Math.max(0, text.length - cleanHead.length - cleanTail.length);
  const marker =
    markerKind === 'short'
      ? SHORT_MIDDLE_MARKER
      : middleMarkerText({
          multiline,
          countText: formatCharCount(omitted),
          threadId: markerKind === 'thread' ? threadId : '',
        });

  return `${cleanHead}${marker}${cleanTail}`;
};

/**
 * Pick the turn's actual final message from chronological non-empty text
 * segments separated by tool calls. Normally returns only the last segment so
 * earlier progress narration is dropped; if the last segment is a brief closing
 * postscript right after a substantial summary (e.g. a trailing cleanup or
 * attach step followed by "Attached the screenshot."), keeps that summary too.
 */
export const selectFinalMessage = (segments) => {
  const nonEmpty = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    const trimmed = String(segment ?? '').trim();
    if (trimmed) nonEmpty.push(trimmed);
  }
  if (nonEmpty.length === 0) return '';
  const last = nonEmpty[nonEmpty.length - 1];
  if (nonEmpty.length >= 2 && last.length < SHORT_CLOSING_MAX_CHARS) {
    const prev = nonEmpty[nonEmpty.length - 2];
    if (prev.length >= SUBSTANTIAL_PREV_MIN_CHARS && prev.length >= last.length * SUBSTANTIAL_PREV_RATIO) {
      return `${prev}\n\n${last}`;
    }
  }
  return last;
};
