import fs from 'node:fs';
import path from 'node:path';

// Antigravity ACP protocol helpers:
// 1. Payload bounding and sanitization (detaching V8 sliced strings, stripping
//    base64 images and duplicate formatted outputs, enforcing node/text budgets).
// 2. Security warning extraction from permission option metadata.
// 3. Prompt-outliving tool classification (`run_command`, `schedule`, `IsDaemon`).
// 4. Dependency-free pre-edit unified diff generation with real line placement.

export const TOOL_TEXT_LIMIT = 8000;
export const TOOL_TEXT_TRUNCATED = '[Earlier output truncated]\n\n';
export const COMMAND_LINE_TRUNCATED = '\n\n[Command truncated]';
export const QUESTION_LABEL_LIMIT = 512;
export const SECURITY_WARNING_META_KEY = 'agy.security.warning';

const PAYLOAD_NODE_BUDGET = 512;
const PAYLOAD_TEXT_BUDGET = 64_000;
const PAYLOAD_MAX_DEPTH = 16;

const COMMAND_KEYS = new Set(['CommandLine', 'command_line', 'commandLine', 'command']);
const OUTPUT_KEYS = new Set(['aggregatedOutput', 'combinedOutput', 'combined_output', 'output', 'text']);
const DUPLICATE_OUTPUT_KEYS = new Set(['formatted_output', 'formattedOutput']);
const IMAGE_BLOB_KEYS = new Set(['data', 'blob']);
const DATA_IMAGE_PREFIX = /^\s*data:image\//i;

const PRE_EDIT_MAX_BYTES = 1024 * 1024;
const DIFF_MAX_CHANGED_LINES = 1000;
const DIFF_MAX_TEXT_BYTES = 256 * 1024;
const DIFF_CONTEXT_LINES = 3;

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

/** Detaches a string from any huge parent V8 SlicedString. */
export const copyBoundedText = (text) => {
  if (typeof text !== 'string' || !text.length) return '';
  return Buffer.from(text, 'utf16le').toString('utf16le');
};

const sliceHeadSafe = (text, maxLength) => {
  if (maxLength <= 0) return '';
  let end = Math.min(text.length, maxLength);
  if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
    end -= 1;
  }
  return copyBoundedText(text.slice(0, end));
};

const sliceTailSafe = (text, maxLength) => {
  if (maxLength <= 0) return '';
  let start = Math.max(0, text.length - maxLength);
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start))) {
    start += 1;
  }
  return copyBoundedText(text.slice(start));
};

/** Bounds a command line by keeping its head (UTF-16 high-surrogate safe). */
export const boundCommandLine = (text, limit = TOOL_TEXT_LIMIT) => {
  if (typeof text !== 'string') return '';
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : TOOL_TEXT_LIMIT;
  if (text.length <= cap) return copyBoundedText(text);
  if (cap <= COMMAND_LINE_TRUNCATED.length) return COMMAND_LINE_TRUNCATED.slice(0, cap);
  return `${sliceHeadSafe(text, cap - COMMAND_LINE_TRUNCATED.length)}${COMMAND_LINE_TRUNCATED}`;
};

/** Bounds command output by keeping its tail (UTF-16 low-surrogate safe). */
export const boundCommandText = (text, limit = TOOL_TEXT_LIMIT) => {
  if (typeof text !== 'string') return '';
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : TOOL_TEXT_LIMIT;
  if (text.length <= cap) return copyBoundedText(text);
  if (cap <= TOOL_TEXT_TRUNCATED.length) return TOOL_TEXT_TRUNCATED.slice(0, cap);
  return `${TOOL_TEXT_TRUNCATED}${sliceTailSafe(text, cap - TOOL_TEXT_TRUNCATED.length)}`;
};

/** Bounds a question/warning label by keeping its head with `...` (UTF-16 safe). */
export const boundQuestionText = (text, limit = QUESTION_LABEL_LIMIT) => {
  if (typeof text !== 'string') return '';
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : QUESTION_LABEL_LIMIT;
  if (text.length <= cap) return copyBoundedText(text);
  if (cap <= 3) return '.'.repeat(cap);
  return `${sliceHeadSafe(text, cap - 3)}...`;
};

