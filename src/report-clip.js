// Shared report clipping and final-message selection for Durango Code (renderer + main).
// Mirrors Durango's server-side report helpers so desktop and server behave
// identically when selecting a turn's final message or trimming overlong text.

const LONG_MIDDLE_MARKER_MIN_MAX = 120;
const MIN_CONTENT_BUDGET_FOR_MARKER = 40;
const SHORT_MIDDLE_MARKER = '…';

const SHORT_CLOSING_MAX_CHARS = 200;
const SUBSTANTIAL_PREV_MIN_CHARS = 300;
const SUBSTANTIAL_PREV_RATIO = 3;

const NON_COMPACT_ROOT_EXTENSIONS =
  /\.(?:apng|avif|bmp|csv|docx?|gif|heic|ico|jpe?g|m4v|mov|mp3|mp4|ogg|pdf|png|pptx?|svg|tar|tiff?|wav|webm|webp|xlsx?|zip)$/i;

const COMPACT_LINKS_TOKEN =
  /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)|(`+)[^\n]*?\3|(!?)\[([^\]\n]+)\]\((?:<(file:\/\/[^>\n]+)>|(file:\/\/[^)\s]+))\)/g;

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

const stripMatchingRoot = (filePath, roots, hasLineRef) => {
  if (!roots.length) return filePath;
  if (!hasLineRef && NON_COMPACT_ROOT_EXTENSIONS.test(filePath)) return filePath;
  const normalized = filePath.replace(/\\/g, '/');
  for (const root of roots) {
    if (normalized.startsWith(`${root}/`)) {
      return normalized.slice(root.length + 1);
    }
  }
  return filePath;
};

const labelMatchesPath = (rawLabel, fullPath, displayPath) => {
  const clean = rawLabel.trim().replace(/^`+|`+$/g, '').trim();
  if (!clean) return true;
  const baseLabel = clean
    .replace(/\s*\((?:lines?\s*|L)\d+(?:\s*[-–]\s*L?\d+)?\)\s*$/i, '')
    .replace(/(?::\d+(?:-\d+)?|#L?\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/i, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();
  if (!baseLabel) return true;
  const normFull = fullPath.replace(/\\/g, '/').toLowerCase();
  const normDisplay = displayPath.replace(/\\/g, '/').toLowerCase();
  const basename = normFull.slice(normFull.lastIndexOf('/') + 1);
  return (
    baseLabel === basename ||
    baseLabel === normDisplay ||
    baseLabel === normFull ||
    normFull.endsWith(`/${baseLabel}`)
  );
};

/**
 * Turn verbose `file://` markdown links (e.g. `[foo.js](file:///repo/foo.js#L12-L34)`)
 * into compact plain `path:line` references so link markup doesn't eat report budgets.
 * Skips fenced code blocks, inline code spans, image embeds (`![...](file://...)`),
 * and non-`file://` URLs. Keeps descriptive labels intact and preserves full paths for
 * media/document attachments even when `rootPath`/`rootPaths` is provided.
 */
export const compactFileLinks = (value, options = undefined) => {
  const text = String(value ?? '');
  if (!text || !text.includes('file://')) return text;
  const roots = normalizeRoots(options);
  return text.replace(COMPACT_LINKS_TOKEN, (match, _fenceLead, fence, inlineTick, bang, label, angleUrl, bareUrl) => {
    if (fence || inlineTick || bang === '!') return match;
    const rawUrl = angleUrl || bareUrl;
    if (!rawUrl) return match;
    const decoded = decodeFileUrl(rawUrl);
    if (!decoded) return match;
    const suffix = formatLineFragment(decoded.fragment);
    const hasLineRef = suffix.startsWith(':');
    const pathPart = stripMatchingRoot(decoded.filePath, roots, hasLineRef);
    const ref = `${pathPart}${suffix}`;
    return labelMatchesPath(label, decoded.filePath, pathPart) ? ref : `${label} (${ref})`;
  });
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
