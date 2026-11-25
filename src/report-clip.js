// Shared report clipping for Durango Code (renderer + main).
// Mirrors Durango's server-side report clipping so desktop and server clip
// identically when a report still exceeds a transport or inbox ceiling.

const LONG_MIDDLE_MARKER_MIN_MAX = 120;
const MULTILINE_MIDDLE_MARKER = '\n\n…[middle trimmed]…\n\n';
const INLINE_MIDDLE_MARKER = ' …[middle trimmed]… ';
const SHORT_MIDDLE_MARKER = '…';

/**
 * Trim only the middle when text exceeds `max`, preserving both the opening
 * summary and the closing outcome/links. Snaps to nearby line or word breaks
 * when room allows, and guarantees `result.length <= max`.
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
  const cleanHead = head.trimEnd() || text.slice(0, headBudget);

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
  const cleanTail = tailBudget > 0 ? tail.trimStart() || text.slice(text.length - tailBudget) : '';

  return `${cleanHead}${marker}${cleanTail}`;
};