const isImageObject = (record) => {
  if (!record || typeof record !== 'object') return false;
  if (record.type === 'image') return true;
  const mime = record.mimeType ?? record.mime_type;
  return typeof mime === 'string' && /^image\//i.test(mime.trim());
};

/**
 * Sanitizes an Antigravity ACP tool payload: strips `data:image/...` strings,
 * image `data`/`blob` fields, and duplicate `formatted_output`/`formattedOutput`;
 * bounds command fields (head) and output fields (tail); enforces node (512)
 * and total text (64_000) budgets.
 */
export const sanitizeAntigravityToolPayload = (payload) => {
  const state = {
    nodesRemaining: PAYLOAD_NODE_BUDGET,
    textRemaining: PAYLOAD_TEXT_BUDGET,
  };
  const seen = new WeakSet();

  const boundString = (value, key) => {
    if (DATA_IMAGE_PREFIX.test(value)) return undefined;
    if (state.textRemaining <= 0) return '';
    const limit = Math.min(TOOL_TEXT_LIMIT, state.textRemaining);
    let result;
    if (key && COMMAND_KEYS.has(key)) {
      result = boundCommandLine(value, limit);
    } else if (key && OUTPUT_KEYS.has(key)) {
      result = boundCommandText(value, limit);
    } else if (value.length <= limit) {
      result = copyBoundedText(value);
    } else {
      result = boundCommandText(value, limit);
    }
    state.textRemaining = Math.max(0, state.textRemaining - result.length);
    return result;
  };

  const visit = (value, key, depth) => {
    if (state.nodesRemaining <= 0 || depth > PAYLOAD_MAX_DEPTH) return undefined;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      state.nodesRemaining -= 1;
      return value;
    }
    if (typeof value === 'bigint') {
      state.nodesRemaining -= 1;
      return String(value);
    }
    if (typeof value === 'string') {
      state.nodesRemaining -= 1;
      return boundString(value, key);
    }
    if (typeof value !== 'object') return undefined;
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
    state.nodesRemaining -= 1;

    try {
      if (Array.isArray(value)) {
        const out = [];
        for (const item of value) {
          if (state.nodesRemaining <= 0) break;
          const sanitized = visit(item, null, depth + 1);
          if (sanitized !== undefined) out.push(sanitized);
        }
        return out;
      }

      const imageObj = isImageObject(value);
      const out = {};
      for (const [prop, propVal] of Object.entries(value)) {
        if (state.nodesRemaining <= 0) break;
        if (DUPLICATE_OUTPUT_KEYS.has(prop)) continue;
        if (imageObj && IMAGE_BLOB_KEYS.has(prop)) continue;
        if (prop === 'blob') continue;
        const sanitized = visit(propVal, prop, depth + 1);
        if (sanitized !== undefined) out[prop] = sanitized;
      }
      return out;
    } finally {
      seen.delete(value);
    }
  };

  return visit(payload, null, 0);
};

/** Reads `option._meta['agy.security.warning']` (`message` or `title`), bounded to 512 chars. */
export const antigravitySecurityWarning = (option) => {
  const warning = option?._meta?.[SECURITY_WARNING_META_KEY];
  if (!warning) return null;
  if (typeof warning === 'string') {
    const trimmed = warning.trim();
    return trimmed ? boundQuestionText(trimmed, QUESTION_LABEL_LIMIT) : null;
  }
  if (typeof warning === 'object') {
    const raw =
      (typeof warning.message === 'string' && warning.message.trim()) ||
      (typeof warning.title === 'string' && warning.title.trim()) ||
      '';
    return raw ? boundQuestionText(raw, QUESTION_LABEL_LIMIT) : null;
  }
  return null;
};

const isTerminalToolStatus = (status) =>
  status === 'done' || status === 'completed' || status === 'error' || status === 'failed' || status === 'cancelled';

const isDaemonRecord = (record) =>
  Boolean(record && typeof record === 'object' && (record.IsDaemon === true || record.isDaemon === true || record.is_daemon === true));

