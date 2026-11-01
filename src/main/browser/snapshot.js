// Turns Chromium accessibility trees (CDP Accessibility.getFullAXTree) into the
// compact text outline the browser_snapshot tool returns. Pure: no Electron,
// so the format is unit-tested against fixtures.
//
//   Tab t2 · https://example.com/login · "Sign in"
//   - heading "Sign in" [level=1] [ref=e1]
//   - textbox "Email" [ref=e2] [focused]
//   - button "Continue" [ref=e3]

export const SNAPSHOT_DEFAULT_MAX_CHARS = 20_000;
export const SNAPSHOT_MIN_MAX_CHARS = 2_000;
export const SNAPSHOT_MAX_MAX_CHARS = 60_000;
const NAME_MAX = 200;
const TEXT_MAX = 400;

const TEXT_ROLES = new Set(['StaticText', 'text']);
const SKIPPED_ROLES = new Set(['InlineTextBox', 'LineBreak', 'ListMarker']);
// Structural wrappers that only matter when they carry a name.
const TRANSPARENT_ROLES = new Set([
  'generic',
  'none',
  'presentation',
  'GenericContainer',
  'Section',
  'section',
  'paragraph',
  'div',
  'Div',
  'LayoutTable',
  'LayoutTableRow',
  'LayoutTableCell',
  'RootWebArea',
  'WebArea',
  'Canvas',
  'superscript',
  'subscript',
  'strong',
  'emphasis',
  'mark',
  'time',
  'Abbr',
  'code',
  'label',
  'LabelText',
]);
// Document roots: the header already names the page.
const DOCUMENT_ROLES = new Set(['RootWebArea', 'WebArea']);
const BOOLEAN_PROPS = ['focused', 'disabled', 'required', 'selected', 'readonly', 'modal', 'multiselectable'];

export const clampSnapshotMaxChars = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return SNAPSHOT_DEFAULT_MAX_CHARS;
  return Math.min(SNAPSHOT_MAX_MAX_CHARS, Math.max(SNAPSHOT_MIN_MAX_CHARS, Math.round(number)));
};

const clean = (value, max = NAME_MAX) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const propertyMap = (node) => {
  const map = new Map();
  for (const property of node.properties ?? []) {
    if (property && typeof property.name === 'string') map.set(property.name, property.value?.value);
  }
  return map;
};

const describeProps = (node, props, masked) => {
  const parts = [];
  if (props.has('level')) parts.push(`[level=${props.get('level')}]`);
  const checked = props.get('checked');
  if (checked === 'true' || checked === true) parts.push('[checked]');
  else if (checked === 'mixed') parts.push('[checked=mixed]');
  const pressed = props.get('pressed');
  if (pressed === 'true' || pressed === true) parts.push('[pressed]');
  const expanded = props.get('expanded');
  if (expanded === true || expanded === 'true') parts.push('[expanded]');
  else if (expanded === false || expanded === 'false') parts.push('[collapsed]');
  for (const name of BOOLEAN_PROPS) {
    const value = props.get(name);
    if (value === true || value === 'true') parts.push(`[${name}]`);
  }
  const rawValue = node.value?.value;
  if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
    const value = masked ? '••••••' : clean(rawValue, NAME_MAX);
    if (value) parts.push(`[value=${JSON.stringify(value)}]`);
  }
  return parts;
};

/**
 * @param {object} input
 * @param {string} input.tabId
 * @param {string} input.url
 * @param {string} input.title
 * @param {Array} input.nodes            AX nodes of the main frame
 * @param {Map<number, Array>} [input.frames]  child-frame AX nodes keyed by the owner <iframe>'s backendDOMNodeId
 * @param {Set<number>} [input.maskedNodeIds]   backendDOMNodeIds whose values must not be shown (password fields)
 * @param {(backendNodeId: number) => string} input.allocateRef
 * @param {number} [input.maxChars]
 * @param {string[]} [input.notes]       extra lines under the header (e.g. an open dialog)
 * @returns {{ text: string, refCount: number, lineCount: number, truncatedLines: number }}
 */
