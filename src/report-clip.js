// Shared report clipping and final-message selection for Durango Code (renderer + main).
// Mirrors Durango's server-side report helpers so desktop and server behave
// identically when selecting a turn's final message or trimming overlong text.

const LONG_MIDDLE_MARKER_MIN_MAX = 120;
const MULTILINE_MIDDLE_MARKER = '\n\n…[middle trimmed]…\n\n';
const INLINE_MIDDLE_MARKER = ' …[middle trimmed]… ';
const SHORT_MIDDLE_MARKER = '…';

const SHORT_CLOSING_MAX_CHARS = 200;
const SUBSTANTIAL_PREV_MIN_CHARS = 300;
const SUBSTANTIAL_PREV_RATIO = 3;

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
 */
export const clipMiddle = (value, max) => {
  const text = String(value ?? '').trim();
  if (max <= 0 || !text) return '';
  if (text.length <= max) return text;
  if (max === 1) return SHORT_MIDDLE_MARKER;

  const marker =
    max >= LONG_MIDDLE_MARKER_MIN_MAX
      ? text.includes('\n')
        ? MULTILINE_MIDDLE_MARKER
        : INLINE_MIDDLE_MARKER
      : SHORT_MIDDLE_MARKER;
  const budget = max - marker.length;
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