const isDaemonTool = (toolState) =>
  toolState?.isDaemon === true || isDaemonRecord(toolState?.rawInput) || isDaemonRecord(toolState?.args);

const isScheduleTool = (toolState) => {
  const name =
    typeof toolState?.toolName === 'string'
      ? toolState.toolName
      : typeof toolState?.name === 'string'
        ? toolState.name
        : '';
  const title = typeof toolState?.title === 'string' ? toolState.title.trim() : '';
  return name === 'schedule' || title === 'Run schedule' || title === 'Running schedule';
};

const isCommandTool = (toolState) => {
  const name =
    typeof toolState?.toolName === 'string'
      ? toolState.toolName
      : typeof toolState?.name === 'string'
        ? toolState.name
        : '';
  return toolState?.kind === 'execute' || name === 'run_command';
};

/** True when a non-terminal tool call is explicitly marked as a daemon (`IsDaemon: true`). */
export const antigravityIsDaemonTool = (toolState) => {
  if (!toolState || typeof toolState !== 'object') return false;
  if (isTerminalToolStatus(toolState.status)) return false;
  return isDaemonTool(toolState);
};

/** True when a command tool call can outlive the prompt (excludes daemons and schedule). */
export const antigravityCommandOutlivesPrompt = (toolState) => {
  if (!toolState || typeof toolState !== 'object') return false;
  if (isTerminalToolStatus(toolState.status)) return false;
  if (isDaemonTool(toolState)) return false;
  if (isScheduleTool(toolState)) return false;
  return isCommandTool(toolState);
};

/** True when any tool call (non-daemon command or non-daemon schedule) can outlive the prompt. */
export const antigravityToolOutlivesPrompt = (toolState) => {
  if (!toolState || typeof toolState !== 'object') return false;
  if (isTerminalToolStatus(toolState.status)) return false;
  if (isDaemonTool(toolState)) return false;
  return isScheduleTool(toolState) || isCommandTool(toolState);
};

// ---------------------------------------------------------------------------
// Pre-edit unified diff placement (zero external npm dependencies)
// ---------------------------------------------------------------------------

/** Synchronously reads a pre-edit UTF-8 text file up to 1 MiB, or null on failure/binary/non-file. */
export const readAntigravityPreEditFile = (filePath, cwd = null) => {
  if (typeof filePath !== 'string' || !filePath) return null;
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : typeof cwd === 'string' && cwd
      ? path.resolve(cwd, filePath)
      : null;
  if (!resolved) return null;
  let fd;
  try {
    // Check stat before openSync AND pass O_NONBLOCK so a FIFO/named pipe
    // supplied by a model tool call can never block Electron's main thread.
    const preStat = fs.statSync(resolved);
    if (!preStat.isFile() || preStat.size > PRE_EDIT_MAX_BYTES) return null;
    const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);
    fd = fs.openSync(resolved, openFlags);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > PRE_EDIT_MAX_BYTES) return null;
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = fs.readSync(fd, buffer, offset, stat.size - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    const slice = offset === stat.size ? buffer : buffer.subarray(0, offset);
    if (slice.includes(0)) return null;
    return slice.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
};

const pickString = (record, keys) => {
  if (!record || typeof record !== 'object') return undefined;
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key];
  }
  return undefined;
};

const pickPositiveInt = (record, keys) => {
  if (!record || typeof record !== 'object') return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  }
  return undefined;
};