export const buildSnapshot = ({
  tabId,
  url,
  title,
  nodes,
  frames = new Map(),
  maskedNodeIds = new Set(),
  allocateRef,
  maxChars = SNAPSHOT_DEFAULT_MAX_CHARS,
  notes = [],
}) => {
  let refCount = 0;

  const buildTree = (treeNodes) => {
    const byId = new Map();
    for (const node of treeNodes ?? []) byId.set(String(node.nodeId), node);
    const roots = (treeNodes ?? []).filter((node) => !node.parentId || !byId.has(String(node.parentId)));
    const visited = new Set();

    // Returns a list of items: { text } or { role, name, ref, props, children }.
    const visit = (node) => {
      if (!node || visited.has(node.nodeId)) return [];
      visited.add(node.nodeId);
      const childItems = () => {
        const items = [];
        for (const childId of node.childIds ?? []) items.push(...visit(byId.get(String(childId))));
        // A same-process frame's tree comes separately; graft it under its
        // <iframe> unless the main tree already inlined it.
        if ((node.role?.value === 'Iframe' || node.role?.value === 'iframe') && items.length === 0) {
          const frameNodes = frames.get(node.backendDOMNodeId);
          if (frameNodes) items.push(...buildTree(frameNodes));
        }
        return mergeText(items);
      };
      const role = String(node.role?.value ?? '');
      if (SKIPPED_ROLES.has(role)) return [];
      if (node.ignored) return childItems();
      const name = clean(node.name?.value);
      if (TEXT_ROLES.has(role)) {
        const text = clean(node.name?.value, TEXT_MAX);
        return text ? [{ text }] : [];
      }
      if (DOCUMENT_ROLES.has(role)) return childItems();
      const props = propertyMap(node);
      const masked = maskedNodeIds.has(node.backendDOMNodeId);
      const propParts = describeProps(node, props, masked);
      if (TRANSPARENT_ROLES.has(role) && !name && propParts.length === 0) return childItems();
      // Refs in document order: allocate before visiting the children.
      const ref =
        typeof node.backendDOMNodeId === 'number' && allocateRef ? allocateRef(node.backendDOMNodeId) : null;
      if (ref) refCount += 1;
      let children = childItems();
      // A control's text children usually repeat its name: drop them.
      if (name && children.length > 0 && children.every((item) => item.text !== undefined)) {
        const joined = clean(children.map((item) => item.text).join(' '), TEXT_MAX);
        if (joined === name || name.includes(joined) || joined.includes(name)) children = [];
      }
      return [{ role: role || 'unknown', name, ref, props: propParts, children }];
    };

    const items = [];
    for (const root of roots) items.push(...visit(root));
    return mergeText(items);
  };

  const mergeText = (items) => {
    const merged = [];
    for (const item of items) {
      const last = merged[merged.length - 1];
      if (item.text !== undefined && last?.text !== undefined) {
        last.text = clean(`${last.text} ${item.text}`, TEXT_MAX);
      } else {
        merged.push(item.text !== undefined ? { text: item.text } : item);
      }
    }
    return merged;
  };

  const lines = [];
  const serialize = (items, depth) => {
    const indent = '  '.repeat(depth);
    for (const item of items) {
      if (item.text !== undefined) {
        lines.push(`${indent}- text ${JSON.stringify(item.text)}`);
        continue;
      }
      const parts = [`${indent}- ${item.role}`];
      if (item.name) parts.push(JSON.stringify(item.name));
      if (item.ref) parts.push(`[ref=${item.ref}]`);
      parts.push(...item.props);
      lines.push(parts.join(' '));
      serialize(item.children, depth + 1);
    }
  };
  serialize(buildTree(nodes), 0);

  const header = [`Tab ${tabId} · ${url || 'about:blank'} · ${JSON.stringify(clean(title) || '')}`, ...notes];
  if (lines.length === 0) lines.push('- (the page has no accessible content yet)');

  const budget = clampSnapshotMaxChars(maxChars);
  let used = header.join('\n').length;
  let kept = 0;
  for (const line of lines) {
    if (used + 1 + line.length > budget) break;
    used += 1 + line.length;
    kept += 1;
  }
  const truncatedLines = lines.length - kept;
  const output = [...header, ...lines.slice(0, kept)];
  if (truncatedLines > 0) {
    output.push(`… ${truncatedLines} more lines (pass a larger max_chars, up to ${SNAPSHOT_MAX_MAX_CHARS}, to see them)`);
  }
  return { text: output.join('\n'), refCount, lineCount: lines.length, truncatedLines };
};
