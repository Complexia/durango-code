// Native Antigravity skill discovery: user/project roots, skills.json manifests
// (with inherits/entries/include_only/exclude), and plugin skills. Pure Node
// fs/promises + path + os with zero external dependencies.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const MAX_SCAN_BYTES = 8_000_000;
export const MAX_SCAN_ENTRIES = 10_000;
export const MAX_SKILL_BYTES = 1_000_000;

const FRONTMATTER_READ_BYTES = 64 * 1024;
const MAX_INHERIT_DEPTH = 10;
const SKILL_FILE_NAME = 'SKILL.md';

const unquoteYamlScalar = (value) => {
  const trimmed = String(value ?? '').trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\(["\\ntr])/g, (_, ch) => {
        if (ch === 'n') return '\n';
        if (ch === 't') return '\t';
        if (ch === 'r') return '\r';
        return ch;
      });
  }
  return trimmed;
};

/**
 * Lightweight YAML frontmatter parser for SKILL.md (`--- ... ---`).
 * Handles quoted/unquoted values, block scalars (`>`, `>-`, `|`, `|-`), and
 * folded/wrapped plain lines.
 */
export const parseAntigravitySkillFrontmatter = (text) => {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?=[ \t]*(?:\r?\n|$))/.exec(source);
  if (!match) return {};
  const fields = {};
  let key = null;
  let blockStyle = null;
  for (const line of match[1].split(/\r?\n/)) {
    if (key && blockStyle && (line.trim() === '' || /^\s/.test(line))) {
      const piece = line.trim();
      if (piece === '') {
        if (fields[key]) fields[key] += '\n';
      } else {
        fields[key] = fields[key] ? `${fields[key]}${blockStyle === '|' ? '\n' : ' '}${piece}` : piece;
      }
      continue;
    }
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const entry = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (entry) {
      key = entry[1];
      const rawValue = entry[2].trim();
      if (/^[|>][+-]?$/.test(rawValue)) {
        blockStyle = rawValue[0];
        fields[key] = '';
      } else {
        blockStyle = null;
        fields[key] = unquoteYamlScalar(rawValue);
      }
      continue;
    }
    if (key && !blockStyle && /^\s+\S/.test(line)) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  for (const fieldKey of Object.keys(fields)) {
    fields[fieldKey] = fields[fieldKey].trim();
  }
  return fields;
};

const safeStat = async (targetPath) => {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
};

const canonicalPath = async (targetPath) => {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
};