const splitLines = (text) => {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  if (normalized === '') return [];
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const extractEditChunks = (rawInput) => {
  if (!rawInput || typeof rawInput !== 'object') return null;
  const rawChunks = rawInput.ReplacementChunks ?? rawInput.replacement_chunks ?? rawInput.replacementChunks;
  if (Array.isArray(rawChunks)) {
    if (!rawChunks.length) return null;
    const chunks = [];
    for (const entry of rawChunks) {
      if (!entry || typeof entry !== 'object') return null;
      const target = pickString(entry, ['TargetContent', 'target_content', 'targetContent', 'Target', 'target']);
      const replacement = pickString(entry, ['ReplacementContent', 'replacement_content', 'replacementContent', 'Replacement', 'replacement']);
      if (typeof target !== 'string' || typeof replacement !== 'string') return null;
      chunks.push({
        target,
        replacement,
        startLine: pickPositiveInt(entry, ['StartLine', 'start_line', 'startLine']),
        endLine: pickPositiveInt(entry, ['EndLine', 'end_line', 'endLine']),
      });
    }
    return chunks;
  }

  const target = pickString(rawInput, ['TargetContent', 'target_content', 'targetContent', 'Target', 'target']);
  const replacement = pickString(rawInput, ['ReplacementContent', 'replacement_content', 'replacementContent', 'Replacement', 'replacement']);
  if (typeof target !== 'string' || typeof replacement !== 'string') return null;
  return [
    {
      target,
      replacement,
      startLine: pickPositiveInt(rawInput, ['StartLine', 'start_line', 'startLine']),
      endLine: pickPositiveInt(rawInput, ['EndLine', 'end_line', 'endLine']),
    },
  ];
};

// Shortest edit script (Myers O((N+M)D)) capped at `maxChanges` edits.
// Returns an array of `{ type: 'equal' | 'delete' | 'insert', line }` or null
// when the edit distance exceeds `maxChanges`.
const myersLineDiff = (oldLines, newLines, maxChanges) => {
  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const a = oldLines.slice(prefix, oldLines.length - suffix);
  const b = newLines.slice(prefix, newLines.length - suffix);
  const n = a.length;
  const m = b.length;

  const ops = [];
  for (let i = 0; i < prefix; i += 1) ops.push({ type: 'equal', line: oldLines[i] });

  if (n === 0 && m === 0) {
    for (let i = 0; i < suffix; i += 1) ops.push({ type: 'equal', line: oldLines[oldLines.length - suffix + i] });
    return { ops, changes: 0 };
  }
  if (n === 0) {
    if (m > maxChanges) return null;
    for (let j = 0; j < m; j += 1) ops.push({ type: 'insert', line: b[j] });
    for (let i = 0; i < suffix; i += 1) ops.push({ type: 'equal', line: oldLines[oldLines.length - suffix + i] });
    return { ops, changes: m };
  }
  if (m === 0) {
    if (n > maxChanges) return null;
    for (let i = 0; i < n; i += 1) ops.push({ type: 'delete', line: a[i] });
    for (let i = 0; i < suffix; i += 1) ops.push({ type: 'equal', line: oldLines[oldLines.length - suffix + i] });
    return { ops, changes: n };
  }

  const maxD = Math.min(n + m, maxChanges);
  const offset = maxD;
  const v = new Int32Array(2 * maxD + 1);
  const trace = [];
  let foundD = -1;

  for (let d = 0; d <= maxD; d += 1) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
    if (foundD !== -1) break;
  }

  if (foundD === -1) return null;

  const middle = [];
  let x = n;
  let y = m;
  for (let d = foundD; d >= 1; d -= 1) {
    const prevV = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && prevV[d + k - 1] < prevV[d + k + 1]) ? k + 1 : k - 1;
    const prevX = prevV[d + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      middle.push({ type: 'equal', line: a[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      middle.push({ type: 'insert', line: b[y - 1] });
      y -= 1;
    } else {
      middle.push({ type: 'delete', line: a[x - 1] });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    middle.push({ type: 'equal', line: a[x - 1] });
    x -= 1;
    y -= 1;
  }
  middle.reverse();

  for (const op of middle) ops.push(op);
  for (let i = 0; i < suffix; i += 1) ops.push({ type: 'equal', line: oldLines[oldLines.length - suffix + i] });
  return { ops, changes: foundD };
};

// Converts a Myers op stream anchored at `baseOldIndex` into atomic edit runs:
// `{ oldStart, oldEnd, deleted, inserted }`.
const opsToEditRuns = (ops, baseOldIndex) => {
  const runs = [];
  let oldIdx = baseOldIndex;
  let current = null;
  for (const op of ops) {
    if (op.type === 'equal') {
      if (current) {
        runs.push(current);
        current = null;
      }
      oldIdx += 1;
      continue;
    }
    if (!current) current = { oldStart: oldIdx, oldEnd: oldIdx, deleted: [], inserted: [] };
    if (op.type === 'delete') {
      current.deleted.push(op.line);
      oldIdx += 1;
      current.oldEnd = oldIdx;
    } else {
      current.inserted.push(op.line);
    }
  }
  if (current) runs.push(current);
  return runs;
};

const findUniqueWholeLineMatch = (fileLines, targetLines, startLine, endLine) => {
  if (!targetLines.length) {
    return fileLines.length === 0 ? 0 : -1;
  }
  const searchStart = startLine !== undefined ? Math.max(0, startLine - 1) : 0;
  const searchEnd = endLine !== undefined ? Math.min(fileLines.length, endLine) : fileLines.length;
  const lastStart = searchEnd - targetLines.length;
  if (lastStart < searchStart) return -1;

  let matchIndex = -1;
  for (let i = searchStart; i <= lastStart; i += 1) {
    let matched = true;
    for (let k = 0; k < targetLines.length; k += 1) {
      if (fileLines[i + k] !== targetLines[k]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      if (matchIndex !== -1) return -1; // ambiguous
      matchIndex = i;
    }
  }
  return matchIndex;
};

const formatHunks = (baseLines, runs, { snippetOnly = false, initialDelta = 0 } = {}) => {
  if (!runs.length) return { hunks: [], additions: 0, deletions: 0, delta: initialDelta };

  const groups = [];
  let group = [runs[0]];
  for (let i = 1; i < runs.length; i += 1) {
    const prev = group[group.length - 1];
    const next = runs[i];
    if (next.oldStart - prev.oldEnd <= 2 * DIFF_CONTEXT_LINES) {
      group.push(next);
    } else {
      groups.push(group);
      group = [next];
    }
  }
  groups.push(group);

  const hunks = [];
  let additions = 0;
  let deletions = 0;
  let lineDelta = initialDelta;

  for (const hunkRuns of groups) {
    const first = hunkRuns[0];
    const last = hunkRuns[hunkRuns.length - 1];
    const ctxStart = Math.max(0, first.oldStart - DIFF_CONTEXT_LINES);
    const ctxEnd = Math.min(baseLines.length, last.oldEnd + DIFF_CONTEXT_LINES);
    const body = [];
    let oldCount = 0;
    let newCount = 0;

    let cursor = ctxStart;
    for (const run of hunkRuns) {
      while (cursor < run.oldStart) {
        body.push(` ${baseLines[cursor]}`);
        oldCount += 1;
        newCount += 1;
        cursor += 1;
      }
      for (const line of run.deleted) {
        body.push(`-${line}`);
        oldCount += 1;
        deletions += 1;
      }
      for (const line of run.inserted) {
        body.push(`+${line}`);
        newCount += 1;
        additions += 1;
      }
      cursor = run.oldEnd;
    }
    while (cursor < ctxEnd) {
      body.push(` ${baseLines[cursor]}`);
      oldCount += 1;
      newCount += 1;
      cursor += 1;
    }

    const oldStart = oldCount === 0 ? ctxStart : ctxStart + 1;
    const newStart0 = ctxStart + lineDelta;
    const newStart = newCount === 0 ? newStart0 : newStart0 + 1;
    lineDelta += newCount - oldCount;

    const suffix = snippetOnly ? ' snippet, line unknown' : '';
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${suffix}\n${body.join('\n')}`);
  }

  return { hunks, additions, deletions, delta: lineDelta };
};

/**
 * Computes a structured unified diff (`{ path, additions, deletions, patch, snippetOnly }`)
 * for Antigravity edit tools (`replace_file_content`, `multi_replace_file_content`,
 * `edit_file`), placing chunks against the pre-edit file when uniquely matchable.
 */
export const antigravityEditDiff = ({
  path: inputPath,
  rawInput,
  locations,
  readPreEditFile = readAntigravityPreEditFile,
} = {}) => {
  const chunks = extractEditChunks(rawInput);
  if (!chunks) return null;

  const explicitPath =
    (typeof inputPath === 'string' && inputPath) ||
    pickString(rawInput, ['TargetFile', 'target_file', 'Path', 'path', 'file_path', 'AbsolutePath']) ||
    (Array.isArray(locations) ? locations.find((loc) => typeof loc?.path === 'string' && loc.path)?.path : null) ||
    null;
  const resolvedPath = explicitPath || 'file';

  let totalTextBytes = 0;
  const prepared = [];
  for (const chunk of chunks) {
    totalTextBytes += Buffer.byteLength(chunk.target, 'utf8') + Buffer.byteLength(chunk.replacement, 'utf8');
    if (totalTextBytes > DIFF_MAX_TEXT_BYTES) return null;
    const targetLines = splitLines(chunk.target);
    const replacementLines = splitLines(chunk.replacement);
    prepared.push({ ...chunk, targetLines, replacementLines });
  }

  const preEditText =
    typeof readPreEditFile === 'function' && (explicitPath || readPreEditFile !== readAntigravityPreEditFile)
      ? readPreEditFile(explicitPath ?? '')
      : null;
  const fileLines = typeof preEditText === 'string' ? splitLines(preEditText) : null;

  let placedCount = 0;
  if (fileLines) {
    for (const chunk of prepared) {
      chunk.matchStart = findUniqueWholeLineMatch(fileLines, chunk.targetLines, chunk.startLine, chunk.endLine);
      if (chunk.matchStart !== -1) placedCount += 1;
    }
  } else {
    for (const chunk of prepared) chunk.matchStart = -1;
  }

  // Mixed placed/unplaced chunks cannot produce a coherent diff.
  if (placedCount > 0 && placedCount < prepared.length) return null;

  const allPlaced = fileLines !== null && placedCount === prepared.length;
  let remainingChangeBudget = DIFF_MAX_CHANGED_LINES;

  if (allPlaced) {
    const ordered = [...prepared].sort((a, b) => a.matchStart - b.matchStart);
    for (let i = 1; i < ordered.length; i += 1) {
      const prevEnd = ordered[i - 1].matchStart + ordered[i - 1].targetLines.length;
      if (ordered[i].matchStart < prevEnd) return null; // overlapping chunks
    }

    const allRuns = [];
    for (const chunk of ordered) {
      const diff = myersLineDiff(chunk.targetLines, chunk.replacementLines, remainingChangeBudget);
      if (!diff) return null;
      remainingChangeBudget -= diff.changes;
      const runs = opsToEditRuns(diff.ops, chunk.matchStart);
      for (const run of runs) allRuns.push(run);
    }
    if (!allRuns.length) return null;

    const { hunks, additions, deletions } = formatHunks(fileLines, allRuns, { snippetOnly: false });
    if (!hunks.length) return null;

    return {
      path: resolvedPath,
      additions,
      deletions,
      patch: `--- ${resolvedPath}\n+++ ${resolvedPath}\n${hunks.join('\n')}`,
      snippetOnly: false,
    };
  }

  // Unplaced / snippet-only fallback.
  const allHunks = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const chunk of prepared) {
    const diff = myersLineDiff(chunk.targetLines, chunk.replacementLines, remainingChangeBudget);
    if (!diff) return null;
    remainingChangeBudget -= diff.changes;
    const runs = opsToEditRuns(diff.ops, 0);
    if (!runs.length) continue;
    const { hunks, additions, deletions } = formatHunks(chunk.targetLines, runs, { snippetOnly: true });
    for (const hunk of hunks) allHunks.push(hunk);
    totalAdditions += additions;
    totalDeletions += deletions;
  }
  if (!allHunks.length) return null;

  return {
    path: resolvedPath,
    additions: totalAdditions,
    deletions: totalDeletions,
    patch: `--- ${resolvedPath}\n+++ ${resolvedPath}\n${allHunks.join('\n')}`,
    snippetOnly: true,
  };
};

/** Returns the unified diff patch string for an Antigravity edit tool call, or null. */
export const antigravityEditPatch = (options) => antigravityEditDiff(options)?.patch ?? null;