const readLeadingUtf8 = async (filePath, fileSize) => {
  const toRead = Math.min(fileSize, FRONTMATTER_READ_BYTES);
  if (toRead <= 0) return '';
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await handle.read(buffer, 0, toRead, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
};

const readJsonFile = async (filePath, budget) => {
  const stat = await safeStat(filePath);
  if (!stat || !stat.isFile()) return null;
  if (stat.size > MAX_SKILL_BYTES) return null;
  if (budget.bytes + stat.size > MAX_SCAN_BYTES) return null;
  budget.bytes += stat.size;
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

// Linear-time Thompson NFA regex compiler + matcher so repository-controlled
// `skills.json` `include_only`/`exclude` patterns can never trigger ReDoS
// (catastrophic backtracking) on Electron's main thread.
const MAX_PATTERN_LENGTH = 256;
const MAX_PATTERN_INPUT_LENGTH = 512;
const MAX_NFA_STATES = 512;

const buildCharMatcher = (spec) => {
  if (spec.kind === 'any') return (ch) => ch !== '\n' && ch !== '\r';
  if (spec.kind === 'lit') return (ch) => ch === spec.char;
  if (spec.kind === 'class') {
    const { negated, ranges, chars, classes } = spec;
    return (ch) => {
      let matched = chars.has(ch);
      if (!matched) {
        const code = ch.charCodeAt(0);
        for (const [lo, hi] of ranges) {
          if (code >= lo && code <= hi) {
            matched = true;
            break;
          }
        }
      }
      if (!matched) {
        for (const fn of classes) {
          if (fn(ch)) {
            matched = true;
            break;
          }
        }
      }
      return negated ? !matched : matched;
    };
  }
  return () => false;
};

const ESCAPE_CLASS_MATCHERS = {
  d: (ch) => ch >= '0' && ch <= '9',
  D: (ch) => !(ch >= '0' && ch <= '9'),
  w: (ch) => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_',
  W: (ch) => !((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_'),
  s: (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v',
  S: (ch) => !(ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'),
};

const compileLinearRegex = (rawPattern) => {
  if (typeof rawPattern !== 'string' || rawPattern.length > MAX_PATTERN_LENGTH) return null;
  let source = rawPattern;
  if (source.startsWith('^')) source = source.slice(1);
  if (source.endsWith('$') && !source.endsWith('\\$')) source = source.slice(0, -1);

  const states = [];
  const addState = (state) => {
    if (states.length >= MAX_NFA_STATES) throw new Error('NFA_TOO_LARGE');
    const id = states.length;
    states.push(state);
    return id;
  };
  let pos = 0;

  const readEscapeChar = () => {
    if (pos >= source.length) throw new Error('BAD_ESCAPE');
    const ch = source[pos++];
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    return ch;
  };

  const parseCharClass = () => {
    let negated = false;
    if (pos < source.length && source[pos] === '^') {
      negated = true;
      pos += 1;
    }
    const chars = new Set();
    const ranges = [];
    const classes = [];
    let first = true;
    while (pos < source.length && (first || source[pos] !== ']')) {
      first = false;
      if (source[pos] === '\\') {
        pos += 1;
        const next = source[pos];
        if (next && ESCAPE_CLASS_MATCHERS[next]) {
          classes.push(ESCAPE_CLASS_MATCHERS[next]);
          pos += 1;
          continue;
        }
        const ch = readEscapeChar();
        if (pos + 1 < source.length && source[pos] === '-' && source[pos + 1] !== ']') {
          pos += 1;
          const endCh = source[pos] === '\\' ? (pos += 1, readEscapeChar()) : source[pos++];
          ranges.push([ch.charCodeAt(0), endCh.charCodeAt(0)]);
        } else {
          chars.add(ch);
        }
        continue;
      }
      const ch = source[pos++];
      if (pos + 1 < source.length && source[pos] === '-' && source[pos + 1] !== ']') {
        pos += 1;
        const endCh = source[pos] === '\\' ? (pos += 1, readEscapeChar()) : source[pos++];
        ranges.push([ch.charCodeAt(0), endCh.charCodeAt(0)]);
      } else {
        chars.add(ch);
      }
    }
    if (pos >= source.length || source[pos] !== ']') throw new Error('UNCLOSED_CLASS');
    pos += 1;
    return { kind: 'class', negated, chars, ranges, classes };
  };

  const cloneFrag = (frag) => {
    // Rebuild via AST node for clean {m,n} repetition without mutating states.
    return buildNode(frag);
  };

  const parseAtom = () => {
    if (pos >= source.length) return null;
    const ch = source[pos];
    if (ch === '|' || ch === ')') return null;
    if (ch === '(') {
      pos += 1;
      if (source[pos] === '?') {
        if (source[pos + 1] === ':') {
          pos += 2;
        } else {
          throw new Error('UNSUPPORTED_GROUP');
        }
      }
      const inner = parseAlternation();
      if (pos >= source.length || source[pos] !== ')') throw new Error('UNCLOSED_GROUP');
      pos += 1;
      return inner;
    }
    if (ch === '[') {
      pos += 1;
      return { type: 'match', matcher: buildCharMatcher(parseCharClass()) };
    }
    if (ch === '.') {
      pos += 1;
      return { type: 'match', matcher: buildCharMatcher({ kind: 'any' }) };
    }
    if (ch === '\\') {
      pos += 1;
      const next = source[pos];
      if (!next) throw new Error('BAD_ESCAPE');
      if (next >= '1' && next <= '9') throw new Error('NO_BACKREF');
      if (ESCAPE_CLASS_MATCHERS[next]) {
        pos += 1;
        return { type: 'match', matcher: ESCAPE_CLASS_MATCHERS[next] };
      }
      const lit = readEscapeChar();
      return { type: 'match', matcher: buildCharMatcher({ kind: 'lit', char: lit }) };
    }
    if (ch === '^' || ch === '$') {
      pos += 1;
      return { type: 'empty' };
    }
    pos += 1;
    return { type: 'match', matcher: buildCharMatcher({ kind: 'lit', char: ch }) };
  };

  const parseQuantified = () => {
    let node = parseAtom();
    if (!node) return null;
    while (pos < source.length) {
      const ch = source[pos];
      if (ch === '*' || ch === '+' || ch === '?') {
        pos += 1;
        if (source[pos] === '?') pos += 1;
        node = { type: 'quant', op: ch, child: node };
      } else if (ch === '{') {
        const rest = source.slice(pos);
        const match = /^\{(\d+)(?:,(\d*))?\}/.exec(rest);
        if (!match) break;
        const min = Number(match[1]);
        const max = match[2] === undefined ? min : match[2] === '' ? Infinity : Number(match[2]);
        if (min > 32 || (Number.isFinite(max) && (max > 32 || max < min))) throw new Error('BOUND_TOO_LARGE');
        pos += match[0].length;
        if (source[pos] === '?') pos += 1;
        node = { type: 'repeat', min, max, child: node };
      } else {
        break;
      }
    }
    return node;
  };

  const parseConcat = () => {
    const parts = [];
    while (pos < source.length && source[pos] !== '|' && source[pos] !== ')') {
      const part = parseQuantified();
      if (!part) break;
      parts.push(part);
    }
    if (parts.length === 0) return { type: 'empty' };
    if (parts.length === 1) return parts[0];
    return { type: 'concat', parts };
  };

  const parseAlternation = () => {
    const branches = [parseConcat()];
    while (pos < source.length && source[pos] === '|') {
      pos += 1;
      branches.push(parseConcat());
    }
    return branches.length === 1 ? branches[0] : { type: 'alt', branches };
  };

  const buildNode = (node) => {
    if (node.type === 'empty') {
      const s = addState({ kind: 'eps', out: [] });
      return { start: s, end: s };
    }
    if (node.type === 'match') {
      const end = addState({ kind: 'eps', out: [] });
      const start = addState({ kind: 'char', matcher: node.matcher, next: end });
      return { start, end };
    }
    if (node.type === 'concat') {
      const built = node.parts.map(buildNode);
      for (let i = 0; i < built.length - 1; i += 1) {
        states[built[i].end].out.push(built[i + 1].start);
      }
      return { start: built[0].start, end: built[built.length - 1].end };
    }
    if (node.type === 'alt') {
      const start = addState({ kind: 'eps', out: [] });
      const end = addState({ kind: 'eps', out: [] });
      for (const branch of node.branches) {
        const b = buildNode(branch);
        states[start].out.push(b.start);
        states[b.end].out.push(end);
      }
      return { start, end };
    }
    if (node.type === 'quant') {
      const inner = buildNode(node.child);
      const start = addState({ kind: 'eps', out: [] });
      const end = addState({ kind: 'eps', out: [] });
      if (node.op === '?') {
        states[start].out.push(inner.start, end);
        states[inner.end].out.push(end);
      } else if (node.op === '*') {
        states[start].out.push(inner.start, end);
        states[inner.end].out.push(inner.start, end);
      } else {
        states[start].out.push(inner.start);
        states[inner.end].out.push(inner.start, end);
      }
      return { start, end };
    }
    if (node.type === 'repeat') {
      const parts = [];
      for (let i = 0; i < node.min; i += 1) parts.push(cloneFrag(node.child));
      if (node.max === Infinity) {
        parts.push(buildNode({ type: 'quant', op: '*', child: node.child }));
      } else {
        for (let i = node.min; i < node.max; i += 1) {
          parts.push(buildNode({ type: 'quant', op: '?', child: node.child }));
        }
      }
      if (parts.length === 0) {
        const s = addState({ kind: 'eps', out: [] });
        return { start: s, end: s };
      }
      for (let i = 0; i < parts.length - 1; i += 1) {
        states[parts[i].end].out.push(parts[i + 1].start);
      }
      return { start: parts[0].start, end: parts[parts.length - 1].end };
    }
    throw new Error('UNKNOWN_NODE');
  };

  let frag;
  try {
    const ast = parseAlternation();
    if (pos !== source.length) return null;
    frag = buildNode(ast);
  } catch {
    return null;
  }

  const accept = frag.end;
  const epsilonClosure = (initial) => {
    const visited = new Set();
    const stack = [...initial];
    while (stack.length) {
      const id = stack.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      const state = states[id];
      if (state.kind === 'eps') {
        for (const target of state.out) {
          if (!visited.has(target)) stack.push(target);
        }
      }
    }
    return visited;
  };

  const startSet = epsilonClosure([frag.start]);
  return (value) => {
    if (typeof value !== 'string' || value.length > MAX_PATTERN_INPUT_LENGTH) return false;
    let current = startSet;
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      const next = [];
      for (const id of current) {
        const state = states[id];
        if (state.kind === 'char' && state.matcher(ch)) {
          next.push(state.next);
        }
      }
      if (next.length === 0) return false;
      current = epsilonClosure(next);
    }
    return current.has(accept);
  };
};

const compilePattern = (pattern) => {
  if (typeof pattern !== 'string') return null;
  const trimmed = pattern.trim();
  if (!trimmed) return null;
  const matcher = compileLinearRegex(trimmed);
  if (matcher) return (value) => value === trimmed || matcher(value);
  return (value) => value === trimmed;
};

const createFilterLayer = (spec) => {
  if (!spec || typeof spec !== 'object') return null;
  const includePatterns = Array.isArray(spec.include_only)
    ? spec.include_only.map(compilePattern).filter(Boolean)
    : [];
  const excludePatterns = Array.isArray(spec.exclude)
    ? spec.exclude.map(compilePattern).filter(Boolean)
    : [];
  if (!includePatterns.length && !excludePatterns.length) return null;
  return {
    includeOnly: includePatterns.length ? includePatterns : null,
    exclude: excludePatterns,
  };
};

const matchesFilterLayers = (candidates, filterLayers) => {
  const names = candidates.filter((value) => typeof value === 'string' && value.length > 0);
  if (!names.length) return false;
  for (const layer of filterLayers) {
    if (layer.includeOnly && !names.some((name) => layer.includeOnly.some((match) => match(name)))) {
      return false;
    }
    if (layer.exclude.length && names.some((name) => layer.exclude.some((match) => match(name)))) {
      return false;
    }
  }
  return true;
};

const resolveManifestTarget = async (rawPath, manifestPath, { cwd, homeDir }) => {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(homeDir, trimmed.slice(2));
  }
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);

  const manifestDir = path.dirname(manifestPath);
  const manifestDirName = path.basename(manifestDir);
  const candidates = [];
  if (manifestDirName === '.agents' || manifestDirName === '.agent') {
    candidates.push(path.resolve(path.dirname(manifestDir), trimmed));
    candidates.push(path.resolve(manifestDir, trimmed));
  } else {
    candidates.push(path.resolve(manifestDir, trimmed));
  }
  if (cwd) {
    const fromCwd = path.resolve(cwd, trimmed);
    if (!candidates.includes(fromCwd)) candidates.push(fromCwd);
  }
  for (const candidate of candidates) {
    if (await safeStat(candidate)) return candidate;
  }
  return candidates[0] || null;
};

const loadSkillFromDir = async (skillDir, dirName, scope, filterLayers, state) => {
  if (state.budget.entries >= MAX_SCAN_ENTRIES || state.budget.bytes >= MAX_SCAN_BYTES) return;
  const skillMdPath = path.join(skillDir, SKILL_FILE_NAME);
  const stat = await safeStat(skillMdPath);
  if (!stat || !stat.isFile()) return;
  if (stat.size > MAX_SKILL_BYTES) return;
  if (state.budget.bytes + stat.size > MAX_SCAN_BYTES) return;
  state.budget.bytes += stat.size;

  let text = '';
  try {
    text = await readLeadingUtf8(skillMdPath, stat.size);
  } catch {
    return;
  }

  const frontmatter = parseAntigravitySkillFrontmatter(text);
  const name = (typeof frontmatter.name === 'string' && frontmatter.name.trim()
    ? frontmatter.name.trim()
    : dirName
  ).replace(/^\/+/, '');
  if (!name) return;

  if (filterLayers.length && !matchesFilterLayers([dirName, name], filterLayers)) return;
  if (state.seen.has(name)) return;

  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  state.seen.add(name);
  state.skills.push({
    name,
    description,
    argumentHint: '',
    path: skillMdPath,
    scope,
  });
};

const scanSkillsDirectory = async (rootDir, scope, filterLayers, state) => {
  if (state.budget.entries >= MAX_SCAN_ENTRIES || state.budget.bytes >= MAX_SCAN_BYTES) return;
  const rootStat = await safeStat(rootDir);
  if (!rootStat || !rootStat.isDirectory()) return;

  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  let foundSubdirSkill = false;
  for (const entry of entries) {
    if (state.budget.entries >= MAX_SCAN_ENTRIES || state.budget.bytes >= MAX_SCAN_BYTES) return;
    state.budget.entries += 1;

    const fullPath = path.join(rootDir, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      const targetStat = await safeStat(fullPath);
      isDir = Boolean(targetStat?.isDirectory());
    }
    if (!isDir) continue;

    const beforeCount = state.skills.length;
    await loadSkillFromDir(fullPath, entry.name, scope, filterLayers, state);
    if (state.skills.length > beforeCount) foundSubdirSkill = true;
  }

  // Also support an entry pointing directly at a single skill folder.
  if (!foundSubdirSkill && entries.some((entry) => entry.name === SKILL_FILE_NAME)) {
    await loadSkillFromDir(rootDir, path.basename(rootDir), scope, filterLayers, state);
  }
};

const scanSkillsManifest = async (manifestPath, scope, inheritedLayers, ancestors, depth, context, state) => {
  if (depth > MAX_INHERIT_DEPTH) return;
  if (state.budget.entries >= MAX_SCAN_ENTRIES || state.budget.bytes >= MAX_SCAN_BYTES) return;

  const canonical = await canonicalPath(manifestPath);
  if (ancestors.has(canonical)) return;

  const manifest = await readJsonFile(manifestPath, state.budget);
  if (!manifest) return;

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(canonical);

  const manifestLayer = createFilterLayer(manifest);
  const baseLayers = manifestLayer ? [...inheritedLayers, manifestLayer] : inheritedLayers;

  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  for (const rawEntry of entries) {
    if (state.budget.entries >= MAX_SCAN_ENTRIES || state.budget.bytes >= MAX_SCAN_BYTES) return;
    const entry = typeof rawEntry === 'string' ? { path: rawEntry } : rawEntry;
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') continue;
    const targetPath = await resolveManifestTarget(entry.path, manifestPath, context);
    if (!targetPath) continue;
    const entryLayer = createFilterLayer(entry);
    const entryLayers = entryLayer ? [...baseLayers, entryLayer] : baseLayers;
    await scanSkillsDirectory(targetPath, scope, entryLayers, state);
  }

  const inherits = Array.isArray(manifest.inherits) ? manifest.inherits : [];
  for (const rawInherit of inherits) {
    if (state.budget.entries >= MAX_SCAN_ENTRIES || state.budget.bytes >= MAX_SCAN_BYTES) return;
    const inheritSpec = typeof rawInherit === 'string' ? { path: rawInherit } : rawInherit;
    if (!inheritSpec || typeof inheritSpec !== 'object' || typeof inheritSpec.path !== 'string') continue;
    const targetPath = await resolveManifestTarget(inheritSpec.path, manifestPath, context);
    if (!targetPath) continue;
    const inheritLayer = createFilterLayer(inheritSpec);
    const inheritLayers = inheritLayer ? [...baseLayers, inheritLayer] : baseLayers;
    await scanSkillsManifest(targetPath, scope, inheritLayers, nextAncestors, depth + 1, context, state);
  }
};

const scanPluginSkills = async (geminiRoot, state) => {
  if (state.budget.entries >= MAX_SCAN_ENTRIES || state.budget.bytes >= MAX_SCAN_BYTES) return;
  const configDir = path.join(geminiRoot, 'config');
  const pluginsDir = path.join(configDir, 'plugins');
  const pluginsStat = await safeStat(pluginsDir);
  if (!pluginsStat || !pluginsStat.isDirectory()) return;

  const config = await readJsonFile(path.join(configDir, 'config.json'), state.budget);
  const pluginsConfig = config?.plugins && typeof config.plugins === 'object' ? config.plugins : {};

  let pluginEntries;
  try {
    pluginEntries = await fs.readdir(pluginsDir, { withFileTypes: true });
  } catch {
    return;
  }
  pluginEntries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of pluginEntries) {
    if (state.budget.entries >= MAX_SCAN_ENTRIES || state.budget.bytes >= MAX_SCAN_BYTES) return;
    state.budget.entries += 1;

    const pluginDir = path.join(pluginsDir, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      const targetStat = await safeStat(pluginDir);
      isDir = Boolean(targetStat?.isDirectory());
    }
    if (!isDir) continue;

    const configured = pluginsConfig[entry.name];
    if (configured && typeof configured === 'object' && configured.enabled === false) continue;

    if (!(configured && typeof configured === 'object' && configured.enabled === true)) {
      const pluginJson = await readJsonFile(path.join(pluginDir, 'plugin.json'), state.budget);
      if (pluginJson?.disabled === true) continue;
    }

    await scanSkillsDirectory(path.join(pluginDir, 'skills'), 'plugin', [], state);
  }
};

/**
 * Discover Antigravity's native project, user, `skills.json`, and plugin skills.
 * Returns a sorted array of `{ name, description, argumentHint: '', path, scope }`.
 */
export const discoverAntigravitySkills = async ({ cwd, homeDir = os.homedir(), geminiHome } = {}) => {
  const resolvedHome = path.resolve(homeDir || os.homedir());
  const resolvedCwd = typeof cwd === 'string' && cwd.trim() ? path.resolve(cwd) : null;
  const resolvedGeminiHome = typeof geminiHome === 'string' && geminiHome.trim()
    ? path.resolve(geminiHome)
    : path.join(resolvedHome, '.gemini');

  const state = {
    skills: [],
    seen: new Set(),
    budget: { bytes: 0, entries: 0 },
  };

  // 1–5. Scan skill directory roots in priority order (first skill with a given name wins).
  const roots = [
    { dir: path.join(resolvedGeminiHome, 'config', 'skills'), scope: 'user' },
    ...(resolvedCwd ? [{ dir: path.join(resolvedCwd, '.gemini', 'skills'), scope: 'project' }] : []),
    { dir: path.join(resolvedGeminiHome, 'antigravity-cli', 'skills'), scope: 'user' },
    ...(resolvedCwd ? [{ dir: path.join(resolvedCwd, '.agents', 'skills'), scope: 'project' }] : []),
    ...(resolvedCwd ? [{ dir: path.join(resolvedCwd, '.agent', 'skills'), scope: 'project' }] : []),
  ];

  for (const root of roots) {
    await scanSkillsDirectory(root.dir, root.scope, [], state);
  }

  // Scan skills.json manifests with inherits, entries, include_only, and exclude.
  const manifests = [
    ...(resolvedCwd ? [{ file: path.join(resolvedCwd, '.agents', 'skills.json'), scope: 'project' }] : []),
    ...(resolvedCwd ? [{ file: path.join(resolvedCwd, '.agent', 'skills.json'), scope: 'project' }] : []),
    { file: path.join(resolvedGeminiHome, 'config', 'skills.json'), scope: 'user' },
  ];

  const manifestContext = { cwd: resolvedCwd, homeDir: resolvedHome };
  for (const manifest of manifests) {
    await scanSkillsManifest(manifest.file, manifest.scope, [], new Set(), 0, manifestContext, state);
  }

  // Scan enabled plugin skills.
  await scanPluginSkills(resolvedGeminiHome, state);

  return state.skills.sort((a, b) => a.name.localeCompare(b.name));
};

const normalizeSlashCommand = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const name = typeof entry.name === 'string' ? entry.name.trim().replace(/^\/+/, '') : '';
  if (!name) return null;
  const description = typeof entry.description === 'string' ? entry.description.trim() : '';
  const argumentHint =
    typeof entry.argumentHint === 'string'
      ? entry.argumentHint.trim()
      : typeof entry.input?.hint === 'string'
        ? entry.input.hint.trim()
        : '';
  return { name, description, argumentHint };
};

/**
 * Merge ACP `available_commands_update` commands with discovered Antigravity skills.
 * Live commands win on name collision; result is sorted alphabetically and
 * normalized to `{ name, description, argumentHint }`.
 */
export const mergeAntigravitySlashCommands = (liveCommands, skills) => {
  const byName = new Map();
  for (const entry of Array.isArray(liveCommands) ? liveCommands : []) {
    const normalized = normalizeSlashCommand(entry);
    if (!normalized || byName.has(normalized.name)) continue;
    byName.set(normalized.name, normalized);
  }
  for (const entry of Array.isArray(skills) ? skills : []) {
    const normalized = normalizeSlashCommand(entry);
    if (!normalized || byName.has(normalized.name)) continue;
    byName.set(normalized.name, normalized);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
};
